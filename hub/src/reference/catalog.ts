import { attr, child, children, descendants, parseXml, text } from "./xml.js";
import { sourceOfBook } from "./sources.js";
import { fetchFromKiwix, readCapped } from "./net.js";

/**
 * Kiwix's catalog (OPDS, Atom): every archive Kiwix publishes, read whole with no filter so the request says nothing
 * about the owner's choices, at most once a day, and kept (the curated sources' part) in state.json.
 */

export const CATALOG_URL = "https://library.kiwix.org/catalog/v2/entries?count=-1";
/** The whole catalog was 4.4 MB on 2026-11-16. */
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
export const CATALOG_TIMEOUT_MS = 120_000;

export interface CatalogBook {
  /** Kiwix's name for the book, the same for every flavour and date (`wikipedia_en_all`). */
  name: string;
  /** `maxi`, `nopic`, `mini` or empty. */
  flavour: string;
  /** ISO 639-3 codes, most often one (`eng`); a few archives hold two (`eng,spa`). */
  langs: string[];
  title: string;
  summary: string;
  tags: string[];
  articles: number;
  /** When this file was made, as Kiwix says (ISO time), and its day. */
  updated: string;
  date: string;
  /** The metalink that lists this file's mirrors and hashes. */
  meta4: string;
  /** The file's name (`wikipedia_en_all_nopic_2026-06.zim`) and size, as the catalog gives it. */
  file: string;
  bytes: number;
  images: boolean;
  fulltext: boolean;
}

/** Only metalinks from Kiwix's own download server (and its load balancer) are followed. */
export function kiwixDownloadUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === "https:" && (u.hostname === "download.kiwix.org" || u.hostname.endsWith(".download.kiwix.org")) && !u.username && !u.password && !u.port;
  } catch { return false; }
}

const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zim$/;

/** The catalog's books that can be downloaded: an https metalink on Kiwix's server and a plain file name. */
export function parseCatalog(xml: string): CatalogBook[] {
  const doc = parseXml(xml);
  const out: CatalogBook[] = [];
  for (const e of descendants(doc, "entry")) {
    const name = text(child(e, "name"));
    if (!name) continue;
    const acq = children(e, "link").find((l) => attr(l, "rel") === "http://opds-spec.org/acquisition/open-access");
    const meta4 = attr(acq, "href");
    if (!meta4 || !kiwixDownloadUrl(meta4) || !meta4.endsWith(".meta4")) continue;
    const file = decodeURIComponent(new URL(meta4).pathname.split("/").pop() ?? "").replace(/\.meta4$/, "");
    if (!FILE.test(file)) continue;
    const tags = text(child(e, "tags")).split(";").map((t) => t.trim()).filter(Boolean);
    const flavour = text(child(e, "flavour"));
    const updated = text(child(e, "updated"));
    const tag = (k: string) => tags.find((t) => t.startsWith(`${k}:`))?.slice(k.length + 1);
    const pictures = tag("_pictures");
    out.push({
      name, flavour, file,
      langs: text(child(e, "language")).split(",").map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2,3}$/.test(l)),
      title: text(child(e, "title")).slice(0, 200),
      summary: text(child(e, "summary")).slice(0, 500),
      tags,
      articles: Number(text(child(e, "articleCount"))) || 0,
      updated,
      date: /^\d{4}-\d\d-\d\d/.test(updated) ? updated.slice(0, 10) : "",
      meta4,
      bytes: Number(attr(acq, "length")) || 0,
      images: pictures ? pictures === "yes" : flavour !== "nopic" && flavour !== "mini",
      fulltext: tag("_ftindex") === "yes",
    });
  }
  return out;
}

/** The part of the catalog the curated sources use. */
export function curated(books: CatalogBook[]): CatalogBook[] { return books.filter((b) => !!sourceOfBook(b.name)); }

/** Read the whole catalog (one request, a hard time limit) and keep the curated sources' books. */
export async function fetchCatalog(fetchFn: typeof fetch, url = CATALOG_URL, timeoutMs = CATALOG_TIMEOUT_MS): Promise<CatalogBook[]> {
  const res = await fetchFromKiwix(fetchFn, url, timeoutMs, "application/atom+xml");
  if (!res.ok) throw new Error(`catalog answered ${res.status}`);
  const books = curated(parseCatalog(await readCapped(res, MAX_CATALOG_BYTES)));
  if (!books.length) throw new Error("the catalog named none of the sources");
  return books;
}
