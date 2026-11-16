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
  if (input.copy.primaryTexts.length > 1 || input.copy.headlines.length > 1) return "feed_spec_texts";
  return "story_spec";
}

function identity(preset: Preset) {
  const id: Record<string, string> = { page_id: preset.pageId };
  if (preset.igUserId) id.instagram_user_id = preset.igUserId;
  return id;
}

function commonFields(input: CreativeInput) {
  return {
    name: input.name,
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

export function buildCreative(input: CreativeInput): Record<string, unknown> {
  const shape = creativeShape(input);
  let { copy } = input;
  if (shape === "feed_spec_placement" && pacTextsLimited()) {
    copy = { ...copy, primaryTexts: copy.primaryTexts.slice(0, 1), headlines: copy.headlines.slice(0, 1) };
  }
  const cta = { type: copy.cta, value: { link: copy.linkUrl } };

  if (shape === "story_spec") {
    const a = input.assets[0];
    if (a.kind === "image") {
      return {
        ...commonFields(input),
        object_story_spec: {
          ...identity(input.preset),
          link_data: {
            image_hash: a.imageHash,
            link: copy.linkUrl,
            message: copy.primaryTexts[0] ?? "",
            name: copy.headlines[0] || undefined,
            description: copy.description || undefined,
            call_to_action: cta,
          },
        },
      };
    }
    return {
      ...commonFields(input),
      object_story_spec: {
        ...identity(input.preset),
        video_data: {
          video_id: a.videoId,
          image_url: a.thumbnailHash ? undefined : a.thumbnailUrl,
          image_hash: a.thumbnailHash,
          message: copy.primaryTexts[0] ?? "",
          title: copy.headlines[0] || undefined,
          link_description: copy.description || undefined,
          call_to_action: cta,
        },
      },
    };
  }

  // asset_feed_spec: several texts and/or one file per placement group.
  // Placement customization + several texts (Meta's "PAC + Multi-Text" pattern): each rule binds a
  // file label, a body label and a title label, and every body and title carries the labels of
  // all rules, so every placement rotates all the texts. See docs/META-API-NOTES.md 5.2.
  const isVideo = input.assets[0].kind === "video";
  const pac = shape === "feed_spec_placement";
  const slots = input.assets.map((a) => a.slot ?? "feed");
  const ruleSlots = pac ? (["vertical", "feed"] as const).filter((x) => slots.includes(x)) : [];
  const textLabels = (prefix: string) => (pac ? ruleSlots.map((r) => ({ name: `${prefix}_${r}` })) : undefined);
  const fileLabel = (a: CreativeAsset) => (pac ? [{ name: `f_${a.slot ?? "feed"}` }] : undefined);

  const feed: Record<string, unknown> = {
    ad_formats: [isVideo ? "SINGLE_VIDEO" : "SINGLE_IMAGE"],
    bodies: copy.primaryTexts.map((text) => ({ text, adlabels: textLabels("b") })),
    titles: copy.headlines.map((text) => ({ text, adlabels: textLabels("t") })),
    descriptions: copy.description ? [{ text: copy.description }] : undefined,
    link_urls: [{ website_url: copy.linkUrl }],
    call_to_action_types: [copy.cta],
  };
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
  if (pac) {
    feed.optimization_type = "PLACEMENT";
    const fileKey = isVideo ? "video_label" : "image_label";
    feed.asset_customization_rules = ruleSlots.map((r, i) => ({
      customization_spec: r === "vertical" ? VERTICAL_SPEC : FEED_SPEC,
      [fileKey]: { name: `f_${r}` },
      ...(copy.primaryTexts.length ? { body_label: { name: `b_${r}` } } : {}),
      ...(copy.headlines.length ? { title_label: { name: `t_${r}` } } : {}),
      priority: i + 1,
    }));
  } else {
    feed.optimization_type = "DEGREES_OF_FREEDOM";
  }
  return { ...commonFields(input), object_story_spec: identity(input.preset), asset_feed_spec: feed };
}

/** Remove undefined values so the request body only carries what we mean to send. */
export function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
