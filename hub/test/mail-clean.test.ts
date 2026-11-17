import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanMail, footerStart, isGreeting, isNameSignOff, isPieceOf, isSignOff, keyLines, pickLines, safeLink, summaryLines } from "../src/mail-clean.js";

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
  // A forward with no words of its own shows what it forwards, without the forward's header lines.
  assert.equal(body("---------- Forwarded message ---------\nFrom: Shop\nYour order shipped."), "Your order shipped.");
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

test("mail-clean (rules 2): a long signature after the sign-off goes, blank lines and an address line included", () => {
  const mail = [
    "Hi Robin,", "", "The quote for the roof is attached. We can start on the 3rd.", "",
    "Thanks and regards,", "", "Pat Lee", "Project Manager", "Lee & Sons Roofing", "123 Main St, Suite 4, Springfield, IL 62704",
    "Office: (555) 010-0100", "Mobile: (555) 010-0199", "www.leeroofing.example",
  ].join("\n");
  assert.deepEqual(cleanMail(mail), { text: "The quote for the roof is attached. We can start on the 3rd.", unsure: false });
});

test("mail-clean (rules 2): a signature with no sign-off word goes when it starts with the sender's name", () => {
  const mail = "Can we move Thursday's call to 3pm?\n\nPat Lee\nProject Manager | Lee & Sons\n(555) 010-0100";
  assert.deepEqual(cleanMail(mail, { names: ["Pat Lee"] }), { text: "Can we move Thursday's call to 3pm?", unsure: false });
  assert.equal(cleanMail(mail).unsure, true, "without the sender's name the model is asked instead");
  // The name inside a sentence near the end is not a signature.
  assert.equal(cleanMail("Ask Pat\nLee says the quote is ready.", { names: ["Pat Lee"] }).text, "Ask Pat\nLee says the quote is ready.");
});

test("mail-clean (rules 2): a forward with nothing above it shows the forwarded message, its headers gone", () => {
  for (const marker of ["Begin forwarded message:", "---------- Forwarded message ---------", "-----Original Message-----"]) {
    const mail = `${marker}\n\nFrom: Maple Street Vet <front-desk@maplevet.example>\nSubject: Pepper's checkup\nDate: November 14, 2026 at 9:00:00 AM EST\nTo: Robin <robin@example.com>\n\nDear Robin,\n\nPepper is due for her booster.\n\nKind regards,\nMaple Street Vet`;
    assert.equal(body(mail), "Pepper is due for her booster.", marker);
  }
  // Outlook's own forward: the header block alone, with bold stars.
  assert.equal(body("*From:* Pat Lee <pat@example.com>\n*Sent:* Friday, November 14, 2026 9:00 AM\n*To:* Robin\n*Subject:* Roof\n\nThe quote is attached."), "The quote is attached.");
  // Words above a forward are the message.
  assert.equal(body("FYI, see below.\n\nBegin forwarded message:\n\nFrom: Shop\nYour order shipped."), "FYI, see below.");
});

test("mail-clean (rules 2): more quote and device forms, disclaimers, dashed greetings and longer sign-offs", () => {
  assert.equal(body("Works for me.\n\n*From:* Pat <pat@example.com>\n*Sent:* Monday\n*To:* Robin\n\nOld text"), "Works for me.", "Outlook's bold header");
  assert.equal(body("Works for me.\n\nOn Mon, Nov 17, 2026 at 9:12 AM Pat Lee\n<pat@example.com>\nwrote:\n> old"), "Works for me.", "On ... wrote: over three lines");
  assert.equal(body("Works for me.\n\nGet Outlook for iOS<https://aka.ms/o0ukef>"), "Works for me.");
  assert.equal(body("Works for me.\nSent from my Galaxy"), "Works for me.");
  assert.equal(body("Hi Robin -\nWorks for me."), "Works for me.");
  for (const s of ["Thanks and regards,", "Thanks & regards", "Have a great weekend!", "Kindest regards,", "Thanks in advance,", "Talk to you soon,", "V/R"]) assert.equal(isSignOff(s), true, s);
  assert.equal(isSignOff("Have a great weekend at the lake with the kids"), false, "a sentence");
  const legal = "See you at 5.\n\nCONFIDENTIALITY NOTICE: This e-mail message, including any attachments, is for the sole use of the intended recipient(s) and may contain confidential information.";
  assert.equal(body(legal), "See you at 5.");
  assert.equal(body("This message and any attachments are confidential and intended only for you.\nThe offer stands until Friday."), "This message and any attachments are confidential and intended only for you.\nThe offer stands until Friday.", "never the first line");
});

// Shaped like a real account notice: the message, a help line, the company as sign-off, a separator, links, copyright.
const NOTICE = [
  "A new sign-in key for your Fieldstone account (r●●●●@example.com) was made on November 17, 2026.", "", "Kitchen tablet", "",
  "If you did not do this, change your Fieldstone password now.", "", "If you need more help, visit Fieldstone Support.", "https://help.fieldstone.example/", "",
  "Fieldstone Support", "", "-------------------------------------------------------------", "",
  "Your Account", "https://account.fieldstone.example", "", "Privacy Policy", "https://fieldstone.example/privacy", "",
  "Copyright (c) 2026 Fieldstone Inc., 1 Main Street, Springfield. All rights reserved.",
].join("\n");

// Shaped like a real shipping notice: navigation links, a headline with the greeting, status steps, a footer.
const SHIPPED = [
  "Your Orders", "", "https://shop.example/orders?ref_=nav_orders", "", "Your Account", "", "https://shop.example/account?ref_=nav_acct", "",
  "Robin, your package was shipped!", "Ordered", "", "Shipped", "", "Out for delivery", "", "Arriving today", "", "Order #", "112-0000000-0000000", "",
  "Track package", "https://shop.example/track?orderId=112-0000000-0000000&shipmentId=AbCdEf&ref_=email_track_btn", "",
  "* Garden hose, 50 ft, green", "Quantity: 1", "24.99 USD", "", "Total", "26.74 USD", "",
  "shop-transactional-add-to-calendar-button", "", "https://media.shop.example/cal/x7f3.ics", "",
  "©2026 Shop.example, Inc. or its affiliates. 1 Commerce Way, Springfield.", "",
  "Your invoice can be found here. ( https://shop.example/invoice?orderID=112-0000000-0000000&ref_=inv ) One or more items in your shipment came from another seller.", "",
  "Privacy Notice https://shop.example/privacy",
].join("\n");

test("mail-clean (rules 2): a company footer goes: separator, link list, copyright, and the company's name above it", () => {
  const c = cleanMail(NOTICE, { names: ["Fieldstone"] });
  assert.equal(c.text, "A new sign-in key for your Fieldstone account (r●●●●@example.com) was made on November 17, 2026.\n\nKitchen tablet\n\nIf you did not do this, change your Fieldstone password now.\n\nIf you need more help, visit Fieldstone Support.");
  // A person's mail that ends in a short list without any sure footer mark keeps it.
  assert.equal(body("Bring these:\n\nTent\nStove\nMaps"), "Bring these:\n\nTent\nStove\nMaps");
  assert.deepEqual([footerStart(["Hi", "a", "b"]), footerStart(["Message.", "", "-----", "Links"])], [-1, 1]);
  // The same notice as a system's mail: the separator still marks the footer after its links are gone.
  assert.equal(cleanMail(NOTICE, { automated: true }).text, "A new sign-in key for your Fieldstone account (r●●●●@example.com) was made on November 17, 2026.\n\nKitchen tablet\n\nIf you did not do this, change your Fieldstone password now.\n\nIf you need more help, visit Fieldstone Support.");
});

test("mail-clean (rules 2): an automated mail keeps only its own lines: no navigation, links, image names or footer", () => {
  const c = cleanMail(SHIPPED, { names: ["Shop.example"], automated: true });
  assert.equal(c.unsure, true, "always offered to the model for a summary");
  assert.equal(c.text, [
    "Robin, your package was shipped!", "Ordered", "", "Shipped", "", "Out for delivery", "", "Arriving today", "", "Order #", "112-0000000-0000000", "",
    "Track package", "", "* Garden hose, 50 ft, green", "Quantity: 1", "24.99 USD", "", "Total", "26.74 USD",
  ].join("\n"));
  // The button stays as a link; the navigation ("Your Orders", "Your Account") does not.
  assert.deepEqual(c.links, [{ text: "Track package", url: "https://shop.example/track?orderId=112-0000000-0000000&shipmentId=AbCdEf&ref_=email_track_btn" }]);
  // The greeting after a headline or two goes.
  assert.equal(cleanMail("Apply for aid for next year.\n\nYour form is open\n\nRobin,\n\nYou can now send your form.", { automated: true }).text, "Apply for aid for next year.\n\nYour form is open\n\nYou can now send your form.");
  assert.equal(cleanMail("Click here to view this email as a web page.\nYour bill is ready.\nHow helpful was this email?\n1\n2\n3", { automated: true }).text, "Your bill is ready.");
});

test("mail-clean (rules 3): the key lines of an automated mail, picked by rules, every word the sender's", () => {
  const c = cleanMail(SHIPPED, { automated: true });
  const cleaned = c.text;
  assert.equal(keyLines(cleaned, c.links), "Robin, your package was shipped!\n\nArriving today\n\nOrder # 112-0000000-0000000\n\nTrack package\n\nTotal 26.74 USD", "the button too, and the paragraphs");
  assert.equal(keyLines(cleaned), "Robin, your package was shipped!\n\nArriving today\n\nOrder # 112-0000000-0000000\n\nTotal 26.74 USD", "a line that is no button is no key line for being one");
  const aid = [
    "Apply for aid for next school year.", "Your 2027 form is open today", "You can now send your 2027 form. If you are in school next fall, send it early.",
    "Send your form", "Remember: you must send a form every year.", "If you have questions, visit our help pages.", "Need help with your form? Call us.", "Sign up for text alerts about your form.",
  ].join("\n\n");
  assert.equal(keyLines(aid), "Apply for aid for next school year.\n\nYour 2027 form is open today\n\nYou can now send your 2027 form. If you are in school next fall, send it early.", "help text and offers left out");
  assert.equal(keyLines("Your code is 123456.\nIt expires in 10 minutes."), null, "short enough to show whole");
  for (const l of (keyLines(cleaned) ?? "").split("\n")) for (const w of l.split(/\s+/)) assert.ok(cleaned.includes(w), `"${w}" is the sender's`);
});

test("mail-clean (rules 6): a shop's notice: repeats, the subject, the shop's name and separators go; its button stays, linked", () => {
  // Shaped like a real shop notice: headline, shop name, order number, the headline again between separators, the
  // message, a date, a button, another link, a carrier number with its link, an item list, a help line.
  const notice = [
    "The last item in your order is out for delivery", "", "Fieldstone Records", "", "Order FS1234", "",
    "-----------------------------------------------", "The last item in your order is out for delivery", "-----------------------------------------------", "",
    "The last item in your order is out for delivery.", "Track your shipment to see the delivery status.", "",
    "Estimated delivery date: November 17, 2026", "", "Track my shipment ", "( https://store.fieldstone.example/orders/abc/authenticate?key=xyz&id=1 )", "", "",
    "or Visit our store ", "( https://store.fieldstone.example?id=2 )", "", "", "CARRIER tracking number: 384600000000 ", "( https://carrier.example/track?n=384600000000 )", "",
    "Items in this shipment", "----------------------", "", "Vinyl (10th Anniversary Edition) × 1", "",
    "If you have any questions, reply to this email or", "contact us at help@fieldstone.example.",
  ].join("\n");
  const c = cleanMail(notice, { automated: true, names: ["Fieldstone Records"], subject: "A shipment from order FS1234 is out for delivery" });
  assert.deepEqual(c.links, [{ text: "Track my shipment", url: "https://store.fieldstone.example/orders/abc/authenticate?key=xyz&id=1" }], "only the button that acts on this message");
  assert.ok(!c.text.includes("-----") && !c.text.includes("Fieldstone Records") && !c.text.includes("Order FS1234"), "separators, the shop's name, what the subject says");
  assert.equal(c.text.split("\n").filter((l) => l.startsWith("The last item")).length, 1, "the repeated headline once");
  assert.equal(keyLines(c.text, c.links), "The last item in your order is out for delivery.\nTrack your shipment to see the delivery status.\n\nEstimated delivery date: November 17, 2026\n\nTrack my shipment");
});

test("mail-clean (rules 6): a button's link must be https to a host, and buttons are few", () => {
  for (const ok of ["https://shop.example/track?x=1", "https://a.b.example:8443/p"]) assert.ok(safeLink(ok), ok);
  for (const bad of ["http://shop.example/", "javascript:alert(1)", "https://user:pw@shop.example/", "https://shop.example/a b", "data:text/html,x", `https://shop.example/${"x".repeat(2001)}`]) assert.equal(safeLink(bad), null, bad.slice(0, 40));
  const many = ["Order ready.", ...[1, 2, 3, 4, 5].flatMap((n) => [`View item ${n}`, `https://shop.example/${n}`])].join("\n");
  assert.equal(cleanMail(many, { automated: true }).links?.length, 3, "at most 3");
  const http = cleanMail("Bill ready.\nPay now\nhttp://shop.example/pay", { automated: true });
  assert.equal(http.links, undefined, "an http link is no button");
  assert.ok(!http.text.includes("Pay now"), "and its label goes with it");
});

test("mail-clean (rules 2): a summary is only lines the model picked by number, as the sender wrote them", () => {
  const text = cleanMail(SHIPPED, { automated: true }).text;
  const ls = summaryLines(text);
  assert.equal(ls[0], "Robin, your package was shipped!");
  const pick = (...n: number[]) => n.map((i) => ls.indexOf(["Robin, your package was shipped!", "Arriving today", "Total", "26.74 USD"][i]) + 1);
  assert.equal(pickLines(pick(1, 0, 2, 3), text), "Robin, your package was shipped!\nArriving today\nTotal\n26.74 USD", "in the message's own order");
  for (const bad of [[], [0], [ls.length + 1], [1, 1], ["1"], [1.5], [1, 2, 3, 4, 5, 6, 7], "1,2", null, [{ n: 1 }]]) assert.equal(pickLines(bad, text), null, JSON.stringify(bad));
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
