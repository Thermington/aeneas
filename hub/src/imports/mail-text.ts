/**
 * Turning a message's parts into the plain text the model reads, for every mail source: the text part when it says
 * enough, else the HTML part with its markup taken out; invisible padding (zero-width spaces, soft hyphens, word
 * joiners) goes, and runs of spaces and blank lines close up.
 */

/** The text of a message from its text parts and HTML parts, in the order they came. */
export function bodyText(plain: string[], html: string[]): string {
  const raw = plain.join("\n").trim().length > 200 ? plain.join("\n") : html.length ? htmlToText(html.join("\n")) : plain.join("\n");
  return raw.replace(/[​-‏­͏⁠﻿ ]/g, (c) => (c === " " ? " " : ""))
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
}

/**
 * The text of a message for reading as a person (the Mail screen), not for the model: the text part whenever there is
 * one, since it keeps what the cleaning rules look for (`> ` quotes, the `-- ` signature line); the HTML made plain
 * only when there is none. Paragraphs stay apart (one blank line); invisible padding goes.
 */
export function readingText(plain: string[], html: string[]): string {
  const p = plain.join("\n");
  const h = html.length ? htmlToText(html.join("\n")) : "";
  const count = (s: string) => s.split("\n").filter((l) => l.trim()).length;
  // Some senders put HTML in the text part: then the HTML part (or that text, made plain) is read, never the tags.
  // Others flatten the text part to a line or two (iCloud Mail on the web: "Hi Jennifer, I'd be glad … Best, Robin")
  // while the HTML keeps the lines that tell greeting, message and sign-off apart: then the HTML is read too.
  const flattened = h && count(p) <= 2 && count(h) >= 3;
  const raw = p.trim() && !looksLikeHtml(p) && !flattened ? p : html.length ? h : htmlToText(p);
  const lines = raw.replace(/\r\n?/g, "\n").replace(/[\u200b-\u200f\u00ad\u034f\u2060\ufeff]/g, "").replace(/\u00a0/g, " ")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  return lines.filter((l, i) => l.trim() !== "" || (i > 0 && lines[i - 1].trim() !== "")).join("\n").trim();
}

/** A text part that is really HTML: five or more layout tags or comments (a text that mentions one tag is not). */
export function looksLikeHtml(s: string): boolean {
  const tags = s.slice(0, 512 * 1024).match(/<\/?(table|tr|td|th|tbody|div|p|span|center|br|img|h[1-6]|ul|li|a\s|font|style)\b[^>]{0,2000}>|<!--/gi);
  return (tags?.length ?? 0) >= 5;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", zwnj: "", zwj: "", shy: "", copy: "©", reg: "®", trade: "™", mdash: "-", ndash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: "\"", ldquo: "\"", bull: "*", middot: "*", euro: "€", pound: "£" };

/** A character reference's character, or nothing for a number no character has (&#x110000; threw, and the mail failed). */
const codePoint = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");

export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
