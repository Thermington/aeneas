import http from "node:http";
import https from "node:https";

/**
 * The offline reference's requests: every one has a hard time limit. The catalog and metalinks come only from Kiwix's
 * own https hosts; archive and reader downloads follow a mirror's redirects over https, since their hashes are checked.
 */

/** Kiwix's hosts: the catalog and metalinks are read from these only, redirects included. */
export function kiwixHost(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === "https:" && (u.hostname === "kiwix.org" || u.hostname.endsWith(".kiwix.org")) && !u.username && !u.password;
  } catch { return false; }
}

/** A response body as text, refused past `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) throw new Error(`the answer is over ${max} bytes`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new Error(`the answer is over ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A GET from Kiwix with one time limit over every hop and the body: at most three redirects, each to one of Kiwix's
 * own https hosts (library.kiwix.org answers from opds.library.kiwix.org); anything else is refused.
 */
export async function fetchFromKiwix(fetchFn: typeof fetch, url: string, timeoutMs: number, accept: string): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  let at = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!kiwixHost(at)) throw new Error("an address outside Kiwix's servers was refused");
    const res = await fetchFn(at, { signal, headers: { accept, "user-agent": "Aeneas hub (offline reference)" }, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!next) throw new Error(`Kiwix answered ${res.status} with no address`);
      at = new URL(next, at).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

export interface GetOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Until the answer's headers arrive (default 20 s). */
  connectTimeoutMs?: number;
  /** With no bytes for this long the request is dropped (default 60 s). */
  idleTimeoutMs?: number;
  /** Tests only: plain http to 127.0.0.1 is allowed too. */
  allowHttpLoopback?: boolean;
}

export interface GetResponse { status: number; headers: http.IncomingHttpHeaders; body: http.IncomingMessage; url: string }

export class NetError extends Error {
  constructor(message: string, readonly kind: "connect" | "timeout" | "status" | "refused") { super(message); }
}

function allowed(u: URL, opts: GetOptions): boolean {
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return !!opts.allowHttpLoopback && u.protocol === "http:" && u.hostname === "127.0.0.1";
}

/**
 * A streaming GET (archives, the reader's own archive): at most five redirects, every hop https. The body is the
 * caller's to read or destroy; it ends with an error when no byte arrives for `idleTimeoutMs`.
 */
export function httpGet(url: string, opts: GetOptions = {}): Promise<GetResponse> {
  return new Promise((resolve, reject) => {
    let hops = 0;
    const go = (at: string) => {
      let u: URL;
      try { u = new URL(at); } catch { reject(new NetError("not an address", "refused")); return; }
      if (!allowed(u, opts)) { reject(new NetError("only https addresses are used", "refused")); return; }
      if (opts.signal?.aborted) { reject(new NetError("stopped", "connect")); return; }
      const mod = u.protocol === "https:" ? https : http;
      let settled = false;
      const req = mod.get(u, { headers: { "user-agent": "Aeneas hub (offline reference)", ...(opts.headers ?? {}) } });
      const connect = setTimeout(() => { req.destroy(new NetError("no answer in time", "timeout")); }, opts.connectTimeoutMs ?? 20_000);
      const onAbort = () => req.destroy(new NetError("stopped", "connect"));
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (e) => {
        clearTimeout(connect);
        opts.signal?.removeEventListener("abort", onAbort);
        if (!settled) { settled = true; reject(e instanceof NetError ? e : new NetError(`connection failed: ${(e as NodeJS.ErrnoException).code ?? "error"}`, "connect")); }
      });
      req.on("response", (res) => {
        clearTimeout(connect);
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          opts.signal?.removeEventListener("abort", onAbort);
          settled = true;
          if (++hops > 5) { reject(new NetError("too many redirects", "status")); return; }
          go(new URL(res.headers.location, u).toString());
          return;
        }
        settled = true;
        // Idle: the socket's own timer, reset by every byte.
        res.setTimeout(opts.idleTimeoutMs ?? 60_000, () => res.destroy(new NetError("no data for too long", "timeout")));
        res.once("close", () => opts.signal?.removeEventListener("abort", onAbort));
        opts.signal?.addEventListener("abort", () => res.destroy(new NetError("stopped", "connect")), { once: true });
        resolve({ status, headers: res.headers, body: res, url: u.toString() });
      });
    };
    go(url);
  });
}
