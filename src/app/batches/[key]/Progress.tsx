"use client";

import { useEffect, useRef, useState } from "react";
import type { DeliveryRow } from "@/lib/manage/delivery";
import type { BatchView, Cancelled, RetryResult } from "@/lib/service";
import type { CopyOverride } from "@/lib/types";
import { api, type Templates } from "../../client-api";
import { msgClass } from "../../msg";
import {
  canChangeAfterLaunch, copyStale, eventTime, goLiveLine, goLivePlanText, groupLaunching, presetStale, retryLaunch, retryOffer,
  retryQuestion, reviewCheckedText, stopLaunch, stopTurnOnOffer, waitForReview,
} from "./batch-logic";

// After launch: live progress per ad, then links to Ads Manager and Meta's review status.
// A failed ad's copy can be changed here before "Retry"; "Check delivery" asks Meta how the
// created ad sets and ads are doing.

type Ad = BatchView["ads"][number];
type Act = (label: string, fn: () => Promise<BatchView | void>) => void;
type Reload = () => Promise<BatchView | null>;

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

/** A Meta ID with a "copy" button (to reuse the post with "ads from a post"). */
function MetaId({ label, id }: { label: string; id: string }) {
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied("yes");
    } catch {
      setCopied("no"); // no clipboard access (old browser or not https): the ID is on screen to select
    }
    setTimeout(() => setCopied(""), 2000);
  }
  return (
    <div style={{ fontFamily: "inherit", fontSize: 12, marginTop: 4, wordBreak: "break-all" }}>
      <span className="muted">{label}:</span> <span>{id}</span>{" "}
      <button className="link" style={{ fontSize: 12 }} onClick={copy}>{copied === "yes" ? "Copied" : copied === "no" ? "Select and copy it" : "copy"}</button>
    </div>
  );
}

/** Change the copy of an ad that failed, before pressing Retry. Keeps the ad's other changes. */
export function FailedCopyEditor({ ad, tpl, batchKey, busy, act, onClose }: { ad: Ad; tpl: Templates | null; batchKey: string; busy: string; act: Act; onClose: () => void }) {
  // One box per text, like Settings: a primary text may have line breaks of its own.
  const pad = (a: string[]) => [...a, "", "", "", "", ""].slice(0, 5);
  const filled = (a: string[]) => a.map((x) => x.trim()).filter(Boolean);
  const [texts, setTexts] = useState(pad(ad.copy.primaryTexts));
  const [heads, setHeads] = useState(pad(ad.copy.headlines));
  const [desc, setDesc] = useState(ad.copy.description);
  const [link, setLink] = useState(ad.copy.linkUrl);
  const [displayLink, setDisplayLink] = useState(ad.copy.displayLink ?? "");
  const [cta, setCta] = useState(ad.copy.cta);
  const [error, setError] = useState("");

  function save() {
    const copy: CopyOverride = { ...(ad.override as CopyOverride), primaryTexts: filled(texts), headlines: filled(heads), description: desc, linkUrl: link.trim(), displayLink: displayLink.trim(), cta };
    setError("");
    act(`copy-${ad.id}`, async () => {
      try {
        const v = await api<BatchView>(`/api/batches/${batchKey}/copy`, { method: "POST", body: { rows: [{ ad: ad.position, copy }] } });
        onClose();
        return v;
      } catch (e) {
        setError((e as Error).message); // shown here, next to the editor
      }
    });
  }

  return (
    <div style={{ background: "#fafaf7", padding: 12, borderRadius: 8 }}>
      <p className="muted">New copy for ad {ad.position} only. Save, then press Retry at the top.</p>
      <div className="grid2">
        <div>
          <small>Primary texts (up to 5; Meta rotates them)</small>
          {texts.map((x, i) => (
            <textarea key={i} rows={2} value={x} aria-label={`Primary text ${i + 1}`} onChange={(e) => setTexts(texts.map((y, j) => (j === i ? e.target.value : y)))} style={{ marginBottom: 4 }} />
          ))}
        </div>
        <div>
          <small>Headlines (up to 5)</small>
          {heads.map((x, i) => (
            <input key={i} value={x} aria-label={`Headline ${i + 1}`} onChange={(e) => setHeads(heads.map((y, j) => (j === i ? e.target.value : y)))} style={{ marginBottom: 4 }} />
          ))}
        </div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label><span>Description</span><input value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
        <label><span>Landing page</span><input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" /></label>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label><span>Display link</span><input value={displayLink} onChange={(e) => setDisplayLink(e.target.value)} placeholder="e.g. sahajta.com/visit" /></label>
        <label><span>Button</span>
          <select value={cta} onChange={(e) => setCta(e.target.value)}>
            {!tpl?.ctaTypes.includes(cta) && <option value={cta}>{cta.replace(/_/g, " ").toLowerCase()}</option>}
            {tpl?.ctaTypes.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>)}
          </select>
        </label>
      </div>
      {error && <div className={msgClass(error)}>{error}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" disabled={!filled(texts).length || !!busy} onClick={save}>{busy === `copy-${ad.id}` ? "Saving…" : "Save new copy"}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * A failed or partly done batch: pick another settings preset or copy template for the ads not
 * created yet (e.g. a preset without the Instagram account Meta refused), then press Retry.
 */
function SettingsAfterFailure({ view, tpl, busy, act, batchKey }: { view: BatchView; tpl: Templates | null; busy: string; act: Act; batchKey: string }) {
  const s = view.settings;
  const left = view.progress.total - view.progress.done;
  const presetTpl = tpl?.presets.find((p) => p.id === s.presetId);
  const copyTpl = tpl?.copy.find((c) => c.id === s.copyTemplateId);
  const save = (body: { presetId?: number; copyTemplateId?: number }) =>
    act("settings", () => api<BatchView>(`/api/batches/${batchKey}`, { method: "PATCH", body }));

  return (
    <div className="panel">
      <header>
        <h2>Settings for the ads not created yet</h2>
        <p className="hint" style={{ marginLeft: 0 }}>
          A change here is used only for the {left} ad{left === 1 ? "" : "s"} not created yet, when you press Retry. Ads already in Meta keep the settings they were made with.
        </p>
      </header>
      <div className="row">
        <label>
          <span>Meta settings preset (Page, Instagram)</span>
          <select aria-label="Settings preset" value={s.presetId ?? ""} disabled={!!busy || !tpl} onChange={(e) => save({ presetId: Number(e.target.value) })}>
            {!presetTpl && <option value={s.presetId ?? ""} disabled>{s.preset?.name ?? "Choose a preset"}</option>}
            {tpl?.presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>
          <span>Copy template</span>
          <select aria-label="Copy template" value={s.copyTemplateId ?? ""} disabled={!!busy || !tpl} onChange={(e) => save({ copyTemplateId: Number(e.target.value) })}>
            {!copyTpl && <option value={s.copyTemplateId ?? ""} disabled>{s.copyTemplateId ? "This batch's copy" : "Choose a copy template"}</option>}
            {tpl?.copy.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
      {presetTpl && presetStale(presetTpl, s.preset) && (
        <div className="msg info" style={{ marginTop: 12 }}>This preset was edited in Settings after the launch. <button className="link" disabled={!!busy} onClick={() => save({ presetId: presetTpl.id })}>Use the latest version</button></div>
      )}
      {copyTpl && copyStale(copyTpl, s.copy) && (
        <div className="msg info" style={{ marginTop: 12 }}>This copy template was edited in Settings after the launch. <button className="link" disabled={!!busy} onClick={() => save({ copyTemplateId: copyTpl.id })}>Use the latest version</button></div>
      )}
      {s.preset && (
        <dl className="kv">
          <dt>Facebook Page</dt><dd>{s.preset.pageName || s.preset.pageId || <span style={{ color: "var(--err)" }}>not set</span>}</dd>
          <dt>Instagram</dt><dd>{s.preset.igName || s.preset.igUserId || "not set (uses the Facebook Page)"}</dd>
        </dl>
      )}
      {busy === "settings" && <p className="muted">Saving…</p>}
    </div>
  );
}

function Delivery({ batchKey }: { batchKey: string }) {
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function check() {
    setBusy(true);
    setError("");
    try {
      setRows((await api<{ rows: DeliveryRow[] }>(`/api/batches/${batchKey}/delivery`)).rows);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <div className="panel">
      <header>
        <h2>Delivery</h2>
        <button style={{ marginLeft: "auto" }} disabled={busy} onClick={check}>{busy ? "Asking Meta…" : rows ? "Check again" : "Check delivery"}</button>
        <p className="hint" style={{ marginLeft: 0 }}>Are the ads and ad sets running, still learning, or stopped by a problem?</p>
      </header>
      {error && <div className={msgClass(error)}>{error}</div>}
      {rows && !rows.length && <p className="muted">Meta has nothing to show yet.</p>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Name</th><th>Status</th><th>Learning</th><th>Problems</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.kind + r.id} className={r.issues.length ? "has-error" : ""}>
                  <td style={{ whiteSpace: "nowrap" }}>{r.kind === "adset" ? "Ad set" : "Ad"}</td>
                  <td className="name-cell">{r.name}</td>
                  <td>{r.plain}</td>
                  <td>{r.learning ?? <small>—</small>}</td>
                  <td style={{ minWidth: 200 }}>
                    {r.issues.length ? r.issues.map((i) => <div key={i} style={{ fontSize: 13, color: "var(--err)" }}>{i}</div>) : <small>None</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Progress({ view, tpl, busy, error, loadError, act, reload, batchKey }: { view: BatchView; tpl: Templates | null; busy: string; error: string; loadError: string; act: Act; reload: Reload; batchKey: string }) {
  const { progress: pr } = view;
  const running = view.status === "queued" || view.status === "running";
  const pct = pr.total ? Math.round(((pr.done + pr.failed) / pr.total) * 100) : 0;
  const elapsed = minutesSince(view.launchedAt);
  const [editing, setEditing] = useState<number | null>(null);
  const s = view.settings;
  // "Check Meta review status now": the worker asks Meta a moment later, so the page reloads a
  // few times (these reloads don't call Meta) and shows "Checking…" meanwhile.
  const [review, setReview] = useState<{ state: "" | "checking" | "news" | "same" | "late"; error?: string }>({ state: "" });
  // What the last Retry or Stop did, in the server's words. Cleared when the next one is pressed.
  const [notice, setNotice] = useState("");
  const [stopped, setStopped] = useState("");
  const groupRunning = groupLaunching(view);
  const turnOnStop = stopTurnOnOffer(view);
  const offer = retryOffer(view);
  const plan = goLivePlanText(view.goLivePlan);
  const canChange = canChangeAfterLaunch(view) && !running;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function checkReview() {
    setReview({ state: "checking" });
    // reviewCheckedAt moves when the worker has asked Meta: the reloads stop then.
    const before = { ads: view.ads, reviewCheckedAt: view.reviewCheckedAt };
    try {
      await api(`/api/batches/${batchKey}/review`, { method: "POST" });
    } catch (e) {
      setReview({ state: "", error: (e as Error).message });
      return;
    }
    const result = await waitForReview(before, reload, { alive: () => alive.current });
    if (result && alive.current) setReview({ state: result });
  }

  function stop(turnOnOnly = false) {
    const others = view.together.filter((t) => t.status === "queued" || t.status === "running").length;
    const what = [running ? "this launch" : "", others ? `the launch${others === 1 ? "" : "es"} into ${others} other ad set${others === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    const question = turnOnOnly
      ? "Don't turn these ads on? They stay paused (with the ads of the other ad sets launched together); nothing is deleted. You can turn them on later from the Campaigns page."
      : `Stop ${what} after the current step? Ads already created stay (paused) and are not turned on: a turn-on plan still waiting is cancelled. Nothing is deleted.`;
    if (!confirm(question)) return;
    setNotice("");
    act("cancel", async () => {
      const { view: v, stopped: text } = await stopLaunch(() => api<BatchView & { cancelled?: Cancelled[] }>(`/api/batches/${batchKey}/cancel`, { method: "POST" }), view.key);
      setStopped(text);
      return v;
    });
  }

  function retry(goLiveOnly: boolean) {
    // Asked when the Retry turns ads on with the yes given at launch, or when a Retry now no longer uses
    // that yes (long after the launch ended: it makes a draft plan). After a Stop the box above says so.
    const question = retryQuestion(view, goLiveOnly);
    if (question && !confirm(question)) return;
    setStopped("");
    setNotice("");
    act("retry", async () => {
      const { view: v, notice: text } = await retryLaunch(() => api<BatchView & { retry?: RetryResult }>(`/api/batches/${batchKey}/retry`, { method: "POST" }));
      setNotice(text);
      return v;
    });
  }

  return (
    <>
      <h1>{running ? "Launching…" : pr.failed ? "Some ads need another try" : "Ads created"}</h1>
      <p className="lead">
        {view.source.kind === "drive" ? `From Drive: ${view.source.label}` : "Uploaded files"} · {s.campaignName} →{" "}
        {s.adsetMode === "new_per_ad" ? "a new ad set per ad" : s.adsetMode === "new_shared" ? `one new ad set copied from ${s.adsetName ?? "the picked ad set"}` : s.adsetName}
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
            {view.launchEstimate ? `Estimate at launch: ${view.launchEstimate}${view.together.length ? " for every ad set" : ""}. ` : ""}
            {view.timeLeft ? `${view.timeLeft[0].toUpperCase()}${view.timeLeft.slice(1)}. ` : `Still to do: ${view.preview.estimate.text}. `}You can close this page; the launch carries on.
          </p>
        )}
        {!running && (
          <div className="msg info">
            <strong>What happened:</strong> {pr.done} ad{pr.done === 1 ? "" : "s"} created{pr.failed ? `, ${pr.failed} not created (the reason is next to each one below)` : ""}.{" "}
            {pr.failed > 0 && <>Fix the cause (use <strong>Change copy</strong> if the text or link was the problem{canChange ? ", or pick another settings preset below" : ""}), then press <strong>Retry</strong>: ads already created are never made twice. </>}
            {s.goLive === "paused"
              ? <>Every created ad is <strong>paused</strong>. Turn them on in Ads Manager or under <a href="/manage">Campaigns</a>.</>
              : goLiveLine(view)}
          </div>
        )}
        {plan && (
          <div className={`msg ${plan.draft ? "warning" : "info"}`}>
            Turn-on plan <a href={plan.href}>{plan.key}</a>: {plan.text}
          </div>
        )}
        {view.together.length > 0 && (
          <p className="muted">Launched together into other ad sets: {view.together.map((t, i) => <span key={t.key}>{i ? ", " : ""}<a href={`/batches/${t.key}`}>{t.adsetName ?? t.key}</a> ({t.status})</span>)}</p>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          {groupRunning && (
            <button className="danger" disabled={!!busy || view.cancelRequested || !!stopped} onClick={() => stop()}>
              {view.cancelRequested || stopped ? "Stopping after the current step…" : busy === "cancel" ? "Stopping…" : "Stop the launch"}
            </button>
          )}
          {turnOnStop && !stopped && (
            <button className="danger" disabled={!!busy} onClick={() => stop(true)}>
              {busy === "cancel" ? "Stopping…" : turnOnStop}
            </button>
          )}
          {offer && (
            <button className="primary" disabled={!!busy} onClick={() => retry(offer.goLiveOnly)}>
              {busy === "retry" ? "Starting…" : offer.label}
            </button>
          )}
          {!running && pr.done > 0 && (
            <button disabled={!!busy || review.state === "checking"} onClick={() => void checkReview()}>
              {review.state === "checking" ? "Checking…" : "Check Meta review status now"}
            </button>
          )}
          {!running && pr.done > 0 && view.reviewCheckedAt && <small className="muted">{reviewCheckedText(view.reviewCheckedAt)}</small>}
        </div>
        {stopped && <div className="msg info">{stopped}</div>}
        {notice && <div className="msg info" style={{ whiteSpace: "pre-line" }}>{notice}</div>}
        {review.state === "news" && <div className="msg ok">Meta&apos;s review status is updated below.</div>}
        {review.state === "same" && <div className="msg info">No change in Meta&apos;s review yet. Meta&apos;s answer can take a few minutes; check again later.</div>}
        {review.state === "late" && <div className="msg info">Meta hasn&apos;t been asked yet: the check is waiting its turn. Look again in a few minutes.</div>}
        {review.error && <div className={msgClass(review.error)}>{review.error}</div>}
        {loadError && <div className="msg warning">Could not refresh the progress: {loadError}. Trying again by itself.</div>}
        {error && <div className={msgClass(error)} style={{ whiteSpace: "pre-line" }}>{error}</div>}
      </div>

      {canChange && <SettingsAfterFailure view={view} tpl={tpl} busy={busy} act={act} batchKey={batchKey} />}

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
              <FragmentRow key={ad.id} ad={ad} tpl={tpl} running={running} busy={busy} act={act} batchKey={batchKey} editing={editing === ad.id} setEditing={(on) => setEditing(on ? ad.id : null)} />
            ))}
          </tbody>
        </table>
      </div>
      </div>

      {pr.done > 0 && <Delivery batchKey={batchKey} />}

      <details className="panel">
        <summary>Activity log</summary>
        <div className="events">
          {view.events.map((e, i) => (
            <div key={i} className={e.level}>
              <small>{eventTime(e.at)}</small> {e.message}
            </div>
          ))}
        </div>
      </details>
    </>
  );
}

function FragmentRow({ ad, tpl, running, busy, act, batchKey, editing, setEditing }: { ad: Ad; tpl: Templates | null; running: boolean; busy: string; act: Act; batchKey: string; editing: boolean; setEditing: (on: boolean) => void }) {
  const canChange = ad.status === "failed" && !running;
  return (
    <>
      <tr className={ad.status === "failed" ? "has-error" : ""}>
        <td>{ad.position}</td>
        <td className="name-cell">
          {ad.metaName}
          <div style={{ fontFamily: "inherit" }}>
            {ad.files.map((f) => <span key={f.id} className={`badge ${f.ratio === "9x16" ? "v" : ""}`} style={{ marginRight: 4 }}>{f.ratio?.replace("x", ":") ?? "?"}</span>)}
          </div>
          {ad.metaPostId && <MetaId label="Facebook post ID" id={ad.metaPostId} />}
          {ad.metaIgMediaId && <MetaId label="Instagram media ID" id={ad.metaIgMediaId} />}
        </td>
        <td style={{ maxWidth: 320 }}>
          <span className={`status ${ad.status}`}>{{ pending: "Waiting", working: "Working", waiting: "Waiting for Meta", done: "Created", failed: "Failed" }[ad.status] ?? ad.status}</span>
          {ad.status !== "done" && ad.step && <div><small>{ad.step}</small></div>}
          {ad.error && <div className="msg error" style={{ fontSize: 13 }}>{ad.error}</div>}
          {ad.leftover && <div className="msg info" style={{ fontSize: 13 }}>{ad.leftover}</div>}
          {ad.featureWarnings.map((w) => <div key={w} className="msg warning" style={{ fontSize: 13 }}>{w}</div>)}
          {canChange && !editing && (
            <button style={{ height: 30, fontSize: 13 }} disabled={!!busy} onClick={() => setEditing(true)}>Change copy</button>
          )}
        </td>
        <td style={{ maxWidth: 240 }}>
          {ad.metaAdId ? <span className={`status ${reviewClass(ad.effectiveStatus)}`}>{ad.reviewLabel}</span> : <small>—</small>}
          {ad.reviewIssues.map((i) => <div key={i} style={{ fontSize: 13, color: "var(--err)" }}>{i}</div>)}
        </td>
        <td style={{ whiteSpace: "nowrap" }}>{ad.adsManagerUrl && <a href={ad.adsManagerUrl} target="_blank" rel="noreferrer">Open ↗</a>}</td>
      </tr>
      {canChange && editing && (
        <tr>
          <td colSpan={5}>
            <FailedCopyEditor ad={ad} tpl={tpl} batchKey={batchKey} busy={busy} act={act} onClose={() => setEditing(false)} />
          </td>
        </tr>
      )}
    </>
  );
}
