import fs from "node:fs";
import path from "node:path";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { diskSpace } from "../diskspace.js";
import { gpuBusyNow, onThisMachine } from "../gpu.js";
import { dbJobClock, scheduleDaily } from "../schedule.js";
import { errCode } from "../logsafe.js";
import { CATALOG_URL, fetchCatalog, type CatalogBook } from "./catalog.js";
import { fetchMetalink, type Metalink } from "./metalink.js";
import { downloadArchive, partialDone, readPartial, removePartial } from "./download.js";
import { KiwixReader, readerMeta, readerRandom, readerRaw, readerSearch, readerSuggest, urlNameOf, type ReaderOptions, type TextHit, type TitleHit } from "./kiwix.js";
import { applySettings, DEFAULT_SETTINGS, planBooks, readSettings, sourcesView, stillChosen, type Settings, type Wanted } from "./plan.js";
import { AnswerCache, isLanguageCopy, rankResults, type Hit, type PerBook } from "./search.js";
import { cleanPage, MEDIA_TYPES, pageSummary, titleFromPath } from "./sanitize.js";
import { sourceById } from "./sources.js";
import { setReferenceReadiness } from "./ready.js";
import type { GetOptions, GetResponse } from "./net.js";

/**
 * The offline reference (module `reference`, CONTRACT "Offline reference"): Kiwix archives kept on the hub, downloaded,
 * checked and searched here, read on every device and by the assistant. Started by main.ts; returns its stop.
 *
 * `<reference>/state.json` holds the owner's choices, the books, the downloads and the cached catalog; `files/` the
 * archives in use; `partial/` a download in progress with its progress file; `bin/` the reader.
 */

const GB = 1024 ** 3;
/** Room a download keeps free besides its own size: 5 GB, plus the 2 GB the disk watch keeps (diskspace.ts). */
export const ROOM_BYTES = 7 * GB;
const DAY = 24 * 3_600_000;
const WEEK = 7 * DAY;
const SUGGEST_MS = 2000;
const SEARCH_MS = 2000;
const PAGE_MS = 8000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export type DownloadState = "queued" | "downloading" | "verifying" | "paused" | "waiting" | "failed";
export type WaitReason = "night" | "game" | "disk" | "offline" | "module";

/** A book kept in `files/`. `old_file` is the file it replaces, kept until the reader answers with the new one. */
export interface StoredBook {
  name: string; flavour: string; lang: string; langs: string[]; source: string; title: string; date: string; updated: string;
  bytes: number; articles: number; fulltext: boolean; images: boolean; file: string; state: "ready" | "removing"; old_file: string | null;
}
/**
 * Whether a download is an update: a newer file of the same book in the same kind, which waits for the night when updates
 * do. Pictures switched on or off, or Wikipedia to intros, is the owner's own choice and starts at once.
 */
export function isUpdate(books: Pick<StoredBook, "name" | "flavour" | "state">[], d: { name: string; flavour: string }): boolean {
  return books.some((b) => b.name === d.name && b.flavour === d.flavour && b.state === "ready");
}

/** A download in the queue; `failed` holds the reason it stopped until it is tried again. */
export interface StoredDownload {
  name: string; flavour: string; lang: string; langs: string[]; source: string; title: string; date: string; updated: string;
  bytes: number; articles: number; fulltext: boolean; images: boolean; file: string; meta4: string; update: boolean; failed: string | null;
}
interface StoredState {
  version: 1;
  settings: Settings;
  catalog: { checked_at: string | null; books: CatalogBook[] };
  books: StoredBook[];
  downloads: StoredDownload[];
  /** Books the owner removed: not wanted until chosen again. */
  dropped: string[];
  paused: boolean;
}

export interface ReferenceOptions {
  /** The reader: a binary to run as it is, how it is run, where its release is read (tests). */
  reader?: Partial<Pick<ReaderOptions, "binary" | "command" | "releaseUrl" | "pins" | "startTimeoutMs">>;
  /** Requests for the catalog and metalinks (default: the hub's own fetch). */
  fetch?: typeof fetch;
  catalogUrl?: string;
  /** How archives are fetched (tests). */
  get?: (url: string, opts: GetOptions) => Promise<GetResponse>;
  /** Tests only: plain http to 127.0.0.1 for archives and the reader's release. */
  allowHttpLoopback?: boolean;
  /** Why downloads wait for a game, or null (default: the graphics card's check). */
  gameRunning?: () => Promise<string | null>;
  /** How often the downloads are looked at (default 30 s). */
  everyMs?: number;
  now?: () => number;
}

type HubLike = Pick<Hub, "cfg" | "modules" | "ai" | "fetch" | "db">;

interface Live { state: DownloadState; reason?: WaitReason }
interface Active { name: string; file: string; ctl: AbortController; done: number; samples: [number, number][]; verifying: boolean; stopReason: Live | null; task: Promise<void> }

const slim = (b: CatalogBook): CatalogBook => ({ ...b, tags: [], summary: "" });

/** Whether a time is in the update window, 01:00 to 07:00 hub time. */
export function inNight(t: number): boolean { const h = new Date(t).getHours(); return h >= 1 && h < 7; }

/** A game on this machine's graphics card: the mail filer's check while the model server is here, else the card's own. */
async function gameOnHub(hub: HubLike): Promise<string | null> {
  if (hub.cfg.ollamaUrl && onThisMachine(hub.cfg.ollamaUrl)) return hub.ai.gameRunning();
  return gpuBusyNow(false);
}

/** A network failure (the catalog, a metalink): the hub is offline or Kiwix is down, not a wrong file. */
function networkError(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  const msg = (e as Error)?.message ?? "";
  return name === "TimeoutError" || name === "AbortError" || (e instanceof TypeError && /fetch failed/i.test(msg)) || /answered 5\d\d/.test(msg);
}

export class ReferenceService {
  readonly dir: string;
  readonly filesDir: string;
  readonly partialDir: string;
  readonly reader: KiwixReader;
  private readonly stateFile: string;
  private st: StoredState;
  private started = false;
  private stopped = false;
  private active: Active | null = null;
  private live = new Map<string, Live>();
  private doneCache = new Map<string, number>();
  private stops: (() => void)[] = [];
  private pumping = false;
  private again = false;
  private catalogLoad: Promise<void> | null = null;
  private offlineUntil = 0;
  private offlineDelay = 60_000;
  private game: { at: number; busy: string | null } | null = null;
  private readerChain: Promise<void> = Promise.resolve();
  private readerBusy = false;
  private readerAgain = false;
  private titles = new AnswerCache<{ hits: Hit[]; partial: boolean }>(50, 60_000);
  private searches = new AnswerCache<{ hits: Hit[]; total: number; partial: boolean; need: number }>(50, 60_000);
  private readonly now: () => number;

  constructor(private hub: HubLike, private opts: ReferenceOptions = {}) {
    this.dir = hub.cfg.referenceDir;
    this.filesDir = path.join(this.dir, "files");
    this.partialDir = path.join(this.dir, "partial");
    this.stateFile = path.join(this.dir, "state.json");
    this.now = opts.now ?? Date.now;
    this.st = this.load();
    this.reader = new KiwixReader({
      binDir: path.join(this.dir, "bin"),
      allowHttpLoopback: opts.allowHttpLoopback,
      ...(opts.reader ?? {}),
      onChange: () => { this.titles.clear(); this.searches.clear(); },
    });
    setReferenceReadiness(hub.cfg, () => this.hasReadyBook());
  }

  // ---------- state ----------

  private load(): StoredState {
    const fresh: StoredState = { version: 1, settings: structuredClone(DEFAULT_SETTINGS), catalog: { checked_at: null, books: [] }, books: [], downloads: [], dropped: [], paused: false };
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[reference] state.json could not be read (${errCode(e)}); starting with no choices`);
      return fresh;
    }
    const v = (raw && typeof raw === "object" ? raw : {}) as Partial<StoredState>;
    const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? x as T[] : []);
    return {
      version: 1,
      settings: readSettings(v.settings),
      catalog: { checked_at: typeof v.catalog?.checked_at === "string" ? v.catalog.checked_at : null, books: arr<CatalogBook>(v.catalog?.books).filter((b) => b && typeof b.name === "string" && typeof b.file === "string") },
      books: arr<StoredBook>(v.books).filter((b) => b && typeof b.name === "string" && typeof b.file === "string").map((b) => ({ ...b, old_file: b.old_file ?? null })),
      downloads: arr<StoredDownload>(v.downloads).filter((d) => d && typeof d.name === "string" && typeof d.file === "string" && typeof d.meta4 === "string").map((d) => ({ ...d, failed: d.failed ?? null })),
      dropped: arr<string>(v.dropped).filter((x) => typeof x === "string"),
      paused: v.paused === true,
    };
  }

  private save(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.st), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (e) { console.error(`[reference] state.json not saved: ${errCode(e)}`); }
  }

  private moduleOn(): boolean { return this.hub.modules.on("reference"); }
  private get fetchFn(): typeof fetch { return this.opts.fetch ?? this.hub.fetch; }

  /** A book is downloaded and the reader answers: search and the assistant's tools have something to read. */
  hasReadyBook(): boolean {
    return this.moduleOn() && this.reader.state === "ready" && this.st.books.some((b) => b.state === "ready");
  }

  private wanted(settings = this.st.settings, dropped: ReadonlySet<string> = new Set(this.st.dropped)): Wanted[] {
    return planBooks(settings, this.st.catalog.books, dropped);
  }

  // ---------- choices and the plan ----------

  private doneOf(d: { name: string; file: string }): number {
    if (this.active?.name === d.name) return this.active.done;
    let n = this.doneCache.get(d.file);
    if (n === undefined) { n = partialDone(this.partialDir, d.file); this.doneCache.set(d.file, n); }
    return n;
  }

  private freeBytes(): number {
    const d = diskSpace(fs.existsSync(this.dir) ? this.dir : this.hub.cfg.dataDir);
    return d?.free_bytes ?? 0;
  }

  /** What the choices add up to against the room on the disk. */
  planTotals(): { wanted_bytes: number; to_download_bytes: number; free_bytes: number; fits: boolean } {
    const wanted = this.wanted();
    const wantedBytes = wanted.reduce((n, w) => n + w.bytes, 0);
    const toDownload = this.st.downloads.reduce((n, d) => n + Math.max(0, d.bytes - this.doneOf(d)), 0);
    const free = this.freeBytes();
    return { wanted_bytes: wantedBytes, to_download_bytes: toDownload, free_bytes: free, fits: free >= toDownload + (toDownload ? ROOM_BYTES : 0) };
  }

  /** `GET /reference/settings`: `{ settings, plan }`, the choices and what they add up to. */
  settingsView(): { settings: Settings; plan: ReturnType<ReferenceService["planTotals"]> } {
    return { settings: structuredClone(this.st.settings), plan: this.planTotals() };
  }

  async putSettings(input: Record<string, unknown>): Promise<ReturnType<ReferenceService["settingsView"]>> {
    const next = applySettings(this.st.settings, input);
    // A book the owner removed comes back once it is chosen again (its source or language picked anew).
    const none = new Set<string>();
    const before = new Set(this.wanted(this.st.settings, none).map((w) => w.name));
    const after = this.wanted(next, none);
    const newly = new Set(after.filter((w) => !before.has(w.name)).map((w) => w.name));
    const addedSources = next.sources.filter((s) => !this.st.settings.sources.includes(s));
    this.st.dropped = this.st.dropped.filter((n) => !newly.has(n) && !addedSources.some((s) => after.some((w) => w.name === n && w.source === s)));
    this.st.settings = next;
    // Books whose source or language is no longer chosen go (the catalog no longer listing one does not remove it);
    // one chosen again before its file went stays.
    const wantedNow = new Set(this.wanted(next).map((w) => w.name));
    for (const b of this.st.books) {
      if (b.state === "ready" && !stillChosen(next, b.source, b.langs)) b.state = "removing";
      else if (b.state === "removing" && stillChosen(next, b.source, b.langs) && wantedNow.has(b.name) && fs.existsSync(path.join(this.filesDir, b.file))) b.state = "ready";
    }
    this.syncDownloads();
    this.save();
    this.titles.clear(); this.searches.clear();
    // Nothing is fetched until a source is chosen; the first time, the catalog is read now.
    if (next.sources.length && !this.st.catalog.checked_at && this.started) void this.loadCatalog(false).then(() => { this.syncDownloads(); this.save(); this.kick(); }).catch((e) => { console.error(`[reference] catalog not read: ${errCode(e)}`); });
    void this.syncReader();
    this.kick();
    return this.settingsView();
  }

  /** `GET /reference/sources`: read the catalog first when there is none yet; a day-old one is read again meanwhile. */
  async sourcesList(): Promise<{ checked_at: string | null; sources: ReturnType<typeof sourcesView> }> {
    if (!this.st.catalog.checked_at) {
      try { await this.loadCatalog(false); }
      catch (e) {
        console.error(`[reference] catalog not read: ${errCode(e)}`);
        throw new StoreError(502, "Kiwix's catalog could not be read. Check the hub's internet connection and try again.");
      }
    } else if (this.now() - Date.parse(this.st.catalog.checked_at) > DAY) {
      void this.loadCatalog(false).then(() => { this.syncDownloads(); this.save(); this.kick(); }).catch((e) => { console.error(`[reference] catalog not read: ${errCode(e)}`); });
    }
    return { checked_at: this.st.catalog.checked_at, sources: sourcesView(this.st.catalog.books) };
  }

  /** Read the catalog: at most once a day unless the owner asks (`force`). */
  private loadCatalog(force: boolean): Promise<void> {
    const last = Date.parse(this.st.catalog.checked_at ?? "");
    if (!force && Number.isFinite(last) && this.now() - last < DAY) return Promise.resolve();
    if (this.catalogLoad) return this.catalogLoad;
    this.catalogLoad = (async () => {
      try {
        const books = await fetchCatalog(this.fetchFn, this.opts.catalogUrl ?? CATALOG_URL);
        this.st.catalog = { checked_at: new Date(this.now()).toISOString(), books: books.map(slim) };
        this.save();
        console.log(`[reference] catalog read: ${books.length} archives of the curated sources`);
      } finally { this.catalogLoad = null; }
    })();
    return this.catalogLoad;
  }

  // ---------- status ----------

  private liveOf(name: string): Live {
    let l = this.live.get(name);
    if (!l) { l = { state: "queued" }; this.live.set(name, l); }
    return l;
  }

  private speedOf(a: Active): number {
    const s = a.samples;
    if (s.length < 2) return 0;
    const [t0, b0] = s[0];
    const [t1, b1] = s[s.length - 1];
    return t1 > t0 ? ((b1 - b0) / (t1 - t0)) * 1000 : 0;
  }

  /** `GET /reference/status`. */
  status() {
    const downloading = new Set(this.st.downloads.map((d) => d.name));
    const books = this.st.books.map((b) => ({
      name: b.name, flavour: b.flavour, lang: b.lang, source: b.source, title: b.title, date: b.date, bytes: b.bytes, articles: b.articles,
      fulltext: b.fulltext, file: b.file, state: b.state === "removing" ? "removing" as const : downloading.has(b.name) ? "update" as const : "ready" as const,
    }));
    const downloads = this.st.downloads.map((d) => {
      const a = this.active?.name === d.name ? this.active : null;
      const l = this.live.get(d.name) ?? { state: "queued" as DownloadState };
      const state: DownloadState = d.failed ? "failed" : a ? (a.verifying ? "verifying" : a.stopReason ? a.stopReason.state : "downloading") : this.st.paused ? "paused" : l.state;
      const reason = state === "waiting" ? (a?.stopReason?.reason ?? l.reason) : undefined;
      const done = this.doneOf(d);
      const bytesPerSec = a && !a.verifying ? this.speedOf(a) : 0;
      return {
        name: d.name, flavour: d.flavour, lang: d.lang, source: d.source, title: d.title, date: d.date, bytes: d.bytes,
        done_bytes: done,
        // Bits per second, as the cap (max_mbps) is in megabits.
        speed_bps: Math.round(bytesPerSec * 8),
        eta_s: bytesPerSec > 0 ? Math.round(Math.max(0, d.bytes - done) / bytesPerSec) : null,
        state, ...(reason ? { reason } : {}), ...(d.failed ? { error: d.failed } : {}),
      };
    });
    return {
      on: this.moduleOn(),
      reader: { state: this.reader.state, ...(this.reader.error ? { error: this.reader.error } : {}) },
      books, downloads, plan: this.planTotals(), next_check: this.nextCheck(),
    };
  }

  /** When the catalog is next checked: a week after the last check, at the job's time (00:50). */
  private nextCheck(): string | null {
    if (!this.st.settings.sources.length) return null;
    const last = Date.parse(this.st.catalog.checked_at ?? "");
    const due = Math.max(this.now(), Number.isFinite(last) ? last + WEEK : this.now());
    const next = new Date(due);
    next.setHours(0, 50, 0, 0);
    if (next.getTime() < due) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  // ---------- owner's actions ----------

  pause() {
    this.st.paused = true;
    this.save();
    this.stopActive({ state: "paused" });
    return this.status();
  }

  resume() {
    this.st.paused = false;
    this.offlineUntil = 0;
    for (const d of this.st.downloads) { d.failed = null; Object.assign(this.liveOf(d.name), { state: "queued", reason: undefined }); }
    this.save();
    this.kick();
    return this.status();
  }

  /** `POST /reference/check`: read the catalog now and queue what is missing or newer (failed downloads too). */
  async check() {
    try { await this.loadCatalog(true); }
    catch (e) {
      console.error(`[reference] catalog not read: ${errCode(e)}`);
      throw new StoreError(502, "Kiwix's catalog could not be read. Check the hub's internet connection and try again.");
    }
    for (const d of this.st.downloads) d.failed = null;
    this.offlineUntil = 0;
    this.syncDownloads();
    this.save();
    this.kick();
    return this.status();
  }

  /** `DELETE /reference/books/:name`: its file goes and it is not wanted until chosen again. */
  removeBook(name: string) {
    const book = this.st.books.find((b) => b.name === name);
    const dl = this.st.downloads.find((d) => d.name === name);
    if (!book && !dl) throw new StoreError(404, "no such book");
    if (!this.st.dropped.includes(name)) this.st.dropped.push(name);
    if (dl) this.dropDownload(dl);
    if (book) book.state = "removing";
    this.save();
    this.titles.clear(); this.searches.clear();
    void this.syncReader();
    return this.status();
  }

  // ---------- downloads ----------

  /** Downloads to match the plan: one for each wanted book not ready in that file, first downloads before updates. */
  private syncDownloads(): void {
    const wanted = this.wanted();
    const byName = new Map(wanted.map((w) => [w.name, w]));
    for (const d of [...this.st.downloads]) {
      const w = byName.get(d.name);
      if (!w || w.file !== d.file) this.dropDownload(d);
    }
    for (const w of wanted) {
      const ready = this.st.books.find((b) => b.name === w.name);
      if (ready && ready.state === "ready" && ready.file === w.file) continue;
      if (this.st.downloads.some((d) => d.name === w.name)) continue;
      this.st.downloads.push({ name: w.name, flavour: w.flavour, lang: w.lang, langs: w.langs, source: w.source, title: w.title, date: w.date, updated: w.updated, bytes: w.bytes, articles: w.articles, fulltext: w.fulltext, images: w.images, file: w.file, meta4: w.meta4, update: isUpdate(this.st.books, w), failed: null });
    }
    const order = new Map(wanted.map((w, i) => [w.name, i]));
    // An update is a newer file of the same kind. Pictures switched on or off, or Wikipedia to intros, is the owner's own
    // choice and starts at once like a first download, not at night.
    for (const d of this.st.downloads) d.update = isUpdate(this.st.books, d);
    this.st.downloads.sort((a, b) => Number(a.update) - Number(b.update) || (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
    this.cleanPartials();
  }

  private dropDownload(d: StoredDownload): void {
    if (this.active?.name === d.name) this.stopActive(null);
    this.st.downloads = this.st.downloads.filter((x) => x !== d);
    this.live.delete(d.name);
    this.doneCache.delete(d.file);
    // A download still stopping removes its own files once it has stopped.
    if (this.active?.file !== d.file) removePartial(this.partialDir, d.file);
  }

  /** Files in partial/ no download names (one dropped while the hub was off) are removed. */
  private cleanPartials(): void {
    let names: string[];
    try { names = fs.readdirSync(this.partialDir); } catch { return; }
    const keep = new Set(this.st.downloads.map((d) => d.file));
    if (this.active) keep.add(this.active.file);
    for (const n of names) {
      const file = n.replace(/\.json(\.tmp)?$/, "");
      if (!keep.has(file)) { try { fs.rmSync(path.join(this.partialDir, n), { force: true }); } catch { /* next time */ } }
    }
  }

  private stopActive(why: Live | null): void {
    if (!this.active) return;
    this.active.stopReason = why;
    this.active.ctl.abort();
  }

  private kick(): void { if (this.started && !this.stopped) void this.pump(); }

  private async pump(): Promise<void> {
    if (this.pumping) { this.again = true; return; }
    this.pumping = true;
    try {
      do { this.again = false; await this.pumpOnce(); } while (this.again && !this.stopped);
    } catch (e) { console.error(`[reference] ${errCode(e)}`); }
    finally { this.pumping = false; }
  }

  /** A game on this machine, asked at most every 30 seconds. */
  private async gameNow(): Promise<string | null> {
    if (this.opts.gameRunning) { try { return await this.opts.gameRunning(); } catch { return null; } }
    const now = Date.now();
    if (this.game && now - this.game.at < 30_000) return this.game.busy;
    let busy: string | null = null;
    try { busy = await gameOnHub(this.hub); } catch { busy = null; }
    this.game = { at: now, busy };
    return busy;
  }

  /** One look at the queue: what may run now, what waits and why. */
  private async pumpOnce(): Promise<void> {
    void this.syncReader();
    if (this.stopped) return;
    const downloads = this.st.downloads;
    if (!this.moduleOn()) {
      this.stopActive({ state: "waiting", reason: "module" });
      for (const d of downloads) Object.assign(this.liveOf(d.name), { state: "waiting", reason: "module" });
      return;
    }
    if (this.st.paused) {
      this.stopActive({ state: "paused" });
      for (const d of downloads) Object.assign(this.liveOf(d.name), { state: "paused", reason: undefined });
      return;
    }
    const game = downloads.length ? await this.gameNow() : null;
    const disk = diskSpace(fs.existsSync(this.dir) ? this.dir : this.hub.cfg.dataDir);
    const now = this.now();
    let chosen: StoredDownload | null = null;
    let activeReason: Live | null = null;
    for (const d of this.st.downloads) {
      const l = this.liveOf(d.name);
      if (d.failed) { Object.assign(l, { state: "failed", reason: undefined }); continue; }
      const remaining = Math.max(0, d.bytes - this.doneOf(d));
      const reason: WaitReason | null = game ? "game"
        : disk?.low ? "disk"
        : d.update && this.st.settings.schedule === "nights" && !inNight(now) ? "night"
        : now < this.offlineUntil ? "offline"
        : disk && disk.free_bytes < remaining + ROOM_BYTES ? "disk"
        : null;
      if (reason) {
        Object.assign(l, { state: "waiting", reason });
        if (this.active?.name === d.name) activeReason = { state: "waiting", reason };
        continue;
      }
      if (!chosen) { chosen = d; if (this.active?.name !== d.name) Object.assign(l, { state: "queued", reason: undefined }); continue; }
      Object.assign(l, { state: "queued", reason: undefined });
    }
    // One at a time: what runs must be the first that may (a first download goes ahead of an update).
    if (this.active && this.active.name !== chosen?.name) this.stopActive(activeReason ?? { state: "queued" });
    if (chosen && !this.active) this.startDownload(chosen);
  }

  private capBytes(): number | null { const m = this.st.settings.max_mbps; return m ? (m * 1_000_000) / 8 : null; }

  private async metaFor(d: StoredDownload): Promise<Metalink> {
    try { return await fetchMetalink(this.fetchFn, d.meta4); }
    catch (e) {
      // Offline for the metalink: a download already under way goes on with the mirrors it had.
      const p = readPartial(this.partialDir, d.file);
      if (p && networkError(e)) return { file: p.file, size: p.size, sha256: p.sha256, pieceLength: p.piece_length, pieces: p.pieces, urls: p.urls };
      throw e;
    }
  }

  private startDownload(d: StoredDownload): void {
    const ctl = new AbortController();
    const act: Active = { name: d.name, file: d.file, ctl, done: this.doneOf(d), samples: [], verifying: false, stopReason: null, task: Promise.resolve() };
    this.active = act;
    Object.assign(this.liveOf(d.name), { state: "downloading", reason: undefined });
    act.task = (async () => {
      try {
        const meta = await this.metaFor(d);
        if (meta.file !== d.file) throw new Error("the metalink names another file than the catalog");
        if (ctl.signal.aborted) return;
        const r = await downloadArchive({
          partialDir: this.partialDir, meta, signal: ctl.signal,
          maxBytesPerSecond: () => this.capBytes(),
          onProgress: (n) => {
            act.done = n;
            this.doneCache.set(d.file, n);
            const t = Date.now();
            act.samples.push([t, n]);
            while (act.samples.length > 2 && t - act.samples[0][0] > 10_000) act.samples.shift();
          },
          onVerifying: () => { act.verifying = true; },
          get: this.opts.get, allowHttpLoopback: this.opts.allowHttpLoopback,
        });
        if (r.ok) { this.offlineDelay = 60_000; this.finish(d, r.file, meta.size); }
        else if (r.kind === "offline") this.goOffline();
        else if (r.kind === "bad") this.fail(d, r.error);
      } catch (e) {
        if (!ctl.signal.aborted) {
          if (networkError(e)) this.goOffline();
          else this.fail(d, (e as Error).message);
        }
      } finally {
        if (this.active === act) this.active = null;
        this.doneCache.delete(d.file);
        if (act.stopReason) Object.assign(this.liveOf(d.name), act.stopReason);
        // Dropped while it ran: its files go now that they are closed.
        if (!this.st.downloads.some((x) => x.file === d.file)) removePartial(this.partialDir, d.file);
        this.kick();
      }
    })();
  }

  /** No mirror answered: wait (one minute, doubling to six hours) before trying again. */
  private goOffline(): void {
    this.offlineUntil = this.now() + this.offlineDelay;
    this.offlineDelay = Math.min(6 * 3_600_000, this.offlineDelay * 2);
    console.error("[reference] no mirror answered; downloads wait");
  }

  private fail(d: StoredDownload, error: string): void {
    const kept = this.st.downloads.find((x) => x.name === d.name && x.file === d.file);
    if (kept) kept.failed = error.slice(0, 300);
    this.save();
    console.error("[reference] a download failed its checks");
  }

  /** A checked file goes into files/; the reader restarts with it; an older file of the book waits for that. */
  private finish(d: StoredDownload, partialFile: string, size: number): void {
    fs.mkdirSync(this.filesDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.filesDir, d.file);
    fs.renameSync(partialFile, target);
    removePartial(this.partialDir, d.file);
    const existing = this.st.books.find((b) => b.name === d.name);
    const rec: StoredBook = { name: d.name, flavour: d.flavour, lang: d.lang, langs: d.langs, source: d.source, title: d.title, date: d.date, updated: d.updated, bytes: size, articles: d.articles, fulltext: d.fulltext, images: d.images, file: d.file, state: "ready", old_file: null };
    if (existing) {
      // The file it replaces stays until the reader answers with the new one.
      if (existing.old_file && existing.old_file !== d.file) this.deleteFile(existing.old_file);
      rec.old_file = existing.file !== d.file ? existing.file : null;
      this.st.books = this.st.books.map((b) => (b === existing ? rec : b));
    } else this.st.books.push(rec);
    this.st.downloads = this.st.downloads.filter((x) => x.name !== d.name);
    this.live.delete(d.name);
    this.save();
    this.titles.clear(); this.searches.clear();
    console.log(`[reference] a book is ready (${this.st.books.filter((b) => b.state === "ready").length} in all)`);
    void this.syncReader();
  }

  private deleteFile(file: string): boolean {
    try { fs.rmSync(path.join(this.filesDir, file), { force: true }); return true; }
    catch (e) { console.error(`[reference] an old archive could not be removed yet: ${errCode(e)}`); return false; }
  }

  // ---------- the reader ----------

  /** Bring the reader in line with the books; calls made while one runs (an install can take minutes) become one more run. */
  private syncReader(): Promise<void> {
    if (this.readerBusy) { this.readerAgain = true; return this.readerChain; }
    this.readerBusy = true;
    this.readerChain = (async () => {
      try {
        do { this.readerAgain = false; await this.syncReaderNow(); } while (this.readerAgain);
      } catch (e) { console.error(`[reference] reader: ${errCode(e)}`); }
      finally { this.readerBusy = false; }
    })();
    return this.readerChain;
  }

  private async syncReaderNow(): Promise<void> {
    const run = this.started && !this.stopped && this.moduleOn();
    const want = run ? this.st.books.filter((b) => b.state === "ready" && fs.existsSync(path.join(this.filesDir, b.file))).map((b) => path.join(this.filesDir, b.file)) : [];
    await this.reader.setFiles(want);
    // What the reader has open: what it was asked for, and what the running one was started with.
    const running = new Set(this.reader.serving());
    const open = new Set([...want, ...running]);
    let changed = false;
    // Removed books' files go once the reader no longer has them open.
    for (const b of this.st.books.filter((x) => x.state === "removing")) {
      if (open.has(path.join(this.filesDir, b.file))) continue;
      const gone = this.deleteFile(b.file) && (!b.old_file || this.deleteFile(b.old_file));
      if (gone) { this.st.books = this.st.books.filter((x) => x !== b); changed = true; }
    }
    // An older file of a book goes once the reader answers with the new one; if it cannot, the old one is used again.
    // Only a file the running reader was started with is asked about (one that arrived meanwhile waits for the next run).
    if (this.reader.state === "ready" && this.reader.base) {
      for (const b of this.st.books.filter((x) => x.state === "ready" && x.old_file && running.has(path.join(this.filesDir, x.file)))) {
        const name = await readerMeta(this.reader.base, urlNameOf(b.file), "Name", 5000).catch(() => null);
        if (name !== null) {
          if (this.deleteFile(b.old_file!)) { b.old_file = null; changed = true; }
          continue;
        }
        console.error("[reference] the reader could not open a new archive; the previous one is used again");
        this.deleteFile(b.file);
        const failedFile = b.file;
        b.file = b.old_file!;
        b.old_file = null;
        changed = true;
        const w = this.wanted().find((x) => x.name === b.name && x.file === failedFile);
        if (w && !this.st.downloads.some((x) => x.name === w.name)) this.st.downloads.push({ ...w, update: true, failed: "The reader could not open the new file." } as StoredDownload);
        void this.syncReader();
      }
    }
    if (changed) { this.save(); this.titles.clear(); this.searches.clear(); }
  }

  // ---------- running ----------

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    // Downloads cut by a stop go on; their states are worked out again.
    this.live.clear();
    this.syncDownloads();
    const every = setInterval(() => this.kick(), this.opts.everyMs ?? 30_000);
    every.unref();
    this.stops.push(() => clearInterval(every));
    // The catalog is checked weekly; a week missed while the hub was off is made up after it starts (schedule.ts).
    this.stops.push(scheduleDaily("reference-catalog", 0, 50, () => { void this.weekly(); }, { clock: dbJobClock(this.hub.db) }));
    // Off: the reader and downloads stop, the files stay. On: they go on.
    this.stops.push(this.hub.modules.onChange((on, off) => {
      if (off.includes("reference") || on.includes("reference")) { this.titles.clear(); this.searches.clear(); this.kick(); }
    }));
    this.kick();
  }

  private async weekly(): Promise<void> {
    if (!this.moduleOn() || !this.st.settings.sources.length) return;
    const last = Date.parse(this.st.catalog.checked_at ?? "");
    if (Number.isFinite(last) && this.now() - last < WEEK - 3_600_000) return;
    try { await this.check(); } catch { /* logged; the next day tries again */ }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const s of this.stops.splice(0)) { try { s(); } catch { /* gone */ } }
    // A download in progress keeps its checked pieces for the next start.
    const task = this.active?.task;
    this.stopActive(null);
    await task?.catch(() => {});
    await this.reader.stop();
  }

  // ---------- search and reading ----------

  private readyBooks(): StoredBook[] { return this.st.books.filter((b) => b.state === "ready"); }

  private readerBase(): string {
    if (this.reader.state !== "ready" || !this.reader.base) {
      if (!this.readyBooks().length) throw new StoreError(404, "No reference book is downloaded yet. Choose sources in Settings, Reference.");
      throw new StoreError(503, "The reference reader is starting. Try again in a moment.", undefined, { reader: this.reader.state });
    }
    return this.reader.base;
  }

  private book(name: string): StoredBook {
    const b = this.readyBooks().find((x) => x.name === name);
    if (!b) throw new StoreError(404, "no such book");
    return b;
  }

  private firstLang(): string { return this.st.settings.languages[0] ?? "eng"; }
  private booksSig(books: StoredBook[]): string { return books.map((b) => b.file).join(","); }

  /** `GET /reference/suggest`: titles across every ready book, for as-you-type. */
  async suggest(q: string, limit: number): Promise<{ q: string; results: Pick<Hit, "book" | "source" | "lang" | "title" | "path">[]; partial: boolean }> {
    const books = this.readyBooks();
    if (!q.trim() || !books.length) return { q, results: [], partial: false };
    const base = this.readerBase();
    const key = JSON.stringify([q, limit, this.booksSig(books)]);
    let got = this.titles.get(key);
    if (!got) {
      const per = await Promise.all(books.map(async (b) => {
        try { return { book: b, titles: await readerSuggest(base, urlNameOf(b.file), q, Math.max(limit, 8), SUGGEST_MS), texts: [] as TextHit[] } as PerBook; }
        catch { return null; }
      }));
      got = { hits: rankResults(q, per.filter((p): p is PerBook => !!p), this.firstLang()), partial: per.some((p) => !p) };
      this.titles.set(key, got);
    }
    return { q, results: got.hits.slice(0, limit).map((h) => ({ book: h.book, source: h.source, lang: h.lang, title: h.title, path: h.path })), partial: got.partial };
  }

  /** `GET /reference/search`: titles then full text across the ready books (narrowed by sources and languages). */
  async search(q: string, opts: { sources: string[]; langs: string[]; limit: number; offset: number }): Promise<{ q: string; results: Hit[]; total: number; took_ms: number; partial: boolean }> {
    const t0 = Date.now();
    const books = this.readyBooks().filter((b) => (!opts.sources.length || opts.sources.includes(b.source)) && (!opts.langs.length || b.langs.some((l) => opts.langs.includes(l))));
    if (!q.trim() || !books.length) return { q, results: [], total: 0, took_ms: Date.now() - t0, partial: false };
    const base = this.readerBase();
    // Fetched in steps of 20 so paging through a query reads the reader once per step.
    const need = Math.min(200, Math.ceil((opts.offset + opts.limit) / 20) * 20);
    const key = JSON.stringify([q, opts.sources, opts.langs, this.booksSig(books)]);
    let got = this.searches.get(key);
    if (!got || got.need < need) {
      let partial = false;
      let total = 0;
      const per = await Promise.all(books.map(async (b): Promise<PerBook | null> => {
        const url = urlNameOf(b.file);
        const [titles, texts] = await Promise.all([
          readerSuggest(base, url, q, Math.min(need, 50), SEARCH_MS).catch(() => null),
          b.fulltext ? readerSearch(base, url, q, need, 0, SEARCH_MS).catch(() => null) : Promise.resolve({ total: 0, hits: [] as TextHit[] }),
        ]);
        if (!titles || !texts) partial = true;
        if (!titles && !texts) return null;
        total += texts?.total ?? 0;
        return { book: b, titles: titles ?? ([] as TitleHit[]), texts: texts?.hits ?? [] };
      }));
      const hits = rankResults(q, per.filter((p): p is PerBook => !!p), this.firstLang());
      got = { hits, total: Math.max(total, hits.length), partial, need };
      this.searches.set(key, got);
    }
    return { q, results: got.hits.slice(opts.offset, opts.offset + opts.limit), total: got.total, took_ms: Date.now() - t0, partial: got.partial };
  }

  /** A page of a book as the reader stores it, following a redirect inside the book once. */
  private async rawPage(b: StoredBook, p: string, maxBytes: number): Promise<{ path: string; type: string; body: Buffer }> {
    const base = this.readerBase();
    const url = urlNameOf(b.file);
    let at = p;
    for (let hop = 0; hop < 3; hop++) {
      const r = await readerRaw(base, url, at, PAGE_MS, maxBytes).catch((e) => { throw new StoreError(502, `the reader did not answer (${errCode(e)})`); });
      if (r.status >= 300 && r.status < 400) {
        if (!r.location) break;
        at = r.location;
        continue;
      }
      if (r.status === 404) throw new StoreError(404, "no such page in that book");
      if (r.status !== 200) throw new StoreError(502, `the reader answered ${r.status}`);
      return { path: at, type: r.type, body: r.body };
    }
    throw new StoreError(404, "no such page in that book");
  }

  /** `GET /reference/article`: the page sanitized, with its headings, date, original address and license. */
  async article(bookName: string, p: string) {
    const b = this.book(bookName);
    const raw = await this.rawPage(b, p, MAX_PAGE_BYTES);
    if (raw.type !== "text/html" && raw.type !== "application/xhtml+xml") throw new StoreError(404, "that is not a page the reader can show");
    const page = cleanPage(raw.body.toString("utf8"), { book: b.name, path: raw.path, images: b.images, urlName: urlNameOf(b.file) });
    return {
      book: b.name, source: b.source, lang: b.lang, title: page.title, path: raw.path, html: page.html, toc: page.toc, date: b.date,
      ...(page.url ? { url: page.url } : {}), license: sourceById(b.source)?.license ?? "See the source",
    };
  }

  /** `GET /reference/summary`: the first paragraph and the first picture, for link previews. */
  async summary(bookName: string, p: string): Promise<{ title: string; text: string; media?: string }> {
    const b = this.book(bookName);
    const raw = await this.rawPage(b, p, MAX_PAGE_BYTES);
    if (raw.type !== "text/html" && raw.type !== "application/xhtml+xml") throw new StoreError(404, "that is not a page the reader can show");
    const s = pageSummary(raw.body.toString("utf8"), { book: b.name, path: raw.path, images: b.images, urlName: urlNameOf(b.file) });
    return { title: s.title, text: s.text, ...(s.media ? { media: s.media } : {}) };
  }

  /** `GET /reference/media`: a picture from a book (PNG, JPEG, GIF, WebP or SVG only). */
  async media(bookName: string, p: string): Promise<{ type: string; body: Buffer }> {
    const b = this.book(bookName);
    if (!b.images) throw new StoreError(404, "that book has no pictures");
    const raw = await this.rawPage(b, p, MAX_MEDIA_BYTES);
    const types = new Set(Object.values(MEDIA_TYPES));
    if (!types.has(raw.type) || !looksLike(raw.type, raw.body)) throw new StoreError(404, "not a picture the reference serves");
    return { type: raw.type, body: raw.body };
  }

  /** `GET /reference/random`: a random article from the ready books (narrowed by sources and languages). */
  async random(opts: { sources: string[]; langs: string[] }): Promise<{ book: string; path: string; title: string }> {
    const books = this.readyBooks().filter((b) => (!opts.sources.length || opts.sources.includes(b.source)) && (!opts.langs.length || b.langs.some((l) => opts.langs.includes(l))));
    if (!books.length) throw new StoreError(404, "no ready book matches");
    const base = this.readerBase();
    let last: { book: string; path: string; title: string } | null = null;
    // Another language's copy is passed over a few times (ArchWiki has many).
    for (let i = 0; i < 6; i++) {
      const b = books[Math.floor(Math.random() * books.length)];
      const p = await readerRandom(base, urlNameOf(b.file), PAGE_MS).catch(() => null);
      if (!p) continue;
      last = { book: b.name, path: p, title: titleFromPath(p) };
      if (!isLanguageCopy(last.title, b.langs)) return last;
    }
    if (last) return last;
    throw new StoreError(502, "the reader gave no page");
  }
}

/** A picture's first bytes match its type (the archive's own label is not trusted alone). */
function looksLike(type: string, b: Buffer): boolean {
  switch (type) {
    case "image/png": return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg": return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/gif": return b.subarray(0, 4).toString("latin1") === "GIF8";
    case "image/webp": return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
    case "image/svg+xml": return /<svg[\s>]/i.test(b.subarray(0, 4096).toString("utf8"));
    default: return false;
  }
}

const services = new WeakMap<object, ReferenceService>();

/**
 * The hub's reference service, made on first use: routes use it whether or not it was started. With `opts` (tests) a
 * new one replaces it.
 */
export function referenceFor(hub: Hub, opts?: ReferenceOptions): ReferenceService {
  let s = services.get(hub);
  if (!s || opts) {
    if (s) void s.stop();
    s = new ReferenceService(hub, opts ?? {});
    services.set(hub, s);
  }
  return s;
}

/** Start the offline reference's background work (downloads, the reader, the weekly check); returns its stop. */
export function startReference(hub: Hub, opts?: ReferenceOptions): () => void {
  const s = referenceFor(hub, opts);
  s.start();
  return () => { void s.stop(); };
}
