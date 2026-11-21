"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BatchView, CampaignInfo } from "@/lib/service";
import type { Check } from "@/lib/types";
import { api, lastUsed, type Templates } from "../../client-api";
import { msgClass } from "../../msg";
import { checkSections, copyStale as isCopyStale, lastUploadDone, launchAndReread, launchBody, needsDestReload, pickLastUsed, presetStale as isPresetStale, pollDelay, reloadAfterPatch, reloadWithDest, summaryKey, warningsAccepted } from "./batch-logic";
import Groups from "./Groups";
import LaunchStep, { useSummary } from "./LaunchStep";
import CopySheet from "./CopySheet";
import PreviewTable from "./PreviewTable";
import Progress from "./Progress";
import Uploader from "./Uploader";

export type { Templates };

function Checks({ list }: { list: Check[] }) {
  if (!list.length) return null;
  return (
    <ul className="checks">
      {list.map((c) => (
        <li key={c.code + c.message} className={c.level}>{c.message}</li>
      ))}
    </ul>
  );
}

export default function BatchClient({ batchKey }: { batchKey: string }) {
  const [view, setView] = useState<BatchView | null>(null);
  const [tpl, setTpl] = useState<Templates | null>(null);
  const [dest, setDest] = useState<CampaignInfo[] | null>(null);
  const [destError, setDestError] = useState("");
  // error: what an action answered (a refused launch, a refused change). loadError: the last
  // reload failed. Kept apart so a reload never wipes the reason a launch was refused.
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loadTick, setLoadTick] = useState(0);
  const [busy, setBusy] = useState("");
  // How many warnings the page showed when "I read the warnings" was ticked (null: not ticked).
  // The launch sends this number; a launch that finds more is refused and the box must be ticked again.
  const [acceptedAt, setAcceptedAt] = useState<number | null>(null);
  // After such a refusal: the box stays off until the page shows the new warnings.
  const [rereading, setRereading] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [spendTyped, setSpendTyped] = useState("");
  // The summary reads Meta: asked for only for a draft, and again only when the ad set, copy,
  // preset or go-live choice changed (not per upload, not per poll; with a new ad set per ad, also
  // when the number of ads changed, since the total is per ad).
  const { summary, error: summaryError, loading: summaryLoading, retry: retrySummary } = useSummary(batchKey, summaryKey(view));
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadingRef = useRef(0);

  /** Reload the batch. withDest adds the destination checks (they may read Meta). */
  const load = useCallback(async (withDest = false): Promise<BatchView | null> => {
    try {
      const v = await api<BatchView>(`/api/batches/${batchKey}${withDest ? "?dest=1" : ""}`);
      setView(v);
      setLoadError("");
      return v;
    } catch (e) {
      setLoadError((e as Error).message);
      return null;
    } finally {
      setLoadTick((n) => n + 1);
    }
  }, [batchKey]);

  // Uploads finish one by one: reload at most every 1.5 s. While files are still uploading the
  // reload skips the destination checks; once every upload is done, one reload with them.
  const reloadSoon = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void load(reloadWithDest(uploadingRef.current));
    }, 1500);
  }, [load]);

  const onUploading = useCallback((n: number) => {
    const was = uploadingRef.current;
    uploadingRef.current = n;
    setUploading(n);
    if (lastUploadDone(was, n)) reloadSoon();
  }, [reloadSoon]);

  const loadDest = useCallback(async (refresh = false) => {
    try {
      setDestError("");
      const d = await api<{ campaigns: CampaignInfo[] }>(`/api/destinations${refresh ? "?refresh=1" : ""}`);
      setDest(d.campaigns);
    } catch (e) {
      setDestError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(true);
    void api<Templates>("/api/templates").then(setTpl).catch((e: Error) => setError(e.message));
    void loadDest();
  }, [load, loadDest]);

  // Live progress while launching; slower checks for Meta's review afterwards. These reloads
  // never read Meta. After a failed reload the next one is still scheduled (loadTick changes).
  useEffect(() => {
    const ms = pollDelay(view, !!loadError);
    if (ms === null) return;
    const t = setTimeout(() => void load(), ms);
    return () => clearTimeout(t);
  }, [view, loadError, loadTick, load]);

  const warningsSeen = useRef(0);
  useEffect(() => {
    if (view && view.status === "draft" && view.preview.warnings !== warningsSeen.current) {
      warningsSeen.current = view.preview.warnings;
      setAcceptedAt(null); // new or different warnings must be read again
    }
  }, [view]);

  /**
   * Show a batch an action answered. A draft answer without the destination checks (they are kept
   * 2 minutes) is loaded again with them, so an ad set or Instagram error never just disappears.
   */
  const show = useCallback((v: BatchView) => {
    setView(v);
    if (needsDestReload(v)) void load(true);
  }, [load]);

  async function patch(body: Record<string, unknown>) {
    setError("");
    const before = view?.preview ?? null;
    try {
      const v = await api<BatchView & { destChecked?: boolean }>(`/api/batches/${batchKey}`, { method: "PATCH", body });
      setView(v);
      // Only the ad set, copy template, preset and angle are remembered for the next batch (never the go-live).
      lastUsed.set(pickLastUsed(body));
      // The answer already is the batch; reload with destination checks only when they may have changed or are missing.
      if (reloadAfterPatch(body, before, v) || needsDestReload(v)) void load(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function act(label: string, fn: () => Promise<BatchView | void>) {
    setBusy(label);
    setError("");
    try {
      const v = await fn();
      if (v) show(v);
      else await load(true);
    } catch (e) {
      setError((e as Error).message);
      // A refused launch may have found new warnings (e.g. a landing page that stopped loading).
      // A failed reload goes to loadError, so the reason above stays on screen.
      void load(true);
    } finally {
      setBusy("");
    }
  }

  /** Launch. A refusal over warnings the page didn't show unticks the box and shows them first. */
  async function launch(body: ReturnType<typeof launchBody>) {
    setBusy("launch");
    setError("");
    await launchAndReread(() => api<BatchView>(`/api/batches/${batchKey}/launch`, { method: "POST", body }), {
      shown: (v) => { setView(v); setBusy(""); },
      failed: (msg) => { setError(msg); setBusy(""); },
      untick: () => setAcceptedAt(null),
      rereading: setRereading,
      reload: () => load(true),
    });
  }

  if (!view) {
    const why = loadError || error;
    if (!why) return <p className="muted">Loading…</p>;
    return <div className={msgClass(why)}>{why} <button className="link" onClick={() => void load(true)}>Try again</button></div>;
  }
  if (view.status !== "draft") {
    return <Progress view={view} tpl={tpl} busy={busy} error={error} loadError={loadError} act={act} reload={load} batchKey={batchKey} />;
  }

  const s = view.settings;
  const campaign = dest?.find((c) => c.id === s.campaignId);
  const adNames = tpl?.naming.filter((n) => n.kind === "ad") ?? [];
  const setNames = tpl?.naming.filter((n) => n.kind === "adset") ?? [];
  // What the launch will use is the batch's own copy of the preset and copy template. If they
  // were edited in Settings since, offer to take the latest version.
  const presetTpl = tpl?.presets.find((p) => p.id === s.presetId);
  const preset = s.preset ? { ...s.preset, enhancementsOn: Object.keys(s.preset.enhancements ?? {}) } : null;
  const presetStale = isPresetStale(presetTpl, s.preset);
  const copyTpl = tpl?.copy.find((c) => c.id === s.copyTemplateId);
  const copyStale = isCopyStale(copyTpl, s.copy);
  const p = view.preview;
  const sections = checkSections(p.batchChecks);
  const blocked = p.errors > 0;
  const accepted = warningsAccepted(acceptedAt, p.warnings);
  const needsAccept = !accepted;

  const todo = [...p.batchChecks, ...p.ads.flatMap((a) => a.checks)].filter((c) => c.level === "error").map((c) => c.message);
  const todoAll = [...new Set(todo)];
  const todoShort = todoAll.slice(0, 3);
  const needsSpend = s.goLive !== "paused";
  const spendLabel = summary?.launch?.spendConfirmation ?? "";
  // Meta refuses to turn ads on while an account check (payment, health, pixel) is an error.
  const accountBlocks = needsSpend ? (summary?.launch?.checks ?? []).filter((c) => c.level === "error") : [];
  const newAdset = s.adsetMode === "new_per_ad" || s.adsetMode === "new_shared";

  return (
    <>
      <h1>New batch</h1>
      <p className="lead">
        {view.source.kind === "drive" ? `From Drive: ${view.source.label}` : "Uploaded files"} · {view.ads.length} ad{view.ads.length === 1 ? "" : "s"}. Nothing is sent to Meta until you press Launch.
      </p>

      <section className="panel">
        <header>
          <span className={`step ${view.ads.length ? "done" : ""}`}>1</span><h2>Creatives</h2>
          <p className="hint">Drag a file onto another ad to pair them. 9:16 shows in Stories and Reels; 4:5 or 1:1 shows in Feed.</p>
        </header>
        <Groups
          view={view}
          onMove={(assetId, to) => act("move", () => api<BatchView>(`/api/batches/${batchKey}/move`, { method: "POST", body: { assetId, toAdId: to } }))}
          onRemove={(assetId) => act("move", () => api<BatchView>(`/api/batches/${batchKey}/move`, { method: "POST", body: { assetId, remove: true } }))}
        />
        <div style={{ marginTop: view.ads.length ? 16 : 0 }}>
          <Uploader batchKey={batchKey} onUploaded={reloadSoon} onBusy={onUploading} />
        </div>
        <Checks list={sections.creatives} />
      </section>

      <section className="panel">
        <header>
          <span className={`step ${s.adsetId ? "done" : ""}`}>2</span><h2>Where they go</h2>
          <button className="link" style={{ marginLeft: "auto", fontSize: 13.5 }} onClick={() => loadDest(true)}>Refresh from Meta</button>
        </header>
        {destError && <div className={msgClass(destError)}>{destError}</div>}
        <div className="row">
          <label>
            <span>Campaign</span>
            <select value={s.campaignId ?? ""} onChange={(e) => patch({ campaignId: e.target.value })}>
              <option value="" disabled>{dest ? "Choose a campaign" : "Loading campaigns…"}</option>
              {dest?.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.status.toLowerCase()})</option>
              ))}
            </select>
          </label>
          <label>
            <span>{s.adsetMode === "new_per_ad" ? "Ad set to copy for each ad" : s.adsetMode === "new_shared" ? "Ad set to copy" : "Ad set"}</span>
            <select value={s.adsetId ?? ""} onChange={(e) => patch({ adsetId: e.target.value })} disabled={!campaign}>
              <option value="" disabled>{campaign ? "Choose an ad set" : "Choose a campaign first"}</option>
              {campaign?.adsets.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.isDynamicCreative ? " (Dynamic creative: can't use)" : ""}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="golive" role="radiogroup" aria-label="Which ad set the ads go into" style={{ marginTop: 14 }}>
          {([
            ["existing", "Into this ad set", "Every ad goes into the ad set above."],
            ["new_per_ad", "A new ad set for each ad", "Each ad gets its own paused copy of the ad set above."],
            ["new_shared", "One new ad set for all the ads", "One paused copy of the ad set above holds all the ads (up to 50)."],
          ] as const).map(([v, title, sub]) => (
            <label key={v} className={s.adsetMode === v ? "on" : ""}>
              <input type="radio" name="adsetmode" checked={s.adsetMode === v} onChange={() => patch({ adsetMode: v })} />
              <strong>{title}</strong>
              <small>{sub}</small>
            </label>
          ))}
        </div>
        {newAdset && <p className="hint">A copy keeps the same budget, audience and placements, and is created paused.</p>}
        <Checks list={sections.destination} />
      </section>

      <section className="panel">
        <header>
          <span className={`step ${s.copyTemplateId ? "done" : ""}`}>3</span><h2>Copy</h2>
          <a href="/settings#copy" style={{ marginLeft: "auto", fontSize: 13.5 }}>Edit templates</a>
          <p className="hint">The same texts go on every ad. To change one ad, use the preview at the bottom.</p>
        </header>
        <select aria-label="Copy template" value={s.copyTemplateId ?? ""} onChange={(e) => patch({ copyTemplateId: Number(e.target.value) })}>
          <option value="" disabled>{tpl?.copy.length ? "Choose a copy template" : "No copy templates yet: add one in Settings"}</option>
          {tpl?.copy.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {copyStale && (
          <div className="msg info">This template was edited in Settings after you picked it. <button className="link" onClick={() => patch({ copyTemplateId: s.copyTemplateId })}>Use the latest version</button></div>
        )}
        {s.copyTemplateId ? (
          <div className="copybox grid2">
            <div>
              <small>{s.copy.primaryTexts.length} primary text{s.copy.primaryTexts.length === 1 ? "" : "s"}</small>
              {s.copy.primaryTexts.map((t, i) => <p key={i}>{t}</p>)}
            </div>
            <div>
              <small>{s.copy.headlines.length} headline{s.copy.headlines.length === 1 ? "" : "s"}</small>
              {s.copy.headlines.map((t, i) => <p key={i}><strong>{t}</strong></p>)}
              <small>{s.copy.descriptions.length} description{s.copy.descriptions.length === 1 ? "" : "s"}</small>
              {s.copy.descriptions.length ? s.copy.descriptions.map((t, i) => <p key={i}>{t}</p>) : <p>—</p>}
              <small>Button and link</small><p>{s.copy.cta.replace(/_/g, " ").toLowerCase()} → {s.copy.linkUrl || "no link"}</p>
              {s.copy.utmTemplate && <><small>UTM</small><p><code>{s.copy.utmTemplate}</code></p></>}
            </div>
          </div>
        ) : null}
        {view.ads.length > 0 && <CopySheet batchKey={batchKey} features={tpl?.features ?? []} onSaved={show} />}
      </section>

      <section className="panel">
        <header><span className="step done">4</span><h2>Names</h2></header>
        <div className="row">
          <label>
            <span>Ad name</span>
            <select value={adNames.find((n) => n.pattern === s.adNameTemplate)?.id ?? ""} onChange={(e) => patch({ adNameTemplate: adNames.find((n) => n.id === Number(e.target.value))?.pattern })}>
              <option value="">Custom</option>
              {adNames.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </label>
          <label style={{ maxWidth: 220 }}>
            <span>Angle <small>(fills {"{angle}"})</small></span>
            <input defaultValue={s.angle} key={`angle-${s.angle}`} placeholder="e.g. price" onBlur={(e) => e.target.value !== s.angle && patch({ angle: e.target.value })} />
          </label>
          <label style={{ maxWidth: 220 }}>
            <span>Persona <small>(fills {"{persona}"})</small></span>
            <input defaultValue={s.persona} key={`persona-${s.persona}`} placeholder="e.g. investor" onBlur={(e) => e.target.value !== s.persona && patch({ persona: e.target.value })} />
          </label>
        </div>
        {view.ads[0] && (
          <div style={{ marginTop: 14 }}>
            <small>First ad will be named</small>
            <div className="preview-name">{view.ads[0].metaName}</div>
            {newAdset && <><small style={{ display: "block", marginTop: 8 }}>in a new ad set named</small><div className="preview-name">{view.ads[0].adsetName}</div></>}
          </div>
        )}
        <details>
          <summary>Change the pattern</summary>
          <div className="row">
            <label>
              <span>Ad name pattern</span>
              <input defaultValue={s.adNameTemplate} key={s.adNameTemplate} onBlur={(e) => e.target.value !== s.adNameTemplate && patch({ adNameTemplate: e.target.value })} />
            </label>
          </div>
          {newAdset && (
            <div className="row" style={{ marginTop: 12 }}>
              <label>
                <span>New ad set name</span>
                <select value={setNames.find((n) => n.pattern === s.adsetNameTemplate)?.id ?? ""} onChange={(e) => patch({ adsetNameTemplate: setNames.find((n) => n.id === Number(e.target.value))?.pattern })}>
                  <option value="">Custom</option>
                  {setNames.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
              </label>
              <label>
                <span>Ad set name pattern</span>
                <input defaultValue={s.adsetNameTemplate} key={s.adsetNameTemplate} onBlur={(e) => e.target.value !== s.adsetNameTemplate && patch({ adsetNameTemplate: e.target.value })} />
              </label>
            </div>
          )}
          <div className="copybox">
            {tpl?.tokens.map((t) => <div key={t.token} style={{ padding: "2px 0" }}><code>{t.token}</code> {t.meaning}</div>)}
            <p className="hint">Ads get exactly these names in Meta. A code like [L:{view.key}-01] is added only to the names of creatives and of new ad sets the launcher makes; a retry uses it to find what Meta already made, so nothing is created twice.</p>
          </div>
        </details>
      </section>

      <section className="panel">
        <header>
          <span className={`step ${preset?.pageId ? "done" : ""}`}>5</span><h2>Meta settings</h2>
          <a href="/settings#presets" style={{ marginLeft: "auto", fontSize: 13.5 }}>Edit presets</a>
        </header>
        <select aria-label="Settings preset" value={s.presetId ?? ""} onChange={(e) => patch({ presetId: Number(e.target.value) })}>
          {tpl?.presets.map((p2) => <option key={p2.id} value={p2.id}>{p2.name}</option>)}
        </select>
        {presetStale && (
          <div className="msg info" style={{ marginTop: 12 }}>This preset was edited in Settings after you picked it. <button className="link" onClick={() => patch({ presetId: s.presetId })}>Use the latest version</button></div>
        )}
        {preset && (
          <dl className="kv">
            <dt>Facebook Page</dt><dd>{preset.pageName || preset.pageId || <span style={{ color: "var(--err)" }}>not set</span>}</dd>
            <dt>Instagram</dt><dd>{preset.igName || preset.igUserId || "not set (uses the Facebook Page)"}</dd>
            <dt>AI enhancements</dt><dd>{preset.enhancementsOn.length ? `${preset.enhancementsOn.length} switched on` : "All off"}</dd>
            <dt>Multi-advertiser ads</dt><dd>{preset.multiAdvertiser ? "On" : "Off"}</dd>
          </dl>
        )}
        <Checks list={sections.settings} />
      </section>

      <section className="panel">
        <header>
          <span className="step">6</span><h2>Preview</h2>
          <button style={{ marginLeft: "auto" }} disabled={!!busy || !view.ads.length} onClick={() => act("check", () => api<BatchView>(`/api/batches/${batchKey}/preview`, { method: "POST" }))}>
            {busy === "check" ? "Checking…" : "Check landing pages"}
          </button>
        </header>
        <Checks list={sections.preview} />
        {view.ads.length ? <div className="table-wrap"><PreviewTable view={view} tpl={tpl} batchKey={batchKey} onChange={show} /></div> : <p className="muted">Add images or videos in step 1 to see the ads here.</p>}
      </section>

      <LaunchStep view={view} dest={dest} patch={(b) => void patch(b)} summary={summary} summaryError={summaryError} summaryLoading={summaryLoading} retrySummary={retrySummary} />

      {loadError && <div className="msg warning">Could not refresh the batch: {loadError}</div>}
      {error && <div className={msgClass(error)} style={{ whiteSpace: "pre-line" }}>{error}</div>}

      <div className="launchbar">
        <div className="grow">
          <div className="estimate">
            <strong>{view.ads.length * (1 + s.extraAdsets.length)} ad{view.ads.length * (1 + s.extraAdsets.length) === 1 ? "" : "s"}</strong>, {s.goLive === "paused" ? "created paused" : s.goLive === "now" ? "turned on when all are in" : "turned on at the set time"} · {p.estimate.label}{s.extraAdsets.length ? " for all the ad sets" : ""}
          </div>
          {uploading > 0 ? (
            <small>Wait for the uploads to finish: {uploading} file{uploading === 1 ? "" : "s"} still uploading.</small>
          ) : blocked ? (
            <small>Before launch: {todoShort.join(" · ").replace(/\.(?= ·|$)/g, "")}{todoAll.length > 3 ? ` · and ${todoAll.length - 3} more` : ""}</small>
          ) : accountBlocks.length ? (
            <small>Ads can&apos;t be turned on yet: {accountBlocks[0].message}{accountBlocks.length > 1 ? ` · and ${accountBlocks.length - 1} more in the summary.` : ""} You can still launch them paused.</small>
          ) : (
            <small>{p.warnings ? `${p.warnings} warning${p.warnings === 1 ? "" : "s"} in the preview` : "Ready to launch"}{p.estimate.rateLimited ? ` · Meta's limit on this ad account sets the pace: ${p.estimate.pace}` : ""}</small>
          )}
        </div>
        {p.warnings > 0 && !blocked && (
          <label className="check">
            <input type="checkbox" checked={accepted} disabled={rereading} onChange={(e) => setAcceptedAt(e.target.checked ? p.warnings : null)} />
            {rereading ? "Loading the new warnings…" : `I read the ${p.warnings === 1 ? "warning" : `${p.warnings} warnings`}`}
          </label>
        )}
        {needsSpend && !blocked && (
          <label className="spend-confirm">
            <small>Turns ads on. Type the total daily budget from the summary ({spendLabel}) to confirm:</small>
            <input value={spendTyped} onChange={(e) => setSpendTyped(e.target.value)} placeholder={spendLabel || "₹0"} aria-label="Total daily budget" />
          </label>
        )}
        <button className="primary big" disabled={blocked || needsAccept || rereading || !!busy || uploading > 0 || accountBlocks.length > 0 || (needsSpend && !spendTyped.trim()) || (needsSpend && !summary?.launch)}
          onClick={() => void launch(launchBody({ warnings: p.warnings, acceptedAt, goLive: s.goLive, spendTyped }))}>
          {busy === "launch" ? "Starting…" : s.goLive === "paused" ? "Launch (paused)" : s.goLive === "now" ? "Launch and turn on" : "Launch and schedule"}
        </button>
      </div>
    </>
  );
}
