import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LauncherApi } from "./tools";

// Claude tools for everything beyond "launch a folder of creatives": the connection, templates
// and presets, per-ad copy, batch control, campaigns and ad sets (through change plans), and results.
// Every change in Meta goes through a plan: plan_changes shows the summary, confirm_plan runs it
// only after the person's explicit yes. Nothing can be deleted or archived.

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true });
const run = (f: () => Promise<string>) => f().then(text).catch(fail);

interface Connection {
  connected: boolean;
  adAccount: { id: string; name: string; adsManagerLink: string } | null;
  page: { id: string; name: string; pictureUrl: string | null; link: string } | null;
  instagram: { id: string; username: string; pictureUrl: string | null; link: string; allowed: boolean | null } | null;
  loginBy: string | null;
  loginExpiresAt: string | null;
  loginExpired: boolean;
  problems: string[];
}

export function connectionText(c: Connection): string {
  if (!c.connected) return c.problems.join(" ");
  const lines = [
    `Ad account: ${c.adAccount!.name} (ID ${c.adAccount!.id.replace("act_", "")}) · ${c.adAccount!.adsManagerLink}`,
    c.page ? `Facebook Page: ${c.page.name} (ID ${c.page.id}) · ${c.page.link}${c.page.pictureUrl ? ` · picture: ${c.page.pictureUrl}` : ""}` : "Facebook Page: not set",
    c.instagram
      ? `Instagram: @${c.instagram.username} (ID ${c.instagram.id}) · ${c.instagram.link}${c.instagram.pictureUrl ? ` · picture: ${c.instagram.pictureUrl}` : ""}${c.instagram.allowed === false ? " · NOT ALLOWED for this ad account" : c.instagram.allowed ? " · allowed for this ad account" : ""}`
      : "Instagram: none (Instagram placements use the Facebook Page)",
    `Meta login: ${c.loginBy ?? "?"}, ${c.loginExpired ? "EXPIRED" : c.loginExpiresAt ? `works until ${new Date(c.loginExpiresAt).toDateString()}` : "does not expire"}`,
  ];
  for (const p of c.problems) lines.push(`PROBLEM: ${p}`);
  return lines.join("\n");
}

interface PlanView {
  key: string;
  title: string;
  status: string;
  statusLabel: string;
  canSpend: boolean;
  runAt: string | null;
  link: string;
  summary: {
    account: { id: string; name: string; currency: string };
    steps: { n: number; title: string; lines: string[] }[];
    adsets: { step: number; name: string; campaign: string; dailyBudget: number | null; lifetimeBudget: number | null; details: Record<string, string> }[];
    totals: { campaigns: number; adsets: number; ads: number; dailyBudget: number; lifetimeBudget: number; spendNowDaily: number; turnsOn: string[] };
    checks: { level: string; message: string }[];
    errors: number;
    warnings: number;
    canSpend: boolean;
    spendConfirmation: string | null;
  } | null;
  progress: { n: number; title: string; status: string; message: string; ids: string[] }[];
}

function planText(v: PlanView): string {
  const s = v.summary;
  const out = [`Plan ${v.key}: ${v.title}. Status: ${v.statusLabel}. Open in the app: ${v.link}`];
  if (!s) return out.join("\n");
  const cur = s.account.currency === "INR" ? "₹" : `${s.account.currency} `;
  const m = (x: number | null) => (x === null ? "" : `${cur}${x.toLocaleString("en-IN")}`);
  out.push(`Ad account: ${s.account.name} (${s.account.id.replace("act_", "")}).`);
  for (const st of s.steps) {
    out.push(`${st.n ? `Step ${st.n}` : "When"}: ${st.title}`);
    for (const l of st.lines) out.push(`   ${l}`);
  }
  if (s.adsets.length) {
    out.push("", "| Step | Ad set | Campaign | Daily budget | Lifetime | Bid | Schedule | Audience | Placements |", "|---|---|---|---|---|---|---|---|---|");
    for (const a of s.adsets) out.push(`| ${a.step} | ${a.name} | ${a.campaign} | ${m(a.dailyBudget)} | ${m(a.lifetimeBudget)} | ${a.details.bid ?? ""} | ${a.details.schedule ?? ""} | ${a.details.audience ?? a.details.change ?? a.details.status ?? ""} | ${a.details.placements ?? ""} |`);
  }
  out.push("", `TOTAL daily budget in this plan (ad sets, and campaign budgets): ${m(s.totals.dailyBudget)}${s.totals.lifetimeBudget ? ` (plus ${m(s.totals.lifetimeBudget)} lifetime)` : ""}. ${s.totals.campaigns} campaign(s), ${s.totals.adsets} new ad set(s), ${s.totals.ads} ad(s).`);
  if (s.totals.turnsOn.length) out.push(`TURNS ON: ${s.totals.turnsOn.join("; ")}. Daily budget able to spend afterwards: ${m(s.totals.spendNowDaily)}.`);
  for (const c of s.checks) out.push(`${c.level === "error" ? "ERROR" : "Warning"}: ${c.message}`);
  if (v.status === "draft") {
    if (s.errors) out.push(`\n${s.errors} error(s): fix them with update_plan before it can run.`);
    else
      out.push(
        `\nNothing has changed in Meta yet. Show this whole summary to the person (every budget and the total). Run it only after they say yes: confirm_plan with confirm: true${s.warnings ? ", accept_warnings: true (after they accepted the warnings)" : ""}${s.canSpend ? `, and spend_confirmation: "${s.spendConfirmation}" — the person must say this total themselves; do not fill it in for them` : ""}.`,
      );
  } else {
    out.push("", "Progress:");
    for (const p of v.progress) out.push(`  ${p.n}. ${p.title}: ${p.status}${p.message ? ` · ${p.message}` : ""}${p.ids.length ? ` · IDs ${p.ids.slice(0, 20).join(", ")}${p.ids.length > 20 ? "…" : ""}` : ""}`);
  }
  return out.join("\n");
}

const opsDescription = `List of steps, run in order. Each step is an object with "type" and its fields. Money is in the account currency (rupees), not paise. Dates are ISO with time zone, e.g. 2026-11-20T09:00:00+05:30. Use list_options for allowed values and lookup for IDs (pixels, audiences, interests, locations).
Types:
- create_campaign: name or name_template, objective (OUTCOME_LEADS…), budget_level "campaign" (CBO, give daily_budget or lifetime_budget+stop_time) or "adset" (ABO), bid_strategy, special_ad_categories, spend_cap, status (PAUSED default), ref (a label later steps use as "$label").
- edit_campaign: campaign (id or "$ref"), any of name, daily_budget, lifetime_budget, bid_strategy, spend_cap, stop_time, status.
- duplicate_campaign: campaign, copies (number) or changes (one object per copy with name/daily_budget/bid_strategy/status…), with_contents (true = copy its ad sets and ads), name_template, ref.
- create_adset: campaign (id or "$ref"), name or name_template, daily_budget or lifetime_budget (+end_time) unless the campaign has a campaign budget, start_time, end_time, destination (WEBSITE, ON_AD for instant forms, WHATSAPP…), goal (LEAD_GENERATION, OFFSITE_CONVERSIONS, LANDING_PAGE_VIEWS…), pixel_id + event (LEAD…) or custom_conversion_id, page_id, bid_strategy + bid_amount, saved_audience_id, countries, regions, cities ({key, radius}), age_min, age_max, genders (all|men|women), interests ([{id,name}]), custom_audiences, excluded_custom_audiences, advantage_audience (true/false), placements ("advantage" or {platforms, facebook_positions, instagram_positions}), attribution (7d_click_1d_view…), min_daily_spend, max_daily_spend, targeting (raw Meta targeting), status, persona, ref.
- edit_adset: adset (id or "$ref") and any create_adset field to change (budget, bid, schedule, audience, placements, goal, status, name).
- duplicate_adset: adset, campaign (target; default the same), copies or changes (one object per copy; each may change name, budget, bid, audience, schedule, status…; anything not given keeps the original), with_ads, name_template (e.g. "{campaign}_{persona}_{budget}_{n}"), ref.
- ads_from_post: post_id (Facebook "pageid_postid", or a post id plus page_id; or an Instagram media id with source "instagram" and instagram_user_id), adsets (ids or "$ref"), name or name_template ({adset}, {n}), status. One creative, so engagement adds up on the one post.
- set_status: status ACTIVE (turn on) or PAUSED (turn off), with campaigns, adsets, ads (id lists) and/or whole_campaigns (campaign + all its ad sets + all its ads).
Nothing can be deleted or archived.`;

export function registerManageTools(server: McpServer, api: LauncherApi) {
  server.registerTool(
    "connection_status",
    {
      title: "What the launcher is connected to",
      description:
        "Shows the connected Meta ad account (name, ID), the Facebook Page and Instagram account in use (name, ID, profile picture link, direct link, and whether the ad account may use that Instagram account), and when the Meta login expires. Call this before every preview and launch, and include it in the pre-launch summary so the person can check the right accounts are used.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(async () => connectionText(await api.call<Connection>("GET", "/api/connection"))),
  );

  // ---------- Templates and presets ----------

  server.registerTool(
    "save_copy_template",
    {
      title: "Create or edit a copy template",
      description:
        "Create a copy template, or edit one (give its id or exact name; fields left out keep their value). Up to 5 primary texts and 5 headlines. utm_template is added to every ad's link; Meta fills {{campaign.name}}, {{adset.name}}, {{ad.name}}, {{ad.id}} itself. New templates get UTM tags by default.",
      inputSchema: {
        template: z.string().optional().describe("Id or name of the template to edit. Leave out to create a new one."),
        name: z.string().optional(),
        primary_texts: z.array(z.string()).max(5).optional(),
        headlines: z.array(z.string()).max(5).optional(),
        description: z.string().optional(),
        link_url: z.string().optional(),
        cta: z.string().optional().describe("Call to action, e.g. LEARN_MORE, SIGN_UP, GET_QUOTE, BOOK_NOW, CONTACT_US, WHATSAPP_MESSAGE"),
        utm_template: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) =>
      run(async () => {
        const t = await api.call<{ copy: { id: number; name: string; primaryTexts: string[]; headlines: string[]; description: string; cta: string; linkUrl: string; utmTemplate: string }[] }>("GET", "/api/templates");
        const cur = a.template ? t.copy.find((c) => String(c.id) === a.template || c.name.toLowerCase() === a.template!.toLowerCase()) : undefined;
        if (a.template && !cur) throw new Error(`No copy template "${a.template}". Existing: ${t.copy.map((c) => c.name).join(", ") || "none"}.`);
        const body = {
          kind: "copy",
          id: cur?.id,
          name: a.name ?? cur?.name ?? "",
          primaryTexts: a.primary_texts ?? cur?.primaryTexts ?? [],
          headlines: a.headlines ?? cur?.headlines ?? [],
          description: a.description ?? cur?.description ?? "",
          cta: a.cta ?? cur?.cta ?? "LEARN_MORE",
          linkUrl: a.link_url ?? cur?.linkUrl ?? "",
          ...(a.utm_template !== undefined || cur ? { utmTemplate: a.utm_template ?? cur?.utmTemplate ?? "" } : {}),
        };
        const r = await api.call<{ id: number }>("POST", "/api/templates", body);
        return `${cur ? "Updated" : "Created"} copy template "${body.name}" (id ${r.id}): ${body.primaryTexts.length} primary text(s), ${body.headlines.length} headline(s), ${body.cta} → ${body.linkUrl || "no link"}.`;
      }),
  );

  server.registerTool(
    "save_naming_template",
    {
      title: "Create or edit a naming template",
      description:
        "Naming templates for ads, ad sets and campaigns. Words in braces are filled in: {date} (also {date:YYMMDD}), {n} (auto-number 01, 02…), {creative}, {angle}, {persona}, {format}, {campaign}, {adset}, {objective}, {budget}, {copy}, {batch}. Give template (id or name) to edit one.",
      inputSchema: {
        template: z.string().optional(),
        kind: z.enum(["ad", "adset", "campaign"]).optional(),
        name: z.string().optional(),
        pattern: z.string().optional().describe('e.g. "{date}_{persona}_{angle}_{n}"'),
        is_default: z.boolean().optional().describe("Use for new batches and plans by default"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) =>
      run(async () => {
        const t = await api.call<{ naming: { id: number; name: string; kind: "ad" | "adset" | "campaign"; pattern: string; is_default: number }[] }>("GET", "/api/templates");
        const cur = a.template ? t.naming.find((n) => String(n.id) === a.template || n.name.toLowerCase() === a.template!.toLowerCase()) : undefined;
        if (a.template && !cur) throw new Error(`No naming template "${a.template}".`);
        const body = { kind: "naming", id: cur?.id, namingKind: a.kind ?? cur?.kind ?? "ad", name: a.name ?? cur?.name ?? "", pattern: a.pattern ?? cur?.pattern ?? "", isDefault: a.is_default };
        const r = await api.call<{ id: number }>("POST", "/api/templates", body);
        return `${cur ? "Updated" : "Created"} ${body.namingKind} naming template "${body.name}" (id ${r.id}): ${body.pattern}${a.is_default ? " (default)" : ""}.`;
      }),
  );

  server.registerTool(
    "save_settings_preset",
    {
      title: "Create or edit a settings preset",
      description:
        "Ad-level Meta settings used for every ad of a batch: Facebook Page, Instagram account, each Advantage+ creative enhancement on or off, and multi-advertiser ads. Give preset (id or name) to edit; fields left out keep their value. list_templates shows the enhancement keys. Use connection_status / lookup pages for Page and Instagram IDs.",
      inputSchema: {
        preset: z.string().optional(),
        name: z.string().optional(),
        page_id: z.string().optional(),
        page_name: z.string().optional(),
        instagram_id: z.string().optional().describe('Instagram account ID, or "none" to use the Facebook Page on Instagram'),
        instagram_username: z.string().optional(),
        enhancements_on: z.array(z.string()).optional().describe("Enhancement keys to switch ON. Every other one is sent OFF. [] = all off."),
        switch_on: z.array(z.string()).optional().describe("Switch these on, keep the rest as they are"),
        switch_off: z.array(z.string()).optional().describe("Switch these off, keep the rest as they are"),
        multi_advertiser: z.boolean().optional(),
        is_default: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) =>
      run(async () => {
        const t = await api.call<{ presets: { id: number; name: string; pageId: string; pageName: string; igUserId: string; igName: string; enhancementsOn: string[]; multiAdvertiser: boolean; isDefault: boolean }[]; features: { key: string; label: string }[] }>("GET", "/api/templates");
        const cur = a.preset ? t.presets.find((p) => String(p.id) === a.preset || p.name.toLowerCase() === a.preset!.toLowerCase()) : undefined;
        if (a.preset && !cur) throw new Error(`No preset "${a.preset}". Existing: ${t.presets.map((p) => p.name).join(", ")}.`);
        const on = new Set(a.enhancements_on ?? cur?.enhancementsOn ?? []);
        for (const k of a.switch_on ?? []) on.add(k);
        for (const k of a.switch_off ?? []) on.delete(k);
        const noIg = a.instagram_id === "none";
        const body = {
          kind: "preset",
          id: cur?.id,
          name: a.name ?? cur?.name ?? "",
          pageId: a.page_id ?? cur?.pageId ?? "",
          pageName: a.page_name ?? cur?.pageName ?? "",
          igUserId: noIg ? "" : (a.instagram_id ?? cur?.igUserId ?? ""),
          igName: noIg ? "" : (a.instagram_username ?? cur?.igName ?? ""),
          enhancements: Object.fromEntries([...on].map((k) => [k, "OPT_IN"])),
          multiAdvertiser: a.multi_advertiser ?? cur?.multiAdvertiser ?? false,
          isDefault: a.is_default,
        };
        const r = await api.call<{ id: number }>("POST", "/api/templates", body);
        const labels = new Map(t.features.map((f) => [f.key, f.label]));
        return `${cur ? "Updated" : "Created"} preset "${body.name}" (id ${r.id}). Page ${body.pageName || body.pageId || "not set"}, Instagram ${body.igName ? `@${body.igName}` : "none"}. Enhancements ON: ${[...on].map((k) => labels.get(k) ?? k).join("; ") || "none (all off)"}. Multi-advertiser ads ${body.multiAdvertiser ? "on" : "off"}.`;
      }),
  );

  // ---------- Batch control ----------

  server.registerTool(
    "set_ad_copy",
    {
      title: "Set copy per ad in a batch",
      description:
        "Give ads in a draft batch their own copy: primary texts (up to 5), headlines (up to 5), description, link, call to action. Each row names the ad by its number in the preview or by creative / file name. Fields left out use the batch's copy template. Use this when every ad has its own copy, e.g. from a sheet the person pasted.",
      inputSchema: {
        batch_id: z.string(),
        rows: z
          .array(
            z.object({
              ad: z.union([z.string(), z.number()]).describe("Ad number or creative/file name"),
              primary_texts: z.array(z.string()).max(5).optional(),
              headlines: z.array(z.string()).max(5).optional(),
              description: z.string().optional(),
              link_url: z.string().optional(),
              cta: z.string().optional(),
              angle: z.string().optional(),
            }),
          )
          .min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ batch_id, rows }) =>
      run(async () => {
        const body = {
          rows: rows.map((r) => ({
            ad: r.ad,
            angle: r.angle,
            copy: { primaryTexts: r.primary_texts, headlines: r.headlines, description: r.description, linkUrl: r.link_url, cta: r.cta },
          })),
        };
        await api.call("POST", `/api/batches/${batch_id}/copy`, body);
        return `Saved copy for ${rows.length} ad(s) in batch ${batch_id}. Run preview_batch with batch_id to see the result.`;
      }),
  );

  server.registerTool(
    "regroup_files",
    {
      title: "Move a file to another ad",
      description: "Change which files go together in one ad (e.g. which 9:16 and 4:5 versions pair up) in a draft batch. Move a file into ad number N, or into an ad of its own.",
      inputSchema: { batch_id: z.string(), file: z.string().describe("File name, e.g. hook-01_4x5.mp4"), to: z.union([z.number(), z.literal("new")]).describe('Ad number, or "new" for an ad of its own') },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ batch_id, file, to }) =>
      run(async () => {
        await api.call("POST", `/api/batches/${batch_id}/regroup`, { file, to });
        return `Moved ${file} ${to === "new" ? "into an ad of its own" : `into ad ${to}`}. Run preview_batch with batch_id ${batch_id} to see the new grouping.`;
      }),
  );

  server.registerTool(
    "retry_failed",
    {
      title: "Retry the failed ads of a batch",
      description: "Create the ads of a batch that failed or were not reached. Ads already created are never made again. Fix the cause first (batch_status shows it).",
      inputSchema: { batch_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ batch_id }) =>
      run(async () => {
        const v = await api.call<{ key: string; progress: { total: number; done: number } }>("POST", `/api/batches/${batch_id}/retry`);
        return `Retrying batch ${v.key}: ${v.progress.total - v.progress.done} ad(s) to create. Use batch_status to follow it.`;
      }),
  );

  server.registerTool(
    "cancel_batch",
    {
      title: "Stop a running launch",
      description: "Stop a batch that is launching. It stops after the current step; ads already created stay (paused); nothing is deleted. retry_failed continues it later.",
      inputSchema: { batch_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ batch_id }) =>
      run(async () => {
        const v = await api.call<{ key: string; status: string; progress: { done: number; total: number } }>("POST", `/api/batches/${batch_id}/cancel`);
        return `Batch ${v.key}: ${v.status === "running" ? "stopping after the current step" : "stopped"}. ${v.progress.done} of ${v.progress.total} ads were created and stay paused.`;
      }),
  );

  // ---------- Campaigns, ad sets, plans ----------

  server.registerTool(
    "list_campaigns",
    {
      title: "Campaigns and ad sets with budgets",
      description: "Every campaign (not deleted) with its ad sets: status, budget (campaign or ad set), bid, schedule, goal, audience and placements in plain words, plus IDs to use in plans.",
      inputSchema: { campaign: z.string().optional().describe("Only campaigns whose name or id contains this"), refresh: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ campaign, refresh }) =>
      run(async () => {
        type T = { currency: string; campaigns: { id: string; name: string; status: string; effectiveStatus: string; cbo: boolean; details: Record<string, string>; adsets: { id: string; name: string; status: string; details: Record<string, string> }[] }[] };
        const t = await api.call<T>("GET", `/api/manage/tree${refresh ? "?refresh=1" : ""}`);
        const q = campaign?.toLowerCase();
        const list = t.campaigns.filter((c) => !q || c.id === q || c.name.toLowerCase().includes(q));
        if (!list.length) return "No campaigns found.";
        return list
          .map((c) =>
            [
              `Campaign "${c.name}" (id ${c.id}) · ${c.status.toLowerCase()} · ${c.details.objective} · budget ${c.details.budget} · bid ${c.details.bid}`,
              ...c.adsets.map((a) => `  - Ad set "${a.name}" (id ${a.id}) · ${a.status.toLowerCase()} · ${a.details.budget} · ${a.details.bid} · ${a.details.schedule} · goal ${a.details.goal} · audience ${a.details.audience} · placements ${a.details.placements}`),
            ].join("\n"),
          )
          .join("\n");
      }),
  );

  server.registerTool(
    "get_details",
    {
      title: "Every setting of a campaign or ad set",
      description: "All settings of one campaign or ad set, in plain words and as Meta's raw fields (targeting, promoted object, attribution, spend limits).",
      inputSchema: { kind: z.enum(["campaign", "adset"]), id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, id }) =>
      run(async () => {
        const d = await api.call<{ plain: Record<string, string>; raw: unknown }>("GET", `/api/manage/object/${kind}/${id}`);
        return `${Object.entries(d.plain).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nRaw: ${JSON.stringify(d.raw)}`;
      }),
  );

  server.registerTool(
    "list_options",
    {
      title: "Allowed values for campaigns and ad sets",
      description: "Objectives, bid strategies, special ad categories, conversion locations (destination), performance goals, website pixel events, attribution windows and placement platforms, with plain labels.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const o = await api.call<Record<string, { value: string; label: string; note?: string }[]>>("GET", "/api/manage/options");
        return Object.entries(o).map(([k, list]) => `${k}:\n${list.map((x) => `  ${x.value} = ${x.label}${x.note ? ` (${x.note})` : ""}`).join("\n")}`).join("\n");
      }),
  );

  server.registerTool(
    "lookup",
    {
      title: "Look up audiences, pixels, interests, locations",
      description: "IDs for plans: saved_audiences, custom_audiences (incl. lookalikes), pixels, custom_conversions, interests (search with q), locations (search with q: countries, regions, cities), pages.",
      inputSchema: { what: z.enum(["saved_audiences", "custom_audiences", "pixels", "custom_conversions", "interests", "locations", "pages"]), q: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ what, q }) =>
      run(async () => {
        const r = await api.call<{ items: Record<string, unknown>[] }>("GET", `/api/manage/lookup?what=${what}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
        if (!r.items.length) return "Nothing found.";
        return r.items.slice(0, 50).map((i) => JSON.stringify(i.targeting ? { ...i, targeting: "(saved targeting)" } : i)).join("\n");
      }),
  );

  server.registerTool(
    "plan_changes",
    {
      title: "Plan changes to campaigns and ad sets (nothing runs yet)",
      description: `Create, duplicate and edit campaigns and ad sets, create ads from existing posts, and turn things on or off — in bulk, 1 to 300 steps in one plan (e.g. 15 ad sets with budgets ₹500 to ₹1,500). The plan is checked against Meta (reads, plus Meta's own validate-only check) and returns the summary: every ad set's budget, bid, schedule, audience and placements, the TOTAL daily budget, what turns on, and warnings for unusual budgets. Nothing changes in Meta until confirm_plan. Use run_at to schedule it.\n\n${opsDescription}`,
      inputSchema: {
        title: z.string().optional(),
        run_at: z.string().optional().describe("ISO time to run the plan, e.g. 2026-11-20T09:00:00+05:30. Leave out to run when confirmed."),
        expected_daily_total: z.number().optional().describe("The total daily budget the person said; the check flags any difference"),
        ops: z.array(z.record(z.string(), z.any())).min(1).max(300),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) => run(async () => planText(await api.call<PlanView>("POST", "/api/plans", a))),
  );

  server.registerTool(
    "update_plan",
    {
      title: "Change a plan before it runs",
      description: "Replace the steps (or time) of a plan that has not been confirmed, and check it again. Send the full new list of steps.",
      inputSchema: { plan_id: z.string(), title: z.string().optional(), run_at: z.string().optional(), expected_daily_total: z.number().optional(), ops: z.array(z.record(z.string(), z.any())).min(1).max(300) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ plan_id, ...rest }) => run(async () => planText(await api.call<PlanView>("POST", `/api/plans/${plan_id}/update`, rest))),
  );

  server.registerTool(
    "confirm_plan",
    {
      title: "Run a plan (after the person's explicit yes)",
      description:
        "Runs a checked plan in the background (or at its scheduled time). Only call this after the person has seen the whole summary from plan_changes and clearly said yes. Needs confirm: true; accept_warnings: true if there were warnings and the person accepted them; and when the plan turns anything on, spend_confirmation: the total daily budget exactly as the summary shows it, as the person confirmed it. Never guess or fill in the total yourself.",
      inputSchema: { plan_id: z.string(), confirm: z.literal(true), accept_warnings: z.boolean().optional(), spend_confirmation: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ plan_id, confirm, accept_warnings, spend_confirmation }) =>
      run(async () => planText(await api.call<PlanView>("POST", `/api/plans/${plan_id}/confirm`, { confirm, acceptWarnings: accept_warnings ?? false, spendConfirmation: spend_confirmation }))),
  );

  server.registerTool(
    "plan_status",
    {
      title: "Plan progress, or list recent plans",
      description: "Progress of one plan (each step: done, failed and why, new IDs), or the list of recent plans when plan_id is left out.",
      inputSchema: { plan_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ plan_id }) =>
      run(async () => {
        if (plan_id) return planText(await api.call<PlanView>("GET", `/api/plans/${plan_id}/view`));
        const r = await api.call<{ plans: { key: string; title: string; statusLabel: string; createdAt: string; dailyBudget: number }[] }>("GET", "/api/plans");
        return r.plans.map((p) => `${p.key}: ${p.title} · ${p.statusLabel} · ${p.createdAt}`).join("\n") || "No plans yet.";
      }),
  );

  server.registerTool(
    "cancel_plan",
    {
      title: "Cancel a plan",
      description: "Cancel a plan that has not run yet (or stop a running one after its current step). Steps already done stay; nothing is deleted.",
      inputSchema: { plan_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ plan_id }) => run(async () => planText(await api.call<PlanView>("POST", `/api/plans/${plan_id}/cancel`))),
  );

  // ---------- Results ----------

  server.registerTool(
    "get_results",
    {
      title: "Read results (spend, leads, CPL, CTR…)",
      description:
        "Meta's results per ad, ad set or campaign (or the whole account) for any date range, with breakdowns (age, gender, country, region, publisher_platform, platform_position, device_platform, day). Metrics: names from list_metrics (spend, impressions, reach, frequency, ctr, cpc, cpm, actions:lead, cost:lead…, any actions:<type> or cost:<type>) and custom metrics by name. Or give column_set.",
      inputSchema: {
        level: z.enum(["account", "campaign", "adset", "ad"]),
        ids: z.array(z.string()).optional().describe("Only these IDs"),
        ids_level: z.enum(["campaign", "adset", "ad"]).optional().describe("What the ids are (default: the same as level), e.g. level ad with campaign ids"),
        date_preset: z.string().optional().describe("today, yesterday, last_3d, last_7d, last_14d, last_30d, last_90d, this_month, last_month, maximum"),
        since: z.string().optional().describe("YYYY-MM-DD"),
        until: z.string().optional().describe("YYYY-MM-DD"),
        breakdowns: z.array(z.string()).optional(),
        metrics: z.array(z.string()).optional(),
        column_set: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      run(async () => {
        type R = { currency: string; level: string; range: string; columns: { key: string; label: string; format: string }[]; rows: { name: string; id: string; breakdown: Record<string, string>; values: Record<string, number | null> }[]; totals: Record<string, number | null> };
        const r = await api.call<R>("POST", "/api/results", { action: "query", ...a });
        const sym = r.currency === "INR" ? "₹" : `${r.currency} `;
        const f = (v: number | null | undefined, fmt: string) => (v === null || v === undefined ? "–" : fmt === "money" ? `${sym}${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : fmt === "percent" ? `${v.toFixed(2)}%` : v.toLocaleString("en-IN", { maximumFractionDigits: 2 }));
        const bks = [...new Set(r.rows.flatMap((x) => Object.keys(x.breakdown)))];
        const head = [r.level, ...bks, ...r.columns.map((c) => c.label)];
        const lines = [`Results by ${r.level}, ${r.range}:`, `| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
        for (const x of r.rows.slice(0, 200)) lines.push(`| ${x.name} (${x.id}) | ${[...bks.map((b) => x.breakdown[b] ?? ""), ...r.columns.map((c) => f(x.values[c.key], c.format))].join(" | ")} |`);
        lines.push(`| TOTAL | ${[...bks.map(() => ""), ...r.columns.map((c) => f(r.totals[c.key], c.format))].join(" | ")} |`);
        if (r.rows.length > 200) lines.push(`(${r.rows.length - 200} more rows not shown; narrow the query.)`);
        if (!r.rows.length) lines.push("No delivery in this range.");
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "list_metrics",
    {
      title: "Metric names, custom metrics and column sets",
      description: "Every metric name get_results accepts, the custom metrics (with formulas) and the saved column sets.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const c = await api.call<{ standard: { key: string; label: string }[]; custom: { name: string; formula: string; format: string }[]; columnSets: { name: string; metrics: string[]; isDefault: boolean }[]; note: string }>("GET", "/api/results");
        return [
          "Metrics:",
          ...c.standard.map((m) => `  ${m.key} = ${m.label}`),
          c.note,
          "Custom metrics:",
          ...(c.custom.length ? c.custom.map((m) => `  ${m.name} = ${m.formula} (${m.format})`) : ["  none yet"]),
          "Column sets:",
          ...c.columnSets.map((s) => `  ${s.name}${s.isDefault ? " (default)" : ""}: ${s.metrics.join(", ")}`),
        ].join("\n");
      }),
  );

  server.registerTool(
    "save_custom_metric",
    {
      title: "Create or edit a custom metric",
      description: 'A metric from a formula of other metrics, e.g. name "Cost per site visit", formula "spend / actions:offsite_conversion.fb_pixel_custom". Use + - * / and brackets; names with spaces go in quotes. Kept in the launcher (Meta\'s API can\'t create Ads Manager custom metrics) and usable in get_results and column sets.',
      inputSchema: { id: z.number().optional(), name: z.string(), formula: z.string(), format: z.enum(["number", "money", "percent"]).optional(), description: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) =>
      run(async () => {
        const r = await api.call<{ id: number }>("POST", "/api/results", { action: "save_custom_metric", ...a });
        return `Saved custom metric "${a.name}" (id ${r.id}) = ${a.formula}.`;
      }),
  );

  server.registerTool(
    "save_column_set",
    {
      title: "Create or edit a column set",
      description: "A saved list of metrics, like Ads Manager's column presets. Used by get_results (column_set) and the app's Results page.",
      inputSchema: { id: z.number().optional(), name: z.string(), metrics: z.array(z.string()).min(1), is_default: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (a) =>
      run(async () => {
        const r = await api.call<{ id: number }>("POST", "/api/results", { action: "save_column_set", id: a.id, name: a.name, metrics: a.metrics, isDefault: a.is_default });
        return `Saved column set "${a.name}" (id ${r.id}): ${a.metrics.join(", ")}.`;
      }),
  );
}
