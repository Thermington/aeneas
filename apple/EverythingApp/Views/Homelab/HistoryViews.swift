import SwiftUI
import EACore

// History (Tech, since 2026-11-19): a machine's or place's story on its page, and every machine's latest on the
// Overview. The lines come from EACore's TechHistory, as on the web (web/src/views/History.tsx).

extension HistoryKind {
    /// A change or a check coming back is fine, a failed change or a check going down a problem, the hub noticing a
    /// reading needs a look; the rest are gray.
    var tone: StatusTone? {
        switch self {
        case .change, .back: return .ok
        case .failed, .down: return .danger
        case .event: return .warn
        case .running, .notes: return nil
        }
    }
}

/// History rows, `step` at a time with Show older. `onDelete`: a line you wrote yourself, after the parent asks.
struct HistoryRows: View {
    var items: [HistoryItem]
    var showHost = false
    var step = 15
    var onDelete: (Entity) -> Void
    @State private var shown: Int?

    var body: some View {
        let limit = shown ?? step
        if items.isEmpty {
            Text("Nothing yet. Changes, alerts and checks that went down and came back show here.")
                .font(.subheadline).foregroundStyle(.secondary)
        }
        ForEach(items.prefix(limit)) { i in HistoryRow(item: i, showHost: showHost, onDelete: onDelete) }
        if items.count > limit {
            Button("Show older") { shown = limit + step }
        }
    }
}

/// One line of history: a dot by kind, what happened, when and who, the detail, and under a change with a command the
/// command and how to undo it; the chat it came from, and Delete for your own lines.
struct HistoryRow: View {
    @EnvironmentObject var model: AppModel
    var item: HistoryItem
    var showHost = false
    var onDelete: (Entity) -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "circle.fill").font(.system(size: 8)).foregroundStyle(item.kind.tone.fill(else: .gray)).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                if showHost {
                    Text("\(Text(item.host).font(.body.monospaced()).foregroundStyle(.secondary)) \(StyleGuard.dashes(item.text))")
                } else {
                    Text(StyleGuard.dashes(item.text))
                }
                Text([ISO.date(item.at).map { Homelab.ago($0) } ?? "", item.by?.words ?? ""].filter { !$0.isEmpty }.joined(separator: ", "))
                    .font(.caption).foregroundStyle(.secondary)
                if let d = item.detail, !d.isEmpty {
                    Text(StyleGuard.dashes(d)).font(.caption).foregroundStyle(item.kind == .failed || item.kind == .down ? AnyShapeStyle(.dangerText) : AnyShapeStyle(.secondary)).lineLimit(3)
                }
                if let command = item.command {
                    DisclosureGroup(item.rollback == nil ? "Command" : "Command and how to undo it") {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .top, spacing: 8) {
                                CommandBlock(text: command)
                                HomelabCopyButton(text: command).labelStyle(.iconOnly).controlSize(.small)
                            }
                            if let undo = item.rollback { Text("To undo: \(StyleGuard.dashes(undo))").font(.caption) }
                        }
                        .padding(.top, 4)
                    }
                    .font(.caption)
                }
                if item.session_id != nil || item.own {
                    HStack(spacing: 14) {
                        if let session = item.session_id {
                            Button("Open the chat") { model.openChat(session) }
                        }
                        if item.own, let e = item.entity {
                            Button("Delete", role: .destructive) { onDelete(e) }
                        }
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// A step planned on this machine (a command handed to you to run, a plan from a chat) that nobody has said was done:
/// Done puts it in the history, Didn't do it drops it.
struct PlannedStepRow: View {
    var entry: Entity
    var onDone: () -> Void
    var onDrop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(StyleGuard.dashes(entry.str("what"))).font(.body.weight(.medium))
            if let c = entry.string("command"), !c.isEmpty, c != entry.str("what") { CommandBlock(text: c) }
            let undo = entry.string("rollback").flatMap { $0.isEmpty ? nil : "; to undo: \(StyleGuard.dashes($0))" } ?? ""
            Text("Planned \(Homelab.ago(entry.string("at")))\(undo)").font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button("Done", action: onDone).buttonStyle(.themedProminent)
                Button("Didn't do it", action: onDrop).buttonStyle(.bordered)
            }
            .controlSize(.small)
        }
        .padding(.vertical, 4)
    }
}

/// One line, "What did you change?": a change made by hand, written into this machine's history.
struct NoteChangeRow: View {
    @EnvironmentObject var engine: SyncEngine
    var host: String
    @State private var what = ""
    @State private var busy = false

    var body: some View {
        HStack {
            TextField("What did you change?", text: $what, prompt: Text("What did you change? Replaced the fan, updated the BIOS"))
                .onSubmit { Task { await save() } }
                .accessibilityLabel("What did you change on \(host)?")
            Button("Add") { Task { await save() } }
                .buttonStyle(.borderless)
                .disabled(busy || Homelab.trimmed(what).isEmpty)
        }
        // The line under the row runs from the field, not from the button (a field is not text the list aligns to).
        .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
    }

    private func save() async {
        let text = String(Homelab.trimmed(what).prefix(1000))
        guard !text.isEmpty, !busy else { return }
        busy = true
        defer { busy = false }
        _ = await engine.create(kind: .journal, fields: [
            "host": .string(Homelab.hostKey(host)), "at": .string(ISO.now()), "what": .string(text), "risk": .string("low"), "outcome": .string("done")
        ])
        what = ""
    }
}
