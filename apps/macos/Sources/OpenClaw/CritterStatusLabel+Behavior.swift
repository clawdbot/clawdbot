import AppKit
import SwiftUI

extension CritterStatusLabel {
    private var isWorkingNow: Bool {
        self.iconState.isWorking || self.isWorking
    }

    private var effectiveAnimationsEnabled: Bool {
        self.animationsEnabled && !self.isSleeping && !self.isPaused
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            self.iconImage
                .frame(width: 18, height: 18)
                .rotationEffect(.degrees(self.wiggleAngle), anchor: .center)
                .offset(x: self.wiggleOffset)
                // Avoid Combine's TimerPublisher here: on macOS 26.2 we've seen crashes inside executor checks
                // triggered by its callbacks. Drive periodic updates via a Swift-concurrency task instead.
                .task(id: self.tickTaskID) {
                    guard self.effectiveAnimationsEnabled, !self.earBoostActive else {
                        await MainActor.run { self.resetMotion() }
                        return
                    }

                    await MainActor.run { self.rescheduleElapsedAnimationTimers(from: Date()) }
                    while !Task.isCancelled {
                        let now = Date()
                        let delay = await MainActor.run {
                            self.tick(now)
                            return self.nextTickDelay(after: now)
                        }
                        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                    }
                }
                .onChange(of: self.isPaused) { _, _ in self.resetMotion() }
                .onChange(of: self.blinkTick) { _, _ in
                    guard self.effectiveAnimationsEnabled, !self.earBoostActive else { return }
                    self.blink()
                }
                .onChange(of: self.sendCelebrationTick) { _, _ in
                    guard self.effectiveAnimationsEnabled, !self.earBoostActive else { return }
                    self.celebrate()
                }
                .onChange(of: self.animationsEnabled) { _, enabled in
                    if enabled, !self.isSleeping {
                        self.scheduleRandomTimers(from: Date())
                    } else {
                        self.resetMotion()
                    }
                }
                .onChange(of: self.isSleeping) { _, _ in
                    self.resetMotion()
                }
                .onChange(of: self.earBoostActive) { _, active in
                    if active {
                        self.resetMotion()
                    } else if self.effectiveAnimationsEnabled {
                        self.scheduleRandomTimers(from: Date())
                    }
                }

            if self.gatewayNeedsAttention {
                Circle()
                    .fill(self.gatewayBadgeColor)
                    .frame(width: 6, height: 6)
                    .padding(1)
            }

            if self.voiceWakeMeterActive {
                Circle()
                    .fill(.orange)
                    .frame(width: 5, height: 5)
                    .padding(2)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
        }
        .frame(width: 18, height: 18)
    }

    private var tickTaskID: Int {
        // Ensure SwiftUI restarts (and cancels) the task when these change.
        (self.effectiveAnimationsEnabled ? 1 : 0) |
            (self.earBoostActive ? 2 : 0) |
            (self.isWorkingNow ? 4 : 0)
    }

    private func nextTickDelay(after now: Date) -> TimeInterval {
        Self.nextAnimationTickDelay(
            now: now,
            isWorking: self.isWorkingNow,
            deadlines: [self.nextBlink, self.nextWiggle, self.nextLegWiggle, self.nextEarWiggle])
    }

    static func nextAnimationTickDelay(
        now: Date,
        isWorking: Bool,
        deadlines: [Date]) -> TimeInterval
    {
        // Working motion needs a steady cadence; idle motion only wakes for its next visible event.
        if isWorking { return 0.35 }
        guard let nextDeadline = deadlines.min() else { return 1 }
        return max(0.05, nextDeadline.timeIntervalSince(now))
    }

    private func tick(_ now: Date) {
        guard self.effectiveAnimationsEnabled, !self.earBoostActive else {
            self.resetMotion()
            return
        }

        if now >= self.nextBlink {
            self.blink()
            self.nextBlink = now.addingTimeInterval(Double.random(in: 3.5...8.5))
        }

        if now >= self.nextWiggle {
            self.wiggle()
            self.nextWiggle = now.addingTimeInterval(Double.random(in: 6.5...14))
        }

        if now >= self.nextLegWiggle {
            self.wiggleLegs()
            self.nextLegWiggle = now.addingTimeInterval(Double.random(in: 5.0...11.0))
        }

        if now >= self.nextEarWiggle {
            self.wiggleEars()
            self.nextEarWiggle = now.addingTimeInterval(Double.random(in: 7.0...14.0))
        }

        if self.isWorkingNow {
            self.scurry()
        }
    }

    private var iconImage: Image {
        let badge: CritterIconRenderer.Badge? = if let prominence = self.iconState.badgeProminence, !self.isPaused {
            CritterIconRenderer.Badge(
                symbolName: self.iconState.badgeSymbolName,
                prominence: prominence)
        } else {
            nil
        }

        if self.isPaused {
            // Paused reads as "off duty": awake but with drooped antennae, distinct
            // from idle (perked) and sleeping (drooped + closed eyes).
            return Image(nsImage: CritterIconRenderer.makeIcon(blink: 0, antennaDroop: 1, badge: nil))
        }

        if self.isSleeping {
            return Image(nsImage: CritterIconRenderer.makeIcon(
                blink: 1,
                antennaDroop: 1,
                eyesClosedLines: true,
                badge: nil))
        }

        return Image(nsImage: CritterIconRenderer.makeIcon(
            blink: self.blinkAmount,
            legWiggle: max(self.legWiggle, self.isWorkingNow ? 0.6 : 0),
            earWiggle: self.earWiggle,
            earScale: self.earBoostActive ? 1.9 : 1.0,
            happyEyes: self.celebrating,
            badge: badge))
    }

    private func resetMotion() {
        self.blinkAmount = 0
        self.celebrating = false
        self.wiggleAngle = 0
        self.wiggleOffset = 0
        self.legWiggle = 0
        self.earWiggle = 0
    }

    /// Message sent: flash happy "∩ ∩" eyes and kick the legs.
    private func celebrate() {
        self.celebrating = true
        self.wiggleLegs()
        // Generation advances only for celebrations that actually start, so the
        // newest flash always owns the clear: older expiry tasks bail, and the
        // eyes can never stick on after a skipped send tick.
        self.celebrationGeneration += 1
        let generation = self.celebrationGeneration
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 900_000_000)
            guard self.celebrationGeneration == generation else { return }
            self.celebrating = false
        }
    }

    private func blink() {
        withAnimation(.easeInOut(duration: 0.08)) { self.blinkAmount = 1 }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 160_000_000)
            withAnimation(.easeOut(duration: 0.12)) { self.blinkAmount = 0 }
        }
    }

    private func wiggle() {
        let targetAngle = Double.random(in: -4.5...4.5)
        let targetOffset = CGFloat.random(in: -0.5...0.5)
        withAnimation(.interpolatingSpring(stiffness: 220, damping: 18)) {
            self.wiggleAngle = targetAngle
            self.wiggleOffset = targetOffset
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 360_000_000)
            withAnimation(.interpolatingSpring(stiffness: 220, damping: 18)) {
                self.wiggleAngle = 0
                self.wiggleOffset = 0
            }
        }
    }

    private func wiggleLegs() {
        let target = CGFloat.random(in: 0.35...0.9)
        withAnimation(.easeInOut(duration: 0.14)) {
            self.legWiggle = target
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 220_000_000)
            withAnimation(.easeOut(duration: 0.18)) { self.legWiggle = 0 }
        }
    }

    private func scurry() {
        let target = CGFloat.random(in: 0.7...1.0)
        withAnimation(.easeInOut(duration: 0.12)) {
            self.legWiggle = target
            self.wiggleOffset = CGFloat.random(in: -0.6...0.6)
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000)
            withAnimation(.easeOut(duration: 0.16)) {
                self.legWiggle = 0.25
                self.wiggleOffset = 0
            }
        }
    }

    private func wiggleEars() {
        let target = CGFloat.random(in: -1.2...1.2)
        withAnimation(.interpolatingSpring(stiffness: 260, damping: 19)) {
            self.earWiggle = target
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 320_000_000)
            withAnimation(.interpolatingSpring(stiffness: 260, damping: 19)) {
                self.earWiggle = 0
            }
        }
    }

    private func scheduleRandomTimers(from date: Date) {
        self.nextBlink = date.addingTimeInterval(Double.random(in: 3.5...8.5))
        self.nextWiggle = date.addingTimeInterval(Double.random(in: 6.5...14))
        self.nextLegWiggle = date.addingTimeInterval(Double.random(in: 5.0...11.0))
        self.nextEarWiggle = date.addingTimeInterval(Double.random(in: 7.0...14.0))
    }

    private func rescheduleElapsedAnimationTimers(from date: Date) {
        let deadlines = [self.nextBlink, self.nextWiggle, self.nextLegWiggle, self.nextEarWiggle]
        guard deadlines.contains(where: { $0 <= date }) else { return }
        self.scheduleRandomTimers(from: date)
    }

    private var gatewayNeedsAttention: Bool {
        if self.isSleeping { return false }
        switch self.gatewayStatus {
        case .failed, .stopped:
            return !self.isPaused
        case .starting, .running, .attachedExisting:
            return false
        }
    }

    private var gatewayBadgeColor: Color {
        switch self.gatewayStatus {
        case .failed: .red
        case .stopped: .orange
        default: .clear
        }
    }
}

#if DEBUG
@MainActor
extension CritterStatusLabel {
    static func exerciseForTesting() async {
        var label = CritterStatusLabel(
            isPaused: false,
            isSleeping: false,
            isWorking: true,
            earBoostActive: false,
            blinkTick: 1,
            sendCelebrationTick: 1,
            gatewayStatus: .running(details: nil),
            animationsEnabled: true,
            iconState: .workingMain(.tool(.bash)),
            voiceWakeMeterActive: true)

        _ = label.body
        _ = label.iconImage
        _ = label.tickTaskID
        label.tick(Date())
        label.resetMotion()
        label.blink()
        label.wiggle()
        label.wiggleLegs()
        label.wiggleEars()
        label.scurry()
        label.celebrate()
        label.scheduleRandomTimers(from: Date())
        _ = label.gatewayNeedsAttention
        _ = label.gatewayBadgeColor

        label.isPaused = true
        _ = label.iconImage

        label.isPaused = false
        label.isSleeping = true
        _ = label.iconImage

        label.isSleeping = false
        label.iconState = .idle
        _ = label.iconImage

        let failed = CritterStatusLabel(
            isPaused: false,
            isSleeping: false,
            isWorking: false,
            earBoostActive: false,
            blinkTick: 0,
            sendCelebrationTick: 0,
            gatewayStatus: .failed("boom"),
            animationsEnabled: false,
            iconState: .idle,
            voiceWakeMeterActive: false)
        _ = failed.gatewayNeedsAttention
        _ = failed.gatewayBadgeColor

        let stopped = CritterStatusLabel(
            isPaused: false,
            isSleeping: false,
            isWorking: false,
            earBoostActive: false,
            blinkTick: 0,
            sendCelebrationTick: 0,
            gatewayStatus: .stopped,
            animationsEnabled: false,
            iconState: .idle,
            voiceWakeMeterActive: false)
        _ = stopped.gatewayNeedsAttention
        _ = stopped.gatewayBadgeColor

        _ = CritterIconRenderer.makeIcon(
            blink: 0.6,
            legWiggle: 0.8,
            earWiggle: 0.4,
            earScale: 1.4,
            antennaDroop: 0.5,
            eyesClosedLines: true,
            happyEyes: true,
            badge: .init(symbolName: "gearshape.fill", prominence: .secondary))
    }
}
#endif
