import { execFile } from "node:child_process";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { loadHosts, type Host } from "./ai/hosts.js";
import { sshRunner, type SshRunner } from "./backups.js";
import { recordReading, sensorByName, stateFor } from "./sensors.js";
import { feedStdin } from "./child.js";
import { errCode } from "./logsafe.js";
import { readMachineInfo, setMachineOs, updateMachineInfo } from "./machineinfo.js";
import { StoreError } from "./store.js";
import { HOST_SCRIPTS } from "@everythingapp/shared";

/**
 * Module 4 and 6: the machines under Tech are sensors too, with nothing to set up. Every 10 minutes the hub reads CPU
 * and memory use, disk use, CPU, NVMe and GPU temperatures, GPU memory and ZFS pool health from the machines the person added (Machines,
 * hosts.json, reached over ssh; the hub machine itself directly), with one fixed read-only script per OS. A sensor is
 * made the first time a value comes in, with thresholds that alert (a disk past 90%, a degraded pool); CPU and memory
 * use have none, since a game or a build fills them for a while and that is fine; the owner can set one. A reading is
 * stored only when the value moved, the state changed or an hour passed, so a year stays small. A machine that is
 * asleep or away is skipped: its ping monitor already says so, and its sensors do not go stale for a week.
 */

const TICK_MS = 10 * 60_000;
const KEEP_MS = 60 * 60_000;
const STALE_MINUTES = 7 * 24 * 60;
/** Room for a Proxmox host, which reads each of its virtual machines too. */
const TIMEOUT_MS = 45_000;

/** `location`: a guest's own name, for a reading of a virtual machine or container read through its Proxmox host. */
export interface HostValue { name: string; value: number; unit: string; location?: string }
interface Spec { unit: string; min?: number; max?: number; band: number }

/** Thresholds and the change worth a reading, by what the value is (the last part of the sensor name). */
function specFor(name: string): Spec {
  // CPU is a 2-second sample every 10 minutes, so only a big move is worth a reading between the hourly ones.
  if (/(^|\.)cpu\.used$/.test(name)) return { unit: "%", band: 15 };
  if (/(^|\.)memory\.used$/.test(name)) return { unit: "%", band: 5 };
  if (name.endsWith(".used")) return { unit: "%", max: 90, band: 1 };
  if (name.endsWith(".pool")) return { unit: "%", max: 80, band: 1 };
  if (name.endsWith(".healthy")) return { unit: "", min: 1, band: 0 };
  if (name.endsWith(".vram")) return { unit: "%", band: 5 };
  if (/(^|\.)gpu\d+\.temp$/.test(name)) return { unit: "°C", max: 85, band: 3 };
  if (/(^|\.)nvme\d+\.temp$/.test(name)) return { unit: "°C", max: 70, band: 3 };
  return { unit: "°C", max: 90, band: 3 };
}

/** The script for a host and how it runs: remote command plus the script on stdin. */
export function hostScript(os: Host["os"]): { remote: string; stdin: string } {
  if (os === "windows") return { remote: "powershell -NoProfile -NonInteractive -Command -", stdin: HOST_SCRIPTS.windows };
  return { remote: "sh -s", stdin: os === "macos" ? HOST_SCRIPTS.macos : HOST_SCRIPTS.linux };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";

/** Values from a script's output, named `<host>.<thing>`. Lines it does not know are ignored. */
export function parseHostOutput(host: string, out: string): HostValue[] {
  const values: HostValue[] = [];
  const add = (name: string, value: number) => { if (Number.isFinite(value)) values.push({ name: `${host}.${name}`, value, unit: specFor(name).unit }); };
  const counts = new Map<string, number>();
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    const [tag, ...rest] = line.split(/\s+/);
    if ((tag === "cpu" || tag === "mem") && rest.length === 1) {
      add(tag === "cpu" ? "cpu.used" : "memory.used", parseFloat(rest[0]));
    } else if (tag === "disk" && rest.length >= 2) {
      const mount = rest.slice(0, -1).join(" ");
      add(`disk.${mount === "/" ? "root" : slug(mount)}.used`, parseFloat(rest.at(-1)!));
    } else if (tag === "temp" && rest.length === 2) {
      const kind = rest[0] === "nvme" ? "nvme" : "cpu";
      const n = counts.get(kind) ?? 0;
      counts.set(kind, n + 1);
      add(kind === "nvme" ? `nvme${n}.temp` : n ? `cpu${n}.temp` : "cpu.temp", Math.round(parseFloat(rest[1]) / 100) / 10);
    } else if (tag === "gpu") {
      const [index, temp, used, total] = line.slice(4).split(",").map((x) => parseFloat(x.trim()));
      if (!Number.isFinite(index)) continue;
      add(`gpu${index}.temp`, temp);
      if (total > 0) add(`gpu${index}.vram`, Math.round((1000 * used) / total) / 10);
    } else if (tag === "pool" && rest.length >= 3) {
      const name = slug(rest[0]);
      add(`zfs.${name}.pool`, parseFloat(rest[1]));
      add(`zfs.${name}.healthy`, rest[2] === "ONLINE" ? 1 : 0);
    }
  }
  return values;
}

export interface Guest { name: string; vmid: number; state: string; container: boolean; os?: string }

const pct = (used: number, total: number) => Math.round((1000 * used) / total) / 10;
const json = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
/** A disk inside a guest, as the guest agent names it: "C:\\" is c, "/" is root. */
const guestMount = (m: string) => (/^[A-Za-z]:\\?$/.test(m) ? m[0].toLowerCase() : m === "/" ? "root" : slug(m));
const SKIP_FS = /^(squashfs|tmpfs|devtmpfs|overlay|vfat|efivarfs|iso9660|udf)$/i;

/**
 * A Proxmox host's guests from its script output: every VM and container it lists (with its state), and readings for
 * the running ones, named after the guest (`ad.cpu.used`) and kept at the guest's own name. Memory only when the guest
 * reports it (balloon driver or container); disks only from the guest agent (or a container's own disk).
 */
export function parseGuests(out: string): { guests: Guest[]; values: HostValue[] } {
  const guests: Guest[] = [];
  const values: HostValue[] = [];
  const byId = new Map<number, Guest>();
  const add = (guest: string, thing: string, value: number) => {
    if (Number.isFinite(value)) values.push({ name: `${guest}.${thing}`, value, unit: specFor(thing).unit, location: guest });
  };
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("pvevm ")) {
      const j = json(line.slice(6)) as Record<string, any> | null;
      if (!j || typeof j.name !== "string" || typeof j.vmid !== "number") continue;
      const g: Guest = { name: slug(j.name), vmid: j.vmid, state: String(j.status ?? "unknown"), container: false };
      guests.push(g);
      byId.set(g.vmid, g);
      if (g.state !== "running") continue;
      if (typeof j.cpu === "number") add(g.name, "cpu.used", Math.round(j.cpu * 1000) / 10);
      const b = j.ballooninfo;
      if (b && typeof b.total_mem === "number" && typeof b.free_mem === "number" && b.total_mem > 0) add(g.name, "memory.used", pct(b.total_mem - b.free_mem, b.total_mem));
    } else if (line.startsWith("pvefs ")) {
      const m = /^pvefs (\d+) (.*)$/.exec(line);
      const g = m ? byId.get(Number(m[1])) : undefined;
      const list = m ? json(m[2]) : null;
      if (!g || !Array.isArray(list)) continue;
      const seen = new Set<string>();
      for (const fs of list as Record<string, any>[]) {
        const total = Number(fs["total-bytes"]), used = Number(fs["used-bytes"]);
        if (!(total > 0) || !Number.isFinite(used) || SKIP_FS.test(String(fs.type ?? "")) || typeof fs.mountpoint !== "string") continue;
        const d = guestMount(fs.mountpoint);
        if (seen.has(d)) continue;
        seen.add(d);
        add(g.name, `disk.${d}.used`, pct(used, total));
      }
    } else if (line.startsWith("pveos ")) {
      const m = /^pveos (\d+) (.*)$/.exec(line);
      const g = m ? byId.get(Number(m[1])) : undefined;
      const j = m ? (json(m[2]) as Record<string, any> | null) : null;
      const name = j && typeof j["pretty-name"] === "string" ? j["pretty-name"] : j && typeof j.name === "string" ? `${j.name} ${j.version ?? ""}` : "";
      const os = name.replace(/^Microsoft\s+/, "").replace(/[^\p{L}\p{N} .,()/_+:-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (g && os) g.os = os;
    } else if (line.startsWith("pvelxc ")) {
      const list = json(line.slice(7));
      if (!Array.isArray(list)) continue;
      for (const c of list as Record<string, any>[]) {
        if (typeof c.name !== "string") continue;
        const g: Guest = { name: slug(c.name), vmid: Number(c.vmid), state: String(c.status ?? "unknown"), container: true };
        guests.push(g);
        if (g.state !== "running") continue;
        if (typeof c.cpu === "number") add(g.name, "cpu.used", Math.round(c.cpu * 1000) / 10);
        if (c.maxmem > 0) add(g.name, "memory.used", pct(Number(c.mem), Number(c.maxmem)));
        if (c.maxdisk > 0) add(g.name, "disk.root.used", pct(Number(c.disk), Number(c.maxdisk)));
      }
    }
  }
  return { guests, values };
}

/** What the machine says it runs, from the script's `os` line, in plain printable text; null when it said nothing. */
export function parseHostOs(out: string): string | null {
  for (const raw of out.split(/\r?\n/)) {
    const m = /^os\s+(.+)$/.exec(raw.trim());
    if (!m) continue;
    const text = m[1].replace(/[^\p{L}\p{N} .,()/_+:-]/gu, "").replace(/\s+/g, " ").replace(/,\s*firmware\s*$/, "").trim().slice(0, 80);
    if (text && !/^(macos|os)?$/i.test(text)) return text;
  }
  return null;
}

/** Whether a new value is worth a reading: it moved past its band, changes the state, or an hour passed. */
export function worthKeeping(sensor: Entity | null, v: HostValue, now: Date): boolean {
  if (!sensor || typeof sensor.fields.last_value !== "number" || typeof sensor.fields.last_at !== "string") return true;
  if (stateFor(sensor, v.value) !== sensor.fields.state) return true;
  if (Math.abs(v.value - sensor.fields.last_value) > specFor(v.name).band) return true;
  return now.getTime() - new Date(sensor.fields.last_at).getTime() >= KEEP_MS;
}

/** Store what a host reported: new sensors get their thresholds; existing ones keep any the owner changed. */
/** Sensor names are at most 80 characters: a long mount path keeps its start and end, joined by "..". */
export function sensorName(name: string): string {
  return name.length <= 80 ? name : `${name.slice(0, 50)}..${name.slice(-28)}`;
}

export function storeHostValues(hub: Hub, host: string, values: HostValue[], now: Date = new Date()): number {
  let kept = 0;
  for (const raw of values) {
    // One value that cannot be stored no longer stops the rest of the machine's values (and its missing-value check).
    try {
      const v = { ...raw, name: sensorName(raw.name) };
      let sensor = sensorByName(hub, v.name);
      if (!sensor) {
        const s = specFor(v.name);
        sensor = hub.store.create("sensor", { name: v.name, unit: s.unit, location: v.location ?? host, alert: true, stale_minutes: STALE_MINUTES, ...(s.min !== undefined ? { min: s.min } : {}), ...(s.max !== undefined ? { max: s.max } : {}) });
      }
      if (!worthKeeping(sensor, v, now)) continue;
      recordReading(hub, v.name, { value: v.value, unit: v.unit || undefined, at: now.toISOString() }, now);
      kept++;
    } catch (e) {
      console.error(`[hostsensors] a value from one machine was not stored: ${errCode(e)}`);
    }
  }
  return kept;
}

const localRunner: SshRunner = (_dest, remote, stdin, timeoutMs) => new Promise((resolve) => {
  // The same command line ssh would run on that machine: through cmd.exe on a Windows hub, sh elsewhere.
  const [file, args] = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", remote]] : ["sh", ["-c", remote]];
  const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
  feedStdin(child, stdin);
});

/** The machines to read: every known host, once (a `-wifi` alias of a host is the same machine). */
export function sensorHosts(hosts: Host[]): Host[] {
  const names = new Set(hosts.map((h) => h.name));
  return hosts.filter((h) => !(h.name.endsWith("-wifi") && names.has(h.name.slice(0, -5))));
}

/** Ticks in a row a sensor was missing from its machine's report while the machine reported the rest. */
const missing = new WeakMap<Hub, Map<string, number>>();
/** Three ticks (30 minutes): one failed `nvidia-smi` is not a missing GPU. */
export const MISSING_TICKS = 3;

/**
 * A machine that answers but no longer reports one of its values (a pool not imported after a reboot, a data disk
 * that did not mount, the GPU driver gone) makes that sensor stale after MISSING_TICKS, with its notify. The week
 * of `stale_minutes` is for a machine that is away, not for one value missing from a machine that is here.
 */
export function markMissing(hub: Hub, host: string, values: HostValue[], now: Date = new Date()): string[] {
  let m = missing.get(hub);
  if (!m) { m = new Map(); missing.set(hub, m); }
  const present = new Set(values.map((v) => sensorName(v.name)));
  const out: string[] = [];
  for (const s of hub.store.list({ kind: "sensor", limit: 10000 })) {
    const name = String(s.fields.name);
    if (s.fields.location !== host || !name.startsWith(`${host}.`)) continue;
    if (present.has(name)) { m.delete(name); continue; }
    if (s.fields.state === "stale" || typeof s.fields.last_at !== "string") continue;
    const n = (m.get(name) ?? 0) + 1;
    m.set(name, n);
    if (n < MISSING_TICKS) continue;
    hub.store.patch(s.id, { state: "stale" });
    if (s.fields.alert !== false) hub.bus.emit("notify", { id: `sensor:${name}:stale:${now.toISOString()}`, kind: "sensor", title: `${name} stale: ${host} no longer reports it`, at: now.toISOString(), name, value: null, unit: String(s.fields.unit ?? ""), state: "stale" });
    m.delete(name);
    out.push(name);
  }
  return out;
}

export async function hostSensorTick(hub: Hub, run: SshRunner = sshRunner, now: Date = new Date()): Promise<{ host: string; values: number; kept: number; error?: string }[]> {
  const hosts = sensorHosts(loadHosts(hub.cfg));
  return Promise.all(hosts.map(async (h) => {
    const { remote, stdin } = hostScript(h.os);
    const r = await (h.local ? localRunner : run)(h.target, remote, stdin, TIMEOUT_MS);
    const own = parseHostOutput(h.name, r.stdout);
    // Guests the hub also reads directly (added as machines) keep their own readings, not a second set from the host.
    const known = new Set(hosts.flatMap((x) => x.aliases.concat(x.name)));
    const { guests, values: guestValues } = parseGuests(r.stdout);
    for (const g of guests) {
      if (known.has(g.name)) continue;
      try { updateMachineInfo(hub, g.name, { vm_of: h.name, vm_state: g.state, ...(g.os ? { os: g.os } : {}) }); } catch (e) { console.error(`[hostsensors] a guest was not kept: ${errCode(e)}`); }
    }
    const values = own.concat(guestValues.filter((v) => !known.has(String(v.location))));
    const os = parseHostOs(r.stdout);
    if (os) { try { setMachineOs(hub, h.name, os, now.toISOString()); } catch (e) { console.error(`[hostsensors] a machine's OS was not kept: ${errCode(e)}`); } }
    if (!values.length) return { host: h.name, values: 0, kept: 0, error: (r.stderr.trim().split("\n").at(-1) ?? `exit ${r.code}`).slice(0, 200) };
    const kept = storeHostValues(hub, h.name, values, now);
    markMissing(hub, h.name, values, now);
    return { host: h.name, values: values.length, kept };
  }));
}

/**
 * A computer that reports itself (since 2026-11-20): the Aeneas app on it runs the same reading script for its OS
 * (HOST_SCRIPTS) every 10 minutes and sends the output with its own device key, for a computer the hub does not
 * sign in to. Its readings are stored as the hub's own are, under the computer's name. A computer the hub already
 * reads keeps the hub's readings; a name another device still reports is refused, so two computers never mix.
 */
export const REPORT_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export function reportComputer(hub: Hub, deviceId: string, input: { name: string; output: string }, now: Date = new Date()): { name: string; read_by_hub: boolean; kept: number } {
  const name = input.name.trim().toLowerCase();
  if (!REPORT_NAME.test(name)) throw new StoreError(422, "the computer's name has letters, digits, dots, dashes or underscores");
  if (input.output.length > 64_000) throw new StoreError(413, "the report is too long");
  if (!hub.modules.on("homelab") && !hub.modules.on("sensors")) throw new StoreError(409, "Machines is off on this hub");
  const hosts = loadHosts(hub.cfg);
  if (hosts.some((h) => h.name === name || h.aliases.includes(name))) return { name, read_by_hub: true, kept: 0 };
  const info = readMachineInfo(hub)[name];
  if (info?.reported_by && info.reported_by !== deviceId) {
    const other = hub.store.get(info.reported_by);
    if (other && other.kind === "device" && !other.deleted_at) throw new StoreError(409, `another device already reports a computer named ${name}`);
  }
  const at = now.toISOString();
  updateMachineInfo(hub, name, { reported_by: deviceId, ...(info?.reported_at && now.getTime() - Date.parse(info.reported_at) < KEEP_MS ? {} : { reported_at: at }) });
  const os = parseHostOs(input.output);
  if (os) setMachineOs(hub, name, os, at);
  if (!hub.modules.on("sensors")) return { name, read_by_hub: false, kept: 0 };
  const values = parseHostOutput(name, input.output);
  const kept = storeHostValues(hub, name, values, now);
  if (values.length) markMissing(hub, name, values, now);
  return { name, read_by_hub: false, kept };
}

/** Every 10 minutes, first a minute after start. Off with EA_HOST_SENSORS=false. */
export function startHostSensorLoop(hub: Hub, intervalMs = TICK_MS): () => void {
  if (!hub.cfg.hostSensors) return () => {};
  let running = false;
  const tick = () => {
    if (running || !hub.modules.on("sensors")) return;
    running = true;
    hostSensorTick(hub)
      .then((rs) => { const kept = rs.reduce((n, r) => n + r.kept, 0); if (kept) console.log(`[hostsensors] ${kept} readings from ${rs.filter((r) => r.values).length} host(s)`); })
      .catch((e) => console.error(`[hostsensors] tick failed: ${errCode(e)}`))
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 60_000).unref();
  return () => clearInterval(timer);
}
