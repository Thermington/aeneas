import XCTest
@testable import EACore

final class AppReportTests: XCTestCase {
    func testEachPlatformSaysWhichAppAndVersionItIs() throws {
        let info: [String: Any] = ["CFBundleShortVersionString": "1.0.5", "CFBundleVersion": "202611191200"]
        XCTAssertEqual(AppReport.current(platform: .iphone, info: info), AppReport(kind: "ios", version: "1.0.5", build: "202611191200"))
        XCTAssertEqual(AppReport.current(platform: .ipad, info: info)?.kind, "ipados")
        XCTAssertEqual(AppReport.current(platform: .mac, info: info)?.kind, "macos")
        XCTAssertEqual(AppReport.current(platform: .watch, info: info)?.kind, "watchos")
        // The hub takes only a plain version and a short build.
        XCTAssertNil(AppReport.current(platform: .iphone, info: ["CFBundleShortVersionString": "1.0"]))
        XCTAssertNil(AppReport.current(platform: .iphone, info: ["CFBundleShortVersionString": "1.0.5", "CFBundleVersion": "has spaces"])?.build)
        let json = String(decoding: try JSONCoding.data(AppReport(kind: "ios", version: "1.0.5", build: nil)), as: UTF8.self)
        XCTAssertTrue(json.contains("\"kind\":\"ios\"") && json.contains("\"version\":\"1.0.5\""), json)
    }
}
