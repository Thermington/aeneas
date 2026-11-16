import { useEffect, useState } from "react";
import { HubError } from "../../sync/api";
import { db } from "../../sync/db";
import { uuid } from "../../sync/edits";
import { useHubReady } from "../../sync/hooks";
import { plainError } from "../../lib/errors";
import { go } from "../../lib/router";
import {
  ASSISTANT_DRAFT_KEY, TEXT_SIZES, TEXT_SIZE_DEFAULT, addRecent, keepPosition, pageKey, parsePositions, parseRecent,
  type Positions, type RecentPage, type RefHit, type RefStatus, type Stage,
} from "../../lib/reference";
import * as api from "./api";

// ---------- The hub's status, shared by the search screen, the reader and Settings, Reference ----------

let status: RefStatus | null = null;
let statusAt = 0;
let statusError: { text: string; missing: boolean } | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

/** A status read elsewhere (Settings polls it) becomes the one every Reference screen shows. */
export function keepStatus(s: RefStatus): void {
  status = s;
  statusAt = Date.now();
  statusError = null;
  changed();
}

export function refreshStatus(): Promise<void> {
  loading ??= api.status().then(keepStatus, (e) => {
    statusError = { text: plainError(e), missing: e instanceof HubError && e.status === 404 };
    changed();
  }).finally(() => { loading = null; });
  return loading;
}

/**
 * The status, read again when it is older than `maxAgeMs` (only while `enabled`); `missing` is a hub without
 * Reference (404).
 */
export function useRefStatus(maxAgeMs = 30_000, enabled = true): { status: RefStatus | null; error: { text: string; missing: boolean } | null } {
  const ready = useHubReady();
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((x) => x + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  useEffect(() => {
    if (enabled && ready && Date.now() - statusAt > maxAgeMs) void refreshStatus();
  }, [ready, maxAgeMs, enabled]);
  return { status, error: statusError };
}

// ---------- Kept on this device ----------

const RECENT_KEY = "ea.reference.recent";
const POSITIONS_KEY = "ea.reference.positions";
const SIZE_KEY = "ea.reference.textSize";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private window: kept until the app closes */ }
}

export function readRecent(): RecentPage[] {
  return parseRecent(read(RECENT_KEY));
}
export function rememberPage(page: RecentPage): void {
  write(RECENT_KEY, JSON.stringify(addRecent(readRecent(), page)));
}
export function clearRecent(): void {
  write(RECENT_KEY, null);
}

let positions: Positions | null = null;
export function readPositions(): Positions {
  positions ??= parsePositions(read(POSITIONS_KEY));
  return positions;
}
export function savePosition(book: string, path: string, fraction: number): void {
  positions = keepPosition(readPositions(), pageKey(book, path), fraction);
  write(POSITIONS_KEY, JSON.stringify(positions));
}

export function readTextSize(): number {
  const n = Number(read(SIZE_KEY));
  return TEXT_SIZES.includes(n) ? n : TEXT_SIZE_DEFAULT;
}
export function writeTextSize(n: number): void {
  write(SIZE_KEY, String(n));
}

// ---------- Kept while the app is open ----------

/** The search as it was when a result was opened, so Back from the reader finds it where it was. */
export interface SearchMemo {
  q: string; sources: string[]; langs: string[];
  hits: RefHit[]; total: number; partial: boolean; stage: Stage | null; scrollY: number;
}
export const searchMemo: { current: SearchMemo | null } = { current: null };

/** The title of the page being opened, shown while it loads. */
export const opening: { current: { book: string; path: string; title: string } | null } = { current: null };

/**
 * Ask about this page: a new chat with its first message typed in, handed to the Assistant through sessionStorage
 * (`ea.assistantDraft`, read once for that chat), the way Gallery hands a picture to Create image.
 */
export async function askAssistant(text: string): Promise<void> {
  const id = uuid();
  const now = new Date().toISOString();
  await db.sessions.put({ id, title: "New chat", task_type: "auto", allow_cloud: false, messages: [], created_at: now, updated_at: now, on_hub: false });
  try { sessionStorage.setItem(ASSISTANT_DRAFT_KEY, JSON.stringify({ session: id, text })); } catch { /* private window */ }
  go(`/assistant/${id}`);
}
