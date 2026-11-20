import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { istLabel } from "../lib/time";
import { cell, connectionText, forThePerson, registerManageTools } from "./manage-tools";

// The launcher tools for Claude (the batch tools here, everything else in manage-tools.ts). Shared by the Claude Desktop extension (stdio, mcp/)
// and the Claude Code endpoint (/api/mcp). Both call the app's own HTTP API with the
// person's API key; neither ever sees the Meta token. Claude asks; the app does the work.
// Every time shown to Claude is India time words (istLabel), never a raw ISO or UTC time.

export interface LauncherApi {
  call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
}

export function httpApi(baseUrl: string, apiKey: string): LauncherApi {
  const base = baseUrl.replace(/\/$/, "");
  return {
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (!apiKey) throw new Error("No API key set. Create one in the launcher under Settings → Claude connection.");
      let res: Response;
      try {
        res = await fetch(`${base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${apiKey}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(180_000),
        });
      } catch (e) {
        throw new Error(`Couldn't reach the launcher at ${base} (${e instanceof Error ? e.message : String(e)}).`);
      }
      // The launcher always answers with a JSON object. Anything else (a proxy's or sign-in page, an
      // empty answer) is said plainly, never handed to a tool that would read fields that aren't there.
      const raw = await res.text().catch(() => "");
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        data = undefined;
      }
      const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as { error?: unknown }) : null;
      if (obj && typeof obj.error === "string" && obj.error) throw new Error(obj.error);
      if (!res.ok) throw new Error(`The launcher answered with error ${res.status}.`);
      if (!obj) throw new Error(`The launcher's address (${base}) answered with something that is not the launcher (for example a web page from a proxy or a sign-in page). Check the launcher address in the Claude extension's settings, or try again in a minute.`);
      return obj as T;
    },
  };
}

// Shapes we read from the app's API (subset of BatchView).
interface PresetView { name: string; pageId?: string; pageName?: string; igUserId?: string; igName?: string; enhancements?: Record<string, string>; multiAdvertiser?: boolean; whatsappNumber?: string; threadsUserId?: string; sponsorPageId?: string }
interface Check { level: "error" | "warning"; message: string }
interface AdCopy { primaryTexts: string[]; headlines: string[]; descriptions?: string[]; linkUrl: string; cta: string; utmTemplate?: string; displayLink?: string; leadFormId?: string }
interface ViewAd {
  position: number;
  creativeName: string;
  metaName: string;
  adsetName: string;
  files: { id?: number; filename: string; ratio: string | null; placement: string; size: string; durationSec: number | null }[];
  copy: AdCopy;
  /** True when this ad has its own copy or settings (not only the batch's). */
  hasOverride?: boolean;
  override?: Partial<AdCopy> & { format?: string; enhancements?: Record<string, string>; multiAdvertiser?: boolean };
  checks: Check[];
  status: string;
  step: string | null;
  error: string | null;
  reviewLabel: string;
  reviewIssues: string[];
  metaPostId: string | null;
  metaIgMediaId: string | null;
  leftover: string | null;
  featureWarnings: string[];
  adsManagerUrl: string | null;
}
interface View {
  key: string;
  status: string;
  statusLabel: string;
  source: { kind: string; label: string };
  settings: {
    campaignName: string | null;
    adsetMode: string;
    adsetName: string | null;
    copyTemplateId: number | null;
    copy?: AdCopy;
    preset: PresetView | null;
    goLive: string;
    goLiveAt: string | null;
    extraAdsets: { name: string; campaignName: string }[];
  };
  together?: { key: string; adsetName: string | null; status: string }[];
  /** estimate.text: the time for the whole launch (every ad set) in one sentence. */
  preview: { batchChecks: Check[]; errors: number; warnings: number; estimate: { label: string; rateLimited: boolean; text?: string } };
  launchEstimate: string | null;
  /** While the launch runs: the time left for the whole launch, from how fast the ads are going in. */
  timeLeft?: string | null;
  progress: { total: number; done: number; failed: number; working: number };
  links: { app: string; campaign: string | null };
  ads: ViewAd[];
  unassigned?: { id: number; filename: string; kind: string }[];
  createdAt?: string;
  launchedAt?: string | null;
  finishedAt?: string | null;
  cancelRequested?: boolean;
  /** The plan that turns the ads on (go live now / at a time), once it is made. */
  goLivePlan?: { key: string; status: string; runAt: string | null; stopNote?: string } | null;
  reviewCheckedAt?: string | null;
  stoppedAt?: string | null;
  /** The ads are still to be turned on, but the yes given at launch no longer does it: why (a Retry then saves the turn-on plan as a draft). */
  goLiveHold?: string | null;
  /** A Retry pressed now would not turn the ads on by itself (more than goLiveHold, e.g. a Retry long after the launch ended): why. */
  retryHold?: string | null;
  /** The turn-on step failed: one plain sentence while the worker tries again, or after it gave up. */
  goLiveNote?: string | null;
  goLiveWaits?: string | null;
  /** The batch's log, newest first. */
  events?: { level: string; message: string; at: string }[];
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true });
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\.+$/, "");

/** Most rows of a table shown to Claude; the rest are in the app (its link is in the answer). */
const MAX_ROWS = 30;
/** list_destinations: most campaigns and ad set lines (as list_campaigns). */
const MAX_CAMPAIGNS = 60;
const MAX_ADSET_LINES = 150;
/** The launcher's batch list holds the latest 50 batches. */
const BATCHES_LISTED = 50;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The time of the whole launch (every ad set), in one sentence. */
const estimateWords = (e: View["preview"]["estimate"]) => e.text ?? `${e.label}${e.rateLimited ? " (Meta's speed limit for new apps sets the pace)" : ""}`;

/** What a retry_failed now would meet, next to the Retry advice: the ads are not turned on by it. */
function retryHoldLine(v: View): string | null {
  if (!v.retryHold || v.settings.goLive === "paused") return null;
  return `If retry_failed is used now, the ads are NOT turned on by themselves: ${v.retryHold}, so the budget confirmation given at launch is not used. Once every ad is in, the plan that turns them on is saved as a draft for the person to check and confirm.`;
}

/** "now" / "at a time" / paused, in words, with the time in IST. */
function liveWords(goLive: string, goLiveAt: string | null, style: "upper" | "lower"): string {
  const on = style === "upper" ? "TURNED ON" : "turned on";
  if (goLive === "now") return `created paused, then ${on} once all are in`;
  if (goLive === "at") return `created paused, then ${on} at ${goLiveAt ? istLabel(goLiveAt) : "a time not set yet"}`;
  return style === "upper" ? "all to be created PAUSED" : "all PAUSED";
}

interface LaunchSum {
  connection: Parameters<typeof connectionText>[0];
  launch: {
    account: { name: string; id: string };
    campaign: { name: string; status: string; budget: string } | null;
    /** Every campaign of the launch (older servers send only `campaign`). */
    campaigns?: { id: string; name: string; status: string; budget: string }[];
    adsets: { campaignId?: string; name: string; budget: string; bid: string; schedule: string; audience: string; placements: string; goal: string; ads: number }[];
    totalDailyLabel: string;
    /** Lifetime budgets, shown on their own (they are counted per day in the total). */
    lifetimeBudgets?: string[];
    alsoSpends: string[];
    adCount: number;
    copy: { primaryTexts: number; headlines: number; firstText: string; link: string; cta: string; utm: string };
    goLive: string;
    warnings: string[];
    checks?: { level: string; message: string }[];
    /** Lines shown even when all is well: ad account health, pixel, daily budget ceiling. */
    health?: string[];
    spendConfirmation: string | null;
  } | null;
}

/** The settings preset in one line: every ad-level setting it sends (Page, Instagram, WhatsApp, Threads, branded content…). */
function presetLine(p: PresetView | null): string {
  if (!p) return "Settings preset: none.";
  const on = Object.entries(p.enhancements ?? {}).filter(([, v]) => v === "OPT_IN").map(([k]) => k);
  const parts = [
    `Facebook Page ${p.pageName || p.pageId || "not set"}`,
    `Instagram ${p.igName ? `@${p.igName}` : p.igUserId ? `ID ${p.igUserId}` : "none (the Page is used)"}`,
    `WhatsApp number ${p.whatsappNumber || "none"}`,
    `Threads account ${p.threadsUserId || "none"}`,
    `branded content partner Page ${p.sponsorPageId || "none"}`,
    `AI enhancements ${on.length ? `${on.join(", ")} on` : "all off"}`,
    `multi-advertiser ${p.multiAdvertiser ? "on" : "off"}`,
  ];
  return `Settings preset: ${p.name} (${parts.join(", ")}).`;
}

/**
 * The copy line of the summary: the batch's copy (ads with their own copy are in the table), and how
 * many ads have a link of their own, so the batch's link is never read as every ad's link.
 */
function copyLine(v: View | undefined, l: NonNullable<LaunchSum["launch"]>): string {
  const own = v ? v.ads.filter((a) => a.hasOverride).length : 0;
  const c = v?.settings.copy;
  const batchLink = c ? c.linkUrl : l.copy.link;
  const ownLinks = v ? v.ads.filter((a) => a.hasOverride && a.copy.linkUrl !== batchLink).length : 0;
  const notes = [own ? `${own} ad${own === 1 ? " has its" : "s have their"} own copy, shown in the table` : "", ownLinks ? `${ownLinks} ad${ownLinks === 1 ? " has its" : "s have their"} own link` : ""].filter(Boolean);
  const label = notes.length ? `Copy (the batch copy; ${notes.join("; ")})` : "Copy";
  if (!c) return `${label}: ${l.copy.primaryTexts} primary text(s), ${l.copy.headlines} headline(s), ${l.copy.cta} → ${l.copy.link || "no link"}${l.copy.utm ? ` · UTM ${l.copy.utm}` : ""}. First text: "${clip(l.copy.firstText, 160)}"`;
  const first = c.primaryTexts[0] ?? "";
  return `${label}: ${c.primaryTexts.length} primary text(s), ${c.headlines.length} headline(s), ${c.cta} → ${c.linkUrl || "no link"}${c.utmTemplate ? ` · UTM ${c.utmTemplate}` : ""} · display link ${c.displayLink || "none"} · ${descText(c.descriptions, 80)}${c.leadFormId ? ` · lead form ${c.leadFormId}` : ""}. First text: "${clip(first, 160)}"`;
}

function summaryText(s: LaunchSum, v?: View): string {
  const lines = ["PRE-LAUNCH SUMMARY", connectionText(s.connection)];
  const l = s.launch;
  if (!l) return lines.join("\n");
  const adsetLine = (a: NonNullable<LaunchSum["launch"]>["adsets"][number]) => `Ad set: ${a.name} · ${a.budget} · bid ${a.bid} · ${a.schedule} · goal ${a.goal} · audience ${a.audience} · placements ${a.placements} · ${a.ads} ad(s)`;
  // One "Campaign:" line per campaign, each followed by its ad sets, so every budget in the total is shown.
  const camps = l.campaigns?.length ? l.campaigns : l.campaign ? [{ id: "", ...l.campaign }] : [];
  if (!camps.length) lines.push("Campaign: no campaign picked");
  const shown = new Set<number>();
  for (const c of camps) {
    lines.push(`Campaign: ${c.name} (${c.status.toLowerCase()}) · budget ${c.budget}`);
    l.adsets.forEach((a, i) => {
      if (shown.has(i) || (camps.length > 1 && a.campaignId !== c.id)) return;
      shown.add(i);
      lines.push(adsetLine(a));
    });
  }
  l.adsets.forEach((a, i) => !shown.has(i) && lines.push(adsetLine(a)));
  for (const x of l.alsoSpends) lines.push(`Also spends: ${x}`);
  for (const x of l.lifetimeBudgets ?? []) lines.push(`Lifetime budget: ${x}`);
  lines.push(`TOTAL daily budget: ${l.totalDailyLabel}.${l.lifetimeBudgets?.length ? " (Lifetime budgets are counted as what they can spend per day.)" : ""} Ads: ${l.adCount}. ${l.goLive}`);
  lines.push(copyLine(v, l));
  for (const h of l.health ?? []) lines.push(h);
  for (const w of l.warnings) lines.push(`Budget warning: ${w}`);
  for (const c of l.checks ?? []) lines.push(`${c.level === "error" ? "CHECK FAILED" : "Check"}: ${c.message}`);
  return lines.join("\n");
}

/** 'descriptions "A" | "B"' (each cut to `max` characters), or "description none". */
function descText(list: string[] | undefined, max = 200): string {
  return list?.length ? `description${list.length > 1 ? "s" : ""} ${list.map((d) => `"${clip(d, max)}"`).join(" | ")}` : "description none";
}

/** The ad's copy in the table; an ad with its own copy shows its first text, headline and button. */
function copyCell(a: ViewAd): string {
  const base = `${a.copy.primaryTexts.length} texts, ${a.copy.headlines.length} headlines, ${a.copy.descriptions?.length ?? 0} descriptions → ${a.copy.linkUrl || "no link"}`;
  if (!a.hasOverride) return base;
  const parts = [
    a.copy.primaryTexts[0] ? `text "${clip(a.copy.primaryTexts[0], 60)}"` : "",
    a.copy.headlines[0] ? `headline "${clip(a.copy.headlines[0], 40)}"` : "",
    `button ${a.copy.cta}`,
    a.copy.displayLink ? `display link ${a.copy.displayLink}` : "",
    a.copy.descriptions?.length ? descText(a.copy.descriptions, 40) : "",
    a.copy.leadFormId ? `lead form ${a.copy.leadFormId}` : "",
    a.override?.format === "carousel" ? "carousel" : "",
  ].filter(Boolean);
  return `${base} · OWN COPY: ${parts.join(", ")}`;
}

function previewText(v: View, sum?: LaunchSum, sumError?: string): string {
  const s = v.settings;
  const lines: string[] = [];
  lines.push(`Batch ${v.key} (${v.source.kind === "drive" ? `Drive folder "${v.source.label}"` : "uploaded files"}): ${v.ads.length} ads, ${liveWords(s.goLive, s.goLiveAt, "upper")}.`);
  lines.push(`Destination: ${s.campaignName ?? "no campaign picked"} → ${s.adsetMode === "new_per_ad" ? `a new ad set per ad, copied from "${s.adsetName ?? "?"}"` : s.adsetMode === "new_shared" ? `one new ad set for all the ads, copied from "${s.adsetName ?? "?"}"` : (s.adsetName ?? "no ad set picked")}${s.extraAdsets?.length ? `; the same ads also go into ${s.extraAdsets.map((x) => `"${x.name}" (${x.campaignName})`).join(", ")}` : ""}`);
  lines.push(presetLine(s.preset));
  lines.push(`Time estimate: ${estimateWords(v.preview.estimate)}.`);
  lines.push(`Open in the app to check or regroup by dragging: ${v.links.app}`);
  lines.push("");
  for (const c of v.preview.batchChecks) lines.push(`${c.level === "error" ? "ERROR" : "Warning"}: ${c.message}`);
  if (v.unassigned?.length) lines.push(`Files not in any ad yet: ${v.unassigned.map((f) => f.filename).join(", ")} (regroup_files puts them into an ad).`);
  // Big batches: the ads with problems first; the rest are in the app.
  const rank = (a: ViewAd) => (a.checks.some((c) => c.level === "error") ? 0 : a.checks.length ? 1 : 2);
  const shown = v.ads.length > MAX_ROWS ? [...v.ads].sort((x, y) => rank(x) - rank(y) || x.position - y.position).slice(0, MAX_ROWS).sort((x, y) => x.position - y.position) : v.ads;
  lines.push("| # | Name in Meta | Files (ratio → placement) | Copy | Problems |");
  lines.push("|---|---|---|---|---|");
  for (const a of shown) {
    const files = a.files.map((f) => `${f.filename} (${f.ratio?.replace("x", ":") ?? "?"} → ${f.placement})`).join("; ");
    const probs = a.checks.map((c) => `${c.level === "error" ? "ERROR" : "Warning"}: ${c.message}`).join(" / ") || "none";
    lines.push(`| ${a.position} | ${cell(a.metaName)} | ${cell(files)} | ${cell(copyCell(a))} | ${cell(probs)} |`);
  }
  if (shown.length < v.ads.length) {
    const hidden = v.ads.filter((a) => !shown.includes(a));
    const withErrors = hidden.filter((a) => rank(a) === 0).length;
    const withWarnings = hidden.filter((a) => rank(a) === 1).length;
    const clean = hidden.length - withErrors - withWarnings;
    const parts = [withErrors ? `${withErrors} with errors` : "", withWarnings ? `${withWarnings} with warnings` : "", clean ? `${clean} without problems` : ""].filter(Boolean);
    lines.push(`(${hidden.length} more ads are not listed here: ${parts.join(", ")}. Every ad and its problems are in the app: ${v.links.app})`);
  }
  lines.push("");
  if (sum) lines.push(summaryText(sum, v), "");
  if (sumError) lines.push(`The pre-launch summary couldn't be loaded: ${sumError}. Don't launch until preview_batch shows it.`, "");
  const spend = sum?.launch?.spendConfirmation ? `, and spend_confirmation: "${sum.launch.spendConfirmation}" (the total daily budget, said by the person; never fill it in yourself)` : "";
  // A check of the summary that failed (e.g. the ad account is disabled): never "No problems found".
  const failed = (sum?.launch?.checks ?? []).filter((c) => c.level === "error");
  const accept = v.preview.warnings ? ` and accept_warnings: ${v.preview.warnings} (the number of warnings they read and accepted)` : "";
  if (v.preview.errors) lines.push(`${v.preview.errors} error(s) block the launch. Fix them in the app (link above) or change the settings with preview_batch.${failed.length ? ` Also CHECK FAILED in the summary (${failed.length}, above).` : ""}`);
  else if (sumError) lines.push("The checks found no errors, but without the summary the person can't see the budgets: call preview_batch again (with batch_id) before launching.");
  else if (!sum?.launch) lines.push("No ad set is picked yet, so there is no pre-launch summary. Pick one with ad_set (list_destinations shows them).");
  else if (failed.length) {
    const what = failed.map((c) => c.message.replace(/\.+$/, "")).join("; ");
    lines.push(
      s.goLive !== "paused"
        ? `CHECK FAILED in the summary (${failed.length}): ${what}. The launch is refused until this is fixed, and nothing would be turned on. Show it to the person and fix it first, then call preview_batch again.`
        : `CHECK FAILED in the summary (${failed.length}): ${what}. Until this is fixed the launch may fail, or the ads may not deliver. Show it to the person and fix it first; launch only if they still want the paused ads created now: launch_batch with confirm: true${accept}.`,
    );
  } else if (v.preview.warnings) lines.push(`${v.preview.warnings} warning(s). Show the summary and every warning to the person; launch only with their explicit yes: launch_batch with confirm: true and accept_warnings: ${v.preview.warnings} (the number of warnings they accepted)${spend}.`);
  else lines.push(`No problems found. Show the summary to the person and ask for an explicit yes, then call launch_batch with confirm: true${spend}.`);
  return lines.join("\n");
}

const PLAN_WORDS: Record<string, string> = {
  draft: "a draft waiting for your confirmation: show its summary to the person, then confirm_plan",
  queued: "confirmed",
  running: "running now",
  done: "done: the ads were turned on",
  partial: "some steps failed",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * Whether and when the ads of a "go live now / at a time" batch are turned on. Never promises a turn-on
 * that will not happen: a draft plan, a cancelled one, a Stop, a failed turn-on (goLiveNote) and a
 * finished batch with no plan are each said plainly.
 */
function turnOnLines(v: View): string[] {
  const gp = v.goLivePlan;
  const launching = v.status === "queued" || v.status === "running";
  const finished = v.status === "done" || v.status === "partial" || v.status === "failed";
  const allIn = v.progress.total > 0 && v.progress.done === v.progress.total;
  const askFirst = v.retryHold
    ? "retry_failed tries again (ask the person first)"
    : "retry_failed tries again (ask the person first: it turns the ads on, and then they can spend)";
  const out: string[] = [];
  if (gp) {
    if (gp.status === "draft") {
      out.push(`NOT turned on: the plan that turns the ads on (${gp.key}) is saved as a draft${v.goLiveHold ? `, because ${v.goLiveHold}` : ""}. Nothing turns on until the person confirms it: show them its summary (plan_status with plan_id ${gp.key}), they type the amount that can spend themselves, then confirm_plan. Never fill in that amount yourself.`);
    } else if (gp.status === "cancelled" && gp.stopNote) {
      out.push(`Not fully turned on: the plan that was to turn the ads on (${gp.key}) was cancelled while it ran. ${gp.stopNote[0].toUpperCase()}${gp.stopNote.slice(1)}. plan_status with plan_id ${gp.key} shows which items are on.`);
    } else if (gp.status === "cancelled") {
      out.push(`Not turned on: the plan that was to turn the ads on (${gp.key}) was cancelled, so the ads stay paused.`);
    } else if (gp.status === "failed" || gp.status === "partial") {
      out.push(`The plan that turns the ads on (${gp.key}) ${gp.status === "failed" ? "failed" : "stopped part-way"}: some or all ads may still be paused. plan_status with plan_id ${gp.key} says why and what to do.`);
    } else {
      out.push(`Turned on by plan ${gp.key} (${PLAN_WORDS[gp.status] ?? gp.status})${gp.runAt ? ` at ${istLabel(gp.runAt)}` : gp.status === "queued" || gp.status === "running" ? " as soon as it runs" : ""}. plan_status with plan_id ${gp.key} shows it.`);
    }
    if (v.goLiveNote) out.push(v.goLiveNote);
    return out;
  }
  if (v.goLiveNote) {
    // The launcher's own sentence: either it is still trying (and when), or it gave up.
    out.push(v.goLiveNote);
    if (finished && !/trying again/i.test(v.goLiveNote)) {
      out.push(`Nothing more happens by itself; ${askFirst}.`);
      const hold = retryHoldLine(v);
      if (hold) out.push(hold);
    }
    else out.push("Until it works the ads stay paused.");
    return out;
  }
  if (v.cancelRequested) {
    out.push("Not turned on: the launch was stopped, so the ads that were created stay paused. retry_failed continues it (ask the person first).");
    return out;
  }
  if (v.goLiveWaits) {
    out.push(`Every ad of this batch is in. They are turned on together with the other ad sets of this launch, once every ad is in there too: ${v.goLiveWaits}. Until then they stay paused; retry_failed on that batch creates its missing ads (ask the person first).`);
    return out;
  }
  if (finished && allIn) {
    // Every ad is in, yet no plan was made: never say "once every ad is in" here.
    const last = (v.events ?? [])[0];
    out.push(`Every ad is in, but no plan to turn them on has been made yet, so they are still paused. It is normally made within a minute; if it is still missing after a few minutes, turning them on did not work: ${askFirst}.`);
    const hold = retryHoldLine(v);
    if (hold) out.push(hold);
    if (last && (last.level === "warn" || last.level === "error")) out.push(`Last note in the batch log: ${last.message}`);
    return out;
  }
  if (v.goLiveHold && launching) {
    out.push(`NOT turned on by themselves: ${v.goLiveHold}. Once every ad is in, the plan that turns them on is saved as a draft; the person checks it and types the amount that can spend themselves.`);
    return out;
  }
  out.push(`The ads are turned on by a plan ${v.settings.goLive === "at" && v.settings.goLiveAt ? `at ${istLabel(v.settings.goLiveAt)} ` : ""}once every ad is in; batch_status shows that plan's code once it is made.`);
  if (finished && v.goLiveHold) out.push(`But if retry_failed is used now, they are not turned on by themselves (${v.goLiveHold}): the plan is saved as a draft for the person to check and confirm.`);
  return out;
}

function statusText(v: View): string {
  const p = v.progress;
  const lines = [`Batch ${v.key}: ${v.statusLabel}. ${p.done} of ${p.total} ads created${p.failed ? `, ${p.failed} failed` : ""}${p.working ? `, ${p.working} in progress` : ""}.`];
  const when = [v.createdAt ? `made ${istLabel(v.createdAt)}` : "", v.launchedAt ? `launched ${istLabel(v.launchedAt)}` : "", v.finishedAt ? `finished ${istLabel(v.finishedAt)}` : ""].filter(Boolean);
  if (when.length) lines.push(`Times (IST): ${when.join(", ")}.`);
  if (v.status === "queued" || v.status === "running" || v.timeLeft) {
    const left = v.timeLeft ? `${v.timeLeft[0].toUpperCase()}${v.timeLeft.slice(1)}` : `Still to do: ${estimateWords(v.preview.estimate)}`;
    lines.push(`Estimate at launch${v.together?.length ? " (every ad set)" : ""}: ${v.launchEstimate ?? "unknown"}. ${left}. Progress is live at ${v.links.app}`);
  }
  if (v.cancelRequested && (v.status === "queued" || v.status === "running")) lines.push("Stopping: it was cancelled and stops after the current step.");
  if (v.links.campaign) lines.push(`Campaign in Ads Manager: ${v.links.campaign}`);
  const line = (a: ViewAd) => {
    const parts = [`${a.position}. ${a.metaName}: ${a.status === "done" ? `created, ${a.reviewLabel}` : a.status === "failed" ? `FAILED: ${a.error}` : (a.step ?? a.status)}`];
    if (a.adsManagerUrl) parts.push(a.adsManagerUrl);
    if (a.metaPostId) parts.push(`post ID ${a.metaPostId}`);
    if (a.metaIgMediaId) parts.push(`Instagram media ID ${a.metaIgMediaId}`);
    if (a.leftover) parts.push(`Note: ${a.leftover}`);
    for (const i of a.reviewIssues) parts.push(`Meta review: ${i}`);
    for (const w of a.featureWarnings) parts.push(`Warning: ${w}`);
    return parts.join(" · ");
  };
  if (v.ads.length <= MAX_ROWS) for (const a of v.ads) lines.push(line(a));
  else {
    // Big batches: every ad that is not in yet (or has a review problem), then a count of the rest.
    const notable = v.ads.filter((a) => a.status !== "done" || a.reviewIssues.length || a.leftover);
    for (const a of notable.slice(0, MAX_ROWS)) lines.push(line(a));
    const rest = v.ads.length - Math.min(notable.length, MAX_ROWS);
    if (rest > 0) lines.push(`(${rest} more ads ${notable.length > MAX_ROWS ? "" : "were created without problems and "}are not listed here. Every ad with its Ads Manager link and post ID is in the app: ${v.links.app}. list_ads shows the ads of an ad set.)`);
  }
  if (v.reviewCheckedAt) lines.push(`Meta's review status was last read ${istLabel(v.reviewCheckedAt)}. refresh_review reads it again.`);
  if (v.status === "done" || v.status === "partial" || v.status === "failed") {
    lines.push(`What happened: ${p.done} ad(s) created${p.failed ? `, ${p.failed} not created (reasons above)` : ""}.`);
    if (p.failed) {
      lines.push(`Next: fix the cause named in each failure, then call retry_failed (or press "Retry failed" in the app: ${v.links.app}). Ads that went through are never duplicated.`);
      const hold = retryHoldLine(v);
      if (hold) lines.push(hold);
    }
    if (v.settings.goLive === "paused") lines.push("Created ads are PAUSED. Turn them on in Ads Manager, or with plan_changes (set_status ACTIVE) and confirm_plan.");
  }
  if (v.settings.goLive !== "paused") lines.push(...turnOnLines(v));
  for (const t of v.together ?? []) lines.push(`Launched together: batch ${t.key} → ad set "${t.adsetName}" (${t.status}).`);
  // The Retry note is said once, even when two pieces of advice mention retry_failed.
  const hold = retryHoldLine(v);
  return lines.filter((l, i) => l !== hold || lines.indexOf(l) === i).join("\n");
}

/** accept_warnings as Claude sends it: the number of warnings the person accepted (or true). */
function acceptedWarnings(x: unknown): number | boolean {
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x;
  if (typeof x === "string") {
    const t = x.trim().toLowerCase();
    if (/^\d+$/.test(t)) return Number(t);
    return t === "true" || t === "yes";
  }
  return false;
}

/** The file of a batch by its name (any case, with or without the extension). */
function findFile(v: View, name: string) {
  const q = name.trim().toLowerCase();
  const base = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, "");
  const all = [...v.ads.flatMap((a) => a.files.map((f) => ({ id: f.id, filename: f.filename, ad: a.position as number | null }))), ...(v.unassigned ?? []).map((f) => ({ id: f.id as number | undefined, filename: f.filename, ad: null }))];
  return all.find((f) => f.filename.toLowerCase() === q) ?? all.find((f) => base(f.filename) === base(q));
}

export function registerTools(server: McpServer, api: LauncherApi) {
  registerManageTools(server, api);
  server.registerTool(
    "list_destinations",
    {
      title: "List campaigns and ad sets",
      description: "List the Meta campaigns and ad sets in the connected ad account that ads can be launched into. Ad sets with Dynamic creative switched on can't be used. Long lists are cut: give campaign to narrow.",
      inputSchema: {
        campaign: z.string().optional().describe("Only campaigns whose name or id contains this"),
        refresh: z.boolean().optional().describe("Re-read from Meta instead of the 5-minute cache"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ campaign, refresh }) => {
      try {
        const d = await api.call<{ campaigns: { id: string; name: string; status: string; adsets: { id: string; name: string; status: string; isDynamicCreative: boolean }[] }[] }>("GET", `/api/destinations${refresh ? "?refresh=1" : ""}`);
        const q = campaign?.trim().toLowerCase();
        const list = d.campaigns.filter((c) => !q || c.id === q || c.name.toLowerCase().includes(q));
        if (!list.length) return text(q ? `No campaign whose name or id contains "${campaign}".` : "No active or paused campaigns found.");
        const total = list.reduce((n, c) => n + c.adsets.length, 0);
        const out: string[] = [];
        let setLines = 0;
        let shown = 0;
        for (const c of list) {
          if (shown >= MAX_CAMPAIGNS || setLines >= MAX_ADSET_LINES) break;
          shown++;
          out.push(`Campaign "${c.name}" (id ${c.id}, ${c.status.toLowerCase()})`);
          const sets = c.adsets.slice(0, Math.max(0, MAX_ADSET_LINES - setLines));
          for (const a of sets) out.push(`  - Ad set "${a.name}" (id ${a.id}, ${a.status.toLowerCase()})${a.isDynamicCreative ? " [Dynamic creative: can't use]" : ""}`);
          setLines += sets.length;
          if (sets.length < c.adsets.length) out.push(`  (${c.adsets.length - sets.length} more ad sets in this campaign not shown; call list_destinations with campaign: "${c.name}")`);
        }
        if (shown < list.length) out.push(`(${list.length - shown} more campaigns not shown, ${list.length} in all with ${total} ad sets; give campaign to narrow the list.)`);
        // The launcher reads up to 500 of each from Meta: a list that long may be cut.
        if (d.campaigns.length >= 500 || d.campaigns.reduce((n, c) => n + c.adsets.length, 0) >= 500) out.push("Note: this ad account has more campaigns or ad sets than the launcher reads at once (500), so some may be missing here. preview_batch still takes any ad set by its ID.");
        return text(out.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_templates",
    {
      title: "List copy, naming and settings presets",
      description: "List saved copy templates (primary texts, headlines, link, call to action, display link, description, lead form, UTM tags), naming templates and Meta settings presets (Page, Instagram account, AI enhancements, multi-advertiser, WhatsApp number, Threads account, partner Page = Ads Manager's \"Branded content\").",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const t = await api.call<{
          copy: { id: number; name: string; primaryTexts: string[]; headlines: string[]; linkUrl: string; cta: string; utmTemplate?: string; displayLink?: string; leadFormId?: string; descriptions?: string[] }[];
          naming: { id: number; name: string; kind: string; pattern: string; is_default: number }[];
          presets: { id: number; name: string; pageId?: string; pageName: string; igName: string; enhancementsOn: string[]; multiAdvertiser: boolean; isDefault: boolean; whatsappNumber?: string; threadsUserId?: string; sponsorPageId?: string }[];
          features: { key: string; label: string }[];
          tokens: { token: string; meaning: string }[];
        }>("GET", "/api/templates");
        const out = [
          "Copy templates:",
          ...t.copy.map(
            (c) =>
              `  - "${c.name}" (id ${c.id}): ${c.primaryTexts.length} primary texts, ${c.headlines.length} headlines, ${c.descriptions?.length ?? 0} descriptions, ${c.cta} → ${c.linkUrl || "no link"} · display link ${c.displayLink || "none"} · ${descText(c.descriptions)} · lead form ${c.leadFormId || "none"} · UTM ${c.utmTemplate || "none"}\n    First text: ${c.primaryTexts[0] ?? "(none)"}`,
          ),
          "Naming templates:",
          ...t.naming.map((n) => `  - ${n.kind === "ad" ? "Ad" : n.kind === "adset" ? "Ad set" : "Campaign"} "${n.name}" (id ${n.id}): ${n.pattern}${n.is_default ? " (default)" : ""}`),
          "Settings presets:",
          ...t.presets.map(
            (p) =>
              `  - "${p.name}" (id ${p.id})${p.isDefault ? " (default)" : ""}: Page ${p.pageName || p.pageId || "not set"}, Instagram ${p.igName ? `@${p.igName}` : "none"}, AI enhancements ${p.enhancementsOn.length ? p.enhancementsOn.join(", ") + " on" : "all off"}, multi-advertiser ${p.multiAdvertiser ? "on" : "off"}, WhatsApp ${p.whatsappNumber || "none"}, Threads account ${p.threadsUserId || "none"}, partner Page (branded content) ${p.sponsorPageId || "none"}`,
          ),
          "Advantage+ creative enhancement keys (for save_settings_preset):",
          ...t.features.map((f) => `  ${f.key} = ${f.label}`),
          "Naming words:",
          ...t.tokens.map((x) => `  ${x.token} = ${x.meaning}`),
        ];
        return text(out.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_batches",
    {
      title: "List batches",
      description: "The latest batches (up to 50; older ones are only in the app): code, status (not launched yet, launching, all ads created, some failed…), where the ads go, how many ads were created or failed, who made it and when (IST). Use the code with batch_status, preview_batch or retry_failed.",
      inputSchema: { status: z.enum(["all", "draft", "launched", "problems"]).optional().describe("draft: not launched yet · launched: launching or finished · problems: some or all ads failed. Default all.") },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      try {
        const r = await api.call<{ batches: { key: string; status: string; statusLabel: string; source: string; destination: string; ads: number; done: number; failed: number; createdBy: string | null; createdAt: string; launchedAt: string | null }[] }>("GET", "/api/batches");
        const list = r.batches.filter((b) => !status || status === "all" || (status === "draft" ? b.status === "draft" : status === "launched" ? b.status !== "draft" : b.status === "partial" || b.status === "failed"));
        // Only the latest 50 come from the launcher: an older batch with problems is not among them.
        const cut = r.batches.length >= BATCHES_LISTED;
        const among = cut ? ` among the latest ${r.batches.length} batches (older ones are in the app's batch list)` : "";
        if (!list.length) return text(status && status !== "all" ? `No batches like that${among}.` : "No batches yet.");
        const lines = list.map((b) => `${b.key}: ${b.statusLabel} · ${b.source} → ${b.destination} · ${b.ads} ad(s)${b.done ? `, ${b.done} created` : ""}${b.failed ? `, ${b.failed} failed` : ""} · made ${istLabel(b.createdAt)}${b.createdBy ? ` by ${b.createdBy}` : ""}${b.launchedAt ? ` · launched ${istLabel(b.launchedAt)}` : ""}`);
        if (cut) lines.push(`(Only the latest ${r.batches.length} batches are looked at; older ones are in the app's batch list.)`);
        return text(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "preview_batch",
    {
      title: "Preview a batch",
      description:
        "Build a batch from a Google Drive folder link (or update a batch already in the app) and return the preview and the pre-launch summary: connected ad account, Page and Instagram; campaign; every ad set's budget, bid, schedule, audience and placements; lifetime budgets; the TOTAL daily budget; the batch copy and each ad's own copy; every ad with its name, files, warnings and errors; a time estimate and a link to the app. Creates nothing in Meta. Always show the summary to the person before launching. Ad sets, copy templates and presets can be given by name or id (a name that fits several is refused with the list). Use more_ad_sets to put the same ads into several ad sets, and go_live to turn them on once created (now or at a set time) instead of leaving them paused. Times without a zone are India time (IST).",
      inputSchema: {
        drive_folder_url: z.string().optional().describe("Google Drive folder link. Creates a new batch."),
        batch_id: z.string().optional().describe("Code of a batch already in the app, e.g. k4r94. Use to change settings and preview again."),
        ad_set: z.union([z.string(), z.array(z.string())]).optional().describe("Ad set name or id to launch into (the template when a new ad set is made). A list puts the same ads into every ad set in it."),
        ad_sets: z.array(z.string()).optional().describe("Several ad sets (names or ids): the same ads go into each one, in one launch"),
        ad_set_mode: z.enum(["existing", "new_per_ad", "new_shared"]).optional().describe("existing: into the ad set(s) as they are · new_per_ad: a new paused copy of the ad set per ad · new_shared: one new paused copy of the ad set for all the ads"),
        new_ad_set_per_ad: z.boolean().optional().describe("Same as ad_set_mode new_per_ad (older name)"),
        copy_template: z.string().optional().describe("Copy template name or id"),
        settings_preset: z.string().optional().describe("Settings preset name or id (default preset if left out)"),
        angle: z.string().optional().describe("Angle word for the {angle} part of names"),
        ad_name_template: z.string().optional().describe("Naming pattern for ads, e.g. {date}_{creative}_{angle}_{format}, or a saved naming template's name"),
        adset_name_template: z.string().optional().describe("Naming pattern for new ad sets, or a saved naming template's name"),
        persona: z.string().optional().describe("Persona word for the {persona} part of names"),
        more_ad_sets: z.union([z.array(z.string()), z.string()]).optional().describe("More ad sets (names or ids) that get the same ads, in one launch"),
        go_live: z.enum(["paused", "now", "at"]).optional().describe("paused (default): create everything paused. now: turn the ads on once all are created. at: turn them on at go_live_at. Turning on needs the person to type the total daily budget at launch."),
        go_live_at: z.string().optional().describe("Time for go_live 'at', e.g. 2026-11-20T09:00 (India time when no zone is given) or 2026-11-20T09:00:00+05:30"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (a) => {
      try {
        if (!a.drive_folder_url && !a.batch_id) return fail("Give drive_folder_url (new batch) or batch_id (existing batch).");
        const more = a.more_ad_sets === undefined ? undefined : Array.isArray(a.more_ad_sets) ? a.more_ad_sets : [a.more_ad_sets];
        const sets = [...(Array.isArray(a.ad_set) ? a.ad_set : a.ad_set ? [a.ad_set] : []), ...(a.ad_sets ?? [])].map((x) => x.trim()).filter(Boolean);
        const extras = [...sets.slice(1), ...(more ?? [])];
        const settings = {
          adsetId: sets[0],
          adsetMode: a.ad_set_mode ?? (a.new_ad_set_per_ad === undefined ? undefined : a.new_ad_set_per_ad ? "new_per_ad" : "existing"),
          ...(sets.length || more ? { extraAdsetIds: extras } : {}),
          copyTemplateId: a.copy_template,
          presetId: a.settings_preset,
          angle: a.angle,
          adNameTemplate: a.ad_name_template,
          adsetNameTemplate: a.adset_name_template,
          persona: a.persona,
          goLive: a.go_live,
          goLiveAt: a.go_live_at,
        };
        const changes = Object.values(settings).some((x) => x !== undefined);
        let key = a.batch_id;
        if (a.drive_folder_url) key = (await api.call<View>("POST", "/api/batches", { driveFolder: a.drive_folder_url, ...settings })).key;
        else if (changes) await api.call<View>("PATCH", `/api/batches/${key}`, settings);
        const v = await api.call<View>("POST", `/api/batches/${key}/preview`);
        if (v.status !== "draft") {
          return text(
            `Batch ${v.key} has been launched (${v.statusLabel.toLowerCase()}), so there is nothing to preview or launch again.${changes ? " Its settings preset or copy template change applies to the ads not created yet: retry_failed creates them with it." : ""} Its status:\n\n${statusText(v)}`,
          );
        }
        let sum: LaunchSum | undefined;
        let sumError: string | undefined;
        try {
          sum = await api.call<LaunchSum>("GET", `/api/batches/${key}/summary`);
        } catch (e) {
          sumError = why(e);
        }
        return text(previewText(v, sum, sumError));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "launch_batch",
    {
      title: "Launch a previewed batch",
      description:
        "Launch a batch that was previewed with preview_batch. Ads are created PAUSED; if the batch's go_live is now or at a time, they are turned on once every ad is in. Only call this after the person has seen the pre-launch summary and said yes. Needs confirm: true; accept_warnings: the number of warnings the preview showed and the person accepted (a launch that finds more warnings than that is refused and names the new ones); and for go_live now/at, spend_confirmation: the total daily budget exactly as the summary shows it, as the person said it (never fill it in yourself). Returns at once; the launch runs in the background (use batch_status).",
      inputSchema: {
        batch_id: z.string().describe("Batch code from preview_batch, e.g. k4r94"),
        confirm: z.literal(true).describe("Must be true: the person confirmed the launch"),
        accept_warnings: z.union([z.number(), z.boolean(), z.string()]).optional().describe("How many warnings the person saw in the preview and accepted, e.g. 3 (true also works, but then a warning that appears only at launch is refused)"),
        spend_confirmation: z.union([z.string(), z.number()]).optional().describe("Total daily budget as shown in the summary and typed by the person, e.g. ₹15,000; needed when the ads will be turned on"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ batch_id, confirm, accept_warnings, spend_confirmation }) => {
      try {
        let v: View;
        try {
          v = await api.call<View>("POST", `/api/batches/${batch_id}/launch`, { confirm, acceptWarnings: acceptedWarnings(accept_warnings), spendConfirmation: spend_confirmation === undefined ? undefined : String(spend_confirmation) });
        } catch (e) {
          throw forThePerson(e, "preview_batch");
        }
        const live = v.settings.goLive === "now" ? "created paused and turned on once all are in" : v.settings.goLive === "at" ? `created paused and turned on at ${v.settings.goLiveAt ? istLabel(v.settings.goLiveAt) : "the set time"}` : "all PAUSED";
        return text(`Launch started for batch ${v.key}: ${v.ads.length} ads, ${live}.${v.together?.length ? ` Also launching ${v.together.map((t) => `${t.key} → "${t.adsetName}"`).join(", ")}.` : ""} Estimated time${v.together?.length ? " for every ad set" : ""}: ${estimateWords(v.preview.estimate)}. Live progress: ${v.links.app}\nUse batch_status to check progress.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "batch_status",
    {
      title: "Batch progress and results",
      description: "Progress and results of a batch: which ads were created (with Ads Manager links, post IDs and Meta's review status), which failed and why, and for ads to be turned on, the plan that turns them on and when (IST).",
      inputSchema: { batch_id: z.string().describe("Batch code, e.g. k4r94") },
      annotations: { readOnlyHint: true },
    },
    async ({ batch_id }) => {
      try {
        return text(statusText(await api.call<View>("GET", `/api/batches/${batch_id}`)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "refresh_review",
    {
      title: "Read Meta's review status again",
      description: "Ask the launcher to read Meta's review status (in review, approved, rejected and why) of a launched batch's ads now, instead of waiting for the next scheduled check. Takes a minute or so; then batch_status or delivery_status shows it. Changes nothing in Meta.",
      inputSchema: { batch_id: z.string().describe("Batch code, e.g. k4r94") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ batch_id }) => {
      try {
        await api.call("POST", `/api/batches/${batch_id}/review`);
        return text(`Asked the launcher to read Meta's review status of batch ${batch_id} now. It takes a minute or so; then batch_status (or delivery_status with batch_id) shows it.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "remove_file",
    {
      title: "Remove a file from a draft batch",
      description: "Take one file out of a batch that was not launched yet (e.g. a wrong video). The ads are numbered again. Only the launcher's copy changes: nothing in Meta or Google Drive is touched. Ask the person first and pass confirm: true only after their yes.",
      inputSchema: { batch_id: z.string(), file: z.string().describe("File name as shown in the preview, e.g. hook-01_4x5.mp4"), confirm: z.literal(true).describe("Must be true: the person said to remove this file") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ batch_id, file }) => {
      try {
        const v = await api.call<View>("GET", `/api/batches/${batch_id}`);
        if (v.status !== "draft") return fail(`Batch ${batch_id} has been launched, so its files can't change.`);
        const f = findFile(v, file);
        if (!f || f.id === undefined) return fail(`No file "${file}" in batch ${batch_id}. preview_batch lists the files.`);
        const after = await api.call<View>("POST", `/api/batches/${batch_id}/move`, { assetId: f.id, remove: true });
        return text(`Removed ${f.filename} from batch ${batch_id}${f.ad ? ` (it was in ad ${f.ad})` : ""}. The batch now has ${after.ads.length} ad(s). Run preview_batch with batch_id ${batch_id} to check it again.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_draft",
    {
      title: "Delete a batch that was never launched",
      description: "Delete a draft batch from the launcher (only one that was never launched), with the uploaded files only it used. Nothing in Meta or Google Drive is touched. Ask the person first and pass confirm: true only after their yes.",
      inputSchema: { batch_id: z.string(), confirm: z.literal(true).describe("Must be true: the person said to delete this draft") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ batch_id }) => {
      try {
        await api.call("DELETE", `/api/batches/${batch_id}`);
        return text(`Deleted draft batch ${batch_id}. It was never launched, so nothing in Meta changed.`);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
