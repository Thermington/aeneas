import XCTest
@testable import EAWhisper

final class HearingSupportTests: XCTestCase {
    /// WhisperKit's table decides: Series 9, Ultra 2 and later run base; older Watches are not listed and keep the
    /// iPhone writing speech down.
    func testWhichWatchesRunBase() {
        for device in ["Watch7,1", "Watch7,5", "Watch7,9", "Watch7,12", "Watch8,1"] {
            XCTAssertTrue(HearingSupport.canRun("openai_whisper-base.en", device: device), device)
            XCTAssertTrue(HearingSupport.canRun("openai_whisper-base", device: device), device)
            XCTAssertTrue(HearingSupport.canRun("openai_whisper-tiny.en", device: device), device)
        }
        for device in ["Watch6,14", "Watch6,18", "Watch6,6", "Watch5,1", "Watch4,1"] {
            XCTAssertFalse(HearingSupport.canRun("openai_whisper-base.en", device: device), device)
        }
        // A listed Watch is not offered the large models.
        XCTAssertFalse(HearingSupport.canRun("openai_whisper-small.en", device: "Watch7,9"))
        // A Mac (as in the Watch simulator) is not a Watch WhisperKit lists for these, whatever it could run.
        XCTAssertFalse(HearingSupport.canRun("openai_whisper-base.en", device: "Mac99,1"))
    }

    func testCleanJoinsWindows() {
        XCTAssertEqual(WatchHearing.clean("  I weigh 192.2 today.\n  Then  more "), "I weigh 192.2 today. Then more")
    }
}
