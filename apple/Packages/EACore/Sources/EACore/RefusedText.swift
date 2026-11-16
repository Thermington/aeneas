import Foundation

/// An edit the hub refused, in plain words, as the web shows it (`web/src/lib/errors.ts`): why, and what it changed
/// field by field so it can be typed again. The hub sends its sentence with the details as JSON after it.
public enum RefusedText {
    /// Why, as the end of a sentence: "the hub did not accept due", "it is no longer on the hub".
    public static func reason(_ reason: String) -> String {
        let r = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        if let m = r.range(of: #"^(invalid fields|validation failed)\b"#, options: .regularExpression) {
            let rest = String(r[m.upperBound...])
            var names: [String] = []
            for path in matches(#""path":\[([^\]]*)\]"#, in: rest) {
                let parts = matches(#""([^"]+)""#, in: path).map(words)
                let name = parts.joined(separator: " ")
                if !name.isEmpty, !names.contains(name) { names.append(name) }
            }
            return names.isEmpty ? "the hub did not accept what was changed" : "the hub did not accept \(inWords(names))"
        }
        if r.hasPrefix("entity not found") { return "it is no longer on the hub" }
        if r.hasPrefix("kind mismatch") { return "the hub has it as another kind of item" }
        if r.hasPrefix("too large to send") { return "it was \(r)" }
        let plain = r.replacingOccurrences(of: #":\s*[\[{].*$"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return plain.isEmpty ? "the hub said no" : plain
    }

    /// What was changed, one "field: value" line each ("remind at: 2026-11-16T14:00:00.000Z"); long values are cut at
    /// 200 characters and empty ones left out. `fields` is the JSON object the engine kept.
    public static func values(_ fields: String) -> [String] {
        guard let data = fields.data(using: .utf8),
              let object = try? JSONDecoder().decode([String: JSONValue].self, from: data) else { return fields.isEmpty ? [] : [fields] }
        return object.keys.sorted().compactMap { key in
            let text: String
            switch object[key]! {
            case .null: return nil
            case .string(let s): if s.isEmpty { return nil }; text = s
            default: text = (try? String(decoding: JSONEncoder().encode(object[key]!), as: UTF8.self)) ?? ""
            }
            return "\(words(key)): \(text.count > 200 ? String(text.prefix(197)) + "..." : text)"
        }
    }

    /// "remind_at" is "remind at".
    static func words(_ key: String) -> String { key.replacingOccurrences(of: "_", with: " ") }

    /// "a", "a and b", "a, b and c".
    static func inWords(_ xs: [String]) -> String {
        xs.count < 2 ? xs.joined() : xs.dropLast().joined(separator: ", ") + " and " + xs[xs.count - 1]
    }

    private static func matches(_ pattern: String, in text: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            m.numberOfRanges > 1 ? ns.substring(with: m.range(at: 1)) : nil
        }
    }
}
