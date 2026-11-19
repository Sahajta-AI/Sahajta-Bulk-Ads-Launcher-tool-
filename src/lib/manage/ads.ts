import type { MetaClient } from "../meta/client";
import type { Clock } from "../meta/pacer";
import { uploadImage, uploadVideo, videoStatus, videoThumbnail } from "../meta/upload";
import { sha256File } from "../engine/media";
import { CTA_TYPES } from "./cta";

// Existing ads: read them, and change their name, status, texts, link, button or file.
// Changing anything but the name or status means a new creative (Meta can't edit a creative),
// which is then put on the same ad. Ads that run an existing post can't change their text.

export interface AdEditSpec {
  name?: string;
  status?: "PAUSED" | "ACTIVE";
  primary_texts?: string[];
  headlines?: string[];
  description?: string;
  link_url?: string;
  cta?: string;
  display_link?: string;
  /** UTM tags on the link, e.g. "utm_source=facebook&utm_content={{ad.name}}". */
  url_tags?: string;
  /** A Google Drive file link: swap the ad's image or video for this file. */
  media_url?: string;
  /** Put this existing creative on the ad (used by "Undo this plan"). */
  creative_id?: string;
}

interface CreativeRow {
  id: string;
  name?: string;
  object_story_id?: string;
  effective_object_story_id?: string;
  effective_instagram_media_id?: string;
  source_instagram_media_id?: string;
  object_story_spec?: Record<string, unknown> & { link_data?: Record<string, unknown>; video_data?: Record<string, unknown> };
  asset_feed_spec?: Record<string, unknown> & { bodies?: { text: string; adlabels?: unknown }[]; titles?: { text: string; adlabels?: unknown }[]; descriptions?: { text: string }[]; link_urls?: Record<string, unknown>[]; call_to_action_types?: string[]; images?: unknown[]; videos?: unknown[] };
  url_tags?: string;
  degrees_of_freedom_spec?: Record<string, unknown>;
  contextual_multi_ads?: Record<string, unknown>;
}

export interface AdInfo {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  adsetId: string;
  creative: CreativeRow;
  /** The ad runs an existing post (its likes and comments): its text can't be changed. */
  fromPost: boolean;
  postId: string | null;
  instagramMediaId: string | null;
}

const CREATIVE_FIELDS = "id,name,object_story_id,effective_object_story_id,effective_instagram_media_id,source_instagram_media_id,object_story_spec,asset_feed_spec,url_tags,degrees_of_freedom_spec,contextual_multi_ads";

export async function readAd(client: MetaClient, id: string): Promise<AdInfo> {
  const r = await client.get<{ id: string; name: string; status: string; effective_status?: string; adset_id: string; creative?: CreativeRow }>(id, { fields: `id,name,status,effective_status,adset_id,creative{${CREATIVE_FIELDS}}` });
  const c = r.creative ?? { id: "" };
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    effectiveStatus: r.effective_status ?? r.status,
    adsetId: r.adset_id,
    creative: c,
    fromPost: !!(c.object_story_id || (c.source_instagram_media_id && !c.object_story_spec)),
    postId: c.effective_object_story_id ?? c.object_story_id ?? null,
    instagramMediaId: c.effective_instagram_media_id ?? c.source_instagram_media_id ?? null,
  };
}

/** Meta's review and delivery state of an ad (its effective_status), in plain words. */
const AD_STATE: Record<string, string> = {
  PENDING_REVIEW: "in review",
  IN_PROCESS: "in review (Meta is processing the change)",
  DISAPPROVED: "rejected by Meta",
  PREAPPROVED: "pre-approved",
  WITH_ISSUES: "has issues",
  PENDING_BILLING_INFO: "not delivering: payment details missing",
  ADSET_PAUSED: "not delivering: its ad set is off",
  CAMPAIGN_PAUSED: "not delivering: its campaign is off",
  ARCHIVED: "archived",
  DELETED: "deleted",
};

/**
 * An ad's on/off setting and Meta's review state, apart: Meta's effective_status alone ("IN_PROCESS")
 * doesn't say whether the ad is still paused. `onOff` is the ad's own setting ("on" or "paused");
 * `review` is what Meta says about it ("in review", "rejected by Meta", "approved"…).
 */
export function adState(status: string, effectiveStatus: string | undefined): { onOff: string; review: string } {
  const own = (status ?? "").toUpperCase();
  const eff = (effectiveStatus ?? own).toUpperCase();
  const onOff = own === "ACTIVE" ? "on" : own === "PAUSED" ? "paused" : own.toLowerCase().replace(/_/g, " ") || "unknown";
  const review = AD_STATE[eff] ?? (eff === "ACTIVE" ? "approved" : eff === "PAUSED" ? "no review pending" : eff.toLowerCase().replace(/_/g, " "));
  return { onOff, review };
}

export function describeAdEdit(e: AdEditSpec): string[] {
  const out: string[] = [];
  if (e.name) out.push(`name → "${e.name}"`);
  if (e.primary_texts) out.push(`primary text${e.primary_texts.length > 1 ? "s" : ""} → ${e.primary_texts.map((t) => `"${t.slice(0, 60)}${t.length > 60 ? "…" : ""}"`).join(", ")}`);
  if (e.headlines) out.push(`headline${e.headlines.length > 1 ? "s" : ""} → ${e.headlines.map((t) => `"${t}"`).join(", ")}`);
  if (e.description !== undefined) out.push(`description → "${e.description}"`);
  if (e.link_url) out.push(`link → ${e.link_url}`);
  if (e.display_link !== undefined) out.push(`display link → ${e.display_link || "none"}`);
  if (e.cta) out.push(`button → ${e.cta.replace(/_/g, " ").toLowerCase()}`);
  if (e.url_tags !== undefined) out.push(`UTM tags → ${e.url_tags || "none"}`);
  if (e.media_url) out.push(`file → ${e.media_url}`);
  if (e.creative_id) out.push(`creative → ${e.creative_id} (as it was)`);
  if (e.status) out.push(`status → ${e.status}`);
  return out;
}

export function adEditProblems(e: AdEditSpec): string[] {
  const out: string[] = [];
  if ((e.primary_texts?.length ?? 0) > 5 || (e.headlines?.length ?? 0) > 5) out.push("up to 5 primary texts and 5 headlines.");
  if (e.cta && !CTA_TYPES.includes(e.cta)) out.push(`unknown button ${e.cta}.`);
  if (e.link_url && !/^https?:\/\//i.test(e.link_url)) out.push(`the link must start with https://.`);
  return out;
}

/**
 * Meta keeps one primary text and one headline on an ad made without text options (no asset_feed_spec):
 * several can't be put on it, and silently keeping the first would not be what the summary promised.
 */
export function textOptionsProblem(adName: string, hasTextOptions: boolean, e: AdEditSpec): string | null {
  const texts = e.primary_texts?.length ?? 0;
  const heads = e.headlines?.length ?? 0;
  if ((texts <= 1 && heads <= 1) || hasTextOptions) return null;
  const what = [texts > 1 ? `${texts} primary texts` : "", heads > 1 ? `${heads} headlines` : ""].filter(Boolean).join(" and ");
  return `"${adName}" was made with one primary text and one headline (no text options), so Meta can't take ${what} on it. Give one of each, or make a new ad with several (a launch with several texts makes text options).`;
}

const textChange = (e: AdEditSpec) => e.primary_texts || e.headlines || e.description !== undefined || e.link_url || e.cta || e.display_link !== undefined || e.url_tags !== undefined || e.media_url;

/** Apply the text changes to a creative's spec (both the link-ad and the asset-feed forms). */
export function changedCreative(c: CreativeRow, e: AdEditSpec, media?: { imageHash?: string; videoId?: string; thumbnailUrl?: string }): Record<string, unknown> {
  const oss = structuredClone(c.object_story_spec ?? {}) as Record<string, unknown> & { link_data?: Record<string, unknown>; video_data?: Record<string, unknown> };
  const afs = c.asset_feed_spec ? (structuredClone(c.asset_feed_spec) as NonNullable<CreativeRow["asset_feed_spec"]>) : undefined;
  const cta = (old: Record<string, unknown> | undefined) => {
    const prev = (old ?? {}) as { type?: string; value?: Record<string, unknown> };
    return { type: e.cta ?? prev.type ?? "LEARN_MORE", value: { ...(prev.value ?? {}), ...(e.link_url ? { link: e.link_url } : {}) } };
  };
  if (oss.link_data) {
    const l = oss.link_data;
    const cards = Array.isArray(l.child_attachments) ? (l.child_attachments as Record<string, unknown>[]) : null;
    if (e.primary_texts?.length) l.message = e.primary_texts[0];
    if (cards) {
      // A carousel: the headline, description, link and button are on each card, as the launcher made
      // them (card N gets headline N, or the first one).
      l.child_attachments = cards.map((card, i) => ({
        ...card,
        ...(e.headlines?.length ? { name: e.headlines[i] ?? e.headlines[0] } : {}),
        ...(e.description !== undefined ? { description: e.description || undefined } : {}),
        ...(e.link_url ? { link: e.link_url } : {}),
        ...(e.cta || e.link_url ? { call_to_action: cta(card.call_to_action as Record<string, unknown>) } : {}),
      }));
    } else {
      if (e.headlines?.length) l.name = e.headlines[0];
      if (e.description !== undefined) l.description = e.description || undefined;
    }
    if (e.link_url) l.link = e.link_url;
    if (e.display_link !== undefined) l.caption = e.display_link || undefined;
    if (e.cta || e.link_url) l.call_to_action = cta(l.call_to_action as Record<string, unknown>);
    if (media?.imageHash) { l.image_hash = media.imageHash; delete l.picture; delete l.image_url; }
  }
  if (oss.video_data) {
    const v = oss.video_data;
    if (e.primary_texts?.length) v.message = e.primary_texts[0];
    if (e.headlines?.length) v.title = e.headlines[0];
    if (e.description !== undefined) v.link_description = e.description || undefined;
    if (e.cta || e.link_url || e.display_link !== undefined) {
      // A video ad's display link is on its button (link_caption), as the launcher made it.
      const c = cta(v.call_to_action as Record<string, unknown>);
      const value: Record<string, unknown> = { ...c.value };
      if (e.display_link !== undefined) {
        if (e.display_link && c.type !== "WHATSAPP_MESSAGE") value.link_caption = e.display_link;
        else delete value.link_caption;
      }
      v.call_to_action = { type: c.type, value };
    }
    if (media?.videoId) { v.video_id = media.videoId; v.image_url = media.thumbnailUrl; delete v.image_hash; }
  }
  if (afs) {
    const labelsOf = (list?: { adlabels?: unknown }[]) => list?.[0]?.adlabels;
    if (e.primary_texts?.length) { const l = labelsOf(afs.bodies); afs.bodies = e.primary_texts.map((text) => ({ text, ...(l ? { adlabels: l } : {}) })); }
    if (e.headlines?.length) { const l = labelsOf(afs.titles); afs.titles = e.headlines.map((text) => ({ text, ...(l ? { adlabels: l } : {}) })); }
    if (e.description !== undefined) afs.descriptions = e.description ? [{ text: e.description }] : undefined;
    if (afs.link_urls && (e.link_url || e.display_link !== undefined)) afs.link_urls = afs.link_urls.map((u) => ({ ...u, ...(e.link_url ? { website_url: e.link_url } : {}), ...(e.display_link !== undefined ? { display_url: e.display_link || undefined } : {}) }));
    if (e.cta && afs.call_to_action_types) afs.call_to_action_types = [e.cta];
  }
  // Read-only fields Meta returns but refuses on create.
  for (const k of ["image_url"]) if (oss.link_data && oss.link_data[k] && oss.link_data.image_hash) delete oss.link_data[k];
  const body: Record<string, unknown> = {
    object_story_spec: oss,
    ...(afs ? { asset_feed_spec: afs } : {}),
    url_tags: e.url_tags !== undefined ? e.url_tags || undefined : c.url_tags,
    ...(c.degrees_of_freedom_spec ? { degrees_of_freedom_spec: c.degrees_of_freedom_spec } : {}),
    ...(c.contextual_multi_ads ? { contextual_multi_ads: c.contextual_multi_ads } : {}),
  };
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

export interface EditOpts {
  key: string;
  mark: string;
  currency: string;
  accountDbId?: number;
  clock?: Clock;
  driveFile?: (link: string) => Promise<{ path: string; name: string; kind: "image" | "video" }>;
  remember: (values: Record<string, unknown>) => void;
}

/** Change one ad. Returns a sentence for the plan's progress. */
export async function editAd(client: MetaClient, id: string, e: AdEditSpec, o: EditOpts): Promise<string> {
  const ad = await readAd(client, id);
  // Only what this edit changes is remembered, so "Undo this plan" puts back only that.
  const before: Record<string, unknown> = {};
  if (e.name) before.name = ad.name;
  if (e.status) before.status = ad.status;
  if (textChange(e) || e.creative_id) before.creative_id = ad.creative.id;
  o.remember(before);
  const patch: Record<string, unknown> = {};
  if (e.name) patch.name = e.name;
  if (textChange(e)) {
    if (ad.fromPost) throw new Error(`"${ad.name}" runs an existing post, so its text, link and file can't change. Change the post itself, or make a new ad.`);
    const several = textOptionsProblem(ad.name, !!ad.creative.asset_feed_spec, e);
    if (several) throw new Error(several);
    let media: { imageHash?: string; videoId?: string; thumbnailUrl?: string } | undefined;
    if (e.media_url) {
      if (!o.driveFile) throw new Error("Swapping the file needs the plan author's Google login (sign in to the launcher again).");
      if (ad.creative.asset_feed_spec?.images && (ad.creative.asset_feed_spec.images as unknown[]).length > 1) throw new Error("This ad has a 9:16 and a 4:5 file; swapping is possible for ads with one file. Make a new ad with both files instead.");
      if (ad.creative.asset_feed_spec?.videos && (ad.creative.asset_feed_spec.videos as unknown[]).length > 1) throw new Error("This ad has a 9:16 and a 4:5 video; swapping is possible for ads with one file. Make a new ad with both files instead.");
      const f = await o.driveFile(e.media_url);
      const isVideoAd = !!ad.creative.object_story_spec?.video_data || !!ad.creative.asset_feed_spec?.videos;
      if ((f.kind === "video") !== isVideoAd) throw new Error(`The ad is ${isVideoAd ? "a video" : "an image"} ad, so swap it for ${isVideoAd ? "a video" : "an image"} (got ${f.name}).`);
      if (f.kind === "image") media = { imageHash: await uploadImage(client, f.path, f.name) };
      else {
        if (!o.accountDbId) throw new Error("Video swap needs the ad account.");
        const videoId = await uploadVideo(client, { accountDbId: o.accountDbId, sha: await sha256File(f.path), file: f.path, title: f.name });
        for (let t = 0; t < 80; t++) {
          const s = await videoStatus(client, videoId);
          if (s.status === "ready") break;
          if (s.status === "error") throw new Error(`Meta could not process ${f.name}.`);
          await (o.clock?.sleep(15_000) ?? new Promise((r) => setTimeout(r, 15_000)));
        }
        media = { videoId, thumbnailUrl: (await videoThumbnail(client, videoId)) ?? undefined };
      }
    }
    const body = changedCreative(ad.creative, e, media);
    const name = `${(ad.creative.name ?? ad.name).replace(/\s*\[P:[^\]]+\]$/, "")} ${o.mark}`.slice(0, 200);
    const created = await client.post<{ id: string }>(`${client.accountId}/adcreatives`, { ...body, name }, { idempotencyKey: o.key });
    patch.creative = { creative_id: created.id };
  }
  if (e.creative_id && !patch.creative) patch.creative = { creative_id: e.creative_id };
  if (e.status) patch.status = e.status;
  if (Object.keys(patch).length) await client.post(id, patch);
  return `Updated ad "${e.name ?? ad.name}"${patch.creative ? " with a new creative (Meta reviews it again)" : ""}.`;
}
