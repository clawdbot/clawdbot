import Foundation
import SwabbleKit
import Testing
@testable import OpenClaw

@Suite("Voice Wake manager suppression", .serialized)
struct VoiceWakeManagerSuppressionTests {
    @Test
    @MainActor func `clearing Talk suppression restarts after pending start was canceled`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.statusText = "Paused"

        manager.setSuppressedByTalk(true)
        manager.setSuppressedByTalk(false)

        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
        #expect(manager.isListening == false)
    }

    @Test
    @MainActor func `clearing Talk suppression does not clobber voice note suppression`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.statusText = "Listening"

        manager.setSuppressedByVoiceNote(true)
        manager.setSuppressedByTalk(true)
        manager.setSuppressedByTalk(false)

        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Paused")
        #expect(manager.isListening == false)

        manager.setSuppressedByVoiceNote(false)
        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
    }

    @Test
    @MainActor func `enabling Voice Wake during push to talk remains suppressed`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.setSuppressedByPushToTalk(true)

        manager.setEnabled(true)
        await manager._test_waitForScheduledStart()

        #expect(manager.statusText == "Paused")
        #expect(manager.isListening == false)

        manager.setSuppressedByPushToTalk(false)
        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
    }

    @Test
    @MainActor func `Talk and push to talk suppression clear independently`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.statusText = "Listening"
        manager.setSuppressedByTalk(true)
        manager.setSuppressedByPushToTalk(true)

        manager.setSuppressedByTalk(false)
        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Paused")

        manager.setSuppressedByPushToTalk(false)
        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
    }

    @Test
    @MainActor func `auxiliary audio and background suppression clear independently`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.statusText = "Listening"
        manager.setSuppressedForAuxiliaryAudio(true)
        manager.setSuppressedForBackground(true)

        manager.setSuppressedForAuxiliaryAudio(false)
        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Paused")
        #expect(manager._test_isSuppressedForBackground())
        #expect(!manager._test_isSuppressedForAuxiliaryAudio())

        manager.setSuppressedForBackground(false)
        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
    }

    @Test
    @MainActor func `push to talk suppression rejects buffered Voice Wake results`() throws {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.triggerWords = ["openclaw"]
        manager.isEnabled = true
        manager.isListening = true
        let staleGeneration = manager._test_recognitionGeneration()

        manager.setSuppressedByPushToTalk(true)

        let transcript = "openclaw hello"
        let triggerRange = try #require(transcript.range(of: "openclaw"))
        let commandRange = try #require(transcript.range(of: "hello"))
        manager._test_handleRecognitionCallback(
            transcript: transcript,
            segments: [
                WakeWordSegment(text: "openclaw", start: 0, duration: 0.2, range: triggerRange),
                WakeWordSegment(text: "hello", start: 0.8, duration: 0.2, range: commandRange),
            ],
            errorText: nil,
            recognitionGeneration: staleGeneration)

        #expect(manager.lastTriggeredCommand == nil)
        #expect(manager.statusText == "Paused")
    }
}
