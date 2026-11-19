import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { saveAppSettings } from "@/lib/appsettings";
import { confirmPlan, createPlan, updatePlan } from "@/lib/manage/service";
import { getPlan, runPlan, summarise, type Op } from "@/lib/manage/plan";
import { timeMs } from "@/lib/time";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Review-fix round 2, group PLANS: each test runs the real plan code against the practice Meta.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
const WHO = "r2plans@example.com";
process.env.ALLOWED_EMAILS = WHO;
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let clock: FakeClock;
let mock: MockMeta;

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
const confirm = (key: string, spend?: string | null) => confirmPlan(key, { confirm: true, acceptWarnings: true, spendConfirmation: spend ?? undefined }, WHO);
async function confirmAndRun(key: string, spend?: string | null) {
  await confirm(key, spend);
  return run(key);
}
const progress = (key: string) => JSON.parse(getPlan(key).progress) as { status: string; ids: string[]; message: string }[];
const warningsOf = (s: { checks: { level: string; message: string }[] }) => s.checks.filter((c) => c.level === "warning").map((c) => c.message).join("\n");
const errorsOf = (s: { checks: { level: string; message: string }[] }) => s.checks.filter((c) => c.level === "error").map((c) => c.message).join("\n");
const DAY = 86_400_000;
const at = (base: number, d: number) => new Date(base + d * DAY).toISOString();
const posts = (path: string) => mock.calls.filter((c) => c.method === "POST" && c.path === path).length;
const named = (type: string, name: string) => mock.of(type).filter((o) => o.name === name);
const fail = { message: "Invalid parameter", code: 100, error_user_msg: "No." };

describe("R2 · a lost answer: Meta made the object, the answer never came", () => {
  it("the retry finds the campaign by its name and sends nothing twice", async () => {
    const v = await createPlan({ ops: [{ type: "create_campaign", name: "Lost answer", objective: "OUTCOME_LEADS", budget_level: "adset" }] }, WHO, "claude");
    await confirm(v.key);
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/campaigns", kind: "timeout_after_create" });
    await run(v.key);
    expect(progress(v.key)[0].status).toBe("failed");
    expect(named("campaign", "Lost answer")).toHaveLength(1);
    await updatePlan(v.key);
    await confirm(v.key);
    const before = posts("act_1001/campaigns");
    expect(await run(v.key)).toEqual({ done: 1, failed: 0 });
    expect(posts("act_1001/campaigns")).toBe(before);
    expect(mock.idempotentHits).toBe(0);
    expect(named("campaign", "Lost answer")).toHaveLength(1);
    expect(progress(v.key)[0].ids[0]).toBe(named("campaign", "Lost answer")[0].id);
  });

  it("found under the name it was sent with after the step was renamed, then renamed (no second campaign)", async () => {
    const op = (name: string): Op => ({ type: "create_campaign", name, objective: "OUTCOME_LEADS", budget_level: "adset" });
    const v = await createPlan({ ops: [op("First name")] }, WHO, "claude");
    await confirm(v.key);
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/campaigns", kind: "timeout_after_create" });
    await run(v.key);
    await updatePlan(v.key, { ops: [op("Second name")] });
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    expect(named("campaign", "First name")).toHaveLength(0);
    expect(named("campaign", "Second name")).toHaveLength(1);
  });

  it("an ad set found after a lost answer gets the budget the step was changed to", async () => {
    const op = (daily: number): Op => ({ type: "create_adset", campaign: "c1", name: "Lost set", daily_budget: daily, goal: "LEAD_GENERATION" });
    const v = await createPlan({ ops: [op(300)] }, WHO, "claude");
    await confirm(v.key);
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/adsets", kind: "timeout_after_create" });
    await run(v.key);
    expect(Number(named("adset", "Lost set")[0].daily_budget)).toBe(30000);
    const u = await updatePlan(v.key, { ops: [op(200)] });
    expect(u.summary!.adsets[0].dailyBudget).toBe(200);
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    const sets = named("adset", "Lost set");
    expect(sets).toHaveLength(1);
    expect(Number(sets[0].daily_budget)).toBe(20000);
    expect(sets[0].status).toBe("PAUSED");
  });
});

describe("R2 · a stopped step changed from ON to paused turns off what it made", () => {
  it("ads from a post: the ad made ON is paused again, and no second ad is made in its ad set", async () => {
    const op = (status?: "ACTIVE"): Op => ({ type: "ads_from_post", post_id: "p1_555", adsets: ["as1", "as4"], ...(status ? { status } : {}) });
    const v = await createPlan({ ops: [op("ACTIVE")] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    let n = 0;
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/ads" && ++n === 2, kind: "error", error: fail });
    await run(v.key);
    const first = progress(v.key)[0].ids[0];
    expect(mock.objects.get(first)!.status).toBe("ACTIVE");
    const u = await updatePlan(v.key, { ops: [op()] });
    expect(warningsOf(u.summary!)).toMatch(/Step 1 keeps the 1 item it made before it stopped and changes it to match the new settings when the plan runs \(status\)/);
    expect(u.canSpend).toBe(false);
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    expect(mock.objects.get(first)!.status).toBe("PAUSED");
    expect(mock.of("ad").filter((a) => a.adset_id === "as1")).toHaveLength(1);
    expect(mock.objects.get(progress(v.key)[0].ids[1])!.status).toBe("PAUSED");
  });

  it("copy_ad: the copy turned ON before the stop is paused again (the status is always sent)", async () => {
    mock.objects.set("cr_ad9", { _type: "creative", id: "cr_ad9", name: "Creative [L:t-01]", object_story_spec: { page_id: "p1", link_data: { link: "https://example.com", message: "Old", name: "Head", image_hash: "h1" } } });
    mock.objects.set("ad9", { _type: "ad", id: "ad9", name: "Ad 9 [L:t-01]", adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", creative_id: "cr_ad9" });
    const op = (status?: "ACTIVE"): Op => ({ type: "copy_ad", ad: "ad9", adsets: ["as1", "as4"], ...(status ? { status } : {}) });
    const v = await createPlan({ ops: [op("ACTIVE")] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    let n = 0;
    // The second new ad (on the same creative, C1) is refused with an error that stops the step.
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/ads" && ++n === 2, kind: "error", error: { message: "Permissions error", code: 200 } });
    await run(v.key);
    const first = progress(v.key)[0].ids[0];
    expect(mock.objects.get(first)!.status).toBe("ACTIVE");
    await updatePlan(v.key, { ops: [op()] });
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    expect(mock.objects.get(first)!.status).toBe("PAUSED");
  });

  it("a campaign made ON that the changed step no longer uses (other objective) is turned off when the plan runs", async () => {
    const start = at(Date.now(), 2);
    const end = at(Date.now(), 3);
    const op = (objective: string, periods = true): Op => ({ type: "create_campaign", name: "Orphan", objective, budget_level: "campaign", daily_budget: 1000, status: "ACTIVE", ...(periods ? { budget_schedules: [{ start, end, increase_percent: 20 }] } : {}) });
    const v = await createPlan({ ops: [op("OUTCOME_LEADS")] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    await run(v.key); // the practice Meta has no budget period route: the campaign is made (ON), then the step fails
    const old = progress(v.key)[0].ids[0];
    expect(mock.objects.get(old)!.status).toBe("ACTIVE");
    const u = await updatePlan(v.key, { ops: [op("OUTCOME_TRAFFIC", false)] });
    expect(warningsOf(u.summary!)).toMatch(/Step 1 now works on something else\. The 1 item it made before it stopped is not reused; it is turned off when the plan runs/);
    expect(await confirmAndRun(v.key, u.summary!.spendConfirmation)).toEqual({ done: 1, failed: 0 });
    expect(mock.objects.get(old)!.status).toBe("PAUSED");
    expect(progress(v.key)[0].ids[0]).not.toBe(old);
    expect(mock.objects.get(progress(v.key)[0].ids[0])!.objective).toBe("OUTCOME_TRAFFIC");
  });

  it("a copied ad set whose budget change was taken out of the step gets the original's budget back", async () => {
    const v = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as4", copies: 2, changes: [{ daily_budget: 2000 }, { daily_budget: 2000 }] }] }, WHO, "claude");
    await confirm(v.key);
    let n = 0;
    // A temporary error (code 100 would make the step rebuild the copy instead).
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/copies") && ++n === 2, kind: "error", error: { message: "Temporary problem", code: 2 } });
    await run(v.key);
    const first = progress(v.key)[0].ids[0];
    expect(Number(mock.objects.get(first)!.daily_budget)).toBe(200000);
    const u = await updatePlan(v.key, { ops: [{ type: "duplicate_adset", adset: "as4", copies: 2 }] });
    expect(u.summary!.adsets.filter((a) => a.isNew).map((a) => a.dailyBudget)).toEqual([800, 800]);
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    expect(Number(mock.objects.get(first)!.daily_budget)).toBe(80000);
  });
});

describe("R2 · a customer list changed after part of it was uploaded", () => {
  it("makes a new audience with exactly the new rows (the parts sent to the old one don't count)", async () => {
    const emails = Array.from({ length: 10_001 }, (_, i) => `u${i}@example.com`);
    const v = await createPlan({ ops: [{ type: "create_custom_audience", name: "Buyers", source: { kind: "customer_list", emails } }] }, WHO, "claude");
    await confirm(v.key);
    let n = 0;
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/users") && ++n === 2, kind: "network" });
    await run(v.key);
    const old = progress(v.key)[0].ids[0];
    expect((mock.objects.get(old)!.users as unknown[]).length).toBe(10_000);
    const u = await updatePlan(v.key, { ops: [{ type: "create_custom_audience", name: "Buyers", source: { kind: "customer_list", emails: emails.slice(1) } }] });
    expect(warningsOf(u.summary!)).toMatch(/Step 1 now works on something else.*an audience spends nothing/);
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    const now = progress(v.key)[0].ids[0];
    expect(now).not.toBe(old);
    expect((mock.objects.get(now)!.users as unknown[]).length).toBe(10_000);
  });
});

describe("R2 · lifetime budgets: days counted from the run, confirmation a day later", () => {
  it("confirming a day after the check says nothing changed in Meta (not 'budgets changed') and asks for the new total", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    mock.objects.get("c1")!.status = "ACTIVE";
    mock.objects.set("as5", { _type: "adset", id: "as5", name: "Lifetime AS", campaign_id: "c1", status: "PAUSED", lifetime_budget: "3000000", end_time: at(t0, 5.5), optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as5"] }] }, WHO, "claude");
    // 5.5 days left: whole days, rounded down (round 3) → 5 days → ₹6,000 a day.
    expect(v.summary!.spendConfirmation).toBe("₹6,000");
    vi.setSystemTime(t0 + DAY);
    const e = (await confirm(v.key, "₹6,000").catch((x: Error) => x)) as Error;
    // 4.5 days left → 4 days → ₹7,500 a day.
    expect(e.message).toMatch(/Nothing changed in Meta, but fewer days are left for the lifetime budgets .* ₹7,500 a day \(it was ₹6,000\)/);
    expect(e.message).not.toMatch(/Budgets changed/);
    expect(await confirmAndRun(v.key, "₹7,500")).toEqual({ done: 1, failed: 0 });
    expect(mock.objects.get("as5")!.status).toBe("ACTIVE");
  });

  it("a campaign-budget campaign with a lifetime budget that starts later is counted over its own days", async () => {
    const now = Date.now();
    mock.objects.set("c7", { _type: "campaign", id: "c7", name: "Later CBO", status: "PAUSED", objective: "OUTCOME_LEADS", lifetime_budget: "4000000", start_time: at(now, 10), stop_time: at(now, 12), special_ad_categories: [] });
    mock.objects.set("as7", { _type: "adset", id: "as7", name: "In later CBO", campaign_id: "c7", status: "ACTIVE", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c7"] }] });
    expect(s.spendConfirmation).toBe("₹20,000");
    expect((s.notes ?? []).join(" ")).toMatch(/₹40,000 lifetime counted as ₹20,000 a day \(2 days from .* until /);
    // 2.7 days from its start: a part of a day doesn't count as a day (rounded down to 2, not up to 3).
    mock.objects.get("c7")!.stop_time = at(now, 12.7);
    const part = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c7"] }] });
    expect(part.spendConfirmation).toBe("₹20,000");
    expect((part.notes ?? []).join(" ")).toMatch(/₹40,000 lifetime counted as ₹20,000 a day \(2 days from /);
  });
});

describe("R2 · other ways a plan makes more spend in a day", () => {
  it("an earlier end on a lifetime ad set that is on asks for the typed total", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    mock.objects.set("as5", { _type: "adset", id: "as5", name: "Lifetime AS", campaign_id: "c1", status: "ACTIVE", lifetime_budget: "3000000", end_time: at(Date.now(), 10), optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    // 2.5 days left: 2 whole days (rounded down) → ₹15,000 a day.
    const s = await summarise(clientFor(), { ops: [{ type: "edit_adset", adset: "as5", end_time: at(Date.now(), 2.5) }] });
    expect(s.canSpend).toBe(true);
    expect(s.spendConfirmation).toBe("₹15,000");
    const later = await summarise(clientFor(), { ops: [{ type: "edit_adset", adset: "as5", end_time: at(Date.now(), 20) }] });
    expect(later.canSpend).toBe(false);
  });

  it("a budget period that starts before the plan's run time is refused (it would be in the past then)", async () => {
    const now = Date.now();
    const s = await summarise(clientFor(), { run_at: at(now, 3), ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [{ start: at(now, 2), end: at(now, 2.5), increase_percent: 20 }] }] });
    expect(errorsOf(s)).toMatch(/budget period 1 starts at .* less than 10 minutes after the plan runs/);
  });
});

describe("R2 · budget periods count in the total and the ceiling", () => {
  const ops = (now: number): Op[] => [
    { type: "create_campaign", ref: "c", name: "Sale", objective: "OUTCOME_LEADS", budget_level: "campaign", daily_budget: 1000, status: "ACTIVE", budget_schedules: [{ start: at(now, 2), end: at(now, 3), increase_percent: 50 }, { start: at(now, 4), end: at(now, 5), increase_amount: 800 }] },
    { type: "create_adset", campaign: "$c", name: "Sale AS", goal: "LEAD_GENERATION", status: "ACTIVE" },
  ];

  it("a campaign made ON with periods asks for its budget plus the largest raise", async () => {
    const s = await summarise(clientFor(), { ops: ops(Date.now()) });
    expect(s.canSpend).toBe(true);
    expect(s.spendConfirmation).toBe("₹1,800");
    expect((s.notes ?? []).join(" ")).toMatch(/Campaign "Sale": ₹1,000 a day, and up to ₹1,800 a day during its budget periods/);
  });

  it("the daily ceiling counts the raise", async () => {
    saveAppSettings({ dailyBudgetCeiling: 1500 }, WHO);
    const s = await summarise(clientFor(), { ops: ops(Date.now()) });
    expect(errorsOf(s)).toMatch(/would let ₹1,800 a day spend, above the daily budget ceiling of ₹1,500/);
  });

  it("a period Meta already took can't be taken out of the step on a retry (the launcher can't remove it)", async () => {
    const p1 = { start: at(Date.now(), 2), end: at(Date.now(), 2.5), increase_percent: 20 };
    const p2 = { start: at(Date.now(), 4), end: at(Date.now(), 4.5), increase_percent: 30 };
    let sent = 0;
    const orig = mock.fetch;
    mock.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/budget_schedules") && (init?.method ?? "GET").toUpperCase() === "POST") {
        if (++sent === 2) return Response.json({ error: { message: "Invalid parameter", code: 100, error_user_msg: "Period refused." } }, { status: 400 });
        return Response.json({ id: `bs${sent}` });
      }
      return orig(input, init);
    }) as typeof fetch;
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1, p2] }] }, WHO, "claude");
    await confirmAndRun(v.key, v.summary!.spendConfirmation);
    await expect(updatePlan(v.key, { ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [{ ...p2, increase_percent: 25 }] }] })).rejects.toThrow(/already added the budget period .* can't remove a budget period/);
  });
});

describe("R2 · a retried plan given a new time is checked again when it runs", () => {
  it("budgets raised in Ads Manager before the new time: back to a draft, nothing turned on", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as4", name: "Renamed" }, { type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirm(v.key, "₹500");
    mock.inject({ match: (m, p) => m === "POST" && p === "as1", kind: "error", error: fail });
    await run(v.key);
    expect(getPlan(v.key).status).toBe("partial");
    const u = await updatePlan(v.key, { run_at: at(Date.now(), 1) });
    expect(u.runAt).toBeTruthy();
    await confirm(v.key, "₹500");
    mock.objects.get("as1")!.daily_budget = "90000";
    const r = await run(v.key);
    expect(r.reopened).toMatch(/₹900 a day \(it was ₹500\)/);
    expect(mock.objects.get("as1")!.status).toBe("PAUSED");
    expect(getPlan(v.key).status).toBe("draft");
    expect(progress(v.key)[0].status).toBe("done");
    expect(progress(v.key)[1].message).toMatch(/^Not run at /);
  });
});

describe("R2 · POST /api/plans/{key}/retry", () => {
  it("takes a new run time and title without ops", async () => {
    const KEY = "sal_r2_plans_key";
    db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, 'test', ?, 'test')").run(WHO, sha256(KEY));
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as1", name: "X" }, { type: "edit_adset", adset: "as4", name: "Y" }] }, WHO, "claude");
    await confirm(v.key);
    mock.inject({ match: (m, p) => m === "POST" && p === "as4", kind: "error", error: fail });
    await run(v.key);
    expect(getPlan(v.key).status).toBe("partial");
    const { POST } = await import("@/app/api/plans/[key]/[action]/route");
    const when = at(Date.now(), 2);
    const res = await POST(new Request(`http://app/api/plans/${v.key}/retry`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ run_at: when, title: "Second try" }) }), { params: Promise.resolve({ key: v.key, action: "retry" }) });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { runAt: string | null; title: string; status: string };
    expect(view.status).toBe("draft");
    expect(view.title).toBe("Second try");
    expect(timeMs(view.runAt)).toBe(Date.parse(when));
  });
});
