import { route } from "@/lib/http";
import { batchLaunchSummary } from "@/lib/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

/** The pre-launch summary: accounts, Page, Instagram, every budget and the total, schedule, copy. */
export const GET = route<Ctx>(async (_req, { params }) => batchLaunchSummary((await params).key));
