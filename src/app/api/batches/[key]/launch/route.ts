import { body, route } from "@/lib/http";
import { launchBatch } from "@/lib/service";

type Ctx = { params: Promise<{ key: string }> };

/** { confirm: true, acceptWarnings?: number | boolean, spendConfirmation?: "₹15,000" }.
 *  acceptWarnings: how many warnings the person saw and accepted (a launch that finds more is refused,
 *  naming the new ones); true is still accepted. Ads are created paused; when the batch is set to go
 *  live, they are turned on after every ad is in, and the total daily budget must be typed back. */
export const POST = route<Ctx>(async (req, { params }) => launchBatch((await params).key, await body<{ confirm?: boolean; acceptWarnings?: boolean | number; spendConfirmation?: string }>(req)));
