"use client";

import { useState } from "react";
import { api, lastUsed } from "./client-api";

export default function NewBatch() {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<"drive" | "upload" | null>(null);
  const [error, setError] = useState("");

  async function start(kind: "drive" | "upload") {
    setBusy(kind);
    setError("");
    try {
      const body = { ...lastUsed.get(), ...(kind === "drive" ? { driveFolder: link } : {}) };
      const view = await api<{ key: string }>("/api/batches", { method: "POST", body }).catch(async (e: Error) => {
        // A remembered ad set may be gone: try again without remembered settings.
        if (/Couldn't find/.test(e.message)) return api<{ key: string }>("/api/batches", { method: "POST", body: kind === "drive" ? { driveFolder: link } : {} });
        throw e;
      });
      window.location.href = `/batches/${view.key}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <>
      <div className="options">
        <div className="panel option" style={{ marginBottom: 0 }}>
          <div>
            <h2>Google Drive folder</h2>
            <p className="hint">Paste the folder link. Sub-folders are included, and files stay private in Drive.</p>
          </div>
          <input type="url" aria-label="Drive folder link" placeholder="https://drive.google.com/drive/folders/…" value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === "Enter" && link && !busy && start("drive")} />
          <div className="grow" />
          <button className="primary" disabled={!link || !!busy} onClick={() => start("drive")}>
            {busy === "drive" ? "Reading the folder…" : "Continue"}
          </button>
        </div>
        <div className="panel option" style={{ marginBottom: 0 }}>
          <div>
            <h2>Files from this computer</h2>
            <p className="hint">Drag files or whole folders in on the next screen. Big videos keep uploading if your internet drops.</p>
          </div>
          <div className="grow" />
          <button className="primary" disabled={!!busy} onClick={() => start("upload")}>
            {busy === "upload" ? "Starting…" : "Upload files"}
          </button>
        </div>
      </div>
      {error && <div className="msg error">{error}</div>}
    </>
  );
}
