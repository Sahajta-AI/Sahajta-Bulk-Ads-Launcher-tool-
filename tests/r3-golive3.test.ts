import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { batchLaunchSummary, batchView, cancelBatch, launchBatch, retryFailed, runPreview, updateSettings } from "@/lib/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { goLiveLine, retryOffer, retryQuestion } from "@/app/batches/[key]/batch-logic";
import type { BatchRow } from "@/lib/types";
import { runClaimed } from "@/worker/run";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Round 3 (GOLIVE3): normal launches are turned on as confirmed, with one turn-on plan for all the ad
// sets of a launch, whose total is the total typed at launch. Practice Meta only (MockMeta).

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
  const deps = { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "r3-golive3-")) };
  return { accountId, batchId, key: getBatch(batchId)!.key, deps };
}

/** Launch as the page does: the total typed back exactly as the summary shows it. */
async function launchTyped(key: string) {
  const typed = (await batchLaunchSummary(key)).launch!.spendConfirmation!;
  await launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: typed });
  return typed;
}

const status = (id: string) => mock.objects.get(id)?.status;
const planRow = (batchKey: string) => db().prepare("SELECT * FROM plans WHERE key = ?").get(goLivePlan(batchKey)!.key) as { id: number; key: string; status: string; summary: string; batch_id: number | null; run_at: string | null };

/**
 * Every batch of the launch is created (in launch order), and the worker's turn-on step runs after
 * each, as afterLaunch does. Returns the last step's answer, the turn-on plan, and the plan's total.
 */
async function runLaunch(b: Awaited<ReturnType<typeof batch>>) {
  let msg: string | null = null;
  for (const x of siblings(getBatch(b.batchId)!)) {
    expect(await runBatch(x.id, b.deps)).toEqual({ done: 9, failed: 0 });
    msg = await queueGoLive(x.id);
  }
  const plan = goLivePlan(b.key);
  const summary = plan ? (JSON.parse(planRow(b.key).summary) as PlanSummary) : null;
  return { msg, plan, planTotal: summary?.spendConfirmation ?? null };
}

/** The plan lane runs the turn-on plan (as the worker does): nothing reopened, every step done. */
async function runTurnOn(b: Awaited<ReturnType<typeof batch>>) {
  const r = await runPlan(planRow(b.key).id, { client: clientFor(b.accountId), clock });
  expect(r.reopened ?? "not reopened").toBe("not reopened");
  expect(r).toMatchObject({ done: 1, failed: 0 });
  return r;
}

/** The normal launch: queued as confirmed, the plan's total is the typed one, and it turns everything on. */
async function expectTurnedOnAsConfirmed(b: Awaited<ReturnType<typeof batch>>, typed: string, campaigns: string[]) {
  const { msg, plan, planTotal } = await runLaunch(b);
  expect(msg).toMatch(/^(Turning the ads on now|The ads will be turned on at)/);
  expect(plan?.status).toBe("queued");
  expect(sameAmount(planTotal ?? "", typed)).toBe(true);
  for (const x of siblings(getBatch(b.batchId)!)) expect(goLivePlan(x.key)).toEqual(plan); // one plan for the launch
  await runTurnOn(b);
  const ads = siblings(getBatch(b.batchId)!).flatMap((x) => getAds(x.id));
  expect(ads.every((a) => status(a.meta_ad_id!) === "ACTIVE")).toBe(true);
  expect([...new Set(ads.map((a) => a.meta_adset_id!))].every((id) => status(id) === "ACTIVE")).toBe(true);
  for (const c of campaigns) expect(status(c)).toBe("ACTIVE");
}

const inTwoDays = () => new Date(Date.now() + 2 * DAY).toISOString();

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

describe("normal launches: turned on as confirmed, no hold", () => {
  it("paused: no turn-on plan, everything stays paused", async () => {
    const b = await batch();
    await launchBatch(b.key, { confirm: true, acceptWarnings: true });
    const { msg, plan } = await runLaunch(b);
    expect(msg).toBeNull();
    expect(plan).toBeNull();
    expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
    expect(status("c1")).toBe("PAUSED");
  }, 120_000);

  it("now, existing ad set", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now" });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹500");
    await expectTurnedOnAsConfirmed(b, typed, ["c1"]);
  }, 120_000);

  it("at a time, existing ad set", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "at", goLiveAt: inTwoDays() });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹500");
    await expectTurnedOnAsConfirmed(b, typed, ["c1"]);
    expect(planRow(b.key).run_at).toBeTruthy();
  }, 120_000);

  it("now, a new ad set for each ad", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now", adsetMode: "new_per_ad" });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹4,500"); // 9 copies of ₹500
    await expectTurnedOnAsConfirmed(b, typed, ["c1"]);
  }, 120_000);

  it("now, one new ad set shared by all ads", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now", adsetMode: "new_shared" });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹500");
    await expectTurnedOnAsConfirmed(b, typed, ["c1"]);
  }, 120_000);

  it("now, a campaign-budget campaign", async () => {
    const b = await batch({ adsetId: "as3" });
    await updateSettings(b.key, { adsetId: "as3", goLive: "now" });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹1,000");
    await expectTurnedOnAsConfirmed(b, typed, ["c2"]);
  }, 120_000);

  it("now, a lifetime budget ad set", async () => {
    const b = await batch();
    Object.assign(mock.objects.get("as1")!, { daily_budget: undefined, lifetime_budget: "3000000", end_time: new Date(Date.now() + 5 * DAY + HOUR).toISOString() });
    await updateSettings(b.key, { goLive: "now" });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹6,000"); // ₹30,000 ÷ 5 whole days
    await expectTurnedOnAsConfirmed(b, typed, ["c1"]);
  }, 120_000);

  it("at a time, a lifetime campaign budget: counted from the time", async () => {
    const b = await batch({ adsetId: "as3" });
    const c2 = mock.objects.get("c2")!;
    delete c2.daily_budget;
    Object.assign(c2, { lifetime_budget: "2000000", stop_time: new Date(Date.now() + 6 * DAY + HOUR).toISOString() }); // ₹20,000
    await updateSettings(b.key, { adsetId: "as3", goLive: "at", goLiveAt: inTwoDays() });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹5,000"); // 4 whole days left from the time
    await expectTurnedOnAsConfirmed(b, typed, ["c2"]);
  }, 120_000);

  it("now, a lifetime budget: a launch that runs past a whole-day mark is still turned on", async () => {
    const b = await batch();
    Object.assign(mock.objects.get("as1")!, { daily_budget: undefined, lifetime_budget: "3000000", end_time: new Date(Date.now() + 5 * DAY + 20 * 60_000).toISOString() });
    await updateSettings(b.key, { goLive: "now" });
    expect(await launchTyped(b.key)).toBe("₹6,000");
    for (const x of siblings(getBatch(b.batchId)!)) await runBatch(x.id, b.deps);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + HOUR }); // the launch took an hour: 4 whole days left now
    expect(await queueGoLive(b.batchId)).toMatch(/^Turning the ads on now/);
    vi.useRealTimers();
    // The plan itself says what can spend now (₹7,500); the typed ₹6,000 was for the same budgets.
    expect((JSON.parse(planRow(b.key).summary) as PlanSummary).spendConfirmation).toBe("₹7,500");
  }, 120_000);

  it("now, several ad sets in one campaign", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now", extraAdsetIds: ["as4"] });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹1,300");
    await expectTurnedOnAsConfirmed(b, typed, ["c1"]);
  }, 120_000);

  it("at a time, several ad sets in one campaign: the plan is checked at the time and runs", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "at", goLiveAt: inTwoDays(), extraAdsetIds: ["as4"] });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹1,300");
    await expectTurnedOnAsConfirmed(b, typed, ["c1"]);
  }, 120_000);

  it("now, two ad sets of one campaign-budget campaign: the campaign budget counts once", async () => {
    mock.objects.set("as5", { ...mock.objects.get("as3")!, id: "as5", name: "CBO ad set 2", status: "PAUSED", effective_status: "PAUSED" });
    const b = await batch({ adsetId: "as3" });
    await updateSettings(b.key, { adsetId: "as3", goLive: "now", extraAdsetIds: ["as5"] });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹1,000");
    await expectTurnedOnAsConfirmed(b, typed, ["c2"]);
  }, 120_000);

  it("now, several ad sets in different campaigns", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now", extraAdsetIds: ["as3"] });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹1,500"); // ₹500 + the campaign budget ₹1,000
    await expectTurnedOnAsConfirmed(b, typed, ["c1", "c2"]);
  }, 120_000);

  it("now, a new ad set per ad into two ad sets of different campaigns", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now", adsetMode: "new_per_ad", extraAdsetIds: ["as3"] });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹5,500"); // 9 × ₹500, and the campaign budget ₹1,000 once for the 9 copies of the other
    await expectTurnedOnAsConfirmed(b, typed, ["c1", "c2"]);
  }, 120_000);

  it("now, a campaign already running with another ad set on: that ad set counts, and the launch is turned on", async () => {
    const b = await batch();
    Object.assign(mock.objects.get("c1")!, { status: "ACTIVE" });
    Object.assign(mock.objects.get("as4")!, { status: "ACTIVE", effective_status: "ACTIVE" });
    await updateSettings(b.key, { goLive: "now" });
    const s = (await batchLaunchSummary(b.key)).launch!;
    expect(s.alsoSpends.join(" ")).toMatch(/"Min-spend template" in "November tests" \(₹800 a day\) is already on: it counts in the total/);
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹1,300");
    await expectTurnedOnAsConfirmed(b, typed, ["c1"]);
  }, 120_000);

  it("now, into an ad set already on in a running campaign (its old ads on too): turned on as confirmed", async () => {
    // Not everything starts paused: the ad set and the campaign already spend; the launch adds ads to it.
    const b = await batch();
    Object.assign(mock.objects.get("c1")!, { status: "ACTIVE" });
    Object.assign(mock.objects.get("as1")!, { status: "ACTIVE", effective_status: "ACTIVE" });
    await updateSettings(b.key, { goLive: "now" });
    const typed = await launchTyped(b.key);
    expect(typed).toBe("₹500");
    await expectTurnedOnAsConfirmed(b, typed, ["c1"]);
  }, 120_000);

  it("now: batch X, then batch Y into another ad set of the same campaign; X's turn-on runs before Y is in: both turned on as typed", async () => {
    const x = await batch(); // as1, ₹500
    const y = await batch({ adsetId: "as4" }); // as4, ₹800, same campaign c1
    await updateSettings(x.key, { goLive: "now" });
    await updateSettings(y.key, { goLive: "now" });
    expect(await launchTyped(x.key)).toBe("₹500");
    expect(await launchTyped(y.key)).toBe("₹800"); // c1 and as1 still paused: only as4 can spend
    await expectTurnedOnAsConfirmed(x, "₹500", ["c1"]);
    // Y's plan counts what it starts (as4, ₹800 as typed), not as1 that X's plan already turned on.
    const { msg, plan, planTotal } = await runLaunch(y);
    expect(msg).toMatch(/^Turning the ads on now/);
    expect(plan?.status).toBe("queued");
    expect(planTotal).toBe("₹1,300"); // the plan itself still shows all that can spend in the campaign
    await runTurnOn(y);
    expect([status("as1"), status("as4"), status("c1")]).toEqual(["ACTIVE", "ACTIVE", "ACTIVE"]);
    expect(getAds(y.batchId).every((a) => status(a.meta_ad_id!) === "ACTIVE")).toBe(true);
  }, 180_000);

  it("at a time: batch X at one time, batch Y later into the same campaign; X's plan ran before Y's ads were in: Y queued at its time and runs", async () => {
    const x = await batch();
    const y = await batch({ adsetId: "as4" });
    const xAt = new Date(Date.now() + DAY).toISOString();
    const yAt = inTwoDays();
    await updateSettings(x.key, { goLive: "at", goLiveAt: xAt });
    await updateSettings(y.key, { goLive: "at", goLiveAt: yAt });
    expect(await launchTyped(x.key)).toBe("₹500");
    expect(await launchTyped(y.key)).toBe("₹800");
    expect((await runLaunch(x)).msg).toMatch(/^The ads will be turned on at/);
    // X's time comes: its plan runs (c1 and as1 on).
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(xAt) + 60_000 });
    await runTurnOn(x);
    expect([status("c1"), status("as1")]).toEqual(["ACTIVE", "ACTIVE"]);
    // Y's ads go in after that: its plan is queued as confirmed for its own time, not held.
    const { msg, plan } = await runLaunch(y);
    expect(msg).toMatch(/^The ads will be turned on at/);
    expect(plan?.status).toBe("queued");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(yAt) + 60_000 });
    await runTurnOn(y);
    expect(status("as4")).toBe("ACTIVE");
    expect(getAds(y.batchId).every((a) => status(a.meta_ad_id!) === "ACTIVE")).toBe(true);
  }, 180_000);

  it("a Retry right after a long first run (3 hours) still turns the ads on; the page doesn't say otherwise", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now" });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    db().prepare("UPDATE ads SET status = 'failed', error = 'x' WHERE id = ?").run(getAds(b.batchId)[8].id);
    updateBatch(b.batchId, { status: "partial", launched_at: new Date(Date.now() - 3 * HOUR).toISOString(), finished_at: new Date(Date.now() - 60_000).toISOString() });
    const v = await batchView(b.key);
    expect([v.goLiveHold, v.retryHold]).toEqual([null, null]);
    expect(retryQuestion(v, false)).toMatch(/^Retry the failed ads\? Once every ad is in, the ads are turned on straight away/);
    expect(retryFailed(b.key).message).not.toMatch(/NOT turned on/);
    expect(await runBatch(b.batchId, b.deps)).toEqual({ done: 9, failed: 0 });
    expect(await queueGoLive(b.batchId)).toMatch(/^Turning the ads on now/);
  }, 120_000);
});

describe("a Retry long after the launch ended", () => {
  it("the page's next-step line follows the worker; only the Retry button and its question say a Retry would not turn them on", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now" });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    db().prepare("UPDATE ads SET status = 'failed', error = 'x' WHERE id = ?").run(getAds(b.batchId)[8].id);
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR).toISOString();
    updateBatch(b.batchId, { status: "partial", launched_at: twoHoursAgo, finished_at: twoHoursAgo });
    const v = await batchView(b.key);
    expect(v.goLiveHold).toBeNull();
    expect(v.retryHold).toMatch(/^more than an hour passed between the end of the launch \(.* IST\) and the Retry$/);
    expect(goLiveLine(v)).not.toMatch(/won't be turned on by themselves/);
    expect(retryQuestion(v, false)).toMatch(/^Retry the failed ads\? The ads are NOT turned on by themselves: more than an hour passed/);
    // The Retry: once every ad is in, the turn-on plan is a draft.
    expect(retryFailed(b.key).message).toMatch(/The ads are NOT turned on by themselves: more than an hour passed between the end of the launch/);
    // The rerun fails again; a quick second Retry does not bring the old yes back.
    await runBatch(b.batchId, b.deps);
    db().prepare("UPDATE ads SET status = 'failed', error = 'x' WHERE id = ?").run(getAds(b.batchId)[8].id);
    updateBatch(b.batchId, { status: "partial", finished_at: new Date().toISOString() });
    expect((await batchView(b.key)).goLiveHold).toMatch(/more than an hour passed/);
    retryFailed(b.key);
    await runBatch(b.batchId, b.deps);
    expect(await queueGoLive(b.batchId)).toMatch(/NOT turned on: more than an hour passed between the end of the launch .* and the Retry/);
    expect(goLivePlan(b.key)?.status).toBe("draft");
  }, 120_000);

  it("every ad in, the turn-on never made: the button makes the plan to confirm (pressed, run by the worker); nothing turns on", async () => {
    // Round 4: replaces a test that checked the texts only. The button is pressed and the worker runs it.
    const b = await batch();
    await updateSettings(b.key, { goLive: "now" });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    updateBatch(b.batchId, { finished_at: new Date(Date.now() - 3 * HOUR).toISOString() });
    const v = await batchView(b.key);
    expect(retryOffer(v)).toEqual({ label: "Make the turn-on plan to confirm", goLiveOnly: true });
    expect(retryQuestion(v, true)).toMatch(/^Make the plan that turns the ads on\? The ads are NOT turned on by themselves/);
    // Pressed: only the turn-on step runs again (a "golive" job), as the worker runs it.
    const r = retryFailed(b.key);
    expect(r).toMatchObject({ retried: 0, goLive: true });
    expect(r.message).toMatch(/NOT turned on by themselves: more than an hour passed between the end of the launch/);
    const job = claimNext(LANES.other)!;
    expect(job.kind).toBe("golive");
    await runClaimed(job);
    expect(goLivePlan(b.key)?.status).toBe("draft");
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan'").pluck().get()).toBe(0);
    expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
    expect([status("as1"), status("c1")]).toEqual(["PAUSED", "PAUSED"]);
    expect((await batchView(b.key)).events[0].message).toMatch(/^Ads created but NOT turned on: more than an hour passed .* saved as a draft/);
  }, 120_000);
});

describe("one turn-on plan for the ad sets of a launch", () => {
  async function twoAdSets(at?: string) {
    const b = await batch();
    await updateSettings(b.key, { goLive: at ? "at" : "now", goLiveAt: at, extraAdsetIds: ["as4"] });
    await launchTyped(b.key);
    const sib = siblings(getBatch(b.batchId)!).find((x) => x.id !== b.batchId)!;
    return { ...b, sib };
  }

  it("one ad set waits for the other's failed ad; the page says so and offers no Retry there; a Retry on the other turns both on", async () => {
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    await runBatch(b.sib.id, b.deps);
    db().prepare("UPDATE ads SET status = 'failed', error = 'x' WHERE id = ?").run(getAds(b.sib.id)[0].id);
    updateBatch(b.sib.id, { status: "partial", finished_at: new Date(Date.now() - 10 * 60_000).toISOString() });
    updateBatch(b.batchId, { finished_at: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect(await queueGoLive(b.batchId)).toMatch(/has 1 ad not created \(press Retry on batch/);
    const v = await batchView(b.key);
    expect(v.goLiveWaits).toBe(`the launch into ad set "Min-spend template" has 1 ad not created (press Retry on batch ${b.sib.key})`);
    expect(goLiveLine(v)).toMatch(/^The ads are turned on together with the other ad sets of this launch, once every ad is in there too: the launch into ad set "Min-spend template"/);
    expect(retryOffer(v)).toBeNull();
    expect(retryFailed(b.sib.key).message).toMatch(/turned on once every ad is in, together with the other ad sets of this launch/);
    expect(await runBatch(b.sib.id, b.deps)).toEqual({ done: 9, failed: 0 });
    expect(await queueGoLive(b.sib.id)).toMatch(/^Turning the ads on now/);
    expect(goLivePlan(b.key)).toEqual(goLivePlan(b.sib.key));
    expect(planRow(b.key).batch_id).toBe(b.batchId);
  }, 120_000);

  it("a late Retry on one ad set holds the group's plan; Stop on the other cancels it for both", async () => {
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    await queueGoLive(b.batchId);
    await runBatch(b.sib.id, b.deps);
    db().prepare("UPDATE ads SET status = 'failed', error = 'x' WHERE id = ?").run(getAds(b.sib.id)[0].id);
    updateBatch(b.sib.id, { status: "partial", finished_at: new Date(Date.now() - 2 * HOUR).toISOString() });
    retryFailed(b.sib.key);
    await runBatch(b.sib.id, b.deps);
    expect(await queueGoLive(b.sib.id)).toMatch(/NOT turned on: more than an hour passed/);
    const plan = goLivePlan(b.key)!;
    expect(plan.status).toBe("draft");
    expect(goLivePlan(b.sib.key)).toEqual(plan);
    const r = cancelBatch(b.key);
    expect(r.cancelled.map((c) => [c.key, c.result, c.planKey])).toEqual([[b.key, "turn_on_cancelled", plan.key], [b.sib.key, "turn_on_cancelled", plan.key]]);
    expect(goLivePlan(b.key)?.status).toBe("cancelled");
    expect(getBatch(b.sib.id)!.stopped_at).toBeTruthy();
  }, 120_000);

  it("Stop, then Retry on one ad set: its own draft plan; the other's later Retry makes its own; each batch finds its plan", async () => {
    const b = await twoAdSets(inTwoDays());
    await runBatch(b.batchId, b.deps);
    await queueGoLive(b.batchId);
    await runBatch(b.sib.id, b.deps);
    cancelBatch(b.key); // before the plan was made: both stopped
    expect(await queueGoLive(b.sib.id)).toMatch(/skipped: the launch was stopped/);
    retryFailed(b.key);
    expect(await queueGoLive(b.batchId)).toMatch(/NOT turned on: the launch was stopped/);
    const first = goLivePlan(b.key)!;
    expect(goLivePlan(b.sib.key)).toBeNull();
    retryFailed(b.sib.key);
    await queueGoLive(b.sib.id);
    const second = goLivePlan(b.sib.key)!;
    expect(second.key).not.toBe(first.key);
    expect(goLivePlan(b.key)!.key).toBe(first.key);
    expect(JSON.parse((db().prepare("SELECT ops FROM plans WHERE key = ?").pluck().get(first.key)) as string).ops[0].ads).toHaveLength(9);
  }, 120_000);

  it("the two ad sets' turn-on steps at the same moment (both held mid-check by a slow Meta): one plan, one job; the later step makes nothing", async () => {
    // Round 4: the two checks really overlap (both wait for Meta), not one after the other.
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    await runBatch(b.sib.id, b.deps);
    const slow = slowMeta();
    const pA = queueGoLive(b.batchId);
    const pB = queueGoLive(b.sib.id);
    slow.restore();
    slow.release();
    const answers = await Promise.all([pA, pB]);
    expect(answers.filter((a) => a === null)).toHaveLength(1); // this batch is already turned on by that plan
    expect(answers.find((a) => a !== null)).toMatch(/^Turning the ads on now/);
    expect(db().prepare("SELECT COUNT(*) FROM plans").pluck().get()).toBe(1);
    expect(goLivePlan(b.key)?.status).toBe("queued");
    expect(goLivePlan(b.sib.key)).toEqual(goLivePlan(b.key));
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan' AND status = 'queued'").pluck().get()).toBe(1);
  }, 120_000);

  it("two turn-on steps of different groups at the same moment (after Stop, Retry on each): each batch gets its own draft plan", async () => {
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    await runBatch(b.sib.id, b.deps);
    cancelBatch(b.key); // both stopped before the plan was made
    retryFailed(b.key);
    const slowA = slowMeta();
    const pA = queueGoLive(b.batchId); // its group: itself (the other is still stopped)
    slowA.restore();
    retryFailed(b.sib.key);
    const slowB = slowMeta();
    const pB = queueGoLive(b.sib.id); // its group: both (the first has no plan yet)
    slowB.restore();
    slowA.release();
    expect(await pA).toMatch(/NOT turned on: the launch was stopped/);
    slowB.release();
    // The first one's plan was made meanwhile: checked again with the ad set left, not dropped.
    expect(await pB).toMatch(/NOT turned on: the launch was stopped/);
    const first = goLivePlan(b.key)!;
    const second = goLivePlan(b.sib.key)!;
    expect(second.key).not.toBe(first.key);
    expect([first.status, second.status]).toEqual(["draft", "draft"]);
    expect([getBatch(b.batchId)!.go_live_done, getBatch(b.sib.id)!.go_live_done]).toEqual([1, 1]);
    expect(db().prepare("SELECT batch_id FROM plans WHERE key = ?").pluck().get(second.key)).toBe(b.sib.id);
    expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
  }, 120_000);

  it("a Stop is one transaction: when a write fails half-way, nothing of it stays", async () => {
    const b = await twoAdSets();
    await runBatch(b.batchId, b.deps);
    await runBatch(b.sib.id, b.deps);
    db().exec(`CREATE TRIGGER fail_stop BEFORE INSERT ON events WHEN NEW.batch_id = ${b.sib.id} AND NEW.message LIKE 'Stopped%' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    expect(() => cancelBatch(b.key)).toThrow(/disk full/);
    db().exec("DROP TRIGGER fail_stop");
    expect([getBatch(b.batchId)!.cancel_requested, getBatch(b.batchId)!.stopped_at]).toEqual([0, null]);
    expect(await queueGoLive(b.sib.id)).toMatch(/^Turning the ads on now/);
  }, 120_000);
});

describe("migration 6", () => {
  // Round 4: from the database the committed app leaves (migrations 1-3), as on the server.
  it("on a version-3 database: finds old turn-on plans by the launcher's mark (renamed too) or their title; others stay unlinked; old Stops count", () => {
    const old = new Database(":memory:");
    for (let v = 0; v < 3; v++) old.exec(migrations[v]);
    old.pragma("user_version = 3");
    setDb(old);
    const acc = upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
    const [a, r, d, x, s, gone] = Array.from({ length: 6 }, () => newBatch(acc, "test@example.com"));
    const key = (id: number) => (getBatch(id) as BatchRow).key;
    const goneKey = key(gone);
    const mark = (id: number | string) => `test@example.com (when launching batch ${typeof id === "string" ? id : key(id)})`;
    const add = old.prepare("INSERT INTO plans (key, ad_account_id, title, status, ops, confirmed_by) VALUES (?, ?, ?, ?, '{}', ?)");
    add.run("p_title", acc, `Turn on batch ${key(a)} (9 ads)`, "queued", mark(a)); // as the app made it
    add.run("p_renamed", acc, "Diwali ads on", "queued", mark(r)); // renamed on the plan page
    add.run("p_draft", acc, `Turn on batch ${key(d)} (3 ads)`, "draft", null); // never confirmed: only its title
    add.run("p_both", acc, `Turn on batch ${key(a)} (2 ads)`, "queued", mark(x)); // renamed to look like another batch's: the mark wins
    add.run("p_other", acc, "Turn on the November ads", "queued", "someone@example.com"); // a plan of the person's own
    add.run("p_nobatch", acc, "Turn on batch zzzzz (3 ads)", "queued", "test@example.com (when launching batch zzzzz)"); // no such batch
    add.run("p_gone", acc, "Old launch on", "queued", mark(goneKey));
    old.prepare("DELETE FROM batches WHERE id = ?").run(gone); // the batch was deleted later
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    old.prepare("UPDATE batches SET go_live = 'now', status = 'partial', cancel_requested = 1, launched_at = ?, finished_at = ? WHERE id = ?").run(tenMinAgo, tenMinAgo, s);
    migrate(old);
    expect(old.prepare("SELECT key, batch_id FROM plans ORDER BY key").all()).toEqual([
      { key: "p_both", batch_id: x },
      { key: "p_draft", batch_id: d },
      { key: "p_gone", batch_id: null },
      { key: "p_nobatch", batch_id: null },
      { key: "p_other", batch_id: null },
      { key: "p_renamed", batch_id: r },
      { key: "p_title", batch_id: a },
    ]);
    expect(getBatch(s)!.stopped_at).toBe(tenMinAgo);
    expect(getBatch(s)!.late_retry_from).toBeNull(); // no Retry column before: nothing to keep
    expect(old.pragma("user_version", { simple: true })).toBe(migrations.length);
  });

  it("on a database that ran the round-2 migration 5: late Retries already held stay held ('now' and 'at a time')", () => {
    const old = new Database(":memory:");
    for (let v = 0; v < 5; v++) old.exec(migrations[v]);
    old.pragma("user_version = 5");
    setDb(old);
    const acc = upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
    const [n, at, ok] = Array.from({ length: 3 }, () => newBatch(acc, "test@example.com"));
    const setTime = new Date(Date.now() - 3 * HOUR).toISOString();
    updateBatch(n, { go_live: "now", status: "queued", launched_at: new Date(Date.now() - 3 * HOUR).toISOString(), retried_at: new Date().toISOString() });
    updateBatch(at, { go_live: "at", go_live_at: setTime, status: "queued", launched_at: new Date(Date.now() - 4 * HOUR).toISOString(), retried_at: new Date().toISOString() });
    updateBatch(ok, { go_live: "at", go_live_at: new Date(Date.now() - 30 * 60_000).toISOString(), status: "queued", retried_at: new Date().toISOString() });
    migrate(old);
    expect(getBatch(n)!.late_retry_from).toBeTruthy();
    expect(getBatch(at)!.late_retry_from).toBe(setTime);
    expect(getBatch(ok)!.late_retry_from).toBeNull();
  });
});

describe("small points", () => {
  it("acceptWarnings as a number: a warning not seen is refused even when the count is the same", async () => {
    const b = await batch();
    updateBatch(b.batchId, { copy: JSON.stringify({ ...LEAD_COPY, headlines: [] }) }); // "No headline." on each ad
    const before = (await runPreview(b.key)).preview.warnings;
    // A headline is added (those warnings go) and the UTM template gets an unknown word (new ones, as many).
    updateBatch(b.batchId, { copy: JSON.stringify({ ...LEAD_COPY, utmTemplate: "utm_source=fb&utm_content={nonsense}" }) });
    expect((await batchView(b.key, { remember: false })).preview.warnings).toBe(before); // the same count
    await expect(launchBatch(b.key, { confirm: true, acceptWarnings: before })).rejects.toThrow(/new warnings? since you checked:\n- [^\n]*UTM template has unknown words/);
    expect(getBatch(b.batchId)!.status).toBe("draft");
  }, 60_000);

  it("the Retry answer speaks to whoever reads it (no 'the person')", async () => {
    const b = await batch();
    await updateSettings(b.key, { goLive: "now" });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    db().prepare("UPDATE ads SET status = 'failed', error = 'x' WHERE id = ?").run(getAds(b.batchId)[0].id);
    updateBatch(b.batchId, { status: "partial" });
    const msg = retryFailed(b.key).message;
    expect(msg).toMatch(/with the budgets confirmed at launch \(₹500 a day\)/);
    expect(msg).not.toMatch(/the person/);
  }, 60_000);
});
