import SwiftUI
import EACore
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Status colors (fine, needs a look, a problem) as SwiftUI styles. They come from the theme in the environment: a
/// saved theme's own, else the classic ones for its mode (as on the web); Classic itself keeps the system's green,
/// orange and red. Resolved from the environment, so a screen, a sheet or a popover in another theme or in light or
/// dark gets its own, and a change of theme redraws them.
struct StatusStyle: ShapeStyle {
    enum Use: Hashable {
        /// Dots, bars, borders, lights: the color itself.
        case fill
        /// Words: moved toward the theme's text color until they read at 4.5:1 on its background and cards.
        case text
        /// Words on a fill of the color: white or a dark ink, whichever reads.
        case on
    }

    var tone: StatusTone
    var use: Use

    func resolve(in environment: EnvironmentValues) -> Color {
        ThemeStatus.color(tone, use, theme: environment.eaTheme?.spec, dark: environment.colorScheme == .dark)
    }
}

extension ShapeStyle where Self == StatusStyle {
    /// Fine, as a fill (a dot, a bar, a light).
    static var ok: StatusStyle { StatusStyle(tone: .ok, use: .fill) }
    /// Needs a look, as a fill.
    static var warn: StatusStyle { StatusStyle(tone: .warn, use: .fill) }
    /// A problem, as a fill.
    static var danger: StatusStyle { StatusStyle(tone: .danger, use: .fill) }
    /// Fine, as words (and the icons beside them).
    static var okText: StatusStyle { StatusStyle(tone: .ok, use: .text) }
    /// Needs a look, as words.
    static var warnText: StatusStyle { StatusStyle(tone: .warn, use: .text) }
    /// A problem, as words.
    static var dangerText: StatusStyle { StatusStyle(tone: .danger, use: .text) }
}

extension StatusTone {
    /// As a fill: a dot, a bar, an icon on its own.
    var fill: StatusStyle { StatusStyle(tone: self, use: .fill) }
    /// As words, and the icons beside them.
    var text: StatusStyle { StatusStyle(tone: self, use: .text) }
}

extension Optional where Wrapped == StatusTone {
    /// The status color as a fill, or a plain color when there is no status (unknown, planned, off).
    func fill(else plain: Color) -> AnyShapeStyle { map { AnyShapeStyle($0.fill) } ?? AnyShapeStyle(plain) }
    /// The status color as words, or a plain color when there is no status.
    func text(else plain: Color) -> AnyShapeStyle { map { AnyShapeStyle($0.text) } ?? AnyShapeStyle(plain) }
}

/// A small capsule with a status in it: the words in the status color made readable, on a light tint of the color.
/// Without a status, the words and the tint are in `color`.
struct StatusCapsule: ViewModifier {
    var tone: StatusTone?
    var color: Color
    var tint: Double

    func body(content: Content) -> some View {
        content
            .foregroundStyle(tone.text(else: color))
            .background(tone.fill(else: color).opacity(tint), in: Capsule())
    }
}

extension View {
    func statusCapsule(_ tone: StatusTone?, else color: Color, tint: Double) -> some View {
        modifier(StatusCapsule(tone: tone, color: color, tint: tint))
    }
}

/// The palettes behind `StatusStyle`, worked out once per theme and light or dark.
enum ThemeStatus {
    private struct Key: Hashable { var theme: AppTheme?; var dark: Bool }
    nonisolated(unsafe) private static var cache: [Key: StatusPalette] = [:]
    private static let lock = NSLock()

    static func palette(theme: AppTheme?, dark: Bool) -> StatusPalette {
        let key = Key(theme: theme, dark: dark)
        lock.lock(); defer { lock.unlock() }
        if let p = cache[key] { return p }
        let p = theme.map(StatusPalette.init(theme:)) ?? classic(dark: dark)
        cache[key] = p
        return p
    }

    static func color(_ tone: StatusTone, _ use: StatusStyle.Use, theme: AppTheme?, dark: Bool) -> Color {
        // Classic's fills are the system colors themselves, which follow the system's own contrast settings.
        if theme == nil, use == .fill { return systemColor(tone) }
        let p = palette(theme: theme, dark: dark)
        let hex: String?
        switch use {
        case .fill: hex = p.fill[tone]
        case .text: hex = p.text[tone]
        case .on: hex = p.on[tone]
        }
        return hex.flatMap(FeelController.color) ?? systemColor(tone)
    }

    static func systemColor(_ tone: StatusTone) -> Color {
        switch tone {
        case .ok: return .green
        case .warn: return .orange
        case .danger: return .red
        }
    }

    /// Classic: the system's green, orange and red on the system's own grouped backgrounds, in light or dark.
    private static func classic(dark: Bool) -> StatusPalette {
        #if os(iOS)
        let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        func hex(_ c: UIColor) -> String {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            c.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
            return FeelTheme.hex(r: Double(r), g: Double(g), b: Double(b))
        }
        let fill: [StatusTone: String] = [.ok: hex(.systemGreen), .warn: hex(.systemOrange), .danger: hex(.systemRed)]
        let backgrounds = [hex(.systemGroupedBackground), hex(.secondarySystemGroupedBackground), hex(.systemBackground)]
        let text = hex(.label)
        #else
        var fill: [StatusTone: String] = [:]
        var backgrounds: [String] = []
        var text = dark ? "#FFFFFF" : "#000000"
        func hex(_ c: NSColor) -> String {
            let s = c.usingColorSpace(.sRGB) ?? .gray
            return FeelTheme.hex(r: Double(s.redComponent), g: Double(s.greenComponent), b: Double(s.blueComponent))
        }
        (NSAppearance(named: dark ? .darkAqua : .aqua) ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance {
            fill = [.ok: hex(.systemGreen), .warn: hex(.systemOrange), .danger: hex(.systemRed)]
            backgrounds = [hex(.windowBackgroundColor), hex(.controlBackgroundColor), hex(.underPageBackgroundColor)]
            text = hex(.labelColor)
        }
        #endif
        let ink = dark ? "#000000" : "#111111"
        return StatusPalette(fill: fill, text: text, backgrounds: backgrounds, ink: ink)
    }
}

/// Today's and Week's events in their calendar's color (the owner's choice in Theme, Calendar colors, else the color
/// Apple Calendar or iCloud gives the calendar), else the theme's accent, as on the web.
enum EventColor {
    /// The event's calendar color, or the accent (`.tint`) for an event on no calendar or one without a color.
    static func style(_ e: Entity, calendars: [CalendarColorEntry]) -> AnyShapeStyle {
        if let c = EventCalendar.color(of: e, calendars: calendars).flatMap(FeelController.color) { return AnyShapeStyle(c) }
        return AnyShapeStyle(.tint)
    }
}
