import SwiftUI
import Combine
import WatchKit
import EACore

/// One spoken capture on its way from the wrist, as the Watch last heard of it.
struct WatchCaptureStatus: Codable, Identifiable, Equatable {
    var id: String
    var seconds: Double
    var at: Date
    /// 0 sent or waiting for the iPhone, 1 the iPhone has it, then `WatchCaptureResult.State.rank`.
    var step: Int
    var line: String
    var failed = false

    var finished: Bool { step >= WatchCaptureResult.State.saved.rank }
}

/// Capture by voice. The Watch records what is said (watchOS's own dictation kept only the last sentence or so of
/// anything longer than about half a minute, and the Watch has no speech recognition an app can use), hands the
/// recording to WatchConnectivity through `WatchLink`, which delivers it when the iPhone is in reach, and the iPhone
/// turns it into text on the device and saves it as a capture. Keeps the last few captures' progress, from "Sent to
/// your iPhone" to how it was filed. Lives on the app model, so leaving the page while recording still sends it.
@MainActor
final class WatchCaptureModel: ObservableObject {
    let recorder = HumRecorder(limit: WatchVoiceCapture.maxSeconds, speech: true)
    @Published private(set) var recent: [WatchCaptureStatus]
    @Published var problem: String?
    private var subs: Set<AnyCancellable> = []

    private static let key = "watch.captures"
    private static let keep = 5

    init() {
        recent = (UserDefaults.standard.data(forKey: Self.key)).flatMap { try? JSONDecoder().decode([WatchCaptureStatus].self, from: $0) } ?? []
        // The screen watches this model, so the recorder's clock and meter show through it.
        recorder.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subs)
        // On the next turn of the main loop, so clearing `finished` does not happen inside its own change.
        recorder.$finished.compactMap { $0 }.receive(on: DispatchQueue.main)
            .sink { [weak self] take in self?.send(take) }.store(in: &subs)
    }

    func record() async {
        problem = nil
        await recorder.start()
        if recorder.recording { WKHaptic.start() }
    }

    func stop() { recorder.stop() }
    func discard() { recorder.cancel() }

    private func send(_ take: HumTake) {
        recorder.finished = nil
        let capture = WatchVoiceCapture(seconds: take.seconds, format: take.url.pathExtension.lowercased())
        let reachable = WatchLink.shared.isReachable
        do {
            try WatchLink.shared.queueCapture(capture, file: take.url)
        } catch {
            try? FileManager.default.removeItem(at: take.url)
            problem = "Could not keep the recording: \(error.localizedDescription)"
            WKHaptic.failure()
            return
        }
        recent.insert(WatchCaptureStatus(id: capture.id, seconds: capture.seconds, at: capture.recordedAt, step: 0,
                                         line: reachable ? "Sent to your iPhone" : "Waiting for your iPhone"), at: 0)
        save()
    }

    /// WatchConnectivity finished the transfer.
    func delivered(_ id: String) { advance(id, step: 1, line: "Your iPhone is writing it down") }

    /// What the iPhone heard and how it was saved; a tap on the wrist once it is saved or not.
    func apply(_ r: WatchCaptureResult) {
        guard advance(r.id, step: r.state.rank, line: r.line, failed: r.state == .failed || r.state == .nothing) else { return }
        switch r.state {
        case .saved: WKHaptic.success()
        case .failed, .nothing: WKHaptic.failure()
        case .waiting: break
        }
    }

    #if DEBUG
    /// Simulator checks with no iPhone or speech model: a capture saved as the iPhone would report it.
    func debugSaved(_ text: String) {
        let id = UUID().uuidString.lowercased()
        recent.insert(WatchCaptureStatus(id: id, seconds: 42, at: Date(), step: 1, line: "Your iPhone is writing it down"), at: 0)
        apply(WatchCaptureResult(id: id, state: .saved, text: text, outcome: "Saved as a note"))
    }
    #endif

    /// The capture to show under the buttons: one on its way, or one that ended in the last 15 minutes.
    var shown: WatchCaptureStatus? {
        guard let s = recent.first else { return nil }
        return !s.finished || Date().timeIntervalSince(s.at) < 15 * 60 ? s : nil
    }

    /// Steps only go forward: a queued message can arrive after a direct one, and the same outcome can arrive twice.
    @discardableResult
    private func advance(_ id: String, step: Int, line: String, failed: Bool = false) -> Bool {
        guard let i = recent.firstIndex(where: { $0.id == id }) else { return false }
        let cur = recent[i]
        guard step > cur.step || (step == cur.step && !cur.finished) else { return false }
        recent[i].step = step
        recent[i].line = line
        recent[i].failed = failed
        save()
        return true
    }

    private func save() {
        if recent.count > Self.keep { recent.removeLast(recent.count - Self.keep) }
        if let d = try? JSONEncoder().encode(recent) { UserDefaults.standard.set(d, forKey: Self.key) }
    }
}

private extension WKHaptic {
    static func start() { WKInterfaceDevice.current().play(.start) }
}

/// A capture being recorded: the clock, a level meter that shows the microphone hears something, Done and Cancel.
/// Done (or a double tap) sends it to the iPhone, which writes it down; how it was filed comes back to the voice page.
struct WatchCaptureRecordingPanel: View {
    @ObservedObject var capture: WatchCaptureModel

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 4) {
                Circle().fill(.orange).frame(width: 7, height: 7)
                Text("Listening").font(.caption2).foregroundStyle(.secondary)
            }
            Text("\(WatchHumRecordingPanel.clock(capture.recorder.elapsed)) of \(WatchHumRecordingPanel.clock(WatchVoiceCapture.maxSeconds))")
                .font(.title3.monospacedDigit())
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.25))
                    Capsule().fill(Color.green).frame(width: max(0, g.size.width * CGFloat(capture.recorder.level)))
                }
            }
            .frame(height: 6)
            .accessibilityHidden(true)
            Button { capture.stop() } label: {
                Label("Done", systemImage: "checkmark").frame(maxWidth: .infinity, minHeight: 44)
            }
            .tint(.orange)
            // Double tap (finger and thumb) ends it as it started it.
            .handGestureShortcut(.primaryAction)
            Button("Cancel", role: .destructive) { capture.discard() }
                .font(.caption2)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
        }
    }
}

struct WatchCaptureRow: View {
    let status: WatchCaptureStatus

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: status.failed ? "exclamationmark.triangle" : status.finished ? "checkmark.circle" : "arrow.up.circle")
                .foregroundStyle(status.failed ? Color.orange : status.finished ? Color.green : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(StyleGuard.dashes(status.line)).font(.footnote).lineLimit(4).fixedSize(horizontal: false, vertical: true)
                Text("Capture, \(WatchHumRecordingPanel.clock(status.seconds)), \(status.at.formatted(date: .omitted, time: .shortened))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
