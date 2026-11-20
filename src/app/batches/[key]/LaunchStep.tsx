"use client";

import { Fragment, useEffect, useState } from "react";
import type { LaunchSummary } from "@/lib/manage/golive";
import type { BatchView, CampaignInfo, ConnectionSummary } from "@/lib/service";
import { api } from "../../client-api";
import IdentityCard from "../../IdentityCard";
import { isoToIstInput, istInputToIso } from "../../manage/util";
import { msgClass } from "../../msg";
import { summaryFor } from "./batch-logic";

// Step 7: when the ads go live, more ad sets for the same ads, and the pre-launch summary
// (accounts, every budget and the total, schedule, audience, placements, copy) that must be
// read before Launch. A launch that turns ads on needs the total daily budget typed back.

export interface Summary { connection: ConnectionSummary; launch: LaunchSummary | null }

/**
 * The pre-launch summary (it reads Meta). Asked for when `key` changes; null = don't ask
 * (batch not loaded yet, or already launched). `retry` asks again after an error. A summary asked
 * for an earlier key is never shown (its total may be out of date), only "Asking Meta…".
 */
export function useSummary(batchKey: string, key: string | null) {
  const [got, setGot] = useState<{ key: string | null; value: Summary } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setLoading(true);
    setError("");
    api<Summary>(`/api/batches/${batchKey}/summary`)
      .then((s) => { if (live) setGot({ key, value: s }); })
      .catch((e: Error) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [batchKey, key, again]);
  return { summary: summaryFor(got, key), error, loading, retry: () => setAgain((n) => n + 1) };
}

export default function LaunchStep({ view, dest, patch, summary, summaryError, summaryLoading, retrySummary }: {
  view: BatchView;
  dest: CampaignInfo[] | null;
  patch: (b: Record<string, unknown>) => void;
  summary: Summary | null;
  summaryError: string;
  summaryLoading: boolean;
  retrySummary: () => void;
}) {
  const s = view.settings;
  const extraIds = new Set(s.extraAdsets.map((x) => x.id));
  const l = summary?.launch;
  const c = summary?.connection;
  // Ads with a link of their own: the batch's link above is not theirs.
  const ownLinks = view.ads.filter((a) => a.hasOverride && a.copy.linkUrl !== s.copy.linkUrl).length;

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
          <input type="datetime-local" defaultValue={isoToIstInput(s.goLiveAt)} key={s.goLiveAt ?? "none"} onBlur={(e) => e.target.value && e.target.value !== isoToIstInput(s.goLiveAt) && patch({ goLiveAt: istInputToIso(e.target.value) })} />
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
      {summaryError && (
        <div className={msgClass(summaryError)}>
          {summaryError} <button className="link" disabled={summaryLoading} onClick={retrySummary}>{summaryLoading ? "Asking Meta…" : "Try again"}</button>
        </div>
      )}
      {summaryLoading && !summary && !summaryError && <p className="muted">Asking Meta for the budgets…</p>}
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
            <dt>{(l.campaigns ?? []).length > 1 ? "Campaigns" : "Campaign"}</dt>
            <dd>
              {(l.campaigns?.length ? l.campaigns : l.campaign ? [l.campaign] : []).map((c) => (
                <div key={c.id}>{c.name} <small>({c.status.toLowerCase()} · {c.budget})</small></div>
              ))}
              {!l.campaigns?.length && !l.campaign && "—"}
            </dd>
            <dt>Ads</dt><dd>{view.ads.length * (1 + s.extraAdsets.length)}</dd>
            <dt>Time</dt><dd>{view.preview.estimate.text}</dd>
            <dt>When</dt><dd>{l.goLive}</dd>
            <dt>Copy</dt><dd>{l.copy.primaryTexts} primary text{l.copy.primaryTexts === 1 ? "" : "s"}, {l.copy.headlines} headline{l.copy.headlines === 1 ? "" : "s"}, {l.copy.cta.replace(/_/g, " ").toLowerCase()} → {l.copy.link ? <a href={l.copy.link} target="_blank" rel="noreferrer">{l.copy.link}</a> : <span style={{ color: "var(--err)" }}>no link</span>}
              {" "}· display link {s.copy.displayLink || "none"} · {s.copy.descriptions.length ? `${s.copy.descriptions.length} description${s.copy.descriptions.length === 1 ? "" : "s"}: ${s.copy.descriptions.map((d) => `“${d}”`).join(", ")}` : "description none"}
              {ownLinks > 0 && <div><small>{ownLinks} ad{ownLinks === 1 ? " has its" : "s have their"} own link (shown in the ads table).</small></div>}
            </dd>
            <dt>Settings</dt><dd>WhatsApp number {s.preset?.whatsappNumber || "none"} · Threads account {s.preset?.threadsUserId || "none"} · branded content partner Page {s.preset?.sponsorPageId || "none"}</dd>
            {(l.health ?? []).map((h) => {
              const at = h.indexOf(": ");
              return <Fragment key={h}><dt>{at > 0 ? h.slice(0, at) : "Check"}</dt><dd>{at > 0 ? h.slice(at + 2) : h}</dd></Fragment>;
            })}
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
          {l.checks.filter((c) => c.level === "error").map((c) => <div key={c.code + c.message} className="msg error">{c.message}</div>)}
          {l.checks.filter((c) => c.level === "warning").map((c) => <div key={c.code + c.message} className="msg warning">{c.message}</div>)}
          {s.goLive !== "paused" && l.checks.some((c) => c.level === "error") && (
            <p className="hint">Ads can&apos;t be turned on until the red items above are fixed. You can still create them paused.</p>
          )}
          <div className="total-budget">Total daily budget: <strong>{l.totalDailyLabel}</strong></div>
          {(l.lifetimeBudgets ?? []).length > 0 && (
            <div className="msg info">
              The total counts each lifetime budget as what it can spend in one day:
              <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                {l.lifetimeBudgets.map((x) => <li key={x}>{x}</li>)}
              </ul>
            </div>
          )}
          {l.alsoSpends.map((x) => <div key={x} className="msg warning">{x}</div>)}
          {l.warnings.map((w) => <div key={w} className="msg warning">{w}</div>)}
        </>
      )}
    </section>
  );
}
