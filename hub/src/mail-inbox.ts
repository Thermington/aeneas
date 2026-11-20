import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DB } from "./db.js";
import type { Hub } from "./hub.js";
import { icloudInbox, INBOX_DAYS } from "./imports/icloud.js";
import type { InboxMail, InboxSource, MailAddress } from "./imports/inbox-source.js";

/** Where the Mail screen's mail comes from (imports/inbox-source.ts): iCloud today; a Gmail source is one more entry. */
export const INBOX_SOURCES: InboxSource[] = [icloudInbox];
/** The source an account key belongs to, by its prefix. */
export const sourceOf = (account: string) => INBOX_SOURCES.find((s) => account.startsWith(s.prefix)) ?? null;
import { mailboxLabel } from "./mail-filer.js";
import { errCode } from "./logsafe.js";
import { mailDocument, pictureData, withImages } from "./mail-html.js";
import { bundleOf, NO_MODULES, type BundleContext } from "./mail-bundles.js";
import { fetchBytesViaTor, fetchPublicBytes, TorDown } from "./ai/web.js";
import { StoreError } from "./store.js";

/**
 * The Mail screen's store (CONTRACT.md, Mail): the iCloud Inbox's mail, sorted into bundles, with what the owner did to
 * each (pinned, snoozed, done).
 *
 * `<data>/mail.sqlite` is a file of its own, like chats.sqlite: the nightly backup copies only hub.sqlite, so mail text
 * never reaches a backup; nothing here is an entity, so nothing is synced to devices; and the assistant's tools, search
 * and memory never read this file. `secure_delete` makes SQLite overwrite what it deletes instead of only marking it
 * free, and big deletes checkpoint the WAL so old pages leave it too.
 *
 * Kept per message, while it is in the Inbox (and while snoozed, however long): mailbox, its folder id, Message-ID, date,
 * the sender's name and address, a Reply-To that differs from From, subject, its text as a person reads it, its HTML
 * cleaned for showing (mail-html.ts) with its pictures written in, whether a system sent it, and the owner's pin, snooze
 * and done. Never other recipients or attachments.
 *
 * Pictures (since 2026-11-19): those sent inside a mail come with it; those on the web are fetched by the hub soon after
 * the mail arrives, every one of them, whether the mail is ever opened or not (fetchMailImages), and only through Tor,
 * as web lookups are (since 2026-11-20). So opening a mail loads nothing, a sender's "opened" tracking says only that
 * the mail was fetched, and the sender's servers see a Tor exit: neither the device's address nor the home's. Pictures a mail marks as one dot or hidden (tracking pixels) are never
 * fetched (mail-html.ts), and only https addresses are.
 *
 * A hub without Tor fetches no web picture on its own. An open mail then offers Show pictures (showPictures): that
 * mail's pictures, fetched straight from the hub because the person asked, after being told that its sender will see
 * the home's internet address. No brand logo is fetched on such a hub.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  message_id TEXT,
  at TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_address TEXT NOT NULL,
  reply_to TEXT,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  automated INTEGER NOT NULL,
  unsubscribe INTEGER NOT NULL,
  list_id TEXT,
  bundle TEXT,
  state TEXT NOT NULL DEFAULT 'inbox',
  pinned INTEGER NOT NULL DEFAULT 0,
  snooze_until TEXT,
  task_id TEXT,
  done_at TEXT,
  html TEXT,
  remote TEXT,
  logo_domain TEXT,
  back_at TEXT,
  PRIMARY KEY (account, id)
);
CREATE INDEX IF NOT EXISTS inbox_at ON inbox(at);
CREATE INDEX IF NOT EXISTS inbox_mid ON inbox(account, message_id);
CREATE TABLE IF NOT EXISTS mailboxes (account TEXT PRIMARY KEY, last_refresh TEXT, last_error TEXT, more INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS logos (domain TEXT PRIMARY KEY, url TEXT NOT NULL, svg TEXT, fetched_at TEXT);
`;

export function openMailDb(dbPath: string): DB {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 15000");
  db.pragma("secure_delete = ON");
  // This file's first version: nothing older ever shipped, so there is nothing to bring forward.
  db.exec(SCHEMA);
  return db;
}

const DAY_MS = 86_400_000;
/** A message's id in the API: stays the same when the message moves between folders, and shows nothing of the mail. */
export const mailKey = (account: string, id: string) => crypto.createHash("sha256").update(`${account}\n${id}`).digest("hex").slice(0, 24);

/** Whether a message is kept already by its folder id (the refresh fetches only what is not). */
export function isKept(db: DB, account: string): (id: string) => boolean {
  const has = db.prepare("SELECT 1 FROM inbox WHERE account = ? AND id = ?");
  return (id) => !!has.get(account, id);
}

/** Whether a message is kept already by its Message-ID (it moved, or the Inbox's ids were renumbered). */
export function isKeptMessage(db: DB, account: string): (messageId: string) => boolean {
  const has = db.prepare("SELECT 1 FROM inbox WHERE account = ? AND message_id = ?");
  return (mid) => !!has.get(account, mid);
}

/** The folder part of a folder id (`<UIDVALIDITY>:<UID>:<folder>`). */
const folderOf = (id: string) => /^\d+:\d+:([\s\S]+)$/.exec(id)?.[1] ?? "";

/**
 * Keep what one refresh of a mailbox found, in one transaction:
 * 1. moved: a kept message found in the Inbox under another id takes that id; one marked done is back in the Inbox
 *    (the owner moved it back in Apple Mail);
 * 2. new mail is kept;
 * 3. mail kept as in the Inbox (or snoozed there) that is no longer in it was archived, moved or deleted elsewhere:
 *    it goes. Done mail is in Archive and stays (for its kept time). Nothing goes when the listing found no Inbox.
 */
export function keepInbox(db: DB, account: string, found: { present: string[] | null; mails: InboxMail[]; moved: { id: string; message_id: string }[] }): { kept: number; gone: number } {
  const insert = db.prepare(`INSERT OR IGNORE INTO inbox (account, id, key, message_id, at, from_name, from_address, reply_to, subject, text, automated, unsubscribe, list_id, html, remote, logo_domain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // A brand's logo, fetched later (fetchMailImages); a new address for it is fetched again.
  const logo = db.prepare("INSERT INTO logos (domain, url) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET url = excluded.url, svg = CASE WHEN logos.url = excluded.url THEN logos.svg END, fetched_at = CASE WHEN logos.url = excluded.url THEN logos.fetched_at END");
  const move = db.prepare("UPDATE inbox SET id = ?, state = CASE state WHEN 'done' THEN 'inbox' ELSE state END, done_at = CASE state WHEN 'done' THEN NULL ELSE done_at END WHERE account = ? AND message_id = ?");
  let kept = 0;
  let gone = 0;
  db.transaction(() => {
    for (const m of found.moved) move.run(m.id, account, m.message_id);
    for (const m of found.mails) {
      kept += insert.run(account, m.id, mailKey(account, m.id), m.message_id, m.at.toISOString(), m.from.name, m.from.address, m.reply_to,
        m.subject, m.text, m.automated ? 1 : 0, m.unsubscribe ? 1 : 0, m.list_id, m.html, m.html && m.remote.length ? JSON.stringify(m.remote) : null, m.logo?.domain ?? null).changes;
      if (m.logo) logo.run(m.logo.domain, m.logo.url);
    }
    if (found.present) {
      const here = new Set(found.present);
      const inboxFolders = new Set(found.present.map(folderOf));
      const del = db.prepare("DELETE FROM inbox WHERE account = ? AND id = ?");
      const rows = db.prepare("SELECT id FROM inbox WHERE account = ? AND state IN ('inbox', 'snoozed')").all(account) as { id: string }[];
      for (const r of rows) {
        // Only mail kept from the Inbox folder can be said to have left it (an empty Inbox names no folder: all left).
        if (here.has(r.id)) continue;
        if (inboxFolders.size && !inboxFolders.has(folderOf(r.id))) continue;
        gone += del.run(account, r.id).changes;
      }
    }
  }).immediate();
  if (gone) db.pragma("wal_checkpoint(TRUNCATE)");
  return { kept, gone };
}

/** Unlinking a mailbox: its mail goes at once. */
export function deleteMailbox(db: DB, account: string): number {
  const n = db.prepare("DELETE FROM inbox WHERE account = ?").run(account).changes;
  db.prepare("DELETE FROM mailboxes WHERE account = ?").run(account);
  db.pragma("wal_checkpoint(TRUNCATE)");
  return n;
}

/** The module switched off: every message goes. */
export function deleteAllMail(db: DB): number {
  const n = db.prepare("DELETE FROM inbox").run().changes;
  db.prepare("DELETE FROM mailboxes").run();
  db.prepare("DELETE FROM logos").run();
  db.pragma("wal_checkpoint(TRUNCATE)");
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading what is kept (the routes)

export type MailState = "inbox" | "snoozed" | "done";
/** One message in the list: no text, a first line of it. */
export interface MailSummary {
  id: string; at: string; from: MailAddress; reply_to?: string; subject: string; preview: string;
  automated: boolean; bundle: string | null; state: MailState; pinned: boolean; snooze_until?: string;
  /** The sender's verified brand logo, by domain: the list's `logos` has the picture. */
  logo_domain?: string;
  /** When it came back from a snooze: the Inbox lists it by this time, not by when it arrived. */
  back_at?: string;
}
/**
 * One message whole: its text, and its HTML as a page to show (mailDocument: cleaned, nothing in it loads anything),
 * or null when it has none. `pictures_pending`: its web pictures are still being fetched. `pictures_ask`: this hub has
 * no Tor, so they are fetched only when the person asks for this mail's (POST /mail/messages/:id/pictures).
 */
export interface MailMessage extends MailSummary { text: string; html: string | null; pictures_pending: boolean; pictures_ask: boolean }

type Row = { key: string; at: string; from_name: string; from_address: string; reply_to: string | null; subject: string; text: string; automated: number; bundle: string | null; state: MailState; pinned: number; snooze_until: string | null; logo_domain?: string | null; back_at?: string | null };

/**
 * The first words of a message for the list: its text on one line, at most 200 characters, links by their words only
 * (`label (https://…)`, `[label](https://…)` and bare addresses lose the address). Only the start of the text is
 * read for it (PREVIEW_READ): a mail of nothing but `(http://(http://…` cannot make it take long.
 */
const PREVIEW_READ = 4000;
export const previewOf = (text: string) => text.slice(0, PREVIEW_READ)
  .replace(/\[([^\]\n]{0,300})\]\(\s*(https?:|mailto:)[^)\s]*\s*\)/gi, "$1")
  .replace(/\s*[(<]\s*(https?:\/\/|mailto:)[^)>\s]*\s*[)>]/gi, "")
  .replace(/(https?:\/\/|www\.)[^\s)]+/gi, "")
  .replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim().slice(0, 200);

function summary(r: Row): MailSummary {
  return {
    id: r.key, at: r.at, from: { name: r.from_name, address: r.from_address },
    ...(r.reply_to ? { reply_to: r.reply_to } : {}),
    subject: r.subject, preview: previewOf(r.text), automated: !!r.automated, bundle: r.bundle, state: r.state, pinned: !!r.pinned,
    ...(r.snooze_until ? { snooze_until: r.snooze_until } : {}),
    ...(r.logo_domain ? { logo_domain: r.logo_domain } : {}),
    ...(r.back_at ? { back_at: r.back_at } : {}),
  };
}

/** At most this many messages in one list answer, newest first. */
export const LIST_MAX = 5000;

/**
 * Everything kept, newest first, each in its bundle (mail-bundles.ts, worked out now from `ctx`, the owner's records):
 * the screen sorts it into Inbox, Snoozed, Done and the bundles.
 */
export function listMail(db: DB, ctx: BundleContext = NO_MODULES): MailSummary[] {
  const rows = db.prepare("SELECT key, at, from_name, from_address, reply_to, subject, substr(text, 1, 3000) AS text, automated, unsubscribe, list_id, bundle, state, pinned, snooze_until, logo_domain, back_at FROM inbox ORDER BY coalesce(back_at, at) DESC, key LIMIT ?").all(LIST_MAX) as (Row & { unsubscribe: number; list_id: string | null })[];
  return rows.map((r) => ({
    ...summary(r),
    bundle: bundleOf({ from: { name: r.from_name, address: r.from_address }, subject: r.subject, automated: !!r.automated, unsubscribe: !!r.unsubscribe, list_id: r.list_id, text: r.text }, ctx),
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// One thing at a time per hub: a refresh and a Done never overlap, or a listing made before a move could put the mail
// back in the Inbox after it.

const locks = new WeakMap<Hub, Promise<unknown>>();
function exclusive<T>(hub: Hub, job: () => Promise<T>): Promise<T> {
  const run = (locks.get(hub) ?? Promise.resolve()).catch(() => {}).then(job);
  locks.set(hub, run.catch(() => {}));
  return run;
}

// ---------------------------------------------------------------------------------------------------------------------
// Done and Undo: the Mail screen's only change to the mailbox (its source's move: iCloud's moveICloud, Inbox to Archive and back)

/** How long Done mail stays on the hub (the Done view, Undo); in iCloud it stays in Archive. */
export const DONE_DAYS = 30;
/** At most this many mails in one Done or Undo (a Sweep of a big day). */
export const MOVE_MAX = 500;
export interface MoveResult { moved: string[]; failed: number; error?: string }

/** Done: kept mail in the Inbox (or snoozed) moves to iCloud's Archive and shows under Done. */
export async function markDone(hub: Hub, keys: string[], now = new Date()): Promise<MoveResult> {
  const r = await moveKept(hub, keys, "archive", now);
  finishSnoozeTasks(hub, r.moved, now);
  return r;
}
/** Undo (or "Move to Inbox" from Done): done mail moves back from Archive to the Inbox. */
export const undoDone = (hub: Hub, keys: string[]) => moveKept(hub, keys, "inbox");

async function moveKept(hub: Hub, keys: string[], to: "archive" | "inbox", now = new Date()): Promise<MoveResult> {
  return exclusive(hub, async () => {
    const db = hub.mailDb;
    const get = db.prepare("SELECT key, account, id, message_id, state FROM inbox WHERE key = ?");
    const from = to === "archive" ? ["inbox", "snoozed"] : ["done"];
    /** For the log: which of the two this is (never anything of the mail). */
    const step = to === "archive" ? "done" : "undo";
    const rows = [...new Set(keys)].slice(0, MOVE_MAX).map((k) => get.get(k) as { key: string; account: string; id: string; message_id: string | null; state: MailState } | undefined)
      .filter((r): r is NonNullable<typeof r> => !!r && from.includes(r.state));
    let failed = Math.min(keys.length, MOVE_MAX) - rows.length;
    const moved: string[] = [];
    let error: string | undefined;
    const save = to === "archive"
      ? db.prepare("UPDATE inbox SET id = ?, state = 'done', done_at = ?, snooze_until = NULL WHERE key = ?")
      : db.prepare("UPDATE inbox SET id = ?, state = 'inbox', done_at = NULL WHERE key = ?");
    for (const account of new Set(rows.map((r) => r.account))) {
      const mine = rows.filter((r) => r.account === account);
      try {
        const source = sourceOf(account);
        if (!source) throw new StoreError(409, "This mailbox is no longer linked.");
        const ids = await source.move(hub, account, mine.map((r) => ({ id: r.id, message_id: r.message_id })), to);
        db.transaction(() => {
          for (const r of mine) {
            const id = ids.get(r.id);
            if (!id) { failed++; continue; }
            if (to === "archive") save.run(id, now.toISOString(), r.key); else save.run(id, r.key);
            moved.push(r.key);
          }
        }).immediate();
      } catch (e) {
        failed += mine.length;
        error = e instanceof StoreError ? e.message : "The mail could not be moved. The hub's log has the error code.";
        console.error(`[mail-inbox] ${mailboxLabel(hub, account)}: ${step} ${errCode(e)}`);
      }
    }
    if (moved.length) console.log(`[mail-inbox] ${step}: ${moved.length} moved${failed ? `, ${failed} not moved` : ""}`);
    if (failed && !error) error = failed === 1 ? "One mail was not moved: it changed in iCloud since the last refresh. Refresh and try again." : `${failed} mails were not moved: they changed in iCloud since the last refresh. Refresh and try again.`;
    return { moved, failed, ...(error ? { error } : {}) };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Snooze: on the hub only (the mail stays in iCloud's Inbox), with a task that says only that a mail is snoozed

/** A snooze ends at most this far ahead. */
export const SNOOZE_MAX_DAYS = 366;
type SnoozeRow = { key: string; state: MailState; task_id: string | null };
const openTask = (hub: Hub, id: string | null) => {
  const t = id ? hub.store.get(id) : null;
  return t && !t.deleted_at && t.fields.status !== "done" ? t : null;
};

/** What a snooze's task is called: never the mail's own words. */
export const SNOOZE_TASK_TITLE = "Snoozed mail";

/**
 * Snooze a mail in the Inbox (or snooze it again) until `until`: it leaves the Inbox for Snoozed, and a task reminds
 * at that time, in Tasks and Reminders. The task is titled "Snoozed mail" and points at the mail by its id
 * (`task.mail`); it holds none of the mail's words. Tasks sync to every device, are in backups and are open to the
 * assistant, and a subject is written by whoever sent the mail: with it in a task, mail would reach the model after
 * all, and a crafted subject could try to steer it. The Mail screen's Snoozed list says which mail it is. False when
 * the mail is not kept or is done.
 */
export function snoozeMail(hub: Hub, key: string, until: Date): boolean {
  const db = hub.mailDb;
  const r = db.prepare("SELECT key, state, task_id FROM inbox WHERE key = ?").get(key) as SnoozeRow | undefined;
  if (!r || r.state === "done") return false;
  const when = until.toISOString();
  let task = openTask(hub, r.task_id);
  if (task) task = hub.store.patch(task.id, { remind_at: when, snoozed_until: null });
  else task = hub.store.create("task", { title: SNOOZE_TASK_TITLE, status: "scheduled", order: Date.now(), remind_at: when, mail: key });
  db.prepare("UPDATE inbox SET state = 'snoozed', snooze_until = ?, task_id = ?, back_at = NULL WHERE key = ?").run(when, task.id, key);
  return true;
}

/**
 * Back to the Inbox now (Unsnooze, or its task was done or deleted), at the top. `keepTask`: leave the task as it is
 * (it is what brought the mail back); otherwise an open one is deleted, as the snooze it stood for is over.
 */
export function unsnoozeMail(hub: Hub, key: string, opts: { keepTask?: boolean } = {}, now = new Date()): boolean {
  const db = hub.mailDb;
  const r = db.prepare("SELECT key, state, task_id FROM inbox WHERE key = ?").get(key) as SnoozeRow | undefined;
  if (!r || r.state !== "snoozed") return false;
  db.prepare("UPDATE inbox SET state = 'inbox', snooze_until = NULL, task_id = NULL, back_at = ? WHERE key = ?").run(now.toISOString(), key);
  const task = opts.keepTask ? null : openTask(hub, r.task_id);
  if (task) hub.store.patch(task.id, { deleted_at: now.toISOString() });
  return true;
}

/**
 * Snoozes whose time has come: back to the Inbox, at the top. Their task stays (it is the reminder that just went
 * off); done with the mail, it is done with the task too (finishSnoozeTasks).
 */
export function wakeSnoozed(hub: Hub, now = new Date()): number {
  return hub.mailDb.prepare("UPDATE inbox SET state = 'inbox', back_at = snooze_until, snooze_until = NULL WHERE state = 'snoozed' AND snooze_until <= ?").run(now.toISOString()).changes;
}

/** Mail marked done: its snooze's task, if still open, is done too. */
function finishSnoozeTasks(hub: Hub, keys: string[], now: Date) {
  const db = hub.mailDb;
  const get = db.prepare("SELECT task_id FROM inbox WHERE key = ? AND task_id IS NOT NULL");
  const clear = db.prepare("UPDATE inbox SET task_id = NULL WHERE key = ?");
  for (const key of keys) {
    const r = get.get(key) as { task_id: string } | undefined;
    if (!r) continue;
    const task = openTask(hub, r.task_id);
    if (task) hub.store.patch(task.id, { status: "done", done_at: now.toISOString() });
    clear.run(key);
  }
}

/** A snooze's task marked done or deleted (in Tasks, Reminders, on any device): its mail comes back at once. */
export function installMailHooks(hub: Hub): void {
  hub.store.afterWrite((entity) => {
    if (entity.kind !== "task" || typeof entity.fields.mail !== "string") return;
    if (!entity.deleted_at && entity.fields.status !== "done") return;
    const r = hub.mailDb.prepare("SELECT key FROM inbox WHERE key = ? AND state = 'snoozed' AND task_id = ?").get(entity.fields.mail, entity.id);
    if (r) unsnoozeMail(hub, entity.fields.mail, { keepTask: true });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// What the owner does to a mail (on the hub only, nothing in iCloud changes)

/** Pin or unpin a kept mail: it stays where it is in the list, shows with a pin, and Sweep passes it by. */
export function setPinned(db: DB, key: string, pinned: boolean): boolean {
  return db.prepare("UPDATE inbox SET pinned = ? WHERE key = ?").run(pinned ? 1 : 0, key).changes > 0;
}

/** The verified logos the kept mail uses, by domain, as data: SVG pictures (one each, however many mails). */
export function mailLogos(db: DB): Record<string, string> {
  const rows = db.prepare("SELECT domain, svg FROM logos WHERE svg IS NOT NULL AND domain IN (SELECT logo_domain FROM inbox)").all() as { domain: string; svg: string }[];
  return Object.fromEntries(rows.map((r) => [r.domain, r.svg]));
}

/**
 * One message with its whole kept text and its page, or null. `byTor`: this hub fetches web pictures itself (through
 * Tor), so pictures not there yet are on their way; otherwise they wait for the person to ask.
 */
export function mailMessage(db: DB, key: string, byTor = true): MailMessage | null {
  const r = db.prepare("SELECT key, at, from_name, from_address, reply_to, subject, text, automated, bundle, state, pinned, snooze_until, html, remote FROM inbox WHERE key = ?").get(key) as (Row & { html: string | null; remote: string | null }) | undefined;
  return r ? { ...summary(r), text: r.text, html: r.html ? mailDocument(withImages(r.html, [])) : null, pictures_pending: !!r.remote && byTor, pictures_ask: !!r.remote && !byTor } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Web pictures

/** A logo at most this big (BIMI's own limit is 32 KB), fetched again after this long; a failed one is tried a day later. */
const LOGO_BYTES = 64 * 1024;
const LOGO_DAYS = 30;

/** Bytes that are an SVG picture: text, starting (after an XML line, comments or a doctype) with an <svg> element. */
export function isSvg(b: Buffer): boolean {
  const head = b.subarray(0, 4096).toString("utf8").replace(/^\uFEFF/, "").replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/gi, "").trimStart();
  return /^<svg[\s>]/i.test(head);
}

/**
 * Fetch the verified logos not fetched yet (or not for LOGO_DAYS), one per brand's domain, through Tor like the
 * pictures. They are shown only as pictures (`<img>`), where an SVG's scripts and links never run.
 */
async function fetchLogos(db: DB, socks: string, now = new Date()): Promise<number> {
  const stale = new Date(now.getTime() - LOGO_DAYS * DAY_MS).toISOString();
  const rows = db.prepare("SELECT domain, url FROM logos WHERE (fetched_at IS NULL OR fetched_at < ?) AND domain IN (SELECT logo_domain FROM inbox) LIMIT 50").all(stale) as { domain: string; url: string }[];
  const save = db.prepare("UPDATE logos SET svg = ?, fetched_at = ? WHERE domain = ? AND url = ?");
  let got = 0;
  for (const r of rows) {
    let b: Buffer | null;
    // Tor is not there: the logos not fetched yet wait for the next run, like the pictures.
    try { b = await mailImages.fetch(r.url, socks); } catch (e) { if (e instanceof TorDown) return got; b = null; }
    if (b && b.length <= LOGO_BYTES && isSvg(b)) {
      save.run(`data:image/svg+xml;base64,${b.toString("base64")}`, now.toISOString(), r.domain, r.url);
      got++;
    } else {
      // Tried again a day later: as if fetched LOGO_DAYS - 1 days ago.
      save.run(null, new Date(now.getTime() - (LOGO_DAYS - 1) * DAY_MS).toISOString(), r.domain, r.url);
    }
  }
  return got;
}

/** Each picture at most this big; a mail's pictures at most this much in all (the rest stay empty). */
const PICTURE_BYTES = 2_000_000;
const MAIL_PICTURE_BYTES = 8_000_000;
/** Pictures fetched at once, and mails done per batch (the module's switch is checked between batches). */
const AT_ONCE = 6;
const BATCH = 10;
/**
 * How a web picture is fetched; both ways https only, no cookie, capped (ai/web.ts). Tests swap them.
 * `fetch`: through Tor, the only way the hub fetches a picture on its own.
 * `direct`: straight from the hub, only for a mail whose pictures the person asked for on a hub without Tor.
 */
export const mailImages = {
  fetch: (url: string, socks: string): Promise<Buffer | null> => fetchBytesViaTor(url, socks, 45_000, PICTURE_BYTES),
  direct: (url: string): Promise<Buffer | null> => fetchPublicBytes(url, 15_000, PICTURE_BYTES),
};
const fetching = new WeakMap<Hub, Promise<number>>();

/**
 * One mail's web pictures, fetched with `get`, as data: addresses in the order of its `remote` list: null for one that
 * failed, is not a PNG, JPEG, GIF or WebP, or would take the mail past MAIL_PICTURE_BYTES. TorDown passes through.
 */
async function picturesOf(remote: string, get: (url: string) => Promise<Buffer | null>): Promise<{ pictures: (string | null)[]; failed: number }> {
  let urls: string[] = [];
  try { urls = (JSON.parse(remote) as unknown[]).filter((u): u is string => typeof u === "string"); } catch { /* none */ }
  const pictures: (string | null)[] = urls.map(() => null);
  let total = 0;
  let failed = 0;
  for (let i = 0; i < urls.length; i += AT_ONCE) {
    const got = await Promise.all(urls.slice(i, i + AT_ONCE).map((u) => get(u).catch((e) => { if (e instanceof TorDown) throw e; failed++; return null; })));
    got.forEach((b, j) => {
      if (!b || total + b.length > MAIL_PICTURE_BYTES) return;
      const data = pictureData(b);
      if (data) { pictures[i + j] = data; total += b.length; }
    });
  }
  return { pictures, failed };
}

/**
 * Fetch the web pictures of every kept mail that still waits for them, newest mail first, through Tor, and write them
 * into its HTML as data: pictures (a picture that fails stays empty). One run at a time per hub; it stops when the
 * module is switched off, and when Tor stops answering (the mail not done yet waits for the next refresh). Resolves to
 * the number of mails done. On a hub without Tor it fetches nothing: see showPictures.
 */
export function fetchMailImages(hub: Hub): Promise<number> {
  const socks = hub.cfg.torSocks;
  if (!socks) return Promise.resolve(0);
  const busy = fetching.get(hub);
  if (busy) return busy;
  const run = (async () => {
    const db = hub.mailDb;
    const next = db.prepare("SELECT key, html, remote FROM inbox WHERE remote IS NOT NULL ORDER BY at DESC LIMIT ?");
    const save = db.prepare("UPDATE inbox SET html = ?, remote = NULL WHERE key = ? AND remote IS NOT NULL");
    const noPictures = db.prepare("UPDATE inbox SET remote = NULL WHERE key = ?");
    let done = 0;
    let failed = 0;
    let down = false;
    while (!down) {
      if (!hub.modules.on("mail_inbox")) break;
      const rows = next.all(BATCH) as { key: string; html: string; remote: string }[];
      if (!rows.length) break;
      for (const r of rows) {
        try {
          const got = await picturesOf(r.remote, (u) => mailImages.fetch(u, socks));
          failed += got.failed;
          save.run(withImages(r.html, got.pictures), r.key);
          done++;
        } catch (e) {
          if (e instanceof TorDown) { down = true; break; }
          // A mail whose pictures cannot be written in keeps none and is not tried again: it must not hold up the
          // mail after it, refresh after refresh.
          console.error(`[mail-inbox] a mail's pictures could not be written in, so it has none: ${errCode(e)}`);
          noPictures.run(r.key);
          done++;
        }
      }
    }
    if (done) console.log(`[mail-inbox] pictures fetched for ${done} mails${failed ? `, ${failed} pictures failed` : ""}`);
    if (down) console.log("[mail-inbox] Tor is not answering: the pictures not fetched yet wait for the next refresh");
    else if (hub.modules.on("mail_inbox")) await fetchLogos(db, socks);
    return done;
  })();
  fetching.set(hub, run);
  void run.finally(() => fetching.delete(hub)).catch(() => {});
  return run;
}

const showing = new WeakMap<Hub, Map<string, Promise<void>>>();

/**
 * Show pictures, pressed on one open mail on a hub without Tor: that mail's web pictures, fetched straight from the hub
 * because the person asked (the screen told them its sender will see the home's internet address), and written in.
 * Only that mail's: no other mail's, and no logo. A hub with Tor never fetches this way (409). Null when the mail is
 * not kept.
 */
export async function showPictures(hub: Hub, key: string): Promise<MailMessage | null> {
  if (hub.cfg.torSocks) throw new StoreError(409, "This hub fetches mail pictures through Tor on its own, and never another way.");
  const db = hub.mailDb;
  const jobs = showing.get(hub) ?? new Map<string, Promise<void>>();
  showing.set(hub, jobs);
  let job = jobs.get(key);
  if (!job) {
    job = (async () => {
      const r = db.prepare("SELECT html, remote FROM inbox WHERE key = ? AND remote IS NOT NULL").get(key) as { html: string; remote: string } | undefined;
      if (!r) return;
      try {
        const got = await picturesOf(r.remote, (u) => mailImages.direct(u));
        db.prepare("UPDATE inbox SET html = ?, remote = NULL WHERE key = ? AND remote IS NOT NULL").run(withImages(r.html, got.pictures), key);
        console.log(`[mail-inbox] pictures fetched for one mail because its owner asked${got.failed ? `, ${got.failed} pictures failed` : ""}`);
      } catch (e) {
        console.error(`[mail-inbox] a mail's pictures could not be written in, so it has none: ${errCode(e)}`);
        db.prepare("UPDATE inbox SET remote = NULL WHERE key = ?").run(key);
      }
    })().finally(() => jobs.delete(key));
    jobs.set(key, job);
  }
  await job;
  return mailMessage(db, key, false);
}

/** Each linked mailbox with when the Mail screen last refreshed it, what went wrong, and whether more is coming. */
export function mailboxStates(hub: Hub): { email: string; last_refresh: string | null; last_error: string | null; more: boolean }[] {
  const get = hub.mailDb.prepare("SELECT last_refresh, last_error, more FROM mailboxes WHERE account = ?");
  return INBOX_SOURCES.flatMap((source) => source.accounts(hub).map((account) => {
    const s = get.get(account) as { last_refresh: string | null; last_error: string | null; more: number } | undefined;
    return { email: account.slice(source.prefix.length), last_refresh: s?.last_refresh ?? null, last_error: s?.last_error ?? null, more: !!s?.more };
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Refresh

export type RefreshResult = { mailboxes: ({ email: string; kept: number; gone: number; more: boolean } | { email: string; error: string })[] };
/** One refresh at a time per hub: a second ask while one runs gets the same answer. */
const running = new WeakMap<Hub, Promise<RefreshResult>>();

/**
 * Bring every linked iCloud mailbox's Inbox up to date: new mail of the last INBOX_DAYS kept, what left the Inbox gone.
 * `owner`: the Refresh button, which also tries a mailbox paused after a refused password once.
 */
export function refreshMail(hub: Hub, opts: { owner?: boolean } = {}, now: Date = new Date()): Promise<RefreshResult> {
  const busy = running.get(hub);
  if (busy) return busy;
  const run = exclusive(hub, async (): Promise<RefreshResult> => {
    const db = hub.mailDb;
    // Done mail is kept DONE_DAYS (Done view, Undo), then deleted from the hub; it stays in iCloud's Archive.
    wakeSnoozed(hub, now);
    if (db.prepare("DELETE FROM inbox WHERE state = 'done' AND done_at < ?").run(new Date(now.getTime() - DONE_DAYS * DAY_MS).toISOString()).changes) db.pragma("wal_checkpoint(TRUNCATE)");
    const out: RefreshResult = { mailboxes: [] };
    const save = db.prepare("INSERT INTO mailboxes (account, last_refresh, last_error, more) VALUES (?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET last_refresh = excluded.last_refresh, last_error = excluded.last_error, more = excluded.more");
    const since = new Date(now.getTime() - INBOX_DAYS * DAY_MS);
    for (const [source, account] of INBOX_SOURCES.flatMap((src) => src.accounts(hub).map((a) => [src, a] as const))) {
      const email = account.slice(source.prefix.length);
      try {
        const found = await source.list(hub, account, since, isKept(db, account), isKeptMessage(db, account), opts);
        const r = keepInbox(db, account, found);
        save.run(account, new Date().toISOString(), null, found.more ? 1 : 0);
        if (r.kept || r.gone || found.more) console.log(`[mail-inbox] ${mailboxLabel(hub, account)}: ${r.kept} new, ${r.gone} left the Inbox${found.more ? ", more next time" : ""}`);
        out.mailboxes.push({ email, kept: r.kept, gone: r.gone, more: found.more });
      } catch (e) {
        // A StoreError's message is the hub's own (a source never passes on the server's words); anything else is not shown.
        const error = e instanceof StoreError ? e.message : "The mailbox could not be refreshed. The hub's log has the error code.";
        save.run(account, new Date().toISOString(), error, 0);
        console.error(`[mail-inbox] ${mailboxLabel(hub, account)}: ${errCode(e)}`);
        out.mailboxes.push({ email, error });
      }
    }
    // The new mail's web pictures, in the background (the Refresh button does not wait for them).
    void fetchMailImages(hub).catch((e) => console.error(`[mail-inbox] pictures: ${errCode(e)}`));
    return out;
  });
  running.set(hub, run);
  void run.finally(() => running.delete(hub)).catch(() => {});
  return run;
}

/** A minute after start, then every 15 minutes while the module is on: a refresh; a minute later while more is waiting. */
export function startMailInboxJob(hub: Hub): () => void {
  let soon: NodeJS.Timeout | undefined;
  const tick = () => {
    if (!hub.modules.on("mail_inbox")) return;
    refreshMail(hub).then((r) => {
      // More new mail than one refresh takes (the first one, often): the next batch a minute later.
      if (!r.mailboxes.some((m) => "more" in m && m.more)) return;
      clearTimeout(soon);
      soon = setTimeout(tick, 60_000);
      soon.unref?.();
    }).catch((e) => console.error(`[mail-inbox] ${errCode(e)}`));
  };
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, 15 * 60_000);
  first.unref?.();
  every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); clearTimeout(soon); };
}
