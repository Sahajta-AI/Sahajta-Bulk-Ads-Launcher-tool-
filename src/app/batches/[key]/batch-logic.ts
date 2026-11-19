// Decisions the batch page makes (pure: no React, so they can be unit tested).
// The ad account is on Meta's starter tier (about 300 calls an hour), so the page must not ask
// for anything that reads Meta per upload or per poll.

import type { BatchView, Cancelled, RetryResult } from "@/lib/service";
import { istLabel } from "@/lib/time";
import type { Check, CopyOverride, Preset } from "@/lib/types";
import type { LastUsed, Templates } from "../../client-api";
import { ist } from "../../manage/util";

type CopyLike = Pick<Templates["copy"][number], "primaryTexts" | "headlines" | "description" | "cta" | "linkUrl" | "utmTemplate" | "displayLink" | "leadFormId">;
type PresetTpl = Templates["presets"][number];
type ViewAd = Pick<BatchView["ads"][number], "id" | "effectiveStatus" | "metaAdId" | "reviewIssues">;
type Checks = Pick<BatchView["preview"], "batchChecks" | "ads">;

const str = (v: string | null | undefined) => v ?? "";

/** The copy template was edited in Settings after the batch took its copy of it. */
export function copyStale(tpl: CopyLike | undefined, copy: CopyLike | undefined): boolean {
  if (!tpl || !copy) return false;
  const pick = (c: CopyLike) => [c.primaryTexts, c.headlines, str(c.description), str(c.cta), str(c.linkUrl), str(c.utmTemplate), str(c.displayLink), str(c.leadFormId)];
  return JSON.stringify(pick(tpl)) !== JSON.stringify(pick(copy));
}

/** The preset was edited in Settings after the batch took its copy of it. */
export function presetStale(tpl: PresetTpl | undefined, preset: Preset | null | undefined): boolean {
  if (!tpl || !preset) return false;
  const on = (keys: string[]) => [...keys].sort().join();
  return str(tpl.pageId) !== str(preset.pageId)
    || str(tpl.igUserId) !== str(preset.igUserId)
    || !!tpl.multiAdvertiser !== !!preset.multiAdvertiser
    || on(tpl.enhancementsOn ?? []) !== on(Object.keys(preset.enhancements ?? {}))
    || str(tpl.whatsappNumber) !== str(preset.whatsappNumber)
    || str(tpl.threadsUserId) !== str(preset.threadsUserId)
    || str(tpl.sponsorPageId) !== str(preset.sponsorPageId);
}

/**
 * When the launch summary (which reads Meta) must be asked for again: only for a draft that has
 * loaded, and only when the ad set, copy, preset or go-live choice changed. Not per upload, except
 * with "a new ad set for each ad": there the total is per ad, so the number of ads counts too.
 * null = don't ask.
 */
export function summaryKey(view: (Pick<BatchView, "key" | "status" | "settings"> & { ads?: readonly unknown[] }) | null): string | null {
  if (!view || view.status !== "draft") return null;
  const s = view.settings;
  const perAd = s.adsetMode === "new_per_ad" ? (view.ads?.length ?? 0) : null;
  return JSON.stringify([view.key, s.campaignId, s.adsetId, s.adsetMode, perAd, s.extraAdsets.map((x) => x.id), s.presetId, s.preset, s.copyTemplateId, s.copy, s.goLive, s.goLiveAt]);
}

/**
 * The summary to show for this key: one asked for another key (other ad set, budget, number of
 * ads…) is never shown, so its total can't be typed back.
 */
export function summaryFor<T>(got: { key: string | null; value: T } | null, key: string | null): T | null {
  return got && key !== null && got.key === key ? got.value : null;
}

/** A draft shown without its destination checks (they are kept 2 minutes): load it again with them. */
export function needsDestReload(v: Pick<BatchView, "status"> & { destChecked?: boolean }): boolean {
  return v.status === "draft" && v.destChecked !== true;
}

/** After an upload: reload once the last one finished (from some uploading to none). */
export function lastUploadDone(was: number, now: number): boolean {
  return was > 0 && now === 0;
}

/** Reloads while files are still uploading skip the destination checks (they may read Meta). */
export function reloadWithDest(uploading: number): boolean {
  return uploading === 0;
}

const LAST_USED: (keyof LastUsed)[] = ["adsetId", "adsetMode", "copyTemplateId", "presetId", "angle"];

/**
 * What a new batch starts with from the last one: the ad set, copy template, preset and angle. Never
 * the go-live choice, its time or the extra ad sets (a new batch always starts paused, in one ad set).
 */
export function pickLastUsed(x: Record<string, unknown> | null | undefined): LastUsed {
  const out: Record<string, unknown> = {};
  for (const k of LAST_USED) if (x && x[k] !== undefined && x[k] !== null && x[k] !== "") out[k] = x[k];
  return out as LastUsed;
}

/** Settings whose change changes what the destination checks say (ad set, Instagram, lead form). */
const DEST_KEYS = new Set(["campaignId", "adsetId", "adsetMode", "extraAdsetIds", "presetId", "copyTemplateId"]);

const codes = (p: Checks) => new Set([...p.batchChecks, ...p.ads.flatMap((a) => a.checks)].map((c) => c.code));

/**
 * After a settings change (PATCH) that already returned the batch, is one more load with the
 * destination checks needed? Yes when the change touched the ad set, preset or copy, or when a
 * check disappeared (it may be a destination check the quick answer leaves out). No when the
 * server says its answer already includes the destination checks.
 */
export function reloadAfterPatch(body: Record<string, unknown>, before: Checks | null, after: { preview: Checks; destChecked?: boolean }): boolean {
  if (after.destChecked === true) return false;
  if (Object.keys(body).some((k) => DEST_KEYS.has(k))) return true;
  if (!before) return false;
  const now = codes(after.preview);
  return [...codes(before)].some((c) => !now.has(c));
}

const isLaunching = (status: string) => status === "queued" || status === "running";

/** This batch, or a batch launched together with it into another ad set, is still launching. */
export function groupLaunching(view: { status: string; together?: { status: string }[] }): boolean {
  return isLaunching(view.status) || (view.together ?? []).some((t) => isLaunching(t.status));
}

/**
 * Milliseconds until the next quiet reload of a launched batch (null = stop). Keeps going after a
 * failed reload, and while a batch launched together with this one (other ad set) is still running.
 */
export function pollDelay(view: { status: string; ads: ViewAd[]; together?: { status: string }[] } | null, lastLoadFailed: boolean): number | null {
  if (!view) return null;
  const running = groupLaunching(view);
  const inReview = view.ads.some((a) => a.effectiveStatus === "PENDING_REVIEW" || a.effectiveStatus === "IN_PROCESS" || (!!a.metaAdId && !a.effectiveStatus));
  if (!running && !inReview) return null;
  const base = running ? 3000 : 60_000;
  return lastLoadFailed ? Math.max(base, 10_000) : base;
}

/** What Meta's review said for every ad, to see whether a "check now" brought news. */
export function reviewSnapshot(ads: ViewAd[]): string {
  return JSON.stringify(ads.map((a) => [a.id, a.effectiveStatus, a.reviewIssues]));
}

/** After "Check Meta review status now": quiet reloads (no Meta calls) while the worker asks Meta. */
export const REVIEW_POLL_MS = [5000, 10_000, 15_000];

type ReviewView = { ads: ViewAd[]; reviewCheckedAt?: string | null };

/**
 * One quiet reload after "Check Meta review status now": is the check over? "news" (Meta's review
 * changed), "same" (the check ran, nothing changed), or null (keep waiting). When the server says
 * when the review was last read (`reviewCheckedAt`), the check is over as soon as that time moves;
 * without it (older server), only a change in the review ends it early.
 */
export function reviewCheckResult(before: ReviewView, after: ReviewView): "news" | "same" | null {
  const changed = reviewSnapshot(after.ads) !== reviewSnapshot(before.ads);
  if (changed) return "news";
  const known = before.reviewCheckedAt !== undefined && after.reviewCheckedAt !== undefined;
  if (known && !!after.reviewCheckedAt && after.reviewCheckedAt !== before.reviewCheckedAt) return "same";
  return null;
}

/** After the last quiet reload: "same", or "late" when the server shows the check has not run yet. */
export function reviewCheckTimedOut(before: ReviewView, last: ReviewView | null): "same" | "late" {
  const known = before.reviewCheckedAt !== undefined && last?.reviewCheckedAt !== undefined;
  return known && last!.reviewCheckedAt === before.reviewCheckedAt ? "late" : "same";
}

/** "Last checked 19 Nov 2026, 3:05 pm IST", or "" when the server doesn't say. */
export function reviewCheckedText(at: string | null | undefined): string {
  return at ? `Last checked ${ist(at)}` : "";
}

// ---------- Launch: warnings the person read ----------

/**
 * The tick "I read the warnings" counts only for the warnings the page showed when it was ticked
 * (`acceptedAt` = their number). More or fewer warnings since: it must be ticked again.
 */
export function warningsAccepted(acceptedAt: number | null, warningsNow: number): boolean {
  return warningsNow === 0 || (acceptedAt !== null && acceptedAt === warningsNow);
}

/** What the Launch button sends: how many warnings the person saw (the server refuses if it finds more). */
export function launchBody(o: { warnings: number; acceptedAt: number | null; goLive: string; spendTyped: string }) {
  return {
    confirm: true as const,
    acceptWarnings: o.warnings > 0 && o.acceptedAt === o.warnings ? o.acceptedAt : 0,
    spendConfirmation: o.goLive !== "paused" ? o.spendTyped : undefined,
  };
}

/**
 * The launch was refused because the server found warnings the person had not seen ("2 new warnings
 * since you checked…", or "There is 1 warning. Read them…"): untick, show them, ask for a new tick.
 */
export function isWarningsRefusal(message: string | null | undefined): boolean {
  return !!message && (/\bnew warnings? since you checked\b/i.test(message) || /Read them in the preview and accept them/i.test(message));
}

// ---------- Where each check of the batch shows on the draft page ----------

const DEST_CODES = ["no_campaign", "no_adset", "adset_missing", "dynamic_creative"];
const SETTINGS_CODES = ["no_page", "no_instagram"];

/**
 * Batch checks by section: step 1 (files skipped), step 2 (the ad set), step 5 (Page, Instagram),
 * step 6 (everything else, e.g. lead form, WhatsApp button, checks that couldn't run). "Pick a
 * campaign / ad set" and "no files yet" show only in the launch bar's list, so they are left out.
 */
export function checkSections(list: Check[]): { creatives: Check[]; destination: Check[]; settings: Check[]; preview: Check[] } {
  return {
    creatives: list.filter((c) => c.code === "skipped_files"),
    destination: list.filter((c) => DEST_CODES.includes(c.code) && c.code !== "no_campaign" && c.code !== "no_adset"),
    settings: list.filter((c) => SETTINGS_CODES.includes(c.code)),
    preview: list.filter((c) => !DEST_CODES.includes(c.code) && !SETTINGS_CODES.includes(c.code) && c.code !== "skipped_files" && c.code !== "no_ads"),
  };
}

// ---------- After the launch ----------

type AfterView = Pick<BatchView, "status" | "progress" | "finishedAt"> & {
  settings: Pick<BatchView["settings"], "goLive">;
  goLivePlan?: BatchView["goLivePlan"];
  goLiveHold?: string | null;
  retryHold?: string | null;
  goLiveWaits?: string | null;
};

/**
 * A failed or partly done batch: the settings preset and copy template can still change, for the
 * ads not created yet (e.g. a preset without the Instagram account Meta refused).
 */
export function canChangeAfterLaunch(view: Pick<BatchView, "status" | "progress">): boolean {
  return (view.status === "failed" || view.status === "partial") && view.progress.done < view.progress.total;
}

/**
 * The Retry button, or null. Ads not created yet: retry them. Every ad in, but the ads were to be
 * turned on and no turn-on plan exists a few minutes after the end: offer to turn them on again, or,
 * when the yes given at launch no longer holds or a Retry now would not use it (a Stop, a Retry long
 * after the launch ended…), to make the turn-on plan to confirm (the server answers what it did).
 * Nothing while the ads wait for the other ad sets of the launch (a Retry here can't help).
 */
export function retryOffer(view: AfterView, now = Date.now()): { label: string; goLiveOnly: boolean } | null {
  if (view.status === "draft" || isLaunching(view.status)) return null;
  const left = view.progress.total - view.progress.done;
  if (left > 0) return { label: `Retry the ${left} failed ad${left === 1 ? "" : "s"} only`, goLiveOnly: false };
  if (view.settings.goLive === "paused" || view.goLivePlan || view.goLivePlan === undefined || !view.progress.total || view.goLiveWaits) return null;
  const ended = view.finishedAt ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(view.finishedAt) ? view.finishedAt : `${view.finishedAt.replace(" ", "T")}Z`) : NaN;
  // Right after the last ad the worker makes the turn-on plan: give it a few minutes.
  if (!Number.isNaN(ended) && now - ended < 3 * 60_000) return null;
  return { label: view.goLiveHold || view.retryHold ? "Make the turn-on plan to confirm" : "Turn the ads on again", goLiveOnly: true };
}

const PLAN_STATE: Record<string, string> = {
  draft: "Saved as a draft: open it to check and confirm.",
  queued: "Confirmed, waiting to run.",
  running: "Turning the ads on now.",
  done: "Done: the ads were turned on.",
  partial: "Some steps failed: open it to see which.",
  failed: "Failed: open it to see why. The ads stay paused.",
  cancelled: "Cancelled: the ads were not turned on.",
};

/** The plan that turns the batch's ads on, in plain words (status and, if set, the time in India). */
export function goLivePlanText(plan: BatchView["goLivePlan"] | undefined): { key: string; href: string; text: string; draft: boolean } | null {
  if (!plan) return null;
  const when = plan.runAt && (plan.status === "queued" || plan.status === "draft") ? ` Runs at ${ist(plan.runAt)}.` : "";
  // Cancelled while it ran: say what it had already turned on, not "not turned on".
  const state = plan.status === "cancelled" && plan.stopNote ? `Cancelled while it ran: ${plan.stopNote}.` : (PLAN_STATE[plan.status] ?? plan.status);
  return { key: plan.key, href: `/plans/${plan.key}`, text: `${state}${when}`, draft: plan.status === "draft" };
}

const andList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]);

/**
 * What Stop did, from its answer: the launches it stopped, the turn-ons it stopped, and the ads that
 * were already turned on before it (Stop doesn't turn those off).
 * "Stopped: this batch and the launch into ad set "X". Ads already created stay paused; …"
 */
export function stoppedText(cancelled: Pick<Cancelled, "key" | "adsetName" | "result" | "planKey">[] | undefined, batchKey: string): string {
  if (!cancelled?.length) return "";
  const who = (c: { key: string; adsetName: string | null }) => (c.key === batchKey ? "this batch" : `the launch into ad set "${c.adsetName ?? c.key}"`);
  const plan = (c: { planKey?: string }) => (c.planKey ? ` (plan ${c.planKey})` : "");
  const launches = cancelled.filter((c) => c.result === "cancelled" || c.result === "stopping");
  const offs = cancelled.filter((c) => c.result === "turn_on_cancelled");
  const on = cancelled.filter((c) => c.result === "already_on" || c.result === "turn_on_stopping");
  const out: string[] = [];
  if (launches.length) out.push(`Stopped: ${andList(launches.map((c) => (c.result === "stopping" ? `${who(c)} (after the current step)` : who(c))))}.`);
  if (offs.length) out.push(`Stopped the turn-on of ${andList(offs.map((c) => `${who(c)}${plan(c)}`))}: those ads are not turned on.`);
  if (!on.length) out.push("Ads already created stay paused; nothing is deleted or turned on.");
  else {
    out.push("Nothing is deleted. Other ads already created stay paused.");
    out.push(`Already turned on before the Stop: the ads of ${andList(on.map((c) => `${who(c)}${plan(c)}${c.result === "turn_on_stopping" ? ", which stops now; what it already turned on stays on" : ""}`))}. Stop doesn't turn them off: pause them under Campaigns, or open the plan and press Undo.`);
  }
  return out.join(" ");
}

/**
 * Every ad is in and the ads are still to be turned on (a turn-on plan waiting, or about to be
 * made): the button that stops only that, or null. While the launch runs, "Stop the launch" does it.
 */
export function stopTurnOnOffer(v: Pick<BatchView, "status" | "settings" | "goLivePlan" | "progress" | "cancelRequested"> & { together?: { status: string }[] }): string | null {
  if (groupLaunching(v) || v.settings.goLive === "paused" || v.status === "draft") return null;
  const p = v.goLivePlan;
  if (p) return p.status === "queued" || p.status === "draft" ? "Don't turn the ads on" : p.status === "running" ? "Stop turning the ads on" : null;
  return v.progress.total > 0 && v.progress.done === v.progress.total && !v.cancelRequested ? "Don't turn the ads on" : null;
}

type HoldView = Pick<BatchView, "settings" | "goLivePlan"> & { goLiveHold?: string | null; retryHold?: string | null; goLiveWaits?: string | null; goLiveNote?: string | null; status?: string };

/** The ads are still to be turned on by this batch (no turn-on plan made yet). */
const goLivePending = (v: HoldView) => v.settings.goLive !== "paused" && !v.goLivePlan;

/**
 * Why the ads won't be turned on by themselves as things are now (after a Stop, a time long past, or a
 * Retry long after the launch ended), in plain words, or "". The turn-on plan is then a draft to check
 * and confirm. What a Retry pressed now would meet is said on the Retry button and its question only.
 */
export function holdText(v: HoldView): string {
  if (!goLivePending(v) || !v.goLiveHold) return "";
  return `The ads won't be turned on by themselves: ${v.goLiveHold}. ${v.status === "queued" || v.status === "running" ? "Once" : "After a Retry, once"} every ad is in, a turn-on plan is saved as a draft: open it, check the budgets and confirm it to turn the ads on.`;
}

/**
 * "What happened" after the launch: what the worker does next to turn the ads on. "" for paused batches
 * and when the turn-on plan shows instead; the server's note when turning them on failed (the worker
 * tries again, or gave up: then they stay paused until Retry); the other ad sets of the launch it waits for.
 */
export function goLiveLine(v: HoldView): string {
  if (!goLivePending(v)) return "";
  const hold = holdText(v);
  if (hold) return hold;
  if (v.goLiveNote) return `${v.goLiveNote}${/NOT turned on/.test(v.goLiveNote) ? ` Press "${v.retryHold ? "Make the turn-on plan to confirm" : "Turn the ads on again"}"${v.retryHold ? "" : " to try again"}.` : ""}`;
  if (v.goLiveWaits) return `The ads are turned on together with the other ad sets of this launch, once every ad is in there too: ${v.goLiveWaits}.`;
  const s = v.settings;
  return s.goLive === "now"
    ? "The ads are turned on once every ad is in. The activity log below shows when."
    : `The ads are turned on at ${s.goLiveAt ? istLabel(s.goLiveAt) : "the set time"}, once every ad is in.`;
}

/**
 * The question asked before a Retry: when it will turn ads on with the yes given at launch, or when a
 * Retry now no longer uses that yes (pressed long after the launch ended: a draft plan is made to
 * confirm). null when the Retry turns nothing on by itself and the page already says why (paused
 * batch, a turn-on plan already made, or the yes no longer holds anyway).
 */
export function retryQuestion(v: HoldView, goLiveOnly: boolean): string | null {
  if (!goLivePending(v) || v.goLiveHold) return null;
  if (v.retryHold) {
    return `${goLiveOnly ? "Make the plan that turns the ads on?" : "Retry the failed ads?"} The ads are NOT turned on by themselves: ${v.retryHold}, so the budget confirmation given at launch is not used. ${goLiveOnly ? "A" : "Once every ad is in, a"} turn-on plan is saved as a draft: open it, check the budgets and confirm it to turn the ads on.`;
  }
  const when = v.settings.goLive === "at" && v.settings.goLiveAt ? `at ${istLabel(v.settings.goLiveAt)}` : "straight away";
  return goLiveOnly
    ? `Try again to turn the ads on ${when}? They start spending with the budgets confirmed at launch.`
    : `Retry the failed ads? Once every ad is in, the ads are turned on ${when} and start spending with the budgets confirmed at launch.`;
}

/** An activity log time: India time with the date ("19 Nov 2026, 03:05 pm IST"), on any laptop. */
export function eventTime(at: string): string {
  return istLabel(at);
}

// ---------- The page's actions (the network call is passed in, so tests can use the real server) ----------

/** Stop: the answer and what to say about it. */
export async function stopLaunch<V>(post: () => Promise<V & { cancelled?: Cancelled[] }>, batchKey: string): Promise<{ view: V; stopped: string }> {
  const r = await post();
  return { view: r, stopped: stoppedText(r.cancelled, batchKey) };
}

/** Retry: the answer and the server's own words about what it did. */
export async function retryLaunch<V>(post: () => Promise<V & { retry?: RetryResult }>): Promise<{ view: V; notice: string }> {
  const r = await post();
  return { view: r, notice: r.retry?.message ?? "" };
}

/**
 * After "Check Meta review status now": quiet reloads (no Meta calls) until the check ran. "news",
 * "same" or "late"; null when the page went away meanwhile.
 */
export async function waitForReview(
  before: ReviewView,
  reload: () => Promise<ReviewView | null>,
  opts: { sleep?: (ms: number) => Promise<void>; alive?: () => boolean } = {},
): Promise<"news" | "same" | "late" | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = opts.alive ?? (() => true);
  let last: ReviewView | null = null;
  for (const ms of REVIEW_POLL_MS) {
    await sleep(ms);
    if (!alive()) return null;
    const v = await reload();
    if (v) last = v;
    const result = v ? reviewCheckResult(before, v) : null;
    if (result) return result;
  }
  return reviewCheckTimedOut(before, last);
}

/**
 * Launch. A refusal over warnings the page didn't show unticks the box, keeps it off until the
 * reload with the new warnings is on screen, and then lets the person tick again.
 */
export async function launchAndReread<V>(
  post: () => Promise<V>,
  ui: { shown: (v: V) => void; failed: (message: string) => void; untick: () => void; rereading: (on: boolean) => void; reload: () => Promise<unknown> },
): Promise<void> {
  try {
    ui.shown(await post());
  } catch (e) {
    const msg = (e as Error).message;
    ui.failed(msg);
    const reread = isWarningsRefusal(msg);
    if (reread) {
      ui.untick();
      ui.rereading(true);
    }
    // The launch's own check is saved, so this reload shows the warnings it found.
    await ui.reload();
    if (reread) ui.rereading(false);
  }
}

/**
 * Per-ad settings the "Change copy for this ad" form does not show, so saving it must carry
 * them over (the save replaces the ad's own changes): link tags and the carousel format.
 */
export function notEditedHere(o: CopyOverride): Pick<CopyOverride, "utmTemplate" | "format"> {
  const keep: Pick<CopyOverride, "utmTemplate" | "format"> = {};
  if (o.utmTemplate) keep.utmTemplate = o.utmTemplate;
  if (o.format) keep.format = o.format;
  return keep;
}
