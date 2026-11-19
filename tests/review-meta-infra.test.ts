import Database from "better-sqlite3";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Review probes (19 Nov 2026) for the Meta layer and the worker after the META/INFRA fixes.
// Each test names the behaviour we want. A failing test = a bug found by the review.

const ctl = vi.hoisted(() => ({
  runBatch: null as null | ((id: number) => Promise<{ done: number; failed: number }>),
  queueGoLive: null as null | ((id: number) => Promise<string | null>),
  checkReview: null as null | ((id: number) => Promise<{ pending: number }>),
}));

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/engine/launcher", async (orig) => {
  const real = await orig<typeof import("@/lib/engine/launcher")>();
  return {
    ...real,
    runBatch: (id: number, deps: never) => (ctl.runBatch ? ctl.runBatch(id) : real.runBatch(id, deps)),
    checkReview: (c: never, id: number) => (ctl.checkReview ? ctl.checkReview(id) : real.checkReview(c, id)),
  };
});
vi.mock("@/lib/manage/golive", async (orig) => {
  const real = await orig<typeof import("@/lib/manage/golive")>();
  return { ...real, queueGoLive: (id: number) => (ctl.queueGoLive ? ctl.queueGoLive(id) : real.queueGoLive(id)) };
});
vi.mock("@/lib/cleanup", async (orig) => {
  const real = await orig<typeof import("@/lib/cleanup")>();
  return { ...real, removeBatchFiles: () => 0 };
});
vi.mock("@/lib/meta/factory", async (orig) => {
  const real = await orig<typeof import("@/lib/meta/factory")>();
  return { ...real, clientFor: () => ({}) };
});

import { backupNow } from "@/lib/backup";
import { db, openDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { LANES, claimNext, enqueue } from "@/lib/jobs";
import { MetaClient } from "@/lib/meta/client";
import { RateLimitedError } from "@/lib/meta/errors";
import { loadPacer } from "@/lib/meta/factory";
import { FakeClock } from "@/lib/meta/mock";
import { Pacer, WINDOW_MS, type Clock, type PacerState } from "@/lib/meta/pacer";
import { newBatch } from "@/lib/setup";
import { updateBatch } from "@/lib/store";
import { runClaimed } from "@/worker/run";
import { freshDb } from "./helpers";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "review-meta-infra-"));
const saved = { dataDir: process.env.DATA_DIR, par: process.env.BACKUP_PAR_URL };
beforeEach(() => {
  process.env.DATA_DIR = DATA;
  delete process.env.BACKUP_PAR_URL;
  freshDb();
  ctl.runBatch = ctl.queueGoLive = ctl.checkReview = null;
});
afterEach(() => {
  process.env.DATA_DIR = saved.dataDir;
  if (saved.par === undefined) delete process.env.BACKUP_PAR_URL;
  else process.env.BACKUP_PAR_URL = saved.par;
});

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake clock that lets "other requests" act while a call sleeps. */
class RaceClock implements Clock {
  t = Date.UTC(2026, 10, 19, 9, 0, 0);
  slept = 0;
  onSleep: (() => void) | null = null;
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
    this.slept += ms;
    this.onSleep?.();
  }
}

describe("interactive deadline (M5), end to end", () => {
  it("a page's call answers within its 25 s even when other page/Claude requests take each freed point first", async () => {
    const clock = new RaceClock();
    const pacer = new Pacer(clock, { capPoints: 60 });
    // The page share (90% of 60 = 54 points) is used; one point ages out every 5 seconds.
    pacer.state.log = Array.from({ length: 54 }, (_, i) => [clock.t - WINDOW_MS + 5_000 * (i + 1), 1] as [number, number]);
    // Other requests in the same web process (same pacerFor object) win each freed point.
    let others = 0;
    clock.onSleep = () => {
      if (others++ < 40) pacer.state.log.push([clock.now(), 1]);
    };
    const c = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: (async () => answer({ id: "1" })) as unknown as typeof fetch, clock, pacer, maxWaitMs: 15_000 });
    const r = await c.get("1").then(
      () => "answered",
      (e: unknown) => e,
    );
    expect(clock.slept, `waited ${Math.round(clock.slept / 1000)} s in Pacer.acquire's loop`).toBeLessThanOrEqual(25_000);
    expect(r).toBeInstanceOf(RateLimitedError);
  });

  it("an interactive list read stops asking again with smaller pages once its 25 s are used", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const tooBig = (async () => {
      calls++;
      clock.t += 10_000; // Meta takes a while before it says the page is too big
      return answer({ error: { message: "Please reduce the amount of data you're asking for, then retry your request", code: 1 } }, 500);
    }) as unknown as typeof fetch;
    const c = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: tooBig, clock, pacer: new Pacer(clock, { capPoints: 9000 }), maxWaitMs: 15_000 });
    await c.getAll("act_1/ads", { fields: "id,creative{id,name,object_story_spec}" }).catch(() => null);
    expect(calls, `${calls} requests, ${(calls * 10)} s for one page request`).toBeLessThanOrEqual(3);
  });
});

describe("pacer: SQLITE_BUSY fallback (M1)", () => {
  // Round 3: two real connections to one database file (the web app and the worker), real SQLite
  // locks, and the factory's own pacer (loadPacer). This used to fake the busy error in one process.
  it("a step that falls back after SQLITE_BUSY never overwrites a block the other process saved", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "m1-busy-")), "launcher.db");
    const webConn = openDb(file);
    const workerConn = openDb(file);
    webConn.pragma("busy_timeout = 30"); // production waits 5 s; same code path, shorter test
    const row = () => JSON.parse(workerConn.prepare("SELECT state FROM rate_state WHERE ad_account_id = 1").pluck().get() as string) as PacerState;
    workerConn.prepare("INSERT INTO rate_state (ad_account_id, state) VALUES (1, ?)").run(JSON.stringify({ log: [], capPoints: 60, blockedUntil: 0 }));
    const web = loadPacer(1, webConn);
    // The worker holds the database: it was refused by Meta and saves a 5-minute block.
    workerConn.exec("BEGIN IMMEDIATE");
    const blockedUntil = Date.now() + WINDOW_MS;
    workerConn.prepare("UPDATE rate_state SET state = ? WHERE ad_account_id = 1").run(JSON.stringify({ log: [], capPoints: 60, blockedUntil, strikes: 1, lastRefusalAt: Date.now() }));
    web.observe({ bucMaxPct: 10 }); // the web's answer to an earlier call arrives: busy, nothing written
    workerConn.exec("COMMIT");
    expect(row().blockedUntil).toBe(blockedUntil);
    // The next step gets the database: what the web saw is saved, the worker's block stays.
    web.observe({ bucMaxPct: 11 });
    expect(row()).toMatchObject({ blockedUntil, strikes: 1, lastBuc: { pct: 11 } });
    webConn.close();
    workerConn.close();
  });
});

describe("worker: go-live retries (I1) and the review schedule (I2)", () => {
  const ACC = () => Number(db().prepare("INSERT INTO ad_accounts (meta_account_id, name, is_default, token_enc) VALUES ('act_1001', 'Sahajta (mock)', 1, 'x')").run().lastInsertRowid);
  const queued = (kind: string, batchId: number | null) => db().prepare("SELECT * FROM jobs WHERE kind = ? AND batch_id IS ? AND status = 'queued'").all(kind, batchId) as { id: number; run_after: number }[];

  it("a go-live retry (the launch job run again 5 minutes later) does not pull the next review check forward", async () => {
    const b = newBatch(ACC(), "marketer@example.com");
    db().prepare("INSERT INTO ads (batch_id, position, key, creative_name, status, meta_ad_id) VALUES (?, 1, 'k-1', 'c-1', 'done', 'ad1')").run(b);
    updateBatch(b, { status: "running", go_live: "now", campaign_id: "c1", adset_id: "as1" });
    ctl.runBatch = async (id) => {
      updateBatch(id, { status: "done", finished_at: new Date().toISOString() });
      return { done: 1, failed: 0 };
    };
    ctl.queueGoLive = async () => {
      throw new Error("Meta did not answer");
    };
    ctl.checkReview = async () => ({ pending: 1 }); // Meta is still reviewing the ad
    enqueue("launch", b);
    await runClaimed(claimNext(LANES.launch)!);
    // Review check 1 (2 minutes after the launch): the next one is due 10 minutes later.
    db().prepare("UPDATE jobs SET run_after = 0 WHERE kind = 'review' AND status = 'queued'").run();
    await runClaimed(claimNext(LANES.other)!);
    const before = queued("review", b)[0].run_after;
    expect(before).toBeGreaterThan(Date.now() + 9 * 60_000);
    // The go-live retry 5 minutes later: since round 2 a "golive" job (only the turn-on step, in the
    // lane with the review checks), no longer the whole launch job.
    db().prepare("UPDATE jobs SET run_after = 0 WHERE kind = 'golive' AND status = 'queued'").run();
    await runClaimed(claimNext(LANES.other)!);
    expect(queued("review", b)[0].run_after, "review check pulled forward to 2 minutes: 12 go-live retries use up the 24-hour schedule in about an hour").toBeGreaterThanOrEqual(before);
  });
});

describe("http.ts errorResponse (M6)", () => {
  it("a database error is not shown to the person as a 400 with SQLite's words and table names", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const locked = errorResponse(new Database.SqliteError("database is locked", "SQLITE_BUSY"));
      const unique = errorResponse(new Database.SqliteError("UNIQUE constraint failed: copy_templates.ad_account_id, copy_templates.name", "SQLITE_CONSTRAINT_UNIQUE"));
      expect(unique.message).not.toMatch(/constraint|copy_templates/);
      expect(locked.status).not.toBe(400);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("backups (I7)", () => {
  it("an expired backup link (Object Storage answers 404 before reading the upload) is reported as HTTP 404 with the hint", async () => {
    // Make the database big enough that the upload is still being written when the answer comes.
    const big = "x".repeat(200_000);
    const ins = db().prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)");
    for (let i = 0; i < 200; i++) ins.run(`probe:${i}`, JSON.stringify(big + i + Math.random()), Date.now() + 3600_000);
    const server = http.createServer((req, res) => {
      res.writeHead(404, { "content-type": "text/plain", connection: "close" });
      res.end("The PAR has expired");
      req.socket.destroySoon?.();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.BACKUP_PAR_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/p/SECRET/n/ns/b/bucket/o/`;
    try {
      const r = await backupNow("probe");
      expect(r.uploaded).toBe(false);
      expect(r.message).toMatch(/HTTP 404.*expired/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
