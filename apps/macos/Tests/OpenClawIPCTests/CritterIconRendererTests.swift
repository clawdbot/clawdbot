import AppKit
import Testing
@testable import OpenClaw

@MainActor
struct CritterIconRendererTests {
    @Test func `make icon renders expected size`() {
        let image = CritterIconRenderer.makeIcon(
            blink: 0.25,
            legWiggle: 0.5,
            earWiggle: 0.2,
            earScale: 1,
            badge: nil)

        #expect(image.size.width == 18)
        #expect(image.size.height == 18)
        #expect(image.tiffRepresentation != nil)
    }

    @Test func `make icon renders with badge`() {
        let image = CritterIconRenderer.makeIcon(
            blink: 0,
            legWiggle: 0,
            earWiggle: 0,
            earScale: 1,
            badge: .init(symbolName: "terminal.fill", prominence: .primary))

        #expect(image.tiffRepresentation != nil)
    }

    @Test func `make icon renders expressive states`() {
        let sleeping = CritterIconRenderer.makeIcon(
            blink: 1,
            antennaDroop: 1,
            eyesClosedLines: true)
        let celebrating = CritterIconRenderer.makeIcon(blink: 0, happyEyes: true)

        #expect(sleeping.tiffRepresentation != nil)
        #expect(celebrating.tiffRepresentation != nil)
    }

    @Test func `critter status label exercises helpers`() async {
        await CritterStatusLabel.exerciseForTesting()
    }

    @Test func `idle critter sleeps until its next animation`() {
        let now = Date(timeIntervalSinceReferenceDate: 100)
        let delay = CritterStatusLabel.nextAnimationTickDelay(
            now: now,
            isWorking: false,
            deadlines: [
                now.addingTimeInterval(8),
                now.addingTimeInterval(5),
                now.addingTimeInterval(11),
                now.addingTimeInterval(7),
            ])

        #expect(delay == 5)
    }

    @Test func `working critter keeps its animation cadence`() {
        let now = Date(timeIntervalSinceReferenceDate: 100)
        let delay = CritterStatusLabel.nextAnimationTickDelay(
            now: now,
            isWorking: true,
            deadlines: [now.addingTimeInterval(8)])

        #expect(delay == 0.35)
    }
}
