import { engine } from "../../sync/engine";
import { HubError, type HubClient } from "../../sync/api";
import type {
  RefArticle, RefPlan, RefRandom, RefSearchAnswer, RefSettings, RefSources, RefStatus, RefSuggestAnswer, RefSummary,
} from "../../lib/reference";
import { readSettings } from "../../lib/reference";

/**
 * The hub's Reference routes (CONTRACT "Offline reference"), through the hub client: its key in the header and its
 * fetch (hubFetch), so a Direct link hub is reached over the app's own connection, picture bytes included.
 */

function client(): HubClient {
  const c = engine.client;
  if (!c) throw new Error("Not connected to a hub.");
  return c;
}

/** A signal that ends with the caller's or after `ms`, whichever comes first, so no request waits forever. */
function timed(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException("The hub took too long to answer.", "TimeoutError")), ms);
  const stop = () => ctl.abort(signal?.reason);
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  return { signal: ctl.signal, done: () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); } };
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, ms = 20_000): Promise<T> {
  const t = timed(signal, ms);
  try {
    return await client().req<T>(method, path, body, t.signal);
  } finally {
    t.done();
  }
}

function query(params: Record<string, string | number | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) { if (v.length) q.set(k, v.join(",")); }
    else q.set(k, String(v));
  }
  return q.toString();
}

export interface Narrow { sources: string[]; langs: string[] }

export function suggest(q: string, signal?: AbortSignal): Promise<RefSuggestAnswer> {
  return call("GET", `/reference/suggest?${query({ q, limit: 8 })}`, undefined, signal);
}

export function search(q: string, narrow: Narrow, offset: number, signal?: AbortSignal): Promise<RefSearchAnswer> {
  return call("GET", `/reference/search?${query({ q, sources: narrow.sources, langs: narrow.langs, limit: 20, offset })}`, undefined, signal);
}

export function article(book: string, path: string, signal?: AbortSignal): Promise<RefArticle> {
  return call("GET", `/reference/article?${query({ book, path })}`, undefined, signal, 30_000);
}

export function random(narrow: Narrow): Promise<RefRandom> {
  return call("GET", `/reference/random?${query({ sources: narrow.sources, langs: narrow.langs })}`);
}

const summaries = new Map<string, Promise<RefSummary>>();

/** A linked page's first paragraph, for its preview; asked once per page while the app is open. */
export function summary(book: string, path: string): Promise<RefSummary> {
  const key = `${book}\n${path}`;
  let p = summaries.get(key);
  if (!p) {
    p = call<RefSummary>("GET", `/reference/summary?${query({ book, path })}`);
    p.catch(() => summaries.delete(key));
    if (summaries.size > 200) summaries.delete(summaries.keys().next().value as string);
    summaries.set(key, p);
  }
  return p;
}

/** A picture from a book, as a blob: address for an <img>. The caller revokes it. */
export async function media(book: string, path: string, signal?: AbortSignal): Promise<string> {
  const c = client();
  const t = timed(signal, 30_000);
  try {
    const res = await c.fetchImpl(c.url(`/reference/media?${query({ book, path })}`), { headers: c.headers(), signal: t.signal });
    if (!res.ok) throw new HubError(res.status, `media ${res.status}`);
    return URL.createObjectURL(await res.blob());
  } finally {
    t.done();
  }
}

export function status(): Promise<RefStatus> {
  return call("GET", "/reference/status");
}

export async function settings(): Promise<{ settings: RefSettings; plan: RefPlan | null }> {
  return readSettings(await call<unknown>("GET", "/reference/settings"));
}

export async function saveSettings(changes: Partial<RefSettings>): Promise<{ settings: RefSettings; plan: RefPlan | null }> {
  return readSettings(await call<unknown>("PUT", "/reference/settings", changes));
}

export function sources(): Promise<RefSources> {
  return call("GET", "/reference/sources", undefined, undefined, 60_000);
}

export function pause(): Promise<unknown> { return call("POST", "/reference/pause", {}); }
export function resume(): Promise<unknown> { return call("POST", "/reference/resume", {}); }
export function checkNow(): Promise<unknown> { return call("POST", "/reference/check", {}, undefined, 60_000); }
export function removeBook(name: string): Promise<unknown> { return call("DELETE", `/reference/books/${encodeURIComponent(name)}`); }
