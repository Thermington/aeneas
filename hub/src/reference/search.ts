import { isLanguageName } from "./languages.js";
import { snippetHtml } from "./sanitize.js";
import type { TextHit, TitleHit } from "./kiwix.js";

/**
 * Search results from every ready book merged into one list (CONTRACT "Offline reference", Search): a title equal to
 * the query first (letter case and accents aside), then titles that start with it, then full-text results in the
 * reader's order, then other title matches; books in the owner's first language ahead of the others at each step;
 * pages that are another language's copy ("Mirrors (Magyar)") after everything else; one result per title and book.
 */

export interface BookRef { name: string; source: string; lang: string; langs: string[] }
export interface Hit { book: string; source: string; lang: string; title: string; path: string; snippet: string; kind: "title" | "text"; words?: number }

/** Letter case, accents, underscores and repeated spaces aside. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Languages written in the Latin alphabet (ISO 639-3), for the check below. */
const LATIN_LANGS = new Set(["eng", "fra", "deu", "spa", "por", "ita", "nld", "pol", "ces", "slk", "slv", "hrv", "bos", "ron", "hun", "fin", "est", "lav", "lit", "swe", "nor", "nob", "nno", "dan", "isl", "tur", "vie", "ind", "msa", "zsm", "tgl", "fil", "swa", "cat", "eus", "glg", "afr", "sqi", "mlt", "cym", "gle", "epo", "lat"]);
/** Two or more letters in a row from another script than Latin (marks between them allowed): a word in Cyrillic, Greek, Han... */
const OTHER_SCRIPT_WORD = /(?:(?!\p{Script=Latin})\p{L}\p{M}*){2,}/u;

/**
 * A page that is another language's copy of one: its title ends in a language's own name in parentheses, or, in a book
 * written in the Latin alphabet, it holds a word in another script ("Bluetooth клавиатура" in the English ArchWiki).
 */
export function isLanguageCopy(title: string, bookLangs: string[] = []): boolean {
  if (bookLangs.length && bookLangs.every((l) => LATIN_LANGS.has(l)) && OTHER_SCRIPT_WORD.test(title)) return true;
  const m = /\(([^()]{2,40})\)\s*$/.exec(title);
  if (!m || !isLanguageName(m[1])) return false;
  // "(English)" in an English book is not a copy from elsewhere.
  return !(bookLangs.includes("eng") && m[1].trim().toLowerCase() === "english");
}

export interface PerBook { book: BookRef; titles: TitleHit[]; texts: TextHit[] }

interface Ranked extends Hit { key: number[] }

/** Merge each book's title and text results; `firstLang` is the owner's first chosen language. */
export function rankResults(q: string, per: PerBook[], firstLang: string): Hit[] {
  const fq = fold(q);
  const best = new Map<string, Ranked>();
  const put = (h: Ranked) => {
    const id = `${h.book}\u0000${fold(h.title)}`;
    const had = best.get(id);
    if (!had) { best.set(id, h); return; }
    // The better place wins. A title result takes the text result's page for the same title: the title index also
    // holds redirects ("Bluetooth Headset" to "Bluetooth headset"), full text only real pages, with a snippet.
    const better = compare(h.key, had.key) < 0 ? h : had;
    const other = better === h ? had : h;
    if (!better.snippet && other.snippet) {
      better.snippet = other.snippet;
      better.path = other.path;
      better.title = other.title;
      if (other.words) better.words = other.words;
    }
    best.set(id, better);
  };
  per.forEach((p, bookOrder) => {
    const langRank = p.book.langs.includes(firstLang) ? 0 : 1;
    p.titles.forEach((t, i) => {
      const ft = fold(t.title);
      const tier = ft === fq ? 0 : ft.startsWith(fq) ? 1 : 3;
      const copy = isLanguageCopy(t.title, p.book.langs) ? 1 : 0;
      put({ book: p.book.name, source: p.book.source, lang: p.book.lang, title: t.title, path: t.path, snippet: "", kind: "title", key: [copy, tier, langRank, i, bookOrder] });
    });
    p.texts.forEach((t, i) => {
      const ft = fold(t.title);
      const copy = isLanguageCopy(t.title, p.book.langs) ? 1 : 0;
      // A text result whose title is the query, or starts with it, counts as that title.
      const tier = ft === fq ? 0 : ft.startsWith(fq) ? 1 : 2;
      put({ book: p.book.name, source: p.book.source, lang: p.book.lang, title: t.title, path: t.path, snippet: snippetHtml(t.snippet, 300), kind: tier < 2 ? "title" : "text", ...(t.words ? { words: t.words } : {}), key: [copy, tier, langRank, i, bookOrder] });
    });
  });
  return [...best.values()].sort((a, b) => compare(a.key, b.key)).map(({ key: _key, ...h }) => h);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** A small cache of recent answers: `max` entries, each kept `ttlMs`. */
export class AnswerCache<T> {
  private items = new Map<string, { at: number; value: T }>();
  constructor(private max = 50, private ttlMs = 60_000) {}
  get(key: string, now = Date.now()): T | undefined {
    const e = this.items.get(key);
    if (!e) return undefined;
    if (now - e.at > this.ttlMs) { this.items.delete(key); return undefined; }
    // Most recent last.
    this.items.delete(key);
    this.items.set(key, e);
    return e.value;
  }
  set(key: string, value: T, now = Date.now()): void {
    this.items.delete(key);
    this.items.set(key, { at: now, value });
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
  }
  clear(): void { this.items.clear(); }
}
