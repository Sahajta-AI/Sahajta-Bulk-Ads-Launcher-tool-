import { db, json } from "./db";
import type { AdAccountRow, AdRow, AssetRow, BatchRow, Check, Copy, CopyOverride, Preset } from "./types";
import { descriptionsIn, withDescriptions } from "./descriptions";

// Small data-access helpers shared by the web app, the worker and the CLI.

export function getBatch(id: number): BatchRow | undefined {
  return db().prepare("SELECT * FROM batches WHERE id = ?").get(id) as BatchRow | undefined;
}

export function getBatchByKey(key: string): BatchRow | undefined {
  return db().prepare("SELECT * FROM batches WHERE key = ?").get(key) as BatchRow | undefined;
}

export function getAds(batchId: number): AdRow[] {
  return db().prepare("SELECT * FROM ads WHERE batch_id = ? ORDER BY position").all(batchId) as AdRow[];
}

export function getAd(id: number): AdRow | undefined {
  return db().prepare("SELECT * FROM ads WHERE id = ?").get(id) as AdRow | undefined;
}

export function getAssets(batchId: number): AssetRow[] {
  return db().prepare("SELECT * FROM assets WHERE batch_id = ? ORDER BY rel_path, filename").all(batchId) as AssetRow[];
}

export function getAdAssets(adId: number): AssetRow[] {
  return db().prepare("SELECT * FROM assets WHERE ad_id = ? ORDER BY ratio, filename").all(adId) as AssetRow[];
}

export function getAccount(id?: number): AdAccountRow | undefined {
  if (id) return db().prepare("SELECT * FROM ad_accounts WHERE id = ?").get(id) as AdAccountRow | undefined;
  return db().prepare("SELECT * FROM ad_accounts ORDER BY is_default DESC, id LIMIT 1").get() as AdAccountRow | undefined;
}

type Patch = Record<string, string | number | null>;

function update(table: string, id: number, patch: Patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  const extra = table === "ads" ? ", updated_at = datetime('now')" : "";
  db().prepare(`UPDATE ${table} SET ${sets}${extra} WHERE id = @id`).run({ ...patch, id });
}

export const updateBatch = (id: number, patch: Patch) => update("batches", id, patch);
export const updateAd = (id: number, patch: Patch) => update("ads", id, patch);
export const updateAsset = (id: number, patch: Patch) => update("assets", id, patch);

export function logEvent(batchId: number, adId: number | null, level: "info" | "warn" | "error", message: string) {
  db().prepare("INSERT INTO events (batch_id, ad_id, level, message) VALUES (?, ?, ?, ?)").run(batchId, adId, level, message);
}

export function batchCopy(b: BatchRow): Copy {
  const c = json<Copy>(b.copy, { primaryTexts: [], headlines: [], descriptions: [], cta: "LEARN_MORE", linkUrl: "", utmTemplate: "" });
  return { ...withDescriptions(c), descriptions: descriptionsIn(c) ?? [] };
}

/** This ad's own copy changes (old ones may still have one `description`: lib/descriptions.ts). */
export function adOverride(ad: Pick<AdRow, "copy_override">): CopyOverride {
  return withDescriptions(json<CopyOverride>(ad.copy_override, {}));
}

/** The batch copy with this ad's overrides applied. Empty override fields mean "use the batch value". */
export function adCopy(b: BatchRow, ad: AdRow): Copy {
  const base = batchCopy(b);
  const o = adOverride(ad);
  const pick = <T>(v: T | undefined, d: T): T => {
    if (v === undefined || v === null) return d;
    if (Array.isArray(v) && v.filter((x) => String(x).trim()).length === 0) return d;
    if (typeof v === "string" && !v.trim()) return d;
    return v;
  };
  return {
    primaryTexts: pick(o.primaryTexts, base.primaryTexts).filter((t) => t.trim()),
    headlines: pick(o.headlines, base.headlines).filter((t) => t.trim()),
    descriptions: pick(o.descriptions, base.descriptions).filter((t) => t.trim()),
    cta: pick(o.cta, base.cta),
    linkUrl: pick(o.linkUrl, base.linkUrl),
    utmTemplate: pick(o.utmTemplate, base.utmTemplate),
    displayLink: pick(o.displayLink, base.displayLink ?? ""),
    leadFormId: pick(o.leadFormId, base.leadFormId ?? ""),
  };
}

/** The batch's settings preset with this ad's own enhancements and multi-advertiser choice, if it has them. */
export function adPreset(b: BatchRow, ad: AdRow): Preset {
  const base = batchPreset(b);
  const o = adOverride(ad);
  return {
    ...base,
    ...(o.enhancements ? { enhancements: o.enhancements } : {}),
    ...(typeof o.multiAdvertiser === "boolean" ? { multiAdvertiser: o.multiAdvertiser } : {}),
  };
}

export function batchPreset(b: BatchRow): Preset {
  return json<Preset>(b.preset, { name: "", pageId: "", pageName: "", igUserId: "", igName: "", enhancements: {}, multiAdvertiser: false });
}

export function adChecks(ad: AdRow): Check[] {
  return json<Check[]>(ad.checks, []);
}

export function attemptsOf(ad: AdRow): Record<string, number> {
  return json<Record<string, number>>(ad.attempts, {});
}

/** Most recent creatives read to find one by name (pages of 100): Meta has no name filter for creatives. */
export const CREATIVE_LOOKUP_MAX = 1000;
/** The reads that takes at most: what the time estimate counts for it. */
export const CREATIVE_LOOKUP_PAGES = CREATIVE_LOOKUP_MAX / 100;

/**
 * What a run looks up in Meta before creating anything, so nothing is made twice (an earlier run may have
 * made it without the launcher knowing: a lost answer, a crash, a restored database).
 *  - Ads by their [L:key] name: always (one read; Meta's name filter works for ads, and a found ad gives
 *    its creative too). New ad sets per ad: the same, always.
 *  - Creatives: Meta has no name filter for them, so this reads up to 1,000 recent creatives. Only when a
 *    try of a creative without its ID is saved (the try is saved before the create is sent), or after a
 *    database restore (deploy/restore.sh marks every unfinished ad "restored": its tries may be missing).
 * The time estimate counts the same reads.
 */
export function lookupsNeeded(batch: Pick<BatchRow, "adset_mode">, ads: AdRow[]): { ads: boolean; creatives: boolean; adsets: boolean } {
  const tried = (a: AdRow) => attemptsOf(a);
  return {
    ads: ads.length > 0,
    creatives: ads.some((a) => !a.meta_creative_id && ((tried(a).restored ?? 0) > 0 || (tried(a).creative ?? 0) > (tried(a).creative_refused ?? 0))),
    adsets: batch.adset_mode === "new_per_ad" && ads.length > 0,
  };
}

export function cacheGet<T>(key: string): T | undefined {
  const row = db().prepare("SELECT value, expires_at FROM cache WHERE key = ?").get(key) as { value: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return undefined;
  return JSON.parse(row.value) as T;
}

export function cacheSet(key: string, value: unknown, ttlMs: number) {
  db().prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
    .run(key, JSON.stringify(value), Date.now() + ttlMs);
}

export function cacheDelete(prefix: string) {
  db().prepare("DELETE FROM cache WHERE key LIKE ?").run(`${prefix}%`);
}

/** The launch a batch belongs to: its group_key (the same ads into several ad sets), or itself alone. */
export function launchOf(b: Pick<BatchRow, "id" | "group_key">): string {
  return b.group_key ?? `batch:${b.id}`;
}

export interface MadeCreative {
  meta_creative_id: string;
  ad_key: string;
  feature_warnings: string;
}

/** A creative this launch already made with this hash (whatever happened to the ad that made it since). */
export function madeCreative(b: BatchRow, hash: string): MadeCreative | undefined {
  return db()
    .prepare("SELECT meta_creative_id, ad_key, feature_warnings FROM launch_creatives WHERE launch = ? AND ad_account_id = ? AND creative_hash = ?")
    .get(launchOf(b), b.ad_account_id, hash) as MadeCreative | undefined;
}

/** Remember a creative this launch made (the first one with a hash stays). */
export function saveMadeCreative(b: BatchRow, hash: string, c: MadeCreative) {
  db()
    .prepare("INSERT OR IGNORE INTO launch_creatives (launch, ad_account_id, creative_hash, meta_creative_id, ad_key, feature_warnings) VALUES (?, ?, ?, ?, ?, ?)")
    .run(launchOf(b), b.ad_account_id, hash, c.meta_creative_id, c.ad_key, c.feature_warnings || "[]");
}
