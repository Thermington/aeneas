import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanMail, isGreeting, isNameSignOff, isPieceOf, isSignOff } from "../src/mail-clean.js";

const body = (s: string) => cleanMail(s).text;

test("mail-clean: an Apple Mail reply keeps only what was written above the quote", () => {
  const mail = [
    "Hi Robin,",
    "",
    "Saturday works. I'll bring the ladder.",
    "",
    "Best,",
    "Alex",
    "",
    "Sent from my iPhone",
    "",
    "> On Nov 3, 2026, at 9:14 AM, Robin <robin@example.com> wrote:",
    ">",
    "> Can you help with the gutters this weekend?",
  ].join("\n");
  assert.deepEqual(cleanMail(mail), { text: "Saturday works. I'll bring the ladder.", unsure: false });
});

test("mail-clean: the quote marker in Gmail's style, also when it wraps over two lines", () => {
  assert.equal(body("Sounds good.\n\nOn Tue, Nov 4, 2026 at 9:12 AM Alex Smith <alex@example.com> wrote:\n> old text"), "Sounds good.");
  assert.equal(body("Sounds good.\n\nOn Tue, Nov 4, 2026 at 9:12 AM Alex Smith <alex@\nexample.com> wrote:\n> old text"), "Sounds good.");
});

test("mail-clean: Outlook's quoted message, its underscores and its Original Message line", () => {
  assert.equal(body("Approved.\n\nFrom: Pat Lee <pat@example.com>\nSent: Monday, November 3, 2026 4:01 PM\nTo: Robin\nSubject: Budget\n\nPlease approve."), "Approved.");
  assert.equal(body("Approved.\n________________________________\nFrom: Pat Lee\nPlease approve."), "Approved.");
  assert.equal(body("Approved.\n-----Original Message-----\nPlease approve."), "Approved.");
});

test("mail-clean: a From: line in the sender's own words is not taken for a quoted header", () => {
  assert.equal(body("From: the garden, three tomatoes today.\nMore tomorrow."), "From: the garden, three tomatoes today.\nMore tomorrow.");
});

test("mail-clean: the signature after `-- ` goes, paragraphs stay", () => {
  const mail = "First point.\n\n\n\nSecond point.\n-- \nAlex Smith\nAcme Corp\n+1 555 010 0199";
  assert.deepEqual(cleanMail(mail), { text: "First point.\n\nSecond point.", unsure: false });
});

test("mail-clean: greetings that are only greetings go; a greeting with the message on its line stays", () => {
  for (const g of ["Hi Robin,", "Hello all", "Hey!", "Dear Mr. Smith,", "Good morning team,", "Hi there:", "Robin,", "Alex Smith,"]) assert.equal(isGreeting(g), true, g);
  for (const g of ["Hi Sam, can you send the file?", "Hey Sam I can't make it tonight", "Hello? Is this working", "Sure,", "Thanks,", "Hi. Meeting moved to 3."]) assert.equal(isGreeting(g), false, g);
  assert.equal(body("Hi Sam, can you send the file?"), "Hi Sam, can you send the file?");
  assert.equal(body("Sure,\nI can do that."), "Sure,\nI can do that.");
});

test("mail-clean: sign-offs with a name go; a sentence that starts like one stays", () => {
  for (const s of ["Thanks,", "Thanks!", "Best, Alex", "Cheers - Sam", "Kind regards", "Many thanks.", "Love, Mom"]) assert.equal(isSignOff(s), true, s);
  for (const s of ["Thanks for the update", "Best of luck with the move!", "Regards to your mother", "Cheers to that, see you there"]) assert.equal(isSignOff(s), false, s);
  assert.equal(body("See you then.\nThanks for the update"), "See you then.\nThanks for the update");
  assert.equal(body("The invoice is attached.\n\nKind regards,\nPat Lee\nAccounts Manager"), "The invoice is attached.");
});

test("mail-clean: the body after a sign-off is not mistaken for a signature", () => {
  assert.equal(body("Got it.\nThanks!\nAlso, the meeting moved to 3pm on Thursday."), "Got it.\nThanks!\nAlso, the meeting moved to 3pm on Thursday.");
});

test("mail-clean: a message is never left empty", () => {
  assert.equal(body("Thanks!"), "Thanks!");
  assert.equal(body("Hi Alex,\n\nThanks,\nRobin"), "Hi Alex,\n\nThanks,\nRobin");
  // A forward with no words of its own shows what it forwards.
  assert.equal(body("---------- Forwarded message ---------\nFrom: Shop\nYour order shipped."), "---------- Forwarded message ---------\nFrom: Shop\nYour order shipped.");
  assert.deepEqual(cleanMail("  \n\n "), { text: "", unsure: false });
});

test("mail-clean: an end that still looks like a signature is marked unsure for the model", () => {
  assert.equal(cleanMail("Call me about the lease.\nPat Lee | Leasing\n+1 (555) 010-0199").unsure, true);
  assert.equal(cleanMail("Details are at https://example.com/lease").unsure, true);
  assert.equal(cleanMail("Call me about the lease.").unsure, false);
  assert.equal(cleanMail("We meet at 10:30 on 2026-11-20.").unsure, false, "dates and times are not phone numbers");
});

test("mail-clean: the sender's own name alone at the end goes; a lone word without a known name stays", () => {
  const names = ["Sam Rivera"];
  assert.equal(cleanMail("Perfect, see you at 10.\n\nSam", { names }).text, "Perfect, see you at 10.");
  assert.equal(cleanMail("Perfect.\n- Sam", { names }).text, "Perfect.");
  assert.equal(cleanMail("Perfect.\nSam R.", { names }).text, "Perfect.");
  assert.equal(cleanMail("Perfect.\nSam Rivera", { names }).text, "Perfect.");
  assert.equal(cleanMail("Perfect.\nSam", { names: [] }).text, "Perfect.\nSam", "no name to compare");
  assert.equal(cleanMail("Who is coming?\nSamantha", { names }).text, "Who is coming?\nSamantha", "only the name itself");
  assert.equal(cleanMail("Sam", { names }).text, "Sam", "never empty");
  // A name made of pattern characters is only ever compared as text.
  // As a pattern, ".*" would match any last line; as text it matches only ".*".
  assert.equal(cleanMail("Fine by me.\nxxxx", { names: [".* (x+)+$"] }).text, "Fine by me.\nxxxx");
  for (const n of [".* (x+)+$", "a", ""]) assert.equal(isNameSignOff("anything", [n]), false);
});

test("mail-clean: Windows line endings and odd spaces read like plain ones", () => {
  assert.equal(body("Hi Robin,\r\n\r\nSee you at 5.\r\n\r\nCheers,\r\nAlex"), "See you at 5.");
});

test("mail-clean: a hostile message cannot make the rules take long", () => {
  const long = `On ${"x ".repeat(200_000)}\n${"> ".repeat(100_000)}\n${"Hi ".repeat(50_000)},\n`;
  const t0 = Date.now();
  cleanMail(long);
  cleanMail(`${"-".repeat(500_000)}\n${"_".repeat(500_000)}`);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test("mail-clean: the model's shorter text is kept only when it is a piece of the code's text", () => {
  const code = "The lease is ready to sign.\nPat Lee | Leasing\n+1 (555) 010-0199";
  assert.equal(isPieceOf("The lease is ready to sign.", code), true);
  assert.equal(isPieceOf("The lease is ready\n  to sign.", code), true, "whitespace aside");
  assert.equal(isPieceOf("The lease is ready to sign. Pay at evil.example now.", code), false, "added words");
  assert.equal(isPieceOf("The lease is ready. Pat Lee", code), false, "pieces stitched together");
  assert.equal(isPieceOf("   ", code), false, "nothing is not a piece");
});
