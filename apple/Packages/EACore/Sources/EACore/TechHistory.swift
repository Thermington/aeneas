import Foundation

// History (Tech, since 2026-11-19): what happened on a machine or place, newest first, put together from what every
// device already has: changes (`journal`, without approved lookups or steps only planned), checks that went down and
// came back (`incident`), readings that went out of bounds and back (journal lines the hub writes, `source: "hub"`),
// and fix notes (`runbook`). Nothing to fill in: the one line people add is "What did you change?". A port of
// web/src/lib/history.ts, so every app tells a machine's story in the same words (packages/shared/CONTRACT.md, journal).

public enum HistoryKind: String, Sendable {
    case change, failed, running, event, down, back, notes
}

/// Who did it: you, the assistant with your approval, or the hub noticing. Fix notes say nothing.
public enum HistoryBy: String, Sendable {
    case you, assistant, hub

    public var words: String {
        switch self {
        case .you: return "you"
        case .assistant: return "the assistant, with your approval"
        case .hub: return "noticed by the hub"
        }
    }
}

public struct HistoryItem: Equatable, Identifiable, Sendable {
    public var key: String
    public var at: String
    /// The machine or place, for the Overview's list across all of them.
    public var host: String
    public var kind: HistoryKind
    public var text: String
    public var detail: String?
    public var by: HistoryBy?
    public var command: String?
    public var rollback: String?
    public var session_id: String?
    /// The journal entry, for Delete.
    public var entity: Entity?
    public var id: String { key }

    /// A line you wrote yourself, which you may delete.
    public var own: Bool { entity != nil && by == .you }
}

public enum TechHistory {
    /// A machine's or place's history, newest first. `hostOf` gives a check's machine or place (GET /ops `things`), so
    /// an incident lands on the page its check is on. Without `host`, every machine's history together (the Overview's
    /// Recent activity).
    public static func items(journal: [Entity], incidents: [Entity], runbooks: [Entity], hostOf: (String) -> String?,
                             host: String? = nil) -> [HistoryItem] {
        func mine(_ h: String?) -> Bool {
            guard let h else { return false }
            if let host { return same(h, host) }
            return !h.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        var out: [HistoryItem] = []
        for e in journal {
            let outcome = e.string("outcome") ?? "done"
            if e.isDeleted || outcome == "planned" || e.bool("lookup") == true || !mine(e.string("host")) { continue }
            let hub = e.string("source") == "hub"
            let command = e.string("command")
            let session = e.string("session_id")
            let ran = !(command ?? "").isEmpty && !(session ?? "").isEmpty
            let kind: HistoryKind = hub ? .event : outcome == "failed" || outcome == "interrupted" ? .failed : outcome == "running" ? .running : .change
            let detail: String?
            switch outcome {
            case "failed": detail = "it failed"
            case "interrupted": detail = "it stopped before it finished, so it may be half done"
            case "reverted": detail = "undone later"
            case "running": detail = "running now"
            default: detail = nil
            }
            out.append(HistoryItem(key: "j-\(e.id)", at: e.str("at", e.created_at), host: e.str("host").lowercased(), kind: kind,
                                   text: e.str("what"), detail: detail, by: hub ? .hub : ran ? .assistant : .you,
                                   command: filled(command), rollback: filled(e.string("rollback")), session_id: filled(session), entity: e))
        }
        for e in incidents {
            // One folded into its machine's incident is that one's story.
            if e.isDeleted || !(e.string("merged_into") ?? "").isEmpty { continue }
            guard let h = hostOf(e.str("monitor_id")), mine(h) else { continue }
            let name = e.str("name")
            let also = e.stringArray("also_down")
            let opened = e.str("opened_at")
            out.append(HistoryItem(key: "down-\(e.id)", at: opened, host: h, kind: .down,
                                   text: "\(name) went down\(also.isEmpty ? "" : ", with \(also.joined(separator: ", "))")",
                                   detail: e.string("last_error"), by: .hub))
            if let closed = e.string("closed_at"), !closed.isEmpty {
                let seconds = max(0, (ISO.date(closed) ?? Date()).timeIntervalSince(ISO.date(opened) ?? Date()))
                out.append(HistoryItem(key: "back-\(e.id)", at: closed, host: h, kind: .back, text: "\(name) came back after \(duration(seconds))", by: .hub))
            }
        }
        for e in runbooks where !e.isDeleted && mine(e.string("host")) {
            out.append(HistoryItem(key: "rb-\(e.id)", at: e.updated_at, host: e.str("host").lowercased(), kind: .notes,
                                   text: "Fix notes updated", detail: e.string("title")))
        }
        // Newest first; the same moment keeps the order above.
        return out.enumerated().sorted { $0.element.at != $1.element.at ? $0.element.at > $1.element.at : $0.offset < $1.offset }.map(\.element)
    }

    /// Steps planned on a machine that nobody has said were done: they wait at the top of its page with Done and
    /// Didn't do it.
    public static func plannedSteps(_ journal: [Entity], host: String) -> [Entity] {
        journal.filter { !$0.isDeleted && $0.string("outcome") == "planned" && same($0.str("host"), host) }
            .sorted { $0.str("at") > $1.str("at") }
    }

    /// "37m 0s", "2h 5m", "3d 4h": as the web writes how long something was down.
    public static func duration(_ seconds: TimeInterval) -> String {
        let s = Int(max(0, seconds).rounded())
        let d = s / 86400, h = (s % 86400) / 3600, m = (s % 3600) / 60
        if d > 0 { return "\(d)d \(h)h" }
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return "\(m)m \(s % 60)s" }
        return "\(s)s"
    }

    /// An empty command or rollback shows nothing, as on the web.
    static func filled(_ s: String?) -> String? { (s ?? "").isEmpty ? nil : s }

    static func same(_ a: String, _ b: String) -> Bool {
        a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == b.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
