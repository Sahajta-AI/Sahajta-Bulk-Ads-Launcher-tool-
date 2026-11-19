import { route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { clientFor } from "@/lib/meta/factory";
import { MetaError, RateLimitedError, plainError } from "@/lib/meta/errors";
import { deliveryStatus, planDeliveryTargets } from "@/lib/manage/delivery";
import { getPlan, planProgress } from "@/lib/manage/plan";
import { getAccount } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Meta IDs are digits (letters in practice mode); a name with spaces is not an ID. */
const ID = /^[A-Za-z0-9_]+$/;

/** ?campaign=ID | ?adset=ID | ?ad=ID | ?plan=KEY → delivery, review and learning status. */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  try {
    if (u.get("plan")) {
      // What the plan made or changed, by kind, from its own steps: no Meta call per ID to ask what it is
      // (IDs of older steps whose kind isn't saved are looked up in one list read per kind).
      // The plan's own ad account, which may not be the default one.
      const r = getPlan(u.get("plan")!);
      const ops = (JSON.parse(r.ops) as { ops?: { type: string }[] }).ops ?? [];
      const targets = planDeliveryTargets(ops, planProgress(r));
      if (!targets.campaigns.length && !targets.adsets.length && !targets.ads.length && !targets.unknown?.length) return { rows: [] };
      return { rows: await deliveryStatus(clientFor(r.ad_account_id), targets) };
    }
    const q = { campaigns: u.getAll("campaign"), adsets: u.getAll("adset"), ads: u.getAll("ad") };
    for (const [what, list] of [["campaign", q.campaigns], ["ad set", q.adsets], ["ad", q.ads]] as const) {
      const bad = list.find((x) => !ID.test(x.trim()));
      if (bad !== undefined) throw new HttpError(400, `"${bad}" is not ${what === "ad" ? "an" : "a"} ${what} ID. Give the ID (a number; Ads Manager shows it in the ${what}'s row), not the name.`);
    }
    if (!q.campaigns.length && !q.adsets.length && !q.ads.length) throw new HttpError(400, "Give ?campaign=, ?adset=, ?ad= or ?plan=.");
    const acc = getAccount();
    if (!acc?.token_enc) throw new HttpError(409, "Meta is not connected yet.");
    return { rows: await deliveryStatus(clientFor(acc.id), q) };
  } catch (e) {
    if (e instanceof MetaError && !(e instanceof RateLimitedError)) throw new HttpError(e.isThrottle ? 429 : 502, plainError(e, "Reading the delivery status"));
    throw e;
  }
});
