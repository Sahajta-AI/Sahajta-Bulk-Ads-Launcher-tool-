import { db, json } from "../db";
import { HttpError } from "../httperror";
import { enqueue } from "../jobs";
import { clearAlerts } from "../alerts";
import { clientFor } from "../meta/factory";
import { MetaError, RateLimitedError, plainError } from "../meta/errors";
import { cacheDelete, cacheGet, cacheSet, getAccount } from "../store";
import { DEFAULT_COLUMNS, formulaVars, isStandardMetric, metricProblem, parseFormula, readInsights, STANDARD_METRICS, type CustomMetric, type Expr, type InsightsQuery } from "./insights";
import { accountInfo, ADSET_FIELDS, CAMPAIGN_FIELDS, describeAdSet, describeCampaign, isCbo, lookups, type AdSetRow, type CampaignRow } from "./objects";
import { allOptions, fromMinor } from "./options";
import { LIST_FIELDS, basisChanged, canon, changedFields, confirmCheck, copiesOf, defaultTitle, getPlan, indiaDate, itemsMade, itemsMaybeOn, keepNotes, madeCount, markChecked, periodMark, refKey, planProgress, planWait, sameAmount, savePlan, stepIdentity, summarise, type Op, type PlanInput, type PlanProgress, type PlanRow, type PlanSummary } from "./plan";
import { istLabel, timeMs, zonedTime } from "../time";
import { hashCustomerList } from "./audiences";
import { namingPattern } from "../service";
import { config } from "../config";

// Campaigns, ad sets, change plans and results: what the app's routes and Claude's tools call.

function account() {
  const acc = getAccount();
  if (!acc?.token_enc) throw new HttpError(409, "Meta is not connected yet. Open Settings → Meta connection and click Connect Meta.");
  return acc;
}

function metaFail(e: unknown, doing: string): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof RateLimitedError) throw new HttpError(429, e.message);
  if (e instanceof MetaError) throw new HttpError(502, plainError(e, doing));
  throw e;
}

// ---------- Campaigns and ad sets ----------

export interface TreeAdSet { id: string; name: string; status: string; effectiveStatus: string; dailyBudget: number | null; lifetimeBudget: number | null; details: Record<string, string> }
export interface TreeCampaign { id: string; name: string; status: string; effectiveStatus: string; objective: string; cbo: boolean; dailyBudget: number | null; lifetimeBudget: number | null; details: Record<string, string>; adsets: TreeAdSet[] }

/** Every campaign (not deleted) with its ad sets, budgets and settings in plain words. Cached 2 minutes. */
export async function campaignTree(refresh = false): Promise<{ currency: string; campaigns: TreeCampaign[]; fetchedAt: string }> {
  const acc = account();
  const key = `tree:${acc.id}`;
  if (!refresh) {
    const hit = cacheGet<{ currency: string; campaigns: TreeCampaign[]; fetchedAt: string }>(key);
    if (hit) return hit;
  }
  const client = clientFor(acc.id);
  try {
    const { currency } = await accountInfo(client);
    const live = ["ACTIVE", "PAUSED", "IN_PROCESS", "WITH_ISSUES", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO"];
    const [campaigns, adsets] = await Promise.all([
      client.getAll<CampaignRow>(`${client.accountId}/campaigns`, { fields: CAMPAIGN_FIELDS, effective_status: live }),
      client.getAll<AdSetRow>(`${client.accountId}/adsets`, { fields: ADSET_FIELDS, effective_status: [...live, "CAMPAIGN_PAUSED"] }, 2000),
    ]);
    const out = {
      currency,
      fetchedAt: new Date().toISOString(),
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        effectiveStatus: c.effective_status ?? c.status,
        objective: c.objective ?? "",
        cbo: isCbo(c),
        dailyBudget: fromMinor(c.daily_budget, currency),
        lifetimeBudget: fromMinor(c.lifetime_budget, currency),
        details: describeCampaign(c, currency),
        adsets: adsets
          .filter((a) => a.campaign_id === c.id)
          .map((a) => ({ id: a.id, name: a.name, status: a.status, effectiveStatus: a.effective_status ?? a.status, dailyBudget: fromMinor(a.daily_budget, currency), lifetimeBudget: fromMinor(a.lifetime_budget, currency), details: describeAdSet(a, currency) })),
      })),
    };
    cacheSet(key, out, 2 * 60_000);
    return out;
  } catch (e) {
    metaFail(e, "Reading campaigns");
  }
}

/** One campaign or ad set with every setting (raw Meta fields plus plain words). */
export async function objectDetails(kind: "campaign" | "adset", id: string) {
  const acc = account();
  const client = clientFor(acc.id);
  try {
    const { currency } = await accountInfo(client);
    if (kind === "campaign") {
      const c = await client.get<CampaignRow>(id, { fields: CAMPAIGN_FIELDS });
      return { kind, raw: c, plain: describeCampaign(c, currency), currency };
    }
    const a = await client.get<AdSetRow>(id, { fields: ADSET_FIELDS });
    return { kind, raw: a, plain: describeAdSet(a, currency), currency };
  } catch (e) {
    metaFail(e, `Reading ${kind} ${id}`);
  }
}

export async function lookup(what: string, q?: string) {
  const acc = account();
  try {
    return await lookups(clientFor(acc.id), what, q);
  } catch (e) {
    if (e instanceof Error && !(e instanceof MetaError)) throw new HttpError(400, e.message);
    metaFail(e, `Listing ${what}`);
  }
}

export const options = () => allOptions();

// ---------- Plans ----------

export interface PlanView {
  key: string;
  title: string;
  status: string;
  statusLabel: string;
  canSpend: boolean;
  runAt: string | null;
  summary: PlanSummary | null;
  input: PlanInput;
  progress: { n: number; title: string; status: string; message: string; ids: string[] }[];
  createdBy: string | null;
  source: string;
  createdAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  finishedAt: string | null;
  link: string;
  /** Running, but waiting for Meta's rate limits: until when (ISO) and why. */
  waiting: { until: string; untilLabel: string; reason: string } | null;
  /** The same times in India time words ("20 Nov 2026, 09:00 am IST"), for Claude and the pages. */
  labels: { runAt: string | null; createdAt: string; confirmedAt: string | null; finishedAt: string | null };
}

const PLAN_LABEL: Record<string, string> = {
  draft: "Waiting for your confirmation",
  queued: "Confirmed, waiting to run",
  running: "Running",
  done: "Done",
  partial: "Some steps failed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function planView(key: string): PlanView {
  const r = getPlan(key);
  const input = JSON.parse(r.ops) as PlanInput;
  const summary = json<PlanSummary | null>(r.summary, null);
  const prog = planProgress(r);
  const wait = r.status === "running" ? planWait(r.id) : null;
  return {
    key: r.key,
    title: r.title,
    status: r.status,
    statusLabel:
      r.status === "queued" && r.run_at && timeMs(r.run_at) > Date.now()
        ? `Scheduled for ${istLabel(r.run_at)}`
        : r.status === "cancelled" && prog.some((p) => p.status === "running")
          ? "Stopping now: no more items or steps run after the one it is on. What it already made or turned on stays as it is"
          : (PLAN_LABEL[r.status] ?? r.status),
    canSpend: !!r.can_spend,
    runAt: r.run_at,
    summary,
    input,
    progress: input.ops.map((_, i) => ({ n: i + 1, title: summary?.steps.find((s) => s.n === i + 1)?.title ?? input.ops[i].type, status: prog[i]?.status ?? "pending", message: prog[i]?.message ?? "", ids: prog[i]?.ids ?? [] })),
    createdBy: r.created_by,
    source: r.source,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    confirmedBy: r.confirmed_by,
    finishedAt: r.finished_at,
    link: `${config.appUrl}/plans/${r.key}`,
    labels: { runAt: r.run_at ? istLabel(r.run_at) : null, createdAt: istLabel(r.created_at), confirmedAt: r.confirmed_at ? istLabel(r.confirmed_at) : null, finishedAt: r.finished_at ? istLabel(r.finished_at) : null },
    waiting: wait ? { until: new Date(wait.until).toISOString(), untilLabel: new Date(wait.until).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase(), reason: wait.reason } : null,
  };
}

const TIME_FIELDS = ["start_time", "end_time", "stop_time"];
const NUMBER_FIELDS = ["daily_budget", "lifetime_budget", "bid_amount", "spend_cap", "min_daily_spend", "max_daily_spend", "roas_average_floor", "age_min", "age_max", "copies", "size_percent", "increase_percent", "increase_amount"];

/** Times without a zone are India time (the server runs in UTC); numbers sent as text ("1,500") are numbers. */
function tidy<T>(raw: T): T {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const k of TIME_FIELDS) if (typeof o[k] === "string") o[k] = zonedTime(o[k] as string) ?? o[k];
  for (const k of NUMBER_FIELDS) if (typeof o[k] === "string" && /^\s*-?[\d,]+(\.\d+)?\s*$/.test(o[k] as string)) o[k] = Number((o[k] as string).replace(/[,\s]/g, ""));
  // One text where a list goes ("as4") is a list of one, never split into letters.
  for (const k of LIST_FIELDS) if (typeof o[k] === "string" && (o[k] as string).trim()) o[k] = [(o[k] as string).trim()];
  // An audience's source: numbers sent as text ("30" days).
  if (o.source && typeof o.source === "object" && !Array.isArray(o.source)) {
    const src = { ...(o.source as Record<string, unknown>) };
    if (typeof src.days === "string" && /^\s*\d+\s*$/.test(src.days)) src.days = Number(src.days);
    o.source = src;
  }
  if (Array.isArray(o.budget_schedules)) {
    o.budget_schedules = o.budget_schedules.map((b) => {
      if (!b || typeof b !== "object") return b;
      const x = tidy(b as Record<string, unknown>);
      if (typeof x.start === "string") x.start = zonedTime(x.start) ?? x.start;
      if (typeof x.end === "string") x.end = zonedTime(x.end) ?? x.end;
      return x;
    });
  }
  if (Array.isArray(o.changes)) o.changes = o.changes.map((c) => tidy(c));
  return o as T;
}

function validInput(input: PlanInput, accountDbId: number): PlanInput {
  if (!input || !Array.isArray(input.ops)) throw new HttpError(400, "A plan needs ops: a list of steps.");
  const total = input.expected_daily_total as unknown;
  const expected = total === undefined || total === null || total === "" ? undefined : Number(String(total).replace(/[,\s₹]/g, ""));
  if (expected !== undefined && !(expected >= 0)) throw new HttpError(400, "expected_daily_total must be a number of rupees.");
  // Saved naming templates can be named by their name or ID (plan psx4n used "TEST – campaign naming").
  const fixName = <T extends { name_template?: string }>(o: T): T => (o && o.name_template ? { ...o, name_template: namingPattern(o.name_template, accountDbId) } : o);
  const ops = input.ops.map((raw) => {
    if (!raw || typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string") throw new HttpError(400, 'Every step needs a "type".');
    let op = tidy(fixName(raw as Op & { name_template?: string })) as Op;
    if ("changes" in op && Array.isArray(op.changes)) op = { ...op, changes: (op.changes as { name_template?: string }[]).map(fixName) } as Op;
    // Customer lists: keep only hashes, never the emails and phone numbers themselves.
    if (op.type === "create_custom_audience" && op.source?.kind === "customer_list") {
      const { skipped, ...hashed } = hashCustomerList(op.source);
      op = { ...op, source: hashed, ...(skipped ? { skipped_rows: skipped } : {}) } as Op;
    }
    return op;
  });
  const runAt = input.run_at ? zonedTime(input.run_at) ?? input.run_at : undefined;
  return { title: input.title ?? undefined, run_at: runAt, expected_daily_total: expected, ops };
}

/** Steps a stopped plan already finished: index → the IDs they made. */
function doneSteps(r: PlanRow): Map<number, string[]> {
  const m = new Map<number, string[]>();
  planProgress(r).forEach((p, i) => {
    if (p.status === "done") m.set(i, p.ids.filter(Boolean));
  });
  return m;
}

/** Notes added to a plan's summary (kept when the plan is checked again at confirmation). */
function withNotes(s: PlanSummary, notes: string[]): PlanSummary {
  if (!notes.length) return s;
  const checks = [...s.checks, ...notes.map((message) => ({ level: "warning" as const, code: "plan_note", message }))];
  return { ...s, checks, warnings: checks.filter((c) => c.level === "warning").length };
}

/** Save a plan and check it (reads Meta, writes nothing). Nothing runs until confirmPlan. */
export async function createPlan(input: PlanInput, who: string, source: "app" | "claude"): Promise<PlanView> {
  const acc = account();
  return createPlanFor(acc.id, input, who, source);
}

/** The same, for a given ad account (Undo uses the plan's own ad account, not the default one). */
async function createPlanFor(accountDbId: number, input: PlanInput, who: string, source: "app" | "claude", notes: string[] = []): Promise<PlanView> {
  const clean = validInput(input, accountDbId);
  let summary: PlanSummary;
  try {
    summary = await summarise(clientFor(accountDbId), clean, { validate: true });
  } catch (e) {
    metaFail(e, "Checking the plan");
  }
  return planView(savePlan(accountDbId, clean, withNotes(summary, notes), who, source));
}

const hasProgress = (p: PlanProgress | undefined) => !!p && (p.status !== "pending" || p.ids.some(Boolean) || !!p.attempted?.length || !!p.sub || !!p.before || !!p.finished?.length || !!p.orphans?.length);
const turnsOn = (op: Op) => (op as { status?: string }).status === "ACTIVE" || ((op as { changes?: { status?: string }[] }).changes ?? []).some((c) => c?.status === "ACTIVE");
/** Steps that make things (a changed one keeps what it made and changes it to match). */
const MAKES = new Set(["create_campaign", "create_adset", "duplicate_campaign", "duplicate_adset", "ads_from_post", "copy_ad", "create_custom_audience", "create_lookalike"]);

/**
 * The marks of a stopped step kept when it is changed: budget periods Meta already took (so they are
 * never sent twice; older marks by place become marks by period) and items already turned off. Other
 * follow-up writes run again with the new settings.
 */
function keptMarks(prev: Op | undefined, p: PlanProgress): string[] {
  const periods = (prev as { budget_schedules?: Parameters<typeof periodMark>[0][] } | undefined)?.budget_schedules ?? [];
  const out = new Set<string>();
  for (const k of p.finished ?? []) {
    const byPlace = /^schedule:(\d+)$/.exec(k);
    if (byPlace) {
      const b = periods[Number(byPlace[1])];
      if (b) out.add(periodMark(b));
    } else if (k.startsWith("schedule:") || k.startsWith("orphan:")) out.add(k);
  }
  return [...out];
}

/**
 * A budget period Meta already took stays on the campaign (the launcher can't remove one), so a changed
 * step must keep it: then it counts in what can spend, and it is not sent again.
 */
function periodsStay(i: number, prev: Op, op: Op, p: PlanProgress, kept: string[]) {
  if (prev.type !== "create_campaign" && prev.type !== "edit_campaign") return;
  const now = new Set(((op as { budget_schedules?: Parameters<typeof periodMark>[0][] }).budget_schedules ?? []).map(periodMark));
  const gone = ((prev as { budget_schedules?: Parameters<typeof periodMark>[0][] }).budget_schedules ?? []).filter((b) => kept.includes(periodMark(b)) && !now.has(periodMark(b)));
  if (!gone.length || !(p.ids.some(Boolean) || prev.type === "edit_campaign")) return;
  const say = gone.map((b) => `${istLabel(b.start)} to ${istLabel(b.end)} (${b.increase_percent !== undefined ? `+${b.increase_percent}%` : `+${b.increase_amount}`})`).join("; ");
  throw new HttpError(409, `Step ${i + 1} already added the budget period${gone.length === 1 ? "" : "s"} ${say} to the campaign before it stopped, and the launcher can't remove a budget period. Keep ${gone.length === 1 ? "it" : "them"} in step ${i + 1} as ${gone.length === 1 ? "it is" : "they are"} (not sent again), or remove ${gone.length === 1 ? "it" : "them"} in Ads Manager and make a new plan.`);
}

type Item = { id: string; kind: "campaign" | "adset" | "ad" };

/**
 * A copy step retried with fewer copies than it made: the extra copies (and the ad sets and ads made
 * inside them) leave the step, so a later step's "$ref" never uses them. Those that may be on are turned
 * off when the plan runs (orphans); the rest stay paused. Undo still turns them all off. Nothing is deleted.
 */
function dropExtraCopies(i: number, prev: Op, op: Op, p: PlanProgress): { p: PlanProgress; note: string } {
  const count = copiesOf(op as { copies?: number; changes?: unknown[] });
  const extra = p.ids.map((id, j) => ({ id, j })).filter((x) => x.id && x.j >= count);
  const copyNo = (k: string | number) => (typeof k === "number" ? k + 1 : Number(String(k).split("/")[0]));
  const dropped = (k: string | number) => (typeof k === "number" ? k >= count : /^\d+\//.test(k) && copyNo(k) > count);
  const maybeOn = new Set(itemsMaybeOn(prev, p).map((x) => x.id));
  const kind: Item["kind"] = op.type === "duplicate_campaign" ? "campaign" : "adset";
  const orphans: Item[] = [...(p.orphans ?? [])];
  const unused: Item[] = [...(p.unused ?? [])];
  for (const x of extra) (maybeOn.has(x.id) ? orphans : unused).push({ id: x.id, kind });
  const sub: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.sub ?? {})) {
    // Ad sets and ads made inside a copy are made paused.
    if (dropped(k)) unused.push({ id: v, kind: op.type === "duplicate_adset" || k.split("/").length > 2 ? "ad" : "adset" });
    else sub[k] = v;
  }
  const keep = <T,>(o: Record<string, T> | undefined) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => !dropped(/^\d+$/.test(k) ? Number(k) : k))) : o);
  const next: PlanProgress = {
    ...p,
    ids: p.ids.slice(0, count),
    sub: Object.keys(sub).length || p.sub ? sub : undefined,
    attempted: p.attempted?.filter((k) => !dropped(k)),
    attemptedAt: keep(p.attemptedAt),
    attemptedName: keep(p.attemptedName),
    ...(orphans.length ? { orphans } : {}),
    ...(unused.length ? { unused } : {}),
  };
  if (!extra.length) return { p: next, note: "" };
  const x = extra.length;
  const on = extra.filter((e) => maybeOn.has(e.id)).length;
  const what = `Step ${i + 1} now makes ${count} cop${count === 1 ? "y" : "ies"}, but it made ${x + count} before it stopped. The last ${x === 1 ? "one is" : `${x} are`} not used`;
  const then = on === 0 ? ` and ${x === 1 ? "stays" : "stay"} paused` : on === x ? ` and ${x === 1 ? "is" : "are"} turned off when the plan runs` : `: the ${on} that may be on ${on === 1 ? "is" : "are"} turned off when the plan runs, the rest stay paused`;
  return { p: next, note: `${what}${then} (nothing is deleted; "Undo this plan" turns ${x === 1 ? "it" : "them"} off too).` };
}

/**
 * An "ads from a post" or "copy an ad" step changed to other ad sets (same post or ad): its items are
 * matched by ad set, so an ad set it still uses keeps the ad already made there (never a second one), and
 * the ads in ad sets it no longer uses leave the step (turned off when they may be on). Only when every ad
 * set can be matched (a ref to a step that did not finish: null).
 */
function carryByTarget(i: number, prev: Op, op: Op, p: PlanProgress, ids: (v: string) => string[] | null): { p: PlanProgress; note: string } | null {
  const samePost = prev.type === "ads_from_post" && op.type === "ads_from_post" && prev.post_id === op.post_id && (prev.source ?? "facebook") === (op.source ?? "facebook") && prev.page_id === op.page_id && prev.instagram_user_id === op.instagram_user_id;
  const sameAd = prev.type === "copy_ad" && op.type === "copy_ad" && prev.ad === op.ad;
  if (!samePost && !sameAd) return null;
  const list = (xs: string[] | undefined) => {
    const out: string[] = [];
    for (const x of xs ?? []) {
      const got = ids(String(x));
      if (!got) return null;
      out.push(...got);
    }
    return out;
  };
  const before = p.targets ?? list((prev as { adsets?: string[] }).adsets);
  const now = list((op as { adsets?: string[] }).adsets);
  if (!before || !now) return null;
  const used = new Set<number>();
  const next: PlanProgress = { status: "pending", ids: [], message: "", gen: (p.gen ?? 0) + 1, targets: now, changed: changedFields(prev, op), ...(p.sub?.creative ? { sub: { creative: p.sub.creative } } : {}) };
  let keptN = 0;
  now.forEach((t, k) => {
    const j = before.findIndex((b, x) => b === t && !used.has(x) && (p.ids[x] || p.attempted?.includes(x)));
    if (j < 0) return;
    used.add(j);
    if (p.ids[j]) {
      next.ids[k] = p.ids[j];
      keptN++;
    } else {
      // Sent before with no answer: looked up in that ad set (by the name it was sent with) before making it.
      next.attempted = [...(next.attempted ?? []), k];
      if (p.attemptedAt?.[String(j)] !== undefined) next.attemptedAt = { ...(next.attemptedAt ?? {}), [String(k)]: p.attemptedAt[String(j)] };
      if (p.attemptedName?.[String(j)] !== undefined) next.attemptedName = { ...(next.attemptedName ?? {}), [String(k)]: p.attemptedName[String(j)] };
    }
  });
  const maybeOn = new Set(itemsMaybeOn(prev, p).map((x) => x.id));
  const left = p.ids.map((id, j) => ({ id, j })).filter((x) => x.id && !used.has(x.j));
  const orphans: Item[] = [...(p.orphans ?? []), ...left.filter((x) => maybeOn.has(x.id)).map((x) => ({ id: x.id, kind: "ad" as const }))];
  const unused: Item[] = [...(p.unused ?? []), ...left.filter((x) => !maybeOn.has(x.id)).map((x) => ({ id: x.id, kind: "ad" as const }))];
  if (orphans.length) next.orphans = orphans;
  if (unused.length) next.unused = unused;
  const on = left.filter((x) => maybeOn.has(x.id)).length;
  const parts = [
    keptN ? `keeps the ${keptN === 1 ? "ad" : `${keptN} ads`} it already made in ad sets it still uses (no second ad there)` : "",
    left.length ? `doesn't use the ${left.length === 1 ? "ad" : `${left.length} ads`} it made in ad sets it no longer uses: ${on === left.length ? `${left.length === 1 ? "it is" : "they are"} turned off when the plan runs` : on ? `the ${on} that may be on ${on === 1 ? "is" : "are"} turned off when the plan runs, the rest stay paused` : `${left.length === 1 ? "it stays" : "they stay"} paused`} (nothing is deleted)` : "",
  ].filter(Boolean);
  return { p: next, note: `Step ${i + 1} now uses other ad sets. It ${parts.join(", and ") || "makes its ads in them when the plan runs"}.` };
}

/**
 * Change a plan and check it again. A draft plan can change freely. A plan that stopped part-way
 * (partial or failed) can be fixed and retried: finished steps stay as they were and are not run
 * again; the step that stopped keeps its place; the rest runs after a new confirmation.
 * Fields left out keep their saved value (run_at, expected_daily_total, title, and ops); null or ""
 * clears them. So a new time alone is a valid change.
 */
export async function updatePlan(key: string, input?: Partial<PlanInput>): Promise<PlanView> {
  const r = getPlan(key);
  const retry = r.status === "partial" || r.status === "failed";
  if (r.status !== "draft" && !retry) throw new HttpError(409, `This plan is ${PLAN_LABEL[r.status]?.toLowerCase() ?? r.status}, so it can't change. Make a new plan instead.`);
  const old = JSON.parse(r.ops) as PlanInput;
  const progress = planProgress(r);
  const ran = old.ops.some((_, i) => hasProgress(progress[i]));
  const given = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(given, k);
  const value = <T,>(k: string): T | undefined => (given[k] === null || given[k] === "" ? undefined : (given[k] as T));
  const merged: PlanInput = {
    title: has("title") ? value<string>("title") : old.title,
    run_at: has("run_at") ? value<string>("run_at") : old.run_at,
    expected_daily_total: has("expected_daily_total") ? value<number>("expected_daily_total") : old.expected_daily_total,
    ops: Array.isArray(given.ops) ? (given.ops as Op[]) : old.ops,
  };
  // A time that has passed, or one for a plan that already ran part-way, doesn't carry over to the retry.
  if (!has("run_at") && merged.run_at && (ran || !(timeMs(zonedTime(merged.run_at) ?? merged.run_at) > Date.now()))) merged.run_at = undefined;
  const clean = validInput(merged, r.ad_account_id);
  if (old.name_date) clean.name_date = old.name_date;
  // Steps that already ran stay protected, also after the plan went back to draft for a retry.
  // Compared field by field, so the same step sent back with its fields in another order is the same.
  const done = doneSteps(r);
  for (const i of done.keys()) {
    if (!clean.ops[i] || canon(clean.ops[i]) !== canon(old.ops[i])) throw new HttpError(409, `Step ${i + 1} already ran, so it can't change or move. Keep the finished steps as they were, in the same places, and change the steps after them.`);
  }
  // The step that stopped keeps its place: what it made (or may have made) is matched by its place.
  const s = old.ops.findIndex((_, i) => progress[i]?.status !== "done");
  if (s >= 0 && hasProgress(progress[s])) {
    const same = (op?: Op) => !!op && (canon(op) === canon(old.ops[s]) || stepIdentity(op) === stepIdentity(old.ops[s]));
    if (!same(clean.ops[s]) && clean.ops.some((op, i) => i > s && same(op))) {
      const n = madeCount(old.ops[s], progress[s]);
      throw new HttpError(409, `Step ${s + 1} stopped part-way${n ? ` after it made or changed ${n} item${n === 1 ? "" : "s"}` : ""}, so it keeps its place (what it made is reused when it runs again). Add new steps after step ${s + 1}, not before it, and don't move or remove it.`);
    }
    // Taken out (no step in its place, or the steps after it moved up): what it made, changed or turned
    // on would drop out of the plan, and Undo could no longer put it back.
    const p = progress[s];
    const removed = !clean.ops[s] || old.ops.some((o, i) => i > s && canon(o) === canon(clean.ops[s]));
    const op0 = old.ops[s];
    // A turn-on or turn-off step changed only what was not already so; an answer lost may have made something.
    const changedN = op0.type === "set_status" ? Object.values(p.before ?? {}).filter((b) => b.status !== op0.status).length : madeCount(op0, p);
    const touched = changedN + (p.orphans?.length ?? 0) + (p.unused?.length ?? 0) + (p.attempted?.length ?? 0);
    if (removed && touched) {
      throw new HttpError(409, `Step ${s + 1} stopped part-way after it made, changed or turned on something in Meta, so it can't be taken out: the plan keeps it so "Undo this plan" can put those back. Keep step ${s + 1} (you can change it), or press "Undo this plan".`);
    }
  }
  const notes: string[] = [];
  // The ad sets an ads step names, as IDs, for matching its items by ad set: an ID; a finished step's ref;
  // a name as the last check found it for this step (else the name itself, which then matches nothing).
  const oldNames = json<PlanSummary | null>(r.summary, null)?.names ?? {};
  const targetIds = (step: number) => (v: string): string[] | null => {
    const t = v.trim();
    const m = /^\$([A-Za-z0-9_-]+)(?:\.(\d+))?$/.exec(t);
    if (!m) return [oldNames[`${step}|adset|${t.toLowerCase()}`] ?? t];
    const i = old.ops.findIndex((o, k) => refKey((o as { ref?: string }).ref, k + 1) === m[1]);
    const ids = i >= 0 && done.has(i) ? done.get(i)! : null;
    if (!ids) return null;
    return m[2] === undefined ? ids : ids[Number(m[2]) - 1] ? [ids[Number(m[2]) - 1]] : null;
  };
  // Keep finished steps; a stopped step that still works on the same things keeps what it made, and the
  // run sends it the changed settings (PlanProgress.changed).
  const nextProgress = clean.ops.map((op, i): PlanProgress => {
    const p = progress[i];
    const fresh: PlanProgress = { status: "pending", ids: [], message: "" };
    if (!p) return fresh;
    if (done.has(i)) return p;
    const prev = old.ops[i];
    if (prev && canon(op) === canon(prev)) return { ...p, status: "pending", message: "" };
    const kept = keptMarks(prev, p);
    if (prev && stepIdentity(op) === stepIdentity(prev)) {
      periodsStay(i, prev, op, p, kept);
      const changedNow = changedFields(prev, op);
      const changed = [...new Set([...(p.changed ?? []), ...changedNow])].sort();
      let next: PlanProgress = { ...p, status: "pending", message: "", finished: kept, changed };
      // Fewer copies than it already made: the extra copies are not used (turned off if they may be on).
      let dropNote = "";
      if (op.type === "duplicate_campaign" || op.type === "duplicate_adset") ({ p: next, note: dropNote } = dropExtraCopies(i, prev, op, next));
      const n = madeCount(prev, next);
      const fields = changedNow.filter((k) => k !== "copies" && k !== "ref").map((k) => k.replace(/_/g, " "));
      if (n && MAKES.has(op.type)) notes.push(`Step ${i + 1} keeps the ${n} item${n === 1 ? "" : "s"} it made before it stopped${fields.length ? ` and changes ${n === 1 ? "it" : "them"} to match the new settings when the plan runs (${fields.join(", ")})` : ""}.`);
      if (dropNote) notes.push(dropNote);
      return next;
    }
    // An ads step that now uses other ad sets (same post or ad): the ads it made in ad sets it still
    // uses are kept (never a second ad there); those in ad sets it no longer uses are not used.
    const carried = prev ? carryByTarget(i, prev, op, p, targetIds(i + 1)) : null;
    if (carried) {
      notes.push(carried.note);
      return { ...carried.p, ...(kept.some((k) => k.startsWith("orphan:")) ? { finished: kept.filter((k) => k.startsWith("orphan:")) } : {}) };
    }
    // Works on something else: what the step made is not reused. Items it made or turned on that may be
    // ON are turned off first when the plan runs; the rest stay paused (and Undo still turns them off);
    // undo memory of a step of the same kind is kept.
    const n = prev ? madeCount(prev, p) : 0;
    const maybeOn = prev ? itemsMaybeOn(prev, p) : [];
    const made = prev ? itemsMade(prev, p).filter((x) => !maybeOn.some((o) => o.id === x.id)) : [];
    const edits = prev && (prev.type === "edit_campaign" || prev.type === "edit_adset" || prev.type === "edit_ad");
    if (n && prev) {
      const off = maybeOn.length;
      const it = n === 1 ? "it" : "they";
      const isAre = (k: number) => (k === 1 ? "is" : "are");
      notes.push(`Step ${i + 1} now works on something else. ${
        edits ? `The ${n} item${n === 1 ? "" : "s"} it changed before it stopped keep${n === 1 ? "s" : ""} those changes${p.before && prev.type === op.type ? ' ("Undo this plan" can still put them back)' : ""}.`
        : prev.type === "create_custom_audience" || prev.type === "create_lookalike" ? `The ${n} audience${n === 1 ? "" : "s"} it made before it stopped ${n === 1 ? "stays" : "stay"} in Meta (an audience spends nothing; remove it in Ads Manager if not needed).`
        : prev.type === "set_status" ? (off ? `The ${off} item${off === 1 ? "" : "s"} it turned on before it stopped ${isAre(off)} turned off when the plan runs${off < n ? "; what was already on stays on" : ""}.` : `The ${n} item${n === 1 ? "" : "s"} it ${prev.status === "ACTIVE" ? "worked on" : "turned off"} before it stopped ${n === 1 ? "stays" : "stay"} as ${it} ${isAre(n)}.`)
        : off ? `The ${n} item${n === 1 ? "" : "s"} it made before it stopped ${isAre(n)} not reused; ${off === n ? `${it} ${isAre(n)}` : `the ${off} that may be on ${isAre(off)}`} turned off when the plan runs${off < n ? ", the rest stay paused" : ""} (nothing is deleted).`
        : `The ${n} item${n === 1 ? "" : "s"} it made before it stopped ${isAre(n)} not reused and ${n === 1 ? "stays" : "stay"} paused (nothing is deleted).`
      }`);
    }
    const periods = Object.values(p.periods ?? {});
    if (periods.length && prev) notes.push(`Step ${i + 1} added ${periods.length} budget period${periods.length === 1 ? "" : "s"} to campaign ${[...new Set(periods.map((x) => x.campaign))].join(", ")} before it stopped. ${periods.length === 1 ? "It stays" : "They stay"} on that campaign (the launcher can't remove a budget period); remove ${periods.length === 1 ? "it" : "them"} in Ads Manager if not needed.`);
    if (p.before && prev && prev.type !== op.type && !(prev.type === "set_status" && prev.status === "ACTIVE")) notes.push(`Step ${i + 1} changed ${Object.keys(p.before).length} item${Object.keys(p.before).length === 1 ? "" : "s"} before it stopped (${Object.keys(p.before).slice(0, 5).join(", ")}); "Undo this plan" can't put ${Object.keys(p.before).length === 1 ? "it" : "them"} back now that the step is of another kind. Change ${Object.keys(p.before).length === 1 ? "it" : "them"} back in Ads Manager if needed.`);
    const orphans = [...(p.orphans ?? []), ...maybeOn];
    const unused = [...(p.unused ?? []), ...made];
    return {
      ...fresh,
      gen: (p.gen ?? 0) + 1,
      ...(p.before && prev?.type === op.type ? { before: p.before } : {}),
      ...(orphans.length ? { orphans } : {}),
      ...(unused.length ? { unused } : {}),
      ...(kept.some((k) => k.startsWith("orphan:")) ? { finished: kept.filter((k) => k.startsWith("orphan:")) } : {}),
    };
  });
  let summary: PlanSummary;
  try {
    summary = await summarise(clientFor(r.ad_account_id), clean, { validate: true, done, progress: nextProgress });
  } catch (e) {
    metaFail(e, "Checking the plan");
  }
  summary = withNotes(summary, notes);
  const title = clean.title?.trim() || (has("title") ? defaultTitle(clean) : r.title);
  db().prepare("UPDATE plans SET ops = ?, summary = ?, can_spend = ?, run_at = ?, title = ?, progress = ?, status = 'draft', finished_at = NULL, confirmed_at = NULL, confirmed_by = NULL WHERE id = ?")
    .run(JSON.stringify(clean), JSON.stringify(summary), summary.canSpend ? 1 : 0, clean.run_at ?? null, title, JSON.stringify(nextProgress), r.id);
  return planView(key);
}

/** The explicit yes. A plan that can spend money also needs the daily amount that can spend typed back. */
export async function confirmPlan(key: string, opts: { confirm?: boolean; acceptWarnings?: boolean; spendConfirmation?: string }, who: string): Promise<PlanView> {
  let r = getPlan(key);
  // When this confirmation's check started: a plan or launch of the same ad account that ran after it
  // makes the run check the plan again (runPlan).
  const checkedAt = Date.now();
  // Check again right before running: budgets or statuses may have changed in Ads Manager since.
  if (r.status === "draft" && opts.confirm === true) {
    const input = JSON.parse(r.ops) as PlanInput;
    // {date} in names stands for the day the plan was first confirmed (a retry on another day reuses the names).
    if (!input.name_date) {
      input.name_date = indiaDate();
      db().prepare("UPDATE plans SET ops = ? WHERE id = ?").run(JSON.stringify(input), r.id);
    }
    try {
      const old = json<PlanSummary | null>(r.summary, null);
      const fresh = keepNotes(await summarise(clientFor(r.ad_account_id), input, { validate: false, done: doneSteps(r), progress: planProgress(r) }), old);
      db().prepare("UPDATE plans SET summary = ?, can_spend = ? WHERE id = ?").run(JSON.stringify(fresh), fresh.canSpend ? 1 : 0, r.id);
      if (old && fresh.canSpend) {
        const sameTotal = sameAmount(old.spendConfirmation ?? "", fresh.spendConfirmation ?? "");
        if (!old.canSpend || !old.spendConfirmation) {
          throw new HttpError(409, `Something changed in Meta since the plan was checked, so it now turns things on: ${fresh.spendConfirmation} a day can spend. Read the summary again and confirm with this total.`);
        }
        // Budgets, times and what is ON are compared (all of them: the person types the total again); the
        // total alone also moves when a day passes and a lifetime budget has fewer days left (nothing
        // changed in Meta then: the message says so).
        if (basisChanged(old, fresh)) {
          throw new HttpError(
            409,
            sameTotal
              ? `Budgets or what is on changed in Meta since the plan was checked (what can spend is still ${fresh.spendConfirmation} a day). Read the summary again and confirm.`
              : `Budgets changed in Meta since the plan was checked: what can spend is now ${fresh.spendConfirmation} a day (it was ${old.spendConfirmation}). Read the summary again and confirm with the new total.`,
          );
        }
        if (!sameTotal) {
          throw new HttpError(409, `Nothing changed in Meta, but fewer days are left for the lifetime budgets than when the plan was checked, so they now count as ${fresh.spendConfirmation} a day (it was ${old.spendConfirmation}). Read the summary again and confirm with the new total.`);
        }
      }
    } catch (e) {
      metaFail(e, "Checking the plan again");
    }
    r = getPlan(key);
  }
  confirmCheck(r, opts);
  const planId = r.id;
  const runAt = r.run_at;
  // "Confirmed, waiting to run" and the job that runs it are saved together: a busy database can't leave
  // a queued plan that nothing ever runs.
  const won = db()
    .transaction((): boolean => {
      if (!db().prepare("UPDATE plans SET status = 'queued', confirmed_at = datetime('now'), confirmed_by = ? WHERE id = ? AND status = 'draft'").run(who, planId).changes) return false;
      // Just checked: a run that starts within a few minutes doesn't check it again (one that waits longer
      // does, and so does one after another plan or launch of this ad account ran).
      markChecked(planId, getPlan(key).confirmed_at, checkedAt);
      enqueue("plan", planId, runAt ? Math.max(Date.now(), timeMs(runAt) || 0) : Date.now());
      return true;
    })
    .immediate();
  if (!won) throw new HttpError(409, "This plan was confirmed already.");
  cacheDelete("tree:");
  cacheDelete("dest:");
  return planView(key);
}

/**
 * "Undo this plan": a new plan (checked, waiting for confirmation like any other) that puts back
 * what the plan changed (only the fields each step changed: names, budgets, bids, times, audiences,
 * creatives and statuses) and turns off everything it made. Nothing is deleted. What can't be put back
 * (an end time or spend limit added where there was none, a goal or attribution change) is said in
 * the undo plan's summary.
 */
export async function undoPlan(key: string, who: string, source: "app" | "claude"): Promise<PlanView> {
  const r = getPlan(key);
  if (!["done", "partial", "failed", "cancelled"].includes(r.status)) throw new HttpError(409, "Only a plan that has run can be undone.");
  const input = JSON.parse(r.ops) as PlanInput;
  const progress = planProgress(r);
  const client = clientFor(r.ad_account_id);
  let currency: string;
  try {
    ({ currency } = await accountInfo(client));
  } catch (e) {
    metaFail(e, "Reading the ad account");
  }
  const rupees = (v: unknown) => (v === undefined || v === null || v === "" || Number(v) === 0 ? undefined : fromMinor(v as string, currency) ?? undefined);
  const ops: Op[] = [];
  const offCampaigns: string[] = [];
  const offAdsets: string[] = [];
  const offAds: string[] = [];
  const statusBack = new Map<"ACTIVE" | "PAUSED", { campaigns: string[]; adsets: string[]; ads: string[] }>();
  const notes: string[] = [];
  for (let i = input.ops.length - 1; i >= 0; i--) {
    const op = input.ops[i];
    const p = progress[i];
    if (!p || (!p.ids.length && !p.sub && !p.before && !p.orphans?.length && !p.unused?.length)) continue;
    // Items earlier versions of a changed step made and no longer use: turned off too.
    for (const x of [...(p.orphans ?? []), ...(p.unused ?? [])]) (x.kind === "campaign" ? offCampaigns : x.kind === "adset" ? offAdsets : offAds).push(x.id);
    const subs = Object.entries(p.sub ?? {}).filter(([k]) => !k.startsWith("users_") && k !== "creative");
    switch (op.type) {
      case "create_campaign":
      case "duplicate_campaign":
        offCampaigns.push(...p.ids.filter(Boolean));
        for (const [k, v] of subs) (k.split("/").length > 2 ? offAds : offAdsets).push(v);
        break;
      case "create_adset":
      case "duplicate_adset":
        offAdsets.push(...p.ids.filter(Boolean));
        offAds.push(...subs.map(([, v]) => v));
        break;
      case "ads_from_post":
      case "copy_ad":
        offAds.push(...p.ids.filter(Boolean));
        break;
      case "create_custom_audience":
      case "create_lookalike":
        if (p.ids.filter(Boolean).length) {
          const made = p.ids.filter(Boolean);
          const name = (op as { name?: string }).name?.trim();
          notes.push(`${name ? `Audience "${name}"` : "Audience"} (ID ${made.join(", ")}) stays: it spends nothing; remove it in Ads Manager if not needed.`);
        }
        break;
      default:
        break;
    }
    for (const [id, b] of Object.entries(p.before ?? {})) {
      const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
      const step = `Step ${i + 1} of plan ${key}`;
      for (const x of (b.not_restorable as string[] | undefined) ?? []) notes.push(`${step} also changed the ${x} of ${id}; that is not put back here. Change it in Ads Manager if needed.`);
      if (op.type === "edit_campaign") {
        const e: Record<string, unknown> = { type: "edit_campaign", campaign: id };
        if (has("name") && b.name) e.name = b.name;
        if (has("daily_budget") && rupees(b.daily_budget)) e.daily_budget = rupees(b.daily_budget);
        if (has("lifetime_budget") && rupees(b.lifetime_budget)) e.lifetime_budget = rupees(b.lifetime_budget);
        if (has("bid_strategy") && b.bid_strategy) e.bid_strategy = b.bid_strategy;
        if (has("spend_cap")) {
          if (rupees(b.spend_cap)) e.spend_cap = rupees(b.spend_cap);
          else notes.push(`${step} added a spend limit to campaign ${id}, which had none; the launcher can't remove a spend limit. Remove it in Ads Manager if needed.`);
        }
        if (has("start_time") && b.start_time) e.start_time = b.start_time;
        if (has("stop_time")) {
          if (b.stop_time) e.stop_time = b.stop_time;
          else notes.push(`${step} added an end time to campaign ${id}, which had none; the launcher can't remove an end time. Remove it in Ads Manager if needed.`);
        }
        if (has("status") && (b.status === "ACTIVE" || b.status === "PAUSED")) e.status = b.status;
        if (Object.keys(e).length > 2) ops.push(e as Op);
      } else if (op.type === "edit_adset") {
        const e: Record<string, unknown> = { type: "edit_adset", adset: id };
        if (has("name") && b.name) e.name = b.name;
        if (has("daily_budget") && rupees(b.daily_budget)) e.daily_budget = rupees(b.daily_budget);
        if (has("lifetime_budget") && rupees(b.lifetime_budget)) e.lifetime_budget = rupees(b.lifetime_budget);
        if (has("bid_strategy") && b.bid_strategy) e.bid_strategy = b.bid_strategy;
        if (has("bid_amount") && rupees(b.bid_amount)) e.bid_amount = rupees(b.bid_amount);
        if (has("start_time") && b.start_time) e.start_time = b.start_time;
        if (has("end_time")) {
          if (b.end_time) e.end_time = b.end_time;
          else notes.push(`${step} added an end time to ad set ${id}, which had none; the launcher can't remove an end time. Remove it in Ads Manager if needed.`);
        }
        if (has("targeting") && b.targeting) e.replace_targeting = b.targeting;
        if (has("status") && (b.status === "ACTIVE" || b.status === "PAUSED")) e.status = b.status;
        if (Object.keys(e).length > 2) ops.push(e as Op);
      } else if (op.type === "edit_ad") {
        const e: Record<string, unknown> = { type: "edit_ad", ad: id };
        if (has("name") && b.name) e.name = b.name;
        if (has("creative_id") && b.creative_id) e.creative_id = b.creative_id;
        if (has("status") && (b.status === "ACTIVE" || b.status === "PAUSED")) e.status = b.status;
        if (Object.keys(e).length > 2) ops.push(e as Op);
      } else if (op.type === "set_status" && b.status && b.status !== op.status && (b.status === "ACTIVE" || b.status === "PAUSED")) {
        // One step per status for everything (not one step per item: a go-live of 300 ads is one undo step).
        const g = statusBack.get(b.status) ?? { campaigns: [], adsets: [], ads: [] };
        (b.kind === "campaign" ? g.campaigns : b.kind === "adset" ? g.adsets : g.ads).push(id);
        statusBack.set(b.status, g);
      }
    }
  }
  // Things the plan turned on that were off before go off in the same step as what it made (one turn-off step).
  const backOff = statusBack.get("PAUSED");
  if (backOff) {
    offCampaigns.push(...backOff.campaigns);
    offAdsets.push(...backOff.adsets);
    offAds.push(...backOff.ads);
    statusBack.delete("PAUSED");
  }
  for (const [status, g] of statusBack) {
    const step: Record<string, unknown> = { type: "set_status", status };
    if (g.campaigns.length) step.campaigns = [...new Set(g.campaigns)];
    if (g.adsets.length) step.adsets = [...new Set(g.adsets)];
    if (g.ads.length) step.ads = [...new Set(g.ads)];
    ops.push(step as Op);
  }
  const off: Op[] = [];
  if (offCampaigns.length || offAdsets.length || offAds.length) {
    const step: Record<string, unknown> = { type: "set_status", status: "PAUSED" };
    if (offCampaigns.length) step.campaigns = [...new Set(offCampaigns)];
    if (offAdsets.length) step.adsets = [...new Set(offAdsets)];
    if (offAds.length) step.ads = [...new Set(offAds)];
    off.push(step as Op);
  }
  const all = [...off, ...ops];
  if (!all.length) throw new HttpError(409, `Plan ${key} changed nothing that can be put back.${notes.length ? ` ${notes.join(" ")}` : ""}`);
  // The notes are the undo plan's warnings (shown with its summary), not part of its title.
  const view = await createPlanFor(r.ad_account_id, { title: `Undo plan ${key}`, ops: all }, who, source, notes);
  return planView(view.key);
}

export function cancelPlan(key: string): PlanView {
  const r = getPlan(key);
  if (!["draft", "queued", "running"].includes(r.status)) throw new HttpError(409, `This plan is already ${PLAN_LABEL[r.status]?.toLowerCase() ?? r.status}.`);
  db().prepare("UPDATE plans SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?").run(r.id);
  db().prepare("UPDATE jobs SET status = 'done', last_error = 'cancelled' WHERE kind = 'plan' AND batch_id = ? AND status = 'queued'").run(r.id);
  // The home page's alerts about this plan (a turn-on waiting for a yes, a stop) are answered now.
  clearAlerts(`/plans/${key}`, ["golive", "stopped"]);
  return planView(key);
}

export function listPlans(limit = 30) {
  const rows = db().prepare("SELECT * FROM plans ORDER BY id DESC LIMIT ?").all(limit) as PlanRow[];
  return rows.map((r) => {
    const s = json<PlanSummary | null>(r.summary, null);
    return { key: r.key, title: r.title, status: r.status, statusLabel: PLAN_LABEL[r.status] ?? r.status, canSpend: !!r.can_spend, runAt: r.run_at, runAtLabel: r.run_at ? istLabel(r.run_at) : null, createdAt: r.created_at, createdAtLabel: istLabel(r.created_at), createdBy: r.created_by, source: r.source, dailyBudget: s?.totals.dailyBudget ?? 0, steps: (JSON.parse(r.ops) as PlanInput).ops.length };
  });
}

// ---------- Results ----------

export function customMetrics(): (CustomMetric & { id: number; description: string })[] {
  const acc = account();
  return db().prepare("SELECT id, name, formula, format, description FROM custom_metrics WHERE ad_account_id = ? ORDER BY name").all(acc.id) as (CustomMetric & { id: number; description: string })[];
}

/** A formula written back after a name in it changed. Names that aren't plain words go in [brackets]. */
function formulaText(e: Expr): string {
  const side = (x: Expr) => (x.k === "bin" ? `(${formulaText(x)})` : formulaText(x));
  if (e.k === "num") return String(e.v);
  if (e.k === "var") return /^[A-Za-z_][\w.:]*$/.test(e.v) ? e.v : `[${e.v}]`;
  if (e.k === "neg") return `-${side(e.a)}`;
  return `${side(e.a)} ${e.op} ${side(e.b)}`;
}

function renameIn(e: Expr, from: string, to: string): Expr {
  if (e.k === "var") return e.v.toLowerCase() === from.toLowerCase() ? { k: "var", v: to } : e;
  if (e.k === "neg") return { k: "neg", a: renameIn(e.a, from, to) };
  if (e.k === "bin") return { ...e, a: renameIn(e.a, from, to), b: renameIn(e.b, from, to) };
  return e;
}

const usesName = (formula: string, name: string) => {
  try {
    return [...formulaVars(parseFormula(formula))].some((v) => v.toLowerCase() === name.toLowerCase());
  } catch {
    return false;
  }
};

export function saveCustomMetric(m: { id?: number; name: string; formula: string; format?: string; description?: string }) {
  const acc = account();
  if (!m.name?.trim() || !m.formula?.trim()) throw new HttpError(400, "A custom metric needs a name and a formula, e.g. spend / actions:lead.");
  const name = m.name.trim();
  const formula = m.formula.trim();
  if (/[+\-*/()[\]"']/.test(name)) throw new HttpError(400, "Leave + - * / brackets and quotes out of the metric's name.");
  if (isStandardMetric(name) || STANDARD_METRICS.some((x) => x.key.toLowerCase() === name.toLowerCase())) throw new HttpError(400, `"${name}" is already the name of a standard metric. Pick another name.`);
  try {
    parseFormula(formula);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const all = customMetrics();
  const prev = m.id ? all.find((x) => x.id === Number(m.id)) : undefined;
  if (m.id && !prev) throw new HttpError(404, `No custom metric with id ${m.id}.`);
  const others = all.filter((x) => x.id !== prev?.id);
  if (others.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `A custom metric called "${name}" already exists. Pick another name, or edit that one.`);
  // Every name in the formula must work out: a standard metric, actions:/cost:<type>, or another custom metric (no loops).
  const problem = metricProblem(name, [...others, { name, formula, format: m.format ?? "number" }]);
  if (problem) throw new HttpError(400, `${problem} Use list_metrics to see the names (counts are actions:<type>, costs cost:<type>).`);
  const fmt = ["number", "money", "percent"].includes(m.format ?? "") ? m.format! : "number";
  return db().transaction(() => {
    if (prev) {
      db().prepare("UPDATE custom_metrics SET name=?, formula=?, format=?, description=? WHERE id=? AND ad_account_id=?").run(name, formula, fmt, m.description ?? prev.description ?? "", prev.id, acc.id);
      // A new name: column sets and other formulas that use the old name follow it.
      if (prev.name.toLowerCase() !== name.toLowerCase() || prev.name !== name) {
        for (const o of others) {
          if (!usesName(o.formula, prev.name)) continue;
          db().prepare("UPDATE custom_metrics SET formula = ? WHERE id = ?").run(formulaText(renameIn(parseFormula(o.formula), prev.name, name)), o.id);
        }
        for (const c of columnSets().filter((x) => x.id)) {
          if (!c.metrics.some((x) => x.toLowerCase() === prev.name.toLowerCase())) continue;
          db().prepare("UPDATE column_sets SET metrics = ? WHERE id = ?").run(JSON.stringify(c.metrics.map((x) => (x.toLowerCase() === prev.name.toLowerCase() ? name : x))), c.id);
        }
      }
      return prev.id;
    }
    return Number(db().prepare("INSERT INTO custom_metrics (ad_account_id, name, formula, format, description) VALUES (?,?,?,?,?)").run(acc.id, name, formula, fmt, m.description ?? "").lastInsertRowid);
  })();
}

export function columnSets(): { id: number; name: string; metrics: string[]; isDefault: boolean }[] {
  const acc = account();
  const rows = db().prepare("SELECT id, name, metrics, is_default FROM column_sets WHERE ad_account_id = ? ORDER BY is_default DESC, name").all(acc.id) as { id: number; name: string; metrics: string; is_default: number }[];
  const out = rows.map((r) => ({ id: r.id, name: r.name, metrics: JSON.parse(r.metrics) as string[], isDefault: !!r.is_default }));
  if (!out.length) out.push({ id: 0, name: "Standard", metrics: DEFAULT_COLUMNS, isDefault: true });
  return out;
}

export function saveColumnSet(c: { id?: number; name: string; metrics: string[]; isDefault?: boolean }) {
  const acc = account();
  if (!c.name?.trim()) throw new HttpError(400, "Give the column set a name.");
  if (!Array.isArray(c.metrics) || !c.metrics.length) throw new HttpError(400, "Pick at least one metric.");
  const custom = customMetrics();
  const bad = c.metrics.map((x) => metricProblem(String(x), custom)).filter((x): x is string => !!x);
  if (bad.length) throw new HttpError(400, `${bad.join(" ")} Use list_metrics to see the names (counts are actions:<type>, costs cost:<type>), or create it as a custom metric.`);
  if (c.id && !db().prepare("SELECT 1 FROM column_sets WHERE id = ? AND ad_account_id = ?").get(Number(c.id), acc.id)) throw new HttpError(404, `No column set with id ${c.id}.`);
  return db().transaction(() => {
    if (c.isDefault) db().prepare("UPDATE column_sets SET is_default = 0 WHERE ad_account_id = ?").run(acc.id);
    if (c.id) {
      db().prepare("UPDATE column_sets SET name=?, metrics=?, is_default=COALESCE(?, is_default) WHERE id=? AND ad_account_id=?").run(c.name.trim(), JSON.stringify(c.metrics), c.isDefault === undefined ? null : c.isDefault ? 1 : 0, c.id, acc.id);
      return c.id;
    }
    return Number(db().prepare("INSERT INTO column_sets (ad_account_id, name, metrics, is_default) VALUES (?,?,?,?)").run(acc.id, c.name.trim(), JSON.stringify(c.metrics), c.isDefault ? 1 : 0).lastInsertRowid);
  })();
}

/**
 * Remove a saved column set or custom metric (launcher settings only; nothing in Meta). A custom metric
 * that another formula uses is refused (that formula would stop working); one that column sets use is
 * taken out of those sets, which are named in the answer.
 */
export function deleteResultsItem(kind: "column_set" | "custom_metric", id: number): { removedFrom: string[] } {
  const acc = account();
  if (kind === "column_set") {
    const r = db().prepare("DELETE FROM column_sets WHERE id = ? AND ad_account_id = ?").run(id, acc.id);
    if (!r.changes) throw new HttpError(404, `No column set with id ${id}.`);
    return { removedFrom: [] };
  }
  const all = customMetrics();
  const metric = all.find((x) => x.id === Number(id));
  if (!metric) throw new HttpError(404, `No custom metric with id ${id}.`);
  const usedBy = all.filter((x) => x.id !== metric.id && usesName(x.formula, metric.name));
  if (usedBy.length) throw new HttpError(409, `"${metric.name}" is used in the formula of ${usedBy.map((x) => `"${x.name}"`).join(", ")}. Change ${usedBy.length === 1 ? "that formula" : "those formulas"} first, then remove it.`);
  const sets = columnSets().filter((c) => c.id && c.metrics.some((x) => x.toLowerCase() === metric.name.toLowerCase()));
  const emptied = sets.filter((c) => c.metrics.every((x) => x.toLowerCase() === metric.name.toLowerCase()));
  if (emptied.length) throw new HttpError(409, `"${metric.name}" is the only column of the column set ${emptied.map((c) => `"${c.name}"`).join(", ")}. Add another column there (or remove that column set) first.`);
  db().transaction(() => {
    for (const c of sets) db().prepare("UPDATE column_sets SET metrics = ? WHERE id = ?").run(JSON.stringify(c.metrics.filter((x) => x.toLowerCase() !== metric.name.toLowerCase())), c.id);
    db().prepare("DELETE FROM custom_metrics WHERE id = ? AND ad_account_id = ?").run(metric.id, acc.id);
  })();
  return { removedFrom: sets.map((c) => c.name) };
}

export async function results(q: InsightsQuery & { column_set?: string }) {
  const acc = account();
  let metrics = q.metrics;
  const fromSet = !q.metrics?.length;
  if (!metrics?.length && q.column_set) {
    const set = columnSets().find((s) => s.name.toLowerCase() === q.column_set!.toLowerCase() || String(s.id) === String(q.column_set));
    if (!set) throw new HttpError(400, `No column set called "${q.column_set}". Column sets: ${columnSets().map((s) => `"${s.name}"`).join(", ")}.`);
    metrics = set.metrics;
  }
  if (!metrics?.length) metrics = columnSets().find((s) => s.isDefault)?.metrics;
  try {
    const client = clientFor(acc.id);
    const { currency, timezone } = await accountInfo(client);
    // A saved column set leaves out a column whose name no longer works (with a note); names typed in the query are refused.
    return { currency, ...(await readInsights(client, { ...q, metrics }, customMetrics(), { timezone, dropUnknown: fromSet })) };
  } catch (e) {
    if (e instanceof Error && !(e instanceof MetaError) && !(e instanceof HttpError)) throw new HttpError(400, e.message);
    metaFail(e, "Reading results");
  }
}

export function metricsCatalog() {
  return { standard: STANDARD_METRICS, custom: customMetrics(), columnSets: columnSets(), note: "Any Meta action works as actions:<action_type> (count) or cost:<action_type> (cost per action), e.g. actions:offsite_conversion.fb_pixel_custom." };
}
