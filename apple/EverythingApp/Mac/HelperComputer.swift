#if os(macOS)
import Foundation
import EACore

/// A helped person's Mac as their helper's computer (docs/helpers.md; the Windows app's web/src/lib/helperAgent.ts):
/// while someone helps them and "Let ... use this computer" is on (on by default, kept per Mac), it asks their hub for
/// work and runs each command (EACore HelperCommand), sending the output back. The person is not asked each time:
/// they chose to trust their helper, and their hub writes everything in the log they read. Only the main app runs it.
@MainActor
final class HelperComputer {
    static let shared = HelperComputer()
    static let key = "helperComputer.on"

    var isOn: Bool { UserDefaults.standard.object(forKey: Self.key) as? Bool ?? true }

    private weak var engine: SyncEngine?
    private var name: () -> String = { "Mac" }
    private var task: Task<Void, Never>?
    /// The hub client last told whether this Mac is on, so it is told once per connection and after each change.
    private var told: ObjectIdentifier?

    func start(engine: SyncEngine, name: @escaping () -> String) {
        guard task == nil else { return }
        self.engine = engine
        self.name = name
        task = Task { await loop() }
    }

    func setOn(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: Self.key)
        told = nil
        guard engine != nil else { return }
        task?.cancel()
        task = Task { await loop() }
    }

    private func loop() async {
        while !Task.isCancelled {
            guard let c = engine?.client else { await pause(30); continue }
            do {
                if told != ObjectIdentifier(c) {
                    try await c.setAgent(on: isOn, os: "macos", name: name())
                    told = ObjectIdentifier(c)
                }
                if !isOn { await pause(300); continue }
                let r = try await c.agentJobs(wait: 25)
                for job in r.jobs {
                    let out: (exitCode: Int, output: String)
                    // Signing in to another device in the home is the Windows app's for now; its password is not kept.
                    if job.ssh != nil { out = (1, AgentJob.macCannotSignIn) }
                    else { out = await HelperCommand.run(job.command, timeout: min(max(job.timeout_s, 5), 600)) }
                    try? await c.finishAgentJob(job.id, exitCode: out.exitCode, output: out.output)
                }
                // Nobody helps now: ask again in two minutes, so a yes on the phone reaches this Mac soon.
                if r.helping != true { await pause(120) }
            } catch let e as HubError {
                // A hub before 1.0.6 has no such route, and one signed in with the hub's main key is no device: done.
                if case let .http(status, _) = e, status == 404 || status == 403 { return }
                told = nil
                await pause(30)
            } catch {
                told = nil
                await pause(30)
            }
        }
    }

    private func pause(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
}
#endif
