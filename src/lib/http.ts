import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { config } from "./config";
import { sha256 } from "./crypto";
import { db } from "./db";
import { HttpError } from "./httperror";
import { MetaError, RateLimitedError, plainError } from "./meta/errors";
import { NotConnectedError, withRequestDeadline } from "./meta/factory";

// Shared helpers for API routes: who is calling (browser session or Claude API key),
// and plain-language error responses.

export { HttpError };

export interface Caller {
  email: string;
  via: "session" | "api_key";
}

export async function caller(req: Request): Promise<Caller> {
  const authz = req.headers.get("authorization");
  if (authz?.startsWith("Bearer ")) {
    const key = authz.slice(7).trim();
    const row = db().prepare("SELECT id, user_email FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL").get(sha256(key)) as { id: number; user_email: string } | undefined;
    if (!row || !config.allowedEmails.includes(row.user_email)) throw new HttpError(401, "This API key is not valid. Create a new one in the app under Settings → Claude connection.");
    db().prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
    return { email: row.user_email, via: "api_key" };
  }
  const dev = process.env.DEV_LOGIN_EMAIL;
  if (dev && process.env.NODE_ENV === "development") return { email: dev.toLowerCase(), via: "session" };
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email || !config.allowedEmails.includes(email)) throw new HttpError(401, "Please sign in.");
  return { email, via: "session" };
}

export const SERVER_FAULT = "Something went wrong on the server; it was logged.";
export const DB_BUSY = "The database is busy. Try again in a moment.";

/** better-sqlite3's error code ("SQLITE_BUSY", "SQLITE_CONSTRAINT_UNIQUE"…), if `e` is a database error. */
function sqliteCode(e: unknown): string | undefined {
  const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.startsWith("SQLITE_") ? code : undefined;
}

/**
 * The status and plain message for an error a route threw.
 * - HttpError: its own status and words.
 * - Meta limiting calls: 429 with the time to try again.
 * - Meta not connected: 409 with what to click.
 * - Any other Meta error: 502 with the plain sentence and Meta's words.
 * - The database busy (the worker holds it): 503, try again. Any other database error: 500.
 *   SQLite's words (table and column names) go to the server log, not the page.
 * - A bug in our code (TypeError and friends): 500; the details go to the server log, not the page.
 * - Any other Error: 400 with its message (many messages for the person are plain Errors).
 */
export function errorResponse(e: unknown): { status: number; message: string } {
  if (e instanceof HttpError) return { status: e.status, message: e.message };
  if (e instanceof RateLimitedError) return { status: 429, message: e.message };
  if (e instanceof NotConnectedError) return { status: 409, message: e.message };
  if (e instanceof MetaError) {
    console.error(e);
    return { status: e.isThrottle ? 429 : 502, message: plainError(e, "The request to Meta") };
  }
  const dbCode = sqliteCode(e);
  if (dbCode) {
    console.error(e);
    return /^SQLITE_(BUSY|LOCKED)/.test(dbCode) ? { status: 503, message: DB_BUSY } : { status: 500, message: SERVER_FAULT };
  }
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError || e instanceof RangeError) {
    console.error(e);
    return { status: 500, message: SERVER_FAULT };
  }
  if (e instanceof Error) {
    console.error(e);
    return { status: 400, message: e.message };
  }
  console.error(e);
  return { status: 400, message: String(e) };
}

/**
 * Wrap a route handler: catches errors and returns { error } with a plain message. Every Meta
 * client the handler makes shares one deadline (factory.ts withRequestDeadline), so a page or a
 * Claude tool gets its answer within about 25 s however many reads the request needs.
 */
export function route<Ctx>(fn: (req: Request, ctx: Ctx, who: Caller) => Promise<unknown>) {
  return (req: Request, ctx: Ctx) =>
    withRequestDeadline(async () => {
      try {
        const who = await caller(req);
        const out = await fn(req, ctx, who);
        return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
      } catch (e) {
        const { status, message } = errorResponse(e);
        return NextResponse.json({ error: message }, { status });
      }
    });
}

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
