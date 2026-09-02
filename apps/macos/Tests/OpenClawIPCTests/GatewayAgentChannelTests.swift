import Testing
@testable import OpenClaw

struct GatewayAgentChannelTests {
    @Test func `should deliver blocks web chat`() {
        #expect(GatewayAgentChannel.webchat.shouldDeliver(true) == false)
        #expect(GatewayAgentChannel.webchat.shouldDeliver(false) == false)
    }

    @Test func `should deliver allows last and provider channels`() {
        #expect(GatewayAgentChannel.last.shouldDeliver(true) == true)
        #expect(GatewayAgentChannel.whatsapp.shouldDeliver(true) == true)
        #expect(GatewayAgentChannel.telegram.shouldDeliver(true) == true)
        #expect(GatewayAgentChannel.googlechat.shouldDeliver(true) == true)
        #expect(GatewayAgentChannel.imessage.shouldDeliver(true) == true)
        #expect(GatewayAgentChannel.last.shouldDeliver(false) == false)
    }

    @Test func `init raw normalizes and falls back to last`() {
        #expect(GatewayAgentChannel(raw: nil) == .last)
        #expect(GatewayAgentChannel(raw: "  ") == .last)
        #expect(GatewayAgentChannel(raw: "WEBCHAT") == .webchat)
        #expect(GatewayAgentChannel(raw: "googlechat") == .googlechat)
        #expect(GatewayAgentChannel(raw: "IMESSAGE") == .imessage)
        #expect(GatewayAgentChannel(raw: "unknown") == .last)
    }
}
