import XCTest
import Combine
@testable import EACore

/// A hub for these tests: what it holds comes back from /sync/changes by seq, pushes are kept, a claim gives a key.
final class OneHub: HubTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var held: [Entity]
    private var _pushed: [Patch] = []
    private var _down = false
    let claimId: String
    let claimKey: String
    var pushed: [Patch] { lock.withLock { _pushed } }
    var down: Bool { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }

    init(_ entities: [Entity] = [], claimId: String = "22222222-2222-4222-8222-222222222222", claimKey: String = "ead1_new") {
        held = entities; self.claimId = claimId; self.claimKey = claimKey
    }

    func add(_ e: Entity) { lock.withLock { held.append(e) } }

    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        if down { throw HubError.transport("The Internet connection appears to be offline.") }
        switch path {
        case "devices/claim":
            return (200, Data(#"{"device_id":"\#(claimId)","key":"\#(claimKey)","name":"Phone"}"#.utf8))
        case "sync/push":
            let req = try JSONCoding.decode(PushRequest.self, from: body ?? Data())
            lock.withLock { _pushed += req.patches }
            let applied = req.patches.map { #"{"id":"\#($0.id)","seq":1}"# }.joined(separator: ",")
            return (200, Data(#"{"applied":[\#(applied)],"rejected":[],"seq":1}"#.utf8))
        case "sync/changes":
            let since = Int(query["since"] ?? "0") ?? 0
            let list = lock.withLock { held }
            let changes = list.enumerated().filter { $0.offset + 1 > since }.map { Change(seq: $0.offset + 1, entity: $0.element) }
            return (200, try JSONCoding.data(ChangesResponse(changes: changes, seq: list.count, more: false)))
        default:
            return (200, Data("{}".utf8))
        }
    }
}

@MainActor
final class HubCopyTests: XCTestCase {
    let phoneId = "11111111-1111-4111-8111-111111111111"

    private func config(hub: String = "http://hub-a.test", key: String = "ead1_a", pin: String? = nil) -> SharedConfig {
        let c = SharedConfig(suiteName: "eacore-tests-\(UUID().uuidString)")
        c.hubURL = hub
        c.hubPin = pin
        c.storeDeviceKey(key)
        c.deviceId = phoneId
        c.deviceName = "Phone"
        return c
    }

    private func reminder(_ id: String) -> Entity {
        Entity(id: id, kind: .task, fields: ["title": "Call Jamie", "status": "scheduled", "order": 1, "remind_at": .string(ISO.string(Date().addingTimeInterval(86400)))])
    }

    // MARK: switching hubs (bug 8)

    /// The owner switches to hub B because hub A is out of reach. Hub A's note stayed beside hub B's items, and the
    /// capture queued for hub A went to hub B. Both go now, with the links to Apple's stores kept by hub A's ids.
    func testSwitchingHubsForgetsTheOldHubsCopyQueueAndLinks() async throws {
        let c = config()
        let store = try SyncStore.inMemory()
        try await store.upsertFromHub(Entity(id: "note-a", kind: .note, fields: ["title": "Hub A's note", "path": "a.md"]))
        try await store.applyLocal(Patch(id: "cap-a", kind: .capture, space: .personal, ts: ISO.now(), fields: ["text": "queued for hub A", "source": "iphone"], create: true))
        for k in [AppleLinkRecords.reminders, AppleLinkRecords.calendar, AppleLinkRecords.contacts] { UserDefaults.standard.set(Data("{}".utf8), forKey: k) }
        let engine = SyncEngine(config: c, platform: .iphone, store: store)
        engine.schedulesNotifications = false
        let hubA = OneHub()
        hubA.down = true
        let hubB = OneHub([Entity(id: "note-b", kind: .note, fields: ["title": "Hub B's note", "path": "b.md"])])
        var current = hubA
        engine.makeClient = { HubClient(transport: current) }
        engine.pairingClient = { _, _ in HubClient(transport: hubB) }
        await engine.start()
        current = hubB
        try await engine.pair(hubURL: "http://hub-b.test", code: "ABCD-EFGH", deviceName: nil)
        XCTAssertNil(engine.get("note-a"), "hub A's items are gone")
        XCTAssertNil(engine.get("cap-a"))
        XCTAssertNotNil(engine.get("note-b"))
        XCTAssertFalse(hubB.pushed.contains { $0.id == "cap-a" }, "hub A's queued capture never reaches hub B")
        for k in [AppleLinkRecords.reminders, AppleLinkRecords.calendar, AppleLinkRecords.contacts] {
            XCTAssertNil(UserDefaults.standard.object(forKey: k), "\(k) is forgotten")
        }
        XCTAssertTrue(engine.hasHubCopy, "filled from hub B")
        engine.stop()
    }

    /// Switching while hub A answers: the capture queued for it reaches hub A before the copy goes, and never hub B.
    func testSwitchingHubsSendsWhatWasQueuedToTheOldHubFirst() async throws {
        let c = config()
        let store = try SyncStore.inMemory()
        try await store.applyLocal(Patch(id: "cap-a", kind: .capture, space: .personal, ts: ISO.now(), fields: ["text": "queued for hub A", "source": "iphone"], create: true))
        let engine = SyncEngine(config: c, platform: .iphone, store: store)
        engine.schedulesNotifications = false
        let hubA = OneHub()
        hubA.down = true
        let hubB = OneHub()
        var current = hubA
        engine.makeClient = { HubClient(transport: current) }
        engine.pairingClient = { _, _ in HubClient(transport: hubB) }
        await engine.start()
        XCTAssertEqual(engine.outboxCount, 1)
        hubA.down = false
        current = hubB
        try await engine.pair(hubURL: "http://hub-b.test", code: "ABCD-EFGH", deviceName: nil)
        XCTAssertTrue(hubA.pushed.contains { $0.id == "cap-a" }, "the old hub took its capture")
        XCTAssertFalse(hubB.pushed.contains { $0.id == "cap-a" })
        XCTAssertNil(engine.get("cap-a"))
        XCTAssertEqual(engine.outboxCount, 0)
        engine.stop()
    }

    /// Paired again with the same hub: nothing is wiped, and the queued capture still goes to it.
    func testPairingAgainWithTheSameHubKeepsTheCopy() async throws {
        let c = config()
        let store = try SyncStore.inMemory()
        try await store.upsertFromHub(Entity(id: "note-a", kind: .note, fields: ["title": "Hub A's note", "path": "a.md"]))
        try await store.applyLocal(Patch(id: "cap-a", kind: .capture, space: .personal, ts: ISO.now(), fields: ["text": "queued for hub A", "source": "iphone"], create: true))
        UserDefaults.standard.set(Data("{}".utf8), forKey: AppleLinkRecords.reminders)
        let engine = SyncEngine(config: c, platform: .iphone, store: store)
        engine.schedulesNotifications = false
        let hubA = OneHub(claimId: phoneId)
        hubA.down = true
        engine.makeClient = { HubClient(transport: hubA) }
        engine.pairingClient = { _, _ in HubClient(transport: hubA) }
        await engine.start()
        hubA.down = false
        try await engine.pair(hubURL: "http://hub-a.test/", code: "ABCD-EFGH", deviceName: nil)
        XCTAssertNotNil(engine.get("note-a"))
        let stored = try await engine.store.get("note-a")
        XCTAssertNotNil(stored)
        XCTAssertTrue(hubA.pushed.contains { $0.id == "cap-a" })
        XCTAssertNotNil(UserDefaults.standard.object(forKey: AppleLinkRecords.reminders))
        UserDefaults.standard.removeObject(forKey: AppleLinkRecords.reminders)
        engine.stop()
    }

    // MARK: a setup link for the same hub (bug 7)

    /// A link to this hub that names another certificate: it was taken at once, the pin replaced and the device's key
    /// sent under it. It is asked about first now, and even when the owner says yes, the key never goes under it.
    func testALinkNamingAnotherCertificateIsAskedAboutAndNeverCarriesTheKey() async throws {
        let hub = "https://hub.home.test:8787"
        let pinned = String(repeating: "a", count: 64), other = String(repeating: "b", count: 64)
        XCTAssertTrue(SetupLink(hub: hub, credential: .code("ABCDEFGH"), pin: other).needsConfirmation(currentHub: hub, currentPin: pinned))
        XCTAssertTrue(SetupLink(hub: hub, credential: .code("ABCDEFGH"), pin: other).needsConfirmation(currentHub: hub, currentPin: nil), "a pin where there was none")
        XCTAssertFalse(SetupLink(hub: hub, credential: .code("ABCDEFGH"), pin: pinned.uppercased()).needsConfirmation(currentHub: hub + "/", currentPin: pinned))
        XCTAssertFalse(SetupLink(hub: hub, credential: .code("ABCDEFGH")).needsConfirmation(currentHub: hub, currentPin: pinned), "no pin leaves the pin as it is")
        XCTAssertTrue(SetupLink(hub: "https://other.test", credential: .code("ABCDEFGH"), pin: pinned).needsConfirmation(currentHub: hub, currentPin: pinned))

        // Said yes to: the claim goes, the old entry is left for Settings, Devices, and the old key stays home.
        let c = config(hub: hub, key: "ead1_real", pin: pinned)
        let engine = SyncEngine(config: c, platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        var keys: [String] = []
        let claim = OneHub(claimId: "33333333-3333-4333-8333-333333333333")
        engine.pairingClient = { _, key in keys.append(key); return HubClient(transport: claim) }
        engine.makeClient = { HubClient(transport: OneHub()) }
        try await engine.pair(hubURL: hub, code: "ABCD-EFGH", deviceName: nil, pin: other)
        XCTAssertFalse(keys.contains("ead1_real"), "the device's key is not sent under the link's pin")
        XCTAssertEqual(c.deviceKey, "ead1_new")
        engine.stop()

        // The same pin as before: the old entry is removed with the old key, as it always was.
        let same = config(hub: hub, key: "ead1_real", pin: pinned)
        let again = SyncEngine(config: same, platform: .iphone, store: try SyncStore.inMemory())
        again.schedulesNotifications = false
        var sent: [String] = []
        again.pairingClient = { _, key in sent.append(key); return HubClient(transport: claim) }
        again.makeClient = { HubClient(transport: OneHub()) }
        try await again.pair(hubURL: hub, code: "ABCD-EFGH", deviceName: nil, pin: pinned)
        XCTAssertTrue(sent.contains("ead1_real"))
        again.stop()
    }

    /// An older link (`token=`) to this hub whose trade did not go through deleted the device's own key and left it on
    /// the link's shared key. The key stays now, and the link's error is shown.
    func testATokenLinkWhoseTradeFailsKeepsTheDevicesOwnKey() async {
        let hub = "https://hub.home.test:8787"
        let pinned = String(repeating: "a", count: 64)
        let c = config(hub: hub, key: "ead1_real", pin: pinned)
        let engine = SyncEngine(config: c, platform: .iphone, store: try! SyncStore.inMemory())
        engine.schedulesNotifications = false
        let failing = OneHub()
        failing.down = true
        engine.pairingClient = { _, _ in HubClient(transport: failing) }
        engine.makeClient = { HubClient(transport: OneHub()) }
        do {
            try await engine.connect(hubURL: hub, token: "shared-key-from-the-link", deviceName: nil, pin: String(repeating: "0", count: 64))
            XCTFail("the failed trade is reported")
        } catch {}
        XCTAssertEqual(c.deviceKey, "ead1_real")
        XCTAssertEqual(c.legacyToken, "")
        XCTAssertEqual(c.hubPin, pinned)
    }

    // MARK: sample mode and a removed device (bugs 4 and 5)

    /// Sample mode copies nothing into this device's own stores (Health among them), and ending it takes off the alerts
    /// planned from the sample's reminders, which kept firing for up to 30 days.
    func testSampleModeCopiesNothingAndEndingItTakesOffItsAlerts() async throws {
        let c = SharedConfig(suiteName: "eacore-tests-\(UUID().uuidString)")
        c.sampleMode = true
        c.hubURL = SyncEngine.sampleHubURL
        c.deviceId = "sample-device"
        let store = try SyncStore.inMemory()
        try await store.upsertFromHub(reminder("t1"))
        let engine = SyncEngine(config: c, platform: .iphone, store: store)
        var plans: [[String]] = []
        engine.onReplan = { plans.append($0.map(\.id)) }
        engine.makeClient = { HubClient(transport: OneHub()) }
        await engine.start()
        XCTAssertEqual(plans.last, ["t1"])
        XCTAssertNotNil(engine.client)
        XCTAssertFalse(engine.pairedWithHub, "no Health export (and no other copy) in sample mode")
        XCTAssertFalse(engine.hasHubCopy)
        await engine.endSample()
        XCTAssertEqual(plans.last, [], "the sample's alerts are taken off")
        engine.stop()
    }

    /// Removed from another device: the copies into this device's own stores stop before its copy is emptied (the
    /// Health export read the empty copy as every log deleted), and the alerts planned from its reminders go.
    func testARemovedDeviceStopsCopyingFirstAndTakesOffItsAlerts() async throws {
        let c = config()
        let store = try SyncStore.inMemory()
        try await store.upsertFromHub(reminder("t1"))
        try await store.setCursor(4)
        let engine = SyncEngine(config: c, platform: .iphone, store: store)
        var plans: [[String]] = []
        engine.onReplan = { plans.append($0.map(\.id)) }
        let removed = FakeTransport()
        removed.responses = Array(repeating: (401, Data(#"{"error":"unauthorized","device_removed":true}"#.utf8)), count: 20)
        engine.makeClient = { HubClient(transport: removed) }
        var held = false
        var pairedWhenEmptied: Bool?
        let watch = engine.$entities.sink { e in
            MainActor.assumeIsolated {
                if !e.isEmpty { held = true } else if held, pairedWhenEmptied == nil { pairedWhenEmptied = engine.pairedWithHub }
            }
        }
        await engine.start()
        XCTAssertTrue(plans.contains(["t1"]))
        for _ in 0..<100 where !engine.deviceRemoved { try? await Task.sleep(nanoseconds: 10_000_000) }
        for _ in 0..<100 where plans.last != [] { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(engine.deviceRemoved)
        XCTAssertEqual(pairedWhenEmptied, false, "nothing copies into Health or Contacts once the copy is empty")
        XCTAssertEqual(plans.last, [], "every planned reminder alert is taken off")
        XCTAssertFalse(engine.hasHubCopy)
        watch.cancel()
    }

    /// What the Health export takes out of Health: only samples of logs this device holds as deleted or changed. A log
    /// missing from the copy (emptied on a removed device) is not one the person deleted.
    func testAnEmptiedCopyTakesNothingOutOfHealth() {
        func log(_ id: String, _ value: JSONValue, note: String? = nil) -> Entity {
            var f: [String: JSONValue] = ["type": "weight", "value": value, "unit": "lb", "at": "2026-11-10T08:00:00.000Z"]
            if let note { f["note"] = .string(note) }
            return Entity(id: id, kind: .log, fields: f)
        }
        let sig: (Entity) -> String? = { e in e.str("type") == "weight" ? "\(e.str("type"))|\(e.fields["value"].map { "\($0)" } ?? "")|\(e.str("at"))" : nil }
        let w1 = log("w1", 180), w2 = log("w2", 181)
        let exported = ["w1": sig(w1)!, "w2": sig(w2)!]
        XCTAssertEqual(HealthExport.plan(exported: exported, logs: [], signature: sig), .init(), "an empty copy takes nothing out")
        var gone = w1
        gone.deleted_at = "2026-11-12T08:00:00.000Z"
        let p = HealthExport.plan(exported: exported, logs: [gone, log("w2", 182), log("w3", 179)], signature: sig)
        XCTAssertEqual(p.removals, ["w1", "w2"], "deleted, and changed")
        XCTAssertEqual(p.writes, ["w2", "w3"], "changed, and new")
        XCTAssertEqual(HealthExport.plan(exported: [:], logs: [log("w4", 178, note: "Apple Health")], signature: sig).writes, [], "what came from Health")
    }

    // MARK: a filled copy (bug 6)

    /// Contacts (and the other copies into Apple's stores) wait for a copy filled from the hub: an unpaired or removed
    /// device, or one whose copy is empty, read as nobody in People and sent every card as a second person.
    func testCopiesWaitForACopyFilledFromTheHub() async throws {
        let c = config()
        let hub = OneHub([Entity(id: "p1", kind: .person, fields: ["name": "Jamie Lee"])])
        hub.down = true
        let store = try SyncStore.inMemory()
        let engine = SyncEngine(config: c, platform: .iphone, store: store)
        engine.schedulesNotifications = false
        engine.makeClient = { HubClient(transport: hub) }
        await engine.start()
        XCTAssertTrue(engine.pairedWithHub)
        XCTAssertFalse(engine.hasHubCopy, "never filled from the hub")
        hub.down = false
        await engine.sync()
        XCTAssertTrue(engine.hasHubCopy)
        engine.stop()
        // A later launch while the hub is out of reach still holds a filled copy.
        hub.down = true
        let later = SyncEngine(config: c, platform: .iphone, store: store)
        later.schedulesNotifications = false
        later.makeClient = { HubClient(transport: hub) }
        await later.start()
        XCTAssertTrue(later.hasHubCopy)
        later.stop()
        // A copy an older build filled (it has pulled, with no mark yet) counts as filled.
        let older = try SyncStore.inMemory()
        try await older.setCursor(12)
        let updated = SyncEngine(config: c, platform: .iphone, store: older)
        updated.schedulesNotifications = false
        updated.makeClient = { HubClient(transport: hub) }
        await updated.start()
        XCTAssertTrue(updated.hasHubCopy)
        updated.stop()
    }

    // MARK: background refresh (bug 9)

    /// Background refresh copied Calendar before it synced: an event made in the app (whose copy the Mac had already put
    /// in Apple Calendar) was not here yet, and that copy came in as a second event. The hub's changes come first now,
    /// and nothing is brought in while the hub is out of reach.
    func testBackgroundRefreshPullsBeforeTheCopiesRun() async throws {
        let c = config()
        let hub = OneHub()
        let engine = SyncEngine(config: c, platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        engine.makeClient = { HubClient(transport: hub) }
        await engine.start()
        // Made in the app on another device while this one slept; the Mac copied it into the calendar.
        hub.add(Entity(id: "e1", kind: .event, fields: ["title": "Dinner with Robin", "start": "2026-11-20T23:00:00.000Z", "end": "2026-11-21T01:00:00.000Z",
                                                        "all_day": false, "apple": .object(["id": "X1", "calendar": "Home"])]))
        let macCopy = AppleEvent(externalId: "X1", localId: "L1", title: "Dinner with Robin", start: "2026-11-20T23:00:00.000Z", end: "2026-11-21T01:00:00.000Z",
                                 allDay: false, modified: ISO.date("2026-11-15T20:00:00.000Z"))
        XCTAssertEqual(EventMirror.adopt(found: [macCopy], calendarTitle: "Home", events: engine.list(.event)).count, 1, "copied before syncing: a second event")
        var adopted: [EventMirror.Adoption]?
        var inReach = false
        await engine.refreshing {
            adopted = EventMirror.adopt(found: [macCopy], calendarTitle: "Home", events: engine.list(.event))
            inReach = engine.hubInReach
        }
        XCTAssertEqual(adopted, [], "the app's own event is here first, so its copy is not brought in")
        XCTAssertTrue(inReach)
        hub.down = true
        await engine.refreshing { inReach = engine.hubInReach }
        XCTAssertFalse(inReach, "out of reach: Calendar events are not brought in")
        engine.stop()
    }
}
