import fs from "node:fs";
import path from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAppSettings } from "@/lib/appsettings";
import { db } from "@/lib/db";
import { markReviewChecked } from "@/lib/jobs";
import { queueGoLive, siblings } from "@/lib/manage/golive";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { batchLaunchSummary, batchView, cancelBatch, launchBatch, listTemplates, retryFailed, runPreview, savePreset, updateSettings, type BatchView } from "@/lib/service";
import { getAds, getBatch, logEvent, updateBatch } from "@/lib/store";
import {
  canChangeAfterLaunch, checkSections, goLivePlanText, groupLaunching, isWarningsRefusal, launchAndReread, launchBody, pollDelay, retryLaunch, retryOffer,
  reviewCheckResult, reviewCheckTimedOut, reviewCheckedText, stopLaunch, stoppedText, warningsAccepted,
} from "@/app/batches/[key]/batch-logic";
import LaunchStep from "@/app/batches/[key]/LaunchStep";
import PreviewTable from "@/app/batches/[key]/PreviewTable";
import Progress from "@/app/batches/[key]/Progress";
import { planChecks, reopenedReason, spendWords, timeLabel } from "@/app/plans/[key]/plan-logic";
import { COPY, LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Batch pages, second round (Group WEB, 19 Nov): the pages use what the BATCH group added on the
// server. Pure page logic is tested directly and, where it reads a server answer, against the real
// service with the practice Meta account (no network, no real Meta). What a page shows is checked
// by rendering its component to HTML with the real server's answer (round 2: no test reads a page's
// source text any more).

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let folder: string;
let mock: MockMeta;

/** The check codes preview.ts can make are read from its text (the one place they are listed). */
const src = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");
/** A component's first render as HTML (effects don't run). */
const html = <P,>(c: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(c as ComponentType<object>, props as object));
/** The batch page after the launch, as the browser gets it (the real answer of GET /api/batches/[key]). */
const progress = (view: BatchView, o: { error?: string } = {}) =>
  html(Progress, { view, tpl: listTemplates() as never, busy: "", error: o.error ?? "", loadError: "", act: () => {}, reload: async () => null, batchKey: view.key });

beforeAll(async () => {
  folder = await fifteenFileFolder();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://example.com/dead")) return Promise.resolve(new Response("gone", { status: 404 }));
    return u.startsWith("https://example.com") ? Promise.resolve(new Response("ok")) : real(url, init);
  });
}, 120_000);

beforeEach(() => {
  freshDb();
  mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
});

async function batch(copy: object = LEAD_COPY) {
  const { accountId, batchId } = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
  updateBatch(batchId, { copy: JSON.stringify(copy) });
  return { accountId, batchId, key: getBatch(batchId)!.key };
}

/** Every ad created in Meta (as the worker leaves it). */
function allIn(batchId: number) {
  for (const [i, a] of getAds(batchId).entries()) {
    db().prepare("UPDATE ads SET status = 'done', meta_ad_id = ?, meta_adset_id = 'as1' WHERE id = ?").run(`9${i}`, a.id);
    mock.objects.set(`9${i}`, { id: `9${i}`, name: `Ad ${i}`, adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", _type: "ad" } as never);
  }
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

describe("1 Launch sends how many warnings the person saw", () => {
  it("the tick counts only for the warnings shown when it was ticked", () => {
    expect(warningsAccepted(null, 0)).toBe(true);
    expect(warningsAccepted(null, 2)).toBe(false);
    expect(warningsAccepted(2, 2)).toBe(true);
    expect(warningsAccepted(2, 3)).toBe(false);
  });

  it("the body carries the number (not true), and the typed budget only when ads are turned on", () => {
    expect(launchBody({ warnings: 2, acceptedAt: 2, goLive: "paused", spendTyped: "₹500" })).toEqual({ confirm: true, acceptWarnings: 2, spendConfirmation: undefined });
    expect(launchBody({ warnings: 3, acceptedAt: 2, goLive: "now", spendTyped: "₹500" })).toEqual({ confirm: true, acceptWarnings: 0, spendConfirmation: "₹500" });
    expect(launchBody({ warnings: 0, acceptedAt: null, goLive: "paused", spendTyped: "" }).acceptWarnings).toBe(0);
  });

  it("knows the server's 'new warnings' refusals, and nothing else", () => {
    expect(isWarningsRefusal("1 new warning since you checked:\n- Ad 1: …")).toBe(true);
    expect(isWarningsRefusal("3 new warnings since you checked:\n- …\nRead them, then launch again accepting 5 warnings.")).toBe(true);
    expect(isWarningsRefusal("There are 2 warnings. Read them in the preview and accept them to launch.")).toBe(true);
    expect(isWarningsRefusal("Fix these first:\n- No landing page URL.")).toBe(false);
    expect(isWarningsRefusal("")).toBe(false);
  });

  it("with the real server: a landing page that fails at launch is refused, shown on reload, and a new tick launches", async () => {
    const { batchId, key } = await batch();
    let v = await runPreview(key); // what the page shows after "Check landing pages"
    const seen = v.preview.warnings;
    updateBatch(batchId, { copy: JSON.stringify({ ...LEAD_COPY, linkUrl: "https://example.com/dead" }) });
    const err = await launchBatch(key, launchBody({ warnings: seen, acceptedAt: seen, goLive: "paused", spendTyped: "" })).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isWarningsRefusal((err as Error).message)).toBe(true);
    // The page reloads (?dest=1): the new warning is on screen and the old tick no longer counts.
    v = await batchView(key, { withDestination: true });
    expect(v.preview.warnings).toBeGreaterThan(seen);
    expect(v.preview.ads.flatMap((a) => a.checks).some((c) => c.code === "link_down")).toBe(true);
    expect(warningsAccepted(seen, v.preview.warnings)).toBe(false);
    // Ticked again with the warnings the page shows: the page's count is the server's count, so it goes.
    const done = await launchBatch(key, launchBody({ warnings: v.preview.warnings, acceptedAt: v.preview.warnings, goLive: "paused", spendTyped: "" }));
    expect(done.status).toBe("queued");
  }, 60_000);

  it("with the real server: such a refusal unticks the box and keeps it off until the reload with the new warnings is shown", async () => {
    const { batchId, key } = await batch();
    const seen = (await runPreview(key)).preview.warnings;
    updateBatch(batchId, { copy: JSON.stringify({ ...LEAD_COPY, linkUrl: "https://example.com/dead" }) });
    const steps: string[] = [];
    await launchAndReread(() => launchBatch(key, launchBody({ warnings: seen, acceptedAt: seen, goLive: "paused", spendTyped: "" })), {
      shown: () => steps.push("shown"),
      failed: (m) => steps.push(isWarningsRefusal(m) ? "failed: new warnings" : `failed: ${m}`),
      untick: () => steps.push("untick"),
      rereading: (on) => steps.push(`rereading ${on}`),
      reload: async () => { steps.push(`reload (${(await batchView(key, { withDestination: true })).preview.warnings > seen ? "more" : "same"} warnings)`); },
    });
    expect(steps).toEqual(["failed: new warnings", "untick", "rereading true", "reload (more warnings)", "rereading false"]);
  }, 60_000);

  it("another refusal (an error to fix) keeps the tick and just reloads; a launch that goes shows the batch", async () => {
    const steps: string[] = [];
    const ui = { shown: () => steps.push("shown"), failed: () => steps.push("failed"), untick: () => steps.push("untick"), rereading: (on: boolean) => steps.push(`rereading ${on}`), reload: async () => { steps.push("reload"); } };
    await launchAndReread(async () => { throw new Error("Fix these first:\n- No landing page URL."); }, ui);
    expect(steps).toEqual(["failed", "reload"]);
    steps.length = 0;
    await launchAndReread(async () => ({}), ui);
    expect(steps).toEqual(["shown"]);
  });
});

describe("2 Failed or partly done batch: preset and copy template for the ads not created yet", () => {
  const v = (status: string, done: number, total = 3) => ({ status, progress: { total, done, failed: total - done, working: 0 } });
  it("only for a failed or partial batch with ads still to create", () => {
    expect(canChangeAfterLaunch(v("failed", 0))).toBe(true);
    expect(canChangeAfterLaunch(v("partial", 2))).toBe(true);
    expect(canChangeAfterLaunch(v("partial", 3))).toBe(false);
    expect(canChangeAfterLaunch(v("done", 3))).toBe(false);
    expect(canChangeAfterLaunch(v("running", 1))).toBe(false);
  });

  it("with the real server: the page's PATCH body changes the preset of a failed batch", async () => {
    const { batchId, key } = await batch();
    updateBatch(batchId, { status: "failed" });
    db().prepare("UPDATE ads SET status = 'failed', error = 'Meta refused the Instagram account (1815199).' WHERE batch_id = ?").run(batchId);
    const id = Number(savePreset({ name: "No Instagram", pageId: "p1", pageName: "Sahajta AI", igUserId: "", igName: "" }));
    await updateSettings(key, { presetId: id }); // what PATCH /api/batches/[key] runs
    const after = await batchView(key);
    expect(after.settings.presetId).toBe(id);
    expect(after.settings.preset?.igUserId ?? "").toBe("");
    expect(canChangeAfterLaunch(after)).toBe(true);
  }, 60_000);

  it("with the real server: the page shows only those two pickers and says what they change", async () => {
    const { batchId, key } = await batch();
    allIn(batchId);
    const ads = getAds(batchId);
    db().prepare("UPDATE ads SET status = 'failed', meta_ad_id = NULL, error = 'Meta refused the Instagram account.' WHERE id IN (?, ?)").run(ads[0].id, ads[1].id);
    updateBatch(batchId, { status: "partial" });
    const out = progress(await batchView(key));
    const part = out.slice(out.indexOf("Settings for the ads not created yet"));
    expect(part.match(/<select /g)?.length).toBe(2);
    expect(part).toMatch(/aria-label="Settings preset"/);
    expect(part).toMatch(/aria-label="Copy template"/);
    expect(part).toMatch(/used only for the 2 ads not created yet/);
    expect(part).toMatch(/Ads already in Meta keep the settings they were made with/);
    // A batch with every ad in has nothing to change.
    db().prepare("UPDATE ads SET status = 'done' WHERE batch_id = ?").run(batchId);
    updateBatch(batchId, { status: "done" });
    expect(progress(await batchView(key))).not.toMatch(/Settings for the ads not created yet/);
  }, 60_000);
});

describe("3 Launch summary: lifetime budgets next to the total", () => {
  it("with the real server: the summary lists the lifetime budget lines under the total", async () => {
    const { key } = await batch();
    const end = new Date(Date.now() + 5 * 86_400_000).toISOString();
    Object.assign(mock.objects.get("as1")!, { daily_budget: undefined, lifetime_budget: "3000000", end_time: end });
    await updateSettings(key, { goLive: "now" });
    const summary = await batchLaunchSummary(key);
    expect(summary.launch!.lifetimeBudgets.length).toBe(1);
    const out = html(LaunchStep, { view: await batchView(key), dest: [], patch: () => {}, summary, summaryError: "", summaryLoading: false, retrySummary: () => {} });
    const total = out.indexOf("Total daily budget: <strong>");
    const line = out.indexOf(summary.launch!.lifetimeBudgets[0].replace(/"/g, "&quot;"));
    expect(total).toBeGreaterThan(0);
    expect(line).toBeGreaterThan(total);
  }, 60_000);
});

describe("4 Retry shows what the server did", () => {
  const view = (o: Record<string, unknown> = {}) => ({
    status: "done", progress: { total: 3, done: 3, failed: 0, working: 0 }, finishedAt: ago(10), settings: { goLive: "now" as const }, goLivePlan: null, ...o,
  }) as Parameters<typeof retryOffer>[0];
  it("offers Retry for ads not created, and 'turn on again' when every ad is in but no turn-on plan was made", () => {
    expect(retryOffer(view({ status: "partial", progress: { total: 3, done: 1, failed: 2, working: 0 } }))).toEqual({ label: "Retry the 2 failed ads only", goLiveOnly: false });
    expect(retryOffer(view())).toEqual({ label: "Turn the ads on again", goLiveOnly: true });
    expect(retryOffer(view({ status: "running" }))).toBeNull();
    expect(retryOffer(view({ settings: { goLive: "paused" } }))).toBeNull();
    expect(retryOffer(view({ goLivePlan: { key: "P1", status: "queued", runAt: null } }))).toBeNull();
    // Right after the launch the worker is still making the plan: no button yet.
    expect(retryOffer(view({ finishedAt: ago(1) }))).toBeNull();
  });

  it("with the real server: every ad in, go-live pending → the offer and the server's message", async () => {
    const { batchId, key } = await batch();
    allIn(batchId);
    updateBatch(batchId, { go_live: "now", status: "done", finished_at: ago(10), go_live_total: "₹1,500", go_live_total_at: ago(30) });
    const offer = retryOffer(await batchView(key));
    expect(offer?.goLiveOnly).toBe(true);
    const r = retryFailed(key);
    expect(r.message).toMatch(/Every ad is already in Meta; turning them on again/);
  }, 60_000);

  it("with the real server: a launch from before the total was typed says its Retry saves a draft to confirm", async () => {
    const { batchId, key } = await batch();
    allIn(batchId);
    updateBatch(batchId, { go_live: "now", status: "done", finished_at: ago(10) });
    const r = retryFailed(key);
    expect(r.message).toMatch(/^Every ad is already in Meta\. The ads are NOT turned on by themselves: this launch is from before the total daily budget was typed at launch\./);
    expect(r.message).not.toContain("turning them on again");
  }, 60_000);

  it("with the real server: the page's Retry shows the server's own words about what it did", async () => {
    const { batchId, key } = await batch();
    allIn(batchId);
    updateBatch(batchId, { go_live: "now", status: "done", finished_at: ago(10), go_live_total: "₹1,500", go_live_total_at: ago(30) });
    // What POST /api/batches/[key]/retry answers.
    const r = await retryLaunch(async () => { const retry = retryFailed(key); return { ...(await batchView(key)), retry }; });
    expect(r.notice).toMatch(/^Every ad is already in Meta; turning them on again/);
    expect(r.view.key).toBe(key);
  }, 60_000);
});

describe("5 Stop names every launch it stopped", () => {
  it("in plain words, this batch first by its place in the answer", () => {
    expect(stoppedText([{ key: "B1", adsetName: "Main", result: "cancelled" }, { key: "B2", adsetName: "Retargeting", result: "cancelled" }], "B1"))
      .toBe('Stopped: this batch and the launch into ad set "Retargeting". Ads already created stay paused; nothing is deleted or turned on.');
    expect(stoppedText([{ key: "B1", adsetName: null, result: "stopping" }], "B1")).toMatch(/^Stopped: this batch \(after the current step\)\./);
    expect(stoppedText([], "B1")).toBe("");
    expect(stoppedText(undefined, "B1")).toBe("");
  });

  it("the Stop button and quiet reloads stay while a batch launched together is still running", () => {
    const main = { status: "done", ads: [], together: [{ status: "queued" }] };
    expect(groupLaunching(main)).toBe(true);
    expect(pollDelay(main, false)).toBe(3000);
    expect(groupLaunching({ status: "done", together: [{ status: "failed" }] })).toBe(false);
  });

  it("with the real server: the main batch is done, its extra ad set still queued; Stop from the main page names it", async () => {
    const { batchId, key } = await batch();
    await updateSettings(key, { extraAdsetIds: ["as4"] });
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    updateBatch(batchId, { status: "done" });
    db().prepare("UPDATE jobs SET status = 'done' WHERE batch_id = ?").run(batchId);
    const v = await batchView(key);
    expect(groupLaunching(v)).toBe(true);
    const r = cancelBatch(key);
    expect(stoppedText(r.cancelled, key)).toBe(`Stopped: the launch into ad set "${sib.adset_name}". Ads already created stay paused; nothing is deleted or turned on.`);
  }, 60_000);

  it("with the real server: the main page shows Stop while the group runs, and Stop's answer in words", async () => {
    const { batchId, key } = await batch();
    await updateSettings(key, { extraAdsetIds: ["as4"] });
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    updateBatch(batchId, { status: "done" });
    db().prepare("UPDATE jobs SET status = 'done' WHERE batch_id = ?").run(batchId);
    expect(progress(await batchView(key))).toMatch(/<button class="danger"[^>]*>Stop the launch<\/button>/);
    // What POST /api/batches/[key]/cancel answers.
    const r = await stopLaunch(async () => { const { cancelled } = cancelBatch(key); return { ...(await batchView(key)), cancelled }; }, key);
    expect(r.stopped).toBe(`Stopped: the launch into ad set "${sib.adset_name}". Ads already created stay paused; nothing is deleted or turned on.`);
    expect(progress(r.view)).not.toMatch(/Stop the launch/);
  }, 60_000);
});

describe("6 The turn-on plan", () => {
  it("status in plain words, the run time in India time, a link to the plan; a draft asks to check and confirm", () => {
    expect(goLivePlanText(null)).toBeNull();
    expect(goLivePlanText({ key: "P7", status: "draft", runAt: null })).toEqual({ key: "P7", href: "/plans/P7", text: "Saved as a draft: open it to check and confirm.", draft: true });
    const q = goLivePlanText({ key: "P8", status: "queued", runAt: "2026-11-20T03:30:00.000Z" })!;
    expect(q.draft).toBe(false);
    expect(q.text).toMatch(/^Confirmed, waiting to run\. Runs at 20 Nov 2026, 9:00\s?am IST\.$/i);
    expect(goLivePlanText({ key: "P9", status: "done", runAt: "2026-11-20T03:30:00.000Z" })!.text).toBe("Done: the ads were turned on.");
  });

  it("with the real server: a go-live plan kept as a draft shows as a draft", async () => {
    const { batchId, key } = await batch();
    allIn(batchId);
    updateBatch(batchId, { go_live: "now", status: "done" });
    saveAppSettings({ dailyBudgetCeiling: 100 }, "t@example.com");
    expect(await queueGoLive(batchId)).toMatch(/NOT turned on/);
    const plan = goLivePlanText((await batchView(key)).goLivePlan);
    expect(plan?.draft).toBe(true);
    expect(plan?.href).toMatch(/^\/plans\/.+/);
  }, 60_000);

  it("with the real server: the page shows the draft plan with its link", async () => {
    const { batchId, key } = await batch();
    allIn(batchId);
    updateBatch(batchId, { go_live: "now", status: "done" });
    saveAppSettings({ dailyBudgetCeiling: 100 }, "t@example.com");
    await queueGoLive(batchId);
    const v = await batchView(key);
    const out = progress(v);
    expect(out).toContain(`<div class="msg warning">Turn-on plan <a href="/plans/${v.goLivePlan!.key}">${v.goLivePlan!.key}</a>: Saved as a draft: open it to check and confirm.</div>`);
  }, 60_000);
});

describe("7 'Check Meta review status now' uses reviewCheckedAt", () => {
  const ads = [{ id: 1, effectiveStatus: "PENDING_REVIEW", metaAdId: "9", reviewIssues: [] as string[] }];
  it("stops when the check ran; says 'news' when the review changed", () => {
    const before = { ads, reviewCheckedAt: null };
    expect(reviewCheckResult(before, { ads, reviewCheckedAt: null })).toBeNull();
    expect(reviewCheckResult(before, { ads, reviewCheckedAt: "2026-11-19T10:00:00.000Z" })).toBe("same");
    expect(reviewCheckResult(before, { ads: [{ ...ads[0], effectiveStatus: "ACTIVE" }], reviewCheckedAt: "2026-11-19T10:00:00.000Z" })).toBe("news");
    expect(reviewCheckTimedOut(before, { ads, reviewCheckedAt: null })).toBe("late");
  });

  it("without reviewCheckedAt (older server) the old behaviour stays", () => {
    expect(reviewCheckResult({ ads }, { ads })).toBeNull();
    expect(reviewCheckResult({ ads }, { ads: [{ ...ads[0], effectiveStatus: "ACTIVE" }] })).toBe("news");
    expect(reviewCheckTimedOut({ ads }, { ads })).toBe("same");
  });

  it("'last checked' in India time", () => {
    expect(reviewCheckedText("2026-11-19T09:30:00.000Z")).toMatch(/^Last checked 19 Nov 2026, 3:00\s?pm IST$/i);
    expect(reviewCheckedText(null)).toBe("");
  });

  it("with the real server: the worker's note ends the wait", async () => {
    const { batchId, key } = await batch();
    allIn(batchId);
    updateBatch(batchId, { status: "done" });
    const before = await batchView(key);
    expect(before.reviewCheckedAt).toBeNull();
    markReviewChecked(batchId);
    expect(reviewCheckResult(before, await batchView(key))).toBe("same");
  }, 60_000);

  it("with the real server: the page shows the button and when the review was last read, in India time", async () => {
    const { batchId, key } = await batch();
    allIn(batchId);
    updateBatch(batchId, { status: "done" });
    expect(progress(await batchView(key))).not.toMatch(/Last checked/);
    markReviewChecked(batchId);
    const v = await batchView(key);
    const out = progress(v);
    expect(out).toMatch(/>Check Meta review status now<\/button>/);
    expect(out).toContain(`<small class="muted">${reviewCheckedText(v.reviewCheckedAt)}</small>`);
  }, 60_000);
});

describe("8 New check codes show like the others", () => {
  const check = (code: string) => ({ level: "warning" as const, code, message: code });
  it("lead form, WhatsApp and 'couldn't check' show in the preview step", () => {
    const s = checkSections(["dest_unchecked", "lead_form_needed", "lead_form_unused", "whatsapp_button", "adset_missing", "no_page", "skipped_files", "no_ads", "no_campaign"].map(check));
    expect(s.preview.map((c) => c.code)).toEqual(["dest_unchecked", "lead_form_needed", "lead_form_unused", "whatsapp_button"]);
    expect(s.destination.map((c) => c.code)).toEqual(["adset_missing"]);
    expect(s.settings.map((c) => c.code)).toEqual(["no_page"]);
    expect(s.creatives.map((c) => c.code)).toEqual(["skipped_files"]);
  });

  it("every check code the server makes shows in one place (only the launch bar's 'pick a campaign / ad set / files' are left out)", () => {
    const codes = [...new Set([...src("src/lib/engine/preview.ts").matchAll(/code: "(\w+)"/g)].map((m) => m[1]))];
    expect(codes).toEqual(expect.arrayContaining(["file_missing", "carousel_texts", "cta_unsupported", "lead_form_needed", "whatsapp_button"]));
    const s = checkSections(codes.map(check));
    const shown = [...s.creatives, ...s.destination, ...s.settings, ...s.preview].map((c) => c.code);
    expect(shown.length).toBe(new Set(shown).size);
    expect(codes.filter((c) => !shown.includes(c)).sort()).toEqual(["no_ads", "no_adset", "no_campaign"]);
  });

  it("with the real server: an Instant form ad set without a lead form shows in the preview step", async () => {
    const { key } = await batch(COPY);
    const v = await batchView(key, { withDestination: true });
    expect(checkSections(v.preview.batchChecks).preview.map((c) => c.code)).toContain("lead_form_needed");
  }, 60_000);

  it("with the real server: the preview table shows each ad's errors and warnings", async () => {
    const { batchId, key } = await batch();
    const ad = getAds(batchId)[0];
    db().prepare("UPDATE ads SET copy_override = ? WHERE id = ?").run(JSON.stringify({ cta: "WHATSAPP_MESSAGE" }), ad.id);
    const v = await runPreview(key, { linkResults: new Map([["https://example.com/visit", "The page answered 404 (not found)."]]) });
    const row = v.preview.ads[0];
    const shown = [...row.checks.filter((c) => c.level === "error"), ...row.checks.filter((c) => c.level === "warning")];
    expect(shown.some((c) => c.level === "warning")).toBe(true);
    const out = html(PreviewTable, { view: v, tpl: null, batchKey: key, onChange: () => {} });
    for (const c of shown) expect(out).toContain(`<li class="${c.level}">${c.message.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;")}</li>`);
  }, 60_000);
});

// ---------- Plan page (after the PLANS group's server changes) ----------
// Round 2: only the plan page's pure helpers (src/app/plans/[key]/plan-logic.ts) are tested here.
// The checks that read PlanClient.tsx, manage/service.ts and plan.ts as text were removed: the plan
// page and its server belong to the PLANS group (see the BATCH round-2 report).

const rupee = (n: number) => `₹${n.toLocaleString("en-IN")}`;

describe("Plan page: India-time labels, plan notes by the button, the amount to type, sent back to draft", () => {
  it("(2) times use the server's India-time words, else are formatted here", () => {
    expect(timeLabel("20 Nov 2026, 09:00 am IST", "2026-11-20T03:30:00.000Z")).toBe("20 Nov 2026, 09:00 am IST");
    expect(timeLabel(null, "2026-11-20T03:30:00.000Z")).toMatch(/^20 Nov 2026, 9:00\s?am IST$/i);
    expect(timeLabel(undefined, null)).toBe("");
  });

  it("(3) a draft's plan notes (retry/undo) go by the confirm button; the tick covers every warning and note", () => {
    const checks = [
      { level: "error" as const, code: "x", message: "E" },
      { level: "warning" as const, code: "budget_high", message: "W" },
      { level: "warning" as const, code: "plan_note", message: "Audience 123 stays." },
    ];
    const draft = planChecks(checks, true);
    expect(draft.notes.map((c) => c.message)).toEqual(["Audience 123 stays."]);
    expect(draft.warnings.map((c) => c.code)).toEqual(["budget_high"]);
    expect(draft.errors).toHaveLength(1);
    expect(draft.toAccept).toBe(2);
    const ran = planChecks(checks, false);
    expect(ran.notes).toEqual([]);
    expect(ran.warnings.map((c) => c.code)).toEqual(["budget_high", "plan_note"]);
    expect(planChecks(null, true).toAccept).toBe(0);
  });

  it("(4) the amount to type is named for what it is, and told apart from the total daily budget", () => {
    const same = spendWords({ dailyBudget: 1500, spendNowDaily: 1500 }, "₹1,500", rupee)!;
    expect(same.ask).toBe("Type ₹1,500: what can spend in a day once this plan has run.");
    expect(same.differs).toBe("");
    const diff = spendWords({ dailyBudget: 2000, spendNowDaily: 15000 }, "₹15,000", rupee)!;
    expect(diff.differs).toMatch(/^This is not the total daily budget above \(₹2,000\)/);
    expect(spendWords({ dailyBudget: 0, spendNowDaily: 0 }, null, rupee)).toBeNull();
  });

  it("(5) a plan sent back to draft at its run time says why", () => {
    const step = (message: string) => [{ n: 1, title: "Turn on", status: "pending", message, ids: [] as string[] }];
    const why = "Not run at 20 Nov 2026, 09:00 am IST: what can spend changed since it was confirmed: now ₹6,000 a day (it was ₹5,000). Nothing was changed in Meta.";
    expect(reopenedReason({ status: "draft", progress: step(why) } as never)).toBe(why);
    expect(reopenedReason({ status: "queued", progress: step(why) } as never)).toBe("");
    expect(reopenedReason({ status: "draft", progress: step("Made before it stopped: 2 items (kept, paused; Retry continues from here).") } as never)).toBe("");
    expect(reopenedReason({ status: "draft", progress: [] } as never)).toBe("");
  });
});
