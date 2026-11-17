import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHub, plainBackup } from "./helpers.js";
import type { ChatMail } from "../src/imports/icloud.js";
import { deleteAllMail, deleteMailbox, isKept, keepDays, keepMails, keptSince, openMailDb, purgeOld, setKeepDays, subjectKey, threadId } from "../src/mail-chat.js";
import { runBackup } from "../src/backup.js";

const ACCOUNT = "icloud:robin@icloud.example";
const NOW = new Date("2026-11-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

let uid = 0;
/** A fetched message, with only what a test cares about set. */
function mail(over: Partial<ChatMail> & { at: Date }): ChatMail {
  uid++;
  return { id: `7:${uid}:INBOX`, message_id: `m${uid}@example.com`, in_reply_to: null, references: [], from: { name: "Alex", address: "alex@example.com" }, reply_to: null, subject: "Gutters", text: "Hello there.", mine: false, ...over };
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mailchat-"));
  const file = path.join(dir, "mail.sqlite");
  const db = openMailDb(file);
  return { db, file, done: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

type Row = { id: string; thread: string; text: string; cleaned_by: string; unsure: number; mine: number; reply_to: string | null };
const rows = (db: ReturnType<typeof openMailDb>) => db.prepare("SELECT * FROM messages ORDER BY at").all() as Row[];

test("mail-chat: a thread from References and In-Reply-To, whatever order the mail comes in", () => {
  const { db, done } = tmpDb();
  try {
    const root = mail({ at: hoursAgo(30), message_id: "root@x" });
    const reply = mail({ at: hoursAgo(20), message_id: "r1@x", in_reply_to: "root@x", references: ["root@x"], mine: true, subject: "Re: Gutters" });
    const reply2 = mail({ at: hoursAgo(10), message_id: "r2@x", in_reply_to: "r1@x", references: ["root@x", "r1@x"], subject: "Re: Gutters" });
    // The newest reply arrives in a refresh before the rest (the cap of a refresh, a folder read first).
    assert.equal(keepMails(db, ACCOUNT, [reply2], NOW), 1);
    assert.equal(keepMails(db, ACCOUNT, [root, reply], NOW), 2);
    const threads = new Set(rows(db).map((r) => r.thread));
    assert.equal(threads.size, 1, "one conversation");
    assert.equal([...threads][0], threadId("root@x"));
    assert.match([...threads][0], /^[0-9a-f]{16}$/, "the id shows nothing of the mail");
  } finally { done(); }
});

test("mail-chat: a reply that names only its parent joins the parent's conversation", () => {
  const { db, done } = tmpDb();
  try {
    const a = mail({ at: hoursAgo(30), message_id: "a@x" });
    const b = mail({ at: hoursAgo(20), message_id: "b@x", in_reply_to: "a@x", subject: "Re: Gutters" });
    const c = mail({ at: hoursAgo(10), message_id: "c@x", in_reply_to: "b@x", subject: "Re: Gutters" });
    keepMails(db, ACCOUNT, [c, a, b], NOW); // kept oldest first, so each finds the one it answers
    assert.equal(new Set(rows(db).map((r) => r.thread)).size, 1);
  } finally { done(); }
});

test("mail-chat: a Re: with no reply headers joins by subject only with the same person", () => {
  const { db, done } = tmpDb();
  try {
    keepMails(db, ACCOUNT, [mail({ at: hoursAgo(40), message_id: "a@x", subject: "Lease" })], NOW);
    keepMails(db, ACCOUNT, [
      mail({ at: hoursAgo(30), message_id: "b@x", subject: "RE: Re[2]:  lease" }),
      mail({ at: hoursAgo(20), message_id: "c@x", subject: "Re: Lease", from: { name: "Mallory", address: "mallory@example.com" } }),
      mail({ at: hoursAgo(10), message_id: "d@x", subject: "Lease" }),
    ], NOW);
    const t = rows(db).map((r) => r.thread);
    assert.equal(t[1], t[0], "same subject, same person: joined");
    assert.notEqual(t[2], t[0], "someone else cannot slip into the conversation with the same subject");
    assert.notEqual(t[3], t[0], "a new mail without Re: starts its own conversation");
    assert.equal(subjectKey("Fwd: RE:  Re[3]: The  Lease "), "the lease");
  } finally { done(); }
});

test("mail-chat: only the cleaned text is kept, with what the code was unsure of", () => {
  const { db, done } = tmpDb();
  try {
    keepMails(db, ACCOUNT, [
      mail({ at: hoursAgo(5), text: "Hi Robin,\n\nSaturday works.\n\nBest,\nAlex\n\n> On Monday you wrote:\n> SECRET-QUOTE", reply_to: "other@example.com" }),
      mail({ at: hoursAgo(4), text: "Call me.\nPat Lee | Leasing\n+1 555 010 0199" }),
    ], NOW);
    const [a, b] = rows(db);
    assert.equal(a.text, "Saturday works.");
    assert.equal(a.cleaned_by, "code");
    assert.equal(a.reply_to, "other@example.com");
    assert.equal(b.unsure, 1);
    assert.ok(!JSON.stringify(rows(db)).includes("SECRET-QUOTE"), "the quoted history is not kept anywhere");
  } finally { done(); }
});

test("mail-chat: nothing older than the kept window is kept; a shorter window deletes at once; 0 is not offered", () => {
  const { db, done } = tmpDb();
  try {
    assert.equal(keepDays(db), 7, "7 days unless chosen");
    assert.equal(keepMails(db, ACCOUNT, [mail({ at: hoursAgo(24 * 8) }), mail({ at: hoursAgo(24 * 6) }), mail({ at: hoursAgo(24 * 2) })], NOW), 2);
    assert.equal(keptSince(db, NOW).toISOString(), hoursAgo(24 * 7).toISOString());
    assert.equal(purgeOld(db, new Date(NOW.getTime() + 2 * 86400_000)), 1, "two days on, the 6-day-old one is 8 days old");
    assert.equal(setKeepDays(db, 0), null, "never forever");
    assert.equal(setKeepDays(db, 14), null, "only the choices offered");
    assert.equal(setKeepDays(db, "30"), null);
    assert.equal(setKeepDays(db, 30, NOW), 30);
    assert.equal(keepDays(db), 30);
  } finally { done(); }
});

test("mail-chat: a message already kept is not kept twice or fetched again", () => {
  const { db, done } = tmpDb();
  try {
    const m = mail({ at: hoursAgo(1) });
    assert.equal(keepMails(db, ACCOUNT, [m], NOW), 1);
    assert.equal(keepMails(db, ACCOUNT, [{ ...m, text: "changed" }], NOW), 0);
    assert.equal(isKept(db, ACCOUNT)(m.id), true);
    assert.equal(isKept(db, "icloud:other@icloud.example")(m.id), false, "per mailbox");
  } finally { done(); }
});

test("mail-chat: unlinking a mailbox or switching the module off deletes the text from the file itself", () => {
  const { db, file, done } = tmpDb();
  try {
    keepMails(db, ACCOUNT, [mail({ at: hoursAgo(1), text: "zanzibar-one" })], NOW);
    keepMails(db, "icloud:sam@icloud.example", [mail({ at: hoursAgo(1), text: "zanzibar-two" })], NOW);
    assert.equal(deleteMailbox(db, ACCOUNT), 1);
    assert.equal(rows(db).length, 1, "the other mailbox stays");
    assert.equal(deleteAllMail(db), 1);
    const bytes = Buffer.concat([fs.readFileSync(file), ...(fs.existsSync(`${file}-wal`) ? [fs.readFileSync(`${file}-wal`)] : [])]);
    assert.ok(!bytes.includes(Buffer.from("zanzibar")), "secure_delete and the checkpoint leave no trace on disk");
  } finally { done(); }
});

test("mail-chat: mail.sqlite sits beside the hub and never reaches the nightly backup", async () => {
  const t = makeHub();
  try {
    assert.ok(fs.existsSync(path.join(t.dir, "mail.sqlite")));
    keepMails(t.hub.mailDb, ACCOUNT, [mail({ at: new Date(), text: "quokka-mail-text" })]);
    const { file } = await runBackup(t.hub.db, path.join(t.dir, "backups"), t.hub.backupKey);
    const plain = await plainBackup(t, file);
    assert.ok(!fs.readFileSync(plain).includes(Buffer.from("quokka-mail-text")), "backup holds no mail text");
  } finally { t.cleanup(); }
});
