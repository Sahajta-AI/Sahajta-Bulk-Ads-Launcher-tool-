// Create an API key for Claude from the server's command line (the app's Settings page does the same).
//   npm run apikey -- someone@yourcompany.com [label]
import crypto from "node:crypto";
import { config } from "@/lib/config";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";

const email = (process.argv[2] ?? "").toLowerCase();
if (!config.allowedEmails.includes(email)) {
  console.error(`${email || "(no email)"} is not in ALLOWED_EMAILS.`);
  process.exit(1);
}
const key = `sal_${crypto.randomBytes(24).toString("base64url")}`;
db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run(email, process.argv[3] ?? "Claude", sha256(key), key.slice(-4));
console.log(key);
