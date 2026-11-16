import Foundation

// Offline reference (contract, Offline reference): open references kept on the hub as Kiwix archives (Wikipedia,
// Wiktionary, medical and practical guides and more), searched and read on every device with no internet. Every
// search and page goes through the hub. Decoding is lossy: a source, book or result the app does not understand is
// dropped, never fatal, and a missing field falls back so a thinner answer still decodes.

// MARK: Sources and choices

/// One kind of a source in one language (`GET /reference/sources`). `flavour` is `maxi` (with pictures), `nopic`
/// (text only), `mini` (Wikipedia: the start of each article) or empty (the only kind there is).
public struct ReferenceCatalogBook: Codable, Equatable, Hashable, Sendable {
    public var name: String
    public var flavour: String
    public var images: Bool
    public var bytes: Int64
    public var date: String
    public var articles: Int

    public init(name: String, flavour: String = "", images: Bool = false, bytes: Int64 = 0, date: String = "", articles: Int = 0) {
        self.name = name; self.flavour = flavour; self.images = images; self.bytes = bytes; self.date = date; self.articles = articles
    }

    enum CodingKeys: String, CodingKey { case name, flavour, images, bytes, date, articles }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        flavour = c.referenceString(.flavour)
        images = c.referenceBool(.images) ?? (flavour == "maxi")
        bytes = c.referenceInt64(.bytes)
        date = c.referenceString(.date)
        articles = Int(c.referenceInt64(.articles))
    }
}

/// A language a source comes in. `code` is ISO 639-3 as Kiwix gives it (`eng`), `tag` the BCP 47 tag (`en`),
/// `name` in English and `native` in itself.
public struct ReferenceLanguage: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var code: String
    public var tag: String
    public var name: String
    public var native: String
    public var books: [ReferenceCatalogBook]
    public var id: String { code }

    public init(code: String, tag: String = "", name: String = "", native: String = "", books: [ReferenceCatalogBook] = []) {
        self.code = code; self.tag = tag; self.name = name.isEmpty ? code : name; self.native = native; self.books = books
    }

    enum CodingKeys: String, CodingKey { case code, tag, name, native, books }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        tag = c.referenceString(.tag)
        let n = c.referenceString(.name)
        name = n.isEmpty ? code : n
        native = c.referenceString(.native)
        books = (try? c.decodeIfPresent(LossyList<ReferenceCatalogBook>.self, forKey: .books))?.items ?? []
    }
}

/// One reference the hub offers (a curated source joined with Kiwix's catalog).
public struct ReferenceSource: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var summary: String
    public var group: String
    public var license: String
    public var languages: [ReferenceLanguage]

    public init(id: String, title: String, summary: String = "", group: String = "", license: String = "", languages: [ReferenceLanguage] = []) {
        self.id = id; self.title = title; self.summary = summary; self.group = group; self.license = license; self.languages = languages
    }

    enum CodingKeys: String, CodingKey { case id, title, summary, group, license, languages }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        let t = c.referenceString(.title)
        title = t.isEmpty ? id : t
        summary = c.referenceString(.summary)
        group = c.referenceString(.group)
        license = c.referenceString(.license)
        languages = (try? c.decodeIfPresent(LossyList<ReferenceLanguage>.self, forKey: .languages))?.items ?? []
    }

    /// Whether some language of it comes both with pictures and without, so a picture choice means something.
    public var offersPictures: Bool {
        languages.contains { l in l.books.contains { $0.flavour == "maxi" } && l.books.contains { $0.flavour == "nopic" } }
    }
}

/// Sources that share a group, for Settings.
public struct ReferenceSourceGroup: Equatable, Identifiable, Sendable {
    public var title: String
    public var sources: [ReferenceSource]
    public var id: String { title }
}

/// `GET /reference/sources`.
public struct ReferenceSources: Codable, Equatable, Sendable {
    public var checked_at: String?
    public var sources: [ReferenceSource]

    /// The contract's groups, in its order.
    public static let groups = ["Encyclopedias", "Dictionaries and travel", "Medicine", "Practical", "Questions and answers", "Learning", "Books", "Technical"]

    public init(checked_at: String? = nil, sources: [ReferenceSource] = []) { self.checked_at = checked_at; self.sources = sources }

    enum CodingKeys: String, CodingKey { case checked_at, sources }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        checked_at = try? c.decodeIfPresent(String.self, forKey: .checked_at)
        sources = (try? c.decodeIfPresent(LossyList<ReferenceSource>.self, forKey: .sources))?.items ?? []
    }

    /// Sources by group: the contract's groups first in its order, then any other group in the hub's order. Sources
    /// keep the hub's order inside a group; a group with none is left out.
    public var grouped: [ReferenceSourceGroup] {
        var order = Self.groups
        for s in sources where !order.contains(s.group) { order.append(s.group) }
        return order.compactMap { g in
            let list = sources.filter { $0.group == g }
            return list.isEmpty ? nil : ReferenceSourceGroup(title: g, sources: list)
        }
    }

    /// Every language some source comes in, once each (the first source's names win), by English name.
    public var languages: [ReferenceLanguage] {
        var seen: [String: ReferenceLanguage] = [:]
        for s in sources {
            for l in s.languages where seen[l.code] == nil { seen[l.code] = ReferenceLanguage(code: l.code, tag: l.tag, name: l.name, native: l.native) }
        }
        return seen.values.sorted { a, b in
            let order = a.name.localizedStandardCompare(b.name)
            return order == .orderedSame ? a.code < b.code : order == .orderedAscending
        }
    }

    /// How many sources come in a language.
    public func sourceCount(language code: String) -> Int { sources.filter { s in s.languages.contains { $0.code == code } }.count }

    public func source(_ id: String) -> ReferenceSource? { sources.first { $0.id == id } }

    public func language(_ code: String) -> ReferenceLanguage? {
        for s in sources { if let l = s.languages.first(where: { $0.code == code }) { return l } }
        return nil
    }
}

/// A source's own choices, over the general ones.
public struct ReferenceOverride: Codable, Equatable, Hashable, Sendable {
    public var images: Bool?
    public var languages: [String]?

    public init(images: Bool? = nil, languages: [String]? = nil) { self.images = images; self.languages = languages }
    public var isEmpty: Bool { images == nil && languages == nil }
}

/// The owner's choices (`GET /reference/settings`), with the contract's defaults for anything left out.
public struct ReferenceSettings: Codable, Equatable, Sendable {
    public var sources: [String]
    /// ISO 639-3 codes, as the sources list gives them.
    public var languages: [String]
    public var images: Bool
    /// `intros` or `text`.
    public var wikipedia: String
    public var overrides: [String: ReferenceOverride]
    /// `nights` or `any`.
    public var schedule: String
    /// Megabits a second; nil for no cap.
    public var max_mbps: Double?

    public static let defaults = ReferenceSettings()

    public init(sources: [String] = [], languages: [String] = ["eng"], images: Bool = false, wikipedia: String = "text",
                overrides: [String: ReferenceOverride] = [:], schedule: String = "nights", max_mbps: Double? = nil) {
        self.sources = sources; self.languages = languages; self.images = images; self.wikipedia = wikipedia
        self.overrides = overrides; self.schedule = schedule; self.max_mbps = max_mbps
    }

    enum CodingKeys: String, CodingKey { case sources, languages, images, wikipedia, overrides, schedule, max_mbps }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sources = (try? c.decodeIfPresent([String].self, forKey: .sources)) ?? []
        languages = (try? c.decodeIfPresent([String].self, forKey: .languages)) ?? ["eng"]
        images = c.referenceBool(.images) ?? false
        let w = c.referenceString(.wikipedia)
        wikipedia = w.isEmpty ? "text" : w
        overrides = (try? c.decodeIfPresent([String: ReferenceOverride].self, forKey: .overrides)) ?? [:]
        let s = c.referenceString(.schedule)
        schedule = s.isEmpty ? "nights" : s
        max_mbps = c.referenceDouble(.max_mbps)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sources, forKey: .sources)
        try c.encode(languages, forKey: .languages)
        try c.encode(images, forKey: .images)
        try c.encode(wikipedia, forKey: .wikipedia)
        try c.encode(overrides, forKey: .overrides)
        try c.encode(schedule, forKey: .schedule)
        if let m = max_mbps { try c.encode(m, forKey: .max_mbps) } else { try c.encodeNil(forKey: .max_mbps) }
    }
}

/// What the choices come to on the hub's disk.
public struct ReferencePlan: Codable, Equatable, Sendable {
    public var wanted_bytes: Int64
    public var to_download_bytes: Int64
    public var free_bytes: Int64
    public var fits: Bool

    public init(wanted_bytes: Int64 = 0, to_download_bytes: Int64 = 0, free_bytes: Int64 = 0, fits: Bool = true) {
        self.wanted_bytes = wanted_bytes; self.to_download_bytes = to_download_bytes; self.free_bytes = free_bytes; self.fits = fits
    }

    enum CodingKeys: String, CodingKey { case wanted_bytes, to_download_bytes, free_bytes, fits }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        wanted_bytes = c.referenceInt64(.wanted_bytes)
        to_download_bytes = c.referenceInt64(.to_download_bytes)
        free_bytes = c.referenceInt64(.free_bytes)
        fits = c.referenceBool(.fits) ?? true
    }
}

/// `GET /reference/settings` and `PUT /reference/settings`: the choices and the plan. Read both as
/// `{ settings, plan }` and as the choices with `plan` beside them.
public struct ReferenceSettingsAnswer: Decodable, Equatable, Sendable {
    public var settings: ReferenceSettings
    public var plan: ReferencePlan?

    public init(settings: ReferenceSettings, plan: ReferencePlan? = nil) { self.settings = settings; self.plan = plan }

    enum CodingKeys: String, CodingKey { case settings, plan }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let nested = try? c.decodeIfPresent(ReferenceSettings.self, forKey: .settings) { settings = nested }
        else { settings = try ReferenceSettings(from: decoder) }
        plan = try? c.decodeIfPresent(ReferencePlan.self, forKey: .plan)
    }
}

/// A change to the choices (`PUT /reference/settings`): only the fields set are sent. `max_mbps` set to `.some(nil)`
/// sends null, which takes the cap away.
public struct ReferenceSettingsChange: Encodable, Equatable, Sendable {
    public var sources: [String]?
    public var languages: [String]?
    public var images: Bool?
    public var wikipedia: String?
    public var overrides: [String: ReferenceOverride]?
    public var schedule: String?
    public var max_mbps: Double??

    public init(sources: [String]? = nil, languages: [String]? = nil, images: Bool? = nil, wikipedia: String? = nil,
                overrides: [String: ReferenceOverride]? = nil, schedule: String? = nil, max_mbps: Double?? = nil) {
        self.sources = sources; self.languages = languages; self.images = images; self.wikipedia = wikipedia
        self.overrides = overrides; self.schedule = schedule; self.max_mbps = max_mbps
    }

    enum CodingKeys: String, CodingKey { case sources, languages, images, wikipedia, overrides, schedule, max_mbps }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(sources, forKey: .sources)
        try c.encodeIfPresent(languages, forKey: .languages)
        try c.encodeIfPresent(images, forKey: .images)
        try c.encodeIfPresent(wikipedia, forKey: .wikipedia)
        try c.encodeIfPresent(overrides, forKey: .overrides)
        try c.encodeIfPresent(schedule, forKey: .schedule)
        if let cap = max_mbps {
            if let v = cap { try c.encode(v, forKey: .max_mbps) } else { try c.encodeNil(forKey: .max_mbps) }
        }
    }

    /// The choices with this change made, as the hub will hold them once it answers.
    public func applied(to s: ReferenceSettings) -> ReferenceSettings {
        var out = s
        if let v = sources { out.sources = v }
        if let v = languages { out.languages = v }
        if let v = images { out.images = v }
        if let v = wikipedia { out.wikipedia = v }
        if let v = overrides { out.overrides = v }
        if let v = schedule { out.schedule = v }
        if let v = max_mbps { out.max_mbps = v }
        return out
    }
}

// MARK: Status

/// A book on the hub. `state` is `ready`, `update` (a newer file is downloading; this one still reads) or `removing`.
public struct ReferenceBook: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var name: String
    public var flavour: String
    public var lang: String
    public var source: String
    public var title: String
    public var date: String
    public var bytes: Int64
    public var articles: Int
    public var fulltext: Bool
    public var file: String
    public var state: String
    public var id: String { name }
    /// Ready, or ready while a newer copy downloads.
    public var isReadable: Bool { state == "ready" || state == "update" }

    public init(name: String, flavour: String = "", lang: String = "", source: String = "", title: String = "", date: String = "",
                bytes: Int64 = 0, articles: Int = 0, fulltext: Bool = true, file: String = "", state: String = "ready") {
        self.name = name; self.flavour = flavour; self.lang = lang; self.source = source; self.title = title.isEmpty ? name : title
        self.date = date; self.bytes = bytes; self.articles = articles; self.fulltext = fulltext; self.file = file; self.state = state
    }

    enum CodingKeys: String, CodingKey { case name, flavour, lang, source, title, date, bytes, articles, fulltext, file, state }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        flavour = c.referenceString(.flavour)
        lang = c.referenceString(.lang)
        source = c.referenceString(.source)
        let t = c.referenceString(.title)
        title = t.isEmpty ? name : t
        date = c.referenceString(.date)
        bytes = c.referenceInt64(.bytes)
        articles = Int(c.referenceInt64(.articles))
        fulltext = c.referenceBool(.fulltext) ?? false
        file = c.referenceString(.file)
        let s = c.referenceString(.state)
        state = s.isEmpty ? "ready" : s
    }
}

/// A download on the hub. `state` is `queued`, `downloading`, `verifying`, `paused`, `waiting` (with `reason`:
/// `night`, `game`, `disk`, `offline` or `module`) or `failed` (with `error`).
public struct ReferenceDownload: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var name: String
    public var flavour: String
    public var lang: String
    public var source: String
    public var title: String
    public var date: String
    public var bytes: Int64
    public var done_bytes: Int64
    /// Bits a second (shown in Mbps, as the speed cap is set).
    public var speed_bps: Double
    public var eta_s: Double?
    public var state: String
    public var reason: String?
    public var error: String?
    public var id: String { name }

    public init(name: String, flavour: String = "", lang: String = "", source: String = "", title: String = "", date: String = "",
                bytes: Int64 = 0, done_bytes: Int64 = 0, speed_bps: Double = 0, eta_s: Double? = nil, state: String = "queued",
                reason: String? = nil, error: String? = nil) {
        self.name = name; self.flavour = flavour; self.lang = lang; self.source = source; self.title = title.isEmpty ? name : title
        self.date = date; self.bytes = bytes; self.done_bytes = done_bytes; self.speed_bps = speed_bps; self.eta_s = eta_s
        self.state = state; self.reason = reason; self.error = error
    }

    enum CodingKeys: String, CodingKey { case name, flavour, lang, source, title, date, bytes, done_bytes, speed_bps, eta_s, state, reason, error }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        flavour = c.referenceString(.flavour)
        lang = c.referenceString(.lang)
        source = c.referenceString(.source)
        let t = c.referenceString(.title)
        title = t.isEmpty ? name : t
        date = c.referenceString(.date)
        bytes = c.referenceInt64(.bytes)
        done_bytes = c.referenceInt64(.done_bytes)
        speed_bps = c.referenceDouble(.speed_bps) ?? 0
        eta_s = c.referenceDouble(.eta_s)
        let s = c.referenceString(.state)
        state = s.isEmpty ? "queued" : s
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }

    /// How much is in, 0 to 1.
    public var fraction: Double { bytes > 0 ? min(1, max(0, Double(done_bytes) / Double(bytes))) : 0 }
    /// Moving now, or about to: worth watching closely.
    public var isActive: Bool { ["queued", "downloading", "verifying"].contains(state) }
}

/// `GET /reference/status`.
public struct ReferenceStatus: Decodable, Equatable, Sendable {
    /// The reader on the hub: `off`, `installing`, `starting`, `ready` or `failed` (with `error`).
    public struct Reader: Codable, Equatable, Sendable {
        public var state: String
        public var error: String?
        public init(state: String, error: String? = nil) { self.state = state; self.error = error }
    }

    public var on: Bool
    public var reader: Reader
    public var books: [ReferenceBook]
    public var downloads: [ReferenceDownload]
    public var plan: ReferencePlan?
    public var next_check: String?

    public init(on: Bool = true, reader: Reader = Reader(state: "off"), books: [ReferenceBook] = [], downloads: [ReferenceDownload] = [],
                plan: ReferencePlan? = nil, next_check: String? = nil) {
        self.on = on; self.reader = reader; self.books = books; self.downloads = downloads; self.plan = plan; self.next_check = next_check
    }

    enum CodingKeys: String, CodingKey { case on, reader, books, downloads, plan, next_check }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        on = c.referenceBool(.on) ?? true
        reader = (try? c.decodeIfPresent(Reader.self, forKey: .reader)) ?? Reader(state: "off")
        books = (try? c.decodeIfPresent(LossyList<ReferenceBook>.self, forKey: .books))?.items ?? []
        downloads = (try? c.decodeIfPresent(LossyList<ReferenceDownload>.self, forKey: .downloads))?.items ?? []
        plan = try? c.decodeIfPresent(ReferencePlan.self, forKey: .plan)
        next_check = try? c.decodeIfPresent(String.self, forKey: .next_check)
    }

    /// Books that can be searched and read now.
    public var readableBooks: [ReferenceBook] { books.filter(\.isReadable) }
    /// A download is moving or about to, so the screen asks often.
    public var downloading: Bool { downloads.contains { $0.isActive } }
    public var paused: Bool { downloads.contains { $0.state == "paused" } }
}

// MARK: Search

/// A title for as-you-type (`GET /reference/suggest`).
public struct ReferenceSuggestion: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var book: String
    public var source: String
    public var lang: String
    public var title: String
    public var path: String
    public var id: String { ReferenceLink.key(book: book, path: path) }

    public init(book: String, source: String = "", lang: String = "", title: String, path: String) {
        self.book = book; self.source = source; self.lang = lang; self.title = title; self.path = path
    }

    enum CodingKeys: String, CodingKey { case book, source, lang, title, path }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        book = try c.decode(String.self, forKey: .book)
        path = try c.decode(String.self, forKey: .path)
        source = c.referenceString(.source)
        lang = c.referenceString(.lang)
        let t = c.referenceString(.title)
        title = t.isEmpty ? path : t
    }
}

public struct ReferenceSuggestions: Decodable, Equatable, Sendable {
    public var q: String
    public var results: [ReferenceSuggestion]

    enum CodingKeys: String, CodingKey { case q, results }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        q = c.referenceString(.q)
        results = (try? c.decodeIfPresent(LossyList<ReferenceSuggestion>.self, forKey: .results))?.items ?? []
    }
}

/// A full-text or title hit (`GET /reference/search`). `snippet` is HTML with only `<b>` kept; `kind` is `title` or `text`.
public struct ReferenceSearchResult: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var book: String
    public var source: String
    public var lang: String
    public var title: String
    public var path: String
    public var snippet: String
    public var kind: String
    public var words: Int?
    public var id: String { ReferenceLink.key(book: book, path: path) }

    public init(book: String, source: String = "", lang: String = "", title: String, path: String, snippet: String = "", kind: String = "text", words: Int? = nil) {
        self.book = book; self.source = source; self.lang = lang; self.title = title; self.path = path
        self.snippet = snippet; self.kind = kind; self.words = words
    }

    enum CodingKeys: String, CodingKey { case book, source, lang, title, path, snippet, kind, words }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        book = try c.decode(String.self, forKey: .book)
        path = try c.decode(String.self, forKey: .path)
        source = c.referenceString(.source)
        lang = c.referenceString(.lang)
        let t = c.referenceString(.title)
        title = t.isEmpty ? path : t
        snippet = c.referenceString(.snippet)
        let k = c.referenceString(.kind)
        kind = k.isEmpty ? "text" : k
        words = (try? c.decodeIfPresent(Int.self, forKey: .words)) ?? nil
    }
}

public struct ReferenceSearchPage: Decodable, Equatable, Sendable {
    public var q: String
    public var results: [ReferenceSearchResult]
    public var total: Int
    public var took_ms: Int
    /// A book was left out because it took too long.
    public var partial: Bool

    enum CodingKeys: String, CodingKey { case q, results, total, took_ms, partial }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        q = c.referenceString(.q)
        results = (try? c.decodeIfPresent(LossyList<ReferenceSearchResult>.self, forKey: .results))?.items ?? []
        total = max(Int(c.referenceInt64(.total)), results.count)
        took_ms = Int(c.referenceInt64(.took_ms))
        partial = c.referenceBool(.partial) ?? false
    }
}

// MARK: Reading

/// An h2 or h3 of a page, with the id its heading has.
public struct ReferenceTocEntry: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var level: Int
    public var id: String
    public var text: String

    public init(level: Int, id: String, text: String) { self.level = level; self.id = id; self.text = text }

    enum CodingKeys: String, CodingKey { case level, id, text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        level = Int(c.referenceInt64(.level, or: 2))
        let t = c.referenceString(.text)
        text = t.isEmpty ? id : t
    }
}

/// `GET /reference/article`: the body sanitized on the hub (no scripts, styles or outside addresses), every heading
/// with an id, links inside the book as `#/reference/<book>/<path>`, pictures as `data-media` without `src`.
public struct ReferenceArticle: Codable, Equatable, Sendable {
    public var book: String
    public var source: String
    public var lang: String
    public var title: String
    public var path: String
    public var html: String
    public var toc: [ReferenceTocEntry]
    public var date: String
    /// The page on its original site, when the source has one.
    public var url: String?
    public var license: String

    public init(book: String, source: String = "", lang: String = "", title: String, path: String, html: String = "",
                toc: [ReferenceTocEntry] = [], date: String = "", url: String? = nil, license: String = "") {
        self.book = book; self.source = source; self.lang = lang; self.title = title; self.path = path; self.html = html
        self.toc = toc; self.date = date; self.url = url; self.license = license
    }

    enum CodingKeys: String, CodingKey { case book, source, lang, title, path, html, toc, date, url, license }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        book = try c.decode(String.self, forKey: .book)
        path = try c.decode(String.self, forKey: .path)
        source = c.referenceString(.source)
        lang = c.referenceString(.lang)
        let t = c.referenceString(.title)
        title = t.isEmpty ? path : t
        html = c.referenceString(.html)
        toc = (try? c.decodeIfPresent(LossyList<ReferenceTocEntry>.self, forKey: .toc))?.items ?? []
        date = c.referenceString(.date)
        let u = (try? c.decodeIfPresent(String.self, forKey: .url)) ?? nil
        url = (u?.isEmpty ?? true) ? nil : u
        license = c.referenceString(.license)
    }
}

/// `GET /reference/summary`: the first paragraph as plain text and its first picture, for link previews.
public struct ReferenceSummary: Codable, Equatable, Sendable {
    public var title: String
    public var text: String
    public var media: String?

    public init(title: String, text: String, media: String? = nil) { self.title = title; self.text = text; self.media = media }

    enum CodingKeys: String, CodingKey { case title, text, media }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = c.referenceString(.title)
        text = c.referenceString(.text)
        let m = (try? c.decodeIfPresent(String.self, forKey: .media)) ?? nil
        media = (m?.isEmpty ?? true) ? nil : m
    }
}

/// `GET /reference/random`.
public struct ReferenceRandomPage: Codable, Equatable, Hashable, Sendable {
    public var book: String
    public var path: String
    public var title: String

    public init(book: String, path: String, title: String) { self.book = book; self.path = path; self.title = title }

    enum CodingKeys: String, CodingKey { case book, path, title }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        book = try c.decode(String.self, forKey: .book)
        path = try c.decode(String.self, forKey: .path)
        let t = c.referenceString(.title)
        title = t.isEmpty ? path : t
    }
}

// MARK: Hub routes

private struct ReferenceEmpty: Codable {}

extension HubClient {
    public func referenceSources() async throws -> ReferenceSources { try await get("reference/sources", as: ReferenceSources.self) }

    public func referenceSettings() async throws -> ReferenceSettingsAnswer { try await get("reference/settings", as: ReferenceSettingsAnswer.self) }

    /// Send only what changed; the hub answers with every choice and the plan.
    public func setReferenceSettings(_ change: ReferenceSettingsChange) async throws -> ReferenceSettingsAnswer {
        try await post("reference/settings", change, as: ReferenceSettingsAnswer.self, method: "PUT")
    }

    public func referenceStatus() async throws -> ReferenceStatus { try await get("reference/status", as: ReferenceStatus.self) }

    public func pauseReferenceDownloads() async throws { _ = try await send("POST", "reference/pause", body: try JSONCoding.data(ReferenceEmpty())) }

    public func resumeReferenceDownloads() async throws { _ = try await send("POST", "reference/resume", body: try JSONCoding.data(ReferenceEmpty())) }

    /// Read the catalog now and queue what is missing or newer.
    public func checkReferenceNow() async throws { _ = try await send("POST", "reference/check", body: try JSONCoding.data(ReferenceEmpty())) }

    /// The book's file goes, and it is not wanted again until chosen again.
    public func removeReferenceBook(_ name: String) async throws { _ = try await send("DELETE", "reference/books/\(name)") }

    /// Titles only, for as-you-type.
    public func referenceSuggest(_ q: String, limit: Int = 8) async throws -> ReferenceSuggestions {
        try await get("reference/suggest", query: ["q": q, "limit": String(limit)], as: ReferenceSuggestions.self)
    }

    /// Titles first, then full text, across every ready book. `sources` and `langs` narrow it (empty: all).
    public func referenceSearch(_ q: String, sources: [String] = [], langs: [String] = [], limit: Int = 20, offset: Int = 0) async throws -> ReferenceSearchPage {
        try await get("reference/search", query: [
            "q": q, "sources": Self.referenceList(sources), "langs": Self.referenceList(langs),
            "limit": String(limit), "offset": String(offset),
        ], as: ReferenceSearchPage.self)
    }

    public func referenceArticle(book: String, path: String) async throws -> ReferenceArticle {
        try await get("reference/article", query: ["book": book, "path": path], as: ReferenceArticle.self)
    }

    public func referenceSummary(book: String, path: String) async throws -> ReferenceSummary {
        try await get("reference/summary", query: ["book": book, "path": path], as: ReferenceSummary.self)
    }

    /// A picture of a page, read with this device's key.
    public func referenceMedia(book: String, path: String) async throws -> Data {
        try await send("GET", "reference/media", query: ["book": book, "path": path])
    }

    public func referenceRandom(sources: [String] = [], langs: [String] = []) async throws -> ReferenceRandomPage {
        try await get("reference/random", query: ["sources": Self.referenceList(sources), "langs": Self.referenceList(langs)], as: ReferenceRandomPage.self)
    }

    /// A list for a query: comma separated, left out when empty.
    static func referenceList(_ ids: [String]) -> String? {
        let clean = ids.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return clean.isEmpty ? nil : clean.joined(separator: ",")
    }
}

// MARK: Pure helpers

/// Links between pages: `#/reference/<book>/<path, URL-encoded>`, alone or at the end of an address.
public enum ReferenceLink {
    /// One key per page, for recents, reading positions and pictures.
    public static func key(book: String, path: String) -> String { "\(book)/\(path)" }

    /// The book and the path a link names, nil for any other link.
    public static func parse(_ href: String) -> (book: String, path: String)? {
        guard let hash = href.range(of: "#/reference/") else { return nil }
        let rest = href[hash.upperBound...]
        guard let slash = rest.firstIndex(of: "/") else { return nil }
        let book = String(rest[..<slash]).removingPercentEncoding ?? String(rest[..<slash])
        let raw = String(rest[rest.index(after: slash)...])
        let path = raw.removingPercentEncoding ?? raw
        guard !book.isEmpty, !path.isEmpty else { return nil }
        return (book, path)
    }

    /// `<book>/<path>` as typed (a launch argument): split at the first slash.
    public static func split(_ s: String) -> (book: String, path: String)? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let slash = t.firstIndex(of: "/") else { return nil }
        let book = String(t[..<slash]), path = String(t[t.index(after: slash)...])
        return book.isEmpty || path.isEmpty ? nil : (book, path)
    }
}

/// Words for people: snippets, citations, the Ask prefill, archive dates, sizes and download progress.
public enum ReferenceText {
    /// A search snippet with only `<b>` as bold. Every other tag goes (its text stays), entities are decoded, runs of
    /// white space become one space, and a tag or entity cut off at the end is dropped. Bold runs carry
    /// `inlinePresentationIntent` `.stronglyEmphasized`, which SwiftUI's Text shows as bold.
    public static func snippet(_ html: String) -> AttributedString {
        var parts: [(text: String, bold: Bool)] = []
        var bold = false
        var text = ""
        func flush(atEnd: Bool = false) {
            if !text.isEmpty { parts.append((decodeEntities(atEnd ? dropCutEntity(text) : text), bold)) }
            text = ""
        }
        var i = html.startIndex
        while i < html.endIndex {
            let ch = html[i]
            guard ch == "<" else { text.append(ch); i = html.index(after: i); continue }
            // A tag cut off at the end of the snippet: it and anything after it go.
            guard let close = html[i...].firstIndex(of: ">") else { break }
            let inside = html[html.index(after: i)..<close].trimmingCharacters(in: .whitespaces).lowercased()
            let closing = inside.hasPrefix("/")
            let name = String((closing ? inside.dropFirst() : Substring(inside)).prefix { $0.isLetter || $0.isNumber })
            switch name {
            case "b", "strong": flush(); bold = !closing
            case "br", "p", "div", "li": text.append(" ")
            default: break
            }
            i = html.index(after: close)
        }
        flush(atEnd: true)

        // One space for any run of white space, none at either end.
        var runs: [(text: String, bold: Bool)] = []
        var lastWasSpace = true
        for p in parts {
            var s = ""
            for ch in p.text {
                if ch.isWhitespace {
                    if !lastWasSpace { s.append(" "); lastWasSpace = true }
                } else {
                    s.append(ch)
                    lastWasSpace = false
                }
            }
            if !s.isEmpty { runs.append((s, p.bold)) }
        }
        while let last = runs.last, last.text.hasSuffix(" ") {
            runs[runs.count - 1].text.removeLast()
            if runs[runs.count - 1].text.isEmpty { runs.removeLast() }
        }
        var out = AttributedString()
        for r in runs {
            var a = AttributedString(r.text)
            if r.bold { a.inlinePresentationIntent = .stronglyEmphasized }
            out += a
        }
        return out
    }

    /// The snippet as plain text (accessibility, copy).
    public static func plainSnippet(_ html: String) -> String { String(snippet(html).characters) }

    /// `<title>. <source title>, offline copy of <archive date>.` and ` <url>` when the page has an original address.
    /// A title that already ends a sentence gets no second period.
    public static func citation(title: String, sourceTitle: String, date: String, url: String?) -> String {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = t.last.map { ".?!".contains($0) } ?? false
        var s = "\(t)\(end ? "" : ".") \(sourceTitle), offline copy of \(archiveDate(date))."
        if let u = url?.trimmingCharacters(in: .whitespacesAndNewlines), !u.isEmpty { s += " \(u)" }
        return s
    }

    /// What Ask about this page puts in the Assistant's box, ready for the question.
    public static func askPrefill(title: String, sourceTitle: String, book: String, path: String) -> String {
        "Ask about \"\(title)\" (\(sourceTitle), reference \(book)/\(path)): "
    }

    /// An archive date for people, in English: `2025-10-04` is `October 4, 2025`, `2025-10` is `October 2025`.
    /// Anything else stays as given.
    public static func archiveDate(_ raw: String) -> String {
        let s = raw.trimmingCharacters(in: .whitespaces)
        if let d = day(s) { return longDay.string(from: d) }
        if let d = month(s) { return longMonth.string(from: d) }
        return s
    }

    /// The month of an archive, short, in the person's own way of writing dates (`Oct 2025`).
    public static func shortArchiveDate(_ raw: String, locale: Locale = .current) -> String {
        let s = raw.trimmingCharacters(in: .whitespaces)
        guard let d = day(s) ?? month(s) else { return s }
        return d.formatted(Date.FormatStyle(locale: locale, timeZone: utc).month(.abbreviated).year())
    }

    /// A size on disk (`12.4 GB`).
    public static func size(_ bytes: Int64) -> String { ByteCountFormatter.string(fromByteCount: max(0, bytes), countStyle: .file) }

    /// A download speed from bits a second, in megabits a second as the cap is set (`8.4 Mbps`, `120 Mbps`).
    public static func speed(_ bitsPerSecond: Double) -> String {
        let mbps = max(0, bitsPerSecond.isFinite ? bitsPerSecond : 0) / 1_000_000
        return mbps >= 100 ? "\(Int(mbps.rounded())) Mbps" : String(format: "%.1f Mbps", mbps)
    }

    /// How long a download still takes, said roughly; nil when the hub does not know.
    public static func timeLeft(_ seconds: Double?) -> String? {
        guard let s = seconds, s.isFinite, s > 0 else { return nil }
        if s < 60 { return "under a minute left" }
        let minutes = Int((s / 60).rounded())
        if minutes < 60 { return "about \(minutes) min left" }
        let hours = minutes / 60, rest = minutes % 60
        if hours >= 48 { return "about \(Int((Double(hours) / 24).rounded())) days left" }
        return rest == 0 ? "about \(hours) h left" : "about \(hours) h \(rest) min left"
    }

    /// One line under a download: how far it is, or why it waits.
    public static func progress(_ d: ReferenceDownload) -> String {
        let amount = d.bytes > 0 ? "\(size(d.done_bytes)) of \(size(d.bytes))" : size(d.done_bytes)
        switch d.state {
        case "downloading":
            var parts = [amount]
            if d.speed_bps > 0 { parts.append(speed(d.speed_bps)) }
            if let left = timeLeft(d.eta_s) { parts.append(left) }
            return parts.joined(separator: ", ")
        case "queued": return d.done_bytes > 0 ? "Waiting its turn, \(amount) in" : "Waiting its turn"
        case "verifying": return "Checking the file"
        case "paused": return d.done_bytes > 0 ? "Paused at \(amount)" : "Paused"
        case "waiting": return waiting(d.reason)
        case "failed":
            let e = (d.error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return e.isEmpty ? "Did not download. It tries again at the next check." : "Did not download: \(e)"
        default: return d.state.capitalized
        }
    }

    /// Why a download waits.
    public static func waiting(_ reason: String?) -> String {
        switch reason {
        case "night": return "Waits for the night, 01:00 to 07:00 on the hub"
        case "game": return "Waits while a game is running on the hub"
        case "disk": return "Waits for room on the hub's disk"
        case "offline": return "No download server answers. It tries again later."
        case "module": return "Waits while Reference is off"
        default: return "Waiting"
        }
    }

    /// `maxi`, `nopic`, `mini` and the only kind, in words.
    public static func flavour(_ f: String) -> String? {
        switch f {
        case "maxi": return "with pictures"
        case "nopic": return "text only"
        case "mini": return "intros only"
        default: return nil
        }
    }

    // MARK: inside

    private static let utc = TimeZone(identifier: "UTC") ?? TimeZone(secondsFromGMT: 0)!
    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = utc
        f.dateFormat = format
        return f
    }
    private static let dayParser = formatter("yyyy-MM-dd")
    private static let monthParser = formatter("yyyy-MM")
    private static let longDay = formatter("MMMM d, yyyy")
    private static let longMonth = formatter("MMMM yyyy")

    private static func day(_ s: String) -> Date? {
        guard s.count >= 10 else { return nil }
        let head = String(s.prefix(10))
        guard head.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return nil }
        return dayParser.date(from: head)
    }

    private static func month(_ s: String) -> Date? {
        guard s.range(of: #"^\d{4}-\d{2}$"#, options: .regularExpression) != nil else { return nil }
        return monthParser.date(from: s)
    }

    /// `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&#39;`, `&nbsp;` and numeric entities; anything else as written.
    static func decodeEntities(_ s: String) -> String {
        guard s.contains("&") else { return s }
        var out = ""
        var i = s.startIndex
        while i < s.endIndex {
            if s[i] == "&", let semi = s[i...].prefix(12).firstIndex(of: ";") {
                let name = String(s[s.index(after: i)..<semi])
                if let ch = entity(name) {
                    out.append(ch)
                    i = s.index(after: semi)
                    continue
                }
            }
            out.append(s[i])
            i = s.index(after: i)
        }
        return out
    }

    private static func entity(_ name: String) -> Character? {
        switch name {
        case "amp": return "&"
        case "lt": return "<"
        case "gt": return ">"
        case "quot": return "\""
        case "apos": return "'"
        case "nbsp": return " "
        default:
            guard name.hasPrefix("#") else { return nil }
            let digits = name.dropFirst()
            let value: UInt32?
            if digits.first == "x" || digits.first == "X" { value = UInt32(digits.dropFirst(), radix: 16) } else { value = UInt32(digits) }
            return value.flatMap(Unicode.Scalar.init).map(Character.init)
        }
    }

    /// An entity cut off at the very end (`... &am`) goes.
    private static func dropCutEntity(_ s: String) -> String {
        guard let amp = s.lastIndex(of: "&") else { return s }
        let tail = s[s.index(after: amp)...]
        guard !tail.contains(";"), tail.count <= 10, tail.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "#" }) else { return s }
        return String(s[..<amp])
    }
}

/// The book a source is wanted as, as the hub picks it (contract, Choices), so Settings can show the size of each
/// source for the current choices before the hub's plan comes back.
public enum ReferencePlanner {
    /// The source whose size the Wikipedia choice (intros or full text) changes.
    public static let wikipedia = "wikipedia"

    public struct Wanted: Equatable, Sendable {
        public var language: ReferenceLanguage
        public var book: ReferenceCatalogBook
    }

    public static func images(for source: ReferenceSource, in s: ReferenceSettings) -> Bool { s.overrides[source.id]?.images ?? s.images }

    public static func languages(for source: ReferenceSource, in s: ReferenceSettings) -> [String] { s.overrides[source.id]?.languages ?? s.languages }

    /// One book for one language: `mini` for Wikipedia intros, `maxi` when pictures are on for it and it exists,
    /// else `nopic`, else the only kind, or the smaller of the kinds left (mdwiki's pictures and its larger one with
    /// videos), as the hub picks (hub/src/reference/plan.ts, pickFlavour). Of two of a kind, the newer.
    public static func book(in language: ReferenceLanguage, of source: ReferenceSource, settings s: ReferenceSettings) -> ReferenceCatalogBook? {
        let books = language.books
        guard !books.isEmpty else { return nil }
        func newest(_ list: [ReferenceCatalogBook]) -> ReferenceCatalogBook? { list.max { $0.date < $1.date } }
        func kind(_ f: String) -> ReferenceCatalogBook? { newest(books.filter { $0.flavour == f }) }
        if source.id == wikipedia, s.wikipedia == "intros", let m = kind("mini") { return m }
        if images(for: source, in: s), let m = kind("maxi") { return m }
        if let n = kind("nopic") { return n }
        let rest = Set(books.map(\.flavour)).filter { $0 != "mini" }.compactMap { kind($0) }
        return rest.min { $0.bytes < $1.bytes } ?? newest(books)
    }

    /// The books wanted for a source with these choices, in the source's language order.
    public static func wanted(_ source: ReferenceSource, settings s: ReferenceSettings) -> [Wanted] {
        let langs = Set(languages(for: source, in: s))
        return source.languages.filter { langs.contains($0.code) }.compactMap { l in book(in: l, of: source, settings: s).map { Wanted(language: l, book: $0) } }
    }

    public static func bytes(_ source: ReferenceSource, settings s: ReferenceSettings) -> Int64 {
        wanted(source, settings: s).reduce(0) { $0 + $1.book.bytes }
    }
}

/// Pages read on this device, newest first: at most 30, one entry per page.
public struct ReferenceRecent: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var book: String
    public var path: String
    public var title: String
    public var source: String
    public var lang: String
    public var at: String
    public var id: String { ReferenceLink.key(book: book, path: path) }

    public init(book: String, path: String, title: String, source: String = "", lang: String = "", at: String = "") {
        self.book = book; self.path = path; self.title = title; self.source = source; self.lang = lang; self.at = at
    }
}

public enum ReferenceRecents {
    public static let limit = 30

    /// The page goes first; an earlier entry for it goes, and the list keeps the 30 newest.
    public static func adding(_ page: ReferenceRecent, to list: [ReferenceRecent], limit: Int = ReferenceRecents.limit) -> [ReferenceRecent] {
        var out = list.filter { $0.id != page.id }
        out.insert(page, at: 0)
        return Array(out.prefix(max(0, limit)))
    }
}

/// Where a page was left: the last heading above the top of the screen and how far past it, and the share of the
/// page scrolled, for when the heading is gone.
public struct ReferencePosition: Codable, Equatable, Sendable {
    public var fraction: Double
    public var anchor: String
    public var offset: Double
    /// Seconds since 1970, to drop the oldest first.
    public var at: Double

    public init(fraction: Double, anchor: String = "", offset: Double = 0, at: Double = Date().timeIntervalSince1970) {
        self.fraction = min(1, max(0, fraction.isFinite ? fraction : 0)); self.anchor = anchor
        self.offset = offset.isFinite ? offset : 0; self.at = at
    }
}

public enum ReferencePositions {
    public static let limit = 300

    /// The map with this page's position set, keeping at most `limit` pages (the oldest go first).
    public static func setting(_ p: ReferencePosition, for key: String, in map: [String: ReferencePosition], limit: Int = ReferencePositions.limit) -> [String: ReferencePosition] {
        var m = map
        m[key] = p
        guard m.count > limit else { return m }
        let extra = m.count - max(1, limit)
        for (k, _) in m.filter({ $0.key != key }).sorted(by: { $0.value.at < $1.value.at }).prefix(extra) { m.removeValue(forKey: k) }
        return m
    }
}

/// Pictures a page shows. The hub sends only PNG, JPEG, GIF, WebP and SVG; the type is read from the bytes, since
/// a transport may not carry headers, and anything else is refused.
public enum ReferenceMedia {
    public static func mimeType(_ data: Data) -> String? {
        let b = [UInt8](data.prefix(16))
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
        if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if b.starts(with: Array("GIF87a".utf8)) || b.starts(with: Array("GIF89a".utf8)) { return "image/gif" }
        if b.count >= 12, b.starts(with: Array("RIFF".utf8)), Array(b[8..<12]) == Array("WEBP".utf8) { return "image/webp" }
        // SVG is text: an XML declaration, a comment or a doctype may come first.
        let head = String(decoding: data.prefix(1024), as: UTF8.self).lowercased()
        let trimmed = head.drop { $0.isWhitespace || $0 == "\u{FEFF}" }
        if trimmed.hasPrefix("<"), head.contains("<svg") { return "image/svg+xml" }
        return nil
    }
}

// MARK: lenient fields

extension KeyedDecodingContainer {
    /// A string, or "" when it is missing, null or not a string.
    func referenceString(_ key: Key) -> String { ((try? decodeIfPresent(String.self, forKey: key)) ?? nil) ?? "" }

    func referenceBool(_ key: Key) -> Bool? { (try? decodeIfPresent(Bool.self, forKey: key)) ?? nil }

    /// A whole number sent as an integer or as a number with a fraction.
    func referenceInt64(_ key: Key, or fallback: Int64 = 0) -> Int64 {
        if let v = (try? decodeIfPresent(Int64.self, forKey: key)) ?? nil { return v }
        if let d = (try? decodeIfPresent(Double.self, forKey: key)) ?? nil, d.isFinite, abs(d) < 9.2e18 { return Int64(d) }
        return fallback
    }

    func referenceDouble(_ key: Key) -> Double? {
        guard let d = (try? decodeIfPresent(Double.self, forKey: key)) ?? nil, d.isFinite else { return nil }
        return d
    }
}
