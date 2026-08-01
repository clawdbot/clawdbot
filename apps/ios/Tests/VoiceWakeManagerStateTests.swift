import Foundation
import SwabbleKit
import Testing
@testable import OpenClaw

private actor VoiceWakeCommandBarrier {
    private var entered = false
    private var enteredWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    private(set) var observedCancellation: Bool?

    func suspend() async {
        self.entered = true
        for waiter in self.enteredWaiters {
            waiter.resume()
        }
        self.enteredWaiters.removeAll()
        await withCheckedContinuation { continuation in
            self.releaseContinuation = continuation
        }
        self.observedCancellation = Task.isCancelled
    }

    func waitUntilEntered() async {
        if self.entered {
            return
        }
        await withCheckedContinuation { continuation in
            self.enteredWaiters.append(continuation)
        }
    }

    func release() {
        self.releaseContinuation?.resume()
        self.releaseContinuation = nil
    }
}

@Suite(.serialized) struct VoiceWakeManagerStateTests {
    @Test @MainActor func `handle recognition callback restarts on error`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.isListening = true
        let recognitionGeneration = manager._test_recognitionGeneration()

        manager._test_handleRecognitionCallback(transcript: nil, segments: [], errorText: "boom")
        #expect(manager.statusText.contains("Recognizer error") == true)
        #expect(manager.isListening == false)
        #expect(manager._test_recognitionGeneration() > recognitionGeneration)

        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
    }

    @Test @MainActor func `handle recognition callback dispatches command`() async throws {
        let manager = VoiceWakeManager()
        manager.triggerWords = ["openclaw"]
        manager.isEnabled = true

        actor CaptureBox {
            var value: String?
            func set(_ next: String) {
                self.value = next
            }
        }
        let capture = CaptureBox()
        manager.configure { cmd in
            await capture.set(cmd)
        }

        let transcript = "openclaw hello"
        let triggerRange = try #require(transcript.range(of: "openclaw"))
        let helloRange = try #require(transcript.range(of: "hello"))
        let segments = [
            WakeWordSegment(text: "openclaw", start: 0.0, duration: 0.2, range: triggerRange),
            WakeWordSegment(text: "hello", start: 0.8, duration: 0.2, range: helloRange),
        ]

        manager._test_handleRecognitionCallback(transcript: transcript, segments: segments, errorText: nil)
        #expect(manager.lastTriggeredCommand == "hello")
        #expect(manager.statusText == "Triggered")

        try? await Task.sleep(nanoseconds: 300_000_000)
        #expect(await capture.value == "hello")
    }

    @Test @MainActor func `suppression cancels an admitted command before dispatch`() async throws {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        let barrier = VoiceWakeCommandBarrier()
        actor CaptureBox {
            var value: String?
            func set(_ next: String) {
                self.value = next
            }
        }
        let capture = CaptureBox()
        manager.triggerWords = ["openclaw"]
        manager.isEnabled = true
        manager.isListening = true
        manager.configure { command in
            await barrier.suspend()
            guard !Task.isCancelled else { return }
            await capture.set(command)
        }

        let transcript = "openclaw hello"
        let triggerRange = try #require(transcript.range(of: "openclaw"))
        let commandRange = try #require(transcript.range(of: "hello"))
        manager._test_handleRecognitionCallback(
            transcript: transcript,
            segments: [
                WakeWordSegment(text: "openclaw", start: 0, duration: 0.2, range: triggerRange),
                WakeWordSegment(text: "hello", start: 0.8, duration: 0.2, range: commandRange),
            ],
            errorText: nil)
        await barrier.waitUntilEntered()

        manager.setSuppressedByPushToTalk(true)
        await barrier.release()
        for _ in 0..<100 {
            if await barrier.observedCancellation != nil {
                break
            }
            await Task.yield()
        }

        #expect(await barrier.observedCancellation == true)
        #expect(await capture.value == nil)
    }

    @Test @MainActor func `Voice Wake deactivates only its owned audio session`() {
        var deactivationCount = 0
        let manager = VoiceWakeManager._test_withoutRestartDelays {
            deactivationCount += 1
        }

        manager.stop()
        #expect(deactivationCount == 0)

        manager._test_setAudioSessionIsActive(true)
        manager.stop()
        manager.stop()
        #expect(deactivationCount == 1)
    }
}
