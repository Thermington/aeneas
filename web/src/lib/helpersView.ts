import { useCallback, useEffect, useState } from "react";
import { engine } from "../sync/engine";
import { HubError, type HelpersView } from "../sync/api";
import { useHubReady } from "../sync/hooks";

/**
 * Who helps this person with their devices (GET /helpers), shared by the offer card and Settings, People who help
 * you. Asked when the app gets its hub, every two minutes, and when the window comes back to the front. Null on a hub
 * without helpers (before 1.0.6) or before the first answer.
 */
let current: HelpersView | null = null;
const listeners = new Set<(v: HelpersView | null) => void>();
let lastAsk = 0;

export async function refreshHelpers(): Promise<HelpersView | null> {
  const c = engine.client;
  if (!c) return current;
  lastAsk = Date.now();
  try {
    current = await c.helpers();
  } catch (e) {
    if (e instanceof HubError && (e.status === 404 || e.status === 403)) current = null;
  }
  for (const fn of listeners) fn(current);
  return current;
}

export function useHelpers(): { view: HelpersView | null; refresh: () => Promise<HelpersView | null> } {
  const [view, setView] = useState(current);
  const ready = useHubReady();
  useEffect(() => {
    listeners.add(setView);
    if (Date.now() - lastAsk > 10_000) void refreshHelpers();
    const t = setInterval(() => void refreshHelpers(), 2 * 60_000);
    const onFocus = () => { if (Date.now() - lastAsk > 20_000) void refreshHelpers(); };
    window.addEventListener("focus", onFocus);
    return () => { listeners.delete(setView); clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [ready]);
  return { view, refresh: useCallback(() => refreshHelpers(), []) };
}

/** "Monday 3:14 PM", for a line in the log. */
export function whenText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: "long" })} at ${time}`;
  return `${d.toLocaleDateString([], { month: "long", day: "numeric" })} at ${time}`;
}

/** "today at 3:14 PM", "Monday at 3:14 PM": the same, inside a sentence. */
export function inSentence(iso: string, now = new Date()): string {
  return whenText(iso, now).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase());
}

/** "Since today at 3:14 PM". */
export function sinceText(iso: string, now = new Date()): string {
  return `Since ${inSentence(iso, now)}`;
}
