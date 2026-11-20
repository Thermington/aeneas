import Foundation
import AVFoundation
import EACore

/// Records a spoken capture on a Watch that writes speech down itself, so its words can show while the owner speaks.
/// The microphone goes through an audio engine: each piece of sound is turned into 16 kHz mono, written to the same
/// compressed recording as `HumRecorder` makes (the iPhone hears that file), and kept, its latest 30 seconds at most,
/// for the live passes (`LiveHearing`). Watches without the model record with `HumRecorder` as before, and so does
/// this Watch if the audio engine cannot start.
@MainActor
final class LiveSpeechRecorder: ObservableObject {
    @Published private(set) var recording = false
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var level: Float = 0
    @Published var error: String?
    /// Set when the take ends with Done or at the limit, as with `HumRecorder`.
    @Published var finished: HumTake?

    enum Start { case started, denied, failed }

    let limit: TimeInterval
    private let audio = LiveAudio()
    private var engine: AVAudioEngine?
    private var url: URL?
    private var clock: Task<Void, Never>?
    private var feed: Task<Void, Never>?
    private var interruption: NSObjectProtocol?

    init(limit: TimeInterval) { self.limit = limit }

    /// Starts recording. `.failed` leaves nothing behind, so the caller can record with `HumRecorder` instead.
    func start() async -> Start {
        guard !recording else { return .started }
        error = nil
        guard await HumRecorder.microphoneAllowed() else {
            error = "The microphone is not allowed. Turn it on in Settings, Privacy and Security, Microphone."
            return .denied
        }
        do {
            let session = AVAudioSession.sharedInstance()
            // As HumRecorder records speech: automatic gain kept, so a voice at arm's length comes out louder.
            try session.setCategory(.record, mode: .default, options: [])
            try session.setActive(true)
            let engine = AVAudioEngine()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw LiveAudio.Failure.noInput }
            let url = try audio.open(input: format, settings: HumRecorder.speechSettings, fallback: HumRecorder.speechFallbackSettings)
            input.installTap(onBus: 0, bufferSize: 4096, format: format) { [audio] buffer, _ in audio.take(buffer) }
            engine.prepare()
            do { try engine.start() } catch {
                input.removeTap(onBus: 0)
                audio.close(keep: false)
                throw error
            }
            self.engine = engine
            self.url = url
        } catch {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            return .failed
        }
        began()
        // A call or another app taking the microphone ends the take; what was recorded is kept.
        interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
            if began { Task { @MainActor in self?.stop() } }
        }
        return .started
    }

    #if DEBUG
    /// Simulator checks with no microphone: the file's speech is fed in at the pace it was spoken, through the same
    /// path as the microphone's, and the take ends with the file, as Done would end it.
    func start(feeding file: URL) -> Bool {
        guard !recording, let src = try? AVAudioFile(forReading: file),
              let buffer = AVAudioPCMBuffer(pcmFormat: src.processingFormat, frameCapacity: AVAudioFrameCount(src.length)),
              (try? src.read(into: buffer)) != nil, let url = try? audio.open(input: src.processingFormat, settings: HumRecorder.speechSettings, fallback: HumRecorder.speechFallbackSettings) else { return false }
        self.url = url
        began()
        let format = src.processingFormat
        let step = AVAudioFrameCount(format.sampleRate / 10)
        feed = Task { [weak self, audio] in
            var at: AVAudioFrameCount = 0
            while at < buffer.frameLength, !Task.isCancelled {
                let n = min(step, buffer.frameLength - at)
                guard let piece = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n) else { break }
                piece.frameLength = n
                for c in 0..<Int(format.channelCount) {
                    if let from = buffer.floatChannelData?[c], let to = piece.floatChannelData?[c] { to.update(from: from + Int(at), count: Int(n)) }
                }
                audio.take(piece)
                at += n
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            if !Task.isCancelled { self?.stop() }
        }
        return true
    }
    #endif

    private func began() {
        elapsed = 0
        level = 0
        recording = true
        AudioFocus.recording = true
        clock = Task { [weak self] in
            while !Task.isCancelled {
                self?.tick()
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
    }

    private func tick() {
        guard recording else { return }
        let (seconds, power) = audio.meter()
        elapsed = seconds
        // -50 dB and below shows as empty, like a mixer's meter.
        level = max(0, min(1, (power + 50) / 50))
        if seconds >= limit { stop() }
    }

    /// The audio a live pass hears now, nil while there is too little (see `LiveHearing.window`). `recorded`: how far
    /// the recording had got, for the next `due` check.
    func window() -> (samples: [Float], recorded: Int, cut: Bool)? { audio.window() }

    var recorded: Int { audio.recorded }

    /// Ends the take and hands it over in `finished`.
    func stop() { end(keep: true) }

    /// Ends the take and throws it away.
    func cancel() { end(keep: false) }

    private func end(keep: Bool) {
        guard recording else { return }
        feed?.cancel()
        feed = nil
        clock?.cancel()
        clock = nil
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        if let o = interruption { NotificationCenter.default.removeObserver(o); interruption = nil }
        let seconds = Double(audio.recorded) / LiveHearing.sampleRate
        audio.close(keep: keep)
        recording = false
        AudioFocus.recording = false
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard keep, let url else { url = nil; return }
        self.url = nil
        elapsed = seconds
        if audio.failed {
            try? FileManager.default.removeItem(at: url)
            error = "The recording stopped with an error. Try again."
            return
        }
        guard seconds >= 1 else {
            try? FileManager.default.removeItem(at: url)
            error = "That was too short to hear. Record for at least a second."
            return
        }
        finished = HumTake(url: url, seconds: seconds)
    }
}

/// The audio side of `LiveSpeechRecorder`, used from the audio thread: it converts each piece to 16 kHz mono, writes
/// it to the recording and keeps the latest samples. Everything is behind one lock.
private final class LiveAudio: @unchecked Sendable {
    enum Failure: Error { case noInput, noConverter }

    private let lock = NSLock()
    private var file: AVAudioFile?
    private var url: URL?
    private var converter: AVAudioConverter?
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: LiveHearing.sampleRate, channels: 1, interleaved: false)!
    /// The latest samples, from position `start` in the whole recording; trimmed to 30 seconds now and then.
    private var kept: [Float] = []
    private var start = 0
    private var total = 0
    private var power: Float = -160
    private(set) var failed = false

    /// A new recording in the temporary folder HumRecorder uses: compressed speech (AAC, 16 kHz), or plain 16 kHz WAV
    /// where AAC cannot start, the formats the iPhone takes.
    func open(input: AVAudioFormat, settings: [String: Any], fallback: [String: Any]) throws -> URL {
        guard let conv = AVAudioConverter(from: input, to: target) else { throw Failure.noConverter }
        // Complete unless open, as HumRecorder: a take still recording when the Watch locks can be finished.
        let folder = DataProtection.folder(FileManager.default.temporaryDirectory.appendingPathComponent("hum-takes", isDirectory: true), .completeUnlessOpen)
        let name = "capture-" + UUID().uuidString
        var url = folder.appendingPathComponent(name + ".m4a")
        let file: AVAudioFile
        if let aac = try? AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false) {
            file = aac
        } else {
            try? FileManager.default.removeItem(at: url)
            url = folder.appendingPathComponent(name + ".wav")
            file = try AVAudioFile(forWriting: url, settings: fallback, commonFormat: .pcmFormatFloat32, interleaved: false)
        }
        lock.withLock {
            self.file = file; self.url = url; converter = conv
            kept = []; start = 0; total = 0; power = -160; failed = false
        }
        return url
    }

    /// One piece of microphone sound (the audio thread).
    func take(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            guard let converter, let file else { return }
            let room = AVAudioFrameCount((Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate).rounded(.up)) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: room) else { return }
            var given = false
            var err: NSError?
            converter.convert(to: out, error: &err) { _, status in
                if given { status.pointee = .noDataNow; return nil }
                given = true
                status.pointee = .haveData
                return buffer
            }
            guard err == nil, out.frameLength > 0, let data = out.floatChannelData?[0] else { return }
            let n = Int(out.frameLength)
            do { try file.write(from: out) } catch { failed = true }
            let samples = UnsafeBufferPointer(start: data, count: n)
            kept.append(contentsOf: samples)
            total += n
            var sum: Float = 0
            for s in samples { sum += s * s }
            power = 10 * log10(max(sum / Float(n), 1e-16))
            // Trimmed in steps, not on every piece: the latest 30 seconds are all a pass hears.
            let keep = Int(LiveHearing.maxWindow * LiveHearing.sampleRate)
            if kept.count > keep + Int(10 * LiveHearing.sampleRate) {
                let drop = kept.count - keep
                kept.removeFirst(drop)
                start += drop
            }
        }
    }

    var recorded: Int { lock.withLock { total } }

    func meter() -> (seconds: TimeInterval, power: Float) {
        lock.withLock { (Double(total) / LiveHearing.sampleRate, power) }
    }

    func window() -> (samples: [Float], recorded: Int, cut: Bool)? {
        lock.withLock {
            guard let w = LiveHearing.window(recorded: total), w.range.lowerBound >= start else { return nil }
            return (Array(kept[(w.range.lowerBound - start)..<(w.range.upperBound - start)]), total, w.cut)
        }
    }

    /// Finishes the file (`keep`) or deletes it, and lets the kept samples go.
    func close(keep: Bool) {
        lock.withLock {
            file?.close()
            file = nil
            converter = nil
            kept = []
            if !keep, let url { try? FileManager.default.removeItem(at: url) }
            url = nil
        }
    }
}
