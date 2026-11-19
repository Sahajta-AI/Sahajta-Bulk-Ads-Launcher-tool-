import { db, json } from "../db";
import { appLink, clearAlerts, sendAlert } from "../alerts";
import { enqueue } from "../jobs";
import { clientFor } from "../meta/factory";
import { adCopy, batchCopy, batchPreset, getAccount, getAds, getBatch, getBatchByKey, logEvent, updateBatch } from "../store";
import { istLabel, timeMs } from "../time";
import { dailyEquivalent } from "./budget";
import type { BatchRow, Check } from "../types";
import { accountHealth, pixelCheck } from "./checks";
import { accountInfo, campaignAdSets, describeAdSet, getAdSet, getCampaign, isCbo, istTime, type AdSetRow } from "./objects";
import { fromMinor, money } from "./options";
import { MAX_COPIES, budgetWarnDaily, savePlan, summarise, type Op, type PlanInput, type PlanSummary, type SpendItem } from "./plan";

// Batches: what happens after the ads are in ("launch now" / "at a time"), and the summary
// shown before the launch is confirmed.

export interface ExtraAdset { id: string; name: string; campaignId: string; campaignName: string }

export const extraAdsets = (b: BatchRow): ExtraAdset[] => json<ExtraAdset[]>(b.extra_adsets, []);

/** The extra ad sets that really get a batch of their own: never the main ad set, never twice. */
export function launchExtras(b: BatchRow): ExtraAdset[] {
  const seen = new Set<string>(b.adset_id ? [b.adset_id] : []);
  return extraAdsets(b).filter((x) => {
    if (!x?.id || seen.has(x.id)) return false;
    seen.add(x.id);
    return true;
  });
}

/** The batch and the batches launched together with it (one per extra ad set). */
export function siblings(b: BatchRow): BatchRow[] {
  if (!b.group_key) return [b];
  return db().prepare("SELECT * FROM batches WHERE group_key = ? ORDER BY id").all(b.group_key) as BatchRow[];
}

// dailyEquivalent lives in ./budget (plan.ts uses it too, without importing this file).
export { dailyEquivalent };

/** "₹30,000 lifetime, ends 25 Nov (counted as ₹4,286 a day)" */
function lifetimeLabel(life: number, end: string | null | undefined, perDay: number, m: (v: number | null) => string): string {
  const ms = timeMs(end);
  const ends = Number.isNaN(ms) ? "" : `, ends ${new Date(ms).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}`;
  return `${m(life)} lifetime${ends} (counted as ${m(perDay)} a day)`;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * The plan that turns a batch's ads on, if one was made. One plan turns on all the ad sets of a launch
 * (plans.batch_id: the lowest id of the batches it turns on); after a Stop and a Retry on one of them, or
 * for launches from before 19 Nov, a batch may have a plan of its own. Found by plans.batch_id, not by the
 * title (a plan can be renamed): the batch's own plan, or a plan of the launch that turns on any of its
 * ads (a plan edited to leave some ads out is still found).
 */
export function goLivePlan(batchKey: string): { key: string; status: string; runAt: string | null; stopNote?: string } | null {
  const b = getBatchByKey(batchKey);
  if (!b) return null;
  const ids = siblings(b).map((x) => x.id);
  const r = db()
    .prepare(
      `SELECT key, status, run_at, progress FROM plans p WHERE p.batch_id IN (${marks(ids.length)}) AND (p.batch_id = ?
         OR EXISTS (SELECT 1 FROM ads a WHERE a.batch_id = ? AND a.meta_ad_id IS NOT NULL AND instr(p.ops, '"' || a.meta_ad_id || '"') > 0))
       ORDER BY p.id DESC LIMIT 1`,
    )
    .get(...ids, b.id, b.id) as { key: string; status: string; run_at: string | null; progress: string } | undefined;
  if (!r) return null;
  // Cancelled while it ran: what it had already turned on (the stopped step's own words).
  let stopNote: string | undefined;
  if (r.status === "cancelled") {
    const steps = JSON.parse(r.progress || "[]") as { status?: string; ids?: string[]; message?: string }[];
    const st = steps.find((x) => x.status === "stopped" && (x.ids ?? []).length && x.message);
    if (st) stopNote = st.message!.replace(/^Stopped because the plan was cancelled: /, "").replace(/ Nothing after this step ran\.$/, "").replace(/\.$/, "");
  }
  return { key: r.key, status: r.status, runAt: r.run_at, ...(stopNote ? { stopNote } : {}) };
}

const HOUR = 3600_000;
const isLaunching = (b: BatchRow) => b.status === "queued" || b.status === "running";

/** The first amount in a money text ("₹1,500" → 1500); 0 when there is none. */
function amountOf(s: string | null | undefined): number {
  const m = /\d[\d,]*(?:\.\d+)?/.exec(s ?? "");
  return m ? Number(m[0].replace(/,/g, "")) : 0;
}

/**
 * What the budgets that can spend add up to in a day, with each lifetime budget spread over the whole
 * days left from `at`: the plan engine's own items (spendBasis), so two checks made at different times
 * compare as at the same moment (the days left on a lifetime budget go down as time passes).
 */
export function spendAt(basis: SpendItem[], at: number): number {
  return basis.reduce((sum, x) => sum + (x.daily ?? dailyEquivalent(null, x.lifetime, x.end, x.start, at)) + (x.raise || 0), 0);
}

/**
 * Why the turn-on plan can spend more than the total typed back at launch (the whole reason, as the
 * draft message says it), or null. Only what THIS plan starts or raises counts (SpendItem.mine, the plan
 * engine's own rule, also used when the plan starts to run): a budget already spending before it that it
 * leaves as it is (an earlier launch's ad set turned on meanwhile in the same campaign) is not "more than
 * typed". Compared at the moment the total was worked out for (go_live_total_at): a lifetime budget
 * whose days left went down while the ads were made is not "more". Less than typed is fine. A launch
 * from before the total was kept has nothing to compare against, so it needs a new yes.
 */
function moneyHold(b: BatchRow, s: PlanSummary): string | null {
  if (!s.canSpend) return null;
  const typed = b.go_live_total;
  if (!typed) return "the total typed at launch was not kept, so the turn-on needs a new yes";
  const t0 = [timeMs(b.go_live_total_at), b.go_live === "at" ? timeMs(b.go_live_at) : NaN].find((x) => !Number.isNaN(x));
  const limit = amountOf(typed) + 0.5;
  const why = ", so the budget confirmation given at launch is not used";
  const basis = s.spendBasis;
  if (!basis) {
    const total = amountOf(s.spendConfirmation);
    return total <= limit ? null : `what can spend once they are on is now ${s.spendConfirmation} a day, not the ${typed} typed at launch${why}`;
  }
  const at = t0 ?? Date.now();
  const started = basis.filter((x) => x.mine !== false);
  const total = spendAt(started, at);
  if (total <= limit) return null;
  return started.length === basis.length
    ? `what can spend once they are on is now ${s.spendConfirmation ?? money(total, s.account.currency)} a day, not the ${typed} typed at launch${why}`
    : `what the budgets it turns on can spend is now ${money(total, s.account.currency)} a day (budgets already spending before it are not counted), not the ${typed} typed at launch${why}`;
}

/**
 * When a Retry pressed at `now` comes more than an hour after the later of the set time ("at a time")
 * and the end of the run before it: that time (ISO), or null. The first run itself may take hours (or
 * end after the set time): that is still the launch that was confirmed. retryFailed keeps the answer on
 * the batch (late_retry_from) when the Retry is pressed.
 */
export function lateRetryFrom(b: Pick<BatchRow, "go_live" | "go_live_at" | "finished_at">, now = Date.now()): string | null {
  if (b.go_live !== "now" && b.go_live !== "at") return null;
  const ended = timeMs(b.finished_at);
  const at = b.go_live === "at" ? timeMs(b.go_live_at) : NaN;
  if (Number.isNaN(ended) && Number.isNaN(at)) return null;
  const from = Number.isNaN(at) || (!Number.isNaN(ended) && ended >= at) ? ended : at;
  if (now - from <= HOUR) return null;
  return from === ended ? b.finished_at! : b.go_live_at!;
}

/**
 * Why the yes given at launch (the typed total) no longer turns this batch's ads on by itself, or
 * null when it still does. The turn-on plan is then saved as a draft that needs a fresh confirmation.
 *  - The launch was stopped ("Stop the launch", on this batch or one launched with it).
 *  - "Retry" was pressed more than an hour after the later of the set time ("at a time") and the end of
 *    the run before it (late_retry_from, kept once it happened). The first run itself may take hours,
 *    and may end after the set time: that is still the launch that was confirmed.
 * `retryNow`: what a Retry pressed at `now` would meet (for the Retry button and its question).
 */
export function goLiveHold(b: BatchRow, now = Date.now(), opts: { retryNow?: boolean } = {}): string | null {
  if (b.go_live === "paused") return null;
  if (b.stopped_at) return `the launch was stopped (${istLabel(b.stopped_at)})`;
  const late = b.late_retry_from ?? (opts.retryNow && !isLaunching(b) ? lateRetryFrom(b, now) : null);
  if (!late) return null;
  const setTime = b.go_live === "at" && timeMs(late) === timeMs(b.go_live_at);
  return setTime
    ? `more than an hour passed between the time set to turn them on (${istTime(b.go_live_at!)}) and the Retry`
    : `more than an hour passed between the end of the launch (${istLabel(late)}) and the Retry`;
}

/** Stop is in force: pressed, and no Retry since (Retry clears cancel_requested). Nothing is turned on, no plan is made. */
export const stopInForce = (b: BatchRow): boolean => !!b.cancel_requested;

/**
 * The batches one turn-on plan turns on: this one, with the batches launched together with it whose ads
 * are still to be turned on by the yes given at launch (not stopped, no turn-on plan yet). Several ad
 * sets of one launch are turned on together, by one plan, once every ad of each is in.
 */
export function turnOnGroup(b: BatchRow): BatchRow[] {
  const all = siblings(b);
  const others = all.filter((x) => x.id !== b.id && x.go_live !== "paused" && x.status !== "draft" && !x.go_live_done && !stopInForce(x));
  return [b, ...others].sort((x, y) => x.id - y.id);
}

/** The other batches of the group whose ads are not all in yet, in plain words, or null. */
export function groupWaits(b: BatchRow, group = turnOnGroup(b)): string | null {
  const parts = group
    .filter((x) => x.id !== b.id)
    .map((x) => {
      const name = `the launch into ad set "${x.adset_name ?? x.key}"`;
      if (isLaunching(x)) return `${name} is still running`;
      const left = db().prepare("SELECT COUNT(*) FROM ads WHERE batch_id = ? AND status != 'done'").pluck().get(x.id) as number;
      return left ? `${name} has ${left} ad${left === 1 ? "" : "s"} not created (press Retry on batch ${x.key})` : "";
    })
    .filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

/** The hold that applies to the group's turn-on plan (this batch's first; `retryNow` for this batch only), or null. */
export function groupHold(b: BatchRow, group = turnOnGroup(b), opts: { retryNow?: boolean } = {}): string | null {
  return goLiveHold(b, Date.now(), opts) ?? group.filter((x) => x.id !== b.id).map((x) => goLiveHold(x)).find(Boolean) ?? null;
}

/**
 * Stop for a batch whose ads are all in: its turn-on plan, if it has not run, is cancelled (atomically:
 * a plan the worker starts at this moment is not cancelled as "not run"). "cancelled": it was waiting
 * (queued, or a draft) and won't run; "stopping": it was running and stops now, before the next item (the
 * plan's normal stop: what it already turned on stays on); "on": it already ran, so the ads are on and
 * Stop doesn't turn them off; null: no plan (none yet, or one that ended without turning anything on).
 * Every turn-on plan of the launch that has not ended is stopped too (plans.batch_id in the launch),
 * also one no batch finds any more (edited to leave ads out, or a second plan of an old launch).
 * A plan shared by several batches is stopped once: pass the same `seen` map for each batch.
 */
export function stopTurnOn(b: BatchRow, seen = new Map<string, "cancelled" | "stopping" | "on" | null>()): { result: "cancelled" | "stopping" | "on"; planKey: string } | null {
  if (b.go_live === "paused") return null;
  const ids = siblings(b).map((x) => x.id);
  const open = db().prepare(`SELECT key FROM plans WHERE batch_id IN (${marks(ids.length)}) AND status IN ('queued', 'draft', 'running') ORDER BY id`).pluck().all(...ids) as string[];
  const swept = open.filter((k) => !seen.has(k));
  for (const k of swept) seen.set(k, stopPlan(k));
  // The batch's own plan; else one of the launch's plans this Stop just stopped (so the Stop says so).
  const plan = goLivePlan(b.key) ?? (swept.find((k) => seen.get(k)) ? { key: swept.find((k) => seen.get(k))! } : null);
  if (!plan) return null;
  if (!seen.has(plan.key)) seen.set(plan.key, stopPlan(plan.key));
  const result = seen.get(plan.key);
  if (result === "cancelled") logEvent(b.id, null, "warn", `Stopped: the turn-on plan ${plan.key} is cancelled. The ads stay paused; turn them on from the Campaigns page when you're ready.`);
  if (result === "stopping") logEvent(b.id, null, "warn", `Stop asked: the turn-on plan ${plan.key} was already running; it stops now, before the next item. Ads it already turned on stay on.`);
  return result ? { result, planKey: plan.key } : null;
}

function stopPlan(key: string): "cancelled" | "stopping" | "on" | null {
  const id = db().prepare("SELECT id FROM plans WHERE key = ?").pluck().get(key) as number;
  if (db().prepare("UPDATE plans SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status IN ('queued', 'draft')").run(id).changes) {
    db().prepare("UPDATE jobs SET status = 'done', last_error = 'cancelled' WHERE kind = 'plan' AND batch_id = ? AND status = 'queued'").run(id);
    // "Not turned on: open the plan" no longer applies (the worker clears them for a plan that ran).
    clearAlerts(`/plans/${key}`, ["golive", "stopped"]);
    return "cancelled";
  }
  if (db().prepare("UPDATE plans SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status = 'running'").run(id).changes) return "stopping";
  const now = db().prepare("SELECT status FROM plans WHERE id = ?").pluck().get(id) as string;
  return now === "done" || now === "partial" ? "on" : null;
}

/** Another ad set of the launch had its turn-on plan made while this one was being checked. */
const SAME_MOMENT = Symbol("same moment");

/**
 * After a launch: when the batch was launched with "now" or "at a time", make the plan that turns on
 * the new ads, their ad sets and campaigns (the campaigns last). The batches launched together into
 * several ad sets share one plan, made by the last of them to have every ad in: its total is compared
 * once with the total typed at launch. The yes (with that total) was given at launch, so the plan is
 * queued as confirmed, unless:
 *  - the launch was stopped and not retried since (nothing is turned on, no plan is made);
 *  - the yes no longer holds for one of the batches (goLiveHold: stopped then retried, a Retry long
 *    after the launch ended or its set time), the plan starts more spend than was typed (or the typed
 *    total was not kept), or its own check finds an error now (e.g. the Safety ceiling was lowered):
 *    then the plan is saved as a draft that needs a fresh confirmation, and the person is told (event
 *    and alert).
 * Waits while any ad of the group is not created. Safe to call again, also for two batches at the
 * same moment: each batch is turned on by at most one plan. null: this batch is already turned on by
 * a plan. When another ad set's plan was made meanwhile, it is checked again with the ad sets left
 * (once here; then an error, so the worker tries again).
 */
export async function queueGoLive(batchId: number): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const r = await queueGoLiveOnce(batchId);
    if (r !== SAME_MOMENT) return r;
    if (attempt >= 2) throw new Error("the turn-on plan of another ad set of this launch was made at the same moment; trying again");
  }
}

/**
 * A batch whose turn-on plan was made: if that plan is confirmed ("queued") but nothing will run it (no
 * waiting or running job, e.g. a database error right after it was confirmed), it is put in the queue
 * again. Returns what was done, or null.
 */
function requeueTurnOn(b: BatchRow): string | null {
  const plan = goLivePlan(b.key);
  if (!plan || plan.status !== "queued") return null;
  return db()
    .transaction((): string | null => {
      const row = db().prepare("SELECT id, status, run_at FROM plans WHERE key = ?").get(plan.key) as { id: number; status: string; run_at: string | null };
      if (row.status !== "queued") return null;
      const open = db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan' AND batch_id = ? AND status IN ('queued', 'running')").pluck().get(row.id) as number;
      if (open) return null;
      const at = timeMs(row.run_at);
      enqueue("plan", row.id, Number.isNaN(at) ? Date.now() : at);
      const msg = `The turn-on plan ${plan.key} was confirmed but not waiting to run; it is queued again.`;
      logEvent(b.id, null, "info", msg);
      return msg;
    })
    .immediate();
}

async function queueGoLiveOnce(batchId: number): Promise<string | null | typeof SAME_MOMENT> {
  const b = getBatch(batchId);
  if (!b || b.go_live === "paused") return null;
  if (b.go_live_done) return requeueTurnOn(b);
  if (stopInForce(b)) {
    logEvent(batchId, null, "warn", "Not turned on: the launch was stopped. The ads that were created stay paused; turn them on from the Campaigns page when you're ready.");
    return "go-live skipped: the launch was stopped";
  }
  const missing = getAds(batchId).filter((a) => a.status !== "done").length;
  if (missing) {
    logEvent(batchId, null, "warn", `Not turned on yet: ${missing} ad${missing > 1 ? "s were" : " was"} not created. Fix and press "Retry failed"; the ads are turned on once every ad is in.`);
    return `go-live waits for ${missing} failed ad(s)`;
  }
  const group = turnOnGroup(b);
  const waits = groupWaits(b, group);
  if (waits) {
    logEvent(batchId, null, "info", `All ads are created. They are turned on together with the other ad sets of this launch, once every ad is in there too: ${waits}.`);
    return `go-live waits for the other ad sets of this launch: ${waits}`;
  }
  const ids = group.map((x) => x.id);
  const ads = group.flatMap((x) => getAds(x.id));
  const adIds = ads.map((a) => a.meta_ad_id!).filter(Boolean);
  const adsetIds = [...new Set(ads.map((a) => a.meta_adset_id!).filter(Boolean))];
  const campaigns = [...new Set(group.map((x) => x.campaign_id!).filter(Boolean))];
  const at = timeMs(b.go_live_at);
  const runAt = b.go_live === "at" && !Number.isNaN(at) && at > Date.now() + 60_000 ? b.go_live_at! : undefined;
  const n = `${ads.length} ad${ads.length > 1 ? "s" : ""}`;
  const input: PlanInput = {
    title: group.length > 1 ? `Turn on batches ${group.map((x) => x.key).join(", ")} (${n} in ${group.length} ad sets)` : `Turn on batch ${b.key} (${n})`,
    run_at: runAt,
    // Ads first, then ad sets, the campaigns last: nothing spends until everything is on.
    ops: [{ type: "set_status", status: "ACTIVE", ads: adIds, adsets: adsetIds, campaigns }],
  };
  const client = clientFor(b.ad_account_id);
  const summary = await summarise(client, input, { validate: false });
  // The yes was for the total typed at launch: more spend started since (a budget raised in Ads Manager,
  // or a copy ad set) needs a new one.
  const overTyped = moneyHold(b, summary);
  const errors = (summary.checks ?? []).filter((c) => c.level === "error").map((c) => c.message);
  // One write: the plan, the batches it turns on (go_live_done) and, when the yes given at launch still
  // holds, its confirmation and its job. A busy database leaves nothing half-done (the next try makes it
  // all again), two batches of the group finishing at the same moment make one plan, and a Stop pressed
  // while the plan was being checked wins (the batches are read again here).
  const made = db()
    .transaction((): typeof SAME_MOMENT | null | { key: string; queued: boolean; reason: string; level: "warn" | "error"; stopped: boolean } => {
      const fresh = ids.map((id) => getBatch(id)!);
      if (fresh.find((x) => x.id === b.id)?.go_live_done) return null;
      if (fresh.some((x) => x.go_live_done)) return SAME_MOMENT;
      const k = savePlan(b.ad_account_id, input, summary, b.created_by ?? "launcher", "app");
      db().prepare("UPDATE plans SET batch_id = ? WHERE key = ?").run(ids[0], k);
      for (const id of ids) updateBatch(id, { go_live_done: 1 });
      const hold = fresh.map((x) => goLiveHold(x)).find(Boolean);
      const reason = hold ? `${hold}, so the budget confirmation given at launch is not used` : overTyped ?? (summary.errors > 0 ? errors.join(" ") || "the turn-on plan's check found a problem" : "");
      const stopped = fresh.some((x) => stopInForce(x));
      if (reason) return { key: k, queued: false, reason, level: hold || overTyped ? "warn" : "error", stopped };
      const id = db().prepare("UPDATE plans SET status = 'queued', confirmed_at = datetime('now'), confirmed_by = ? WHERE key = ? RETURNING id").pluck().get(`${b.created_by ?? "?"} (when launching batch ${b.key})`, k) as number;
      enqueue("plan", id, runAt ? timeMs(runAt) : Date.now());
      return { key: k, queued: true, reason: "", level: "warn", stopped };
    })
    .immediate();
  if (made === null || made === SAME_MOMENT) return made;
  const { key } = made;
  const log = (level: "info" | "warn" | "error", msg: string) => {
    for (const id of ids) logEvent(id, null, level, msg);
  };
  if (!made.queued) {
    const msg = `Ads created but NOT turned on: ${made.reason.trim().replace(/\.+$/, "")}. The turn-on plan ${key} is saved as a draft: open it, check the budgets and confirm it to turn the ads on.`;
    log(made.level, msg);
    // No email when the person just pressed Stop, or the draft was cancelled meanwhile (nothing to confirm).
    const still = db().prepare("SELECT status FROM plans WHERE key = ?").pluck().get(key) === "draft";
    if (b.created_by && still && !made.stopped) {
      await sendAlert({ to: b.created_by, subject: `Launch ${b.key}: ads created but not turned on`, lines: [msg], link: appLink(`/plans/${key}`), kind: "golive" });
    }
    return msg;
  }
  const msg = runAt ? `The ads will be turned on at ${istTime(runAt)} (plan ${key}).` : `Turning the ads on now (plan ${key}).`;
  log("info", group.length > 1 ? `${msg.replace(/\.$/, "")}, with the other ad sets of this launch.` : msg);
  return msg;
}

/**
 * The turn-on plan this launch will make, as the plan engine reads it before any ad exists: the picked
 * ad sets (or their new copies) and campaigns turned on. Only its spend count is used (summariseLaunch).
 * An existing ad set is first marked off, as the new ads are, so turning it on counts as "turns on" even
 * when it already is on (the real plan turns the new ads on): the plan engine then counts every ad set
 * that is on in those campaigns, exactly as it will for the real plan.
 */
function turnOnModel(b: BatchRow, targets: { id: string; campaignId: string }[], adCount: number, runAt: string | undefined): PlanInput {
  const ops: Op[] = [];
  const campaigns = [...new Set(targets.map((t) => t.campaignId))];
  if (b.adset_mode === "existing") {
    const adsets = targets.map((t) => t.id);
    ops.push({ type: "set_status", status: "PAUSED", adsets }, { type: "set_status", status: "ACTIVE", adsets, campaigns });
  } else {
    const copies = b.adset_mode === "new_per_ad" ? Math.max(1, adCount) : 1;
    for (const t of targets) {
      for (let i = 0; i < copies; i += MAX_COPIES) {
        const k = Math.min(MAX_COPIES, copies - i);
        ops.push({ type: "duplicate_adset", adset: t.id, copies: k, changes: Array.from({ length: k }, () => ({ status: "ACTIVE" as const })) });
      }
    }
    ops.push({ type: "set_status", status: "ACTIVE", campaigns });
  }
  return { title: `Launch ${b.key}`, run_at: runAt, ops };
}

// ---------- Pre-launch summary ----------

export interface LaunchSummary {
  account: { id: string; name: string; currency: string };
  /** The first campaign (kept for older readers); `campaigns` has every one. */
  campaign: { id: string; name: string; status: string; budget: string; cbo: boolean } | null;
  /** Every campaign of the launch, each once, with its budget (the campaign budget amount when it has one). */
  campaigns: { id: string; name: string; status: string; budget: string; cbo: boolean }[];
  adsets: { campaignId: string; name: string; budget: string; dailyBudget: number | null; bid: string; schedule: string; audience: string; placements: string; goal: string; ads: number; isNew: boolean }[];
  /**
   * What can spend in one day once the ads are on, counted as the turn-on plan counts it (the same
   * number the plan will show): the budget of every ad set that is on at the end in the campaigns
   * turned on (a campaign budget once), each lifetime budget ÷ the whole days it has left.
   */
  totalDailyBudget: number;
  totalDailyLabel: string;
  /** ISO time the total is worked out for: now, or the time the ads are turned on ("at a time"). */
  spendAt: string;
  /** Lifetime budgets, shown on their own: "“Ad set”: ₹30,000 lifetime, ends 25 Nov (counted as ₹4,286 a day)". */
  lifetimeBudgets: string[];
  alsoSpends: string[];
  adCount: number;
  copy: { primaryTexts: number; headlines: number; firstText: string; link: string; cta: string; utm: string };
  goLive: string;
  warnings: string[];
  /** Account health, pixel and landing page checks. */
  checks: Check[];
  /** Typed back to confirm a launch that turns ads on (one amount, the total above); null for paused launches. */
  spendConfirmation: string | null;
}

/** Everything the person should see before saying yes. Reads Meta (each ad set once); writes nothing. */
export async function launchSummary(b: BatchRow, goLive: { mode: "paused" | "now" | "at"; at?: string | null }): Promise<LaunchSummary> {
  const acc = getAccount(b.ad_account_id)!;
  const client = clientFor(acc.id);
  const { currency, name } = await accountInfo(client);
  const m = (v: number | null) => money(v, currency);
  const ads = getAds(b.id);
  const warnings: string[] = [];
  const adsets: LaunchSummary["adsets"] = [];
  const lifetimeBudgets: string[] = [];
  const campaignList: LaunchSummary["campaigns"] = [];
  const alsoSpends: string[] = [];
  // The main ad set and the extra ones, each once (the main one is never also an extra).
  const targets = [{ id: b.adset_id, campaignId: b.campaign_id }, ...launchExtras(b).map((x) => ({ id: x.id, campaignId: x.campaignId }))].filter(
    (t, i, all): t is { id: string; campaignId: string } => !!t.id && !!t.campaignId && all.findIndex((o) => o.id === t.id) === i,
  );
  const campaigns = new Map<string, Awaited<ReturnType<typeof getCampaign>>>();
  const rows = new Map<string, AdSetRow>();
  // A lifetime budget spreads over the days left from when the ads are turned on: for "at a time",
  // from that time (fewer days left, so more a day), never from now.
  const onAt = goLive.mode === "at" ? timeMs(goLive.at) : NaN;
  const from = Number.isNaN(onAt) ? Date.now() : Math.max(Date.now(), onAt);
  for (const t of targets) {
    let c = campaigns.get(t.campaignId);
    if (!c) {
      c = await getCampaign(client, t.campaignId);
      campaigns.set(t.campaignId, c);
    }
    const cbo = isCbo(c);
    const a = await getAdSet(client, t.id);
    rows.set(t.id, a);
    const d = describeAdSet(a, currency);
    const daily = fromMinor(a.daily_budget, currency);
    const life = fromMinor(a.lifetime_budget, currency);
    const each = cbo ? null : dailyEquivalent(daily, life, a.end_time, a.start_time, from);
    const copies = b.adset_mode === "new_per_ad" ? ads.length : 1;
    const budgetText = !cbo && life && each !== null ? lifetimeLabel(life, a.end_time, each - (daily ?? 0), m) : d.budget;
    if (!cbo && life && each !== null) lifetimeBudgets.push(`"${a.name}": ${budgetText}${copies > 1 ? `, for each of the ${copies} new ad sets` : ""}`);
    adsets.push({
      campaignId: t.campaignId,
      name: b.adset_mode === "new_per_ad" ? `${ads.length} new ad set${ads.length > 1 ? "s" : ""} copied from "${a.name}"` : b.adset_mode === "new_shared" ? `1 new ad set for all ${ads.length} ads, copied from "${a.name}"` : a.name,
      budget: cbo ? "campaign budget" : `${budgetText}${copies > 1 ? ` each (${m((each ?? 0) * copies)} a day for all ${copies})` : ""}`,
      dailyBudget: each === null ? null : each * copies,
      bid: d.bid,
      schedule: d.schedule,
      audience: d.audience,
      placements: d.placements,
      goal: d.goal,
      ads: ads.length,
      isNew: b.adset_mode !== "existing",
    });
    if (each && each > budgetWarnDaily()) warnings.push(`"${a.name}" can spend ${m(each)} a day, above the usual limit of ${m(budgetWarnDaily())}.`);
  }
  for (const c of campaigns.values()) {
    const cbo = isCbo(c);
    const daily = fromMinor(c.daily_budget, currency);
    const life = fromMinor(c.lifetime_budget, currency);
    const perDay = cbo ? dailyEquivalent(daily, life, c.stop_time, c.start_time, from) : 0;
    const lifeText = cbo && life ? lifetimeLabel(life, c.stop_time, perDay - (daily ?? 0), m) : "";
    if (lifeText) lifetimeBudgets.push(`Campaign "${c.name}": ${lifeText}`);
    campaignList.push({ id: c.id, name: c.name, status: c.status, budget: cbo ? (daily ? `${m(daily)} a day (campaign budget)` : `${lifeText} (campaign budget)`) : "set on each ad set", cbo });
    if (cbo && perDay > budgetWarnDaily()) warnings.push(`Campaign "${c.name}" can spend ${m(perDay)} a day, above the usual limit of ${m(budgetWarnDaily())}.`);
  }
  // The total: the plan engine's own count for the turn-on plan this launch makes, at the same moment,
  // so the total typed here is the plan's total when nothing changed in Meta (also with other ad sets
  // on in the campaign, a campaign budget shared by several picked ad sets, or lifetime budgets).
  const plan = await summarise(client, turnOnModel(b, targets, ads.length, goLive.mode === "at" && !Number.isNaN(onAt) ? new Date(from).toISOString() : undefined), { validate: false });
  const basis = plan.spendBasis ?? [];
  const total = spendAt(basis, from);
  if (goLive.mode !== "paused") {
    // Ad sets already on in those campaigns: they count in the total (and spend once the campaign is on).
    const picked = new Set(targets.map((t) => t.id));
    const counted = new Set(basis.filter((x) => x.kind === "adset" && !picked.has(x.id) && !x.id.startsWith("$")).map((x) => x.id));
    for (const c of campaigns.values()) {
      const cbo = isCbo(c);
      if (cbo ? c.status === "ACTIVE" : !counted.size) continue;
      for (const o of (await campaignAdSets(client, c.id)).filter((a) => a.status === "ACTIVE" && !picked.has(a.id) && (cbo || counted.has(a.id)))) {
        const od = fromMinor(o.daily_budget, currency);
        const ol = fromMinor(o.lifetime_budget, currency);
        const what = cbo ? "campaign budget" : ol && !od ? lifetimeLabel(ol, o.end_time, dailyEquivalent(null, ol, o.end_time, o.start_time, from), m) : `${m(od)} a day`;
        alsoSpends.push(`"${o.name}" in "${c.name}" (${what}) is already on${c.status === "ACTIVE" ? "" : " and starts spending when the campaign is turned on"}${cbo ? "" : ": it counts in the total"}.`);
      }
    }
  }
  if (b.adset_mode !== "existing" && launchExtras(b).length) warnings.push("New ad sets and several ad sets were both picked: each extra ad set is copied the same way as the first.");
  // The batch copy (ads with their own copy are shown in the preview, ad by ad).
  const copy = batchCopy(b);
  const checks: Check[] = [...(await accountHealth(client))];
  const pixelIds = new Set<string>();
  for (const a of rows.values()) {
    const px = a.promoted_object?.pixel_id;
    if (px) pixelIds.add(String(px));
  }
  const links = [...new Set(ads.map((ad) => adCopy(b, ad).linkUrl).filter(Boolean))];
  // Each pixel check has its own time limit: several pixels are checked together, not one after another.
  for (const list of await Promise.all([...pixelIds].map((px) => pixelCheck(client, px, links)))) checks.push(...list);
  const preset = batchPreset(b);
  const goLiveText =
    goLive.mode === "now" ? "Turned ON as soon as every ad is created." : goLive.mode === "at" && goLive.at ? `Created paused, turned ON at ${istTime(goLive.at)}.` : "Created PAUSED. Nothing spends until someone turns it on.";
  if (goLive.mode === "at" && (!goLive.at || Number.isNaN(timeMs(goLive.at)))) warnings.push("Pick the date and time to turn the ads on.");
  if (!preset.pageId) warnings.push("No Facebook Page in the settings preset.");
  return {
    account: { id: acc.meta_account_id, name, currency },
    campaign: campaignList[0] ?? null,
    campaigns: campaignList,
    adsets,
    totalDailyBudget: total,
    totalDailyLabel: m(total),
    spendAt: new Date(from).toISOString(),
    lifetimeBudgets,
    alsoSpends,
    adCount: ads.length * Math.max(1, targets.length),
    copy: { primaryTexts: copy.primaryTexts.length, headlines: copy.headlines.length, firstText: copy.primaryTexts[0] ?? "", link: copy.linkUrl, cta: copy.cta, utm: copy.utmTemplate },
    goLive: goLiveText,
    warnings,
    checks,
    spendConfirmation: goLive.mode === "paused" ? null : m(total),
  };
}
