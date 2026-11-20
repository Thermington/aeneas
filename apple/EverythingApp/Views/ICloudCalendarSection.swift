import SwiftUI
import EACore

/// Settings, Connections, iCloud Calendar (Calendar accounts module): the hub keeps the iCloud calendars the owner
/// chooses in step with the app, both ways, so every device has them with no Apple Calendar involved. Linking needs the
/// address's app-specific password, unless iCloud Mail already uses that address on the hub.
struct ICloudCalendarSection: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    /// Addresses linked for iCloud Mail: they need no password here.
    var mailAddresses: [String]

    @State private var view: HubCalendars?
    @State private var loadError: String?
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var message: (ok: Bool, text: String)?
    @State private var stopping: String?

    var body: some View {
        SwiftUI.Section {
            if let view {
                if view.accounts.isEmpty { linkForm } else { ForEach(view.accounts) { account($0) } }
            } else if let loadError {
                Text(loadError).font(.footnote).foregroundStyle(.dangerText)
            } else {
                ProgressView()
            }
            if let message { Text(message.text).font(.footnote).foregroundStyle(message.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(.dangerText)) }
        } header: {
            Text("iCloud Calendar")
        } footer: {
            Text(view?.accounts.isEmpty == false
                 ? "The hub syncs the chosen calendars every 5 minutes and soon after you change an event here: title, times and place, both ways. Notes, alerts and invitees stay as they are in iCloud. Repeating events come in but are changed in iCloud only. Work events never leave the hub."
                 : "Your iCloud calendars on every device, Windows, Android and the web included, kept in step by the hub both ways. Apple's app-specific password is kept on your hub only and never shown again.")
        }
        .themedRow()
        .task { await load() }
        .confirmationDialog("Stop syncing \(stopping ?? "")?", isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }), titleVisibility: .visible, presenting: stopping) { address in
            Button("Stop syncing", role: .destructive) { act { try await $0.stopCalendarSync(email: address) } }
        } message: { _ in
            Text("The hub stops syncing this address. Its events stay in the app as they are, and the occurrences of repeating events go. The password is deleted from the hub unless iCloud Mail still uses it.")
        }
    }

    // MARK: Not linked yet

    @ViewBuilder private var linkForm: some View {
        TextField("Apple Account email", text: $email)
            .textContentType(.username)
            .autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.emailAddress)
            #endif
        let known = mailAddresses.contains(email.trimmingCharacters(in: .whitespaces).lowercased())
        if !known {
            SecureField("App-specific password", text: $password)
                .textContentType(.password)
        }
        Text(known
             ? "iCloud Mail already uses this address on the hub, so its password is used here too."
             : "Make one at account.apple.com, under Sign-In and Security, App-Specific Passwords. If iCloud Mail already uses this address on the hub, leave the password empty.")
            .font(.caption).foregroundStyle(.secondary)
        Link(destination: URL(string: "https://account.apple.com/account/manage")!) { Label("Open account.apple.com", systemImage: "arrow.up.right.square") }
        Button(busy ? "Checking with iCloud" : "Link") {
            let address = email.trimmingCharacters(in: .whitespaces)
            let pass = password
            act { c in
                _ = try await c.linkICloudCalendars(email: address, password: known ? nil : pass)
                password = ""
                return "Linked. Choose the calendars to keep in step."
            }
        }
        .disabled(busy || email.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    // MARK: Linked

    @ViewBuilder private func account(_ a: HubCalendars.Account) -> some View {
        Text(a.email).font(.body.weight(.semibold))
        ForEach(a.calendars) { cal in
            Toggle(isOn: Binding(get: { cal.chosen }, set: { on in
                var chosen = a.calendars.filter(\.chosen).map(\.url)
                if on { chosen.append(cal.url) } else { chosen.removeAll { $0 == cal.url } }
                let target = a.target.flatMap { chosen.contains($0) ? $0 : nil }
                act { _ = try await $0.chooseCalendars(email: a.email, chosen: chosen, target: target); return on ? "\(cal.name) is kept in step." : "\(cal.name) is no longer synced; its events stay as they are." }
            })) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(cal.name)
                    if !cal.writable { Text("read only").font(.caption).foregroundStyle(.secondary) }
                }
            }
            .disabled(busy)
        }
        let writable = a.calendars.filter { $0.chosen && $0.writable }
        Picker("New events go to", selection: Binding(get: { a.target ?? "" }, set: { t in
            let chosen = a.calendars.filter(\.chosen).map(\.url)
            act { _ = try await $0.chooseCalendars(email: a.email, chosen: chosen, target: t.isEmpty ? nil : t); return t.isEmpty ? "Events made in Aeneas stay in the app." : "Events made in Aeneas go to \(a.calendars.first { $0.url == t }?.name ?? "that calendar")." }
        })) {
            Text("Keep them in the app").tag("")
            ForEach(writable) { Text($0.name).tag($0.url) }
        }
        .disabled(busy)
        LabeledContent("Last sync", value: a.last_sync.flatMap(ISO.date).map(\.shortDateTime) ?? "Not yet")
        if let e = a.last_error, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.dangerText) }
        Button(busy ? "Syncing" : "Sync now") {
            act { c in
                let v = try await c.syncCalendarsNow()
                return v.accounts.first { $0.email == a.email }?.last_error ?? "Synced."
            }
        }
        .disabled(busy)
        Button("Stop syncing", role: .destructive) { stopping = a.email }
            .disabled(busy)
    }

    // MARK: Hub calls

    private func load() async {
        guard let c = engine.client else { return }
        do { view = try await c.calendars(); loadError = nil } catch { loadError = error.localizedDescription }
    }

    /// One call to the hub, then the view, the module list (whether the hub keeps the calendars now) and a mirror run
    /// so this device steps aside or back at once.
    private func act(_ f: @escaping (HubClient) async throws -> String) {
        guard let client = engine.client else { return }
        busy = true
        message = nil
        Task {
            do { message = (true, try await f(client)) } catch { message = (false, error.localizedDescription) }
            await load()
            await model.refreshModules()
            EventMirrorSync.shared.scheduleRun(after: 1)
            await engine.sync()
            busy = false
        }
    }
}
