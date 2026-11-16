import { decodeEntities } from "./html.js";
import { articleText, type ArticleText } from "./sanitize.js";
import { fold } from "./search.js";

/**
 * The offline reference as the assistant reads it (`reference_search`, `reference_read` in ai/tools.ts): snippets as
 * plain text, and a page as its start plus the section that best answers the question, at most 6000 characters.
 */

/** A search snippet (HTML with only `<b>`) as plain text. */
export function plainSnippet(html: string): string {
  return decodeEntities(html.replace(/<\/?b>/g, "")).replace(/\s+/g, " ").trim();
}

const STOP = new Set("the and for with what when where which who whom whose how why does did do is are was were can could should would will about from into onto that this these those have has had not but you your yours my mine our ours its it's a an of to in on at by or be as if then than there their them they we he she his her him tell explain show give find look read page article reference please want need know any some all more most also just like ask".split(" "));

/** The question itself: an "Ask about this page" message's opening and a "reference <book>/<path>" are not part of it. */
export function questionOf(message: string): string {
  return message.replace(/^\s*Ask about ".*?" \([^)]*\):\s*/s, "").replace(/\breference\s+\S+\/\S+/g, " ");
}

/** The words of a question worth matching: three letters or more, common words left out. */
export function questionWords(q: string): string[] {
  return [...new Set(fold(questionOf(q)).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 30);
}

const tokens = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** How often a word is in a text, as a whole word or with a short ending ("headset" in "headsets"). */
function hits(toks: string[], w: string): number {
  let n = 0;
  for (const t of toks) if (t === w || (t.startsWith(w) && t.length - w.length <= 2)) n++;
  return n;
}

/** How well a text answers: words in its heading count most, then in its sub-headings ("### "), then a few times in it. */
function score(heading: string, text: string, words: string[]): number {
  const head = tokens(heading);
  const subs = tokens(text.split("\n").filter((l) => l.startsWith("### ")).join(" "));
  const body = tokens(text);
  return words.reduce((sum, w) => sum + (hits(head, w) ? 5 : 0) + (hits(subs, w) ? 3 : 0) + Math.min(hits(body, w), 3), 0);
}

/** The words of the question that tell sections apart: those of the page's own title are left out. */
function asked(question: string, pageTitle: string): string[] {
  const subject = new Set(questionWords(pageTitle));
  return questionWords(question).filter((w) => !subject.has(w));
}

/**
 * The section named (by its title or id), else the one whose title and text best match the question. Words of the
 * page's own title are left out: every section is about them ("headset" on the Bluetooth headset page).
 */
export function bestSection(art: ArticleText, question: string, named?: string, pageTitle = ""): ArticleText["sections"][number] | null {
  if (named?.trim()) {
    const n = fold(named);
    const hit = art.sections.find((s) => fold(s.title) === n) ?? art.sections.find((s) => fold(s.title).includes(n) || fold(s.id).includes(n.replace(/ /g, "_")));
    if (hit) return hit;
  }
  const words = asked(question, pageTitle);
  let best: ArticleText["sections"][number] | null = null;
  let top = 0;
  for (const s of art.sections) {
    const v = score(s.title, s.text, words);
    if (v > top) { top = v; best = s; }
  }
  return best;
}

/** A section within `space`: whole when it fits, else the parts under its sub-headings that answer best, in their order. */
function focus(sec: ArticleText["sections"][number], words: string[], space: number): string {
  const head = `## ${sec.title}\n`;
  if (head.length + sec.text.length <= space) return head + sec.text;
  const parts = sec.text.split(/\n+(?=### )/).map((p, i) => ({ p, i, v: score("", p, words) }));
  const keep = new Set<number>();
  let used = head.length;
  for (const c of [...parts].sort((a, b) => b.v - a.v || a.i - b.i)) {
    if (used + c.p.length + 2 > space) continue;
    keep.add(c.i);
    used += c.p.length + 2;
  }
  if (!keep.size) return cut(head + [...parts].sort((a, b) => b.v - a.v || a.i - b.i)[0].p, space);
  return head + parts.filter((x) => keep.has(x.i)).map((x) => x.p).join("\n\n");
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.max(0, max - 1));
  const end = head.lastIndexOf(" ");
  return `${end > max * 0.8 ? head.slice(0, end) : head}…`;
}

/** A sanitized page as plain text for the assistant: its start and the best section (or every section as far as they fit). */
export function pageForAssistant(html: string, question: string, section?: string, max = 6000, pageTitle = ""): string {
  const art = articleText(html);
  const sec = bestSection(art, question, section, pageTitle);
  const others = art.sections.filter((s) => s !== sec && s.title).map((s) => s.title);
  const index = others.length ? `\n\n(Sections: ${cut([...new Set(others)].join("; "), 600)})` : "";
  const room = max - index.length;
  if (!sec) {
    let body = art.lead;
    for (const s of art.sections) {
      const add = `\n\n## ${s.title}\n${s.text}`;
      if (body.length + add.length > room) { body += add; break; }
      body += add;
    }
    return cut(body, room) + index;
  }
  // The start, shortened when the section needs the room; then the section, focused on what was asked.
  const lead = art.lead ? cut(art.lead, Math.max(1200, room - (sec.text.length + sec.title.length + 6))) : "";
  const secPart = focus(sec, asked(question, pageTitle), Math.max(0, room - lead.length - 2));
  return cut([lead, secPart].filter(Boolean).join("\n\n"), room) + index;
}
