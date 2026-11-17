"use client";

import { useEffect, useState } from "react";
import type { LaunchSummary } from "@/lib/manage/golive";
import type { BatchView, CampaignInfo, ConnectionSummary } from "@/lib/service";
import { api } from "../../client-api";
import IdentityCard from "../../IdentityCard";

// Step 7: when the ads go live, more ad sets for the same ads, and the pre-launch summary
// (accounts, every budget and the total, schedule, audience, placements, copy) that must be
// read before Launch. A launch that turns ads on needs the total daily budget typed back.

/** ISO → value for <input type="datetime-local"> in the browser's time (India). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface Summary { connection: ConnectionSummary; launch: LaunchSummary | null }

export function useSummary(batchKey: string, deps: unknown[]) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api<Summary>(`/api/batches/${batchKey}/summary`)
      .then((s) => { if (live) { setSummary(s); setError(""); } })
      .catch((e: Error) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { summary, error, loading };
}

export default function LaunchStep({ view, dest, patch, summary, summaryError, summaryLoading }: {
  view: BatchView;
  dest: CampaignInfo[] | null;
  patch: (b: Record<string, unknown>) => void;
  summary: Summary | null;
  summaryError: string;
  summaryLoading: boolean;
}) {
  const s = view.settings;
  const extraIds = new Set(s.extraAdsets.map((x) => x.id));
  const l = summary?.launch;
  const c = summary?.connection;

  return (
    <section className="panel">
      <header>
        <span className={`step ${l ? "done" : ""}`}>7</span><h2>Launch and summary</h2>
        <p className="hint">Read this before you press Launch. It is what Meta will get.</p>
      </header>

      <div className="golive" role="radiogroup" aria-label="When the ads go live">
        {([
          ["paused", "Create paused", "Nothing spends until someone turns it on."],
          ["now", "Launch now", "Turned on as soon as every ad is created."],
          ["at", "Schedule", "Created now, turned on at a date and time."],
        ] as const).map(([v, title, sub]) => (
          <label key={v} className={s.goLive === v ? "on" : ""}>
            <input type="radio" name="golive" checked={s.goLive === v} onChange={() => patch({ goLive: v })} />
            <strong>{title}</strong>
            <small>{sub}</small>
          </label>
        ))}
      </div>
      {s.goLive === "at" && (
        <label className="field" style={{ marginTop: 10, maxWidth: 280 }}>
          <span>Turn on at (India time)</span>
          <input type="datetime-local" defaultValue={toLocalInput(s.goLiveAt)} key={s.goLiveAt ?? "none"} onBlur={(e) => e.target.value && patch({ goLiveAt: new Date(e.target.value).toISOString() })} />
        </label>
      )}

      <details style={{ marginTop: 12 }} open={s.extraAdsets.length > 0}>
        <summary>Also put the same ads into more ad sets {s.extraAdsets.length ? `(${s.extraAdsets.length} picked)` : ""}</summary>
        <p className="hint">Each ad set gets every ad of this batch. Files are uploaded to Meta once.</p>
        {!dest && <p className="muted">Loading ad sets…</p>}
        <div className="extra-adsets">
          {dest?.map((camp) => (
            <div key={camp.id}>
              <small className="muted">{camp.name}</small>
              {camp.adsets.filter((a) => a.id !== s.adsetId && !a.isDynamicCreative).map((a) => (
                <label key={a.id} className="check">
                  <input type="checkbox" checked={extraIds.has(a.id)} onChange={(e) => {
                    const next = new Set(extraIds);
                    if (e.target.checked) next.add(a.id); else next.delete(a.id);
                    patch({ extraAdsetIds: [...next] });
                  }} />
                  {a.name}
                </label>
              ))}
            </div>
          ))}
        </div>
      </details>

      <h3 style={{ marginTop: 18 }}>Summary</h3>
      {summaryError && <div className="msg error">{summaryError}</div>}
      {summaryLoading && !summary && <p className="muted">Asking Meta for the budgets…</p>}
      {c && (
        <>
          <dl className="kv">
            <dt>Ad account</dt>
            <dd>{c.adAccount ? <>{c.adAccount.name} <small>({c.adAccount.id.replace("act_", "")})</small></> : "Not connected"}</dd>
          </dl>
          <div className="identities">
            {c.page && <IdentityCard kind="page" name={c.page.name} id={c.page.id} pictureUrl={c.page.pictureUrl} link={c.page.link} />}
            {c.instagram
              ? <IdentityCard kind="instagram" name={c.instagram.username} id={c.instagram.id} pictureUrl={c.instagram.pictureUrl} link={c.instagram.link} warning={c.instagram.allowed === false ? "Not allowed for this ad account: Meta will refuse the ads." : null} />
              : <div className="list-item"><span className="grow">Instagram</span>None (Instagram ads show the Facebook Page)</div>}
          </div>
          {c.problems.map((p) => <div key={p} className="msg error">{p}</div>)}
        </>
      )}
      {l && (
        <>
          <dl className="kv">
            <dt>Campaign</dt><dd>{l.campaign ? <>{l.campaign.name} <small>({l.campaign.status.toLowerCase()} · {l.campaign.budget})</small></> : "—"}</dd>
            <dt>Ads</dt><dd>{l.adCount}</dd>
            <dt>When</dt><dd>{l.goLive}</dd>
            <dt>Copy</dt><dd>{l.copy.primaryTexts} primary text{l.copy.primaryTexts === 1 ? "" : "s"}, {l.copy.headlines} headline{l.copy.headlines === 1 ? "" : "s"}, {l.copy.cta.replace(/_/g, " ").toLowerCase()} → {l.copy.link ? <a href={l.copy.link} target="_blank" rel="noreferrer">{l.copy.link}</a> : <span style={{ color: "var(--err)" }}>no link</span>}</dd>
            {l.copy.utm && <><dt>Link tags</dt><dd><code style={{ overflowWrap: "anywhere" }}>{l.copy.utm}</code></dd></>}
          </dl>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ad set</th><th>Budget</th><th>Bid</th><th>Schedule</th><th>Goal</th><th>Audience</th><th>Placements</th></tr></thead>
              <tbody>
                {l.adsets.map((a) => (
                  <tr key={a.name}><td>{a.name}</td><td>{a.budget}</td><td>{a.bid}</td><td>{a.schedule}</td><td>{a.goal}</td><td style={{ minWidth: 200 }}>{a.audience}</td><td>{a.placements}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="total-budget">Total daily budget: <strong>{l.totalDailyLabel}</strong></div>
          {l.alsoSpends.map((x) => <div key={x} className="msg warning">{x}</div>)}
          {l.warnings.map((w) => <div key={w} className="msg warning">{w}</div>)}
        </>
      )}
    </section>
  );
}
