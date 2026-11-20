import SwiftUI
import os
import EACore
import EAWhisper

/// Speech written down on this Watch: Whisper through WhisperKit, on a Watch that WhisperKit says can run it (Series 9,
/// Ultra 2 and later) once the model is here. The iPhone fetches the model and WatchConnectivity carries it over,
/// with nothing for the owner to do; this tells the iPhone which model to send and which files are still missing.
/// Until the model is complete (and on every other Watch) captures are written down on the iPhone only, as before.
/// The model is loaded as soon as the voice page is in front (`warm`), not when a capture starts: loading takes
/// longer than a short capture, and the first load on a Watch much longer (Core ML prepares the model for its chip),
/// so a model that started loading with the recording showed no words at all. Until words come the recording panel
/// says where the model stands (`recordingNote`).
@MainActor
final class WatchSpeech: ObservableObject {
    static let shared = WatchSpeech()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "watchspeech")
    private static let hintsKey = "watch.speechHints"
    private static let timingsKey = "watch.speechTimings"
    /// The name of the model this Watch has loaded at least once (the first load is the long one).
    private static let loadedOnceKey = "watch.speechLoadedOnce"

    /// Where the model is in this app's memory.
    enum Loading: Equatable { case notYet, loading, loaded, failed }

    let store = SpeechModelStore.local
    private let hearing = WatchHearing()
    /// The model this Watch writes speech down with; nil when it cannot run one.
    let model: SpeechModel?
    /// The whole model is here and checked.
    @Published private(set) var ready: Bool
    @Published private(set) var loading: Loading = .notYet
    /// How much of the model has arrived, for the recording panel while it is still on its way.
    @Published private(set) var bytesHere: Int64
    /// How the model last did on this Watch (`SpeechTimings`), told to the iPhone for its log.
    private(set) var timings: [String: Double]
    /// The words the iPhone said to expect, given to Whisper as its prompt.
    private(set) var hints: [String]
    #if DEBUG
    /// The timing hook's lines (`-EAWatchHearingBench YES`), shown on the voice page.
    @Published var benchLines: [String] = []
    #endif

    private init() {
        let wanted = SpeechModel.forLocale(.current)
        var canRun = HearingSupport.canRun(wanted.name)
        #if DEBUG
        // Simulator checks: `-EAWatchHearing YES` treats this as a Watch that can run the model (the simulator reads as
        // the Mac it runs on, which WhisperKit's table does not list as a Watch).
        if UserDefaults.standard.bool(forKey: "EAWatchHearing") { canRun = true }
        #endif
        model = canRun ? wanted : nil
        ready = canRun && SpeechModelStore.local.isComplete(wanted)
        bytesHere = canRun ? SpeechModelStore.local.bytesHere(wanted) : 0
        hints = UserDefaults.standard.stringArray(forKey: Self.hintsKey) ?? SpeechHints.expected
        timings = (UserDefaults.standard.dictionary(forKey: Self.timingsKey) as? [String: Double]) ?? [:]
    }

    /// At launch: models this Watch no longer uses go (a language change), and the iPhone hears what is wanted.
    func start() {
        store.removeAll(except: model)
        if let words = WatchLink.shared.speechHints { setHints(words) }
        report()
        Self.log.notice("device \(HearingSupport.device, privacy: .public) model \(self.model?.name ?? "none", privacy: .public) ready=\(self.ready)")
    }

    /// Tells the iPhone the model this Watch wants, the files it lacks and how the model last did (nothing new is
    /// sent when nothing changed).
    func report() {
        WatchLink.shared.updateSpeechState(WatchSpeechState(model: model, store: store, device: HearingSupport.device, timings: timings))
    }

    /// Keeps a timing (`SpeechTimings`) for the next report.
    func note(_ key: String, _ seconds: Double) {
        timings[key] = (seconds * 10).rounded() / 10
        UserDefaults.standard.set(timings, forKey: Self.timingsKey)
    }

    /// WatchConnectivity became active or the iPhone came in reach.
    func linkChanged() {
        if let words = WatchLink.shared.speechHints { setHints(words) }
        report()
    }

    func setHints(_ words: [String]) {
        guard words != hints else { return }
        hints = words
        UserDefaults.standard.set(words, forKey: Self.hintsKey)
    }

    /// A model file came from the iPhone and was checked.
    func fileArrived() {
        if let model {
            ready = store.isComplete(model)
            bytesHere = store.bytesHere(model)
        }
        report()
    }

    /// Writes captures down here.
    var canHear: Bool { model != nil && ready }

    /// The model is in memory: a capture's words can come at once.
    var loaded: Bool { loading == .loaded }

    /// This Watch has loaded its model before, so loading now takes seconds, not the first load's minutes.
    var loadedBefore: Bool { model.map { UserDefaults.standard.string(forKey: Self.loadedOnceKey) == $0.name } ?? false }

    /// Loads the model, once, and keeps it while the app runs. Called when the voice page comes to the front and
    /// when the model arrives, so it is in memory before a capture starts, and again when a capture starts in case it
    /// is not. Loading the first time after the model arrives (or after a watchOS update) also has Core ML prepare
    /// it for this chip, which takes longest.
    func warm() {
        guard let model, ready, loading == .notYet || loading == .failed else { return }
        loading = .loading
        let folder = store.modelFolder(model)
        let first = !loadedBefore
        let started = Date()
        Task {
            do {
                #if DEBUG
                // Simulator checks: `-EAWatchSlowLoad 8` makes loading take that many seconds longer, as a real
                // Watch's first load does (the simulator loads in about a second).
                await hearing.setLoadDelay(UserDefaults.standard.double(forKey: "EAWatchSlowLoad"))
                #endif
                try await hearing.load(folder)
                let took = Date().timeIntervalSince(started)
                loading = .loaded
                UserDefaults.standard.set(model.name, forKey: Self.loadedOnceKey)
                note(SpeechTimings.load, took)
                if first { note(SpeechTimings.firstLoad, took) }
                Self.log.notice("model loaded in \(String(format: "%.1f", took), privacy: .public) s\(first ? " (the first load on this Watch)" : "", privacy: .public)")
                report()
            } catch {
                loading = .failed
                Self.log.error("the model did not load: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// What the recording panel says under the meter until the words come, on a Watch that can write speech down
    /// itself; nil on every other Watch, whose panel is as it always was. `live`: the live recorder took this capture.
    func recordingNote(live: Bool) -> String? {
        guard let model else { return nil }
        guard ready else {
            let mb = { (b: Int64) in Int((Double(b) / 1_000_000).rounded()) }
            return "Your words will show here once the speech model is on this Watch (\(mb(bytesHere)) of \(mb(model.bytes)) MB so far)."
        }
        guard live else { return "Your words show after Done this time." }
        switch loading {
        case .loaded: return "Your words will show here."
        case .failed: return "The speech model did not start. Your iPhone writes this one down."
        case .notYet, .loading:
            return loadedBefore ? "Getting ready to show your words." : "Getting ready to show your words. The first time takes longer."
        }
    }

    /// The words in a recording `seconds` long, or nil when the model could not hear it (the iPhone still writes it
    /// down).
    func transcribe(_ url: URL, seconds: Double) async -> String? {
        guard let model, ready else { return nil }
        // A model still loading is waited for here, so the time kept is the hearing alone when it was loaded.
        let wasLoaded = loaded
        warm()
        let started = Date()
        do {
            let words = try await hearing.transcribe(url, folder: store.modelFolder(model), prompt: SpeechHints.prompt(hints), language: language(model))
            let took = Date().timeIntervalSince(started)
            Self.log.notice("heard on the Watch in \(String(format: "%.2f", took), privacy: .public) s\(wasLoaded ? "" : " (with the model's loading)", privacy: .public)")
            if wasLoaded {
                note(SpeechTimings.heard, took)
                note(SpeechTimings.heardAudio, seconds)
            }
            report()
            return words.isEmpty ? nil : words
        } catch {
            Self.log.error("not heard on the Watch: \(String(describing: error), privacy: .public)")
            report()
            return nil
        }
    }

    /// The words in the latest audio of a capture still being recorded (16 kHz samples), nil when nothing came (the
    /// panel then keeps its last words). `shouldStop` ends it early when the owner presses Done or Cancel.
    func hearLive(_ samples: [Float], shouldStop: @escaping @Sendable () -> Bool) async -> String? {
        guard let model, ready else { return nil }
        do {
            let words = try await hearing.transcribe(samples: samples, folder: store.modelFolder(model), prompt: SpeechHints.prompt(hints),
                                                     language: language(model), shouldStop: shouldStop)
            return words.isEmpty ? nil : words
        } catch is CancellationError {
            // Done, Cancel, the wrist dropping or the panel leaving the screen.
            return nil
        } catch {
            Self.log.error("live pass failed: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    /// How long a live pass took, for the log (category watchspeech) and the iPhone's (`SpeechTimings`), so a real
    /// Watch's passes can be read without the Watch.
    func notePass(audio: TimeInterval, took: TimeInterval) {
        Self.log.notice("live pass \(String(format: "%.1f", audio), privacy: .public) s of speech in \(String(format: "%.2f", took), privacy: .public) s")
        note(SpeechTimings.pass, took)
        note(SpeechTimings.passAudio, audio)
    }

    private func language(_ m: SpeechModel) -> String? { m == .baseEn ? "en" : SpeechModel.language(.current) }

    #if DEBUG
    /// `-EAWatchHearingBench YES`: times every model folder on this Watch (the delivered one, plus any copied into the
    /// store folder by hand, such as tiny for comparison) with the bundled sample ("I weigh one ninety two point two
    /// today", 2.4 s): loading, the whole sample twice, then live passes as the recording panel makes them (the first
    /// second, the whole sample, a full 30 seconds), and keeps the numbers in Documents/hearing-bench.json, the log and
    /// the voice page. For timing the owner's own Watch, where the simulator's numbers say little: the simulator runs
    /// Core ML on the Mac's processor.
    func bench() async {
        guard let sample = Bundle.main.url(forResource: "hearing-sample", withExtension: "m4a") else {
            benchLines = ["No sample in this build"]
            return
        }
        let folders = ((try? FileManager.default.contentsOfDirectory(at: store.folder, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasPrefix("openai_whisper") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        guard !folders.isEmpty else {
            benchLines = ["No model on this Watch yet"]
            return
        }
        benchLines = ["Timing \(folders.count) models"]
        // The loaded model is let go first, so each load is measured from cold.
        await hearing.unload()
        loading = .notYet
        let timings = await HearingTiming.run(folders: folders, sample: sample, prompt: SpeechHints.prompt(hints), language: "en")
        benchLines = timings.map(\.line)
        for t in timings { Self.log.notice("bench \(t.line, privacy: .public)") }
        if let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
           let data = try? JSONEncoder().encode(timings) {
            try? data.write(to: docs.appendingPathComponent("hearing-bench.json"))
        }
    }
    #endif
}
