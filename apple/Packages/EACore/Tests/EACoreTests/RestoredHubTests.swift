import XCTest
@testable import EACore

/// A hub restored from a copy older than some items: an edit of one is refused as "entity not found", a create brings
/// it back.
final class RestoredHub: HubTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var missing: Set<String>
    private var _pushed: [Patch] = []
    var pushed: [Patch] { lock.withLock { _pushed } }
    init(missing: Set<String>) { self.missing = missing }

    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        switch path {
        case "sync/push":
            let req = try JSONCoding.decode(PushRequest.self, from: body!)
            var applied: [String] = [], rejected: [String] = []
            lock.withLock {
                _pushed.append(contentsOf: req.patches)
                for p in req.patches {
                    if missing.contains(p.id), p.create != true {
                        rejected.append("{\"id\":\"\(p.id)\",\"reason\":\"entity not found; send create: true to create it\"}")
                    } else {
                        if p.create == true { missing.remove(p.id) }
                        applied.append("{\"id\":\"\(p.id)\",\"seq\":\(applied.count + 1)}")
                    }
                }
            }
            return (200, Data("{\"applied\":[\(applied.joined(separator: ","))],\"rejected\":[\(rejected.joined(separator: ","))],\"seq\":1}".utf8))
        case "sync/changes":
            return (200, Data("{\"changes\":[],\"seq\":1,\"more\":false}".utf8))
        default:
            if path.hasPrefix("entities/") { return (404, Data("{\"error\":\"entity not found\"}".utf8)) }
            return (200, Data("{}".utf8))
        }
    }
}

final class RestoredHubTests: XCTestCase {
    /// The edit used to be refused, the item refetched, a 404 answered and the item deleted here.
    @MainActor
    func testAnEditOfAnItemTheRestoredHubLacksSendsItAgainWhole() async throws {
        let config = SharedConfig(suiteName: "restored-\(UUID().uuidString)")
        config.deviceId = "phone-1"
        let store = try SyncStore.inMemory()
        let made = "2026-11-14T09:00:00.000Z"
        _ = try await store.upsertFromHub(Entity(id: "t1", kind: .task, created_at: made, fields: ["title": "Call the vet", "status": "next", "order": 3]))
        let engine = SyncEngine(config: config, platform: .iphone, store: store)
        engine.schedulesNotifications = false
        let hub = RestoredHub(missing: ["t1"])
        engine.makeClient = { HubClient(transport: hub) }
        await engine.start()
        _ = await engine.update("t1", fields: ["title": "Call the vet about Rex"])
        await engine.sync()
        XCTAssertEqual(engine.get("t1")?.str("title"), "Call the vet about Rex", "kept here")
        let creates = hub.pushed.filter { $0.id == "t1" && $0.create == true }
        XCTAssertEqual(creates.count, 1)
        XCTAssertEqual(creates.first?.ts, made, "stamped with when it was made, so it keeps its day")
        XCTAssertEqual(creates.first?.fields["title"], .string("Call the vet about Rex"))
        XCTAssertEqual(creates.first?.fields["order"], .number(3))
        XCTAssertEqual(engine.outboxCount, 0)
        XCTAssertTrue(engine.rejectedEdits.isEmpty, "not listed as refused")
        engine.stop()
    }
}

final class FastClockMergeTests: XCTestCase {
    /// A phone whose clock ran 10 minutes fast kept its own value after another device's later edit won on the hub.
    func testWithNothingWaitingTheHubsCopyWins() async throws {
        let store = try SyncStore.inMemory()
        let ahead = ISO.string(Date().addingTimeInterval(600))
        var mine = Entity(id: "t1", kind: .task, fields: ["title": "Mine", "status": "next"])
        mine.field_ts = ["title": ahead, "status": ahead]
        _ = try await store.upsertFromHub(mine)
        var theirs = Entity(id: "t1", kind: .task, fields: ["title": "Theirs", "status": "next"])
        theirs.field_ts = ["title": ISO.now(), "status": ISO.now()]
        let merged = try await store.upsertFromHub(theirs)
        XCTAssertEqual(merged.str("title"), "Theirs", "the hub's copy, as on the web")

        // An edit waiting to send still wins over an older hub value.
        _ = try await store.applyLocal(Patch(id: "t1", kind: .task, ts: ISO.string(Date().addingTimeInterval(5)), fields: ["title": "Waiting"]))
        var older = theirs
        older.fields["title"] = "Older"
        older.field_ts["title"] = ISO.string(Date().addingTimeInterval(-60))
        let kept = try await store.upsertFromHub(older)
        XCTAssertEqual(kept.str("title"), "Waiting")
    }
}
