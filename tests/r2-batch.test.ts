import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { runBatch } from "@/lib/engine/launcher";
import { dailyEquivalent, goLivePlan, launchSummary, queueGoLive, siblings } from "@/lib/manage/golive";
import { runPlan } from "@/lib/manage/plan";
import { goLive } from "@/worker/run";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { localFiles } from "@/lib/sources/local";
import {
  batchLaunchSummary, batchView, cancelBatch, launchBatch, listTemplates, retryFailed, saveCopyTemplate, savePreset, setAdCopyBy, updateAdOverride, updateSettings, type BatchView,
} from "@/lib/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import {
  eventTime, goLiveLine, holdText, needsDestReload, pickLastUsed, retryOffer, retryQuestion, stopTurnOnOffer, stoppedText,
} from "@/app/batches/[key]/batch-logic";
import { EMPTY_CELLS } from "@/app/batches/[key]/copy-sheet";
import Progress from "@/app/batches/[key]/Progress";
import { copyBody } from "@/app/settings/settings-logic";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Round 2 (BATCH): what turns ads on after a launch. The yes given at launch (the typed total)
// must not turn ads on after a Stop, long after the launch, or for more than was typed; Stop stops a
// turn-on that is waiting, also when every ad is already in. Practice Meta only.

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

async function batch() {
  const { accountId, batchId } = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
  updateBatch(batchId, { copy: JSON.stringify(LEAD_COPY) });
  const deps = { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "r2-batch-")) };
  return { accountId, batchId, key: getBatch(batchId)!.key, deps };
}

/** Launch as the page does: the total typed back exactly as the summary shows it. */
async function launchTyped(key: string) {
  const typed = (await batchLaunchSummary(key)).launch!.spendConfirmation!;
  await launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: typed });
  return typed;
}

const html = <P,>(c: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(c as ComponentType<object>, props as object));
const progress = (view: BatchView) => html(Progress, { view, tpl: listTemplates() as never, busy: "", error: "", loadError: "", act: () => {}, reload: async () => null, batchKey: view.key });
const planStatus = (key: string) => goLivePlan(key)?.status;

describe("the turn-on after the launch: only for what was typed", () => {
  it("a normal 'launch now' is turned on as confirmed (the plan's amount is the typed one)", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    const typed = await launchTyped(key);
    expect((getBatch(batchId) as unknown as { go_live_total: string }).go_live_total).toBe(typed);
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    expect(await queueGoLive(batchId)).toMatch(/^Turning the ads on now/);
    expect(planStatus(key)).toBe("queued");
  }, 120_000);

  it("a budget raised after the launch: the turn-on plan is a draft that names both amounts", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key); // ₹500
    await runBatch(batchId, deps);
    mock.objects.get("as1")!.daily_budget = "5000000"; // ₹50,000 a day, set in Ads Manager
    const msg = await queueGoLive(batchId);
    expect(msg).toMatch(/NOT turned on: what can spend once they are on is now ₹50,000 a day, not the ₹500 typed at launch/);
    expect(planStatus(key)).toBe("draft");
  }, 120_000);

  it("several ad sets: one turn-on plan for the launch; a budget raised in one of them holds it, and nothing goes on", async () => {
    // Round 3: replaces "each batch's plan is its part" (it never ran a plan). The real plan is made and run.
    const { accountId, batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now", extraAdsetIds: ["as4"] });
    expect(await launchTyped(key)).toBe("₹1,300"); // ₹500 + ₹800
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    await runBatch(batchId, deps);
    expect(await queueGoLive(batchId)).toMatch(/waits for the other ad sets of this launch: the launch into ad set "Min-spend template" is still running/);
    mock.objects.get("as4")!.daily_budget = "90000"; // ₹900 in Ads Manager: ₹500 + ₹900 > ₹1,300
    await runBatch(sib.id, deps);
    expect(await queueGoLive(sib.id)).toMatch(/NOT turned on: what can spend once they are on is now ₹1,400 a day, not the ₹1,300 typed at launch/);
    const plan = goLivePlan(key)!;
    expect(goLivePlan(sib.key)).toEqual(plan);
    expect(plan.status).toBe("draft");
    expect(db().prepare("SELECT batch_id FROM plans WHERE key = ?").pluck().get(plan.key)).toBe(batchId);
    // The plan lane never runs a draft: nothing is on.
    const id = db().prepare("SELECT id FROM plans WHERE key = ?").pluck().get(plan.key) as number;
    expect(await runPlan(id, { client: clientFor(accountId), clock })).toEqual({ done: 0, failed: 0 });
    expect([mock.objects.get("c1")!.status, mock.objects.get("as1")!.status, mock.objects.get("as4")!.status]).toEqual(["PAUSED", "PAUSED", "PAUSED"]);
  }, 120_000);

  it("several ad sets, nothing changed: one plan turns every ad, both ad sets and the campaign on", async () => {
    const { accountId, batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now", extraAdsetIds: ["as4"] });
    await launchTyped(key);
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    // The second ad set finishes first this time: the last one in makes the plan.
    await runBatch(sib.id, deps);
    expect(await queueGoLive(sib.id)).toMatch(/waits for the other ad sets/);
    await runBatch(batchId, deps);
    expect(await queueGoLive(batchId)).toMatch(/^Turning the ads on now/);
    expect(db().prepare("SELECT COUNT(*) FROM plans").pluck().get()).toBe(1);
    const id = db().prepare("SELECT id FROM plans WHERE key = ?").pluck().get(goLivePlan(key)!.key) as number;
    expect(await runPlan(id, { client: clientFor(accountId), clock })).toEqual({ done: 1, failed: 0 });
    expect(mock.of("ad").filter((a) => a.status === "ACTIVE")).toHaveLength(18);
    expect([mock.objects.get("c1")!.status, mock.objects.get("as1")!.status, mock.objects.get("as4")!.status]).toEqual(["ACTIVE", "ACTIVE", "ACTIVE"]);
    expect(planStatus(sib.key)).toBe("done");
  }, 120_000);

  it("a long first run is still the launch that was confirmed; a Retry an hour after the launch is not", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    updateBatch(batchId, { launched_at: new Date(Date.now() - 3 * 3600_000).toISOString() }); // the run took 3 hours
    expect(await queueGoLive(batchId)).toMatch(/^Turning the ads on now/);
  }, 120_000);

  it("a Stop pressed while the turn-on plan is being checked wins: the plan stays a draft", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    // The Stop arrives while queueGoLive reads Meta.
    mock.inject({ match: (m) => { if (m === "GET") db().prepare("UPDATE batches SET cancel_requested = 1, stopped_at = ? WHERE id = ?").run(new Date().toISOString(), batchId); return false; }, kind: "error" });
    expect(await queueGoLive(batchId)).toMatch(/NOT turned on: the launch was stopped/);
    expect(planStatus(key)).toBe("draft");
  }, 120_000);

  it("'at a time': a lifetime budget is spread over the days left from that time, not from now", async () => {
    const { batchId, key } = await batch();
    const end = new Date(Date.now() + 5 * 86_400_000 + 3600_000).toISOString(); // whole days are counted: 5 from now, 3 from the time
    Object.assign(mock.objects.get("as1")!, { daily_budget: undefined, lifetime_budget: "3000000", end_time: end }); // ₹30,000 lifetime
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await updateSettings(key, { goLive: "at", goLiveAt: at });
    const s = await launchSummary(getBatch(batchId)!, { mode: "at", at });
    expect(s.totalDailyBudget).toBe(dailyEquivalent(0, 30000, end, null, Date.parse(at))); // 3 days left from then
    expect(s.totalDailyBudget).toBe(10000);
    expect((await launchSummary(getBatch(batchId)!, { mode: "now" })).totalDailyBudget).toBe(6000); // 5 days from now
  }, 120_000);

  it("the summary's copy is the batch copy, not the first ad's own copy", async () => {
    const { batchId, key } = await batch();
    updateAdOverride(key, getAds(batchId)[0].id, { copy: { primaryTexts: ["Only for ad 1"], linkUrl: "https://example.com/ad1" } });
    const s = await launchSummary(getBatch(batchId)!, { mode: "paused" });
    expect(s.copy.firstText).toBe(LEAD_COPY.primaryTexts[0]);
    expect(s.copy.link).toBe(LEAD_COPY.linkUrl);
    expect(s.copy.primaryTexts).toBe(LEAD_COPY.primaryTexts.length);
  }, 120_000);
});

describe("Stop when every ad is in and only the turn-on is left", () => {
  async function scheduled() {
    const b = await batch();
    await updateSettings(b.key, { goLive: "at", goLiveAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    await launchTyped(b.key);
    await runBatch(b.batchId, b.deps);
    await queueGoLive(b.batchId);
    expect(planStatus(b.key)).toBe("queued");
    return b;
  }

  it("a turn-on plan waiting for its time is cancelled and named, with a plain message; the page says so", async () => {
    const { key } = await scheduled();
    const plan = goLivePlan(key)!;
    const v = await batchView(key);
    expect(stopTurnOnOffer(v)).toBe("Don't turn the ads on");
    expect(progress(v)).toMatch(/<button class="danger">Don&#x27;t turn the ads on<\/button>/);
    const r = cancelBatch(key);
    expect(r.cancelled).toEqual([{ key, adsetName: v.settings.adsetName, result: "turn_on_cancelled", planKey: plan.key, message: `All ads are created. The turn-on plan ${plan.key} is stopped, so the ads stay paused.` }]);
    expect(planStatus(key)).toBe("cancelled");
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan' AND status = 'queued'").pluck().get()).toBe(0);
    expect(stoppedText(r.cancelled, key)).toBe(`Stopped the turn-on of this batch (plan ${plan.key}): those ads are not turned on. Ads already created stay paused; nothing is deleted or turned on.`);
    // Retry can't turn them on again by itself.
    expect(() => retryFailed(key)).toThrow(/was cancelled, so the ads stay paused/);
  }, 120_000);

  it("a draft turn-on plan is cancelled too; one that is running is named as stopping; one that ran is named, not stopped", async () => {
    // Round 3: replaces a test that set the plan's status by hand. Each plan here is made and run for real.
    // A draft: Stop, Retry, then the worker's turn-on step saves the plan as a draft. Stop cancels it.
    const a = await batch();
    await updateSettings(a.key, { goLive: "now" });
    await launchTyped(a.key);
    await runBatch(a.batchId, a.deps);
    cancelBatch(a.key);
    retryFailed(a.key);
    await goLive(a.batchId);
    const draft = goLivePlan(a.key)!;
    expect(draft.status).toBe("draft");
    expect(cancelBatch(a.key).cancelled[0]).toMatchObject({ result: "turn_on_cancelled", planKey: draft.key });
    expect(planStatus(a.key)).toBe("cancelled");

    // Running: Stop is pressed while the plan lane turns the first ad on (what happens to the rest is the
    // plan engine's stop, tested in review2-batch).
    const { accountId, batchId, key } = await scheduled();
    const orig = mock.fetch;
    const stops: ReturnType<typeof cancelBatch>[] = [];
    mock.fetch = async (input, init) => {
      if (!stops.length && (init?.method ?? "GET").toUpperCase() === "POST" && /status=ACTIVE/.test(String(init?.body ?? ""))) stops.push(cancelBatch(key));
      return orig(input, init);
    };
    const id = db().prepare("SELECT id FROM plans WHERE key = ?").pluck().get(goLivePlan(key)!.key) as number;
    try {
      await runPlan(id, { client: clientFor(accountId), clock });
    } finally {
      mock.fetch = orig;
    }
    expect(stops[0].cancelled[0]).toMatchObject({ key, result: "turn_on_stopping", planKey: goLivePlan(key)!.key });
    expect(getBatch(batchId)!.stopped_at).toBeTruthy();

    // Ran: every ad on; Stop names the plan and doesn't turn them off.
    const c = await batch();
    await updateSettings(c.key, { goLive: "now" });
    await launchTyped(c.key);
    await runBatch(c.batchId, c.deps);
    await queueGoLive(c.batchId);
    const ran = goLivePlan(c.key)!;
    await runPlan(db().prepare("SELECT id FROM plans WHERE key = ?").pluck().get(ran.key) as number, { client: clientFor(c.accountId), clock });
    expect(planStatus(c.key)).toBe("done");
    expect(() => cancelBatch(c.key)).toThrow(new RegExp(`already turned on by plan ${ran.key}. Stop doesn't turn them off`));
  }, 180_000);

  it("no plan made yet (the worker is still trying to turn them on): none is made", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps); // done; the go-live has not run yet
    expect(cancelBatch(key).cancelled).toEqual([expect.objectContaining({ key, result: "turn_on_cancelled", message: "All ads are created. They are not turned on, so they stay paused." })]);
    expect(await queueGoLive(batchId)).toMatch(/skipped: the launch was stopped/);
    expect(goLivePlan(key)).toBeNull();
  }, 120_000);

  it("a paused launch that finished has nothing to stop", async () => {
    const { batchId, key, deps } = await batch();
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    await runBatch(batchId, deps);
    expect(() => cancelBatch(key)).toThrow(/not launching .* nothing is waiting to turn its ads on/);
  }, 120_000);
});

describe("after a Stop, the page and Retry say plainly that nothing turns on by itself", () => {
  it("the batch view, the page's box, the Retry label and the server's answer", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    cancelBatch(key); // before it started
    const v = await batchView(key);
    expect(v.stoppedAt).toBeTruthy();
    expect(v.goLiveHold).toMatch(/^the launch was stopped \(\d+ \w+ 2026, .* IST\)$/);
    expect(holdText(v)).toMatch(/^The ads won't be turned on by themselves: the launch was stopped/);
    expect(goLiveLine(v)).toBe(holdText(v));
    expect(retryQuestion(v, false)).toBeNull(); // nothing spends without a new confirmation: no "it will spend" question
    expect(progress(v)).toContain("The ads won&#x27;t be turned on by themselves: the launch was stopped");
    const r = retryFailed(key);
    expect(r.message).toMatch(/The ads are NOT turned on by themselves: the launch was stopped .*a turn-on plan is saved as a draft/);
    await runBatch(batchId, deps);
    await queueGoLive(batchId);
    expect(planStatus(key)).toBe("draft");
  }, 120_000);

  it("every ad in after a Stop: the button makes the plan to confirm, it doesn't say 'turn on again'", () => {
    const view = { status: "done", progress: { total: 3, done: 3, failed: 0, working: 0 }, finishedAt: new Date(Date.now() - 600_000).toISOString(), settings: { goLive: "now" as const }, goLivePlan: null };
    expect(retryOffer({ ...view, goLiveHold: "the launch was stopped (19 Nov 2026, 03:05 pm IST)" })?.label).toBe("Make the turn-on plan to confirm");
    expect(retryOffer(view)?.label).toBe("Turn the ads on again");
  });

  it("a Retry that will turn ads on with the launch's yes asks first, and says when", () => {
    const v = { settings: { goLive: "now" }, goLivePlan: null, goLiveHold: null } as never;
    expect(retryQuestion(v, false)).toMatch(/^Retry the failed ads\? Once every ad is in, the ads are turned on straight away/);
    expect(retryQuestion({ settings: { goLive: "paused" }, goLivePlan: null } as never, false)).toBeNull();
    expect(retryQuestion({ settings: { goLive: "now" }, goLivePlan: { key: "p1", status: "queued", runAt: null } } as never, true)).toBeNull();
  });

  it("the worker's note about a failed turn-on replaces 'turned on once every ad is in'", async () => {
    // Round 3: replaces a test that built the view by hand. The worker's turn-on step really fails here.
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    await launchTyped(key);
    await runBatch(batchId, deps);
    mock.inject({ match: () => true, kind: "error", error: { message: "Invalid OAuth access token", code: 190 }, status: 400 });
    await goLive(batchId);
    const v = await batchView(key);
    expect(v.goLiveNote).toMatch(/^Turning the ads on failed 1 time/);
    expect(goLiveLine(v)).toBe(v.goLiveNote);
    expect(progress(v)).toContain("Turning the ads on failed 1 time");
    expect(progress(v)).not.toContain("turned on once every ad is in");
  }, 120_000);

  it("the batch view has goLiveNote (null while nothing failed)", async () => {
    const { key } = await batch();
    expect((await batchView(key)).goLiveNote).toBeNull();
  }, 60_000);
});

describe("Stop's answer on the page", () => {
  it("names a turn-on that was already done, and doesn't claim nothing was turned on", () => {
    const text = stoppedText([
      { key: "B2", adsetName: "Retargeting", result: "cancelled" },
      { key: "B1", adsetName: "Main", result: "already_on", planKey: "p9" },
    ], "B1");
    expect(text).toBe('Stopped: the launch into ad set "Retargeting". Nothing is deleted. Other ads already created stay paused. Already turned on before the Stop: the ads of this batch (plan p9). Stop doesn\'t turn them off: pause them under Campaigns, or open the plan and press Undo.');
    expect(text).not.toMatch(/nothing is deleted or turned on/);
  });
});

describe("the page: small fixes", () => {
  it("a new batch starts from the last ad set, copy, preset and angle only (never the go-live or extra ad sets)", () => {
    expect(pickLastUsed({ adsetId: "as1", adsetMode: "existing", copyTemplateId: 2, presetId: 3, angle: "price", goLive: "now", goLiveAt: "2026-11-20T09:00", extraAdsetIds: ["as4"], campaignId: "c1" }))
      .toEqual({ adsetId: "as1", adsetMode: "existing", copyTemplateId: 2, presetId: 3, angle: "price" });
    expect(pickLastUsed({ goLive: "now" })).toEqual({});
  });

  it("a draft answer without its destination checks is loaded again with them", () => {
    expect(needsDestReload({ status: "draft", destChecked: false })).toBe(true);
    expect(needsDestReload({ status: "draft" })).toBe(true);
    expect(needsDestReload({ status: "draft", destChecked: true })).toBe(false);
    expect(needsDestReload({ status: "done", destChecked: false })).toBe(false);
  });

  it("activity log times are India time with the date (SQLite's UTC time)", async () => {
    expect(eventTime("2026-11-19 09:35:00")).toMatch(/^19 Nov 2026, 03:05\s?pm IST$/i);
    const { batchId, key } = await batch();
    updateBatch(batchId, { status: "done" });
    db().prepare("INSERT INTO events (batch_id, level, message, created_at) VALUES (?, 'info', 'Launch started.', '2026-11-19 09:35:00')").run(batchId);
    expect(progress(await batchView(key))).toMatch(/<small>19 Nov 2026, 03:05\s?pm IST<\/small> Launch started\./i);
  }, 60_000);

  it("the copy sheet's hint says what the server does: an empty cell keeps the ad's own earlier copy", async () => {
    const { batchId, key } = await batch();
    setAdCopyBy(key, [{ ad: 1, copy: { primaryTexts: ["Ad 1's own text"] } }]);
    setAdCopyBy(key, [{ ad: 1, copy: { headlines: ["New headline"] } }]); // a sheet row with the text cell empty
    const o = JSON.parse(getAds(batchId)[0].copy_override!);
    expect(o).toEqual({ primaryTexts: ["Ad 1's own text"], headlines: ["New headline"] });
    expect(EMPTY_CELLS).toMatch(/keep what the ad has now: its own copy saved earlier, or else the batch's copy/);
  }, 60_000);

  it("the same copy saved again in another order keeps a failed ad's creative", async () => {
    const { batchId, key } = await batch();
    const ad = getAds(batchId)[0];
    db().prepare("UPDATE ads SET status = 'failed', copy_override = ?, meta_creative_id = 'cr9' WHERE id = ?").run(JSON.stringify({ headlines: ["H"], primaryTexts: ["T"] }), ad.id);
    updateBatch(batchId, { status: "failed" });
    updateAdOverride(key, ad.id, { copy: { primaryTexts: ["T"], headlines: ["H"] } });
    expect(getAds(batchId)[0].meta_creative_id).toBe("cr9");
    updateAdOverride(key, ad.id, { copy: { primaryTexts: ["T2"], headlines: ["H"] } });
    expect(getAds(batchId)[0].meta_creative_id).toBeNull();
  }, 60_000);

  it("Settings 'Add' refuses a name in use (copy template and preset); Claude's save by name still edits", async () => {
    await batch();
    const id = saveCopyTemplate({ name: "Site Visit", primaryTexts: ["A"], linkUrl: "https://example.com/a" });
    expect(() => saveCopyTemplate(copyBody({ name: "SITE VISIT", texts: ["B"], heads: [], desc: "", cta: "LEARN_MORE", link: "", utm: "", displayLink: "", leadFormId: "" }))).toThrow(/A copy template is already called "SITE VISIT"/);
    expect(saveCopyTemplate({ name: "site visit", primaryTexts: ["C"] })).toBe(id); // Claude: edit by name
    const p = Number(savePreset({ name: "Main page", pageId: "p1", pageName: "Sahajta AI" }));
    expect(() => savePreset({ name: "main page", pageId: "p2", create: true })).toThrow(/A settings preset is already called/);
    expect(Number(savePreset({ name: "main page", igUserId: "" }))).toBe(p);
  }, 60_000);
});
