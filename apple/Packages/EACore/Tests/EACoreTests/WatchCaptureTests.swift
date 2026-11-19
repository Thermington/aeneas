import XCTest
@testable import EACore

final class WatchCaptureTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("watch-capture-tests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func capture(_ fields: String) throws -> Entity {
        try JSONCoding.decode(Entity.self, from: #"{"id":"cap-1","kind":"capture","space":"personal","created_at":"2026-11-19T15:43:50.085Z","updated_at":"2026-11-19T15:44:16.511Z","deleted_at":null,"fields":\#(fields),"field_ts":{}}"#)
    }

    private func recording(_ ext: String = "m4a") throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("watch-capture-src-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("take.\(ext)")
        try Data("....ftypM4A ".utf8).write(to: url)
        return url
    }

    // MARK: transfer metadata

    func testMetadataRoundTripsAsPropertyListValues() throws {
        let at = ISO.date("2026-11-19T15:43:20.250Z")!
        let c = WatchVoiceCapture(id: "4b1c2d3e-aaaa-bbbb-cccc-0123456789ab", seconds: 74.5, recordedAt: at, format: "m4a")
        let m = c.metadata
        XCTAssertEqual(m["kind"] as? String, "capture-audio")
        XCTAssertEqual(m["format"] as? String, "m4a")
        // WatchConnectivity refuses anything a property list cannot hold.
        XCTAssertTrue(PropertyListSerialization.propertyList(m, isValidFor: .binary))
        XCTAssertEqual(WatchVoiceCapture(metadata: m), c)
        // A hum's transfer is not a capture, nor the other way round.
        XCTAssertNil(WatchHum(metadata: m))
        XCTAssertNil(WatchVoiceCapture(metadata: WatchHum(seconds: 3).metadata))
    }

    func testMetadataWithBadIdsOrFormatsIsRefused() {
        XCTAssertNil(WatchVoiceCapture(metadata: nil))
        XCTAssertNil(WatchVoiceCapture(metadata: ["kind": "capture-audio"]))
        // The id and the format name files on the iPhone.
        XCTAssertNil(WatchVoiceCapture(metadata: ["kind": "capture-audio", "id": "../../etc"]))
        XCTAssertNil(WatchVoiceCapture(metadata: ["kind": "capture-audio", "id": "abc", "format": "m4a/../../x"]))
        XCTAssertNil(WatchVoiceCapture(metadata: ["kind": "capture-audio", "id": "abc", "format": "exe"]))
        let bare = WatchVoiceCapture(metadata: ["kind": "capture-audio", "id": "abc-1"])
        XCTAssertEqual(bare?.format, "m4a")
        XCTAssertEqual(bare?.seconds, 0)
        // A format the iPhone does not take is not passed on from the Watch side either.
        XCTAssertEqual(WatchVoiceCapture(seconds: 2, format: "caf").format, "m4a")
        XCTAssertEqual(WatchVoiceCapture(seconds: 2, format: "wav").format, "wav")
    }

    // MARK: result message

    func testResultMessageRoundTripsAndRefusesOthers() {
        let r = WatchCaptureResult(id: "c1", state: .saved, text: "call the vet tomorrow", outcome: "Saved as a task")
        XCTAssertTrue(PropertyListSerialization.propertyList(r.message, isValidFor: .binary))
        XCTAssertEqual(WatchCaptureResult(message: r.message), r)
        XCTAssertNil(WatchCaptureResult(message: ["kind": "hum-result", "id": "c1", "state": "done"]))
        XCTAssertNil(WatchCaptureResult(message: ["kind": "capture-result", "id": "c1", "state": "teleported"]))
        XCTAssertNil(WatchHumResult(message: r.message))
    }

    func testLines() {
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .saved, text: " call the vet ", outcome: "Saved as a task").line, "Saved as a task: call the vet")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .saved, text: "x").line, "Saved: x")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .nothing).line, "Heard nothing. Try again a little closer.")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .waiting).line, "Your iPhone will write it down when it can")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .waiting, error: "your iPhone is getting its speech model").line, "Your iPhone is getting its speech model.")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .failed, text: "buy milk", error: "Not saved on your iPhone.").line, "Not saved on your iPhone. buy milk")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .failed).line, "Not saved.")
        XCTAssertTrue(WatchCaptureResult(id: "c", state: .nothing).finished)
        XCTAssertFalse(WatchCaptureResult(id: "c", state: .waiting).finished)
        XCTAssertLessThan(WatchCaptureResult.State.waiting.rank, WatchCaptureResult.State.saved.rank)
        XCTAssertEqual(WatchCaptureResult.State.saved.rank, WatchCaptureResult.State.failed.rank)
    }

    func testOutcomeSaysHowItWasFiled() throws {
        XCTAssertEqual(WatchCaptureResult.outcome(of: try capture(#"{"text":"a","filing":"pending"}"#), online: true), "In your diary, filing it")
        XCTAssertEqual(WatchCaptureResult.outcome(of: try capture(#"{"text":"a","processed":true,"suggested_kind":"task"}"#), online: true), "Saved as a task")
        XCTAssertEqual(WatchCaptureResult.outcome(of: try capture(#"{"text":"a","processed":true,"suggested_kind":"none"}"#), online: true), "Saved, to sort later")
        XCTAssertEqual(WatchCaptureResult.outcome(of: try capture(#"{"text":"a"}"#), online: false), "Saved, will sync")
    }

    // MARK: queue

    func testQueueMovesTheRecordingInOnceAndKeepsOrder() throws {
        let q = WatchCaptureQueue(folder: folder)
        let later = WatchVoiceCapture(id: "b-2", seconds: 4, recordedAt: Date(timeIntervalSince1970: 200))
        let earlier = WatchVoiceCapture(id: "a-1", seconds: 9, recordedAt: Date(timeIntervalSince1970: 100), format: "wav")
        let src = try recording()
        XCTAssertTrue(try q.add(later, moving: src))
        XCTAssertFalse(FileManager.default.fileExists(atPath: src.path))
        XCTAssertTrue(try q.add(earlier, moving: try recording("wav")))
        XCTAssertEqual(q.audioURL(earlier).lastPathComponent, "a-1.wav")
        XCTAssertTrue(q.hasAudio(earlier))
        XCTAssertEqual(q.all().map(\.capture.id), ["a-1", "b-2"])
        // Sent twice: the second copy is left alone and nothing is saved twice.
        let again = try recording()
        XCTAssertFalse(try q.add(later, moving: again))
        XCTAssertTrue(FileManager.default.fileExists(atPath: again.path))
        XCTAssertThrowsError(try q.add(WatchVoiceCapture(id: "../x", seconds: 1), moving: try recording()))
    }

    func testQueueKeepsWordsUntilFinishedThenForgetsThem() throws {
        let q = WatchCaptureQueue(folder: folder)
        let c = WatchVoiceCapture(id: "c-1", seconds: 4)
        try q.add(c, moving: try recording())
        q.setText("c-1", "everyone else on the local hub")
        XCTAssertEqual(q.entry("c-1")?.text, "everyone else on the local hub")
        XCTAssertEqual(q.pending().count, 1)
        let done = Date(timeIntervalSince1970: 1_000)
        q.finish("c-1", at: done)
        XCTAssertFalse(q.hasAudio(c))
        XCTAssertNil(q.entry("c-1")?.text)
        XCTAssertTrue(q.pending().isEmpty)
        // Still known for a week, so a transfer that comes again is not saved again.
        XCTAssertFalse(try q.add(c, moving: try recording()))
        q.prune(now: done.addingTimeInterval(6 * 86_400))
        XCTAssertNotNil(q.entry("c-1"))
        q.prune(now: done.addingTimeInterval(8 * 86_400))
        XCTAssertNil(q.entry("c-1"))
        XCTAssertTrue(try q.add(c, moving: try recording()))
        q.remove("c-1")
        XCTAssertTrue(q.all().isEmpty)
        XCTAssertFalse(q.hasAudio(c))
    }
}
