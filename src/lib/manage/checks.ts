import type { MetaClient } from "../meta/client";
import { MetaError, mustSurface } from "../meta/errors";
import { cacheGet, cacheSet } from "../store";
import type { Check } from "../types";
import { fromMinor, money } from "./options";

// Checks before anything goes live (batches and plans): is the ad account able to spend, does the
// landing page open, does the pixel exist and sit on the page, and what will each ad look like.

const ACCOUNT_STATUS: Record<number, string> = {
  1: "active",
  2: "disabled",
  3: "unsettled (an unpaid bill)",
  7: "under risk review",
  8: "pending settlement",
  9: "in a grace period",
  100: "pending closure",
  101: "closed",
  201: "active (any)",
  202: "closed (any)",
};

/** Why a read failed, in a few plain words. */
function why(e: unknown): string {
  if (e instanceof MetaError) {
    if (e.noAnswer || e.unknownOutcome) return "no answer from Meta";
    const words = e.body?.error_user_msg || e.body?.message || e.message;
    return `Meta said: "${words}"${e.code !== undefined ? ` (code ${e.code})` : ""}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Meta's disable_reason for a disabled ad account, in plain words. */
const DISABLE_REASON: Record<number, string> = {
  1: "its ads broke Meta's advertising policies",
  2: "Meta is reviewing it for intellectual property (IP) problems",
  3: "a problem with the payment method (Meta's payment risk review)",
  4: "Meta closed it as a suspicious account",
  5: "Meta is reviewing it (account review)",
  6: "the business that owns it failed Meta's integrity review",
  7: "it was closed for good",
  8: "it was an unused reseller account",
  9: "it was not used for a long time",
  10: "it is an umbrella account",
  11: "the Business Manager that owns it broke Meta's policies",
  12: "Meta thinks the account's details are not correct",
  13: "the business that owns it stopped sharing it",
  14: "Meta is reviewing a message conversation linked to it",
  15: "Meta thinks someone else got into the account (compromised)",
};

/**
 * Ad account health: status, payment method, account spending limit. A good read is cached
 * 10 minutes; a failed read is not cached, so the next check asks Meta again. Meta limiting calls
 * or a lost login is thrown (the page says so), never turned into a warning.
 */
export async function accountHealth(client: MetaClient): Promise<Check[]> {
  const key = `health:${client.accountId}`;
  const hit = cacheGet<Check[]>(key);
  if (hit) return hit;
  const out: Check[] = [];
  let a: { name?: string; account_status?: number; disable_reason?: number; spend_cap?: string; amount_spent?: string; currency?: string; funding_source_details?: { display_string?: string } };
  try {
    a = await client.get(client.accountId, { fields: "name,account_status,disable_reason,spend_cap,amount_spent,currency,funding_source_details" });
  } catch (e) {
    if (mustSurface(e)) throw e;
    return [{ level: "warning", code: "account_unknown", message: `Couldn't ask Meta about the ad account's status and payment method just now (${why(e)}). Check again in a minute.` }];
  }
  const cur = a.currency ?? "INR";
  if (a.account_status !== undefined && a.account_status !== 1) {
    const why = a.account_status === 2 && a.disable_reason ? ` (Meta's reason: ${DISABLE_REASON[a.disable_reason] ?? `reason code ${a.disable_reason}`})` : "";
    out.push({ level: a.account_status === 9 ? "warning" : "error", code: "account_status", message: `The ad account "${a.name}" is ${ACCOUNT_STATUS[a.account_status] ?? `in status ${a.account_status}`}${why}, so ads won't deliver. Fix it in Ads Manager → Billing / Account quality.` });
  }
  if (!a.funding_source_details?.display_string) out.push({ level: "warning", code: "no_payment", message: "Meta shows no payment method on this ad account (or the login can't see it). Ads stop delivering without one." });
  const cap = Number(a.spend_cap) || 0;
  if (cap) {
    const left = cap - (Number(a.amount_spent) || 0);
    const leftRs = fromMinor(left, cur) ?? 0;
    if (left <= 0) out.push({ level: "error", code: "spend_cap", message: `The ad account's spending limit (${money(fromMinor(cap, cur), cur)}) is used up, so nothing will deliver. Raise or reset it in Ads Manager → Billing → Account spending limit.` });
    else if (left < cap * 0.1) out.push({ level: "warning", code: "spend_cap", message: `Only ${money(leftRs, cur)} is left before the ad account's spending limit; then every ad stops. Raise it in Ads Manager → Billing if needed.` });
  }
  cacheSet(key, out, 10 * 60_000);
  return out;
}

/** Landing pages checked for the pixel (more are named in a note), read at most 5 at a time. */
const MAX_PAGES = 20;
const PAGES_AT_ONCE = 5;
/**
 * All the landing pages of one pixel check are read within this long (the launch summary is a page
 * someone waits for). Pages not read by then are named as not checked.
 */
export const PAGES_WITHIN_MS = 8_000;
/** A page the check ran out of time for. */
const UNCHECKED = Symbol("unchecked");

/** `fn` on every item, at most `n` at a time; results in the items' order. */
async function eachLimited<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * The pixel exists, has fired recently, and (when a landing page is given) is on that page.
 * "Pixel isn't in this ad account" only when Meta says so (code 100). Meta limiting calls or a lost
 * login is thrown; any other failed read is a warning, never a false "missing".
 */
export async function pixelCheck(client: MetaClient, pixelId: string, landingPages: string[] = [], fetchImpl: typeof fetch = fetch, opts: { pagesWithinMs?: number } = {}): Promise<Check[]> {
  const out: Check[] = [];
  let px: { id: string; name?: string; last_fired_time?: string; is_unavailable?: boolean };
  try {
    px = await client.get(pixelId, { fields: "id,name,last_fired_time,is_unavailable" });
  } catch (e) {
    if (mustSurface(e)) throw e;
    if (e instanceof MetaError && e.code === 100) return [{ level: "error", code: "pixel_missing", message: `Pixel ${pixelId} isn't in this ad account (or the login can't see it). Pick another pixel.` }];
    if (e instanceof MetaError && (e.code === 10 || e.code === 200 || (e.code !== undefined && e.code > 200 && e.code < 300))) {
      return [{ level: "warning", code: "pixel_no_access", message: `The launcher's Meta login has no permission to read pixel ${pixelId}, so it wasn't checked. In Meta Business settings → Data sources → Pixels, share the pixel with this ad account (and the login), then check again.` }];
    }
    return [{ level: "warning", code: "pixel_unknown", message: `Couldn't check pixel ${pixelId} just now (${why(e)}). Check again in a minute.` }];
  }
  if (px.is_unavailable) out.push({ level: "error", code: "pixel_unavailable", message: `Pixel "${px.name}" is unavailable in Meta.` });
  if (!px.last_fired_time) out.push({ level: "warning", code: "pixel_silent", message: `Pixel "${px.name}" has never sent an event, so Meta has nothing to optimise for yet.` });
  else if (Date.now() - Date.parse(px.last_fired_time) > 7 * 86_400_000) out.push({ level: "warning", code: "pixel_silent", message: `Pixel "${px.name}" last sent an event on ${px.last_fired_time.slice(0, 10)}. Check it still works on the website.` });
  const all = [...new Set(landingPages)].filter((u) => /^https?:\/\//i.test(u));
  const pages = all.slice(0, MAX_PAGES);
  // One time limit for all the pages: when it ends, pages still open are cut and the rest not started.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), opts.pagesWithinMs ?? PAGES_WITHIN_MS);
  const late = new Promise<typeof UNCHECKED>((r) => stop.signal.addEventListener("abort", () => r(UNCHECKED), { once: true }));
  let found: (Check | null | typeof UNCHECKED)[];
  try {
    found = await eachLimited(pages, PAGES_AT_ONCE, (url) => (stop.signal.aborted ? Promise.resolve(UNCHECKED) : Promise.race([pageHasPixel(url, pixelId, fetchImpl, stop.signal), late])));
  } finally {
    clearTimeout(timer);
  }
  for (const c of found) if (c && c !== UNCHECKED) out.push(c);
  const unchecked = pages.filter((_, i) => found[i] === UNCHECKED);
  if (unchecked.length === 1) {
    out.push({ level: "warning", code: "pixel_pages_unchecked", message: `${unchecked[0]} took too long to open, so pixel ${pixelId} wasn't looked for on it. Check it with Meta Pixel Helper.` });
  } else if (unchecked.length) {
    const named = unchecked.slice(0, 3).join(", ") + (unchecked.length > 3 ? ` and ${unchecked.length - 3} more` : "");
    out.push({ level: "warning", code: "pixel_pages_unchecked", message: `${unchecked.length} landing pages took too long to open, so pixel ${pixelId} wasn't looked for on them (${named}). Check them with Meta Pixel Helper.` });
  }
  if (all.length > MAX_PAGES) {
    out.push({ level: "warning", code: "pixel_pages_unchecked", message: `There are ${all.length} different landing pages; pixel ${pixelId} was looked for on the first ${MAX_PAGES} only. Check the other ${all.length - MAX_PAGES} with Meta Pixel Helper.` });
  }
  return out;
}

/**
 * One landing page: is the pixel in its HTML? A page the checker can't read says so, never "pixel not
 * found". `stop` ends when the whole check is out of time: the page is then "not checked".
 */
async function pageHasPixel(url: string, pixelId: string, fetchImpl: typeof fetch, stop: AbortSignal): Promise<Check | null | typeof UNCHECKED> {
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.any([AbortSignal.timeout(10_000), stop]), headers: { "User-Agent": "Mozilla/5.0 (SahajtaAdsLauncher pixel check)" } });
    if (!res.ok) {
      const blocked = [401, 403, 429, 503].includes(res.status);
      return { level: "warning", code: "pixel_page_unread", message: `Couldn't read ${url} (HTTP ${res.status}${blocked ? "; the site may block automated checks" : ""}), so the pixel on it wasn't checked. Open the page with Meta Pixel Helper to confirm pixel ${pixelId} is there.` };
    }
    const html = (await res.text()).slice(0, 2_000_000);
    const hasPixel = html.includes(pixelId);
    const hasMetaTag = /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\(/.test(html);
    const hasTagManager = /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/.test(html);
    if (!hasPixel && !hasMetaTag) {
      return { level: "warning", code: "pixel_not_on_page", message: `Pixel ${pixelId} wasn't found on ${url}${hasTagManager ? " (the page uses Google Tag Manager, which may load it later; check with Meta Pixel Helper)" : ""}. Without it, conversions from this page aren't counted.` };
    }
    if (!hasPixel && hasMetaTag) return { level: "warning", code: "pixel_other", message: `${url} has a Meta pixel, but not ${pixelId}. Check the page and the ad set use the same pixel.` };
    return null;
  } catch {
    if (stop.aborted) return UNCHECKED;
    return null; // a page that doesn't open is reported by the landing page check
  }
}

export const PREVIEW_FORMATS: { format: string; label: string }[] = [
  { format: "MOBILE_FEED_STANDARD", label: "Facebook Feed" },
  { format: "INSTAGRAM_STANDARD", label: "Instagram Feed" },
  { format: "INSTAGRAM_STORY", label: "Instagram Stories" },
  { format: "INSTAGRAM_REELS", label: "Instagram Reels" },
  { format: "FACEBOOK_STORY_MOBILE", label: "Facebook Stories" },
  { format: "FACEBOOK_REELS_MOBILE", label: "Facebook Reels" },
];

/**
 * Preview links per placement for a creative that doesn't exist yet (Meta's generatepreviews).
 * Each link opens Meta's own rendering of the ad and works for about 24 hours.
 */
export async function creativePreviews(client: MetaClient, creative: Record<string, unknown>): Promise<{ label: string; url: string | null; problem?: string }[]> {
  const out: { label: string; url: string | null; problem?: string }[] = [];
  for (const f of PREVIEW_FORMATS) {
    try {
      const r = await client.get<{ data?: { body?: string }[] }>(`${client.accountId}/generatepreviews`, { creative, ad_format: f.format });
      const body = r.data?.[0]?.body ?? "";
      const src = /src="([^"]+)"/.exec(body)?.[1]?.replace(/&amp;/g, "&") ?? null;
      out.push({ label: f.label, url: src });
    } catch (e) {
      out.push({ label: f.label, url: null, problem: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    }
  }
  return out;
}
