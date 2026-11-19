import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, setDb, type DB } from "@/lib/db";
import { MetaClient } from "@/lib/meta/client";
import { exchangeCode, listInstagram, savePending } from "@/lib/meta/connect";
import { loadPacer } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { Pacer, WINDOW_MS } from "@/lib/meta/pacer";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Second look at the audit of the Meta client (tests/audit-client.test.ts). Each test states the
// behaviour we want; a failing test means the problem is real today.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };

beforeEach(() => {
  freshDb();
});

function devTier(p: Pacer) {
  p.observe({ tier: "development_access", bucMaxPct: 10 });
}

describe("refusals in a row (strikes)", () => {
  it("refusals of calls that were already on their way count as one refusal, not five", () => {
    // The Ads tab reads up to 50 ads at once; when Meta refuses, several answers come back refused together.
    const clock = new FakeClock();
    const p = new Pacer(clock);
    devTier(p);
    for (let i = 0; i < 5; i++) p.throttled({});
    clock.t = p.state.blockedUntil + 1;
    p.throttled({}); // the first refusal after that block: the second block in a row
    expect((p.state.blockedUntil - clock.now()) / 60_000).toBe((2 * WINDOW_MS) / 60_000); // 10 min, not 60
  });

  it("a refusal hours after the last one starts again at 5 minutes, even in one process", () => {
    const clock = new FakeClock();
    const p = new Pacer(clock);
    devTier(p);
    for (let i = 0; i < 3; i++) {
      p.throttled({});
      clock.t = p.state.blockedUntil + 1;
    }
    clock.t += 3 * 3_600_000; // nobody used the app for 3 hours
    p.throttled({});
    expect((p.state.blockedUntil - clock.now()) / 60_000).toBe(WINDOW_MS / 60_000); // 5 min, not 40
  });
});

describe("Meta errors with a throttle code that are not short rate limits", () => {
  it("613/1487225 (ad creation capped by the account's daily spend limit) fails the write at once instead of retrying for an hour and blocking the ad account", async () => {
    let calls = 0;
    const f: typeof fetch = async () => {
      calls++;
      const ok = calls >= 5;
      return new Response(JSON.stringify(ok ? { id: "1" } : { error: { message: "Ad creation limit reached for this ad account's daily spend limit", code: 613, error_subcode: 1487225 } }), {
        status: ok ? 200 : 400,
        headers: { "content-type": "application/json" },
      });
    };
    const clock = new FakeClock();
    const pacer = new Pacer(clock);
    devTier(pacer);
    const c = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: f, clock, pacer }); // the worker (no maxWaitMs)
    await c.post("act_1/ads", { name: "x" }).catch((e: unknown) => e);
    expect(calls, `retried ${calls - 1} times over ${Math.round(clock.slept / 60_000)} minutes, the whole ad account blocked meanwhile`).toBe(1);
  });
});

describe("Connect Meta", () => {
  it("an Instagram list Meta did not give is not shown as 'not allowed for this ad account'", async () => {
    const m = new MockMeta({ clock: new FakeClock(), capPoints: 9000 });
    g.__mockMeta = m;
    savePending("marketer@example.com", await exchangeCode("practice"));
    // Any error on the ad account's Instagram list (a RateLimitedError too, once Connect Meta gets maxWaitMs).
    const err = { message: "An unexpected error has occurred. Please retry your request later.", type: "OAuthException", code: 2, is_transient: true };
    for (let i = 0; i < 2; i++) m.inject({ match: (method, p) => method === "GET" && p.endsWith("/instagram_accounts"), kind: "error", error: err });
    const r = await listInstagram("marketer@example.com", "act_1001").catch((e: unknown) => e);
    // Today: [{ username: "sahajta.ai", allowed: false }] → selectAssets refuses with "not allowed to use @sahajta.ai yet".
    expect(r).toBeInstanceOf(Error);
  });
});

describe("tier upgrade without X-Ad-Account-Usage (risk: not seen on the real API yet)", () => {
  it("a pacer told 'standard_access' only through X-Business-Use-Case-Usage uses more than the starter 60 points", () => {
    const p = new Pacer(new FakeClock());
    p.observe({ tier: "standard_access", bucMaxPct: 1 });
    expect(p.capPoints).toBeGreaterThan(60);
  });
});

// The row is the only state: the web app and the worker each change it in one IMMEDIATE transaction
// per step (factory.ts loadPacer). Here they are two real connections to one database file, as in
// production, so every step goes through SQLite and its locks (audit findings 1, 3 and 4).
describe("two processes on one rate_state row (two SQLite connections)", () => {
  const opened: DB[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const d of opened.splice(0)) d.close();
  });
  function twoProcesses() {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "critique-client-")), "launcher.db");
    const webDb = openDb(file);
    const workerDb = openDb(file);
    opened.push(webDb, workerDb);
    setDb(webDb);
    const id = upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
    return { web: loadPacer(id, webDb), worker: loadPacer(id, workerDb) };
  }

  it("finding 3: a block saved by one process survives the other's late answer", () => {
    const { web, worker } = twoProcesses();
    expect(web.waitFor(1, true).ms).toBe(0); // web's call goes out
    worker.throttled({}); // worker refused
    web.observe({ bucMaxPct: 40 }); // web's answer arrives
    expect(web.waitFor(1, true).ms).toBeGreaterThan(0);
  });

  it("finding 4: a success in either process resets the strikes for both", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { web, worker } = twoProcesses();
    devTier(web);
    for (let i = 0; i < 3; i++) {
      web.throttled({});
      vi.setSystemTime(web.state.blockedUntil + 1);
    }
    expect(worker.waitFor(1).ms).toBe(0);
    worker.succeeded(); // the worker's call went through
    vi.setSystemTime(Date.now() + 3 * 3_600_000);
    web.throttled({});
    expect(web.state.blockedUntil - Date.now()).toBe(WINDOW_MS);
  });

  it("finding 1: Guard 1 counts both processes' calls", async () => {
    const { web, worker } = twoProcesses();
    devTier(worker);
    let calls = 0;
    while (worker.waitFor(1).ms === 0 && calls < 100) {
      await worker.acquire(1);
      calls++;
    }
    while (calls < 100) {
      const ok = await web.acquire(1, undefined, { maxWaitMs: 0 }).then(() => true, () => false);
      if (!ok) break;
      calls++;
    }
    expect(calls).toBeLessThanOrEqual(60);
  });
});
