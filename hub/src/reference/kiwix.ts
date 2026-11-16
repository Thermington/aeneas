import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { errCode } from "../logsafe.js";
import { child, descendants, localName, parseXml, text, type XNode } from "./xml.js";
import { httpGet } from "./net.js";
import { sha256File } from "./download.js";

/**
 * The reader: kiwix-serve 3.8.1, Kiwix's own build for the hub's system, downloaded once from Kiwix's release folder
 * and used only when the archive matches the SHA-256 written here (checked before it is unpacked). The hub runs it on
 * 127.0.0.1 at a free port, tied to the hub's process, with outside links blocked, and is the only thing that talks to
 * it. It restarts with a new set of archives and after it stops (2 s, doubling to 5 minutes).
 */

export const KIWIX_VERSION = "3.8.1";
export const KIWIX_RELEASE = "https://download.kiwix.org/release/kiwix-tools/";

export interface Pin { file: string; sha256: string; bytes: number }
export const KIWIX_PINS: Record<string, Pin> = {
  "linux-x86_64": { file: "kiwix-tools_linux-x86_64-3.8.1.tar.gz", sha256: "46557f9a3c3eaada2556a957cf5bc662c07dc6286e8924e04fa3a173f83ff6dd", bytes: 21503420 },
  "linux-aarch64": { file: "kiwix-tools_linux-aarch64-3.8.1.tar.gz", sha256: "7b00940e1f5e4642e4ef6e7262543893e105b20e9e97be5352e129c591fa29da", bytes: 20430528 },
  "macos-arm64": { file: "kiwix-tools_macos-arm64-3.8.1.tar.gz", sha256: "222e8398ca50ac005a7e92cf0116e0c83e3c44c79cab0bb7f6537943d517e8d3", bytes: 10254751 },
  "macos-x86_64": { file: "kiwix-tools_macos-x86_64-3.8.1.tar.gz", sha256: "70219e56f7c274e1fc0db8487abdcc91bde9a6f2923958894c0c81ee24b06c01", bytes: 10768392 },
  "win-x86_64": { file: "kiwix-tools_win-x86_64-3.8.1.zip", sha256: "fcd01ed2b93e9a68632c7863c83b9f66bf64406a66357be1df7b8b75596f3e45", bytes: 18301924 },
};

/** Kiwix's name for this machine's build, or null when it makes none. */
export function kiwixPlatform(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform === "linux" && arch === "x64") return "linux-x86_64";
  if (platform === "linux" && arch === "arm64") return "linux-aarch64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x86_64";
  if (platform === "win32" && arch === "x64") return "win-x86_64";
  return null;
}

/** The name the reader serves a file under: the file's name without `.zim`. */
export function urlNameOf(file: string): string { return path.basename(file).replace(/\.zim$/, ""); }

export type ReaderState = "off" | "installing" | "starting" | "ready" | "failed";

export interface ReaderOptions {
  /** `<reference>/bin`. */
  binDir: string;
  /** A kiwix-serve to run as it is, with nothing downloaded (tests). */
  binary?: string;
  /** Tests: where the release is read from, its pins, and plain http to 127.0.0.1 for that. */
  releaseUrl?: string;
  pins?: Record<string, Pin>;
  allowHttpLoopback?: boolean;
  /** Tests: how a binary is run (a stand-in reader started with node). */
  command?: (binary: string, args: string[]) => { file: string; args: string[] };
  startTimeoutMs?: number;
  /** Told whenever the state changes. */
  onChange?: () => void;
}

const run = (file: string, args: string[], timeoutMs: number) => new Promise<void>((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = a && typeof a === "object" ? a.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** The folder holding the reader, found after unpacking (the tarballs hold one folder, the zip none). */
function findServe(dir: string, depth = 2): string | null {
  const exe = process.platform === "win32" ? "kiwix-serve.exe" : "kiwix-serve";
  if (fs.existsSync(path.join(dir, exe))) return dir;
  if (depth <= 0) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const found = findServe(path.join(dir, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/** Download, check and unpack the pinned kiwix-tools; the path of kiwix-serve. Done once, then reused. */
export async function installKiwix(opts: Pick<ReaderOptions, "binDir" | "releaseUrl" | "pins" | "allowHttpLoopback">, platform = kiwixPlatform()): Promise<string> {
  if (!platform) throw new Error("Kiwix makes no reader for this machine's system");
  const pin = (opts.pins ?? KIWIX_PINS)[platform];
  if (!pin) throw new Error("Kiwix makes no reader for this machine's system");
  fs.mkdirSync(opts.binDir, { recursive: true, mode: 0o700 });
  const dir = path.join(opts.binDir, `kiwix-tools-${KIWIX_VERSION}`);
  const exe = path.join(dir, process.platform === "win32" ? "kiwix-serve.exe" : "kiwix-serve");
  const marker = path.join(dir, ".installed");
  try { if (fs.existsSync(exe) && fs.readFileSync(marker, "utf8").trim() === pin.sha256) return exe; } catch { /* installed again */ }

  const archive = path.join(opts.binDir, pin.file);
  const part = `${archive}.part`;
  const ctl = new AbortController();
  const deadline = setTimeout(() => ctl.abort(), 15 * 60_000);
  try {
    const res = await httpGet(`${opts.releaseUrl ?? KIWIX_RELEASE}${pin.file}`, { signal: ctl.signal, allowHttpLoopback: opts.allowHttpLoopback, connectTimeoutMs: 30_000, idleTimeoutMs: 60_000 });
    if (res.status !== 200) { res.body.destroy(); throw new Error(`Kiwix's release folder answered ${res.status}`); }
    const out = fs.createWriteStream(part, { mode: 0o600 });
    let got = 0;
    try {
      for await (const chunk of res.body) {
        got += (chunk as Buffer).length;
        if (got > pin.bytes) throw new Error("the reader's archive is larger than the one pinned");
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
      if (!res.body.destroyed) res.body.destroy();
    }
    if (got !== pin.bytes) throw new Error("the reader's archive is not the size pinned");
    if ((await sha256File(part)) !== pin.sha256) throw new Error("the reader's archive does not match its pinned SHA-256");
    fs.renameSync(part, archive);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  } finally { clearTimeout(deadline); }

  const work = fs.mkdtempSync(path.join(opts.binDir, "unpack-"));
  try {
    // The system's tar (on Windows its tar reads the zip).
    await run("tar", [process.platform === "win32" ? "-xf" : "-xzf", archive, "-C", work], 120_000);
    const found = findServe(work);
    if (!found) throw new Error("the reader's archive holds no kiwix-serve");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(found, dir);
    if (process.platform !== "win32") fs.chmodSync(exe, 0o755);
    fs.writeFileSync(marker, `${pin.sha256}\n`, { mode: 0o600 });
    return exe;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }
}

const MAX_DELAY_MS = 5 * 60_000;

export class KiwixReader {
  state: ReaderState = "off";
  error: string | null = null;
  /** `http://127.0.0.1:<port>` while it answers. */
  base: string | null = null;
  private files: string[] = [];
  private proc: ChildProcess | null = null;
  private delay = 2000;
  private retryAt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private wanted: string[] = [];
  private stopped = false;

  constructor(private opts: ReaderOptions) {}

  /** The files the running reader was started with (none while it is not running). */
  serving(): string[] { return this.proc && this.state === "ready" ? [...this.files] : []; }

  private set(state: ReaderState, error: string | null = null): void {
    this.state = state;
    this.error = error;
    if (state !== "ready") this.base = null;
    try { this.opts.onChange?.(); } catch { /* the listener's own problem */ }
  }

  /** The files it should serve (sorted paths); it starts, restarts or stops to match. */
  setFiles(files: string[]): Promise<void> {
    const next = [...files].sort();
    // A new set of archives is tried at once, even while waiting after a failure.
    if (next.length !== this.wanted.length || next.some((f, i) => f !== this.wanted[i])) this.retryAt = 0;
    this.wanted = next;
    this.chain = this.chain.then(() => this.apply()).catch((e) => { console.error(`[reference] reader: ${errCode(e)}`); });
    return this.chain;
  }

  private async apply(): Promise<void> {
    const want = this.wanted;
    if (this.stopped || !want.length) { await this.kill(); if (this.state !== "off") this.set("off"); return; }
    const same = want.length === this.files.length && want.every((f, i) => f === this.files[i]);
    if (same && this.proc && (this.state === "ready" || this.state === "starting")) return;
    if (Date.now() < this.retryAt) return;
    let exe = this.opts.binary;
    if (!exe) {
      this.set("installing");
      try { exe = await installKiwix(this.opts); }
      catch (e) {
        console.error(`[reference] the reader could not be installed: ${errCode(e)}`);
        this.backoff(`The Kiwix reader could not be installed: ${(e as Error).message}`);
        return;
      }
    }
    await this.kill();
    this.set("starting");
    const port = await freePort();
    const args = ["--address=127.0.0.1", `--port=${port}`, `--attachToProcess=${process.pid}`, "--blockexternal", "--skipInvalid", ...want];
    const cmd = this.opts.command ? this.opts.command(exe, args) : { file: exe, args };
    const proc = spawn(cmd.file, cmd.args, { stdio: "ignore", windowsHide: true });
    this.proc = proc;
    this.files = want;
    let exited = false;
    proc.on("error", () => { exited = true; });
    proc.on("exit", () => {
      exited = true;
      if (this.proc !== proc) return;
      this.proc = null;
      this.files = [];
      if (this.stopped || !this.wanted.length) { this.set("off"); return; }
      console.error("[reference] the reader stopped; starting it again");
      this.backoff("The reader stopped; it starts again shortly.");
    });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 60_000);
    while (Date.now() < deadline && !exited && this.proc === proc) {
      try {
        const r = await fetch(`${base}/catalog/v2/entries`, { signal: AbortSignal.timeout(2000) });
        await r.body?.cancel().catch(() => {});
        if (r.ok) break;
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.proc !== proc) return;
    if (exited || Date.now() >= deadline) {
      await this.kill();
      this.backoff("The reader did not start.");
      return;
    }
    this.base = base;
    this.set("ready");
    // Once it has served for five minutes, a later stop waits 2 s again.
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => { if (this.proc === proc) this.delay = 2000; }, 5 * 60_000);
    this.stableTimer.unref();
  }

  /** Failed for now: try again after the delay, which doubles up to five minutes. */
  private backoff(error: string): void {
    this.set("failed", error);
    this.retryAt = Date.now() + this.delay;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (!this.stopped) void this.setFiles(this.wanted); }, this.delay);
    this.retryTimer.unref();
    this.delay = Math.min(MAX_DELAY_MS, this.delay * 2);
  }

  private async kill(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    this.files = [];
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 3000);
      p.once("exit", () => { clearTimeout(done); resolve(); });
      try { p.kill(); } catch { clearTimeout(done); resolve(); }
    });
  }

  /** Stop for good (the hub is stopping). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wanted = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    await this.chain.catch(() => {});
    await this.kill();
    if (this.state !== "off") this.set("off");
  }
}

// ---------- talking to the reader ----------

async function readerGet(base: string, pathAndQuery: string, timeoutMs: number, redirect: "follow" | "manual" = "follow"): Promise<Response> {
  return fetch(`${base}${pathAndQuery}`, { signal: AbortSignal.timeout(timeoutMs), redirect });
}

async function bodyCapped(res: Response, max: number): Promise<Buffer> {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) { await res.body?.cancel().catch(() => {}); throw new Error("too large"); }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error("too large");
  return buf;
}

export interface TitleHit { title: string; path: string }
export interface TextHit { title: string; path: string; snippet: ({ text: string } | { bold: string })[]; words: number | null }

/** Titles that match as one types: the reader's title index ("pattern" rows, its own search link, left out). */
export async function readerSuggest(base: string, urlName: string, term: string, count: number, timeoutMs: number): Promise<TitleHit[]> {
  const res = await readerGet(base, `/suggest?content=${encodeURIComponent(urlName)}&term=${encodeURIComponent(term)}&count=${count}`, timeoutMs);
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`reader answered ${res.status}`); }
  const rows = JSON.parse((await bodyCapped(res, 1 << 20)).toString("utf8")) as { value?: unknown; kind?: unknown; path?: unknown }[];
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r && r.kind !== "pattern" && typeof r.value === "string" && typeof r.path === "string")
    .map((r) => ({ title: String(r.value), path: String(r.path) }));
}

/** The book-relative path in a reader link (`/content/<book>/<path>`), decoded. */
export function pathFromLink(link: string, urlName: string): string | null {
  const prefix = `/content/${urlName}/`;
  let p = link;
  try { p = new URL(link, "http://reader.invalid").pathname; } catch { return null; }
  if (!p.startsWith(prefix)) return null;
  const rest = p.slice(prefix.length);
  try { return rest.split("/").map(decodeURIComponent).join("/"); } catch { return null; }
}

/** Full-text results in the reader's order, with its total. */
export async function readerSearch(base: string, urlName: string, pattern: string, pageLength: number, start: number, timeoutMs: number): Promise<{ total: number; hits: TextHit[] }> {
  const res = await readerGet(base, `/search?books.name=${encodeURIComponent(urlName)}&pattern=${encodeURIComponent(pattern)}&format=xml&pageLength=${pageLength}&start=${start}`, timeoutMs);
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`reader answered ${res.status}`); }
  const doc = parseXml((await bodyCapped(res, 4 << 20)).toString("utf8"));
  const totalEl = descendants(doc, "totalResults")[0] ?? null;
  const hits: TextHit[] = [];
  for (const item of descendants(doc, "item")) {
    const p = pathFromLink(text(child(item, "link")), urlName);
    if (p === null) continue;
    const words = Number(text(child(item, "wordCount")).replace(/[^\d]/g, ""));
    hits.push({ title: text(child(item, "title")), path: p, snippet: snippetParts(child(item, "description")), words: Number.isFinite(words) && words > 0 ? words : null });
  }
  return { total: Number(text(totalEl)) || hits.length, hits };
}

/** The reader's snippet as text and bold parts (it marks the words found with `<b>`). */
function snippetParts(desc: XNode | null): ({ text: string } | { bold: string })[] {
  const out: ({ text: string } | { bold: string })[] = [];
  const walk = (n: XNode, bold: boolean) => {
    for (let i = 0; i < n.childNodes.length; i++) {
      const c = n.childNodes[i];
      if (c.nodeType === 3 || c.nodeType === 4) {
        const t = c.nodeValue ?? "";
        if (t) out.push(bold ? { bold: t } : { text: t });
      } else if (c.nodeType === 1) walk(c, bold || localName(c) === "b");
    }
  };
  if (desc) walk(desc, false);
  return out;
}

/** `location`: where a redirect entry leads, as a path in the same book (null when it leads elsewhere). */
export interface RawPage { status: number; type: string; body: Buffer; location?: string | null }

/** A page or file of a book as it is stored (`/raw/<book>/content/<path>`). */
export async function readerRaw(base: string, urlName: string, p: string, timeoutMs: number, maxBytes: number): Promise<RawPage> {
  const enc = p.split("/").map(encodeURIComponent).join("/");
  const res = await readerGet(base, `/raw/${encodeURIComponent(urlName)}/content/${enc}`, timeoutMs, "manual");
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const loc = res.headers.get("location");
    return { status: res.status, type: "", body: Buffer.alloc(0), ...(res.status >= 300 && res.status < 400 ? { location: loc ? pathFromLink(loc, urlName) : null } : {}) };
  }
  return { status: res.status, type: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), body: await bodyCapped(res, maxBytes) };
}

/** One of a book's metadata (`Name`, `Title`, `Date`...), or null. */
export async function readerMeta(base: string, urlName: string, key: string, timeoutMs: number): Promise<string | null> {
  const res = await readerGet(base, `/raw/${encodeURIComponent(urlName)}/meta/${encodeURIComponent(key)}`, timeoutMs, "manual");
  if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
  return (await bodyCapped(res, 1 << 16)).toString("utf8");
}

/** A random article's path in a book. */
export async function readerRandom(base: string, urlName: string, timeoutMs: number): Promise<string | null> {
  const res = await readerGet(base, `/random?content=${encodeURIComponent(urlName)}`, timeoutMs, "manual");
  await res.body?.cancel().catch(() => {});
  const loc = res.headers.get("location");
  return res.status >= 300 && res.status < 400 && loc ? pathFromLink(loc, urlName) : null;
}
