#if os(iOS)
import Foundation
import UIKit
import Speech
import AVFoundation
import os
import EACore

/// Captures spoken on the Watch arrive as WatchConnectivity file transfers, which `WatchLink` moves into
/// `WatchCaptureQueue.local`. This turns each recording into text on this iPhone, saves it as a capture from the
/// Watch (with the recording's id, so one sent twice is saved once, and with what the Watch heard itself when it can
/// write speech down), and tells the Watch what was heard and how it was saved, then what the hub filed it as. The
/// audio never leaves the two devices. One that cannot be heard right now (the speech model still downloading, the
/// app out of background time) stays queued and is heard the next time the app is active.
@MainActor
final class WatchCaptureRelay {
    static let shared = WatchCaptureRelay()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "watchcapture")

    /// How long the iPhone keeps asking the hub whether a capture is filed while it has background time after saving
    /// it (the system gives about 30 s); later checks come when the app is next active.
    static let filingWatch: TimeInterval = 25
    static let filingPoll: TimeInterval = 3

    private let queue = WatchCaptureQueue.local
    private var running = false
    private var again = false

    /// Starts a run without waiting for it; app start must not wait on hearing a recording.
    func kick() { Task { await run() } }

    func run() async {
        // One run at a time. A capture that arrives during a run is picked up by one more pass.
        if running { again = true; return }
        running = true
        defer { running = false }
        repeat {
            again = false
            await runOnce()
        } while again
    }

    private func runOnce() async {
        queue.prune()
        guard !queue.pending().isEmpty || !queue.awaitingFiling().isEmpty else { return }
        await AppModel.shared.ensureStarted()
        let engine = AppModel.shared.engine

        // A recording often arrives while the app is in the background; ask for the time to hear it.
        holdBackgroundTime()
        defer { releaseBackgroundTime() }

        let hints = WatchSpeechSetup.hints(engine)
        var savedNow = false
        captures: for e in queue.pending() {
            let c = e.capture
            var text = e.text
            if text == nil {
                guard queue.hasAudio(c) else {
                    queue.finish(c.id)
                    await tell(WatchCaptureResult(id: c.id, state: .failed, text: c.heard, error: "The recording was lost on your iPhone. Say it again."))
                    continue
                }
                switch await WatchCaptureTranscriber.transcribe(queue.audioURL(c), hints: hints) {
                case .text(let t):
                    text = t
                    queue.setText(c.id, t)
                case .nothing:
                    queue.finish(c.id)
                    Self.log.notice("capture \(c.id, privacy: .public): no words")
                    await tell(WatchCaptureResult(id: c.id, state: .nothing))
                    continue
                case .later(let why):
                    // The rest wait too: what stops this one (no speech model yet, no background time) stops them.
                    Self.log.notice("capture \(c.id, privacy: .public) waits: \(why, privacy: .public)")
                    await tell(WatchCaptureResult(id: c.id, state: .waiting, error: why))
                    break captures
                case .failed(let why):
                    // This iPhone cannot write it down at all (no speech model for its language, an older iOS). When
                    // the Watch wrote it down itself, its words are saved rather than lost.
                    if let heard = c.heard {
                        Self.log.notice("capture \(c.id, privacy: .public) saved with the Watch's words: \(why, privacy: .public)")
                        text = heard
                        queue.setText(c.id, heard)
                    } else {
                        queue.finish(c.id)
                        Self.log.error("capture \(c.id, privacy: .public) not heard: \(why, privacy: .public)")
                        await tell(WatchCaptureResult(id: c.id, state: .failed, error: why))
                        continue
                    }
                }
            }
            guard let words = text else { continue }
            // Online it goes to the hub, which files it; with no hub in reach it is saved here and goes with the next
            // sync. The Watch's own hearing goes along for the filer, unless it is the words being saved.
            let second = c.heard == words ? nil : c.heard
            if let saved = await engine.capture(words, source: .watch, id: c.id, heardOnWatch: second) {
                // Being filed in the background (or sorted once it reaches the hub): the Watch hears how once it is done.
                let filing = saved.str("filing") == "pending" || saved.bool("sort") == true
                queue.finish(c.id, awaitsFiling: filing)
                let outcome = WatchCaptureResult.outcome(of: saved, online: engine.status == .online)
                Self.log.notice("capture \(c.id, privacy: .public) saved filing=\(filing)")
                await tell(WatchCaptureResult(id: c.id, state: .saved, text: words, outcome: outcome))
                savedNow = savedNow || filing
            } else {
                queue.finish(c.id)
                await tell(WatchCaptureResult(id: c.id, state: .failed, text: words, error: "Not saved on your iPhone."))
            }
        }
        await tellFiled(engine, watch: savedNow)
    }

    /// Tells the Watch what the hub filed each waiting capture as. Asks the hub when it is in reach (the local copy
    /// only changes with a sync); right after a save it asks every few seconds while the background time lasts, since
    /// the hub files a capture in a few seconds to a minute.
    private func tellFiled(_ engine: SyncEngine, watch: Bool) async {
        let until = Date().addingTimeInterval(watch ? Self.filingWatch : 0)
        while true {
            let waiting = queue.awaitingFiling()
            if waiting.isEmpty { return }
            for e in waiting {
                let id = e.capture.id
                var capture = engine.get(id)
                if engine.status == .online, let c = engine.client, let fresh = try? await c.entity(id) {
                    await engine.absorb(fresh)
                    capture = fresh
                }
                guard let capture else { continue }
                if capture.deleted_at != nil { queue.filingTold(id); continue }
                if let r = WatchCaptureResult.filed(capture) {
                    Self.log.notice("capture \(id, privacy: .public) filed")
                    await tell(r)
                    queue.filingTold(id)
                }
            }
            // A capture that arrived meanwhile is heard first (the next pass asks again), not after the wait.
            guard Date() < until, queue.pending().isEmpty, !queue.awaitingFiling().isEmpty else { return }
            try? await Task.sleep(nanoseconds: UInt64(Self.filingPoll * 1_000_000_000))
        }
    }

    private var backgroundTask = UIBackgroundTaskIdentifier.invalid

    private func holdBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Watch capture") { [weak self] in self?.releaseBackgroundTime() }
    }

    private func releaseBackgroundTime() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    private func tell(_ r: WatchCaptureResult) async {
        await WatchLink.shared.sendCaptureResult(r)
    }
}

/// Turns a recording from the Watch into text on this iPhone. iOS 26 or later: Apple's SpeechAnalyzer, entirely on
/// the device, needing no permission beyond what the Watch already had. Earlier systems: SFSpeechRecognizer, only on
/// the device (the recording is never sent to Apple's speech service), with speech recognition allowed for Aeneas.
@MainActor
enum WatchCaptureTranscriber {
    enum Outcome: Equatable {
        case text(String)
        /// The recording held no words.
        case nothing
        /// Can be heard later, not now; why, in a sentence for the Watch.
        case later(String)
        /// Cannot be heard on this iPhone; why, in a sentence for the Watch.
        case failed(String)
    }

    /// Longest a recording may take to hear before the next run tries again: a five minute capture takes seconds.
    static let timeout: TimeInterval = 120

    /// `hints`: words to expect (`SpeechHints`), so "I weigh 192.2" wins over "Highway 192.2".
    static func transcribe(_ url: URL, hints: [String] = []) async -> Outcome {
        #if DEBUG
        // Debug builds: `-EAWatchCaptureText "<words>"` stands in for the speech model, for simulator checks.
        if let t = UserDefaults.standard.string(forKey: "EAWatchCaptureText") { return t.isEmpty ? .nothing : .text(t) }
        #endif
        if #available(iOS 26, *) { return await analyze(url, hints: hints) }
        return await recognize(url, hints: hints)
    }

    // MARK: SpeechAnalyzer (iOS 26 and later)

    @available(iOS 26, *)
    private static func analyze(_ url: URL, hints: [String]) async -> Outcome {
        guard let module = await module(for: Locale.current) else {
            return .failed("Your iPhone has no speech model for its language, so it could not write this down.")
        }
        do {
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                try await request.downloadAndInstall()
            }
        } catch {
            return .later("Your iPhone is getting its speech model. The capture is written down once it has it.")
        }
        do {
            let text = try await withTimeout(timeout) { try await run(module, file: url, hints: hints) }
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? .nothing : .text(t)
        } catch is TimedOut {
            return .later("Your iPhone ran out of time writing it down. It tries again when Aeneas is open.")
        } catch {
            // A file it cannot read or convert will not read later either.
            let e = error as NSError
            if e.domain == NSOSStatusErrorDomain || (e.domain == "WatchCapture" && e.code != 1) {
                return .failed("Your iPhone could not read the recording.")
            }
            return .later("Your iPhone could not write it down yet (\(error.localizedDescription)). It tries again when Aeneas is open.")
        }
    }

    /// The transcriber for this language: SpeechTranscriber where the device has it, else DictationTranscriber (the
    /// model of system dictation, on more devices and languages). Final results only: nothing is shown while it hears.
    @available(iOS 26, *)
    private static func module(for locale: Locale) async -> (any SpeechModule)? {
        if SpeechTranscriber.isAvailable, let l = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
            return SpeechTranscriber(locale: l, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
        }
        if let l = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
            return DictationTranscriber(locale: l, contentHints: [], transcriptionOptions: [.punctuation], reportingOptions: [], attributeOptions: [])
        }
        return nil
    }

    /// The whole file through the speech model; its results end when the analysis has finished. The model takes only
    /// its own audio format (a file as the Watch recorded it is refused), so the audio is converted on the way in.
    @available(iOS 26, *)
    private static func run(_ module: any SpeechModule, file url: URL, hints: [String]) async throws -> String {
        let file = try AVAudioFile(forReading: url)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            throw NSError(domain: "WatchCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "the speech model is not ready"])
        }
        let results = Task { () throws -> String in
            var segments = SpeechSegments()
            if let t = module as? SpeechTranscriber {
                for try await r in t.results { segments.update(String(r.text.characters), final: r.isFinal) }
            } else if let t = module as? DictationTranscriber {
                for try await r in t.results { segments.update(String(r.text.characters), final: r.isFinal) }
            }
            return segments.text
        }
        let analyzer = SpeechAnalyzer(modules: [module])
        // The timeout cancels this task: the analysis stops and its results end, so nothing waits on it.
        return try await withTaskCancellationHandler {
            do {
                try await analyzer.prepareToAnalyze(in: format)
                if !hints.isEmpty {
                    // The expected words, as contextual strings: a hint only, so a model that refuses it still hears.
                    let context = AnalysisContext()
                    context.contextualStrings[.general] = hints
                    try? await analyzer.setContext(context)
                }
                let (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
                try await analyzer.start(inputSequence: stream)
                try convert(file, to: format) { input.yield(AnalyzerInput(buffer: $0)) }
                input.finish()
                try await analyzer.finalizeAndFinishThroughEndOfInput()
            } catch {
                results.cancel()
                await analyzer.cancelAndFinishNow()
                throw error
            }
            return try await results.value
        } onCancel: {
            results.cancel()
            Task { await analyzer.cancelAndFinishNow() }
        }
    }

    /// Reads the file and hands it on in `format`, a piece at a time.
    static func convert(_ file: AVAudioFile, to format: AVAudioFormat, _ yield: (AVAudioPCMBuffer) -> Void) throws {
        let source = file.processingFormat
        guard let converter = AVAudioConverter(from: source, to: format) else {
            throw NSError(domain: "WatchCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "the recording's audio could not be converted"])
        }
        let piece: AVAudioFrameCount = 8192
        let room = AVAudioFrameCount((Double(piece) * format.sampleRate / source.sampleRate).rounded(.up)) + 1024
        var ended = false
        var readError: Error?
        while true {
            guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: room) else { break }
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, state in
                // A new buffer each time: the converter may still hold the last one. Reading at the end of the
                // file fails rather than reading nothing, so the end is found by position.
                guard !ended, file.framePosition < file.length, let buf = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: piece) else {
                    ended = true
                    state.pointee = .endOfStream
                    return nil
                }
                do { try file.read(into: buf, frameCount: piece) } catch { readError = error }
                if readError != nil || buf.frameLength == 0 {
                    ended = true
                    state.pointee = .endOfStream
                    return nil
                }
                state.pointee = .haveData
                return buf
            }
            if let readError { throw readError }
            if status == .error { throw error ?? NSError(domain: "WatchCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: "the recording's audio could not be converted"]) }
            if out.frameLength > 0 { yield(out) }
            if status == .endOfStream || (ended && out.frameLength == 0) { break }
        }
    }

    // MARK: SFSpeechRecognizer (earlier systems)

    private static func recognize(_ url: URL, hints: [String]) async -> Outcome {
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer() else {
            return .failed("Your iPhone has no speech recognition for its language, so it could not write this down.")
        }
        guard recognizer.supportsOnDeviceRecognition else {
            return .failed("Your iPhone cannot turn speech into text by itself. iOS 26 or later can.")
        }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: break
        case .notDetermined:
            // Asked only with Aeneas on screen: a question while the iPhone is in a pocket goes unseen.
            guard UIApplication.shared.applicationState == .active, await DevicePermissions.requestSpeech() else {
                return .later("Open Aeneas on your iPhone and allow speech recognition to have it written down.")
            }
        default:
            return .failed("Speech recognition is off for Aeneas on your iPhone. Turn it on in Settings, Privacy and Security, Speech Recognition.")
        }
        guard recognizer.isAvailable else { return .later("Speech recognition is not ready on your iPhone. It tries again when Aeneas is open.") }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        request.contextualStrings = hints
        let holder = TaskHolder()
        do {
            let text = try await withTimeout(timeout) {
                try await withTaskCancellationHandler {
                    try await withCheckedThrowingContinuation { (c: CheckedContinuation<String, Error>) in
                        let once = Once()
                        holder.task = recognizer.recognitionTask(with: request) { result, error in
                            if let result, result.isFinal {
                                once.run { c.resume(returning: result.bestTranscription.formattedString) }
                            } else if let error {
                                once.run { c.resume(throwing: error) }
                            }
                        }
                    }
                } onCancel: { holder.task?.cancel() }
            }
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? .nothing : .text(t)
        } catch is TimedOut {
            return .later("Your iPhone ran out of time writing it down. It tries again when Aeneas is open.")
        } catch {
            // 1110: no speech was found in the recording.
            if (error as NSError).code == 1110 { return .nothing }
            return .later("Your iPhone could not write it down yet (\(error.localizedDescription)). It tries again when Aeneas is open.")
        }
    }

    private struct TimedOut: Error {}

    /// The work, or `TimedOut` once `seconds` pass first (the work is then cancelled).
    private static func withTimeout<T: Sendable>(_ seconds: TimeInterval, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw TimedOut()
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw TimedOut() }
            return first
        }
    }
}

/// The recognizer's task, cancelled from another thread when the timeout comes first.
private final class TaskHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var _task: SFSpeechRecognitionTask?
    var task: SFSpeechRecognitionTask? {
        get { lock.withLock { _task } }
        set { lock.withLock { _task = newValue } }
    }
}

/// The recognizer can report a final result and an error for the same run; the continuation resumes once.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func run(_ f: () -> Void) {
        let first = lock.withLock { () -> Bool in
            defer { done = true }
            return !done
        }
        if first { f() }
    }
}
#endif
