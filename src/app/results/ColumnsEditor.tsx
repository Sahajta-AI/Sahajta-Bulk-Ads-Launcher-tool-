"use client";

import { useState } from "react";
import { api } from "../client-api";
import type { Catalog, ColumnSet } from "./shared";
import s from "./results.module.css";

/** Pick, order and save the metrics shown in the table, like Ads Manager's column presets. */
export default function ColumnsEditor({ catalog, metrics, set, onApply, onSaved }: {
  catalog: Catalog;
  metrics: string[];
  /** The saved set these columns came from, if any. */
  set: ColumnSet | null;
  onApply: (metrics: string[]) => void;
  onSaved: (setId: number | null, metrics: string[]) => Promise<void>;
}) {
  const [list, setList] = useState<string[]>(metrics);
  const [extra, setExtra] = useState("");
  const [name, setName] = useState(set && set.id > 0 ? set.name : "");
  const [isDefault, setIsDefault] = useState(set?.isDefault ?? false);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const labelOf = (k: string) =>
    catalog.standard.find((m) => m.key === k)?.label ?? catalog.custom.find((c) => c.name.toLowerCase() === k.toLowerCase())?.name ?? k;
  const has = (k: string) => list.some((x) => x.toLowerCase() === k.toLowerCase());
  const toggle = (k: string) => setList(has(k) ? list.filter((x) => x.toLowerCase() !== k.toLowerCase()) : [...list, k]);
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    setList(next);
  };

  function addExtra() {
    const k = extra.trim();
    if (!/^(actions|cost):[\w.]+$/.test(k)) {
      setMsg({ kind: "error", text: "Write it as actions:<event name> or cost:<event name>, for example actions:offsite_conversion.fb_pixel_custom." });
      return;
    }
    if (!has(k)) setList([...list, k]);
    setExtra("");
    setMsg(null);
  }

  async function save(asNew: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const id = !asNew && set && set.id > 0 ? set.id : undefined;
      const r = await api<{ id: number }>("/api/results", { method: "POST", body: { action: "save_column_set", id, name, metrics: list, isDefault } });
      await onSaved(r.id, list);
      setMsg({ kind: "ok", text: `Saved “${name.trim()}”.` });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!set || set.id <= 0) return;
    if (!confirm(`Remove the column set “${set.name}”? This only changes the launcher, nothing in Meta.`)) return;
    setBusy(true);
    try {
      await api(`/api/results/column_set/${set.id}`, { method: "DELETE" });
      await onSaved(null, list);
      setMsg({ kind: "ok", text: `Removed “${set.name}”.` });
      setName("");
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel">
        <header>
          <h2>Columns in the table</h2>
          <p className="hint" style={{ marginLeft: 0 }}>Top of this list is the first column. Use the arrows to change the order.</p>
        </header>
        {list.length === 0 && <p className="muted">No columns yet. Tick some metrics below.</p>}
        <div className={s.chosen}>
          {list.map((k, i) => (
            <div key={k} className={s.chosenItem}>
              <span className={s.grow} title={k}>{labelOf(k)}</span>
              <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${labelOf(k)} up`}>↑</button>
              <button onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label={`Move ${labelOf(k)} down`}>↓</button>
              <button className="danger" onClick={() => toggle(k)} aria-label={`Remove ${labelOf(k)}`}>✕</button>
            </div>
          ))}
        </div>

        <p className="section-title" style={{ marginTop: 16 }}>Meta metrics</p>
        <div className={s.pickGrid}>
          {catalog.standard.map((m) => (
            <label key={m.key} className="check"><input type="checkbox" checked={has(m.key)} onChange={() => toggle(m.key)} />{m.label}</label>
          ))}
        </div>
        {catalog.custom.length > 0 && (
          <>
            <p className="section-title">Your custom metrics</p>
            <div className={s.pickGrid}>
              {catalog.custom.map((c) => (
                <label key={c.id} className="check"><input type="checkbox" checked={has(c.name)} onChange={() => toggle(c.name)} />{c.name}</label>
              ))}
            </div>
          </>
        )}
        <div className="row">
          <label>
            <span>Add any other Meta event</span>
            <input value={extra} onChange={(e) => setExtra(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addExtra(); }} placeholder="actions:offsite_conversion.fb_pixel_custom" />
          </label>
          <button onClick={addExtra} disabled={!extra.trim()}>Add</button>
        </div>
        <p className="hint">Use actions:&lt;event&gt; for how many times it happened, and cost:&lt;event&gt; for the cost of each one.</p>
      </div>

      <div className="panel">
        <header><h2>Save these columns</h2></header>
        <div className="row">
          <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lead gen view" /></label>
        </div>
        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Show this set first every time
        </label>
        {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
        <div className={s.actions}>
          {set && set.id > 0 && <button className="primary" disabled={busy || !name.trim() || !list.length} onClick={() => save(false)}>Update “{set.name}”</button>}
          <button className={set && set.id > 0 ? "" : "primary"} disabled={busy || !name.trim() || !list.length} onClick={() => save(true)}>Save as a new set</button>
          <button disabled={!list.length} onClick={() => onApply(list)}>Use without saving</button>
          {set && set.id > 0 && <button className="link danger" disabled={busy} onClick={remove}>Remove this set</button>}
        </div>
      </div>
    </>
  );
}
