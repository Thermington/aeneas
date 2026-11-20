import SwiftUI
import EACore

/// Add machine (since 2026-11-20; web/src/views/settings/MachinesSetup.tsx, AddMachineForm): an address, a user and the
/// password once, or a password manager item. The hub signs in with it, puts its own key there, checks that signing in
/// with the key works and keeps nothing but the key (POST /machines/setup). The password is in this view's state only
/// until the request is sent, is cleared after it whatever the answer, and is never logged. Rows for a Form section.
struct AddMachineRows: View {
    @EnvironmentObject var engine: SyncEngine
    var onAdded: (HubMachine) async -> Void
    @State private var address: String
    @State private var user: String
    @State private var password = ""
    @State private var item = ""
    @State private var useItem = false
    /// Whether a password manager is linked on the hub (GET /setup): only then is an item offered.
    @State private var passwordManager = false
    @State private var busy = false
    @State private var error: String?
    @State private var done: String?

    /// `address` and `user` fill the form, as This Mac does with its own name.
    init(address: String = "", user: String = "", onAdded: @escaping (HubMachine) async -> Void = { _ in }) {
        _address = State(initialValue: address)
        _user = State(initialValue: user)
        self.onAdded = onAdded
    }

    private static let osName = ["linux": "Linux", "macos": "macOS", "windows": "Windows"]

    private var secret: String { useItem ? item.trimmingCharacters(in: .whitespacesAndNewlines) : password }
    private var ready: Bool {
        !busy && !address.trimmingCharacters(in: .whitespaces).isEmpty && !user.trimmingCharacters(in: .whitespaces).isEmpty && !secret.isEmpty
    }

    // Rows of the section around it, so no Group: a modifier on a Group in a Form goes on every row, and the
    // password manager question would be asked once per row.
    var body: some View {
        TextField("Address", text: $address, prompt: Text("Address, like nas.local or 192.168.1.20"))
            .modifier(PlainEntry())
            .task { passwordManager = (try? await engine.client?.passwordManagerLinked()) ?? false }
        TextField("User", text: $user, prompt: Text("User"))
            .modifier(PlainEntry())
        if useItem {
            TextField("Item", text: $item, prompt: Text("Password manager item, like Tech/NAS"))
                .modifier(PlainEntry())
        } else {
            SecureField("Password", text: $password, prompt: Text("Password"))
                .onSubmit { if ready { submit() } }
        }
        if passwordManager {
            Button(useItem ? "Type the password instead" : "Use a password manager item instead") { useItem.toggle() }
                .buttonStyle(.borderless)
        }
        HStack(spacing: 8) {
            Button(busy ? "Adding…" : "Add") { submit() }
                .buttonStyle(.themedProminent)
                .disabled(!ready)
            if busy {
                ProgressView().controlSize(.small)
                Text("Signing in and adding the hub's key. This takes a few seconds.").font(.caption).foregroundStyle(.secondary)
            }
        }
        if let done { Text(done).font(.callout).foregroundStyle(.okText) }
        if let error { Text(error).font(.callout).foregroundStyle(.dangerText) }
        Text("The password is used once, to put the hub's key there, and is not kept. The computer needs SSH on: on a Mac, System Settings, General, Sharing, Remote Login; on Windows, Settings, System, Optional features, OpenSSH Server; on Linux, the openssh-server package.")
            .font(.footnote).foregroundStyle(.secondary)
    }

    private func submit() {
        guard let c = engine.client, ready else { return }
        let a = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let u = user.trimmingCharacters(in: .whitespacesAndNewlines)
        let item = useItem
        let s = secret
        busy = true
        error = nil
        done = nil
        Task {
            defer { busy = false; password = "" }
            do {
                let r = try await c.setupMachine(address: a, user: u, password: item ? nil : s, secret: item ? s : nil)
                let os = r.machine.os.map { " (\(Self.osName[$0] ?? $0))" } ?? ""
                done = "\(r.created ? "Added" : "Set up again:") \(r.machine.name)\(os). The hub signs in with its own key now."
                address = ""
                await onAdded(r.machine)
            } catch {
                // The hub's refusals are written for people ("nas.local did not accept that user name and password").
                self.error = Homelab.errorText(error)
            }
        }
    }
}

/// A field for a name, address or item: no capitals or corrections added by the keyboard.
private struct PlainEntry: ViewModifier {
    func body(content: Content) -> some View {
        content
            .autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            #endif
    }
}

/// The hub's public SSH key, for a machine that takes only keys (the hub answers 409 for one that takes no password
/// and points here): added by hand to that account's authorized keys. Read only when asked (GET /machines/hub-key).
struct HubKeyRows: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var key: String?
    @State private var copied = false
    @State private var error: String?

    var body: some View {
        if let key {
            Text(key).font(.caption.monospaced()).textSelection(.enabled)
            Button(copied ? "Copied" : "Copy") { Homelab.copy(key); copied = true }
                .buttonStyle(.borderless)
            Text("One line in that account's ~/.ssh/authorized_keys. On Windows, an administrator's goes in C:\\ProgramData\\ssh\\administrators_authorized_keys.")
                .font(.footnote).foregroundStyle(.secondary)
        } else {
            Button("Show the hub's key, to add by hand") { Task { await load() } }
                .buttonStyle(.borderless)
            if let error { Text(error).font(.caption).foregroundStyle(.dangerText) }
        }
    }

    private func load() async {
        guard let c = engine.client else { error = "Showing the hub's key needs the hub. Set it up in Settings."; return }
        do { key = try await c.hubKey(); error = nil } catch { self.error = Homelab.errorText(error) }
    }
}

/// Set up Machines (since 2026-11-20; web MachinesStart): what Machines offers right after it is switched on in this
/// app: add a computer or device, on the Mac this Mac's own choices, and how the assistant adds one. All optional.
struct MachinesStartSheet: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    /// Nil until the hub answers; false shows where to link one.
    @State private var passwordManager: Bool?

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    Text("All of these are optional, and you can come back to them in Tech, Add machine.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                SwiftUI.Section("Add a computer or device") {
                    AddMachineRows(onAdded: { _ in await OpsBoardFeed.shared.load(engine) })
                }
                #if os(macOS)
                SwiftUI.Section("This Mac") {
                    ThisMacRows(onAdded: { _ in await OpsBoardFeed.shared.load(engine) })
                }
                #endif
                SwiftUI.Section("With the assistant") {
                    Text("Tell it to add one whose password is in your password manager, like \"add the NAS at 192.168.1.20 as admin, the password is the NAS item\". It asks before it signs in.")
                    if passwordManager == false {
                        Text("Link a password manager first in Settings, Connections.").font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Set up Machines")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { passwordManager = try? await engine.client?.passwordManagerLinked() }
        }
        #if os(macOS)
        .frame(minWidth: 540, minHeight: 600)
        #endif
    }
}

#if os(macOS)
/// This Mac (Set up Machines and Settings, Machines; the Windows app's ThisComputer): Show this Mac in Tech, and Let
/// the hub sign in to this Mac. The sandbox cannot turn on Remote Login or write the hub's key to ~/.ssh, so signing in
/// is System Settings for the one and Add machine, filled with this Mac's name and user, for the other.
struct ThisMacRows: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var report = ThisMacReport.shared
    var onAdded: (HubMachine) async -> Void = { _ in }
    /// Add machine for this Mac, shown after Let the hub sign in to this Mac.
    @State private var signingIn = Self.startSigningIn

    /// `-EAThisMacSignIn YES` (DebugHooksMac): the filled form shows without opening System Settings, for screenshots.
    private static var startSigningIn: Bool {
        #if DEBUG
        UserDefaults.standard.bool(forKey: "EAThisMacSignIn")
        #else
        false
        #endif
    }

    private var hubReads: Bool { report.last?.readByHub == true }

    var body: some View {
        Toggle(isOn: Binding(get: { report.on }, set: { report.setOn($0) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Show this Mac in Tech")
                TimelineView(.periodic(from: .now, by: 60)) { _ in
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .toggleStyle(.switch)
        if report.on && !hubReads && !model.isOn(.sensors) {
            Text("Its readings show once Sensors is on too (Settings, Modules, Tech); until then Tech shows only what it runs.")
                .font(.caption).foregroundStyle(.secondary)
        }
        if !hubReads {
            Button("Let the hub sign in to this Mac") {
                ThisMacReport.openSharingSettings()
                signingIn = true
            }
            Text("This opens System Settings, Sharing: turn on Remote Login there, then add this Mac below with your password once. The hub then reads this Mac itself and the assistant can run commands here; anything that changes this Mac waits for your yes.")
                .font(.footnote).foregroundStyle(.secondary)
            if signingIn {
                AddMachineRows(address: ThisMacReport.address, user: NSUserName(), onAdded: onAdded)
            }
        }
    }

    private var note: String {
        guard let last = report.last else {
            return "Its CPU, memory and startup disk go to the hub every 10 minutes while this app runs, read the same way the hub reads its machines."
        }
        if last.readByHub { return "The hub already signs in to \(last.name) and reads it itself, so this app sends nothing." }
        if let e = last.error { return "Not sent: \(e)" }
        return "Its CPU, memory and startup disk go to the hub every 10 minutes while this app runs. Last sent \(Homelab.ago(last.at))."
    }
}
#endif

/// Settings, Machines (while Machines is on): the machines the hub reaches and Add machine, as the Overview's Add
/// machine has them, and on the Mac this Mac's own choices.
struct MachinesSettingsPage: View {
    @EnvironmentObject var engine: SyncEngine

    var body: some View {
        MachinesForm(onChanged: { await OpsBoardFeed.shared.load(engine) }, thisMac: true)
            .themedScreen()
            .navigationTitle("Machines")
    }
}
