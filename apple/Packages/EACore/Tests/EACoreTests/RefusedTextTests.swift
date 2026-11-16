import XCTest
@testable import EACore

final class RefusedTextTests: XCTestCase {
    func testTheHubsReasonInPlainWords() {
        let invalid = #"invalid fields: [{"expected":"string","code":"invalid_type","path":["due"],"message":"Invalid input"},{"path":["remind_at"]}]"#
        XCTAssertEqual(RefusedText.reason(invalid), "the hub did not accept due and remind at")
        XCTAssertEqual(RefusedText.reason("invalid fields"), "the hub did not accept what was changed")
        XCTAssertEqual(RefusedText.reason("entity not found; send create: true to create it"), "it is no longer on the hub")
        XCTAssertEqual(RefusedText.reason("kind mismatch: entity is task"), "the hub has it as another kind of item")
        XCTAssertEqual(RefusedText.reason("ts is not a date and time"), "ts is not a date and time")
        XCTAssertEqual(RefusedText.reason("work space is erased: {\"x\":1}"), "work space is erased")
        XCTAssertEqual(RefusedText.reason(""), "the hub said no")
    }

    func testWhatWasChangedLineByLine() {
        let fields = #"{"title":"Call the vet about Rex","remind_at":"2026-11-16T14:00:00.000Z","done":false,"notes":"","tags":["pets"],"gone":null}"#
        XCTAssertEqual(RefusedText.values(fields), ["done: false", "remind at: 2026-11-16T14:00:00.000Z", "tags: [\"pets\"]", "title: Call the vet about Rex"])
        let long = RefusedText.values(#"{"body":"\#(String(repeating: "x", count: 500))"}"#)[0]
        XCTAssertEqual(long.count, "body: ".count + 200)
        XCTAssertTrue(long.hasSuffix("..."))
        XCTAssertEqual(RefusedText.values("not json"), ["not json"], "kept as it was rather than lost")
    }
}
