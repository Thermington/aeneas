import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StoreError } from "./store.js";
import { REPO_DIR } from "./config.js";

/**
 * Other people's hubs on this machine (deploy/people.sh on Linux, deploy/windows/people.ps1 on Windows,
 * docs/multi-person.md), as the owner's hub sees them.
 *
 * The owner adds a person from the app: the hub writes a request into a folder only the owner's account can write to,
 * and a small root service (aeneas-people.path on Linux; on Windows the SYSTEM task "\Aeneas\Aeneas people") runs the
 * root-owned copy of the script for it, the same as the command line would, writing progress and the result (the new
 * hub's address and a pairing code for the person's first device) where only the owner's account can read it. The hub
 * itself never runs anything as root or SYSTEM: it names a person, nothing else.
 *
 * Only the owner's hub (the account in the owner file) offers this; everyone else's says `not_owner`. A Mac hub has one
 * person (`linux_only`, the name kept for the apps that read it: Linux and Windows are the platforms that have this).
 */

export interface PersonHub {
  name: string;
  account: string;
  port: number;
  color: string;
  owner: boolean;
  address: string | null;
  up: boolean;
}

export type HubsReason = "linux_only" | "not_set_up" | "not_owner";

/** The platform whose layout applies: the machine's own, or `EA_PEOPLE_PLATFORM` in tests (with EA_PEOPLE_ROOT). */
function platform(): NodeJS.Platform {
  const p = process.env.EA_PEOPLE_ROOT ? process.env.EA_PEOPLE_PLATFORM : undefined;
  return p === "win32" || p === "linux" ? p : process.platform;
}
/** Linux and Windows hubs take several people; a Mac hub has one. */
export function peopleSupported(p: NodeJS.Platform = platform()): boolean { return p === "linux" || p === "win32"; }

/**
 * Where the list of people, the owner file and the request and result folders are. Linux: /etc/aeneas and
 * /var/lib/aeneas. Windows: %ProgramData%\Aeneas (deploy/windows/people.ps1 makes it, with its folders' permissions).
 * Every fixed path is under `EA_PEOPLE_ROOT` in tests.
 */
function layout(): { registry: string; owner: string; requests: string; results: string } {
  const test = process.env.EA_PEOPLE_ROOT;
  if (platform() === "win32") {
    const base = test ? path.join(test, "ProgramData", "Aeneas") : path.join(process.env.ProgramData || "C:\\ProgramData", "Aeneas");
    return { registry: path.join(base, "people.json"), owner: path.join(base, "owner"), requests: path.join(base, "requests"), results: path.join(base, "results") };
  }
  const root = test || "/";
  return { registry: path.join(root, "etc/aeneas/people.json"), owner: path.join(root, "etc/aeneas/owner"), requests: path.join(root, "var/lib/aeneas/requests"), results: path.join(root, "var/lib/aeneas/results") };
}
const REGISTRY = () => layout().registry;
const OWNER_FILE = () => layout().owner;
const REQUESTS = () => layout().requests;
const RESULTS = () => layout().results;

/**
 * The command that turns this on, shown where the app would offer Add a person. On Windows it is pasted into a normal
 * PowerShell window and asks Windows for permission once (UAC); `-Owner` names the account whose hub this is, since an
 * administrator's password typed into that prompt runs it as the administrator.
 */
export function setupCommand(p: NodeJS.Platform = platform(), repo: string = REPO_DIR, user: string = me()): string {
  if (p !== "win32") return "sudo bash ~/everythingapp/deploy/people.sh setup --name <your name>";
  const script = path.win32.join(repo, "deploy", "windows", "people.ps1");
  return `Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File "${script}" setup -Owner "${user.replace(/["']/g, "")}" -Name "<your name>"'`;
}
export const SETUP_COMMAND = setupCommand();

/** What everyone who is added should hear first, shown before and after adding someone. */
/** Said before and after someone is added: the machine's admin can open every account's files (docs/multi-person.md). */
export function adminNote(p: NodeJS.Platform = platform()): string {
  const who = p === "win32" ? "Anyone with administrator rights on this PC" : "Anyone with admin (root or sudo) rights on this machine";
  return `Each person's notes, chats and everything else are kept in their own account on this machine, apart from yours and from everyone else's. ${who}, you included, can still open them. Tell the people you add before they start.`;
}

export const NAME_RE = /^[A-Za-z][A-Za-z '.-]{0,29}$/;
const ACCOUNT_RE = /^aeneas-[a-z0-9]{1,20}$/;
const ID_RE = /^[a-z0-9-]{8,40}$/;

function me(): string { try { return os.userInfo().username; } catch { return ""; } }
/** Account names: Windows does not tell case apart in them. */
function sameAccount(a: string, b: string): boolean { return platform() === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }

export function hubsState(): { available: boolean; reason?: HubsReason } {
  if (!peopleSupported() && !process.env.EA_PEOPLE_ROOT) return { available: false, reason: "linux_only" };
  let owner = "";
  try { owner = fs.readFileSync(OWNER_FILE(), "utf8").replace(/^\uFEFF/, "").trim(); } catch { return { available: false, reason: "not_set_up" }; }
  if (!sameAccount(owner, me())) return { available: false, reason: "not_owner" };
  try { fs.accessSync(REQUESTS(), fs.constants.W_OK); } catch { return { available: false, reason: "not_set_up" }; }
  return { available: true };
}

function registry(): { name: string; user: string; port: number; color?: string; owner?: boolean; address?: string }[] {
  try {
    const list = JSON.parse(fs.readFileSync(REGISTRY(), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function up(port: number): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2000);
  try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal })).ok; } catch { return false; } finally { clearTimeout(t); }
}

/**
 * On a machine with several people, a hub that is not the owner's runs a copy of the owner's code (people.sh update):
 * it is updated with theirs. The owner's name then, else null (the owner's own hub, or a machine with one hub).
 */
export function updatedWithOwner(): string | null {
  if (!peopleSupported() && !process.env.EA_PEOPLE_ROOT) return null;
  let owner = "";
  try { owner = fs.readFileSync(OWNER_FILE(), "utf8").replace(/^\uFEFF/, "").trim(); } catch { return null; }
  const account = me();
  if (!owner || sameAccount(owner, account)) return null;
  const list = registry();
  if (!list.some((p) => sameAccount(String(p.user), account))) return null;
  return String(list.find((p) => p.owner)?.name ?? "the machine owner");
}

export async function listHubs(): Promise<PersonHub[]> {
  const list = registry();
  return Promise.all(list.map(async (p) => ({
    name: String(p.name), account: String(p.user), port: Number(p.port), color: String(p.color ?? ""), owner: !!p.owner,
    address: p.address ? String(p.address) : null, up: await up(Number(p.port)),
  })));
}

function request(op: "add" | "pair" | "stop" | "ward", name: string, color = "", extra: { helper?: string; hash?: string } = {}): { request_id: string } {
  const state = hubsState();
  if (!state.available) throw new StoreError(409, state.reason === "not_owner" ? "only the machine owner's hub adds people" : `this machine is not set up for several people yet: run ${SETUP_COMMAND}`, { reason: state.reason });
  const id = crypto.randomUUID();
  const body = JSON.stringify({ id, op, name, color, ...extra });
  // Written under another name first, so the root service never reads half a request.
  const tmp = path.join(REQUESTS(), `.${id}.part`);
  // On Windows the folder's permissions (not its read-only flag, which is all hubsState can see) decide who may write.
  try {
    fs.writeFileSync(tmp, body, { mode: 0o660 });
    fs.renameSync(tmp, path.join(REQUESTS(), `${id}.json`));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOENT") throw new StoreError(409, `this hub cannot hand requests to the machine yet: run ${SETUP_COMMAND}`, { reason: "not_set_up" });
    throw e;
  }
  return { request_id: id };
}

export function addPerson(body: Record<string, unknown>): { request_id: string } {
  const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
  if (!NAME_RE.test(name)) throw new StoreError(422, "a name is letters, spaces, apostrophes, dots or dashes, up to 30, starting with a letter");
  const color = String(body.color ?? "").trim();
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new StoreError(422, "a color is #rrggbb");
  const taken = registry().find((p) => String(p.name).toLowerCase() === name.toLowerCase());
  if (taken) throw new StoreError(409, `${name} already has a hub here`);
  return request("add", name, color);
}

/** By account (aeneas-...), the one stable handle: names are for people to read. */
function personByAccount(account: string) {
  if (!ACCOUNT_RE.test(account)) throw new StoreError(404, "no such hub");
  const p = registry().find((x) => x.user === account && !x.owner);
  if (!p) throw new StoreError(404, "no such hub");
  return p;
}

export function pairPerson(account: string): { request_id: string } { return request("pair", String(personByAccount(account).name)); }
export function stopPerson(account: string): { request_id: string } { return request("stop", String(personByAccount(account).name)); }

/**
 * The owner offers to help this person with their devices (helpers.ts on their hub, helping.ts on this one): only the
 * SHA-256 of the key this hub made goes through the request; their hub keeps the offer until they say yes.
 */
export function wardPerson(account: string, helper: string, keyHash: string): { request_id: string } {
  if (!NAME_RE.test(helper)) throw new StoreError(422, "your name, as the person will see it, is letters, up to 30");
  if (!/^[0-9a-f]{64}$/.test(keyHash)) throw new StoreError(422, "bad key hash");
  return request("ward", String(personByAccount(account).name), "", { helper, hash: keyHash });
}

/** A person's hub on this machine by account, with its port, for this hub to reach it on 127.0.0.1. */
export function personHub(account: string): { name: string; account: string; port: number } {
  const p = personByAccount(account);
  return { name: String(p.name), account: String(p.user), port: Number(p.port) };
}

/** Progress or the result of a request: `queued` until the root service picks it up. */
export function requestResult(id: string): Record<string, unknown> {
  if (!ID_RE.test(id)) throw new StoreError(404, "no such request");
  if (fs.existsSync(path.join(REQUESTS(), `${id}.json`))) return { state: "queued" };
  let text: string;
  try { text = fs.readFileSync(path.join(RESULTS(), `${id}.json`), "utf8"); } catch { throw new StoreError(404, "no such request"); }
  // Read while the script rewrites it: the request is under way, not gone.
  try { return JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>; } catch { return { state: "working" }; }
}
