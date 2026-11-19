import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { confirmPlan, createPlan, undoPlan, updatePlan } from "@/lib/manage/service";
import { getPlan, runPlan, summarise } from "@/lib/manage/plan";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Review probes of the plan engine rewrite. Each test names the behaviour that should hold;
// a failing test is a bug found in review.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let clock: FakeClock;
let mock: MockMeta;
const WHO = "review@example.com";

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 90000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
  upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
});
afterEach(() => {
  vi.useRealTimers();
});

const run = (key: string) => runPlan(getPlan(key).id, { client: clientFor(), clock });
async function confirmAndRun(key: string, spend?: string) {
  await confirmPlan(key, { confirm: true, acceptWarnings: true, spendConfirmation: spend }, WHO);
  return run(key);
}
const progress = (key: string) => JSON.parse(getPlan(key).progress) as { status: string; ids: string[]; message: string; before?: Record<string, Record<string, unknown>> }[];
const DAY = 86_400_000;
const at = (base: number, d: number) => new Date(base + d * DAY).toISOString();
function addAd(id: string, adset: string) {
  mock.objects.set(`cr_${id}`, { _type: "creative", id: `cr_${id}`, name: `Creative ${id}`, object_story_spec: { page_id: "p1", link_data: { link: "https://example.com", message: "Old", name: "Head", image_hash: "h1" } } });
  mock.objects.set(id, { _type: "ad", id, name: `Ad ${id}`, adset_id: adset, status: "PAUSED", effective_status: "PAUSED", creative_id: `cr_${id}` });
}

describe("Review · lifetime budgets and scheduled plans", () => {
  it("a scheduled plan that turns on a lifetime-budget ad set still runs the next day when nothing changed in Meta", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    mock.objects.get("c1")!.status = "ACTIVE";
    mock.objects.set("as5", { _type: "adset", id: "as5", name: "Lifetime AS", campaign_id: "c1", status: "PAUSED", lifetime_budget: "3000000", end_time: at(t0, 5.2), optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const v = await createPlan({ run_at: at(t0, 1), ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as5"] }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true, spendConfirmation: v.summary!.spendConfirmation! }, WHO);
    vi.setSystemTime(t0 + DAY); // the run time: nothing changed in Meta
    const r = await run(v.key);
    expect(r.reopened).toBeUndefined();
    expect(mock.objects.get("as5")!.status).toBe("ACTIVE");
  });

  it("a lifetime ad set that starts later is counted over the days it really runs (not from today)", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const now = Date.now();
    mock.objects.set("as5", { _type: "adset", id: "as5", name: "Sale AS", campaign_id: "c1", status: "PAUSED", lifetime_budget: "7000000", start_time: at(now, 6), end_time: at(now, 7), optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as5"] }] });
    // ₹70,000 spent over one day once it starts: the daily amount is ₹70,000, not ₹10,000.
    expect(s.spendConfirmation).toBe("₹70,000");
  });
});

describe("Review · retry of a changed create step", () => {
  it("a create_campaign retried with a lower budget leaves Meta's campaign at the budget the summary shows", async () => {
    const start = at(Date.now(), 2);
    const end = at(Date.now(), 3);
    const v = await createPlan({ ops: [{ type: "create_campaign", ref: "c", name: "Reuse me", objective: "OUTCOME_LEADS", budget_level: "campaign", daily_budget: 5000, budget_schedules: [{ start, end, increase_percent: 20 }] }] }, WHO, "claude");
    await confirmAndRun(v.key);
    // The mock has no budget_schedules route: the campaign is made, then the period fails.
    expect(progress(v.key)[0].status).toBe("failed");
    expect(progress(v.key)[0].ids[0]).toBeTruthy();
    const u = await updatePlan(v.key, { ops: [{ type: "create_campaign", ref: "c", name: "Reuse me", objective: "OUTCOME_LEADS", budget_level: "campaign", daily_budget: 1000 }] });
    expect(u.summary!.steps[0].lines.join(" ")).toMatch(/₹1,000 a day/);
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    const id = progress(v.key)[0].ids[0];
    expect(Number(mock.objects.get(id)!.daily_budget)).toBe(100000);
  });
});

describe("Review · budget periods", () => {
  it("a retried edit_campaign whose second period was fixed sends the first period only once", async () => {
    const p1 = { start: at(Date.now(), 2), end: at(Date.now(), 2.5), increase_percent: 20 };
    const p2 = { start: at(Date.now(), 4), end: at(Date.now(), 4.5), increase_percent: 30 };
    const sent: string[] = [];
    const orig = mock.fetch;
    mock.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/budget_schedules") && (init?.method ?? "GET").toUpperCase() === "POST") {
        const body = String(init?.body ?? "");
        sent.push(body);
        if (sent.length === 2) return Response.json({ error: { message: "Invalid parameter", code: 100, error_user_msg: "Period refused." } }, { status: 400 });
        return Response.json({ id: `bs${sent.length}` });
      }
      return orig(input, init);
    }) as typeof fetch;
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1, p2] }] }, WHO, "claude");
    await confirmAndRun(v.key);
    expect(progress(v.key)[0].status).toBe("failed");
    await updatePlan(v.key, { ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1, { ...p2, increase_percent: 25 }] }] });
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    const p1Start = String(Math.floor(Date.parse(p1.start) / 1000));
    expect(sent.filter((b) => b.includes(`time_start=${p1Start}`))).toHaveLength(1);
  });

  it("adding a budget raise to a campaign that is on asks for the typed total", async () => {
    mock.objects.get("c2")!.status = "ACTIVE"; // as3 is on: the campaign spends ₹1,000 a day now
    const s = await summarise(clientFor(), { ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [{ start: at(Date.now(), 2), end: at(Date.now(), 3), increase_percent: 700 }] }] });
    expect(s.canSpend).toBe(true);
  });
});

describe("Review · Meta calls on the 300-an-hour tier", () => {
  function manyAds(n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      mock.objects.set(`asx${i}`, { _type: "adset", id: `asx${i}`, name: `Set ${i}`, campaign_id: "c1", status: "ACTIVE", daily_budget: "10000", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
      addAd(`adx${i}`, `asx${i}`);
      ids.push(`adx${i}`);
    }
    return ids;
  }

  it("checking a plan that turns on 12 ads in 12 ad sets reads the ad sets together, not one by one", async () => {
    const ads = manyAds(12);
    const before = mock.calls.length;
    await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", ads }] });
    const oneByOne = mock.calls.slice(before).filter((c) => c.method === "GET" && /^asx\d+$/.test(c.path));
    expect(oneByOne).toHaveLength(0);
  });

  it("checking a bulk rename of 12 ads (one edit_ad step each, as the Ads page sends it) reads the ads once", async () => {
    const ads = manyAds(12);
    const before = mock.calls.length;
    await summarise(clientFor(), { ops: ads.map((id, i) => ({ type: "edit_ad" as const, ad: id, name: `Renamed ${i}` })) });
    const reads = mock.calls.slice(before).filter((c) => c.method === "GET" && c.path === "act_1001/ads");
    expect(reads.length).toBeLessThanOrEqual(1);
  });

  it("the check at confirmation (no Meta validate_only) doesn't list the campaigns again for every new ad set", async () => {
    const ops = [
      { type: "create_campaign" as const, ref: "nc", name: "New one", objective: "OUTCOME_LEADS", budget_level: "adset" as const },
      ...[1, 2, 3, 4].map((i) => ({ type: "create_adset" as const, campaign: "$nc", name: `AS ${i}`, daily_budget: 300, goal: "LEAD_GENERATION" })),
    ];
    const before = mock.calls.length;
    await summarise(clientFor(), { ops }, { validate: false });
    const lists = mock.calls.slice(before).filter((c) => c.method === "GET" && c.path === "act_1001/campaigns");
    expect(lists).toHaveLength(0);
  });

  it("running a turn-on of 12 ads does not read each ad's status with its own call", async () => {
    const ads = manyAds(12);
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", ads }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true, spendConfirmation: v.summary!.spendConfirmation ?? undefined }, WHO);
    const before = mock.calls.length;
    await run(v.key);
    const reads = mock.calls.slice(before).filter((c) => c.method === "GET" && /^adx\d+$/.test(c.path));
    expect(reads.length).toBeLessThanOrEqual(1);
  });
});

describe("Review · undo memory on a retried step", () => {
  it("ad sets a stopped set_status turned on are still put back by Undo after the step was changed and retried", async () => {
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1", "as4"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true, spendConfirmation: v.summary!.spendConfirmation! }, WHO);
    mock.inject({ match: (m, p) => m === "POST" && p === "c1", kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "No." } });
    await run(v.key);
    expect(mock.objects.get("as1")!.status).toBe("ACTIVE");
    expect(mock.objects.get("as4")!.status).toBe("ACTIVE");
    // Fixed by leaving the campaign out: the step now works on other things.
    await updatePlan(v.key, { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1", "as4"] }] });
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    const u = await undoPlan(v.key, WHO, "claude");
    const back = u.input.ops.find((o) => o.type === "set_status" && o.status === "PAUSED") as { adsets?: string[] } | undefined;
    expect(back?.adsets ?? []).toEqual(expect.arrayContaining(["as1", "as4"]));
  });
});
