import type { MetaClient } from "../meta/client";
import { MetaError, mustSurface } from "../meta/errors";
import { feedbackLines, type Issue as FeedbackIssue } from "./feedback";

// After launch: is each ad set and ad delivering, and if not, why. Meta's review status,
// the learning phase, and the reasons Meta gives for anything not delivering.
//
// Reads go through the ad account's lists with a filter (ad sets whose id / campaign is in a list,
// ads whose id / ad set is in a list), one call per page of 100, instead of one call per object:
// on Meta's starter tier (about 300 calls an hour) a 20-ad batch costs 2 calls, not 40.

const LEARNING: Record<string, string> = { LEARNING: "learning", SUCCESS: "out of learning", FAIL: "learning limited" };

const STATUS: Record<string, string> = {
  ACTIVE: "delivering (on)",
  PAUSED: "off",
  ADSET_PAUSED: "not delivering: its ad set is off",
  CAMPAIGN_PAUSED: "not delivering: its campaign is off",
  PENDING_REVIEW: "in Meta review",
  IN_PROCESS: "being processed by Meta",
  DISAPPROVED: "rejected by Meta",
  PREAPPROVED: "pre-approved",
  PENDING_BILLING_INFO: "not delivering: payment details missing",
  WITH_ISSUES: "has issues",
  ARCHIVED: "archived",
  DELETED: "deleted",
};

/** Status of an ID Meta no longer lists for this ad account. */
export const NOT_FOUND = "NOT_FOUND";
const NOT_FOUND_TEXT = "not found in Meta (deleted, or not in this ad account)";

export interface DeliveryRow {
  /** "campaign" only for a campaign ID Meta doesn't have (status NOT_FOUND); campaigns are otherwise shown by their ad sets. */
  kind: "campaign" | "adset" | "ad";
  id: string;
  name: string;
  status: string;
  plain: string;
  learning: string | null;
  issues: string[];
  /** An ad whose ad set is not among the rows (an edited ad elsewhere): the ad set it is in. */
  inAdset?: { id: string; name: string };
}

type Issue = FeedbackIssue;
type AdSet = { id: string; name: string; campaign_id?: string; effective_status?: string; learning_stage_info?: { status?: string }; issues_info?: Issue[] };
type Ad = { id: string; name: string; adset_id: string; adset?: { name?: string }; effective_status?: string; issues_info?: Issue[]; ad_review_feedback?: Record<string, unknown> };

const ADSET_FIELDS = "id,name,campaign_id,effective_status,learning_stage_info,issues_info";
const AD_FIELDS = "id,name,adset_id,adset{name},effective_status,issues_info,ad_review_feedback";
/** Ads listed for an ad set or campaign: everything except archived and deleted ones. */
const LISTED_AD_STATUSES = ["ACTIVE", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "PENDING_REVIEW", "IN_PROCESS", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "WITH_ISSUES"];
/**
 * IDs asked for by ID: archived ones too, so they show as such. Not "DELETED": Meta refuses it in an
 * account-level list filter (code 100, subcode 1815001, checked on the real account 19 Nov 2026), so a
 * deleted ID is simply missing from the answer and shows as "not found".
 */
const ALL_AD_STATUSES = [...LISTED_AD_STATUSES, "ARCHIVED"];
const ALL_ADSET_STATUSES = ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "IN_PROCESS", "WITH_ISSUES", "ARCHIVED"];
/** IDs per filter (Meta's IN lists stay short; more IDs = more calls). */
const CHUNK = 50;

const chunks = <T,>(list: T[], n: number) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const uniq = (list?: string[]) => [...new Set((list ?? []).map((x) => String(x).trim()).filter(Boolean))];

/** Meta's text of an error (its own message when it gave one). */
const metaText = (e: MetaError) => `${e.body?.message ?? ""} ${e.message}`;

/**
 * Meta says the object does not exist (deleted, or not visible to this login): code 100 with
 * subcode 33, or that message. Only this makes an ID "not found"; any other code-100 answer (a field
 * Meta doesn't know, a bad parameter) is a real error and is shown as one.
 */
export const isMissing = (e: unknown) => e instanceof MetaError && !mustSurface(e) && (e.subcode === 33 || /does not exist/i.test(metaText(e)));

/** Meta refused the filter itself (code 100 naming the filtering): read one object at a time instead. */
const filterRefused = (e: unknown) => e instanceof MetaError && !mustSurface(e) && e.code === 100 && !isMissing(e) && /filter/i.test(metaText(e));

/**
 * Objects of one kind whose `field` is in `values`, read from the ad account's list in pages.
 * Returns null when Meta refuses the filter (the caller then reads one by one).
 */
async function listWhere<T>(client: MetaClient, edge: "campaigns" | "adsets" | "ads", field: "id" | "adset.id" | "campaign.id", values: string[], fields: string, statuses?: string[]): Promise<T[] | null> {
  const out: T[] = [];
  for (const part of chunks(values, CHUNK)) {
    try {
      out.push(...(await client.getAll<T>(`${client.accountId}/${edge}`, { fields, filtering: [{ field, operator: "IN", value: part }], ...(statuses ? { effective_status: statuses } : {}), limit: 100 }, 5000)));
    } catch (e) {
      if (filterRefused(e)) return null;
      throw e;
    }
  }
  return out;
}

/**
 * One read per item (only when Meta refused the filter); an item Meta says does not exist is left
 * out. The first other error stops the reads and is thrown (rate limits, lost logins, bad fields).
 */
async function readEach<T>(ids: string[], read: (id: string) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (const id of ids) {
    try {
      out.push(...(await read(id)));
    } catch (e) {
      if (isMissing(e)) continue;
      throw e;
    }
  }
  return out;
}

async function adSetsOf(client: MetaClient, campaigns: string[]): Promise<AdSet[]> {
  return (await listWhere<AdSet>(client, "adsets", "campaign.id", campaigns, ADSET_FIELDS)) ?? readEach(campaigns, (c) => client.getAll<AdSet>(`${c}/adsets`, { fields: ADSET_FIELDS }));
}

/** The campaigns of these IDs that Meta has (deleted ones count as gone). */
async function campaignsThere(client: MetaClient, ids: string[]): Promise<Set<string>> {
  const found = (await listWhere<{ id: string }>(client, "campaigns", "id", ids, "id")) ?? (await readEach(ids, async (id) => [await client.get<{ id: string }>(id, { fields: "id" })]));
  return new Set(found.map((c) => c.id));
}

async function adSetsById(client: MetaClient, ids: string[]): Promise<AdSet[]> {
  return (await listWhere<AdSet>(client, "adsets", "id", ids, ADSET_FIELDS, ALL_ADSET_STATUSES)) ?? readEach(ids, async (id) => [await client.get<AdSet>(id, { fields: ADSET_FIELDS })]);
}

async function adsOf(client: MetaClient, adsets: string[]): Promise<Ad[]> {
  return (await listWhere<Ad>(client, "ads", "adset.id", adsets, AD_FIELDS, LISTED_AD_STATUSES)) ?? readEach(adsets, (a) => client.getAll<Ad>(`${a}/ads`, { fields: AD_FIELDS, effective_status: LISTED_AD_STATUSES }));
}

async function adsById(client: MetaClient, ids: string[]): Promise<Ad[]> {
  return (await listWhere<Ad>(client, "ads", "id", ids, AD_FIELDS, ALL_AD_STATUSES)) ?? readEach(ids, async (id) => [await client.get<Ad>(id, { fields: AD_FIELDS })]);
}

const plainOf = (st: string) => STATUS[st] ?? st.toLowerCase();

function adSetRow(a: AdSet): DeliveryRow {
  const st = a.effective_status ?? "";
  const l = a.learning_stage_info?.status;
  return { kind: "adset", id: a.id, name: a.name, status: st, plain: plainOf(st), learning: l ? LEARNING[l] ?? l.toLowerCase() : null, issues: feedbackLines(a) };
}

function adRow(ad: Ad): DeliveryRow {
  const st = ad.effective_status ?? "";
  return { kind: "ad", id: ad.id, name: ad.name, status: st, plain: plainOf(st), learning: null, issues: feedbackLines(ad) };
}

const missingRow = (kind: DeliveryRow["kind"], id: string): DeliveryRow => ({ kind, id, name: "", status: NOT_FOUND, plain: NOT_FOUND_TEXT, learning: null, issues: [] });

/**
 * Delivery of the given ad sets and ads (IDs), or of everything in the given campaigns.
 * Each ad set is followed by its ads. An ID Meta no longer has stays as a row ("not found in Meta"),
 * campaigns too; a campaign that is there but has no ad sets gives no row.
 * `unknown`: IDs whose kind isn't known (older plan steps): looked for among the ad sets, then the
 * ads (one list read each); one that is neither (a campaign, or gone) is left out.
 * Rate limits and a lost Meta login are thrown, never shown as an empty table.
 */
export async function deliveryStatus(client: MetaClient, q: { campaigns?: string[]; adsets?: string[]; ads?: string[]; unknown?: string[] }): Promise<DeliveryRow[]> {
  const campaigns = uniq(q.campaigns);
  const askedSets = uniq(q.adsets);
  const askedAds = uniq(q.ads);
  const unknown = uniq(q.unknown).filter((id) => !campaigns.includes(id) && !askedSets.includes(id) && !askedAds.includes(id));

  const sets = new Map<string, AdSet>();
  if (campaigns.length) for (const a of await adSetsOf(client, campaigns)) sets.set(a.id, a);
  // A campaign with no ad set found: is it there at all? (One more read, only for those.)
  const bare = campaigns.filter((c) => ![...sets.values()].some((a) => a.campaign_id === c));
  const goneCampaigns = bare.length ? await campaignsThere(client, bare).then((there) => bare.filter((c) => !there.has(c))) : [];
  const setIds = askedSets.filter((id) => !sets.has(id));
  if (setIds.length) for (const a of await adSetsById(client, setIds)) sets.set(a.id, a);
  // No one-by-one reads for these: if Meta refuses the filter they are left out.
  const unknownSets = unknown.filter((id) => !sets.has(id));
  if (unknownSets.length) for (const a of (await listWhere<AdSet>(client, "adsets", "id", unknownSets, ADSET_FIELDS, ALL_ADSET_STATUSES)) ?? []) sets.set(a.id, a);

  // Every ad of the ad sets when campaigns or only ad sets were asked for; otherwise just the given ads.
  const ads = new Map<string, Ad>();
  if ((campaigns.length || !askedAds.length) && sets.size) for (const ad of await adsOf(client, [...sets.keys()])) ads.set(ad.id, ad);
  const adIds = askedAds.filter((id) => !ads.has(id));
  if (adIds.length) for (const ad of await adsById(client, adIds)) ads.set(ad.id, ad);
  const unknownAds = unknown.filter((id) => !sets.has(id) && !ads.has(id));
  if (unknownAds.length) for (const ad of (await listWhere<Ad>(client, "ads", "id", unknownAds, AD_FIELDS, ALL_AD_STATUSES)) ?? []) ads.set(ad.id, ad);

  const out: DeliveryRow[] = [];
  const shown = new Set<string>();
  for (const s of sets.values()) {
    out.push(adSetRow(s));
    for (const ad of ads.values()) {
      if (ad.adset_id !== s.id) continue;
      out.push(adRow(ad));
      shown.add(ad.id);
    }
  }
  // Ads whose ad set is not listed (e.g. an ad a plan edited in another ad set): said with their own ad
  // set (its name comes with the ad), never put under the ad set listed last. Only when ad set rows are
  // listed: with none, no ad is shown under one.
  for (const ad of ads.values()) {
    if (shown.has(ad.id)) continue;
    const row = adRow(ad);
    if (ad.adset_id && sets.size) row.inAdset = { id: ad.adset_id, name: ad.adset?.name ?? "" };
    out.push(row);
  }
  for (const id of goneCampaigns) out.push(missingRow("campaign", id));
  for (const id of askedSets) if (!sets.has(id)) out.push(missingRow("adset", id));
  for (const id of askedAds) if (!ads.has(id)) out.push(missingRow("ad", id));
  return out;
}

/**
 * What a plan made or changed, by kind, from its own steps and saved IDs (no Meta call to ask what
 * each ID is). IDs whose kind the plan doesn't say (older turn-on/off steps) come back in `unknown`.
 */
export function planDeliveryTargets(
  ops: { type: string; campaigns?: unknown; adsets?: unknown; ads?: unknown; whole_campaigns?: unknown }[],
  progress: { ids?: (string | null)[]; sub?: Record<string, string>; before?: Record<string, Record<string, unknown>> }[],
): { campaigns: string[]; adsets: string[]; ads: string[]; unknown?: string[] } {
  const campaigns: string[] = [];
  const adsets: string[] = [];
  const ads: string[] = [];
  const unknown: string[] = [];
  const into = (kind: unknown, id: string) => {
    if (kind === "campaign") campaigns.push(id);
    else if (kind === "adset") adsets.push(id);
    else if (kind === "ad") ads.push(id);
  };
  const KIND: Record<string, string> = {
    create_campaign: "campaign",
    edit_campaign: "campaign",
    duplicate_campaign: "campaign",
    create_adset: "adset",
    edit_adset: "adset",
    duplicate_adset: "adset",
    ads_from_post: "ad",
    copy_ad: "ad",
    edit_ad: "ad",
  };
  progress.forEach((p, i) => {
    const op = ops[i];
    if (!op || !p) return;
    const ids = (p.ids ?? []).filter((x): x is string => typeof x === "string" && !!x);
    if (op.type === "set_status") {
      // Each ID's kind was saved with its old status ("Undo"); else the step's own lists say it.
      const listed = (k: unknown) => (Array.isArray(k) ? k.map(String) : []);
      for (const id of ids) {
        const kind =
          p.before?.[id]?.kind ??
          ([...listed(op.campaigns), ...listed(op.whole_campaigns)].includes(id) ? "campaign" : listed(op.adsets).includes(id) ? "adset" : listed(op.ads).includes(id) ? "ad" : undefined);
        if (kind === "campaign" || kind === "adset" || kind === "ad") into(kind, id);
        else unknown.push(id);
      }
    } else {
      for (const id of ids) into(KIND[op.type], id);
    }
    // Items made inside one copy: "2/<ad set>" and "2/<ad set>/<ad>" (campaign copies), "2/<ad>" (ad set copies).
    for (const [k, id] of Object.entries(p.sub ?? {})) {
      const parts = k.split("/").length;
      if (op.type === "duplicate_campaign") into(parts === 2 ? "adset" : parts === 3 ? "ad" : undefined, id);
      else if (op.type === "duplicate_adset" && parts === 2) into("ad", id);
    }
  });
  const u = (l: string[]) => [...new Set(l)];
  const known = new Set([...campaigns, ...adsets, ...ads]);
  const rest = u(unknown).filter((id) => !known.has(id));
  return { campaigns: u(campaigns), adsets: u(adsets), ads: u(ads), ...(rest.length ? { unknown: rest } : {}) };
}
