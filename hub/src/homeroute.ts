import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { homeAddress } from "./announce.js";
import { errCode } from "./logsafe.js";
import { isLoopback, isPrivateV4, type TlsFiles } from "./tls.js";

/**
 * The home route (link.ts decides when it runs): besides the link the hub was set up with (Direct link or Tailscale),
 * the hub answers on the home network, so devices on the same Wi-Fi keep syncing through it while the internet is down.
 *
 * - The hub's id (`<data>/hub-id`): apps tell one hub from another by it, so the same hub reached another way (home
 *   network, Direct link, Tailscale) is still the same hub.
 * - Its own certificate when EA_TLS_CERT is not set (`<data>/tls/home.crt` and `home.key`), made here with node:crypto
 *   alone and then kept for good, since devices pin it.
 * - A second listener, HTTPS only, on EA_HOME_PORT of every address. Before TLS starts it closes any connection that
 *   does not come from a private address and arrive on a private address of this machine: never loopback, never
 *   Tailscale (100.64.0.0/10), never a public address. Nothing on it counts as this machine.
 */

// ---------- the hub's id ----------

/** Crockford's base32, as pairing codes use it: no I, L, O or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const HUB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Bytes as Crockford base32, five bits a character, the last one padded with zero bits (16 bytes make 26). */
export function crockford32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

const ids = new Map<string, string | null>();

export const hubIdFile = (dataDir: string) => path.join(dataDir, "hub-id");

function readHubId(file: string): string | null {
  const v = fs.readFileSync(file, "utf8").trim();
  if (HUB_ID_RE.test(v)) return v;
  console.error("[home] the hub-id file is damaged; it is left as it is, and pairing links go out without the hub's id");
  return null;
}

/**
 * This hub's id: 16 random bytes as 26 characters of Crockford base32, made once and kept in `<data>/hub-id` (mode
 * 600), read once a run. A file that cannot be read is never written over (a new id would make every device think it
 * moved to another hub): links then go out without the id, as an older hub's do.
 */
export function hubId(dataDir: string): string | null {
  const known = ids.get(dataDir);
  if (known !== undefined) return known;
  const file = hubIdFile(dataDir);
  let id: string | null;
  try {
    id = readHubId(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[home] the hub-id file could not be read (${errCode(e)}); pairing links go out without the hub's id`);
      ids.set(dataDir, null);
      return null;
    }
    const made = crockford32(crypto.randomBytes(16));
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, `${made}\n`, { mode: 0o600, flag: "wx" });
      id = made;
    } catch (w) {
      // Made a moment ago by another run of the hub (a command beside the server): theirs is the one.
      if ((w as NodeJS.ErrnoException).code !== "EEXIST") { console.error(`[home] the hub-id file could not be written (${errCode(w)})`); return null; }
      try { id = readHubId(file); } catch { id = null; }
    }
  }
  ids.set(dataDir, id);
  return id;
}

// ---------- this machine's addresses ----------

/** Where the machine's addresses come from (tests put made-up ones here). */
export const lan = {
  /** The address of the adapter with the way out, as announce.ts picks it, or null. */
  wayOut: (): Promise<string | null> => homeAddress(),
  interfaces: (): NodeJS.Dict<os.NetworkInterfaceInfo[]> => os.networkInterfaces(),
  hostName: (): string => os.hostname(),
};

function privateV4(list: os.NetworkInterfaceInfo[]): string[] {
  return [...new Set(list.filter((a) => a.family === "IPv4" && !a.internal && isPrivateV4(a.address)).map((a) => a.address))];
}

/**
 * The hub's home network addresses now: the private IPv4 addresses of the adapter with the way out (the one the router
 * serves), or of every adapter when there is no way out to go by (no router answers the routing table).
 */
export async function homeAddresses(): Promise<string[]> {
  let out: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    out = await Promise.race([lan.wayOut(), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2000); timer.unref(); })]);
  } catch { out = null; } finally { clearTimeout(timer); }
  const all = Object.values(lan.interfaces()).filter((l): l is os.NetworkInterfaceInfo[] => !!l);
  const adapter = out ? all.find((l) => l.some((a) => a.address === out)) : undefined;
  return privateV4(adapter ?? all.flat());
}

/**
 * Whether a connection may go on: from a private address to a private address of this machine. With `loopback`,
 * this machine itself too (a Home Wi-Fi only hub's own port, which serves the local checks); the home route's own
 * listener never lets loopback in.
 */
export function homeConnectionAllowed(remote: string | undefined, local: string | undefined, opts: { loopback?: boolean } = {}): boolean {
  if (opts.loopback && isLoopback(remote) && isLoopback(local)) return true;
  return isPrivateV4(remote) && isPrivateV4(local);
}

// ---------- the home certificate ----------

/** DER, just enough of it for one certificate. */
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
function int(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  return tlv(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) groups.unshift(0x80 | (v & 0x7f));
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
}
/** UTCTime until 2049, GeneralizedTime after (RFC 5280, 4.1.2.5). */
function time(d: Date): Buffer {
  const s = `${d.toISOString().slice(0, 19).replace(/[-:T]/g, "")}Z`;
  const y = d.getUTCFullYear();
  return y >= 1950 && y < 2050 ? tlv(0x17, Buffer.from(s.slice(2), "ascii")) : tlv(0x18, Buffer.from(s, "ascii"));
}
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));

const OID = {
  ecdsaSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  subjectKeyId: "2.5.29.14",
  keyUsage: "2.5.29.15",
  altName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * A self-signed certificate for a TLS server, as the installer's openssl makes one: EC P-256 signed with SHA-256,
 * not a CA, for digital signatures and server use only, with the names and IPv4 addresses given, valid from an hour
 * ago (clocks differ) for `years`. Built here so the hub needs neither openssl nor another library.
 */
export function selfSignedCertificate(o: { name: string; dns: string[]; ips: string[]; years?: number; now?: Date }): TlsFiles {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const now = new Date(Math.floor((o.now ?? new Date()).getTime() / 1000) * 1000);
  const from = new Date(now.getTime() - 3600_000);
  const until = new Date(now);
  until.setUTCFullYear(until.getUTCFullYear() + (o.years ?? 10));
  const name = seq(set(seq(oid(OID.commonName), tlv(0x0c, Buffer.from(o.name, "utf8")))));
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const alt = seq(
    ...[...new Set(o.dns)].map((d) => tlv(0x82, Buffer.from(d, "ascii"))),
    ...[...new Set(o.ips)].filter((ip) => IPV4_RE.test(ip)).map((ip) => tlv(0x87, Buffer.from(ip.split(".").map(Number)))),
  );
  // The key's point (the last 65 bytes of a P-256 SubjectPublicKeyInfo), hashed as RFC 5280 4.2.1.2 says.
  const point = spki.subarray(spki.length - 65);
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(serial),
    seq(oid(OID.ecdsaSha256)),
    name,
    seq(time(from), time(until)),
    name,
    spki,
    tlv(0xa3, seq(
      ext(OID.basicConstraints, true, seq()),
      ext(OID.keyUsage, true, tlv(0x03, Buffer.from([0x07, 0x80]))),
      ext(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      ext(OID.altName, false, alt),
      ext(OID.subjectKeyId, false, tlv(0x04, crypto.createHash("sha1").update(point).digest())),
    )),
  );
  const der = seq(tbs, seq(oid(OID.ecdsaSha256)), tlv(0x03, Buffer.concat([Buffer.from([0]), crypto.sign("sha256", tbs, privateKey)])));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{1,64}/g, "$&\n")}-----END CERTIFICATE-----\n`;
  return {
    key: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }) as string),
    cert: Buffer.from(pem),
    fingerprint: crypto.createHash("sha256").update(der).digest("hex"),
  };
}

export function homeCertFiles(dataDir: string) {
  const dir = path.join(dataDir, "tls");
  return { dir, cert: path.join(dir, "home.crt"), key: path.join(dir, "home.key") };
}

const certs = new Map<string, TlsFiles>();

/** Why the home certificate cannot be used, in a sentence for Settings (never a path or a system message). */
export class HomeCertError extends Error {}

const UNUSABLE = "Move home.crt and home.key out of the hub's tls folder and restart the hub to make a new one.";

function readIfThere(file: string): Buffer | null {
  try { return fs.readFileSync(file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HomeCertError(`The home certificate could not be read (${(e as NodeJS.ErrnoException).code ?? "error"}).`);
  }
}

function checkedPair(cert: Buffer, key: Buffer): TlsFiles {
  let x509: crypto.X509Certificate;
  let priv: crypto.KeyObject;
  try { x509 = new crypto.X509Certificate(cert); priv = crypto.createPrivateKey(key); } catch { throw new HomeCertError(`The home certificate or its key is damaged. ${UNUSABLE}`); }
  if (!x509.checkPrivateKey(priv)) throw new HomeCertError(`The home certificate's key does not belong to it. ${UNUSABLE}`);
  return { key, cert, fingerprint: crypto.createHash("sha256").update(x509.raw).digest("hex") };
}

/** A new file with its mode from the start, put in place whole. */
function writeNew(file: string, data: Buffer, mode: number): void {
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, data, { mode, flag: "wx" });
  fs.renameSync(tmp, file);
}

function shortHost(h: string): string {
  const s = h.split(".")[0];
  return /^[A-Za-z0-9-]{1,63}$/.test(s) ? s : "";
}

/**
 * The certificate the home route serves when the hub has none of its own (EA_TLS_CERT): `<data>/tls/home.crt` and
 * `home.key` (key 600, folder 700). Made the first time, for this machine's private IPv4 addresses, 127.0.0.1,
 * localhost, its host name and `<host>.local`, and kept from then on, since devices pin it. Half a pair (a write cut
 * off) is made again; a pair that cannot be used is an error, never replaced on its own. Null with `make: false` when
 * none was made yet.
 */
export function homeCertificate(dataDir: string, opts: { make?: boolean } = {}): TlsFiles | null {
  const known = certs.get(dataDir);
  if (known) return known;
  const f = homeCertFiles(dataDir);
  const cert = readIfThere(f.cert);
  const key = readIfThere(f.key);
  let files: TlsFiles;
  if (cert && key) files = checkedPair(cert, key);
  else if (opts.make === false) return null;
  else {
    const host = shortHost(lan.hostName());
    files = selfSignedCertificate({
      name: "Aeneas hub",
      dns: ["localhost", ...(host ? [host, `${host}.local`] : [])],
      ips: ["127.0.0.1", ...privateV4(Object.values(lan.interfaces()).flatMap((l) => l ?? []))],
    });
    fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(f.dir, 0o700);
    writeNew(f.key, files.key, 0o600);
    writeNew(f.cert, files.cert, 0o644);
    console.log(`[home] made the hub's certificate for the home network, valid 10 years (sha256 ${files.fingerprint})`);
  }
  certs.set(dataDir, files);
  return files;
}

// ---------- another person's hub on this machine ----------

/**
 * Whether `port` is the port of a hub in the list deploy/people.sh keeps of the hubs on this machine. people.sh numbers
 * them from 8788 up, the default home port of a hub on 8787, so the home route leaves those alone: taking one on every
 * address would stop that person's hub from starting.
 */
export function portOfAnotherHub(port: number): boolean {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(process.env.EA_PEOPLE_ROOT || "/", "etc", "aeneas", "people.json"), "utf8")) as unknown;
    return Array.isArray(list) && list.some((p) => Number((p as { port?: unknown })?.port) === port);
  } catch { return false; }
}

// ---------- the listener ----------

export interface HomeState { listening: boolean; port: number; fp: string | null; error?: string }

/** What a person reads in Settings when the port cannot be opened. */
function bindError(port: number, e: NodeJS.ErrnoException): string {
  if (e.code === "EADDRINUSE") return `Port ${port} is already in use on this computer, so the hub does not answer on the home network yet. It tries again every few minutes; if another program keeps the port, set EA_HOME_PORT in hub.env to a free port and restart the hub.`;
  if (e.code === "EACCES") return `This hub may not open port ${port}. Set EA_HOME_PORT in hub.env to a port above 1024 and restart the hub.`;
  return `The hub could not open port ${port} for the home network (${e.code ?? "error"}).`;
}

interface Running { front: net.Server; sockets: Set<net.Socket>; port: number; fp: string }

/**
 * The home route's own listener: the same app as the hub's port, over HTTPS only (no plain HTTP at all), for the home
 * network only. Started, moved and stopped by link.ts as the settings change; one change at a time. A port in use (the
 * hub's last run still closing, another program) is tried again after 15 s, 30 s, 1 min, 2 min, then every 5 min.
 */
export class HomeListener {
  private run: Running | null = null;
  private error_: string | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private listener: http.RequestListener;
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;
  /** Bumped by every start, stop and failure when it is asked for: only the latest one is carried out or tried again. */
  private changes = 0;

  constructor(fetch: (req: Request, env?: unknown) => Response | Promise<Response>, private opts: { host?: string; retryMs?: number[]; onListening?: () => void } = {}) {
    const app = getRequestListener(fetch as never);
    // Checked again where the app reads it: the address is read (and so kept) while the connection is surely open,
    // and a request whose address is gone is dropped, since the app counts a missing address as this machine.
    this.listener = (req, res) => {
      if (!isPrivateV4(req.socket.remoteAddress)) { req.socket.destroy(); return; }
      void app(req, res);
    };
  }

  state(): HomeState {
    const r = this.run;
    return { listening: !!r, port: r?.port ?? 0, fp: r?.fp ?? null, ...(this.error_ ? { error: this.error_ } : {}) };
  }

  /** Serves `files` on `port`, or goes on serving when it already does exactly that. */
  start(files: TlsFiles, port: number): Promise<HomeState> {
    const change = ++this.changes;
    return this.queue(() => this.open(files, port, change));
  }

  /** Stops taking connections; the open ones end after `graceMs` (the answer to the request that turned it off gets out). */
  stop(graceMs = 0): Promise<void> {
    ++this.changes;
    return this.queue(async () => { this.close(graceMs); this.error_ = undefined; });
  }

  /** Not serving, for the reason given (shown in Settings). */
  fail(error: string): Promise<void> {
    ++this.changes;
    return this.queue(async () => { this.close(0); this.error_ = error; });
  }

  private queue<T>(f: () => Promise<T>): Promise<T> {
    const p = this.chain.then(f, f);
    this.chain = p.catch(() => {});
    return p;
  }

  private close(graceMs: number): void {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.failures = 0;
    const r = this.run;
    this.run = null;
    if (!r) return;
    r.front.close();
    const drop = () => { for (const s of r.sockets) s.destroy(); };
    if (graceMs > 0) setTimeout(drop, graceMs).unref();
    else drop();
    console.log("[home] stopped answering on the home network");
  }

  private async open(files: TlsFiles, port: number, change: number, again = false): Promise<HomeState> {
    // A later start or stop was asked for after this one: that one decides.
    if (change !== this.changes) return this.state();
    if (this.run && this.run.fp === files.fingerprint && (this.run.port === port || port === 0)) return this.state();
    const failures = again ? this.failures : 0;
    this.close(0);
    this.failures = failures;
    const secure = https.createServer({ key: files.key, cert: files.cert, minVersion: "TLSv1.2", handshakeTimeout: 20_000 }, this.listener);
    // A failed handshake (plain HTTP, or a device that does not have this certificate yet) ends that connection only.
    secure.on("tlsClientError", (_e, socket) => socket.destroy());
    const sockets = new Set<net.Socket>();
    const front = net.createServer((socket) => {
      if (!homeConnectionAllowed(socket.remoteAddress, socket.localAddress)) { socket.destroy(); return; }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      secure.emit("connection", socket);
    });
    // The HTTPS server never listens itself: its header and request time limits start with the front's.
    front.on("listening", () => secure.emit("listening"));
    front.on("close", () => secure.close());
    const failed = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      front.once("error", resolve);
      front.listen({ port, host: this.opts.host ?? "0.0.0.0" }, () => { front.removeListener("error", resolve); resolve(null); });
    });
    if (failed) {
      this.error_ = bindError(port, failed);
      console.error(`[home] the home network route did not start on port ${port} (${errCode(failed)})`);
      if (failed.code === "EADDRINUSE") {
        const delays = this.opts.retryMs ?? [15_000, 30_000, 60_000, 120_000, 300_000];
        const wait = delays[Math.min(this.failures++, delays.length - 1)];
        this.retry = setTimeout(() => {
          this.retry = null;
          void this.queue(async () => {
            // Only while nothing was asked for since (open checks the same).
            if (change !== this.changes) return;
            const st = await this.open(files, port, change, true);
            if (st.listening) this.opts.onListening?.();
          });
        }, wait);
        this.retry.unref();
      }
      return this.state();
    }
    // Later trouble (no file handles left for a new connection) is logged; the hub goes on.
    front.on("error", (e) => console.error(`[home] home network listener: ${errCode(e)}`));
    const bound = (front.address() as net.AddressInfo).port;
    this.run = { front, sockets, port: bound, fp: files.fingerprint };
    this.error_ = undefined;
    console.log(`[home] answering on the home network, port ${bound}, HTTPS only (certificate sha256 ${files.fingerprint})`);
    return this.state();
  }
}
