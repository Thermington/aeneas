import { fmtBytes } from "./time";

/**
 * The offline reference (module `reference`, CONTRACT "Offline reference"): the hub's answers as types, and the parts of
 * the Reference screen, its reader and Settings, Reference that need no browser, so they can be tested.
 */

// ---------- What the hub answers ----------

/** A title (suggest) or a search result. `snippet` is HTML with only `<b>` kept. */
export interface RefHit { book: string; source: string; lang: string; title: string; path: string; snippet?: string; kind?: "title" | "text"; words?: number }
export interface RefSuggestAnswer { q: string; results: RefHit[] }
export interface RefSearchAnswer { q: string; results: RefHit[]; total: number; took_ms: number; partial: boolean }
export interface RefTocEntry { level: number; id: string; text: string }
export interface RefArticle {
  book: string; source: string; lang: string; title: string; path: string;
  html: string; toc: RefTocEntry[]; date: string; url?: string | null; license: string;
}
export interface RefSummary { title: string; text: string; media?: string | null }
export interface RefRandom { book: string; path: string; title: string }
export interface RefBook {
  name: string; flavour: string; lang: string; source: string; title: string; date: string; bytes: number; articles: number;
  fulltext: boolean; file: string; state: "ready" | "update" | "removing";
}
export type RefDownloadState = "queued" | "downloading" | "verifying" | "paused" | "waiting" | "failed";
export interface RefDownload {
  name: string; flavour: string; lang: string; source: string; title: string; date: string;
  bytes: number; done_bytes: number; speed_bps: number | null; eta_s: number | null;
  state: RefDownloadState; reason?: string; error?: string;
}
export interface RefPlan { wanted_bytes: number; to_download_bytes: number; free_bytes: number; fits: boolean }
export type RefReaderState = "off" | "installing" | "starting" | "ready" | "failed";
export interface RefStatus {
  on: boolean; reader: { state: RefReaderState; error?: string }; books: RefBook[]; downloads: RefDownload[];
  plan: RefPlan; next_check: string | null;
}
export interface RefOverride { images?: boolean; languages?: string[] }
export interface RefSettings {
  sources: string[]; languages: string[]; images: boolean; wikipedia: "intros" | "text";
  overrides: Record<string, RefOverride>; schedule: "nights" | "any"; max_mbps: number | null;
}
export interface RefCatalogBook { name: string; flavour: string; images: boolean; bytes: number; date: string; articles: number }
export interface RefLanguage { code: string; tag: string; name: string; native: string; books: RefCatalogBook[] }
export interface RefSource { id: string; title: string; summary: string; group: string; license: string; languages: RefLanguage[] }
export interface RefSources { checked_at: string | null; sources: RefSource[] }

/** The contract's defaults: nothing chosen, English, no pictures, all of Wikipedia's text, updates at night, no cap. */
export const DEFAULT_SETTINGS: RefSettings = { sources: [], languages: ["eng"], images: false, wikipedia: "text", overrides: {}, schedule: "nights", max_mbps: null };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);

/** The choices and the plan from GET or PUT /reference/settings, whether the hub nests them under `settings` or not. */
export function readSettings(answer: unknown): { settings: RefSettings; plan: RefPlan | null } {
  const top = isObj(answer) ? answer : {};
  const s = isObj(top.settings) ? top.settings : top;
  const overrides: Record<string, RefOverride> = {};
  if (isObj(s.overrides)) {
    for (const [id, o] of Object.entries(s.overrides)) {
      if (!isObj(o)) continue;
      const one: RefOverride = {};
      if (typeof o.images === "boolean") one.images = o.images;
      const langs = strings(o.languages);
      if (langs) one.languages = langs;
      overrides[id] = one;
    }
  }
  const settings: RefSettings = {
    sources: strings(s.sources) ?? DEFAULT_SETTINGS.sources,
    languages: strings(s.languages) ?? DEFAULT_SETTINGS.languages,
    images: typeof s.images === "boolean" ? s.images : DEFAULT_SETTINGS.images,
    wikipedia: s.wikipedia === "intros" ? "intros" : "text",
    overrides,
    schedule: s.schedule === "any" ? "any" : "nights",
    max_mbps: typeof s.max_mbps === "number" && s.max_mbps > 0 ? s.max_mbps : null,
  };
  const p = isObj(top.plan) ? top.plan : null;
  const plan = p && typeof p.wanted_bytes === "number" ? (p as unknown as RefPlan) : null;
  return { settings, plan };
}

// ---------- Addresses ----------

export const REFERENCE = "/reference";

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** A link's page path split from the section it names: `Fever#Causes` is the page `Fever` at `Causes`. */
export function splitAnchor(path: string): { path: string; anchor: string | null } {
  const i = path.indexOf("#");
  return i < 0 ? { path, anchor: null } : { path: path.slice(0, i), anchor: path.slice(i + 1) || null };
}

/** The reader's address for a page: `/reference/<book>/<path>`, each URL-encoded, with `?at=` for a section. */
export function readerPath(book: string, path: string, anchor?: string | null): string {
  const base = `${REFERENCE}/${encodeURIComponent(book)}/${encodeURIComponent(path)}`;
  return anchor ? `${base}?at=${encodeURIComponent(anchor)}` : base;
}

/**
 * The page a hash path opens in the reader, or null for the search screen. The page path may come with its slashes
 * encoded (`A%2FFever`) or not (`A/Fever`); a section comes as `?at=` or, from a link, after a `#`.
 */
export function readerRoute(hashPath: string, params?: URLSearchParams | null): { book: string; path: string; anchor: string | null } | null {
  const raw = hashPath.replace(/^#/, "").split("?")[0];
  if (!raw.startsWith(`${REFERENCE}/`)) return null;
  const rest = raw.slice(REFERENCE.length + 1);
  const cut = rest.indexOf("/");
  if (cut <= 0) return null;
  const book = decode(rest.slice(0, cut));
  const page = splitAnchor(decode(rest.slice(cut + 1)));
  if (!book || !page.path) return null;
  return { book, path: page.path, anchor: params?.get("at") || page.anchor };
}

/** What a link inside an article does: open a page in the reader, jump within the page, leave for the internet, or nothing. */
export type LinkKind = "reader" | "anchor" | "external" | "none";

export function linkKind(href: string | null | undefined, a: { book?: string | null; path?: string | null; external?: boolean }): LinkKind {
  if (a.book && a.path) return "reader";
  const h = (href ?? "").trim();
  if (a.external) return /^https?:\/\/[^\s]/i.test(h) ? "external" : "none";
  if (h.startsWith(`#${REFERENCE}/`)) return "reader";
  if (h.startsWith("#") && h.length > 1 && !h.startsWith("#/")) return "anchor";
  return "none";
}

/**
 * Wikipedia's own classes that the reader styles, each under a name of its own so a page can never pick up one of the
 * app's (a page's `tabs` or `thumb` would otherwise take the app's rules). Every other class is dropped.
 */
export const CLASS_MAP: Record<string, string> = {
  infobox: "rx-infobox", sidebar: "rx-infobox", "vertical-navbox": "rx-infobox",
  wikitable: "rx-wikitable",
  navbox: "rx-navbox",
  thumb: "rx-thumb", tright: "rx-right", tleft: "rx-left", floatright: "rx-right", floatleft: "rx-left", thumbcaption: "rx-caption",
  hatnote: "rx-hatnote", dablink: "rx-hatnote",
  reflist: "rx-refs", references: "rx-refs", "mw-references-wrap": "rx-refs",
  ambox: "rx-note",
  quotebox: "rx-quote",
  gallery: "rx-gallery", gallerybox: "rx-gallerybox",
  "mwe-math-mathml-a11y": "rx-sr", "mw-empty-elt": "rx-hidden",
  "mwe-math-fallback-image-inline": "rx-math", "mwe-math-fallback-image-display": "rx-math-block",
};

/** A class attribute with only the classes the reader styles, renamed (CLASS_MAP); empty when none is left. */
export function mapClasses(value: string | null | undefined): string {
  const out = new Set<string>();
  for (const c of (value ?? "").split(/\s+/)) {
    const m = CLASS_MAP[c];
    if (m) out.add(m);
  }
  return [...out].join(" ");
}

// ---------- Search ----------

export interface SnippetPart { text: string; bold: boolean }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function fromCode(n: number, fallback: string): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : fallback;
}

/** Character references in text, as the characters they stand for; unknown ones stay as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return fromCode(parseInt(k.slice(2), 16), m);
    if (k.startsWith("#")) return fromCode(parseInt(k.slice(1), 10), m);
    return ENTITIES[k] ?? m;
  });
}

/**
 * A search snippet as plain text runs, bold where the hub put `<b>`: the screen builds its own nodes from these and
 * never inserts the hub's string as markup. Any other tag is dropped, its text kept.
 */
export function snippetParts(html: string | null | undefined): SnippetPart[] {
  const src = html ?? "";
  const out: SnippetPart[] = [];
  const push = (raw: string, bold: boolean) => {
    if (!raw) return;
    const text = decodeEntities(raw);
    const last = out[out.length - 1];
    if (last && last.bold === bold) last.text += text;
    else out.push({ text, bold });
  };
  let depth = 0;
  let at = 0;
  for (const m of src.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?\/?>/g)) {
    push(src.slice(at, m.index), depth > 0);
    at = (m.index ?? 0) + m[0].length;
    const name = (m[2] ?? "").toLowerCase();
    if (name === "b" || name === "strong") depth = m[1] ? Math.max(0, depth - 1) : depth + 1;
  }
  push(src.slice(at), depth > 0);
  return out;
}

/** Which answer a result list shows: titles first (suggest), then the full results (search) of the same query. */
export type Stage = "suggest" | "search";
const STAGE_RANK: Record<Stage, number> = { suggest: 1, search: 2 };
export interface Shown { gen: number; stage: Stage | null }

/**
 * Whether an answer may replace the results on screen. Each query (and each change of the chips) gets a newer `gen`;
 * an answer belongs on screen only while its query is the newest (`current`), so an older query's answer that comes in
 * late is dropped, and titles never replace the full results already shown for that same query.
 */
export function mayShow(current: number, shown: Shown, incoming: { gen: number; stage: Stage }): boolean {
  if (incoming.gen !== current) return false;
  if (shown.gen === incoming.gen && shown.stage && STAGE_RANK[shown.stage] > STAGE_RANK[incoming.stage]) return false;
  return true;
}

/** Whether a page of more results continues the list on screen: the newest query's full results, from where they end. */
export function mayAppend(current: number, shown: Shown, count: number, page: { gen: number; offset: number }): boolean {
  return page.gen === current && shown.gen === current && shown.stage === "search" && page.offset === count;
}

export const hitKey = (h: Pick<RefHit, "book" | "path">) => `${h.book}\n${h.path}`;

/** A list with more results after it, each page only once. */
export function appendHits(list: RefHit[], more: RefHit[]): RefHit[] {
  const seen = new Set(list.map(hitKey));
  const out = [...list];
  for (const h of more) {
    if (seen.has(hitKey(h))) continue;
    seen.add(hitKey(h));
    out.push(h);
  }
  return out;
}

/** Results from the chosen sources and languages only (none chosen: all). Titles come unfiltered from the hub. */
export function filterHits(hits: RefHit[], sources: string[], langs: string[]): RefHit[] {
  return hits.filter((h) => (!sources.length || sources.includes(h.source)) && (!langs.length || langs.includes(h.lang)));
}

/** The result Enter opens when none is picked: a title that is the query (letter case and accents aside), else the first. */
export function bestHit(hits: Pick<RefHit, "title">[], query: string): number {
  if (!hits.length) return -1;
  const q = foldText(query).trim();
  const i = hits.findIndex((h) => foldText(h.title).trim() === q);
  return i >= 0 ? i : 0;
}

/** Names in a few words: "A", "A and B", "A, B and 2 more". */
export function shortList(names: string[]): string {
  const t = [...new Set(names)];
  if (t.length <= 2) return joinWords(t);
  return `${t[0]}, ${t[1]} and ${t.length - 2} more`;
}

/** The search field's hint, naming what it searches. */
export function searchPlaceholder(titles: string[]): string {
  return titles.length ? `Search ${shortList(titles)}` : "Search";
}

// ---------- Find in page ----------

const foldCache = new Map<string, string>();

/** One UTF-16 unit in lower case without its accent, still one unit, so offsets in folded text are offsets in the page. */
export function foldChar(c: string): string {
  const code = c.charCodeAt(0);
  if (code < 128) {
    if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
    return code === 9 || code === 10 || code === 12 || code === 13 ? " " : c;
  }
  let f = foldCache.get(c);
  if (f === undefined) {
    if (/\s/.test(c)) f = " ";
    else {
      const lower = c.toLowerCase();
      const base = lower.normalize("NFD").replace(/[̀-ͯ]/g, "");
      f = base.length === 1 ? base : lower.length === 1 ? lower : c;
    }
    foldCache.set(c, f);
  }
  return f;
}

/** Text folded unit by unit (foldChar): the same length as what it came from. */
export function foldText(s: string): string {
  const out: string[] = new Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = foldChar(s[i]);
  return out.join("");
}

/** Part of one match inside one text node. */
export interface MatchPiece { node: number; start: number; end: number }

/** Where a folded query matches at `at` in folded text: a space in the query stands for any run of spaces. */
function matchEnd(hay: string, at: number, q: string): number {
  let k = at;
  for (let j = 0; j < q.length; j++) {
    if (q[j] === " ") {
      if (hay[k] !== " ") return -1;
      while (hay[k] === " ") k++;
    } else {
      if (hay[k] !== q[j]) return -1;
      k++;
    }
  }
  return k;
}

/**
 * Find in page: every match of the query in a page's text, read as one run of text across its text nodes (`texts`),
 * ignoring letter case and accents, a space matching any run of spaces. Each match is the pieces of it in each node it
 * spans, in page order, at most `limit` matches.
 */
export function findMatches(texts: string[], query: string, limit = 500): MatchPiece[][] {
  const q = foldText(query).trim().replace(/ +/g, " ");
  if (!q) return [];
  const starts: number[] = [];
  let total = 0;
  for (const t of texts) { starts.push(total); total += t.length; }
  const hay = foldText(texts.join(""));
  const out: MatchPiece[][] = [];
  let node = 0;
  let i = 0;
  while (i < hay.length && out.length < limit) {
    const at = hay.indexOf(q[0], i);
    if (at < 0) break;
    const end = matchEnd(hay, at, q);
    if (end < 0) { i = at + 1; continue; }
    while (node < texts.length - 1 && starts[node] + texts[node].length <= at) node++;
    const pieces: MatchPiece[] = [];
    for (let n = node; n < texts.length && starts[n] < end; n++) {
      const a = Math.max(at, starts[n]) - starts[n];
      const b = Math.min(end, starts[n] + texts[n].length) - starts[n];
      if (b > a) pieces.push({ node: n, start: a, end: b });
    }
    out.push(pieces);
    i = end;
  }
  return out;
}

/** "3 of 17", "No matches", or "3 of 500+" when the page has more than the count kept. */
export function findCountText(current: number, count: number, limit = 500): string {
  if (!count) return "No matches";
  return `${current + 1} of ${count}${count >= limit ? "+" : ""}`;
}

// ---------- On this device: pages read, where reading stopped, text size ----------

/** A page read on this device, for Continue reading. `source` is the name shown for its book. */
export interface RecentPage { book: string; path: string; title: string; source: string; lang: string; at: string }
export const RECENT_MAX = 30;

/** The list with a page read now at its top: once each, newest first, at most `max`. */
export function addRecent(list: RecentPage[], page: RecentPage, max = RECENT_MAX): RecentPage[] {
  return [page, ...list.filter((p) => p.book !== page.book || p.path !== page.path)].slice(0, max);
}

/** The kept list, with anything unreadable left out. */
export function parseRecent(raw: string | null | undefined, max = RECENT_MAX): RecentPage[] {
  let v: unknown;
  try { v = JSON.parse(raw ?? "[]"); } catch { return []; }
  if (!Array.isArray(v)) return [];
  let out: RecentPage[] = [];
  for (const x of v) {
    if (!isObj(x) || typeof x.book !== "string" || typeof x.path !== "string" || !x.book || !x.path) continue;
    const page: RecentPage = {
      book: x.book, path: x.path, title: typeof x.title === "string" && x.title ? x.title : x.path,
      source: typeof x.source === "string" ? x.source : "", lang: typeof x.lang === "string" ? x.lang : "", at: typeof x.at === "string" ? x.at : "",
    };
    if (!out.some((p) => p.book === page.book && p.path === page.path)) out = [...out, page];
  }
  return out.slice(0, max);
}

/** Where reading stopped, per page: a fraction of the page's height, and when. */
export type Positions = Record<string, { f: number; at: number }>;
export const POSITIONS_MAX = 300;
export const pageKey = (book: string, path: string) => `${book}/${path}`;

/** The positions with one page's updated; the oldest go past `max`. */
export function keepPosition(map: Positions, key: string, fraction: number, now = Date.now(), max = POSITIONS_MAX): Positions {
  const f = Math.round(Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * 10_000) / 10_000;
  const next: Positions = { ...map, [key]: { f, at: now } };
  const keys = Object.keys(next);
  if (keys.length <= max) return next;
  keys.sort((a, b) => next[a].at - next[b].at);
  for (const k of keys.slice(0, keys.length - max)) delete next[k];
  return next;
}

export function parsePositions(raw: string | null | undefined): Positions {
  let v: unknown;
  try { v = JSON.parse(raw ?? "{}"); } catch { return {}; }
  const out: Positions = {};
  if (!isObj(v)) return out;
  for (const [k, p] of Object.entries(v)) {
    if (isObj(p) && typeof p.f === "number" && typeof p.at === "number") out[k] = { f: Math.min(1, Math.max(0, p.f)), at: p.at };
  }
  return out;
}

/** Reading text sizes in pixels; Smaller and Larger step through them. */
export const TEXT_SIZES = [14, 15, 16, 17, 18, 20, 22, 25, 28];
export const TEXT_SIZE_DEFAULT = 17;

/** The next size up or down from any size; the ends stay where they are. */
export function stepTextSize(size: number, step: 1 | -1): number {
  if (step > 0) return TEXT_SIZES.find((s) => s > size) ?? TEXT_SIZES[TEXT_SIZES.length - 1];
  return [...TEXT_SIZES].reverse().find((s) => s < size) ?? TEXT_SIZES[0];
}

// ---------- Words for people ----------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** An archive's date (`2024-01-15`, or a month) as "January 15, 2024" (long) or "Jan 2024" (short); anything else as given. */
export function archiveDate(date: string | null | undefined, style: "long" | "short" = "short"): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(date ?? "");
  if (!m) return date ?? "";
  const month = Number(m[2]);
  if (month < 1 || month > 12) return date ?? "";
  const name = MONTHS[month - 1];
  if (style === "short") return `${name.slice(0, 3)} ${m[1]}`;
  return m[3] ? `${name} ${Number(m[3])}, ${m[1]}` : `${name} ${m[1]}`;
}

/** Copy citation: `<title>. <source title>, offline copy of <archive date>.` and the page's original address when it has one. */
export function citationText(a: Pick<RefArticle, "title" | "date" | "url">, sourceTitle: string): string {
  const title = a.title.trim();
  const end = /[.!?]$/.test(title) ? "" : ".";
  return `${title}${end} ${sourceTitle}, offline copy of ${archiveDate(a.date, "long")}.${a.url ? ` ${a.url}` : ""}`;
}

/** The first message of an Ask about this page chat, as the hub's guide reads it. */
export function askAboutText(a: Pick<RefArticle, "title" | "book" | "path">, sourceTitle: string): string {
  return `Ask about "${a.title}" (${sourceTitle}, reference ${a.book}/${a.path}): `;
}

/**
 * The Assistant's handoff (sessionStorage): `{ session, text }`, a new chat to open with its first message typed in.
 * The Assistant reads it once for that chat and removes it.
 */
export const ASSISTANT_DRAFT_KEY = "ea.assistantDraft";

const languageNames: Record<string, string> = {};

/** A language code from Kiwix (`eng`, or several as `eng,fra`) in English words. */
export function languageName(code: string | null | undefined): string {
  const c = (code ?? "").trim();
  if (!c) return "";
  if (c.includes(",")) return joinWords(c.split(",").map((x) => languageName(x)).filter(Boolean));
  if (languageNames[c]) return languageNames[c];
  let name = c;
  try {
    const n = new Intl.DisplayNames(["en"], { type: "language" }).of(c);
    if (n && n.toLowerCase() !== c.toLowerCase()) name = n;
  } catch { /* not a language code */ }
  languageNames[c] = name;
  return name;
}

/** A Kiwix language code as a page's `lang` attribute (`eng` is `en`); undefined when it is not one. */
export function languageTag(code: string | null | undefined): string | undefined {
  const c = (code ?? "").split(",")[0].trim();
  if (!c || c === "mul") return undefined;
  try { return Intl.getCanonicalLocales(c)[0]; } catch { return undefined; }
}

/** "a", "a and b", "a, b and c". */
export function joinWords(xs: string[]): string {
  return xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** "1 article", "6,812,345 articles". */
export function countText(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${Math.max(0, Math.round(n)).toLocaleString("en-US")} ${many}`;
}

/** A size for people: "97 GB", "820 MB"; "size unknown" when the hub does not say. */
export function sizeText(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "size unknown";
  return fmtBytes(bytes);
}

/** A download speed, given in bits per second (like the cap, `max_mbps`), as "32 Mbps" or "640 kbps". */
export function speedText(bitsPerSecond: number | null | undefined): string {
  if (typeof bitsPerSecond !== "number" || !Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return "";
  if (bitsPerSecond < 1_000_000) return `${Math.max(1, Math.round(bitsPerSecond / 1000))} kbps`;
  const m = bitsPerSecond / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} Mbps`;
}

/** Time left as "about 40 min left"; empty when the hub cannot tell. */
export function etaText(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return "under a minute left";
  const min = Math.round(seconds / 60);
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  if (h < 48) return `about ${h} h${min % 60 ? ` ${min % 60} min` : ""} left`;
  return `about ${Math.round(h / 24)} days left`;
}

/** How much of a download is done, 0 to 100. */
export function percentDone(d: Pick<RefDownload, "bytes" | "done_bytes">): number {
  if (!d.bytes || d.bytes <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((d.done_bytes / d.bytes) * 100)));
}

/** "1.2 GB of 9.8 GB, 32 Mbps, about 40 min left". */
export function progressText(d: Pick<RefDownload, "bytes" | "done_bytes" | "speed_bps" | "eta_s" | "state">): string {
  const parts = [`${sizeText(d.done_bytes)} of ${sizeText(d.bytes)}`];
  if (d.state === "downloading") {
    const s = speedText(d.speed_bps);
    const t = etaText(d.eta_s);
    if (s) parts.push(s);
    if (t) parts.push(t);
  }
  return parts.join(", ");
}

const WAITING: Record<string, string> = {
  night: "Waits for the night, between 01:00 and 07:00 on the hub",
  game: "Waits while a game is running",
  disk: "Waits for room on the hub's disk",
  offline: "No download server answers. It tries again later",
  module: "Waits while Reference is switched off",
};

/** What a download is doing, in words. */
export function downloadStateText(d: Pick<RefDownload, "state" | "reason" | "error">): string {
  switch (d.state) {
    case "queued": return "Waiting its turn";
    case "downloading": return "Downloading";
    case "verifying": return "Checking the file";
    case "paused": return "Paused";
    case "waiting": return (d.reason && WAITING[d.reason]) || "Waiting";
    case "failed": return d.error ? `Failed: ${d.error}` : "Failed";
    default: return "";
  }
}

/** What kind of copy a book is, in words; empty for a source that has only one kind. */
export function flavourText(flavour: string): string {
  return flavour === "maxi" ? "with pictures" : flavour === "nopic" ? "text only" : flavour === "mini" ? "intros only" : "";
}

/** The Settings row under Reference: what is on the hub and what is downloading. */
export function settingsSummary(status: Pick<RefStatus, "books" | "downloads"> | null | undefined): string {
  if (!status) return "Wikipedia and more, kept on the hub";
  const ready = readyBooks(status);
  const names = shortList([...new Set(ready.map((b) => sourceTitle(ready, b.source)))]);
  const moving = (status.downloads ?? []).filter((d) => d.state === "downloading" || d.state === "verifying").length;
  return [names || "Nothing downloaded yet", moving ? `${moving} downloading` : ""].filter(Boolean).join(", ");
}

/** Whether downloads are moving, so Settings asks the hub every 2 seconds instead of now and then. */
export function downloadsRunning(status: Pick<RefStatus, "downloads"> | null | undefined): boolean {
  return !!status?.downloads.some((d) => d.state === "downloading" || d.state === "verifying" || d.state === "queued");
}

/** The total against free space, in short sentences, and how full the bar under it is (0 to 1). */
export function planText(plan: RefPlan): { lines: string[]; fits: boolean; share: number } {
  const lines = [`Your choices take ${sizeText(plan.wanted_bytes)}.`];
  lines.push(plan.to_download_bytes > 0 ? `${sizeText(plan.to_download_bytes)} of it is still to download.` : plan.wanted_bytes > 0 ? "All of it is downloaded." : "Nothing to download.");
  lines.push(`The hub has ${sizeText(plan.free_bytes)} free.`);
  if (!plan.fits) lines.push("Not enough room, so downloads wait. Pick fewer sources or languages, or turn pictures off.");
  const share = plan.free_bytes > 0 ? Math.min(1, Math.max(0, plan.to_download_bytes / plan.free_bytes)) : plan.to_download_bytes > 0 ? 1 : 0;
  return { lines, fits: plan.fits, share };
}

// ---------- What the choices download ----------

export const WIKIPEDIA = "wikipedia";

/** The languages a source is wanted in: its own override, else the chosen ones. */
export function languagesFor(sourceId: string, s: RefSettings): string[] {
  return s.overrides[sourceId]?.languages ?? s.languages;
}

/** Whether a source comes with pictures under the choices (its override, else the setting for all). */
export function imagesFor(sourceId: string, s: RefSettings): boolean {
  return s.overrides[sourceId]?.images ?? s.images;
}

/**
 * The one book wanted for a source in one language, as the hub picks it: with pictures (`maxi`) when they are on for it
 * and it exists, else text only (`nopic`), else the only kind there is; Wikipedia's intros (`mini`) when Wikipedia is set
 * to intros, where pictures do not apply. The newest of a kind.
 */
export function wantedBook(sourceId: string, lang: Pick<RefLanguage, "books">, s: RefSettings): RefCatalogBook | null {
  const newest = (f: string) => lang.books.filter((b) => b.flavour === f).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
  if (sourceId === WIKIPEDIA && s.wikipedia === "intros") {
    const mini = newest("mini");
    if (mini) return mini;
  } else if (imagesFor(sourceId, s)) {
    const maxi = newest("maxi");
    if (maxi) return maxi;
  }
  const nopic = newest("nopic");
  if (nopic) return nopic;
  // Else the only kind there is, or the smaller of the kinds left (mdwiki's pictures and its larger one with videos),
  // as the hub picks (hub/src/reference/plan.ts, pickFlavour).
  const kinds = [...new Set(lang.books.map((b) => b.flavour))];
  const rest = kinds.filter((f) => f !== "mini").map(newest).filter((b): b is RefCatalogBook => !!b).sort((a, b) => a.bytes - b.bytes);
  return rest[0] ?? (kinds.length ? newest(kinds[0]) : undefined) ?? null;
}

/** The books a source would download under the choices, one per wanted language it has. */
export function wantedBooks(source: Pick<RefSource, "id" | "languages">, s: RefSettings): RefCatalogBook[] {
  const out: RefCatalogBook[] = [];
  for (const code of languagesFor(source.id, s)) {
    const lang = source.languages.find((l) => l.code === code);
    const b = lang && wantedBook(source.id, lang, s);
    if (b) out.push(b);
  }
  return out;
}

/** A source's size under the choices; null when it has none of the wanted languages. */
export function wantedBytes(source: Pick<RefSource, "id" | "languages">, s: RefSettings): number | null {
  const books = wantedBooks(source, s);
  return books.length ? books.reduce((n, b) => n + (b.bytes || 0), 0) : null;
}

/** The groups in the contract's order; one the hub adds later goes after them. */
export const GROUPS = ["Encyclopedias", "Dictionaries and travel", "Medicine", "Practical", "Questions and answers", "Learning", "Books", "Technical"];

export function groupSources(list: RefSource[]): Array<{ group: string; sources: RefSource[] }> {
  const names = [...new Set([...GROUPS, ...list.map((x) => x.group)])];
  return names.map((group) => ({ group, sources: list.filter((x) => x.group === group) })).filter((g) => g.sources.length);
}

/** A language any source has, with how many sources have it. */
export interface LanguageChoice { code: string; tag: string; name: string; native: string; sources: number }

export function allLanguages(sources: RefSource[]): LanguageChoice[] {
  const by = new Map<string, LanguageChoice>();
  for (const src of sources) {
    for (const l of src.languages) {
      const had = by.get(l.code);
      if (had) had.sources++;
      else by.set(l.code, { code: l.code, tag: l.tag, name: l.name || languageName(l.code), native: l.native, sources: 1 });
    }
  }
  return [...by.values()].sort((a, b) => b.sources - a.sources || a.name.localeCompare(b.name));
}

/** The languages whose English or own name, or code, has the words typed (letter case and accents aside). */
export function matchLanguages(list: LanguageChoice[], query: string): LanguageChoice[] {
  const q = foldText(query).trim();
  if (!q) return list;
  return list.filter((l) => [l.name, l.native, l.code, l.tag].some((x) => foldText(x ?? "").includes(q)));
}

// ---------- Books on the hub, for the search screen ----------

/** The books search reads: ready, or ready with a newer copy on its way. */
export function readyBooks(status: Pick<RefStatus, "books"> | null | undefined): RefBook[] {
  return (status?.books ?? []).filter((b) => b.state === "ready" || b.state === "update");
}

/** The name shown for a book's source: the book's title, else its source's id. */
export function bookTitle(books: RefBook[], book: string, sourceId = ""): string {
  const b = books.find((x) => x.name === book);
  return b?.title || sourceTitle(books, sourceId || b?.source || "") || book;
}

/** The name shown for a source: the title of its English book if it has one, else of its first; else its id. */
export function sourceTitle(books: RefBook[], sourceId: string): string {
  const of = books.filter((b) => b.source === sourceId);
  const b = of.find((x) => x.lang === "eng") ?? of[0];
  return b?.title || (sourceId ? sourceId.charAt(0).toUpperCase() + sourceId.slice(1) : "");
}

/** The chips that narrow a search: one per source, and one per language, of the ready books. */
export function searchChips(books: RefBook[]): { sources: Array<{ id: string; label: string }>; langs: Array<{ code: string; label: string }> } {
  const sources = [...new Set(books.map((b) => b.source))].map((id) => ({ id, label: sourceTitle(books, id) }));
  const langs = [...new Set(books.map((b) => b.lang))].map((code) => ({ code, label: languageName(code) }));
  return { sources, langs };
}
