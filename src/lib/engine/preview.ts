import { db } from "../db";
import { GB, freeBytes } from "../cleanup";
import { pacTextsLimited } from "../meta/creative";
import { getMedia } from "../meta/upload";
import { adChecks, adCopy, batchPreset, getAdAssets, getAds, getAssets, getBatch, updateAd, updateBatch } from "../store";
import type { AdRow, AssetRow, BatchRow, Check } from "../types";
import { estimate, type Estimate, type PlanAd } from "./estimate";
import { formatLabel, groupFiles, slotOf } from "./grouping";
import { humanSize, ratioText } from "./media";
import { metaName, renderName, renderUtm, unknownTokens, type NameContext } from "./naming";

// Everything between "files picked" and "launch": grouping, names, checks, estimate.

// Limits. Sources: docs/META-API-NOTES.md section 14.
export const LIMITS = {
  imageMaxBytes: 30 * 1024 * 1024,
  imageMinWidth: 600,
  imageGoodWidth: 1080,
  videoMaxBytes: 4 * 1024 ** 3,
  videoMaxSec: 241 * 60,
  verticalLongSec: 90,
  videoMinWidth: 500,
  primaryTextSoft: 125,
  primaryTextHard: 1024,
  headlineSoft: 40,
  headlineHard: 255,
  descriptionSoft: 30,
  descriptionHard: 255,
  maxTexts: 5,
};

// ---------- Grouping ----------

/** Group files that are not in an ad yet. Matching names join an existing ad. */
export function autoGroup(batchId: number) {
  const batch = getBatch(batchId)!;
  const loose = getAssets(batchId).filter((a) => a.ad_id === null && a.kind !== "unsupported");
  if (!loose.length) return;
  const groups = groupFiles(loose.map((a) => ({ id: a.id, filename: a.filename, relPath: a.rel_path, kind: a.kind, ratio: a.ratio })));
  const existing = getAds(batchId);
  const tx = db().transaction(() => {
    for (const g of groups) {
      const kind = loose.find((a) => a.id === g.assetIds[0])!.kind;
      const match = existing.find((ad) => ad.creative_name === g.name && getAdAssets(ad.id)[0]?.kind === kind);
      const adId = match ? match.id : newAd(batch, g.name);
      for (const id of g.assetIds) db().prepare("UPDATE assets SET ad_id = ? WHERE id = ?").run(adId, id);
    }
    renumber(batchId);
  });
  tx.immediate();
}

function newAd(batch: BatchRow, name: string): number {
  const pos = (db().prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM ads WHERE batch_id = ?").get(batch.id) as { p: number }).p;
  const res = db().prepare("INSERT INTO ads (batch_id, position, key, creative_name) VALUES (?, ?, ?, ?)").run(batch.id, pos, `${batch.key}-tmp${pos}-${Date.now() % 100000}`, name);
  return Number(res.lastInsertRowid);
}

/** Drop empty ads and give every ad a clean number and key (01, 02, ...). Only before launch. */
export function renumber(batchId: number) {
  const batch = getBatch(batchId)!;
  db().prepare("DELETE FROM ads WHERE batch_id = ? AND id NOT IN (SELECT DISTINCT ad_id FROM assets WHERE ad_id IS NOT NULL)").run(batchId);
  const ads = getAds(batchId);
  // Two passes so keys never collide on the UNIQUE index.
  for (const ad of ads) db().prepare("UPDATE ads SET key = ? WHERE id = ?").run(`${batch.key}-tmp${ad.id}`, ad.id);
  ads.forEach((ad, i) => {
    db().prepare("UPDATE ads SET position = ?, key = ? WHERE id = ?").run(i + 1, `${batch.key}-${String(i + 1).padStart(2, "0")}`, ad.id);
  });
}

/** Drag-and-drop: move a file to another ad, or to a new ad of its own. */
export function moveAsset(batchId: number, assetId: number, toAdId: number | "new") {
  const batch = getBatch(batchId)!;
  if (batch.status !== "draft") throw new Error("This batch has already been launched; its grouping can't change.");
  const asset = db().prepare("SELECT * FROM assets WHERE id = ? AND batch_id = ?").get(assetId, batchId) as AssetRow | undefined;
  if (!asset) throw new Error("File not found in this batch.");
  db().transaction(() => {
    let target: number;
    if (toAdId === "new") {
      target = newAd(batch, asset.filename.replace(/\.[^.]+$/, ""));
    } else {
      const ad = db().prepare("SELECT id FROM ads WHERE id = ? AND batch_id = ?").get(toAdId, batchId);
      if (!ad) throw new Error("Ad not found in this batch.");
      target = toAdId;
    }
    db().prepare("UPDATE assets SET ad_id = ? WHERE id = ?").run(target, assetId);
    renumber(batchId);
  }).immediate();
}

export function removeAsset(batchId: number, assetId: number) {
  const batch = getBatch(batchId)!;
  if (batch.status !== "draft") throw new Error("This batch has already been launched.");
  db().prepare("DELETE FROM assets WHERE id = ? AND batch_id = ?").run(assetId, batchId);
  renumber(batchId);
}

// ---------- Names ----------

export function adNameContext(batch: BatchRow, ad: AdRow, assets: AssetRow[]): NameContext {
  const copyName = batch.copy_template_id
    ? (db().prepare("SELECT name FROM copy_templates WHERE id = ?").get(batch.copy_template_id) as { name: string } | undefined)?.name
    : undefined;
  return {
    date: batch.launched_at ? new Date(batch.launched_at) : new Date(),
    creative: ad.creative_name,
    angle: ad.angle ?? batch.angle,
    format: formatLabel(assets),
    n: ad.position,
    batch: batch.key,
    copy: copyName ?? "",
    campaign: batch.campaign_name ?? "",
    adset: batch.adset_mode === "existing" ? (batch.adset_name ?? "") : "",
    persona: batch.persona ?? "",
  };
}

export function computeNames(batchId: number) {
  const batch = getBatch(batchId)!;
  for (const ad of getAds(batchId)) {
    const ctx = adNameContext(batch, ad, getAdAssets(ad.id));
    const adsetName = batch.adset_mode === "new_per_ad" ? renderName(batch.adset_name_template, ctx) : batch.adset_name ?? "";
    const name = renderName(batch.ad_name_template, { ...ctx, adset: adsetName });
    updateAd(ad.id, { name, adset_name: adsetName });
  }
}

// ---------- Checks ----------

export interface DestinationInfo {
  adset?: { id: string; name: string; is_dynamic_creative?: boolean; ad_count?: number } | null;
  /** Set when Meta says the ad account may not use the preset's Instagram account (code 200/1815199). */
  igProblem?: string;
}

/** Meta allows at most 50 ads (not archived or deleted) in one ad set. */
export const MAX_ADS_PER_ADSET = 50;

function textChecks(label: string, texts: string[], soft: number, hard: number, out: Check[]) {
  texts.forEach((t, i) => {
    const which = texts.length > 1 ? `${label} ${i + 1}` : label;
    if (t.length > hard) out.push({ level: "error", code: "text_too_long", message: `${which} is ${t.length} characters. Meta's limit is ${hard}. Shorten it.` });
    else if (t.length > soft) out.push({ level: "warning", code: "text_long", message: `${which} is ${t.length} characters. Over ${soft} gets cut off with "See more" on most placements.` });
  });
}

export function checkAd(batch: BatchRow, ad: AdRow, assets: AssetRow[]): Check[] {
  const out: Check[] = [];
  const copy = adCopy(batch, ad);

  if (!assets.length) out.push({ level: "error", code: "no_files", message: "This ad has no files." });

  // Files
  for (const a of assets) {
    if (a.kind === "image" && a.size_bytes > LIMITS.imageMaxBytes) out.push({ level: "error", code: "file_too_big", message: `${a.filename} is ${humanSize(a.size_bytes)}. Images must be under 30 MB.` });
    if (a.kind === "video" && a.size_bytes > LIMITS.videoMaxBytes) out.push({ level: "error", code: "file_too_big", message: `${a.filename} is ${humanSize(a.size_bytes)}. Videos must be under 4 GB.` });
    if (a.kind === "video" && a.duration_sec && a.duration_sec > LIMITS.videoMaxSec) out.push({ level: "error", code: "video_too_long", message: `${a.filename} is ${Math.round(a.duration_sec / 60)} minutes long. Meta's limit is 241 minutes.` });
    if (a.kind === "video" && a.ratio === "9x16" && a.duration_sec && a.duration_sec > LIMITS.verticalLongSec) {
      out.push({ level: "warning", code: "vertical_long", message: `${a.filename} is ${Math.round(a.duration_sec)} seconds. Stories and Reels work best under ${LIMITS.verticalLongSec} seconds.` });
    }
    if (!a.width || !a.height) out.push({ level: "warning", code: "size_unknown", message: `Couldn't read the size of ${a.filename}. Grouping used the file name only.` });
    else if (a.kind === "image" && a.width < LIMITS.imageMinWidth) out.push({ level: "error", code: "too_small", message: `${a.filename} is only ${ratioText(a.width, a.height)}. Meta needs at least ${LIMITS.imageMinWidth} pixels wide.` });
    else if (a.kind === "image" && a.width < LIMITS.imageGoodWidth) out.push({ level: "warning", code: "low_res", message: `${a.filename} is ${ratioText(a.width, a.height)}. It may look blurry; 1080 pixels wide or more is better.` });
    else if (a.kind === "video" && a.width < LIMITS.videoMinWidth) out.push({ level: "warning", code: "low_res", message: `${a.filename} is ${ratioText(a.width, a.height)}. It may look blurry.` });
  }

  // Placement grouping
  if (assets.length > 1) {
    const kinds = new Set(assets.map((a) => a.kind));
    if (kinds.size > 1) out.push({ level: "error", code: "mixed_kinds", message: "This ad mixes images and videos. Drag them into separate ads." });
    const bySlot = new Map<string, AssetRow[]>();
    for (const a of assets) {
      const s = slotOf(a.ratio);
      if (!s) {
        out.push({ level: "error", code: "unknown_ratio", message: `${a.filename} is ${ratioText(a.width, a.height)}, which is neither vertical (9:16) nor feed (4:5, 1:1). Move it to its own ad.` });
        continue;
      }
      bySlot.set(s, [...(bySlot.get(s) ?? []), a]);
    }
    for (const [slot, list] of bySlot) {
      if (list.length > 1) {
        out.push({ level: "error", code: "slot_clash", message: `Two files for ${slot === "vertical" ? "Stories and Reels" : "Feed"}: ${list.map((a) => a.filename).join(" and ")}. Drag one into another ad.` });
      }
    }
    if (!bySlot.has("vertical") && bySlot.size) out.push({ level: "warning", code: "no_vertical", message: "No vertical (9:16) version. Stories and Reels will show the feed version." });
    if (!bySlot.has("feed") && bySlot.size) out.push({ level: "warning", code: "no_feed", message: "No feed (4:5 or 1:1) version. Feed will show the vertical version, cropped." });
  } else if (assets.length === 1) {
    const a = assets[0];
    const what = a.kind === "video" ? "video" : "image";
    if (a.ratio === "9x16") out.push({ level: "warning", code: "no_feed", message: `This ${what} has no feed (4:5) version. Feed will show the 9:16 file, cropped.` });
    else if (a.ratio === "4x5" || a.ratio === "1x1") out.push({ level: "warning", code: "no_vertical", message: `This ${what} has no vertical (9:16) version. Stories and Reels will show it with empty space around it.` });
    else if (a.ratio === "other") out.push({ level: "warning", code: "odd_ratio", message: `${a.filename} is ${ratioText(a.width, a.height)}, an unusual shape. Meta may crop it.` });
  }

  // Copy
  if (assets.length > 1 && pacTextsLimited() && (copy.primaryTexts.length > 1 || copy.headlines.length > 1)) {
    out.push({ level: "warning", code: "pac_one_text", message: "Meta doesn't accept several texts in an ad with separate vertical and feed files. Only the first primary text and headline will be used for this ad." });
  }
  if (!copy.primaryTexts.length) out.push({ level: "error", code: "no_text", message: "No primary text. Pick a copy template or add text to this ad." });
  if (!copy.headlines.length) out.push({ level: "warning", code: "no_headline", message: "No headline." });
  if (copy.primaryTexts.length > LIMITS.maxTexts) out.push({ level: "error", code: "too_many_texts", message: `${copy.primaryTexts.length} primary texts. Meta allows up to 5.` });
  if (copy.headlines.length > LIMITS.maxTexts) out.push({ level: "error", code: "too_many_texts", message: `${copy.headlines.length} headlines. Meta allows up to 5.` });
  textChecks("Primary text", copy.primaryTexts, LIMITS.primaryTextSoft, LIMITS.primaryTextHard, out);
  textChecks("Headline", copy.headlines, LIMITS.headlineSoft, LIMITS.headlineHard, out);
  if (copy.description) textChecks("Description", [copy.description], LIMITS.descriptionSoft, LIMITS.descriptionHard, out);
  if (!copy.linkUrl) out.push({ level: "error", code: "no_link", message: "No landing page URL." });
  else if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(copy.linkUrl)) out.push({ level: "error", code: "bad_link", message: `The landing page "${copy.linkUrl}" is not a full web address. It must start with https://` });
  const utmUnknown = unknownTokens(copy.utmTemplate);
  if (utmUnknown.length) out.push({ level: "warning", code: "utm_token", message: `UTM template has unknown words in braces: ${utmUnknown.join(", ")}. They will be sent as typed.` });

  return out;
}

export function checkBatch(batch: BatchRow, dest: DestinationInfo): Check[] {
  const out: Check[] = [];
  const preset = batchPreset(batch);
  const ads = getAds(batch.id);
  if (!ads.length) out.push({ level: "error", code: "no_ads", message: "No images or videos in this batch yet." });
  // Drive files are downloaded to the server during the launch: make sure they fit.
  const free = freeBytes();
  if (free !== null) {
    const toDownload = (db().prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM assets WHERE batch_id = ? AND ad_id IS NOT NULL AND local_path IS NULL").get(batch.id) as { n: number }).n;
    if (free - toDownload < 2 * GB) {
      out.push({ level: "error", code: "disk_full", message: `The server has ${(free / GB).toFixed(1)} GB free and this batch needs about ${(toDownload / GB).toFixed(1)} GB more. Ask your admin to free space before launching.` });
    }
  }
  if (!batch.campaign_id) out.push({ level: "error", code: "no_campaign", message: "Pick a campaign." });
  if (!batch.adset_id) out.push({ level: "error", code: "no_adset", message: batch.adset_mode === "new_per_ad" ? "Pick the ad set to copy for each new ad set." : "Pick an ad set." });
  if (dest.adset === null) out.push({ level: "error", code: "adset_missing", message: "The chosen ad set no longer exists in Meta. Pick another one." });
  if (batch.adset_mode === "existing" && ads.length) {
    const already = dest.adset?.ad_count ?? 0;
    if (already + ads.length > MAX_ADS_PER_ADSET) {
      out.push({
        level: "error",
        code: "adset_full",
        message: `Meta allows ${MAX_ADS_PER_ADSET} ads in one ad set. ${already ? `This ad set already has ${already}, and this batch adds ${ads.length}.` : `This batch has ${ads.length}.`} Tick "Put each ad in its own new ad set", or split the files into smaller batches.`,
      });
    }
  }
  if (dest.adset?.is_dynamic_creative) {
    out.push({
      level: "error",
      code: "dynamic_creative",
      message: `"${dest.adset.name}" has Dynamic creative switched on. Ads from this tool can't go there: Meta would mix their files and texts into one ad. Pick another ad set, or switch Dynamic creative off in Ads Manager.`,
    });
  }
  if (!preset.pageId) out.push({ level: "error", code: "no_page", message: "Pick a Facebook Page in Meta settings." });
  if (dest.igProblem) out.push({ level: "error", code: "ig_not_allowed", message: dest.igProblem });
  if (batch.go_live === "at" && (!batch.go_live_at || Date.parse(batch.go_live_at) < Date.now())) out.push({ level: "error", code: "go_live_time", message: "Pick a time in the future to turn the ads on." });
  if (!preset.igUserId) out.push({ level: "warning", code: "no_instagram", message: "No Instagram account picked. On Instagram, ads will show your Facebook Page's name and picture." });
  const skipped = getAssets(batch.id).filter((a) => a.kind === "unsupported");
  if (skipped.length) {
    out.push({ level: "warning", code: "skipped_files", message: `Skipped ${skipped.length} file${skipped.length > 1 ? "s" : ""} that ${skipped.length > 1 ? "are" : "is"} not JPG, PNG, MP4 or MOV: ${skipped.slice(0, 5).map((a) => a.filename).join(", ")}${skipped.length > 5 ? "…" : ""}` });
  }
  const unknown = [...unknownTokens(batch.ad_name_template), ...unknownTokens(batch.adset_name_template)];
  if (unknown.length) out.push({ level: "warning", code: "name_token", message: `Naming template has unknown words in braces: ${unknown.join(", ")}. They will appear as typed.` });
  return out;
}

/** Fetch each distinct landing page once. Not loading is a warning, not an error. */
export async function checkLinks(urls: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await Promise.all(
    [...new Set(urls)].filter((u) => /^https?:\/\//i.test(u)).map(async (url) => {
      try {
        const res = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Mozilla/5.0 (SahajtaAdsLauncher link check)" } });
        out.set(url, res.ok ? null : `returned error ${res.status}`);
        await res.body?.cancel();
      } catch (e) {
        out.set(url, e instanceof Error && e.name === "TimeoutError" ? "did not respond in 10 seconds" : "could not be reached");
      }
    }),
  );
  return out;
}

// ---------- Preview ----------

export interface PreviewAd {
  id: number;
  position: number;
  key: string;
  creativeName: string;
  name: string;
  metaName: string;
  adsetName: string;
  angle: string;
  files: { id: number; filename: string; kind: string; ratio: string | null; size: string; dims: string; durationSec: number | null; placement: string }[];
  copy: ReturnType<typeof adCopy>;
  hasOverride: boolean;
  /** This ad's own copy changes (empty when it uses the batch copy). */
  override: Partial<ReturnType<typeof adCopy>>;
  urlTags: string;
  checks: Check[];
  status: string;
  step: string | null;
  error: string | null;
  metaAdId: string | null;
  metaAdsetId: string | null;
  effectiveStatus: string | null;
  reviewIssues: string[];
  featureWarnings: string[];
}

export interface Preview {
  batchChecks: Check[];
  ads: PreviewAd[];
  errors: number;
  warnings: number;
  estimate: Estimate;
}

function placementLabel(a: AssetRow, groupSize: number): string {
  const s = slotOf(a.ratio);
  if (groupSize === 1) return "All placements";
  if (s === "vertical") return "Stories and Reels";
  if (s === "feed") return "Feed and everything else";
  return "Unknown";
}

/** Build the preview from what is saved. `linkResults` adds landing-page warnings. */
export function buildPreview(batchId: number, dest: DestinationInfo, capPoints: number, opts: { linkResults?: Map<string, string | null>; persist?: boolean; namePrefix?: string } = {}): Preview {
  const batch = getBatch(batchId)!;
  const isDraft = batch.status === "draft";
  if (isDraft) computeNames(batchId);
  const batchChecks = isDraft ? checkBatch(batch, dest) : [];
  const planAds: PlanAd[] = [];
  const ads: PreviewAd[] = getAds(batchId).map((ad) => {
    const assets = getAdAssets(ad.id);
    const copy = adCopy(batch, ad);
    let checks = isDraft ? checkAd(batch, ad, assets) : adChecks(ad);
    const linkProblem = opts.linkResults?.get(copy.linkUrl);
    if (isDraft && linkProblem) checks = [...checks, { level: "warning", code: "link_down", message: `Landing page ${linkProblem}: ${copy.linkUrl}` }];
    if (isDraft && opts.persist) updateAd(ad.id, { checks: JSON.stringify(checks) });
    planAds.push({
      done: ad.status === "done",
      newAdset: batch.adset_mode === "new_per_ad" && !ad.meta_adset_id,
      assets: assets.map((a) => ({ kind: a.kind as "image" | "video", sizeBytes: a.size_bytes, alreadyUploaded: !!(a.sha256 && getMedia(batch.ad_account_id, a.sha256)?.status === "ready") })),
    });
    const ctx = adNameContext(batch, ad, assets);
    return {
      id: ad.id,
      position: ad.position,
      key: ad.key,
      creativeName: ad.creative_name,
      name: ad.name ?? "",
      metaName: metaName(ad.name ?? ad.creative_name, ad.key, opts.namePrefix),
      adsetName: ad.adset_name ?? "",
      angle: ad.angle ?? "",
      files: assets.map((a) => ({
        id: a.id,
        filename: a.filename,
        kind: a.kind,
        ratio: a.ratio,
        size: humanSize(a.size_bytes),
        dims: ratioText(a.width, a.height),
        durationSec: a.duration_sec,
        placement: placementLabel(a, assets.length),
      })),
      copy,
      hasOverride: !!ad.copy_override && ad.copy_override !== "{}",
      override: ad.copy_override ? (JSON.parse(ad.copy_override) as Partial<ReturnType<typeof adCopy>>) : {},
      urlTags: renderUtm(copy.utmTemplate, ctx),
      checks,
      status: ad.status,
      step: ad.step,
      error: ad.error,
      metaAdId: ad.meta_ad_id,
      metaAdsetId: ad.meta_adset_id,
      effectiveStatus: ad.effective_status,
      reviewIssues: ad.review_issues ? (JSON.parse(ad.review_issues) as string[]) : [],
      featureWarnings: JSON.parse(ad.feature_warnings) as string[],
    };
  });
  const est = estimate(planAds, capPoints);
  if (opts.persist && isDraft) updateBatch(batchId, { estimate_seconds: est.seconds, previewed_at: new Date().toISOString() });
  const all = [...batchChecks, ...ads.flatMap((a) => a.checks)];
  return {
    batchChecks,
    ads,
    errors: all.filter((c) => c.level === "error").length,
    warnings: all.filter((c) => c.level === "warning").length,
    estimate: est,
  };
}
