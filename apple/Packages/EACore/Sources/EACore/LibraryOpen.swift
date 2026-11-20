import Foundation

/// Which Library areas (Plan, Notes, Tech...) are open on this device, kept as one area title per line in a stored
/// string. Every area starts closed so all of them fit on one screen; one you open stays open until you close it. The
/// iPhone's Library tab and the iPad and Mac sidebar share the list.
public enum LibraryOpen {
    public static let key = "library.open"

    public static func titles(_ raw: String) -> [String] {
        var seen = Set<String>()
        // Homelab was renamed Tech on 2026-11-19: an area opened under the old name stays open.
        return raw.split(separator: "\n").map { $0 == "Homelab" ? "Tech" : String($0) }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public static func isOpen(_ raw: String, _ title: String) -> Bool { titles(raw).contains(title) }

    /// The stored list with `title` opened or closed.
    public static func setting(_ raw: String, _ title: String, open: Bool) -> String {
        var list = titles(raw).filter { $0 != title }
        if open { list.append(title) }
        return list.joined(separator: "\n")
    }

    public static func toggled(_ raw: String, _ title: String) -> String {
        setting(raw, title, open: !isOpen(raw, title))
    }
}
