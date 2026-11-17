import { Readable } from "node:stream";
import type { TestHub } from "./helpers.js";
import { setImapFactory, type ImapClient, type ImapFolder } from "../src/imports/icloud.js";

// A fake iCloud for the Mail screen's tests (icloud-chat, mail-routes). Not a test file itself.
export const PASSWORD = "abcd-efgh-ijkl-mnop";
export const EMAIL = "robin@icloud.example";
export const ACCOUNT = `icloud:${EMAIL}`;

export interface Msg {
  uid: number;
  folder: string;
  at: Date;
  subject: string;
  from: { name?: string; address: string };
  replyTo?: { address: string };
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  plain?: string;
  html?: string;
}

export const FOLDERS: ImapFolder[] = [
  { path: "INBOX", flags: new Set() },
  { path: "Archive", specialUse: "\\Archive", flags: new Set() },
  { path: "Junk", specialUse: "\\Junk", flags: new Set() },
  { path: "Deleted Messages", specialUse: "\\Trash", flags: new Set() },
  { path: "Drafts", specialUse: "\\Drafts", flags: new Set() },
  { path: "Sent Messages", specialUse: "\\Sent", flags: new Set() },
  { path: "[Group]", flags: new Set(["\\Noselect"]) },
];

/** A fake iCloud for the Mail screen: folders, messages, and a record of every call and query. */
export function fake(messages: Msg[], opts: { password?: string } = {}) {
  const seen = { connects: 0, logouts: 0, calls: [] as string[], opened: [] as { path: string; readOnly: unknown }[], fetches: [] as unknown[], searches: [] as Record<string, unknown>[] };
  setImapFactory((login) => {
    let open: string | null = null;
    const find = (uid: string) => messages.find((m) => m.folder === open && String(m.uid) === uid);
    const c: ImapClient = {
      async connect() {
        seen.calls.push("connect"); seen.connects++;
        if (login.pass !== (opts.password ?? PASSWORD)) throw Object.assign(new Error("Authentication failed"), { authenticationFailed: true });
      },
      async logout() { seen.calls.push("logout"); seen.logouts++; },
      close() { seen.calls.push("close"); },
      async list() { seen.calls.push("list"); return FOLDERS; },
      async mailboxOpen(p, o) {
        seen.calls.push("mailboxOpen"); seen.opened.push({ path: p, readOnly: (o as { readOnly?: unknown }).readOnly });
        if (!FOLDERS.some((f) => f.path === p)) throw Object.assign(new Error("no such folder"), { responseStatus: "NO" });
        open = p;
        return { uidValidity: 7n };
      },
      async search(q) {
        seen.calls.push("search"); seen.searches.push(q);
        const since = q.since as Date;
        return messages.filter((m) => m.folder === open && m.at >= since).map((m) => m.uid);
      },
      async fetchOne(uid, query, o) {
        seen.calls.push("fetchOne"); seen.fetches.push({ query, o });
        const m = find(uid);
        if (!m) return false;
        const parts = [m.plain !== undefined ? { type: "text/plain" } : null, m.html !== undefined ? { type: "text/html" } : null].filter(Boolean) as { type: string }[];
        return {
          internalDate: m.at,
          envelope: { date: m.at, subject: m.subject, messageId: m.messageId && `<${m.messageId}>`, inReplyTo: m.inReplyTo && `<${m.inReplyTo}>`, from: [m.from], replyTo: [m.replyTo ?? m.from] },
          bodyStructure: parts.length === 1 ? parts[0] : { type: "multipart/alternative", childNodes: parts.map((p, i) => ({ ...p, part: String(i + 1) })) },
          ...(query.headers ? { headers: Buffer.from(m.references ? `References: ${m.references}\r\n\r\n` : "\r\n") } : {}),
        };
      },
      async download(uid, part) {
        seen.calls.push("download");
        const m = find(uid)!;
        const both = m.plain !== undefined && m.html !== undefined;
        const body = both ? (part === "1" ? m.plain! : m.html!) : (m.plain ?? m.html ?? "");
        return { content: Readable.from([Buffer.from(body, "utf8")]) };
      },
    };
    return c;
  });
  return seen;
}

export function linked(t: TestHub, extra: Record<string, unknown> = {}) {
  t.hub.connections.update((c) => { c.icloud = [{ email: EMAIL, password: PASSWORD, linked_at: new Date().toISOString(), ...extra }]; });
}
export const done = (t: TestHub) => { setImapFactory(null); t.cleanup(); };
export const ago = (days: number) => new Date(Date.now() - days * 86400_000);
