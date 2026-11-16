import crypto from "node:crypto";
import { body, route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, _ctx, who) =>
  db().prepare("SELECT id, label, key_hint AS hint, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_keys WHERE user_email = ? AND revoked_at IS NULL ORDER BY id DESC").all(who.email),
);

/** Create a key for Claude. The key is shown once; only its hash is stored. */
export const POST = route(async (req, _ctx, who) => {
  if (who.via !== "session") throw new HttpError(403, "API keys can only be created from the app.");
  const { label } = await body<{ label?: string }>(req);
  const key = `sal_${crypto.randomBytes(24).toString("base64url")}`;
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run(who.email, label?.trim() || "Claude", sha256(key), key.slice(-4));
  return { key };
});
