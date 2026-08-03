import Testing
@testable import OpenClaw

@MainActor
@Suite struct TalkModeIncrementalSpeechBufferTests {
    @Test func emitsSoftBoundaryBeforeTerminalPunctuation() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager._test_incrementalReset()

        let partial =
            "We start speaking earlier by splitting this long stream chunk at a whitespace boundary before punctuation arrives"
        let segments = manager._test_incrementalIngest(partial, isFinal: false)

        #expect(segments.count == 1)
        #expect(segments[0].count >= 72)
        #expect(segments[0].count < partial.count)
    }

    @Test func keepsShortChunkBufferedWithoutPunctuation() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager._test_incrementalReset()

        let short = "short chunk without punctuation"
        let segments = manager._test_incrementalIngest(short, isFinal: false)

        #expect(segments.isEmpty)
    }
}
