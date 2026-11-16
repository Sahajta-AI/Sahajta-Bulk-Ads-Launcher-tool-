import { body, route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { disconnect, inspect, listAssets, listInstagram, metaStatus, savePending, selectAssets } from "@/lib/meta/connect";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ action: string }> };

// GET  /api/meta/status      the connection, for Settings
// GET  /api/meta/assets      ad accounts and Pages the login may use
// GET  /api/meta/instagram?adAccountId=act_…   Instagram accounts for that ad account
// POST /api/meta/select      save the chosen ad account, Page and Instagram account
// POST /api/meta/token       "Paste a token instead" (then pick, as after the login)
// POST /api/meta/disconnect  forget the token

export const GET = route<Ctx>(async (req, ctx, who) => {
  const { action } = await ctx.params;
  if (action === "status") return metaStatus(who.email);
  if (action === "assets") return listAssets(who.email);
  if (action === "instagram") return listInstagram(who.email, new URL(req.url).searchParams.get("adAccountId") ?? "");
  throw new HttpError(404, "Not found.");
});

export const POST = route<Ctx>(async (req, ctx, who) => {
  const { action } = await ctx.params;
  if (who.via !== "session") throw new HttpError(403, "The Meta connection can only be changed in the app.");
  if (action === "select") {
    const b = await body<{ adAccountId?: string; pageId?: string; igUserId?: string }>(req);
    await selectAssets(who.email, { adAccountId: b.adAccountId ?? "", pageId: b.pageId ?? "", igUserId: b.igUserId || undefined });
    return metaStatus(who.email);
  }
  if (action === "token") {
    const { token } = await body<{ token?: string }>(req);
    const t = token?.trim().replace(/^Bearer\s+/i, "");
    if (!t) throw new HttpError(400, "Paste the token first.");
    savePending(who.email, await inspect(t));
    return { ok: true };
  }
  if (action === "disconnect") {
    disconnect();
    return metaStatus(who.email);
  }
  throw new HttpError(404, "Not found.");
});
