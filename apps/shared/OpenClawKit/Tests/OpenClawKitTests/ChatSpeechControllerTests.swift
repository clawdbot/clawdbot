import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
private final class GatedClipPlayer: ChatSpeechClipPlaying {
    var playedClips: [OpenClawChatSpeechClip] = []
    var stopCount = 0
    private var pending: CheckedContinuation<Bool, Never>?

    func play(clip: OpenClawChatSpeechClip) async -> Bool {
        self.playedClips.append(clip)
        return await withCheckedContinuation { continuation in
            self.pending = continuation
        }
    }

    func stop() {
        self.stopCount += 1
        self.resolve(false)
    }

    func resolve(_ finished: Bool) {
        let pending = self.pending
        self.pending = nil
        pending?.resume(returning: finished)
    }
}

@MainActor
private final class RecordingLocalSpeaker: ChatSpeechLocalSpeaking {
    var spokenTexts: [String] = []
    var stopCount = 0

    func speak(text: String) async -> Bool {
        self.spokenTexts.append(text)
        return true
    }

    func stop() {
        self.stopCount += 1
    }
}

@MainActor
private struct SpeechHarness {
    let controller: OpenClawChatSpeechController
    let clipPlayer: GatedClipPlayer
    let localSpeaker: RecordingLocalSpeaker

    init(synthesize: @escaping OpenClawChatSpeechSynthesis) {
        let clipPlayer = GatedClipPlayer()
        let localSpeaker = RecordingLocalSpeaker()
        self.clipPlayer = clipPlayer
        self.localSpeaker = localSpeaker
        self.controller = OpenClawChatSpeechController(
            synthesize: synthesize,
            clipPlayer: clipPlayer,
            localSpeech: localSpeaker)
    }
}

/// Polls until the controller reaches the expected phase; playback hops
/// through an unstructured task, so tests must yield to it.
@MainActor
private func waitForPhase(
    _ controller: OpenClawChatSpeechController,
    _ expected: OpenClawChatSpeechController.Phase) async -> Bool
{
    for _ in 0..<200 {
        if controller.phase == expected { return true }
        await Task.yield()
    }
    return controller.phase == expected
}

@MainActor
@Suite("OpenClawChatSpeechController")
struct ChatSpeechControllerTests {
    @Test func `plays gateway clip and returns to idle`() async {
        let clip = OpenClawChatSpeechClip(
            data: Data([9, 9, 9]),
            outputFormat: "mp3",
            mimeType: "audio/mpeg",
            fileExtension: ".mp3")
        let harness = SpeechHarness { _ in clip }
        let messageID = UUID()

        harness.controller.toggle(messageID: messageID, text: "Hello there.")
        #expect(harness.controller.phase == .preparing(messageID))
        #expect(await waitForPhase(harness.controller, .speaking(messageID)))
        #expect(harness.clipPlayer.playedClips == [clip])

        harness.clipPlayer.resolve(true)
        #expect(await waitForPhase(harness.controller, .idle))
        #expect(harness.localSpeaker.spokenTexts.isEmpty)
    }

    @Test func `falls back to local speech when synthesis fails`() async {
        struct SynthesisFailed: Error {}
        let harness = SpeechHarness { _ in throw SynthesisFailed() }
        let messageID = UUID()

        harness.controller.toggle(messageID: messageID, text: "Read me aloud")
        #expect(await waitForPhase(harness.controller, .idle))
        #expect(harness.localSpeaker.spokenTexts == ["Read me aloud"])
        #expect(harness.clipPlayer.playedClips.isEmpty)
    }

    @Test func `falls back to local speech when clip is unplayable`() async {
        let clip = OpenClawChatSpeechClip(data: Data([1]), mimeType: nil)
        let harness = SpeechHarness { _ in clip }
        let messageID = UUID()

        harness.controller.toggle(messageID: messageID, text: "Broken clip")
        #expect(await waitForPhase(harness.controller, .speaking(messageID)))

        // Unplayable clip resolves false without a user stop.
        harness.clipPlayer.resolve(false)
        #expect(await waitForPhase(harness.controller, .idle))
        #expect(harness.localSpeaker.spokenTexts == ["Broken clip"])
    }

    @Test func `toggle while active stops without fallback`() async {
        let clip = OpenClawChatSpeechClip(data: Data([5]), mimeType: nil)
        let harness = SpeechHarness { _ in clip }
        let messageID = UUID()

        harness.controller.toggle(messageID: messageID, text: "Long reply")
        #expect(await waitForPhase(harness.controller, .speaking(messageID)))

        harness.controller.toggle(messageID: messageID, text: "Long reply")
        #expect(harness.controller.phase == .idle)
        #expect(harness.clipPlayer.stopCount > 0)
        // The interrupted clip resolves false, but the bumped generation must
        // keep the stop from cascading into the on-device voice.
        for _ in 0..<50 {
            await Task.yield()
        }
        #expect(harness.localSpeaker.spokenTexts.isEmpty)
    }

    @Test func `starting another message supersedes the first`() async {
        let clip = OpenClawChatSpeechClip(data: Data([7]), mimeType: nil)
        let harness = SpeechHarness { _ in clip }
        let first = UUID()
        let second = UUID()

        harness.controller.toggle(messageID: first, text: "First message")
        #expect(await waitForPhase(harness.controller, .speaking(first)))

        harness.controller.toggle(messageID: second, text: "Second message")
        #expect(await waitForPhase(harness.controller, .speaking(second)))
        #expect(harness.controller.isActive(second))
        #expect(!harness.controller.isActive(first))

        harness.clipPlayer.resolve(true)
        #expect(await waitForPhase(harness.controller, .idle))
    }

    @Test func `blank text stays idle`() async {
        let harness = SpeechHarness { _ in
            OpenClawChatSpeechClip(data: Data([1]), mimeType: nil)
        }

        harness.controller.toggle(messageID: UUID(), text: "   \n  ")
        #expect(harness.controller.phase == .idle)
        for _ in 0..<50 {
            await Task.yield()
        }
        #expect(harness.clipPlayer.playedClips.isEmpty)
        #expect(harness.localSpeaker.spokenTexts.isEmpty)
    }

    @Test func `identifies container hints and headerless formats`() {
        let mp3 = OpenClawChatSpeechClip(
            data: Data([1]),
            outputFormat: "mp3",
            mimeType: "audio/mpeg",
            fileExtension: ".mp3")
        let pcm = OpenClawChatSpeechClip(
            data: Data([1]),
            outputFormat: "pcm",
            mimeType: "audio/pcm",
            fileExtension: ".pcm")
        let azureRaw = OpenClawChatSpeechClip(
            data: Data([1]),
            outputFormat: "raw-8khz-8bit-mono-mulaw",
            fileExtension: ".pcm")
        let sampledPCM = OpenClawChatSpeechClip(
            data: Data([1]),
            outputFormat: "pcm_24000",
            fileExtension: ".pcm")
        let rawULaw = OpenClawChatSpeechClip(
            data: Data([1]),
            outputFormat: "ulaw_8000")

        #expect(!mp3.isHeaderlessAudio)
        #expect(mp3.fileTypeHint != nil)
        #expect(pcm.isHeaderlessAudio)
        #expect(azureRaw.isHeaderlessAudio)
        #expect(sampledPCM.isHeaderlessAudio)
        #expect(rawULaw.isHeaderlessAudio)
    }
}
