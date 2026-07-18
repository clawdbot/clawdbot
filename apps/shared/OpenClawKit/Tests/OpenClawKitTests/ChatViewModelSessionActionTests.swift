import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private actor SessionActionTransportState {
    var forkedParentKeys: [String] = []

    func recordFork(_ key: String) {
        self.forkedParentKeys.append(key)
    }
}

private final class SessionActionTransport: @unchecked Sendable, OpenClawChatTransport {
    private let state = SessionActionTransportState()
    private let forkDelay: Duration?

    init(forkDelay: Duration? = nil) {
        self.forkDelay = forkDelay
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "session-\(sessionKey)",
            messages: [],
            thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw NSError(domain: "SessionActionTransport", code: 1)
    }

    func forkSession(parentKey: String) async throws -> String {
        await self.state.recordFork(parentKey)
        if let forkDelay {
            try await Task.sleep(for: forkDelay)
        }
        return "forked"
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }

    func forkedParentKeys() async -> [String] {
        await self.state.forkedParentKeys
    }
}

@MainActor
struct ChatViewModelSessionActionTests {
    @Test func `fork does not mutate gateway while session switching is blocked`() async {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.attachments = [OpenClawPendingAttachment(
            url: nil,
            data: Data([1]),
            fileName: "draft.png",
            mimeType: "image/png",
            preview: nil)]

        await viewModel.forkSession(key: "main")

        let forkedKeys = await transport.forkedParentKeys()
        #expect(forkedKeys.isEmpty)
        #expect(viewModel.sessionKey == "main")
        #expect(viewModel.errorText == String(
            localized: "Remove attachments or wait for delivery to resolve before starting a new chat."))
    }

    @Test func `fork completion does not override newer navigation`() async throws {
        let transport = SessionActionTransport(forkDelay: .milliseconds(50))
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)

        let fork = Task { await viewModel.forkSession(key: "main") }
        try await self.waitUntil { await transport.forkedParentKeys() == ["main"] }
        viewModel.switchSession(to: "other")
        await fork.value

        #expect(viewModel.sessionKey == "other")
    }

    private func waitUntil(
        timeout: Duration = .seconds(2),
        condition: @escaping @MainActor () async -> Bool) async throws
    {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("timed out waiting for session action condition")
    }
}
