import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db } from "@/lib/db";
import { resetFailed, runBatch } from "@/lib/engine/launcher";
import { buildPreview } from "@/lib/engine/preview";
import { DEFAULT_UTM } from "@/lib/engine/naming";
import { MockMeta, FakeClock } from "@/lib/meta/mock";
import { createPlan } from "@/lib/manage/service";
import { batchView, listTemplates, namingPattern, runPreview, saveCopyTemplate, saveNamingTemplate, updateSettings, type BatchSettings } from "@/lib/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { registerTools, type LauncherApi } from "@/mcp/tools";
import { fifteenFileFolder, freshDb, mockDeps, setupBatch } from "./helpers";

// Final check of the 17 Nov bug list: the expectations the other test files did not assert directly.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let folder: string;
let mock: MockMeta;
beforeAll(async () => {
  folder = await fifteenFileFolder();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => (String(url).startsWith("https://example.com") ? Promise.resolve(new Response("ok")) : real(url, init)));
}, 120_000);
beforeEach(() => {
  freshDb();
  mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
});

/** Claude's tools wired to the app's own service functions, the way the HTTP routes call them. */
async function claude() {
  const api: LauncherApi = {
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      const m = path.match(/^\/api\/batches\/([a-z0-9]+)(\/[a-z]+)?$/);
      if (m && method === "PATCH" && !m[2]) {
        await updateSettings(m[1], body as BatchSettings);
        return batchView(m[1]) as T;
      }
      if (m && method === "POST" && m[2] === "/preview") return (await runPreview(m[1])) as T;
      if (path === "/api/templates" && method === "GET") return listTemplates() as T;
      if (path === "/api/templates" && method === "POST") return { id: saveCopyTemplate(body as never) } as T;
      throw new Error(`not wired in this test: ${method} ${path}`);
    },
  };
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, api);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
}

describe("Schedule row: same ads into many ad sets from Claude (batch zrhtj)", () => {
  it("preview_batch with a list of ad sets uses all of them; no 'Pick an ad set'", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
    // As in zrhtj's first preview: nothing picked yet.
    updateBatch(batchId, { campaign_id: null, campaign_name: null, adset_id: null, adset_name: null });
    const key = getBatch(batchId)!.key;
    const tool = await claude();
    const r = await tool("preview_batch", { batch_id: key, ad_set: ["as1", "as4", "as3"] });
    expect(r.isError).toBe(false);
    expect(r.text).not.toMatch(/Pick an ad set|Pick a campaign/);
    const b = getBatch(batchId)!;
    expect(b.adset_id).toBe("as1");
    expect(b.campaign_id).toBeTruthy();
    expect((JSON.parse(b.extra_adsets ?? "[]") as { id: string }[]).map((x) => x.id)).toEqual(["as4", "as3"]);
  });
});

describe("Batch control row: a failed launch's empty ad set (batch rbqdz)", () => {
  it("is named in the result, and Retry puts the ad into that same ad set", async () => {
    const { accountId, batchId } = await setupBatch(folder, { mode: "new_per_ad" });
    const { mock: m, deps } = mockDeps(accountId);
    const dest = { adset: { id: "as1", name: "t", is_dynamic_creative: false } };
    buildPreview(batchId, dest, 60, { persist: true });
    m.inject({ match: (method, p) => method === "POST" && p.endsWith("/adcreatives"), kind: "error", error: { message: "Invalid parameter", code: 100, error_subcode: 1815199, error_user_msg: "This Instagram account can't be used." } });
    expect(await runBatch(batchId, deps)).toEqual({ done: 8, failed: 1 });
    const failed = getAds(batchId).find((a) => a.status === "failed")!;
    expect(failed.meta_adset_id).toBeTruthy();
    expect(failed.meta_ad_id).toBeFalsy();
    const view = buildPreview(batchId, dest, 60).ads.find((a) => a.id === failed.id)!;
    expect(view.leftover).toContain(`empty paused ad set (ID ${failed.meta_adset_id}`);
    expect(view.leftover).toContain("Retry failed");

    expect(resetFailed(batchId)).toBe(1);
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    const after = getAds(batchId).find((a) => a.id === failed.id)!;
    expect(after.meta_adset_id).toBe(failed.meta_adset_id);
    expect(m.of("adset").filter((s) => s.id !== "as1" && s.id !== "as2")).toHaveLength(9); // 9 ads, 9 copies, none twice
    expect(buildPreview(batchId, dest, 60).ads.every((a) => a.leftover === null)).toBe(true);
  });
});

describe("Copy row: one default UTM for every new copy template", () => {
  it("a template made from Claude and one made in the app get the same tags", async () => {
    const { accountId } = await setupBatch(folder);
    db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
    const tool = await claude();
    const r = await tool("save_copy_template", { name: "TEST – Uday multi-copy", primary_texts: ["one", "two"], headlines: ["A", "B"], link_url: "https://warmchain.sahajta.com", cta: "LEARN_MORE" });
    expect(r.isError).toBe(false);
    // The Settings page starts the field at DEFAULT_UTM and sends it; leaving it out gives the same.
    saveCopyTemplate({ name: "Site Visit", primaryTexts: ["x"], headlines: ["y"], linkUrl: "https://example.com", cta: "LEARN_MORE" } as never);
    const utms = (db().prepare("SELECT name, utm_template FROM copy_templates WHERE name IN ('TEST – Uday multi-copy', 'Site Visit')").all() as { utm_template: string }[]).map((x) => x.utm_template);
    expect(utms).toEqual([DEFAULT_UTM, DEFAULT_UTM]);
    // Editing a template from Claude without utm_template keeps its tags.
    await tool("save_copy_template", { template: "Site Visit", headlines: ["new"] });
    expect(db().prepare("SELECT utm_template FROM copy_templates WHERE name = 'Site Visit'").pluck().get()).toBe(DEFAULT_UTM);
  });
});

describe("Reuse posts row: what Meta takes, checked before the run", () => {
  it("an Instagram post made for an ad is refused in the check, with the fix; its Facebook post ID passes", async () => {
    const { accountId } = await setupBatch(folder);
    db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
    const bad = await createPlan({ ops: [{ type: "ads_from_post", post_id: "ig_555", source: "instagram", instagram_user_id: "ig1", adsets: ["as1"] }] }, "test@example.com", "claude");
    const msg = bad.summary!.checks.map((c) => c.message).join("\n");
    expect(bad.summary!.errors).toBe(1);
    expect(msg).toMatch(/Step 1: Meta doesn't take ig_555 as an Instagram post: it was made for an ad/);
    expect(msg).toMatch(/Reuse it with its Facebook post ID/);
    const good = await createPlan({ ops: [{ type: "ads_from_post", post_id: "p1_777", adsets: ["as1", "as4"] }] }, "test@example.com", "claude");
    expect(good.summary!.errors).toBe(0);
  });
});

describe("Campaigns row: the bid label of copied ad sets (plan pxrjw)", () => {
  it("a bid-cap ad set copied with its campaign still reads 'Bid cap at ₹12'", async () => {
    const { accountId } = await setupBatch(folder);
    db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
    const v = await createPlan({ ops: [
      { type: "create_campaign", ref: "c2", name: "TEST_C", objective: "OUTCOME_TRAFFIC", budget_level: "adset", bid_strategy: "LOWEST_COST_WITHOUT_CAP" },
      { type: "create_adset", ref: "a", campaign: "$c2", name: "R2 AS1", daily_budget: 100, destination: "WEBSITE", goal: "LINK_CLICKS", countries: ["IN"] },
      { type: "duplicate_adset", ref: "b", adset: "$a", changes: [{ name: "R2 AS2", daily_budget: 110 }, { name: "R2 AS3 bidcap12", daily_budget: 120, bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount: 12 }] },
      { type: "duplicate_campaign", campaign: "$c2", with_contents: true, changes: [{ name: "R2 campaign copy" }] },
    ] } as never, "test@example.com", "claude");
    expect(v.summary!.errors).toBe(0);
    const bids = v.summary!.adsets.filter((a) => a.name === "R2 AS3 bidcap12").map((a) => a.details.bid);
    expect(bids).toEqual(["Bid cap at ₹12", "Bid cap at ₹12"]); // the original and its copy in "R2 campaign copy"
    expect(v.summary!.adsets.filter((a) => a.name === "R2 AS2").map((a) => a.details.bid)).toEqual(["Highest volume (no cap)", "Highest volume (no cap)"]);
  });
});

describe("Naming row: a saved template by name or id", () => {
  it("a plan accepts the template's id as well as its name", async () => {
    const { accountId } = await setupBatch(folder);
    db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
    const id = saveNamingTemplate({ name: "TEST – campaign naming", kind: "campaign", pattern: "TEST_{date:YYMMDD}_{objective}_{n}" });
    expect(namingPattern(String(id))).toBe("TEST_{date:YYMMDD}_{objective}_{n}");
    expect(namingPattern(`#${id}`)).toBe("TEST_{date:YYMMDD}_{objective}_{n}");
    expect(namingPattern("{n}")).toBe("{n}");
    const v = await createPlan({ ops: [{ type: "create_campaign", name_template: String(id), objective: "OUTCOME_TRAFFIC", budget_level: "adset" }] }, "test@example.com", "claude");
    expect(v.summary!.steps[0].title).toMatch(/Create campaign "TEST_\d{6}_TRAFFIC_01"/);
  });
});
