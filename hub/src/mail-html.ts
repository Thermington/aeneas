import { escapeAttr, escapeText, parseHtml, type HElement, type HNode } from "./reference/html.js";

/**
 * A mail's HTML made safe to show on the Mail screen (CONTRACT.md, Mail). The mail is parsed into a tree and written out
 * again from it: only elements and attributes on the lists below survive, so nothing can run, load or submit.
 * - Gone: script, iframe, object, embed, form and its fields, svg, meta, link, base, every `on…` handler, every
 *   `javascript:` or other address that is not http(s) or mailto, and any CSS that loads something (`@import`, `url()`
 *   other than a picture written into the mail, `expression`, `behavior`).
 * - Kept: the layout mail uses (tables, `bgcolor`, `align`, `font`, `center`, inline styles, the mail's own `<style>`
 *   rules), and links (http, https, mailto).
 * - Pictures: one sent inside the mail (`cid:`) is written in as a data: address; a picture on the web is not loaded
 *   by the screen ever. Its address is handed back (`remote`), the hub fetches it (mail-inbox.ts, fetchMailImages) and
 *   writes it in later with `withImages`; until then the tag has no `src`.
 *
 * This is the first of three walls. The screen shows the result in an iframe sandboxed without `allow-scripts` (no
 * script runs, whatever got through), and `mailDocument`'s Content-Security-Policy lets the page load nothing but the
 * data: pictures in it.
 */

/** Elements kept as they are, attributes cleaned. Any other element gives way to what is inside it. */
const KEEP = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite", "code",
  "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s", "samp", "section",
  "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u", "ul",
  "var", "wbr",
]);
/** Left out with everything inside them. `style` is read separately (its rules, cleaned). */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "noembed", "noframes", "template",
  "svg", "math", "title", "meta", "link", "base", "input", "button", "select", "textarea", "option", "optgroup", "datalist", "output",
  "progress", "meter", "audio", "video", "source", "track", "canvas", "map", "area", "param", "dialog", "portal", "xmp", "plaintext",
  "slot", "form", "picture", "xml",
]);
const VOID_OUT = new Set(["br", "col", "hr", "img", "wbr"]);
/** Attributes any kept element may have (layout and text), besides those below. */
const ATTRS = new Set([
  "align", "valign", "bgcolor", "border", "cellpadding", "cellspacing", "color", "colspan", "rowspan", "dir", "face", "height",
  "width", "size", "style", "title", "lang", "class", "id", "role", "span", "start", "type", "nowrap", "summary", "headers", "scope",
]);
/** At most this many web pictures per mail are fetched; the rest stay empty. */
export const IMAGES_MAX = 60;
/** Picture types written into a page, by the bytes at their start (never by what the sender's server calls them). */
const PICTURE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;
/** A data: picture longer than this is left out (a mail's whole HTML is capped anyway). */
const DATA_MAX = 3_000_000;

/** CSS that loads nothing and escapes nothing: no @import, no url() but a data: picture, no old IE script hooks. */
export function cleanCss(css: string): string {
  return css
    .replace(/[<>\u0000\uE020]/g, " ")
    .replace(/\\/g, "") // CSS escapes could spell a word the checks below look for (u\72l, \65xpression)
    .replace(/@import[^;]*;?/gi, "")
    .replace(/@font-face\s*\{[^}]*\}/gi, "")
    // A data: picture is marked (\uE020) while every other url( goes, then written back as url(.
    .replace(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_m, _q, u: string) => (PICTURE.test(u.trim()) && u.length <= DATA_MAX ? `\uE020("${u.trim().replace(/\s+/g, "")}")` : "none"))
    .replace(/(-webkit-)?image-set\s*\(|url\s*\(/gi, "none(")
    .replace(/expression\s*\(|behavior\s*:|-moz-binding|javascript:/gi, "x-")
    .replace(/\uE020/g, "url");
}

/** A link kept: http, https or mailto, nothing else (no javascript:, data:, file:). */
export function mailHref(raw: string): string | null {
  const h = raw.trim();
  if (/^mailto:[^\s<>"]{1,500}$/i.test(h)) return h;
  let u: URL;
  try { u = new URL(h); } catch { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return null;
  return u.toString();
}

/** A web picture's address that may be fetched: http or https, no login in it. */
function remoteSrc(raw: string): string | null {
  const h = raw.trim().startsWith("//") ? `https:${raw.trim()}` : raw.trim();
  let u: URL;
  try { u = new URL(h); } catch { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return null;
  return u.toString();
}

export interface CleanMail {
  /** The mail's own CSS rules (cleaned) and its body, ready for mailDocument. */
  html: string;
  /** Web pictures to fetch, in the order `<img data-r="N">` numbers them. */
  remote: string[];
}

/**
 * Clean one mail's HTML. `cids`: pictures sent inside the mail, by Content-ID (without angle brackets), as data:
 * addresses. Web pictures come out as `<img data-r="N" …>` (no src), N their place in `remote`.
 */
export function cleanMailHtml(raw: string, cids: Map<string, string> = new Map()): CleanMail {
  const doc = parseHtml(raw);
  const remote: string[] = [];
  const styles: string[] = [];
  const out: string[] = [];
  let bodyAttrs = "";

  const attrsOf = (e: HElement): string => {
    let s = "";
    const tag = e.name;
    for (const [k, v] of e.attrs) {
      const name = k.toLowerCase();
      if (name === "href") {
        if (tag !== "a") continue;
        const h = mailHref(v);
        if (h) s += ` href="${escapeAttr(h)}"`;
      } else if (name === "src" || name === "alt") {
        continue; // pictures are handled below
      } else if (name === "style") {
        const css = cleanCss(v).trim();
        if (css) s += ` style="${escapeAttr(css)}"`;
      } else if (ATTRS.has(name) && /^[a-z-]{1,20}$/.test(name)) {
        s += ` ${name}="${escapeAttr(v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500))}"`;
      }
    }
    return s;
  };

  const img = (e: HElement): string => {
    const src = (e.attrs.get("src") ?? "").trim();
    const alt = e.attrs.get("alt");
    const rest = attrsOf(e) + (alt ? ` alt="${escapeAttr(alt.slice(0, 500))}"` : "");
    if (/^cid:/i.test(src)) {
      const data = cids.get(src.slice(4).replace(/^<|>$/g, "").trim());
      return data ? `<img src="${escapeAttr(data)}"${rest}>` : `<img${rest}>`;
    }
    if (/^data:/i.test(src)) return PICTURE.test(src) && src.length <= DATA_MAX ? `<img src="${escapeAttr(src.replace(/\s+/g, ""))}"${rest}>` : `<img${rest}>`;
    const url = remoteSrc(src);
    if (!url) return `<img${rest}>`;
    let n = remote.indexOf(url);
    if (n < 0 && remote.length < IMAGES_MAX) { remote.push(url); n = remote.length - 1; }
    // data-r first, so withImages finds it by the tag's start, which no text can have (text has its `<` escaped).
    return n < 0 ? `<img${rest}>` : `<img data-r="${n}"${rest}>`;
  };

  const walk = (n: HNode) => {
    if (n.type === "text") { out.push(escapeText(n.text)); return; }
    const name = n.name;
    if (name === "style") {
      styles.push(n.children.map((c) => (c.type === "text" ? c.text : "")).join(""));
      return;
    }
    if (DROP.has(name)) return;
    if (name === "body") bodyAttrs = attrsOf(n);
    if (name === "img") { out.push(img(n)); return; }
    if (!KEEP.has(name)) { n.children.forEach(walk); return; }
    out.push(`<${name}${attrsOf(n)}>`);
    if (VOID_OUT.has(name)) return;
    n.children.forEach(walk);
    out.push(`</${name}>`);
  };
  doc.children.forEach(walk);

  const css = styles.map(cleanCss).join("\n").trim();
  const html = `${css ? `<style>${css}</style>` : ""}<div class="aeneas-mail"${bodyAttrs}>${out.join("")}</div>`;
  return { html, remote };
}

/** `html` with its fetched web pictures written in: `pictures[N]` a data: address for `<img data-r="N">`, or null. */
export function withImages(html: string, pictures: (string | null)[]): string {
  return html.replace(/<img data-r="(\d+)"/g, (m, n: string) => {
    const p = pictures[Number(n)];
    return p && PICTURE.test(p) ? `<img src="${escapeAttr(p)}"` : "<img";
  });
}

/** A picture's type by its first bytes, or null when it is not a picture a page may show (SVG never: it can hold script). */
export function pictureType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** A picture's bytes as a data: address, or null when they are not a picture. */
export function pictureData(b: Buffer): string | null {
  const type = pictureType(b);
  return type ? `data:${type};base64,${b.toString("base64")}` : null;
}

/**
 * The page the screen shows: the cleaned mail inside a document whose Content-Security-Policy loads nothing but the
 * data: pictures written into it (no script, no font, no request anywhere), links opening outside it, on white the way
 * senders design mail.
 */
export const MAIL_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'";
export function mailDocument(clean: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>html,body{margin:0;padding:0;background:#fff;color:#1f1f1f}body{padding:12px 16px;font:15px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere;overflow-x:auto}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${clean}</body></html>`;
}
