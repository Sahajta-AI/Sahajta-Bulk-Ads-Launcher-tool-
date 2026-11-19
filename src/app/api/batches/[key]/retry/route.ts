import { body, route } from "@/lib/http";
import { batchView, retryFailed } from "@/lib/service";

type Ctx = { params: Promise<{ key: string }> };

/** Retry the ads not created yet. Ads that went through are never touched or duplicated.
 *  Optional body { presetId?, copyTemplateId? } (id or name): use another settings preset or copy
 *  template for those ads. When every ad is in but the ads were not turned on yet, the go-live runs again.
 *  The answer is the batch, plus `retry: { retried, goLive, message }`. */
export const POST = route<Ctx>(async (req, { params }) => {
  const { key } = await params;
  const b = await body<{ presetId?: number | string; copyTemplateId?: number | string }>(req);
  const retry = retryFailed(key, { presetId: b?.presetId, copyTemplateId: b?.copyTemplateId });
  return { ...(await batchView(key)), retry };
});
