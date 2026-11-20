import { createHash } from "node:crypto";
import fs from "node:fs";
import { clearAlerts } from "../alerts";
import { feedbackLines } from "../manage/feedback";
import { db, json } from "../db";
import type { MetaClient } from "../meta/client";
import { buildCreative, clean, type CreativeAsset } from "../meta/creative";
import { MetaError, metaSaid, plainError } from "../meta/errors";
import { featureWarnings } from "../meta/features";
import { getMedia, saveMedia, uploadImage, uploadVideo, videoStatus, videoThumbnail } from "../meta/upload";
import { READ_COST, WRITE_COST, type Clock } from "../meta/pacer";
import { CREATIVE_LOOKUP_MAX, adCopy, adPreset, attemptsOf, getAdAssets, getAds, getBatch, logEvent, lookupsNeeded, madeCreative, saveMadeCreative, updateAd, updateBatch } from "../store";
import type { AdRow, AssetRow, BatchRow } from "../types";
import { slotOf } from "./grouping";
import { extractFrame } from "./media";
import { keyTag, metaName, renderUtm } from "./naming";
import { adNameContext } from "./preview";
import { adsetCloneParams, getAdSet, getCampaign, isCbo } from "../manage/objects";

// The launch engine. Runs one batch to the end, one Meta call at a time, paced.
//
// No duplicates, even after a crash, a timeout or a database restore:
//  1. Every object name carries the ad's key, e.g. "[L:b7k2x-03]".
//  2. Each run starts by listing objects in Meta whose name contains "[L:<batch key>-"
//     and adopting them (3 reads per run, whatever the batch size).
//  3. Before any create we write "attempted" to the database. If a create gets no clear
//     answer, the retry looks the object up in Meta by its key before creating again.
//  4. Media is keyed by file checksum, so the same file is never uploaded twice.
//  5. The same ads launched into several ad sets (batches with one group_key): each creative is made
//     once per launch when what is sent to Meta is the same (creative_hash), and every ad set's ad
//     uses it, so all ad sets share one post per ad. Anything different (copy, link, identity, form…)
//     makes its own creative.

// Each check is one read; on the 60-point tier, checking every 30 s starved the uploads of later ads.
export const VIDEO_POLL_MS = 90_000;
const THUMBNAIL_MAX_AGE_MS = 6 * 3600_000; // Meta's thumbnail links expire: fetch a fresh one for later batches.
const VIDEO_TIMEOUT_MS = 45 * 60_000;
const MAX_TRANSIENT_TRIES = 4;

export interface FileSource {
  /** Make sure the asset is on local disk with a checksum. Returns the updated row. */
  ensureLocal(asset: AssetRow): Promise<AssetRow & { local_path: string; sha256: string }>;
}

export interface LaunchDeps {
  client: MetaClient;
  files: FileSource;
  clock: Clock;
  accountDbId: number;
  /** Test hook: called after each Meta create, before the result is saved. Throwing simulates a crash. */
  afterCreate?: (kind: "adset" | "creative" | "ad", adKey: string) => void;
  namePrefix?: string;
  tmpDir: string;
  /** When each ad started waiting for video processing (set by runBatch). */
  waitStart?: Map<number, number>;
  /** Meta points each ad's own steps used in this run (set by runBatch), saved as work_points when it is done. */
  work?: Map<number, number>;
}

/** An ad row with the columns of migration 7 (shared creatives, time left). */
type ShareRow = AdRow & { creative_hash?: string | null; done_at?: number | null; work_points?: number | null };

/** Count Meta points against the ad whose step made the call (for the time left of a launch). */
function spend(deps: LaunchDeps, ad: AdRow, points: number) {
  deps.work?.set(ad.id, (deps.work.get(ad.id) ?? 0) + points);
}

type Found = Map<string, { id: string; name: string; creative?: { id?: string } }>;

const TAG_RE = /\[L:([a-z0-9]+-\d+)\]/;

const LIVE_STATUSES = ["ACTIVE", "PAUSED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES"];

/**
 * List objects on an edge whose name contains `needle`. Uses Meta's name filter; for creatives Meta
 * refuses it ("Filtering field 'name' with operation 'contain' is not supported", 1A, 20 Nov 2026), so
 * recent creatives are listed and matched here, without first sending a filter Meta refuses (that
 * call counts against the limit too). Other edges fall back the same way if Meta ever refuses.
 */
async function listByName<T extends { id: string; name: string }>(client: MetaClient, edge: "ads" | "adsets" | "adcreatives", needle: string, fields = "id,name"): Promise<T[]> {
  const base: Record<string, unknown> = { fields };
  if (edge !== "adcreatives") base.effective_status = LIVE_STATUSES;
  if (edge === "adcreatives") {
    const recent = await client.getAll<T>(`${client.accountId}/${edge}`, base, CREATIVE_LOOKUP_MAX);
    return recent.filter((r) => r.name?.includes(needle));
  }
  try {
    return await client.getAll<T>(`${client.accountId}/${edge}`, { ...base, filtering: [{ field: "name", operator: "CONTAIN", value: needle }] });
  } catch (e) {
    // Only a refused filter (invalid parameter) is worth listing instead; a login or permission error is not.
    if (!(e instanceof MetaError) || e.isTransient || e.code !== 100) throw e;
    const recent = await client.getAll<T>(`${client.accountId}/${edge}`, base, CREATIVE_LOOKUP_MAX);
    return recent.filter((r) => r.name?.includes(needle));
  }
}

async function findByBatchKey(client: MetaClient, edge: "ads" | "adsets" | "adcreatives", batchKey: string, fields?: string): Promise<Found> {
  const rows = await listByName<{ id: string; name: string; creative?: { id?: string } }>(client, edge, `[L:${batchKey}-`, fields);
  const out: Found = new Map();
  for (const r of rows) {
    const m = TAG_RE.exec(r.name);
    if (m && !out.has(m[1])) out.set(m[1], r);
  }
  return out;
}

async function findOne(client: MetaClient, edge: "ads" | "adsets" | "adcreatives", adKey: string, match?: (name: string) => boolean): Promise<string | null> {
  const rows = await listByName(client, edge, keyTag(adKey));
  return rows.find((r) => !match || match(r.name))?.id ?? null;
}

/** The ad's format: "carousel" when its own settings say so. */
export function adFormat(ad: AdRow): "single" | "carousel" {
  try {
    return (JSON.parse(ad.copy_override ?? "{}") as { format?: string }).format === "carousel" ? "carousel" : "single";
  } catch {
    return "single";
  }
}

/** After a failed ad's copy is changed, its creative is made again as "v2", "v3"…; older ones are not reused. */
export function creativeVersion(ad: AdRow): number {
  return (attemptsOf(ad).copy_gen ?? 0) + 1;
}
function creativeMatches(ad: AdRow, name: string): boolean {
  const v = creativeVersion(ad);
  return v === 1 ? !/ v\d+$/.test(name) : name.endsWith(` v${v}`);
}

/**
 * A video's thumbnail link (video_data.image_url, a carousel card's picture, asset_feed_spec's
 * thumbnail_url): Meta signs it, so each read gives another link for the same picture. The video id
 * already says which file it is.
 */
const THUMBNAIL_LINKS = new Set(["image_url", "thumbnail_url", "picture"]);

/** JSON with sorted keys and no thumbnail links, so the same creative always gives the same text. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => !THUMBNAIL_LINKS.has(k)).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * What makes two creatives the same: everything sent to Meta except the creative's name and a video's
 * thumbnail link, and its version (after a copy change, "v2" never reuses a creative made before it).
 */
export function creativeHash(body: Record<string, unknown>, version: number): string {
  const { name: _name, ...rest } = body;
  return createHash("sha256").update(stableJson({ v: version, body: rest })).digest("hex");
}

/** The ads of this launch (this batch and the batches launched with it into other ad sets) with this creative hash. */
function launchAdsWithHash(batch: BatchRow, hash: string, exceptAdId: number): ShareRow[] {
  return db()
    .prepare(
      `SELECT a.* FROM ads a JOIN batches b ON b.id = a.batch_id
       WHERE a.creative_hash = ? AND a.id != ? AND b.ad_account_id = ? AND ${batch.group_key ? "b.group_key = ?" : "b.id = ?"} ORDER BY a.id`,
    )
    .all(hash, exceptAdId, batch.ad_account_id, batch.group_key ?? batch.id) as ShareRow[];
}

/**
 * The creative this ad can use instead of making its own: one another ad set of this launch already made
 * with the very same body (`made`), or one an ad of this launch tried to make but got no answer for, found
 * in Meta by that ad's key (a lost answer never leads to a second creative). null: make it.
 */
async function sharedCreative(deps: LaunchDeps, batch: BatchRow, ad: AdRow, hash: string): Promise<{ id: string; from: string; made: boolean; featureWarnings?: string } | null> {
  // Meta refused this ad with the creative of another ad set: it makes its own.
  if (attemptsOf(ad).own_creative) return null;
  // Kept apart from the ads: the ad that made it may have changed its copy (or got its own) since.
  const kept = madeCreative(batch, hash);
  if (kept && kept.ad_key !== ad.key) return { id: kept.meta_creative_id, from: kept.ad_key, made: true, featureWarnings: kept.feature_warnings };
  const same = launchAdsWithHash(batch, hash, ad.id);
  const made = same.find((a) => a.meta_creative_id);
  if (made) return { id: made.meta_creative_id!, from: made.key, made: true, featureWarnings: made.feature_warnings };
  // Only tries without a clear answer: a create Meta refused made nothing.
  for (const other of same.filter((a) => (attemptsOf(a).creative ?? 0) > (attemptsOf(a).creative_refused ?? 0))) {
    spend(deps, ad, READ_COST);
    const id = await findOne(deps.client, "adcreatives", other.key, (n) => creativeMatches(other, n));
    if (id) {
      // The ad that asked for it gets it too: its Retry uses it instead of making another.
      updateAd(other.id, { meta_creative_id: id });
      return { id, from: other.key, made: false };
    }
  }
  return null;
}

/** The post behind a creative, when another ad of this ad account that uses it already read it. */
function knownPost(batch: BatchRow, ad: AdRow, creativeId: string): { meta_post_id: string | null; meta_ig_media_id: string | null } | undefined {
  return db()
    .prepare(
      `SELECT a.meta_post_id, a.meta_ig_media_id FROM ads a JOIN batches b ON b.id = a.batch_id
       WHERE a.meta_creative_id = ? AND a.id != ? AND b.ad_account_id = ? AND (a.meta_post_id IS NOT NULL OR a.meta_ig_media_id IS NOT NULL) LIMIT 1`,
    )
    .get(creativeId, ad.id, batch.ad_account_id) as { meta_post_id: string | null; meta_ig_media_id: string | null } | undefined;
}

/** A stable UUID (v4 layout) for one logical create, so Meta's idempotency key matches on retry. */
export function idempotencyKey(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Said on an ad Meta refused with the creative of another ad set. */
export const OWN_CREATIVE_NOTE = "It used the same creative as the other ad sets; Retry makes this ad its own creative (its own post, so its likes and comments are counted apart).";

class StepError extends Error {
  constructor(public plain: string, public detail: string, public transient: boolean) {
    super(plain);
  }
}

function bumpAttempt(ad: AdRow, kind: string) {
  const a = attemptsOf(ad);
  a[kind] = (a[kind] ?? 0) + 1;
  updateAd(ad.id, { attempts: JSON.stringify(a) });
  ad.attempts = JSON.stringify(a);
}

/**
 * Create an object exactly once: look it up first if an earlier attempt may have created it,
 * and send an idempotency key derived from the ad's key, so Meta itself can spot a repeat.
 */
async function createOnce(
  deps: LaunchDeps,
  ad: AdRow,
  kind: "adset" | "creative" | "ad",
  edge: "ads" | "adsets" | "adcreatives",
  create: (idempotencyKey: string) => Promise<string>,
): Promise<{ id: string; adopted: boolean }> {
  if (attemptsOf(ad)[kind]) {
    spend(deps, ad, READ_COST);
    const existing = await findOne(deps.client, edge, ad.key, kind === "creative" ? (n) => creativeMatches(ad, n) : undefined);
    if (existing) return { id: existing, adopted: true };
  }
  bumpAttempt(ad, kind);
  spend(deps, ad, WRITE_COST);
  const gen = (attemptsOf(ad)[`${kind}_gen`] ?? 0) + (kind === "creative" ? (attemptsOf(ad).copy_gen ?? 0) * 100 : 0);
  let id: string;
  try {
    id = await create(idempotencyKey(`${ad.key}:${kind}:${gen}`));
  } catch (e) {
    // Same key, different body (e.g. the copy was fixed before "retry failed"): use a new key.
    if (e instanceof MetaError && e.subcode === 1349016) {
      bumpAttempt(ad, `${kind}_gen`);
      id = await create(idempotencyKey(`${ad.key}:${kind}:${gen + 1}`));
    } else throw e;
  }
  deps.afterCreate?.(kind, ad.key);
  return { id, adopted: false };
}

function setStep(ad: AdRow, step: string, status: AdRow["status"] = "working") {
  ad.step = step;
  ad.status = status;
  updateAd(ad.id, { step, status });
}

async function ensureMedia(deps: LaunchDeps, ad: AdRow, asset: AssetRow): Promise<{ ready: boolean; creativeAsset?: CreativeAsset }> {
  const { client, accountDbId } = deps;
  const local = await deps.files.ensureLocal(asset);
  const media = getMedia(accountDbId, local.sha256);

  if (asset.kind === "image") {
    let hash = media?.image_hash;
    if (!hash) {
      setStep(ad, `Uploading ${asset.filename}`);
      spend(deps, ad, WRITE_COST);
      hash = await uploadImage(client, local.local_path, asset.filename);
      saveMedia({ ad_account_id: accountDbId, sha256: local.sha256, kind: "image", image_hash: hash, status: "ready" });
    }
    return { ready: true, creativeAsset: { kind: "image", slot: slotOf(asset.ratio), imageHash: hash } };
  }

  // Video
  let videoId = media?.video_id ?? null;
  if (!videoId || media?.status === "uploading" || media?.status === "error") {
    setStep(ad, `Uploading ${asset.filename}`);
    spend(deps, ad, WRITE_COST * 2);
    videoId = await uploadVideo(client, {
      accountDbId,
      sha: local.sha256,
      file: local.local_path,
      title: asset.filename,
      onProgress: (pct) => updateAd(ad.id, { step: `Uploading ${asset.filename} (${pct}%)` }),
    });
  }
  let row = getMedia(accountDbId, local.sha256)!;
  if (row.status !== "ready") {
    spend(deps, ad, READ_COST);
    const st = await videoStatus(client, videoId);
    if (st.status === "error") {
      saveMedia({ ad_account_id: accountDbId, sha256: local.sha256, kind: "video", status: "error", video_id: null });
      throw new StepError(`Meta could not process ${asset.filename}. Check the file plays, then retry.`, `video ${videoId} status error`, false);
    }
    if (st.status !== "ready") return { ready: false };
    saveMedia({ ad_account_id: accountDbId, sha256: local.sha256, kind: "video", video_id: videoId, status: "ready" });
    row = getMedia(accountDbId, local.sha256)!;
  }

  // Thumbnail: Meta's own if it made one, otherwise a frame we grab with ffmpeg.
  const staleUrl = row.thumbnail_url && Date.now() - Date.parse(`${(row as { updated_at?: string }).updated_at ?? ""}Z`) > THUMBNAIL_MAX_AGE_MS;
  if ((!row.thumbnail_url && !row.thumbnail_hash) || staleUrl) {
    spend(deps, ad, READ_COST);
    const uri = await videoThumbnail(client, videoId);
    if (uri) {
      saveMedia({ ad_account_id: accountDbId, sha256: local.sha256, kind: "video", status: "ready", thumbnail_url: uri });
    } else if (!fs.existsSync(local.local_path) && (row.thumbnail_url || row.thumbnail_hash)) {
      // The same Drive file was used by the main batch of this launch (no copy on this server): keep its thumbnail.
    } else {
      const out = `${deps.tmpDir}/${local.sha256.slice(0, 16)}.jpg`;
      await extractFrame(local.local_path, out);
      spend(deps, ad, WRITE_COST);
      const hash = await uploadImage(client, out, `${asset.filename}.jpg`);
      saveMedia({ ad_account_id: accountDbId, sha256: local.sha256, kind: "video", status: "ready", thumbnail_hash: hash });
    }
    row = getMedia(accountDbId, local.sha256)!;
  }
  return {
    ready: true,
    creativeAsset: { kind: "video", slot: slotOf(asset.ratio), videoId, thumbnailUrl: row.thumbnail_url ?? undefined, thumbnailHash: row.thumbnail_hash ?? undefined },
  };
}

/**
 * A paused copy of the batch's template ad set, named "<template> [L:key]" from the start so a retry can
 * find it. Meta refuses a copy whose spend limits don't fit a campaign budget (1885648, batch u2942):
 * then the ad set is built from the template's settings without the spend limits.
 */
async function copyTemplate(deps: LaunchDeps, batch: BatchRow, key: string, adId: number, idem: string): Promise<string> {
  const { client } = deps;
  try {
    const res = await client.post<{ id?: string; copied_adset_id?: string; ad_object_ids?: { copied_id: string }[] }>(`${batch.adset_id}/copies`, {
      deep_copy: false,
      status_option: "PAUSED",
      rename_options: { rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` ${keyTag(key)}` },
    }, { idempotencyKey: idem });
    const newId = res.copied_adset_id ?? res.ad_object_ids?.[0]?.copied_id ?? res.id;
    if (!newId) throw new MetaError("Meta did not return the new ad set ID", { status: 200 });
    return newId;
  } catch (e) {
    if (!(e instanceof MetaError) || e.subcode !== 1885648) throw e;
    const src = await getAdSet(client, batch.adset_id!);
    const camp = await getCampaign(client, src.campaign_id);
    logEvent(batch.id, adId, "info", "Meta refused a plain copy of the template (its minimum spend is above the campaign budget). Building the ad set from the template's settings without the spend limits.");
    const res = await client.post<{ id: string }>(`${client.accountId}/adsets`, adsetCloneParams(src, src.campaign_id, `${src.name} ${keyTag(key)}`, isCbo(camp)), { idempotencyKey: idempotencyKey(`${key}:adset-rebuild`) });
    return res.id;
  }
}

/**
 * The creative an ad would get, for Meta's preview (nothing is created). Images are uploaded once
 * (the same upload is used at launch); a video must already be uploaded and processed.
 */
export async function previewCreative(deps: LaunchDeps, batch: BatchRow, ad: AdRow): Promise<Record<string, unknown>> {
  const assets = getAdAssets(ad.id);
  const parts: CreativeAsset[] = [];
  for (const asset of assets) {
    if (asset.kind === "video") {
      const local = asset.sha256 ? asset : await deps.files.ensureLocal(asset);
      const media = getMedia(deps.accountDbId, local.sha256!);
      if (!media?.video_id || media.status !== "ready") throw new Error(`Previews of video ads appear once ${asset.filename} is uploaded to Meta, which happens at launch. Launch paused, then preview in Ads Manager.`);
      parts.push({ kind: "video", slot: slotOf(asset.ratio), videoId: media.video_id, thumbnailUrl: media.thumbnail_url ?? undefined, thumbnailHash: media.thumbnail_hash ?? undefined });
    } else {
      // Upload without touching the ad's status (it is still a draft).
      const local = await deps.files.ensureLocal(asset);
      let hash = getMedia(deps.accountDbId, local.sha256)?.image_hash;
      if (!hash) {
        hash = await uploadImage(deps.client, local.local_path, asset.filename);
        saveMedia({ ad_account_id: deps.accountDbId, sha256: local.sha256, kind: "image", image_hash: hash, status: "ready" });
      }
      parts.push({ kind: "image", slot: slotOf(asset.ratio), imageHash: hash });
    }
  }
  const copy = adCopy(batch, ad);
  const ctx = adNameContext(batch, ad, assets);
  return clean(buildCreative({ name: metaName(ad.name || ad.creative_name, ad.key, deps.namePrefix ?? "", 80), format: adFormat(ad), copy, urlTags: renderUtm(copy.utmTemplate, ctx), preset: adPreset(batch, ad), assets: parts }));
}

/** Run the next step for one ad. Returns when the ad is done, failed, or waiting on Meta. */
async function advanceAd(deps: LaunchDeps, batch: BatchRow, ad: AdRow): Promise<void> {
  const { client } = deps;
  const prefix = deps.namePrefix ?? "";
  const assets = getAdAssets(ad.id);

  // 1. Media: upload every file first, then wait for all videos together.
  const creativeAssets: CreativeAsset[] = [];
  const notReady: AssetRow[] = [];
  for (const asset of assets) {
    const r = await ensureMedia(deps, ad, asset);
    if (r.ready) creativeAssets.push(r.creativeAsset!);
    else notReady.push(asset);
  }
  if (notReady.length) {
    const now = deps.clock.now();
    const since = deps.waitStart?.get(ad.id) ?? now;
    deps.waitStart?.set(ad.id, since);
    if (now - since > VIDEO_TIMEOUT_MS) {
      deps.waitStart?.delete(ad.id);
      throw new StepError(`Meta is still processing ${notReady[0].filename} after 45 minutes. Retry later.`, "video processing timeout", true);
    }
    setStep(ad, `Waiting for Meta to process ${notReady.map((a) => a.filename).join(" and ")}`, "waiting");
    ad.wait_until = now + VIDEO_POLL_MS;
    updateAd(ad.id, { wait_until: ad.wait_until });
    return;
  }
  deps.waitStart?.delete(ad.id);
  updateAd(ad.id, { wait_until: null });

  // 2. Ad set
  let adsetId = ad.meta_adset_id;
  if (batch.adset_mode === "existing") {
    adsetId = batch.adset_id!;
    if (!ad.meta_adset_id) updateAd(ad.id, { meta_adset_id: adsetId });
  } else if (batch.adset_mode === "new_shared") {
    // One new ad set (a paused copy of the template) for every ad of the batch.
    adsetId = getBatch(batch.id)?.shared_adset_id ?? null;
    if (!adsetId) {
      const sharedKey = `${batch.key}-00`;
      setStep(ad, "Creating the batch's new ad set (copy of the template)");
      spend(deps, ad, READ_COST);
      adsetId = await findOne(client, "adsets", sharedKey);
      if (adsetId) logEvent(batch.id, null, "info", "Found the batch's new ad set in Meta already; reused it.");
      else {
        spend(deps, ad, WRITE_COST);
        adsetId = await copyTemplate(deps, batch, sharedKey, ad.id, idempotencyKey(`${sharedKey}:adset`));
      }
      updateBatch(batch.id, { shared_adset_id: adsetId });
      spend(deps, ad, WRITE_COST);
      await client.post(adsetId, { name: metaName(ad.adset_name || batch.adset_name || "New ad set", sharedKey, prefix) });
    }
    if (ad.meta_adset_id !== adsetId) updateAd(ad.id, { meta_adset_id: adsetId });
  } else {
    if (!adsetId) {
      setStep(ad, "Creating the ad set (copy of the template)");
      const { id, adopted } = await createOnce(deps, ad, "adset", "adsets", (key) => copyTemplate(deps, batch, ad.key, ad.id, key));
      adsetId = id;
      updateAd(ad.id, { meta_adset_id: adsetId });
      if (adopted) logEvent(batch.id, ad.id, "info", `Found the ad set Meta already created for ${ad.key}; reused it.`);
    }
    // Rename from "<template name> [L:key]" to the naming template. Safe to repeat.
    if (!attemptsOf(ad).adset_named) {
      setStep(ad, "Naming the new ad set");
      spend(deps, ad, WRITE_COST);
      await client.post(adsetId, { name: metaName(ad.adset_name || ad.creative_name, ad.key, prefix) });
      bumpAttempt(ad, "adset_named");
    }
  }
  ad.meta_adset_id = adsetId;

  // 3. Creative: made once per launch for each distinct creative. An ad of another ad set of this launch
  //    with the very same creative (files, copy, link with its tags filled in, Page and Instagram, form…)
  //    uses it too, so all the ad sets share one post per ad (likes and comments stay together).
  const preset = adPreset(batch, ad);
  const creativeBody = () => {
    const copy = adCopy(batch, ad);
    const ctx = adNameContext(batch, ad, assets);
    const version = creativeVersion(ad);
    const body = clean(
      buildCreative({ name: `${metaName(ad.name || ad.creative_name, ad.key, prefix, 80)}${version > 1 ? ` v${version}` : ""}`, format: adFormat(ad), copy, urlTags: renderUtm(copy.utmTemplate, ctx), preset, assets: creativeAssets }),
    );
    return { body, hash: creativeHash(body, version) };
  };
  if (ad.meta_creative_id && !(ad as ShareRow).creative_hash) {
    // Found in Meta by its key (e.g. after a database restore): its hash, worked out here from the saved
    // files (no Meta call), lets the other ad sets of this launch use it instead of making a second one.
    const { hash } = creativeBody();
    (ad as ShareRow).creative_hash = hash;
    updateAd(ad.id, { creative_hash: hash });
    if (!attemptsOf(ad).creative_shared) saveMadeCreative(batch, hash, { meta_creative_id: ad.meta_creative_id, ad_key: ad.key, feature_warnings: ad.feature_warnings });
  }
  if (!ad.meta_creative_id && !ad.meta_ad_id) {
    setStep(ad, "Creating the creative");
    const { body, hash } = creativeBody();
    const shared = await sharedCreative(deps, batch, ad, hash);
    if (shared?.made) {
      ad.meta_creative_id = shared.id;
      const a = attemptsOf(ad);
      a.creative_shared = 1;
      ad.attempts = JSON.stringify(a);
      updateAd(ad.id, { meta_creative_id: shared.id, creative_hash: hash, feature_warnings: shared.featureWarnings ?? "[]", attempts: ad.attempts });
      logEvent(batch.id, ad.id, "info", `Uses the creative already made for ${shared.from} (same file and copy), so the ad shares its post: likes and comments stay together.`);
    } else {
      let id: string;
      let adopted = !!shared;
      if (shared) id = shared.id;
      else {
        // Saved before the create: if Meta's answer is lost, the other ad sets of this launch look it up instead of making a second one.
        const before = attemptsOf(ad);
        if (!before.creative && before.creative_refused !== undefined) {
          // A copy change started the tries again: an old refusal says nothing about the new ones.
          delete before.creative_refused;
          ad.attempts = JSON.stringify(before);
          updateAd(ad.id, { attempts: ad.attempts });
        }
        updateAd(ad.id, { creative_hash: hash });
        try {
          ({ id, adopted } = await createOnce(deps, ad, "creative", "adcreatives", async (key) => {
            const res = await client.post<{ id: string }>(`${client.accountId}/adcreatives`, body, { idempotencyKey: key });
            return res.id;
          }));
        } catch (e) {
          // Meta said no: nothing was made, so the other ad sets need not look this try up.
          if (e instanceof MetaError && !e.isTransient) {
            const a = attemptsOf(ad);
            a.creative_refused = a.creative ?? 0;
            updateAd(ad.id, { attempts: JSON.stringify(a) });
            ad.attempts = JSON.stringify(a);
          }
          throw e;
        }
      }
      ad.meta_creative_id = id;
      const a = attemptsOf(ad);
      delete a.creative_shared;
      ad.attempts = JSON.stringify(a);
      updateAd(ad.id, { meta_creative_id: id, creative_hash: hash, attempts: ad.attempts });
      if (adopted) logEvent(batch.id, ad.id, "info", `Found the creative Meta already created for ${shared?.from ?? ad.key}; reused it.`);

      // Read back the enhancements Meta actually stored (once per creative).
      spend(deps, ad, READ_COST);
      const stored = await client.get<{ degrees_of_freedom_spec?: { creative_features_spec?: Record<string, { enroll_status?: string }> } }>(id, {
        fields: "degrees_of_freedom_spec",
      });
      const warnings = featureWarnings(stored.degrees_of_freedom_spec?.creative_features_spec, preset.enhancements);
      updateAd(ad.id, { feature_warnings: JSON.stringify(warnings) });
      for (const w of warnings) logEvent(batch.id, ad.id, "warn", w);
      // Kept for the other ad sets of this launch, whatever happens to this ad later.
      saveMadeCreative(batch, hash, { meta_creative_id: id, ad_key: shared?.from ?? ad.key, feature_warnings: JSON.stringify(warnings) });
    }
  }

  // 4. Ad, always PAUSED.
  if (!ad.meta_ad_id) {
    setStep(ad, "Creating the ad (paused)");
    let res: { id: string; adopted: boolean };
    try {
      res = await createOnce(deps, ad, "ad", "ads", async (key) => {
        const r = await client.post<{ id: string }>(
          `${client.accountId}/ads`,
          { name: metaName(ad.name || ad.creative_name, ad.key, prefix), adset_id: adsetId, creative: { creative_id: ad.meta_creative_id }, status: "PAUSED" },
          { idempotencyKey: key },
        );
        return r.id;
      });
    } catch (e) {
      // Meta refused the ad with the creative another ad set made: Retry makes this ad its own creative
      // (its own post), so the shared one can't keep it out.
      if (e instanceof MetaError && !e.isTransient && !isAccessError(e) && attemptsOf(ad).creative_shared) {
        const a = attemptsOf(ad);
        delete a.creative_shared;
        a.own_creative = 1;
        ad.attempts = JSON.stringify(a);
        ad.meta_creative_id = null;
        updateAd(ad.id, { attempts: ad.attempts, meta_creative_id: null, creative_hash: null, meta_post_id: null, meta_ig_media_id: null });
        (e as MetaError & { note?: string }).note = OWN_CREATIVE_NOTE;
        logEvent(batch.id, ad.id, "info", OWN_CREATIVE_NOTE);
      }
      throw e;
    }
    const { id, adopted } = res;
    ad.meta_ad_id = id;
    updateAd(ad.id, { meta_ad_id: id });
    if (adopted) logEvent(batch.id, ad.id, "info", `Found the ad Meta already created for ${ad.key}; reused it.`);
  }

  // The post behind the ad, so it can be reused (ads from a post keep their likes and comments).
  // Read once per creative: the ads of the other ad sets that share it get the same post.
  const known = !ad.meta_post_id && ad.meta_creative_id ? knownPost(batch, ad, ad.meta_creative_id) : undefined;
  if (known) updateAd(ad.id, { meta_post_id: known.meta_post_id, meta_ig_media_id: known.meta_ig_media_id });
  else if (!ad.meta_post_id && ad.meta_creative_id) {
    spend(deps, ad, READ_COST);
    const c = await client.get<{ effective_object_story_id?: string; effective_instagram_media_id?: string }>(ad.meta_creative_id!, { fields: "effective_object_story_id,effective_instagram_media_id" }).catch(() => ({}) as { effective_object_story_id?: string; effective_instagram_media_id?: string });
    if (c.effective_object_story_id || c.effective_instagram_media_id) updateAd(ad.id, { meta_post_id: c.effective_object_story_id ?? null, meta_ig_media_id: c.effective_instagram_media_id ?? null });
  }

  setStep(ad, "Done. Paused in Ads Manager, waiting for your review.", "done");
  updateAd(ad.id, { error: null, error_detail: null, done_at: deps.clock.now(), work_points: deps.work?.get(ad.id) ?? null });
  deps.work?.delete(ad.id);
  logEvent(batch.id, ad.id, "info", `Created ad ${ad.meta_ad_id} for ${ad.creative_name}`);
}

/** At the start of every run: adopt anything Meta already has for this batch. */
async function reconcile(deps: LaunchDeps, batch: BatchRow) {
  const ads = getAds(batch.id).filter((a) => a.status !== "done");
  if (!ads.length) return;
  const need = lookupsNeeded(batch, ads);
  const none = Promise.resolve(new Map() as Found);
  const [foundAds, foundCreatives, foundAdsets] = await Promise.all([
    need.ads ? findByBatchKey(deps.client, "ads", batch.key, "id,name,creative{id}") : none,
    need.creatives ? findByBatchKey(deps.client, "adcreatives", batch.key) : none,
    need.adsets ? findByBatchKey(deps.client, "adsets", batch.key) : none,
  ]);
  for (const ad of ads) {
    const patch: Record<string, string> = {};
    // The look-up after a restore is done: later runs look up only what they try.
    const at = attemptsOf(ad);
    if (at.restored) {
      delete at.restored;
      ad.attempts = JSON.stringify(at);
      patch.attempts = ad.attempts;
    }
    const fa = foundAdsets.get(ad.key);
    const fc = foundCreatives.get(ad.key);
    const fd = foundAds.get(ad.key);
    if (fa && !ad.meta_adset_id) patch.meta_adset_id = fa.id;
    if (fc && !ad.meta_creative_id && creativeMatches(ad, fc.name)) patch.meta_creative_id = fc.id;
    if (fd && !ad.meta_ad_id) patch.meta_ad_id = fd.id;
    // The ad is in Meta: its creative is the one it uses (a creative shared with another ad set carries that ad's key).
    if (fd?.creative?.id && !ad.meta_creative_id && !patch.meta_creative_id) patch.meta_creative_id = fd.creative.id;
    const found = Object.keys(patch).filter((k) => k !== "attempts");
    if (Object.keys(patch).length) updateAd(ad.id, patch);
    if (found.length) {
      logEvent(batch.id, ad.id, "info", `Found ${found.map((k) => k.replace("meta_", "").replace("_id", "")).join(", ")} already in Meta for ${ad.key}; reusing instead of creating again.`);
    }
  }
}

export interface RunResult {
  done: number;
  failed: number;
}

/** Run a batch until every ad is done or failed. Safe to call again after a crash. */
export async function runBatch(batchId: number, deps: LaunchDeps): Promise<RunResult> {
  let batch = getBatch(batchId)!;
  updateBatch(batchId, { status: "running", run_count: batch.run_count + 1, launched_at: batch.launched_at ?? new Date().toISOString() });
  batch = getBatch(batchId)!;
  logEvent(batchId, null, "info", batch.run_count > 1 ? `Run ${batch.run_count} started (checking Meta for anything already created).` : "Launch started.");

  // A network drop or Meta hiccup at this point must not end the run: try a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      await reconcile(deps, batch);
      break;
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal) throw e;
      const access = e instanceof MetaError && isAccessError(e);
      if (attempt < 5 && !access && isTransientError(e)) {
        logEvent(batchId, null, "warn", `Couldn't reach Meta to check for earlier work (${attempt}/4). Trying again in ${attempt * 30} seconds.`);
        await deps.clock.sleep(attempt * 30_000);
        continue;
      }
      // Nothing can be created safely without this check: every ad not created yet is marked failed
      // with the reason in plain words (e.g. "Reconnect Meta"), and Retry starts again from here.
      const plain = plainError(e, "Checking Meta for ads made by an earlier run");
      const detail = e instanceof MetaError ? e.detail : String(e);
      const rest = getAds(batchId).filter((a) => a.status !== "done");
      for (const r of rest) updateAd(r.id, { status: "failed", error: plain, error_detail: detail, wait_until: null });
      logEvent(batchId, null, "error", `${plain} Stopped before creating anything; ${rest.length} ad${rest.length === 1 ? "" : "s"} not created yet.`);
      return finish(batchId);
    }
  }
  deps = { ...deps, waitStart: new Map(), work: new Map() };

  const tries = new Map<number, number>();
  for (;;) {
    const ads = getAds(batchId).filter((a) => a.status !== "done" && a.status !== "failed");
    if (!ads.length) break;
    if (getBatch(batchId)?.cancel_requested) {
      for (const a of ads) updateAd(a.id, { status: "failed", error: 'Cancelled before it was created. Press "Retry failed" to create it.', wait_until: null });
      logEvent(batchId, null, "warn", `Cancelled: ${ads.length} ad${ads.length > 1 ? "s" : ""} not created. Ads already created stay paused in Meta.`);
      break;
    }
    const now = deps.clock.now();
    const ready = ads.find((a) => a.status !== "waiting" || !a.wait_until || a.wait_until <= now);
    if (!ready) {
      const next = Math.min(...ads.map((a) => a.wait_until ?? now));
      await deps.clock.sleep(Math.max(1000, next - now));
      continue;
    }
    const ad = ready;
    try {
      const before = ad.step;
      await advanceAd(deps, batch, ad);
      if (getAds(batchId).find((a) => a.id === ad.id)?.step !== before) tries.delete(ad.id); // progress: fresh retry budget
    } catch (e) {
      // A "fatal" error stands for the process dying (tests use it to simulate a kill).
      if ((e as { fatal?: boolean }).fatal) throw e;
      const n = (tries.get(ad.id) ?? 0) + 1;
      tries.set(ad.id, n);
      const said = e instanceof StepError ? e.plain : e instanceof MetaError && e.subcode === 1815199 ? igNotAllowedText(e, stepVerb(ad.step ?? "Launching")) : plainError(e, stepVerb(ad.step ?? "Launching"));
      const note = (e as { note?: string }).note;
      const plain = note ? `${said} ${note}` : said;
      const detail = e instanceof StepError ? e.detail : e instanceof MetaError ? e.detail : String(e);
      const transient = e instanceof StepError ? e.transient : isTransientError(e);
      // The Meta connection expired or lost permission: every other ad would fail the same way.
      if (e instanceof MetaError && isAccessError(e)) {
        const rest = getAds(batchId).filter((a) => a.status !== "done");
        for (const r of rest) updateAd(r.id, { status: "failed", error: plain, error_detail: detail, wait_until: null });
        logEvent(batchId, null, "error", `${plain} Stopped the launch; ${rest.length} ad${rest.length === 1 ? "" : "s"} not created yet.`);
        break;
      }
      if (transient && n < MAX_TRANSIENT_TRIES) {
        logEvent(batchId, ad.id, "warn", `${plain} Trying again (${n}/${MAX_TRANSIENT_TRIES - 1}).`);
        updateAd(ad.id, { status: "waiting", wait_until: deps.clock.now() + 10_000 * n });
        continue;
      }
      updateAd(ad.id, { status: "failed", error: plain, error_detail: detail, wait_until: null });
      logEvent(batchId, ad.id, "error", plain);
    }
  }

  return finish(batchId);
}

/** The end of a run: the batch's status, and (when every ad is in) its old failure alerts leave the home page. */
function finish(batchId: number): RunResult {
  const final = getAds(batchId);
  const done = final.filter((a) => a.status === "done").length;
  const failed = final.length - done;
  updateBatch(batchId, { status: failed === 0 ? "done" : done === 0 ? "failed" : "partial", finished_at: new Date().toISOString() });
  logEvent(batchId, null, failed ? "warn" : "info", `Finished: ${done} ad${done === 1 ? "" : "s"} created${failed ? `, ${failed} failed` : ""}.`);
  if (failed === 0) clearBatchAlerts(batchId);
  return { done, failed };
}

/**
 * Every ad is in: remove the home page alerts about ads not created and launches that stopped, for
 * this batch and the batches launched with it that are done too. "Ads created but not turned on yet"
 * stays until the turn-on step went through (go_live_done): the ads are still paused until then.
 */
export function clearBatchAlerts(batchId: number): number {
  const b = getBatch(batchId);
  if (!b) return 0;
  const group = b.group_key
    ? (db().prepare("SELECT key, go_live_done FROM batches WHERE group_key = ? AND (id = ? OR status = 'done')").all(b.group_key, b.id) as { key: string; go_live_done: number }[])
    : [{ key: b.key, go_live_done: b.go_live_done }];
  return group.reduce((n, x) => n + clearAlerts(`/batches/${x.key}`, x.go_live_done ? ["create_failed", "stopped", "golive"] : ["create_failed", "stopped"]), 0);
}

/**
 * 200/1815199 for a batch already launched. The batch keeps its own copy of the settings preset, so
 * editing the preset in Settings does not reach it: the fix is to retry the batch with another preset.
 */
function igNotAllowedText(e: MetaError, doing: string): string {
  return `${doing} failed: the ad account is not allowed to use the Instagram account in this batch's settings preset. Fix one of two ways: (1) in Meta Business settings → Accounts → Instagram accounts → pick the account → Assign assets → add this ad account, then press "Retry failed"; or (2) retry this batch with a settings preset set to "No Instagram account (use the Facebook Page)" (ask Claude: retry_failed with that settings preset). Editing the preset in Settings alone does not change a batch that was already launched.${metaSaid(e)}`;
}

function stepVerb(step: string): string {
  return step.replace(/\s*\(\d+%\)$/, "").replace(/^Waiting for Meta to process/, "Processing");
}

/** "Retry failed only": every ad not yet created goes back to pending (failed ads, and ads a
 *  stopped run left half-way); done ads are never touched. */
export function resetFailed(batchId: number): number {
  const res = db().prepare("UPDATE ads SET status = 'pending', error = NULL, error_detail = NULL, wait_until = NULL, step = NULL WHERE batch_id = ? AND status != 'done'").run(batchId);
  return res.changes;
}

/** Worth trying again: Meta's transient errors, network drops, and Google Drive hiccups. */
export function isTransientError(e: unknown): boolean {
  if (e instanceof MetaError) return e.isTransient;
  const err = e as { code?: string | number; status?: number; response?: { status?: number }; message?: string; name?: string };
  const status = Number(err?.response?.status ?? err?.status ?? 0);
  if (status === 429 || status >= 500) return true;
  if (typeof err?.code === "string" && /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_\w+)$/.test(err.code)) return true;
  return err?.name === "AbortError" || err?.name === "TimeoutError" || /fetch failed|socket hang up|network|timed? ?out/i.test(err?.message ?? "");
}

/** The token expired or lacks a permission: retrying ad by ad can't help. */
function isAccessError(e: MetaError): boolean {
  const c = e.code ?? 0;
  return c === 190 || c === 102 || c === 10 || (c >= 200 && c <= 299);
}

/** After launch: read each ad's review status and explain problems in plain words. One read per 100 ads. */
export async function checkReview(client: MetaClient, batchId: number): Promise<{ pending: number }> {
  const batch = getBatch(batchId)!;
  const ads = getAds(batchId).filter((a) => a.meta_ad_id);
  if (!ads.length) return { pending: 0 };
  type Row = { id: string; name: string; effective_status?: string; ad_review_feedback?: Record<string, unknown>; issues_info?: { error_summary?: string; error_message?: string }[]; creative?: { effective_object_story_id?: string; effective_instagram_media_id?: string } };
  const rows = await listByName<Row>(client, "ads", `[L:${batch.key}-`, "id,name,effective_status,ad_review_feedback,issues_info,creative{effective_object_story_id,effective_instagram_media_id}");
  const byId = new Map(rows.map((r) => [r.id, r]));
  let pending = 0;
  for (const ad of ads) {
    const r = byId.get(ad.meta_ad_id!);
    if (!r) {
      updateAd(ad.id, { effective_status: "DELETED", review_issues: JSON.stringify(["Not found in Meta: it may have been deleted or archived."]) });
      continue;
    }
    const issues = reviewIssues(r);
    if (r.effective_status === "PENDING_REVIEW" || r.effective_status === "IN_PROCESS") pending++;
    updateAd(ad.id, {
      effective_status: r.effective_status ?? null,
      review_issues: issues.length ? JSON.stringify(issues) : null,
      ...(r.creative?.effective_object_story_id ? { meta_post_id: r.creative.effective_object_story_id } : {}),
      ...(r.creative?.effective_instagram_media_id ? { meta_ig_media_id: r.creative.effective_instagram_media_id } : {}),
    });
  }
  return { pending };
}

// Meta's review feedback in plain words (placement-specific reasons are one level deeper).
const reviewIssues = feedbackLines;

/** Plain words for Meta's review status. */
export function reviewLabel(status: string | null): string {
  switch (status) {
    case null:
    case undefined:
      return "Not checked yet";
    case "PENDING_REVIEW":
    case "IN_PROCESS":
      return "In Meta review";
    case "PAUSED":
    case "ADSET_PAUSED":
    case "CAMPAIGN_PAUSED":
      return "Approved, paused";
    case "DISAPPROVED":
      return "Rejected by Meta";
    case "WITH_ISSUES":
      return "Has issues";
    case "DELETED":
    case "ARCHIVED":
      return "Deleted or archived";
    case "PREAPPROVED":
      return "Pre-approved, paused";
    case "ACTIVE":
      return "Active";
    default:
      return status.replace(/_/g, " ").toLowerCase();
  }
}

export const _test = { reviewIssues, json };
