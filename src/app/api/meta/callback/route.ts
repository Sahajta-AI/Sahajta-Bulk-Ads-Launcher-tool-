import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { caller } from "@/lib/http";
import { exchangeCode, savePending } from "@/lib/meta/connect";

export const dynamic = "force-dynamic";

// Facebook sends the browser back here with a one-time code. The server swaps it for a
// token, keeps it encrypted, and sends the person to Settings to pick the ad account and Page.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/settings?${q}#meta`, config.appUrl));
    res.cookies.delete({ name: "meta_state", path: "/api/meta" });
    return res;
  };
  let email: string;
  try {
    email = (await caller(req)).email;
  } catch {
    return NextResponse.redirect(new URL("/login", config.appUrl));
  }
  const cookie = req.headers.get("cookie")?.match(/(?:^|;\s*)meta_state=([^;]+)/)?.[1];
  if (!cookie || cookie !== url.searchParams.get("state")) return back(`meta_error=${encodeURIComponent("The Facebook login took too long or came from another window. Click Connect Meta again.")}`);
  if (url.searchParams.get("error")) return back("meta=cancelled");
  const code = url.searchParams.get("code");
  if (!code) return back(`meta_error=${encodeURIComponent("Facebook did not send the login back. Click Connect Meta again.")}`);
  try {
    savePending(email, await exchangeCode(code));
    return back("meta=pick");
  } catch (e) {
    return back(`meta_error=${encodeURIComponent((e as Error).message)}`);
  }
}
