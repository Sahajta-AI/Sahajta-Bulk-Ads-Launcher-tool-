import { route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { clientFor } from "@/lib/meta/factory";
import { MetaError, RateLimitedError, plainError } from "@/lib/meta/errors";
import { getAccount } from "@/lib/store";
import { adState } from "@/lib/manage/ads";
import { db } from "@/lib/db";
import { plainNames } from "@/lib/manage/objects";

export const dynamic = "force-dynamic";

/** Most ads listed for one ad set (pages of 25 ads with their creatives; one Meta call per page). */
const MAX_ADS = 100;

const CREATIVE = "creative{object_story_id,effective_object_story_id,effective_instagram_media_id,source_instagram_media_id,object_story_spec,asset_feed_spec,url_tags}";
const STATUSES = ["ACTIVE", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "PENDING_REVIEW", "IN_PROCESS", "WITH_ISSUES", "PREAPPROVED", "DISAPPROVED", "PENDING_BILLING_INFO"];

type Cta = { type?: string; value?: { link?: string; link_caption?: string } };
type Card = { name?: string; description?: string; link?: string; image_hash?: string; video_id?: string; call_to_action?: Cta };
type Creative = {
  url_tags?: string;
  object_story_id?: string;
  effective_object_story_id?: string;
  effective_instagram_media_id?: string;
  source_instagram_media_id?: string;
  object_story_spec?: {
    link_data?: { message?: string; name?: string; description?: string; caption?: string; link?: string; image_hash?: string; call_to_action?: Cta; child_attachments?: Card[] };
    video_data?: { message?: string; title?: string; link_description?: string; video_id?: string; call_to_action?: Cta };
  };
  asset_feed_spec?: {
    bodies?: { text: string }[];
    titles?: { text: string }[];
    descriptions?: { text: string }[];
    link_urls?: { website_url?: string; display_url?: string }[];
    call_to_action_types?: string[];
    images?: { hash?: string }[];
    videos?: { video_id?: string }[];
  };
};
type AdRow = { id: string; name: string; status: string; effective_status?: string; tracking_specs?: Record<string, unknown>[]; creative?: Creative };

/** The website pixels and offline event sets an ad tracks (its tracking_specs). */
function trackingOf(specs: Record<string, unknown>[] = []) {
  const has = (t: Record<string, unknown>, type: string) => Array.isArray(t["action.type"]) && (t["action.type"] as string[]).includes(type);
  const uniq = (l: string[]) => [...new Set(l.map(String))];
  return {
    pixels: uniq(specs.filter((t) => has(t, "offsite_conversion") && Array.isArray(t.fb_pixel)).flatMap((t) => t.fb_pixel as string[])),
    offline: uniq(specs.filter((t) => has(t, "offline_conversion") && Array.isArray(t.dataset)).flatMap((t) => t.dataset as string[])),
  };
}

/** The ad's files: image hashes and video IDs, wherever the launcher (or Ads Manager) put them. */
function filesOf(c: Creative): { images: string[]; videos: string[] } {
  const ld = c.object_story_spec?.link_data;
  const vd = c.object_story_spec?.video_data;
  const afs = c.asset_feed_spec;
  const cards = ld?.child_attachments ?? [];
  const uniq = (l: (string | undefined)[]) => [...new Set(l.filter((x): x is string => !!x))];
  // Text options (asset_feed_spec) carry the files when there are several (9:16 + 4:5); else the
  // link ad, a carousel's cards or the video ad do.
  // A video card's image_hash is its thumbnail, not a file of the ad.
  const images = uniq([...(afs?.images?.map((i) => i.hash) ?? []), ...(afs?.images?.length ? [] : [ld?.image_hash, ...cards.map((x) => (x.video_id ? undefined : x.image_hash))])]);
  const videos = uniq([...(afs?.videos?.map((v) => v.video_id) ?? []), ...(afs?.videos?.length ? [] : [vd?.video_id, ...cards.map((x) => x.video_id)])]);
  return { images, videos };
}

/** The button type, e.g. SIGN_UP: from the text options, the link ad, a carousel's first card or the video ad. */
function buttonOf(c: Creative): string | null {
  const ld = c.object_story_spec?.link_data;
  return c.asset_feed_spec?.call_to_action_types?.[0] ?? ld?.call_to_action?.type ?? ld?.child_attachments?.find((x) => x.call_to_action?.type)?.call_to_action?.type ?? c.object_story_spec?.video_data?.call_to_action?.type ?? null;
}

/**
 * File names for image hashes and video IDs. First the launcher's own record (files it uploaded: no
 * Meta call); then, for images it doesn't know, a read of the ad account's image library (an image
 * keeps the file name it was uploaded with; 50 images a read). A video the launcher didn't upload shows its ID.
 * A failed read (e.g. Meta limiting calls) leaves those names out; the list itself still answers.
 */
async function fileNames(client: ReturnType<typeof clientFor>, accId: number, images: string[], videos: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const local = (col: "image_hash" | "video_id", ids: string[]) => {
    if (!ids.length) return;
    const rows = db()
      .prepare(`SELECT m.${col} AS id, a.filename FROM meta_media m JOIN assets a ON a.sha256 = m.sha256 WHERE m.ad_account_id = ? AND m.${col} IN (${ids.map(() => "?").join(",")}) ORDER BY a.id`)
      .all(accId, ...ids) as { id: string; filename: string }[];
    for (const r of rows) names.set(r.id, r.filename);
  };
  local("image_hash", images);
  local("video_id", videos);
  const unknown = images.filter((h) => !names.has(h));
  // 50 hashes a read (a short enough link), each answered in one page; at most 2 reads (100 images) per
  // list, so a list of big carousels made in Ads Manager can't use much of the hour. Usually 1 read, often none.
  for (let i = 0; i < Math.min(unknown.length, 100); i += 50) {
    const part = unknown.slice(i, i + 50);
    try {
      const r = await client.get<{ data?: { hash: string; name?: string }[] }>(`${client.accountId}/adimages`, { hashes: part, fields: "hash,name", limit: part.length });
      for (const x of r.data ?? []) if (x.name) names.set(x.hash, x.name);
    } catch {
      // Names are extra: the ads are listed without them.
      break;
    }
  }
  return names;
}

/**
 * ?adset=ID → its ads with their on/off setting and Meta's review state, texts, headlines,
 * descriptions, link, display link, button, files and the post behind each (up to 100). One list
 * read with the creatives inside (pages of 25), not one read per ad, plus at most one read of the
 * image library for file names the launcher doesn't know.
 */
export const GET = route(async (req) => {
  const adset = new URL(req.url).searchParams.get("adset")?.trim();
  if (!adset) throw new HttpError(400, "Give ?adset=<ad set ID>.");
  if (!/^[A-Za-z0-9_]+$/.test(adset)) throw new HttpError(400, `"${adset}" is not an ad set ID. Give the ID (a number; Ads Manager shows it in the ad set's row), not the name.`);
  const acc = getAccount();
  if (!acc?.token_enc) throw new HttpError(409, "Meta is not connected yet.");
  const client = clientFor(acc.id);
  let list: AdRow[];
  try {
    // One more than shown tells whether the list was cut.
    list = await client.getAll<AdRow>(`${adset}/ads`, { fields: `id,name,status,effective_status,tracking_specs,${CREATIVE}`, effective_status: STATUSES, limit: 25 }, MAX_ADS + 1);
  } catch (e) {
    if (e instanceof MetaError && !(e instanceof RateLimitedError)) throw new HttpError(e.isThrottle ? 429 : 502, plainError(e, "Reading the ads of this ad set"));
    throw e;
  }
  const truncated = list.length > MAX_ADS;
  const shown = list.slice(0, MAX_ADS);
  const files = new Map(shown.map((a) => [a.id, filesOf(a.creative ?? {})]));
  // Pixel names only when an ad tracks one (cached for an hour); languages aren't shown here.
  const idNames = shown.some((a) => trackingOf(a.tracking_specs).pixels.length || trackingOf(a.tracking_specs).offline.length) ? await plainNames(client, { locales: false }) : {};
  const names = await fileNames(client, acc.id, [...new Set([...files.values()].flatMap((f) => f.images))], [...new Set([...files.values()].flatMap((f) => f.videos))]);
  return {
    ads: shown.map((a) => {
      const c = a.creative ?? {};
      const f = files.get(a.id)!;
      const ld = c.object_story_spec?.link_data;
      const vd = c.object_story_spec?.video_data;
      const afs = c.asset_feed_spec;
      const cards = ld?.child_attachments ?? [];
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        effectiveStatus: a.effective_status ?? a.status,
        // "paused" + "in review": the ad's own setting and what Meta says, apart.
        ...adState(a.status, a.effective_status),
        fromPost: !!(c.object_story_id || (c.source_instagram_media_id && !c.object_story_spec)),
        postId: c.effective_object_story_id ?? c.object_story_id ?? null,
        instagramMediaId: c.effective_instagram_media_id ?? c.source_instagram_media_id ?? null,
        primaryTexts: afs?.bodies?.map((b) => b.text) ?? [ld?.message ?? vd?.message ?? ""].filter(Boolean),
        // A carousel's headlines are on its cards (the launcher puts them there).
        headlines: afs?.titles?.map((t) => t.text) ?? (cards.length ? cards.map((x) => x.name ?? "") : [ld?.name ?? vd?.title ?? ""]).filter(Boolean),
        link: ld?.link ?? cards.find((x) => x.link)?.link ?? vd?.call_to_action?.value?.link ?? afs?.link_urls?.[0]?.website_url ?? null,
        // Where the launcher puts them: the text options (asset_feed_spec) first, then a carousel's cards,
        // the link ad (description, caption) or the video ad (link_description, the button's link_caption).
        descriptions: afs?.descriptions?.length
          ? afs.descriptions.map((d) => d.text).filter(Boolean)
          : (cards.length ? [...new Set(cards.map((x) => x.description ?? ""))] : [ld?.description ?? vd?.link_description ?? ""]).filter(Boolean),
        displayLink: afs?.link_urls?.find((u) => u.display_url)?.display_url ?? ld?.caption ?? vd?.call_to_action?.value?.link_caption ?? null,
        button: buttonOf(c),
        // UTM tags added to the link (edit_ad's url_tags).
        utmTags: c.url_tags ?? null,
        // What the ad tracks: website pixels and offline event sets, named when known.
        tracking: ((t) => ({ pixels: t.pixels.map((id) => ({ id, name: idNames.pixels?.[id] ?? null })), offline: t.offline.map((id) => ({ id, name: idNames.pixels?.[id] ?? null })) }))(trackingOf(a.tracking_specs)),
        // Each file by name when known, else "image <hash>" / "video <ID>".
        files: [...f.images.map((h) => ({ kind: "image" as const, id: h, name: names.get(h) ?? null })), ...f.videos.map((v) => ({ kind: "video" as const, id: v, name: names.get(v) ?? null }))],
      };
    }),
    truncated,
    note: truncated ? `Only the first ${MAX_ADS} ads of this ad set are listed.` : null,
  };
});
