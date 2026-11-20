import type { Copy, Preset } from "../types";
import type { Slot } from "../engine/grouping";
import { creativeFeaturesSpec } from "./features";

// Builds the POST /act_x/adcreatives body for one ad.
// Call shapes and the reasons behind them: docs/SPEC.md "Meta call sequence" and
// docs/META-API-NOTES.md sections 5-8.

export interface CreativeAsset {
  kind: "image" | "video";
  slot: Slot | null;
  imageHash?: string;
  videoId?: string;
  thumbnailUrl?: string;
  thumbnailHash?: string;
}

export interface CreativeInput {
  name: string;
  /** "carousel": one card per file. */
  format?: "single" | "carousel";
  copy: Copy;
  urlTags: string;
  preset: Preset;
  assets: CreativeAsset[];
}

// Placements served by the 9:16 file. Everything else falls to the catch-all feed rule.
// Messenger Stories and Instagram Explore Feed were removed in v26 and must not be named.
export const VERTICAL_SPEC = {
  publisher_platforms: ["facebook", "instagram"],
  facebook_positions: ["story", "facebook_reels"],
  instagram_positions: ["story", "reels"],
};

/** The feed rule matches every other placement. Empty spec = catch-all (Meta's Threads PAC example). */
export const FEED_SPEC = {};

export type CreativeShape = "story_spec" | "feed_spec_texts" | "feed_spec_placement";

/** Which request shape an ad needs. */
export function creativeShape(input: Pick<CreativeInput, "assets" | "copy">): CreativeShape {
  if (input.assets.length > 1) return "feed_spec_placement";
  if (input.copy.primaryTexts.length > 1 || input.copy.headlines.length > 1 || input.copy.descriptions.length > 1) return "feed_spec_texts";
  return "story_spec";
}

function identity(preset: Preset) {
  const id: Record<string, string> = { page_id: preset.pageId };
  if (preset.igUserId) id.instagram_user_id = preset.igUserId;
  if (preset.threadsUserId) id.threads_user_id = preset.threadsUserId;
  return id;
}

function commonFields(input: CreativeInput) {
  return {
    name: input.name,
    ...(input.preset.sponsorPageId ? { branded_content_sponsor_page_id: input.preset.sponsorPageId } : {}),
    url_tags: input.urlTags || undefined,
    degrees_of_freedom_spec: { creative_features_spec: creativeFeaturesSpec(input.preset.enhancements) },
    contextual_multi_ads: { enroll_status: input.preset.multiAdvertiser ? "OPT_IN" : "OPT_OUT" },
  };
}

/**
 * Fallback switch for the first live test: if Meta rejects several texts in a placement-customized
 * ad, META_PAC_TEXTS=first sends only the first primary text and headline in those ads
 * (fallback 2 in docs/META-API-NOTES.md 5.2). Ads with one file keep all their texts.
 */
export function pacTextsLimited(): boolean {
  return process.env.META_PAC_TEXTS === "first";
}

/** The call to action: a website link, or a WhatsApp chat (click-to-WhatsApp ads). */
function callToAction(copy: Copy, preset: Preset) {
  if (copy.cta === "WHATSAPP_MESSAGE") {
    return { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP", ...(preset.whatsappNumber ? { whatsapp_number: preset.whatsappNumber } : {}), ...(copy.linkUrl ? { link: copy.linkUrl } : {}) } };
  }
  return { type: copy.cta, value: { link: copy.linkUrl, ...(copy.leadFormId ? { lead_gen_form_id: copy.leadFormId } : {}) } };
}

/** One file, one text: a normal link ad (image) or video ad. */
function storySpec(input: CreativeInput, copy: Copy): Record<string, unknown> {
  const cta = callToAction(copy, input.preset);
  const a = input.assets[0];
  if (a.kind === "image") {
    return {
      ...identity(input.preset),
      link_data: {
        image_hash: a.imageHash,
        link: copy.linkUrl,
        message: copy.primaryTexts[0] ?? "",
        name: copy.headlines[0] || undefined,
        description: copy.descriptions[0] || undefined,
        caption: copy.displayLink || undefined,
        call_to_action: cta,
      },
    };
  }
  return {
    ...identity(input.preset),
    video_data: {
      video_id: a.videoId,
      image_url: a.thumbnailHash ? undefined : a.thumbnailUrl,
      image_hash: a.thumbnailHash,
      message: copy.primaryTexts[0] ?? "",
      title: copy.headlines[0] || undefined,
      link_description: copy.descriptions[0] || undefined,
      call_to_action: copy.displayLink && cta.type !== "WHATSAPP_MESSAGE" ? { ...cta, value: { ...cta.value, link_caption: copy.displayLink } } : cta,
    },
  };
}

/** Carousel: each file is a card; card N gets headline N and description N (or the first one). Checked with Meta's validate_only, 18 Nov 2026. */
function carousel(input: CreativeInput, copy: Copy): Record<string, unknown> {
  const cta = callToAction(copy, input.preset);
  return {
    ...commonFields(input),
    object_story_spec: {
      ...identity(input.preset),
      link_data: {
        link: copy.linkUrl,
        message: copy.primaryTexts[0] ?? "",
        caption: copy.displayLink || undefined,
        multi_share_optimized: false,
        multi_share_end_card: false,
        call_to_action: cta,
        child_attachments: input.assets.map((a, i) => ({
          link: copy.linkUrl,
          name: copy.headlines[i] ?? copy.headlines[0] ?? undefined,
          description: copy.descriptions[i] ?? copy.descriptions[0] ?? undefined,
          ...(a.kind === "image" ? { image_hash: a.imageHash } : { video_id: a.videoId, picture: a.thumbnailUrl, image_hash: a.thumbnailHash }),
          call_to_action: cta,
        })),
      },
    },
  };
}

export function buildCreative(input: CreativeInput): Record<string, unknown> {
  if (input.format === "carousel" && input.assets.length >= 2) return carousel(input, input.copy);
  const shape = creativeShape(input);
  let { copy } = input;
  if (shape === "feed_spec_placement" && pacTextsLimited()) {
    copy = { ...copy, primaryTexts: copy.primaryTexts.slice(0, 1), headlines: copy.headlines.slice(0, 1), descriptions: copy.descriptions.slice(0, 1) };
  }

  if (shape === "story_spec") return { ...commonFields(input), object_story_spec: storySpec(input, copy) };

  if (shape === "feed_spec_texts") {
    // One file with several texts (Meta's "multiple text options"): a normal link or video ad
    // carrying the first text, plus every text in asset_feed_spec. Meta refuses the pure
    // asset_feed_spec form for this ("The link field is required", 100/2061015, batch zrhtj).
    // Checked with Meta's validate_only on 18 Nov 2026.
    return {
      ...commonFields(input),
      object_story_spec: storySpec(input, copy),
      asset_feed_spec: {
        bodies: copy.primaryTexts.map((text) => ({ text })),
        titles: copy.headlines.length ? copy.headlines.map((text) => ({ text })) : undefined,
        descriptions: copy.descriptions.length ? copy.descriptions.map((text) => ({ text })) : undefined,
        optimization_type: "DEGREES_OF_FREEDOM",
      },
    };
  }

  // asset_feed_spec: one file per placement group, and every text in every placement.
  // Placement customization + several texts (Meta's "PAC + Multi-Text" pattern): each rule binds a
  // file label, a body label and a title label, and every body and title carries the labels of
  // all rules, so every placement rotates all the texts. See docs/META-API-NOTES.md 5.2.
  const isVideo = input.assets[0].kind === "video";
  const slots = input.assets.map((a) => a.slot ?? "feed");
  const ruleSlots = (["vertical", "feed"] as const).filter((x) => slots.includes(x));
  const textLabels = (prefix: string) => ruleSlots.map((r) => ({ name: `${prefix}_${r}` }));
  const fileLabel = (a: CreativeAsset) => [{ name: `f_${a.slot ?? "feed"}` }];
  const cta = callToAction(copy, input.preset);

  const feed: Record<string, unknown> = {
    ad_formats: [isVideo ? "SINGLE_VIDEO" : "SINGLE_IMAGE"],
    bodies: copy.primaryTexts.map((text) => ({ text, adlabels: textLabels("b") })),
    titles: copy.headlines.map((text) => ({ text, adlabels: textLabels("t") })),
    // One description only: Meta refuses several in an ad with placement rules, labelled or not
    // ("Multiple descriptions assets cannot be applied to rule no. 1", 100/1885878; validate_only on
    // 1A, 20 Nov 2026). The preview warns when an ad's other descriptions are left out (pair_one_description).
    descriptions: copy.descriptions.length ? [{ text: copy.descriptions[0] }] : undefined,
    link_urls: [{ website_url: copy.linkUrl, display_url: copy.displayLink || undefined }],
    call_to_action_types: [cta.type],
  };
  if (cta.type === "WHATSAPP_MESSAGE" || copy.leadFormId) feed.call_to_actions = [cta];
  if (isVideo) {
    feed.videos = input.assets.map((a) => ({
      video_id: a.videoId,
      thumbnail_url: a.thumbnailHash ? undefined : a.thumbnailUrl,
      thumbnail_hash: a.thumbnailHash,
      adlabels: fileLabel(a),
    }));
  } else {
    feed.images = input.assets.map((a) => ({ hash: a.imageHash, adlabels: fileLabel(a) }));
  }
  feed.optimization_type = "PLACEMENT";
  const fileKey = isVideo ? "video_label" : "image_label";
  feed.asset_customization_rules = ruleSlots.map((r, i) => ({
    customization_spec: r === "vertical" ? VERTICAL_SPEC : FEED_SPEC,
    [fileKey]: { name: `f_${r}` },
    ...(copy.primaryTexts.length ? { body_label: { name: `b_${r}` } } : {}),
    ...(copy.headlines.length ? { title_label: { name: `t_${r}` } } : {}),
    priority: i + 1,
  }));
  return { ...commonFields(input), object_story_spec: identity(input.preset), asset_feed_spec: feed };
}

/** Remove undefined values so the request body only carries what we mean to send. */
export function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
