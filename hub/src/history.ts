import { readingLabel } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { sensorByName } from "./sensors.js";
import { errCode } from "./logsafe.js";

/**
 * History (Tech, since 2026-11-19): what happened on a machine or place, on its page. Most of it is already kept:
 * changes are `journal` entries, a check that went down and came back is its `incident`, fix notes are `runbook`s, and
 * the apps put those together. What nothing kept was a reading going out of bounds and back, which only notified: the
 * hub writes those as journal entries with `source: "hub"` (lists of changes leave them out). A sensor that flaps
 * across its bound keeps one line: a new state within the hour rewrites that line with the latest, so a history stays
 * readable and still ends on how the reading is now.
 */

const FLAP_MS = 60 * 60_000;

/** The line for a reading's new state: "Disk P: went above 90%: 91.2%", "Freezer back to normal: 2 °F". */
export function readingEvent(name: string, location: string, state: string, value: number | null, unit: string, bounds: { min?: number; max?: number }): string {
  const label = readingLabel(name, location);
  const u = (n: number) => (unit === "%" ? `${n}%` : unit ? `${n} ${unit}` : String(n));
  const shown = value === null ? "" : `: ${u(Math.round(value * 10) / 10)}`;
  if (/\.healthy$/.test(name)) return state === "ok" ? `${label}: healthy again` : `${label}: degraded`;
  switch (state) {
    case "high": return `${label} went above ${bounds.max != null ? u(bounds.max) : "its bound"}${shown}`;
    case "low": return `${label} went below ${bounds.min != null ? u(bounds.min) : "its bound"}${shown}`;
    case "stale": return `${label} stopped reporting`;
    default: return `${label} back to normal${shown}`;
  }
}

export function installHistory(hub: Hub): void {
  const last = new Map<string, { id: string; at: number }>();
  hub.bus.on("notify", (n) => {
    if (n.kind !== "sensor" || typeof n.name !== "string" || typeof n.state !== "string") return;
    try {
      const s = sensorByName(hub, n.name);
      if (!s || s.fields.alert === false) return;
      const at = n.at || new Date().toISOString();
      const prev = last.get(n.name);
      const now = Date.parse(at) || Date.now();
      const location = String(s.fields.location ?? "").trim();
      const what = readingEvent(n.name, location, n.state, typeof n.value === "number" ? n.value : null, String(s.fields.unit ?? ""), {
        ...(typeof s.fields.min === "number" ? { min: s.fields.min } : {}),
        ...(typeof s.fields.max === "number" ? { max: s.fields.max } : {}),
      });
      const line = prev && now - prev.at < FLAP_MS ? hub.store.get(prev.id) : null;
      if (line && !line.deleted_at) {
        hub.store.patch(line.id, { at, what: `${what} (it went back and forth)`.slice(0, 1000) });
        return;
      }
      const j = hub.store.create("journal", { host: (location || "home").toLowerCase(), at, what: what.slice(0, 1000), risk: "low", outcome: "done", source: "hub" });
      last.set(n.name, { id: j.id, at: now });
    } catch (e) {
      console.error(`[history] a reading's alert was not written: ${errCode(e)}`);
    }
  });
}
