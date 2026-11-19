// Per-ad copy pasted from a sheet (pure: no React, so it can be unit tested).
// Columns: ad (number, creative or file name), primary_text_1..5, headline_1..5, description,
// link, display_link, lead_form_id, cta, utm, enhancements (feature keys switched ON for that ad
// only, comma-separated; "none" = all off), multi_advertiser (yes/no). Empty cells keep what the ad
// has now (the server merges: a field left out keeps the ad's own copy, or else the batch's copy).

export type CopySheetRow = { ad: string; copy: Record<string, unknown>; problem?: string };

/** What an empty cell does, as the page says it (the server merges each row into the ad's copy). */
export const EMPTY_CELLS = "Empty cells keep what the ad has now: its own copy saved earlier, or else the batch's copy.";

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Split the whole pasted text into rows of cells. Google Sheets puts a cell with a line break,
 * a tab or a quote mark in quotes ("Line one\nLine two", "" for a quote mark), so line breaks
 * inside quotes belong to the cell, not to a new row. Blank rows outside quotes are skipped.
 * Returns null when a quote is never closed (then the caller reads the text line by line).
 */
function recordsOf(text: string, sep: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  const endCell = () => { row.push(cur.trim()); cur = ""; };
  const endRow = () => {
    endCell();
    if (row.some((c) => c !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && !cur.trim()) { quoted = true; cur = ""; }
    else if (ch === sep) endCell();
    else if (ch === "\n") endRow();
    else cur += ch;
  }
  if (quoted) return null;
  endRow();
  return rows;
}

/** Old way, used only when a quote is never closed: one line = one row; quotes only within a line. */
function linesOf(text: string, sep: string): string[][] {
  return text.split("\n").filter((l) => l.trim()).map((line) => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"' && !cur.trim()) quoted = true;
      else if (ch === sep) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}

const YES = ["yes", "y", "on", "true", "1"];
const NO = ["no", "n", "off", "false", "0"];

export function parseCopySheet(text: string, features: { key: string }[] = []): CopySheetRow[] {
  const clean = text.replace(/\r\n?/g, "\n");
  const firstLine = clean.split("\n").find((l) => l.trim()) ?? "";
  const sep = firstLine.includes("\t") ? "\t" : ",";
  const records = recordsOf(clean, sep) ?? linesOf(clean, sep);
  if (records.length < 2) return [];
  const head = records[0].map(norm);
  const col = (name: string) => head.indexOf(name);
  const adCol = ["ad", "file", "creative", "ad_number"].map(col).find((i) => i >= 0) ?? -1;
  return records.slice(1).map((cells) => {
    const get = (name: string) => (col(name) >= 0 ? cells[col(name)] ?? "" : "");
    const many = (prefix: string, alt: string) => [1, 2, 3, 4, 5].map((n) => get(`${prefix}_${n}`) || (n === 1 ? get(alt) : "")).filter(Boolean);
    const copy: Record<string, unknown> = {};
    const problems: string[] = [];
    const texts = many("primary_text", "primary_text");
    const heads = many("headline", "headline");
    if (texts.length) copy.primaryTexts = texts;
    if (heads.length) copy.headlines = heads;
    if (get("description")) copy.description = get("description");
    if (get("link") || get("link_url")) copy.linkUrl = get("link") || get("link_url");
    if (get("display_link")) copy.displayLink = get("display_link");
    if (get("lead_form_id") || get("lead_form")) copy.leadFormId = get("lead_form_id") || get("lead_form");
    if (get("cta")) copy.cta = get("cta").toUpperCase().replace(/\s+/g, "_");
    if (get("utm") || get("utm_template")) copy.utmTemplate = get("utm") || get("utm_template");
    const enh = get("enhancements");
    if (enh) {
      const keys = /^(none|off|no)$/i.test(enh) ? [] : enh.split(/[,;]/).map((k) => k.trim().toLowerCase()).filter(Boolean);
      const unknown = features.length ? keys.filter((k) => !features.some((f) => f.key === k)) : [];
      if (unknown.length) problems.push(`unknown enhancement ${unknown.join(", ")}`);
      copy.enhancements = Object.fromEntries(keys.map((k) => [k, "OPT_IN"]));
    }
    const multi = get("multi_advertiser").toLowerCase();
    if (multi) {
      if (YES.includes(multi)) copy.multiAdvertiser = true;
      else if (NO.includes(multi)) copy.multiAdvertiser = false;
      else problems.push("multi_advertiser must be yes or no");
    }
    const ad = adCol >= 0 ? cells[adCol] ?? "" : "";
    if (!ad) problems.unshift("no ad number or file name");
    else if (!Object.keys(copy).length) problems.unshift("no copy in this row");
    return { ad, copy, problem: problems.length ? problems.join("; ") : undefined };
  });
}
