import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { claimNext, LANES } from "@/lib/jobs";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { getAds, getBatch } from "@/lib/store";
import { httpApi, registerTools } from "@/mcp/tools";
import { runClaimed } from "@/worker/run";
import { runBatch } from "@/lib/engine/launcher";
import { MetaClient } from "@/lib/meta/client";
import { pacerFor } from "@/lib/meta/factory";
import { realClock, type Clock } from "@/lib/meta/pacer";
import { localFiles } from "@/lib/sources/local";
import { DEFAULT_UTM } from "@/lib/engine/naming";
import { LEAD_COPY, freshDb, setupBatch } from "./helpers";

// Final end-to-end journeys (19 Nov 2026): the seams between launches, go-live, plans, Claude's tools,
// pacing and shared creatives, the way the marketer works. Claude's real tools → httpApi → the app's REAL
// route handlers in-process → service → the practice Meta (MockMeta). The worker is driven with its own
// functions (claimNext + runClaimed). Nothing here calls the real Meta API.
// A failing test here is a finding: its name says what is wrong.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
const WHO = "shubhang@example.com";
process.env.ALLOWED_EMAILS = WHO;
const BASE = "http://launcher.final";
const KEY = "sal_final_journeys_key_0123";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
const LOG = path.join(os.tmpdir(), "final-journeys-output.txt");

let mock: MockMeta;
let clock: FakeClock;
let images: string;

// ---------- the app's routes, in-process ----------
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

/** Longest time one web request took (ms), and its path. */
let slowest = { ms: 0, path: "" };
/** Every web request: real time and time on the (fake) clock it took. */
let webTimes: { path: string; realMs: number; clockMs: number }[] = [];
async function dispatch(req: Request): Promise<Response> {
  const u = new URL(req.url);
  for (const r of table) {
    const m = r.re.exec(u.pathname);
    if (!m) continue;
    const mod = (await r.load()) as Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
    const h = mod[req.method];
    if (!h) return new Response("Method Not Allowed", { status: 405 });
    const t0 = performance.now();
    const f0 = Date.now();
    const res = await h(req, { params: Promise.resolve(Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]))) });
    const ms = performance.now() - t0;
    if (ms > slowest.ms) slowest = { ms, path: `${req.method} ${u.pathname}${u.search}` };
    webTimes.push({ path: `${req.method} ${u.pathname}${u.search}`, realMs: ms, clockMs: Date.now() - f0 });
    return res;
  }
  return new Response("404", { status: 404 });
}

beforeAll(async () => {
  images = path.join(os.tmpdir(), "final-three-images");
  fs.mkdirSync(images, { recursive: true });
  for (const [i, c] of ["#c33", "#3c3", "#33c"].entries()) {
    const f = path.join(images, `img-${i + 1}_1x1.jpg`);
    if (!fs.existsSync(f)) await sharp({ create: { width: 1080, height: 1080, channels: 3, background: c } }).jpeg().toFile(f);
  }
  fs.writeFileSync(LOG, "");
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
    const s = url instanceof Request ? url.url : String(url);
    if (s.startsWith(BASE)) return dispatch(new Request(s, init));
    if (s.startsWith("https://example.com")) return Promise.resolve(new Response("<html>ok</html>"));
    if (s.includes("gmail.googleapis.com")) return Promise.resolve(new Response("{}"));
    if (s.startsWith("https://graph.facebook.com")) throw new Error(`real Meta called: ${s}`);
    return real(url, init);
  });
}, 120_000);

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  clock.t = Date.now();
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true });
  g.__mockMeta = mock;
  slowest = { ms: 0, path: "" };
  webTimes = [];
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------- Claude ----------
async function claude() {
  const server = new McpServer({ name: "final", version: "0" });
  registerTools(server, httpApi(BASE, KEY));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "final", version: "0" });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const t0 = performance.now();
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content.map((c) => c.text).join("\n");
    fs.appendFileSync(LOG, `\n===== ${expect.getState().currentTestName} :: ${name} ${JSON.stringify(args).slice(0, 300)}\n${r.isError ? "[isError] " : ""}${text}\n`);
    return { text, isError: !!r.isError, ms: performance.now() - t0 };
  };
}

/** What a marketer must never read in an answer: undefined, NaN, raw objects or JSON, raw ISO or database times. */
function plain(text: string) {
  expect.soft(text, "no undefined/NaN/null words").not.toMatch(/\bundefined\b|\bNaN\b|\bnull\b/);
  expect.soft(text, "no [object Object]").not.toContain("[object Object]");
  expect.soft(text, "no raw JSON").not.toMatch(/\{"[a-z_]+":/);
  expect.soft(text, "no raw ISO / database time").not.toMatch(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d/);
}

/** The connected practice account, the default, with Claude's key. */
function account() {
  const id = db().prepare("SELECT id FROM ad_accounts LIMIT 1").pluck().get() as number;
  db().prepare("UPDATE ad_accounts SET is_default = 1, meta_user_name = 'Marketer' WHERE id = ?").run(id);
  if (!db().prepare("SELECT 1 FROM api_keys").get()) db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, 'Claude', ?, 'test')").run(WHO, sha256(KEY));
  return id;
}

/** A draft of the 3 images, with the lead form copy, made by the marketer. */
async function threeImages() {
  const r = await setupBatch(images);
  account();
  db().prepare("UPDATE batches SET copy = ?, created_by = ? WHERE id = ?").run(JSON.stringify(LEAD_COPY), WHO, r.batchId);
  return { ...r, key: getBatch(r.batchId)!.key };
}

/** A second campaign-budget ad set in c2 (paused), next to the practice account's as3. */
function addCboAdset(id = "as5", name = "CBO ad set 2") {
  mock.objects.set(id, { ...mock.objects.get("as3")!, id, name, status: "PAUSED", effective_status: "CAMPAIGN_PAUSED" });
}

/** The worker's launch lane: run every queued launch, in order. */
async function workerLaunches(max = 20) {
  let n = 0;
  for (let job = claimNext(LANES.launch); job && n < max; job = claimNext(LANES.launch), n++) await runClaimed(job);
  return n;
}

/** The worker's plan lane at a given time (ms). */
async function workerPlansAt(at: number) {
  let n = 0;
  for (let job = claimNext(LANES.plan, at); job; job = claimNext(LANES.plan, at), n++) await runClaimed(job);
  return n;
}

/** Tomorrow's date in India time, as YYYY-MM-DD. */
const istTomorrow = () => new Date(Date.now() + 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
const rupees = (s: string) => Number(s.replace(/[^\d.]/g, ""));
const minor = (x: unknown) => Number(x ?? 0) / 100;

/** What can spend in a day in the practice Meta now: ON campaigns' budgets, or their ON ad sets' budgets. */
function canSpendNow(): number {
  let total = 0;
  for (const c of mock.of("campaign").filter((c) => c.status === "ACTIVE")) {
    if (c.daily_budget) total += minor(c.daily_budget);
    else for (const a of mock.of("adset").filter((a) => a.campaign_id === c.id && a.status === "ACTIVE")) total += minor(a.daily_budget);
  }
  return total;
}

/** A note in the output log (console output of passing tests is hidden). */
const note = (s: unknown) => fs.appendFileSync(LOG, `\n----- note: ${typeof s === "string" ? s : JSON.stringify(s)}\n`);
const posted = (suffix: string, from = 0) => mock.calls.slice(from).filter((c) => c.method === "POST" && c.path.endsWith(suffix)).length;
const planRows = () => db().prepare("SELECT key, status, run_at, title FROM plans ORDER BY id").all() as { key: string; status: string; run_at: string | null; title: string }[];
/** Tomorrow 9 am IST as the marketer types it, and the same moment in ms. */
const nineTomorrow = () => ({ typed: `${istTomorrow()}T09:00`, ms: Date.parse(`${istTomorrow()}T09:00:00+05:30`) });
/** 3 images with Meta's own link tags (the launcher's default UTM), so one creative serves every ad set. */
async function threeImagesShared() {
  const b = await threeImages();
  db().prepare("UPDATE batches SET copy = ? WHERE id = ?").run(JSON.stringify({ ...LEAD_COPY, utmTemplate: DEFAULT_UTM }), b.batchId);
  return b;
}
const spendTyped = (preview: string) => /spend_confirmation: "([^"]+)"/.exec(preview)?.[1] ?? "";
const warningsIn = (preview: string) => Number(/accept_warnings: (\d+)/.exec(preview)?.[1] ?? 0);

describe("Journey 1 · 3 images into 4 ad sets (two campaigns, one with a campaign budget), turned on tomorrow 9 am", () => {
  it("preview → launch with the typed total → worker → batch_status at each stage → one turn-on plan at 9 am → everything on, total as typed", async () => {
    addCboAdset();
    const { key, accountId } = await threeImagesShared();
    void accountId;
    const call = await claude();
    const nine = nineTomorrow();

    // Preview: 12 ads in 4 ad sets, turned on at 9 am IST, total ₹2,300 (₹500 + ₹800 + campaign budget ₹1,000).
    const pv = await call("preview_batch", { batch_id: key, ad_set: ["as1", "as4", "as3", "as5"], go_live: "at", go_live_at: nine.typed });
    expect(pv.isError).toBe(false);
    plain(pv.text);
    expect(pv.text).toMatch(/TURNED ON at \d{1,2} Nov 2026, 09:00 am IST\./);
    expect(pv.text).toMatch(/Time estimate: about \d+ minutes? for 12 ads in 4 ad sets/);
    expect(pv.text).toContain("TOTAL daily budget: ₹2,300. Ads: 12.");
    const typed = spendTyped(pv.text);
    expect(typed).toBe("₹2,300");

    // Launch with the total typed back; the answer names every ad set of the launch.
    const l = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text), spend_confirmation: typed });
    expect(l.isError).toBe(false);
    plain(l.text);
    expect(l.text).toMatch(/turned on at \d{1,2} Nov 2026, 09:00 am IST\./);
    expect(l.text).toMatch(/Also launching \w+ → "Min-spend template", \w+ → "CBO ad set", \w+ → "CBO ad set 2"\./);
    expect(l.text).toMatch(/for 12 ads in 4 ad sets/);

    // Stage 1: queued. The estimate covers the whole launch; the turn-on time is said in IST.
    const s1 = await call("batch_status", { batch_id: key });
    plain(s1.text);
    expect(s1.text).toMatch(/^Batch \w+: Waiting to start\. 0 of 3 ads created\./);
    expect(s1.text).toMatch(/left for 12 ads in 4 ad sets/);
    expect(s1.text).toMatch(/turned on by a plan at \d{1,2} Nov 2026, 09:00 am IST once every ad is in/);

    // Stage 2: the worker made the first ad set's ads; the others are still queued.
    const from = mock.calls.length;
    await runClaimed(claimNext(LANES.launch)!);
    const s2 = await call("batch_status", { batch_id: key });
    plain(s2.text);
    expect(s2.text).toMatch(/3 of 3 ads created/);
    expect(s2.text).toMatch(/left for 9 ads in 3 ad sets/);
    expect(s2.text).toMatch(/turned on together with the other ad sets of this launch, once every ad is in there too/);
    expect(s2.text).not.toMatch(/Turned on by plan/);

    // Stage 3: every launch ran. Shared creatives: 3 uploads, 3 creatives, 3 posts for 12 ads, all paused.
    await workerLaunches();
    expect(posted("adimages", from)).toBe(3);
    expect(posted("adcreatives", from)).toBe(3);
    expect(mock.of("creative")).toHaveLength(3);
    expect(mock.of("ad")).toHaveLength(12);
    expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
    const ads = db().prepare("SELECT position, meta_post_id, meta_creative_id, meta_adset_id FROM ads").all() as { position: number; meta_post_id: string; meta_creative_id: string; meta_adset_id: string }[];
    expect(new Set(ads.map((a) => a.meta_post_id)).size).toBe(3);
    expect(new Set(ads.map((a) => a.meta_adset_id)).size).toBe(4);

    // One turn-on plan for the whole launch, confirmed, at 9 am IST tomorrow.
    const plans = planRows();
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe("queued");
    expect(Date.parse(plans[0].run_at!)).toBe(nine.ms);
    const keys = db().prepare("SELECT key FROM batches ORDER BY id").pluck().all() as string[];
    for (const k of keys) {
      const s = await call("batch_status", { batch_id: k });
      plain(s.text);
      expect(s.text).toContain(`Turned on by plan ${plans[0].key} (confirmed) at ${/(\d{1,2} Nov 2026, 09:00 am IST)/.exec(s.text)?.[1] ?? "?"}`);
      expect(s.text).toMatch(/at \d{1,2} Nov 2026, 09:00 am IST\. plan_status/);
    }
    const ps = await call("plan_status", { plan_id: plans[0].key });
    plain(ps.text);
    expect(ps.text).toMatch(/Status: Scheduled for \d{1,2} Nov 2026, 09:00 am IST\./);
    expect(ps.text).toContain(`What can spend once it has run: ${typed} a day`);

    // A minute before 9: nothing runs, nothing is on.
    expect(claimNext(LANES.plan, nine.ms - 60_000)).toBeUndefined();
    expect(canSpendNow()).toBe(0);

    // 9:01 am: the worker runs it. Everything on, and what can spend is exactly what was typed.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nine.ms + 60_000);
    expect(await workerPlansAt(nine.ms + 60_000)).toBe(1);
    expect(planRows()[0].status).toBe("done");
    expect(mock.of("ad").every((a) => a.status === "ACTIVE")).toBe(true);
    expect(["as1", "as4", "as3", "as5"].map((id) => mock.objects.get(id)!.status)).toEqual(["ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE"]);
    expect(["c1", "c2"].map((id) => mock.objects.get(id)!.status)).toEqual(["ACTIVE", "ACTIVE"]);
    expect(canSpendNow()).toBe(rupees(typed));
    const done = await call("plan_status", { plan_id: plans[0].key });
    plain(done.text);
    expect(done.text).toMatch(/Turned on 2 campaigns, 4 ad sets and 12 ads\./);
    const after = await call("batch_status", { batch_id: key });
    expect(after.text).toContain(`Turned on by plan ${plans[0].key} (done: the ads were turned on)`);
    note(`slowest web request: ${Math.round(slowest.ms)} ms ${slowest.path}`);
  }, 120_000);

  it("the pre-launch summary of a launch into two campaigns shows the second campaign and its ₹1,000 campaign budget (the typed ₹2,300 can be checked)", async () => {
    addCboAdset();
    const { key } = await threeImagesShared();
    const call = await claude();
    const pv = await call("preview_batch", { batch_id: key, ad_set: ["as1", "as4", "as3", "as5"], go_live: "at", go_live_at: nineTomorrow().typed });
    expect(pv.text).toContain("TOTAL daily budget: ₹2,300.");
    // ₹500 + ₹800 are on the ad set lines; the other ₹1,000 is CBO campaign's budget, which must be shown.
    expect(pv.text).toMatch(/Campaign: CBO campaign[^\n]*₹1,000 a day/);
  }, 120_000);

  it("an 'at a time' launch's estimate does not say the ads are turned on minutes after they are made", async () => {
    addCboAdset();
    const { key } = await threeImagesShared();
    const call = await claude();
    const pv = await call("preview_batch", { batch_id: key, ad_set: ["as1", "as4", "as3", "as5"], go_live: "at", go_live_at: nineTomorrow().typed });
    const est = /Time estimate: ([^\n]+)/.exec(pv.text)![1];
    note(est);
    // The ads are turned on at 9 am tomorrow, not "then about 5 minutes to turn them on" after they are made.
    expect(est).not.toMatch(/then (about \d+ minutes?|under a minute) to turn them on/);
  }, 120_000);

  it("Stop on another launch in the middle of its turn-on: the plan stops before the next item, nothing can spend, and the answers say so", async () => {
    const { st, plan, key, other, call } = await stopMidTurnOn();
    plain(st.text);
    expect(st.isError).toBe(false);
    expect(st.text).toMatch(new RegExp(`plan that turns its ads on \\(${plan.key}\\) was already running: it stops now, before the next item\\. What it already turned on stays on`));
    // Only the first ad was turned on; the campaign stays off, so nothing can spend.
    expect(mock.of("ad").filter((a) => a.status === "ACTIVE")).toHaveLength(1);
    expect(mock.objects.get("c3")!.status).toBe("PAUSED");
    expect(canSpendNow()).toBe(0);
    expect(planRows()[0].status).toBe("cancelled");
    const ps = await call("plan_status", { plan_id: plan.key });
    plain(ps.text);
    expect(ps.text).toMatch(/1 of 9 items turned on \(they stay on\); the other 8 were not changed, so the campaign stays off/);
    for (const k of [key, other]) {
      const s = await call("batch_status", { batch_id: k });
      plain(s.text);
      expect(s.text).toMatch(new RegExp(`the plan that was to turn the ads on \\(${plan.key}\\) was cancelled`));
      expect(s.text).not.toMatch(/are turned on by a plan|Turned on by plan/);
    }
  }, 120_000);

  it("plan_status of a turn-on the person stopped says it was stopped, not that a step failed", async () => {
    const { plan, call } = await stopMidTurnOn();
    const ps = await call("plan_status", { plan_id: plan.key });
    expect(ps.text).toContain("Status: Cancelled.");
    expect(ps.text).not.toMatch(/\b1 failed\b|: failed ·/);
  }, 120_000);

  it("after a Stop in the middle of the turn-on, batch_status does not say 'the ads stay paused' when one of its ads was turned on", async () => {
    const { key, call } = await stopMidTurnOn();
    const on = mock.of("ad").filter((a) => a.status === "ACTIVE").map((a) => a.id);
    expect(on).toHaveLength(1);
    const mine = getAds(db().prepare("SELECT id FROM batches WHERE key = ?").pluck().get(key) as number).map((a) => a.meta_ad_id);
    expect(mine).toContain(on[0]);
    const s = await call("batch_status", { batch_id: key });
    // Ad 1 of this batch is ON (its campaign is off, so it doesn't spend yet): "stay paused" is not true.
    expect(s.text).not.toMatch(/so the ads stay paused/);
  }, 120_000);
});

/**
 * Another launch (go live now) into a new paused campaign with two ad sets (₹300 + ₹400). While its
 * turn-on plan runs, right after Meta took the first "on", Claude presses Stop on the OTHER ad set's batch.
 */
async function stopMidTurnOn() {
  mock.objects.set("c3", { id: "c3", name: "Second launch", status: "PAUSED", objective: "OUTCOME_LEADS", special_ad_categories: [], _type: "campaign" } as never);
  for (const [id, budget] of [["as6", "30000"], ["as7", "40000"]] as const) mock.objects.set(id, { ...mock.objects.get("as4")!, id, name: `Second ${id}`, campaign_id: "c3", status: "PAUSED", daily_budget: budget, daily_min_spend_target: undefined } as never);
  const { key } = await threeImagesShared();
  const call = await claude();
  const pv = await call("preview_batch", { batch_id: key, ad_set: ["as6", "as7"], go_live: "now" });
  const typed = spendTyped(pv.text);
  expect(typed).toBe("₹700");
  expect((await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text), spend_confirmation: typed })).isError).toBe(false);
  await workerLaunches();
  const plan = planRows()[0];
  expect(plan.status).toBe("queued");
  const other = db().prepare("SELECT key FROM batches WHERE key != ?").pluck().get(key) as string;
  const orig = mock.fetch;
  let stop: { text: string; isError: boolean } | null = null;
  mock.fetch = async (input, init) => {
    const res = await orig(input, init);
    const body = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    if (!stop && (init?.method ?? "GET").toUpperCase() === "POST" && body?.get("status") === "ACTIVE") stop = await call("cancel_batch", { batch_id: other });
    return res;
  };
  await workerPlansAt(Date.now() + 1000);
  mock.fetch = orig;
  expect(stop).not.toBeNull();
  return { st: stop! as { text: string; isError: boolean }, plan, key, other, call };
}

/** A paused launch of the 3 images into as1 (the marketer's earlier work): ads to edit, copy and reuse the post of. */
async function earlierPausedLaunch(call: Awaited<ReturnType<typeof claude>>) {
  const b = await threeImagesShared();
  const pv = await call("preview_batch", { batch_id: b.key, ad_set: "as1" });
  await call("launch_batch", { batch_id: b.key, confirm: true, accept_warnings: warningsIn(pv.text) });
  await workerLaunches();
  return { ...b, ads: getAds(b.batchId) };
}

/** Journey 2's steps (copy_ad and edit_ad use two ads of the earlier paused launch). */
function journeyTwoOps(a1: { meta_post_id?: string | null }, a2: { meta_ad_id?: string | null }, copies = 3) {
  return [
    { type: "create_campaign", ref: "c", name: "Final CBO 300", objective: "OUTCOME_LEADS", budget_level: "campaign", daily_budget: 300 },
    { type: "create_adset", ref: "a", campaign: "$c", name: "Final base", min_daily_spend: 100, destination: "ON_AD", goal: "LEAD_GENERATION", page_id: "p1", countries: ["IN"], age_min: 25, age_max: 45 },
    { type: "duplicate_adset", ref: "copies", adset: "$a", copies, changes: Array.from({ length: copies }, (_, i) => ({ name: `Final copy ${i + 1}`, min_daily_spend: 250 })) },
    { type: "create_custom_audience", ref: "web", name: "Final site visitors", source: { kind: "website", pixel_id: "px1", days: 30 } },
    { type: "create_lookalike", ref: "lal", name: "Final LAL 1%", source_audience: "$web", country: "IN", size_percent: 1 },
    { type: "ads_from_post", ref: "fp", post_id: a1.meta_post_id, adsets: ["$a"], name: "Final from post" },
    { type: "copy_ad", ref: "cp", ad: a2.meta_ad_id, adsets: ["$copies.1"] },
    { type: "edit_ad", ad: a2.meta_ad_id, headlines: ["Final headline"], description: "Plots from 20 lakh", display_link: "sahajta.com/visit" },
    { type: "set_status", status: "ACTIVE", whole_campaigns: ["$c"] },
  ];
}
const planKeyOf = (text: string) => /^Plan (\w+):/.exec(text)?.[1] ?? "";
/** Meta refuses the 3rd ad set copy (not a spend-limit refusal: the step stops). */
function refuseThirdCopy() {
  let n = 0;
  mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/copies") && ++n === 3, kind: "error", error: { message: "Too many ad sets", code: 1487, error_user_title: "Ad set limit", error_user_msg: "This ad account has reached its limit of ad sets." } });
}
const inCampaign = (campaignId: string) => mock.of("adset").filter((x) => x.campaign_id === campaignId);

/**
 * Journey 2 up to the finished retry (the plan's campaign is on). Answers are checked in the journey
 * test; here only what later journeys need.
 */
async function journeyTwoMade(call: Awaited<ReturnType<typeof claude>>) {
  const earlier = await earlierPausedLaunch(call);
  const [a1, a2] = earlier.ads;
  const ops = journeyTwoOps(a1, a2);
  const p = await call("plan_changes", { title: "Final journey plan", ops });
  const key = planKeyOf(p.text);
  await call("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true, spend_confirmation: "₹300" });
  refuseThirdCopy();
  await workerPlansAt(Date.now() + 1000);
  const r = await call("retry_plan", { plan_id: key, ops: journeyTwoOps(a1, a2, 1) });
  await call("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true, spend_confirmation: spendTyped(r.text) });
  await workerPlansAt(Date.now() + 1000);
  const campaign = mock.of("campaign").find((c) => c.name === "Final CBO 300")!;
  return { earlier, a1, a2, key, campaign };
}

describe("Journey 2 · one plan: campaign, min-spend ad sets in a ₹300 campaign budget, audiences, ads, turned on", () => {
  it("plan_changes → plan_status → confirm_plan → Meta refuses mid-way → retry_plan with fewer copies → run → undo_plan; true numbers, plain words", async () => {
    const call = await claude();
    const earlier = await earlierPausedLaunch(call);
    const [a1, a2] = earlier.ads;
    const oldCreative = a2.meta_creative_id!;

    // The plan: summary first, the money first.
    const p = await call("plan_changes", { title: "Final journey plan", ops: journeyTwoOps(a1, a2) });
    expect(p.isError).toBe(false);
    plain(p.text);
    const key = planKeyOf(p.text);
    expect(p.text).toContain("TOTAL daily budget at the end of this plan (every ad set once, at its final budget, plus campaign budgets): ₹300. 1 campaign(s), 4 new ad set(s), 2 ad(s).");
    expect(p.text).toContain('TURNS ON: campaign "Final CBO 300" with 4 ad sets and 2 ads. Daily budget able to spend afterwards: ₹300.');
    expect(p.text).toContain("To run it, the person types ₹300");
    // The minimums that can't all fit are said before anything runs (the marketer's B1/B4).
    expect(p.text).toMatch(/minimum daily spends adding up to ₹850 \("Final base" ₹100, "Final copy 1" ₹250, "Final copy 2" ₹250, "Final copy 3" ₹250\), more than its ₹300 daily budget/);
    expect(p.text).toContain("People who visited the website with pixel px1 in the last 30 days.");
    expect(p.text).toMatch(/Step 7: Copy ad "[^"]+" into 1 ad set\n\s+Same creative, so the same post/);
    expect(p.text).toMatch(/Step 8: Edit ad "[^"]+"\n\s+headline → "Final headline"; description → "Plots from 20 lakh"; display link → sahajta\.com\/visit/);
    const view = await call("plan_status", { plan_id: key });
    plain(view.text);
    expect(view.text).toContain("Status: Waiting for your confirmation.");
    expect((await call("plan_status", {})).text).toMatch(new RegExp(`${key}: Final journey plan · Waiting for your confirmation · 9 step\\(s\\) · made \\d{1,2} Nov 2026, \\d\\d:\\d\\d [ap]m IST`));

    // A wrong total is refused, in words that tell Claude not to type it itself.
    const wrong = await call("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true, spend_confirmation: "₹1,150" });
    expect(wrong.isError).toBe(true);
    plain(wrong.text);
    expect(wrong.text).toMatch(/Never fill in spend_confirmation yourself/);
    const c = await call("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true, spend_confirmation: "₹300" });
    expect(c.isError).toBe(false);
    expect(c.text).toContain("Status: Confirmed, waiting to run.");

    // The worker runs it; Meta refuses the 3rd copy. Steps 1–2 and 2 copies are made, nothing is on.
    refuseThirdCopy();
    await workerPlansAt(Date.now() + 1000);
    const failed = await call("plan_status", { plan_id: key });
    plain(failed.text);
    expect(failed.text).toContain("Status: Some steps failed.");
    expect(failed.text).toContain("Steps: 2 done, 1 failed, 6 skipped (of 9).");
    expect(failed.text).toMatch(/3\. Copy ad set "Final base" 3 times into "Final CBO 300": failed · Step 3 failed\. Meta said: "Ad set limit: This ad account has reached its limit of ad sets\." \(code 1487\)\. Made before it stopped: 2 items \(kept, paused; Retry continues from here\)/);
    const camp = mock.of("campaign").find((x) => x.name === "Final CBO 300")!;
    expect(camp.status).toBe("PAUSED");
    expect(inCampaign(camp.id).map((x) => x.status)).toEqual(["PAUSED", "PAUSED", "PAUSED"]);
    expect(canSpendNow()).toBe(0);

    // Retry with one copy: the second copy made before the stop is not used and stays off.
    const r = await call("retry_plan", { plan_id: key, ops: journeyTwoOps(a1, a2, 1) });
    expect(r.isError).toBe(false);
    plain(r.text);
    expect(r.text).toContain("Step 3 now makes 1 copy, but it made 2 before it stopped. The last one is not used and is turned off when the plan runs");
    expect(r.text).toContain('TURNS ON: campaign "Final CBO 300" with 2 ad sets and 2 ads. Daily budget able to spend afterwards: ₹300.');
    const typed = spendTyped(r.text);
    expect(typed).toBe("₹300");
    await call("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true, spend_confirmation: typed });
    const creativesBefore = posted("adcreatives");
    await workerPlansAt(Date.now() + 1000);
    const done = await call("plan_status", { plan_id: key });
    plain(done.text);
    expect(done.text).toContain("Status: Done.");
    expect(done.text).toMatch(/Copy 1: Meta refused the minimum daily spend of ₹250 asked for it \(the minimum daily spends of the ad sets in "Final CBO 300" would add up to more than its ₹300 a day\), so that minimum was left out; it has a minimum daily spend of ₹100\./);
    expect(done.text).toMatch(/Turned on 1 campaign, 2 ad sets and 2 ads\./);

    // What can spend is what was typed; nothing is on that wasn't counted.
    expect(canSpendNow()).toBe(rupees(typed));
    const sets = inCampaign(camp.id);
    expect(sets.map((x) => [x.name, x.status])).toEqual([["Final base", "ACTIVE"], ["Final copy 1", "ACTIVE"], ["Final copy 2", "PAUSED"]]);
    expect(sets.filter((x) => x.status === "ACTIVE").reduce((t, x) => t + minor(x.daily_min_spend_target), 0)).toBeLessThanOrEqual(300);
    // copy_ad used the original creative (same post); only edit_ad made a new creative.
    const copied = mock.of("ad").find((x) => x.adset_id === sets[1].id)!;
    expect(copied.creative_id).toBe(oldCreative);
    expect(posted("adcreatives", 0) - creativesBefore).toBe(2); // ads_from_post's creative + edit_ad's new one
    expect(mock.objects.get(a2.meta_ad_id!)!.creative_id).not.toBe(oldCreative);

    // Undo: no typed total, everything the plan turned on goes off, the old creative goes back.
    const u = await call("undo_plan", { plan_id: key });
    expect(u.isError).toBe(false);
    plain(u.text);
    expect(u.text).toContain("No typed total is needed");
    const uk = planKeyOf(u.text);
    await call("confirm_plan", { plan_id: uk, confirm: true, accept_warnings: true });
    const before = posted("adcreatives");
    await workerPlansAt(Date.now() + 1000);
    expect((await call("plan_status", { plan_id: uk })).text).toContain("Status: Done.");
    expect(camp.status).toBe("PAUSED");
    expect(canSpendNow()).toBe(0);
    expect(mock.of("ad").filter((x) => x.status === "ACTIVE")).toHaveLength(0);
    expect(mock.objects.get(a2.meta_ad_id!)!.creative_id).toBe(oldCreative);
    expect(posted("adcreatives") - before).toBe(0);
  }, 120_000);

  it("the lookalike step names its source audience (\"Final site visitors\"), not the plan's internal \"$web\"", async () => {
    const call = await claude();
    const { ads } = await earlierPausedLaunch(call);
    const p = await call("plan_changes", { ops: journeyTwoOps(ads[0], ads[1]) });
    expect(p.text).toMatch(/1% of people in IN most like audience "?Final site visitors"?/);
  }, 120_000);

  it("the copy step shows the ₹250 minimum asked for each copy, not the field name \"min_daily_spend\"", async () => {
    const call = await claude();
    const { ads } = await earlierPausedLaunch(call);
    const p = await call("plan_changes", { ops: journeyTwoOps(ads[0], ads[1]) });
    const step3 = p.text.split("Step 3:")[1].split("Step 4:")[0];
    expect(step3).not.toContain("min_daily_spend");
    expect(step3).toMatch(/Copy 1: "Final copy 1"[^\n]*minimum ₹250/);
  }, 120_000);

  it("plan titles use plain words: no \"Already done: create adset\" after a retry, no \"9 steps: create campaign, create adset, duplicate adset…\" as a default title", async () => {
    const call = await claude();
    const { key, a1, a2 } = await journeyTwoMade(call);
    const s = await call("plan_status", { plan_id: key });
    expect.soft(s.text, "finished steps after a retry").not.toMatch(/Already done: create (adset|campaign)/);
    const untitled = await call("plan_changes", { ops: journeyTwoOps(a1, a2) });
    expect.soft(/^Plan \w+: (.+?)\. Status:/m.exec(untitled.text)?.[1] ?? "", "default title").not.toMatch(/create adset|duplicate adset|set status/);
  }, 120_000);

  it("undo_plan's summary is clean: a plain title, one turn-off step, and putting the old creative back is not called 'a new creative'", async () => {
    const call = await claude();
    const { key } = await journeyTwoMade(call);
    const u = await call("undo_plan", { plan_id: key });
    const title = /^Plan \w+: (.+?)\. Status:/m.exec(u.text)?.[1] ?? "";
    expect.soft(title, "title").not.toMatch(/stays \(it spends nothing/);
    expect.soft((u.text.match(/^Step \d+: Turn off:/gm) ?? []).length, "turn-off steps").toBe(1);
    const restore = u.text.split(/Step \d+: Edit ad/)[1] ?? "";
    expect.soft(restore, "restoring the old creative").not.toMatch(/A new creative is made/);
    expect.soft(u.text, "audiences named by name").toMatch(/"Final LAL 1%"|Final LAL 1%/);
  }, 120_000);
});

describe("Journey 4 · results, delivery and lists on what was made", () => {
  it("list_campaigns, list_ads, delivery_status and get_results tell the truth about the plan's campaign and the edited ads", async () => {
    const call = await claude();
    const { a2, key, campaign } = await journeyTwoMade(call);
    const cl = await call("list_campaigns", { campaign: "Final CBO 300" });
    plain(cl.text);
    expect(cl.text).toMatch(/Campaign "Final CBO 300" \(id \d+\) · active · Leads · budget ₹300 a day \(campaign budget\)/);
    expect(cl.text).toMatch(/Ad set "Final base" \(id \d+\) · active · campaign budget · spend limits: minimum ₹100 a day, no maximum/);
    expect(cl.text).toMatch(/Ad set "Final copy 1" \(id \d+\) · active · campaign budget · spend limits: minimum ₹100 a day, no maximum/);
    expect(cl.text).toMatch(/Ad set "Final copy 2" \(id \d+\) · paused · campaign budget · spend limits: minimum ₹100 a day, no maximum/);

    // The edited ad: paused · in review, its new headline, description and display link.
    const l1 = await call("list_ads", { adset: "November test ad set" });
    plain(l1.text);
    const edited = l1.text.split("\n- ").find((x) => x.includes(`(id ${a2.meta_ad_id})`)) ?? "";
    expect(edited).toMatch(/· paused · in review ·/);
    expect(edited).toMatch(/headlines: Final headline\n {2}descriptions: "Plots from 20 lakh"/);
    expect(edited).toMatch(/display link: sahajta\.com\/visit/);
    // The copy and the ad from the post: on, on the original posts.
    const l2 = await call("list_ads", { adset: "Final copy 1" });
    plain(l2.text);
    expect(l2.text).toMatch(/· on · [a-z ]+ · post ID p1_1003/);
    const l3 = await call("list_ads", { adset: "Final base" });
    plain(l3.text);
    expect(l3.text).toMatch(/"Final from post" \(id \d+\) · on · [a-z ]+ · runs an existing post · post ID p1_1001/);

    // Delivery: by plan and by campaign name.
    const d1 = await call("delivery_status", { plan_id: key });
    plain(d1.text);
    note(d1.text);
    expect(d1.text).toMatch(/Ad set "Final base"/);
    expect(d1.text).toMatch(/Ad set "Final copy 1"/);
    const d2 = await call("delivery_status", { campaign: "Final CBO 300" });
    plain(d2.text);
    expect(d2.text).toMatch(/Ad set "Final base" \(\d+\): delivering \(on\)\n  Ad "Final from post" \(\d+\): delivering \(on\)/);
    expect(d2.text).toMatch(/Ad set "Final copy 2" \(\d+\): off/);

    // Results of the campaign by ad, in rupees, with a total row. (The practice Meta answers every ad
    // whatever the filter, so the check is that the launcher asks Meta for this campaign's ads only.)
    const orig = mock.fetch;
    const asked: string[] = [];
    mock.fetch = async (input, init) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u.includes("/insights")) asked.push(decodeURIComponent(u));
      return orig(input, init);
    };
    const r = await call("get_results", { level: "ad", ids: campaign.id, ids_level: "campaign", date_preset: "last_7d", metrics: ["spend", "impressions", "actions:lead", "cost:lead"] });
    plain(r.text);
    note(r.text);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Results by ad, /);
    expect(r.text).toMatch(/\| TOTAL \| ₹[\d,]+ \| [\d,]+ \| \d+ \| ₹[\d.,]+ \|/);
    mock.fetch = orig;
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]).toMatch(new RegExp(`"field":"campaign\\.id","operator":"IN","value":\\["${campaign.id}"\\]`));
  }, 120_000);

  it("delivery_status for a plan does not show the edited ad (it is in another ad set) under the plan's last ad set", async () => {
    const call = await claude();
    const { a2, key } = await journeyTwoMade(call);
    const d = await call("delivery_status", { plan_id: key });
    // a2 is in "November test ad set"; the answer must not indent it under "Final copy 2" (a paused copy it has nothing to do with).
    expect(d.text).not.toMatch(new RegExp(`Ad set "Final copy 2"[^\\n]*\\n  Ad "[^"]+" \\(${a2.meta_ad_id}\\)`));
  }, 120_000);
});

/** "about 1 hour 5 minutes" / "about 12 minutes" / "under a minute" → seconds. */
function durationSec(t: string): number {
  if (/under a minute/.test(t)) return 30;
  const h = /about (\d+) hours?/.exec(t);
  const m = /(\d+) minutes?/.exec(t.replace(/about \d+ hours?/, ""));
  return (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0);
}

/**
 * One timeline for everything (Date, the launcher's realClock used by the web pacer, the worker and the
 * practice Meta), so the starter tier's 5-minute window and Claude's 25-second limit are real on it.
 * `hook` runs while the worker waits 20 s or more for Meta.
 */
function starterTimeline() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now());
  const ctl: { hook: ((ms: number) => Promise<void>) | null } = { hook: null };
  let inHook = false;
  const timeline: Clock = {
    now: () => Date.now(),
    sleep: async (ms: number) => {
      if (ctl.hook && !inHook && ms >= 20_000) {
        inHook = true;
        try {
          await ctl.hook(ms);
        } finally {
          inHook = false;
        }
      }
      vi.setSystemTime(Date.now() + ms);
    },
  };
  const saved = { now: realClock.now, sleep: realClock.sleep };
  Object.assign(realClock, timeline);
  mock = new MockMeta({ clock: timeline, capPoints: 60, hourlyCalls: 300, richAccount: true, allowActive: true });
  g.__mockMeta = mock;
  const ids = ["as1", "as4"];
  for (let i = 5; ids.length < 15; i++) {
    mock.objects.set(`as${i}`, { ...mock.objects.get("as4")!, id: `as${i}`, name: `Ad set ${i}` });
    ids.push(`as${i}`);
  }
  return { timeline, ctl, ids, restore: () => Object.assign(realClock, saved) };
}

describe("Journey 3 · the starter tier (60 points / 5 minutes): a 45-ad launch while Claude keeps asking", () => {
  it("launch_batch into 15 ad sets, two minutes after preview_batch, is not refused for 'couldn't check' warnings that only the launcher's own pacing caused", async () => {
    const t = starterTimeline();
    try {
      const { key } = await threeImagesShared();
      const call = await claude();
      const pv = await call("preview_batch", { batch_id: key, ad_set: t.ids });
      expect(warningsIn(pv.text)).toBe(3);
      vi.setSystemTime(Date.now() + 120_000); // the person reads the summary
      const l = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: 3 });
      note(l.text.split("\n").slice(0, 3).join("\n"));
      expect(l.text).not.toMatch(/Couldn't check how many ads/);
      expect(l.isError).toBe(false);
    } finally {
      t.restore();
    }
  }, 300_000);

  it("every answer while the launch waits for Meta is plain and honest, and no web request waits past 25 s", async () => {
    const t = starterTimeline();
    try {
      const { key, accountId } = await threeImagesShared();
      const call = await claude();
      const pv = await call("preview_batch", { batch_id: key, ad_set: t.ids });
      plain(pv.text);
      const est = /Time estimate: ([^\n]+?)\.\n/.exec(pv.text)![1];
      expect(est).toMatch(/for 45 ads in 15 ad sets \(Meta's limit on this ad account sets the pace/);
      // The person reads the summary, says yes; new "couldn't check" warnings are shown and accepted (see the test above).
      vi.setSystemTime(Date.now() + 120_000);
      let l = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text) });
      plain(l.text);
      for (let i = 0; l.isError && i < 3; i++) {
        vi.setSystemTime(Date.now() + 60_000);
        l = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: Number(/accepting (\d+) warnings/.exec(l.text)?.[1] ?? 0) });
      }
      expect(l.isError).toBe(false);

      // While the worker waits for Meta, Claude asks the usual questions.
      const answers: { name: string; text: string; isError: boolean }[] = [];
      const leftSaid: { at: number; sec: number; text: string }[] = [];
      let waits = 0;
      t.ctl.hook = async () => {
        waits++;
        if (waits % 2) return;
        const s = await call("batch_status", { batch_id: key });
        answers.push({ name: "batch_status", ...s });
        const left = /\. (About [^.]+ left for [^.(]+)/.exec(s.text)?.[1];
        if (left) leftSaid.push({ at: Date.now(), sec: durationSec(left.toLowerCase()), text: left.trim() });
        for (const [name, args] of [
          ["list_campaigns", {}],
          ["list_ads", { adset: "as1" }],
          ["delivery_status", { batch_id: key }],
          ["plan_changes", { ops: [{ type: "edit_adset", adset: "as1", name: "Renamed while launching" }] }],
        ] as const) answers.push({ name, ...(await call(name, args as Record<string, unknown>)) });
      };

      // The worker's launch lane (its own client on the same shared pacer; it waits as long as Meta asks).
      const t0 = Date.now();
      const worker = new MetaClient({ token: "mock", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, pacer: pacerFor(accountId), clock: t.timeline });
      const deps = { client: worker, files: localFiles, clock: t.timeline, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "final-starter-")) };
      for (const id of db().prepare("SELECT id FROM batches ORDER BY id").pluck().all() as number[]) {
        const job = claimNext(LANES.launch);
        expect(job?.batch_id).toBe(id);
        await runBatch(id, deps);
        db().prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(job!.id);
      }
      t.ctl.hook = null;
      const tEnd = Date.now();
      const minutes = (tEnd - t0) / 60_000;
      expect(mock.of("ad")).toHaveLength(45);
      expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
      expect(mock.of("creative")).toHaveLength(3);
      const longest = webTimes.reduce((m, w) => (w.clockMs > m.clockMs ? w : m), { path: "", clockMs: 0, realMs: 0 });
      note({ minutes, estimate: est, waits, refusedByMeta: mock.throttled, answers: answers.length, errors: answers.filter((a) => a.isError).map((a) => a.name), longestWebWait: longest, leftSaid: leftSaid.map((x) => [`${Math.round((tEnd - x.at) / 60_000)} min really left`, x.text]) });

      // Meta never refused a call: the pacer kept the launch under the limit while Claude asked.
      expect(mock.throttled).toBe(0);
      // Every answer is plain: a normal answer, or the plain "Meta is limiting… try again after" words.
      expect(answers.length).toBeGreaterThan(5);
      for (const a of answers) {
        plain(a.text);
        expect.soft(a.text, `${a.name}: no raw error`).not.toMatch(/WaitTooLong|SqliteError|code 17\b|code 80004|\bat .+:\d+:\d+/);
        if (a.isError) expect.soft(a.text, `${a.name}: an error says why and when`).toMatch(/Meta is limiting how often the launcher may call this ad account[^\n]*Try again after about \d{1,2}:\d\d [ap]m IST|This took too long/);
      }
      // No web request waited past 25 s on the launcher's clock.
      expect(longest.clockMs).toBeLessThanOrEqual(25_000);
      // The time left batch_status gave was honest: between half and double the time really left.
      expect(leftSaid.length).toBeGreaterThan(1);
      for (const x of leftSaid) {
        const real = (tEnd - x.at) / 1000;
        if (real < 120) continue;
        expect.soft(x.sec / real, `"${x.text}" with ${Math.round(real / 60)} minutes really left`).toBeGreaterThan(0.5);
        expect.soft(x.sec / real, `"${x.text}" with ${Math.round(real / 60)} minutes really left`).toBeLessThan(2);
      }
      // The estimate before the launch was honest too.
      expect(minutes / (durationSec(est) / 60), `estimate "${est}" vs ${minutes.toFixed(1)} minutes`).toBeLessThan(1.6);
      expect(minutes / (durationSec(est) / 60), `estimate "${est}" vs ${minutes.toFixed(1)} minutes`).toBeGreaterThan(0.5);
    } finally {
      t.restore();
    }
  }, 300_000);
});
