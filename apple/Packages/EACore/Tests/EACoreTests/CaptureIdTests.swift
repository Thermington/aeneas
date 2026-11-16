import XCTest
@testable import EACore

/// The share sheet gives each capture its own id. When its reply is lost, the app sends it again with that id.
final class CaptureIdTests: XCTestCase {
    @MainActor
    func testAShareSentAgainWithItsIdIsOneCapture() async throws {
        let config = SharedConfig(suiteName: "capture-id-\(UUID().uuidString)")
        config.deviceId = "phone-1"
        let engine = SyncEngine(config: config, platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        let hub = RelayLimitTransport()
        engine.makeClient = { HubClient(transport: hub) }
        await engine.start()
        let id = UUID().uuidString.lowercased()
        // The share sheet's own send: the hub saved it, and the reply never came back.
        hub.loseCaptureReply = true
        _ = try? await HubClient(transport: hub).capture(CaptureRequest(text: "Article to read", source: .iphone, auto: true, id: id))
        hub.loseCaptureReply = false
        let saved = await engine.capture("Article to read", source: .iphone, id: id)
        await engine.sync()
        XCTAssertEqual(saved?.id, id)
        XCTAssertEqual(Array(hub.hubCaptures.keys), [id], "the same capture, not a second copy")
        XCTAssertEqual(hub.pushedCaptureCreates, [])
        engine.stop()
    }

    @MainActor
    func testAShareSavedOfflineKeepsItsId() async throws {
        let config = SharedConfig(suiteName: "capture-id-\(UUID().uuidString)")
        config.deviceId = "phone-1"
        let engine = SyncEngine(config: config, platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        let hub = PushRecordingHub()
        hub.down = true
        engine.makeClient = { HubClient(transport: hub) }
        await engine.start()
        let id = UUID().uuidString.lowercased()
        let saved = await engine.capture("Article to read", source: .iphone, id: id)
        XCTAssertEqual(saved?.id, id)
        hub.down = false
        await engine.sync()
        XCTAssertEqual(hub.pushed.filter { $0.kind == .capture }.map(\.id), [id], "sent later under the id it was shared with")
        engine.stop()
    }
}
