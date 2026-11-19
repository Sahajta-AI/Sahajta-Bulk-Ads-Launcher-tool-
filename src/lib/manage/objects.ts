import type { MetaClient } from "../meta/client";
import { mustSurface } from "../meta/errors";
import { cacheGet, cacheSet } from "../store";
import { istLabel, zonedTime } from "../time";
import { attributionSpec, BID_STRATEGIES, DESTINATIONS, fromMinor, GOALS, label, money, OBJECTIVES, PIXEL_EVENTS, toMinor } from "./options";

// Campaigns and ad sets: read them, turn plain settings into Meta's fields, and describe them
// in plain words for the pre-launch summary.

export const CAMPAIGN_FIELDS = "id,name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy,spend_cap,special_ad_categories,buying_type,start_time,stop_time";
export const ADSET_FIELDS =
  "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,bid_strategy,bid_amount,billing_event,optimization_goal,destination_type,promoted_object,targeting,start_time,end_time,attribution_spec,daily_min_spend_target,daily_spend_cap,lifetime_min_spend_target,lifetime_spend_cap,is_dynamic_creative,adset_schedule,frequency_control_specs,pacing_type";

export interface CampaignRow {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  spend_cap?: string;
  special_ad_categories?: string[];
  start_time?: string;
  stop_time?: string;
}

export interface AdSetRow {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  campaign_id: string;
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  bid_amount?: string;
  billing_event?: string;
  optimization_goal?: string;
  destination_type?: string;
  promoted_object?: Record<string, unknown>;
  targeting?: Targeting;
  start_time?: string;
  end_time?: string;
  attribution_spec?: { event_type: string; window_days: number }[];
  daily_min_spend_target?: string;
  daily_spend_cap?: string;
  lifetime_min_spend_target?: string;
  lifetime_spend_cap?: string;
  is_dynamic_creative?: boolean;
  /** Hours it runs (dayparting): minutes after midnight and days (0 = Sunday). */
  adset_schedule?: { start_minute: number; end_minute: number; days: number[] }[];
  pacing_type?: string[];
  frequency_control_specs?: { event: string; interval_days: number; max_frequency: number }[];
  /** Only in rows built from a plan's settings (Meta doesn't return it). */
  brand_safety_content_filter_levels?: string[];
}

export type Targeting = Record<string, unknown> & {
  geo_locations?: { countries?: string[]; regions?: { key: string; name?: string }[]; cities?: { key: string; name?: string; radius?: number; distance_unit?: string }[]; location_types?: string[] };
  excluded_geo_locations?: Record<string, unknown>;
  age_min?: number;
  age_max?: number;
  genders?: number[];
  flexible_spec?: { interests?: { id: string; name?: string }[]; [k: string]: unknown }[];
  custom_audiences?: { id: string; name?: string }[];
  excluded_custom_audiences?: { id: string; name?: string }[];
  targeting_automation?: { advantage_audience?: number };
  publisher_platforms?: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
  messenger_positions?: string[];
  audience_network_positions?: string[];
  threads_positions?: string[];
  device_platforms?: string[];
  locales?: number[];
  excluded_publisher_list_ids?: string[];
};

/** An ad set as people describe it. Money is in the account's currency (rupees), not paise. */
export interface AdSetSpec {
  name?: string;
  /** Naming template for this ad set, e.g. "{date}_{persona}_{budget}_{n}". Used when name is empty. */
  name_template?: string;
  daily_budget?: number;
  lifetime_budget?: number;
  start_time?: string;
  end_time?: string;
  destination?: string;
  goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  bid_amount?: number;
  roas_average_floor?: number;
  pixel_id?: string;
  event?: string;
  custom_event_str?: string;
  custom_conversion_id?: string;
  page_id?: string;
  app_id?: string;
  app_store_url?: string;
  whatsapp_number?: string;
  saved_audience_id?: string;
  countries?: string[];
  regions?: (string | { key: string; name?: string })[];
  cities?: (string | { key: string; name?: string; radius?: number; distance_unit?: string })[];
  age_min?: number;
  age_max?: number;
  genders?: "all" | "men" | "women";
  interests?: (string | { id: string; name?: string })[];
  custom_audiences?: (string | { id: string; name?: string })[];
  excluded_custom_audiences?: (string | { id: string; name?: string })[];
  advantage_audience?: boolean;
  /** "advantage" (Meta picks) or a list of positions per platform. */
  placements?: "advantage" | { platforms?: string[]; facebook_positions?: string[]; instagram_positions?: string[]; messenger_positions?: string[]; audience_network_positions?: string[]; threads_positions?: string[] };
  /** Raw Meta targeting, merged last (for anything the fields above don't cover). */
  targeting?: Record<string, unknown>;
  attribution?: string;
  min_daily_spend?: number;
  max_daily_spend?: number;
  status?: "PAUSED" | "ACTIVE";
  persona?: string;
  angle?: string;
  /** Run only at set hours (dayparting). Needs a lifetime budget. Times in the ad account's time zone. */
  schedule?: { days: number[]; start: string; end: string }[];
  /** Reach goal only: at most `impressions` per person every `days` days. */
  frequency_cap?: { impressions: number; days: number };
  /** Brand safety: how strict the inventory filter is on Facebook and Audience Network. */
  inventory_filter?: "expanded" | "moderate" | "limited";
  /** Brand safety: IDs of block lists (publisher lists) to keep the ads away from. */
  block_list_ids?: string[];
  /** Language (locale) IDs; lookup languages lists them. */
  languages?: number[];
  /** Detailed targeting expansion. Meta now always applies it (the field was removed in 2026); kept so a request for it gets a plain answer. */
  targeting_expansion?: boolean;
  /** A Dynamic creative ad set (Meta mixes the files and texts of its one ad). */
  dynamic_creative?: boolean;
  /** Put this exact targeting back (used by "Undo this plan"). */
  replace_targeting?: Record<string, unknown>;
}

export interface CampaignSpec {
  name?: string;
  name_template?: string;
  objective?: string;
  /** "campaign" = Advantage campaign budget (CBO); "adset" = each ad set has its own budget (ABO). */
  budget_level?: "campaign" | "adset";
  daily_budget?: number;
  lifetime_budget?: number;
  bid_strategy?: string;
  special_ad_categories?: string[];
  special_ad_category_country?: string[];
  spend_cap?: number;
  start_time?: string;
  stop_time?: string;
  status?: "PAUSED" | "ACTIVE";
  persona?: string;
  angle?: string;
  /** Raise the campaign budget for set periods (campaign budget only). */
  budget_schedules?: { start: string; end: string; increase_percent?: number; increase_amount?: number }[];
}

const ids = (list: (string | { id?: string; key?: string })[] | undefined, k: "id" | "key" = "id") =>
  (list ?? []).map((x) => (typeof x === "string" ? { [k]: x } : x)) as { id: string; key: string; name?: string }[];

/** The ad account's currency and time zone (cached for a day). */
export async function accountInfo(client: MetaClient): Promise<{ currency: string; timezone: string; name: string }> {
  const key = `acctinfo:${client.accountId}`;
  const hit = cacheGet<{ currency: string; timezone: string; name: string }>(key);
  if (hit) return hit;
  const r = await client.get<{ currency?: string; timezone_name?: string; name?: string }>(client.accountId, { fields: "currency,timezone_name,name" });
  const out = { currency: r.currency ?? "INR", timezone: r.timezone_name ?? "Asia/Kolkata", name: r.name ?? client.accountId };
  cacheSet(key, out, 86_400_000);
  return out;
}

export async function getCampaign(client: MetaClient, id: string): Promise<CampaignRow> {
  return client.get<CampaignRow>(id, { fields: CAMPAIGN_FIELDS });
}

export async function getAdSet(client: MetaClient, id: string): Promise<AdSetRow> {
  return client.get<AdSetRow>(id, { fields: ADSET_FIELDS });
}

export async function campaignAdSets(client: MetaClient, campaignId: string): Promise<AdSetRow[]> {
  return client.getAll<AdSetRow>(`${campaignId}/adsets`, { fields: ADSET_FIELDS, effective_status: ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "IN_PROCESS", "WITH_ISSUES", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "ADSET_PAUSED"] });
}

export async function adSetAds(client: MetaClient, adsetId: string): Promise<{ id: string; name: string; status: string; effective_status?: string }[]> {
  return client.getAll(`${adsetId}/ads`, { fields: "id,name,status,effective_status", effective_status: ["ACTIVE", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "PENDING_REVIEW", "IN_PROCESS", "WITH_ISSUES", "PREAPPROVED", "DISAPPROVED", "PENDING_BILLING_INFO"] });
}

/** Campaign budget (CBO) when the campaign itself has a budget. */
export const isCbo = (c: Pick<CampaignRow, "daily_budget" | "lifetime_budget">) => !!(Number(c.daily_budget) || Number(c.lifetime_budget));

// ---------- Spec → Meta fields ----------

/** Meta fields for a campaign create or edit. */
export function campaignParams(spec: CampaignSpec, currency: string, forCreate: boolean): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (spec.name) p.name = spec.name;
  if (spec.objective) p.objective = spec.objective;
  if (spec.daily_budget !== undefined) p.daily_budget = toMinor(spec.daily_budget, currency);
  if (spec.lifetime_budget !== undefined) p.lifetime_budget = toMinor(spec.lifetime_budget, currency);
  if (spec.bid_strategy) p.bid_strategy = spec.bid_strategy;
  if (spec.spend_cap !== undefined) p.spend_cap = toMinor(spec.spend_cap, currency);
  if (spec.start_time) p.start_time = spec.start_time;
  if (spec.stop_time) p.stop_time = spec.stop_time;
  if (forCreate) {
    const cats = (spec.special_ad_categories ?? []).filter((c) => c && c !== "NONE");
    p.special_ad_categories = cats;
    if (cats.length && spec.special_ad_category_country?.length) p.special_ad_category_country = spec.special_ad_category_country;
    // ABO campaigns have no budget; Meta then asks whether ad sets may share up to 20% of budget.
    if (spec.budget_level !== "campaign" && spec.daily_budget === undefined && spec.lifetime_budget === undefined) p.is_adset_budget_sharing_enabled = false;
    p.status = spec.status ?? "PAUSED";
  } else if (spec.status) p.status = spec.status;
  return p;
}

/** Full targeting from the spec, starting from `base` (the current targeting when editing). */
export function buildTargeting(spec: AdSetSpec, base: Targeting = {}, savedAudience?: Targeting): Targeting {
  const t: Targeting = structuredClone(savedAudience ?? base);
  const geo = { ...(t.geo_locations ?? {}) };
  if (spec.countries || spec.regions || spec.cities) {
    if (spec.countries) geo.countries = spec.countries.map((c) => c.toUpperCase());
    else delete geo.countries;
    // The name picked in the lookup is kept, so the summary says "Maharashtra", not "region 1728"
    // (Meta returns the same {key, name} when it reads targeting, and takes it back as it is).
    if (spec.regions) geo.regions = ids(spec.regions, "key").map((r) => ({ key: r.key, ...(r.name ? { name: r.name } : {}) }));
    else delete geo.regions;
    if (spec.cities) {
      geo.cities = (ids(spec.cities, "key") as { key: string; name?: string; radius?: number; distance_unit?: string }[]).map((c) => ({ key: c.key, ...(c.name ? { name: c.name } : {}), ...(c.radius ? { radius: Number(c.radius), distance_unit: c.distance_unit ?? "kilometer" } : {}) }));
    }
    else delete geo.cities;
    t.geo_locations = geo;
  }
  if (!t.geo_locations) t.geo_locations = { countries: ["IN"] };
  if (spec.age_min !== undefined) t.age_min = spec.age_min;
  if (spec.age_max !== undefined) t.age_max = spec.age_max;
  if (spec.genders) {
    if (spec.genders === "all") delete t.genders;
    else t.genders = [spec.genders === "men" ? 1 : 2];
  }
  if (spec.interests) {
    const rest = (t.flexible_spec ?? []).map((f) => { const { interests: _i, ...o } = f; return o; }).filter((f) => Object.keys(f).length);
    t.flexible_spec = spec.interests.length ? [{ ...(rest[0] ?? {}), interests: ids(spec.interests).map((i) => ({ id: i.id, ...(i.name ? { name: i.name } : {}) })) }, ...rest.slice(1)] : rest;
    if (!t.flexible_spec.length) delete t.flexible_spec;
  }
  if (spec.custom_audiences) t.custom_audiences = ids(spec.custom_audiences).map((a) => ({ id: a.id }));
  if (spec.excluded_custom_audiences) t.excluded_custom_audiences = ids(spec.excluded_custom_audiences).map((a) => ({ id: a.id }));
  if (spec.advantage_audience !== undefined) t.targeting_automation = { ...(t.targeting_automation ?? {}), advantage_audience: spec.advantage_audience ? 1 : 0 };
  if (t.targeting_automation?.advantage_audience === undefined) t.targeting_automation = { ...(t.targeting_automation ?? {}), advantage_audience: 0 };
  if (spec.placements) {
    for (const k of ["publisher_platforms", "facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions", "threads_positions", "device_platforms"]) delete t[k];
    if (spec.placements !== "advantage") {
      const pl = spec.placements;
      if (pl.platforms?.length) t.publisher_platforms = pl.platforms;
      for (const k of ["facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions", "threads_positions"] as const) if (pl[k]?.length) t[k] = pl[k];
    }
  }
  if (spec.languages) {
    if (spec.languages.length) t.locales = spec.languages;
    else delete t.locales;
  }
  // Meta removed targeting_optimization (100/1870197, checked 18 Nov 2026): Advantage detailed
  // targeting now always applies, so targeting_expansion is never sent; the plan check says so.
  delete t.targeting_optimization;
  if (spec.block_list_ids) t.excluded_publisher_list_ids = spec.block_list_ids;
  if (spec.targeting) Object.assign(t, structuredClone(spec.targeting));
  return t;
}

const AUDIENCE_KEYS: (keyof AdSetSpec)[] = ["saved_audience_id", "countries", "regions", "cities", "age_min", "age_max", "genders", "interests", "custom_audiences", "excluded_custom_audiences", "advantage_audience", "placements", "targeting", "languages", "block_list_ids"];

const FILTER_LEVELS: Record<string, string[]> = {
  expanded: ["FACEBOOK_RELAXED", "AN_RELAXED"],
  moderate: ["FACEBOOK_STANDARD", "AN_STANDARD"],
  limited: ["FACEBOOK_STRICT", "AN_STRICT"],
};

/** "09:30" → minutes after midnight. */
const minutes = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`"${hhmm}" is not a time like 09:30.`);
  return Number(m[1]) * 60 + Number(m[2]);
};
export const touchesAudience = (spec: AdSetSpec) => AUDIENCE_KEYS.some((k) => spec[k] !== undefined);

/** Meta fields for an ad set create (with campaign_id) or edit. `current` is the ad set being edited or copied. */
export function adsetParams(spec: AdSetSpec, currency: string, opts: { current?: AdSetRow; savedAudience?: Targeting; forCreate: boolean }): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const cur = opts.current;
  if (spec.name) p.name = spec.name;
  if (spec.daily_budget !== undefined) p.daily_budget = toMinor(spec.daily_budget, currency);
  if (spec.lifetime_budget !== undefined) p.lifetime_budget = toMinor(spec.lifetime_budget, currency);
  if (spec.start_time) p.start_time = spec.start_time;
  if (spec.end_time) p.end_time = spec.end_time;
  if (spec.destination) p.destination_type = spec.destination;
  if (spec.goal) p.optimization_goal = spec.goal;
  if (spec.billing_event) p.billing_event = spec.billing_event;
  else if (opts.forCreate) p.billing_event = "IMPRESSIONS";
  if (spec.bid_strategy) p.bid_strategy = spec.bid_strategy;
  if (spec.bid_amount !== undefined) p.bid_amount = toMinor(spec.bid_amount, currency);
  if (spec.roas_average_floor !== undefined) p.bid_constraints = { roas_average_floor: Math.round(spec.roas_average_floor * 10000) };
  const po: Record<string, unknown> = { ...(cur?.promoted_object ?? {}) };
  let poChanged = false;
  const setPo = (k: string, v: unknown) => { if (v !== undefined && v !== "") { po[k] = v; poChanged = true; } };
  setPo("pixel_id", spec.pixel_id);
  setPo("custom_event_type", spec.event);
  setPo("custom_event_str", spec.custom_event_str);
  setPo("custom_conversion_id", spec.custom_conversion_id);
  setPo("page_id", spec.page_id);
  setPo("application_id", spec.app_id);
  setPo("object_store_url", spec.app_store_url);
  setPo("whatsapp_phone_number", spec.whatsapp_number);
  if (poChanged || (opts.forCreate && Object.keys(po).length)) p.promoted_object = po;
  if (spec.replace_targeting) p.targeting = spec.replace_targeting;
  else if (touchesAudience(spec) || opts.forCreate) p.targeting = buildTargeting(spec, cur?.targeting ?? {}, opts.savedAudience);
  if (spec.attribution) p.attribution_spec = attributionSpec(spec.attribution);
  if (spec.schedule?.length) {
    p.pacing_type = ["day_parting"];
    p.adset_schedule = spec.schedule.map((w) => ({ start_minute: minutes(w.start), end_minute: minutes(w.end), days: w.days }));
  }
  if (spec.frequency_cap) p.frequency_control_specs = [{ event: "IMPRESSIONS", interval_days: spec.frequency_cap.days, max_frequency: spec.frequency_cap.impressions }];
  if (spec.inventory_filter) p.brand_safety_content_filter_levels = FILTER_LEVELS[spec.inventory_filter] ?? FILTER_LEVELS.moderate;
  if (spec.dynamic_creative !== undefined && opts.forCreate) p.is_dynamic_creative = spec.dynamic_creative;
  if (spec.min_daily_spend !== undefined) p.daily_min_spend_target = toMinor(spec.min_daily_spend, currency);
  if (spec.max_daily_spend !== undefined) p.daily_spend_cap = toMinor(spec.max_daily_spend, currency);
  if (opts.forCreate) p.status = spec.status ?? "PAUSED";
  else if (spec.status) p.status = spec.status;
  return p;
}

/** Fields to rebuild an ad set from scratch from an existing one (copy without the spend limits). */
/** `extra` (plans): the copy's own budget (minor units), end time and a bid strategy when the original has none,
 *  e.g. an ad set from a campaign-budget campaign copied into a campaign without campaign budget. */
export function adsetCloneParams(src: AdSetRow, campaignId: string, name: string, cboCampaign: boolean, extra: { daily_budget?: number; lifetime_budget?: number; end_time?: string; bid_strategy?: string } = {}): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name,
    campaign_id: campaignId,
    status: "PAUSED",
    billing_event: src.billing_event ?? "IMPRESSIONS",
    optimization_goal: src.optimization_goal,
    targeting: src.targeting,
  };
  if (src.destination_type) p.destination_type = src.destination_type;
  if (src.promoted_object) p.promoted_object = src.promoted_object;
  if (src.attribution_spec) p.attribution_spec = src.attribution_spec;
  if (src.bid_strategy) p.bid_strategy = src.bid_strategy;
  if (src.bid_amount) p.bid_amount = Number(src.bid_amount);
  if (!cboCampaign) {
    if (Number(src.daily_budget)) p.daily_budget = Number(src.daily_budget);
    if (Number(src.lifetime_budget)) p.lifetime_budget = Number(src.lifetime_budget);
  }
  if (src.end_time && Date.parse(src.end_time) > Date.now()) p.end_time = src.end_time;
  if (src.start_time && Date.parse(src.start_time) > Date.now()) p.start_time = src.start_time;
  if (!cboCampaign) {
    if (extra.daily_budget) { p.daily_budget = extra.daily_budget; delete p.lifetime_budget; }
    if (extra.lifetime_budget) { p.lifetime_budget = extra.lifetime_budget; delete p.daily_budget; }
    if (!p.bid_strategy) p.bid_strategy = extra.bid_strategy ?? "LOWEST_COST_WITHOUT_CAP";
  }
  if (extra.end_time) p.end_time = extra.end_time;
  if (Number(p.lifetime_budget) && src.adset_schedule?.length) {
    p.pacing_type = src.pacing_type ?? ["day_parting"];
    p.adset_schedule = src.adset_schedule;
  }
  if (src.frequency_control_specs?.length) p.frequency_control_specs = src.frequency_control_specs;
  if (Number(p.lifetime_budget) && !p.end_time) p.end_time = new Date(Date.now() + 7 * 86_400_000).toISOString();
  return p;
}

// ---------- Plain words ----------

export function describeTargeting(t: Targeting | undefined): { audience: string; placements: string } {
  if (!t) return { audience: "Not set", placements: "Advantage+ placements" };
  const g = t.geo_locations ?? {};
  const where = [
    ...(g.countries ?? []),
    ...(g.regions ?? []).map((r) => r.name ?? `region ${r.key}`),
    ...(g.cities ?? []).map((c) => `${c.name ?? `city ${c.key}`}${c.radius ? ` +${c.radius} ${c.distance_unit === "mile" ? "mi" : "km"}` : ""}`),
  ];
  const parts = [where.length ? where.join(", ") : "No location"];
  parts.push(`age ${t.age_min ?? 18}–${t.age_max ?? 65}`);
  parts.push(!t.genders?.length ? "all genders" : t.genders.includes(1) ? "men" : "women");
  const interests = (t.flexible_spec ?? []).flatMap((f) => f.interests ?? []);
  if (interests.length) parts.push(`interests: ${interests.slice(0, 6).map((i) => i.name ?? i.id).join(", ")}${interests.length > 6 ? ` +${interests.length - 6}` : ""}`);
  if (t.custom_audiences?.length) parts.push(`${t.custom_audiences.length} custom/lookalike audience${t.custom_audiences.length > 1 ? "s" : ""}: ${t.custom_audiences.map((a) => a.name ?? a.id).join(", ")}`);
  if (t.excluded_custom_audiences?.length) parts.push(`excluding ${t.excluded_custom_audiences.map((a) => a.name ?? a.id).join(", ")}`);
  if (t.locales?.length) parts.push(`language${t.locales.length > 1 ? "s" : ""} ${t.locales.join(", ")}`);
  parts.push(`Advantage+ audience ${t.targeting_automation?.advantage_audience ? "on" : "off"}`);
  const pl = t.publisher_platforms?.length
    ? [t.publisher_platforms.join(" + "), ...["facebook_positions", "instagram_positions"].filter((k) => (t[k] as string[] | undefined)?.length).map((k) => `${k.split("_")[0]}: ${(t[k] as string[]).join(", ")}`)].join("; ")
    : "Advantage+ placements (all)";
  return { audience: parts.join(" · "), placements: pl };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const FILTER_WORDS: Record<string, string> = { RELAXED: "expanded inventory", STANDARD: "moderate inventory", STRICT: "limited inventory" };

/** The extra ad set settings in plain words (only those that are set): hours, attribution, languages,
 *  brand safety, Dynamic creative and frequency cap. */
export function adsetExtras(a: Partial<AdSetRow>): Record<string, string> {
  const out: Record<string, string> = {};
  if (a.adset_schedule?.length) {
    out.hours = `runs only ${a.adset_schedule.map((w) => `${(w.days ?? []).map((d) => DAY_NAMES[d] ?? d).join(", ")} ${hhmm(w.start_minute)}–${hhmm(w.end_minute)}`).join("; ")} (ad account time)`;
  }
  if (a.attribution_spec?.length) {
    const by = Object.fromEntries(a.attribution_spec.map((x) => [x.event_type, x.window_days]));
    out.attribution = [by.CLICK_THROUGH ? `${by.CLICK_THROUGH}-day click` : "", by.VIEW_THROUGH ? `${by.VIEW_THROUGH}-day view` : "", by.ENGAGED_VIDEO_VIEW ? `${by.ENGAGED_VIDEO_VIEW}-day engaged view` : ""].filter(Boolean).join(" or ") + " attribution";
  }
  const t = a.targeting;
  if (t?.locales?.length) out.languages = `language IDs ${t.locales.join(", ")}`;
  const safety: string[] = [];
  const level = a.brand_safety_content_filter_levels?.[0]?.split("_")[1];
  if (level) safety.push(FILTER_WORDS[level] ?? level.toLowerCase());
  if (t?.excluded_publisher_list_ids?.length) safety.push(`${t.excluded_publisher_list_ids.length} block list${t.excluded_publisher_list_ids.length > 1 ? "s" : ""} (${t.excluded_publisher_list_ids.join(", ")})`);
  if (safety.length) out.brandSafety = `brand safety: ${safety.join(", ")}`;
  if (a.is_dynamic_creative) out.dynamicCreative = "Dynamic creative on";
  const f = a.frequency_control_specs?.[0];
  if (f) out.frequencyCap = `frequency cap ${f.max_frequency} per ${f.interval_days} day${f.interval_days > 1 ? "s" : ""}`;
  return out;
}

/**
 * An ad set's spend limits (Meta's daily_min_spend_target / daily_spend_cap and the lifetime ones) in plain
 * words in the account's currency, e.g. "minimum ₹100 a day, maximum ₹500 a day"; "" when it has none.
 */
export function spendLimitsText(a: Partial<AdSetRow>, currency: string): string {
  const amount = (v: string | undefined) => {
    const n = fromMinor(v, currency);
    return n ? money(n, currency) : "";
  };
  const pair = (min: string, max: string, per: string) => (min || max ? `${min ? `minimum ${min} ${per}` : "no minimum"}, ${max ? `maximum ${max} ${per}` : "no maximum"}` : "");
  return [pair(amount(a.daily_min_spend_target), amount(a.daily_spend_cap), "a day"), pair(amount(a.lifetime_min_spend_target), amount(a.lifetime_spend_cap), "lifetime")].filter(Boolean).join("; ");
}

export function describeAdSet(a: Partial<AdSetRow>, currency: string): Record<string, string> {
  const daily = fromMinor(a.daily_budget, currency);
  const life = fromMinor(a.lifetime_budget, currency);
  const t = describeTargeting(a.targeting);
  const po = a.promoted_object ?? {};
  const event = po.custom_event_type ? label(PIXEL_EVENTS, String(po.custom_event_type)) : po.custom_conversion_id ? `custom conversion ${String(po.custom_conversion_id)}` : "";
  const limits = spendLimitsText(a, currency);
  return {
    ...adsetExtras(a),
    budget: daily ? `${money(daily, currency)} a day` : life ? `${money(life, currency)} lifetime` : "campaign budget",
    // Only when set: the ad set's minimum and maximum spend.
    ...(limits ? { spendLimits: limits } : {}),
    bid: `${label(BID_STRATEGIES, a.bid_strategy) || "Highest volume"}${a.bid_amount ? ` at ${money(fromMinor(a.bid_amount, currency), currency)}` : ""}`,
    schedule: `${a.start_time ? `from ${istTime(a.start_time)}` : "starts when turned on"}${a.end_time ? ` until ${istTime(a.end_time)}` : ", no end date"}`,
    goal: [label(DESTINATIONS, a.destination_type), label(GOALS, a.optimization_goal), event].filter(Boolean).join(" → ") || "not set",
    audience: t.audience,
    placements: t.placements,
    status: a.status ?? "PAUSED",
  };
}

export function describeCampaign(c: Partial<CampaignRow>, currency: string): Record<string, string> {
  const daily = fromMinor(c.daily_budget, currency);
  const life = fromMinor(c.lifetime_budget, currency);
  return {
    objective: label(OBJECTIVES, c.objective),
    budget: daily ? `${money(daily, currency)} a day (campaign budget)` : life ? `${money(life, currency)} lifetime (campaign budget)` : "set on each ad set",
    bid: label(BID_STRATEGIES, c.bid_strategy) || (daily || life ? "Highest volume" : "set on each ad set"),
    spendCap: c.spend_cap ? money(fromMinor(c.spend_cap, currency), currency) : "none",
    specialCategories: c.special_ad_categories?.length ? c.special_ad_categories.join(", ") : "none",
    status: c.status ?? "PAUSED",
  };
}

/** A time in India time. A time written without a zone is India time (the server runs in UTC). */
export function istTime(iso: string): string {
  return istLabel(zonedTime(iso) ?? iso);
}

// ---------- Lookups for audiences and goals ----------

export async function lookups(client: MetaClient, what: string, q?: string): Promise<unknown[]> {
  const act = client.accountId;
  switch (what) {
    case "saved_audiences":
      return client.getAll(`${act}/saved_audiences`, { fields: "id,name,description,targeting" });
    case "custom_audiences":
      return client.getAll(`${act}/customaudiences`, { fields: "id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound" });
    case "pixels":
      return client.getAll(`${act}/adspixels`, { fields: "id,name,last_fired_time" });
    case "custom_conversions":
      return client.getAll(`${act}/customconversions`, { fields: "id,name,custom_event_type,rule" });
    case "interests":
      return (await client.get<{ data: unknown[] }>("search", { type: "adinterest", q: q ?? "", limit: 25 })).data;
    case "locations":
      return (await client.get<{ data: unknown[] }>("search", { type: "adgeolocation", q: q ?? "", location_types: ["country", "region", "city"], limit: 25 })).data;
    case "pages":
      return client.getAll(`${act}/promote_pages`, { fields: "id,name" });
    case "posts":
      return listPosts(client, q);
    case "lead_forms":
      return listLeadForms(client, q);
    case "languages":
      return (await client.get<{ data: unknown[] }>("search", { type: "adlocale", q: q ?? "", limit: 25 })).data;
    case "block_lists":
      return client.getAll(`${act}/publisher_block_lists`, { fields: "id,name" }).catch(surfaceOr([]));
    default:
      throw new Error(`Unknown list "${what}". Use one of: saved_audiences, custom_audiences, pixels, custom_conversions, interests, locations, languages, block_lists, pages, posts, lead_forms.`);
  }
}

/** A `.catch` for reads with a fallback: Meta limiting calls or a lost login is never hidden behind the fallback. */
export function surfaceOr<T>(fallback: T): (e: unknown) => T {
  return (e: unknown) => {
    if (mustSurface(e)) throw e;
    return fallback;
  };
}

/** A Page token for Page-only reads (posts, lead forms). Asked from Meta each time; never stored. */
async function pageClient(client: MetaClient, pageId: string): Promise<MetaClient> {
  const r = await client.get<{ access_token?: string }>(pageId, { fields: "access_token" });
  if (!r.access_token) throw new Error("Meta did not give a Page token: the connected Facebook login must be able to manage this Page.");
  return client.withToken(r.access_token);
}

/**
 * Posts to reuse with "ads from a post": the Page's recent posts, and the posts behind the account's
 * ads (Facebook post ID and Instagram media ID). `q` = a Page ID to list that Page's posts, or text to
 * search in the post text or ad name.
 */
export async function listPosts(client: MetaClient, q?: string): Promise<unknown[]> {
  const out: Record<string, unknown>[] = [];
  const pageId = q && /^\d+$/.test(q) ? q : undefined;
  const text = pageId ? "" : (q ?? "").toLowerCase();
  const pages = pageId ? [{ id: pageId }] : await client.getAll<{ id: string; name: string }>(`${client.accountId}/promote_pages`, { fields: "id,name" }, 10).catch(surfaceOr([] as { id: string; name: string }[]));
  for (const pg of pages.slice(0, 5)) {
    try {
      const pc = await pageClient(client, pg.id);
      const posts = await pc.get<{ data: { id: string; message?: string; created_time?: string; permalink_url?: string; is_eligible_for_promotion?: boolean }[] }>(`${pg.id}/published_posts`, { fields: "id,message,created_time,permalink_url,is_eligible_for_promotion", limit: 25 });
      for (const p of posts.data) out.push({ source: "facebook_page", post_id: p.id, text: (p.message ?? "").slice(0, 120), created: p.created_time, link: p.permalink_url, can_promote: p.is_eligible_for_promotion ?? null });
    } catch (e) {
      if (mustSurface(e)) throw e;
      out.push({ source: "facebook_page", page_id: pg.id, problem: e instanceof Error ? e.message : String(e) });
    }
  }
  const ads = await client.getAll<{ id: string; name: string; creative?: { effective_object_story_id?: string; effective_instagram_media_id?: string } }>(`${client.accountId}/ads`, { fields: "id,name,creative{effective_object_story_id,effective_instagram_media_id}", effective_status: ["ACTIVE", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "PENDING_REVIEW", "WITH_ISSUES", "IN_PROCESS"] }, 300).catch(surfaceOr([] as { id: string; name: string; creative?: { effective_object_story_id?: string; effective_instagram_media_id?: string } }[]));
  const seen = new Set<string>();
  for (const a of ads) {
    const post = a.creative?.effective_object_story_id;
    const ig = a.creative?.effective_instagram_media_id;
    const k = `${post}|${ig}`;
    if ((!post && !ig) || seen.has(k)) continue;
    seen.add(k);
    out.push({ source: "ad", ad_name: a.name, ad_id: a.id, post_id: post ?? null, instagram_media_id: ig ?? null });
  }
  return text ? out.filter((x) => JSON.stringify(x).toLowerCase().includes(text)) : out;
}

/** Instant forms (lead forms) of the Page(s) the ad account can use. `q` = a Page ID. */
export async function listLeadForms(client: MetaClient, q?: string): Promise<unknown[]> {
  const pages = q && /^\d+$/.test(q) ? [{ id: q }] : await client.getAll<{ id: string }>(`${client.accountId}/promote_pages`, { fields: "id" }, 10).catch(surfaceOr([] as { id: string }[]));
  const out: unknown[] = [];
  for (const pg of pages.slice(0, 5)) {
    try {
      const pc = await pageClient(client, pg.id);
      const forms = await pc.getAll<{ id: string; name: string; status?: string; created_time?: string }>(`${pg.id}/leadgen_forms`, { fields: "id,name,status,created_time" }, 100);
      out.push(...forms.map((f) => ({ page_id: pg.id, ...f })));
    } catch (e) {
      if (mustSurface(e)) throw e;
      out.push({ page_id: pg.id, problem: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
