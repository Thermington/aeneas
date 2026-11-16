#if DEBUG && os(macOS)
import AppKit
import SwiftUI
import UserNotifications
import EACore

/// Mac screenshot hooks, Debug builds only. Launch arguments:
///   -EASection <section>       open a section, e.g. today or week
///   -EAWindowSize 1280x800     the main window's size with its title bar, in points
///   -EASample YES              a copy that is not set up starts in sample mode, as Try it with sample data does
///   -EADictationTest YES       presses the mic on the screen shown; with -EADictationSay "<words>" it hears them
///   -EAReferenceTest YES       the Reference screen in a window of its own (its size from -EAWindowSize); prints the
///                              window number. With -EAReferenceQuery <words> it searches for them; with
///                              -EAReferenceOpen <book>/<path> (which also opens the window) that page is in the reader
/// Screenshots are then taken from outside (screencapture -o -l <window id>), which needs Screen Recording.
@MainActor
enum DebugHooksMac {
    static func applyLaunchArguments(_ model: AppModel) async {
        let d = UserDefaults.standard
        if d.bool(forKey: "EASample"), !model.isConfigured { await model.startSample() }
        if d.bool(forKey: "EAMenuTest") { Task { await menuSelfTest(model) } }
        if let s = d.string(forKey: "EASection"), let section = Section(rawValue: s) { model.section = section }
        if d.bool(forKey: "EADictationTest") { let s = model.section; Task { await dictationSelfTest(section: s) } }
        if let id = d.string(forKey: "EAModuleTest") { Task { await moduleSelfTest(model, id: id) } }
        if d.bool(forKey: "EAReferenceTest") || d.string(forKey: "EAReferenceOpen") != nil { Task { await referenceSelfTest(model) } }
        guard let size = d.string(forKey: "EAWindowSize").flatMap(parse) else { return }
        try? await Task.sleep(for: .seconds(1))
        guard let window = NSApp.windows.first(where: { $0.canBecomeMain }) else { return }
        window.setFrame(NSRect(origin: window.frame.origin, size: size), display: true)
        window.center()
    }

    /// `-EAMenuTest YES` (with `-EASample YES` on a copy that is not set up): the window commands checked from inside
    /// the app, one line each on standard output, so run the binary from a shell. When it says "ready for reopen",
    /// send what a Dock click sends (`open -b <bundle id>`); at "ready for link", open `everythingapp://week` with
    /// `open -b <bundle id>`.
    static func menuSelfTest(_ model: AppModel) async {
        func say(_ s: String) { print("menu test: " + s); fflush(stdout) }
        func mains() -> [NSWindow] {
            NSApp.windows.filter { $0.isVisible && $0.canBecomeMain && $0.identifier?.rawValue.hasPrefix("screen") != true }
        }
        func wait(_ seconds: Double, until ok: () -> Bool) async -> Bool {
            let end = Date().addingTimeInterval(seconds)
            while Date() < end {
                if ok() { return true }
                try? await Task.sleep(for: .milliseconds(200))
            }
            return ok()
        }
        func closeAll() async {
            mains().forEach { $0.performClose(nil) }
            _ = await wait(3) { mains().isEmpty }
        }
        func describe(_ title: String) -> String {
            guard let menu = NSApp.mainMenu?.items.first(where: { $0.title == title })?.submenu else { return "\(title): none" }
            let items = menu.items.filter { !$0.isSeparatorItem && !$0.isHidden }.map { i -> String in
                guard !i.keyEquivalent.isEmpty else { return i.title }
                let f = i.keyEquivalentModifierMask
                let mods = (f.contains(.control) ? "⌃" : "") + (f.contains(.option) ? "⌥" : "") + (f.contains(.shift) ? "⇧" : "") + (f.contains(.command) ? "⌘" : "")
                return "\(i.title) \(mods)\(i.keyEquivalent == " " ? "Space" : i.keyEquivalent.uppercased())"
            }
            return "\(title): " + items.joined(separator: " | ")
        }

        guard await wait(15, until: { !mains().isEmpty }) else { say("FAIL no main window at start"); return }
        say("main window at start: " + mains().map { "\($0.identifier?.rawValue ?? "none") \"\($0.title)\"" }.joined(separator: ", "))
        let app = NSApp.mainMenu?.items.first?.submenu
        say("App menu: " + (app?.items.filter { !$0.isSeparatorItem && !$0.isHidden }.map(\.title).joined(separator: " | ") ?? "none"))
        for title in ["File", "Window", "Help"] { say(describe(title)) }

        // Settings… in the app menu, with the main window closed.
        await closeAll()
        say("closed: \(mains().count) main windows open")
        if let app, let i = app.items.firstIndex(where: { $0.title.hasPrefix("Settings") }) {
            app.performActionForItem(at: i)
            let ok = await wait(5) { !mains().isEmpty && model.section == .settings }
            say((ok ? "PASS" : "FAIL") + " Settings opened the main window on Settings (\(mains().count) open, section \(model.section.rawValue))")
        } else {
            say("FAIL no Settings item")
        }

        // Aeneas in the Window menu, with the main window closed.
        await closeAll()
        if let menu = NSApp.mainMenu?.items.first(where: { $0.title == "Window" })?.submenu,
           let i = menu.items.firstIndex(where: { $0.title == "Aeneas" }) {
            menu.performActionForItem(at: i)
            let ok = await wait(5) { mains().count == 1 }
            say((ok ? "PASS" : "FAIL") + " Window, Aeneas opened the main window (\(mains().count) open)")
            menu.performActionForItem(at: i)
            try? await Task.sleep(for: .seconds(1))
            say((mains().count == 1 ? "PASS" : "FAIL") + " Window, Aeneas with it open kept one window (\(mains().count) open)")
        } else {
            say("FAIL no Aeneas item in the Window menu")
        }

        // A Dock click, sent from the shell.
        await closeAll()
        say("ready for reopen")
        let reopened = await wait(30) { !mains().isEmpty }
        say((reopened ? "PASS" : "FAIL") + " reopen brought the main window back (\(mains().count) open)")

        // A link while the main window is closed.
        await closeAll()
        model.section = .today
        say("ready for link")
        let linked = await wait(30) { !mains().isEmpty && model.section == .week }
        say((linked ? "PASS" : "FAIL") + " the link opened the main window on Week (\(mains().count) open, section \(model.section.rawValue))")
        // Settings… again with the window open: the same window, not a second one.
        if let app, let i = app.items.firstIndex(where: { $0.title.hasPrefix("Settings") }) {
            app.performActionForItem(at: i)
            try? await Task.sleep(for: .seconds(2))
            let ok = mains().count == 1 && model.section == .settings
            say((ok ? "PASS" : "FAIL") + " Settings with the window open kept one window (\(mains().count) open, section \(model.section.rawValue))")
        }
        if let w = mains().first { say("window \(w.windowNumber)") }
        // The File, Window and Help menus drawn over the window for 4 seconds each, with the menu's own window number
        // printed for a screenshot taken from the shell (`screencapture -l`).
        if let w = mains().first, let content = w.contentView {
            for title in ["File", "Window", "Help"] {
                guard let menu = NSApp.mainMenu?.items.first(where: { $0.title == title })?.submenu else { continue }
                let find = Timer(timeInterval: 0.8, repeats: false) { _ in
                    let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
                    let level = Int(CGWindowLevelForKey(.popUpMenuWindow))
                    let ids = all.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == getpid() && ($0[kCGWindowLayer as String] as? Int) == level }
                        .compactMap { $0[kCGWindowNumber as String] as? Int }
                    say("menu \(title) window \(ids.first.map(String.init) ?? "none")")
                }
                let done = Timer(timeInterval: 4, repeats: false) { _ in menu.cancelTracking() }
                RunLoop.main.add(find, forMode: .eventTracking)
                RunLoop.main.add(done, forMode: .eventTracking)
                // Near the top of the window (SwiftUI's content view is flipped), so the whole menu fits below.
                menu.popUp(positioning: nil, at: NSPoint(x: 240, y: content.isFlipped ? 30 : content.bounds.height - 30), in: content)
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
        // The sample's reminders would otherwise alert later from a copy that is no longer running.
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        say("done")
    }

    /// `-EADictationTest YES` with `-EADictationSay "<words>"` and `-EASection assistant` (or capture): runs the screen's
    /// mic button action as a click does (SwiftUI builds no accessibility tree to press it by unless an assistive app is
    /// on). The dictation prints each step ("dictation: ..."); this prints the window number for a screenshot and, on
    /// Capture, taps again after 8 seconds (Capture has no stop on a pause).
    static func dictationSelfTest(section: Section) async {
        func say(_ s: String) { print("dictation test: " + s); fflush(stdout) }
        var window: NSWindow?
        for _ in 0..<100 {
            window = NSApp.windows.first { $0.isVisible && $0.canBecomeMain && $0.identifier?.rawValue.hasPrefix("main") == true }
            if window != nil { break }
            try? await Task.sleep(for: .milliseconds(200))
        }
        guard let window else { say("FAIL no main window"); return }
        // The screen's own start (the assistant reads its chats first).
        try? await Task.sleep(for: .seconds(3))
        say("window \(window.windowNumber)")
        say("pressing the mic on \(section.rawValue)")
        NotificationCenter.default.post(name: .debugPressMic, object: nil)
        if section == .capture {
            try? await Task.sleep(for: .seconds(8))
            say("pressing the mic again to stop")
            NotificationCenter.default.post(name: .debugPressMic, object: nil)
        }
        try? await Task.sleep(for: .seconds(20))
        say("done")
    }

    /// `-EAModuleTest <module id>` (in sample mode): Settings, Modules in a window of its own with that module switched
    /// on as a click does, so the answer shown under the switch can be screenshotted. Prints the window number.
    static func moduleSelfTest(_ model: AppModel, id: String) async {
        func say(_ s: String) { print("module test: " + s); fflush(stdout) }
        try? await Task.sleep(for: .seconds(3))
        let screen = NavigationStack { ModulesSettingsView() }
            .themedRoot()
            .environmentObject(model)
            .environmentObject(model.engine)
        let w = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 640, height: 720), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        w.title = "Modules"
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: screen)
        w.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .seconds(3))
        say("flipping \(id)")
        NotificationCenter.default.post(name: .debugFlipModule, object: id)
        try? await Task.sleep(for: .seconds(3))
        say("window \(w.windowNumber)")
        try? await Task.sleep(for: .seconds(2))
        say("done")
    }

    /// `-EAReferenceTest YES` or `-EAReferenceOpen <book>/<path>`: the Reference screen in a window of its own, with
    /// its toolbar and search field, searching for `-EAReferenceQuery` and with the page open when asked. Prints the
    /// window number once the page has had time to load.
    static func referenceSelfTest(_ model: AppModel) async {
        func say(_ s: String) { print("reference test: " + s); fflush(stdout) }
        let d = UserDefaults.standard
        try? await Task.sleep(for: .seconds(2))
        let query = d.string(forKey: "EAReferenceQuery")
        var page: ReferencePageLink?
        if let s = d.string(forKey: "EAReferenceOpen") {
            if let l = ReferenceLink.split(s) { page = ReferencePageLink(book: l.book, path: l.path) } else { say("not <book>/<path>: \(s)") }
        }
        let screen = NavigationStack { ReferenceView(startQuery: query, startPage: page) }
            .themedRoot()
            .environmentObject(model)
            .environmentObject(model.engine)
        let size = d.string(forKey: "EAWindowSize").flatMap(parse) ?? NSSize(width: 1100, height: 760)
        let w = NSWindow(contentRect: NSRect(origin: NSPoint(x: 160, y: 120), size: size), styleMask: [.titled, .closable, .resizable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = "Reference"
        w.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: screen)
        // The screen's toolbar (search field, buttons) and title on this window, as in the app's own windows.
        host.sceneBridgingOptions = .all
        w.contentView = host
        w.center()
        w.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .seconds(6))
        say("window \(w.windowNumber)")
        try? await Task.sleep(for: .seconds(2))
        say("done")
    }

    private static func parse(_ s: String) -> NSSize? {
        let p = s.lowercased().split(separator: "x").compactMap { Double($0) }
        return p.count == 2 ? NSSize(width: p[0], height: p[1]) : nil
    }
}
#endif
