import fs from "node:fs";
import { TEXT_LIMITS } from "../copy-limits";
import { db } from "../db";
import { GB, freeBytes, removeUnusedUploads } from "../cleanup";
import { CTA_TYPES } from "../manage/cta";
import { pacTextsLimited } from "../meta/creative";
import { getMedia } from "../meta/upload";
import { DEFAULT_CAP, WINDOW_MS, type PacerState } from "../meta/pacer";
import { adChecks, adCopy, adOverride, adPreset, batchPreset, getAdAssets, getAds, getAssets, getBatch, CREATIVE_LOOKUP_PAGES, lookupsNeeded, updateAd, updateBatch } from "../store";
import type { AdRow, AssetRow, BatchRow, Check } from "../types";
import { estimateWork, timeLeft, type Estimate, type LaunchWork, type RateLimits } from "./estimate";
import { formatLabel, groupFiles, slotOf } from "./grouping";
import { humanSize, ratioText } from "./media";
import { metaAdName, metaName, renderName, renderUtm, unknownTokens, type NameContext } from "./naming";

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
  ...TEXT_LIMITS,
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

/**
 * Drag-and-drop: move a file to another ad, or to a new ad of its own. The file keeps the copy and
 * angle of the ad it was in (batch zrhtj: moving IMG3 out and back lost its own copy), so an ad of
 * its own gets that copy back. An ad keeps its own copy while it still has files.
 */
export function moveAsset(batchId: number, assetId: number, toAdId: number | "new") {
  const batch = getBatch(batchId)!;
  if (batch.status !== "draft") throw new Error("This batch has already been launched; its grouping can't change.");
  const asset = db().prepare("SELECT * FROM assets WHERE id = ? AND batch_id = ?").get(assetId, batchId) as AssetRow | undefined;
  if (!asset) throw new Error("File not found in this batch.");
  db().transaction(() => {
    // Remember the copy of the ad the file leaves (if it had its own).
    const from = asset.ad_id ? (db().prepare("SELECT copy_override, angle FROM ads WHERE id = ?").get(asset.ad_id) as { copy_override: string | null; angle: string | null } | undefined) : undefined;
    if (from && (from.copy_override || from.angle)) db().prepare("UPDATE assets SET copy_override = ?, angle = ? WHERE id = ?").run(from.copy_override, from.angle, assetId);
    const memory = db().prepare("SELECT copy_override, angle FROM assets WHERE id = ?").get(assetId) as { copy_override: string | null; angle: string | null };
    let target: number;
    if (toAdId === "new") {
      target = newAd(batch, asset.filename.replace(/\.[^.]+$/, ""));
      if (memory.copy_override || memory.angle) db().prepare("UPDATE ads SET copy_override = ?, angle = ? WHERE id = ?").run(memory.copy_override, memory.angle, target);
    } else {
      const ad = db().prepare("SELECT id FROM ads WHERE id = ? AND batch_id = ?").get(toAdId, batchId);
      if (!ad) throw new Error("Ad not found in this batch.");
      target = toAdId; // the ad keeps its own copy; the file remembers its own for later
    }
    db().prepare("UPDATE assets SET ad_id = ? WHERE id = ?").run(target, assetId);
    renumber(batchId);
  }).immediate();
}

export function removeAsset(batchId: number, assetId: number) {
  const batch = getBatch(batchId)!;
  if (batch.status !== "draft") throw new Error("This batch has already been launched.");
  const file = db().prepare("SELECT local_path FROM assets WHERE id = ? AND batch_id = ?").pluck().get(assetId, batchId) as string | null | undefined;
  db().prepare("DELETE FROM assets WHERE id = ? AND batch_id = ?").run(assetId, batchId);
  renumber(batchId);
  // The uploaded file goes too, unless another batch (launched into another ad set) still uses it.
  removeUnusedUploads([file ?? null]);
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
    // An empty naming pattern (the box cleared) falls back to the creative name: never an ad called only "[L:key]".
    const adsetName =
      batch.adset_mode === "new_per_ad" ? renderName(batch.adset_name_template, ctx) || ad.creative_name
      : batch.adset_mode === "new_shared" ? renderName(batch.adset_name_template, { ...ctx, creative: "", format: "", angle: batch.angle, n: undefined }) || `${batch.adset_name ?? "New ad set"} (batch ${batch.key})`
      : batch.adset_name ?? "";
    const name = renderName(batch.ad_name_template, { ...ctx, adset: adsetName }) || ad.creative_name;
    updateAd(ad.id, { name, adset_name: adsetName });
  }
}

// ---------- Checks ----------

/** What the launcher knows about an ad set it puts ads into (from the cached ad-set list, no extra calls). */
export interface AdsetDest {
  id: string;
  name: string;
  is_dynamic_creative?: boolean;
  ad_count?: number;
  /** Meta's destination_type: ON_AD (Instant form), WEBSITE, WHATSAPP, MESSENGER… */
  destination_type?: string;
  optimization_goal?: string;
  campaignName?: string;
}

export interface DestinationInfo {
  adset?: AdsetDest | null;
  /** Set when Meta says the ad account may not use the preset's Instagram account (code 200/1815199). */
  igProblem?: string;
  /** The template ad set has a minimum spend that a campaign budget can refuse (batch u2942). */
  templateMinSpend?: string;
  /** Checks that couldn't run just now (Meta limiting calls, login expired…): shown as warnings, never a silent pass. */
  unchecked?: string[];
  /** The extra ad sets that get the same ads (launched as batches of their own). `missing`: not found in Meta. */
  extras?: (AdsetDest & { missing?: boolean })[];
}

/** An Instant form (lead form) ad set: Meta refuses ads without a lead form on the button. A leads goal
 *  with destination "On your ad" (ON_AD), or with no destination (older lead ad sets). Messenger, calls
 *  and WhatsApp lead ad sets have their own destination and are not Instant form ad sets. */
export const isInstantForm = (a?: AdsetDest | null) =>
  !!a && ["LEAD_GENERATION", "QUALITY_LEAD"].includes(a.optimization_goal ?? "") && (!a.destination_type || a.destination_type === "ON_AD" || a.destination_type === "UNDEFINED");
const isWhatsApp = (a?: AdsetDest | null) => !!a && a.destination_type === "WHATSAPP";
/** We know what the ad set does (the cached list has its destination or goal). */
const knownGoal = (a?: AdsetDest | null) => !!a && !!(a.destination_type || a.optimization_goal);

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
    // Uploaded files are removed from the server some time after a launch, or from a draft left for 14 days.
    if (a.source_kind !== "drive" && (!a.local_path || !fs.existsSync(a.local_path))) {
      out.push({ level: "error", code: "file_missing", message: `${a.filename} is no longer on the server (files are removed some time after a launch, or when a draft is left for 14 days). Remove it from this ad and upload it again.` });
    }
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

  const isCarousel = (() => {
    try {
      return (JSON.parse(ad.copy_override ?? "{}") as { format?: string }).format === "carousel";
    } catch {
      return false;
    }
  })();
  if (isCarousel) {
    // Carousel: each file is a card, in the order shown; images and videos may mix.
    if (assets.length < 2) out.push({ level: "error", code: "carousel_short", message: "A carousel needs at least 2 files. Drag more files into this ad, or switch it back to a single ad." });
    if (assets.length > 10) out.push({ level: "error", code: "carousel_long", message: `A carousel can have at most 10 cards; this ad has ${assets.length} files.` });
    if (assets.some((a) => a.ratio && a.ratio !== "1x1")) out.push({ level: "warning", code: "carousel_ratio", message: "Carousel cards show best as square (1:1) files; other shapes are cropped." });
    if (copy.headlines.length > 1 && copy.headlines.length < assets.length) out.push({ level: "warning", code: "carousel_headlines", message: `${assets.length} cards and ${copy.headlines.length} headlines: cards without their own headline use the first one.` });
    if (copy.primaryTexts.length > 1) out.push({ level: "warning", code: "carousel_texts", message: `A carousel uses only the first primary text; the other ${copy.primaryTexts.length - 1} are not sent to Meta.` });
  }

  // Placement grouping
  if (assets.length > 1 && !isCarousel) {
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
  if (assets.length > 1 && pacTextsLimited() && (copy.primaryTexts.length > 1 || copy.headlines.length > 1 || copy.descriptions.length > 1)) {
    out.push({ level: "warning", code: "pac_one_text", message: "Meta doesn't accept several texts in an ad with separate vertical and feed files. Only the first primary text, headline and description will be used for this ad." });
  }
  if (assets.length > 1 && !isCarousel && copy.descriptions.length > 1) {
    out.push({ level: "warning", code: "pair_one_description", message: `Meta takes one description in an ad with separate 9:16 and 4:5 files, so only the first is used: "${copy.descriptions[0]}". The other ${copy.descriptions.length - 1} are left out. An ad with one file (or a carousel) takes all of them.` });
  }
  if (!copy.primaryTexts.length) out.push({ level: "error", code: "no_text", message: "No primary text. Pick a copy template or add text to this ad." });
  if (!copy.headlines.length) out.push({ level: "warning", code: "no_headline", message: "No headline." });
  if (copy.primaryTexts.length > LIMITS.maxTexts) out.push({ level: "error", code: "too_many_texts", message: `${copy.primaryTexts.length} primary texts. Meta allows up to 5.` });
  if (copy.headlines.length > LIMITS.maxTexts) out.push({ level: "error", code: "too_many_texts", message: `${copy.headlines.length} headlines. Meta allows up to 5.` });
  if (copy.descriptions.length > LIMITS.maxTexts) out.push({ level: "error", code: "too_many_texts", message: `${copy.descriptions.length} descriptions. Meta allows up to 5.` });
  textChecks("Primary text", copy.primaryTexts, LIMITS.primaryTextSoft, LIMITS.primaryTextHard, out);
  textChecks("Headline", copy.headlines, LIMITS.headlineSoft, LIMITS.headlineHard, out);
  textChecks("Description", copy.descriptions, LIMITS.descriptionSoft, LIMITS.descriptionHard, out);
  if (!copy.linkUrl) out.push({ level: "error", code: "no_link", message: "No landing page URL." });
  else if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(copy.linkUrl)) out.push({ level: "error", code: "bad_link", message: `The landing page "${copy.linkUrl}" is not a full web address. It must start with https://` });
  if (copy.cta && !CTA_TYPES.includes(copy.cta)) {
    out.push({ level: "error", code: "cta_unsupported", message: `The button "${copy.cta}" can't be used by the launcher yet (Meta needs a phone number, address or Messenger setup for it). Pick another button in the copy.` });
  }
  const utmUnknown = unknownTokens(copy.utmTemplate);
  if (utmUnknown.length) out.push({ level: "warning", code: "utm_token", message: `UTM template has unknown words in braces: ${utmUnknown.join(", ")}. They will be sent as typed.` });

  return out;
}

/** "ads 1, 2 and 5" / "every ad". */
function whichAds(list: AdRow[], all: number): string {
  if (list.length === all) return "every ad";
  const n = list.map((a) => a.position);
  return `ad${n.length > 1 ? "s" : ""} ${n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}` : n[0]}`;
}

/**
 * Does the copy fit what each target ad set does? An Instant form ad set needs a lead form on every
 * ad, a WhatsApp ad set needs the "Send WhatsApp message" button. Meta refuses the ads otherwise,
 * after the files were already uploaded.
 */
function fitChecks(batch: BatchRow, ads: AdRow[], dest: DestinationInfo): Check[] {
  const out: Check[] = [];
  if (!ads.length) return out;
  const copies = ads.map((ad) => ({ ad, copy: adCopy(batch, ad) }));
  const main = dest.adset ?? null;
  const targets: { a: AdsetDest; label: string; extra: boolean }[] = [];
  if (main) targets.push({ a: main, label: batch.adset_mode === "existing" ? `"${main.name}"` : `The template ad set "${main.name}"`, extra: false });
  for (const x of dest.extras ?? []) if (!x.missing) targets.push({ a: x, label: `Extra ad set "${x.name}"`, extra: true });
  for (const t of targets) {
    if (!knownGoal(t.a)) continue;
    if (isInstantForm(t.a)) {
      const missing = copies.filter((c) => !c.copy.leadFormId).map((c) => c.ad);
      if (missing.length) {
        const who = missing.length === ads.length ? "the copy has none" : `${whichAds(missing, ads.length)} ${missing.length === 1 ? "has" : "have"} none`;
        out.push({ level: "error", code: "lead_form_needed", message: `${t.label} collects leads with an Instant form, so Meta refuses ads without a lead form, and ${who}. Add the lead form ID to the copy (copy template → Lead form), or pick an ad set that sends people to a website.` });
      }
    } else if (copies.some((c) => c.copy.leadFormId)) {
      const withForm = copies.filter((c) => c.copy.leadFormId).map((c) => c.ad);
      // The copy was made for an Instant form ad set and the same ads also go into one that isn't.
      const level = t.extra && isInstantForm(main) ? "error" : "warning";
      out.push({ level, code: "lead_form_unused", message: `${t.label} doesn't collect leads with an Instant form, but ${whichAds(withForm, ads.length)} open${withForm.length === 1 ? "s" : ""} a lead form. Meta may refuse ${withForm.length === 1 ? "it" : "them"}. Remove the lead form from the copy, or ${t.extra ? "untick this ad set" : "pick an Instant form ad set"}.` });
    }
    if (isWhatsApp(t.a)) {
      const wrong = copies.filter((c) => c.copy.cta !== "WHATSAPP_MESSAGE").map((c) => c.ad);
      if (wrong.length) {
        out.push({ level: "error", code: "whatsapp_button", message: `${t.label} sends people to WhatsApp, so Meta needs the "Send WhatsApp message" button, and ${whichAds(wrong, ads.length)} use${wrong.length === 1 ? "s" : ""} another button. Change the button in the copy, or pick another ad set.` });
      }
    }
  }
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
  if (!batch.adset_id) out.push({ level: "error", code: "no_adset", message: batch.adset_mode === "existing" ? "Pick an ad set." : "Pick the ad set to copy for the new ad set." });
  if (batch.adset_mode === "new_shared" && ads.length > MAX_ADS_PER_ADSET) {
    out.push({ level: "error", code: "adset_full", message: `Meta allows ${MAX_ADS_PER_ADSET} ads in one ad set and this batch has ${ads.length}. Use "a new ad set per ad", or split the files into smaller batches.` });
  }
  if (batch.adset_mode !== "existing" && dest.templateMinSpend) out.push({ level: "warning", code: "min_spend", message: dest.templateMinSpend });
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
  // Extra ad sets (the same ads, launched as batches of their own).
  for (const x of dest.extras ?? []) {
    const label = `Extra ad set "${x.name}"`;
    if (x.missing) {
      out.push({ level: "error", code: "adset_missing", message: `${label} no longer exists in Meta. Untick it, or pick another one.` });
      continue;
    }
    if (x.is_dynamic_creative) out.push({ level: "error", code: "dynamic_creative", message: `${label} has Dynamic creative switched on. Ads from this tool can't go there: Meta would mix their files and texts into one ad. Untick it, or switch Dynamic creative off in Ads Manager.` });
    if (batch.adset_mode === "existing" && ads.length && (x.ad_count ?? 0) + ads.length > MAX_ADS_PER_ADSET) {
      out.push({ level: "error", code: "adset_full", message: `Meta allows ${MAX_ADS_PER_ADSET} ads in one ad set. ${label} already has ${x.ad_count ?? 0}, and this batch adds ${ads.length}. Untick it, or split the files into smaller batches.` });
    }
  }
  out.push(...fitChecks(batch, ads, dest));
  for (const u of dest.unchecked ?? []) out.push({ level: "warning", code: "dest_unchecked", message: u });
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

/**
 * A landing page that didn't load, in plain words (also usable by other checks). `failure` is the HTTP
 * status, or the error fetch threw.
 */
export function linkProblemText(url: string, failure: number | unknown): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep the text */
  }
  if (typeof failure === "number") {
    if (failure === 403 || failure === 429 || failure === 503) return `The site ${host} refused the launcher's check of ${url} (HTTP ${failure}); open it in a browser to confirm it works.`;
    if (failure === 404 || failure === 410) return `Landing page ${url}: page not found (${failure}). People clicking the ad would see an error page.`;
    return `Landing page ${url}: the site answered with an error (${failure}). People clicking the ad would see an error page.`;
  }
  const e = failure as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? e?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /ENOTFOUND|EAI_AGAIN/.test(`${e?.message ?? ""} ${e?.cause?.message ?? ""}`)) {
    return `Landing page ${url}: couldn't open: the site doesn't exist (no web address ${host}). People clicking the ad would see an error page.`;
  }
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `Landing page ${url}: couldn't open: it did not answer within 10 seconds.`;
  return `Landing page ${url}: couldn't open${code ? ` (${code})` : ""}. Open it in a browser to check it works.`;
}

/** Landing pages opened at the same time, and the time all of them must be checked within. */
const LINKS_AT_ONCE = 5;
export const LINKS_WITHIN_MS = 15_000;

/**
 * Open each distinct landing page once, a few at a time, all within one time limit. The value is the
 * problem in plain words (null = opens fine). A page the check ran out of time for says so. Not
 * opening is a warning, not an error.
 */
export async function checkLinks(urls: string[], fetchImpl: typeof fetch = fetch, opts: { withinMs?: number } = {}): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const list = [...new Set(urls)].filter((u) => /^https?:\/\//i.test(u));
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), opts.withinMs ?? LINKS_WITHIN_MS);
  const outOfTime = (url: string) => `Landing page ${url} wasn't checked: the check ran out of time. Open it in a browser to check it works.`;
  /** Set once the answer is given: a page that answers later changes nothing. */
  let answered = false;
  const put = (url: string, v: string | null) => !answered && out.set(url, v);
  const one = async (url: string) => {
    if (stop.signal.aborted) return put(url, outOfTime(url));
    try {
      const res = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.any([AbortSignal.timeout(10_000), stop.signal]), headers: { "User-Agent": "Mozilla/5.0 (SahajtaAdsLauncher link check)" } });
      put(url, res.ok ? null : linkProblemText(url, res.status));
      await res.body?.cancel().catch(() => undefined);
    } catch (e) {
      put(url, stop.signal.aborted ? outOfTime(url) : linkProblemText(url, e));
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < list.length) await one(list[next++]);
  };
  // A fetch that ignores the abort can't hold the answer past the time limit.
  const late = new Promise<void>((r) => stop.signal.addEventListener("abort", () => r(), { once: true }));
  try {
    await Promise.race([Promise.all(Array.from({ length: Math.min(LINKS_AT_ONCE, list.length) }, worker)), late]);
  } finally {
    clearTimeout(timer);
  }
  for (const u of list) if (!out.has(u)) out.set(u, outOfTime(u));
  answered = true;
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
  /** Facebook post and Instagram media behind the created ad (to reuse it with "ads from a post"). */
  metaPostId: string | null;
  metaIgMediaId: string | null;
  /** Something this ad left in Meta although it failed (an empty paused ad set), in plain words. */
  leftover: string | null;
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

// ---------- Time estimate of a whole launch ----------

/** What Meta lets this ad account do now, from the pacer's saved numbers (no Meta call). */
export function accountLimits(accountDbId: number, now = Date.now()): RateLimits {
  const fixed = process.env.META_RATE_CAP_POINTS ? Number(process.env.META_RATE_CAP_POINTS) : undefined;
  const row = db().prepare("SELECT state FROM rate_state WHERE ad_account_id = ?").get(accountDbId) as { state: string } | undefined;
  let st: Partial<PacerState> = {};
  try {
    st = row ? (JSON.parse(row.state) as PacerState) : {};
  } catch {
    /* no numbers yet */
  }
  return {
    capPoints: fixed || st.capPoints || DEFAULT_CAP,
    tier: st.tier,
    usedPoints: (st.log ?? []).filter(([t]) => t > now - WINDOW_MS).reduce((s, [, p]) => s + p, 0),
    // Meta's reading of the last hour, as it is now: the calls it counted leave the hour as it goes by
    // (taken as spread over that hour), so a reading 45 minutes old counts a quarter of what it said.
    hourPct: st.lastBuc && st.lastBuc.at > now - 3_600_000 ? st.lastBuc.pct * (1 - (now - st.lastBuc.at) / 3_600_000) : undefined,
  };
}

const formatOf = (ad: AdRow) => {
  try {
    return (JSON.parse(ad.copy_override ?? "{}") as { format?: string }).format === "carousel" ? "carousel" : "single";
  } catch {
    return "single";
  }
};
const versionOf = (ad: AdRow) => ((JSON.parse(ad.attempts || "{}") as { copy_gen?: number }).copy_gen ?? 0) + 1;
/** A file's identity across the batches of one launch (a Drive file has no checksum until it is downloaded). */
const fileKey = (a: AssetRow) => (a.source_kind === "drive" ? `drive:${a.source_ref}` : (a.sha256 ?? `${a.source_kind}:${a.source_ref}`));

/**
 * The batches of this batch's launch: itself and the batches launched with it into other ad sets, plus,
 * while it is a draft, the extra ad sets it will launch into (as batches still to come, with its ads).
 */
function launchRuns(batch: BatchRow): { b: BatchRow; ads: AdRow[]; virtual: boolean }[] {
  const real = batch.group_key
    ? (db().prepare("SELECT * FROM batches WHERE group_key = ? AND ad_account_id = ? ORDER BY id").all(batch.group_key, batch.ad_account_id) as BatchRow[])
    : [batch];
  const runs = real.map((b) => ({ b, ads: getAds(b.id), virtual: false }));
  const taken = new Set(real.map((b) => b.adset_id));
  for (const b of real.filter((x) => x.status === "draft")) {
    let extras: { id?: string; name?: string; campaignId?: string; campaignName?: string }[] = [];
    try {
      extras = JSON.parse(b.extra_adsets || "[]");
    } catch {
      /* none */
    }
    for (const x of extras) {
      if (!x?.id || taken.has(x.id)) continue;
      taken.add(x.id);
      const vb: BatchRow = { ...b, key: `${b.key}+${x.id}`, adset_id: x.id, adset_name: x.name ?? null, campaign_id: x.campaignId ?? b.campaign_id, campaign_name: x.campaignName ?? b.campaign_name, shared_adset_id: null };
      runs.push({ b: vb, ads: getAds(b.id).map((a) => ({ ...a, status: "pending", meta_adset_id: null, meta_creative_id: null, meta_ad_id: null, attempts: "{}" })), virtual: true });
    }
  }
  return runs;
}

/**
 * The Meta work left in this batch's whole launch, as the launcher does it: each file uploaded once,
 * each distinct creative made once (the ads of the other ad sets reuse it), one ad per ad set, plus the
 * reads. Only batches that will run count (a draft, or one queued or launching).
 */
export function launchWork(batch: BatchRow): LaunchWork {
  const runs = launchRuns(batch);
  const assetsOf = new Map<number, AssetRow[]>();
  const assets = (ad: AdRow) => {
    if (!assetsOf.has(ad.id)) assetsOf.set(ad.id, getAdAssets(ad.id));
    return assetsOf.get(ad.id)!;
  };
  // What makes two creatives the same, known before the files are in Meta: files, copy, identity, link tags, format, version.
  const creativeKey = (b: BatchRow, ad: AdRow) => {
    const copy = adCopy(b, ad);
    const files = assets(ad);
    // An ad Meta refused with another ad set's creative makes its own.
    const own = (JSON.parse(ad.attempts || "{}") as { own_creative?: number }).own_creative ? ad.id : 0;
    return JSON.stringify([files.map(fileKey), copy, adPreset(b, ad), renderUtm(copy.utmTemplate, adNameContext(b, ad, files)), formatOf(ad), versionOf(ad), own]);
  };
  // A file is in Meta when any batch of the launch has its checksum and Meta has it ready.
  const inMeta = new Map<string, boolean>();
  for (const { b, ads } of runs) {
    for (const ad of ads) {
      for (const a of assets(ad)) {
        if (inMeta.get(fileKey(a))) continue;
        const m = a.sha256 ? getMedia(b.ad_account_id, a.sha256) : undefined;
        inMeta.set(fileKey(a), !!m && m.status === "ready" && !!(m.image_hash || m.video_id));
      }
    }
  }
  const made = new Set<string>();
  const needed = new Map<string, AdRow>();
  const w: LaunchWork = { ads: 0, adsets: 0, creatives: 0, uploads: [], newAdsets: 0, runReads: 0 };
  for (const { b, ads } of runs) {
    for (const ad of ads) if (ad.meta_creative_id) made.add(creativeKey(b, ad));
    if (!["draft", "queued", "running"].includes(b.status)) continue;
    // A run in progress leaves its failed ads for a Retry.
    const left = ads.filter((a) => a.status !== "done" && (b.status !== "running" || a.status !== "failed"));
    if (!left.length) continue;
    w.ads += left.length;
    w.adsets += b.adset_mode === "new_per_ad" ? left.length : 1;
    // The run's look-up of earlier work: its ads (and new ad sets) by name, one read each; creatives only
    // when an earlier run tried one or after a restore (Meta has no name filter for them: up to 10 pages).
    if (b.status !== "running") {
      const need = lookupsNeeded(b, left);
      // The ads are looked for in the ad sets known before the run (the existing one, the batch's new one,
      // or new ones made or tried by an earlier run): none yet, no read (as reconcile does).
      const tried = (a: AdRow) => (JSON.parse(a.attempts || "{}") as { adset?: number }).adset ?? 0;
      const adsetsKnown = b.adset_mode === "existing" ? !!b.adset_id : b.adset_mode === "new_shared" ? !!b.shared_adset_id : left.some((a) => a.meta_adset_id || tried(a) > 0);
      w.runReads += (need.ads && adsetsKnown ? 1 : 0) + (need.adsets ? 1 : 0) + (need.creatives ? CREATIVE_LOOKUP_PAGES : 0);
      // A batch queued before 21 Nov has no saved pixel: its run reads it once (a draft gets it at launch, free).
      if (b.status !== "draft" && b.adset_id && (b.tracking_pixel === null || b.tracking_pixel === undefined)) w.runReads += 1;
    }
    if (b.adset_mode === "new_per_ad") w.newAdsets += left.filter((a) => !a.meta_adset_id).length;
    else if (b.adset_mode === "new_shared" && !b.shared_adset_id) {
      w.newAdsets += 1;
      w.runReads += 1; // the look-up of the batch's new ad set by its key, before it is copied
    }
    for (const ad of left) if (!ad.meta_creative_id && !ad.meta_ad_id) needed.set(creativeKey(b, ad), ad);
  }
  const files = new Map<string, { kind: "image" | "video"; sizeBytes: number }>();
  for (const [key, ad] of needed) {
    if (made.has(key)) continue;
    w.creatives++;
    for (const a of assets(ad)) if (!inMeta.get(fileKey(a)) && (a.kind === "image" || a.kind === "video")) files.set(fileKey(a), { kind: a.kind, sizeBytes: a.size_bytes });
  }
  w.uploads = [...files.values()];
  w.turnOn = turnOnWork(runs);
  return w;
}

/**
 * Turning the ads on when every ad is in (go-live "now" or "at a time"): every ad of the launch, every
 * ad set they are in and the campaigns, one write each. 0 when the ads stay paused or are turned on already,
 * and for "at a time": that turn-on runs at the chosen time, not right after the ads are made, so it is
 * not part of the time the launch takes (the summary says when the ads are turned on).
 */
function turnOnWork(runs: { b: BatchRow; ads: AdRow[] }[]): number {
  const main = runs[0]?.b;
  if (!main || main.go_live === "paused" || main.go_live === "at" || runs.some((r) => r.b.go_live_done)) return 0;
  const live = runs.filter((r) => r.ads.length);
  const ads = live.reduce((n, r) => n + r.ads.length, 0);
  const adsets = live.reduce((n, r) => n + (r.b.adset_mode === "new_per_ad" ? r.ads.length : 1), 0);
  const campaigns = new Set(live.map((r) => r.b.campaign_id ?? r.b.key)).size;
  return ads + adsets + campaigns;
}

/**
 * Time left of this batch's launch (every ad set), while a batch of it is queued or launching: from how
 * fast its ads went in over the last minutes. null when nothing of it is running.
 */
export function launchTimeLeft(batch: BatchRow, limits: RateLimits, now = Date.now()): Estimate | null {
  const runs = launchRuns(batch).filter((r) => !r.virtual);
  if (!runs.some((r) => r.b.status === "queued" || r.b.status === "running")) return null;
  const ids = runs.map((r) => r.b.id);
  const done = db()
    .prepare(`SELECT done_at AS doneAt, work_points AS points FROM ads WHERE batch_id IN (${ids.map(() => "?").join(",")}) AND done_at IS NOT NULL AND done_at >= ?`)
    .all(...ids, now - 10 * 60_000) as { doneAt: number; points: number | null }[];
  return timeLeft(launchWork(batch), limits, done, now);
}

/** Build the preview from what is saved. `linkResults` adds landing-page warnings. `capPoints`: the ad
 *  account's limits (accountLimits), or only its points per 5 minutes. */
export function buildPreview(batchId: number, dest: DestinationInfo, capPoints: number | RateLimits, opts: { linkResults?: Map<string, string | null>; persist?: boolean; namePrefix?: string } = {}): Preview {
  const batch = getBatch(batchId)!;
  const isDraft = batch.status === "draft";
  if (isDraft) computeNames(batchId);
  const batchChecks = isDraft ? checkBatch(batch, dest) : [];
  const all0 = getAds(batchId);
  // "One new ad set for the batch": when no ad got into it, the empty paused ad set is reported once.
  const sharedLeft = batch.adset_mode === "new_shared" && batch.shared_adset_id && !all0.some((a) => a.meta_ad_id) ? all0.find((a) => a.status !== "done") : undefined;
  const ads: PreviewAd[] = all0.map((ad) => {
    const assets = getAdAssets(ad.id);
    const copy = adCopy(batch, ad);
    let checks = isDraft ? checkAd(batch, ad, assets) : adChecks(ad);
    const linkProblem = opts.linkResults?.get(copy.linkUrl);
    if (isDraft && linkProblem) checks = [...checks, { level: "warning", code: "link_down", message: linkProblem }];
    if (isDraft && opts.persist) updateAd(ad.id, { checks: JSON.stringify(checks) });
    const ctx = adNameContext(batch, ad, assets);
    return {
      id: ad.id,
      position: ad.position,
      key: ad.key,
      creativeName: ad.creative_name,
      name: ad.name ?? "",
      // The ad's name in Meta: no launch key (21 Nov 2026).
      metaName: metaAdName(ad.name || ad.creative_name, opts.namePrefix),
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
      override: adOverride(ad) as Partial<ReturnType<typeof adCopy>>,
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
      metaPostId: ad.meta_post_id ?? null,
      metaIgMediaId: ad.meta_ig_media_id ?? null,
      leftover:
        ad.status !== "done" && batch.adset_mode === "new_per_ad" && ad.meta_adset_id && !ad.meta_ad_id
          ? `An empty paused ad set (ID ${ad.meta_adset_id}, named with [L:${ad.key}]) is in Meta from this attempt. "Retry failed" puts the ad into it; nothing is made twice.`
          : sharedLeft?.id === ad.id
            ? `The batch's new ad set (ID ${batch.shared_adset_id}, named with [L:${batch.key}-00]) is in Meta, paused and empty, from this attempt. "Retry failed" puts the ads into it; nothing is made twice.`
            : null,
    };
  });
  // The whole launch: this batch and the batches launched with it into other ad sets.
  const est = estimateWork(launchWork(getBatch(batchId)!), typeof capPoints === "number" ? { capPoints } : capPoints);
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
