import Speech
import Testing
@testable import OpenClaw

struct SpeechRecognitionRequestPolicyTests {
    @Test func `passive Voice Wake requires on device recognition`() throws {
        let request = SFSpeechAudioBufferRecognitionRequest()

        try SpeechRecognitionRequestPolicy.configurePassiveVoiceWake(
            request,
            supportsOnDeviceRecognition: true)

        #expect(request.shouldReportPartialResults)
        #expect(request.taskHint == .dictation)
        #expect(request.requiresOnDeviceRecognition)
    }

    @Test func `passive Voice Wake rejects unsupported locales`() {
        let request = SFSpeechAudioBufferRecognitionRequest()

        #expect(throws: SpeechRecognitionRequestPolicy.PolicyError.onDeviceRecognitionUnavailable) {
            try SpeechRecognitionRequestPolicy.configurePassiveVoiceWake(
                request,
                supportsOnDeviceRecognition: false)
        }
    }

    @Test func `interactive transcription permits Apple Speech services`() {
        let request = SFSpeechAudioBufferRecognitionRequest()

        SpeechRecognitionRequestPolicy.configureInteractiveTranscription(request)

        #expect(request.shouldReportPartialResults)
        #expect(request.taskHint == .dictation)
        #expect(!request.requiresOnDeviceRecognition)
    }
}
