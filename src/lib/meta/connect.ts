import { config } from "../config";
import { decrypt, encrypt } from "../crypto";
import { db } from "../db";
import { HttpError } from "../httperror";
import { defaultPreset, isMock, seedDefaults } from "../setup";
import { cacheDelete, cacheGet, cacheSet, getAccount } from "../store";
import { MetaClient } from "./client";
import { MetaError, RateLimitedError, metaSaid, mustSurface } from "./errors";
import { DEFAULT_UTM } from "../engine/naming";
import { defaultMaxWaitMs, mockMeta, pacerFor, sharedDeadline } from "./factory";

// Connect Meta from inside the app, so the person who uses the launcher can do it alone:
//   Settings → Connect Meta → Facebook login (they tick the ad account, Page, Instagram)
//   → /api/meta/callback gets a one-time code → the server swaps it for a token
//   → they pick the ad account, Page and Instagram account → saved, encrypted.
// "Paste a token instead" ends in the same picking step.
// The token never reaches the browser. Between login and picking it waits, encrypted,
// in the cache table for 30 minutes at most.

// What the Facebook login asks for (the same list as the "Launcher connect" configuration in the Meta app).
// Instagram accounts come through the ad account (ads_management), so instagram_basic is not needed.
export const PERMISSIONS = ["ads_management", "ads_read", "business_management", "pages_show_list", "pages_read_engagement", "pages_manage_ads"];

const PENDING_MS = 30 * 60_000;
const pendingKey = (email: string) => `meta:pending:${email}`;

interface TokenInfo {
  token: string;
  expiresAt: number | null; // ms; null = does not expire (system user) or unknown
  who: string;
  scopes: string[] | null;
}

interface Graph {
  fetch: typeof fetch;
  base: string;
  version: string;
  appId: string;
  appSecret: string;
}

function graph(): Graph {
  if (isMock()) return { fetch: mockMeta().fetch, base: "https://graph.facebook.com", version: config.metaApiVersion, appId: "mock-app", appSecret: "mock-secret" };
  if (!config.metaAppId || !config.metaAppSecret) {
    throw new HttpError(409, "Connect Meta is not set up on the server yet: META_APP_ID and META_APP_SECRET are missing. Ask your admin (docs/SETUP.md, Meta step 4).");
  }
  return { fetch, base: config.metaGraphUrl, version: config.metaApiVersion, appId: config.metaAppId, appSecret: config.metaAppSecret };
}

/**
 * A client for Connect Meta. Someone is waiting on the Settings page, so it answers within seconds
 * when Meta limits calls (maxWaitMs). Calls about an ad account the launcher already knows share
 * that account's pacing (the same rate_state row as launches and pages).
 */
function clientWith(g: Graph, token: string, adAccountId?: string) {
  const known = adAccountId ? (db().prepare("SELECT id FROM ad_accounts WHERE meta_account_id = ?").get(adAccountId) as { id: number } | undefined) : undefined;
  return new MetaClient({
    token,
    accountId: adAccountId || "act_0",
    version: g.version,
    baseUrl: g.base,
    appSecret: isMock() ? undefined : g.appSecret,
    fetch: g.fetch,
    pacer: known ? pacerFor(known.id) : undefined,
    maxWaitMs: defaultMaxWaitMs(),
    deadline: sharedDeadline(),
  });
}

/** For `.catch` fallbacks: Meta limiting calls or a dead login must reach the person, never become "nothing". */
function surface(e: unknown) {
  if (mustSurface(e)) throw e;
}

export function redirectUri() {
  return `${config.appUrl}/api/meta/callback`;
}

/** Where the Connect Meta button sends the browser. Practice mode skips Facebook. */
export function dialogUrl(state: string): string {
  if (isMock()) return `/api/meta/callback?code=practice&state=${state}`;
  const g = graph();
  const q = new URLSearchParams({ client_id: g.appId, redirect_uri: redirectUri(), state, response_type: "code" });
  if (config.metaLoginConfigId) {
    q.set("config_id", config.metaLoginConfigId);
    q.set("override_default_response_type", "true");
  } else {
    q.set("scope", PERMISSIONS.join(","));
  }
  return `https://www.facebook.com/${g.version}/dialog/oauth?${q}`;
}

async function oauth(g: Graph, params: Record<string, string>) {
  const res = await g.fetch(`${g.base}/${g.version}/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: g.appId, client_secret: g.appSecret, ...params }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!res.ok || !j.access_token) throw new HttpError(400, `Facebook did not finish the connection (${j.error?.message ?? `error ${res.status}`}). Click Connect Meta and try again.`);
  return { token: j.access_token, expiresIn: j.expires_in };
}

/** The one-time code from the Facebook login → a token that lasts (about 60 days for a person; no end for a system user). */
export async function exchangeCode(code: string): Promise<TokenInfo> {
  const g = graph();
  let t = await oauth(g, { code, redirect_uri: redirectUri() });
  // A person's first token lasts about 2 hours: swap it for the 60-day one.
  if (t.expiresIn && t.expiresIn < 7 * 86_400) t = await oauth(g, { grant_type: "fb_exchange_token", fb_exchange_token: t.token });
  return inspect(t.token);
}

/** Ask Meta who the token belongs to, what it may do and when it ends. */
export async function inspect(token: string): Promise<TokenInfo> {
  const g = graph();
  let me: { id: string; name?: string };
  try {
    me = await clientWith(g, token).get<{ id: string; name?: string }>("me", { fields: "id,name" });
  } catch (e) {
    // Meta limiting calls says nothing about the token: pass the plain "try again after…" message on.
    if (e instanceof RateLimitedError || (e instanceof MetaError && e.isThrottle)) throw e;
    const why = e instanceof MetaError && e.code === 190 ? "it may be expired, cut short when copied, or made for another app" : e instanceof Error ? e.message : String(e);
    throw new HttpError(400, `Meta did not accept this token: ${why}.`);
  }
  let expiresAt: number | null = null;
  let scopes: string[] | null = null;
  try {
    // debug_token takes the token as a parameter (server to Meta over HTTPS; never logged).
    const res = await g.fetch(`${g.base}/${g.version}/debug_token?${new URLSearchParams({ input_token: token, access_token: `${g.appId}|${g.appSecret}` })}`);
    const d = ((await res.json()) as { data?: { expires_at?: number; scopes?: string[] } }).data;
    if (d?.expires_at) expiresAt = d.expires_at * 1000;
    if (d?.scopes) scopes = d.scopes;
  } catch {
    /* expiry and permissions stay unknown */
  }
  return { token, expiresAt, who: me.name ?? me.id, scopes };
}

export function savePending(email: string, t: TokenInfo) {
  cacheSet(pendingKey(email), { tokenEnc: encrypt(t.token), expiresAt: t.expiresAt, who: t.who, scopes: t.scopes }, PENDING_MS);
}

/** The token waiting to be used (just connected), or the one in use (to change the ad account or Page). */
function workingToken(email: string): TokenInfo | undefined {
  const p = cacheGet<{ tokenEnc: string; expiresAt: number | null; who: string; scopes: string[] | null }>(pendingKey(email));
  if (p) return { token: decrypt(p.tokenEnc), expiresAt: p.expiresAt, who: p.who, scopes: p.scopes };
  const acc = getAccount();
  if (acc?.token_enc) return { token: decrypt(acc.token_enc), expiresAt: acc.token_expires_at, who: acc.meta_user_name ?? "", scopes: null };
  return undefined;
}

const ACCOUNT_STATUS: Record<number, string> = {
  1: "Active",
  2: "Disabled",
  3: "Payment problem",
  7: "Under risk review",
  8: "Payment pending",
  9: "Grace period",
  100: "Closing",
  101: "Closed",
};

export interface MetaAssets {
  who: string;
  expiresAt: number | null;
  missing: string[];
  adAccounts: { id: string; name: string; business: string; active: boolean; status: string }[];
  pages: { id: string; name: string; pictureUrl: string | null; link: string; instagram: { id: string; username: string } | null }[];
}

/** An Instagram account as the pickers show it. `allowed`: the ad account may advertise with it
 *  (Meta refuses the creative with code 200/1815199 otherwise). */
export interface InstagramChoice {
  id: string;
  username: string;
  pictureUrl: string | null;
  link: string;
  allowed: boolean;
}

export const pageLink = (id: string) => `https://www.facebook.com/${id}`;
export const igLink = (username: string) => `https://www.instagram.com/${username}`;

/** What the connected Facebook login may use: ad accounts, Pages and their Instagram accounts. */
export async function listAssets(email: string): Promise<MetaAssets> {
  const t = workingToken(email);
  if (!t) throw new HttpError(409, "Click Connect Meta first.");
  const client = clientWith(graph(), t.token);
  const accounts = await client.getAll<{ id: string; name: string; account_status: number; business?: { name: string } }>("me/adaccounts", { fields: "id,name,account_status,business{name}" });
  type PageRow = { id: string; name: string; picture?: { data?: { url?: string } }; instagram_business_account?: { id: string; username: string } };
  // A Page's linked Instagram account needs more permissions than the Page list; without them, list the Pages alone.
  const pages = await client
    .getAll<PageRow>("me/accounts", { fields: "id,name,picture{url},instagram_business_account{id,username}" })
    .catch((e: unknown) => {
      surface(e);
      return client.getAll<PageRow>("me/accounts", { fields: "id,name,picture{url}" });
    })
    .catch((e: unknown) => {
      surface(e);
      return client.getAll<PageRow>("me/accounts", { fields: "id,name" });
    });
  return {
    who: t.who,
    expiresAt: t.expiresAt,
    missing: t.scopes ? PERMISSIONS.filter((p) => !t.scopes!.includes(p)) : [],
    adAccounts: accounts.map((a) => ({ id: a.id, name: a.name, business: a.business?.name ?? "", active: a.account_status === 1, status: ACCOUNT_STATUS[a.account_status] ?? `Status ${a.account_status}` })),
    pages: pages.map((p) => ({ id: p.id, name: p.name, pictureUrl: p.picture?.data?.url ?? null, link: pageLink(p.id), instagram: p.instagram_business_account ?? null })),
  };
}

/** Instagram accounts the ad account can advertise with (allowed), plus those only linked to
 *  the Pages (not allowed until someone assigns them to the ad account in Business settings).
 *  If Meta doesn't give the ad account's list, say so: guessing "not allowed" would refuse a
 *  choice that may be fine. */
export async function listInstagram(email: string, adAccountId: string): Promise<InstagramChoice[]> {
  const t = workingToken(email);
  if (!t) throw new HttpError(409, "Click Connect Meta first.");
  const client = clientWith(graph(), t.token, adAccountId);
  type IgRow = { id: string; username: string; profile_pic?: string };
  const fromAccount = await client
    .getAll<IgRow>(`${adAccountId}/instagram_accounts`, { fields: "id,username,profile_pic" })
    .catch((e: unknown) => {
      surface(e);
      // Without the picture field (some logins may not read it).
      return client.getAll<IgRow>(`${adAccountId}/instagram_accounts`, { fields: "id,username" });
    })
    .catch((e: unknown) => {
      surface(e);
      throw new HttpError(
        502,
        `Couldn't read from Meta which Instagram accounts this ad account may use, so the launcher can't tell which ones are allowed.${e instanceof MetaError ? metaSaid(e) || ` (${e.message})` : ` (${e instanceof Error ? e.message : String(e)})`} Try again in a minute, or pick "None (use the Facebook Page)".`,
      );
    });
  const fromPages = (await listAssets(email)).pages.map((p) => p.instagram).filter((i): i is { id: string; username: string } => !!i);
  const out: InstagramChoice[] = fromAccount.map((i) => ({ id: i.id, username: i.username, pictureUrl: i.profile_pic ?? null, link: igLink(i.username), allowed: true }));
  for (const i of fromPages) if (!out.some((o) => o.id === i.id)) out.push({ id: i.id, username: i.username, pictureUrl: null, link: igLink(i.username), allowed: false });
  return out;
}

function copyTemplates(from: number, to: number) {
  const d = db();
  d.prepare("INSERT INTO copy_templates (ad_account_id, name, primary_texts, headlines, description, descriptions, cta, link_url, utm_template, display_link, lead_form_id) SELECT ?, name, primary_texts, headlines, description, descriptions, cta, link_url, utm_template, display_link, lead_form_id FROM copy_templates WHERE ad_account_id = ?").run(to, from);
  d.prepare("INSERT INTO naming_templates (ad_account_id, name, kind, pattern, is_default) SELECT ?, name, kind, pattern, is_default FROM naming_templates WHERE ad_account_id = ?").run(to, from);
  d.prepare("INSERT INTO settings_presets (ad_account_id, name, page_id, page_name, ig_user_id, ig_name, enhancements, multi_advertiser, whatsapp_number, threads_user_id, sponsor_page_id, offline_dataset_ids, is_default) SELECT ?, name, page_id, page_name, ig_user_id, ig_name, enhancements, multi_advertiser, whatsapp_number, threads_user_id, sponsor_page_id, offline_dataset_ids, is_default FROM settings_presets WHERE ad_account_id = ?").run(to, from);
  d.prepare("INSERT INTO campaign_templates (ad_account_id, name, objective, special_ad_categories) SELECT ?, name, objective, special_ad_categories FROM campaign_templates WHERE ad_account_id = ?").run(to, from);
}

/**
 * Save the choice: the token goes (encrypted) with the chosen ad account, which becomes the one in use.
 * A new ad account takes over the templates and presets of the previous one.
 */
export async function selectAssets(email: string, sel: { adAccountId: string; pageId: string; igUserId?: string }): Promise<number> {
  const t = workingToken(email);
  if (!t) throw new HttpError(409, "The Facebook login has timed out. Click Connect Meta again.");
  const assets = await listAssets(email);
  const acc = assets.adAccounts.find((a) => a.id === sel.adAccountId);
  if (!acc) throw new HttpError(400, "Pick an ad account from the list.");
  if (!acc.active) throw new HttpError(400, `"${acc.name}" is not active in Meta (${acc.status.toLowerCase()}). Pick another ad account, or fix it in Meta first.`);
  const page = assets.pages.find((p) => p.id === sel.pageId);
  if (!page) throw new HttpError(400, "Pick the Facebook Page the ads should run from.");
  const ig = sel.igUserId ? (await listInstagram(email, acc.id)).find((i) => i.id === sel.igUserId) : undefined;
  if (sel.igUserId && !ig) throw new HttpError(400, "Pick an Instagram account from the list, or none.");
  if (ig && !ig.allowed) {
    throw new HttpError(
      400,
      `The ad account "${acc.name}" is not allowed to use @${ig.username} yet, so Meta would refuse every ad. In Meta Business settings → Accounts → Instagram accounts → @${ig.username} → Assign assets (Connected assets), add the ad account "${acc.name}", then click Connect Meta again. Or pick "None (use the Facebook Page)".`,
    );
  }

  const d = db();
  const previous = getAccount();
  const existing = d.prepare("SELECT id FROM ad_accounts WHERE meta_account_id = ?").get(acc.id) as { id: number } | undefined;
  const id = d.transaction(() => {
    const id = existing?.id ?? Number(d.prepare("INSERT INTO ad_accounts (meta_account_id, name) VALUES (?, ?)").run(acc.id, acc.name).lastInsertRowid);
    d.prepare("UPDATE ad_accounts SET is_default = (id = ?)").run(id);
    d.prepare(
      "UPDATE ad_accounts SET name = ?, token_enc = ?, token_expires_at = ?, meta_user_name = ?, connected_by = ?, connected_at = datetime('now') WHERE id = ?",
    ).run(acc.name, encrypt(t.token), t.expiresAt, t.who, email, id);
    if (!existing && previous && previous.id !== id) copyTemplates(previous.id, id);
    seedDefaults(id);
    // The chosen Page and Instagram go into the default preset, and into any preset without a Page.
    const preset = defaultPreset(id)!;
    d.prepare("UPDATE settings_presets SET page_id = ?, page_name = ?, ig_user_id = ?, ig_name = ? WHERE ad_account_id = ? AND (id = ? OR page_id = '')")
      .run(page.id, page.name, ig?.id ?? "", ig?.username ?? "", id, preset.id);
    if (isMock() && !d.prepare("SELECT 1 FROM copy_templates WHERE ad_account_id = ?").get(id)) {
      // Practice mode: one example copy template so the flow can be tried end to end.
      d.prepare("INSERT INTO copy_templates (ad_account_id, name, primary_texts, headlines, description, descriptions, cta, link_url, utm_template) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        "Site-visit copy (example)",
        JSON.stringify(["Book a free site visit this weekend.", "Plots from 20 lakh, ready to register.", "See the layout before you decide."]),
        JSON.stringify(["Free site visit", "Plots from 20L", "See the layout"]),
        "Sahajta Estates",
        JSON.stringify(["Sahajta Estates"]),
        "LEARN_MORE",
        "https://sahajta.com",
        DEFAULT_UTM,
      );
    }
    return id;
  })();
  cacheDelete(pendingKey(email));
  cacheDelete("dest:");
  cacheDelete("ident:");
  return id;
}

/** Forget the token. Templates, presets and history stay. */
export function disconnect() {
  const acc = getAccount();
  if (acc) db().prepare("UPDATE ad_accounts SET token_enc = NULL, token_expires_at = NULL WHERE id = ?").run(acc.id);
  cacheDelete("dest:");
  cacheDelete("ident:");
}

export interface MetaStatus {
  ready: boolean;
  practice: boolean;
  connected: boolean;
  pending: boolean;
  adAccount: { id: string; name: string } | null;
  page: string | null;
  instagram: string | null;
  /** IDs and links for the Page and Instagram account in the default preset. */
  pageId: string | null;
  pageLink: string | null;
  igUserId: string | null;
  igLink: string | null;
  who: string | null;
  connectedBy: string | null;
  connectedAt: string | null;
  expiresAt: number | null;
  expired: boolean;
  expiresSoon: boolean;
}

export function metaStatus(email: string): MetaStatus {
  const acc = getAccount();
  const connected = !!acc?.token_enc;
  const preset = acc ? defaultPreset(acc.id) : undefined;
  const expiresAt = connected ? (acc!.token_expires_at ?? null) : null;
  return {
    ready: isMock() || (!!config.metaAppId && !!config.metaAppSecret),
    practice: isMock(),
    connected,
    pending: !!cacheGet(pendingKey(email)),
    adAccount: connected ? { id: acc!.meta_account_id, name: acc!.name } : null,
    page: connected ? preset?.pageName || preset?.pageId || null : null,
    instagram: connected ? (preset?.igName ? `@${preset.igName}` : preset?.igUserId || null) : null,
    pageId: connected ? preset?.pageId || null : null,
    pageLink: connected && preset?.pageId ? pageLink(preset.pageId) : null,
    igUserId: connected ? preset?.igUserId || null : null,
    igLink: connected && preset?.igName ? igLink(preset.igName) : null,
    who: connected ? acc!.meta_user_name : null,
    connectedBy: connected ? acc!.connected_by : null,
    connectedAt: connected ? acc!.connected_at : null,
    expiresAt,
    expired: !!expiresAt && expiresAt < Date.now(),
    expiresSoon: !!expiresAt && expiresAt - Date.now() < 7 * 86_400_000,
  };
}

/** Practice mode only: connect the fake account without a browser (command-line tools). */
export async function connectPractice(email = "practice@example.com"): Promise<number> {
  if (!isMock()) throw new Error("connectPractice is only for practice mode (META_MOCK=1).");
  savePending(email, await exchangeCode("practice"));
  const a = await listAssets(email);
  const acc = a.adAccounts.find((x) => x.active)!;
  return selectAssets(email, { adAccountId: acc.id, pageId: a.pages[0].id, igUserId: a.pages[0].instagram?.id });
}
