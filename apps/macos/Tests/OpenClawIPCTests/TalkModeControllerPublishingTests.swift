import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct TalkModeControllerPublishingTests {
    @Test func `controller publishes smoothed clamped level`() {
        let controller = TalkModeController()

        controller.updateLevel(2)
        let attackLevel = controller.level
        controller.updateLevel(0.2)
        let releaseLevel = controller.level
        controller.updateLevel(-1)

        #expect(attackLevel > 0 && attackLevel <= 1)
        #expect(releaseLevel > 0.2 && releaseLevel < attackLevel)
        #expect(controller.level == 0)
    }

    @Test func `controller publishes bounded finals and distinct partial`() {
        let controller = TalkModeController()
        controller.updatePartialTranscript("  speaking now  ")

        #expect(controller.partialTranscript == "speaking now")

        for index in 0..<25 {
            controller.commitTranscript("utterance \(index)")
        }

        #expect(controller.partialTranscript.isEmpty)
        #expect(controller.recentTranscripts.count == 20)
        #expect(controller.recentTranscripts.first == "utterance 5")
        #expect(controller.recentTranscripts.last == "utterance 24")
    }
}
