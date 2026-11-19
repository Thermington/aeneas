import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Database as DB } from "better-sqlite3";
import { StoreError } from "./store.js";
import { KeePassVault } from "./keepass.js";
import { quoteFor, SECRET_REF } from "./secrets.js";
import { redactValues, type HostOs } from "./ai/hosts.js";

/**
 * People who help this person with their devices (the "warden" of the design talk; docs/helpers.md). Made for someone
 * who is not technical and has a family member they trust fully, usually the one whose machine this hub runs on.
 *
 * - The helper's hub offers (people.sh ward, from Settings, People on this machine on the owner's hub). This hub keeps
 *   only the SHA-256 of the key the helper's hub made, until the person says yes once in their app. After that the
 *   helper never asks them again: someone who is not technical cannot judge a command, and chose to trust the helper.
 * - What the helper can reach with that key is `/warden/*` only: the person's devices and the passwords the person put
 *   in for the helper. Never their notes, chats, diary or anything else on this hub.
 * - Everything the helper does is written in a log the person can read in plain words, and Stop helping ends the key at
 *   once (the helper can stop too).
 * - Passwords for the helper live in their own KeePass file, `helper-passwords.kdbx`, apart from the person's own vault,
 *   with a master password the hub makes and keeps with its other secrets. A command names one as {{secret:Title}};
 *   the value goes in only here, quoted for the device's shell, and is cut out of what comes back.
 * - Commands run on the person's computer through the Aeneas app there (an "agent": the Windows app with Let my helper
 *   use this computer on), which asks this hub for work and sends back the output.
 */

export const HELPER_KEY_PREFIX = "eah1_";
export type HelperState = "offered" | "active" | "stopped";

export interface Helper {
  id: string;
  name: string;
  key_hash: string;
  state: HelperState;
  offered_at: string;
  accepted_at?: string;
  stopped_at?: string;
  stopped_by?: "person" | "helper";
}

/** An Aeneas app that runs commands for the helper, by the device it is. */
export interface Agent { device_id: string; name: string; os: HostOs; on: boolean; at: string }

/** What a scan of the person's home network found (done by their app). */
export interface ScanDevice { name: string; ip: string; open: number[]; kind?: string }
export interface Scan { at: string; by: string; network?: string; devices: ScanDevice[] }

interface HelpersFile {
  v: 1;
  helpers: Helper[];
  agents: Record<string, Agent>;
  scan?: Scan;
  /** The key each device in the home answered SSH with the first time, by address: a different one later is refused. */
  known_hosts?: Record<string, string>;
}

export interface HelperLog { id: string; at: string; helper: string; kind: string; device: string | null; text: string; detail: string | null; outcome: string | null }

/** A job for the person's computer: a command there, or (`ssh`) on another device in the home, signed in from there. */
export interface AgentJob {
  id: string; device_id: string; command: string; os: HostOs; timeout_s: number; created_at: string;
  ssh?: { ip: string; port: number; username: string; password: string; host_key?: string };
}
export interface JobResult { exit_code: number; output: string; host_key?: string }

const now = () => new Date().toISOString();
const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const NAME_RE = /^[A-Za-z][A-Za-z '.-]{0,29}$/;
/** Commands a helper's run may take at most, and how long a job waits for an app that has not asked for work yet. */
export const MAX_RUN_S = 600;

export class Helpers {
  private data: HelpersFile | null = null;
  private jobs = new Map<string, { job: AgentJob; resolve: (r: JobResult) => void; timer: NodeJS.Timeout }>();
  private waiters = new Map<string, Set<() => void>>();
  /** When each agent last asked for work, by device: an app that asked within 90 seconds is listening. */
  private polled = new Map<string, number>();
  readonly vault: KeePassVault;

  constructor(private dataDir: string, private db: DB, private vaultPassword: () => string, private ensureVaultPassword: () => string) {
    db.exec(`CREATE TABLE IF NOT EXISTS helper_log (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, helper TEXT NOT NULL, kind TEXT NOT NULL, device TEXT, text TEXT NOT NULL, detail TEXT, outcome TEXT
    ); CREATE INDEX IF NOT EXISTS helper_log_at ON helper_log(at);`);
    this.vault = new KeePassVault(path.join(dataDir, "helper-passwords.kdbx"), () => this.vaultPassword());
  }

  private file(): string { return path.join(this.dataDir, "helpers.json"); }

  private load(): HelpersFile {
    if (this.data) return this.data;
    try {
      const j = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Partial<HelpersFile>;
      this.data = { v: 1, helpers: Array.isArray(j.helpers) ? j.helpers : [], agents: j.agents && typeof j.agents === "object" ? j.agents : {}, ...(j.scan ? { scan: j.scan } : {}), ...(j.known_hosts && typeof j.known_hosts === "object" ? { known_hosts: j.known_hosts } : {}) };
    } catch {
      this.data = { v: 1, helpers: [], agents: {} };
    }
    return this.data;
  }

  private save(d: HelpersFile): void {
    this.data = d;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file());
  }

  list(): Helper[] { return this.load().helpers; }
  get(id: string): Helper | null { return this.list().find((h) => h.id === id) ?? null; }
  active(): Helper[] { return this.list().filter((h) => h.state === "active"); }

  /** A helper's offer (people.sh ward, with the hub's main key). A second offer from the same name replaces the first. */
  offer(name: string, keyHash: string): Helper {
    const n = String(name ?? "").trim().replace(/\s+/g, " ");
    if (!NAME_RE.test(n)) throw new StoreError(422, "a helper's name is letters, up to 30");
    if (!/^[0-9a-f]{64}$/.test(String(keyHash))) throw new StoreError(422, "key_hash is the key's SHA-256");
    const d = structuredClone(this.load());
    const old = d.helpers.find((h) => h.name.toLowerCase() === n.toLowerCase() && h.state !== "stopped");
    const h: Helper = { id: old?.id ?? crypto.randomUUID(), name: n, key_hash: keyHash, state: old?.state === "active" ? "active" : "offered", offered_at: now(), ...(old?.accepted_at ? { accepted_at: old.accepted_at } : {}) };
    d.helpers = [...d.helpers.filter((x) => x.id !== h.id), h];
    this.save(d);
    this.record(h, "offered", null, `${n} offered to help you with your phone and computer.`);
    return h;
  }

  accept(id: string): Helper {
    const d = structuredClone(this.load());
    const h = d.helpers.find((x) => x.id === id);
    if (!h || h.state === "stopped") throw new StoreError(404, "no such offer");
    if (h.state === "active") return h;
    h.state = "active";
    h.accepted_at = now();
    this.save(d);
    this.record(h, "accepted", null, `You let ${h.name} help you.`);
    return h;
  }

  /** Stop helping: the key ends at once. By the person (Stop helping) or by the helper. */
  stop(id: string, by: "person" | "helper"): Helper {
    const d = structuredClone(this.load());
    const h = d.helpers.find((x) => x.id === id);
    if (!h) throw new StoreError(404, "no such helper");
    if (h.state !== "stopped") {
      h.state = "stopped";
      h.stopped_at = now();
      h.stopped_by = by;
      this.save(d);
      this.record(h, "stopped", null, by === "person" ? `You stopped ${h.name} from helping.` : `${h.name} stopped helping.`);
    }
    return h;
  }

  /** The helper a key belongs to, in any state, or null. */
  lookup(key: string | null | undefined): Helper | null {
    if (!key || !key.startsWith(HELPER_KEY_PREFIX)) return null;
    const h = sha(key);
    const found = this.list().filter((x) => x.key_hash === h);
    return found.find((x) => x.state === "active") ?? found.find((x) => x.state === "offered") ?? found[0] ?? null;
  }

  // ---------- the log the person reads ----------

  record(h: Pick<Helper, "name">, kind: string, device: string | null, text: string, detail: string | null = null, outcome: string | null = null): void {
    this.db.prepare("INSERT INTO helper_log (id, at, helper, kind, device, text, detail, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), now(), h.name, kind, device, text.slice(0, 500), detail ? detail.slice(0, 4000) : null, outcome);
  }

  logList(limit = 200): HelperLog[] {
    return this.db.prepare("SELECT * FROM helper_log ORDER BY at DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 1000)) as HelperLog[];
  }

  // ---------- agents: the person's Aeneas apps that run commands ----------

  /** An app says whether it lets the helper use the computer it runs on (`on`), and what it is. */
  setAgent(deviceId: string, body: { on?: unknown; os?: unknown; name?: unknown }): Agent {
    const os: HostOs = body.os === "windows" || body.os === "macos" || body.os === "linux" ? body.os : "windows";
    const d = structuredClone(this.load());
    const a: Agent = { device_id: deviceId, name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : "Computer", os, on: body.on !== false, at: now() };
    d.agents[deviceId] = a;
    this.save(d);
    return a;
  }

  agents(): (Agent & { listening: boolean })[] {
    const t = Date.now();
    return Object.values(this.load().agents).map((a) => ({ ...a, listening: a.on && t - (this.polled.get(a.device_id) ?? 0) < 90_000 }));
  }

  /** Forget a device's agent (the device was removed). */
  dropAgent(deviceId: string): void {
    const d = structuredClone(this.load());
    if (!d.agents[deviceId]) return;
    delete d.agents[deviceId];
    this.save(d);
  }

  /** Work waiting for this device; waits up to `waitMs` for some when there is none. Only while a helper is active. */
  async nextJobs(deviceId: string, waitMs: number): Promise<AgentJob[]> {
    this.polled.set(deviceId, Date.now());
    const mine = () => [...this.jobs.values()].map((j) => j.job).filter((j) => j.device_id === deviceId);
    if (mine().length || waitMs <= 0) return mine();
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(deviceId) ?? new Set();
      const done = () => { clearTimeout(t); set.delete(done); resolve(); };
      const t = setTimeout(done, waitMs);
      set.add(done);
      this.waiters.set(deviceId, set);
    });
    this.polled.set(deviceId, Date.now());
    return mine();
  }

  /** The app's answer to a job. */
  finishJob(deviceId: string, jobId: string, r: { exit_code?: unknown; output?: unknown }): boolean {
    const j = this.jobs.get(jobId);
    if (!j || j.job.device_id !== deviceId) return false;
    clearTimeout(j.timer);
    this.jobs.delete(jobId);
    const hk = (r as { host_key?: unknown }).host_key;
    j.resolve({ exit_code: typeof r.exit_code === "number" ? r.exit_code : 1, output: typeof r.output === "string" ? r.output.slice(0, 200_000) : "", ...(typeof hk === "string" && /^SHA256:[A-Za-z0-9+/=]{20,60}$/.test(hk) ? { host_key: hk } : {}) });
    return true;
  }

  /**
   * Run a command on one of the person's computers for a helper: secrets filled in from the helper vault, the job
   * handed to that computer's app, the answer back with the secrets cut out, and a line in the person's log.
   */
  async run(helper: Helper, body: { device?: unknown; command?: unknown; purpose?: unknown; kind?: unknown; timeout_s?: unknown; target?: unknown }): Promise<JobResult & { device: string }> {
    if (helper.state !== "active") throw new StoreError(403, "not helping now");
    const deviceId = String(body.device ?? "");
    const agent = this.load().agents[deviceId];
    if (!agent || !agent.on) throw new StoreError(404, "that computer does not let its helper run anything (Aeneas is not installed there, or it is turned off in its app)");
    const command = String(body.command ?? "").trim();
    if (!command || command.length > 20_000) throw new StoreError(422, "a command is needed");
    const purpose = String(body.purpose ?? "").trim().slice(0, 200) || "Checked something";
    const kind = body.kind === "change" ? "change" : "check";
    const timeout = Math.min(Math.max(Number(body.timeout_s) || 60, 5), MAX_RUN_S);
    // Another device in the home, signed in to over SSH from this computer, with the password saved for it.
    const target = sshTarget(body.target);
    const login = target ? await this.loginFor(target.ip, target.login) : null;
    const { command: filled, values } = await this.fill(command, target ? "linux" : agent.os);
    const job: AgentJob = {
      id: crypto.randomUUID(), device_id: deviceId, command: filled, os: target ? "linux" : agent.os, timeout_s: timeout, created_at: now(),
      ...(target && login ? { ssh: { ip: target.ip, port: target.port, username: login.username, password: login.password, ...(this.load().known_hosts?.[target.ip] ? { host_key: this.load().known_hosts![target.ip] } : {}) } } : {}),
    };
    if (login) values.push(login.password);
    const result = await new Promise<JobResult>((resolve) => {
      // An app that is closed or asleep never answers: the helper hears that, not silence.
      const timer = setTimeout(() => {
        this.jobs.delete(job.id);
        resolve({ exit_code: -1, output: this.agents().find((a) => a.device_id === deviceId)?.listening ? "The computer did not finish in time." : `${agent.name} is not reachable now: the Aeneas app there is closed, or the computer is off or asleep.` });
      }, (timeout + 15) * 1000);
      this.jobs.set(job.id, { job, resolve, timer });
      for (const w of [...(this.waiters.get(deviceId) ?? [])]) w();
    });
    const output = redactValues(result.output, values);
    const ok = result.exit_code === 0;
    // The first key a device answers with is kept; the app refuses a different one later (helper.rs).
    if (target && result.host_key && !this.load().known_hosts?.[target.ip]) {
      const d = structuredClone(this.load());
      d.known_hosts = { ...(d.known_hosts ?? {}), [target.ip]: result.host_key };
      this.save(d);
    }
    const where = target ? `${this.deviceName(target.ip)}, through ${agent.name}` : agent.name;
    this.record(helper, kind, where, `${purpose}${ok ? "" : " (it did not work)"}`, command, ok ? "done" : `exit ${result.exit_code}`);
    return { exit_code: result.exit_code, output, device: where };
  }

  /** A device in the home by address, as the scan named it. */
  private deviceName(ip: string): string {
    const d = this.scan()?.devices.find((x) => x.ip === ip);
    return d ? `${d.name || d.kind || "device"} (${ip})` : ip;
  }

  /** The saved login for a device in the home: the one named, else the one saved for that device's address. */
  private async loginFor(ip: string, title?: string): Promise<{ username: string; password: string }> {
    if (!this.vault.exists()) throw new StoreError(409, "no passwords have been saved for the helper yet");
    const entries = await this.vault.list();
    const e = title ? entries.find((x) => x.title.toLowerCase() === title.toLowerCase()) : entries.find((x) => x.url === ip);
    if (!e) throw new StoreError(409, `no password is saved for the device at ${ip}: they can save one in their app (Passwords, Is it for one of the devices in your home?)`);
    const username = (await this.vault.read(e.title, "username")) ?? "";
    const password = (await this.vault.read(e.title, "password")) ?? "";
    if (!username || !password) throw new StoreError(409, `the password "${e.title}" needs a user name and a password`);
    return { username, password };
  }

  /** Forget a device's key (it was reset or replaced), so the next sign-in takes its new one. */
  forgetHostKey(ip: string): boolean {
    const d = structuredClone(this.load());
    if (!d.known_hosts?.[ip]) return false;
    delete d.known_hosts[ip];
    this.save(d);
    return true;
  }

  // ---------- passwords for the helper ----------

  private async openVault(): Promise<KeePassVault> {
    this.ensureVaultPassword();
    if (!this.vault.exists()) await this.vault.create("Passwords for my helper");
    return this.vault;
  }

  /** Names and user names only, never a password. */
  async passwords(): Promise<{ title: string; username: string; device?: string }[]> {
    if (!this.vault.exists()) return [];
    return (await this.vault.list()).map((e) => ({ title: e.title, username: e.username ?? "", ...(e.url && /^(\d{1,3}\.){3}\d{1,3}$/.test(e.url) ? { device: e.url } : {}) }));
  }

  async putPassword(body: { title?: unknown; username?: unknown; password?: unknown; notes?: unknown; device?: unknown }): Promise<{ title: string; username: string }> {
    const title = typeof body.title === "string" ? body.title.trim().replace(/\s+/g, " ") : "";
    if (!title || /[{}/]/.test(title) || title.length > 80) throw new StoreError(422, "give it a name, like My computer or My email (no braces or slashes)");
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) throw new StoreError(422, "type the password");
    const v = await this.openVault();
    // The device in the home it signs in to, by address (from the scan), kept as the item's address.
    const device = typeof body.device === "string" && /^(\d{1,3}\.){3}\d{1,3}$/.test(body.device) ? body.device : undefined;
    const e = await v.put({ title, username: typeof body.username === "string" ? body.username.trim() : undefined, password, url: device, notes: typeof body.notes === "string" ? body.notes : undefined });
    for (const h of this.active()) this.record(h, "password", null, `You saved a password for ${h.name}: ${title}.`);
    return { title: e.title, username: e.username ?? "" };
  }

  async removePassword(title: string): Promise<boolean> {
    if (!this.vault.exists()) return false;
    const gone = await this.vault.remove(title);
    if (gone) for (const h of this.active()) this.record(h, "password", null, `You removed the password ${title}.`);
    return gone;
  }

  /** {{secret:Title}} (the password) or {{secret:Title/username}} filled in, quoted for the computer's shell. */
  private async fill(command: string, os: HostOs): Promise<{ command: string; values: string[] }> {
    const refs = [...new Set([...command.matchAll(SECRET_REF)].map((m) => m[1].trim()))];
    if (!refs.length) return { command, values: [] };
    if (!this.vault.exists()) throw new StoreError(409, "no passwords have been saved for the helper yet");
    const values = new Map<string, string>();
    for (const r of refs) {
      const [title, field] = r.includes("/") ? [r.slice(0, r.lastIndexOf("/")), r.slice(r.lastIndexOf("/") + 1)] : [r, "password"];
      const v = await this.vault.read(title, field === "username" || field === "user" ? "username" : "password");
      if (!v) throw new StoreError(404, `no saved password called ${title}`);
      values.set(r, v);
    }
    return { command: command.replace(SECRET_REF, (_, r: string) => quoteFor(os, values.get(r.trim())!)), values: [...values.values()] };
  }

  // ---------- what the person's app found on their network ----------

  setScan(by: string, body: { network?: unknown; devices?: unknown }): Scan {
    const list = Array.isArray(body.devices) ? body.devices : [];
    const devices: ScanDevice[] = list.slice(0, 512).flatMap((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const ip = typeof o.ip === "string" && /^(\d{1,3}\.){3}\d{1,3}$/.test(o.ip) ? o.ip : null;
      if (!ip) return [];
      const open = Array.isArray(o.open) ? o.open.filter((p): p is number => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 32) : [];
      return [{ name: typeof o.name === "string" ? o.name.slice(0, 80) : "", ip, open, ...(typeof o.kind === "string" ? { kind: o.kind.slice(0, 40) } : {}) }];
    });
    const scan: Scan = { at: now(), by, ...(typeof body.network === "string" ? { network: body.network.slice(0, 40) } : {}), devices };
    const d = structuredClone(this.load());
    d.scan = scan;
    this.save(d);
    for (const h of this.active()) this.record(h, "scan", by, `${by} looked for the devices in your home and found ${devices.length}.`);
    return scan;
  }

  scan(): Scan | null { return this.load().scan ?? null; }

  /** What the helper sees: the person's computers that let it run commands, what the scan found, and the password names. */
  async wardenView(): Promise<{ computers: (Agent & { listening: boolean })[]; scan: Scan | null; passwords: { title: string; username: string }[] }> {
    return { computers: this.agents().filter((a) => a.on), scan: this.scan(), passwords: await this.passwords() };
  }
}

/** A fresh helper key (the helper's hub makes it; the person's hub only ever sees its hash). */
export function newHelperKey(): { key: string; hash: string } {
  const key = HELPER_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
  return { key, hash: sha(key) };
}

export function helperKeyHash(key: string): string { return sha(key); }

/** `{ ip, port?, login? }` for a device in the home: a private IPv4 address only. */
function sshTarget(v: unknown): { ip: string; port: number; login?: string } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ip = typeof o.ip === "string" ? o.ip : "";
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m || m.slice(1).some((x) => Number(x) > 255)) throw new StoreError(422, "a device in the home is named by its address, like 192.168.1.20");
  const [a, b] = [Number(m[1]), Number(m[2])];
  const home = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!home) throw new StoreError(422, "only devices on the home network");
  const port = Number(o.port) > 0 && Number(o.port) < 65536 ? Number(o.port) : 22;
  return { ip, port, ...(typeof o.login === "string" && o.login.trim() ? { login: o.login.trim() } : {}) };
}

