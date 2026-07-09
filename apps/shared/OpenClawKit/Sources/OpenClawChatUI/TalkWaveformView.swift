import SwiftUI

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
            Color(red: 0.95, green: 0.45, blue: 0.30),
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

    private static let born = Date()

    public init(phase: TalkWaveformPhase, palette: TalkWaveformPalette = .standard) {
        self.phase = phase
        self.palette = palette
    }

    public var body: some View {
        let frozen = self.reduceMotion || self.phase == .idle
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: frozen)) { timeline in
            let time = frozen ? 0 : timeline.date.timeIntervalSince(Self.born)
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

/// Pure waveform math, split from the view for unit testing and so the Android
/// port has one canonical reference for every constant.
public enum TalkWaveformMath {
    /// Per-phase drive for the wave amplitude in 0...1.
    public static func power(for phase: TalkWaveformPhase, time: Double) -> Double {
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
    public static func wavePath(in size: CGSize, time: Double, seed: Double, power: Double) -> Path {
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

    /// |A·sin(kx − t)| shaped by the bell envelope g = (K/(K+(kx−t′)²))^K, K = 4.
    private static func attenuatedSine(x: Double, A: Double, k: Double, t: Double) -> Double {
        let sine = A * sin(k * x - t)
        let tPrime = t - .pi / 2
        let envelope = pow(4.0 / (4.0 + pow(k * x - tPrime, 2)), 4.0)
        return abs(sine * envelope)
    }
}
