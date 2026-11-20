import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { makeHub, plainBackup } from "./helpers.js";
import type { InboxMail } from "../src/imports/icloud.js";
import { deleteAllMail, deleteMailbox, isKept, isKeptMessage, keepInbox, listMail, mailKey, mailMessage, openMailDb } from "../src/mail-inbox.js";
import { runBackup } from "../src/backup.js";

const ACCOUNT = "icloud:robin@icloud.example";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

let uid = 0;
/** A fetched Inbox message, with only what a test cares about set. */
function mail(over: Partial<InboxMail> = {}): InboxMail {
  uid++;
  return { id: `7:${uid}:INBOX`, at: hoursAgo(uid), message_id: `m${uid}@example.com`, from: { name: "Alex", address: "alex@example.com" }, reply_to: null, subject: `Mail ${uid}`, text: "Hello there.", automated: false, unsubscribe: false, list_id: null, html: null, remote: [], ...over } as InboxMail;
}
const found = (mails: InboxMail[], present: string[] | null = mails.map((m) => m.id), moved: { id: string; message_id: string }[] = []) => ({ present, mails, moved });

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mailinbox-"));
  const file = path.join(dir, "mail.sqlite");
  const db = openMailDb(file);
  return { db, file, done: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const state = (db: ReturnType<typeof openMailDb>) => (db.prepare("SELECT id, message_id, state FROM inbox ORDER BY at DESC").all() as { id: string; message_id: string; state: string }[]);

test("mail-inbox: new Inbox mail is kept once, newest first, with a key that names nothing", () => {
  const { db, done } = tmpDb();
  try {
    const a = mail({ subject: "Gutters", text: "Saturday?\n\nAlex", reply_to: "other@example.com", automated: true });
    const b = mail();
    assert.deepEqual(keepInbox(db, ACCOUNT, found([a, b])), { kept: 2, gone: 0 });
    assert.deepEqual(keepInbox(db, ACCOUNT, found([a, b])), { kept: 0, gone: 0 }, "not kept twice");
    assert.ok(isKept(db, ACCOUNT)(a.id));
    assert.ok(isKeptMessage(db, ACCOUNT)(a.message_id!));
    const list = listMail(db);
    assert.deepEqual(list.map((m) => m.subject), ["Gutters", b.subject]);
    const first = list[0];
    assert.equal(first.id, mailKey(ACCOUNT, a.id));
    assert.match(first.id, /^[0-9a-f]{24}$/, "the API id shows neither address nor folder");
    assert.deepEqual([first.state, first.pinned, first.bundle, first.automated, first.reply_to], ["inbox", false, "other", true, "other@example.com"], "a system's mail with no bundle words is in Other");
    assert.equal(first.preview, "Saturday? Alex", "a first line, on one line");
    assert.equal((first as unknown as { text?: string }).text, undefined, "the list carries no text");
    assert.equal(mailMessage(db, first.id)!.text, "Saturday?\n\nAlex");
    assert.equal(mailMessage(db, "nope"), null);
  } finally { done(); }
});

test("mail-inbox: mail that left the Inbox goes, however old; done mail in Archive stays; no Inbox means nothing goes", () => {
  const { db, done } = tmpDb();
  try {
    const old = mail({ at: hoursAgo(24 * 200) });
    const stays = mail();
    const archived = mail();
    keepInbox(db, ACCOUNT, found([old, stays, archived]));
    db.prepare("UPDATE inbox SET state = 'done', id = '7:50:Archive' WHERE id = ?").run(archived.id);
    // The Inbox no longer lists `old` (archived in Apple Mail): it goes. The done one is in Archive: it stays.
    assert.deepEqual(keepInbox(db, ACCOUNT, found([], [stays.id])), { kept: 0, gone: 1 });
    assert.deepEqual(state(db).map((r) => r.message_id).sort(), [archived.message_id, stays.message_id].sort());
    assert.deepEqual(keepInbox(db, ACCOUNT, found([], null)), { kept: 0, gone: 0 }, "a listing without an Inbox removes nothing");
    assert.deepEqual(keepInbox(db, ACCOUNT, found([], [])), { kept: 0, gone: 1 }, "an empty Inbox: everything left it");
    assert.deepEqual(state(db).map((r) => r.state), ["done"]);
    // Another mailbox's mail is its own.
    keepInbox(db, "icloud:sam@icloud.example", found([mail()]));
    keepInbox(db, ACCOUNT, found([], []));
    assert.equal(listMail(db).length, 2);
  } finally { done(); }
});

test("mail-inbox: a kept message found under a new id takes it; done mail moved back to the Inbox is in the Inbox again", () => {
  const { db, done } = tmpDb();
  try {
    const a = mail();
    const b = mail();
    keepInbox(db, ACCOUNT, found([a, b]));
    const key = listMail(db).find((m) => m.subject === a.subject)!.id;
    db.prepare("UPDATE inbox SET state = 'done', done_at = ?, id = '7:90:Archive' WHERE id = ?").run(new Date().toISOString(), b.id);
    keepInbox(db, ACCOUNT, found([], ["8:1:INBOX", "8:2:INBOX"], [{ id: "8:1:INBOX", message_id: a.message_id! }, { id: "8:2:INBOX", message_id: b.message_id! }]));
    const rows = state(db);
    assert.deepEqual(rows.map((r) => [r.id, r.state]), [["8:1:INBOX", "inbox"], ["8:2:INBOX", "inbox"]], "renumbered ids taken, done one back");
    assert.equal(listMail(db).find((m) => m.subject === a.subject)!.id, key, "the API id stays the same across moves");
  } finally { done(); }
});

test("mail-inbox: the chat view's kept mail is deleted once when the file is opened", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mailinbox-"));
  try {
    const file = path.join(dir, "mail.sqlite");
    const old = new Database(file);
    old.exec("CREATE TABLE messages (key TEXT, text TEXT); CREATE TABLE mailboxes (account TEXT PRIMARY KEY, last_refresh TEXT, last_error TEXT);");
    old.prepare("INSERT INTO messages VALUES ('k', 'wombat-chat-text')").run();
    old.prepare("INSERT INTO mailboxes VALUES ('icloud:x', '2026-11-18', null)").run();
    old.close();
    const db = openMailDb(file);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages'").get(), undefined);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mailboxes").get() as { n: number }).n, 0);
    db.close();
    const bytes = Buffer.concat([fs.readFileSync(file), ...(fs.existsSync(`${file}-wal`) ? [fs.readFileSync(`${file}-wal`)] : [])]);
    assert.ok(!bytes.includes(Buffer.from("wombat-chat-text")), "overwritten, not only forgotten");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mail-inbox: mail kept as text only is fetched again with its HTML (the file is emptied once)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mailinbox-"));
  try {
    const file = path.join(dir, "mail.sqlite");
    const old = new Database(file);
    old.exec(`CREATE TABLE inbox (account TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL UNIQUE, message_id TEXT, at TEXT NOT NULL, from_name TEXT NOT NULL, from_address TEXT NOT NULL, reply_to TEXT, subject TEXT NOT NULL, text TEXT NOT NULL, automated INTEGER NOT NULL, unsubscribe INTEGER NOT NULL, list_id TEXT, bundle TEXT, state TEXT NOT NULL DEFAULT 'inbox', pinned INTEGER NOT NULL DEFAULT 0, snooze_until TEXT, task_id TEXT, done_at TEXT, PRIMARY KEY (account, id));
      CREATE TABLE mailboxes (account TEXT PRIMARY KEY, last_refresh TEXT, last_error TEXT, more INTEGER NOT NULL DEFAULT 0);`);
    old.prepare("INSERT INTO inbox (account, id, key, at, from_name, from_address, subject, text, automated, unsubscribe) VALUES ('a', '7:1:INBOX', 'k', '2026-11-18', 'A', 'a@x', 's', 'numbat-text', 0, 0)").run();
    old.prepare("INSERT INTO mailboxes VALUES ('icloud:x', '2026-11-18', null, 0)").run();
    old.close();
    const db = openMailDb(file);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mailboxes").get() as { n: number }).n, 0, "the next refresh starts over");
    keepInbox(db, ACCOUNT, found([mail({ html: "<p>x</p>", remote: ["https://img.example/a.png"] })]));
    assert.deepEqual(db.prepare("SELECT html, remote FROM inbox").get(), { html: "<p>x</p>", remote: '["https://img.example/a.png"]' });
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mail-inbox: unlinking a mailbox or switching the module off deletes the text from the file itself", () => {
  const { db, file, done } = tmpDb();
  try {
    keepInbox(db, ACCOUNT, found([mail({ text: "zanzibar-one" })]));
    keepInbox(db, "icloud:sam@icloud.example", found([mail({ text: "zanzibar-two" })]));
    assert.equal(deleteMailbox(db, ACCOUNT), 1);
    assert.equal(listMail(db).length, 1, "the other mailbox stays");
    assert.equal(deleteAllMail(db), 1);
    const bytes = Buffer.concat([fs.readFileSync(file), ...(fs.existsSync(`${file}-wal`) ? [fs.readFileSync(`${file}-wal`)] : [])]);
    assert.ok(!bytes.includes(Buffer.from("zanzibar")), "secure_delete and the checkpoint leave no trace on disk");
  } finally { done(); }
});

test("mail-inbox: mail.sqlite sits beside the hub and never reaches the nightly backup", async () => {
  const t = makeHub();
  try {
    assert.ok(fs.existsSync(path.join(t.dir, "mail.sqlite")));
    keepInbox(t.hub.mailDb, ACCOUNT, found([mail({ text: "quokka-mail-text" })]));
    const { file } = await runBackup(t.hub.db, path.join(t.dir, "backups"), t.hub.backupKey);
    const plain = await plainBackup(t, file);
    assert.ok(!fs.readFileSync(plain).includes(Buffer.from("quokka-mail-text")), "backup holds no mail text");
  } finally { t.cleanup(); }
});
