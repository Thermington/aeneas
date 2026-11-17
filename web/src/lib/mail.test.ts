import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cleanedNote, dayHeading, httpsLink, keepLabel, messageLines, mailLink, mailPath, nameHidesAddress, peopleLine, previewLine, replyToWarning, toLine, withLabel } from "./mail";
import { SCREEN_MODULE, moduleOfScreen } from "./modules";

const ALEX = { name: "Alex", address: "alex@example.com" };

describe("mail screen rules", () => {
  it("names who a conversation is with", () => {
    expect(withLabel({ with: [] })).toBe("You");
    expect(withLabel({ with: [ALEX] })).toBe("Alex");
    expect(withLabel({ with: [{ name: "", address: "sam@example.com" }] })).toBe("sam@example.com");
    expect(withLabel({ with: [ALEX, { name: "Sam", address: "s@x.example" }] })).toBe("Alex and Sam");
    expect(withLabel({ with: [ALEX, ALEX, ALEX, ALEX] })).toBe("Alex, Alex and 2 more");
  });

  it("says which way a conversation went and who is in it", () => {
    expect(previewLine({ preview: "See you at 5.", last_mine: true })).toBe("You: See you at 5.");
    expect(previewLine({ preview: "See you at 5.", last_mine: false })).toBe("See you at 5.");
    // An older hub sends no last_mine.
    expect(previewLine({ preview: "See you at 5." })).toBe("See you at 5.");
    expect(peopleLine([ALEX, { name: " ", address: "sam@example.com" }])).toBe("Alex <alex@example.com>, sam@example.com");
    expect(toLine([ALEX, { name: "Sam", address: "s@x.example" }])).toBe("To Alex and Sam");
    expect(toLine([])).toBeNull();
    expect(toLine(undefined)).toBeNull();
  });

  it("says when the text is a summary or a system's mail, and nothing for a person's mail", () => {
    expect(cleanedNote({ cleaned_by: "summary", automated: true })).toMatch(/^Summary of an automated email/);
    expect(cleanedNote({ cleaned_by: "code", automated: true })).toMatch(/^Automated email/);
    expect(cleanedNote({ cleaned_by: "key-lines", automated: true })).toMatch(/^Key lines of an automated email/);
    expect(cleanedNote({ cleaned_by: "code", automated: false })).toBeNull();
    expect(cleanedNote({ cleaned_by: "model" })).toBeNull();
  });

  it("shows a button line as a link to its https host, and only then", () => {
    const m = { text: "Out for delivery.\n\nTrack my shipment\nTrack at fedex.com\nPay now", links: [
      { text: "Track my shipment", url: "https://store.shop.example/orders/1?key=x" },
      { text: "Track at fedex.com", url: "https://evil.example/fedex" },
      { text: "Pay now", url: "http://shop.example/pay" },
      { text: "Not a line here", url: "https://shop.example/x" },
    ] };
    const lines = messageLines(m);
    expect(lines.map((l) => l.text)).toEqual(["Out for delivery.", "", "Track my shipment", "Track at fedex.com", "Pay now"]);
    expect(lines[2].link).toEqual({ href: "https://store.shop.example/orders/1?key=x", host: "store.shop.example" });
    expect(lines[3].link, "the label names another site").toBeUndefined();
    expect(lines[4].link, "not https").toBeUndefined();
    expect(messageLines({ text: "Track at fedex.com", links: [{ text: "Track at fedex.com", url: "https://www.fedex.com/t" }] })[0].link?.host).toBe("www.fedex.com");
    for (const bad of ["javascript:alert(1)", "https://user:pw@shop.example/", "data:text/html,x", "not a url"]) expect(httpsLink(bad), bad).toBeNull();
  });

  it("warns when replies would go somewhere other than the sender", () => {
    expect(replyToWarning({ from: ALEX })).toBeNull();
    expect(replyToWarning({ from: ALEX, reply_to: "ALEX@example.com" })).toBeNull();
    expect(replyToWarning({ from: { name: "Your Bank", address: "alerts@bank.example" }, reply_to: "help@b4nk-support.example" }))
      .toBe("Replies go to help@b4nk-support.example, not to alerts@bank.example.");
  });

  it("notices a display name that shows another address", () => {
    expect(nameHidesAddress({ name: "support@bank.example", address: "x@evil.example" })).toBe(true);
    expect(nameHidesAddress({ name: "Alex (alex@example.com)", address: "alex@example.com" })).toBe(false);
    expect(nameHidesAddress(ALEX)).toBe(false);
  });

  it("opens only the links the hub makes: Apple Mail's message:// and iCloud Mail on the web", () => {
    const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)";
    const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
    expect(mailLink(`message://${encodeURIComponent("<a1@x>")}`, MAC)).toBe("message://%3Ca1%40x%3E");
    expect(mailLink(`message://${encodeURIComponent("<a1@x>")}`, WINDOWS), "no Apple Mail on Windows").toBeNull();
    expect(mailLink("https://www.icloud.com/mail/", WINDOWS)).toBe("https://www.icloud.com/mail/");
    for (const bad of ["javascript:alert(1)", "https://evil.example/", "message://x", "https://www.icloud.com/mail/../evil", "data:text/html,hi", "", undefined]) {
      expect(mailLink(bad, MAC), String(bad)).toBeNull();
    }
  });

  it("puts a day heading only where the day changes", () => {
    const a = new Date(2026, 10, 17, 9).toISOString();
    const b = new Date(2026, 10, 17, 18).toISOString();
    const c = new Date(2026, 10, 18, 8).toISOString();
    expect(dayHeading(a, null)).toBeTruthy();
    expect(dayHeading(b, a)).toBeNull();
    expect(dayHeading(c, b)).toBeTruthy();
    expect(dayHeading("not a date", null)).toBeNull();
  });

  it("routes and labels", () => {
    expect(mailPath()).toBe("/mail");
    expect(mailPath("ab12")).toBe("/mail?c=ab12");
    expect(keepLabel(7)).toBe("7 days");
    expect(keepLabel(365)).toBe("1 year");
    expect(SCREEN_MODULE["/mail"]).toBe("mail_chat");
    expect(moduleOfScreen("/mail")).toBe("mail_chat");
  });

  it("the Mail screen never renders mail as HTML or markdown", () => {
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|renderMarkdown|insertAdjacentHTML/);
    // Every link it shows goes through mailLink, so no href comes straight from a message.
    expect(src).not.toMatch(/href=\{m\.link\}|href=\{original/);
    // Button links come only from messageLines, which checks them.
    // (The screen's own in-app links, #/mail…, are not from a message.)
    expect((src.match(/href=\{[^}]+\}/g) ?? []).filter((h) => !h.startsWith("href={`#")).sort()).toEqual(["href={line.link.href}", "href={link}"]);
  });
});
