import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connectionText, registerManageTools } from "./manage-tools";

// The launcher tools for Claude (the batch tools here, everything else in manage-tools.ts). Shared by the Claude Desktop extension (stdio, mcp/)
// and the Claude Code endpoint (/api/mcp). Both call the app's own HTTP API with the
// person's API key; neither ever sees the Meta token. Claude asks; the app does the work.

export interface LauncherApi {
  call<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T>;
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
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `The launcher answered with error ${res.status}.`);
      return data as T;
    },
  };
}

// Shapes we read from the app's API (subset of BatchView).
interface Check { level: "error" | "warning"; message: string }
interface ViewAd {
  position: number;
  creativeName: string;
  metaName: string;
  adsetName: string;
  files: { filename: string; ratio: string | null; placement: string; size: string; durationSec: number | null }[];
  copy: { primaryTexts: string[]; headlines: string[]; linkUrl: string; cta: string };
  checks: Check[];
  status: string;
  step: string | null;
  error: string | null;
  reviewLabel: string;
  reviewIssues: string[];
  featureWarnings: string[];
  adsManagerUrl: string | null;
}
interface View {
  key: string;
  status: string;
  statusLabel: string;
  source: { kind: string; label: string };
  settings: { campaignName: string | null; adsetMode: string; adsetName: string | null; copyTemplateId: number | null; preset: { name: string } | null; goLive: string; goLiveAt: string | null; extraAdsets: { name: string; campaignName: string }[] };
  together?: { key: string; adsetName: string | null; status: string }[];
  preview: { batchChecks: Check[]; errors: number; warnings: number; estimate: { label: string; rateLimited: boolean } };
  launchEstimate: string | null;
  progress: { total: number; done: number; failed: number; working: number };
  links: { app: string; campaign: string | null };
  ads: ViewAd[];
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true });

interface LaunchSum {
  connection: Parameters<typeof connectionText>[0];
  launch: {
    account: { name: string; id: string };
    campaign: { name: string; status: string; budget: string } | null;
    adsets: { name: string; budget: string; bid: string; schedule: string; audience: string; placements: string; goal: string; ads: number }[];
    totalDailyLabel: string;
    alsoSpends: string[];
    adCount: number;
    copy: { primaryTexts: number; headlines: number; firstText: string; link: string; cta: string; utm: string };
    goLive: string;
    warnings: string[];
    spendConfirmation: string | null;
  } | null;
}

function summaryText(s: LaunchSum): string {
  const lines = ["PRE-LAUNCH SUMMARY", connectionText(s.connection)];
  const l = s.launch;
  if (!l) return lines.join("\n");
  lines.push(`Campaign: ${l.campaign?.name ?? "?"} (${l.campaign?.status.toLowerCase() ?? "?"}) · budget ${l.campaign?.budget ?? "?"}`);
  for (const a of l.adsets) lines.push(`Ad set: ${a.name} · ${a.budget} · bid ${a.bid} · ${a.schedule} · goal ${a.goal} · audience ${a.audience} · placements ${a.placements} · ${a.ads} ad(s)`);
  for (const x of l.alsoSpends) lines.push(`Also spends: ${x}`);
  lines.push(`TOTAL daily budget: ${l.totalDailyLabel}. Ads: ${l.adCount}. ${l.goLive}`);
  lines.push(`Copy: ${l.copy.primaryTexts} primary text(s), ${l.copy.headlines} headline(s), ${l.copy.cta} → ${l.copy.link || "no link"}${l.copy.utm ? ` · UTM ${l.copy.utm}` : ""}. First text: "${l.copy.firstText.slice(0, 160)}${l.copy.firstText.length > 160 ? "…" : ""}"`);
  for (const w of l.warnings) lines.push(`Budget warning: ${w}`);
  return lines.join("\n");
}

function previewText(v: View, sum?: LaunchSum): string {
  const s = v.settings;
  const lines: string[] = [];
  const live = s.goLive === "now" ? "created paused, then TURNED ON once all are in" : s.goLive === "at" ? `created paused, then TURNED ON at ${s.goLiveAt}` : "all to be created PAUSED";
  lines.push(`Batch ${v.key} (${v.source.kind === "drive" ? `Drive folder "${v.source.label}"` : "uploaded files"}): ${v.ads.length} ads, ${live}.`);
  lines.push(`Destination: ${s.campaignName ?? "no campaign picked"} → ${s.adsetMode === "new_per_ad" ? `a new ad set per ad, copied from "${s.adsetName ?? "?"}"` : (s.adsetName ?? "no ad set picked")}${s.extraAdsets?.length ? `; the same ads also go into ${s.extraAdsets.map((x) => `"${x.name}" (${x.campaignName})`).join(", ")}` : ""}`);
  lines.push(`Settings preset: ${s.preset?.name ?? "none"}. Time estimate: ${v.preview.estimate.label}${v.preview.estimate.rateLimited ? " (Meta's speed limit for new apps sets the pace)" : ""}.`);
  lines.push(`Open in the app to check or regroup by dragging: ${v.links.app}`);
  lines.push("");
  for (const c of v.preview.batchChecks) lines.push(`${c.level === "error" ? "ERROR" : "Warning"}: ${c.message}`);
  lines.push("| # | Name in Meta | Files (ratio → placement) | Copy | Problems |");
  lines.push("|---|---|---|---|---|");
  for (const a of v.ads) {
    const files = a.files.map((f) => `${f.filename} (${f.ratio?.replace("x", ":") ?? "?"} → ${f.placement})`).join("; ");
    const copy = `${a.copy.primaryTexts.length} texts, ${a.copy.headlines.length} headlines → ${a.copy.linkUrl || "no link"}`;
    const probs = a.checks.map((c) => `${c.level === "error" ? "ERROR" : "Warning"}: ${c.message}`).join(" / ") || "none";
    lines.push(`| ${a.position} | ${a.metaName} | ${files} | ${copy} | ${probs} |`);
  }
  lines.push("");
  if (sum) lines.push(summaryText(sum), "");
  const spend = sum?.launch?.spendConfirmation ? `, and spend_confirmation: "${sum.launch.spendConfirmation}" (the total daily budget, said by the person; never fill it in yourself)` : "";
  if (v.preview.errors) lines.push(`${v.preview.errors} error(s) block the launch. Fix them in the app (link above) or change the settings with preview_batch.`);
  else if (v.preview.warnings) lines.push(`${v.preview.warnings} warning(s). Show the summary and the warnings to the person; launch only with their explicit yes (launch_batch with confirm: true and accept_warnings: true${spend}).`);
  else lines.push(`No problems found. Show the summary to the person and ask for an explicit yes, then call launch_batch with confirm: true${spend}.`);
  return lines.join("\n");
}

function statusText(v: View): string {
  const p = v.progress;
  const lines = [`Batch ${v.key}: ${v.statusLabel}. ${p.done} of ${p.total} ads created${p.failed ? `, ${p.failed} failed` : ""}${p.working ? `, ${p.working} in progress` : ""}.`];
  if (v.status === "queued" || v.status === "running") lines.push(`Estimate at launch: ${v.launchEstimate ?? "unknown"}. Still to do: ${v.preview.estimate.label}. Progress is live at ${v.links.app}`);
  if (v.links.campaign) lines.push(`Campaign in Ads Manager: ${v.links.campaign}`);
  for (const a of v.ads) {
    const parts = [`${a.position}. ${a.metaName}: ${a.status === "done" ? `created, ${a.reviewLabel}` : a.status === "failed" ? `FAILED: ${a.error}` : (a.step ?? a.status)}`];
    if (a.adsManagerUrl) parts.push(a.adsManagerUrl);
    for (const i of a.reviewIssues) parts.push(`Meta review: ${i}`);
    for (const w of a.featureWarnings) parts.push(`Warning: ${w}`);
    lines.push(parts.join(" · "));
  }
  if (v.status === "done" || v.status === "partial" || v.status === "failed") {
    lines.push(`What happened: ${p.done} ad(s) created${p.failed ? `, ${p.failed} not created (reasons above)` : ""}.`);
    if (p.failed) lines.push(`Next: fix the cause named in each failure, then call retry_failed (or press "Retry failed" in the app: ${v.links.app}). Ads that went through are never duplicated.`);
    lines.push(v.settings.goLive === "paused" ? "Created ads are PAUSED. Turn them on in Ads Manager, or with plan_changes (set_status ACTIVE) and confirm_plan." : "The ads are turned on by a plan once every ad is in (plan_status shows it).");
  }
  for (const t of v.together ?? []) lines.push(`Launched together: batch ${t.key} → ad set "${t.adsetName}" (${t.status}).`);
  return lines.join("\n");
}

export function registerTools(server: McpServer, api: LauncherApi) {
  registerManageTools(server, api);
  server.registerTool(
    "list_destinations",
    {
      title: "List campaigns and ad sets",
      description: "List the Meta campaigns and ad sets in the Sahajta ad account that ads can be launched into. Ad sets with Dynamic creative switched on can't be used.",
      inputSchema: { refresh: z.boolean().optional().describe("Re-read from Meta instead of the 5-minute cache") },
      annotations: { readOnlyHint: true },
    },
    async ({ refresh }) => {
      try {
        const d = await api.call<{ campaigns: { id: string; name: string; status: string; adsets: { id: string; name: string; status: string; isDynamicCreative: boolean }[] }[] }>("GET", `/api/destinations${refresh ? "?refresh=1" : ""}`);
        const lines = d.campaigns.map((c) => [`Campaign "${c.name}" (id ${c.id}, ${c.status.toLowerCase()})`, ...c.adsets.map((a) => `  - Ad set "${a.name}" (id ${a.id}, ${a.status.toLowerCase()})${a.isDynamicCreative ? " [Dynamic creative: can't use]" : ""}`)].join("\n"));
        return text(lines.join("\n") || "No active or paused campaigns found.");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_templates",
    {
      title: "List copy, naming and settings presets",
      description: "List saved copy templates (primary texts, headlines, link, call to action), naming templates and Meta settings presets (Page, Instagram account, AI enhancements).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const t = await api.call<{
          copy: { id: number; name: string; primaryTexts: string[]; headlines: string[]; linkUrl: string; cta: string }[];
          naming: { id: number; name: string; kind: string; pattern: string; is_default: number }[];
          presets: { id: number; name: string; pageName: string; igName: string; enhancementsOn: string[]; multiAdvertiser: boolean; isDefault: boolean }[];
          features: { key: string; label: string }[];
          tokens: { token: string; meaning: string }[];
        }>("GET", "/api/templates");
        const out = [
          "Copy templates:",
          ...t.copy.map((c) => `  - "${c.name}" (id ${c.id}): ${c.primaryTexts.length} primary texts, ${c.headlines.length} headlines, ${c.cta} → ${c.linkUrl}\n    First text: ${c.primaryTexts[0] ?? "(none)"}`),
          "Naming templates:",
          ...t.naming.map((n) => `  - ${n.kind === "ad" ? "Ad" : n.kind === "adset" ? "Ad set" : "Campaign"} "${n.name}" (id ${n.id}): ${n.pattern}${n.is_default ? " (default)" : ""}`),
          "Settings presets:",
          ...t.presets.map((p) => `  - "${p.name}" (id ${p.id})${p.isDefault ? " (default)" : ""}: Page ${p.pageName || "not set"}, Instagram ${p.igName || "not set"}, AI enhancements ${p.enhancementsOn.length ? p.enhancementsOn.join(", ") + " on" : "all off"}, multi-advertiser ${p.multiAdvertiser ? "on" : "off"}`),
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
    "preview_batch",
    {
      title: "Preview a batch",
      description:
        "Build a batch from a Google Drive folder link (or update a batch already in the app) and return the preview and the pre-launch summary: connected ad account, Page and Instagram; campaign; every ad set's budget, bid, schedule, audience and placements; the TOTAL daily budget; copy and links; every ad with its name, files, warnings and errors; a time estimate and a link to the app. Creates nothing in Meta. Always show the summary to the person before launching. Ad sets, copy templates and presets can be given by name or id. Use more_ad_sets to put the same ads into several ad sets, and go_live to launch them on now or at a set time instead of paused.",
      inputSchema: {
        drive_folder_url: z.string().optional().describe("Google Drive folder link. Creates a new batch."),
        batch_id: z.string().optional().describe("Code of a batch already in the app, e.g. k4r94. Use to change settings and preview again."),
        ad_set: z.string().optional().describe("Ad set name or id to launch into (or the template ad set when new_ad_set_per_ad is true)"),
        new_ad_set_per_ad: z.boolean().optional().describe("Create one new paused ad set per ad, copied from ad_set"),
        copy_template: z.string().optional().describe("Copy template name or id"),
        settings_preset: z.string().optional().describe("Settings preset name or id (default preset if left out)"),
        angle: z.string().optional().describe("Angle word for the {angle} part of names"),
        ad_name_template: z.string().optional().describe("Naming pattern for ads, e.g. {date}_{creative}_{angle}_{format}"),
        adset_name_template: z.string().optional().describe("Naming pattern for new ad sets"),
        persona: z.string().optional().describe("Persona word for the {persona} part of names"),
        more_ad_sets: z.array(z.string()).optional().describe("More ad sets (names or ids) that get the same ads, in one launch"),
        go_live: z.enum(["paused", "now", "at"]).optional().describe("paused (default): create everything paused. now: turn the ads on once all are created. at: turn them on at go_live_at."),
        go_live_at: z.string().optional().describe("ISO time for go_live 'at', e.g. 2026-11-20T09:00:00+05:30"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (a) => {
      try {
        if (!a.drive_folder_url && !a.batch_id) return fail("Give drive_folder_url (new batch) or batch_id (existing batch).");
        const settings = {
          adsetId: a.ad_set,
          adsetMode: a.new_ad_set_per_ad === undefined ? undefined : a.new_ad_set_per_ad ? "new_per_ad" : "existing",
          copyTemplateId: a.copy_template,
          presetId: a.settings_preset,
          angle: a.angle,
          adNameTemplate: a.ad_name_template,
          adsetNameTemplate: a.adset_name_template,
          persona: a.persona,
          extraAdsetIds: a.more_ad_sets,
          goLive: a.go_live,
          goLiveAt: a.go_live_at,
        };
        let key = a.batch_id;
        if (a.drive_folder_url) key = (await api.call<View>("POST", "/api/batches", { driveFolder: a.drive_folder_url, ...settings })).key;
        else await api.call<View>("PATCH", `/api/batches/${key}`, settings);
        const v = await api.call<View>("POST", `/api/batches/${key}/preview`);
        const sum = await api.call<LaunchSum>("GET", `/api/batches/${key}/summary`).catch(() => undefined);
        return text(previewText(v, sum));
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
        "Launch a batch that was previewed with preview_batch. Ads are created PAUSED; if the batch's go_live is now or at a time, they are turned on once every ad is in. Only call this after the person has seen the pre-launch summary and said yes. Needs confirm: true; accept_warnings: true if the preview had warnings and the person accepted them; and for go_live now/at, spend_confirmation: the total daily budget exactly as the summary shows it, as the person confirmed it (never fill it in yourself). Returns at once; the launch runs in the background (use batch_status).",
      inputSchema: {
        batch_id: z.string().describe("Batch code from preview_batch, e.g. k4r94"),
        confirm: z.literal(true).describe("Must be true: the person confirmed the launch"),
        accept_warnings: z.boolean().optional().describe("True if the person accepted the preview's warnings"),
        spend_confirmation: z.string().optional().describe("Total daily budget as shown in the summary, e.g. ₹15,000; needed when the ads will be turned on"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ batch_id, confirm, accept_warnings, spend_confirmation }) => {
      try {
        const v = await api.call<View>("POST", `/api/batches/${batch_id}/launch`, { confirm, acceptWarnings: accept_warnings ?? false, spendConfirmation: spend_confirmation });
        const live = v.settings.goLive === "now" ? "created paused and turned on once all are in" : v.settings.goLive === "at" ? `created paused and turned on at ${v.settings.goLiveAt}` : "all PAUSED";
        return text(`Launch started for batch ${v.key}: ${v.ads.length} ads, ${live}.${v.together?.length ? ` Also launching ${v.together.map((t) => `${t.key} → "${t.adsetName}"`).join(", ")}.` : ""} Estimated time: ${v.preview.estimate.label}. Live progress: ${v.links.app}\nUse batch_status to check progress.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "batch_status",
    {
      title: "Batch progress and results",
      description: "Progress and results of a batch: which ads were created (with Ads Manager links and Meta's review status), which failed and why.",
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
}
