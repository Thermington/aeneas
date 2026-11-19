import Foundation
#if os(iOS) || os(macOS)
import Network
#endif

/// Finding the devices on a helped person's home network, when they press Find the devices in my home (People who help
/// you; docs/helpers.md): which addresses answer on a few telling ports, and the names devices announce over Bonjour.
/// The same ports and labels as the Windows and Android apps (web/src-tauri/src/helper.rs). Only the home network is
/// asked; nothing leaves it. iOS asks once for Local Network access (Info.plist says why).
public enum HomeNetwork {
    /// Ports that say what a device is and how a helper could reach it.
    public static let ports = [22, 80, 443, 445, 548, 554, 631, 1400, 3389, 5900, 8009, 8080, 9100, 62078]
    /// Bonjour names devices announce for themselves (also in Info.plist's NSBonjourServices).
    public static let services = ["_device-info._tcp", "_companion-link._tcp", "_airplay._tcp", "_raop._tcp", "_googlecast._tcp", "_ipp._tcp",
                                  "_printer._tcp", "_smb._tcp", "_ssh._tcp", "_rfb._tcp", "_http._tcp", "_hap._tcp"]

    /// A private IPv4 address (10/8, 172.16/12, 192.168/16).
    public static func isPrivate(_ ip: String) -> Bool {
        let p = ip.split(separator: ".").compactMap { Int($0) }
        guard p.count == 4, p.allSatisfy({ (0...255).contains($0) }) else { return false }
        return p[0] == 10 || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 192 && p[1] == 168)
    }

    /// "192.168.1.0/24" and the first three parts, for an address on it.
    public static func network(of ip: String) -> (cidr: String, prefix: String)? {
        let p = ip.split(separator: ".")
        guard p.count == 4, isPrivate(ip) else { return nil }
        let prefix = p.prefix(3).joined(separator: ".")
        return ("\(prefix).0/24", prefix)
    }

    /// This device's private IPv4 address: Wi-Fi first (en0 on an iPhone; Wi-Fi or Ethernet on a Mac), then any other.
    public static func localIPv4() -> String? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var found: [(name: String, ip: String)] = []
        var cur: UnsafeMutablePointer<ifaddrs>? = first
        while let i = cur {
            defer { cur = i.pointee.ifa_next }
            guard let sa = i.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET), (i.pointee.ifa_flags & UInt32(IFF_UP)) != 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString: host)
            if isPrivate(ip) { found.append((String(cString: i.pointee.ifa_name), ip)) }
        }
        return (found.first { $0.name == "en0" } ?? found.first { $0.name.hasPrefix("en") } ?? found.first)?.ip
    }

    /// Looks for the devices on this device's home network (about 15 seconds). Throws when it is on none.
    #if os(iOS) || os(macOS)
    public static func scan(timeout: Double = 0.5, concurrency: Int = 96) async throws -> (network: String, devices: [HomeDevice]) {
        guard let me = localIPv4(), let net = network(of: me) else { throw ScanError.noHomeNetwork }
        async let named = announcedNames(wait: 4)
        var open: [String: [Int]] = [:]
        let targets = (1...254).flatMap { h in ports.map { ("\(net.prefix).\(h)", $0) } }
        await withTaskGroup(of: (String, Int)?.self) { group in
            var next = 0
            func add() {
                guard next < targets.count else { return }
                let (ip, port) = targets[next]
                next += 1
                group.addTask { await probe(host: ip, port: port, timeout: timeout) ? (ip, port) : nil }
            }
            for _ in 0..<min(concurrency, targets.count) { add() }
            while let r = await group.next() {
                if let (ip, port) = r { open[ip, default: []].append(port) }
                add()
            }
        }
        let names = await named
        for ip in names.keys where ip.hasPrefix(net.prefix + ".") { if open[ip] == nil { open[ip] = [] } }
        let devices = open.keys.sorted { a, b in (Int(a.split(separator: ".").last ?? "") ?? 0) < (Int(b.split(separator: ".").last ?? "") ?? 0) }.map { ip -> HomeDevice in
            let ports = open[ip]!.sorted()
            let announced = names[ip] ?? ""
            return HomeDevice(name: ip == me ? "This device" : announced, ip: ip, open: ports, kind: HomeDeviceKind.kind(ip: ip, open: ports, announced: announced))
        }
        return (net.cidr, devices)
    }

    public enum ScanError: Error, LocalizedError {
        case noHomeNetwork
        public var errorDescription: String? { "This device is not on a home Wi-Fi network now." }
    }

    /// Whether `host` takes a TCP connection on `port` within `timeout` seconds.
    static func probe(host: String, port: Int, timeout: Double) async -> Bool {
        guard let p = NWEndpoint.Port(rawValue: UInt16(port)) else { return false }
        let conn = NWConnection(host: NWEndpoint.Host(host), port: p, using: .tcp)
        let once = FirstCall()
        return await withCheckedContinuation { cont in
            let finish = { (ok: Bool) in
                guard once.first() else { return }
                conn.stateUpdateHandler = nil
                conn.cancel()
                cont.resume(returning: ok)
            }
            conn.stateUpdateHandler = { s in
                switch s {
                case .ready: finish(true)
                // Refused, or no route: nothing answers there.
                case .waiting, .failed, .cancelled: finish(false)
                default: break
                }
            }
            conn.start(queue: probeQueue)
            probeQueue.asyncAfter(deadline: .now() + timeout) { finish(false) }
        }
    }

    private static let probeQueue = DispatchQueue(label: "aeneas.homenetwork", attributes: .concurrent)

    /// Bonjour names by IPv4 address, listening `wait` seconds. A service's address comes from connecting to it.
    static func announcedNames(wait: Double) async -> [String: String] {
        let found = Guarded<[(name: String, endpoint: NWEndpoint)]>([])
        let browsers = services.map { NWBrowser(for: .bonjour(type: $0, domain: nil), using: .tcp) }
        for b in browsers {
            b.browseResultsChangedHandler = { results, _ in
                for r in results {
                    if case let .service(name, _, _, _) = r.endpoint { found.update { $0.append((name, r.endpoint)) } }
                }
            }
            b.start(queue: probeQueue)
        }
        try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
        browsers.forEach { $0.cancel() }
        var seen = Set<String>()
        let unique = found.value.filter { seen.insert("\($0.endpoint)").inserted }
        var out: [String: String] = [:]
        await withTaskGroup(of: (String, String)?.self) { group in
            for s in unique.prefix(64) {
                group.addTask { await resolve(s.endpoint, timeout: 1.5).map { ($0, s.name) } }
            }
            for await r in group { if let (ip, name) = r, isPrivate(ip), out[ip] == nil { out[ip] = name } }
        }
        return out
    }

    /// The IPv4 address behind a Bonjour service, by connecting to it.
    private static func resolve(_ endpoint: NWEndpoint, timeout: Double) async -> String? {
        let params = NWParameters.tcp
        if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let conn = NWConnection(to: endpoint, using: params)
        let once = FirstCall()
        return await withCheckedContinuation { cont in
            let finish = { (ip: String?) in
                guard once.first() else { return }
                conn.stateUpdateHandler = nil
                conn.cancel()
                cont.resume(returning: ip)
            }
            conn.stateUpdateHandler = { s in
                switch s {
                case .ready:
                    if case let .hostPort(host, _)? = conn.currentPath?.remoteEndpoint, case let .ipv4(a) = host {
                        finish("\(a)".split(separator: "%").first.map(String.init))
                    } else { finish(nil) }
                case .waiting, .failed, .cancelled: finish(nil)
                default: break
                }
            }
            conn.start(queue: probeQueue)
            probeQueue.asyncAfter(deadline: .now() + timeout) { finish(nil) }
        }
    }
    #endif
}

/// True once, for the first caller.
private final class FirstCall: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func first() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}

/// A value several queues add to.
private final class Guarded<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T { lock.lock(); defer { lock.unlock() }; return v }
    func update(_ f: (inout T) -> Void) { lock.lock(); defer { lock.unlock() }; f(&v) }
}

#if os(macOS)
/// A helped person's Mac running a command its helper sent (docs/helpers.md): /bin/zsh -c, output and errors together,
/// stopped with everything it started after `timeout` seconds, at most 200 KB of output. The Mac app is sandboxed, so
/// a command reaches what the app may: enough to look at the Mac, not to change system settings.
public enum HelperCommand {
    public static let maxOutput = 200_000

    public static func run(_ command: String, timeout: TimeInterval) async -> (exitCode: Int, output: String) {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                cont.resume(returning: runBlocking(command, timeout: timeout))
            }
        }
    }

    static func runBlocking(_ command: String, timeout: TimeInterval) -> (exitCode: Int, output: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-c", command]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        p.standardInput = FileHandle.nullDevice
        let out = Guarded(Data())
        pipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; return }
            out.update { if $0.count < maxOutput + 4096 { $0.append(d) } }
        }
        do { try p.run() } catch { return (1, "The command could not start: \(error.localizedDescription)") }
        let done = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in done.signal() }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            stopTree(p.processIdentifier)
            p.terminate()
            _ = done.wait(timeout: .now() + 2)
            pipe.fileHandleForReading.readabilityHandler = nil
            return (124, "Stopped after \(Int(timeout)) seconds.")
        }
        // What is still in the pipe after the end.
        let rest = pipe.fileHandleForReading.readDataToEndOfFile()
        pipe.fileHandleForReading.readabilityHandler = nil
        out.update { $0.append(rest) }
        return (Int(p.terminationStatus), cut(String(decoding: out.value, as: UTF8.self)))
    }

    static func cut(_ s: String) -> String {
        guard s.utf8.count > maxOutput else { return s }
        var t = String(decoding: Array(s.utf8.prefix(maxOutput)), as: UTF8.self)
        if t.hasSuffix("\u{FFFD}") { t.removeLast() }
        return t + "\n[cut]"
    }

    /// Everything a command started, children first, then the command.
    private static func stopTree(_ pid: Int32) {
        for child in children(of: pid) { stopTree(child) }
        kill(pid, SIGKILL)
    }

    private static func children(of pid: Int32) -> [Int32] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        p.arguments = ["-P", String(pid)]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return [] }
        p.waitUntilExit()
        return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(whereSeparator: \.isNewline).compactMap { Int32($0) }
    }
}
#endif
