import Foundation
import SwiftUI

private enum ChatWorkingClawSeed {
    /// Process lifetime is the native equivalent of the web page-load salt.
    static let salt = UInt32.random(in: UInt32.min...UInt32.max)
}

struct ChatWorkingClawPose {
    var bodyRotation: CGFloat = 0
    var jawRotation: CGFloat = -10
    var xOffset: CGFloat = 0
    var yOffset: CGFloat = 0
    var zRotation: CGFloat = 0
    var yRotation: CGFloat = 0
    var bodyScale: CGFloat = 1
    var powOpacity: Double = 0
    var powScale: CGFloat = 0.4

    static let parked = Self(bodyRotation: 8, jawRotation: -4)
}

private struct ChatWorkingClawKeyframe {
    let progress: Double
    let value: CGFloat
}

enum ChatWorkingClawMotion {
    private enum Easing {
        case easeOut
        case easeInOut
        case linear

        func amount(for linear: Double) -> Double {
            switch self {
            case .easeOut:
                1 - pow(1 - linear, 3)
            case .easeInOut:
                UnitCurve.easeInOut.value(at: linear)
            case .linear:
                linear
            }
        }
    }

    private static let bodySnips = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.06, value: 0),
        ChatWorkingClawKeyframe(progress: 0.10, value: -4),
        ChatWorkingClawKeyframe(progress: 0.16, value: 3),
        ChatWorkingClawKeyframe(progress: 0.22, value: -4),
        ChatWorkingClawKeyframe(progress: 0.26, value: -4),
        ChatWorkingClawKeyframe(progress: 0.32, value: 3),
        ChatWorkingClawKeyframe(progress: 0.42, value: 0),
        ChatWorkingClawKeyframe(progress: 1, value: 0),
    ]
    private static let jawSnips = [
        ChatWorkingClawKeyframe(progress: 0, value: -10),
        ChatWorkingClawKeyframe(progress: 0.06, value: -10),
        ChatWorkingClawKeyframe(progress: 0.10, value: -26),
        ChatWorkingClawKeyframe(progress: 0.16, value: 4),
        ChatWorkingClawKeyframe(progress: 0.22, value: -24),
        ChatWorkingClawKeyframe(progress: 0.26, value: -24),
        ChatWorkingClawKeyframe(progress: 0.32, value: 4),
        ChatWorkingClawKeyframe(progress: 0.42, value: -10),
        ChatWorkingClawKeyframe(progress: 1, value: -10),
    ]
    private static let comboX = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.08, value: 0),
        ChatWorkingClawKeyframe(progress: 0.12, value: -2),
        ChatWorkingClawKeyframe(progress: 0.16, value: 5),
        ChatWorkingClawKeyframe(progress: 0.22, value: -2),
        ChatWorkingClawKeyframe(progress: 0.26, value: -2),
        ChatWorkingClawKeyframe(progress: 0.30, value: 5),
        ChatWorkingClawKeyframe(progress: 0.38, value: 0),
        ChatWorkingClawKeyframe(progress: 0.46, value: -3),
        ChatWorkingClawKeyframe(progress: 0.52, value: 8),
        ChatWorkingClawKeyframe(progress: 0.62, value: 0),
        ChatWorkingClawKeyframe(progress: 1, value: 0),
    ]
    private static let comboBodyRotation = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.38, value: 0),
        ChatWorkingClawKeyframe(progress: 0.46, value: -6),
        ChatWorkingClawKeyframe(progress: 0.52, value: 4),
        ChatWorkingClawKeyframe(progress: 0.62, value: 0),
        ChatWorkingClawKeyframe(progress: 1, value: 0),
    ]
    private static let comboJaw = [
        ChatWorkingClawKeyframe(progress: 0, value: -10),
        ChatWorkingClawKeyframe(progress: 0.08, value: -10),
        ChatWorkingClawKeyframe(progress: 0.12, value: -16),
        ChatWorkingClawKeyframe(progress: 0.16, value: 4),
        ChatWorkingClawKeyframe(progress: 0.22, value: -16),
        ChatWorkingClawKeyframe(progress: 0.26, value: -16),
        ChatWorkingClawKeyframe(progress: 0.30, value: 4),
        ChatWorkingClawKeyframe(progress: 0.38, value: -10),
        ChatWorkingClawKeyframe(progress: 0.46, value: -18),
        ChatWorkingClawKeyframe(progress: 0.52, value: 6),
        ChatWorkingClawKeyframe(progress: 0.62, value: -10),
        ChatWorkingClawKeyframe(progress: 1, value: -10),
    ]
    private static let backflipY = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.55, value: 0),
        ChatWorkingClawKeyframe(progress: 0.62, value: -3),
        ChatWorkingClawKeyframe(progress: 0.70, value: -3),
        ChatWorkingClawKeyframe(progress: 0.78, value: 0),
        ChatWorkingClawKeyframe(progress: 1, value: 0),
    ]
    private static let backflipRotation = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.55, value: 0),
        ChatWorkingClawKeyframe(progress: 0.62, value: -120),
        ChatWorkingClawKeyframe(progress: 0.70, value: -240),
        ChatWorkingClawKeyframe(progress: 0.78, value: -360),
        ChatWorkingClawKeyframe(progress: 1, value: -360),
    ]
    private static let zenBodyScale = [
        ChatWorkingClawKeyframe(progress: 0, value: 1),
        ChatWorkingClawKeyframe(progress: 0.30, value: 1.08),
        ChatWorkingClawKeyframe(progress: 0.55, value: 1),
        ChatWorkingClawKeyframe(progress: 1, value: 1),
    ]
    private static let zenJaw = [
        ChatWorkingClawKeyframe(progress: 0, value: -10),
        ChatWorkingClawKeyframe(progress: 0.60, value: -10),
        ChatWorkingClawKeyframe(progress: 0.70, value: -24),
        ChatWorkingClawKeyframe(progress: 0.76, value: 2),
        ChatWorkingClawKeyframe(progress: 0.86, value: -10),
        ChatWorkingClawKeyframe(progress: 1, value: -10),
    ]
    private static let drummerBodyRotation = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.15, value: -8),
        ChatWorkingClawKeyframe(progress: 0.30, value: 0),
        ChatWorkingClawKeyframe(progress: 0.55, value: 8),
        ChatWorkingClawKeyframe(progress: 0.70, value: 0),
        ChatWorkingClawKeyframe(progress: 1, value: 0),
    ]
    private static let drummerJaw = [
        ChatWorkingClawKeyframe(progress: 0, value: -10),
        ChatWorkingClawKeyframe(progress: 0.10, value: -20),
        ChatWorkingClawKeyframe(progress: 0.15, value: 2),
        ChatWorkingClawKeyframe(progress: 0.25, value: -10),
        ChatWorkingClawKeyframe(progress: 0.50, value: -20),
        ChatWorkingClawKeyframe(progress: 0.55, value: 2),
        ChatWorkingClawKeyframe(progress: 0.65, value: -10),
        ChatWorkingClawKeyframe(progress: 1, value: -10),
    ]
    private static let peekabooY = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.55, value: 0),
        ChatWorkingClawKeyframe(progress: 0.62, value: 5),
        ChatWorkingClawKeyframe(progress: 0.72, value: 5),
        ChatWorkingClawKeyframe(progress: 0.78, value: -1.5),
        ChatWorkingClawKeyframe(progress: 0.84, value: 0),
        ChatWorkingClawKeyframe(progress: 1, value: 0),
    ]
    private static let peekabooScale = [
        ChatWorkingClawKeyframe(progress: 0, value: 1),
        ChatWorkingClawKeyframe(progress: 0.55, value: 1),
        ChatWorkingClawKeyframe(progress: 0.62, value: 0.72),
        ChatWorkingClawKeyframe(progress: 0.72, value: 0.72),
        ChatWorkingClawKeyframe(progress: 0.78, value: 1.06),
        ChatWorkingClawKeyframe(progress: 0.84, value: 1),
        ChatWorkingClawKeyframe(progress: 1, value: 1),
    ]
    private static let peekabooJaw = [
        ChatWorkingClawKeyframe(progress: 0, value: -10),
        ChatWorkingClawKeyframe(progress: 0.55, value: -10),
        ChatWorkingClawKeyframe(progress: 0.62, value: -2),
        ChatWorkingClawKeyframe(progress: 0.72, value: -2),
        ChatWorkingClawKeyframe(progress: 0.78, value: -28),
        ChatWorkingClawKeyframe(progress: 0.86, value: -10),
        ChatWorkingClawKeyframe(progress: 1, value: -10),
    ]
    private static let nodOffBodyRotation = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.10, value: 0),
        ChatWorkingClawKeyframe(progress: 0.35, value: 10),
        ChatWorkingClawKeyframe(progress: 0.55, value: 14),
        ChatWorkingClawKeyframe(progress: 0.60, value: 15),
        ChatWorkingClawKeyframe(progress: 0.64, value: -3),
        ChatWorkingClawKeyframe(progress: 0.70, value: 0),
        ChatWorkingClawKeyframe(progress: 1, value: 0),
    ]
    private static let nodOffY = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.10, value: 0),
        ChatWorkingClawKeyframe(progress: 0.35, value: 1),
        ChatWorkingClawKeyframe(progress: 0.60, value: 1.5),
        ChatWorkingClawKeyframe(progress: 0.64, value: -0.5),
        ChatWorkingClawKeyframe(progress: 0.70, value: 0),
        ChatWorkingClawKeyframe(progress: 1, value: 0),
    ]
    private static let nodOffJaw = [
        ChatWorkingClawKeyframe(progress: 0, value: -10),
        ChatWorkingClawKeyframe(progress: 0.10, value: -10),
        ChatWorkingClawKeyframe(progress: 0.35, value: -16),
        ChatWorkingClawKeyframe(progress: 0.60, value: -21),
        ChatWorkingClawKeyframe(progress: 0.64, value: -6),
        ChatWorkingClawKeyframe(progress: 0.70, value: -24),
        ChatWorkingClawKeyframe(progress: 0.74, value: 4),
        ChatWorkingClawKeyframe(progress: 0.80, value: -22),
        ChatWorkingClawKeyframe(progress: 0.84, value: 4),
        ChatWorkingClawKeyframe(progress: 0.90, value: -10),
        ChatWorkingClawKeyframe(progress: 1, value: -10),
    ]
    private static let curiousBodyRotation = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.30, value: 0),
        ChatWorkingClawKeyframe(progress: 0.40, value: -14),
        ChatWorkingClawKeyframe(progress: 0.62, value: -14),
        ChatWorkingClawKeyframe(progress: 0.70, value: 4),
        ChatWorkingClawKeyframe(progress: 0.76, value: 0),
        ChatWorkingClawKeyframe(progress: 1, value: 0),
    ]
    private static let curiousJaw = [
        ChatWorkingClawKeyframe(progress: 0, value: -10),
        ChatWorkingClawKeyframe(progress: 0.30, value: -10),
        ChatWorkingClawKeyframe(progress: 0.40, value: -16),
        ChatWorkingClawKeyframe(progress: 0.62, value: -16),
        ChatWorkingClawKeyframe(progress: 0.70, value: -6),
        ChatWorkingClawKeyframe(progress: 0.76, value: -10),
        ChatWorkingClawKeyframe(progress: 1, value: -10),
    ]
    private static let omNomX = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.30, value: 0),
        ChatWorkingClawKeyframe(progress: 0.36, value: 2.5),
        ChatWorkingClawKeyframe(progress: 0.40, value: 1),
        ChatWorkingClawKeyframe(progress: 0.46, value: 2.5),
        ChatWorkingClawKeyframe(progress: 0.50, value: 1),
        ChatWorkingClawKeyframe(progress: 0.56, value: 2.5),
        ChatWorkingClawKeyframe(progress: 0.64, value: 0),
        ChatWorkingClawKeyframe(progress: 1, value: 0),
    ]
    private static let omNomJaw = [
        ChatWorkingClawKeyframe(progress: 0, value: -10),
        ChatWorkingClawKeyframe(progress: 0.26, value: -10),
        ChatWorkingClawKeyframe(progress: 0.30, value: -30),
        ChatWorkingClawKeyframe(progress: 0.36, value: 8),
        ChatWorkingClawKeyframe(progress: 0.42, value: -30),
        ChatWorkingClawKeyframe(progress: 0.46, value: 8),
        ChatWorkingClawKeyframe(progress: 0.52, value: -30),
        ChatWorkingClawKeyframe(progress: 0.56, value: 8),
        ChatWorkingClawKeyframe(progress: 0.64, value: -10),
        ChatWorkingClawKeyframe(progress: 1, value: -10),
    ]
    private static let fakeOutBodyRotation = [
        ChatWorkingClawKeyframe(progress: 0, value: 0),
        ChatWorkingClawKeyframe(progress: 0.06, value: 0),
        ChatWorkingClawKeyframe(progress: 0.10, value: -4),
        ChatWorkingClawKeyframe(progress: 0.55, value: -4),
        ChatWorkingClawKeyframe(progress: 0.58, value: 3),
        ChatWorkingClawKeyframe(progress: 0.62, value: -4),
        ChatWorkingClawKeyframe(progress: 0.66, value: 3),
        ChatWorkingClawKeyframe(progress: 0.70, value: -4),
        ChatWorkingClawKeyframe(progress: 0.74, value: 3),
        ChatWorkingClawKeyframe(progress: 0.80, value: 0),
        ChatWorkingClawKeyframe(progress: 1, value: 0),
    ]
    private static let fakeOutJaw = [
        ChatWorkingClawKeyframe(progress: 0, value: -10),
        ChatWorkingClawKeyframe(progress: 0.06, value: -10),
        ChatWorkingClawKeyframe(progress: 0.10, value: -26),
        ChatWorkingClawKeyframe(progress: 0.55, value: -26),
        ChatWorkingClawKeyframe(progress: 0.58, value: 4),
        ChatWorkingClawKeyframe(progress: 0.62, value: -24),
        ChatWorkingClawKeyframe(progress: 0.66, value: 4),
        ChatWorkingClawKeyframe(progress: 0.70, value: -22),
        ChatWorkingClawKeyframe(progress: 0.74, value: 4),
        ChatWorkingClawKeyframe(progress: 0.80, value: -10),
        ChatWorkingClawKeyframe(progress: 1, value: -10),
    ]

    static func pose(stance: ChatWorkingClawStance, elapsed: TimeInterval) -> ChatWorkingClawPose {
        let duration: TimeInterval = switch stance {
        case .flurry: 1.3
        case .spin: 3.6
        case .zen: 6
        case .drummer: 1.2
        case .nodOff: 3.6
        default: 2.4
        }
        let progress = max(0, elapsed).truncatingRemainder(dividingBy: duration) / duration
        var pose = ChatWorkingClawPose()
        pose.jawRotation = self.sample(self.jawSnips, at: progress)

        switch stance {
        case .standard, .southpaw, .flurry:
            pose.bodyRotation = self.sample(self.bodySnips, at: progress)
        case .spin:
            pose.yRotation = CGFloat(progress * 360)
        case .shadowbox:
            pose.bodyRotation = self.sample(self.comboBodyRotation, at: progress)
            pose.jawRotation = self.sample(self.comboJaw, at: progress)
            pose.xOffset = self.sample(self.comboX, at: progress)
            pose.powOpacity = Double(self.sample(
                [
                    .init(progress: 0, value: 0),
                    .init(progress: 0.46, value: 0),
                    .init(progress: 0.52, value: 1),
                    .init(progress: 0.58, value: 0),
                    .init(progress: 1, value: 0),
                ],
                at: progress,
                easing: .linear))
            pose.powScale = self.sample([
                .init(progress: 0, value: 0.4),
                .init(progress: 0.46, value: 0.4),
                .init(progress: 0.52, value: 1.2),
                .init(progress: 0.58, value: 1.5),
                .init(progress: 1, value: 1.5),
            ], at: progress)
        case .backflip:
            pose.yOffset = self.sample(self.backflipY, at: progress)
            pose.zRotation = self.sample(self.backflipRotation, at: progress)
        case .zen:
            pose.bodyScale = self.sample(self.zenBodyScale, at: progress, easing: .easeInOut)
            pose.jawRotation = self.sample(self.zenJaw, at: progress)
        case .drummer:
            pose.bodyRotation = self.sample(self.drummerBodyRotation, at: progress)
            pose.jawRotation = self.sample(self.drummerJaw, at: progress)
        case .peekaboo:
            pose.yOffset = self.sample(self.peekabooY, at: progress)
            pose.bodyScale = self.sample(self.peekabooScale, at: progress)
            pose.jawRotation = self.sample(self.peekabooJaw, at: progress)
        case .nodOff:
            pose.bodyRotation = self.sample(self.nodOffBodyRotation, at: progress)
            pose.yOffset = self.sample(self.nodOffY, at: progress)
            pose.jawRotation = self.sample(self.nodOffJaw, at: progress)
        case .curious:
            pose.bodyRotation = self.sample(self.curiousBodyRotation, at: progress)
            pose.jawRotation = self.sample(self.curiousJaw, at: progress)
        case .omNom:
            pose.xOffset = self.sample(self.omNomX, at: progress)
            pose.jawRotation = self.sample(self.omNomJaw, at: progress)
        case .fakeOut:
            pose.bodyRotation = self.sample(self.fakeOutBodyRotation, at: progress)
            pose.jawRotation = self.sample(self.fakeOutJaw, at: progress)
        }
        return pose
    }

    private static func sample(
        _ frames: [ChatWorkingClawKeyframe],
        at progress: Double,
        easing: Easing = .easeOut) -> CGFloat
    {
        guard let first = frames.first else { return 0 }
        guard progress > first.progress else { return first.value }
        for pair in zip(frames, frames.dropFirst()) where progress <= pair.1.progress {
            let span = pair.1.progress - pair.0.progress
            let linear = span > 0 ? (progress - pair.0.progress) / span : 1
            let amount = easing.amount(for: linear)
            return pair.0.value + (pair.1.value - pair.0.value) * CGFloat(amount)
        }
        return frames.last?.value ?? first.value
    }
}

struct ChatWorkingClawView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var animationStartedAt = Date()

    let stance: ChatWorkingClawStance
    var parked = false

    init(seed: String, parked: Bool = false) {
        self.stance = ChatWorkingClawStance.seeded(seed, salt: ChatWorkingClawSeed.salt)
        self.parked = parked
    }

    var body: some View {
        Group {
            if self.parked {
                self.artwork(pose: .parked)
            } else {
                TimelineView(.animation(
                    minimumInterval: 1 / 30,
                    paused: self.reduceMotion || self.scenePhase != .active))
                { context in
                    let pose = self.reduceMotion || self.scenePhase != .active
                        ? ChatWorkingClawPose()
                        : ChatWorkingClawMotion.pose(
                            stance: self.stance,
                            elapsed: context.date.timeIntervalSince(self.animationStartedAt))
                    self.artwork(pose: pose)
                }
            }
        }
        .frame(width: 28, height: 24)
        .accessibilityHidden(true)
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .active {
                self.animationStartedAt = Date()
            }
        }
        .onChange(of: self.reduceMotion) { _, isReduced in
            if !isReduced {
                self.animationStartedAt = Date()
            }
        }
    }

    private func artwork(pose: ChatWorkingClawPose) -> some View {
        ZStack {
            ZStack {
                ChatWorkingClawBodyShape()
                    .fill(OpenClawChatTheme.accent)
                ChatWorkingClawJawShape()
                    .fill(OpenClawChatTheme.accent)
                    .rotationEffect(
                        .degrees(pose.jawRotation),
                        anchor: UnitPoint(x: 8.6 / 24, y: 11 / 24))
            }
            .frame(width: 18, height: 18)
            .rotationEffect(.degrees(pose.bodyRotation + pose.zRotation))
            .rotation3DEffect(
                .degrees(pose.yRotation),
                axis: (x: 0, y: 1, z: 0),
                perspective: 0.45)
            .scaleEffect(pose.bodyScale)
            .offset(x: pose.xOffset, y: pose.yOffset)
            .scaleEffect(x: !self.parked && self.stance == .southpaw ? -1 : 1, y: 1)

            if pose.powOpacity > 0 {
                Text("✦")
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(OpenClawChatTheme.accent)
                    .scaleEffect(pose.powScale)
                    .opacity(pose.powOpacity)
                    .offset(x: 14, y: -7)
                    .accessibilityHidden(true)
            }
        }
    }
}

private struct ChatWorkingClawBodyShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addEllipse(in: CGRect(x: 3, y: 10, width: 10.4, height: 10.4))
        path.move(to: CGPoint(x: 10.2, y: 20))
        path.addCurve(
            to: CGPoint(x: 22.3, y: 13.2),
            control1: CGPoint(x: 14.5, y: 20.8),
            control2: CGPoint(x: 19, y: 18.6))
        path.addCurve(
            to: CGPoint(x: 18.4, y: 12.8),
            control1: CGPoint(x: 21, y: 12.9),
            control2: CGPoint(x: 19.7, y: 12.7))
        path.addLine(to: CGPoint(x: 17.5, y: 14.6))
        path.addLine(to: CGPoint(x: 16, y: 12.9))
        path.addLine(to: CGPoint(x: 14.3, y: 14.5))
        path.addLine(to: CGPoint(x: 13.5, y: 13))
        path.addLine(to: CGPoint(x: 11.5, y: 14.2))
        path.closeSubpath()
        return path.applying(self.transform(for: rect))
    }

    private func transform(for rect: CGRect) -> CGAffineTransform {
        let scale = min(rect.width, rect.height) / 24
        return CGAffineTransform(
            a: scale,
            b: 0,
            c: 0,
            d: scale,
            tx: rect.midX - 12 * scale,
            ty: rect.midY - 12 * scale)
    }
}

private struct ChatWorkingClawJawShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 5.6, y: 12.2))
        path.addCurve(
            to: CGPoint(x: 15.6, y: 2),
            control1: CGPoint(x: 5.2, y: 5.6),
            control2: CGPoint(x: 10.4, y: 1.4))
        path.addCurve(
            to: CGPoint(x: 22.6, y: 8.2),
            control1: CGPoint(x: 19.4, y: 2.6),
            control2: CGPoint(x: 21.8, y: 5.2))
        path.addCurve(
            to: CGPoint(x: 17.6, y: 7.9),
            control1: CGPoint(x: 20.9, y: 7.7),
            control2: CGPoint(x: 19.2, y: 7.6))
        path.addLine(to: CGPoint(x: 16.9, y: 6.3))
        path.addLine(to: CGPoint(x: 15.2, y: 8.5))
        path.addCurve(
            to: CGPoint(x: 11.6, y: 12.4),
            control1: CGPoint(x: 13.6, y: 9.4),
            control2: CGPoint(x: 12.2, y: 10.9))
        path.addLine(to: CGPoint(x: 6.8, y: 13))
        path.closeSubpath()
        let scale = min(rect.width, rect.height) / 24
        return path.applying(CGAffineTransform(
            a: scale,
            b: 0,
            c: 0,
            d: scale,
            tx: rect.midX - 12 * scale,
            ty: rect.midY - 12 * scale))
    }
}

struct ChatWorkingStatusText: View {
    @Environment(\.scenePhase) private var scenePhase

    let startedAt: Date
    let seed: String
    let outputTokens: Int?

    var body: some View {
        Group {
            if self.scenePhase == .active {
                TimelineView(.periodic(from: self.startedAt, by: 1)) { context in
                    self.label(at: context.date)
                }
            } else {
                self.label(at: Date())
            }
        }
        .foregroundStyle(.secondary)
    }

    private func label(at date: Date) -> some View {
        let elapsedMilliseconds = max(1000, Int(date.timeIntervalSince(self.startedAt) * 1000))
        let duration = ChatWorkingDurationFormatter.compact(milliseconds: Double(elapsedMilliseconds))
        return HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text(duration)
                .font(OpenClawChatTypography.captionSemiBold)
                .monospacedDigit()
            if let tokensText = ChatTurnRecapText.tokens(self.outputTokens) {
                Text("·")
                    .font(OpenClawChatTypography.caption)
                    .accessibilityHidden(true)
                Text(tokensText)
                    .font(OpenClawChatTypography.caption)
                    .monospacedDigit()
            }
            if let index = ChatWorkingPhrase.index(
                seed: self.seed,
                elapsedMilliseconds: elapsedMilliseconds)
            {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text("·")
                        .font(OpenClawChatTypography.caption)
                    Text(ChatWorkingPhrase.resources[index] + "…")
                        .font(OpenClawChatTypography.caption)
                }
                .accessibilityHidden(true)
            }
        }
    }
}

struct ChatTurnRecapRow: View {
    let recap: ChatTurnRecap

    var body: some View {
        HStack(spacing: 7) {
            ChatWorkingClawView(seed: "turn-recap", parked: true)
            Text(ChatTurnRecapText.done(runtimeMs: self.recap.runtimeMs))
                .font(OpenClawChatTypography.caption)
            if let tokensText = ChatTurnRecapText.tokens(self.recap.outputTokens) {
                Text("·")
                    .font(OpenClawChatTypography.caption)
                    .accessibilityHidden(true)
                Text(tokensText)
                    .font(OpenClawChatTypography.caption)
            }
        }
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }
}
