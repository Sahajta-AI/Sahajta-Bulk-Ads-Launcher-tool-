import { config } from "./config";
import { db, json } from "./db";
import { reviewLabel, resetFailed } from "./engine/launcher";
import { DEFAULT_UTM, META_URL_PARAMS, NAME_TOKENS } from "./engine/naming";
import { humanDuration } from "./engine/estimate";
import { accountLimits, autoGroup, buildPreview, checkLinks, launchTimeLeft, MAX_ADS_PER_ADSET, moveAsset, type AdsetDest, type DestinationInfo, type Preview } from "./engine/preview";
import { extraAdsets, goLivePlan, groupHold, groupWaits, lateRetryFrom, launchExtras, launchSummary, siblings, stopTurnOn, turnOnGroup, type ExtraAdset } from "./manage/golive";
import { accountInfo, getAdSet, getCampaign, isCbo, istTime } from "./manage/objects";
import { fromMinor, money } from "./manage/options";
import { getAppSettings } from "./appsettings";
import fs from "node:fs";
import path from "node:path";
import { previewCreative } from "./engine/launcher";
import { anyFiles } from "./sources/drive";
import { realClock } from "./meta/pacer";
import { creativePreviews } from "./manage/checks";
import { deliveryStatus } from "./manage/delivery";
import { MetaError, RateLimitedError, mustSurface, plainError } from "./meta/errors";
import { sameAmount } from "./manage/plan";
import { enqueue, reviewCheckedAt } from "./jobs";
import { clientFor } from "./meta/factory";
import { FEATURES } from "./meta/features";
import { defaultPreset, newBatch, presetFromRow } from "./setup";
import { igLink, pageLink } from "./meta/connect";
import { folderName, importDriveFolder, parseFolderId } from "./sources/drive";
import { removeUnusedUploads } from "./cleanup";
import { timeMs, zonedTime } from "./time";
import { adCopy, attemptsOf, batchCopy, batchPreset, cacheDelete, cacheGet, cacheSet, getAccount, getAds, getBatchByKey, logEvent, updateAd, updateBatch } from "./store";
import type { BatchRow, Copy, CopyOverride, Preset } from "./types";
import { HttpError } from "./httperror";
import { goLiveNote } from "./alerts";

// Everything the web app and Claude (through the API) can do. Routes stay thin.

export { CTA_TYPES } from "./manage/cta";
import { CTA_TYPES } from "./manage/cta";

function account() {
  const acc = getAccount();
  if (!acc) throw new HttpError(409, "Meta is not connected yet. Open Settings → Meta connection and click Connect Meta.");
  return acc;
}

function batchOr404(key: string): BatchRow {
  const b = getBatchByKey(key);
  if (!b) throw new HttpError(404, `No batch with code "${key}".`);
  return b;
}

/** Why a Meta read didn't work, in a few plain words (for "Couldn't check … just now: <why>"). */
function why(e: unknown): string {
  if (e instanceof RateLimitedError) return e.message;
  if (e instanceof MetaError) {
    if (e.code === 190 || e.code === 102) return "the Meta login has expired. Open Settings → Meta connection and click Reconnect Meta.";
    if (e.isThrottle) return "Meta asked the launcher to slow down. Try again in a few minutes.";
    if (e.noAnswer) return "Meta did not answer (connection problem). Try again in a minute.";
    const b = e.body;
    return `Meta said "${b?.error_user_msg || b?.message || e.message}"${b?.code ? ` (code ${b.code}${b.error_subcode ? `/${b.error_subcode}` : ""})` : ""}.`;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---------- Destinations ----------

export interface AdsetInfo {
  id: string;
  name: string;
  status: string;
  isDynamicCreative: boolean;
  /** Meta's destination_type: ON_AD (Instant form), WEBSITE, WHATSAPP… */
  destinationType?: string;
  optimizationGoal?: string;
}
export interface CampaignInfo {
  id: string;
  name: string;
  status: string;
  objective: string;
  adsets: AdsetInfo[];
}

/** Bumped when the cached list gains fields, so an old cache entry is read again. */
const DEST_VERSION = 2;

export async function listDestinations(refresh = false): Promise<{ campaigns: CampaignInfo[]; fetchedAt: string }> {
  const acc = account();
  const key = `dest:${acc.id}`;
  if (!refresh) {
    const hit = cacheGet<{ campaigns: CampaignInfo[]; fetchedAt: string; v?: number }>(key);
    if (hit?.v === DEST_VERSION) return hit;
  }
  const client = clientFor(acc.id);
  const live = ["ACTIVE", "PAUSED", "IN_PROCESS", "WITH_ISSUES", "CAMPAIGN_PAUSED"];
  type AdsetRow = { id: string; name: string; status: string; campaign_id: string; is_dynamic_creative?: boolean; destination_type?: string; optimization_goal?: string };
  const [campaigns, adsets] = await Promise.all([
    client.getAll<{ id: string; name: string; status: string; objective: string }>(`${client.accountId}/campaigns`, { fields: "id,name,status,objective", effective_status: live.filter((s) => s !== "CAMPAIGN_PAUSED") }),
    client.getAll<AdsetRow>(`${client.accountId}/adsets`, { fields: "id,name,status,campaign_id,is_dynamic_creative,destination_type,optimization_goal", effective_status: live }),
  ]);
  const out = {
    v: DEST_VERSION,
    fetchedAt: new Date().toISOString(),
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      adsets: adsets
        .filter((a) => a.campaign_id === c.id)
        .map((a) => ({ id: a.id, name: a.name, status: a.status, isDynamicCreative: !!a.is_dynamic_creative, destinationType: a.destination_type, optimizationGoal: a.optimization_goal })),
    })),
  };
  cacheSet(key, out, 5 * 60_000);
  return out;
}

async function findAdset(id: string): Promise<{ campaign: CampaignInfo; adset: AdsetInfo } | null> {
  for (const refresh of [false, true]) {
    const d = await listDestinations(refresh);
    for (const c of d.campaigns) {
      const a = c.adsets.find((x) => x.id === id);
      if (a) return { campaign: c, adset: a };
    }
  }
  return null;
}

/**
 * Find by ID or name: the ID, then the exact name (any case), then a part of the name. Several
 * matches are never guessed: the person gets the list to pick from.
 */
function pickByName<T extends { id: string | number; name: string }>(list: T[], q: string, what: string, describe: (x: T) => string = (x) => `"${x.name}" (ID ${x.id})`): T | undefined {
  const t = String(q ?? "").trim();
  if (!t) return undefined;
  const byId = list.find((x) => String(x.id) === t);
  if (byId) return byId;
  const s = t.toLowerCase();
  const exact = list.filter((x) => x.name.trim().toLowerCase() === s);
  if (exact.length === 1) return exact[0];
  const several = exact.length > 1 ? exact : list.filter((x) => x.name.toLowerCase().includes(s));
  if (several.length === 1) return several[0];
  if (several.length > 1) {
    const shown = several.slice(0, 12).map(describe).join("; ");
    throw new HttpError(400, `${exact.length > 1 ? `Several ${what}s are called "${t}"` : `"${t}" fits several ${what}s`}: ${shown}${several.length > 12 ? `; and ${several.length - 12} more` : ""}. Give the exact name or the ID.`);
  }
  return undefined;
}

/** An ad set by ID or name (Claude and the API). The cached list first; Meta again if not found. */
async function findAdsetByText(q: string): Promise<{ campaign: CampaignInfo; adset: AdsetInfo } | null> {
  for (const refresh of [false, true]) {
    const d = await listDestinations(refresh);
    const all = d.campaigns.flatMap((c) => c.adsets.map((a) => ({ ...a, campaign: c })));
    const m = pickByName(all, q, "ad set", (a) => `"${a.name}" in campaign "${a.campaign.name}" (ID ${a.id})`);
    if (m) {
      const { campaign, ...adset } = m;
      return { campaign, adset };
    }
  }
  return null;
}

// ---------- Templates ----------

interface CopyRow { id: number; name: string; primary_texts: string; headlines: string; description: string; cta: string; link_url: string; utm_template: string; display_link?: string; lead_form_id?: string }

export function copyFromRow(r: CopyRow): Copy & { id: number; name: string } {
  return { id: r.id, name: r.name, primaryTexts: JSON.parse(r.primary_texts) as string[], headlines: JSON.parse(r.headlines) as string[], description: r.description, cta: r.cta, linkUrl: r.link_url, utmTemplate: r.utm_template, displayLink: r.display_link ?? "", leadFormId: r.lead_form_id ?? "" };
}

export function listTemplates() {
  const acc = account();
  const copy = (db().prepare("SELECT * FROM copy_templates WHERE ad_account_id = ? ORDER BY name").all(acc.id) as CopyRow[]).map(copyFromRow);
  const naming = db().prepare("SELECT id, name, kind, pattern, is_default FROM naming_templates WHERE ad_account_id = ? ORDER BY kind, is_default DESC, name").all(acc.id) as { id: number; name: string; kind: "ad" | "adset" | "campaign"; pattern: string; is_default: number }[];
  const presets = (db().prepare("SELECT * FROM settings_presets WHERE ad_account_id = ? ORDER BY is_default DESC, name").all(acc.id) as Parameters<typeof presetFromRow>[0][]).map((r) => ({
    ...presetFromRow(r),
    isDefault: !!(r as unknown as { is_default: number }).is_default,
    enhancementsOn: Object.keys(presetFromRow(r).enhancements),
  }));
  return { copy, naming, presets, tokens: NAME_TOKENS, metaUrlParams: META_URL_PARAMS, defaultUtm: DEFAULT_UTM, features: FEATURES, ctaTypes: CTA_TYPES };
}

/** The saved item with exactly this name (any case), for "save with an existing name = edit it". */
function idByExactName(table: "copy_templates" | "settings_presets", accId: number, name: string): number | undefined {
  return db().prepare(`SELECT id FROM ${table} WHERE ad_account_id = ? AND lower(trim(name)) = lower(?) ORDER BY id LIMIT 1`).pluck().get(accId, name.trim()) as number | undefined;
}

function nameTaken(table: "copy_templates" | "settings_presets", accId: number, name: string, exceptId: number): boolean {
  return !!db().prepare(`SELECT 1 FROM ${table} WHERE ad_account_id = ? AND lower(trim(name)) = lower(?) AND id != ?`).get(accId, name.trim(), exceptId);
}

/**
 * Create or edit a copy template. Edit = an id, or the exact name of a saved one (names stay unique;
 * Claude saves by name). `create`: the Settings "Add" form; a name already in use is refused, never
 * overwritten. When editing, a field left out keeps its saved value; "" or [] clears it.
 */
export function saveCopyTemplate(t: Partial<Copy> & { id?: number; name?: string; create?: boolean }) {
  const acc = account();
  const name = t.name?.trim();
  let id = t.id ? Number(t.id) : undefined;
  if (!id && name) {
    id = idByExactName("copy_templates", acc.id, name);
    if (id && t.create) throw new HttpError(400, `A copy template is already called "${name}". Pick another name, or edit that one.`);
  }
  const cur = id ? (db().prepare("SELECT * FROM copy_templates WHERE id = ? AND ad_account_id = ?").get(id, acc.id) as CopyRow | undefined) : undefined;
  if (id && !cur) throw new HttpError(404, "That copy template no longer exists.");
  if ((!cur && !name) || (t.name !== undefined && !name)) throw new HttpError(400, "Give the copy template a name.");
  if (cur && name && nameTaken("copy_templates", acc.id, name, cur.id)) throw new HttpError(400, `Another copy template is already called "${name}". Pick another name.`);
  const texts = t.primaryTexts === undefined ? undefined : (t.primaryTexts ?? []).map((x) => String(x).trim()).filter(Boolean);
  const heads = t.headlines === undefined ? undefined : (t.headlines ?? []).map((x) => String(x).trim()).filter(Boolean);
  if ((texts?.length ?? 0) > 5 || (heads?.length ?? 0) > 5) throw new HttpError(400, "Up to 5 primary texts and 5 headlines.");
  if (t.cta && !CTA_TYPES.includes(t.cta)) throw new HttpError(400, `Unknown call-to-action ${t.cta}. Use one of: ${CTA_TYPES.join(", ")}.`);
  if (t.linkUrl?.trim() && !/^https?:\/\//i.test(t.linkUrl.trim())) throw new HttpError(400, "The link must start with https://.");
  const opt = (v: string | undefined) => (v === undefined ? null : String(v ?? "").trim());
  if (cur) {
    db()
      .prepare(
        `UPDATE copy_templates SET name = COALESCE(?, name), primary_texts = COALESCE(?, primary_texts), headlines = COALESCE(?, headlines), description = COALESCE(?, description),
           cta = COALESCE(?, cta), link_url = COALESCE(?, link_url), utm_template = COALESCE(?, utm_template), display_link = COALESCE(?, display_link), lead_form_id = COALESCE(?, lead_form_id),
           updated_at = datetime('now') WHERE id = ? AND ad_account_id = ?`,
      )
      .run(name ?? null, texts ? JSON.stringify(texts) : null, heads ? JSON.stringify(heads) : null, t.description === undefined ? null : (t.description ?? ""), t.cta === undefined ? null : t.cta || "LEARN_MORE", opt(t.linkUrl), opt(t.utmTemplate), opt(t.displayLink), opt(t.leadFormId), cur.id, acc.id);
    return cur.id;
  }
  // New templates get UTM tags by default, so analytics and the CRM show which ad brought each lead.
  const utm = t.utmTemplate === undefined ? DEFAULT_UTM : (t.utmTemplate ?? "").trim();
  return Number(
    db()
      .prepare("INSERT INTO copy_templates (name, primary_texts, headlines, description, cta, link_url, utm_template, display_link, lead_form_id, ad_account_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(name, JSON.stringify(texts ?? []), JSON.stringify(heads ?? []), t.description ?? "", t.cta || "LEARN_MORE", (t.linkUrl ?? "").trim(), utm, (t.displayLink ?? "").trim(), (t.leadFormId ?? "").trim(), acc.id).lastInsertRowid,
  );
}

export function saveNamingTemplate(t: { id?: number; name: string; kind: "ad" | "adset" | "campaign"; pattern: string; isDefault?: boolean }) {
  const acc = account();
  if (!t.name?.trim() || !t.pattern?.trim()) throw new HttpError(400, "A naming template needs a name and a pattern.");
  if (!["ad", "adset", "campaign"].includes(t.kind)) throw new HttpError(400, "kind must be ad, adset or campaign");
  const tx = db().transaction(() => {
    if (t.isDefault) db().prepare("UPDATE naming_templates SET is_default = 0 WHERE ad_account_id = ? AND kind = ?").run(acc.id, t.kind);
    if (t.id) {
      db().prepare("UPDATE naming_templates SET name=?, kind=?, pattern=?, is_default=COALESCE(?, is_default) WHERE id=? AND ad_account_id=?").run(t.name.trim(), t.kind, t.pattern.trim(), t.isDefault === undefined ? null : t.isDefault ? 1 : 0, t.id, acc.id);
      return t.id;
    }
    return Number(db().prepare("INSERT INTO naming_templates (ad_account_id, name, kind, pattern, is_default) VALUES (?,?,?,?,?)").run(acc.id, t.name.trim(), t.kind, t.pattern.trim(), t.isDefault ? 1 : 0).lastInsertRowid);
  });
  return tx();
}

/**
 * Create or edit a settings preset. Edit = an id, or the exact name of a saved one (names stay unique;
 * Claude saves by name). `create`: the Settings "Add" form; a name already in use is refused, never
 * overwritten. When editing, a field left out keeps its saved value; "" clears it (Instagram, WhatsApp,
 * Threads, partner Page).
 */
export function savePreset(p: Partial<Preset> & { id?: number; name?: string; isDefault?: boolean; create?: boolean }) {
  const acc = account();
  const name = p.name?.trim();
  let id = p.id ? Number(p.id) : undefined;
  if (!id && name) {
    id = idByExactName("settings_presets", acc.id, name);
    if (id && p.create) throw new HttpError(400, `A settings preset is already called "${name}". Pick another name, or edit that one.`);
  }
  const cur = id ? db().prepare("SELECT id FROM settings_presets WHERE id = ? AND ad_account_id = ?").get(id, acc.id) : undefined;
  if (id && !cur) throw new HttpError(404, "That preset no longer exists.");
  if ((!cur && !name) || (p.name !== undefined && !name)) throw new HttpError(400, "Give the preset a name.");
  if (cur && name && nameTaken("settings_presets", acc.id, name, id!)) throw new HttpError(400, `Another settings preset is already called "${name}". Pick another name.`);
  let enh: string | null = null;
  if (p.enhancements !== undefined) {
    const unknown = Object.keys(p.enhancements ?? {}).filter((k) => !FEATURES.some((f) => f.key === k));
    if (unknown.length) throw new HttpError(400, `Unknown enhancement${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Known: ${FEATURES.map((f) => f.key).join(", ")}.`);
    const on: Record<string, "OPT_IN"> = {};
    for (const [k, v] of Object.entries(p.enhancements ?? {})) if (v === "OPT_IN" || (v as unknown) === true || (v as unknown) === "on") on[k] = "OPT_IN";
    enh = JSON.stringify(on);
  }
  const wa = p.whatsappNumber === undefined || p.whatsappNumber === null ? null : String(p.whatsappNumber).replace(/[^\d+]/g, "");
  if (wa && !/^\+?\d{11,15}$/.test(wa)) throw new HttpError(400, "Give the WhatsApp number with its country code, e.g. +919812345678.");
  for (const [k, v] of [["Threads account ID", p.threadsUserId], ["partner Page ID", p.sponsorPageId]] as const) if (v && !/^\d+$/.test(String(v).trim())) throw new HttpError(400, `The ${k} is a number.`);
  const opt = (v: string | undefined | null) => (v === undefined || v === null ? null : String(v).trim());
  const multi = p.multiAdvertiser === undefined ? null : p.multiAdvertiser ? 1 : 0;
  return db().transaction(() => {
    if (p.isDefault) db().prepare("UPDATE settings_presets SET is_default = 0 WHERE ad_account_id = ?").run(acc.id);
    if (cur) {
      db()
        .prepare(
          `UPDATE settings_presets SET name = COALESCE(?, name), page_id = COALESCE(?, page_id), page_name = COALESCE(?, page_name), ig_user_id = COALESCE(?, ig_user_id), ig_name = COALESCE(?, ig_name),
             enhancements = COALESCE(?, enhancements), multi_advertiser = COALESCE(?, multi_advertiser), whatsapp_number = COALESCE(?, whatsapp_number), threads_user_id = COALESCE(?, threads_user_id),
             sponsor_page_id = COALESCE(?, sponsor_page_id), is_default = COALESCE(?, is_default) WHERE id = ? AND ad_account_id = ?`,
        )
        .run(name ?? null, opt(p.pageId), opt(p.pageName), opt(p.igUserId), opt(p.igName), enh, multi, wa, opt(p.threadsUserId), opt(p.sponsorPageId), p.isDefault === undefined ? null : p.isDefault ? 1 : 0, id!, acc.id);
      return id!;
    }
    return Number(
      db()
        .prepare("INSERT INTO settings_presets (name, page_id, page_name, ig_user_id, ig_name, enhancements, multi_advertiser, whatsapp_number, threads_user_id, sponsor_page_id, is_default, ad_account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(name, opt(p.pageId) ?? "", opt(p.pageName) ?? "", opt(p.igUserId) ?? "", opt(p.igName) ?? "", enh ?? "{}", multi ?? 0, wa ?? "", opt(p.threadsUserId) ?? "", opt(p.sponsorPageId) ?? "", p.isDefault ? 1 : 0, acc.id).lastInsertRowid,
    );
  })();
}

export function deleteTemplate(kind: "copy" | "naming" | "preset", id: number) {
  const table = { copy: "copy_templates", naming: "naming_templates", preset: "settings_presets" }[kind];
  if (kind === "preset" && (db().prepare("SELECT COUNT(*) AS n FROM settings_presets").get() as { n: number }).n <= 1) throw new HttpError(400, "Keep at least one settings preset.");
  db().prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}

export interface Identities {
  pages: { id: string; name: string; pictureUrl: string | null; link: string }[];
  /** Only accounts the ad account may advertise with (Meta refuses others with 200/1815199). */
  instagram: { id: string; username: string; pictureUrl: string | null; link: string }[];
  /** False when Meta did not answer the Instagram list; then nothing is blocked on it. */
  instagramKnown: boolean;
  /** False when Meta did not answer the Page list. */
  pagesKnown?: boolean;
}

/**
 * Facebook Pages and Instagram accounts this ad account can use, with photo, ID and link. Cached for
 * 30 minutes, but only a complete answer: a failed read is never remembered. Meta limiting calls or an
 * expired login is passed on (the person sees why), never turned into an empty list.
 */
export async function listIdentities(refresh = false): Promise<Identities> {
  const acc = account();
  const key = `ident:${acc.id}`;
  if (!refresh) {
    const hit = cacheGet<Identities>(key);
    if (hit?.pages?.every((p) => "link" in p)) return hit;
  }
  const client = clientFor(acc.id);
  type PageRow = { id: string; name: string; picture?: { data?: { url?: string } } };
  type IgRow = { id: string; username: string; profile_pic?: string };
  const surface = (e: unknown) => {
    if (mustSurface(e)) throw e;
  };
  let pagesKnown = true;
  const pages = await client
    .getAll<PageRow>(`${client.accountId}/promote_pages`, { fields: "id,name,picture{url}" })
    .catch((e) => {
      surface(e);
      return client.getAll<PageRow>(`${client.accountId}/promote_pages`, { fields: "id,name" }); // pictures need another permission
    })
    .catch((e) => {
      surface(e);
      pagesKnown = false;
      return [] as PageRow[];
    });
  let instagramKnown = true;
  const instagram = await client
    .getAll<IgRow>(`${client.accountId}/instagram_accounts`, { fields: "id,username,profile_pic" })
    .catch((e) => {
      surface(e);
      return client.getAll<IgRow>(`${client.accountId}/instagram_accounts`, { fields: "id,username" });
    })
    .catch((e) => {
      surface(e);
      instagramKnown = false;
      return [] as IgRow[];
    });
  const out: Identities = {
    pages: pages.map((p) => ({ id: p.id, name: p.name, pictureUrl: p.picture?.data?.url ?? null, link: pageLink(p.id) })),
    instagram: instagram.map((i) => ({ id: i.id, username: i.username, pictureUrl: i.profile_pic ?? null, link: igLink(i.username) })),
    instagramKnown,
    pagesKnown,
  };
  if (pagesKnown && instagramKnown) cacheSet(key, out, 30 * 60_000);
  return out;
}

export interface ConnectionSummary {
  connected: boolean;
  adAccount: { id: string; name: string; adsManagerLink: string } | null;
  page: { id: string; name: string; pictureUrl: string | null; link: string } | null;
  instagram: { id: string; username: string; pictureUrl: string | null; link: string; allowed: boolean | null } | null;
  loginBy: string | null;
  loginExpiresAt: string | null;
  loginExpired: boolean;
  problems: string[];
}

/** What the launcher is connected to right now, as the pre-launch summary and Claude show it.
 *  `preset` defaults to the default settings preset. Meta limiting calls is passed on (not hidden).
 *  `cachedOnly`: no Meta reads (for a batch already launched). */
export async function connectionSummary(preset?: Preset | null, opts: { cachedOnly?: boolean } = {}): Promise<ConnectionSummary> {
  const acc = getAccount();
  if (!acc?.token_enc) {
    return { connected: false, adAccount: null, page: null, instagram: null, loginBy: null, loginExpiresAt: null, loginExpired: false, problems: ["Meta is not connected. Open Settings → Meta connection → Connect Meta."] };
  }
  const p = preset ?? defaultPreset(acc.id) ?? null;
  const problems: string[] = [];
  let ids: Identities | null = null;
  if (opts.cachedOnly) {
    ids = cacheGet<Identities>(`ident:${acc.id}`) ?? null;
  } else {
    try {
      ids = await listIdentities();
    } catch (e) {
      if (mustSurface(e)) throw e;
      problems.push(`Couldn't ask Meta for the Page and Instagram details just now: ${why(e)}`);
    }
  }
  const pg = p?.pageId ? (ids?.pages.find((x) => x.id === p.pageId) ?? { id: p.pageId, name: p.pageName || p.pageId, pictureUrl: null, link: pageLink(p.pageId) }) : null;
  if (!pg) problems.push("No Facebook Page is set in the settings preset.");
  else if (ids && ids.pages.length && !ids.pages.some((x) => x.id === pg.id)) {
    problems.push(`Meta does not list the Page "${pg.name}" (${pg.id}) among the Pages this ad account promotes. If ads fail with a Page permission error, add the Page to the ad account in Meta Business settings → Accounts → Pages → Assign assets.`);
  }
  let ig: ConnectionSummary["instagram"] = null;
  if (p?.igUserId) {
    const found = ids?.instagram.find((x) => x.id === p.igUserId);
    const allowed = ids?.instagramKnown ? !!found : null;
    ig = { id: p.igUserId, username: found?.username ?? p.igName, pictureUrl: found?.pictureUrl ?? null, link: igLink(found?.username ?? p.igName), allowed };
    if (allowed === false) problems.push(igNotAllowed(acc.name, ig.username));
  }
  const exp = acc.token_expires_at;
  if (exp && exp < Date.now()) problems.push("The Meta login has expired. Settings → Meta connection → Reconnect Meta.");
  return {
    connected: true,
    adAccount: { id: acc.meta_account_id, name: acc.name, adsManagerLink: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${acc.meta_account_id.replace(/^act_/, "")}` },
    page: pg,
    instagram: ig,
    loginBy: acc.meta_user_name,
    loginExpiresAt: exp ? new Date(exp).toISOString() : null,
    loginExpired: !!exp && exp < Date.now(),
    problems,
  };
}

export function igNotAllowed(accountName: string, username: string): string {
  return `The ad account "${accountName}" is not allowed to use Instagram @${username}, so Meta refuses the ads (code 200/1815199). Fix: Meta Business settings → Accounts → Instagram accounts → @${username} → Assign assets → add the ad account "${accountName}". Or set the settings preset's Instagram account to "None (use the Facebook Page)".`;
}

// ---------- Batches ----------

export interface BatchSettings {
  campaignId?: string;
  adsetMode?: "existing" | "new_per_ad" | "new_shared";
  adsetId?: string; // or a name (from Claude)
  copyTemplateId?: number | string; // or a name
  adNameTemplate?: string;
  adsetNameTemplate?: string;
  presetId?: number | string;
  angle?: string;
  persona?: string;
  /** More ad sets that get the same ads (ids or names). One batch per ad set is launched together. */
  extraAdsetIds?: string[];
  goLive?: "paused" | "now" | "at";
  /** A time without a zone is India time (e.g. "2026-11-20T09:00" = 9:00 am IST). */
  goLiveAt?: string | null;
}

type Patch = Record<string, string | number | null>;

const given = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "";

/** Copy template and settings preset (by id or name) → the batch's own copy of them. No Meta calls. */
function templatePatch(accId: number, s: Pick<BatchSettings, "copyTemplateId" | "presetId">): Patch {
  const patch: Patch = {};
  if (given(s.copyTemplateId)) {
    const list = (db().prepare("SELECT * FROM copy_templates WHERE ad_account_id = ?").all(accId) as CopyRow[]).map(copyFromRow);
    const t = pickByName(list, String(s.copyTemplateId), "copy template");
    if (!t) throw new HttpError(400, `Couldn't find a copy template called "${s.copyTemplateId}". Saved ones: ${list.map((x) => `"${x.name}"`).join(", ") || "none"}.`);
    patch.copy_template_id = t.id;
    const { id: _id, name: _n, ...copy } = t;
    patch.copy = JSON.stringify(copy);
  }
  if (given(s.presetId)) {
    const rows = db().prepare("SELECT * FROM settings_presets WHERE ad_account_id = ?").all(accId) as Parameters<typeof presetFromRow>[0][];
    const r = pickByName(rows, String(s.presetId), "settings preset");
    if (!r) throw new HttpError(400, `Couldn't find a settings preset called "${s.presetId}". Saved ones: ${rows.map((x) => `"${x.name}"`).join(", ") || "none"}.`);
    patch.preset_id = r.id;
    patch.preset = JSON.stringify(presetFromRow(r));
  }
  return patch;
}

/** The batch columns for these settings, checked (names found, times read). `b` null: a batch not made yet. */
async function settingsPatch(b: BatchRow | null, accId: number, s: BatchSettings): Promise<Patch> {
  const patch: Patch = {};
  if (s.adsetMode) {
    if (!["existing", "new_per_ad", "new_shared"].includes(s.adsetMode)) throw new HttpError(400, "adsetMode must be existing, new_per_ad or new_shared.");
    patch.adset_mode = s.adsetMode;
  }
  if (given(s.adsetId)) {
    const found = await findAdsetByText(String(s.adsetId));
    if (!found) throw new HttpError(400, `Couldn't find an ad set called "${s.adsetId}". Use list_destinations to see the names.`);
    patch.adset_id = found.adset.id;
    patch.adset_name = found.adset.name;
    patch.campaign_id = found.campaign.id;
    patch.campaign_name = found.campaign.name;
  } else if (given(s.campaignId)) {
    const d = await listDestinations();
    const c = pickByName(d.campaigns, String(s.campaignId), "campaign");
    if (!c) throw new HttpError(400, `Couldn't find a campaign called "${s.campaignId}".`);
    patch.campaign_id = c.id;
    patch.campaign_name = c.name;
    if ((b?.campaign_id ?? null) !== c.id) {
      patch.adset_id = null;
      patch.adset_name = null;
    }
  }
  Object.assign(patch, templatePatch(accId, s));
  if (s.adNameTemplate !== undefined) patch.ad_name_template = namingPattern(s.adNameTemplate ?? "", accId) ?? "";
  if (s.adsetNameTemplate !== undefined) patch.adset_name_template = namingPattern(s.adsetNameTemplate ?? "", accId) ?? "";
  if (s.angle !== undefined) patch.angle = s.angle ?? "";
  if (s.persona !== undefined) patch.persona = s.persona ?? "";
  // Extra ad sets: never the main ad set (whichever field changed), never twice.
  const mainId = "adset_id" in patch ? (patch.adset_id as string | null) : (b?.adset_id ?? null);
  let extras: ExtraAdset[] | undefined;
  if (s.extraAdsetIds !== undefined && s.extraAdsetIds !== null) {
    const list = Array.isArray(s.extraAdsetIds) ? s.extraAdsetIds : [s.extraAdsetIds];
    extras = [];
    for (const q of list.filter((x) => given(x))) {
      const found = await findAdsetByText(String(q));
      if (!found) throw new HttpError(400, `Couldn't find an ad set called "${q}". Use list_destinations to see the names.`);
      extras.push({ id: found.adset.id, name: found.adset.name, campaignId: found.campaign.id, campaignName: found.campaign.name });
    }
  }
  const before = b ? extraAdsets(b) : [];
  const after = (extras ?? before).filter((x, i, all) => x.id !== mainId && all.findIndex((o) => o.id === x.id) === i);
  if (extras !== undefined || after.length !== before.length) patch.extra_adsets = JSON.stringify(after);
  if (s.goLive !== undefined) {
    if (!["paused", "now", "at"].includes(s.goLive)) throw new HttpError(400, "goLive must be paused, now or at.");
    patch.go_live = s.goLive;
  }
  if (s.goLiveAt !== undefined) {
    if (!given(s.goLiveAt)) patch.go_live_at = null;
    else {
      // No time zone given: India time, never the server's UTC clock.
      const z = zonedTime(String(s.goLiveAt));
      if (!z) throw new HttpError(400, `"${s.goLiveAt}" is not a date and time. Write it like 2026-11-20T09:00 (India time).`);
      patch.go_live_at = z;
    }
  }
  return patch;
}

/** Validate the settings first (a wrong ad set name must not leave an empty draft behind), then make the batch. */
export async function createBatch(email: string, opts: { driveFolder?: string } & BatchSettings = {}): Promise<string> {
  const acc = account();
  const { driveFolder, ...settings } = opts ?? {};
  const patch = await settingsPatch(null, acc.id, settings);
  let source: { kind: "drive" | "upload"; ref?: string; label?: string } = { kind: "upload" };
  let folderId: string | null = null;
  if (driveFolder) {
    folderId = parseFolderId(driveFolder);
    if (!folderId) throw new HttpError(400, "That doesn't look like a Google Drive folder link.");
    source = { kind: "drive", ref: folderId, label: await folderName(email, folderId) };
  }
  const id = newBatch(acc.id, email, source);
  const key = (db().prepare("SELECT key FROM batches WHERE id = ?").get(id) as { key: string }).key;
  updateBatch(id, patch);
  if (folderId) {
    try {
      await importDriveFolder(id, email, folderId);
      autoGroup(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HttpError(e instanceof HttpError ? e.status : 400, `${msg} Batch ${key} was made, but its files could not all be read from Drive: open it in the app to add the files again, or delete it.`);
    }
  }
  return key;
}

const AFTER_LAUNCH_SETTINGS = ["presetId", "copyTemplateId"];

/**
 * A batch that ended failed or partly done: only its settings preset and copy template can change,
 * for the ads not created yet (e.g. a preset without Instagram after Meta refused it with 1815199).
 * A creative made with the old settings is not reused: Retry makes a new one ("v2").
 */
function changeAfterLaunch(b: BatchRow, accId: number, s: BatchSettings): string | null {
  const other = Object.entries(s ?? {}).filter(([k, v]) => v !== undefined && !AFTER_LAUNCH_SETTINGS.includes(k));
  if (other.length) {
    throw new HttpError(409, `This batch has been launched, so ${other.map(([k]) => k).join(", ")} can't change. Only the settings preset and the copy template can change, for the ads not created yet; then press "Retry failed".`);
  }
  const patch = templatePatch(accId, s);
  const changed = Object.entries(patch).filter(([k, v]) => (b as unknown as Record<string, unknown>)[k] !== v);
  if (!changed.length) return null;
  updateBatch(b.id, patch);
  const what = [patch.preset ? `settings preset "${json<Preset>(String(patch.preset), {} as Preset).name}"` : "", patch.copy_template_id ? "copy template" : ""].filter(Boolean).join(" and ");
  for (const ad of getAds(b.id).filter((a) => a.status !== "done")) {
    const a = attemptsOf(ad);
    if (ad.meta_creative_id || a.creative) {
      a.copy_gen = (a.copy_gen ?? 0) + 1;
      delete a.creative;
      updateAd(ad.id, { meta_creative_id: null, attempts: JSON.stringify(a) });
    }
    updateAd(ad.id, { error: `The ${what} changed after the failure. Press "Retry failed" to create this ad with it.` });
  }
  logEvent(b.id, null, "info", `Changed to the ${what} after the launch. "Retry failed" creates the ads not made yet with it; ads already in Meta keep the old settings.`);
  return what;
}

export async function updateSettings(key: string, s: BatchSettings) {
  const b = batchOr404(key);
  const acc = account();
  if (b.status === "failed" || b.status === "partial") {
    changeAfterLaunch(b, acc.id, s ?? {});
    return;
  }
  if (b.status !== "draft") throw new HttpError(409, "This batch has been launched; its settings can't change.");
  updateBatch(b.id, await settingsPatch(b, acc.id, s ?? {}));
}

/** Fields given replace the ad's own values; fields left out keep them. "" or [] clears a field (the batch copy is used). */
function mergeCopy(current: CopyOverride, change: CopyOverride): CopyOverride {
  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(change ?? {})) if (v !== undefined) out[k] = v;
  return out as CopyOverride;
}

/**
 * Per-ad copy by ad number or creative name (Claude, and the copy-sheet import). Each row changes only
 * the fields it gives (format, lead form, enhancements… are kept unless given). All rows or none: a bad
 * row saves nothing and the error names the row.
 */
export function setAdCopyBy(key: string, rows: { ad: string | number; copy?: CopyOverride; angle?: string }[]) {
  const b = batchOr404(key);
  if (!Array.isArray(rows)) throw new HttpError(400, "Give the rows as a list: the ad (number or creative name) and its copy or angle.");
  const ads = getAds(b.id);
  const done: string[] = [];
  db().transaction(() => {
    rows.forEach((r, i) => {
      const where = `Row ${i + 1}${r && r.ad !== undefined && r.ad !== null ? ` (ad ${r.ad})` : ""}`;
      try {
        if (!r || typeof r !== "object" || !given(r.ad)) throw new HttpError(400, "names no ad. Give the ad number or the creative name from the preview.");
        const hasCopy = !!r.copy && typeof r.copy === "object";
        if (!hasCopy && r.angle === undefined) throw new HttpError(400, "has no copy or angle to set.");
        const q = String(r.ad).trim().toLowerCase().replace(/\.[a-z0-9]+$/, "");
        const ad =
          ads.find((a) => String(a.position) === q || a.key === q) ??
          ads.find((a) => a.creative_name.toLowerCase() === q) ??
          ads.find((a) => getAdAssetsByAd(a.id).some((f) => f.filename.toLowerCase().replace(/\.[a-z0-9]+$/, "") === q));
        if (!ad) throw new HttpError(400, `No ad "${r.ad}" in batch ${key}. Use the ad number or the creative name from the preview.`);
        let copy: CopyOverride | undefined;
        if (hasCopy) {
          // The latest saved copy (an earlier row of this call may have changed the same ad).
          const now = db().prepare("SELECT copy_override FROM ads WHERE id = ?").pluck().get(ad.id) as string | null;
          copy = mergeCopy(json<CopyOverride>(now, {}), r.copy!);
          if ((copy.primaryTexts?.length ?? 0) > 5 || (copy.headlines?.length ?? 0) > 5) throw new HttpError(400, `Ad ${ad.position}: up to 5 primary texts and 5 headlines.`);
          if (copy.cta && !CTA_TYPES.includes(copy.cta)) throw new HttpError(400, `Ad ${ad.position}: unknown call-to-action ${copy.cta}.`);
        }
        updateAdOverride(key, ad.id, { copy, angle: r.angle });
        done.push(`${ad.position} (${ad.creative_name})`);
      } catch (e) {
        if (e instanceof HttpError) throw new HttpError(e.status, `${where}: ${e.message} Nothing was saved.`);
        throw e;
      }
    });
  })();
  return done;
}

function getAdAssetsByAd(adId: number) {
  return db().prepare("SELECT filename FROM assets WHERE ad_id = ?").all(adId) as { filename: string }[];
}

/** Move a file to another ad (by number) or to an ad of its own. For Claude's regroup tool. */
export function regroupFile(key: string, file: string, to: number | string | "new") {
  const b = batchOr404(key);
  const f = db().prepare("SELECT id, filename FROM assets WHERE batch_id = ? AND (lower(filename) = lower(?) OR lower(rel_path) = lower(?))").get(b.id, file, file) as { id: number; filename: string } | undefined;
  if (!f) throw new HttpError(400, `No file "${file}" in batch ${key}.`);
  let toId: number | "new" = "new";
  if (to !== "new") {
    const ad = getAds(b.id).find((a) => a.position === Number(to));
    if (!ad) throw new HttpError(400, `Batch ${key} has no ad ${to}.`);
    toId = ad.id;
  }
  try {
    moveAsset(b.id, f.id, toId);
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
}

export interface Cancelled {
  key: string;
  adsetName: string | null;
  /**
   * "cancelled": the launch had not started; "stopping": it stops after the current step;
   * "turn_on_cancelled": the ads are not turned on by the yes given at launch (the turn-on plan
   * `planKey` that had not run is cancelled, or none will be made), so they stay paused;
   * "turn_on_stopping": that plan was running, it stops now (what it turned on
   * stays on); "already_on": it already ran, so the ads are on and Stop does not turn them off.
   */
  result: "cancelled" | "stopping" | "turn_on_cancelled" | "turn_on_stopping" | "already_on";
  /** The turn-on plan, for the turn_on_* results and "already_on". */
  planKey?: string;
  /** What happened to this batch, in plain words. */
  message: string;
}

const isLaunching = (b: BatchRow) => b.status === "queued" || b.status === "running";

/**
 * Stop a launch, and the launches into other ad sets made with it (same ads): ads not created yet
 * stay uncreated (Retry continues them later), and the yes given at launch no longer turns anything
 * on: a turn-on plan that has not run (queued or a draft) is cancelled, a running one stops after its
 * current step, one not made yet is not made, and after a Retry the turn-on plan is saved as a draft
 * that needs a fresh confirmation. Also for a batch whose ads are all in and only its turn-on is
 * left. Nothing is deleted. A turn-on plan that already ran is named ("already_on"): Stop does not
 * turn those ads off.
 */
export function cancelBatch(key: string): { cancelled: Cancelled[] } {
  // One write transaction (nothing here waits for Meta): a worker can't make or start a turn-on plan
  // half-way through the Stop, and two Stops don't mix.
  return db().transaction(() => cancelGroup(key)).immediate();
}

function cancelGroup(key: string): { cancelled: Cancelled[] } {
  const b = batchOr404(key);
  const all = siblings(b);
  const cancelled: Cancelled[] = [];
  const now = new Date().toISOString();
  for (const x of all.filter(isLaunching)) {
    const also = x.id === b.id ? "" : ` (stopped together with batch ${b.key})`;
    if (x.status === "queued") {
      db().prepare("UPDATE jobs SET status = 'done', last_error = 'cancelled' WHERE kind = 'launch' AND batch_id = ? AND status = 'queued'").run(x.id);
      db().prepare("UPDATE ads SET status = 'failed', error = 'Cancelled before it was created. Press \"Retry failed\" to create it.' WHERE batch_id = ? AND status != 'done'").run(x.id);
      const ads = getAds(x.id);
      const done = ads.filter((a) => a.status === "done").length;
      // cancel_requested also stops a worker that picked the job up at this very moment, and the go-live.
      // Every ad already in (a "turn the ads on again" retry): the batch is done, only the go-live stops.
      updateBatch(x.id, { status: done === ads.length ? "done" : done ? "partial" : "failed", finished_at: now, cancel_requested: 1, stopped_at: now });
      logEvent(x.id, null, "warn", `Cancelled before the launch started${also}.`);
      cancelled.push({ key: x.key, adsetName: x.adset_name, result: "cancelled", message: done === ads.length ? "All ads are created. They are not turned on, so they stay paused." : "Stopped before it started. Ads already created stay paused; nothing is turned on. Retry creates the others later." });
    } else {
      updateBatch(x.id, { cancel_requested: 1, stopped_at: now });
      logEvent(x.id, null, "warn", `Cancel asked${also}: the launch stops after the current step. Ads already created stay (paused) and are not turned on.`);
      cancelled.push({ key: x.key, adsetName: x.adset_name, result: "stopping", message: "Stops after the current step. Ads already created stay paused and are not turned on." });
    }
  }
  // The batches that finished: the yes given at launch must not turn their ads on either. Several of
  // them may share one turn-on plan: it is stopped once, and each batch says what happened to it.
  const on: Cancelled[] = [];
  const plans = new Map<string, "cancelled" | "stopping" | "on" | null>();
  for (const x of all.filter((y) => !isLaunching(y) && y.status !== "draft" && y.go_live !== "paused")) {
    if (!x.go_live_done) {
      // No turn-on plan made yet (the worker is about to, is trying again, or waits for failed ads): none is
      // queued to run. A turn-on step already running when Stop is pressed saves its plan as a draft (no email).
      updateBatch(x.id, { cancel_requested: 1, stopped_at: now });
      const allIn = getAds(x.id).every((a) => a.status === "done");
      logEvent(x.id, null, "warn", `Stopped${x.id === b.id ? "" : ` together with batch ${b.key}`}: the ads that were created stay paused and are not turned on.`);
      cancelled.push({ key: x.key, adsetName: x.adset_name, result: "turn_on_cancelled", message: allIn ? "All ads are created. They are not turned on, so they stay paused." : "The ads already created stay paused. After a Retry they are not turned on by themselves: a turn-on plan is saved as a draft to check and confirm." });
      continue;
    }
    const t = stopTurnOn(x, plans);
    if (!t) continue;
    if (t.result === "cancelled") {
      updateBatch(x.id, { stopped_at: now });
      cancelled.push({ key: x.key, adsetName: x.adset_name, result: "turn_on_cancelled", planKey: t.planKey, message: `All ads are created. The turn-on plan ${t.planKey} is stopped, so the ads stay paused.` });
    } else if (t.result === "stopping") {
      updateBatch(x.id, { stopped_at: now });
      cancelled.push({ key: x.key, adsetName: x.adset_name, result: "turn_on_stopping", planKey: t.planKey, message: `The turn-on plan ${t.planKey} was already running: it stops now; what it already turned on stays on. Pause those under Campaigns.` });
    } else {
      on.push({ key: x.key, adsetName: x.adset_name, result: "already_on", planKey: t.planKey, message: `The ads were already turned on by plan ${t.planKey}. Stop doesn't turn them off: pause them under Campaigns, or open the plan and press Undo.` });
    }
  }
  if (!cancelled.length) {
    const own = on.find((c) => c.key === b.key) ?? on[0];
    throw new HttpError(409, `This batch is not launching (${STATUS_LABEL[b.status]?.toLowerCase() ?? b.status}) and nothing is waiting to turn its ads on.${own ? ` ${own.message}` : ""}`);
  }
  return { cancelled: [...cancelled, ...on] };
}

/** Two saved per-ad copies say the same (key order and empty values don't matter). */
function sameCopy(a: string | null | undefined, b: string | null | undefined): boolean {
  const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
  const canon = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.keys(v).filter((k) => !empty((v as Record<string, unknown>)[k])).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])
      : v;
  return JSON.stringify(canon(json<unknown>(a ?? null, {}))) === JSON.stringify(canon(json<unknown>(b ?? null, {})));
}

export function updateAdOverride(key: string, adId: number, o: { copy?: CopyOverride; angle?: string | null }) {
  const b = batchOr404(key);
  const ad = getAds(b.id).find((a) => a.id === adId);
  if (!ad) throw new HttpError(404, "Ad not found.");
  // Before launch every ad can change. After launch only ads that were not created (batch zrhtj: a
  // failed ad must be fixable before "Retry failed"); created ads change through a plan (edit_ad).
  if (b.status !== "draft") {
    if (b.status === "running" || b.status === "queued") throw new HttpError(409, "This batch is launching. Wait for it to finish (or stop it), then fix the failed ads.");
    if (ad.status === "done") throw new HttpError(409, `Ad ${ad.position} (${ad.creative_name}) is already in Meta. Change it with a plan step edit_ad (Campaigns page, or Claude's plan_changes).`);
  }
  const patch: Record<string, string | null> = {};
  if (o.copy !== undefined && o.copy !== null) {
    const clean: CopyOverride = {};
    for (const [k, v] of Object.entries(o.copy)) {
      if (k === "enhancements" && v && typeof v === "object") {
        const unknown = Object.keys(v).filter((f) => !FEATURES.some((x) => x.key === f));
        if (unknown.length) throw new HttpError(400, `Unknown enhancement${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`);
        (clean as Record<string, unknown>)[k] = Object.fromEntries(Object.keys(v).map((f) => [f, "OPT_IN"]));
      } else if (k === "multiAdvertiser" && typeof v === "boolean") (clean as Record<string, unknown>)[k] = v;
      else if (k === "format") {
        if (v !== "single" && v !== "carousel") throw new HttpError(400, 'format must be "single" or "carousel".');
        if (v === "carousel") (clean as Record<string, unknown>)[k] = v;
      }
      else if (Array.isArray(v) ? v.some((x) => String(x).trim()) : typeof v === "string" && v.trim()) (clean as Record<string, unknown>)[k] = v;
    }
    if ((clean.primaryTexts?.length ?? 0) > 5 || (clean.headlines?.length ?? 0) > 5) throw new HttpError(400, "Up to 5 primary texts and 5 headlines.");
    if (clean.cta && !CTA_TYPES.includes(clean.cta)) throw new HttpError(400, `Unknown call-to-action ${clean.cta}.`);
    if (clean.linkUrl && !/^https?:\/\//i.test(clean.linkUrl)) throw new HttpError(400, "The link must start with https://.");
    const next = Object.keys(clean).length ? JSON.stringify(clean) : null;
    // Written only when it changed: the same copy again (e.g. a row that only sets the angle) keeps a
    // failed ad's creative and its error.
    if (!sameCopy(next, ad.copy_override)) patch.copy_override = next;
  }
  if (o.angle !== undefined) patch.angle = o.angle === "" ? null : o.angle;
  updateAd(ad.id, patch);
  // The ad's files remember this copy, so it stays with them if they move to another ad.
  db().prepare("UPDATE assets SET copy_override = ?, angle = ? WHERE ad_id = ?").run(patch.copy_override !== undefined ? patch.copy_override : ad.copy_override, patch.angle !== undefined ? patch.angle : ad.angle, ad.id);
  // The link tags use {angle}: a new angle is new link tags, so the creative changes as with new copy.
  const angleOf = (x: string | null | undefined) => x ?? b.angle ?? "";
  const angleChanged =
    patch.angle !== undefined &&
    angleOf(patch.angle) !== angleOf(ad.angle) &&
    /\{angle[}:]/.test(adCopy(b, { ...ad, copy_override: patch.copy_override !== undefined ? patch.copy_override : ad.copy_override }).utmTemplate);
  if (b.status !== "draft" && (patch.copy_override !== undefined || angleChanged)) {
    // A creative made with the old copy is not reused: the retry makes "v2".
    const a = JSON.parse(ad.attempts || "{}") as Record<string, number>;
    if (ad.meta_creative_id || a.creative) {
      a.copy_gen = (a.copy_gen ?? 0) + 1;
      delete a.creative;
      delete a.creative_shared;
      updateAd(ad.id, { meta_creative_id: null, creative_hash: null, meta_post_id: null, meta_ig_media_id: null, attempts: JSON.stringify(a) });
    }
    const what = patch.copy_override !== undefined ? "Copy" : "Angle (used in the link tags)";
    updateAd(ad.id, { error: `${what} changed after the failure. Press "Retry failed" to create this ad with the new ${patch.copy_override !== undefined ? "copy" : "link tags"}.` });
    logEvent(b.id, ad.id, "info", `${what} of ad ${ad.position} changed after the launch; Retry creates it with the new ${patch.copy_override !== undefined ? "copy" : "link tags"}.`);
  }
}

/** A saved naming template's pattern, when the text is its name or ID; otherwise the text itself. */
export function namingPattern(text: string | undefined, accountDbId?: number): string | undefined {
  if (text === undefined || text === null) return text;
  const t = String(text).trim();
  if (!t) return t;
  const acc = accountDbId ?? getAccount()?.id;
  if (!acc) return t;
  const rows = db().prepare("SELECT id, name, pattern FROM naming_templates WHERE ad_account_id = ?").all(acc) as { id: number; name: string; pattern: string }[];
  const hit = rows.find((r) => r.name.toLowerCase() === t.toLowerCase()) ?? (/^#?\d+$/.test(t) && !t.includes("{") ? rows.find((r) => String(r.id) === t.replace("#", "")) : undefined);
  return hit ? hit.pattern : t;
}

// ---------- Destination checks ----------

const LIVE_AD_STATUSES = ["ACTIVE", "PAUSED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES"];
/** How long a count read from Meta may stand in when Meta is limiting calls (a launch right after its preview). */
const AD_COUNT_KEEP = 15 * 60_000;
/** Meta limiting calls (or the launcher pacing itself to stay under Meta's limit), not a real problem. */
const isPacing = (e: unknown) => e instanceof RateLimitedError || (e instanceof MetaError && e.isThrottle);

/**
 * How many ads each ad set holds (Meta allows 50): one read for all of them (the account's ads edge,
 * filtered by ad set), so a launch into many ad sets doesn't spend one call per ad set. Kept 2 minutes,
 * except at launch (`fresh`). When Meta is limiting calls, a count read in the last 15 minutes is used
 * (`recent`). An ad set with no count has `err`.
 */
async function adCountsOf(accountDbId: number, ids: string[], fresh = false): Promise<Map<string, { n?: number; recent?: boolean; err?: unknown }>> {
  const out = new Map<string, { n?: number; recent?: boolean; err?: unknown }>();
  const todo: string[] = [];
  for (const id of new Set(ids)) {
    const hit = fresh ? undefined : cacheGet<{ n: number | null }>(`adcount:${id}`);
    if (hit) out.set(id, { n: hit.n ?? undefined });
    else todo.push(id);
  }
  if (!todo.length) return out;
  const save = (id: string, n: number | undefined) => {
    cacheSet(`adcount:${id}`, { n: n ?? null }, 2 * 60_000);
    if (n !== undefined) cacheSet(`adcount-recent:${id}`, { n }, AD_COUNT_KEEP);
    out.set(id, { n });
  };
  try {
    const client = clientFor(accountDbId);
    if (todo.length === 1) {
      const r = await client.get<{ summary?: { total_count?: number } }>(`${todo[0]}/ads`, { fields: "id", limit: 1, summary: "total_count", effective_status: LIVE_AD_STATUSES });
      save(todo[0], r.summary?.total_count);
    } else {
      const rows = await client.getAll<{ adset_id?: string }>(
        `${client.accountId}/ads`,
        { fields: "adset_id", filtering: [{ field: "adset.id", operator: "IN", value: todo }], effective_status: LIVE_AD_STATUSES, limit: 500 },
        (MAX_ADS_PER_ADSET + 10) * todo.length,
      );
      const counts = new Map(todo.map((id) => [id, 0]));
      for (const r of rows) if (r.adset_id && counts.has(r.adset_id)) counts.set(r.adset_id, counts.get(r.adset_id)! + 1);
      for (const [id, n] of counts) save(id, n);
    }
  } catch (e) {
    for (const id of todo) {
      const recent = isPacing(e) ? cacheGet<{ n: number }>(`adcount-recent:${id}`) : undefined;
      out.set(id, recent ? { n: recent.n, recent: true } : { err: e });
    }
  }
  return out;
}

const toDest = (f: { campaign: CampaignInfo; adset: AdsetInfo }): AdsetDest => ({
  id: f.adset.id,
  name: f.adset.name,
  is_dynamic_creative: f.adset.isDynamicCreative,
  destination_type: f.adset.destinationType,
  optimization_goal: f.adset.optimizationGoal,
  campaignName: f.campaign.name,
});

/**
 * What Meta says about where the ads go: the Instagram account, the ad set (and the extra ones), how
 * many ads they hold. A check that can't run says so as a warning; it never passes silently.
 * `fresh`: read the ad counts again (launch), and re-read the Instagram list before blocking on it.
 */
async function destinationInfo(b: BatchRow, opts: { fresh?: boolean } = {}): Promise<DestinationInfo> {
  const unchecked: string[] = [];
  let igProblem: string | undefined;
  const preset = batchPreset(b);
  if (preset.igUserId) {
    const who = `Instagram @${preset.igName || preset.igUserId}`;
    try {
      const allowed = (x: Identities) => x.instagram.some((i) => i.id === preset.igUserId);
      let ids = await listIdentities();
      if (ids.instagramKnown && !allowed(ids)) {
        // The list is kept 30 minutes: ask Meta again before blocking (the person may just have fixed it).
        const recheck = `ident-recheck:${b.ad_account_id}`;
        if (opts.fresh || !cacheGet(recheck)) {
          cacheSet(recheck, 1, 2 * 60_000);
          // Only a complete new answer replaces the known "not allowed": Meta not answering is not a yes.
          const again = await listIdentities(true).catch(() => null);
          if (again?.instagramKnown) ids = again;
        }
      }
      if (!ids.instagramKnown) unchecked.push(`Couldn't check whether the ad account may use ${who}: Meta didn't give its list of Instagram accounts.`);
      else if (!allowed(ids)) igProblem = igNotAllowed(getAccount(b.ad_account_id)?.name ?? "this ad account", preset.igName || preset.igUserId);
    } catch (e) {
      unchecked.push(`Couldn't check whether the ad account may use ${who} just now: ${why(e)}`);
    }
  }
  const dest = await adsetInfo(b, opts);
  const all = [...unchecked, ...(dest.unchecked ?? [])];
  return { ...dest, ...(igProblem ? { igProblem } : {}), ...(all.length ? { unchecked: all } : {}) };
}

async function adsetInfo(b: BatchRow, opts: { fresh?: boolean }): Promise<DestinationInfo> {
  if (!b.adset_id) return {};
  const unchecked: string[] = [];
  let f: Awaited<ReturnType<typeof findAdset>>;
  try {
    f = await findAdset(b.adset_id);
  } catch (e) {
    return { unchecked: [`Couldn't check the ad set "${b.adset_name ?? b.adset_id}" in Meta just now: ${why(e)}`] };
  }
  if (!f) return { adset: null };
  // How many ads the ad set already holds (Meta's limit is 50).
  // All the counts in one read (the main ad set and the extra ones). At launch, a count Meta's limit kept
  // the launcher from reading is not a new warning: Meta itself refuses an ad set's 51st ad, so the launch
  // fails safely for that ad instead.
  const counts = b.adset_mode === "existing" ? await adCountsOf(b.ad_account_id, [b.adset_id, ...launchExtras(b).map((x) => x.id)], opts.fresh) : new Map<string, { n?: number; err?: unknown }>();
  const countProblem = (id: string) => {
    const e = counts.get(id)?.err;
    return e !== undefined && !(opts.fresh && isPacing(e)) ? e : undefined;
  };
  let adCount: number | undefined;
  if (b.adset_mode === "existing") {
    adCount = counts.get(b.adset_id)?.n;
    const e = countProblem(b.adset_id);
    if (e !== undefined) unchecked.push(`Couldn't check how many ads "${f.adset.name}" already holds (Meta allows ${MAX_ADS_PER_ADSET}) just now: ${why(e)}`);
  }
  // Copying a template with a minimum spend into a campaign budget campaign: Meta may refuse (u2942).
  let templateMinSpend: string | undefined;
  if (b.adset_mode !== "existing") {
    const copies = b.adset_mode === "new_per_ad" ? getAds(b.id).length : 1;
    const key = `minspend:${b.adset_id}:${copies}`;
    const hit = opts.fresh ? undefined : cacheGet<{ text: string | null }>(key);
    if (hit) templateMinSpend = hit.text ?? undefined;
    else {
      try {
        const client = clientFor(b.ad_account_id);
        const t = await getAdSet(client, b.adset_id);
        const minSpend = Number(t.daily_min_spend_target) || Number(t.lifetime_min_spend_target);
        if (minSpend) {
          const camp = await getCampaign(client, t.campaign_id);
          if (isCbo(camp)) {
            const { currency } = await accountInfo(client);
            templateMinSpend = `"${t.name}" has a minimum spend of ${money(fromMinor(minSpend, currency), currency)} and its campaign uses a campaign budget of ${money(fromMinor(camp.daily_budget || camp.lifetime_budget, currency), currency)}. With ${copies} new ad set${copies === 1 ? "" : "s"}, Meta may refuse plain copies; the launcher then builds them from the same settings without the spend limits.`;
          }
        }
        cacheSet(key, { text: templateMinSpend ?? null }, 2 * 60_000);
      } catch (e) {
        unchecked.push(`Couldn't check the spend limits of the template ad set "${f.adset.name}" just now: ${why(e)}`);
      }
    }
  }
  // The extra ad sets that get the same ads: they must exist, take ads from this tool, and have room.
  const extras: NonNullable<DestinationInfo["extras"]> = [];
  for (const x of launchExtras(b)) {
    try {
      const fx = await findAdset(x.id);
      if (!fx) {
        extras.push({ id: x.id, name: x.name, missing: true });
        continue;
      }
      let n: number | undefined;
      if (b.adset_mode === "existing") {
        n = counts.get(x.id)?.n;
        const e = countProblem(x.id);
        if (e !== undefined) unchecked.push(`Couldn't check how many ads the extra ad set "${fx.adset.name}" already holds just now: ${why(e)}`);
      }
      extras.push({ ...toDest(fx), ad_count: n });
    } catch (e) {
      unchecked.push(`Couldn't check the extra ad set "${x.name}" in Meta just now: ${why(e)}`);
    }
  }
  return {
    adset: { ...toDest(f), ad_count: adCount },
    ...(templateMinSpend ? { templateMinSpend } : {}),
    ...(unchecked.length ? { unchecked } : {}),
    ...(extras.length ? { extras } : {}),
  };
}

// The destination checks of a draft, kept 2 minutes per batch: copy, file and setting changes (and
// polls) show them again without asking Meta. Only valid while the destination settings are the same.
const DEST_TTL = 2 * 60_000;
type DestCache = { sig: string; dest: DestinationInfo; links: [string, string | null][] };
const destSig = (b: BatchRow) => JSON.stringify([b.adset_id, b.adset_mode, b.campaign_id, batchPreset(b).igUserId ?? "", launchExtras(b).map((x) => x.id)]);
function cachedDest(b: BatchRow): DestCache | undefined {
  const hit = cacheGet<DestCache>(`bdest:${b.id}`);
  return hit && hit.sig === destSig(b) ? hit : undefined;
}
function saveDest(b: BatchRow, dest: DestinationInfo, links?: Map<string, string | null>) {
  cacheSet(`bdest:${b.id}`, { sig: destSig(b), dest, links: links ? [...links] : [] } satisfies DestCache, DEST_TTL);
}

// Warnings the person has seen for a draft (any view of it), so a launch can tell new ones apart.
type Warn = { id: string; code: string; text: string };
function warningsOf(p: Preview): Warn[] {
  const out: Warn[] = [];
  for (const c of p.batchChecks) if (c.level === "warning") out.push({ id: `b:${c.code}:${c.code === "dest_unchecked" ? c.message.split(":")[0] : c.message}`, code: c.code, text: c.message });
  for (const a of p.ads) for (const c of a.checks) if (c.level === "warning") out.push({ id: `a${a.id}:${c.code}:${c.code === "link_down" ? a.copy.linkUrl : c.message}`, code: c.code, text: `Ad ${a.position} (${a.creativeName}): ${c.message}` });
  return out;
}
const seenWarnings = (batchId: number) => new Set(cacheGet<string[]>(`wseen:${batchId}`) ?? []);
function rememberWarnings(batchId: number, p: Preview) {
  const seen = seenWarnings(batchId);
  const before = seen.size;
  for (const w of warningsOf(p)) seen.add(w.id);
  if (seen.size !== before || !before) cacheSet(`wseen:${batchId}`, [...seen].slice(-2000), 30 * 86_400_000);
}
/** Warnings that first appear when the launch checks again (landing pages, checks Meta didn't answer). */
const LATE_WARNINGS = new Set(["link_down", "dest_unchecked"]);

export function adsManagerLink(kind: "ad" | "adset" | "campaign", id: string) {
  const act = account().meta_account_id.replace(/^act_/, "");
  const page = { ad: "ads", adset: "adsets", campaign: "campaigns" }[kind];
  return `https://adsmanager.facebook.com/adsmanager/manage/${page}?act=${act}&selected_${kind}_ids=${id}`;
}

export interface BatchView {
  key: string;
  status: string;
  statusLabel: string;
  source: { kind: string; label: string };
  settings: {
    campaignId: string | null;
    campaignName: string | null;
    adsetMode: string;
    adsetId: string | null;
    adsetName: string | null;
    copyTemplateId: number | null;
    copy: Copy;
    adNameTemplate: string;
    adsetNameTemplate: string;
    presetId: number | null;
    preset: Preset | null;
    angle: string;
    persona: string;
    extraAdsets: ExtraAdset[];
    goLive: "paused" | "now" | "at";
    goLiveAt: string | null;
  };
  /** Batches launched together with this one (same ads, other ad sets). */
  together: { key: string; adsetName: string | null; status: string }[];
  cancelRequested: boolean;
  preview: Preview;
  /** True when the preview includes the checks of the destination in Meta (ad set, Instagram, ad counts),
   *  read now or in the last 2 minutes. False: reload with ?dest=1 to see them. */
  destChecked: boolean;
  /** The estimate shown when the batch was launched, for the whole launch (the preview's estimate is for what is left). */
  launchEstimate: string | null;
  /**
   * While this launch runs (this batch or one launched with it into another ad set): the time left for
   * the whole launch, from how fast the ads are really going in, in one plain sentence. null otherwise.
   */
  timeLeft: string | null;
  progress: { total: number; done: number; failed: number; working: number };
  createdAt: string;
  launchedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
  events: { level: string; message: string; at: string }[];
  links: { app: string; campaign: string | null };
  ads: (Preview["ads"][number] & { adsManagerUrl: string | null; reviewLabel: string })[];
  unassigned: { id: number; filename: string; kind: string }[];
  /** The plan that turns the ads on ("now" / "at a time"), once made: its code, status and time. */
  /** stopNote: a turn-on cancelled while it ran, what it had already turned on, in words. */
  goLivePlan: { key: string; status: string; runAt: string | null; stopNote?: string } | null;
  /** When the worker last read Meta's review status for this batch (ISO), or null. */
  reviewCheckedAt: string | null;
  /** When "Stop the launch" was pressed (this batch or one launched with it), or null. */
  stoppedAt: string | null;
  /**
   * The ads are still to be turned on ("now" / "at a time"), but the yes given at launch no longer does
   * it, as things are now (a Stop, a time long past, a Retry that came long after the launch ended; for
   * this batch or one turned on with it): why, in plain words. The turn-on plan is then saved as a draft
   * to check and confirm. null: the yes still holds, or nothing to turn on.
   */
  goLiveHold: string | null;
  /**
   * What a Retry pressed now would meet, when it is more than goLiveHold (a Retry more than an hour after
   * the launch ended): for the Retry button and its question only. null otherwise.
   */
  retryHold: string | null;
  /**
   * Every ad of this batch is in, and the ads are turned on together with the other ad sets of this
   * launch: the ones that must finish first, in plain words ("the launch into ad set "X" is still
   * running"). null otherwise.
   */
  goLiveWaits: string | null;
  /** The turn-on step failed: one plain sentence while the worker tries again, or after it gave up; else null. */
  goLiveNote: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Not launched yet",
  queued: "Waiting to start",
  running: "Launching",
  done: "All ads created",
  partial: "Some ads failed",
  failed: "Failed",
};

export interface BatchViewOptions {
  /** Read the destination checks from Meta now (page load with ?dest=1). */
  withDestination?: boolean;
  /** Destination checks already read (runPreview, launch): used as they are. */
  dest?: DestinationInfo;
  /** Landing-page results (checkLinks). */
  linkResults?: Map<string, string | null>;
  /** Save the checks and the estimate (the full check). */
  persist?: boolean;
  /** Read the ad counts fresh from Meta (launch). */
  fresh?: boolean;
  /** Count this view's warnings as seen by the person (default true; a launch's own check is not). */
  remember?: boolean;
}

/**
 * The batch as the page and Claude show it. Without options it never reads Meta: the destination
 * checks come from the last 2 minutes (if the destination settings are unchanged).
 */
export async function batchView(key: string, opts: BatchViewOptions = {}): Promise<BatchView> {
  const b = batchOr404(key);
  const isDraft = b.status === "draft";
  let dest: DestinationInfo = {};
  let links = opts.linkResults;
  let destChecked = false;
  if (isDraft) {
    const cached = cachedDest(b);
    if (opts.dest || opts.withDestination) {
      dest = opts.dest ?? (await destinationInfo(b, { fresh: opts.fresh }));
      destChecked = true;
      // Landing-page results of a recent "Check" stay shown (same addresses only).
      const merged = new Map<string, string | null>(cached?.links ?? []);
      for (const [u, p] of links ?? []) merged.set(u, p);
      links = merged;
      saveDest(b, dest, links);
    } else if (cached) {
      dest = cached.dest;
      links = new Map(cached.links);
      destChecked = true;
    }
  }
  const limits = accountLimits(b.ad_account_id);
  const preview = buildPreview(b.id, dest, limits, { namePrefix: config.namePrefix, linkResults: links, persist: opts.persist });
  if (isDraft && opts.remember !== false) rememberWarnings(b.id, preview);
  const fresh = batchOr404(key);
  const ads = getAds(b.id);
  const events = (db().prepare("SELECT level, message, created_at AS at FROM events WHERE batch_id = ? ORDER BY id DESC LIMIT 60").all(b.id) as { level: string; message: string; at: string }[]);
  const unassigned = db().prepare("SELECT id, filename, kind FROM assets WHERE batch_id = ? AND ad_id IS NULL").all(b.id) as { id: number; filename: string; kind: string }[];
  // The ads are still to be turned on by the yes given at launch: what the worker will meet (with the
  // batches turned on together with this one), and what a Retry pressed now would meet.
  const pending = fresh.status !== "draft" && fresh.go_live !== "paused" && !fresh.go_live_done;
  const group = pending ? turnOnGroup(fresh) : [];
  const hold = pending ? groupHold(fresh, group) : null;
  const retryHold = pending && !isLaunching(fresh) ? groupHold(fresh, group, { retryNow: true }) : null;
  return {
    key: b.key,
    status: fresh.status,
    statusLabel: STATUS_LABEL[fresh.status] ?? fresh.status,
    source: { kind: b.source_kind, label: b.source_label },
    settings: {
      campaignId: fresh.campaign_id,
      campaignName: fresh.campaign_name,
      adsetMode: fresh.adset_mode,
      adsetId: fresh.adset_id,
      adsetName: fresh.adset_name,
      copyTemplateId: fresh.copy_template_id,
      copy: batchCopy(fresh),
      adNameTemplate: fresh.ad_name_template,
      adsetNameTemplate: fresh.adset_name_template,
      presetId: fresh.preset_id,
      preset: fresh.preset ? json<Preset>(fresh.preset, null as unknown as Preset) : null,
      angle: fresh.angle,
      persona: fresh.persona,
      extraAdsets: launchExtras(fresh),
      goLive: fresh.go_live,
      goLiveAt: fresh.go_live_at,
    },
    together: siblings(fresh).filter((x) => x.id !== fresh.id).map((x) => ({ key: x.key, adsetName: x.adset_name, status: x.status })),
    cancelRequested: !!fresh.cancel_requested,
    preview,
    destChecked,
    launchEstimate: fresh.estimate_seconds ? humanDuration(fresh.estimate_seconds) : null,
    timeLeft: isDraft ? null : (launchTimeLeft(fresh, limits)?.text ?? null),
    progress: {
      total: ads.length,
      done: ads.filter((a) => a.status === "done").length,
      failed: ads.filter((a) => a.status === "failed").length,
      working: ads.filter((a) => a.status === "working" || a.status === "waiting").length,
    },
    createdAt: fresh.created_at,
    launchedAt: fresh.launched_at,
    finishedAt: fresh.finished_at,
    createdBy: fresh.created_by,
    events,
    links: { app: `${config.appUrl}/batches/${b.key}`, campaign: fresh.campaign_id ? adsManagerLink("campaign", fresh.campaign_id) : null },
    ads: preview.ads.map((a) => ({ ...a, adsManagerUrl: a.metaAdId ? adsManagerLink("ad", a.metaAdId) : null, reviewLabel: reviewLabel(a.effectiveStatus) })),
    unassigned,
    goLivePlan: fresh.go_live === "paused" ? null : goLivePlan(b.key),
    reviewCheckedAt: reviewCheckedAt(b.id),
    stoppedAt: fresh.stopped_at ?? null,
    goLiveHold: hold,
    retryHold: retryHold && retryHold !== hold ? retryHold : null,
    goLiveWaits: pending && ads.length && ads.every((a) => a.status === "done") ? groupWaits(fresh, group) : null,
    goLiveNote: goLiveNote(b.id),
  };
}

/** Full check: the destination in Meta and each landing page. Saves the result and returns the view with it. */
export async function runPreview(key: string, opts: { fresh?: boolean; linkResults?: Map<string, string | null>; remember?: boolean } = {}): Promise<BatchView> {
  const b = batchOr404(key);
  if (b.status !== "draft") return batchView(key);
  const dest = await destinationInfo(b, { fresh: opts.fresh });
  const urls = getAds(b.id).map((a) => adCopy(b, a).linkUrl).filter(Boolean);
  const linkResults = opts.linkResults ?? (await checkLinks(urls));
  return batchView(key, { dest, linkResults, persist: true, remember: opts.remember });
}

/** A draft copy of batch `b` for one more ad set: same files, grouping, copy and settings. */
function cloneForAdset(b: BatchRow, x: ExtraAdset, group: string): string {
  const d = db();
  return d.transaction(() => {
    const id = newBatch(b.ad_account_id, b.created_by, { kind: b.source_kind, ref: b.source_ref ?? undefined, label: b.source_label });
    const key = (d.prepare("SELECT key FROM batches WHERE id = ?").get(id) as { key: string }).key;
    d.prepare(
      `UPDATE batches SET campaign_id = ?, campaign_name = ?, adset_mode = ?, adset_id = ?, adset_name = ?, copy_template_id = ?, copy = ?,
         ad_name_template = ?, adset_name_template = ?, preset_id = ?, preset = ?, angle = ?, persona = ?, go_live = ?, go_live_at = ?, group_key = ?, extra_adsets = '[]' WHERE id = ?`,
    ).run(x.campaignId, x.campaignName, b.adset_mode, x.id, x.name, b.copy_template_id, b.copy, b.ad_name_template, b.adset_name_template, b.preset_id, b.preset, b.angle, b.persona, b.go_live, b.go_live_at, group, id);
    for (const ad of getAds(b.id)) {
      const newAd = Number(d.prepare("INSERT INTO ads (batch_id, position, key, creative_name, angle, copy_override) VALUES (?, ?, ?, ?, ?, ?)").run(id, ad.position, `${key}-${String(ad.position).padStart(2, "0")}`, ad.creative_name, ad.angle, ad.copy_override).lastInsertRowid);
      d.prepare(
        `INSERT INTO assets (batch_id, ad_id, source_kind, source_ref, rel_path, filename, kind, mime, size_bytes, width, height, duration_sec, ratio, local_path, sha256)
         SELECT ?, ?, source_kind, source_ref, rel_path, filename, kind, mime, size_bytes, width, height, duration_sec, ratio, CASE WHEN source_kind = 'drive' THEN NULL ELSE local_path END, sha256 FROM assets WHERE ad_id = ?`,
      ).run(id, newAd, ad.id);
    }
    return key;
  })();
}

/**
 * The summary shown before the launch is confirmed: accounts, budgets, total, schedule, copy.
 * Kept a minute while nothing it depends on changes. A launched batch's summary reads nothing
 * from Meta (the page doesn't show it). The launch itself always reads Meta again.
 */
export async function batchLaunchSummary(key: string) {
  const b = batchOr404(key);
  if (b.status !== "draft") return { connection: await connectionSummary(batchPreset(b), { cachedOnly: true }), launch: null };
  const sig = JSON.stringify([b.adset_id, b.campaign_id, b.adset_mode, launchExtras(b).map((x) => x.id), b.go_live, b.go_live_at, b.copy, b.preset, getAds(b.id).map((a) => [a.id, a.copy_override])]);
  type Sum = { connection: ConnectionSummary; launch: Awaited<ReturnType<typeof launchSummary>> | null };
  const hit = cacheGet<{ sig: string; value: Sum }>(`bsum:${b.id}`);
  if (hit?.sig === sig) return hit.value;
  const [connection, launch] = await Promise.all([
    connectionSummary(batchPreset(b)),
    b.adset_id ? launchSummary(b, { mode: b.go_live, at: b.go_live_at }) : Promise.resolve(null),
  ]);
  const value: Sum = { connection, launch };
  cacheSet(`bsum:${b.id}`, { sig, value }, 60_000);
  return value;
}

/**
 * Launch a draft. `acceptWarnings`: the number of warnings the person saw (or true). A launch that
 * finds a landing-page or "couldn't check" warning the person has not seen, or more warnings than were
 * seen, is refused, naming them.
 */
export async function launchBatch(key: string, opts: { confirm?: boolean; acceptWarnings?: boolean | number; spendConfirmation?: string }) {
  if (opts.confirm !== true) throw new HttpError(400, "Launching needs confirm: true.");
  const b = batchOr404(key);
  if (b.status !== "draft") throw new HttpError(409, `This batch is already ${STATUS_LABEL[b.status]?.toLowerCase() ?? b.status}.`);
  const acc = getAccount(b.ad_account_id);
  if (acc?.token_expires_at && acc.token_expires_at < Date.now()) {
    throw new HttpError(409, "The Meta login has expired, so nothing could be created. Open Settings → Meta connection and click Reconnect Meta, then launch again.");
  }
  if (b.go_live === "at" && (!b.go_live_at || !(timeMs(b.go_live_at) > Date.now()))) throw new HttpError(400, "Pick a time in the future to turn the ads on, or launch them paused.");
  const seenBefore = seenWarnings(b.id);
  // The full check, with the destination read fresh from Meta: the launch decides on exactly this.
  const dest = await destinationInfo(b, { fresh: true });
  const links = await checkLinks(getAds(b.id).map((a) => adCopy(b, a).linkUrl).filter(Boolean));
  const view = await batchView(key, { dest, linkResults: links, persist: true, remember: false });
  // Strict guardrail: a launch that turns ads on needs the total daily budget typed back.
  let spend: string | null = null;
  let spendAt: string | null = null;
  if (b.go_live !== "paused") {
    const sum = await launchSummary(b, { mode: b.go_live, at: b.go_live_at });
    spend = sum.spendConfirmation;
    spendAt = sum.spendAt;
    const blocking = sum.checks.filter((c) => c.level === "error");
    if (blocking.length) throw new HttpError(422, `This launch turns ads on, but:\n- ${blocking.map((c) => c.message).join("\n- ")}`);
    const ceiling = getAppSettings().dailyBudgetCeiling;
    if (ceiling && sum.totalDailyBudget > ceiling) {
      throw new HttpError(422, `This launch would let ${sum.totalDailyLabel} a day spend${sum.lifetimeBudgets.length ? " (lifetime budgets counted per day)" : ""}, above the daily budget ceiling of ${money(ceiling, sum.account.currency)} set in Settings → Safety. Lower the budgets or launch paused.`);
    }
    if (!opts.spendConfirmation || !sameAmount(opts.spendConfirmation, sum.spendConfirmation ?? "")) {
      throw new HttpError(
        422,
        `${opts.spendConfirmation ? "The total you typed doesn't match. " : ""}This launch turns the ads on${b.go_live === "at" ? " at the chosen time" : ""}, so Meta will spend money. Check every budget in the summary, then confirm by typing the total daily budget exactly as shown: ${sum.spendConfirmation}.`,
      );
    }
  }
  if (view.preview.errors > 0) {
    const list = [...view.preview.batchChecks, ...view.preview.ads.flatMap((a) => a.checks.map((c) => ({ ...c, message: `Ad ${a.position} (${a.creativeName}): ${c.message}` })))].filter((c) => c.level === "error");
    throw new HttpError(422, `Fix these first:\n- ${list.map((c) => c.message).join("\n- ")}`);
  }
  const warnings = warningsOf(view.preview);
  if (warnings.length) {
    const raw = opts.acceptWarnings as unknown;
    const accepted = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : (raw as boolean | number | undefined);
    if (!accepted) throw new HttpError(422, `There ${warnings.length === 1 ? "is 1 warning" : `are ${warnings.length} warnings`}. Read them in the preview and accept them to launch.`);
    // Compared one by one, not by count: a landing page that first fails now, or a check Meta didn't
    // answer, is refused even when another warning went away meanwhile (same number of warnings).
    const unseen = warnings.filter((w) => !seenBefore.has(w.id));
    const late = unseen.filter((w) => LATE_WARNINGS.has(w.code));
    // A number (the warnings the person saw): every warning not seen is new, whatever the count.
    const fresh = typeof accepted === "number" ? (unseen.length ? unseen : warnings.length > accepted ? warnings : []) : late;
    if (fresh.length) {
      rememberWarnings(b.id, view.preview); // they are shown now, in this answer
      const n = typeof accepted === "number" ? Math.max(fresh.length, warnings.length - accepted) : fresh.length;
      throw new HttpError(422, `${n === 1 ? "1 new warning" : `${n} new warnings`} since you checked:\n- ${fresh.slice(0, 10).map((w) => w.text).join("\n- ")}${fresh.length > 10 ? `\n- and ${fresh.length - 10} more` : ""}\nRead ${n === 1 ? "it" : "them"}, then launch again${typeof accepted === "number" ? ` accepting ${warnings.length} warnings` : ""}.`);
    }
  }
  // Same ads into more ad sets: one batch per extra ad set (never the main one, never twice), checked before anything is queued.
  const extras = launchExtras(b);
  const sibs: string[] = [];
  if (extras.length) {
    const group = b.group_key ?? b.key;
    updateBatch(b.id, { group_key: group });
    for (const x of extras) sibs.push(cloneForAdset(b, x, group));
    for (const k of sibs) {
      // The main check just read the extra ad sets' counts, so this asks Meta nothing new.
      const v = await runPreview(k, { linkResults: links, remember: false });
      if (v.preview.errors > 0) {
        for (const kk of sibs) deleteDraft(kk);
        const list = v.preview.batchChecks.filter((c) => c.level === "error").map((c) => c.message);
        throw new HttpError(422, `The copy for ad set "${v.settings.adsetName}" can't launch:\n- ${list.join("\n- ") || "see the preview"}`);
      }
    }
  }
  // Only one launch per batch, even from two tabs or Claude at the same moment.
  // The total typed back is kept: the turn-on plan made after the launch is queued only if what it can spend is not more.
  const won = db().prepare("UPDATE batches SET status = 'queued', warnings_accepted = ?, go_live_total = ?, go_live_total_at = ? WHERE id = ? AND status = 'draft'").run(opts.acceptWarnings ? 1 : 0, spend, spendAt, b.id).changes;
  if (!won) {
    for (const kk of sibs) deleteDraft(kk);
    throw new HttpError(409, "This batch is already launching.");
  }
  const when = b.go_live === "now" ? " The ads are turned on once all are created." : b.go_live === "at" ? ` The ads are turned on at ${istTime(b.go_live_at!)}.` : "";
  logEvent(b.id, null, "info", `Queued for launch. Estimated time: ${view.preview.estimate.text}.${when}${spend ? ` Confirmed total daily budget: ${spend}.` : ""}`);
  enqueue("launch", b.id);
  for (const k of sibs) {
    const s2 = batchOr404(k);
    db().prepare("UPDATE batches SET status = 'queued', warnings_accepted = ?, go_live_total = ?, go_live_total_at = ? WHERE id = ?").run(opts.acceptWarnings ? 1 : 0, spend, spendAt, s2.id);
    logEvent(s2.id, null, "info", `Queued with batch ${b.key} (same ads, ad set "${s2.adset_name}").`);
    enqueue("launch", s2.id);
  }
  return batchView(key);
}

export interface RetryResult {
  /** Ads put back in the queue. */
  retried: number;
  /** True when no ad failed but the ads still had to be turned on: the go-live is queued again. */
  goLive: boolean;
  message: string;
}

/**
 * Retry the ads not created yet (failed, or left half-way). Ads already in Meta are never touched.
 * `presetId` / `copyTemplateId`: use another settings preset or copy template for those ads.
 * When every ad is in but the ads were not turned on yet ("now" / "at a time"), the go-live runs again.
 */
export function retryFailed(key: string, opts: { presetId?: number | string; copyTemplateId?: number | string } = {}): RetryResult {
  const b = batchOr404(key);
  if (b.status === "running" || b.status === "queued") throw new HttpError(409, "This batch is still running.");
  if (b.status === "draft") throw new HttpError(409, "This batch hasn't been launched yet.");
  const left = getAds(b.id).filter((a) => a.status !== "done").length;
  const goLivePending = b.go_live !== "paused" && !b.go_live_done;
  // Nothing to do: refused before anything changes (the preset and copy template stay as they are).
  if (!left && !goLivePending) {
    updateBatch(b.id, { status: "done" });
    const plan = b.go_live !== "paused" ? goLivePlan(b.key) : null;
    const planText = plan?.status === "draft"
      ? ` The plan that turns the ads on (${plan.key}) is waiting for your confirmation.`
      : plan?.status === "cancelled"
        ? ` The plan that was to turn the ads on (${plan.key}) was cancelled, so the ads stay paused. Turn them on from the Campaigns page when you're ready.`
        : "";
    throw new HttpError(409, `No failed ads to retry.${planText}`);
  }
  // Another preset or copy template is only for ads still to create.
  const changed = left && (given(opts?.presetId) || given(opts?.copyTemplateId)) ? changeAfterLaunch(b, account().id, { presetId: opts.presetId, copyTemplateId: opts.copyTemplateId }) : null;
  // A Retry more than an hour after the later of the set time ("at a time") and the end of the run before
  // it is not the launch that was confirmed; kept on the batch (also for a later Retry), with that time.
  const late = goLivePending ? lateRetryFrom(b) : null;
  // Every ad in: only the turn-on step runs again (a "golive" job: no new launch run, no review check
  // moved, no backup); the batch stays done. Otherwise the launch runs again for the ads not created.
  const won = db()
    .prepare(`UPDATE batches SET status = ${left ? "'queued'" : "'done'"}, cancel_requested = 0, retried_at = ?, late_retry_from = COALESCE(late_retry_from, ?) WHERE id = ? AND status NOT IN ('running', 'queued', 'draft')`)
    .run(new Date().toISOString(), late, b.id).changes;
  if (!won) throw new HttpError(409, "This batch is already running.");
  // The worker's go-live tries start again from 0.
  cacheDelete(`golive_retry:${b.id}:`);
  const n = resetFailed(b.id);
  const fresh = batchOr404(key);
  const at = timeMs(fresh.go_live_at);
  // After a Stop, or a Retry long after the launch ended (this batch or one turned on with it), the yes
  // given at launch no longer turns the ads on.
  const group = goLivePending ? turnOnGroup(fresh) : [];
  const hold = goLivePending ? groupHold(fresh, group) : null;
  const typed = fresh.go_live_total;
  const asTyped = ` with the budgets confirmed at launch (${typed} a day). If what can spend has gone up since, they are not turned on: a turn-on plan is saved as a draft to check and confirm.`;
  const together = group.length > 1 ? ", together with the other ad sets of this launch" : "";
  const goLiveText = !goLivePending
    ? ""
    : hold
      ? ` The ads are NOT turned on by themselves: ${hold}, so the budget confirmation given at launch is not used. Once every ad is in, a turn-on plan is saved as a draft to check and confirm.`
      : !typed
        ? ` The ads are NOT turned on by themselves: this launch is from before the total daily budget was typed at launch. Once every ad is in${together}, a turn-on plan is saved as a draft to check and confirm.`
        : fresh.go_live === "at" && at > Date.now()
        ? ` The ads are turned on at ${istTime(fresh.go_live_at!)} once every ad is in${together}${asTyped}`
        : ` The ads are turned on once every ad is in${together}${asTyped}`;
  if (!n) {
    const waits = groupWaits(fresh, group);
    const message = hold || !fresh.go_live_total
      ? `Every ad is already in Meta.${goLiveText}`
      : waits
        ? `Every ad is already in Meta. They are turned on together with the other ad sets of this launch, once every ad is in there too: ${waits}.`
        : `Every ad is already in Meta; turning them on again.${goLiveText}`;
    logEvent(b.id, null, "info", message);
    enqueue("golive", b.id);
    return { retried: 0, goLive: true, message };
  }
  const message = `Retrying ${n} ad${n > 1 ? "s" : ""} not created yet${changed ? ` with the ${changed}` : ""}. Ads that already went through are not touched.${goLiveText}`;
  logEvent(b.id, null, "info", message);
  enqueue("launch", b.id);
  return { retried: n, goLive: false, message };
}

export function refreshReview(key: string) {
  const b = batchOr404(key);
  enqueue("review", b.id);
}

export function listBatches(limit = 50) {
  const rows = db().prepare("SELECT * FROM batches ORDER BY id DESC LIMIT ?").all(limit) as BatchRow[];
  return rows.map((b) => {
    const counts = db().prepare("SELECT COUNT(*) AS total, SUM(status = 'done') AS done, SUM(status = 'failed') AS failed FROM ads WHERE batch_id = ?").get(b.id) as { total: number; done: number | null; failed: number | null };
    return {
      key: b.key,
      status: b.status,
      statusLabel: STATUS_LABEL[b.status] ?? b.status,
      source: b.source_label || (b.source_kind === "drive" ? "Google Drive" : "Uploaded files"),
      destination: b.adset_mode === "new_per_ad" ? `${b.campaign_name ?? "?"} → new ad set per ad` : b.adset_mode === "new_shared" ? `${b.campaign_name ?? "?"} → one new ad set` : `${b.campaign_name ?? "?"} → ${b.adset_name ?? "?"}`,
      ads: counts.total,
      done: counts.done ?? 0,
      failed: counts.failed ?? 0,
      createdBy: b.created_by,
      createdAt: b.created_at,
      launchedAt: b.launched_at,
    };
  });
}

/** Delete a draft and the files only it used (uploads another batch still points to stay). */
export function deleteDraft(key: string) {
  const b = batchOr404(key);
  if (b.status !== "draft") throw new HttpError(409, "Only batches that were never launched can be deleted.");
  const files = db().prepare("SELECT DISTINCT local_path FROM assets WHERE batch_id = ? AND local_path IS NOT NULL").pluck().all(b.id) as string[];
  db().prepare("DELETE FROM batches WHERE id = ?").run(b.id);
  for (const p of ["batch", "bdest", "bsum", "wseen"]) cacheDelete(`${p}:${b.id}`);
  removeUnusedUploads(files, b.key);
}

/** Meta's own preview of one ad, per placement, before it is created. Images are uploaded to the
 *  ad account's library (reused at launch); videos need to be uploaded already. */
export async function adPreviews(key: string, ad: number | string) {
  const b = batchOr404(key);
  const row = getAds(b.id).find((a) => String(a.position) === String(ad) || a.creative_name.toLowerCase() === String(ad).toLowerCase());
  if (!row) throw new HttpError(404, `Batch ${key} has no ad ${ad}.`);
  const client = clientFor(b.ad_account_id);
  const tmpDir = path.join(config.dataDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const creative = await previewCreative({ client, files: anyFiles, clock: realClock, accountDbId: b.ad_account_id, tmpDir }, b, row);
    return { ad: row.position, name: row.name || row.creative_name, previews: await creativePreviews(client, creative) };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, e instanceof MetaError ? plainError(e, "Making the preview") : (e as Error).message);
  }
}

/** Delivery and review of a batch's ads and ad sets, after launch. */
export async function batchDelivery(key: string) {
  const b = batchOr404(key);
  const ads = getAds(b.id).filter((a) => a.meta_ad_id);
  if (!ads.length) return { rows: [] };
  const client = clientFor(b.ad_account_id);
  return { rows: await deliveryStatus(client, { adsets: [...new Set(ads.map((a) => a.meta_adset_id!).filter(Boolean))], ads: ads.map((a) => a.meta_ad_id!) }) };
}
