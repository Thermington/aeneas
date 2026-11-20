import XCTest
@testable import EACore

/// A machine's History, as web/src/lib/history.test.ts checks it on the web.
final class TechHistoryTests: XCTestCase {
    private func ent(_ id: String, _ kind: Kind, _ fields: [String: JSONValue], updated: String = "") -> Entity {
        Entity(id: id, kind: kind, created_at: "", updated_at: updated, fields: fields)
    }
    private func s(_ v: String) -> JSONValue { .string(v) }

    private var journal: [Entity] {
        [ent("j1", .journal, ["host": s("desk-pc"), "at": s("2026-11-19T10:00:00Z"), "what": s("Replaced the case fan"), "risk": s("low"), "outcome": s("done")]),
         ent("j2", .journal, ["host": s("desk-pc"), "at": s("2026-11-19T11:00:00Z"), "what": s("Restart ollama"), "command": s("Restart-Service ollama"),
                              "rollback": s("none needed"), "risk": s("medium"), "outcome": s("done"), "session_id": s("s1")]),
         ent("j3", .journal, ["host": s("desk-pc"), "at": s("2026-11-19T12:00:00Z"), "what": s("Count words in the notes"), "command": s("wc -w"),
                              "risk": s("low"), "outcome": s("done"), "session_id": s("s2"), "lookup": .bool(true)]),
         ent("j4", .journal, ["host": s("desk-pc"), "at": s("2026-11-19T13:00:00Z"), "what": s("Disk P: went above 90%: 91.2%"), "risk": s("low"),
                              "outcome": s("done"), "source": s("hub")]),
         ent("j5", .journal, ["host": s("desk-pc"), "at": s("2026-11-03T18:00:00Z"), "what": s("rm -rf /mnt/b/old"), "command": s("rm -rf /mnt/b/old"),
                              "risk": s("high"), "outcome": s("planned")]),
         ent("j6", .journal, ["host": s("server"), "at": s("2026-11-19T14:00:00Z"), "what": s("Upgrade packages"), "command": s("apt-get -y upgrade"),
                              "risk": s("medium"), "outcome": s("failed"), "session_id": s("s3")])]
    }
    private var incidents: [Entity] {
        [ent("i1", .incident, ["monitor_id": s("m1"), "name": s("Ollama"), "opened_at": s("2026-11-19T09:00:00Z"), "closed_at": s("2026-11-19T09:37:00Z"),
                               "last_error": s("refused the connection on port 11434")]),
         ent("i2", .incident, ["monitor_id": s("m1"), "name": s("Ollama"), "opened_at": s("2026-11-18T09:00:00Z"), "closed_at": s("2026-11-18T09:01:00Z"),
                               "merged_into": s("i9")])]
    }
    private var runbooks: [Entity] { [ent("r1", .runbook, ["host": s("desk-pc"), "title": s("Fix notes: desk-pc")], updated: "2026-11-19T15:00:00Z")] }
    private let hostOf: (String) -> String? = { $0 == "m1" ? "desk-pc" : nil }

    func testPutsAMachinesChangesAlertsOutagesAndFixNotesTogetherNewestFirstWithoutLookupsOrPlannedSteps() {
        let items = TechHistory.items(journal: journal, incidents: incidents, runbooks: runbooks, hostOf: hostOf, host: "desk-pc")
        XCTAssertEqual(items.map(\.kind), [.notes, .event, .change, .change, .back, .down])
        XCTAssertEqual(items.map(\.text), ["Fix notes updated", "Disk P: went above 90%: 91.2%", "Restart ollama", "Replaced the case fan",
                                           "Ollama came back after 37m 0s", "Ollama went down"])
        XCTAssertEqual(items.map(\.by), [nil, .hub, .assistant, .you, .hub, .hub])
        let restart = items.first { $0.text == "Restart ollama" }
        XCTAssertEqual(restart?.command, "Restart-Service ollama")
        XCTAssertEqual(restart?.rollback, "none needed")
        XCTAssertEqual(restart?.session_id, "s1")
        XCTAssertEqual(items.last?.detail, "refused the connection on port 11434")
        XCTAssertEqual(items.first?.detail, "Fix notes: desk-pc")
        // Only your own lines can be deleted.
        XCTAssertEqual(items.filter(\.own).map(\.text), ["Replaced the case fan"])
    }

    func testListsEveryMachineTogetherForTheOverviewAndAFailedChangeSaysSo() {
        let all = TechHistory.items(journal: journal, incidents: incidents, runbooks: runbooks, hostOf: hostOf)
        XCTAssertEqual(Set(all.map(\.host)), ["desk-pc", "server"])
        let failed = all.first { $0.host == "server" }
        XCTAssertEqual(failed?.kind, .failed)
        XCTAssertEqual(failed?.detail, "it failed")
        XCTAssertEqual(failed?.by, .assistant)
    }

    func testKeepsStepsOnlyPlannedApartForDoneOrDidntDoIt() {
        XCTAssertEqual(TechHistory.plannedSteps(journal, host: "DESK-PC").map(\.id), ["j5"])
        XCTAssertEqual(TechHistory.plannedSteps(journal, host: "server").map(\.id), [])
    }

    func testSaysHowLongSomethingWasDownAsTheWebDoes() {
        XCTAssertEqual(TechHistory.duration(45), "45s")
        XCTAssertEqual(TechHistory.duration(37 * 60), "37m 0s")
        XCTAssertEqual(TechHistory.duration(2 * 3600 + 5 * 60 + 9), "2h 5m")
        XCTAssertEqual(TechHistory.duration(3 * 86400 + 4 * 3600), "3d 4h")
    }
}
