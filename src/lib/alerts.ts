import { createHash } from "node:crypto";
import { config } from "./config";
import { db } from "./db";
import { getAppSettings } from "./appsettings";
import { GO_LIVE_MAX_TRIES, goLiveRetryKey, goLiveStopped, type GoLiveRetryInfo } from "./jobs";
import { authFor } from "./sources/drive";

// Failure alerts: when a launch or plan that runs in the background (often at a scheduled time,
// with nobody watching) fails or half-fails, the person who started it gets an email from their
// own Google account (Gmail API, "send only" permission given at sign-in). No paid service.
// If the email can't be sent, the alert stays on the home page and in the activity log.
//
// The same subject again (same person) within 6 hours replaces the earlier home-page entry (the
// newest words are shown, with a count). It is emailed again only when its words changed: a job
// that retries every few minutes with the same problem must not send an email every few minutes,
// but a new problem under the same subject (Retry failed again for another reason) is emailed.

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/**
 * What an alert is about, so the right event removes it from the home page:
 *  - create_failed: ads of a launch were not created (gone when every ad is in);
 *  - stopped: a launch or plan stopped with an error (a launch's goes when every ad is in);
 *  - golive: ads created but not turned on yet (gone only once the turn-on step went through).
 * Other alerts (plans not run, backups) have no kind and are never removed by a launch.
 */
export type AlertKind = "create_failed" | "stopped" | "golive";

export interface Alert {
  to: string;
  subject: string;
  lines: string[];
  link: string;
  kind?: AlertKind;
}

type Stored = Alert & { at: string; count?: number; emailedAt?: string; emailedSig?: string };

const REPEAT_MS = 6 * 3_600_000;
let seq = 0;
const KEEP_MS = 14 * 86_400_000;

/** Header values never carry a line break (a subject or address can't add headers). */
const oneLine = (s: string) => String(s).replace(/[\r\n]+/g, " ").trim();

/** The alert's words: a different text under the same subject is a new problem (emailed again). */
const sigOf = (a: Alert) => createHash("sha256").update(`${a.subject}\n${a.lines.join("\n")}`).digest("hex").slice(0, 16);

/** The alert's kind; alerts saved before kinds existed (or sent without one) are known by their subject. */
export function kindOf(a: Pick<Alert, "kind" | "subject">): AlertKind | null {
  if (a.kind) return a.kind;
  if (/not turned on/i.test(a.subject)) return "golive";
  if (/\bnot created\b|\bfailed\b/i.test(a.subject)) return "create_failed";
  if (/\bstopped\b/i.test(a.subject)) return "stopped";
  return null;
}

/** The email as Gmail's API takes it (exported for tests: no header can be added through the subject or address). */
export function alertMime(a: Alert): string {
  const body = [...a.lines, "", `Open it: ${a.link}`, "", "Sent by the Sahajta Ads Launcher. Turn these emails off in Settings → Safety."].join("\r\n");
  const subject = `=?UTF-8?B?${Buffer.from(oneLine(a.subject)).toString("base64")}?=`;
  const to = oneLine(a.to);
  return [`To: ${to}`, `From: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", body].join("\r\n");
}

/** Save the alert for the home page. An earlier entry with the same subject (6 hours) is replaced; returns it. */
function record(a: Alert): { key: string; earlier: Stored | null } {
  const now = Date.now();
  let earlier: Stored | null = null;
  const rows = db().prepare("SELECT key, value FROM cache WHERE key LIKE 'alert:%' AND expires_at > ? ORDER BY key DESC LIMIT 100").all(now) as { key: string; value: string }[];
  for (const r of rows) {
    const v = JSON.parse(r.value) as Stored;
    if (v.to.toLowerCase() === a.to.toLowerCase() && v.subject === a.subject && now - Date.parse(v.at) < REPEAT_MS) {
      earlier = v;
      db().prepare("DELETE FROM cache WHERE key = ?").run(r.key);
      break;
    }
  }
  // Keys sort by arrival (the home page lists newest first), even within one millisecond.
  const key = `alert:${now}:${String(seq++ % 1_000_000).padStart(6, "0")}${Math.random().toString(36).slice(2, 4)}`;
  const value: Stored = {
    ...a,
    at: new Date(now).toISOString(),
    count: (earlier?.count ?? 1) + (earlier ? 1 : 0),
    // What was emailed (and when) is kept, so the same words are not emailed twice within 6 hours.
    ...(earlier?.emailedAt ? { emailedAt: earlier.emailedAt, emailedSig: earlier.emailedSig } : {}),
  };
  db().prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), now + KEEP_MS);
  return { key, earlier };
}

function markEmailed(key: string, sig: string) {
  const row = db().prepare("SELECT value FROM cache WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return;
  db().prepare("UPDATE cache SET value = ? WHERE key = ?").run(JSON.stringify({ ...(JSON.parse(row.value) as Stored), emailedAt: new Date().toISOString(), emailedSig: sig }), key);
}

/** Record the alert (home page) and email it. Never throws: an alert must not break the worker. */
export async function sendAlert(a: Alert): Promise<{ emailed: boolean; why?: string }> {
  let saved: { key: string; earlier: Stored | null } | null = null;
  const sig = sigOf(a);
  try {
    saved = record(a);
  } catch {
    /* the email still goes out */
  }
  try {
    if (!getAppSettings().alertEmails) return { emailed: false, why: "email alerts are off in Settings" };
    const sentAt = saved?.earlier?.emailedAt ? Date.parse(saved.earlier.emailedAt) : NaN;
    // Older entries have no emailedSig: their words are taken as the same.
    const sameWords = !saved?.earlier?.emailedSig || saved.earlier.emailedSig === sig;
    if (Date.now() - sentAt < REPEAT_MS && sameWords) return { emailed: false, why: "the same alert was emailed less than 6 hours ago (it is updated on the home page)" };
    const scope = (db().prepare("SELECT google_scope FROM users WHERE email = ?").get(oneLine(a.to).toLowerCase()) as { google_scope: string | null } | undefined)?.google_scope ?? "";
    if (!scope.includes(GMAIL_SEND_SCOPE)) return { emailed: false, why: `${a.to} hasn't allowed email alerts yet (sign out and in again, and allow "send email")` };
    const client = authFor(oneLine(a.to));
    const { token } = await client.getAccessToken();
    const raw = Buffer.from(alertMime(a)).toString("base64url");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { emailed: false, why: `Gmail answered ${res.status}${res.status === 403 ? " (is the Gmail API switched on in the Google Cloud project?)" : ""}` };
    try {
      if (saved) markEmailed(saved.key, sig);
    } catch {
      /* the email went out; only the "don't repeat" note is lost */
    }
    return { emailed: true };
  } catch (e) {
    return { emailed: false, why: e instanceof Error ? e.message : String(e) };
  }
}

/** Alerts of the last 14 days, newest first (home page). `count` > 1 when the same subject came again. */
export function recentAlerts(limit = 10): (Alert & { at: string; count?: number })[] {
  const rows = db().prepare("SELECT value FROM cache WHERE key LIKE 'alert:%' AND expires_at > ? ORDER BY key DESC LIMIT ?").all(Date.now(), limit) as { value: string }[];
  return rows.map((r) => {
    const { emailedAt: _e, emailedSig: _s, ...v } = JSON.parse(r.value) as Stored;
    return v;
  });
}

/**
 * Remove the home-page alerts that link to this page (e.g. "/batches/ab12c" after its Retry worked).
 * With `kinds`, only alerts of those kinds (an alert of no known kind is never removed then).
 * Returns how many.
 */
export function clearAlerts(path: string, kinds?: AlertKind[]): number {
  const rows = db().prepare("SELECT key, value FROM cache WHERE key LIKE 'alert:%'").all() as { key: string; value: string }[];
  let n = 0;
  for (const r of rows) {
    const v = JSON.parse(r.value) as Stored;
    const link = v.link ?? "";
    if (link !== path && !link.endsWith(path)) continue;
    if (kinds) {
      const k = kindOf(v);
      if (!k || !kinds.includes(k)) continue;
    }
    db().prepare("DELETE FROM cache WHERE key = ?").run(r.key);
    n++;
  }
  return n;
}

export const appLink = (path: string) => `${config.appUrl}${path}`;

/** "3:05 pm" in India time. */
const istClock = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();

/**
 * One plain sentence when a batch was meant to turn its ads on but they are not on yet because the
 * turn-on step failed: while the worker tries again, and after it gave up (kept 14 days, like the
 * alert). Null otherwise: paused launch, nothing failed, the turn-on step went through (go_live_done),
 * or "Stop the launch" is in force (nothing is tried again; the batch page and Claude say it was stopped).
 * The ad sets of one launch are turned on together, by the step of whichever finished last: its tries
 * count for every batch of the launch still to be turned on (this batch's own first).
 */
export function goLiveNote(batchId: number): string | null {
  const b = db().prepare("SELECT go_live, go_live_done, cancel_requested, stopped_at, retried_at FROM batches WHERE id = ?").get(batchId) as
    | { go_live: string | null; go_live_done: number; cancel_requested: number; stopped_at: string | null; retried_at: string | null }
    | undefined;
  if (!b || !b.go_live || b.go_live === "paused" || b.go_live_done || goLiveStopped(b)) return null;
  const read = <T,>(key: string) => {
    const r = db().prepare("SELECT value FROM cache WHERE key = ? AND expires_at > ?").get(key, Date.now()) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  };
  // This batch and the batches turned on together with it (launched with it, still to be turned on, not stopped).
  const group = db()
    .prepare(
      `SELECT id FROM batches WHERE id = ? OR (group_key IS NOT NULL AND group_key = (SELECT group_key FROM batches WHERE id = ?)
         AND go_live != 'paused' AND status != 'draft' AND go_live_done = 0 AND cancel_requested = 0)
       ORDER BY id = ? DESC, id`,
    )
    .pluck()
    .all(batchId, batchId, batchId) as number[];
  const tried = group.map((id) => ({ id, tries: Number(read<number>(goLiveRetryKey(id))) || 0 })).filter((x) => x.tries > 0);
  const from = tried.find((x) => x.id === batchId) ?? tried.sort((x, y) => y.tries - x.tries)[0];
  if (!from) return null;
  const tries = from.tries;
  const info = read<GoLiveRetryInfo>(`${goLiveRetryKey(from.id)}info`);
  const full = (info?.reason ?? "").trim().replace(/\.+$/, "");
  const reason = full.length > 300 ? `${full.slice(0, 299).trimEnd()}…` : full;
  // The real schedule: a go-live job of the launch waiting in the queue (or running now).
  const job = db()
    .prepare(`SELECT status, run_after FROM jobs WHERE kind = 'golive' AND batch_id IN (${group.map(() => "?").join(",")}) AND status IN ('queued', 'running') ORDER BY status = 'running' DESC, run_after LIMIT 1`)
    .get(...group) as { status: string; run_after: number } | undefined;
  const gaveUp = !job && (info ? info.nextAt === null : tries >= GO_LIVE_MAX_TRIES);
  if (gaveUp) return `The ads were NOT turned on${reason ? `: ${reason}` : ` after ${tries} tries`}. They stay paused.`;
  const failed = `Turning the ads on failed ${tries} time${tries === 1 ? "" : "s"}${reason ? ` (${reason})` : ""}.`;
  if (job?.status === "running") return `${failed} Trying again now.`;
  const next = job?.run_after ?? info?.nextAt ?? null;
  return next ? `${failed} Trying again at ${istClock(Math.max(next, Date.now()))} IST.` : failed;
}
