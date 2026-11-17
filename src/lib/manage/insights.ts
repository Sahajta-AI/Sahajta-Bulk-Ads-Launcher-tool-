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

// ---------- Reading insights ----------

export interface CustomMetric { name: string; formula: string; format: string }

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

type Raw = Record<string, unknown> & { actions?: { action_type: string; value: string }[]; cost_per_action_type?: { action_type: string; value: string }[]; video_thruplay_watched_actions?: { action_type: string; value: string }[] };

export interface InsightsResult {
  level: Level;
  range: string;
  columns: { key: string; label: string; format: string }[];
  rows: { name: string; id: string; breakdown: Record<string, string>; values: Record<string, number | null> }[];
  totals: Record<string, number | null>;
}

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
    const a = r.video_thruplay_watched_actions?.[0];
    return a ? Number(a.value) : 0;
  }
  const v = r[key];
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function readInsights(client: MetaClient, q: InsightsQuery, custom: CustomMetric[]): Promise<InsightsResult> {
  const level = LEVELS.includes(q.level) ? q.level : "ad";
  const metrics = q.metrics?.length ? q.metrics : DEFAULT_COLUMNS;
  const customBy = new Map(custom.map((c) => [c.name.toLowerCase(), c]));
  const parsed = new Map<string, Expr>();
  // Meta fields to ask for: plain metrics, and those used inside custom formulas.
  const need = new Set<string>(["spend"]);
  const addKey = (k: string) => {
    if (k.startsWith("actions:")) need.add("actions");
    else if (k.startsWith("cost:")) need.add("cost_per_action_type");
    else if (NUMERIC_FIELDS.has(k) || k === "video_thruplay_watched_actions") need.add(k);
  };
  for (const m of metrics) {
    const c = customBy.get(m.toLowerCase());
    if (c) {
      const e = parseFormula(c.formula);
      parsed.set(m, e);
      for (const v of formulaVars(e)) addKey(v);
    } else if (m.includes(":") || NUMERIC_FIELDS.has(m) || m === "video_thruplay_watched_actions") addKey(m);
    else throw new Error(`Unknown metric "${m}". Use list_metrics to see the names, or create it as a custom metric.`);
  }
  const fields = [...need, ...(level === "account" ? [] : [`${level}_id`, `${level}_name`])];
  const params: Record<string, unknown> = { level, fields: fields.join(","), limit: Math.min(q.limit ?? 500, 500) };
  if (q.since && q.until) params.time_range = { since: q.since, until: q.until };
  else params.date_preset = q.date_preset && DATE_PRESETS.includes(q.date_preset) ? q.date_preset : "last_7d";
  const bds = (q.breakdowns ?? []).filter((b) => b !== "day");
  if (bds.length) params.breakdowns = bds;
  if (q.breakdowns?.includes("day")) params.time_increment = 1;
  if (q.ids?.length) {
    params.filtering = [{ field: `${q.ids_level ?? (level === "account" ? "campaign" : level)}.id`, operator: "IN", value: q.ids }];
  }
  const raw = await client.getAll<Raw>(`${client.accountId}/insights`, params, q.limit ?? 2000);

  const valueOf = (r: Raw, key: string): number | null => {
    const e = parsed.get(key);
    if (e) return evalFormula(e, (name) => {
      const inner = customBy.get(name.toLowerCase());
      if (inner && inner.name !== key) return evalFormula(parseFormula(inner.formula), (n2) => rawValue(r, n2));
      return rawValue(r, name);
    });
    return rawValue(r, key);
  };
  const rows = raw.map((r) => {
    const breakdown: Record<string, string> = {};
    for (const b of bds) if (r[b] !== undefined) breakdown[b] = String(r[b]);
    if (q.breakdowns?.includes("day")) breakdown.day = String(r.date_start ?? "");
    const values: Record<string, number | null> = {};
    for (const m of metrics) values[m] = valueOf(r, m);
    return { id: String(r[`${level}_id`] ?? client.accountId), name: String(r[`${level}_name`] ?? "Whole account"), breakdown, values };
  });
  // Totals: add up counts and spend; work rates out again from the totals.
  const sumRaw: Raw = { actions: [], cost_per_action_type: [] };
  const sums = new Map<string, number>();
  for (const r of raw) {
    for (const k of ["spend", "impressions", "reach", "clicks", "inline_link_clicks", "unique_clicks"]) sums.set(k, (sums.get(k) ?? 0) + (rawValue(r, k) ?? 0));
    for (const a of r.actions ?? []) sums.set(`actions:${a.action_type}`, (sums.get(`actions:${a.action_type}`) ?? 0) + Number(a.value));
  }
  for (const [k, v] of sums) if (!k.includes(":")) sumRaw[k] = v;
  sumRaw.actions = [...sums].filter(([k]) => k.startsWith("actions:")).map(([k, v]) => ({ action_type: k.slice(8), value: String(v) }));
  const spend = sums.get("spend") ?? 0;
  const imp = sums.get("impressions") ?? 0;
  const lclicks = sums.get("inline_link_clicks") ?? 0;
  const clicks = sums.get("clicks") ?? 0;
  const derived: Record<string, number | null> = {
    ctr: imp ? (clicks / imp) * 100 : null,
    inline_link_click_ctr: imp ? (lclicks / imp) * 100 : null,
    cpc: clicks ? spend / clicks : null,
    cost_per_inline_link_click: lclicks ? spend / lclicks : null,
    cpm: imp ? (spend / imp) * 1000 : null,
    frequency: null, // reach can't be added across rows
    reach: null,
    cpp: null,
    unique_ctr: null,
    unique_clicks: null,
  };
  const totals: Record<string, number | null> = {};
  for (const m of metrics) {
    if (m.startsWith("cost:")) {
      const n = sums.get(`actions:${m.slice(5)}`) ?? 0;
      totals[m] = n ? spend / n : null;
    } else if (m in derived) totals[m] = derived[m];
    else totals[m] = valueOf(sumRaw, m);
  }
  const labels = new Map(STANDARD_METRICS.map((s) => [s.key, s]));
  return {
    level,
    range: q.since && q.until ? `${q.since} to ${q.until}` : String(params.date_preset).replace(/_/g, " "),
    columns: metrics.map((m) => {
      const c = customBy.get(m.toLowerCase());
      if (c) return { key: m, label: c.name, format: c.format };
      const s = labels.get(m);
      return { key: m, label: s?.label ?? m, format: s?.format ?? (m.startsWith("cost:") ? "money" : "number") };
    }),
    rows,
    totals,
  };
}

export function formatValue(v: number | null | undefined, format: string, currency = "INR"): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  if (format === "money") return `${currency === "INR" ? "₹" : `${currency} `}${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  if (format === "percent") return `${v.toFixed(2)}%`;
  return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
