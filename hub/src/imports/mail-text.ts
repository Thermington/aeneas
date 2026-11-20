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
 *
 * HTML read this way (`readableHtml`) loses what a mail app hides (`display:none`, `visibility:hidden`, `hidden`: the
 * inbox preview line, text meant only for programs) and keeps where its links go: `[label](url)` with `links: "marks"`,
 * for the cleaning rules, which turn each into its label and a link; `label (url)` otherwise, as a text part writes
 * them. A link whose label the text part also has with its own address (`label <https://…>`, often the direct one where
 * the HTML has a click tracker's) takes the text part's.
 *
 * `prefer: "html"` (the Mail screen's list and search): the HTML made plain whenever it says anything, since it is
 * what a mail app shows; many senders' text parts are an afterthought (Markdown links, a mail service's placeholders).
 */
export function readingText(plain: string[], html: string[], links: "marks" | "text" = "text", prefer: "text" | "html" = "text"): string {
  const p = plain.join("\n");
  const fromHtml = (s: string) => readableHtml(s, links, p);
  const h = html.length ? fromHtml(html.join("\n")) : "";
  const count = (s: string) => s.split("\n").filter((l) => l.trim()).length;
  // Some senders put HTML in the text part: then the HTML part (or that text, made plain) is read, never the tags.
  // Others flatten the text part to a line or two (iCloud Mail on the web: "Hi Jennifer, I'd be glad … Best, Robin")
  // while the HTML keeps the lines that tell greeting, message and sign-off apart: then the HTML is read too.
  const flattened = h && count(p) <= 2 && count(h) >= 3;
  const raw = prefer === "html" && h.trim() ? h : p.trim() && !looksLikeHtml(p) && !flattened ? p : html.length ? h : fromHtml(p);
  const lines = raw.replace(/\r\n?/g, "\n").replace(/[\u200b-\u200f\u00ad\u034f\u2060\ufeff]/g, "").replace(/\u00a0/g, " ")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  return lines.filter((l, i) => l.trim() !== "" || (i > 0 && lines[i - 1].trim() !== "")).join("\n").trim();
}

/** Elements with no closing tag: a hidden one is only its tag. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** An opening tag, its attributes bounded (a crafted tag cannot make a pattern take long). */
const OPEN_TAG = /<([a-z][a-z0-9]{0,20})\b([^>]{0,4000})>/gi;
/** Attributes that hide an element in a mail app. */
const HIDES = (attrs: string) => /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs) || /(^|\s)hidden(\s|=|\/|$)/i.test(attrs);

/** `html` without the elements a mail app hides: each hidden element with all that is inside it. */
function withoutHidden(html: string): string {
  let out = "";
  let at = 0;
  OPEN_TAG.lastIndex = 0;
  for (let m = OPEN_TAG.exec(html), n = 0; m && n < 5000; m = OPEN_TAG.exec(html), n++) {
    if (!HIDES(m[2])) continue;
    const name = m[1].toLowerCase();
    let end = OPEN_TAG.lastIndex;
    if (!VOID.has(name) && !m[2].trimEnd().endsWith("/")) {
      // The matching closing tag: the same name, nesting counted.
      const tag = new RegExp(`<(/?)${name}\\b[^>]{0,4000}>`, "gi");
      tag.lastIndex = end;
      let depth = 1;
      for (let t = tag.exec(html); t; t = tag.exec(html)) {
        depth += t[1] ? -1 : 1;
        if (depth === 0) { end = tag.lastIndex; break; }
      }
      if (depth !== 0) end = html.length; // never closed: hidden to the end, as a mail app shows it
    }
    out += html.slice(at, m.index);
    at = end;
    OPEN_TAG.lastIndex = end;
  }
  return out + html.slice(at);
}

/** Marks for a link while the HTML is made plain (the private-use characters are taken out of the mail first). */
const L0 = "\uE000", L1 = "\uE001", L2 = "\uE002";
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const flatSpaces = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The HTML of a mail made plain for reading: hidden elements go, and each link keeps where it goes (see readingText).
 * `plain`: the message's text part, whose `label <url>` addresses are preferred for the same label.
 */
export function readableHtml(html: string, links: "marks" | "text", plain = ""): string {
  const flatPlain = flatSpaces(plain);
  /** The text part's address for this label, when it writes `label <https://…>`. */
  const direct = (label: string) => {
    const i = label.length >= 2 ? flatPlain.indexOf(`${label} <http`) : -1;
    if (i < 0) return null;
    const from = i + label.length + 2;
    const j = flatPlain.indexOf(">", from);
    const url = j > from ? flatPlain.slice(from, j) : "";
    return /^https?:\/\/[^\s<>]{1,2000}$/i.test(url) ? url : null;
  };
  let s = html.replace(/[\uE000-\uE002]/g, "")
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  s = withoutHidden(s);
  // Each <a href> with its label, as marks: the label made plain, the address kept.
  let out = "";
  let at = 0;
  const open = /<a\b([^>]{0,4000})>/gi;
  for (let m = open.exec(s), n = 0; m && n < 5000; m = open.exec(s), n++) {
    const close = /<\/a\s*>/gi;
    close.lastIndex = open.lastIndex;
    const c = close.exec(s);
    if (!c || c.index - open.lastIndex > 4000) continue;
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[1]);
    const raw = (href?.[2] ?? href?.[3] ?? href?.[4] ?? "").trim();
    const label = flatSpaces(htmlToText(s.slice(open.lastIndex, c.index))).replace(/[[\]]/g, "");
    const url = /^https?:\/\//i.test(raw) && !/[<>\s]/.test(raw) ? (direct(label) ?? htmlToText(raw)) : "";
    out += s.slice(at, m.index) + (label && url ? `${L0}${escapeHtml(label)}${L1}${escapeHtml(url)}${L2}` : s.slice(open.lastIndex, c.index));
    at = close.lastIndex;
    open.lastIndex = close.lastIndex;
  }
  s = htmlToText(out + s.slice(at));
  return s.replace(new RegExp(`${L0}([^${L0}${L1}${L2}]*)${L1}([^${L0}${L1}${L2}]*)${L2}`, "g"), (_, label: string, url: string) =>
    links === "marks" ? `[${label}](${url})` : `${label} (${url})`);
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
