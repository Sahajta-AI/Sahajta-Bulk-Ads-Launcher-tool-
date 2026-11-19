import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, openDb, setDb, type DB } from "@/lib/db";
import { MetaClient } from "@/lib/meta/client";
import { decrypt, encrypt, sha256, UNREADABLE_SECRET } from "@/lib/crypto";
import { MetaError, RateLimitedError, isThrottleBody, mustSurface, plainError } from "@/lib/meta/errors";
import { exchangeCode, listAssets, listInstagram, savePending } from "@/lib/meta/connect";
import { NotConnectedError, clientFor, loadPacer, pacerFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { Pacer, WINDOW_MS, WaitTooLong, parseUsage, realClock, type PacerState } from "@/lib/meta/pacer";
import { HttpError } from "@/lib/httperror";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Fixes of group META (18 Nov 2026 audit, items M1–M8). Each test failed before its fix.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
const THROTTLE = { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true };

const opened: DB[] = [];
beforeEach(() => {
  freshDb();
});
afterEach(() => {
  vi.useRealTimers();
  for (const d of opened.splice(0)) d.close();
});

/**
 * The web app and the worker: two connections to one database file, as in production (two
 * processes), so SQLite's locks are real. The app's db() is the web app's connection.
 */
function twoProcesses() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fix-meta-")), "launcher.db");
  const webDb = openDb(file);
  const workerDb = openDb(file);
  opened.push(webDb, workerDb);
  setDb(webDb);
  const id = upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
  const row = (): PacerState => {
    const r = workerDb.prepare("SELECT state FROM rate_state WHERE ad_account_id = ?").get(id) as { state: string } | undefined;
    return r ? (JSON.parse(r.state) as PacerState) : { log: [], capPoints: 60, blockedUntil: 0 };
  };
  return { file, webDb, workerDb, id, row };
}

/**
 * Another process (a thread with its own connection) holds the database for `ms`, like a long step
 * of the worker; it saves `state` as the rate_state row inside that transaction. Resolves once it
 * holds the lock; `done` resolves when it has committed.
 */
async function holdDb(file: string, ms: number, id: number, state?: PacerState) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const w = new Worker(
    `const { workerData: d } = require("node:worker_threads");
    const db = new (require("better-sqlite3"))(d.file);
    db.exec("BEGIN IMMEDIATE");
    if (d.state) db.prepare("INSERT INTO rate_state (ad_account_id, state, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(ad_account_id) DO UPDATE SET state = excluded.state").run(d.id, d.state);
    Atomics.store(d.flag, 0, 1);
    Atomics.wait(d.flag, 0, 1, d.ms);
    db.exec("COMMIT");
    db.close();`,
    { eval: true, workerData: { file, ms, id, state: state && JSON.stringify(state), flag } },
  );
  const done = new Promise<void>((resolve, reject) => {
    w.on("exit", () => resolve());
    w.on("error", reject);
  });
  while (Atomics.load(flag, 0) === 0) await new Promise((r) => setTimeout(r, 1));
  return { done };
}

const devTier = (p: Pacer) => p.observe({ tier: "development_access", bucMaxPct: 10 });

function answer(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fetch that answers from a list, then keeps answering the last one. */
function scripted(list: (() => Response)[]) {
  let n = 0;
  const f = (async () => list[Math.min(n++, list.length - 1)]()) as unknown as typeof fetch;
  return { f, calls: () => n };
}

describe("M1: one rate_state row shared by the web app and the worker (SQLite transactions)", () => {
  it("Guard 1 counts both processes' calls: together they stay under Meta's 60 points", async () => {
    const { webDb, workerDb, id, row } = twoProcesses();
    const worker = loadPacer(id, workerDb);
    const web = loadPacer(id, webDb);
    devTier(worker);
    let calls = 0;
    while (worker.waitFor(1).ms === 0 && calls < 200) {
      await worker.acquire(1);
      calls++;
    }
    while (web.waitFor(1, true).ms === 0 && calls < 200) {
      await web.acquire(1, undefined, { maxWaitMs: 0 });
      calls++;
    }
    expect(calls).toBeLessThanOrEqual(60);
    expect(calls).toBe(54); // 75% for the launch, up to 90% with the page's calls
    expect(row().log.length).toBe(54);
  });

  it("a block the worker saved survives the web app's answer to a call that was already on its way", () => {
    const { webDb, workerDb, id } = twoProcesses();
    const web = loadPacer(id, webDb);
    const worker = loadPacer(id, workerDb);
    expect(web.waitFor(1, true).ms).toBe(0);
    worker.throttled({});
    web.observe({ bucMaxPct: 40 });
    expect(web.waitFor(1, true).ms).toBeGreaterThan(0);
    expect(loadPacer(id, workerDb).waitFor(1).ms).toBeGreaterThan(0); // a restarted process sees it too
  });

  it("database busy: the web app's step writes nothing, so the block the worker saved meanwhile stays", async () => {
    const { file, webDb, workerDb, id, row } = twoProcesses();
    webDb.pragma("busy_timeout = 300");
    const web = loadPacer(id, webDb);
    expect(web.waitFor(1, true).ms).toBe(0);
    // The worker is refused by Meta and saves a 5-minute block in a step that holds the database
    // for 450 ms; the web app gives up waiting for it after 300 ms.
    const blocked: PacerState = { log: [], capPoints: 60, tier: "development_access", blockedUntil: Date.now() + WINDOW_MS, strikes: 1, lastRefusalAt: Date.now() };
    const worker = await holdDb(file, 450, id, blocked);
    web.observe({ bucMaxPct: 10 }); // the web app's answer to an earlier call arrives
    await worker.done;
    expect(row().blockedUntil).toBe(blocked.blockedUntil);
    expect(web.waitFor(1, true).ms).toBeGreaterThan(250_000); // and both processes honour it
    expect(loadPacer(id, workerDb).waitFor(1).ms).toBeGreaterThan(250_000);
  });

  it("database busy: a block Meta gave the web app is saved by its next step, and the worker honours it", async () => {
    const { file, webDb, workerDb, id, row } = twoProcesses();
    webDb.pragma("busy_timeout = 50");
    const web = loadPacer(id, webDb);
    const calls = row().log.length;
    const worker = await holdDb(file, 400, id); // a long worker step
    await web.acquire(1, undefined, { maxWaitMs: 0 }); // a page's call goes out while the database is busy…
    web.throttled({}); // …and Meta refuses it
    expect(web.waitFor(1, true).ms).toBeGreaterThan(250_000); // the web app keeps to the block meanwhile
    await worker.done;
    web.observe({ bucMaxPct: 5 }); // the next step gets the database
    expect(row().blockedUntil).toBeGreaterThan(Date.now() + 250_000);
    expect(row().log.length).toBe(calls + 1); // the call sent while busy is counted too
    expect(loadPacer(id, workerDb).waitFor(1).ms).toBeGreaterThan(250_000);
  });

  it("every step runs inside the transaction it is given", async () => {
    let row: PacerState | undefined;
    let steps = 0;
    const atomic = <T,>(fn: () => T): T => {
      steps++;
      return fn();
    };
    const p = new Pacer(new FakeClock(), undefined, (s) => (row = structuredClone(s)), undefined, () => row, atomic);
    await p.acquire(1);
    p.observe({ bucMaxPct: 5 });
    p.throttled({});
    expect(steps).toBeGreaterThanOrEqual(3);
    expect(row!.log.length).toBe(1);
  });

  it("an answer to a call sent before the last refusal does not reset the refusals in a row", () => {
    const clock = new FakeClock();
    const p = new Pacer(clock);
    devTier(p);
    p.throttled({}); // 1st: 5 min
    clock.t = p.state.blockedUntil + 1;
    const sentBefore = clock.now() - 1000;
    p.throttled({}); // 2nd: 10 min
    p.succeeded(sentBefore); // that call left before Meta refused: it proves nothing
    clock.t = p.state.blockedUntil + 1;
    p.throttled({});
    expect(p.state.blockedUntil - clock.now()).toBe(4 * WINDOW_MS);
  });

  it("a saved state from before the fix (5 strikes, no refusal time) starts again at 5 minutes", () => {
    const clock = new FakeClock();
    const p = new Pacer(clock, { capPoints: 60, tier: "development_access", strikes: 5 });
    p.throttled({});
    expect(p.state.blockedUntil - clock.now()).toBe(WINDOW_MS); // not an hour
  });

  it("a refusal that comes with a 5-second reset still blocks for Meta's documented time (no refusal every 5 s)", () => {
    const clock = new FakeClock();
    const p = new Pacer(clock, { capPoints: 9000 });
    p.throttled({ accUtilPct: 2, accResetSec: 5 });
    expect(p.state.blockedUntil - clock.now()).toBe(60_000); // full access: 60 s, not 5 s
    clock.t = p.state.blockedUntil + 1;
    p.throttled({ accUtilPct: 2, accResetSec: 5 });
    expect(p.state.blockedUntil - clock.now()).toBe(120_000);
  });

  it("the tier sets the cap when Meta sends no X-Ad-Account-Usage", () => {
    const p = new Pacer(new FakeClock());
    p.observe({ tier: "standard_access", bucMaxPct: 1 });
    expect(p.capPoints).toBe(9000);
    p.observe({ tier: "development_access", bucMaxPct: 1 });
    expect(p.capPoints).toBe(60);
  });

  it("background work keeps to 75% of the 5-minute cap; a page may use up to 90%", async () => {
    const p = new Pacer(new FakeClock(), { capPoints: 60 });
    for (let i = 0; i < 45; i++) await p.acquire(1);
    expect(p.waitFor(1, false).ms).toBeGreaterThan(0);
    expect(p.waitFor(1, true).ms).toBe(0);
    for (let i = 0; i < 9; i++) await p.acquire(1, undefined, { maxWaitMs: 0 });
    expect(p.waitFor(1, true).ms).toBeGreaterThan(0);
    expect(p.pointsPerSecond).toBeCloseTo((60 * 0.75) / 300); // launch time estimates unchanged
  });

  it("Guard 3 reads only the ads_management entry of X-Business-Use-Case-Usage", () => {
    const h = new Headers({
      "x-business-use-case-usage": JSON.stringify({
        "9001": [
          { type: "ads_insights", call_count: 95, total_cputime: 10, total_time: 10, estimated_time_to_regain_access: 30, ads_api_access_tier: "development_access" },
          { type: "ads_management", call_count: 12, total_cputime: 3, total_time: 4, estimated_time_to_regain_access: 0, ads_api_access_tier: "development_access" },
        ],
      }),
    });
    const u = parseUsage(h);
    expect(u).toMatchObject({ bucMaxPct: 12, tier: "development_access" });
    expect(u.bucRegainMin).toBeUndefined();
  });
});

describe("M2: limits with a throttle code that are not a short pause of the ad account", () => {
  const cases = [
    { code: 613, error_subcode: 1487225, message: "Ad creation limit reached for this ad account's daily spend limit", says: /ads this ad account may create/ },
    { code: 613, error_subcode: 1487632, message: "Too many budget changes", says: /4 budget changes per hour/ },
    { code: 17, error_subcode: 1885172, message: "Spend limit changes exceeded", says: /10 changes to the account spending limit/ },
  ];
  for (const c of cases) {
    it(`${c.code}/${c.error_subcode} fails the call at once with Meta's words, without blocking the ad account`, async () => {
      const clock = new FakeClock();
      const pacer = new Pacer(clock);
      const { f, calls } = scripted([() => answer({ error: { message: c.message, code: c.code, error_subcode: c.error_subcode } }, 400)]);
      const worker = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: f, clock, pacer });
      const e = await worker.post("act_1/ads", { name: "x" }).catch((x: unknown) => x);
      expect(calls()).toBe(1);
      expect(e).toBeInstanceOf(MetaError);
      expect(e).not.toBeInstanceOf(RateLimitedError);
      expect(mustSurface(e)).toBe(false);
      expect((e as MetaError).isTransient).toBe(false);
      expect(pacer.state.blockedUntil).toBe(0);
      const msg = plainError(e, "Creating ad 1");
      expect(msg).toMatch(c.says);
      expect(msg).toContain(c.message);
      expect(msg).not.toMatch(/is waiting/);
    });
  }

  it("613/4841018 (one change per item every 30 s): the worker waits 30 s and repeats only that call; a page gets a plain error", async () => {
    const edit = () => answer({ error: { message: "Too many changes to this object", code: 613, error_subcode: 4841018 } }, 400);
    const clock = new FakeClock();
    const pacer = new Pacer(clock);
    const a = scripted([edit, () => answer({ success: true })]);
    const worker = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: a.f, clock, pacer });
    expect(await worker.post("as1", { daily_budget: 5000 })).toEqual({ success: true });
    expect(a.calls()).toBe(2);
    expect(clock.slept).toBeGreaterThanOrEqual(30_000);
    expect(clock.slept).toBeLessThan(60_000);
    expect(pacer.state.blockedUntil).toBe(0); // the ad account is not blocked

    const b = scripted([edit]);
    const page = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: b.f, clock, pacer: new Pacer(clock), maxWaitMs: 15_000 });
    const e = await page.post("as1", { daily_budget: 5000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MetaError);
    expect(e).not.toBeInstanceOf(RateLimitedError);
    expect(plainError(e, "Changing the budget")).toMatch(/one change to the same item every 30 seconds/);
  });

  it("80001, 80002 and 80005 are rate limits too", () => {
    for (const code of [80001, 80002, 80005]) expect(isThrottleBody({ code, message: "too many calls" })).toBe(true);
  });
});

describe("M3: Connect Meta answers in seconds and never guesses 'not allowed'", () => {
  it("calls about a known ad account use its shared pacing: a block the worker saved is respected without calling Meta", async () => {
    const m = new MockMeta({ clock: new FakeClock(), capPoints: 9000 });
    g.__mockMeta = m;
    const id = upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
    loadPacer(id).throttled({}); // the worker was refused a moment ago
    savePending("marketer@example.com", await exchangeCode("practice"));
    const before = m.calls.filter((c) => c.path.endsWith("/instagram_accounts")).length;
    const e = await listInstagram("marketer@example.com", "act_1001").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RateLimitedError);
    expect(m.calls.filter((c) => c.path.endsWith("/instagram_accounts")).length).toBe(before);
    expect(pacerFor(id).state.blockedUntil).toBeGreaterThan(Date.now());
  });

  it("a rate limit on the Page list is shown, not hidden by the fallbacks for missing permissions", async () => {
    const m = new MockMeta({ clock: new FakeClock(), capPoints: 9000 });
    g.__mockMeta = m;
    savePending("marketer@example.com", await exchangeCode("practice"));
    m.inject({ match: (method, p) => method === "GET" && p === "me/accounts", kind: "error", error: THROTTLE });
    await expect(listAssets("marketer@example.com")).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("an Instagram list Meta did not give is an error that says so (not every account 'not allowed')", async () => {
    const m = new MockMeta({ clock: new FakeClock(), capPoints: 9000 });
    g.__mockMeta = m;
    savePending("marketer@example.com", await exchangeCode("practice"));
    const err = { message: "An unexpected error has occurred. Please retry your request later.", type: "OAuthException", code: 2, is_transient: true };
    for (let i = 0; i < 2; i++) m.inject({ match: (method, p) => method === "GET" && p.endsWith("/instagram_accounts"), kind: "error", error: err });
    const e = await listInstagram("marketer@example.com", "act_1001").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as Error).message).toMatch(/Couldn't read from Meta which Instagram accounts/);
    expect((e as Error).message).toContain("An unexpected error has occurred");
  });
});

describe("M4: 'Please reduce the amount of data'", () => {
  const tooBig = () => answer({ error: { message: "Please reduce the amount of data you're asking for, then retry your request", type: "OAuthException", code: 1 } }, 500);

  it("getAll asks for the same page again with half the rows, down to 5", async () => {
    const limits: number[] = [];
    const f = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const limit = Number(url.searchParams.get("limit"));
      limits.push(limit);
      if (limit > 25) return tooBig();
      const after = url.searchParams.get("after");
      return after
        ? answer({ data: [{ id: "3" }], paging: { cursors: {} } })
        : answer({ data: [{ id: "1" }, { id: "2" }], paging: { cursors: { after: "x" }, next: "https://graph.facebook.com/next" } });
    }) as unknown as typeof fetch;
    const clock = new FakeClock();
    const c = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: f, clock, pacer: new Pacer(clock, { capPoints: 9000 }), maxWaitMs: 15_000 });
    const rows = await c.getAll<{ id: string }>("act_1/insights", { level: "ad" });
    expect(rows.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(limits).toEqual([100, 50, 25, 25]);

    const always = scripted([tooBig]);
    const d = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: always.f, clock, pacer: new Pacer(clock, { capPoints: 9000 }), maxWaitMs: 15_000 });
    const e = await d.getAll("act_1/insights", { limit: 20 }).catch((x: unknown) => x);
    expect(always.calls()).toBe(3); // 20, 10, 5
    expect(plainError(e, "Reading results")).toMatch(/too much data at once; pick fewer days, fewer breakdowns or a higher level/);

    const once = scripted([tooBig]);
    const r = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: once.f, clock, pacer: new Pacer(clock, { capPoints: 9000 }), maxWaitMs: 15_000 });
    await r.getAll("act_1/insights", { limit: 500 }, 2000, { shrinkPages: false }).catch(() => null);
    expect(once.calls()).toBe(1); // a caller that would rather ask for fewer days asks only once
  });

  it("'nothing is created twice' is said only for writes", async () => {
    const clock = new FakeClock();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const c = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: down, clock, pacer: new Pacer(clock, { capPoints: 9000 }) });
    const read = await c.get("act_1/campaigns").catch((x: unknown) => x);
    const write = await c.post("act_1/campaigns", { name: "x" }).catch((x: unknown) => x);
    expect((read as MetaError).unknownOutcome).toBe(false);
    expect((read as MetaError).isTransient).toBe(true); // still worth trying again
    expect(plainError(read, "Reading campaigns")).not.toMatch(/created twice/);
    expect(plainError(read, "Reading campaigns")).toMatch(/did not get an answer from Meta/);
    expect(plainError(write, "Creating the campaign")).toMatch(/nothing is created twice/);
  });
});

describe("M5: a page or a Claude tool gets its answer within about 25 seconds", () => {
  it("one call's waits end at the deadline, even when other requests take each point that frees up", async () => {
    const clock = new FakeClock();
    const pacer = new Pacer(clock, { capPoints: 60 });
    // The page share (90% of 60 = 54 points) is used; one point frees up every 5 seconds.
    for (let i = 1; i <= 54; i++) pacer.state.log.push([clock.t - WINDOW_MS + 5_000 * i, 1]);
    // While our call waits, another request of the web app takes each point that frees up.
    let sleeps = 0;
    let taken = 0;
    const sleep = clock.sleep.bind(clock);
    clock.sleep = async (ms: number) => {
      sleeps++;
      await sleep(ms);
      if (taken < 40) await pacer.acquire(1, undefined, { maxWaitMs: 0 }).then(() => taken++, () => undefined);
    };
    const deadline = clock.now() + 25_000;
    await expect(pacer.acquire(1, undefined, { deadline })).rejects.toBeInstanceOf(WaitTooLong);
    expect(sleeps).toBe(4); // acquire's loop ran: four waits of 5 s, then the fifth would pass the deadline
    expect(taken).toBe(4);
    expect(clock.now()).toBeLessThanOrEqual(deadline);
  });

  it("every Meta client made while answering one web request shares one 25 s deadline (route())", async () => {
    const saved = process.env.ALLOWED_EMAILS;
    process.env.ALLOWED_EMAILS = "meta@example.com";
    const KEY = "sal_fix_meta_key";
    db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, 'test', ?, 'test')").run("meta@example.com", sha256(KEY));
    const id = upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
    g.__mockMeta = new MockMeta({ clock: realClock, capPoints: 9000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const { route } = await import("@/lib/http");
      // Before each read Meta asks us to wait 10 s (a short block in the shared row).
      const pause = () =>
        db()
          .prepare("INSERT INTO rate_state (ad_account_id, state, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(ad_account_id) DO UPDATE SET state = excluded.state")
          .run(id, JSON.stringify({ log: [], capPoints: 9000, blockedUntil: Date.now() + 10_000 }));
      // A page that makes n reads, each with its own client (like an ad set's details).
      let stoppedAt = 0;
      const page = (n: number) =>
        route(async () => {
          const start = Date.now();
          const done: number[] = [];
          for (let i = 0; i < n; i++) {
            pause();
            await clientFor(id)
              .get("act_1001", { fields: "name" })
              .catch((e: unknown) => {
                stoppedAt = (Date.now() - start) / 1000;
                throw e;
              });
            done.push((Date.now() - start) / 1000);
          }
          return { done };
        });
      const ask = async (n: number) => {
        const res = page(n)(new Request("http://app/x", { headers: { Authorization: `Bearer ${KEY}` } }), {});
        await vi.advanceTimersByTimeAsync(60_000);
        const r = await res;
        return { status: r.status, body: (await r.json()) as unknown };
      };
      const three = await ask(3);
      expect(three.status).toBe(429); // the third read would only start at 30 s
      expect(stoppedAt).toBe(20); // the person is told at once, not after more waiting
      expect(await ask(1)).toEqual({ status: 200, body: { done: [10] } }); // the next request has its own 25 s
    } finally {
      if (saved === undefined) delete process.env.ALLOWED_EMAILS;
      else process.env.ALLOWED_EMAILS = saved;
    }
  });

  it("no read is tried again when the retry would pass the deadline", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const slow = (async () => {
      calls++;
      clock.t += 20_000; // Meta took 20 s, then the connection dropped
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const c = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: slow, clock, pacer: new Pacer(clock, { capPoints: 9000 }), maxWaitMs: 15_000 });
    await expect(c.get("act_1/campaigns")).rejects.toBeInstanceOf(MetaError);
    expect(calls).toBe(2); // the 3rd try would start at 46 s
  });
});

describe("M6: what a route answers for each kind of error", () => {
  it("bugs are 500 (logged), Meta errors 502 in plain words, limits 429, not connected 409, plain messages 400", async () => {
    const { errorResponse, SERVER_FAULT } = await import("@/lib/http");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(errorResponse(new TypeError("Cannot read properties of undefined (reading 'id')"))).toEqual({ status: 500, message: SERVER_FAULT });
    expect(errorResponse(new RangeError("Invalid time value")).status).toBe(500);
    expect(errorResponse(new NotConnectedError("Meta is not connected yet."))).toEqual({ status: 409, message: "Meta is not connected yet." });
    expect(errorResponse(new RateLimitedError(Date.now() + 300_000)).status).toBe(429);
    const meta = errorResponse(new MetaError("Invalid parameter", { status: 400, body: { code: 100, message: "Invalid parameter", error_user_msg: "The budget is too low." } }));
    expect(meta.status).toBe(502);
    expect(meta.message).toMatch(/Meta said: "The budget is too low."/);
    expect(errorResponse(new Error("Pick an ad set first."))).toEqual({ status: 400, message: "Pick an ad set first." });
    expect(errorResponse(new HttpError(404, "No such batch."))).toEqual({ status: 404, message: "No such batch." });
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });
});

describe("M7: a token saved with another encryption key", () => {
  it("says to connect again, not a crypto error", () => {
    const keep = process.env.APP_ENCRYPTION_KEY;
    try {
      process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
      const saved = encrypt("EAAB-token");
      process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
      expect(() => decrypt(saved)).toThrow(UNREADABLE_SECRET);
      expect(() => decrypt("garbage")).toThrow(UNREADABLE_SECRET);
    } finally {
      process.env.APP_ENCRYPTION_KEY = keep;
    }
  });
});

describe("M8: the fake Meta behaves like production", () => {
  const client = (m: MockMeta, clock: FakeClock, extra: Partial<ConstructorParameters<typeof MetaClient>[0]> = {}) =>
    new MetaClient({ token: "t", accountId: m.accountId, version: "v26.0", fetch: m.fetch, clock, pacer: new Pacer(clock), ...extra });

  it("without X-Ad-Account-Usage (production) the starter tier comes from X-Business-Use-Case-Usage, and a long read job is never refused", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 60, accountUsageHeader: false });
    const res = await m.fetch(`https://graph.facebook.com/v26.0/${m.accountId}?fields=name`);
    expect(res.headers.get("x-ad-account-usage")).toBeNull();
    expect(parseUsage(res.headers).tier).toBe("development_access");
    const big = new MockMeta({ clock, capPoints: 9000, accountUsageHeader: false });
    expect(parseUsage((await big.fetch(`https://graph.facebook.com/v26.0/${big.accountId}`)).headers).tier).toBe("standard_access");

    const c = client(m, clock);
    for (let i = 0; i < 100; i++) await c.get(m.accountId, { fields: "name" });
    expect(m.throttled).toBe(0);
  });

  it("hourlyCalls: call_count is the real share of the hour, and calls past it are refused", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 9000, hourlyCalls: 10 });
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) last = await m.fetch(`https://graph.facebook.com/v26.0/${m.accountId}`);
    expect(parseUsage(last!.headers).bucMaxPct).toBe(50);
    for (let i = 0; i < 5; i++) await m.fetch(`https://graph.facebook.com/v26.0/${m.accountId}`);
    const refused = await m.fetch(`https://graph.facebook.com/v26.0/${m.accountId}`);
    expect(((await refused.json()) as { error: { code: number } }).error.code).toBe(80004);
    expect(parseUsage(refused.headers).bucRegainMin).toBeGreaterThan(0);
  });

  it("inject() can answer with HTTP 500, like Meta's code 1", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 9000 });
    m.inject({ match: () => true, kind: "error", status: 500, error: { message: "Please reduce the amount of data you're asking for", code: 1 } });
    expect((await m.fetch(`https://graph.facebook.com/v26.0/${m.accountId}/ads`)).status).toBe(500);
  });

  it("filtering with IN on id, adset.id and campaign.id", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 9000, richAccount: true });
    for (const [id, adset] of [["ad1", "as1"], ["ad2", "as1"], ["ad3", "as3"]]) m.objects.set(id, { _type: "ad", id, name: id, adset_id: adset, status: "PAUSED" });
    const c = client(m, clock);
    const ids = async (edge: string, field: string, value: string[]) =>
      (await c.getAll<{ id: string }>(`${m.accountId}/${edge}`, { fields: "id", filtering: [{ field, operator: "IN", value }] })).map((r) => r.id).sort();
    expect(await ids("ads", "id", ["ad2", "no-such"])).toEqual(["ad2"]);
    expect(await ids("ads", "adset.id", ["as1"])).toEqual(["ad1", "ad2"]);
    expect(await ids("ads", "campaign.id", ["c2"])).toEqual(["ad3"]);
    expect(await ids("adsets", "campaign.id", ["c2"])).toEqual(["as3"]);
    expect(await ids("adsets", "id", ["no-such-id"])).toEqual([]);
  });

  it("metadata=1 says what kind of object an ID is", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 9000, richAccount: true });
    m.objects.set("ad1", { _type: "ad", id: "ad1", name: "ad1", adset_id: "as1", status: "PAUSED" });
    const c = client(m, clock);
    const type = async (id: string) => (await c.get<{ metadata?: { type: string } }>(id, { fields: "id", metadata: 1 })).metadata?.type;
    expect([await type("c1"), await type("as1"), await type("ad1")]).toEqual(["campaign", "adset", "adgroup"]);
  });

  it("lists come in pages: `limit` is honoured, with paging.next while more rows exist", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 9000, richAccount: true });
    for (let i = 0; i < 30; i++) m.objects.set(`ad${i}`, { _type: "ad", id: `ad${i}`, name: `ad${i}`, adset_id: "as1", status: "PAUSED" });
    const c = client(m, clock);
    const first = await c.get<{ data: unknown[]; paging: { next?: string; cursors: { after?: string } } }>(`${m.accountId}/ads`, { fields: "id", limit: 4 });
    expect(first.data).toHaveLength(4);
    expect(first.paging.next).toBeTruthy();
    expect(first.paging.cursors.after).toBeTruthy();
    expect((await c.get<{ data: unknown[] }>("as1/ads", { fields: "id" })).data).toHaveLength(25); // Meta's default page
    const before = m.calls.length;
    expect(await c.getAll(`${m.accountId}/ads`, { fields: "id", limit: 7 })).toHaveLength(30);
    expect(m.calls.length - before).toBe(5);
  });

  it("leadFormRule: an ad in an Instant form ad set (ON_AD) needs a lead form on its button", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 9000, richAccount: true, leadFormRule: true });
    const c = client(m, clock);
    const creative = async (cta: Record<string, unknown>) =>
      (await c.post<{ id: string }>(`${m.accountId}/adcreatives`, { name: "x [L:abc12-01]", object_story_spec: { page_id: "p1", link_data: { link: "https://example.com", message: "Hi", call_to_action: cta } } })).id;
    const plain = await creative({ type: "LEARN_MORE", value: { link: "https://example.com" } });
    const withForm = await creative({ type: "SIGN_UP", value: { link: "https://example.com", lead_gen_form_id: "123" } });
    const e = await c.post(`${m.accountId}/ads`, { name: "a [L:abc12-01]", adset_id: "as1", creative: { creative_id: plain }, status: "PAUSED" }).catch((x: unknown) => x);
    expect(plainError(e, "Creating the ad")).toMatch(/instant form/i);
    expect((await c.post<{ id: string }>(`${m.accountId}/ads`, { name: "b [L:abc12-02]", adset_id: "as1", creative: { creative_id: withForm }, status: "PAUSED" })).id).toBeTruthy();
  });
});
