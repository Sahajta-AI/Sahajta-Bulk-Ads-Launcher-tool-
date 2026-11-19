import { route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { clientFor } from "@/lib/meta/factory";
import { MetaError, RateLimitedError, plainError } from "@/lib/meta/errors";
import { getAccount } from "@/lib/store";
import { adState } from "@/lib/manage/ads";

export const dynamic = "force-dynamic";

/** Most ads listed for one ad set (pages of 25 ads with their creatives; one Meta call per page). */
const MAX_ADS = 100;

const CREATIVE = "creative{object_story_id,effective_object_story_id,effective_instagram_media_id,source_instagram_media_id,object_story_spec,asset_feed_spec}";
const STATUSES = ["ACTIVE", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "PENDING_REVIEW", "IN_PROCESS", "WITH_ISSUES", "PREAPPROVED", "DISAPPROVED", "PENDING_BILLING_INFO"];

type Creative = {
  object_story_id?: string;
  effective_object_story_id?: string;
  effective_instagram_media_id?: string;
  source_instagram_media_id?: string;
  object_story_spec?: {
    link_data?: { message?: string; name?: string; description?: string; caption?: string; link?: string; child_attachments?: { name?: string; description?: string; link?: string }[] };
    video_data?: { message?: string; title?: string; link_description?: string; call_to_action?: { value?: { link?: string; link_caption?: string } } };
  };
  asset_feed_spec?: { bodies?: { text: string }[]; titles?: { text: string }[]; descriptions?: { text: string }[]; link_urls?: { website_url?: string; display_url?: string }[] };
};
type AdRow = { id: string; name: string; status: string; effective_status?: string; creative?: Creative };

/**
 * ?adset=ID → its ads with their on/off setting and Meta's review state, texts, description, link,
 * display link and the post behind each (up to 100). One list read with the creatives inside (pages
 * of 25), not one read per ad: every field below comes from that read.
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
    list = await client.getAll<AdRow>(`${adset}/ads`, { fields: `id,name,status,effective_status,${CREATIVE}`, effective_status: STATUSES, limit: 25 }, MAX_ADS + 1);
  } catch (e) {
    if (e instanceof MetaError && !(e instanceof RateLimitedError)) throw new HttpError(e.isThrottle ? 429 : 502, plainError(e, "Reading the ads of this ad set"));
    throw e;
  }
  const truncated = list.length > MAX_ADS;
  return {
    ads: list.slice(0, MAX_ADS).map((a) => {
      const c = a.creative ?? {};
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
        description: afs?.descriptions?.find((d) => d.text)?.text ?? (cards.length ? cards.find((x) => x.description)?.description : ld?.description) ?? vd?.link_description ?? null,
        displayLink: afs?.link_urls?.find((u) => u.display_url)?.display_url ?? ld?.caption ?? vd?.call_to_action?.value?.link_caption ?? null,
      };
    }),
    truncated,
    note: truncated ? `Only the first ${MAX_ADS} ads of this ad set are listed.` : null,
  };
});
