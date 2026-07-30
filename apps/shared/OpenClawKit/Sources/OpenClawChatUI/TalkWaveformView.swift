import SwiftUI

private enum TalkWaveformClock {
    static let born = Date()
}

/// Universal OpenClaw talk animation: an iOS 9-style Siri waveform shared by the
/// iOS, watchOS, and macOS apps; the Android app ports the same math in Compose
/// (`TalkWaveform.kt`). Math adapted from noahchalifour/swiftui-siri-waveform-view
/// (MIT), as packaged by alfianlosari/SiriWaveView; redrawn with Canvas +
/// TimelineView so lobes flow continuously instead of re-randomizing per power
/// change.
///
/// This file is also compiled directly into the watch target, which links no
/// packages (see `apps/ios/project.yml`). Keep it dependency-free SwiftUI.
public enum TalkWaveformPhase: Equatable, Sendable {
    /// Voice surface is off or unavailable: flat, static, dimmed.
    case idle
    /// Connecting or waiting on the agent. No audio exists in this state, so the
    /// wave breathes on a slow synthetic swell by design.
    case thinking
    /// Capturing the user's voice. `level` is the live microphone level in 0...1;
    /// `speechActive` raises the floor once endpointing detects actual speech.
    case listening(level: Double, speechActive: Bool)
    /// Agent speech playback. `level` is the live playback envelope in 0...1.
    /// `nil` means the active voice path exposes no envelope (AVSpeechSynthesizer
    /// and compressed streaming playback have no metering API); the wave then
    /// falls back to a synthetic pulse rather than freezing.
    case speaking(level: Double?)
}

/// Wave colors, front to back. Surfaces embedding the wave on tinted backgrounds
/// (for example the macOS orb) pass their own colors.
public struct TalkWaveformPalette: Equatable, Sendable {
    public var active: [Color]
    public var inactive: [Color]

    public init(active: [Color], inactive: [Color]) {
        self.active = active
        self.inactive = inactive
    }

    public static let standard = TalkWaveformPalette(
        active: [
            Color(red: 198 / 255.0, green: 62 / 255.0, blue: 56 / 255.0),
            Color(red: 79 / 255.0, green: 200 / 255.0, blue: 174 / 255.0),
            Color(red: 0.45, green: 0.08, blue: 0.12),
        ],
        inactive: [
            Color(white: 0.62),
            Color(white: 0.72),
            Color(white: 0.82),
        ])
}

public struct TalkWaveformView: View {
    public var phase: TalkWaveformPhase
    public var palette: TalkWaveformPalette

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(phase: TalkWaveformPhase, palette: TalkWaveformPalette = .standard) {
        self.phase = phase
        self.palette = palette
    }

    public var body: some View {
        let frozen = self.reduceMotion || self.phase == .idle
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: frozen)) { timeline in
            let time = frozen ? 0 : timeline.date.timeIntervalSince(TalkWaveformClock.born)
            let power = TalkWaveformMath.power(for: self.phase, time: time)
            Canvas { context, size in
                let midY = size.height / 2
                var line = Path()
                line.move(to: CGPoint(x: 0, y: midY))
                line.addLine(to: CGPoint(x: size.width, y: midY))
                context.stroke(line, with: .color(.secondary.opacity(0.30)), lineWidth: 1)

                // Screen blend pops on dark; opacity overlap reads better on light.
                context.blendMode = self.colorScheme == .dark ? .screen : .normal
                let opacity = self.colorScheme == .dark ? 0.9 : 0.55
                for (index, color) in self.colors.enumerated() {
                    let path = TalkWaveformMath.wavePath(
                        in: size,
                        time: time,
                        seed: Double(index) * 7.31,
                        power: power)
                    context.fill(path, with: .color(color.opacity(opacity)))
                }
            }
        }
        .opacity(self.phase == .idle ? 0.6 : 1.0)
    }

    private var colors: [Color] {
        self.phase == .idle ? self.palette.inactive : self.palette.active
    }
}

/// A continuous, audio-reactive contour that turns an avatar into the voice
/// surface. Unlike radial equalizer bars, the two overlapping lobes read as one
/// living signal and stay legible at Dynamic Island scale.
public struct TalkAvatarWaveformView<Avatar: View>: View {
    public var phase: TalkWaveformPhase
    public var palette: TalkWaveformPalette
    public var diameter: CGFloat
    public var avatarDiameter: CGFloat
    public var samples: [Double]

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var capturedSamples: [Double] = []
    private let avatar: Avatar

    public init(
        phase: TalkWaveformPhase,
        palette: TalkWaveformPalette = .standard,
        diameter: CGFloat,
        avatarDiameter: CGFloat,
        samples: [Double] = [],
        @ViewBuilder avatar: () -> Avatar)
    {
        self.phase = phase
        self.palette = palette
        self.diameter = diameter
        self.avatarDiameter = avatarDiameter
        self.samples = samples
        self.avatar = avatar()
    }

    public var body: some View {
        let isActive = self.phase != .idle

        ZStack {
            if self.usesMeasuredEnvelope {
                self.measuredContour
            } else {
                self.fallbackContour(isActive: isActive)
            }

            self.avatar
                .frame(width: self.avatarDiameter, height: self.avatarDiameter)
        }
        .frame(width: self.diameter, height: self.diameter)
        .animation(self.reduceMotion ? nil : .easeOut(duration: 0.2), value: isActive)
        .onAppear { self.capture(self.measuredLevel) }
        .onChange(of: self.measuredLevel) { _, level in
            self.capture(level)
        }
    }

    private var measuredContour: some View {
        let colors = self.contourColors
        let renderedSamples = self.reduceMotion ? [0.16] : self.renderedSamples
        let previousSamples = renderedSamples.count > 1
            ? Array(renderedSamples.dropLast())
            : renderedSamples

        return Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let baseRadius = self.avatarDiameter / 2 + max(2, self.diameter * 0.035)
            let availableAmplitude = max(1, min(size.width, size.height) / 2 - baseRadius - 1)

            let backPath = TalkWaveformMath.radialEnvelopePath(
                center: center,
                baseRadius: baseRadius + 0.5,
                amplitude: availableAmplitude,
                samples: previousSamples,
                scale: 0.72)
            context.fill(backPath, with: .color(colors.secondary.opacity(0.36)))

            let frontPath = TalkWaveformMath.radialEnvelopePath(
                center: center,
                baseRadius: baseRadius,
                amplitude: availableAmplitude,
                samples: renderedSamples)
            context.fill(
                frontPath,
                with: .linearGradient(
                    Gradient(colors: [colors.primary, colors.primary, colors.secondary]),
                    startPoint: CGPoint(x: 0, y: size.height),
                    endPoint: CGPoint(x: size.width, y: 0)))
        }
        .shadow(color: colors.primary.opacity(0.22), radius: max(2, self.diameter * 0.06))
        .animation(self.reduceMotion ? nil : .linear(duration: 0.12), value: renderedSamples)
    }

    private func fallbackContour(isActive: Bool) -> some View {
        let frozen = self.reduceMotion || !isActive
        let colors = self.contourColors

        return TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: frozen)) { timeline in
            let time = frozen ? 0 : timeline.date.timeIntervalSince(TalkWaveformClock.born)
            let power = TalkWaveformMath.power(for: self.phase, time: time)

            Canvas { context, size in
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                let baseRadius = self.avatarDiameter / 2 + max(2, self.diameter * 0.035)
                let availableAmplitude = max(1, min(size.width, size.height) / 2 - baseRadius - 1)

                let backPath = TalkWaveformMath.radialPath(
                    center: center,
                    baseRadius: baseRadius + 0.75,
                    amplitude: availableAmplitude * power * 0.82,
                    time: time,
                    seed: 3.7)
                context.fill(backPath, with: .color(colors.secondary.opacity(0.42)))

                let frontPath = TalkWaveformMath.radialPath(
                    center: center,
                    baseRadius: baseRadius,
                    amplitude: availableAmplitude * power,
                    time: time,
                    seed: 0.4)
                context.fill(
                    frontPath,
                    with: .linearGradient(
                        Gradient(colors: [colors.primary, colors.primary, colors.secondary]),
                        startPoint: CGPoint(x: 0, y: size.height),
                        endPoint: CGPoint(x: size.width, y: 0)))
            }
            .shadow(color: colors.primary.opacity(0.22), radius: max(2, self.diameter * 0.06))
        }
        .opacity(isActive ? 1 : 0)
    }

    private var measuredLevel: Double? {
        switch self.phase {
        case let .listening(level, _): level
        case let .speaking(level): level
        case .idle, .thinking: nil
        }
    }

    private var usesMeasuredEnvelope: Bool {
        !self.samples.isEmpty || self.measuredLevel != nil
    }

    private var renderedSamples: [Double] {
        if !self.samples.isEmpty { return self.samples }
        if !self.capturedSamples.isEmpty { return self.capturedSamples }
        return self.measuredLevel.map { [$0] } ?? [0]
    }

    private func capture(_ level: Double?) {
        guard self.samples.isEmpty, let level, level.isFinite else { return }
        self.capturedSamples.append(min(max(level, 0), 1))
        if self.capturedSamples.count > 16 {
            self.capturedSamples.removeFirst(self.capturedSamples.count - 16)
        }
    }

    private var contourColors: (primary: Color, secondary: Color) {
        let primary = self.palette.active.first ?? .red
        let secondary = self.palette.active.dropFirst().first ?? primary
        switch self.phase {
        case .listening:
            return (secondary, primary)
        case .idle, .thinking, .speaking:
            return (primary, secondary)
        }
    }
}

/// A compact, center-origin voice envelope for constrained surfaces such as
/// Dynamic Island. Its geometry comes only from recent audio-level samples;
/// there is no time-based carrier, GIF-like loop, or layout-changing width.
/// The widget and watch targets compile this source directly; keep the trace
/// module-internal instead of expanding OpenClawChatUI's public API.
struct TalkVoiceTraceView: View {
    var phase: TalkWaveformPhase
    var palette: TalkWaveformPalette
    var samples: [Double]
    var sampleRange: ClosedRange<Double>

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        phase: TalkWaveformPhase,
        palette: TalkWaveformPalette = .standard,
        samples: [Double] = [],
        sampleRange: ClosedRange<Double> = 0...1)
    {
        self.phase = phase
        self.palette = palette
        self.samples = samples
        self.sampleRange = sampleRange
    }

    var body: some View {
        let isActive = self.phase != .idle
        let colors = self.traceColors
        let renderedSamples = self.reduceMotion ? [0.16] : (self.samples.isEmpty ? [0.03] : self.samples)
        let previousSamples = renderedSamples.count > 1
            ? Array(renderedSamples.dropLast())
            : renderedSamples

        Canvas { context, size in
            let middle = size.height / 2
            var baseline = Path()
            baseline.move(to: CGPoint(x: 0, y: middle))
            baseline.addLine(to: CGPoint(x: size.width, y: middle))
            context.stroke(
                baseline,
                with: .linearGradient(
                    Gradient(colors: [
                        colors.primary.opacity(0),
                        colors.secondary.opacity(0.36),
                        colors.primary.opacity(0),
                    ]),
                    startPoint: .zero,
                    endPoint: CGPoint(x: size.width, y: 0)),
                lineWidth: 0.75)

            // The back contour is the immediately preceding real envelope,
            // creating depth without introducing an unrelated oscillator.
            let backPath = TalkWaveformMath.traceEnvelopePath(
                in: size,
                samples: previousSamples,
                sampleRange: self.sampleRange,
                scale: 0.72)
            context.fill(backPath, with: .color(colors.secondary.opacity(0.28)))

            let frontPath = TalkWaveformMath.traceEnvelopePath(
                in: size,
                samples: renderedSamples,
                sampleRange: self.sampleRange,
                scale: 1)
            context.fill(
                frontPath,
                with: .linearGradient(
                    Gradient(colors: [colors.primary.opacity(0.82), colors.secondary, colors.primary.opacity(0.82)]),
                    startPoint: CGPoint(x: 0, y: middle),
                    endPoint: CGPoint(x: size.width, y: middle)))
        }
        .shadow(color: colors.primary.opacity(0.22), radius: 2)
        .opacity(isActive ? 1 : 0)
        .accessibilityHidden(true)
    }

    private var traceColors: (primary: Color, secondary: Color) {
        let primary = self.palette.active.first ?? .red
        let secondary = self.palette.active.dropFirst().first ?? primary
        switch self.phase {
        case .listening:
            return (secondary, primary)
        case .idle, .thinking, .speaking:
            return (primary, secondary)
        }
    }
}

/// Pure waveform math, split from the view for unit testing and so the Android
/// port has one canonical reference for every constant.
enum TalkWaveformMath {
    /// Per-phase drive for the wave amplitude in 0...1.
    static func power(for phase: TalkWaveformPhase, time: Double) -> Double {
        switch phase {
        case .idle:
            return 0.05
        case .thinking:
            return 0.16 + 0.10 * (0.5 + 0.5 * sin(time * 1.6))
        case let .listening(level, speechActive):
            let clamped = min(max(level, 0), 1)
            // Detected speech lifts the floor so the wave visibly commits to the
            // user even when the mic level dips between words.
            return speechActive ? 0.55 + 0.45 * clamped : 0.30 + 0.65 * clamped
        case let .speaking(level):
            guard let level else {
                // Synthetic pulse for voice paths with no playback metering.
                return 0.70 * (0.55 + 0.45 * abs(sin(time * 5.0)))
            }
            return 0.25 + 0.75 * min(max(level, 0), 1)
        }
    }

    /// One wave = max envelope of three drifting lobes, mirrored around the midline.
    static func wavePath(in size: CGSize, time: Double, seed: Double, power: Double) -> Path {
        let midX = Double(size.width) / 2
        let midY = Double(size.height) / 2

        // Lobe parameters oscillate smoothly so peaks sweep back and forth
        // across the line instead of scrolling off-screen.
        let lobes: [(A: Double, k: Double, t: Double)] = (0..<3).map { index in
            let f = Double(index)
            let ampFrequency = 0.9 + 0.23 * f
            let ampPhase = time * ampFrequency + seed * 2.4 + f * 2.1
            let amp = 0.30 + 0.70 * (0.5 + 0.5 * sin(ampPhase))
            let k = 0.62 + 0.11 * f
            let driftFrequency = 0.45 + 0.17 * f
            let driftPhase = time * driftFrequency + seed + f * 1.9
            let t = 2.8 * sin(driftPhase)
            return (A: amp, k: k, t: t)
        }

        var upper: [CGPoint] = []
        var x = -midX
        while x <= midX {
            let graphX = x / (midX / 9.0)
            var y: Double = 0
            for lobe in lobes {
                let amplitude = lobe.A * midY * power
                y = max(y, Self.attenuatedSine(x: graphX, A: amplitude, k: lobe.k, t: lobe.t))
            }
            upper.append(CGPoint(x: midX + x, y: midY - y))
            x += 2
        }

        var path = Path()
        path.move(to: CGPoint(x: 0, y: midY))
        path.addLines(upper)
        for point in upper.reversed() {
            path.addLine(to: CGPoint(x: point.x, y: 2 * midY - point.y))
        }
        path.closeSubpath()
        return path
    }

    /// Closed organic contour used around the avatar. The harmonic mix avoids
    /// spoke-like repetition while remaining deterministic and bounded.
    static func radialPath(
        center: CGPoint,
        baseRadius: CGFloat,
        amplitude: CGFloat,
        time: Double,
        seed: Double,
        sampleCount: Int = 96) -> Path
    {
        let count = max(sampleCount, 24)
        var points: [CGPoint] = []
        points.reserveCapacity(count)

        for index in 0..<count {
            let angle = Double(index) / Double(count) * 2 * Double.pi
            let radius = Self.radialRadius(
                angle: angle,
                baseRadius: Double(baseRadius),
                amplitude: Double(amplitude),
                time: time,
                seed: seed)
            points.append(CGPoint(
                x: center.x + CGFloat(cos(angle) * radius),
                y: center.y + CGFloat(sin(angle) * radius)))
        }

        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        path.addLines(Array(points.dropFirst()))
        path.closeSubpath()
        return path
    }

    static func radialRadius(
        angle: Double,
        baseRadius: Double,
        amplitude: Double,
        time: Double,
        seed: Double) -> Double
    {
        let harmonic = 0.50
            + 0.22 * sin(angle * 3 + time * 2.35 + seed)
            + 0.17 * sin(angle * 5 - time * 1.55 + seed * 1.7)
            + 0.11 * sin(angle * 7 + time * 0.95 - seed * 0.6)
        let normalized = min(max(harmonic, 0), 1)
        return baseRadius + max(amplitude, 0) * (0.30 + 0.70 * normalized)
    }

    /// A closed contour made only from measured audio history. The newest sample
    /// sits opposite the seam and the history mirrors back toward it, keeping the
    /// path continuous without a time-based carrier.
    static func radialEnvelopePath(
        center: CGPoint,
        baseRadius: CGFloat,
        amplitude: CGFloat,
        samples: [Double],
        scale: Double = 1,
        sampleCount: Int = 72) -> Path
    {
        let count = max(sampleCount, 24)
        var path = Path()

        for index in 0..<count {
            let progress = Double(index) / Double(count)
            let angle = progress * 2 * Double.pi - Double.pi / 2
            let magnitude = Self.radialEnvelopeMagnitude(progress: progress, samples: samples)
            let radius = baseRadius + amplitude * CGFloat(magnitude * min(max(scale, 0), 1))
            let point = CGPoint(
                x: center.x + CGFloat(cos(angle)) * radius,
                y: center.y + CGFloat(sin(angle)) * radius)
            if index == 0 {
                path.move(to: point)
            } else {
                path.addLine(to: point)
            }
        }
        path.closeSubpath()
        return path
    }

    static func radialEnvelopeMagnitude(progress: Double, samples: [Double]) -> Double {
        guard !samples.isEmpty else { return 0.08 }
        let x = min(max(progress, 0), 1)
        let mirroredHistory = abs(x * 2 - 1) * Double(max(samples.count - 1, 0))
        let level = Self.interpolatedEnvelopeSample(at: mirroredHistory, samples: samples)
        return 0.08 + 0.92 * pow(level, 0.72)
    }

    /// A closed envelope whose newest audio sample lives at the center and whose
    /// prior samples radiate toward both edges. `sampleRange` lets constrained
    /// surfaces render a focused segment without changing the underlying signal.
    static func traceEnvelopePath(
        in size: CGSize,
        samples: [Double],
        sampleRange: ClosedRange<Double> = 0...1,
        scale: Double = 1,
        sampleCount: Int = 48) -> Path
    {
        let count = max(sampleCount, 16)
        let midY = Double(size.height) / 2
        let halfHeight = max(1, midY - 1)
        var upper: [CGPoint] = []
        upper.reserveCapacity(count + 1)

        for index in 0...count {
            let localProgress = Double(index) / Double(count)
            let progress = sampleRange.lowerBound + localProgress * (sampleRange.upperBound - sampleRange.lowerBound)
            let magnitude = Self.traceEnvelopeMagnitude(progress: progress, samples: samples)
            let displacement = halfHeight * min(max(scale, 0), 1) * magnitude
            upper.append(CGPoint(
                x: Double(size.width) * localProgress,
                y: midY - displacement))
        }

        var path = Path()
        guard let first = upper.first else { return path }
        path.move(to: first)
        path.addLines(Array(upper.dropFirst()))
        for point in upper.reversed() {
            path.addLine(to: CGPoint(x: point.x, y: 2 * midY - point.y))
        }
        path.closeSubpath()
        return path
    }

    static func traceEnvelopeMagnitude(progress: Double, samples: [Double]) -> Double {
        let x = min(max(progress, 0), 1)
        guard x > 0, x < 1 else { return 0 }
        let taper = pow(max(0, sin(.pi * x)), 0.48)
        guard !samples.isEmpty else { return 0.03 * taper }

        let distanceFromCenter = abs(x - 0.5) * 2
        let historyPosition = distanceFromCenter * Double(max(samples.count - 1, 0))
        let level = Self.interpolatedEnvelopeSample(at: historyPosition, samples: samples)
        return taper * (0.03 + 0.97 * pow(level, 0.72))
    }

    /// Catmull-Rom interpolation keeps sparse ActivityKit samples fluid while
    /// remaining entirely derived from the measured playback history.
    static func interpolatedEnvelopeSample(at historyPosition: Double, samples: [Double]) -> Double {
        guard !samples.isEmpty else { return 0 }
        let maximum = samples.count - 1
        let position = min(max(historyPosition, 0), Double(maximum))
        let lower = Int(position.rounded(.down))
        let fraction = position - Double(lower)

        func newestFirst(_ index: Int) -> Double {
            let clampedIndex = min(max(index, 0), maximum)
            return min(max(samples[maximum - clampedIndex], 0), 1)
        }

        let p0 = newestFirst(lower - 1)
        let p1 = newestFirst(lower)
        let p2 = newestFirst(lower + 1)
        let p3 = newestFirst(lower + 2)
        let value = 0.5 * ((2 * p1) +
            (-p0 + p2) * fraction +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * fraction * fraction +
            (-p0 + 3 * p1 - 3 * p2 + p3) * fraction * fraction * fraction)
        return min(max(value, 0), 1)
    }

    /// |A·sin(kx − t)| shaped by the bell envelope g = (K/(K+(kx−t′)²))^K, K = 4.
    private static func attenuatedSine(x: Double, A: Double, k: Double, t: Double) -> Double {
        let sine = A * sin(k * x - t)
        let tPrime = t - .pi / 2
        let envelope = pow(4.0 / (4.0 + pow(k * x - tPrime, 2)), 4.0)
        return abs(sine * envelope)
    }
}
