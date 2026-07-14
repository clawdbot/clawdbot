import OpenClawKit
import Testing
@testable import OpenClaw

struct GatewayStatusBuilderTests {
    @Test func `paused problem keeps error status`() {
        let state = GatewayStatusBuilder.build(
            gatewayServerName: nil,
            lastGatewayProblem: GatewayConnectionProblem(
                kind: .pairingRequired,
                owner: .gateway,
                title: "Pairing required",
                message: "Approve this device before reconnecting.",
                requestId: "req-123",
                retryable: false,
                pauseReconnect: true),
            gatewayStatusText: "Reconnecting…")

        #expect(state == .error)
    }

    @Test func `transient problem keeps error status while reconnecting`() {
        let state = GatewayStatusBuilder.build(
            gatewayServerName: nil,
            lastGatewayProblem: GatewayConnectionProblem(
                kind: .timeout,
                owner: .network,
                title: "Connection timed out",
                message: "The gateway did not respond before the connection timed out.",
                retryable: true,
                pauseReconnect: false),
            gatewayStatusText: "Reconnecting…")

        #expect(state == .error)
    }

    @Test func `chat gateway pill labels match display state`() {
        #expect(ChatProTab.gatewayPillTitle(state: .disconnected, isGatewayUsable: false) == "Offline")
        #expect(ChatProTab.gatewayPillTitle(state: .connecting, isGatewayUsable: false) == "Connecting")
        #expect(ChatProTab.gatewayPillTitle(state: .error, isGatewayUsable: false) == "Attention")
        #expect(ChatProTab.gatewayPillTitle(state: .connected, isGatewayUsable: true) == "Connected")
        #expect(ChatProTab.gatewayPillTitle(state: .connected, isGatewayUsable: false) == "Unavailable")
    }

    @Test func `chat agent badge rejects placeholder question mark`() {
        #expect(ChatProTab.normalizedBadgeEmoji(" 🦞 ") == "🦞")
        #expect(ChatProTab.normalizedBadgeEmoji("?") == nil)
        #expect(ChatProTab.normalizedBadgeEmoji("   ") == nil)
        #expect(ChatProTab.normalizedBadgeEmoji(nil) == nil)
        #expect(ChatProTab.initialsBadge(for: "Agent Smith") == "AS")
    }

    @Test func `pinned attachment displays its captured gateway owner`() {
        #expect(ChatProTab.presentationGatewayState(
            current: .connected,
            isAttachmentOwnerPinned: true,
            capturedOwnerID: "gateway-a",
            currentOwnerID: "gateway-b") == .disconnected)
        #expect(ChatProTab.presentationGatewayState(
            current: .connected,
            isAttachmentOwnerPinned: true,
            capturedOwnerID: "gateway-a",
            currentOwnerID: "gateway-a") == .connected)
        #expect(ChatProTab.presentationGatewayState(
            current: .connected,
            isAttachmentOwnerPinned: false,
            capturedOwnerID: "gateway-a",
            currentOwnerID: "gateway-b") == .connected)
    }

    @Test func `chat starter prompts stay stable and actionable`() {
        #expect(ChatProTab.emptyAssistantPrompts.map(\.id) == ["summarize-status", "show-controls", "start-voice"])
        #expect(ChatProTab.emptyAssistantPrompts.allSatisfy { !$0.title.isEmpty && !$0.prompt.isEmpty })
    }
}
