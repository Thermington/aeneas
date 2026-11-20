import XCTest
@testable import EACore

final class LiveHearingTests: XCTestCase {
    private let rate = LiveHearing.sampleRate

    // MARK: which audio a pass hears

    func testAPassHearsWhatHasBeenSaidUpToThirtySeconds() {
        // Under a second: nothing to hear yet.
        XCTAssertNil(LiveHearing.window(recorded: 0))
        XCTAssertNil(LiveHearing.window(recorded: Int(0.9 * rate)))
        // From the start while the capture is short.
        let short = LiveHearing.window(recorded: Int(1 * rate))
        XCTAssertEqual(short?.range, 0..<16_000)
        XCTAssertEqual(short?.cut, false)
        let twelve = LiveHearing.window(recorded: Int(12.5 * rate))
        XCTAssertEqual(twelve?.range, 0..<200_000)
        XCTAssertEqual(twelve?.cut, false)
        // Exactly Whisper's 30 seconds: all of it.
        XCTAssertEqual(LiveHearing.window(recorded: 480_000)?.range, 0..<480_000)
        XCTAssertEqual(LiveHearing.window(recorded: 480_000)?.cut, false)
        // A long capture: the latest 30 seconds, and older speech is left out.
        let long = LiveHearing.window(recorded: Int(95 * rate))
        XCTAssertEqual(long?.range, Int(65 * rate)..<Int(95 * rate))
        XCTAssertEqual(long?.range.count, 480_000)
        XCTAssertEqual(long?.cut, true)
    }

    func testTheNextPassWaitsForNewSpeech() {
        // Nothing heard yet and a second recorded: hear it.
        XCTAssertTrue(LiveHearing.due(recorded: 16_000, heard: 0))
        // Too little recorded to hear at all.
        XCTAssertFalse(LiveHearing.due(recorded: 12_000, heard: 0))
        // A fast pass right after the last: not until half a second more has been said.
        XCTAssertFalse(LiveHearing.due(recorded: 40_000, heard: 36_000))
        XCTAssertTrue(LiveHearing.due(recorded: 44_000, heard: 36_000))
        // A slow pass: plenty has been said meanwhile, so the next one starts at once.
        XCTAssertTrue(LiveHearing.due(recorded: 200_000, heard: 100_000))
    }

    // MARK: how the shown words change

    func testWordsFirmUpWhenTwoPassesAgree() {
        var w = LiveWords()
        XCTAssertTrue(w.isEmpty)
        XCTAssertEqual(w.shown, "")
        // First pass: everything may still change.
        w = w.updated(with: " I weigh ", cut: false)
        XCTAssertEqual(w.firmText, "")
        XCTAssertEqual(w.tentativeText, "I weigh")
        // Second pass agrees on what was said before and adds more.
        w = w.updated(with: "I weigh 192", cut: false)
        XCTAssertEqual(w.firmText, "I weigh")
        XCTAssertEqual(w.tentativeText, "192")
        XCTAssertEqual(w.shown, "I weigh 192")
        // Capitals and punctuation do not make a word different.
        w = w.updated(with: "I weigh 192.2 today.", cut: false)
        XCTAssertEqual(w.firmText, "I weigh")
        XCTAssertEqual(w.tentativeText, "192.2 today.")
        w = w.updated(with: "i weigh, 192.2 today", cut: false)
        XCTAssertEqual(w.firmText, "i weigh, 192.2 today")
        XCTAssertEqual(w.tentativeText, "")
    }

    func testAHearingThatChangesItsMindLosesItsFirmWordsFromThere() {
        var w = LiveWords().updated(with: "Highway 192", cut: false).updated(with: "Highway 192.2", cut: false)
        XCTAssertEqual(w.firmText, "Highway")
        // More speech makes the start clear: from the first word that differs, nothing is firm.
        w = w.updated(with: "I weigh 192.2 today", cut: false)
        XCTAssertEqual(w.firmText, "")
        XCTAssertEqual(w.tentativeText, "I weigh 192.2 today")
    }

    func testAPassThatHearsNothingKeepsTheLastWords() {
        let w = LiveWords().updated(with: "remind me to", cut: false)
        XCTAssertEqual(w.updated(with: "", cut: false), w)
        XCTAssertEqual(w.updated(with: "   ", cut: false), w)
        // Whisper's notes for sounds that are not speech are not words.
        XCTAssertEqual(w.updated(with: "[BLANK_AUDIO]", cut: false), w)
        XCTAssertEqual(w.updated(with: " (wind blowing) *coughs* ", cut: false), w)
        XCTAssertEqual(LiveWords().updated(with: "[Music] call the vet", cut: false).tentativeText, "call the vet")
    }

    func testALongCaptureShowsItsLatestPart() {
        // The latest 30 seconds start partway through a word: that first word is left out, and "…" says there was more.
        var w = LiveWords().updated(with: "ning walk with Biscuit then coffee", cut: true)
        XCTAssertTrue(w.cut)
        XCTAssertEqual(w.tentativeText, "walk with Biscuit then coffee")
        XCTAssertEqual(w.shown, "… walk with Biscuit then coffee")
        w = w.updated(with: "ning walk with Biscuit then coffee at", cut: true)
        XCTAssertEqual(w.firmText, "walk with Biscuit then coffee")
        XCTAssertEqual(w.shown, "… walk with Biscuit then coffee at")
        XCTAssertEqual(w.tentativeText, "at")
        // A cut pass of one word that may be half a word shows nothing new.
        XCTAssertEqual(w.updated(with: "ning", cut: true), w)
    }

    func testSilenceIsNotHeard() {
        XCTAssertTrue(LiveHearing.quiet([]))
        XCTAssertTrue(LiveHearing.quiet([Float](repeating: 0, count: 16_000)))
        // A muted microphone's hiss, far under a voice.
        XCTAssertTrue(LiveHearing.quiet((0..<16_000).map { i in Float(i % 2 == 0 ? 0.001 : -0.001) }))
        // Two seconds of a quiet voice in thirty seconds of silence is still speech.
        var some = [Float](repeating: 0, count: 30 * 16_000)
        for i in 0..<(2 * 16_000) { some[i] = Float(sin(Double(i) / 8)) * 0.05 }
        XCTAssertFalse(LiveHearing.quiet(some))
    }
}
