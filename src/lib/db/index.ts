import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { migrations } from "./schema";

export type DB = Database.Database;

const g = globalThis as unknown as { __launcherDb?: DB };

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.pragma("busy_timeout = 5000");
  d.pragma("foreign_keys = ON");
  migrate(d);
  return d;
}

/**
 * Brings the database to the newest schema. The web app and the worker start at the same moment
 * after a deploy, so each step runs in an IMMEDIATE transaction (one process at a time) and reads
 * user_version again inside it: the process that comes second sees the step done and skips it.
 */
export function migrate(d: DB) {
  if ((d.pragma("user_version", { simple: true }) as number) >= migrations.length) return;
  const step = d.transaction((): boolean => {
    const v = d.pragma("user_version", { simple: true }) as number;
    if (v >= migrations.length) return false;
    d.exec(migrations[v]);
    d.pragma(`user_version = ${v + 1}`);
    return true;
  });
  while (step.immediate()) {
    /* next migration */
  }
}

/** The shared database for the web app and the worker (one file, WAL mode). */
export function db(): DB {
  if (!g.__launcherDb) g.__launcherDb = openDb(config.dbPath);
  return g.__launcherDb;
}

/** Tests use this to point the app at a fresh database. */
export function setDb(d: DB) {
  g.__launcherDb = d;
}

export function now(): string {
  return new Date().toISOString();
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
