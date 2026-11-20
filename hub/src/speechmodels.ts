import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { errCode } from "./logsafe.js";

/**
 * The Apple Watch's speech model (Watch Capture writes speech down on the Watch, since 2026-11-20), fetched by the
 * hub so the apps never contact anyone but the hub. On the first request the hub downloads the pinned files of the
 * model from Hugging Face (packages/shared/speech-models.json: one revision, each file's size and SHA-256), checks
 * each, keeps them in `<data>/speech-models/<model>/`, and hands them to the iPhone, which checks them again and
 * carries them to the Watch. Hugging Face sees only the hub's address and which public files it fetched. Only those
 * files, from Hugging Face's own hosts, with the Voice module on.
 */

export interface SpeechFile { path: string; size: number; sha256: string }
export interface SpeechModelPin { name: string; files: SpeechFile[]; tokenizer_repo: string; tokenizer_revision: string }
interface Manifest { repo: string; revision: string; tokenizer_files: string[]; models: SpeechModelPin[] }

const MANIFEST_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/shared/speech-models.json");
export const SPEECH_MANIFEST: Manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")) as Manifest;

/** Hugging Face and the hosts it sends large files from; a redirect anywhere else is refused. */
export const allowedHost = (host: string) => /(^|\.)huggingface\.co$/i.test(host) || /(^|\.)hf\.co$/i.test(host);

export function modelPin(name: string): SpeechModelPin | null {
  return SPEECH_MANIFEST.models.find((m) => m.name === name) ?? null;
}

/** Where a file comes from: the pinned revision, never a branch that can move. */
export function sourceUrl(m: SpeechModelPin, f: SpeechFile): string {
  if (SPEECH_MANIFEST.tokenizer_files.includes(f.path)) return `https://huggingface.co/${m.tokenizer_repo}/resolve/${m.tokenizer_revision}/${f.path}`;
  return `https://huggingface.co/${SPEECH_MANIFEST.repo}/resolve/${SPEECH_MANIFEST.revision}/${m.name}/${f.path}`;
}

const dirOf = (hub: Hub, m: SpeechModelPin) => path.join(hub.cfg.dataDir, "speech-models", m.name);
const fileOf = (hub: Hub, m: SpeechModelPin, f: SpeechFile) => path.join(dirOf(hub, m), ...f.path.split("/"));
/** A file is put in place only after its size and hash matched, so one there at its full size is a checked one. */
const has = (hub: Hub, m: SpeechModelPin, f: SpeechFile) => { try { return fs.statSync(fileOf(hub, m, f)).size === f.size; } catch { return false; } };

export interface SpeechModelState { name: string; state: "ready" | "fetching" | "missing" | "failed"; bytes: number; total: number; error?: string }
const running = new Map<string, Promise<void>>();
const failures = new Map<string, string>();

export function speechModelState(hub: Hub, m: SpeechModelPin): SpeechModelState {
  const total = m.files.reduce((n, f) => n + f.size, 0);
  const bytes = m.files.filter((f) => has(hub, m, f)).reduce((n, f) => n + f.size, 0);
  const state = bytes === total ? "ready" : running.has(m.name) ? "fetching" : failures.has(m.name) ? "failed" : "missing";
  return { name: m.name, state, bytes, total, ...(state === "failed" ? { error: failures.get(m.name) } : {}) };
}

/** One file: followed through Hugging Face's redirects (its own hosts only), hashed as it arrives, kept if it matches. */
export async function fetchFile(url: string, f: SpeechFile, dest: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let at = url;
  let res: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(at);
    if (u.protocol !== "https:" || !allowedHost(u.hostname)) throw new Error(`refused to fetch from ${u.hostname}`);
    res = await fetchImpl(at, { redirect: "manual", headers: { "user-agent": "Aeneas hub (Watch speech model)" }, signal: AbortSignal.timeout(15 * 60_000) });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) break;
    at = new URL(next, at).toString();
  }
  if (!res || res.status !== 200 || !res.body) throw new Error(`${f.path}: answered ${res?.status ?? "nothing"}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(part, { mode: 0o600 });
  let size = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > f.size) throw new Error(`${f.path}: larger than pinned`);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    if (size !== f.size || hash.digest("hex") !== f.sha256) throw new Error(`${f.path}: not the pinned file`);
    fs.renameSync(part, dest);
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }
}

/** What the hub fetches with; tests give a stand-in so they never reach the network. */
let fetcher: typeof fetch = (...a) => fetch(...a);
export function useSpeechFetch(f: typeof fetch): void { fetcher = f; }

/** Fetch what is missing, once at a time per model. */
export function prepareSpeechModel(hub: Hub, m: SpeechModelPin, fetchImpl: typeof fetch = fetcher): SpeechModelState {
  if (!running.has(m.name) && speechModelState(hub, m).state !== "ready") {
    failures.delete(m.name);
    const job = (async () => {
      for (const f of m.files) if (!has(hub, m, f)) await fetchFile(sourceUrl(m, f), f, fileOf(hub, m, f), fetchImpl);
      console.log("[speech] the Watch's speech model was fetched and checked");
    })()
      .catch((e) => { failures.set(m.name, String((e as Error)?.message ?? e).slice(0, 160)); console.error(`[speech] the Watch's speech model was not fetched: ${errCode(e)}`); })
      .finally(() => running.delete(m.name));
    running.set(m.name, job);
  }
  return speechModelState(hub, m);
}

/** A checked file's bytes, for the iPhone. */
export function speechModelFile(hub: Hub, m: SpeechModelPin, filePath: string): Buffer {
  const f = m.files.find((x) => x.path === filePath);
  if (!f) throw new StoreError(404, "no such file in that model");
  if (!has(hub, m, f)) throw new StoreError(409, "the hub has not fetched that file yet");
  return fs.readFileSync(fileOf(hub, m, f));
}

/** Test hook: the model's last failure and run, forgotten. */
export function resetSpeechModels(): void { running.clear(); failures.clear(); fetcher = (...a) => fetch(...a); }
export async function speechModelSettled(name: string): Promise<void> { await running.get(name); }
