import Foundation

/// Which of the app's logs the iPhone writes to Apple Health and which samples it wrote before come out again.
/// HealthImporter does the writing; this is the rule, pure so it is tested without HealthKit.
public enum HealthExport {
    public struct Plan: Equatable, Sendable {
        /// Logs whose samples come out of Health: deleted in the app, or changed (and written again).
        public var removals: [String] = []
        /// Logs to write: new ones, and changed ones again.
        public var writes: [String] = []
    }

    /// - Parameters:
    ///   - exported: what was written before, log id to the log's signature then.
    ///   - logs: every log this device holds, deleted ones included.
    ///   - signature: what a log looks like to Health; nil for one Health has no type for.
    /// A sample comes out only for a log this device holds as deleted or changed. A log missing from the local copy
    /// is not one the person deleted: a removed device's copy is emptied, and its export took every sample it had
    /// written out of Health.
    public static func plan(exported: [String: String], logs: [Entity], signature: (Entity) -> String?) -> Plan {
        var p = Plan()
        let byId = Dictionary(logs.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for (id, sig) in exported.sorted(by: { $0.key < $1.key }) {
            guard let e = byId[id] else { continue }
            if e.isDeleted || signature(e) != sig { p.removals.append(id) }
        }
        let removed = Set(p.removals)
        for e in logs.sorted(by: { $0.id < $1.id }) where !e.isDeleted && e.str("note") != "Apple Health" && e.str("note") != "end" {
            guard exported[e.id] == nil || removed.contains(e.id), signature(e) != nil else { continue }
            p.writes.append(e.id)
        }
        return p
    }
}
