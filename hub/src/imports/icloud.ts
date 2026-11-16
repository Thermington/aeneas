import { ImapFlow } from "imapflow";
import { nowIso } from "@everythingapp/shared";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { BACKFILL_DAYS, MAIL_QUERY, OVERLAP_MS } from "./gmail.js";
import type { FetchedMail, MailRef, MailSource } from "./mail-sources.js";
import { bodyText } from "./mail-text.js";

/**
 * iCloud Mail, read-only, over IMAP. Apple has no sign-in for mail, so each mailbox is linked with an app-specific
 * password the owner makes at account.apple.com and enters once; it is kept only in connections.json (sealed) and never
 * shown, logged or sent anywhere but iCloud. The hub talks only to imap.mail.me.com:993 over TLS with normal certificate
 * checks; nothing a request, setting or the assistant sends can change that.
 *
 * Read-only for real: every folder is opened with EXAMINE, message parts are fetched with BODY.PEEK (nothing is marked
 * read), and nothing here stores, moves, copies, appends, expunges or deletes. Only text parts are fetched, capped,
 * never attachments. Mail is read in memory and never stored, as for Gmail.
 */

const HOST = "imap.mail.me.com";
const PORT = 993;
/** The prefix that marks an iCloud mailbox in the `mail` table (mail-sources.ts). */
const PREFIX = "icloud:";
/** At most this much of each text part is read. */
export const PART_MAX = 256 * 1024;
/** At most this many text parts of one message are read (a text and an HTML version, and a few more). */
const PARTS_MAX = 4;
/** Folders whose special use says they are not received mail. */
const SKIP_USE = new Set(["\\Junk", "\\Trash", "\\Drafts", "\\Sent"]);
/** A link to the message when it carries no Message-ID: iCloud Mail on the web. */
const WEB_LINK = "https://www.icloud.com/mail/";

export interface ICloudAccount {
  email: string;
  /** The app-specific password, as Apple shows it (abcd-efgh-ijkl-mnop). Never leaves the hub but to iCloud. */
  password: string;
  linked_at: string;
  /** Mail up to this time has been listed; the next read starts a little before it. */
  listed_to?: string;
  /** The search it was listed with; another search lists the mailbox again. */
  query?: string;
  last_sync?: string;
  last_error?: string | null;
  /**
   * When iCloud last refused the password. The hub then stops signing in on its own (repeated refused sign-ins can get
   * an Apple Account locked) until the mailbox is linked again or the owner presses Read now, which tries once.
   */
  refused_at?: string | null;
}

/** Said when iCloud refused a mailbox's password and the hub stopped signing in. */
export const REFUSED = "iCloud refused this mailbox's app-specific password (it was revoked, or the Apple Account changed). The hub stopped signing in so your account is not locked. Make a new app-specific password at account.apple.com and link the mailbox again, or press Read now to try this one once more.";

/**
 * Gmail's search words, so both sources look for the same mail: every `subject:` word in MAIL_QUERY, and the two
 * words Gmail looks for anywhere in the mail, which IMAP looks for in the body.
 */
export const SUBJECT_WORDS = [...MAIL_QUERY.matchAll(/subject:(\w+)/g)].map((m) => m[1]);
export const BODY_WORDS = ["veterinary", "animal hospital"];
/** What a listing searched with, kept on the account: a change lists the mailbox again. */
const SEARCH_ID = JSON.stringify({ subject: SUBJECT_WORDS, body: BODY_WORDS });

// ---------------------------------------------------------------------------------------------------------------------
// The IMAP client. Only these calls are used; the type names exactly what the hub may ask of a server, and no call that
// changes a mailbox is in it. Tests swap in a fake with setImapFactory.

export interface ImapFolder { path: string; specialUse?: string; flags: Set<string> }
export interface ImapPart { part?: string; type: string; disposition?: string; dispositionParameters?: Record<string, string>; parameters?: Record<string, string>; childNodes?: ImapPart[] }
export interface ImapMessage {
  internalDate?: Date | string;
  envelope?: { date?: Date | string; subject?: string; messageId?: string; from?: { name?: string; address?: string }[] };
  bodyStructure?: ImapPart;
}
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(): Promise<ImapFolder[]>;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<{ uidValidity: bigint }>;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchOne(uid: string, query: { envelope: true; bodyStructure: true; internalDate: true }, options: { uid: true }): Promise<ImapMessage | false>;
  download(uid: string, part: string, options: { uid: true; maxBytes: number }): Promise<{ content?: NodeJS.ReadableStream } | undefined>;
}
export interface ImapLogin { user: string; pass: string }

const realClient = (login: ImapLogin): ImapClient => new ImapFlow({
  host: HOST, port: PORT, secure: true, auth: login,
  // imapflow's own logger would write the conversation with the server, addresses included.
  logger: false,
  connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
  disableAutoIdle: true,
}) as unknown as ImapClient;
let makeClient = realClient;

/** For tests: a fake IMAP client in place of iCloud. Null puts the real one back. */
export function setImapFactory(f: ((login: ImapLogin) => ImapClient) | null) {
  makeClient = f ?? realClient;
}

/** iCloud refused the address and password: told apart from a server out of reach, which is tried again later. */
export class ICloudRefused extends StoreError {
  constructor() { super(422, "iCloud did not accept this address and app-specific password. Check both, or make a new app-specific password at account.apple.com."); }
}

/** The hub's own words for a failure: never the server's, which can repeat the address or the password's owner. */
function failure(e: unknown): StoreError {
  if (e instanceof StoreError) return e;
  if ((e as { authenticationFailed?: boolean })?.authenticationFailed) return new ICloudRefused();
  return new StoreError(502, "iCloud Mail could not be reached from the hub, or stopped answering. Check the hub's internet connection and try again.");
}

/**
 * How long one job may take in all, connection included: the socket timeout ends only a silent connection, and a
 * server that keeps sending a little would hold the mail job without end. Tests shorten them.
 */
const DEADLINES = { check: 60_000, list: 10 * 60_000, read: 2 * 60_000 };
export function setICloudDeadlines(d: Partial<typeof DEADLINES> | null) {
  Object.assign(DEADLINES, d ?? { check: 60_000, list: 10 * 60_000, read: 2 * 60_000 });
}

/** One connection for one job, closed at the end whatever happens, and given up at its deadline. */
async function withClient<T>(login: ImapLogin, deadlineMs: number, job: (c: ImapClient) => Promise<T>): Promise<T> {
  const c = makeClient(login);
  let timer: NodeJS.Timeout | undefined;
  const run = (async () => { await c.connect(); return job(c); })();
  run.catch(() => {}); // after the deadline it ends on its own, as the connection is closed under it
  try {
    return await Promise.race([run, new Promise<never>((_, fail) => {
      timer = setTimeout(() => {
        try { c.close(); } catch { /* closed already */ }
        fail(new StoreError(502, "iCloud Mail stopped answering in time. The hub tries again later."));
      }, deadlineMs);
      timer.unref?.();
    })]);
  } catch (e) {
    throw failure(e);
  } finally {
    clearTimeout(timer);
    await c.logout().catch(() => { try { c.close(); } catch { /* closed already */ } });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Accounts

const accountName = (email: string) => `${PREFIX}${email}`;
const emailOf = (account: string) => account.slice(PREFIX.length);

function account(hub: Hub, email: string): ICloudAccount {
  const a = hub.connections.get().icloud?.find((x) => x.email === email);
  if (!a) throw new StoreError(404, "that iCloud mailbox is not linked");
  return a;
}

function saveAccount(hub: Hub, email: string, fields: Partial<ICloudAccount>) {
  hub.connections.update((c) => { const a = c.icloud?.find((x) => x.email === email); if (a) Object.assign(a, fields); });
}

/** An app-specific password as Apple shows it, or null when `v` is not one (an Apple ID password never is). */
export function appPassword(v: unknown): string | null {
  const letters = typeof v === "string" ? v.replace(/[\s-]/g, "").toLowerCase() : "";
  return /^[a-z]{16}$/.test(letters) ? letters.match(/.{4}/g)!.join("-") : null;
}

/** Link a mailbox: check the password with iCloud once, keep it, and start the first read. */
export async function linkICloud(hub: Hub, body: Record<string, unknown>, read: (account: string) => void = () => {}) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StoreError(422, "email is the iCloud Mail address");
  const password = appPassword(body.password);
  if (!password) throw new StoreError(422, "password is an app-specific password made at account.apple.com (16 letters, like abcd-efgh-ijkl-mnop), not your Apple ID password");
  await withClient({ user: email, pass: password }, DEADLINES.check, async () => {});
  hub.connections.update((c) => {
    const list = (c.icloud ??= []);
    const prev = list.find((a) => a.email === email);
    if (prev) Object.assign(prev, { password, last_error: null, refused_at: null });
    else list.push({ email, password, linked_at: nowIso() });
  });
  read(accountName(email));
  return hub.connections.view().icloud;
}

/** Unlink a mailbox: its password and queue go; filed records stay. The password itself is revoked only at Apple. */
export function unlinkICloud(hub: Hub, email: string) {
  account(hub, email);
  hub.db.prepare("DELETE FROM mail WHERE account = ?").run(accountName(email));
  hub.connections.update((c) => { c.icloud = (c.icloud ?? []).filter((x) => x.email !== email); });
  return { ...hub.connections.view().icloud, message: "The mailbox is unlinked and its password deleted from the hub. To end the password itself, revoke it at account.apple.com, under Sign-In and Security, App-Specific Passwords." };
}

// ---------------------------------------------------------------------------------------------------------------------
// Listing and reading

/** The folders that hold received mail: every one but Junk, Trash, Drafts and Sent, and ones that cannot be opened. */
export function mailFolders(folders: ImapFolder[]): ImapFolder[] {
  return folders.filter((f) => !(f.specialUse && SKIP_USE.has(f.specialUse)) && !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"));
}

/** The server-side search: since a day, any of Gmail's subject words, or the vet words in the body. */
export function searchQuery(since: Date): Record<string, unknown> {
  return { since, or: [...SUBJECT_WORDS.map((w) => ({ subject: w })), ...BODY_WORDS.map((w) => ({ body: w }))] };
}

/** A message id: `<UIDVALIDITY>:<UID>:<folder>`, since a UID is unique only in one folder and one UIDVALIDITY. */
const messageId = (uidValidity: bigint | number | string, uid: number, folder: string) => `${uidValidity}:${uid}:${folder}`;
function parseId(id: string): { validity: string; uid: string; folder: string } | null {
  const m = /^(\d+):(\d+):([\s\S]+)$/.exec(id);
  return m ? { validity: m[1], uid: m[2], folder: m[3] } : null;
}

/** List a mailbox's likely mail since it was last listed (the first time, the last BACKFILL_DAYS) and queue what is new. */
export async function listICloud(hub: Hub, accountKey: string, now: Date = new Date(), opts: { owner?: boolean } = {}): Promise<{ listed: number; queued: number }> {
  const email = emailOf(accountKey);
  let a = account(hub, email);
  if (a.refused_at && !opts.owner) throw new StoreError(409, REFUSED);
  if (a.listed_to && a.query !== SEARCH_ID) {
    hub.db.prepare("DELETE FROM mail WHERE account = ? AND state = 'queued'").run(accountKey);
    saveAccount(hub, email, { listed_to: undefined });
    a = account(hub, email);
  }
  const from = a.listed_to ? new Date(Date.parse(a.listed_to) - OVERLAP_MS) : new Date(now.getTime() - BACKFILL_DAYS * 86400_000);
  const ids: string[] = [];
  try {
    await withClient({ user: a.email, pass: a.password }, DEADLINES.list, async (c) => {
      for (const f of mailFolders(await c.list())) {
        const box = await c.mailboxOpen(f.path, { readOnly: true });
        const uids = (await c.search(searchQuery(from), { uid: true })) || [];
        // Oldest first, so the filer (which takes the newest queued first) reads recent mail before old.
        for (const uid of [...uids].sort((x, y) => x - y)) ids.push(messageId(box.uidValidity, uid, f.path));
      }
    });
  } catch (e) {
    const f = failure(e);
    if (f instanceof ICloudRefused) saveAccount(hub, email, { last_sync: nowIso(), last_error: REFUSED, refused_at: nowIso() });
    else saveAccount(hub, email, { last_sync: nowIso(), last_error: f.message });
    throw f;
  }
  const insert = hub.db.prepare("INSERT OR IGNORE INTO mail (account, id, state) VALUES (?, ?, 'queued')");
  let queued = 0;
  hub.db.transaction(() => { for (const id of ids) queued += insert.run(accountKey, id).changes; }).immediate();
  saveAccount(hub, email, { listed_to: now.toISOString(), query: SEARCH_ID, last_sync: nowIso(), last_error: null, refused_at: null });
  return { listed: ids.length, queued };
}

/** The text parts of a message worth reading: text/plain and text/html, not attachments, at most PARTS_MAX. */
export function textParts(node: ImapPart | undefined): { part: string; html: boolean }[] {
  const out: { part: string; html: boolean }[] = [];
  const walk = (n: ImapPart | undefined) => {
    if (!n || out.length >= PARTS_MAX) return;
    if (n.childNodes?.length) { for (const c of n.childNodes) walk(c); return; }
    const type = n.type.toLowerCase();
    const named = n.dispositionParameters?.filename || n.parameters?.name;
    if ((type === "text/plain" || type === "text/html") && n.disposition?.toLowerCase() !== "attachment" && !named) {
      out.push({ part: n.part ?? "1", html: type === "text/html" });
    }
  };
  walk(node);
  return out;
}

async function readStream(s: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!s) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of s as AsyncIterable<Buffer | string>) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(b);
    size += b.length;
    if (size >= PART_MAX) break;
  }
  return Buffer.concat(chunks).subarray(0, PART_MAX).toString("utf8");
}

/** One queued message as text, or null when it is gone (its folder, its UIDVALIDITY or the message itself). */
export async function readICloud(hub: Hub, accountKey: string, id: string): Promise<FetchedMail | null> {
  const ref = parseId(id);
  if (!ref) return null;
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at) throw new StoreError(409, REFUSED);
  return withClient({ user: a.email, pass: a.password }, DEADLINES.read, async (c) => {
    let box: { uidValidity: bigint };
    try { box = await c.mailboxOpen(ref.folder, { readOnly: true }); }
    catch (e) {
      // The server said NO: the folder is gone or renamed. Anything else (a dropped connection) is not "gone".
      if ((e as { responseStatus?: string })?.responseStatus === "NO") return null;
      throw e;
    }
    if (String(box.uidValidity) !== ref.validity) return null;
    const msg = await c.fetchOne(ref.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
    if (!msg) return null;
    const plain: string[] = [];
    const html: string[] = [];
    for (const p of textParts(msg.bodyStructure)) {
      const d = await c.download(ref.uid, p.part, { uid: true, maxBytes: PART_MAX });
      (p.html ? html : plain).push(await readStream(d?.content));
    }
    const env = msg.envelope ?? {};
    const sender = env.from?.[0];
    const at = new Date(msg.internalDate ?? env.date ?? Date.now());
    return {
      at: Number.isNaN(at.getTime()) ? new Date() : at,
      from: sender ? (sender.name ? `${sender.name} <${sender.address ?? ""}>` : sender.address ?? "") : "",
      subject: env.subject ?? "",
      text: bodyText(plain, html),
      message_id: env.messageId,
    };
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_sync: nowIso(), last_error: REFUSED, refused_at: nowIso() });
    throw e;
  });
}

/** Opens the message in Apple Mail (Mac, iPhone, iPad) by its Message-ID; iCloud Mail on the web when it has none. */
export function icloudLink(ref: MailRef): string {
  const mid = ref.message_id?.trim().replace(/^<|>$/g, "");
  return mid ? `message://${encodeURIComponent(`<${mid}>`)}` : WEB_LINK;
}

/** iCloud Mail as a mail source. */
export const icloudSource: MailSource = {
  kind: "icloud",
  accounts: (hub) => (hub.connections.get().icloud ?? []).map((a) => accountName(a.email)),
  list: (hub, accountKey, opts) => listICloud(hub, accountKey, new Date(), opts),
  read: (hub, accountKey, id) => readICloud(hub, accountKey, id),
  link: icloudLink,
  isOwnLink: (url) => url.startsWith("message://") || url === WEB_LINK,
};
