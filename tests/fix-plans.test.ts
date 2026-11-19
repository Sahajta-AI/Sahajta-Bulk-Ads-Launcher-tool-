import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { clientFor } from "@/lib/meta/factory";
import { MetaClient } from "@/lib/meta/client";
import { RateLimitedError } from "@/lib/meta/errors";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { Pacer } from "@/lib/meta/pacer";
import { cancelPlan, confirmPlan, createPlan, customMetrics, columnSets, deleteResultsItem, planView, results, saveColumnSet, saveCustomMetric, undoPlan, updatePlan } from "@/lib/manage/service";
import { getPlan, runPlan, sameAmount, savePlan, summarise, type PlanInput } from "@/lib/manage/plan";
import { buildTargeting, describeAdSet, istTime, listPosts } from "@/lib/manage/objects";
import { saveAppSettings } from "@/lib/appsettings";
import { recentAlerts } from "@/lib/alerts";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Fixes of the plan engine (fix plan, group PLANS: P1–P32). Each test failed before its fix.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let clock: FakeClock;
let mock: MockMeta;
const WHO = "fix@example.com";

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
  upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
});
afterEach(() => {
  vi.useRealTimers();
});

const run = (key: string, extra: Partial<Parameters<typeof runPlan>[1]> = {}) => runPlan(getPlan(key).id, { client: clientFor(), clock, ...extra });
async function confirmAndRun(key: string, spend?: string) {
  await confirmPlan(key, { confirm: true, acceptWarnings: true, spendConfirmation: spend }, WHO);
  return run(key);
}
const progress = (key: string) => JSON.parse(getPlan(key).progress) as { status: string; ids: string[]; message: string; sub?: Record<string, string>; before?: Record<string, Record<string, unknown>> }[];
const errorsOf = (s: { checks: { level: string; message: string }[] }) => s.checks.filter((c) => c.level === "error").map((c) => c.message).join("\n");
const warningsOf = (s: { checks: { level: string; message: string }[] }) => s.checks.filter((c) => c.level === "warning").map((c) => c.message).join("\n");
/** Every POST body sent to the fake Meta. */
function sentBodies() {
  const sent: { path: string; body: string }[] = [];
  const orig = mock.fetch;
  mock.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST" && typeof init?.body === "string") {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      sent.push({ path: url.pathname.replace(/^\/v\d+\.\d+\/?/, ""), body: decodeURIComponent(init.body.replace(/\+/g, " ")) });
    }
    return orig(input, init);
  }) as typeof fetch;
  return sent;
}
function addAd(id: string, adset: string, extra: Record<string, unknown> = {}) {
  mock.objects.set(`cr_${id}`, { _type: "creative", id: `cr_${id}`, name: `Creative ${id} [L:t-01]`, object_story_spec: { page_id: "p1", link_data: { link: "https://example.com", message: "Old", name: "Head", image_hash: "h1", call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } } } } });
  mock.objects.set(id, { _type: "ad", id, name: `Ad ${id} [L:t-01]`, adset_id: adset, status: "PAUSED", effective_status: "PAUSED", creative_id: `cr_${id}`, ...extra });
}
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

describe("P1 · the first failed step stops the plan", () => {
  it("later steps are skipped and say why; a turn-on step's message never says 'kept, paused'", async () => {
    const v = await createPlan({ ops: [
      { type: "edit_adset", adset: "as1", name: "X" },
      { type: "edit_adset", adset: "as4", name: "Y" },
    ] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    mock.inject({ match: (m, p) => m === "POST" && p === "as1", kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "No." } });
    expect(await run(v.key)).toEqual({ done: 0, failed: 2 });
    expect(mock.objects.get("as4")!.name).toBe("Min-spend template");
    expect(progress(v.key)[1]).toMatchObject({ status: "skipped" });
    expect(progress(v.key)[1].message).toMatch(/step 1 failed/);
  });
});

describe("P2 / P31 · spend of ads turned on, read with one account-level read", () => {
  it("set_status on an ad in a live ad set asks for that budget, reads the ads once, and refuses a campaign ID in ads", async () => {
    addAd("ad9", "as3");
    mock.objects.get("c2")!.status = "ACTIVE";
    const before = mock.calls.length;
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", ads: ["ad9"] }] });
    expect(s.spendConfirmation).toBe("₹1,000");
    const reads = mock.calls.slice(before).map((c) => c.path);
    expect(reads.filter((p) => p === "act_1001/ads")).toHaveLength(1);
    expect(reads).not.toContain("ad9");
    // The ad's ad set and campaign come with the account-level reads, not one by one.
    expect(reads).not.toContain("as3");
    expect(reads).not.toContain("c2");
    const bad = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", ads: ["c1"] }] });
    expect(errorsOf(bad)).toMatch(/c1 is not an ad in this ad account/);
  });

  it("an ad set ID that isn't in this ad account is refused (P31)", async () => {
    mock.objects.set("as9", { _type: "adset", id: "as9", name: "Other account's ad set", campaign_id: "c1", status: "PAUSED", daily_budget: "10000" });
    const orig = mock.fetch;
    mock.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await orig(input, init);
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("act_1001/adsets")) {
        const b = (await res.clone().json()) as { data: { id: string }[] };
        return new Response(JSON.stringify({ ...b, data: b.data.filter((x) => x.id !== "as9") }), { status: res.status, headers: res.headers });
      }
      return res;
    }) as typeof fetch;
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as9"] }] });
    expect(errorsOf(s)).toMatch(/as9 is not an ad set in this ad account/);
  });
});

describe("P3 / P17 · lifetime budgets count as lifetime ÷ days left; paused budgets don't count", () => {
  it("turning on a ₹30,000 lifetime ad set ending in 2 days asks for ₹15,000 and says how it was counted", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    // 2.5 days left: whole days, rounded down (round 3), so 2 days.
    mock.objects.set("as5", { _type: "adset", id: "as5", name: "Lifetime AS", campaign_id: "c1", status: "PAUSED", lifetime_budget: "3000000", end_time: inDays(2.5), optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as5"] }] });
    expect(s.spendConfirmation).toBe("₹15,000");
    expect(s.steps.flatMap((x) => x.lines).join(" ")).toMatch(/₹30,000 lifetime counted as ₹15,000 a day/);
  });
});

describe("P4 · update and retry keep what wasn't sent", () => {
  it("a new time alone is a valid change; null clears the expected total; retry drops a time that passed", async () => {
    const at = inDays(1);
    const v = await createPlan({ run_at: at, expected_daily_total: 500, ops: [{ type: "edit_adset", adset: "as1", name: "X" }] }, WHO, "claude");
    const later = inDays(2);
    const u = await updatePlan(v.key, { run_at: later });
    expect(u.runAt).toBe(later);
    expect(u.input.ops).toHaveLength(1);
    expect(u.input.expected_daily_total).toBe(500);
    const c = await updatePlan(v.key, { expected_daily_total: null as never });
    expect(c.input.expected_daily_total).toBeUndefined();
    expect(c.runAt).toBe(later);
    // Three days on, the time has passed: a change that leaves run_at out drops it (it runs when confirmed).
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3 * 86_400_000 });
    const d = await updatePlan(v.key, { title: "Later" });
    expect(d.runAt).toBeNull();
    expect(d.title).toBe("Later");
  });
});

describe("P5 · a scheduled plan is checked again when it runs; only queued plans run", () => {
  it("a draft (reopened for a retry) is not run by a leftover job", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as1", name: "X" }] }, WHO, "claude");
    expect(await run(v.key)).toEqual({ done: 0, failed: 0 });
    expect(mock.objects.get("as1")!.name).toBe("November test ad set");
    expect(getPlan(v.key).status).toBe("draft");
  });

  it("budgets raised in Ads Manager after the yes: back to a draft with the reason, an alert, nothing changed in Meta", async () => {
    const v = await createPlan({ run_at: inDays(1), ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true, spendConfirmation: "₹500" }, WHO);
    mock.objects.get("as1")!.daily_budget = "90000";
    const r = await run(v.key);
    expect(r.reopened).toMatch(/₹900 a day \(it was ₹500\)/);
    expect(mock.objects.get("as1")!.status).toBe("PAUSED");
    expect(getPlan(v.key).status).toBe("draft");
    expect(getPlan(v.key).run_at).toBeNull();
    expect(progress(v.key)[0].message).toMatch(/^Not run at .* IST: what can spend changed/);
    expect(recentAlerts(5)[0].subject).toMatch(new RegExp(`Plan ${v.key} was not run`));
    // Confirmed again with the new total, it runs now.
    expect(await confirmAndRun(v.key, "₹900")).toEqual({ done: 1, failed: 0 });
    expect(mock.objects.get("as1")!.status).toBe("ACTIVE");
  });

  it("an unchanged scheduled plan runs", async () => {
    const v = await createPlan({ run_at: inDays(1), ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    expect(await confirmAndRun(v.key, "₹500")).toEqual({ done: 1, failed: 0 });
  });
});

describe("P6 · audiences made in the plan are left out of Meta's validate_only check", () => {
  it("no '$ref' reaches Meta, and the summary says Meta checks them at run time", async () => {
    const sent = sentBodies();
    const v = await createPlan({ ops: [
      { type: "create_custom_audience", ref: "aud", name: "Visitors", source: { kind: "website", pixel_id: "px1", days: 30 } },
      { type: "create_adset", campaign: "c1", name: "With aud", daily_budget: 300, goal: "LEAD_GENERATION", custom_audiences: ["$aud", "23851111"] },
    ] }, WHO, "claude");
    const checks = sent.filter((x) => x.body.includes("validate_only"));
    expect(checks.some((x) => x.body.includes("23851111"))).toBe(true);
    expect(checks.filter((x) => x.body.includes("$aud"))).toEqual([]);
    expect(v.summary!.steps[1].lines.join(" ")).toMatch(/Meta checks the audiences made in this plan when it runs/);
  });
});

describe("P7 · a retry never adopts an older object", () => {
  async function lostCampaign() {
    const v = await createPlan({ ops: [{ type: "create_campaign", name: "Lost answer", objective: "OUTCOME_LEADS", budget_level: "adset" }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/campaigns", kind: "network" });
    await run(v.key);
    return v;
  }
  it("a same-name campaign made before the attempt is not taken; one made after it is (no second campaign)", async () => {
    const v = await lostCampaign();
    mock.objects.set("old1", { _type: "campaign", id: "old1", name: "Lost answer", status: "PAUSED", objective: "OUTCOME_LEADS", created_time: new Date(Date.now() - 86_400_000).toISOString() });
    await updatePlan(v.key);
    await confirmAndRun(v.key);
    expect(progress(v.key)[0].ids[0]).not.toBe("old1");

    const w = await lostCampaign();
    mock.objects.set("new1", { _type: "campaign", id: "new1", name: "Lost answer", status: "PAUSED", objective: "OUTCOME_LEADS", created_time: new Date().toISOString() });
    // the campaign the first retry made has the same name and was made just before this attempt (within the
    // minute allowed for clocks): the one Meta made last is taken
    await updatePlan(w.key);
    await confirmAndRun(w.key);
    expect(progress(w.key)[0].ids[0]).toBe("new1");
  });

  it("a lookup that fails for another reason stops the step instead of creating it twice", async () => {
    const v = await lostCampaign();
    await updatePlan(v.key);
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    mock.inject({ match: (m, p) => m === "GET" && p === "act_1001/campaigns", kind: "error", error: { message: "Permissions error", code: 200 } });
    await run(v.key);
    expect(mock.of("campaign").filter((c) => c.name === "Lost answer")).toHaveLength(0);
    expect(progress(v.key)[0].status).toBe("failed");
  });
});

describe("P8 · a customer list is uploaded in parts, each tracked", () => {
  it("the retry sends the missing part to the audience made before", async () => {
    const v = await createPlan({ ops: [{ type: "create_custom_audience", name: "Buyers", source: { kind: "customer_list", emails: ["a@example.com", "b@example.com", "c@example.com"] } }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/users"), kind: "network" });
    await run(v.key);
    expect(progress(v.key)[0].ids).toHaveLength(1);
    expect(progress(v.key)[0].sub?.users_0).toBeUndefined();
    await updatePlan(v.key);
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    expect(mock.of("audience")).toHaveLength(1);
    expect((mock.of("audience")[0].users as unknown[]).length).toBe(3);
    expect(progress(v.key)[0].sub?.users_0).toBe("3");
  });
});

describe("P9 · edit_ad retry", () => {
  it("a changed text on retry re-edits with a new idempotency key (1349016) and every ad gets the new text", async () => {
    addAd("ad9", "as1");
    const v = await createPlan({ ops: [{ type: "copy_ad", ref: "cp", ad: "ad9", adsets: ["as1", "as4"] }, { type: "edit_ad", ad: "$cp", primary_texts: ["Text A"] }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    let n = 0;
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/adcreatives" && ++n === 2, kind: "error", error: { message: "Temporary problem", code: 2 } });
    await run(v.key);
    await updatePlan(v.key, { ops: [{ type: "copy_ad", ref: "cp", ad: "ad9", adsets: ["as1", "as4"] }, { type: "edit_ad", ad: "$cp", primary_texts: ["Text B"] }] });
    expect(await confirmAndRun(v.key)).toEqual({ done: 2, failed: 0 });
    for (const id of progress(v.key)[0].ids) expect(JSON.stringify(mock.objects.get(String(mock.objects.get(id)!.creative_id))!.body)).toMatch(/Text B/);
  });
});

describe("P10 / P11 · retry after a fix", () => {
  it("a stopped step changed to work on another ad set doesn't reuse its copies, and says so", async () => {
    const v = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as1", copies: 3 }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    let n = 0;
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/copies") && ++n === 2, kind: "error", error: { message: "Temporary problem", code: 2 } });
    await run(v.key);
    const u = await updatePlan(v.key, { ops: [{ type: "duplicate_adset", adset: "as4", copies: 3 }] });
    expect(warningsOf(u.summary!)).toMatch(/Step 1 now works on something else\. The 1 item it made before it stopped is not reused and stays paused/);
    expect(progress(v.key)[0].ids).toEqual([]);
  });
});

describe("P12 · names follow renames and creates", () => {
  it("an old name after a rename is refused in words (the run would not find it either)", async () => {
    const s = await summarise(clientFor(), { ops: [
      { type: "edit_adset", adset: "Min-spend template", name: "Template v2" },
      { type: "edit_adset", adset: "Min-spend template", daily_budget: 900 },
    ] });
    expect(errorsOf(s)).toMatch(/Step 2: no ad set is called "Min-spend template" at this step: an earlier step renames it to "Template v2"/);
  });
});

describe("P13 · a ref to several items where one is used", () => {
  it("edit_campaign on '$copies' (3 copies) is refused, naming the ref and the count", async () => {
    const s = await summarise(clientFor(), { ops: [
      { type: "duplicate_campaign", ref: "copies", campaign: "c2", copies: 3 },
      { type: "edit_campaign", campaign: "$copies", daily_budget: 2000 },
    ] });
    expect(errorsOf(s)).toMatch(/Step 2: "\$copies" is 3 campaigns, but edit_campaign uses one/);
  });
});

describe("P14 · several texts on an ad without text options", () => {
  it("is refused for an ad made earlier in the plan too (the source ad is read)", async () => {
    addAd("ad9", "as1");
    const s = await summarise(clientFor(), { ops: [
      { type: "copy_ad", ref: "cp", ad: "ad9", adsets: ["as4"] },
      { type: "edit_ad", ad: "$cp", headlines: ["A", "B"] },
    ] });
    expect(errorsOf(s)).toMatch(/Step 2: .*one primary text and one headline.*2 headlines/);
  });
});

describe("P15 · undo", () => {
  it("an end time added where there was none is named as not put back; set_status is undone in one step per status", async () => {
    const v = await createPlan({ ops: [
      { type: "edit_adset", adset: "as1", end_time: inDays(5) },
      { type: "set_status", status: "ACTIVE", adsets: ["as1", "as4"], campaigns: ["c1"] },
    ] }, WHO, "claude");
    await confirmAndRun(v.key, v.summary!.spendConfirmation!);
    const u = await undoPlan(v.key, WHO, "claude");
    expect(warningsOf(u.summary!)).toMatch(/added an end time to ad set as1, which had none/);
    expect(u.input.ops.filter((o) => o.type === "set_status")).toHaveLength(1);
    expect(u.input.ops[0]).toMatchObject({ type: "set_status", status: "PAUSED", campaigns: ["c1"], adsets: ["as1", "as4"] });
  });

  it("the undo plan is made for the plan's own ad account, not the default one", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as1", name: "Renamed" }] }, WHO, "claude");
    await confirmAndRun(v.key);
    const other = upsertAccount({ metaAccountId: "act_2002", name: "Other", token: "mock-token" });
    db().prepare("UPDATE ad_accounts SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END").run(other);
    const u = await undoPlan(v.key, WHO, "claude");
    expect(getPlan(u.key).ad_account_id).toBe(getPlan(v.key).ad_account_id);
  });
});

describe("P16 · unknown fields are refused", () => {
  it("'count' on duplicate_adset says to use copies; 'budget' in changes is named; every form field is taken", async () => {
    const s = await summarise(clientFor(), { ops: [
      { type: "duplicate_adset", adset: "as1", count: 5 } as never,
      { type: "duplicate_adset", adset: "as1", changes: [{ budget: 900 } as never] },
    ] });
    expect(errorsOf(s)).toMatch(/Step 1: unknown field "count"; did you mean copies\?/);
    expect(errorsOf(s)).toMatch(/Step 2: copy 1: unknown field "budget"/);
    const full = await summarise(clientFor(), { ops: [{
      type: "create_adset", ref: "x", campaign: "c1", name: "Every field", lifetime_budget: 30000, start_time: inDays(2), end_time: inDays(12), destination: "WEBSITE", goal: "LANDING_PAGE_VIEWS",
      countries: ["IN"], regions: [{ key: "1728", name: "Maharashtra" }], cities: [{ key: "1234", name: "Pune", radius: 20 }], age_min: 28, age_max: 50, genders: "women",
      interests: [{ id: "6003", name: "Real estate" }], languages: [24], custom_audiences: ["1"], excluded_custom_audiences: ["2"], advantage_audience: true,
      placements: { platforms: ["facebook"] }, attribution: "1d_click", schedule: [{ days: [1], start: "09:00", end: "18:00" }], inventory_filter: "limited",
      block_list_ids: ["991"], dynamic_creative: true, persona: "p", angle: "a", status: "PAUSED", bid_strategy: "LOWEST_COST_WITHOUT_CAP", min_daily_spend: 100, max_daily_spend: 900,
    }] });
    expect(errorsOf(full)).not.toMatch(/unknown field/);
  });
});

describe("P18 · small things", () => {
  it("'Rs. 15,000' matches ₹15,000; a budget of 0 is refused; the changed-total message never says null", async () => {
    expect(sameAmount("Rs. 15,000", "₹15,000")).toBe(true);
    expect(sameAmount("Rs.15000", "₹15,000")).toBe(true);
    const s = await summarise(clientFor(), { ops: [{ type: "edit_adset", adset: "as1", daily_budget: 0 }] });
    expect(errorsOf(s)).toMatch(/daily_budget must be a number above 0/);
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as3"] }] }, WHO, "claude");
    mock.objects.get("as3")!.status = "PAUSED";
    mock.objects.get("c2")!.status = "ACTIVE";
    const err = await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/now turns things on: ₹1,000 a day/);
    expect((err as Error).message).not.toMatch(/null/);
  });
});

describe("P19 · budget periods are never sent as MULTIPLIER", () => {
  it("+20% is sent as +₹200 (ABSOLUTE, paise) and the summary says so; Meta's limits are checked", async () => {
    const start = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const end = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const sent = sentBodies();
    const orig = mock.fetch;
    mock.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const res = await orig(input, init);
      return url.includes("/budget_schedules") ? Response.json({ id: "bs1" }) : res;
    }) as typeof fetch;
    const v = await createPlan({ ops: [{ type: "create_campaign", name: "Sched", objective: "OUTCOME_LEADS", budget_level: "campaign", daily_budget: 1000, budget_schedules: [{ start, end, increase_percent: 20 }] }] }, WHO, "claude");
    expect(v.summary!.steps[0].lines.join(" ")).toMatch(/\+20% \(\+₹200 on ₹1,000 a day\)/);
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    const body = sent.find((x) => x.path.endsWith("/budget_schedules"))!.body;
    expect(body).toMatch(/budget_value_type=ABSOLUTE/);
    expect(body).toMatch(/budget_value=20000(&|$)/);
    expect(body).not.toMatch(/MULTIPLIER/);
    const bad = await summarise(clientFor(), { ops: [
      { type: "create_campaign", name: "Short", objective: "OUTCOME_LEADS", budget_level: "campaign", daily_budget: 1000, budget_schedules: [{ start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), increase_percent: 900 }] },
      { type: "create_campaign", name: "Life", objective: "OUTCOME_LEADS", budget_level: "campaign", lifetime_budget: 9000, stop_time: inDays(9), budget_schedules: [{ start, end, increase_amount: 100 }] },
    ] });
    expect(errorsOf(bad)).toMatch(/Step 1: budget period 1 is shorter than 3 hours/);
    expect(errorsOf(bad)).toMatch(/Step 1: budget period 1: Meta allows at most 8 times the daily budget/);
    expect(errorsOf(bad)).toMatch(/Step 2: budget scheduling works only with a daily campaign budget/);
  });
});

describe("P20 · times without a zone are India time", () => {
  it("run_at and ad set times are stored with +05:30 and shown as that time", async () => {
    const v = await createPlan({ run_at: "2027-11-20T09:00", ops: [{ type: "edit_adset", adset: "as1", end_time: "2027-12-01T23:00" }] }, WHO, "claude");
    expect(v.runAt).toBe("2027-11-20T09:00:00+05:30");
    expect((v.input.ops[0] as { end_time: string }).end_time).toBe("2027-12-01T23:00:00+05:30");
    expect(v.summary!.steps[0].title).toMatch(/09:00 am IST/i);
    expect(istTime("2026-11-20T09:00:00")).toMatch(/09:00 am/i);
  });
});

describe("P21 / P23 · undo memory is saved before the change; a resumed step skips finished items", () => {
  it("one edit_adset step on two ad sets, killed after Meta applied the 2nd edit: the 2nd's budget is still remembered and the 1st is not edited again", async () => {
    const acc = getPlan((await createPlan({ ops: [{ type: "edit_adset", adset: "as1", name: "x" }] }, WHO, "claude")).key).ad_account_id;
    // Step 2 edits several ad sets in one step (the two copies step 1 makes).
    const input: PlanInput = { ops: [{ type: "duplicate_adset", ref: "cp", adset: "as4", copies: 2 }, { type: "edit_adset", adset: "$cp", daily_budget: 900 }] };
    const client = clientFor();
    const key = savePlan(acc, input, await summarise(client, input), WHO, "claude");
    db().prepare("UPDATE plans SET status = 'queued' WHERE key = ?").run(key);
    let n = 0;
    const realPost = client.post.bind(client);
    (client as unknown as { post: typeof realPost }).post = (async (p: string, params?: Record<string, unknown>, o?: unknown) => {
      const r = await realPost(p, params as never, o as never);
      if (Number(params?.daily_budget) === 90000 && ++n === 2) throw Object.assign(new Error("killed"), { fatal: true });
      return r;
    }) as typeof realPost;
    await expect(runPlan(getPlan(key).id, { client, clock })).rejects.toThrow("killed");
    const [first, second] = progress(key)[0].ids;
    expect(Number(mock.objects.get(second)!.daily_budget)).toBe(90000);
    const fresh = new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, pacer: new Pacer(clock), clock });
    const before = mock.calls.filter((c) => c.method === "POST" && c.path === first).length;
    await runPlan(getPlan(key).id, { client: fresh, clock });
    expect(progress(key)[1].status).toBe("done");
    expect(progress(key)[1].before?.[second]?.daily_budget).toBe("80000");
    expect(progress(key)[1].before?.[first]?.daily_budget).toBe("80000");
    expect(mock.calls.filter((c) => c.method === "POST" && c.path === first).length).toBe(before);
  });
});

describe("P22 · cancel inside a long copy step", () => {
  it("stops after the copy it is on, and the plan ends cancelled", async () => {
    const v = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as1", copies: 4 }, { type: "edit_adset", adset: "as4", name: "never" }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    let n = 0;
    await run(v.key, { afterCreate: () => { if (++n === 2) cancelPlan(v.key); } });
    expect(progress(v.key)[0].ids.filter(Boolean)).toHaveLength(2);
    expect(progress(v.key)[0].message).toMatch(/cancelled: 2 of 4 copies made/);
    expect(planView(v.key).status).toBe("cancelled");
    expect(mock.objects.get("as4")!.name).toBe("Min-spend template");
  });
});

describe("P24 / P25 · Meta's rules checked before the run", () => {
  it("a housing ad set aimed at women 25–45 is refused; switching a daily ad set to lifetime is refused", async () => {
    const s = await summarise(clientFor(), { ops: [
      { type: "create_campaign", ref: "h", name: "Homes", objective: "OUTCOME_LEADS", budget_level: "campaign", daily_budget: 1000, special_ad_categories: ["HOUSING"], special_ad_category_country: ["IN"] },
      { type: "create_adset", campaign: "$h", name: "W", goal: "LEAD_GENERATION", age_min: 25, age_max: 45, genders: "women", cities: [{ key: "1", name: "Pune", radius: 10 }] },
      { type: "edit_adset", adset: "as1", lifetime_budget: 10000, end_time: inDays(5) },
    ] });
    const e = errorsOf(s);
    expect(e).toMatch(/Step 2: housing ads must reach every age from 18 to 65\+/);
    expect(e).toMatch(/Step 2: housing ads can't be shown to one gender only/);
    expect(e).toMatch(/Step 2: housing ads need a radius of at least 25 km/);
    expect(e).toMatch(/Step 3: "November test ad set" has a daily budget, and Meta can't switch an existing ad set between daily and lifetime budget/);
  });
});

describe("P26 · a campaign-budget ad set copied into an ad-set-budget campaign", () => {
  it("the rebuild after Meta refuses the plain copy carries the copy's budget and a bid strategy", async () => {
    const v = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as3", campaign: "c1", changes: [{ daily_budget: 300 }] }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    const sent = sentBodies();
    mock.inject({ match: (m, p) => m === "POST" && p === "as3/copies", kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Your ad sets' combined minimum spend is higher than your campaign budget." } });
    expect(await run(v.key)).toEqual({ done: 1, failed: 0 });
    const rebuild = sent.find((x) => x.path === "act_1001/adsets")!;
    expect(rebuild.body).toMatch(/campaign_id=c1(&|$)/);
    expect(rebuild.body).toMatch(/daily_budget=30000(&|$)/);
    expect(rebuild.body).toMatch(/bid_strategy=LOWEST_COST_WITHOUT_CAP/);
    const copy = mock.objects.get(progress(v.key)[0].ids[0])!;
    expect(copy).toMatchObject({ campaign_id: "c1", status: "PAUSED" });
    expect(Number(copy.daily_budget)).toBe(30000);
  });
});

describe("P27 · a lookalike of an audience made in the same plan", () => {
  it("warns that Meta needs about 100 matched people first", async () => {
    const s = await summarise(clientFor(), { ops: [
      { type: "create_custom_audience", ref: "v", name: "Visitors", source: { kind: "website", pixel_id: "px1", days: 30 } },
      { type: "create_lookalike", name: "LAL", source_audience: "$v", country: "IN", size_percent: 1 },
    ] });
    expect(warningsOf(s)).toMatch(/Step 2: .*about 100 matched people/);
  });
});

describe("P28 · ad set settings in plain words", () => {
  it("hours, attribution, languages, brand safety, Dynamic creative, frequency cap and place names", () => {
    const t = buildTargeting({ regions: [{ key: "1728", name: "Maharashtra" }], cities: [{ key: "1234", name: "Pune", radius: 25 }], languages: [24], block_list_ids: ["991"] });
    const d = describeAdSet({ targeting: t, adset_schedule: [{ start_minute: 540, end_minute: 1080, days: [1, 2] }], attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }], brand_safety_content_filter_levels: ["FACEBOOK_STRICT"], is_dynamic_creative: true, frequency_control_specs: [{ event: "IMPRESSIONS", interval_days: 7, max_frequency: 2 }] }, "INR");
    const all = Object.values(d).join(" | ");
    expect(all).toMatch(/Maharashtra/);
    expect(all).toMatch(/Pune \+25 km/);
    expect(all).toMatch(/Mon, Tue 09:00–18:00/);
    expect(all).toMatch(/1-day click attribution/);
    expect(all).toMatch(/language IDs 24/);
    expect(all).toMatch(/limited inventory, 1 block list/);
    expect(all).toMatch(/Dynamic creative on/);
    expect(all).toMatch(/frequency cap 2 per 7 days/);
  });
});

describe("P29 · lookups say Meta is limiting calls", () => {
  it("listPosts rethrows a rate limit instead of answering 'nothing found'", async () => {
    const throttle = { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true };
    mock.inject({ match: (m, p) => m === "GET" && p.endsWith("/promote_pages"), kind: "error", error: throttle });
    const interactive = new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, pacer: new Pacer(clock), clock, maxWaitMs: 1000 });
    await expect(listPosts(interactive)).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("P30 · custom metrics and column sets", () => {
  it("rename updates column sets and formulas; delete is refused while a formula uses it; a column set loses a deleted metric with a note", async () => {
    const cpl = saveCustomMetric({ name: "CPL", formula: "spend / actions:lead", format: "money" });
    const gst = saveCustomMetric({ name: "CPL GST", formula: "CPL * 1.18", format: "money" });
    saveColumnSet({ name: "Mine", metrics: ["spend", "CPL", "CPL GST"], isDefault: true });
    saveCustomMetric({ id: cpl, name: "Cost per lead", formula: "spend / actions:lead", format: "money" });
    expect(customMetrics().find((m) => m.id === gst)!.formula).toBe("[Cost per lead] * 1.18");
    expect(columnSets().find((c) => c.name === "Mine")!.metrics).toEqual(["spend", "Cost per lead", "CPL GST"]);
    expect(() => deleteResultsItem("custom_metric", cpl)).toThrow(/used in the formula of "CPL GST"/);
    expect(deleteResultsItem("custom_metric", gst)).toEqual({ removedFrom: ["Mine"] });
    expect(() => saveColumnSet({ name: "Bad", metrics: ["spnd"] })).toThrow(/Unknown metric "spnd"/);
    expect(() => saveCustomMetric({ name: "Bad", formula: "spnd / 2" })).toThrow(/spnd/);
    expect(() => deleteResultsItem("custom_metric", 999)).toThrow(/No custom metric with id 999/);
    // A name that stopped working in a stored column set is left out with a note, not an error.
    db().prepare("UPDATE column_sets SET metrics = ? WHERE name = 'Mine'").run(JSON.stringify(["spend", "Gone metric"]));
    const r = await results({ level: "campaign" });
    expect(r!.notes.join(" ")).toMatch(/Gone metric/);
  });
});

describe("P32 · {date} in names is fixed when the plan is confirmed", () => {
  it("a run on a later day still uses the confirmation date", async () => {
    const v = await createPlan({ ops: [{ type: "create_campaign", name_template: "{date}_dated", objective: "OUTCOME_LEADS", budget_level: "adset" }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    const input = JSON.parse(getPlan(v.key).ops) as PlanInput;
    expect(input.name_date).toMatch(/^\d{4}-\d\d-\d\d$/);
    db().prepare("UPDATE plans SET ops = ? WHERE key = ?").run(JSON.stringify({ ...input, name_date: "2026-01-05" }), v.key);
    await run(v.key);
    expect(mock.of("campaign").some((c) => c.name === "2026-01-05_dated")).toBe(true);
  });
});
