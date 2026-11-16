// Advantage+ creative enhancements (degrees_of_freedom_spec.creative_features_spec).
// We send OPT_OUT for every documented key unless the preset switches it on.
// `standard_enhancements` is deprecated (v22.0) and is never sent.
// Only documented keys are sent: an unknown or gated key may make Meta reject the creative.
// After each creative is created we read it back; any feature that is switched on and that
// the preset did not ask for becomes a warning, so the marketer learns about new Meta features.
// Source: docs/META-API-NOTES.md section 6 (Meta "get started" table, 3 Nov 2026).

export interface Feature {
  key: string;
  label: string; // plain words for the Settings page
}

export const FEATURES: Feature[] = [
  { key: "adapt_to_placement", label: "Adapt the creative to each placement (Meta's default: on)" },
  { key: "add_text_overlay", label: "Put text on top of the image or video" },
  { key: "creative_stickers", label: "Add stickers" },
  { key: "description_automation", label: "Show the description in more places (Meta's default: on)" },
  { key: "enhance_cta", label: "Add or change the call-to-action phrase" },
  { key: "image_animation", label: "Animate still images" },
  { key: "image_background_gen", label: "Generate new image backgrounds" },
  { key: "image_brightness_and_contrast", label: "Adjust image brightness and contrast" },
  { key: "image_templates", label: "Add a template frame around images" },
  { key: "image_text_translation", label: "Translate text inside images" },
  { key: "image_touchups", label: "Touch up images (crop and fix)" },
  { key: "image_uncrop", label: "Expand images to fit more placements" },
  { key: "inline_comment", label: "Show a top comment under the ad (Meta's default: on)" },
  { key: "media_type_automation", label: "Turn images into short videos" },
  { key: "pac_relaxation", label: "Relax your per-placement file choice" },
  { key: "product_extensions", label: "Show products from your catalogue" },
  { key: "reveal_details_over_time", label: "Reveal details over time" },
  { key: "text_optimizations", label: "Swap and rewrite your text" },
  { key: "text_translation", label: "Translate your text" },
  { key: "translate_voiceover", label: "Translate the voice-over" },
  { key: "video_auto_crop", label: "Auto-crop videos" },
  { key: "video_filtering", label: "Add visual filters to videos" },
  { key: "video_uncrop", label: "Expand videos to fit more placements" },
  { key: "text_generation", label: "Write new text variations with AI" },
];

/**
 * Every key in Meta's SDK (v26 codegen, 84 keys). Not sent, because many are gated or for
 * catalogue and WhatsApp ads; known here only so read-back warnings can name them.
 */
export const SDK_FEATURE_KEYS = new Set(
  "adapt_to_placement add_text_overlay ads_with_benefits advantage_plus_creative app_highlights audio auto_promotion_tag biz_ai carousel_to_video catalog_feed_tag creative_stickers customize_product_recommendation cv_transformation description_automation dha_optimization dynamic_cta_text dynamic_partner_content enable_ncs_testimonials enhance_cta fb_feed_tag fb_reels_tag fb_story_tag feed_caption_optimization generate_cta hide_price hyperlink_formatting ig_feed_tag ig_glados_feed ig_reels_tag ig_stream_tag ig_video_native_subtitle image_animation image_auto_crop image_background_gen image_banner image_brightness_and_contrast image_end_card image_enhancement image_templates image_text_translation image_touchups image_uncrop inline_comment local_store_extension media_liquidity_animated_image media_order media_type_automation multi_creative_post_carousel multi_photo_to_video music_generation pac_genai_recomposition pac_recomposition pac_relaxation product_browsing product_extensions product_metadata_automation product_tags profile_card profile_extension replace_media_text reveal_details_over_time show_destination_blurbs show_summary site_extensions standard_enhancements standard_enhancements_catalog text_extraction_for_headline text_extraction_for_tap_target text_formatting_optimization text_generation text_optimizations text_overlay_translation text_translation translate_voiceover video_auto_crop video_filtering video_highlight video_highlights video_to_image video_uncrop video_uncrop_9x16_to_9x18 video_voiceover wa_mm_image_filtering wa_mm_text_truncation_length".split(" "),
);

export const FEATURE_KEYS = new Set(FEATURES.map((f) => f.key));

/** Keys that must never be sent. */
export const NEVER_SEND = new Set(["standard_enhancements"]);

export function creativeFeaturesSpec(optIn: Record<string, "OPT_IN">): Record<string, { enroll_status: "OPT_IN" | "OPT_OUT" }> {
  const spec: Record<string, { enroll_status: "OPT_IN" | "OPT_OUT" }> = {};
  for (const f of FEATURES) spec[f.key] = { enroll_status: optIn[f.key] === "OPT_IN" ? "OPT_IN" : "OPT_OUT" };
  return spec;
}

/**
 * Compare what Meta stored with what we asked for. Returns plain-language warnings for:
 *  - features we asked to switch off that Meta switched on anyway
 *  - features we do not know that are switched on
 */
export function featureWarnings(stored: Record<string, { enroll_status?: string }> | undefined, optIn: Record<string, "OPT_IN">): string[] {
  const out: string[] = [];
  for (const [key, v] of Object.entries(stored ?? {})) {
    if (v?.enroll_status !== "OPT_IN") continue;
    if (optIn[key] === "OPT_IN") continue;
    if (NEVER_SEND.has(key)) continue; // old bundle; its parts are checked one by one
    if (FEATURE_KEYS.has(key)) out.push(`Meta switched on "${FEATURES.find((f) => f.key === key)!.label}" even though we asked for it off. Check the ad in Ads Manager.`);
    else if (SDK_FEATURE_KEYS.has(key)) out.push(`Meta switched on the AI enhancement "${key}" for this ad. This tool can't switch that one off yet. Check it in Ads Manager.`);
    else out.push(`Meta has a new AI enhancement "${key}" switched on for this ad. This tool doesn't know it yet. Check it in Ads Manager and tell your admin so it can be added to the off-list.`);
  }
  return out;
}
