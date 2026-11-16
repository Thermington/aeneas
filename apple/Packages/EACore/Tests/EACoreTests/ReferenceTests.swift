import XCTest
@testable import EACore

/// A hub that answers every call with one body and keeps what was asked.
private final class ReferenceHub: HubTransport, @unchecked Sendable {
    struct Call: Equatable { var method: String; var path: String; var query: [String: String]; var body: String? }
    private let lock = NSLock()
    private var _calls: [Call] = []
    var calls: [Call] { lock.withLock { _calls } }
    let status: Int
    let answer: Data

    init(_ answer: String = "{}", status: Int = 200) { self.answer = Data(answer.utf8); self.status = status }

    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        lock.withLock { _calls.append(Call(method: method, path: path, query: query, body: body.map { String(decoding: $0, as: UTF8.self) })) }
        return (status, answer)
    }
}

final class ReferenceTests: XCTestCase {
    // MARK: decoding

    private let sourcesJSON = """
    {"checked_at": "2026-11-16T03:00:00.000Z", "sources": [
      {"id": "wiktionary", "title": "Wiktionary", "summary": "A dictionary.", "group": "Dictionaries and travel", "license": "CC BY-SA 4.0",
       "languages": [{"code": "eng", "tag": "en", "name": "English", "native": "English",
                      "books": [{"name": "wiktionary_en_all", "flavour": "maxi", "images": true, "bytes": 8100000000, "date": "2025-09-12", "articles": 7000000},
                                {"name": "wiktionary_en_all", "flavour": "nopic", "images": false, "bytes": 5400000000, "date": "2025-09-12", "articles": 7000000}]}]},
      {"id": "wikipedia", "title": "Wikipedia", "summary": "The encyclopedia.", "group": "Encyclopedias", "license": "CC BY-SA 4.0",
       "languages": [{"code": "eng", "tag": "en", "name": "English", "native": "English",
                      "books": [{"name": "wikipedia_en_all", "flavour": "maxi", "images": true, "bytes": 1.1e11, "date": "2025-10-04", "articles": 6900000},
                                {"name": "wikipedia_en_all", "flavour": "nopic", "images": false, "bytes": 48000000000, "date": "2025-10-04", "articles": 6900000},
                                {"name": "wikipedia_en_all", "flavour": "mini", "images": false, "bytes": 12000000000, "date": "2025-10-04", "articles": 6900000},
                                {"flavour": "maxi"}]},
                     {"code": "deu", "tag": "de", "name": "German", "native": "Deutsch",
                      "books": [{"name": "wikipedia_de_all", "flavour": "nopic", "images": false, "bytes": 20000000000, "date": "2025-08-01", "articles": 2900000}]}]},
      {"id": "archwiki", "title": "ArchWiki", "summary": "Linux how-to.", "group": "Technical", "license": "GFDL",
       "languages": [{"code": "eng", "tag": "en", "name": "English", "native": "English",
                      "books": [{"name": "archlinux_en_all", "flavour": "", "images": false, "bytes": 30000000, "date": "2025-11-01", "articles": 9000}]}]},
      {"id": "gardens", "title": "Garden guides", "group": "Outdoors", "languages": []},
      {"title": "no id"}
    ]}
    """

    func testDecodesSourcesLossilyAndGroupsThemInTheContractsOrder() throws {
        let s = try JSONCoding.decode(ReferenceSources.self, from: sourcesJSON)
        XCTAssertEqual(s.checked_at, "2026-11-16T03:00:00.000Z")
        XCTAssertEqual(s.sources.map(\.id), ["wiktionary", "wikipedia", "archwiki", "gardens"], "a source without an id is dropped")
        let wiki = try XCTUnwrap(s.source("wikipedia"))
        XCTAssertEqual(wiki.languages.map(\.code), ["eng", "deu"])
        XCTAssertEqual(wiki.languages[0].books.count, 3, "a book without a name is dropped")
        XCTAssertEqual(wiki.languages[0].books[0].bytes, 110_000_000_000, "a size sent as a float still reads")
        XCTAssertEqual(wiki.languages[1].native, "Deutsch")
        XCTAssertTrue(wiki.offersPictures)
        XCTAssertFalse(try XCTUnwrap(s.source("archwiki")).offersPictures)
        XCTAssertEqual(s.source("gardens")?.summary, "")

        XCTAssertEqual(s.grouped.map(\.title), ["Encyclopedias", "Dictionaries and travel", "Technical", "Outdoors"],
                       "the contract's groups first, then the hub's own, empty ones left out")
        XCTAssertEqual(s.languages.map(\.code), ["eng", "deu"], "by English name: English, then German")
        XCTAssertEqual(s.languages.first { $0.code == "deu" }?.books, [], "the language list carries no books")
        XCTAssertEqual(s.sourceCount(language: "eng"), 3)
        XCTAssertEqual(s.language("deu")?.name, "German")
    }

    func testDecodesSettingsInEitherShapeWithTheDefaults() throws {
        let nested = try JSONCoding.decode(ReferenceSettingsAnswer.self, from: """
        {"settings": {"sources": ["wikipedia"], "languages": ["eng", "deu"], "images": true, "wikipedia": "intros",
                      "overrides": {"wiktionary": {"images": false}, "archwiki": {"languages": ["eng"]}}, "schedule": "any", "max_mbps": 25},
         "plan": {"wanted_bytes": 12000000000, "to_download_bytes": 3000000000, "free_bytes": 800000000000, "fits": true}}
        """)
        XCTAssertEqual(nested.settings.sources, ["wikipedia"])
        XCTAssertEqual(nested.settings.languages, ["eng", "deu"])
        XCTAssertTrue(nested.settings.images)
        XCTAssertEqual(nested.settings.wikipedia, "intros")
        XCTAssertEqual(nested.settings.overrides["wiktionary"], ReferenceOverride(images: false))
        XCTAssertEqual(nested.settings.overrides["archwiki"], ReferenceOverride(languages: ["eng"]))
        XCTAssertEqual(nested.settings.schedule, "any")
        XCTAssertEqual(nested.settings.max_mbps, 25)
        XCTAssertEqual(nested.plan, ReferencePlan(wanted_bytes: 12_000_000_000, to_download_bytes: 3_000_000_000, free_bytes: 800_000_000_000, fits: true))

        let flat = try JSONCoding.decode(ReferenceSettingsAnswer.self, from: """
        {"sources": ["archwiki"], "max_mbps": null, "plan": {"wanted_bytes": 30000000, "to_download_bytes": 0, "free_bytes": 5000000000, "fits": false}}
        """)
        XCTAssertEqual(flat.settings, ReferenceSettings(sources: ["archwiki"]), "anything left out takes the contract's default")
        XCTAssertEqual(flat.settings.languages, ["eng"])
        XCTAssertFalse(flat.settings.images)
        XCTAssertEqual(flat.settings.wikipedia, "text")
        XCTAssertEqual(flat.settings.schedule, "nights")
        XCTAssertNil(flat.settings.max_mbps)
        XCTAssertEqual(flat.plan?.fits, false)

        let bare = try JSONCoding.decode(ReferenceSettingsAnswer.self, from: "{}")
        XCTAssertEqual(bare.settings, .defaults)
        XCTAssertNil(bare.plan)
    }

    func testAChangeSendsOnlyWhatChangedAndNullTakesTheCapAway() throws {
        XCTAssertEqual(try JSONCoding.string(ReferenceSettingsChange(sources: ["wikipedia", "archwiki"])), #"{"sources":["wikipedia","archwiki"]}"#)
        XCTAssertEqual(try JSONCoding.string(ReferenceSettingsChange(max_mbps: .some(nil))), #"{"max_mbps":null}"#)
        XCTAssertEqual(try JSONCoding.string(ReferenceSettingsChange(max_mbps: 50)), #"{"max_mbps":50}"#)
        XCTAssertEqual(try JSONCoding.string(ReferenceSettingsChange(overrides: ["wiktionary": ReferenceOverride(images: true)], schedule: "any")),
                       #"{"overrides":{"wiktionary":{"images":true}},"schedule":"any"}"#)
        XCTAssertEqual(try JSONCoding.string(ReferenceSettingsChange()), "{}")

        let before = ReferenceSettings(sources: ["wikipedia"], max_mbps: 10)
        let after = ReferenceSettingsChange(images: true, max_mbps: .some(nil)).applied(to: before)
        XCTAssertEqual(after, ReferenceSettings(sources: ["wikipedia"], images: true, max_mbps: nil))
        XCTAssertEqual(ReferenceSettingsChange(wikipedia: "intros").applied(to: before).max_mbps, 10, "a field not sent stays")
    }

    func testDecodesTheStatus() throws {
        let s = try JSONCoding.decode(ReferenceStatus.self, from: """
        {"on": true, "reader": {"state": "ready"},
         "books": [
           {"name": "wikipedia_en_all", "flavour": "nopic", "lang": "eng", "source": "wikipedia", "title": "Wikipedia", "date": "2025-10-04",
            "bytes": 48000000000, "articles": 6900000, "fulltext": true, "file": "wikipedia_en_all_nopic_2025-10.zim", "state": "ready"},
           {"name": "archlinux_en_all", "flavour": "", "lang": "eng", "source": "archwiki", "title": "ArchWiki", "date": "2025-11-01",
            "bytes": 30000000, "articles": 9000, "fulltext": false, "file": "archlinux_en_all_2025-11.zim", "state": "update"},
           {"name": "wiktionary_en_all", "flavour": "nopic", "lang": "eng", "source": "wiktionary", "title": "Wiktionary", "date": "2025-09-12",
            "bytes": 5400000000, "articles": 7000000, "fulltext": true, "file": "wiktionary_en_all_nopic_2025-09.zim", "state": "removing"},
           {"flavour": "nopic"}
         ],
         "downloads": [
           {"name": "wikipedia_de_all", "flavour": "nopic", "lang": "deu", "source": "wikipedia", "title": "Wikipedia", "date": "2025-08-01",
            "bytes": 20000000000, "done_bytes": 5000000000, "speed_bps": 11200000.5, "eta_s": 1340, "state": "downloading"},
           {"name": "archlinux_en_all", "flavour": "", "lang": "eng", "source": "archwiki", "title": "ArchWiki", "date": "2025-11-10",
            "bytes": 31000000, "done_bytes": 0, "speed_bps": 0, "eta_s": null, "state": "waiting", "reason": "night"},
           {"name": "gutenberg_en_all", "flavour": "", "lang": "eng", "source": "gutenberg", "title": "Project Gutenberg", "date": "2025-07-01",
            "bytes": 70000000000, "done_bytes": 100, "speed_bps": 0, "state": "failed", "error": "hash did not match"}
         ],
         "plan": {"wanted_bytes": 68030000000, "to_download_bytes": 15031000000, "free_bytes": 812000000000, "fits": true},
         "next_check": "2026-11-23T01:00:00.000Z"}
        """)
        XCTAssertTrue(s.on)
        XCTAssertEqual(s.reader, ReferenceStatus.Reader(state: "ready"))
        XCTAssertEqual(s.books.map(\.name), ["wikipedia_en_all", "archlinux_en_all", "wiktionary_en_all"])
        XCTAssertEqual(s.readableBooks.map(\.name), ["wikipedia_en_all", "archlinux_en_all"], "a book being removed is not read")
        XCTAssertFalse(s.books[1].fulltext)
        XCTAssertEqual(s.books[0].file, "wikipedia_en_all_nopic_2025-10.zim")
        XCTAssertEqual(s.downloads.count, 3)
        XCTAssertEqual(s.downloads[0].speed_bps, 11_200_000.5)
        XCTAssertEqual(s.downloads[0].eta_s, 1340)
        XCTAssertEqual(s.downloads[0].fraction, 0.25, accuracy: 0.0001)
        XCTAssertNil(s.downloads[1].eta_s)
        XCTAssertEqual(s.downloads[1].reason, "night")
        XCTAssertEqual(s.downloads[2].error, "hash did not match")
        XCTAssertTrue(s.downloading)
        XCTAssertFalse(s.paused)
        XCTAssertEqual(s.plan?.free_bytes, 812_000_000_000)
        XCTAssertEqual(s.next_check, "2026-11-23T01:00:00.000Z")

        let failed = try JSONCoding.decode(ReferenceStatus.self, from: #"{"on": false, "reader": {"state": "failed", "error": "kiwix-serve stopped"}, "books": [], "downloads": [], "plan": null, "next_check": null}"#)
        XCTAssertFalse(failed.on)
        XCTAssertEqual(failed.reader.error, "kiwix-serve stopped")
        XCTAssertNil(failed.plan)
        XCTAssertFalse(failed.downloading)
    }

    func testDecodesSuggestionsAndSearchResults() throws {
        let sug = try JSONCoding.decode(ReferenceSuggestions.self, from: """
        {"q": "photo", "results": [
          {"book": "wikipedia_en_all", "source": "wikipedia", "lang": "eng", "title": "Photosynthesis", "path": "Photosynthesis"},
          {"book": "wiktionary_en_all", "source": "wiktionary", "lang": "eng", "title": "photon", "path": "photon"},
          {"title": "no book"}
        ]}
        """)
        XCTAssertEqual(sug.q, "photo")
        XCTAssertEqual(sug.results.map(\.title), ["Photosynthesis", "photon"])
        XCTAssertEqual(sug.results[0].id, "wikipedia_en_all/Photosynthesis")

        let page = try JSONCoding.decode(ReferenceSearchPage.self, from: """
        {"q": "relativity", "results": [
          {"book": "wikipedia_en_all", "source": "wikipedia", "lang": "eng", "title": "Relativity", "path": "Relativity", "snippet": "", "kind": "title"},
          {"book": "wikipedia_en_all", "source": "wikipedia", "lang": "eng", "title": "Gravity", "path": "Gravity",
           "snippet": "explained by the theory of <b>relativity</b>", "kind": "text", "words": 12034}
        ], "total": 5021, "took_ms": 84, "partial": true}
        """)
        XCTAssertEqual(page.total, 5021)
        XCTAssertEqual(page.took_ms, 84)
        XCTAssertTrue(page.partial)
        XCTAssertEqual(page.results[0].kind, "title")
        XCTAssertNil(page.results[0].words)
        XCTAssertEqual(page.results[1].words, 12034)
        XCTAssertEqual(page.results[1].snippet, "explained by the theory of <b>relativity</b>")

        let thin = try JSONCoding.decode(ReferenceSearchPage.self, from: #"{"q": "x", "results": [{"book": "b", "path": "p"}]}"#)
        XCTAssertEqual(thin.total, 1, "a total below the results on hand is raised to them")
        XCTAssertFalse(thin.partial)
        XCTAssertEqual(thin.results[0].title, "p")
        XCTAssertEqual(thin.results[0].kind, "text")
    }

    func testDecodesAPageASummaryAndARandomPage() throws {
        let a = try JSONCoding.decode(ReferenceArticle.self, from: """
        {"book": "wikipedia_en_all", "source": "wikipedia", "lang": "eng", "title": "Photosynthesis", "path": "Photosynthesis",
         "html": "<p>Photosynthesis needs <a href=\\"#/reference/wikipedia_en_all/Chlorophyll\\" data-book=\\"wikipedia_en_all\\" data-path=\\"Chlorophyll\\">chlorophyll</a>.</p>",
         "toc": [{"level": 2, "id": "Overview", "text": "Overview"}, {"level": 3, "id": "Light_reactions", "text": "Light reactions"}, {"text": "no id"}],
         "date": "2025-10-04", "url": "https://en.wikipedia.org/wiki/Photosynthesis", "license": "CC BY-SA 4.0"}
        """)
        XCTAssertEqual(a.title, "Photosynthesis")
        XCTAssertEqual(a.toc, [ReferenceTocEntry(level: 2, id: "Overview", text: "Overview"), ReferenceTocEntry(level: 3, id: "Light_reactions", text: "Light reactions")])
        XCTAssertEqual(a.url, "https://en.wikipedia.org/wiki/Photosynthesis")
        XCTAssertEqual(a.license, "CC BY-SA 4.0")
        XCTAssertTrue(a.html.contains("data-path=\"Chlorophyll\""))

        let noURL = try JSONCoding.decode(ReferenceArticle.self, from: #"{"book": "archlinux_en_all", "title": "Systemd", "path": "Systemd", "html": "", "toc": [], "date": "2025-11-01", "url": null, "license": "GFDL"}"#)
        XCTAssertNil(noURL.url)
        let emptyURL = try JSONCoding.decode(ReferenceArticle.self, from: #"{"book": "b", "path": "p", "url": ""}"#)
        XCTAssertNil(emptyURL.url, "an empty address is no address")

        let sum = try JSONCoding.decode(ReferenceSummary.self, from: #"{"title": "Chlorophyll", "text": "Chlorophyll is a green pigment.", "media": "I/Chlorophyll.jpg"}"#)
        XCTAssertEqual(sum, ReferenceSummary(title: "Chlorophyll", text: "Chlorophyll is a green pigment.", media: "I/Chlorophyll.jpg"))
        XCTAssertNil(try JSONCoding.decode(ReferenceSummary.self, from: #"{"title": "Chlorophyll", "text": "A green pigment."}"#).media)

        let r = try JSONCoding.decode(ReferenceRandomPage.self, from: #"{"book": "wikipedia_en_all", "path": "Lake_Bled", "title": "Lake Bled"}"#)
        XCTAssertEqual(r, ReferenceRandomPage(book: "wikipedia_en_all", path: "Lake_Bled", title: "Lake Bled"))
    }

    // MARK: the hub's routes

    func testRoutesAskTheContractsPaths() async throws {
        let hub = ReferenceHub(#"{"q": "a b", "results": [], "total": 0, "took_ms": 1, "partial": false}"#)
        let c = HubClient(transport: hub)
        _ = try await c.referenceSearch("a b", sources: ["wikipedia", "archwiki"], langs: ["eng"], offset: 20)
        _ = try await c.referenceSearch("plain")
        XCTAssertEqual(hub.calls[0], .init(method: "GET", path: "reference/search",
                                           query: ["q": "a b", "sources": "wikipedia,archwiki", "langs": "eng", "limit": "20", "offset": "20"], body: nil))
        XCTAssertEqual(hub.calls[1].query, ["q": "plain", "limit": "20", "offset": "0"], "no filter: the lists are left out")

        let other = ReferenceHub("{}")
        let c2 = HubClient(transport: other)
        _ = try? await c2.referenceSuggest("photo")
        _ = try? await c2.referenceArticle(book: "wikipedia_en_all", path: "C++")
        _ = try? await c2.referenceSummary(book: "wikipedia_en_all", path: "Chlorophyll")
        _ = try await c2.referenceMedia(book: "wikipedia_en_all", path: "I/Leaf.jpg")
        _ = try? await c2.referenceRandom(langs: ["deu"])
        _ = try await c2.setReferenceSettings(ReferenceSettingsChange(images: true))
        try await c2.pauseReferenceDownloads()
        try await c2.resumeReferenceDownloads()
        try await c2.checkReferenceNow()
        try await c2.removeReferenceBook("wiktionary_en_all")
        let calls = other.calls
        XCTAssertEqual(calls.map { "\($0.method) \($0.path)" }, [
            "GET reference/suggest", "GET reference/article", "GET reference/summary", "GET reference/media", "GET reference/random",
            "PUT reference/settings", "POST reference/pause", "POST reference/resume", "POST reference/check", "DELETE reference/books/wiktionary_en_all",
        ])
        XCTAssertEqual(calls[0].query, ["q": "photo", "limit": "8"])
        XCTAssertEqual(calls[1].query, ["book": "wikipedia_en_all", "path": "C++"])
        XCTAssertEqual(calls[3].query, ["book": "wikipedia_en_all", "path": "I/Leaf.jpg"])
        XCTAssertEqual(calls[4].query, ["langs": "deu"])
        XCTAssertEqual(calls[5].body, #"{"images":true}"#)
        XCTAssertEqual(calls[6].body, "{}", "a POST carries an empty JSON object")
        XCTAssertNil(calls[9].body)
    }

    func testAHubWithoutReferenceSaysNotFound() async {
        let c = HubClient(transport: ReferenceHub(#"{"error": "not found"}"#, status: 404))
        do {
            _ = try await c.referenceStatus()
            XCTFail("a 404 is an error")
        } catch let e as HubError {
            XCTAssertEqual(e, .http(status: 404, message: "not found"))
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    // MARK: snippets

    private func boldWords(_ a: AttributedString) -> [String] {
        a.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }.map { String(a[$0.range].characters) }
    }

    func testASnippetKeepsOnlyBoldAsBold() {
        let s = ReferenceText.snippet("the theory of <b>relativity</b> and <i>special</i> <B>Relativity</B> &amp; more")
        XCTAssertEqual(String(s.characters), "the theory of relativity and special Relativity & more")
        XCTAssertEqual(boldWords(s), ["relativity", "Relativity"])
        XCTAssertEqual(ReferenceText.plainSnippet("<b>a</b>"), "a")
    }

    func testASnippetDecodesEntitiesAndJoinsWhiteSpace() {
        let s = ReferenceText.snippet("  Caf&#233; &lt;menu&gt;\n\n  &quot;open&quot;&nbsp;&#x41;&apos;s  &unknown; ")
        XCTAssertEqual(String(s.characters), "Café <menu> \"open\" A's &unknown;")
        XCTAssertEqual(boldWords(s), [])
        XCTAssertEqual(String(ReferenceText.snippet("one<br>two<br/>three</p><p>four").characters), "one two three four")
    }

    func testASnippetCutOffMidwayDropsTheCutPart() {
        let unclosed = ReferenceText.snippet("named after the <b>river")
        XCTAssertEqual(String(unclosed.characters), "named after the river")
        XCTAssertEqual(boldWords(unclosed), ["river"], "bold left open runs to the end")
        XCTAssertEqual(String(ReferenceText.snippet("the theory of <b").characters), "the theory of", "a tag cut in half goes")
        XCTAssertEqual(String(ReferenceText.snippet("salt &amp; pepper &am").characters), "salt & pepper", "an entity cut in half goes")
        XCTAssertEqual(String(ReferenceText.snippet("AT&T<b>shares</b>").characters), "AT&Tshares", "only the very end can be cut")
        XCTAssertEqual(String(ReferenceText.snippet("").characters), "")
        XCTAssertEqual(String(ReferenceText.snippet("<b></b>").characters), "")
    }

    // MARK: citation, Ask, dates

    func testTheCitation() {
        XCTAssertEqual(ReferenceText.citation(title: "Photosynthesis", sourceTitle: "Wikipedia", date: "2025-10-04", url: "https://en.wikipedia.org/wiki/Photosynthesis"),
                       "Photosynthesis. Wikipedia, offline copy of October 4, 2025. https://en.wikipedia.org/wiki/Photosynthesis")
        XCTAssertEqual(ReferenceText.citation(title: "Systemd", sourceTitle: "ArchWiki", date: "2025-11", url: nil),
                       "Systemd. ArchWiki, offline copy of November 2025.")
        XCTAssertEqual(ReferenceText.citation(title: "Systemd", sourceTitle: "ArchWiki", date: "2025-11-01T00:00:00Z", url: "  "),
                       "Systemd. ArchWiki, offline copy of November 1, 2025.", "an empty address is left out")
        XCTAssertEqual(ReferenceText.citation(title: "Washington, D.C.", sourceTitle: "Wikivoyage", date: "2025-06-30", url: nil),
                       "Washington, D.C. Wikivoyage, offline copy of June 30, 2025.", "no second period after one the title ends with")
        XCTAssertEqual(ReferenceText.citation(title: "What is it?", sourceTitle: "Super User", date: "someday", url: nil),
                       "What is it? Super User, offline copy of someday.", "a date that does not read stays as given")
    }

    func testTheAskPrefillIsExact() {
        XCTAssertEqual(ReferenceText.askPrefill(title: "Photosynthesis", sourceTitle: "Wikipedia", book: "wikipedia_en_all", path: "Photosynthesis"),
                       "Ask about \"Photosynthesis\" (Wikipedia, reference wikipedia_en_all/Photosynthesis): ")
        XCTAssertEqual(ReferenceText.askPrefill(title: "C++", sourceTitle: "cppreference", book: "cppreference_en", path: "w/cpp/language"),
                       "Ask about \"C++\" (cppreference, reference cppreference_en/w/cpp/language): ")
    }

    func testArchiveDates() {
        XCTAssertEqual(ReferenceText.archiveDate("2025-01-09"), "January 9, 2025")
        XCTAssertEqual(ReferenceText.archiveDate("2025-12"), "December 2025")
        XCTAssertEqual(ReferenceText.archiveDate(""), "")
        let us = Locale(identifier: "en_US")
        XCTAssertEqual(ReferenceText.shortArchiveDate("2025-10-04", locale: us), "Oct 2025")
        XCTAssertEqual(ReferenceText.shortArchiveDate("2025-12-31T23:59:59Z", locale: us), "Dec 2025", "the archive's own day, whatever the zone")
        XCTAssertEqual(ReferenceText.shortArchiveDate("soon", locale: us), "soon")
    }

    // MARK: recents and reading positions

    func testRecentsAreNewestFirstWithoutRepeatsAndAtMostThirty() {
        func page(_ n: Int) -> ReferenceRecent { ReferenceRecent(book: "b", path: "p\(n)", title: "Page \(n)", at: "2026-11-16T00:00:\(n % 60)Z") }
        var list: [ReferenceRecent] = []
        for n in 0..<35 { list = ReferenceRecents.adding(page(n), to: list) }
        XCTAssertEqual(list.count, 30)
        XCTAssertEqual(list.first?.path, "p34")
        XCTAssertEqual(list.last?.path, "p5", "the oldest go first")

        list = ReferenceRecents.adding(ReferenceRecent(book: "b", path: "p20", title: "Page 20 again"), to: list)
        XCTAssertEqual(list.count, 30)
        XCTAssertEqual(list.first?.title, "Page 20 again")
        XCTAssertEqual(list.filter { $0.path == "p20" }.count, 1, "one entry per page")
        XCTAssertEqual(ReferenceRecents.adding(page(1), to: [ReferenceRecent(book: "other", path: "p1", title: "x")]).count, 2,
                       "the same path in another book is another page")
    }

    func testPositionsAreBoundedAndTheOldestGoFirst() {
        var map: [String: ReferencePosition] = [:]
        for n in 0..<6 { map = ReferencePositions.setting(ReferencePosition(fraction: 0.1, at: Double(n)), for: "k\(n)", in: map, limit: 4) }
        XCTAssertEqual(Set(map.keys), ["k2", "k3", "k4", "k5"])
        map = ReferencePositions.setting(ReferencePosition(fraction: 0.5, anchor: "Overview", offset: 40, at: 1), for: "k3", in: map, limit: 4)
        XCTAssertEqual(map.count, 4, "updating a page adds nothing")
        XCTAssertEqual(map["k3"], ReferencePosition(fraction: 0.5, anchor: "Overview", offset: 40, at: 1))
        XCTAssertEqual(ReferencePosition(fraction: 3, at: 0).fraction, 1)
        XCTAssertEqual(ReferencePosition(fraction: .nan, at: 0).fraction, 0)
        XCTAssertEqual(ReferencePositions.limit, 300)
    }

    // MARK: links

    func testLinksInsideABook() {
        XCTAssertTrue(ReferenceLink.parse("#/reference/wikipedia_en_all/Photosynthesis")! == ("wikipedia_en_all", "Photosynthesis"))
        XCTAssertTrue(ReferenceLink.parse("aeneas-ref://page/#/reference/wikipedia_en_all/Caf%C3%A9%20au%20lait")! == ("wikipedia_en_all", "Café au lait"))
        XCTAssertTrue(ReferenceLink.parse("#/reference/cppreference_en/w%2Fcpp%2Flanguage")! == ("cppreference_en", "w/cpp/language"))
        XCTAssertTrue(ReferenceLink.parse("#/reference/cppreference_en/w/cpp/language")! == ("cppreference_en", "w/cpp/language"))
        XCTAssertTrue(ReferenceLink.parse("#/reference/wikipedia_en_all/C++")! == ("wikipedia_en_all", "C++"))
        XCTAssertNil(ReferenceLink.parse("#cite_note-1"))
        XCTAssertNil(ReferenceLink.parse("https://en.wikipedia.org/wiki/Photosynthesis"))
        XCTAssertNil(ReferenceLink.parse("#/reference/onlybook"))
        XCTAssertNil(ReferenceLink.parse("#/reference//path"))
        XCTAssertEqual(ReferenceLink.key(book: "b", path: "a/b"), "b/a/b")
        XCTAssertTrue(ReferenceLink.split(" wikipedia_en_all/A/Lake Bled ")! == ("wikipedia_en_all", "A/Lake Bled"))
        XCTAssertNil(ReferenceLink.split("nopath"))
    }

    // MARK: sizes for the choices

    func testTheBookWantedForEachChoice() throws {
        let s = try JSONCoding.decode(ReferenceSources.self, from: sourcesJSON)
        let wiki = try XCTUnwrap(s.source("wikipedia")), dict = try XCTUnwrap(s.source("wiktionary")), arch = try XCTUnwrap(s.source("archwiki"))

        XCTAssertEqual(ReferencePlanner.wanted(wiki, settings: .defaults).map(\.book.flavour), ["nopic"], "pictures are off by default")
        XCTAssertEqual(ReferencePlanner.wanted(wiki, settings: ReferenceSettings(images: true)).map(\.book.flavour), ["maxi"])
        XCTAssertEqual(ReferencePlanner.wanted(wiki, settings: ReferenceSettings(images: true, wikipedia: "intros")).map(\.book.flavour), ["mini"],
                       "intros take no pictures")
        XCTAssertEqual(ReferencePlanner.wanted(dict, settings: ReferenceSettings(wikipedia: "intros")).map(\.book.flavour), ["nopic"],
                       "intros only touch Wikipedia")
        XCTAssertEqual(ReferencePlanner.wanted(arch, settings: ReferenceSettings(images: true)).map(\.book.flavour), [""], "the only kind there is")

        let both = ReferenceSettings(languages: ["eng", "deu"], images: true)
        XCTAssertEqual(ReferencePlanner.wanted(wiki, settings: both).map(\.book.name), ["wikipedia_en_all", "wikipedia_de_all"])
        XCTAssertEqual(ReferencePlanner.wanted(wiki, settings: both).map(\.book.flavour), ["maxi", "nopic"], "German has no pictures kind")
        XCTAssertEqual(ReferencePlanner.bytes(wiki, settings: both), 110_000_000_000 + 20_000_000_000)
        XCTAssertEqual(ReferencePlanner.wanted(arch, settings: ReferenceSettings(languages: ["deu"])), [], "not in a chosen language")

        let override = ReferenceSettings(images: true, overrides: ["wiktionary": ReferenceOverride(images: false), "wikipedia": ReferenceOverride(languages: ["deu"])])
        XCTAssertEqual(ReferencePlanner.wanted(dict, settings: override).map(\.book.flavour), ["nopic"], "a source's own picture choice wins")
        XCTAssertEqual(ReferencePlanner.wanted(wiki, settings: override).map(\.language.code), ["deu"], "a source's own languages win")
        XCTAssertTrue(ReferencePlanner.images(for: wiki, in: override))
        XCTAssertFalse(ReferencePlanner.images(for: dict, in: override))

        // No text-only kind and two others (mdwiki's pictures and its larger one with videos): the smaller, as the hub picks.
        let md = try JSONCoding.decode(ReferenceSources.self, from: Data(#"{"checked_at":null,"sources":[{"id":"mdwiki","title":"Medical","summary":"","group":"Medicine","license":"","languages":[{"code":"eng","tag":"en","name":"English","native":"English","books":[{"name":"mdwiki_en_all","flavour":"","images":true,"bytes":10800000000,"date":"2025-11-14","articles":1},{"name":"mdwiki_en_all","flavour":"maxi","images":true,"bytes":2300000000,"date":"2025-11-12","articles":1}]}]}]}"#.utf8))
        XCTAssertEqual(ReferencePlanner.wanted(try XCTUnwrap(md.source("mdwiki")), settings: .defaults).map(\.book.flavour), ["maxi"])
    }

    // MARK: pictures

    func testPictureTypesComeFromTheBytes() {
        XCTAssertEqual(ReferenceMedia.mimeType(Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0])), "image/png")
        XCTAssertEqual(ReferenceMedia.mimeType(Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10])), "image/jpeg")
        XCTAssertEqual(ReferenceMedia.mimeType(Data("GIF89a....".utf8)), "image/gif")
        XCTAssertEqual(ReferenceMedia.mimeType(Data("RIFF\u{0}\u{0}\u{0}\u{0}WEBPVP8 ".utf8)), "image/webp")
        XCTAssertEqual(ReferenceMedia.mimeType(Data("\u{FEFF}<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>".utf8)), "image/svg+xml")
        XCTAssertEqual(ReferenceMedia.mimeType(Data("  <svg width=\"10\"></svg>".utf8)), "image/svg+xml")
        XCTAssertNil(ReferenceMedia.mimeType(Data("<html><body>not a picture</body></html>".utf8)))
        XCTAssertNil(ReferenceMedia.mimeType(Data("%PDF-1.7".utf8)))
        XCTAssertNil(ReferenceMedia.mimeType(Data()))
    }

    // MARK: downloads in words

    func testDownloadProgressInWords() {
        XCTAssertNil(ReferenceText.timeLeft(nil))
        XCTAssertNil(ReferenceText.timeLeft(0))
        XCTAssertEqual(ReferenceText.timeLeft(20), "under a minute left")
        XCTAssertEqual(ReferenceText.timeLeft(1340), "about 22 min left")
        XCTAssertEqual(ReferenceText.timeLeft(3600), "about 1 h left")
        XCTAssertEqual(ReferenceText.timeLeft(2 * 3600 + 600), "about 2 h 10 min left")
        XCTAssertEqual(ReferenceText.timeLeft(3 * 86400), "about 3 days left")

        XCTAssertEqual(ReferenceText.speed(84_200_000), "84.2 Mbps", "the speed is bits a second, shown as the cap is set")
        XCTAssertEqual(ReferenceText.speed(120_400_000), "120 Mbps")
        XCTAssertEqual(ReferenceText.speed(400_000), "0.4 Mbps")

        let size = ReferenceText.size
        let d = ReferenceDownload(name: "w", bytes: 20_000_000_000, done_bytes: 5_000_000_000, speed_bps: 11_200_000, eta_s: 1340, state: "downloading")
        XCTAssertEqual(ReferenceText.progress(d), "\(size(5_000_000_000)) of \(size(20_000_000_000)), 11.2 Mbps, about 22 min left")
        XCTAssertEqual(ReferenceText.progress(ReferenceDownload(name: "w", bytes: 10, state: "queued")), "Waiting its turn")
        XCTAssertEqual(ReferenceText.progress(ReferenceDownload(name: "w", state: "verifying")), "Checking the file")
        XCTAssertEqual(ReferenceText.progress(ReferenceDownload(name: "w", bytes: 20_000_000_000, done_bytes: 5_000_000_000, state: "paused")),
                       "Paused at \(size(5_000_000_000)) of \(size(20_000_000_000))")
        XCTAssertEqual(ReferenceText.progress(ReferenceDownload(name: "w", state: "waiting", reason: "night")), "Waits for the night, 01:00 to 07:00 on the hub")
        XCTAssertEqual(ReferenceText.progress(ReferenceDownload(name: "w", state: "waiting", reason: "disk")), "Waits for room on the hub's disk")
        XCTAssertEqual(ReferenceText.progress(ReferenceDownload(name: "w", state: "waiting", reason: "something new")), "Waiting")
        XCTAssertEqual(ReferenceText.progress(ReferenceDownload(name: "w", state: "failed", error: "hash did not match")), "Did not download: hash did not match")
        XCTAssertEqual(ReferenceText.flavour("maxi"), "with pictures")
        XCTAssertNil(ReferenceText.flavour(""))
    }

    func testTheModuleIdIsKnown() {
        XCTAssertEqual(AppModule(rawValue: "reference"), .reference)
        XCTAssertTrue([ModuleInfo(id: "reference", title: "Reference", on: false)].isOn(.reference) == false)
    }
}
