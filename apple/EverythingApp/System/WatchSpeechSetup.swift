#if os(iOS)
import Foundation
import Network
import UIKit
import os
import EACore

/// What the Watch needs from this iPhone to write captures down itself, with nothing for the owner to do:
/// - the words to expect (`SpeechHints`: weigh, pounds, the owner's people, pet and projects), sent whenever they
///   change, which the Watch gives Whisper as its prompt (this iPhone's own speech model gets the same words);
/// - the Whisper model, once. A Watch that WhisperKit says can run it (Series 9, Ultra 2 and later) asks for it in its
///   application context; this iPhone copies the pinned files from the hub over Wi-Fi (the hub fetches them from
///   Hugging Face once, so the apps contact only the hub), checks each against its pinned size and SHA-256, and hands
///   them to WatchConnectivity, which carries them to the Watch in the background.
///   Once the Watch has the whole model, this iPhone's copy is deleted. Until then the Watch works as before (the
///   iPhone writes every capture down).
/// The iPhone does the fetching rather than the Watch, whose network goes through this iPhone anyway and whose app is
/// suspended soon after it leaves the screen: a 150 MB download there would take many returns to the app.
@MainActor
final class WatchSpeechSetup {
    static let shared = WatchSpeechSetup()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "watchspeech")

    private let store = SpeechModelStore.local
    private var running = false
    private var again = false

    func kick() { Task { await run() } }

    /// The words this owner's captures are likely to hold.
    static func hints(_ engine: SyncEngine) -> [String] {
        SpeechHints.words(people: engine.list(.person), projects: engine.list(.project), pet: UserDefaults.standard.string(forKey: PetView.nameKey) ?? "")
    }

    func run() async {
        if running { again = true; return }
        running = true
        defer { running = false }
        repeat {
            again = false
            await runOnce()
        } while again
    }

    private func runOnce() async {
        let link = WatchLink.shared
        // Before WatchConnectivity is active nothing about the Watch is known yet; activation runs this again.
        guard link.isActivated else { return }
        guard link.hasPairedWatch else {
            // No Watch with the app any more: nothing to carry, so no copy is kept.
            store.removeAll(except: nil)
            return
        }
        await AppModel.shared.ensureStarted()
        let model = AppModel.shared
        // Voice off: captures are not spoken, so no words are sent and no model is fetched.
        guard model.isOn(.voice) else { return }
        link.sendSpeechHints(Self.hints(model.engine))

        guard let state = link.watchSpeechState, let name = state.model, let wanted = SpeechModel.named(name) else {
            store.removeAll(except: nil)
            return
        }
        if state.ready {
            Self.log.notice("the Watch has \(name, privacy: .public); this iPhone's copy is deleted")
            store.removeAll(except: nil)
            return
        }
        store.removeAll(except: wanted)
        let lacking = state.missing.compactMap(wanted.file).filter { !store.has(wanted, $0) }
        if !lacking.isEmpty, !(await download(wanted, lacking)) { return }
        link.sendSpeechModelFiles(wanted, paths: state.missing, store: store)
    }

    /// Copies files of the pinned model from the hub, over a network that is not metered (Wi-Fi or wired; never
    /// cellular data or Low Data Mode), checking each against this app's own pins. The hub fetches the model from
    /// Hugging Face on the first ask (only the hub ever contacts Hugging Face); while it does, this waits a little and
    /// otherwise tries again on the next run. Files that came are kept, so one cut short goes on from there. True when
    /// every file is here.
    private func download(_ m: SpeechModel, _ files: [SpeechModel.File]) async -> Bool {
        guard let client = AppModel.shared.engine.client else { return false }
        // The phone's own network kind: copying 150 MB is for Wi-Fi, whichever way it reaches the hub.
        guard await NetworkKind.unmetered() else {
            Self.log.notice("waiting for Wi-Fi to copy \(m.name, privacy: .public)")
            return false
        }
        // The largest file takes a while over a relay: background time keeps it going if the app leaves the screen.
        let task = UIApplication.shared.beginBackgroundTask(withName: "Watch speech model") {}
        defer { UIApplication.shared.endBackgroundTask(task) }
        do {
            // Up to about two minutes for the hub to fetch it, then the next run.
            for attempt in 0..<12 {
                let s = try await client.speechModelState(m.name)
                if s.state == "ready" { break }
                if s.state == "failed" { Self.log.error("the hub could not fetch \(m.name, privacy: .public): \(s.error ?? "", privacy: .public)"); return false }
                if attempt == 11 { return false }
                try await Task.sleep(for: .seconds(10))
            }
        } catch {
            Self.log.error("asking the hub for \(m.name, privacy: .public): \(String(describing: error), privacy: .public)")
            return false
        }
        Self.log.notice("copying \(files.count) files of \(m.name, privacy: .public) from the hub")
        for f in files {
            do {
                let data = try await client.speechModelFile(m.name, path: f.path)
                let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try data.write(to: tmp)
                // Hashing 100 MB takes a moment: off the main thread. A file that does not match this app's pins is
                // refused, whatever the hub sent.
                let store = self.store
                let path = f.path
                try await Task.detached { try store.accept(tmp, as: path, for: m) }.value
            } catch {
                Self.log.error("\(f.path, privacy: .public) not copied: \(String(describing: error), privacy: .public)")
                return false
            }
        }
        return store.isComplete(m) || files.allSatisfy { store.has(m, $0) }
    }
}
/// The phone's own network, as copying a large file cares about it.
enum NetworkKind {
    /// Wi-Fi or wired and not in Low Data Mode: never cellular data. The first answer of a path monitor.
    static func unmetered() async -> Bool {
        await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            let monitor = NWPathMonitor()
            let once = OnceFlag()
            monitor.pathUpdateHandler = { p in
                guard once.take() else { return }
                monitor.cancel()
                c.resume(returning: p.status == .satisfied && !p.isExpensive && !p.isConstrained)
            }
            monitor.start(queue: .global(qos: .utility))
        }
    }

    /// The monitor can call back more than once; only the first answers.
    private final class OnceFlag: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func take() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
    }
}
#endif
