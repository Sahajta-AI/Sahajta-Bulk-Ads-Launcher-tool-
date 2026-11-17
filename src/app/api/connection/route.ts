import { route } from "@/lib/http";
import { connectionSummary } from "@/lib/service";

export const dynamic = "force-dynamic";

/** What the launcher is connected to: ad account, Page and Instagram (photo, ID, link), login expiry. */
export const GET = route(async () => connectionSummary());
