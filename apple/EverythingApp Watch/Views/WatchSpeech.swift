import SwiftUI
import os
import EACore
import EAWhisper

/// Speech written down on this Watch: Whisper through WhisperKit, on a Watch that WhisperKit says can run it (Series 9,
/// Ultra 2 and later) once the model is here. The iPhone fetches the model and WatchConnectivity carries it over,
/// with nothing for the owner to do; this tells the iPhone which model to send and which files are still missing.
/// Until the model is complete (and on every other Watch) captures are written down on the iPhone only, as before.
@MainActor
final class WatchSpeech: ObservableObject {
    static let shared = WatchSpeech()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "watchspeech")
    private static let hintsKey = "watch.speechHints"

    let store = SpeechModelStore.local
    private let hearing = WatchHearing()
    /// The model this Watch writes speech down with; nil when it cannot run one.
    let model: SpeechModel?
    /// The whole model is here and checked.
    @Published private(set) var ready: Bool
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
        hints = UserDefaults.standard.stringArray(forKey: Self.hintsKey) ?? SpeechHints.expected
    }

    /// At launch: models this Watch no longer uses go (a language change), and the iPhone hears what is wanted.
    func start() {
        store.removeAll(except: model)
        if let words = WatchLink.shared.speechHints { setHints(words) }
        report()
        Self.log.notice("device \(HearingSupport.device, privacy: .public) model \(self.model?.name ?? "none", privacy: .public) ready=\(self.ready)")
    }

    /// Tells the iPhone the model this Watch wants and the files it lacks (nothing new is sent when nothing changed).
    func report() {
        WatchLink.shared.updateSpeechState(WatchSpeechState(model: model, store: store, device: HearingSupport.device))
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
        if let model { ready = store.isComplete(model) }
        report()
    }

    /// Writes captures down here.
    var canHear: Bool { model != nil && ready }

    /// Loads the model while the owner speaks, so it is ready when they stop. Loading the first time after the model
    /// arrives (or after a watchOS update) also has Core ML prepare it for this chip, which takes longest.
    func warm() {
        guard let model, ready else { return }
        let folder = store.modelFolder(model)
        Task { try? await hearing.load(folder) }
    }

    /// The words in a recording, or nil when the model could not hear it (the iPhone still writes it down).
    func transcribe(_ url: URL) async -> String? {
        guard let model, ready else { return nil }
        let started = Date()
        do {
            let words = try await hearing.transcribe(url, folder: store.modelFolder(model), prompt: SpeechHints.prompt(hints), language: language(model))
            Self.log.notice("heard on the Watch in \(String(format: "%.2f", Date().timeIntervalSince(started)), privacy: .public) s")
            return words.isEmpty ? nil : words
        } catch {
            Self.log.error("not heard on the Watch: \(String(describing: error), privacy: .public)")
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

    /// How long a live pass took, for the log (category watchspeech), so a real Watch's passes can be read in Console.
    func notePass(audio: TimeInterval, took: TimeInterval) {
        Self.log.notice("live pass \(String(format: "%.1f", audio), privacy: .public) s of speech in \(String(format: "%.2f", took), privacy: .public) s")
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
