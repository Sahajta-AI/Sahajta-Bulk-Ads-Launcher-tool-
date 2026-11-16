import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { config } from "./config";
import { sha256 } from "./crypto";
import { db } from "./db";
import { HttpError } from "./httperror";

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

/** Wrap a route handler: catches errors and returns { error } with a plain message. */
export function route<Ctx>(fn: (req: Request, ctx: Ctx, who: Caller) => Promise<unknown>) {
  return async (req: Request, ctx: Ctx) => {
    try {
      const who = await caller(req);
      const out = await fn(req, ctx, who);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      const message = e instanceof Error ? e.message : String(e);
      if (!(e instanceof HttpError)) console.error(e);
      return NextResponse.json({ error: message }, { status });
    }
  };
}

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
