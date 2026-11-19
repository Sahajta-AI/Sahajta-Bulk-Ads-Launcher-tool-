import { route } from "@/lib/http";
import { batchView, cancelBatch } from "@/lib/service";

type Ctx = { params: Promise<{ key: string }> };

/** Stop a launch after the current step, with the launches into other ad sets made with it, and any
 *  turn-on of their ads that has not run (also when every ad is already in). Ads already created stay
 *  paused; nothing is deleted. `cancelled` names each batch and what happened to it (`result`,
 *  `planKey`, `message`), including turn-ons that already ran (Stop doesn't turn those off). */
export const POST = route<Ctx>(async (_req, { params }) => {
  const { key } = await params;
  const { cancelled } = cancelBatch(key);
  return { ...(await batchView(key)), cancelled };
});
