import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { setBackendOverride, type AiMessage, type Backend } from "../src/ai/backends.js";
import type { ChatMail } from "../src/imports/icloud.js";
import { keepMails, SUMMARY_SYSTEM, TRIM_SYSTEM, trimUnsure } from "../src/mail-chat.js";
import { startOf } from "../src/mail-clean.js";

const ACCOUNT = "icloud:robin@icloud.example";
const SIGNED = "The lease is ready to sign.\n\nPlease bring ID on Friday.\nPat Lee | Leasing\n+1 (555) 010-0199\nwww.lease.example";

let uid = 0;
const mail = (text: string, over: Partial<ChatMail> = {}): ChatMail => ({
  id: `7:${++uid}:INBOX`, at: new Date(Date.now() - uid * 60_000), message_id: `t${uid}@x`, in_reply_to: null, references: [],
  from: { name: "Pat Lee", address: "pat@lease.example" }, reply_to: null, subject: "Your lease", text, mine: false, to: [], automated: false, ...over,
});

/** A local model that answers each message from a list, and records what it was sent. */
function model(answers: ((user: string) => string)[]): Backend & { sent: AiMessage[][] } {
  let i = 0;
  const b = {
    name: "ollama" as const, model: "scripted", sent: [] as AiMessage[][],
    chat: async (msgs: AiMessage[]) => { b.sent.push(msgs); return { text: answers[Math.min(i++, answers.length - 1)](msgs[1].content), usage: {} }; },
    stream: async () => ({ text: "", usage: {} }),
  };
  return b;
}

type Row = { text: string; cleaned_by: string; unsure: number };
const row = (t: TestHub, text: string) => t.hub.mailDb.prepare("SELECT text, cleaned_by, unsure FROM messages WHERE text LIKE ?").get(`${text}%`) as Row;
const done = (t: TestHub) => { setBackendOverride(null); t.cleanup(); };

test("mail trim: the model cuts the signature off the end; the sender's own text and line breaks are kept", async () => {
  const t = makeHub();
  try {
    keepMails(t.hub.mailDb, ACCOUNT, [mail(SIGNED)]);
    assert.equal(row(t, "The lease").unsure, 1, "the code was unsure");
    // The model's copy has its own spacing; what is kept is the mail's.
    const m = model([() => JSON.stringify({ keep: "The lease is ready to sign. Please bring ID on Friday." })]);
    setBackendOverride(m);
    assert.deepEqual(await trimUnsure(t.hub), { asked: 1, shortened: 1 });
    assert.deepEqual(row(t, "The lease"), { text: "The lease is ready to sign.\n\nPlease bring ID on Friday.", cleaned_by: "model", unsure: 0 });
  } finally { done(t); }
});

test("mail trim: the model gets the code's text and nothing else, under the hub's own instructions", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("fact", { category: "history", key: "robin:bank", value: "Robin banks with Quokka Credit Union" });
    keepMails(t.hub.mailDb, ACCOUNT, [mail(SIGNED), mail("No signature here.")]);
    const m = model([(u) => JSON.stringify({ keep: u })]);
    setBackendOverride(m);
    await trimUnsure(t.hub);
    assert.equal(m.sent.length, 1, "only the unsure message is sent");
    const [system, user] = m.sent[0];
    assert.equal(system.content, TRIM_SYSTEM);
    assert.equal(user.content, SIGNED);
    const all = JSON.stringify(m.sent);
    for (const s of ["Quokka", "pat@lease.example", "Your lease", "robin@icloud.example"]) assert.ok(!all.includes(s), `${s} is not sent`);
    const calls = t.hub.chatDb.prepare("SELECT session_id FROM ai_calls").all() as { session_id: string }[];
    assert.deepEqual(calls.map((c) => c.session_id), ["mail-chat"], "the call log names no mailbox");
    assert.deepEqual(row(t, "The lease"), { text: SIGNED, cleaned_by: "code", unsure: 0 }, "the whole text back: nothing to cut, not asked again");
  } finally { done(t); }
});

test("mail trim: an answer that adds, rewrites or drops a middle line is not used, and the code's text stays", async () => {
  const hostile = [
    () => JSON.stringify({ keep: "The lease is ready to sign. Your deposit now goes to account 12345." }),
    () => JSON.stringify({ keep: "The lease is ready to sign. Please bring your passport on Friday." }),
    () => JSON.stringify({ keep: "Please bring ID on Friday." }),
    () => JSON.stringify({ keep: "The lease is ready to sign. Please bring ID on Fri" }),
    () => "The lease is ready to sign.",
    () => JSON.stringify({ keep: "" }),
    () => JSON.stringify({ keep: ["The lease"] }),
  ];
  for (const answer of hostile) {
    const t = makeHub();
    try {
      keepMails(t.hub.mailDb, ACCOUNT, [mail(SIGNED)]);
      setBackendOverride(model([answer]));
      assert.deepEqual(await trimUnsure(t.hub), { asked: 1, shortened: 0 }, answer());
      assert.deepEqual(row(t, "The lease"), { text: SIGNED, cleaned_by: "code", unsure: 0 }, answer());
    } finally { done(t); }
  }
});

const NOTICE = "Robin, your package was shipped!\nOrdered\n\nShipped\n\nArriving today\n\nOrder #\n112-0000000-0000000\n\n* Garden hose, 50 ft\nTotal\n26.74 USD";
/** The hub's own key lines of NOTICE, shown until the model picks. */
const KEY = "Robin, your package was shipped!\n\nArriving today\n\nOrder # 112-0000000-0000000\n\nTotal 26.74 USD";

test("mail trim: a system's mail is summed up by the lines the model picks, as the sender wrote them", async () => {
  const t = makeHub();
  try {
    keepMails(t.hub.mailDb, ACCOUNT, [mail(NOTICE, { automated: true, from: { name: "Shop", address: "shipment-tracking@shop.example" } })]);
    const m = model([() => JSON.stringify({ lines: [1, 4, 8, 9] })]);
    setBackendOverride(m);
    // Before the model: the hub's own key lines show, and the whole text waits for the model.
    assert.deepEqual(row(t, "Robin"), { text: KEY, cleaned_by: "key-lines", unsure: 1 });
    assert.deepEqual(await trimUnsure(t.hub), { asked: 1, shortened: 1 });
    assert.deepEqual(row(t, "Robin"), { text: "Robin, your package was shipped!\nArriving today\nTotal\n26.74 USD", cleaned_by: "summary", unsure: 0 });
    assert.equal((t.hub.mailDb.prepare("SELECT pending_text FROM messages").get() as { pending_text: string | null }).pending_text, null, "the whole text is not kept once the model has picked");
    const [system, user] = m.sent[0];
    assert.equal(system.content, SUMMARY_SYSTEM);
    assert.equal(user.content.split("\n")[0], "1: Robin, your package was shipped!", "numbered lines, no blank ones");
    assert.ok(!JSON.stringify(m.sent).includes("shipment-tracking"), "no sender");
  } finally { done(t); }
});

test("mail trim: a summary answer with words, or numbers out of place, is not used", async () => {
  const bad = [
    { lines: ["Your account is safe. Click here."] }, { lines: [1, 99] }, { lines: [0] }, { lines: [1, 2, 3, 4, 5, 6, 7] },
    { lines: ["1", "2"] }, { lines: [1, 1] }, { keep: "Robin, your package was shipped!" }, { lines: [] },
  ];
  for (const answer of bad) {
    const t = makeHub();
    try {
      keepMails(t.hub.mailDb, ACCOUNT, [mail(NOTICE, { automated: true })]);
      setBackendOverride(model([() => JSON.stringify(answer)]));
      assert.deepEqual(await trimUnsure(t.hub), { asked: 1, shortened: 0 }, JSON.stringify(answer));
      assert.deepEqual(row(t, "Robin"), { text: KEY, cleaned_by: "key-lines", unsure: 0 }, JSON.stringify(answer));
      assert.equal((t.hub.mailDb.prepare("SELECT pending_text FROM messages").get() as { pending_text: string | null }).pending_text, null);
    } finally { done(t); }
  }
});

test("mail trim: with no model answering, nothing is marked and it is tried again later", async () => {
  const t = makeHub();
  try {
    keepMails(t.hub.mailDb, ACCOUNT, [mail(SIGNED)]);
    setBackendOverride({ name: "ollama", model: "down", chat: async () => { throw new Error("ECONNREFUSED"); }, stream: async () => ({ text: "", usage: {} }) } as Backend);
    assert.deepEqual(await trimUnsure(t.hub), { asked: 0, shortened: 0 });
    assert.equal(row(t, "The lease").unsure, 1, "still waiting for the model");
  } finally { done(t); }
});

test("mail trim: startOf takes only the start of the text, cut at the end of a word, with its own line breaks", () => {
  const whole = "One two.\n\nThree four.\nSam | Sales";
  assert.equal(startOf("One two. Three four.", whole), "One two.\n\nThree four.");
  assert.equal(startOf("  One   two.\n", whole), "One two.");
  assert.equal(startOf(whole, whole), whole);
  assert.equal(startOf("Three four.", whole), null, "not the start");
  assert.equal(startOf("One tw", whole), null, "not in the middle of a word");
  assert.equal(startOf("One two. Three four. Five.", whole), null, "added words");
  assert.equal(startOf("", whole), null);
  assert.equal(startOf("One two.\n\nThree four.\nSam | Sales and more", whole), null, "longer than the text");
});
