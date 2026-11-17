import { db, json } from "../db";
import { HttpError } from "../httperror";
import { enqueue } from "../jobs";
import { clientFor } from "../meta/factory";
import { MetaError, plainError } from "../meta/errors";
import { cacheDelete, cacheGet, cacheSet, getAccount } from "../store";
import { DEFAULT_COLUMNS, parseFormula, readInsights, STANDARD_METRICS, type CustomMetric, type InsightsQuery } from "./insights";
import { accountInfo, ADSET_FIELDS, CAMPAIGN_FIELDS, describeAdSet, describeCampaign, isCbo, lookups, type AdSetRow, type CampaignRow } from "./objects";
import { allOptions, fromMinor } from "./options";
import { confirmCheck, getPlan, planProgress, savePlan, summarise, type PlanInput, type PlanRow, type PlanSummary } from "./plan";
import { config } from "../config";

// Campaigns, ad sets, change plans and results: what the app's routes and Claude's tools call.

function account() {
  const acc = getAccount();
  if (!acc?.token_enc) throw new HttpError(409, "Meta is not connected yet. Open Settings → Meta connection and click Connect Meta.");
  return acc;
}

function metaFail(e: unknown, doing: string): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof MetaError) throw new HttpError(502, plainError(e, doing));
  throw e;
}

// ---------- Campaigns and ad sets ----------

export interface TreeAdSet { id: string; name: string; status: string; effectiveStatus: string; dailyBudget: number | null; lifetimeBudget: number | null; details: Record<string, string> }
export interface TreeCampaign { id: string; name: string; status: string; effectiveStatus: string; objective: string; cbo: boolean; dailyBudget: number | null; lifetimeBudget: number | null; details: Record<string, string>; adsets: TreeAdSet[] }

/** Every campaign (not deleted) with its ad sets, budgets and settings in plain words. Cached 2 minutes. */
export async function campaignTree(refresh = false): Promise<{ currency: string; campaigns: TreeCampaign[]; fetchedAt: string }> {
  const acc = account();
  const key = `tree:${acc.id}`;
  if (!refresh) {
    const hit = cacheGet<{ currency: string; campaigns: TreeCampaign[]; fetchedAt: string }>(key);
    if (hit) return hit;
  }
  const client = clientFor(acc.id);
  try {
    const { currency } = await accountInfo(client);
    const live = ["ACTIVE", "PAUSED", "IN_PROCESS", "WITH_ISSUES", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO"];
    const [campaigns, adsets] = await Promise.all([
      client.getAll<CampaignRow>(`${client.accountId}/campaigns`, { fields: CAMPAIGN_FIELDS, effective_status: live }),
      client.getAll<AdSetRow>(`${client.accountId}/adsets`, { fields: ADSET_FIELDS, effective_status: [...live, "CAMPAIGN_PAUSED"] }, 2000),
    ]);
    const out = {
      currency,
      fetchedAt: new Date().toISOString(),
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        effectiveStatus: c.effective_status ?? c.status,
        objective: c.objective ?? "",
        cbo: isCbo(c),
        dailyBudget: fromMinor(c.daily_budget, currency),
        lifetimeBudget: fromMinor(c.lifetime_budget, currency),
        details: describeCampaign(c, currency),
        adsets: adsets
          .filter((a) => a.campaign_id === c.id)
          .map((a) => ({ id: a.id, name: a.name, status: a.status, effectiveStatus: a.effective_status ?? a.status, dailyBudget: fromMinor(a.daily_budget, currency), lifetimeBudget: fromMinor(a.lifetime_budget, currency), details: describeAdSet(a, currency) })),
      })),
    };
    cacheSet(key, out, 2 * 60_000);
    return out;
  } catch (e) {
    metaFail(e, "Reading campaigns");
  }
}

/** One campaign or ad set with every setting (raw Meta fields plus plain words). */
export async function objectDetails(kind: "campaign" | "adset", id: string) {
  const acc = account();
  const client = clientFor(acc.id);
  try {
    const { currency } = await accountInfo(client);
    if (kind === "campaign") {
      const c = await client.get<CampaignRow>(id, { fields: CAMPAIGN_FIELDS });
      return { kind, raw: c, plain: describeCampaign(c, currency), currency };
    }
    const a = await client.get<AdSetRow>(id, { fields: ADSET_FIELDS });
    return { kind, raw: a, plain: describeAdSet(a, currency), currency };
  } catch (e) {
    metaFail(e, `Reading ${kind} ${id}`);
  }
}

export async function lookup(what: string, q?: string) {
  const acc = account();
  try {
    return await lookups(clientFor(acc.id), what, q);
  } catch (e) {
    if (e instanceof Error && !(e instanceof MetaError)) throw new HttpError(400, e.message);
    metaFail(e, `Listing ${what}`);
  }
}

export const options = () => allOptions();

// ---------- Plans ----------

export interface PlanView {
  key: string;
  title: string;
  status: string;
  statusLabel: string;
  canSpend: boolean;
  runAt: string | null;
  summary: PlanSummary | null;
  input: PlanInput;
  progress: { n: number; title: string; status: string; message: string; ids: string[] }[];
  createdBy: string | null;
  source: string;
  createdAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  finishedAt: string | null;
  link: string;
}

const PLAN_LABEL: Record<string, string> = {
  draft: "Waiting for your confirmation",
  queued: "Confirmed, waiting to run",
  running: "Running",
  done: "Done",
  partial: "Some steps failed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function planView(key: string): PlanView {
  const r = getPlan(key);
  const input = JSON.parse(r.ops) as PlanInput;
  const summary = json<PlanSummary | null>(r.summary, null);
  const prog = planProgress(r);
  return {
    key: r.key,
    title: r.title,
    status: r.status,
    statusLabel: r.status === "queued" && r.run_at && Date.parse(r.run_at) > Date.now() ? `Scheduled for ${new Date(r.run_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST` : (PLAN_LABEL[r.status] ?? r.status),
    canSpend: !!r.can_spend,
    runAt: r.run_at,
    summary,
    input,
    progress: input.ops.map((_, i) => ({ n: i + 1, title: summary?.steps.find((s) => s.n === i + 1)?.title ?? input.ops[i].type, status: prog[i]?.status ?? "pending", message: prog[i]?.message ?? "", ids: prog[i]?.ids ?? [] })),
    createdBy: r.created_by,
    source: r.source,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    confirmedBy: r.confirmed_by,
    finishedAt: r.finished_at,
    link: `${config.appUrl}/plans/${r.key}`,
  };
}

function validInput(input: PlanInput): PlanInput {
  if (!input || !Array.isArray(input.ops)) throw new HttpError(400, "A plan needs ops: a list of steps.");
  return { title: input.title, run_at: input.run_at || undefined, expected_daily_total: input.expected_daily_total, ops: input.ops };
}

/** Save a plan and check it (reads Meta, writes nothing). Nothing runs until confirmPlan. */
export async function createPlan(input: PlanInput, who: string, source: "app" | "claude"): Promise<PlanView> {
  const acc = account();
  const clean = validInput(input);
  let summary: PlanSummary;
  try {
    summary = await summarise(clientFor(acc.id), clean, { validate: true });
  } catch (e) {
    metaFail(e, "Checking the plan");
  }
  return planView(savePlan(acc.id, clean, summary, who, source));
}

/** Change a draft plan (new steps or time) and check it again. */
export async function updatePlan(key: string, input: PlanInput): Promise<PlanView> {
  const r = getPlan(key);
  if (r.status !== "draft") throw new HttpError(409, "Only a plan that has not been confirmed can change. Make a new plan instead.");
  const clean = validInput(input);
  let summary: PlanSummary;
  try {
    summary = await summarise(clientFor(r.ad_account_id), clean, { validate: true });
  } catch (e) {
    metaFail(e, "Checking the plan");
  }
  db().prepare("UPDATE plans SET ops = ?, summary = ?, can_spend = ?, run_at = ?, title = COALESCE(NULLIF(?, ''), title), progress = ? WHERE id = ?")
    .run(JSON.stringify(clean), JSON.stringify(summary), summary.canSpend ? 1 : 0, clean.run_at ?? null, clean.title ?? "", JSON.stringify(clean.ops.map(() => ({ status: "pending", ids: [], message: "" }))), r.id);
  return planView(key);
}

/** The explicit yes. A plan that can spend money also needs the total daily budget typed back. */
export async function confirmPlan(key: string, opts: { confirm?: boolean; acceptWarnings?: boolean; spendConfirmation?: string }, who: string): Promise<PlanView> {
  let r = getPlan(key);
  // Check again right before running: budgets or statuses may have changed in Ads Manager since.
  if (r.status === "draft") {
    const input = JSON.parse(r.ops) as PlanInput;
    try {
      const fresh = await summarise(clientFor(r.ad_account_id), input, { validate: false });
      const old = json<PlanSummary | null>(r.summary, null);
      db().prepare("UPDATE plans SET summary = ?, can_spend = ? WHERE id = ?").run(JSON.stringify(fresh), fresh.canSpend ? 1 : 0, r.id);
      if (old && fresh.canSpend && old.spendConfirmation !== fresh.spendConfirmation) {
        throw new HttpError(409, `Budgets changed in Meta since the plan was checked: the total is now ${fresh.spendConfirmation} a day (was ${old.spendConfirmation}). Read the summary again and confirm with the new total.`);
      }
    } catch (e) {
      metaFail(e, "Checking the plan again");
    }
    r = getPlan(key);
  }
  confirmCheck(r, opts);
  const won = db().prepare("UPDATE plans SET status = 'queued', confirmed_at = datetime('now'), confirmed_by = ? WHERE id = ? AND status = 'draft'").run(who, r.id).changes;
  if (!won) throw new HttpError(409, "This plan was confirmed already.");
  enqueue("plan", r.id, r.run_at ? Math.max(Date.now(), Date.parse(r.run_at)) : Date.now());
  cacheDelete("tree:");
  cacheDelete("dest:");
  return planView(key);
}

export function cancelPlan(key: string): PlanView {
  const r = getPlan(key);
  if (!["draft", "queued", "running"].includes(r.status)) throw new HttpError(409, `This plan is already ${PLAN_LABEL[r.status]?.toLowerCase() ?? r.status}.`);
  db().prepare("UPDATE plans SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?").run(r.id);
  db().prepare("UPDATE jobs SET status = 'done', last_error = 'cancelled' WHERE kind = 'plan' AND batch_id = ? AND status = 'queued'").run(r.id);
  return planView(key);
}

export function listPlans(limit = 30) {
  const rows = db().prepare("SELECT * FROM plans ORDER BY id DESC LIMIT ?").all(limit) as PlanRow[];
  return rows.map((r) => {
    const s = json<PlanSummary | null>(r.summary, null);
    return { key: r.key, title: r.title, status: r.status, statusLabel: PLAN_LABEL[r.status] ?? r.status, canSpend: !!r.can_spend, runAt: r.run_at, createdAt: r.created_at, createdBy: r.created_by, source: r.source, dailyBudget: s?.totals.dailyBudget ?? 0, steps: (JSON.parse(r.ops) as PlanInput).ops.length };
  });
}

// ---------- Results ----------

export function customMetrics(): (CustomMetric & { id: number; description: string })[] {
  const acc = account();
  return db().prepare("SELECT id, name, formula, format, description FROM custom_metrics WHERE ad_account_id = ? ORDER BY name").all(acc.id) as (CustomMetric & { id: number; description: string })[];
}

export function saveCustomMetric(m: { id?: number; name: string; formula: string; format?: string; description?: string }) {
  const acc = account();
  if (!m.name?.trim() || !m.formula?.trim()) throw new HttpError(400, "A custom metric needs a name and a formula, e.g. spend / actions:lead.");
  if (/[+\-*/()]/.test(m.name)) throw new HttpError(400, "Leave + - * / and brackets out of the metric's name.");
  try {
    parseFormula(m.formula);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const fmt = ["number", "money", "percent"].includes(m.format ?? "") ? m.format! : "number";
  if (m.id) {
    db().prepare("UPDATE custom_metrics SET name=?, formula=?, format=?, description=? WHERE id=? AND ad_account_id=?").run(m.name.trim(), m.formula.trim(), fmt, m.description ?? "", m.id, acc.id);
    return m.id;
  }
  return Number(db().prepare("INSERT INTO custom_metrics (ad_account_id, name, formula, format, description) VALUES (?,?,?,?,?)").run(acc.id, m.name.trim(), m.formula.trim(), fmt, m.description ?? "").lastInsertRowid);
}

export function columnSets(): { id: number; name: string; metrics: string[]; isDefault: boolean }[] {
  const acc = account();
  const rows = db().prepare("SELECT id, name, metrics, is_default FROM column_sets WHERE ad_account_id = ? ORDER BY is_default DESC, name").all(acc.id) as { id: number; name: string; metrics: string; is_default: number }[];
  const out = rows.map((r) => ({ id: r.id, name: r.name, metrics: JSON.parse(r.metrics) as string[], isDefault: !!r.is_default }));
  if (!out.length) out.push({ id: 0, name: "Standard", metrics: DEFAULT_COLUMNS, isDefault: true });
  return out;
}

export function saveColumnSet(c: { id?: number; name: string; metrics: string[]; isDefault?: boolean }) {
  const acc = account();
  if (!c.name?.trim()) throw new HttpError(400, "Give the column set a name.");
  if (!c.metrics?.length) throw new HttpError(400, "Pick at least one metric.");
  const known = new Set([...STANDARD_METRICS.map((m) => m.key), ...customMetrics().map((m) => m.name.toLowerCase())]);
  const bad = c.metrics.filter((m) => !known.has(m) && !known.has(m.toLowerCase()) && !/^(actions|cost):[\w.]+$/.test(m));
  if (bad.length) throw new HttpError(400, `Unknown metric${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}.`);
  return db().transaction(() => {
    if (c.isDefault) db().prepare("UPDATE column_sets SET is_default = 0 WHERE ad_account_id = ?").run(acc.id);
    if (c.id) {
      db().prepare("UPDATE column_sets SET name=?, metrics=?, is_default=COALESCE(?, is_default) WHERE id=? AND ad_account_id=?").run(c.name.trim(), JSON.stringify(c.metrics), c.isDefault === undefined ? null : c.isDefault ? 1 : 0, c.id, acc.id);
      return c.id;
    }
    return Number(db().prepare("INSERT INTO column_sets (ad_account_id, name, metrics, is_default) VALUES (?,?,?,?)").run(acc.id, c.name.trim(), JSON.stringify(c.metrics), c.isDefault ? 1 : 0).lastInsertRowid);
  })();
}

export function deleteResultsItem(kind: "column_set" | "custom_metric", id: number) {
  const acc = account();
  db().prepare(`DELETE FROM ${kind === "column_set" ? "column_sets" : "custom_metrics"} WHERE id = ? AND ad_account_id = ?`).run(id, acc.id);
}

export async function results(q: InsightsQuery & { column_set?: string }) {
  const acc = account();
  let metrics = q.metrics;
  if (!metrics?.length && q.column_set) {
    const set = columnSets().find((s) => s.name.toLowerCase() === q.column_set!.toLowerCase() || String(s.id) === q.column_set);
    if (!set) throw new HttpError(400, `No column set called "${q.column_set}".`);
    metrics = set.metrics;
  }
  if (!metrics?.length) metrics = columnSets().find((s) => s.isDefault)?.metrics;
  try {
    const client = clientFor(acc.id);
    const { currency } = await accountInfo(client);
    return { currency, ...(await readInsights(client, { ...q, metrics }, customMetrics())) };
  } catch (e) {
    if (e instanceof Error && !(e instanceof MetaError) && !(e instanceof HttpError)) throw new HttpError(400, e.message);
    metaFail(e, "Reading results");
  }
}

export function metricsCatalog() {
  return { standard: STANDARD_METRICS, custom: customMetrics(), columnSets: columnSets(), note: "Any Meta action works as actions:<action_type> (count) or cost:<action_type> (cost per action), e.g. actions:offsite_conversion.fb_pixel_custom." };
}
