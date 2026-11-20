import Foundation

/// Words shown while a capture is still being recorded, on a Watch that writes speech down itself: the Watch hears
/// what has been said so far again and again, each pass starting as soon as the last one ends, and the recording panel
/// shows the words as they firm up. These are the rules for which audio a pass hears and how the shown words change;
/// the final pass on the whole recording after Done is what is kept.
public enum LiveHearing {
    /// The rate the Watch keeps live audio at, the rate Whisper hears.
    public static let sampleRate = 16_000.0
    /// Whisper hears 30 seconds at a time: a longer capture shows the words of its latest 30 seconds.
    public static let maxWindow: TimeInterval = 30
    /// Under a second there is too little to hear.
    public static let minAudio: TimeInterval = 1
    /// A pass waits until at least this much has been said since the last one, so a Watch that hears fast does not
    /// hear the same audio twice.
    public static let minNew: TimeInterval = 0.5
    /// The pause after a pass before the next one starts.
    public static let pause: TimeInterval = 0.3

    /// The samples a pass hears, as positions in the whole recording: the most recent `maxWindow` of the `recorded`
    /// samples, nil while there is less than `minAudio`. `cut`: older speech is left out of this pass.
    public static func window(recorded: Int, rate: Double = sampleRate, max: TimeInterval = maxWindow, min: TimeInterval = minAudio) -> (range: Range<Int>, cut: Bool)? {
        guard recorded >= Int(min * rate) else { return nil }
        let size = Int(max * rate)
        let start = Swift.max(0, recorded - size)
        return (start..<recorded, start > 0)
    }

    /// Whether to hear again: enough new speech since the last pass, which heard up to `heard` samples.
    public static func due(recorded: Int, heard: Int, rate: Double = sampleRate) -> Bool {
        window(recorded: recorded, rate: rate) != nil && recorded - heard >= Int(minNew * rate)
    }
}

/// The words the recording panel shows while the owner speaks. Words two passes in a row agree on are firm; the rest
/// may still change as more is said. A pass that hears nothing keeps the words already shown.
public struct LiveWords: Equatable, Sendable {
    public private(set) var firm: [String] = []
    public private(set) var tentative: [String] = []
    /// The latest pass left out older speech (a capture longer than Whisper's 30 seconds).
    public private(set) var cut = false

    public init() {}

    public var isEmpty: Bool { firm.isEmpty && tentative.isEmpty }

    /// "…" when older speech is no longer shown, before the words.
    public var lead: String { cut && !isEmpty ? "…" : "" }

    public var firmText: String { firm.joined(separator: " ") }

    public var tentativeText: String { tentative.joined(separator: " ") }

    /// All of it, as the panel reads it.
    public var shown: String { [lead, firmText, tentativeText].filter { !$0.isEmpty }.joined(separator: " ") }

    /// After a pass heard `text`. `cut`: the pass heard only the latest part, so its first word may be the end of a
    /// word cut in half and is left out.
    public func updated(with text: String, cut: Bool) -> LiveWords {
        var words = Self.words(text)
        if cut, !words.isEmpty { words.removeFirst() }
        guard !words.isEmpty else { return self }
        let before = firm + tentative
        var agree = 0
        while agree < min(before.count, words.count), Self.key(before[agree]) == Self.key(words[agree]) { agree += 1 }
        var next = LiveWords()
        next.firm = Array(words.prefix(agree))
        next.tentative = Array(words.dropFirst(agree))
        next.cut = cut
        return next
    }

    /// The words of a pass, without what Whisper writes for sounds rather than speech ("[BLANK_AUDIO]", "(wind)").
    static func words(_ text: String) -> [String] {
        let bare = text.replacingOccurrences(of: #"\[[^\]]*\]|\([^)]*\)|\*[^*]*\*"#, with: " ", options: .regularExpression)
        return bare.split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /// A word for comparing two passes: the same word with other capitals or a comma after it is still the same.
    static func key(_ w: String) -> String {
        w.lowercased().trimmingCharacters(in: .punctuationCharacters)
    }
}
