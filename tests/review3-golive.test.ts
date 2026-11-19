import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db, migrate, setDb } from "@/lib/db";
import { migrations } from "@/lib/db/schema";
import { runBatch } from "@/lib/engine/launcher";
import { LANES, claimNext } from "@/lib/jobs";
import { goLivePlan, queueGoLive, siblings } from "@/lib/manage/golive";
import { runPlan, sameAmount, type PlanSummary } from "@/lib/manage/plan";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { localFiles } from "@/lib/sources/local";
import { newBatch, upsertAccount } from "@/lib/setup";
import { batchLaunchSummary, batchView, cancelBatch, launchBatch, retryFailed, updateSettings } from "@/lib/service";
import { confirmPlan, updatePlan } from "@/lib/manage/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { goLiveLine } from "@/app/batches/[key]/batch-logic";
import { registerTools, type LauncherApi } from "@/mcp/tools";
import { afterLaunch, runClaimed } from "@/worker/run";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Review 3 (independent, third pass) of the batch turn-on ("go-live"). Practice Meta only (MockMeta).
// "FINDING" probes fail today and pass once the bug is fixed. "OK" probes pass: cases checked and fine.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let folder: string;
let clock: FakeClock;
let mock: MockMeta;
const HOUR = 3600_000;

beforeAll(async () => {
  folder = await fifteenFileFolder();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => (String(url).startsWith("https://example.com") ? Promise.resolve(new Response("ok")) : real(url, init)));
}, 120_000);

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
});

afterEach(() => {
  vi.useRealTimers();
});

async function batch(opts: { adsetId?: string } = {}) {
  const { accountId, batchId } = await setupBatch(folder, { adsetId: opts.adsetId });
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
  updateBatch(batchId, { copy: JSON.stringify(LEAD_COPY) });
  const deps = { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "review3-golive-")) };
  return { accountId, batchId, key: getBatch(batchId)!.key, deps };
}

/** Launch as the page does: the total typed back exactly as the summary shows it. */
async function launchTyped(key: string) {
  const typed = (await batchLaunchSummary(key)).launch!.spendConfirmation!;
  await launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: typed });
  return typed;
}

const status = (id: string) => mock.objects.get(id)?.status;
const planOf = (batchKey: string) => {
  const p = goLivePlan(batchKey);
  return p ? (db().prepare("SELECT * FROM plans WHERE key = ?").get(p.key) as { id: number; key: string; status: string; summary: string; batch_id: number | null }) : null;
};

/** Hold the practice Meta's answers until `release()` (a slow Meta / a pacer wait), for clients made from now on. */
function slowMeta() {
  const orig = mock.fetch;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  mock.fetch = async (i, init) => {
    await gate;
    return orig(i, init);
  };
  return { release, restore: () => (mock.fetch = orig) };
}

async function twoAdSets(goLive: "now" | "at" = "now", at?: string) {
  const b = await batch();
  await updateSettings(b.key, { goLive, goLiveAt: at, extraAdsetIds: ["as4"] });
  await launchTyped(b.key);
  const sib = siblings(getBatch(b.batchId)!).find((x) => x.id !== b.batchId)!;
  return { ...b, sib };
}

/** Claude's batch_status, run through the real tool code on the server's own batch view. */
async function claudeStatus(key: string): Promise<string> {
  const api: LauncherApi = {
    async call<T>(_m: string, p: string): Promise<T> {
      return JSON.parse(JSON.stringify(await batchView(p.split("/").pop()!))) as T;
    },
  };
  const server = new McpServer({ name: "t", version: "1" });
  registerTools(server, api);
  const [a, bb] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "c", version: "1" });
  await client.connect(bb);
  const r = (await client.callTool({ name: "batch_status", arguments: { batch_id: key } })) as { content: { text: string }[] };
  await client.close();
  return r.content.map((c) => c.text).join("\n");
}

// ---------------------------------------------------------------------------------------------

describe("FINDINGS", () => {
  it("FINDING 1: two batches launched into one campaign back to back: the second is held only because the first one's turn-on ran meanwhile", async () => {
    const x = await batch(); // ad set as1 (₹500) in c1
    const y = await batch({ adsetId: "as4" }); // ad set as4 (₹800) in c1
    await updateSettings(x.key, { goLive: "now" });
    await updateSettings(y.key, { goLive: "now" });
    expect(await launchTyped(x.key)).toBe("₹500");
    expect(await launchTyped(y.key)).toBe("₹800"); // c1 and as1 are still paused: only as4 can spend
    // The worker runs X, then its turn-on, then Y (one launch lane).
    await runBatch(x.batchId, x.deps);
    expect(await queueGoLive(x.batchId)).toMatch(/^Turning the ads on now/);
    await runPlan(planOf(x.key)!.id, { client: clientFor(x.accountId), clock });
    expect([status("c1"), status("as1")]).toEqual(["ACTIVE", "ACTIVE"]);
    await runBatch(y.batchId, y.deps);
    // Nothing changed in Meta that Y's turn-on starts: as1 already spends, Y adds as4's ₹800 as typed.
    expect(await queueGoLive(y.batchId)).toMatch(/^Turning the ads on now/);
  }, 120_000);

  it("FINDING 2: 'at a time': a first run that ends more than an hour after the set time holds the turn-on (no Retry, nothing changed)", async () => {
    const b = await batch();
    const at = new Date(Date.now() + 10 * 60_000).toISOString();
    await updateSettings(b.key, { goLive: "at", goLiveAt: at });
    expect(await launchTyped(b.key)).toBe("₹500");
    await runBatch(b.batchId, b.deps);
    // The launch (rate limits, videos) ended 2 hours after it started: the same confirmed launch.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * HOUR });
    updateBatch(b.batchId, { finished_at: new Date().toISOString() });
    expect(await queueGoLive(b.batchId)).toMatch(/^Turning the ads on now/);
  }, 120_000);

  it("FINDING 1b: two batches into one campaign, both 'at' the same time: the second plan is reopened at its time (the first one ran first)", async () => {
    const x = await batch();
    const y = await batch({ adsetId: "as4" });
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await updateSettings(x.key, { goLive: "at", goLiveAt: at });
    await updateSettings(y.key, { goLive: "at", goLiveAt: at });
    await launchTyped(x.key);
    await launchTyped(y.key);
    await runBatch(x.batchId, x.deps);
    await queueGoLive(x.batchId);
    await runBatch(y.batchId, y.deps);
    expect(await queueGoLive(y.batchId)).toMatch(/^The ads will be turned on at/);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(at) + 60_000 });
    await runPlan(planOf(x.key)!.id, { client: clientFor(x.accountId), clock });
    const r = await runPlan(planOf(y.key)!.id, { client: clientFor(y.accountId), clock });
    expect(r.reopened ?? "not reopened").toBe("not reopened");
  }, 120_000);

  it("FINDING 3: the group's turn-on failed at the last ad set and the worker gave up: the other ad set's page still promises it", async () => {
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    await afterLaunch(b.batchId, { done: 9, failed: 0 }); // waits: the other ad set is still queued
    await runBatch(b.sib.id, b.deps);
    // Every try of the last ad set's turn-on fails (Meta refuses the login), as the worker runs them.
    const refuse = () => mock.inject({ match: () => true, kind: "error", error: { message: "Invalid OAuth access token", code: 190 }, status: 400 });
    refuse();
    await afterLaunch(b.sib.id, { done: 9, failed: 0 });
    for (let i = 0; i < 20; i++) {
      db().prepare("UPDATE jobs SET run_after = 0 WHERE kind = 'golive' AND status = 'queued'").run();
      const job = claimNext(LANES.other);
      if (!job) break;
      if (job.kind === "golive") refuse();
      await runClaimed(job);
    }
    expect((await batchView(b.sib.key)).goLiveNote).toMatch(/^The ads were NOT turned on/);
    const v = await batchView(b.key);
    expect(v.goLivePlan).toBeNull();
    // Nothing will turn the first ad set's ads on by itself any more.
    expect(goLiveLine(v)).not.toMatch(/^The ads are turned on once every ad is in/);
  }, 180_000);

  it("FINDING 4: Claude's batch_status doesn't say the ads wait for the other ad set's failed ad (goLiveWaits); it blames a failed turn-on", async () => {
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    await runBatch(b.sib.id, b.deps);
    db().prepare("UPDATE ads SET status = 'failed', error = 'x' WHERE id = ?").run(getAds(b.sib.id)[0].id);
    updateBatch(b.sib.id, { status: "partial" });
    expect(await queueGoLive(b.batchId)).toMatch(/has 1 ad not created/);
    const v = await batchView(b.key);
    expect(v.goLiveWaits).toMatch(/has 1 ad not created \(press Retry on batch/);
    const text = await claudeStatus(b.key);
    expect(text).toMatch(/has 1 ad not created|other ad set/);
    expect(text).not.toMatch(/turning them on did not work/);
  }, 120_000);

  it("FINDING 5: the plan is queued but its job is never made (a database error at that moment): the retry says done, nothing ever runs it", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now" });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    db().exec("CREATE TRIGGER busy_once BEFORE INSERT ON jobs WHEN NEW.kind = 'plan' BEGIN SELECT RAISE(ABORT, 'database is locked'); END");
    await expect(queueGoLive(b.batchId)).rejects.toThrow(/database is locked/);
    db().exec("DROP TRIGGER busy_once");
    // The worker's next try (5 minutes later):
    await queueGoLive(b.batchId);
    expect(planOf(b.key)!.status).toBe("queued"); // the page says "Confirmed, waiting to run."
    const jobs = db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan' AND batch_id = ? AND status = 'queued'").pluck().get(planOf(b.key)!.id);
    expect(jobs).toBe(1);
  }, 120_000);

  it("FINDING 6: two turn-on steps with different groups at the same moment (after Stop + Retry on both): the second batch gets no plan and nothing says so", async () => {
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    await queueGoLive(b.batchId);
    await runBatch(b.sib.id, b.deps);
    db().prepare("UPDATE ads SET status = 'failed', error = 'x' WHERE id = ?").run(getAds(b.sib.id)[0].id);
    updateBatch(b.sib.id, { status: "partial" });
    cancelBatch(b.key); // both stopped, no plan yet
    // Retry on the first (every ad in): its turn-on step starts while the other is still stopped, and
    // waits for Meta (the pacer on a slow account).
    retryFailed(b.key);
    const slowA = slowMeta();
    const pA = queueGoLive(b.batchId); // its group: itself only (the other is stopped)
    slowA.restore();
    // Meanwhile: Retry on the other; its failed ad is created and its turn-on step starts.
    retryFailed(b.sib.key);
    expect(await runBatch(b.sib.id, b.deps)).toEqual({ done: 9, failed: 0 });
    const slowB = slowMeta();
    const pB = queueGoLive(b.sib.id); // its group: both (the first has no plan yet)
    slowB.restore();
    slowA.release();
    await pA;
    slowB.release();
    const rB = await pB; // null: the worker takes it as done, no retry, no alert
    expect(getBatch(b.batchId)!.go_live_done).toBe(1);
    expect({ rB, done: getBatch(b.sib.id)!.go_live_done, plan: goLivePlan(b.sib.key)?.status ?? null }).toMatchObject({ done: 1, plan: "draft" });
  }, 120_000);

  it("FINDING 7: migration 6 on a real old database: a renamed turn-on plan is not found, so Stop doesn't cancel it and it turns the ads on later", () => {
    // The database as the committed app (HEAD) leaves it: migrations 1-3.
    const old = new Database(":memory:");
    for (let v = 0; v < 3; v++) old.exec(migrations[v]);
    old.pragma("user_version = 3");
    setDb(old);
    const acc = upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
    const id = newBatch(acc, "test@example.com");
    const key = (getBatch(id) as { key: string }).key;
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    old.prepare("UPDATE batches SET status = 'done', go_live = 'at', go_live_at = ?, go_live_done = 1, campaign_id = 'c1', adset_id = 'as1', adset_mode = 'existing' WHERE id = ?").run(at, id);
    old.prepare("INSERT INTO ads (batch_id, position, key, creative_name, status, meta_adset_id, meta_ad_id) VALUES (?, 1, ?, 'a', 'done', 'as1', '9001'), (?, 2, ?, 'b', 'done', 'as1', '9002')").run(id, `${key}-01`, id, `${key}-02`);
    const ops = JSON.stringify({ title: `Turn on batch ${key} (2 ads)`, run_at: at, ops: [{ type: "set_status", status: "ACTIVE", ads: ["9001", "9002"], adsets: ["as1"], campaigns: ["c1"] }] });
    // The person renamed it on the plan page; HEAD's queueGoLive marked who confirmed it and for which batch.
    old.prepare("INSERT INTO plans (key, ad_account_id, title, status, ops, run_at, confirmed_at, confirmed_by) VALUES ('pold', ?, 'Diwali ads on', 'queued', ?, ?, datetime('now'), ?)").run(acc, ops, at, `test@example.com (when launching batch ${key})`);
    // A plan for a batch that no longer exists, and one whose title matches no batch: no harm.
    old.prepare("INSERT INTO plans (key, ad_account_id, title, ops) VALUES ('pgone', ?, 'Turn on batch zzzzz (3 ads)', '{}'), ('pother', ?, 'Turn on the November ads', '{}')").run(acc, acc);
    migrate(old);
    expect(old.prepare("SELECT key, batch_id FROM plans WHERE key IN ('pgone', 'pother') ORDER BY key").all()).toEqual([{ key: "pgone", batch_id: null }, { key: "pother", batch_id: null }]);
    let stopped = "";
    try {
      stopped = JSON.stringify(cancelBatch(key).cancelled.map((c) => c.result));
    } catch (e) {
      stopped = (e as Error).message; // today: "This batch is not launching ... and nothing is waiting to turn its ads on."
    }
    expect({ stopped, plan: old.prepare("SELECT status FROM plans WHERE key = 'pold'").pluck().get() }).toEqual({ stopped: '["turn_on_cancelled"]', plan: "cancelled" });
  });

  it("FINDING 9: a held turn-on plan edited to leave out ad 1, then confirmed: Stop on the batch no longer finds it (first-ad rule)", async () => {
    const b = await batch();
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await updateSettings(b.key, { goLive: "at", goLiveAt: at });
    const typed = await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    cancelBatch(b.key); // stopped before the turn-on was made
    retryFailed(b.key);
    expect(await queueGoLive(b.batchId)).toMatch(/NOT turned on: the launch was stopped/);
    const key = goLivePlan(b.key)!.key;
    // The person leaves the first creative out and confirms the rest (a fresh yes).
    const input = JSON.parse(db().prepare("SELECT ops FROM plans WHERE key = ?").pluck().get(key) as string) as { ops: { ads: string[] }[] };
    await updatePlan(key, { ops: [{ ...input.ops[0], ads: input.ops[0].ads.slice(1) }] as never });
    await confirmPlan(key, { confirm: true, acceptWarnings: true, spendConfirmation: typed }, "test@example.com");
    expect(db().prepare("SELECT status FROM plans WHERE key = ?").pluck().get(key)).toBe("queued");
    // Later: "Stop" on the batch, to keep the ads off after all.
    expect(goLivePlan(b.key)?.key ?? null).toBe(key);
    let msg = "";
    try {
      cancelBatch(b.key);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect({ msg, plan: db().prepare("SELECT status FROM plans WHERE key = ?").pluck().get(key) }).toEqual({ msg: "", plan: "cancelled" });
  }, 120_000);

  it("FINDING 8: a launch from before the typed total was kept: its turn-on is queued with no amount check, even after the budget went up tenfold", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now" });
    await launchTyped(b.key);
    // As an in-flight launch of the committed app looks after the deploy: a total was typed, not kept.
    updateBatch(b.batchId, { go_live_total: null, go_live_total_at: null });
    await runBatch(b.batchId, b.deps);
    mock.objects.get("as1")!.daily_budget = "500000"; // ₹5,000 instead of ₹500
    expect(await queueGoLive(b.batchId)).toMatch(/NOT turned on/);
  }, 120_000);
});

describe("OK: checked and fine", () => {
  it("OK: Stop while the turn-on step waits for Meta: the plan is kept as a draft, never queued; nothing turns on", async () => {
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    await queueGoLive(b.batchId);
    await runBatch(b.sib.id, b.deps);
    const slow = slowMeta();
    const p = queueGoLive(b.sib.id);
    slow.restore();
    const r = cancelBatch(b.key);
    expect(r.cancelled.map((c) => c.result)).toEqual(["turn_on_cancelled", "turn_on_cancelled"]);
    slow.release();
    expect(await p).toMatch(/NOT turned on: the launch was stopped/);
    expect(goLivePlan(b.key)?.status).toBe("draft");
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan'").pluck().get()).toBe(0);
    expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
  }, 120_000);

  it("OK: Stop while the turn-on plan's run-start check reads Meta: nothing is turned on", async () => {
    const b = await twoAdSets();
    for (const x of siblings(getBatch(b.batchId)!)) {
      await runBatch(x.id, b.deps);
      await queueGoLive(x.id);
    }
    const plan = planOf(b.key)!;
    expect(plan.status).toBe("queued");
    const slow = slowMeta();
    const run = runPlan(plan.id, { client: clientFor(b.accountId), clock });
    slow.restore();
    const r = cancelBatch(b.key);
    expect(r.cancelled.map((c) => c.result)).toEqual(["turn_on_stopping", "turn_on_stopping"]);
    slow.release();
    await run;
    expect(planOf(b.key)!.status).toBe("cancelled");
    expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
    expect(status("c1")).toBe("PAUSED");
  }, 120_000);

  it("OK: the first-ad rule after a Stop: a Retry that creates ad 1 later finds that batch's own plan, the sibling keeps its own", async () => {
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    db().prepare("UPDATE ads SET status = 'failed', error = 'x', meta_ad_id = NULL WHERE id = ?").run(getAds(b.batchId)[0].id);
    updateBatch(b.batchId, { status: "partial" });
    await runBatch(b.sib.id, b.deps);
    cancelBatch(b.key);
    retryFailed(b.sib.key);
    await queueGoLive(b.sib.id);
    const sibPlan = goLivePlan(b.sib.key)!;
    expect(sibPlan.status).toBe("draft");
    expect(goLivePlan(b.key)).toBeNull(); // its ad 2 is not in the other's plan
    retryFailed(b.key);
    expect(await runBatch(b.batchId, b.deps)).toEqual({ done: 9, failed: 0 });
    expect(await queueGoLive(b.batchId)).toMatch(/NOT turned on: the launch was stopped/);
    const own = goLivePlan(b.key)!;
    expect(own.key).not.toBe(sibPlan.key);
    expect(goLivePlan(b.sib.key)!.key).toBe(sibPlan.key);
    // Stop now cancels each batch's own plan.
    const r = cancelBatch(b.key);
    expect(r.cancelled.map((c) => [c.key, c.planKey])).toEqual([[b.key, own.key], [b.sib.key, sibPlan.key]]);
  }, 120_000);

  it("OK: one new shared ad set into two ad sets of different campaigns, one a lifetime campaign budget, 'at a time': typed total = plan total, queued", async () => {
    const b = await batch();
    const c2 = mock.objects.get("c2")!;
    delete c2.daily_budget;
    Object.assign(c2, { lifetime_budget: "2000000", stop_time: new Date(Date.now() + 6 * 86_400_000 + HOUR).toISOString() });
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await updateSettings(b.key, { goLive: "at", goLiveAt: at, adsetMode: "new_shared", extraAdsetIds: ["as3"] });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹5,500"); // ₹500 + ₹20,000 ÷ 4 whole days from the time
    for (const x of siblings(getBatch(b.batchId)!)) {
      expect(await runBatch(x.id, b.deps)).toEqual({ done: 9, failed: 0 });
      await queueGoLive(x.id);
    }
    const plan = planOf(b.key)!;
    expect(plan.status).toBe("queued");
    expect(sameAmount((JSON.parse(plan.summary) as PlanSummary).spendConfirmation ?? "", typed)).toBe(true);
  }, 120_000);

  it("OK: the plan's run-start check adds a few reads only (one per kind, not one per ad): 18 ads in 2 ad sets", async () => {
    const b = await twoAdSets();
    for (const x of siblings(getBatch(b.batchId)!)) await runBatch(x.id, b.deps);
    let n = mock.calls.length;
    await queueGoLive(b.batchId);
    await queueGoLive(b.sib.id);
    const make = mock.calls.slice(n);
    n = mock.calls.length;
    await runPlan(planOf(b.key)!.id, { client: clientFor(b.accountId), clock });
    const run = mock.calls.slice(n);
    const gets = (c: { method: string }[]) => c.filter((x) => x.method === "GET").length;
    // Today: the turn-on step 6 reads; the run 9 reads (6 for the run-start check, 3 status reads) and
    // 21 writes (18 ads, 2 ad sets, the campaign). The check costs 6 points against the writes' 63.
    expect(gets(make)).toBeLessThanOrEqual(8);
    expect(gets(run)).toBeLessThanOrEqual(12);
    expect(run.length - gets(run)).toBe(21);
  }, 120_000);
});
