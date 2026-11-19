import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { MetaClient } from "@/lib/meta/client";
import { RateLimitedError, plainError } from "@/lib/meta/errors";
import { exchangeCode, listInstagram, savePending } from "@/lib/meta/connect";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { Pacer, WINDOW_MS, realClock, type PacerState } from "@/lib/meta/pacer";
import { deliveryStatus } from "@/lib/manage/delivery";
import { listIdentities } from "@/lib/service";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Audit of the Meta client, pacer and Connect Meta (18 Nov 2026). Each failing test names the
// behaviour the marketer needs on Meta's starter access level. Own file: rate blocks stay here.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
const THROTTLE = { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true };

/** The rate_state row both processes read and write (last writer wins, like SQLite). */
function sharedRow() {
  let row: PacerState | undefined;
  return {
    save: (s: PacerState) => {
      row = JSON.parse(JSON.stringify(s)) as PacerState;
    },
    read: () => row,
  };
}

/** Real Meta on the starter level sends no X-Ad-Account-Usage header (18 Nov 2026); the fake always does. */
function starterTier(f: typeof fetch): typeof fetch {
  return async (input, init) => {
    const r = await f(input, init);
    const h = new Headers(r.headers);
    h.delete("x-ad-account-usage");
    return new Response(await r.text(), { status: r.status, headers: h });
  };
}

beforeEach(() => {
  freshDb();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("two processes (web app and worker) sharing rate_state", () => {
  it("a block the worker saved is not wiped when the web app saves Meta's numbers from a call that was already on its way", () => {
    const clock = new FakeClock();
    const row = sharedRow();
    const web = new Pacer(clock, undefined, row.save, undefined, row.read);
    const worker = new Pacer(clock, undefined, row.save, undefined, row.read);
    expect(web.waitFor(1, true).ms).toBe(0); // the web's call goes out…
    worker.throttled({}); // …meanwhile Meta refuses the worker: 300 s block saved
    web.observe({ bucMaxPct: 40 }); // the web's answer arrives and is saved
    // The web's next call (and any restarted process) must still see the block.
    expect(web.waitFor(1, true).ms).toBeGreaterThan(0);
    expect(new Pacer(clock, row.read()).waitFor(1).ms).toBeGreaterThan(0);
  });

  it("together they stay under Meta's 60 points per 5 minutes on the starter level (no refusal)", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 60 });
    const f = starterTier(m.fetch);
    const row = sharedRow();
    const worker = new MetaClient({ token: "t", accountId: m.accountId, version: "v26.0", fetch: f, clock, pacer: new Pacer(clock, undefined, row.save, undefined, row.read) });
    const web = new MetaClient({ token: "t", accountId: m.accountId, version: "v26.0", fetch: f, clock, maxWaitMs: 15_000, pacer: new Pacer(clock, undefined, row.save, undefined, row.read) });
    for (let i = 0; i < 45; i++) await worker.get(m.accountId, { fields: "name" }); // a launch uses its own 75%
    for (let i = 0; i < 16; i++) await web.get(m.accountId, { fields: "name" }).catch(() => null); // the Campaigns page
    expect(m.throttled).toBe(0);
  });

  it("a call that went through resets the refusals in a row for both processes (the next refusal blocks 5 minutes, not 40)", () => {
    const clock = new FakeClock();
    const row = sharedRow();
    const web = new Pacer(clock, undefined, row.save, undefined, row.read);
    const worker = new Pacer(clock, undefined, row.save, undefined, row.read);
    observeTier(web);
    // Three refusals in a row on pages (the 18 Nov incident).
    for (let i = 0; i < 3; i++) {
      web.throttled({});
      clock.t = web.state.blockedUntil + 1;
    }
    // The worker's next call goes through: Meta is no longer refusing.
    expect(worker.waitFor(1).ms).toBe(0);
    worker.succeeded();
    // Hours later Meta refuses a page call once.
    clock.t += 3 * 3_600_000;
    web.waitFor(1, true);
    web.throttled({});
    expect(web.state.blockedUntil - clock.now()).toBe(WINDOW_MS);
  });
});

function observeTier(p: Pacer) {
  p.observe({ tier: "development_access", bucMaxPct: 10 });
}

describe("reads that Meta refuses for size", () => {
  it("'Please reduce the amount of data' (HTTP 500, code 1) shows Meta's words, not 'connection problem… nothing is created twice'", async () => {
    let calls = 0;
    const f: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "Please reduce the amount of data you're asking for, then retry your request", type: "OAuthException", code: 1 } }), { status: 500, headers: { "content-type": "application/json" } });
    };
    const clock = new FakeClock();
    const c = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: f, clock, pacer: new Pacer(clock), maxWaitMs: 15_000 });
    const e = await c.get("act_1/adsets", { fields: "targeting", limit: 100 }).catch((x: unknown) => x);
    const msg = plainError(e, "Reading campaigns");
    // Corrected after the critique: the audit wrote toBe(3), which described today's bug (the same
    // too-big read repeated twice, 3 reads of the hourly 300). A clear "too much data" answer is
    // never repeated as it is: at most 1 call.
    expect(calls).toBeLessThanOrEqual(1);
    expect(msg).not.toMatch(/connection problem|created twice/);
    expect(msg).toMatch(/reduce the amount of data/);
  });
});

describe("pages that read Meta while it is limiting the ad account", () => {
  it("Delivery says Meta is limiting calls, instead of an empty table ('Meta has nothing to show yet')", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 60 });
    const pacer = new Pacer(clock);
    pacer.throttled({}); // Meta paused the account a moment ago
    const page = new MetaClient({ token: "t", accountId: m.accountId, version: "v26.0", fetch: m.fetch, clock, pacer, maxWaitMs: 15_000 });
    await expect(deliveryStatus(page, { adsets: ["as1"], ads: ["ad1"] })).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("Connect Meta (Settings, a web request) answers within seconds when Meta refuses the ad account's Instagram list, instead of waiting 5 minutes and retrying", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const m = new MockMeta({ clock: realClock, capPoints: 9000 });
    m.fetch = starterTier(m.fetch); // no X-Ad-Account-Usage, as on 18 Nov
    g.__mockMeta = m;
    savePending("marketer@example.com", await exchangeCode("practice"));
    m.inject({ match: (method, p) => method === "GET" && p.endsWith("/instagram_accounts"), kind: "error", error: THROTTLE });
    let settled = false;
    const p = listInstagram("marketer@example.com", "act_1001").then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const refusedThenWaiting = !settled;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await p;
    expect(refusedThenWaiting).toBe(false);
  });

  // Last in the file: it leaves a real-time block on ad account 1 in the factory's pacer.
  it("Settings' Page and Instagram lists don't show empty (cached 30 minutes) after a rate refusal", async () => {
    const m = new MockMeta({ clock: new FakeClock(), capPoints: 9000 });
    g.__mockMeta = m;
    upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
    db().prepare("UPDATE ad_accounts SET is_default = 1").run();
    m.inject({ match: (method, p) => method === "GET" && p.endsWith("/promote_pages"), kind: "error", error: THROTTLE });
    const first = await listIdentities().then(
      (r) => r,
      (e: unknown) => e,
    );
    expect(first).toBeInstanceOf(Error); // the person is told Meta is limiting calls
    // And nothing empty stays in the cache: a later look (after the block) asks Meta again.
    const cached = db().prepare("SELECT value FROM cache WHERE key LIKE 'ident:%'").get() as { value: string } | undefined;
    expect(cached).toBeUndefined();
  });
});
