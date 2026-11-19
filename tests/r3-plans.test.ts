import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { appLink, recentAlerts, sendAlert } from "@/lib/alerts";
import { cancelPlan, confirmPlan, createPlan, planView, undoPlan, updatePlan } from "@/lib/manage/service";
import { getPlan, runPlan, summarise, type Op } from "@/lib/manage/plan";
import { reopenedReason } from "@/app/plans/[key]/plan-logic";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Round 3, group PLANS: each test runs the real plan engine against the practice Meta.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
const WHO = "r3plans@example.com";
process.env.ALLOWED_EMAILS = WHO;
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let clock: FakeClock;
let mock: MockMeta;

function practiceMeta(opts: { budgetSchedules?: boolean } = {}) {
  mock = new MockMeta({ clock, capPoints: 90000, richAccount: true, allowActive: true, videoProcessingMs: 1000, ...opts });
  g.__mockMeta = mock;
}

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  practiceMeta({ budgetSchedules: true });
  upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
});
afterEach(() => {
  vi.useRealTimers();
});

const run = (key: string, deps: Partial<Parameters<typeof runPlan>[1]> = {}) => runPlan(getPlan(key).id, { client: clientFor(), clock, ...deps });
const confirm = (key: string, spend?: string | null) => confirmPlan(key, { confirm: true, acceptWarnings: true, spendConfirmation: spend ?? undefined }, WHO);
async function confirmAndRun(key: string, spend?: string | null) {
  await confirm(key, spend);
  return run(key);
}
type Prog = { status: string; ids: string[]; message: string; orphans?: { id: string }[]; unused?: { id: string; kind: string }[] };
const progress = (key: string) => JSON.parse(getPlan(key).progress) as Prog[];
const summaryOf = (key: string) => JSON.parse(getPlan(key).summary!) as { spendConfirmation: string | null; checks: { level: string; code: string; message: string }[] };
const errorsOf = (s: { checks: { level: string; message: string }[] }) => s.checks.filter((c) => c.level === "error").map((c) => c.message).join("\n");
const notesOf = (s: { checks: { code: string; message: string }[] }) => s.checks.filter((c) => c.code === "plan_note").map((c) => c.message).join("\n");
const status = (id: string) => mock.objects.get(id)?.status;
const fail = { message: "Invalid parameter", code: 100, error_user_msg: "Refused (test)." };
const DAY = 86_400_000;
const at = (base: number, d: number) => new Date(base + d * DAY).toISOString();
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
/** A budget period as Meta keeps it on a campaign (budget_value in paise). */
const metaPeriod = (id: string, start: string, end: string, value: number, type = "ABSOLUTE", st = "ACTIVE") => ({ id, budget_value: String(value), budget_value_type: type, time_start: sec(start), time_end: sec(end), status: st });

describe("R3 · Stop while a turn-on step runs", () => {
  it("a cancel during the turn-on stops before the next item: the campaign (last) stays off and the plan stays cancelled", async () => {
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1", "as4"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    // The person presses Cancel while the first ad set is being turned on.
    let first = true;
    mock.inject({ match: (m, p) => { if (first && m === "POST" && p === "as1") { first = false; cancelPlan(v.key); } return false; }, kind: "error" });
    expect(await run(v.key)).toEqual({ done: 0, failed: 1 });
    expect(status("as1")).toBe("ACTIVE");
    expect(status("as4")).toBe("PAUSED");
    expect(status("c1")).toBe("PAUSED"); // nothing spends
    expect(getPlan(v.key).status).toBe("cancelled");
    expect(progress(v.key)[0].message).toMatch(/^Stopped because the plan was cancelled: 1 of 3 items turned on \(they stay on\); the other 2 were not changed, so the campaign stays off( and nothing spends)?\./);
  });

  it("a cancel that comes while the last step finishes leaves the plan cancelled (not done)", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as1", name: "Renamed" }] }, WHO, "claude");
    await confirm(v.key);
    mock.inject({ match: (m, p) => { if (m === "POST" && p === "as1") cancelPlan(v.key); return false; }, kind: "error" });
    expect(await run(v.key)).toEqual({ done: 1, failed: 0 });
    expect(getPlan(v.key).status).toBe("cancelled");
    expect(getPlan(v.key).finished_at).toBeTruthy();
  });

  it("the page says the plan stops now while a step is still running", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as1", name: "X" }] }, WHO, "claude");
    await confirm(v.key);
    let label = "";
    mock.inject({ match: (m, p) => { if (m === "POST" && p === "as1") { cancelPlan(v.key); label = planView(v.key).statusLabel; } return false; }, kind: "error" });
    await run(v.key);
    expect(label).toMatch(/^Stopping now: .* What it already made or turned on stays as it is/);
  });

  it("Cancel clears the home-page alerts about the plan", async () => {
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    await sendAlert({ to: WHO, subject: `Plan ${v.key} needs a yes`, lines: ["x"], link: appLink(`/plans/${v.key}`), kind: "golive" });
    expect(recentAlerts().some((a) => a.subject.includes(v.key))).toBe(true);
    cancelPlan(v.key);
    expect(recentAlerts().some((a) => a.subject.includes(v.key))).toBe(false);
  });
});

describe("R3 · checked again when the run starts", () => {
  it("a plan confirmed a while ago (waited behind other plans) is checked again: a budget raised since sends it back, nothing turned on", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirm(v.key, "₹500");
    mock.objects.get("as1")!.daily_budget = "300000";
    vi.setSystemTime(t0 + 10 * 60_000);
    const r = await run(v.key);
    expect(r.reopened).toMatch(/now ₹3,000 a day \(it was ₹500\)/);
    expect(status("as1")).toBe("PAUSED");
    expect(getPlan(v.key).status).toBe("draft");
    const why = progress(v.key)[0].message;
    expect(why).toMatch(/^Not run: what can spend changed .* Read the plan again and confirm it to run it\.$/);
    expect(reopenedReason(planView(v.key))).toBe(why);
  });

  it("a plan run right after the person confirmed it is not checked again (no second read of everything)", async () => {
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirm(v.key, "₹500");
    const before = mock.calls.length;
    expect(await run(v.key)).toEqual({ done: 1, failed: 0 });
    const reads = mock.calls.slice(before).filter((c) => c.method === "GET" && c.path !== "act_1001");
    expect(reads.length).toBeLessThanOrEqual(2); // the statuses of the ad set and the campaign
  });
});

describe("R3 · budget periods already in Meta", () => {
  it("a period already on a campaign the plan turns on counts in the total and the ceiling", async () => {
    const now = Date.now();
    mock.objects.get("c2")!.budget_schedules = [metaPeriod("bs1", at(now, 2), at(now, 3), 50000)];
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] });
    expect(s.spendConfirmation).toBe("₹1,500");
    expect((s.notes ?? []).join(" ")).toMatch(/Campaign "CBO campaign" already has a budget period in Meta: .* \+₹500 a day/);
  });

  it("the same period added in Ads Manager and by the plan counts twice (Meta would have both)", async () => {
    const now = Date.now();
    mock.objects.get("c2")!.status = "ACTIVE";
    mock.objects.get("c2")!.budget_schedules = [metaPeriod("bs1", at(now, 2), at(now, 3), 50000)];
    const s = await summarise(clientFor(), { ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [{ start: at(now, 2), end: at(now, 3), increase_amount: 500 }] }] });
    expect(s.spendConfirmation).toBe("₹2,000");
  });

  it("a period that ended, or a deleted one, doesn't count", async () => {
    const now = Date.now();
    mock.objects.get("c2")!.budget_schedules = [metaPeriod("bs1", at(now, -3), at(now, -2), 50000), metaPeriod("bs2", at(now, 2), at(now, 3), 70000, "ABSOLUTE", "DELETED")];
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] });
    expect(s.spendConfirmation).toBe("₹1,000");
  });

  it("a period set as a multiple of the budget is not guessed: the plan can't be confirmed, and says why", async () => {
    const now = Date.now();
    mock.objects.get("c2")!.budget_schedules = [metaPeriod("bs1", at(now, 2), at(now, 3), 2, "MULTIPLIER")];
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] });
    expect(errorsOf(s)).toMatch(/Campaign "CBO campaign" has a budget period in Meta .* set as a multiple of its budget\. The launcher can't count that/);
  });

  it("periods that can't be read stop the check (what can spend is not known)", async () => {
    mock.inject({ match: (m, p) => m === "GET" && p === "c2/budget_schedules", kind: "error", error: { message: "Unsupported get request", code: 100 } });
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] });
    expect(errorsOf(s)).toMatch(/Couldn't read the budget periods of campaign "CBO campaign" in Meta, so what it can spend is not known/);
  });

  it("a period this plan adds is counted once, also after Meta took it (a finished step on retry)", async () => {
    const p1 = { start: at(Date.now(), 2), end: at(Date.now(), 2.5), increase_percent: 50 };
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1] }, { type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] }, WHO, "claude");
    expect(v.summary!.spendConfirmation).toBe("₹1,500");
    await confirm(v.key, "₹1,500");
    mock.inject({ match: (m, p) => m === "POST" && p === "c2", kind: "error", error: fail });
    await run(v.key);
    expect(progress(v.key).map((p) => p.status)).toEqual(["done", "failed"]);
    expect((mock.objects.get("c2")!.budget_schedules as unknown[]).length).toBe(1);
    const u = await updatePlan(v.key);
    expect(u.summary!.spendConfirmation).toBe("₹1,500"); // not ₹2,000
    expect(await confirmAndRun(v.key, "₹1,500")).toEqual({ done: 2, failed: 0 });
    expect(status("c2")).toBe("ACTIVE");
  });

  it("a period whose answer was lost is found in Meta on retry and not sent again", async () => {
    mock.objects.get("c2")!.status = "ACTIVE";
    const p1 = { start: at(Date.now(), 2), end: at(Date.now(), 2.5), increase_amount: 500 };
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    mock.inject({ match: (m, p) => m === "POST" && p === "c2/budget_schedules", kind: "timeout_after_create" });
    await run(v.key);
    expect(progress(v.key)[0].status).toBe("failed");
    const u = await updatePlan(v.key);
    expect(u.summary!.spendConfirmation).toBe("₹1,500"); // the period in Meta, counted once
    expect(await confirmAndRun(v.key, "₹1,500")).toEqual({ done: 1, failed: 0 });
    expect((mock.objects.get("c2")!.budget_schedules as unknown[]).length).toBe(1);
    expect(mock.calls.filter((c) => c.method === "POST" && c.path === "c2/budget_schedules")).toHaveLength(1);
  });

  it("after a lost answer, periods that can't be read stop the step in plain words; nothing is sent twice", async () => {
    mock.objects.get("c2")!.status = "ACTIVE";
    const p1 = { start: at(Date.now(), 2), end: at(Date.now(), 2.5), increase_amount: 500 };
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    mock.inject({ match: (m, p) => m === "POST" && p === "c2/budget_schedules", kind: "timeout_after_create" });
    await run(v.key);
    await updatePlan(v.key);
    await confirm(v.key, "₹1,500");
    // The read after the lost answer fails (the confirmation's own read worked).
    mock.inject({ match: (m, p) => m === "GET" && p === "c2/budget_schedules", kind: "error", error: { message: "Unsupported get request", code: 100 } });
    expect(await run(v.key)).toEqual({ done: 0, failed: 1 });
    expect(progress(v.key)[0].message).toMatch(/was sent to Meta before, but Meta's answer never came, and the launcher couldn't read the campaign's budget periods .* It was not sent again/);
    expect(mock.calls.filter((c) => c.method === "POST" && c.path === "c2/budget_schedules")).toHaveLength(1);
  });

  it("a period Meta refused (a clear no) is sent again on retry without a lookup", async () => {
    const p1 = { start: at(Date.now(), 2), end: at(Date.now(), 2.5), increase_amount: 500 };
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    mock.inject({ match: (m, p) => m === "POST" && p === "c2/budget_schedules", kind: "error", error: fail });
    await run(v.key);
    await updatePlan(v.key);
    const before = mock.calls.length;
    expect(await confirmAndRun(v.key, summaryOf(v.key).spendConfirmation)).toEqual({ done: 1, failed: 0 });
    expect((mock.objects.get("c2")!.budget_schedules as unknown[]).length).toBe(1);
    // The run reads no periods (only the confirmation's check does).
    const runReads = mock.calls.slice(before).filter((c) => c.method === "GET" && c.path === "c2/budget_schedules");
    expect(runReads.length).toBeLessThanOrEqual(1);
  });
});

describe("R3 · what makes an ON object spend again", () => {
  it("a higher spend limit on an ON campaign needs the typed total", async () => {
    Object.assign(mock.objects.get("c2")!, { status: "ACTIVE", spend_cap: "1000000" });
    const s = await summarise(clientFor(), { ops: [{ type: "edit_campaign", campaign: "c2", spend_cap: 20000 }] });
    expect(s.canSpend).toBe(true);
    expect(s.spendConfirmation).toBe("₹1,000");
    const lower = await summarise(clientFor(), { ops: [{ type: "edit_campaign", campaign: "c2", spend_cap: 5000 }] });
    expect(lower.canSpend).toBe(false);
  });

  it("an ON ad set that has ended counts as ₹0 (it can't spend)", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    Object.assign(mock.objects.get("as4")!, { status: "ACTIVE", end_time: at(Date.now(), -1) });
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"] }] });
    expect(s.spendConfirmation).toBe("₹500"); // as1 only, not as4's ₹800
  });

  it("an ON ad set that has not started yet, started earlier, needs the typed total", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    Object.assign(mock.objects.get("as1")!, { status: "ACTIVE", start_time: at(Date.now(), 20) });
    const s = await summarise(clientFor(), { ops: [{ type: "edit_adset", adset: "as1", start_time: at(Date.now(), 1) }] });
    expect(s.canSpend).toBe(true);
    expect(s.spendConfirmation).toBe("₹500");
  });
});

describe("R3 · the stopped step keeps its record", () => {
  it("taking out a stopped step that turned something on is refused in plain words", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as2", name: "Renamed" }, { type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    mock.inject({ match: (m, p) => m === "POST" && p === "c1", kind: "error", error: fail });
    await run(v.key);
    await expect(updatePlan(v.key, { ops: [{ type: "edit_adset", adset: "as2", name: "Renamed" }] })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Step 2 stopped part-way .* so it can't be taken out: the plan keeps it so "Undo this plan" can put those back/) });
  });

  it("a stopped step that made nothing (Meta refused its first item) can be taken out", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as2", name: "Renamed" }, { type: "create_adset", campaign: "c1", name: "Refused set", daily_budget: 300, goal: "LEAD_GENERATION" }] }, WHO, "claude");
    await confirm(v.key);
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/adsets", kind: "error", error: fail });
    await run(v.key);
    expect(progress(v.key)[1].status).toBe("failed");
    const u = await updatePlan(v.key, { ops: [{ type: "edit_adset", adset: "as2", name: "Renamed" }] });
    expect(u.status).toBe("draft");
  });

  it("a turn-on step changed to other targets turns off what the first version turned on", async () => {
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1", "as4"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    mock.inject({ match: (m, p) => m === "POST" && p === "c1", kind: "error", error: fail });
    await run(v.key);
    expect([status("as1"), status("as4")]).toEqual(["ACTIVE", "ACTIVE"]);
    const u = await updatePlan(v.key, { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] });
    expect(notesOf(u.summary!)).toMatch(/Step 1 now works on something else\. The 2 items it turned on before it stopped are turned off when the plan runs/);
    expect(u.summary!.spendConfirmation).toBe("₹500");
    expect(await confirmAndRun(v.key, "₹500")).toEqual({ done: 1, failed: 0 });
    expect([status("as1"), status("as4"), status("c1")]).toEqual(["ACTIVE", "PAUSED", "ACTIVE"]);
  });
});

describe("R3 · fewer copies on retry", () => {
  it("the dropped copy leaves the step (not used by a later $ref), and Undo still turns it off", async () => {
    const w = await createPlan({ ops: [{ type: "duplicate_adset", ref: "cp", adset: "as1", copies: 3 }, { type: "edit_adset", adset: "$cp", daily_budget: 450 }] }, WHO, "claude");
    await confirm(w.key);
    let posts = 0;
    mock.inject({ match: (m, p) => m === "POST" && /^\d+$/.test(p) && ++posts === 3, kind: "error", error: fail });
    await run(w.key);
    const third = progress(w.key)[0].ids[2];
    const u = await updatePlan(w.key, { ops: [{ type: "duplicate_adset", ref: "cp", adset: "as1", copies: 2 }, { type: "edit_adset", adset: "$cp", daily_budget: 450 }] });
    expect(notesOf(u.summary!)).toMatch(/Step 1 keeps the 2 items it made before it stopped\./);
    expect(notesOf(u.summary!)).toMatch(/Step 1 now makes 2 copies, but it made 3 before it stopped\. The last one is not used and stays paused \(nothing is deleted; "Undo this plan" turns it off too\)\./);
    expect(progress(w.key)[0].ids).toHaveLength(2);
    expect(await confirmAndRun(w.key)).toEqual({ done: 2, failed: 0 });
    expect(Number(mock.objects.get(third)!.daily_budget)).toBe(50000); // not edited by "$cp"
    const undo = await undoPlan(w.key, WHO, "claude");
    const off = undo.input.ops.find((o) => o.type === "set_status" && o.status === "PAUSED") as { adsets?: string[] };
    expect(off.adsets).toContain(third);
  });

  it("copies made ON by the stopped step are counted once in the total", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const op: Op = { type: "duplicate_adset", adset: "as1", changes: [{ status: "ACTIVE", daily_budget: 900 }, { status: "ACTIVE", daily_budget: 900 }] };
    const v = await createPlan({ ops: [op] }, WHO, "claude");
    expect(v.summary!.spendConfirmation).toBe("₹1,800");
    await confirm(v.key, "₹1,800");
    let posts = 0;
    mock.inject({ match: (m, p) => m === "POST" && /^\d+$/.test(p) && ++posts === 2, kind: "error", error: fail });
    await run(v.key);
    expect(status(progress(v.key)[0].ids[0])).toBe("ACTIVE");
    const u = await updatePlan(v.key);
    expect(u.summary!.spendConfirmation).toBe("₹1,800"); // not ₹2,700
  });
});

describe("R3 · ads from a post: a wrong ad set fixed", () => {
  it("keeps the ad of the ad set it still uses and turns off the ON ad in the ad set it no longer uses", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    mock.objects.set("2001", { _type: "adset", id: "2001", name: "Right set", campaign_id: "c1", status: "ACTIVE", daily_budget: "40000", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    mock.objects.set("2002", { _type: "adset", id: "2002", name: "Wrong set", campaign_id: "c1", status: "ACTIVE", daily_budget: "40000", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    mock.objects.set("2003", { _type: "adset", id: "2003", name: "Other set", campaign_id: "c1", status: "ACTIVE", daily_budget: "40000", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const op = (sets: string[]): Op => ({ type: "ads_from_post", post_id: "p1_123", adsets: sets, name: "Post ad", status: "ACTIVE" });
    const v = await createPlan({ ops: [op(["2001", "2002", "2003"])] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    let ads = 0;
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/ads" && ++ads === 3, kind: "error", error: fail });
    await run(v.key);
    const [inRight, inWrong] = progress(v.key)[0].ids;
    expect([status(inRight), status(inWrong)]).toEqual(["ACTIVE", "ACTIVE"]);
    const u = await updatePlan(v.key, { ops: [op(["2001", "2003"])] });
    expect(notesOf(u.summary!)).toMatch(/Step 1 now uses other ad sets\. It keeps the ad it already made in ad sets it still uses \(no second ad there\), and doesn't use the ad it made in ad sets it no longer uses: it is turned off when the plan runs/);
    expect(await confirmAndRun(v.key, u.summary!.spendConfirmation)).toEqual({ done: 1, failed: 0 });
    expect(mock.of("ad").filter((a) => a.adset_id === "2001")).toHaveLength(1);
    expect(mock.of("ad").filter((a) => a.adset_id === "2003")).toHaveLength(1);
    expect(status(inWrong)).toBe("PAUSED");
    expect(progress(v.key)[0].ids[0]).toBe(inRight);
  });
});

describe("R3 · messages", () => {
  it("a copy step stopped by Cancel says which copies are on and which are paused", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const v = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as1", changes: [{ status: "ACTIVE" }, {}, { status: "ACTIVE" }] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    let n = 0;
    await run(v.key, { afterCreate: () => { if (++n === 2) cancelPlan(v.key); } });
    expect(progress(v.key)[0].message).toMatch(/cancelled: 2 of 3 copies made \(kept: 1 on, 1 paused\)/);
  });

  it("an edit step changed to another ad set says the items it changed keep those changes (not 'paused')", async () => {
    const v = await createPlan({ ops: [{ type: "duplicate_adset", ref: "x", adset: "as1", copies: 2 }, { type: "edit_adset", adset: "$x", daily_budget: 900 }] }, WHO, "claude");
    await confirm(v.key);
    let posts = 0;
    mock.inject({ match: (m, p) => m === "POST" && /^\d+$/.test(p) && ++posts === 4, kind: "error", error: fail });
    await run(v.key);
    const u = await updatePlan(v.key, { ops: [{ type: "duplicate_adset", ref: "x", adset: "as1", copies: 2 }, { type: "edit_adset", adset: "$x.2", daily_budget: 900 }] });
    expect(notesOf(u.summary!)).toMatch(/Step 2 now works on something else\. The 1 item it changed before it stopped keeps those changes \("Undo this plan" can still put them back\)\./);
  });

  it("a wrong typed amount is refused without calling it the total daily budget", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"] }] }, WHO, "claude");
    const msg = await confirm(v.key, "₹1").catch((e: Error) => e.message);
    expect(msg).toMatch(/^The amount you typed doesn't match\. .* typing what can spend in a day once the plan has run, exactly as shown: ₹500\.$/);
  });
});

describe("R3 · Meta calls when the plan runs", () => {
  it("a name is looked up once with Meta's name filter, or not at all when the check found it", async () => {
    for (let i = 0; i < 50; i++) mock.objects.set(`asn${i}`, { _type: "adset", id: `asn${i}`, name: `Set ${i}`, campaign_id: "c1", status: "PAUSED", daily_budget: "10000", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "Set 7", daily_budget: 250 }] }, WHO, "claude");
    await confirm(v.key);
    // After confirming, another ad set gets the same name in Ads Manager: the run uses the one confirmed.
    mock.objects.set("asn_dup", { _type: "adset", id: "asn_dup", name: "Set 7", campaign_id: "c1", status: "PAUSED", daily_budget: "10000" });
    const before = mock.calls.length;
    expect(await run(v.key)).toEqual({ done: 1, failed: 0 });
    expect(mock.calls.slice(before).filter((c) => c.method === "GET" && c.path === "act_1001/adsets")).toHaveLength(0);
    expect(Number(mock.objects.get("asn7")!.daily_budget)).toBe(25000);
    expect(Number(mock.objects.get("asn_dup")!.daily_budget)).toBe(10000);
  });

  it("ads from a post read their ad sets' names only when the name template uses {adset}", async () => {
    const make = async (template?: string) => {
      const v = await createPlan({ ops: [{ type: "ads_from_post", post_id: "p1_123", adsets: ["as1", "as2"], ...(template ? { name_template: template } : { name: "Plain" }) }] }, WHO, "claude");
      await confirm(v.key);
      const before = mock.calls.length;
      expect(await run(v.key)).toEqual({ done: 1, failed: 0 });
      return { reads: mock.calls.slice(before).filter((c) => c.method === "GET" && /^(as\d|act_1001\/adsets)$/.test(c.path)).length, key: v.key };
    };
    expect((await make()).reads).toBe(0);
    const t = await make("{adset} - post");
    expect(t.reads).toBe(1);
    expect(mock.of("ad").some((a) => a.name === "November test ad set - post")).toBe(true);
  });
});
