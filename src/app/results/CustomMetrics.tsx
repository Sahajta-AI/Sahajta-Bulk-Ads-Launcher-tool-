"use client";

import { useState } from "react";
import { api } from "../client-api";
import type { CustomMetricT, Format } from "./shared";
import s from "./results.module.css";

const FORMATS: [Format, string][] = [
  ["number", "Number"],
  ["money", "Money (₹)"],
  ["percent", "Percent (%)"],
];
const formatLabel = (f: string) => FORMATS.find(([k]) => k === f)?.[1] ?? f;

type Draft = { id?: number; name: string; formula: string; format: Format; description: string };
const EMPTY: Draft = { name: "", formula: "", format: "money", description: "" };

/** Your own metrics made from Meta's numbers, e.g. Cost per lead = spend / actions:lead. */
export default function CustomMetrics({ metrics, onChanged }: { metrics: CustomMetricT[]; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/results", { method: "POST", body: { action: "save_custom_metric", ...draft } });
      await onChanged();
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: CustomMetricT) {
    if (!confirm(`Remove the custom metric “${m.name}”? Column sets that show it lose that column.`)) return;
    setError("");
    setNote("");
    try {
      const r = await api<{ removedFrom?: string[] }>(`/api/results/custom_metric/${m.id}`, { method: "DELETE" });
      const sets = r.removedFrom ?? [];
      setNote(`Removed “${m.name}”.${sets.length ? ` It was also taken out of the column set${sets.length > 1 ? "s" : ""} ${sets.map((x) => `“${x}”`).join(", ")}.` : ""}`);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="panel">
        <header>
          <h2>Custom metrics</h2>
          {!draft && <button className="primary" style={{ marginLeft: "auto" }} onClick={() => { setDraft({ ...EMPTY }); setError(""); setNote(""); }}>Add a metric</button>}
        </header>
        {error && !draft && <div className="msg error">{error}</div>}
        {note && !error && !draft && <div className="msg ok">{note}</div>}
        {metrics.length === 0 && <p className="muted">No custom metrics yet. Add one to see things like cost per site visit.</p>}
        {metrics.map((m) => (
          <div key={m.id} className="list-item">
            <span className="grow">
              <strong style={{ fontWeight: 600 }}>{m.name}</strong> <span className="badge grey">{formatLabel(m.format)}</span>
              <span className={s.formula} style={{ display: "block" }}>{m.formula}</span>
              {m.description && <small style={{ display: "block" }}>{m.description}</small>}
            </span>
            <button onClick={() => { setDraft({ id: m.id, name: m.name, formula: m.formula, format: m.format, description: m.description ?? "" }); setError(""); }}>Edit</button>
            <button className="link danger" onClick={() => remove(m)}>Remove</button>
          </div>
        ))}
      </div>

      {draft && (
        <div className="panel">
          <header><h2>{draft.id ? `Edit “${draft.name}”` : "New custom metric"}</h2></header>
          <div className="row">
            <label><span>Name</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Cost per site visit" /></label>
            <label style={{ maxWidth: 220 }}>
              <span>Show as</span>
              <select value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value as Format })}>
                {FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </div>
          <label className="field" style={{ marginTop: 14 }}>
            <span>Formula</span>
            <input value={draft.formula} onChange={(e) => setDraft({ ...draft, formula: e.target.value })} placeholder="spend / actions:lead" spellCheck={false} />
          </label>
          <p className="hint">
            Use metric names, numbers, + − × ÷ (write * and /) and brackets. Put a name that has spaces in quotes, like &quot;Cost per lead&quot;. Examples:
          </p>
          <ul className={s.examples}>
            <li>Cost per lead = <code>spend / actions:lead</code></li>
            <li>Cost per site visit = <code>spend / actions:offsite_conversion.fb_pixel_custom</code></li>
          </ul>
          <label className="field" style={{ marginTop: 14 }}>
            <span>Note (optional)</span>
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What this number tells you" />
          </label>
          {error && <div className="msg error">{error}</div>}
          <div className={s.actions}>
            <button className="primary" disabled={busy || !draft.name.trim() || !draft.formula.trim()} onClick={save}>{busy ? "Saving…" : "Save metric"}</button>
            <button onClick={() => { setDraft(null); setError(""); }}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
