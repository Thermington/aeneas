import XCTest
@testable import EACore

/// A hub that keeps what was pushed and can be out of reach.
final class PushRecordingHub: HubTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _pushed: [Patch] = []
    private var _down = false
    var pushed: [Patch] { lock.withLock { _pushed } }
    var down: Bool { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }

    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        if down { throw HubError.transport("Could not connect to the server.") }
        switch path {
        case "sync/push":
            let req = try JSONCoding.decode(PushRequest.self, from: body!)
            lock.withLock { _pushed.append(contentsOf: req.patches) }
            let applied = req.patches.enumerated().map { "{\"id\":\"\($0.element.id)\",\"seq\":\($0.offset + 1)}" }.joined(separator: ",")
            return (200, Data("{\"applied\":[\(applied)],\"rejected\":[],\"seq\":1}".utf8))
        case "sync/changes":
            return (200, Data("{\"changes\":[],\"seq\":1,\"more\":false}".utf8))
        default:
            return (200, Data("{}".utf8))
        }
    }
}

final class WidgetDoneTests: XCTestCase {
    private let tapped = "2026-11-16T04:00:00.000Z"

    func testWaitingDonesKeepOnePerTaskOldestFirst() {
        let c = SharedConfig(suiteName: "widget-done-\(UUID().uuidString)")
        c.addPendingWidgetDone(WidgetDone(taskId: "a", at: "2026-11-16T04:00:00.000Z"))
        c.addPendingWidgetDone(WidgetDone(taskId: "b", at: "2026-11-16T04:01:00.000Z"))
        c.addPendingWidgetDone(WidgetDone(taskId: "a", at: "2026-11-16T04:02:00.000Z"))
        XCTAssertEqual(c.pendingWidgetDones.map(\.taskId), ["b", "a"])
        c.removePendingWidgetDones([WidgetDone(taskId: "b", at: "2026-11-16T04:01:00.000Z")])
        XCTAssertEqual(c.pendingWidgetDones, [WidgetDone(taskId: "a", at: "2026-11-16T04:02:00.000Z")])
        c.clearSnapshot()
        XCTAssertTrue(c.pendingWidgetDones.isEmpty, "a removed device keeps no Done waiting")
    }

    /// The widget's Done ended a repeating task; every other Done moves it to its next time.
    func testADoneOnARepeatingTaskMovesItOnInsteadOfEndingIt() {
        let task = Entity(id: "r1", kind: .task, fields: ["title": "Water the plants", "status": "next", "repeat": "every 1 days", "remind_at": "2026-11-16T03:00:00.000Z"])
        let timing = WidgetDone.timing(of: task)
        let p = WidgetDone(taskId: "r1", at: tapped, timing: timing).patch()
        XCTAssertNil(p.fields["status"], "a repeating task stays open")
        XCTAssertEqual(p.fields["remind_at"], .string("2026-11-17T03:00:00.000Z"))
        XCTAssertEqual(p.ts, tapped)
        XCTAssertEqual(WidgetDone(taskId: "r1", at: tapped).patch(task: task).fields["remind_at"], .string("2026-11-17T03:00:00.000Z"), "the app uses the task it holds")
        XCTAssertEqual(WidgetDone(taskId: "t1", at: tapped).patch().fields["status"], .string("done"), "any other task is done")
        let c = SharedConfig(suiteName: "widget-done-\(UUID().uuidString)")
        c.addPendingWidgetDone(WidgetDone(taskId: "r1", at: tapped, timing: timing))
        XCTAssertEqual(c.pendingWidgetDones.first?.timing, timing, "the waiting line keeps the timing")
        c.defaults.set("old|\(tapped)", forKey: "now.donePending")
        XCTAssertEqual(c.pendingWidgetDones, [WidgetDone(taskId: "old", at: tapped)], "a line written before the timing was kept still reads")
    }

    /// The widget's Done while the hub was out of reach used to be dropped, so the task came back not done.
    @MainActor
    func testADoneTheHubDidNotTakeIsQueuedAndSentOnceItAnswers() async throws {
        let config = SharedConfig(suiteName: "widget-done-\(UUID().uuidString)")
        config.deviceId = "phone-1"
        let store = try SyncStore.inMemory()
        _ = try await store.upsertFromHub(Entity(id: "t1", kind: .task, fields: ["title": "Order filament", "status": "next"]))
        let engine = SyncEngine(config: config, platform: .iphone, store: store)
        engine.schedulesNotifications = false
        config.addPendingWidgetDone(WidgetDone(taskId: "t1", at: tapped))
        config.addPendingWidgetDone(WidgetDone(taskId: "not-here-yet", at: tapped))
        let hub = PushRecordingHub()
        hub.down = true
        engine.makeClient = { HubClient(transport: hub) }

        await engine.start()
        XCTAssertEqual(engine.get("t1")?.str("status"), "done", "done here at once, not back as Next")
        XCTAssertEqual(engine.outboxCount, 1, "queued with the rest")
        XCTAssertEqual(config.pendingWidgetDones.map(\.taskId), ["not-here-yet"], "a task this device does not hold yet waits")

        hub.down = false
        await engine.sync()
        XCTAssertEqual(engine.outboxCount, 0)
        let sent = hub.pushed.filter { $0.id == "t1" }
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ts, tapped, "stamped when it was tapped")
        XCTAssertEqual(sent.first?.fields["status"], .string("done"))
        engine.stop()
    }
}
