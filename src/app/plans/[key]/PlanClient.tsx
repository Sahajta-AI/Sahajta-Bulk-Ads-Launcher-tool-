"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../client-api";
import { msgClass } from "../../msg";
import { DeliveryTable } from "../../manage/delivery";
import s from "../../manage/manage.module.css";
import { planPill, rupees, type PlanView } from "../../manage/util";
import { planChecks, reopenedReason, spendWords, timeLabel } from "./plan-logic";

const STEP_PILL: Record<string, { cls: string; label: string }> = {
  pending: { cls: "draft", label: "Waiting" },
  running: { cls: "running", label: "Running" },
  done: { cls: "done", label: "Done" },
  failed: { cls: "failed", label: "Failed" },
  skipped: { cls: "draft", label: "Skipped" },
  stopped: { cls: "partial", label: "Stopped" },
};

export default function PlanClient({ planKey }: { planKey: string }) {
  const router = useRouter();
  const [view, setView] = useState<PlanView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [accept, setAccept] = useState(false);
  const [typed, setTyped] = useState("");
  const [opsText, setOpsText] = useState("");
  const [opsError, setOpsError] = useState("");
  const [showDelivery, setShowDelivery] = useState(false);

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

  async function retry(withOps: boolean) {
    setError("");
    setOpsError("");
    let body: { ops?: unknown[] } = {};
    if (withOps) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(opsText);
      } catch (e) {
        setOpsError(`This is not valid JSON, so it can't be checked. ${(e as Error).message}`);
        return;
      }
      if (!Array.isArray(parsed)) {
        setOpsError("The steps must be a list: start with [ and end with ].");
        return;
      }
      body = { ops: parsed };
    }
    setBusy(withOps ? "retryOps" : "retry");
    try {
      const v = await api<PlanView>(`/api/plans/${planKey}/retry`, { method: "POST", body });
      setView(v);
      setAccept(false);
      setTyped("");
      setOpsText(JSON.stringify(v.input.ops, null, 2));
    } catch (e) {
      if (withOps) setOpsError((e as Error).message);
      else setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function undo() {
    if (!window.confirm("This makes a new plan that puts back names, budgets, bids, audiences and on/off as they were, and turns off what this plan made. Nothing is deleted. You check it before it runs.")) return;
    setBusy("undo");
    setError("");
    try {
      const v = await api<PlanView>(`/api/plans/${planKey}/undo`, { method: "POST", body: {} });
      router.push(`/plans/${v.key}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  }

  if (loadError && !view) {
    return (
      <>
        <p><a href="/manage">← Campaigns</a></p>
        <div className={msgClass(loadError)}>{loadError}</div>
      </>
    );
  }
  if (!view) return <p className="muted">Loading the plan…</p>;

  const sum = view.summary;
  const cur = sum?.account.currency ?? "INR";
  const money = (n: number | null | undefined) => (n === null || n === undefined ? "–" : rupees(n, cur));
  const isDraft = view.status === "draft";
  // The plan's own notes (what a retry or undo can't put back) show by the confirm button of a draft.
  const { errors, warnings, notes, toAccept } = planChecks(sum?.checks, isDraft);
  const canCancel = ["draft", "queued", "running"].includes(view.status);
  const needsTyping = !!sum?.canSpend;
  const spend = sum ? spendWords(sum.totals, sum.spendConfirmation, money) : null;
  // Sent back to a draft just before its run time (budgets changed, a problem found): why, at the top.
  const reopened = reopenedReason(view);
  const ready = !!sum && errors.length === 0 && (toAccept === 0 || accept) && (!needsTyping || typed.trim() !== "");
  const stopped = view.status === "partial" || view.status === "failed";
  const ran = view.status === "done" || stopped;
  const somethingRan = view.progress.some((p) => p.status === "done" || p.status === "failed" || p.status === "stopped" || p.ids.length > 0);
  const canUndo = ["done", "partial", "failed", "cancelled"].includes(view.status) && somethingRan;
  // A plan sent back to draft by "Try the rest again" still has finished steps; its steps can change too.
  const retried = isDraft && view.progress.some((p) => p.status === "done");
  const editor = (stopped || retried) && (
    <details style={{ marginTop: 14 }} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !opsText) setOpsText(JSON.stringify(view.input.ops, null, 2)); }}>
      <summary>Change the plan’s steps (advanced)</summary>
      <p className="hint" style={{ marginTop: 0 }}>
        The steps are written as JSON. Steps that already finished must stay exactly as they are; change only the steps after them.
      </p>
      <textarea
        value={opsText}
        onChange={(e) => { setOpsText(e.target.value); setOpsError(""); }}
        rows={14}
        spellCheck={false}
        className={s.code}
      />
      {opsError && <div className={msgClass(opsError)} style={{ whiteSpace: "pre-line" }}>{opsError}</div>}
      <div className={s.actions}>
        <button disabled={!!busy || !opsText.trim()} onClick={() => void retry(true)}>{busy === "retryOps" ? "Checking…" : "Check changed plan"}</button>
        <button className="link" disabled={!!busy} onClick={() => { setOpsText(JSON.stringify(view.input.ops, null, 2)); setOpsError(""); }}>Start again from the saved steps</button>
      </div>
    </details>
  );

  return (
    <>
      <p><a href="/manage">← Campaigns</a></p>
      <div className={s.title}>
        <h1>{view.title || "Change plan"}</h1>
      </div>
      <p style={{ marginBottom: 6 }}>
        <span className={`status ${planPill(view.status)}`}>{view.statusLabel}</span>
      </p>
      {reopened && (
        <div className="msg warning" style={{ marginBottom: 12 }}>
          <strong>This plan did not run.</strong> {reopened}
        </div>
      )}
      {view.waiting && (
        <div className="msg info" style={{ marginBottom: 12 }}>
          Waiting for Meta until about {view.waiting.untilLabel} IST: {view.waiting.reason}. The plan continues by itself; nothing needs doing.
        </div>
      )}
      <p className="muted" style={{ marginBottom: 24 }}>
        Made by {view.createdBy ?? "someone"} {view.source === "claude" ? "through Claude" : "in the app"} on {timeLabel(view.labels?.createdAt, view.createdAt)}.
        {view.runAt ? <> Scheduled for {timeLabel(view.labels?.runAt, view.runAt)}.</> : null}
        {view.confirmedAt && view.status === "draft" ? (
          <> It was confirmed on {timeLabel(view.labels?.confirmedAt, view.confirmedAt)}, then sent back for a new confirmation.</>
        ) : view.confirmedAt ? (
          <> Confirmed by {view.confirmedBy ?? "someone"} on {timeLabel(view.labels?.confirmedAt, view.confirmedAt)}.</>
        ) : null}
        {view.finishedAt ? <> Finished on {timeLabel(view.labels?.finishedAt, view.finishedAt)}.</> : null}
      </p>

      {error && <div className={msgClass(error)} style={{ whiteSpace: "pre-line" }}>{error}</div>}
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

      {stopped && (
        <div className="panel">
          <header><h2>Fix and retry</h2></header>
          <p className="muted" style={{ marginTop: 0 }}>
            Steps that finished stay as they are and won’t run again. Try the rest again as it is, or change the plan.
            The plan is checked again and comes back here for you to confirm.
          </p>
          <div className={s.actions}>
            <button className="primary" disabled={!!busy} onClick={() => void retry(false)}>{busy === "retry" ? "Checking…" : "Try the rest again"}</button>
          </div>
          {editor}
        </div>
      )}

      {ran && (
        <div className="panel">
          <header><h2>Delivery</h2></header>
          <p className="muted" style={{ marginTop: 0 }}>Ask Meta whether what this plan made or changed is delivering, in review or has problems.</p>
          {showDelivery ? (
            <DeliveryTable query={`plan=${encodeURIComponent(planKey)}`} onClose={() => setShowDelivery(false)} />
          ) : (
            <div className={s.actions}>
              <button onClick={() => setShowDelivery(true)}>Check delivery</button>
            </div>
          )}
        </div>
      )}

      {canUndo && (
        <div className="panel">
          <header><h2>Undo this plan</h2></header>
          <p className="muted" style={{ marginTop: 0 }}>
            Makes a new plan that puts back names, budgets, bids, audiences and on/off as they were, and turns off what this plan made.
            Nothing is deleted. You check the new plan before it runs.
          </p>
          <div className={s.actions}>
            <button disabled={!!busy} onClick={() => void undo()}>{busy === "undo" ? "Making the undo plan…" : "Undo this plan"}</button>
          </div>
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
              <dd>{sum.runAt ? timeLabel(sum.runAt === view.runAt ? view.labels?.runAt : null, sum.runAt) : "As soon as you confirm"}</dd>
            </dl>
            {sum.steps.map((st) => (
              <div key={st.n} className="list-item" style={{ alignItems: "flex-start" }}>
                <span className="step">{st.n}</span>
                <div className="grow">
                  <strong style={{ fontWeight: 600 }}>{st.title}</strong>
                  {st.title.startsWith("Already done") && <> <span className="status done">done</span></>}
                  {st.lines.length > 0 && (
                    <ul className={s.stepLines}>
                      {st.lines.map((l, i) => <li key={i}>{l}</li>)}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>

          {(sum.adsets.length > 0 || (sum.campaignBudgets?.length ?? 0) > 0) && (
            <div className="panel">
              <header><h2>Every ad set at the end of this plan</h2></header>
              {sum.adsets.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Steps</th><th>Ad set</th><th>Campaign</th><th>Daily budget</th><th>Lifetime budget</th><th>Bid</th><th>Schedule</th><th>Audience</th><th>Placements</th><th>On/off</th></tr>
                    </thead>
                    <tbody>
                      {sum.adsets.map((a, i) => {
                        const d = a.details;
                        const st = a.status || d.status || "";
                        return (
                          <tr key={i}>
                            <td>{(a.steps?.length ? a.steps : [a.step]).join(", ")}</td>
                            <td style={{ minWidth: 140 }}>
                              {a.name}
                              {a.isNew && <> <span className="badge">new</span></>}
                            </td>
                            <td style={{ minWidth: 120 }}>{a.campaign}</td>
                            <td>{a.dailyBudget !== null ? money(a.dailyBudget) : <span className="muted">{d.budget === "campaign budget" ? "Campaign budget" : "–"}</span>}</td>
                            <td>{money(a.lifetimeBudget)}</td>
                            <td>{d.bid}</td>
                            <td style={{ minWidth: 140 }}>{d.schedule}</td>
                            <td style={{ minWidth: 200 }}>{d.audience}</td>
                            <td style={{ minWidth: 160 }}>{d.placements}</td>
                            <td><span className={`status ${st === "ACTIVE" ? "failed" : "draft"}`}>{st === "ACTIVE" ? "On" : st ? "Off" : "–"}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {(sum.campaignBudgets?.length ?? 0) > 0 && (
                <>
                  <div className={s.section}>Campaign budgets in this plan</div>
                  {sum.campaignBudgets.map((c, i) => (
                    <div key={i} className="list-item">
                      <div className="grow">
                        {c.name}
                        <div className="hint" style={{ marginTop: 2 }}>
                          {c.dailyBudget !== null ? `${money(c.dailyBudget)} a day` : c.lifetimeBudget !== null ? `${money(c.lifetimeBudget)} lifetime` : "No budget"} · shared by its ad sets
                        </div>
                      </div>
                      <span className={`status ${c.status === "ACTIVE" ? "failed" : "draft"}`}>{c.status === "ACTIVE" ? "On" : "Off"}</span>
                    </div>
                  ))}
                </>
              )}
              {(sum.adsets.some((a) => a.status === "ACTIVE") || sum.campaignBudgets?.some((c) => c.status === "ACTIVE")) && (
                <p className="hint">“On” is shown in red because it can spend money once the plan runs.</p>
              )}
            </div>
          )}

          <div className="panel">
            <header><h2>Totals</h2></header>
            <small className="muted">Total daily budget in this plan (every budget, on or off)</small>
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
                What can spend in a day once this has run: <strong>{money(sum.totals.spendNowDaily)}</strong>
              </div>
            )}
            {(sum.notes?.length ?? 0) > 0 && (
              <ul className={s.stepLines}>
                {sum.notes!.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}
          </div>

          {(errors.length > 0 || warnings.length > 0) && (
            <div className="panel">
              <header><h2>Checks</h2></header>
              {errors.length > 0 && (
                <p className="hint" style={{ marginTop: 0 }}>
                  {retried ? "Fix these problems first: change the steps below, then check the plan again." : "Fix these problems first. Make a new plan from the Campaigns page with the fix."}
                </p>
              )}
              {errors.map((c, i) => <div key={`e${i}`} className="msg error">{c.message}</div>)}
              {warnings.map((c, i) => <div key={`w${i}`} className="msg warning">{c.message}</div>)}
            </div>
          )}

          {isDraft && (
            <div className="panel">
              <header><h2>Confirm</h2></header>
              <p className="muted" style={{ marginTop: 0 }}>Nothing has changed in Meta yet. The plan runs only after you confirm.</p>
              {notes.map((c, i) => <div key={`n${i}`} className="msg warning">{c.message}</div>)}
              {needsTyping && (
                <label className="field" style={{ marginTop: 12 }}>
                  <span>This plan turns things on, so Meta will spend money. {spend?.ask ?? `Type ${sum.spendConfirmation} to confirm.`}</span>
                  <input className={s.confirmInput} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={sum.spendConfirmation ?? "₹15,000"} inputMode="decimal" autoComplete="off" aria-label="What can spend in a day once this plan has run" />
                </label>
              )}
              {needsTyping && spend?.differs && <p className="hint">{spend.differs}</p>}
              {toAccept > 0 && (
                <label className="check" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                  I have read the {warnings.length && notes.length ? "warnings and notes" : notes.length ? "notes above" : "warnings"}
                </label>
              )}
              <div className={s.actions} style={{ marginTop: 16 }}>
                <button className="primary big" disabled={!ready || !!busy} onClick={confirm}>
                  {busy === "confirm" ? "Starting…" : view.runAt ? "Schedule the plan" : "Run the plan"}
                </button>
                <button className="danger" disabled={!!busy} onClick={cancel}>{busy === "cancel" ? "Cancelling…" : "Cancel plan"}</button>
              </div>
              {errors.length > 0 && <p className="hint">You can’t run this plan while it has problems.</p>}
              {retried && editor}
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
