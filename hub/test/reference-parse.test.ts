import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { curated, fetchCatalog, kiwixDownloadUrl, parseCatalog } from "../src/reference/catalog.js";
import { fetchMetalink, parseMetalink } from "../src/reference/metalink.js";
import { findSource, sourceOfBook, SOURCES, GROUPS } from "../src/reference/sources.js";
import { findLanguage, isLanguageName, language } from "../src/reference/languages.js";
import { kiwixPlatform, KIWIX_PINS } from "../src/reference/kiwix.js";
import { REF_FIXTURES } from "./reference-helpers.js";

const catalogXml = fs.readFileSync(path.join(REF_FIXTURES, "catalog.xml"), "utf8");

test("reference catalog: entries are read with their flavour, languages, tags, size and metalink", () => {
  const all = parseCatalog(catalogXml);
  const arch = all.find((b) => b.name === "archlinux_en_all")!;
  assert.deepEqual({ ...arch, tags: undefined }, {
    name: "archlinux_en_all", flavour: "maxi", file: "archlinux_en_all_maxi_2026-10.zim", langs: ["eng"], title: "ArchWiki & friends",
    summary: "ArchWiki & friends for tests", tags: undefined, articles: 16485, updated: "2026-10-21T00:00:00Z", date: "2026-10-21",
    meta4: "https://lb.download.kiwix.org/zim/test/archlinux_en_all_maxi_2026-10.zim.meta4", bytes: 38311936, images: true, fulltext: true,
  });
  assert.ok(arch.tags.includes("_ftindex:yes"));
  const so = all.find((b) => b.name === "es.stackoverflow.com_mul_all")!;
  assert.deepEqual(so.langs, ["eng", "spa"], "an archive with two languages keeps both");
  assert.equal(all.find((b) => b.name === "wikipedia_en_all" && b.flavour === "nopic")!.images, false);
  assert.equal(all.find((b) => b.name === "mdwiki_en_all" && b.flavour === "")!.images, true, "the unnamed kind with pictures");
  assert.equal(all.find((b) => b.name === "devdocs_en_bash")!.fulltext, false);
  // Only https metalinks on Kiwix's own download server are followed.
  assert.ok(!all.some((b) => b.name === "wikivoyage_en_all"), "a plain http metalink is left out");
  assert.ok(!all.some((b) => b.name === "wikivoyage_fr_all"), "a metalink on another host is left out");
  assert.equal(kiwixDownloadUrl("https://download.kiwix.org/zim/x.zim.meta4"), true);
  assert.equal(kiwixDownloadUrl("https://lb.download.kiwix.org/zim/x.zim.meta4"), true);
  assert.equal(kiwixDownloadUrl("https://download.kiwix.org.evil.example/x.meta4"), false);
  assert.equal(kiwixDownloadUrl("https://user:pw@download.kiwix.org/x.meta4"), false);
  // The curated part: no TED, no gutenberg_mul_all (every language in one 250 GB archive), no DevDocs set not chosen.
  const names = new Set(curated(all).map((b) => b.name));
  for (const n of ["ted_en_all", "gutenberg_mul_all", "devdocs_en_influxdata"]) assert.ok(!names.has(n), n);
  for (const n of ["wikipedia_en_all", "gutenberg_en_all", "devdocs_en_bash", "libretexts.org_en_bio", "es.stackoverflow.com_mul_all"]) assert.ok(names.has(n), n);
  assert.throws(() => parseCatalog("<feed><entry></feed>"), /not well-formed/);
});

test("reference catalog: read whole from library.kiwix.org with no filter, redirects only within Kiwix", async () => {
  const asked: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    asked.push(String(url));
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal, "every request has a time limit");
    if (String(url).startsWith("https://library.kiwix.org/")) return new Response("", { status: 301, headers: { location: "https://opds.library.kiwix.org/catalog/v2/entries?count=-1" } });
    return new Response(catalogXml, { headers: { "content-type": "application/atom+xml" } });
  }) as typeof fetch;
  const books = await fetchCatalog(fake);
  assert.deepEqual(asked, ["https://library.kiwix.org/catalog/v2/entries?count=-1", "https://opds.library.kiwix.org/catalog/v2/entries?count=-1"]);
  assert.ok(books.length > 10 && books.every((b) => sourceOfBook(b.name)));
  const away = (async (url: string) => (String(url).includes("kiwix.org") ? new Response("", { status: 302, headers: { location: "https://evil.example/catalog" } }) : new Response(catalogXml))) as typeof fetch;
  await assert.rejects(fetchCatalog(away), /outside Kiwix/);
  const down = (async () => new Response("busy", { status: 503 })) as typeof fetch;
  await assert.rejects(fetchCatalog(down), /503/);
});

test("reference metalink: size, SHA-256, piece hashes and https mirrors by priority, Kiwix's own server last", async () => {
  const xml = fs.readFileSync(path.join(REF_FIXTURES, "archive.meta4"), "utf8");
  const meta4 = "https://lb.download.kiwix.org/zim/test/devdocs_en_bash_2026-10.zim.meta4";
  const m = parseMetalink(xml, meta4);
  assert.equal(m.file, "devdocs_en_bash_2026-10.zim");
  assert.equal(m.size, 10000);
  assert.equal(m.sha256, "e0cabb299ce29d7a60e0a65cab4d3e14d8e60b5995daeb60b2932bbac04e505b");
  assert.equal(m.pieceLength, 4096);
  assert.equal(m.pieces.length, 3);
  assert.deepEqual(m.urls, [
    "https://mirror-one.example.org/kiwix/zim/test/devdocs_en_bash_2026-10.zim",
    "https://mirror-two.example.org/kiwix/zim/test/devdocs_en_bash_2026-10.zim",
    "https://download.kiwix.org/zim/test/devdocs_en_bash_2026-10.zim",
  ], "http and ftp mirrors are dropped");
  // Pieces that do not cover the file are not used; the whole file's hash still is.
  const short = parseMetalink(xml.replace("<size>10000</size>", "<size>20000</size>"), meta4);
  assert.deepEqual([short.pieceLength, short.pieces], [0, []]);
  assert.throws(() => parseMetalink(xml.replace(/<hash type="sha-256">[^<]+<\/hash>/, ""), meta4), /no SHA-256/);
  assert.throws(() => parseMetalink(xml.replace('name="devdocs_en_bash_2026-10.zim"', 'name="../../etc/passwd"'), meta4), /plain archive name/);
  const fetched = await fetchMetalink((async () => new Response(xml)) as typeof fetch, meta4);
  assert.equal(fetched.urls.length, 3);
  await assert.rejects(fetchMetalink((async () => new Response(xml)) as typeof fetch, "https://mirror.example.org/x.meta4"), /outside Kiwix/);
});

test("reference sources: every pattern matches its own books only, and names are found by id or title", () => {
  assert.equal(SOURCES.length, new Set(SOURCES.map((s) => s.id)).size, "ids are unique");
  for (const s of SOURCES) assert.ok((GROUPS as readonly string[]).includes(s.group), s.id);
  const of = (n: string) => { const r = sourceOfBook(n); return r ? [r.source.id, r.segment] : null; };
  assert.deepEqual(of("wikipedia_en_all"), ["wikipedia", "en"]);
  assert.deepEqual(of("wikipedia_be-tarask_all"), ["wikipedia", "be-tarask"]);
  assert.equal(of("wikipedia_mul_all"), null);
  assert.equal(of("gutenberg_mul_all"), null);
  assert.deepEqual(of("gutenberg_en_lcc-s"), ["gutenberg_agriculture", null]);
  assert.deepEqual(of("libretexts.org_en_med"), ["libretexts", null]);
  assert.deepEqual(of("devdocs_en_python"), ["devdocs", null]);
  assert.equal(of("devdocs_en_angular"), null);
  assert.deepEqual(of("es.stackoverflow.com_mul_all"), ["stackoverflow_es", null]);
  assert.equal(of("serverfaultXcom_en_all"), null, "a dot in a name is a dot");
  assert.equal(findSource("Wikipedia")?.id, "wikipedia");
  assert.equal(findSource("stack overflow")?.id, "stackoverflow");
  assert.equal(findSource("arch")?.id, "archwiki");
  assert.equal(findSource("nothing like it"), null);
});

test("reference languages: ISO 639-3 codes to BCP 47 tags and names; unknown codes fall back to the code", () => {
  assert.deepEqual(language("eng"), { code: "eng", tag: "en", name: "English", native: "English" });
  assert.deepEqual(language("spa"), { code: "spa", tag: "es", name: "Spanish", native: "Español" });
  assert.equal(language("hbs").tag, "sh");
  assert.equal(language("tgl").tag, "tl");
  assert.equal(language("ace").tag, "ace");
  assert.deepEqual(language("qqq"), { code: "qqq", tag: "qqq", name: "qqq", native: "qqq" });
  assert.equal(findLanguage("English"), "eng");
  assert.equal(findLanguage("en"), "eng");
  assert.equal(findLanguage("español"), "spa");
  assert.equal(findLanguage("Klingon"), null);
  assert.ok(isLanguageName("Русский") && isLanguageName("magyar") && isLanguageName("简体中文"));
  assert.ok(!isLanguageName("Latin") && !isLanguageName("programming language"), "names in English do not count");
});

test("reference reader: a pinned build for each system Kiwix makes one for", () => {
  assert.equal(kiwixPlatform("linux", "x64"), "linux-x86_64");
  assert.equal(kiwixPlatform("linux", "arm64"), "linux-aarch64");
  assert.equal(kiwixPlatform("darwin", "arm64"), "macos-arm64");
  assert.equal(kiwixPlatform("darwin", "x64"), "macos-x86_64");
  assert.equal(kiwixPlatform("win32", "x64"), "win-x86_64");
  assert.equal(kiwixPlatform("freebsd", "x64"), null);
  for (const pin of Object.values(KIWIX_PINS)) {
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    assert.match(pin.file, /^kiwix-tools_[a-z0-9_-]+-3\.8\.1\.(tar\.gz|zip)$/);
    assert.ok(pin.bytes > 10_000_000);
  }
});
