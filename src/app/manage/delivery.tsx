"use client";

// "Is it delivering?" A small table of ad sets and ads with Meta's status in plain words,
// the learning phase, and any problems Meta reports. Read only.

import { useCallback, useEffect, useState } from "react";
import type { DeliveryRow } from "@/lib/manage/delivery";
import { api } from "../client-api";
import { msgClass } from "../msg";
import s from "./manage.module.css";

const PILL: Record<string, string> = {
  ACTIVE: "done",
  PAUSED: "draft",
  ADSET_PAUSED: "draft",
  CAMPAIGN_PAUSED: "draft",
  PENDING_REVIEW: "running",
  IN_PROCESS: "running",
  PREAPPROVED: "running",
  DISAPPROVED: "failed",
  WITH_ISSUES: "failed",
  PENDING_BILLING_INFO: "partial",
};

/** Loads when shown. `query` is "plan=KEY", "campaign=ID" or "adset=ID". */
export function DeliveryTable({ query, onClose }: { query: string; onClose?: () => void }) {
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRows((await api<{ rows: DeliveryRow[] }>(`/api/manage/delivery?${query}`)).rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={s.delivery}>
      {loading && !rows && <p className="muted" style={{ margin: 0 }}>Asking Meta…</p>}
      {error && <div className={msgClass(error)}>{error}</div>}
      {rows && rows.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing to show: no ad sets or ads found.</p>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table className={s.smallTable}>
            <thead>
              <tr><th>What</th><th>Name</th><th>Status</th><th>Learning</th><th>Problems</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}${r.id}`}>
                  <td>{r.kind === "adset" ? "Ad set" : r.kind === "campaign" ? "Campaign" : "Ad"}</td>
                  <td style={{ minWidth: 160, whiteSpace: "normal" }}>{r.name}{r.inAdset && <small className="muted"> (in ad set {r.inAdset.name ? `"${r.inAdset.name}"` : r.inAdset.id})</small>}</td>
                  <td><span className={`status ${PILL[r.status] ?? "partial"}`}>{r.plain || "unknown"}</span></td>
                  <td>{r.learning ?? <span className="muted">–</span>}</td>
                  <td style={{ minWidth: 200, whiteSpace: "normal", color: r.issues.length ? "var(--err)" : undefined }}>
                    {r.issues.length ? r.issues.join("; ") : <span className="muted">None</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={s.actions} style={{ marginTop: 8 }}>
        <button className="link" disabled={loading} onClick={() => void load()}>{loading ? "Checking…" : "Check again"}</button>
        {onClose && <button className="link" onClick={onClose}>Hide</button>}
      </div>
    </div>
  );
}
