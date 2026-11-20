import Foundation
#if os(macOS)
import Darwin
import SystemConfiguration
#endif

/// A computer's own app reporting it (since 2026-11-20, the contract's "A computer's own app"): the Mac app sends this
/// Mac's readings with its own device key (`PUT /devices/me/computer`) once the person ticks Show this Mac in Tech. The
/// hub reads them as it reads the output of its own scripts (packages/shared/src/hostscripts.ts): `cpu <percent>`,
/// `mem <percent>`, `disk <mount> <percent>` and `os <what it runs>`. The app is sandboxed and cannot run top,
/// memory_pressure, df or sw_vers, so it reads the same things natively and writes those lines itself.
public enum ThisComputer {
    /// What the readings were; nil leaves that line out, as the hub's scripts do when a tool says nothing.
    public struct Reading: Equatable, Sendable {
        public var cpu: Double?
        public var memory: Double?
        /// The startup disk, written as the hub's Mac script writes it (`disk / <percent>`).
        public var disk: Double?
        /// "macOS 26.1".
        public var os: String?
        public init(cpu: Double? = nil, memory: Double? = nil, disk: Double? = nil, os: String? = nil) {
            self.cpu = cpu; self.memory = memory; self.disk = disk; self.os = os
        }
    }

    /// The lines the hub parses. Numbers always have a dot: the Windows script once wrote 89,3 on a German Windows and
    /// the hub read 89.
    public static func lines(_ r: Reading) -> String {
        var out: [String] = []
        if let v = percent(r.cpu) { out.append("cpu \(v)") }
        if let v = percent(r.memory) { out.append("mem \(v)") }
        if let v = percent(r.disk) { out.append("disk / \(v)") }
        if let os = r.os?.trimmingCharacters(in: .whitespacesAndNewlines), !os.isEmpty { out.append("os \(os)") }
        return out.joined(separator: "\n")
    }

    private static let posix = Locale(identifier: "en_US_POSIX")

    /// One decimal, 0 to 100; nil for nothing or a number that is not one.
    static func percent(_ v: Double?) -> String? {
        guard let v, v.isFinite else { return nil }
        return String(format: "%.1f", locale: posix, min(100, max(0, v)))
    }

    /// "macOS 26.1", or "macOS 26.1.2" with a patch, as `sw_vers` writes it.
    public static func osLine(_ v: OperatingSystemVersion) -> String {
        "macOS \(v.majorVersion).\(v.minorVersion)\(v.patchVersion > 0 ? ".\(v.patchVersion)" : "")"
    }

    /// The name the hub keeps the computer under: the short host name (before the first dot), lowercased, with only
    /// letters a to z, digits, dots, dashes and underscores, starting with a letter or digit (the hub's REPORT_NAME,
    /// at most 63 characters). Nil when nothing is left.
    public static func reportName(_ host: String) -> String? {
        let short = host.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789._-")
        var name = String(short.lowercased().filter { allowed.contains($0) })
        while let f = name.first, !(f.isASCII && (f.isLetter || f.isNumber)) { name.removeFirst() }
        name = String(name.prefix(63))
        return name.isEmpty ? nil : name
    }

    /// The processor's time in each state, summed over every core, as `host_statistics` counts it: ticks since the
    /// Mac started. Each counter is 32 bits and wraps after some weeks on a Mac with many cores, so differences are
    /// taken with wrapping arithmetic.
    public struct CPUTicks: Equatable, Sendable {
        public var user: UInt32
        public var system: UInt32
        public var idle: UInt32
        public var nice: UInt32
        public init(user: UInt32, system: UInt32, idle: UInt32, nice: UInt32) {
            self.user = user; self.system = system; self.idle = idle; self.nice = nice
        }
    }

    /// The percent of the time between two samples the processor was busy (everything but idle). Nil when no time
    /// passed between them.
    public static func cpuBusy(from a: CPUTicks, to b: CPUTicks) -> Double? {
        let busy = UInt64(b.user &- a.user) + UInt64(b.system &- a.system) + UInt64(b.nice &- a.nice)
        let total = busy + UInt64(b.idle &- a.idle)
        guard total > 0 else { return nil }
        return 100 * Double(busy) / Double(total)
    }

    /// Memory in use as the hub reads it on a Mac it signs in to: 100 minus the system's free percentage, the number
    /// `memory_pressure` prints ("System-wide memory free percentage"), which is the kernel's `kern.memorystatus_level`.
    /// Reading the same number keeps a Mac that reports itself comparable with one the hub reads.
    public static func memoryUsed(freePercent: Int32) -> Double? {
        guard (0...100).contains(freePercent) else { return nil }
        return Double(100 - freePercent)
    }

    /// Only when that number cannot be read: (active + wired + compressed pages) over all the physical memory, close
    /// to Activity Monitor's Memory Used, which reads higher than the free percentage does.
    public static func memoryUsed(active: UInt64, wired: UInt64, compressed: UInt64, pageSize: UInt64, total: UInt64) -> Double? {
        guard total > 0, pageSize > 0 else { return nil }
        return 100 * Double((active + wired + compressed) * pageSize) / Double(total)
    }

    /// The startup disk's use: what is not available for important use, over its size.
    public static func diskUsed(total: Int64, available: Int64) -> Double? {
        guard total > 0 else { return nil }
        return 100 * Double(max(0, total - max(0, available))) / Double(total)
    }
}

#if os(macOS)
extension ThisComputer {
    /// This Mac's short host name, as `hostname -s` prints it on the Mac: what the hub calls a Mac it signs in to, so a
    /// Mac the hub reads itself is known by the same name.
    public static func hostName() -> String {
        var buf = [CChar](repeating: 0, count: 256)
        guard gethostname(&buf, buf.count) == 0 else { return localHostName() ?? "" }
        let full = String(cString: buf)
        let short = full.split(separator: ".").first.map(String.init) ?? ""
        return short.isEmpty || short == "localhost" ? localHostName() ?? short : short
    }

    /// The name other machines on the home network reach this Mac by, with `.local` after it (System Settings,
    /// General, Sharing, Local hostname).
    public static func localHostName() -> String? {
        guard let name = SCDynamicStoreCopyLocalHostName(nil) as String?, !name.isEmpty else { return nil }
        return name
    }

    /// What is in use now, read the way the lines above say. The processor is sampled twice, `cpuSeconds` apart (about
    /// 2 seconds, as the hub's scripts do), so this waits that long.
    public static func read(cpuSeconds: Double = 2) async -> Reading {
        var r = Reading()
        if let a = cpuTicks() {
            try? await Task.sleep(for: .seconds(cpuSeconds))
            if let b = cpuTicks() { r.cpu = cpuBusy(from: a, to: b) }
        }
        r.memory = memory()
        r.disk = disk()
        r.os = osLine(ProcessInfo.processInfo.operatingSystemVersion)
        return r
    }

    /// The report's `output`: this Mac's lines in the hub's format.
    public static func output(cpuSeconds: Double = 2) async -> String { lines(await read(cpuSeconds: cpuSeconds)) }

    static func cpuTicks() -> CPUTicks? {
        var info = host_cpu_load_info()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info_data_t>.size / MemoryLayout<integer_t>.size)
        let ok = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count) }
        }
        guard ok == KERN_SUCCESS else { return nil }
        let t = info.cpu_ticks
        return CPUTicks(user: t.0, system: t.1, idle: t.2, nice: t.3)
    }

    static func memory() -> Double? {
        var level: Int32 = 0
        var size = MemoryLayout<Int32>.size
        if sysctlbyname("kern.memorystatus_level", &level, &size, nil, 0) == 0, let used = memoryUsed(freePercent: level) { return used }
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let ok = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
        }
        guard ok == KERN_SUCCESS else { return nil }
        var page: vm_size_t = 0
        guard host_page_size(mach_host_self(), &page) == KERN_SUCCESS else { return nil }
        return memoryUsed(active: UInt64(stats.active_count), wired: UInt64(stats.wire_count), compressed: UInt64(stats.compressor_page_count),
                          pageSize: UInt64(page), total: ProcessInfo.processInfo.physicalMemory)
    }

    static func disk() -> Double? {
        let keys: Set<URLResourceKey> = [.volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey]
        guard let v = try? URL(fileURLWithPath: "/").resourceValues(forKeys: keys), let total = v.volumeTotalCapacity,
              let available = v.volumeAvailableCapacityForImportantUsage else { return nil }
        return diskUsed(total: Int64(total), available: available)
    }
}
#endif
