import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { listHubs, personHub, wardPerson } from "./hubs.js";
import { newHelperKey } from "./helpers.js";
import type { HelpingEntry } from "./imports/connections.js";
import type { Host, HostOs, RunResult } from "./ai/hosts.js";
import { errCode } from "./logsafe.js";

/**
 * The owner's side of helping someone with their devices (helpers.ts is that person's side). Only the machine owner's
 * hub offers, and only to people with a hub on this machine (People on this machine): their hub answers on 127.0.0.1
 * at its own port, so nothing about it leaves the machine.
 *
 * Offering makes a key here and sends only its SHA-256 through people.sh's root service (`ward`); the key itself is
 * kept with this hub's sealed connection secrets. Once the person says yes in their app, their computers that let
 * their helper in (the Aeneas app there) show up as machines for the assistant (run_command, approve_command): read
 * only commands run at once and changes wait for the owner's yes, as for the owner's own machines. The person is never
 * asked; their hub logs everything for them to read.
 */

/** `not_sent`: their hub has no such offer (the machine's root service could not deliver it): offer again. */
export type HelpState = "waiting" | "helping" | "stopped" | "unreachable" | "not_sent";

export interface HelpComputer { device_id: string; name: string; os: HostOs; listening: boolean }
export interface HelpView {
  account: string;
  name: string;
  state: HelpState;
  offered_at: string;
  computers: HelpComputer[];
  scan: { at: string; by: string; devices: { name: string; ip: string; open: number[]; kind?: string }[] } | null;
  passwords: { title: string; username: string }[];
}

const entries = (hub: Hub): HelpingEntry[] => hub.connections.get().helping ?? [];

/** A call to a helped person's hub on this machine, with the helper key. */
async function wardenCall(hub: Hub, e: HelpingEntry, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<{ status: number; data: any }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await hub.fetch(`http://127.0.0.1:${e.port}${path}`, {
      method, signal: ctl.signal,
      headers: { authorization: `Bearer ${e.key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  } finally { clearTimeout(t); }
}

/** Each person this hub helps, as their hub answers now. */
export async function helpingView(hub: Hub): Promise<HelpView[]> {
  return Promise.all(entries(hub).map(async (e) => {
    const base = { account: e.account, name: e.name, offered_at: e.offered_at, computers: [], scan: null, passwords: [] };
    try {
      const r = await wardenCall(hub, e, "GET", "/warden/me");
      if (r.status === 200 && r.data) {
        cacheComputers(e, r.data.computers ?? [], r.data.scan ?? null);
        return { ...base, state: "helping" as const, computers: (r.data.computers ?? []).map(comp), scan: r.data.scan ?? null, passwords: r.data.passwords ?? [] };
      }
      cacheComputers(e, []);
      const state = r.data?.state === "offered" ? "waiting" as const : r.data?.state === "stopped" ? "stopped" as const : r.status === 401 ? "not_sent" as const : "unreachable" as const;
      return { ...base, state };
    } catch {
      return { ...base, state: "unreachable" as const };
    }
  }));
}

const comp = (c: Record<string, unknown>): HelpComputer => ({ device_id: String(c.device_id), name: String(c.name ?? "Computer"), os: (c.os as HostOs) ?? "windows", listening: !!c.listening });

/** Offer to help: a key made here, its hash to the person's hub through the root service; they say yes in their app. */
export function offerHelp(hub: Hub, account: string): { request_id: string } {
  const p = personHub(account);
  const helper = (hub.profile.get().name || (hub.cfg.ownerName !== "the owner" ? hub.cfg.ownerName : "") || "").trim();
  if (!helper) throw new StoreError(409, "set your name first (Settings, Set up): it is how they will see you");
  const { key, hash } = newHelperKey();
  const r = wardPerson(account, helper.split(/\s+/)[0].slice(0, 30), hash);
  hub.connections.update((c) => {
    c.helping = [...(c.helping ?? []).filter((x) => x.account !== account), { account, name: p.name, port: p.port, key, offered_at: new Date().toISOString() }];
  });
  return r;
}

/** Stop helping: the person's hub ends the key, and this hub forgets it. */
export async function stopHelping(hub: Hub, account: string): Promise<{ stopped: boolean }> {
  const e = entries(hub).find((x) => x.account === account);
  if (!e) throw new StoreError(404, "you do not help them");
  try { await wardenCall(hub, e, "DELETE", "/warden/me"); } catch (err) { console.error(`[helping] could not tell their hub: ${errCode(err)}`); }
  hub.connections.update((c) => { c.helping = (c.helping ?? []).filter((x) => x.account !== account); });
  computers.delete(account);
  return { stopped: true };
}

// ---------- their computers as machines for the assistant ----------

/** The computers each helped person's hub last listed, by account. Refreshed by helpingView and every minute. */
type ScanDevice = { name: string; ip: string; open: number[]; kind?: string };
const computers = new Map<string, { name: string; list: HelpComputer[]; ssh: ScanDevice[] }>();

function cacheComputers(e: HelpingEntry, list: Record<string, unknown>[], scan: { devices?: ScanDevice[] } | null = null): void {
  // Devices in their home that take SSH (the scan saw port 22), other than their computers' own addresses.
  const ssh = (scan?.devices ?? []).filter((d) => d.open?.includes(22) && d.name !== "This computer");
  computers.set(e.account, { name: e.name, list: list.map(comp), ssh });
}

/** "Mom's computer": how the assistant and the owner name a helped person's computer. */
export function computerName(person: string, computer: string, many: boolean): string {
  const owner = person.endsWith("s") ? `${person}'` : `${person}'s`;
  return many ? `${owner} ${computer}` : `${owner} computer`;
}

/** Hosts for HostActions.extraHosts: one per computer that lets its helper in. */
export function helpedHosts(): Host[] {
  const out: Host[] = [];
  for (const [account, { name, list, ssh }] of computers) {
    // Signed in to over SSH from the first of their computers that answers now (else the first one).
    const via = list.find((c) => c.listening) ?? list[0];
    if (via) {
      for (const d of ssh) {
        const n = `${name.endsWith("s") ? `${name}'` : `${name}'s`} ${d.name || d.kind || "device"} (${d.ip})`;
        out.push({
          name: n, aliases: [n.toLowerCase(), d.ip], target: `helped:${account}:${via.device_id}:${d.ip}`, os: "linux", local: false,
          via: `SSH from ${name}'s ${via.name} on their home network, signed in with the password they saved for this device`,
          helper: { account, device: via.device_id, ip: d.ip, port: 22 },
        });
      }
    }
    for (const c of list) {
      const n = computerName(name, c.name, list.length > 1);
      out.push({
        name: n, aliases: [n.toLowerCase(), `${name.toLowerCase()} computer`, `${name.toLowerCase()}'s ${c.name.toLowerCase()}`],
        target: `helped:${account}:${c.device_id}`, os: c.os, local: false,
        via: `${name}'s Aeneas app on that computer (you help ${name}; ${c.listening ? "it is on now" : "it is not answering now"})`,
        helper: { account, device: c.device_id },
      });
    }
  }
  return out;
}

/** Runs a command on a helped person's computer, through their hub (which logs it for them) and their app. */
export async function runOnHelped(hub: Hub, host: Host, command: string, timeoutS: number, meta?: { purpose: string; kind: "check" | "change" }): Promise<RunResult> {
  const e = entries(hub).find((x) => x.account === host.helper?.account);
  if (!e || !host.helper) return { exit_code: 1, output: "You no longer help them.", timed_out: false, ms: 0 };
  const t0 = Date.now();
  try {
    const target = host.helper.ip ? { target: { ip: host.helper.ip, port: host.helper.port ?? 22 } } : {};
    const r = await wardenCall(hub, e, "POST", "/warden/run", { device: host.helper.device, command, purpose: meta?.purpose ?? "", kind: meta?.kind ?? "check", timeout_s: timeoutS, ...target }, (timeoutS + 30) * 1000);
    if (r.status !== 200) return { exit_code: 1, output: String(r.data?.error ?? `their hub answered ${r.status}`), timed_out: false, ms: Date.now() - t0 };
    return { exit_code: Number(r.data.exit_code), output: String(r.data.output ?? ""), timed_out: false, ms: Date.now() - t0 };
  } catch (err) {
    return { exit_code: 1, output: `Their hub did not answer (${errCode(err)}).`, timed_out: true, ms: Date.now() - t0 };
  }
}

/** Every minute, the computers of the people this hub helps, so the assistant's machine list is current. */
export function startHelpingRefresh(hub: Hub): () => void {
  const tick = () => { if (entries(hub).length) void helpingView(hub).catch(() => {}); };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, 60_000);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

/** For Settings, People on this machine: each person's hub with whether this hub helps them. */
export async function peopleWithHelp(hub: Hub) {
  const [hubs, views] = await Promise.all([listHubs(), helpingView(hub)]);
  return hubs.map((h) => ({ ...h, help: views.find((v) => v.account === h.account) ?? null }));
}
