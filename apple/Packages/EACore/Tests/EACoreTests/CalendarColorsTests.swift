import XCTest
@testable import EACore

/// Calendar colors (Theme, Calendar colors) and theme status colors, with the same rules as packages/shared and
/// web/src/feel/appTheme.ts.
final class CalendarColorsTests: XCTestCase {
    private let cals = [
        CalendarColorEntry(key: "apple:iCloud/Home", name: "Home", account: "iCloud", color: "#1BADF8"),
        CalendarColorEntry(key: "icloud:https://x/gym/", name: "Gym", color: "#FF2968", chosen: "#00AA55"),
        CalendarColorEntry(key: "apple:iCloud/Plain", name: "Plain"),
    ]

    // MARK: which calendar, which color

    func testAnEventsCalendarIsWhatBroughtItInElseItsLinks() {
        XCTAssertEqual(EventCalendar.key(["calendar_key": "apple:iCloud/Home", "caldav": .object(["calendar": "https://x/gym/"])]), "apple:iCloud/Home")
        XCTAssertEqual(EventCalendar.key(["caldav": .object(["account": "a", "calendar": "https://x/gym/", "uid": "u"])]), "icloud:https://x/gym/")
        XCTAssertEqual(EventCalendar.key(["apple": .object(["id": "X", "calendar": "Family"])]), "apple:Family", "an older app named only the calendar")
        XCTAssertEqual(EventCalendar.key(["source": "m365", "title": "Standup"]), "work:m365")
        XCTAssertNil(EventCalendar.key(["title": "made here"]), "made in the app on no calendar: the theme's accent")
        XCTAssertNil(EventCalendar.key(["calendar_key": "", "apple": .object(["id": "X"])]))
    }

    func testTheOwnersChoiceWinsThenTheCalendarsOwnColor() {
        XCTAssertEqual(EventCalendar.color(of: Entity(kind: .event, fields: ["calendar_key": "apple:iCloud/Home"]), calendars: cals), "#1BADF8")
        XCTAssertEqual(EventCalendar.color(of: Entity(kind: .event, fields: ["caldav": .object(["calendar": "https://x/gym/"])]), calendars: cals), "#00AA55")
        XCTAssertNil(EventCalendar.color(of: Entity(kind: .event, fields: ["calendar_key": "apple:iCloud/Plain"]), calendars: cals), "a calendar with no color")
        XCTAssertNil(EventCalendar.color(of: Entity(kind: .event, fields: ["calendar_key": "apple:iCloud/Gone"]), calendars: cals))
        XCTAssertNil(EventCalendar.color(of: Entity(kind: .event, fields: ["title": "made here"]), calendars: cals))
    }

    func testAppleKeysNameTheAccountAndTheCalendar() {
        XCTAssertEqual(EventCalendar.appleKey(account: "iCloud", calendar: "Home"), "apple:iCloud/Home")
        XCTAssertNil(EventCalendar.appleKey(account: "iCloud", calendar: "  "), "a calendar with no title has no key")
        XCTAssertNil(EventCalendar.appleKey(account: "iCloud", calendar: String(repeating: "a", count: 300)), "longer than the hub keeps")
        XCTAssertEqual(CalendarInfo(id: "c", title: "Home", sourceTitle: "iCloud", isExchange: false, color: "#1BADF8").report,
                       CalendarReportItem(key: "apple:iCloud/Home", name: "Home", account: "iCloud", color: "#1BADF8"))
    }

    // MARK: the feel setting

    func testTheFeelSettingCarriesCalendarsAndThemeStatusColors() throws {
        let json = #"""
        {"app_theme":"custom:cave","app_themes":[
          {"id":"cave","name":"Cave","mode":"dark","accent":"#33ccaa","background":"#101010","surface":"#1A1A1A","text":"#EEEEEE","ok":"#00ff00","warn":"not a color"},
          {"id":"plain","name":"Plain","mode":"light","accent":"#0A84FF","background":"#FFFFFF","surface":"#FFFFFF","text":"#111111"}],
         "calendars":[{"key":"apple:iCloud/Home","name":"Home","account":"iCloud","color":"#1badf8","chosen":"#00aa55","seen_at":"2026-11-20T10:00:00.000Z"},
                      {"key":"","name":"Broken"},{"key":"apple:iCloud/Home","name":"Again"},{"key":"apple:Gmail/Friends","name":"Friends","color":"bad"}]}
        """#
        let f = try JSONDecoder().decode(FeelSettings.self, from: Data(json.utf8))
        let cave = try XCTUnwrap(f.activeAppTheme)
        XCTAssertEqual(cave.ok, "#00FF00")
        XCTAssertNil(cave.warn, "a broken status color is dropped alone")
        XCTAssertEqual(cave.status(.warn), StatusPalette.classicDark[.warn], "a status color left out is the classic one for the mode")
        XCTAssertEqual(f.app_themes[1].status(.danger), StatusPalette.classicLight[.danger])
        XCTAssertEqual(f.calendars.map(\.key), ["apple:iCloud/Home", "apple:Gmail/Friends"], "one per key, none without one")
        XCTAssertEqual(f.calendars[0].shown, "#00AA55")
        XCTAssertNil(f.calendars[1].color)
        // A theme without its own status colors goes back to the hub without them, as the hub's schema wants.
        let out = String(data: try JSONEncoder().encode(f.app_themes[1]), encoding: .utf8)!
        XCTAssertFalse(out.contains("ok"), out)
        XCTAssertFalse(out.contains("null"), out)
        // An older cache without calendars still reads.
        XCTAssertEqual(try JSONDecoder().decode(FeelSettings.self, from: Data(#"{"motion":false}"#.utf8)).calendars, [])
    }

    // MARK: status colors

    func testStatusWordsReadOnEveryBuiltInThemeAndOnClassic() {
        var themes = AppTheme.builtIns
        themes.append(AppTheme(id: "cl", name: "Classic light", mode: "light", accent: "#2F5FBF", background: "#F5F4F1", surface: "#FFFFFF", text: "#1B1D22"))
        themes.append(AppTheme(id: "cd", name: "Classic dark", mode: "dark", accent: "#7EA2EA", background: "#17181B", surface: "#1F2126", text: "#E8E6E1"))
        for t in themes {
            let p = StatusPalette(theme: t)
            for tone in StatusTone.allCases {
                let words = p.text[tone]!
                XCTAssertGreaterThanOrEqual(FeelColor.contrast(words, t.background), 4.5, "\(tone) on \(t.name)'s background")
                XCTAssertGreaterThanOrEqual(FeelColor.contrast(words, t.surface), 4.5, "\(tone) on \(t.name)'s cards")
                XCTAssertGreaterThanOrEqual(FeelColor.contrast(p.on[tone]!, p.fill[tone]!), 4.5, "words on a \(tone) fill in \(t.name)")
            }
        }
    }

    func testAThemesOwnStatusColorsStayAsFillsAndReadAsWords() {
        let t = AppTheme(id: "x", name: "X", mode: "light", accent: "#0A84FF", background: "#FFFFFF", surface: "#FFFFFF", text: "#111111", warn: "#FFD60A")
        let p = StatusPalette(theme: t)
        XCTAssertEqual(p.fill[.warn], "#FFD60A")
        XCTAssertEqual(p.fill[.ok], StatusPalette.classicLight[.ok])
        XCTAssertGreaterThanOrEqual(FeelColor.contrast(p.text[.warn]!, "#FFFFFF"), 4.5)
        XCTAssertEqual(FeelColor.readable("#2B7047", text: "#111111", on: ["#FFFFFF"]), "#2B7047", "a color that reads is kept")
        XCTAssertEqual(FeelColor.readable("#FFFFFF", text: "#111111", on: ["#FFFFFF"]), FeelColor.mix("#FFFFFF", "#111111", 0.6), "moved toward the text only as far as needed")
        XCTAssertEqual(t.withStatus(.warn, nil).warn, nil)
        XCTAssertTrue(t.hasOwnStatus(.warn))
        XCTAssertFalse(t.hasOwnStatus(.ok))
    }

    func testWordsOnAnAccentReadOnEveryBuiltInTheme() {
        for t in AppTheme.builtIns {
            let ink = FeelColor.mix(t.background, "#000000", t.isDark ? 0.4 : 0.85)
            XCTAssertGreaterThanOrEqual(FeelColor.contrast(FeelColor.onFill(t.accent, ink: ink), t.accent), 4.5, t.name)
        }
        XCTAssertEqual(FeelColor.onFill("#0A4FBF", ink: "#000000"), "#FFFFFF")
        XCTAssertEqual(FeelColor.mix("#000000", "#FFFFFF", 0.5), "#808080")
    }

    // MARK: telling the hub

    func testCalendarsAreReportedWhenNewOrChangedElseOnceADay() {
        var plan = CalendarReportPlan()
        let t0 = ISO.date("2026-11-20T10:00:00.000Z")!
        let home = CalendarReportItem(key: "apple:iCloud/Home", name: "Home", account: "iCloud", color: "#1badf8")
        let work = CalendarReportItem(key: "apple:Exchange/Calendar", name: "Calendar", account: "Exchange", color: "#FF9500")
        XCTAssertNil(plan.found([], part: "personal", now: t0), "nothing to tell")
        let first = plan.found([home], part: "personal", now: t0)
        XCTAssertEqual(first?.map(\.color), ["#1BADF8"], "colors go as #RRGGBB")
        plan.didSend(first!, now: t0)
        XCTAssertNil(plan.found([home], part: "personal", now: t0.addingTimeInterval(3600)), "the hub knows it")
        // Another part's calendars go with the ones already known, so the list is whole every time.
        let both = plan.found([work], part: "work", now: t0.addingTimeInterval(3600))
        XCTAssertEqual(both?.map(\.key), ["apple:Exchange/Calendar", "apple:iCloud/Home"])
        plan.didSend(both!, now: t0.addingTimeInterval(3600))
        XCTAssertNil(plan.found([home], part: "personal", now: t0.addingTimeInterval(7200)))
        var recolored = home; recolored.color = "#FF2968"
        XCTAssertEqual(plan.found([recolored], part: "personal", now: t0.addingTimeInterval(7200))?.count, 2, "a changed color goes at once")
        plan.didSend(plan.all, now: t0.addingTimeInterval(7200))
        XCTAssertNotNil(plan.found([recolored], part: "personal", now: t0.addingTimeInterval(7200 + 86400)), "and the same list again a day later")
        // One the hub would refuse is left out instead of the whole list being refused.
        XCTAssertEqual(CalendarReportPlan().all, [])
        var p2 = CalendarReportPlan()
        XCTAssertEqual(p2.found([CalendarReportItem(key: "apple:x/ ", name: " "), home], part: "p")?.map(\.key), ["apple:iCloud/Home"])
    }

    // MARK: the importers write calendar_key

    func testImportedEventsCarryTheirCalendarAndOlderOnesGetItOnce() {
        let now = ISO.date("2026-10-26T14:00:00.000Z")!
        let window = CalendarDiff.window(now: now)
        let o = CalendarOccurrence(eventIdentifier: "E1", calendarId: "work", title: "Design review", start: now.addingTimeInterval(3600),
                                   end: now.addingTimeInterval(7200), calendarKey: "apple:Exchange/Calendar")
        let made = CalendarDiff.plan(previous: [:], existing: { _ in nil }, occurrences: [o], selected: ["work"], window: window, now: now, newId: { _ in "id1" })
        XCTAssertEqual(made.patches.first?.fields["calendar_key"], "apple:Exchange/Calendar")

        // Imported before calendar_key existed: the next import adds it, to the same entity.
        var oldFields = o.fields
        oldFields.removeValue(forKey: "calendar_key")
        let old = Entity(id: "id1", kind: .event, space: .work, created_at: ISO.string(now), updated_at: ISO.string(now), deleted_at: nil, fields: oldFields)
        let prev = [o.externalId: ImportedOccurrence(entity_id: "id1", start: ISO.string(o.start), calendar_id: "work", event_id: "E1")]
        let again = CalendarDiff.plan(previous: prev, existing: { $0 == "id1" ? old : nil }, occurrences: [o], selected: ["work"], window: window, now: now)
        XCTAssertEqual(again.inserted, 0)
        XCTAssertEqual(again.patches.map(\.id), ["id1"])
        XCTAssertEqual(again.patches.first?.fields, ["calendar_key": "apple:Exchange/Calendar"])

        // Another device named the account differently: its key stays while the event stays in the calendar.
        var other = old
        other.fields["calendar_key"] = "apple:Work/Calendar"
        XCTAssertTrue(CalendarDiff.plan(previous: prev, existing: { _ in other }, occurrences: [o], selected: ["work"], window: window, now: now).patches.isEmpty)
        // Moved to another calendar on this device: the new calendar's key.
        var moved = o
        moved.calendarId = "work2"
        moved.calendarKey = "apple:Exchange/Team"
        let m = CalendarDiff.plan(previous: prev, existing: { _ in other }, occurrences: [moved], selected: ["work", "work2"], window: window, now: now)
        XCTAssertEqual(m.patches.first?.fields["calendar_key"], "apple:Exchange/Team")
    }

    func testLinkedEventsGetTheKeyOfTheCalendarTheyAreIn() {
        let now = ISO.date("2026-10-30T05:00:00.000Z")!
        func event(_ key: String?) -> Entity {
            var f: [String: JSONValue] = ["title": "Dinner", "start": "2026-10-31T23:00:00.000Z", "end": "2026-11-01T00:00:00.000Z", "all_day": false,
                                          "apple": .object(["id": "X"])]
            if let key { f["calendar_key"] = .string(key) }
            return Entity(id: "e", kind: .event, space: .personal, created_at: "2026-10-30T03:00:00.000Z", updated_at: "2026-10-30T04:00:00.000Z", deleted_at: nil, fields: f)
        }
        let a = AppleEvent(externalId: "X", localId: "L", title: "Dinner", start: "2026-10-31T23:00:00.000Z", end: "2026-11-01T00:00:00.000Z", allDay: false, calendarId: "home-cal")
        let keys = ["home-cal": "apple:iCloud/Home", "family": "apple:iCloud/Family"]
        func plan(_ e: Entity, _ a: EACore.AppleEvent, state: [String: SyncedEvent] = [:]) -> EventMirrorPlan {
            EventMirror.plan(events: [e], apple: ["X": a], state: state, now: now, target: { _ in "" }, calendarKey: { keys[$0] }) { _ in true }
        }
        XCTAssertEqual(plan(event(nil), a).patches.map(\.fields), [["calendar_key": "apple:iCloud/Home"]], "an event linked before keys existed gets one")
        XCTAssertTrue(plan(event("apple:iCloud/Home"), a).patches.isEmpty)
        XCTAssertTrue(plan(event("apple:Other name/Home"), a).patches.isEmpty, "another device's name for the same calendar stays")
        // Moved to Family in Apple Calendar, which this device saw: the new calendar's key.
        var fam = a; fam.calendarId = "family"
        let seen = ["e": SyncedEvent(appleId: "X", fields: EventMirror.fields(of: a), calendarId: "home-cal")]
        XCTAssertEqual(plan(event("apple:iCloud/Home"), fam, state: seen).patches.map(\.fields), [["calendar_key": "apple:iCloud/Family"]])

        // Events brought in from the personal calendar carry its key.
        let adopted = EventMirror.adopt(found: [AppleEvent(externalId: "N", localId: "LN", title: "Lunch", start: "2026-11-02T17:00:00.000Z", end: "2026-11-02T18:00:00.000Z", allDay: false)],
                                        calendarTitle: "Home", calendarKey: "apple:iCloud/Home", events: [], now: now)
        XCTAssertEqual(adopted.first?.patch.fields["calendar_key"], "apple:iCloud/Home")
    }
}
