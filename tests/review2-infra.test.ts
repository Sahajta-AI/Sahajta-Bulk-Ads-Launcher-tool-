import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Second independent review (19 Nov 2026) of the META and READS-INFRA fix groups.
// Probes run the real code: practice Meta (mock.ts), real SQLite files for two-process cases,
// a real worker process for the stop test. Never the real Meta API.
// A failing test = a bug found by this review; a passing one = a case checked and found fine.

const ctl = vi.hoisted(() => ({
  /** Make updateBatch throw SQLITE_BUSY once when it saves go_live_done (the database busy right after the plan was saved). */
  busyOnGoLiveDone: false,
}));

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/cleanup", async (orig) => {
  const real = await orig<typeof import("@/lib/cleanup")>();
  return { ...real, removeBatchFiles: () => 0 };
});
vi.mock("@/lib/sources/drive", async (orig) => ({
  ...(await orig<typeof import("@/lib/sources/drive")>()),
  authFor: () => ({ getAccessToken: async () => ({ token: "fake-gmail-token" }) }),
}));
vi.mock("@/lib/store", async (orig) => {
  const real = await orig<typeof import("@/lib/store")>();
  return {
    ...real,
    updateBatch: (id: number, patch: Record<string, unknown>) => {
      if (ctl.busyOnGoLiveDone && "go_live_done" in patch) {
        ctl.busyOnGoLiveDone = false;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return real.updateBatch(id, patch as never);
    },
  };
});

import { goLiveNote, recentAlerts } from "@/lib/alerts";
import { goLiveLine } from "@/app/batches/[key]/batch-logic";
import { sha256 } from "@/lib/crypto";
import { db, openDb, type DB } from "@/lib/db";
import { route } from "@/lib/http";
import { claimNext, enqueue, GO_LIVE_NOTE_MS, goLiveRetryKey, LANES, releaseJobs } from "@/lib/jobs";
import { NOT_FOUND, deliveryStatus } from "@/lib/manage/delivery";
import { runPlan } from "@/lib/manage/plan";
import { MetaClient } from "@/lib/meta/client";
import { OutOfTimeError, RateLimitedError } from "@/lib/meta/errors";
import { clientFor, sharedDeadline, withRequestDeadline, useBackgroundClients, defaultMaxWaitMs } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { Pacer, WINDOW_MS, realClock, type Clock, type PacerState } from "@/lib/meta/pacer";
import { cancelBatch, retryFailed } from "@/lib/service";
import { newBatch, upsertAccount } from "@/lib/setup";
import { cacheSet, getBatch, updateBatch } from "@/lib/store";
import { goLive, runClaimed } from "@/worker/run";
import { freshDb } from "./helpers";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.ALLOWED_EMAILS = "review2@example.com";
const API_KEY = "sal_review2_infra_key";
const WHO = "marketer@example.com";
const g = globalThis as unknown as { __mockMeta?: MockMeta };

let mock: MockMeta;
let accountId: number;
let gmail: string[] = [];

beforeEach(() => {
  process.env.META_MOCK = "1";
  freshDb();
  mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true, allowActive: true });
  g.__mockMeta = mock;
  accountId = upsertAccount({ metaAccountId: "act_1001", name: "Practice", token: "mock-token" });
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, 'test', ?, 'test')").run("review2@example.com", sha256(API_KEY));
  db().prepare("INSERT INTO users (email, google_scope) VALUES (?, ?)").run(WHO, "openid https://www.googleapis.com/auth/gmail.send");
  ctl.busyOnGoLiveDone = false;
  gmail = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).includes("gmail.googleapis.com")) {
      gmail.push(Buffer.from(JSON.parse(String(init.body)).raw as string, "base64url").toString("utf8"));
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------------------------------------
// Two processes on one database file (web app and worker), real SQLite locks.
// ---------------------------------------------------------------------------------------------

function twoProcesses() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review2-pacer-"));
  const file = path.join(dir, "launcher.db");
  const web = openDb(file);
  const worker = openDb(file);
  // The web gives up on the lock quickly (production waits 5 s; same code path, shorter test).
  web.pragma("busy_timeout = 30");
  return { web, worker };
}

const rowOf = (conn: DB, id = 1): PacerState | undefined => {
  const r = conn.prepare("SELECT state FROM rate_state WHERE ad_account_id = ?").get(id) as { state: string } | undefined;
  return r ? (JSON.parse(r.state) as PacerState) : undefined;
};
const putRow = (conn: DB, s: Partial<PacerState>, id = 1) =>
  conn.prepare("INSERT INTO rate_state (ad_account_id, state) VALUES (?, ?) ON CONFLICT(ad_account_id) DO UPDATE SET state = excluded.state").run(id, JSON.stringify(s));

/** Exactly what factory.ts loadPacer builds (read → change → write in one IMMEDIATE transaction), on a clock the test controls. */
function pacerOn(conn: DB, clock: Clock, id = 1): Pacer {
  const read = () => rowOf(conn, id);
  const save = (s: PacerState) => putRow(conn, s, id);
  return new Pacer(clock, read(), save, undefined, read, (fn) => conn.transaction(fn).immediate());
}

describe("pacer: the database busy (the other process holds it)", () => {
  it("a Meta block and a call the web saw while busy are saved later: the worker's longer block stays, every call is counted once", async () => {
    const { web, worker } = twoProcesses();
    const clock = new FakeClock();
    const t0 = clock.now();
    putRow(worker, { log: [], capPoints: 60, blockedUntil: 0, tier: "development_access" });
    const p = pacerOn(web, clock);

    worker.exec("BEGIN IMMEDIATE"); // the worker holds the database
    await p.acquire(1, undefined, { deadline: t0 + 25_000 }); // a page's read goes out (decided on the row as read)
    p.answered({ accUtilPct: 5 }, t0); // its answer
    p.throttled({}); // the next read is refused: 300 s block, strike 1
    expect(rowOf(worker)!.log, "nothing written while busy").toEqual([]);
    // Meanwhile the worker was refused too, with a later strike: a 20-minute block, and its own write call.
    worker.prepare("UPDATE rate_state SET state = ? WHERE ad_account_id = 1").run(JSON.stringify({ log: [[t0 - 1000, 3]], capPoints: 60, blockedUntil: t0 + 1_200_000, tier: "development_access", strikes: 3, lastRefusalAt: t0 - 500 }));
    worker.exec("COMMIT");

    clock.t += 1000;
    p.observe({ bucMaxPct: 10 }); // the next step gets the database: merges and saves
    p.observe({ bucMaxPct: 11 });
    const row = rowOf(worker)!;
    expect(row.blockedUntil, "the worker's 20-minute block is not shortened").toBe(t0 + 1_200_000);
    expect(row.log.map(([, pts]) => pts).sort(), "worker's write + the web's one read, each once").toEqual([1, 3]);
    expect(row.strikes, "strikes never go down by a merge").toBeGreaterThanOrEqual(3);

    // And the other way round: the web's block is the longer one.
    worker.exec("BEGIN IMMEDIATE");
    clock.t += 1_300_000;
    p.throttled({}); // refused again while busy (strike 4: 40 min)
    worker.prepare("UPDATE rate_state SET state = ? WHERE ad_account_id = 1").run(JSON.stringify({ ...rowOf(worker)!, blockedUntil: clock.now() + 60_000 }));
    worker.exec("COMMIT");
    p.observe({});
    expect(rowOf(worker)!.blockedUntil, "the web's own block is saved, not lost to the worker's shorter one").toBeGreaterThan(clock.now() + 60_000);
  });

  it("a success seen while the database was busy still counts: the next refusal blocks 5 minutes, not 10", async () => {
    const { web, worker } = twoProcesses();
    const clock = new FakeClock();
    const t0 = clock.now();
    // One refusal 6 minutes ago; its 5-minute block is over.
    putRow(worker, { log: [], capPoints: 60, blockedUntil: t0 - 60_000, tier: "development_access", strikes: 1, lastRefusalAt: t0 - 360_000 });
    const p = pacerOn(web, clock);
    // For comparison: the same story with the database free.
    const free = twoProcesses();
    putRow(free.worker, rowOf(worker)!);
    const q = pacerOn(free.web, clock);

    worker.exec("BEGIN IMMEDIATE");
    await p.acquire(1, undefined, { deadline: t0 + 25_000 });
    p.answered({}, clock.now()); // Meta answered: the refusals are over (strikes back to 0) — while the worker holds the database
    worker.exec("COMMIT");
    await q.acquire(1, undefined, { deadline: t0 + 25_000 });
    q.answered({}, clock.now());

    clock.t += 30_000;
    p.throttled({}); // a new refusal (database free now)
    q.throttled({});
    const blockBusy = rowOf(worker)!.blockedUntil - clock.now();
    const blockFree = rowOf(free.worker)!.blockedUntil - clock.now();
    expect(blockFree).toBe(WINDOW_MS);
    expect(blockBusy, `block after a success seen while busy: ${blockBusy / 1000} s`).toBe(WINDOW_MS);
  });
});

// ---------------------------------------------------------------------------------------------
// One deadline per web request (AsyncLocalStorage).
// ---------------------------------------------------------------------------------------------

describe("one deadline per web request", () => {
  it("clients of one request share one deadline; two requests at the same time each have their own; none outside a request", async () => {
    const one = withRequestDeadline(async () => {
      const a = clientFor(accountId);
      await a.get("c1", { fields: "id" }); // first Meta call: the request's 25 s start
      await new Promise((r) => setTimeout(r, 5));
      const b = clientFor(accountId);
      return { a: (a as unknown as { opts: { deadline: object } }).opts.deadline, b: (b as unknown as { opts: { deadline: object } }).opts.deadline, store: sharedDeadline() };
    });
    const two = withRequestDeadline(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return sharedDeadline();
    });
    const [r1, r2] = await Promise.all([one, two]);
    expect(r1.a).toBe(r1.b);
    expect(r1.a).toBe(r1.store);
    expect((r1.a as { at?: number }).at).toBeGreaterThan(Date.now());
    expect(r2).not.toBe(r1.store);
    expect((r2 as { at?: number }).at, "the other request's clock has not started").toBeUndefined();
    expect(sharedDeadline(), "no deadline outside a request").toBeUndefined();
  });

  it("route(): every client made while answering one request shares its deadline", async () => {
    const handler = route(async () => {
      const a = clientFor(accountId);
      const b = clientFor(accountId);
      return { same: (a as unknown as { opts: { deadline: object } }).opts.deadline === (b as unknown as { opts: { deadline: object } }).opts.deadline };
    });
    const res = await handler(new Request("http://x/api/test", { headers: { authorization: `Bearer ${API_KEY}` } }), {});
    expect(await res.json()).toEqual({ same: true });
  });

  it("the 25 s start at the request's first Meta call: a request that first spent 30 s on other work still waits 5 s for the pacer", async () => {
    const clock = new FakeClock();
    const pacer = new Pacer(clock, { capPoints: 60 });
    const shared = {}; // one request (factory.ts sharedDeadline)
    const c = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: (async () => answer({ id: "1" })) as unknown as typeof fetch, clock, pacer, maxWaitMs: 15_000, deadline: shared });
    clock.t += 30_000; // landing-page checks, file work…
    // The page share (54 of 60 points) is used; the oldest point ages out in 5 s.
    pacer.state.log = Array.from({ length: 54 }, (_, i) => [clock.now() - WINDOW_MS + 5_000 + i, 1] as [number, number]);
    const start = clock.now();
    await expect(c.get("1")).resolves.toEqual({ id: "1" });
    expect(clock.now() - start).toBeGreaterThanOrEqual(5_000);
    expect(clock.now() - start).toBeLessThan(6_000);
  });

  // Round 3 lead decision (item 1): Meta's own answer time is NOT cut at the request's deadline, and
  // getAll still reads the remaining pages: a slow but correct answer is better than an error, and a
  // cut call still counts against Meta's limit. Only the words change when the request's own time ran
  // out during a short wait. The two probes below assert that decided behaviour.
  it("a slow Meta read is not cut at the request's deadline: Meta's answer that comes after it is used", async () => {
    let aborted = false;
    const slow = ((_u: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(answer({ id: "1" })), 600); // Meta answers after 600 ms
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(t);
          reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        });
      })) as unknown as typeof fetch;
    // The request's deadline is 300 ms here (25 s in production).
    const c = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: slow, pacer: new Pacer(realClock, { capPoints: 9000 }), maxWaitMs: 15_000, deadlineMs: 300 });
    await expect(c.get("1")).resolves.toEqual({ id: "1" });
    expect(aborted).toBe(false);
  });

  it("past the request's deadline an interactive list read still reads every page (slow but complete)", async () => {
    const clock = new FakeClock();
    let pages = 0;
    const slow = (async (u: string) => {
      pages++;
      clock.t += 10_000; // each page takes Meta 10 s
      const after = Number(new URL(u).searchParams.get("after") ?? 0);
      const next = after + 1;
      return answer({ data: [{ id: String(after) }], paging: next < 6 ? { cursors: { after: String(next) }, next: `https://graph.facebook.com/v26.0/x?after=${next}` } : {} });
    }) as unknown as typeof fetch;
    const c = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: slow, clock, pacer: new Pacer(clock, { capPoints: 9000 }), maxWaitMs: 15_000 });
    const out = await c.getAll("act_1/ads", { fields: "id" }).then(
      (rows) => `${rows.length} rows`,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(out).toBe("6 rows");
    expect(pages).toBe(6);
  });

  it("a short pacing wait after the request's own 25 s ran out says the request took too long, not that Meta is limiting", async () => {
    const clock = new FakeClock();
    const pacer = new Pacer(clock, { capPoints: 60 });
    const c = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: (async () => answer({ id: "1" })) as unknown as typeof fetch, clock, pacer, maxWaitMs: 15_000 });
    await c.get("1"); // the request's first call: its 25 s start
    clock.t += 24_990;
    // The page share (54 of 60 points) is used; a point frees up in 2 s, after the deadline.
    pacer.state.log = Array.from({ length: 54 }, (_, i) => [clock.now() - WINDOW_MS + 2_000 + i, 1] as [number, number]);
    const short = await c.get("1").catch((e: unknown) => e);
    expect(short).toBeInstanceOf(OutOfTimeError);
    expect(short).toBeInstanceOf(RateLimitedError); // handled like a rate limit everywhere (shown, never swallowed)
    expect((short as Error).message).toMatch(/^This took too long/);
    expect((short as Error).message).not.toMatch(/Meta is limiting/);
    // A block from Meta longer than one call may wait is still "Meta is limiting…".
    const d = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: (async () => answer({ id: "1" })) as unknown as typeof fetch, clock, pacer: new Pacer(clock, { capPoints: 60, blockedUntil: clock.now() + 240_000 }), maxWaitMs: 15_000 });
    const long = await d.get("1").catch((e: unknown) => e);
    expect(long).not.toBeInstanceOf(OutOfTimeError);
    expect((long as Error).message).toMatch(/^Meta is limiting how often/);
  });
});

// ---------------------------------------------------------------------------------------------
// Go-live: the turn-on step alone, tried again by the worker.
// ---------------------------------------------------------------------------------------------

/** A launched "now" batch whose two ads are in Meta (practice account), its turn-on not done yet. */
function launchedBatch(status = "done"): { id: number; key: string } {
  const id = newBatch(accountId, WHO);
  const key = getBatch(id)!.key;
  for (const n of [1, 2]) {
    const adId = `90${n}`;
    db().prepare("INSERT INTO ads (batch_id, position, key, creative_name, status, meta_adset_id, meta_ad_id) VALUES (?, ?, ?, ?, 'done', 'as1', ?)").run(id, n, `${key}-0${n}`, `ad${n}`, adId);
    mock.objects.set(adId, { id: adId, name: `[L:${key}-0${n}] ad${n}`, adset_id: "as1", campaign_id: "c1", status: "PAUSED", effective_status: "PAUSED", _type: "ad" } as never);
  }
  updateBatch(id, { campaign_id: "c1", adset_id: "as1", adset_name: "November test ad set", go_live: "now", go_live_total: "₹500", status, launched_at: new Date().toISOString(), finished_at: new Date().toISOString() } as never);
  return { id, key };
}

/** The worker tried to turn the ads on `tries` times and failed; `nextAt` = when it tries again (null: gave up). */
function failedTries(batchId: number, tries: number, nextAt: number | null) {
  cacheSet(goLiveRetryKey(batchId), tries, GO_LIVE_NOTE_MS);
  cacheSet(`${goLiveRetryKey(batchId)}info`, { reason: "Meta had a temporary problem", nextAt }, GO_LIVE_NOTE_MS);
  if (nextAt) enqueue("golive", batchId, nextAt);
}

const turnOnPlans = (key: string) => db().prepare("SELECT key, status FROM plans WHERE title LIKE ? ORDER BY id").all(`Turn on batch ${key} (%`) as { key: string; status: string }[];
const queued = (kind: string, batchId: number) => db().prepare("SELECT id FROM jobs WHERE kind = ? AND batch_id = ? AND status = 'queued'").all(kind, batchId) as { id: number }[];

describe("go-live retries", () => {
  it("Stop pressed while the worker waits to try again: the note no longer says it tries again (Claude's batch_status shows this note first)", () => {
    const b = launchedBatch();
    failedTries(b.id, 1, Date.now() + 5 * 60_000);
    expect(goLiveNote(b.id)).toMatch(/Trying again at/);
    cancelBatch(b.key);
    const note = goLiveNote(b.id);
    expect(note ?? "", `goLiveNote after Stop: ${note}`).not.toMatch(/trying again/i);
  });

  it("a day after the worker gave up, the batch still says the ads were not turned on", async () => {
    const b = launchedBatch();
    // The worker's real last try (11 failed before): Meta refuses (the login expired) and it gives up.
    cacheSet(goLiveRetryKey(b.id), 11, GO_LIVE_NOTE_MS);
    mock.inject({ match: () => true, kind: "error", error: { message: "Invalid OAuth access token", code: 190 }, status: 400 });
    await goLive(b.id);
    expect(goLiveNote(b.id)).toMatch(/NOT turned on/);
    // 25 hours later, whatever the worker saved that would have expired by then is gone.
    // Round 3 (item 4): it is kept 14 days now (GO_LIVE_NOTE_MS). The probe used to expire every entry
    // whatever its time; it now expires only those a day would really remove.
    const lives = db().prepare("SELECT MIN(expires_at) FROM cache WHERE key LIKE 'golive_retry:%'").pluck().get() as number;
    expect(lives - Date.now(), "the go-live note is kept 14 days").toBeGreaterThan(13.9 * 86_400_000);
    db().prepare("UPDATE cache SET expires_at = ? WHERE key LIKE 'golive_retry:%' AND expires_at <= ?").run(Date.now() - 1, Date.now() + 25 * 3_600_000);
    const note = goLiveNote(b.id);
    const page = goLiveLine({ settings: { goLive: "now" } as never, goLivePlan: null, goLiveHold: null, goLiveNote: note });
    expect(note ?? `null; the batch page now says: "${page}"`).toMatch(/NOT turned on/);
  });

  it("a go-live try for a batch that was stopped meanwhile makes no plan, turns nothing on and stops trying", async () => {
    const b = launchedBatch();
    failedTries(b.id, 3, Date.now() - 1);
    cancelBatch(b.key);
    const job = claimNext(LANES.other)!;
    expect(job.kind).toBe("golive");
    await runClaimed(job);
    expect(turnOnPlans(b.key)).toEqual([]);
    expect(queued("golive", b.id)).toEqual([]);
    expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
    expect(goLiveNote(b.id)).toBeNull();
  });

  it("Retry pressed on the page while the worker's go-live try is reading Meta: one turn-on plan, not two", async () => {
    const b = launchedBatch();
    failedTries(b.id, 1, Date.now() - 1);
    // Hold the worker's first Meta read until the person has pressed Retry.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let hit!: () => void;
    const reached = new Promise<void>((r) => (hit = r));
    const real = mock.fetch;
    let first = true;
    mock.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (first) {
        first = false;
        hit();
        await gate;
      }
      return real(u, init);
    }) as typeof fetch;
    const job = claimNext(LANES.other)!;
    const running = runClaimed(job);
    await reached;
    const r = retryFailed(b.key); // web: every ad is in → only the turn-on step again
    expect(r.goLive).toBe(true);
    open();
    await running;
    const next = claimNext(LANES.other);
    expect(next?.kind).toBe("golive");
    await runClaimed(next!);
    expect(turnOnPlans(b.key)).toHaveLength(1);
    expect(turnOnPlans(b.key)[0].status).toBe("queued");
  });

  it("Stop pressed while the worker's go-live try is reading Meta: the plan stays a draft, nothing is queued to turn the ads on", async () => {
    const b = launchedBatch();
    failedTries(b.id, 2, Date.now() - 1);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let hit!: () => void;
    const reached = new Promise<void>((r) => (hit = r));
    const real = mock.fetch;
    let first = true;
    mock.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (first) {
        first = false;
        hit();
        await gate;
      }
      return real(u, init);
    }) as typeof fetch;
    const job = claimNext(LANES.other)!;
    const running = runClaimed(job);
    await reached;
    cancelBatch(b.key);
    open();
    await running;
    const plans = turnOnPlans(b.key);
    expect(plans.map((p) => p.status)).toEqual(["draft"]);
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan' AND status = 'queued'").pluck().get()).toBe(0);
    expect(queued("golive", b.id)).toEqual([]);
  });

  it("the database busy right after the turn-on plan was saved: the next try makes no second plan", async () => {
    const b = launchedBatch();
    ctl.busyOnGoLiveDone = true;
    await goLive(b.id); // plan saved, then "database is locked" when marking go_live_done → counted as a failed try
    await goLive(b.id); // the try 5 minutes later
    const plans = turnOnPlans(b.key);
    expect(plans.length, `turn-on plans: ${JSON.stringify(plans)}`).toBe(1);
  });

  it("a stop (deploy) during the first failure's email puts the try back without leaving two go-live jobs", async () => {
    const b = launchedBatch();
    // Meta refuses the first read (the login expired): the try fails, the next one is queued, then the email is sent.
    mock.inject({ match: () => true, kind: "error", error: { message: "Invalid OAuth access token", code: 190 }, status: 400 });
    let sendEmail!: () => void;
    const emailing = new Promise<void>((r) => (sendEmail = r));
    let emailStarted!: () => void;
    const started = new Promise<void>((r) => (emailStarted = r));
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("gmail.googleapis.com")) {
        emailStarted();
        await emailing;
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    enqueue("golive", b.id);
    const job = claimNext(LANES.other)!;
    const running = runClaimed(job);
    await started;
    expect(queued("golive", b.id), "the next try is already queued").toHaveLength(1);
    releaseJobs([job.id]); // SIGTERM: the running job goes back in the queue, then process.exit(0) (index.ts stop())
    const left = queued("golive", b.id); // what the next worker start finds
    sendEmail(); // (only to let this test end; the real process has exited here)
    await running;
    expect(left.length, `queued go-live jobs for the batch after the stop: ${left.length} (the released try runs again at once on restart, then the follow-up)`).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Alerts on the home page.
// ---------------------------------------------------------------------------------------------

describe("alerts", () => {
  it("'ads created but not turned on' (turn-on plan saved as a draft) leaves the home page once that plan has turned the ads on", async () => {
    const b = launchedBatch();
    // Stop, then Retry: the yes given at launch no longer holds, the turn-on plan is saved as a draft.
    updateBatch(b.id, { stopped_at: new Date(Date.now() - 60_000).toISOString() } as never);
    await goLive(b.id);
    const [plan] = turnOnPlans(b.key);
    expect(plan.status).toBe("draft");
    expect(recentAlerts().some((a) => /not turned on/.test(a.subject))).toBe(true);
    // The person checks the plan and confirms it; the worker runs it. (Round 3: through the worker's own
    // plan job, as in production: the worker clears the plan's alerts after runPlan, plan.ts is not ours.)
    db().prepare("UPDATE plans SET status = 'queued', confirmed_at = datetime('now'), confirmed_by = ? WHERE key = ?").run(WHO, plan.key);
    const id = db().prepare("SELECT id FROM plans WHERE key = ?").pluck().get(plan.key) as number;
    enqueue("plan", id);
    await runClaimed(claimNext(LANES.plan)!);
    expect(turnOnPlans(b.key)[0].status).toBe("done");
    expect(mock.of("ad").filter((a) => a.id === "901" || a.id === "902").every((a) => a.status === "ACTIVE")).toBe(true);
    const still = recentAlerts().filter((a) => /not turned on/.test(a.subject));
    expect(still.map((a) => a.subject), "home page after the ads are on").toEqual([]);
  });

  it("go-live failing 12 times: emailed on the first and the last try only; one home-page entry with the last words; then it stops", async () => {
    const b = launchedBatch();
    for (let i = 0; i < 12; i++) {
      // The worker takes the queued go-live job (as the lane would) and tries again.
      db().prepare("UPDATE jobs SET status = 'done' WHERE kind = 'golive' AND batch_id = ? AND status = 'queued'").run(b.id);
      mock.inject({ match: () => true, kind: "error", error: { message: "Invalid OAuth access token", code: 190 }, status: 400 });
      await goLive(b.id);
    }
    expect(gmail.length).toBe(2);
    const mine = recentAlerts(50).filter((a) => a.subject.includes(b.key));
    expect(mine).toHaveLength(1);
    expect(mine[0].count, "two alerts recorded (try 1 and try 12), one home-page entry").toBe(2);
    expect(mine[0].lines.join(" ")).toMatch(/tried 12 times/);
    expect(goLiveNote(b.id)).toMatch(/NOT turned on/);
    expect(queued("golive", b.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Delivery reads.
// ---------------------------------------------------------------------------------------------

describe("delivery", () => {
  it("230 ad IDs, 20 of them gone: 5 list reads of 50, 210 rows found and 20 'not found', nothing else", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 9000, richAccount: true });
    const ids: string[] = [];
    for (let i = 0; i < 230; i++) {
      const id = String(70_000 + i);
      ids.push(id);
      if (i % 23 !== 0 && i % 23 !== 5) m.objects.set(id, { id, name: `ad ${i}`, adset_id: "as1", campaign_id: "c1", status: "PAUSED", effective_status: "PAUSED", _type: "ad" } as never);
    }
    const c = new MetaClient({ token: "t", accountId: m.accountId, version: "v26.0", fetch: m.fetch, clock, pacer: new Pacer(clock, { capPoints: 9000 }), maxWaitMs: 15_000 });
    const before = m.calls.length;
    const rows = await deliveryStatus(c, { ads: ids });
    expect(m.calls.length - before).toBe(5);
    expect(rows.filter((r) => r.status === NOT_FOUND)).toHaveLength(20);
    expect(rows.filter((r) => r.status === "PAUSED")).toHaveLength(210);
    expect(rows).toHaveLength(230);
  });

  it("the filter refused, then one ID Meta says does not exist (subcode 33) and one it refuses for another reason: the second is an error, not 'not found'", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 9000, richAccount: true });
    m.objects.set("801", { id: "801", name: "a", adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", _type: "ad" } as never);
    const c = new MetaClient({ token: "t", accountId: m.accountId, version: "v26.0", fetch: m.fetch, clock, pacer: new Pacer(clock, { capPoints: 9000 }), maxWaitMs: 15_000 });
    m.inject({ match: (_m, p) => p.endsWith("/ads"), kind: "error", error: { message: "(#100) Filtering field id with operation in not supported", code: 100 } });
    m.inject({ match: (_m, p) => p === "802", kind: "error", error: { message: "Unsupported get request. Object with ID '802' does not exist, cannot be loaded due to missing permissions, or does not support this operation.", code: 100, error_subcode: 33 } });
    m.inject({ match: (_m, p) => p === "803", kind: "error", error: { message: "(#100) Tried accessing nonexisting field (ad_review_feedback)", code: 100 } });
    await expect(deliveryStatus(c, { ads: ["801", "802", "803"] })).rejects.toThrow(/nonexisting field/);
  });
});

describe("pixel check on a page request", () => {
  it("20 landing pages that each take the full 10 s timeout: the check still ends within a page's 25 s (scaled: 100 ms per page, 250 ms in all)", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 9000, richAccount: true });
    const c = new MetaClient({ token: "t", accountId: m.accountId, version: "v26.0", fetch: m.fetch, clock, pacer: new Pacer(clock, { capPoints: 9000 }), maxWaitMs: 15_000 });
    const pages = Array.from({ length: 20 }, (_, i) => `https://shop.example/landing-${i}`);
    const slowSite = (async (url: string) => {
      // The first 5 pages open at once; the others stand for the 10 s a page may take (AbortSignal.timeout(10_000)).
      await new Promise((r) => setTimeout(r, Number(url.split("-").pop()) < 5 ? 5 : 100));
      return new Response("<html>fbq('init','px1')</html>");
    }) as unknown as typeof fetch;
    const { pixelCheck, PAGES_WITHIN_MS } = await import("@/lib/manage/checks");
    expect(PAGES_WITHIN_MS, "one limit for all the pages of a check (production)").toBeLessThanOrEqual(10_000);
    const started = Date.now();
    // Round 3 (item 8): one overall limit for the pages, scaled like the pages: 8 s → 80 ms.
    const checks = await pixelCheck(c, "px1", pages, slowSite, { pagesWithinMs: 80 });
    const took = Date.now() - started;
    expect(took, `${took} ms = ${Math.round(took / 100)} rounds of a page timeout (${Math.round(took / 100) * 10} s in production, per pixel)`).toBeLessThanOrEqual(250);
    // The 15 pages not read in time are named as not checked, never as "pixel not found".
    const pageChecks = checks.filter((x) => /page|not_on|other/.test(x.code)); // (the practice pixel's own "never fired" note aside)
    expect(pageChecks.map((x) => x.code)).toEqual(["pixel_pages_unchecked"]);
    expect(pageChecks[0].message).toMatch(/^15 landing pages took too long to open, so pixel px1 wasn't looked for on them \(https:\/\/shop\.example\/landing-5, .* and 12 more\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// The worker process itself: started as docker-compose starts it, stopped with SIGTERM.
// ---------------------------------------------------------------------------------------------

describe("worker stop (SIGTERM)", () => {
  it("node --import tsx src/worker/index.ts: SIGTERM during a backup upload → the job goes back in the queue (not counted), exit 0 in about 8 s", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "review2-worker-"));
    const file = path.join(dataDir, "launcher.db");
    const d = openDb(file);
    // Already ran today: the nightly step stays out of the way.
    const istDay = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    d.prepare("INSERT INTO app_settings (key, value) VALUES ('nightly_last_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(istDay);
    const jobId = Number(d.prepare("INSERT INTO jobs (kind, batch_id, run_after) VALUES ('backup', NULL, 0)").run().lastInsertRowid);
    d.close();

    // Object Storage that takes the upload and never answers.
    let putSeen!: () => void;
    const put = new Promise<void>((r) => (putSeen = r));
    const server = http.createServer((req) => {
      if (req.method === "PUT") putSeen();
      req.resume();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    const child = spawn(process.execPath, ["--import", "tsx", "src/worker/index.ts"], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: dataDir, META_MOCK: "1", BACKUP_PAR_URL: `http://127.0.0.1:${port}/p/test/o/`, APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (out += String(b)));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    try {
      await Promise.race([put, exited.then(() => Promise.reject(new Error(`worker exited early:\n${out}`))), new Promise((_, no) => setTimeout(() => no(new Error(`no upload within 20 s:\n${out}`)), 20_000))]);
      const stopAt = Date.now();
      child.kill("SIGTERM");
      const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
      const took = Date.now() - stopAt;
      const after = openDb(file);
      const job = after.prepare("SELECT status, attempts FROM jobs WHERE id = ?").get(jobId) as { status: string; attempts: number };
      after.close();
      expect(code, out).toBe(0);
      expect(took).toBeGreaterThanOrEqual(7_500);
      expect(took).toBeLessThan(12_000);
      expect(job).toEqual({ status: "queued", attempts: 0 });
      expect(out).toMatch(/SIGTERM: no new jobs/);
      expect(out).toMatch(/Put 1 running job\(s\) back in the queue/);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      server.closeAllConnections();
      server.close();
    }
  }, 45_000);
});

// Last: flips this process to "worker" mode for good.
describe("the worker's clients", () => {
  it("never get a page's deadline, even when made inside a request wrapper", async () => {
    useBackgroundClients();
    expect(defaultMaxWaitMs()).toBeUndefined();
    const c = await withRequestDeadline(async () => {
      expect(sharedDeadline()).toBeUndefined();
      return clientFor(accountId);
    });
    expect(c.interactive).toBe(false);
  });
});
