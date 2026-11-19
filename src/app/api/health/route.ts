import { NextResponse } from "next/server";
import { backupHealth } from "@/lib/backup";
import { db } from "@/lib/db";
import { lastHeartbeat } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// Public (no sign-in): used by the uptime monitor and the server's restart check. It says only
// whether the app, the database and the worker are alive, and how old the last backups are.
// Backup messages can name server paths, so they show only in Settings → Safety (signed in).
// A missing off-site backup does not make the check fail (that would restart the app for nothing).

const hoursSince = (iso: string | null, now: number) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / 3600_000)) : null);

export async function GET() {
  try {
    db().prepare("SELECT 1").get();
    const now = Date.now();
    const beat = lastHeartbeat();
    const workerOk = !!beat && now - beat < 120_000;
    const b = backupHealth(now);
    // Hours since the last backup on the server and since the last copy in Object Storage (null = none yet).
    const backup = { ageHours: hoursSince(b.lastBackupAt, now), offsiteAgeHours: hoursSince(b.lastOffsiteAt, now) };
    return NextResponse.json({ ok: workerOk, backup }, { status: workerOk ? 200 : 503 });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
