"use client";

import { Fragment, useState } from "react";
import type { BatchView } from "@/lib/service";
import type { CopyOverride } from "@/lib/types";
import { api, type Templates } from "../../client-api";
import { msgClass } from "../../msg";
import { notEditedHere } from "./batch-logic";

// One row per ad: name, files, copy, destination, problems. "Change copy" edits one ad only.
// "Preview in Meta" asks Meta for its own preview of the ad in each placement.

type Ad = BatchView["ads"][number];

interface MetaPreview { label: string; url: string | null; problem?: string }
type PreviewState = { loading: true } | { loading: false; error?: string; previews?: MetaPreview[] };

function Override({ ad, tpl, presetOn, presetMulti, batchKey, onDone }: { ad: Ad; tpl: Templates | null; presetOn: string[]; presetMulti: boolean; batchKey: string; onDone: (v: BatchView) => void }) {
  const pad = (a: string[]) => [...a, "", "", "", "", ""].slice(0, 5);
  // Start from this ad's earlier changes, so saving one field never wipes the others.
  const o = (ad.override ?? {}) as CopyOverride;
  const [texts, setTexts] = useState(pad(o.primaryTexts ?? []));
  const [heads, setHeads] = useState(pad(o.headlines ?? []));
  const [descs, setDescs] = useState(pad(o.descriptions ?? []));
  const [link, setLink] = useState(o.linkUrl ?? "");
  const [displayLink, setDisplayLink] = useState(o.displayLink ?? "");
  const [leadFormId, setLeadFormId] = useState(o.leadFormId ?? "");
  const [cta, setCta] = useState(o.cta ?? "");
  const [angle, setAngle] = useState(ad.angle);
  // Enhancements: sent only when this ad has its own list or the person ticks a box.
  const [enhOwn, setEnhOwn] = useState(!!o.enhancements);
  const [enh, setEnh] = useState<Set<string>>(new Set(o.enhancements ? Object.keys(o.enhancements) : presetOn));
  const [multi, setMulti] = useState<"same" | "on" | "off">(typeof o.multiAdvertiser === "boolean" ? (o.multiAdvertiser ? "on" : "off") : "same");
  const [error, setError] = useState("");

  async function save(clear = false) {
    try {
      // Link tags and the carousel format are set elsewhere (sheet, Claude): keep them.
      const copy: CopyOverride = { ...notEditedHere(o), primaryTexts: texts.filter((t) => t.trim()), headlines: heads.filter((t) => t.trim()), descriptions: descs.filter((t) => t.trim()), linkUrl: link, displayLink, leadFormId, cta };
      if (enhOwn) copy.enhancements = Object.fromEntries([...enh].map((k) => [k, "OPT_IN" as const]));
      if (multi !== "same") copy.multiAdvertiser = multi === "on";
      const body = clear ? { copy: {}, angle: "" } : { copy, angle };
      onDone(await api<BatchView>(`/api/batches/${batchKey}/items/${ad.id}`, { method: "PATCH", body }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div style={{ background: "#fafaf7", padding: 12, borderRadius: 8 }}>
      <p className="muted">Only for this ad. Leave a box empty to keep the batch copy.</p>
      <div className="grid2">
        <div>
          <small>Primary texts (up to 5)</small>
          {texts.map((t, i) => (
            <textarea key={i} rows={2} value={t} placeholder={ad.copy.primaryTexts[i] ?? ""} onChange={(e) => setTexts(texts.map((x, j) => (j === i ? e.target.value : x)))} style={{ marginBottom: 4 }} />
          ))}
        </div>
        <div>
          <small>Headlines (up to 5)</small>
          {heads.map((t, i) => (
            <input key={i} value={t} placeholder={ad.copy.headlines[i] ?? ""} onChange={(e) => setHeads(heads.map((x, j) => (j === i ? e.target.value : x)))} style={{ marginBottom: 4 }} />
          ))}
          <small>Descriptions (up to 5)</small>
          {descs.map((t, i) => (
            <input key={i} value={t} placeholder={ad.copy.descriptions[i] ?? ""} onChange={(e) => setDescs(descs.map((x, j) => (j === i ? e.target.value : x)))} style={{ marginBottom: 4 }} />
          ))}
          <small>Landing page</small>
          <input value={link} placeholder={ad.copy.linkUrl} onChange={(e) => setLink(e.target.value)} />
          <small>Display link (short link shown on the ad)</small>
          <input value={displayLink} placeholder={ad.copy.displayLink || "e.g. sahajta.com/visit"} onChange={(e) => setDisplayLink(e.target.value)} />
          <small>Lead form ID (only for ad sets that collect leads on Facebook)</small>
          <input value={leadFormId} placeholder={ad.copy.leadFormId || "none"} inputMode="numeric" onChange={(e) => setLeadFormId(e.target.value.trim())} />
          <small>Button</small>
          <select value={cta} onChange={(e) => setCta(e.target.value)}>
            <option value="">Same as batch ({ad.copy.cta.replace(/_/g, " ").toLowerCase()})</option>
            {tpl?.ctaTypes.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>)}
          </select>
          <small>Angle</small>
          <input value={angle} onChange={(e) => setAngle(e.target.value)} />
          <small>Multi-advertiser ads</small>
          <select value={multi} onChange={(e) => setMulti(e.target.value as typeof multi)}>
            <option value="same">Same as the preset ({presetMulti ? "on" : "off"})</option>
            <option value="on">On for this ad</option>
            <option value="off">Off for this ad</option>
          </select>
        </div>
      </div>
      {tpl && tpl.features.length > 0 && (
        <details open={enhOwn}>
          <summary>AI enhancements for this ad {enhOwn ? `(${enh.size} on, only for this ad)` : "(same as the preset)"}</summary>
          <p className="hint">Ticked means Meta may change this part of the ad. Untouched, the ad uses the preset.</p>
          <div className="grid2" style={{ marginTop: 6 }}>
            {tpl.features.map((f) => (
              <label className="check" key={f.key}>
                <input type="checkbox" checked={enh.has(f.key)} onChange={(e) => {
                  const n = new Set(enh);
                  if (e.target.checked) n.add(f.key); else n.delete(f.key);
                  setEnh(n);
                  setEnhOwn(true);
                }} />
                {f.label}
              </label>
            ))}
          </div>
          {enhOwn && <button className="link" style={{ marginTop: 6 }} onClick={() => { setEnhOwn(false); setEnh(new Set(presetOn)); }}>Use the preset&apos;s choice again</button>}
        </details>
      )}
      {error && <div className={msgClass(error)}>{error}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={() => save()}>Save for this ad</button>
        {ad.hasOverride && <button onClick={() => save(true)}>Use the batch copy again</button>}
      </div>
    </div>
  );
}

function MetaPreviews({ state }: { state: PreviewState | undefined }) {
  if (!state) return null;
  if (state.loading) return <small style={{ display: "block", marginTop: 4 }}>Asking Meta for the preview…</small>;
  if (state.error) return <div className={msgClass(state.error)} style={{ fontSize: 13 }}>{state.error}</div>;
  return (
    <div style={{ marginTop: 4, fontSize: 13 }}>
      {state.previews?.map((p) => (
        <div key={p.label}>
          {p.label}: {p.url ? <a href={p.url} target="_blank" rel="noreferrer">Open ↗</a> : <span style={{ color: "var(--warn)" }}>{p.problem ?? "No preview from Meta."}</span>}
        </div>
      ))}
      {state.previews?.some((p) => p.url) && <small>Links work for about a day.</small>}
    </div>
  );
}

export default function PreviewTable({ view, tpl, batchKey, onChange }: { view: BatchView; tpl: Templates | null; batchKey: string; onChange: (v: BatchView) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const [previews, setPreviews] = useState<Record<number, PreviewState>>({});
  const s = view.settings;
  const where = s.adsetMode === "new_per_ad" ? "New ad set" : s.adsetName ?? "No ad set picked";
  const presetOn = Object.keys(s.preset?.enhancements ?? {});
  const presetMulti = !!s.preset?.multiAdvertiser;

  async function preview(ad: Ad) {
    setPreviews((p) => ({ ...p, [ad.id]: { loading: true } }));
    try {
      const r = await api<{ previews: MetaPreview[] }>(`/api/batches/${batchKey}/previews?ad=${ad.position}`);
      setPreviews((p) => ({ ...p, [ad.id]: { loading: false, previews: r.previews } }));
    } catch (e) {
      setPreviews((p) => ({ ...p, [ad.id]: { loading: false, error: (e as Error).message } }));
    }
  }

  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Name in Meta</th>
          <th>Files</th>
          <th>Copy</th>
          <th>Goes to</th>
          <th>Check</th>
        </tr>
      </thead>
      <tbody>
        {view.ads.map((ad) => {
          const errors = ad.checks.filter((c) => c.level === "error");
          const warnings = ad.checks.filter((c) => c.level === "warning");
          const pv = previews[ad.id];
          return (
            <Fragment key={ad.id}>
              <tr className={errors.length ? "has-error" : ""}>
                <td>{ad.position}</td>
                <td className="name-cell">{ad.metaName}</td>
                <td>
                  {ad.files.map((f) => (
                    <div key={f.id} style={{ fontSize: 13 }}>
                      <span className={`badge ${f.ratio === "9x16" ? "v" : ""}`}>{f.ratio?.replace("x", ":") ?? "?"}</span> {f.filename}
                      <small> · {f.size}{f.durationSec ? ` · ${Math.round(f.durationSec)}s` : ""} · {f.placement}</small>
                    </div>
                  ))}
                </td>
                <td style={{ maxWidth: 260 }}>
                  {ad.hasOverride && <span className="badge">Changed for this ad</span>}
                  <div>{ad.copy.primaryTexts[0] ?? <span style={{ color: "var(--err)" }}>no text</span>}</div>
                  {ad.copy.primaryTexts.length > 1 && <small>+{ad.copy.primaryTexts.length - 1} more texts, </small>}
                  <small>{ad.copy.headlines.length} headline{ad.copy.headlines.length === 1 ? "" : "s"}</small>
                  <div>
                    <button className="link" onClick={() => setOpen(open === ad.id ? null : ad.id)}>{open === ad.id ? "Close" : "Change copy for this ad"}</button>
                  </div>
                  <button style={{ height: 30, fontSize: 13, marginTop: 6 }} disabled={pv?.loading} onClick={() => preview(ad)}>
                    {pv?.loading ? "Loading…" : pv ? "Preview in Meta again" : "Preview in Meta"}
                  </button>
                  <MetaPreviews state={pv} />
                </td>
                <td>
                  <small>{s.campaignName ?? "No campaign"}</small>
                  <div>
                    {s.adsetMode === "new_per_ad" ? <span className="name-cell">{ad.adsetName}</span>
                      : s.adsetMode === "new_shared" ? <><small>One new ad set for all: </small><span className="name-cell">{ad.adsetName}</span></>
                      : where}
                  </div>
                </td>
                <td style={{ maxWidth: 280 }}>
                  {!errors.length && !warnings.length && <span className="status done">Ready</span>}
                  <ul className="checks">
                    {[...errors, ...warnings].map((c) => <li key={c.code + c.message} className={c.level}>{c.message}</li>)}
                  </ul>
                </td>
              </tr>
              {open === ad.id && (
                <tr>
                  <td colSpan={6}>
                    <Override ad={ad} tpl={tpl} presetOn={presetOn} presetMulti={presetMulti} batchKey={batchKey} onDone={(v) => { onChange(v); setOpen(null); }} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
