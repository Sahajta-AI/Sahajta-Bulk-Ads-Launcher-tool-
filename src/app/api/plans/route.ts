import { body, route } from "@/lib/http";
import { createPlan, listPlans } from "@/lib/manage/service";
import type { PlanInput } from "@/lib/manage/plan";

export const dynamic = "force-dynamic";

export const GET = route(async () => ({ plans: listPlans() }));

/** Save and check a plan. Nothing in Meta changes until it is confirmed. */
export const POST = route(async (req, _ctx, who) => createPlan(await body<PlanInput>(req), who.email, who.via === "api_key" ? "claude" : "app"));
