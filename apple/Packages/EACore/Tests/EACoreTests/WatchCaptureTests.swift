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

    /// The status line under the words: the words have their own line ("Heard: ..."), so they are not repeated.
    func testLines() {
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .saved, text: " call the vet ", outcome: "Saved as a task").line, "Saved as a task")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .saved, text: "x").line, "Saved")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .nothing).line, "Heard nothing. Try again a little closer.")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .waiting).line, "Your iPhone will write it down when it can")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .waiting, error: "your iPhone is getting its speech model").line, "Your iPhone is getting its speech model.")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .failed, text: "buy milk", error: "Not saved on your iPhone.").line, "Not saved on your iPhone.")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .failed).line, "Not saved.")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .filed, text: "I weigh 192.2 today.", filed: "Logs: weight 192.2 lb").line, "Filed: Logs: weight 192.2 lb")
        XCTAssertEqual(WatchCaptureResult(id: "c", state: .filed, filed: " ").line, "Filed")
        XCTAssertTrue(WatchCaptureResult(id: "c", state: .nothing).finished)
        XCTAssertTrue(WatchCaptureResult(id: "c", state: .filed).finished)
        XCTAssertFalse(WatchCaptureResult(id: "c", state: .waiting).finished)
    }

    /// Results can arrive out of order: each state's rank says which is newer. Filed comes after saved, so the filed
    /// result is never taken for older news and dropped.
    func testStatesAreRankedInTheOrderTheyHappen() {
        let r = { (s: WatchCaptureResult.State) in s.rank }
        // The Watch's own steps: 0 sent, 1 delivered.
        XCTAssertGreaterThan(r(.waiting), 1)
        XCTAssertLessThan(r(.waiting), r(.saved))
        XCTAssertEqual(r(.saved), r(.failed))
        XCTAssertEqual(r(.saved), r(.nothing))
        XCTAssertGreaterThan(r(.filed), r(.saved))
        XCTAssertEqual(WatchCaptureResult.State.allCases.map(\.rank).max(), r(.filed))
    }

    func testFiledResultRoundTripsAndComesOnlyOnceTheHubIsDone() throws {
        let r = WatchCaptureResult(id: "c1", state: .filed, text: "I weigh 192.2 today.", filed: "Logs: weight 192.2 lb (filed by rule)")
        XCTAssertTrue(PropertyListSerialization.propertyList(r.message, isValidFor: .binary))
        XCTAssertEqual(WatchCaptureResult(message: r.message), r)
        XCTAssertNil(WatchCaptureResult.filed(try capture(#"{"text":"a","filing":"pending","processed":true}"#)))
        XCTAssertNil(WatchCaptureResult.filed(try capture(#"{"text":"a","filing":"failed","filed":"Could not file it automatically"}"#)))
        XCTAssertNil(WatchCaptureResult.filed(try capture(#"{"text":"a","filing":"done"}"#)))
        let done = WatchCaptureResult.filed(try capture(#"{"text":" I weigh 192.2 today. ","filing":"done","filed":"Logs: weight 192.2 lb (filed by rule)","heard_on_watch":"Highway 192.2 today."}"#))
        XCTAssertEqual(done, WatchCaptureResult(id: "cap-1", state: .filed, text: "I weigh 192.2 today.", filed: "Logs: weight 192.2 lb (filed by rule)"))
    }

    func testWatchHearingTravelsWithTheRecording() {
        let c = WatchVoiceCapture(id: "c-9", seconds: 3, heard: "  Highway 192.2 today. ")
        XCTAssertEqual(c.heard, "Highway 192.2 today.")
        XCTAssertEqual(c.metadata["heard"] as? String, "Highway 192.2 today.")
        XCTAssertTrue(PropertyListSerialization.propertyList(c.metadata, isValidFor: .binary))
        XCTAssertEqual(WatchVoiceCapture(metadata: c.metadata)?.heard, "Highway 192.2 today.")
        // No hearing (a Watch that cannot run the model): no key, as before.
        XCTAssertNil(WatchVoiceCapture(seconds: 3, heard: "   ").metadata["heard"])
        XCTAssertNil(WatchVoiceCapture(metadata: WatchVoiceCapture(id: "c-8", seconds: 3).metadata)?.heard)
        XCTAssertEqual(WatchVoiceCapture(seconds: 1, heard: String(repeating: "a", count: 9000)).heard?.count, WatchVoiceCapture.maxHeard)
    }

    // MARK: what the Watch row shows

    private func status(_ step: Int = 0, line: String = "Sent to your iPhone", hearing: Bool? = nil) -> WatchCaptureStatus {
        WatchCaptureStatus(id: "c1", seconds: 3, at: Date(timeIntervalSince1970: 0), step: step, line: line, hearing: hearing)
    }

    func testRowFromRecordingToFiled() {
        // Just recorded on a Watch that writes speech down: no words yet.
        var s = status(hearing: true)
        XCTAssertNil(s.words)
        XCTAssertEqual(s.status, "Writing it down")
        XCTAssertEqual(s.banner, "Writing it down")
        // A second or two later: the Watch's own words at once.
        s.heardOnWatch("Highway 192.2 today.")
        XCTAssertEqual(s.words, "Heard: Highway 192.2 today.")
        XCTAssertEqual(s.status, "Sent to your iPhone")
        XCTAssertEqual(s.banner, "Heard: Highway 192.2 today.")
        // The iPhone has the recording.
        XCTAssertTrue(s.advance(step: 1, line: "Your iPhone is writing it down"))
        XCTAssertEqual(s.status, "Your iPhone is writing it down")
        XCTAssertEqual(s.words, "Heard: Highway 192.2 today.")
        // Saved: the iPhone's words replace the Watch's.
        XCTAssertTrue(s.apply(WatchCaptureResult(id: "c1", state: .saved, text: "I weigh 192.2 today.", outcome: "In your diary, filing it")))
        XCTAssertEqual(s.words, "Heard: I weigh 192.2 today.")
        XCTAssertEqual(s.status, "In your diary, filing it")
        XCTAssertEqual(s.banner, "In your diary, filing it")
        XCTAssertTrue(s.finished)
        // Filed.
        XCTAssertTrue(s.apply(WatchCaptureResult(id: "c1", state: .filed, text: "I weigh 192.2 today.", filed: "Logs: weight 192.2 lb")))
        XCTAssertEqual(s.words, "Heard: I weigh 192.2 today.")
        XCTAssertEqual(s.status, "Filed: Logs: weight 192.2 lb")
        XCTAssertEqual(s.filed, "Logs: weight 192.2 lb")
        // A late copy of the saved result, or the delivery, changes nothing.
        XCTAssertFalse(s.apply(WatchCaptureResult(id: "c1", state: .saved, text: "I weigh 192.2 today.", outcome: "In your diary, filing it")))
        XCTAssertFalse(s.advance(step: 1, line: "Your iPhone is writing it down"))
        XCTAssertEqual(s.status, "Filed: Logs: weight 192.2 lb")
    }

    func testRowOnAWatchThatCannotWriteSpeechDown() {
        var s = status(line: "Waiting for your iPhone")
        XCTAssertNil(s.words)
        XCTAssertEqual(s.banner, "Waiting for your iPhone")
        // The filed result can come before the saved one (queued messages): it still shows, words and all.
        XCTAssertTrue(s.apply(WatchCaptureResult(id: "c1", state: .filed, text: "call the vet tomorrow", filed: "Tasks: Call the vet")))
        XCTAssertEqual(s.words, "Heard: call the vet tomorrow")
        XCTAssertEqual(s.status, "Filed: Tasks: Call the vet")
        XCTAssertFalse(s.apply(WatchCaptureResult(id: "c1", state: .saved, text: "call the vet tomorrow", outcome: "In your diary, filing it")))
    }

    func testRowWhenTheWatchGivesUpOrTheIPhoneHearsNothing() {
        var s = status(hearing: true)
        s.heardOnWatch(nil)
        XCTAssertNil(s.words)
        XCTAssertNil(s.hearing)
        XCTAssertEqual(s.status, "Sent to your iPhone")
        // Whisper can make words out of silence: when the iPhone heard nothing, the Watch's words are not shown.
        var t = status()
        t.heardOnWatch("Thank you.")
        XCTAssertTrue(t.apply(WatchCaptureResult(id: "c1", state: .nothing)))
        XCTAssertNil(t.words)
        XCTAssertTrue(t.failed)
        XCTAssertEqual(t.status, "Heard nothing. Try again a little closer.")
        // Not saved: the words stay, so the owner sees what was lost.
        var u = status()
        u.heardOnWatch("buy milk")
        XCTAssertTrue(u.apply(WatchCaptureResult(id: "c1", state: .failed, error: "Not saved on your iPhone.")))
        XCTAssertEqual(u.words, "Heard: buy milk")
        XCTAssertEqual(u.status, "Not saved on your iPhone.")
        // Waiting is not finished and does not drop the Watch's words.
        var w = status(1, line: "Your iPhone is writing it down")
        w.heardOnWatch("note to self")
        XCTAssertTrue(w.apply(WatchCaptureResult(id: "c1", state: .waiting)))
        XCTAssertFalse(w.finished)
        XCTAssertEqual(w.words, "Heard: note to self")
    }

    /// The last capture stays under the buttons until the next one, however long ago it was.
    func testTheNewestCaptureStaysShown() throws {
        let old = WatchCaptureStatus(id: "a", seconds: 2, at: Date(timeIntervalSince1970: 0), step: 5, line: "Filed: Notes: x", filed: "Notes: x")
        let newer = WatchCaptureStatus(id: "b", seconds: 2, at: Date(), step: 0, line: "Sent to your iPhone")
        XCTAssertEqual(WatchCaptureStatus.shown([old])?.id, "a")
        XCTAssertEqual(WatchCaptureStatus.shown([newer, old])?.id, "b")
        XCTAssertNil(WatchCaptureStatus.shown([]))
    }

    /// Rows kept on the Watch before this change (no hearing, no filed) still read.
    func testRowsSavedBeforeStillDecode() throws {
        let json = #"[{"id":"x","seconds":4,"at":100,"step":4,"line":"Saved as a task: call the vet","failed":false}]"#
        let rows = try JSONDecoder().decode([WatchCaptureStatus].self, from: Data(json.utf8))
        XCTAssertEqual(rows.first?.status, "Saved as a task: call the vet")
        XCTAssertNil(rows.first?.words)
        XCTAssertNil(rows.first?.filed)
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

    func testQueueKeepsTheWatchHearingUntilFinishedAndRemembersWhatAwaitsFiling() throws {
        let q = WatchCaptureQueue(folder: folder)
        let c = WatchVoiceCapture(id: "c-2", seconds: 3)
        try q.add(c, moving: try recording())
        q.setHeard("c-2", " Highway 192.2 today. ")
        XCTAssertEqual(q.entry("c-2")?.capture.heard, "Highway 192.2 today.")
        XCTAssertEqual(q.entry("c-2")?.capture.metadata["heard"] as? String, "Highway 192.2 today.")
        XCTAssertTrue(q.awaitingFiling().isEmpty)
        q.finish("c-2", awaitsFiling: true)
        // The words leave the queue with the recording; only the fact that the Watch waits for the filing stays.
        XCTAssertNil(q.entry("c-2")?.capture.heard)
        XCTAssertEqual(q.awaitingFiling().map(\.capture.id), ["c-2"])
        XCTAssertTrue(q.pending().isEmpty)
        q.filingTold("c-2")
        XCTAssertTrue(q.awaitingFiling().isEmpty)
        XCTAssertNotNil(q.entry("c-2"))
        // A capture finished without filing to wait for (heard nothing, failed) is never waited on.
        let d = WatchVoiceCapture(id: "c-3", seconds: 3)
        try q.add(d, moving: try recording())
        q.finish("c-3")
        XCTAssertTrue(q.awaitingFiling().isEmpty)
    }
}
