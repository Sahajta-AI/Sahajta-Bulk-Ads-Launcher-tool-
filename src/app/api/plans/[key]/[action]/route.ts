import { body, route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { cancelPlan, confirmPlan, planView, undoPlan, updatePlan } from "@/lib/manage/service";
import type { PlanInput } from "@/lib/manage/plan";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string; action: string }> };

// GET  /api/plans/{key}/view
// POST /api/plans/{key}/update   { ops, run_at, title }  (draft only, checked again)
// POST /api/plans/{key}/confirm  { confirm: true, acceptWarnings, spendConfirmation }
// POST /api/plans/{key}/cancel
// POST /api/plans/{key}/retry    { ops?, run_at?, title?, expected_daily_total? } a plan that stopped part-way: finished
//                                 steps stay, the rest is checked again; fields left out keep their saved value
// POST /api/plans/{key}/undo     a new plan that puts things back as they were (nothing deleted)

export const GET = route<Ctx>(async (_req, { params }) => {
  const { key, action } = await params;
  if (action !== "view") throw new HttpError(404, "Not found.");
  return planView(key);
});

export const POST = route<Ctx>(async (req, { params }, who) => {
  const { key, action } = await params;
  if (action === "update") return updatePlan(key, await body<PlanInput>(req));
  if (action === "retry") {
    // A new time or title is used also without ops (updatePlan keeps every field left out).
    const b = await body<Partial<PlanInput> | null>(req);
    return updatePlan(key, b && typeof b === "object" ? b : undefined);
  }
  if (action === "undo") return undoPlan(key, who.email, who.via === "api_key" ? "claude" : "app");
  if (action === "confirm") {
    const b = await body<{ confirm?: boolean; acceptWarnings?: boolean; spendConfirmation?: string }>(req);
    return confirmPlan(key, b, who.email);
  }
  if (action === "cancel") return cancelPlan(key);
  throw new HttpError(404, "Not found.");
});
