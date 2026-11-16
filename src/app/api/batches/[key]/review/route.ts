import { route } from "@/lib/http";
import { refreshReview } from "@/lib/service";

type Ctx = { params: Promise<{ key: string }> };

export const POST = route<Ctx>(async (_req, { params }) => {
  refreshReview((await params).key);
});
