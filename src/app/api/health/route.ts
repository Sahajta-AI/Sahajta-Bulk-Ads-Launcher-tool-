import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { lastHeartbeat } from "@/lib/jobs";

export const dynamic = "force-dynamic";

// Public: used by the uptime monitor. Says whether the app, the database and the worker are alive.
export async function GET() {
  try {
    db().prepare("SELECT 1").get();
    const beat = lastHeartbeat();
    const workerOk = !!beat && Date.now() - beat < 120_000;
    return NextResponse.json({ ok: workerOk, app: "ok", database: "ok", worker: workerOk ? "ok" : "not responding" }, { status: workerOk ? 200 : 503 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
