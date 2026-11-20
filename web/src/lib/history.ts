import type { Entity } from "@everythingapp/shared";
import type { IncidentF } from "./ops";
import { fmtDuration } from "./time";

/**
 * History (Tech, since 2026-11-19): what happened on a machine or place, newest first, put together from what every
 * device already has: changes (`journal`, without approved lookups or steps only planned), checks that went down and
 * came back (`incident`), readings that went out of bounds and back (journal lines the hub writes, `source: "hub"`),
 * and fix notes (`runbook`). Nothing to fill in: the one line people add is "What did you change?".
 */

export type HistoryKind = "change" | "failed" | "running" | "event" | "down" | "back" | "notes";
export interface HistoryItem {
  key: string;
  at: string;
  /** The machine or place, for the Overview's list across all of them. */
  host: string;
  kind: HistoryKind;
  text: string;
  detail?: string;
  /** Who: you, the assistant with your approval, or the hub noticing. Fix notes say nothing. */
  by?: "you" | "assistant" | "hub";
  command?: string;
  rollback?: string;
  session_id?: string;
  /** The journal entry, for Delete. */
  entity?: Entity;
}

const same = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
const secondsBetween = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000);

/**
 * `hostOf` gives a check's machine or place (GET /ops `things`), so an incident lands on the page its check is on.
 * Without `host`, every machine's history together (the Overview's Recent activity).
 */
export function historyItems(
  src: { journal: Entity[]; incidents: Entity[]; runbooks: Entity[]; hostOf: (monitorId: string) => string | undefined },
  host?: string,
): HistoryItem[] {
  const mine = (h: unknown) => (host ? same(h, host) : typeof h === "string" && !!h.trim());
  const out: HistoryItem[] = [];
  for (const e of src.journal) {
    const f = e.fields as Record<string, unknown>;
    if (e.deleted_at || f.outcome === "planned" || f.lookup === true || !mine(f.host)) continue;
    const outcome = String(f.outcome ?? "done");
    const hub = f.source === "hub";
    const ran = !!f.command && !!f.session_id;
    out.push({
      key: `j-${e.id}`, at: String(f.at), host: String(f.host).toLowerCase(),
      kind: hub ? "event" : outcome === "failed" || outcome === "interrupted" ? "failed" : outcome === "running" ? "running" : "change",
      text: String(f.what ?? ""),
      detail: outcome === "failed" ? "it failed" : outcome === "interrupted" ? "it stopped before it finished, so it may be half done" : outcome === "reverted" ? "undone later" : outcome === "running" ? "running now" : undefined,
      by: hub ? "hub" : ran ? "assistant" : "you",
      ...(typeof f.command === "string" ? { command: f.command } : {}),
      ...(typeof f.rollback === "string" ? { rollback: f.rollback } : {}),
      ...(typeof f.session_id === "string" ? { session_id: f.session_id } : {}),
      entity: e,
    });
  }
  for (const e of src.incidents) {
    const f = e.fields as IncidentF & { merged_into?: string };
    // One folded into its machine's incident is that one's story.
    if (e.deleted_at || f.merged_into) continue;
    const h = src.hostOf(f.monitor_id);
    if (!h || !mine(h)) continue;
    const also = f.also_down?.length ? `, with ${f.also_down.join(", ")}` : "";
    out.push({ key: `down-${e.id}`, at: f.opened_at, host: h, kind: "down", text: `${f.name} went down${also}`, detail: f.last_error, by: "hub" });
    if (f.closed_at) out.push({ key: `back-${e.id}`, at: f.closed_at, host: h, kind: "back", text: `${f.name} came back after ${fmtDuration(secondsBetween(f.opened_at, f.closed_at))}`, by: "hub" });
  }
  for (const e of src.runbooks) {
    const f = e.fields as Record<string, unknown>;
    if (e.deleted_at || !mine(f.host)) continue;
    out.push({ key: `rb-${e.id}`, at: e.updated_at, host: String(f.host).toLowerCase(), kind: "notes", text: "Fix notes updated", detail: typeof f.title === "string" ? f.title : undefined });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Steps planned on a machine that nobody has said were done: they wait at the top of its page with Done and Didn't do it. */
export function plannedSteps(journal: Entity[], host: string): Entity[] {
  return journal
    .filter((e) => !e.deleted_at && e.fields.outcome === "planned" && same(e.fields.host, host))
    .sort((a, b) => (String(a.fields.at) < String(b.fields.at) ? 1 : -1));
}
