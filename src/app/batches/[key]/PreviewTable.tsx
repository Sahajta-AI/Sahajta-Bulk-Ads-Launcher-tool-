"use client";

import { Fragment, useState } from "react";
import type { BatchView } from "@/lib/service";
import { api } from "../../client-api";
import type { Templates } from "./BatchClient";

// One row per ad: name, files, copy, destination, problems. "Change copy" edits one ad only.

type Ad = BatchView["ads"][number];

function Override({ ad, tpl, batchKey, onDone }: { ad: Ad; tpl: Templates | null; batchKey: string; onDone: (v: BatchView) => void }) {
  const pad = (a: string[]) => [...a, "", "", "", "", ""].slice(0, 5);
  // Start from this ad's earlier changes, so saving one field never wipes the others.
  const o = ad.override ?? {};
  const [texts, setTexts] = useState(pad(o.primaryTexts ?? []));
  const [heads, setHeads] = useState(pad(o.headlines ?? []));
  const [desc, setDesc] = useState(o.description ?? "");
  const [link, setLink] = useState(o.linkUrl ?? "");
  const [cta, setCta] = useState(o.cta ?? "");
  const [angle, setAngle] = useState(ad.angle);
  const [error, setError] = useState("");

  async function save(clear = false) {
    try {
      const body = clear
        ? { copy: {}, angle: "" }
        : { copy: { primaryTexts: texts.filter((t) => t.trim()), headlines: heads.filter((t) => t.trim()), description: desc, linkUrl: link, cta }, angle };
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
          <small>Description</small>
          <input value={desc} placeholder={ad.copy.description} onChange={(e) => setDesc(e.target.value)} />
          <small>Landing page</small>
          <input value={link} placeholder={ad.copy.linkUrl} onChange={(e) => setLink(e.target.value)} />
          <small>Button</small>
          <select value={cta} onChange={(e) => setCta(e.target.value)}>
            <option value="">Same as batch ({ad.copy.cta.replace(/_/g, " ").toLowerCase()})</option>
            {tpl?.ctaTypes.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>)}
          </select>
          <small>Angle</small>
          <input value={angle} onChange={(e) => setAngle(e.target.value)} />
        </div>
      </div>
      {error && <div className="msg error">{error}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={() => save()}>Save for this ad</button>
        {ad.hasOverride && <button onClick={() => save(true)}>Use the batch copy again</button>}
      </div>
    </div>
  );
}

export default function PreviewTable({ view, tpl, batchKey, onChange }: { view: BatchView; tpl: Templates | null; batchKey: string; onChange: (v: BatchView) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const s = view.settings;
  const where = s.adsetMode === "new_per_ad" ? "New ad set" : s.adsetName ?? "No ad set picked";

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
                </td>
                <td>
                  <small>{s.campaignName ?? "No campaign"}</small>
                  <div>{s.adsetMode === "new_per_ad" ? <span className="name-cell">{ad.adsetName}</span> : where}</div>
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
                    <Override ad={ad} tpl={tpl} batchKey={batchKey} onDone={(v) => { onChange(v); setOpen(null); }} />
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
