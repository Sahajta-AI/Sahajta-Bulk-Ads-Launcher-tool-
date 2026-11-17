import { createHash, randomBytes } from "node:crypto";
import { db, json } from "../db";
import { HttpError } from "../httperror";
import { renderName } from "../engine/naming";
import { DeletionRefused, type MetaClient } from "../meta/client";
import { MetaError, plainError } from "../meta/errors";
import type { Clock } from "../meta/pacer";
import type { Check } from "../types";
import {
  accountInfo,
  adSetAds,
  adsetCloneParams,
  adsetParams,
  campaignAdSets,
  campaignParams,
  describeAdSet,
  describeCampaign,
  getAdSet,
  getCampaign,
  isCbo,
  istTime,
  touchesAudience,
  type AdSetRow,
  type AdSetSpec,
  type CampaignRow,
  type CampaignSpec,
  type Targeting,
} from "./objects";
import { BID_STRATEGIES, fromMinor, money, OBJECTIVES } from "./options";

// Change plans: every change to campaigns, ad sets and ad status goes through one plan.
//   1. createPlan: the list of steps is saved and checked. Reads Meta (never writes), builds the
//      pre-launch summary (every budget, the total, schedule, audience, placements), warns about
//      unusual budgets, and asks Meta to validate the first create of each kind (validate_only).
//   2. confirmPlan: needs confirm: true; when the plan can make Meta spend money, also the total
//      daily budget typed back exactly as the summary shows it. Nothing runs without this.
//   3. The worker runs the steps in order, paced, saving every new ID as it goes, so a restart
//      continues where it stopped and never creates anything twice.
// Nothing is ever deleted or archived (MetaClient refuses it).

export type StatusValue = "PAUSED" | "ACTIVE";

export type Op =
  | ({ type: "create_campaign"; ref?: string } & CampaignSpec)
  | ({ type: "edit_campaign"; campaign: string } & CampaignSpec)
  | { type: "duplicate_campaign"; campaign: string; ref?: string; copies?: number; with_contents?: boolean; changes?: CampaignSpec[]; name_template?: string; persona?: string }
  | ({ type: "create_adset"; ref?: string; campaign: string } & AdSetSpec)
  | ({ type: "edit_adset"; adset: string } & AdSetSpec)
  | { type: "duplicate_adset"; adset: string; ref?: string; campaign?: string; copies?: number; with_ads?: boolean; changes?: AdSetSpec[]; name_template?: string; persona?: string }
  | { type: "ads_from_post"; post_id: string; source?: "facebook" | "instagram"; adsets: string[]; name?: string; name_template?: string; page_id?: string; instagram_user_id?: string; status?: StatusValue }
  | { type: "set_status"; status: StatusValue; campaigns?: string[]; adsets?: string[]; ads?: string[]; whole_campaigns?: string[] };

export interface PlanInput {
  title?: string;
  /** ISO time to run at (e.g. 2026-11-20T09:00:00+05:30). Empty = as soon as confirmed. */
  run_at?: string;
  /** The total daily budget the person planned, if they said one. The check warns when the plan differs. */
  expected_daily_total?: number;
  ops: Op[];
}

export interface SummaryAdSet {
  step: number;
  name: string;
  campaign: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  details: Record<string, string>;
}

export interface PlanSummary {
  account: { id: string; name: string; currency: string };
  runAt: string | null;
  steps: { n: number; title: string; lines: string[] }[];
  adsets: SummaryAdSet[];
  totals: { campaigns: number; adsets: number; ads: number; dailyBudget: number; lifetimeBudget: number; spendNowDaily: number; turnsOn: string[] };
  checks: Check[];
  errors: number;
  warnings: number;
  canSpend: boolean;
  /** What the person types back to confirm a plan that can spend, e.g. "₹15,000". */
  spendConfirmation: string | null;
}

export interface PlanProgress {
  status: "pending" | "running" | "done" | "failed" | "skipped";
  ids: string[];
  message: string;
  /** Items started but not saved (a crash may have created them): looked up before creating again. */
  attempted?: number[];
}

export interface PlanRow {
  id: number;
  key: string;
  ad_account_id: number;
  title: string;
  status: string;
  ops: string;
  summary: string | null;
  can_spend: number;
  run_at: string | null;
  progress: string;
  created_by: string | null;
  source: string;
  created_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  finished_at: string | null;
}

/** Daily budget above this (account currency) gets a warning. Change with BUDGET_WARN_DAILY in .env. */
export const budgetWarnDaily = () => Number(process.env.BUDGET_WARN_DAILY || 10000);
export const MAX_COPIES = 200;
export const MAX_OPS = 300;

// ---------- Helpers ----------

const isRef = (s: string | undefined) => !!s && s.startsWith("$");
const refName = (s: string) => s.replace(/^\$/, "").split(".")[0];

function newKey(): string {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  for (;;) {
    const k = "p" + Array.from(randomBytes(4), (b) => a[b % a.length]).join("");
    if (!db().prepare("SELECT 1 FROM plans WHERE key = ?").get(k)) return k;
  }
}

export function idemKey(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function copiesOf(op: { copies?: number; changes?: unknown[] }): number {
  return Math.max(op.changes?.length ?? 0, op.copies ?? (op.changes?.length ? 0 : 1));
}

function nameFor(pattern: string | undefined, fallback: string, ctx: { n: number; persona?: string; angle?: string; campaign?: string; objective?: string; budget?: number | null; adset?: string }): string {
  if (!pattern) return fallback;
  return renderName(pattern, {
    date: new Date(),
    n: ctx.n,
    persona: ctx.persona ?? "",
    angle: ctx.angle ?? "",
    campaign: ctx.campaign ?? "",
    adset: ctx.adset ?? "",
    objective: (ctx.objective ?? "").replace(/^OUTCOME_/, ""),
    budget: ctx.budget ? String(ctx.budget) : "",
  }).slice(0, 380);
}

const needsBid = (s?: string) => s === "COST_CAP" || s === "LOWEST_COST_WITH_BID_CAP";

// ---------- The world as the plan sees it (for the summary) ----------

interface WCampaign { id: string; name: string; status: string; cbo: boolean; daily: number | null; lifetime: number | null; objective?: string; virtual: boolean }
interface WAdSet { id: string; name: string; status: string; campaignId: string; daily: number | null; lifetime: number | null; virtual: boolean }

class World {
  campaigns = new Map<string, WCampaign>();
  adsets = new Map<string, WAdSet>();
  refs = new Map<string, string[]>();
  loadedTrees = new Set<string>();
  constructor(private client: MetaClient, private currency: string) {}

  async campaign(id: string): Promise<WCampaign> {
    const hit = this.campaigns.get(id);
    if (hit) return hit;
    const c = await getCampaign(this.client, id);
    const w: WCampaign = { id, name: c.name, status: c.status, cbo: isCbo(c), daily: fromMinor(c.daily_budget, this.currency), lifetime: fromMinor(c.lifetime_budget, this.currency), objective: c.objective, virtual: false };
    this.campaigns.set(id, w);
    return w;
  }

  async adset(id: string): Promise<{ w: WAdSet; row: AdSetRow | null }> {
    const hit = this.adsets.get(id);
    if (hit) return { w: hit, row: null };
    const a = await getAdSet(this.client, id);
    const w: WAdSet = { id, name: a.name, status: a.status, campaignId: a.campaign_id, daily: fromMinor(a.daily_budget, this.currency), lifetime: fromMinor(a.lifetime_budget, this.currency), virtual: false };
    this.adsets.set(id, w);
    return { w, row: a };
  }

  /** Every ad set of a campaign (for "what can spend once this campaign is on"). */
  async tree(campaignId: string) {
    if (this.loadedTrees.has(campaignId) || isRef(campaignId) || this.campaigns.get(campaignId)?.virtual) return;
    this.loadedTrees.add(campaignId);
    for (const a of await campaignAdSets(this.client, campaignId)) {
      if (!this.adsets.has(a.id)) this.adsets.set(a.id, { id: a.id, name: a.name, status: a.status, campaignId, daily: fromMinor(a.daily_budget, this.currency), lifetime: fromMinor(a.lifetime_budget, this.currency), virtual: false });
    }
  }

  /** Daily budget that can spend: active campaigns × their active ad sets. */
  spendDaily(): { total: number; lines: string[] } {
    let total = 0;
    const lines: string[] = [];
    for (const c of this.campaigns.values()) {
      if (c.status !== "ACTIVE") continue;
      const on = [...this.adsets.values()].filter((a) => a.campaignId === c.id && a.status === "ACTIVE");
      if (!on.length) continue;
      if (c.cbo) {
        total += c.daily ?? 0;
        lines.push(`${c.name}: ${c.daily ? `${money(c.daily, this.currency)} a day` : `${money(c.lifetime, this.currency)} lifetime`} (campaign budget, ${on.length} ad set${on.length > 1 ? "s" : ""} on)`);
      } else {
        for (const a of on) {
          total += a.daily ?? 0;
          lines.push(`${c.name} → ${a.name}: ${a.daily ? `${money(a.daily, this.currency)} a day` : `${money(a.lifetime, this.currency)} lifetime`}`);
        }
      }
    }
    return { total, lines };
  }
}

// ---------- Check and summary ----------

/** Read Meta and describe what the plan will do. Writes nothing to Meta except validate_only checks. */
export async function summarise(client: MetaClient, input: PlanInput, opts: { validate?: boolean } = {}): Promise<PlanSummary> {
  const info = await accountInfo(client);
  const cur = info.currency;
  const world = new World(client, cur);
  const steps: PlanSummary["steps"] = [];
  const adsets: SummaryAdSet[] = [];
  const checks: Check[] = [];
  const turnsOn: string[] = [];
  let campaignsN = 0;
  let adsN = 0;
  let newAdsets = 0;
  const cboOn = new Set<string>(); // existing campaign-budget campaigns this plan turns on
  let canSpend = false;
  const validated = new Set<string>();
  const err = (n: number, message: string) => checks.push({ level: "error", code: "plan", message: `Step ${n}: ${message}` });
  const warn = (n: number, message: string) => checks.push({ level: "warning", code: "plan", message: `Step ${n}: ${message}` });
  const m = (v: number | null | undefined) => money(v ?? null, cur);

  if (!input.ops?.length) checks.push({ level: "error", code: "plan_empty", message: "The plan has no steps." });
  if ((input.ops?.length ?? 0) > MAX_OPS) checks.push({ level: "error", code: "plan_big", message: `At most ${MAX_OPS} steps in one plan. Split it.` });
  if (input.run_at && Number.isNaN(Date.parse(input.run_at))) checks.push({ level: "error", code: "run_at", message: `"${input.run_at}" is not a date and time. Use e.g. 2026-11-20T09:00:00+05:30.` });
  else if (input.run_at && Date.parse(input.run_at) < Date.now() - 60_000) checks.push({ level: "error", code: "run_at", message: `The start time ${istTime(input.run_at)} is in the past.` });

  // Spend before the plan, for the campaigns it touches (filled as we go).
  const before = new Map<string, string>();
  const remember = (map: Map<string, { status: string }>, id: string) => { if (!before.has(id)) before.set(id, map.get(id)?.status ?? ""); };

  async function resolveCampaign(n: number, ref: string): Promise<WCampaign | null> {
    if (isRef(ref)) {
      const id = world.refs.get(refName(ref))?.[0];
      if (!id) { err(n, `"${ref}" doesn't name an earlier step's ref.`); return null; }
      return world.campaigns.get(id) ?? null;
    }
    try { return await world.campaign(ref); } catch (e) { err(n, `campaign ${ref} not found in this ad account (${e instanceof Error ? e.message : e}).`); return null; }
  }

  async function resolveAdsets(n: number, list: string[]): Promise<WAdSet[]> {
    const out: WAdSet[] = [];
    for (const r of list) {
      if (isRef(r)) {
        const got = world.refs.get(refName(r));
        if (!got) { err(n, `"${r}" doesn't name an earlier step's ref.`); continue; }
        for (const id of got) { const a = world.adsets.get(id); if (a) out.push(a); }
        continue;
      }
      try { out.push((await world.adset(r)).w); } catch { err(n, `ad set ${r} not found in this ad account.`); }
    }
    return out;
  }

  async function validate(kind: string, path: string, params: Record<string, unknown>, n: number) {
    if (!opts.validate || validated.has(kind) || validated.size >= 4) return;
    validated.add(kind);
    try {
      await client.post(path, { ...params, execution_options: ["validate_only"] });
    } catch (e) {
      if (e instanceof MetaError && !e.isTransient) err(n, `Meta's own check refused it. ${plainError(e, "Checking")}`);
    }
  }

  function budgetChecks(n: number, what: string, daily: number | null | undefined) {
    if (daily && daily > budgetWarnDaily()) warn(n, `${what} has a daily budget of ${m(daily)}, above the usual limit of ${m(budgetWarnDaily())}. Make sure this is right.`);
  }

  let n = 0;
  for (const op of input.ops ?? []) {
    n++;
    const lines: string[] = [];
    let title = "";
    try {
      switch (op.type) {
        case "create_campaign": {
          campaignsN++;
          const name = nameFor(op.name_template, op.name ?? "", { n, persona: op.persona, angle: op.angle, objective: op.objective, budget: op.daily_budget ?? op.lifetime_budget });
          title = `Create campaign "${name || "(no name)"}"`;
          if (!name) err(n, "the campaign needs a name or a name template.");
          if (!op.objective || !OBJECTIVES.some((o) => o.value === op.objective)) err(n, `objective must be one of ${OBJECTIVES.map((o) => o.value).join(", ")}.`);
          const cbo = op.budget_level === "campaign" || op.daily_budget !== undefined || op.lifetime_budget !== undefined;
          if (op.budget_level === "campaign" && op.daily_budget === undefined && op.lifetime_budget === undefined) err(n, "a campaign budget (CBO) needs daily_budget or lifetime_budget.");
          if (op.daily_budget !== undefined && op.lifetime_budget !== undefined) err(n, "give daily_budget or lifetime_budget, not both.");
          if (op.lifetime_budget !== undefined && !op.stop_time) err(n, "a lifetime budget needs stop_time.");
          if (op.bid_strategy && !BID_STRATEGIES.some((b) => b.value === op.bid_strategy)) err(n, `unknown bid strategy ${op.bid_strategy}.`);
          const id = `$${op.ref ?? `step${n}`}`;
          world.campaigns.set(id, { id, name, status: op.status ?? "PAUSED", cbo, daily: op.daily_budget ?? null, lifetime: op.lifetime_budget ?? null, objective: op.objective, virtual: true });
          world.refs.set(op.ref ?? `step${n}`, [id]);
          const d = describeCampaign({ objective: op.objective, daily_budget: op.daily_budget !== undefined ? String(op.daily_budget * 100) : undefined, lifetime_budget: op.lifetime_budget !== undefined ? String(op.lifetime_budget * 100) : undefined, bid_strategy: op.bid_strategy, special_ad_categories: op.special_ad_categories?.filter((c) => c !== "NONE"), status: op.status ?? "PAUSED", spend_cap: op.spend_cap !== undefined ? String(op.spend_cap * 100) : undefined }, "INR");
          lines.push(`Objective: ${d.objective}. Budget: ${cbo ? (op.daily_budget ? `${m(op.daily_budget)} a day (campaign budget)` : `${m(op.lifetime_budget)} lifetime (campaign budget)`) : "on each ad set"}. Bid: ${d.bid}. Special ad category: ${d.specialCategories}. Spend limit: ${op.spend_cap ? m(op.spend_cap) : "none"}.`);
          lines.push(`Created ${op.status === "ACTIVE" ? "ON" : "paused"}.`);
          if (cbo) budgetChecks(n, `Campaign "${name}"`, op.daily_budget);
          if (op.status === "ACTIVE") { canSpend = true; turnsOn.push(`campaign "${name}"`); }
          await validate("campaign", `${client.accountId}/campaigns`, { ...campaignParams({ ...op, name: name || "validate" }, cur, true), status: "PAUSED" }, n);
          break;
        }
        case "edit_campaign": {
          const c = await resolveCampaign(n, op.campaign);
          if (!c) break;
          title = `Edit campaign "${c.name}"`;
          const changes: string[] = [];
          if (op.name) changes.push(`name → "${op.name}"`);
          if (op.daily_budget !== undefined) {
            if (!c.cbo) err(n, `"${c.name}" has no campaign budget (budgets are on its ad sets). Edit the ad sets instead.`);
            changes.push(`daily budget ${m(c.daily)} → ${m(op.daily_budget)}`);
            if (c.status === "ACTIVE" && op.daily_budget > (c.daily ?? 0)) canSpend = true;
            budgetChecks(n, `Campaign "${c.name}"`, op.daily_budget);
            c.daily = op.daily_budget;
          }
          if (op.lifetime_budget !== undefined) { changes.push(`lifetime budget ${m(c.lifetime)} → ${m(op.lifetime_budget)}`); if (c.status === "ACTIVE") canSpend = true; c.lifetime = op.lifetime_budget; }
          if (op.bid_strategy) changes.push(`bid strategy → ${op.bid_strategy}`);
          if (op.spend_cap !== undefined) changes.push(`spend limit → ${m(op.spend_cap)}`);
          if (op.stop_time) changes.push(`end → ${istTime(op.stop_time)}`);
          if (op.status) { changes.push(`status → ${op.status}`); if (op.status === "ACTIVE") { canSpend = true; turnsOn.push(`campaign "${c.name}"`); await world.tree(c.id); } c.status = op.status; }
          if (!changes.length) err(n, "nothing to change.");
          lines.push(changes.join("; "));
          if (!c.virtual) await validate("edit_campaign", c.id, campaignParams(op, cur, false), n);
          break;
        }
        case "duplicate_campaign": {
          const c = await resolveCampaign(n, op.campaign);
          if (!c) break;
          const count = copiesOf(op);
          if (count < 1 || count > MAX_COPIES) { err(n, `copies must be between 1 and ${MAX_COPIES}.`); break; }
          title = `Copy campaign "${c.name}" ${count} time${count > 1 ? "s" : ""}${op.with_contents ? " with its ad sets and ads" : " (campaign only)"}`;
          const srcAdsets = op.with_contents ? (await campaignAdSets(client, c.id)) : [];
          const ids: string[] = [];
          for (let j = 0; j < count; j++) {
            const ch = op.changes?.[j] ?? {};
            const name = ch.name ?? nameFor(op.name_template ?? ch.name_template, `${c.name} - copy ${j + 1}`, { n: j + 1, persona: op.persona ?? ch.persona, objective: c.objective, budget: ch.daily_budget ?? c.daily });
            const id = `$${op.ref ?? `step${n}`}.${j}`;
            ids.push(id);
            campaignsN++;
            const daily = ch.daily_budget ?? c.daily;
            world.campaigns.set(id, { ...c, id, name, status: ch.status ?? "PAUSED", daily, lifetime: ch.lifetime_budget ?? c.lifetime, virtual: true });
            const changed = Object.entries(ch).filter(([k]) => k !== "name").map(([k, v]) => `${k} → ${String(v)}`);
            lines.push(`Copy ${j + 1}: "${name}"${changed.length ? `, ${changed.join(", ")}` : ", same settings"}${ch.status === "ACTIVE" ? ", turned ON" : ", paused"}.`);
            if (c.cbo) budgetChecks(n, `Copy "${name}"`, daily);
            if (ch.status === "ACTIVE") { canSpend = true; turnsOn.push(`campaign "${name}"`); }
            for (const a of srcAdsets) {
              const vid = `${id}/${a.id}`;
              const d = describeAdSet(a, cur);
              world.adsets.set(vid, { id: vid, name: a.name, status: "PAUSED", campaignId: id, daily: fromMinor(a.daily_budget, cur), lifetime: fromMinor(a.lifetime_budget, cur), virtual: true });
              newAdsets++;
              adsets.push({ step: n, name: `${a.name} (in ${name})`, campaign: name, dailyBudget: fromMinor(a.daily_budget, cur), lifetimeBudget: fromMinor(a.lifetime_budget, cur), details: { ...d, status: "PAUSED" } });
            }
          }
          if (op.with_contents) lines.push(`Each copy gets ${srcAdsets.length} ad set${srcAdsets.length === 1 ? "" : "s"} and their ads, all paused.`);
          world.refs.set(op.ref ?? `step${n}`, ids);
          break;
        }
        case "create_adset": {
          const c = await resolveCampaign(n, op.campaign);
          if (!c) break;
          const name = op.name || nameFor(op.name_template, "", { n, persona: op.persona, angle: op.angle, campaign: c.name, budget: op.daily_budget ?? op.lifetime_budget });
          title = `Create ad set "${name || "(no name)"}" in "${c.name}"`;
          if (!name) err(n, "the ad set needs a name or a name template.");
          adsetBudgetRules(n, op, c, err);
          if (!op.goal) err(n, "say what to optimise for (goal), e.g. LEAD_GENERATION or OFFSITE_CONVERSIONS.");
          if (needsBid(op.bid_strategy) && op.bid_amount === undefined) err(n, `${op.bid_strategy} needs bid_amount.`);
          if (op.lifetime_budget !== undefined && !op.end_time) err(n, "a lifetime budget needs end_time.");
          if (op.goal === "OFFSITE_CONVERSIONS" && !op.pixel_id && !op.custom_conversion_id && !op.app_id) err(n, "conversions need pixel_id and event (or custom_conversion_id).");
          let saved: Targeting | undefined;
          if (op.saved_audience_id) saved = (await client.get<{ targeting?: Targeting }>(op.saved_audience_id, { fields: "targeting" })).targeting;
          const params = adsetParams({ ...op, name }, cur, { forCreate: true, savedAudience: saved });
          const id = `$${op.ref ?? `step${n}`}`;
          world.adsets.set(id, { id, name, status: op.status ?? "PAUSED", campaignId: c.id, daily: op.daily_budget ?? null, lifetime: op.lifetime_budget ?? null, virtual: true });
          world.refs.set(op.ref ?? `step${n}`, [id]);
          const d = describeAdSet({ ...(params as Partial<AdSetRow>), daily_budget: params.daily_budget as string | undefined, lifetime_budget: params.lifetime_budget as string | undefined, bid_amount: params.bid_amount as string | undefined }, cur);
          newAdsets++;
          adsets.push({ step: n, name, campaign: c.name, dailyBudget: op.daily_budget ?? null, lifetimeBudget: op.lifetime_budget ?? null, details: d });
          lines.push(`${d.budget}; ${d.bid}; ${d.schedule}. Goal: ${d.goal}. Audience: ${d.audience}. Placements: ${d.placements}.${op.saved_audience_id ? ` Saved audience ${op.saved_audience_id}.` : ""} Created ${op.status === "ACTIVE" ? "ON" : "paused"}.`);
          budgetChecks(n, `Ad set "${name}"`, op.daily_budget);
          if (op.status === "ACTIVE") { canSpend = true; turnsOn.push(`ad set "${name}"`); await world.tree(c.id); }
          if (!c.virtual) await validate("adset", `${client.accountId}/adsets`, { ...params, campaign_id: c.id, status: "PAUSED" }, n);
          break;
        }
        case "edit_adset": {
          let got: { w: WAdSet; row: AdSetRow | null };
          try { got = await world.adset(op.adset); } catch { err(n, `ad set ${op.adset} not found.`); break; }
          const a = got.w;
          const row = got.row ?? (a.virtual ? null : await getAdSet(client, a.id));
          title = `Edit ad set "${a.name}"`;
          const c = a.virtual ? world.campaigns.get(a.campaignId) : await world.campaign(a.campaignId).catch(() => undefined);
          const changes: string[] = [];
          if (op.name) changes.push(`name → "${op.name}"`);
          if (op.daily_budget !== undefined) {
            if (c?.cbo) err(n, `"${a.name}" is in a campaign-budget campaign; change the campaign's budget instead.`);
            changes.push(`daily budget ${m(a.daily)} → ${m(op.daily_budget)}`);
            budgetChecks(n, `Ad set "${a.name}"`, op.daily_budget);
            if (a.status === "ACTIVE" && op.daily_budget > (a.daily ?? 0)) canSpend = true;
            a.daily = op.daily_budget;
          }
          if (op.lifetime_budget !== undefined) { changes.push(`lifetime budget ${m(a.lifetime)} → ${m(op.lifetime_budget)}`); if (a.status === "ACTIVE") canSpend = true; a.lifetime = op.lifetime_budget; }
          if (op.bid_strategy || op.bid_amount !== undefined) changes.push(`bid → ${op.bid_strategy ?? row?.bid_strategy ?? ""}${op.bid_amount !== undefined ? ` ${m(op.bid_amount)}` : ""}`);
          if (needsBid(op.bid_strategy) && op.bid_amount === undefined && !row?.bid_amount) err(n, `${op.bid_strategy} needs bid_amount.`);
          if (op.start_time) changes.push(`start → ${istTime(op.start_time)}`);
          if (op.end_time) changes.push(`end → ${istTime(op.end_time)}`);
          if (op.goal || op.destination || op.event || op.pixel_id) changes.push(`goal → ${[op.destination, op.goal, op.event].filter(Boolean).join(" / ")}`);
          if (touchesAudience(op)) {
            const params = adsetParams(op, cur, { current: row ?? undefined, forCreate: false });
            const d = describeAdSet({ targeting: params.targeting as Targeting }, cur);
            changes.push(`audience → ${d.audience}; placements → ${d.placements}`);
          }
          if (op.attribution) changes.push(`attribution → ${op.attribution}`);
          if (op.min_daily_spend !== undefined || op.max_daily_spend !== undefined) changes.push(`spend limits → min ${m(op.min_daily_spend)}, max ${m(op.max_daily_spend)}`);
          if (op.status) { changes.push(`status → ${op.status}`); if (op.status === "ACTIVE") { canSpend = true; turnsOn.push(`ad set "${a.name}"`); if (c) await world.tree(c.id); } a.status = op.status; }
          if (!changes.length) err(n, "nothing to change.");
          lines.push(changes.join("; "));
          adsets.push({ step: n, name: op.name ?? a.name, campaign: c?.name ?? "", dailyBudget: a.daily, lifetimeBudget: a.lifetime, details: { change: changes.join("; ") } });
          if (!a.virtual) await validate("edit_adset", a.id, adsetParams(op, cur, { current: row ?? undefined, forCreate: false }), n);
          break;
        }
        case "duplicate_adset": {
          let src: AdSetRow;
          try { src = await getAdSet(client, op.adset); } catch { err(n, `ad set ${op.adset} not found.`); break; }
          await world.adset(src.id).catch(() => undefined);
          const target = op.campaign ? await resolveCampaign(n, op.campaign) : await world.campaign(src.campaign_id);
          if (!target) break;
          const count = copiesOf(op);
          if (count < 1 || count > MAX_COPIES) { err(n, `copies must be between 1 and ${MAX_COPIES}.`); break; }
          title = `Copy ad set "${src.name}" ${count} time${count > 1 ? "s" : ""} into "${target.name}"${op.with_ads ? " with its ads" : ""}`;
          const ids: string[] = [];
          for (let j = 0; j < count; j++) {
            const ch = op.changes?.[j] ?? {};
            const daily = target.cbo ? null : ch.daily_budget ?? fromMinor(src.daily_budget, cur);
            const lifetime = target.cbo ? null : ch.lifetime_budget ?? fromMinor(src.lifetime_budget, cur);
            const name = ch.name ?? nameFor(ch.name_template ?? op.name_template, `${src.name} - copy ${j + 1}`, { n: j + 1, persona: ch.persona ?? op.persona, angle: ch.angle, campaign: target.name, budget: daily ?? lifetime, adset: src.name });
            if (target.cbo && (ch.daily_budget !== undefined || ch.lifetime_budget !== undefined)) err(n, `copy ${j + 1}: "${target.name}" uses a campaign budget, so its ad sets can't have their own budget.`);
            if (!target.cbo && !daily && !lifetime) err(n, `copy ${j + 1}: needs a daily or lifetime budget (the campaign has no campaign budget).`);
            if (needsBid(ch.bid_strategy) && ch.bid_amount === undefined) err(n, `copy ${j + 1}: ${ch.bid_strategy} needs bid_amount.`);
            const id = `$${op.ref ?? `step${n}`}.${j}`;
            ids.push(id);
            world.adsets.set(id, { id, name, status: ch.status ?? "PAUSED", campaignId: target.id, daily, lifetime, virtual: true });
            const merged = adsetParams(ch, cur, { current: src, forCreate: false });
            const d = describeAdSet({ ...src, ...(merged as Partial<AdSetRow>), daily_budget: daily !== null ? String(daily * 100) : undefined, lifetime_budget: lifetime !== null ? String(lifetime * 100) : undefined }, cur);
            newAdsets++;
            adsets.push({ step: n, name, campaign: target.name, dailyBudget: daily, lifetimeBudget: lifetime, details: d });
            const changed = Object.keys(ch).filter((k) => k !== "name" && k !== "name_template");
            lines.push(`Copy ${j + 1}: "${name}": ${d.budget}; ${d.bid}${changed.length ? ` (changed: ${changed.join(", ")})` : " (same settings)"}${ch.status === "ACTIVE" ? ", turned ON" : ", paused"}.`);
            budgetChecks(n, `Copy "${name}"`, daily);
            if (ch.status === "ACTIVE") { canSpend = true; turnsOn.push(`ad set "${name}"`); }
          }
          if (ids.some((id) => world.adsets.get(id)?.status === "ACTIVE")) await world.tree(target.id);
          const d0 = describeAdSet(src, cur);
          lines.push(`Template settings: goal ${d0.goal}; audience ${d0.audience}; placements ${d0.placements}; ${d0.schedule}.`);
          if (Number(src.daily_min_spend_target) || Number(src.daily_spend_cap)) lines.push("The template has ad set spend limits; copies into a campaign-budget campaign are made without them if Meta refuses them.");
          world.refs.set(op.ref ?? `step${n}`, ids);
          break;
        }
        case "ads_from_post": {
          const targets = await resolveAdsets(n, op.adsets ?? []);
          title = `Ads from existing post ${op.post_id} in ${targets.length} ad set${targets.length === 1 ? "" : "s"}`;
          if (!op.post_id) err(n, "give post_id.");
          if (!targets.length) err(n, "give at least one ad set.");
          adsN += targets.length;
          lines.push(`One creative from ${op.source === "instagram" ? "Instagram post" : "Facebook post"} ${op.post_id}, so likes, comments and shares add up on that one post. Ad sets: ${targets.map((a) => `"${a.name}"`).join(", ")}. Ads created ${op.status === "ACTIVE" ? "ON" : "paused"}.`);
          if (op.status === "ACTIVE") { canSpend = true; turnsOn.push(`${targets.length} ad${targets.length > 1 ? "s" : ""} from post ${op.post_id}`); }
          break;
        }
        case "set_status": {
          const on = op.status === "ACTIVE";
          const parts: string[] = [];
          for (const id of op.whole_campaigns ?? []) {
            const c = await resolveCampaign(n, id);
            if (!c) continue;
            await world.tree(c.id);
            const sets = [...world.adsets.values()].filter((a) => a.campaignId === c.id);
            let adCount = 0;
            for (const a of sets) if (!a.virtual) adCount += (await adSetAds(client, a.id)).length;
            remember(world.campaigns, c.id);
            c.status = op.status;
            if (on && c.cbo) cboOn.add(c.id);
            for (const a of sets) a.status = op.status;
            parts.push(`whole campaign "${c.name}": the campaign, ${sets.length} ad set${sets.length === 1 ? "" : "s"} and ${adCount} ad${adCount === 1 ? "" : "s"}`);
            if (on) turnsOn.push(`campaign "${c.name}" with ${sets.length} ad sets and ${adCount} ads`);
            for (const a of sets) adsets.push({ step: n, name: a.name, campaign: c.name, dailyBudget: c.cbo ? null : a.daily, lifetimeBudget: c.cbo ? null : a.lifetime, details: { status: op.status } });
          }
          for (const id of op.campaigns ?? []) {
            const c = await resolveCampaign(n, id);
            if (!c) continue;
            remember(world.campaigns, c.id);
            c.status = op.status;
            if (on && c.cbo) cboOn.add(c.id);
            if (on) { await world.tree(c.id); turnsOn.push(`campaign "${c.name}"`); }
            parts.push(`campaign "${c.name}"`);
          }
          for (const a of await resolveAdsets(n, op.adsets ?? [])) {
            a.status = op.status;
            if (on) { turnsOn.push(`ad set "${a.name}"`); await world.campaign(a.campaignId).catch(() => undefined); }
            parts.push(`ad set "${a.name}"`);
            adsets.push({ step: n, name: a.name, campaign: world.campaigns.get(a.campaignId)?.name ?? "", dailyBudget: a.daily, lifetimeBudget: a.lifetime, details: { status: op.status } });
          }
          if (op.ads?.length) { parts.push(`${op.ads.length} ad${op.ads.length > 1 ? "s" : ""}`); if (on) turnsOn.push(`${op.ads.length} ad${op.ads.length > 1 ? "s" : ""}`); }
          title = `Turn ${on ? "ON" : "off"}: ${parts.join(", ") || "nothing"}`;
          if (!parts.length) err(n, "name what to turn on or off (campaigns, adsets, ads or whole_campaigns).");
          if (on) canSpend = true;
          lines.push(on ? "Turning on lets Meta spend the budgets below." : "Turning off stops spending. Nothing is deleted.");
          break;
        }
        default:
          err(n, `unknown step type "${(op as { type?: string }).type}". Use create_campaign, edit_campaign, duplicate_campaign, create_adset, edit_adset, duplicate_adset, ads_from_post or set_status.`);
      }
    } catch (e) {
      if (e instanceof DeletionRefused) err(n, e.message);
      else err(n, e instanceof MetaError ? plainError(e, "Reading Meta") : e instanceof Error ? e.message : String(e));
    }
    if ((op as { status?: string }).status && !["ACTIVE", "PAUSED"].includes(String((op as { status?: string }).status))) err(n, `status must be ACTIVE or PAUSED. Deleting or archiving is not possible in the launcher.`);
    steps.push({ n, title: title || op.type, lines });
  }

  // Budgets across the plan.
  const dailies = adsets.map((a) => a.dailyBudget).filter((x): x is number => !!x);
  const cboDaily = [...world.campaigns.values()].filter((c) => c.cbo && (c.virtual || cboOn.has(c.id))).reduce((s, c) => s + (c.daily ?? 0), 0);
  const dailyTotal = dailies.reduce((s, x) => s + x, 0) + cboDaily;
  const lifetimeTotal = adsets.reduce((s, a) => s + (a.lifetimeBudget ?? 0), 0);
  if (dailies.length >= 3) {
    const sorted = [...dailies].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    for (const a of adsets) if (a.dailyBudget && a.dailyBudget > 3 * median) checks.push({ level: "warning", code: "budget_outlier", message: `"${a.name}" has ${m(a.dailyBudget)} a day, more than 3 times the plan's usual ${m(median)}. Check it is not a typo.` });
  }
  if (input.expected_daily_total !== undefined && Math.abs(input.expected_daily_total - dailyTotal) > 0.5) {
    checks.push({ level: "error", code: "budget_mismatch", message: `The plan's ad set budgets add up to ${m(dailyTotal)} a day, but the plan said ${m(input.expected_daily_total)}. Fix the budgets or the expected total.` });
  }
  const spend = world.spendDaily();
  if (canSpend && spend.total === 0 && !input.run_at) checks.push({ level: "warning", code: "nothing_delivers", message: "Something is turned on, but no campaign and ad set are both on afterwards, so nothing will spend yet." });
  if (input.run_at) steps.unshift({ n: 0, title: `Runs at ${istTime(input.run_at)}`, lines: ["The server runs the steps at this time. Until then the plan can be cancelled."] });

  return {
    account: { id: client.accountId, name: info.name, currency: cur },
    runAt: input.run_at ?? null,
    steps,
    adsets,
    totals: { campaigns: campaignsN, adsets: newAdsets, ads: adsN, dailyBudget: dailyTotal, lifetimeBudget: lifetimeTotal, spendNowDaily: spend.total, turnsOn },
    checks,
    errors: checks.filter((c) => c.level === "error").length,
    warnings: checks.filter((c) => c.level === "warning").length,
    canSpend,
    spendConfirmation: canSpend ? m(Math.max(spend.total, dailyTotal)) : null,
  };
}

function adsetBudgetRules(n: number, op: AdSetSpec, c: WCampaign, err: (n: number, m: string) => void) {
  const has = op.daily_budget !== undefined || op.lifetime_budget !== undefined;
  if (c.cbo && has) err(n, `"${c.name}" uses a campaign budget, so the ad set can't have its own budget.`);
  if (!c.cbo && !has) err(n, `"${c.name}" has no campaign budget, so the ad set needs daily_budget or lifetime_budget.`);
  if (op.daily_budget !== undefined && op.lifetime_budget !== undefined) err(n, "give daily_budget or lifetime_budget, not both.");
}

// ---------- Saving, confirming ----------

export function getPlan(key: string): PlanRow {
  const r = db().prepare("SELECT * FROM plans WHERE key = ?").get(key) as PlanRow | undefined;
  if (!r) throw new HttpError(404, `No plan with code "${key}".`);
  return r;
}

export function savePlan(accountDbId: number, input: PlanInput, summary: PlanSummary, who: string, source: "app" | "claude"): string {
  const key = newKey();
  db()
    .prepare("INSERT INTO plans (key, ad_account_id, title, ops, summary, can_spend, run_at, progress, created_by, source) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(key, accountDbId, input.title?.trim() || defaultTitle(input), JSON.stringify(input), JSON.stringify(summary), summary.canSpend ? 1 : 0, input.run_at ?? null, JSON.stringify(input.ops.map(() => ({ status: "pending", ids: [], message: "" }))), who, source);
  return key;
}

function defaultTitle(input: PlanInput): string {
  const kinds = [...new Set(input.ops.map((o) => o.type.replace(/_/g, " ")))];
  return `${input.ops.length} step${input.ops.length === 1 ? "" : "s"}: ${kinds.join(", ")}`;
}

/** Normalise "₹15,000" / "15000" / "INR 15,000.00" for comparing. */
export function sameAmount(a: string, b: string): boolean {
  const num = (s: string) => Number(s.replace(/[^\d.]/g, ""));
  return !!a.trim() && Number.isFinite(num(a)) && Math.abs(num(a) - num(b)) < 0.5;
}

export function confirmCheck(row: PlanRow, opts: { confirm?: boolean; acceptWarnings?: boolean; spendConfirmation?: string }) {
  if (opts.confirm !== true) throw new HttpError(400, "Running a plan needs confirm: true, after the person has read the summary.");
  if (row.status !== "draft") throw new HttpError(409, `This plan is already ${row.status}.`);
  const s = json<PlanSummary | null>(row.summary, null);
  if (!s) throw new HttpError(409, "The plan has not been checked yet.");
  if (s.errors > 0) throw new HttpError(422, `Fix these first:\n- ${s.checks.filter((c) => c.level === "error").map((c) => c.message).join("\n- ")}`);
  if (s.warnings > 0 && !opts.acceptWarnings) throw new HttpError(422, `There ${s.warnings === 1 ? "is 1 warning" : `are ${s.warnings} warnings`}. Show them to the person and accept them to run the plan.`);
  if (s.canSpend) {
    if (!opts.spendConfirmation || !sameAmount(opts.spendConfirmation, s.spendConfirmation ?? "")) {
      throw new HttpError(
        422,
        `${opts.spendConfirmation ? "The total you typed doesn't match. " : ""}This plan turns things on, so Meta will spend money. Check every budget in the summary, then confirm by typing the total daily budget exactly as shown: ${s.spendConfirmation}.`,
      );
    }
  }
}

export function planProgress(row: PlanRow): PlanProgress[] {
  return json<PlanProgress[]>(row.progress, []);
}

// ---------- Running ----------

export interface RunDeps {
  client: MetaClient;
  clock: Clock;
  /** Test hook: called after each create, before the ID is saved. Throwing simulates a crash. */
  afterCreate?: (what: string) => void;
}

function saveProgress(planId: number, p: PlanProgress[]) {
  db().prepare("UPDATE plans SET progress = ? WHERE id = ?").run(JSON.stringify(p), planId);
}

function isAccessError(e: unknown) {
  if (!(e instanceof MetaError)) return false;
  const c = e.code ?? 0;
  return c === 190 || c === 102 || c === 10 || (c >= 200 && c <= 299);
}

/** Run a confirmed plan to the end. Safe to call again after a crash: finished steps and saved IDs are kept. */
export async function runPlan(planId: number, deps: RunDeps): Promise<{ done: number; failed: number }> {
  const row = db().prepare("SELECT * FROM plans WHERE id = ?").get(planId) as PlanRow;
  if (row.status === "cancelled") return { done: 0, failed: 0 };
  db().prepare("UPDATE plans SET status = 'running' WHERE id = ?").run(planId);
  const input = JSON.parse(row.ops) as PlanInput;
  const progress = planProgress(row);
  const { client } = deps;
  const { currency } = await accountInfo(client);
  const refs = new Map<string, string[]>();
  // Refs from steps finished in an earlier run.
  input.ops.forEach((op, i) => {
    const ref = (op as { ref?: string }).ref ?? `step${i + 1}`;
    if (progress[i]?.ids.length) refs.set(ref, progress[i].ids);
  });
  const resolve = (s: string): string[] => {
    if (!isRef(s)) return [s];
    const got = refs.get(refName(s));
    if (!got?.length) throw new Error(`Step "${s}" did not create anything, so this step can't run.`);
    const idx = s.split(".")[1];
    return idx !== undefined ? [got[Number(idx)]].filter(Boolean) : got;
  };
  const cancelled = () => (db().prepare("SELECT status FROM plans WHERE id = ?").get(planId) as { status: string }).status === "cancelled";

  let stop = "";
  for (let i = 0; i < input.ops.length; i++) {
    const op = input.ops[i];
    const p = (progress[i] ??= { status: "pending", ids: [], message: "" });
    if (p.status === "done" || p.status === "skipped") continue;
    if (stop) { p.status = "skipped"; p.message = stop; saveProgress(planId, progress); continue; }
    if (cancelled()) { stop = "The plan was cancelled before this step."; i--; continue; }
    p.status = "running";
    saveProgress(planId, progress);
    try {
      await runOp(op, i, p, { ...deps, currency, resolve, planKey: row.key, save: () => saveProgress(planId, progress) });
      p.status = "done";
      const ref = (op as { ref?: string }).ref ?? `step${i + 1}`;
      if (p.ids.length) refs.set(ref, p.ids);
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal) throw e;
      p.status = "failed";
      p.message = e instanceof MetaError ? plainError(e, `Step ${i + 1}`) : `Step ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`;
      if (isAccessError(e)) stop = "Not run: the Meta connection lost permission in an earlier step.";
    }
    saveProgress(planId, progress);
  }
  const done = progress.filter((p) => p.status === "done").length;
  const failed = progress.length - done;
  const status = cancelled() ? "cancelled" : failed === 0 ? "done" : done === 0 ? "failed" : "partial";
  db().prepare("UPDATE plans SET status = ?, finished_at = datetime('now') WHERE id = ?").run(status, planId);
  return { done, failed };
}

interface OpCtx extends RunDeps {
  currency: string;
  resolve: (s: string) => string[];
  planKey: string;
  save: () => void;
}

/** Create something once: if an earlier run started this item but saved no ID, look it up by name first. */
async function createItem(p: PlanProgress, j: number, ctx: OpCtx, find: () => Promise<string | null>, create: () => Promise<string>): Promise<string> {
  if (p.ids[j]) return p.ids[j];
  if (p.attempted?.includes(j)) {
    const found = await find();
    if (found) {
      p.ids[j] = found;
      ctx.save();
      return found;
    }
  }
  p.attempted = [...(p.attempted ?? []).filter((x) => x !== j), j];
  ctx.save();
  const id = await create();
  ctx.afterCreate?.(`${ctx.planKey}:${j}`);
  p.ids[j] = id;
  p.attempted = p.attempted.filter((x) => x !== j);
  ctx.save();
  return id;
}

async function findByName(client: MetaClient, edge: string, name: string, extra: Record<string, unknown> = {}): Promise<string | null> {
  const rows = await client.getAll<{ id: string; name: string }>(edge, { fields: "id,name", filtering: [{ field: "name", operator: "EQUAL", value: name }], ...extra }).catch(() => []);
  return rows.find((r) => r.name === name)?.id ?? null;
}

/** A copy is first named "<original> [P:plan.step.item]" and renamed after; a restart finds it by either name. */
async function findCopy(client: MetaClient, edge: string, marker: string, finalName: string, extra: Record<string, unknown> = {}): Promise<string | null> {
  const rows = await client.getAll<{ id: string; name: string }>(edge, { fields: "id,name", filtering: [{ field: "name", operator: "CONTAIN", value: marker }], ...extra }).catch(() => []);
  return rows.find((r) => r.name.includes(marker))?.id ?? (await findByName(client, edge, finalName, extra));
}

async function runOp(op: Op, i: number, p: PlanProgress, ctx: OpCtx): Promise<void> {
  const { client, currency } = ctx;
  const act = client.accountId;
  const key = (j: number) => idemKey(`plan:${ctx.planKey}:${i}:${j}`);
  switch (op.type) {
    case "create_campaign": {
      const name = nameFor(op.name_template, op.name ?? "", { n: i + 1, persona: op.persona, angle: op.angle, objective: op.objective, budget: op.daily_budget ?? op.lifetime_budget });
      await createItem(p, 0, ctx, () => findByName(client, `${act}/campaigns`, name), async () => (await client.post<{ id: string }>(`${act}/campaigns`, campaignParams({ ...op, name }, currency, true), { idempotencyKey: key(0) })).id);
      p.message = `Created campaign "${name}"${op.status === "ACTIVE" ? " (on)" : " (paused)"}.`;
      return;
    }
    case "edit_campaign": {
      const [id] = ctx.resolve(op.campaign);
      await client.post(id, campaignParams(op, currency, false));
      p.ids = [id];
      p.message = `Updated campaign ${id}.`;
      return;
    }
    case "duplicate_campaign": {
      const [src] = ctx.resolve(op.campaign);
      const c = await getCampaign(client, src);
      const count = copiesOf(op);
      for (let j = 0; j < count; j++) {
        const ch = op.changes?.[j] ?? {};
        const name = ch.name ?? nameFor(op.name_template ?? ch.name_template, `${c.name} - copy ${j + 1}`, { n: j + 1, persona: op.persona ?? ch.persona, objective: c.objective, budget: ch.daily_budget ?? fromMinor(c.daily_budget, currency) });
        const marker = `[P:${ctx.planKey}.${i}.${j}]`;
        const id = await createItem(p, j, ctx, () => findCopy(client, `${act}/campaigns`, marker, name), async () => {
          const r = await client.post<{ id?: string; copied_campaign_id?: string; ad_object_ids?: { copied_id: string; ad_object_type?: string }[] }>(`${src}/copies`, {
            deep_copy: !!op.with_contents,
            status_option: "PAUSED",
            rename_options: { rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` ${marker}` },
          }, { idempotencyKey: key(j) });
          const newId = r.copied_campaign_id ?? r.ad_object_ids?.find((x) => !x.ad_object_type || x.ad_object_type === "campaign")?.copied_id ?? r.id;
          if (!newId) throw new Error("Meta did not return the new campaign's ID. With many ad sets, copy the campaign without its contents, then copy the ad sets.");
          return newId;
        });
        const params = campaignParams({ ...ch, name }, currency, false);
        await client.post(id, params);
      }
      p.message = `Made ${count} cop${count === 1 ? "y" : "ies"} of "${c.name}", paused unless a copy said otherwise.`;
      return;
    }
    case "create_adset": {
      const [campaignId] = ctx.resolve(op.campaign);
      const c = await getCampaign(client, campaignId);
      const name = op.name || nameFor(op.name_template, "", { n: i + 1, persona: op.persona, angle: op.angle, campaign: c.name, budget: op.daily_budget ?? op.lifetime_budget });
      let saved: Targeting | undefined;
      if (op.saved_audience_id) saved = (await client.get<{ targeting?: Targeting }>(op.saved_audience_id, { fields: "targeting" })).targeting;
      await createItem(p, 0, ctx, () => findByName(client, `${act}/adsets`, name, { campaign_id: campaignId }), async () =>
        (await client.post<{ id: string }>(`${act}/adsets`, { ...adsetParams({ ...op, name }, currency, { forCreate: true, savedAudience: saved }), campaign_id: campaignId }, { idempotencyKey: key(0) })).id,
      );
      p.message = `Created ad set "${name}"${op.status === "ACTIVE" ? " (on)" : " (paused)"}.`;
      return;
    }
    case "edit_adset": {
      const [id] = ctx.resolve(op.adset);
      const cur = touchesAudience(op) || op.event || op.pixel_id ? await getAdSet(client, id) : undefined;
      await client.post(id, adsetParams(op, currency, { current: cur, forCreate: false }));
      p.ids = [id];
      p.message = `Updated ad set ${id}.`;
      return;
    }
    case "duplicate_adset": {
      const [srcId] = ctx.resolve(op.adset);
      const src = await getAdSet(client, srcId);
      const [targetId] = op.campaign ? ctx.resolve(op.campaign) : [src.campaign_id];
      const target = await getCampaign(client, targetId);
      const cbo = isCbo(target);
      const count = copiesOf(op);
      let rebuilt = 0;
      for (let j = 0; j < count; j++) {
        const ch = op.changes?.[j] ?? {};
        const daily = cbo ? null : ch.daily_budget ?? fromMinor(src.daily_budget, currency);
        const name = ch.name ?? nameFor(ch.name_template ?? op.name_template, `${src.name} - copy ${j + 1}`, { n: j + 1, persona: ch.persona ?? op.persona, angle: ch.angle, campaign: target.name, budget: daily ?? ch.lifetime_budget ?? fromMinor(src.lifetime_budget, currency), adset: src.name });
        const marker = `[P:${ctx.planKey}.${i}.${j}]`;
        const id = await createItem(p, j, ctx, () => findCopy(client, `${act}/adsets`, marker, name), async () => {
          try {
            const r = await client.post<{ id?: string; copied_adset_id?: string; ad_object_ids?: { copied_id: string }[] }>(`${srcId}/copies`, {
              campaign_id: targetId,
              deep_copy: !!op.with_ads,
              status_option: "PAUSED",
              rename_options: { rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: ` ${marker}` },
            }, { idempotencyKey: key(j) });
            const newId = r.copied_adset_id ?? r.ad_object_ids?.[0]?.copied_id ?? r.id;
            if (!newId) throw new Error("Meta did not return the new ad set's ID.");
            return newId;
          } catch (e) {
            // Meta refuses copies whose spend limits or budget don't fit the target campaign
            // (e.g. 1885648: minimum spend above a campaign budget). Rebuild without them.
            if (!(e instanceof MetaError) || e.code !== 100 || op.with_ads) throw e;
            rebuilt++;
            return (await client.post<{ id: string }>(`${act}/adsets`, adsetCloneParams(src, targetId, `${name} ${marker}`, cbo), { idempotencyKey: idemKey(`plan:${ctx.planKey}:${i}:${j}:rebuild`) })).id;
          }
        });
        const params = adsetParams({ ...ch, name, ...(cbo ? { daily_budget: undefined, lifetime_budget: undefined } : {}) }, currency, { current: src, forCreate: false });
        await client.post(id, params);
      }
      p.message = `Made ${count} cop${count === 1 ? "y" : "ies"} of "${src.name}" in "${target.name}"${rebuilt ? ` (${rebuilt} rebuilt without the template's spend limits, which Meta refused)` : ""}.`;
      return;
    }
    case "ads_from_post": {
      const targets = op.adsets.flatMap((s) => ctx.resolve(s));
      const isIg = op.source === "instagram";
      const storyId = !isIg && !op.post_id.includes("_") && op.page_id ? `${op.page_id}_${op.post_id}` : op.post_id;
      const creativeName = `${op.name ?? "Post"} [post ${op.post_id}]`.slice(0, 100);
      // Item 0 is the one creative; items 1.. are the ads, one per ad set.
      const creativeId = await createItem(p, 0, ctx, () => findByName(client, `${act}/adcreatives`, creativeName), async () => {
        const body: Record<string, unknown> = isIg
          ? { name: creativeName, source_instagram_media_id: op.post_id, instagram_user_id: op.instagram_user_id }
          : { name: creativeName, object_story_id: storyId };
        return (await client.post<{ id: string }>(`${act}/adcreatives`, body, { idempotencyKey: key(0) })).id;
      });
      for (let j = 0; j < targets.length; j++) {
        const adset = await getAdSet(client, targets[j]);
        const name = nameFor(op.name_template, op.name ?? `Post ${op.post_id}`, { n: j + 1, adset: adset.name });
        await createItem(p, j + 1, ctx, () => findByName(client, `${targets[j]}/ads`, name), async () =>
          (await client.post<{ id: string }>(`${act}/ads`, { name, adset_id: targets[j], creative: { creative_id: creativeId }, status: op.status ?? "PAUSED" }, { idempotencyKey: key(j + 1) })).id,
        );
      }
      p.message = `Created ${targets.length} ad${targets.length === 1 ? "" : "s"} from post ${op.post_id}, all sharing one creative.`;
      return;
    }
    case "set_status": {
      const on = op.status === "ACTIVE";
      const campaigns = (op.campaigns ?? []).flatMap((s) => ctx.resolve(s));
      const adsets = (op.adsets ?? []).flatMap((s) => ctx.resolve(s));
      const ads = [...(op.ads ?? [])];
      for (const c of (op.whole_campaigns ?? []).flatMap((s) => ctx.resolve(s))) {
        campaigns.push(c);
        for (const a of await campaignAdSets(client, c)) {
          adsets.push(a.id);
          for (const ad of await adSetAds(client, a.id)) ads.push(ad.id);
        }
      }
      // On: ads first, campaign last, so nothing starts until everything is on. Off: the reverse.
      const order = on ? [...ads, ...adsets, ...campaigns] : [...campaigns, ...adsets, ...ads];
      const doneSet = new Set(p.ids);
      for (const id of order) {
        if (doneSet.has(id)) continue;
        await client.post(id, { status: op.status });
        p.ids.push(id);
        doneSet.add(id);
        ctx.save();
      }
      p.message = `Turned ${on ? "on" : "off"} ${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}, ${adsets.length} ad set${adsets.length === 1 ? "" : "s"} and ${ads.length} ad${ads.length === 1 ? "" : "s"}.`;
      return;
    }
  }
}

export type { AdSetSpec, CampaignSpec, CampaignRow };
