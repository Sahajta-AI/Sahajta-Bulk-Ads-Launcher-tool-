import type { MetaClient } from "../meta/client";
import { cacheGet, cacheSet } from "../store";
import { attributionSpec, BID_STRATEGIES, DESTINATIONS, fromMinor, GOALS, label, money, OBJECTIVES, PIXEL_EVENTS, toMinor } from "./options";

// Campaigns and ad sets: read them, turn plain settings into Meta's fields, and describe them
// in plain words for the pre-launch summary.

export const CAMPAIGN_FIELDS = "id,name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy,spend_cap,special_ad_categories,buying_type,start_time,stop_time";
export const ADSET_FIELDS =
  "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,bid_strategy,bid_amount,billing_event,optimization_goal,destination_type,promoted_object,targeting,start_time,end_time,attribution_spec,daily_min_spend_target,daily_spend_cap,lifetime_min_spend_target,lifetime_spend_cap,is_dynamic_creative";

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
    if (spec.regions) geo.regions = ids(spec.regions, "key").map((r) => ({ key: r.key }));
    else delete geo.regions;
    if (spec.cities) {
      geo.cities = (ids(spec.cities, "key") as { key: string; radius?: number; distance_unit?: string }[]).map((c) => (c.radius ? { key: c.key, radius: Number(c.radius), distance_unit: c.distance_unit ?? "kilometer" } : { key: c.key }));
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
  if (spec.targeting) Object.assign(t, structuredClone(spec.targeting));
  return t;
}

const AUDIENCE_KEYS: (keyof AdSetSpec)[] = ["saved_audience_id", "countries", "regions", "cities", "age_min", "age_max", "genders", "interests", "custom_audiences", "excluded_custom_audiences", "advantage_audience", "placements", "targeting"];
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
  if (touchesAudience(spec) || opts.forCreate) p.targeting = buildTargeting(spec, cur?.targeting ?? {}, opts.savedAudience);
  if (spec.attribution) p.attribution_spec = attributionSpec(spec.attribution);
  if (spec.min_daily_spend !== undefined) p.daily_min_spend_target = toMinor(spec.min_daily_spend, currency);
  if (spec.max_daily_spend !== undefined) p.daily_spend_cap = toMinor(spec.max_daily_spend, currency);
  if (opts.forCreate) p.status = spec.status ?? "PAUSED";
  else if (spec.status) p.status = spec.status;
  return p;
}

/** Fields to rebuild an ad set from scratch from an existing one (copy without the spend limits). */
export function adsetCloneParams(src: AdSetRow, campaignId: string, name: string, cboCampaign: boolean): Record<string, unknown> {
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
  if (Number(src.lifetime_budget) && !p.end_time) p.end_time = new Date(Date.now() + 7 * 86_400_000).toISOString();
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
  parts.push(`Advantage+ audience ${t.targeting_automation?.advantage_audience ? "on" : "off"}`);
  const pl = t.publisher_platforms?.length
    ? [t.publisher_platforms.join(" + "), ...["facebook_positions", "instagram_positions"].filter((k) => (t[k] as string[] | undefined)?.length).map((k) => `${k.split("_")[0]}: ${(t[k] as string[]).join(", ")}`)].join("; ")
    : "Advantage+ placements (all)";
  return { audience: parts.join(" · "), placements: pl };
}

export function describeAdSet(a: Partial<AdSetRow>, currency: string): Record<string, string> {
  const daily = fromMinor(a.daily_budget, currency);
  const life = fromMinor(a.lifetime_budget, currency);
  const t = describeTargeting(a.targeting);
  const po = a.promoted_object ?? {};
  const event = po.custom_event_type ? label(PIXEL_EVENTS, String(po.custom_event_type)) : po.custom_conversion_id ? `custom conversion ${String(po.custom_conversion_id)}` : "";
  return {
    budget: daily ? `${money(daily, currency)} a day` : life ? `${money(life, currency)} lifetime` : "campaign budget",
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

export function istTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} IST`;
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
    default:
      throw new Error(`Unknown list "${what}". Use one of: saved_audiences, custom_audiences, pixels, custom_conversions, interests, locations, pages.`);
  }
}
