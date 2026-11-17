import SwiftUI

/// The Hum Song icon: a note beside a drum and its stick, so it reads as melody and rhythm together. SF Symbols has
/// no drum, so it is drawn here, from the same 24 by 24 drawing as the web app's icon. Each part is filled on its
/// own (the note and the stick whole, the drum with its top rim open), so where parts overlap they stay solid.
public struct HumSongGlyph: View {
    public init() {}

    public var body: some View {
        ZStack {
            HumSongGlyphPart(part: .note).fill()
            HumSongGlyphPart(part: .drum).fill(style: FillStyle(eoFill: true))
            HumSongGlyphPart(part: .stick).fill()
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

/// One part of `HumSongGlyph`, scaled from its 24 by 24 drawing to the middle of the rect.
public struct HumSongGlyphPart: Shape {
    public enum Part: Sendable { case note, drum, stick }
    public var part: Part

    public init(part: Part) { self.part = part }

    public func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let k = side / 24
        let ox = rect.midX - side / 2, oy = rect.midY - side / 2
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * k, y: oy + y * k) }

        /// Points on an ellipse (center, radii, turned by `tilt` degrees) from angle `a` to `b` in degrees, y down.
        func arc(_ p: inout Path, _ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat, from a: CGFloat, to b: CGFloat,
                 tilt: CGFloat = 0, start: Bool) {
            let steps = 32
            let t = tilt * .pi / 180
            for i in 0...steps {
                let ang = (a + (b - a) * CGFloat(i) / CGFloat(steps)) * .pi / 180
                let x = rx * cos(ang), y = ry * sin(ang)
                let q = pt(cx + x * cos(t) - y * sin(t), cy + x * sin(t) + y * cos(t))
                if i == 0 && start { p.move(to: q) } else { p.addLine(to: q) }
            }
        }

        var p = Path()
        switch part {
        case .note:
            // Head, tilted up to the right; stem; flag.
            arc(&p, 6.2, 16.2, 3.2, 2.4, from: 0, to: 360, tilt: -20, start: true)
            p.closeSubpath()
            p.addRect(CGRect(origin: pt(8.4, 3), size: CGSize(width: 1.6 * k, height: 13 * k)))
            p.move(to: pt(10, 3))
            p.addCurve(to: pt(13, 8.2), control1: pt(12, 4.2), control2: pt(13.5, 5.2))
            p.addCurve(to: pt(10, 5.6), control1: pt(12.6, 6.6), control2: pt(11.6, 5.8))
            p.closeSubpath()
        case .drum:
            // The shell: the top's far half, down the right side, the bottom's near half, up the left side. Then the
            // top's skin, which the even-odd fill leaves open inside the rim.
            arc(&p, 17, 15.5, 5, 1.9, from: 180, to: 360, start: true)
            p.addLine(to: pt(22, 20))
            arc(&p, 17, 20, 5, 1.9, from: 0, to: 180, start: false)
            p.closeSubpath()
            arc(&p, 17, 15.5, 3.6, 1.05, from: 0, to: 360, start: true)
            p.closeSubpath()
        case .stick:
            p.move(to: pt(17.2, 14.3))
            p.addLine(to: pt(21.6, 8.4))
            p.addLine(to: pt(22.5, 9.0))
            p.addLine(to: pt(18.1, 14.9))
            p.closeSubpath()
        }
        return p
    }
}
