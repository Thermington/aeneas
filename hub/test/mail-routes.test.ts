import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ACCOUNT, ago, done, EMAIL, fake, linked, PASSWORD, type Msg } from "./fake-icloud-chat.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { messageKey, threadId } from "../src/mail-chat.js";

/** How many messages the Mail screen keeps. */
const kept = (t: TestHub) => (t.hub.mailDb.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;

const ALEX = { name: "Alex", address: "alex@example.com" };
const ME = { name: "Robin", address: EMAIL };
const THREAD: Msg[] = [
  { uid: 1, folder: "INBOX", at: ago(3), subject: "Gutters", from: ALEX, messageId: "a1@x", plain: "Hi Robin,\n\nCan you help with the gutters this weekend?\n\nThanks,\nAlex" },
  { uid: 2, folder: "Sent Messages", at: ago(2), subject: "Re: Gutters", from: ME, messageId: "r1@x", inReplyTo: "a1@x", references: "<a1@x>", plain: "Hi Alex,\n\nSure, Saturday?\n\nBest,\nRobin\n\nOn Mon, Alex <alex@example.com> wrote:\n> Can you help with the gutters this weekend?" },
  { uid: 3, folder: "INBOX", at: ago(1), subject: "Re: Gutters", from: ALEX, messageId: "a2@x", inReplyTo: "r1@x", references: "<a1@x> <r1@x>", plain: "Saturday works. I'll bring the ladder.\n\nSent from my iPhone" },
];
const PHISH: Msg = { uid: 4, folder: "INBOX", at: ago(1), subject: "Your account", from: { name: "Your Bank", address: "alerts@bank.example" }, replyTo: { address: "help@b4nk-support.example" }, messageId: "p1@x", plain: "Please confirm your details today." };

test("mail routes: Refresh keeps the mail as conversations, mine and theirs, body text only", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([...THREAD, PHISH]);
    const r = await (await t.api("/mail/refresh", { method: "POST" })).json() as { mailboxes: { email: string; kept: number }[] };
    assert.deepEqual(r.mailboxes, [{ email: EMAIL, listed: 4, kept: 4 }]);

    const list = await (await t.api("/mail/conversations")).json() as { conversations: { id: string; subject: string; with: { address: string }[]; count: number; preview: string }[]; keep_days: number; choices: number[]; mailboxes: { email: string; last_error: string | null }[] };
    assert.equal(list.keep_days, 7);
    assert.deepEqual(list.choices, [7, 30, 90, 365]);
    assert.equal(list.mailboxes[0].last_error, null);
    assert.equal(list.conversations.length, 2);
    const gutters = list.conversations.find((c) => c.subject === "Gutters")!;
    assert.equal(gutters.id, threadId("a1@x"));
    assert.equal(gutters.count, 3);
    assert.deepEqual(gutters.with.map((w) => w.address), [ALEX.address], "the other person, not the owner");
    assert.equal(gutters.preview, "Saturday works. I'll bring the ladder.");

    const conv = await (await t.api(`/mail/conversations/${gutters.id}`)).json() as { messages: { id: string; mine: boolean; text: string; link: string; reply_to?: string }[] };
    assert.deepEqual(conv.messages.map((m) => [m.mine, m.text]), [
      [false, "Can you help with the gutters this weekend?"],
      [true, "Sure, Saturday?"],
      [false, "Saturday works. I'll bring the ladder."],
    ]);
    assert.equal(conv.messages[0].link, `message://${encodeURIComponent("<a1@x>")}`);
    assert.equal(conv.messages[0].id, messageKey(ACCOUNT, "7:1:INBOX"));
    assert.ok(!("reply_to" in conv.messages[0]));

    const phish = list.conversations.find((c) => c.subject === "Your account")!;
    const p = await (await t.api(`/mail/conversations/${phish.id}`)).json() as { messages: { reply_to?: string; from: { address: string } }[] };
    assert.equal(p.messages[0].reply_to, "help@b4nk-support.example", "the warning's address");
    assert.equal(p.messages[0].from.address, "alerts@bank.example", "the real sender address");
    assert.equal((await t.api("/mail/conversations/0000000000000000")).status, 404);
  } finally { done(t); }
});

test("mail routes: a second refresh fetches only what is new; search finds by words in text, subject and names", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake([...THREAD, PHISH]);
    await t.api("/mail/refresh", { method: "POST" });
    const fetched = seen.fetches.length;
    const again = await (await t.api("/mail/refresh", { method: "POST" })).json() as { mailboxes: { listed: number; kept: number }[] };
    assert.deepEqual(again.mailboxes, [{ email: EMAIL, listed: 0, kept: 0 }]);
    assert.equal(seen.fetches.length, fetched, "nothing fetched twice");

    const find = async (q: string) => ((await (await t.api(`/mail/conversations?q=${encodeURIComponent(q)}`)).json()) as { conversations: { subject: string }[] }).conversations.map((c) => c.subject);
    assert.deepEqual(await find("LADDER saturday"), ["Gutters"], "every word, case aside");
    assert.deepEqual(await find("bank"), ["Your account"], "the sender's name");
    assert.deepEqual(await find("ladder bank"), [], "every word must be there");
    assert.deepEqual(await find("%"), [], "no wildcards");
    assert.deepEqual(await find("weekend"), ["Gutters"]);
  } finally { done(t); }
});

test("mail routes: Show original fetches the whole message now, and nothing of it is kept", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(THREAD);
    await t.api("/mail/refresh", { method: "POST" });
    const id = messageKey(ACCOUNT, "7:2:Sent Messages");
    const o = await (await t.api(`/mail/messages/${id}/original`)).json() as { text: string; subject: string };
    assert.match(o.text, /^Hi Alex,/);
    assert.match(o.text, /> Can you help/, "quoted history included");
    assert.ok(!JSON.stringify(t.hub.mailDb.prepare("SELECT * FROM messages").all()).includes("Hi Alex"), "the original is not kept");
    assert.equal((await t.api("/mail/messages/nope/original")).status, 404);
  } finally { done(t); }
});

test("mail routes: keep_days is one of the choices, and a shorter time deletes at once", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([{ ...THREAD[0], at: ago(20) }, THREAD[2]]);
    assert.equal((await t.api("/mail/settings", { method: "PUT", json: { keep_days: 30 } })).status, 200);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(kept(t), 2);
    for (const bad of [0, 14, "7", null]) assert.equal((await t.api("/mail/settings", { method: "PUT", json: { keep_days: bad } })).status, 422, String(bad));
    const r = await (await t.api("/mail/settings", { method: "PUT", json: { keep_days: 7 } })).json() as { keep_days: number };
    assert.equal(r.keep_days, 7);
    assert.equal(kept(t), 1, "the 20-day-old message went at once");
  } finally { done(t); }
});

test("mail routes: unlinking deletes the mailbox's mail; switching the module off deletes it all and closes the routes", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(THREAD);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal((await t.api(`/connections/icloud/${encodeURIComponent(EMAIL)}`, { method: "DELETE" })).status, 200);
    assert.equal(kept(t), 0);

    linked(t);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(kept(t), 3);
    await t.api("/modules", { method: "PUT", json: { mail_chat: false } });
    assert.equal(kept(t), 0, "module off: mail deleted");
    const r = await t.api("/mail/conversations");
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as { module: string }).module, "mail_chat");
  } finally { done(t); }
});

test("mail routes: the iCloud link serves either module; receipts' Read now needs receipts on", async () => {
  const t = makeHub();
  try {
    const seen = fake([]);
    await t.api("/modules", { method: "PUT", json: { mail: false, mail_chat: true } });
    assert.equal((await t.api("/connections/icloud", { method: "PUT", json: { email: EMAIL, password: PASSWORD } })).status, 200, "linking works with only the Mail screen on");
    assert.equal((await t.api("/connections/icloud/sync", { method: "POST" })).status, 404, "receipts are off");
    await t.api("/modules", { method: "PUT", json: { mail: true, mail_chat: false } });
    assert.equal((await t.api("/mail/conversations")).status, 404);
    assert.equal((await t.api("/connections/icloud/sync", { method: "POST" })).status, 200);
    assert.ok(seen.connects >= 1);
  } finally { done(t); }
});

test("mail routes: the assistant's tools can neither read the mail nor refresh it", () => {
  for (const [m, p] of [["GET", "/mail/conversations"], ["GET", "/mail/conversations/abc"], ["GET", "/mail/messages/abc/original"], ["POST", "/mail/refresh"], ["PUT", "/mail/settings"], ["GET", "/mail%2Fconversations"], ["GET", "/%6Dail/conversations"]]) {
    assert.ok(refuseToolCall(m, p), `${m} ${p}`);
  }
});

test("mail routes: a conversation of the owner's own sent mail says who it went to; others' recipients are never kept", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([
      { uid: 1, folder: "Sent Messages", at: ago(1), subject: "Keys", from: ME, messageId: "k1@x", to: [{ name: "Jordan Lee", address: "Jordan@Work.example" }, { address: EMAIL }], cc: [{ name: "Sam", address: "sam@example.com" }], plain: "I left the keys under the mat." },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Party", from: ALEX, messageId: "p1@x", to: [{ name: "Robin", address: EMAIL }, { name: "Secret Guest", address: "guest@example.com" }], plain: "Party at 8!" },
    ]);
    await t.api("/mail/refresh", { method: "POST" });
    const list = await (await t.api("/mail/conversations")).json() as { conversations: { id: string; subject: string; with: { name: string; address: string }[]; last_mine: boolean }[] };
    const keys = list.conversations.find((c) => c.subject === "Keys")!;
    assert.deepEqual(keys.with, [{ name: "Jordan Lee", address: "jordan@work.example" }, { name: "Sam", address: "sam@example.com" }], "To then Cc, not the owner");
    assert.equal(keys.last_mine, true);
    const party = list.conversations.find((c) => c.subject === "Party")!;
    assert.deepEqual(party.with.map((w) => w.address), [ALEX.address]);
    assert.equal(party.last_mine, false);
    const conv = await (await t.api(`/mail/conversations/${keys.id}`)).json() as { with: unknown[]; messages: { to?: { address: string }[] }[] };
    assert.deepEqual(conv.messages[0].to?.map((a) => a.address), ["jordan@work.example", "sam@example.com"]);
    assert.equal(conv.with.length, 2);
    const kept = JSON.stringify(t.hub.mailDb.prepare("SELECT * FROM messages").all());
    assert.ok(!kept.includes("guest@example.com"), "who else someone else's mail went to is not kept");
    // Found by who it went to.
    const found = await (await t.api("/mail/conversations?q=jordan")).json() as { conversations: { subject: string }[] };
    assert.deepEqual(found.conversations.map((c) => c.subject), ["Keys"]);
  } finally { done(t); }
});

test("mail routes: new cleaning rules fetch the kept mail again and clean it by them", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(THREAD);
    await t.api("/mail/refresh", { method: "POST" });
    const fetched = seen.fetches.length;
    // As a hub kept it under the rules before: another version, and a text the old rules left.
    t.hub.mailDb.prepare("UPDATE settings SET value = '1' WHERE key = 'clean_version'").run();
    t.hub.mailDb.prepare("UPDATE messages SET text = 'old rules text'").run();
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(seen.fetches.length, fetched * 2, "everything fetched again");
    assert.ok(!JSON.stringify(t.hub.mailDb.prepare("SELECT text FROM messages").all()).includes("old rules text"));
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(seen.fetches.length, fetched * 2, "once only");
  } finally { done(t); }
});

test("mail routes: an automated message's button comes with it as a link, checked again on the way out", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([{ uid: 1, folder: "INBOX", at: ago(1), subject: "Shipped", from: { name: "Shop", address: "no-reply@shop.example" }, messageId: "s1@x", plain: "Your order shipped.\n\nTrack package\nhttps://shop.example/track?id=1\n\nYour Account\nhttps://shop.example/account" }]);
    await t.api("/mail/refresh", { method: "POST" });
    const list = await (await t.api("/mail/conversations")).json() as { conversations: { id: string }[] };
    const get = async () => ((await (await t.api(`/mail/conversations/${list.conversations[0].id}`)).json()) as { messages: { text: string; automated: boolean; links?: { text: string; url: string }[] }[] }).messages[0];
    const m = await get();
    assert.equal(m.automated, true);
    assert.equal(m.text, "Your order shipped.\n\nTrack package");
    assert.deepEqual(m.links, [{ text: "Track package", url: "https://shop.example/track?id=1" }]);
    // A link that is not https (written straight into the file) never reaches the screen, nor one whose line is not shown.
    t.hub.mailDb.prepare("UPDATE messages SET links = ?").run(JSON.stringify([{ text: "Track package", url: "javascript:alert(1)" }, { text: "Gone line", url: "https://shop.example/x" }]));
    assert.equal((await get()).links, undefined);
  } finally { done(t); }
});

test("mail routes: a refused password shows on the mailbox, without the server's words", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([], { password: "zzzz-zzzz-zzzz-zzzz" });
    const r = await (await t.api("/mail/refresh", { method: "POST" })).json() as { mailboxes: { error?: string }[] };
    assert.match(r.mailboxes[0].error!, /did not accept/);
    const list = await (await t.api("/mail/conversations")).json() as { mailboxes: { last_error: string | null }[] };
    assert.equal(list.mailboxes[0].last_error, r.mailboxes[0].error);
    assert.ok(!list.mailboxes[0].last_error!.includes("Authentication failed"), "the hub's words, not the server's");
  } finally { done(t); }
});
