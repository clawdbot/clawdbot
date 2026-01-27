import Testing
@testable import Moltbot

@Suite(.serialized) struct VoiceWakeForwarderTests {
    @Test func prefixedTranscriptUsesMachineName() {
        let transcript = "hello world"
        let prefixed = VoiceWakeForwarder.prefixedTranscript(transcript, machineName: "My-Mac")

        #expect(prefixed.starts(with: "User talked via voice recognition on"))
        #expect(prefixed.contains("My-Mac"))
        #expect(prefixed.hasSuffix("\n\nhello world"))
    }

    @Test func forwardOptionsDefaults() {
        let opts = VoiceWakeForwarder.ForwardOptions()
        #expect(opts.sessionKey == "main")
        #expect(opts.thinking == "low")
        #expect(opts.deliver == true)
        #expect(opts.to == nil)
        #expect(opts.channel == .last)
    }
}
