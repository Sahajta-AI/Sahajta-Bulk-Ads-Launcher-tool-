"use client";

import { useEffect, useRef, useState } from "react";
import * as tus from "tus-js-client";

// Drag files or folders in. Each file goes up with tus (resumable, 16 MB chunks),
// so a dropped connection continues where it stopped.

interface Item {
  file: File;
  rel: string;
}

async function readEntry(entry: FileSystemEntry, prefix = ""): Promise<Item[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    return [{ file, rel: prefix + file.name }];
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const all: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      all.push(...batch);
    }
    const nested = await Promise.all(all.map((e) => readEntry(e, `${prefix}${entry.name}/`)));
    return nested.flat();
  }
  return [];
}

export default function Uploader({ batchKey, onUploaded, onBusy }: { batchKey: string; onUploaded: () => void; onBusy?: (uploading: number) => void }) {
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  function uploadOne(item: Item): Promise<void> {
    return new Promise((resolve) => {
      const up = new tus.Upload(item.file, {
        endpoint: "/api/upload",
        chunkSize: 16 * 1024 * 1024,
        retryDelays: [0, 2000, 5000, 10000, 20000, 30000, 60000],
        removeFingerprintOnSuccess: true,
        // Resume only within this batch: the same file dropped into another batch starts fresh.
        fingerprint: (file) => Promise.resolve(["sahajta", batchKey, item.rel, file.size, file.lastModified].join("|")),
        metadata: { batch: batchKey, filename: item.file.name, relativePath: item.rel, filetype: item.file.type },
        onProgress: (sent, total) => setProgress((p) => ({ ...p, [item.rel]: Math.round((sent / total) * 100) })),
        onError: (err) => {
          setErrors((e) => [...e, `${item.rel}: ${err.message.split("\n")[0]}`]);
          resolve();
        },
        onSuccess: () => {
          setProgress((p) => ({ ...p, [item.rel]: 100 }));
          resolve();
        },
      });
      // Resume an earlier, interrupted upload of the same file if there is one.
      up.findPreviousUploads().then((prev) => {
        if (prev.length) up.resumeFromPreviousUpload(prev[0]);
        up.start();
      });
    });
  }

  async function uploadAll(items: Item[]) {
    const queue = items.filter((i) => !i.file.name.startsWith("."));
    setProgress((p) => ({ ...p, ...Object.fromEntries(queue.map((i) => [i.rel, 0])) }));
    let next = 0;
    const workers = Array.from({ length: 3 }, async () => {
      while (next < queue.length) {
        const item = queue[next++];
        await uploadOne(item);
        onUploaded();
      }
    });
    await Promise.all(workers);
    onUploaded();
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).filter(Boolean) as FileSystemEntry[];
    const items = (await Promise.all(entries.map((en) => readEntry(en)))).flat();
    await uploadAll(items);
  }

  const files = Object.entries(progress);
  const failed = new Set(errors.map((e) => e.split(": ")[0]));
  const busy = files.filter(([n, p]) => p < 100 && !failed.has(n));
  const uploading = busy.length;
  useEffect(() => onBusy?.(uploading), [uploading, onBusy]);

  return (
    <div>
      <div
        className={`drop ${over ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <strong>Drag images, videos or whole folders here</strong>
        <p>
          or <button className="link" onClick={() => input.current?.click()}>choose files</button> /{" "}
          <button className="link" onClick={() => folderInput.current?.click()}>choose a folder</button>
        </p>
        <input ref={input} type="file" multiple hidden accept="image/jpeg,image/png,video/mp4,video/quicktime,.mov,.m4v"
          onChange={(e) => uploadAll([...(e.target.files ?? [])].map((file) => ({ file, rel: file.name })))} />
        <input ref={folderInput} type="file" multiple hidden {...({ webkitdirectory: "" } as object)}
          onChange={(e) => uploadAll([...(e.target.files ?? [])].map((file) => ({ file, rel: file.webkitRelativePath || file.name })))} />
      </div>
      {busy.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <small>Uploading {busy.length} of {files.length} files. You can keep working; don&apos;t close this tab.</small>
          {busy.slice(0, 6).map(([name, p]) => (
            <div key={name} style={{ fontSize: 13 }}>
              {name} <div className="bar"><div style={{ width: `${p}%` }} /></div>
            </div>
          ))}
        </div>
      )}
      {errors.map((e) => (
        <div key={e} className="msg error">Upload failed for {e}. Drop the file again to continue where it stopped.</div>
      ))}
    </div>
  );
}
