import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { createPlan, confirmPlan, planView, undoPlan, updatePlan } from "@/lib/manage/service";
import { getPlan, runPlan, sameAmount, summarise, type PlanInput } from "@/lib/manage/plan";
import { saveAppSettings } from "@/lib/appsettings";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Audit of the plan engine (plan.ts, service.ts, ads.ts). Each test names what SHOULD happen;
// a failing test is a defect found on the fake Meta.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let clock: FakeClock;
let mock: MockMeta;
const WHO = "audit@example.com";

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
  upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
});

const run = (key: string) => runPlan(getPlan(key).id, { client: clientFor(), clock });
async function confirmAndRun(key: string, spend?: string) {
  await confirmPlan(key, { confirm: true, acceptWarnings: true, spendConfirmation: spend }, WHO);
  return run(key);
}
const progress = (key: string) => JSON.parse(getPlan(key).progress) as { status: string; ids: string[]; message: string }[];

/** An existing single-text link ad (story_spec creative) in an ad set. */
function addAd(id: string, adset: string, text = "Old text") {
  mock.objects.set(`cr_${id}`, { _type: "creative", id: `cr_${id}`, name: `Creative ${id} [L:t-01]`, object_story_spec: { page_id: "p1", link_data: { link: "https://example.com", message: text, name: "Head", image_hash: "h1", call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } } } } });
  mock.objects.set(id, { _type: "ad", id, name: `Ad ${id} [L:t-01]`, adset_id: adset, status: "PAUSED", effective_status: "PAUSED", creative_id: `cr_${id}` });
}

describe("audit: Meta's pre-run check and audiences made in the same plan", () => {
  it("the validate_only check never sends an unresolved '$ref' audience ID to Meta (real Meta refuses it and blocks a valid plan)", async () => {
    const sent: string[] = [];
    const orig = mock.fetch;
    mock.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST" && typeof init?.body === "string") sent.push(decodeURIComponent(init.body.replace(/\+/g, " ")));
      return orig(input, init);
    }) as typeof fetch;
    await createPlan({ ops: [
      { type: "create_custom_audience", ref: "visitors", name: "Site visitors 30d", source: { kind: "website", pixel_id: "px1", days: 30 } },
      { type: "create_lookalike", ref: "lal", name: "LAL 1% IN", source_audience: "$visitors", country: "IN", size_percent: 1 },
      { type: "create_adset", campaign: "c1", name: "LAL ad set", daily_budget: 300, goal: "LEAD_GENERATION", custom_audiences: ["$lal"], excluded_custom_audiences: ["$visitors"] },
    ] }, WHO, "claude");
    const checks = sent.filter((b) => b.includes("validate_only"));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.filter((b) => b.includes('"$lal"') || b.includes('"$visitors"'))).toEqual([]);
  });
});

describe("audit: the typed total when ads are turned on", () => {
  it("edit_ad turning ON an ad made earlier in the plan (a $ref) needs the typed daily total", async () => {
    addAd("ad9", "as3");
    mock.objects.get("c2")!.status = "ACTIVE"; // as3 is already on, so the copied ad would spend at once
    const s = await summarise(clientFor(), { ops: [
      { type: "copy_ad", ref: "cp", ad: "ad9", adsets: ["as3"] },
      { type: "edit_ad", ad: "$cp", status: "ACTIVE" },
    ] });
    expect(s.canSpend).toBe(true);
    expect(s.spendConfirmation).toBe("₹1,000");
  });

  it("turning ON an ad inside a live ad set asks for that ad set's budget, not ₹0, and doesn't say 'nothing will spend'", async () => {
    addAd("ad9", "as3");
    mock.objects.get("c2")!.status = "ACTIVE";
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", ads: ["ad9"] }] });
    expect(s.canSpend).toBe(true);
    expect(s.checks.find((c) => c.code === "nothing_delivers")).toBeUndefined();
    expect(s.spendConfirmation).toBe("₹1,000");
  });

  it("turning ON a lifetime-budget campaign is not confirmed with '₹0' and the daily ceiling still applies", async () => {
    saveAppSettings({ dailyBudgetCeiling: 5000 }, WHO);
    const stop = new Date(Date.now() + 2 * 86_400_000).toISOString();
    mock.objects.set("c5", { _type: "campaign", id: "c5", name: "Lifetime camp", status: "PAUSED", objective: "OUTCOME_LEADS", lifetime_budget: "3000000", stop_time: stop, bid_strategy: "LOWEST_COST_WITHOUT_CAP", special_ad_categories: [] });
    mock.objects.set("as5", { _type: "adset", id: "as5", name: "Lifetime ad set", campaign_id: "c5", status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c5"] }] });
    expect(s.canSpend).toBe(true);
    expect(s.spendConfirmation).not.toBe("₹0"); // ₹30,000 over 2 days can spend
    expect(s.checks.some((c) => c.code === "budget_ceiling")).toBe(true);
  });

  it("paused new ad sets don't count as spend: the ceiling doesn't block a plan that only turns on one ₹500 ad set", async () => {
    saveAppSettings({ dailyBudgetCeiling: 10_000 }, WHO);
    mock.objects.get("c1")!.status = "ACTIVE";
    const s = await summarise(clientFor(), { ops: [
      { type: "duplicate_adset", adset: "as1", changes: Array.from({ length: 12 }, () => ({ daily_budget: 1000 })) },
      { type: "set_status", status: "ACTIVE", adsets: ["as1"] },
    ] });
    expect(s.checks.find((c) => c.code === "budget_ceiling")).toBeUndefined();
    expect(s.spendConfirmation).toBe("₹500");
  });
});

describe("audit: a failed step and the steps after it", () => {
  it("when lowering a budget fails, a later step does NOT turn that ad set on at the old, higher budget", async () => {
    const v = await createPlan({ ops: [
      { type: "edit_adset", adset: "as1", daily_budget: 200 },
      { type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] },
    ] }, WHO, "claude");
    expect(v.summary!.spendConfirmation).toBe("₹200");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true, spendConfirmation: "₹200" }, WHO);
    mock.inject({ match: (m, p) => m === "POST" && p === "as1", kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Budget change refused." } });
    await run(v.key);
    expect(Number(mock.objects.get("as1")!.daily_budget)).toBe(50000); // still ₹500: step 1 failed
    expect(mock.objects.get("as1")!.status).toBe("PAUSED"); // the person typed ₹200, not ₹500
  });
});

describe("audit: changing a plan keeps its schedule and guard", () => {
  it("update_plan with only new steps keeps run_at and expected_daily_total", async () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const v = await createPlan({ run_at: at, expected_daily_total: 500, ops: [{ type: "edit_adset", adset: "as1", name: "X" }] }, WHO, "claude");
    expect(v.runAt).toBe(at);
    const u = await updatePlan(v.key, { ops: [{ type: "edit_adset", adset: "as1", name: "Y" }] } as PlanInput);
    expect(u.runAt).toBe(at);
    expect(u.input.expected_daily_total).toBe(500);
  });
});

describe("audit: names in a plan mean the same thing in the check and in the run", () => {
  it("an ad set renamed in step 1 (by its numeric ID, as on real Meta) and named by its old name in step 2: if the check passes, the run passes", async () => {
    // The fake's own IDs ("as1") are not numbers, so they always go through the name lookup; real IDs are numbers.
    mock.objects.set("777001", { _type: "adset", id: "777001", name: "Numeric AS", campaign_id: "c1", status: "PAUSED", effective_status: "PAUSED", daily_budget: "30000", bid_strategy: "LOWEST_COST_WITHOUT_CAP", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    // Corrected by the fix (P12): after step 1 no ad set is called "Numeric AS" any more, in the check or in
    // the run, so the check refuses step 2 with the new name, instead of passing a step the run can't do.
    const v = await createPlan({ ops: [
      { type: "edit_adset", adset: "777001", name: "Numeric AS renamed" },
      { type: "set_status", status: "PAUSED", adsets: ["Numeric AS"] },
    ] }, WHO, "claude");
    expect(v.summary!.checks.filter((c) => c.level === "error").map((c) => c.message).join(" ")).toMatch(/Step 2: .*renames it to "Numeric AS renamed"/);
    const ok = await createPlan({ ops: [
      { type: "edit_adset", adset: "777001", name: "Numeric AS renamed" },
      { type: "set_status", status: "PAUSED", adsets: ["Numeric AS renamed"] },
    ] }, WHO, "claude");
    expect(ok.summary!.errors).toBe(0);
    expect(await confirmAndRun(ok.key)).toEqual({ done: 2, failed: 0 });
  });

  it("an ad set made in step 2 and named by its name in step 3 (after a name lookup in step 1) is found in the run", async () => {
    const v = await createPlan({ ops: [
      { type: "edit_adset", adset: "Min-spend template", daily_budget: 900 },
      { type: "create_adset", campaign: "c1", name: "Fresh AS", daily_budget: 100, goal: "LEAD_GENERATION" },
      { type: "edit_adset", adset: "Fresh AS", daily_budget: 150 },
    ] }, WHO, "claude");
    expect(v.summary!.errors).toBe(0);
    expect(await confirmAndRun(v.key)).toEqual({ done: 3, failed: 0 });
  });
});

describe("audit: undo", () => {
  it("undo puts a campaign's bid strategy back (it is remembered but not used)", async () => {
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", bid_strategy: "COST_CAP" }] }, WHO, "claude");
    await confirmAndRun(v.key);
    expect(mock.objects.get("c2")!.bid_strategy).toBe("COST_CAP");
    const u = await undoPlan(v.key, WHO, "claude");
    await confirmAndRun(u.key, u.summary!.spendConfirmation ?? undefined);
    expect(mock.objects.get("c2")!.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP");
  });

  it("a plan that turned on 301 ads can be undone (the undo is not split into one step per ad, over the 300-step limit)", async () => {
    const ids = Array.from({ length: 301 }, (_, i) => `9${String(i).padStart(5, "0")}`);
    for (const id of ids) mock.objects.set(id, { _type: "ad", id, name: `Ad ${id}`, adset_id: "as1", status: "PAUSED", effective_status: "PAUSED" });
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", ads: ids }] }, WHO, "claude");
    await confirmAndRun(v.key, v.summary!.spendConfirmation ?? undefined);
    expect(mock.objects.get(ids[300])!.status).toBe("ACTIVE");
    const u = await undoPlan(v.key, WHO, "claude");
    expect(u.summary!.checks.filter((c) => c.level === "error").map((c) => c.message)).toEqual([]);
  });
});

describe("audit: typed confirmation", () => {
  it("'Rs. 15,000' and 'Rs.15000' match ₹15,000 (common in India)", () => {
    expect(sameAmount("Rs. 15,000", "₹15,000")).toBe(true);
    expect(sameAmount("Rs.15000", "₹15,000")).toBe(true);
  });

  it("when Meta changed so a plan now turns something on, the message gives the old total, not 'null'", async () => {
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as3"] }] }, WHO, "claude");
    expect(v.summary!.canSpend).toBe(false); // as3 is already on
    mock.objects.get("as3")!.status = "PAUSED"; // someone paused it in Ads Manager
    const err = await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/null/);
  });
});

describe("audit: fields the plan doesn't know", () => {
  it("unknown fields in a step are refused in the check instead of being ignored (and not shown as 'changed')", async () => {
    const s = await summarise(clientFor(), { ops: [
      { type: "duplicate_adset", adset: "as1", changes: [{ budget: 900 } as never] },
      { type: "create_adset", campaign: "c1", name: "x", daily_budget: 300, goal: "LEAD_GENERATION", age_minimum: 30 } as never,
    ] });
    expect(s.errors).toBeGreaterThan(0);
  });
});

describe("audit: a ref to several items used where one is taken", () => {
  it("create_adset in '$copies' (3 campaign copies) makes an ad set in each, or the check says it can't", async () => {
    const s = await summarise(clientFor(), { ops: [
      { type: "duplicate_campaign", ref: "copies", campaign: "c1", copies: 3 },
      { type: "create_adset", campaign: "$copies", name: "New AS", daily_budget: 100, goal: "LEAD_GENERATION" },
    ] });
    const made = s.adsets.filter((a) => a.name === "New AS").length;
    expect(made === 3 || s.checks.some((c) => /Step 2/.test(c.message) && c.level === "error")).toBe(true);
  });
});

describe("audit: retry never duplicates", () => {
  async function stoppedPlan() {
    const ops: PlanInput["ops"] = [
      { type: "create_campaign", ref: "c", name: "Shift test", objective: "OUTCOME_LEADS", budget_level: "adset" },
      { type: "duplicate_adset", adset: "as1", campaign: "$c", copies: 4 },
    ];
    const v = await createPlan({ ops }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    let copiesSeen = 0;
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/copies") && ++copiesSeen === 3, kind: "error", error: { message: "Temporary problem", code: 2 } });
    expect(await run(v.key)).toEqual({ done: 1, failed: 1 });
    const camp = mock.of("campaign").find((c) => c.name === "Shift test")!;
    expect(mock.of("adset").filter((a) => a.campaign_id === camp.id)).toHaveLength(2);
    return { v, ops, camp };
  }

  it("adding a step before the stopped step and retrying makes 4 copies in all, not 6", async () => {
    const { v, ops, camp } = await stoppedPlan();
    // Corrected by the fix (P10): a step before the stopped step is refused in plain words (the stopped
    // step keeps its place, so what it made is reused); the same step added after it is fine.
    await expect(updatePlan(v.key, { ops: [ops[0], { type: "edit_adset", adset: "as4", name: "Min-spend template v2" }, ops[1]] })).rejects.toThrow(/Step 2 stopped part-way.*Add new steps after step 2/);
    await updatePlan(v.key, { ops: [ops[0], ops[1], { type: "edit_adset", adset: "as4", name: "Min-spend template v2" }] });
    await confirmAndRun(v.key);
    expect(mock.of("adset").filter((a) => a.campaign_id === camp.id)).toHaveLength(4);
  });

  it("retry with a finished step sent back with its fields in another order (as Claude often does) is accepted", async () => {
    const { v, ops } = await stoppedPlan();
    const reordered = { budget_level: "adset", objective: "OUTCOME_LEADS", name: "Shift test", ref: "c", type: "create_campaign" } as PlanInput["ops"][number];
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(ops[0]));
    await expect(updatePlan(v.key, { ops: [reordered, ops[1]] })).resolves.toBeTruthy();
  });

  it("fixing the stopped step keeps the IDs of the copies it already made", async () => {
    const { v, ops } = await stoppedPlan();
    const before = progress(v.key)[1].ids.filter(Boolean);
    expect(before).toHaveLength(2);
    await updatePlan(v.key, { ops: [ops[0], { ...ops[1], name_template: "fixed_{n}" } as PlanInput["ops"][number]] });
    expect(progress(v.key)[1].ids.filter(Boolean)).toEqual(before);
  });

  it("a campaign whose create got no answer is not swapped for an older campaign with the same name on retry", async () => {
    const v = await createPlan({ ops: [
      { type: "create_campaign", ref: "c", name: "November tests", objective: "OUTCOME_LEADS", budget_level: "adset" },
      { type: "create_adset", campaign: "$c", name: "AS new", daily_budget: 100, goal: "LEAD_GENERATION" },
    ] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/campaigns", kind: "network" });
    await run(v.key);
    await updatePlan(v.key);
    await confirmAndRun(v.key);
    expect(mock.of("campaign").filter((c) => c.name === "November tests")).toHaveLength(2);
    expect(mock.of("adset").find((a) => a.name === "AS new")!.campaign_id).not.toBe("c1");
  });
});

describe("audit: scheduled plans", () => {
  it("a scheduled turn-on plan checks budgets and the ceiling again when it runs, days after it was confirmed", async () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const v = await createPlan({ run_at: at, ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true, spendConfirmation: v.summary!.spendConfirmation! }, WHO);
    expect(v.summary!.spendConfirmation).toBe("₹500");
    // Before run_at: the budget is raised to ₹5,000 in Ads Manager and a ₹1,000 ceiling is set.
    mock.objects.get("as1")!.daily_budget = "500000";
    saveAppSettings({ dailyBudgetCeiling: 1000 }, WHO);
    await run(v.key);
    expect(mock.objects.get("as1")!.status).toBe("PAUSED");
  });
});

describe("audit: editing an existing ad's texts", () => {
  it("3 primary texts on a single-text ad: all 3 reach Meta (the summary promised 3)", async () => {
    addAd("ad9", "as1");
    // Corrected by the fix (P14): an ad made without text options keeps one text on Meta, so the check
    // refuses 3 texts plainly (it never promises 3 and then keeps only the first). One text still works.
    const v = await createPlan({ ops: [{ type: "edit_ad", ad: "ad9", primary_texts: ["Text A", "Text B", "Text C"] }] }, WHO, "claude");
    expect(v.summary!.checks.filter((c) => c.level === "error").map((c) => c.message).join(" ")).toMatch(/one primary text, one headline and one description.*3 primary texts/);
    const one = await createPlan({ ops: [{ type: "edit_ad", ad: "ad9", primary_texts: ["Text B"] }] }, WHO, "claude");
    expect(one.summary!.errors).toBe(0);
    await confirmAndRun(one.key);
    const cr = mock.objects.get(String(mock.objects.get("ad9")!.creative_id))!;
    expect(cr.id).not.toBe("cr_ad9");
    expect(JSON.stringify(cr.body)).toMatch(/Text B/);
  });

  it("retry of an edit_ad step that stopped at its 2nd ad doesn't edit the finished 1st ad again, and succeeds", async () => {
    addAd("ad9", "as1");
    const v = await createPlan({ ops: [
      { type: "copy_ad", ref: "cp", ad: "ad9", adsets: ["as1", "as4"] },
      { type: "edit_ad", ad: "$cp", primary_texts: ["New text"] },
    ] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    let creatives = 0;
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/adcreatives" && ++creatives === 2, kind: "error", error: { message: "Temporary problem", code: 2 } });
    expect(await run(v.key)).toEqual({ done: 1, failed: 1 });
    await updatePlan(v.key);
    expect(await confirmAndRun(v.key)).toEqual({ done: 2, failed: 0 });
    expect(progress(v.key)[1].message).not.toMatch(/Idempotency/);
  });
});

describe("audit: audiences", () => {
  it("a customer list whose upload stopped part-way is uploaded on retry, not taken as finished because the empty audience exists", async () => {
    const v = await createPlan({ ops: [{ type: "create_custom_audience", name: "Buyers", source: { kind: "customer_list", emails: ["a@example.com", "b@example.com"] } }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/users"), kind: "network" });
    expect(await run(v.key)).toEqual({ done: 0, failed: 1 });
    await updatePlan(v.key);
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    const a = mock.of("audience").filter((x) => x.name === "Buyers");
    expect(a).toHaveLength(1);
    expect((a[0].users as string[][]).length).toBe(2);
  });
});

describe("audit: planView status after the run", () => {
  it("(control) the plan engine runs a simple edit end to end on this setup", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as1", name: "Control" }] }, WHO, "claude");
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    expect(planView(v.key).status).toBe("done");
    expect(db().prepare("SELECT COUNT(*) AS n FROM plans").get()).toEqual({ n: 1 });
  });
});
