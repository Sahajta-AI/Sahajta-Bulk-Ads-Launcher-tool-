import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_STATUS_KEY, getSetting } from "@/lib/appsettings";
import { backupNow } from "@/lib/backup";
import { db, setDb } from "@/lib/db";
import { DB_BUSY, SERVER_FAULT, errorResponse } from "@/lib/http";
import { workerHeartbeat } from "@/lib/jobs";
import { freshDb } from "./helpers";

// Review round 2, group META: database errors on pages, and what the public /api/health shows.

vi.mock("@/auth", () => ({ auth: async () => null }));

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "r2-meta-"));
const saved = { dataDir: process.env.DATA_DIR, par: process.env.BACKUP_PAR_URL };
beforeEach(() => {
  process.env.DATA_DIR = DATA;
  delete process.env.BACKUP_PAR_URL;
  freshDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.DATA_DIR = saved.dataDir;
  if (saved.par === undefined) delete process.env.BACKUP_PAR_URL;
  else process.env.BACKUP_PAR_URL = saved.par;
});

describe("database errors on a page or a Claude tool", () => {
  it("busy or locked: 503, try again; any other: 500; SQLite's words only in the server log", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(errorResponse(new Database.SqliteError("database is locked", "SQLITE_BUSY"))).toEqual({ status: 503, message: DB_BUSY });
    expect(errorResponse(new Database.SqliteError("database is locked", "SQLITE_BUSY_SNAPSHOT"))).toEqual({ status: 503, message: DB_BUSY });
    expect(errorResponse(new Database.SqliteError("database table is locked", "SQLITE_LOCKED"))).toEqual({ status: 503, message: DB_BUSY });
    const unique = new Database.SqliteError("UNIQUE constraint failed: copy_templates.ad_account_id, copy_templates.name", "SQLITE_CONSTRAINT_UNIQUE");
    expect(errorResponse(unique)).toEqual({ status: 500, message: SERVER_FAULT });
    expect(log).toHaveBeenCalledWith(unique);
    // A real one from the database, not a hand-made error.
    db().exec("CREATE TABLE t (name TEXT UNIQUE); INSERT INTO t VALUES ('a')");
    const real = (() => {
      try {
        db().exec("INSERT INTO t VALUES ('a')");
      } catch (e) {
        return e;
      }
    })();
    expect(errorResponse(real)).toEqual({ status: 500, message: SERVER_FAULT });
    // Plain messages for the person are still shown as they are.
    expect(errorResponse(new Error("Pick an ad set first."))).toEqual({ status: 400, message: "Pick an ad set first." });
  });
});

describe("/api/health is public", () => {
  it("shows only whether the app is up and how old the backups are: no messages, paths or links", async () => {
    process.env.BACKUP_PAR_URL = "http://127.0.0.1:1/p/SECRET-PAR-TOKEN/o/";
    await backupNow("test"); // saved on the server; the upload fails
    // The last try's message can name server paths.
    const s = JSON.parse(getSetting(BACKUP_STATUS_KEY)!);
    const firstAt = new Date(Date.now() - 49 * 3600_000).toISOString();
    db()
      .prepare("UPDATE app_settings SET value = ? WHERE key = ?")
      .run(JSON.stringify({ ...s, firstAt, message: "Saved on the server, but the upload failed: ENOENT /data/backups/launcher-x.db.gz" }), BACKUP_STATUS_KEY);
    workerHeartbeat();
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, backup: { ageHours: 0, offsiteAgeHours: null } });
    expect(JSON.stringify(body)).not.toMatch(/data|SECRET|127\.0\.0\.1|Saved|failed/);
  });

  it("when the database can't be read: 503 and ok false, the error only in the server log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const closed = new Database(path.join(DATA, "closed.db"));
    closed.close();
    setDb(closed);
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
    expect(log).toHaveBeenCalled();
  });
});
