import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { MockMeta, FakeClock } from "@/lib/meta/mock";
import { clientFor } from "@/lib/meta/factory";
import { runBatch } from "@/lib/engine/launcher";
import { localFiles } from "@/lib/sources/local";
import { saveAppSettings } from "@/lib/appsettings";
import { checkLinks } from "@/lib/engine/preview";
import { httpApi, registerTools } from "@/mcp/tools";
import { getAds, getBatch } from "@/lib/store";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// the marketer's test of Claude's tools at 12:10 pm IST on 19 Nov 2026 (rows "Pre-launch checks", "Display
// link, Threads, WhatsApp number and branding per ad" and "Create, duplicate and edit campaigns").
// Claude's real tools → httpApi → the app's REAL route handlers in-process → service → the practice Meta.
// Landing pages are answered by a fake web (never the real internet); nothing calls the real Meta API.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
process.env.ALLOWED_EMAILS = "test@example.com";
const BASE = "http://launcher.r5";
const KEY = "sal_r5_shubhang_key_0123456789";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let mock: MockMeta;
let clock: FakeClock;
let folder: string;

const PAGE_404 = "https://warmchain.sahajta.com/this-page-does-not-exist-test-404";
const NO_SITE = "https://no-such-site-sahajta-test-12345.com/";
/** Landing pages fetched by the checks (the fake web), in order. */
let webHits: string[] = [];
/** Pages that answer with the pixel's code on them. */
let pixelPages = new Set<string>();

const mods = import.meta.glob("../src/app/api/**/route.ts");
const table = Object.keys(mods)
  .filter((p) => !p.includes("[..."))
  .map((p) => {
    const rel = p.replace("../src/app", "").replace("/route.ts", "");
    const names: string[] = [];
    const re = new RegExp("^" + rel.split("/").map((seg) => { const m = /^\[(\w+)\]$/.exec(seg); if (m) { names.push(m[1]); return "([^/]+)"; } return seg; }).join("/") + "$");
    return { re, names, load: mods[p] };
  })
  .sort((a, b) => a.names.length - b.names.length);

async function dispatch(req: Request): Promise<Response> {
  const u = new URL(req.url);
  for (const r of table) {
    const m = r.re.exec(u.pathname);
    if (!m) continue;
    const mod = (await r.load()) as Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
    const h = mod[req.method];
    if (!h) return new Response("Method Not Allowed", { status: 405 });
    return h(req, { params: Promise.resolve(Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]))) });
  }
  return new Response("404", { status: 404 });
}

beforeAll(async () => {
  folder = await fifteenFileFolder();
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const s = url instanceof Request ? url.url : String(url);
    if (s.startsWith(BASE)) return dispatch(new Request(s, init));
    // The fake web: never the real internet.
    webHits.push(s);
    if (s === PAGE_404) return new Response("<html>Not found</html>", { status: 404 });
    if (s.startsWith(NO_SITE)) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND no-such-site-sahajta-test-12345.com"), { code: "ENOTFOUND" }) });
    if (pixelPages.has(s)) return new Response(`<html><script src="https://connect.facebook.net/en_US/fbevents.js"></script><script>fbq('init','px1')</script></html>`);
    return new Response("<html>ok</html>");
  });
}, 120_000);

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 90000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
  webHits = [];
  pixelPages = new Set();
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run("test@example.com", "r5", sha256(KEY), KEY.slice(-4));
});

async function claude() {
  const server = new McpServer({ name: "r5", version: "0" });
  registerTools(server, httpApi(BASE, KEY));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "r5", version: "0" });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
}

async function batch(opts: { lead?: boolean; adsetId?: string } = {}) {
  const r = await setupBatch(folder, { adsetId: opts.adsetId });
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(r.accountId);
  if (opts.lead !== false) db().prepare("UPDATE batches SET copy = ? WHERE id = ?").run(JSON.stringify(LEAD_COPY), r.batchId);
  return { ...r, key: getBatch(r.batchId)!.key };
}
const deps = (accountId: number) => ({ client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "r5-")) });
const planKey = (text: string) => /^Plan (\w+):/m.exec(text)?.[1] ?? "";
/** The practice Meta answers every call from now on with "User request limit reached" (code 17). */
function rateLimitMeta() {
  for (let i = 0; i < 500; i++) mock.inject({ match: () => true, kind: "error", error: { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true } });
}

const THROTTLE = { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true };
/** Meta's "limiting calls" answer, as Claude must see it: what happened and when to try again. */
const LIMITED = /Meta is limiting how often the launcher may call this ad account.*Try again after about \d{1,2}:\d\d [ap]m IST \(in \d+ minutes?\)/;
const rowOf = (text: string, n: number) => text.split("\n").find((x) => x.startsWith(`| ${n} |`)) ?? "";
const WHO = "test@example.com";

describe("P1 · ad account health is a line of the pre-launch summary", () => {
  it("all well: preview_batch shows 'Ad account health: active, payment method Visa *1234, no spending limit'", async () => {
    const { key } = await batch();
    const call = await claude();
    const r = await call("preview_batch", { batch_id: key });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^PRE-LAUNCH SUMMARY$/m);
    expect(r.text).toMatch(/^Ad account health: active, payment method Visa \*1234, no spending limit$/m);
  });

  it("a disabled ad account: the health line says NOT ACTIVE and the summary has a CHECK FAILED that refuses a turn-on", async () => {
    g.__mockMeta = mock = new MockMeta({ clock, capPoints: 90000, richAccount: true, allowActive: true, videoProcessingMs: 1000, accountStatus: 2 });
    const { key } = await batch();
    const call = await claude();
    const r = await call("preview_batch", { batch_id: key, go_live: "now" });
    expect(r.text).toMatch(/^Ad account health: NOT ACTIVE: disabled, payment method Visa \*1234, no spending limit$/m);
    expect(r.text).toMatch(/^CHECK FAILED: The ad account ".*" is disabled, so ads won't deliver\./m);
    expect(r.text).toMatch(/The launch is refused until this is fixed/);
  });
});

describe("P2 · landing pages are opened by preview_batch itself", () => {
  it("ad 1's 404 page and ad 2's site that doesn't exist are each flagged in plain words, without asking", async () => {
    const { key } = await batch();
    const call = await claude();
    const set = await call("set_ad_copy", { batch_id: key, rows: [{ ad: 1, link_url: PAGE_404 }, { ad: 2, link_url: NO_SITE }] });
    expect(set.isError, set.text).toBe(false);
    webHits = [];
    const r = await call("preview_batch", { batch_id: key });
    expect(webHits).toContain(PAGE_404);
    expect(webHits).toContain(NO_SITE);
    expect(rowOf(r.text, 1)).toContain(`Warning: Landing page ${PAGE_404}: page not found (404). People clicking the ad would see an error page.`);
    expect(rowOf(r.text, 2)).toContain(`Warning: Landing page ${NO_SITE}: couldn't open: the site doesn't exist`);
    expect(rowOf(r.text, 3)).not.toMatch(/Landing page/);
  });

  it("a few pages at a time, and one time limit for all: a page that never answers is named as not checked", async () => {
    let open = 0;
    let most = 0;
    const slow: typeof fetch = async (u) => {
      open++;
      most = Math.max(most, open);
      try {
        if (String(u).includes("hang")) await new Promise(() => undefined); // never answers, ignores the abort
        await new Promise((r) => setTimeout(r, 20));
        return new Response("ok");
      } finally {
        open--;
      }
    };
    const urls = [...Array.from({ length: 12 }, (_, i) => `https://site${i}.example.org/`), "https://hang.example.org/"];
    const t0 = Date.now();
    const res = await checkLinks(urls, slow, { withinMs: 400 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(most).toBeLessThanOrEqual(5);
    expect(res.get("https://site0.example.org/")).toBeNull();
    expect(res.get("https://hang.example.org/")).toBe("Landing page https://hang.example.org/ wasn't checked: the check ran out of time. Open it in a browser to check it works.");
  });
});

describe("P3 · the pixel is a line of the pre-launch summary", () => {
  it("an Instant-form ad set says 'no pixel needed'", async () => {
    const { key } = await batch();
    const call = await claude();
    const r = await call("preview_batch", { batch_id: key });
    expect(r.text).toMatch(/^Pixel: no pixel needed \(the ad set doesn't use one; goal: Instant forms.*Leads\)$/m);
  });

  it("a website-conversion ad set names its pixel, event, last event and whether the pixel is on the landing page", async () => {
    Object.assign(mock.objects.get("as1")!, { optimization_goal: "OFFSITE_CONVERSIONS", destination_type: "WEBSITE", promoted_object: { pixel_id: "px1", custom_event_type: "LEAD" } });
    const { key } = await batch({ lead: false });
    pixelPages.add("https://example.com/visit");
    const call = await claude();
    const r = await call("preview_batch", { batch_id: key });
    expect(r.text).toMatch(/^Pixel: "Site pixel" \(ID px1\) · event LEAD · last event 2026-11-01 · found on 1 of 1 landing page checked$/m);
  });

  it("a pixel that isn't on the landing page: the line says found on 0 of 1, and a check names the page", async () => {
    Object.assign(mock.objects.get("as1")!, { optimization_goal: "OFFSITE_CONVERSIONS", destination_type: "WEBSITE", promoted_object: { pixel_id: "px1", custom_event_type: "LEAD" } });
    const { key } = await batch({ lead: false });
    const call = await claude();
    const r = await call("preview_batch", { batch_id: key });
    expect(r.text).toMatch(/^Pixel: "Site pixel" \(ID px1\) · event LEAD · last event 2026-11-01 · found on 0 of 1 landing page checked$/m);
    expect(r.text).toMatch(/^Check: Pixel px1 wasn't found on https:\/\/example.com\/visit/m);
  });
});

describe("P4 · the daily budget ceiling", () => {
  it("no ceiling set: a ₹9,00,000 a day plan says so plainly (the warning and a line), and shows no ₹0 lifetime", async () => {
    await batch();
    const call = await claude();
    const p = await call("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", daily_budget: 900000 }] });
    expect(p.isError, p.text).toBe(false);
    expect(p.text).toMatch(/Warning: .*₹9,00,000.*above the usual limit of ₹10,000\. Make sure this is right\. No daily budget ceiling is set, so nothing stops this; it can be set only in the app, Settings → Safety\./);
    expect(p.text).toMatch(/^Daily budget ceiling: none set, so nothing stops a very large budget\./m);
    expect(p.text).not.toMatch(/₹0/);
    expect((await call("get_safety_settings", {})).text).toMatch(/^Daily budget ceiling: none set/);
  });

  it("a ceiling set: Claude sees it, a plan that would spend more is an ERROR and confirm_plan is refused", async () => {
    await batch();
    saveAppSettings({ dailyBudgetCeiling: 50000 }, WHO);
    const call = await claude();
    expect((await call("get_safety_settings", {})).text).toMatch(/^Daily budget ceiling: ₹50,000 a day\. A launch or plan that would let more than this spend per day is refused\./);
    const p = await call("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", daily_budget: 900000 }, { type: "set_status", status: "ACTIVE", campaigns: ["c1"], adsets: ["as1"] }] });
    expect(p.text).toMatch(/^Daily budget ceiling \(Settings → Safety\): ₹50,000 a day\./m);
    expect(p.text).toMatch(/ERROR: This plan would let ₹9,00,000 a day spend, above the daily budget ceiling of ₹50,000/);
    expect(p.text).toMatch(/The daily budget ceiling \(Settings → Safety\) is ₹50,000 a day/);
    const c = await call("confirm_plan", { plan_id: planKey(p.text), confirm: true, accept_warnings: true, spend_confirmation: "₹9,00,000" });
    expect(c.isError).toBe(true);
    expect(c.text).toMatch(/ceiling of ₹50,000/);
    expect(mock.objects.get("as1")!.daily_budget).toBe("50000");
    // A plan that only sets the budget (nothing spends yet) says it can't be turned on later.
    const paused = await call("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", daily_budget: 900000 }] });
    expect(paused.text).toMatch(/Warning: "November test ad set" \(₹9,00,000 a day\) is above the daily budget ceiling of ₹50,000 set in Settings → Safety\. Nothing spends in this plan, but it can't be turned on/);
  });

  it("a batch that turns ads on above the ceiling: CHECK FAILED in preview_batch, and launch_batch is refused", async () => {
    const { key } = await batch();
    saveAppSettings({ dailyBudgetCeiling: 400 }, WHO);
    const call = await claude();
    const r = await call("preview_batch", { batch_id: key, go_live: "now" });
    expect(r.text).toMatch(/^Daily budget ceiling: ₹400 a day \(Settings → Safety\)/m);
    expect(r.text).toMatch(/^CHECK FAILED: This launch would let ₹500 a day spend, above the daily budget ceiling of ₹400 set in Settings → Safety\./m);
    expect(r.text).toMatch(/The launch is refused until this is fixed/);
    const l = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: 99, spend_confirmation: "₹500" });
    expect(l.isError).toBe(true);
    expect(l.text).toMatch(/ceiling of ₹400/);
    expect(getBatch((await import("@/lib/store")).getBatchByKey(key)!.id)!.status).toBe("draft");
  });
});

describe("P5 · the batch copy line is the batch's, and ads with their own link are counted", () => {
  it("ad 1 with its own link: the copy line shows the batch link and says 1 ad has its own link", async () => {
    const { key } = await batch();
    const call = await claude();
    await call("set_ad_copy", { batch_id: key, rows: [{ ad: 1, link_url: "https://example.com/own" }] });
    const r = await call("preview_batch", { batch_id: key });
    expect(r.text).toMatch(/^Copy \(the batch copy; 1 ad has its own copy, shown in the table; 1 ad has its own link\): 5 primary text\(s\), 5 headline\(s\), LEARN_MORE → https:\/\/example\.com\/visit /m);
    expect(rowOf(r.text, 1)).toContain("→ https://example.com/own");
  });
});

describe("D1 · display link and description are shown everywhere", () => {
  it("save_copy_template → list_templates, the preview's copy line, an ad's own display link, and list_ads after launch", async () => {
    const { key, batchId, accountId } = await batch({ lead: false });
    // A link-click ad set, so no lead form is needed.
    Object.assign(mock.objects.get("as1")!, { optimization_goal: "LINK_CLICKS", destination_type: "WEBSITE", promoted_object: {} });
    const call = await claude();
    const t = await call("save_copy_template", { name: "Visit", primary_texts: ["Book a visit"], headlines: ["Free visit"], link_url: "https://example.com/visit", display_link: "sahajta.com/visit", description: "Plots from 20 lakh", cta: "LEARN_MORE" });
    expect(t.isError, t.text).toBe(false);
    const l = await call("list_templates", {});
    expect(l.text).toMatch(/"Visit" \(id \d+\): .* · display link sahajta\.com\/visit · description "Plots from 20 lakh" · lead form none/);
    await call("set_ad_copy", { batch_id: key, rows: [{ ad: 2, display_link: "sahajta.com/ad2" }] });
    const r = await call("preview_batch", { batch_id: key, copy_template: "Visit" });
    expect(r.text).toMatch(/^Copy \(the batch copy; 1 ad has its own copy, shown in the table\): 1 primary text\(s\), 1 headline\(s\), LEARN_MORE → https:\/\/example\.com\/visit .*· display link sahajta\.com\/visit · description "Plots from 20 lakh"/m);
    expect(rowOf(r.text, 2)).toMatch(/OWN COPY: .*display link sahajta\.com\/ad2, description "Plots from 20 lakh"/);
    const go = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: Number(/(\d+) warning\(s\)\. Show/.exec(r.text)?.[1] ?? 0) });
    expect(go.isError, go.text).toBe(false);
    await runBatch(batchId, deps(accountId));
    expect(getAds(batchId).every((a) => a.status === "done")).toBe(true);
    const ads = await call("list_ads", { adset: "November test ad set" });
    expect(ads.isError, ads.text).toBe(false);
    expect(ads.text).toMatch(/descriptions: "Plots from 20 lakh"\n {2}button: [^\n]+ · file: [^\n]+\n {2}link: https:\/\/example\.com\/visit[^\n]* · display link: sahajta\.com\/visit/);
    expect(ads.text).toMatch(/display link: sahajta\.com\/ad2/);
  }, 120_000);
});

describe("D2 + D3 · WhatsApp, Threads and the branded content partner Page", () => {
  it("save_settings_preset takes 'branding' (Ads Manager's word) as the partner Page; list_templates and preview_batch show all three", async () => {
    const { key } = await batch();
    const call = await claude();
    const s = await call("save_settings_preset", { name: "Brand", page_id: "p1", page_name: "Sahajta AI", instagram_id: "ig1", instagram_username: "sahajta.ai", whatsapp_number: "+919812345678", threads_account_id: "777", branding: "888" });
    expect(s.isError, s.text).toBe(false);
    expect(s.text).toMatch(/Partner Page \(paid partnership\): 888\. \(The partner Page is what Ads Manager calls "Branded content"\.\)/);
    const l = await call("list_templates", {});
    expect(l.text).toMatch(/"Brand" \(id \d+\): .*WhatsApp \+919812345678, Threads account 777, partner Page \(branded content\) 888/);
    const r = await call("preview_batch", { batch_id: key, settings_preset: "Brand" });
    expect(r.text).toMatch(/^Settings preset: Brand \(Facebook Page Sahajta AI, Instagram @sahajta\.ai, WhatsApp number \+919812345678, Threads account 777, branded content partner Page 888, AI enhancements all off, multi-advertiser off\)\.$/m);
    // The other names of the same field, and two different values refused.
    expect((await call("save_settings_preset", { preset: "Brand", branded_content_partner: "999" })).text).toMatch(/Partner Page \(paid partnership\): 999\./);
    const both = await call("save_settings_preset", { preset: "Brand", partner_page_id: "1", branding: "2" });
    expect(both.isError).toBe(true);
    expect(both.text).toMatch(/are the same field/);
  });

  it("the tool descriptions say the partner Page is Ads Manager's 'Branded content'", async () => {
    const server = new McpServer({ name: "r5d", version: "0" });
    registerTools(server, httpApi(BASE, KEY));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "r5d", version: "0" });
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    const preset = tools.find((t) => t.name === "save_settings_preset")!;
    expect(preset.description).toMatch(/Ads Manager calls "Branded content"/);
    expect(Object.keys((preset.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(expect.arrayContaining(["partner_page_id", "branded_content_partner", "branding"]));
  });
});

describe("R1 · Meta limiting calls is never an empty or partial answer", () => {
  it("list_ads on an ad set with 2 ads: 'Meta is limiting…, try again after …', never 'No ads'", async () => {
    await batch();
    mock.objects.set("120200000001", { ...mock.objects.get("as1")!, id: "120200000001", name: "Numeric ad set" });
    for (const id of ["9001", "9002"]) mock.objects.set(id, { _type: "ad", id, name: `Ad ${id}`, adset_id: "120200000001", status: "PAUSED", effective_status: "PAUSED" });
    const call = await claude();
    mock.inject({ match: (m, p) => m === "GET" && p === "120200000001/ads", kind: "error", error: THROTTLE });
    const r = await call("list_ads", { adset: "120200000001" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(LIMITED);
    expect(r.text).not.toMatch(/No ads/);
  });

  it("preview_batch while the summary's reads are limited: says the summary couldn't be loaded, when to try again, and not to launch", async () => {
    const { key } = await batch();
    const call = await claude();
    mock.inject({ match: (m, p) => m === "GET" && p === "c1", kind: "error", error: THROTTLE });
    const r = await call("preview_batch", { batch_id: key, go_live: "now" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/\| 1 \| /);
    expect(r.text).toMatch(new RegExp(`The pre-launch summary couldn't be loaded: ${LIMITED.source}.*Don't launch until preview_batch shows it\\.`));
    expect(r.text).not.toMatch(/PRE-LAUNCH SUMMARY|Show the summary|launch_batch with confirm|No problems found/);
  });

  it("preview_batch while the account health read is limited: the same, never a summary without its health line", async () => {
    const { key } = await batch();
    const call = await claude();
    mock.inject({ match: (m, p) => m === "GET" && p === "act_1001", kind: "error", error: THROTTLE });
    const r = await call("preview_batch", { batch_id: key });
    expect(r.text).toMatch(/The pre-launch summary couldn't be loaded: Meta is limiting/);
    expect(r.text).not.toMatch(/PRE-LAUNCH SUMMARY/);
  });

  it("ad_previews when Meta limits the preview calls: one plain answer with the time, never six 'not available'", async () => {
    const { key, batchId } = await batch();
    const call = await claude();
    const img = getAds(batchId).find((a) => a.creative_name.startsWith("static-price"))!.position;
    mock.inject({ match: (m, p) => p.endsWith("/generatepreviews"), kind: "error", error: THROTTLE });
    const r = await call("ad_previews", { batch_id: key, ad: img });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(LIMITED);
    expect(r.text).not.toMatch(/not available/);
  });

  it("every other read tool says Meta is limiting calls (with the time), never 'nothing found'", async () => {
    const { key, batchId, accountId } = await batch();
    const call = await claude();
    const pv = await call("preview_batch", { batch_id: key });
    await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: Number(/(\d+) warning\(s\)\. Show/.exec(pv.text)?.[1] ?? 0) });
    await runBatch(batchId, deps(accountId));
    for (let i = 0; i < 300; i++) mock.inject({ match: () => true, kind: "error", error: THROTTLE });
    const tools: [string, Record<string, unknown>][] = [
      ["list_ads", { adset: "November test ad set" }],
      ["list_campaigns", {}],
      ["list_destinations", { refresh: true }],
      ["delivery_status", { batch_id: key }],
      ["delivery_status", { campaign: "c1" }],
      ["get_details", { kind: "adset", id: "as1" }],
      ["get_results", { level: "campaign", date_preset: "last_7d" }],
      ...(["saved_audiences", "custom_audiences", "pixels", "custom_conversions", "block_lists", "pages", "posts", "lead_forms"] as const).map((w) => ["lookup", { what: w }] as [string, Record<string, unknown>]),
      ["lookup", { what: "interests", q: "real estate" }],
    ];
    for (const [name, args] of tools) {
      const r = await call(name, args);
      expect(r.text, `${name} ${JSON.stringify(args)}`).toMatch(/Meta is limiting how often the launcher may call this ad account/);
      expect(r.isError, `${name} ${JSON.stringify(args)}: ${r.text}`).toBe(true);
      expect(r.text, name).not.toMatch(/^(No |Nothing found)/);
    }
  }, 120_000);

  it("with nothing read before: connection_status and list_instagram_accounts say Meta is limiting calls (read from the last 30 minutes, they answer from that)", async () => {
    await batch();
    const call = await claude();
    for (let i = 0; i < 50; i++) mock.inject({ match: () => true, kind: "error", error: THROTTLE });
    for (const name of ["connection_status", "list_instagram_accounts"]) {
      const r = await call(name, {});
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(LIMITED);
    }
  });
});
