// Turn rows pasted from Google Sheets (tab-separated, first row = headers) into plan steps.
// Each row becomes one step: create → create_adset, copy → duplicate_adset (one copy),
// edit → edit_adset. Campaign and ad set names are matched to IDs from the campaign list.

import type { Op } from "@/lib/manage/plan";
import type { AdSetSpec } from "@/lib/manage/objects";
import { countryList, num, type Option, type Tree } from "./util";

export const BULK_HEADERS = [
  "action", "name", "campaign", "source_adset", "adset", "daily_budget", "lifetime_budget", "bid_strategy", "bid_amount",
  "start_time", "end_time", "countries", "age_min", "age_max", "genders", "status", "goal", "destination", "pixel_id", "event",
  "languages", "inventory_filter", "frequency_cap",
];

export interface BulkRow {
  line: number;
  action: string;
  target: string;
  changes: string;
  op: Op | null;
  errors: string[];
}

export interface BulkResult {
  rows: BulkRow[];
  ignored: string[];
  error: string;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** "2026-11-20 09:00", "20/11/2026 9:00", "2026-11-20" → ISO in India time. */
export function sheetTime(v: string): string {
  const t = v.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return iso(m[1], m[2], m[3], m[4], m[5]);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return iso(m[3], m[2], m[1], m[4], m[5]);
  throw new Error(`time "${v}" not understood; use 2026-11-20 09:00 (India time)`);
}

function iso(y: string, mo: string, d: string, h = "0", mi = "00"): string {
  const p = (x: string) => x.padStart(2, "0");
  if (Number(mo) > 12 || Number(d) > 31 || Number(h) > 23) throw new Error(`date "${y}-${mo}-${d}" not valid`);
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00+05:30`;
}

function pickOption(v: string, list: Option[], what: string): string {
  const t = v.trim().toLowerCase();
  const hit =
    list.find((o) => o.value.toLowerCase() === t || o.label.toLowerCase() === t) ??
    list.find((o) => o.label.toLowerCase().includes(t) || o.value.toLowerCase().replace(/_/g, " ").includes(t));
  if (!hit) throw new Error(`${what} "${v}" not known`);
  return hit.value;
}

const BID_WORDS: Record<string, string> = {
  "highest volume": "LOWEST_COST_WITHOUT_CAP",
  "lowest cost": "LOWEST_COST_WITHOUT_CAP",
  "cost cap": "COST_CAP",
  "bid cap": "LOWEST_COST_WITH_BID_CAP",
  roas: "LOWEST_COST_WITH_MIN_ROAS",
  "roas goal": "LOWEST_COST_WITH_MIN_ROAS",
};

export function parseBulk(text: string, tree: Tree, bidStrategies: Option[], goals: Option[], destinations: Option[]): BulkResult {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], ignored: [], error: lines.length ? "Paste the header row and at least one row below it." : "" };
  const headers = lines[0].split("\t").map(norm);
  if (!headers.includes("action")) return { rows: [], ignored: [], error: "The first row must be the headers, with an “action” column (create, copy or edit)." };
  const ignored = headers.filter((h) => h && !BULK_HEADERS.includes(h));

  const campaigns = tree.campaigns;
  const adsets = campaigns.flatMap((c) => c.adsets.map((a) => ({ ...a, campaign: c })));

  const findCampaign = (v: string) => {
    const t = v.trim();
    const byId = campaigns.find((c) => c.id === t);
    if (byId) return byId;
    const hits = campaigns.filter((c) => c.name.trim().toLowerCase() === t.toLowerCase());
    if (hits.length > 1) throw new Error(`${hits.length} campaigns are called "${t}"; use the campaign ID`);
    if (!hits.length) throw new Error(`no campaign called "${t}"`);
    return hits[0];
  };
  const findAdSet = (v: string) => {
    const t = v.trim();
    const byId = adsets.find((a) => a.id === t);
    if (byId) return byId;
    const hits = adsets.filter((a) => a.name.trim().toLowerCase() === t.toLowerCase());
    if (hits.length > 1) throw new Error(`${hits.length} ad sets are called "${t}"; use the ad set ID`);
    if (!hits.length) throw new Error(`no ad set called "${t}"`);
    return hits[0];
  };

  const rows: BulkRow[] = lines.slice(1).map((line, i) => {
    const cells = line.split("\t");
    const get = (h: string) => {
      const k = headers.indexOf(h);
      return k >= 0 ? (cells[k] ?? "").trim() : "";
    };
    const errors: string[] = [];
    const action = get("action").toLowerCase();
    const row: BulkRow = { line: i + 2, action, target: "", changes: "", op: null, errors };
    const attempt = <T,>(f: () => T): T | undefined => {
      try {
        return f();
      } catch (e) {
        errors.push((e as Error).message);
        return undefined;
      }
    };

    // Fields every action can set.
    const spec: AdSetSpec = {};
    const said: string[] = [];
    const money = (h: string, k: "daily_budget" | "lifetime_budget" | "bid_amount", label: string) => {
      const v = get(h);
      if (!v) return;
      const n = num(v);
      if (n === undefined || !Number.isFinite(n) || n < 0) errors.push(`${label} "${v}" is not a number`);
      else {
        spec[k] = n;
        said.push(`${label} ₹${n.toLocaleString("en-IN")}`);
      }
    };
    if (get("name") && action !== "create") { spec.name = get("name"); said.push(`name "${spec.name}"`); }
    money("daily_budget", "daily_budget", "daily budget");
    money("lifetime_budget", "lifetime_budget", "lifetime budget");
    if (get("bid_strategy")) {
      const v = get("bid_strategy");
      const b = BID_WORDS[v.toLowerCase()] ?? attempt(() => pickOption(v, bidStrategies, "bid strategy"));
      if (b) { spec.bid_strategy = b; said.push(`bid ${bidStrategies.find((o) => o.value === b)?.label ?? b}`); }
    }
    if (get("bid_amount")) {
      const v = get("bid_amount");
      const n = num(v);
      if (n === undefined || !Number.isFinite(n) || n < 0) errors.push(`bid amount "${v}" is not a number`);
      else if (spec.bid_strategy === "LOWEST_COST_WITH_MIN_ROAS") { spec.roas_average_floor = n; said.push(`ROAS goal ${n}`); }
      else { spec.bid_amount = n; said.push(`bid amount ₹${n.toLocaleString("en-IN")}`); }
    }
    if (get("start_time")) { const t = attempt(() => sheetTime(get("start_time"))); if (t) { spec.start_time = t; said.push(`start ${get("start_time")}`); } }
    if (get("end_time")) { const t = attempt(() => sheetTime(get("end_time"))); if (t) { spec.end_time = t; said.push(`end ${get("end_time")}`); } }
    if (get("countries")) { spec.countries = countryList(get("countries")); said.push(`countries ${spec.countries.join(", ")}`); }
    for (const [h, k, label] of [["age_min", "age_min", "age from"], ["age_max", "age_max", "age to"]] as const) {
      const v = get(h);
      if (!v) continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 13 || n > 65) errors.push(`${label} "${v}" must be a whole number from 13 to 65`);
      else { spec[k] = n; said.push(`${label} ${n}`); }
    }
    if (get("genders")) {
      const g = get("genders").toLowerCase();
      const val = ["all", "both", "any"].includes(g) ? "all" : ["men", "man", "male", "m", "1"].includes(g) ? "men" : ["women", "woman", "female", "f", "2"].includes(g) ? "women" : null;
      if (!val) errors.push(`genders "${get("genders")}" must be all, men or women`);
      else { spec.genders = val; said.push(`gender ${val}`); }
    }
    if (get("status")) {
      const v = get("status").toLowerCase();
      const st = ["on", "active", "yes", "live"].includes(v) ? "ACTIVE" : ["off", "paused", "pause", "no"].includes(v) ? "PAUSED" : null;
      if (!st) errors.push(`status "${get("status")}" must be on or off`);
      else { spec.status = st; said.push(st === "ACTIVE" ? "turn ON" : "turn off"); }
    }
    if (get("goal")) { const v = attempt(() => pickOption(get("goal"), goals, "goal")); if (v) { spec.goal = v; said.push(`goal ${get("goal")}`); } }
    if (get("destination")) { const v = attempt(() => pickOption(get("destination"), destinations, "destination")); if (v) { spec.destination = v; said.push(`destination ${get("destination")}`); } }
    if (get("pixel_id")) { spec.pixel_id = get("pixel_id"); said.push(`pixel ${spec.pixel_id}`); }
    if (get("event")) { spec.event = get("event").toUpperCase().replace(/\s+/g, "_"); said.push(`event ${spec.event}`); }
    if (get("languages")) {
      const ids = get("languages").split(/[,\s]+/).filter(Boolean);
      const nums = ids.map(Number);
      if (nums.some((n) => !Number.isInteger(n) || n <= 0)) errors.push(`languages "${get("languages")}" must be language IDs (numbers) with commas`);
      else { spec.languages = nums; said.push(`languages ${nums.join(", ")}`); }
    }
    if (get("inventory_filter")) {
      const v = get("inventory_filter").toLowerCase();
      if (v === "expanded" || v === "moderate" || v === "limited") { spec.inventory_filter = v; said.push(`inventory filter ${v}`); }
      else errors.push(`inventory_filter "${get("inventory_filter")}" must be expanded, moderate or limited`);
    }
    if (get("frequency_cap")) {
      const m = get("frequency_cap").match(/^(\d+)\s*\/\s*(\d+)$/);
      if (!m || !Number(m[1]) || !Number(m[2])) errors.push(`frequency_cap "${get("frequency_cap")}" must look like 2/7 (2 times every 7 days)`);
      else { spec.frequency_cap = { impressions: Number(m[1]), days: Number(m[2]) }; said.push(`frequency cap ${m[1]} every ${m[2]} days`); }
    }
    row.changes = said.join("; ");

    if (action === "create") {
      const name = get("name");
      if (!name) errors.push("create needs a name");
      if (!get("campaign")) errors.push("create needs a campaign");
      const c = get("campaign") ? attempt(() => findCampaign(get("campaign"))) : undefined;
      row.target = `New ad set "${name}"${c ? ` in "${c.name}"` : ""}`;
      if (c && name) row.op = { type: "create_adset", campaign: c.id, ...spec, name, status: spec.status ?? "PAUSED" };
    } else if (action === "copy") {
      if (!get("source_adset")) errors.push("copy needs source_adset (the ad set to copy)");
      const a = get("source_adset") ? attempt(() => findAdSet(get("source_adset"))) : undefined;
      const c = get("campaign") ? attempt(() => findCampaign(get("campaign"))) : undefined;
      row.target = a ? `Copy "${a.name}"${c && c.id !== a.campaign.id ? ` into "${c.name}"` : ""}` : "Copy";
      if (a) row.op = { type: "duplicate_adset", adset: a.id, ...(c && c.id !== a.campaign.id ? { campaign: c.id } : {}), copies: 1, changes: [spec] };
    } else if (action === "edit") {
      if (!get("adset")) errors.push("edit needs adset (the ad set to change)");
      const a = get("adset") ? attempt(() => findAdSet(get("adset"))) : undefined;
      row.target = a ? `Edit "${a.name}"` : "Edit";
      if (a && !said.length) errors.push("nothing to change in this row");
      if (a) row.op = { type: "edit_adset", adset: a.id, ...spec };
    } else {
      errors.push(action ? `action "${action}" must be create, copy or edit` : "action is empty (use create, copy or edit)");
    }
    if (errors.length) row.op = null;
    return row;
  });

  return { rows, ignored, error: "" };
}
