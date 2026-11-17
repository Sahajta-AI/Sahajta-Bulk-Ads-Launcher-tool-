"use client";

import { useState } from "react";
import type { BatchView } from "@/lib/service";
import { api } from "../../client-api";

// Per-ad copy from a sheet: paste rows copied from Google Sheets (first row = headers).
// Columns: ad (number, creative or file name), primary_text_1..5, headline_1..5,
// description, link, cta. Empty cells keep the batch's copy.

type Row = { ad: string; copy: Record<string, unknown>; problem?: string };

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

export function parseCopySheet(text: string): Row[] {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const head = lines[0].split(sep).map(norm);
  const col = (name: string) => head.indexOf(name);
  const adCol = ["ad", "file", "creative", "ad_number"].map(col).find((i) => i >= 0) ?? -1;
  return lines.slice(1).map((line) => {
    const cells = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    const get = (name: string) => (col(name) >= 0 ? cells[col(name)] ?? "" : "");
    const many = (prefix: string, alt: string) => [1, 2, 3, 4, 5].map((n) => get(`${prefix}_${n}`) || (n === 1 ? get(alt) : "")).filter(Boolean);
    const copy: Record<string, unknown> = {};
    const texts = many("primary_text", "primary_text");
    const heads = many("headline", "headline");
    if (texts.length) copy.primaryTexts = texts;
    if (heads.length) copy.headlines = heads;
    if (get("description")) copy.description = get("description");
    if (get("link") || get("link_url")) copy.linkUrl = get("link") || get("link_url");
    if (get("cta")) copy.cta = get("cta").toUpperCase().replace(/\s+/g, "_");
    const ad = adCol >= 0 ? cells[adCol] ?? "" : "";
    return { ad, copy, problem: !ad ? "no ad number or file name" : !Object.keys(copy).length ? "no copy in this row" : undefined };
  });
}

export default function CopySheet({ batchKey, onSaved }: { batchKey: string; onSaved: (v: BatchView) => void }) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = parseCopySheet(text);
  const bad = rows.filter((r) => r.problem);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const v = await api<BatchView>(`/api/batches/${batchKey}/copy`, { method: "POST", body: { rows: rows.map((r) => ({ ad: r.ad, copy: r.copy })) } });
      onSaved(v);
      setMsg({ kind: "ok", text: `Saved copy for ${rows.length} ad${rows.length === 1 ? "" : "s"}. Check them in the preview below.` });
      setText("");
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
    setBusy(false);
  }

  return (
    <details style={{ marginTop: 12 }}>
      <summary>Each ad has its own copy? Paste it from a sheet</summary>
      <p className="hint">
        Copy the rows from Google Sheets with the header row. Columns: <code>ad</code> (ad number or file name), <code>primary_text_1</code> … <code>primary_text_5</code>, <code>headline_1</code> … <code>headline_5</code>, <code>description</code>, <code>link</code>, <code>cta</code>. Empty cells keep the template&apos;s copy.
      </p>
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"ad\tprimary_text_1\theadline_1\tlink\n1\tBook a site visit this weekend\tFree site visit\thttps://…"} style={{ width: "100%", fontFamily: "inherit" }} />
      {rows.length > 0 && (
        <p className="muted">{rows.length} row{rows.length === 1 ? "" : "s"} read{bad.length ? `; ${bad.length} with a problem: ${bad.map((b) => `row ${rows.indexOf(b) + 2} (${b.problem})`).join(", ")}` : ""}.</p>
      )}
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      <button className="primary" disabled={busy || !rows.length || bad.length > 0} onClick={save}>{busy ? "Saving…" : "Save copy per ad"}</button>
    </details>
  );
}
