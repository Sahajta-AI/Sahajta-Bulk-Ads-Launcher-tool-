import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runBatch } from "@/lib/engine/launcher";
import { buildPreview } from "@/lib/engine/preview";
import { DeletionRefused, MetaClient } from "@/lib/meta/client";
import { plainError, MetaError } from "@/lib/meta/errors";
import { Pacer } from "@/lib/meta/pacer";
import { evalFormula, parseFormula, readInsights } from "@/lib/manage/insights";
import { buildTargeting } from "@/lib/manage/objects";
import { confirmCheck, getPlan, runPlan, savePlan, sameAmount, summarise, type PlanInput } from "@/lib/manage/plan";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { fifteenFileFolder, freshDb, mockDeps, setupBatch } from "./helpers";

let folder: string;
beforeAll(async () => {
  folder = await fifteenFileFolder();
}, 120_000);
beforeEach(() => {
  freshDb();
});

const ACC = () => Number(db().prepare("INSERT INTO ad_accounts (meta_account_id, name, is_default, token_enc) VALUES ('act_1001', 'Sahajta (mock)', 1, 'x')").run().lastInsertRowid);

function plan(accountDbId: number, input: PlanInput, summary: Awaited<ReturnType<typeof summarise>>) {
  const key = savePlan(accountDbId, input, summary, "test@example.com", "claude");
  db().prepare("UPDATE plans SET status = 'queued' WHERE key = ?").run(key);
  return getPlan(key);
}

describe("never delete anything", () => {
  it("the Meta client refuses DELETE and the DELETED / ARCHIVED statuses before any request", async () => {
    const { client, mock } = mockDeps(1);
    await expect(client.post("as1", { status: "DELETED" })).rejects.toBeInstanceOf(DeletionRefused);
    await expect(client.post("as1", { status: "archived" })).rejects.toBeInstanceOf(DeletionRefused);
    await expect(client.post("as1/copies", { status_option: "ARCHIVED" })).rejects.toBeInstanceOf(DeletionRefused);
    expect((client as unknown as { delete?: unknown }).delete).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
  });

  it("a plan that tries to archive is refused in the check, not sent", async () => {
    const acc = ACC();
    const { client, mock } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const s = await summarise(client, { ops: [{ type: "edit_adset", adset: "as1", status: "ARCHIVED" as never }] });
    expect(s.errors).toBeGreaterThan(0);
    expect(s.checks.map((c) => c.message).join(" ")).toMatch(/not possible/);
    expect(mock.calls.filter((c) => c.path !== "act_1001" && !c.path.startsWith("as1") && !c.path.startsWith("c1"))).toHaveLength(0);
  });
});

describe("bug from batch rbqdz: Instagram account not allowed for the ad account", () => {
  it("Meta's code and words are shown, with the two ways to fix it, and the batch stops", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { deps } = mockDeps(accountId, { capPoints: 9000, igNotAllowed: true });
    const res = await runBatch(batchId, deps);
    expect(res.done).toBe(0);
    const ad = getAds(batchId)[0];
    expect(ad.error).toMatch(/not allowed to use the Instagram account/);
    expect(ad.error).toMatch(/Assign assets/);
    expect(ad.error).toMatch(/code 200\/1815199/);
    expect(ad.error).toMatch(/No permission to use this Instagram account/);
    // Every other ad failed with the same reason instead of trying 9 times.
    expect(getAds(batchId).every((a) => a.status === "failed" && a.error === ad.error)).toBe(true);
  });

  it("the preview blocks the launch when Meta says the Instagram account is not allowed", async () => {
    const { batchId } = await setupBatch(folder);
    const p = buildPreview(batchId, { igProblem: "The ad account is not allowed to use Instagram @sahajta.ai" }, 9000);
    expect(p.batchChecks.find((c) => c.code === "ig_not_allowed")?.level).toBe("error");
  });

  it("other errors also carry Meta's own message and code", () => {
    const e = new MetaError("x", { status: 400, body: { code: 100, error_subcode: 33, message: "Unsupported post request" } });
    expect(plainError(e, "Creating the ad")).toBe('Creating the ad failed: Meta rejected one of the settings. Meta said: "Unsupported post request" (code 100/33).');
  });
});

describe("minimum spend above a campaign budget (batch u2942)", () => {
  it("a new ad set per ad is built from the template's settings when Meta refuses the copy", async () => {
    const { accountId, batchId } = await setupBatch(folder, { mode: "new_per_ad", adsetId: "as4" });
    const { deps, mock } = mockDeps(accountId, { capPoints: 9000, richAccount: true });
    const t = mock.objects.get("as4")!;
    t.campaign_id = "c2"; // the template sits in a campaign-budget campaign
    delete t.daily_budget;
    updateBatch(batchId, { campaign_id: "c2" });
    const res = await runBatch(batchId, deps);
    expect(res).toEqual({ done: 9, failed: 0 });
    const made = mock.of("adset").filter((a) => String(a.name).includes("[L:"));
    expect(made).toHaveLength(9);
    for (const a of made) {
      expect(a.daily_min_spend_target).toBeUndefined();
      expect(a.campaign_id).toBe("c2");
      expect(a.status).toBe("PAUSED");
    }
  });
});

describe("change plans", () => {
  it("15 ad sets with budgets ₹500 to ₹1,500 in one plan: summary, total, guardrail, run", async () => {
    const acc = ACC();
    const { client, clock, mock } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const budgets = Array.from({ length: 15 }, (_, i) => 500 + Math.round((i * 1000) / 14));
    const input: PlanInput = {
      title: "November scale test",
      expected_daily_total: budgets.reduce((a, b) => a + b, 0),
      ops: [
        { type: "create_campaign", ref: "camp", name: "Nov leads ABO", objective: "OUTCOME_LEADS", budget_level: "adset" },
        { type: "duplicate_adset", adset: "as1", campaign: "$camp", name_template: "{campaign}_{persona}_{budget}_{n}", persona: "investor", changes: budgets.map((b) => ({ daily_budget: b })) },
      ],
    };
    const s = await summarise(client, input, { validate: true });
    expect(s.errors).toBe(0);
    expect(s.adsets).toHaveLength(15);
    expect(s.totals.adsets).toBe(15);
    expect(s.totals.campaigns).toBe(1);
    expect(s.totals.dailyBudget).toBe(input.expected_daily_total);
    expect(s.adsets[0].name).toBe("Nov leads ABO_investor_500_01");
    expect(s.adsets[0].details.audience).toMatch(/IN · age 25–55/);
    expect(s.canSpend).toBe(false); // everything is created paused
    expect(mock.of("campaign")).toHaveLength(2); // the check created nothing (validate_only)

    // A typo budget: warned, and the total no longer matches what the person said.
    const typo = structuredClone(input);
    (typo.ops[1] as { changes: { daily_budget: number }[] }).changes[3].daily_budget = 9000;
    const s2 = await summarise(client, typo);
    expect(s2.checks.find((c) => c.code === "budget_outlier")?.message).toMatch(/₹9,000/);
    expect(s2.checks.find((c) => c.code === "budget_mismatch")?.level).toBe("error");

    const row = plan(acc, input, s);
    db().prepare("UPDATE plans SET status = 'draft' WHERE id = ?").run(row.id);
    expect(() => confirmCheck(getPlan(row.key), { confirm: false })).toThrow(/confirm: true/);
    confirmCheck(getPlan(row.key), { confirm: true });
    const res = await runPlan(row.id, { client, clock });
    expect(res).toEqual({ done: 2, failed: 0 });
    const camp = mock.of("campaign").find((c) => c.name === "Nov leads ABO")!;
    const sets = mock.of("adset").filter((a) => a.campaign_id === camp.id);
    expect(sets).toHaveLength(15);
    expect(sets.map((a) => Number(a.daily_budget)).sort((a, b) => a - b)).toEqual(budgets.map((b) => b * 100).sort((a, b) => a - b));
    expect(sets.every((a) => a.status === "PAUSED")).toBe(true);
    expect(sets.map((a) => a.name)).toContain("Nov leads ABO_investor_1500_15");
    expect(getPlan(row.key).status).toBe("done");
  });

  it("campaign budget rules and bid caps are checked before anything runs", async () => {
    const acc = ACC();
    const { client } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const s = await summarise(client, {
      ops: [
        { type: "create_adset", campaign: "c2", name: "x", daily_budget: 500, goal: "LEAD_GENERATION" },
        { type: "create_adset", campaign: "c1", name: "y", goal: "LEAD_GENERATION" },
        { type: "create_adset", campaign: "c1", name: "z", daily_budget: 500, goal: "LEAD_GENERATION", bid_strategy: "COST_CAP" },
        { type: "create_campaign", name: "cbo", objective: "OUTCOME_LEADS", budget_level: "campaign" },
      ],
    });
    const msgs = s.checks.filter((c) => c.level === "error").map((c) => c.message);
    expect(msgs.some((m) => /Step 1: .*campaign budget/.test(m))).toBe(true);
    expect(msgs.some((m) => /Step 2: .*needs daily_budget/.test(m))).toBe(true);
    expect(msgs.some((m) => /Step 3: COST_CAP needs bid_amount/.test(m))).toBe(true);
    expect(msgs.some((m) => /Step 4: a campaign budget \(CBO\) needs/.test(m))).toBe(true);
  });

  it("copies into a campaign-budget campaign drop the template's spend limits when Meta refuses them", async () => {
    const acc = ACC();
    const { client, clock, mock } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const input: PlanInput = { ops: [{ type: "duplicate_adset", adset: "as4", campaign: "c2", copies: 3 }] };
    const s = await summarise(client, input);
    expect(s.errors).toBe(0);
    const row = plan(acc, input, s);
    await runPlan(row.id, { client, clock });
    const made = mock.of("adset").filter((a) => a.campaign_id === "c2" && a.id !== "as3");
    expect(made).toHaveLength(3);
    expect(made.every((a) => a.daily_min_spend_target === undefined && a.daily_budget === undefined)).toBe(true);
    expect(JSON.parse(getPlan(row.key).progress)[0].message).toMatch(/rebuilt without the template's spend limits/);
  });

  it("duplicate a campaign with its contents, edit an ad set's budget and audience", async () => {
    const acc = ACC();
    const { client, clock, mock } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const input: PlanInput = {
      ops: [
        { type: "duplicate_campaign", campaign: "c2", with_contents: true, changes: [{ name: "Copy A", daily_budget: 2000 }, { name: "Copy B" }] },
        { type: "edit_adset", adset: "as1", daily_budget: 750, age_min: 30, interests: [{ id: "6003", name: "Real estate" }], placements: { platforms: ["facebook", "instagram"], instagram_positions: ["stream", "reels"] } },
      ],
    };
    const s = await summarise(client, input);
    expect(s.errors).toBe(0);
    expect(s.steps[1].lines[0]).toMatch(/daily budget ₹500 → ₹750/);
    expect(s.steps[1].lines[0]).toMatch(/Real estate/);
    const row = plan(acc, input, s);
    expect(await runPlan(row.id, { client, clock })).toEqual({ done: 2, failed: 0 });
    const a = mock.of("campaign").find((c) => c.name === "Copy A")!;
    expect(Number(a.daily_budget)).toBe(200000);
    expect(mock.of("adset").filter((x) => x.campaign_id === a.id)).toHaveLength(1);
    const as1 = mock.objects.get("as1")!;
    expect(Number(as1.daily_budget)).toBe(75000);
    const t = as1.targeting as Record<string, unknown>;
    expect(t.age_min).toBe(30);
    expect(t.age_max).toBe(55); // kept from before
    expect(t.publisher_platforms).toEqual(["facebook", "instagram"]);
  });

  it("ads from one existing post in three ad sets share one creative", async () => {
    const acc = ACC();
    const { client, clock, mock } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const input: PlanInput = { ops: [{ type: "ads_from_post", post_id: "p1_777", adsets: ["as1", "as4", "as3"], name_template: "Post777_{adset}" }] };
    const s = await summarise(client, input);
    expect(s.errors).toBe(0);
    expect(s.totals.ads).toBe(3);
    const row = plan(acc, input, s);
    await runPlan(row.id, { client, clock });
    expect(mock.of("creative")).toHaveLength(1);
    expect(mock.of("creative")[0].object_story_id).toBe("p1_777");
    const ads = mock.of("ad");
    expect(ads).toHaveLength(3);
    expect(new Set(ads.map((x) => x.creative_id)).size).toBe(1);
    expect(ads.every((x) => x.status === "PAUSED")).toBe(true);
    expect(ads.map((x) => x.name)).toContain("Post777_CBO ad set");
  });

  it("turning a whole campaign on needs the total daily budget typed back, and turns ads on before the campaign", async () => {
    const acc = ACC();
    const { client, clock, mock } = mockDeps(acc, { capPoints: 9000, richAccount: true, allowActive: true });
    mock.objects.set("ad1", { _type: "ad", id: "ad1", name: "a", adset_id: "as3", status: "PAUSED", effective_status: "PAUSED" });
    const input: PlanInput = { ops: [{ type: "set_status", status: "ACTIVE", whole_campaigns: ["c2"] }] };
    const s = await summarise(client, input);
    expect(s.canSpend).toBe(true);
    expect(s.totals.spendNowDaily).toBe(1000);
    expect(s.totals.dailyBudget).toBe(1000);
    expect(s.spendConfirmation).toBe("₹1,000");
    const row = plan(acc, input, s);
    db().prepare("UPDATE plans SET status = 'draft' WHERE id = ?").run(row.id);
    expect(() => confirmCheck(getPlan(row.key), { confirm: true })).toThrow(/typing the total daily budget/);
    expect(() => confirmCheck(getPlan(row.key), { confirm: true, spendConfirmation: "₹10,000" })).toThrow(/₹1,000/);
    confirmCheck(getPlan(row.key), { confirm: true, spendConfirmation: "1000" });
    expect(sameAmount("INR 1,000.00", "₹1,000")).toBe(true);
    const before = mock.calls.length;
    await runPlan(row.id, { client, clock });
    const writes = mock.calls.slice(before).filter((c) => c.method === "POST").map((c) => c.path);
    expect(writes).toEqual(["ad1", "as3", "c2"]);
    expect(mock.objects.get("c2")!.status).toBe("ACTIVE");
    expect(mock.objects.get("ad1")!.status).toBe("ACTIVE");
  });

  it("a crash in the middle of 10 copies resumes without making any copy twice", async () => {
    const acc = ACC();
    const { client, clock, mock } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const input: PlanInput = { ops: [{ type: "duplicate_adset", adset: "as1", copies: 10, name_template: "copy_{n}" }] };
    const row = plan(acc, input, await summarise(client, input));
    let n = 0;
    await expect(runPlan(row.id, { client, clock, afterCreate: () => { if (++n === 4) throw Object.assign(new Error("killed"), { fatal: true }); } })).rejects.toThrow("killed");
    const res = await runPlan(row.id, { client: new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, pacer: new Pacer(clock), clock }), clock });
    expect(JSON.parse(getPlan(row.key).progress)[0].message).not.toMatch(/failed/);
    expect(res).toEqual({ done: 1, failed: 0 });
    const copies = mock.of("adset").filter((a) => String(a.name).startsWith("copy_"));
    expect(copies).toHaveLength(10);
    expect(new Set(copies.map((c) => c.name)).size).toBe(10);
  });

  it("a scheduled plan in the past is refused; unknown refs are named", async () => {
    const acc = ACC();
    const { client } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const s = await summarise(client, { run_at: "2020-01-01T09:00:00+05:30", ops: [{ type: "create_adset", campaign: "$nope", name: "x", daily_budget: 1, goal: "REACH" }] });
    expect(s.checks.map((c) => c.message).join(" ")).toMatch(/in the past/);
    expect(s.checks.map((c) => c.message).join(" ")).toMatch(/"\$nope" doesn't name an earlier step/);
  });
});

describe("audiences", () => {
  it("editing one part of the audience keeps the rest", () => {
    const base = { geo_locations: { countries: ["IN"] }, age_min: 25, age_max: 55, custom_audiences: [{ id: "ca1" }] };
    const t = buildTargeting({ genders: "women", excluded_custom_audiences: ["ca9"] }, base);
    expect(t).toMatchObject({ geo_locations: { countries: ["IN"] }, age_min: 25, genders: [2], custom_audiences: [{ id: "ca1" }], excluded_custom_audiences: [{ id: "ca9" }] });
    expect(t.targeting_automation).toEqual({ advantage_audience: 0 });
    const t2 = buildTargeting({ cities: [{ key: "2295424", radius: 25 }] }, base);
    expect(t2.geo_locations).toEqual({ cities: [{ key: "2295424", radius: 25, distance_unit: "kilometer" }] });
  });
});

describe("results and custom metrics", () => {
  it("formulas: + - * / and brackets, no eval, divide by zero is empty", () => {
    const e = parseFormula('(spend + 100) / actions:lead * 2 - "Cost per site visit"');
    const v = evalFormula(e, (n) => ({ spend: 900, "actions:lead": 10, "Cost per site visit": 5 })[n] ?? null);
    expect(v).toBe(195);
    expect(evalFormula(parseFormula("spend / actions:lead"), (n) => (n === "spend" ? 100 : 0))).toBeNull();
    expect(() => parseFormula("spend; process.exit()")).toThrow(/character/);
    expect(() => parseFormula("(spend")).toThrow(/bracket/);
  });

  it("reads results per ad set with a custom metric and correct totals", async () => {
    const acc = ACC();
    const { client } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const r = await readInsights(client, { level: "adset", date_preset: "last_7d", metrics: ["spend", "actions:lead", "cost:lead", "CPLV"] }, [{ name: "CPLV", formula: "spend / actions:landing_page_view", format: "money" }]);
    expect(r.rows.length).toBe(4);
    expect(r.rows[0].values.CPLV).toBe(1000 / 400);
    const spend = r.rows.reduce((s, x) => s + (x.values.spend ?? 0), 0);
    const leads = r.rows.reduce((s, x) => s + (x.values["actions:lead"] ?? 0), 0);
    expect(r.totals.spend).toBe(spend);
    expect(r.totals["cost:lead"]).toBeCloseTo(spend / leads);
    expect(r.columns.find((c) => c.key === "CPLV")?.format).toBe("money");
  });
});

describe("go-live choice on a batch", () => {
  it("a batch set to 'now' is created paused; nothing is turned on until all ads are in", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    updateBatch(batchId, { go_live: "now" });
    const { deps, mock } = mockDeps(accountId, { capPoints: 9000 });
    // The fake Meta still refuses any ACTIVE status here: creation itself must stay paused.
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
    expect(getBatch(batchId)!.go_live_done).toBe(0); // the worker queues the turn-on plan next
  });
});
