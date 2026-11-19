import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { cancelPlan, confirmPlan, createPlan, undoPlan, updatePlan } from "@/lib/manage/service";
import { getPlan, runPlan, summarise, type PlanInput } from "@/lib/manage/plan";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Critique of tests/audit-plans.test.ts: extra checks on the plan engine. Each test names what
// SHOULD happen; a failing test confirms a defect (or a gap the auditor missed) on the fake Meta.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let clock: FakeClock;
let mock: MockMeta;
const WHO = "critique@example.com";

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
const progress = (key: string) => JSON.parse(getPlan(key).progress) as { status: string; ids: string[]; message: string }[];

function addAd(id: string, adset: string) {
  mock.objects.set(`cr_${id}`, { _type: "creative", id: `cr_${id}`, name: `Creative ${id} [L:t-01]`, object_story_spec: { page_id: "p1", link_data: { link: "https://example.com", message: "Old", name: "Head", image_hash: "h1", call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } } } } });
  mock.objects.set(id, { _type: "ad", id, name: `Ad ${id} [L:t-01]`, adset_id: adset, status: "PAUSED", effective_status: "PAUSED", creative_id: `cr_${id}` });
}

describe("critique: retry and schedule", () => {
  it("MISSED: a scheduled plan that ran and stopped can be retried as it is (its start time is now in the past)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const at = new Date(now + 3_600_000).toISOString();
    const v = await createPlan({ run_at: at, ops: [
      { type: "edit_adset", adset: "as1", name: "Renamed" },
      { type: "edit_adset", adset: "as4", name: "Renamed 4" },
    ] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    vi.setSystemTime(now + 2 * 3_600_000); // the worker runs it at run_at
    mock.inject({ match: (m, p) => m === "POST" && p === "as4", kind: "error", error: { message: "Temporary problem", code: 2 } });
    expect(await run(v.key)).toEqual({ done: 1, failed: 1 });
    const r = await updatePlan(v.key); // "Try the rest again" / retry_plan without ops
    expect(r.summary!.checks.filter((c) => c.level === "error").map((c) => c.message)).toEqual([]);
  });

  it("MISSED (#9 harm): a retried edit_ad step does not put a NEW creative on an ad it already finished (that ad would go back to review)", async () => {
    addAd("ad9", "as1");
    // Meta's idempotency header is "rolling out ... ignored where not enabled": model an account without it.
    const orig = mock.fetch;
    mock.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      h.delete("x-client-idempotent-key");
      return orig(input, { ...init, headers: h });
    }) as typeof fetch;
    // One edit_ad step for two ads, so the 2nd ad's failure leaves the 1st finished inside the step.
    const v2 = await createPlan({ ops: [{ type: "copy_ad", ref: "cp", ad: "ad9", adsets: ["as1", "as4"] }, { type: "edit_ad", ad: "$cp", primary_texts: ["New"] }] }, WHO, "claude");
    await confirmPlan(v2.key, { confirm: true, acceptWarnings: true }, WHO);
    let creatives = 0;
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/adcreatives" && ++creatives === 2, kind: "error", error: { message: "Temporary problem", code: 2 } });
    await run(v2.key);
    const first = progress(v2.key)[1].ids[0];
    const creativeAfterRun1 = mock.objects.get(first)!.creative_id;
    await updatePlan(v2.key);
    await confirmAndRun(v2.key);
    expect(mock.objects.get(first)!.creative_id).toBe(creativeAfterRun1);
  });
});

describe("critique: typed total, more paths than the auditor listed", () => {
  it("copy_ad with status ACTIVE into a live ad set asks for that ad set's spend, not ₹0", async () => {
    addAd("ad9", "as3");
    mock.objects.get("c2")!.status = "ACTIVE";
    const s = await summarise(clientFor(), { ops: [{ type: "copy_ad", ad: "ad9", adsets: ["as3"], status: "ACTIVE" }] });
    expect(s.canSpend).toBe(true);
    expect(s.spendConfirmation).toBe("₹1,000");
  });

  it("edit_ad turning ON an existing ad in a live ad set asks for ₹1,000, not ₹0", async () => {
    addAd("ad9", "as3");
    mock.objects.get("c2")!.status = "ACTIVE";
    const s = await summarise(clientFor(), { ops: [{ type: "edit_ad", ad: "ad9", status: "ACTIVE" }] });
    expect(s.canSpend).toBe(true);
    expect(s.spendConfirmation).toBe("₹1,000");
  });
});

describe("critique: refs to several items", () => {
  it("MISSED: edit_campaign on '$copies' (3 copies) edits all 3 or the check refuses (today: only copy 1, silently)", async () => {
    mock.objects.get("c2")!.status = "PAUSED";
    const s = await summarise(clientFor(), { ops: [
      { type: "duplicate_campaign", ref: "copies", campaign: "c2", copies: 3 },
      { type: "edit_campaign", campaign: "$copies", daily_budget: 2000 },
    ] });
    const titled3 = /3 campaigns/.test(s.steps[1].title);
    expect(titled3 || s.errors > 0).toBe(true);
  });
});

describe("critique: copies between budget types", () => {
  it("SUSPECTED: an ad set copied from a campaign-budget campaign into an ad-set-budget campaign with a per-copy budget can be made when Meta refuses the plain copy", async () => {
    const v = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as3", campaign: "c1", changes: [{ daily_budget: 300 }] }] }, WHO, "claude");
    expect(v.summary!.errors).toBe(0); // the check says OK
    // Real Meta (judgement): a copy without a budget can't go into a campaign without campaign budget.
    mock.inject({ match: (m, p) => m === "POST" && p === "as3/copies", kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Ad set needs a budget." } });
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
  });

  it("SUSPECTED: switching an ad set from a daily to a lifetime budget is flagged (Meta doesn't switch budget types), and the total doesn't count both", async () => {
    const end = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const s = await summarise(clientFor(), { ops: [{ type: "edit_adset", adset: "as1", lifetime_budget: 10_000, end_time: end }] });
    const row = s.adsets.find((a) => a.name === "November test ad set")!;
    expect(row.dailyBudget !== 500 || s.errors > 0).toBe(true);
  });
});

describe("critique: messages after a failed step", () => {
  it("a turn-on step that failed part-way does not say the items it turned ON are 'kept, paused'", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1", "as4"] }] }, WHO, "claude");
    mock.inject({ match: (m, p) => m === "POST" && p === "as4", kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Refused." } });
    await confirmAndRun(v.key, v.summary!.spendConfirmation!);
    expect(mock.objects.get("as1")!.status).toBe("ACTIVE");
    expect(progress(v.key)[0].message).not.toMatch(/kept, paused/);
  });
});

describe("critique: fields the plan doesn't know (#16, worst case)", () => {
  it("duplicate_adset with 'count: 5' (instead of copies) is refused, not run as 1 copy", async () => {
    const s = await summarise(clientFor(), { ops: [{ type: "duplicate_adset", adset: "as1", count: 5 } as never] });
    expect(s.errors).toBeGreaterThan(0);
  });
});

describe("critique: undo restores only what the plan changed", () => {
  it("MISSED: the undo of a rename sends back only the name (not the budget, bid, times and full targeting read before)", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as1", name: "Renamed" }] }, WHO, "claude");
    await confirmAndRun(v.key);
    // Someone raises the budget in Ads Manager after the plan ran.
    mock.objects.get("as1")!.daily_budget = "90000";
    const u = await undoPlan(v.key, WHO, "claude");
    const op = u.input.ops[0] as Record<string, unknown>;
    expect(Object.keys(op).filter((k) => op[k] !== undefined).sort()).toEqual(["adset", "name", "type"]);
  });
});

describe("critique: long steps", () => {
  it("SUSPECTED: cancelling a plan stops a long copy step before it makes every copy", async () => {
    const v = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as1", copies: 5 }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    let n = 0;
    await run(v.key, { afterCreate: () => { if (++n === 1) cancelPlan(v.key); } });
    expect(mock.of("adset").filter((a) => String(a.name).startsWith("November test ad set - copy")).length).toBeLessThan(5);
  });

  it("SUSPECTED: a retried copy step does not write again to the copies it already finished", async () => {
    const ops: PlanInput["ops"] = [{ type: "duplicate_adset", adset: "as1", copies: 4 }];
    const v = await createPlan({ ops }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    let copies = 0;
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/copies") && ++copies === 3, kind: "error", error: { message: "Temporary problem", code: 2 } });
    await run(v.key);
    const made = progress(v.key)[0].ids.filter(Boolean);
    expect(made).toHaveLength(2);
    await updatePlan(v.key);
    const before = mock.calls.length;
    await confirmAndRun(v.key);
    const rewrites = mock.calls.slice(before).filter((c) => c.method === "POST" && made.includes(c.path));
    expect(rewrites).toHaveLength(0);
  });
});

describe("critique: Meta's pre-run check with audiences made in the plan (#6, second path)", () => {
  it("edit_adset with a '$ref' audience doesn't send '$aud' to validate_only either", async () => {
    const sent: string[] = [];
    const orig = mock.fetch;
    mock.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST" && typeof init?.body === "string") sent.push(decodeURIComponent(init.body.replace(/\+/g, " ")));
      return orig(input, init);
    }) as typeof fetch;
    await createPlan({ ops: [
      { type: "create_custom_audience", ref: "aud", name: "Visitors", source: { kind: "website", pixel_id: "px1", days: 30 } },
      { type: "edit_adset", adset: "as1", custom_audiences: ["$aud"] },
    ] }, WHO, "claude");
    expect(sent.filter((b) => b.includes("validate_only") && b.includes('"$aud"'))).toEqual([]);
  });
});

describe("critique: retry adopts the wrong object (#7, worse than reported)", () => {
  it("MISSED: copy_ad whose copy request got no answer does not adopt the SOURCE ad as its copy on retry", async () => {
    addAd("ad9", "as1");
    const v = await createPlan({ ops: [{ type: "copy_ad", ad: "ad9", adsets: ["as4"] }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/ads", kind: "network" }); // the new ad on the same creative (C1)
    expect(await run(v.key)).toEqual({ done: 0, failed: 1 });
    await updatePlan(v.key);
    await confirmAndRun(v.key);
    expect(progress(v.key)[0].ids).not.toContain("ad9");
    expect(mock.of("ad").filter((a) => a.adset_id === "as4")).toHaveLength(1);
  });

  it("MISSED: duplicate_adset whose copy got no answer does not adopt an older copy (same default name) from an earlier plan", async () => {
    const first = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as1", copies: 1 }] }, WHO, "claude");
    await confirmAndRun(first.key);
    const old = progress(first.key)[0].ids[0];
    const v = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as1", copies: 1, changes: [{ daily_budget: 900 }] }] }, WHO, "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    mock.inject({ match: (m, p) => m === "POST" && p === "as1/copies", kind: "network" });
    await run(v.key);
    await updatePlan(v.key);
    await confirmAndRun(v.key);
    expect(progress(v.key)[0].ids[0]).not.toBe(old);
    expect(Number(mock.objects.get(old)!.daily_budget)).toBe(50000); // the earlier plan's copy is untouched
  });
});
