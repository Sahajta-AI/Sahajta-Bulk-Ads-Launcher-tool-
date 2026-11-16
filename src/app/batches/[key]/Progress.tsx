"use client";

import type { BatchView } from "@/lib/service";
import { api } from "../../client-api";

// After launch: live progress per ad, then links to Ads Manager and Meta's review status.

function reviewClass(s: string | null) {
  if (!s) return "pending";
  if (s === "DISAPPROVED" || s === "WITH_ISSUES" || s === "DELETED" || s === "ARCHIVED") return "failed";
  if (s === "PENDING_REVIEW" || s === "IN_PROCESS") return "working";
  return "done";
}

function minutesSince(iso: string | null) {
  if (!iso) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(iso.endsWith("Z") ? iso : `${iso}Z`).getTime()) / 60000));
}

export default function Progress({ view, busy, error, act, batchKey }: { view: BatchView; busy: string; error: string; act: (label: string, fn: () => Promise<BatchView | void>) => void; batchKey: string }) {
  const { progress: pr } = view;
  const running = view.status === "queued" || view.status === "running";
  const pct = pr.total ? Math.round(((pr.done + pr.failed) / pr.total) * 100) : 0;
  const elapsed = minutesSince(view.launchedAt);

  return (
    <>
      <h1>{running ? "Launching…" : pr.failed ? "Some ads need another try" : "Ads created"}</h1>
      <p className="lead">
        {view.source.kind === "drive" ? `From Drive: ${view.source.label}` : "Uploaded files"} · {view.settings.campaignName} →{" "}
        {view.settings.adsetMode === "new_per_ad" ? "a new ad set per ad" : view.settings.adsetName}
      </p>

      <div className="panel">
        <header>
          <span className={`status ${view.status}`}>{view.statusLabel}</span>
          <strong>{pr.done} of {pr.total} ads created{pr.failed ? `, ${pr.failed} failed` : ""}</strong>
          {view.links.campaign && <a href={view.links.campaign} target="_blank" rel="noreferrer" style={{ marginLeft: "auto" }}>Open campaign in Ads Manager</a>}
        </header>
        <div className="bar"><div style={{ width: `${pct}%` }} /></div>
        {running && (
          <p className="muted">
            {elapsed > 0 ? `${elapsed} minute${elapsed === 1 ? "" : "s"} so far. ` : ""}
            {view.launchEstimate ? `Estimate at launch: ${view.launchEstimate}. ` : ""}Still to do: {view.preview.estimate.label}. You can close this page; the launch carries on.
          </p>
        )}
        {!running && (
          <div className="msg info">
            Every ad is <strong>paused</strong>. Review them in Ads Manager and switch them on yourself when you are happy.
          </div>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          {pr.failed > 0 && !running && (
            <button className="primary" disabled={!!busy} onClick={() => act("retry", () => api<BatchView>(`/api/batches/${batchKey}/retry`, { method: "POST" }))}>
              {busy === "retry" ? "Starting…" : `Retry the ${pr.failed} failed ad${pr.failed === 1 ? "" : "s"} only`}
            </button>
          )}
          {!running && pr.done > 0 && (
            <button disabled={!!busy} onClick={() => act("review", async () => { await api(`/api/batches/${batchKey}/review`, { method: "POST" }); })}>
              {busy === "review" ? "Asking Meta…" : "Check Meta review status now"}
            </button>
          )}
        </div>
        {error && <div className="msg error">{error}</div>}
      </div>

      <div className="panel"><div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Ad</th>
              <th>Progress</th>
              <th>Meta review</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {view.ads.map((ad) => (
              <tr key={ad.id} className={ad.status === "failed" ? "has-error" : ""}>
                <td>{ad.position}</td>
                <td className="name-cell">
                  {ad.metaName}
                  <div style={{ fontFamily: "inherit" }}>
                    {ad.files.map((f) => <span key={f.id} className={`badge ${f.ratio === "9x16" ? "v" : ""}`} style={{ marginRight: 4 }}>{f.ratio?.replace("x", ":") ?? "?"}</span>)}
                  </div>
                </td>
                <td style={{ maxWidth: 320 }}>
                  <span className={`status ${ad.status}`}>{{ pending: "Waiting", working: "Working", waiting: "Waiting for Meta", done: "Created", failed: "Failed" }[ad.status] ?? ad.status}</span>
                  {ad.status !== "done" && ad.step && <div><small>{ad.step}</small></div>}
                  {ad.error && <div className="msg error" style={{ fontSize: 13 }}>{ad.error}</div>}
                  {ad.featureWarnings.map((w) => <div key={w} className="msg warning" style={{ fontSize: 13 }}>{w}</div>)}
                </td>
                <td style={{ maxWidth: 240 }}>
                  {ad.metaAdId ? <span className={`status ${reviewClass(ad.effectiveStatus)}`}>{ad.reviewLabel}</span> : <small>—</small>}
                  {ad.reviewIssues.map((i) => <div key={i} style={{ fontSize: 13, color: "var(--err)" }}>{i}</div>)}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>{ad.adsManagerUrl && <a href={ad.adsManagerUrl} target="_blank" rel="noreferrer">Open ↗</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>

      <details className="panel">
        <summary>Activity log</summary>
        <div className="events">
          {view.events.map((e, i) => (
            <div key={i} className={e.level}>
              <small>{new Date(`${e.at}Z`).toLocaleTimeString()}</small> {e.message}
            </div>
          ))}
        </div>
      </details>
    </>
  );
}
