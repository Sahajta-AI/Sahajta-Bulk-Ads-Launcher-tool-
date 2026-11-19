import { route } from "@/lib/http";
import { adPreviews } from "@/lib/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

/** ?ad=3 → Meta's preview links of ad 3 per placement (Feed, Stories, Reels), before it is created. */
export const GET = route<Ctx>(async (req, { params }) => adPreviews((await params).key, new URL(req.url).searchParams.get("ad") ?? "1"));
