import Database from "better-sqlite3";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fixes for the worker, the job queue, migrations and backups (INFRA I1–I10).
// The worker's own logic is tested with the launch, plan and review engines replaced by stubs:
// what is checked here is what the worker does around them.

const ctl = vi.hoisted(() => ({
  runBatch: null as null | ((id: number) => Promise<{ done: number; failed: number }>),
  queueGoLive: null as null | ((id: number) => Promise<string | null>),
  checkReview: null as null | ((id: number) => Promise<{ pending: number }>),
  runPlan: null as null | ((id: number) => Promise<{ done: number; failed: number }>),
  removeBatchFiles: null as null | ((id: number) => number),
  sweepFiles: null as null | (() => unknown),
}));

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
vi.mock("@/lib/manage/plan", async (orig) => {
  const real = await orig<typeof import("@/lib/manage/plan")>();
  return { ...real, runPlan: (id: number, deps: never) => (ctl.runPlan ? ctl.runPlan(id) : real.runPlan(id, deps)) };
});
vi.mock("@/lib/cleanup", async (orig) => {
  const real = await orig<typeof import("@/lib/cleanup")>();
  return {
    ...real,
    removeBatchFiles: (id: number) => (ctl.removeBatchFiles ? ctl.removeBatchFiles(id) : real.removeBatchFiles(id)),
    sweepFiles: () => (ctl.sweepFiles ? ctl.sweepFiles() : real.sweepFiles()),
  };
});
vi.mock("@/lib/meta/factory", async (orig) => {
  const real = await orig<typeof import("@/lib/meta/factory")>();
  return { ...real, clientFor: () => ({}) };
});

import { recentAlerts } from "@/lib/alerts";
import { BACKUP_STATUS_KEY, NIGHTLY_DAY_KEY, getSetting } from "@/lib/appsettings";
import { backupAlertDue, backupHealth, backupNow, markBackupAlerted } from "@/lib/backup";
import { db, migrate, openDb, setDb } from "@/lib/db";
import { migrations } from "@/lib/db/schema";
import { LANES, MAX_ATTEMPTS, claimNext, enqueue, releaseJobs, requeueStale, reviewCheckedAt } from "@/lib/jobs";
import { cacheGet, cacheSet, getAds, getBatch, updateBatch } from "@/lib/store";
import { newBatch } from "@/lib/setup";
import { GO_LIVE_MAX_TRIES, REVIEW_SCHEDULE_MIN, nightly, runClaimed, safeHeartbeat } from "@/worker/run";
import { freshDb } from "./helpers";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "fix-infra-"));
const saved = { dataDir: process.env.DATA_DIR, par: process.env.BACKUP_PAR_URL, admin: process.env.ADMIN_EMAIL };
beforeEach(() => {
  process.env.DATA_DIR = DATA;
  delete process.env.BACKUP_PAR_URL;
  freshDb();
  for (const k of Object.keys(ctl) as (keyof typeof ctl)[]) ctl[k] = null;
});
afterEach(() => {
  process.env.DATA_DIR = saved.dataDir;
  if (saved.par === undefined) delete process.env.BACKUP_PAR_URL;
  else process.env.BACKUP_PAR_URL = saved.par;
  if (saved.admin === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = saved.admin;
});

/** The test ad account (made once per test database). */
const ACC = () =>
  (db().prepare("SELECT id FROM ad_accounts WHERE meta_account_id = 'act_1001'").get() as { id: number } | undefined)?.id ??
  Number(db().prepare("INSERT INTO ad_accounts (meta_account_id, name, is_default, token_enc) VALUES ('act_1001', 'Sahajta (mock)', 1, 'x')").run().lastInsertRowid);

/** A batch with ads in the given states, as it is while the worker runs it. */
function batchWithAds(states: string[], patch: Record<string, string | number | null> = {}): number {
  const b = newBatch(ACC(), "marketer@example.com");
  const key = getBatch(b)!.key;
  states.forEach((s, i) =>
    db().prepare("INSERT INTO ads (batch_id, position, key, creative_name, status, error, meta_ad_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(b, i + 1, `${key}-${i + 1}`, `creative-${i + 1}`, s, s === "failed" ? "Meta refused the video (own reason)" : null, s === "done" ? `ad${i + 1}` : null),
  );
  updateBatch(b, { status: "running", go_live: "now", campaign_id: "c1", adset_id: "as1", ...patch });
  return b;
}

/** Stub runBatch: ends the batch like the real one (status from the ads). */
function runBatchEnds(result: { done: number; failed: number }) {
  ctl.runBatch = async (id) => {
    updateBatch(id, { status: result.failed === 0 ? "done" : result.done === 0 ? "failed" : "partial", finished_at: new Date().toISOString() });
    return result;
  };
}

async function runLaunchJob(batchId: number) {
  enqueue("launch", batchId);
  const job = claimNext(LANES.launch)!;
  await runClaimed(job);
  return db().prepare("SELECT * FROM jobs WHERE id = ?").get(job.id) as { status: string; last_error: string | null };
}

const queued = (kind: string, batchId: number | null) =>
  db().prepare("SELECT * FROM jobs WHERE kind = ? AND batch_id IS ? AND status = 'queued'").all(kind, batchId) as { id: number; run_after: number }[];

describe("I1: after a launch, the follow-up steps never change the batch's result", () => {
  it("go-live failing after every ad was created: batch stays done, only the go-live is tried again in 5 minutes, and the person is told", async () => {
    const b = batchWithAds(["done", "done"]);
    runBatchEnds({ done: 2, failed: 0 });
    ctl.queueGoLive = async () => {
      throw new Error("Meta is limiting calls for this ad account");
    };
    const job = await runLaunchJob(b);
    expect(job.status).toBe("done");
    expect(getBatch(b)!.status).toBe("done");
    expect(getAds(b).every((a) => a.status === "done")).toBe(true);
    // A go-live job, never the whole launch again.
    expect(queued("launch", b)).toHaveLength(0);
    const again = queued("golive", b);
    expect(again).toHaveLength(1);
    expect(again[0].run_after).toBeGreaterThan(Date.now() + 4 * 60_000);
    const alert = recentAlerts().find((a) => a.subject.includes("not turned on"));
    expect(alert?.lines[0]).toBe("Ads created but not turned on yet: Meta is limiting calls for this ad account");
    // The other follow-ups still happened.
    expect(queued("review", b)).toHaveLength(1);
    expect(queued("backup", null)).toHaveLength(1);
  });

  it("the re-run turns the ads on once Meta answers, and stops retrying", async () => {
    const b = batchWithAds(["done"]);
    runBatchEnds({ done: 1, failed: 0 });
    let calls = 0;
    ctl.queueGoLive = async () => {
      if (++calls === 1) throw new Error("network drop");
      return "Turning the ads on now (plan P-1).";
    };
    await runLaunchJob(b);
    db().prepare("UPDATE jobs SET run_after = 0 WHERE kind = 'golive' AND status = 'queued'").run();
    const retry = claimNext(LANES.other)!;
    expect(retry.kind).toBe("golive");
    await runClaimed(retry);
    expect(calls).toBe(2);
    expect(queued("golive", b)).toHaveLength(0);
    expect(cacheGet(`golive_retry:${b}:`)).toBeUndefined();
    expect(getBatch(b)!.status).toBe("done");
  });

  it(`gives up after ${GO_LIVE_MAX_TRIES} tries and says to press Retry`, async () => {
    const b = batchWithAds(["done"]);
    runBatchEnds({ done: 1, failed: 0 });
    ctl.queueGoLive = async () => {
      throw new Error("still failing");
    };
    cacheSet(`golive_retry:${b}:`, GO_LIVE_MAX_TRIES - 1, 60_000);
    await runLaunchJob(b);
    expect(queued("golive", b)).toHaveLength(0);
    expect(recentAlerts()[0].lines.join(" ")).toMatch(/press Retry/);
    expect(getBatch(b)!.status).toBe("done");
  });

  it("a follow-up step that throws (file removal) doesn't change the status and doesn't stop the go-live", async () => {
    const b = batchWithAds(["done"]);
    runBatchEnds({ done: 1, failed: 0 });
    ctl.removeBatchFiles = () => {
      throw new Error("EACCES: permission denied");
    };
    let turnedOn = false;
    ctl.queueGoLive = async () => {
      turnedOn = true;
      return "ok";
    };
    const job = await runLaunchJob(b);
    expect(job.status).toBe("done");
    expect(getBatch(b)!.status).toBe("done");
    expect(turnedOn).toBe(true);
  });

  it("error handler: a launch that stopped after every ad was created is marked done, not partly done", async () => {
    const b = batchWithAds(["done", "done"]);
    ctl.runBatch = async () => {
      throw new Error("database is locked");
    };
    const job = await runLaunchJob(b);
    expect(job.status).toBe("failed");
    expect(getBatch(b)!.status).toBe("done");
  });

  it("error handler: ads not created are marked failed with the reason; ads that already failed keep their own reason", async () => {
    const b = batchWithAds(["done", "failed", "pending"]);
    ctl.runBatch = async () => {
      throw new Error("network drop");
    };
    await runLaunchJob(b);
    const ads = getAds(b);
    expect(getBatch(b)!.status).toBe("partial");
    expect(ads[1].error).toBe("Meta refused the video (own reason)");
    expect(ads[2].status).toBe("failed");
    expect(ads[2].error).toMatch(/^The launch stopped before this ad was created: network drop/);
  });
});

describe("I2: review checks keep their schedule when one fails", () => {
  it("a failed check schedules the next one", async () => {
    const b = batchWithAds(["done"], { status: "done" });
    ctl.checkReview = async () => {
      throw new Error("Meta is limiting calls");
    };
    enqueue("review", b);
    await runClaimed(claimNext(LANES.other)!);
    const next = queued("review", b);
    expect(next).toHaveLength(1);
    expect(next[0].run_after).toBeGreaterThan(Date.now() + (REVIEW_SCHEDULE_MIN[1] - 1) * 60_000);
  });

  it("the schedule still ends: failed checks count", async () => {
    const b = batchWithAds(["done"], { status: "done" });
    ctl.checkReview = async () => {
      throw new Error("down");
    };
    for (let i = 0; i < REVIEW_SCHEDULE_MIN.length + 2; i++) {
      db().prepare("UPDATE jobs SET run_after = 0 WHERE kind = 'review' AND status = 'queued'").run();
      if (i === 0) enqueue("review", b, 0);
      const job = claimNext(LANES.other);
      if (!job) break;
      await runClaimed(job);
    }
    const total = (db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'review' AND batch_id = ?").get(b) as { n: number }).n;
    expect(total).toBe(REVIEW_SCHEDULE_MIN.length);
    expect(queued("review", b)).toHaveLength(0);
  });

  it("a successful check records when it ran (reviewCheckedAt for the batch page)", async () => {
    const b = batchWithAds(["done"], { status: "done" });
    ctl.checkReview = async () => ({ pending: 0 });
    expect(reviewCheckedAt(b)).toBeNull();
    enqueue("review", b);
    await runClaimed(claimNext(LANES.other)!);
    expect(Date.parse(reviewCheckedAt(b)!)).toBeGreaterThan(Date.now() - 60_000);
  });
});

function plan(status: string): number {
  const acc = ACC();
  return Number(db().prepare("INSERT INTO plans (key, ad_account_id, title, status, ops, created_by) VALUES (?, ?, 'Test plan', ?, '{\"ops\":[]}', 'marketer@example.com')").run(`P-${Math.random().toString(36).slice(2, 7)}`, acc, status).lastInsertRowid);
}

describe("I3: a plan job only runs a plan that is waiting to run", () => {
  for (const status of ["draft", "partial", "done", "failed", "cancelled"]) {
    it(`a requeued job for a ${status} plan does nothing`, async () => {
      const id = plan(status);
      let ran = false;
      ctl.runPlan = async () => {
        ran = true;
        return { done: 1, failed: 0 };
      };
      enqueue("plan", id);
      await runClaimed(claimNext(LANES.plan)!);
      expect(ran).toBe(false);
      expect(queued("backup", null)).toHaveLength(0);
      expect((db().prepare("SELECT status FROM plans WHERE id = ?").get(id) as { status: string }).status).toBe(status);
    });
  }

  it("a queued plan runs", async () => {
    const id = plan("queued");
    let ran = false;
    ctl.runPlan = async () => {
      ran = true;
      return { done: 1, failed: 0 };
    };
    enqueue("plan", id);
    await runClaimed(claimNext(LANES.plan)!);
    expect(ran).toBe(true);
  });
});

describe("I4: job attempts", () => {
  it(`a launch job that kills the worker ${MAX_ATTEMPTS} times is stopped, and its batch is marked like any failed run`, () => {
    const b = batchWithAds(["done", "pending"]);
    const id = enqueue("launch", b);
    for (let i = 0; i < 10; i++) {
      if (!claimNext(LANES.launch)) break;
      const r = requeueStale(); // crash, Docker restarts the worker
      if (r.stopped.length) expect(r.stopped[0].stopped).toEqual({ kind: "launch", key: getBatch(b)!.key, who: "marketer@example.com" });
    }
    const job = db().prepare("SELECT status, last_error FROM jobs WHERE id = ?").get(id) as { status: string; last_error: string };
    expect(job.status).toBe("failed");
    expect(job.last_error).toMatch(/restarted 5 times/);
    expect(getBatch(b)!.status).toBe("partial");
    expect(getAds(b)[1].status).toBe("failed");
    expect(getAds(b)[1].error).toMatch(/restarted 5 times.*Press "Retry"/);
  });

  it("a plan job given up the same way marks the plan failed; a plan that already finished is not touched", () => {
    const running = plan("running");
    const done = plan("done");
    const a = enqueue("plan", running);
    const b2 = enqueue("plan", done);
    db().prepare("UPDATE jobs SET status = 'running', attempts = ? WHERE id IN (?, ?)").run(MAX_ATTEMPTS, a, b2);
    const r = requeueStale();
    expect(r.requeued).toBe(0);
    expect(r.stopped).toHaveLength(2);
    expect((db().prepare("SELECT status FROM plans WHERE id = ?").get(running) as { status: string }).status).toBe("failed");
    expect((db().prepare("SELECT status FROM plans WHERE id = ?").get(done) as { status: string }).status).toBe("done");
  });

  it("a deploy's SIGTERM reaches the worker started like the container starts it: the running job goes back in the queue (no attempt counted) and it exits within the 15-second stop window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-stop-"));
    const file = path.join(dir, "launcher.db");
    const d = openDb(file);
    // The nightly run already happened today, so the worker starts nothing else.
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    d.prepare("INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, 'test', datetime('now'))").run(NIGHTLY_DAY_KEY, today);
    // A backup whose upload never gets an answer: the job is still running when the stop comes.
    const server = http.createServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const jobId = Number(d.prepare("INSERT INTO jobs (kind, batch_id, run_after) VALUES ('backup', NULL, 0)").run().lastInsertRowid);
    const job = () => d.prepare("SELECT status, attempts FROM jobs WHERE id = ?").get(jobId) as { status: string; attempts: number };
    let out = "";
    const child = spawn(process.execPath, ["--import", "tsx", "src/worker/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: dir, BACKUP_PAR_URL: `http://127.0.0.1:${port}/p/test/n/ns/b/bucket/o/` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (out += String(b)));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    try {
      for (let i = 0; i < 150 && job().status !== "running"; i++) await new Promise((r) => setTimeout(r, 200));
      expect(job(), out).toEqual({ status: "running", attempts: 1 });
      const t0 = Date.now();
      child.kill("SIGTERM");
      const code = await Promise.race([exited, new Promise<"still running">((r) => setTimeout(() => r("still running"), 20_000))]);
      expect(code, out).toBe(0);
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(out).toMatch(/SIGTERM: no new jobs/);
      expect(out).toMatch(/Put 1 running job\(s\) back in the queue/);
      expect(job()).toEqual({ status: "queued", attempts: 0 });
    } finally {
      child.kill("SIGKILL");
      server.closeAllConnections();
      server.close();
      d.close();
    }
  }, 60_000);

  it("a job that finished in the stop window is not put back", () => {
    const id = enqueue("backup", null);
    claimNext(LANES.other);
    db().prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(id);
    expect(releaseJobs([id])).toBe(0);
  });
});

/** A time in India time on a given day. */
const ist = (d: string, hhmm: string) => Date.parse(`${d}T${hhmm}:00+05:30`);

describe("I5: nightly cleanup and backup", () => {
  it("runs once per India-time day, on the first check after 02:00 (even hours late)", async () => {
    expect(await nightly(ist("2026-11-20", "01:59"))).toBe(false);
    expect(queued("backup", null)).toHaveLength(0);
    // The lane was busy all night: the first check is at 05:10.
    expect(await nightly(ist("2026-11-20", "05:10"))).toBe(true);
    expect(queued("backup", null)).toHaveLength(1);
    expect(getSetting(NIGHTLY_DAY_KEY)).toBe("2026-11-20");
    expect(await nightly(ist("2026-11-20", "23:59"))).toBe(false);
    expect(await nightly(ist("2026-11-21", "00:30"))).toBe(false);
    expect(await nightly(ist("2026-11-21", "02:00"))).toBe(true);
  });

  it("a failing cleanup never throws out of the nightly run (it would stop the worker)", async () => {
    ctl.sweepFiles = () => {
      throw new Error("ENOSPC");
    };
    await expect(nightly(ist("2026-11-20", "02:01"))).resolves.toBe(true);
    expect(queued("backup", null)).toHaveLength(1);
  });

  it("a worker restart does not run it twice the same day (the day is in the database)", async () => {
    expect(await nightly(ist("2026-11-20", "02:30"))).toBe(true);
    db().prepare("DELETE FROM jobs").run();
    expect(await nightly(ist("2026-11-20", "02:31"))).toBe(false);
    expect(queued("backup", null)).toHaveLength(0);
  });
});

describe("I6: heartbeat", () => {
  it("a database error in the heartbeat timer doesn't throw (it would crash the worker)", () => {
    const closed = openDb(":memory:");
    closed.close();
    setDb(closed);
    try {
      expect(() => safeHeartbeat()).not.toThrow();
    } finally {
      freshDb();
    }
  });
});

/** A local stand-in for Object Storage: answers PUTs with `status` and keeps what it received. */
async function bucket(status: number) {
  const got: { url: string; body: Buffer; length: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      got.push({ url: req.url ?? "", body: Buffer.concat(parts), length: req.headers["content-length"] });
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/p/SECRET-PAR-TOKEN/n/ns/b/bucket/o/`, got, close: () => new Promise((r) => server.close(r)) };
}

describe("I7: backups", () => {
  it("streams a compressed copy to Object Storage and records the result (without the link)", async () => {
    db().prepare("INSERT INTO ad_accounts (meta_account_id, name) VALUES ('act_42', 'Backup probe')").run();
    const b = await bucket(200);
    process.env.BACKUP_PAR_URL = b.url;
    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      const r = await backupNow("test");
      expect(r.uploaded).toBe(true);
      expect(readSpy.mock.calls.filter((c) => String(c[0]).includes("backups"))).toHaveLength(0);
    } finally {
      readSpy.mockRestore();
      await b.close();
    }
    expect(b.got).toHaveLength(1);
    expect(b.got[0].url).toMatch(/\/o\/launcher-.*\.db\.gz$/);
    expect(Number(b.got[0].length)).toBe(b.got[0].body.length);
    const restored = path.join(DATA, "restored.db");
    fs.writeFileSync(restored, zlib.gunzipSync(b.got[0].body));
    const copy = new Database(restored, { readonly: true });
    expect(copy.prepare("SELECT name FROM ad_accounts WHERE meta_account_id = 'act_42'").get()).toEqual({ name: "Backup probe" });
    copy.close();
    const s = JSON.parse(getSetting(BACKUP_STATUS_KEY)!);
    expect(s).toMatchObject({ saved: true, uploaded: true, message: "Backed up (test)." });
    expect(s.lastUploadedAt).toBe(s.at);
  });

  it("a refused upload is recorded with a plain message that never shows the link", async () => {
    const b = await bucket(403);
    process.env.BACKUP_PAR_URL = b.url;
    try {
      const r = await backupNow("test");
      expect(r.uploaded).toBe(false);
      expect(r.message).toMatch(/HTTP 403.*expired/);
    } finally {
      await b.close();
    }
    const h = backupHealth();
    expect(h.offsite).toBe(false);
    expect(JSON.stringify(h)).not.toMatch(/SECRET-PAR-TOKEN/);
  });

  it("an upload that can't connect doesn't show the link either", async () => {
    process.env.BACKUP_PAR_URL = "http://127.0.0.1:1/p/SECRET-PAR-TOKEN/n/ns/b/bucket/o/";
    const r = await backupNow("test");
    expect(r.uploaded).toBe(false);
    expect(r.message).toMatch(/upload to Object Storage failed/);
    expect(getSetting(BACKUP_STATUS_KEY)).not.toMatch(/SECRET-PAR-TOKEN/);
  });

  it("/api/health shows only how old the backups are (still 200 for the uptime check); the warning after 48 hours is in Settings", async () => {
    process.env.BACKUP_PAR_URL = "http://127.0.0.1:1/p/SECRET-PAR-TOKEN/o/";
    await backupNow("test"); // upload fails
    const s = JSON.parse(getSetting(BACKUP_STATUS_KEY)!);
    // The first failing backup was 49 hours ago.
    db().prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(JSON.stringify({ ...s, firstAt: new Date(Date.now() - 49 * 3600_000).toISOString() }), BACKUP_STATUS_KEY);
    safeHeartbeat();
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = (await res.json()) as { ok: boolean; backup: { ageHours: number | null; offsiteAgeHours: number | null } };
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, backup: { ageHours: 0, offsiteAgeHours: null } });
    expect(JSON.stringify(body)).not.toMatch(/SECRET-PAR-TOKEN/);
    // Settings → Safety (signed in) says why, without the link.
    const h = backupHealth();
    expect(h.offsite).toBe(false);
    expect(h.warning).toMatch(/No backup has reached Object Storage yet \(49 hours/);
    expect(JSON.stringify(h)).not.toMatch(/SECRET-PAR-TOKEN/);
  });

  it("the admin is alerted after 48 hours without an off-site copy, at most once a day", async () => {
    process.env.ADMIN_EMAIL = "admin@example.com";
    const b = await bucket(200);
    process.env.BACKUP_PAR_URL = b.url;
    try {
      await backupNow("test"); // uploaded now
    } finally {
      await b.close();
    }
    const now = Date.now();
    expect(backupAlertDue(now + 47 * 3600_000)).toBeNull();
    const due = backupAlertDue(now + 49 * 3600_000);
    expect(due?.to).toBe("admin@example.com");
    expect(due?.lines[0]).toMatch(/No backup copy outside the server for 49 hours/);
    markBackupAlerted(now + 49 * 3600_000);
    expect(backupAlertDue(now + 50 * 3600_000)).toBeNull();
    expect(backupAlertDue(now + 74 * 3600_000)).not.toBeNull();
  });
});

describe("I8: migrations when the app and the worker start at the same moment", () => {
  it("the process that loses the race skips the migration instead of failing", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fix-mig-")), "launcher.db");
    openDb(file).close();
    migrations.push("ALTER TABLE ads ADD COLUMN fix_probe TEXT;");
    try {
      const app = new Database(file);
      const worker = new Database(file);
      worker.pragma("busy_timeout = 5000");
      const realTx = worker.transaction.bind(worker);
      let first = true;
      (worker as unknown as { transaction: typeof realTx }).transaction = ((fn: () => void) => {
        if (first) {
          first = false;
          migrate(app); // the app wins: it migrates after the worker read user_version
        }
        return realTx(fn);
      }) as typeof realTx;
      expect(() => migrate(worker)).not.toThrow();
      expect(worker.pragma("user_version", { simple: true })).toBe(migrations.length);
      expect((worker.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('ads') WHERE name = 'fix_probe'").get() as { n: number }).n).toBe(1);
    } finally {
      migrations.pop();
    }
  });
});

describe("I10: the campaign lists are read again after a launch or plan", () => {
  const seed = () => {
    cacheSet("tree:1", { campaigns: [] }, 120_000);
    cacheSet("dest:1", { campaigns: [] }, 120_000);
  };

  it("after a launch (also when it failed)", async () => {
    const b = batchWithAds(["done"]);
    runBatchEnds({ done: 1, failed: 0 });
    ctl.queueGoLive = async () => null;
    seed();
    await runLaunchJob(b);
    expect(cacheGet("tree:1")).toBeUndefined();
    expect(cacheGet("dest:1")).toBeUndefined();

    const b2 = batchWithAds(["pending"]);
    ctl.runBatch = async () => {
      throw new Error("network drop");
    };
    seed();
    await runLaunchJob(b2);
    expect(cacheGet("tree:1")).toBeUndefined();
    expect(cacheGet("dest:1")).toBeUndefined();
  });

  it("after a plan", async () => {
    const id = plan("queued");
    ctl.runPlan = async () => ({ done: 1, failed: 0 });
    seed();
    enqueue("plan", id);
    await runClaimed(claimNext(LANES.plan)!);
    expect(cacheGet("tree:1")).toBeUndefined();
    expect(cacheGet("dest:1")).toBeUndefined();
  });
});
