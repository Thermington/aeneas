import Foundation
import AVFoundation
import WhisperKit

/// Which devices can write speech down themselves, decided by WhisperKit's own table of devices and the models each
/// runs (the same table argmax publishes as whisperkit-coreml's config.json): on the Watch, Series 9, Ultra 2 and later
/// (identifiers "Watch7" and "Watch8") run tiny and base. A Watch the table does not list keeps writing speech down on
/// the iPhone.
public enum HearingSupport {
    /// This device's identifier as WhisperKit reads it ("Watch7,9" on a Series 10; the Mac's in a simulator).
    public static var device: String { WhisperKit.deviceName() }

    /// True when WhisperKit lists `device` and runs `model` on it. A device the table does not list gets WhisperKit's
    /// default, which offers every model without saying the device can run them, so it does not count here.
    public static func canRun(_ model: String, device: String = HearingSupport.device) -> Bool {
        let config = Constants.fallbackModelSupportConfig
        let listed = config.deviceSupports.contains { s in s.identifiers.contains { device.hasPrefix($0) } }
        return listed && config.modelSupport(for: device).supported.contains(model)
    }
}

/// Speech written down on this device with Whisper. One model is kept loaded while the app runs, since loading takes
/// longer than hearing a short capture; the Watch starts loading it when a recording starts, so it is ready by the
/// time the person stops.
public actor WatchHearing {
    public enum Failure: Error, Equatable {
        /// The model folder could not be loaded (files missing or damaged).
        case notLoaded(String)
    }

    private var kit: WhisperKit?
    private var folder: URL?
    /// A load under way: the actor lets other calls in while it waits, and they wait for it instead of loading twice.
    private var loadingNow = false

    public init() {}

    /// Loads the model in `folder` (its Core ML files with tokenizer.json and tokenizer_config.json beside them), once.
    /// Returns how long it took; 0 when it was already loaded. Nothing is downloaded: the folder must be complete.
    @discardableResult
    public func load(_ folder: URL) async throws -> TimeInterval {
        let start = Date()
        // The load the Watch started when the recording began is waited for.
        while loadingNow { try await Task.sleep(nanoseconds: 50_000_000) }
        if let kit, self.folder == folder, kit.modelState == .loaded {
            return Date().timeIntervalSince(start) < 0.06 ? 0 : Date().timeIntervalSince(start)
        }
        loadingNow = true
        defer { loadingNow = false }
        await unload()
        let config = WhisperKitConfig(
            modelFolder: folder.path,
            tokenizerFolder: folder,
            verbose: false,
            logLevel: .error,
            // Loaded straight away: prewarming loads every part twice to save memory while Core ML prepares it.
            prewarm: false,
            load: true,
            download: false
        )
        do {
            kit = try await WhisperKit(config)
            self.folder = folder
            return Date().timeIntervalSince(start)
        } catch {
            throw Failure.notLoaded(String(describing: error))
        }
    }

    public var isLoaded: Bool { kit?.modelState == .loaded }

    public func unload() async {
        await kit?.unloadModels()
        kit = nil
        folder = nil
    }

    /// The words in an audio file (m4a or wav, any rate; WhisperKit turns it into 16 kHz mono). `prompt` is the
    /// words Aeneas expects to hear (weigh, pounds, the owner's people), given to Whisper as text it has just heard so
    /// those spellings win. `language` is a two letter code ("en"); nil lets a multilingual model find it.
    public func transcribe(_ audio: URL, folder: URL, prompt: String = "", language: String? = nil) async throws -> String {
        try await load(folder)
        guard let kit else { throw Failure.notLoaded("no model") }
        let results = try await kit.transcribe(audioPath: audio.path, decodeOptions: options(kit, prompt: prompt, language: language, live: false))
        return Self.clean(results.map(\.text).joined(separator: " "))
    }

    /// The words in audio still being recorded: 16 kHz mono samples, at most Whisper's 30 seconds (one window). A live
    /// pass makes one try only, since the next pass hears it again anyway. `shouldStop` ends it early when the owner
    /// presses Done or Cancel (checked as each word comes, so the final pass is not kept waiting).
    public func transcribe(samples: [Float], folder: URL, prompt: String = "", language: String? = nil,
                           shouldStop: (@Sendable () -> Bool)? = nil) async throws -> String {
        if shouldStop?() == true { return "" }
        try await load(folder)
        guard let kit else { throw Failure.notLoaded("no model") }
        if shouldStop?() == true { return "" }
        let stop = shouldStop
        let results = try await kit.transcribe(audioArray: samples, decodeOptions: options(kit, prompt: prompt, language: language, live: true),
                                               callback: { _ in stop?() == true ? false : nil })
        if shouldStop?() == true { return "" }
        return Self.clean(results.map(\.text).joined(separator: " "))
    }

    private func options(_ kit: WhisperKit, prompt: String, language: String?, live: Bool) -> DecodingOptions {
        var promptTokens: [Int]?
        let p = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if !p.isEmpty, let tok = kit.tokenizer {
            let ids = tok.encode(text: " " + p).filter { $0 < tok.specialTokens.specialTokenBegin }
            if !ids.isEmpty { promptTokens = ids }
        }
        let code = language.flatMap { Constants.languageCodes.contains($0) ? $0 : nil }
        return DecodingOptions(
            task: .transcribe,
            language: code,
            temperature: 0,
            // The final pass may try twice more at a higher temperature when a window comes out as repeats; each try
            // is another full pass on a small processor, so a live pass does not.
            temperatureFallbackCount: live ? 0 : 2,
            usePrefillPrompt: true,
            detectLanguage: code == nil,
            skipSpecialTokens: true,
            withoutTimestamps: true,
            // WhisperKit starts no window in the last second of the audio, which is right for a whole recording but left
            // a live pass on the first second with nothing to hear.
            windowClipTime: live ? 0.5 : 1.0,
            promptTokens: promptTokens,
            // One window at a time: the Watch has little memory to spare.
            concurrentWorkerCount: 1
        )
    }

    /// Whisper's text with the spaces it leaves between windows and at the start taken out.
    static func clean(_ s: String) -> String {
        s.split(whereSeparator: { $0 == " " || $0 == "\n" }).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// How long a model takes on this device, for the debug launch hook on the Watch (`-EAWatchHearingBench`), so the
/// owner's own Watch can be timed: loading (the first load on a device also has Core ML prepare the model for its
/// chip, which takes longest), then the same sample written down twice (the first right after loading, the second
/// as every later capture is), then live passes as the recording panel makes them while the owner speaks.
public struct HearingTiming: Codable, Equatable, Sendable {
    /// One live pass: how much speech it heard and how long it took.
    public struct LivePass: Codable, Equatable, Sendable {
        public var audioSeconds: Double
        public var seconds: Double
        public var text: String
    }

    public var model: String
    public var device: String
    public var audioSeconds: Double
    public var loadSeconds: Double
    public var firstSeconds: Double
    public var secondSeconds: Double
    public var text: String
    public var live: [LivePass]
    public var error: String?

    public init(model: String, device: String, audioSeconds: Double, loadSeconds: Double, firstSeconds: Double, secondSeconds: Double, text: String, live: [LivePass] = [], error: String? = nil) {
        self.model = model; self.device = device; self.audioSeconds = audioSeconds; self.loadSeconds = loadSeconds
        self.firstSeconds = firstSeconds; self.secondSeconds = secondSeconds; self.text = text; self.live = live; self.error = error
    }

    /// One line for the log and the screen: "openai_whisper-base.en on Watch7,9: load 4.1 s, 2.4 s of speech in 1.3 s
    /// (then 0.9 s): I weigh 192.2 today. Live: 1.0 s in 0.8 s, 2.4 s in 0.9 s, 30.0 s in 1.6 s".
    public var line: String {
        if let error { return "\(model) on \(device): \(error)" }
        func s(_ v: Double) -> String { String(format: "%.2f s", v) }
        let passes = live.map { "\(String(format: "%.1f", $0.audioSeconds)) s in \(s($0.seconds))" }.joined(separator: ", ")
        return "\(model) on \(device): load \(s(loadSeconds)), \(String(format: "%.1f", audioSeconds)) s of speech in \(s(firstSeconds)) (then \(s(secondSeconds))): \(text)"
            + (passes.isEmpty ? "" : ". Live: \(passes)")
    }

    /// Times each model folder in turn with `sample`, unloading between them so each load is measured from cold.
    public static func run(folders: [URL], sample: URL, prompt: String, language: String?) async -> [HearingTiming] {
        let device = HearingSupport.device
        let seconds = audioSeconds(sample)
        var out: [HearingTiming] = []
        for folder in folders {
            let hearing = WatchHearing()
            let name = folder.lastPathComponent
            do {
                let load = try await hearing.load(folder)
                var t0 = Date()
                let text = try await hearing.transcribe(sample, folder: folder, prompt: prompt, language: language)
                let first = Date().timeIntervalSince(t0)
                t0 = Date()
                _ = try await hearing.transcribe(sample, folder: folder, prompt: prompt, language: language)
                let second = Date().timeIntervalSince(t0)
                let live = try await livePasses(hearing, folder: folder, sample: sample, prompt: prompt, language: language)
                out.append(HearingTiming(model: name, device: device, audioSeconds: seconds, loadSeconds: load, firstSeconds: first, secondSeconds: second, text: text, live: live))
            } catch {
                out.append(HearingTiming(model: name, device: device, audioSeconds: seconds, loadSeconds: 0, firstSeconds: 0, secondSeconds: 0, text: "", error: String(describing: error)))
            }
            await hearing.unload()
        }
        return out
    }

    /// Live passes as a capture grows: the first second, then the whole sample, then a full 30 second window (the
    /// sample over and over with a pause between), which is how long a pass on a long capture takes. Whisper reads
    /// every pass as 30 seconds of sound, so the time grows with the words more than with the seconds.
    static func livePasses(_ hearing: WatchHearing, folder: URL, sample: URL, prompt: String, language: String?) async throws -> [LivePass] {
        let audio = try AudioProcessor.loadAudioAsFloatArray(fromPath: sample.path)
        let rate = 16_000
        var long: [Float] = []
        while long.count < 30 * rate { long += audio + [Float](repeating: 0, count: rate / 2) }
        let pieces: [[Float]] = [Array(audio.prefix(rate)), audio, Array(long.prefix(30 * rate))]
        var passes: [LivePass] = []
        for piece in pieces {
            let t0 = Date()
            let text = try await hearing.transcribe(samples: piece, folder: folder, prompt: prompt, language: language)
            passes.append(LivePass(audioSeconds: Double(piece.count) / Double(rate), seconds: Date().timeIntervalSince(t0), text: text))
        }
        return passes
    }

    static func audioSeconds(_ url: URL) -> Double {
        guard let f = try? AVAudioFile(forReading: url) else { return 0 }
        return Double(f.length) / f.processingFormat.sampleRate
    }
}
