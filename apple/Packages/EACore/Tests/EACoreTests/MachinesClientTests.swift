import XCTest
@testable import EACore

/// Add machine (Tech Overview): GET and PUT /machines as the hub serves them (hub/src/routes/ai.ts).
final class MachinesClientTests: XCTestCase {
    func testReadsTheMachinesAndOffersSSHConfigNamesNotAddedYet() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data("""
        {"machines":[{"name":"server","ssh":"server","os":"macos","local":true,"aliases":["server"]},{"name":"nas01","ssh":"admin@nas01"}],"ssh_config":["NAS01","desk-pc","pve2"]}
        """.utf8))]
        let r = try await HubClient(transport: t).machines()
        XCTAssertEqual(t.calls.last?.method, "GET")
        XCTAssertEqual(t.calls.last?.path, "machines")
        XCTAssertEqual(r.machines.map(\.name), ["server", "nas01"])
        XCTAssertEqual(r.machines.first?.local, true)
        XCTAssertEqual(r.machines.first?.aliases, ["server"])
        XCTAssertEqual(r.machines.last?.ssh, "admin@nas01")
        XCTAssertNil(r.machines.last?.local)
        // nas01 is added whatever case its SSH config entry is in.
        XCTAssertEqual(r.offers, ["desk-pc", "pve2"])
        // An older hub's answer without the SSH config names still reads.
        t.responses = [(200, Data(#"{"machines":[]}"#.utf8))]
        let bare = try await HubClient(transport: t).machines()
        XCTAssertEqual(bare, HubMachines(machines: [], ssh_config: []))
    }

    func testSavesTheWholeListAndSendsOnlyWhatEachMachineHas() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data(#"{"machines":[{"name":"server","local":true},{"name":"nas01","ssh":"admin@nas01"}]}"#.utf8))]
        let list = [HubMachine(name: "server", local: true), HubMachine.typed("  admin@NAS01 ")!]
        let saved = try await HubClient(transport: t).setMachines(list)
        XCTAssertEqual(t.calls.last?.method, "PUT")
        XCTAssertEqual(t.calls.last?.path, "machines")
        let sent = try JSONSerialization.jsonObject(with: t.calls.last?.body ?? Data()) as? [String: Any]
        let machines = sent?["machines"] as? [[String: Any]]
        XCTAssertEqual(machines?.count, 2)
        XCTAssertEqual(Set(machines?[0].keys.map { $0 } ?? []), ["name", "local"])
        XCTAssertEqual(machines?[1]["name"] as? String, "nas01")
        XCTAssertEqual(machines?[1]["ssh"] as? String, "admin@NAS01")
        XCTAssertEqual(saved.map(\.name), ["server", "nas01"])
        XCTAssertNil(HubMachine.typed("   "))
        XCTAssertEqual(HubMachine.typed("desk-pc"), HubMachine(name: "desk-pc", ssh: "desk-pc"))
    }

    func testABadNameComesBackInTheHubsWords() async throws {
        let t = FakeTransport()
        t.responses = [(422, Data(#"{"error":"each machine needs a name of letters, digits, dots, dashes or underscores"}"#.utf8))]
        do {
            _ = try await HubClient(transport: t).setMachines([HubMachine(name: "bad name")])
            XCTFail("the hub refused it")
        } catch HubError.http(let status, let message) {
            XCTAssertEqual(status, 422)
            XCTAssertEqual(message, "each machine needs a name of letters, digits, dots, dashes or underscores")
        }
    }
}
