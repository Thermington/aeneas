import Foundation

/// Words a speech model should expect in a capture: what Aeneas files (weights, doses, reminders), the owner's
/// people, their pet and their projects. "Highway 192.2 today" was "I weigh 192.2 today": a model told that "weigh"
/// and "pounds" are likely hears them over a sound-alike. The iPhone builds the list, gives it to its own speech model
/// (SpeechAnalyzer's contextual strings) and sends it to the Watch, whose Whisper gets the same words as its prompt.
public enum SpeechHints {
    /// At most this many words and phrases, and this many characters in all: the Watch's Whisper takes a prompt of up
    /// about 220 tokens and keeps only its end, and a longer list makes a short capture slower to hear.
    public static let maxWords = 60
    public static let maxCharacters = 600
    public static let maxPeople = 30
    public static let maxProjects = 10

    /// The application context key the iPhone sends the list under.
    public static let contextKey = "speech_hints"

    /// What people say to Aeneas, the ways each kind of log is said and the units the app knows.
    public static var expected: [String] {
        ["remind me", "to do", "note", "idea"] + LogType.allCases.flatMap(spoken) + units
    }

    static let units = ["pounds", "kilograms", "milligrams", "cups", "minutes", "hours"]

    /// How a log type is said. Exhaustive on purpose: a new log type has to say how it sounds.
    static func spoken(_ t: LogType) -> [String] {
        switch t {
        case .weight: return ["weigh", "weight"]
        case .med: return ["took my", "medication"]
        case .bp: return ["blood pressure"]
        case .caffeine: return ["caffeine", "coffee"]
        case .sleep: return ["slept"]
        case .mood: return ["mood"]
        case .activity: return ["workout"]
        case .steps: return ["steps"]
        case .custom: return []
        }
    }

    /// The list for this owner: the expected words, then the pet, the people (those the owner described, then the
    /// most recently changed) and the active projects. Duplicates (any case) are left out, and the list stops at the
    /// caps.
    public static func words(people: [Entity], projects: [Entity], pet: String) -> [String] {
        var out: [String] = []
        var seen = Set<String>()
        var chars = 0
        func add(_ raw: String) {
            let w = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            guard !w.isEmpty, w.count <= 40, out.count < maxWords, chars + w.count <= maxCharacters,
                  seen.insert(w.lowercased()).inserted else { return }
            out.append(w)
            chars += w.count
        }
        expected.forEach(add)
        add(pet)
        let living = people.filter { $0.kind == .person && $0.deleted_at == nil && $0.str("merged_into").isEmpty }
            .sorted { a, b in
                let ra = !a.str("relationship").isEmpty, rb = !b.str("relationship").isEmpty
                if ra != rb { return ra }
                return a.updated_at > b.updated_at
            }
        for p in living.prefix(maxPeople) {
            add(p.str("name"))
            add(p.str("nickname"))
        }
        let active = projects.filter { $0.kind == .project && $0.deleted_at == nil && $0.str("status") != "done" }
            .sorted { a, b in
                let aa = a.str("status") == "active", ba = b.str("status") == "active"
                if aa != ba { return aa }
                return a.updated_at > b.updated_at
            }
        for p in active.prefix(maxProjects) { add(p.str("name")) }
        return out
    }

    /// The same words as Whisper's prompt: a plain list, as if it had just heard them.
    public static func prompt(_ words: [String]) -> String { words.joined(separator: ", ") }

    public static func context(_ words: [String]) -> [String: Any] { [contextKey: words] }

    /// The list from an application context, cleaned and capped again (it came from another device).
    public static func words(context: [String: Any]) -> [String]? {
        guard let list = context[contextKey] as? [String] else { return nil }
        var out: [String] = []
        var chars = 0
        for w in list {
            let t = w.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty, t.count <= 40, out.count < maxWords, chars + t.count <= maxCharacters else { continue }
            out.append(t)
            chars += t.count
        }
        return out
    }
}
