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

// The marketer's rows of 20 Nov 2026, Project Uday launch:
//  - "Missing ad settings and per-ad overrides": up to 5 descriptions per ad (set_ad_copy,
//    save_copy_template, edit_ad), shown in the preview and in list_ads.
//  - "Edit and copy existing ads": list_ads shows each ad's button and its image or video file.
// Claude's real tools → httpApi → the app's REAL route handlers in-process → service → the practice Meta.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
process.env.ALLOWED_EMAILS = "test@example.com";
const BASE = "http://launcher.r6";
const KEY = "sal_r6_marketer_key_0123456789";
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
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run(WHO, "r6", sha256(KEY), KEY.slice(-4));
});

async function claude() {
  const server = new McpServer({ name: "r6", version: "0" });
  registerTools(server, httpApi(BASE, KEY));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "r6", version: "0" });
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
const deps = (accountId: number) => ({ client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "r6-")) });
const planKey = (text: string) => /^Plan (\w+):/m.exec(text)?.[1] ?? "";
const rowOf = (text: string, n: number) => text.split("\n").find((x) => x.startsWith(`| ${n} |`)) ?? "";
const adBlock = (text: string, id: string) => text.split("\n- ").find((x) => x.includes(`(id ${id})`)) ?? "";
const adByName = (batchId: number, name: string) => getAds(batchId).find((a) => a.creative_name === name)!;
type Afs = { descriptions?: { text: string }[]; bodies?: { text: string }[] };
const creativeOf = (ad: AdRow) => mock.objects.get(ad.meta_creative_id!) as unknown as { asset_feed_spec?: Afs; object_story_spec?: { link_data?: { description?: string }; video_data?: { link_description?: string } } };
const FIVE = ["Plots from 20 lakh", "Site visit this Sunday", "RERA approved", "Near the new metro", "Loans from 7 banks"];

describe("U1 · up to 5 descriptions in a copy template", () => {
  it("save_copy_template keeps all 5; list_templates and the answer show them; the old single description still works", async () => {
    const { key } = await batch();
    const call = await claude();
    const s = await call("save_copy_template", { name: "Uday IMG1", primary_texts: ["T1", "T2", "T3"], headlines: ["H1", "H2", "H3", "H4", "H5"], descriptions: FIVE, link_url: "https://example.com/uday", cta: "LEARN_MORE", lead_form_id: "555000111" });
    expect(s.isError, s.text).toBe(false);
    expect(s.text).toMatch(/3 primary text\(s\), 5 headline\(s\), 5 description\(s\)/);
    expect(s.text).toContain(`Descriptions: ${FIVE.map((d, i) => `${i + 1}. "${d}"`).join(" ")}`);
    const l = await call("list_templates");
    expect(l.text).toMatch(/"Uday IMG1" \(id \d+\): 3 primary texts, 5 headlines, 5 descriptions,/);
    expect(l.text).toContain(`descriptions ${FIVE.map((d) => `"${d}"`).join(" | ")}`);
    // The app's Settings page reads the same list.
    expect(listTemplates().copy.find((c) => c.name === "Uday IMG1")!.descriptions).toEqual(FIVE);
    // The old field (one description) is still taken, as a list of one.
    const old = await call("save_copy_template", { name: "Old style", primary_texts: ["T"], headlines: ["H"], description: "One line", link_url: "https://example.com/o" });
    expect(old.text).toMatch(/1 description\(s\)/);
    expect(listTemplates().copy.find((c) => c.name === "Old style")!.descriptions).toEqual(["One line"]);
    // Editing a template without descriptions keeps them; [] clears them.
    await call("save_copy_template", { template: "Uday IMG1", headlines: ["Only one"] });
    expect(listTemplates().copy.find((c) => c.name === "Uday IMG1")!.descriptions).toEqual(FIVE);
    await call("save_copy_template", { template: "Uday IMG1", descriptions: [] });
    expect(listTemplates().copy.find((c) => c.name === "Uday IMG1")!.descriptions).toEqual([]);
    // The batch takes the template's list.
    await call("save_copy_template", { template: "Uday IMG1", headlines: ["H1", "H2", "H3", "H4", "H5"], descriptions: FIVE });
    const pv = await call("preview_batch", { batch_id: key, copy_template: "Uday IMG1" });
    expect(pv.text).toMatch(/^Copy: 3 primary text\(s\), 5 headline\(s\), LEARN_MORE → https:\/\/example\.com\/uday .*descriptions "Plots from 20 lakh" \| "Site visit this Sunday" \| "RERA approved" \| "Near the new metro" \| "Loans from 7 banks"/m);
    expect(rowOf(pv.text, 1)).toMatch(/3 texts, 5 headlines, 5 descriptions → /);
  }, 120_000);

  it("6 descriptions are refused, in Claude's tools and in the app", async () => {
    await batch();
    const call = await claude();
    const r = await call("save_copy_template", { name: "Six", primary_texts: ["T"], descriptions: [...FIVE, "Sixth"] });
    expect(r.isError).toBe(true);
    expect(() => saveCopyTemplate({ name: "Six", primaryTexts: ["T"], descriptions: [...FIVE, "Sixth"] })).toThrow(/Up to 5 descriptions \(6 given\)/);
    expect(listTemplates().copy.some((c) => c.name === "Six")).toBe(false);
  });
});

describe("U2 · 5 descriptions per ad: set_ad_copy → preview → Meta", () => {
  it("each ad's own 5 descriptions reach Meta in its creative; other ads keep the batch's description", async () => {
    const { key, batchId, accountId } = await batch();
    const call = await claude();
    const price = adByName(batchId, "static-price");
    const pair = adByName(batchId, "testimonial");
    const set = await call("set_ad_copy", {
      batch_id: key,
      rows: [
        { ad: "static-price", primary_texts: ["Price text"], headlines: ["Price headline"], descriptions: FIVE },
        { ad: "testimonial", descriptions: ["Pair desc 1", "Pair desc 2", "Pair desc 3"] },
      ],
    });
    expect(set.isError, set.text).toBe(false);
    const pv = await call("preview_batch", { batch_id: key });
    expect(rowOf(pv.text, price.position)).toMatch(/1 texts, 1 headlines, 5 descriptions → .*OWN COPY: .*descriptions "Plots from 20 lakh" [|/] "Site visit this Sunday"/);
    expect(rowOf(pv.text, pair.position)).toMatch(/5 texts, 5 headlines, 3 descriptions/);
    // Meta takes one description in a 9:16 + 4:5 ad: the preview says which one is used.
    expect(rowOf(pv.text, pair.position)).toMatch(/Warning: Meta takes one description in an ad with separate 9:16 and 4:5 files, so only the first is used: "Pair desc 1"\. The other 2 are left out\./);
    expect(rowOf(pv.text, price.position)).not.toMatch(/takes one description/);
    // An ad without its own copy shows the batch's one description (saved before 20 Nov as one string).
    const other = getAds(batchId).find((a) => a.id !== price.id && a.id !== pair.id)!;
    expect(rowOf(pv.text, other.position)).toMatch(/5 texts, 5 headlines, 1 descriptions → /);

    const warnings = Number(/(\d+) warning\(s\)\. Show/.exec(pv.text)?.[1] ?? 0);
    const go = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warnings });
    expect(go.isError, go.text).toBe(false);
    await runBatch(batchId, deps(accountId));
    expect(getAds(batchId).every((a) => a.status === "done"), JSON.stringify(getAds(batchId).map((a) => [a.creative_name, a.status, a.error]))).toBe(true);

    // One file, one text, one headline, 5 descriptions: Meta's text options carry all 5.
    const pc = creativeOf(adByName(batchId, "static-price"));
    expect(pc.asset_feed_spec?.descriptions?.map((d) => d.text)).toEqual(FIVE);
    expect(pc.object_story_spec?.link_data?.description).toBe(FIVE[0]);
    // A 9:16 + 4:5 pair: the first one (Meta refuses several there).
    expect(creativeOf(adByName(batchId, "testimonial")).asset_feed_spec?.descriptions?.map((d) => d.text)).toEqual(["Pair desc 1"]);
    // The batch's one description still goes out on the other ads.
    const oc = creativeOf(getAds(batchId).find((a) => a.id === other.id)!);
    const otherDescs = oc.asset_feed_spec?.descriptions?.map((d) => d.text) ?? [oc.object_story_spec?.link_data?.description ?? oc.object_story_spec?.video_data?.link_description];
    expect(otherDescs).toEqual(["Sahajta Estates"]);
  }, 120_000);

  it("6 descriptions for one ad are refused and nothing is saved", async () => {
    const { key, batchId } = await batch();
    const call = await claude();
    const r = await call("set_ad_copy", { batch_id: key, rows: [{ ad: "static-price", descriptions: [...FIVE, "Sixth"] }] });
    expect(r.isError).toBe(true);
    expect(adByName(batchId, "static-price").copy_override).toBeNull();
    // The app's own route (the copy sheet) says it plainly.
    const res = await fetch(`${BASE}/api/batches/${key}/copy`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ rows: [{ ad: "static-price", copy: { descriptions: [...FIVE, "Sixth"] } }] }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Up to 5 descriptions \(6 given\)\. Nothing was saved\./);
  });

  it("the copy sheet reads description_1 … description_5 (and a plain description column)", () => {
    const rows = parseCopySheet(`ad\tprimary_text_1\tdescription_1\tdescription_2\tdescription_3\tdescription_4\tdescription_5\n1\tText\t${FIVE.join("\t")}`);
    expect(rows[0].copy.descriptions).toEqual(FIVE);
    expect(parseCopySheet("ad\tdescription\n2\tJust one")[0].copy.descriptions).toEqual(["Just one"]);
  });
});

describe("U3 · copies saved before 20 Nov (one description) still work", () => {
  it("a batch copy, an ad's own copy and a template with the old single description read as a list of one", async () => {
    const { batchId } = await batch();
    const b = getBatch(batchId)! as BatchRow;
    expect(batchCopy({ ...b, copy: JSON.stringify({ ...LEAD_COPY, description: "Old batch line" }) }).descriptions).toEqual(["Old batch line"]);
    const ad = getAds(batchId)[0];
    expect(adCopy(b, { ...ad, copy_override: JSON.stringify({ description: "Old ad line" }) }).descriptions).toEqual(["Old ad line"]);
    // An old ad copy with an empty description uses the batch's.
    expect(adCopy({ ...b, copy: JSON.stringify({ ...LEAD_COPY, description: "Batch" }) }, { ...ad, copy_override: JSON.stringify({ description: "" }) }).descriptions).toEqual(["Batch"]);
    // A template row with only the old column filled.
    const accId = b.ad_account_id;
    db().prepare("INSERT INTO copy_templates (ad_account_id, name, primary_texts, headlines, description) VALUES (?, 'Old row', '[\"T\"]', '[]', 'Old template line')").run(accId);
    expect(listTemplates().copy.find((c) => c.name === "Old row")!.descriptions).toEqual(["Old template line"]);
  });

  it("migration 9 moves each saved template's description into the list", () => {
    const d = new Database(":memory:");
    for (const m of migrations.slice(0, 8)) d.exec(m);
    d.prepare("INSERT INTO ad_accounts (meta_account_id, name) VALUES ('act_1', 'A')").run();
    d.prepare("INSERT INTO copy_templates (ad_account_id, name, primary_texts, headlines, description) VALUES (1, 'With', '[]', '[]', ' Plots from 20 lakh ')").run();
    d.prepare("INSERT INTO copy_templates (ad_account_id, name, primary_texts, headlines, description) VALUES (1, 'Without', '[]', '[]', '')").run();
    d.exec(migrations[8]);
    const rows = d.prepare("SELECT name, description, descriptions FROM copy_templates ORDER BY name").all() as { name: string; description: string; descriptions: string }[];
    expect(rows).toEqual([
      { name: "With", description: " Plots from 20 lakh ", descriptions: '["Plots from 20 lakh"]' },
      { name: "Without", description: "", descriptions: "[]" },
    ]);
  });
});

describe("U4 · edit_ad with several descriptions", () => {
  it("an ad with text options gets the new list; an ad without them refuses several but takes one", async () => {
    const { key, batchId, accountId } = await batch();
    const call = await claude();
    await call("set_ad_copy", { batch_id: key, rows: [{ ad: "static-price", primary_texts: ["P"], headlines: ["H"], descriptions: ["Old 1", "Old 2"] }] });
    const pv = await call("preview_batch", { batch_id: key });
    await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: Number(/(\d+) warning\(s\)\. Show/.exec(pv.text)?.[1] ?? 0) });
    await runBatch(batchId, deps(accountId));
    const withOptions = adByName(batchId, "static-price");
    const p = await call("plan_changes", { ops: [{ type: "edit_ad", ad: withOptions.meta_ad_id, descriptions: ["New 1", "New 2", "New 3"] }] });
    expect(p.isError, p.text).toBe(false);
    expect(p.text).toMatch(/descriptions → "New 1", "New 2", "New 3"/);
    const k = planKey(p.text);
    const c = await call("confirm_plan", { plan_id: k, confirm: true, accept_warnings: true });
    expect(c.isError, c.text).toBe(false);
    expect(await runPlan(getPlan(k).id, { client: clientFor(accountId), clock })).toEqual({ done: 1, failed: 0 });
    const ad = mock.objects.get(withOptions.meta_ad_id!) as unknown as { creative_id: string };
    const cr = mock.objects.get(ad.creative_id) as unknown as { asset_feed_spec: Afs };
    expect(cr.asset_feed_spec.descriptions?.map((d) => d.text)).toEqual(["New 1", "New 2", "New 3"]);

    // A plain ad (one text, one headline, one description, no text options): several are refused at the check.
    mock.objects.set("cr_plain", { id: "cr_plain", _type: "creative", name: "plain", object_story_spec: { page_id: "p1", link_data: { message: "M", name: "N", description: "D", link: "https://example.com/p", image_hash: "h1", call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com/p" } } } } } as never);
    mock.objects.set("ad_plain", { id: "ad_plain", _type: "ad", name: "Plain ad", adset_id: "as1", creative_id: "cr_plain", status: "PAUSED", effective_status: "PAUSED" } as never);
    const many = await call("plan_changes", { ops: [{ type: "edit_ad", ad: "ad_plain", descriptions: ["A", "B"] }] });
    expect(many.text).toMatch(/"Plain ad" was made with one primary text, one headline and one description \(no text options\), so Meta can't take 2 descriptions on it/);
    const one = await call("plan_changes", { ops: [{ type: "edit_ad", ad: "ad_plain", descriptions: ["Only one"] }] });
    expect(one.text).not.toMatch(/no text options/);
    expect(one.text).toMatch(/description → "Only one"/);

    // A 9:16 + 4:5 ad (placement rules): several descriptions are refused at the check, one is fine.
    const pairAd = adByName(batchId, "testimonial").meta_ad_id!;
    const pairMany = await call("plan_changes", { ops: [{ type: "edit_ad", ad: pairAd, descriptions: ["A", "B"] }] });
    expect(pairMany.text).toMatch(/has separate 9:16 and 4:5 files, and Meta takes one description in such an ad \(2 given\)\. Give one description\./);
    const pairOne = await call("plan_changes", { ops: [{ type: "edit_ad", ad: pairAd, descriptions: ["Just this"] }] });
    expect(pairOne.text).not.toMatch(/takes one description/);
  }, 120_000);
});

describe("U5 · list_ads shows the button and the file", () => {
  it("after a launch: each ad's descriptions, its button and its file names, from the launcher's own record (no extra Meta read)", async () => {
    const { key, batchId, accountId } = await batch();
    const call = await claude();
    await call("set_ad_copy", { batch_id: key, rows: [{ ad: "static-price", descriptions: FIVE, cta: "SIGN_UP" }] });
    const pv = await call("preview_batch", { batch_id: key });
    await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: Number(/(\d+) warning\(s\)\. Show/.exec(pv.text)?.[1] ?? 0) });
    await runBatch(batchId, deps(accountId));
    const before = mock.calls.filter((x) => x.path.includes("adimages") && x.method === "GET").length;
    const r = await call("list_ads", { adset: "as1" });
    expect(r.isError, r.text).toBe(false);
    const price = adBlock(r.text, adByName(batchId, "static-price").meta_ad_id!);
    expect(price).toContain(`descriptions: ${FIVE.map((d) => `"${d}"`).join(" | ")}`);
    expect(price).toMatch(/button: sign up · file: image static-price_1x1\.jpg\n/);
    const pair = adBlock(r.text, adByName(batchId, "testimonial").meta_ad_id!);
    expect(pair).toMatch(/file: image testimonial_(story|feed)\.jpg, image testimonial_(story|feed)\.jpg/);
    const vid = adBlock(r.text, adByName(batchId, "hook-01").meta_ad_id!);
    expect(vid).toMatch(/button: learn more · file: video hook-01_(9x16|4x5)\.mp4, video hook-01_(9x16|4x5)\.mp4/);
    expect(r.text).not.toMatch(/undefined|null|name not known/);
    // Every file name came from the launcher's own record.
    expect(mock.calls.filter((x) => x.path.includes("adimages") && x.method === "GET").length).toBe(before);
  }, 120_000);

  it("an image the launcher didn't upload: its name from Meta's image library, in one read; if Meta is limiting calls, the list still answers", async () => {
    await batch();
    mock.objects.set("imgX", { id: "imgX", _type: "image", hash: "hX", name: "IMG2.png" } as never);
    mock.objects.set("cr_x", { id: "cr_x", _type: "creative", name: "x", object_story_spec: { page_id: "p1", link_data: { message: "M", name: "N", link: "https://example.com/x", image_hash: "hX", call_to_action: { type: "SIGN_UP", value: { link: "https://example.com/x" } } } } } as never);
    mock.objects.set("ad_x", { id: "ad_x", _type: "ad", name: "D IMG1 swapped to IMG2", adset_id: "as1", creative_id: "cr_x", status: "PAUSED", effective_status: "PAUSED" } as never);
    const call = await claude();
    const r = await call("list_ads", { adset: "as1" });
    expect(adBlock(r.text, "ad_x")).toMatch(/button: sign up · file: image IMG2\.png\n/);
    expect(mock.calls.filter((x) => x.path.includes("adimages") && x.method === "GET").length).toBe(1);
    // The image read is refused: the ads are still listed, the file by its hash.
    let first = true;
    mock.inject({ match: (m: string, p: string) => m === "GET" && p.includes("adimages") && (first ? !(first = false) : false), kind: "error", error: { message: "Invalid parameter", code: 100 } });
    const r2 = await call("list_ads", { adset: "as1" });
    expect(r2.isError, r2.text).toBe(false);
    expect(adBlock(r2.text, "ad_x")).toMatch(/file: image hX \(name not known\)/);
  }, 120_000);
});

describe("U6 · how the creative carries several descriptions", () => {
  const base: Copy = { primaryTexts: ["T"], headlines: ["H"], descriptions: ["D1", "D2"], cta: "LEARN_MORE", linkUrl: "https://example.com", utmTemplate: "" };
  const preset = { name: "p", pageId: "p1", pageName: "P", igUserId: "", igName: "", enhancements: {}, multiAdvertiser: false };
  it("one file with several descriptions needs text options; one description stays a plain ad", () => {
    expect(creativeShape({ assets: [{ kind: "image", slot: null, imageHash: "h" }], copy: base })).toBe("feed_spec_texts");
    expect(creativeShape({ assets: [{ kind: "image", slot: null, imageHash: "h" }], copy: { ...base, descriptions: ["D1"] } })).toBe("story_spec");
  });
  it("a carousel's card N gets description N, or the first", () => {
    const c = buildCreative({ name: "c", format: "carousel", copy: { ...base, headlines: ["H1", "H2", "H3"] }, urlTags: "", preset, assets: [1, 2, 3].map((i) => ({ kind: "image" as const, slot: null, imageHash: `h${i}` })) }) as { object_story_spec: { link_data: { child_attachments: { description?: string }[] } } };
    expect(c.object_story_spec.link_data.child_attachments.map((x) => x.description)).toEqual(["D1", "D2", "D1"]);
  });
});

describe("U7 · the whole-launch time (Launch on a schedule, retest 20 Nov, batch fscgv)", () => {
  // The real launch: 3 images into 4 ad sets said "about 5 minutes" and took 11. Each ad set's run first
  // looked for earlier work; Meta has no name filter for creatives, so that read up to 1,000 creatives
  // (11 reads) per ad set, on the starter tier's 45 points per 5 minutes.
  const STARTER = { capPoints: 60, tier: "development_access" };
  const starter = (accountDbId: number) => {
    const pacer = new Pacer(clock, undefined, undefined, 60);
    const client = new MetaClient({ token: "mock-token", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, pacer, clock });
    return { client, files: localFiles, clock, accountDbId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "r6-s-")) };
  };
  async function fourAdsets() {
    for (const i of [5, 6]) mock.objects.set(`as${i}`, { ...mock.objects.get("as4")!, id: `as${i}`, name: `Ad set ${i}` });
    const { accountId, batchId, key } = await batch();
    // Three image ads, as in fscgv.
    for (const a of getAds(batchId)) if (!["static-price", "static-team", "Static Offer"].includes(a.creative_name)) db().prepare("DELETE FROM ads WHERE id = ?").run(a.id);
    db().prepare("UPDATE assets SET ad_id = NULL WHERE ad_id NOT IN (SELECT id FROM ads)").run();
    await updateSettings(key, { extraAdsetIds: ["as4", "as5", "as6"] });
    // An ad account with a history: 450 creatives already.
    for (let i = 0; i < 450; i++) mock.objects.set(`old_cr_${i}`, { id: `old_cr_${i}`, _type: "creative", name: `Older creative ${i}` } as never);
    return { accountId, batchId, key };
  }

  it("3 images into 4 ad sets: no look-up reads on a first run, and the launch takes about what the preview said", async () => {
    const { accountId, batchId, key } = await fourAdsets();
    const est = buildPreview(batchId, {}, STARTER).estimate;
    expect(est.text).toMatch(/ for 12 ads in 4 ad sets /);
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    const group = siblings(getBatch(batchId)!);
    expect(group).toHaveLength(4);
    const from = mock.calls.length;
    const start = clock.now();
    const deps = starter(accountId);
    for (const b of group) expect(await runBatch(b.id, deps)).toEqual({ done: 3, failed: 0 });
    const minutes = (clock.now() - start) / 60_000;
    const calls = mock.calls.slice(from).filter((c) => !c.path.startsWith("rupload/"));
    // Nobody listed the 450 creatives (and no filter Meta refuses was sent); each ad set checked its ads once.
    expect(calls.filter((c) => c.method === "GET" && c.path.endsWith("/adcreatives"))).toHaveLength(0);
    expect(calls.filter((c) => c.method === "GET" && c.path.endsWith("/ads"))).toHaveLength(4);
    console.log(`fscgv again: ${calls.length} Meta calls, ${minutes.toFixed(1)} simulated minutes; the preview said "${est.text}"`);
    expect(minutes).toBeLessThan((est.seconds / 60) * 1.3);
    expect(minutes).toBeGreaterThan((est.seconds / 60) * 0.7);
  }, 120_000);

  it("a run after a try whose answer was lost still looks it up (and only then), finds it among 450 creatives, and the estimate counts that look-up", async () => {
    const { accountId, batchId, key } = await fourAdsets();
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    const group = siblings(getBatch(batchId)!);
    const ad = getAds(group[0].id)[0];
    // An earlier run sent the creative (the try is saved first), Meta made it, and the answer never came.
    db().prepare("UPDATE ads SET attempts = ? WHERE id = ?").run(JSON.stringify({ creative: 1 }), ad.id);
    mock.objects.set("cr_lost", { id: "cr_lost", _type: "creative", name: `Lost one [L:${ad.key}]` } as never);
    const w = launchWork(getBatch(group[0].id)!);
    expect(w.runReads).toBeGreaterThan(0); // the estimate counts this run's look-up
    const before = mock.calls.length;
    await runBatch(group[0].id, starter(accountId));
    const reads = mock.calls.slice(before).filter((c) => c.method === "GET" && c.path.endsWith("/adcreatives"));
    expect(reads.length).toBeGreaterThanOrEqual(5); // 450 + creatives, 100 a page
    expect(getAds(group[0].id).find((a) => a.id === ad.id)!.meta_creative_id).toBe("cr_lost");
    // The other ad sets' first runs only check their ads (one read each), no creative listing.
    expect(launchWork(getBatch(group[1].id)!).runReads).toBe(3);
  }, 120_000);
});

describe("U8 · review of 20 Nov: nothing made twice after a database restore, and the smaller points", () => {
  /** Real Meta may ignore the idempotency key (DECISIONS.md: "still rolling this out"): the look-ups alone must prevent repeats. */
  const noIdem: typeof fetch = (input, init) => {
    const h = new Headers(init?.headers);
    h.delete("x-client-idempotent-key");
    return mock.fetch(input, { ...init, headers: h });
  };
  const plainDeps = (accountDbId: number) => {
    const pacer = new Pacer(clock, undefined, undefined, 9000);
    const client = new MetaClient({ token: "mock-token", accountId: mock.accountId, version: "v26.0", fetch: noIdem, pacer, clock });
    return { client, files: localFiles, clock, accountDbId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "r6-r-")) };
  };
  /** What deploy/restore.sh does to a backup before it goes back in place. */
  const restoreFrom = (backup: Buffer) => {
    const d = new Database(backup);
    const sql = fs.readFileSync(path.join(__dirname, "../deploy/restore.sh"), "utf8").match(/sqlite3 "\$TMP\/launcher.db" "(UPDATE ads SET attempts[^"]+)"/)![1].replace(/\\\$/g, "$");
    d.exec(sql);
    setDb(d);
  };

  it("a restore from a backup taken before the launch ran: the next run finds every ad and creative in Meta, makes none again", async () => {
    const { accountId, batchId, key } = await batch();
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    const backup = db().serialize();
    const d = plainDeps(accountId);
    expect(await runBatch(batchId, d)).toEqual({ done: 9, failed: 0 });
    const made = { creatives: mock.of("creative").length, ads: mock.of("ad").length };
    restoreFrom(backup);
    expect(await runBatch(batchId, d)).toEqual({ done: 9, failed: 0 });
    expect({ creatives: mock.of("creative").length, ads: mock.of("ad").length }).toEqual(made);
    // The mark is used once: the run after reads no creatives.
    expect(getAds(batchId).every((a) => !JSON.parse(a.attempts || "{}").restored)).toBe(true);
  }, 120_000);

  it("a restore after a creative was made but its ad was not: the creative is found among the account's creatives, not made again", async () => {
    const { accountId, batchId, key } = await batch();
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    const backup = db().serialize();
    // Meta refuses every ad: the creatives are made, the ads are not.
    for (let i = 0; i < 100; i++) mock.inject({ match: (m: string, p: string) => m === "POST" && p.endsWith("/ads"), kind: "error", error: { message: "Invalid parameter", code: 100 } });
    const d = plainDeps(accountId);
    await runBatch(batchId, d);
    const creatives = mock.of("creative").length;
    expect(creatives).toBeGreaterThan(0);
    expect(mock.of("ad")).toHaveLength(0);
    (mock as unknown as { faults: unknown[] }).faults.length = 0;
    restoreFrom(backup);
    expect(await runBatch(batchId, d)).toEqual({ done: 9, failed: 0 });
    expect(mock.of("creative")).toHaveLength(creatives);
    expect(mock.of("ad")).toHaveLength(9);
  }, 120_000);

  it("Meta's reading of the hour gets older: the estimate counts what is left of it", async () => {
    const { accountLimits } = await import("@/lib/engine/preview");
    const { accountId } = await batch();
    const now = Date.now();
    const save = (pct: number, at: number) => db().prepare("INSERT OR REPLACE INTO rate_state (ad_account_id, state) VALUES (?, ?)").run(accountId, JSON.stringify({ capPoints: 60, log: [], lastBuc: { pct, at } }));
    save(100, now);
    expect(accountLimits(accountId, now).hourPct).toBe(100);
    save(100, now - 45 * 60_000);
    expect(accountLimits(accountId, now).hourPct).toBeCloseTo(25, 5);
    save(100, now - 61 * 60_000);
    expect(accountLimits(accountId, now).hourPct).toBeUndefined();
  });

  it("taking the same copy template again on a batch saved before 20 Nov is no change: no new creatives, no error on the ads", async () => {
    const { accountId, batchId, key } = await batch();
    const call = await claude();
    await call("save_copy_template", { name: "Old", primary_texts: ["Book a free site visit."], headlines: ["Free site visit"], description: "Sahajta Estates", link_url: "https://example.com/visit", cta: "LEARN_MORE", lead_form_id: "555000111" });
    const tpl = listTemplates().copy.find((c) => c.name === "Old")!;
    // The batch took this template before 20 Nov: its copy has the old single description.
    const { id: _i, name: _n, descriptions: _d, ...rest } = tpl;
    db().prepare("UPDATE batches SET copy = ?, copy_template_id = ?, status = 'failed' WHERE id = ?").run(JSON.stringify({ ...rest, description: "Sahajta Estates" }), tpl.id, batchId);
    const ad = getAds(batchId)[0];
    db().prepare("UPDATE ads SET status = 'failed', meta_creative_id = 'cr_kept', attempts = ? WHERE id = ?").run(JSON.stringify({ creative: 1 }), ad.id);
    const { updateSettings: upd } = await import("@/lib/service");
    await upd(key, { copyTemplateId: tpl.id });
    const after = getAds(batchId).find((a) => a.id === ad.id)!;
    expect(after.meta_creative_id).toBe("cr_kept");
    expect(after.error ?? "").not.toMatch(/changed after the failure/);
    void accountId;
  });

  it("a template whose description an older version changed after the upgrade (a rollback): that change is used", async () => {
    await batch();
    saveCopyTemplate({ name: "Two", primaryTexts: ["T"], descriptions: ["A", "B"] });
    expect(listTemplates().copy.find((c) => c.name === "Two")!.descriptions).toEqual(["A", "B"]);
    db().prepare("UPDATE copy_templates SET description = 'Changed by the old version' WHERE name = 'Two'").run();
    expect(listTemplates().copy.find((c) => c.name === "Two")!.descriptions).toEqual(["Changed by the old version"]);
    db().prepare("UPDATE copy_templates SET description = '' WHERE name = 'Two'").run();
    expect(listTemplates().copy.find((c) => c.name === "Two")!.descriptions).toEqual([]);
  });

  it("list_ads: a video carousel shows its videos only (not the cards' thumbnails), and 60 unknown images are named in 2 reads", async () => {
    await batch();
    const card = (v: string) => ({ name: "H", link: "https://example.com", video_id: v, image_hash: `thumb_${v}`, call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } } });
    mock.objects.set("cr_vc", { id: "cr_vc", _type: "creative", name: "vc", object_story_spec: { page_id: "p1", link_data: { message: "M", link: "https://example.com", child_attachments: [card("v1"), card("v2")] } } } as never);
    mock.objects.set("ad_vc", { id: "ad_vc", _type: "ad", name: "Video carousel", adset_id: "as1", creative_id: "cr_vc", status: "PAUSED", effective_status: "PAUSED" } as never);
    for (let i = 0; i < 60; i++) {
      mock.objects.set(`img_${i}`, { id: `img_${i}`, _type: "image", hash: `h${i}`, name: `IMG${i}.png` } as never);
      mock.objects.set(`cr_i${i}`, { id: `cr_i${i}`, _type: "creative", name: `i${i}`, object_story_spec: { page_id: "p1", link_data: { message: "M", link: "https://example.com", image_hash: `h${i}`, call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } } } } } as never);
      mock.objects.set(`ad_i${i}`, { id: `ad_i${i}`, _type: "ad", name: `Image ad ${i}`, adset_id: "as1", creative_id: `cr_i${i}`, status: "PAUSED", effective_status: "PAUSED" } as never);
    }
    const call = await claude();
    const before = mock.calls.length;
    const r = await call("list_ads", { adset: "as1" });
    expect(adBlock(r.text, "ad_vc")).toMatch(/file: video v1 \(name not known\), video v2 \(name not known\)\n/);
    expect(adBlock(r.text, "ad_i59")).toMatch(/file: image IMG59\.png\n/);
    expect(adBlock(r.text, "ad_i0")).toMatch(/file: image IMG0\.png\n/);
    expect(mock.calls.slice(before).filter((c) => c.method === "GET" && c.path.endsWith("/adimages"))).toHaveLength(2);
  }, 120_000);

  it("a carousel takes a headline and a description per card in edit_ad; several primary texts are refused plainly", async () => {
    await batch();
    const card = (h: string) => ({ name: h, description: "D", link: "https://example.com", image_hash: "h1", call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } } });
    mock.objects.set("cr_car", { id: "cr_car", _type: "creative", name: "car", object_story_spec: { page_id: "p1", link_data: { message: "M", link: "https://example.com", child_attachments: [card("A"), card("B")] } } } as never);
    mock.objects.set("ad_car", { id: "ad_car", _type: "ad", name: "Carousel ad", adset_id: "as1", creative_id: "cr_car", status: "PAUSED", effective_status: "PAUSED" } as never);
    const call = await claude();
    const ok = await call("plan_changes", { ops: [{ type: "edit_ad", ad: "ad_car", headlines: ["H1", "H2"], descriptions: ["D1", "D2"] }] });
    expect(ok.text).not.toMatch(/no text options|is a carousel/);
    // More than its 2 cards: said, not dropped without a word.
    const more = await call("plan_changes", { ops: [{ type: "edit_ad", ad: "ad_car", descriptions: ["D1", "D2", "D3"] }] });
    expect(more.text).toMatch(/"Carousel ad" is a carousel of 2 cards, so only the first 2 of the 3 descriptions are used \(card N gets number N\)\./);
    const bad = await call("plan_changes", { ops: [{ type: "edit_ad", ad: "ad_car", primary_texts: ["T1", "T2"] }] });
    expect(bad.text).toMatch(/"Carousel ad" is a carousel: it has one primary text \(each card has its own headline and description\)\. Give one primary text\./);
  }, 120_000);
});

describe("U9 · whatever edit_ad can change, list_ads shows (so every edit can be checked from Claude)", () => {
  // 20 Nov: list_ads showed the description and display link after a fix, then the button and the file were
  // found missing, then the UTM tags. This test covers the whole set: a new edit_ad field fails it until list_ads shows it.
  const SHOWN: Record<string, { value: unknown; shown: RegExp } | "covered elsewhere"> = {
    name: { value: "U9 renamed", shown: /^"U9 renamed" \(id ad_u9\)/m },
    status: { value: "PAUSED", shown: /· paused · /m },
    primary_texts: { value: ["U9 text"], shown: /texts: "U9 text"/ },
    headlines: { value: ["U9 headline"], shown: /headlines: U9 headline/ },
    descriptions: { value: ["U9 description"], shown: /descriptions: "U9 description"/ },
    description: "covered elsewhere", // the old single form of descriptions (U4)
    link_url: { value: "https://example.com/u9", shown: /link: https:\/\/example\.com\/u9 / },
    cta: { value: "SIGN_UP", shown: /button: sign up/ },
    display_link: { value: "example.com/u9", shown: /display link: example\.com\/u9/ },
    url_tags: { value: "utm_source=u9&utm_content={{ad.name}}", shown: /UTM tags: utm_source=u9&utm_content=\{\{ad\.name\}\}/ },
    media_url: "covered elsewhere", // a Drive file: list_ads shows the file by name (U5)
    tracking_pixels: { value: ["111222333444555"], shown: /tracking: website pixel [^\n]*111222333444555/ },
    tracking_offline: { value: ["777000111"], shown: /offline event set 777000111/ },
  };

  it("every documented edit_ad field, changed by a real plan run, is visible in list_ads", async () => {
    await batch();
    const { stepFieldsText } = await import("@/mcp/manage-tools");
    const documented = [...stepFieldsText("edit_ad").matchAll(/^- (\w+): /gm)].map((m) => m[1]).filter((k) => !["type", "ref", "ad"].includes(k));
    for (const f of documented) expect(SHOWN[f], `edit_ad.${f} is not checked here: show it in list_ads, then add it to SHOWN`).toBeDefined();
    mock.objects.set("cr_u9", { id: "cr_u9", _type: "creative", name: "u9 [L:r6u9-01]", url_tags: "utm_source=old", object_story_spec: { page_id: "p1", link_data: { message: "Old", name: "Old", description: "Old", caption: "old.com", link: "https://example.com/old", image_hash: "h1", call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com/old" } } } } } as never);
    mock.objects.set("ad_u9", { id: "ad_u9", _type: "ad", name: "Old name", adset_id: "as1", creative_id: "cr_u9", status: "PAUSED", effective_status: "PAUSED" } as never);
    const op: Record<string, unknown> = { type: "edit_ad", ad: "ad_u9" };
    for (const [f, x] of Object.entries(SHOWN)) if (x !== "covered elsewhere") op[f] = x.value;
    const call = await claude();
    const p = await call("plan_changes", { ops: [op] });
    expect(p.isError, p.text).toBe(false);
    const k = planKey(p.text);
    const conf = await call("confirm_plan", { plan_id: k, confirm: true, accept_warnings: true });
    expect(conf.isError, conf.text).toBe(false);
    const ran = await runPlan(getPlan(k).id, { client: clientFor(), clock });
    expect(ran, (await call("plan_status", { plan_id: k })).text).toEqual({ done: 1, failed: 0 });
    const r = await call("list_ads", { adset: "as1" });
    const block = adBlock(r.text, "ad_u9");
    for (const [f, x] of Object.entries(SHOWN)) if (x !== "covered elsewhere") expect(block, `edit_ad.${f} not visible in list_ads`).toMatch(x.shown);
  }, 120_000);
});
