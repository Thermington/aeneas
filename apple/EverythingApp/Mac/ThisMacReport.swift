#if os(macOS)
import AppKit
import Foundation
import EACore

/// Show this Mac in Tech (since 2026-11-20; the Windows app's web/src/lib/thisComputer.ts). Off until the person ticks
/// it, and kept per Mac. While it is on and the app runs, this Mac's CPU, memory, startup disk and macOS version go to
/// the hub every 10 minutes (PUT /devices/me/computer, read by EACore's ThisComputer) under its short host name, so a
/// Mac the hub does not sign in to still has a card in Tech. When the hub already signs in to it, the hub keeps its
/// own readings: nothing is sent and the app asks again only hourly. A hub without the route (404, older than 1.0.8) is
/// not asked again until the app starts again. Only the main app runs it.
@MainActor
final class ThisMacReport: ObservableObject {
    static let shared = ThisMacReport()
    static let key = "thisMac.report"
    static let every: TimeInterval = 10 * 60

    /// The last answer: when, under which name, whether the hub reads this Mac itself, or why nothing was kept.
    struct Last: Equatable {
        var at: Date
        var name: String
        var readByHub: Bool
        var error: String?
    }

    @Published private(set) var on = UserDefaults.standard.bool(forKey: ThisMacReport.key)
    @Published private(set) var last: Last?

    private weak var engine: SyncEngine?
    private var task: Task<Void, Never>?

    /// The name this Mac reports under, nil when its host name has nothing the hub takes.
    static var name: String? { ThisComputer.reportName(ThisComputer.hostName()) }
    /// What Add machine is filled with for this Mac: the name the home network reaches it by.
    static var address: String { "\(ThisComputer.localHostName() ?? ThisComputer.hostName()).local" }

    func start(engine: SyncEngine) {
        self.engine = engine
        restart()
    }

    func setOn(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: Self.key)
        self.on = on
        if !on { last = nil }
        restart()
    }

    private func restart() {
        task?.cancel()
        guard on, engine != nil else { task = nil; return }
        task = Task { await loop() }
    }

    private func loop() async {
        while !Task.isCancelled, on {
            guard let c = engine?.client else { await pause(60); continue }
            do {
                let r = try await send(c)
                // The hub signs in to this Mac itself: nothing for the app to send.
                await pause(r.read_by_hub ? 6 * Self.every : Self.every)
            } catch {
                if Task.isCancelled { return }
                if case .http(let status, _) = error as? HubError, status == 404 {
                    last = Last(at: Date(), name: Self.name ?? "", readByHub: false, error: "this hub is older than this app. Update it in Settings, About.")
                    return
                }
                last = Last(at: Date(), name: Self.name ?? "", readByHub: false, error: Self.words(error))
                await pause(Self.every)
            }
        }
    }

    /// Reads this Mac (about 2 seconds, off the main thread) and sends it.
    private func send(_ c: HubClient) async throws -> ComputerReport {
        guard let name = Self.name else { throw ReportError.noName }
        let output = await Task.detached(priority: .utility) { await ThisComputer.output() }.value
        let r = try await c.reportComputer(name: name, output: output)
        last = Last(at: Date(), name: r.name, readByHub: r.read_by_hub, error: nil)
        return r
    }

    private enum ReportError: LocalizedError {
        case noName
        var errorDescription: String? { "this Mac's name could not be read" }
    }

    /// The hub's own sentence when it gave one ("Machines is off on this hub"), else what went wrong.
    private static func words(_ e: Error) -> String {
        if case .http(_, let message) = e as? HubError, !message.isEmpty { return message }
        return (e as? LocalizedError)?.errorDescription ?? e.localizedDescription
    }

    private func pause(_ seconds: TimeInterval) async {
        try? await Task.sleep(for: .seconds(seconds))
    }

    /// System Settings, General, Sharing, where Remote Login is turned on (the sandbox cannot turn it on or write the
    /// hub's key to ~/.ssh, so the person does the one and Add machine does the other with their password).
    static func openSharingSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Sharing-Settings.extension") { NSWorkspace.shared.open(url) }
    }
}
#endif
