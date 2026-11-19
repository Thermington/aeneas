import { createHash, createPublicKey, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Hub } from "./hub.js";
import { VERSION } from "./hub.js";
import { REPO_DIR } from "./config.js";
import { StoreError } from "./store.js";
import { errCode } from "./logsafe.js";

/**
 * The Windows and Android apps update from the hub. The hub and every app share one version, so the apps a hub serves
 * are its own release's: the hub fetches the installer and its signature from that GitHub release once, keeps them in
 * its data folder, and hands them to its devices, which never call anyone but the hub. An installer is served only
 * when its signature checks out against the release key (packages/shared/app-update-key.txt), and the apps check it
 * again before installing, so neither a changed download nor a changed hub can put another program on a device.
 */

export const APP_PLATFORMS = ["windows", "android"] as const;
export type AppPlatform = typeof APP_PLATFORMS[number];
export type AppFileState = "missing" | "fetching" | "ready" | "unpublished" | "failed";

export interface AppFile {
  platform: AppPlatform;
  version: string;
  state: AppFileState;
  file: string;
  size?: number;
  sha256?: string;
  signature?: string;
  error?: string;
  at?: string;
}

/** The release file for a platform and version, as the release process names it. */
export function assetName(platform: AppPlatform, version: string): string {
  return platform === "windows" ? `Aeneas-windows-${version}-setup.exe` : `Aeneas-android-${version}.apk`;
}

/** What the release key signs: the platform, the version and the file's SHA-256, so a signature fits one file only. */
export function signedMessage(platform: AppPlatform, version: string, sha256hex: string): string {
  return `aeneas-app-update/1\n${platform}\n${version}\n${sha256hex.toLowerCase()}`;
}

/** The release key's public half (base64, 32 bytes): EA_APP_UPDATE_KEY in tests, else the file every copy ships with. */
export function appUpdateKey(): string {
  if (process.env.EA_APP_UPDATE_KEY) return process.env.EA_APP_UPDATE_KEY.trim();
  const text = fs.readFileSync(path.join(REPO_DIR, "packages", "shared", "app-update-key.txt"), "utf8");
  return text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
}

/** Whether `signatureB64` is the release key's signature of this file. */
export function signatureOk(platform: AppPlatform, version: string, sha256hex: string, signatureB64: string, keyB64 = appUpdateKey()): boolean {
  try {
    const raw = Buffer.from(keyB64, "base64");
    if (raw.length !== 32) return false;
    // An Ed25519 public key in SPKI form: the fixed 12-byte header, then the 32 key bytes.
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
    const sig = Buffer.from(signatureB64.trim(), "base64");
    return sig.length === 64 && verify(null, Buffer.from(signedMessage(platform, version, sha256hex)), key, sig);
  } catch { return false; }
}

/** -1, 0 or 1 for two versions like 1.0.3; null when either is not three numbers. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v.trim()) ? v.trim().split(".").map(Number) : null);
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The GitHub repository whose releases hold the apps: EA_RELEASE_REPO, else the one this hub's code was cloned from
 * (a fork serves its own releases, signed with its own key), else the project's.
 */
export function releaseRepo(): string {
  const valid = (s: string) => /^[\w.-]+\/[\w.-]+$/.test(s);
  if (process.env.EA_RELEASE_REPO && valid(process.env.EA_RELEASE_REPO)) return process.env.EA_RELEASE_REPO;
  try {
    const url = execFileSync("git", ["-C", REPO_DIR, "remote", "get-url", "origin"], { timeout: 5_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
    if (m && valid(m[1])) return m[1];
  } catch { /* not a clone */ }
  return "gnomecannon/aeneas";
}

/** GitHub's download host and the hosts it hands release files out from. Nothing else is followed. */
const ALLOWED_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const MAX_BYTES = 300 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60_000;

type FetchLike = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
let releaseFetch: FetchLike = (url, init) => fetch(url, init);
/** Tests swap GitHub for a stand-in. */
export function setReleaseFetch(f: FetchLike | null): void { releaseFetch = f ?? ((url, init) => fetch(url, init)); }

/** One GET that follows at most 4 redirects, each to an allowed host over https. */
async function get(url: string, signal: AbortSignal): Promise<Response> {
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(at);
    if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) throw new Error(`refused host ${u.hostname}`);
    const res = await releaseFetch(at, { redirect: "manual", signal, headers: { "user-agent": "aeneas-hub" } });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!next) throw new Error("redirect without a location");
      at = new URL(next, at).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

/** The hub's copy of its release's apps: one folder in the data folder, older versions removed once a newer one is in. */
export class AppReleases {
  private states = new Map<AppPlatform, AppFile>();
  private running = new Map<AppPlatform, Promise<AppFile>>();

  constructor(private dataDir: string, private version: string = VERSION) {}

  private dir(): string { return path.join(this.dataDir, "app-releases"); }
  private metaPath(platform: AppPlatform): string { return path.join(this.dir(), `${platform}-${this.version}.json`); }
  filePath(platform: AppPlatform): string { return path.join(this.dir(), assetName(platform, this.version)); }

  /** Where this platform's app stands: kept from an earlier fetch, being fetched, or not yet asked for. */
  state(platform: AppPlatform): AppFile {
    const live = this.states.get(platform);
    if (live) return live;
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath(platform), "utf8")) as AppFile;
      const st = fs.statSync(this.filePath(platform));
      if (meta.state === "ready" && meta.version === this.version && st.size === meta.size && meta.sha256 && meta.signature) {
        this.states.set(platform, meta);
        return meta;
      }
    } catch { /* not fetched yet */ }
    return { platform, version: this.version, state: "missing", file: assetName(platform, this.version) };
  }

  /** Every platform's state, with the size, SHA-256 and signature the apps check a download against. */
  view(): Record<AppPlatform, AppFile> {
    return Object.fromEntries(APP_PLATFORMS.map((p) => [p, this.state(p)])) as Record<AppPlatform, AppFile>;
  }

  /** Fetches the app once (a second ask waits for the same fetch). Resolves with the outcome, never throws. */
  prepare(platform: AppPlatform): Promise<AppFile> {
    const s = this.state(platform);
    if (s.state === "ready") return Promise.resolve(s);
    const already = this.running.get(platform);
    if (already) return already;
    const job = this.fetchApp(platform).finally(() => this.running.delete(platform));
    this.running.set(platform, job);
    return job;
  }

  private async fetchApp(platform: AppPlatform): Promise<AppFile> {
    const version = this.version, file = assetName(platform, version);
    const base = `https://github.com/${releaseRepo()}/releases/download/v${version}/`;
    const set = (s: Partial<AppFile> & { state: AppFileState }): AppFile => {
      const next: AppFile = { platform, version, file, ...s, at: new Date().toISOString() };
      this.states.set(platform, next);
      return next;
    };
    set({ state: "fetching" });
    fs.mkdirSync(this.dir(), { recursive: true });
    const tmp = `${this.filePath(platform)}.part`;
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const sigRes = await get(base + file + ".sig", signal);
      if (sigRes.status === 404) {
        await sigRes.body?.cancel().catch(() => {});
        return set({ state: "unpublished", error: `The ${version} release has no signed ${platform === "windows" ? "Windows" : "Android"} app yet.` });
      }
      if (!sigRes.ok) throw new Error(`signature ${sigRes.status}`);
      const signature = (await sigRes.text()).trim().slice(0, 200);
      const res = await get(base + file, signal);
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return set({ state: "unpublished", error: `The ${version} release has no ${platform === "windows" ? "Windows" : "Android"} app yet.` });
      }
      if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_BYTES) throw new Error("too large");
      const hash = createHash("sha256");
      let size = 0;
      const out = fs.createWriteStream(tmp, { mode: 0o600 });
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > MAX_BYTES) throw new Error("too large");
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      const sha256 = hash.digest("hex");
      if (!signatureOk(platform, version, sha256, signature)) {
        fs.rmSync(tmp, { force: true });
        console.error(`[apps] the ${platform} app ${version}: its signature does not match the release key; not served`);
        return set({ state: "failed", error: "The downloaded app's signature does not match the release key, so the hub will not hand it out." });
      }
      fs.renameSync(tmp, this.filePath(platform));
      const done = set({ state: "ready", size, sha256, signature });
      fs.writeFileSync(this.metaPath(platform), JSON.stringify(done));
      this.removeOlder(platform);
      console.log(`[apps] the ${platform} app ${version} is ready (${Math.round(size / 1024)} KB)`);
      return done;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      console.error(`[apps] the ${platform} app ${version} was not fetched: ${errCode(e)}`);
      return set({ state: "failed", error: "The hub could not fetch the app from GitHub. Try again later." });
    }
  }

  /** Earlier versions' files for this platform: the hub serves only its own version. */
  private removeOlder(platform: AppPlatform): void {
    const keep = new Set([assetName(platform, this.version), `${platform}-${this.version}.json`]);
    for (const f of fs.readdirSync(this.dir())) {
      const mine = platform === "windows" ? /^Aeneas-windows-.*-setup\.exe$|^windows-.*\.json$/ : /^Aeneas-android-.*\.apk$|^android-.*\.json$/;
      if (mine.test(f) && !keep.has(f)) fs.rmSync(path.join(this.dir(), f), { force: true });
    }
  }

  /** The ready file for a download, or a 409 saying why there is none. */
  ready(platform: AppPlatform): AppFile & { path: string } {
    const s = this.state(platform);
    if (s.state !== "ready") throw new StoreError(409, s.error ?? "The hub does not have this app yet. Ask it to fetch it first.", { state: s.state });
    return { ...s, path: this.filePath(platform) };
  }
}

/** The hub's AppReleases, made on first use. */
const byHub = new WeakMap<object, AppReleases>();
export function appReleases(hub: Hub): AppReleases {
  let r = byHub.get(hub);
  if (!r) { r = new AppReleases(hub.cfg.dataDir); byHub.set(hub, r); }
  return r;
}

export function isAppPlatform(p: string): p is AppPlatform { return (APP_PLATFORMS as readonly string[]).includes(p); }
