import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, migrate, setDb } from "@/lib/db";
import { migrations } from "@/lib/db/schema";
import { runBatch } from "@/lib/engine/launcher";
import { goLiveHold, goLivePlan, queueGoLive, siblings } from "@/lib/manage/golive";
import { runPlan, sameAmount } from "@/lib/manage/plan";
import { confirmPlan, updatePlan } from "@/lib/manage/service";
import { money } from "@/lib/manage/options";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { localFiles } from "@/lib/sources/local";
import { newBatch, upsertAccount } from "@/lib/setup";
import { batchLaunchSummary, batchView, cancelBatch, launchBatch, retryFailed, updateSettings } from "@/lib/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { goLiveLine, stoppedText } from "@/app/batches/[key]/batch-logic";
import { goLive, runJob } from "@/worker/run";
import type { BatchRow } from "@/lib/types";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Independent review round 2 (19 Nov 2026): batch launch, Stop, Retry and the turn-on after the
// launch. Practice Meta only (MockMeta), never the real API. A failing test is a bug; a passing one is
// a case that was checked and found fine. Names say what the marketer should get.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let folder: string;
let clock: FakeClock;
let mock: MockMeta;

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
  const deps = { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "review2-batch-")) };
  return { accountId, batchId, key: getBatch(batchId)!.key, deps };
}

/** Launch as the page does: the total typed back exactly as the summary shows it. */
async function launchTyped(key: string) {
  const typed = (await batchLaunchSummary(key)).launch!.spendConfirmation!;
  await launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: typed });
  return typed;
}

const planStatus = (key: string) => goLivePlan(key)?.status;
const planId = (batchKey: string) => db().prepare("SELECT id FROM plans WHERE key = ?").pluck().get(goLivePlan(batchKey)!.key) as number;
/** The plan lane runs the batch's turn-on plan (as the worker does). */
const runTurnOn = (batchKey: string, accountId: number) => runPlan(planId(batchKey), { client: clientFor(accountId), clock });
const status = (id: string) => mock.objects.get(id)?.status;

describe("normal launches are turned on as confirmed (not held)", () => {
  it("a launch into a campaign that is already running, with another ad set on, is turned on as confirmed", async () => {
    const { batchId, key, deps } = await batch();
    // c1 runs already; as4 (₹800 a day) is on and spending. The batch goes into as1 (₹500 a day).
    Object.assign(mock.objects.get("c1")!, { status: "ACTIVE" });
    Object.assign(mock.objects.get("as4")!, { status: "ACTIVE", effective_status: "ACTIVE" });
    await updateSettings(key, { goLive: "now" });
    // Round 3: the summary counts as the turn-on plan does (every ad set on in the campaign): ₹500 + ₹800.
    expect(await launchTyped(key)).toBe("₹1,300");
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    const msg = await queueGoLive(batchId);
    // Nothing changed in Meta since the yes: the ads must go on.
    expect(msg).toMatch(/^Turning the ads on now/);
    expect(planStatus(key)).toBe("queued");
  }, 120_000);

  it("a paused campaign with another ad set switched on but holding no ads on: turned on as confirmed", async () => {
    const { batchId, key, deps } = await batch();
    Object.assign(mock.objects.get("as4")!, { status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED" }); // on, no ads in it
    await updateSettings(key, { goLive: "now" });
    expect(await launchTyped(key)).toBe("₹1,300"); // round 3: counted as the turn-on plan counts it
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    expect(await queueGoLive(batchId)).toMatch(/^Turning the ads on now/);
  }, 120_000);

  it("several ad sets of one campaign, 'now': both ad sets are turned on by one plan once the second one finishes", async () => {
    const { accountId, batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now", extraAdsetIds: ["as4"] });
    expect(await launchTyped(key)).toBe("₹1,300"); // ₹500 + ₹800
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    await runBatch(batchId, deps);
    // Round 3 (one plan per launch): the first waits for the second ad set of the launch.
    expect(await queueGoLive(batchId)).toMatch(/waits for the other ad sets/);
    expect(planStatus(key)).toBeUndefined();
    // Nothing changed in Ads Manager. The second ad set finishes.
    await runBatch(sib.id, deps);
    const msg = await queueGoLive(sib.id);
    expect(msg).toMatch(/^Turning the ads on now/);
    expect(planStatus(sib.key)).toBe("queued");
    expect(goLivePlan(key)).toEqual(goLivePlan(sib.key));
    await runTurnOn(key, accountId);
    expect([status("as1"), status("as4"), status("c1")]).toEqual(["ACTIVE", "ACTIVE", "ACTIVE"]);
  }, 120_000);

  it("several ad sets of one campaign, 'at a time': both are turned on at the time", async () => {
    const { accountId, batchId, key, deps } = await batch();
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await updateSettings(key, { goLive: "at", goLiveAt: at, extraAdsetIds: ["as4"] });
    expect(await launchTyped(key)).toBe("₹1,300");
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    await runBatch(batchId, deps);
    await queueGoLive(batchId);
    await runBatch(sib.id, deps);
    await queueGoLive(sib.id);
    expect([planStatus(key), planStatus(sib.key)]).toEqual(["queued", "queued"]);
    // The time comes: the plan lane runs one plan, then the other. Nothing changed in Ads Manager.
    const first = await runTurnOn(key, accountId);
    expect(first.reopened).toBeUndefined();
    const second = await runTurnOn(sib.key, accountId);
    expect(second.reopened ?? "not reopened").toBe("not reopened");
    expect(status("as4")).toBe("ACTIVE");
  }, 120_000);

  it("two ad sets of one campaign-budget campaign: the second is turned on (the campaign budget counts once)", async () => {
    const c2set = mock.objects.get("as3")!;
    mock.objects.set("as5", { ...c2set, id: "as5", name: "CBO ad set 2", status: "PAUSED", effective_status: "PAUSED" });
    const { batchId, key, deps } = await batch({ adsetId: "as3" });
    await updateSettings(key, { adsetId: "as3", goLive: "now", extraAdsetIds: ["as5"] });
    expect(await launchTyped(key)).toBe("₹1,000"); // the campaign budget, once
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    await runBatch(batchId, deps);
    expect(await queueGoLive(batchId)).toMatch(/waits for the other ad sets/); // round 3: one plan for the launch
    await runBatch(sib.id, deps);
    const msg = await queueGoLive(sib.id);
    expect(msg).toMatch(/^Turning the ads on now/);
  }, 120_000);

  it("'now' with a lifetime budget: a launch that runs past a whole-day mark is still turned on as confirmed", async () => {
    const { batchId, key, deps } = await batch();
    // ₹30,000 lifetime ending in 5 days and 30 minutes: 5 whole days counted at launch (₹6,000 a day;
    // round 3 counts whole days left, a part day dropped). An hour later only 4 whole days are left.
    const end = new Date(Date.now() + 5 * 86_400_000 + 30 * 60_000).toISOString();
    Object.assign(mock.objects.get("as1")!, { daily_budget: undefined, lifetime_budget: "3000000", end_time: end });
    await updateSettings(key, { goLive: "now" });
    expect(await launchTyped(key)).toBe("₹6,000");
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    // The launch took an hour (common on the starter tier). Nothing changed in Meta.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3600_000 });
    const msg = await queueGoLive(batchId);
    vi.useRealTimers();
    expect(msg).toMatch(/^Turning the ads on now/);
  }, 120_000);
});

describe("checked and fine: normal launches", () => {
  it("one ad set, 'now', daily budget: queued as confirmed", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    expect(await launchTyped(key)).toBe("₹500");
    await runBatch(batchId, deps);
    expect(await queueGoLive(batchId)).toMatch(/^Turning the ads on now/);
  }, 120_000);

  it("'at a time' with a lifetime budget: queued for the time, as confirmed", async () => {
    const { batchId, key, deps } = await batch();
    const end = new Date(Date.now() + 6 * 86_400_000 + 3600_000).toISOString(); // 4 whole days (and an hour) after the time
    Object.assign(mock.objects.get("as1")!, { daily_budget: undefined, lifetime_budget: "3000000", end_time: end });
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await updateSettings(key, { goLive: "at", goLiveAt: at });
    expect(await launchTyped(key)).toBe("₹7,500"); // 4 days left from the time
    await runBatch(batchId, deps);
    expect(await queueGoLive(batchId)).toMatch(/^The ads will be turned on at/);
    expect(planStatus(key)).toBe("queued");
  }, 120_000);

  it("a new ad set for each ad ('now'): queued as confirmed", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now", adsetMode: "new_per_ad" });
    expect(await launchTyped(key)).toBe("₹4,500"); // 9 copies of ₹500
    await runBatch(batchId, deps);
    expect(await queueGoLive(batchId)).toMatch(/^Turning the ads on now/);
  }, 120_000);

  it("one new shared ad set ('now'): queued as confirmed", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now", adsetMode: "new_shared" });
    expect(await launchTyped(key)).toBe("₹500");
    await runBatch(batchId, deps);
    expect(await queueGoLive(batchId)).toMatch(/^Turning the ads on now/);
  }, 120_000);

  it("a campaign-budget campaign, one ad set ('now'): queued as confirmed", async () => {
    const { batchId, key, deps } = await batch({ adsetId: "as3" });
    await updateSettings(key, { adsetId: "as3", goLive: "now" });
    expect(await launchTyped(key)).toBe("₹1,000");
    await runBatch(batchId, deps);
    expect(await queueGoLive(batchId)).toMatch(/^Turning the ads on now/);
  }, 120_000);

  it("several ad sets in different campaigns ('now'): one plan turns both campaigns on", async () => {
    const { accountId, batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now", extraAdsetIds: ["as3"] });
    expect(await launchTyped(key)).toBe("₹1,500"); // ₹500 + campaign budget ₹1,000
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    await runBatch(batchId, deps);
    await queueGoLive(batchId);
    await runBatch(sib.id, deps);
    expect(await queueGoLive(sib.id)).toMatch(/^Turning the ads on now/);
    await runTurnOn(key, accountId);
    expect([status("c1"), status("c2"), status("as1"), status("as3")]).toEqual(["ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE"]);
  }, 120_000);

  it("a budget raised in Ads Manager between launch and turn-on is held (single and group)", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    mock.objects.get("as1")!.daily_budget = "50100"; // ₹501: one rupee more
    expect(await queueGoLive(batchId)).toMatch(/NOT turned on: what can spend once they are on is now ₹501 a day, not the ₹500 typed at launch/);
  }, 120_000);

  it("money texts: the typed total and the plan's total compare by amount in every currency format", () => {
    for (const cur of ["INR", "USD", "EUR", "JPY", "KWD"]) {
      for (const v of [500, 1500, 150000, 10.5, 1234567.89]) {
        expect(sameAmount(money(v, cur), money(v, cur))).toBe(true);
        expect(sameAmount(money(v, cur), money(v + 1, cur))).toBe(false);
      }
    }
    expect(sameAmount("₹1,500", "₹1,500.00")).toBe(true);
    expect(sameAmount("₹1,50,000", "₹150,000")).toBe(true);
  });
});

describe("Stop and Retry: nothing goes on without a fresh, correct yes", () => {
  it("'Stop turning the ads on' while the turn-on plan runs keeps the campaign paused (it is turned on last)", async () => {
    const { accountId, batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    await queueGoLive(batchId);
    // The plan lane starts turning things on (ads first, campaign last). The person presses Stop on
    // the batch page ("Stop turning the ads on") right after the first ad went on.
    const orig = mock.fetch;
    const stops: ReturnType<typeof cancelBatch>[] = [];
    mock.fetch = async (input, init) => {
      if (!stops.length && (init?.method ?? "GET").toUpperCase() === "POST" && /status=ACTIVE/.test(String(init?.body ?? ""))) stops.push(cancelBatch(key));
      return orig(input, init);
    };
    try {
      await runTurnOn(key, accountId);
    } finally {
      mock.fetch = orig;
    }
    expect(stops[0].cancelled[0]).toMatchObject({ key, result: "turn_on_stopping" });
    // Nothing spends while the campaign is off: Stop must keep it off.
    expect(status("c1")).toBe("PAUSED");
    expect(status("as1")).toBe("PAUSED");
  }, 120_000);

  it("a batch stopped before this update still counts as stopped: a Retry after the update does not use the old yes", () => {
    // A database from before migration 5, with a batch whose launch was stopped (cancel_requested = 1).
    const old = new Database(":memory:");
    for (let v = 0; v < 4; v++) old.exec(migrations[v]);
    old.pragma("user_version = 4");
    setDb(old);
    const acc = upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
    const id = newBatch(acc, "test@example.com");
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    updateBatch(id, { go_live: "now", status: "partial", cancel_requested: 1, launched_at: tenMinAgo, finished_at: tenMinAgo });
    migrate(old);
    const row = old.prepare("SELECT * FROM batches WHERE id = ?").get(id) as BatchRow;
    // Retry clears cancel_requested and sets retried_at; the Stop must still be remembered.
    const afterRetry = { ...row, cancel_requested: 0, retried_at: new Date().toISOString() } as BatchRow;
    expect(goLiveHold(afterRetry) ?? "no hold").toMatch(/stopped/);
    // What the person sees when pressing Retry on it (every ad in, only the turn-on left).
    old.prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(acc);
    expect(retryFailed(row.key).message).toMatch(/NOT turned on by themselves/);
  });

  it("a Retry pressed right after a long first run (3 hours, 1 ad failed) is still the launch that was confirmed", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    const ad = getAds(batchId)[8];
    db().prepare("UPDATE ads SET status = 'failed', error = 'x' WHERE id = ?").run(ad.id);
    // The run started 3 hours ago and ended a minute ago with 1 ad not created.
    updateBatch(batchId, { status: "partial", launched_at: new Date(Date.now() - 3 * 3600_000).toISOString(), finished_at: new Date(Date.now() - 60_000).toISOString() });
    const r = retryFailed(key);
    expect(r.message).not.toMatch(/NOT turned on/);
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    expect(await queueGoLive(batchId)).toMatch(/^Turning the ads on now/);
  }, 120_000);
});

describe("what turns ads on is checked when it runs, and the page says what will happen", () => {
  it("a 'now' turn-on plan that waited in the plan lane while a budget was raised in Ads Manager is checked again", async () => {
    const { accountId, batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key); // ₹500
    await runBatch(batchId, deps);
    expect(await queueGoLive(batchId)).toMatch(/^Turning the ads on now/);
    // The plan lane is busy with another long plan; meanwhile as1 is raised to ₹5,000 in Ads Manager.
    mock.objects.get("as1")!.daily_budget = "500000";
    const r = await runTurnOn(key, accountId);
    // ₹5,000 a day was never typed: the ads must not be turned on with the old yes.
    expect(status("as1") === "ACTIVE" && status("c1") === "ACTIVE" && !r.reopened).toBe(false);
  }, 120_000);

  it("a long 'now' launch that just finished: the page doesn't say 'won't be turned on by themselves' when the worker then turns them on", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    // The run started 2 hours ago (starter tier) and just ended; the worker's turn-on step comes next
    // (or its 5-minute retry after a Meta hiccup). No Stop, no Retry.
    updateBatch(batchId, { launched_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const said = goLiveLine(await batchView(key));
    await goLive(batchId);
    const p = goLivePlan(key);
    expect({ said, plan: p?.status }).not.toEqual({ said: expect.stringMatching(/won't be turned on by themselves/), plan: "queued" });
  }, 120_000);
});

describe("the batch finds its own turn-on plan", () => {
  it("a turn-on plan given another title (update_plan / plan page) is still the batch's: Stop cancels it", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "at", goLiveAt: new Date(Date.now() + 86_400_000).toISOString() });
    await launchTyped(key);
    await runBatch(batchId, deps);
    cancelBatch(key);
    retryFailed(key);
    await goLive(batchId); // Stop then Retry: a draft to confirm
    const plan = goLivePlan(key)!;
    expect(plan.status).toBe("draft");
    await updatePlan(plan.key, { title: "Turn on the November ads" });
    const typed = JSON.parse(db().prepare("SELECT summary FROM plans WHERE key = ?").pluck().get(plan.key) as string).spendConfirmation;
    await confirmPlan(plan.key, { confirm: true, acceptWarnings: true, spendConfirmation: typed }, "test@example.com");
    // Queued for tomorrow. The person changes their mind and presses "Don't turn the ads on" on the batch.
    let answer = "";
    try {
      answer = JSON.stringify(cancelBatch(key).cancelled);
    } catch (e) {
      answer = (e as Error).message;
    }
    const left = db().prepare("SELECT status FROM plans WHERE key = ?").pluck().get(plan.key);
    expect({ left, answer }).toEqual({ left: "cancelled", answer: expect.stringContaining(plan.key) });
  }, 120_000);
});

describe("checked and fine: Stop, Retry, races", () => {
  it("Stop while one ad set's ads are all in (waiting) and another is still launching: neither is turned on, both are named", async () => {
    // Round 3: the ad sets of a launch are turned on together, so nothing is on before the last one is in.
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now", extraAdsetIds: ["as4"] });
    await launchTyped(key);
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    await runBatch(batchId, deps);
    expect(await queueGoLive(batchId)).toMatch(/waits for the other ad sets/);
    updateBatch(sib.id, { status: "running" });
    const r = cancelBatch(key);
    expect(r.cancelled).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: sib.key, result: "stopping" }),
      expect.objectContaining({ key, result: "turn_on_cancelled" }),
    ]));
    expect(stoppedText(r.cancelled, key)).toMatch(/nothing is deleted or turned on/);
    // The second launch ends (the Stop was seen) and makes no turn-on plan.
    await runBatch(sib.id, deps);
    expect(await queueGoLive(sib.id)).toMatch(/skipped: the launch was stopped/);
    expect(goLivePlan(sib.key)).toBeNull();
    expect(goLivePlan(key)).toBeNull();
    expect(status("c1")).toBe("PAUSED");
  }, 120_000);

  it("Stop after the launch's one turn-on plan ran: every ad set is named as already on", async () => {
    const { accountId, batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now", extraAdsetIds: ["as4"] });
    await launchTyped(key);
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    await runBatch(batchId, deps);
    await queueGoLive(batchId);
    await runBatch(sib.id, deps);
    await queueGoLive(sib.id);
    await runTurnOn(key, accountId);
    let said = "";
    try {
      cancelBatch(key);
    } catch (e) {
      said = (e as Error).message;
    }
    expect(said).toMatch(new RegExp(`already turned on by plan ${goLivePlan(key)!.key}. Stop doesn't turn them off`));
  }, 120_000);

  it("Stop on a group, then Retry on one batch: its plan is a draft; the other batch stays stopped with no plan", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now", extraAdsetIds: ["as4"] });
    await launchTyped(key);
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    cancelBatch(key); // both still waiting in the launch lane
    expect(retryFailed(key).message).toMatch(/NOT turned on by themselves: the launch was stopped/);
    await runBatch(batchId, deps);
    expect(await queueGoLive(batchId)).toMatch(/NOT turned on: the launch was stopped/);
    expect(planStatus(key)).toBe("draft");
    expect(await queueGoLive(sib.id)).toMatch(/skipped: the launch was stopped/);
    expect(goLivePlan(sib.key)).toBeNull();
    expect(status("c1")).toBe("PAUSED");
  }, 120_000);

  it("Retry with no failed ads after a Stop: only the turn-on step runs, as a draft; the batch stays done", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    expect(cancelBatch(key).cancelled[0]).toMatchObject({ result: "turn_on_cancelled" });
    const r = retryFailed(key);
    expect(r).toMatchObject({ retried: 0, goLive: true });
    expect(getBatch(batchId)!.status).toBe("done");
    const job = db().prepare("SELECT * FROM jobs WHERE kind = 'golive' AND batch_id = ? AND status = 'queued'").get(batchId);
    expect(job).toBeTruthy();
    await runJob(job as never);
    expect(planStatus(key)).toBe("draft");
    expect(getBatch(batchId)!.status).toBe("done");
  }, 120_000);

  it("the launch's own turn-on and a golive job at the same moment make one plan", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    await Promise.all([goLive(batchId), goLive(batchId)]);
    expect(db().prepare("SELECT COUNT(*) FROM plans WHERE title LIKE ?").pluck().get(`Turn on batch ${key} (%`)).toBe(1);
  }, 120_000);

  it("worker restart mid turn-on, Stop pressed while it was down: the plan does not continue", async () => {
    const { accountId, batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    await queueGoLive(batchId);
    const pid = planId(key);
    const first = getAds(batchId)[0].meta_ad_id!;
    // The worker turned the first ad on, then died with the step marked running.
    mock.objects.get(first)!.status = "ACTIVE";
    db().prepare("UPDATE plans SET status = 'running', progress = ? WHERE id = ?").run(JSON.stringify([{ status: "running", ids: [first], message: "" }]), pid);
    expect(cancelBatch(key).cancelled[0]).toMatchObject({ result: "turn_on_stopping" });
    // The worker comes back and picks the plan job again.
    const job = db().prepare("SELECT * FROM jobs WHERE kind = 'plan' AND batch_id = ?").get(pid) as Record<string, unknown>;
    await runJob({ ...job, status: "running" } as never);
    expect(status("c1")).toBe("PAUSED");
    expect(status(getAds(batchId)[1].meta_ad_id!)).toBe("PAUSED");
    void accountId;
  }, 120_000);

  it("a turn-on plan cancelled by Stop never runs, even if the plan lane already picked its job", async () => {
    const { accountId, batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "at", goLiveAt: new Date(Date.now() + 86_400_000).toISOString() });
    await launchTyped(key);
    await runBatch(batchId, deps);
    await queueGoLive(batchId);
    cancelBatch(key);
    expect(await runTurnOn(key, accountId)).toEqual({ done: 0, failed: 0 });
    expect(status("c1")).toBe("PAUSED");
  }, 120_000);

  it("a draft turn-on plan confirmed later, after a budget was raised in Ads Manager: refused with the new total", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    cancelBatch(key);
    retryFailed(key);
    await goLive(batchId);
    const plan = goLivePlan(key)!;
    expect(plan.status).toBe("draft");
    mock.objects.get("as1")!.daily_budget = "90000"; // ₹900
    await expect(confirmPlan(plan.key, { confirm: true, acceptWarnings: true, spendConfirmation: "₹500" }, "test@example.com")).rejects.toThrow(/now ₹900 a day/);
    expect(status("c1")).toBe("PAUSED");
  }, 120_000);

  it("the batch page after Stop then Retry says plainly the ads are not turned on by themselves", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    cancelBatch(key);
    const v = await batchView(key);
    expect(v.goLiveHold).toMatch(/^the launch was stopped \(/);
    expect(v.stoppedAt).toBeTruthy();
  }, 120_000);
});
