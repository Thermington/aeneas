import { StoreError } from "../store.js";
import type { CatalogBook } from "./catalog.js";
import { knownLanguage, language } from "./languages.js";
import { isSourceId, sourceOfBook, SOURCES, type Source } from "./sources.js";

/** The owner's choices (CONTRACT "Offline reference", Choices). */
export interface Settings {
  sources: string[];
  languages: string[];
  images: boolean;
  wikipedia: "intros" | "text";
  overrides: Record<string, { images?: boolean; languages?: string[] }>;
  schedule: "nights" | "any";
  max_mbps: number | null;
}

export const DEFAULT_SETTINGS: Settings = { sources: [], languages: ["eng"], images: false, wikipedia: "text", overrides: {}, schedule: "nights", max_mbps: null };

/** One book the plan wants: the flavour picked for it from the catalog. */
export interface Wanted {
  name: string;
  flavour: string;
  /** Its language (the site's own for an archive that also lists English), and every language it lists. */
  lang: string;
  langs: string[];
  source: string;
  title: string;
  date: string;
  updated: string;
  bytes: number;
  articles: number;
  fulltext: boolean;
  images: boolean;
  file: string;
  meta4: string;
}

const KEYS = ["sources", "languages", "images", "wikipedia", "overrides", "schedule", "max_mbps"];

const bad = (msg: string): never => { throw new StoreError(422, msg); };

function codes(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) bad(`${what} must be a list of language codes (ISO 639-3, like eng)`);
  const list = [...new Set((v as string[]).map((x) => x.trim().toLowerCase()))];
  const unknown = list.filter((x) => !knownLanguage(x));
  if (unknown.length) bad(`${what}: no source has ${unknown.slice(0, 5).join(", ")}; use ISO 639-3 codes like eng`);
  return list;
}

/** The settings with `input` applied, every value checked; a wrong type or an unknown id is 422. */
export function applySettings(current: Settings, input: Record<string, unknown>): Settings {
  const unknownKeys = Object.keys(input).filter((k) => !KEYS.includes(k));
  if (unknownKeys.length) bad(`unknown setting ${unknownKeys.join(", ")}; known: ${KEYS.join(", ")}`);
  const next: Settings = structuredClone(current);
  if ("sources" in input) {
    const v = input.sources;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) bad("sources must be a list of source ids");
    const unknown = (v as string[]).filter((x) => !isSourceId(x));
    if (unknown.length) bad(`no source named ${unknown.slice(0, 5).join(", ")}`);
    next.sources = [...new Set(v as string[])];
  }
  if ("languages" in input) next.languages = codes(input.languages, "languages");
  if ("images" in input) {
    if (typeof input.images !== "boolean") bad("images must be true or false");
    next.images = input.images as boolean;
  }
  if ("wikipedia" in input) {
    if (input.wikipedia !== "intros" && input.wikipedia !== "text") bad('wikipedia must be "intros" or "text"');
    next.wikipedia = input.wikipedia as "intros" | "text";
  }
  if ("schedule" in input) {
    if (input.schedule !== "nights" && input.schedule !== "any") bad('schedule must be "nights" or "any"');
    next.schedule = input.schedule as "nights" | "any";
  }
  if ("max_mbps" in input) {
    const v = input.max_mbps;
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100_000)) bad("max_mbps must be a number of megabits per second above 0, or null for no cap");
    next.max_mbps = v as number | null;
  }
  if ("overrides" in input) {
    const v = input.overrides;
    if (!v || typeof v !== "object" || Array.isArray(v)) bad("overrides must be an object of source ids");
    const out: Settings["overrides"] = {};
    for (const [id, o] of Object.entries(v as Record<string, unknown>)) {
      if (!isSourceId(id)) bad(`overrides: no source named ${id}`);
      if (!o || typeof o !== "object" || Array.isArray(o)) bad(`overrides.${id} must be an object with images or languages`);
      const extra = Object.keys(o as object).filter((k) => k !== "images" && k !== "languages");
      if (extra.length) bad(`overrides.${id}: unknown setting ${extra.join(", ")}`);
      const ov = o as { images?: unknown; languages?: unknown };
      const entry: { images?: boolean; languages?: string[] } = {};
      if (ov.images !== undefined) {
        if (typeof ov.images !== "boolean") bad(`overrides.${id}.images must be true or false`);
        entry.images = ov.images as boolean;
      }
      if (ov.languages !== undefined) entry.languages = codes(ov.languages, `overrides.${id}.languages`);
      if (Object.keys(entry).length) out[id] = entry;
    }
    next.overrides = out;
  }
  return next;
}

/** Settings read back from state.json: anything not valid falls back to the default, field by field. */
export function readSettings(v: unknown): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (!v || typeof v !== "object") return s;
  for (const k of KEYS) {
    if (!(k in (v as object))) continue;
    try { Object.assign(s, applySettings(s, { [k]: (v as Record<string, unknown>)[k] })); } catch { /* keeps the default */ }
  }
  return s;
}

/** The language a book is listed under: the site's own for an archive that also lists English (`eng,spa` is spa). */
export function mainLang(langs: string[]): string {
  return langs.find((l) => l !== "eng") ?? langs[0] ?? "";
}

/** For each chosen source: its languages and whether pictures are wanted. */
function choiceFor(s: Settings, source: Source): { langs: string[]; images: boolean } {
  const ov = s.overrides[source.id];
  return { langs: ov?.languages ?? s.languages, images: ov?.images ?? s.images };
}

/** Whether a book of this source in these languages is still chosen (the source on, one of its languages chosen). */
export function stillChosen(s: Settings, sourceId: string, langs: string[]): boolean {
  if (!s.sources.includes(sourceId)) return false;
  const source = SOURCES.find((x) => x.id === sourceId);
  if (!source) return false;
  const c = choiceFor(s, source);
  return langs.some((l) => c.langs.includes(l));
}

/**
 * The flavour wanted: `maxi` when pictures are wanted and there is one, else `nopic`, else the only kind there is
 * (the smaller when two are left, as mdwiki's `maxi` and its larger one with videos). Wikipedia's `mini` (the start of
 * each article) only when intros are chosen; then pictures do not count.
 */
export function pickFlavour(books: CatalogBook[], images: boolean, intros: boolean): CatalogBook | null {
  const by = (f: string) => books.find((b) => b.flavour === f);
  if (intros) { const mini = by("mini"); if (mini) return mini; }
  if (images && !intros) { const maxi = by("maxi"); if (maxi) return maxi; }
  const nopic = by("nopic");
  if (nopic) return nopic;
  const rest = books.filter((b) => b.flavour !== "mini").sort((a, b) => a.bytes - b.bytes);
  return rest[0] ?? books[0] ?? null;
}

interface Grouped { source: Source; pattern: string; segment: string | null; books: CatalogBook[] }

/** The catalog grouped by source and book name. */
export function groupCatalog(catalog: CatalogBook[]): Map<string, Grouped> {
  const out = new Map<string, Grouped>();
  for (const b of catalog) {
    const g = out.get(b.name);
    if (g) { g.books.push(b); continue; }
    const s = sourceOfBook(b.name);
    if (s) out.set(b.name, { ...s, books: [b] });
  }
  return out;
}

/**
 * The names of a source in one language. For a `{lang}` pattern one name: the one whose code in the name is the
 * language's tag (`wikipedia_en_all` for eng, not `wikipedia_en-simple_all`), else one without a variant, else the
 * first. Other patterns: every name in that language (each LibreTexts book, each DevDocs set).
 */
export function namesIn(groups: Grouped[], lang: string): Grouped[] {
  const inLang = groups.filter((g) => g.books.some((b) => b.langs.includes(lang)));
  const out: Grouped[] = [];
  const byPattern = new Map<string, Grouped[]>();
  for (const g of inLang) {
    if (g.segment === null) { out.push(g); continue; }
    byPattern.set(g.pattern, [...(byPattern.get(g.pattern) ?? []), g]);
  }
  const tag = language(lang).tag;
  for (const list of byPattern.values()) {
    const pick = list.find((g) => g.segment === tag) ?? list.find((g) => !g.segment!.includes("-")) ?? [...list].sort((a, b) => a.books[0].name.localeCompare(b.books[0].name))[0];
    out.push(pick);
  }
  return out.sort((a, b) => a.books[0].name.localeCompare(b.books[0].name));
}

/** Every book the settings want, in the sources' order: one flavour per name, names the owner removed left out. */
export function planBooks(s: Settings, catalog: CatalogBook[], dropped: ReadonlySet<string> = new Set()): Wanted[] {
  const groups = [...groupCatalog(catalog).values()];
  const out: Wanted[] = [];
  const seen = new Set<string>();
  for (const source of SOURCES) {
    if (!s.sources.includes(source.id)) continue;
    const c = choiceFor(s, source);
    const mine = groups.filter((g) => g.source.id === source.id);
    for (const lang of c.langs) {
      for (const g of namesIn(mine, lang)) {
        const name = g.books[0].name;
        if (seen.has(name) || dropped.has(name)) continue;
        const b = pickFlavour(g.books, c.images, source.id === "wikipedia" && s.wikipedia === "intros");
        if (!b) continue;
        seen.add(name);
        out.push({ name, flavour: b.flavour, lang: mainLang(b.langs), langs: b.langs, source: source.id, title: b.title, date: b.date, updated: b.updated, bytes: b.bytes, articles: b.articles, fulltext: b.fulltext, images: b.images, file: b.file, meta4: b.meta4 });
      }
    }
  }
  return out;
}

export interface SourceView {
  id: string; title: string; summary: string; group: string; license: string;
  languages: { code: string; tag: string; name: string; native: string; books: { name: string; flavour: string; images: boolean; bytes: number; date: string; articles: number }[] }[];
}

/** `GET /reference/sources`: every curated source with the books Kiwix has for it, by language. */
export function sourcesView(catalog: CatalogBook[]): SourceView[] {
  const groups = [...groupCatalog(catalog).values()];
  return SOURCES.map((source) => {
    const mine = groups.filter((g) => g.source.id === source.id);
    const codes = [...new Set(mine.flatMap((g) => g.books.flatMap((b) => b.langs)))];
    const languages = codes.map((code) => {
      const books = namesIn(mine, code).flatMap((g) => g.books)
        .sort((a, b) => a.name.localeCompare(b.name) || a.bytes - b.bytes)
        .map((b) => ({ name: b.name, flavour: b.flavour, images: b.images, bytes: b.bytes, date: b.date, articles: b.articles }));
      return { ...language(code), books };
    }).filter((l) => l.books.length).sort((a, b) => a.name.localeCompare(b.name));
    return { id: source.id, title: source.title, summary: source.summary, group: source.group, license: source.license, languages };
  });
}
