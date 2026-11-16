import { useCallback, useEffect, useRef } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { useEscape } from "../lib/keys";
import { fmtDue } from "../lib/planner";

/**
 * One tap schedules: a short list of `next` tasks (manual order) for a free slot. The caller does the
 * scheduling and closes the picker. Kept to one thing per row so it reads at 390 px.
 */
export function TaskPicker({ title, onPick, onClose, busy, error }: { title: string; onPick: (t: Entity) => void; onClose: () => void; busy?: boolean; error?: string | null }) {
  const next = useEntities("task", (e) => e.fields.status === "next" && !e.fields.block)
    .slice()
    .sort((a, b) => (a.fields.order as number) - (b.fields.order as number));
  useEscape(useCallback(() => onClose(), [onClose]));
  // It opens above the timeline, out of sight on a phone when Schedule here was low on the page: brought into view,
  // with the focus, each time it opens for a slot.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" });
    box.current?.focus({ preventScroll: true });
  }, [title]);
  return (
    <div className="picker card" role="dialog" aria-label={title} ref={box} tabIndex={-1}>
      <div className="row between">
        <strong>{title}</strong>
        <button className="small ghost" onClick={onClose} aria-label="Close the task picker">
          Close
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!next.length && <div className="muted small">No next tasks. Add one in Tasks.</div>}
      <div className="list" style={{ marginTop: 8 }}>
        {next.slice(0, 8).map((t) => (
          <button key={t.id} className="item pick" disabled={busy} onClick={() => onPick(t)} aria-label={`Schedule ${String(t.fields.title)}`}>
            <span className="body">
              <span className="t">{String(t.fields.title)}</span>
              {!!t.fields.due && <span className="meta">due {fmtDue(t.fields.due as string)}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
