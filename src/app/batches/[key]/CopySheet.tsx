"use client";

import { useState } from "react";
import type { BatchView } from "@/lib/service";
import { api } from "../../client-api";
import { EMPTY_CELLS, parseCopySheet } from "./copy-sheet";

// Per-ad copy from a sheet: paste rows copied from Google Sheets (first row = headers).
// The parser lives in copy-sheet.ts (cells with line breaks stay one cell).

export { parseCopySheet };

export default function CopySheet({ batchKey, features, onSaved }: { batchKey: string; features: { key: string; label: string }[]; onSaved: (v: BatchView) => void }) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = parseCopySheet(text, features);
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
        Copy the rows from Google Sheets with the header row. Columns: <code>ad</code> (ad number or file name), <code>primary_text_1</code> … <code>primary_text_5</code>, <code>headline_1</code> … <code>headline_5</code>, <code>description_1</code> … <code>description_5</code>, <code>link</code>, <code>display_link</code> (short link shown on the ad), <code>lead_form_id</code>, <code>cta</code>, <code>utm</code> (link tags). {EMPTY_CELLS}
      </p>
      <p className="hint">
        Two columns change Meta settings for that ad only: <code>enhancements</code> lists the AI enhancements to switch on, separated by commas (<code>none</code> switches all off), and <code>multi_advertiser</code> is <code>yes</code> or <code>no</code>. Leave them empty to keep what the ad has now (the preset, unless you set them for this ad before).
      </p>
      {features.length > 0 && (
        <details>
          <summary>Names to use in the enhancements column</summary>
          {features.map((f) => <div key={f.key} style={{ fontSize: 13, padding: "2px 0" }}><code>{f.key}</code> {f.label}</div>)}
        </details>
      )}
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"ad\tprimary_text_1\theadline_1\tlink\n1\tBook a site visit this weekend\tFree site visit\thttps://…"} style={{ width: "100%", fontFamily: "inherit", marginTop: 8 }} />
      {rows.length > 0 && (
        <p className="muted">{rows.length} row{rows.length === 1 ? "" : "s"} read{bad.length ? `; ${bad.length} with a problem: ${bad.map((b) => `row ${rows.indexOf(b) + 2} (${b.problem})`).join(", ")}` : ""}.</p>
      )}
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      <button className="primary" disabled={busy || !rows.length || bad.length > 0} onClick={save}>{busy ? "Saving…" : "Save copy per ad"}</button>
    </details>
  );
}
