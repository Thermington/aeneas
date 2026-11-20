import SwiftUI
import Combine
import WatchKit
import EACore

/// Capture by voice. The Watch records what is said (watchOS's own dictation kept only the last sentence or so of
/// anything longer than about half a minute, and watchOS has no speech recognition an app can use) and hands the
/// recording to WatchConnectivity through `WatchLink`, which delivers it when the iPhone is in reach; the iPhone writes
/// it down on the device and saves it as a capture. A Watch that runs Whisper (`WatchSpeech`) writes it down first
/// and shows what it heard at once, and its words go with the recording. Keeps the last few captures' progress, from
/// "Heard: ..." to what the hub filed it as. While such a Watch records, it also hears what has been said so far again
/// and again and shows the words under the timer (`hearLive`). Lives on the app model, so leaving the page while
/// recording still sends it.
@MainActor
final class WatchCaptureModel: ObservableObject {
    /// Records on Watches without the model, and on this one if the live recorder cannot start.
    let recorder = HumRecorder(limit: WatchVoiceCapture.maxSeconds, speech: true)
    /// Records on a Watch with the model, keeping the latest audio for the live passes.
    let liveRecorder = LiveSpeechRecorder(limit: WatchVoiceCapture.maxSeconds)
    @Published private(set) var recent: [WatchCaptureStatus]
    @Published var problem: String?
    /// The words heard so far while recording; empty when nothing is heard yet or the Watch has no model.
    @Published private(set) var liveWords = LiveWords()
    /// The live recorder took this capture, so live passes can hear it.
    @Published private(set) var live = false
    private var subs: Set<AnyCancellable> = []
    /// Set by Done and Cancel: the live pass under way stops at its next word.
    private var liveStop: LiveStop?
    /// This capture's first live words have shown (their delay is kept once).
    private var wordsShown = false

    var recording: Bool { recorder.recording || liveRecorder.recording }
    var elapsed: TimeInterval { live ? liveRecorder.elapsed : recorder.elapsed }
    var level: Float { live ? liveRecorder.level : recorder.level }
    var recorderError: String? { liveRecorder.error ?? recorder.error }

    private static let key = "watch.captures"
    private static let keep = 5
    /// The recording waits at most this long for the Watch's own words, then goes without them (they still show here
    /// when they come). A short capture takes a second or two.
    static let hearingWait: TimeInterval = 15

    init() {
        var rows = (UserDefaults.standard.data(forKey: Self.key)).flatMap { try? JSONDecoder().decode([WatchCaptureStatus].self, from: $0) } ?? []
        // A hearing cut off when the app was stopped never finishes; its recording went at the next launch without it.
        for i in rows.indices where rows[i].hearing == true { rows[i].heardOnWatch(nil) }
        recent = rows
        // The screen watches this model, so the recorder's clock and meter show through it.
        recorder.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subs)
        liveRecorder.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subs)
        // On the next turn of the main loop, so clearing `finished` does not happen inside its own change.
        recorder.$finished.compactMap { $0 }.receive(on: DispatchQueue.main)
            .sink { [weak self] take in self?.recorder.finished = nil; self?.send(take) }.store(in: &subs)
        liveRecorder.$finished.compactMap { $0 }.receive(on: DispatchQueue.main)
            .sink { [weak self] take in self?.liveRecorder.finished = nil; self?.send(take) }.store(in: &subs)
    }

    func record() async {
        guard !recording else { return }
        problem = nil
        liveWords = LiveWords()
        live = false
        wordsShown = false
        guard WatchSpeech.shared.canHear else {
            await recorder.start()
            if recorder.recording { WKHaptic.start() }
            return
        }
        // Usually in memory already (the voice page loads it); if not, it loads while the owner speaks.
        WatchSpeech.shared.warm()
        switch await liveRecorder.start() {
        case .started: live = true
        case .denied: return
        case .failed:
            // No live words this time, but the capture is recorded as on any Watch.
            await recorder.start()
        }
        WatchSpeech.shared.note(SpeechTimings.live, live ? 1 : 0)
        if recording { WKHaptic.start() }
    }

    func stop() {
        endLive()
        if live { liveRecorder.stop() } else { recorder.stop() }
    }

    func discard() {
        endLive()
        if live { liveRecorder.cancel() } else { recorder.cancel() }
        liveWords = LiveWords()
    }

    /// Done or Cancel: a live pass under way stops at once, so the final pass is not kept waiting behind it.
    private func endLive() {
        liveStop?.stop()
        liveStop = nil
    }

    /// While the recording panel is on screen with the Watch's screen on: hears the latest audio again and again and
    /// updates the words under the timer. Each pass starts as soon as the last one ended, after a short pause, once
    /// there is new speech, so it goes as fast as this Watch manages. A pass that takes long leaves the last words
    /// showing until it lands. Ends when the recording ends, or when the panel leaves the screen or the wrist drops
    /// (the task is cancelled); the final pass after Done is unchanged.
    func hearLive() async {
        guard live, liveRecorder.recording, WatchSpeech.shared.canHear else { return }
        let stop = LiveStop()
        liveStop?.stop()
        liveStop = stop
        await withTaskCancellationHandler {
            var heard = 0
            while !Task.isCancelled, !stop.stopped, liveRecorder.recording {
                guard LiveHearing.due(recorded: liveRecorder.recorded, heard: heard), let w = liveRecorder.window() else {
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    continue
                }
                // Nothing said yet (or a muted microphone): Whisper would write words for the silence.
                if LiveHearing.quiet(w.samples) {
                    heard = w.recorded
                    try? await Task.sleep(nanoseconds: UInt64(LiveHearing.pause * 1_000_000_000))
                    continue
                }
                let started = Date()
                let words = await WatchSpeech.shared.hearLive(w.samples, shouldStop: { stop.stopped })
                guard !Task.isCancelled, !stop.stopped, liveRecorder.recording else { break }
                WatchSpeech.shared.notePass(audio: Double(w.samples.count) / LiveHearing.sampleRate, took: Date().timeIntervalSince(started))
                heard = w.recorded
                if let words {
                    liveWords = liveWords.updated(with: words, cut: w.cut)
                    if !wordsShown, !liveWords.isEmpty {
                        wordsShown = true
                        WatchSpeech.shared.note(SpeechTimings.firstWords, liveRecorder.elapsed)
                    }
                }
                try? await Task.sleep(nanoseconds: UInt64(LiveHearing.pause * 1_000_000_000))
            }
        } onCancel: {
            stop.stop()
        }
    }

    private func send(_ take: HumTake) {
        let hears = WatchSpeech.shared.canHear
        let capture = WatchVoiceCapture(seconds: take.seconds, format: take.url.pathExtension.lowercased())
        do {
            // While the Watch writes it down the recording waits in the queue, kept on disk: a second or two with the
            // model in memory. With the model still loading it goes to the iPhone at once, as on any Watch (the first
            // load takes far longer than the wait), and the Watch's own words show here when they come.
            try WatchLink.shared.queueCapture(capture, file: take.url, hold: hears && WatchSpeech.shared.loaded)
        } catch {
            try? FileManager.default.removeItem(at: take.url)
            problem = "Could not keep the recording: \(error.localizedDescription)"
            WKHaptic.failure()
            return
        }
        recent.insert(WatchCaptureStatus(id: capture.id, seconds: capture.seconds, at: capture.recordedAt, step: 0,
                                         line: Self.sentLine, hearing: hears ? true : nil), at: 0)
        save()
        if hears { Task { await hear(capture) } }
    }

    private static var sentLine: String { WatchLink.shared.isReachable ? "Sent to your iPhone" : "Waiting for your iPhone" }

    /// The Watch writes the capture down, shows the words, and lets the recording go with them.
    private func hear(_ c: WatchVoiceCapture) async {
        let url = WatchCaptureQueue.local.audioURL(c)
        let deadline = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.hearingWait * 1_000_000_000))
            guard !Task.isCancelled else { return }
            WatchLink.shared.release(capture: c.id, heard: nil)
            self?.update(c.id) { $0.line = Self.sentLine }
        }
        let words = await WatchSpeech.shared.transcribe(url, seconds: c.seconds)
        deadline.cancel()
        // Does nothing when the deadline already let the recording go.
        WatchLink.shared.release(capture: c.id, heard: words)
        update(c.id) {
            $0.heardOnWatch(words)
            if $0.step == 0 { $0.line = Self.sentLine }
        }
    }

    private func update(_ id: String, _ change: (inout WatchCaptureStatus) -> Void) {
        guard let i = recent.firstIndex(where: { $0.id == id }) else { return }
        change(&recent[i])
        save()
    }

    /// WatchConnectivity finished the transfer.
    func delivered(_ id: String) {
        update(id) { $0.advance(step: 1, line: "Your iPhone is writing it down") }
    }

    /// What the iPhone heard, how it was saved and what the hub filed it as; a tap on the wrist once it is saved or not.
    func apply(_ r: WatchCaptureResult) {
        guard let i = recent.firstIndex(where: { $0.id == r.id }), recent[i].apply(r) else { return }
        save()
        switch r.state {
        case .saved: WKHaptic.success()
        case .failed, .nothing: WKHaptic.failure()
        case .waiting, .filed: break
        }
    }

    #if DEBUG
    /// Simulator checks with no iPhone or speech model: a capture saved as the iPhone would report it.
    func debugSaved(_ text: String) {
        let id = UUID().uuidString.lowercased()
        recent.insert(WatchCaptureStatus(id: id, seconds: 42, at: Date(), step: 1, line: "Your iPhone is writing it down"), at: 0)
        apply(WatchCaptureResult(id: id, state: .saved, text: text, outcome: "Saved as a note"))
    }

    /// `-captureSample YES`: the bundled sample goes through the real capture path as if just recorded (the Watch's
    /// own hearing included, with `-EAWatchHearing YES` and the model in the simulator's store).
    func debugSample() async {
        guard let src = Bundle.main.url(forResource: "hearing-sample", withExtension: "m4a") else { problem = "No sample in this build"; return }
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("capture-\(UUID().uuidString).m4a")
        guard (try? FileManager.default.copyItem(at: src, to: copy)) != nil else { return }
        // As in a real capture: the model loads while the owner speaks (the sample is 2.4 s long).
        WatchSpeech.shared.warm()
        try? await Task.sleep(nanoseconds: 2_400_000_000)
        send(HumTake(url: copy, seconds: 2.4))
    }

    /// `-captureLive YES`: a capture recorded from the bundled spoken sample instead of the microphone, fed in at the
    /// pace it was spoken, with the live words showing as on a Watch with the model (`-EAWatchHearing YES` and the model
    /// in the simulator's store); it ends with the sample, as Done would end it.
    func debugLive() {
        guard !recording, WatchSpeech.shared.canHear,
              let src = Bundle.main.url(forResource: "live-sample", withExtension: "m4a") else { problem = "No live sample or model"; return }
        problem = nil
        liveWords = LiveWords()
        WatchSpeech.shared.warm()
        live = liveRecorder.start(feeding: src)
    }

    /// `-captureFiled "Logs: weight 192.2 lb"`: the newest capture as the iPhone reports it once saved and then filed
    /// (the simulator's WatchConnectivity does not carry recordings to the iPhone simulator).
    func debugFiled(_ filed: String, text: String?) {
        guard let s = recent.first else { return }
        let words = text ?? s.heard ?? "I weigh 192.2 today."
        apply(WatchCaptureResult(id: s.id, state: .saved, text: words, outcome: "In your diary, filing it"))
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            apply(WatchCaptureResult(id: s.id, state: .filed, text: words, filed: filed))
        }
    }
    #endif

    /// The capture to show under the buttons: the newest, until the next capture replaces it.
    var shown: WatchCaptureStatus? { WatchCaptureStatus.shown(recent) }

    private func save() {
        if recent.count > Self.keep { recent.removeLast(recent.count - Self.keep) }
        if let d = try? JSONEncoder().encode(recent) { UserDefaults.standard.set(d, forKey: Self.key) }
    }
}

private extension WKHaptic {
    static func start() { WKInterfaceDevice.current().play(.start) }
}

/// Tells a live pass to stop, from the main thread to WhisperKit's, which asks as each word comes.
final class LiveStop: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    var stopped: Bool { lock.withLock { done } }
    func stop() { lock.withLock { done = true } }
}


/// A capture being recorded: the clock, a level meter that shows the microphone hears something, Done and Cancel.
/// On a Watch that writes speech down itself, the words said so far show under them, the ones still settling dimmer.
/// Done (or a double tap) ends it: the words show on the voice page (at once on a Watch that writes speech down
/// itself), then what the hub filed it as.
struct WatchCaptureRecordingPanel: View {
    @ObservedObject var capture: WatchCaptureModel
    @ObservedObject private var speech = WatchSpeech.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 4) {
                Circle().fill(.orange).frame(width: 7, height: 7)
                Text("Listening").font(.caption2).foregroundStyle(.secondary)
            }
            Text("\(WatchHumRecordingPanel.clock(capture.elapsed)) of \(WatchHumRecordingPanel.clock(WatchVoiceCapture.maxSeconds))")
                .font(.title3.monospacedDigit())
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.25))
                    Capsule().fill(Color.green).frame(width: max(0, g.size.width * CGFloat(capture.level)))
                }
            }
            .frame(height: 6)
            .accessibilityHidden(true)
            if capture.live, !capture.liveWords.isEmpty {
                liveText
                    .font(.footnote)
                    // The latest words: a long capture shows its end.
                    .lineLimit(3)
                    .truncationMode(.head)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .animation(.default, value: capture.liveWords)
            } else if let note = speech.recordingNote(live: capture.live) {
                // Until the words come: where the Watch's speech model stands, so the owner can tell what to expect.
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
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
        // Live passes only while this panel is on screen and the screen is on: they stop when the wrist drops or the
        // app leaves the screen (the task is cancelled) and start again when it comes back.
        .task(id: scenePhase == .active && capture.live) {
            guard scenePhase == .active, capture.live else { return }
            await capture.hearLive()
        }
    }

    /// Settled words in full, the ones the next pass may still change dimmer.
    private var liveText: Text {
        let w = capture.liveWords
        let settled = [w.lead, w.firmText].filter { !$0.isEmpty }.joined(separator: " ")
        let tail = w.tentativeText
        return Text(settled) + Text(settled.isEmpty || tail.isEmpty ? tail : " " + tail).foregroundStyle(.secondary)
    }
}

/// The newest capture under the voice page's buttons: what was heard ("Heard: ..."), then how far it got, from
/// "Writing it down" to "Filed: Logs: weight 192.2 lb". It stays until the next capture.
struct WatchCaptureRow: View {
    let status: WatchCaptureStatus

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            icon
            VStack(alignment: .leading, spacing: 2) {
                if let w = status.words {
                    Text(StyleGuard.dashes(w)).font(.footnote).lineLimit(6).fixedSize(horizontal: false, vertical: true)
                }
                Text(StyleGuard.dashes(status.status))
                    .font(status.words == nil ? .footnote : .caption2)
                    .foregroundStyle(status.words == nil ? Color.primary : status.filed != nil ? Color.green : Color.secondary)
                    .lineLimit(4).fixedSize(horizontal: false, vertical: true)
                Text("Capture, \(WatchHumRecordingPanel.clock(status.seconds)), \(status.at.formatted(date: .omitted, time: .shortened))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var icon: some View {
        if status.hearing == true {
            ProgressView().frame(width: 16, height: 16)
        } else {
            Image(systemName: status.failed ? "exclamationmark.triangle" : status.filed != nil ? "checkmark.circle.fill" : status.finished ? "checkmark.circle" : "arrow.up.circle")
                .foregroundStyle(status.failed ? Color.orange : status.finished ? Color.green : Color.secondary)
        }
    }
}
