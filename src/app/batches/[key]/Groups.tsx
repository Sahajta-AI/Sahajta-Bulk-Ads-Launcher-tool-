"use client";

import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import type { BatchView } from "@/lib/service";

// The grouping board: one card per ad. Drag a file onto another card to pair it,
// or onto "New ad" to give it an ad of its own.

type Ad = BatchView["ads"][number];
type File = Ad["files"][number];

function ratioBadge(f: File) {
  if (!f.ratio) return <span className="badge grey">?</span>;
  return <span className={`badge ${f.ratio === "9x16" ? "v" : ""}`}>{f.ratio.replace("x", ":")}</span>;
}

function Chip({ file, onRemove, editable }: { file: File; onRemove: () => void; editable: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `asset-${file.id}`, disabled: !editable });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 10, position: "relative" as const } : undefined;
  return (
    <div ref={setNodeRef} style={style} className={`chip ${isDragging ? "dragging" : ""}`} {...listeners} {...attributes} title={`${file.filename} · ${file.dims} · ${file.size}`}>
      {ratioBadge(file)}
      <span className="name">
        {file.filename}
        {file.placement !== "All placements" && <small className="where">{file.placement}</small>}
      </span>
      {editable && (
        <button onPointerDown={(e) => e.stopPropagation()} onClick={onRemove} title="Remove from batch" aria-label={`Remove ${file.filename}`}>
          ×
        </button>
      )}
    </div>
  );
}

function Card({ ad, children }: { ad: Ad; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `ad-${ad.id}` });
  const problems = ad.checks.filter((c) => c.code === "slot_clash" || c.code === "mixed_kinds" || c.code === "unknown_ratio");
  return (
    <div ref={setNodeRef} className={`group ${isOver ? "over" : ""}`}>
      <h3>
        <span className="badge grey">{String(ad.position).padStart(2, "0")}</span> {ad.creativeName}
      </h3>
      {children}
      {problems.map((c) => (
        <div key={c.message} className="msg error" style={{ fontSize: 12 }}>{c.message}</div>
      ))}
    </div>
  );
}

function NewZone() {
  const { setNodeRef, isOver } = useDroppable({ id: "new" });
  return (
    <div ref={setNodeRef} className={`group new ${isOver ? "over" : ""}`}>
      Drop a file here to make it a separate ad
    </div>
  );
}

export default function Groups({ view, onMove, onRemove }: { view: BatchView; onMove: (assetId: number, to: number | "new") => void; onRemove: (assetId: number) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const editable = view.status === "draft";

  function onDragEnd(e: DragEndEvent) {
    if (!e.over) return;
    const assetId = Number(String(e.active.id).replace("asset-", ""));
    const target = e.over.id === "new" ? "new" : Number(String(e.over.id).replace("ad-", ""));
    const from = view.ads.find((a) => a.files.some((f) => f.id === assetId));
    if (from && from.id === target) return;
    onMove(assetId, target);
  }

  if (!view.ads.length) return null;

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="groups">
        {view.ads.map((ad) => (
          <Card key={ad.id} ad={ad}>
            {ad.files.map((f) => (
              <Chip key={f.id} file={f} editable={editable} onRemove={() => onRemove(f.id)} />
            ))}
          </Card>
        ))}
        {editable && <NewZone />}
      </div>
    </DndContext>
  );
}
