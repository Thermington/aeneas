import { findMatches, foldText, linkKind, mapClasses } from "../../lib/reference";

/**
 * The reader's own pass over an article the hub already sanitized (CONTRACT "Offline reference", Reading): the page is
 * parsed into an inert document, where nothing loads or runs, every element and attribute not on the lists below is
 * taken out, and the nodes are moved into the reader as they are, never written back out as markup and parsed again.
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";
const MATH_NS = "http://www.w3.org/1998/Math/MathML";

/** Elements removed with everything inside them. */
const DROP = [
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "select", "textarea",
  "option", "optgroup", "datalist", "link", "meta", "base", "noscript", "template", "svg", "canvas", "video", "audio", "source",
  "track", "map", "area", "title", "head", "dialog", "portal", "slot", "marquee", "noembed", "noframes", "xmp", "plaintext", "param",
];

/** Elements kept as they are (their attributes cleaned); any other element gives way to its contents. */
const KEEP = new Set([
  "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn",
  "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark",
  "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "small", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
]);

/** Elements kept under another name: landmarks inside an article would confuse the app's own. */
const RENAME: Record<string, string> = {
  center: "div", font: "span", big: "span", tt: "code", main: "div", nav: "div", aside: "div", header: "div", footer: "div", article: "div",
};

/** Formulas (MathML) with their layout attributes only. */
const MATH_TAGS = new Set([
  "math", "mi", "mo", "mn", "ms", "mtext", "mrow", "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mtable", "mtr", "mtd",
  "mover", "munder", "munderover", "mspace", "mstyle", "mpadded", "mphantom", "semantics", "annotation", "menclose", "mmultiscripts",
  "mprescripts", "none",
]);
const MATH_ATTRS = new Set(["display", "mathvariant", "stretchy", "fence", "separator", "accent", "accentunder", "lspace", "rspace", "columnalign", "rowalign", "displaystyle", "scriptlevel", "linethickness", "notation", "encoding"]);

/** An article's ids carry this, so none can clash with the app's own (`main`, `root`). */
export const ID_PREFIX = "rx-";

const digits = (v: string, max: number) => /^\d{1,5}$/.test(v) && Number(v) > 0 && Number(v) <= max;

function cleanAttributes(el: Element, tag: string): void {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    const v = attr.value;
    let keep = false;
    switch (name) {
      case "id": el.setAttribute("id", ID_PREFIX + v); continue;
      case "class": {
        const c = mapClasses(v);
        if (c) el.setAttribute("class", c);
        else el.removeAttribute(attr.name);
        continue;
      }
      case "style":
        // Wikipedia hides its MathML copy of a formula this way; hidden it stays.
        if (/display\s*:\s*none/i.test(v)) el.setAttribute("hidden", "");
        break;
      case "title": case "data-book": case "data-path": case "data-media": case "data-external": case "hidden": keep = true; break;
      case "alt": keep = tag === "img"; break;
      case "href": keep = tag === "a"; break;
      case "lang": keep = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(v); break;
      case "dir": keep = v === "ltr" || v === "rtl" || v === "auto"; break;
      case "width": case "height": keep = tag === "img" && digits(v, 5000); break;
      case "colspan": case "rowspan": keep = (tag === "td" || tag === "th") && digits(v, 100); break;
      case "scope": keep = tag === "th" && /^(row|col|rowgroup|colgroup)$/.test(v); break;
      case "headers": case "abbr": keep = tag === "td" || tag === "th"; break;
      case "start": keep = tag === "ol" && /^-?\d{1,6}$/.test(v); break;
      case "reversed": keep = tag === "ol"; break;
      case "type": keep = (tag === "ol" || tag === "li") && /^[1aAiI]$/.test(v); break;
      case "value": keep = tag === "li" && /^\d{1,6}$/.test(v); break;
      case "datetime": keep = tag === "time" || tag === "del" || tag === "ins"; break;
      case "open": keep = tag === "details"; break;
      default: keep = false;
    }
    if (!keep) el.removeAttribute(attr.name);
  }
}

function rename(el: Element, to: string): Element {
  const next = el.ownerDocument.createElement(to);
  for (const attr of [...el.attributes]) {
    // The HTML parser takes attribute names setAttribute refuses; those would be dropped anyway.
    try { next.setAttribute(attr.name, attr.value); } catch { /* not a name setAttribute takes */ }
  }
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
  return next;
}

function unwrap(el: Element): void {
  el.replaceWith(...el.childNodes);
}

/** A link's own rules after its attributes are cleaned: a page in a book, a section, the internet, or plain text. */
function cleanLink(a: Element): void {
  const kind = linkKind(a.getAttribute("href"), { book: a.getAttribute("data-book"), path: a.getAttribute("data-path"), external: a.hasAttribute("data-external") });
  if (kind === "none") {
    a.removeAttribute("href");
    a.removeAttribute("data-external");
    return;
  }
  if (kind === "external") {
    a.setAttribute("rel", "noopener noreferrer");
    a.setAttribute("title", "Opens in your browser. Needs the internet.");
    const note = a.ownerDocument.createElement("span");
    note.className = "sr-only";
    note.textContent = " (needs the internet)";
    a.appendChild(note);
  } else a.removeAttribute("data-external");
}

/**
 * The article as nodes for the reader: only text, structure, tables, figures, lists, code, formulas and links; ids
 * prefixed; pictures without an address until they come into view; every folded section open; a first heading that
 * repeats the title left out; wide tables in a box that scrolls sideways.
 */
export function sanitizeArticle(html: string, title: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
  const body = doc.body;
  body.querySelectorAll(DROP.join(",")).forEach((el) => el.remove());
  const comments = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const gone: Node[] = [];
  while (comments.nextNode()) gone.push(comments.currentNode);
  gone.forEach((c) => c.parentNode?.removeChild(c));

  // Deepest first, so an element given way to its contents hands over children that are already clean.
  const all = [...body.querySelectorAll("*")].reverse();
  for (const original of all) {
    if (!original.isConnected) continue;
    if (original.namespaceURI === MATH_NS) {
      if (!MATH_TAGS.has(original.localName)) { original.remove(); continue; }
      for (const attr of [...original.attributes]) if (!MATH_ATTRS.has(attr.name.toLowerCase())) original.removeAttribute(attr.name);
      continue;
    }
    if (original.namespaceURI !== HTML_NS) { original.remove(); continue; }
    let el = original;
    let tag = el.localName;
    if (RENAME[tag]) { tag = RENAME[tag]; el = rename(el, tag); }
    if (!KEEP.has(tag)) { unwrap(el); continue; }
    cleanAttributes(el, tag);
    if (tag === "a") cleanLink(el);
    else if (tag === "details") el.setAttribute("open", "");
    else if (tag === "img" && !el.getAttribute("data-media")) el.remove();
  }

  // One h1 on the screen: the reader's own title.
  const first = body.querySelector("h1");
  if (first && foldText(first.textContent ?? "").trim() === foldText(title).trim()) first.remove();
  body.querySelectorAll("h1").forEach((h) => rename(h, "h2"));

  for (const table of [...body.querySelectorAll("table")]) {
    if (table.parentElement?.closest("table")) continue;
    const box = doc.createElement("div");
    box.className = table.classList.contains("rx-infobox") ? "rx-scroll rx-infobox-box" : "rx-scroll";
    table.replaceWith(box);
    box.appendChild(table);
  }

  const out = document.createDocumentFragment();
  for (const n of [...body.childNodes]) out.appendChild(document.adoptNode(n));
  return out;
}

/** The element of an article's id (as the hub wrote it), inside the reader. */
export function articleElement(root: ParentNode | null | undefined, id: string): HTMLElement | null {
  if (!root || !id) return null;
  return root.querySelector<HTMLElement>(`[id="${CSS.escape(ID_PREFIX + id)}"]`);
}

// ---------- Find in page ----------

/** Takes the find marks out of the page, leaving its text as it was. */
export function clearFinds(root: HTMLElement): void {
  const marks = root.querySelectorAll("mark.ref-find");
  if (!marks.length) return;
  marks.forEach((m) => m.replaceWith(...m.childNodes));
  root.normalize();
}

/** Marks every match of the query in the page's visible text with <mark>; each match's marks, in page order. */
export function markFinds(root: HTMLElement, query: string, limit = 500): HTMLElement[][] {
  clearFinds(root);
  if (!query.trim()) return [];
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("[hidden], .rx-sr, .rx-hidden, .sr-only") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const matches = findMatches(nodes.map((n) => n.data), query, limit);
  const marks: HTMLElement[][] = matches.map(() => []);
  const byNode = new Map<number, Array<{ m: number; start: number; end: number }>>();
  matches.forEach((pieces, m) => {
    for (const p of pieces) {
      const list = byNode.get(p.node) ?? [];
      list.push({ m, start: p.start, end: p.end });
      byNode.set(p.node, list);
    }
  });
  for (const [i, pieces] of byNode) {
    const node = nodes[i];
    // Last first: splitting off the end of a node leaves the offsets before it as they were.
    pieces.sort((a, b) => b.start - a.start);
    for (const p of pieces) {
      node.splitText(p.end);
      const part = node.splitText(p.start);
      const mark = document.createElement("mark");
      mark.className = "ref-find";
      part.replaceWith(mark);
      mark.appendChild(part);
      marks[p.m].push(mark);
    }
  }
  return marks;
}

// ---------- Pictures ----------

/**
 * Loads an article's pictures (`img[data-media]`) as they come near the screen, four at a time, each through the hub
 * client as a blob: address, and lets each go again (revoked, its address removed, its size kept) once it is far
 * off screen. Returns the stop, which lets every one go.
 */
export function watchImages(root: HTMLElement, load: (path: string, signal: AbortSignal) => Promise<string>): () => void {
  if (typeof IntersectionObserver === "undefined") return () => undefined;
  type State = { url?: string; ctl?: AbortController; queued?: boolean };
  const state = new Map<HTMLImageElement, State>();
  const queue: HTMLImageElement[] = [];
  let running = 0;
  let stopped = false;

  const pump = () => {
    while (!stopped && running < 4 && queue.length) {
      const img = queue.shift()!;
      const s = state.get(img)!;
      s.queued = false;
      const path = img.getAttribute("data-media");
      if (!path) continue;
      const ctl = new AbortController();
      s.ctl = ctl;
      running++;
      load(path, ctl.signal).then(
        (url) => {
          if (ctl.signal.aborted || stopped) { URL.revokeObjectURL(url); return; }
          s.url = url;
          img.classList.remove("rx-failed");
          img.onload = () => {
            if (!img.getAttribute("width") && img.naturalWidth) {
              img.setAttribute("width", String(img.naturalWidth));
              img.setAttribute("height", String(img.naturalHeight));
            }
          };
          img.src = url;
        },
        () => { if (!ctl.signal.aborted) img.classList.add("rx-failed"); },
      ).finally(() => {
        if (s.ctl === ctl) s.ctl = undefined;
        running--;
        pump();
      });
    }
  };
  const near = (img: HTMLImageElement) => {
    const s = state.get(img) ?? {};
    state.set(img, s);
    if (s.url || s.ctl || s.queued) return;
    s.queued = true;
    queue.push(img);
    pump();
  };
  const far = (img: HTMLImageElement) => {
    const s = state.get(img);
    if (!s) return;
    if (s.queued) {
      s.queued = false;
      const i = queue.indexOf(img);
      if (i >= 0) queue.splice(i, 1);
    }
    s.ctl?.abort();
    s.ctl = undefined;
    if (s.url) {
      URL.revokeObjectURL(s.url);
      s.url = undefined;
      img.removeAttribute("src");
    }
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const img = e.target as HTMLImageElement;
      if (e.isIntersecting) near(img);
      else far(img);
    }
  }, { rootMargin: "800px 0px" });
  root.querySelectorAll<HTMLImageElement>("img[data-media]").forEach((img) => io.observe(img));
  return () => {
    stopped = true;
    io.disconnect();
    for (const [img, s] of state) {
      s.ctl?.abort();
      if (s.url) URL.revokeObjectURL(s.url);
      img.onload = null;
    }
    state.clear();
    queue.length = 0;
  };
}

/** The words under a picture: its figure's caption, else its alt text. */
export function captionOf(img: HTMLImageElement): string {
  const cap = img.closest("figure")?.querySelector("figcaption") ?? img.closest(".rx-thumb")?.querySelector(".rx-caption");
  return (cap?.textContent ?? "").replace(/\s+/g, " ").trim() || img.alt || "";
}
