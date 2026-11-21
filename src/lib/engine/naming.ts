// Naming templates: "{date}_{creative}_{angle}_{format}" -> "2026-11-03_hook-01_price_VID-9x16+4x5".
// Every name sent to Meta also ends with the ad's launch key, e.g. " [L:b7k2x-03]".
// That key is how retries find objects Meta already created, so it is never optional.

export interface NameContext {
  date?: Date;
  creative?: string;
  angle?: string;
  format?: string;
  n?: number;
  batch?: string;
  copy?: string;
  campaign?: string;
  adset?: string;
  persona?: string;
  objective?: string;
  budget?: string;
}

export const NAME_TOKENS: { token: string; meaning: string }[] = [
  { token: "{date}", meaning: "Launch date, 2026-11-03. Other formats: {date:YYMMDD}, {date:DDMMYY}, {date:YYYYMMDD}" },
  { token: "{creative}", meaning: "Creative name from the file name, ratio removed (hook-01)" },
  { token: "{angle}", meaning: "Angle you type for the batch or for one ad" },
  { token: "{format}", meaning: "VID or IMG plus the ratios, e.g. VID-9x16+4x5" },
  { token: "{n}", meaning: "Ad number in this batch, 01, 02, ... Other widths: {n:1} gives 1, 2, ... (no leading zero), {n:3} gives 001" },
  { token: "{copy}", meaning: "Copy template name" },
  { token: "{campaign}", meaning: "Campaign name" },
  { token: "{adset}", meaning: "Ad set name" },
  { token: "{batch}", meaning: "Batch code" },
  { token: "{persona}", meaning: "Persona you type for the batch, the plan or one ad set" },
  { token: "{objective}", meaning: "Campaign objective in short, e.g. LEADS (campaign and ad set names)" },
  { token: "{budget}", meaning: "Daily or lifetime budget, e.g. 1500 (campaign and ad set names)" },
];

/** Meta fills these in itself, in links only (UTM parameters): the names as they are in Ads Manager. */
export const META_URL_PARAMS = ["{{campaign.name}}", "{{campaign.id}}", "{{adset.name}}", "{{adset.id}}", "{{ad.name}}", "{{ad.id}}", "{{placement}}", "{{site_source_name}}"];

/** UTM parameters for new copy templates: each lead shows which campaign, ad set and ad brought it. */
export const DEFAULT_UTM = "utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&utm_id={{ad.id}}";

const pad = (n: number) => String(n).padStart(2, "0");

function formatDate(d: Date, fmt?: string): string {
  // IST is where the team works; use it so a 1 a.m. launch gets the right date.
  const ist = new Date(d.getTime() + 330 * 60_000);
  const Y = String(ist.getUTCFullYear());
  const M = pad(ist.getUTCMonth() + 1);
  const D = pad(ist.getUTCDate());
  switch ((fmt ?? "").toUpperCase()) {
    case "YYMMDD": return Y.slice(2) + M + D;
    case "DDMMYY": return D + M + Y.slice(2);
    case "YYYYMMDD": return Y + M + D;
    case "DD-MM-YYYY": return `${D}-${M}-${Y}`;
    default: return `${Y}-${M}-${D}`;
  }
}

function tokenValue(name: string, arg: string | undefined, ctx: NameContext): string | undefined {
  switch (name) {
    case "date": return formatDate(ctx.date ?? new Date(), arg);
    case "creative": return ctx.creative ?? "";
    case "angle": return ctx.angle ?? "";
    case "format": return ctx.format ?? "";
    // {n} = 01, 02 …; {n:1} = 1, 2 … (no leading zero); {n:3} = 001 …
    case "n": return ctx.n === undefined ? "" : String(ctx.n).padStart(arg && /^[1-6]$/.test(arg.trim()) ? Number(arg.trim()) : 2, "0");
    case "batch": return ctx.batch ?? "";
    case "copy": return ctx.copy ?? "";
    case "campaign": return ctx.campaign ?? "";
    case "adset": return ctx.adset ?? "";
    case "persona": return ctx.persona ?? "";
    case "objective": return ctx.objective ?? "";
    case "budget": return ctx.budget ?? "";
    default: return undefined; // unknown tokens stay as typed
  }
}

// Single braces only: Meta's own URL parameters like {{ad.name}} pass through untouched.
const TOKEN = /(?<!\{)\{(\w+)(?::([^{}]+))?\}(?!\})/g;

export function renderPattern(pattern: string, ctx: NameContext, encode?: (v: string) => string): string {
  return pattern.replace(TOKEN, (whole, name: string, arg: string | undefined) => {
    const v = tokenValue(name.toLowerCase(), arg, ctx);
    if (v === undefined) return whole;
    return encode ? encode(v) : v;
  });
}

/** Render a name and tidy separators left behind by empty tokens. */
export function renderName(pattern: string, ctx: NameContext): string {
  return renderPattern(pattern, ctx)
    .replace(/(\s*[_\-|.]\s*)(?:[_\-|.]\s*)+/g, "$1")
    .replace(/^[\s_\-|.]+|[\s_\-|.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function keyTag(key: string): string {
  return `[L:${key}]`;
}

/**
 * The ad's name in Meta: optional TEST_ prefix + the rendered name, with no launch key (people read ad
 * names in Ads Manager; 21 Nov 2026). The launcher finds its ads by ad set and creative instead.
 */
export function metaAdName(rendered: string, prefix = "", maxBody = 400): string {
  const body = rendered.slice(0, maxBody).trim();
  return (prefix && !body.startsWith(prefix) ? prefix + body : body).trim();
}

/** The exact name sent to Meta for creatives and new ad sets: optional TEST_ prefix + rendered name + launch key. */
export function metaName(rendered: string, key: string, prefix = "", maxBody = 200): string {
  const tag = keyTag(key);
  const body = rendered.slice(0, maxBody).trim();
  const withPrefix = prefix && !body.startsWith(prefix) ? prefix + body : body;
  return `${withPrefix} ${tag}`.trim();
}

export function unknownTokens(pattern: string): string[] {
  const out: string[] = [];
  for (const m of pattern.matchAll(TOKEN)) {
    if (tokenValue(m[1].toLowerCase(), m[2], {}) === undefined) out.push(m[0]);
  }
  return out;
}

/** UTM template, e.g. "utm_source=meta&utm_campaign={campaign}&utm_content={creative}" -> Meta url_tags. */
export function renderUtm(template: string, ctx: NameContext): string {
  return renderPattern(template.replace(/^[?&]/, ""), ctx, (v) => encodeURIComponent(v));
}
