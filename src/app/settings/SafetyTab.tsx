"use client";

import { useEffect, useState } from "react";
import type { AppSettings } from "@/lib/appsettings";
import type { BackupHealth } from "@/lib/backup";
import { api } from "../client-api";
import { ist, rupees } from "../manage/util";
import { ceilingQuestion, readCeiling, removesCeiling } from "./settings-logic";

// Settings → Safety: the daily budget ceiling (only changed here, never by Claude) and
// failure emails for launches and plans that run in the background.

export default function SafetyTab() {
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [ceiling, setCeiling] = useState("");
  const [emails, setEmails] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [backup, setBackup] = useState<BackupHealth | null>(null);

  useEffect(() => {
    api<AppSettings & { backup?: BackupHealth }>("/api/settings")
      .then((s) => { setSaved(s); setCeiling(String(s.dailyBudgetCeiling)); setEmails(s.alertEmails); setBackup(s.backup ?? null); })
      .catch((e: Error) => setMsg({ kind: "error", text: e.message }));
  }, []);

  // Typed as text so "₹1,500" works; empty is not read as 0 (no ceiling) by mistake.
  const read = readCeiling(ceiling);
  const invalid = read.value === undefined;

  async function save() {
    if (read.value === undefined || busy) return;
    if (saved && removesCeiling(saved.dailyBudgetCeiling, read.value)
      && !window.confirm(ceilingQuestion(saved.dailyBudgetCeiling, rupees))) return;
    setBusy(true);
    setMsg(null);
    try {
      const s = await api<AppSettings>("/api/settings", { method: "POST", body: { dailyBudgetCeiling: read.value, alertEmails: emails } });
      setSaved(s);
      setCeiling(String(s.dailyBudgetCeiling));
      setEmails(s.alertEmails);
      setMsg({ kind: "ok", text: "Saved." });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
    setBusy(false);
  }

  if (!saved) return msg ? <div className={`msg ${msg.kind}`}>{msg.text}</div> : <p className="muted">Loading…</p>;

  return (
    <div className="panel">
      <header><h2>Safety</h2></header>
      <label className="field" style={{ maxWidth: 280 }}>
        <span>Daily budget ceiling (₹)</span>
        <input type="text" inputMode="numeric" value={ceiling} onChange={(e) => setCeiling(e.target.value)} placeholder="e.g. 5000" />
      </label>
      <p className="hint">
        No launch or plan can let more than this spend per day. Claude can&apos;t change it. 0 means no ceiling.
        {" "}Now: {saved.dailyBudgetCeiling ? <strong>{rupees(saved.dailyBudgetCeiling)} a day</strong> : "no ceiling"}.
      </p>
      {read.error && <div className="msg error">{read.error}</div>}

      <label className="check" style={{ marginTop: 18 }}>
        <input type="checkbox" checked={emails} onChange={(e) => setEmails(e.target.checked)} />
        <span>Email me when a background launch or plan fails</span>
      </label>
      <p className="hint">Emails are sent from your own Gmail. If you signed in before 18 Nov, sign out and in again and allow &apos;send email&apos;.</p>

      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={busy || invalid} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>

      {backup && (
        <>
          <h3 style={{ marginTop: 24 }}>Backups</h3>
          <p className="hint">
            {backup.lastBackupAt
              ? <>Last backup: {ist(backup.lastBackupAt)}, {backup.offsite ? "copied to Object Storage" : "kept on the server only"}. Last copy outside the server: {backup.lastOffsiteAt ? ist(backup.lastOffsiteAt) : "none yet"}.</>
              : backup.message}
          </p>
          {backup.warning
            ? <div className="msg error">{backup.warning}</div>
            : backup.lastBackupAt && !backup.offsite && <p className="hint">{backup.message}</p>}
        </>
      )}
    </div>
  );
}
