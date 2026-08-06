import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite("Chat message speech client")
struct ChatMessageSpeechClientTests {
    @Test func `requests tts speak and preserves playback metadata`() async throws {
        let expectedAudio = Data([1, 2, 3])
        var requestedMethod: String?
        var requestedParams: TtsSpeakParams?
        var requestedTimeout: Int?

        let clip = try await ChatMessageSpeechClient.synthesize(text: "Read this") {
            method,
            paramsJSON,
            timeoutSeconds in
            requestedMethod = method
            requestedTimeout = timeoutSeconds
            requestedParams = try JSONDecoder().decode(
                TtsSpeakParams.self,
                from: Data((paramsJSON ?? "").utf8))
            return try JSONEncoder().encode(TtsSpeakResult(
                audiobase64: expectedAudio.base64EncodedString(),
                provider: "openai",
                outputformat: "mp3",
                mimetype: "audio/mpeg",
                fileextension: ".mp3"))
        }

        #expect(requestedMethod == "tts.speak")
        #expect(requestedParams?.text == "Read this")
        #expect(requestedTimeout == 60)
        #expect(clip == OpenClawChatSpeechClip(
            data: expectedAudio,
            outputFormat: "mp3",
            mimeType: "audio/mpeg",
            fileExtension: ".mp3"))
    }
}
