import { body, route } from "@/lib/http";
import { launchBatch } from "@/lib/service";

type Ctx = { params: Promise<{ key: string }> };

/** { confirm: true, acceptWarnings?: boolean, spendConfirmation?: "₹15,000" }.
 *  Ads are created paused; when the batch is set to go live, they are turned on after every ad is in,
 *  and the total daily budget must be typed back in spendConfirmation. */
export const POST = route<Ctx>(async (req, { params }) => launchBatch((await params).key, await body<{ confirm?: boolean; acceptWarnings?: boolean; spendConfirmation?: string }>(req)));
