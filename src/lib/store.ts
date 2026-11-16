import { db, json } from "./db";
import type { AdAccountRow, AdRow, AssetRow, BatchRow, Check, Copy, CopyOverride, Preset } from "./types";

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
  return json<Copy>(b.copy, { primaryTexts: [], headlines: [], description: "", cta: "LEARN_MORE", linkUrl: "", utmTemplate: "" });
}

/** The batch copy with this ad's overrides applied. Empty override fields mean "use the batch value". */
export function adCopy(b: BatchRow, ad: AdRow): Copy {
  const base = batchCopy(b);
  const o = json<CopyOverride>(ad.copy_override, {});
  const pick = <T>(v: T | undefined, d: T): T => {
    if (v === undefined || v === null) return d;
    if (Array.isArray(v) && v.filter((x) => String(x).trim()).length === 0) return d;
    if (typeof v === "string" && !v.trim()) return d;
    return v;
  };
  return {
    primaryTexts: pick(o.primaryTexts, base.primaryTexts).filter((t) => t.trim()),
    headlines: pick(o.headlines, base.headlines).filter((t) => t.trim()),
    description: pick(o.description, base.description),
    cta: pick(o.cta, base.cta),
    linkUrl: pick(o.linkUrl, base.linkUrl),
    utmTemplate: pick(o.utmTemplate, base.utmTemplate),
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
