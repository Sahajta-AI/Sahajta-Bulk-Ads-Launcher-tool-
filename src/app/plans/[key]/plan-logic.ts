// Decisions the plan page makes (pure: no React, so they can be unit tested).

import type { PlanView } from "@/lib/manage/service";
import type { Check } from "@/lib/types";
import { ist } from "../../manage/util";

/** A time in India time: the server's own words when it sent them, else formatted here. */
export function timeLabel(label: string | null | undefined, iso: string | null | undefined): string {
  return label || ist(iso);
}

/**
 * The plan's checks as the page shows them. The plan's own notes (code "plan_note": what a retry
 * or an undo can't put back) show next to the confirm button of a draft; on a plan that already
 * ran they stay with the other warnings. `toAccept`: every warning and note, which the tick covers
 * (the server counts them all).
 */
export function planChecks(checks: Check[] | null | undefined, isDraft: boolean) {
  const all = checks ?? [];
  const isNote = (c: Check) => c.level === "warning" && c.code === "plan_note";
  return {
    errors: all.filter((c) => c.level === "error"),
    warnings: all.filter((c) => c.level === "warning" && !(isDraft && isNote(c))),
    notes: isDraft ? all.filter(isNote) : [],
    toAccept: all.filter((c) => c.level === "warning").length,
  };
}

/**
 * The amount typed back to confirm is what can spend in a day once the plan has run (only what ends
 * on, lifetime budgets per day). It can differ from the plan's total daily budget (every budget, on
 * or off): say so, so nobody types the wrong one.
 */
export function spendWords(
  totals: { dailyBudget: number; spendNowDaily: number },
  confirmation: string | null | undefined,
  money: (n: number) => string,
): { ask: string; differs: string } | null {
  if (!confirmation) return null;
  return {
    ask: `Type ${confirmation}: what can spend in a day once this plan has run.`,
    differs: totals.spendNowDaily !== totals.dailyBudget
      ? `This is not the total daily budget above (${money(totals.dailyBudget)}). That adds up every budget in the plan, on or off; the amount to type counts only what is on once the plan has run, with lifetime budgets counted per day and budget periods at their highest.`
      : "",
  };
}

/** A plan sent back to a draft when its run started (checked again: something changed in Meta since it was
 *  confirmed): the reason (on the first step still to run; step 1 unless a retried plan's earlier steps had
 *  finished), or "". */
export function reopenedReason(view: Pick<PlanView, "status" | "progress">): string {
  if (view.status !== "draft") return "";
  return view.progress.find((p) => /^Not run( at |: )/.test(p.message ?? ""))?.message ?? "";
}
