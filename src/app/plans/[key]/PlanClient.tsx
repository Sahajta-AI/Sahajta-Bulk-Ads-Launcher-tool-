"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../../client-api";
import s from "../../manage/manage.module.css";
import { ist, planPill, rupees, type PlanView } from "../../manage/util";

const STEP_PILL: Record<string, { cls: string; label: string }> = {
  pending: { cls: "draft", label: "Waiting" },
  running: { cls: "running", label: "Running" },
  done: { cls: "done", label: "Done" },
  failed: { cls: "failed", label: "Failed" },
  skipped: { cls: "draft", label: "Skipped" },
};

export default function PlanClient({ planKey }: { planKey: string }) {
  const [view, setView] = useState<PlanView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [accept, setAccept] = useState(false);
  const [typed, setTyped] = useState("");

  const load = useCallback(async () => {
    try {
      setView(await api<PlanView>(`/api/plans/${planKey}/view`));
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [planKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live progress while the plan waits or runs. A plan scheduled far ahead is checked less often.
  useEffect(() => {
    if (!view || (view.status !== "queued" && view.status !== "running")) return;
    const farAhead = view.status === "queued" && view.runAt && Date.parse(view.runAt) - Date.now() > 60_000;
    const t = setInterval(() => void load(), farAhead ? 30_000 : 4000);
    return () => clearInterval(t);
  }, [view, load]);

  async function confirm() {
    if (!view) return;
    setBusy("confirm");
    setError("");
    try {
      setView(await api<PlanView>(`/api/plans/${planKey}/confirm`, { method: "POST", body: { confirm: true, acceptWarnings: accept, spendConfirmation: typed.trim() || undefined } }));
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setBusy("");
    }
  }

  async function cancel() {
    if (!window.confirm("Cancel this plan? Steps that already ran stay as they are. Steps not yet run will not run.")) return;
    setBusy("cancel");
    setError("");
    try {
      setView(await api<PlanView>(`/api/plans/${planKey}/cancel`, { method: "POST", body: {} }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (loadError && !view) {
    return (
      <>
        <p><a href="/manage">← Campaigns</a></p>
        <div className="msg error">{loadError}</div>
      </>
    );
  }
  if (!view) return <p className="muted">Loading the plan…</p>;

  const sum = view.summary;
  const cur = sum?.account.currency ?? "INR";
  const money = (n: number | null | undefined) => (n === null || n === undefined ? "–" : rupees(n, cur));
  const errors = sum?.checks.filter((c) => c.level === "error") ?? [];
  const warnings = sum?.checks.filter((c) => c.level === "warning") ?? [];
  const isDraft = view.status === "draft";
  const canCancel = ["draft", "queued", "running"].includes(view.status);
  const needsTyping = !!sum?.canSpend;
  const ready = !!sum && errors.length === 0 && (warnings.length === 0 || accept) && (!needsTyping || typed.trim() !== "");

  return (
    <>
      <p><a href="/manage">← Campaigns</a></p>
      <div className={s.title}>
        <h1>{view.title || "Change plan"}</h1>
      </div>
      <p style={{ marginBottom: 6 }}>
        <span className={`status ${planPill(view.status)}`}>{view.statusLabel}</span>
      </p>
      <p className="muted" style={{ marginBottom: 24 }}>
        Made by {view.createdBy ?? "someone"} {view.source === "claude" ? "through Claude" : "in the app"} on {ist(view.createdAt)}.
        {view.runAt ? <> Scheduled for {ist(view.runAt)}.</> : null}
        {view.confirmedAt ? <> Confirmed by {view.confirmedBy ?? "someone"} on {ist(view.confirmedAt)}.</> : null}
        {view.finishedAt ? <> Finished on {ist(view.finishedAt)}.</> : null}
      </p>

      {error && <div className="msg error" style={{ whiteSpace: "pre-line" }}>{error}</div>}
      {loadError && <div className="msg warning">Could not refresh: {loadError}</div>}

      {!isDraft && (
        <div className="panel">
          <header><h2>Progress</h2></header>
          {view.status === "cancelled" && <div className="msg info">This plan was cancelled. Steps that had not run yet will not run.</div>}
          {view.progress.map((p) => {
            const pill = STEP_PILL[p.status] ?? { cls: "draft", label: p.status };
            return (
              <div key={p.n} className="list-item" style={{ alignItems: "flex-start" }}>
                <span className="step">{p.n}</span>
                <div className="grow">
                  <div>{p.title}</div>
                  {p.message && <div className={p.status === "failed" ? "msg error" : "hint"}>{p.message}</div>}
                  {p.ids.length > 0 && <div className={s.ids}>Created or changed: {p.ids.join(", ")}</div>}
                </div>
                <span className={`status ${pill.cls}`}>{pill.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {!sum && <div className="msg warning">This plan has not been checked yet.</div>}

      {sum && (
        <>
          <div className="panel">
            <header><h2>What this plan does</h2></header>
            <dl className="kv" style={{ marginTop: 0 }}>
              <dt>Ad account</dt>
              <dd>{sum.account.name || "Ad account"} ({sum.account.id})</dd>
              <dt>When</dt>
              <dd>{sum.runAt ? ist(sum.runAt) : "As soon as you confirm"}</dd>
            </dl>
            {sum.steps.map((st) => (
              <div key={st.n} className="list-item" style={{ alignItems: "flex-start" }}>
                <span className="step">{st.n}</span>
                <div className="grow">
                  <strong style={{ fontWeight: 600 }}>{st.title}</strong>
                  {st.lines.length > 0 && (
                    <ul className={s.stepLines}>
                      {st.lines.map((l, i) => <li key={i}>{l}</li>)}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>

          {sum.adsets.length > 0 && (
            <div className="panel">
              <header><h2>Every ad set in this plan</h2></header>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Step</th><th>Ad set</th><th>Campaign</th><th>Daily budget</th><th>Lifetime budget</th><th>Bid</th><th>Schedule</th><th>Audience</th><th>Placements</th></tr>
                  </thead>
                  <tbody>
                    {sum.adsets.map((a, i) => {
                      const d = a.details;
                      const other = d.change ? `Change: ${d.change}` : !d.bid && d.status ? (d.status === "ACTIVE" ? "Turn ON" : "Turn off") : null;
                      return (
                        <tr key={i}>
                          <td>{a.step}</td>
                          <td>{a.name}</td>
                          <td>{a.campaign}</td>
                          <td>{a.dailyBudget !== null ? money(a.dailyBudget) : <span className="muted">{d.budget === "campaign budget" ? "Campaign budget" : "–"}</span>}</td>
                          <td>{money(a.lifetimeBudget)}</td>
                          {other !== null ? (
                            <td colSpan={4} style={d.status === "ACTIVE" ? { color: "var(--err)", fontWeight: 500 } : undefined}>{other}</td>
                          ) : (
                            <>
                              <td>{d.bid}</td>
                              <td>{d.schedule}</td>
                              <td style={{ minWidth: 200 }}>{d.audience}</td>
                              <td style={{ minWidth: 160 }}>{d.placements}</td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="panel">
            <header><h2>Totals</h2></header>
            <small className="muted">Total daily budget in this plan</small>
            <div className={s.big}>{money(sum.totals.dailyBudget)}</div>
            <div className={s.totals} style={{ marginTop: 14 }}>
              <div><small>Lifetime budgets</small>{money(sum.totals.lifetimeBudget)}</div>
              <div><small>Campaigns</small>{sum.totals.campaigns}</div>
              <div><small>Ad sets</small>{sum.totals.adsets}</div>
              <div><small>Ads</small>{sum.totals.ads}</div>
            </div>
            {sum.totals.turnsOn.length > 0 && (
              <div className={s.spend}>
                <strong>This turns on:</strong>
                <ul>{sum.totals.turnsOn.map((t, i) => <li key={i}>{t}</li>)}</ul>
                Daily budget able to spend afterwards: <strong>{money(sum.totals.spendNowDaily)}</strong>
              </div>
            )}
          </div>

          {(errors.length > 0 || warnings.length > 0) && (
            <div className="panel">
              <header><h2>Checks</h2></header>
              {errors.length > 0 && <p className="hint" style={{ marginTop: 0 }}>Fix these problems first. Make a new plan from the Campaigns page with the fix.</p>}
              {errors.map((c, i) => <div key={`e${i}`} className="msg error">{c.message}</div>)}
              {warnings.map((c, i) => <div key={`w${i}`} className="msg warning">{c.message}</div>)}
              {isDraft && warnings.length > 0 && (
                <label className="check" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                  I have read the warnings
                </label>
              )}
            </div>
          )}

          {isDraft && (
            <div className="panel">
              <header><h2>Confirm</h2></header>
              <p className="muted" style={{ marginTop: 0 }}>Nothing has changed in Meta yet. The plan runs only after you confirm.</p>
              {needsTyping && (
                <label className="field" style={{ marginTop: 12 }}>
                  <span>This plan turns things on, so Meta will spend money. Type the total daily budget to confirm: <strong>{sum.spendConfirmation}</strong></span>
                  <input className={s.confirmInput} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={sum.spendConfirmation ?? "₹15,000"} inputMode="decimal" autoComplete="off" />
                </label>
              )}
              <div className={s.actions} style={{ marginTop: 16 }}>
                <button className="primary big" disabled={!ready || !!busy} onClick={confirm}>
                  {busy === "confirm" ? "Starting…" : view.runAt ? "Schedule the plan" : "Run the plan"}
                </button>
                <button className="danger" disabled={!!busy} onClick={cancel}>{busy === "cancel" ? "Cancelling…" : "Cancel plan"}</button>
              </div>
              {errors.length > 0 && <p className="hint">You can’t run this plan while it has problems.</p>}
            </div>
          )}
        </>
      )}

      {(!isDraft || !sum) && canCancel && (
        <div className={s.actions}>
          <button className="danger" disabled={!!busy} onClick={cancel}>{busy === "cancel" ? "Cancelling…" : "Cancel plan"}</button>
        </div>
      )}
    </>
  );
}
