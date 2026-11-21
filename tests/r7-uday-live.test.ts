import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sha256 } from "@/lib/crypto";
import { db, setDb } from "@/lib/db";
import { migrations } from "@/lib/db/schema";
import { MockMeta, FakeClock } from "@/lib/meta/mock";
import { clientFor } from "@/lib/meta/factory";
import { buildCreative, creativeShape } from "@/lib/meta/creative";
import { runBatch } from "@/lib/engine/launcher";
import { buildPreview, launchWork } from "@/lib/engine/preview";
import { siblings } from "@/lib/manage/golive";
import { MetaClient } from "@/lib/meta/client";
import { Pacer } from "@/lib/meta/pacer";
import { localFiles } from "@/lib/sources/local";
import { getPlan, runPlan } from "@/lib/manage/plan";
import { launchBatch, listTemplates, saveCopyTemplate, updateSettings } from "@/lib/service";
import { adCopy, batchCopy, getAds, getBatch } from "@/lib/store";
import { parseCopySheet } from "@/app/batches/[key]/copy-sheet";
import { httpApi, registerTools } from "@/mcp/tools";
import type { AdRow, BatchRow, Copy } from "@/lib/types";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// The marketer's rows after the live Project Uday launch (20–21 Nov 2026):
//  - "Missing campaign and ad set settings": the custom event and pixel named in every summary; languages by
//    name; WhatsApp (Status) placements and "Advantage+ without Audience Network"; placements platform by
//    platform; each ad's tracking set explicitly and shown.
//  - "Naming templates": {n:1} without a leading zero; no launch key in ad names; long copy flagged when set.
//  - "Push the launcher code…": each ad's tracking set explicitly (website pixel only by default).
// Claude's real tools → httpApi → the app's REAL route handlers in-process → service → the practice Meta.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
process.env.ALLOWED_EMAILS = "test@example.com";
const BASE = "http://launcher.r7";
const KEY = "sal_r7_marketer_key_0123456789";
const WHO = "test@example.com";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let mock: MockMeta;
let clock: FakeClock;
let folder: string;

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
    return new Response("<html>ok</html>"); // landing pages: the fake web, never the real internet
  });
}, 120_000);

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 90000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run(WHO, "r7", sha256(KEY), KEY.slice(-4));
});

async function claude() {
  const server = new McpServer({ name: "r7", version: "0" });
  registerTools(server, httpApi(BASE, KEY));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "r7", version: "0" });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
}

/** A draft batch of the 15-file folder into the practice ad set as1 (it collects leads: the copy has a lead form). */
async function batch() {
  const r = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(r.accountId);
  db().prepare("UPDATE batches SET copy = ? WHERE id = ?").run(JSON.stringify(LEAD_COPY), r.batchId);
  return { ...r, key: getBatch(r.batchId)!.key };
}
const deps = (accountId: number) => ({ client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "r7-")) });
const planKey = (text: string) => /^Plan (\w+):/m.exec(text)?.[1] ?? "";
const rowOf = (text: string, n: number) => text.split("\n").find((x) => x.startsWith(`| ${n} |`)) ?? "";
const adBlock = (text: string, id: string) => text.split("\n- ").find((x) => x.includes(`(id ${id})`)) ?? "";
const adByName = (batchId: number, name: string) => getAds(batchId).find((a) => a.creative_name === name)!;
type Afs = { descriptions?: { text: string }[]; bodies?: { text: string }[] };
const creativeOf = (ad: AdRow) => mock.objects.get(ad.meta_creative_id!) as unknown as { asset_feed_spec?: Afs; object_story_spec?: { link_data?: { description?: string }; video_data?: { link_description?: string } } };
const FIVE = ["Plots from 20 lakh", "Site visit this Sunday", "RERA approved", "Near the new metro", "Loans from 7 banks"];


const PIXEL_PLAN = { type: "create_adset", ref: "a1", campaign: "c1", name: "TC1.1 | TG1-CP1", daily_budget: 600, destination: "WEBSITE", goal: "OFFSITE_CONVERSIONS", event: "OTHER", custom_event_str: "QualifiedAfterCall", pixel_id: "px1", countries: ["IN"], age_min: 18, age_max: 65 };

/** A saved settings preset by name, as a batch keeps it. */
function listTemplatesPreset(name: string) {
  return listTemplates().presets.find((p) => p.name === name)!;
}

describe("V1 · the custom event and its pixel, by name, before and after", () => {
  it("the plan summary says \"Custom event: QualifiedAfterCall on pixel \"Site pixel\" (px1)\"; get_details and list_campaigns say it after the run", async () => {
    await batch();
    const call = await claude();
    const p = await call("plan_changes", { ops: [{ ...PIXEL_PLAN, languages: [6] }] });
    expect(p.isError, p.text).toBe(false);
    expect(p.text).toContain('Custom event: QualifiedAfterCall on pixel "Site pixel" (px1)');
    expect(p.text).toMatch(/language English \(US\)/);
    expect(p.text).not.toMatch(/give custom_event_str|language IDs/);
    const k = planKey(p.text);
    expect((await call("confirm_plan", { plan_id: k, confirm: true, accept_warnings: true })).isError).toBe(false);
    expect(await runPlan(getPlan(k).id, { client: clientFor(), clock })).toEqual({ done: 1, failed: 0 });
    const made = mock.of("adset").find((a) => a.name === "TC1.1 | TG1-CP1")!;
    const d = await call("get_details", { kind: "adset", id: made.id });
    expect(d.text).toContain('Custom event: QualifiedAfterCall on pixel "Site pixel" (px1)');
    expect(d.text).toMatch(/English \(US\) \(6\)/);
    const l = await call("list_campaigns", { refresh: true });
    expect(l.text).toContain('Custom event: QualifiedAfterCall on pixel "Site pixel" (px1)');
  }, 120_000);
});

describe("V2 · placements: WhatsApp Status, Advantage+ without Audience Network, platform by platform", () => {
  it("advantage_no_audience_network sends every platform but Audience Network (WhatsApp included) and says so; WhatsApp Status can be picked by hand; an unknown word is refused", async () => {
    await batch();
    const call = await claude();
    const p = await call("plan_changes", { ops: [{ ...PIXEL_PLAN, placements: "advantage_no_audience_network" }, { ...PIXEL_PLAN, ref: "a2", name: "TC1.2", placements: { platforms: ["facebook", "whatsapp"], facebook_positions: ["feed"], whatsapp_positions: ["status"] } }] });
    expect(p.isError, p.text).toBe(false);
    expect(p.text).toContain("Advantage+ without Audience Network: Facebook (all positions) · Instagram (all positions) · Messenger (all positions) · Threads (all positions) · WhatsApp (all positions)");
    expect(p.text).toContain("Placements: Facebook (feed) · WhatsApp (status)");
    const k = planKey(p.text);
    await call("confirm_plan", { plan_id: k, confirm: true, accept_warnings: true });
    expect(await runPlan(getPlan(k).id, { client: clientFor(), clock })).toEqual({ done: 2, failed: 0 });
    const t1 = mock.of("adset").find((a) => a.name === "TC1.1 | TG1-CP1")!.targeting as Record<string, unknown>;
    expect(t1.publisher_platforms).toEqual(["facebook", "instagram", "messenger", "threads", "whatsapp"]);
    expect(Object.keys(t1).filter((k2) => k2.endsWith("_positions"))).toEqual([]);
    const t2 = mock.of("adset").find((a) => a.name === "TC1.2")!.targeting as Record<string, unknown>;
    expect(t2).toMatchObject({ publisher_platforms: ["facebook", "whatsapp"], facebook_positions: ["feed"], whatsapp_positions: ["status"] });
    const bad = await call("plan_changes", { ops: [{ ...PIXEL_PLAN, placements: "everything_but_an" }] });
    expect(bad.text).toMatch(/placements "everything_but_an" is not one Meta knows here/);
  }, 120_000);
});

describe("V3 · names: {n:1}, no launch key in ad names, renamed ads still followed", () => {
  it("TC1.1.{n:1} names the ads TC1.1.1, TC1.1.2 …; Meta's ad names have no [L:…]; creatives keep it; review status is still read after the ads are renamed", async () => {
    const { key, batchId, accountId } = await batch();
    db().prepare("UPDATE batches SET ad_name_template = ? WHERE id = ?").run("TC1.1.{n:1} | {creative}", batchId);
    const call = await claude();
    const pv = await call("preview_batch", { batch_id: key });
    expect(pv.text).toMatch(/TC1\.1\.1 [|/] /);
    expect(pv.text).not.toMatch(/TC1\.1\.01/);
    await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: Number(/(\d+) warning\(s\)\. Show/.exec(pv.text)?.[1] ?? 0) });
    await runBatch(batchId, deps(accountId));
    const ads = mock.of("ad");
    expect(ads.length).toBeGreaterThan(0);
    expect(ads.map((a) => String(a.name)).sort()[0]).toMatch(/^TC1\.1\.1 \| /);
    expect(ads.every((a) => !String(a.name).includes("[L:"))).toBe(true);
    expect(mock.of("creative").every((c) => String(c.name).includes("[L:"))).toBe(true);
    // Renamed in Ads Manager, as after the live launch: the review check still finds every ad (by its ID).
    for (const a of ads) a.name = `Renamed ${a.id}`;
    const { checkReview } = await import("@/lib/engine/launcher");
    await checkReview(clientFor(accountId), batchId);
    expect(getAds(batchId).every((a) => a.effective_status !== "DELETED")).toBe(true);
  }, 120_000);

  it("the Campaigns page's bulk rename takes {n:1} too", async () => {
    const { renderName } = await import("@/app/manage/ads");
    expect(renderName("TC1.1.{n:1}", "x", 0, 15)).toBe("TC1.1.1");
    expect(renderName("TC1.1.{n}", "x", 0, 15)).toBe("TC1.1.01");
    expect(renderName("TC1.1.{n:3}", "x", 4, 15)).toBe("TC1.1.005");
  });
});

describe("V4 · copy over Meta's limits is flagged the moment it is set", () => {
  it("set_ad_copy and save_copy_template say which text is too long and by how much", async () => {
    const { key } = await batch();
    const call = await claude();
    const long = "x".repeat(1100);
    const s = await call("set_ad_copy", { batch_id: key, rows: [{ ad: 1, primary_texts: ["ok", long], headlines: ["h".repeat(260)] }] });
    expect(s.isError, s.text).toBe(false);
    expect(s.text).toMatch(/WARNING: ad 1: primary text 2 is 1,100 characters; Meta's limit is 1,024\. Saved, but the launch is refused until it is shortened\./);
    expect(s.text).toMatch(/WARNING: ad 1: headline is 260 characters; Meta's limit is 255/);
    const t = await call("save_copy_template", { name: "Long", primary_texts: [long], link_url: "https://example.com" });
    expect(t.text).toMatch(/WARNING: primary text is 1,100 characters; Meta's limit is 1,024\. Saved, but a launch with it is refused until it is shortened\./);
    const ok = await call("set_ad_copy", { batch_id: key, rows: [{ ad: 2, primary_texts: ["short"] }] });
    expect(ok.text).not.toMatch(/WARNING/);
  });
});

describe("V5 · each ad's tracking, set explicitly", () => {
  async function pixelAdset() {
    Object.assign(mock.objects.get("as1")!, { optimization_goal: "OFFSITE_CONVERSIONS", destination_type: "WEBSITE", promoted_object: { pixel_id: "px1", custom_event_type: "OTHER", custom_event_str: "QualifiedAfterCall" } });
  }

  it("a launch sets every ad's tracking to its ad set's pixel (saved at launch: no extra read), plus the preset's offline event sets; the summary says so", async () => {
    const { key, batchId, accountId } = await batch();
    await pixelAdset();
    // The offline event set: readable by the ad account, but not one of its pixels.
    mock.objects.set("555666777888999", { id: "555666777888999", _type: "dataset", name: "Offline set" } as never);
    const call = await claude();
    const preset = await call("save_settings_preset", { name: "Uday", page_id: "p1", page_name: "Sahajta AI", offline_event_set_ids: ["555666777888999"] });
    expect(preset.text).toMatch(/Tracking on each ad: the ad set's website pixel and offline event set 555666777888999/);
    const pv = await call("preview_batch", { batch_id: key, settings_preset: "Uday" });
    expect(pv.text).toMatch(/Tracking set on every ad by the launcher: website pixel "Site pixel" \(px1\); offline event set 555666777888999\./);
    await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: Number(/(\d+) warning\(s\)\. Show/.exec(pv.text)?.[1] ?? 0) });
    expect(getBatch(batchId)!.tracking_pixel).toBe("px1");
    const before = mock.calls.length;
    await runBatch(batchId, deps(accountId));
    // No read of the ad set's promoted object during the run (it was saved at launch).
    expect(mock.calls.slice(before).filter((c) => c.method === "GET" && c.path === "as1").length).toBe(0);
    for (const ad of mock.of("ad")) expect(ad.tracking_specs).toEqual([{ "action.type": ["offsite_conversion"], fb_pixel: ["px1"] }, { "action.type": ["offline_conversion"], dataset: ["555666777888999"] }]);
    const l = await call("list_ads", { adset: "as1" });
    expect(l.text).toMatch(/tracking: website pixel "Site pixel" \(px1\) · offline event set 555666777888999/);
  }, 120_000);

  it("a wrong offline event set ID in the preset is refused in the summary, before anything is made", async () => {
    const { key } = await batch();
    await pixelAdset();
    const call = await claude();
    await call("save_settings_preset", { name: "Wrong", page_id: "p1", page_name: "Sahajta AI", offline_event_set_ids: ["999999999"] });
    const pv = await call("preview_batch", { batch_id: key, settings_preset: "Wrong" });
    expect(pv.text).toMatch(/CHECK FAILED: The settings preset tracks offline event set 999999999, which this ad account can't use/);
    const go = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: 99 });
    expect(go.isError, go.text).toBe(true);
    expect(go.text).toMatch(/offline event set 999999999/);
    // A preset changed to it after a launch (the Retry path): the run itself sends nothing to Meta.
    const { batchId, accountId } = { batchId: getBatch((await import("@/lib/store")).getBatchByKey(key)!.id)!.id, accountId: getBatch((await import("@/lib/store")).getBatchByKey(key)!.id)!.ad_account_id };
    const wrong = listTemplatesPreset("Wrong");
    db().prepare("UPDATE batches SET preset = ?, status = 'queued' WHERE id = ?").run(JSON.stringify(wrong), batchId);
    const before = mock.calls.length;
    expect(await runBatch(batchId, deps(accountId))).toEqual({ done: 0, failed: 9 });
    expect(mock.calls.slice(before).filter((c) => c.method === "POST")).toHaveLength(0);
    expect(getAds(batchId)[0].error).toMatch(/offline event set 999999999, which this ad account can't use/);
  }, 120_000);

  it("a batch queued before this change (no saved pixel) reads it once; an ad set without a pixel gets no tracking set", async () => {
    const { key, batchId, accountId } = await batch();
    await pixelAdset();
    const call = await claude();
    const pv = await call("preview_batch", { batch_id: key });
    await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: Number(/(\d+) warning\(s\)\. Show/.exec(pv.text)?.[1] ?? 0) });
    db().prepare("UPDATE batches SET tracking_pixel = NULL WHERE id = ?").run(batchId);
    const before = mock.calls.length;
    await runBatch(batchId, deps(accountId));
    expect(mock.calls.slice(before).filter((c) => c.method === "GET" && c.path === "as1").length).toBe(1);
    expect(getBatch(batchId)!.tracking_pixel).toBe("px1");
    expect(mock.of("ad").every((a) => JSON.stringify(a.tracking_specs) === JSON.stringify([{ "action.type": ["offsite_conversion"], fb_pixel: ["px1"] }]))).toBe(true);
  }, 120_000);

  it("edit_ad changes a live ad's tracking (pixel only, offline set removed) without a new creative; Undo puts it back", async () => {
    await batch();
    const old = [{ "action.type": ["offsite_conversion"], fb_pixel: ["111222333444555"] }, { "action.type": ["offline_conversion"], dataset: ["555666777888999"] }, { "action.type": ["link_click"], post: ["1"] }];
    mock.objects.set("cr_live", { id: "cr_live", _type: "creative", name: "live [L:r7live-01]", object_story_spec: { page_id: "p1", link_data: { message: "M", link: "https://example.com", image_hash: "h1", call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } } } } } as never);
    mock.objects.set("ad_live", { id: "ad_live", _type: "ad", name: "TC1.1.1 | IMG1", adset_id: "as1", creative_id: "cr_live", status: "ACTIVE", effective_status: "ACTIVE", tracking_specs: old } as never);
    const call = await claude();
    const p = await call("plan_changes", { ops: [{ type: "edit_ad", ad: "ad_live", tracking_offline: [] }] });
    expect(p.isError, p.text).toBe(false);
    expect(p.text).toMatch(/tracking: offline event sets → none/);
    const k = planKey(p.text);
    await call("confirm_plan", { plan_id: k, confirm: true, accept_warnings: true });
    expect(await runPlan(getPlan(k).id, { client: clientFor(), clock })).toEqual({ done: 1, failed: 0 });
    const live = mock.objects.get("ad_live") as unknown as { creative_id: string; tracking_specs: unknown };
    expect(live.creative_id).toBe("cr_live"); // no new creative
    // The offline set is gone; the pixel and everything else Meta tracks on the ad stay.
    expect(live.tracking_specs).toEqual([{ "action.type": ["link_click"], post: ["1"] }, { "action.type": ["offsite_conversion"], fb_pixel: ["111222333444555"] }]);
    const u = await call("undo_plan", { plan_id: k });
    expect(u.isError, u.text).toBe(false);
    const uk = planKey(u.text);
    await call("confirm_plan", { plan_id: uk, confirm: true, accept_warnings: true });
    expect(await runPlan(getPlan(uk).id, { client: clientFor(), clock })).toEqual({ done: 1, failed: 0 });
    expect((mock.objects.get("ad_live") as unknown as { tracking_specs: unknown }).tracking_specs).toEqual(old);
  }, 120_000);
});
