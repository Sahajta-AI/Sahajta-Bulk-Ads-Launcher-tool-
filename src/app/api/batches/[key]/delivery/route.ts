import { route } from "@/lib/http";
import { batchDelivery } from "@/lib/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

/** Delivery, review and learning status of the batch's ad sets and ads. */
export const GET = route<Ctx>(async (_req, { params }) => batchDelivery((await params).key));
