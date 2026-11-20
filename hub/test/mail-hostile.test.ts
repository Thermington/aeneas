import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCss, cleanMailHtml, withImages } from "../src/mail-html.js";
import { bodyText, htmlToText, looksLikeHtml, readingText, withoutBlocks, withoutComments, withoutTags } from "../src/imports/mail-text.js";
import { parseHtml } from "../src/reference/html.js";
import { previewOf } from "../src/mail-inbox.js";
import { cidParts, type ImapPart } from "../src/imports/icloud.js";

/**
 * Mail is hostile input, and the hub reads it on its one thread: a mail must not be able to hold it. Until 2026-11-20
 * several of these routines searched to the end of the mail again from every `<!--`, `<style`, `<`, `url(` or
 * `@font-face{` that was never closed, so a mail of a few hundred thousand of them took minutes (a megabyte of
 * `<!--a-->`: four minutes in the parser; 100,000 characters of `url(`: seven seconds in the CSS cleaner, a hundred
 * times that at a megabyte).
 */

const SIZE = 600_000;
const fill = (unit: string, size = SIZE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
/** Far above what one pass takes (a fraction of a second), far below what the old patterns took (a minute or more). */
const LIMIT_MS = 5000;
function quick(what: string, run: () => unknown) {
  const t0 = Date.now();
  run();
  const ms = Date.now() - t0;
  assert.ok(ms < LIMIT_MS, `${what} took ${ms} ms`);
}

test("hostile mail: markup that never closes is read in one pass (HTML cleaner, parser, text for reading and for the model)", () => {
  const units = ["<!--a-->", "<!--a--!>", "<!--", "<!x", "<?x", "</ ", "<", "<<", "<p", "<a", "<a ", "<a href='x", "<br", "</p", "<style>", "<STYLE ", "<script>", "<title>", "<head>",
    "<div hidden>", "<div style=\"display:none\">", "<p>", "<a href=\"https://e.example/\">x", "<table><tr><td>", "&#x41", "&amp", "[a](", "(http://", "<http://a", " ("];
  for (const u of units) {
    const mail = fill(u);
    quick(`parseHtml ${u}`, () => parseHtml(mail));
    quick(`cleanMailHtml ${u}`, () => cleanMailHtml(mail));
    quick(`readingText (html) ${u}`, () => readingText([], [mail], "text", "html"));
    quick(`readingText (text part) ${u}`, () => readingText([mail], []));
    quick(`bodyText ${u}`, () => bodyText([], [mail]));
    quick(`looksLikeHtml ${u}`, () => looksLikeHtml(mail));
    quick(`previewOf ${u}`, () => previewOf(mail));
  }
});

test("hostile mail: CSS that never closes is cleaned in one pass, in a <style> and in a style attribute", () => {
  const units = ["url(", "url( ", "url('", "url(\"a", "URL (", "url(data:image/png;base64,AAAA", "@font-face{", "@font-face {a:b;", "@import ", "@import url(", "image-set(", "expression(", "/*", "\\", "{", ";"];
  for (const u of units) {
    const css = fill(u);
    quick(`cleanCss ${u}`, () => cleanCss(css));
    quick(`<style> ${u}`, () => cleanMailHtml(`<style>${css}</style><p>x</p>`));
    quick(`style="" ${u}`, () => cleanMailHtml(`<p style="${css.replace(/"/g, "'")}">x</p>`));
  }
  quick("withImages", () => withImages(fill('<img data-r="1">'), ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]));
  // A web picture's own style is read to tell a tracking pixel: only its start.
  quick("a picture's style of /*", () => cleanMailHtml(`<img src="https://img.example/a.png" style="${fill("/*a")}">`));
  quick("many pictures with long styles", () => cleanMailHtml(fill(`<img src="https://img.example/a.png" style="${"/*a".repeat(600)}">`)));
});

test("hostile mail: a message of thousands of parts is looked through once for its pictures", () => {
  const html = fill("<p>no pictures here</p>", 200_000);
  const parts: ImapPart = { type: "multipart/related", childNodes: Array.from({ length: 20_000 }, (_, i) => ({ part: String(i + 1), type: "image/png", id: `<p${i}@x>`, size: 100 })) };
  quick("cidParts", () => assert.deepEqual(cidParts(parts, html), []));
});

// The one-pass routines against the patterns they replaced, on strings made of the pieces mail is made of.
// A small generator whose every bit is well mixed. The low bits of a plain multiply-and-add repeat every few
// numbers, which, with a count of pieces that is a power of two, made the same few strings over and over.
let seed = 20261120;
const rnd = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const made = (pieces: string[], max: number) => { let s = ""; for (let i = 1 + rnd(max); i > 0; i--) s += pieces[rnd(pieces.length)]; return s; };

test("mail text: taking out blocks, comments and tags in one pass gives what the patterns gave", () => {
  const pieces = ["<", ">", "<>", "<!--", "-->", "--!>", "<!-->", "<!", "<?", "</", "<p>", "</p>", "<p", "<br>", "<br/", "<style>", "</style>", "<STYLE x", "</Style>", "</style >", "<script>", "</script>",
    "<title>", "</title>", "<head>", "</head>", "<a href=\"https://e.example/x\">", "</a>", "<td>", "</td>", "&amp;", "&#60;", "&", "text", " ", "\n", "\"", "'", "/", "x", "<span title=\"a<b\">", "<1", "< "];
  // htmlToText as it was written until 2026-11-20 (of the named characters, only the one the pieces have).
  const before = (html: string) => html
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/gi, "&");
  for (let i = 0; i < 4000; i++) {
    const s = made(pieces, 40);
    assert.equal(withoutBlocks(s), s.replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, " "), JSON.stringify(s));
    assert.equal(withoutComments(s), s.replace(/<!--[\s\S]*?-->/g, " "), JSON.stringify(s));
    assert.equal(withoutTags(s), s.replace(/<[^>]+>/g, " "), JSON.stringify(s));
    assert.equal(htmlToText(s), before(s), JSON.stringify(s));
  }
  assert.equal(bodyText([], ["<p>One</p><!-- gone --><style>p{}</style><b>two</b> &amp; &#51;"]), "One\ntwo & 3");
});

test("mail html: cleaning CSS in one pass gives what the patterns gave", () => {
  const PICTURE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;
  // cleanCss as it was written until 2026-11-20, with the one step added since (an @import the removals leave
  // behind). Its sample picture is a real one: a picture's bytes are checked now, which the patterns did not do.
  const before = (css: string) => css
    .replace(/[<>\u0000]/g, " ")
    .replace(/\\/g, "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/@font-face\s*\{[^}]*\}/gi, "")
    .replace(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_m, _q, u: string) => (PICTURE.test(u.trim()) && u.length <= 3_000_000 ? `("${u.trim().replace(/\s+/g, "")}")` : "none"))
    .replace(/(-webkit-)?image-set\s*\(|url\s*\(/gi, "none(")
    .replace(/expression\s*\(|behavior\s*:|-moz-binding|javascript:/gi, "x-")
    .replace(/@import/gi, "@x-import")
    .replace(//g, "url");
  const pieces = ["url(", "url (", "URL(", "url( ", ")", " )", "'", "\"", " ", "\n", "data:image/png;base64,iVBORw0KGgoAAAAN", "data:image/svg+xml;base64,AAAA", "https://e.example/a.png", "@font-face", "@font-face{", "@FONT-FACE {",
    "{", "}", ";", "a:b", "@import", "\\", "image-set(", "expression(", "behavior:", "javascript:", "x", "<", ">", "/*", "*/", "u\\72l("];
  for (let i = 0; i < 6000; i++) {
    const css = made(pieces, 30);
    assert.equal(cleanCss(css), before(css), JSON.stringify(css));
  }
});
