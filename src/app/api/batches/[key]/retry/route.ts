import { route } from "@/lib/http";
import { batchView, retryFailed } from "@/lib/service";

type Ctx = { params: Promise<{ key: string }> };

/** Retry failed ads only. Ads that went through are never touched or duplicated. */
export const POST = route<Ctx>(async (_req, { params }) => {
  const { key } = await params;
  retryFailed(key);
  return batchView(key);
});
