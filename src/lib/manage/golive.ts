import { db, json } from "../db";
import { enqueue } from "../jobs";
import { clientFor } from "../meta/factory";
import { adCopy, batchPreset, getAccount, getAds, getBatch, logEvent, updateBatch } from "../store";
import type { BatchRow } from "../types";
import { accountInfo, adSetAds, campaignAdSets, describeAdSet, getAdSet, getCampaign, isCbo, istTime } from "./objects";
import { fromMinor, money } from "./options";
import { budgetWarnDaily, savePlan, summarise, type PlanInput } from "./plan";

// Batches: what happens after the ads are in ("launch now" / "at a time"), and the summary
// shown before the launch is confirmed.

export interface ExtraAdset { id: string; name: string; campaignId: string; campaignName: string }

export const extraAdsets = (b: BatchRow): ExtraAdset[] => json<ExtraAdset[]>(b.extra_adsets, []);

/** The batch and the batches launched together with it (one per extra ad set). */
export function siblings(b: BatchRow): BatchRow[] {
  if (!b.group_key) return [b];
  return db().prepare("SELECT * FROM batches WHERE group_key = ? ORDER BY id").all(b.group_key) as BatchRow[];
}

/**
 * After a launch: when the batch was launched with "now" or "at a time", queue a plan that turns
 * on the new ads, their ad sets and the campaign. The yes (with the budget total) was given at
 * launch, so the plan is queued as confirmed. Waits while any ad is not created.
 */
export async function queueGoLive(batchId: number): Promise<string | null> {
  const b = getBatch(batchId);
  if (!b || b.go_live === "paused" || b.go_live_done) return null;
  const ads = getAds(batchId);
  const missing = ads.filter((a) => a.status !== "done").length;
  if (missing) {
    logEvent(batchId, null, "warn", `Not turned on yet: ${missing} ad${missing > 1 ? "s were" : " was"} not created. Fix and press "Retry failed"; the ads are turned on once every ad is in.`);
    return `go-live waits for ${missing} failed ad(s)`;
  }
  const adIds = ads.map((a) => a.meta_ad_id!).filter(Boolean);
  const adsetIds = [...new Set(ads.map((a) => a.meta_adset_id!).filter(Boolean))];
  const runAt = b.go_live === "at" && b.go_live_at && Date.parse(b.go_live_at) > Date.now() + 60_000 ? b.go_live_at : undefined;
  const input: PlanInput = {
    title: `Turn on batch ${b.key} (${ads.length} ad${ads.length > 1 ? "s" : ""})`,
    run_at: runAt,
    ops: [{ type: "set_status", status: "ACTIVE", ads: adIds, adsets: adsetIds, campaigns: b.campaign_id ? [b.campaign_id] : [] }],
  };
  const client = clientFor(b.ad_account_id);
  const summary = await summarise(client, input, { validate: false });
  const key = savePlan(b.ad_account_id, input, summary, b.created_by ?? "launcher", "app");
  db().prepare("UPDATE plans SET status = 'queued', confirmed_at = datetime('now'), confirmed_by = ? WHERE key = ?").run(`${b.created_by ?? "?"} (when launching batch ${b.key})`, key);
  const id = (db().prepare("SELECT id FROM plans WHERE key = ?").get(key) as { id: number }).id;
  enqueue("plan", id, runAt ? Date.parse(runAt) : Date.now());
  updateBatch(b.id, { go_live_done: 1 });
  const msg = runAt ? `The ads will be turned on at ${istTime(runAt)} (plan ${key}).` : `Turning the ads on now (plan ${key}).`;
  logEvent(b.id, null, "info", msg);
  return msg;
}

// ---------- Pre-launch summary ----------

export interface LaunchSummary {
  account: { id: string; name: string; currency: string };
  campaign: { id: string; name: string; status: string; budget: string; cbo: boolean } | null;
  adsets: { name: string; budget: string; dailyBudget: number | null; bid: string; schedule: string; audience: string; placements: string; goal: string; ads: number; isNew: boolean }[];
  totalDailyBudget: number;
  totalDailyLabel: string;
  alsoSpends: string[];
  adCount: number;
  copy: { primaryTexts: number; headlines: number; firstText: string; link: string; cta: string; utm: string };
  goLive: string;
  warnings: string[];
  /** Typed back to confirm a launch that turns ads on; null for paused launches. */
  spendConfirmation: string | null;
}

/** Everything the person should see before saying yes. Reads Meta; writes nothing. */
export async function launchSummary(b: BatchRow, goLive: { mode: "paused" | "now" | "at"; at?: string | null }): Promise<LaunchSummary> {
  const acc = getAccount(b.ad_account_id)!;
  const client = clientFor(acc.id);
  const { currency, name } = await accountInfo(client);
  const m = (v: number | null) => money(v, currency);
  const ads = getAds(b.id);
  const warnings: string[] = [];
  const adsets: LaunchSummary["adsets"] = [];
  let campaign: LaunchSummary["campaign"] = null;
  let total = 0;
  const alsoSpends: string[] = [];
  const targets = [{ id: b.adset_id, campaignId: b.campaign_id }, ...extraAdsets(b).map((x) => ({ id: x.id, campaignId: x.campaignId }))].filter((t): t is { id: string; campaignId: string } => !!t.id && !!t.campaignId);
  const campaigns = new Map<string, Awaited<ReturnType<typeof getCampaign>>>();
  for (const t of targets) {
    let c = campaigns.get(t.campaignId);
    if (!c) { c = await getCampaign(client, t.campaignId); campaigns.set(t.campaignId, c); }
    const cbo = isCbo(c);
    const a = await getAdSet(client, t.id);
    const d = describeAdSet(a, currency);
    const each = cbo ? null : fromMinor(a.daily_budget, currency);
    const copies = b.adset_mode === "new_per_ad" ? ads.length : 1;
    adsets.push({
      name: b.adset_mode === "new_per_ad" ? `${ads.length} new ad set${ads.length > 1 ? "s" : ""} copied from "${a.name}"` : a.name,
      budget: cbo ? "campaign budget" : `${d.budget}${copies > 1 ? ` each (${m((each ?? 0) * copies)} a day for all ${copies})` : ""}`,
      dailyBudget: each === null ? null : each * copies,
      bid: d.bid,
      schedule: d.schedule,
      audience: d.audience,
      placements: d.placements,
      goal: d.goal,
      ads: ads.length,
      isNew: b.adset_mode === "new_per_ad",
    });
    if (!cbo) total += (each ?? 0) * copies;
    if (each && each > budgetWarnDaily()) warnings.push(`"${a.name}" has ${m(each)} a day, above the usual limit of ${m(budgetWarnDaily())}.`);
  }
  for (const c of campaigns.values()) {
    const cbo = isCbo(c);
    const daily = fromMinor(c.daily_budget, currency);
    if (cbo) total += daily ?? 0;
    campaign ??= { id: c.id, name: c.name, status: c.status, budget: cbo ? (daily ? `${m(daily)} a day (campaign budget)` : `${m(fromMinor(c.lifetime_budget, currency))} lifetime (campaign budget)`) : "set on each ad set", cbo };
    if (cbo && daily && daily > budgetWarnDaily()) warnings.push(`Campaign "${c.name}" has ${m(daily)} a day, above the usual limit of ${m(budgetWarnDaily())}.`);
    if (goLive.mode !== "paused" && c.status !== "ACTIVE") {
      // Turning the campaign on also lets its other ad sets that are on start spending.
      const others = (await campaignAdSets(client, c.id)).filter((a) => a.status === "ACTIVE" && !targets.some((t) => t.id === a.id));
      for (const o of others) {
        const live = (await adSetAds(client, o.id)).some((x) => x.status === "ACTIVE");
        if (!live) continue;
        const od = fromMinor(o.daily_budget, currency);
        alsoSpends.push(`"${o.name}" in "${c.name}" (${od ? `${m(od)} a day` : "campaign budget"}) is already on and starts spending when the campaign is turned on.`);
        if (!cbo) total += od ?? 0;
      }
    }
  }
  if (b.adset_mode === "new_per_ad" && extraAdsets(b).length) warnings.push("New ad set per ad and several ad sets were both picked; each extra ad set gets its own copies.");
  const copy = ads[0] ? adCopy(b, ads[0]) : { primaryTexts: [], headlines: [], linkUrl: "", cta: "", utmTemplate: "" };
  const preset = batchPreset(b);
  const goLiveText =
    goLive.mode === "now" ? "Turned ON as soon as every ad is created." : goLive.mode === "at" && goLive.at ? `Created paused, turned ON at ${istTime(goLive.at)}.` : "Created PAUSED. Nothing spends until someone turns it on.";
  if (goLive.mode === "at" && (!goLive.at || Number.isNaN(Date.parse(goLive.at)))) warnings.push("Pick the date and time to turn the ads on.");
  if (!preset.pageId) warnings.push("No Facebook Page in the settings preset.");
  return {
    account: { id: acc.meta_account_id, name, currency },
    campaign,
    adsets,
    totalDailyBudget: total,
    totalDailyLabel: m(total),
    alsoSpends,
    adCount: ads.length * Math.max(1, targets.length),
    copy: { primaryTexts: copy.primaryTexts.length, headlines: copy.headlines.length, firstText: copy.primaryTexts[0] ?? "", link: copy.linkUrl, cta: copy.cta, utm: copy.utmTemplate },
    goLive: goLiveText,
    warnings,
    spendConfirmation: goLive.mode === "paused" ? null : m(total),
  };
}
