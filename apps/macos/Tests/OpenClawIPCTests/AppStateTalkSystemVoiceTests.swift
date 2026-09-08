import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct AppStateTalkSystemVoiceTests {
    @Test func `changing recognition locale clears a voice selection that no longer exists`() {
        let state = AppState(preview: true)
        state.talkSystemVoiceID = "com.apple.voice.deleted.test-voice"

        state.voiceWakeLocaleID = "fr-FR"

        #expect(state.talkSystemVoiceID.isEmpty)
    }

    @Test func `changing recognition locale preserves an already-empty selection`() {
        let state = AppState(preview: true)
        state.talkSystemVoiceID = ""

        state.voiceWakeLocaleID = "fr-FR"

        #expect(state.talkSystemVoiceID.isEmpty)
    }
}
