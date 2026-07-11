import Foundation
import SwiftUI

/// High-level emotional state for the animated mascot. Callers describe *how
/// the mascot should feel*; the animator owns how that feeling looks, including
/// the transition gesture played when a mood is entered.
public enum OpenClawMascotMood: String, CaseIterable, Equatable, Sendable {
    /// Site-parity float/wiggle plus randomized blinks, glances, and rare quirks.
    case idle
    /// Looks around a lot — searching (gateway discovery, permission list).
    case curious
    /// Eyes drift up and scan, antennae twitch asymmetrically — work in flight.
    case thinking
    /// Perky antennae, soft smile, happy-squint eyes.
    case happy
    /// One big jump-and-claw-raise entrance, then sparkly happy loop.
    case celebrating
    /// Droopy antennae, dim glow, downward gaze, periodic sighs.
    case sad
    /// Heavy lids, slow float, drifting z's; periodic yawns.
    case sleepy
    /// Subdued idle that watches the content below (compact chat hero).
    case attentive
}

/// Ambient particle overlay drawn around the mascot for one pose frame.
enum OpenClawMascotEffect: Equatable {
    case none
    case sparkles
    case hearts
    case zzz
}

/// Drives the mascot's behavior over time: per-mood base loops, randomized
/// micro-behaviors (blinks, glances, claw snaps, rare quirks), one-shot
/// gestures, and interaction Easter eggs (click reactions, dizzy spiral,
/// auto-sleep). Not thread-safe by design — SwiftUI drives it from the view
/// body on the main thread only.
final class OpenClawMascotAnimator {
    /// Deterministic xorshift64* so tests can seed the behavior schedule.
    struct SeededGenerator: RandomNumberGenerator {
        private var state: UInt64

        init(seed: UInt64) {
            self.state = seed == 0 ? 0x9E37_79B9_7F4A_7C15 : seed
        }

        mutating func next() -> UInt64 {
            self.state ^= self.state >> 12
            self.state ^= self.state << 25
            self.state ^= self.state >> 27
            return self.state &* 2_685_821_657_736_338_717
        }
    }

    private(set) var mood: OpenClawMascotMood = .idle

    private var rng: SeededGenerator
    private var startTime: TimeInterval?
    private var lastPoseTime: TimeInterval = 0

    // One-shot gesture playback (single slot; quirks wait for a free slot).
    private var activeGesture: OpenClawMascotGesture?
    private var activeGestureStart: TimeInterval = 0
    private var pendingGesture: OpenClawMascotGesture?
    private var pendingGestureAt: TimeInterval = 0

    // Randomized micro-behavior schedule.
    private var nextBlinkAt: TimeInterval = 0
    private var pendingDoubleBlink = false
    private var blinkStarts: [TimeInterval] = []
    private var nextGlanceAt: TimeInterval = 0
    private var gazeHoldUntil: TimeInterval = 0
    private var gazeTarget: CGSize = .zero
    private var currentGaze: CGSize = .zero
    private var nextClawSnapAt: TimeInterval = 0
    private var nextQuirkAt: TimeInterval = 0
    private var nextMoodBeatAt: TimeInterval = 0
    private var lastClickReaction: OpenClawMascotGesture?

    // Interaction state.
    private var pointerTarget: CGSize?
    private var recentTapTimes: [TimeInterval] = []
    private var dizzyStart: TimeInterval = 0
    private var dizzyUntil: TimeInterval = 0
    private var dizzyRecoveryQueued = false

    // Auto-sleep: idle mascots doze off and need a click to wake up. Night
    // owls (23:00-05:00 local) nod off about twice as fast. Only mascots with
    // a tap handler may sleep — a non-interactive view has no wake path and
    // would stay asleep forever.
    private let allowsAutoSleep: Bool
    private var lastInteractionAt: TimeInterval = 0
    private var sleepAfter: TimeInterval = 60
    private let nightOwl: Bool

    init(seed: UInt64? = nil, hourOfDay: Int? = nil, allowsAutoSleep: Bool = false) {
        self.rng = SeededGenerator(seed: seed ?? UInt64.random(in: 1...UInt64.max))
        self.allowsAutoSleep = allowsAutoSleep
        let hour = hourOfDay ?? Calendar.current.component(.hour, from: Date())
        self.nightOwl = hour >= 23 || hour < 5
    }

    // MARK: - Inputs

    func setMood(_ mood: OpenClawMascotMood, at time: TimeInterval) {
        guard mood != self.mood else { return }
        self.mood = mood
        self.lastInteractionAt = time
        self.rescheduleMoodBeat(at: time)
        if let entrance = Self.entranceGesture(for: mood) {
            self.startGesture(entrance, at: time)
        }
    }

    /// Pointer direction from the view center, roughly unit-scaled; nil when
    /// the pointer leaves. Eyes track it, and presence defers auto-sleep —
    /// but hovering never wakes a sleeping mascot; that takes a click.
    func setPointerTarget(_ direction: CGSize?, at time: TimeInterval) {
        self.pointerTarget = direction.map { dir in
            CGSize(width: dir.width.clamped(to: -1...1), height: dir.height.clamped(to: -1...1))
        }
        if direction != nil, !self.isDozing(at: time) {
            self.lastInteractionAt = time
        }
    }

    /// Click Easter-egg ladder: single clicks pick a playful reaction, a
    /// quick burst of affection earns blushing hearts, and relentless
    /// clicking makes the poor thing dizzy.
    func handleTap(at time: TimeInterval) {
        let wasDozing = self.isDozing(at: time)
        self.lastInteractionAt = time
        self.sleepAfter = self.randomSleepDelay()
        if wasDozing {
            self.startGesture(.startle, at: time)
            return
        }
        self.recentTapTimes.append(time)
        self.recentTapTimes.removeAll { time - $0 > 3.0 }
        let burst = self.recentTapTimes.count
        if time < self.dizzyUntil || burst >= 6 {
            if time >= self.dizzyUntil {
                self.dizzyStart = time
            }
            self.dizzyUntil = max(self.dizzyUntil, time + 2.4)
            self.dizzyRecoveryQueued = true
            self.activeGesture = nil
            return
        }
        if burst >= 3 {
            self.startGesture(.heartBurst, at: time)
            return
        }
        var reactions: [OpenClawMascotGesture] = [.hop, .wave, .wink]
        if let last = self.lastClickReaction {
            reactions.removeAll { $0 == last }
        }
        let reaction = reactions.randomElement(using: &self.rng) ?? .hop
        self.lastClickReaction = reaction
        self.startGesture(reaction, at: time)
    }

    // MARK: - Pose

    func pose(at time: TimeInterval) -> OpenClawMascotPose {
        if self.startTime == nil {
            self.begin(at: time)
        }
        let dt = (time - self.lastPoseTime).clamped(to: 0...0.1)
        self.lastPoseTime = time
        self.advanceSchedules(at: time)

        let dozing = self.isDozing(at: time)
        let effectiveMood: OpenClawMascotMood = dozing ? .sleepy : self.mood
        var pose = self.basePose(for: effectiveMood, at: time)
        self.applyGaze(&pose, mood: effectiveMood, at: time, dt: dt)
        self.applyBlinks(&pose, at: time)
        self.applyDizzy(&pose, at: time)

        if let gesture = self.activeGesture {
            let progress = (time - self.activeGestureStart) / gesture.duration
            if progress >= 1 {
                self.activeGesture = nil
            } else {
                gesture.apply(to: &pose, progress: CGFloat(progress))
            }
        }

        pose.clampChannels()
        return pose
    }

    // MARK: - Lifecycle

    private func begin(at time: TimeInterval) {
        self.startTime = time
        self.lastPoseTime = time
        self.lastInteractionAt = time
        self.sleepAfter = self.randomSleepDelay()
        self.nextBlinkAt = time + self.random(in: 0.8...2.4)
        self.nextGlanceAt = time + self.random(in: 1.5...4.0)
        self.nextClawSnapAt = time + self.random(in: 2.0...5.0)
        self.nextQuirkAt = time + self.random(in: 9...18)
        self.rescheduleMoodBeat(at: time)
        // Say hello: a little wave shortly after first appearing.
        if self.mood == .idle || self.mood == .curious || self.mood == .happy {
            self.pendingGesture = .wave
            self.pendingGestureAt = time + 0.9
        }
    }

    private func isDozing(at time: TimeInterval) -> Bool {
        self.allowsAutoSleep && self.mood == .idle &&
            time - self.lastInteractionAt > self.sleepAfter
    }

    private func randomSleepDelay() -> TimeInterval {
        let base = self.random(in: 45...80)
        return self.nightOwl ? base * 0.55 : base
    }

    private func random(in range: ClosedRange<Double>) -> Double {
        Double.random(in: range, using: &self.rng)
    }

    // MARK: - Schedules

    private func advanceSchedules(at time: TimeInterval) {
        if time >= self.nextBlinkAt {
            self.blinkStarts.append(time)
            if self.pendingDoubleBlink {
                self.pendingDoubleBlink = false
                self.nextBlinkAt = time + self.blinkInterval()
            } else if self.random(in: 0...1) < 0.14 {
                self.pendingDoubleBlink = true
                self.nextBlinkAt = time + 0.34
            } else {
                self.nextBlinkAt = time + self.blinkInterval()
            }
        }
        self.blinkStarts.removeAll { time - $0 > OpenClawMascotGesture.blinkDuration }

        if time >= self.nextGlanceAt {
            self.gazeTarget = self.randomGlanceTarget()
            self.gazeHoldUntil = time + self.random(in: 0.7...1.9)
            self.nextGlanceAt = self.gazeHoldUntil + self.glanceInterval()
        } else if time >= self.gazeHoldUntil {
            self.gazeTarget = .zero
        }

        let dozing = self.isDozing(at: time)
        if time >= self.nextClawSnapAt {
            if self.activeGesture == nil, !dozing, self.mood != .sad, time >= self.dizzyUntil {
                self.startGesture(.clawSnap, at: time)
            }
            self.nextClawSnapAt = time + self.random(in: 4...9)
        }

        if time >= self.nextQuirkAt {
            if self.activeGesture == nil, !dozing, time >= self.dizzyUntil, self.quirkEligible {
                self.startGesture(self.randomQuirk(), at: time)
            }
            self.nextQuirkAt = time + self.random(in: self.mood == .curious ? 7...14 : 9...18)
        }

        if time >= self.nextMoodBeatAt {
            if self.activeGesture == nil, time >= self.dizzyUntil {
                if self.mood == .sad {
                    self.startGesture(.sigh, at: time)
                } else if dozing || self.mood == .sleepy {
                    self.startGesture(.yawn, at: time)
                }
            }
            self.rescheduleMoodBeat(at: time)
        }

        // Fires once the gesture slot frees up rather than dropping the clip.
        if let pending = self.pendingGesture, time >= self.pendingGestureAt,
           self.activeGesture == nil, !dozing
        {
            self.pendingGesture = nil
            self.startGesture(pending, at: time)
        }

        if self.dizzyRecoveryQueued, time >= self.dizzyUntil {
            self.dizzyRecoveryQueued = false
            self.startGesture(.shake, at: time)
        }
    }

    private var quirkEligible: Bool {
        switch self.mood {
        case .idle, .curious, .happy, .attentive: true
        case .thinking, .celebrating, .sad, .sleepy: false
        }
    }

    private func randomQuirk() -> OpenClawMascotGesture {
        // Weighted grab bag; the sneeze stays rare so it keeps surprising.
        let roll = self.random(in: 0...11)
        switch roll {
        case ..<3: return .wink
        case ..<6: return .peek
        case ..<8: return .antennaZap
        case ..<10: return .hop
        default: return .sneeze
        }
    }

    private func blinkInterval() -> TimeInterval {
        self.mood == .attentive ? self.random(in: 1.8...4.0) : self.random(in: 2.2...5.5)
    }

    private func glanceInterval() -> TimeInterval {
        switch self.mood {
        case .curious: self.random(in: 1.6...4.0)
        case .thinking: self.random(in: 1.2...3.0)
        default: self.random(in: 3.0...8.0)
        }
    }

    private func randomGlanceTarget() -> CGSize {
        let magnitude = self.random(in: 0.5...1.0)
        let angle = self.random(in: 0...(2 * .pi))
        // Bias horizontal: sideways glances read better than straight up/down.
        return CGSize(width: cos(angle) * magnitude, height: sin(angle) * magnitude * 0.6)
    }

    private func rescheduleMoodBeat(at time: TimeInterval) {
        self.nextMoodBeatAt = time + self.random(in: 6...12)
    }

    private func startGesture(_ gesture: OpenClawMascotGesture, at time: TimeInterval) {
        self.activeGesture = gesture
        self.activeGestureStart = time
    }

    private static func entranceGesture(for mood: OpenClawMascotMood) -> OpenClawMascotGesture? {
        switch mood {
        case .happy: .hop
        case .celebrating: .celebrate
        case .sad: .sigh
        case .sleepy: .yawn
        case .idle, .curious, .thinking, .attentive: nil
        }
    }

    // MARK: - Pose layers

    /// Per-mood base loop. `.idle` keeps the exact site-parity waves (float 4s,
    /// antenna ±3° at 2s); other moods reshape speed, depth, and expression.
    private func basePose(for mood: OpenClawMascotMood, at time: TimeInterval) -> OpenClawMascotPose {
        var pose = OpenClawMascotPose()
        switch mood {
        case .idle:
            pose.floatOffset = -4.8 * (1 - cos(2 * .pi * Self.cyclePhase(time, period: 4)))
            pose.antennaDegrees = -3 * sin(2 * .pi * Self.cyclePhase(time, period: 2))
        case .curious:
            pose.floatOffset = -4.2 * (1 - cos(2 * .pi * Self.cyclePhase(time, period: 3.4)))
            pose.antennaDegrees = -4 * sin(2 * .pi * Self.cyclePhase(time, period: 1.7))
            pose.bodyTilt = 1.6 * sin(2 * .pi * Self.cyclePhase(time, period: 5.2))
        case .thinking:
            pose.floatOffset = -3.2 * (1 - cos(2 * .pi * Self.cyclePhase(time, period: 5)))
            // Antennae twitch out of phase — visible "processing".
            pose.antennaDegrees = -5 * sin(2 * .pi * Self.cyclePhase(time, period: 1.3))
            pose.bodyTilt = 2 * sin(2 * .pi * Self.cyclePhase(time, period: 6))
            pose.eyeGlowOpacity = 0.9 + 0.1 * sin(2 * .pi * Self.cyclePhase(time, period: 0.8))
        case .happy:
            pose.floatOffset = -6 * (1 - cos(2 * .pi * Self.cyclePhase(time, period: 3)))
            pose.antennaDegrees = -4.5 * sin(2 * .pi * Self.cyclePhase(time, period: 1.6))
            pose.mouthCurve = 0.55 + 0.1 * sin(2 * .pi * Self.cyclePhase(time, period: 3))
            pose.happyEyes = 0.35
        case .celebrating:
            let hop = abs(sin(2 * .pi * Self.cyclePhase(time, period: 1.6)))
            pose.floatOffset = -9 * hop
            pose.bodyStretch = 1 + 0.03 * hop
            pose.antennaDegrees = -6 * sin(2 * .pi * Self.cyclePhase(time, period: 0.8))
            let clawWave = sin(2 * .pi * Self.cyclePhase(time, period: 0.9))
            pose.leftClawDegrees = 20 + 8 * clawWave
            pose.rightClawDegrees = -20 + 8 * clawWave
            pose.mouthCurve = 0.9
            pose.mouthOpen = 0.35
            pose.happyEyes = 0.7
            pose.glowScale = 1.1
            pose.effect = .sparkles
            pose.effectPhase = Self.cyclePhase(time, period: 2.2)
        case .sad:
            pose.floatOffset = -2.4 * (1 - cos(2 * .pi * Self.cyclePhase(time, period: 5.5)))
            pose.antennaDegrees = -1.5 * sin(2 * .pi * Self.cyclePhase(time, period: 3))
            pose.antennaDroop = 0.75
            pose.mouthCurve = -0.55
            pose.eyeGlowOpacity = 0.6
        case .sleepy:
            pose.floatOffset = -2 * (1 - cos(2 * .pi * Self.cyclePhase(time, period: 6)))
            pose.antennaDroop = 0.35
            pose.leftEyeOpenness = 0.22 + 0.08 * sin(2 * .pi * Self.cyclePhase(time, period: 3))
            pose.rightEyeOpenness = pose.leftEyeOpenness
            pose.eyeGlowOpacity = 0.5
            pose.mouthRound = 0.15
            // Slow head-bob as it nods off.
            pose.bodyTilt = 2.5 * sin(2 * .pi * Self.cyclePhase(time, period: 6))
            pose.effect = .zzz
            pose.effectPhase = Self.cyclePhase(time, period: 3)
        case .attentive:
            pose.floatOffset = -3 * (1 - cos(2 * .pi * Self.cyclePhase(time, period: 4)))
            pose.antennaDegrees = -2.5 * sin(2 * .pi * Self.cyclePhase(time, period: 2))
            pose.mouthCurve = 0.25
        }
        return pose
    }

    private func applyGaze(
        _ pose: inout OpenClawMascotPose,
        mood: OpenClawMascotMood,
        at time: TimeInterval,
        dt: TimeInterval)
    {
        var target = self.pointerTarget ?? self.gazeTarget
        switch mood {
        case .thinking:
            // Pondering: eyes drift up and slowly scan side to side.
            if self.pointerTarget == nil {
                target = CGSize(
                    width: 0.4 * sin(2 * .pi * Self.cyclePhase(time, period: 3.8)),
                    height: -0.55)
            }
        case .attentive:
            if self.pointerTarget == nil {
                target = CGSize(width: target.width * 0.5, height: 0.35)
            }
        case .sad:
            if self.pointerTarget == nil {
                target = CGSize(width: target.width * 0.3, height: 0.5)
            }
        case .sleepy:
            target = CGSize(width: 0, height: 0.4)
        case .idle, .curious, .happy, .celebrating:
            break
        }
        let blend = 1 - exp(-dt * 9)
        self.currentGaze.width += (target.width - self.currentGaze.width) * blend
        self.currentGaze.height += (target.height - self.currentGaze.height) * blend
        pose.gaze = self.currentGaze
    }

    private func applyBlinks(_ pose: inout OpenClawMascotPose, at time: TimeInterval) {
        guard pose.happyEyes < 0.6 else { return }
        for start in self.blinkStarts {
            let progress = (time - start) / OpenClawMascotGesture.blinkDuration
            guard progress >= 0, progress <= 1 else { continue }
            let closure = OpenClawMascotGesture.bell(CGFloat(progress))
            pose.leftEyeOpenness = min(pose.leftEyeOpenness, 1 - closure)
            pose.rightEyeOpenness = min(pose.rightEyeOpenness, 1 - closure)
            pose.eyeGlowOpacity *= max(0.3, 1 - closure)
        }
    }

    private func applyDizzy(_ pose: inout OpenClawMascotPose, at time: TimeInterval) {
        guard time < self.dizzyUntil else { return }
        let remaining = self.dizzyUntil - time
        // Ramp in from the first dizzy tap, out toward the recovery shake;
        // extra taps extend `dizzyUntil` without restarting the ramp-in.
        let ramp = min((time - self.dizzyStart) / 0.25, remaining / 0.4).clamped(to: 0...1)
        pose.dizzy = ramp
        pose.dizzyPhase = Self.cyclePhase(time, period: 0.55)
        pose.bodyTilt += 4.5 * ramp * sin(2 * .pi * Self.cyclePhase(time, period: 0.85))
        pose.antennaDegrees += 6 * ramp * sin(2 * .pi * Self.cyclePhase(time, period: 0.45))
        pose.mouthRound = max(pose.mouthRound, 0.3 * ramp)
        pose.happyEyes = 0
        pose.mouthCurve = min(pose.mouthCurve, 0)
        pose.gaze = .zero
    }

    static func cyclePhase(_ time: TimeInterval, period: TimeInterval) -> CGFloat {
        let normalized = (time / period).truncatingRemainder(dividingBy: 1)
        return CGFloat(normalized < 0 ? normalized + 1 : normalized)
    }
}

/// One-shot animation clips layered over the mood base pose.
enum OpenClawMascotGesture: Equatable {
    case wave
    case hop
    case wink
    case celebrate
    case heartBurst
    case peek
    case sneeze
    case antennaZap
    case sigh
    case yawn
    case startle
    case shake
    case clawSnap

    static let blinkDuration: TimeInterval = 0.16

    var duration: TimeInterval {
        switch self {
        case .wave: 1.5
        case .hop: 0.7
        case .wink: 0.9
        case .celebrate: 2.4
        case .heartBurst: 2.0
        case .peek: 1.9
        case .sneeze: 1.5
        case .antennaZap: 1.0
        case .sigh: 1.8
        case .yawn: 2.0
        case .startle: 0.8
        case .shake: 0.8
        case .clawSnap: 0.6
        }
    }

    func apply(to pose: inout OpenClawMascotPose, progress p: CGFloat) {
        switch self {
        case .wave:
            let raised = Self.plateau(p, attack: 0.18, release: 0.82)
            pose.rightClawDegrees += raised * (-28 + 9 * sin(p * 6 * .pi))
            pose.bodyTilt += -2 * raised
            pose.mouthCurve = max(pose.mouthCurve, 0.5 * raised)
        case .hop:
            let air = Self.bell(((p - 0.2) / 0.6).clamped(to: 0...1))
            pose.floatOffset += -9 * air
            pose.bodyStretch += 0.045 * air - 0.1 * Self.bell((p / 0.2).clamped(to: 0...1))
                - 0.06 * Self.bell(((p - 0.82) / 0.18).clamped(to: 0...1))
            pose.mouthCurve = max(pose.mouthCurve, 0.4 * air)
        case .wink:
            let closure = Self.plateau(p, attack: 0.3, release: 0.72)
            pose.rightEyeOpenness = min(pose.rightEyeOpenness, 1 - closure)
            pose.mouthCurve = max(pose.mouthCurve, 0.5 * closure)
            pose.bodyTilt += 1.5 * closure
        case .celebrate:
            let env = Self.plateau(p, attack: 0.12, release: 0.88)
            let hops = abs(sin(p * 4 * .pi))
            pose.floatOffset += -11 * hops * env
            pose.bodyStretch += 0.035 * hops * env
            pose.leftClawDegrees += 38 * env
            pose.rightClawDegrees += -38 * env
            pose.happyEyes = max(pose.happyEyes, env)
            pose.mouthCurve = max(pose.mouthCurve, env)
            pose.mouthOpen = max(pose.mouthOpen, 0.6 * Self.bell(p))
            pose.antennaDroop = 0
            pose.glowScale = max(pose.glowScale, 1 + 0.2 * env)
            pose.effect = .sparkles
            pose.effectPhase = p
        case .heartBurst:
            let env = Self.plateau(p, attack: 0.15, release: 0.85)
            pose.blush = max(pose.blush, 0.9 * env)
            pose.happyEyes = max(pose.happyEyes, 0.8 * env)
            pose.mouthCurve = max(pose.mouthCurve, 0.8 * env)
            pose.bodyTilt += 2 * env * sin(p * 4 * .pi)
            pose.effect = .hearts
            pose.effectPhase = p
        case .peek:
            // Lean left, then right, like checking who's offscreen.
            let left = Self.plateau((p / 0.5).clamped(to: 0...1), attack: 0.3, release: 0.7)
            let right = Self.plateau(((p - 0.5) / 0.5).clamped(to: 0...1), attack: 0.3, release: 0.7)
            pose.bodyTilt += -6 * left + 6 * right
            pose.gaze = CGSize(width: -1.1 * left + 1.1 * right, height: -0.1)
            pose.glowScale = max(pose.glowScale, 1.1)
        case .sneeze:
            if p < 0.42 {
                let inhale = OpenClawMascotGesture.easeInOut(p / 0.42)
                pose.bodyStretch += 0.04 * inhale
                pose.gaze = CGSize(width: 0, height: -0.8 * inhale)
                pose.mouthRound = max(pose.mouthRound, 0.55 * inhale)
                pose.antennaDegrees += 8 * inhale
            } else if p < 0.58 {
                let burst = Self.bell((p - 0.42) / 0.16)
                pose.bodyStretch -= 0.13 * burst
                pose.leftEyeOpenness = 0
                pose.rightEyeOpenness = 0
                pose.antennaDroop = max(pose.antennaDroop, 0.9 * burst)
                pose.bodyTilt += 3 * burst
            } else {
                let recover = 1 - OpenClawMascotGesture.easeInOut((p - 0.58) / 0.42)
                pose.antennaDroop = max(pose.antennaDroop, 0.5 * recover)
                pose.eyeGlowOpacity *= 1 - 0.4 * recover
                pose.mouthRound = max(pose.mouthRound, 0.2 * recover)
            }
        case .antennaZap:
            let env = 1 - p
            pose.antennaDegrees += 5 * env * sin(p * 12 * .pi)
            pose.glowScale = max(pose.glowScale, 1 + 0.55 * Self.bell(p))
            pose.eyeGlowOpacity = 1
        case .sigh:
            let rise = OpenClawMascotGesture.easeInOut((p / 0.3).clamped(to: 0...1))
            let fall = OpenClawMascotGesture.easeInOut(((p - 0.3) / 0.45).clamped(to: 0...1))
            pose.bodyStretch += 0.025 * rise - 0.08 * fall * (1 - ((p - 0.85) / 0.15).clamped(to: 0...1))
            pose.gaze = CGSize(width: pose.gaze.width, height: 0.5 * fall)
            pose.antennaDroop = min(1, pose.antennaDroop + 0.15 * fall)
        case .yawn:
            let openess = Self.plateau(p, attack: 0.3, release: 0.75)
            pose.mouthRound = max(pose.mouthRound, 0.9 * openess)
            pose.leftEyeOpenness = min(pose.leftEyeOpenness, 1 - 0.9 * openess)
            pose.rightEyeOpenness = min(pose.rightEyeOpenness, 1 - 0.9 * openess)
            pose.bodyStretch += 0.03 * openess
            pose.bodyTilt += -2 * openess
        case .startle:
            let jolt = Self.bell((p / 0.4).clamped(to: 0...1))
            pose.floatOffset += -5 * jolt
            pose.bodyStretch += 0.05 * jolt
            pose.glowScale = max(pose.glowScale, 1 + 0.4 * jolt)
            pose.leftEyeOpenness = 1
            pose.rightEyeOpenness = 1
            pose.antennaDroop = 0
            pose.antennaDegrees = 0
            pose.gaze = .zero
        case .shake:
            pose.bodyTilt += 5 * (1 - p) * sin(p * 6 * .pi)
            pose.gaze = .zero
        case .clawSnap:
            // The site's 4s-cycle snap, compressed into a schedulable clip:
            // snap to -8° and back, right claw trailing slightly.
            pose.leftClawDegrees += -8 * Self.bell((p / 0.7).clamped(to: 0...1))
            pose.rightClawDegrees += -8 * Self.bell(((p - 0.25) / 0.7).clamped(to: 0...1))
        }
    }

    // MARK: - Easing

    static func easeInOut(_ t: CGFloat) -> CGFloat {
        let clamped = t.clamped(to: 0...1)
        return clamped * clamped * (3 - 2 * clamped)
    }

    /// Smooth 0→1→0 bump peaking at 0.5.
    static func bell(_ t: CGFloat) -> CGFloat {
        let clamped = t.clamped(to: 0...1)
        return self.easeInOut(clamped < 0.5 ? clamped * 2 : (1 - clamped) * 2)
    }

    /// Ease in until `attack`, hold at 1, ease out after `release`.
    static func plateau(_ t: CGFloat, attack: CGFloat, release: CGFloat) -> CGFloat {
        let clamped = t.clamped(to: 0...1)
        if clamped < attack {
            return self.easeInOut(clamped / attack)
        }
        if clamped > release {
            return self.easeInOut((1 - clamped) / (1 - release))
        }
        return 1
    }
}

extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}
