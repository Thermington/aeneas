import Foundation

/// A capture spoken on the Watch. The Watch records it (watchOS has no speech recognition for apps, and its dictation
/// kept only the last sentence or so of anything longer than about half a minute), and the recording goes to the
/// iPhone as a WatchConnectivity file transfer with this as its metadata, so it waits until the iPhone is in reach.
/// A Watch that runs Whisper (Series 9, Ultra 2 and later, once the model is on it) writes it down first and sends
/// what it heard along (`heard`), to show at once and to give the hub's filer a second hearing. The iPhone writes it
/// down again with its own model, saves that as the capture (`POST /capture` with this id, so a recording sent twice
/// is saved once) and answers with a `WatchCaptureResult`.
public struct WatchVoiceCapture: Codable, Equatable, Sendable {
    /// The metadata `kind` that marks a file transfer as a spoken capture.
    public static let kind = "capture-audio"
    /// The longest capture the Watch records. Compressed speech, so five minutes is about a megabyte over Bluetooth.
    public static let maxSeconds: TimeInterval = 300
    /// The recording formats the iPhone takes; anything else is refused, since the format names the file there.
    public static let formats: Set<String> = ["m4a", "wav"]
    /// The longest Watch hearing passed on: five minutes of speech is well under this.
    public static let maxHeard = 8000

    public var id: String
    public var seconds: Double
    public var recordedAt: Date
    /// The recording's file extension: "m4a" (compressed speech) or "wav" (where the Watch could not compress).
    public var format: String
    /// What the Watch itself heard, when it can write speech down. The iPhone's own hearing is what is saved.
    public var heard: String?

    public init(id: String = UUID().uuidString.lowercased(), seconds: Double, recordedAt: Date = Date(), format: String = "m4a", heard: String? = nil) {
        self.id = id; self.seconds = seconds; self.recordedAt = recordedAt
        self.format = Self.formats.contains(format) ? format : "m4a"
        self.heard = Self.clean(heard)
    }

    static func clean(_ s: String?) -> String? {
        let t = (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : String(t.prefix(maxHeard))
    }

    /// Property list values only, which is all WatchConnectivity carries.
    public var metadata: [String: Any] {
        var m: [String: Any] = ["kind": Self.kind, "id": id, "seconds": seconds, "recorded_at": ISO.string(recordedAt), "format": format]
        if let heard { m["heard"] = heard }
        return m
    }

    /// Nil for any other transfer. The id and the format name files on the iPhone, so only plain ones are taken.
    public init?(metadata: [String: Any]?) {
        guard let m = metadata, m["kind"] as? String == Self.kind,
              let id = m["id"] as? String, WatchHum.isPlainId(id) else { return nil }
        let format = (m["format"] as? String) ?? "m4a"
        guard Self.formats.contains(format) else { return nil }
        self.id = id
        self.format = format
        seconds = (m["seconds"] as? NSNumber)?.doubleValue ?? 0
        recordedAt = ISO.date(m["recorded_at"] as? String) ?? Date()
        heard = Self.clean(m["heard"] as? String)
    }
}

/// What the iPhone tells the Watch about a spoken capture, by `sendMessage` when the Watch is in reach, else
/// `transferUserInfo`.
public struct WatchCaptureResult: Equatable, Sendable {
    public static let kind = "capture-result"

    public enum State: String, CaseIterable, Sendable {
        /// The iPhone has it but could not turn it into text yet (the speech model downloading, the app out of
        /// background time); it tries again the next time the app is active.
        case waiting
        /// Saved as a capture: `outcome` says how it is being filed, `text` is what was heard.
        case saved
        /// The recording held no words.
        case nothing
        case failed
        /// The hub has filed it: `filed` says where ("Logs: weight 192.2 lb"), `text` is what was saved. Sent after
        /// `saved`, once the hub's filer is done.
        case filed

        /// Messages can arrive out of order (a queued one after a direct one), so a later step never gives way to an
        /// earlier one. The Watch's own steps come first: 0 sent, 1 delivered to the iPhone.
        public var rank: Int {
            switch self {
            case .waiting: return 2
            case .saved, .nothing, .failed: return 4
            case .filed: return 5
            }
        }
    }

    public var id: String
    public var state: State
    /// What the iPhone heard: the words that were saved.
    public var text: String?
    /// How it was saved: "Saved as a task", "In your diary, filing it".
    public var outcome: String?
    public var error: String?
    /// What the hub filed it as, with `filed`.
    public var filed: String?

    public init(id: String, state: State, text: String? = nil, outcome: String? = nil, error: String? = nil, filed: String? = nil) {
        self.id = id; self.state = state; self.text = text; self.outcome = outcome; self.error = error; self.filed = filed
    }

    public var finished: Bool { state != .waiting }

    public var message: [String: Any] {
        var m: [String: Any] = ["kind": Self.kind, "id": id, "state": state.rawValue]
        if let text { m["text"] = text }
        if let outcome { m["outcome"] = outcome }
        if let error { m["error"] = error }
        if let filed { m["filed"] = filed }
        return m
    }

    /// Nil for any other message, or a state this Watch does not know.
    public init?(message: [String: Any]) {
        guard message["kind"] as? String == Self.kind, let id = message["id"] as? String, !id.isEmpty,
              let state = (message["state"] as? String).flatMap(State.init(rawValue:)) else { return nil }
        self.init(id: id, state: state, text: message["text"] as? String, outcome: message["outcome"] as? String,
                  error: message["error"] as? String, filed: message["filed"] as? String)
    }

    /// The status line the Watch shows under the words: "In your diary, filing it", "Filed: Logs: weight 192.2 lb".
    /// The words show on a line of their own ("Heard: ..."), so they are not repeated here.
    public var line: String {
        switch state {
        case .waiting: return WatchHumResult.sentence(error) ?? "Your iPhone will write it down when it can"
        case .saved:
            let o = (outcome ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return o.isEmpty ? "Saved" : o
        case .nothing: return "Heard nothing. Try again a little closer."
        case .failed: return WatchHumResult.sentence(error) ?? "Not saved."
        case .filed:
            let f = (filed ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return f.isEmpty ? "Filed" : "Filed: \(f)"
        }
    }

    /// How a saved capture was filed, as the Watch said it when it dictated captures itself. `online`: the iPhone
    /// reached the hub (the capture is on it), else it waits on the iPhone and goes with the next sync.
    public static func outcome(of capture: Entity, online: Bool) -> String {
        if capture.str("filing") == "pending" { return "In your diary, filing it" }
        if capture.bool("processed") == true, let k = capture.string("suggested_kind"), !k.isEmpty, k != "none" { return "Saved as a \(k)" }
        return online ? "Saved, to sort later" : "Saved, will sync"
    }

    /// The last word on a capture once the hub has filed it (`filing` done and `filed` set, e.g. "Logs: weight 192.2
    /// lb"), with the words that were saved; nil while it is still being filed or waits to be sorted.
    public static func filed(_ capture: Entity) -> WatchCaptureResult? {
        let f = capture.str("filed").trimmingCharacters(in: .whitespacesAndNewlines)
        guard capture.str("filing") == "done", !f.isEmpty else { return nil }
        let t = capture.str("text").trimmingCharacters(in: .whitespacesAndNewlines)
        return WatchCaptureResult(id: capture.id, state: .filed, text: t.isEmpty ? nil : t, filed: f)
    }
}

/// One spoken capture on its way from the wrist, as the Watch last heard of it, and what its row on the voice page
/// shows: the words ("Heard: ..."), what the Watch heard at once and the iPhone's words once it has them, and a
/// status line under them, from "Sent to your iPhone" to "Filed: Logs: weight 192.2 lb".
public struct WatchCaptureStatus: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var seconds: Double
    public var at: Date
    /// 0 sent or waiting for the iPhone, 1 the iPhone has it, then `WatchCaptureResult.State.rank`.
    public var step: Int
    public var line: String
    public var failed: Bool
    /// What the Watch heard itself.
    public var heard: String?
    /// The Watch is writing it down now.
    public var hearing: Bool?
    /// What the iPhone heard: the words that were saved and filed.
    public var text: String?
    /// What the hub filed it as.
    public var filed: String?

    public init(id: String, seconds: Double, at: Date, step: Int, line: String, failed: Bool = false, heard: String? = nil, hearing: Bool? = nil, text: String? = nil, filed: String? = nil) {
        self.id = id; self.seconds = seconds; self.at = at; self.step = step; self.line = line; self.failed = failed
        self.heard = heard; self.hearing = hearing; self.text = text; self.filed = filed
    }

    public var finished: Bool { step >= WatchCaptureResult.State.saved.rank }

    /// The words on the row: the iPhone's once they are saved, the Watch's own until then.
    public var words: String? {
        let t = [text, heard].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
        return t.map { "Heard: \($0)" }
    }

    /// The line under the words.
    public var status: String {
        if hearing == true { return "Writing it down" }
        return line
    }

    /// What the banner at the bottom says when the row changes: the words when they first appear, then how it went.
    public var banner: String {
        if step < WatchCaptureResult.State.saved.rank, hearing != true, let w = words { return w }
        return status
    }

    /// The Watch has written it down (or given up on it: nil words).
    public mutating func heardOnWatch(_ words: String?) {
        hearing = nil
        let t = (words ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        heard = t.isEmpty ? nil : t
    }

    /// Moves to a later step. Steps only go forward: a queued message can arrive after a direct one, and the same
    /// outcome can arrive twice. False when nothing changed.
    @discardableResult
    public mutating func advance(step: Int, line: String, failed: Bool = false) -> Bool {
        guard step > self.step || (step == self.step && !finished) else { return false }
        self.step = step
        self.line = line
        self.failed = failed
        return true
    }

    /// What the iPhone said. False when it was older news than what the row shows.
    @discardableResult
    public mutating func apply(_ r: WatchCaptureResult) -> Bool {
        guard advance(step: r.state.rank, line: r.line, failed: r.state == .failed || r.state == .nothing) else { return false }
        hearing = nil
        switch r.state {
        case .saved, .filed, .failed:
            if let t = r.text?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { text = t }
            if r.state == .filed { filed = r.filed }
        case .nothing:
            // The iPhone heard no words: whatever the Watch made of it (Whisper can make words out of silence) is
            // not shown as heard.
            heard = nil
            text = nil
        case .waiting:
            break
        }
        return true
    }

    /// The capture the voice page shows under its buttons: the newest, until the next capture replaces it.
    public static func shown(_ recent: [WatchCaptureStatus]) -> WatchCaptureStatus? { recent.first }
}

/// Spoken captures kept on a device until the next step has them: on the Watch until WatchConnectivity has
/// delivered the recording, on the iPhone until it is saved as a capture and the Watch has been told. Each is
/// `<id>.json` with its recording `<id>.<format>` beside it while there is one. Kept in Application Support, not the
/// temporary folder, which the system may empty while a capture waits.
public struct WatchCaptureQueue: Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var capture: WatchVoiceCapture
        /// What the iPhone heard, kept once it has it so a capture waiting on the hub is not heard twice.
        public var text: String?
        /// When the Watch was told how it ended. The record stays a while so a repeated transfer is not saved twice.
        public var finishedAt: Date?
        /// Saved while the hub was still filing it: the Watch is told what it was filed as once the hub is done.
        public var awaitsFiling: Bool?

        public init(capture: WatchVoiceCapture, text: String? = nil, finishedAt: Date? = nil, awaitsFiling: Bool? = nil) {
            self.capture = capture; self.text = text; self.finishedAt = finishedAt; self.awaitsFiling = awaitsFiling
        }
    }

    public let folder: URL

    public init(folder: URL) { self.folder = folder }

    /// This device's queue.
    public static var local: WatchCaptureQueue {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return WatchCaptureQueue(folder: base.appendingPathComponent("watch-captures", isDirectory: true))
    }

    public func audioURL(_ c: WatchVoiceCapture) -> URL { folder.appendingPathComponent("\(c.id).\(c.format)") }
    func recordURL(_ id: String) -> URL { folder.appendingPathComponent("\(id).json") }

    public func hasAudio(_ c: WatchVoiceCapture) -> Bool { FileManager.default.fileExists(atPath: audioURL(c).path) }

    /// Moves the recording in. False when this capture is already here (sent twice), and then the file is left alone.
    @discardableResult
    public func add(_ c: WatchVoiceCapture, moving file: URL) throws -> Bool {
        guard WatchHum.isPlainId(c.id), WatchVoiceCapture.formats.contains(c.format) else { throw HubError.transport("Bad capture id") }
        guard entry(c.id) == nil else { return false }
        let fm = FileManager.default
        DataProtection.folder(folder, .untilFirstUnlock)
        let dest = audioURL(c)
        try? fm.removeItem(at: dest)
        do { try fm.moveItem(at: file, to: dest) } catch { try fm.copyItem(at: file, to: dest) }
        // A moved file keeps its own class, so it is set here.
        DataProtection.protect(dest, .untilFirstUnlock)
        do { try save(Entry(capture: c)) } catch { try? fm.removeItem(at: dest); throw error }
        return true
    }

    public func entry(_ id: String) -> Entry? {
        guard let data = try? Data(contentsOf: recordURL(id)) else { return nil }
        return try? JSONCoding.decode(Entry.self, from: data)
    }

    /// Every capture here, oldest first.
    public func all() -> [Entry] {
        guard let names = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return [] }
        return names.filter { $0.pathExtension == "json" }
            .compactMap { (try? Data(contentsOf: $0)).flatMap { try? JSONCoding.decode(Entry.self, from: $0) } }
            .sorted { $0.capture.recordedAt != $1.capture.recordedAt ? $0.capture.recordedAt < $1.capture.recordedAt : $0.capture.id < $1.capture.id }
    }

    /// Captures whose outcome the Watch has not been told yet.
    public func pending() -> [Entry] { all().filter { $0.finishedAt == nil } }

    /// What was heard, kept before it goes to the hub.
    public func setText(_ id: String, _ text: String) {
        guard var e = entry(id) else { return }
        e.text = text
        try? save(e)
    }

    /// The Watch's own hearing, added on the Watch before the recording goes (it travels in the transfer's metadata).
    public func setHeard(_ id: String, _ heard: String?) {
        guard var e = entry(id) else { return }
        e.capture.heard = WatchVoiceCapture.clean(heard)
        try? save(e)
    }

    /// Done with it: the recording and the words leave this queue (a saved capture is in the app's own data).
    /// `awaitsFiling`: the Watch is told later what the hub filed it as.
    public func finish(_ id: String, at date: Date = Date(), awaitsFiling: Bool = false) {
        guard var e = entry(id) else { return }
        e.finishedAt = date
        e.text = nil
        e.capture.heard = nil
        e.awaitsFiling = awaitsFiling ? true : nil
        try? save(e)
        try? FileManager.default.removeItem(at: audioURL(e.capture))
    }

    /// Captures saved while the hub was filing them, whose filing the Watch has not been told yet.
    public func awaitingFiling() -> [Entry] { all().filter { $0.finishedAt != nil && $0.awaitsFiling == true } }

    /// The Watch has been told what the hub filed it as.
    public func filingTold(_ id: String) {
        guard var e = entry(id), e.awaitsFiling == true else { return }
        e.awaitsFiling = nil
        try? save(e)
    }

    public func remove(_ id: String) {
        if let e = entry(id) { try? FileManager.default.removeItem(at: audioURL(e.capture)) }
        try? FileManager.default.removeItem(at: recordURL(id))
    }

    /// Forgets finished captures after a week (one still waiting on the hub's filing too: the Watch shows only the
    /// newest capture, long replaced by then).
    public func prune(now: Date = Date(), keep: TimeInterval = 7 * 86_400) {
        for e in all() { if let f = e.finishedAt, now.timeIntervalSince(f) > keep { remove(e.capture.id) } }
    }

    /// Complete until first user authentication: WatchConnectivity hands recordings over and the iPhone hears them in
    /// the background, often with the phone locked in a pocket.
    private func save(_ e: Entry) throws {
        DataProtection.folder(folder, .untilFirstUnlock)
        try DataProtection.write(JSONCoding.data(e), to: recordURL(e.capture.id), .untilFirstUnlock)
    }
}
