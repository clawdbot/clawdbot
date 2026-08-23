import OpenClawKit
import Testing
@testable import OpenClaw

struct DeepLinkAgentPolicyTests {
    @Test func `validate message for handle rejects too long when unkeyed`() {
        let msg = String(repeating: "a", count: DeepLinkAgentPolicy.maxUnkeyedConfirmChars + 1)
        let res = DeepLinkAgentPolicy.validateMessageForHandle(message: msg, allowUnattended: false)
        switch res {
        case let .failure(error):
            #expect(
                error == .messageTooLongForConfirmation(
                    max: DeepLinkAgentPolicy.maxUnkeyedConfirmChars,
                    actual: DeepLinkAgentPolicy.maxUnkeyedConfirmChars + 1))
        case .success:
            Issue.record("expected failure, got success")
        }
    }

    @Test func `validate message for handle allows too long when keyed`() {
        let msg = String(repeating: "a", count: DeepLinkAgentPolicy.maxUnkeyedConfirmChars + 1)
        let res = DeepLinkAgentPolicy.validateMessageForHandle(message: msg, allowUnattended: true)
        switch res {
        case .success:
            break
        case let .failure(error):
            Issue.record("expected success, got failure: \(error)")
        }
    }

    @Test func `effective delivery ignores delivery fields when unkeyed`() {
        let link = AgentDeepLink(
            message: "Hello",
            sessionKey: "s",
            thinking: "low",
            deliver: true,
            to: "+15551234567",
            channel: "whatsapp",
            timeoutSeconds: 10,
            key: nil)
        let res = DeepLinkAgentPolicy.effectiveDelivery(link: link, allowUnattended: false)
        #expect(res.deliver == false)
        #expect(res.to == nil)
        #expect(res.channel == .last)
    }

    @Test func `effective delivery honors deliver for deliverable channels when keyed`() {
        let link = AgentDeepLink(
            message: "Hello",
            sessionKey: "s",
            thinking: "low",
            deliver: true,
            to: "  +15551234567 ",
            channel: "whatsapp",
            timeoutSeconds: 10,
            key: "secret")
        let res = DeepLinkAgentPolicy.effectiveDelivery(link: link, allowUnattended: true)
        #expect(res.deliver == true)
        #expect(res.to == "+15551234567")
        #expect(res.channel == .whatsapp)
    }

    @Test func `effective delivery still blocks web chat delivery when keyed`() {
        let link = AgentDeepLink(
            message: "Hello",
            sessionKey: "s",
            thinking: "low",
            deliver: true,
            to: "+15551234567",
            channel: "webchat",
            timeoutSeconds: 10,
            key: "secret")
        let res = DeepLinkAgentPolicy.effectiveDelivery(link: link, allowUnattended: true)
        #expect(res.deliver == false)
        #expect(res.channel == .webchat)
    }
}
