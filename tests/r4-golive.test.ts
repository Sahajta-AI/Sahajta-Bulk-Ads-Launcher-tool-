import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { goLiveNote, recentAlerts } from "@/lib/alerts";
import { runBatch } from "@/lib/engine/launcher";
import { GO_LIVE_NOTE_MS, goLiveRetryKey } from "@/lib/jobs";
import { goLiveHold, goLivePlan, lateRetryFrom, queueGoLive, siblings } from "@/lib/manage/golive";
import { runPlan } from "@/lib/manage/plan";
import { confirmPlan, updatePlan } from "@/lib/manage/service";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { localFiles } from "@/lib/sources/local";
import { batchLaunchSummary, batchView, cancelBatch, launchBatch, updateSettings } from "@/lib/service";
import { cacheSet, getAds, getBatch, updateBatch } from "@/lib/store";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Round 4 (GOLIVE4): the batch turn-on after the third review. Practice Meta only (MockMeta).

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let folder: string;
let clock: FakeClock;
let mock: MockMeta;
const HOUR = 3600_000;
const DAY = 86_400_000;

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
  const deps = { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "r4-golive-")) };
  return { accountId, batchId, key: getBatch(batchId)!.key, deps };
}

/** Launch as the page does: the total typed back exactly as the summary shows it. */
async function launchTyped(key: string) {
  const typed = (await batchLaunchSummary(key)).launch!.spendConfirmation!;
  await launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: typed });
  return typed;
}

async function twoAdSets(goLive: "now" | "at" = "now", at?: string) {
  const b = await batch();
  await updateSettings(b.key, { goLive, goLiveAt: at, extraAdsetIds: ["as4"] });
  await launchTyped(b.key);
  const sib = siblings(getBatch(b.batchId)!).find((x) => x.id !== b.batchId)!;
  return { ...b, sib };
}

const status = (id: string) => mock.objects.get(id)?.status;
const planStatus = (key: string) => db().prepare("SELECT status FROM plans WHERE key = ?").pluck().get(key) as string;
const planJobs = (key: string) => db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan' AND status = 'queued' AND batch_id = (SELECT id FROM plans WHERE key = ?)").pluck().get(key) as number;
const golive = (link: string) => recentAlerts(50).filter((a) => a.link.endsWith(link) && a.kind === "golive");

describe("1: Stop cancels every turn-on plan of the launch that has not run", () => {
  it("a second waiting plan for the same batch (as an older launch could leave) is cancelled too, with its job", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "at", goLiveAt: new Date(Date.now() + 2 * DAY).toISOString() });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    expect(await queueGoLive(b.batchId)).toMatch(/^The ads will be turned on at/);
    const plan = goLivePlan(b.key)!;
    // An older copy of the plan for the same batch, still waiting with its own job.
    const row = db().prepare("SELECT * FROM plans WHERE key = ?").get(plan.key) as Record<string, unknown>;
    const older = Number(db().prepare("INSERT INTO plans (key, ad_account_id, title, status, ops, summary, can_spend, run_at, created_by, batch_id) VALUES ('pdup1', ?, ?, 'queued', ?, ?, 1, ?, ?, ?)").run(row.ad_account_id, row.title, row.ops, row.summary, row.run_at, row.created_by, b.batchId).lastInsertRowid);
    db().prepare("INSERT INTO jobs (kind, batch_id, run_after) VALUES ('plan', ?, ?)").run(older, Date.now() + 2 * DAY);
    expect(goLivePlan(b.key)!.key).toBe("pdup1"); // the newest one is the one the page shows
    const r = cancelBatch(b.key);
    expect(r.cancelled.map((c) => c.result)).toEqual(["turn_on_cancelled"]);
    expect([planStatus(plan.key), planStatus("pdup1")]).toEqual(["cancelled", "cancelled"]);
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan' AND status = 'queued'").pluck().get()).toBe(0);
  }, 120_000);

  it("Stop on the other ad set's page cancels the launch's plan even when it was edited to leave that ad set out", async () => {
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    await queueGoLive(b.batchId);
    await runBatch(b.sib.id, b.deps);
    mock.objects.get("as4")!.daily_budget = "90000"; // ₹900 in Ads Manager: held
    expect(await queueGoLive(b.sib.id)).toMatch(/NOT turned on/);
    const plan = goLivePlan(b.key)!;
    // The person keeps only the first ad set's ads and confirms that (a fresh yes).
    const ops = JSON.parse(db().prepare("SELECT ops FROM plans WHERE key = ?").pluck().get(plan.key) as string) as { ops: { ads: string[]; adsets: string[]; campaigns: string[] }[] };
    const mine = getAds(b.batchId).map((a) => a.meta_ad_id!);
    await updatePlan(plan.key, { ops: [{ ...ops.ops[0], ads: mine, adsets: ["as1"] }] as never });
    const typed = (JSON.parse(db().prepare("SELECT summary FROM plans WHERE key = ?").pluck().get(plan.key) as string) as { spendConfirmation: string }).spendConfirmation;
    await confirmPlan(plan.key, { confirm: true, acceptWarnings: true, spendConfirmation: typed }, "test@example.com");
    expect(planStatus(plan.key)).toBe("queued");
    expect(goLivePlan(b.sib.key)).toBeNull(); // none of its ads are in that plan any more
    const r = cancelBatch(b.sib.key);
    expect(r.cancelled.map((c) => [c.key, c.result, c.planKey])).toEqual([[b.key, "turn_on_cancelled", plan.key]]);
    expect(planStatus(plan.key)).toBe("cancelled");
    expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
  }, 120_000);
});

describe("3: a launch from before the typed total was kept", () => {
  it("its turn-on plan is a draft that needs a new yes, with that reason; nothing is queued", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now" });
    await launchTyped(b.key);
    updateBatch(b.batchId, { go_live_total: null, go_live_total_at: null });
    await runBatch(b.batchId, b.deps);
    const msg = await queueGoLive(b.batchId);
    expect(msg).toMatch(/^Ads created but NOT turned on: the total typed at launch was not kept, so the turn-on needs a new yes\. The turn-on plan \w+ is saved as a draft/);
    expect(goLivePlan(b.key)?.status).toBe("draft");
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan'").pluck().get()).toBe(0);
    expect(golive(`/plans/${goLivePlan(b.key)!.key}`)).toHaveLength(1);
  }, 120_000);
});

describe("4: only what the turn-on starts counts against the typed total", () => {
  it("X then Y into one campaign: Y's own ad set raised after the launch is still held, and the words say what is counted", async () => {
    const x = await batch();
    const y = await batch({ adsetId: "as4" });
    await updateSettings(x.key, { goLive: "now" });
    await updateSettings(y.key, { goLive: "now" });
    await launchTyped(x.key);
    expect(await launchTyped(y.key)).toBe("₹800");
    await runBatch(x.batchId, x.deps);
    await queueGoLive(x.batchId);
    await runPlan(db().prepare("SELECT id FROM plans WHERE key = ?").pluck().get(goLivePlan(x.key)!.key) as number, { client: clientFor(x.accountId), clock });
    expect(status("as1")).toBe("ACTIVE");
    await runBatch(y.batchId, y.deps);
    mock.objects.get("as4")!.daily_budget = "90000"; // ₹900 in Ads Manager
    expect(await queueGoLive(y.batchId)).toMatch(/NOT turned on: what the budgets it turns on can spend is now ₹900 a day \(budgets already spending before it are not counted\), not the ₹800 typed at launch, so the budget confirmation given at launch is not used/);
    expect(goLivePlan(y.key)?.status).toBe("draft");
    expect(status("as4")).toBe("PAUSED");
  }, 180_000);

  it("an ad set already on in a running campaign, raised after the launch, is not held by the new launch into another ad set", async () => {
    const b = await batch({ adsetId: "as4" });
    Object.assign(mock.objects.get("c1")!, { status: "ACTIVE" });
    Object.assign(mock.objects.get("as1")!, { status: "ACTIVE", effective_status: "ACTIVE" });
    await updateSettings(b.key, { goLive: "now" });
    expect(await launchTyped(b.key)).toBe("₹1,300"); // as1 already on counts in the total shown
    await runBatch(b.batchId, b.deps);
    mock.objects.get("as1")!.daily_budget = "500000"; // ₹5,000: it already spends; this launch doesn't start it
    expect(await queueGoLive(b.batchId)).toMatch(/^Turning the ads on now/);
  }, 120_000);
});

describe("5: 'at a time' and a Retry", () => {
  const row = (o: { at: number; ended: number }) => ({ go_live: "at" as const, go_live_at: new Date(o.at).toISOString(), finished_at: new Date(o.ended).toISOString() });
  it("late only when the Retry comes more than an hour after the later of the set time and the end of the run before it", () => {
    const now = Date.now();
    expect(lateRetryFrom(row({ at: now - 2 * HOUR, ended: now - 30 * 60_000 }), now)).toBeNull(); // the run ended late, Retry soon after
    expect(lateRetryFrom(row({ at: now - 2 * HOUR, ended: now - 90 * 60_000 }), now)).toBe(new Date(now - 90 * 60_000).toISOString()); // the run's end
    expect(lateRetryFrom(row({ at: now - 2 * HOUR, ended: now - 3 * HOUR }), now)).toBe(new Date(now - 2 * HOUR).toISOString()); // the set time
    expect(lateRetryFrom(row({ at: now + DAY, ended: now - 3 * HOUR }), now)).toBeNull(); // the time is still to come
    expect(lateRetryFrom({ go_live: "now", go_live_at: null, finished_at: new Date(now - 2 * HOUR).toISOString() }, now)).toBe(new Date(now - 2 * HOUR).toISOString());
    expect(lateRetryFrom({ go_live: "paused", go_live_at: null, finished_at: new Date(now - 2 * HOUR).toISOString() }, now)).toBeNull();
  });

  it("the page: no hold while the first run ends late; the Retry button says a Retry now would not use the yes (set time named)", async () => {
    const b = await batch();
    const at = new Date(Date.now() + 10 * 60_000).toISOString();
    await updateSettings(b.key, { goLive: "at", goLiveAt: at });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    db().prepare("UPDATE ads SET status = 'failed', error = 'x' WHERE id = ?").run(getAds(b.batchId)[8].id);
    // Three hours after the set time; the run ended before it.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(at) + 3 * HOUR });
    updateBatch(b.batchId, { status: "partial", finished_at: new Date(Date.parse(at) - 60_000).toISOString() });
    const v = await batchView(b.key);
    expect(v.goLiveHold).toBeNull();
    expect(v.retryHold).toMatch(/^more than an hour passed between the time set to turn them on \(.*\) and the Retry$/);
    // Once the Retry is kept on the batch (late_retry_from), the turn-on plan is a draft with the same words.
    updateBatch(b.batchId, { late_retry_from: at, retried_at: new Date().toISOString() });
    expect(goLiveHold(getBatch(b.batchId)!)).toMatch(/^more than an hour passed between the time set to turn them on/);
    db().prepare("UPDATE ads SET status = 'done' WHERE batch_id = ?").run(b.batchId);
    updateBatch(b.batchId, { status: "done" });
    expect(await queueGoLive(b.batchId)).toMatch(/NOT turned on: more than an hour passed between the time set to turn them on .* and the Retry, so the budget confirmation given at launch is not used/);
  }, 120_000);
});

describe("6: the plan is queued with its job, or not at all", () => {
  it("a database error at the job: nothing of the turn-on stays (no plan, not marked done); the next try queues it with one job", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now" });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    db().exec("CREATE TRIGGER busy_once BEFORE INSERT ON jobs WHEN NEW.kind = 'plan' BEGIN SELECT RAISE(ABORT, 'database is locked'); END");
    await expect(queueGoLive(b.batchId)).rejects.toThrow(/database is locked/);
    db().exec("DROP TRIGGER busy_once");
    expect(db().prepare("SELECT COUNT(*) FROM plans").pluck().get()).toBe(0);
    expect(getBatch(b.batchId)!.go_live_done).toBe(0);
    expect(await queueGoLive(b.batchId)).toMatch(/^Turning the ads on now/);
    expect(planJobs(goLivePlan(b.key)!.key)).toBe(1);
  }, 120_000);

  it("a confirmed plan left with no job (older data): the next turn-on step queues it again, once", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "at", goLiveAt: new Date(Date.now() + 2 * DAY).toISOString() });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    await queueGoLive(b.batchId);
    const key = goLivePlan(b.key)!.key;
    db().prepare("DELETE FROM jobs WHERE kind = 'plan'").run();
    expect(await queueGoLive(b.batchId)).toMatch(/was confirmed but not waiting to run; it is queued again/);
    expect(planJobs(key)).toBe(1);
    const job = db().prepare("SELECT run_after FROM jobs WHERE kind = 'plan'").pluck().get() as number;
    expect(job).toBe(Date.parse(db().prepare("SELECT run_at FROM plans WHERE key = ?").pluck().get(key) as string)); // at its time, not now
    expect(await queueGoLive(b.batchId)).toBeNull();
    expect(planJobs(key)).toBe(1);
    // A draft is never queued this way.
    db().prepare("UPDATE plans SET status = 'draft' WHERE key = ?").run(key);
    db().prepare("DELETE FROM jobs WHERE kind = 'plan'").run();
    expect(await queueGoLive(b.batchId)).toBeNull();
    expect(planJobs(key)).toBe(0);
  }, 120_000);
});

describe("7: the page of the other ad set reads the launch's turn-on tries", () => {
  it("while the worker tries again for the last ad set, the first one's page says so (not 'turned on once every ad is in')", async () => {
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    await runBatch(b.sib.id, b.deps);
    cacheSet(goLiveRetryKey(b.sib.id), 2, GO_LIVE_NOTE_MS);
    cacheSet(`${goLiveRetryKey(b.sib.id)}info`, { reason: "Meta is busy", nextAt: Date.now() + 5 * 60_000 }, GO_LIVE_NOTE_MS);
    db().prepare("INSERT INTO jobs (kind, batch_id, run_after) VALUES ('golive', ?, ?)").run(b.sib.id, Date.now() + 5 * 60_000);
    expect(goLiveNote(b.batchId)).toMatch(/^Turning the ads on failed 2 times \(Meta is busy\)\. Trying again at .* IST\.$/);
    expect(goLiveNote(b.sib.id)).toMatch(/^Turning the ads on failed 2 times/);
    // A batch of another launch is not affected.
    const other = await batch();
    await updateSettings(other.key, { goLive: "now" });
    expect(goLiveNote(other.batchId)).toBeNull();
  }, 120_000);
});

describe("9: two turn-on steps that keep meeting another ad set's new plan", () => {
  it("checked again once with the ad sets left; if it happens again, a plain error so the worker tries again", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now", extraAdsetIds: ["as4", "as3"] });
    await launchTyped(b.key);
    const all = siblings(getBatch(b.batchId)!);
    expect(all).toHaveLength(3);
    for (const x of all) await runBatch(x.id, b.deps);
    const [first, second, last] = all;
    // Each time the last ad set's step reads its ads in Meta, another ad set of its group gets a plan of
    // its own meanwhile (first while it checks all three, then the second while it checks the two left).
    const orig = mock.fetch;
    const has = (u: string, id: number) => getAds(id).some((a) => u.includes(`"${a.meta_ad_id}"`));
    mock.fetch = async (i, init) => {
      const u = decodeURIComponent(String(i));
      if (/\/ads\?/.test(u) && has(u, last.id)) {
        if (has(u, first.id)) updateBatch(first.id, { go_live_done: 1 });
        else if (has(u, second.id)) updateBatch(second.id, { go_live_done: 1 });
      }
      return orig(i, init);
    };
    await expect(queueGoLive(last.id)).rejects.toThrow(/^the turn-on plan of another ad set of this launch was made at the same moment; trying again$/);
    mock.fetch = orig;
    expect(getBatch(last.id)!.go_live_done).toBe(0);
    expect(db().prepare("SELECT COUNT(*) FROM plans").pluck().get()).toBe(0);
    // The worker's next try: its own plan.
    expect(await queueGoLive(last.id)).toMatch(/^Turning the ads on now/);
    expect(db().prepare("SELECT batch_id FROM plans").pluck().get()).toBe(last.id);
  }, 180_000);
});

describe("small: the draft email", () => {
  it("a draft cancelled right after it was saved (a Stop at that moment) is not emailed; a held draft is", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now" });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    mock.objects.get("as1")!.daily_budget = "90000"; // held: ₹900, not ₹500
    // The Stop lands between the save and the email (as the batch log is written).
    db().exec("CREATE TRIGGER stop_now AFTER INSERT ON events WHEN NEW.message LIKE 'Ads created but NOT turned on%' BEGIN UPDATE plans SET status = 'cancelled'; END");
    expect(await queueGoLive(b.batchId)).toMatch(/NOT turned on/);
    db().exec("DROP TRIGGER stop_now");
    const key = goLivePlan(b.key)!.key;
    expect(planStatus(key)).toBe("cancelled");
    expect(golive(`/plans/${key}`)).toHaveLength(0);
    // The same hold without the Stop: emailed (kept on the home page).
    const c = await batch();
    await updateSettings(c.key, { goLive: "now" });
    await launchTyped(c.key); // ₹900 now
    await runBatch(c.batchId, c.deps);
    mock.objects.get("as1")!.daily_budget = "120000"; // ₹1,200: held
    expect(await queueGoLive(c.batchId)).toMatch(/NOT turned on/);
    expect(golive(`/plans/${goLivePlan(c.key)!.key}`)).toHaveLength(1);
  }, 180_000);

  it("Stop pressed while the turn-on was being checked: a draft is kept, no email", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now" });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    const orig = mock.fetch;
    let stopped = false;
    mock.fetch = async (i, init) => {
      if (!stopped) {
        stopped = true;
        cancelBatch(b.key);
      }
      return orig(i, init);
    };
    expect(await queueGoLive(b.batchId)).toMatch(/NOT turned on: the launch was stopped/);
    mock.fetch = orig;
    expect(goLivePlan(b.key)?.status).toBe("draft");
    expect(golive(`/plans/${goLivePlan(b.key)!.key}`)).toHaveLength(0);
  }, 120_000);
});
