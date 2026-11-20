import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetFailed, runBatch } from "@/lib/engine/launcher";
import { buildPreview, moveAsset } from "@/lib/engine/preview";
import { buildCreative } from "@/lib/meta/creative";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { localFiles } from "@/lib/sources/local";
import { createPlan, confirmPlan, undoPlan, updatePlan, planView } from "@/lib/manage/service";
import { getPlan, runPlan, summarise, type PlanInput } from "@/lib/manage/plan";
import { saveAppSettings } from "@/lib/appsettings";
import { batchView, namingPattern, regroupFile, setAdCopyBy, updateSettings } from "@/lib/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { fifteenFileFolder, freshDb, setupBatch } from "./helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every bug the marketer logged on 17 Nov 2026, reproduced on the fake Meta (which now refuses the same
// things the real one did), plus the new features from the same round.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let folder: string;
let clock: FakeClock;
let mock: MockMeta;
beforeAll(async () => {
  folder = await fifteenFileFolder();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => (String(url).startsWith("https://example.com") ? Promise.resolve(new Response("ok")) : real(url, init)));
}, 120_000);
beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
});

const WHO = "test@example.com";
async function batch() {
  const { accountId, batchId } = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
  return { accountId, batchId, key: getBatch(batchId)!.key, deps: { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "v3-")) } };
}
async function account() {
  const { accountId } = await batch();
  return accountId;
}
async function runConfirmed(key: string, spend?: string) {
  await confirmPlan(key, { confirm: true, acceptWarnings: true, spendConfirmation: spend }, WHO);
  const id = getPlan(key).id;
  return runPlan(id, { client: clientFor(), clock });
}
const adsetsIn = (campaignId: string) => mock.of("adset").filter((a) => a.campaign_id === campaignId);

describe("Copy: several primary texts and headlines (batch zrhtj)", () => {
  it("one file with 2 texts and 2 headlines is a link ad plus text options, so Meta's 'link is required' can't happen", () => {
    const preset = { name: "p", pageId: "p1", pageName: "", igUserId: "ig1", igName: "", enhancements: {}, multiAdvertiser: false };
    const copy = { primaryTexts: ["one", "two"], headlines: ["A", "B"], descriptions: ["d"], cta: "LEARN_MORE", linkUrl: "https://warmchain.sahajta.com", utmTemplate: "", displayLink: "warmchain.sahajta.com" };
    const c = buildCreative({ name: "n", copy, urlTags: "", preset, assets: [{ kind: "image", slot: null, imageHash: "h" }] }) as { object_story_spec: { link_data: Record<string, unknown> }; asset_feed_spec: { bodies: unknown[]; titles: unknown[]; optimization_type: string } };
    expect(c.object_story_spec.link_data.link).toBe("https://warmchain.sahajta.com");
    expect(c.object_story_spec.link_data.message).toBe("one");
    expect(c.object_story_spec.link_data.caption).toBe("warmchain.sahajta.com");
    expect(c.asset_feed_spec.bodies).toHaveLength(2);
    expect(c.asset_feed_spec.titles).toHaveLength(2);
    expect(c.asset_feed_spec.optimization_type).toBe("DEGREES_OF_FREEDOM");
  });

  it("carousel: each file a card with its own headline; Threads profile and partnership go on the creative", () => {
    const preset = { name: "p", pageId: "p1", pageName: "", igUserId: "ig1", igName: "", enhancements: {}, multiAdvertiser: false, threadsUserId: "777", sponsorPageId: "888" };
    const copy = { primaryTexts: ["one"], headlines: ["Card A", "Card B"], descriptions: [], cta: "LEARN_MORE", linkUrl: "https://x.com", utmTemplate: "" };
    const c = buildCreative({ name: "n", format: "carousel", copy, urlTags: "", preset, assets: [{ kind: "image", slot: "feed", imageHash: "h1" }, { kind: "image", slot: "feed", imageHash: "h2" }, { kind: "video", slot: "feed", videoId: "v1", thumbnailUrl: "https://t" }] }) as { branded_content_sponsor_page_id: string; object_story_spec: { threads_user_id: string; link_data: { child_attachments: { name: string; image_hash?: string; video_id?: string }[] } } };
    expect(c.branded_content_sponsor_page_id).toBe("888");
    expect(c.object_story_spec.threads_user_id).toBe("777");
    expect(c.object_story_spec.link_data.child_attachments.map((x) => x.name)).toEqual(["Card A", "Card B", "Card A"]);
    expect(c.object_story_spec.link_data.child_attachments[2].video_id).toBe("v1");
  });

  it("a carousel ad in a batch: checked (2 to 10 files) and launched as one ad", async () => {
    const { batchId, key, deps } = await batch();
    const two = getAds(batchId).find((a) => db().prepare("SELECT COUNT(*) FROM assets WHERE ad_id = ?").pluck().get(a.id) === 2)!;
    setAdCopyBy(key, [{ ad: two.position, copy: { format: "carousel" } as never }]);
    const p = buildPreview(batchId, {}, 9000);
    const ad = p.ads.find((a) => a.id === two.id)!;
    expect(ad.checks.some((c) => c.code === "slot_clash")).toBe(false);
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    const cr = mock.objects.get(getAds(batchId).find((a) => a.id === two.id)!.meta_creative_id!)!;
    expect((cr.body as { object_story_spec: { link_data: { child_attachments: unknown[] } } }).object_story_spec.link_data.child_attachments).toHaveLength(2);
  });

  it("a whole batch where every ad has 5 texts and 5 headlines goes through (the fake Meta refuses the old shape)", async () => {
    const { batchId, deps } = await batch();
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
  });
});

describe("Plans: refs to what earlier steps make (plan psx4n)", () => {
  it("create a campaign, an ad set in it with no bid strategy, 3 copies, then edit them, in one plan", async () => {
    await account();
    const input: PlanInput = {
      expected_daily_total: 120 + 150 + 200 + 250,
      ops: [
        { type: "create_campaign", ref: "c1", name_template: "TEST_{date:YYMMDD}_{objective}_{n}", objective: "OUTCOME_TRAFFIC", budget_level: "adset" },
        { type: "create_adset", ref: "a1", campaign: "$c1", name: "TEST AS1", daily_budget: 100, destination: "WEBSITE", goal: "LINK_CLICKS", countries: ["IN"] },
        { type: "duplicate_adset", ref: "dups", adset: "$a1", changes: [{ name: "AS2", daily_budget: 150 }, { name: "AS3", daily_budget: 200, bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount: 10 }, { name: "AS4", daily_budget: 250, genders: "women" }] },
        { type: "edit_adset", adset: "$a1", name: "TEST AS1 edited", daily_budget: 120 },
        { type: "edit_adset", adset: "$dups.3", age_min: 30 },
      ],
    };
    const v = await createPlan(input, WHO, "claude");
    expect(v.summary!.checks.filter((c) => c.level === "error")).toEqual([]);
    // Each ad set once, at its final budget: 120 (not 100 + 120) + 150 + 200 + 250.
    expect(v.summary!.totals.dailyBudget).toBe(720);
    expect(v.summary!.adsets.map((a) => [a.name, a.dailyBudget])).toEqual([["TEST AS1 edited", 120], ["AS2", 150], ["AS3", 200], ["AS4", 250]]);
    expect(v.summary!.steps[1].lines.join(" ")).toMatch(/Highest volume/);
    expect(await runConfirmed(v.key)).toEqual({ done: 5, failed: 0 });
    const camp = mock.of("campaign").find((c) => String(c.name).startsWith("TEST_"))!;
    expect(camp.bid_strategy).toBeUndefined(); // ABO: no bid strategy on the campaign (Meta 1885737)
    const sets = adsetsIn(camp.id);
    expect(sets.map((a) => a.name).sort()).toEqual(["AS2", "AS3", "AS4", "TEST AS1 edited"]);
    expect(sets.find((a) => a.name === "TEST AS1 edited")!.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP");
    expect(Number(sets.find((a) => a.name === "TEST AS1 edited")!.daily_budget)).toBe(12000);
    expect((sets.find((a) => a.name === "AS4")!.targeting as { age_min: number }).age_min).toBe(30);
    expect(sets.every((a) => a.status === "PAUSED")).toBe(true);
  });

  it("explains a bad ref: unknown, out of range, or the wrong kind", async () => {
    await account();
    const v = await createPlan({ ops: [
      { type: "create_campaign", ref: "c1", name: "C", objective: "OUTCOME_LEADS", budget_level: "adset" },
      { type: "create_adset", ref: "a1", campaign: "$c1", name: "A", daily_budget: 100, goal: "LEAD_GENERATION" },
      { type: "edit_adset", adset: "$nope", daily_budget: 5 },
      { type: "edit_adset", adset: "$a1.2", daily_budget: 5 },
      { type: "edit_adset", adset: "$c1", daily_budget: 5 },
      { type: "create_adset", ref: "a1", campaign: "$c1", name: "B", daily_budget: 100, goal: "LEAD_GENERATION" },
    ] }, WHO, "claude");
    const msgs = v.summary!.checks.map((c) => c.message).join("\n");
    expect(msgs).toMatch(/Step 3: "\$nope" doesn't name an earlier step's ref/);
    expect(msgs).toMatch(/Step 4: "\$a1\.2": step "a1" makes 1 item, so use \$a1\./);
    expect(msgs).toMatch(/Step 5: "\$c1" is a campaign, not an ad set/);
    expect(msgs).toMatch(/Step 6: the ref "a1" is already used by step 2/);
  });

  it("a saved naming template can be named in a plan (psx4n used its name)", async () => {
    const acc = await account();
    db().prepare("INSERT INTO naming_templates (ad_account_id, name, kind, pattern) VALUES (?, 'TEST – campaign naming', 'campaign', 'TEST_{date:YYMMDD}_{objective}_{n}')").run(acc);
    expect(namingPattern("TEST – campaign naming")).toBe("TEST_{date:YYMMDD}_{objective}_{n}");
    expect(namingPattern("{date}_{n}")).toBe("{date}_{n}");
    const v = await createPlan({ ops: [{ type: "create_campaign", name_template: "test – CAMPAIGN naming", objective: "OUTCOME_TRAFFIC", budget_level: "adset" }] }, WHO, "claude");
    expect(v.summary!.steps[0].title).toMatch(/Create campaign "TEST_\d{6}_TRAFFIC_01"/);
  });
});

describe("Plans: totals and bid strategy (psx4n, pwjd6)", () => {
  it("copying a campaign with its contents counts the ad sets as they are at that step: ₹1,440", async () => {
    await account();
    const v = await createPlan({ ops: [
      { type: "create_campaign", ref: "c1", name: "C", objective: "OUTCOME_TRAFFIC", budget_level: "adset" },
      { type: "create_adset", ref: "a1", campaign: "$c1", name: "AS1", daily_budget: 100, goal: "LINK_CLICKS" },
      { type: "duplicate_adset", adset: "$a1", changes: [{ name: "AS2", daily_budget: 150 }, { name: "AS3", daily_budget: 200 }, { name: "AS4", daily_budget: 250 }] },
      { type: "edit_adset", adset: "$a1", daily_budget: 120 },
      { type: "duplicate_campaign", campaign: "$c1", with_contents: true, changes: [{ name: "C copy" }] },
    ] }, WHO, "claude");
    expect(v.summary!.errors).toBe(0);
    expect(v.summary!.totals.dailyBudget).toBe(1440);
    expect(v.summary!.adsets).toHaveLength(8);
  });

  it("an ABO campaign with a bid strategy: kept off the campaign, used for its new ad sets; editing it there is refused plainly", async () => {
    await account();
    const v = await createPlan({ ops: [
      { type: "create_campaign", ref: "c1", name: "C", objective: "OUTCOME_LEADS", budget_level: "adset", bid_strategy: "COST_CAP" },
      { type: "create_adset", campaign: "$c1", name: "A", daily_budget: 100, goal: "LEAD_GENERATION", bid_amount: 50 },
    ] }, WHO, "claude");
    expect(v.summary!.errors).toBe(0);
    expect(v.summary!.steps[0].lines.join(" ")).toMatch(/keeps the bid strategy on each ad set/i);
    await runConfirmed(v.key);
    const camp = mock.of("campaign").find((c) => c.name === "C")!;
    expect(camp.bid_strategy).toBeUndefined();
    expect(adsetsIn(camp.id)[0].bid_strategy).toBe("COST_CAP");
    const bad = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c1", bid_strategy: "COST_CAP" }] }, WHO, "claude");
    expect(bad.summary!.checks[0].message).toMatch(/budget on the ad sets, so Meta keeps the bid strategy on each ad set/);
  });

  it("a campaign budget campaign gets Highest volume when no bid strategy is given", async () => {
    await account();
    const v = await createPlan({ ops: [{ type: "create_campaign", name: "CBO", objective: "OUTCOME_LEADS", budget_level: "campaign", daily_budget: 1000 }] }, WHO, "claude");
    await runConfirmed(v.key);
    expect(mock.of("campaign").find((c) => c.name === "CBO")!.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP");
  });
});

describe("Plans: copying campaigns of any size (pwjd6)", () => {
  it("a campaign with 3 ad sets and 2 ads is copied one object at a time (Meta allows fewer than 3 per copy)", async () => {
    await account();
    for (const [i, a] of ["as1", "as4"].entries()) mock.objects.set(`ad${i}`, { _type: "ad", id: `ad${i}`, name: `Ad ${i}`, adset_id: a, status: "PAUSED", effective_status: "PAUSED" });
    const v = await createPlan({ ops: [{ type: "duplicate_campaign", campaign: "c1", with_contents: true, copies: 2 }] }, WHO, "claude");
    expect(v.summary!.errors).toBe(0);
    expect(await runConfirmed(v.key)).toEqual({ done: 1, failed: 0 });
    const copies = mock.of("campaign").filter((c) => String(c.name).startsWith("November tests - copy"));
    expect(copies).toHaveLength(2);
    for (const c of copies) {
      const sets = adsetsIn(c.id);
      expect(sets.map((a) => a.name).sort()).toEqual(["Dynamic creative ad set", "Min-spend template", "November test ad set"]);
      expect(mock.of("ad").filter((a) => sets.some((s) => s.id === a.adset_id)).map((a) => a.name).sort()).toEqual(["Ad 0", "Ad 1"]);
    }
    // The original is untouched.
    expect(adsetsIn("c1")).toHaveLength(3);
  });

  it("a crash in the middle of copying the ad sets resumes without doubles", async () => {
    await account();
    const v = await createPlan({ ops: [{ type: "duplicate_campaign", campaign: "c1", with_contents: true }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    const id = getPlan(v.key).id;
    let n = 0;
    await expect(runPlan(id, { client: clientFor(), clock, afterCreate: () => { if (++n === 3) throw Object.assign(new Error("killed"), { fatal: true }); } })).rejects.toThrow("killed");
    expect(await runPlan(id, { client: clientFor(), clock })).toEqual({ done: 1, failed: 0 });
    const copy = mock.of("campaign").filter((c) => String(c.name).startsWith("November tests - copy"));
    expect(copy).toHaveLength(1);
    expect(adsetsIn(copy[0].id)).toHaveLength(3);
  });
});

describe("Plans: retry a stopped plan, and undo", () => {
  it("a plan that stopped at step 2 is fixed and retried; step 1 is not run again", async () => {
    await account();
    const v = await createPlan({ ops: [
      { type: "create_campaign", ref: "c1", name: "Retry me", objective: "OUTCOME_LEADS", budget_level: "adset" },
      { type: "create_adset", campaign: "$c1", name: "A", daily_budget: 100, goal: "LEAD_GENERATION" },
    ] }, WHO, "claude");
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adsets"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Something Meta didn't like." } });
    expect(await runConfirmed(v.key)).toEqual({ done: 1, failed: 1 });
    expect(planView(v.key).status).toBe("partial");
    const again = await updatePlan(v.key, { ops: [
      { type: "create_campaign", ref: "c1", name: "Retry me", objective: "OUTCOME_LEADS", budget_level: "adset" },
      { type: "create_adset", campaign: "$c1", name: "A fixed", daily_budget: 100, goal: "LEAD_GENERATION" },
    ] });
    expect(again.status).toBe("draft");
    expect(again.summary!.steps[0].title).toMatch(/Already done/);
    await expect(updatePlan(v.key, { ops: [{ type: "create_campaign", ref: "c1", name: "Changed", objective: "OUTCOME_LEADS", budget_level: "adset" }, { type: "create_adset", campaign: "$c1", name: "A", daily_budget: 100, goal: "LEAD_GENERATION" }] })).rejects.toThrow(/Step 1 already ran/);
    expect(await runConfirmed(v.key)).toEqual({ done: 2, failed: 0 });
    const camps = mock.of("campaign").filter((c) => c.name === "Retry me");
    expect(camps).toHaveLength(1);
    expect(adsetsIn(camps[0].id).map((a) => a.name)).toEqual(["A fixed"]);
  });

  it("undo puts budgets, names and status back and turns off what the plan made", async () => {
    await account();
    const v = await createPlan({ ops: [
      { type: "edit_adset", adset: "as1", name: "Renamed", daily_budget: 900 },
      { type: "duplicate_adset", adset: "as1", copies: 2 },
      { type: "set_status", status: "ACTIVE", adsets: ["as4"] },
    ] }, WHO, "claude");
    await runConfirmed(v.key, v.summary!.spendConfirmation ?? undefined);
    expect(mock.objects.get("as1")!.name).toBe("Renamed");
    const u = await undoPlan(v.key, WHO, "claude");
    expect(u.summary!.errors).toBe(0);
    await runConfirmed(u.key, u.summary!.spendConfirmation ?? undefined);
    expect(mock.objects.get("as1")!.name).toBe("November test ad set");
    expect(Number(mock.objects.get("as1")!.daily_budget)).toBe(50000);
    expect(mock.objects.get("as4")!.status).toBe("PAUSED");
    const copies = mock.of("adset").filter((a) => String(a.name).includes("copy"));
    expect(copies).toHaveLength(2);
    expect(copies.every((c) => c.status === "PAUSED")).toBe(true);
    expect(mock.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("Ads: copy and edit existing ads; ads from posts", () => {
  it("copy an ad into two ad sets, edit its text (new creative), and refuse text changes on a post ad", async () => {
    const { batchId, deps } = await batch();
    await runBatch(batchId, deps);
    const ad = getAds(batchId)[0];
    const v = await createPlan({ ops: [
      { type: "copy_ad", ref: "cp", ad: ad.meta_ad_id!, adsets: ["as4", "as3"] },
      { type: "edit_ad", ad: "$cp.1", name: "Renamed copy", primary_texts: ["New text"], headlines: ["New head"], display_link: "sahajta.com" },
    ] }, WHO, "claude");
    expect(v.summary!.errors).toBe(0);
    await runConfirmed(v.key);
    const copies = mock.of("ad").filter((a) => a.adset_id === "as4" || a.adset_id === "as3");
    expect(copies).toHaveLength(2);
    const edited = copies.find((a) => a.name === "Renamed copy")!;
    const cr = mock.objects.get(String(edited.creative_id))!;
    expect(cr.id).not.toBe(ad.meta_creative_id);
    const spec = (cr.body as { object_story_spec: { link_data?: { message: string; caption?: string } }; asset_feed_spec?: { bodies: { text: string }[] } });
    expect(JSON.stringify(spec)).toMatch(/New text/);
    // A post ad: its text can't change.
    const post = await createPlan({ ops: [{ type: "ads_from_post", ref: "pa", post_id: "p1_777", adsets: ["as1"] }] }, WHO, "claude");
    await runConfirmed(post.key);
    const pa = getPlan(post.key);
    const paId = JSON.parse(pa.progress)[0].ids[0];
    const bad = await createPlan({ ops: [{ type: "edit_ad", ad: paId, primary_texts: ["x"] }] }, WHO, "claude");
    expect(bad.summary!.checks[0].message).toMatch(/runs an existing post/);
  });

  it("batch_status shows the post ID of every created ad, for reuse", async () => {
    const { batchId, key, deps } = await batch();
    await runBatch(batchId, deps);
    const v = await batchView(key);
    expect(v.ads.every((a) => a.metaPostId && a.metaIgMediaId)).toBe(true);
  });
});

describe("Audiences", () => {
  it("a website audience and a lookalike of it in one plan, then used in a new ad set", async () => {
    await account();
    const v = await createPlan({ ops: [
      { type: "create_custom_audience", ref: "visitors", name: "Site visitors 30d", source: { kind: "website", pixel_id: "px1", days: 30, url_contains: ["/plots"] } },
      { type: "create_lookalike", ref: "lal", name: "LAL 1% IN", source_audience: "$visitors", country: "IN", size_percent: 1 },
      { type: "create_adset", campaign: "c1", name: "LAL ad set", daily_budget: 300, goal: "LEAD_GENERATION", custom_audiences: ["$lal"], excluded_custom_audiences: ["$visitors"] },
    ] }, WHO, "claude");
    expect(v.summary!.errors).toBe(0);
    expect(await runConfirmed(v.key)).toEqual({ done: 3, failed: 0 });
    const [web, lal] = mock.of("audience");
    expect(JSON.stringify(web.rule)).toMatch(/i_contains/);
    expect(lal.lookalike_spec).toEqual({ type: "similarity", ratio: 0.01, country: "IN" });
    const set = mock.of("adset").find((a) => a.name === "LAL ad set")!;
    expect((set.targeting as { custom_audiences: { id: string }[] }).custom_audiences).toEqual([{ id: lal.id }]);
  });

  it("a customer list is stored and sent only as hashes; bad rows are counted", async () => {
    await account();
    const v = await createPlan({ ops: [{ type: "create_custom_audience", name: "Buyers", source: { kind: "customer_list", emails: [" Buyer@Example.com ", "not-an-email"], phones: ["98123 45678"] } }] }, WHO, "claude");
    const stored = getPlan(v.key).ops;
    expect(stored).not.toMatch(/buyer@example\.com|9812345678/i);
    expect(stored).toMatch(/"skipped_rows":1/);
    await runConfirmed(v.key);
    const a = mock.of("audience")[0];
    expect((a.users as string[][]).length).toBe(2);
    expect((a.users as string[][])[0][0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Batches", () => {
  it("regrouping keeps an ad's own copy with its file (batch zrhtj)", async () => {
    const { batchId, key } = await batch();
    const ads = getAds(batchId);
    const single = ads.find((a) => db().prepare("SELECT COUNT(*) FROM assets WHERE ad_id = ?").pluck().get(a.id) === 1)!;
    const file = db().prepare("SELECT filename FROM assets WHERE ad_id = ?").pluck().get(single.id) as string;
    setAdCopyBy(key, [{ ad: single.position, copy: { primaryTexts: ["IMG3 own copy"], headlines: ["IMG3 headline"] } }]);
    const other = ads.find((a) => a.id !== single.id)!;
    regroupFile(key, file, other.position);
    regroupFile(key, file, "new");
    const back = getAds(batchId).find((a) => db().prepare("SELECT filename FROM assets WHERE ad_id = ?").pluck().all(a.id).includes(file))!;
    expect(JSON.parse(back.copy_override!).primaryTexts).toEqual(["IMG3 own copy"]);
    // The ad it visited keeps its own copy.
    expect(getAds(batchId).find((a) => a.creative_name === other.creative_name)!.copy_override).toBeNull();
  });

  it("a failed ad can get new copy after the launch; Retry makes a v2 creative and never reuses the old one", async () => {
    const { batchId, key, deps } = await batch();
    let first = true;
    mock.inject({ match: (m, p) => { if (m === "POST" && p.endsWith("/ads") && first) { first = false; return true; } return false; }, kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Text not allowed." } });
    const r = await runBatch(batchId, deps);
    expect(r.failed).toBe(1);
    const failed = getAds(batchId).find((a) => a.status === "failed")!;
    expect(failed.meta_creative_id).toBeTruthy(); // the creative was made, then the ad failed
    expect(() => setAdCopyBy(key, [{ ad: getAds(batchId).find((a) => a.status === "done")!.position, copy: { primaryTexts: ["x"] } }])).toThrow(/already in Meta/);
    setAdCopyBy(key, [{ ad: failed.position, copy: { primaryTexts: ["Fixed text"], headlines: ["Fixed head"] } }]);
    resetFailed(batchId);
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    const ad = getAds(batchId).find((a) => a.id === failed.id)!;
    expect(ad.meta_creative_id).not.toBe(failed.meta_creative_id);
    const cr = mock.objects.get(ad.meta_creative_id!)!;
    expect(String(cr.name)).toMatch(/ v2$/);
    expect(JSON.stringify(cr.body)).toMatch(/Fixed text/);
  });

  it("one new ad set for the whole batch: 9 ads in one paused copy, also after a crash", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { adsetMode: "new_shared" });
    const before = mock.of("adset").length;
    let n = 0;
    await expect(runBatch(batchId, { ...deps, afterCreate: (k: string) => { if (k === "creative" && ++n === 1) throw Object.assign(new Error("killed"), { fatal: true }); } })).rejects.toThrow("killed");
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    expect(mock.of("adset").length).toBe(before + 1);
    const shared = getBatch(batchId)!.shared_adset_id!;
    expect(getAds(batchId).every((a) => a.meta_adset_id === shared)).toBe(true);
    expect(mock.objects.get(shared)!.status).toBe("PAUSED");
  });

  it("the preview warns about a template with a minimum spend in a campaign budget campaign (u2942)", async () => {
    const { batchId } = await batch();
    updateBatch(batchId, { adset_mode: "new_per_ad" });
    const p = buildPreview(batchId, { templateMinSpend: "has a minimum spend" }, 9000);
    expect(p.batchChecks.find((c) => c.code === "min_spend")?.level).toBe("warning");
  });

  it("the daily budget ceiling in Settings blocks plans and launches that would spend more", async () => {
    const { key } = await batch();
    saveAppSettings({ dailyBudgetCeiling: 400 }, WHO);
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    expect(v.summary!.checks.find((c) => c.code === "budget_ceiling")?.message).toMatch(/₹500 a day.*ceiling of ₹400/);
    await updateSettings(key, { goLive: "now" });
    await expect(import("@/lib/service").then((s) => s.launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: "₹500" }))).rejects.toThrow(/ceiling of ₹400/);
  });

  it("move a moved-in file between batches is refused after launch; moving into an unknown ad is explained", async () => {
    const { key } = await batch();
    expect(() => regroupFile(key, "no-such-file.jpg", "new")).toThrow(/No file/);
    expect(() => regroupFile(key, "static-price_1x1.jpg", 99)).toThrow(/no ad 99/);
  });
});

describe("Plan check edge cases", () => {
  it("dayparting needs a lifetime budget; frequency cap needs REACH; unknown step types and deletes are refused", async () => {
    await account();
    const s = await summarise(clientFor(), { ops: [
      { type: "create_adset", campaign: "c1", name: "x", daily_budget: 100, goal: "LEAD_GENERATION", schedule: [{ days: [1, 2], start: "09:00", end: "18:00" }] },
      { type: "create_adset", campaign: "c1", name: "y", daily_budget: 100, goal: "LEAD_GENERATION", frequency_cap: { impressions: 2, days: 7 } },
      { type: "delete_adset", adset: "as1" } as never,
    ] });
    const msgs = s.checks.map((c) => c.message).join("\n");
    expect(msgs).toMatch(/Step 1: running only at set hours .* needs a lifetime budget/);
    expect(msgs).toMatch(/Step 2: a frequency cap works only with the goal REACH/);
    expect(msgs).toMatch(/Step 3: unknown step type "delete_adset".*Deleting is not possible/);
  });

  it("a plan with nothing in it, too many steps, or a time in the past is refused before anything else", async () => {
    await account();
    const s1 = await summarise(clientFor(), { ops: [] });
    expect(s1.checks[0].message).toMatch(/no steps/);
    const s2 = await summarise(clientFor(), { run_at: "2020-01-01T09:00:00+05:30", ops: [{ type: "edit_adset", adset: "as1", name: "x" }] });
    expect(s2.checks.map((c) => c.message).join(" ")).toMatch(/in the past/);
  });
});

describe("Failure alerts", () => {
  it("are kept for the home page, and say plainly why no email went out", async () => {
    const { sendAlert, recentAlerts } = await import("@/lib/alerts");
    const r = await sendAlert({ to: "nobody@example.com", subject: "Plan p1 stopped", lines: ["x"], link: "https://x" });
    expect(r.emailed).toBe(false);
    expect(r.why).toMatch(/hasn't allowed email alerts/);
    expect(recentAlerts()[0].subject).toBe("Plan p1 stopped");
    saveAppSettings({ alertEmails: false }, WHO);
    expect((await sendAlert({ to: "a@b.c", subject: "s", lines: [], link: "" })).why).toMatch(/off in Settings/);
  });
});

describe("Early check for an ad set in a campaign the plan makes", () => {
  it("Meta checks it against a similar existing campaign, so the campaign isn't made alone", async () => {
    await account();
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adsets"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_title: "Invalid optimisation goal", error_user_msg: "This goal isn't available for this objective." } });
    const v = await createPlan({ ops: [
      { type: "create_campaign", ref: "c1", name: "New traffic", objective: "OUTCOME_TRAFFIC", budget_level: "adset" },
      { type: "create_adset", campaign: "$c1", name: "A", daily_budget: 100, goal: "LEAD_GENERATION" },
    ] }, WHO, "claude");
    expect(v.summary!.checks.find((c) => c.level === "error")?.message).toMatch(/Step 2: Meta's own check refused it.*This goal isn't available/);
  });
});
