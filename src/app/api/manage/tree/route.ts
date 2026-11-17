import { route } from "@/lib/http";
import { campaignTree } from "@/lib/manage/service";

export const dynamic = "force-dynamic";

/** Every campaign with its ad sets, budgets and settings in plain words. ?refresh=1 reads Meta again. */
export const GET = route(async (req) => campaignTree(new URL(req.url).searchParams.get("refresh") === "1"));
