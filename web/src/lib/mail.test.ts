import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { BUNDLES, bundleOf, frameLink, initials, logoSrc, shownAt, snoozeChoices, httpsLink, dayGroup, inboxSections, initial, matches, messageLines, nameHidesAddress, replyToWarning, sendersLine, shownBundles, textParts, viewMessages, whenLabel, type MailSummary } from "./mail";
import { SCREEN_MODULE, moduleOfScreen } from "./modules";

const ALEX = { name: "Alex", address: "alex@example.com" };
const NOW = new Date(2026, 10, 19, 15, 0);
const at = (daysAgo: number, h = 9) => new Date(2026, 10, 19 - daysAgo, h).toISOString();
let n = 0;
const mail = (over: Partial<MailSummary> = {}): MailSummary => ({ id: `m${++n}`, at: at(0), from: ALEX, subject: `Mail ${n}`, preview: "Hello", automated: false, bundle: null, state: "inbox", pinned: false, ...over });
const allOn = () => true;

describe("mail screen rules", () => {
  it("groups by day: Today, Yesterday, This week, This month, then months", () => {
    expect(dayGroup(at(0, 8), NOW)).toBe("Today");
    expect(dayGroup(at(1, 23), NOW)).toBe("Yesterday");
    expect(dayGroup(at(5), NOW)).toBe("This week");
    expect(dayGroup(at(12), NOW)).toBe("This month");
    expect(dayGroup(new Date(2026, 9, 3).toISOString(), NOW)).toBe(new Date(2026, 9, 3).toLocaleDateString([], { month: "long", year: "numeric" }));
    expect(dayGroup("nonsense", NOW)).toBe("Earlier");
    expect(whenLabel(at(0, 9), NOW)).toBe(new Date(2026, 10, 19, 9).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    expect(whenLabel(at(3), NOW)).toBe(new Date(2026, 10, 16, 9).toLocaleDateString([], { weekday: "short" }));
  });

  it("shows module bundles only while their module is on; other mail in an unknown or hidden bundle stands alone", () => {
    const off = (id: string) => id !== "pet";
    expect(shownBundles(allOn).map((b) => b.id)).toEqual(BUNDLES.map((b) => b.id));
    expect(shownBundles(off).map((b) => b.id)).not.toContain("pet");
    expect(shownBundles(off).map((b) => b.id)).toContain("promos");
    expect(bundleOf({ bundle: "pet" }, shownBundles(off))).toBeNull();
    expect(bundleOf({ bundle: "made-up" }, shownBundles(allOn))).toBeNull();
    expect(bundleOf({ bundle: "promos" }, shownBundles(allOn))?.name).toBe("Promos");
  });

  it("lists the Inbox newest first under day headings, a bundle as one row per day, pinned mail on its own", () => {
    const shown = shownBundles(allOn);
    const ms = [
      mail({ at: at(0, 10), subject: "Hike?" }),
      mail({ at: at(0, 9), bundle: "purchases", from: { name: "Northwind", address: "o@northwind.example" } }),
      mail({ at: at(0, 8), bundle: "purchases", from: { name: "Larkspur Books", address: "r@larkspur.example" } }),
      mail({ at: at(0, 7), bundle: "purchases", pinned: true, subject: "Pinned receipt" }),
      mail({ at: at(1), bundle: "purchases" }),
      mail({ at: at(0, 6), state: "done", subject: "Done one" }),
      mail({ at: at(0, 5), state: "snoozed", subject: "Snoozed one" }),
    ];
    const s = inboxSections(ms, shown, { now: NOW });
    expect(s.map((x) => x.title)).toEqual(["Today", "Yesterday"]);
    expect(s[0].rows.map((r) => (r.kind === "mail" ? r.mail.subject : `[${r.bundle.name} ${r.mails.length}]`))).toEqual(["Hike?", "[Purchases 2]", "Pinned receipt"]);
    const bundle = s[0].rows[1];
    expect(bundle.kind === "bundle" && sendersLine(bundle.mails)).toBe("Northwind, Larkspur Books");
    expect(s[1].rows.map((r) => r.kind)).toEqual(["bundle"]);
    expect(inboxSections(ms, shown, { now: NOW, pinnedOnly: true }).flatMap((x) => x.rows).map((r) => r.kind === "mail" && r.mail.subject)).toEqual(["Pinned receipt"]);
    expect(viewMessages(ms, "done", shown).map((m) => m.subject)).toEqual(["Done one"]);
    expect(viewMessages(ms, "snoozed", shown).map((m) => m.subject)).toEqual(["Snoozed one"]);
    expect(viewMessages(ms, "b:purchases", shown)).toHaveLength(4);
  });

  it("searches sender, subject and first words, every word", () => {
    const m = mail({ subject: "Gutters this weekend", preview: "Bring the ladder" });
    expect(matches(m, "")).toBe(true);
    expect(matches(m, "alex LADDER")).toBe(true);
    expect(matches(m, "alex roof")).toBe(false);
  });

  it("gives each sender a letter", () => {
    expect(initial(ALEX)).toBe("A");
    expect(initial({ name: "", address: "sam@example.com" })).toBe("S");
    expect(initial({ name: "\"Ölund\"", address: "x@y" })).toBe("Ö");
    expect(initial({ name: "", address: "" })).toBe("?");
    expect(initials({ name: "Alumni Relations Team", address: "a@x" })).toBe("AT");
    expect(initials({ name: "jordan avery", address: "j@x" })).toBe("JA");
    expect(initials(ALEX)).toBe("A");
    expect(initials({ name: "", address: "sam@example.com" })).toBe("S");
  });

  it("offers the snooze times: later today, tomorrow, the weekend, next week", () => {
    const thu = new Date(2026, 10, 19, 15, 0); // a Thursday, 3 PM
    expect(snoozeChoices(thu).map((c) => [c.id, c.label, c.at.getTime()])).toEqual([
      ["later", "Later today", new Date(2026, 10, 19, 18).getTime()],
      ["tomorrow", "Tomorrow", new Date(2026, 10, 20, 8).getTime()],
      ["weekend", "This weekend", new Date(2026, 10, 21, 9).getTime()],
      ["nextweek", "Next week", new Date(2026, 10, 23, 8).getTime()],
    ]);
    expect(snoozeChoices(new Date(2026, 10, 19, 19, 0)).map((c) => c.id)).not.toContain("later");
    const sat = snoozeChoices(new Date(2026, 10, 21, 10, 0));
    expect(sat.find((c) => c.id === "weekend")).toMatchObject({ label: "Next weekend", at: new Date(2026, 10, 28, 9) });
    expect(sat.find((c) => c.id === "nextweek")!.at).toEqual(new Date(2026, 10, 23, 8));
  });

  it("lists a mail back from a snooze by when it came back, at the top", () => {
    const old = mail({ at: at(5), subject: "Back from snooze", back_at: at(0, 14) });
    const fresh = mail({ at: at(0, 10), subject: "Fresh" });
    expect(shownAt(old)).toBe(at(0, 14));
    const s = inboxSections([fresh, old], shownBundles(allOn), { now: NOW });
    expect(s[0].title).toBe("Today");
    expect(s[0].rows.map((r) => r.kind === "mail" && r.mail.subject)).toEqual(["Back from snooze", "Fresh"]);
  });

  it("shows a logo only as the hub sends it: a data: SVG picture", () => {
    const svg = `data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'/>")}`;
    expect(logoSrc(svg)).toBe(svg);
    expect(logoSrc("https://cdn.shop.example/logo.svg")).toBeNull();
    expect(logoSrc("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(logoSrc(`${svg}" onerror="alert(1)`)).toBeNull();
    expect(logoSrc(undefined)).toBeNull();
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    expect(src.match(/<img [^>]*>/g)).toEqual([`<img src={logo} alt="" />`]);
    expect(src).toMatch(/const logo = m\.logo_domain \? logoSrc\(logos\[m\.logo_domain\]\) : null;/);
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

  it("makes a link's label inside a line a link, with its host beside it", () => {
    const m = { text: "Elm Hall TICKETS HERE\nTake the Band Quiz CLICK HERE and see https://band.example/faq.\nTrack at fedex.com today", links: [
      { text: "TICKETS HERE", url: "https://tickets.example/e/1" },
      { text: "Band Quiz CLICK HERE", url: "https://quiz.example/" },
      { text: "Track at fedex.com", url: "https://evil.example/t" },
      { text: "x", url: "https://too-short.example/" },
    ] };
    const lines = messageLines(m);
    expect(lines[0].parts).toEqual([{ text: "Elm Hall " }, { text: "TICKETS HERE", href: "https://tickets.example/e/1", host: "tickets.example" }]);
    expect(lines[1].parts).toEqual([
      { text: "Take the " }, { text: "Band Quiz CLICK HERE", href: "https://quiz.example/", host: "quiz.example" },
      { text: " and see " }, { text: "https://band.example/faq", href: "https://band.example/faq" }, { text: "." },
    ]);
    expect(lines[2].parts?.some((p) => p.href), "a label naming another site than its link is no link").toBe(false);
    expect(lines.flatMap((l) => l.parts ?? []).some((p) => p.href?.includes("too-short")), "a one-letter label is no link").toBe(false);
  });

  it("makes the https addresses written in a message links, the address itself as their text", () => {
    expect(textParts("See https://example.com/a?b=1. Thanks")).toEqual([
      { text: "See " }, { text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" }, { text: ". Thanks" },
    ]);
    expect(textParts("Visit www.shop.example, or not")[1]).toEqual({ text: "www.shop.example", href: "https://www.shop.example/" });
    expect(textParts("(https://en.wikipedia.example/wiki/Tea_(drink))")[1].text, "a bracket the address opened stays").toBe("https://en.wikipedia.example/wiki/Tea_(drink)");
    expect(textParts("(see https://example.com/x)")[1].text, "a bracket it did not open goes").toBe("https://example.com/x");
    expect(textParts("Plain text, no address.")).toEqual([{ text: "Plain text, no address." }]);
    for (const bad of ["http://example.com", "http://www.example.com", "javascript:alert(1)", "https://user:pw@example.com/", "mailto:a@b.example", "me@www.example.com", "https://localhost/x", "data:text/html,x"]) {
      expect(textParts(`x ${bad} y`).some((p) => p.href), bad).toBe(false);
    }
    // Letters from another alphabet that look like Latin ones: the real host is shown beside it.
    expect(textParts("https://\u0430pple.example/login")[0].warnHost).toBe("xn--pple-43d.example");
    expect(textParts("https://apple.example/")[0].warnHost).toBeUndefined();
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

  it("routes", () => {
    expect(SCREEN_MODULE["/mail"]).toBe("mail_inbox");
    expect(moduleOfScreen("/mail")).toBe("mail_inbox");
  });

  it("the Mail screen shows mail HTML only in a frame where nothing runs, and links only what textParts checked", () => {
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|renderMarkdown|insertAdjacentHTML|document\.write/);
    // The hub's cleaned page goes in one iframe, sandboxed without scripts, popups, forms or navigation.
    expect(src.match(/<iframe[^>]*>/g)).toEqual([`<iframe ref={ref} className="mailx-frame" title={title} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={doc} />`]);
    expect(src).not.toMatch(/allow-scripts|allow-popups|allow-forms|allow-top-navigation|\.src\s*=/);
    // The only href from outside the app's own screens (#/...) is a piece textParts made and checked.
    expect((src.match(/href=\{[^}]+\}/g) ?? []).filter((h) => !h.startsWith("href={`#")).sort()).toEqual(["href={p.href}"]);
    expect(src.match(/<Parts parts=\{[^}]+\}/g)).toEqual(["<Parts parts={textParts(line)}"]);
  });

  it("opens a link from inside a mail only when it is http, https or mailto", () => {
    expect(frameLink("https://shop.example/a")).toBe("https://shop.example/a");
    expect(frameLink("mailto:help@shop.example")).toBe("mailto:help@shop.example");
    expect(frameLink("javascript:alert(1)")).toBeNull();
    expect(frameLink("file:///c:/x")).toBeNull();
    expect(frameLink(null)).toBeNull();
  });
});
