import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// The five launcher tools for Claude. Shared by the Claude Desktop extension (stdio, mcp/)
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
  settings: { campaignName: string | null; adsetMode: string; adsetName: string | null; copyTemplateId: number | null; preset: { name: string } | null };
  preview: { batchChecks: Check[]; errors: number; warnings: number; estimate: { label: string; rateLimited: boolean } };
  launchEstimate: string | null;
  progress: { total: number; done: number; failed: number; working: number };
  links: { app: string; campaign: string | null };
  ads: ViewAd[];
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true });

function previewText(v: View): string {
  const s = v.settings;
  const lines: string[] = [];
  lines.push(`Batch ${v.key} (${v.source.kind === "drive" ? `Drive folder "${v.source.label}"` : "uploaded files"}): ${v.ads.length} ads, all to be created PAUSED.`);
  lines.push(`Destination: ${s.campaignName ?? "no campaign picked"} → ${s.adsetMode === "new_per_ad" ? `a new ad set per ad, copied from "${s.adsetName ?? "?"}"` : (s.adsetName ?? "no ad set picked")}`);
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
  if (v.preview.errors) lines.push(`${v.preview.errors} error(s) block the launch. Fix them in the app (link above) or change the settings with preview_batch.`);
  else if (v.preview.warnings) lines.push(`${v.preview.warnings} warning(s). Show them to the person; launch only with their OK (launch_batch with confirm: true and accept_warnings: true).`);
  else lines.push("No problems found. Ask the person to confirm, then call launch_batch with confirm: true.");
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
  if (p.failed && v.status !== "running" && v.status !== "queued") lines.push(`Failed ads can be retried with "Retry failed only" in the app: ${v.links.app} (ads that went through are never duplicated).`);
  if (v.status === "done" || v.status === "partial") lines.push("All created ads are PAUSED. The person reviews them in Ads Manager and switches them on there.");
  return lines.join("\n");
}

export function registerTools(server: McpServer, api: LauncherApi) {
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
        }>("GET", "/api/templates");
        const out = [
          "Copy templates:",
          ...t.copy.map((c) => `  - "${c.name}" (id ${c.id}): ${c.primaryTexts.length} primary texts, ${c.headlines.length} headlines, ${c.cta} → ${c.linkUrl}\n    First text: ${c.primaryTexts[0] ?? "(none)"}`),
          "Naming templates:",
          ...t.naming.map((n) => `  - ${n.kind === "ad" ? "Ad" : "Ad set"} "${n.name}": ${n.pattern}${n.is_default ? " (default)" : ""}`),
          "Settings presets:",
          ...t.presets.map((p) => `  - "${p.name}" (id ${p.id})${p.isDefault ? " (default)" : ""}: Page ${p.pageName || "not set"}, Instagram ${p.igName || "not set"}, AI enhancements ${p.enhancementsOn.length ? p.enhancementsOn.join(", ") + " on" : "all off"}, multi-advertiser ${p.multiAdvertiser ? "on" : "off"}`),
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
        "Build a batch from a Google Drive folder link (or update a batch already in the app) and return the preview: every ad with its name, files, copy, destination, warnings and errors, plus a time estimate and a link to open it in the app (where files can be regrouped by dragging). Creates nothing in Meta. Always show the preview to the person before launching. Ad sets, copy templates and presets can be given by name or id.",
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
        };
        let key = a.batch_id;
        if (a.drive_folder_url) key = (await api.call<View>("POST", "/api/batches", { driveFolder: a.drive_folder_url, ...settings })).key;
        else await api.call<View>("PATCH", `/api/batches/${key}`, settings);
        const v = await api.call<View>("POST", `/api/batches/${key}/preview`);
        return text(previewText(v));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "launch_batch",
    {
      title: "Launch a previewed batch (paused)",
      description:
        "Launch a batch that was previewed with preview_batch. Every ad and ad set is created PAUSED; nothing goes live. Only call this after the person has seen the preview and said yes. Needs confirm: true. If the preview had warnings, also needs accept_warnings: true after the person accepted them. Returns at once; the launch runs in the background (use batch_status).",
      inputSchema: {
        batch_id: z.string().describe("Batch code from preview_batch, e.g. k4r94"),
        confirm: z.literal(true).describe("Must be true: the person confirmed the launch"),
        accept_warnings: z.boolean().optional().describe("True if the person accepted the preview's warnings"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ batch_id, confirm, accept_warnings }) => {
      try {
        const v = await api.call<View>("POST", `/api/batches/${batch_id}/launch`, { confirm, acceptWarnings: accept_warnings ?? false });
        return text(`Launch started for batch ${v.key}: ${v.ads.length} ads, all PAUSED. Estimated time: ${v.preview.estimate.label}. Live progress: ${v.links.app}\nUse batch_status to check progress.`);
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
