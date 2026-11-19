import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { MetaClient } from "@/lib/meta/client";
import { RateLimitedError } from "@/lib/meta/errors";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { DEV_CAP, Pacer, WINDOW_MS } from "@/lib/meta/pacer";
import { campaignTree, confirmPlan, createPlan, planView } from "@/lib/manage/service";
import { getPlan, runPlan, setPlanWait } from "@/lib/manage/plan";
import { HttpError } from "@/lib/httperror";
import { fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Meta's hourly limit on the starter access level (18 Nov 2026, plan pxrjw): pages and Claude must
// get a plain answer instead of hanging, refused calls must not be retried every minute, and a long
// plan must say how far it is and what it waits for. Own file: a rate block must not leak into other tests.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
const THROTTLE = { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true };
let folder: string;
let mock: MockMeta;
beforeAll(async () => {
  folder = await fifteenFileFolder();
}, 120_000);
beforeEach(() => {
  freshDb();
  mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true, allowActive: true });
  g.__mockMeta = mock;
});

describe("the pacer on Meta's starter access level", () => {
  it("learns the tier, keeps to 60 points, and doubles the wait after each refusal in a row", () => {
    const clock = new FakeClock();
    const p = new Pacer(clock, { capPoints: 1440 });
    p.observe({ tier: "development_access", bucMaxPct: 10 });
    expect(p.capPoints).toBe(DEV_CAP);
    const t0 = clock.now();
    p.throttled({});
    expect(p.state.blockedUntil - t0).toBe(WINDOW_MS); // Meta's documented 300 s block
    clock.t = p.state.blockedUntil;
    p.throttled({});
    expect(p.state.blockedUntil - clock.now()).toBe(2 * WINDOW_MS);
    clock.t = p.state.blockedUntil;
    p.throttled({});
    expect(p.state.blockedUntil - clock.now()).toBe(4 * WINDOW_MS);
    p.succeeded();
    clock.t = p.state.blockedUntil;
    p.throttled({});
    expect(p.state.blockedUntil - clock.now()).toBe(WINDOW_MS); // back to the start after a call went through
  });

  it("background work leaves the hour's last quarter for pages and Claude", () => {
    const clock = new FakeClock();
    const p = new Pacer(clock, { capPoints: 9000 });
    p.observe({ bucMaxPct: 80 });
    expect(p.waitFor(1, false).ms).toBeGreaterThan(0);
    expect(p.waitFor(1, true).ms).toBe(0);
  });

  it("the web app sees a block the worker learned, and the other way round", () => {
    const clock = new FakeClock();
    const worker = new Pacer(clock, { capPoints: 9000 });
    const web = new Pacer(clock, { capPoints: 9000 }, undefined, undefined, () => worker.state);
    worker.throttled({ bucRegainMin: 40 });
    expect(web.waitFor(1, true).ms).toBe(40 * 60_000);
  });
});

describe("a page or a Claude tool while Meta is limiting the account", () => {
  it("gets the plain answer with the time at once, and the refused call is not repeated", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 60 }); // Meta's headers say "development_access"
    const pacer = new Pacer(clock, { capPoints: 60 });
    const page = new MetaClient({ token: "t", accountId: m.accountId, version: "v26.0", fetch: m.fetch, pacer, clock, maxWaitMs: 15_000 });
    m.inject({ match: (method) => method === "GET", kind: "error", error: THROTTLE });
    const calls = m.calls.length;
    const e = await page.get(m.accountId, { fields: "name" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RateLimitedError);
    expect((e as Error).message).toMatch(/Meta is limiting how often the launcher may call this ad account.*Try again after about \d{1,2}:\d\d [ap]m IST \(in 5 minutes\)/);
    expect((e as Error).message).toMatch(/starter access level/);
    expect(m.calls.length - calls).toBe(1);
    // A second page request during the block doesn't call Meta at all.
    await expect(page.get(m.accountId, { fields: "name" })).rejects.toBeInstanceOf(RateLimitedError);
    expect(m.calls.length - calls).toBe(1);
  });

  it("background work (a launch, a plan) waits for Meta and then carries on", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 9000 });
    const worker = new MetaClient({ token: "t", accountId: m.accountId, version: "v26.0", fetch: m.fetch, pacer: new Pacer(clock, { capPoints: 9000 }), clock });
    m.inject({ match: (method) => method === "GET", kind: "error", error: THROTTLE });
    const r = await worker.get<{ id: string }>(m.accountId, { fields: "name" });
    expect(r.id).toBeTruthy();
    expect(clock.slept).toBeGreaterThanOrEqual(60_000);
  });

  it("the Campaigns page answers 429 with the message (the old page kept 'Reading your campaigns…')", async () => {
    const { accountId } = await setupBatch(folder);
    db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
    mock.inject({ match: (method, p) => method === "GET" && p.includes("/campaigns"), kind: "error", error: THROTTLE });
    const e = await campaignTree(true).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(429);
    expect((e as Error).message).toMatch(/Try again after about/);
    // A plan check during a block says so, instead of skipping Meta's own check quietly.
    mock.inject({ match: (method, p) => method === "GET" && p.endsWith("as1"), kind: "error", error: THROTTLE });
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as1", daily_budget: 120 }] }, "test@example.com", "claude");
    expect(v.summary!.checks.map((c) => c.message).join(" ")).toMatch(/Meta is limiting how often/);
  });
});

describe("a long campaign copy (plan pxrjw)", () => {
  it("shows how many items are copied, shows Meta waits, and a cancel during the last copy lets it finish but keeps the plan cancelled", async () => {
    const { accountId } = await setupBatch(folder);
    db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
    for (const [i, a] of ["as1", "as4"].entries()) mock.objects.set(`ad${i}`, { _type: "ad", id: `ad${i}`, name: `Ad ${i}`, adset_id: a, status: "PAUSED", effective_status: "PAUSED" });
    const v = await createPlan({ ops: [{ type: "duplicate_campaign", campaign: "c1", with_contents: true }] }, "test@example.com", "claude");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, "test@example.com");
    const id = getPlan(v.key).id;
    const seen: string[] = [];
    let labels = "";
    const r = await runPlan(id, {
      client: clientFor(),
      clock: new FakeClock(),
      afterCreate: () => {
        seen.push(planView(v.key).progress[0].message);
        if (seen.length === 3) {
          setPlanWait(id, Date.now() + 120_000, "Close to Meta's hourly limit for this ad account");
          const w = planView(v.key).waiting;
          labels += `${w?.untilLabel ?? "none"}|${w?.reason ?? ""}`;
          setPlanWait(id, null);
          // Cancelled while the only copy is being made: that copy finishes, nothing after it runs, the plan stays cancelled.
          db().prepare("UPDATE plans SET status = 'cancelled' WHERE id = ?").run(id);
          labels += `|${planView(v.key).statusLabel}`;
        }
      },
    });
    expect(r).toEqual({ done: 1, failed: 0 }); // the one copy it was making finishes
    expect(seen).toContain('Copying "November tests": 1 of 6 items copied (campaign, ad sets and ads, one at a time).');
    expect(seen.some((s) => /: 2 of 6 items copied/.test(s))).toBe(true);
    expect(labels).toMatch(/^\d{1,2}:\d\d [ap]m\|Close to Meta's hourly limit for this ad account\|Stopping now: no more items or steps run/);
    expect(getPlan(v.key).status).toBe("cancelled");
    expect(planView(v.key).waiting).toBeNull();
  });
});
