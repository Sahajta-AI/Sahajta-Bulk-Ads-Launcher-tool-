import { route } from "@/lib/http";
import { batchView, cancelBatch } from "@/lib/service";

type Ctx = { params: Promise<{ key: string }> };

/** Stop a launch after the current step. Ads already created stay; nothing is deleted. */
export const POST = route<Ctx>(async (_req, { params }) => {
  const { key } = await params;
  cancelBatch(key);
  return batchView(key);
});
