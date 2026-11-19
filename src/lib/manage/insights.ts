import type { MetaClient } from "../meta/client";

// Results: Meta's insights for ads, ad sets and campaigns, plus our own metrics.
// Meta's API can't edit Ads Manager's column presets or its custom metrics, so column sets and
// formulas live in the launcher (tables column_sets and custom_metrics) and work the same in
// the app and through Claude.

export const LEVELS = ["account", "campaign", "adset", "ad"] as const;
export type Level = (typeof LEVELS)[number];

export const BREAKDOWNS = ["age", "gender", "country", "region", "publisher_platform", "platform_position", "device_platform", "impression_device", "day"] as const;

export const DATE_PRESETS = ["today", "yesterday", "last_3d", "last_7d", "last_14d", "last_30d", "last_90d", "this_month", "last_month", "maximum"];

/** Plain metrics Meta returns as numbers. Actions are named `actions:<type>`, costs `cost:<type>`. */
export const STANDARD_METRICS: { key: string; label: string; format: "number" | "money" | "percent" }[] = [
  { key: "spend", label: "Amount spent", format: "money" },
  { key: "impressions", label: "Impressions", format: "number" },
  { key: "reach", label: "Reach", format: "number" },
  { key: "frequency", label: "Frequency", format: "number" },
  { key: "clicks", label: "Clicks (all)", format: "number" },
  { key: "inline_link_clicks", label: "Link clicks", format: "number" },
  { key: "ctr", label: "CTR (all)", format: "percent" },
  { key: "inline_link_click_ctr", label: "Link CTR", format: "percent" },
  { key: "cpc", label: "CPC (all)", format: "money" },
  { key: "cost_per_inline_link_click", label: "Cost per link click", format: "money" },
  { key: "cpm", label: "CPM", format: "money" },
  { key: "cpp", label: "Cost per 1,000 reached", format: "money" },
  { key: "unique_clicks", label: "Unique clicks", format: "number" },
  { key: "unique_ctr", label: "Unique CTR", format: "percent" },
  { key: "actions:lead", label: "Leads", format: "number" },
  { key: "cost:lead", label: "Cost per lead (CPL)", format: "money" },
  { key: "actions:landing_page_view", label: "Landing page views", format: "number" },
  { key: "cost:landing_page_view", label: "Cost per landing page view", format: "money" },
  { key: "actions:link_click", label: "Link clicks (actions)", format: "number" },
  { key: "actions:onsite_conversion.messaging_conversation_started_7d", label: "Conversations started", format: "number" },
  { key: "actions:offsite_conversion.fb_pixel_lead", label: "Website leads (pixel)", format: "number" },
  { key: "actions:offsite_conversion.fb_pixel_complete_registration", label: "Registrations (pixel)", format: "number" },
  { key: "actions:offsite_conversion.fb_pixel_purchase", label: "Purchases (pixel)", format: "number" },
  { key: "actions:video_view", label: "3-second video views", format: "number" },
  { key: "video_thruplay_watched_actions", label: "ThruPlays", format: "number" },
  { key: "actions:post_engagement", label: "Post engagement", format: "number" },
];

export const DEFAULT_COLUMNS = ["spend", "impressions", "reach", "frequency", "inline_link_clicks", "inline_link_click_ctr", "cpm", "cost_per_inline_link_click", "actions:lead", "cost:lead"];

const NUMERIC_FIELDS = new Set(STANDARD_METRICS.filter((m) => !m.key.includes(":")).map((m) => m.key));

/** Any Meta action count or cost per action: actions:lead, cost:offsite_conversion.fb_pixel_purchase. */
const ACTION_KEY = /^(actions|cost):[\w.]+$/;

/** A name Meta answers by itself (not a custom metric). */
export const isStandardMetric = (k: string) => NUMERIC_FIELDS.has(k) || ACTION_KEY.test(k);

// ---------- Formulas ----------

type Tok = { t: "num"; v: number } | { t: "var"; v: string } | { t: "op"; v: string } | { t: "(" } | { t: ")" };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if ("+-*/".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    if (c === "÷") { out.push({ t: "op", v: "/" }); i++; continue; }
    if (c === "×") { out.push({ t: "op", v: "*" }); i++; continue; }
    if (c === "(") { out.push({ t: "(" }); i++; continue; }
    if (c === ")") { out.push({ t: ")" }); i++; continue; }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    // Names: letters, digits, _ . : and quoted names for custom metrics with spaces.
    if (c === '"' || c === "'" || c === "[") {
      const end = src.indexOf(c === "[" ? "]" : c, i + 1);
      if (end < 0) throw new Error("A quote or bracket in the formula is not closed.");
      out.push({ t: "var", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const name = /^[A-Za-z_][\w.:]*/.exec(src.slice(i));
    if (name) { out.push({ t: "var", v: name[0] }); i += name[0].length; continue; }
    throw new Error(`The formula has a character I can't read: "${c}". Use metric names, numbers, + - * / and brackets.`);
  }
  return out;
}

export type Expr = { k: "num"; v: number } | { k: "var"; v: string } | { k: "bin"; op: string; a: Expr; b: Expr } | { k: "neg"; a: Expr };

/** Parse "spend / actions:lead" into a tree. No eval: only + - * / and brackets. */
export function parseFormula(src: string): Expr {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  function primary(): Expr {
    const t = toks[i++];
    if (!t) throw new Error("The formula ends too early.");
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "var") return { k: "var", v: t.v };
    if (t.t === "op" && t.v === "-") return { k: "neg", a: primary() };
    if (t.t === "(") {
      const e = sum();
      if (toks[i++]?.t !== ")") throw new Error("A bracket in the formula is not closed.");
      return e;
    }
    throw new Error("The formula has an operator in the wrong place.");
  }
  function product(): Expr {
    let a = primary();
    for (let t = peek(); t?.t === "op" && (t.v === "*" || t.v === "/"); t = peek()) { i++; a = { k: "bin", op: t.v, a, b: primary() }; }
    return a;
  }
  function sum(): Expr {
    let a = product();
    for (let t = peek(); t?.t === "op" && (t.v === "+" || t.v === "-"); t = peek()) { i++; a = { k: "bin", op: t.v, a, b: product() }; }
    return a;
  }
  const e = sum();
  if (i < toks.length) throw new Error("The formula has extra text at the end.");
  return e;
}

export function formulaVars(e: Expr, out = new Set<string>()): Set<string> {
  if (e.k === "var") out.add(e.v);
  if (e.k === "bin") { formulaVars(e.a, out); formulaVars(e.b, out); }
  if (e.k === "neg") formulaVars(e.a, out);
  return out;
}

/** Evaluate; dividing by zero or a missing value gives null (shown as "–"). */
export function evalFormula(e: Expr, get: (name: string) => number | null): number | null {
  switch (e.k) {
    case "num": return e.v;
    case "var": return get(e.v);
    case "neg": { const a = evalFormula(e.a, get); return a === null ? null : -a; }
    case "bin": {
      const a = evalFormula(e.a, get);
      const b = evalFormula(e.b, get);
      if (a === null || b === null) return null;
      if (e.op === "+") return a + b;
      if (e.op === "-") return a - b;
      if (e.op === "*") return a * b;
      return b === 0 ? null : a / b;
    }
  }
}

// ---------- Metric names ----------

export interface CustomMetric { name: string; formula: string; format: string }

/**
 * Every metric name is a standard metric, actions:<type> / cost:<type>, or a custom metric whose
 * formula (and the custom metrics inside it, at any depth) uses only such names.
 * Returns the problem in plain words, or null when the name can be worked out.
 */
export function metricProblem(name: string, custom: CustomMetric[]): string | null {
  const by = new Map(custom.map((c) => [c.name.toLowerCase(), c]));
  const walk = (n: string, path: string[]): string | null => {
    const c = by.get(n.toLowerCase());
    if (!c) {
      if (isStandardMetric(n)) return null;
      if (!path.length) return `Unknown metric "${n}".`;
      return `"${path[path.length - 1]}" uses "${n}", which is not a metric name.`;
    }
    if (path.some((p) => p.toLowerCase() === c.name.toLowerCase())) return `"${path[0]}" uses itself (${[...path, c.name].map((p) => `"${p}"`).join(" → ")}), so it can't be worked out.`;
    let e: Expr;
    try {
      e = parseFormula(c.formula);
    } catch (err) {
      return `The formula of "${c.name}" can't be read: ${(err as Error).message}`;
    }
    for (const v of formulaVars(e)) {
      const p = walk(v, [...path, c.name]);
      if (p) return p;
    }
    return null;
  };
  return walk(name, []);
}

// ---------- Breakdowns and dates ----------

const BREAKDOWN_WORDS: Record<string, string> = {
  age: "age",
  gender: "gender",
  country: "country",
  region: "region",
  publisher_platform: "platform",
  platform_position: "placement",
  device_platform: "device",
  impression_device: "impression device",
  day: "day",
};

/** Breakdown sets Meta accepts together. "day" (one row per day) goes with any of them. */
const BREAKDOWN_SETS: string[][] = [
  ["age"], ["gender"], ["age", "gender"], ["country"], ["region"],
  ["publisher_platform"], ["device_platform"], ["impression_device"],
  ["publisher_platform", "platform_position"], ["publisher_platform", "impression_device"], ["publisher_platform", "device_platform"],
  ["publisher_platform", "platform_position", "impression_device"], ["publisher_platform", "platform_position", "device_platform"],
];

/** The breakdowns to send to Meta (without "day"), or a plain refusal for names or pairs Meta rejects. */
export function checkBreakdowns(list: string[] = []): string[] {
  const unknown = list.filter((b) => !(BREAKDOWNS as readonly string[]).includes(b));
  if (unknown.length) throw new Error(`Unknown breakdown${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Use ${BREAKDOWNS.join(", ")}.`);
  const meta = [...new Set(list.filter((b) => b !== "day"))];
  if (meta.length <= 1 && meta[0] !== "platform_position") return meta;
  const fits = BREAKDOWN_SETS.some((s) => s.length === meta.length && s.every((b) => meta.includes(b)));
  if (fits) return meta;
  if (meta.length === 1) throw new Error('Meta shows placement only together with platform (Facebook, Instagram…). Break down by platform and placement.');
  throw new Error(
    `Meta can't break results down by ${meta.map((b) => BREAKDOWN_WORDS[b] ?? b).join(" and ")} together. Pairs that work: age and gender; platform and placement; platform and device. Any one breakdown works alone, and "day" works with any of them.`,
  );
}

const DAY = /^\d{4}-\d\d-\d\d$/;

/** Today's date (YYYY-MM-DD) in the ad account's time zone. */
export function todayIn(timezone: string | undefined, now = Date.now()): string {
  const f = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try {
    return f(timezone || "Asia/Kolkata");
  } catch {
    return f("Asia/Kolkata");
  }
}

/** A real calendar date written YYYY-MM-DD (2026-02-30 is not one). */
function isDay(d: string): boolean {
  if (!DAY.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/**
 * The dates and the date range as written: real dates, the start not after the end, a known range.
 * Needs no Meta call, so a wrong date is refused before anything is read. Throws the problem in words.
 */
export function checkDates(q: { date_preset?: string; since?: string; until?: string }): void {
  if (q.since || q.until) {
    if (!q.since) throw new Error("Give a start date (since) with the end date, as YYYY-MM-DD.");
    for (const [what, d] of [["start", q.since], ["end", q.until]] as const) {
      if (d !== undefined && d !== "" && !isDay(d)) throw new Error(`The ${what} date "${d}" isn't a date. Write it as YYYY-MM-DD, for example 2026-11-01.`);
    }
    if (q.until && q.since > q.until) throw new Error(`The start date ${q.since} is after the end date ${q.until}.`);
    return;
  }
  const preset = q.date_preset || "last_7d";
  if (!DATE_PRESETS.includes(preset)) throw new Error(`Unknown date range "${preset}". Use one of ${DATE_PRESETS.join(", ")}, or give since and until as YYYY-MM-DD.`);
}

/** The date range Meta is asked for. A start date alone runs to today; an unknown preset is refused. */
export function dateRange(q: { date_preset?: string; since?: string; until?: string }, timezone?: string, now = Date.now()): { params: Record<string, unknown>; label: string } {
  checkDates(q);
  if (q.since || q.until) {
    const since = q.since!;
    const until = q.until || todayIn(timezone, now);
    if (since > until) throw new Error(`The start date ${since} is after today (${until} in the ad account's time zone).`);
    return { params: { time_range: { since, until } }, label: `${since} to ${until}${q.until ? "" : " (today)"}` };
  }
  return { params: { date_preset: q.date_preset || "last_7d" }, label: (q.date_preset || "last_7d").replace(/_/g, " ") };
}

// ---------- Reading insights ----------

export interface InsightsQuery {
  level: Level;
  /** Limit to these IDs. They are campaign, ad set or ad IDs as `ids_level` says (default: the same as level). */
  ids?: string[];
  ids_level?: "campaign" | "adset" | "ad";
  date_preset?: string;
  since?: string;
  until?: string;
  breakdowns?: string[];
  metrics?: string[];
  limit?: number;
}

export interface InsightsOptions {
  /** The ad account's time zone (Meta's timezone_name): "today" for a start date without an end date. */
  timezone?: string;
  /** Saved column sets: leave out a column whose name no longer works (deleted custom metric) with a note, instead of refusing. */
  dropUnknown?: boolean;
  now?: number;
}

type Raw = Record<string, unknown> & { actions?: { action_type: string; value: string }[]; cost_per_action_type?: { action_type: string; value: string }[]; video_thruplay_watched_actions?: { action_type: string; value: string }[] };

export interface InsightsResult {
  level: Level;
  range: string;
  columns: { key: string; label: string; format: string }[];
  rows: { name: string; id: string; breakdown: Record<string, string>; values: Record<string, number | null> }[];
  totals: Record<string, number | null>;
  /** Meta had more rows than the launcher reads: only the first rows are here, and the totals add up those rows. */
  truncated: boolean;
  /** Plain notes for the person (columns left out, rows cut). */
  notes: string[];
  /** The ad account's time zone when it was given; Meta's dates follow it. */
  timezone: string | null;
}

/** Most rows read for one report (each page of 500 is one Meta call). */
export const MAX_ROWS = 5000;

function rawValue(r: Raw, key: string): number | null {
  if (key.startsWith("actions:")) {
    const a = r.actions?.find((x) => x.action_type === key.slice(8));
    return a ? Number(a.value) : 0;
  }
  if (key.startsWith("cost:")) {
    const a = r.cost_per_action_type?.find((x) => x.action_type === key.slice(5));
    return a ? Number(a.value) : null;
  }
  if (key === "video_thruplay_watched_actions") {
    return (r.video_thruplay_watched_actions ?? []).reduce((s, a) => s + (Number(a.value) || 0), 0);
  }
  const v = r[key];
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Fields Meta needs to answer a standard metric, and to work its total out again from the rows. */
const NEEDS: Record<string, string[]> = {
  ctr: ["clicks", "impressions"],
  inline_link_click_ctr: ["inline_link_clicks", "impressions"],
  cpc: ["clicks"],
  cost_per_inline_link_click: ["inline_link_clicks"],
  cpm: ["impressions"],
};

/** Counts that add up across rows. Reach, frequency and unique counts don't (the same person shows up in several rows). */
const ADDITIVE = ["spend", "impressions", "clicks", "inline_link_clicks", "video_thruplay_watched_actions"];

/** Totals of the rows: counts added up, rates worked out again from those sums. */
function totalsBase(raw: Raw[]): (key: string) => number | null {
  const sums = new Map<string, number>();
  const add = (k: string, v: number) => sums.set(k, (sums.get(k) ?? 0) + (Number.isFinite(v) ? v : 0));
  for (const r of raw) {
    for (const k of ADDITIVE) add(k, rawValue(r, k) ?? 0);
    for (const a of r.actions ?? []) add(`actions:${a.action_type}`, Number(a.value));
  }
  const s = (k: string) => sums.get(k) ?? 0;
  const ratio = (a: number, b: number, times = 1) => (b ? (a / b) * times : null);
  return (key) => {
    if (ADDITIVE.includes(key) || key.startsWith("actions:")) return s(key);
    if (key.startsWith("cost:")) return ratio(s("spend"), s(`actions:${key.slice(5)}`));
    switch (key) {
      case "ctr": return ratio(s("clicks"), s("impressions"), 100);
      case "inline_link_click_ctr": return ratio(s("inline_link_clicks"), s("impressions"), 100);
      case "cpc": return ratio(s("spend"), s("clicks"));
      case "cost_per_inline_link_click": return ratio(s("spend"), s("inline_link_clicks"));
      case "cpm": return ratio(s("spend"), s("impressions"), 1000);
      default: return null; // reach, frequency, cpp, unique clicks and unique CTR can't be added up
    }
  };
}

export async function readInsights(client: MetaClient, q: InsightsQuery, custom: CustomMetric[], opts: InsightsOptions = {}): Promise<InsightsResult> {
  const level = q.level ?? "ad";
  if (!LEVELS.includes(level)) throw new Error(`Unknown level "${String(level)}". Use account, campaign, adset or ad.`);
  if (q.ids_level && !["campaign", "adset", "ad"].includes(q.ids_level)) throw new Error(`ids_level must be campaign, adset or ad, not "${q.ids_level}".`);
  const range = dateRange(q, opts.timezone, opts.now);
  const bds = checkBreakdowns(q.breakdowns);
  const byDay = (q.breakdowns ?? []).includes("day");

  // Names first: a typo is refused (or, for a saved column set, left out with a note), never "–" in every row.
  const notes: string[] = [];
  const metrics: string[] = [];
  for (const m of q.metrics?.length ? q.metrics : DEFAULT_COLUMNS) {
    const problem = metricProblem(m, custom);
    if (!problem) metrics.push(m);
    else if (opts.dropUnknown) notes.push(`The column "${m}" was left out: ${problem} Fix it in Edit columns or Custom metrics.`);
    else throw new Error(`${problem} Use list_metrics to see the names (counts are actions:<type>, costs cost:<type>), or create it as a custom metric.`);
  }
  if (!metrics.length) throw new Error(`None of the columns can be shown. ${notes.join(" ")}`);

  const customBy = new Map(custom.map((c) => [c.name.toLowerCase(), c]));
  const parsed = new Map<string, Expr>();
  const formulaOf = (c: CustomMetric) => {
    let e = parsed.get(c.name);
    if (!e) parsed.set(c.name, (e = parseFormula(c.formula)));
    return e;
  };
  // Meta fields to ask for: plain metrics, those inside custom formulas (at any depth), and what totals need.
  const need = new Set<string>(["spend"]);
  const addKey = (k: string, seen: Set<string>) => {
    const c = customBy.get(k.toLowerCase());
    if (c) {
      if (seen.has(c.name)) return;
      seen.add(c.name);
      for (const v of formulaVars(formulaOf(c))) addKey(v, seen);
    } else if (k.startsWith("actions:")) need.add("actions");
    else if (k.startsWith("cost:")) {
      need.add("cost_per_action_type");
      need.add("actions"); // the total cost per action is total spend ÷ total actions
    } else if (NUMERIC_FIELDS.has(k)) {
      need.add(k);
      for (const x of NEEDS[k] ?? []) need.add(x);
    }
  };
  for (const m of metrics) addKey(m, new Set());

  const fields = [...need, ...(level === "account" ? [] : [`${level}_id`, `${level}_name`])];
  const max = Math.max(1, Math.min(Number(q.limit) || 2000, MAX_ROWS));
  const params: Record<string, unknown> = { level, fields: fields.join(","), limit: Math.min(max, 500), ...range.params };
  if (bds.length) params.breakdowns = bds;
  if (byDay) params.time_increment = 1;
  if (q.ids?.length) {
    params.filtering = [{ field: `${q.ids_level ?? (level === "account" ? "campaign" : level)}.id`, operator: "IN", value: q.ids }];
  }
  // One row more than shown tells whether Meta had more. A "too much data" answer is not asked again
  // with smaller pages: the person picks fewer days, fewer breakdowns or a higher level instead.
  let raw = await client.getAll<Raw>(`${client.accountId}/insights`, params, max + 1, { shrinkPages: false });
  const truncated = raw.length > max;
  if (truncated) raw = raw.slice(0, max);

  /** A metric's value, with custom metrics worked out from the names inside them (loops were refused above). */
  const valueWith = (base: (key: string) => number | null) => {
    const get = (key: string, depth = 0): number | null => {
      const c = customBy.get(key.toLowerCase());
      if (c && depth < 20) return evalFormula(formulaOf(c), (n) => get(n, depth + 1));
      return c ? null : base(key);
    };
    return get;
  };

  const rows = raw.map((r) => {
    const breakdown: Record<string, string> = {};
    for (const b of bds) if (r[b] !== undefined) breakdown[b] = String(r[b]);
    if (byDay) breakdown.day = String(r.date_start ?? "");
    const get = valueWith((k) => rawValue(r, k));
    const values: Record<string, number | null> = {};
    for (const m of metrics) values[m] = get(m);
    return { id: String(r[`${level}_id`] ?? client.accountId), name: String(r[`${level}_name`] ?? "Whole account"), breakdown, values };
  });

  // Totals. One row without breakdowns is the whole selection: Meta's own numbers, reach included.
  // Otherwise counts are added up and rates worked out from those sums (custom metrics too);
  // reach, frequency and unique counts can't be added up across rows, so they stay empty.
  const totalsGet = raw.length === 1 && !bds.length && !byDay && !truncated ? valueWith((k) => rawValue(raw[0], k)) : valueWith(totalsBase(raw));
  const totals: Record<string, number | null> = {};
  for (const m of metrics) totals[m] = totalsGet(m);

  if (truncated) notes.push(`Only the first ${max.toLocaleString("en-IN")} rows are shown (Meta has more), and the totals add up these rows only. Pick fewer days, a higher level or fewer breakdowns to see everything.`);

  const labels = new Map(STANDARD_METRICS.map((s) => [s.key, s]));
  return {
    level,
    range: range.label,
    columns: metrics.map((m) => {
      const c = customBy.get(m.toLowerCase());
      if (c) return { key: m, label: c.name, format: c.format };
      const s = labels.get(m);
      return { key: m, label: s?.label ?? m, format: s?.format ?? (m.startsWith("cost:") ? "money" : "number") };
    }),
    rows,
    totals,
    truncated,
    notes,
    timezone: opts.timezone ?? null,
  };
}

export function formatValue(v: number | null | undefined, format: string, currency = "INR"): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  if (format === "money") return `${currency === "INR" ? "₹" : `${currency} `}${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  if (format === "percent") return `${v.toFixed(2)}%`;
  return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
