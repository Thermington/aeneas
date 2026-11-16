import { attr, child, children, descendants, parseXml, text } from "./xml.js";
import { fetchFromKiwix, readCapped } from "./net.js";

/**
 * A Metalink 4 file (RFC 5854) as Kiwix's download server writes it for each archive: the file's size, its SHA-256,
 * the SHA-1 of each piece (4 MiB) and its mirrors by priority. Only https mirrors are kept; Kiwix's own server comes
 * last, as the address the metalink was named for.
 */
export interface Metalink {
  file: string;
  size: number;
  sha256: string;
  pieceLength: number;
  /** SHA-1 of each piece, lower case hex, in order; empty when the metalink gives none. */
  pieces: string[];
  /** Mirrors in priority order, then download.kiwix.org. */
  urls: string[];
}

const MAX_META4_BYTES = 4 * 1024 * 1024;
const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);

export function parseMetalink(xml: string, meta4Url?: string): Metalink {
  const doc = parseXml(xml);
  const file = descendants(doc, "file")[0];
  if (!file) throw new Error("the metalink names no file");
  const name = attr(file, "name");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zim$/.test(name)) throw new Error("the metalink's file name is not a plain archive name");
  const size = Number(text(child(file, "size")));
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("the metalink gives no size");
  const sha256 = children(file, "hash").find((h) => attr(h, "type").toLowerCase() === "sha-256");
  const sum = text(sha256).toLowerCase();
  if (!HEX(64).test(sum)) throw new Error("the metalink gives no SHA-256");
  const piecesEl = children(file, "pieces").find((p) => attr(p, "type").toLowerCase() === "sha-1");
  let pieceLength = 0;
  let pieces: string[] = [];
  if (piecesEl) {
    pieceLength = Number(attr(piecesEl, "length"));
    pieces = children(piecesEl, "hash").map((h) => text(h).toLowerCase());
    const expected = pieceLength > 0 ? Math.ceil(size / pieceLength) : -1;
    // Pieces that do not cover the file exactly cannot be checked one by one; the whole file's SHA-256 still is.
    if (!Number.isSafeInteger(pieceLength) || pieceLength < 1024 || pieces.length !== expected || !pieces.every((p) => HEX(40).test(p))) { pieceLength = 0; pieces = []; }
  }
  const mirrors = children(file, "url")
    .map((u, i) => ({ href: text(u), priority: Number(attr(u, "priority")) || 1000 + i, i }))
    .filter((u) => /^https:\/\//i.test(u.href) && validUrl(u.href))
    .sort((a, b) => a.priority - b.priority || a.i - b.i)
    .map((u) => u.href);
  // download.kiwix.org itself last: the metalink's own address without ".meta4" (it sends the file or a mirror).
  if (meta4Url) {
    try {
      const u = new URL(meta4Url);
      const home = `https://download.kiwix.org${u.pathname.replace(/\.meta4$/, "")}`;
      if (!mirrors.includes(home)) mirrors.push(home);
    } catch { /* no fallback */ }
  }
  if (!mirrors.length) throw new Error("the metalink lists no https mirror");
  return { file: name, size, sha256: sum, pieceLength, pieces, urls: mirrors.slice(0, 12) };
}

function validUrl(href: string): boolean {
  try { const u = new URL(href); return u.protocol === "https:" && !!u.hostname && !u.username && !u.password; } catch { return false; }
}

export async function fetchMetalink(fetchFn: typeof fetch, url: string, timeoutMs = 30_000): Promise<Metalink> {
  const res = await fetchFromKiwix(fetchFn, url, timeoutMs, "application/metalink4+xml");
  if (!res.ok) throw new Error(`metalink answered ${res.status}`);
  return parseMetalink(await readCapped(res, MAX_META4_BYTES), url);
}
