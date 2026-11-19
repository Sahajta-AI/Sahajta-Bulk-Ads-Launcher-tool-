import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { MockMeta, FakeClock } from "@/lib/meta/mock";
import { clientFor } from "@/lib/meta/factory";
import { getPlan, runPlan } from "@/lib/manage/plan";
import { adState, changedCreative } from "@/lib/manage/ads";
import { spendLimitsText } from "@/lib/manage/objects";
import { upsertAccount } from "@/lib/setup";
import { STEP_TYPES, stepFieldsText } from "@/mcp/manage-tools";
import { httpApi, registerTools } from "@/mcp/tools";
import { freshDb } from "./helpers";

// Round 4 (the marketer's test of the Claude tools, 19 Nov):
//   1. plan_changes names every step's fields exactly; plan_step_fields gives one step's fields
//      (create_custom_audience was refused four times: "days must be 1 to 365 for this kind of audience").
//   2. list_ads shows on/off and Meta's review state apart ("paused · in review"), the description
//      and the display link, from the one list read it already makes.
//   3. get_details and list_campaigns show an ad set's minimum and maximum spend in plain words.
// The real tool code runs against the practice Meta (mock), through the launcher's own routes.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
process.env.ALLOWED_EMAILS = "test@example.com";
const BASE = "http://launcher.test";
const KEY = "sal_r4_tools_key_0123456789";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let mock: MockMeta;
let clock: FakeClock;

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

const realFetch = globalThis.fetch;
beforeAll(() => {
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
    const s = url instanceof Request ? url.url : String(url);
    if (s.startsWith(BASE)) return dispatch(new Request(s, init));
    return realFetch(url, init);
  });
});

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 90000, richAccount: true, allowActive: true });
  g.__mockMeta = mock;
  upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run("test@example.com", "r4", sha256(KEY), KEY.slice(-4));
});

async function claude() {
  const server = new McpServer({ name: "r4", version: "0" });
  registerTools(server, httpApi(BASE, KEY));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "r4", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { call, client };
}

const planKey = (text: string) => /^Plan (\w+):/m.exec(text)?.[1] ?? "";

/** The field names plan_step_fields lists for a step ("- name: …" lines, without type and ref). */
function documented(type: string): string[] {
  return [...stepFieldsText(type as never).matchAll(/^- (\w+): /gm)].map((m) => m[1]).filter((k) => k !== "type" && k !== "ref");
}

/** A value of the right kind for each field, so a step with every field reaches the field check. */
const SAMPLE: Record<string, unknown> = {
  name: "TEST r4", name_template: "{date}_{n}", objective: "OUTCOME_LEADS", budget_level: "adset", daily_budget: 500, lifetime_budget: 5000, bid_strategy: "LOWEST_COST_WITHOUT_CAP",
  special_ad_categories: [], special_ad_category_country: ["IN"], spend_cap: 10000, start_time: "2026-12-01T09:00", stop_time: "2026-12-10T09:00", end_time: "2026-12-10T09:00",
  status: "PAUSED", persona: "p", angle: "a", budget_schedules: [], campaign: "c1", adset: "as1", ad: "ad_link", copies: 1, changes: [{ name: "copy" }], with_contents: false, with_ads: false,
  destination: "ON_AD", goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS", bid_amount: 10, roas_average_floor: 2, pixel_id: "px1", event: "LEAD", custom_event_str: "x", custom_conversion_id: "1",
  page_id: "p1", app_id: "1", app_store_url: "https://example.com/app", whatsapp_number: "+919812345678", saved_audience_id: "1", countries: ["IN"], regions: [], cities: [], age_min: 25, age_max: 45,
  genders: "all", interests: [], custom_audiences: [], excluded_custom_audiences: [], advantage_audience: false, placements: "advantage", targeting: {}, attribution: "7d_click_1d_view",
  min_daily_spend: 100, max_daily_spend: 900, schedule: [], frequency_cap: { impressions: 2, days: 7 }, inventory_filter: "moderate", block_list_ids: [], languages: [], targeting_expansion: true,
  dynamic_creative: false, replace_targeting: {}, primary_texts: ["T"], headlines: ["H"], description: "D", link_url: "https://example.com", cta: "LEARN_MORE", display_link: "sahajta.com",
  url_tags: "utm_source=meta", media_url: "https://drive.google.com/file/d/x/view", creative_id: "1", post_id: "p1_123", source: "facebook", adsets: ["as1"], instagram_user_id: "ig1",
  campaigns: [], ads: [], whole_campaigns: [], source_audience: "123", country: "IN", size_percent: 1,
};
const AUDIENCE_SOURCE = { kind: "website", pixel_id: "px1", days: 30 };

/** An ad (with its creative) put straight into the practice Meta, in ad set as1. */
function addAd(id: string, creative: Record<string, unknown>, status = "PAUSED", effective = "PAUSED") {
  mock.objects.set(`cr_${id}`, { id: `cr_${id}`, _type: "creative", name: `cr ${id} [L:r4]`, ...creative } as never);
  mock.objects.set(id, { id, _type: "ad", name: `Ad ${id}`, adset_id: "as1", creative_id: `cr_${id}`, status, effective_status: effective } as never);
}
const cta = (link: string, extra: Record<string, unknown> = {}) => ({ type: "LEARN_MORE", value: { link, ...extra } });
const LINK_AD = { object_story_spec: { page_id: "p1", link_data: { message: "Text A", name: "Head A", description: "Desc A", caption: "sahajta.com/a", link: "https://example.com/a", image_hash: "h1", call_to_action: cta("https://example.com/a") } } };
const VIDEO_AD = { object_story_spec: { page_id: "p1", video_data: { video_id: "v1", message: "Text V", title: "Head V", link_description: "Desc V", call_to_action: cta("https://example.com/v", { link_caption: "sahajta.com/v" }) } } };
const FEED_AD = { object_story_spec: { page_id: "p1" }, asset_feed_spec: { bodies: [{ text: "Body F" }], titles: [{ text: "Title F" }], descriptions: [{ text: "Desc F" }], link_urls: [{ website_url: "https://example.com/f", display_url: "sahajta.com/f" }], call_to_action_types: ["LEARN_MORE"] } };
const CAROUSEL_AD = { object_story_spec: { page_id: "p1", link_data: { message: "Text C", caption: "sahajta.com/c", link: "https://example.com/c", call_to_action: cta("https://example.com/c"), child_attachments: [{ name: "Card 1", description: "Desc C", link: "https://example.com/c", image_hash: "h1", call_to_action: cta("https://example.com/c") }, { name: "Card 2", description: "Desc C", link: "https://example.com/c", image_hash: "h2", call_to_action: cta("https://example.com/c") }] } } };
/** One ad's lines in list_ads' answer. */
const adBlock = (text: string, id: string) => text.split("\n- ").find((x) => x.includes(`(id ${id})`)) ?? "";

// ---------------------------------------------------------------------------------------------

describe("1 · plan_changes and plan_step_fields name every field exactly", () => {
  it("the step types are the plan engine's own, and the description names every one with every field", async () => {
    const { call, client } = await claude();
    // The engine lists its step types when a type is unknown.
    const r = await call("plan_changes", { ops: [{ type: "no_such_step" }] });
    const engine = /Use ([a-z_, ]+)\. Deleting/.exec(r.text)?.[1].split(", ") ?? [];
    expect(engine.length).toBeGreaterThan(10);
    expect([...STEP_TYPES].sort()).toEqual([...engine].sort());
    const desc = (await client.listTools()).tools.find((t) => t.name === "plan_changes")!.description!;
    for (const type of STEP_TYPES) {
      expect(desc, type).toMatch(new RegExp(`^- ${type}: `, "m"));
      for (const f of documented(type)) expect(desc, `${type}.${f}`).toMatch(new RegExp(`\\b${f}\\b`));
    }
    // The audience step that was refused four times: its source fields, with the right field name for days.
    expect(desc).toMatch(/website \{pixel_id, days \(1–180\), url_contains\?, event\?\}/);
    expect(desc).toMatch(/lead_form \{page_id, days \(1–90\), action\?\}/);
    expect(desc).toMatch(/The number of days is always "days"/);
    expect(desc).toMatch(/plan_step_fields/);
    // A sensible size for Claude Desktop's tool help.
    expect(desc.length).toBeLessThan(8000);
  });

  it("every field plan_step_fields lists is one the plan engine takes (no 'unknown field' for any step type)", async () => {
    addAd("ad_link", LINK_AD);
    const { call } = await claude();
    for (const type of STEP_TYPES) {
      const fields = documented(type);
      expect(fields.length, type).toBeGreaterThan(0);
      const op: Record<string, unknown> = { type, ref: "r1" };
      for (const f of fields) {
        expect(f in SAMPLE || f === "source", `no sample value for ${type}.${f}`).toBe(true);
        op[f] = SAMPLE[f];
      }
      if (type === "create_custom_audience") op.source = AUDIENCE_SOURCE;
      if (type === "ads_from_post") op.source = "facebook";
      // The fields the launcher fills in itself are taken too.
      if (type === "edit_adset" || type === "create_adset") op.replace_targeting = {};
      if (type === "edit_ad") op.creative_id = "1";
      const p = await call("plan_changes", { ops: [op] });
      // The plan was checked (saved with its summary), so the field check ran.
      expect(p.isError, `${type}: ${p.text.slice(0, 300)}`).toBe(false);
      expect(planKey(p.text), type).not.toBe("");
      expect(p.text, `${type}: ${p.text.slice(0, 600)}`).not.toMatch(/unknown field/);
      expect(p.text, type).not.toMatch(/unknown step type/);
    }
    // And a field it doesn't list is refused, by name, with the pointer to plan_step_fields.
    const bad = await call("plan_changes", { ops: [{ type: "create_custom_audience", name: "x", source: AUDIENCE_SOURCE, retention_days: 30 }] });
    expect(bad.text).toMatch(/unknown field "retention_days"/);
    expect(bad.text).toMatch(/plan_step_fields \(with the step's type\) lists the exact fields/);
  });

  it("the marketer's audience: plan_step_fields gives the fields, and its example (with a real pixel) is taken without errors", async () => {
    const { call } = await claude();
    const f = await call("plan_step_fields", { type: "create_custom_audience" });
    expect(f.isError).toBe(false);
    expect(f.text).toMatch(/^- source: object, required/m);
    expect(f.text).toMatch(/\{"kind": "website", "pixel_id", "days", "url_contains", "event"\}/);
    expect(f.text).toMatch(/days: whole number 1 to 180, required/);
    expect(f.text).toMatch(/the number of days is always "days"/);
    const example = JSON.parse(/^Example: (.*)$/m.exec(f.text)![1]) as { source: Record<string, unknown> };
    expect(example.source).toEqual({ kind: "website", pixel_id: "<pixel ID>", days: 30 });
    const p = await call("plan_changes", { ops: [{ ...example, source: { ...example.source, pixel_id: "px1" } }] });
    expect(p.text).toMatch(/Create audience "Website visitors 30 days"/);
    expect(p.text).toMatch(/People who visited the website with pixel px1 in the last 30 days/);
    expect(p.text).not.toMatch(/ERROR/);
  });

  it("the names the marketer's Claude tried for days: each answer names the wrong field and the right one (days)", async () => {
    const { call } = await claude();
    for (const wrong of ["retention_days", "lookback_days", "window_days", "retention"]) {
      const p = await call("plan_changes", { ops: [{ type: "create_custom_audience", name: "TEST site 30d", source: { kind: "website", pixel_id: "px1", [wrong]: 30 } }] });
      expect(p.text, wrong).toMatch(new RegExp(`"${wrong}"`));
      expect(p.text, wrong).toMatch(/\bdays\b/);
      expect(p.text, wrong).not.toMatch(/for this kind of audience/);
    }
  });

  it("the day limits plan_step_fields gives for each audience source are the engine's own", async () => {
    const { call } = await claude();
    const limits: Record<string, [number, Record<string, unknown>]> = {
      website: [180, { pixel_id: "px1" }],
      video: [365, { video_ids: ["777001"] }],
      page: [365, { page_id: "p1" }],
      instagram: [365, { instagram_id: "ig1" }],
      lead_form: [90, { page_id: "p1" }],
    };
    const fields = (await call("plan_step_fields", { type: "create_custom_audience" })).text;
    for (const [kind, [max, rest]] of Object.entries(limits)) {
      const block = fields.split(`{"kind": "${kind}"`)[1] ?? "";
      expect(block, kind).toMatch(new RegExp(`days: whole number 1 to ${max}, required`));
      const ok = await call("plan_changes", { ops: [{ type: "create_custom_audience", name: `TEST ${kind}`, source: { kind, days: max, ...rest } }] });
      expect(ok.text, `${kind} ${max} days`).not.toMatch(/days must be|days is missing/);
      const over = await call("plan_changes", { ops: [{ type: "create_custom_audience", name: `TEST ${kind}`, source: { kind, days: max + 1, ...rest } }] });
      // Any wording that names days and the range ("days must be 1 to 180", "source.days must be … from 1 to 180").
      expect(over.text, `${kind} ${max + 1} days`).toMatch(new RegExp(`days must be [^\\n]*\\b1 to ${max}\\b`));
    }
  });

  it("plan_step_fields: every step type, with exact names and allowed values; without a type, the list of types; reads nothing in Meta", async () => {
    const { call } = await claude();
    const before = mock.calls.length;
    const all = await call("plan_step_fields", {});
    for (const t of STEP_TYPES) expect(all.text).toMatch(new RegExp(`^- ${t}: `, "m"));
    const lal = await call("plan_step_fields", { type: "create_lookalike" });
    expect(lal.text).toMatch(/^- source_audience: /m);
    expect(lal.text).toMatch(/^- size_percent: number 1 to 10/m);
    expect(lal.text).toMatch(/^- country: /m);
    const edit = await call("plan_step_fields", { type: "edit_ad" });
    for (const f of ["ad", "name", "status", "primary_texts", "headlines", "description", "link_url", "cta", "display_link", "url_tags", "media_url"]) expect(edit.text, f).toMatch(new RegExp(`^- ${f}: `, "m"));
    expect(edit.text).toMatch(/LEARN_MORE, SHOP_NOW, SIGN_UP/);
    expect(edit.text).toMatch(/Filled in by the launcher, leave out: creative_id/);
    const copy = await call("plan_step_fields", { type: "copy_ad" });
    expect(copy.text).toMatch(/^- adsets: list/m);
    const adset = await call("plan_step_fields", { type: "create_adset" });
    expect(adset.text).toMatch(/^- goal: .*LEAD_GENERATION, QUALITY_LEAD, OFFSITE_CONVERSIONS/m);
    expect(adset.text).toMatch(/^- min_daily_spend: number: rupees a day/m);
    const wrong = await call("plan_step_fields", { type: "create_audience" });
    expect(wrong.isError).toBe(true);
    expect(mock.calls.length).toBe(before);
  });
});

describe("2 · list_ads: on/off and Meta's review apart, description and display link", () => {
  it("shows 'paused · in review' and the other states, from the one list read (no read per ad)", async () => {
    addAd("ad_review", LINK_AD, "PAUSED", "PENDING_REVIEW");
    addAd("ad_process", LINK_AD, "PAUSED", "IN_PROCESS");
    addAd("ad_on", LINK_AD, "ACTIVE", "ACTIVE");
    addAd("ad_rejected", LINK_AD, "PAUSED", "DISAPPROVED");
    addAd("ad_setoff", LINK_AD, "ACTIVE", "ADSET_PAUSED");
    addAd("ad_paused", LINK_AD, "PAUSED", "PAUSED");
    const { call } = await claude();
    const before = mock.calls.length;
    const r = await call("list_ads", { adset: "as1" });
    expect(r.isError, r.text).toBe(false);
    expect(adBlock(r.text, "ad_review")).toMatch(/^"Ad ad_review" \(id ad_review\) · paused · in review · /);
    expect(adBlock(r.text, "ad_process")).toMatch(/· paused · in review \(Meta is processing the change\) · /);
    expect(adBlock(r.text, "ad_on")).toMatch(/· on · approved · /);
    expect(adBlock(r.text, "ad_rejected")).toMatch(/· paused · rejected by Meta · /);
    expect(adBlock(r.text, "ad_setoff")).toMatch(/· on · not delivering: its ad set is off · /);
    expect(adBlock(r.text, "ad_paused")).toMatch(/· paused · no review pending · /);
    expect(r.text).not.toMatch(/in_process|pending_review/);
    // Meta calls: the ad set's ads in one list read (the ad set "as1" is read on the campaign list); never one read per ad.
    const made = mock.calls.slice(before);
    expect(made.filter((c) => c.path === "as1/ads")).toHaveLength(1);
    expect(made.filter((c) => /^(ad_|cr_)/.test(c.path))).toHaveLength(0);
  });

  it("shows the description and display link of link, video, text-option and carousel ads", async () => {
    addAd("ad_link", LINK_AD);
    addAd("ad_video", VIDEO_AD);
    addAd("ad_feed", FEED_AD);
    addAd("ad_carousel", CAROUSEL_AD);
    const { call } = await claude();
    const r = await call("list_ads", { adset: "November test ad set" });
    expect(adBlock(r.text, "ad_link")).toMatch(/description: "Desc A"\n {2}link: https:\/\/example.com\/a · display link: sahajta.com\/a/);
    expect(adBlock(r.text, "ad_video")).toMatch(/description: "Desc V"\n {2}link: https:\/\/example.com\/v · display link: sahajta.com\/v/);
    expect(adBlock(r.text, "ad_feed")).toMatch(/headlines: Title F · description: "Desc F"\n {2}link: https:\/\/example.com\/f · display link: sahajta.com\/f/);
    expect(adBlock(r.text, "ad_carousel")).toMatch(/headlines: Card 1 \| Card 2 · description: "Desc C"\n {2}link: https:\/\/example.com\/c · display link: sahajta.com\/c/);
    expect(r.text).not.toMatch(/undefined|null/);
  });

  it("after edit_ad, list_ads shows the new description and display link, and that the ad is still paused", async () => {
    addAd("ad_link", LINK_AD, "PAUSED", "PAUSED");
    const { call } = await claude();
    const p = await call("plan_changes", { ops: [{ type: "edit_ad", ad: "ad_link", description: "New description", display_link: "sahajta.com/new" }] });
    expect(p.text).toMatch(/description → "New description"; display link → sahajta.com\/new/);
    const key = planKey(p.text);
    const c = await call("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true });
    expect(c.isError, c.text).toBe(false);
    expect(await runPlan(getPlan(key).id, { client: clientFor(), clock })).toEqual({ done: 1, failed: 0 });
    // Meta reviews the new creative again.
    mock.objects.get("ad_link")!.effective_status = "IN_PROCESS";
    const r = await call("list_ads", { adset: "as1" });
    const line = adBlock(r.text, "ad_link");
    expect(line).toMatch(/· paused · in review \(Meta is processing the change\) · /);
    expect(line).toMatch(/description: "New description"/);
    expect(line).toMatch(/display link: sahajta.com\/new/);
  });

  it("an edit puts the description and display link where the ad shows them: a video's button, a carousel's cards", () => {
    const video = changedCreative({ id: "c", ...(VIDEO_AD as Record<string, unknown>) } as never, { display_link: "sahajta.com/new", description: "New" }) as { object_story_spec: { video_data: { link_description: string; call_to_action: { type: string; value: Record<string, unknown> } } } };
    expect(video.object_story_spec.video_data.link_description).toBe("New");
    expect(video.object_story_spec.video_data.call_to_action).toEqual({ type: "LEARN_MORE", value: { link: "https://example.com/v", link_caption: "sahajta.com/new" } });
    const cleared = changedCreative({ id: "c", ...(VIDEO_AD as Record<string, unknown>) } as never, { display_link: "" }) as { object_story_spec: { video_data: { call_to_action: { value: Record<string, unknown> } } } };
    expect(cleared.object_story_spec.video_data.call_to_action.value).toEqual({ link: "https://example.com/v" });
    const car = changedCreative({ id: "c", ...(CAROUSEL_AD as Record<string, unknown>) } as never, { description: "New desc", headlines: ["H1", "H2"], link_url: "https://example.com/new" }) as { object_story_spec: { link_data: Record<string, unknown> & { child_attachments: Record<string, unknown>[] } } };
    const ld = car.object_story_spec.link_data;
    expect(ld.child_attachments.map((x) => [x.name, x.description, x.link])).toEqual([["H1", "New desc", "https://example.com/new"], ["H2", "New desc", "https://example.com/new"]]);
    expect(ld.child_attachments[0].call_to_action).toEqual(cta("https://example.com/new"));
    expect(ld.name).toBeUndefined();
    expect(ld.description).toBeUndefined();
    expect(ld.link).toBe("https://example.com/new");
  });

  it("adState: the ad's own setting and Meta's state, in plain words", () => {
    expect(adState("PAUSED", "IN_PROCESS")).toEqual({ onOff: "paused", review: "in review (Meta is processing the change)" });
    expect(adState("PAUSED", "PENDING_REVIEW")).toEqual({ onOff: "paused", review: "in review" });
    expect(adState("ACTIVE", "CAMPAIGN_PAUSED")).toEqual({ onOff: "on", review: "not delivering: its campaign is off" });
    expect(adState("ACTIVE", undefined)).toEqual({ onOff: "on", review: "approved" });
  });
});

describe("3 · get_details and list_campaigns: an ad set's minimum and maximum spend in plain words", () => {
  it("in the ad account's currency, daily and lifetime; 'none' when there are none", async () => {
    // as4 has a minimum of ₹700 a day (70000 paise); give it a maximum too.
    mock.objects.get("as4")!.daily_spend_cap = "150000";
    const { call } = await claude();
    const d = await call("get_details", { kind: "adset", id: "as4" });
    expect(d.text).toMatch(/^spendLimits: minimum ₹700 a day, maximum ₹1,500 a day$/m);
    const none = await call("get_details", { kind: "adset", id: "as1" });
    expect(none.text).toMatch(/^spendLimits: none \(no minimum or maximum spend\)$/m);
    const l = await call("list_campaigns", { campaign: "November tests" });
    const as4 = l.text.split("\n").find((x) => x.includes("(id as4)")) ?? "";
    expect(as4).toMatch(/· ₹800 a day · spend limits: minimum ₹700 a day, maximum ₹1,500 a day · /);
    const as1 = l.text.split("\n").find((x) => x.includes("(id as1)")) ?? "";
    expect(as1).not.toMatch(/spend limits/);
    // Lifetime limits, and only one side set.
    mock.objects.get("as1")!.lifetime_min_spend_target = "500000";
    const life = await call("get_details", { kind: "adset", id: "as1" });
    expect(life.text).toMatch(/^spendLimits: minimum ₹5,000 lifetime, no maximum$/m);
  });

  it("spendLimitsText: the account's currency, both kinds, zero means none", () => {
    expect(spendLimitsText({ daily_min_spend_target: "10000", daily_spend_cap: "50000" }, "INR")).toBe("minimum ₹100 a day, maximum ₹500 a day");
    expect(spendLimitsText({ daily_spend_cap: "2500" }, "USD")).toBe("no minimum, maximum USD 25 a day");
    expect(spendLimitsText({ lifetime_min_spend_target: "1000", lifetime_spend_cap: "9000" }, "JPY")).toBe("minimum JPY 1,000 lifetime, maximum JPY 9,000 lifetime");
    expect(spendLimitsText({ daily_min_spend_target: "0", daily_spend_cap: "0" }, "INR")).toBe("");
  });
});
