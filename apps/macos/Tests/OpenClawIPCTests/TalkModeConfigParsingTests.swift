import OpenClawProtocol
import Testing
@testable import OpenClaw

struct TalkModeConfigParsingTests {
    @Test func `rejects normalized talk provider payload without resolved`() {
        let talk: [String: AnyCodable] = [
            "provider": AnyCodable("elevenlabs"),
            "providers": AnyCodable([
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ]),
            "voiceId": AnyCodable("voice-legacy"),
        ]

        let selection = TalkModeRuntime.selectTalkProviderConfig(talk)
        #expect(selection == nil)
    }

    @Test func `falls back to legacy talk fields when normalized payload missing`() {
        let talk: [String: AnyCodable] = [
            "voiceId": AnyCodable("voice-legacy"),
            "apiKey": AnyCodable("legacy-key"),
        ]

        let selection = TalkModeRuntime.selectTalkProviderConfig(talk)
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.normalizedPayload == false)
        #expect(selection?.config["voiceId"]?.stringValue == "voice-legacy")
        #expect(selection?.config["apiKey"]?.stringValue == "legacy-key")
    }

    @Test func `reads configured silence timeout ms`() {
        let talk: [String: AnyCodable] = [
            "silenceTimeoutMs": AnyCodable(1500),
        ]

        #expect(TalkModeRuntime.resolvedSilenceTimeoutMs(talk) == 1500)
    }

    @Test func `defaults silence timeout ms when missing`() {
        #expect(TalkModeRuntime.resolvedSilenceTimeoutMs(nil) == TalkDefaults.silenceTimeoutMs)
    }

    @Test func `defaults silence timeout ms when invalid`() {
        let talk: [String: AnyCodable] = [
            "silenceTimeoutMs": AnyCodable(0),
        ]

        #expect(TalkModeRuntime.resolvedSilenceTimeoutMs(talk) == TalkDefaults.silenceTimeoutMs)
    }
}
