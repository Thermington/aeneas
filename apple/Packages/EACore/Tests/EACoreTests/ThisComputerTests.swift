import XCTest
@testable import EACore

/// This Mac in Tech (ThisComputer): the lines the hub parses from a computer's own app, and the name it is kept under.
final class ThisComputerTests: XCTestCase {
    /// The hub's REPORT_NAME (hub/src/hostsensors.ts).
    private func hubTakes(_ name: String) -> Bool { name.range(of: #"^[a-z0-9][a-z0-9._-]{0,62}$"#, options: .regularExpression) != nil }

    func testWritesTheHubsLinesWithOneDecimalAndADot() {
        let out = ThisComputer.lines(.init(cpu: 12.34, memory: 61.8, disk: 84.26, os: "macOS 26.1"))
        XCTAssertEqual(out, "cpu 12.3\nmem 61.8\ndisk / 84.3\nos macOS 26.1")
        XCTAssertFalse(out.contains(","), "a comma would make the hub read 89,3 as 89")
    }

    func testLeavesOutWhatWasNotReadAndKeepsPercentsInRange() {
        XCTAssertEqual(ThisComputer.lines(.init(cpu: nil, memory: 140, disk: .nan, os: "  ")), "mem 100.0")
        XCTAssertEqual(ThisComputer.lines(.init(cpu: -3, memory: nil, disk: .infinity, os: nil)), "cpu 0.0")
        XCTAssertEqual(ThisComputer.lines(.init()), "")
    }

    func testWritesTheVersionAsSwVersDoes() {
        XCTAssertEqual(ThisComputer.osLine(OperatingSystemVersion(majorVersion: 26, minorVersion: 1, patchVersion: 0)), "macOS 26.1")
        XCTAssertEqual(ThisComputer.osLine(OperatingSystemVersion(majorVersion: 26, minorVersion: 1, patchVersion: 2)), "macOS 26.1.2")
        XCTAssertEqual(ThisComputer.osLine(OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0)), "macOS 26.0")
    }

    func testNamesTheComputerAsTheHubTakesIt() {
        XCTAssertEqual(ThisComputer.reportName("Taylors-MacBook-Pro.local"), "taylors-macbook-pro")
        XCTAssertEqual(ThisComputer.reportName("Alex’s MacBook Air"), "alexsmacbookair")
        XCTAssertEqual(ThisComputer.reportName("Mac_Studio"), "mac_studio")
        XCTAssertEqual(ThisComputer.reportName("-_mini.lan"), "mini")
        XCTAssertEqual(ThisComputer.reportName("Café-Mac"), "caf-mac")
        XCTAssertNil(ThisComputer.reportName(""))
        XCTAssertNil(ThisComputer.reportName(".local"))
        XCTAssertNil(ThisComputer.reportName("___"))
        let long = ThisComputer.reportName(String(repeating: "a", count: 80))
        XCTAssertEqual(long?.count, 63)
        for host in ["Taylors-MacBook-Pro.local", "Alex’s MacBook Air", "-_mini.lan", String(repeating: "b", count: 90)] {
            XCTAssertTrue(hubTakes(ThisComputer.reportName(host) ?? ""), host)
        }
    }

    func testCPUIsTheBusyShareBetweenTwoSamplesEvenWhenACounterWraps() {
        let a = ThisComputer.CPUTicks(user: 1000, system: 500, idle: 8000, nice: 0)
        let b = ThisComputer.CPUTicks(user: 1150, system: 550, idle: 8800, nice: 0)
        XCTAssertEqual(ThisComputer.cpuBusy(from: a, to: b)!, 20, accuracy: 0.001)
        // A 32-bit counter that went past its top between the samples still counts what passed.
        let wrapA = ThisComputer.CPUTicks(user: UInt32.max - 49, system: 0, idle: UInt32.max - 99, nice: 0)
        let wrapB = ThisComputer.CPUTicks(user: 50, system: 0, idle: 100, nice: 0)
        XCTAssertEqual(ThisComputer.cpuBusy(from: wrapA, to: wrapB)!, 33.333, accuracy: 0.01)
        XCTAssertNil(ThisComputer.cpuBusy(from: a, to: a), "no time passed")
    }

    func testMemoryIsActiveWiredAndCompressedOverAllMemory() {
        let page: UInt64 = 16384
        let total: UInt64 = 16 * 1024 * 1024 * 1024
        let pages = total / page
        let used = ThisComputer.memoryUsed(active: pages / 4, wired: pages / 8, compressed: pages / 8, pageSize: page, total: total)
        XCTAssertEqual(used!, 50, accuracy: 0.001)
        XCTAssertNil(ThisComputer.memoryUsed(active: 1, wired: 1, compressed: 1, pageSize: page, total: 0))
    }

    func testDiskIsWhatIsNotAvailableOverItsSize() {
        XCTAssertEqual(ThisComputer.diskUsed(total: 1000, available: 250)!, 75, accuracy: 0.001)
        XCTAssertEqual(ThisComputer.diskUsed(total: 1000, available: 2000)!, 0, accuracy: 0.001)
        XCTAssertNil(ThisComputer.diskUsed(total: 0, available: 0))
    }

    #if os(macOS)
    /// This Mac, read for real: every line is one the hub parses, with a number it reads.
    func testReadsThisMacInTheHubsFormat() async throws {
        let out = await ThisComputer.output(cpuSeconds: 0.5)
        let lines = out.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.map { $0.split(separator: " ").first.map(String.init) ?? "" }, ["cpu", "mem", "disk", "os"], out)
        for line in lines.dropLast() {
            let value = try XCTUnwrap(Double(line.split(separator: " ").last.map(String.init) ?? ""), line)
            XCTAssertTrue((0...100).contains(value), line)
        }
        XCTAssertTrue(lines.last?.hasPrefix("os macOS ") == true, out)
        XCTAssertTrue(lines.contains { $0.hasPrefix("disk / ") })
        XCTAssertTrue(hubTakes(ThisComputer.reportName(ThisComputer.hostName()) ?? ""), ThisComputer.hostName())
    }
    #endif

    func testMemoryIsWhatMemoryPressureReads() {
        XCTAssertEqual(ThisComputer.memoryUsed(freePercent: 57), 43)
        XCTAssertNil(ThisComputer.memoryUsed(freePercent: -1))
        XCTAssertNil(ThisComputer.memoryUsed(freePercent: 101))
    }
}
