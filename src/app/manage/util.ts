// Small helpers shared by the Campaigns page and the plan page (browser side).

import type { PlanInput } from "@/lib/manage/plan";
import type { PlanView, TreeCampaign } from "@/lib/manage/service";

export type { PlanInput, PlanView, TreeCampaign };
export type TreeAdSet = TreeCampaign["adsets"][number];

export interface Option {
  value: string;
  label: string;
  note?: string;
}

export interface Options {
  objectives: Option[];
  bidStrategies: Option[];
  specialAdCategories: Option[];
  destinations: Option[];
  goals: Option[];
  pixelEvents: Option[];
  billingEvents: Option[];
  genders: Option[];
  placementPlatforms: Option[];
  attribution: Option[];
}

export interface Tree {
  currency: string;
  fetchedAt: string;
  campaigns: TreeCampaign[];
}

export interface PlanListItem {
  key: string;
  title: string;
  status: string;
  statusLabel: string;
  canSpend: boolean;
  runAt: string | null;
  /** The same time in India time words, from the server ("20 Nov 2026, 09:00 am IST"). */
  runAtLabel?: string | null;
  createdAt: string;
  createdAtLabel?: string;
  createdBy: string | null;
  source: string;
  dailyBudget: number;
  steps: number;
}

/** ₹1,500 (or "USD 1,500" for other currencies). */
export function rupees(n: number | null | undefined, currency = "INR"): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  const sym = currency.toUpperCase() === "INR" ? "₹" : `${currency.toUpperCase()} `;
  return `${sym}${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/** A time shown in India time. Database times without a zone are UTC. */
export function ist(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(" ", "T")}Z`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST`;
}

/** Value of a datetime-local input (read as India time) → ISO with +05:30. Empty stays undefined. */
export function istInputToIso(v: string): string | undefined {
  if (!v) return undefined;
  return `${v.length === 16 ? `${v}:00` : v}+05:30`;
}

/** ISO time → value for a datetime-local input, in India time. */
export function isoToIstInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16);
}

/** A number typed by a person ("1,500", "₹1500") → 1500. Empty → undefined. NaN when not a number. */
export function num(v: string): number | undefined {
  const t = v.replace(/[₹,\s]/g, "");
  if (!t) return undefined;
  return Number(t);
}

/** Plan status → pill class. */
export function planPill(status: string): string {
  return status === "cancelled" ? "failed" : ["draft", "queued", "running", "done", "partial", "failed"].includes(status) ? status : "draft";
}

/** Meta's effective status → pill class and plain label. */
export function metaPill(effective: string): { cls: string; label: string } {
  switch (effective) {
    case "ACTIVE":
      return { cls: "done", label: "On" };
    case "PAUSED":
      return { cls: "draft", label: "Off" };
    case "CAMPAIGN_PAUSED":
      return { cls: "draft", label: "Off (campaign is off)" };
    case "ADSET_PAUSED":
      return { cls: "draft", label: "Off (ad set is off)" };
    case "IN_PROCESS":
    case "PENDING_REVIEW":
    case "PREAPPROVED":
      return { cls: "running", label: "In review" };
    case "WITH_ISSUES":
      return { cls: "failed", label: "Has issues" };
    case "DISAPPROVED":
      return { cls: "failed", label: "Rejected" };
    case "PENDING_BILLING_INFO":
      return { cls: "partial", label: "Needs payment details" };
    default:
      return { cls: "partial", label: effective.replace(/_/g, " ").toLowerCase() };
  }
}

/** Countries typed as "IN, AE" → ["IN", "AE"]. */
export function countryList(v: string): string[] {
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}
