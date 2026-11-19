// Types, labels and number formatting shared by the Results page parts.

export type Format = "number" | "money" | "percent";

export interface StandardMetric { key: string; label: string; format: Format }
export interface CustomMetricT { id: number; name: string; formula: string; format: Format; description: string }
export interface ColumnSet { id: number; name: string; metrics: string[]; isDefault: boolean }
export interface Catalog { standard: StandardMetric[]; custom: CustomMetricT[]; columnSets: ColumnSet[]; note: string }

export interface ResultRow { id: string; name: string; breakdown: Record<string, string>; values: Record<string, number | null> }
export interface ResultData {
  currency: string;
  level: string;
  range: string;
  columns: { key: string; label: string; format: Format }[];
  rows: ResultRow[];
  totals: Record<string, number | null>;
  /** Meta had more rows than the launcher reads: the first rows only, totals of those rows. */
  truncated?: boolean;
  /** Plain notes: columns left out, rows cut. */
  notes?: string[];
  /** The ad account's time zone (Meta's days follow it). */
  timezone?: string | null;
}

/** "Dates follow the ad account's time zone…" when it isn't India time, else null. */
export function zoneNote(timezone: string | null | undefined): string | null {
  if (!timezone || timezone === "Asia/Kolkata" || timezone === "Asia/Calcutta") return null;
  return `Dates and days follow the ad account's time zone (${timezone.replace(/_/g, " ")}), not India time.`;
}

export const LEVELS = [
  ["campaign", "Campaigns"],
  ["adset", "Ad sets"],
  ["ad", "Ads"],
  ["account", "Whole account"],
] as const;
export type Level = (typeof LEVELS)[number][0];

export const DATES = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["last_3d", "Last 3 days"],
  ["last_7d", "Last 7 days"],
  ["last_14d", "Last 14 days"],
  ["last_30d", "Last 30 days"],
  ["last_90d", "Last 90 days"],
  ["this_month", "This month"],
  ["last_month", "Last month"],
  ["maximum", "All time"],
  ["custom", "Pick dates…"],
] as const;

export const BREAKDOWNS = [
  ["age", "Age"],
  ["gender", "Gender"],
  ["country", "Country"],
  ["region", "Region"],
  ["publisher_platform", "Platform"],
  ["platform_position", "Placement"],
  ["device_platform", "Device"],
  ["day", "Day"],
] as const;

export const breakdownLabel = (k: string) => BREAKDOWNS.find(([b]) => b === k)?.[1] ?? k;

/** Meta shows placement only together with platform: picking Placement alone adds Platform. */
export function withPlatform(list: string[]): string[] {
  return list.includes("platform_position") && !list.includes("publisher_platform") ? [...list, "publisher_platform"] : list;
}

/** "facebook" → "Facebook", "instagram_stories" → "Instagram stories", dates → "17 Nov 2026". */
export function breakdownValue(key: string, v: string | undefined): string {
  if (!v) return "–";
  if (key === "day") {
    const d = new Date(`${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }
  if (key === "country" || key === "age") return v;
  const s = v.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatValue(v: number | null | undefined, format: string, currency = "INR"): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const n = v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  if (format === "money") return currency === "INR" ? `₹${n}` : `${currency} ${n}`;
  if (format === "percent") return `${n}%`;
  return n;
}

/** Errors that mean the Meta connection needs attention, so we point to Settings. */
export const isConnectionError = (msg: string) => /connect|token|log ?in|expired|permission|session/i.test(msg);
