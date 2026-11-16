import XCTest
@testable import EACore

final class TranscriptJoinerTests: XCTestCase {
    func testAPauseThatStartsAFreshUtteranceKeepsTheEarlierWords() {
        var j = TranscriptJoiner()
        for p in ["So", "So I'm going", "So I'm going to create a flag", "So I'm going to create a flag, um,"] { j.update(p) }
        // After the pause the recognizer reports only the new words.
        for p in ["It", "It needs to be", "It needs to be a really cool one."] { j.update(p) }
        XCTAssertEqual(j.text, "So I'm going to create a flag, um, It needs to be a really cool one.")
    }

    func testRevisionsReplaceInsteadOfRepeating() {
        var j = TranscriptJoiner()
        for p in ["sew", "So I'm", "So I'm going to the store", "So I'm going to the stores"] { j.update(p) }
        XCTAssertEqual(j.text, "So I'm going to the stores")
    }

    /// SpeechAnalyzer: revisions of the stretch being heard replace each other; final stretches are kept in order.
    func testSpeechSegmentsKeepFinalStretchesAndReviseTheCurrentOne() {
        var s = SpeechSegments()
        XCTAssertEqual(s.update("remind", final: false), "remind")
        XCTAssertEqual(s.update("remind me to water", final: false), "remind me to water")
        XCTAssertEqual(s.update("Remind me to water the plants.", final: true), "Remind me to water the plants.")
        XCTAssertEqual(s.update(" at", final: false), "Remind me to water the plants. at")
        XCTAssertEqual(s.update(" At five tomorrow.", final: true), "Remind me to water the plants. At five tomorrow.")
        // A final report with nothing in it (silence) changes nothing.
        XCTAssertEqual(s.update("", final: true), "Remind me to water the plants. At five tomorrow.")
        XCTAssertEqual(s.settled, s.text)
    }

    func testARestartKeepsWhatWasHeard() {
        var j = TranscriptJoiner()
        j.update("First part.")
        j.endRun()
        j.update("Second")
        j.update("Second part.")
        XCTAssertEqual(j.text, "First part. Second part.")
    }
}
