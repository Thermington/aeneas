import SwiftUI
import EACore

/// Add machine, from the Overview: the machines the assistant may run commands on and the sensors read (GET and PUT
/// /machines), as the web's Settings has them (MachinesSettings). Only machines listed here are contacted; names from
/// the hub machine's SSH config are added with one tap. A change goes to the hub at once, and the Overview reloads its
/// cards (`onChanged`), which come from GET /ops.
struct MachinesSheet: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var onChanged: () async -> Void
    @State private var list: HubMachines?
    @State private var typed = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    Text("The assistant runs read-only commands on these at once; anything that changes a machine waits for your approval. With Sensors on, the hub also reads their CPU, memory, disk and temperature every 10 minutes. No other machine is contacted.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if let list {
                    SwiftUI.Section("Machines") {
                        if list.machines.isEmpty { Text("No machines yet.").foregroundStyle(.secondary) }
                        ForEach(list.machines) { m in row(m, in: list) }
                    }
                    if !list.offers.isEmpty {
                        SwiftUI.Section {
                            FlowLayout(spacing: 8) {
                                ForEach(list.offers, id: \.self) { name in
                                    Button("Add \(name)") { add(HubMachine(name: name.lowercased(), ssh: name)) }
                                        .buttonStyle(.bordered)
                                        .disabled(busy)
                                }
                            }
                            .padding(.vertical, 4)
                        } header: {
                            Text("In the hub machine's SSH config")
                        }
                    }
                } else if error == nil {
                    SwiftUI.Section { HStack { ProgressView().controlSize(.small); Text("Loading").foregroundStyle(.secondary) } }
                }
                SwiftUI.Section {
                    HStack {
                        TextField("Name or SSH host", text: $typed, prompt: Text("Name or SSH host, for example nas01"))
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                            .onSubmit { addTyped() }
                        Button("Add") { addTyped() }
                            .buttonStyle(.borderless)
                            .disabled(busy || list == nil || HubMachine.typed(typed) == nil)
                    }
                } footer: {
                    if let error { Text(error).foregroundStyle(.red) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Add machine")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 480)
        #endif
    }

    private func row(_ m: HubMachine, in list: HubMachines) -> some View {
        let notes = [m.ssh.flatMap { $0 != m.name ? $0 : nil }, m.local == true ? "the hub machine" : nil].compactMap { $0 }
        return HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(m.name).font(.body.monospaced())
                if !notes.isEmpty { Text(notes.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 8)
            Button("Remove", role: .destructive) { save(list.machines.filter { $0.name != m.name }) }
                .buttonStyle(.borderless)
                .disabled(busy)
        }
    }

    private func load() async {
        guard let c = engine.client else { error = "Adding a machine needs the hub. Set it up in Settings."; return }
        do { list = try await c.machines(); error = nil }
        catch { self.error = "Could not read the machines: \(Homelab.errorText(error))" }
    }

    private func addTyped() {
        guard let m = HubMachine.typed(typed) else { return }
        add(m)
    }

    private func add(_ m: HubMachine) {
        guard let list else { return }
        if list.machines.contains(where: { $0.name == m.name }) { error = "\(m.name) is already on the list."; return }
        save(list.machines + [m], clearTyped: true)
    }

    /// The whole list goes at once; the hub answers with what it kept, or says in words what it refused.
    private func save(_ machines: [HubMachine], clearTyped: Bool = false) {
        guard let c = engine.client, !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let kept = try await c.setMachines(machines)
                list = HubMachines(machines: kept, ssh_config: list?.ssh_config ?? [])
                if clearTyped { typed = "" }
                await onChanged()
            } catch {
                self.error = Homelab.errorText(error)
            }
        }
    }
}
