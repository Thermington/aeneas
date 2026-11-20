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

    // MARK: Add machine with a password, and a computer's own app (since 2026-11-20)

    func testAddMachineSendsThePasswordOnceAndOnlyWhatWasGiven() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data(#"{"machine":{"name":"nas02","ssh":"admin@192.168.1.20","os":"linux"},"created":true}"#.utf8))]
        let r = try await HubClient(transport: t).setupMachine(address: "192.168.1.20", user: "admin", password: "pa ss")
        XCTAssertEqual(t.calls.last?.method, "POST")
        XCTAssertEqual(t.calls.last?.path, "machines/setup")
        let sent = try XCTUnwrap(try JSONSerialization.jsonObject(with: t.calls.last?.body ?? Data()) as? [String: String])
        XCTAssertEqual(sent, ["address": "192.168.1.20", "user": "admin", "password": "pa ss"])
        XCTAssertEqual(r, MachineSetup(machine: HubMachine(name: "nas02", ssh: "admin@192.168.1.20", os: "linux"), created: true))
        // With a password manager item there is no password in the body at all.
        t.responses = [(200, Data(#"{"machine":{"name":"nas02","ssh":"admin@192.168.1.20"},"created":false}"#.utf8))]
        let again = try await HubClient(transport: t).setupMachine(address: "192.168.1.20", user: "admin", secret: "Tech/NAS")
        let item = try XCTUnwrap(try JSONSerialization.jsonObject(with: t.calls.last?.body ?? Data()) as? [String: String])
        XCTAssertEqual(item, ["address": "192.168.1.20", "user": "admin", "secret": "Tech/NAS"])
        XCTAssertFalse(again.created)
        // The hub gives the sign-in 20 s and then checks its key: the request waits longer than the usual 20 s.
        XCTAssertEqual(HTTPTransport.timeout(path: "machines/setup"), 90)
    }

    func testAddMachineRefusalsComeBackInTheHubsWords() async throws {
        let t = FakeTransport()
        t.responses = [(401, Data(#"{"error":"nas.local did not accept that user name and password"}"#.utf8))]
        do {
            _ = try await HubClient(transport: t).setupMachine(address: "nas.local", user: "admin", password: "wrong")
            XCTFail("the hub refused it")
        } catch HubError.http(let status, let message) {
            XCTAssertEqual(status, 401)
            XCTAssertEqual(message, "nas.local did not accept that user name and password")
        }
    }

    func testReadsTheHubsKeyAndWhetherAPasswordManagerIsLinked() async throws {
        let t = FakeTransport()
        t.responses = [
            (200, Data(#"{"public_key":"ssh-ed25519 AAAAkey aeneas-hub@server"}"#.utf8)),
            (200, Data(#"{"owner":"Alex","named":true,"ai":{},"model_ready":true,"password_manager":true}"#.utf8)),
            (200, Data(#"{"owner":"Alex"}"#.utf8)),
        ]
        let c = HubClient(transport: t)
        let key = try await c.hubKey()
        XCTAssertEqual(key, "ssh-ed25519 AAAAkey aeneas-hub@server")
        XCTAssertEqual(t.calls.last?.path, "machines/hub-key")
        let linked = try await c.passwordManagerLinked()
        XCTAssertTrue(linked)
        XCTAssertEqual(t.calls.last?.path, "setup")
        let older = try await c.passwordManagerLinked()
        XCTAssertFalse(older, "a hub that does not say has none linked")
    }

    func testReportsThisComputerWithItsLinesAndReadsTheAnswer() async throws {
        let t = FakeTransport()
        t.responses = [
            (200, Data(#"{"name":"taylors-macbook-pro","read_by_hub":false,"kept":3}"#.utf8)),
            (200, Data(#"{"name":"taylors-macbook-pro","read_by_hub":true,"kept":0}"#.utf8)),
            (404, Data(#"{"error":"not found"}"#.utf8)),
        ]
        let c = HubClient(transport: t)
        let output = ThisComputer.lines(.init(cpu: 7.5, memory: 48, disk: 63.2, os: "macOS 26.1"))
        let r = try await c.reportComputer(name: "taylors-macbook-pro", output: output)
        XCTAssertEqual(t.calls.last?.method, "PUT")
        XCTAssertEqual(t.calls.last?.path, "devices/me/computer")
        let sent = try XCTUnwrap(try JSONSerialization.jsonObject(with: t.calls.last?.body ?? Data()) as? [String: String])
        XCTAssertEqual(sent, ["name": "taylors-macbook-pro", "output": "cpu 7.5\nmem 48.0\ndisk / 63.2\nos macOS 26.1"])
        XCTAssertEqual(r.kept, 3)
        XCTAssertFalse(r.read_by_hub)
        let read = try await c.reportComputer(name: "taylors-macbook-pro", output: output)
        XCTAssertTrue(read.read_by_hub, "the hub signs in to it itself")
        // A hub older than the route: the Mac stops asking it.
        do {
            _ = try await c.reportComputer(name: "taylors-macbook-pro", output: output)
            XCTFail("an older hub has no such route")
        } catch HubError.http(let status, _) {
            XCTAssertEqual(status, 404)
        }
    }
}
