import Foundation

/// A calendar's color as the hub keeps it (the feel setting's `calendars`, since 2026-11-20): `color` is the one it has
/// where it lives, as an app that reads Apple Calendar or the hub's iCloud sync last reported it; `chosen` is the
/// owner's (Theme, Calendar colors), which wins. `key` is what events name (`EventCalendar.key`).
public struct CalendarColorEntry: Codable, Equatable, Sendable, Identifiable, Hashable {
    public static let maxCount = 200
    public var key: String
    public var name: String
    public var account: String?
    public var color: String?
    public var chosen: String?
    public var seen_at: String?

    public var id: String { key }

    public init(key: String, name: String, account: String? = nil, color: String? = nil, chosen: String? = nil, seen_at: String? = nil) {
        self.key = key; self.name = name; self.account = account; self.color = color; self.chosen = chosen; self.seen_at = seen_at
    }

    /// The color events on it are drawn in: the owner's choice, else its own.
    public var shown: String? { chosen ?? color }

    /// A key and a name, and only colors that are `#rrggbb`; nil when nothing usable is left.
    var cleaned: CalendarColorEntry? {
        guard !key.isEmpty, key.count <= 300 else { return nil }
        func hex(_ h: String?) -> String? { h.flatMap { FeelTheme.rgb($0) == nil ? nil : $0.uppercased() } }
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return CalendarColorEntry(key: key, name: n.isEmpty ? key : String(n.prefix(120)), account: account, color: hex(color),
                                  chosen: hex(chosen), seen_at: seen_at)
    }
}

/// Which calendar an event is on and the color it is drawn in, with the same rules as `eventCalendarKey` and
/// `calendarColor` in packages/shared.
public enum EventCalendar {
    /// The calendar an event is on, the key its color is kept under: what the app that brought it in wrote
    /// (`calendar_key`), else the iCloud calendar the hub keeps it in step with, else the Apple calendar an older app
    /// named, else the work calendar for Microsoft 365 events. Nil: made in the app and on no calendar (drawn in the
    /// theme's accent).
    public static func key(_ f: [String: JSONValue]) -> String? {
        if let k = f["calendar_key"]?.stringValue, !k.isEmpty { return k }
        if case .object(let c)? = f["caldav"], let cal = c["calendar"]?.stringValue, !cal.isEmpty { return "icloud:\(cal)" }
        if case .object(let a)? = f["apple"], let cal = a["calendar"]?.stringValue, !cal.isEmpty { return "apple:\(cal)" }
        if f["source"]?.stringValue == "m365" { return "work:m365" }
        return nil
    }

    public static func key(_ e: Entity) -> String? { key(e.fields) }

    /// A calendar's color: the owner's choice, else the calendar's own color. Nil for no calendar or one with neither.
    public static func color(_ key: String?, calendars: [CalendarColorEntry]) -> String? {
        guard let key else { return nil }
        return calendars.first { $0.key == key }?.shown
    }

    /// An event's color, or nil for the theme's accent.
    public static func color(of e: Entity, calendars: [CalendarColorEntry]) -> String? { color(key(e), calendars: calendars) }

    /// The key an Apple Calendar calendar's events carry: `apple:<account>/<calendar>`, where the account is the
    /// calendar's source (iCloud, an Exchange address, On My iPhone) and the calendar its title. Nil for a calendar
    /// with no title, or a key longer than the hub keeps (300), which would make it refuse the event.
    public static func appleKey(account: String, calendar: String) -> String? {
        guard !calendar.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let k = "apple:\(account)/\(calendar)"
        return k.count <= 300 ? k : nil
    }
}

/// One calendar an app brings events from, as `PUT /prefs/feel/calendars` takes it.
public struct CalendarReportItem: Codable, Equatable, Sendable, Hashable {
    public var key: String
    public var name: String
    public var account: String?
    public var color: String?

    public init(key: String, name: String, account: String? = nil, color: String? = nil) {
        self.key = key; self.name = name; self.account = account; self.color = color
    }

    /// Within what the hub takes (a key of at most 300 characters, a name of 1 to 120, an account of at most 120, a
    /// `#RRGGBB` color): one it would refuse would make it refuse the whole list. Nil for one without a name.
    var cleaned: CalendarReportItem? {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, key.count <= 300, !n.isEmpty else { return nil }
        let a = account.map { String($0.prefix(120)) }.flatMap { $0.isEmpty ? nil : $0 }
        return CalendarReportItem(key: key, name: String(n.prefix(120)), account: a, color: color.flatMap { FeelTheme.rgb($0) == nil ? nil : $0.uppercased() })
    }
}

/// When the Apple apps tell the hub which calendars they bring events from: when one is new or changed (a name, a
/// color), else at most once a day, so the hub's `seen_at` stays fresh without a request on every run. Each part of
/// the app (the work import, the personal calendar copy) keeps its own list, and the hub hears all of them together.
public struct CalendarReportPlan: Codable, Equatable, Sendable {
    /// What each part of the app last found, by part.
    public var parts: [String: [CalendarReportItem]] = [:]
    /// What the hub was last told, and when.
    public var sent: [CalendarReportItem] = []
    public var sentAt: Date?

    public static let interval: TimeInterval = 86400
    /// The hub takes up to 100 a call.
    public static let maxPerCall = 100

    public init() {}

    /// Every part's calendars together, one per key, in key order.
    public var all: [CalendarReportItem] {
        var byKey: [String: CalendarReportItem] = [:]
        for k in parts.keys.sorted() { for c in parts[k] ?? [] { byKey[c.key] = c } }
        return byKey.keys.sorted().compactMap { byKey[$0] }
    }

    /// Record what one part found now. Returns the list to send, or nil when the hub already knows it and was told
    /// within the day. An empty list is never sent.
    public mutating func found(_ items: [CalendarReportItem], part: String, now: Date = Date()) -> [CalendarReportItem]? {
        parts[part] = items.compactMap(\.cleaned)
        let list = all
        guard !list.isEmpty else { return nil }
        if list == sent, let at = sentAt, now.timeIntervalSince(at) < Self.interval { return nil }
        return list
    }

    /// The hub took the list.
    public mutating func didSend(_ items: [CalendarReportItem], now: Date = Date()) {
        sent = items
        sentAt = now
    }
}
