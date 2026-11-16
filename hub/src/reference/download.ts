import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { httpGet, NetError, type GetOptions, type GetResponse } from "./net.js";
import type { Metalink } from "./metalink.js";

/**
 * One archive downloaded into `partial/` (CONTRACT "Offline reference", Downloads): from its mirrors in order, over
 * https, resumed with HTTP ranges after a cut or a hub restart. Each piece is checked against the metalink's SHA-1 as it
 * lands; a bad piece is fetched again from the next mirror. The whole file is then checked against its SHA-256, read
 * as a stream so the hub keeps answering. Progress is kept in `partial/<file>.json` (with the bytes flushed first), so
 * a restart goes on from the last checked piece.
 */

export interface PartialInfo {
  file: string;
  size: number;
  sha256: string;
  piece_length: number;
  pieces: string[];
  urls: string[];
  /** Pieces checked from the start of the file (with no piece hashes: bytes written). */
  verified: number;
  mirror: number;
}

export type DownloadResult =
  | { ok: true; file: string }
  | { ok: false; kind: "aborted" | "offline" | "bad"; error: string };

export interface DownloadJob {
  partialDir: string;
  meta: Metalink;
  signal: AbortSignal;
  /** The speed cap now, in bytes per second (read as the download goes, so a change applies at once). */
  maxBytesPerSecond?: () => number | null;
  onProgress?: (doneBytes: number) => void;
  onVerifying?: () => void;
  get?: (url: string, opts: GetOptions) => Promise<GetResponse>;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Tests only. */
  allowHttpLoopback?: boolean;
}

const SAVE_EVERY_MS = 10_000;

export function partialPaths(partialDir: string, file: string): { data: string; json: string } {
  return { data: path.join(partialDir, file), json: path.join(partialDir, `${file}.json`) };
}

export function readPartial(partialDir: string, file: string): PartialInfo | null {
  try {
    const v = JSON.parse(fs.readFileSync(partialPaths(partialDir, file).json, "utf8")) as PartialInfo;
    return v && v.file === file && Number.isSafeInteger(v.size) && Array.isArray(v.pieces) ? v : null;
  } catch { return null; }
}

/** Bytes already checked for a download in `partial/`. */
export function partialDone(partialDir: string, file: string): number {
  const p = readPartial(partialDir, file);
  if (!p) return 0;
  return p.piece_length ? Math.min(p.size, p.verified * p.piece_length) : Math.min(p.size, p.verified);
}

export function removePartial(partialDir: string, file: string): void {
  const p = partialPaths(partialDir, file);
  for (const f of [p.data, p.json, `${p.json}.tmp`]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
}

function writeInfo(jsonPath: string, info: PartialInfo): void {
  const tmp = `${jsonPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  fs.renameSync(tmp, jsonPath);
}

/** The SHA-256 of a file, read in 1 MiB pieces so the event loop is never held long. */
export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const h = createHash("sha256");
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  const stop = () => stream.destroy(new Error("stopped"));
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for await (const chunk of stream) h.update(chunk as Buffer);
  } finally { signal?.removeEventListener("abort", stop); }
  return h.digest("hex");
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

export async function downloadArchive(job: DownloadJob): Promise<DownloadResult> {
  const { meta, signal } = job;
  const get = job.get ?? httpGet;
  fs.mkdirSync(job.partialDir, { recursive: true, mode: 0o700 });
  const paths = partialPaths(job.partialDir, meta.file);
  const P = meta.pieceLength;
  const pieces = meta.pieces;
  const kept = readPartial(job.partialDir, meta.file);
  const same = !!kept && kept.sha256 === meta.sha256 && kept.size === meta.size && kept.piece_length === P && fs.existsSync(paths.data);
  const info: PartialInfo = { file: meta.file, size: meta.size, sha256: meta.sha256, piece_length: P, pieces, urls: meta.urls, verified: same ? kept!.verified : 0, mirror: same ? kept!.mirror : 0 };
  const fh = await fs.promises.open(paths.data, same ? "r+" : "w+", 0o600);
  // A download that cannot be right starts again from nothing next time: its files go once the file is closed.
  let discard = false;
  try {
    let done: number;
    if (P) {
      info.verified = Math.min(info.verified, pieces.length);
      done = Math.min(meta.size, info.verified * P);
      await fh.truncate(done);
    } else {
      done = Math.min(meta.size, (await fh.stat()).size);
      await fh.truncate(done);
      info.verified = done;
    }
    writeInfo(paths.json, info);
    let lastSave = Date.now();
    const save = async (force = false) => {
      if (!force && Date.now() - lastSave < SAVE_EVERY_MS) return;
      await fh.datasync();
      writeInfo(paths.json, info);
      lastSave = Date.now();
    };
    job.onProgress?.(done);

    const urls = meta.urls;
    let mirror = info.mirror % urls.length;
    let triesWithoutProgress = 0;
    const badTries = new Map<number, number>();
    // The speed cap: bytes allowed since `windowStart`.
    let windowStart = Date.now();
    let windowBytes = 0;

    while (done < meta.size) {
      if (signal.aborted) { await save(true); return { ok: false, kind: "aborted", error: "stopped" }; }
      if (triesWithoutProgress >= urls.length * 2) { await save(true); return { ok: false, kind: "offline", error: "no mirror sent the file" }; }
      info.mirror = mirror;
      let res: GetResponse;
      try {
        res = await get(urls[mirror], { headers: { range: `bytes=${done}-` }, signal, connectTimeoutMs: job.connectTimeoutMs, idleTimeoutMs: job.idleTimeoutMs, allowHttpLoopback: job.allowHttpLoopback });
      } catch (e) {
        if (signal.aborted) continue;
        if (e instanceof NetError && e.kind === "refused") { mirror = (mirror + 1) % urls.length; triesWithoutProgress++; continue; }
        triesWithoutProgress++;
        mirror = (mirror + 1) % urls.length;
        continue;
      }
      const range = /^bytes (\d+)-/.exec(String(res.headers["content-range"] ?? ""));
      const okStatus = (res.status === 206 && range && Number(range[1]) === done) || (res.status === 200 && done === 0);
      if (!okStatus) {
        res.body.destroy();
        triesWithoutProgress++;
        mirror = (mirror + 1) % urls.length;
        continue;
      }
      let progressed = false;
      let badPiece = false;
      let pieceIndex = P ? Math.floor(done / P) : 0;
      let pieceStart = P ? pieceIndex * P : done;
      let inPiece = done - pieceStart;
      let hasher = createHash("sha1");
      try {
        for await (const raw of res.body) {
          const chunk = raw as Buffer;
          let off = 0;
          while (off < chunk.length) {
            if (!P) {
              const take = Math.min(chunk.length - off, meta.size - done);
              if (take <= 0) { off = chunk.length; break; }
              await fh.write(chunk, off, take, done);
              done += take; off += take; info.verified = done; progressed = true;
              continue;
            }
            const pieceEnd = Math.min(pieceStart + P, meta.size);
            const take = Math.min(chunk.length - off, pieceEnd - (pieceStart + inPiece));
            if (take <= 0) { off = chunk.length; break; }
            await fh.write(chunk, off, take, pieceStart + inPiece);
            hasher.update(chunk.subarray(off, off + take));
            inPiece += take; off += take;
            if (pieceStart + inPiece === pieceEnd) {
              if (hasher.digest("hex") === pieces[pieceIndex]) {
                info.verified = pieceIndex + 1;
                done = pieceEnd;
                pieceIndex++; pieceStart = pieceEnd; inPiece = 0;
                hasher = createHash("sha1");
                progressed = true;
                badTries.delete(pieceIndex - 1);
              } else {
                // Fetched again from the next mirror; a piece no mirror sends right ends the download.
                const tries = (badTries.get(pieceIndex) ?? 0) + 1;
                badTries.set(pieceIndex, tries);
                await fh.truncate(pieceStart);
                badPiece = true;
                if (tries >= urls.length) {
                  res.body.destroy();
                  discard = true;
                  return { ok: false, kind: "bad", error: `piece ${pieceIndex + 1} did not match its SHA-1 from any mirror` };
                }
                break;
              }
            }
          }
          job.onProgress?.(P ? pieceStart + inPiece : done);
          if (badPiece) break;
          if (progressed) { triesWithoutProgress = 0; await save(); }
          // Under the cap: wait until the bytes so far fit the allowed rate.
          const cap = job.maxBytesPerSecond?.() ?? null;
          if (cap && cap > 0) {
            windowBytes += chunk.length;
            const elapsed = Date.now() - windowStart;
            const due = (windowBytes / cap) * 1000;
            if (due > elapsed) await sleep(Math.min(due - elapsed, 5000), signal);
            if (elapsed > 10_000) { windowStart = Date.now(); windowBytes = 0; }
          } else { windowStart = Date.now(); windowBytes = 0; }
          if (signal.aborted) break;
        }
      } catch {
        // A cut connection or a stall: go on from the last checked piece (another mirror when nothing came).
      } finally {
        if (!res.body.destroyed) res.body.destroy();
      }
      if (P && inPiece && !badPiece) await fh.truncate(pieceStart);
      if (badPiece || !progressed) { mirror = (mirror + 1) % urls.length; if (!progressed) triesWithoutProgress++; }
      done = P ? Math.min(meta.size, info.verified * P) : done;
    }
    await save(true);
    if (signal.aborted) return { ok: false, kind: "aborted", error: "stopped" };
    job.onVerifying?.();
    let sum: string;
    try { sum = await sha256File(paths.data, signal); } catch {
      if (signal.aborted) return { ok: false, kind: "aborted", error: "stopped" };
      return { ok: false, kind: "bad", error: "the file could not be read back" };
    }
    if (sum !== meta.sha256) {
      discard = true;
      return { ok: false, kind: "bad", error: "the file's SHA-256 did not match the metalink" };
    }
    return { ok: true, file: paths.data };
  } finally {
    await fh.close().catch(() => {});
    if (discard) removePartial(job.partialDir, meta.file);
  }
}
