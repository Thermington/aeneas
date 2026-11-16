import { createRequire } from "node:module";

/**
 * A small HTML parser for pages from the offline reference: the WHATWG tokenizer's states (tags, attributes with every
 * quoting, comments, doctypes, character references, raw text in script, style and the like) and a tree builder that
 * closes what a browser closes (paragraphs before blocks, list items, table cells, headings) and ignores end tags with
 * nothing open to close. It never throws on bad markup. The sanitizer (sanitize.ts) reads its tree and writes new,
 * escaped markup, so a difference from a browser's reading can drop or keep text but never let markup through.
 *
 * xmldom, the parser the hub already has, reads XML: its HTML mode stops at the first tag that closes out of order,
 * which real pages and hostile ones both have. Its table of named character references is the WHATWG list, used here.
 */

export interface HElement { type: "element"; name: string; attrs: Map<string, string>; children: HNode[]; parent: HElement | null }
export interface HText { type: "text"; text: string; parent: HElement | null }
export type HNode = HElement | HText;

const require = createRequire(import.meta.url);
const NAMED = (require("@xmldom/xmldom/lib/entities.js") as { HTML_ENTITIES: Record<string, string> }).HTML_ENTITIES;

/** Named references a browser also reads without the semicolon (the WHATWG list's legacy names). */
const LEGACY = new Set("AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml".split(" "));

/** Numeric references 0x80 to 0x9F name Windows-1252 characters (WHATWG). */
const C1: Record<number, number> = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 };

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "�";
  return String.fromCodePoint(C1[n] ?? n);
}

/**
 * The character reference at `s[i]` (just after `&`): its text and where reading goes on, or null when it is not one
 * (the `&` is then text). In an attribute, a legacy name without its semicolon followed by `=` or a letter or digit
 * stays as written, as a browser keeps it.
 */
function charRef(s: string, i: number, inAttr: boolean): { text: string; end: number } | null {
  if (s[i] === "#") {
    const hex = s[i + 1] === "x" || s[i + 1] === "X";
    const start = i + (hex ? 2 : 1);
    let j = start;
    while (j < s.length && (hex ? /[0-9a-fA-F]/ : /[0-9]/).test(s[j])) j++;
    if (j === start) return null;
    const n = j - start > 8 ? Infinity : Number.parseInt(s.slice(start, j), hex ? 16 : 10);
    return { text: codePoint(n), end: s[j] === ";" ? j + 1 : j };
  }
  let j = i;
  while (j < s.length && j - i < 40 && /[A-Za-z0-9]/.test(s[j])) j++;
  if (j === i) return null;
  const word = s.slice(i, j);
  if (s[j] === ";" && Object.hasOwn(NAMED, word)) return { text: NAMED[word], end: j + 1 };
  // The longest legacy name the word starts with, read without a semicolon.
  for (let k = word.length; k >= 2; k--) {
    const name = word.slice(0, k);
    if (!LEGACY.has(name)) continue;
    const next = s[i + k];
    if (inAttr && next !== undefined && /[=A-Za-z0-9]/.test(next)) return null;
    return { text: NAMED[name], end: i + k };
  }
  return null;
}

/** Text with its character references read. */
export function decodeEntities(s: string, inAttr = false): string {
  if (!s.includes("&")) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf("&", i);
    if (amp < 0) { out += s.slice(i); break; }
    out += s.slice(i, amp);
    const r = charRef(s, amp + 1, inAttr);
    if (r) { out += r.text; i = r.end; } else { out += "&"; i = amp + 1; }
  }
  return out;
}

export function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}
export function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------- the tree builder's element sets ----------
const VOID = new Set(["area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose content is text to the matching end tag (a browser with scripts on reads noscript this way). */
const RAWTEXT = new Set(["style", "xmp", "iframe", "noembed", "noframes", "noscript", "script"]);
const RCDATA = new Set(["title", "textarea"]);
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "ul", "listing", "plaintext", "xmp"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** An end tag does not close an element past one of these unless it names it (the spec's scope). */
const SCOPE = new Set(["html", "table", "td", "th", "caption", "marquee", "object", "applet", "template", "svg", "math"]);
/** An open `li` (or `dd`, `dt`) is looked for only up to one of these. */
const LIST_SCOPE = new Set([...SCOPE, "ul", "ol", "dl"]);
const TABLE_PARTS = new Set(["tbody", "thead", "tfoot"]);

/** Deeper nesting than this is flattened (a page of 100,000 nested tags must not overflow the stack of any reader). */
const MAX_DEPTH = 400;
/** Larger pages are cut: the reference never has pages this long, and parsing must stay quick. */
export const MAX_HTML_CHARS = 8_000_000;

const WS = /[\t\n\f\r ]/;
const ALPHA = /[A-Za-z]/;

export function parseHtml(input: string): HElement {
  const src = (input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input).replace(/\r\n?/g, "\n").replace(/\u0000/g, "�");
  const root: HElement = { type: "element", name: "#root", attrs: new Map(), children: [], parent: null };
  const stack: HElement[] = [root];
  const current = () => stack[stack.length - 1];

  const addText = (text: string) => {
    if (!text) return;
    const parent = current();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === "text") last.text += text;
    else parent.children.push({ type: "text", text, parent });
  };
  const popUntil = (name: string) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].name === name) { stack.length = i; return; }
    }
  };
  const openIn = (names: Set<string>, scope: Set<string>): string | null => {
    for (let i = stack.length - 1; i > 0; i--) {
      const n = stack[i].name;
      if (names.has(n)) return n;
      if (scope.has(n)) return null;
    }
    return null;
  };
  const closeIfOpen = (names: Set<string>, scope: Set<string>) => {
    const n = openIn(names, scope);
    if (n) popUntil(n);
  };

  const startTag = (name: string, attrs: Map<string, string>) => {
    if (CLOSES_P.has(name)) closeIfOpen(new Set(["p"]), SCOPE);
    if (HEADINGS.has(name) && HEADINGS.has(current().name)) stack.pop();
    if (name === "li") closeIfOpen(new Set(["li"]), LIST_SCOPE);
    if (name === "dd" || name === "dt") closeIfOpen(new Set(["dd", "dt"]), LIST_SCOPE);
    if (name === "option" && current().name === "option") stack.pop();
    if (name === "a") closeIfOpen(new Set(["a"]), SCOPE);
    if (name === "td" || name === "th") closeIfOpen(new Set(["td", "th"]), new Set(["table", "tr"]));
    if (name === "tr") closeIfOpen(new Set(["tr", "td", "th"]), new Set(["table", ...TABLE_PARTS]));
    if (TABLE_PARTS.has(name) || name === "caption" || name === "colgroup") closeIfOpen(new Set([...TABLE_PARTS, "tr", "td", "th", "caption", "colgroup"]), new Set(["table"]));
    const parent = current();
    const el: HElement = { type: "element", name, attrs, children: [], parent };
    parent.children.push(el);
    if (!VOID.has(name) && stack.length < MAX_DEPTH) stack.push(el);
  };
  const endTag = (name: string) => {
    if (name === "br") { startTag("br", new Map()); return; }
    for (let i = stack.length - 1; i > 0; i--) {
      const n = stack[i].name;
      if (n === name) { stack.length = i; return; }
      if (SCOPE.has(n)) return;
    }
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) addText(decodeEntities(src.slice(i, textEnd)));
    if (lt < 0) break;
    i = lt;
    const c = src[i + 1];
    // Comments, doctypes, CDATA and processing instructions: never part of the tree.
    if (c === "!") {
      if (src.startsWith("<!--", i)) {
        // "<!-->" and "<!--->" end at once; otherwise the first "-->" (or "--!>") ends it, else the page does.
        if (src.startsWith("<!-->", i)) { i += 5; continue; }
        if (src.startsWith("<!--->", i)) { i += 6; continue; }
        const a = src.indexOf("-->", i + 4);
        const b = src.indexOf("--!>", i + 4);
        const end = a < 0 ? b : b < 0 ? a : Math.min(a, b);
        i = end < 0 ? n : end + (end === b ? 4 : 3);
        continue;
      }
      const gt = src.indexOf(">", i + 2);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (c === "?") {
      const gt = src.indexOf(">", i + 2);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (c === "/") {
      if (src[i + 2] === ">") { i += 3; continue; }
      if (!src[i + 2] || !ALPHA.test(src[i + 2])) {
        // A bogus comment to the next ">".
        const gt = src.indexOf(">", i + 2);
        i = gt < 0 ? n : gt + 1;
        continue;
      }
      const tag = readTag(src, i + 2);
      if (!tag) break; // the page ended inside the tag: it is dropped
      i = tag.end;
      endTag(tag.name);
      continue;
    }
    if (!c || !ALPHA.test(c)) { addText("<"); i += 1; continue; }
    const tag = readTag(src, i + 1);
    if (!tag) break;
    i = tag.end;
    startTag(tag.name, tag.attrs);
    if (RAWTEXT.has(tag.name) || RCDATA.has(tag.name)) {
      // Text to the matching end tag ("</style" then a space, "/" or ">"), letter case aside.
      const close = new RegExp(`</${tag.name}(?=[\\t\\n\\f\\r />]|$)`, "gi");
      close.lastIndex = i;
      const end = close.exec(src)?.index ?? -1;
      const raw = src.slice(i, end < 0 ? n : end);
      addText(RCDATA.has(tag.name) ? decodeEntities(raw) : raw);
      if (end < 0) { i = n; break; }
      const endTagRead = readTag(src, end + 2);
      i = endTagRead ? endTagRead.end : n;
      endTag(tag.name);
    } else if (tag.name === "plaintext") {
      addText(src.slice(i));
      i = n;
    }
  }
  return root;
}

/** A tag from its name's first letter: its name (lower case), attributes (the first of a name wins) and the end. */
function readTag(s: string, start: number): { name: string; attrs: Map<string, string>; end: number } | null {
  let i = start;
  const n = s.length;
  while (i < n && !WS.test(s[i]) && s[i] !== "/" && s[i] !== ">") i++;
  const name = s.slice(start, i).toLowerCase();
  const attrs = new Map<string, string>();
  while (i < n) {
    while (i < n && (WS.test(s[i]) || s[i] === "/")) i++;
    if (i >= n) return null;
    if (s[i] === ">") return { name, attrs, end: i + 1 };
    // The attribute's name (an "=" first is part of it).
    const ns = i;
    i++;
    while (i < n && !WS.test(s[i]) && s[i] !== "/" && s[i] !== ">" && s[i] !== "=") i++;
    const an = s.slice(ns, i).toLowerCase();
    while (i < n && WS.test(s[i])) i++;
    let value = "";
    if (s[i] === "=") {
      i++;
      while (i < n && WS.test(s[i])) i++;
      if (i >= n) return null;
      const q = s[i];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, i + 1);
        if (close < 0) return null;
        value = decodeEntities(s.slice(i + 1, close), true);
        i = close + 1;
      } else if (q !== ">") {
        const vs = i;
        while (i < n && !WS.test(s[i]) && s[i] !== ">") i++;
        value = decodeEntities(s.slice(vs, i), true);
      }
    }
    if (!attrs.has(an)) attrs.set(an, value);
  }
  return null;
}

/** The first element, in document order, that `test` accepts. */
export function findElement(node: HElement, test: (e: HElement) => boolean): HElement | null {
  for (const c of node.children) {
    if (c.type !== "element") continue;
    if (test(c)) return c;
    const inner = findElement(c, test);
    if (inner) return inner;
  }
  return null;
}

/** Every element `test` accepts, in document order. */
export function findAll(node: HElement, test: (e: HElement) => boolean, limit = Infinity): HElement[] {
  const out: HElement[] = [];
  const walk = (e: HElement) => {
    for (const c of e.children) {
      if (out.length >= limit) return;
      if (c.type !== "element") continue;
      if (test(c)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function hasClass(e: HElement, cls: string): boolean {
  const v = e.attrs.get("class");
  return !!v && v.split(/\s+/).includes(cls);
}

/** Elements that start a new line of text. */
export const BLOCK = new Set(["address", "article", "aside", "blockquote", "br", "caption", "dd", "details", "div", "dl", "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);

/** The element's text, spaces collapsed; blocks are kept apart by a space. */
export function textContent(node: HNode, skip?: (e: HElement) => boolean): string {
  const parts: string[] = [];
  const walk = (x: HNode) => {
    if (x.type === "text") { parts.push(x.text); return; }
    if (skip?.(x)) return;
    if (x.name === "script" || x.name === "style" || x.name === "template" || x.name === "noscript") return;
    const block = BLOCK.has(x.name);
    if (block) parts.push(" ");
    for (const c of x.children) walk(c);
    if (block) parts.push(" ");
  };
  walk(node);
  return parts.join("").replace(/\s+/g, " ").trim();
}
