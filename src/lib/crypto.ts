import crypto from "node:crypto";
import { config } from "./config";

// AES-256-GCM for secrets at rest (Meta token, Google refresh tokens).
// Format: v1:<iv b64>:<tag b64>:<ciphertext b64>

function key(): Buffer {
  const raw = config.encryptionKey;
  if (!raw) throw new Error("APP_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded.");
  return buf;
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

export const UNREADABLE_SECRET = "The saved Meta or Google connection can't be read (the server's encryption key changed). Connect again in Settings.";

export function decrypt(payload: string): string {
  const k = key(); // a missing or malformed key keeps its own message
  const [v, iv, tag, data] = payload.split(":");
  try {
    if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("Unknown secret format");
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Saved with another APP_ENCRYPTION_KEY (or damaged): say what to do, not a crypto error.
    throw new Error(UNREADABLE_SECRET);
  }
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Short random key, lowercase letters and digits, no look-alike characters. */
export function shortKey(len = 5): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
