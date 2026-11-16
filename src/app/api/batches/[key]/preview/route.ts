import { route } from "@/lib/http";
import { runPreview } from "@/lib/service";

type Ctx = { params: Promise<{ key: string }> };

/** Full check, including loading every landing page. */
export const POST = route<Ctx>(async (_req, { params }) => runPreview((await params).key));
