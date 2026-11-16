import { body, route } from "@/lib/http";
import { launchBatch } from "@/lib/service";

type Ctx = { params: Promise<{ key: string }> };

/** { confirm: true, acceptWarnings?: boolean }. Every ad and ad set is created PAUSED. */
export const POST = route<Ctx>(async (req, { params }) => launchBatch((await params).key, await body<{ confirm?: boolean; acceptWarnings?: boolean }>(req)));
