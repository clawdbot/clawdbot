import Foundation
import Testing
@testable import OpenClawChatUI

struct OpenClawMascotAnimatorTests {
    private func makeAnimator(seed: UInt64 = 7, interactive: Bool = false) -> OpenClawMascotAnimator {
        OpenClawMascotAnimator(seed: seed, hourOfDay: 12, allowsAutoSleep: interactive)
    }

    @Test func `poses stay inside drawable bounds for every mood`() {
        for mood in OpenClawMascotMood.allCases {
            let animator = self.makeAnimator()
            _ = animator.pose(at: 0)
            animator.setMood(mood, at: 0)
            var time: TimeInterval = 0
            while time < 30 {
                let pose = animator.pose(at: time)
                #expect(pose.floatOffset.isFinite, "\(mood)")
                #expect((-12...2).contains(pose.floatOffset), "\(mood)")
                #expect((0.86...1.05).contains(pose.bodyStretch), "\(mood)")
                #expect((-8...8).contains(pose.bodyTilt), "\(mood)")
                #expect((0...1).contains(pose.leftEyeOpenness), "\(mood)")
                #expect((0...1).contains(pose.rightEyeOpenness), "\(mood)")
                #expect((0...1).contains(pose.eyeGlowOpacity), "\(mood)")
                #expect((-45...45).contains(pose.leftClawDegrees), "\(mood)")
                #expect((-45...45).contains(pose.rightClawDegrees), "\(mood)")
                #expect((0...1).contains(pose.hardHat), "\(mood)")
                #expect((0...1).contains(pose.accessoryAmount), "\(mood)")
                #expect(abs(pose.gaze.width) <= 1.2 && abs(pose.gaze.height) <= 1.2, "\(mood)")
                time += 1.0 / 30
            }
        }
    }

    @Test func `idle blinks are occasional not constant`() {
        let animator = self.makeAnimator()
        var minOpenness: CGFloat = 1
        var opennessSum: CGFloat = 0
        var samples = 0
        var time: TimeInterval = 0
        while time < 12 {
            let pose = animator.pose(at: time)
            minOpenness = min(minOpenness, pose.leftEyeOpenness)
            opennessSum += pose.leftEyeOpenness
            samples += 1
            time += 1.0 / 30
        }
        #expect(minOpenness < 0.5, "expected at least one blink within 12s")
        #expect(opennessSum / CGFloat(samples) > 0.8, "eyes should be mostly open")
    }

    @Test func `celebrating entrance raises claws`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        animator.setMood(.celebrating, at: 1)
        var raised = false
        var time: TimeInterval = 1
        while time < 2.5 {
            let pose = animator.pose(at: time)
            if pose.leftClawDegrees > 15, pose.rightClawDegrees < -15 {
                raised = true
            }
            time += 1.0 / 30
        }
        #expect(raised)
    }

    @Test func `sad mood droops and frowns`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        animator.setMood(.sad, at: 1)
        let pose = animator.pose(at: 5)
        #expect(pose.antennaDroop > 0.5)
        #expect(pose.mouthCurve < 0)
        #expect(pose.eyeGlowOpacity < 0.9)
    }

    @Test func `working mood hammers with hat and sparks`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        animator.setMood(.working, at: 0)
        var minimumClaw: CGFloat = 45
        var maximumClaw: CGFloat = -45
        var wearsHat = false
        var sparks = false
        var time: TimeInterval = 0
        while time < 4 {
            let pose = animator.pose(at: time)
            minimumClaw = min(minimumClaw, pose.rightClawDegrees)
            maximumClaw = max(maximumClaw, pose.rightClawDegrees)
            wearsHat = wearsHat || (time > 1 && pose.hardHat == 1)
            sparks = sparks || pose.effect == .sparks
            time += 1.0 / 30
        }
        #expect(wearsHat)
        #expect(maximumClaw - minimumClaw > 25)
        #expect(sparks)
    }

    @Test func `working brow wipe interrupts hammering`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        animator.setMood(.working, at: 0)
        var wiped = false
        var time: TimeInterval = 0
        while time < 14 {
            let pose = animator.pose(at: time)
            wiped = wiped || (pose.effect == .sweat && pose.happyEyes > 0.5)
            time += 1.0 / 30
        }
        #expect(wiped)
    }

    @Test func `sleepy mood wears the nightcap`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        animator.setMood(.sleepy, at: 1)
        let animated = animator.pose(at: 4)
        #expect(animated.accessory == .nightcap)
        #expect(animated.accessoryAmount == 1)

        let staticPose = OpenClawMascotPose.staticPose(for: .sleepy)
        #expect(staticPose.accessory == .nightcap)
        #expect(staticPose.accessoryAmount == 1)
    }

    @Test func `requested graduation cap eases into the pose`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        animator.setAccessory(.gradCap, at: 1)

        let initial = animator.pose(at: 1)
        #expect(initial.accessory == .gradCap)
        #expect(initial.accessoryAmount == 0)
        let entering = animator.pose(at: 1.25)
        #expect((0..<1).contains(entering.accessoryAmount))
        let settled = animator.pose(at: 1.5)
        #expect(settled.accessory == .gradCap)
        #expect(settled.accessoryAmount == 1)
    }

    @Test func `leaving working tips then removes the hard hat`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        animator.setMood(.working, at: 0.1)
        _ = animator.pose(at: 2)
        animator.setMood(.happy, at: 2)

        var keptHat = false
        var time: TimeInterval = 2
        while time < 2.9 {
            keptHat = keptHat || animator.pose(at: time).hardHat > 0.3
            time += 1.0 / 30
        }
        #expect(keptHat)
        #expect(animator.pose(at: 3.5).hardHat == 0)
    }

    @Test func `hard hat suppresses requested headwear until the tip finishes`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        animator.setMood(.working, at: 0)
        animator.setAccessory(.gradCap, at: 0)

        // While working (and through the hat-tip exit) the hard hat owns the
        // crown: the requested cap must not co-render.
        var time: TimeInterval = 0.2
        while time < 3 {
            let pose = animator.pose(at: time)
            if pose.hardHat > 0.01 {
                #expect(pose.accessoryAmount == 0, "two hats at t=\(time)")
            }
            time += 1.0 / 30
        }
        animator.setMood(.happy, at: 3)
        while time < 4.4 {
            let pose = animator.pose(at: time)
            if pose.hardHat > 0.01 {
                #expect(pose.accessoryAmount == 0, "two hats at t=\(time)")
            }
            time += 1.0 / 30
        }
        let after = animator.pose(at: 4.5)
        #expect(after.hardHat == 0)
        #expect(after.accessory == .gradCap)
        #expect(after.accessoryAmount == 1)
    }

    @Test func `cancelled working exit skips the phantom hat tip`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        animator.setMood(.working, at: 0)
        // The don is still in flight; the hat never seated.
        _ = animator.pose(at: 0.15)
        animator.setMood(.happy, at: 0.15)

        var time: TimeInterval = 0.16
        while time < 1.5 {
            #expect(animator.pose(at: time).hardHat < 0.05, "phantom hat at t=\(time)")
            time += 1.0 / 30
        }
    }

    @Test func `affection taps trigger hearts`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        animator.handleTap(at: 1.0)
        animator.handleTap(at: 1.3)
        animator.handleTap(at: 1.6)
        let pose = animator.pose(at: 2.2)
        #expect(pose.effect == .hearts)
        #expect(pose.blush > 0)
    }

    @Test func `rapid taps make dizzy then recover`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        for index in 0..<7 {
            animator.handleTap(at: 1.0 + Double(index) * 0.2)
        }
        let dizzyPose = animator.pose(at: 3.0)
        #expect(dizzyPose.dizzy > 0.5)
        let recoveredPose = animator.pose(at: 8.0)
        #expect(recoveredPose.dizzy == 0)
    }

    @Test func `interactive idle mascot dozes off and wakes on tap`() {
        let animator = self.makeAnimator(interactive: true)
        _ = animator.pose(at: 0)
        // Max auto-sleep delay is 80s; 200s is safely asleep for any seed.
        let sleeping = animator.pose(at: 200)
        #expect(sleeping.leftEyeOpenness < 0.5)
        #expect(sleeping.effect == .zzz)
        animator.handleTap(at: 201)
        let awake = animator.pose(at: 201.05)
        #expect(awake.effect != .zzz)
        #expect(awake.leftEyeOpenness > 0.5)
    }

    @Test func `hovering does not wake a sleeping mascot`() {
        let animator = self.makeAnimator(interactive: true)
        _ = animator.pose(at: 0)
        _ = animator.pose(at: 200)
        animator.setPointerTarget(CGSize(width: 1, height: 0), at: 200.1)
        let pose = animator.pose(at: 200.2)
        #expect(pose.effect == .zzz)
    }

    @Test func `non-interactive mascot never sleeps — it has no wake path`() {
        let animator = self.makeAnimator(interactive: false)
        _ = animator.pose(at: 0)
        let pose = animator.pose(at: 500)
        #expect(pose.effect != .zzz)
        #expect(pose.leftEyeOpenness > 0.5)
    }

    @Test func `pointer target steers gaze`() {
        let animator = self.makeAnimator()
        _ = animator.pose(at: 0)
        animator.setPointerTarget(CGSize(width: 1, height: 0), at: 0.1)
        var time: TimeInterval = 0.1
        while time < 2 {
            _ = animator.pose(at: time)
            time += 1.0 / 30
        }
        let pose = animator.pose(at: 2)
        #expect(pose.gaze.width > 0.6)
    }

    @Test func `same seed produces identical behavior`() {
        let first = self.makeAnimator(seed: 42)
        let second = self.makeAnimator(seed: 42)
        var time: TimeInterval = 0
        while time < 10 {
            #expect(first.pose(at: time) == second.pose(at: time))
            time += 1.0 / 30
        }
    }

    @Test func `static poses carry the mood signature`() {
        let sad = OpenClawMascotPose.staticPose(for: .sad)
        #expect(sad.antennaDroop > 0)
        #expect(sad.mouthCurve < 0)
        let celebrating = OpenClawMascotPose.staticPose(for: .celebrating)
        #expect(celebrating.leftClawDegrees > 0)
        #expect(celebrating.mouthCurve > 0)
        let idle = OpenClawMascotPose.staticPose(for: .idle)
        #expect(idle == OpenClawMascotPose())
        let working = OpenClawMascotPose.staticPose(for: .working)
        #expect(working.hardHat == 1)
        #expect(working.rightClawDegrees < 0)
    }

    @Test func `clamp channels bounds every channel`() {
        var pose = OpenClawMascotPose()
        pose.floatOffset = -100
        pose.bodyStretch = 3
        pose.bodyTilt = -90
        pose.leftClawDegrees = 400
        pose.hardHat = 4
        pose.accessoryAmount = 4
        pose.gaze = CGSize(width: 9, height: -9)
        pose.clampChannels()
        #expect(pose.floatOffset == -12)
        #expect(pose.bodyStretch == 1.05)
        #expect(pose.bodyTilt == -8)
        #expect(pose.leftClawDegrees == 45)
        #expect(pose.hardHat == 1)
        #expect(pose.accessoryAmount == 1)
        pose.accessoryAmount = -4
        pose.clampChannels()
        #expect(pose.accessoryAmount == 0)
        #expect(pose.gaze == CGSize(width: 1.2, height: -1.2))
    }
}
