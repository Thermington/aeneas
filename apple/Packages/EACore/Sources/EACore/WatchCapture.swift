import Foundation

/// A capture spoken on the Watch. The Watch records it (it has no speech recognition of its own, and watchOS's
/// dictation kept only the last sentence or so of anything longer than about half a minute), and the recording goes
/// to the iPhone as a WatchConnectivity file transfer with this as its metadata, so it waits until the iPhone is in
/// reach. The iPhone turns it into text on the device, saves it as a capture (`POST /capture` with this id, so a
/// recording sent twice is saved once) and answers with a `WatchCaptureResult`.
public struct WatchVoiceCapture: Codable, Equatable, Sendable {
    /// The metadata `kind` that marks a file transfer as a spoken capture.
    public static let kind = "capture-audio"
    /// The longest capture the Watch records. Compressed speech, so five minutes is about a megabyte over Bluetooth.
    public static let maxSeconds: TimeInterval = 300
    /// The recording formats the iPhone takes; anything else is refused, since the format names the file there.
    public static let formats: Set<String> = ["m4a", "wav"]

    public var id: String
    public var seconds: Double
    public var recordedAt: Date
    /// The recording's file extension: "m4a" (compressed speech) or "wav" (where the Watch could not compress).
    public var format: String

    public init(id: String = UUID().uuidString.lowercased(), seconds: Double, recordedAt: Date = Date(), format: String = "m4a") {
        self.id = id; self.seconds = seconds; self.recordedAt = recordedAt
        self.format = Self.formats.contains(format) ? format : "m4a"
    }

    /// Property list values only, which is all WatchConnectivity carries.
    public var metadata: [String: Any] {
        ["kind": Self.kind, "id": id, "seconds": seconds, "recorded_at": ISO.string(recordedAt), "format": format]
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
        /// Saved as a capture: `outcome` says how it was filed, `text` is what was heard.
        case saved
        /// The recording held no words.
        case nothing
        case failed

        /// Messages can arrive out of order (a queued one after a direct one), so a later step never gives way to an
        /// earlier one. The Watch's own steps come first: 0 sent, 1 delivered to the iPhone.
        public var rank: Int {
            switch self {
            case .waiting: return 2
            case .saved, .nothing, .failed: return 4
            }
        }
    }

    public var id: String
    public var state: State
    /// What was heard.
    public var text: String?
    /// How it was filed: "Saved as a task", "In your diary, filing it".
    public var outcome: String?
    public var error: String?

    public init(id: String, state: State, text: String? = nil, outcome: String? = nil, error: String? = nil) {
        self.id = id; self.state = state; self.text = text; self.outcome = outcome; self.error = error
    }

    public var finished: Bool { state != .waiting }

    public var message: [String: Any] {
        var m: [String: Any] = ["kind": Self.kind, "id": id, "state": state.rawValue]
        if let text { m["text"] = text }
        if let outcome { m["outcome"] = outcome }
        if let error { m["error"] = error }
        return m
    }

    /// Nil for any other message, or a state this Watch does not know.
    public init?(message: [String: Any]) {
        guard message["kind"] as? String == Self.kind, let id = message["id"] as? String, !id.isEmpty,
              let state = (message["state"] as? String).flatMap(State.init(rawValue:)) else { return nil }
        self.init(id: id, state: state, text: message["text"] as? String, outcome: message["outcome"] as? String, error: message["error"] as? String)
    }

    /// The line the Watch shows: "Saved as a task: call the vet tomorrow".
    public var line: String {
        let t = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        switch state {
        case .waiting: return WatchHumResult.sentence(error) ?? "Your iPhone will write it down when it can"
        case .saved:
            let o = (outcome ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let what = o.isEmpty ? "Saved" : o
            return t.isEmpty ? what : "\(what): \(t)"
        case .nothing: return "Heard nothing. Try again a little closer."
        case .failed:
            let why = WatchHumResult.sentence(error) ?? "Not saved."
            return t.isEmpty ? why : "\(why) \(t)"
        }
    }

    /// How a saved capture was filed, as the Watch said it when it dictated captures itself. `online`: the iPhone
    /// reached the hub (the capture is on it), else it waits on the iPhone and goes with the next sync.
    public static func outcome(of capture: Entity, online: Bool) -> String {
        if capture.str("filing") == "pending" { return "In your diary, filing it" }
        if capture.bool("processed") == true, let k = capture.string("suggested_kind"), !k.isEmpty, k != "none" { return "Saved as a \(k)" }
        return online ? "Saved, to sort later" : "Saved, will sync"
    }
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

        public init(capture: WatchVoiceCapture, text: String? = nil, finishedAt: Date? = nil) {
            self.capture = capture; self.text = text; self.finishedAt = finishedAt
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

    /// Done with it: the recording and the words leave this queue (a saved capture is in the app's own data).
    public func finish(_ id: String, at date: Date = Date()) {
        guard var e = entry(id) else { return }
        e.finishedAt = date
        e.text = nil
        try? save(e)
        try? FileManager.default.removeItem(at: audioURL(e.capture))
    }

    public func remove(_ id: String) {
        if let e = entry(id) { try? FileManager.default.removeItem(at: audioURL(e.capture)) }
        try? FileManager.default.removeItem(at: recordURL(id))
    }

    /// Forgets finished captures after a week.
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
