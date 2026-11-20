import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { istLabel } from "../lib/time";
import { ATTRIBUTION, BID_STRATEGIES, BILLING_EVENTS, DESTINATIONS, GOALS, OBJECTIVES, PIXEL_EVENTS, PLACEMENT_PLATFORMS, SPECIAL_AD_CATEGORIES } from "../lib/manage/options";
import { CTA_TYPES } from "../lib/manage/cta";
import type { Op } from "../lib/manage/plan";
import type { AudienceSource } from "../lib/manage/audiences";
import type { AdSetSpec, CampaignSpec } from "../lib/manage/objects";
import type { AdEditSpec } from "../lib/manage/ads";
import type { LauncherApi } from "./tools";

// Claude tools for everything beyond "launch a folder of creatives": the connection, templates
// and presets, per-ad copy, batch control, campaigns and ad sets (through change plans), and results.
// Every change in Meta goes through a plan: plan_changes shows the summary, confirm_plan runs it
// only after the person's explicit yes. Nothing can be deleted or archived.
// Times are shown in India time words (istLabel); times given without a zone are India time.

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true });
const run = (f: () => Promise<string>) => f().then(text).catch(fail);

/** Most rows of a list or table shown to Claude; the rest are in the app (its link is in the answer). */
const MAX_ROWS = 30;

/** How many alerts the launcher sends at most (the newest). */
const ALERTS_SHOWN = 10;

/** Text inside a markdown table cell: a "|" in a name would shift every column after it. */
export const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s*\n\s*/g, " ");

/**
 * A refusal that asks for the typed total, for a fresh look at changed budgets, or for new warnings
 * to be accepted. The server's words are written for the person on the web page ("confirm by typing
 * ₹500"); Claude would read them as an order and send the amount itself. So the answer says plainly
 * that the person decides. `summaryTool` is where Claude shows the person the summary again.
 */
export function forThePerson(e: unknown, summaryTool: string): Error {
  const msg = e instanceof Error ? e.message : String(e);
  const extra: string[] = [];
  if (/confirm by typing|confirm with (the|this) (new )?total|Read the summary again|typed at launch|total you typed|now turns things on/i.test(msg)) {
    extra.push(`For Claude: the person must type this amount themselves, after seeing the summary (${summaryTool} shows it). Show the summary and the amount to them and ask. Never fill in spend_confirmation yourself, not even with the amount named here.`);
  }
  if (/new warnings? since you checked|accept them to (launch|run)|accepting \d+ warnings/i.test(msg)) {
    extra.push(`For Claude: show these warnings to the person first (${summaryTool} lists them). Set accept_warnings only after they have read them and said yes.`);
  }
  if (!extra.length) return e instanceof Error ? e : new Error(msg);
  return new Error(`${msg}\n${extra.join("\n")}`);
}
/** A number Claude may send as text ("15000", "₹15,000"): the server reads both. */
const numberish = z.union([z.number(), z.string()]);
/** One value or a list. */
const oneOrMany = z.union([z.array(z.string()), z.string()]);
const asList = (x: string | string[] | undefined) => (x === undefined ? undefined : (Array.isArray(x) ? x : [x]).map((s) => s.trim()).filter(Boolean));
const asId = (x: number | string | undefined) => {
  if (x === undefined || x === "") return undefined;
  const n = Number(String(x).replace(/^#/, "").trim());
  if (!Number.isInteger(n) || n <= 0) throw new Error(`"${x}" is not an id (a number from list_metrics).`);
  return n;
};

interface Connection {
  connected: boolean;
  adAccount: { id: string; name: string; adsManagerLink: string } | null;
  page: { id: string; name: string; pictureUrl: string | null; link: string } | null;
  instagram: { id: string; username: string; pictureUrl: string | null; link: string; allowed: boolean | null } | null;
  loginBy: string | null;
  loginExpiresAt: string | null;
  loginExpired: boolean;
  problems: string[];
}

export function connectionText(c: Connection): string {
  if (!c.connected) return c.problems.join(" ");
  const lines = [
    `Ad account: ${c.adAccount!.name} (ID ${c.adAccount!.id.replace("act_", "")}) · ${c.adAccount!.adsManagerLink}`,
    c.page ? `Facebook Page: ${c.page.name} (ID ${c.page.id}) · ${c.page.link}${c.page.pictureUrl ? ` · picture: ${c.page.pictureUrl}` : ""}` : "Facebook Page: not set",
    c.instagram
      ? `Instagram: @${c.instagram.username} (ID ${c.instagram.id}) · ${c.instagram.link}${c.instagram.pictureUrl ? ` · picture: ${c.instagram.pictureUrl}` : ""}${c.instagram.allowed === false ? " · NOT ALLOWED for this ad account" : c.instagram.allowed ? " · allowed for this ad account" : ""}`
      : "Instagram: none (Instagram placements use the Facebook Page)",
    `Meta login: ${c.loginBy ?? "?"}, ${c.loginExpired ? "EXPIRED" : c.loginExpiresAt ? `works until ${istLabel(c.loginExpiresAt)}` : "does not expire"}`,
  ];
  for (const p of c.problems) lines.push(`PROBLEM: ${p}`);
  return lines.join("\n");
}

interface PlanAdSet { step: number; steps?: number[]; name: string; campaign: string; dailyBudget: number | null; lifetimeBudget: number | null; status?: string; details: Record<string, string> }
interface PlanView {
  key: string;
  title: string;
  status: string;
  statusLabel: string;
  canSpend: boolean;
  runAt: string | null;
  link: string;
  summary: {
    account: { id: string; name: string; currency: string };
    /** The daily budget ceiling (Settings → Safety) when the plan was checked; 0 = none. */
    dailyCeiling?: number;
    steps: { n: number; title: string; lines: string[] }[];
    adsets: PlanAdSet[];
    campaignBudgets?: { name: string; dailyBudget: number | null; lifetimeBudget: number | null; status: string }[];
    totals: { campaigns: number; adsets: number; ads: number; dailyBudget: number; lifetimeBudget: number; spendNowDaily: number; turnsOn: string[] };
    checks: { level: string; message: string; code?: string }[];
    errors: number;
    warnings: number;
    canSpend: boolean;
    spendConfirmation: string | null;
    /** Plain notes on the money, e.g. "₹30,000 lifetime counted as ₹15,000 a day". */
    notes?: string[];
  } | null;
  progress: { n: number; title: string; status: string; message: string; ids: string[] }[];
  waiting?: { untilLabel: string; reason: string } | null;
  /** The plan's times in India time words. */
  labels?: { runAt: string | null; createdAt: string; confirmedAt: string | null; finishedAt: string | null };
}

/** Steps whose titles differ only in names and numbers ("Edit ad set "A"", "Edit ad set "B""). */
const stepKind = (t: string) => t.replace(/"[^"]*"/g, '"…"').replace(/\d[\d,.]*/g, "#");
/** "1–5, 7, 9–12" */
function ranges(ns: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(j > i ? `${ns[i]}–${ns[j]}` : String(ns[i]));
    i = j;
  }
  return out.join(", ");
}

type Money = (x: number | null) => string;

/** A draft plan's steps: a long run of steps of the same kind shows its first two and a count. */
function stepLines(v: PlanView, m: Money): string[] {
  const s = v.summary!;
  const out: string[] = [];
  const real = s.steps.filter((st) => st.n);
  const full = (st: (typeof real)[number]) => {
    out.push(`Step ${st.n}: ${st.title}`);
    for (const l of st.lines.slice(0, 25)) out.push(`   ${l}`);
    if (st.lines.length > 25) out.push(`   … and ${st.lines.length - 25} more lines (every item is in the table below and in the app: ${v.link})`);
  };
  for (let i = 0; i < real.length; ) {
    let j = i;
    while (j + 1 < real.length && stepKind(real[j + 1].title) === stepKind(real[i].title)) j++;
    const runOf = real.slice(i, j + 1);
    if (runOf.length < 5) runOf.forEach(full);
    else {
      runOf.slice(0, 2).forEach(full);
      const rest = runOf.slice(2);
      const nums = new Set(rest.map((x) => x.n));
      const sets = s.adsets.filter((a) => (a.steps ?? [a.step]).some((n) => nums.has(n)));
      const daily = sets.map((a) => a.dailyBudget).filter((x): x is number => x !== null);
      const money = daily.length ? ` with daily budgets from ${m(Math.min(...daily))} to ${m(Math.max(...daily))}` : "";
      out.push(`Steps ${rest[0].n}–${rest[rest.length - 1].n}: ${rest.length} more steps of the same kind.${sets.length ? ` They make or change ${sets.length} ad set${sets.length === 1 ? "" : "s"}${money} (each one is in the table below).` : ""}`);
      const titles = rest.map((x) => `${x.n}. ${x.title}`).join("; ");
      out.push(titles.length <= 1500 ? `   ${titles}` : `   First: ${rest[0].title}. Last: ${rest[rest.length - 1].title}. Every step with its details is in the app: ${v.link}`);
    }
    i = j + 1;
  }
  return out;
}

/** Errors (all needed to fix the plan) and warnings, the plan's own notes first; long lists are cut. */
function checkLines(v: PlanView): string[] {
  const s = v.summary!;
  const errors = s.checks.filter((c) => c.level === "error");
  const warnings = [...s.checks.filter((c) => c.level !== "error" && c.code === "plan_note"), ...s.checks.filter((c) => c.level !== "error" && c.code !== "plan_note")];
  const out = [...errors.slice(0, 40).map((c) => `ERROR: ${c.message}`), ...warnings.slice(0, 30).map((c) => `Warning: ${c.message}`)];
  const cut = Math.max(0, errors.length - 40) + Math.max(0, warnings.length - 30);
  if (cut) out.push(`… and ${cut} more ${errors.length > 40 ? "errors and warnings" : "warnings"}: every one is in the app (${v.link}).`);
  return out;
}

function draftText(v: PlanView, out: string[], m: Money) {
  const s = v.summary!;
  const when = s.steps.find((st) => !st.n);
  if (when) {
    out.push(`When: ${when.title}`);
    for (const l of when.lines) out.push(`   ${l}`);
  }
  out.push(`Ad account: ${s.account.name} (${s.account.id.replace("act_", "")}).`);
  // The money first: the TOTAL, what turns on, and what the person types to confirm.
  out.push(`TOTAL daily budget at the end of this plan (every ad set once, at its final budget, plus campaign budgets): ${m(s.totals.dailyBudget)}${s.totals.lifetimeBudget ? ` (plus ${m(s.totals.lifetimeBudget)} lifetime)` : ""}. ${s.totals.campaigns} campaign(s), ${s.totals.adsets} new ad set(s), ${s.totals.ads} ad(s).`);
  if (s.totals.turnsOn.length) out.push(`TURNS ON: ${s.totals.turnsOn.join("; ")}. Daily budget able to spend afterwards: ${m(s.totals.spendNowDaily)}.`);
  for (const n of s.notes ?? []) out.push(`Money note: ${n}`);
  if (s.dailyCeiling !== undefined) {
    out.push(
      s.dailyCeiling
        ? `Daily budget ceiling (Settings → Safety): ${m(s.dailyCeiling)} a day. A plan that would let more spend per day can't run.`
        : "Daily budget ceiling: none set, so nothing stops a very large budget. Only the person can set one, in the app: Settings → Safety (get_safety_settings shows it).",
    );
  }
  if (s.canSpend && s.spendConfirmation) {
    const differs = s.spendConfirmation !== m(s.totals.dailyBudget);
    out.push(`To run it, the person types ${s.spendConfirmation}: what can spend in a day once this plan has run${differs ? ". This differs from the TOTAL above: the TOTAL counts every ad set in the plan, on or off; this counts what is on afterwards, including ad sets already on in the campaigns it turns on" : ""}.`);
  } else out.push("No typed total is needed: this plan turns nothing on and raises no budget that is already spending.");
  const checks = checkLines(v);
  if (checks.length) out.push("", ...checks);
  out.push("", ...stepLines(v, m));
  let cut = 0;
  if (s.adsets.length) {
    out.push("", "Every ad set in the plan, as it will be at the end:", "| Steps | Ad set | Campaign | Daily budget | Lifetime | Bid | Schedule | Audience | Placements | On/off |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const a of s.adsets.slice(0, MAX_ROWS)) {
      out.push(`| ${(a.steps ?? [a.step]).join(", ")} | ${cell(a.name)} | ${cell(a.campaign)} | ${a.dailyBudget === null ? (a.details.budget === "campaign budget" ? "campaign budget" : "") : m(a.dailyBudget)} | ${!a.lifetimeBudget ? "" : m(a.lifetimeBudget)} | ${cell(a.details.bid ?? "")} | ${cell(a.details.schedule ?? "")} | ${cell(a.details.audience ?? "")} | ${cell(a.details.placements ?? "")} | ${(a.status ?? "").toLowerCase()} |`);
    }
    cut = Math.max(0, s.adsets.length - MAX_ROWS);
    if (cut) {
      const daily = s.adsets.slice(MAX_ROWS).map((a) => a.dailyBudget).filter((x): x is number => x !== null);
      out.push(`(${cut} more ad sets not shown here${daily.length ? `, daily budgets ${m(Math.min(...daily))} to ${m(Math.max(...daily))}` : ""}. Every ad set with its budget and settings is in the app: ${v.link})`);
    }
  }
  for (const c of s.campaignBudgets ?? []) out.push(`Campaign budget: "${c.name}" ${c.dailyBudget ? `${m(c.dailyBudget)} a day` : `${m(c.lifetimeBudget)} lifetime`} (${c.status.toLowerCase()})`);
  if (s.errors) out.push(`\n${s.errors} error(s): fix them with update_plan before it can run. plan_step_fields (with the step's type) lists the exact fields each step takes and their allowed values.`);
  else
    out.push(
      `\nNothing has changed in Meta yet. Show this summary to the person: the TOTAL, what turns on, and every budget${cut ? ` (the full list of ad sets is in the app: ${v.link})` : ""}. Run it only after they say yes: confirm_plan with confirm: true${s.warnings ? ", accept_warnings: true (after they accepted the warnings)" : ""}${s.canSpend ? `, and spend_confirmation: "${s.spendConfirmation}" — the person must say this total themselves; do not fill it in for them` : ""}.`,
    );
}

/** A plan that was confirmed (or ran): counts, the steps that need attention, and what to do next. */
function progressText(v: PlanView, out: string[], m: Money) {
  const s = v.summary!;
  const p = v.progress;
  const count = (st: string) => p.filter((x) => x.status === st).length;
  const parts = [`${count("done")} done`, count("failed") ? `${count("failed")} failed` : "", count("stopped") ? `${count("stopped")} stopped by the cancel` : "", count("running") ? `${count("running")} running` : "", count("skipped") ? `${count("skipped")} skipped` : "", count("pending") ? `${count("pending")} not run yet` : ""].filter(Boolean);
  out.push(`Steps: ${parts.join(", ")} (of ${p.length}).`);
  if (v.status !== "cancelled" && s.canSpend && s.spendConfirmation) out.push(`What can spend once it has run: ${s.spendConfirmation} a day${s.totals.turnsOn.length ? ` (turns on: ${s.totals.turnsOn.join("; ")})` : ""}.`);
  const line = (x: (typeof p)[number]) => `  ${x.n}. ${x.title}: ${x.status}${x.message ? ` · ${x.message}` : ""}${x.ids.length ? ` · IDs ${x.ids.slice(0, 20).join(", ")}${x.ids.length > 20 ? "…" : ""}` : ""}`;
  out.push("", "Progress:");
  if (p.length <= MAX_ROWS) for (const x of p) out.push(line(x));
  else {
    const notable = p.filter((x) => x.status === "failed" || x.status === "stopped" || x.status === "running");
    for (const x of notable.slice(0, MAX_ROWS)) out.push(line(x));
    if (notable.length > MAX_ROWS) out.push(`  … and ${notable.length - MAX_ROWS} more failed steps (all in the app).`);
    for (const st of ["done", "skipped", "pending"]) {
      const ns = p.filter((x) => x.status === st).map((x) => x.n);
      if (ns.length) out.push(`  ${st === "pending" ? "Not run yet" : st[0].toUpperCase() + st.slice(1)}: steps ${ranges(ns)}.`);
    }
    out.push(`  Every step with its new IDs is in the app: ${v.link}`);
  }
  out.push("");
  const runAt = v.labels?.runAt ?? (v.runAt ? istLabel(v.runAt) : null);
  if (v.status === "queued") out.push(runAt && /^Scheduled/.test(v.statusLabel) ? `Next: it runs by itself at ${runAt}. Until then cancel_plan stops it.` : "Next: it runs in the background now; plan_status shows the progress. cancel_plan stops it: no more items or steps run after the one it is on.");
  else if (v.status === "running") out.push("Next: nothing to do; plan_status shows the progress. cancel_plan stops it: no more items or steps run after the one it is on.");
  else if (v.status === "done") out.push(`Next: delivery_status with plan_id ${v.key} shows whether it delivers. undo_plan makes a plan that puts things back (nothing is deleted).`);
  else if (v.status === "partial" || v.status === "failed")
    out.push(`Next: fix the cause named in the failed step, then retry_plan with plan_id ${v.key} (give ops to change the failed step and the steps after it, or leave ops out to try them again as they are). Finished steps are not run again. Then confirm_plan.`);
  else if (v.status === "cancelled") out.push("Steps already done stay as they are; nothing else runs.");
}

function planText(v: PlanView): string {
  const s = v.summary;
  const out = [`Plan ${v.key}: ${v.title}. Status: ${v.statusLabel}. Open in the app: ${v.link}`];
  if (v.waiting) out.push(`Waiting for Meta until about ${v.waiting.untilLabel} IST: ${v.waiting.reason}. It continues by itself; nothing needs doing.`);
  if (!s) return out.join("\n");
  const cur = s.account.currency === "INR" ? "₹" : `${s.account.currency} `;
  const m: Money = (x) => (x === null ? "" : `${cur}${x.toLocaleString("en-IN")}`);
  if (v.status === "draft") draftText(v, out, m);
  else progressText(v, out, m);
  return out.join("\n");
}

// ---------- Plan steps: every field, by its exact name (plan_changes' description and plan_step_fields) ----------

/**
 * One field of a plan step. `t`: its type, allowed values and rules, for plan_step_fields. `brief`: a few words
 * shown next to the name in plan_changes' description. `opt`: may be left out (audience sources). `internal`:
 * filled in by the launcher (Undo, hashing); listed by plan_step_fields so the list is complete, never in the
 * description.
 */
interface FieldDoc { t: string; brief?: string; opt?: true; internal?: true }
type StepType = Op["type"];
type OpOf<T extends StepType> = Extract<Op, { type: T }>;
/** Every field of T except "type" and "ref" (every step takes ref). Typed against the plan engine's own types
 *  (plan.ts Op, objects.ts, ads.ts, audiences.ts): a field added, renamed or removed there fails the build
 *  until it is written here too, so Claude is never shown a field the launcher doesn't take. */
type Fields<T> = { [K in Exclude<keyof T, "type" | "ref">]-?: FieldDoc };

const values = (list: { value: string }[], sep = ", ") => list.map((o) => o.value).join(sep);
const TIME = "time, e.g. 2026-11-20T09:00 (India time when no zone is given)";
const NAMED = (what: string) => `text: the ${what}'s ID, its exact name, or "$ref" of an earlier step`;
const STATUS: FieldDoc = { t: '"PAUSED" or "ACTIVE" (turns it on: the person types the total to confirm). New items are made PAUSED unless ACTIVE is given.', brief: "PAUSED|ACTIVE" };
const PERSONA: FieldDoc = { t: "text: fills {persona} in name templates" };
const ANGLE: FieldDoc = { t: "text: fills {angle} in name templates" };
const COPIES: FieldDoc = { t: "whole number 1 to 200: how many copies (default 1, or the number of entries in changes)", brief: "1–200" };

const CAMPAIGN: Fields<CampaignSpec> = {
  name: { t: "text: the campaign's name. To make one, give name or name_template." },
  name_template: { t: 'text: a naming pattern, e.g. "{date}_{objective}_{n}", or the name or ID of a saved naming template. Used when name is left out.' },
  objective: { t: `one of ${values(OBJECTIVES)}. Needed to create a campaign.`, brief: values(OBJECTIVES, "|") },
  budget_level: { t: '"campaign" (campaign budget: give daily_budget, or lifetime_budget with stop_time) or "adset" (each ad set has its own budget: leave daily_budget and lifetime_budget out). Left out: "campaign" when a budget is given, otherwise "adset".', brief: '"campaign"|"adset"' },
  daily_budget: { t: "number: rupees a day (the campaign budget). Not with lifetime_budget.", brief: "rupees a day" },
  lifetime_budget: { t: "number: rupees in total (the campaign budget). Needs stop_time. Not with daily_budget.", brief: "rupees, needs stop_time" },
  bid_strategy: { t: `one of ${values(BID_STRATEGIES)} (LOWEST_COST_WITHOUT_CAP = highest volume, the default). With budget_level "adset" it is used for the ad sets this plan makes in this campaign.`, brief: values(BID_STRATEGIES, "|") },
  special_ad_categories: { t: `list of ${values(SPECIAL_AD_CATEGORIES.filter((o) => o.value !== "NONE"))} ([] or ["NONE"] = none). Set when the campaign is made.`, brief: "list, e.g. [\"HOUSING\"]" },
  special_ad_category_country: { t: 'list of 2-letter country codes, e.g. ["IN"]. Only with a special ad category.' },
  spend_cap: { t: "number: rupees, the campaign's spend limit (in total).", brief: "rupees" },
  start_time: { t: TIME, brief: "time" },
  stop_time: { t: `${TIME}. Needed with lifetime_budget.`, brief: "time" },
  status: STATUS,
  persona: PERSONA,
  angle: ANGLE,
  budget_schedules: { t: 'list of {"start": time, "end": time, "increase_percent": number} or {"start", "end", "increase_amount": number in rupees}: raises the daily campaign budget during each period (at least 3 hours each, at most 50). Campaign budget with a daily budget only.', brief: "[{start, end, increase_percent or increase_amount}]" },
};

const ADSET: Fields<AdSetSpec> = {
  name: { t: "text: the ad set's name. To make one, give name or name_template." },
  name_template: { t: 'text: a naming pattern, e.g. "{date}_{persona}_{budget}_{n}" ({date}, {n}, {persona}, {angle}, {campaign}, {adset}, {budget}, {objective}), or the name or ID of a saved naming template.' },
  daily_budget: { t: "number: rupees a day. An ad set needs daily_budget or lifetime_budget, unless its campaign has a campaign budget (then leave both out). Meta can't switch an existing ad set between daily and lifetime budget.", brief: "rupees a day" },
  lifetime_budget: { t: "number: rupees in total. Needs end_time. Not with daily_budget.", brief: "rupees, needs end_time" },
  start_time: { t: TIME, brief: "time" },
  end_time: { t: `${TIME}. Needed with lifetime_budget.`, brief: "time" },
  destination: { t: `where people go (Ads Manager's conversion location): one of ${values(DESTINATIONS)}. ON_AD = Instant forms.`, brief: "WEBSITE, ON_AD (Instant forms), WHATSAPP…" },
  goal: { t: `what Meta optimises for (performance goal): one of ${values(GOALS)}. Needed to create an ad set.`, brief: "LEAD_GENERATION, OFFSITE_CONVERSIONS, LINK_CLICKS, REACH…" },
  billing_event: { t: `one of ${values(BILLING_EVENTS)} (default IMPRESSIONS).`, brief: values(BILLING_EVENTS, "|") },
  bid_strategy: { t: `one of ${values(BID_STRATEGIES)}. Default LOWEST_COST_WITHOUT_CAP (highest volume) when the campaign has no campaign budget.`, brief: "as in create_campaign" },
  bid_amount: { t: "number: rupees, the cost per result goal or bid cap. Needed with COST_CAP and LOWEST_COST_WITH_BID_CAP.", brief: "rupees" },
  roas_average_floor: { t: "number: the return on ad spend goal, e.g. 2.5. Needed with LOWEST_COST_WITH_MIN_ROAS.", brief: "e.g. 2.5" },
  pixel_id: { t: "text: the website pixel's ID (lookup pixels). Goal OFFSITE_CONVERSIONS needs pixel_id with event, or custom_conversion_id." },
  event: { t: `the pixel event: one of ${values(PIXEL_EVENTS)} (OTHER = a custom event, give custom_event_str).`, brief: "LEAD, PURCHASE… or OTHER" },
  custom_event_str: { t: "text: the custom event's name, when event is OTHER." },
  custom_conversion_id: { t: "text: a custom conversion's ID (lookup custom_conversions)." },
  page_id: { t: "text: the Facebook Page's ID (Instant forms, messages, calls)." },
  app_id: { t: "text: the app's ID (with app_store_url)." },
  app_store_url: { t: "text: the app's store link (with app_id)." },
  whatsapp_number: { t: 'text: the WhatsApp number with country code, e.g. "+919812345678".', brief: '"+91…"' },
  saved_audience_id: { t: "text: a saved audience's ID (lookup saved_audiences); its targeting is the starting point." },
  countries: { t: 'list of 2-letter country codes, e.g. ["IN"].', brief: '["IN"]' },
  regions: { t: 'list of region keys, or {"key", "name"} (lookup locations).', brief: "[key or {key, name}]" },
  cities: { t: 'list of city keys, or {"key", "name", "radius": number, "distance_unit": "kilometer" or "mile"} (lookup locations).', brief: "[{key, name, radius}]" },
  age_min: { t: "whole number 18 to 65.", brief: "18–65" },
  age_max: { t: "whole number 18 to 65.", brief: "18–65" },
  genders: { t: '"all", "men" or "women".', brief: "all|men|women" },
  interests: { t: 'list of {"id", "name"} or interest IDs (lookup interests). [] removes every interest.', brief: "[{id, name}]" },
  custom_audiences: { t: 'list of audience IDs (lookup custom_audiences) or "$ref" of an audience this plan makes.', brief: '[ID or "$ref"]' },
  excluded_custom_audiences: { t: 'list of audience IDs or "$ref": people in these are left out.', brief: '[ID or "$ref"]' },
  advantage_audience: { t: "true or false: Advantage+ audience (off unless true).", brief: "true|false" },
  placements: { t: `"advantage" (Meta picks), or {"platforms": [${values(PLACEMENT_PLATFORMS)}], "facebook_positions": [...], "instagram_positions": [...], "messenger_positions": [...], "audience_network_positions": [...], "threads_positions": [...]} with Meta's position names (e.g. feed, story, facebook_reels; stream, story, reels).`, brief: '"advantage" or {platforms, facebook_positions, instagram_positions…}' },
  targeting: { t: "object: Meta's own targeting fields, added last (for anything the fields above don't cover)." },
  attribution: { t: `one of ${values(ATTRIBUTION)}.`, brief: values(ATTRIBUTION, "|") },
  min_daily_spend: { t: "number: rupees a day, the ad set's minimum spend (Meta's ad set spend limit, used with a campaign budget).", brief: "rupees a day" },
  max_daily_spend: { t: "number: rupees a day, the ad set's maximum spend (Meta's ad set spend limit, used with a campaign budget).", brief: "rupees a day" },
  status: STATUS,
  persona: PERSONA,
  angle: ANGLE,
  schedule: { t: 'list of {"days": [0 to 6, 0 = Sunday], "start": "09:00", "end": "18:00"}: runs only at these hours (ad account time). Needs lifetime_budget.', brief: '[{days: [1..5], start: "09:00", end: "18:00"}], needs lifetime_budget' },
  frequency_cap: { t: '{"impressions": number, "days": number}: at most this many impressions per person every so many days. Goal REACH (or IMPRESSIONS, POST_ENGAGEMENT), in Awareness or Engagement campaigns only.', brief: "{impressions, days}" },
  inventory_filter: { t: '"expanded", "moderate" or "limited" (brand safety).', brief: "expanded|moderate|limited" },
  block_list_ids: { t: "list of block list IDs (lookup block_lists)." },
  languages: { t: "list of language (locale) IDs, numbers (lookup languages). [] removes them.", brief: "[locale IDs]" },
  targeting_expansion: { t: "true or false. Meta now always lets detailed targeting reach further; false only gives a warning.", brief: "true|false" },
  dynamic_creative: { t: "true or false: a Dynamic creative ad set (new ad sets only).", brief: "true|false" },
  replace_targeting: { t: "Leave out: undo_plan uses it to put targeting back.", internal: true },
};

const AD_EDIT: Fields<AdEditSpec> = {
  name: { t: "text: the ad's new name." },
  status: STATUS,
  primary_texts: { t: "list of up to 5 texts. Several need an ad made with text options.", brief: "up to 5" },
  headlines: { t: "list of up to 5 headlines (a carousel: card N gets headline N, or the first).", brief: "up to 5" },
  descriptions: { t: "list of up to 5 descriptions, the line under the headline (a carousel: card N gets description N, or the first). Several need an ad made with text options. [] removes them.", brief: "up to 5" },
  description: { t: 'text: one description (same as descriptions: ["…"]; "" removes it).' },
  link_url: { t: "text: the website link, starting with https://." },
  cta: { t: `the button: one of ${CTA_TYPES.join(", ")}.`, brief: "LEARN_MORE, SIGN_UP…" },
  display_link: { t: 'text: the short link shown on the ad, e.g. "sahajta.com/visit" ("" removes it).' },
  url_tags: { t: 'text: UTM tags added to the link, e.g. "utm_source=facebook&utm_content={{ad.name}}" ("" removes them).' },
  media_url: { t: "text: a Google Drive file link: swaps the ad's image or video (ads with one file only).", brief: "Google Drive file link" },
  creative_id: { t: "Leave out: undo_plan uses it to put the old creative back.", internal: true },
};

/** Audience sources: the fields of each kind (create_custom_audience's "source"). */
type SourceKind = AudienceSource["kind"];
const SOURCES: { [K in SourceKind]: Fields<Omit<Extract<AudienceSource, { kind: K }>, "kind">> } = {
  website: {
    pixel_id: { t: "text, required: the pixel's ID (lookup pixels)." },
    days: { t: "whole number 1 to 180, required: people who visited in the last this many days.", brief: "1–180" },
    url_contains: { t: "list of text, optional: only pages whose link contains one of these.", opt: true },
    event: { t: 'text, optional: only people who sent this pixel event, as Meta names it (e.g. "Lead").', opt: true },
  },
  video: {
    video_ids: { t: "list of video IDs, required." },
    days: { t: "whole number 1 to 365, required.", brief: "1–365" },
    watched: { t: '"3s" (the default), "thruplay", "25%", "50%", "75%" or "95%", optional: how much they watched.', opt: true },
  },
  page: {
    page_id: { t: "text, required: the Facebook Page's ID." },
    days: { t: "whole number 1 to 365, required.", brief: "1–365" },
    engaged: { t: '"all" (the default), "messaged" or "cta_clicked", optional.', opt: true },
  },
  instagram: {
    instagram_id: { t: "text, required: the Instagram account's ID." },
    days: { t: "whole number 1 to 365, required.", brief: "1–365" },
    engaged: { t: '"all" (the default), "messaged" or "visited", optional.', opt: true },
  },
  lead_form: {
    page_id: { t: "text, required: the Facebook Page whose Instant forms count." },
    days: { t: "whole number 1 to 90, required.", brief: "1–90" },
    action: { t: '"opened" (the default), "submitted" or "opened_not_submitted", optional.', opt: true },
  },
  customer_list: {
    emails: { t: "list of email addresses, optional (give emails, phones or both).", opt: true },
    phones: { t: "list of phone numbers with country code, optional (10-digit numbers are taken as India).", opt: true },
    hashed: { t: "Leave out: the launcher hashes the emails and phones before saving and keeps only the hashes.", internal: true },
  },
};
const SOURCE_EXAMPLE = '{"kind": "website", "pixel_id": "<pixel ID>", "days": 30}';

interface StepDoc { what: string; fields: Record<string, FieldDoc>; also?: StepType; example: Record<string, unknown> }

/** Every step type with its fields. `also`: the step takes every field of that step too (edits). */
const STEPS: { [T in StepType]: { what: string; fields: Fields<OpOf<T>>; also?: StepType; example: Record<string, unknown> } } = {
  create_campaign: {
    what: "Make a campaign (paused unless status ACTIVE).",
    fields: CAMPAIGN,
    example: { type: "create_campaign", ref: "c1", name: "Leads Nov", objective: "OUTCOME_LEADS", budget_level: "adset" },
  },
  edit_campaign: {
    what: "Change a campaign. Only the fields given change. Meta can't switch a campaign between daily and lifetime budget; bid_strategy only with a campaign budget.",
    fields: { campaign: { t: NAMED("campaign") }, ...CAMPAIGN },
    also: "create_campaign",
    example: { type: "edit_campaign", campaign: "Leads Nov", daily_budget: 2000 },
  },
  duplicate_campaign: {
    what: "Copy a campaign, with or without its ad sets and ads (copies are paused unless a change says ACTIVE).",
    fields: {
      campaign: { t: NAMED("campaign") },
      copies: COPIES,
      changes: { t: "list: one object per copy, with create_campaign fields to change on it (name, daily_budget, lifetime_budget, status, start_time, stop_time…; not budget_schedules). Anything not given keeps the original.", brief: "[one object per copy]" },
      with_contents: { t: "true or false (default): true also copies its ad sets and ads, one at a time.", brief: "true|false" },
      name_template: { t: "text: naming pattern for the copies (or a saved naming template's name or ID)." },
      persona: PERSONA,
    },
    example: { type: "duplicate_campaign", campaign: "Leads Nov", copies: 2, with_contents: true },
  },
  create_adset: {
    what: "Make an ad set in a campaign (paused unless status ACTIVE). Housing, employment and credit campaigns: ages 18–65 only, all genders, radius at least 25 km.",
    fields: { campaign: { t: NAMED("campaign") }, ...ADSET },
    example: { type: "create_adset", campaign: "$c1", name: "Pune 25-45", daily_budget: 500, destination: "ON_AD", goal: "LEAD_GENERATION", page_id: "<Page ID>", countries: ["IN"], age_min: 25, age_max: 45 },
  },
  edit_adset: {
    what: 'Change an ad set ("$ref" of several changes them all). Only the fields given change. Meta can\'t switch an ad set between daily and lifetime budget.',
    fields: { adset: { t: `${NAMED("ad set")} ("$ref" of a step that made several = all of them)` }, ...ADSET },
    also: "create_adset",
    example: { type: "edit_adset", adset: "Pune 25-45", daily_budget: 800, min_daily_spend: 200, max_daily_spend: 1000 },
  },
  duplicate_adset: {
    what: "Copy an ad set, into the same or another campaign, with or without its ads (copies are paused unless a change says ACTIVE).",
    fields: {
      adset: { t: NAMED("ad set") },
      campaign: { t: `${NAMED("campaign")}: where the copies go (default: the same campaign)` },
      copies: COPIES,
      changes: { t: "list: one object per copy, with create_adset fields to change on it (name, daily_budget, countries, age_min, status…). Anything not given keeps the original.", brief: "[one object per copy]" },
      with_ads: { t: "true or false (default): true also copies its ads.", brief: "true|false" },
      name_template: { t: 'text: naming pattern for the copies, e.g. "{campaign}_{persona}_{budget}_{n}".' },
      persona: PERSONA,
    },
    example: { type: "duplicate_adset", adset: "Pune 25-45", changes: [{ name: "Mumbai 25-45", daily_budget: 700 }, { name: "Delhi 25-45", daily_budget: 900 }] },
  },
  ads_from_post: {
    what: "Make ads from an existing post: one creative, so likes and comments add up on that post. lookup posts lists post IDs.",
    fields: {
      post_id: { t: 'text, required: the Facebook post as "pageid_postid", or a post ID with page_id. A post behind an earlier ad is reused by its Facebook post ID (the ads still run on Instagram).', brief: '"pageid_postid"' },
      source: { t: '"facebook" (the default) or "instagram": "instagram" only for organic Instagram posts (needs instagram_user_id); Meta refuses the Instagram media ID of a post made for an ad.', brief: '"facebook" (default) or "instagram" (organic Instagram posts only)' },
      adsets: { t: 'list, required: the ad sets to put an ad in (IDs, exact names or "$ref").', brief: "[ad sets]" },
      name: { t: "text: the ads' name." },
      name_template: { t: "text: naming pattern ({adset}, {n}…)." },
      page_id: { t: "text: the Facebook Page's ID, when post_id has no page part." },
      instagram_user_id: { t: 'text: the Instagram account\'s ID (source "instagram").' },
      status: STATUS,
    },
    example: { type: "ads_from_post", post_id: "<pageid_postid>", adsets: ["Pune 25-45"], name: "From post" },
  },
  edit_ad: {
    what: "Change existing ads. Text or file changes make a new creative on the same ad (Meta reviews it again). Ads that run an existing post can only change name and status.",
    fields: { ad: { t: 'text: the ad\'s ID, or "$ref" of an earlier step ("$ref" of several = all of them).', brief: 'ID or "$ref"' }, ...AD_EDIT },
    example: { type: "edit_ad", ad: "<ad ID>", headlines: ["Free site visit"], descriptions: ["Plots from 20 lakh", "Site visit this Sunday"], display_link: "sahajta.com/visit" },
  },
  copy_ad: {
    what: "Copy an ad into other ad sets with the same creative (and post), paused unless status ACTIVE.",
    fields: {
      ad: { t: 'text: the ad\'s ID, or "$ref" of an earlier step.' },
      adsets: { t: 'list: the ad sets to copy it into (IDs, exact names or "$ref").', brief: "[ad sets]" },
      name: { t: "text: the copies' name (default: the original's)." },
      name_template: { t: "text: naming pattern ({adset}, {n}…)." },
      status: STATUS,
    },
    example: { type: "copy_ad", ad: "<ad ID>", adsets: ["Pune 25-45", "Mumbai 25-45"] },
  },
  set_status: {
    what: "Turn things on or off. IDs must be in this ad account. Nothing can be deleted or archived.",
    fields: {
      status: { t: '"ACTIVE" (turn on: the person types the total to confirm) or "PAUSED" (turn off). Required.', brief: "ACTIVE|PAUSED" },
      campaigns: { t: 'list of campaigns (IDs, exact names or "$ref"): the campaign only.' },
      adsets: { t: 'list of ad sets (IDs, exact names or "$ref").' },
      ads: { t: 'list of ad IDs or "$ref".' },
      whole_campaigns: { t: "list of campaigns: the campaign, all its ad sets and all its ads.", brief: "the campaign with all its ad sets and ads" },
    },
    example: { type: "set_status", status: "PAUSED", adsets: ["Pune 25-45"] },
  },
  create_custom_audience: {
    what: 'Make a custom audience. A later step uses it as "$ref" (custom_audiences, excluded_custom_audiences, or create_lookalike\'s source_audience). Meta fills it over the next hours.',
    fields: {
      name: { t: "text, required: the audience's name." },
      description: { t: "text, optional." },
      source: { t: 'object, required: who is in the audience. Its "kind" decides its other fields (below).', brief: "an object by kind, below" },
    },
    example: { type: "create_custom_audience", ref: "web30", name: "Website visitors 30 days", source: { kind: "website", pixel_id: "<pixel ID>", days: 30 } },
  },
  create_lookalike: {
    what: "Make a lookalike audience from another audience (it needs about 100 matched people first).",
    fields: {
      name: { t: "text, required: the audience's name." },
      source_audience: { t: 'text, required: the audience\'s ID (lookup custom_audiences), or "$ref" of an audience this plan makes.' },
      country: { t: 'text, required: a 2-letter country code, e.g. "IN".', brief: '"IN"' },
      size_percent: { t: "number 1 to 10, required: 1 = the closest 1% of people in the country.", brief: "1–10" },
    },
    example: { type: "create_lookalike", ref: "lal1", name: "Lookalike 1%", source_audience: "$web30", country: "IN", size_percent: 1 },
  },
};
export const STEP_TYPES = Object.keys(STEPS) as StepType[];

const REF_DOC = 'text, optional: names what this step makes (e.g. "c1"); later steps use "$c1" for all of it, or "$c1.2" for the 2nd of several (counting from 1).';

/** One source kind in a few words: website {pixel_id, days (1–180), url_contains?, event?}. */
function sourceBrief(kind: SourceKind): string {
  const f = Object.entries(SOURCES[kind] as Record<string, FieldDoc>).filter(([, d]) => !d.internal);
  return `${kind} {${f.map(([k, d]) => `${k}${d.brief ? ` (${d.brief})` : ""}${d.opt ? "?" : ""}`).join(", ")}}`;
}

/** A step's fields in one line, for plan_changes' description. */
function stepLine(type: StepType): string {
  const s = STEPS[type] as StepDoc;
  const base = s.also ? (STEPS[s.also] as StepDoc).fields : {};
  const own = Object.entries(s.fields).filter(([k, d]) => !d.internal && !(k in base));
  const list = own.map(([k, d]) => (d.brief ? `${k} (${d.brief})` : k)).join(", ");
  let line = `- ${type}: ${s.what} Fields: ${list}${s.also ? `, and any ${s.also} field` : ""}, ref.`;
  if (type === "create_custom_audience") {
    line += ` source is one object, by "kind": ${(Object.keys(SOURCES) as SourceKind[]).map(sourceBrief).join(" | ")} (customer lists are hashed before saving). E.g. source: ${SOURCE_EXAMPLE}. The number of days is always "days".`;
  }
  return line;
}

/** Every field of one step type, its type and allowed values, and an example (plan_step_fields). */
export function stepFieldsText(type: StepType): string {
  const s = STEPS[type] as StepDoc;
  const fields = Object.entries(s.fields);
  const out = [`${type}: ${s.what}`, `Fields, by these exact names (any other field is refused):`, `- type: "${type}"`];
  for (const [k, d] of fields.filter(([, d]) => !d.internal)) out.push(`- ${k}: ${d.t}`);
  out.push(`- ref: ${REF_DOC}`);
  if (type === "create_custom_audience") {
    out.push('source, by its "kind" (the number of days is always "days"):');
    for (const kind of Object.keys(SOURCES) as SourceKind[]) {
      const f = Object.entries(SOURCES[kind] as Record<string, FieldDoc>);
      out.push(`  - {"kind": "${kind}", ${f.filter(([, d]) => !d.internal).map(([k]) => `"${k}"`).join(", ")}}`);
      for (const [k, d] of f.filter(([, d]) => !d.internal)) out.push(`      ${k}: ${d.t}`);
    }
  }
  const internal = [...fields.filter(([, d]) => d.internal), ...(type === "create_custom_audience" ? Object.entries(SOURCES.customer_list).filter(([, d]) => (d as FieldDoc).internal) : [])];
  if (internal.length) out.push(`Filled in by the launcher, leave out: ${internal.map(([k]) => k).join(", ")}.`);
  out.push(`Example: ${JSON.stringify(s.example)}`);
  out.push("Money is in the ad account's currency (rupees), not paise. Times without a zone are India time. lookup gives IDs; list_options gives plain labels for the allowed values.");
  return out.join("\n");
}

const opsDescription = `List of steps, run in order. Each step is an object with "type" and its fields, by the exact names below; a field the launcher doesn't know is refused (never guessed). For a step's fields with their types, allowed values and an example, call plan_step_fields with its type: do that when unsure, before guessing a name. Money is in the account currency (rupees), not paise. Times are ISO, e.g. 2026-11-20T09:00 — without a zone they are India time (IST). Use lookup for IDs (pixels, audiences, interests, locations, languages, posts, lead forms) and list_options for plain labels.
References: give a step "ref" (e.g. "c1"); later steps use "$c1" for what it made, or "$copies.2" for the 2nd of several (counting from 1). This works in every step: create, copy, edit, ads from a post, copy ad, turn on/off, and audiences in targeting. A ref that made several items, used where only one fits, is refused. Campaigns and ad sets can also be named by their exact name instead of the ID. Saved naming templates can be given by name in name_template.
Types and their fields:
${STEP_TYPES.map(stepLine).join("\n")}
Nothing can be deleted or archived.`;

// ---------- Names → IDs (list_ads, delivery_status) ----------

type Tree = { currency: string; campaigns: { id: string; name: string; status: string; effectiveStatus: string; cbo: boolean; details: Record<string, string>; adsets: { id: string; name: string; status: string; details: Record<string, string> }[] }[] };

/** A campaign or ad set found by idOf: its ID, its name when the campaign list gave it, and how the name matched. */
interface Found { id: string; name?: string; part?: boolean }

/**
 * A campaign or ad set given by ID or name → its ID. Meta's IDs are digits and are used as they are.
 * Anything else is looked up on the campaign list: an ID on it (the practice account's IDs have letters),
 * then the exact name, then a part of the name; several matches are refused with the list. A word that
 * is none of these is refused, never sent to Meta as an ID. When the campaign list can't be read, that
 * error is the answer (a name is never guessed to be an ID).
 */
async function idOf(api: LauncherApi, kind: "campaign" | "adset", given: string): Promise<Found> {
  const q = given.trim();
  const word = kind === "campaign" ? "campaign" : "ad set";
  if (!q) throw new Error(`Give the ${word}'s name or ID.`);
  if (/^\d+$/.test(q)) return { id: q };
  let t: Tree;
  try {
    t = await api.call<Tree>("GET", "/api/manage/tree");
  } catch (e) {
    throw new Error(`Couldn't look up the ${word} "${q}" by name: ${(e instanceof Error ? e.message : String(e)).replace(/\.+$/, "")}. Try again later, or give its ID (a number).`);
  }
  const items = kind === "campaign" ? t.campaigns.map((c) => ({ id: c.id, name: c.name, where: "" })) : t.campaigns.flatMap((c) => c.adsets.map((a) => ({ id: a.id, name: a.name, where: c.name })));
  const byId = items.find((x) => x.id === q);
  if (byId) return { id: byId.id, name: byId.name };
  const lower = q.toLowerCase();
  const exact = items.filter((x) => x.name.trim().toLowerCase() === lower);
  const pool = exact.length ? exact : items.filter((x) => x.name.toLowerCase().includes(lower));
  if (pool.length === 1) return { id: pool[0].id, name: pool[0].name, part: !exact.length };
  if (pool.length > 1) {
    throw new Error(`Several ${word}s match "${q}": ${pool.slice(0, 10).map((x) => `"${x.name}" (ID ${x.id}${x.where ? `, in campaign "${x.where}"` : ""})`).join("; ")}${pool.length > 10 ? `; and ${pool.length - 10} more` : ""}. Give the ID or the full name.`);
  }
  throw new Error(`No ${word} called "${q}" among the campaigns and ad sets that are not deleted. list_campaigns shows the names and IDs.`);
}

/**
 * cancel_batch was refused (nothing is launching). The ads can still be turned on by the batch's
 * turn-on plan, which cancel_batch may not stop: the refusal, plus which plan turns them on and that
 * cancel_plan stops it. Never says "nothing happens" when a plan is waiting.
 */
async function turnOnAfterRefusal(e: unknown, batchId: string, api: LauncherApi): Promise<string> {
  const msg = e instanceof Error ? e.message : String(e);
  type B = { settings?: { goLive?: string; goLiveAt?: string | null }; goLivePlan?: { key: string; status: string; runAt: string | null } | null };
  let b: B;
  try {
    b = await api.call<B>("GET", `/api/batches/${encodeURIComponent(batchId)}`);
  } catch {
    return msg;
  }
  const gp = b.goLivePlan;
  if (!b.settings?.goLive || b.settings.goLive === "paused" || !gp) return msg;
  if (gp.status === "queued") {
    return `${msg} But its ads are still to be turned on by plan ${gp.key}${gp.runAt ? ` at ${istLabel(gp.runAt)}` : " as soon as it runs"}. cancel_plan with plan_id ${gp.key} stops that (ask the person first); the ads then stay paused.`;
  }
  if (gp.status === "draft") return `${msg} The plan that would turn its ads on (${gp.key}) is a draft: nothing turns on unless the person confirms it. cancel_plan with plan_id ${gp.key} removes it.`;
  if (gp.status === "running" || gp.status === "done" || gp.status === "partial") {
    return gp.status === "running"
      ? `${msg} Plan ${gp.key} is turning its ads on right now: cancel_plan with plan_id ${gp.key} stops it before the next item (ask the person first). What it already turned on stays on: to turn those off, use plan_changes with set_status PAUSED, then confirm_plan after the person's yes.`
      : `${msg} Its ads are ON: plan ${gp.key} already turned them on, and stopping does not turn them off. To turn them off, use plan_changes with set_status PAUSED, then confirm_plan after the person's yes.`;
  }
  return msg;
}

// ---------- Delivery (delivery_status) ----------

interface DeliveryRow { kind: string; id: string; name: string; status?: string; plain: string; learning: string | null; issues: string[]; inAdset?: { id: string; name: string } }

/** Most rows delivery_status lists; a bigger answer lists the problems first and counts the rest. */
const DELIVERY_ROWS = 60;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const hasProblem = (x: DeliveryRow) => x.issues.length > 0 || /^(DISAPPROVED|WITH_ISSUES|NOT_FOUND|PENDING_BILLING_INFO)$/.test(x.status ?? "") || /rejected|not found|not delivering|with issues/i.test(x.plain);

function deliveryRowText(x: DeliveryRow, indent: boolean): string {
  // An ad from another ad set (one a plan edited) is never indented under the ad set above it.
  const label = x.kind === "campaign" ? "Campaign" : x.kind === "adset" ? "Ad set" : indent && !x.inAdset ? "  Ad" : "Ad";
  const issues = x.issues.join("; ");
  const where = x.inAdset ? ` (in ad set ${x.inAdset.name ? `"${x.inAdset.name}"` : x.inAdset.id})` : "";
  return `${label}${x.name ? ` "${x.name}"` : ""} (${x.id})${where}: ${x.plain}${x.learning ? ` · ${x.learning}` : ""}${issues ? ` · ${clip(issues, 400)}` : ""}`;
}

/** "rejected: 1,460, in review: 12" */
function countByStatus(rows: DeliveryRow[]): string {
  const n = new Map<string, number>();
  for (const x of rows) n.set(x.plain, (n.get(x.plain) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}: ${c.toLocaleString("en-IN")}`).join(", ");
}

/**
 * The delivery rows as text. Up to DELIVERY_ROWS rows: every one, ads under their ad set. More (a big
 * campaign has thousands of ads): the ad sets and ads with problems first, then counts of the rest by
 * status, and how to narrow. Never a cut list without saying so.
 */
function deliveryText(rows: DeliveryRow[]): string {
  if (rows.length <= DELIVERY_ROWS) return rows.map((x) => deliveryRowText(x, true)).join("\n");
  const others = rows.filter((x) => x.kind !== "ad");
  const ads = rows.filter((x) => x.kind === "ad");
  const byProblem = (list: DeliveryRow[]) => [...list.filter(hasProblem), ...list.filter((x) => !hasProblem(x))];
  const sets = byProblem(others).slice(0, 20);
  // Only the ads with a problem are listed; the others are counted by status.
  const problemAds = ads.filter(hasProblem);
  const shownAds = problemAds.slice(0, DELIVERY_ROWS - sets.length);
  const setCount = others.filter((x) => x.kind === "adset").length;
  const out = [`${setCount.toLocaleString("en-IN")} ad set(s) and ${ads.length.toLocaleString("en-IN")} ads: too many to list. Problems are listed first; the rest are counted at the end.`];
  out.push(...sets.map((x) => deliveryRowText(x, false)));
  if (shownAds.length) out.push(`Ads (${problemAds.length.toLocaleString("en-IN")} with problems):`, ...shownAds.map((x) => deliveryRowText(x, false)));
  const restSets = others.filter((x) => !sets.includes(x));
  const restAds = ads.filter((x) => !shownAds.includes(x));
  if (restSets.length) out.push(`Not listed: ${restSets.length.toLocaleString("en-IN")} more ad set(s) (${countByStatus(restSets)}).`);
  if (restAds.length) out.push(`Not listed: ${restAds.length.toLocaleString("en-IN")} more ads (${countByStatus(restAds)}).`);
  out.push("To see one ad set with all its ads, give adset (its name or ID); for one ad, give ad (its ID). Ads Manager and the Campaigns page in the app show every ad.");
  return out.join("\n");
}

/** "ad set "November test ad set" (ID as1)", saying when only a part of the name was given. */
function foundText(kind: "campaign" | "adset", f: Found, given: string): string {
  const word = kind === "campaign" ? "campaign" : "ad set";
  if (!f.name) return `${word} ${f.id}`;
  return `${word} "${f.name}" (ID ${f.id})${f.part ? `, the only ${word} whose name contains "${given.trim()}"` : ""}`;
}

export function registerManageTools(server: McpServer, api: LauncherApi) {
  server.registerTool(
    "connection_status",
    {
      title: "What the launcher is connected to",
      description:
        "Shows the connected Meta ad account (name, ID), the Facebook Page and Instagram account in use (name, ID, profile picture link, direct link, and whether the ad account may use that Instagram account), and when the Meta login expires (IST). Call this before every preview and launch, and include it in the pre-launch summary so the person can check the right accounts are used.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(async () => connectionText(await api.call<Connection>("GET", "/api/connection"))),
  );

  server.registerTool(
    "list_instagram_accounts",
    {
      title: "Facebook Pages and Instagram accounts the ad account may use",
      description: "The Facebook Pages this ad account can promote and the Instagram accounts it may advertise with (name, ID, link). An Instagram account not in this list makes Meta refuse the ads (code 1815199); then set the settings preset's Instagram to one in the list, or to none.",
      inputSchema: { refresh: z.boolean().optional().describe("Read Meta again instead of the 30-minute cache") },
      annotations: { readOnlyHint: true },
    },
    async ({ refresh }) =>
      run(async () => {
        const r = await api.call<{ pages: { id: string; name: string; link: string }[]; instagram: { id: string; username: string; link: string }[]; instagramKnown: boolean; pagesKnown?: boolean }>("GET", `/api/identities${refresh ? "?refresh=1" : ""}`);
        const out = ["Facebook Pages:", ...(r.pages.length ? r.pages.map((p) => `  - ${p.name} (ID ${p.id}) · ${p.link}`) : [r.pagesKnown === false ? "  Meta didn't answer the Page list just now. Try again with refresh: true." : "  none"])];
        out.push("Instagram accounts this ad account may advertise with:");
        if (!r.instagramKnown) out.push("  Meta didn't answer the Instagram list just now, so nothing is blocked on it. Try again with refresh: true.");
        else if (!r.instagram.length) out.push("  none (ads show the Facebook Page on Instagram). To add one: Meta Business settings → Accounts → Instagram accounts → Assign assets → the ad account.");
        else for (const i of r.instagram) out.push(`  - @${i.username} (ID ${i.id}) · ${i.link}`);
        return out.join("\n");
      }),
  );

  server.registerTool(
    "get_safety_settings",
    {
      title: "Safety settings (read only)",
      description: "The daily budget ceiling (no batch or plan may let more than this spend per day), whether failure alerts are emailed, and how the last backup went. Claude can read these but never change them: they change only in the app, Settings → Safety.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const r = await api.call<{ dailyBudgetCeiling: number; currency?: string | null; alertEmails: boolean; backup?: { lastBackupAt: string | null; offsite: boolean; lastOffsiteAt: string | null; message: string; warning: string | null } }>("GET", "/api/settings");
        const amount = (x: number) => (r.currency === "INR" ? `₹${x.toLocaleString("en-IN")}` : r.currency ? `${r.currency} ${x.toLocaleString("en-IN")}` : `${x.toLocaleString("en-IN")} (in the ad account's currency)`);
        const out = [
          `Daily budget ceiling: ${r.dailyBudgetCeiling ? `${amount(r.dailyBudgetCeiling)} a day. A launch or plan that would let more than this spend per day is refused.` : "none set (no limit on what a launch or plan may let spend per day)."}`,
          `Failure alerts by email: ${r.alertEmails ? "on" : "off"} (alerts always show on the home page; list_alerts reads them).`,
        ];
        if (r.backup) {
          const b = r.backup;
          out.push(`Backup: ${b.lastBackupAt ? `last one ${istLabel(b.lastBackupAt)}` : "none yet"}${b.lastOffsiteAt ? `; last copy outside the server ${istLabel(b.lastOffsiteAt)}` : ""}. ${b.message}`);
          if (b.warning) out.push(`BACKUP WARNING: ${b.warning}`);
        }
        out.push("These change only in the app: Settings → Safety.");
        return out.join("\n");
      }),
  );

  server.registerTool(
    "list_alerts",
    {
      title: "Failure alerts",
      description: "The failure alerts of the last 14 days shown on the launcher's home page (a launch or plan that failed, ads created but not turned on, a missing backup…), newest first, with the link to the page that shows the details.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const r = await api.call<{ alerts: { subject: string; lines: string[]; link: string; at: string; count?: number }[] }>("GET", "/api/alerts");
        if (!r.alerts.length) return "No failure alerts in the last 14 days.";
        const out = r.alerts.map((a) => `- ${istLabel(a.at)}: ${a.subject}${a.count && a.count > 1 ? ` (${a.count} times)` : ""}\n  ${a.lines.join(" ")}\n  ${a.link}`);
        // The launcher sends the newest 10 (as its home page shows them); older ones of the 14 days may exist.
        if (r.alerts.length >= ALERTS_SHOWN) out.push(`(Only the ${r.alerts.length} newest alerts are listed; older ones from the last 14 days may exist and are not shown.)`);
        return out.join("\n");
      }),
  );

  // ---------- Templates and presets ----------

  type CopyT = { id: number; name: string; primaryTexts: string[]; headlines: string[]; descriptions: string[]; cta: string; linkUrl: string; utmTemplate: string; displayLink?: string; leadFormId?: string };
  type PresetT = { id: number; name: string; pageId: string; pageName: string; igUserId: string; igName: string; enhancementsOn: string[]; multiAdvertiser: boolean; whatsappNumber?: string; threadsUserId?: string; sponsorPageId?: string; isDefault: boolean };
  type Templates = { copy: CopyT[]; presets: PresetT[]; features: { key: string; label: string }[]; naming: { id: number; name: string; kind: "ad" | "adset" | "campaign"; pattern: string; is_default: number }[] };

  /** The saved item named by its id or exact name (any case). Close names are listed, never guessed. */
  function pick<T extends { id: number; name: string }>(list: T[], given: string, what: string): T {
    const q = given.trim();
    const hit = list.find((x) => String(x.id) === q.replace(/^#/, "")) ?? list.find((x) => x.name.trim().toLowerCase() === q.toLowerCase());
    if (hit) return hit;
    const near = list.filter((x) => x.name.toLowerCase().includes(q.toLowerCase()));
    throw new Error(near.length ? `No ${what} is called exactly "${given}". Did you mean ${near.map((x) => `"${x.name}" (id ${x.id})`).join(" or ")}? Give its exact name or id.` : `No ${what} "${given}". Saved ones: ${list.map((x) => `"${x.name}"`).join(", ") || "none"}.`);
  }
  const sameName = <T extends { name: string }>(list: T[], name?: string) => (name?.trim() ? list.find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase()) : undefined);

  server.registerTool(
    "save_copy_template",
    {
      title: "Create or edit a copy template",
      description:
        "Create a copy template, or edit one: give template (its id or exact name), or a name that already exists. When editing, fields left out keep their saved value and \"\" (or []) clears a field. Up to 5 primary texts, 5 headlines and 5 descriptions. utm_template is added to every ad's link; Meta fills {{campaign.name}}, {{adset.name}}, {{ad.name}}, {{ad.id}} itself. New templates get UTM tags by default. The answer shows everything saved.",
      inputSchema: {
        template: z.string().optional().describe("Id or exact name of the template to edit. Leave out to create one (a name that already exists edits that one)."),
        name: z.string().optional().describe("Name; with template, a new name for it"),
        primary_texts: z.array(z.string()).max(5).optional(),
        headlines: z.array(z.string()).max(5).optional(),
        descriptions: z.array(z.string()).max(5).optional().describe("Up to 5 descriptions (the line under the headline); Meta rotates them like the headlines."),
        description: z.string().optional().describe('One description: same as descriptions ["…"]. Use descriptions for several.'),
        link_url: z.string().optional(),
        cta: z.string().optional().describe("Call to action, e.g. LEARN_MORE, SIGN_UP, GET_QUOTE, BOOK_NOW, CONTACT_US, WHATSAPP_MESSAGE"),
        utm_template: z.string().optional(),
        display_link: z.string().optional().describe("Short link shown on the ad, e.g. sahajta.com/visit"),
        lead_form_id: z.string().optional().describe("Instant form the button opens (lookup lead_forms). Needed for ad sets that collect leads with an Instant form."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) =>
      run(async () => {
        const before = await api.call<Templates>("GET", "/api/templates");
        const cur = a.template ? pick(before.copy, a.template, "copy template") : sameName(before.copy, a.name);
        const body = {
          kind: "copy",
          id: cur?.id,
          name: a.name,
          primaryTexts: a.primary_texts,
          headlines: a.headlines,
          ...(a.descriptions !== undefined ? { descriptions: a.descriptions } : a.description !== undefined ? { descriptions: [a.description] } : {}),
          cta: a.cta,
          linkUrl: a.link_url,
          utmTemplate: a.utm_template,
          displayLink: a.display_link,
          leadFormId: a.lead_form_id,
        };
        const r = await api.call<{ id: number }>("POST", "/api/templates", body);
        const c = (await api.call<Templates>("GET", "/api/templates")).copy.find((x) => x.id === r.id);
        if (!c) return `Saved copy template (id ${r.id}).`;
        return [
          `${cur ? "Updated" : "Created"} copy template "${c.name}" (id ${c.id}): ${c.primaryTexts.length} primary text(s), ${c.headlines.length} headline(s), ${c.descriptions.length} description(s), ${c.cta} → ${c.linkUrl || "no link"}.`,
          `Primary texts: ${c.primaryTexts.map((x, i) => `${i + 1}. "${x}"`).join(" ") || "none"}`,
          `Headlines: ${c.headlines.map((x, i) => `${i + 1}. "${x}"`).join(" ") || "none"}`,
          `Descriptions: ${c.descriptions.map((x, i) => `${i + 1}. "${x}"`).join(" ") || "none"}`,
          `Display link: ${c.displayLink || "none"} · Lead form: ${c.leadFormId || "none"}`,
          `UTM tags: ${c.utmTemplate || "none"}${!cur && a.utm_template === undefined && c.utmTemplate ? " (the default for new templates)" : ""}`,
        ].join("\n");
      }),
  );

  server.registerTool(
    "save_naming_template",
    {
      title: "Create or edit a naming template",
      description:
        "Naming templates for ads, ad sets and campaigns. Words in braces are filled in: {date} (also {date:YYMMDD}), {n} (auto-number 01, 02…), {creative}, {angle}, {persona}, {format}, {campaign}, {adset}, {objective}, {budget}, {copy}, {batch}. Give template (id or exact name) to edit one; fields left out keep their value.",
      inputSchema: {
        template: z.string().optional(),
        kind: z.enum(["ad", "adset", "campaign"]).optional(),
        name: z.string().optional(),
        pattern: z.string().optional().describe('e.g. "{date}_{persona}_{angle}_{n}"'),
        is_default: z.boolean().optional().describe("Use for new batches and plans by default"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) =>
      run(async () => {
        const t = await api.call<Templates>("GET", "/api/templates");
        const cur = a.template ? pick(t.naming, a.template, "naming template") : undefined;
        const body = { kind: "naming", id: cur?.id, namingKind: a.kind ?? cur?.kind ?? "ad", name: a.name ?? cur?.name ?? "", pattern: a.pattern ?? cur?.pattern ?? "", isDefault: a.is_default };
        const r = await api.call<{ id: number }>("POST", "/api/templates", body);
        return `${cur ? "Updated" : "Created"} ${body.namingKind} naming template "${body.name}" (id ${r.id}): ${body.pattern}${a.is_default ? " (default)" : ""}.`;
      }),
  );

  server.registerTool(
    "save_settings_preset",
    {
      title: "Create or edit a settings preset",
      description:
        "Ad-level Meta settings used for every ad of a batch: Facebook Page, Instagram account, each Advantage+ creative enhancement on or off, multi-advertiser ads, WhatsApp number, Threads account and partner Page. The partner Page is what Ads Manager calls \"Branded content\" (or \"Branding\"): the sponsor's Page of a paid partnership; give it as partner_page_id (branded_content_partner and branding are the same field). Give preset (id or exact name), or a name that already exists, to edit one; fields left out keep their value and \"\" clears one (WhatsApp, Threads, partner Page). list_templates shows the enhancement keys. Use connection_status / list_instagram_accounts for Page and Instagram IDs. The answer shows everything saved.",
      inputSchema: {
        preset: z.string().optional().describe("Id or exact name of the preset to edit"),
        name: z.string().optional(),
        page_id: z.string().optional(),
        page_name: z.string().optional(),
        instagram_id: z.string().optional().describe('Instagram account ID, or "none" to use the Facebook Page on Instagram'),
        instagram_username: z.string().optional(),
        enhancements_on: z.array(z.string()).optional().describe("Enhancement keys to switch ON. Every other one is sent OFF. [] = all off."),
        switch_on: z.array(z.string()).optional().describe("Switch these on, keep the rest as they are"),
        switch_off: z.array(z.string()).optional().describe("Switch these off, keep the rest as they are"),
        multi_advertiser: z.boolean().optional(),
        whatsapp_number: z.string().optional().describe("For 'Send WhatsApp message' buttons, with country code, e.g. +919812345678 (\"\" = none)"),
        threads_account_id: z.string().optional().describe("Threads account ID shown on Threads placements (\"\" = none)"),
        partner_page_id: z.string().optional().describe("Branded content / partnership ad ('Paid partnership' label): the partner's (sponsor's) Facebook Page ID. This is the field Ads Manager calls \"Branded content\" or \"Branding\". That Page needs a linked Instagram account (\"\" = none)"),
        branded_content_partner: z.string().optional().describe("Same as partner_page_id (Ads Manager's \"Branded content\" partner Page ID)"),
        branding: z.string().optional().describe("Same as partner_page_id (Ads Manager's \"Branding\" / branded content partner Page ID)"),
        is_default: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) =>
      run(async () => {
        const t = await api.call<Templates>("GET", "/api/templates");
        const cur = a.preset ? pick(t.presets, a.preset, "settings preset") : sameName(t.presets, a.name);
        let enhancements: Record<string, "OPT_IN"> | undefined;
        if (a.enhancements_on || a.switch_on || a.switch_off) {
          const on = new Set(a.enhancements_on ?? cur?.enhancementsOn ?? []);
          for (const k of a.switch_on ?? []) on.add(k);
          for (const k of a.switch_off ?? []) on.delete(k);
          enhancements = Object.fromEntries([...on].map((k) => [k, "OPT_IN" as const]));
        }
        const noIg = a.instagram_id?.trim().toLowerCase() === "none";
        // Ads Manager's "Branded content" / "Branding" partner is the partner Page: one field, three names.
        const given = [a.partner_page_id, a.branded_content_partner, a.branding].filter((x): x is string => x !== undefined);
        if (new Set(given.map((x) => x.trim())).size > 1) throw new Error(`partner_page_id, branded_content_partner and branding are the same field (the branded content partner Page), but different values were given: ${given.map((x) => `"${x}"`).join(", ")}. Give one.`);
        const partner = given[0];
        const body = {
          kind: "preset",
          id: cur?.id,
          name: a.name,
          pageId: a.page_id,
          pageName: a.page_name,
          igUserId: noIg ? "" : a.instagram_id,
          // A new Instagram account without its username: the old username is not kept (the launcher looks the new one up).
          igName: noIg ? "" : (a.instagram_username ?? (a.instagram_id !== undefined && a.instagram_id.trim() !== (cur?.igUserId ?? "") ? "" : undefined)),
          enhancements,
          multiAdvertiser: a.multi_advertiser,
          whatsappNumber: a.whatsapp_number,
          threadsUserId: a.threads_account_id,
          sponsorPageId: partner,
          isDefault: a.is_default,
        };
        const r = await api.call<{ id: number }>("POST", "/api/templates", body);
        const after = await api.call<Templates>("GET", "/api/templates");
        const p = after.presets.find((x) => x.id === r.id);
        if (!p) return `Saved preset (id ${r.id}).`;
        const labels = new Map(after.features.map((f) => [f.key, f.label]));
        return [
          `${cur ? "Updated" : "Created"} preset "${p.name}" (id ${p.id})${p.isDefault ? " (default)" : ""}.`,
          `Facebook Page: ${p.pageName || p.pageId || "not set"}${p.pageId ? ` (ID ${p.pageId})` : ""}. Instagram: ${p.igName ? `@${p.igName}` : p.igUserId ? `ID ${p.igUserId}` : "none (the Facebook Page is used on Instagram)"}${p.igName && p.igUserId ? ` (ID ${p.igUserId})` : ""}.`,
          `Enhancements ON: ${p.enhancementsOn.map((k) => labels.get(k) ?? k).join("; ") || "none (all off)"}. Multi-advertiser ads ${p.multiAdvertiser ? "on" : "off"}.`,
          `WhatsApp number: ${p.whatsappNumber || "none"}. Threads account: ${p.threadsUserId || "none"}. Partner Page (paid partnership): ${p.sponsorPageId || "none"}. (The partner Page is what Ads Manager calls "Branded content".)`,
        ].join("\n");
      }),
  );

  // ---------- Batch control ----------

  server.registerTool(
    "set_ad_copy",
    {
      title: "Set copy per ad in a batch",
      description:
        "Give ads in a batch their own copy and settings: primary texts (up to 5), headlines (up to 5), descriptions (up to 5), link, display link, call to action, lead form, UTM tags, Advantage+ enhancements on, multi-advertiser, carousel, angle. Each row names the ad by its number in the preview or by creative / file name, and changes only the fields it gives: fields left out keep the ad's current value (its own, or the batch's template and preset); \"\" or [] clears a field so the batch copy is used again; format and lead form stay unless given. All rows are saved, or none (the error names the row). Works before launch, and after launch for ads that were not created (retry_failed then creates them with the new copy).",
      inputSchema: {
        batch_id: z.string(),
        rows: z
          .array(
            z.object({
              ad: z.union([z.string(), z.number()]).describe("Ad number or creative/file name"),
              primary_texts: z.array(z.string()).max(5).optional(),
              headlines: z.array(z.string()).max(5).optional(),
              descriptions: z.array(z.string()).max(5).optional().describe("Up to 5 descriptions (the line under the headline)"),
              description: z.string().optional().describe('One description: same as descriptions ["…"]'),
              link_url: z.string().optional(),
              cta: z.string().optional(),
              display_link: z.string().optional(),
              lead_form_id: z.string().optional(),
              utm_template: z.string().optional(),
              enhancements_on: z.array(z.string()).optional().describe("Advantage+ enhancements switched ON for this ad only (others off)"),
              multi_advertiser: z.boolean().optional(),
              format: z.enum(["single", "carousel"]).optional().describe("carousel: every file of this ad becomes a card (2 to 10); single: back to one file or a 9:16 + 4:5 pair"),
              angle: z.string().optional(),
            }),
          )
          .min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ batch_id, rows }) =>
      run(async () => {
        const body = {
          rows: rows.map((r) => {
            // Only the fields given: the server keeps the rest of the ad's copy as it is.
            const fields: Record<string, unknown> = {
              primaryTexts: r.primary_texts,
              headlines: r.headlines,
              descriptions: r.descriptions ?? (r.description !== undefined ? [r.description] : undefined),
              linkUrl: r.link_url,
              cta: r.cta,
              displayLink: r.display_link,
              leadFormId: r.lead_form_id,
              utmTemplate: r.utm_template,
              enhancements: r.enhancements_on ? Object.fromEntries(r.enhancements_on.map((k) => [k, "OPT_IN"])) : undefined,
              multiAdvertiser: r.multi_advertiser,
              format: r.format,
            };
            const copy = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
            return { ad: r.ad, ...(r.angle !== undefined ? { angle: r.angle } : {}), ...(Object.keys(copy).length ? { copy } : {}) };
          }),
        };
        const v = await api.call<{ status?: string }>("POST", `/api/batches/${batch_id}/copy`, body);
        if (!v.status || v.status === "draft") return `Saved copy for ${rows.length} ad(s) in batch ${batch_id}. Run preview_batch with batch_id to see the result.`;
        return `Saved copy for ${rows.length} ad(s) in batch ${batch_id}. Those ads are not in Meta yet: retry_failed creates them with the new copy. (Ads already in Meta change only through plan_changes with edit_ad.)`;
      }),
  );

  server.registerTool(
    "regroup_files",
    {
      title: "Move a file to another ad",
      description: "Change which files go together in one ad (e.g. which 9:16 and 4:5 versions pair up) in a draft batch. Move a file into ad number N, or into an ad of its own.",
      inputSchema: { batch_id: z.string(), file: z.string().describe("File name, e.g. hook-01_4x5.mp4"), to: z.union([z.number(), z.string()]).describe('Ad number, or "new" for an ad of its own') },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ batch_id, file, to }) =>
      run(async () => {
        const t = String(to).trim().toLowerCase();
        const target = t === "new" ? "new" : Number(t.replace(/^(ad\s*)?#?/, ""));
        if (target !== "new" && !(Number.isInteger(target) && target > 0)) throw new Error(`to must be an ad number or "new", not "${to}".`);
        await api.call("POST", `/api/batches/${batch_id}/regroup`, { file, to: target });
        return `Moved ${file} ${target === "new" ? "into an ad of its own" : `into ad ${target}`}. Run preview_batch with batch_id ${batch_id} to see the new grouping.`;
      }),
  );

  server.registerTool(
    "retry_failed",
    {
      title: "Retry the failed ads of a batch",
      description:
        "Create the ads of a batch that failed or were not reached. Ads already created are never made again. Fix the cause first (batch_status shows it); settings_preset or copy_template (name or id) switch the ads not created yet to another preset or copy template (e.g. a preset without Instagram after Meta refused the Instagram account). " +
        "THIS CAN TURN ADS ON AND SPEND MONEY: when the batch was launched to turn its ads on (go live now or at a time) and they are not on yet, the ads are turned on once every ad is in, and then their ad sets' daily budgets can spend. Ask the person first and say so (batch_status shows the batch). " +
        "The yes typed at launch is used only while it still holds: after a Stop, long after the launch, or when what can spend changed since (budgets raised), the plan that turns the ads on is saved as a draft instead; then the person checks it with plan_status and types the new amount themselves.",
      inputSchema: {
        batch_id: z.string(),
        settings_preset: z.string().optional().describe("Settings preset (name or id) for the ads not created yet"),
        copy_template: z.string().optional().describe("Copy template (name or id) for the ads not created yet"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ batch_id, settings_preset, copy_template }) =>
      run(async () => {
        type V = {
          key: string;
          progress: { total: number; done: number };
          settings?: { goLive?: string; goLiveAt?: string | null };
          goLivePlan?: { key: string; status: string; runAt: string | null } | null;
          goLiveHold?: string | null;
          retry?: { retried: number; goLive: boolean; message: string };
        };
        let v: V;
        try {
          v = await api.call<V>("POST", `/api/batches/${batch_id}/retry`, { presetId: settings_preset, copyTemplateId: copy_template });
        } catch (e) {
          throw forThePerson(e, "batch_status");
        }
        const lines = [`Batch ${v.key}: ${v.retry?.message ?? `retrying ${v.progress.total - v.progress.done} ad(s).`} Use batch_status to follow it.`];
        const msg = v.retry?.message ?? "";
        const gp = v.goLivePlan;
        const onAlready = gp && ["running", "done", "partial"].includes(gp.status);
        if (v.settings?.goLive && v.settings.goLive !== "paused" && !onAlready) {
          if (v.goLiveHold || /NOT turned on/.test(msg)) {
            // The yes given at launch no longer holds: nothing turns on until the person confirms again.
            const said = /NOT turned on/.test(msg);
            lines.push(
              `${said ? "" : `The ads are NOT turned on by this retry${v.goLiveHold ? ` (${v.goLiveHold})` : ""}. `}Once every ad is in, the plan that turns them on is saved as a draft: batch_status names it, plan_status shows its summary. Show it to the person; they type the amount that can spend themselves, then confirm_plan. Never fill in that amount yourself.`,
            );
          } else {
            lines.push(
              `This turns the ads on: once every ad is in, they are turned on${v.settings.goLive === "at" && v.settings.goLiveAt ? ` (at ${istLabel(v.settings.goLiveAt)})` : ""} and their ad sets' daily budgets can spend, as the person confirmed at launch.${/draft/i.test(msg) ? "" : " If budgets were raised since, the plan that turns them on is saved as a draft instead, and the person types the new amount themselves."} Make sure the person knows; if they don't want the ads on, cancel_batch stops it now.`,
            );
          }
        }
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "cancel_batch",
    {
      title: "Stop a running launch",
      description: "Stop a batch that is launching, and the launches into other ad sets made with it (same ads). It stops after the current step; ads already created stay (paused) and are not turned on; a plan still waiting to turn them on is cancelled too; nothing is deleted. The answer names every batch and turn-on plan stopped, and says when ads were already turned on (Stop does not turn them off). retry_failed continues a batch later.",
      inputSchema: { batch_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ batch_id }) =>
      run(async () => {
        type Stopped = { key: string; adsetName: string | null; result: "cancelled" | "stopping" | "turn_on_cancelled" | "turn_on_stopping" | "already_on"; planKey?: string; message?: string };
        let v: { key: string; status: string; progress: { done: number; total: number }; cancelled?: Stopped[] };
        try {
          v = await api.call<typeof v>("POST", `/api/batches/${batch_id}/cancel`);
        } catch (e) {
          // Nothing is launching. A plan may still be waiting to turn the ads on: say which, and how to stop it.
          throw new Error(await turnOnAfterRefusal(e, batch_id, api));
        }
        const list = v.cancelled ?? [];
        /** What happened to the turn-on of a batch whose ads were all in already. */
        const offWith = "to turn them off, use plan_changes with set_status PAUSED, then confirm_plan after the person's yes";
        /** What happened to the turn-on of a batch that is not launching any more (its ads are in, or it ended).
         *  One plan turns on every ad set of a launch: its sentence is said once, then only referred to. */
        const said = new Set<string>();
        const turnOn = (x: Stopped) => {
          const k = `${x.result}:${x.planKey ?? ""}`;
          if (x.planKey && said.has(k)) return `the same plan (${x.planKey}), as above.`;
          said.add(k);
          if (x.result === "turn_on_cancelled") {
            return x.planKey
              ? `the plan that was to turn its ads on (${x.planKey}) is now cancelled, so they stay paused.`
              : "the yes given at launch no longer turns its ads on, so the ads created stay paused (after retry_failed, the plan that turns them on is saved as a draft for the person to confirm).";
          }
          if (x.result === "turn_on_stopping") return `the plan that turns its ads on (${x.planKey ?? "?"}) was already running: it stops now, before the next item. What it already turned on stays on: ${offWith}.`;
          return `its ads are ON: ${x.planKey ? `plan ${x.planKey}` : "the turn-on plan"} already turned them on, and Stop does not turn them off. To turn them off, use plan_changes with set_status PAUSED, then confirm_plan after the person's yes.`;
        };
        const own = list.find((x) => x.key === v.key);
        const lines: string[] = [];
        if (own && own.result !== "cancelled" && own.result !== "stopping") lines.push(`Batch ${v.key} (${v.progress.done} of ${v.progress.total} ads created): ${turnOn(own)}`);
        else {
          const stopping = own ? own.result === "stopping" : v.status === "running";
          lines.push(`Batch ${v.key}: ${stopping ? "stopping after the current step" : "stopped"}. ${v.progress.done} of ${v.progress.total} ads were created and stay paused.`);
        }
        for (const x of list.filter((x) => x.key !== v.key)) {
          const who = `batch ${x.key} (same ads, ad set "${x.adsetName ?? "?"}")`;
          if (x.result === "stopping") lines.push(`Also stopping after its current step: ${who}.`);
          else if (x.result === "cancelled") lines.push(`Also stopped: ${who}.`);
          else lines.push(`Also ${who}: ${turnOn(x)}`);
        }
        return lines.join("\n");
      }),
  );

  // ---------- Campaigns, ad sets, plans ----------

  server.registerTool(
    "list_campaigns",
    {
      title: "Campaigns and ad sets with budgets",
      description: "Every campaign (not deleted) with its ad sets: status, budget (campaign or ad set), an ad set's spend limits (minimum and maximum spend), bid, schedule, goal, audience and placements in plain words, plus IDs to use in plans. Long lists are cut: give campaign to narrow.",
      inputSchema: { campaign: z.string().optional().describe("Only campaigns whose name or id contains this"), refresh: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ campaign, refresh }) =>
      run(async () => {
        const t = await api.call<Tree>("GET", `/api/manage/tree${refresh ? "?refresh=1" : ""}`);
        const q = campaign?.trim().toLowerCase();
        const list = t.campaigns.filter((c) => !q || c.id === q || c.name.toLowerCase().includes(q));
        if (!list.length) return "No campaigns found.";
        const out: string[] = [];
        let adsetLines = 0;
        let shown = 0;
        for (const c of list) {
          if (shown >= 60 || adsetLines >= 150) break;
          shown++;
          out.push(`Campaign "${c.name}" (id ${c.id}) · ${c.status.toLowerCase()} · ${c.details.objective} · budget ${c.details.budget} · bid ${c.details.bid}`);
          const sets = c.adsets.slice(0, Math.max(0, 150 - adsetLines));
          for (const a of sets) out.push(`  - Ad set "${a.name}" (id ${a.id}) · ${a.status.toLowerCase()} · ${a.details.budget}${a.details.spendLimits ? ` · spend limits: ${a.details.spendLimits}` : ""} · ${a.details.bid} · ${a.details.schedule} · goal ${a.details.goal} · audience ${a.details.audience} · placements ${a.details.placements}`);
          adsetLines += sets.length;
          if (sets.length < c.adsets.length) out.push(`  (${c.adsets.length - sets.length} more ad sets in this campaign not shown; call list_campaigns with campaign: "${c.name}")`);
        }
        if (shown < list.length) out.push(`(${list.length - shown} more campaigns not shown; give campaign to narrow the list.)`);
        return out.join("\n");
      }),
  );

  /** "IMG2.png" / "image IMG2.png, image IMG2_4x5.png" / "video 1234 (name not known)". */
  const fileText = (files?: { kind: "image" | "video"; id: string; name: string | null }[]) =>
    files?.length ? files.map((f) => (f.name ? `${f.kind} ${f.name}` : `${f.kind} ${f.id} (name not known)`)).join(", ") : "–";

  server.registerTool(
    "list_ads",
    {
      title: "Ads in an ad set",
      description: "The ads of one ad set (by ID or name): ID, name, on/off (on or paused) and Meta's review state apart (e.g. \"paused · in review\"), texts, headlines, descriptions, button, the image or video file (by file name), link, display link, UTM tags, and the Facebook post ID / Instagram media ID behind each (up to 100 ads). Use it to check an ad after edit_ad or copy_ad: still paused, the new texts, button and file. Reuse a post with ads_from_post by its Facebook post ID (the Instagram media ID of an ad's post is for reference; Meta refuses it). Also for copy_ad and edit_ad.",
      inputSchema: { adset: z.string().describe("Ad set ID or name") },
      annotations: { readOnlyHint: true },
    },
    async ({ adset }) =>
      run(async () => {
        const f = await idOf(api, "adset", adset);
        type Ad = { id: string; name: string; status: string; effectiveStatus: string; onOff?: string; review?: string; fromPost: boolean; postId: string | null; instagramMediaId: string | null; primaryTexts: string[]; headlines: string[]; descriptions?: string[]; displayLink?: string | null; link: string | null; button?: string | null; utmTags?: string | null; files?: { kind: "image" | "video"; id: string; name: string | null }[] };
        const r = await api.call<{ ads: Ad[]; truncated?: boolean; note?: string | null }>("GET", `/api/manage/ads?adset=${encodeURIComponent(f.id)}`);
        const which = foundText("adset", f, adset);
        if (!r.ads.length) return `No ads in ${which}.`;
        const lines = [`Ads in ${which}:`];
        // The ad's own on/off setting and Meta's review state apart: "paused · in review".
        const state = (a: Ad) => `${a.onOff ?? a.status.toLowerCase()} · ${a.review ?? a.effectiveStatus.toLowerCase().replace(/_/g, " ")}`;
        lines.push(
          ...r.ads.map(
            (a) =>
              `- "${a.name}" (id ${a.id}) · ${state(a)}${a.fromPost ? " · runs an existing post" : ""} · post ID ${a.postId ?? "–"} · Instagram media ID ${a.instagramMediaId ?? "–"}\n  texts: ${a.primaryTexts.map((t) => `"${t.slice(0, 80)}"`).join(" | ") || "–"}\n  headlines: ${a.headlines.join(" | ") || "–"}\n  descriptions: ${a.descriptions?.map((d) => `"${d}"`).join(" | ") || "–"}\n  button: ${a.button ? a.button.replace(/_/g, " ").toLowerCase() : "–"} · file: ${fileText(a.files)}\n  link: ${a.link ?? "–"} · display link: ${a.displayLink ?? "–"} · UTM tags: ${a.utmTags || "–"}`,
          ),
        );
        if (r.truncated || r.note) lines.push(r.note ?? "Only the first ads of this ad set are listed.");
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "delivery_status",
    {
      title: "Is it delivering? Review, learning and problems",
      description: "After launch: per ad set and ad, whether it is delivering, in review, approved, rejected (with Meta's reason), learning / learning limited, or not delivering and why. Give a batch_id, a plan_id, a campaign (ID or name), an ad set (ID or name) or an ad ID.",
      inputSchema: { batch_id: z.string().optional(), plan_id: z.string().optional(), campaign: z.string().optional().describe("Campaign ID or name"), adset: z.string().optional().describe("Ad set ID or name"), ad: z.string().optional().describe("Ad ID") },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      run(async () => {
        let path = "";
        /** What was asked for, for an answer with no rows. */
        let empty = "";
        if (a.batch_id) {
          path = `/api/batches/${encodeURIComponent(a.batch_id.trim())}/delivery`;
          empty = "Nothing created yet.";
        } else if (a.plan_id) {
          path = `/api/manage/delivery?plan=${encodeURIComponent(a.plan_id.trim())}`;
          empty = `Plan ${a.plan_id.trim()} has not made or changed any ad set or ad yet.`;
        } else if (a.campaign) {
          const f = await idOf(api, "campaign", a.campaign);
          path = `/api/manage/delivery?campaign=${encodeURIComponent(f.id)}`;
          empty = `No ad sets found in ${foundText("campaign", f, a.campaign)}: it has none, or it is not in this ad account (list_campaigns shows the campaigns).`;
        } else if (a.adset) {
          const f = await idOf(api, "adset", a.adset);
          path = `/api/manage/delivery?adset=${encodeURIComponent(f.id)}`;
          empty = `Nothing found for ${foundText("adset", f, a.adset)}: it is not in this ad account, or was deleted.`;
        } else if (a.ad) {
          path = `/api/manage/delivery?ad=${encodeURIComponent(a.ad.trim())}`;
          empty = `Nothing found for ad ${a.ad.trim()}: it is not in this ad account, or was deleted.`;
        }
        if (!path) throw new Error("Give batch_id, plan_id, campaign, adset or ad.");
        const r = await api.call<{ rows: DeliveryRow[] }>("GET", path);
        if (!r.rows.length) return empty;
        return deliveryText(r.rows);
      }),
  );

  server.registerTool(
    "ad_previews",
    {
      title: "See an ad before it is created",
      description: "Meta's own preview of one ad of a draft batch, per placement (Facebook and Instagram Feed, Stories, Reels): links that open how the ad will look. For image ads the image is uploaded to the ad account's image library (reused at launch); nothing else is created and no ad exists until the launch. Video ads work after their videos are uploaded (at launch).",
      inputSchema: { batch_id: z.string(), ad: z.union([z.number(), z.string()]).describe("Ad number or creative name") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ batch_id, ad }) =>
      run(async () => {
        const r = await api.call<{ ad: number; name: string; previews: { label: string; url: string | null; problem?: string }[] }>("GET", `/api/batches/${batch_id}/previews?ad=${encodeURIComponent(String(ad))}`);
        return [`Previews of ad ${r.ad} "${r.name}" (links work for about a day):`, ...r.previews.map((p) => `- ${p.label}: ${p.url ?? `not available (${p.problem ?? "Meta gave no preview"})`}`)].join("\n");
      }),
  );

  server.registerTool(
    "get_details",
    {
      title: "Every setting of a campaign or ad set",
      description: "All settings of one campaign or ad set, in plain words and as Meta's raw fields (targeting, promoted object, attribution, spend limits). An ad set's spend limits are in plain words too, in the ad account's currency (spendLimits, e.g. minimum ₹100 a day, maximum ₹500 a day).",
      inputSchema: { kind: z.enum(["campaign", "adset"]), id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, id }) =>
      run(async () => {
        const d = await api.call<{ plain: Record<string, string>; raw: unknown }>("GET", `/api/manage/object/${kind}/${encodeURIComponent((await idOf(api, kind, id)).id)}`);
        // An ad set without spend limits says so (the plain words list them only when set).
        const plain = kind === "adset" && !d.plain.spendLimits ? { ...d.plain, spendLimits: "none (no minimum or maximum spend)" } : d.plain;
        return `${Object.entries(plain).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nRaw: ${JSON.stringify(d.raw)}`;
      }),
  );

  server.registerTool(
    "list_options",
    {
      title: "Allowed values for campaigns and ad sets",
      description: "Objectives, bid strategies, special ad categories, conversion locations (destination), performance goals, website pixel events, attribution windows and placement platforms, with plain labels.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const o = await api.call<Record<string, { value: string; label: string; note?: string }[]>>("GET", "/api/manage/options");
        return Object.entries(o).map(([k, list]) => `${k}:\n${list.map((x) => `  ${x.value} = ${x.label}${x.note ? ` (${x.note})` : ""}`).join("\n")}`).join("\n");
      }),
  );

  server.registerTool(
    "lookup",
    {
      title: "Look up audiences, pixels, interests, locations",
      description: "IDs for plans: saved_audiences, custom_audiences (incl. lookalikes), pixels, custom_conversions, interests (search with q), locations (search with q: countries, regions, cities), languages (search with q), block_lists, pages, posts (the Pages' recent posts and the posts behind existing ads, with the Facebook post IDs to use in ads_from_post; Instagram-only organic posts aren't listed, Meta hasn't given the app that permission), lead_forms (instant forms). Up to 50 are shown; give q to narrow.",
      inputSchema: { what: z.enum(["saved_audiences", "custom_audiences", "pixels", "custom_conversions", "interests", "locations", "languages", "block_lists", "pages", "posts", "lead_forms"]), q: z.string().optional().describe("Search text (interests, locations, languages, posts) or a Page ID (posts, lead_forms)") },
      annotations: { readOnlyHint: true },
    },
    async ({ what, q }) =>
      run(async () => {
        const r = await api.call<{ items: Record<string, unknown>[] }>("GET", `/api/manage/lookup?what=${what}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
        if (!r.items.length) return "Nothing found.";
        const lines = r.items.slice(0, 50).map((i) => JSON.stringify(i.targeting ? { ...i, targeting: "(saved targeting)" } : i));
        if (r.items.length > 50) lines.push(`(Showing 50 of ${r.items.length}. Give q to narrow the list.)`);
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "plan_step_fields",
    {
      title: "The exact fields of a plan step",
      description:
        "Every field one kind of plan step takes (for plan_changes, update_plan and retry_plan): its exact name, type, allowed values and rules, and an example step. Call it before writing a step you are not sure of; any other field name is refused. Leave type out for the list of step types. Reads nothing in Meta.",
      inputSchema: { type: z.enum(STEP_TYPES as [StepType, ...StepType[]]).optional().describe("The step type, e.g. create_custom_audience") },
      annotations: { readOnlyHint: true },
    },
    async ({ type }) =>
      run(async () =>
        type
          ? stepFieldsText(type)
          : `Step types (plan_step_fields with type gives the fields of one):\n${STEP_TYPES.map((t) => `- ${t}: ${STEPS[t].what}`).join("\n")}`,
      ),
  );

  server.registerTool(
    "plan_changes",
    {
      title: "Plan changes to campaigns and ad sets (nothing runs yet)",
      description: `Create, duplicate and edit campaigns and ad sets, create ads from existing posts, and turn things on or off — in bulk, 1 to 300 steps in one plan (e.g. 15 ad sets with budgets ₹500 to ₹1,500). The plan is checked against Meta (reads, plus Meta's own validate-only check) and returns the summary: first the TOTAL daily budget, what turns on and the amount the person types to confirm; then errors and warnings, every step, and every ad set's budget, bid, schedule, audience and placements (long lists are cut; the app link shows all). Nothing changes in Meta until confirm_plan. Use run_at to schedule it.\n\n${opsDescription}`,
      inputSchema: {
        title: z.string().optional(),
        run_at: z.string().optional().describe("Time to run the plan, e.g. 2026-11-20T09:00 (India time when no zone is given). Leave out to run when confirmed."),
        expected_daily_total: numberish.optional().describe("The total daily budget the person said, e.g. 15000; the check flags any difference"),
        ops: z.array(z.record(z.string(), z.any())).min(1).max(300).describe('The steps: objects with "type" and that type\'s fields (plan_step_fields lists them)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) => run(async () => planText(await api.call<PlanView>("POST", "/api/plans", a))),
  );

  server.registerTool(
    "update_plan",
    {
      title: "Change a plan before it runs",
      description:
        "Change a plan that has not been confirmed (or that stopped part-way), and check it again. Send only what changes: ops (the full new list of steps), run_at, expected_daily_total or title. Anything left out keeps its saved value, so a new time alone is fine; \"\" clears run_at (run when confirmed), expected_daily_total or the title. Times without a zone are India time. Finished steps of a plan that stopped part-way can't change or move.",
      inputSchema: {
        plan_id: z.string(),
        title: z.string().optional(),
        run_at: z.string().optional().describe('New time, e.g. 2026-11-20T09:00 (India time), or "" to run when confirmed'),
        expected_daily_total: numberish.optional().describe('The total the person said, or "" to clear it'),
        ops: z.array(z.record(z.string(), z.any())).min(1).max(300).optional().describe("The full new list of steps (leave out to keep the steps)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ plan_id, ...rest }) =>
      run(async () => {
        const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        if (!Object.keys(body).length) throw new Error("Give what to change: ops, run_at, expected_daily_total or title.");
        try {
          return planText(await api.call<PlanView>("POST", `/api/plans/${plan_id}/update`, body));
        } catch (e) {
          throw forThePerson(e, "plan_status");
        }
      }),
  );

  server.registerTool(
    "confirm_plan",
    {
      title: "Run a plan (after the person's explicit yes)",
      description:
        "Runs a checked plan in the background (or at its scheduled time). Only call this after the person has seen the summary from plan_changes (the TOTAL, what turns on, every budget) and clearly said yes. Needs confirm: true; accept_warnings: true (or the number of warnings they accepted) if there were warnings and the person accepted them; and when the plan can spend, spend_confirmation: the amount the summary says to type (what can spend in a day once the plan has run), exactly as the person said it. Never guess or fill in the amount yourself. Budgets are checked again first: if they changed in Meta, it is refused with the new amount, which the person must see and type themselves.",
      inputSchema: {
        plan_id: z.string(),
        confirm: z.literal(true),
        accept_warnings: z.union([z.boolean(), z.number(), z.string()]).optional().describe("true, or the number of warnings the person read and accepted"),
        spend_confirmation: z.union([z.string(), z.number()]).optional().describe("The amount the person typed, e.g. ₹15,000"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ plan_id, confirm, accept_warnings, spend_confirmation }) =>
      run(async () => {
        let accepted = false;
        const a = accept_warnings === undefined ? false : typeof accept_warnings === "string" ? accept_warnings.trim().toLowerCase() : accept_warnings;
        if (a === true || a === "true" || a === "yes") accepted = true;
        else if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) {
          // A count: it must cover every warning of the plan as it is now.
          const n = Number(a);
          if (n > 0) {
            const v = await api.call<PlanView>("GET", `/api/plans/${encodeURIComponent(plan_id)}/view`);
            const w = v.summary?.warnings ?? 0;
            if (n < w) throw new Error(`The plan has ${w} warnings, but accept_warnings says the person accepted ${n}. Show every warning to the person (plan_status lists them); confirm only after they accept all of them.`);
            accepted = true;
          }
        }
        try {
          return planText(await api.call<PlanView>("POST", `/api/plans/${plan_id}/confirm`, { confirm, acceptWarnings: accepted, spendConfirmation: spend_confirmation === undefined ? undefined : String(spend_confirmation) }));
        } catch (e) {
          throw forThePerson(e, "plan_status");
        }
      }),
  );

  server.registerTool(
    "plan_status",
    {
      title: "Plan progress, or list recent plans",
      description: "Progress of one plan (counts of steps done, failed and skipped, each failed step and why, new IDs, and what to do next), or the list of recent plans with their times (IST) when plan_id is left out.",
      inputSchema: { plan_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ plan_id }) =>
      run(async () => {
        if (plan_id) return planText(await api.call<PlanView>("GET", `/api/plans/${plan_id}/view`));
        const r = await api.call<{ plans: { key: string; title: string; statusLabel: string; createdAt: string; createdAtLabel?: string; runAt: string | null; runAtLabel?: string | null; createdBy?: string | null; steps?: number }[] }>("GET", "/api/plans");
        return (
          r.plans
            .map((p) => {
              const runAt = p.runAtLabel ?? (p.runAt ? istLabel(p.runAt) : null);
              return `${p.key}: ${p.title} · ${p.statusLabel}${p.steps ? ` · ${p.steps} step(s)` : ""}${runAt && !p.statusLabel.startsWith("Scheduled") ? ` · runs ${runAt}` : ""} · made ${p.createdAtLabel ?? istLabel(p.createdAt)}${p.createdBy ? ` by ${p.createdBy}` : ""}`;
            })
            .join("\n") || "No plans yet."
        );
      }),
  );

  server.registerTool(
    "retry_plan",
    {
      title: "Fix and retry a plan that stopped part-way",
      description:
        "For a plan whose status is 'Some steps failed' or 'Failed': steps that finished stay as they are and are not run again; the step that stopped keeps its place. Give ops to change the failed step and the steps after it (send the full list, finished steps unchanged and in the same places), or leave ops out to try them again as they are. Its old run time is not reused: it runs when confirmed again (update_plan with run_at schedules it). The plan is checked again and waits for confirm_plan.",
      inputSchema: { plan_id: z.string(), ops: z.array(z.record(z.string(), z.any())).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ plan_id, ops }) =>
      run(async () => {
        try {
          return planText(await api.call<PlanView>("POST", `/api/plans/${plan_id}/retry`, ops ? { ops } : {}));
        } catch (e) {
          throw forThePerson(e, "plan_status");
        }
      }),
  );

  server.registerTool(
    "undo_plan",
    {
      title: "Undo a plan",
      description: "Makes a new plan that puts back what the given plan changed (names, budgets, bids, times, audiences, creatives and on/off status, only the fields it changed) and turns off everything it made. Nothing is deleted; what can't be put back is named in the summary. Show the new plan's summary and confirm it like any other plan.",
      inputSchema: { plan_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ plan_id }) => run(async () => planText(await api.call<PlanView>("POST", `/api/plans/${plan_id}/undo`))),
  );

  server.registerTool(
    "cancel_plan",
    {
      title: "Cancel a plan",
      description: "Cancel a plan that has not run yet (or stop a running one: no more items or steps run after the one it is on). Steps already done stay; nothing is deleted.",
      inputSchema: { plan_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ plan_id }) => run(async () => planText(await api.call<PlanView>("POST", `/api/plans/${plan_id}/cancel`))),
  );

  // ---------- Results ----------

  server.registerTool(
    "get_results",
    {
      title: "Read results (spend, leads, CPL, CTR…)",
      description:
        "Meta's results per ad, ad set or campaign (or the whole account) for any date range, with breakdowns (age, gender, country, region, publisher_platform, platform_position, device_platform, day; only pairs Meta accepts). Metrics: names from list_metrics (spend, impressions, reach, frequency, ctr, cpc, cpm, actions:lead, cost:lead…, any actions:<type> or cost:<type>) and custom metrics by name. Or give column_set. Days are in the ad account's time zone.",
      inputSchema: {
        level: z.enum(["account", "campaign", "adset", "ad"]),
        ids: oneOrMany.optional().describe("Only these IDs"),
        ids_level: z.enum(["campaign", "adset", "ad"]).optional().describe("What the ids are (default: the same as level), e.g. level ad with campaign ids"),
        date_preset: z.string().optional().describe("today, yesterday, last_3d, last_7d, last_14d, last_30d, last_90d, this_month, last_month, maximum (another name is refused)"),
        since: z.string().optional().describe("YYYY-MM-DD. Without until, it runs to today."),
        until: z.string().optional().describe("YYYY-MM-DD"),
        breakdowns: oneOrMany.optional(),
        metrics: oneOrMany.optional(),
        column_set: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      run(async () => {
        type R = { currency: string; level: string; range: string; columns: { key: string; label: string; format: string }[]; rows: { name: string; id: string; breakdown: Record<string, string>; values: Record<string, number | null> }[]; totals: Record<string, number | null>; truncated?: boolean; notes?: string[]; timezone?: string | null };
        const r = await api.call<R>("POST", "/api/results", { action: "query", ...a, ids: asList(a.ids), breakdowns: asList(a.breakdowns), metrics: asList(a.metrics) });
        const sym = r.currency === "INR" ? "₹" : `${r.currency} `;
        const f = (v: number | null | undefined, fmt: string) => (v === null || v === undefined ? "–" : fmt === "money" ? `${sym}${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : fmt === "percent" ? `${v.toFixed(2)}%` : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
        const bks = [...new Set(r.rows.flatMap((x) => Object.keys(x.breakdown)))];
        const head = [r.level, ...bks, ...r.columns.map((c) => c.label)].map(cell);
        const zone = r.timezone && r.timezone !== "Asia/Kolkata" ? ` (days in the ad account's time zone, ${r.timezone})` : "";
        const lines = [`Results by ${r.level}, ${r.range}${zone}:`, `| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
        for (const x of r.rows.slice(0, 200)) lines.push(`| ${cell(`${x.name} (${x.id})`)} | ${[...bks.map((b) => cell(String(x.breakdown[b] ?? ""))), ...r.columns.map((c) => f(x.values[c.key], c.format))].join(" | ")} |`);
        lines.push(`| TOTAL | ${[...bks.map(() => ""), ...r.columns.map((c) => f(r.totals[c.key], c.format))].join(" | ")} |`);
        if (r.rows.length > 200) lines.push(`(${r.rows.length - 200} more rows not shown; narrow the query.)`);
        if (!r.rows.length) lines.push("No delivery in this range.");
        if (r.rows.length > 1 && r.columns.some((c) => r.totals[c.key] === null)) lines.push("A dash in TOTAL means Meta's number can't be added up across rows (e.g. reach: the same person can be in several rows).");
        for (const n of r.notes ?? []) lines.push(`Note: ${n}`);
        if (r.truncated && !(r.notes ?? []).length) lines.push("Note: Meta has more rows than shown; the totals add up the rows shown only.");
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "list_metrics",
    {
      title: "Metric names, custom metrics and column sets",
      description: "Every metric name get_results accepts, the custom metrics (with formulas and ids) and the saved column sets.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const c = await api.call<{ standard: { key: string; label: string }[]; custom: { id?: number; name: string; formula: string; format: string }[]; columnSets: { id?: number; name: string; metrics: string[]; isDefault: boolean }[]; note: string }>("GET", "/api/results");
        return [
          "Metrics:",
          ...c.standard.map((m) => `  ${m.key} = ${m.label}`),
          c.note,
          "Custom metrics:",
          ...(c.custom.length ? c.custom.map((m) => `  ${m.name}${m.id ? ` (id ${m.id})` : ""} = ${m.formula} (${m.format})`) : ["  none yet"]),
          "Column sets:",
          ...c.columnSets.map((s) => `  ${s.name}${s.id ? ` (id ${s.id})` : ""}${s.isDefault ? " (default)" : ""}: ${s.metrics.join(", ")}`),
        ].join("\n");
      }),
  );

  server.registerTool(
    "save_custom_metric",
    {
      title: "Create or edit a custom metric",
      description:
        'A metric from a formula of other metrics, e.g. name "Cost per site visit", formula "spend / actions:offsite_conversion.fb_pixel_custom". Use + - * / and brackets; names with spaces go in quotes. Every name must be a metric from list_metrics, actions:<type>, cost:<type> or another custom metric. Give id (from list_metrics) to edit one; a new name also updates the formulas and column sets that use it. Kept in the launcher (Meta\'s API can\'t create Ads Manager custom metrics) and usable in get_results and column sets.',
      inputSchema: { id: numberish.optional(), name: z.string(), formula: z.string(), format: z.enum(["number", "money", "percent"]).optional(), description: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) =>
      run(async () => {
        const r = await api.call<{ id: number }>("POST", "/api/results", { action: "save_custom_metric", ...a, id: asId(a.id) });
        return `Saved custom metric "${a.name}" (id ${r.id}) = ${a.formula}${a.format ? ` (${a.format})` : ""}.`;
      }),
  );

  server.registerTool(
    "save_column_set",
    {
      title: "Create or edit a column set",
      description: "A saved list of metrics, like Ads Manager's column presets. Used by get_results (column_set) and the app's Results page. Give id (from list_metrics) to edit one.",
      inputSchema: { id: numberish.optional(), name: z.string(), metrics: oneOrMany, is_default: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) =>
      run(async () => {
        const metrics = asList(a.metrics) ?? [];
        const r = await api.call<{ id: number }>("POST", "/api/results", { action: "save_column_set", id: asId(a.id), name: a.name, metrics, isDefault: a.is_default });
        return `Saved column set "${a.name}" (id ${r.id})${a.is_default ? " (default)" : ""}: ${metrics.join(", ")}.`;
      }),
  );
}
