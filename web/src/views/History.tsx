import { plainError } from "../lib/errors";
import { useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { createEntity, softDelete } from "../sync/edits";
import { copyText, patchEntity } from "../sync/memory";
import { fmtDateTime, relative } from "../lib/time";
import type { HistoryItem } from "../lib/history";

const BY: Record<NonNullable<HistoryItem["by"]>, string> = { you: "you", assistant: "the assistant, with your approval", hub: "noticed by the hub" };
const DOT: Record<HistoryItem["kind"], string> = { change: "up", failed: "down", running: "unknown", event: "warn", down: "down", back: "up", notes: "unknown" };

/** A machine's or place's history, newest first: one line each, with the command and how to undo it under a change the assistant ran. */
export function HistoryList({ items, showHost, step = 15 }: { items: HistoryItem[]; showHost?: boolean; step?: number }) {
  const [shown, setShown] = useState(step);
  if (!items.length) return <div className="muted small" style={{ marginTop: 6 }}>Nothing yet. Changes, alerts and checks that went down and came back show here.</div>;
  return (
    <>
      <ul className="plain history" style={{ marginTop: 8 }}>
        {items.slice(0, shown).map((i) => (
          <HistoryRow key={i.key} i={i} showHost={showHost} />
        ))}
      </ul>
      {items.length > shown && (
        <button className="small ghost" onClick={() => setShown((n) => n + step)}>
          Show older
        </button>
      )}
    </>
  );
}

function HistoryRow({ i, showHost }: { i: HistoryItem; showHost?: boolean }) {
  const [copied, setCopied] = useState(false);
  const own = i.entity && i.by === "you";
  return (
    <li className={`history-row kind-${i.kind}`}>
      <span className={`dot ${DOT[i.kind]}`} aria-hidden="true" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div style={{ overflowWrap: "anywhere" }}>
          {showHost && (
            <>
              <a href={`#/hosts/${encodeURIComponent(i.host)}`} className="mono">
                {i.host}
              </a>{" "}
            </>
          )}
          {i.text}
        </div>
        <div className="muted small">
          <span title={fmtDateTime(i.at)}>{relative(i.at)}</span>
          {i.by && <span>, {BY[i.by]}</span>}
          {i.detail && <span className={i.kind === "failed" || i.kind === "down" ? "error" : ""}>; {i.detail}</span>}
          {i.session_id && (
            <>
              {" · "}
              <a href={`#/assistant/${encodeURIComponent(i.session_id)}`}>chat</a>
            </>
          )}
          {own && (
            <>
              {" · "}
              <button className="link small danger" onClick={() => confirm("Delete this line from the history?") && void softDelete(i.entity!)}>
                delete
              </button>
            </>
          )}
        </div>
        {i.command && (
          <details className="small">
            <summary>command{i.rollback ? " and how to undo it" : ""}</summary>
            <div className="row top" style={{ marginTop: 4 }}>
              <pre className="grow cmd">{i.command}</pre>
              <button className="small ghost" onClick={() => void copyText(i.command!).then((ok) => { setCopied(ok); setTimeout(() => setCopied(false), 1500); })}>
                {copied ? "copied" : "Copy"}
              </button>
            </div>
            {i.rollback && <div>To undo: {i.rollback}</div>}
          </details>
        )}
      </div>
    </li>
  );
}

/** One line, "What did you change?": a change made by hand, written into this machine's history. */
export function NoteChange({ host }: { host: string }) {
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    const text = what.trim();
    if (!text) return;
    setBusy(true);
    setErr("");
    try {
      await createEntity("journal", { host: host.trim().toLowerCase(), at: new Date().toISOString(), what: text, risk: "low", outcome: "done" });
      setWhat("");
    } catch (e) {
      setErr(plainError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input className="grow" value={what} onChange={(e) => setWhat(e.target.value)} placeholder="What did you change? Replaced the fan, updated the BIOS" aria-label={`What did you change on ${host}?`} maxLength={1000} />
      <button type="submit" className="small" disabled={busy || !what.trim()}>
        Add
      </button>
      {err && <div className="error" style={{ flexBasis: "100%" }}>{err}</div>}
    </form>
  );
}

/** Steps planned on this machine (a command handed to you to run, a plan from a chat): Done puts one in the history, Didn't do it drops it. */
export function PlannedSteps({ steps }: { steps: Entity[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  if (!steps.length) return null;
  const done = async (e: Entity) => {
    setBusy(e.id);
    setErr("");
    try {
      await patchEntity(e, { outcome: "done", at: new Date().toISOString() });
    } catch (x) {
      setErr(plainError(x));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="card planned" style={{ marginTop: 8 }}>
      <div className="small" style={{ fontWeight: 600 }}>
        Planned, not done yet
      </div>
      {steps.map((e) => (
        <div key={e.id} className="planned-row">
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ overflowWrap: "anywhere" }}>{String(e.fields.what)}</div>
            {typeof e.fields.command === "string" && e.fields.command !== e.fields.what && <pre className="cmd small">{e.fields.command}</pre>}
            <div className="muted small">planned {relative(String(e.fields.at))}{typeof e.fields.rollback === "string" ? `; to undo: ${e.fields.rollback}` : ""}</div>
          </div>
          <div className="row" style={{ flex: "none" }}>
            <button className="small primary" disabled={busy === e.id} onClick={() => void done(e)}>
              Done
            </button>
            <button className="small" disabled={busy === e.id} onClick={() => confirm("Drop this planned step? It did not happen, so it stays out of the history.") && void softDelete(e)}>
              Didn't do it
            </button>
          </div>
        </div>
      ))}
      {err && <div className="error">{err}</div>}
    </div>
  );
}
