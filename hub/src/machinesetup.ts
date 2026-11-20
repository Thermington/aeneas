import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { Client } from "ssh2";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { readMachines, writeMachines, type HostFileEntry, type HostOs } from "./ai/hosts.js";

/**
 * Add machine sets up the hub's access itself (Tech, since 2026-11-20), so nobody has to copy SSH keys by hand:
 * 1. the hub's own key: the hub machine's default SSH key, made (ed25519, no passphrase) when there is none;
 * 2. one sign-in with the password the owner typed (or a password manager item), never written anywhere: it puts the
 *    hub's key in the account's authorized keys (Linux, Mac, a NAS, or Windows' OpenSSH, administrators' file for an
 *    administrator) and reads what the machine is called;
 * 3. the machine's host key is kept in known_hosts as it was seen at that sign-in;
 * 4. a sign-in with the key alone, as every later reading and command signs in; only then is the machine added.
 * Only port 22. Nothing is changed on the machine except the one line in its authorized keys.
 */

/** `port` is for tests; the apps and the assistant always use 22. */
export interface SetupInput { address: string; user: string; password: string; name?: string; port?: number }
export interface SetupResult { machine: HostFileEntry; created: boolean }

const ADDRESS = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$|^\d{1,3}(?:\.\d{1,3}){3}$/;
const USER = /^[A-Za-z0-9._-]{1,64}(?:@[A-Za-z0-9.-]{1,128})?$/;
/** The folder ssh itself reads (the account's own home, not $HOME); EA_SSH_DIR for tests. */
const SSH_DIR = () => process.env.EA_SSH_DIR || path.join(os.userInfo().homedir, ".ssh");
const TIMEOUT_MS = 20_000;

function run(file: string, args: string[], timeoutMs = 30_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (e, out, err) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out ?? ""), err: String(err ?? "") }));
  });
}

/** The hub's public key: the hub machine's default one, or a new ed25519 key made for it. */
export async function hubPublicKey(): Promise<string> {
  for (const f of ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"]) {
    const p = path.join(SSH_DIR(), f);
    if (fs.existsSync(p) && fs.existsSync(p.slice(0, -4))) return fs.readFileSync(p, "utf8").trim();
  }
  fs.mkdirSync(SSH_DIR(), { recursive: true, mode: 0o700 });
  const key = path.join(SSH_DIR(), "id_ed25519");
  const r = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `aeneas-hub@${os.hostname().split(".")[0]}`, "-f", key]);
  if (r.code !== 0 || !fs.existsSync(`${key}.pub`)) throw new StoreError(500, "the hub could not make its SSH key (is ssh-keygen installed on the hub's machine?)");
  return fs.readFileSync(`${key}.pub`, "utf8").trim();
}

function portOpen(host: string, port: number, ms = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** The POSIX steps: the key in ~/.ssh/authorized_keys once, then what the machine runs and is called. */
export function posixInstall(pub: string): string {
  const q = pub.replace(/'/g, "");
  return `umask 077; mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && (grep -qxF '${q}' "$HOME/.ssh/authorized_keys" || echo '${q}' >> "$HOME/.ssh/authorized_keys") && echo "ok=1"; echo "kernel=$(uname -s)"; echo "host=$(hostname 2>/dev/null | cut -d. -f1)"`;
}

/** The Windows steps (OpenSSH Server): an administrator's key goes in the administrators' file, with its required ACL. */
export function windowsInstall(pub: string): string {
  const q = pub.replace(/'/g, "");
  const script = [
    `$k = '${q}'`,
    "$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    "if ($admin) { $f = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys' } else { $d = Join-Path $env:USERPROFILE '.ssh'; New-Item -ItemType Directory -Force -Path $d | Out-Null; $f = Join-Path $d 'authorized_keys' }",
    "if (!(Test-Path $f) -or !((Get-Content $f) -contains $k)) { Add-Content -Path $f -Value $k -Encoding ascii }",
    "if ($admin) { icacls $f /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null }",
    "'ok=1'",
    "'kernel=Windows'",
    "'host=' + $env:COMPUTERNAME",
  ].join("; ");
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

/** key=value lines from the install's output. */
export function parseInstall(out: string): { ok: boolean; os?: HostOs; host?: string } {
  const v = Object.fromEntries(out.split(/\r?\n/).map((l) => /^(\w+)=(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2].trim()]));
  const os: HostOs | undefined = v.kernel === "Darwin" ? "macos" : v.kernel === "Windows" ? "windows" : v.kernel ? "linux" : undefined;
  const host = (v.host ?? "").toLowerCase().replace(/[^a-z0-9._-]/g, "").replace(/^[^a-z0-9]+/, "").slice(0, 63);
  return { ok: v.ok === "1", ...(os ? { os } : {}), ...(host ? { host } : {}) };
}

/** A host key line for known_hosts from the key blob the server showed (its type is the blob's first string). */
export function knownHostsLine(address: string, blob: Buffer, port = 22): string {
  const len = blob.readUInt32BE(0);
  const type = blob.toString("latin1", 4, 4 + len);
  return `${port === 22 ? address : `[${address}]:${port}`} ${type} ${blob.toString("base64")}`;
}

/** The hub's own private key file (beside its public key), for the check that signing in with it works. */
function hubKeyFile(): string | null {
  for (const f of ["id_ed25519", "id_ecdsa", "id_rsa"]) if (fs.existsSync(path.join(SSH_DIR(), f))) return path.join(SSH_DIR(), f);
  return null;
}

/** Keep the host key as seen, unless known_hosts already has one for that address (then ssh checks it as usual). */
async function rememberHostKey(address: string, blob: Buffer, port: number): Promise<void> {
  const file = path.join(SSH_DIR(), "known_hosts");
  if (fs.existsSync(file)) {
    const r = await run("ssh-keygen", ["-F", port === 22 ? address : `[${address}]:${port}`, "-f", file]);
    if (r.code === 0 && r.out.trim()) return;
  }
  fs.mkdirSync(SSH_DIR(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${knownHostsLine(address, blob, port)}\n`, { mode: 0o600 });
}

/** One sign-in with a password: runs the command and returns its output. The password is only in this call. */
function withPassword(address: string, port: number, user: string, password: string, command: (exec: (cmd: string) => Promise<string>) => Promise<void>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let hostKey: Buffer | null = null;
    let settled = false;
    const finish = (e?: Error) => { if (settled) return; settled = true; c.end(); if (e) reject(e); else resolve(hostKey!); };
    const exec = (cmd: string) => new Promise<string>((res, rej) => {
      c.exec(cmd, (err, stream) => {
        if (err) { rej(err); return; }
        let out = "";
        stream.on("data", (d: Buffer) => { out += d.toString("utf8"); });
        stream.stderr.on("data", () => { /* errors show as a missing ok=1 */ });
        stream.on("close", () => res(out));
      });
    });
    // Ask which sign-in methods the machine takes first ("none"), so one that takes only keys is told apart from a
    // wrong password; then the password, then the same password typed into a prompt (keyboard-interactive).
    const tried = { password: false, keyboard: false };
    let keysOnly = false;
    const authHandler = (left: string[] | null, _partial: boolean | null, next: (m: unknown) => void) => {
      if (left === null) return next({ type: "none", username: user });
      if (left.includes("password") && !tried.password) { tried.password = true; return next({ type: "password", username: user, password }); }
      if (left.includes("keyboard-interactive") && !tried.keyboard) {
        tried.keyboard = true;
        return next({ type: "keyboard-interactive", username: user, prompt: (_n: string, _i: string, _l: string, prompts: unknown[], done: (answers: string[]) => void) => done(prompts.map(() => password)) });
      }
      if (!tried.password && !tried.keyboard) keysOnly = true;
      return next(false);
    };
    c.on("ready", () => { command(exec).then(() => finish(), (e: Error) => finish(e)); });
    c.on("error", (e: Error & { level?: string }) => finish(
      e.level !== "client-authentication" ? new StoreError(502, `could not sign in to ${address}: ${e.message.slice(0, 120)}`)
        : keysOnly ? new StoreError(409, `${address} takes no passwords for SSH sign-in, only keys. Put the hub's key in that account's authorized keys yourself, then add it under "The hub can already sign in to it", which shows the key.`)
          : new StoreError(401, `${address} did not accept that user name and password`),
    ));
    c.connect({ host: address, port, username: user, authHandler: authHandler as never, readyTimeout: TIMEOUT_MS, hostVerifier: (key: Buffer) => { hostKey = Buffer.from(key); return true; } });
  });
}

/** A sign-in with the hub's key alone, the way readings and commands sign in afterwards. */
async function keyWorks(dest: string, port: number, windows: boolean, knownHosts = path.join(SSH_DIR(), "known_hosts")): Promise<boolean> {
  const key = hubKeyFile();
  const r = await run("ssh", [...(key ? ["-i", key, "-o", "IdentitiesOnly=yes"] : []), "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", "-o", "LogLevel=ERROR", "-p", String(port), dest, windows ? "cmd /c echo ok" : "echo ok"], 20_000);
  return r.code === 0 && /ok/.test(r.out);
}

/** Set up the hub's access to a machine and add it (see the file's comment). Throws a StoreError in plain words. */
export async function setupMachineAccess(hub: Hub, input: SetupInput): Promise<SetupResult> {
  const address = input.address.trim().toLowerCase();
  const user = input.user.trim();
  if (!ADDRESS.test(address)) throw new StoreError(422, "the address is a name or an IP address, like nas.local or 192.168.1.20");
  if (!USER.test(user)) throw new StoreError(422, "the user name has letters, digits, dots, dashes or underscores");
  if (!input.password) throw new StoreError(422, "the password is needed once, to add the hub's key");
  const port = input.port ?? 22;
  if (!(await portOpen(address, port))) {
    throw new StoreError(409, `${address} does not answer for sign-in (SSH). Turn it on there: on a Mac, System Settings, General, Sharing, Remote Login; on Windows, Settings, System, Optional features, OpenSSH Server; on Linux, install openssh-server.`);
  }
  const pub = await hubPublicKey();
  let installed: ReturnType<typeof parseInstall> = { ok: false };
  const hostKey = await withPassword(address, port, user, input.password, async (exec) => {
    const probe = (await exec("echo %OS%")).trim();
    const windows = probe === "Windows_NT";
    installed = parseInstall(await exec(windows ? windowsInstall(pub) : posixInstall(pub)));
  });
  if (!installed.ok) throw new StoreError(502, `signed in to ${address}, but the hub's key could not be added to that account`);
  await rememberHostKey(address, hostKey, port);
  const dest = `${user}@${address}`;
  if (!(await keyWorks(dest, port, installed.os === "windows"))) {
    throw new StoreError(502, `the hub's key was added on ${address}, but signing in with it did not work (the SSH server may not allow keys for this account)`);
  }
  const wanted = (input.name ?? "").trim().toLowerCase();
  return addMachine(hub, dest, /^[a-z0-9][a-z0-9._-]{0,62}$/.test(wanted) ? wanted : installed.host || address.split(".")[0].replace(/[^a-z0-9-]/g, "") || "machine", installed.os);
}

/** Add the machine once signing in with the key worked: the same account again updates it, a taken name gets -2. */
function addMachine(hub: Hub, dest: string, base: string, os: HostOs | undefined): SetupResult {
  const list = readMachines(hub.cfg) ?? [];
  const same = list.find((m) => (m.ssh ?? m.name) === dest);
  let name = same?.name ?? base;
  for (let i = 2; !same && list.some((m) => m.name === name); i++) name = `${base}-${i}`;
  const machine: HostFileEntry = { name, ssh: dest, ...(os ? { os } : {}) };
  writeMachines(hub.cfg, same ? list.map((m) => (m === same ? { ...m, ...machine } : m)) : [...list, machine]);
  hub.ai.hosts.forget();
  return { machine, created: !same };
}

/**
 * A computer whose Aeneas app set up the hub's access itself (since 2026-11-20): the app turned on its SSH server,
 * put the hub's key (GET /machines/hub-key) in the account's authorized keys, and sends its SSH host keys, read on
 * that computer, over its own device key. The hub tries the addresses it may be reached at, trusting only those host
 * keys, and adds it as the first that signs in with the hub's key. known_hosts then holds those keys for that
 * address (older lines for it go, since the computer itself just said which keys are its own).
 */
export interface AdoptInput { name: string; user: string; os: HostOs; host_keys: string[]; addresses: string[]; port?: number }
const HOST_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([A-Za-z0-9+/]{40,}={0,2})(?:\s.*)?$/;

export function hostKeysOf(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.slice(0, 8).map((k) => HOST_KEY.exec(String(k ?? "").trim())).filter((m): m is RegExpExecArray => !!m).map((m) => `${m[1]} ${m[2]}`))];
}

export async function adoptComputer(hub: Hub, input: AdoptInput): Promise<SetupResult> {
  const name = input.name.trim().toLowerCase();
  const user = input.user.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) throw new StoreError(422, "the computer's name has letters, digits, dots, dashes or underscores");
  if (!USER.test(user)) throw new StoreError(422, "the user name has letters, digits, dots, dashes or underscores");
  const keys = hostKeysOf(input.host_keys);
  if (!keys.length) throw new StoreError(422, "the computer's SSH host keys are needed, to know it is that computer");
  const addresses = [...new Set(input.addresses.map((a) => a.trim().toLowerCase()).filter((a) => ADDRESS.test(a)))].slice(0, 4);
  if (!addresses.length) throw new StoreError(422, "no address to reach the computer at");
  const port = input.port ?? 22;
  const list = readMachines(hub.cfg) ?? [];
  const taken = list.find((m) => m.name === name);
  if (taken && !addresses.some((a) => taken.ssh === `${user}@${a}`)) throw new StoreError(409, `${name} is already one of the hub's machines`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ea-adopt-"));
  try {
    for (const address of addresses) {
      if (!(await portOpen(address, port, 3000))) continue;
      const host = port === 22 ? address : `[${address}]:${port}`;
      const trial = path.join(tmp, "known_hosts");
      fs.writeFileSync(trial, keys.map((k) => `${host} ${k}\n`).join(""), { mode: 0o600 });
      const dest = `${user}@${address}`;
      if (!(await keyWorks(dest, port, input.os === "windows", trial))) continue;
      const file = path.join(SSH_DIR(), "known_hosts");
      fs.mkdirSync(SSH_DIR(), { recursive: true, mode: 0o700 });
      if (fs.existsSync(file)) await run("ssh-keygen", ["-R", host, "-f", file]);
      fs.appendFileSync(file, keys.map((k) => `${host} ${k}\n`).join(""), { mode: 0o600 });
      fs.rmSync(`${file}.old`, { force: true });
      return addMachine(hub, dest, name, input.os);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  throw new StoreError(502, `the hub could not sign in to ${name} at ${addresses.join(" or ")} with its key: the hub and this computer need to be on the same network or tailnet, and its SSH server needs to be on`);
}
