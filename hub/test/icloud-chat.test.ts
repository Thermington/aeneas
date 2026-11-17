import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { ACCOUNT, ago, done, EMAIL, fake, FOLDERS, linked, type Msg } from "./fake-icloud-chat.js";
import { CHAT_MAX, chatFolders, headerValue, isAutomated, listChatICloud, messageIds, originalICloud, REFUSED } from "../src/imports/icloud.js";
import { looksLikeHtml, readingText } from "../src/imports/mail-text.js";
import { cleanMail } from "../src/mail-clean.js";

test("icloud chat: reads Sent but not Junk, Trash or Drafts, every folder read-only", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake([
      { uid: 1, folder: "INBOX", at: ago(1), subject: "Gutters", from: { name: "Alex", address: "alex@example.com" }, messageId: "a1@example.com", plain: "Saturday?" },
      { uid: 2, folder: "Sent Messages", at: ago(1), subject: "Re: Gutters", from: { name: "Robin", address: EMAIL }, messageId: "r1@icloud.example", inReplyTo: "a1@example.com", references: "<a1@example.com>", plain: "Yes!" },
      { uid: 3, folder: "Junk", at: ago(1), subject: "You won", from: { address: "spam@example.com" }, plain: "x" },
      { uid: 4, folder: "Drafts", at: ago(1), subject: "unsent", from: { address: EMAIL }, plain: "x" },
    ]);
    const { mails, more } = await listChatICloud(t.hub, ACCOUNT, ago(7), () => false);
    assert.equal(more, false);
    assert.deepEqual(seen.opened.map((o) => o.path), ["INBOX", "Archive", "Sent Messages"]);
    assert.ok(seen.opened.every((o) => o.readOnly === true), "EXAMINE, never SELECT");
    assert.deepEqual(mails.map((m) => [m.subject, m.mine]), [["Gutters", false], ["Re: Gutters", true]]);
    const reply = mails[1];
    assert.equal(reply.id, "7:2:Sent Messages");
    assert.equal(reply.message_id, "r1@icloud.example", "angle brackets off");
    assert.equal(reply.in_reply_to, "a1@example.com");
    assert.deepEqual(reply.references, ["a1@example.com"]);
    assert.equal(reply.reply_to, null, "Reply-To that is the From address is no warning");
    // Only the calls the read-only client type has, every connection closed.
    assert.equal(seen.connects, 1);
    assert.equal(seen.logouts, 1);
    assert.deepEqual([...new Set(seen.calls)].sort(), ["connect", "download", "fetchOne", "list", "logout", "mailboxOpen", "search"]);
    assert.deepEqual(seen.fetches[0], { query: { envelope: true, bodyStructure: true, internalDate: true, headers: ["references", "list-unsubscribe", "list-id", "auto-submitted", "precedence", "feedback-id", "x-mailgun-sid", "x-sg-eid", "x-ses-outgoing", "x-mc-user", "x-pm-message-id", "x-msys-api"] }, o: { uid: true } });
  } finally { done(t); }
});

test("icloud chat: a message from the owner's own address is the owner's wherever it is", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([{ uid: 9, folder: "Archive", at: ago(2), subject: "Note to self", from: { address: "Robin@iCloud.example" }, plain: "milk" }]);
    const { mails } = await listChatICloud(t.hub, ACCOUNT, ago(7), () => false);
    assert.equal(mails[0].mine, true, "addresses compared without case");
    assert.equal(mails[0].from.address, EMAIL);
  } finally { done(t); }
});

test("icloud chat: who a message went to is read only for the owner's own mail, without the owner", async () => {
  const t = makeHub();
  try {
    linked(t);
    const others = [{ name: "Jordan", address: "jordan@work.example" }, { name: "Robin", address: EMAIL }];
    fake([
      { uid: 1, folder: "INBOX", at: ago(1), subject: "Party", from: { name: "Alex", address: "alex@example.com" }, to: others, cc: [{ address: "guest@example.com" }], plain: "8pm" },
      { uid: 2, folder: "Sent Messages", at: ago(1), subject: "Keys", from: { name: "Robin", address: EMAIL }, to: others, cc: [{ address: "guest@example.com" }], plain: "Under the mat" },
    ]);
    const { mails } = await listChatICloud(t.hub, ACCOUNT, ago(7), () => false);
    assert.deepEqual(mails.find((m) => m.subject === "Party")!.to, [], "someone else's mail: its recipients are not read");
    assert.deepEqual(mails.find((m) => m.subject === "Keys")!.to.map((a) => a.address), ["jordan@work.example", "guest@example.com"]);
  } finally { done(t); }
});

test("icloud chat: a Reply-To that differs from From is kept for the warning", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([{ uid: 5, folder: "INBOX", at: ago(1), subject: "Your account", from: { name: "Your Bank", address: "alerts@bank.example" }, replyTo: { address: "help@b4nk-support.example" }, plain: "Please confirm." }]);
    const { mails } = await listChatICloud(t.hub, ACCOUNT, ago(7), () => false);
    assert.equal(mails[0].reply_to, "help@b4nk-support.example");
  } finally { done(t); }
});

test("icloud chat: only mail since the kept window, only what is not kept yet, newest first, at most CHAT_MAX", async () => {
  const t = makeHub();
  try {
    linked(t);
    const many: Msg[] = Array.from({ length: CHAT_MAX + 20 }, (_, i) => ({ uid: i + 1, folder: "INBOX", at: ago(1), subject: `m${i + 1}`, from: { address: "a@example.com" }, plain: "hi" }));
    many.push({ uid: 999, folder: "INBOX", at: ago(30), subject: "old", from: { address: "a@example.com" }, plain: "old" });
    const seen = fake(many);
    const since = ago(7);
    const { mails, more } = await listChatICloud(t.hub, ACCOUNT, since, (id) => id === "7:320:INBOX");
    assert.equal(seen.searches[0].since, since, "the search starts at the kept window");
    assert.equal(more, true);
    assert.equal(mails.length, CHAT_MAX);
    assert.equal(mails[0].subject, "m319", "newest first; 320 was kept already");
    assert.ok(!mails.some((m) => m.subject === "old"));
  } finally { done(t); }
});

test("icloud chat: the text part is read as written, the HTML only when there is no text part", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([
      { uid: 1, folder: "INBOX", at: ago(1), subject: "both", from: { address: "a@example.com" }, plain: "Short.\n\n-- \nAlex", html: "<p>Short.</p>" },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "html", from: { address: "a@example.com" }, html: "<p>First</p><p>Second &amp; last</p><script>alert(1)</script>" },
    ]);
    const { mails } = await listChatICloud(t.hub, ACCOUNT, ago(7), () => false);
    assert.equal(mails.find((m) => m.subject === "both")!.text, "Short.\n\n--\nAlex", "the signature marker is still there for the cleaner");
    assert.equal(mails.find((m) => m.subject === "html")!.text, "First\nSecond & last");
  } finally { done(t); }
});

test("icloud chat: a refused password pauses the mailbox; only the owner's Refresh tries again", async () => {
  const t = makeHub();
  try {
    linked(t);
    let seen = fake([], { password: "zzzz-zzzz-zzzz-zzzz" });
    await assert.rejects(listChatICloud(t.hub, ACCOUNT, ago(7), () => false), (e: any) => e.status === 422);
    const a = t.hub.connections.get().icloud![0];
    assert.ok(a.refused_at);
    assert.equal(a.last_error, REFUSED);
    seen = fake([]);
    await assert.rejects(listChatICloud(t.hub, ACCOUNT, ago(7), () => false), (e: any) => e.status === 409);
    await assert.rejects(originalICloud(t.hub, ACCOUNT, "7:1:INBOX"), (e: any) => e.status === 409);
    assert.equal(seen.connects, 0, "no sign-in on its own after a refusal");
    await listChatICloud(t.hub, ACCOUNT, ago(7), () => false, { owner: true });
    assert.equal(seen.connects, 1);
    assert.equal(t.hub.connections.get().icloud![0].refused_at, null, "a password that works again unpauses it");
  } finally { done(t); }
});

test("icloud chat: Show original fetches one message's whole text, and says when it is gone", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake([{ uid: 4, folder: "Archive", at: ago(3), subject: "Lease", from: { name: "Pat", address: "pat@example.com" }, replyTo: { address: "other@example.com" }, plain: "Hi Robin,\n\nSign by Friday.\n\nPat\n\n> old quote" }]);
    const o = await originalICloud(t.hub, ACCOUNT, "7:4:Archive");
    assert.equal(o!.text, "Hi Robin,\n\nSign by Friday.\n\nPat\n\n> old quote", "nothing taken off");
    assert.equal(o!.reply_to, "other@example.com");
    assert.equal(o!.from.name, "Pat");
    assert.deepEqual(seen.fetches.at(-1), { query: { envelope: true, bodyStructure: true, internalDate: true }, o: { uid: true } });
    assert.equal(await originalICloud(t.hub, ACCOUNT, "8:4:Archive"), null, "UIDVALIDITY changed");
    assert.equal(await originalICloud(t.hub, ACCOUNT, "7:4:Gone folder"), null);
    assert.equal(await originalICloud(t.hub, ACCOUNT, "7:5:Archive"), null);
    assert.equal(await originalICloud(t.hub, ACCOUNT, "not an id"), null);
    assert.equal(seen.connects, seen.logouts, "every connection closed");
  } finally { done(t); }
});

test("icloud chat: header helpers take only what they should from hostile headers", () => {
  assert.deepEqual(messageIds("<a@x> <b@y>\r\n <c@z>"), ["a@x", "b@y", "c@z"]);
  assert.deepEqual(messageIds("no ids here"), []);
  assert.equal(messageIds(Array.from({ length: 500 }, (_, i) => `<id${i}@x>`).join(" ")).length, 50, "at most 50");
  assert.deepEqual(messageIds("<has space@x> <ok@x>"), ["ok@x"]);
  assert.equal(headerValue(Buffer.from("References: <a@x>\r\n\t<b@y>\r\nX-Other: 1\r\n"), "references"), "<a@x> <b@y>", "folded lines unfolded");
  assert.equal(headerValue(Buffer.from("X-References: <evil@x>\r\n"), "references"), "", "only the header named");
  assert.equal(headerValue(undefined, "references"), "");
  assert.deepEqual(chatFolders(FOLDERS).map((f) => f.path), ["INBOX", "Archive", "Sent Messages"]);
});

test("mail-text: readingText keeps paragraphs, drops invisible padding, prefers the text part", () => {
  assert.equal(readingText(["One\r\n\r\n\r\n\r\nTwo​  "], ["<p>ignored</p>"]), "One\n\nTwo");
  assert.equal(readingText(["  "], ["<div>Only&nbsp;HTML</div>"]), "Only HTML");
});

test("mail-text: a text part that is really HTML is never shown as code", () => {
  // As some senders do: the text part holds a chunk of the HTML.
  const broken = 'Apply for aid now. <!-- Mirror link -->\n<center>\n<table role="presentation"><tr><td><a href="https://x.example/m">View online</a></td></tr></table>\n</center>\nYou can now send your form.';
  assert.equal(looksLikeHtml(broken), true);
  assert.equal(readingText([broken], ["<p>Apply for aid now.</p><p>You can now send your form.</p>"]), "Apply for aid now.\nYou can now send your form.", "the HTML part instead");
  assert.ok(!/<|role=/.test(readingText([broken], [])), "or that text made plain when there is no HTML part");
  assert.equal(looksLikeHtml("Use <br> for a line break, and <p> for a paragraph."), false, "a mail about two tags is text");
});

test("mail-text: a text part flattened to one line is read from the HTML, so greeting and sign-off can be told apart", () => {
  // As iCloud Mail on the web sends it: the text part on one line, the HTML with every line.
  const plain = ["Hi Alex, I'd be glad to meet. I'm free from 2:30 to 4:30 PM today. Monday afternoon works too. Best, Robin"];
  const html = ['<html><body><div><div><br></div></div><div>Hi Alex,</div><div style="font-family:system-ui"><br></div><div>I\'d be glad to meet. I\'m free from 2:30 to 4:30 PM today.&nbsp;</div><div><br></div><div>Monday afternoon works too.&nbsp;</div><div><br></div><div>Best,</div><div>Robin</div></body></html>'];
  const read = readingText(plain, html);
  assert.equal(read, "Hi Alex,\n\nI'd be glad to meet. I'm free from 2:30 to 4:30 PM today.\n\nMonday afternoon works too.\n\nBest,\nRobin");
  assert.equal(cleanMail(read, { names: ["Robin Lee"] }).text, "I'd be glad to meet. I'm free from 2:30 to 4:30 PM today.\n\nMonday afternoon works too.");
  // A short text part whose HTML has no more lines stays the text part.
  assert.equal(readingText(["Thanks!"], ["<div>Thanks!</div>"]), "Thanks!");
});

test("icloud chat: a mail a system sent is told from a person's", async () => {
  const h = (s: string) => Buffer.from(s.replace(/\n/g, "\r\n"));
  assert.equal(isAutomated(h("References: <a@x>\n"), "alex@example.com"), false);
  assert.equal(isAutomated(h("List-Unsubscribe: <mailto:u@shop.example>\n"), "deals@shop.example"), true);
  assert.equal(isAutomated(h("List-Id: <club.lists.example>\n"), "sam@example.com"), true);
  assert.equal(isAutomated(h("Auto-Submitted: auto-generated\n"), "x@example.com"), true);
  assert.equal(isAutomated(h("Auto-Submitted: no\n"), "x@example.com"), false);
  assert.equal(isAutomated(h("Precedence: bulk\n"), "x@example.com"), true);
  // Sent through a bulk-mail service: a shop's notice from store+123@t.shop.example has no list headers, but these.
  assert.equal(isAutomated(h("Feedback-Id: ct_x:s_1:shop\n"), "store+123@t.shop.example"), true);
  assert.equal(isAutomated(h("X-Mailgun-Sid: WyJhIl0=\n"), "store+123@t.shop.example"), true);
  assert.equal(isAutomated(h("X-SG-EID: abc\n"), "news@x.example"), true);
  for (const a of ["no_reply@email.fieldstone.example", "noreply@aid.example", "shipment-tracking@shop.example", "do-not-reply@bank.example", "notifications@app.example"]) assert.equal(isAutomated(undefined, a), true, a);
  for (const a of ["alex@example.com", "noreen@example.com", "replyall@example.com"]) assert.equal(isAutomated(undefined, a), false, a);

  // Through the listing: the headers are read, and the owner's own mail never counts.
  const t = makeHub();
  try {
    linked(t);
    fake([
      { uid: 1, folder: "INBOX", at: ago(1), subject: "Shipped", from: { name: "Shop", address: "shipment-tracking@shop.example" }, plain: "Your package was shipped!" },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Hi", from: { name: "Alex", address: "alex@example.com" }, plain: "Lunch?" },
      { uid: 3, folder: "Sent Messages", at: ago(1), subject: "Re: Hi", from: { name: "Robin", address: EMAIL }, plain: "Sure" },
    ]);
    const { mails } = await listChatICloud(t.hub, ACCOUNT, ago(7), () => false);
    assert.deepEqual(mails.map((m) => [m.subject, m.automated]).sort(), [["Hi", false], ["Re: Hi", false], ["Shipped", true]]);
  } finally { done(t); }
});
