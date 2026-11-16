"use client";

import { useCallback, useEffect, useState } from "react";
import type { MetaAssets, MetaStatus } from "@/lib/meta/connect";
import { api } from "../client-api";

// Settings → Meta connection. The person who uses the launcher connects Meta here:
// Connect Meta (Facebook login) or paste a token → pick ad account, Page, Instagram.

const day = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

function Picker({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [assets, setAssets] = useState<MetaAssets | null>(null);
  const [sel, setSel] = useState({ adAccountId: "", pageId: "", igUserId: "" });
  const [instagram, setInstagram] = useState<{ id: string; username: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sel.adAccountId) return setInstagram([]);
    api<{ id: string; username: string }[]>(`/api/meta/instagram?adAccountId=${encodeURIComponent(sel.adAccountId)}`).then(setInstagram).catch(() => setInstagram([]));
  }, [sel.adAccountId]);

  useEffect(() => {
    api<MetaAssets>("/api/meta/assets")
      .then((a) => {
        setAssets(a);
        const acc = a.adAccounts.find((x) => x.active);
        const page = a.pages[0];
        setSel({ adAccountId: acc?.id ?? "", pageId: page?.id ?? "", igUserId: page?.instagram?.id ?? "" });
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/api/meta/select", { method: "POST", body: sel });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (!assets) return <div className="panel">{error ? <div className="msg error">{error}</div> : <p className="muted">Asking Meta what this login can use…</p>}</div>;
  const noAds = assets.missing.includes("ads_management");

  return (
    <div className="panel">
      <header><h2>Pick what the launcher uses</h2></header>
      <p className="muted">Logged in to Facebook as <strong>{assets.who}</strong>. {assets.expiresAt ? `This login works until ${day(assets.expiresAt)}.` : "This login does not expire."}</p>
      {assets.missing.length > 0 && (
        <div className={`msg ${noAds ? "error" : "warning"}`}>
          Facebook did not give these permissions: {assets.missing.join(", ")}. Click Connect Meta again and keep every box ticked.
        </div>
      )}
      {!assets.adAccounts.length && (
        <div className="msg warning">
          This Facebook login can&apos;t see any ad accounts. Check in Ads Manager that your own Facebook profile can open the ad account (an agency can add you to it as an advertiser), then click Connect Meta again.
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <label><span>Ad account (where the ads are created)</span>
          <select value={sel.adAccountId} onChange={(e) => setSel({ ...sel, adAccountId: e.target.value })}>
            <option value="">Pick an ad account</option>
            {assets.adAccounts.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.active}>
                {a.name}{a.business ? ` · ${a.business}` : ""} ({a.active ? a.id.replace("act_", "") : a.status})
              </option>
            ))}
          </select>
        </label>
        <label><span>Facebook Page (the ads show this name)</span>
          <select value={sel.pageId} onChange={(e) => { const p = assets.pages.find((x) => x.id === e.target.value); setSel({ ...sel, pageId: e.target.value, igUserId: p?.instagram?.id ?? "" }); }}>
            <option value="">Pick a Page</option>
            {assets.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label><span>Instagram account</span>
          <select value={sel.igUserId} onChange={(e) => setSel({ ...sel, igUserId: e.target.value })}>
            <option value="">None (use the Facebook Page)</option>
            {instagram.map((i) => <option key={i.id} value={i.id}>@{i.username}</option>)}
          </select>
        </label>
      </div>
      {error && <div className="msg error">{error}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={busy || noAds || !sel.adAccountId || !sel.pageId} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        {onCancel && <button onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

export default function MetaTab() {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "ok" | "info"; text: string } | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<MetaStatus>("/api/meta/status").then((s) => { setStatus(s); if (s.pending) setPicking(true); return s; }), []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("meta_error")) setNotice({ kind: "error", text: q.get("meta_error")! });
    if (q.get("meta") === "cancelled") setNotice({ kind: "info", text: "You closed the Facebook window before finishing. Click Connect Meta to try again." });
    if (q.has("meta") || q.has("meta_error")) history.replaceState(null, "", "/settings#meta");
    load().catch((e: Error) => setNotice({ kind: "error", text: e.message }));
  }, [load]);

  async function useToken() {
    setBusy(true);
    setNotice(null);
    try {
      await api("/api/meta/token", { method: "POST", body: { token } });
      setToken("");
      setPicking(true);
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    }
    setBusy(false);
  }

  if (!status) return <div className="panel">{notice ? <div className={`msg ${notice.kind}`}>{notice.text}</div> : <p className="muted">Loading…</p>}</div>;
  const done = () => { setPicking(false); setNotice({ kind: "ok", text: "Saved. New batches use this ad account and Page." }); void load(); };

  return (
    <>
      {notice && <div className={`msg ${notice.kind}`}>{notice.text}</div>}
      {!status.ready && (
        <div className="msg error">Connect Meta is not set up on the server yet (META_APP_ID and META_APP_SECRET are missing). Ask your admin: docs/SETUP.md, Meta step 4.</div>
      )}

      {picking ? (
        <Picker onDone={done} onCancel={status.connected ? () => setPicking(false) : undefined} />
      ) : status.connected ? (
        <div className="panel">
          <header>
            <h2>Meta connection</h2>
            <span className={`status ${status.expired ? "failed" : status.expiresSoon ? "partial" : "done"}`}>{status.expired ? "Expired" : "Connected"}</span>
          </header>
          <div className="list-item"><span className="grow">Ad account</span>{status.adAccount!.name} <small>({status.adAccount!.id.replace("act_", "")})</small></div>
          <div className="list-item"><span className="grow">Facebook Page</span>{status.page ?? "Not set"}</div>
          <div className="list-item"><span className="grow">Instagram account</span>{status.instagram ?? "None"}</div>
          <div className="list-item">
            <span className="grow">Login</span>
            {status.expired ? <span style={{ color: "var(--err)" }}>Expired on {day(status.expiresAt!)}. Click Reconnect Meta.</span>
              : status.expiresAt ? <span style={status.expiresSoon ? { color: "var(--warn)" } : undefined}>Works until {day(status.expiresAt)}. Reconnect before then.</span>
              : "Does not expire"}
          </div>
          <p className="muted">
            Connected{status.connectedBy ? ` by ${status.connectedBy}` : ""}{status.connectedAt ? ` on ${day(new Date(`${status.connectedAt}Z`).getTime())}` : ""}{status.who ? `, as ${status.who} on Facebook` : ""}.
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => setPicking(true)}>Change ad account or Page</button>
            <a className="button" href="/api/meta/connect">Reconnect Meta</a>
            <button className="danger" onClick={() => { if (confirm("Disconnect Meta? Launches stop working until someone connects again. Templates and history stay.")) api<MetaStatus>("/api/meta/disconnect", { method: "POST" }).then(setStatus); }}>Disconnect</button>
          </div>
        </div>
      ) : (
        <div className="panel">
          <header><h2>Connect Meta</h2></header>
          <ol>
            <li>Click <strong>Connect Meta</strong>. Facebook opens. Log in with the Facebook account that can run ads for Sahajta.</li>
            <li>Facebook asks which ad accounts, Pages and Instagram accounts the launcher may use. Tick the ad account you want (for example the agency&apos;s) and your Page.</li>
            <li>Back here, pick the ad account, Page and Instagram account. Done.</li>
          </ol>
          <p className="muted">The launcher only creates paused ads. You switch them on yourself in Ads Manager.{status.practice ? " Practice mode: this connects the fake account, and Facebook does not open." : ""}</p>
          <a className="button primary big" href="/api/meta/connect" aria-disabled={!status.ready}>Connect Meta</a>
          <details style={{ marginTop: 16 }}>
            <summary>Paste a token instead</summary>
            <p className="muted">
              Use this if the Facebook login can&apos;t see your ad account. In Meta Business Settings → Users → System users, pick a system user that has the ad account, Page and Instagram account,
              click Generate token, choose the Sahajta Ads Launcher app, tick ads_management, ads_read, business_management, pages_show_list, pages_read_engagement, pages_manage_ads and instagram_basic,
              then paste the token here. It is saved encrypted on the server and never shown again.
            </p>
            <div className="row">
              <label><span>Token</span><input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
              <button className="primary" disabled={!token || busy} onClick={useToken}>{busy ? "Checking with Meta…" : "Use this token"}</button>
            </div>
          </details>
        </div>
      )}
    </>
  );
}
