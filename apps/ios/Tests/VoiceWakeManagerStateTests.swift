import Foundation
import SwabbleKit
import Testing
@testable import Moltbot

@Suite(.serialized) struct VoiceWakeManagerStateTests {
    @Test @MainActor func suspendAndResumeCycleUpdatesState() async {
        let manager = VoiceWakeManager()
        manager.isEnabled = true
        manager.isListening = true
        manager.statusText = "Listening"

        let suspended = manager.suspendForExternalAudioCapture()
        #expect(suspended == true)
        #expect(manager.isListening == false)
        #expect(manager.statusText == "Paused")

        manager.resumeAfterExternalAudioCapture(wasSuspended: true)
        try? await Task.sleep(nanoseconds: 900_000_000)
        #expect(manager.statusText.contains("Voice Wake") == true)
    }

    @Test @MainActor func handleRecognitionCallbackRestartsOnError() async {
        let manager = VoiceWakeManager()
        manager.isEnabled = true
        manager.isListening = true

        manager._test_handleRecognitionCallback(transcript: nil, segments: [], errorText: "boom")
        #expect(manager.statusText.contains("Recognizer error") == true)
        #expect(manager.isListening == false)

        try? await Task.sleep(nanoseconds: 900_000_000)
        #expect(manager.statusText.contains("Voice Wake") == true)
    }

    @Test @MainActor func handleRecognitionCallbackDispatchesCommand() async {
        let manager = VoiceWakeManager()
        manager.triggerWords = ["clawd"]
        manager.isEnabled = true

        actor CaptureBox {
            var value: String?
            func set(_ next: String) { self.value = next }
        }
        let capture = CaptureBox()
        manager.configure { cmd in
            await capture.set(cmd)
        }

        let transcript = "clawd hello"
        let clawdRange = transcript.range(of: "clawd")!
        let helloRange = transcript.range(of: "hello")!
        let segments = [
            WakeWordSegment(text: "clawd", start: 0.0, duration: 0.2, range: clawdRange),
            WakeWordSegment(text: "hello", start: 0.8, duration: 0.2, range: helloRange),
        ]

        manager._test_handleRecognitionCallback(transcript: transcript, segments: segments, errorText: nil)
        #expect(manager.lastTriggeredCommand == "hello")
        #expect(manager.statusText == "Triggered")

        try? await Task.sleep(nanoseconds: 300_000_000)
        #expect(await capture.value == "hello")
    }
}
