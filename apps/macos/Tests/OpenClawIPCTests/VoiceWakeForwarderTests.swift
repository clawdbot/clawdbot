import Testing
@testable import OpenClaw

@Suite(.serialized) struct VoiceWakeForwarderTests {
    @Test func `prefixed transcript uses machine name`() {
        let transcript = "hello world"
        let prefixed = VoiceWakeForwarder.prefixedTranscript(transcript, machineName: "My-Mac")

        #expect(prefixed.starts(with: "User talked via voice recognition on"))
        #expect(prefixed.contains("My-Mac"))
        #expect(prefixed.hasSuffix("\n\nhello world"))
    }

    @Test func `forward options defaults`() {
        let opts = VoiceWakeForwarder.ForwardOptions()
        #expect(opts.sessionKey == "main")
        #expect(opts.thinking == "low")
        #expect(opts.deliver == true)
        #expect(opts.to == nil)
        #expect(opts.channel == .webchat)
        #expect(opts.channel.shouldDeliver(opts.deliver) == false)
    }

    @Test func `selected forward options use session delivery context`() {
        let entry = VoiceWakeForwarder.SessionRouteEntry(
            key: "agent:main:telegram:group:6812765697",
            channel: "telegram",
            lastChannel: "telegram",
            lastTo: "telegram:6812765697",
            deliveryContext: .init(channel: "telegram", to: "telegram:6812765697"))

        let opts = VoiceWakeForwarder.forwardOptions(
            sessionKey: entry.key,
            routeEntry: entry,
            voiceWakeTrigger: "open claw")

        #expect(opts.sessionKey == "agent:main:telegram:group:6812765697")
        #expect(opts.channel == .telegram)
        #expect(opts.to == "telegram:6812765697")
        #expect(opts.voiceWakeTrigger == "open claw")
        #expect(opts.channel.shouldDeliver(opts.deliver) == true)
    }

    @Test func `selected forward options parse channel scoped session fallback`() {
        let opts = VoiceWakeForwarder.forwardOptions(
            sessionKey: "agent:main:discord:channel:123:456",
            routeEntry: nil)

        #expect(opts.channel == .discord)
        #expect(opts.to == "123:456")
        #expect(opts.channel.shouldDeliver(opts.deliver) == true)
    }

    @Test func `selected forward options keep internal sessions on webchat`() {
        let opts = VoiceWakeForwarder.forwardOptions(
            sessionKey: "agent:main:work",
            routeEntry: nil)

        #expect(opts.channel == .webchat)
        #expect(opts.to == nil)
        #expect(opts.channel.shouldDeliver(opts.deliver) == false)
    }
}
