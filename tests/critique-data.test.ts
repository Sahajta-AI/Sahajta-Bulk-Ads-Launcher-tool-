import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "@/lib/config";
import { db, migrate, openDb } from "@/lib/db";
import { migrations } from "@/lib/db/schema";
import { removeBatchFiles, sweepFiles } from "@/lib/cleanup";
import { runBatch } from "@/lib/engine/launcher";
import { getPlan, runPlan, savePlan, summarise, type PlanInput } from "@/lib/manage/plan";
import { MetaClient } from "@/lib/meta/client";
import { Pacer } from "@/lib/meta/pacer";
import { deleteDraft, retryFailed } from "@/lib/service";
import { newBatch } from "@/lib/setup";
import { getBatch, updateBatch } from "@/lib/store";
import { freshDb, mockDeps, setupBatch } from "./helpers";

// Second look at tests/audit-data.test.ts: checks that confirm, limit or add to its findings.
// "guard" tests pass today and pin a rule that any fix must keep.

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "critique-data-"));
const savedDataDir = process.env.DATA_DIR;
beforeEach(() => {
  process.env.DATA_DIR = DATA;
  freshDb();
});
afterEach(() => {
  process.env.DATA_DIR = savedDataDir;
});

const ACC = () => Number(db().prepare("INSERT INTO ad_accounts (meta_account_id, name, is_default, token_enc) VALUES ('act_1001', 'Sahajta (mock)', 1, 'x')").run().lastInsertRowid);

function uploadedFile(batchId: number, name: string, f?: string): string {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  f ??= path.join(config.uploadsDir, `${name}-${Math.random().toString(36).slice(2)}`);
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, Buffer.alloc(16 * 1024));
    fs.writeFileSync(`${f}.json`, "{}");
  }
  db().prepare("INSERT INTO assets (batch_id, source_kind, source_ref, filename, kind, size_bytes, local_path) VALUES (?, 'upload', ?, ?, 'image', ?, ?)")
    .run(batchId, path.basename(f), `${name}.jpg`, 16 * 1024, f);
  return f;
}

describe("existing nightly sweep (cleanup.ts)", () => {
  it("BUG: files uploaded today into a draft that was created 15 days ago (and never 'Checked') are kept", () => {
    const acc = ACC();
    const b = newBatch(acc, "test@example.com");
    db().prepare("UPDATE batches SET created_at = datetime('now', '-15 days') WHERE id = ?").run(b);
    const f = uploadedFile(b, "fresh-upload"); // asset row created_at = now
    sweepFiles();
    expect(fs.existsSync(f)).toBe(true);
  });

  it("guard: a sibling draft (same uploaded file, launched into another ad set) can be cleaned without touching the main batch's file", () => {
    const acc = ACC();
    const main = newBatch(acc, "test@example.com");
    const sib = newBatch(acc, "test@example.com");
    const f = uploadedFile(main, "shared");
    uploadedFile(sib, "shared", f); // cloneForAdset copies local_path for uploads
    removeBatchFiles(sib);
    deleteDraft(getBatch(sib)!.key);
    expect(fs.existsSync(f)).toBe(true);
    expect(db().prepare("SELECT COUNT(*) AS n FROM assets WHERE local_path = ?").get(f)).toEqual({ n: 1 });
  });

  it("guard (limits the 30-day fix): two partial sibling launches that share a file block each other in removeBatchFiles", () => {
    const acc = ACC();
    const a = newBatch(acc, "test@example.com");
    const b = newBatch(acc, "test@example.com");
    const f = uploadedFile(a, "shared-old");
    uploadedFile(b, "shared-old", f);
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    for (const id of [a, b]) updateBatch(id, { status: "partial", launched_at: old, finished_at: old });
    removeBatchFiles(a);
    removeBatchFiles(b);
    // The "shared" check treats any non-done batch as still needing the file, so a 30-day rule
    // built on removeBatchFiles never frees it. The fix must count expired partial/failed batches as not needing it.
    expect(fs.existsSync(f)).toBe(true);
  });
});

describe("go-live lost when queueGoLive throws (finding 3)", () => {
  it("BUG: a batch whose ads were all created but whose go-live step failed can still be turned on with Retry", () => {
    const acc = ACC();
    const b = newBatch(acc, "test@example.com");
    updateBatch(b, { go_live: "now", campaign_id: "c1", adset_id: "as1" });
    const key = getBatch(b)!.key;
    db().prepare("INSERT INTO ads (batch_id, position, key, creative_name, status, meta_ad_id, meta_adset_id) VALUES (?, 1, ?, 'x', 'done', 'ad1', 'as1')").run(b, `${key}-01`);
    // What the worker's catch writes when queueGoLive throws after every ad was created.
    updateBatch(b, { status: "partial", finished_at: new Date().toISOString() });
    try {
      retryFailed(key);
    } catch {
      /* 409 "No failed ads to retry." */
    }
    const plans = db().prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number };
    const jobs = db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get() as { n: number };
    expect(getBatch(b)!.go_live_done || plans.n || jobs.n).toBeTruthy();
  });
});

describe("requeued jobs (finding 6)", () => {
  it("guard: re-running a launch that already finished makes no Meta writes (so launches need no status check, and keeping the re-run keeps the go-live retry)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "critique-img-"));
    await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#c33" } }).jpeg().toFile(path.join(dir, "offer_4x5.jpg"));
    const { accountId, batchId } = await setupBatch(dir);
    const { mock, deps } = mockDeps(accountId);
    expect(await runBatch(batchId, deps)).toEqual({ done: 1, failed: 0 });
    const writes = mock.calls.filter((c) => c.method === "POST").length;
    expect(await runBatch(batchId, deps)).toEqual({ done: 1, failed: 0 });
    expect(mock.calls.filter((c) => c.method === "POST").length).toBe(writes);
    expect(getBatch(batchId)!.status).toBe("done");
  });

  it("BUG: a requeued job for a plan that ended 'partial' does not re-run the failed step without a new yes", async () => {
    const acc = ACC();
    const { client, clock, mock } = mockDeps(acc, { capPoints: 9000, richAccount: true });
    const input: PlanInput = { ops: [{ type: "edit_adset", adset: "as1", daily_budget: 900 }] };
    const key = savePlan(acc, input, await summarise(client, input), "test@example.com", "claude");
    db().prepare("UPDATE plans SET status = 'partial', progress = ? WHERE key = ?").run(JSON.stringify([{ status: "failed", ids: [], message: "Step 1 failed: network" }]), key);
    const before = mock.calls.filter((c) => c.method === "POST").length;
    await runPlan(getPlan(key).id, { client, clock });
    expect(mock.calls.filter((c) => c.method === "POST").length).toBe(before);
  });
});

describe("Undo memory for set_status (finding 5, go-live plans use set_status)", () => {
  it("BUG: the item being switched on when the worker dies keeps its original status for Undo", async () => {
    const acc = ACC();
    const { client, clock, mock } = mockDeps(acc, { capPoints: 9000, richAccount: true, allowActive: true });
    const input: PlanInput = { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1", "as4"] }] };
    const key = savePlan(acc, input, await summarise(client, input, { validate: false }), "test@example.com", "claude");
    db().prepare("UPDATE plans SET status = 'queued' WHERE key = ?").run(key);
    let n = 0;
    const realPost = client.post.bind(client);
    (client as unknown as { post: typeof realPost }).post = (async (p: string, params?: Record<string, unknown>, o?: unknown) => {
      const r = await realPost(p, params as never, o as never);
      if (params?.status === "ACTIVE" && ++n === 2) throw Object.assign(new Error("killed after Meta applied it"), { fatal: true });
      return r;
    }) as typeof realPost;
    await expect(runPlan(getPlan(key).id, { client, clock })).rejects.toThrow("killed");
    const fresh = new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, pacer: new Pacer(clock), clock });
    await runPlan(getPlan(key).id, { client: fresh, clock });
    const before = (JSON.parse(getPlan(key).progress) as { before?: Record<string, { status?: string }> }[])[0].before ?? {};
    expect(before.as1?.status).toBe("PAUSED"); // saved: the step saved after this item
    expect(before.as4?.status).toBe("PAUSED"); // lost: Meta applied it, the worker died before saving
  });
});

describe("time zones (finding 7)", () => {
  it("guard: a run time without a zone is shown in the plan summary as the time it will really run (so the person can see it before saying yes)", async () => {
    const tz = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const acc = ACC();
      const { client } = mockDeps(acc, { capPoints: 9000, richAccount: true });
      const s = await summarise(client, { run_at: "2027-11-20T09:00:00", ops: [{ type: "edit_adset", adset: "as1", daily_budget: 900 }] });
      expect(s.steps[0].title).toMatch(/02:30\s*pm IST/i);
      expect(new Date(Date.parse("2027-11-20T09:00:00")).toISOString()).toBe("2027-11-20T09:00:00.000Z");
    } finally {
      process.env.TZ = tz;
    }
  });
});

describe("migration race (finding 8)", () => {
  // Fixed (INFRA I8): migrate() now runs each step in an IMMEDIATE transaction and reads user_version
  // again inside it, so the process that loses the race skips the step instead of failing once with
  // "duplicate column". The guard now checks that it does not throw at all, and that a restart is still fine.
  it("guard: the process that loses the migration race does not fail, and a later start is still fine", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "critique-mig-")), "launcher.db");
    openDb(file).close();
    migrations.push("ALTER TABLE ads ADD COLUMN critique_probe TEXT;");
    try {
      const app = new Database(file);
      const worker = new Database(file);
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
      const restarted = new Database(file);
      expect(() => migrate(restarted)).not.toThrow();
      expect(restarted.pragma("user_version", { simple: true })).toBe(migrations.length);
    } finally {
      migrations.pop();
    }
  });
});
