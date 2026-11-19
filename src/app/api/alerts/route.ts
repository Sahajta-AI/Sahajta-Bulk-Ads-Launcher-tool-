import { route } from "@/lib/http";
import { recentAlerts } from "@/lib/alerts";

export const dynamic = "force-dynamic";

/** Failure alerts of the last 14 days (also emailed when allowed). */
export const GET = route(async () => ({ alerts: recentAlerts(10) }));
