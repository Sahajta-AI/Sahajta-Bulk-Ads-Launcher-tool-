import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import { decrypt, encrypt } from "@/lib/crypto";
import { db, migrate, openDb } from "@/lib/db";
import { migrations } from "@/lib/db/schema";
import { sweepFiles } from "@/lib/cleanup";
import { removeAsset } from "@/lib/engine/preview";
import { LANES, claimNext, enqueue, requeueStale } from "@/lib/jobs";
import { MetaClient } from "@/lib/meta/client";
import { Pacer } from "@/lib/meta/pacer";
import { istTime } from "@/lib/manage/objects";
import { getPlan, runPlan, savePlan, summarise, type PlanInput } from "@/lib/manage/plan";
import { deleteDraft } from "@/lib/service";
import { newBatch } from "@/lib/setup";
import { getBatch, updateBatch } from "@/lib/store";
import { freshDb, mockDeps } from "./helpers";

// Audit of the foundations (database, jobs, worker restarts, disk, time zones, secrets).
// Each failing test names the behaviour the launcher should have.

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "audit-data-"));
const savedDataDir = process.env.DATA_DIR;
beforeEach(() => {
  process.env.DATA_DIR = DATA;
  freshDb();
});
afterEach(() => {
  process.env.DATA_DIR = savedDataDir;
});

const ACC = () => Number(db().prepare("INSERT INTO ad_accounts (meta_account_id, name, is_default, token_enc) VALUES ('act_1001', 'Sahajta (mock)', 1, 'x')").run().lastInsertRowid);

/** A file the way the tus upload route leaves it on disk, linked to a batch like addLocalFile does. */
function uploadedFile(batchId: number, name: string): string {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const f = path.join(config.uploadsDir, `${name}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(f, Buffer.alloc(64 * 1024));
  fs.writeFileSync(`${f}.json`, "{}");
  db().prepare("INSERT INTO assets (batch_id, source_kind, source_ref, filename, kind, size_bytes, local_path) VALUES (?, 'upload', ?, ?, 'image', ?, ?)")
    .run(batchId, path.basename(f), `${name}.jpg`, 64 * 1024, f);
  return f;
}

describe("migrations when the app and the worker start at the same moment (deploy)", () => {
  it("a new migration runs once; the process that loses the race does not crash with 'duplicate column'", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "audit-mig-")), "launcher.db");
    openDb(file).close(); // production today: schema 4
    migrations.push("ALTER TABLE ads ADD COLUMN audit_probe TEXT;"); // the next migration in a future deploy
    try {
      const app = new Database(file);
      app.pragma("busy_timeout = 5000");
      const worker = new Database(file);
      worker.pragma("busy_timeout = 5000");
      // The worker has read user_version (4); before its transaction starts, the app migrates first.
      const realTx = worker.transaction.bind(worker);
      let first = true;
      (worker as unknown as { transaction: typeof realTx }).transaction = ((fn: () => void) => {
        if (first) {
          first = false;
          migrate(app);
        }
        return realTx(fn);
      }) as typeof realTx;
      expect(() => migrate(worker)).not.toThrow();
      expect(worker.pragma("user_version", { simple: true })).toBe(migrations.length);
    } finally {
      migrations.pop();
    }
  });
});

describe("jobs after crashes", () => {
  it("a job that kills the worker every time it runs is stopped after a few tries instead of looping forever", () => {
    const id = enqueue("launch", 1);
    for (let i = 0; i < 8; i++) {
      if (!claimNext(LANES.launch)) break;
      requeueStale(); // the worker crashed (out of memory, native crash) and Docker restarted it
    }
    const row = db().prepare("SELECT status, attempts FROM jobs WHERE id = ?").get(id) as { status: string; attempts: number };
    expect(row.status).toBe("failed");
  });
});

describe("disk: creatives are removed once nothing needs them", () => {
  it("files of a deleted draft are removed by the nightly sweep", () => {
    const acc = ACC();
    const b = newBatch(acc, "test@example.com");
    const f = uploadedFile(b, "deleted-draft");
    deleteDraft(getBatch(b)!.key);
    sweepFiles();
    expect(fs.existsSync(f)).toBe(false);
  });

  it("a file removed from a draft is removed from the disk", () => {
    const acc = ACC();
    const b = newBatch(acc, "test@example.com");
    const f = uploadedFile(b, "removed");
    const assetId = (db().prepare("SELECT id FROM assets WHERE local_path = ?").get(f) as { id: number }).id;
    removeAsset(b, assetId);
    sweepFiles();
    expect(fs.existsSync(f)).toBe(false);
  });

  it("files of a launch that ended failed or partly done, and was not retried for 30 days, are removed", () => {
    const acc = ACC();
    const b = newBatch(acc, "test@example.com");
    const f = uploadedFile(b, "old-failed");
    db().prepare("UPDATE batches SET created_at = datetime('now', '-40 days') WHERE id = ?").run(b);
    updateBatch(b, { status: "partial", launched_at: new Date(Date.now() - 40 * 86_400_000).toISOString(), finished_at: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    sweepFiles();
    expect(fs.existsSync(f)).toBe(false);
  });

  it("Drive files downloaded for plans ('swap the creative') into data/tmp do not stay forever", () => {
    const tmp = path.join(config.dataDir, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const f = path.join(tmp, "swap_1AbCdEfGhIjK_video.mp4");
    fs.writeFileSync(f, Buffer.alloc(64 * 1024));
    const old = new Date(Date.now() - 3 * 86_400_000);
    fs.utimesSync(f, old, old);
    sweepFiles();
    expect(fs.existsSync(f)).toBe(false);
  });
});

describe("plans resumed after a deploy restart", () => {
  it("an edit of several ad sets that is cut off part-way still remembers each ad set's original budget (for Undo)", async () => {
    const acc = ACC();
    const { client, clock, mock } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const original = Number(mock.objects.get("as1")!.daily_budget); // 50000 = ₹500
    const input: PlanInput = {
      ops: [
        { type: "duplicate_adset", adset: "as1", copies: 3, name_template: "copy_{n}", ref: "dups" },
        { type: "edit_adset", adset: "$dups", daily_budget: 900 },
      ],
    } as PlanInput;
    const key = savePlan(acc, input, await summarise(client, input), "test@example.com", "claude");
    db().prepare("UPDATE plans SET status = 'queued' WHERE key = ?").run(key);

    // SIGTERM (deploy) arrives after the first ad set got its new budget, before the second.
    let edits = 0;
    const realPost = client.post.bind(client);
    (client as unknown as { post: typeof realPost }).post = (async (p: string, params?: Record<string, unknown>, o?: unknown) => {
      if (params && Number(params.daily_budget) === 90000 && ++edits === 2) throw Object.assign(new Error("killed"), { fatal: true });
      return realPost(p, params as never, o as never);
    }) as typeof realPost;
    await expect(runPlan(getPlan(key).id, { client, clock })).rejects.toThrow("killed");

    // The worker restarts and resumes the plan.
    const fresh = new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, pacer: new Pacer(clock), clock });
    expect(await runPlan(getPlan(key).id, { client: fresh, clock })).toEqual({ done: 2, failed: 0 });
    const progress = JSON.parse(getPlan(key).progress) as { ids: string[]; before?: Record<string, { daily_budget?: string | number }> }[];
    const copies = progress[0].ids;
    expect(copies).toHaveLength(3);
    for (const id of copies) expect(Number(progress[1].before?.[id]?.daily_budget)).toBe(original);
  });

  it("a plan job only runs a plan that is still queued or running (not one reopened as a draft)", async () => {
    const acc = ACC();
    const { client, clock, mock } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const input: PlanInput = { ops: [{ type: "edit_adset", adset: "as1", daily_budget: 900 }] };
    const key = savePlan(acc, input, await summarise(client, input), "test@example.com", "claude");
    // The plan stopped part-way, the marketer pressed Retry and is editing it (status draft, not confirmed),
    // and the old job is put back in the queue by a worker restart.
    db().prepare("UPDATE plans SET status = 'draft' WHERE key = ?").run(key);
    const before = mock.calls.filter((c) => c.method === "POST").length;
    await runPlan(getPlan(key).id, { client, clock });
    expect(mock.calls.filter((c) => c.method === "POST").length).toBe(before);
    expect(getPlan(key).status).toBe("draft");
  });
});

describe("time zones (the server runs in UTC)", () => {
  it("a run time without a zone (\"2026-11-20T09:00:00\", as Claude may send it) is read as India time", () => {
    const tz = process.env.TZ;
    process.env.TZ = "UTC"; // the Docker image sets no TZ
    try {
      expect(istTime("2026-11-20T09:00:00")).toMatch(/09:00\s*am/i);
    } finally {
      process.env.TZ = tz;
    }
  });
});

describe("secrets at rest", () => {
  it("a token saved with another APP_ENCRYPTION_KEY gives a plain message, not a crypto error", () => {
    const keep = process.env.APP_ENCRYPTION_KEY;
    try {
      process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
      const saved = encrypt("EAA-test-token");
      process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64"); // e.g. a rebuilt server with a new .env
      expect(() => decrypt(saved)).toThrow(/connect|encryption key/i);
    } finally {
      process.env.APP_ENCRYPTION_KEY = keep;
    }
  });
});
