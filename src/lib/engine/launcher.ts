import { createHash } from "node:crypto";
import { db, json } from "../db";
import type { MetaClient } from "../meta/client";
import { buildCreative, clean, type CreativeAsset } from "../meta/creative";
import { MetaError, plainError } from "../meta/errors";
import { featureWarnings } from "../meta/features";
import { getMedia, saveMedia, uploadImage, uploadVideo, videoStatus, videoThumbnail } from "../meta/upload";
import type { Clock } from "../meta/pacer";
import { adCopy, attemptsOf, batchPreset, getAdAssets, getAds, getBatch, logEvent, updateAd, updateBatch } from "../store";
import type { AdRow, AssetRow, BatchRow } from "../types";
import { slotOf } from "./grouping";
import { extractFrame } from "./media";
import { keyTag, metaName, renderUtm } from "./naming";
import { adNameContext } from "./preview";

// The launch engine. Runs one batch to the end, one Meta call at a time, paced.
//
// No duplicates, even after a crash, a timeout or a database restore:
//  1. Every object name carries the ad's key, e.g. "[L:b7k2x-03]".
//  2. Each run starts by listing objects in Meta whose name contains "[L:<batch key>-"
//     and adopting them (3 reads per run, whatever the batch size).
//  3. Before any create we write "attempted" to the database. If a create gets no clear
//     answer, the retry looks the object up in Meta by its key before creating again.
//  4. Media is keyed by file checksum, so the same file is never uploaded twice.

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
}

type Found = Map<string, { id: string; name: string }>;

const TAG_RE = /\[L:([a-z0-9]+-\d+)\]/;

const LIVE_STATUSES = ["ACTIVE", "PAUSED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES"];

/**
 * List objects on an edge whose name contains `needle`. Uses Meta's name filter; if Meta
 * refuses the filter on that edge (not documented for /adcreatives), lists recent objects
 * and matches here instead.
 */
async function listByName<T extends { id: string; name: string }>(client: MetaClient, edge: "ads" | "adsets" | "adcreatives", needle: string, fields = "id,name"): Promise<T[]> {
  const base: Record<string, unknown> = { fields };
  if (edge !== "adcreatives") base.effective_status = LIVE_STATUSES;
  try {
    return await client.getAll<T>(`${client.accountId}/${edge}`, { ...base, filtering: [{ field: "name", operator: "CONTAIN", value: needle }] });
  } catch (e) {
    if (!(e instanceof MetaError) || e.isTransient) throw e;
    const recent = await client.getAll<T>(`${client.accountId}/${edge}`, base, 1000);
    return recent.filter((r) => r.name?.includes(needle));
  }
}

async function findByBatchKey(client: MetaClient, edge: "ads" | "adsets" | "adcreatives", batchKey: string): Promise<Found> {
  const rows = await listByName(client, edge, `[L:${batchKey}-`);
  const out: Found = new Map();
  for (const r of rows) {
    const m = TAG_RE.exec(r.name);
    if (m && !out.has(m[1])) out.set(m[1], r);
  }
  return out;
}

async function findOne(client: MetaClient, edge: "ads" | "adsets" | "adcreatives", adKey: string): Promise<string | null> {
  const rows = await listByName(client, edge, keyTag(adKey));
  return rows[0]?.id ?? null;
}

/** A stable UUID (v4 layout) for one logical create, so Meta's idempotency key matches on retry. */
export function idempotencyKey(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

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
    const existing = await findOne(deps.client, edge, ad.key);
    if (existing) return { id: existing, adopted: true };
  }
  bumpAttempt(ad, kind);
  const gen = attemptsOf(ad)[`${kind}_gen`] ?? 0;
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
      hash = await uploadImage(client, local.local_path, asset.filename);
      saveMedia({ ad_account_id: accountDbId, sha256: local.sha256, kind: "image", image_hash: hash, status: "ready" });
    }
    return { ready: true, creativeAsset: { kind: "image", slot: slotOf(asset.ratio), imageHash: hash } };
  }

  // Video
  let videoId = media?.video_id ?? null;
  if (!videoId || media?.status === "uploading" || media?.status === "error") {
    setStep(ad, `Uploading ${asset.filename}`);
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
    const uri = await videoThumbnail(client, videoId);
    if (uri) {
      saveMedia({ ad_account_id: accountDbId, sha256: local.sha256, kind: "video", status: "ready", thumbnail_url: uri });
    } else {
      const out = `${deps.tmpDir}/${local.sha256.slice(0, 16)}.jpg`;
      await extractFrame(local.local_path, out);
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
  } else {
    if (!adsetId) {
      setStep(ad, "Creating the ad set (copy of the template)");
      const { id, adopted } = await createOnce(deps, ad, "adset", "adsets", async (key) => {
        // The copy carries the key from the start (rename_suffix), so a retry can always find it.
        const res = await client.post<{ copied_adset_id?: string; ad_object_ids?: { copied_id: string }[] }>(`${batch.adset_id}/copies`, {
          deep_copy: false,
          status_option: "PAUSED",
          rename_options: { rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` ${keyTag(ad.key)}` },
        }, { idempotencyKey: key });
        const newId = res.copied_adset_id ?? res.ad_object_ids?.[0]?.copied_id;
        if (!newId) throw new MetaError("Meta did not return the new ad set ID", { status: 200 });
        return newId;
      });
      adsetId = id;
      updateAd(ad.id, { meta_adset_id: adsetId });
      if (adopted) logEvent(batch.id, ad.id, "info", `Found the ad set Meta already created for ${ad.key}; reused it.`);
    }
    // Rename from "<template name> [L:key]" to the naming template. Safe to repeat.
    if (!attemptsOf(ad).adset_named) {
      setStep(ad, "Naming the new ad set");
      await client.post(adsetId, { name: metaName(ad.adset_name ?? ad.creative_name, ad.key, prefix) });
      bumpAttempt(ad, "adset_named");
    }
  }
  ad.meta_adset_id = adsetId;

  // 3. Creative
  const preset = batchPreset(batch);
  if (!ad.meta_creative_id) {
    setStep(ad, "Creating the creative");
    const copy = adCopy(batch, ad);
    const ctx = adNameContext(batch, ad, assets);
    const body = clean(
      buildCreative({ name: metaName(ad.name ?? ad.creative_name, ad.key, prefix, 80), copy, urlTags: renderUtm(copy.utmTemplate, ctx), preset, assets: creativeAssets }),
    );
    const { id, adopted } = await createOnce(deps, ad, "creative", "adcreatives", async (key) => {
      const res = await client.post<{ id: string }>(`${client.accountId}/adcreatives`, body, { idempotencyKey: key });
      return res.id;
    });
    ad.meta_creative_id = id;
    updateAd(ad.id, { meta_creative_id: id });
    if (adopted) logEvent(batch.id, ad.id, "info", `Found the creative Meta already created for ${ad.key}; reused it.`);

    // Read back the enhancements Meta actually stored.
    const stored = await client.get<{ degrees_of_freedom_spec?: { creative_features_spec?: Record<string, { enroll_status?: string }> } }>(id, {
      fields: "degrees_of_freedom_spec",
    });
    const warnings = featureWarnings(stored.degrees_of_freedom_spec?.creative_features_spec, preset.enhancements);
    updateAd(ad.id, { feature_warnings: JSON.stringify(warnings) });
    for (const w of warnings) logEvent(batch.id, ad.id, "warn", w);
  }

  // 4. Ad, always PAUSED.
  if (!ad.meta_ad_id) {
    setStep(ad, "Creating the ad (paused)");
    const { id, adopted } = await createOnce(deps, ad, "ad", "ads", async (key) => {
      const res = await client.post<{ id: string }>(
        `${client.accountId}/ads`,
        { name: metaName(ad.name ?? ad.creative_name, ad.key, prefix), adset_id: adsetId, creative: { creative_id: ad.meta_creative_id }, status: "PAUSED" },
        { idempotencyKey: key },
      );
      return res.id;
    });
    ad.meta_ad_id = id;
    updateAd(ad.id, { meta_ad_id: id });
    if (adopted) logEvent(batch.id, ad.id, "info", `Found the ad Meta already created for ${ad.key}; reused it.`);
  }

  setStep(ad, "Done. Paused in Ads Manager, waiting for your review.", "done");
  updateAd(ad.id, { error: null, error_detail: null });
  logEvent(batch.id, ad.id, "info", `Created ad ${ad.meta_ad_id} for ${ad.creative_name}`);
}

/** At the start of every run: adopt anything Meta already has for this batch. */
async function reconcile(deps: LaunchDeps, batch: BatchRow) {
  const ads = getAds(batch.id).filter((a) => a.status !== "done");
  if (!ads.length) return;
  const [foundAds, foundCreatives, foundAdsets] = await Promise.all([
    findByBatchKey(deps.client, "ads", batch.key),
    findByBatchKey(deps.client, "adcreatives", batch.key),
    batch.adset_mode === "new_per_ad" ? findByBatchKey(deps.client, "adsets", batch.key) : Promise.resolve(new Map() as Found),
  ]);
  for (const ad of ads) {
    const patch: Record<string, string> = {};
    const fa = foundAdsets.get(ad.key);
    const fc = foundCreatives.get(ad.key);
    const fd = foundAds.get(ad.key);
    if (fa && !ad.meta_adset_id) patch.meta_adset_id = fa.id;
    if (fc && !ad.meta_creative_id) patch.meta_creative_id = fc.id;
    if (fd && !ad.meta_ad_id) patch.meta_ad_id = fd.id;
    if (Object.keys(patch).length) {
      updateAd(ad.id, patch);
      logEvent(batch.id, ad.id, "info", `Found ${Object.keys(patch).map((k) => k.replace("meta_", "").replace("_id", "")).join(", ")} already in Meta for ${ad.key}; reusing instead of creating again.`);
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
      if (attempt >= 5 || !isTransientError(e)) throw e;
      logEvent(batchId, null, "warn", `Couldn't reach Meta to check for earlier work (${attempt}/4). Trying again in ${attempt * 30} seconds.`);
      await deps.clock.sleep(attempt * 30_000);
    }
  }
  deps = { ...deps, waitStart: new Map() };

  const tries = new Map<number, number>();
  for (;;) {
    const ads = getAds(batchId).filter((a) => a.status !== "done" && a.status !== "failed");
    if (!ads.length) break;
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
      const plain = e instanceof StepError ? e.plain : plainError(e, stepVerb(ad.step ?? "Launching"));
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

  const final = getAds(batchId);
  const done = final.filter((a) => a.status === "done").length;
  const failed = final.length - done;
  updateBatch(batchId, { status: failed === 0 ? "done" : done === 0 ? "failed" : "partial", finished_at: new Date().toISOString() });
  logEvent(batchId, null, failed ? "warn" : "info", `Finished: ${done} ad${done === 1 ? "" : "s"} created${failed ? `, ${failed} failed` : ""}.`);
  return { done, failed };
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
  type Row = { id: string; name: string; effective_status?: string; ad_review_feedback?: Record<string, unknown>; issues_info?: { error_summary?: string; error_message?: string }[] };
  const rows = await listByName<Row>(client, "ads", `[L:${batch.key}-`, "id,name,effective_status,ad_review_feedback,issues_info");
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
    updateAd(ad.id, { effective_status: r.effective_status ?? null, review_issues: issues.length ? JSON.stringify(issues) : null });
  }
  return { pending };
}

function reviewIssues(r: { ad_review_feedback?: Record<string, unknown>; issues_info?: { error_summary?: string; error_message?: string }[] }): string[] {
  const out: string[] = [];
  for (const i of r.issues_info ?? []) out.push([i.error_summary, i.error_message].filter(Boolean).join(": "));
  const fb = r.ad_review_feedback ?? {};
  for (const section of Object.values(fb)) {
    if (section && typeof section === "object") for (const [k, v] of Object.entries(section)) out.push(`${k}: ${String(v)}`);
  }
  return out;
}

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
