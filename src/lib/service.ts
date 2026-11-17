import { config } from "./config";
import { db, json } from "./db";
import { reviewLabel, resetFailed } from "./engine/launcher";
import { DEFAULT_UTM, META_URL_PARAMS, NAME_TOKENS } from "./engine/naming";
import { humanDuration } from "./engine/estimate";
import { autoGroup, buildPreview, checkLinks, moveAsset, type DestinationInfo, type Preview } from "./engine/preview";
import { extraAdsets, launchSummary, siblings, type ExtraAdset } from "./manage/golive";
import { istTime } from "./manage/objects";
import { sameAmount } from "./manage/plan";
import { enqueue } from "./jobs";
import { clientFor, learnedCap } from "./meta/factory";
import { FEATURES } from "./meta/features";
import { defaultPreset, newBatch, presetFromRow } from "./setup";
import { igLink, pageLink } from "./meta/connect";
import { folderName, importDriveFolder, parseFolderId } from "./sources/drive";
import { adCopy, batchCopy, batchPreset, cacheDelete, cacheGet, cacheSet, getAccount, getAds, getBatchByKey, logEvent, updateAd, updateBatch } from "./store";
import type { BatchRow, Copy, CopyOverride, Preset } from "./types";
import { HttpError } from "./httperror";

// Everything the web app and Claude (through the API) can do. Routes stay thin.

export const CTA_TYPES = ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "BOOK_NOW", "CONTACT_US", "GET_QUOTE", "APPLY_NOW", "DOWNLOAD", "SUBSCRIBE", "GET_OFFER", "ORDER_NOW", "WATCH_MORE", "SEE_MORE", "REQUEST_TIME", "GET_DIRECTIONS", "WHATSAPP_MESSAGE", "CALL_NOW", "NO_BUTTON"];

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

// ---------- Destinations ----------

export interface AdsetInfo {
  id: string;
  name: string;
  status: string;
  isDynamicCreative: boolean;
}
export interface CampaignInfo {
  id: string;
  name: string;
  status: string;
  objective: string;
  adsets: AdsetInfo[];
}

export async function listDestinations(refresh = false): Promise<{ campaigns: CampaignInfo[]; fetchedAt: string }> {
  const acc = account();
  const key = `dest:${acc.id}`;
  if (!refresh) {
    const hit = cacheGet<{ campaigns: CampaignInfo[]; fetchedAt: string }>(key);
    if (hit) return hit;
  }
  const client = clientFor(acc.id);
  const live = ["ACTIVE", "PAUSED", "IN_PROCESS", "WITH_ISSUES", "CAMPAIGN_PAUSED"];
  const [campaigns, adsets] = await Promise.all([
    client.getAll<{ id: string; name: string; status: string; objective: string }>(`${client.accountId}/campaigns`, { fields: "id,name,status,objective", effective_status: live.filter((s) => s !== "CAMPAIGN_PAUSED") }),
    client.getAll<{ id: string; name: string; status: string; campaign_id: string; is_dynamic_creative?: boolean }>(`${client.accountId}/adsets`, { fields: "id,name,status,campaign_id,is_dynamic_creative", effective_status: live }),
  ]);
  const out = {
    fetchedAt: new Date().toISOString(),
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      adsets: adsets.filter((a) => a.campaign_id === c.id).map((a) => ({ id: a.id, name: a.name, status: a.status, isDynamicCreative: !!a.is_dynamic_creative })),
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

function matchByName<T extends { id: string | number; name: string }>(list: T[], q: string): T | undefined {
  const s = q.trim().toLowerCase();
  return list.find((x) => String(x.id) === q.trim()) ?? list.find((x) => x.name.toLowerCase() === s) ?? list.find((x) => x.name.toLowerCase().includes(s));
}

// ---------- Templates ----------

interface CopyRow { id: number; name: string; primary_texts: string; headlines: string; description: string; cta: string; link_url: string; utm_template: string }

export function copyFromRow(r: CopyRow): Copy & { id: number; name: string } {
  return { id: r.id, name: r.name, primaryTexts: JSON.parse(r.primary_texts) as string[], headlines: JSON.parse(r.headlines) as string[], description: r.description, cta: r.cta, linkUrl: r.link_url, utmTemplate: r.utm_template };
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

export function saveCopyTemplate(t: Partial<Copy> & { id?: number; name: string }) {
  const acc = account();
  const texts = (t.primaryTexts ?? []).map((x) => x.trim()).filter(Boolean);
  const heads = (t.headlines ?? []).map((x) => x.trim()).filter(Boolean);
  if (!t.name?.trim()) throw new HttpError(400, "Give the copy template a name.");
  if (texts.length > 5 || heads.length > 5) throw new HttpError(400, "Up to 5 primary texts and 5 headlines.");
  if (t.cta && !CTA_TYPES.includes(t.cta)) throw new HttpError(400, `Unknown call-to-action ${t.cta}.`);
  // New templates get UTM tags by default, so analytics and the CRM show which ad brought each lead.
  const utm = t.utmTemplate === undefined && !t.id ? DEFAULT_UTM : (t.utmTemplate ?? "").trim();
  const vals = [t.name.trim(), JSON.stringify(texts), JSON.stringify(heads), t.description ?? "", t.cta ?? "LEARN_MORE", (t.linkUrl ?? "").trim(), utm];
  if (t.id) {
    db().prepare("UPDATE copy_templates SET name=?, primary_texts=?, headlines=?, description=?, cta=?, link_url=?, utm_template=?, updated_at=datetime('now') WHERE id=? AND ad_account_id=?").run(...vals, t.id, acc.id);
    return t.id;
  }
  return Number(db().prepare("INSERT INTO copy_templates (name, primary_texts, headlines, description, cta, link_url, utm_template, ad_account_id) VALUES (?,?,?,?,?,?,?,?)").run(...vals, acc.id).lastInsertRowid);
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

export function savePreset(p: Partial<Preset> & { id?: number; name: string; isDefault?: boolean }) {
  const acc = account();
  if (!p.name?.trim()) throw new HttpError(400, "Give the preset a name.");
  const on: Record<string, "OPT_IN"> = {};
  const unknown = Object.keys(p.enhancements ?? {}).filter((k) => !FEATURES.some((f) => f.key === k));
  if (unknown.length) throw new HttpError(400, `Unknown enhancement${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Known: ${FEATURES.map((f) => f.key).join(", ")}.`);
  for (const [k, v] of Object.entries(p.enhancements ?? {})) if (v === "OPT_IN" || (v as unknown) === true || (v as unknown) === "on") on[k] = "OPT_IN";
  const vals = [p.name.trim(), p.pageId ?? "", p.pageName ?? "", p.igUserId ?? "", p.igName ?? "", JSON.stringify(on), p.multiAdvertiser ? 1 : 0];
  return db().transaction(() => {
    if (p.isDefault) db().prepare("UPDATE settings_presets SET is_default = 0 WHERE ad_account_id = ?").run(acc.id);
    if (p.id) {
      db().prepare("UPDATE settings_presets SET name=?, page_id=?, page_name=?, ig_user_id=?, ig_name=?, enhancements=?, multi_advertiser=?, is_default=COALESCE(?, is_default) WHERE id=? AND ad_account_id=?")
        .run(...vals, p.isDefault === undefined ? null : p.isDefault ? 1 : 0, p.id, acc.id);
      return p.id;
    }
    return Number(db().prepare("INSERT INTO settings_presets (name, page_id, page_name, ig_user_id, ig_name, enhancements, multi_advertiser, is_default, ad_account_id) VALUES (?,?,?,?,?,?,?,?,?)").run(...vals, p.isDefault ? 1 : 0, acc.id).lastInsertRowid);
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
}

/** Facebook Pages and Instagram accounts this ad account can use, with photo, ID and link. */
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
  const pages = await client
    .getAll<PageRow>(`${client.accountId}/promote_pages`, { fields: "id,name,picture{url}" })
    .catch(() => client.getAll<PageRow>(`${client.accountId}/promote_pages`, { fields: "id,name" }))
    .catch(() => [] as PageRow[]);
  let instagramKnown = true;
  const instagram = await client
    .getAll<IgRow>(`${client.accountId}/instagram_accounts`, { fields: "id,username,profile_pic" })
    .catch(() => client.getAll<IgRow>(`${client.accountId}/instagram_accounts`, { fields: "id,username" }))
    .catch(() => {
      instagramKnown = false;
      return [] as IgRow[];
    });
  const out: Identities = {
    pages: pages.map((p) => ({ id: p.id, name: p.name, pictureUrl: p.picture?.data?.url ?? null, link: pageLink(p.id) })),
    instagram: instagram.map((i) => ({ id: i.id, username: i.username, pictureUrl: i.profile_pic ?? null, link: igLink(i.username) })),
    instagramKnown,
  };
  cacheSet(key, out, 30 * 60_000);
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
 *  `preset` defaults to the default settings preset. */
export async function connectionSummary(preset?: Preset | null): Promise<ConnectionSummary> {
  const acc = getAccount();
  if (!acc?.token_enc) {
    return { connected: false, adAccount: null, page: null, instagram: null, loginBy: null, loginExpiresAt: null, loginExpired: false, problems: ["Meta is not connected. Open Settings → Meta connection → Connect Meta."] };
  }
  const p = preset ?? defaultPreset(acc.id) ?? null;
  const problems: string[] = [];
  let ids: Identities | null = null;
  try {
    ids = await listIdentities();
  } catch {
    problems.push("Couldn't ask Meta for the Page and Instagram details just now.");
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
  adsetMode?: "existing" | "new_per_ad";
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
  goLiveAt?: string | null;
}

export async function createBatch(email: string, opts: { driveFolder?: string } & BatchSettings = {}): Promise<string> {
  const acc = account();
  let source: { kind: "drive" | "upload"; ref?: string; label?: string } = { kind: "upload" };
  let folderId: string | null = null;
  if (opts.driveFolder) {
    folderId = parseFolderId(opts.driveFolder);
    if (!folderId) throw new HttpError(400, "That doesn't look like a Google Drive folder link.");
    source = { kind: "drive", ref: folderId, label: await folderName(email, folderId) };
  }
  const id = newBatch(acc.id, email, source);
  const key = (db().prepare("SELECT key FROM batches WHERE id = ?").get(id) as { key: string }).key;
  if (folderId) {
    await importDriveFolder(id, email, folderId);
    autoGroup(id);
  }
  await updateSettings(key, opts);
  return key;
}

export async function updateSettings(key: string, s: BatchSettings) {
  const b = batchOr404(key);
  if (b.status !== "draft") throw new HttpError(409, "This batch has been launched; its settings can't change.");
  const patch: Record<string, string | number | null> = {};
  const acc = account();

  if (s.adsetMode) patch.adset_mode = s.adsetMode;
  if (s.adsetId) {
    let found = await findAdset(s.adsetId);
    if (!found) {
      const d = await listDestinations();
      const all = d.campaigns.flatMap((c) => c.adsets.map((a) => ({ ...a, campaign: c })));
      const m = matchByName(all, s.adsetId);
      if (m) found = { campaign: m.campaign, adset: m };
    }
    if (!found) throw new HttpError(400, `Couldn't find an ad set called "${s.adsetId}". Use list_destinations to see the names.`);
    patch.adset_id = found.adset.id;
    patch.adset_name = found.adset.name;
    patch.campaign_id = found.campaign.id;
    patch.campaign_name = found.campaign.name;
  } else if (s.campaignId) {
    const d = await listDestinations();
    const c = matchByName(d.campaigns, s.campaignId);
    if (!c) throw new HttpError(400, `Couldn't find a campaign called "${s.campaignId}".`);
    patch.campaign_id = c.id;
    patch.campaign_name = c.name;
    if (b.campaign_id !== c.id) {
      patch.adset_id = null;
      patch.adset_name = null;
    }
  }
  if (s.copyTemplateId !== undefined && s.copyTemplateId !== "") {
    const list = (db().prepare("SELECT * FROM copy_templates WHERE ad_account_id = ?").all(acc.id) as CopyRow[]).map(copyFromRow);
    const t = matchByName(list, String(s.copyTemplateId));
    if (!t) throw new HttpError(400, `Couldn't find a copy template called "${s.copyTemplateId}".`);
    patch.copy_template_id = t.id;
    const { id: _id, name: _n, ...copy } = t;
    patch.copy = JSON.stringify(copy);
  }
  if (s.presetId !== undefined && s.presetId !== "") {
    const rows = db().prepare("SELECT * FROM settings_presets WHERE ad_account_id = ?").all(acc.id) as Parameters<typeof presetFromRow>[0][];
    const r = rows.find((x) => String(x.id) === String(s.presetId)) ?? rows.find((x) => x.name.toLowerCase().includes(String(s.presetId).toLowerCase()));
    if (!r) throw new HttpError(400, `Couldn't find a settings preset called "${s.presetId}".`);
    patch.preset_id = r.id;
    patch.preset = JSON.stringify(presetFromRow(r));
  }
  if (s.adNameTemplate !== undefined) patch.ad_name_template = s.adNameTemplate;
  if (s.adsetNameTemplate !== undefined) patch.adset_name_template = s.adsetNameTemplate;
  if (s.angle !== undefined) patch.angle = s.angle;
  if (s.persona !== undefined) patch.persona = s.persona;
  if (s.extraAdsetIds !== undefined) {
    const extras: ExtraAdset[] = [];
    for (const q of s.extraAdsetIds.filter((x) => String(x).trim())) {
      let found = await findAdset(q);
      if (!found) {
        const d = await listDestinations();
        const all = d.campaigns.flatMap((c) => c.adsets.map((a) => ({ ...a, campaign: c })));
        const m = matchByName(all, q);
        if (m) found = { campaign: m.campaign, adset: m };
      }
      if (!found) throw new HttpError(400, `Couldn't find an ad set called "${q}". Use list_destinations to see the names.`);
      if (found.adset.id === (patch.adset_id ?? b.adset_id)) continue;
      if (!extras.some((x) => x.id === found!.adset.id)) extras.push({ id: found.adset.id, name: found.adset.name, campaignId: found.campaign.id, campaignName: found.campaign.name });
    }
    patch.extra_adsets = JSON.stringify(extras);
  }
  if (s.goLive !== undefined) {
    if (!["paused", "now", "at"].includes(s.goLive)) throw new HttpError(400, "goLive must be paused, now or at.");
    patch.go_live = s.goLive;
  }
  if (s.goLiveAt !== undefined) {
    if (s.goLiveAt && Number.isNaN(Date.parse(s.goLiveAt))) throw new HttpError(400, `"${s.goLiveAt}" is not a date and time.`);
    patch.go_live_at = s.goLiveAt || null;
  }
  updateBatch(b.id, patch);
}

/** Per-ad copy by ad number or creative name (Claude, and the copy-sheet import). */
export function setAdCopyBy(key: string, rows: { ad: string | number; copy: CopyOverride; angle?: string }[]) {
  const b = batchOr404(key);
  const ads = getAds(b.id);
  const done: string[] = [];
  for (const r of rows) {
    const q = String(r.ad).trim().toLowerCase().replace(/\.[a-z0-9]+$/, "");
    const ad =
      ads.find((a) => String(a.position) === q || a.key === q) ??
      ads.find((a) => a.creative_name.toLowerCase() === q) ??
      ads.find((a) => getAdAssetsByAd(a.id).some((f) => f.filename.toLowerCase().replace(/\.[a-z0-9]+$/, "") === q));
    if (!ad) throw new HttpError(400, `No ad "${r.ad}" in batch ${key}. Use the ad number or the creative name from the preview.`);
    if ((r.copy.primaryTexts?.length ?? 0) > 5 || (r.copy.headlines?.length ?? 0) > 5) throw new HttpError(400, `Ad ${ad.position}: up to 5 primary texts and 5 headlines.`);
    if (r.copy.cta && !CTA_TYPES.includes(r.copy.cta)) throw new HttpError(400, `Ad ${ad.position}: unknown call-to-action ${r.copy.cta}.`);
    updateAdOverride(key, ad.id, { copy: r.copy, angle: r.angle });
    done.push(`${ad.position} (${ad.creative_name})`);
  }
  return done;
}

function getAdAssetsByAd(adId: number) {
  return db().prepare("SELECT filename FROM assets WHERE ad_id = ?").all(adId) as { filename: string }[];
}

/** Move a file to another ad (by number) or to an ad of its own. For Claude's regroup tool. */
export function regroupFile(key: string, file: string, to: number | "new") {
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

/** Stop a launch: ads not created yet stay uncreated (Retry continues them later). Nothing is deleted. */
export function cancelBatch(key: string) {
  const b = batchOr404(key);
  if (b.status === "queued") {
    db().prepare("UPDATE jobs SET status = 'done', last_error = 'cancelled' WHERE kind = 'launch' AND batch_id = ? AND status = 'queued'").run(b.id);
    db().prepare("UPDATE ads SET status = 'failed', error = 'Cancelled before it was created. Press \"Retry failed\" to create it.' WHERE batch_id = ? AND status != 'done'").run(b.id);
    const done = getAds(b.id).filter((a) => a.status === "done").length;
    updateBatch(b.id, { status: done ? "partial" : "failed", finished_at: new Date().toISOString() });
    logEvent(b.id, null, "warn", "Cancelled before the launch started.");
    return "cancelled";
  }
  if (b.status !== "running") throw new HttpError(409, `This batch is not launching (${STATUS_LABEL[b.status]?.toLowerCase() ?? b.status}).`);
  updateBatch(b.id, { cancel_requested: 1 });
  logEvent(b.id, null, "warn", "Cancel asked: the launch stops after the current step. Ads already created stay (paused).");
  return "stopping";
}

export function updateAdOverride(key: string, adId: number, o: { copy?: CopyOverride; angle?: string | null }) {
  const b = batchOr404(key);
  if (b.status !== "draft") throw new HttpError(409, "This batch has been launched.");
  const ad = getAds(b.id).find((a) => a.id === adId);
  if (!ad) throw new HttpError(404, "Ad not found.");
  const patch: Record<string, string | null> = {};
  if (o.copy !== undefined) {
    const clean: CopyOverride = {};
    for (const [k, v] of Object.entries(o.copy)) {
      if (Array.isArray(v) ? v.some((x) => String(x).trim()) : typeof v === "string" && v.trim()) (clean as Record<string, unknown>)[k] = v;
    }
    patch.copy_override = Object.keys(clean).length ? JSON.stringify(clean) : null;
  }
  if (o.angle !== undefined) patch.angle = o.angle === "" ? null : o.angle;
  updateAd(ad.id, patch);
}

async function destinationInfo(b: BatchRow): Promise<DestinationInfo> {
  // Can the ad account use the preset's Instagram account? Meta refuses every creative otherwise.
  let igProblem: string | undefined;
  const preset = batchPreset(b);
  if (preset.igUserId) {
    try {
      const ids = await listIdentities();
      if (ids.instagramKnown && !ids.instagram.some((i) => i.id === preset.igUserId)) igProblem = igNotAllowed(getAccount(b.ad_account_id)?.name ?? "this ad account", preset.igName || preset.igUserId);
    } catch {
      /* unknown: the launch shows Meta's answer if it is a problem */
    }
  }
  const dest = await adsetInfo(b);
  return igProblem ? { ...dest, igProblem } : dest;
}

async function adsetInfo(b: BatchRow): Promise<DestinationInfo> {
  if (!b.adset_id) return {};
  try {
    const f = await findAdset(b.adset_id);
    if (!f) return { adset: null };
    // How many ads the ad set already holds (Meta's limit is 50). One read; skipped if Meta refuses it.
    let adCount: number | undefined;
    if (b.adset_mode === "existing") {
      try {
        const r = await clientFor(b.ad_account_id).get<{ summary?: { total_count?: number } }>(`${b.adset_id}/ads`, {
          fields: "id",
          limit: 1,
          summary: "total_count",
          effective_status: ["ACTIVE", "PAUSED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES"],
        });
        adCount = r.summary?.total_count;
      } catch {
        /* count unknown: the batch size alone is still checked */
      }
    }
    return { adset: { id: f.adset.id, name: f.adset.name, is_dynamic_creative: f.adset.isDynamicCreative, ad_count: adCount } };
  } catch {
    return {};
  }
}

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
  /** The estimate shown when the batch was launched (the preview's estimate is for what is left). */
  launchEstimate: string | null;
  progress: { total: number; done: number; failed: number; working: number };
  createdAt: string;
  launchedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
  events: { level: string; message: string; at: string }[];
  links: { app: string; campaign: string | null };
  ads: (Preview["ads"][number] & { adsManagerUrl: string | null; reviewLabel: string })[];
  unassigned: { id: number; filename: string; kind: string }[];
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Not launched yet",
  queued: "Waiting to start",
  running: "Launching",
  done: "All ads created",
  partial: "Some ads failed",
  failed: "Failed",
};

export async function batchView(key: string, opts: { withDestination?: boolean } = {}): Promise<BatchView> {
  const b = batchOr404(key);
  const dest = opts.withDestination && b.status === "draft" ? await destinationInfo(b) : {};
  const preview = buildPreview(b.id, dest, learnedCap(b.ad_account_id), { namePrefix: config.namePrefix });
  const fresh = batchOr404(key);
  const ads = getAds(b.id);
  const events = (db().prepare("SELECT level, message, created_at AS at FROM events WHERE batch_id = ? ORDER BY id DESC LIMIT 60").all(b.id) as { level: string; message: string; at: string }[]);
  const unassigned = db().prepare("SELECT id, filename, kind FROM assets WHERE batch_id = ? AND ad_id IS NULL").all(b.id) as { id: number; filename: string; kind: string }[];
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
      extraAdsets: extraAdsets(fresh),
      goLive: fresh.go_live,
      goLiveAt: fresh.go_live_at,
    },
    together: siblings(fresh).filter((x) => x.id !== fresh.id).map((x) => ({ key: x.key, adsetName: x.adset_name, status: x.status })),
    cancelRequested: !!fresh.cancel_requested,
    preview,
    launchEstimate: fresh.estimate_seconds ? humanDuration(fresh.estimate_seconds) : null,
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
  };
}

/** Full check, including loading each landing page. Saves the result. */
export async function runPreview(key: string): Promise<BatchView> {
  const b = batchOr404(key);
  if (b.status !== "draft") return batchView(key);
  const dest = await destinationInfo(b);
  const urls = getAds(b.id).map((a) => adCopy(b, a).linkUrl).filter(Boolean);
  const linkResults = await checkLinks(urls);
  buildPreview(b.id, dest, learnedCap(b.ad_account_id), { linkResults, persist: true });
  return batchView(key);
}

/** A draft copy of batch `b` for one more ad set: same files, grouping, copy and settings. */
function cloneForAdset(b: BatchRow, x: ExtraAdset, group: string): string {
  const d = db();
  return d.transaction(() => {
    const id = newBatch(b.ad_account_id, b.created_by, { kind: b.source_kind, ref: b.source_ref ?? undefined, label: b.source_label });
    const key = (d.prepare("SELECT key FROM batches WHERE id = ?").get(id) as { key: string }).key;
    d.prepare(
      `UPDATE batches SET campaign_id = ?, campaign_name = ?, adset_mode = 'existing', adset_id = ?, adset_name = ?, copy_template_id = ?, copy = ?,
         ad_name_template = ?, adset_name_template = ?, preset_id = ?, preset = ?, angle = ?, persona = ?, go_live = ?, go_live_at = ?, group_key = ?, extra_adsets = '[]' WHERE id = ?`,
    ).run(x.campaignId, x.campaignName, x.id, x.name, b.copy_template_id, b.copy, b.ad_name_template, b.adset_name_template, b.preset_id, b.preset, b.angle, b.persona, b.go_live, b.go_live_at, group, id);
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

/** The summary shown before the launch is confirmed: accounts, budgets, total, schedule, copy. */
export async function batchLaunchSummary(key: string) {
  const b = batchOr404(key);
  const [connection, launch] = await Promise.all([
    connectionSummary(batchPreset(b)),
    b.adset_id ? launchSummary(b, { mode: b.go_live, at: b.go_live_at }) : Promise.resolve(null),
  ]);
  return { connection, launch };
}

export async function launchBatch(key: string, opts: { confirm?: boolean; acceptWarnings?: boolean; spendConfirmation?: string }) {
  if (opts.confirm !== true) throw new HttpError(400, "Launching needs confirm: true.");
  const b = batchOr404(key);
  if (b.status !== "draft") throw new HttpError(409, `This batch is already ${STATUS_LABEL[b.status]?.toLowerCase() ?? b.status}.`);
  if (b.go_live === "at" && (!b.go_live_at || Date.parse(b.go_live_at) < Date.now())) throw new HttpError(400, "Pick a time in the future to turn the ads on, or launch them paused.");
  const view = await runPreview(key);
  // Strict guardrail: a launch that turns ads on needs the total daily budget typed back.
  let spend: string | null = null;
  if (b.go_live !== "paused") {
    const sum = await launchSummary(b, { mode: b.go_live, at: b.go_live_at });
    spend = sum.spendConfirmation;
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
  if (view.preview.warnings > 0 && !opts.acceptWarnings) {
    throw new HttpError(422, `There ${view.preview.warnings === 1 ? "is 1 warning" : `are ${view.preview.warnings} warnings`}. Read them in the preview and accept them to launch.`);
  }
  // Same ads into more ad sets: one batch per extra ad set, checked before anything is queued.
  const extras = extraAdsets(b);
  const sibs: string[] = [];
  if (extras.length) {
    const group = b.group_key ?? b.key;
    updateBatch(b.id, { group_key: group });
    for (const x of extras) sibs.push(cloneForAdset(b, x, group));
    for (const k of sibs) {
      const v = await runPreview(k);
      if (v.preview.errors > 0) {
        for (const kk of sibs) deleteDraft(kk);
        const list = v.preview.batchChecks.filter((c) => c.level === "error").map((c) => c.message);
        throw new HttpError(422, `The copy for ad set "${v.settings.adsetName}" can't launch:\n- ${list.join("\n- ") || "see the preview"}`);
      }
    }
  }
  // Only one launch per batch, even from two tabs or Claude at the same moment.
  const won = db().prepare("UPDATE batches SET status = 'queued', warnings_accepted = ? WHERE id = ? AND status = 'draft'").run(opts.acceptWarnings ? 1 : 0, b.id).changes;
  if (!won) {
    for (const kk of sibs) deleteDraft(kk);
    throw new HttpError(409, "This batch is already launching.");
  }
  const when = b.go_live === "now" ? " The ads are turned on once all are created." : b.go_live === "at" ? ` The ads are turned on at ${istTime(b.go_live_at!)}.` : "";
  logEvent(b.id, null, "info", `Queued for launch. Estimated time: ${view.preview.estimate.label}.${when}${spend ? ` Confirmed total daily budget: ${spend}.` : ""}`);
  enqueue("launch", b.id);
  for (const k of sibs) {
    const s2 = batchOr404(k);
    db().prepare("UPDATE batches SET status = 'queued', warnings_accepted = ? WHERE id = ?").run(opts.acceptWarnings ? 1 : 0, s2.id);
    logEvent(s2.id, null, "info", `Queued with batch ${b.key} (same ads, ad set "${s2.adset_name}").`);
    enqueue("launch", s2.id);
  }
  return batchView(key);
}

export function retryFailed(key: string) {
  const b = batchOr404(key);
  if (b.status === "running" || b.status === "queued") throw new HttpError(409, "This batch is still running.");
  if (b.status === "draft") throw new HttpError(409, "This batch hasn't been launched yet.");
  const won = db().prepare("UPDATE batches SET status = 'queued', cancel_requested = 0 WHERE id = ? AND status NOT IN ('running', 'queued', 'draft')").run(b.id).changes;
  if (!won) throw new HttpError(409, "This batch is already running.");
  const n = resetFailed(b.id);
  if (!n) {
    updateBatch(b.id, { status: "done" });
    throw new HttpError(409, "No failed ads to retry.");
  }
  logEvent(b.id, null, "info", `Retrying ${n} failed ad${n > 1 ? "s" : ""}. Ads that already went through are not touched.`);
  enqueue("launch", b.id);
  return n;
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
      destination: b.adset_mode === "new_per_ad" ? `${b.campaign_name ?? "?"} → new ad set per ad` : `${b.campaign_name ?? "?"} → ${b.adset_name ?? "?"}`,
      ads: counts.total,
      done: counts.done ?? 0,
      failed: counts.failed ?? 0,
      createdBy: b.created_by,
      createdAt: b.created_at,
      launchedAt: b.launched_at,
    };
  });
}

export function deleteDraft(key: string) {
  const b = batchOr404(key);
  if (b.status !== "draft") throw new HttpError(409, "Only batches that were never launched can be deleted.");
  db().prepare("DELETE FROM batches WHERE id = ?").run(b.id);
  cacheDelete(`batch:${b.id}`);
}
