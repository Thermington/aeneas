import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, PASSWORD, type Msg } from "./fake-icloud-mail.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { fetchMailImages, mailImages, type MailMessage, type MailSummary } from "../src/mail-inbox.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** How many messages the Mail screen keeps. */
const kept = (t: TestHub) => (t.hub.mailDb.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n;
const list = async (t: TestHub) => (await (await t.api("/mail")).json()) as { messages: MailSummary[]; mailboxes: { email: string; last_error: string | null; more: boolean }[] };

const ALEX = { name: "Alex", address: "alex@example.com" };
const INBOX: Msg[] = [
  { uid: 1, folder: "INBOX", at: ago(3), subject: "Gutters", from: ALEX, messageId: "a1@x", plain: "Hi Robin,\n\nCan you help with the gutters this weekend?\n\nThanks,\nAlex" },
  { uid: 2, folder: "INBOX", at: ago(1), subject: "Your account", from: { name: "Your Bank", address: "alerts@bank.example" }, replyTo: { address: "help@b4nk-support.example" }, messageId: "p1@x", plain: "Please confirm your details today." },
  { uid: 3, folder: "Archive", at: ago(1), subject: "Archived already", from: ALEX, messageId: "z@x", plain: "x" },
];

test("mail routes: Refresh keeps the Inbox; the list has no text, a message has all of it, as written", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(INBOX);
    const r = await (await t.api("/mail/refresh", { method: "POST" })).json() as { mailboxes: { email: string; kept: number; more: boolean }[] };
    assert.deepEqual(r.mailboxes, [{ email: EMAIL, kept: 2, gone: 0, more: false }]);
    const l = await list(t);
    assert.deepEqual(l.messages.map((m) => m.subject), ["Your account", "Gutters"], "newest first, Inbox only");
    assert.equal(l.messages[0].reply_to, "help@b4nk-support.example", "a Reply-To that differs comes with it");
    assert.equal(l.messages[1].preview, "Hi Robin, Can you help with the gutters this weekend? Thanks, Alex");
    assert.ok(!("text" in l.messages[1]));
    assert.equal(l.mailboxes[0].email, EMAIL);
    const m = await (await t.api(`/mail/messages/${l.messages[1].id}`)).json() as MailMessage;
    assert.equal(m.text, "Hi Robin,\n\nCan you help with the gutters this weekend?\n\nThanks,\nAlex", "nothing taken off");
    assert.equal((await t.api("/mail/messages/000000000000000000000000")).status, 404);
  } finally { done(t); }
});

test("mail routes: an HTML mail is kept cleaned, its web pictures fetched by the hub, and opens as a page that loads nothing", async () => {
  const t = makeHub();
  const fetched: string[] = [];
  const realFetch = mailImages.fetch;
  try {
    linked(t);
    fake([{
      uid: 5, folder: "INBOX", at: ago(0), subject: "Your next coffee", from: { name: "Shop", address: "news@shop.example" }, messageId: "c@x",
      // A text part in Markdown, as some senders write it: the list reads the HTML instead.
      plain: "[Coffee](https://shop.example/all) [Account](https://shop.example/me)\n\nEstimated arrival: Sun",
      html: `<p><a href="https://shop.example/all">Coffee</a> <a href="https://shop.example/me">Account</a></p><p>Estimated arrival: Sun</p><img src="https://img.example/bean.png" alt="Beans"><img src="https://img.example/pixel.gif" width="1" height="1"><script>alert(1)</script>`,
    }]);
    mailImages.fetch = async (url) => { fetched.push(url); return url.endsWith("bean.png") ? PNG : null; };
    await t.api("/mail/refresh", { method: "POST" });
    await fetchMailImages(t.hub);
    const l = await list(t);
    assert.equal(l.messages[0].preview, "Coffee Account Estimated arrival: Sun", "link words only, from the HTML");
    assert.deepEqual(fetched.sort(), ["https://img.example/bean.png", "https://img.example/pixel.gif"], "every web picture, whether opened or not");
    const m = await (await t.api(`/mail/messages/${l.messages[0].id}`)).json() as MailMessage;
    assert.equal(m.pictures_pending, false);
    assert.ok(m.html!.startsWith("<!doctype html>"));
    assert.match(m.html!, /Content-Security-Policy" content="default-src 'none'; img-src data:/);
    assert.match(m.html!, /<img src="data:image\/png;base64,[^"]+" alt="Beans">/);
    assert.doesNotMatch(m.html!, /img\.example|<script|data-r=/, "no web address and nothing that runs");
    assert.match(m.html!, /<a href="https:\/\/shop\.example\/all">Coffee<\/a>/);
  } finally { mailImages.fetch = realFetch; done(t); }
});

test("mail routes: Pin is kept on the hub, nothing is sent to iCloud, and only a kept mail can be pinned", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(INBOX);
    await t.api("/mail/refresh", { method: "POST" });
    const calls = seen.calls.length;
    const id = (await list(t)).messages[1].id;
    assert.equal((await t.api(`/mail/messages/${id}/pin`, { method: "POST", json: { pinned: true } })).status, 200);
    assert.equal((await list(t)).messages.find((m) => m.id === id)!.pinned, true);
    assert.equal((await t.api(`/mail/messages/${id}/pin`, { method: "POST", json: { pinned: false } })).status, 200);
    assert.equal((await list(t)).messages.find((m) => m.id === id)!.pinned, false);
    assert.equal(seen.calls.length, calls, "no connection to iCloud");
    assert.equal((await t.api(`/mail/messages/${id}/pin`, { method: "POST", json: { pinned: "yes" } })).status, 422);
    assert.equal((await t.api("/mail/messages/000000000000000000000000/pin", { method: "POST", json: { pinned: true } })).status, 404);
    assert.ok(refuseToolCall("POST", `/mail/messages/${id}/pin`), "the assistant cannot pin");
  } finally { done(t); }
});

test("mail routes: a second refresh fetches only what is new, and drops what left the Inbox", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = [...INBOX];
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const downloads = seen.calls.filter((c) => c === "download").length;
    msgs.push({ uid: 9, folder: "INBOX", at: ago(0), subject: "New one", from: ALEX, messageId: "n@x", plain: "Hello" });
    msgs.splice(msgs.findIndex((m) => m.uid === 1), 1);
    const r = await (await t.api("/mail/refresh", { method: "POST" })).json() as { mailboxes: { kept: number; gone: number }[] };
    assert.deepEqual([r.mailboxes[0].kept, r.mailboxes[0].gone], [1, 1]);
    assert.equal(seen.calls.filter((c) => c === "download").length, downloads + 1, "only the new message's text fetched");
    assert.deepEqual((await list(t)).messages.map((m) => m.subject), ["New one", "Your account"]);
  } finally { done(t); }
});

test("mail routes: unlinking deletes the mailbox's mail; switching the module off deletes it all and closes the routes", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(INBOX);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal((await t.api(`/connections/icloud/${encodeURIComponent(EMAIL)}`, { method: "DELETE" })).status, 200);
    assert.equal(kept(t), 0);

    linked(t);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(kept(t), 2);
    await t.api("/modules", { method: "PUT", json: { mail_inbox: false } });
    assert.equal(kept(t), 0, "module off: mail deleted");
    const r = await t.api("/mail");
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as { module: string }).module, "mail_inbox");
  } finally { done(t); }
});

test("mail routes: the iCloud link serves either module; receipts' Read now needs receipts on", async () => {
  const t = makeHub();
  try {
    const seen = fake([]);
    await t.api("/modules", { method: "PUT", json: { mail: false, mail_inbox: true } });
    assert.equal((await t.api("/connections/icloud", { method: "PUT", json: { email: EMAIL, password: PASSWORD } })).status, 200, "linking works with only the Mail screen on");
    assert.equal((await t.api("/connections/icloud/sync", { method: "POST" })).status, 404, "receipts are off");
    await t.api("/modules", { method: "PUT", json: { mail: true, mail_inbox: false } });
    assert.equal((await t.api("/mail")).status, 404);
    assert.equal((await t.api("/connections/icloud/sync", { method: "POST" })).status, 200);
    assert.ok(seen.connects >= 1);
  } finally { done(t); }
});

test("mail routes: the assistant's tools can neither read the mail nor refresh it", () => {
  for (const [m, p] of [["GET", "/mail"], ["GET", "/mail/messages/abc"], ["POST", "/mail/refresh"], ["GET", "/mail%2Fmessages"], ["GET", "/%6Dail"]]) {
    assert.ok(refuseToolCall(m, p), `${m} ${p}`);
  }
});

test("mail routes: a refused password shows on the mailbox, without the server's words", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([], { password: "zzzz-zzzz-zzzz-zzzz" });
    const r = await (await t.api("/mail/refresh", { method: "POST" })).json() as { mailboxes: { error?: string }[] };
    assert.match(r.mailboxes[0].error!, /did not accept/);
    const l = await list(t);
    assert.equal(l.mailboxes[0].last_error, r.mailboxes[0].error);
    assert.ok(!l.mailboxes[0].last_error!.includes("Authentication failed"), "the hub's words, not the server's");
  } finally { done(t); }
});
