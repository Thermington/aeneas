import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  addRecent,
  appendHits,
  archiveDate,
  askAboutText,
  bestHit,
  citationText,
  downloadStateText,
  etaText,
  filterHits,
  findCountText,
  findMatches,
  flavourText,
  foldText,
  keepPosition,
  languageName,
  languageTag,
  linkKind,
  mapClasses,
  matchLanguages,
  mayAppend,
  mayShow,
  parsePositions,
  parseRecent,
  percentDone,
  planText,
  progressText,
  readSettings,
  readerPath,
  readerRoute,
  searchChips,
  searchPlaceholder,
  settingsSummary,
  shortList,
  sizeText,
  snippetParts,
  speedText,
  stepTextSize,
  wantedBook,
  wantedBytes,
  type RecentPage,
  type RefBook,
  type RefCatalogBook,
  type RefHit,
  type RefSettings,
  type RefSource,
  type Shown,
} from "./reference";

const GB = 1024 ** 3;

describe("reader addresses", () => {
  it("reads the book and the page from a path whose slashes are encoded, or not", () => {
    expect(readerRoute("/reference/wikipedia_en_all_maxi_2024-01/A%2FFever")).toEqual({ book: "wikipedia_en_all_maxi_2024-01", path: "A/Fever", anchor: null });
    expect(readerRoute("/reference/wikipedia_en_all_maxi_2024-01/A/Fever")).toEqual({ book: "wikipedia_en_all_maxi_2024-01", path: "A/Fever", anchor: null });
    expect(readerRoute("#/reference/se/questions/12/how%20to%3F")).toEqual({ book: "se", path: "questions/12/how to?", anchor: null });
  });
  it("takes the section from ?at= or from a # in the page path", () => {
    expect(readerRoute("/reference/w/Fever", new URLSearchParams("at=Causes"))).toEqual({ book: "w", path: "Fever", anchor: "Causes" });
    expect(readerRoute("/reference/w/Fever%23Causes")).toEqual({ book: "w", path: "Fever", anchor: "Causes" });
  });
  it("is the search screen without a book and a page", () => {
    expect(readerRoute("/reference")).toBeNull();
    expect(readerRoute("/reference/")).toBeNull();
    expect(readerRoute("/reference/book")).toBeNull();
    expect(readerRoute("/reference/book/")).toBeNull();
    expect(readerRoute("/references/a/b")).toBeNull();
    expect(readerRoute("/notes/a/b")).toBeNull();
  });
  it("keeps a page path with a broken escape as it came", () => {
    expect(readerRoute("/reference/w/100%_juice")).toEqual({ book: "w", path: "100%_juice", anchor: null });
  });
  it("makes addresses that read back to the same page", () => {
    for (const [book, path, anchor] of [["w", "A/Fever", null], ["se", "questions/1/a?b#c", null], ["w", "École", "Histoire"]] as const) {
      const href = readerPath(book, path, anchor);
      const [p, q] = href.split("?");
      expect(readerRoute(p, new URLSearchParams(q ?? ""))).toEqual({ book, path: anchor ? path : path.split("#")[0], anchor: anchor ?? (path.includes("#") ? path.split("#")[1] : null) });
    }
    expect(readerPath("w", "A/Fever")).toBe("/reference/w/A%2FFever");
    expect(readerPath("w", "Fever", "Causes")).toBe("/reference/w/Fever?at=Causes");
  });
});

describe("links inside an article", () => {
  it("open in the reader, jump in the page, leave for the internet, or do nothing", () => {
    expect(linkKind("#/reference/w/Cold", { book: "w", path: "Cold" })).toBe("reader");
    expect(linkKind("#/reference/w/Cold", {})).toBe("reader");
    expect(linkKind("#cite_note-1", {})).toBe("anchor");
    expect(linkKind("https://en.wikipedia.org/wiki/Fever", { external: true })).toBe("external");
    expect(linkKind("javascript:alert(1)", { external: true })).toBe("none");
    expect(linkKind("data:text/html,x", {})).toBe("none");
    expect(linkKind("https://example.com", {})).toBe("none");
    expect(linkKind("#", {})).toBe("none");
    expect(linkKind("#/today", {})).toBe("none");
    expect(linkKind(null, {})).toBe("none");
  });
  it("keep only the classes the reader styles, under names of their own", () => {
    expect(mapClasses("infobox vcard biography")).toBe("rx-infobox");
    expect(mapClasses("thumb tright")).toBe("rx-thumb rx-right");
    expect(mapClasses("tabs toast item")).toBe("");
    expect(mapClasses(null)).toBe("");
  });
});

describe("citation and Ask about this page", () => {
  const article = { title: "Fever", book: "wikipedia_en_all_maxi_2024-01", path: "A/Fever", date: "2024-01-15", url: "https://en.wikipedia.org/wiki/Fever" };
  it("cites the title, source and archive date, then the original address", () => {
    expect(citationText(article, "Wikipedia")).toBe("Fever. Wikipedia, offline copy of January 15, 2024. https://en.wikipedia.org/wiki/Fever");
    expect(citationText({ ...article, url: null }, "Wikipedia")).toBe("Fever. Wikipedia, offline copy of January 15, 2024.");
    expect(citationText({ ...article, title: "Acme Inc.", url: undefined }, "Wikipedia")).toBe("Acme Inc. Wikipedia, offline copy of January 15, 2024.");
  });
  it("writes the first message exactly as the hub's guide reads it", () => {
    expect(askAboutText(article, "Wikipedia")).toBe('Ask about "Fever" (Wikipedia, reference wikipedia_en_all_maxi_2024-01/A/Fever): ');
  });
  it("says archive dates in words", () => {
    expect(archiveDate("2024-01-15")).toBe("Jan 2024");
    expect(archiveDate("2024-01-15", "long")).toBe("January 15, 2024");
    expect(archiveDate("2023-11", "long")).toBe("November 2023");
    expect(archiveDate("2024-01-15T00:00:00Z", "long")).toBe("January 15, 2024");
    expect(archiveDate("someday")).toBe("someday");
    expect(archiveDate("")).toBe("");
  });
});

describe("pages read on this device", () => {
  const page = (path: string, at = "2026-11-16T10:00:00Z"): RecentPage => ({ book: "w", path, title: path, source: "Wikipedia", lang: "eng", at });
  it("puts the page just read first, once", () => {
    const list = [page("A"), page("B"), page("C")];
    expect(addRecent(list, page("B", "later")).map((p) => p.path)).toEqual(["B", "A", "C"]);
    expect(addRecent(list, page("B", "later"))[0].at).toBe("later");
    expect(addRecent(list, page("D")).map((p) => p.path)).toEqual(["D", "A", "B", "C"]);
    expect(addRecent(list, { ...page("A"), book: "other" })).toHaveLength(4);
  });
  it("keeps the newest 30", () => {
    let list: RecentPage[] = [];
    for (let i = 0; i < 40; i++) list = addRecent(list, page(`P${i}`));
    expect(list).toHaveLength(30);
    expect(list[0].path).toBe("P39");
    expect(list[29].path).toBe("P10");
  });
  it("reads a kept list, leaving out what is broken or repeated", () => {
    const raw = JSON.stringify([page("A"), { book: "w" }, "x", page("A"), { ...page("B"), title: 5 }]);
    expect(parseRecent(raw).map((p) => [p.path, p.title])).toEqual([["A", "A"], ["B", "B"]]);
    expect(parseRecent("not json")).toEqual([]);
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseRecent(JSON.stringify(Array.from({ length: 50 }, (_, i) => page(`P${i}`))))).toHaveLength(30);
  });
  it("keeps where reading stopped per page, the oldest going first", () => {
    let m = keepPosition({}, "w/A", 0.4, 1);
    m = keepPosition(m, "w/B", 2, 2);
    expect(m["w/A"].f).toBe(0.4);
    expect(m["w/B"].f).toBe(1);
    m = keepPosition(m, "w/C", 0.5, 3, 2);
    expect(Object.keys(m).sort()).toEqual(["w/B", "w/C"]);
    expect(parsePositions(JSON.stringify(m))).toEqual(m);
    expect(parsePositions("{")).toEqual({});
  });
  it("steps the text size through the sizes it has", () => {
    expect(stepTextSize(17, 1)).toBe(18);
    expect(stepTextSize(17, -1)).toBe(16);
    expect(stepTextSize(19, 1)).toBe(20);
    expect(stepTextSize(19, -1)).toBe(18);
    expect(stepTextSize(28, 1)).toBe(28);
    expect(stepTextSize(14, -1)).toBe(14);
  });
});

describe("search snippets", () => {
  it("turn <b> into bold runs and everything else into plain text", () => {
    expect(snippetParts("A <b>fever</b> is a <b>body</b> temperature")).toEqual([
      { text: "A ", bold: false }, { text: "fever", bold: true }, { text: " is a ", bold: false }, { text: "body", bold: true }, { text: " temperature", bold: false },
    ]);
  });
  it("never carry markup through: other tags go, their text stays as text", () => {
    const parts = snippetParts('<img src=x onerror="alert(1)">Hi <i>there</i> <script>alert(2)</script><B>loud</B>');
    expect(parts).toEqual([{ text: "Hi there alert(2)", bold: false }, { text: "loud", bold: true }]);
    expect(parts.some((p) => p.text.includes("<"))).toBe(false);
  });
  it("read character references as the characters, keeping a written < as text", () => {
    expect(snippetParts("Fish &amp; chips &lt;b&gt; &#233;t&#xE9; &bogus;")).toEqual([{ text: "Fish & chips <b> été &bogus;", bold: false }]);
    expect(snippetParts("a < b")).toEqual([{ text: "a < b", bold: false }]);
    expect(snippetParts("")).toEqual([]);
    expect(snippetParts(undefined)).toEqual([]);
  });
  it("close bold at the end of an unclosed tag and ignore a stray close", () => {
    expect(snippetParts("</b>x<b>y")).toEqual([{ text: "x", bold: false }, { text: "y", bold: true }]);
  });
});

describe("result order", () => {
  it("drops an older query's answer that comes in after a newer one's", () => {
    let shown: Shown = { gen: 0, stage: null };
    let current = 1; // typed "fev"
    current = 2; // typed "fever" before anything came back
    expect(mayShow(current, shown, { gen: 2, stage: "suggest" })).toBe(true);
    shown = { gen: 2, stage: "suggest" };
    expect(mayShow(current, shown, { gen: 1, stage: "search" })).toBe(false);
    expect(mayShow(current, shown, { gen: 2, stage: "search" })).toBe(true);
    shown = { gen: 2, stage: "search" };
    expect(mayShow(current, shown, { gen: 2, stage: "suggest" })).toBe(false);
    expect(mayShow(current, shown, { gen: 2, stage: "search" })).toBe(true);
    current = 3; // a chip changed
    expect(mayShow(current, shown, { gen: 2, stage: "search" })).toBe(false);
    expect(mayShow(current, shown, { gen: 3, stage: "suggest" })).toBe(true);
  });
  it("adds a page of more results only to the list it continues", () => {
    const shown: Shown = { gen: 4, stage: "search" };
    expect(mayAppend(4, shown, 20, { gen: 4, offset: 20 })).toBe(true);
    expect(mayAppend(4, shown, 40, { gen: 4, offset: 20 })).toBe(false);
    expect(mayAppend(5, shown, 20, { gen: 4, offset: 20 })).toBe(false);
    expect(mayAppend(4, { gen: 4, stage: "suggest" }, 8, { gen: 4, offset: 8 })).toBe(false);
  });
  const hit = (title: string, book = "w", source = "wikipedia", lang = "eng"): RefHit => ({ book, source, lang, title, path: title });
  it("joins pages without repeating a result", () => {
    expect(appendHits([hit("A"), hit("B")], [hit("B"), hit("C"), hit("C")]).map((h) => h.title)).toEqual(["A", "B", "C"]);
  });
  it("narrows titles by the chips", () => {
    const hits = [hit("A"), hit("B", "wt", "wiktionary"), hit("C", "wf", "wikipedia", "fra")];
    expect(filterHits(hits, [], []).length).toBe(3);
    expect(filterHits(hits, ["wikipedia"], []).map((h) => h.title)).toEqual(["A", "C"]);
    expect(filterHits(hits, ["wikipedia"], ["fra"]).map((h) => h.title)).toEqual(["C"]);
  });
  it("opens the title that is the query, else the first", () => {
    expect(bestHit([hit("Fever (song)"), hit("Févér"), hit("Fever")], "fever")).toBe(1);
    expect(bestHit([hit("Fever dream"), hit("Fever pitch")], "fever")).toBe(0);
    expect(bestHit([], "fever")).toBe(-1);
  });
  it("names what the field searches", () => {
    expect(searchPlaceholder([])).toBe("Search");
    expect(searchPlaceholder(["Wikipedia"])).toBe("Search Wikipedia");
    expect(searchPlaceholder(["Wikipedia", "Wiktionary"])).toBe("Search Wikipedia and Wiktionary");
    expect(searchPlaceholder(["Wikipedia", "Wiktionary", "WikiMed", "ArchWiki"])).toBe("Search Wikipedia, Wiktionary and 2 more");
  });
});

describe("find in page", () => {
  const marked = (texts: string[], q: string) => findMatches(texts, q).map((m) => m.map((p) => texts[p.node].slice(p.start, p.end)).join("|"));
  it("ignores letter case and accents and keeps offsets in the page's own text", () => {
    expect(marked(["Café au lait, CAFE noir, cafe"], "cafe")).toEqual(["Café", "CAFE", "cafe"]);
    expect(foldText("ÉCOLE İ")).toHaveLength("ÉCOLE İ".length);
  });
  it("finds a match that crosses from one text node into the next", () => {
    const texts = ["The bo", "dy tem", "perature"];
    expect(findMatches(texts, "body temperature")).toEqual([[{ node: 0, start: 4, end: 6 }, { node: 1, start: 0, end: 6 }, { node: 2, start: 0, end: 8 }]]);
  });
  it("lets a space stand for any run of spaces and line breaks", () => {
    expect(marked(["high\n   fever"], "high fever")).toEqual(["high\n   fever"]);
    expect(marked(["highfever"], "high fever")).toEqual([]);
  });
  it("finds nothing for an empty query and stops at the limit", () => {
    expect(findMatches(["anything"], "   ")).toEqual([]);
    expect(findMatches(["aaaa"], "a", 3)).toHaveLength(3);
    expect(findMatches(["aaaa"], "aa")).toHaveLength(2);
    expect(findMatches(["", "x", "", "x"], "x").map((m) => m[0].node)).toEqual([1, 3]);
  });
  it("counts in words", () => {
    expect(findCountText(0, 0)).toBe("No matches");
    expect(findCountText(2, 17)).toBe("3 of 17");
    expect(findCountText(0, 500)).toBe("1 of 500+");
  });
});

describe("sizes, downloads and the plan", () => {
  it("says sizes, speeds and time left", () => {
    expect(sizeText(97 * GB)).toBe("97 GB");
    expect(sizeText(1.25 * GB)).toBe("1.3 GB");
    expect(sizeText(undefined)).toBe("size unknown");
    expect(sizeText(-1)).toBe("size unknown");
    expect(speedText(32_000_000)).toBe("32 Mbps");
    expect(speedText(4_200_000)).toBe("4.2 Mbps");
    expect(speedText(640_000)).toBe("640 kbps");
    expect(speedText(0)).toBe("");
    expect(etaText(30)).toBe("under a minute left");
    expect(etaText(40 * 60)).toBe("about 40 min left");
    expect(etaText(2 * 3600 + 10 * 60)).toBe("about 2 h 10 min left");
    expect(etaText(3 * 3600)).toBe("about 3 h left");
    expect(etaText(5 * 86400)).toBe("about 5 days left");
    expect(etaText(null)).toBe("");
  });
  it("describes a download", () => {
    const d = { bytes: 10 * GB, done_bytes: 2.5 * GB, speed_bps: 32_000_000, eta_s: 40 * 60, state: "downloading" as const };
    expect(percentDone(d)).toBe(25);
    expect(progressText(d)).toBe("2.5 GB of 10 GB, 32 Mbps, about 40 min left");
    expect(progressText({ ...d, state: "paused" })).toBe("2.5 GB of 10 GB");
    expect(percentDone({ bytes: 0, done_bytes: 5 })).toBe(0);
    expect(downloadStateText({ state: "waiting", reason: "night" })).toBe("Waits for the night, between 01:00 and 07:00 on the hub");
    expect(downloadStateText({ state: "waiting", reason: "something new" })).toBe("Waiting");
    expect(downloadStateText({ state: "failed", error: "The file did not match its checksum" })).toBe("Failed: The file did not match its checksum");
  });
  it("puts the total against free space", () => {
    const fits = planText({ wanted_bytes: 97 * GB, to_download_bytes: 12 * GB, free_bytes: 410 * GB, fits: true });
    expect(fits.lines).toEqual(["Your choices take 97 GB.", "12 GB of it is still to download.", "The hub has 410 GB free."]);
    expect(fits.share).toBeCloseTo(12 / 410);
    const tight = planText({ wanted_bytes: 120 * GB, to_download_bytes: 120 * GB, free_bytes: 60 * GB, fits: false });
    expect(tight.fits).toBe(false);
    expect(tight.share).toBe(1);
    expect(tight.lines[3]).toMatch(/^Not enough room/);
    expect(planText({ wanted_bytes: 0, to_download_bytes: 0, free_bytes: GB, fits: true }).lines[1]).toBe("Nothing to download.");
    expect(planText({ wanted_bytes: GB, to_download_bytes: 0, free_bytes: GB, fits: true }).lines[1]).toBe("All of it is downloaded.");
  });

  const book = (flavour: string, bytes: number, date = "2024-01-01"): RefCatalogBook => ({ name: `x_${flavour || "all"}_${date}`, flavour, images: flavour === "maxi", bytes, date, articles: 10 });
  const wiki: RefSource = {
    id: "wikipedia", title: "Wikipedia", summary: "", group: "Encyclopedias", license: "CC BY-SA",
    languages: [
      { code: "eng", tag: "en", name: "English", native: "English", books: [book("maxi", 100 * GB), book("nopic", 50 * GB), book("mini", 10 * GB), book("nopic", 48 * GB, "2023-06-01")] },
      { code: "fra", tag: "fr", name: "French", native: "français", books: [book("maxi", 40 * GB), book("nopic", 20 * GB)] },
    ],
  };
  const guide: RefSource = { id: "wikivoyage", title: "Wikivoyage", summary: "", group: "Dictionaries and travel", license: "", languages: [{ code: "eng", tag: "en", name: "English", native: "English", books: [book("", 1 * GB)] }] };
  const s = (over: Partial<RefSettings> = {}): RefSettings => ({ ...DEFAULT_SETTINGS, ...over });
  it("picks the book the hub would download for the choices", () => {
    const eng = wiki.languages[0];
    expect(wantedBook("wikipedia", eng, s())?.bytes).toBe(50 * GB);
    expect(wantedBook("wikipedia", eng, s())?.date).toBe("2024-01-01");
    expect(wantedBook("wikipedia", eng, s({ images: true }))?.flavour).toBe("maxi");
    expect(wantedBook("wikipedia", eng, s({ images: true, wikipedia: "intros" }))?.flavour).toBe("mini");
    expect(wantedBook("wikipedia", eng, s({ overrides: { wikipedia: { images: true } } }))?.flavour).toBe("maxi");
    expect(wantedBook("wikipedia", eng, s({ images: true, overrides: { wikipedia: { images: false } } }))?.flavour).toBe("nopic");
    expect(wantedBook("wikivoyage", guide.languages[0], s({ images: true }))?.flavour).toBe("");
    expect(wantedBook("x", { books: [book("maxi", GB)] }, s())?.flavour).toBe("maxi");
    // No text-only kind and two others (mdwiki): the smaller, as the hub picks.
    expect(wantedBook("mdwiki", { books: [book("", 10 * GB), book("maxi", 2 * GB)] }, s())?.flavour).toBe("maxi");
  });
  it("sizes a source for the chosen languages, or none when it has none of them", () => {
    expect(wantedBytes(wiki, s())).toBe(50 * GB);
    expect(wantedBytes(wiki, s({ languages: ["eng", "fra"] }))).toBe(70 * GB);
    expect(wantedBytes(wiki, s({ languages: ["eng", "fra"], images: true }))).toBe(140 * GB);
    expect(wantedBytes(wiki, s({ languages: ["deu"] }))).toBeNull();
    expect(wantedBytes(wiki, s({ languages: ["deu"], overrides: { wikipedia: { languages: ["fra"] } } }))).toBe(20 * GB);
  });
  it("finds languages by their English or own name", () => {
    const list = [
      { code: "fra", tag: "fr", name: "French", native: "français", sources: 3 },
      { code: "deu", tag: "de", name: "German", native: "Deutsch", sources: 2 },
    ];
    expect(matchLanguages(list, "FRAN").map((l) => l.code)).toEqual(["fra"]);
    expect(matchLanguages(list, "deutsch").map((l) => l.code)).toEqual(["deu"]);
    expect(matchLanguages(list, "")).toHaveLength(2);
  });
});

describe("Settings words", () => {
  const b = (source: string, title: string, state: RefBook["state"] = "ready"): RefBook => ({ name: `${source}_${state}`, source, lang: "eng", title, flavour: "nopic", date: "2024-01-01", bytes: 1, articles: 1, fulltext: true, file: "f.zim", state });
  it("sums up the hub in the Settings row", () => {
    expect(settingsSummary(null)).toBe("Wikipedia and more, kept on the hub");
    expect(settingsSummary({ books: [], downloads: [] })).toBe("Nothing downloaded yet");
    const dl = { name: "x", flavour: "", lang: "eng", source: "x", title: "X", date: "", bytes: 1, done_bytes: 0, speed_bps: null, eta_s: null, state: "downloading" as const };
    expect(settingsSummary({ books: [b("wikipedia", "Wikipedia"), b("wiktionary", "Wiktionary"), b("gone", "Gone", "removing")], downloads: [dl] })).toBe("Wikipedia and Wiktionary, 1 downloading");
    expect(shortList(["A", "B", "C", "D"])).toBe("A, B and 2 more");
  });
  it("names the kinds of copy", () => {
    expect(flavourText("maxi")).toBe("with pictures");
    expect(flavourText("nopic")).toBe("text only");
    expect(flavourText("mini")).toBe("intros only");
    expect(flavourText("")).toBe("");
  });
});

describe("hub answers", () => {
  it("reads the choices whether they come alone or under settings, with the plan", () => {
    const plan = { wanted_bytes: 1, to_download_bytes: 1, free_bytes: 2, fits: true };
    const flat = readSettings({ sources: ["wikipedia"], languages: ["eng"], images: true, wikipedia: "intros", overrides: { wikipedia: { images: false, junk: 1 } }, schedule: "any", max_mbps: 20, plan });
    expect(flat.settings).toEqual({ sources: ["wikipedia"], languages: ["eng"], images: true, wikipedia: "intros", overrides: { wikipedia: { images: false } }, schedule: "any", max_mbps: 20 });
    expect(flat.plan).toEqual(plan);
    const nested = readSettings({ settings: { sources: ["a"] }, plan });
    expect(nested.settings.sources).toEqual(["a"]);
    expect(nested.settings.languages).toEqual(["eng"]);
    expect(nested.plan).toEqual(plan);
    expect(readSettings(null)).toEqual({ settings: DEFAULT_SETTINGS, plan: null });
  });
  it("names languages and makes chips from the ready books", () => {
    expect(languageName("eng")).toBe("English");
    expect(languageName("eng,fra")).toBe("English and French");
    expect(languageName("")).toBe("");
    expect(languageTag("eng")).toBe("en");
    expect(languageTag("mul")).toBeUndefined();
    const b = (name: string, source: string, lang: string, title: string): RefBook => ({ name, source, lang, title, flavour: "nopic", date: "2024-01-01", bytes: 1, articles: 1, fulltext: true, file: `${name}.zim`, state: "ready" });
    const chips = searchChips([b("wf", "wikipedia", "fra", "Wikipédia"), b("we", "wikipedia", "eng", "Wikipedia"), b("wt", "wiktionary", "eng", "Wiktionary")]);
    expect(chips.sources).toEqual([{ id: "wikipedia", label: "Wikipedia" }, { id: "wiktionary", label: "Wiktionary" }]);
    expect(chips.langs.map((l) => l.code)).toEqual(["fra", "eng"]);
  });
});
