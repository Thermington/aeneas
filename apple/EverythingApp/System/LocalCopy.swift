import Foundation
import EACore

/// This app's own copies of the person's data, apart from the sync store (which the engine empties): the chats copy,
/// cached pictures and files, what was given to Spotlight, and what the app keeps from the hub in its own settings.
/// Removed when the hub says this device was removed.
@MainActor
enum LocalCopy {
    static func wipeAppFiles() async {
        await SpotlightIndexer.shared.clear()
        // The wiki's page list, the last dashboard, and the pet's and owner's names from the hub's profile.
        WikiCache.clear()
        DashboardCache.clear()
        for key in [PetView.nameKey, AdminGames.ownerKey] { UserDefaults.standard.removeObject(forKey: key) }
        // Reference: the pages read on this device and where each was left.
        ReferenceHistory.shared.clear()
        for key in [ReferenceHistory.recentsKey, ReferenceHistory.positionsKey, ReferenceHistory.hubKey] { UserDefaults.standard.removeObject(forKey: key) }
        let fm = FileManager.default
        if let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            for name in ["chats.json"] { try? fm.removeItem(at: support.appendingPathComponent("EverythingApp", isDirectory: true).appendingPathComponent(name)) }
        }
        // Caches hold pictures, wiki attachments and MIDI from the hub; everything there is this app's own.
        if let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first,
           let items = try? fm.contentsOfDirectory(at: caches, includingPropertiesForKeys: nil) {
            for u in items { try? fm.removeItem(at: u) }
        }
    }
}
