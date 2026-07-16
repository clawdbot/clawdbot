import SwiftUI

/// Animated OpenClaw mascot. Redraws the canonical 120x120 vector from
/// `ui/public/favicon.svg` so individual parts (claws, antennae, eyes) can
/// animate like the openclaw.ai hero mark; the bundled PNG asset cannot.
/// Styling (palette, glow colors, float depth) follows the openclaw.ai hero
/// (`src/pages/index.astro` + `Layout.astro` theme variables).
///
/// Beyond the site's loop, an `OpenClawMascotAnimator` layers on moods
/// (thinking, celebrating, sad, …), randomized micro-behaviors, and — when
/// `interactive` — click Easter eggs. Eyes follow the pointer on hover.
public struct OpenClawMascotView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @State private var animator: OpenClawMascotAnimator

    private let floats: Bool
    private let mood: OpenClawMascotMood
    private let interactive: Bool

    /// - Parameters:
    ///   - floats: allow whole-body vertical travel (float loop, hops). Turn
    ///     off in tight layouts; bounces then show as squash-and-stretch only.
    ///   - mood: emotional state; transitions play an entrance gesture.
    ///   - interactive: enables click reactions and auto-sleep (waking takes
    ///     a click). Off by default so the mascot never swallows taps meant
    ///     for an enclosing control.
    public init(
        floats: Bool = true,
        mood: OpenClawMascotMood = .idle,
        interactive: Bool = false)
    {
        self.floats = floats
        self.mood = mood
        self.interactive = interactive
        self._animator = State(initialValue: OpenClawMascotAnimator(allowsAutoSleep: interactive))
    }

    public var body: some View {
        let palette = OpenClawMascotPalette.forScheme(self.colorScheme)
        if self.reduceMotion {
            OpenClawMascotCanvas(pose: .staticPose(for: self.mood), palette: palette)
        } else {
            self.animatedMascot(palette: palette)
        }
    }

    @ViewBuilder
    private func animatedMascot(palette: OpenClawMascotPalette) -> some View {
        let core = TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let pose = self.animator.pose(at: timeline.date.timeIntervalSinceReferenceDate)
            // Float translates the whole canvas like the site floats the hero
            // container; drawing the offset inside the canvas would clip the
            // antennae (art starts at y~5 of 120) at the float/hop peak.
            GeometryReader { proxy in
                OpenClawMascotCanvas(pose: pose, palette: palette)
                    .offset(
                        y: self.floats
                            ? pose.floatOffset * min(proxy.size.width, proxy.size.height) / 120
                            : 0)
                    .pointerTracking(size: proxy.size) { direction in
                        self.animator.setPointerTarget(direction, at: self.now())
                    }
            }
        }
        .onChange(of: self.mood) { _, newMood in
            self.animator.setMood(newMood, at: self.now())
        }
        .onAppear {
            self.animator.setMood(self.mood, at: self.now())
        }

        if self.interactive {
            core
                .contentShape(Rectangle())
                .onTapGesture {
                    self.animator.handleTap(at: self.now())
                }
        } else {
            core
        }
    }

    private func now() -> TimeInterval {
        Date().timeIntervalSinceReferenceDate
    }

    /// openclaw.ai hero drop-shadow color (`--logo-glow` / `--logo-glow-hover`).
    /// Pair with a shadow radius of ~10% of the mascot size (15% while hovering)
    /// to match the site's `drop-shadow(0 0 20px)` on a 100px mark.
    public static func heroGlowColor(for colorScheme: ColorScheme, hovering: Bool = false) -> Color {
        switch (colorScheme, hovering) {
        case (.light, false): Color(red: 239 / 255, green: 75 / 255, blue: 88 / 255).opacity(0.2)
        case (.light, true): Color(red: 0, green: 143 / 255, blue: 135 / 255).opacity(0.35)
        case (_, false): Color(red: 1, green: 77 / 255, blue: 77 / 255).opacity(0.4)
        case (_, true): Color(red: 0, green: 229 / 255, blue: 204 / 255).opacity(0.6)
        }
    }
}

extension View {
    /// Eye-tracking hover support where pointers exist; no-op elsewhere.
    @ViewBuilder
    fileprivate func pointerTracking(
        size: CGSize,
        onMove: @escaping (CGSize?) -> Void) -> some View
    {
        #if os(iOS) || os(macOS)
        self.onContinuousHover(coordinateSpace: .local) { phase in
            switch phase {
            case let .active(point):
                guard size.width > 0, size.height > 0 else { return }
                onMove(CGSize(
                    width: (point.x - size.width / 2) / (size.width / 2),
                    height: (point.y - size.height / 2) / (size.height / 2)))
            case .ended:
                onMove(nil)
            }
        }
        #else
        self
        #endif
    }
}

/// Body/antenna colors from the openclaw.ai theme variables: `:root` (dark)
/// and `html[data-theme='light']` in `Layout.astro`. Eye colors are fixed in
/// the site markup and shared by both themes.
struct OpenClawMascotPalette: Equatable {
    let gradientTop: Color
    let gradientBottom: Color
    let antenna: Color

    static let dark = OpenClawMascotPalette(
        gradientTop: Color(red: 1, green: 77 / 255, blue: 77 / 255),
        gradientBottom: Color(red: 153 / 255, green: 27 / 255, blue: 27 / 255),
        antenna: Color(red: 1, green: 77 / 255, blue: 77 / 255))

    static let light = OpenClawMascotPalette(
        gradientTop: Color(red: 255 / 255, green: 112 / 255, blue: 121 / 255),
        gradientBottom: Color(red: 234 / 255, green: 76 / 255, blue: 89 / 255),
        antenna: Color(red: 239 / 255, green: 75 / 255, blue: 88 / 255))

    static func forScheme(_ colorScheme: ColorScheme) -> OpenClawMascotPalette {
        colorScheme == .light ? .light : .dark
    }
}

/// Part transforms and expression channels for one animation frame, produced
/// by `OpenClawMascotAnimator` (or `staticPose` under Reduce Motion) and
/// consumed by `OpenClawMascotCanvas`.
struct OpenClawMascotPose: Equatable {
    var floatOffset: CGFloat = 0
    var antennaDegrees: CGFloat = 0
    /// 0..1: antennae fold outward and down (sadness, sneeze flop).
    var antennaDroop: CGFloat = 0
    var leftClawDegrees: CGFloat = 0
    var rightClawDegrees: CGFloat = 0
    var eyeGlowOpacity: CGFloat = 1
    var glowScale: CGFloat = 1
    var leftEyeOpenness: CGFloat = 1
    var rightEyeOpenness: CGFloat = 1
    /// 0..1: morph eyes into happy ∩ arcs.
    var happyEyes: CGFloat = 0
    /// Unit-ish look direction; drawn as a small eye/glow shift.
    var gaze: CGSize = .zero
    /// -1 frown … +1 smile.
    var mouthCurve: CGFloat = 0
    /// 0..1 open grin depth (takes over from `mouthCurve`).
    var mouthOpen: CGFloat = 0
    /// 0..1 surprised/yawning "o" (takes over from both mouth channels).
    var mouthRound: CGFloat = 0
    var blush: CGFloat = 0
    /// 0..1: hard hat drops from above until seated on the head.
    var hardHat: CGFloat = 0
    /// Degrees around the canvas center.
    var bodyTilt: CGFloat = 0
    /// Vertical squash-and-stretch about the feet; x compensates slightly.
    var bodyStretch: CGFloat = 1
    /// 0..1: glow dots orbit instead of shining — too many clicks.
    var dizzy: CGFloat = 0
    var dizzyPhase: CGFloat = 0
    var effect: OpenClawMascotEffect = .none
    var effectPhase: CGFloat = 0

    /// Motionless expression per mood for Reduce Motion users.
    static func staticPose(for mood: OpenClawMascotMood) -> OpenClawMascotPose {
        var pose = OpenClawMascotPose()
        switch mood {
        case .idle, .curious, .attentive:
            break
        case .thinking:
            pose.gaze = CGSize(width: 0.3, height: -0.5)
        case .working:
            pose.hardHat = 1
            pose.rightClawDegrees = -28
            pose.gaze = CGSize(width: 0.4, height: 0.35)
            pose.mouthCurve = 0.15
            pose.bodyTilt = 2
        case .happy:
            pose.mouthCurve = 0.6
            pose.happyEyes = 0.4
        case .celebrating:
            pose.mouthCurve = 0.9
            pose.mouthOpen = 0.4
            pose.happyEyes = 0.8
            pose.leftClawDegrees = 30
            pose.rightClawDegrees = -30
        case .sad:
            pose.antennaDroop = 0.75
            pose.mouthCurve = -0.55
            pose.eyeGlowOpacity = 0.6
            pose.gaze = CGSize(width: 0, height: 0.5)
        case .sleepy:
            pose.leftEyeOpenness = 0.25
            pose.rightEyeOpenness = 0.25
            pose.eyeGlowOpacity = 0.5
            pose.antennaDroop = 0.35
        }
        return pose
    }

    /// Keeps every channel inside the range the canvas can draw without
    /// clipping the 120x120 art box (claws touch x=0/120, antennae y~5).
    mutating func clampChannels() {
        self.floatOffset = self.floatOffset.clamped(to: -12...2)
        self.antennaDegrees = self.antennaDegrees.clamped(to: -14...14)
        self.antennaDroop = self.antennaDroop.clamped(to: 0...1)
        self.leftClawDegrees = self.leftClawDegrees.clamped(to: -45...45)
        self.rightClawDegrees = self.rightClawDegrees.clamped(to: -45...45)
        self.eyeGlowOpacity = self.eyeGlowOpacity.clamped(to: 0...1)
        self.glowScale = self.glowScale.clamped(to: 0.5...1.6)
        self.leftEyeOpenness = self.leftEyeOpenness.clamped(to: 0...1)
        self.rightEyeOpenness = self.rightEyeOpenness.clamped(to: 0...1)
        self.happyEyes = self.happyEyes.clamped(to: 0...1)
        self.gaze.width = self.gaze.width.clamped(to: -1.2...1.2)
        self.gaze.height = self.gaze.height.clamped(to: -1.2...1.2)
        self.mouthCurve = self.mouthCurve.clamped(to: -1...1)
        self.mouthOpen = self.mouthOpen.clamped(to: 0...1)
        self.mouthRound = self.mouthRound.clamped(to: 0...1)
        self.blush = self.blush.clamped(to: 0...1)
        self.hardHat = self.hardHat.clamped(to: 0...1)
        self.bodyTilt = self.bodyTilt.clamped(to: -8...8)
        self.bodyStretch = self.bodyStretch.clamped(to: 0.86...1.05)
        self.dizzy = self.dizzy.clamped(to: 0...1)
    }
}

/// Internal (not private) so tests and render harnesses can draw exact poses.
struct OpenClawMascotCanvas: View {
    let pose: OpenClawMascotPose
    let palette: OpenClawMascotPalette

    var body: some View {
        Canvas { context, size in
            Self.draw(context: &context, size: size, pose: self.pose, palette: self.palette)
        }
        .accessibilityHidden(true)
    }

    // Geometry below is the favicon.svg path data in its native 120x120 space.
    private static let eyeColor = Color(red: 5 / 255, green: 8 / 255, blue: 16 / 255)
    private static let eyeGlowColor = Color(red: 0, green: 229 / 255, blue: 204 / 255)
    private static let blushColor = Color(red: 1, green: 0.62, blue: 0.68)
    private static let heartColor = Color(red: 1, green: 0.45, blue: 0.55)
    private static let hatAmber = Color(red: 0.95, green: 0.66, blue: 0.20)
    // Rotation pivots: claws hinge on their body-facing edge, antennae on their own center.
    private static let leftClawPivot = CGPoint(x: 26, y: 53)
    private static let rightClawPivot = CGPoint(x: 94, y: 53)
    private static let leftAntennaPivot = CGPoint(x: 37.5, y: 11)
    private static let rightAntennaPivot = CGPoint(x: 82.5, y: 11)
    private static let leftEyeCenter = CGPoint(x: 45, y: 35)
    private static let rightEyeCenter = CGPoint(x: 75, y: 35)

    private static let bodyPath: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 60, y: 10))
        path.addCurve(to: CGPoint(x: 15, y: 55), control1: CGPoint(x: 30, y: 10), control2: CGPoint(x: 15, y: 35))
        path.addCurve(to: CGPoint(x: 45, y: 100), control1: CGPoint(x: 15, y: 75), control2: CGPoint(x: 30, y: 95))
        path.addLine(to: CGPoint(x: 45, y: 110))
        path.addLine(to: CGPoint(x: 55, y: 110))
        path.addLine(to: CGPoint(x: 55, y: 100))
        path.addCurve(to: CGPoint(x: 65, y: 100), control1: CGPoint(x: 55, y: 100), control2: CGPoint(x: 60, y: 102))
        path.addLine(to: CGPoint(x: 65, y: 110))
        path.addLine(to: CGPoint(x: 75, y: 110))
        path.addLine(to: CGPoint(x: 75, y: 100))
        path.addCurve(to: CGPoint(x: 105, y: 55), control1: CGPoint(x: 90, y: 95), control2: CGPoint(x: 105, y: 75))
        path.addCurve(to: CGPoint(x: 60, y: 10), control1: CGPoint(x: 105, y: 35), control2: CGPoint(x: 90, y: 10))
        path.closeSubpath()
        return path
    }()

    private static let leftClawPath: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 20, y: 45))
        path.addCurve(to: CGPoint(x: 5, y: 60), control1: CGPoint(x: 5, y: 40), control2: CGPoint(x: 0, y: 50))
        path.addCurve(to: CGPoint(x: 25, y: 55), control1: CGPoint(x: 10, y: 70), control2: CGPoint(x: 20, y: 65))
        path.addCurve(to: CGPoint(x: 20, y: 45), control1: CGPoint(x: 28, y: 48), control2: CGPoint(x: 25, y: 45))
        path.closeSubpath()
        return path
    }()

    private static let rightClawPath: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 100, y: 45))
        path.addCurve(to: CGPoint(x: 115, y: 60), control1: CGPoint(x: 115, y: 40), control2: CGPoint(x: 120, y: 50))
        path.addCurve(to: CGPoint(x: 95, y: 55), control1: CGPoint(x: 110, y: 70), control2: CGPoint(x: 100, y: 65))
        path.addCurve(to: CGPoint(x: 100, y: 45), control1: CGPoint(x: 92, y: 48), control2: CGPoint(x: 95, y: 45))
        path.closeSubpath()
        return path
    }()

    private static let leftAntennaPath: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 45, y: 15))
        path.addQuadCurve(to: CGPoint(x: 30, y: 8), control: CGPoint(x: 35, y: 5))
        return path
    }()

    private static let rightAntennaPath: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 75, y: 15))
        path.addQuadCurve(to: CGPoint(x: 90, y: 8), control: CGPoint(x: 85, y: 5))
        return path
    }()

    private static func draw(
        context: inout GraphicsContext,
        size: CGSize,
        pose: OpenClawMascotPose,
        palette: OpenClawMascotPalette)
    {
        let scale = min(size.width, size.height) / 120
        context.scaleBy(x: scale, y: scale)

        // Squash-and-stretch about the feet (y=110); x compensates slightly to
        // conserve volume without pushing the claws past the 0/120 box edges.
        if pose.bodyStretch != 1 {
            let stretchX = (1 + (1 - pose.bodyStretch) * 0.5).clamped(to: 0.97...1.03)
            context.translateBy(x: 60, y: 110)
            context.scaleBy(x: stretchX, y: pose.bodyStretch)
            context.translateBy(x: -60, y: -110)
        }
        if pose.bodyTilt != 0 {
            context.translateBy(x: 60, y: 60)
            context.rotate(by: .degrees(pose.bodyTilt))
            context.translateBy(x: -60, y: -60)
        }

        // Site antennae: stroke-width 2, `--coral-bright`.
        let antennaStroke = StrokeStyle(lineWidth: 2, lineCap: .round)

        // Same paint order as favicon.svg: body, claws, antennae, then face.
        context.fill(self.bodyPath, with: self.gradient(for: self.bodyPath, palette: palette))
        self.drawRotated(context: context, degrees: pose.leftClawDegrees, pivot: self.leftClawPivot) {
            $0.fill(self.leftClawPath, with: self.gradient(for: self.leftClawPath, palette: palette))
        }
        self.drawRotated(context: context, degrees: pose.rightClawDegrees, pivot: self.rightClawPivot) {
            $0.fill(self.rightClawPath, with: self.gradient(for: self.rightClawPath, palette: palette))
        }
        // Droop folds each antenna down around its base (where it meets the
        // head) — rotating around the stroke center reads startled, not sad —
        // and damps the wiggle, which keeps its usual center pivot.
        let wiggle = pose.antennaDegrees * (1 - pose.antennaDroop)
        self.drawRotated(
            context: context,
            degrees: -pose.antennaDroop * 40,
            pivot: CGPoint(x: 45, y: 15))
        {
            self.drawRotated(context: $0, degrees: wiggle, pivot: self.leftAntennaPivot) {
                $0.stroke(self.leftAntennaPath, with: .color(palette.antenna), style: antennaStroke)
            }
        }
        self.drawRotated(
            context: context,
            degrees: pose.antennaDroop * 40,
            pivot: CGPoint(x: 75, y: 15))
        {
            self.drawRotated(context: $0, degrees: wiggle, pivot: self.rightAntennaPivot) {
                $0.stroke(self.rightAntennaPath, with: .color(palette.antenna), style: antennaStroke)
            }
        }

        self.drawHardHat(context: context, amount: pose.hardHat)
        self.drawBlush(context: context, pose: pose)
        self.drawEye(context: context, center: self.leftEyeCenter, openness: pose.leftEyeOpenness, pose: pose)
        self.drawEye(context: context, center: self.rightEyeCenter, openness: pose.rightEyeOpenness, pose: pose)
        self.drawMouth(context: context, pose: pose)
        self.drawEffect(context: context, pose: pose, palette: palette)
    }

    private static func drawEye(
        context: GraphicsContext,
        center: CGPoint,
        openness: CGFloat,
        pose: OpenClawMascotPose)
    {
        let shifted = CGPoint(
            x: center.x + pose.gaze.width * 2.0,
            y: center.y + pose.gaze.height * 1.5)

        // Open eye: the upper lid closes downward, so the visible sliver
        // keeps its lower edge as openness shrinks. The ellipse also collapses
        // while the happy arc fades in, so the crossfade reads as one morph.
        if pose.happyEyes < 1 {
            let height = max(1.2, 12 * openness * (1 - 0.6 * pose.happyEyes))
            let rect = CGRect(
                x: shifted.x - 6,
                y: shifted.y - 6 + (12 - height) * 0.65,
                width: 12,
                height: height)
            var eyeContext = context
            eyeContext.opacity = Double(1 - pose.happyEyes)
            eyeContext.fill(Path(ellipseIn: rect), with: .color(self.eyeColor))
        }

        // Happy eyes: ∩ arcs replace the open ellipse.
        if pose.happyEyes > 0 {
            var arc = Path()
            arc.move(to: CGPoint(x: shifted.x - 6, y: shifted.y + 2))
            arc.addQuadCurve(
                to: CGPoint(x: shifted.x + 6, y: shifted.y + 2),
                control: CGPoint(x: shifted.x, y: shifted.y - 5.5))
            var arcContext = context
            arcContext.opacity = Double(pose.happyEyes)
            arcContext.stroke(
                arc,
                with: .color(self.eyeColor),
                style: StrokeStyle(lineWidth: 2.6, lineCap: .round))
        }

        if pose.dizzy > 0 {
            // Orbiting dot — the classic seeing-stars spiral.
            let angle = pose.dizzyPhase * 2 * .pi + (center.x > 60 ? .pi : 0)
            let dot = CGPoint(
                x: shifted.x + cos(angle) * 3.4,
                y: shifted.y + sin(angle) * 2.6)
            var dizzyContext = context
            dizzyContext.opacity = Double(pose.dizzy)
            dizzyContext.fill(
                Path(ellipseIn: CGRect(x: dot.x - 1.8, y: dot.y - 1.8, width: 3.6, height: 3.6)),
                with: .color(self.eyeGlowColor))
        }

        let glowVisibility = Double(
            pose.eyeGlowOpacity * openness * (1 - pose.happyEyes) * (1 - pose.dizzy))
        guard glowVisibility > 0.01 else { return }
        let glowRadius = 2 * pose.glowScale
        let glowCenter = CGPoint(
            x: shifted.x + 1 + pose.gaze.width * 1.2,
            y: shifted.y - 1 + pose.gaze.height * 0.9)
        var glowContext = context
        glowContext.opacity = glowVisibility
        glowContext.fill(
            Path(ellipseIn: CGRect(
                x: glowCenter.x - glowRadius,
                y: glowCenter.y - glowRadius,
                width: glowRadius * 2,
                height: glowRadius * 2)),
            with: .color(self.eyeGlowColor))
    }

    private static func drawMouth(context: GraphicsContext, pose: OpenClawMascotPose) {
        if pose.mouthRound > 0.05 {
            let rx = 1 + 3.2 * pose.mouthRound
            let ry = 1 + 4.2 * pose.mouthRound
            context.fill(
                Path(ellipseIn: CGRect(x: 60 - rx, y: 51 - ry, width: rx * 2, height: ry * 2)),
                with: .color(self.eyeColor))
            return
        }
        if pose.mouthOpen > 0.05 {
            var grin = Path()
            grin.move(to: CGPoint(x: 52.5, y: 48.5))
            grin.addQuadCurve(
                to: CGPoint(x: 67.5, y: 48.5),
                control: CGPoint(x: 60, y: 48.5 + 14 * pose.mouthOpen))
            grin.closeSubpath()
            context.fill(grin, with: .color(self.eyeColor))
            return
        }
        guard abs(pose.mouthCurve) > 0.05 else { return }
        var curve = Path()
        curve.move(to: CGPoint(x: 52.5, y: 49))
        curve.addQuadCurve(
            to: CGPoint(x: 67.5, y: 49),
            control: CGPoint(x: 60, y: 49 + 8 * pose.mouthCurve))
        context.stroke(
            curve,
            with: .color(self.eyeColor),
            style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
    }

    private static func drawBlush(context: GraphicsContext, pose: OpenClawMascotPose) {
        guard pose.blush > 0.02 else { return }
        var blushContext = context
        blushContext.opacity = Double(pose.blush * 0.55)
        for x: CGFloat in [37, 83] {
            blushContext.fill(
                Path(ellipseIn: CGRect(x: x - 4.5, y: 42.5, width: 9, height: 5)),
                with: .color(self.blushColor))
        }
    }

    private static func drawHardHat(context: GraphicsContext, amount: CGFloat) {
        guard amount > 0.01 else { return }
        var dome = Path()
        dome.move(to: CGPoint(x: 45, y: 15))
        dome.addCurve(
            to: CGPoint(x: 60, y: 3),
            control1: CGPoint(x: 47, y: 7),
            control2: CGPoint(x: 54, y: 3))
        dome.addCurve(
            to: CGPoint(x: 75, y: 15),
            control1: CGPoint(x: 66, y: 3),
            control2: CGPoint(x: 73, y: 7))
        dome.addLine(to: CGPoint(x: 45, y: 15))
        dome.closeSubpath()
        let brim = Path(roundedRect: CGRect(x: 41, y: 14, width: 38, height: 5), cornerRadius: 2)
        var hatContext = context
        hatContext.opacity = Double(amount)
        hatContext.translateBy(x: 60, y: 15 - 14 * (1 - amount))
        hatContext.rotate(by: .degrees(-5))
        hatContext.translateBy(x: -60, y: -15)
        hatContext.fill(
            dome,
            with: .linearGradient(
                Gradient(colors: [Color(red: 1, green: 0.84, blue: 0.35), self.hatAmber]),
                startPoint: CGPoint(x: 60, y: 3),
                endPoint: CGPoint(x: 60, y: 16)))
        let outline = Color(red: 0.72, green: 0.45, blue: 0.12).opacity(0.7)
        hatContext.stroke(dome, with: .color(outline), style: StrokeStyle(lineWidth: 0.8))
        hatContext.fill(brim, with: .color(self.hatAmber))
        hatContext.stroke(brim, with: .color(outline), style: StrokeStyle(lineWidth: 0.8))
    }

    private static func drawEffect(
        context: GraphicsContext,
        pose: OpenClawMascotPose,
        palette: OpenClawMascotPalette)
    {
        switch pose.effect {
        case .none:
            return
        case .sparkles:
            for index in 0..<6 {
                let phase = (pose.effectPhase + CGFloat(index) * 0.37)
                    .truncatingRemainder(dividingBy: 1)
                let alpha = OpenClawMascotGesture.bell(phase)
                guard alpha > 0.05 else { continue }
                // Fan the stars across the upper hemisphere.
                let angle = CGFloat.pi + CGFloat.pi * (CGFloat(index) + 0.5) / 6
                let center = CGPoint(
                    x: 60 + cos(angle) * (50 + CGFloat(index % 3) * 4),
                    y: 55 + sin(angle) * (40 + CGFloat((index * 5) % 3) * 4))
                var starContext = context
                starContext.opacity = Double(alpha)
                starContext.fill(
                    self.sparklePath(center: center, size: 2.5 + 2 * alpha),
                    with: .color(index.isMultiple(of: 2) ? self.eyeGlowColor : palette.antenna))
            }
        case .hearts:
            for index in 0..<3 {
                let phase = (pose.effectPhase * 1.15 + CGFloat(index) / 3)
                    .truncatingRemainder(dividingBy: 1)
                let alpha = phase < 0.15 ? phase / 0.15 : 1 - (phase - 0.15) / 0.85
                guard alpha > 0.05 else { continue }
                // Rise from the shoulders outward so they never cover the eyes.
                let center = CGPoint(
                    x: 60 + CGFloat(index - 1) * 26 + 4 * sin(phase * 2 * .pi + CGFloat(index)),
                    y: 30 - 28 * phase)
                var heartContext = context
                heartContext.opacity = Double(alpha)
                heartContext.fill(
                    self.heartPath(center: center, size: 4.5 + CGFloat(index % 2) * 1.5),
                    with: .color(self.heartColor))
            }
        case .zzz:
            for index in 0..<3 {
                let phase = (pose.effectPhase + CGFloat(index) * 0.33)
                    .truncatingRemainder(dividingBy: 1)
                let alpha = phase < 0.2 ? phase / 0.2 : 1 - (phase - 0.2) / 0.8
                guard alpha > 0.05 else { continue }
                let position = CGPoint(
                    x: 86 + 14 * phase + 2 * sin(phase * 4 * .pi),
                    y: 24 - 20 * phase)
                var text = context.resolve(
                    Text("z")
                        .font(OpenClawChatTypography.display(
                            size: 6 + 4 * phase,
                            weight: .bold,
                            relativeTo: .caption2)))
                text.shading = .color(self.eyeGlowColor)
                var zContext = context
                zContext.opacity = Double(alpha * 0.9)
                zContext.draw(text, at: position)
            }
        case .sparks:
            for index in 0..<5 {
                let rawPhase = pose.effectPhase - CGFloat(index) * 0.025
                guard rawPhase >= 0, rawPhase < 0.45 else { continue }
                let alpha = rawPhase < 0.08 ? rawPhase / 0.08 : 1 - (rawPhase - 0.08) / 0.37
                let angle = (-160 + CGFloat(index) * 35) * .pi / 180
                let radius = 5 + 12 * rawPhase / 0.45
                let particleSize = 2.2 + CGFloat(index % 3) * 0.8
                let center = CGPoint(
                    x: (106 + cos(angle) * radius).clamped(to: particleSize...(120 - particleSize)),
                    y: (66 + sin(angle) * radius).clamped(to: particleSize...(120 - particleSize)))
                var sparkContext = context
                sparkContext.opacity = Double(alpha)
                sparkContext.fill(
                    self.sparklePath(center: center, size: particleSize),
                    with: .color(index.isMultiple(of: 2) ? self.eyeGlowColor : self.hatAmber))
            }
        case .sweat:
            let alpha = OpenClawMascotGesture.bell(pose.effectPhase)
            guard alpha > 0.02 else { return }
            let center = CGPoint(x: 42, y: 24 + 7 * pose.effectPhase)
            var drop = Path()
            drop.move(to: CGPoint(x: center.x, y: center.y - 3))
            drop.addCurve(
                to: CGPoint(x: center.x, y: center.y + 3),
                control1: CGPoint(x: center.x - 4, y: center.y + 1),
                control2: CGPoint(x: center.x - 2, y: center.y + 3))
            drop.addCurve(
                to: CGPoint(x: center.x, y: center.y - 3),
                control1: CGPoint(x: center.x + 2, y: center.y + 3),
                control2: CGPoint(x: center.x + 4, y: center.y + 1))
            var sweatContext = context
            sweatContext.opacity = Double(alpha)
            sweatContext.fill(drop, with: .color(Color(red: 0.5, green: 0.83, blue: 1)))
        }
    }

    /// Four-point sparkle: concave diamond built from quad curves.
    private static func sparklePath(center: CGPoint, size: CGFloat) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: center.x, y: center.y - size))
        for (dx, dy) in [(1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)] {
            path.addQuadCurve(
                to: CGPoint(x: center.x + size * dx, y: center.y + size * dy),
                control: center)
        }
        path.closeSubpath()
        return path
    }

    /// Small heart: two lobes plus a point, forgiving at 4-6px sizes.
    private static func heartPath(center: CGPoint, size: CGFloat) -> Path {
        var path = Path()
        let lobeRadius = size * 0.4
        for side: CGFloat in [-0.35, 0.35] {
            path.addEllipse(in: CGRect(
                x: center.x + side * size - lobeRadius,
                y: center.y - size * 0.25 - lobeRadius,
                width: lobeRadius * 2,
                height: lobeRadius * 2))
        }
        path.move(to: CGPoint(x: center.x - size * 0.7, y: center.y - size * 0.05))
        path.addLine(to: CGPoint(x: center.x + size * 0.7, y: center.y - size * 0.05))
        path.addLine(to: CGPoint(x: center.x, y: center.y + size * 0.75))
        path.closeSubpath()
        return path
    }

    /// SVG gradients default to objectBoundingBox units, so the body and each
    /// claw span the full top-left -> bottom-right ramp across their own bounds;
    /// one canvas-wide gradient would leave the claws nearly flat-colored.
    private static func gradient(
        for path: Path,
        palette: OpenClawMascotPalette) -> GraphicsContext.Shading
    {
        let box = path.boundingRect
        return .linearGradient(
            Gradient(colors: [palette.gradientTop, palette.gradientBottom]),
            startPoint: box.origin,
            endPoint: CGPoint(x: box.maxX, y: box.maxY))
    }

    private static func drawRotated(
        context: GraphicsContext,
        degrees: CGFloat,
        pivot: CGPoint,
        draw: (inout GraphicsContext) -> Void)
    {
        var rotated = context
        rotated.translateBy(x: pivot.x, y: pivot.y)
        rotated.rotate(by: .degrees(degrees))
        rotated.translateBy(x: -pivot.x, y: -pivot.y)
        draw(&rotated)
    }
}
