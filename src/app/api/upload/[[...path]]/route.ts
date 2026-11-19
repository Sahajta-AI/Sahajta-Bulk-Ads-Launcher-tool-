import { FileStore } from "@tus/file-store";
import { Server } from "@tus/server";
import fs from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { caller } from "@/lib/http";
import { autoGroup } from "@/lib/engine/preview";
import { GB, freeBytes } from "@/lib/cleanup";
import { addLocalFile } from "@/lib/sources/local";
import { getBatchByKey } from "@/lib/store";

export const dynamic = "force-dynamic";

// Resumable uploads (tus). A dropped connection continues where it stopped instead of
// restarting a 300 MB video. When a file finishes, it joins its batch and is grouped.

const g = globalThis as unknown as { __tus?: Server };

function server() {
  if (g.__tus) return g.__tus;
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  g.__tus = new Server({
    path: "/api/upload",
    datastore: new FileStore({ directory: config.uploadsDir }),
    maxSize: 4 * 1024 ** 3,
    // Relative upload addresses: behind Caddy the app sees "localhost:3000", not the public host.
    relativeLocation: true,
    async onUploadCreate(_req, upload) {
      const b = getBatchByKey(upload.metadata?.batch ?? "");
      if (!b || b.status !== "draft") throw { status_code: 400, body: "This batch can't take new files.\n" };
      // Keep 2 GB free on the server (the database, backups and other uploads need room).
      const free = freeBytes();
      const size = Number(upload.size);
      if (free !== null && Number.isFinite(size) && size > 0 && free - size < 2 * GB) {
        throw { status_code: 507, body: `The server has only ${(free / GB).toFixed(1)} GB free, too little for this ${(size / GB).toFixed(1)} GB file. Ask your admin to free space, then upload it again.\n` };
      }
      return {};
    },
    async onUploadFinish(_req, upload) {
      const b = getBatchByKey(upload.metadata?.batch ?? "");
      const file = path.join(config.uploadsDir, upload.id);
      if (!b || b.status !== "draft") {
        // Finished after the batch was launched: say so instead of dropping it quietly.
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.json`, { force: true });
        throw { status_code: 409, body: "This batch was already launched, so this file was not added. Start a new batch for it.\n" };
      }
      const rel = upload.metadata?.relativePath || upload.metadata?.filename || upload.id;
      // The same file dropped again (e.g. the whole folder after one upload failed): keep one copy.
      const size = fs.statSync(file).size;
      const dup = db().prepare("SELECT id FROM assets WHERE batch_id = ? AND rel_path = ? AND size_bytes = ?").get(b.id, rel, size);
      if (dup) {
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.json`, { force: true });
        return {};
      }
      await addLocalFile(b.id, file, rel, "upload", upload.id);
      autoGroup(b.id);
      return {};
    },
  });
  return g.__tus;
}

async function handle(req: Request) {
  try {
    await caller(req);
  } catch {
    return new Response("Please sign in.", { status: 401 });
  }
  return server().handleWeb(req);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const HEAD = handle;
export const DELETE = handle;
export const OPTIONS = handle;
