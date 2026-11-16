import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { caller } from "@/lib/http";
import { dialogUrl } from "@/lib/meta/connect";

export const dynamic = "force-dynamic";

// Connect Meta button → Facebook login. A random state in a short cookie proves the
// answer that comes back to /api/meta/callback belongs to this browser.
// Redirects use APP_URL: behind Caddy, req.url says "localhost:3000".

export async function GET(req: Request) {
  try {
    await caller(req);
  } catch {
    return NextResponse.redirect(new URL("/login", config.appUrl));
  }
  try {
    const state = crypto.randomBytes(24).toString("base64url");
    const res = NextResponse.redirect(new URL(dialogUrl(state), config.appUrl));
    res.cookies.set("meta_state", state, { httpOnly: true, secure: config.appUrl.startsWith("https:"), sameSite: "lax", path: "/api/meta", maxAge: 900 });
    return res;
  } catch (e) {
    return NextResponse.redirect(new URL(`/settings?meta_error=${encodeURIComponent((e as Error).message)}#meta`, config.appUrl));
  }
}
