import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { runBatch } from "@/lib/engine/launcher";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { localFiles } from "@/lib/sources/local";
import { getPlan, runPlan } from "@/lib/manage/plan";
import { queueGoLive } from "@/lib/manage/golive";
import { getAds, getBatch } from "@/lib/store";
import { httpApi, registerTools } from "@/mcp/tools";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Audit: the marketer's retest of the tracker rows, replayed through Claude's own tools.
// The tools run against the app's real HTTP route handlers (src/app/api/**/route.ts), called in-process
// with a Claude API key, so every answer goes through route() and httpApi exactly as in production.
// Meta is the fake Graph API (src/lib/meta/mock.ts). Nothing here calls the network.

// Google sign-in is not part of this test: Claude calls with an API key (caller() checks it before auth()).
vi.mock("@/auth", () => ({ auth: async () => null }));

process.env.META_MOCK = "1";
const WHO = "shubhang@example.com";
process.env.ALLOWED_EMAILS = WHO;
process.env.APP_URL = "https://launcher.test";
const BASE = "http://launcher.internal";
const API_KEY = "sal_audit_journey_key";
const g = globalThis as unknown as { __mockMeta?: MockMeta };

let folder: string;
let clock: FakeClock;
let mock: MockMeta;
/** Every request the app sent to the fake Meta, with its parsed body. */
let sent: { method: string; path: string; params: Record<string, unknown> }[] = [];
const LOG = path.join(os.tmpdir(), "audit-journey-output.txt");

// ---------- The app's HTTP API, in-process ----------

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Mod = Record<string, Handler | unknown>;
const ROUTES: [RegExp, string[], () => Promise<Mod>][] = [
  [/^\/api\/connection$/, [], () => import("@/app/api/connection/route")],
  [/^\/api\/templates$/, [], () => import("@/app/api/templates/route")],
  [/^\/api\/destinations$/, [], () => import("@/app/api/destinations/route")],
  [/^\/api\/alerts$/, [], () => import("@/app/api/alerts/route")],
  [/^\/api\/settings$/, [], () => import("@/app/api/settings/route")],
  [/^\/api\/batches$/, [], () => import("@/app/api/batches/route")],
  [/^\/api\/batches\/([^/]+)$/, ["key"], () => import("@/app/api/batches/[key]/route")],
  [/^\/api\/batches\/([^/]+)\/preview$/, ["key"], () => import("@/app/api/batches/[key]/preview/route")],
  [/^\/api\/batches\/([^/]+)\/previews$/, ["key"], () => import("@/app/api/batches/[key]/previews/route")],
  [/^\/api\/batches\/([^/]+)\/summary$/, ["key"], () => import("@/app/api/batches/[key]/summary/route")],
  [/^\/api\/batches\/([^/]+)\/launch$/, ["key"], () => import("@/app/api/batches/[key]/launch/route")],
  [/^\/api\/batches\/([^/]+)\/copy$/, ["key"], () => import("@/app/api/batches/[key]/copy/route")],
  [/^\/api\/batches\/([^/]+)\/regroup$/, ["key"], () => import("@/app/api/batches/[key]/regroup/route")],
  [/^\/api\/batches\/([^/]+)\/retry$/, ["key"], () => import("@/app/api/batches/[key]/retry/route")],
  [/^\/api\/batches\/([^/]+)\/cancel$/, ["key"], () => import("@/app/api/batches/[key]/cancel/route")],
  [/^\/api\/batches\/([^/]+)\/delivery$/, ["key"], () => import("@/app/api/batches/[key]/delivery/route")],
  // Routes of the tools added on 19 Nov (refresh_review, remove_file, list_instagram_accounts).
  [/^\/api\/batches\/([^/]+)\/review$/, ["key"], () => import("@/app/api/batches/[key]/review/route")],
  [/^\/api\/batches\/([^/]+)\/move$/, ["key"], () => import("@/app/api/batches/[key]/move/route")],
  [/^\/api\/identities$/, [], () => import("@/app/api/identities/route")],
  [/^\/api\/manage\/tree$/, [], () => import("@/app/api/manage/tree/route")],
  [/^\/api\/manage\/ads$/, [], () => import("@/app/api/manage/ads/route")],
  [/^\/api\/manage\/delivery$/, [], () => import("@/app/api/manage/delivery/route")],
  [/^\/api\/manage\/lookup$/, [], () => import("@/app/api/manage/lookup/route")],
  [/^\/api\/manage\/options$/, [], () => import("@/app/api/manage/options/route")],
  [/^\/api\/manage\/object\/([^/]+)\/([^/]+)$/, ["kind", "id"], () => import("@/app/api/manage/object/[kind]/[id]/route")],
  [/^\/api\/plans$/, [], () => import("@/app/api/plans/route")],
  [/^\/api\/plans\/([^/]+)\/([^/]+)$/, ["key", "action"], () => import("@/app/api/plans/[key]/[action]/route")],
  [/^\/api\/results$/, [], () => import("@/app/api/results/route")],
];

async function dispatch(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url);
  for (const [re, names, load] of ROUTES) {
    const m = re.exec(u.pathname);
    if (!m) continue;
    const mod = await load();
    const method = (init?.method ?? "GET").toUpperCase();
    const h = mod[method] as Handler | undefined;
    if (!h) return Response.json({ error: `No ${method} on ${u.pathname}` }, { status: 405 });
    const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    return h(new Request(url, init), { params: Promise.resolve(params) });
  }
  return Response.json({ error: `No route ${u.pathname}` }, { status: 404 });
}

// ---------- Claude's tools, as Claude Desktop calls them ----------

let mcp: Client;
let toolNames: string[] = [];
async function tool(name: string, args: Record<string, unknown> = {}) {
  const t0 = Date.now();
  const r = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = r.content.map((c) => c.text).join("\n");
  fs.appendFileSync(LOG, `\n===== ${expect.getState().currentTestName} :: ${name} ${JSON.stringify(args).slice(0, 400)}\n${r.isError ? "[isError] " : ""}${text}\n`);
  return { text, isError: !!r.isError, ms: Date.now() - t0 };
}

/** What a marketer must never read in a tool answer. */
function readable(text: string) {
  expect(text).not.toContain("[object Object]");
  expect(text).not.toMatch(/\n\s+at .+\(.+:\d+:\d+\)/); // stack trace
  expect(text).not.toMatch(/undefined|NaN/);
}

beforeAll(async () => {
  folder = await fifteenFileFolder();
  fs.writeFileSync(LOG, "");
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(BASE)) return dispatch(url, init);
    if (url.startsWith("https://example.com")) return new Response("<html>ok</html>", { status: 200 });
    if (url.startsWith("https://down.example.org")) return new Response("Not found", { status: 404 });
    throw new TypeError(`network blocked in this test: ${url}`);
  });
  const server = new McpServer({ name: "audit", version: "0" });
  registerTools(server, httpApi(BASE, API_KEY));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  mcp = new Client({ name: "audit", version: "0" });
  await mcp.connect(b);
  toolNames = (await mcp.listTools()).tools.map((t) => t.name);
}, 120_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

function freshMeta(opts: Partial<ConstructorParameters<typeof MockMeta>[0]> = {}) {
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000, ...opts });
  const orig = mock.fetch;
  sent = [];
  mock.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const p = url.pathname.replace(/^\/v\d+\.\d+\/?/, "");
    if (method !== "GET" && typeof init?.body === "string") {
      const params: Record<string, unknown> = {};
      for (const [k, v] of new URLSearchParams(init.body)) {
        try {
          params[k] = /^[[{]/.test(v) ? JSON.parse(v) : v;
        } catch {
          params[k] = v;
        }
      }
      sent.push({ method, path: p, params });
      // Meta's budget scheduling edge (the fake Meta has no route for it).
      if (p.endsWith("/budget_schedules")) return Response.json({ id: `bs${sent.length}` });
    }
    if (method === "GET" && url.searchParams.get("metadata") === "1") {
      const res = await orig(input, init);
      const body = (await res.clone().json().catch(() => null)) as Record<string, unknown> | null;
      const o = mock.objects.get(p);
      if (body && !body.error && o) return new Response(JSON.stringify({ ...body, metadata: { type: o._type === "ad" ? "adgroup" : o._type } }), { status: res.status, headers: res.headers });
      return res;
    }
    return orig(input, init);
  };
  g.__mockMeta = mock;
}

beforeEach(() => {
  freshDb();
  freshMeta();
  // A rate block learned in one test must not leak into the next. Since 19 Nov the pacer's only state is
  // the rate_state row (shared by the web app and the worker), so it is cleared there, not in pacerFor().state.
  db().prepare("DELETE FROM rate_state").run();
});

/** The connected ad account and Claude's API key (Settings → Claude connection). */
async function connected() {
  const { accountId, batchId } = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1, meta_user_name = 'Marketer' WHERE id = ?").run(accountId);
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, 'Claude', ?, 'test')").run(WHO, sha256(API_KEY));
  return { accountId, batchId, key: getBatch(batchId)!.key };
}

function deps(accountId: number) {
  return { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "audit-")) };
}

/** The worker running a confirmed plan. */
async function workerRunsPlan(planKey: string) {
  return runPlan(getPlan(planKey).id, { client: clientFor(), clock });
}

const planKeyIn = (text: string) => /Plan (p[a-z0-9]{4})/.exec(text)?.[1] ?? "";


const adNo = (batchId: number, creative: string) => getAds(batchId).find((a) => a.creative_name.toLowerCase().includes(creative.toLowerCase()))!.position;
const inDays = (d: number, hhmm = "09:00") => {
  const t = new Date(Date.now() + d * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
  return `${t}T${hhmm}:00+05:30`;
};
const sentTo = (re: RegExp) => sent.filter((s) => re.test(s.path));

async function preparedAccount() {
  const c = await connected();
  db().prepare("UPDATE settings_presets SET page_id = 'p1', page_name = 'Sahajta AI', ig_user_id = 'ig1', ig_name = 'sahajta.ai'").run();
  // The practice account's as1, as3 and as4 collect leads with an Instant form: since 19 Nov (B13) a launch
  // there without a lead form is refused before anything is made, as Meta would refuse every ad.
  db().prepare("UPDATE batches SET copy = ? WHERE id = ?").run(JSON.stringify(LEAD_COPY), c.batchId);
  return c;
}

/** Another batch of the same folder, with a lead form in its copy (see preparedAccount). */
async function leadBatch() {
  const r = await setupBatch(folder);
  db().prepare("UPDATE batches SET copy = ? WHERE id = ?").run(JSON.stringify(LEAD_COPY), r.batchId);
  return { ...r, key: getBatch(r.batchId)!.key };
}

// ======================================================================================
// Row 1: bulk operations in one plan
// ======================================================================================

describe("Row 1 · bulk: one plan makes a campaign, an ad set, 15 copies, edits some, turns it on", () => {
  const budgets = [500, 550, 600, 650, 700, 750, 800, 850, 900, 1000, 1100, 1200, 1300, 1400, 1500];
  const changes = budgets.map((b, i) => ({
    name: `TEST AS ${String(i + 1).padStart(2, "0")}`,
    daily_budget: b,
    ...(i % 5 === 2 ? { bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount: 40 + i } : {}),
    ...(i % 5 === 3 ? { bid_strategy: "COST_CAP", bid_amount: 120 } : {}),
    ...(i % 3 === 0 ? { age_min: 25, age_max: 40, genders: "women" } : i % 3 === 1 ? { interests: [{ id: "6003", name: "Real estate" }] } : { countries: ["IN"], cities: [{ key: "1234", name: "Pune", radius: 25 }] }),
  }));
  const ops = [
    { type: "create_campaign", ref: "c", name: "TEST Bulk 18 Nov", objective: "OUTCOME_LEADS", budget_level: "adset" },
    { type: "create_adset", ref: "base", campaign: "$c", name: "TEST Base", daily_budget: 500, destination: "ON_AD", goal: "LEAD_GENERATION", page_id: "p1", countries: ["IN"], age_min: 25, age_max: 55 },
    { type: "duplicate_adset", ref: "copies", adset: "$base", changes },
    { type: "edit_adset", adset: "$copies.3", daily_budget: 950 },
    { type: "edit_adset", adset: "$copies.7", name: "TEST AS 07 renamed", age_max: 45 },
    { type: "set_status", status: "ACTIVE", whole_campaigns: ["$c"] },
  ];
  // 13,800 for the 15 copies, copy 3 raised from 600 to 950, plus the base ad set's 500.
  const TOTAL = "₹14,650";

  it("plan_changes → plan_status → confirm_plan with the typed total → run → plan_status → undo_plan", async () => {
    await preparedAccount();
    const p = await tool("plan_changes", { title: "TEST bulk 15 copies", expected_daily_total: 14650, ops });
    expect(p.isError).toBe(false);
    readable(p.text);
    const key = planKeyIn(p.text);
    expect(key).toBeTruthy();
    // Every ad set once, at its final budget, and the total he planned.
    expect.soft(p.text).toMatch(/\| 3, 4, 6 \| TEST AS 03 \| TEST Bulk 18 Nov \| ₹950 \|/);
    expect.soft(p.text, "turning on 16 ad sets that have no ads says nothing will spend yet").toMatch(/no ads|nothing will (spend|deliver)/i);
    expect.soft(p.text).toMatch(/TEST AS 07 renamed/);
    expect.soft(p.text).toContain(`TOTAL daily budget at the end of this plan (every ad set once, at its final budget, plus campaign budgets): ${TOTAL}`);
    expect.soft(p.text).toContain(`spend_confirmation: "${TOTAL}"`);
    expect.soft(p.text).toMatch(/Bid cap at ₹42/);
    expect.soft(p.text).toMatch(/Cost per result goal at ₹120|cost cap.*₹120/i);
    expect.soft((p.text.match(/^\| [\d, ]+ \| TEST /gm) ?? []).length).toBe(16);
    // A city picked by name should read as the city, not as its Meta key.
    expect.soft(p.text, "audience column shows Pune, not 'city 1234'").toMatch(/Pune/);

    const st = await tool("plan_status", { plan_id: key });
    expect.soft(st.text).toMatch(/Status: Waiting for your confirmation/);

    const noTotal = await tool("confirm_plan", { plan_id: key, confirm: true });
    expect(noTotal.isError).toBe(true);
    expect.soft(noTotal.text).toContain(`typing what can spend in a day once the plan has run, exactly as shown: ${TOTAL}`);
    const wrong = await tool("confirm_plan", { plan_id: key, confirm: true, spend_confirmation: "₹14,600" });
    expect.soft(wrong.text).toMatch(/doesn't match/);
    const ok = await tool("confirm_plan", { plan_id: key, confirm: true, spend_confirmation: TOTAL });
    expect(ok.isError).toBe(false);
    expect.soft(ok.text).toMatch(/Status: Confirmed, waiting to run/);

    expect(await workerRunsPlan(key)).toEqual({ done: 6, failed: 0 });
    const after = await tool("plan_status", { plan_id: key });
    readable(after.text);
    expect.soft(after.text).toMatch(/Status: Done/);
    expect.soft(after.text).toMatch(/3\. Copy ad set "TEST Base" 15 times.*: done · Made 15 copies/);

    // What Meta has now.
    const camp = mock.of("campaign").find((c) => c.name === "TEST Bulk 18 Nov")!;
    expect(camp.status).toBe("ACTIVE");
    const sets = mock.of("adset").filter((a) => a.campaign_id === camp.id);
    expect(sets).toHaveLength(16);
    expect(sets.every((s) => s.status === "ACTIVE")).toBe(true);
    const s3 = sets.find((s) => s.name === "TEST AS 03")!;
    expect.soft(Number(s3.daily_budget)).toBe(95000);
    expect.soft(s3.bid_strategy).toBe("LOWEST_COST_WITH_BID_CAP");
    expect.soft(Number(s3.bid_amount)).toBe(4200);
    const s7 = sets.find((s) => s.name === "TEST AS 07 renamed")!;
    expect.soft((s7.targeting as { age_max: number }).age_max).toBe(45);
    expect.soft((sets.find((s) => s.name === "TEST AS 01")!.targeting as { genders: number[] }).genders).toEqual([2]);

    // Undo: puts budgets and names back and turns everything off. It should read like one clear step list.
    const u = await tool("undo_plan", { plan_id: key });
    expect(u.isError).toBe(false);
    readable(u.text);
    const ukey = planKeyIn(u.text);
    const stepCount = (u.text.match(/^Step \d+:/gm) ?? []).length;
    expect.soft(stepCount, `undo plan has ${stepCount} steps for one campaign`).toBeLessThanOrEqual(4);
    const uc = await tool("confirm_plan", { plan_id: ukey, confirm: true, accept_warnings: true });
    expect(uc.isError).toBe(false);
    await workerRunsPlan(ukey);
    const back = mock.of("adset").filter((a) => a.campaign_id === camp.id);
    expect.soft(back.every((s) => s.status === "PAUSED")).toBe(true);
    expect.soft(mock.objects.get(camp.id)!.status).toBe("PAUSED");
    expect.soft(Number(back.find((s) => s.id === s3.id)!.daily_budget)).toBe(60000);
    expect.soft(back.find((s) => s.id === s7.id)!.name).toBe("TEST AS 07");
  });

  it("retry_plan after a failure: the failed step says why, finished steps stay, the retry finishes the plan", async () => {
    await preparedAccount();
    const p = await tool("plan_changes", { ops: [
      { type: "edit_adset", adset: "as1", daily_budget: 600 },
      { type: "edit_adset", adset: "Min-spend template", daily_budget: 650 },
      { type: "create_adset", campaign: "c1", name: "TEST after failure", daily_budget: 300, destination: "WEBSITE", goal: "LINK_CLICKS", countries: ["IN"] },
    ] });
    const key = planKeyIn(p.text);
    await tool("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true });
    mock.inject({ match: (m, path) => m === "POST" && path === "as4", kind: "error", error: { message: "Invalid parameter", type: "OAuthException", code: 100, error_subcode: 1885272, error_user_title: "Budget too low", error_user_msg: "Your budget must be at least ₹700 for this ad set." } });
    // Since 19 Nov (P1) a plan stops at the first failed step: step 3 is skipped, not run, so 1 done and 2 not done.
    expect(await workerRunsPlan(key)).toEqual({ done: 1, failed: 2 });
    const st = await tool("plan_status", { plan_id: key });
    readable(st.text);
    expect.soft(st.text).toMatch(/Status: Some steps failed/);
    expect.soft(st.text).toMatch(/2\. Edit ad set "Min-spend template": failed · .*Budget too low: Your budget must be at least ₹700 for this ad set\..*\(code 100\/1885272\)/);
    // He raises the budget in the failed step and retries.
    const r = await tool("retry_plan", { plan_id: key, ops: [
      { type: "edit_adset", adset: "as1", daily_budget: 600 },
      { type: "edit_adset", adset: "Min-spend template", daily_budget: 750 },
      { type: "create_adset", campaign: "c1", name: "TEST after failure", daily_budget: 300, destination: "WEBSITE", goal: "LINK_CLICKS", countries: ["IN"] },
    ] });
    expect(r.isError).toBe(false);
    readable(r.text);
    expect.soft(r.text).toMatch(/Step 1: Already done/);
    // Step 3 was skipped after step 2 failed (P1), so the retry runs it now.
    expect.soft(r.text).not.toMatch(/Step 3: Already done/);
    expect.soft(r.text).toMatch(/Step 3: Create ad set "TEST after failure"/);
    expect.soft(r.text).toMatch(/Status: Waiting for your confirmation/);
    const c = await tool("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true });
    expect(c.isError).toBe(false);
    expect(await workerRunsPlan(key)).toEqual({ done: 3, failed: 0 });
    expect.soft(Number(mock.objects.get("as4")!.daily_budget)).toBe(75000);
    expect.soft(mock.of("adset").filter((a) => a.name === "TEST after failure")).toHaveLength(1);
  });
});

// ======================================================================================
// Row 2: ad sets with every setting
// ======================================================================================

describe("Row 2 · ad sets: create, duplicate and edit with every setting", () => {
  it("the summary shows every setting he asked for, and Meta gets them", async () => {
    await preparedAccount();
    const start = inDays(2, "09:00");
    const end = inDays(12, "23:00");
    const p = await tool("plan_changes", { ops: [
      {
        type: "create_adset", ref: "full", campaign: "November tests", name: "TEST Full settings",
        lifetime_budget: 30000, start_time: start, end_time: end, destination: "WEBSITE", goal: "LANDING_PAGE_VIEWS",
        countries: ["IN"], regions: [{ key: "1728", name: "Maharashtra" }], cities: [{ key: "1234", name: "Pune", radius: 20 }],
        age_min: 28, age_max: 50, genders: "women", interests: [{ id: "6003", name: "Real estate" }], languages: [24, 6],
        custom_audiences: ["23851111"], excluded_custom_audiences: ["23852222"], advantage_audience: true,
        placements: { platforms: ["facebook", "instagram"], facebook_positions: ["feed"], instagram_positions: ["stream", "story", "reels"] },
        attribution: "1d_click", schedule: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" }],
        inventory_filter: "limited", block_list_ids: ["991"], dynamic_creative: true,
      },
      { type: "create_campaign", ref: "aw", name: "TEST Awareness", objective: "OUTCOME_AWARENESS", budget_level: "adset" },
      { type: "create_adset", campaign: "$aw", name: "TEST Reach capped", daily_budget: 400, goal: "REACH", countries: ["IN"], frequency_cap: { impressions: 2, days: 7 } },
    ] });
    expect(p.isError).toBe(false);
    readable(p.text);
    expect.soft(p.text).toMatch(/Step 1: Create ad set "TEST Full settings" in "November tests"/);
    expect.soft(p.text).toMatch(/₹30,000 lifetime/);
    const step1 = p.text.split("Step 2:")[0];
    expect.soft(step1, "names the region and city he picked").toMatch(/Maharashtra.*Pune|Pune.*Maharashtra/s);
    expect.soft(step1).toMatch(/women/);
    expect.soft(step1).toMatch(/Real estate/);
    expect.soft(step1).toMatch(/excluding/);
    expect.soft(step1).toMatch(/Advantage\+ audience on/);
    expect.soft(step1, "shows the hours it runs (Mon–Fri 9:00–18:00)").toMatch(/09:00|9:00 ?am/i);
    expect.soft(step1, "shows the attribution window").toMatch(/1-day click/i);
    expect.soft(step1, "shows the languages").toMatch(/language/i);
    expect.soft(step1, "shows brand safety (limited inventory, block list)").toMatch(/inventory|brand safety|block list/i);
    expect.soft(step1, "shows that Dynamic creative is on").toMatch(/dynamic creative/i);
    expect.soft(p.text.split("Step 3:")[1] ?? "", "shows the frequency cap").toMatch(/2 .*per 7 days|frequency/i);

    const key = planKeyIn(p.text);
    await tool("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true });
    expect(await workerRunsPlan(key)).toEqual({ done: 3, failed: 0 });
    const body = sentTo(/^act_1001\/adsets$/).find((s) => s.params.name === "TEST Full settings")!.params as Record<string, unknown> & { targeting: Record<string, unknown> };
    expect.soft(body.lifetime_budget).toBe("3000000");
    expect.soft(body.attribution_spec).toEqual([{ event_type: "CLICK_THROUGH", window_days: 1 }]);
    expect.soft(body.pacing_type).toEqual(["day_parting"]);
    expect.soft(body.adset_schedule).toEqual([{ start_minute: 540, end_minute: 1080, days: [1, 2, 3, 4, 5] }]);
    expect.soft(body.brand_safety_content_filter_levels).toEqual(["FACEBOOK_STRICT", "AN_STRICT"]);
    expect.soft(body.is_dynamic_creative).toBe("true");
    expect.soft(body.targeting.locales).toEqual([24, 6]);
    expect.soft(body.targeting.excluded_publisher_list_ids).toEqual(["991"]);
    expect.soft(body.targeting.custom_audiences).toEqual([{ id: "23851111" }]);
    expect.soft(body.targeting.excluded_custom_audiences).toEqual([{ id: "23852222" }]);
    expect.soft(body.targeting.targeting_automation).toEqual({ advantage_audience: 1 });
    expect.soft(body.targeting.instagram_positions).toEqual(["stream", "story", "reels"]);
    const reach = sentTo(/^act_1001\/adsets$/).find((s) => s.params.name === "TEST Reach capped")!.params;
    expect.soft(reach.frequency_control_specs).toEqual([{ event: "IMPRESSIONS", interval_days: 7, max_frequency: 2 }]);

    // get_details: the settings in plain words.
    const id = mock.of("adset").find((a) => a.name === "TEST Full settings")!.id;
    const d = await tool("get_details", { kind: "adset", id });
    expect(d.isError).toBe(false);
    const plain = d.text.split("\n\nRaw:")[0];
    expect.soft(plain, "plain words include the attribution window").toMatch(/attribution|1-day click/i);
  });

  it("a duplicated ad set that changes budget type is checked before it runs", async () => {
    await preparedAccount();
    // The original runs on a lifetime budget at set hours; the copy asks for a daily budget.
    Object.assign(mock.objects.get("as1")!, { daily_budget: undefined, lifetime_budget: "3000000", end_time: inDays(10), pacing_type: ["day_parting"], adset_schedule: [{ start_minute: 540, end_minute: 1080, days: [1, 2, 3, 4, 5] }] });
    const p = await tool("plan_changes", { ops: [
      { type: "duplicate_adset", adset: "as1", changes: [{ name: "TEST copy daily", daily_budget: 800 }, { name: "TEST copy lifetime", lifetime_budget: 20000 }] },
      { type: "edit_adset", adset: "Min-spend template", lifetime_budget: 25000 },
    ] });
    readable(p.text);
    // Meta does not let an ad set switch between daily and lifetime budget, and hours (dayparting) need a lifetime budget.
    expect.soft(p.text, "copy 1 switches a lifetime/dayparted ad set to a daily budget: flagged").toMatch(/ERROR: Step 1: copy 1/);
    expect.soft(p.text, "edit switches a daily-budget ad set to lifetime without an end date: flagged").toMatch(/ERROR: Step 2/);
  });

  it("edit an ad set's audience and placements; the summary and Meta agree", async () => {
    await preparedAccount();
    Object.assign((mock.objects.get("as1")!.targeting as Record<string, unknown>), { genders: [2], flexible_spec: [{ interests: [{ id: "6003", name: "Real estate" }] }], publisher_platforms: ["facebook"], facebook_positions: ["feed"] });
    const p = await tool("plan_changes", { ops: [{ type: "edit_adset", adset: "November test ad set", genders: "all", interests: [], placements: "advantage", advantage_audience: true, age_min: 21 }] });
    readable(p.text);
    expect.soft(p.text).toMatch(/audience → IN · age 21–55 · all genders · Advantage\+ audience on; placements → Advantage\+ placements \(all\)/);
    const key = planKeyIn(p.text);
    await tool("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true });
    await workerRunsPlan(key);
    const t = mock.objects.get("as1")!.targeting as Record<string, unknown>;
    expect.soft(t.genders).toBeUndefined();
    expect.soft(t.flexible_spec).toBeUndefined();
    expect.soft(t.publisher_platforms).toBeUndefined();
    expect.soft(t.age_min).toBe(21);
  });
});

// ======================================================================================
// Row 3: campaigns
// ======================================================================================

describe("Row 3 · campaigns: CBO and ABO, special category, spend cap, budget schedule, copies", () => {
  it("one plan; the summary reads right and Meta gets the right fields", async () => {
    await preparedAccount();
    const p = await tool("plan_changes", { ops: [
      { type: "create_campaign", ref: "cbo", name: "TEST CBO", objective: "OUTCOME_LEADS", budget_level: "campaign", daily_budget: 3000, special_ad_categories: ["HOUSING"], special_ad_category_country: ["IN"], spend_cap: 100000, budget_schedules: [{ start: inDays(7, "00:00"), end: inDays(9, "00:00"), increase_percent: 20 }] },
      // Housing ads: Meta allows only ages 18–65+ and all genders (P24 refuses women 25–45 before it runs; checked below).
      { type: "create_adset", campaign: "$cbo", name: "TEST CBO 18-65", destination: "ON_AD", goal: "LEAD_GENERATION", page_id: "p1", countries: ["IN"], age_min: 18, age_max: 65, genders: "all" },
      { type: "create_campaign", ref: "abo", name: "TEST ABO", objective: "OUTCOME_TRAFFIC", budget_level: "adset", bid_strategy: "LOWEST_COST_WITH_BID_CAP" },
      { type: "create_adset", campaign: "$abo", name: "TEST ABO AS", daily_budget: 700, bid_amount: 15, destination: "WEBSITE", goal: "LINK_CLICKS", countries: ["IN"] },
      { type: "duplicate_campaign", campaign: "$cbo", with_contents: true, changes: [{ name: "TEST CBO copy A", daily_budget: 4000 }, { name: "TEST CBO copy B" }] },
      { type: "duplicate_campaign", campaign: "$abo", with_contents: true, copies: 2 },
      { type: "edit_campaign", campaign: "$cbo", name: "TEST CBO edited", daily_budget: 3500, spend_cap: 120000 },
    ] });
    expect(p.isError).toBe(false);
    readable(p.text);
    expect.soft(p.text).toMatch(/Special ad category: HOUSING \(IN\)\. Spend limit: ₹1,00,000\./);
    expect.soft(p.text).toMatch(/Budget raised at set times: .* \+20%/);
    expect.soft(p.text).toMatch(/Copy campaign "TEST CBO" 2 times with its ad sets and ads/);
    expect.soft(p.text).toMatch(/Copy campaign "TEST ABO" 2 times/);
    expect.soft(p.text).toMatch(/\| TEST ABO AS \| TEST ABO - copy 1 \| ₹700 \|  \| Bid cap at ₹15 \|/);
    expect.soft(p.text, "copy changes in plain words (daily budget ₹4,000), not 'daily_budget → 4000'").not.toMatch(/daily_budget → 4000/);
    expect.soft(p.text).toMatch(/Campaign budget: "TEST CBO edited" ₹3,500 a day/);
    expect.soft(p.text).toMatch(/Campaign budget: "TEST CBO copy A" ₹4,000 a day/);
    // CBO 3,500 + copy A 4,000 + copy B 3,000 + ABO ad set 700 × 3 (original and 2 copies)
    expect.soft(p.text).toMatch(/TOTAL daily budget .*: ₹12,600/);
    // Housing ads: Meta allows only age 18–65+, all genders, and 15 km+ radius. An ad set that breaks this fails at run time,
    // so the check refuses it before anything runs (P24).
    const women = await tool("plan_changes", { ops: [
      { type: "create_campaign", ref: "h", name: "TEST housing", objective: "OUTCOME_LEADS", budget_level: "campaign", daily_budget: 3000, special_ad_categories: ["HOUSING"], special_ad_category_country: ["IN"] },
      { type: "create_adset", campaign: "$h", name: "TEST CBO women 25-45", destination: "ON_AD", goal: "LEAD_GENERATION", page_id: "p1", countries: ["IN"], age_min: 25, age_max: 45, genders: "women" },
    ] });
    expect.soft(women.text, "a housing ad set aimed at women 25-45 is flagged before it runs").toMatch(/ERROR: Step 2:.*(housing|special ad category)/i);

    const key = planKeyIn(p.text);
    const c = await tool("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true });
    expect(c.isError).toBe(false);
    expect(await workerRunsPlan(key)).toEqual({ done: 7, failed: 0 });
    const cbo = sentTo(/^act_1001\/campaigns$/).find((s) => s.params.name === "TEST CBO")!.params;
    expect.soft(cbo.special_ad_categories).toEqual(["HOUSING"]);
    expect.soft(cbo.special_ad_category_country).toEqual(["IN"]);
    expect.soft(cbo.spend_cap).toBe("10000000");
    expect.soft(cbo.daily_budget).toBe("300000");
    const sched = sentTo(/budget_schedules$/)[0]?.params;
    // +20% for the period. Since 19 Nov (P19) the launcher never sends MULTIPLIER: it works out the increase from the
    // campaign's daily budget (20% of ₹3,000 = ₹600) and sends that fixed amount in paise (ABSOLUTE 60000).
    expect.soft(sched, "the +20% schedule is sent as +₹600 on ₹3,000").toMatchObject({ budget_value_type: "ABSOLUTE", budget_value: "60000" });
    const lc = await tool("list_campaigns", { campaign: "TEST", refresh: true });
    readable(lc.text);
    expect.soft(lc.text).toMatch(/Campaign "TEST CBO edited" .* budget ₹3,500 a day \(campaign budget\)/);
    expect.soft(lc.text).toMatch(/Campaign "TEST ABO - copy 2"/);
    expect.soft(lc.text).toMatch(/Ad set "TEST ABO AS" .* Bid cap at ₹15/);
  });
});

// ======================================================================================
// Row 4: launch on a schedule, turn a whole campaign on
// ======================================================================================

describe("Row 4 · launch at a time / turn on", () => {
  it("go_live at a time: the total is typed, the ads are made, and he can see which plan turns them on", async () => {
    const { accountId, batchId, key } = await preparedAccount();
    const at = inDays(2, "09:00");
    const pv = await tool("preview_batch", { batch_id: key, go_live: "at", go_live_at: at });
    expect(pv.isError).toBe(false);
    readable(pv.text);
    expect.soft(pv.text).toMatch(/TOTAL daily budget: ₹500/);
    expect.soft(pv.text).toMatch(/turned ON at \d{1,2} \w{3} 2026/);
    expect.soft(pv.text, "the first line says the time in IST words, not raw ISO").not.toMatch(/TURNED ON at \d{4}-\d\d-\d\dT/);
    expect.soft(pv.text).toContain('spend_confirmation: "₹500"');
    const no = await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true });
    expect(no.isError).toBe(true);
    expect.soft(no.text).toMatch(/typing the total daily budget exactly as shown: ₹500/);
    const yes = await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true, spend_confirmation: "₹500" });
    expect(yes.isError).toBe(false);
    expect.soft(yes.text).toMatch(/turned on at/);
    expect(await runBatch(batchId, deps(accountId))).toEqual({ done: 9, failed: 0 });
    const msg = await queueGoLive(batchId);
    const goKey = /plan (p[a-z0-9]{4})/.exec(msg ?? "")?.[1] ?? "";
    expect(goKey).toBeTruthy();
    const bs = await tool("batch_status", { batch_id: key });
    readable(bs.text);
    expect.soft(bs.text, "batch_status names the plan that turns the ads on").toContain(goKey);
    const ps = await tool("plan_status", { plan_id: goKey });
    expect.soft(ps.text).toMatch(/Status: Scheduled for/);
    expect.soft(ps.text).toMatch(/Turn ON: 1 campaign|campaign "November tests"/);
  });

  it("go_live now: the worker turns on ads, ad set and campaign", async () => {
    const { accountId, batchId, key } = await preparedAccount();
    await tool("preview_batch", { batch_id: key, go_live: "now" });
    const yes = await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true, spend_confirmation: "500" });
    expect(yes.isError).toBe(false);
    await runBatch(batchId, deps(accountId));
    const msg = await queueGoLive(batchId);
    const goKey = /plan (p[a-z0-9]{4})/.exec(msg ?? "")![1];
    expect(await workerRunsPlan(goKey)).toEqual({ done: 1, failed: 0 });
    expect(mock.objects.get("c1")!.status).toBe("ACTIVE");
    expect(mock.objects.get("as1")!.status).toBe("ACTIVE");
    expect(mock.of("ad").filter((a) => a.adset_id === "as1").every((a) => a.status === "ACTIVE")).toBe(true);
    const d = await tool("delivery_status", { batch_id: key });
    readable(d.text);
    expect.soft(d.text).toMatch(/Ad set "November test ad set" \(as1\): delivering \(on\)/);
  });

  it("turning a whole campaign on with set_status needs the typed total; a past time is refused in words", async () => {
    const { key } = await preparedAccount();
    const p = await tool("plan_changes", { ops: [{ type: "set_status", status: "ACTIVE", whole_campaigns: ["CBO campaign"] }] });
    readable(p.text);
    expect.soft(p.text).toMatch(/TURNS ON: campaign "CBO campaign" with 1 ad set and 0 ads/);
    const k = planKeyIn(p.text);
    const no = await tool("confirm_plan", { plan_id: k, confirm: true, accept_warnings: true });
    expect(no.isError).toBe(true);
    expect.soft(no.text).toMatch(/exactly as shown: ₹1,000/);
    const ok = await tool("confirm_plan", { plan_id: k, confirm: true, accept_warnings: true, spend_confirmation: "₹1,000" });
    expect(ok.isError).toBe(false);
    const past = await tool("preview_batch", { batch_id: key, go_live: "at", go_live_at: "2026-11-01T09:00:00+05:30" });
    expect.soft(past.text).toMatch(/ERROR: Pick a time in the future to turn the ads on/);
    const pastPlan = await tool("plan_changes", { run_at: "2026-11-01T09:00:00+05:30", ops: [{ type: "edit_adset", adset: "as1", daily_budget: 550 }] });
    expect.soft(pastPlan.text).toMatch(/ERROR: The start time .* is in the past/);
  });
});

// ======================================================================================
// Row 5: copy templates and per-ad copy
// ======================================================================================

describe("Row 5 · copy templates and per-ad copy", () => {
  it("save_copy_template with UTM default, display link and lead form; he can read back what he saved", async () => {
    await preparedAccount();
    const s = await tool("save_copy_template", {
      name: "TEST 5x5", primary_texts: ["T1", "T2", "T3", "T4", "T5"], headlines: ["H1", "H2", "H3", "H4", "H5"], description: "Sahajta Estates",
      link_url: "https://example.com/visit", cta: "SIGN_UP", display_link: "sahajta.com/visit", lead_form_id: "123456789",
    });
    expect(s.isError).toBe(false);
    expect.soft(s.text).toMatch(/Created copy template "TEST 5x5" \(id \d+\): 5 primary text\(s\), 5 headline\(s\), \d+ description\(s\), SIGN_UP → https:\/\/example.com\/visit/);
    expect.soft(s.text, "the answer says the UTM tags it got by default").toMatch(/utm_source=facebook/);
    const l = await tool("list_templates");
    const line = l.text.split("\n").filter((x) => x.includes("TEST 5x5")).join(" ");
    expect.soft(line, "list_templates shows display link, lead form and UTM").toMatch(/sahajta\.com\/visit.*123456789.*utm_|utm_.*sahajta\.com\/visit/);
    const bad = await tool("save_copy_template", { name: "TEST no https", primary_texts: ["x"], link_url: "sahajta.com/visit" });
    expect.soft(bad.text).toBe("The link must start with https://.");
    const { accountId, batchId, key } = await (async () => { const r = await setupBatch(folder); return { ...r, key: getBatch(r.batchId)!.key }; })();
    const pv = await tool("preview_batch", { batch_id: key, copy_template: "TEST 5x5" });
    expect.soft(pv.text).toMatch(/Copy: 5 primary text\(s\), 5 headline\(s\), SIGN_UP → https:\/\/example.com\/visit · UTM utm_source=facebook/);
    await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true });
    expect(await runBatch(batchId, deps(accountId))).toEqual({ done: 9, failed: 0 });
    const cr = sentTo(/^act_1001\/adcreatives$/).map((x) => x.params as { url_tags?: string; object_story_spec?: { link_data?: { caption?: string; call_to_action?: { value: { lead_gen_form_id?: string } } } }; asset_feed_spec?: { call_to_actions?: { value: { lead_gen_form_id?: string } }[]; link_urls?: { display_url?: string }[] } });
    expect.soft(cr.every((c) => /utm_source=facebook/.test(c.url_tags ?? ""))).toBe(true);
    expect.soft(cr.every((c) => (c.object_story_spec?.link_data?.call_to_action?.value.lead_gen_form_id ?? c.asset_feed_spec?.call_to_actions?.[0]?.value.lead_gen_form_id) === "123456789")).toBe(true);
    expect.soft(cr.every((c) => (c.object_story_spec?.link_data?.caption ?? c.asset_feed_spec?.link_urls?.[0]?.display_url) === "sahajta.com/visit")).toBe(true);
    const six = await tool("save_copy_template", { name: "TEST six", primary_texts: ["1", "2", "3", "4", "5", "6"] });
    expect(six.isError).toBe(true);
    expect.soft(six.text).toMatch(/<=5 items at primary_texts/);
  });

  it("set_ad_copy per ad (5 texts, 5 headlines); preview_batch shows each ad's own copy; Meta gets every text", async () => {
    const { accountId, batchId, key } = await preparedAccount();
    const hook = adNo(batchId, "hook-01");
    const price = adNo(batchId, "static-price");
    const r = await tool("set_ad_copy", { batch_id: key, rows: [
      { ad: hook, primary_texts: ["P1", "P2", "P3", "P4", "P5"], headlines: ["Hd1", "Hd2", "Hd3", "Hd4", "Hd5"], link_url: "https://example.com/hook" },
      { ad: "static-price_1x1.jpg", primary_texts: ["Plots from 20 lakh, only this week"], headlines: ["Price drop headline"], display_link: "sahajta.com/price", cta: "GET_QUOTE" },
    ] });
    expect(r.isError).toBe(false);
    expect.soft(r.text).toBe(`Saved copy for 2 ad(s) in batch ${key}. Run preview_batch with batch_id to see the result.`);
    const pv = await tool("preview_batch", { batch_id: key });
    readable(pv.text);
    const row = (n: number) => pv.text.split("\n").find((x) => x.startsWith(`| ${n} |`)) ?? "";
    expect.soft(row(hook)).toMatch(/5 texts, 5 headlines, \d+ descriptions → https:\/\/example.com\/hook/);
    expect.soft(row(price), "the price ad's own headline and button are visible in the preview").toMatch(/Price drop headline|GET_QUOTE/);
    // The pre-launch summary's Copy line is the batch's copy, not ad 1's own link.
    expect.soft(pv.text, "summary Copy line is not ad 1's per-ad link").not.toMatch(/Copy: .*→ https:\/\/example.com\/hook ·/);
    const bad = await tool("set_ad_copy", { batch_id: key, rows: [{ ad: 42, headlines: ["x"] }] });
    expect.soft(bad.text).toMatch(/No ad "42" in batch/);
    await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true });
    expect(await runBatch(batchId, deps(accountId))).toEqual({ done: 9, failed: 0 });
    const creatives = sentTo(/^act_1001\/adcreatives$/).map((s) => s.params as { name: string; asset_feed_spec?: { bodies: unknown[]; titles: unknown[] }; object_story_spec?: { link_data?: { caption?: string; message?: string; call_to_action?: { type: string } } } });
    const hookC = creatives.find((c) => c.asset_feed_spec?.bodies?.length === 5);
    expect.soft(hookC?.asset_feed_spec?.titles).toHaveLength(5);
    const priceC = creatives.find((c) => c.object_story_spec?.link_data?.message === "Plots from 20 lakh, only this week");
    expect.soft(priceC?.object_story_spec?.link_data?.caption).toBe("sahajta.com/price");
    expect.soft(priceC?.object_story_spec?.link_data?.call_to_action?.type).toBe("GET_QUOTE");
  });
});

// ======================================================================================
// Row 6: batch control and clear errors
// ======================================================================================

describe("Row 6 · batch control", () => {
  it("several ad sets, ad set modes, regroup", async () => {
    const { batchId, key } = await preparedAccount();
    const a = await tool("preview_batch", { batch_id: key, ad_set: ["November test ad set", "Min-spend template"] });
    expect(a.isError).toBe(false);
    readable(a.text);
    expect.soft(a.text).toMatch(/the same ads also go into "Min-spend template" \(November tests\)/);
    expect.soft(a.text).toMatch(/TOTAL daily budget: ₹1,300/);
    const b = await tool("preview_batch", { batch_id: key, ad_set_mode: "new_per_ad", ad_set: "November test ad set" });
    expect.soft(b.text).toMatch(/a new ad set per ad, copied from "November test ad set"/);
    expect.soft(b.text).toMatch(/9 new ad sets copied from "November test ad set" · ₹500 a day each \(₹4,500 a day for all 9\)/);
    const g1 = await tool("regroup_files", { batch_id: key, file: "hook-01_4x5.mp4", to: "new" });
    expect.soft(g1.text).toBe(`Moved hook-01_4x5.mp4 into an ad of its own. Run preview_batch with batch_id ${key} to see the new grouping.`);
    const pv = await tool("preview_batch", { batch_id: key });
    expect.soft(pv.text).toMatch(/: 10 ads,/);
    const back = await tool("regroup_files", { batch_id: key, file: "hook-01_4x5.mp4", to: adNo(batchId, "hook-01") });
    expect.soft(back.isError).toBe(false);
    const bad = await tool("regroup_files", { batch_id: key, file: "nope.mp4", to: 1 });
    expect.soft(bad.text).toBe(`No file "nope.mp4" in batch ${key}.`);
  });

  it("a failed ad: clear reason, its copy fixed after launch, retried; post IDs shown", async () => {
    const { accountId, batchId, key } = await preparedAccount();
    await tool("preview_batch", { batch_id: key });
    await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true });
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives"), kind: "error", error: { message: "Invalid parameter", code: 100, error_subcode: 1487390, error_user_title: "Text too long", error_user_msg: "Your ad's primary text is too long." } });
    expect(await runBatch(batchId, deps(accountId))).toEqual({ done: 8, failed: 1 });
    const s1 = await tool("batch_status", { batch_id: key });
    readable(s1.text);
    expect.soft(s1.text).toMatch(/Some ads failed\. 8 of 9 ads created, 1 failed\./);
    expect.soft(s1.text).toMatch(/FAILED: .*Meta said: "Text too long: Your ad's primary text is too long\." \(code 100\/1487390\)/);
    expect.soft(s1.text).toMatch(/Next: fix the cause named in each failure, then call retry_failed/);
    const failed = getAds(batchId).find((a) => a.status === "failed")!;
    const fix = await tool("set_ad_copy", { batch_id: key, rows: [{ ad: failed.position, primary_texts: ["Shorter text."] }] });
    expect(fix.isError).toBe(false);
    // The tool's own advice after a launch: "Run preview_batch with batch_id to see the result."
    const look = await tool("preview_batch", { batch_id: key });
    expect.soft(look.isError, `following set_ad_copy's advice after launch gives: ${look.text}`).toBe(false);
    const rt = await tool("retry_failed", { batch_id: key });
    // Since 19 Nov the answer is the server's own sentence (it also says when the ads are turned on again).
    expect.soft(rt.text).toBe(`Batch ${key}: Retrying 1 ad not created yet. Ads that already went through are not touched. Use batch_status to follow it.`);
    expect(await runBatch(batchId, deps(accountId))).toEqual({ done: 9, failed: 0 });
    const s2 = await tool("batch_status", { batch_id: key });
    expect.soft(s2.text).toMatch(/All ads created\. 9 of 9 ads created\./);
    expect.soft((s2.text.match(/post ID p1_\d+/g) ?? []).length).toBe(9);
    expect.soft(s2.text).toMatch(/Created ads are PAUSED/);
    const again = await tool("retry_failed", { batch_id: key });
    expect.soft(again.text).toBe("No failed ads to retry.");
  });

  it("new ad set per ad: the empty ad set left by a failure is named, and cancel stops a launch", async () => {
    const { accountId, batchId, key } = await preparedAccount();
    await tool("preview_batch", { batch_id: key, ad_set_mode: "new_per_ad" });
    await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true });
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Image too small." } });
    await runBatch(batchId, deps(accountId));
    const s = await tool("batch_status", { batch_id: key });
    expect.soft(s.text).toMatch(/Note: An empty paused ad set \(ID \d+, named with \[L:[a-z0-9]+-\d+\]\) is in Meta from this attempt\. "Retry failed" puts the ad into it; nothing is made twice\./);

    // A second batch: cancel while it waits, then cancel while it runs. (Lead form in its copy: as1 is an Instant-form ad set.)
    const { key: k2, batchId: b2 } = await leadBatch();
    await tool("preview_batch", { batch_id: k2 });
    await tool("launch_batch", { batch_id: k2, confirm: true, accept_warnings: true });
    const c = await tool("cancel_batch", { batch_id: k2 });
    expect.soft(c.text).toBe(`Batch ${k2}: stopped. 0 of 9 ads were created and stay paused.`);
    const st = await tool("batch_status", { batch_id: k2 });
    expect.soft(st.text).toMatch(/Cancelled before it was created/);
    await tool("retry_failed", { batch_id: k2 });
    const run = runBatch(b2, deps(accountId));
    const c2 = await tool("cancel_batch", { batch_id: k2 });
    await run;
    expect.soft(c2.text).toMatch(/stopping after the current step|stopped/);
    const s3 = await tool("batch_status", { batch_id: k2 });
    readable(s3.text);
  });
});

// ======================================================================================
// Row 7: existing ads
// ======================================================================================

describe("Row 7 · edit and copy existing ads", () => {
  it("list_ads → edit text, link, button → copy into another ad set → ads from its post", async () => {
    const { accountId, batchId, key } = await preparedAccount();
    await tool("preview_batch", { batch_id: key });
    await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true });
    await runBatch(batchId, deps(accountId));
    const byName = await tool("list_ads", { adset: "November test ad set" });
    expect.soft(byName.isError, `list_ads by the ad set's name: ${byName.text}`).toBe(false);
    const l = await tool("list_ads", { adset: "as1" });
    readable(l.text);
    expect.soft((l.text.match(/^- "/gm) ?? []).length).toBe(9);
    const price = getAds(batchId).find((a) => a.creative_name.includes("static-price"))!;
    const hook = getAds(batchId).find((a) => a.creative_name.includes("hook-02"))!;
    expect.soft(l.text).toContain(`(id ${price.meta_ad_id})`);
    expect.soft(l.text).toContain(`post ID ${price.meta_post_id}`);
    const p = await tool("plan_changes", { ops: [
      { type: "edit_ad", ad: price.meta_ad_id, primary_texts: ["New text A", "New text B"], headlines: ["New headline"], link_url: "https://example.com/new", cta: "SIGN_UP", display_link: "sahajta.com/new" },
      { type: "edit_ad", ad: hook.meta_ad_id, primary_texts: ["Hook new text"], link_url: "https://example.com/hook-new" },
      { type: "copy_ad", ref: "cp", ad: price.meta_ad_id, adsets: ["Min-spend template"] },
      { type: "ads_from_post", post_id: price.meta_post_id, adsets: ["Min-spend template"], name: "TEST from post" },
    ] });
    expect(p.isError).toBe(false);
    readable(p.text);
    expect.soft(p.text).toMatch(/primary texts → "New text A", "New text B"; headline → "New headline"; link → https:\/\/example.com\/new; display link → sahajta.com\/new; button → sign up/);
    const k = planKeyIn(p.text);
    await tool("confirm_plan", { plan_id: k, confirm: true, accept_warnings: true });
    expect(await workerRunsPlan(k)).toEqual({ done: 4, failed: 0 });
    const l2 = await tool("list_ads", { adset: "as1" });
    const priceLine = l2.text.split("\n- ").find((x) => x.includes(`(id ${price.meta_ad_id})`)) ?? "";
    expect.soft(priceLine).toMatch(/texts: "New text A" \| "New text B"/);
    expect.soft(priceLine).toMatch(/link: https:\/\/example.com\/new/);
    const hookLine = l2.text.split("\n- ").find((x) => x.includes(`(id ${hook.meta_ad_id})`)) ?? "";
    expect.soft(hookLine).toMatch(/Hook new text/);
    expect.soft(hookLine, "the hook ad (9:16 + 4:5) shows its new link").toMatch(/link: https:\/\/example.com\/hook-new/);
    const l4 = await tool("list_ads", { adset: "as4" });
    expect.soft(l4.text).toMatch(/TEST from post.*runs an existing post/);
    expect.soft((l4.text.match(/^- "/gm) ?? []).length).toBe(2);
  });
});

// ======================================================================================
// Row 8: custom audiences and lookalikes
// ======================================================================================

describe("Row 8 · custom audiences and lookalikes, used in the same plan", () => {
  it("website, video, page, instagram, lead form, customer list; lookalikes 1% and 10%; then an ad set uses them", async () => {
    await preparedAccount();
    const p = await tool("plan_changes", { ops: [
      { type: "create_custom_audience", ref: "web", name: "TEST site visitors 30d", source: { kind: "website", pixel_id: "px1", days: 30, url_contains: ["/plots"] } },
      { type: "create_custom_audience", ref: "vid", name: "TEST video thruplay", source: { kind: "video", video_ids: ["777001"], days: 90, watched: "thruplay" } },
      { type: "create_custom_audience", ref: "pg", name: "TEST page engagers", source: { kind: "page", page_id: "p1", days: 365 } },
      { type: "create_custom_audience", ref: "ig", name: "TEST IG engagers", source: { kind: "instagram", instagram_id: "ig1", days: 365 } },
      { type: "create_custom_audience", ref: "lf", name: "TEST form openers", source: { kind: "lead_form", page_id: "p1", days: 90, action: "opened_not_submitted" } },
      { type: "create_custom_audience", ref: "list", name: "TEST buyers list", source: { kind: "customer_list", emails: ["Buyer.One@Example.com ", "bad-email"], phones: ["98123 45678", "+91 98765 43210"] } },
      { type: "create_lookalike", ref: "lal1", name: "TEST LAL 1%", source_audience: "$list", country: "IN", size_percent: 1 },
      { type: "create_lookalike", ref: "lal10", name: "TEST LAL 10%", source_audience: "$pg", country: "IN", size_percent: 10 },
      { type: "create_adset", campaign: "November tests", name: "TEST audiences", daily_budget: 400, destination: "WEBSITE", goal: "LINK_CLICKS", countries: ["IN"], custom_audiences: ["$web", "$lal1", "$lal10"], excluded_custom_audiences: ["$list"] },
    ] });
    expect(p.isError).toBe(false);
    readable(p.text);
    expect.soft(p.text).toMatch(/Create customer list audience "TEST buyers list"/);
    expect.soft(p.text, "says one row was skipped (bad-email)").toMatch(/skipp|not an email|1 row/i);
    // The source is named by its name, not the plan's "$list" (final check, 19 Nov 2026).
    expect.soft(p.text).toMatch(/1% of people in IN most like audience "TEST buyers list"/);
    expect.soft(p.text).toMatch(/3 custom\/lookalike audiences/);
    // The plan as saved keeps no plain emails or phone numbers.
    const saved = db().prepare("SELECT ops FROM plans").pluck().get() as string;
    expect(saved).not.toMatch(/buyer\.one|98123|98765/i);
    const k = planKeyIn(p.text);
    await tool("confirm_plan", { plan_id: k, confirm: true, accept_warnings: true });
    expect(await workerRunsPlan(k)).toEqual({ done: 9, failed: 0 });
    const auds = mock.of("audience");
    expect(auds).toHaveLength(8);
    const lal = sentTo(/customaudiences$/).find((s) => s.params.name === "TEST LAL 10%")!.params;
    expect.soft(lal.lookalike_spec).toMatchObject({ ratio: 0.1, country: "IN" });
    const users = sentTo(/\/users$/)[0]?.params as { payload: { schema: string[]; data: string[][] } };
    expect.soft(users.payload.data).toHaveLength(3);
    const set = mock.of("adset").find((a) => a.name === "TEST audiences")!;
    const t = set.targeting as { custom_audiences: { id: string }[]; excluded_custom_audiences: { id: string }[] };
    expect.soft(t.custom_audiences.map((a) => mock.objects.get(a.id)?.name)).toEqual(["TEST site visitors 30d", "TEST LAL 1%", "TEST LAL 10%"]);
    expect.soft(t.excluded_custom_audiences.map((a) => mock.objects.get(a.id)?.name)).toEqual(["TEST buyers list"]);
    const look = await tool("lookup", { what: "custom_audiences" });
    expect.soft(look.text).toMatch(/TEST LAL 10%/);
    const bad = await tool("plan_changes", { ops: [{ type: "create_lookalike", name: "TEST LAL 12", source_audience: auds[0].id, country: "India", size_percent: 12 }, { type: "create_custom_audience", name: "TEST web 400", source: { kind: "website", pixel_id: "px1", days: 400 } }] });
    expect.soft(bad.text).toMatch(/ERROR: Step 1: country must be a 2-letter code/);
    // Any wording that names the field and its range (the plan check names "source.days" since round 4).
    expect.soft(bad.text).toMatch(/ERROR: Step 1: size_percent must be [^\n]*1 to 10/);
    expect.soft(bad.text).toMatch(/ERROR: Step 2: (source\.)?days must be [^\n]*1 to 180/);
  });
});

// ======================================================================================
// Row 9: display link, Threads, WhatsApp number, partner Page in presets
// ======================================================================================

describe("Row 9 · presets: WhatsApp number, Threads, partner Page, display link", () => {
  it("save_settings_preset reads back what was saved, the batch uses it, and the creative carries it", async () => {
    const { accountId, batchId, key } = await preparedAccount();
    const s = await tool("save_settings_preset", { name: "TEST WhatsApp leads", page_id: "p1", page_name: "Sahajta AI", instagram_id: "ig1", instagram_username: "sahajta.ai", whatsapp_number: "+91 98123 45678", threads_account_id: "777", partner_page_id: "888", enhancements_on: [] });
    expect(s.isError).toBe(false);
    expect.soft(s.text, "the answer confirms the WhatsApp number, Threads account and partner Page").toMatch(/919812345678.*777.*888|WhatsApp.*Threads.*partner/is);
    const l = await tool("list_templates");
    const line = l.text.split("\n").find((x) => x.includes("TEST WhatsApp leads")) ?? "";
    expect.soft(line, "list_templates shows the preset's WhatsApp, Threads and partner Page").toMatch(/WhatsApp|Threads|partner/i);
    // A second preset whose name is the start of the first: asking for it by its exact name must pick it.
    await tool("save_settings_preset", { name: "TEST WhatsApp", page_id: "p1", page_name: "Sahajta AI" });
    const pick = await tool("preview_batch", { batch_id: key, settings_preset: "TEST WhatsApp" });
    expect.soft(pick.text, "preview_batch picks the preset with that exact name").toMatch(/Settings preset: TEST WhatsApp \(/);
    const pv = await tool("preview_batch", { batch_id: key, settings_preset: "TEST WhatsApp leads" });
    expect.soft(pv.text).toMatch(/Settings preset: TEST WhatsApp leads \(/);
    await tool("set_ad_copy", { batch_id: key, rows: [{ ad: "static-price_1x1.jpg", cta: "WHATSAPP_MESSAGE", display_link: "sahajta.com/wa", primary_texts: ["Chat with us"] }] });
    await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true });
    expect(await runBatch(batchId, deps(accountId))).toEqual({ done: 9, failed: 0 });
    const wa = sentTo(/^act_1001\/adcreatives$/).map((x) => x.params as { branded_content_sponsor_page_id?: string; object_story_spec?: { threads_user_id?: string; link_data?: { message?: string; caption?: string; call_to_action?: { type: string; value: { whatsapp_number?: string } } } } }).find((c) => c.object_story_spec?.link_data?.message === "Chat with us")!;
    expect.soft(wa.object_story_spec?.link_data?.call_to_action?.type).toBe("WHATSAPP_MESSAGE");
    expect.soft(wa.object_story_spec?.link_data?.call_to_action?.value.whatsapp_number).toBe("+919812345678");
    expect.soft(wa.object_story_spec?.threads_user_id).toBe("777");
    expect.soft(wa.branded_content_sponsor_page_id).toBe("888");
    expect.soft(wa.object_story_spec?.link_data?.caption).toBe("sahajta.com/wa");
  });
});

// ======================================================================================
// Row 10: pre-launch checks and after launch
// ======================================================================================

describe("Row 10 · pre-launch checks and after launch", () => {
  it("account health, pixel, landing page and ad previews before launch", async () => {
    freshMeta({ accountStatus: 3 });
    const { batchId, key } = await preparedAccount();
    Object.assign(mock.objects.get("as1")!, { promoted_object: { pixel_id: "px1", custom_event_type: "LEAD" } });
    await tool("set_ad_copy", { batch_id: key, rows: [{ ad: "static-team", link_url: "https://down.example.org/offer" }] });
    const pv = await tool("preview_batch", { batch_id: key, go_live: "now" });
    readable(pv.text);
    expect.soft(pv.text).toMatch(/CHECK FAILED: The ad account "Sahajta AI \(mock\)" is unsettled \(an unpaid bill\), so ads won't deliver/);
    expect.soft(pv.text).toMatch(/Pixel "Site pixel" last sent an event on 2026-11-01/);
    // Wording since 19 Nov (R7, in preview.ts): names the page and what people would see.
    expect.soft(pv.text).toMatch(/Landing page https:\/\/down.example.org\/offer: page not found \(404\)/);
    expect.soft(pv.text).toMatch(/Pixel px1 wasn't found on https:\/\/example.com\/visit/);
    const no = await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true, spend_confirmation: "₹500" });
    expect.soft(no.text).toMatch(/This launch turns ads on, but:\n- The ad account .* unsettled/);
    const prev = await tool("ad_previews", { batch_id: key, ad: adNo(batchId, "static-price") });
    readable(prev.text);
    expect.soft(prev.text).toMatch(/- Facebook Feed: https:\/\/mock\.facebook\.com\/ads\/api\/preview_iframe\.php/);
    expect.soft((prev.text.match(/https:\/\/mock\.facebook\.com/g) ?? []).length).toBe(6);
    const vid = await tool("ad_previews", { batch_id: key, ad: adNo(batchId, "hook-03") });
    readable(vid.text);
  });

  it("after launch: delivery_status for batch, campaign, ad set and plan; failure alerts; undo", async () => {
    const { accountId, batchId, key } = await preparedAccount();
    await tool("preview_batch", { batch_id: key });
    await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true });
    await runBatch(batchId, deps(accountId));
    const d1 = await tool("delivery_status", { batch_id: key });
    readable(d1.text);
    expect.soft(d1.text).toMatch(/Ad set "November test ad set" \(as1\): off/);
    expect.soft((d1.text.match(/ {2}Ad ".*" \(\d+\): in Meta review/g) ?? []).length).toBe(9);
    const d2 = await tool("delivery_status", { campaign: "c1" });
    expect.soft(d2.text).toMatch(/in Meta review/);
    const d3 = await tool("delivery_status", { campaign: "November tests" });
    expect.soft(d3.isError, `delivery_status by campaign name: ${d3.text}`).toBe(false);
    const p = await tool("plan_changes", { ops: [{ type: "create_adset", campaign: "c1", name: "TEST delivery", daily_budget: 300, destination: "WEBSITE", goal: "LINK_CLICKS", countries: ["IN"] }] });
    const k = planKeyIn(p.text);
    await tool("confirm_plan", { plan_id: k, confirm: true, accept_warnings: true });
    await workerRunsPlan(k);
    const d4 = await tool("delivery_status", { plan_id: k });
    expect.soft(d4.text, "delivery_status for a plan lists the ad set it made").toMatch(/TEST delivery/);
    // Failure alerts are on the home page; can Claude read them?
    expect.soft(toolNames.some((n) => /alert|problem|failure/i.test(n)), `tools: ${toolNames.join(", ")}`).toBe(true);
  });
});

// ======================================================================================
// 18 Nov incident: Meta refuses calls for the hourly limit
// ======================================================================================

describe("18 Nov incident · Meta's hourly limit (code 17 / 2446079)", () => {
  const THROTTLE = { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true };

  it("every tool answers within seconds with the plain 'Meta is limiting…' text", async () => {
    const { accountId, batchId, key } = await preparedAccount();
    // Something already launched, so the after-launch tools have work to show.
    await tool("preview_batch", { batch_id: key });
    await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true });
    await runBatch(batchId, deps(accountId));
    const plan = await tool("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", daily_budget: 520 }] });
    const pk = planKeyIn(plan.text);
    await tool("confirm_plan", { plan_id: pk, confirm: true, accept_warnings: true });
    await workerRunsPlan(pk);
    const fresh = await setupBatch(folder);
    const k2 = getBatch(fresh.batchId)!.key;
    const adId = getAds(batchId)[0].meta_ad_id!;
    // Caches cleared, as after the 2-minute / 5-minute expiry.
    db().prepare("DELETE FROM cache").run();

    // Meta refuses every call: the injected refusal, during Meta's own block window (reset in an hour).
    for (let i = 0; i < 2000; i++) mock.inject({ match: () => true, kind: "error", error: THROTTLE });
    Object.assign(mock as unknown as { blockedUntil: number }, { blockedUntil: clock.now() + 3_600_000 });

    const calls: [string, Record<string, unknown>][] = [
      ["connection_status", {}],
      ["list_destinations", { refresh: true }],
      ["list_campaigns", { refresh: true }],
      ["list_ads", { adset: "as1" }],
      ["get_details", { kind: "adset", id: "as1" }],
      ["lookup", { what: "custom_audiences" }],
      ["lookup", { what: "posts" }],
      ["delivery_status", { batch_id: key }],
      ["delivery_status", { campaign: "c1" }],
      ["delivery_status", { adset: "as1" }],
      ["delivery_status", { plan_id: pk }],
      ["ad_previews", { batch_id: k2, ad: adNo(fresh.batchId, "static-price") }],
      ["preview_batch", { batch_id: k2, ad_set: "as4" }],
      ["preview_batch", { batch_id: k2, go_live: "now" }],
      ["launch_batch", { batch_id: k2, confirm: true, accept_warnings: true, spend_confirmation: "₹800" }],
      ["plan_changes", { ops: [{ type: "edit_adset", adset: "as1", daily_budget: 530 }] }],
      ["plan_changes", { ops: [{ type: "edit_ad", ad: adId, name: "renamed" }] }],
      ["undo_plan", { plan_id: pk }],
      ["get_results", { level: "campaign", date_preset: "last_7d" }],
    ];
    const slow: string[] = [];
    const unclear: string[] = [];
    for (const [name, args] of calls) {
      const r = await tool(name, args);
      const label = `${name} ${JSON.stringify(args).slice(0, 60)}`;
      if (r.ms > 15_000) slow.push(`${label}: ${r.ms} ms`);
      if (!/Meta is limiting how often the launcher may call this ad account/.test(r.text)) unclear.push(`${label} → ${r.text.slice(0, 220).replace(/\n/g, " | ")}`);
      expect.soft(r.text, label).not.toContain("[object Object]");
      expect.soft(r.text, label).not.toMatch(/\n\s+at .+:\d+:\d+/);
    }
    expect.soft(slow, "tools slower than 15 s").toEqual([]);
    expect.soft(unclear, "tools that did not say 'Meta is limiting…'").toEqual([]);
  }, 120_000);

  it("after the block, the answers are right again (nothing wrong was cached during it)", async () => {
    const { key } = await preparedAccount();
    db().prepare("DELETE FROM cache").run();
    for (let i = 0; i < 50; i++) mock.inject({ match: () => true, kind: "error", error: THROTTLE });
    Object.assign(mock as unknown as { blockedUntil: number }, { blockedUntil: clock.now() + 3_600_000 });
    await tool("connection_status");
    await tool("preview_batch", { batch_id: key, go_live: "now" });
    // Meta allows calls again.
    (mock as unknown as { faults: unknown[] }).faults.length = 0;
    Object.assign(mock as unknown as { blockedUntil: number }, { blockedUntil: 0 });
    // The pacer's only state is the rate_state row since 19 Nov (M1): clear the block there.
    db().prepare("DELETE FROM rate_state").run();
    const c = await tool("connection_status");
    expect.soft(c.text, "Instagram is shown as allowed again").toMatch(/allowed for this ad account/);
    expect.soft(c.text).not.toMatch(/PROBLEM: Couldn't ask Meta/);
    const pv = await tool("preview_batch", { batch_id: key, go_live: "now" });
    expect.soft(pv.text, "the account check is not the cached 'couldn't ask Meta' warning").not.toMatch(/Couldn't ask Meta about the ad account's status/);
  });
});

describe("18 Nov incident · refusals while Meta's usage header says the score resets in a few seconds", () => {
  const THROTTLE = { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true };

  it("a tool that makes many calls still answers within 15 seconds", async () => {
    const { accountId, batchId, key } = await preparedAccount();
    await tool("preview_batch", { batch_id: key });
    await tool("launch_batch", { batch_id: key, confirm: true, accept_warnings: true });
    await runBatch(batchId, deps(accountId));
    const fresh = await setupBatch(folder);
    const k2 = getBatch(fresh.batchId)!.key;
    db().prepare("DELETE FROM cache").run();
    for (let i = 0; i < 500; i++) mock.inject({ match: () => true, kind: "error", error: THROTTLE });
    // X-Ad-Account-Usage: reset_time_duration 5 s (150 of 9,000 points used).
    Object.assign(mock as unknown as { score: number; scoreAt: number }, { score: 150, scoreAt: clock.now() });
    const slow: string[] = [];
    const calls: [string, Record<string, unknown>][] = [
      ["connection_status", {}],
      ["delivery_status", { batch_id: key }],
      ["ad_previews", { batch_id: k2, ad: adNo(fresh.batchId, "static-price") }],
    ];
    for (const [name, args] of calls) {
      const r = await tool(name, args);
      if (r.ms > 15_000) slow.push(`${name}: ${Math.round(r.ms / 1000)} s → ${r.text.slice(0, 80).replace(/\n/g, " | ")}`);
    }
    expect.soft(slow, "tools slower than 15 s").toEqual([]);
  }, 400_000);
});
