import SwiftUI
import EACore

/// Add machine, from the Overview: the machines the assistant may run commands on and the sensors read, as the web's
/// Settings has them (MachinesSettings). A change goes to the hub at once, and the Overview reloads its cards
/// (`onChanged`), which come from GET /ops.
struct MachinesSheet: View {
    @Environment(\.dismiss) private var dismiss
    var onChanged: () async -> Void

    var body: some View {
        NavigationStack {
            MachinesForm(onChanged: onChanged)
                .navigationTitle("Add machine")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 500, minHeight: 560)
        #endif
    }
}

/// The machines the hub reaches (GET and PUT /machines; only machines listed are contacted) with the hub machine's
/// SSH config names to add with one tap, Add machine with an address, user and password once (POST /machines/setup),
/// and folded under "The hub can already sign in to it" a name or SSH host typed and the hub's key to add by hand. In
/// Settings, Machines on the Mac (`thisMac`) also This Mac.
struct MachinesForm: View {
    @EnvironmentObject var engine: SyncEngine
    var onChanged: () async -> Void
    var thisMac = false
    @State private var list: HubMachines?
    @State private var typed = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollViewReader { proxy in
            form
                #if DEBUG
                // `-EAScrollTo thisMac` (DebugHooksMac): This Mac at the top, for screenshots.
                .task {
                    guard UserDefaults.standard.string(forKey: "EAScrollTo") == "thisMac" else { return }
                    try? await Task.sleep(for: .seconds(2))
                    proxy.scrollTo("thisMac", anchor: .top)
                }
                #endif
        }
    }

    private var form: some View {
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
            SwiftUI.Section("Add a computer or device") {
                AddMachineRows(onAdded: added)
            }
            SwiftUI.Section {
                DisclosureGroup("The hub can already sign in to it") {
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
                    Text("For a machine whose key is already set up on the hub's machine: a name from its SSH config, or user@address.")
                        .font(.footnote).foregroundStyle(.secondary)
                    HubKeyRows()
                }
            } footer: {
                if let error { Text(error).foregroundStyle(.dangerText) }
            }
            #if os(macOS)
            if thisMac {
                SwiftUI.Section("This Mac") { ThisMacRows(onAdded: added) }.id("thisMac")
            }
            #endif
        }
        .formStyle(.grouped)
        .task { await load() }
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

    /// The hub put it in hosts.json: the list shows it at once, the Overview's cards once the board reloads.
    private func added(_ m: HubMachine) async {
        if let l = list { list = HubMachines(machines: l.machines.filter { $0.name != m.name } + [m], ssh_config: l.ssh_config) }
        await onChanged()
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
