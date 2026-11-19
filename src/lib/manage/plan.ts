import { createHash, randomBytes } from "node:crypto";
import { db, json } from "../db";
import { cacheDelete, cacheGet, cacheSet } from "../store";
import { HttpError } from "../httperror";
import { renderName } from "../engine/naming";
import { DeletionRefused, type MetaClient } from "../meta/client";
import { MetaError, RateLimitedError, mustSurface, plainError } from "../meta/errors";
import type { Clock } from "../meta/pacer";
import type { Check } from "../types";
import { appLink, sendAlert } from "../alerts";
import { istLabel, timeMs } from "../time";
import {
  accountInfo,
  adSetAds,
  adsetCloneParams,
  adsetExtras,
  adsetParams,
  ADSET_FIELDS,
  CAMPAIGN_FIELDS,
  campaignAdSets,
  campaignParams,
  describeAdSet,
  describeCampaign,
  getAdSet,
  getCampaign,
  isCbo,
  surfaceOr,
  touchesAudience,
  type AdSetRow,
  type AdSetSpec,
  type CampaignRow,
  type CampaignSpec,
  type Targeting,
} from "./objects";
import { BID_STRATEGIES, fromMinor, money, OBJECTIVES, toMinor } from "./options";
import { audienceSummary, createAudience, customerChunks, uploadCustomerChunk, type AudienceOp } from "./audiences";
import { adEditProblems, describeAdEdit, editAd, readAd, textOptionsProblem, type AdEditSpec } from "./ads";
import { accountHealth, pixelCheck } from "./checks";
import { dailyEquivalent } from "./budget";

// Change plans: every change to campaigns, ad sets, ads and audiences goes through one plan.
//   1. createPlan: the steps are saved and checked against a model of the account as each step
//      leaves it ("the world"), so a later step can use anything an earlier step makes ("$ref").
//      The check reads Meta (never writes), builds the summary (every ad set once, at its final
//      budget, and the total), warns about unusual budgets, and asks Meta to validate the first
//      create or edit of each kind (validate_only).
//   2. confirmPlan: needs confirm: true; when the plan turns something on, also the daily amount
//      that can spend afterwards, typed back exactly as the summary shows it. Nothing runs without this.
//   3. The worker runs the steps in order, paced, saving every new ID as it goes, so a restart
//      continues where it stopped and never creates anything twice. The first failed step stops
//      the plan; it can be fixed and retried: finished steps stay finished.
// Nothing is ever deleted or archived (MetaClient refuses it).

export type StatusValue = "PAUSED" | "ACTIVE";

export type Op =
  | ({ type: "create_campaign"; ref?: string } & CampaignSpec)
  | ({ type: "edit_campaign"; campaign: string } & CampaignSpec)
  | { type: "duplicate_campaign"; campaign: string; ref?: string; copies?: number; with_contents?: boolean; changes?: CampaignSpec[]; name_template?: string; persona?: string }
  | ({ type: "create_adset"; ref?: string; campaign: string } & AdSetSpec)
  | ({ type: "edit_adset"; adset: string } & AdSetSpec)
  | { type: "duplicate_adset"; adset: string; ref?: string; campaign?: string; copies?: number; with_ads?: boolean; changes?: AdSetSpec[]; name_template?: string; persona?: string }
  | { type: "ads_from_post"; post_id: string; ref?: string; source?: "facebook" | "instagram"; adsets: string[]; name?: string; name_template?: string; page_id?: string; instagram_user_id?: string; status?: StatusValue }
  | ({ type: "edit_ad"; ad: string } & AdEditSpec)
  | { type: "copy_ad"; ad: string; ref?: string; adsets: string[]; name?: string; name_template?: string; status?: StatusValue }
  | { type: "set_status"; status: StatusValue; campaigns?: string[]; adsets?: string[]; ads?: string[]; whole_campaigns?: string[] }
  | AudienceOp;

export interface PlanInput {
  title?: string;
  /** ISO time to run at (e.g. 2026-11-20T09:00:00+05:30). Empty = as soon as confirmed. */
  run_at?: string;
  /** The total daily budget the person planned, if they said one. The check stops the plan when it differs. */
  expected_daily_total?: number;
  /** The India date (YYYY-MM-DD) {date} in names stands for: fixed when the plan is first confirmed, so a retry on another day reuses the names. */
  name_date?: string;
  ops: Op[];
}

export interface SummaryAdSet {
  /** First step that makes or changes this ad set, and every such step. */
  step: number;
  steps: number[];
  name: string;
  campaign: string;
  /** null when the campaign's budget pays for it (campaign budget). */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  status: string;
  isNew: boolean;
  details: Record<string, string>;
}

export interface PlanSummary {
  account: { id: string; name: string; currency: string };
  /** The daily budget ceiling (Settings → Safety) when the plan was checked; 0 = none. */
  dailyCeiling?: number;
  runAt: string | null;
  steps: { n: number; title: string; lines: string[] }[];
  adsets: SummaryAdSet[];
  /** Campaign budgets in the plan (campaign budget campaigns made, copied, edited or turned on). */
  campaignBudgets: { name: string; dailyBudget: number | null; lifetimeBudget: number | null; status: string }[];
  /** spendNowDaily: what can spend in a day once the plan has run (campaigns and ad sets that end ON,
   *  lifetime budgets counted as lifetime ÷ days left). This is what is typed back to confirm. */
  totals: { campaigns: number; adsets: number; ads: number; dailyBudget: number; lifetimeBudget: number; spendNowDaily: number; turnsOn: string[] };
  checks: Check[];
  errors: number;
  warnings: number;
  canSpend: boolean;
  /** What the person types back to confirm a plan that can spend, e.g. "₹15,000". */
  spendConfirmation: string | null;
  /** Plain notes on the money, e.g. "₹30,000 lifetime counted as ₹15,000 a day". */
  notes?: string[];
  /** What the spend total is made of: every campaign budget (campaign budget) or ad set budget that is ON
   *  at the end, with its budgets, times and budget-period raise. Compared at run time and at confirmation
   *  (not the total itself, which moves as the days left on a lifetime budget go down). */
  spendBasis?: SpendItem[];
  /** Campaigns and ad sets the steps named by name, as found when checked: "<step>|<kind>|<name in
   *  lower case>" → ID. The run uses these IDs (what was confirmed) instead of reading the list again. */
  names?: Record<string, string>;
  /** "Turn on whole campaigns" steps: the ad sets and ads already in Meta that the check counted, by step
   *  number. The run turns on only these and what the plan itself made: never an ad set or ad added to
   *  the campaign after the check, nor one a retry left out. */
  wholeIds?: Record<string, string[]>;
}

export interface SpendItem {
  kind: "campaign" | "adset";
  id: string;
  daily: number | null;
  lifetime: number | null;
  start: string | null;
  end: string | null;
  /** The largest raise of the budget periods this plan adds (campaign budget only). */
  raise: number;
  /** This plan starts this spend or raises it: it was not spending before the plan (off, its campaign
   *  off, ended, or made by the plan), or the plan changes its budget, times, spend limit or budget
   *  periods, or turns something on in it. false: a budget already spending that the plan leaves as it
   *  is. Only these count when the run-start check (and the batch turn-on) ask "more than was confirmed?". */
  mine?: boolean;
}

export interface PlanProgress {
  /** "stopped": the person cancelled the plan while this step ran (not a failure). */
  status: "pending" | "running" | "done" | "failed" | "skipped" | "stopped";
  ids: string[];
  message: string;
  /** Items started but not saved (a crash may have created them): looked up before creating again. */
  attempted?: (number | string)[];
  /** When each attempted item was started (ms): a lookup by name only takes objects Meta made after it. */
  attemptedAt?: Record<string, number>;
  /** The name each attempted item was sent with: a lookup after a lost answer looks for that name, also
   *  when the step was changed since. */
  attemptedName?: Record<string, string>;
  /** Fields of this step that were changed after it stopped part-way (the items it made are kept): the
   *  run sends these to every item made before the change, so Meta matches the summary. */
  changed?: string[];
  /** Items an earlier version of this step made, maybe ON, that the changed step no longer uses: the run
   *  turns them off first (nothing is deleted). */
  orphans?: { id: string; kind: "campaign" | "adset" | "ad" }[];
  /** Items this step made that a changed version no longer uses (paused): never used again, but
   *  "Undo this plan" still turns them off. */
  unused?: { id: string; kind: "campaign" | "adset" | "ad" }[];
  /** Budget periods Meta took, by their mark: the campaign, the times (ms) and the raise sent (account
   *  currency), so a retry counts each one at the amount Meta really added. */
  periods?: Record<string, { campaign: string; s: number; e: number; amount: number }>;
  /** The ad set each item of an "ads from a post" or "copy an ad" step went into (by item place). */
  targets?: string[];
  /** How many times the step was changed to work on something else (new idempotency keys and marks). */
  gen?: number;
  /** Objects made inside one item (ad sets and ads of a copied campaign): source key → new ID.
   *  "users_N": part N of a customer list was uploaded. */
  sub?: Record<string, string>;
  /** Items whose follow-up writes (rename, edit, budget period) finished: a resumed run skips them. */
  finished?: string[];
  /** Values before this step changed them, for "Undo this plan": id → { field: old value }. */
  before?: Record<string, Record<string, unknown>>;
  /** What the run did instead of the plain way, with Meta's reason, by item: "rebuilt:<j>" (an ad set copy
   *  built from the original's settings without its spend limits), "min:<j>" (the minimum daily spend asked
   *  for a copy left out), "newpost:<j>" (a copied ad made with a new creative, a new post). Kept across
   *  retries, so the step's message always says what was built. */
  fallbacks?: Record<string, string>;
}

export interface PlanRow {
  id: number;
  key: string;
  ad_account_id: number;
  title: string;
  status: string;
  ops: string;
  summary: string | null;
  can_spend: number;
  run_at: string | null;
  progress: string;
  created_by: string | null;
  source: string;
  created_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  finished_at: string | null;
}

/** A budget period must start at least this long after the plan runs (a run a few minutes late still sends it in time). */
export const PERIOD_MARGIN_MS = 10 * 60_000;
/** Daily budget above this (account currency) gets a warning. Change with BUDGET_WARN_DAILY in .env. */
export const budgetWarnDaily = () => Number(process.env.BUDGET_WARN_DAILY || 10000);
export const MAX_COPIES = 200;
export const MAX_OPS = 300;
const STEP_TYPES = ["create_campaign", "edit_campaign", "duplicate_campaign", "create_adset", "edit_adset", "duplicate_adset", "ads_from_post", "edit_ad", "copy_ad", "set_status", "create_custom_audience", "create_lookalike"];

/** Each step type in plain words, for titles a person reads ("make an ad set", not "create adset"). */
const STEP_WORDS: Record<string, string> = {
  create_campaign: "make a campaign",
  edit_campaign: "change a campaign",
  duplicate_campaign: "copy a campaign",
  create_adset: "make an ad set",
  edit_adset: "change an ad set",
  duplicate_adset: "copy an ad set",
  ads_from_post: "make ads from a post",
  edit_ad: "change an ad",
  copy_ad: "copy an ad",
  set_status: "turn on or off",
  create_custom_audience: "make an audience",
  create_lookalike: "make a lookalike audience",
};
function stepWords(op: { type?: unknown; status?: unknown } | null | undefined): string {
  const t = String(op?.type ?? "step");
  if (t === "set_status") return op?.status === "ACTIVE" ? "turn on" : op?.status === "PAUSED" ? "turn off" : STEP_WORDS[t];
  return STEP_WORDS[t] ?? t.replace(/_/g, " ");
}

// ---------- Fields each step takes (anything else is refused, never ignored) ----------

const CAMPAIGN_KEYS: Record<keyof CampaignSpec, true> = {
  name: true, name_template: true, objective: true, budget_level: true, daily_budget: true, lifetime_budget: true, bid_strategy: true,
  special_ad_categories: true, special_ad_category_country: true, spend_cap: true, start_time: true, stop_time: true, status: true,
  persona: true, angle: true, budget_schedules: true,
};
const ADSET_KEYS: Record<keyof AdSetSpec, true> = {
  name: true, name_template: true, daily_budget: true, lifetime_budget: true, start_time: true, end_time: true, destination: true, goal: true,
  billing_event: true, bid_strategy: true, bid_amount: true, roas_average_floor: true, pixel_id: true, event: true, custom_event_str: true,
  custom_conversion_id: true, page_id: true, app_id: true, app_store_url: true, whatsapp_number: true, saved_audience_id: true, countries: true,
  regions: true, cities: true, age_min: true, age_max: true, genders: true, interests: true, custom_audiences: true, excluded_custom_audiences: true,
  advantage_audience: true, placements: true, targeting: true, attribution: true, min_daily_spend: true, max_daily_spend: true, status: true,
  persona: true, angle: true, schedule: true, frequency_cap: true, inventory_filter: true, block_list_ids: true, languages: true,
  targeting_expansion: true, dynamic_creative: true, replace_targeting: true,
};
const AD_EDIT_KEYS: Record<keyof AdEditSpec, true> = {
  name: true, status: true, primary_texts: true, headlines: true, description: true, link_url: true, cta: true, display_link: true,
  url_tags: true, media_url: true, creative_id: true,
};
const keysOf = (r: Record<string, true>) => Object.keys(r);
/** "ref" is taken on every step (steps that make nothing just don't use it). */
const OP_KEYS: Record<string, Set<string>> = {
  create_campaign: new Set(["type", "ref", ...keysOf(CAMPAIGN_KEYS)]),
  edit_campaign: new Set(["type", "ref", "campaign", ...keysOf(CAMPAIGN_KEYS)]),
  duplicate_campaign: new Set(["type", "ref", "campaign", "copies", "with_contents", "changes", "name_template", "persona"]),
  create_adset: new Set(["type", "ref", "campaign", ...keysOf(ADSET_KEYS)]),
  edit_adset: new Set(["type", "ref", "adset", ...keysOf(ADSET_KEYS)]),
  duplicate_adset: new Set(["type", "ref", "adset", "campaign", "copies", "with_ads", "changes", "name_template", "persona"]),
  ads_from_post: new Set(["type", "ref", "post_id", "source", "adsets", "name", "name_template", "page_id", "instagram_user_id", "status"]),
  edit_ad: new Set(["type", "ref", "ad", ...keysOf(AD_EDIT_KEYS)]),
  copy_ad: new Set(["type", "ref", "ad", "adsets", "name", "name_template", "status"]),
  set_status: new Set(["type", "ref", "status", "campaigns", "adsets", "ads", "whole_campaigns"]),
  create_custom_audience: new Set(["type", "ref", "name", "description", "source", "skipped_rows"]),
  create_lookalike: new Set(["type", "ref", "name", "source_audience", "country", "size_percent"]),
};
const CHANGE_KEYS: Record<string, Set<string>> = {
  duplicate_campaign: new Set(keysOf(CAMPAIGN_KEYS)),
  duplicate_adset: new Set(keysOf(ADSET_KEYS)),
};
/** Names people (and Claude) often use for a field, and the field the plan takes. */
const SAY_INSTEAD: Record<string, string> = {
  count: "copies", copy: "copies", number: "copies", budget: "daily_budget (or lifetime_budget)", daily: "daily_budget", lifetime: "lifetime_budget",
  age_minimum: "age_min", age_maximum: "age_max", min_age: "age_min", max_age: "age_max", gender: "genders", interest: "interests", country: "countries",
  locations: "countries, regions or cities", optimization_goal: "goal", destination_type: "destination", adset_id: "adset", ad_set: "adset",
  campaign_id: "campaign", ad_id: "ad", adset_ids: "adsets", ad_ids: "ads", campaign_ids: "campaigns", start: "start_time", end: "end_time",
  stop: "stop_time", end_date: "end_time", primary_text: "primary_texts", headline: "headlines", text: "primary_texts", bid: "bid_amount",
  bid_cap: "bid_amount", url: "link_url", link: "link_url", changes_per_copy: "changes",
};

/** Hints that depend on the step (a field one step takes is a wrong name in another). */
const STEP_SAY_INSTEAD: Record<string, Record<string, string>> = {
  create_lookalike: {
    countries: "country (one 2-letter code, e.g. \"IN\")", percent: "size_percent", ratio: "size_percent (1 to 10, in percent)", size: "size_percent", lookalike_percent: "size_percent",
    lookalike_size: "size_percent", source: "source_audience", source_audience_id: "source_audience", origin_audience_id: "source_audience", audience: "source_audience", audience_id: "source_audience",
  },
  create_custom_audience: {
    days: "source.days", retention_days: "source.days", lookback_days: "source.days", pixel_id: "source.pixel_id", kind: "source.kind", page_id: "source.page_id",
    video_ids: "source.video_ids", instagram_id: "source.instagram_id", emails: "source.emails", phones: "source.phones", subtype: "source.kind",
  },
};

// ---------- Audiences: every field checked before anything is described ----------

/** Meta's longest look-back for each kind of audience, in days (as audiences.ts sends them). */
const AUDIENCE_MAX_DAYS: Record<string, number> = { website: 180, video: 365, page: 365, instagram: 365, lead_form: 90 };
const AUDIENCE_KINDS = ["website", "video", "page", "instagram", "lead_form", "customer_list"];
/** The fields each kind of audience source takes. */
const SOURCE_KEYS: Record<string, string[]> = {
  website: ["kind", "pixel_id", "days", "url_contains", "event"],
  video: ["kind", "video_ids", "days", "watched"],
  page: ["kind", "page_id", "days", "engaged"],
  instagram: ["kind", "instagram_id", "days", "engaged"],
  lead_form: ["kind", "page_id", "days", "action"],
  customer_list: ["kind", "emails", "phones", "hashed"],
};
/** The field each kind needs besides kind and days, and what it is. */
const SOURCE_NEEDS: Record<string, [string, string]> = {
  website: ["pixel_id", "the pixel whose website visitors to use (lookup pixels lists them)"],
  video: ["video_ids", "a list of the video IDs whose viewers to use"],
  page: ["page_id", "the Facebook Page whose people to use"],
  instagram: ["instagram_id", "the Instagram account whose people to use"],
  lead_form: ["page_id", "the Facebook Page whose lead forms to use"],
};
const SOURCE_CHOICES: Record<string, Record<string, string[]>> = {
  video: { watched: ["3s", "thruplay", "25%", "50%", "75%", "95%"] },
  page: { engaged: ["all", "messaged", "cta_clicked"] },
  instagram: { engaged: ["all", "messaged", "visited"] },
  lead_form: { action: ["opened", "submitted", "opened_not_submitted"] },
};
/** Names people (and Claude) use for a source field, and the field the source takes. */
const SOURCE_SAY_INSTEAD: Record<string, string> = {
  retention_days: "days", lookback_days: "days", retention: "days", lookback: "days", days_back: "days", lookback_window: "days", window_days: "days",
  duration_days: "days", retention_seconds: "days (in days, not seconds)", pixel: "pixel_id", pixelid: "pixel_id", video_id: "video_ids", videos: "video_ids",
  page: "page_id", pageid: "page_id", instagram_user_id: "instagram_id", instagram_account_id: "instagram_id", ig_id: "instagram_id", url: "url_contains",
  urls: "url_contains", type: "kind", source_type: "kind", subtype: "kind", email: "emails", phone: "phones", phone_numbers: "phones",
};
const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
const shown = (v: unknown) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));

/**
 * What is wrong with an audience step, each naming the exact field the step takes ("source.days is
 * missing: …", "unknown field … in source; did you mean days?"). The step is described only when this is
 * empty, so a summary never shows "undefined".
 */
export function audienceProblems(op: AudienceOp): string[] {
  const out: string[] = [];
  const o = op as unknown as Record<string, unknown>;
  if (isBlank(o.name)) out.push("name is missing: the audience's name.");
  if (op.type === "create_lookalike") {
    if (isBlank(o.source_audience)) out.push('source_audience is missing: the ID of the audience to start from (or "$ref" of an audience this plan makes).');
    if (isBlank(o.country)) out.push('country is missing: the 2-letter code of the country where Meta finds similar people, e.g. "IN".');
    else if (typeof o.country !== "string" || !/^[A-Z]{2}$/.test(o.country)) out.push(`country must be a 2-letter code in capitals, e.g. "IN" (got ${shown(o.country)}).`);
    const size = typeof o.size_percent === "string" && o.size_percent.trim() ? Number(o.size_percent) : o.size_percent;
    if (isBlank(o.size_percent)) out.push("size_percent is missing: how much of the country's people, from 1 to 10 (in percent; 1 = the most like the audience).");
    else if (!(typeof size === "number" && size >= 1 && size <= 10)) out.push(`size_percent must be a number from 1 to 10 (got ${shown(o.size_percent)}).`);
    return out;
  }
  const src = o.source;
  if (isBlank(src)) {
    out.push('source is missing: where the people come from, e.g. {"kind": "website", "pixel_id": "…", "days": 30}.');
    return out;
  }
  if (typeof src !== "object" || Array.isArray(src)) {
    out.push('source must be an object, e.g. {"kind": "website", "pixel_id": "…", "days": 30}.');
    return out;
  }
  const s = src as Record<string, unknown>;
  const kind = String(s.kind ?? "");
  if (isBlank(s.kind)) out.push(`source.kind is missing: one of ${AUDIENCE_KINDS.join(", ")}.`);
  else if (!AUDIENCE_KINDS.includes(kind)) out.push(`source.kind ${shown(s.kind)} is not a kind of audience the launcher makes: use one of ${AUDIENCE_KINDS.join(", ")}.`);
  const keys = SOURCE_KEYS[kind] ?? [...new Set(Object.values(SOURCE_KEYS).flat())];
  for (const k of Object.keys(s)) {
    if (s[k] === undefined || keys.includes(k)) continue;
    const hint = SOURCE_SAY_INSTEAD[k] ?? SOURCE_SAY_INSTEAD[k.toLowerCase()];
    out.push(`unknown field "${k}" in source${hint ? `; did you mean ${hint}?` : `. A ${kind || "source"} audience takes ${keys.join(", ")}.`}`);
  }
  if (!AUDIENCE_KINDS.includes(kind) || kind === "customer_list") return out;
  const max = AUDIENCE_MAX_DAYS[kind] ?? 365;
  const what = `a ${kind.replace("_", " ")} audience`;
  const days = typeof s.days === "string" && s.days.trim() ? Number(s.days) : s.days;
  if (isBlank(s.days)) out.push(`source.days is missing: how many days back to look, from 1 to ${max} for ${what}.`);
  else if (!(typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= max)) out.push(`source.days must be a whole number of days from 1 to ${max} for ${what} (got ${shown(s.days)}).`);
  const [need, means] = SOURCE_NEEDS[kind];
  if (isBlank(s[need])) out.push(`source.${need} is missing: ${means}.`);
  for (const [field, allowed] of Object.entries(SOURCE_CHOICES[kind] ?? {})) {
    if (s[field] !== undefined && !allowed.includes(String(s[field]))) out.push(`source.${field} must be one of ${allowed.join(", ")} (got ${shown(s[field])}).`);
  }
  if (kind === "website" && s.url_contains !== undefined && !(Array.isArray(s.url_contains) && s.url_contains.every((u) => typeof u === "string" && u.trim()))) out.push('source.url_contains must be a list of words in the page address, e.g. ["/pricing"].');
  if (kind === "video" && s.video_ids !== undefined && !Array.isArray(s.video_ids)) out.push('source.video_ids must be a list of video IDs, e.g. ["123", "456"].');
  return out;
}

/** Fields that take a list. A text given alone is never split into letters: the app and Claude's calls
 *  make it a one-item list (service.ts), and the check refuses anything else that is not a list. */
export const LIST_FIELDS = ["adsets", "campaigns", "ads", "whole_campaigns", "countries", "primary_texts", "headlines", "custom_audiences", "excluded_custom_audiences", "interests", "languages", "block_list_ids", "special_ad_categories"];

/** List fields of a step (and of its copies' changes) that are not lists. */
function notLists(op: Record<string, unknown>): string[] {
  const bad = (o: Record<string, unknown>, where: string) => LIST_FIELDS.filter((k) => o[k] !== undefined && o[k] !== null && !Array.isArray(o[k])).map((k) => `${where}${k} must be a list, e.g. ${k.includes("campaign") ? '["Campaign name"]' : k === "countries" ? '["IN"]' : k.includes("text") || k === "headlines" ? '["First text"]' : '["as1"]'} (got ${JSON.stringify(o[k])}).`);
  const out = bad(op, "");
  if (Array.isArray(op.changes)) op.changes.forEach((c, j) => c && typeof c === "object" && out.push(...bad(c as Record<string, unknown>, `copy ${j + 1}: `)));
  return out;
}

// ---------- Refs and names ----------

/** "$copies" = everything step "copies" made; "$copies.2" = the second one (counting from 1). */
const REF = /^\$([A-Za-z0-9_-]+)(?:\.(\d+))?$/;
export const isRef = (s: string | undefined) => !!s && s.startsWith("$");
export const refKey = (r: string | undefined, n: number) => (r ? r.replace(/^\$/, "").trim() : `step${n}`);
const KIND_WORDS: Record<string, [string, string]> = { campaign: ["campaign", "campaigns"], adset: ["ad set", "ad sets"], ad: ["ad", "ads"], audience: ["audience", "audiences"] };

function newKey(): string {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  for (;;) {
    const k = "p" + Array.from(randomBytes(4), (b) => a[b % a.length]).join("");
    if (!db().prepare("SELECT 1 FROM plans WHERE key = ?").get(k)) return k;
  }
}

export function idemKey(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function copiesOf(op: { copies?: number; changes?: unknown[] }): number {
  return Math.max(op.changes?.length ?? 0, op.copies ?? (op.changes?.length ? 0 : 1));
}

/** {date} in a name stands for `date` (the India date the plan was confirmed), or today. */
export function nameFor(pattern: string | undefined, fallback: string, ctx: { n: number; persona?: string; angle?: string; campaign?: string; objective?: string; budget?: number | null; adset?: string; date?: string }): string {
  if (!pattern) return fallback;
  const date = ctx.date && /^\d{4}-\d\d-\d\d$/.test(ctx.date) ? new Date(`${ctx.date}T12:00:00+05:30`) : new Date();
  return renderName(pattern, {
    date,
    n: ctx.n,
    persona: ctx.persona ?? "",
    angle: ctx.angle ?? "",
    campaign: ctx.campaign ?? "",
    adset: ctx.adset ?? "",
    objective: (ctx.objective ?? "").replace(/^OUTCOME_/, ""),
    budget: ctx.budget ? String(ctx.budget) : "",
  }).slice(0, 380);
}

/** Today's date in India (YYYY-MM-DD). */
export function indiaDate(ms = Date.now()): string {
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
}

export const needsBid = (s?: string) => s === "COST_CAP" || s === "LOWEST_COST_WITH_BID_CAP";
const DEFAULT_BID = "LOWEST_COST_WITHOUT_CAP";

/**
 * What is actually sent for an ad set. Meta refuses an ad set in a campaign without campaign budget
 * when it has no bid strategy (100/2490487, plan psx4n), so it gets "Highest volume" unless the plan
 * says otherwise (or the campaign step in this plan named one).
 */
export function effectiveAdsetSpec<T extends AdSetSpec>(spec: T, cbo: boolean, campaignDefaultBid?: string): T {
  if (cbo) return spec;
  if (spec.bid_strategy) return spec;
  return { ...spec, bid_strategy: campaignDefaultBid ?? DEFAULT_BID };
}

/** What is sent for a campaign: with budgets on ad sets (ABO) the bid strategy belongs to the ad sets
 *  (Meta refuses it on the campaign: 100/1885737); with a campaign budget it defaults to Highest volume. */
export function effectiveCampaignSpec(spec: CampaignSpec): CampaignSpec {
  const cbo = spec.budget_level === "campaign" || spec.daily_budget !== undefined || spec.lifetime_budget !== undefined;
  if (!cbo) return { ...spec, bid_strategy: undefined };
  return { ...spec, bid_strategy: spec.bid_strategy ?? DEFAULT_BID };
}

/** JSON with keys in a fixed order and undefined values left out, to compare steps sent back in another order. */
export function canon(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, sort(o[k])]));
    }
    return x;
  };
  return JSON.stringify(sort(v)) ?? "";
}

/** "daily", "lifetime" or "none": Meta can't switch an object it made between these. */
const budgetKind = (o: { daily_budget?: number; lifetime_budget?: number; budget_level?: string }) =>
  o.daily_budget !== undefined ? "daily" : o.lifetime_budget !== undefined ? "lifetime" : o.budget_level === "campaign" ? "campaign" : "none";

/**
 * What a step works on (its type, source and targets) and the settings Meta can't change on an object
 * once it is made (objective, budget type, special ad category; an ad set's goal and destination; an
 * audience's source). A stopped step that is fixed keeps what it made only while this stays the same,
 * and the run then sends the changed settings to it (PlanProgress.changed); otherwise the step makes
 * new items and what it made before is not used (turned off first when it may be on).
 */
export function stepIdentity(op: Op): string {
  const o = op as unknown as Record<string, unknown>;
  const pick = (...k: string[]) => canon(Object.fromEntries(k.map((x) => [x, o[x]])));
  const special = (list?: string[]) => [...(list ?? [])].filter((x) => x && x !== "NONE").sort();
  switch (op.type) {
    case "create_campaign": return canon({ type: op.type, objective: op.objective, budget: budgetKind(op), special: special(op.special_ad_categories), country: op.special_ad_category_country });
    case "edit_campaign": return pick("type", "campaign");
    case "duplicate_campaign": return pick("type", "campaign");
    case "create_adset": return canon({ type: op.type, campaign: op.campaign, budget: budgetKind(op), goal: op.goal, destination: op.destination, dynamic: op.dynamic_creative });
    case "edit_adset": return pick("type", "adset");
    case "duplicate_adset": return pick("type", "adset", "campaign");
    case "ads_from_post": return pick("type", "post_id", "source", "adsets", "page_id", "instagram_user_id");
    case "copy_ad": return pick("type", "ad", "adsets");
    case "edit_ad": return pick("type", "ad");
    case "set_status": return pick("type", "status", "campaigns", "adsets", "ads", "whole_campaigns");
    case "create_custom_audience": return pick("type", "source");
    case "create_lookalike": return pick("type", "source_audience", "country", "size_percent");
    default: return canon(op);
  }
}

/** The fields of a step that differ between two versions of it. */
export function changedFields(a: Op, b: Op): string[] {
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => k !== "type" && canon(x[k]) !== canon(y[k])).sort();
}

/** The mark a budget period gets once Meta took it: the period itself, so a changed list never skips or repeats one. */
export const periodMark = (b: { start: string; end: string; increase_percent?: number; increase_amount?: number }) =>
  `schedule:${canon({ start: timeMs(b.start), end: timeMs(b.end), increase_percent: b.increase_percent, increase_amount: b.increase_amount })}`;

/** Items a step made that may be ON (it made them ON or turned them on), by kind. */
export function itemsMaybeOn(op: Op, p: PlanProgress | undefined): { id: string; kind: "campaign" | "adset" | "ad" }[] {
  if (!p) return [];
  const ids = p.ids.map((x, j) => ({ id: x, j })).filter((x) => !!x.id);
  // An earlier version of the step may have made them ON when its status (or its copies' changes) changed since.
  const wasOn = (op as { status?: string }).status === "ACTIVE" || !!p.changed?.includes("status");
  const changesOn = (j: number) => ((op as { changes?: { status?: string }[] }).changes ?? [])[j]?.status === "ACTIVE" || !!p.changed?.includes("changes");
  switch (op.type) {
    case "create_campaign": return wasOn ? ids.map((x) => ({ id: x.id, kind: "campaign" as const })) : [];
    case "create_adset": return wasOn ? ids.map((x) => ({ id: x.id, kind: "adset" as const })) : [];
    case "duplicate_campaign": return ids.filter((x) => changesOn(x.j)).map((x) => ({ id: x.id, kind: "campaign" as const }));
    case "duplicate_adset": return ids.filter((x) => changesOn(x.j)).map((x) => ({ id: x.id, kind: "adset" as const }));
    case "ads_from_post":
    case "copy_ad": return wasOn ? ids.map((x) => ({ id: x.id, kind: "ad" as const })) : [];
    case "set_status": {
      // What a turn-on step turned on itself (it was off before): not what was already on.
      if (op.status !== "ACTIVE") return [];
      const kindOf = (k: unknown) => (k === "campaign" || k === "adset" ? k : "ad") as "campaign" | "adset" | "ad";
      return ids.filter((x) => p.before?.[x.id] && p.before[x.id].status !== "ACTIVE").map((x) => ({ id: x.id, kind: kindOf(p.before![x.id].kind) }));
    }
    default: return [];
  }
}

/** Items a step made, by kind (what it made itself, not what it changed or turned on). */
export function itemsMade(op: Op, p: PlanProgress | undefined): { id: string; kind: "campaign" | "adset" | "ad" }[] {
  if (!p) return [];
  const ids = p.ids.filter(Boolean);
  const subs = Object.entries(p.sub ?? {}).filter(([k]) => !k.startsWith("users_") && k !== "creative");
  switch (op.type) {
    case "create_campaign": return ids.map((id) => ({ id, kind: "campaign" as const }));
    case "duplicate_campaign": return [...ids.map((id) => ({ id, kind: "campaign" as const })), ...subs.map(([k, id]) => ({ id, kind: (k.split("/").length > 2 ? "ad" : "adset") as "ad" | "adset" }))];
    case "create_adset": return ids.map((id) => ({ id, kind: "adset" as const }));
    case "duplicate_adset": return [...ids.map((id) => ({ id, kind: "adset" as const })), ...subs.map(([, id]) => ({ id, kind: "ad" as const }))];
    case "ads_from_post":
    case "copy_ad": return ids.map((id) => ({ id, kind: "ad" as const }));
    default: return [];
  }
}

/** A Housing, Employment or Credit campaign: Meta limits its targeting. */
const RESTRICTED_CATEGORIES: Record<string, string> = { HOUSING: "housing", EMPLOYMENT: "employment", FINANCIAL_PRODUCTS_SERVICES: "credit / financial", CREDIT: "credit" };

/** Meta's targeting rules for special ad categories: ages 18 to 65+, no gender, city radius at least 15 mi / 25 km. */
function specialTargetingProblems(t: Targeting | undefined, categories: string[] | undefined): string[] {
  const cats = (categories ?? []).filter((c) => RESTRICTED_CATEGORIES[c]);
  if (!cats.length || !t) return [];
  const what = `${cats.map((c) => RESTRICTED_CATEGORIES[c]).join(" and ")} ads`;
  const out: string[] = [];
  const min = t.age_min ?? 18;
  const max = t.age_max ?? 65;
  if (min > 18 || max < 65) out.push(`${what} must reach every age from 18 to 65+ (Meta's rule for this special ad category); this ad set has age ${min}–${max}. Leave age_min and age_max out.`);
  if (t.genders?.length) out.push(`${what} can't be shown to one gender only (Meta's rule for this special ad category). Use genders "all".`);
  const small = (t.geo_locations?.cities ?? []).filter((c) => c.radius !== undefined && (c.distance_unit === "mile" ? c.radius < 15 : c.radius < 25));
  if (small.length) out.push(`${what} need a radius of at least 25 km (15 miles) around a city (Meta's rule for this special ad category); ${small.map((c) => `${c.name ?? c.key} has ${c.radius} ${c.distance_unit === "mile" ? "mi" : "km"}`).join(", ")}.`);
  return out;
}

/** Budget period increase in rupees: a percent of the campaign's daily budget, or a fixed amount. */
export function scheduleIncrease(b: { increase_percent?: number; increase_amount?: number }, daily: number | null): number | null {
  if (b.increase_amount !== undefined) return Number(b.increase_amount);
  if (b.increase_percent === undefined || !daily) return null;
  return Math.round(daily * Number(b.increase_percent)) / 100;
}

// ---------- The world as the plan sees it ----------

/** A budget-period raise on a campaign budget: from s to e (ms), plus `amount` a day. `inMeta`: this
 *  plan already sent it (or sent it and lost Meta's answer), so the same period read from Meta is this one. */
interface Raise { s: number; e: number; amount: number; inMeta?: boolean }
/** An object as Meta had it before the plan (read from Meta; none for what the plan makes). */
interface Orig { status: string; daily: number | null; lifetime: number | null; start: string | null; end: string | null; spendCap?: number | null }
/** `src`: the campaign a plan-made copy was copied from (its budget periods in Meta may come along).
 *  `planRaise`: this plan adds budget periods to it. */
interface WCampaign { id: string; name: string; status: string; cbo: boolean; daily: number | null; lifetime: number | null; start: string | null; end: string | null; spendCap?: number | null; objective?: string; bidDefault?: string; special: string[]; virtual: boolean; touched: boolean; involved: boolean; steps: number[]; raises: Raise[]; src?: string; orig?: Orig; planRaise?: boolean }
interface WAdSet { id: string; name: string; status: string; campaignId: string; daily: number | null; lifetime: number | null; virtual: boolean; touched: boolean; isNew: boolean; steps: number[]; row: Partial<AdSetRow>; ads: string[]; orig?: Orig }
/** What an ad's creative allows: an existing post (text can't change) and text options (several texts). */
interface AdLook { name: string; fromPost: boolean; textOptions: boolean }
interface WAd { id: string; name: string; status: string; adsetId: string; virtual: boolean; sourceAd?: string; look?: AdLook }

class World {
  campaigns = new Map<string, WCampaign>();
  adsets = new Map<string, WAdSet>();
  ads = new Map<string, WAd>();
  refs = new Map<string, { kind: "campaign" | "adset" | "ad" | "audience"; ids: string[] }>();
  private loadedTrees = new Set<string>();
  private loadedAds = new Set<string>();
  private names: { campaign?: { id: string; name: string }[]; adset?: { id: string; name: string }[] } = {};
  /** Real objects left out of the lists read from Meta: items a stopped step made (the step's own items
   *  stand for them, at the settings it will give them) and items the run turns off first. */
  private skip = new Set<string>();
  /** The step being checked, and the names its references were found by ("<step>|<kind>|<name>" → ID). */
  step = 0;
  named = new Map<string, string>();

  constructor(private client: MetaClient, private currency: string) {}

  private budget(minor: string | number | null | undefined) {
    return fromMinor(minor as string, this.currency);
  }

  /** A real object this check must not count from Meta's lists (see `skip`). */
  standIn(id: string) {
    if (!id || isRef(id)) return;
    this.skip.add(id);
    this.adsets.delete(id);
    this.ads.delete(id);
  }

  campaignOf(c: CampaignRow): WCampaign {
    const w: WCampaign = { id: c.id, name: c.name, status: c.status, cbo: isCbo(c), daily: this.budget(c.daily_budget) || null, lifetime: this.budget(c.lifetime_budget) || null, start: c.start_time ?? null, end: c.stop_time ?? null, spendCap: this.budget(c.spend_cap) || null, objective: c.objective, special: (c.special_ad_categories ?? []).filter((x) => x && x !== "NONE"), virtual: false, touched: false, involved: false, steps: [], raises: [] };
    w.orig = { status: w.status, daily: w.daily, lifetime: w.lifetime, start: w.start, end: w.end, spendCap: w.spendCap };
    return w;
  }

  adsetOf(a: AdSetRow): WAdSet {
    const w: WAdSet = { id: a.id, name: a.name, status: a.status, campaignId: a.campaign_id, daily: this.budget(a.daily_budget) || null, lifetime: this.budget(a.lifetime_budget) || null, virtual: false, touched: false, isNew: false, steps: [], row: a, ads: [] };
    w.orig = { status: w.status, daily: w.daily, lifetime: w.lifetime, start: a.start_time ?? null, end: a.end_time ?? null };
    return w;
  }

  /** Is this real ID one the check leaves out of Meta's lists (a stand-in's real item, or one turned off first)? */
  skipped(id: string) {
    return this.skip.has(id);
  }

  async campaign(id: string): Promise<WCampaign> {
    const hit = this.campaigns.get(id);
    if (hit) return hit;
    const w = this.campaignOf(await getCampaign(this.client, id));
    w.id = id;
    this.campaigns.set(id, w);
    return w;
  }

  async adset(id: string): Promise<WAdSet> {
    const hit = this.adsets.get(id);
    if (hit) return hit;
    const w = this.adsetOf(await getAdSet(this.client, id));
    w.id = id;
    this.adsets.set(id, w);
    return w;
  }

  /**
   * Campaigns, ad sets or ads of THIS ad account, read by ID with one account-level read per 100 IDs
   * (not one read each). Returns the IDs that are not in the ad account.
   */
  async preload(kind: "campaign" | "adset" | "ad", ids: string[]): Promise<string[]> {
    const map: Map<string, unknown> = kind === "campaign" ? this.campaigns : kind === "adset" ? this.adsets : this.ads;
    const absent = this.absent[kind];
    const mine = ids.filter((id) => id && !isRef(id));
    const want = [...new Set(mine.filter((id) => !map.has(id) && !absent.has(id)))];
    const found = new Set<string>();
    const edge = kind === "campaign" ? "campaigns" : kind === "adset" ? "adsets" : "ads";
    const fields = kind === "campaign" ? CAMPAIGN_FIELDS : kind === "adset" ? ADSET_FIELDS : "id,name,status,effective_status,adset_id";
    for (let i = 0; i < want.length; i += 100) {
      const part = want.slice(i, i + 100);
      const rows = await this.client.getAll<Record<string, unknown> & { id: string }>(`${this.client.accountId}/${edge}`, { fields, filtering: [{ field: "id", operator: "IN", value: part }], limit: 100 }, part.length + 10);
      for (const r of rows) {
        if (!part.includes(r.id)) continue;
        found.add(r.id);
        if (kind === "campaign") this.campaigns.set(r.id, this.campaignOf(r as unknown as CampaignRow));
        else if (kind === "adset") this.adsets.set(r.id, this.adsetOf(r as unknown as AdSetRow));
        else this.ads.set(r.id, { id: r.id, name: String(r.name ?? ""), status: String(r.status ?? ""), adsetId: String(r.adset_id ?? ""), virtual: false });
      }
    }
    for (const id of want) if (!found.has(id)) absent.add(id);
    // Not in this ad account: read now, or found missing by an earlier read of the same check.
    return [...new Set(mine.filter((id) => absent.has(id) && !map.has(id)))];
  }

  /** IDs a preload found missing from this ad account (not asked again in the same check). */
  private absent = { campaign: new Set<string>(), adset: new Set<string>(), ad: new Set<string>() };

  /** Every ad set of a campaign, as it is at this point of the plan. */
  async adsetsOf(campaignId: string): Promise<WAdSet[]> {
    const c = this.campaigns.get(campaignId);
    if (!c?.virtual && !this.loadedTrees.has(campaignId)) {
      this.loadedTrees.add(campaignId);
      for (const a of await campaignAdSets(this.client, campaignId)) {
        if (!this.adsets.has(a.id) && !this.skip.has(a.id)) this.adsets.set(a.id, { ...this.adsetOf(a), campaignId });
      }
    }
    return [...this.adsets.values()].filter((a) => a.campaignId === campaignId);
  }

  /** Every ad of an ad set, as it is at this point of the plan. */
  async adsOf(adsetId: string): Promise<WAd[]> {
    const a = this.adsets.get(adsetId);
    if (a && !a.virtual && !this.loadedAds.has(adsetId)) {
      this.loadedAds.add(adsetId);
      for (const ad of await adSetAds(this.client, adsetId)) {
        if (!this.ads.has(ad.id) && !this.skip.has(ad.id)) this.ads.set(ad.id, { id: ad.id, name: ad.name, status: ad.status, adsetId, virtual: false, sourceAd: ad.id });
      }
    }
    return [...this.ads.values()].filter((x) => x.adsetId === adsetId);
  }

  private async nameList(kind: "campaign" | "adset") {
    if (kind === "campaign") {
      this.names.campaign ??= await this.client.getAll<{ id: string; name: string }>(`${this.client.accountId}/campaigns`, { fields: "id,name", effective_status: ["ACTIVE", "PAUSED", "IN_PROCESS", "WITH_ISSUES"] }, 2000);
      return this.names.campaign;
    }
    this.names.adset ??= await this.client.getAll<{ id: string; name: string }>(`${this.client.accountId}/adsets`, { fields: "id,name", effective_status: ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "IN_PROCESS", "WITH_ISSUES"] }, 5000);
    return this.names.adset;
  }

  /** IDs for a reference: "$ref", "$ref.2", an ID, or (for campaigns and ad sets) an exact name. */
  async resolve(kind: "campaign" | "adset" | "ad" | "audience", s: string): Promise<string[]> {
    const v = String(s ?? "").trim();
    if (!v) throw new Error(`no ${KIND_WORDS[kind][0]} given.`);
    if (isRef(v)) {
      const m = REF.exec(v);
      if (!m) throw new Error(`"${v}" is not a reference. Use "$name" or "$name.2".`);
      const r = this.refs.get(m[1]);
      if (!r) throw new Error(`"${v}" doesn't name an earlier step's ref.`);
      const say = (k: string) => ({ campaign: "a campaign", adset: "an ad set", ad: "an ad", audience: "an audience" })[k] ?? k;
      if (r.kind !== kind) throw new Error(`"${v}" is ${say(r.kind)}, not ${say(kind)}.`);
      if (m[2] === undefined) return r.ids;
      const i = Number(m[2]);
      if (i < 1 || i > r.ids.length) throw new Error(`"${v}": step "${m[1]}" makes ${r.ids.length} item${r.ids.length === 1 ? "" : "s"}, so use ${r.ids.length === 1 ? `$${m[1]}` : `$${m[1]}.1 to $${m[1]}.${r.ids.length}`}.`);
      return [r.ids[i - 1]];
    }
    if (/^\d+$/.test(v) || kind === "ad" || kind === "audience") return [v];
    // A name: find it in the account (exact, ignoring case), as the plan has left the names at this step:
    // ad sets made or renamed by earlier steps go by their new names.
    // What a stopped step made is in Meta, but its step's own item stands for it here (one item, by the
    // name the step gives it): the real one is left out, so the name is not found twice.
    const list = (await this.nameList(kind)).filter((x) => !this.skip.has(x.id));
    const map: Map<string, { id: string; name: string }> = kind === "campaign" ? this.campaigns : this.adsets;
    const inList = new Set(list.map((x) => x.id));
    const now = [...list.map((x) => ({ id: x.id, name: map.get(x.id)?.name ?? x.name })), ...[...map.values()].filter((x) => !inList.has(x.id)).map((x) => ({ id: x.id, name: x.name }))];
    const lc = v.toLowerCase();
    const hits = now.filter((x) => x.name.toLowerCase() === lc);
    if (!hits.length) {
      const old = list.find((x) => x.name.toLowerCase() === lc && map.get(x.id) && map.get(x.id)!.name.toLowerCase() !== lc);
      if (old) throw new Error(`no ${KIND_WORDS[kind][0]} is called "${v}" at this step: an earlier step renames it to "${map.get(old.id)!.name}". Use its new name or its ID (${old.id}).`);
    }
    const id = onlyOne(hits, v, KIND_WORDS[kind][0]);
    // Found in Meta, or taken as an ID (no name matches): the run uses this, as confirmed. Not one this
    // plan makes (the run finds that by its name once it exists).
    if (!isRef(id) && !id.includes("/")) this.named.set(`${this.step}|${kind}|${lc}`, id);
    return [id];
  }
}

/** One match by name; no match means the text is taken as an ID (Meta then says if it doesn't exist). */
function onlyOne(list: { id: string; name: string }[], v: string, what: string): string {
  if (!list.length) return v;
  if (new Set(list.map((x) => x.id)).size > 1) throw new Error(`${list.length} ${what}s are called "${v}" (IDs ${list.map((x) => x.id).join(", ")}). Use the ID.`);
  return list[0].id;
}

/** A ref to several items, where the step uses one: refused, never "the first one" silently. */
function oneOf(ids: string[], s: string, kind: "campaign" | "adset" | "ad" | "audience", what: string): string {
  if (ids.length === 1) return ids[0];
  throw new Error(`"${s}" is ${ids.length} ${KIND_WORDS[kind][1]}, but ${what} uses one. Use "${s}.1" to "${s}.${ids.length}" (one step for each), or a ref to one item.`);
}

/** "Not found" (code 100) reads become null; anything else is thrown. */
function notFound(e: unknown): null {
  if (!mustSurface(e) && e instanceof MetaError && e.code === 100) return null;
  throw e;
}

/** Custom audiences made earlier in this plan ("$ref") can't go to Meta's validate_only check: they don't exist yet. */
function withoutAudienceRefs<T extends AdSetSpec>(spec: T): { spec: T; stripped: boolean } {
  let stripped = false;
  const keep = (list?: (string | { id: string; name?: string })[]) => {
    if (!list) return list;
    const out = list.filter((x) => !isRef(typeof x === "string" ? x : x?.id));
    if (out.length !== list.length) stripped = true;
    return out;
  };
  const out = { ...spec, custom_audiences: keep(spec.custom_audiences), excluded_custom_audiences: keep(spec.excluded_custom_audiences) };
  if (!spec.custom_audiences) delete out.custom_audiences;
  if (!spec.excluded_custom_audiences) delete out.excluded_custom_audiences;
  return { spec: out, stripped };
}

// ---------- Check and summary ----------

/**
 * The one creative of an "ads from a post" step. A Facebook post goes by its story ID (Page ID + post ID),
 * an organic Instagram post by its media ID. Instagram posts made for ads are reused by their Facebook post ID.
 */
function postCreative(op: Extract<Op, { type: "ads_from_post" }>): Record<string, unknown> {
  const name = `${op.name ?? "Post"} [post ${op.post_id}]`.slice(0, 100);
  if (op.source === "instagram") return { name, source_instagram_media_id: op.post_id, instagram_user_id: op.instagram_user_id };
  const storyId = !op.post_id.includes("_") && op.page_id ? `${op.page_id}_${op.post_id}` : op.post_id;
  return { name, object_story_id: storyId };
}

const MONEY_FIELDS = ["daily_budget", "lifetime_budget", "bid_amount", "spend_cap", "min_daily_spend", "max_daily_spend"];

/** Read Meta and describe what the plan will do. Writes nothing to Meta except validate_only checks.
 *  `done`: steps a stopped plan already finished (index → IDs), when the plan is retried.
 *  `progress`: the plan's saved progress (a retried plan): what its steps already made, the budget
 *  periods Meta already took and the items the run turns off first. */
export async function summarise(client: MetaClient, input: PlanInput, opts: { validate?: boolean; done?: Map<number, string[]>; progress?: PlanProgress[]; atRun?: boolean } = {}): Promise<PlanSummary> {
  const info = await accountInfo(client);
  const cur = info.currency;
  const world = new World(client, cur);
  /** The saved progress of a step that has not finished (a stopped step being retried), if any. */
  const openProgress = (i: number): PlanProgress | undefined => {
    const p = opts.progress?.[i];
    return p && p.status !== "done" && !opts.done?.has(i) ? p : undefined;
  };
  // What stopped steps made stands in as the step's own items (counted once, at the step's settings),
  // and what the run turns off first is not counted as on.
  (input.ops ?? []).forEach((op, i) => {
    const p = openProgress(i);
    if (!p || !op) return;
    for (const x of [...itemsMade(op, p), ...(p.orphans ?? []), ...(p.unused ?? [])]) world.standIn(x.id);
  });
  const steps: PlanSummary["steps"] = [];
  const checks: Check[] = [];
  const turnsOn: string[] = [];
  let adsN = 0;
  let canSpend = false;
  let lastTurnOn = 0;
  const validated = new Set<string>();
  let postChecks = 0;
  const err = (n: number, message: string) => checks.push({ level: "error", code: "plan", message: `Step ${n}: ${message}` });
  const warn = (n: number, message: string) => checks.push({ level: "warning", code: "plan", message: `Step ${n}: ${message}` });
  const m = (v: number | null | undefined) => money(v ?? null, cur);
  const ops = input.ops ?? [];
  const date = input.name_date;
  const looks = new Map<string, AdLook | null>();
  /** Ad sets where this plan turns ads on (off → on): their spend is started by the plan. */
  const lit = new Set<string>();
  /** "Turn on whole campaigns" steps: the real ad sets and ads counted, by step (see PlanSummary.wholeIds). */
  const wholeSaved: Record<string, string[]> = {};

  if (!ops.length) checks.push({ level: "error", code: "plan_empty", message: "The plan has no steps." });
  if (ops.length > MAX_OPS) checks.push({ level: "error", code: "plan_big", message: `At most ${MAX_OPS} steps in one plan. Split it.` });
  const runMs = input.run_at ? timeMs(input.run_at) : NaN;
  if (input.run_at && Number.isNaN(runMs)) checks.push({ level: "error", code: "run_at", message: `"${input.run_at}" is not a date and time. Use e.g. 2026-11-20T09:00:00+05:30 (India time when no zone is given).` });
  else if (input.run_at && runMs < Date.now() - 60_000) checks.push({ level: "error", code: "run_at", message: `The start time ${istLabel(input.run_at)} is in the past.` });
  const refNames = ops.map((o, i) => refKey((o as { ref?: string })?.ref, i + 1));
  for (const [i, r] of refNames.entries()) if (refNames.indexOf(r) !== i) checks.push({ level: "error", code: "ref_twice", message: `Step ${i + 1}: the ref "${r}" is already used by step ${refNames.indexOf(r) + 1}. Give each step its own ref.` });
  // Lifetime budgets are spread over the days from when the plan runs (or the budget starts, if later) to
  // their end: the same rule as the batch go-live (dailyEquivalent).
  const asOf = Math.max(Date.now(), Number.isFinite(runMs) ? runMs : 0);

  // Every campaign, ad set and ad the steps name by ID is read together (one read per kind for each 100
  // IDs), with the ad sets of ads that are turned on and the campaigns of those ad sets, instead of one
  // read each in the steps (Meta allows 300 calls an hour on the starter tier).
  try {
    const want = idsToRead(ops);
    // What a retried plan's finished steps made stands in for them: read with the rest.
    for (const [i, ids] of opts.done ?? []) {
      const t = String(ops[i]?.type ?? "");
      if (t.includes("campaign")) want.campaign.push(...ids);
      else if (t.includes("adset")) { want.adset.push(...ids); want.adsetCampaigns.push(...ids); }
    }
    await world.preload("ad", want.ad);
    const adSetsOfAds = want.adsTurnedOn.map((id) => world.ads.get(id)?.adsetId ?? "").filter(Boolean);
    await world.preload("adset", [...want.adset, ...adSetsOfAds]);
    // Campaigns only of the ad sets whose campaign matters (budgets changed, turned on, copied): not of
    // ad sets that only get paused ads or are turned off.
    const campaignsOf = [...want.adsetCampaigns, ...adSetsOfAds].map((id) => world.adsets.get(id)?.campaignId ?? "").filter(Boolean);
    await world.preload("campaign", [...want.campaign, ...campaignsOf]);
  } catch (e) {
    if (mustSurface(e)) throw e;
    // The steps read what they need one by one, and say what failed.
  }
  /** Campaigns of this ad account, read once, for Meta's early check of ad sets in a new campaign. */
  let checkCampaigns: Promise<SimilarRow[]> | undefined;

  async function validate(kind: string, path: string, params: Record<string, unknown>, n: number) {
    if (!opts.validate || validated.has(kind) || validated.size >= 8) return;
    validated.add(kind);
    try {
      await client.post(path, { ...params, execution_options: ["validate_only"] });
    } catch (e) {
      if (e instanceof RateLimitedError) err(n, `Meta's own check couldn't run. ${e.message}`);
      else if (e instanceof MetaError && !e.isTransient) err(n, `Meta's own check refused it. ${plainError(e, "Checking")}`);
    }
  }

  function budgetCheck(n: number, what: string, daily: number | null | undefined) {
    if (daily && daily > budgetWarnDaily()) warn(n, `${what} has a daily budget of ${m(daily)}, above the usual limit of ${m(budgetWarnDaily())}. Make sure this is right. ${ceilingWords(m)}`);
  }
  function touchAdset(a: WAdSet, n: number) {
    a.touched = true;
    if (!a.steps.includes(n)) a.steps.push(n);
  }
  function touchCampaign(c: WCampaign, n: number) {
    c.touched = true;
    c.involved = true;
    if (!c.steps.includes(n)) c.steps.push(n);
  }
  function turnOn(what: string, n: number) {
    canSpend = true;
    lastTurnOn = n;
    turnsOn.push(what);
  }
  /** Ad sets named by ID, name or ref, read together (one read for each 100) rather than one by one. */
  async function adsetTargets(list: string[] | undefined): Promise<string[]> {
    const ids: string[] = [];
    for (const s of list ?? []) ids.push(...(await world.resolve("adset", s)));
    await world.preload("adset", ids).catch(surfaceOr([]));
    return ids;
  }
  /** New times let an object spend again or sooner: it had ended and now ends later, or it was to start
   *  later and now starts earlier. */
  function spendsAgain(before: { start?: string | null; end?: string | null }, after: { start?: string | null; end?: string | null }): boolean {
    const e0 = timeMs(before.end);
    const e1 = timeMs(after.end);
    if (!Number.isNaN(e0) && e0 <= asOf && (Number.isNaN(e1) || e1 > asOf)) return true;
    const s0 = timeMs(before.start);
    const s1 = timeMs(after.start);
    return !Number.isNaN(s0) && s0 > asOf && (Number.isNaN(s1) || s1 < s0);
  }
  /** An object that has ended (its end is before the plan runs) spends nothing. */
  const ended = (end: string | null | undefined) => {
    const e = timeMs(end);
    return !Number.isNaN(e) && e <= asOf;
  };
  /** What a lifetime budget (with no daily budget) counts as a day from when the plan runs (0 for a daily budget). */
  function lifetimePace(daily: number | null, lifetime: number | null, start: string | null | undefined, end: string | null | undefined): number {
    return !daily && lifetime ? dailyEquivalent(null, lifetime, end, start, asOf) : 0;
  }
  /** An ad set (and its campaign) whose ads are turned on: its budget counts in what can spend.
   *  Read together with the others when the check starts (one read per kind), not one by one. */
  async function involve(adsetId: string) {
    const a = world.adsets.get(adsetId) ?? (await world.adset(adsetId));
    const c = world.campaigns.get(a.campaignId) ?? (await world.campaign(a.campaignId));
    c.involved = true;
  }
  async function one(kind: "campaign" | "adset" | "ad" | "audience", s: string, what: string): Promise<string> {
    return oneOf(await world.resolve(kind, s), s, kind, what);
  }
  /** What an existing ad's creative allows (read once per ad). */
  async function look(adId: string): Promise<AdLook | null> {
    if (!looks.has(adId)) {
      const ad = await readAd(client, adId).catch(notFound);
      looks.set(adId, ad ? { name: ad.name, fromPost: ad.fromPost, textOptions: !!ad.creative.asset_feed_spec } : null);
    }
    return looks.get(adId)!;
  }
  /** Budget periods: Meta's rules, and the plain words (+20% (+₹200 on ₹1,000 a day)). Each raise is
   *  added to the campaign's `raises`, so what can spend counts the highest one. A period Meta already
   *  took (a stopped step being retried: `sp`) is in Meta as it was sent: its times are not checked again
   *  (it may have started), and it counts at the amount Meta took (a percent of the daily budget then). */
  function schedules(n: number, list: CampaignSpec["budget_schedules"], c: { cbo: boolean; daily: number | null; raises?: Raise[]; planRaise?: boolean }, sp?: PlanProgress): string {
    if (!Array.isArray(list) || !list.length) return "";
    if (!c.cbo) err(n, "budget scheduling works only with a campaign budget.");
    else if (!c.daily) err(n, "budget scheduling works only with a daily campaign budget (Meta's rule), not a lifetime budget.");
    if (list.length > 50) err(n, `at most 50 budget periods per campaign (Meta's limit); this step has ${list.length}.`);
    const spans: [number, number][] = [];
    const parts: string[] = [];
    list.forEach((b, k) => {
      const tag = `budget period ${k + 1}`;
      const s = timeMs(b?.start);
      const e = timeMs(b?.end);
      if (Number.isNaN(s) || Number.isNaN(e)) {
        err(n, `${tag}: start and end must be times like 2026-11-20T09:00:00+05:30.`);
        return;
      }
      const mk = periodMark(b);
      const taken = !!sp && (isFinished(sp, mk) || (!sp.changed?.length && isFinished(sp, `schedule:${k}`)));
      const maybeSent = taken || !!sp?.attempted?.includes(mk);
      const takenAmount = taken ? sp?.periods?.[mk]?.amount : undefined;
      if (e <= s) err(n, `${tag} ends before it starts.`);
      else if (e - s < 3 * 3_600_000) err(n, `${tag} is shorter than 3 hours (Meta's minimum for a budget period).`);
      if (taken) {
        // Already in Meta: nothing to check about its times.
      } else if (s <= Date.now()) err(n, `${tag} starts in the past (${istLabel(b.start)}).`);
      // A period must start a little after the plan runs (PERIOD_MARGIN_MS), so a run that starts a few
      // minutes late still sends it before it starts. The check when the run starts only asks "not in the
      // past": the margin was checked against the confirmed run time.
      else if (!opts.atRun && s < asOf + PERIOD_MARGIN_MS) {
        err(n, input.run_at
          ? `${tag} starts at ${istLabel(b.start)}, less than ${PERIOD_MARGIN_MS / 60_000} minutes after the plan runs (${istLabel(input.run_at)}). Make it start at least ${PERIOD_MARGIN_MS / 60_000} minutes after the run time, or run the plan earlier.`
          : `${tag} starts at ${istLabel(b.start)}, less than ${PERIOD_MARGIN_MS / 60_000} minutes from now. Make it start at least ${PERIOD_MARGIN_MS / 60_000} minutes after the plan runs.`);
      }
      if (spans.some(([ps, pe]) => s < pe && ps < e)) err(n, `${tag} overlaps another budget period.`);
      spans.push([s, e]);
      if ((b.increase_percent === undefined) === (b.increase_amount === undefined)) {
        err(n, `${tag}: give increase_percent or increase_amount (one of them).`);
        return;
      }
      const v = b.increase_percent ?? b.increase_amount;
      if (!(typeof v === "number" && v > 0)) {
        err(n, `${tag}: the increase must be a number above 0.`);
        return;
      }
      const inc = takenAmount ?? scheduleIncrease(b, c.daily);
      if (c.daily && inc !== null && c.daily + inc > 8 * c.daily) err(n, `${tag}: Meta allows at most 8 times the daily budget during a period (${m(8 * c.daily)} here), and this makes it ${m(c.daily + inc)}.`);
      if (inc !== null && inc > 0) {
        c.raises?.push({ s, e, amount: inc, inMeta: maybeSent });
        c.planRaise = true;
      }
      if (takenAmount !== undefined) parts.push(`${istLabel(b.start)} to ${istLabel(b.end)} +${m(takenAmount)} (already added in Meta${b.increase_percent !== undefined ? `: +${b.increase_percent}% of the daily budget it had then` : ""})`);
      else parts.push(`${istLabel(b.start)} to ${istLabel(b.end)} ${b.increase_percent !== undefined ? `+${b.increase_percent}%${inc !== null ? ` (+${m(inc)} on ${m(c.daily)} a day)` : ""}` : `+${m(inc)}${c.daily ? ` (on ${m(c.daily)} a day)` : ""}`}${taken ? " (already added in Meta)" : ""}`);
    });
    return parts.length ? `Budget raised at set times: ${parts.join("; ")}.` : "";
  }
  /** Fields the step doesn't take are refused (never ignored). */
  function unknownFields(op: Op, n: number) {
    const allowed = OP_KEYS[op.type];
    const o = op as unknown as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (o[k] === undefined || allowed.has(k)) continue;
      const hint = STEP_SAY_INSTEAD[op.type]?.[k] ?? SAY_INSTEAD[k];
      err(n, `unknown field "${k}"${hint ? `; did you mean ${hint}?` : "."} A field the launcher doesn't know is not guessed: fix its name (plan_step_fields with type "${op.type}" lists the fields this step takes).`);
    }
    const changes = o.changes;
    if (changes === undefined) return;
    if (!Array.isArray(changes)) {
      err(n, "changes must be a list: one object per copy.");
      return;
    }
    const ok = CHANGE_KEYS[op.type];
    changes.forEach((ch, j) => {
      if (!ch || typeof ch !== "object" || Array.isArray(ch)) {
        err(n, `copy ${j + 1}: each entry in changes must be an object (e.g. {"daily_budget": 500}).`);
        return;
      }
      for (const k of Object.keys(ch)) {
        if ((ch as Record<string, unknown>)[k] === undefined || ok?.has(k)) continue;
        err(n, `copy ${j + 1}: unknown field "${k}"${SAY_INSTEAD[k] ? `; did you mean ${SAY_INSTEAD[k]}?` : "."} (plan_step_fields with type "${op.type}" lists the fields this step takes; a copy's changes take the fields of ${op.type === "duplicate_campaign" ? "edit_campaign" : "edit_adset"}).`);
      }
    });
  }
  /** Budgets and bids must be numbers above 0. */
  function positiveMoney(op: Op, n: number) {
    const check = (o: Record<string, unknown>, where: string) => {
      for (const k of MONEY_FIELDS) {
        const v = o[k];
        if (v === undefined || v === null) continue;
        if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) err(n, `${where}${k} must be a number above 0 (got ${JSON.stringify(v)}). To stop spending, turn it off with set_status instead.`);
      }
    };
    check(op as unknown as Record<string, unknown>, "");
    const changes = (op as { changes?: unknown }).changes;
    if (Array.isArray(changes)) changes.forEach((ch, j) => ch && typeof ch === "object" && check(ch as Record<string, unknown>, `copy ${j + 1}: `));
  }

  /** A virtual copy of ad set `src` in campaign `target`, after `ch` is applied. */
  function virtualAdset(id: string, name: string, src: Partial<AdSetRow>, target: WCampaign, ch: AdSetSpec, n: number): WAdSet {
    // A copy keeps its own bid strategy (Meta copies it); the campaign's default only fills a gap (plan pxrjw).
    const params = adsetParams(effectiveAdsetSpec(ch, target.cbo, src.bid_strategy ?? target.bidDefault), cur, { current: src as AdSetRow, forCreate: false });
    const row: Partial<AdSetRow> = { ...src, ...(params as Partial<AdSetRow>), name, campaign_id: target.id };
    if (target.cbo) { delete row.daily_budget; delete row.lifetime_budget; }
    const w: WAdSet = { id, name, status: ch.status ?? "PAUSED", campaignId: target.id, daily: target.cbo ? null : fromMinor(row.daily_budget, cur), lifetime: target.cbo ? null : fromMinor(row.lifetime_budget, cur), virtual: true, touched: true, isNew: true, steps: [n], row, ads: [] };
    world.adsets.set(id, w);
    return w;
  }
  /**
   * Minimum daily spends in a campaign-budget campaign: Meta refuses an ad set whose minimum makes the
   * minimums of the campaign's ad sets (paused ones too) add up to more than its daily budget (100/1885648).
   * Checked for every such campaign where this plan makes or changes an ad set with a minimum; a warning
   * that names the numbers and what the run does then.
   */
  async function minSpendChecks() {
    const minOf = (a: WAdSet) => fromMinor(a.row.daily_min_spend_target, cur) || 0;
    for (const c of [...world.campaigns.values()]) {
      if (!c.cbo || !c.daily) continue;
      const set = [...world.adsets.values()].filter((a) => a.campaignId === c.id && a.touched && minOf(a) > 0);
      if (!set.length) continue;
      let all: WAdSet[];
      try {
        all = await world.adsetsOf(c.id);
      } catch (e) {
        if (mustSurface(e)) throw e;
        continue;
      }
      const withMin = all.filter((a) => minOf(a) > 0);
      const sum = withMin.reduce((t, a) => t + minOf(a), 0);
      if (sum <= c.daily + 0.5) continue;
      const stepNs = [...new Set(set.flatMap((a) => a.steps))].sort((x, y) => x - y);
      const copies = stepNs.some((k) => ops[k - 1]?.type === "duplicate_adset");
      const others = stepNs.some((k) => ops[k - 1]?.type !== "duplicate_adset");
      const list = withMin.slice(0, 6).map((a) => `"${a.name}" ${m(minOf(a))}`).join(", ") + (withMin.length > 6 ? `, and ${withMin.length - 6} more` : "");
      const then = [
        copies ? "A copy whose minimum Meta refuses is still made, without that minimum: a copy Meta refuses as it is is built from the original's settings without its spend limits, and a minimum asked for a copy that Meta refuses is left out (the copy keeps the one it has). The step's message says what each copy has" : "",
        others ? "A new or changed ad set whose minimum Meta refuses stops its step: lower min_daily_spend or raise the campaign budget, then press Retry" : "",
      ].filter(Boolean).join(". ");
      warn(stepNs[stepNs.length - 1], `the ad sets in campaign "${c.name}" would have minimum daily spends adding up to ${m(sum)} (${list}), more than its ${m(c.daily)} daily budget. Meta refuses minimums that add up to more than the campaign budget. ${then}.`);
    }
  }
  const extrasText = (row: Partial<AdSetRow>) => {
    const x = Object.values(adsetExtras(row));
    return x.length ? ` Also: ${x.join("; ")}.` : "";
  };
  // One changed field in words: money in rupees, times in IST, lists joined; a setting given as a group
  // of values (targeting, a frequency cap…) is named as changed, never shown as raw data.
  const plainChange = (k: string, v: unknown) => {
    const words = k.replace(/_/g, " ");
    if (k === "daily_budget") return `daily budget ${m(Number(v))}`;
    if (k === "lifetime_budget") return `lifetime budget ${m(Number(v))}`;
    if (k === "min_daily_spend") return `minimum ${m(Number(v))} a day`;
    if (k === "max_daily_spend") return `maximum ${m(Number(v))} a day`;
    if (k === "bid_amount") return `bid ${m(Number(v))}`;
    if (k === "status") return `turned ${v === "ACTIVE" ? "ON" : "off"}`;
    if (/_time$/.test(k)) return `${words} ${istLabel(String(v))}`;
    if (Array.isArray(v)) return v.every((x) => x === null || typeof x !== "object") ? `${words} → ${v.length ? v.join(", ") : "none"}` : `${words} changed`;
    if (v && typeof v === "object") return `${words} changed`;
    return `${words} → ${String(v)}`;
  };

  let n = 0;
  for (const op of ops) {
    n++;
    const lines: string[] = [];
    let title = "";
    const ref = refKey((op as { ref?: string })?.ref, n);
    const doneIds = opts.done?.get(n - 1);
    const sp = openProgress(n - 1);
    world.step = n;
    try {
      if (!op || typeof op !== "object" || !STEP_TYPES.includes(op.type)) {
        err(n, `unknown step type "${(op as { type?: string })?.type}". Use ${STEP_TYPES.join(", ")}. Deleting is not possible in the launcher.`);
        steps.push({ n, title: String((op as { type?: string })?.type), lines });
        continue;
      }
      if (doneIds) {
        // Finished in an earlier run: the real objects stand in for the plan's.
        title = `Already done: ${stepWords(op)}`;
        const kind = op.type.includes("campaign") ? "campaign" : op.type.includes("adset") ? "adset" : op.type.includes("audience") || op.type.includes("lookalike") ? "audience" : "ad";
        world.refs.set(ref, { kind, ids: doneIds });
        for (const id of doneIds) {
          if (kind === "campaign") touchCampaign(await world.campaign(id), n);
          if (kind === "adset") touchAdset(await world.adset(id), n);
        }
        // Budget periods the step added are in Meta: they raise what the campaign can spend.
        for (const x of Object.values(opts.progress?.[n - 1]?.periods ?? {})) {
          const c = world.campaigns.get(x.campaign) ?? (await world.campaign(x.campaign));
          c.raises.push({ s: x.s, e: x.e, amount: x.amount, inMeta: true });
          c.planRaise = true;
        }
        lines.push(`Finished when the plan last ran (${doneIds.length} item${doneIds.length === 1 ? "" : "s"}). Not done again.`);
        steps.push({ n, title, lines });
        continue;
      }
      const lists = notLists(op as unknown as Record<string, unknown>);
      if (lists.length) {
        // Not read item by item (a text would be read letter by letter, "a, s, 1 are not ad sets").
        for (const l of lists) err(n, l);
        steps.push({ n, title: stepWords(op), lines });
        continue;
      }
      unknownFields(op, n);
      positiveMoney(op, n);
      switch (op.type) {
        case "create_campaign": {
          const spec = effectiveCampaignSpec(op);
          const name = op.name || nameFor(op.name_template, "", { n, persona: op.persona, angle: op.angle, objective: op.objective, budget: op.daily_budget ?? op.lifetime_budget, date });
          title = `Create campaign "${name || "(no name)"}"`;
          if (!name) err(n, "the campaign needs a name or a name template.");
          if (!op.objective || !OBJECTIVES.some((o) => o.value === op.objective)) err(n, `objective must be one of ${OBJECTIVES.map((o) => o.value).join(", ")}.`);
          const cbo = op.budget_level === "campaign" || op.daily_budget !== undefined || op.lifetime_budget !== undefined;
          if (op.budget_level === "campaign" && op.daily_budget === undefined && op.lifetime_budget === undefined) err(n, "a campaign budget (CBO) needs daily_budget or lifetime_budget.");
          if (op.budget_level === "adset" && (op.daily_budget !== undefined || op.lifetime_budget !== undefined)) err(n, 'budget_level "adset" means the budget goes on each ad set: leave daily_budget and lifetime_budget out here.');
          if (op.daily_budget !== undefined && op.lifetime_budget !== undefined) err(n, "give daily_budget or lifetime_budget, not both.");
          if (op.lifetime_budget !== undefined && !op.stop_time) err(n, "a lifetime budget needs stop_time.");
          if (op.bid_strategy && !BID_STRATEGIES.some((b) => b.value === op.bid_strategy)) err(n, `unknown bid strategy ${op.bid_strategy}.`);
          if (op.special_ad_category_country?.length && !op.special_ad_categories?.some((x) => x !== "NONE")) err(n, "special_ad_category_country needs a special ad category.");
          const id = `$${ref}`;
          const c: WCampaign = { id, name, status: op.status ?? "PAUSED", cbo, daily: op.daily_budget ?? null, lifetime: op.lifetime_budget ?? null, start: op.start_time ?? null, end: op.stop_time ?? null, spendCap: op.spend_cap ?? null, objective: op.objective, bidDefault: cbo ? undefined : op.bid_strategy, special: (op.special_ad_categories ?? []).filter((x) => x && x !== "NONE"), virtual: true, touched: true, involved: true, steps: [n], raises: [] };
          world.campaigns.set(id, c);
          world.refs.set(ref, { kind: "campaign", ids: [id] });
          const d = describeCampaign({ objective: op.objective, bid_strategy: spec.bid_strategy, special_ad_categories: op.special_ad_categories?.filter((x) => x !== "NONE") }, cur);
          lines.push(`Objective: ${d.objective}. Budget: ${cbo ? (op.daily_budget ? `${m(op.daily_budget)} a day (campaign budget)` : `${m(op.lifetime_budget)} lifetime (campaign budget)`) : "on each ad set"}. Bid: ${cbo ? d.bid : "set on each ad set"}. Special ad category: ${d.specialCategories}${op.special_ad_category_country?.length ? ` (${op.special_ad_category_country.join(", ")})` : ""}. Spend limit: ${op.spend_cap ? m(op.spend_cap) : "none"}.`);
          if (!cbo && op.bid_strategy) lines.push(`With budgets on the ad sets, Meta keeps the bid strategy on each ad set: ${op.bid_strategy.replace(/_/g, " ").toLowerCase()} is used for the ad sets this plan makes in this campaign without a bid strategy of their own.`);
          const sched = schedules(n, op.budget_schedules, c, sp);
          if (sched) lines.push(sched);
          lines.push(`Created ${c.status === "ACTIVE" ? "ON" : "paused"}.`);
          if (cbo) budgetCheck(n, `Campaign "${name}"`, op.daily_budget);
          if (c.status === "ACTIVE") turnOn(`campaign "${name}"`, n);
          await validate("campaign", `${client.accountId}/campaigns`, { ...campaignParams({ ...spec, name: name || "validate" }, cur, true), status: "PAUSED" }, n);
          break;
        }
        case "edit_campaign": {
          const cid = await one("campaign", op.campaign, "edit_campaign");
          const c = await world.campaign(cid);
          title = `Edit campaign "${c.name}"`;
          touchCampaign(c, n);
          const changes: string[] = [];
          const onlyLifetime = !!c.lifetime && !c.daily;
          const paceBefore = lifetimePace(c.daily, c.lifetime, c.start, c.end);
          const timesBefore = { start: c.start, end: c.end };
          const onlyDaily = !!c.daily && !c.lifetime;
          if (op.name) { changes.push(`name → "${op.name}"`); c.name = op.name; }
          if (op.daily_budget !== undefined) {
            if (!c.cbo) err(n, `"${c.name}" has no campaign budget (budgets are on its ad sets). Edit the ad sets instead.`);
            else if (onlyLifetime) err(n, `"${c.name}" has a lifetime budget, and Meta can't switch an existing campaign between daily and lifetime budget. Change its lifetime_budget, or copy it with a daily budget.`);
            changes.push(`daily budget ${m(c.daily)} → ${m(op.daily_budget)}`);
            if (c.status === "ACTIVE" && op.daily_budget > (c.daily ?? 0)) canSpend = true;
            budgetCheck(n, `Campaign "${c.name}"`, op.daily_budget);
            c.daily = op.daily_budget;
          }
          if (op.lifetime_budget !== undefined) {
            if (!c.cbo) err(n, `"${c.name}" has no campaign budget.`);
            else if (onlyDaily) err(n, `"${c.name}" has a daily budget, and Meta can't switch an existing campaign between daily and lifetime budget. Change its daily_budget, or make a new campaign with a lifetime budget.`);
            if (!(op.stop_time ?? c.end)) err(n, "a lifetime budget needs stop_time.");
            changes.push(`lifetime budget ${m(c.lifetime)} → ${m(op.lifetime_budget)}`);
            if (c.status === "ACTIVE" && op.lifetime_budget > (c.lifetime ?? 0)) canSpend = true;
            c.lifetime = op.lifetime_budget;
          }
          if (op.bid_strategy) {
            if (!c.cbo) err(n, `"${c.name}" has its budget on the ad sets, so Meta keeps the bid strategy on each ad set. Change it with edit_adset on its ad sets.`);
            changes.push(`bid strategy → ${op.bid_strategy}`);
          }
          // A higher spend limit lets an ON campaign that reached its limit spend again.
          const capRaised = op.spend_cap !== undefined && !!c.spendCap && op.spend_cap > c.spendCap;
          if (op.spend_cap !== undefined) { changes.push(`spend limit → ${m(op.spend_cap)}`); c.spendCap = op.spend_cap; }
          if (op.start_time) { changes.push(`start → ${istLabel(op.start_time)}`); c.start = op.start_time; }
          if (op.stop_time) { changes.push(`end → ${istLabel(op.stop_time)}`); c.end = op.stop_time; }
          if (op.budget_schedules?.length) changes.push(schedules(n, op.budget_schedules, c, sp));
          if (op.status) {
            changes.push(`status → ${op.status}`);
            if (op.status === "ACTIVE" && c.status !== "ACTIVE") turnOn(`campaign "${c.name}"`, n);
            c.status = op.status;
          }
          // A budget period raises what an ON campaign can spend: the total to type counts it.
          if (op.budget_schedules?.length && c.status === "ACTIVE") canSpend = true;
          // A lifetime budget spread over fewer days (an earlier end, a later start) spends more each day.
          if (c.status === "ACTIVE" && lifetimePace(c.daily, c.lifetime, c.start, c.end) > paceBefore) canSpend = true;
          // An ON campaign that ended (or hasn't started) spends again (or sooner): a later end, an earlier start.
          if (c.status === "ACTIVE" && (capRaised || spendsAgain(timesBefore, { start: c.start, end: c.end }))) canSpend = true;
          if (!changes.length) err(n, "nothing to change.");
          lines.push(changes.join("; "));
          if (!c.virtual) await validate("edit_campaign", c.id, campaignParams(op, cur, false), n);
          break;
        }
        case "duplicate_campaign": {
          const cid = await one("campaign", op.campaign, "duplicate_campaign");
          const c = await world.campaign(cid);
          const count = copiesOf(op);
          if (!(count >= 1 && count <= MAX_COPIES)) { err(n, `copies must be between 1 and ${MAX_COPIES}.`); break; }
          title = `Copy campaign "${c.name}" ${count} time${count > 1 ? "s" : ""}${op.with_contents ? " with its ad sets and ads" : " (campaign only)"}`;
          const contents = op.with_contents ? await world.adsetsOf(c.id) : [];
          let adCount = 0;
          for (const a of contents) adCount += (await world.adsOf(a.id)).length;
          const ids: string[] = [];
          for (let j = 0; j < count; j++) {
            const ch = op.changes?.[j] ?? {};
            const name = ch.name ?? nameFor(op.name_template ?? ch.name_template, `${c.name} - copy ${j + 1}`, { n: j + 1, persona: op.persona ?? ch.persona, objective: c.objective, budget: ch.daily_budget ?? c.daily, date });
            const id = `$${ref}#${j + 1}`;
            ids.push(id);
            if (!c.cbo && (ch.daily_budget !== undefined || ch.lifetime_budget !== undefined)) err(n, `copy ${j + 1}: "${c.name}" has its budget on the ad sets, so a copy can't get a campaign budget.`);
            if (c.cbo && ch.daily_budget !== undefined && c.lifetime && !c.daily) err(n, `copy ${j + 1}: "${c.name}" has a lifetime budget, and Meta can't switch a copy to a daily budget. Give it a lifetime_budget instead.`);
            if (c.cbo && ch.lifetime_budget !== undefined && c.daily && !c.lifetime) err(n, `copy ${j + 1}: "${c.name}" has a daily budget, and Meta can't switch a copy to a lifetime budget. Give it a daily_budget instead.`);
            if (ch.lifetime_budget !== undefined && !(ch.stop_time ?? c.end)) err(n, `copy ${j + 1}: a lifetime budget needs stop_time.`);
            if (ch.budget_schedules?.length) err(n, `copy ${j + 1}: budget periods can't be set on a copy here; add an edit_campaign step for the copy ("$${ref}.${j + 1}").`);
            if (!c.cbo && ch.bid_strategy) err(n, `copy ${j + 1}: with budgets on ad sets the bid strategy is set on each ad set.`);
            const copy: WCampaign = { ...c, id, name, status: ch.status ?? "PAUSED", daily: c.cbo ? ch.daily_budget ?? (ch.lifetime_budget !== undefined ? null : c.daily) : null, lifetime: c.cbo ? ch.lifetime_budget ?? (ch.daily_budget !== undefined ? null : c.lifetime) : null, start: ch.start_time ?? c.start, end: ch.stop_time ?? c.end, virtual: true, touched: true, involved: true, steps: [n], raises: c.raises.map((r) => ({ ...r })), src: c.virtual ? c.src : c.id, orig: undefined };
            world.campaigns.set(id, copy);
            for (const a of contents) {
              const vid = `${id}/${a.id}`;
              const w = virtualAdset(vid, a.name, a.row, copy, {}, n);
              if (!copy.cbo) { w.daily = a.daily; w.lifetime = a.lifetime; }
              for (const ad of await world.adsOf(a.id)) {
                const adId = `${vid}/${ad.id}`;
                w.ads.push(adId);
                world.ads.set(adId, { id: adId, name: ad.name, status: "PAUSED", adsetId: vid, virtual: true, sourceAd: ad.sourceAd ?? ad.id, look: ad.look });
              }
            }
            const changed = Object.entries(ch).filter(([k, v]) => k !== "name" && v !== undefined).map(([k, v]) => plainChange(k, v));
            lines.push(`Copy ${j + 1}: "${name}"${changed.length ? `, ${changed.join(", ")}` : ", same settings"}${copy.status === "ACTIVE" ? ", turned ON" : ", paused"}.`);
            if (c.cbo) budgetCheck(n, `Copy "${name}"`, copy.daily);
            if (copy.status === "ACTIVE") turnOn(`campaign "${name}"`, n);
          }
          if (op.with_contents) {
            lines.push(`Each copy gets ${contents.length} ad set${contents.length === 1 ? "" : "s"} and ${adCount} ad${adCount === 1 ? "" : "s"} as they are at this step, all paused, copied one at a time (Meta copies at most 2 objects at once).`);
            adsN += adCount * count;
          }
          world.refs.set(ref, { kind: "campaign", ids });
          break;
        }
        case "create_adset": {
          const cid = await one("campaign", op.campaign, "create_adset");
          const c = await world.campaign(cid);
          const spec = effectiveAdsetSpec(op, c.cbo, c.bidDefault);
          const name = op.name || nameFor(op.name_template, "", { n, persona: op.persona, angle: op.angle, campaign: c.name, budget: op.daily_budget ?? op.lifetime_budget, date });
          title = `Create ad set "${name || "(no name)"}" in "${c.name}"`;
          if (!name) err(n, "the ad set needs a name or a name template.");
          adsetRules(n, spec, c, err);
          if (!op.goal) err(n, "say what to optimise for (goal), e.g. LEAD_GENERATION or OFFSITE_CONVERSIONS.");
          if (op.lifetime_budget !== undefined && !op.end_time) err(n, "a lifetime budget needs end_time.");
          if (op.goal === "OFFSITE_CONVERSIONS" && !op.pixel_id && !op.custom_conversion_id && !op.app_id) err(n, "conversions need pixel_id and event (or custom_conversion_id).");
          let saved: Targeting | undefined;
          if (op.saved_audience_id) saved = (await client.get<{ targeting?: Targeting }>(op.saved_audience_id, { fields: "targeting" })).targeting;
          for (const aud of [...(op.custom_audiences ?? []), ...(op.excluded_custom_audiences ?? [])]) {
            const idv = typeof aud === "string" ? aud : aud.id;
            if (isRef(idv)) await world.resolve("audience", idv).catch((e: Error) => err(n, `audience: ${e.message}`));
          }
          const params = adsetParams({ ...spec, name }, cur, { forCreate: true, savedAudience: saved });
          for (const p of specialTargetingProblems(params.targeting as Targeting, c.special)) err(n, p);
          // A stopped step whose answer from Meta was lost may have made this ad set: the run reuses the one
          // Meta made (found as the run finds it), so it is this step's ad set, not a second one.
          if (sp && !sp.ids[0] && sp.attempted?.includes(0) && !c.virtual) {
            const made = await findByName(client, `${c.id}/adsets`, sp.attemptedName?.["0"] ?? name, sp.attemptedAt?.["0"] ?? Number.POSITIVE_INFINITY).catch(surfaceOr(null));
            if (made) world.standIn(made);
          }
          const id = `$${ref}`;
          const w: WAdSet = { id, name, status: op.status ?? "PAUSED", campaignId: c.id, daily: c.cbo ? null : op.daily_budget ?? null, lifetime: c.cbo ? null : op.lifetime_budget ?? null, virtual: true, touched: true, isNew: true, steps: [n], row: { ...(params as Partial<AdSetRow>), campaign_id: c.id }, ads: [] };
          world.adsets.set(id, w);
          world.refs.set(ref, { kind: "adset", ids: [id] });
          c.involved = true;
          const d = describeAdSet(w.row, cur);
          lines.push(`${c.cbo ? "campaign budget" : d.budget}; ${d.bid}; ${d.schedule}. Goal: ${d.goal}. Audience: ${d.audience}. Placements: ${d.placements}.${op.saved_audience_id ? ` Saved audience ${op.saved_audience_id}.` : ""}${extrasText(w.row)} Created ${w.status === "ACTIVE" ? "ON" : "paused"}.`);
          if (op.targeting_expansion === false) warn(n, "Meta now always lets Advantage detailed targeting reach beyond the interests you pick (it can't be switched off any more).");
          if (!op.bid_strategy && !c.cbo) lines.push(`No bid strategy given: ${spec.bid_strategy === DEFAULT_BID ? "Highest volume (no cap)" : (spec.bid_strategy ?? "").replace(/_/g, " ").toLowerCase()} is used.`);
          budgetCheck(n, `Ad set "${name}"`, op.daily_budget);
          if (w.status === "ACTIVE") turnOn(`ad set "${name}"`, n);
          // Audiences this plan makes don't exist yet: Meta's check gets the ad set without them.
          const forCheck = withoutAudienceRefs({ ...spec, name });
          if (forCheck.stripped) lines.push("Meta checks the audiences made in this plan when it runs.");
          const checkParams = forCheck.stripped ? adsetParams(forCheck.spec, cur, { forCreate: true, savedAudience: saved }) : params;
          if (!c.virtual) await validate("adset", `${client.accountId}/adsets`, { ...checkParams, campaign_id: c.id, status: "PAUSED" }, n);
          else if (opts.validate) {
            // The campaign doesn't exist yet: ask Meta to check the ad set against an existing campaign
            // with the same objective, budget type and special ad category, so a bad setting is caught early.
            // Only when Meta's check runs (not at confirmation), and the campaigns are read once per check.
            checkCampaigns ??= campaignsForCheck(client);
            const proxy = similarCampaign(await checkCampaigns, c.objective, c.cbo, c.special);
            if (proxy) await validate(`adset_new_${c.id}`, `${client.accountId}/adsets`, { ...checkParams, campaign_id: proxy, status: "PAUSED" }, n);
            else lines.push("Meta checks this ad set when the plan runs, after the new campaign exists. If Meta refuses it then, the campaign stays paused and empty; fix this step and press Retry.");
          }
          break;
        }
        case "edit_adset": {
          const ids = await world.resolve("adset", op.adset);
          const names: string[] = [];
          const changes: string[] = [];
          let stripped = false;
          for (const aid of ids) {
            const a = await world.adset(aid);
            let c = world.campaigns.get(a.campaignId);
            if (!c) {
              try {
                c = await world.campaign(a.campaignId);
              } catch (e) {
                if (mustSurface(e)) throw e;
                // Whether its campaign is on (so a higher budget or a turn-on can spend) is not known: never
                // taken as "off", which would let the change run with no typed total and no ceiling check.
                const spendy = op.daily_budget !== undefined || op.lifetime_budget !== undefined || !!op.start_time || !!op.end_time || op.status === "ACTIVE" || !!op.schedule?.length;
                if (spendy) err(n, `couldn't read the campaign of "${a.name}", so whether this change lets money spend is not known (${e instanceof MetaError ? plainError(e, "Reading the campaign") : e instanceof Error ? e.message : String(e)}). Check the plan again in a few minutes.`);
              }
            }
            names.push(a.name);
            touchAdset(a, n);
            if (c) c.involved = true;
            const onlyLifetime = !!a.lifetime && !a.daily;
            const paceBefore = lifetimePace(a.daily, a.lifetime, a.row.start_time, a.row.end_time);
            const timesBefore = { start: a.row.start_time, end: a.row.end_time };
            const onlyDaily = !!a.daily && !a.lifetime;
            const ch: string[] = [];
            if (op.name) { ch.push(`name → "${op.name}"`); a.name = op.name; }
            if (op.daily_budget !== undefined) {
              if (c?.cbo) err(n, `"${a.name}" is in a campaign-budget campaign; change the campaign's budget instead.`);
              else if (onlyLifetime) err(n, `"${a.name}" has a lifetime budget, and Meta can't switch an existing ad set between daily and lifetime budget. Change its lifetime_budget, or copy it with a daily budget.`);
              ch.push(`daily budget ${m(a.daily)} → ${m(op.daily_budget)}`);
              budgetCheck(n, `Ad set "${a.name}"`, op.daily_budget);
              if (a.status === "ACTIVE" && c?.status === "ACTIVE" && op.daily_budget > (a.daily ?? 0)) canSpend = true;
              a.daily = op.daily_budget;
            }
            if (op.lifetime_budget !== undefined) {
              if (c?.cbo) err(n, `"${a.name}" is in a campaign-budget campaign; change the campaign's budget instead.`);
              else if (onlyDaily) err(n, `"${a.name}" has a daily budget, and Meta can't switch an existing ad set between daily and lifetime budget. Change its daily_budget, or copy it with a lifetime budget.`);
              if (!(op.end_time ?? a.row.end_time)) err(n, `a lifetime budget needs end_time ("${a.name}" has no end date).`);
              ch.push(`lifetime budget ${m(a.lifetime)} → ${m(op.lifetime_budget)}`);
              if (a.status === "ACTIVE" && c?.status === "ACTIVE" && op.lifetime_budget > (a.lifetime ?? 0)) canSpend = true;
              a.lifetime = op.lifetime_budget;
            }
            if (op.schedule?.length && !(op.lifetime_budget ?? a.lifetime)) err(n, "running only at set hours (schedule) needs a lifetime budget (Meta's rule).");
            if (op.bid_strategy || op.bid_amount !== undefined) ch.push(`bid → ${op.bid_strategy ?? a.row.bid_strategy ?? ""}${op.bid_amount !== undefined ? ` ${m(op.bid_amount)}` : ""}`);
            if (needsBid(op.bid_strategy) && op.bid_amount === undefined && !a.row.bid_amount) err(n, `${op.bid_strategy} needs bid_amount.`);
            if (op.start_time) ch.push(`start → ${istLabel(op.start_time)}`);
            if (op.end_time) ch.push(`end → ${istLabel(op.end_time)}`);
            if (op.goal || op.destination || op.event || op.pixel_id) ch.push(`goal → ${[op.destination, op.goal, op.event].filter(Boolean).join(" / ")}`);
            const params = adsetParams(op, cur, { current: a.row as AdSetRow, forCreate: false });
            if (touchesAudience(op) || op.replace_targeting) {
              const d = describeAdSet({ targeting: params.targeting as Targeting }, cur);
              ch.push(`audience → ${d.audience}; placements → ${d.placements}`);
              if (c) for (const p of specialTargetingProblems(params.targeting as Targeting, c.special)) err(n, p);
            }
            if (op.attribution) ch.push(`attribution → ${op.attribution}`);
            if (op.min_daily_spend !== undefined || op.max_daily_spend !== undefined) ch.push(`spend limits → ${[op.min_daily_spend !== undefined ? `minimum ${m(op.min_daily_spend)} a day` : "", op.max_daily_spend !== undefined ? `maximum ${m(op.max_daily_spend)} a day` : ""].filter(Boolean).join(", ")}`);
            if (op.schedule?.length) ch.push(`runs only at set hours (${op.schedule.length} time window${op.schedule.length > 1 ? "s" : ""})`);
            if (op.frequency_cap) ch.push(`frequency cap ${op.frequency_cap.impressions} per ${op.frequency_cap.days} day${op.frequency_cap.days > 1 ? "s" : ""}`);
            if (op.inventory_filter) ch.push(`brand safety → ${op.inventory_filter} inventory`);
            if (op.status) {
              ch.push(`status → ${op.status}`);
              if (op.status === "ACTIVE" && a.status !== "ACTIVE") turnOn(`ad set "${a.name}"`, n);
              a.status = op.status;
            }
            a.row = { ...a.row, ...(params as Partial<AdSetRow>) };
            // A lifetime budget spread over fewer days (an earlier end, a later start) spends more each day;
            // an ON ad set that ended (or hasn't started) spends again (or sooner) with a later end (an earlier start).
            if (a.status === "ACTIVE" && c?.status === "ACTIVE" && (lifetimePace(a.daily, a.lifetime, a.row.start_time, a.row.end_time) > paceBefore || spendsAgain(timesBefore, { start: a.row.start_time, end: a.row.end_time }))) canSpend = true;
            if (!changes.length) changes.push(...ch);
            const forCheck = withoutAudienceRefs(op);
            if (forCheck.stripped) stripped = true;
            if (!a.virtual) await validate("edit_adset", a.id, forCheck.stripped ? adsetParams(forCheck.spec, cur, { current: a.row as AdSetRow, forCreate: false }) : params, n);
          }
          title = ids.length > 1 ? `Edit ${ids.length} ad sets` : `Edit ad set "${names[0]}"`;
          if (!changes.length) err(n, "nothing to change.");
          lines.push(changes.join("; "));
          if (ids.length > 1) lines.push(`Ad sets: ${names.map((x) => `"${x}"`).join(", ")}.`);
          if (stripped) lines.push("Meta checks the audiences made in this plan when it runs.");
          break;
        }
        case "duplicate_adset": {
          const sid = await one("adset", op.adset, "duplicate_adset (the ad set to copy)");
          const src = await world.adset(sid);
          const tid = op.campaign ? await one("campaign", op.campaign, "duplicate_adset (the campaign to copy into)") : src.campaignId;
          const target = await world.campaign(tid);
          target.involved = true;
          const count = copiesOf(op);
          if (!(count >= 1 && count <= MAX_COPIES)) { err(n, `copies must be between 1 and ${MAX_COPIES}.`); break; }
          const srcAds = op.with_ads ? await world.adsOf(src.id) : [];
          title = `Copy ad set "${src.name}" ${count} time${count > 1 ? "s" : ""} into "${target.name}"${op.with_ads ? ` with its ${srcAds.length} ad${srcAds.length === 1 ? "" : "s"}` : ""}`;
          const srcOnlyLifetime = !!src.lifetime && !src.daily;
          const srcOnlyDaily = !!src.daily && !src.lifetime;
          const ids: string[] = [];
          for (let j = 0; j < count; j++) {
            const ch = op.changes?.[j] ?? {};
            const baseDaily = target.cbo ? null : ch.daily_budget ?? (ch.lifetime_budget !== undefined ? null : src.daily);
            const baseLife = target.cbo ? null : ch.lifetime_budget ?? (ch.daily_budget !== undefined ? null : src.lifetime);
            const name = ch.name ?? nameFor(ch.name_template ?? op.name_template, `${src.name} - copy ${j + 1}`, { n: j + 1, persona: ch.persona ?? op.persona, angle: ch.angle, campaign: target.name, budget: baseDaily ?? baseLife, adset: src.name, date });
            if (target.cbo && (ch.daily_budget !== undefined || ch.lifetime_budget !== undefined)) err(n, `copy ${j + 1}: "${target.name}" uses a campaign budget, so its ad sets can't have their own budget.`);
            if (!target.cbo && !baseDaily && !baseLife) err(n, `copy ${j + 1}: needs a daily or lifetime budget (the campaign has no campaign budget).`);
            if (!target.cbo && ch.daily_budget !== undefined && srcOnlyLifetime) err(n, `copy ${j + 1}: the original "${src.name}" has a lifetime budget, and Meta can't switch a copy to a daily budget. Give the copy a lifetime_budget (with end_time) instead.`);
            if (!target.cbo && ch.lifetime_budget !== undefined && srcOnlyDaily) err(n, `copy ${j + 1}: the original "${src.name}" has a daily budget, and Meta can't switch a copy to a lifetime budget. Give the copy a daily_budget instead.`);
            if (baseLife && !(ch.end_time ?? src.row.end_time)) err(n, `copy ${j + 1}: a lifetime budget needs end_time.`);
            if (ch.schedule?.length && !baseLife) err(n, `copy ${j + 1}: running only at set hours (schedule) needs a lifetime budget (Meta's rule).`);
            if (needsBid(ch.bid_strategy) && ch.bid_amount === undefined) err(n, `copy ${j + 1}: ${ch.bid_strategy} needs bid_amount.`);
            const id = `$${ref}#${j + 1}`;
            ids.push(id);
            const w = virtualAdset(id, name, src.row, target, ch, n);
            w.daily = baseDaily;
            w.lifetime = baseLife;
            for (const p of specialTargetingProblems(w.row.targeting as Targeting, target.special)) err(n, `copy ${j + 1}: ${p}`);
            for (const ad of srcAds) {
              const adId = `${id}/${ad.id}`;
              w.ads.push(adId);
              world.ads.set(adId, { id: adId, name: ad.name, status: "PAUSED", adsetId: id, virtual: true, sourceAd: ad.sourceAd ?? ad.id, look: ad.look });
            }
            adsN += srcAds.length;
            // What the copy changes, in words with the amounts ("minimum ₹250 a day"), not field names.
            const changed = Object.entries(ch)
              .filter(([k, v]) => k !== "name" && k !== "name_template" && v !== undefined)
              .map(([k, v]) => plainChange(k, v));
            const d = describeAdSet(w.row, cur);
            lines.push(`Copy ${j + 1}: "${name}": ${target.cbo ? "campaign budget" : baseDaily ? `${m(baseDaily)} a day` : `${m(baseLife)} lifetime`}; ${d.bid}${changed.length ? ` (changed: ${changed.join(", ")})` : " (same settings)"}${w.status === "ACTIVE" ? ", turned ON" : ", paused"}.`);
            budgetCheck(n, `Copy "${name}"`, baseDaily);
            if (w.status === "ACTIVE") turnOn(`ad set "${name}"`, n);
          }
          const d0 = describeAdSet(src.row, cur);
          lines.push(`From the original: goal ${d0.goal}; audience ${d0.audience}; placements ${d0.placements}; ${d0.schedule}.${extrasText(src.row)}`);
          if (op.with_ads && srcAds.length) lines.push("Each ad set and each ad is copied one at a time (Meta copies at most 2 objects at once).");
          const srcMin = fromMinor(src.row.daily_min_spend_target, cur) || 0;
          const srcMax = fromMinor(src.row.daily_spend_cap, cur) || 0;
          if (srcMin || srcMax) lines.push(`The original has spend limits (${[srcMin ? `minimum ${m(srcMin)} a day` : "", srcMax ? `maximum ${m(srcMax)} a day` : ""].filter(Boolean).join(", ")}); Meta copies them. If Meta refuses a copy with them (in a campaign-budget campaign, the minimums of its ad sets may not add up to more than its budget), that copy is built from the original's settings without its spend limits. The step's message says what each copy has.`);
          world.refs.set(ref, { kind: "adset", ids });
          break;
        }
        case "ads_from_post": {
          const targets: WAdSet[] = [];
          for (const id of await adsetTargets(op.adsets)) targets.push(await world.adset(id));
          title = `Ads from existing post ${op.post_id} in ${targets.length} ad set${targets.length === 1 ? "" : "s"}`;
          if (!op.post_id) err(n, "give post_id (lookup posts lists them).");
          if (op.source === "instagram" && !op.instagram_user_id) err(n, "an Instagram post needs instagram_user_id (the Instagram account it belongs to).");
          if (!targets.length) err(n, "give at least one ad set.");
          // Ask Meta (validate_only) whether it takes this post, so a wrong ID fails here and not in the run.
          if (opts.validate && op.post_id && (op.source !== "instagram" || op.instagram_user_id) && postChecks++ < 10) {
            try {
              await client.post(`${client.accountId}/adcreatives`, { ...postCreative(op), execution_options: ["validate_only"] });
            } catch (e) {
              if (e instanceof RateLimitedError) err(n, `Meta's own check of this post couldn't run. ${e.message}`);
              else if (e instanceof MetaError && !e.isTransient) {
                err(n, e.subcode === 1815897
                  ? `Meta doesn't take ${op.post_id} as an Instagram post: it was made for an ad, and Meta only reuses organic Instagram posts this way. Reuse it with its Facebook post ID instead (post_id from lookup posts, without source "instagram"); the ads still run on Instagram.`
                  : `Meta's own check refused this post. ${plainError(e, "Checking")}`);
              }
            }
          }
          const ids: string[] = [];
          for (const [j, a] of targets.entries()) {
            const id = `$${ref}#${j + 1}`;
            ids.push(id);
            a.ads.push(id);
            world.ads.set(id, { id, name: "", status: op.status ?? "PAUSED", adsetId: a.id, virtual: true, look: { name: `post ${op.post_id}`, fromPost: true, textOptions: false } });
            if (op.status === "ACTIVE") {
              lit.add(a.id);
              await involve(a.id);
            }
          }
          world.refs.set(ref, { kind: "ad", ids });
          adsN += targets.length;
          lines.push(`One creative from ${op.source === "instagram" ? "Instagram post" : "Facebook post"} ${op.post_id}, so likes, comments and shares add up on that one post. Ad sets: ${targets.map((a) => `"${a.name}"`).join(", ")}. Ads created ${op.status === "ACTIVE" ? "ON" : "paused"}.`);
          if (op.status === "ACTIVE") turnOn(`${targets.length} ad${targets.length > 1 ? "s" : ""} from post ${op.post_id}`, n);
          break;
        }
        case "copy_ad": {
          const adId = await one("ad", op.ad, "copy_ad");
          let srcLook: AdLook | undefined;
          let sourceAd: string | undefined;
          let srcName = op.ad;
          if (isRef(op.ad)) {
            const v = world.ads.get(adId);
            srcLook = v?.look;
            sourceAd = v?.sourceAd;
            srcName = v?.name || op.ad;
          } else {
            const l = await look(adId);
            if (!l) { err(n, `ad ${op.ad} not found.`); break; }
            srcLook = l;
            sourceAd = adId;
            srcName = l.name;
          }
          const targets: WAdSet[] = [];
          for (const id of await adsetTargets(op.adsets)) targets.push(await world.adset(id));
          title = `Copy ad "${srcName}" into ${targets.length} ad set${targets.length === 1 ? "" : "s"}`;
          if (!targets.length) err(n, "give at least one ad set to copy the ad into.");
          const ids: string[] = [];
          for (const [j, a] of targets.entries()) {
            const id = `$${ref}#${j + 1}`;
            ids.push(id);
            a.ads.push(id);
            world.ads.set(id, { id, name: op.name ?? srcName, status: op.status ?? "PAUSED", adsetId: a.id, virtual: true, sourceAd, look: srcLook });
            if (op.status === "ACTIVE") {
              lit.add(a.id);
              await involve(a.id);
            }
          }
          world.refs.set(ref, { kind: "ad", ids });
          adsN += targets.length;
          lines.push(`Same creative, so the same post: likes, comments and shares add up on it. Into: ${targets.map((a) => `"${a.name}"`).join(", ")}. Created ${op.status === "ACTIVE" ? "ON" : "paused"}. If Meta refuses the original's creative in one of these ad sets, the copy there is made with a new creative (a new post, its likes and comments start from zero), and the step's message says which.`);
          if (op.status === "ACTIVE") turnOn(`${targets.length} copied ad${targets.length > 1 ? "s" : ""}`, n);
          break;
        }
        case "edit_ad": {
          const ids = await world.resolve("ad", op.ad);
          const changes = describeAdEdit(op);
          if (!changes.length) err(n, "nothing to change.");
          for (const pr of adEditProblems(op)) err(n, pr);
          // Putting an earlier creative back (an undo) is not a text change: no new creative is made.
          const textChange = changes.some((c) => !c.startsWith("name") && !c.startsWith("status") && !c.startsWith("creative →"));
          const many = (op.primary_texts?.length ?? 0) > 1 || (op.headlines?.length ?? 0) > 1;
          const missing = await world.preload("ad", ids.filter((id) => !isRef(id)));
          for (const id of missing) err(n, `ad ${id} is not an ad in this ad account (or it was deleted or archived).`);
          const names: string[] = [];
          for (const id of ids) {
            const w = world.ads.get(id);
            if (!w) continue;
            let l = w.look;
            if (!l && (textChange || many)) {
              const src = w.virtual ? w.sourceAd : id;
              l = (src ? await look(src) : null) ?? undefined;
              w.look = l;
            }
            const label = w.name || l?.name || id;
            names.push(label);
            if (l?.fromPost && textChange) err(n, `"${label}" runs an existing post, so its text, link and file can't change (that would make a new post and lose its likes and comments). Change the post itself, or make a new ad.`);
            else if (l && many) {
              const pr = textOptionsProblem(label, l.textOptions, op);
              if (pr) err(n, pr);
            }
            if (op.status === "ACTIVE" && w.status !== "ACTIVE") {
              turnOn(`ad "${label}"`, n);
              lit.add(w.adsetId);
              await involve(w.adsetId);
            }
            if (op.status) w.status = op.status;
            if (op.name) w.name = op.name;
          }
          title = ids.length > 1 ? `Edit ${ids.length} ads` : `Edit ad "${names[0] ?? op.ad}"`;
          lines.push(changes.join("; "));
          if (textChange) lines.push("A new creative is made with the changes and put on the ad. Meta reviews the ad again; Ads Manager keeps its results.");
          else if (op.creative_id) lines.push(`The creative the ad had before (${op.creative_id}) is put back on it; no new creative is made. Meta may review the ad again; Ads Manager keeps its results.`);
          break;
        }
        case "create_custom_audience":
        case "create_lookalike": {
          // Every field is checked first (each problem names its field); the audience is described only
          // when they are all right, so the summary never shows a missing value.
          const problems = audienceProblems(op);
          if (problems.length) {
            const nm = typeof op.name === "string" && op.name.trim() ? op.name.trim() : "(no name)";
            title = op.type === "create_lookalike" ? `Create lookalike "${nm}"` : `Create audience "${nm}"`;
            for (const pr of problems) err(n, pr);
            lines.push("Fix the fields above; the audience is described here once they are right.");
          } else {
            // An audience this plan makes is named by its own name, not its "$ref".
            const planAudience = (id: string) => {
              const r = id.replace(/^\$/, "").split("#")[0];
              const o = ops.find((x, k) => x && (x.type === "create_custom_audience" || x.type === "create_lookalike") && refKey((x as { ref?: string }).ref, k + 1) === r);
              return (o as { name?: string } | undefined)?.name;
            };
            const s = await audienceSummary(client, op, (r) => world.resolve("audience", r), planAudience);
            title = s.title;
            lines.push(...s.lines);
            for (const e of s.errors) err(n, e);
            for (const w of s.warnings) warn(n, w);
          }
          world.refs.set(ref, { kind: "audience", ids: [`$${ref}`] });
          break;
        }
        case "set_status": {
          const on = op.status === "ACTIVE";
          const parts: string[] = [];
          const list = async (kind: "campaign" | "adset" | "ad", xs?: string[]) => {
            const out: string[] = [];
            for (const s of xs ?? []) out.push(...(await world.resolve(kind, s)));
            return out;
          };
          const wholeIds = await list("campaign", op.whole_campaigns);
          const campIds = await list("campaign", op.campaigns);
          const setIds = await list("adset", op.adsets);
          const adIds = await list("ad", op.ads);
          // Only this ad account's own campaigns, ad sets and ads (one read per kind for every 100 IDs).
          const say = (kind: string, ids: string[], hint: string) => {
            if (!ids.length) return;
            const list = `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ` and ${ids.length - 10} more` : ""}`;
            // Turning off something that was deleted (or archived) in Ads Manager: it can't spend, so there is
            // nothing to turn off there. Said, but it doesn't stop the plan (or an Undo) from running.
            if (!on) warn(n, `${list} ${ids.length === 1 ? `is not ${kind}` : `are not ${kind}s`} in this ad account any more (deleted or archived?), so there is nothing to turn off there; ${ids.length === 1 ? "it is" : "they are"} skipped. If this is a wrong ID, fix it.${hint}`);
            else err(n, `${list} ${ids.length === 1 ? `is not ${kind}` : `are not ${kind}s`} in this ad account (or ${ids.length === 1 ? "it was" : "they were"} deleted or archived).${hint}`);
          };
          const badCamps = new Set(await world.preload("campaign", [...wholeIds, ...campIds]));
          say("a campaign", [...badCamps], "");
          const badSets = new Set(await world.preload("adset", setIds));
          say("an ad set", [...badSets], " Campaign IDs go in campaigns, ad IDs in ads.");
          const badAds = new Set(await world.preload("ad", adIds));
          say("an ad", [...badAds], " Campaign IDs go in campaigns (or whole_campaigns), ad set IDs in adsets.");
          for (const cid of wholeIds.filter((x) => !badCamps.has(x))) {
            const c = await world.campaign(cid);
            const sets = await world.adsetsOf(c.id);
            let adCount = 0;
            const saved = (wholeSaved[String(n)] ??= []);
            for (const a of sets) {
              const ads = await world.adsOf(a.id);
              adCount += ads.length;
              if (!a.virtual) saved.push(a.id);
              for (const ad of ads) {
                if (on && ad.status !== "ACTIVE") lit.add(a.id);
                if (!ad.virtual) saved.push(ad.id);
                ad.status = op.status;
              }
              a.status = op.status;
              touchAdset(a, n);
            }
            if (on && c.status !== "ACTIVE") turnOn(`campaign "${c.name}" with ${sets.length} ad set${sets.length === 1 ? "" : "s"} and ${adCount} ad${adCount === 1 ? "" : "s"}`, n);
            c.status = op.status;
            touchCampaign(c, n);
            parts.push(`whole campaign "${c.name}": the campaign, ${sets.length} ad set${sets.length === 1 ? "" : "s"} and ${adCount} ad${adCount === 1 ? "" : "s"}`);
          }
          for (const cid of campIds.filter((x) => !badCamps.has(x))) {
            const c = await world.campaign(cid);
            if (on && c.status !== "ACTIVE") turnOn(`campaign "${c.name}"`, n);
            c.status = op.status;
            touchCampaign(c, n);
            parts.push(`campaign "${c.name}"`);
          }
          for (const aid of setIds.filter((x) => !badSets.has(x))) {
            const a = await world.adset(aid);
            if (on && a.status !== "ACTIVE") turnOn(`ad set "${a.name}"`, n);
            if (on) await involve(a.id);
            a.status = op.status;
            touchAdset(a, n);
            parts.push(`ad set "${a.name}"`);
          }
          let adsHere = 0;
          let adsOn = 0;
          for (const id of adIds.filter((x) => !badAds.has(x))) {
            const w = world.ads.get(id);
            adsHere++;
            if (!w) continue;
            if (on && w.status !== "ACTIVE") {
              adsOn++;
              lit.add(w.adsetId);
              await involve(w.adsetId);
            }
            w.status = op.status;
          }
          if (adsHere) parts.push(`${adsHere} ad${adsHere > 1 ? "s" : ""}`);
          if (adsOn) turnOn(`${adsOn} ad${adsOn > 1 ? "s" : ""}`, n);
          title = `Turn ${on ? "ON" : "off"}: ${parts.join(", ") || "nothing"}`;
          if (!parts.length && !checks.some((c) => c.message.startsWith(`Step ${n}:`))) err(n, "name what to turn on or off (campaigns, adsets, ads or whole_campaigns).");
          lines.push(on ? "Turning on lets Meta spend the budgets below." : "Turning off stops spending. Nothing is deleted.");
          break;
        }
      }
    } catch (e) {
      if (e instanceof DeletionRefused) err(n, e.message);
      else err(n, e instanceof MetaError ? plainError(e, "Reading Meta") : e instanceof Error ? e.message : String(e));
    }
    const st = (op as { status?: string })?.status;
    if (st && !["ACTIVE", "PAUSED"].includes(String(st))) err(n, "status must be ACTIVE or PAUSED. Deleting or archiving is not possible in the launcher.");
    steps.push({ n, title: title || String((op as { type?: string })?.type), lines });
  }

  // ---- What can really spend afterwards: every campaign the plan touches that ends ON, with all its ad sets ----
  if (canSpend) {
    try {
      for (const a of [...world.adsets.values()].filter((x) => x.touched)) {
        const c = world.campaigns.get(a.campaignId) ?? (await world.campaign(a.campaignId));
        c.involved = true;
      }
      for (const c of [...world.campaigns.values()]) if (c.involved && c.status === "ACTIVE") await world.adsetsOf(c.id);
    } catch (e) {
      if (mustSurface(e)) throw e;
      checks.push({ level: "error", code: "spend_unknown", message: `Couldn't read every ad set of the campaigns this plan turns on, so what can spend is not known: ${plainError(e, "Reading the ad sets")}` });
    }
  }
  const spendNotes: string[] = [];
  /** A lifetime budget as a daily amount: lifetime ÷ whole days from when the plan runs (or the budget
   *  starts, if later) to its end, at least one day. The rule the batch go-live uses too. */
  const perDay = (lifetime: number | null, start: string | null | undefined, end: string | null | undefined, what: string): number => {
    if (!lifetime) return 0;
    const v = dailyEquivalent(null, lifetime, end, start, asOf);
    const s = timeMs(start);
    const from = Number.isNaN(s) ? asOf : Math.max(asOf, s);
    const e = timeMs(end);
    // Whole days left, at least one (the rule of dailyEquivalent: a part of a day does not count as a day).
    const days = Number.isNaN(e) ? 1 : Math.max(1, Math.floor((e - from) / 86_400_000));
    const span = Number.isNaN(e) ? ", no end date found" : from > Date.now() + 60_000 ? ` from ${istLabel(new Date(from).toISOString())} until ${istLabel(end)}` : ` left until ${istLabel(end)}`;
    spendNotes.push(`${what}: ${m(lifetime)} lifetime counted as ${m(v)} a day (${days} day${days === 1 ? "" : "s"}${span}).`);
    return v;
  };
  // Only campaigns the plan involves (makes, changes, turns on, or whose ad sets or ads it turns on), with
  // every one of their ad sets that is ON at the end. Budget periods count at their highest raise.
  // A campaign or ad set that has ended spends nothing (₹0).
  const onAtEnd = (c: WCampaign) => (c.status !== "ACTIVE" || !c.involved || ended(c.end) ? [] : [...world.adsets.values()].filter((a) => a.campaignId === c.id && a.status === "ACTIVE" && !ended(a.row.end_time)));
  // Budget periods already in Meta on the campaign budgets that can spend: read once per campaign.
  if (canSpend) {
    const periodsOf = new Map<string, Promise<MetaPeriod[]>>();
    const absorbed = new Set<Raise>();
    for (const c of world.campaigns.values()) {
      if (!c.cbo || !c.daily || !onAtEnd(c).length) continue;
      const metaId = c.virtual ? c.src : c.id;
      if (!metaId || isRef(metaId)) continue;
      if (!periodsOf.has(metaId)) periodsOf.set(metaId, readPeriods(client, metaId, cur));
      let rows: MetaPeriod[];
      try {
        rows = await periodsOf.get(metaId)!;
      } catch (e) {
        if (mustSurface(e)) throw e;
        checks.push({ level: "error", code: "periods_unknown", message: `Couldn't read the budget periods of campaign "${c.name}" in Meta, so what it can spend is not known. ${plainError(e, "Reading the budget periods")}` });
        continue;
      }
      for (const r of rows) {
        if (r.gone || r.e <= asOf) continue;
        if (r.amount === null) {
          checks.push({ level: "error", code: "periods_unknown", message: `Campaign "${c.name}" has a budget period in Meta (${periodAt(r.s)} to ${periodAt(r.e)}) set as ${r.type === "MULTIPLIER" ? "a multiple of its budget" : `"${r.type || "an unknown kind"}"`}. The launcher can't count that in what can spend. Change it to a fixed amount in Ads Manager (or remove it), then check the plan again.` });
          continue;
        }
        // A period this plan already sent is counted already (each one stands for one period in Meta).
        const mine = c.raises.find((x) => x.inMeta && !absorbed.has(x) && Math.abs(x.s - r.s) < 60_000 && Math.abs(x.e - r.e) < 60_000 && Math.abs(x.amount - r.amount!) < 0.5);
        if (mine) {
          absorbed.add(mine);
          continue;
        }
        c.raises.push({ s: r.s, e: r.e, amount: r.amount });
        spendNotes.push(`Campaign "${c.name}" already has a budget period in Meta: ${periodAt(r.s)} to ${periodAt(r.e)}, +${m(r.amount)} a day.`);
      }
    }
  }
  let spendNow = 0;
  const spendBasis: SpendItem[] = [];
  // Which spend this plan starts or raises (SpendItem.mine), against Meta as it was before the plan.
  const wasSpending = (o: Orig | undefined) => !!o && o.status === "ACTIVE" && !ended(o.end);
  const sameTime = (x: string | null | undefined, y: string | null | undefined) => {
    const a = timeMs(x);
    const b = timeMs(y);
    return Number.isNaN(a) ? Number.isNaN(b) : a === b;
  };
  const sameTimes = (o: Orig | undefined, start: string | null | undefined, end: string | null | undefined) => !!o && sameTime(o.start, start) && sameTime(o.end, end);
  const sameMoney = (o: Orig | undefined, x: { daily: number | null; lifetime: number | null }) => !!o && (o.daily ?? null) === (x.daily ?? null) && (o.lifetime ?? null) === (x.lifetime ?? null);
  const campaignAsBefore = (c: WCampaign) => !c.virtual && sameTimes(c.orig, c.start, c.end) && (c.orig?.spendCap ?? null) === (c.spendCap ?? null);
  const adsetAsBefore = (a: WAdSet) => !a.virtual && wasSpending(a.orig) && sameTimes(a.orig, a.row.start_time, a.row.end_time) && !lit.has(a.id);
  for (const c of world.campaigns.values()) {
    const on = onAtEnd(c);
    if (!on.length) continue;
    if (c.cbo) {
      const raise = c.daily ? maxRaise(c.raises, asOf) : 0;
      spendNow += (c.daily ?? perDay(c.lifetime, c.start, c.end, `Campaign "${c.name}"`)) + raise;
      if (raise) spendNotes.push(`Campaign "${c.name}": ${m(c.daily)} a day, and up to ${m((c.daily ?? 0) + raise)} a day during its budget periods (+${m(raise)}). The total counts the higher amount.`);
      // Already spending (on, with an ad set on, before the plan), and the plan changes neither its budget,
      // times, spend limit nor budget periods, nor turns anything on in it: not this plan's spend.
      const spendingBefore = wasSpending(c.orig) && [...world.adsets.values()].some((a) => a.campaignId === c.id && !a.virtual && wasSpending(a.orig));
      const untouched = spendingBefore && campaignAsBefore(c) && sameMoney(c.orig, c) && !c.planRaise && on.every(adsetAsBefore);
      spendBasis.push({ kind: "campaign", id: c.id, daily: c.daily, lifetime: c.daily ? null : c.lifetime, start: c.daily ? null : c.start, end: c.daily ? null : c.end, raise, mine: !untouched });
    } else {
      for (const a of on) {
        spendNow += a.daily ?? perDay(a.lifetime, a.row.start_time, a.row.end_time, `Ad set "${a.name}"`);
        const untouched = wasSpending(c.orig) && campaignAsBefore(c) && adsetAsBefore(a) && sameMoney(a.orig, a);
        spendBasis.push({ kind: "adset", id: a.id, daily: a.daily, lifetime: a.daily ? null : a.lifetime, start: a.daily ? null : a.row.start_time ?? null, end: a.daily ? null : a.row.end_time ?? null, raise: 0, mine: !untouched });
      }
    }
  }
  spendBasis.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  // ---- The plan's end state: every ad set once, at its final budget ----
  const adsets: SummaryAdSet[] = [...world.adsets.values()]
    .filter((a) => a.touched)
    .map((a) => {
      const c = world.campaigns.get(a.campaignId);
      const cbo = !!c?.cbo;
      const d = describeAdSet({ ...a.row, daily_budget: undefined, lifetime_budget: undefined }, cur);
      return {
        step: a.steps[0],
        steps: a.steps,
        name: a.name,
        campaign: c?.name ?? "",
        dailyBudget: cbo ? null : a.daily,
        // A daily-budget ad set has no lifetime budget: null, never ₹0.
        lifetimeBudget: cbo || !a.lifetime ? null : a.lifetime,
        status: a.status,
        isNew: a.isNew,
        details: { ...d, budget: cbo ? "campaign budget" : a.daily ? `${m(a.daily)} a day` : a.lifetime ? `${m(a.lifetime)} lifetime` : "no budget", status: a.status },
      };
    });
  const budgetCampaigns = [...world.campaigns.values()].filter((c) => c.cbo && (c.touched || [...world.adsets.values()].some((a) => a.touched && a.campaignId === c.id)));
  const dailyTotal = adsets.reduce((s, a) => s + (a.dailyBudget ?? 0), 0) + budgetCampaigns.reduce((s, c) => s + (c.daily ?? 0), 0);
  const lifetimeTotal = adsets.reduce((s, a) => s + (a.lifetimeBudget ?? 0), 0) + budgetCampaigns.reduce((s, c) => s + (c.lifetime ?? 0), 0);
  const dailies = adsets.map((a) => a.dailyBudget).filter((x): x is number => !!x);
  if (dailies.length >= 3) {
    const sorted = [...dailies].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    for (const a of adsets) if (a.dailyBudget && a.dailyBudget > 3 * median) checks.push({ level: "warning", code: "budget_outlier", message: `"${a.name}" has ${m(a.dailyBudget)} a day, more than 3 times the plan's usual ${m(median)}. Check it is not a typo.` });
  }
  if (input.expected_daily_total !== undefined && Math.abs(input.expected_daily_total - dailyTotal) > 0.5) {
    checks.push({ level: "error", code: "budget_mismatch", message: `At the end of this plan the daily budgets add up to ${m(dailyTotal)}, but the plan said ${m(input.expected_daily_total)}. Fix the budgets or the expected total.` });
  }
  // Before anything is made or turned on: can the ad account deliver at all, and do the pixels work.
  const makesOrTurnsOn = ops.some((o) => /^(create|duplicate|copy|ads_from_post)/.test(o?.type ?? "") || (o as { status?: string })?.status === "ACTIVE" || (o?.type === "duplicate_adset" || o?.type === "duplicate_campaign") && (o.changes ?? []).some((c) => c?.status === "ACTIVE"));
  if (makesOrTurnsOn && ops.length) {
    for (const c of await accountHealth(client)) checks.push({ ...c, level: c.level === "error" && !canSpend && c.code !== "account_status" ? "warning" : c.level });
  }
  await minSpendChecks();
  const pixels = new Set<string>();
  for (const o of ops) if ((o?.type === "create_adset" || o?.type === "edit_adset") && o.pixel_id) pixels.add(o.pixel_id);
  for (const px of [...pixels].slice(0, 3)) for (const c of await pixelCheck(client, px)) checks.push(c);
  const ceiling = dailyCeiling();
  if (ceiling && canSpend && spendNow > ceiling) {
    checks.push({ level: "error", code: "budget_ceiling", message: `This plan would let ${m(spendNow)} a day spend, above the daily budget ceiling of ${m(ceiling)} set in Settings.${spendNotes.length ? ` (${spendNotes.join(" ")})` : ""} Lower the budgets, or raise the ceiling in Settings first.` });
  }
  if (ceiling && !canSpend) {
    const over = [...adsets.map((a) => ({ name: a.name, daily: a.dailyBudget ?? 0 })), ...budgetCampaigns.map((c) => ({ name: c.name, daily: c.daily ?? 0 }))].filter((x) => x.daily > ceiling);
    if (over.length) checks.push({ level: "warning", code: "budget_ceiling", message: `${over.slice(0, 3).map((x) => `"${x.name}" (${m(x.daily)} a day)`).join(", ")}${over.length > 3 ? ` and ${over.length - 3} more` : ""} ${over.length === 1 ? "is" : "are"} above the daily budget ceiling of ${m(ceiling)} set in Settings → Safety. Nothing spends in this plan, but ${over.length === 1 ? "it" : "they"} can't be turned on until the budget is lowered (or the ceiling raised in the app).` });
  }
  if (canSpend && spendNow === 0 && !input.run_at) checks.push({ level: "warning", code: "nothing_delivers", message: "Something is turned on, but no campaign and ad set are both on afterwards, so nothing will spend yet." });
  const spending = [...world.campaigns.values()].flatMap(onAtEnd);
  if (canSpend && spending.length && spending.every((a) => a.virtual && !a.ads.length)) {
    spendNotes.push(`The ${spending.length === 1 ? "ad set" : `${spending.length} ad sets`} turned on ${spending.length === 1 ? "was" : "were"} made in this plan with no ads, so nothing will spend until ads are added. The total to confirm is what can spend once they have ads.`);
  }
  if (canSpend && spendNotes.length) {
    const st = steps.find((s) => s.n === lastTurnOn);
    if (st) st.lines.push(...spendNotes);
  }
  if (input.run_at) steps.unshift({ n: 0, title: `Runs at ${istLabel(input.run_at)}`, lines: ["The server runs the steps at this time. Until then the plan can be cancelled. Just before it runs, the budgets are checked again: if anything changed, it is not run and you get an email."] });

  return {
    account: { id: client.accountId, name: info.name, currency: cur },
    dailyCeiling: ceiling,
    runAt: input.run_at ?? null,
    steps,
    adsets,
    campaignBudgets: budgetCampaigns.map((c) => ({ name: c.name, dailyBudget: c.daily, lifetimeBudget: c.lifetime, status: c.status })),
    totals: {
      campaigns: [...world.campaigns.values()].filter((c) => c.virtual).length,
      adsets: adsets.filter((a) => a.isNew).length,
      ads: adsN,
      dailyBudget: dailyTotal,
      lifetimeBudget: lifetimeTotal,
      spendNowDaily: spendNow,
      turnsOn,
    },
    checks,
    errors: checks.filter((c) => c.level === "error").length,
    warnings: checks.filter((c) => c.level === "warning").length,
    canSpend,
    spendConfirmation: canSpend ? m(spendNow) : null,
    notes: spendNotes,
    spendBasis,
    ...(world.named.size ? { names: Object.fromEntries(world.named) } : {}),
    ...(Object.keys(wholeSaved).length ? { wholeIds: wholeSaved } : {}),
  };
}

const basisKey = (x: SpendItem) => `${x.kind}:${x.id}`;
const basisValue = (x: SpendItem) => canon({ daily: x.daily, lifetime: x.lifetime, start: x.start, end: x.end, raise: x.raise });

/**
 * Whether the spend this plan starts or raises changed between two checks of the same plan (the check
 * when the run starts against the confirmed one): an item the plan starts or raises (SpendItem.mine) that
 * the confirmed check didn't count, or counted with other budgets, times or periods. Budgets already
 * spending that the plan leaves as they are don't count (another plan or launch may have turned them on
 * meanwhile: that is not "more than confirmed"), and less spend is fine. Not the total, which moves as
 * days pass on a lifetime budget.
 */
export function spendChanged(old: PlanSummary, fresh: PlanSummary): boolean {
  if (!old.spendBasis || !fresh.spendBasis) return !sameAmount(old.spendConfirmation ?? "", fresh.spendConfirmation ?? "");
  const before = new Map(old.spendBasis.map((x) => [basisKey(x), x]));
  return fresh.spendBasis.some((x) => {
    if (x.mine === false) return false;
    const o = before.get(basisKey(x));
    return !o || basisValue(o) !== basisValue(x);
  });
}

/** Whether anything that can spend at the end changed at all (budgets, times, periods, what is on): for a
 *  confirmation, where the person types the total again. */
export function basisChanged(old: PlanSummary, fresh: PlanSummary): boolean {
  if (!old.spendBasis || !fresh.spendBasis) return !sameAmount(old.spendConfirmation ?? "", fresh.spendConfirmation ?? "");
  const list = (b: SpendItem[]) => b.map((x) => `${basisKey(x)}=${basisValue(x)}`).sort().join("|");
  return list(old.spendBasis) !== list(fresh.spendBasis);
}

function adsetRules(n: number, op: AdSetSpec, c: WCampaign, err: (n: number, m: string) => void) {
  const has = op.daily_budget !== undefined || op.lifetime_budget !== undefined;
  if (c.cbo && has) err(n, `"${c.name}" uses a campaign budget, so the ad set can't have its own budget.`);
  if (!c.cbo && !has) err(n, `"${c.name}" has no campaign budget, so the ad set needs daily_budget or lifetime_budget.`);
  if (op.daily_budget !== undefined && op.lifetime_budget !== undefined) err(n, "give daily_budget or lifetime_budget, not both.");
  if (op.bid_strategy && !BID_STRATEGIES.some((b) => b.value === op.bid_strategy)) err(n, `unknown bid strategy ${op.bid_strategy}.`);
  if (needsBid(op.bid_strategy) && op.bid_amount === undefined) err(n, `${op.bid_strategy} needs bid_amount.`);
  if (op.bid_strategy === "LOWEST_COST_WITH_MIN_ROAS" && op.roas_average_floor === undefined) err(n, "a ROAS goal needs roas_average_floor.");
  if (op.schedule?.length && op.lifetime_budget === undefined) err(n, "running only at set hours (schedule) needs a lifetime budget (Meta's rule).");
  if (op.frequency_cap && op.goal && !["REACH", "IMPRESSIONS", "POST_ENGAGEMENT"].includes(op.goal)) err(n, "a frequency cap works only with the goal REACH (or impressions / post engagement).");
  if (op.frequency_cap && c.objective && !["OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT"].includes(c.objective)) err(n, `Meta allows a frequency cap only in Awareness or Engagement campaigns; "${c.name}" is ${c.objective.replace("OUTCOME_", "").toLowerCase()}.`);
}

/**
 * The daily budget ceiling in plain words, for a warning about a large budget: its amount, or that
 * none is set (so nothing stops the budget) and where it is set.
 */
export function ceilingWords(m: (x: number) => string): string {
  const c = dailyCeiling();
  return c
    ? `The daily budget ceiling (Settings → Safety) is ${m(c)} a day; a launch or plan that would let more spend per day is refused.`
    : "No daily budget ceiling is set, so nothing stops this; it can be set only in the app, Settings → Safety.";
}

/** The hard daily ceiling from Settings (0 = none). */
export function dailyCeiling(): number {
  try {
    const r = db().prepare("SELECT value FROM app_settings WHERE key = 'daily_budget_ceiling'").get() as { value: string } | undefined;
    return r ? Number(r.value) || 0 : 0;
  } catch {
    return 0;
  }
}

// ---------- Saving, confirming ----------

export function getPlan(key: string): PlanRow {
  const r = db().prepare("SELECT * FROM plans WHERE key = ?").get(key) as PlanRow | undefined;
  if (!r) throw new HttpError(404, `No plan with code "${key}".`);
  return r;
}

export function savePlan(accountDbId: number, input: PlanInput, summary: PlanSummary, who: string, source: "app" | "claude"): string {
  const key = newKey();
  db()
    .prepare("INSERT INTO plans (key, ad_account_id, title, ops, summary, can_spend, run_at, progress, created_by, source) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(key, accountDbId, input.title?.trim() || defaultTitle(input), JSON.stringify(input), JSON.stringify(summary), summary.canSpend ? 1 : 0, input.run_at ?? null, JSON.stringify(input.ops.map(() => ({ status: "pending", ids: [], message: "" }))), who, source);
  return key;
}

export function defaultTitle(input: PlanInput): string {
  const kinds = [...new Set(input.ops.map((o) => stepWords(o as { type?: unknown; status?: unknown })))];
  return `${input.ops.length} step${input.ops.length === 1 ? "" : "s"}: ${kinds.join(", ")}`;
}

/** The first number in what was typed: "₹15,000", "15000", "INR 15,000.00", "Rs. 15,000", "Rs.15000". */
function firstAmount(s: string): number {
  const m = /\d[\d,]*(?:\.\d+)?/.exec(s);
  return m ? Number(m[0].replace(/,/g, "")) : NaN;
}

/** Normalise "₹15,000" / "15000" / "INR 15,000.00" / "Rs. 15,000" for comparing. */
export function sameAmount(a: string, b: string): boolean {
  const x = firstAmount(a);
  const y = firstAmount(b);
  return !!a.trim() && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 0.5;
}

export function confirmCheck(row: PlanRow, opts: { confirm?: boolean; acceptWarnings?: boolean; spendConfirmation?: string }) {
  if (opts.confirm !== true) throw new HttpError(400, "Running a plan needs confirm: true, after the person has read the summary.");
  if (row.status !== "draft") throw new HttpError(409, `This plan is already ${row.status}.`);
  const s = json<PlanSummary | null>(row.summary, null);
  if (!s) throw new HttpError(409, "The plan has not been checked yet.");
  if (s.errors > 0) throw new HttpError(422, `Fix these first:\n- ${s.checks.filter((c) => c.level === "error").map((c) => c.message).join("\n- ")}`);
  if (s.warnings > 0 && !opts.acceptWarnings) throw new HttpError(422, `There ${s.warnings === 1 ? "is 1 warning" : `are ${s.warnings} warnings`}. Show them to the person and accept them to run the plan.`);
  if (s.canSpend) {
    if (!opts.spendConfirmation || !sameAmount(opts.spendConfirmation, s.spendConfirmation ?? "")) {
      throw new HttpError(
        422,
        `${opts.spendConfirmation ? "The amount you typed doesn't match. " : ""}This plan turns things on, so Meta will spend money. Check every budget in the summary, then confirm by typing what can spend in a day once the plan has run, exactly as shown: ${s.spendConfirmation}.`,
      );
    }
  }
}

export function planProgress(row: PlanRow): PlanProgress[] {
  return json<PlanProgress[]>(row.progress, []);
}

// ---------- Running ----------

export interface RunDeps {
  client: MetaClient;
  clock: Clock;
  /** Test hook: called after each create, before the ID is saved. Throwing simulates a crash. */
  afterCreate?: (what: string) => void;
  /** Downloads a Drive file for "swap the creative" (needs the plan author's Google login). */
  driveFile?: (fileUrl: string) => Promise<{ path: string; name: string; kind: "image" | "video" }>;
}

function saveProgress(planId: number, p: PlanProgress[]) {
  db().prepare("UPDATE plans SET progress = ? WHERE id = ?").run(JSON.stringify(p), planId);
}

/** A running plan waiting for Meta's rate limits: until when, and why (null clears it). Set by the worker. */
export function setPlanWait(planId: number, until: number | null, reason = "") {
  if (until === null) cacheDelete(`plan_wait:${planId}:`);
  else cacheSet(`plan_wait:${planId}:`, { until, reason }, Math.max(60_000, until - Date.now() + 60_000));
}

export function planWait(planId: number): { until: number; reason: string } | null {
  const w = cacheGet<{ until: number; reason: string }>(`plan_wait:${planId}:`);
  return w && w.until > Date.now() ? w : null;
}

function isAccessError(e: unknown) {
  if (!(e instanceof MetaError)) return false;
  const c = e.code ?? 0;
  return c === 190 || c === 102 || c === 10 || (c >= 200 && c <= 299);
}

/** A cancel arrived while a long step was copying: it stopped after the item it was on. */
class StepStopped extends Error {}

/** A copy step stopped by a cancel: how many copies it made, and whether they are on or paused. */
function copiesStopped(op: { changes?: { status?: string }[] }, made: number, count: number): string {
  const on = Array.from({ length: made }, (_, x) => op.changes?.[x]?.status === "ACTIVE").filter(Boolean).length;
  const state = on === 0 ? "kept, paused" : on === made ? "kept and on" : `kept: ${on} on, ${made - on} paused`;
  return `Stopped because the plan was cancelled: ${made} of ${count} copies made (${state}). Nothing after this step ran.`;
}

/** Items a step made or changed before it stopped (for its message and for retries). */
export function madeCount(op: Op, p: PlanProgress | undefined): number {
  if (!p) return 0;
  if (op.type === "set_status") return p.ids.length;
  if (op.type === "edit_campaign" || op.type === "edit_adset" || op.type === "edit_ad") return (p.finished ?? []).filter((k) => k === "edit" || k.startsWith("item:") || k.startsWith("ad:")).length;
  return p.ids.filter(Boolean).length + Object.keys(p.sub ?? {}).filter((k) => !k.startsWith("users_") && k !== "creative").length;
}

const turnsOnOp = (op: Op) => (op as { status?: string }).status === "ACTIVE" || ((op as { changes?: { status?: string }[] }).changes ?? []).some((c) => c?.status === "ACTIVE");

/** What a stopped step leaves behind, in words that fit the step (a turn-on step's items are ON, not paused). */
function madeNote(op: Op, n: number): string {
  const s = n === 1 ? "" : "s";
  if (op.type === "set_status") {
    const on = op.status === "ACTIVE";
    return `${on ? "Turned on" : "Turned off"} before it stopped: ${n} item${s} (${n === 1 ? "it stays" : "they stay"} ${on ? "on" : "off"}; Retry continues with the rest).`;
  }
  if (op.type === "edit_campaign" || op.type === "edit_adset" || op.type === "edit_ad") return `Changed before it stopped: ${n} item${s} (Retry continues with the rest).`;
  return `Made before it stopped: ${n} item${s} (kept${turnsOnOp(op) ? "" : ", paused"}; Retry continues from here).`;
}

/**
 * A plan is checked again when its run starts, unless the person confirmed it (with a fresh check) a
 * moment ago: budgets or statuses may have changed in Ads Manager while it waited for its time or for
 * other plans. Returns why it must not run, or null.
 */
async function stillAsConfirmed(row: PlanRow, input: PlanInput, progress: PlanProgress[], client: MetaClient): Promise<{ why: string | null; fresh: PlanSummary | null }> {
  let fresh: PlanSummary;
  // Steps a retried plan already finished stand in as they are (as when it was confirmed).
  const done = new Map<number, string[]>();
  progress.forEach((p, i) => {
    if (p?.status === "done") done.set(i, p.ids.filter(Boolean));
  });
  try {
    fresh = await summarise(client, { ...input, run_at: undefined }, { validate: false, done, progress, atRun: true });
  } catch (e) {
    if ((e as { fatal?: boolean }).fatal) throw e;
    return { why: `the plan couldn't be checked again just before it ran (${plainError(e, "Reading Meta")})`, fresh: null };
  }
  const old = json<PlanSummary | null>(row.summary, null);
  const errors = fresh.checks.filter((c) => c.level === "error").map((c) => c.message);
  if (errors.length) return { why: `the check now finds ${errors.length === 1 ? "a problem" : `${errors.length} problems`}: ${errors.slice(0, 3).join(" ")}`, fresh };
  // Budgets, times and what is ON are compared, not the total: a lifetime budget's daily amount goes up
  // as its days pass, while nothing changed in Meta.
  if (fresh.canSpend && (!old?.canSpend || spendChanged(old, fresh))) {
    return {
      why: !old?.canSpend
        ? `it now turns things on (${fresh.spendConfirmation} a day can spend), which it didn't when it was confirmed`
        : sameAmount(old.spendConfirmation ?? "", fresh.spendConfirmation ?? "")
          ? `budgets or what is on changed in Meta since it was confirmed (what can spend is still ${fresh.spendConfirmation} a day)`
          : `what can spend changed since it was confirmed: now ${fresh.spendConfirmation} a day (it was ${old.spendConfirmation})`,
      fresh,
    };
  }
  return { why: null, fresh };
}

/** The plan's own notes (what a retry keeps, what stays in Meta: checks with code plan_note) carried to a
 *  newer check of it, which doesn't make them again. */
export function keepNotes(fresh: PlanSummary, old: PlanSummary | null): PlanSummary {
  const notes = (old?.checks ?? []).filter((c) => c.code === "plan_note" && !fresh.checks.some((f) => f.code === "plan_note" && f.message === c.message));
  if (!notes.length) return fresh;
  const checks = [...fresh.checks, ...notes];
  return { ...fresh, checks, warnings: checks.filter((c) => c.level === "warning").length };
}

/** Back to a draft, with the reason on the plan and in an email. Nothing in Meta was changed. */
async function reopen(row: PlanRow, input: PlanInput, progress: PlanProgress[], why: string, fresh: PlanSummary | null) {
  const when = row.run_at ? istLabel(row.run_at) : "";
  const message = when
    ? `Not run at ${when}: ${why}. Nothing was changed in Meta. Read the plan again and confirm it to run it now, or give it a new time.`
    : `Not run: ${why}. Nothing was changed in Meta. Read the plan again and confirm it to run it.`;
  const p = input.ops.map((_, i) => progress[i] ?? { status: "pending" as const, ids: [], message: "" });
  // The reason goes on the first step still to run (a retried plan's finished steps keep their message).
  const first = Math.max(0, p.findIndex((x) => x.status !== "done"));
  if (p[first]) p[first] = { ...p[first], message };
  const summary = fresh ? JSON.stringify(keepNotes(fresh, json<PlanSummary | null>(row.summary, null))) : row.summary;
  const ops = JSON.stringify({ ...input, run_at: undefined });
  const changed = db().prepare("UPDATE plans SET status = 'draft', run_at = NULL, ops = ?, summary = ?, can_spend = ?, progress = ?, confirmed_at = NULL, confirmed_by = NULL WHERE id = ? AND status = 'running'").run(ops, summary, fresh?.canSpend ? 1 : row.can_spend, JSON.stringify(p), row.id).changes;
  // Cancelled while it was being checked: it stays cancelled, and nobody is asked to confirm it.
  if (!changed) return;
  if (row.created_by) {
    await sendAlert({ to: row.created_by, subject: `Plan ${row.key} was not run${when ? ` at ${when}` : ""}`, lines: [when ? `"${row.title}" was set to run at ${when}.` : `"${row.title}" was checked again when its turn came to run.`, message], link: appLink(`/plans/${row.key}`) });
  }
}

/** A plan confirmed by a person less than this long before its run starts is not checked again (the
 *  confirmation just checked it), unless another plan or launch of the same ad account ran since that
 *  check started (accountChangedSince). Anything else is: a time set, a wait behind other plans, a
 *  turn-on plan queued by a launch. */
const RECHECK_AFTER_MS = 3 * 60_000;

/** confirmPlan's fresh check, for the run that follows: when it started, for this confirmation. */
export function markChecked(planId: number, confirmedAt: string | null, at = Date.now()) {
  cacheSet(`plan_fresh:${planId}:${confirmedAt ?? ""}`, at, RECHECK_AFTER_MS + 60_000);
}

/** The last run of a plan of this ad account ended (or stopped) at `at`. */
const ranKey = (accountDbId: number) => `plan_ran:${accountDbId}:`;

/**
 * Did another plan or launch of this ad account change Meta since `since` (ms), or is one changing it
 * now? Then a check made at `since` may be out of date. Plans: one running now, or one whose run ended
 * after `since` (marked by runPlan). Launches: one running now, or one that finished after `since`.
 * The jobs table keeps no finish time, so the plans' mark and the batches' finished_at are used.
 * A batch's go-live job only reads Meta and saves a plan (the turn-on itself is a plan), so it is not
 * counted on its own.
 */
function accountChangedSince(accountDbId: number, planId: number, since: number): boolean {
  const ran = cacheGet<{ at: number; plan: number }>(ranKey(accountDbId));
  if (ran && ran.plan !== planId && ran.at > since) return true;
  if (db().prepare("SELECT 1 FROM plans WHERE ad_account_id = ? AND id != ? AND status = 'running' LIMIT 1").get(accountDbId, planId)) return true;
  const iso = new Date(since).toISOString();
  return !!db().prepare("SELECT 1 FROM batches WHERE ad_account_id = ? AND (status = 'running' OR (finished_at IS NOT NULL AND julianday(finished_at) >= julianday(?))) LIMIT 1").get(accountDbId, iso);
}

/** Run a confirmed plan to the end. Safe to call again after a crash: finished steps and saved IDs are kept. */
export async function runPlan(planId: number, deps: RunDeps): Promise<{ done: number; failed: number; reopened?: string }> {
  // Only a plan waiting to run (or cut off while running) runs: never a draft someone is editing, a plan
  // that ended or a cancelled one. Changing the status is the lock, so a cancel just before wins.
  const started = db().prepare("UPDATE plans SET status = 'running' WHERE id = ? AND status IN ('queued', 'running')").run(planId).changes;
  if (!started) return { done: 0, failed: 0 };
  const row = db().prepare("SELECT * FROM plans WHERE id = ?").get(planId) as PlanRow;
  const input = JSON.parse(row.ops) as PlanInput;
  const progress = planProgress(row);
  const { client } = deps;
  // A plan is checked again when its run starts (a time set, a wait behind other plans, a turn-on plan
  // queued by a launch, a retried plan given a new time), unless a person confirmed it with a fresh check
  // a moment ago. Not when a run cut off by a restart continues (a step is still marked running, or this
  // confirmation's check already passed).
  const checkedKey = `plan_checked:${row.id}:${row.confirmed_at ?? ""}`;
  const freshAt = cacheGet<number>(`plan_fresh:${row.id}:${row.confirmed_at ?? ""}`);
  // The confirmation's check stands only while nothing else may have changed Meta since it started.
  const justConfirmed = freshAt !== undefined && Date.now() - freshAt < RECHECK_AFTER_MS && !row.run_at && !accountChangedSince(row.ad_account_id, row.id, freshAt);
  if (!justConfirmed && !progress.some((p) => p?.status === "running") && !cacheGet<number>(checkedKey)) {
    const { why, fresh } = await stillAsConfirmed(row, input, progress, client);
    if (why) {
      await reopen(row, input, progress, why, fresh);
      return { done: 0, failed: 0, reopened: why };
    }
    cacheSet(checkedKey, 1, 60 * 86_400_000);
  }
  const { currency } = await accountInfo(client);
  const refs = new Map<string, string[]>();
  const bidDefaults = new Map<string, string>(); // campaign id → bid strategy its create step named (ABO)
  input.ops.forEach((op, i) => {
    if (progress[i]?.ids.length) refs.set(refKey((op as { ref?: string }).ref, i + 1), progress[i].ids);
    if (op.type === "create_campaign" && op.bid_strategy && progress[i]?.ids[0]) bidDefaults.set(progress[i].ids[0], op.bid_strategy);
  });
  // Names: the IDs the confirmed check found for this step; otherwise one read by exact name (Meta's
  // name filter), kept until a step that may make or rename something has run.
  const confirmed = json<PlanSummary | null>(row.summary, null);
  const confirmedNames = confirmed?.names ?? {};
  // Whole campaigns turned on: what the confirmed check counted (none saved: a plan checked before this was kept).
  const confirmedWhole = confirmed?.wholeIds;
  /** What this plan's steps made, and what they no longer use (never turned on). */
  const planItems = () => {
    const made = new Set<string>();
    const never = new Set<string>();
    input.ops.forEach((o, k) => {
      const pp = progress[k];
      if (!pp || !o) return;
      for (const x of itemsMade(o, pp)) made.add(x.id);
      for (const x of [...(pp.orphans ?? []), ...(pp.unused ?? [])]) never.add(x.id);
    });
    for (const id of never) made.delete(id);
    return { made, never };
  };
  const names = new Map<string, { id: string; name: string }[]>();
  let stepNo = 0;
  const resolve = async (kind: "campaign" | "adset" | "ad" | "audience", s: string): Promise<string[]> => {
    const v = String(s ?? "").trim();
    if (isRef(v)) {
      const m = REF.exec(v);
      const got = m ? refs.get(m[1])?.filter(Boolean) : undefined;
      if (!m || !got?.length) throw new Error(`step "${v}" did not make anything, so this step can't run.`);
      if (m[2] === undefined) return got;
      const one = got[Number(m[2]) - 1];
      if (!one) throw new Error(`"${v}": that step made ${got.length} item${got.length === 1 ? "" : "s"}.`);
      return [one];
    }
    if (/^\d+$/.test(v) || kind === "ad" || kind === "audience") return [v];
    const known = confirmedNames[`${stepNo}|${kind}|${v.toLowerCase()}`];
    if (known) return [known];
    const edge = kind === "campaign" ? "campaigns" : "adsets";
    const k = `${edge}|${v.toLowerCase()}`;
    if (!names.has(k)) {
      names.set(k, await client.getAll<{ id: string; name: string }>(`${client.accountId}/${edge}`, { fields: "id,name", filtering: [{ field: "name", operator: "EQUAL", value: v }], effective_status: ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "IN_PROCESS", "WITH_ISSUES"] }, 50));
    }
    return [onlyOne(names.get(k)!.filter((x) => x.name.toLowerCase() === v.toLowerCase()), v, kind === "campaign" ? "campaign" : "ad set")];
  };
  const cancelled = () => (db().prepare("SELECT status FROM plans WHERE id = ?").get(planId) as { status: string }).status === "cancelled";
  const save = () => saveProgress(planId, progress);
  // This run may change Meta: a plan of this ad account confirmed a moment ago is checked again when it runs.
  const markRan = () => cacheSet(ranKey(row.ad_account_id), { at: Date.now(), plan: row.id }, RECHECK_AFTER_MS + 60_000);

  let stop = "";
  for (let i = 0; i < input.ops.length; i++) {
    const op = input.ops[i];
    const p = (progress[i] ??= { status: "pending", ids: [], message: "" });
    if (p.status === "done") continue;
    if (stop) { p.status = "skipped"; p.message = stop; save(); continue; }
    if (cancelled()) { stop = "The plan was cancelled before this step."; i--; continue; }
    p.status = "running";
    stepNo = i + 1;
    save();
    try {
      // Items an earlier version of this step made, that it no longer uses: turned off first. One that
      // was deleted in Ads Manager since can't spend: nothing to turn off.
      for (const o of [...(p.orphans ?? [])]) {
        if (isFinished(p, `orphan:${o.id}`)) continue;
        try {
          await client.post(o.id, { status: "PAUSED" });
        } catch (e) {
          if (!(await goneFromMeta(client, o.id, e))) throw e;
          p.orphans = (p.orphans ?? []).filter((x) => x.id !== o.id);
        }
        finish(p, `orphan:${o.id}`);
        save();
      }
      await runOp(op, i, p, {
        ...deps,
        currency,
        accountDbId: row.ad_account_id,
        resolve,
        bidDefaults,
        planKey: row.key,
        nameDate: input.name_date,
        save,
        cancelled,
        wholeIds: confirmedWhole ? confirmedWhole[String(i + 1)] ?? [] : undefined,
        planItems,
        // Undo memory is saved before the change is sent, so a restart right after it can't lose it.
        remember: (pp, id, values) => {
          remember(pp, id, values);
          save();
        },
      });
      p.status = "done";
      if (p.ids.length) refs.set(refKey((op as { ref?: string }).ref, i + 1), p.ids);
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal) {
        markRan();
        throw e;
      }
      p.status = e instanceof StepStopped ? "stopped" : "failed";
      if (e instanceof StepStopped) {
        p.message = e.message;
        stop = "The plan was cancelled before this step.";
      } else {
        p.message = e instanceof MetaError && e.subcode === 1885648
          ? `Step ${i + 1} failed: Meta refused it because the minimum daily spends of the ad sets in the campaign would add up to more than the campaign budget (code 100/1885648). Lower min_daily_spend, or raise the campaign budget, then press Retry.`
          : e instanceof MetaError ? plainError(e, `Step ${i + 1}`) : `Step ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`;
        const made = madeCount(op, p);
        if (made) p.message += ` ${madeNote(op, made)}`;
        // A copy made whose own settings (name, budget, status, changes) were not sent yet: said, never hidden.
        if (op.type === "duplicate_adset" || op.type === "duplicate_campaign") {
          const half = p.ids.map((id, j) => (id && !isFinished(p, `item:${j}`) ? j + 1 : 0)).filter(Boolean);
          if (half.length) p.message += ` ${half.length === 1 ? `Copy ${half[0]} is` : `Copies ${half.join(", ")} are`} made but not finished: ${half.length === 1 ? "its" : "their"} settings were not sent yet, so ${half.length === 1 ? "it is" : "they are"} paused and still named "… [P:${row.key}.${i + 1}…]". Retry finishes ${half.length === 1 ? "it" : "them"} (no second copy is made).`;
        }
        // The first failed step stops the plan: a later step may depend on it (a budget lowered
        // before a turn-on), and must never run on the old state.
        stop = isAccessError(e)
          ? `Not run: the Meta connection lost permission in step ${i + 1}.`
          : `Skipped: step ${i + 1} failed, so the steps after it did not run. Fix step ${i + 1} and press Retry.`;
      }
    }
    // A step that made, copied or renamed something changes the names a later step may use.
    if (op.type !== "set_status" && op.type !== "edit_ad" && !(op.type === "edit_adset" && !op.name) && !(op.type === "edit_campaign" && !op.name)) names.clear();
    save();
  }
  const done = progress.filter((p) => p.status === "done").length;
  const failed = progress.length - done;
  // A cancelled plan stays cancelled (also when the step that was running when it came was the last one):
  // the steps show what ran. Otherwise done, failed (nothing made or changed) or partial.
  if (cancelled()) {
    db().prepare("UPDATE plans SET finished_at = datetime('now') WHERE id = ?").run(planId);
  } else {
    const status = failed === 0 ? "done" : done === 0 && input.ops.every((o, i) => !madeCount(o, progress[i])) ? "failed" : "partial";
    db().prepare("UPDATE plans SET status = ?, finished_at = datetime('now') WHERE id = ? AND status = 'running'").run(status, planId);
  }
  markRan();
  return { done, failed };
}

/**
 * A turn-off that Meta refused: is the object gone (deleted in Ads Manager, or archived)? Then it can't
 * spend and there is nothing to turn off. Read again to be sure; any other answer is not "gone".
 */
async function goneFromMeta(client: MetaClient, id: string, e: unknown): Promise<boolean> {
  if (!(e instanceof MetaError) || e.code !== 100 || mustSurface(e)) return false;
  try {
    const o = await client.get<{ status?: string; effective_status?: string }>(id, { fields: "status,effective_status" });
    return /DELETED|ARCHIVED/.test(`${o.status ?? ""} ${o.effective_status ?? ""}`);
  } catch (e2) {
    if (mustSurface(e2)) throw e2;
    return e2 instanceof MetaError && e2.code === 100;
  }
}

interface OpCtx extends RunDeps {
  currency: string;
  accountDbId: number;
  /** "Turn on whole campaigns": the real ad sets and ads the confirmed check counted (undefined: not kept). */
  wholeIds?: string[];
  /** What the plan's steps made so far, and the items they no longer use (never turned on). */
  planItems: () => { made: Set<string>; never: Set<string> };
  resolve: (kind: "campaign" | "adset" | "ad" | "audience", s: string) => Promise<string[]>;
  bidDefaults: Map<string, string>;
  planKey: string;
  nameDate?: string;
  save: () => void;
  cancelled: () => boolean;
  remember: (p: PlanProgress, id: string, values: Record<string, unknown>) => void;
}

const isFinished = (p: PlanProgress, k: string) => !!p.finished?.includes(k);
function finish(p: PlanProgress, k: string) {
  p.finished = [...(p.finished ?? []).filter((x) => x !== k), k];
}

/**
 * Create something once: if an earlier run started this item but saved no ID, look it up first (only
 * objects Meta made after that start count, by the name it was sent with). `made`: created now, with
 * this version of the step (false: made earlier or found, maybe with settings the step had before).
 */
async function createOnce(p: PlanProgress, j: number, ctx: OpCtx, find: (since: number, name?: string) => Promise<string | null>, create: () => Promise<string>, name?: string): Promise<{ id: string; made: boolean }> {
  if (p.ids[j]) return { id: p.ids[j], made: false };
  const k = String(j);
  if (p.attempted?.includes(j)) {
    const found = await find(p.attemptedAt?.[k] ?? Number.POSITIVE_INFINITY, p.attemptedName?.[k]);
    if (found) {
      p.ids[j] = found;
      ctx.save();
      return { id: found, made: false };
    }
  }
  p.attempted = [...(p.attempted ?? []).filter((x) => x !== j), j];
  p.attemptedAt = { ...(p.attemptedAt ?? {}), [k]: Date.now() };
  if (name !== undefined) p.attemptedName = { ...(p.attemptedName ?? {}), [k]: name };
  ctx.save();
  const id = await create().catch((e) => refused(p, j, ctx, e));
  ctx.afterCreate?.(`${ctx.planKey}:${j}`);
  p.ids[j] = id;
  p.attempted = p.attempted.filter((x) => x !== j);
  if (p.attemptedAt) delete p.attemptedAt[k];
  if (p.attemptedName) delete p.attemptedName[k];
  // Made with this version of the step: nothing changed to send to it.
  finish(p, `settings:${j}`);
  ctx.save();
  return { id, made: true };
}

/** Meta said no to a create (a clear answer, not a lost one): nothing was made, so nothing is looked up
 *  next time. Rethrows the error. */
function refused(p: PlanProgress, j: number | string, ctx: OpCtx, e: unknown): never {
  if (e instanceof MetaError && !e.unknownOutcome) {
    p.attempted = (p.attempted ?? []).filter((x) => x !== j);
    if (p.attemptedAt) delete p.attemptedAt[String(j)];
    if (p.attemptedName) delete p.attemptedName[String(j)];
    ctx.save();
  }
  throw e;
}

async function createItem(p: PlanProgress, j: number, ctx: OpCtx, find: (since: number, name?: string) => Promise<string | null>, create: () => Promise<string>, name?: string): Promise<string> {
  return (await createOnce(p, j, ctx, find, create, name)).id;
}

/** Meta fields a changed step field becomes (for an item made before the change). */
const CAMPAIGN_PARAMS_OF: Record<string, string[]> = {
  daily_budget: ["daily_budget"], lifetime_budget: ["lifetime_budget"], bid_strategy: ["bid_strategy"], spend_cap: ["spend_cap"],
  start_time: ["start_time"], stop_time: ["stop_time"],
};
const PROMOTED = ["pixel_id", "event", "custom_event_str", "custom_conversion_id", "page_id", "app_id", "app_store_url", "whatsapp_number"];
const AUDIENCE = ["saved_audience_id", "countries", "regions", "cities", "age_min", "age_max", "genders", "interests", "custom_audiences", "excluded_custom_audiences", "advantage_audience", "placements", "targeting", "languages", "block_list_ids", "targeting_expansion", "replace_targeting"];
const ADSET_PARAMS_OF: Record<string, string[]> = {
  daily_budget: ["daily_budget"], lifetime_budget: ["lifetime_budget"], start_time: ["start_time"], end_time: ["end_time"], billing_event: ["billing_event"],
  bid_strategy: ["bid_strategy"], bid_amount: ["bid_amount"], roas_average_floor: ["bid_constraints"], attribution: ["attribution_spec"],
  schedule: ["pacing_type", "adset_schedule"], frequency_cap: ["frequency_control_specs"], inventory_filter: ["brand_safety_content_filter_levels"],
  min_daily_spend: ["daily_min_spend_target"], max_daily_spend: ["daily_spend_cap"],
  ...Object.fromEntries(PROMOTED.map((k) => [k, ["promoted_object"]])),
  ...Object.fromEntries(AUDIENCE.map((k) => [k, ["targeting"]])),
};

/**
 * What to send to an item a changed step made before the change, so Meta has what the summary shows:
 * the name and status always, and every Meta field a changed step field becomes (taken from `full`, the
 * fields as they would be sent to make it now). A field the new version leaves out can't be cleared here.
 */
function changedParams(full: Record<string, unknown>, changed: string[], map: Record<string, string[]>, status: string): Record<string, unknown> {
  const out: Record<string, unknown> = { status };
  if (full.name !== undefined) out.name = full.name;
  for (const k of changed) for (const f of map[k] ?? []) if (full[f] !== undefined) out[f] = full[f];
  return out;
}

/** Same, for objects made inside one item (the ad sets and ads of a copied campaign). */
async function createSub(p: PlanProgress, key: string, ctx: OpCtx, find: (since: number) => Promise<string | null>, create: () => Promise<string>): Promise<string> {
  p.sub ??= {};
  if (p.sub[key]) return p.sub[key];
  if (p.attempted?.includes(key)) {
    const found = await find(p.attemptedAt?.[key] ?? Number.POSITIVE_INFINITY);
    if (found) {
      p.sub[key] = found;
      ctx.save();
      return found;
    }
  }
  p.attempted = [...(p.attempted ?? []).filter((x) => x !== key), key];
  p.attemptedAt = { ...(p.attemptedAt ?? {}), [key]: Date.now() };
  ctx.save();
  const id = await create().catch((e) => refused(p, key, ctx, e));
  ctx.afterCreate?.(`${ctx.planKey}:${key}`);
  p.sub[key] = id;
  p.attempted = p.attempted.filter((x) => x !== key);
  if (p.attemptedAt) delete p.attemptedAt[key];
  ctx.save();
  return id;
}

/** A lookup after a lost answer: "not found" or "can't filter here" (code 100) means create it; Meta
 *  limiting calls or any other error is thrown (never "nothing found", which would create it twice). */
function lookupFail(e: unknown): never[] {
  if (!mustSurface(e) && e instanceof MetaError && e.code === 100) return [];
  throw e;
}

/**
 * An object this plan made but whose answer was lost: found by its exact name, and only when Meta made it
 * after the attempt started (minus a minute for clocks), so an older object with the same name is never
 * taken for it. `since` null: no time check (a creative of a post is the same post either way).
 */
async function findByName(client: MetaClient, edge: string, name: string, since: number | null, timeField: "created_time" | "time_created" = "created_time"): Promise<string | null> {
  const rows = await client
    .getAll<{ id: string; name: string; created_time?: string; time_created?: number | string }>(edge, { fields: since === null ? "id,name" : `id,name,${timeField}`, filtering: [{ field: "name", operator: "EQUAL", value: name }] })
    .catch(lookupFail);
  const madeAt = (r: { created_time?: string; time_created?: number | string }) => {
    if (r.created_time) return timeMs(r.created_time);
    if (r.time_created !== undefined && r.time_created !== "") return Number(r.time_created) * 1000;
    return NaN;
  };
  const hits = rows.filter((r) => r.name === name && (since === null || madeAt(r) >= since - 60_000));
  if (since === null) return hits[0]?.id ?? null;
  // The one Meta made last: an object of the same name made just before this attempt (within the minute
  // allowed for clocks) is older than the one this attempt made.
  return hits.sort((a, b) => madeAt(b) - madeAt(a))[0]?.id ?? null;
}

/** A copy is first named "<original> [P:plan.step.item]" and renamed after: a restart finds it by that mark only
 *  (never by the final name, which an older object, or the original itself, may have). */
async function findCopy(client: MetaClient, edge: string, marker: string): Promise<string | null> {
  const rows = await client.getAll<{ id: string; name: string }>(edge, { fields: "id,name", filtering: [{ field: "name", operator: "CONTAIN", value: marker }] }).catch(lookupFail);
  return rows.find((r) => r.name.includes(marker))?.id ?? null;
}

/** Copy one object (campaign, ad set or ad) on its own: Meta copies at most 2 objects in one request. */
async function copyOne(client: MetaClient, srcId: string, params: Record<string, unknown>, key: string): Promise<string> {
  const r = await client.post<{ id?: string; copied_campaign_id?: string; copied_adset_id?: string; copied_ad_id?: string; ad_object_ids?: { copied_id: string }[] }>(`${srcId}/copies`, { ...params, deep_copy: false, status_option: "PAUSED" }, { idempotencyKey: key });
  const id = r.copied_campaign_id ?? r.copied_adset_id ?? r.copied_ad_id ?? r.ad_object_ids?.[0]?.copied_id ?? r.id;
  if (!id) throw new Error("Meta did not return the new copy's ID.");
  return id;
}

/** Remember a value before changing it, for "Undo this plan" (the first value seen wins). */
function remember(p: PlanProgress, id: string, values: Record<string, unknown>) {
  p.before ??= {};
  p.before[id] ??= values;
}

/** Only the campaign fields this step changes, as they were (Undo puts back only these). */
function campaignBefore(op: CampaignSpec, cur: CampaignRow): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (op.name) b.name = cur.name;
  if (op.daily_budget !== undefined) b.daily_budget = cur.daily_budget ?? null;
  if (op.lifetime_budget !== undefined) b.lifetime_budget = cur.lifetime_budget ?? null;
  if (op.bid_strategy) b.bid_strategy = cur.bid_strategy ?? null;
  if (op.spend_cap !== undefined) b.spend_cap = cur.spend_cap ?? null;
  if (op.start_time) b.start_time = cur.start_time ?? null;
  if (op.stop_time) b.stop_time = cur.stop_time ?? null;
  if (op.status) b.status = cur.status;
  if (op.budget_schedules?.length) b.not_restorable = ["budget periods"];
  return b;
}

/** Only the ad set fields this step changes, as they were; the rest it changes is named for the undo summary. */
function adsetBefore(op: AdSetSpec, cur: AdSetRow): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (op.name) b.name = cur.name;
  if (op.daily_budget !== undefined) b.daily_budget = cur.daily_budget ?? null;
  if (op.lifetime_budget !== undefined) b.lifetime_budget = cur.lifetime_budget ?? null;
  if (op.bid_strategy || op.bid_amount !== undefined) { b.bid_strategy = cur.bid_strategy ?? null; b.bid_amount = cur.bid_amount ?? null; }
  if (op.start_time) b.start_time = cur.start_time ?? null;
  if (op.end_time) b.end_time = cur.end_time ?? null;
  if (touchesAudience(op) || op.replace_targeting) b.targeting = cur.targeting ?? null;
  if (op.status) b.status = cur.status;
  const other = [
    op.goal || op.destination || op.event || op.pixel_id || op.custom_conversion_id || op.custom_event_str || op.app_id || op.page_id || op.whatsapp_number ? "goal" : "",
    op.attribution ? "attribution" : "",
    op.schedule?.length ? "run hours" : "",
    op.frequency_cap ? "frequency cap" : "",
    op.min_daily_spend !== undefined || op.max_daily_spend !== undefined ? "spend limits" : "",
    op.inventory_filter ? "brand safety filter" : "",
    op.billing_event ? "billing event" : "",
    op.roas_average_floor !== undefined ? "ROAS goal" : "",
  ].filter(Boolean);
  if (other.length) b.not_restorable = other;
  return b;
}

async function runOp(op: Op, i: number, p: PlanProgress, ctx: OpCtx): Promise<void> {
  const { client, currency } = ctx;
  const act = client.accountId;
  // A step changed to work on something else starts a new generation: its creates get new idempotency
  // keys and marks, so Meta never hands back (or refuses) what the earlier version made.
  const gen = p.gen ? `g${p.gen}:` : "";
  const key = (j: number | string) => idemKey(`plan:${ctx.planKey}:${i}:${gen}${j}`);
  const mark = (j: number | string) => `[P:${ctx.planKey}.${i + 1}.${p.gen ? `g${p.gen}.` : ""}${j}]`;
  const date = ctx.nameDate;
  switch (op.type) {
    case "create_campaign": {
      const spec = effectiveCampaignSpec(op);
      const name = op.name || nameFor(op.name_template, "", { n: i + 1, persona: op.persona, angle: op.angle, objective: op.objective, budget: op.daily_budget ?? op.lifetime_budget, date });
      const { id, made } = await createOnce(p, 0, ctx, (since, was) => findByName(client, `${act}/campaigns`, was ?? name, since), async () => (await client.post<{ id: string }>(`${act}/campaigns`, campaignParams({ ...spec, name }, currency, true), { idempotencyKey: key(0) })).id, name);
      // Made (or found after a lost answer) before the step was changed: the changes and the status are
      // sent to it, so Meta has what the summary showed and was confirmed.
      if (!made && p.changed?.length && !isFinished(p, "settings:0")) {
        await client.post(id, changedParams(campaignParams({ ...spec, name }, currency, false), p.changed, CAMPAIGN_PARAMS_OF, op.status ?? "PAUSED"));
        finish(p, "settings:0");
        ctx.save();
      }
      if (op.bid_strategy && !spec.bid_strategy) ctx.bidDefaults.set(id, op.bid_strategy);
      if (op.budget_schedules?.length) await addBudgetSchedules(client, id, op.budget_schedules, currency, op.daily_budget ?? null, p, ctx);
      p.message = `Created campaign "${name}"${op.status === "ACTIVE" ? " (on)" : " (paused)"}.`;
      return;
    }
    case "edit_campaign": {
      const id = oneOf(await ctx.resolve("campaign", op.campaign), op.campaign, "campaign", "edit_campaign");
      let cur: CampaignRow | undefined;
      if (!isFinished(p, "edit")) {
        cur = await getCampaign(client, id);
        ctx.remember(p, id, campaignBefore(op, cur));
        const params = campaignParams(op, currency, false);
        if (Object.keys(params).length) await client.post(id, params);
        finish(p, "edit");
        ctx.save();
      }
      if (op.budget_schedules?.length) {
        const daily = op.daily_budget ?? fromMinor((cur ?? (await getCampaign(client, id))).daily_budget, currency);
        await addBudgetSchedules(client, id, op.budget_schedules, currency, daily, p, ctx);
      }
      p.ids = [id];
      p.message = `Updated campaign "${op.name ?? cur?.name ?? id}".`;
      return;
    }
    case "duplicate_campaign": {
      const src = oneOf(await ctx.resolve("campaign", op.campaign), op.campaign, "campaign", "duplicate_campaign");
      const c = await getCampaign(client, src);
      const count = copiesOf(op);
      const contents = op.with_contents ? await campaignAdSets(client, src) : [];
      // Each ad set's ads, read once (not once per copy).
      const adsOf = new Map<string, Awaited<ReturnType<typeof adSetAds>>>();
      for (const a of contents) adsOf.set(a.id, await adSetAds(client, a.id));
      const total = count * (1 + contents.length + [...adsOf.values()].reduce((s, x) => s + x.length, 0));
      let copied = 0;
      const tick = () => {
        copied++;
        p.message = `Copying "${c.name}": ${copied} of ${total} item${total === 1 ? "" : "s"} copied (campaign, ad sets and ads, one at a time).`;
        ctx.save();
      };
      let sets = 0;
      let adsMade = 0;
      for (let j = 0; j < count; j++) {
        if (j > 0 && !p.ids[j] && ctx.cancelled()) throw new StepStopped(copiesStopped(op, j, count));
        const ch = op.changes?.[j] ?? {};
        const name = ch.name ?? nameFor(op.name_template ?? ch.name_template, `${c.name} - copy ${j + 1}`, { n: j + 1, persona: op.persona ?? ch.persona, objective: c.objective, budget: ch.daily_budget ?? fromMinor(c.daily_budget, currency), date });
        const { id, made } = await createOnce(p, j, ctx, () => findCopy(client, `${act}/campaigns`, mark(j + 1)), () => copyOne(client, src, { rename_options: { rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` ${mark(j + 1)}` } }, key(j)));
        if (!isFinished(p, `item:${j}`)) {
          // The status always (a copy changed from ON to paused on a retry is paused); a copy made before
          // the step was changed also gets its budget as the summary shows it (the original's, unless changed).
          const budget = !made && p.changed?.length && isCbo(c)
            ? { daily_budget: ch.daily_budget ?? (ch.lifetime_budget === undefined ? fromMinor(c.daily_budget, currency) || undefined : undefined), lifetime_budget: ch.lifetime_budget ?? (ch.daily_budget === undefined ? fromMinor(c.lifetime_budget, currency) || undefined : undefined) }
            : {};
          await client.post(id, { ...campaignParams({ ...ch, ...budget, name }, currency, false), status: ch.status ?? "PAUSED" });
          finish(p, `item:${j}`);
        }
        tick();
        // Then each ad set and each ad on its own (Meta: "fewer than 3" objects per copy, plan pwjd6).
        for (const a of contents) {
          const subKey = `${j + 1}/${a.id}`;
          const newSet = await createSub(p, subKey, ctx, () => findCopy(client, `${act}/adsets`, mark(subKey)), async () => {
            try {
              return await copyOne(client, a.id, { campaign_id: id, rename_options: { rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` ${mark(subKey)}` } }, key(subKey));
            } catch (e) {
              if (!(e instanceof MetaError) || e.code !== 100) throw e;
              return (await client.post<{ id: string }>(`${act}/adsets`, adsetCloneParams(a, id, `${a.name} ${mark(subKey)}`, isCbo(c)), { idempotencyKey: key(`${subKey}:rebuild`) })).id;
            }
          });
          if (!isFinished(p, `sub:${subKey}`)) {
            await client.post(newSet, { name: a.name });
            finish(p, `sub:${subKey}`);
          }
          sets++;
          tick();
          for (const ad of adsOf.get(a.id) ?? []) {
            const adKey = `${subKey}/${ad.id}`;
            const newAd = await createSub(p, adKey, ctx, () => findCopy(client, `${act}/ads`, mark(adKey)), () => copyOne(client, ad.id, { adset_id: newSet, rename_options: { rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` ${mark(adKey)}` } }, key(adKey)));
            if (!isFinished(p, `sub:${adKey}`)) {
              await client.post(newAd, { name: ad.name });
              finish(p, `sub:${adKey}`);
            }
            adsMade++;
            tick();
          }
        }
      }
      p.message = `Made ${count} cop${count === 1 ? "y" : "ies"} of "${c.name}"${op.with_contents ? ` with ${sets} ad set${sets === 1 ? "" : "s"} and ${adsMade} ad${adsMade === 1 ? "" : "s"} copied one at a time` : ""}, paused unless a copy said otherwise.`;
      return;
    }
    case "create_adset": {
      const campaignId = oneOf(await ctx.resolve("campaign", op.campaign), op.campaign, "campaign", "create_adset");
      const c = await getCampaign(client, campaignId);
      const spec = effectiveAdsetSpec(op, isCbo(c), ctx.bidDefaults.get(campaignId));
      const name = op.name || nameFor(op.name_template, "", { n: i + 1, persona: op.persona, angle: op.angle, campaign: c.name, budget: op.daily_budget ?? op.lifetime_budget, date });
      let saved: Targeting | undefined;
      if (op.saved_audience_id) saved = (await client.get<{ targeting?: Targeting }>(op.saved_audience_id, { fields: "targeting" })).targeting;
      const withAudiences = await resolveAudienceRefs(spec, ctx);
      const full = adsetParams({ ...withAudiences, name }, currency, { forCreate: true, savedAudience: saved });
      const { id, made } = await createOnce(p, 0, ctx, (since, was) => findByName(client, `${campaignId}/adsets`, was ?? name, since), async () =>
        (await client.post<{ id: string }>(`${act}/adsets`, { ...full, campaign_id: campaignId }, { idempotencyKey: key(0) })).id,
      name);
      if (!made && p.changed?.length && !isFinished(p, "settings:0")) {
        await client.post(id, changedParams(full, p.changed, ADSET_PARAMS_OF, op.status ?? "PAUSED"));
        finish(p, "settings:0");
        ctx.save();
      }
      p.message = `Created ad set "${name}"${op.status === "ACTIVE" ? " (on)" : " (paused)"}.`;
      return;
    }
    case "edit_adset": {
      const ids = await ctx.resolve("adset", op.adset);
      for (const id of ids) {
        if (isFinished(p, `item:${id}`)) continue;
        const cur = await getAdSet(client, id);
        ctx.remember(p, id, adsetBefore(op, cur));
        const spec = await resolveAudienceRefs(op, ctx);
        await client.post(id, adsetParams(spec, currency, { current: cur, forCreate: false }));
        finish(p, `item:${id}`);
        ctx.save();
      }
      p.ids = ids;
      p.message = `Updated ${ids.length > 1 ? `${ids.length} ad sets` : `the ad set${op.name ? ` (now "${op.name}")` : ""}`}.`;
      return;
    }
    case "duplicate_adset": {
      const srcId = oneOf(await ctx.resolve("adset", op.adset), op.adset, "adset", "duplicate_adset");
      const src = await getAdSet(client, srcId);
      const targetId = op.campaign ? oneOf(await ctx.resolve("campaign", op.campaign), op.campaign, "campaign", "duplicate_adset") : src.campaign_id;
      const target = await getCampaign(client, targetId);
      const cbo = isCbo(target);
      const count = copiesOf(op);
      const srcAds = op.with_ads ? await adSetAds(client, srcId) : [];
      const budgetWords = cbo && Number(target.daily_budget) ? ` its ${money(fromMinor(target.daily_budget, currency), currency)} a day` : " its budget";
      const minWhy = `the minimum daily spends of the ad sets in "${target.name}" would add up to more than${budgetWords}`;
      const fell = (k: string, why: string) => {
        p.fallbacks = { ...(p.fallbacks ?? {}), [k]: why };
        ctx.save();
      };
      for (let j = 0; j < count; j++) {
        if (j > 0 && !p.ids[j] && ctx.cancelled()) throw new StepStopped(copiesStopped(op, j, count));
        const ch = op.changes?.[j] ?? {};
        const daily = cbo ? null : ch.daily_budget ?? fromMinor(src.daily_budget, currency);
        const name = ch.name ?? nameFor(ch.name_template ?? op.name_template, `${src.name} - copy ${j + 1}`, { n: j + 1, persona: ch.persona ?? op.persona, angle: ch.angle, campaign: target.name, budget: daily ?? ch.lifetime_budget ?? fromMinor(src.lifetime_budget, currency), adset: src.name, date });
        const { id, made } = await createOnce(p, j, ctx, () => findCopy(client, `${act}/adsets`, mark(j + 1)), async () => {
          try {
            return await copyOne(client, srcId, { campaign_id: targetId, rename_options: { rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` ${mark(j + 1)}` } }, key(j));
          } catch (e) {
            // Meta refuses copies whose spend limits or budget don't fit the target campaign
            // (e.g. 1885648: minimum spends above a campaign budget). Built from the original's settings
            // without its spend limits, with the copy's own budget (an ad set from a campaign-budget
            // campaign has none). Remembered, so the message says so also after a retry.
            if (!(e instanceof MetaError) || e.code !== 100) throw e;
            fell(`rebuilt:${j}`, e.subcode === 1885648 ? minWhy : plainError(e, "Copying it"));
            const extra = cbo
              ? {}
              : {
                  daily_budget: ch.daily_budget !== undefined ? toMinor(ch.daily_budget, currency) : undefined,
                  lifetime_budget: ch.lifetime_budget !== undefined ? toMinor(ch.lifetime_budget, currency) : undefined,
                  end_time: ch.end_time,
                  bid_strategy: ch.bid_strategy,
                };
            return (await client.post<{ id: string }>(`${act}/adsets`, adsetCloneParams(src, targetId, `${name} ${mark(j + 1)}`, cbo, extra), { idempotencyKey: key(`${j}:rebuild`) })).id;
          }
        });
        if (!isFinished(p, `item:${j}`)) {
          // As for campaign copies: the status always; the budget again for a copy made before a change.
          const budget = !made && p.changed?.length && !cbo
            ? { daily_budget: ch.daily_budget ?? (ch.lifetime_budget === undefined ? fromMinor(src.daily_budget, currency) || undefined : undefined), lifetime_budget: ch.lifetime_budget ?? (ch.daily_budget === undefined ? fromMinor(src.lifetime_budget, currency) || undefined : undefined) }
            : {};
          const spec = { ...ch, ...budget, name, status: ch.status ?? "PAUSED", ...(cbo ? { daily_budget: undefined, lifetime_budget: undefined } : {}) };
          const withAudiences = await resolveAudienceRefs(spec, ctx);
          const params = adsetParams(withAudiences, currency, { current: src, forCreate: false });
          try {
            await client.post(id, params);
          } catch (e) {
            // The minimum daily spend asked for this copy makes the campaign's minimums add up to more than
            // its budget (100/1885648): the copy is finished in this run without it (it keeps the minimum
            // it has), never left half made.
            if (!(e instanceof MetaError) || e.subcode !== 1885648 || params.daily_min_spend_target === undefined) throw e;
            fell(`min:${j}`, minWhy);
            const { daily_min_spend_target: _asked, ...rest } = params;
            await client.post(id, rest);
          }
          finish(p, `item:${j}`);
          ctx.save();
        }
        for (const ad of srcAds) {
          const adKey = `${j + 1}/${ad.id}`;
          const newAd = await createSub(p, adKey, ctx, () => findCopy(client, `${act}/ads`, mark(adKey)), () => copyOne(client, ad.id, { adset_id: id, rename_options: { rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` ${mark(adKey)}` } }, key(adKey)));
          if (!isFinished(p, `sub:${adKey}`)) {
            await client.post(newAd, { name: ad.name });
            finish(p, `sub:${adKey}`);
            ctx.save();
          }
        }
      }
      p.message = `Made ${count} cop${count === 1 ? "y" : "ies"} of "${src.name}" in "${target.name}"${srcAds.length ? `, each with its ${srcAds.length} ad${srcAds.length === 1 ? "" : "s"}` : ""}.${await copyLimitsNote(client, op, p, count, src, currency)}`;
      return;
    }
    case "ads_from_post": {
      const targets: string[] = [];
      for (const s of op.adsets) targets.push(...(await ctx.resolve("adset", s)));
      const body = postCreative(op);
      // One creative (sub "creative"); one ad per ad set (ids, in ad set order). A creative of the same
      // post is the same post, so taking an earlier one is harmless.
      const creativeId = await createSub(p, "creative", ctx, () => findByName(client, `${act}/adcreatives`, String(body.name), null), async () =>
        (await client.post<{ id: string }>(`${act}/adcreatives`, body, { idempotencyKey: key("creative") })).id,
      );
      // Each item belongs to its ad set (a retry that changes the ad sets keeps the ad of an ad set it still uses).
      p.targets = [...targets];
      ctx.save();
      const setNames = await adsetNames(client, targets, op.name_template);
      for (let j = 0; j < targets.length; j++) {
        const name = nameFor(op.name_template, op.name ?? `Post ${op.post_id}`, { n: j + 1, adset: setNames.get(targets[j]), date });
        const { id, made } = await createOnce(p, j, ctx, (since, was) => findByName(client, `${targets[j]}/ads`, was ?? name, since), async () =>
          (await client.post<{ id: string }>(`${act}/ads`, { name, adset_id: targets[j], creative: { creative_id: creativeId }, status: op.status ?? "PAUSED" }, { idempotencyKey: key(j) })).id,
        name);
        // An ad made before the step was changed gets the new name and status (on → paused too).
        if (!made && p.changed?.length && !isFinished(p, `settings:${j}`)) {
          await client.post(id, { name, status: op.status ?? "PAUSED" });
          finish(p, `settings:${j}`);
          ctx.save();
        }
      }
      p.message = `Created ${targets.length} ad${targets.length === 1 ? "" : "s"} from post ${op.post_id}, all sharing one creative.`;
      return;
    }
    case "copy_ad": {
      const adId = oneOf(await ctx.resolve("ad", op.ad), op.ad, "ad", "copy_ad");
      const src = await readAd(client, adId);
      // The new ad uses the original ad's creative: the same post, so likes, comments and shares add up on it.
      const creativeId = src.creative?.id;
      const targets: string[] = [];
      for (const s of op.adsets) targets.push(...(await ctx.resolve("adset", s)));
      p.targets = [...targets];
      ctx.save();
      const setNames = await adsetNames(client, targets, op.name_template);
      for (let j = 0; j < targets.length; j++) {
        const name = nameFor(op.name_template, op.name ?? src.name, { n: j + 1, adset: setNames.get(targets[j]), date });
        const newPost = () => p.fallbacks?.[`newpost:${j}`];
        // A lost answer: looked up by the name it was sent with (made after the attempt started), then by the
        // mark a copy made by Meta (a new creative, or an earlier version of the launcher) carries.
        const { id, made } = await createOnce(p, j, ctx, async (since, was) => (was && !was.startsWith("[P:") ? await findByName(client, `${targets[j]}/ads`, was, since) : null) ?? (await findCopy(client, `${act}/ads`, mark(j + 1))), async () => {
          if (creativeId && !newPost()) {
            try {
              return (await client.post<{ id: string }>(`${act}/ads`, { name, adset_id: targets[j], creative: { creative_id: creativeId }, status: op.status ?? "PAUSED" }, { idempotencyKey: key(`${j}:ad`) })).id;
            } catch (e) {
              // Only a clear "no" from Meta about this ad makes a new creative. A lost answer, a limit, a
              // lost login or a passing error stop the step (looked up or tried again; never made twice).
              if (!(e instanceof MetaError) || e.unknownOutcome || e.isTransient || mustSurface(e) || isAccessError(e)) throw e;
              p.fallbacks = { ...(p.fallbacks ?? {}), [`newpost:${j}`]: plainError(e, "Using the same creative") };
              ctx.save();
            }
          } else if (!newPost()) {
            p.fallbacks = { ...(p.fallbacks ?? {}), [`newpost:${j}`]: "Meta gave no creative for the original ad" };
            ctx.save();
          }
          // Meta's own copy of the ad: it makes a new creative (a new post).
          return copyOne(client, adId, { adset_id: targets[j], rename_options: { rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` ${mark(j + 1)}` } }, key(j));
        }, name);
        if (!isFinished(p, `item:${j}`)) {
          // Made now on the same creative: name and status were sent with it. Otherwise (Meta's copy, found
          // after a lost answer, or made before the step was changed) they are sent now; a copy changed from
          // ON to paused on a retry is turned off again.
          if (!made || newPost()) await client.post(id, { name, status: op.status ?? "PAUSED" });
          finish(p, `item:${j}`);
          ctx.save();
        }
      }
      const fresh = targets.map((t, j) => ({ t, j, why: p.fallbacks?.[`newpost:${j}`] })).filter((x) => x.why && p.ids[x.j]);
      const n = targets.length;
      if (!fresh.length) p.message = `Copied "${src.name}" into ${n} ad set${n === 1 ? "" : "s"}, on the same creative: the same post, so likes, comments and shares add up on it.`;
      else {
        const same = n - fresh.length;
        p.message = `Copied "${src.name}" into ${n} ad set${n === 1 ? "" : "s"}. ${same ? `${same} on the same creative (the same post). ` : ""}${fresh.length === 1 ? "1 copy got" : `${fresh.length} copies got`} a NEW creative, so a new post whose likes and comments start from zero, because Meta refused the original's creative there: ${fresh.map((x) => `ad set ${setNames.get(x.t) ? `"${setNames.get(x.t)}"` : x.t} (${x.why})`).join("; ")}.`;
      }
      return;
    }
    case "edit_ad": {
      const ids = await ctx.resolve("ad", op.ad);
      const msgs: string[] = [];
      for (const [j, id] of ids.entries()) {
        // Ads this step already finished are not edited again (a second new creative would send them back to review).
        if (isFinished(p, `ad:${id}`) || (!p.finished && p.ids[j] === id)) continue;
        const opts = { mark: mark(j + 1), currency, accountDbId: ctx.accountDbId, clock: ctx.clock, driveFile: ctx.driveFile, remember: (v: Record<string, unknown>) => ctx.remember(p, id, v) };
        try {
          msgs.push(await editAd(client, id, op, { ...opts, key: key(j) }));
        } catch (e) {
          // 1349016: the step was changed and retried, so its idempotency key was used with other texts.
          if (!(e instanceof MetaError) || e.subcode !== 1349016) throw e;
          msgs.push(await editAd(client, id, op, { ...opts, key: key(`${j}:${Date.now()}`) }));
        }
        p.ids[j] = id;
        finish(p, `ad:${id}`);
        ctx.save();
      }
      p.ids = ids;
      p.message = ids.length > 1 ? `Updated ${ids.length} ads.` : msgs[0] ?? "Updated the ad.";
      return;
    }
    case "create_custom_audience":
    case "create_lookalike": {
      const resolved = await resolveAudienceOp(op, ctx);
      const { id, made } = await createOnce(p, 0, ctx, (since, was) => findByName(client, `${act}/customaudiences`, was ?? resolved.name, since, "time_created"), () => createAudience(client, resolved, key(0)), resolved.name);
      if (!made && (p.changed ?? []).some((k) => k === "name" || k === "description") && !isFinished(p, "settings:0")) {
        await client.post(id, { name: resolved.name, ...(resolved.type === "create_custom_audience" && resolved.description !== undefined ? { description: resolved.description } : {}) });
        finish(p, "settings:0");
        ctx.save();
      }
      if (resolved.type === "create_custom_audience" && resolved.source?.kind === "customer_list") {
        // The list goes up in parts, each one marked when Meta took it: a retry sends only what is missing.
        const { schema, parts } = customerChunks(resolved.source);
        for (const [k, rows] of parts.entries()) {
          if (p.sub?.[`users_${k}`]) continue;
          const got = await uploadCustomerChunk(client, id, schema, rows);
          p.sub = { ...(p.sub ?? {}), [`users_${k}`]: String(got) };
          ctx.save();
        }
      }
      p.message = `Created audience "${resolved.name}". Meta fills it over the next hours.`;
      return;
    }
    case "set_status": {
      const on = op.status === "ACTIVE";
      const campaigns: string[] = [];
      const adsets: string[] = [];
      const ads: string[] = [];
      for (const s of op.campaigns ?? []) campaigns.push(...(await ctx.resolve("campaign", s)));
      for (const s of op.adsets ?? []) adsets.push(...(await ctx.resolve("adset", s)));
      for (const s of op.ads ?? []) ads.push(...(await ctx.resolve("ad", s)));
      // Whole campaigns turned ON: only the ad sets and ads the confirmed check counted, and what this plan
      // made. An ad set or ad added after the check (a launch, Ads Manager) is left as it is, and so is one
      // a retry stopped using (it stays paused, as the summary said).
      const { made, never } = ctx.planItems();
      const counted = on && ctx.wholeIds ? new Set([...ctx.wholeIds, ...made]) : null;
      const allowed = (id: string) => !(on && never.has(id)) && (!counted || counted.has(id));
      let leftSets = 0;
      let leftAds = 0;
      for (const s of op.whole_campaigns ?? []) {
        for (const c of await ctx.resolve("campaign", s)) {
          campaigns.push(c);
          for (const a of await campaignAdSets(client, c)) {
            const setOk = allowed(a.id);
            if (setOk) adsets.push(a.id);
            else leftSets++;
            for (const ad of await adSetAds(client, a.id)) {
              if (setOk && allowed(ad.id)) ads.push(ad.id);
              else leftAds++;
            }
          }
        }
      }
      // On: ads first, campaign last, so nothing starts until everything is on. Off: the reverse.
      const kindOf = new Map<string, string>([...ads.map((x) => [x, "ad"] as const), ...adsets.map((x) => [x, "adset"] as const), ...campaigns.map((x) => [x, "campaign"] as const)]);
      const order = on ? [...ads, ...adsets, ...campaigns] : [...campaigns, ...adsets, ...ads];
      const doneSet = new Set(p.ids);
      // Every status read before the loop, one account-level read per kind for each 100 IDs (not one
      // read per item); an ID that read doesn't return is read on its own.
      const statusOf = new Map<string, string | undefined>();
      for (const [edge, list] of [["ads", ads], ["adsets", adsets], ["campaigns", campaigns]] as const) {
        const want = [...new Set(list.filter((id) => !doneSet.has(id)))];
        for (let k = 0; k < want.length; k += 100) {
          const part = want.slice(k, k + 100);
          const rows = await client.getAll<{ id: string; status?: string }>(`${act}/${edge}`, { fields: "id,status", filtering: [{ field: "id", operator: "IN", value: part }], limit: 100 }, part.length + 10).catch(surfaceOr([] as { id: string; status?: string }[]));
          for (const r of rows) if (part.includes(r.id)) statusOf.set(r.id, r.status);
        }
      }
      for (const id of order) {
        if (doneSet.has(id)) continue;
        // A cancel stops the step at once. Turning on goes ads → ad sets → campaigns, so a stop before
        // the campaign leaves it off and nothing spends; what was already turned on stays on.
        if (ctx.cancelled()) {
          const left = order.filter((x) => !doneSet.has(x));
          const leftCampaigns = left.filter((x) => kindOf.get(x) === "campaign" && statusOf.get(x) !== "ACTIVE").length;
          // Every campaign of the step still off: what was turned on can't spend.
          const noneOn = campaigns.length > 0 && campaigns.every((c) => !doneSet.has(c) && statusOf.get(c) !== "ACTIVE");
          throw new StepStopped(`Stopped because the plan was cancelled: ${doneSet.size} of ${order.length} item${order.length === 1 ? "" : "s"} turned ${on ? "on" : "off"} (they stay ${on ? "on" : "off"}); the other ${left.length} ${left.length === 1 ? "was" : "were"} not changed${on && leftCampaigns ? `, so ${leftCampaigns === 1 ? "the campaign stays" : "the campaigns stay"} off${noneOn ? " and nothing spends" : ""}` : ""}. Nothing after this step ran.`);
        }
        const cur = statusOf.has(id) ? { status: statusOf.get(id) } : await client.get<{ status?: string }>(id, { fields: "status" }).catch(surfaceOr({ status: undefined as string | undefined }));
        ctx.remember(p, id, { status: cur.status, kind: kindOf.get(id) });
        try {
          if (cur.status !== op.status) await client.post(id, { status: op.status });
        } catch (e) {
          // Turning off something deleted (or archived) in Ads Manager since the check: it can't spend,
          // so there is nothing to turn off. Anything else stops the step.
          if (on || !(await goneFromMeta(client, id, e))) throw e;
          finish(p, `gone:${id}`);
        }
        p.ids.push(id);
        doneSet.add(id);
        ctx.save();
      }
      const gone = (p.finished ?? []).filter((k) => k.startsWith("gone:")).map((k) => k.slice(5));
      const count = (list: string[]) => list.filter((x) => !gone.includes(x)).length;
      const nc = count(campaigns);
      const na = count(adsets);
      const nd = count(ads);
      const left = [leftSets ? `${leftSets} ad set${leftSets === 1 ? "" : "s"}` : "", leftAds ? `${leftAds} ad${leftAds === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
      p.message = `Turned ${on ? "on" : "off"} ${nc} campaign${nc === 1 ? "" : "s"}, ${na} ad set${na === 1 ? "" : "s"} and ${nd} ad${nd === 1 ? "" : "s"}.${
        gone.length ? ` ${gone.length} ${gone.length === 1 ? "item was" : "items were"} no longer in Meta (deleted or archived), so there was nothing to turn off: ${gone.slice(0, 5).join(", ")}${gone.length > 5 ? "…" : ""}.` : ""}${
        left ? ` Left as ${leftSets + leftAds === 1 ? "it is" : "they are"} (not in the total that was confirmed): ${left} in the campaign that the plan's check didn't count (added after the check, or no longer used by this plan).` : ""}`;
      return;
    }
  }
}

/**
 * What a copy step's copies have, when spend limits are involved: read back from Meta (one read for each
 * 100 copies), so the message says exactly what was built, also after a retry. Copies with the same
 * outcome are said together. Empty when no spend limit is involved.
 */
async function copyLimitsNote(client: MetaClient, op: Extract<Op, { type: "duplicate_adset" }>, p: PlanProgress, count: number, src: AdSetRow, currency: string): Promise<string> {
  const fb = p.fallbacks ?? {};
  const asked = (j: number) => op.changes?.[j]?.min_daily_spend !== undefined || op.changes?.[j]?.max_daily_spend !== undefined;
  const involved = Number(src.daily_min_spend_target) || Number(src.daily_spend_cap) || Object.keys(fb).some((k) => /^(rebuilt|min):/.test(k)) || Array.from({ length: count }, (_, j) => asked(j)).some(Boolean);
  if (!involved) return "";
  const ids = p.ids.slice(0, count).filter(Boolean);
  const limits = new Map<string, { min: number; max: number }>();
  for (let k = 0; k < ids.length; k += 100) {
    const part = ids.slice(k, k + 100);
    const rows = await client.getAll<{ id: string; daily_min_spend_target?: string; daily_spend_cap?: string }>(`${client.accountId}/adsets`, { fields: "id,daily_min_spend_target,daily_spend_cap", filtering: [{ field: "id", operator: "IN", value: part }], limit: 100 }, part.length + 10).catch(surfaceOr([] as { id: string }[]));
    for (const r of rows as { id: string; daily_min_spend_target?: string; daily_spend_cap?: string }[]) limits.set(r.id, { min: fromMinor(r.daily_min_spend_target, currency) || 0, max: fromMinor(r.daily_spend_cap, currency) || 0 });
  }
  const m = (v: number) => money(v, currency);
  const groups = new Map<string, number[]>();
  for (let j = 0; j < count; j++) {
    const id = p.ids[j];
    if (!id) continue;
    const l = limits.get(id);
    const has = !l ? "its spend limits could not be read back" : l.min || l.max ? `it has ${[l.min ? `a minimum daily spend of ${m(l.min)}` : "no minimum daily spend", l.max ? `a maximum of ${m(l.max)} a day` : ""].filter(Boolean).join(" and ")}` : "it has no spend limits";
    const what = [
      fb[`rebuilt:${j}`] ? `Meta refused the copy as it is (${fb[`rebuilt:${j}`]}), so it was built from the original's settings without its spend limits` : "",
      fb[`min:${j}`] ? `Meta refused the minimum daily spend of ${m(Number(op.changes?.[j]?.min_daily_spend))} asked for it (${fb[`min:${j}`]}), so that minimum was left out` : "",
    ].filter(Boolean).join("; then ");
    const key = `${what ? `${what}; ` : ""}${has}`;
    groups.set(key, [...(groups.get(key) ?? []), j + 1]);
  }
  const nums = (list: number[]) => (list.length === 1 ? `Copy ${list[0]}` : `Copies ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);
  return [...groups.entries()].map(([k, list]) => ` ${nums(list)}: ${list.length > 1 ? k.replace(/\bit has\b/g, "each has").replace(/\bit was\b/g, "each was").replace(/\basked for it\b/g, "asked for each") : k}.`).join("");
}

/** The names of these ad sets, read only when the name template uses {adset} (one read for each 100). */
async function adsetNames(client: MetaClient, ids: string[], template: string | undefined): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!template || !/(?<!\{)\{adset(?::[^{}]+)?\}(?!\})/i.test(template)) return out;
  const want = [...new Set(ids)];
  for (let k = 0; k < want.length; k += 100) {
    const part = want.slice(k, k + 100);
    const rows = await client.getAll<{ id: string; name: string }>(`${client.accountId}/adsets`, { fields: "id,name", filtering: [{ field: "id", operator: "IN", value: part }], limit: 100 }, part.length + 10);
    for (const r of rows) out.set(r.id, r.name);
  }
  // An ad set this read didn't return is read on its own (a name template must not get an empty name).
  for (const id of want) if (!out.has(id)) out.set(id, (await getAdSet(client, id)).name);
  return out;
}

/** Custom audience IDs given as "$ref" (made earlier in the plan) become real IDs. */
async function resolveAudienceRefs<T extends AdSetSpec>(spec: T, ctx: OpCtx): Promise<T> {
  const fix = async (list?: (string | { id: string; name?: string })[]) => {
    if (!list) return list;
    const out: { id: string }[] = [];
    for (const x of list) {
      const id = typeof x === "string" ? x : x.id;
      for (const r of await ctx.resolve("audience", id)) out.push({ id: r });
    }
    return out;
  };
  return { ...spec, custom_audiences: await fix(spec.custom_audiences), excluded_custom_audiences: await fix(spec.excluded_custom_audiences) };
}

async function resolveAudienceOp(op: AudienceOp, ctx: OpCtx): Promise<AudienceOp> {
  if (op.type === "create_lookalike" && isRef(op.source_audience)) return { ...op, source_audience: oneOf(await ctx.resolve("audience", op.source_audience), op.source_audience, "audience", "create_lookalike") };
  return op;
}

/** A budget period as Meta keeps it on a campaign: times in ms, the raise in the account currency
 *  (null when it is not a fixed amount: a multiple of the budget can't be counted), and whether it is gone. */
export interface MetaPeriod { s: number; e: number; amount: number | null; type: string; gone: boolean }

/** A time Meta sends as Unix seconds (number or digits) or as text ("2026-11-20T09:00:00+0530"). */
function periodTime(v: unknown): number {
  if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v))) {
    const n = Number(v);
    return n > 1e12 ? n : n * 1000;
  }
  return timeMs(typeof v === "string" ? v : undefined);
}

/** More budget periods than this on one campaign (old ones included) are not read: the check stops. */
const MAX_PERIODS = 1000;

/**
 * The budget periods Meta has on a campaign (GET {campaign}/budget_schedules, 100 a page). Periods that
 * ended, were deleted or cancelled are marked gone; any other status counts. A start Meta doesn't give in
 * a form the launcher reads counts as "already started" (never left out); an unreadable end as "no end".
 * More than MAX_PERIODS: refused (the ones still to come might not all be read).
 */
export async function readPeriods(client: MetaClient, campaignId: string, currency: string): Promise<MetaPeriod[]> {
  const rows = await client.getAll<{ id?: string; budget_value?: string | number; budget_value_type?: string; time_start?: string | number; time_end?: string | number; status?: string }>(`${campaignId}/budget_schedules`, { fields: "id,budget_value,budget_value_type,time_start,time_end,status", limit: 100 }, MAX_PERIODS);
  if (rows.length >= MAX_PERIODS) throw new Error(`the campaign has ${MAX_PERIODS} or more budget periods in Meta (old ones included), too many to read them all, so the launcher can't be sure it counts the ones still to come. Use another campaign, or change this one in Ads Manager`);
  return rows.map((r) => {
    const type = String(r.budget_value_type ?? "").toUpperCase();
    const s = periodTime(r.time_start);
    const e = periodTime(r.time_end);
    const status = String(r.status ?? "").toUpperCase();
    const amount = type === "ABSOLUTE" && r.budget_value !== undefined && r.budget_value !== "" ? fromMinor(String(r.budget_value), currency) : null;
    return { s: Number.isNaN(s) ? Number.NEGATIVE_INFINITY : s, e: Number.isNaN(e) ? Number.POSITIVE_INFINITY : e, amount, type, gone: /DELETED|CANCEL|EXPIRED/.test(status) };
  });
}

/** A budget period's start or end in words: a time Meta didn't give reads "now" (start) or "no end". */
function periodAt(ms: number): string {
  if (Number.isFinite(ms)) return istLabel(new Date(ms).toISOString());
  return ms < 0 ? "now (Meta gave no start time)" : "no end";
}

/**
 * Budget scheduling: raise a campaign budget for set periods (Meta's high-demand periods). Always sent as
 * a fixed amount (ABSOLUTE, in the currency's minor units): a percent is worked out from the daily budget
 * here, so what Meta adds is exactly what the summary showed. Each period is marked once Meta took it,
 * with the amount Meta added. When the answer to a send was lost, the campaign's periods are read first:
 * one with the same times and amount is the one sent; when they can't be read, the step stops (the
 * period is never sent a second time on a guess).
 */
async function addBudgetSchedules(client: MetaClient, campaignId: string, list: NonNullable<CampaignSpec["budget_schedules"]>, currency: string, daily: number | null, p: PlanProgress, ctx: OpCtx) {
  for (const [k, b] of list.entries()) {
    // Marked by the period itself, so a changed list (kept across a retry) never sends one twice.
    // `schedule:<k>` is the older mark by place, kept for runs that started before this change.
    const mk = periodMark(b);
    if (isFinished(p, mk) || (!p.changed?.length && isFinished(p, `schedule:${k}`))) continue;
    const inc = scheduleIncrease(b, daily);
    if (inc === null || !(inc > 0)) throw new Error(`budget period ${k + 1}: a raise in percent needs the campaign's daily budget, and this campaign has none (Meta's budget scheduling works with daily campaign budgets only).`);
    const s = Math.floor(timeMs(b.start) / 1000) * 1000;
    const e = Math.floor(timeMs(b.end) / 1000) * 1000;
    const took = () => {
      finish(p, mk);
      p.periods = { ...(p.periods ?? {}), [mk]: { campaign: campaignId, s, e, amount: inc } };
      p.attempted = (p.attempted ?? []).filter((x) => x !== mk);
      ctx.save();
    };
    if (p.attempted?.includes(mk)) {
      // Sent before, and Meta's answer never came: Meta may have it already.
      let inMeta: MetaPeriod[];
      try {
        inMeta = await readPeriods(client, campaignId, currency);
      } catch (e2) {
        if (mustSurface(e2) || (e2 as { fatal?: boolean }).fatal) throw e2;
        throw new Error(`budget period ${k + 1} (${istLabel(b.start)} to ${istLabel(b.end)}, +${money(inc, currency)} a day) was sent to Meta before, but Meta's answer never came, and the launcher couldn't read the campaign's budget periods to see if Meta has it (${e2 instanceof MetaError ? plainError(e2, "Reading the budget periods") : String(e2)}). It was not sent again, so it is never added twice. Check the campaign's budget periods in Ads Manager: if it is there, take it out of this step; if not, press Retry.`);
      }
      if (inMeta.some((x) => !x.gone && Math.abs(x.s - s) < 60_000 && Math.abs(x.e - e) < 60_000 && x.amount !== null && Math.abs(x.amount - inc) < 0.5)) {
        took();
        continue;
      }
    }
    p.attempted = [...(p.attempted ?? []).filter((x) => x !== mk), mk];
    ctx.save();
    try {
      await client.post(`${campaignId}/budget_schedules`, {
        budget_value: toMinor(inc, currency),
        budget_value_type: "ABSOLUTE",
        time_start: s / 1000,
        time_end: e / 1000,
      });
    } catch (e2) {
      // A clear "no" from Meta: it did not take the period (only a lost answer leaves the doubt).
      if (e2 instanceof MetaError && !e2.unknownOutcome) {
        p.attempted = (p.attempted ?? []).filter((x) => x !== mk);
        ctx.save();
      }
      throw e2;
    }
    took();
  }
}

export type { AdSetSpec, CampaignSpec, CampaignRow };

type SimilarRow = { id: string; objective?: string; daily_budget?: string; lifetime_budget?: string; special_ad_categories?: string[] };

/** The ad account's campaigns (up to 200), read once per check, to find one like a campaign the plan makes. */
function campaignsForCheck(client: MetaClient): Promise<SimilarRow[]> {
  return client
    .getAll<SimilarRow>(`${client.accountId}/campaigns`, { fields: "id,objective,daily_budget,lifetime_budget,special_ad_categories", effective_status: ["ACTIVE", "PAUSED"] }, 200)
    .catch(surfaceOr([] as SimilarRow[]));
}

/** An existing campaign with this objective, budget type and special ad category, to let Meta check a new ad set's settings early. */
function similarCampaign(list: SimilarRow[], objective: string | undefined, cbo: boolean, special: string[]): string | null {
  if (!objective) return null;
  const same = (a: string[] | undefined) => canon([...(a ?? [])].filter((x) => x && x !== "NONE").sort()) === canon([...special].sort());
  return list.find((x) => x.objective === objective && isCbo(x) === cbo && same(x.special_ad_categories))?.id ?? null;
}

/**
 * IDs the steps name directly, by kind, to read together before the steps are checked. Campaigns and ad
 * sets only when they look like Meta IDs (digits; anything else may be a name). `adsTurnedOn`: ads whose
 * ad sets are needed too (their budgets count in what can spend).
 */
function idsToRead(ops: Op[]): { campaign: string[]; adset: string[]; ad: string[]; adsTurnedOn: string[]; adsetCampaigns: string[] } {
  const out = { campaign: [] as string[], adset: [] as string[], ad: [] as string[], adsTurnedOn: [] as string[], adsetCampaigns: [] as string[] };
  const metaId = (s: unknown) => typeof s === "string" && /^\d+$/.test(s.trim());
  const add = (kind: "campaign" | "adset", list: unknown, withCampaign = false) => {
    for (const s of Array.isArray(list) ? list : [list]) {
      if (!metaId(s)) continue;
      out[kind].push(String(s).trim());
      if (kind === "adset" && withCampaign) out.adsetCampaigns.push(String(s).trim());
    }
  };
  const ads = (list: unknown, on: boolean) => {
    for (const s of Array.isArray(list) ? list : [list]) {
      if (typeof s !== "string" || !s.trim() || isRef(s.trim())) continue;
      out.ad.push(s.trim());
      if (on) out.adsTurnedOn.push(s.trim());
    }
  };
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    const o = op as unknown as Record<string, unknown>;
    switch (op.type) {
      case "edit_campaign":
      case "duplicate_campaign": add("campaign", o.campaign); break;
      case "create_adset": add("campaign", o.campaign); break;
      case "edit_adset": add("adset", o.adset, true); break;
      case "duplicate_adset": add("adset", o.adset, true); add("campaign", o.campaign); break;
      case "ads_from_post": add("adset", o.adsets, o.status === "ACTIVE"); break;
      case "copy_ad": add("adset", o.adsets, o.status === "ACTIVE"); break;
      case "edit_ad": ads(o.ad, o.status === "ACTIVE"); break;
      case "set_status":
        add("campaign", o.campaigns);
        add("campaign", o.whole_campaigns);
        add("adset", o.adsets, o.status === "ACTIVE");
        ads(o.ads, o.status === "ACTIVE");
        break;
      default: break;
    }
  }
  return out;
}

/** The largest budget-period raise at any moment from `from` on (periods that overlap add up). */
function maxRaise(raises: Raise[], from: number): number {
  const live = raises.filter((r) => r.e > from);
  let best = 0;
  for (const r of live) {
    const at = Math.max(r.s, from);
    best = Math.max(best, live.filter((x) => x.s <= at && at < x.e).reduce((t, x) => t + x.amount, 0));
  }
  return best;
}
