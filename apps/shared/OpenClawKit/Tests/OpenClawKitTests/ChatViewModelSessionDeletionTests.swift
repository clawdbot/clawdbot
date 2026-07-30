import Foundation
import Testing
@testable import OpenClawChatUI

/// Minimal transport for delete-session flows; unrelated protocol methods keep
/// their throwing defaults.
private final class DeleteSessionTestTransport: @unchecked Sendable, OpenClawChatTransport {
    private let lock = NSLock()
    private var deletedKeysStorage: [String] = []
    private var historyRequestsStorage: [String] = []

    var deletedKeys: [String] {
        self.lock.withLock { self.deletedKeysStorage }
    }

    var historyRequests: [String] {
        self.lock.withLock { self.historyRequestsStorage }
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        self.lock.withLock { self.historyRequestsStorage.append(sessionKey) }
        let json = """
        {"sessionKey":"\(sessionKey)","sessionId":null,"messages":[],"thinkingLevel":"off"}
        """
        return try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: Data(json.utf8))
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        let json = """
        {"runId":"\(UUID().uuidString)","status":"ok"}
        """
        return try JSONDecoder().decode(OpenClawChatSendResponse.self, from: Data(json.utf8))
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }

    func deleteSession(key: String) async throws {
        self.lock.withLock { self.deletedKeysStorage.append(key) }
    }
}

@MainActor
struct ChatViewModelSessionDeletionTests {
    @Test func `deleting the active main session re-bootstraps in place`() async throws {
        let transport = DeleteSessionTestTransport()
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        vm.load()
        try await waitUntil("initial bootstrap history") {
            await MainActor.run { transport.historyRequests.contains("main") }
        }

        let historyCountBeforeDelete = transport.historyRequests.count
        vm.deleteSession("main")

        try await waitUntil("delete reaches transport") {
            await MainActor.run { transport.deletedKeys == ["main"] }
        }
        // The main key stays the address after deletion, so the view model
        // must re-bootstrap it rather than silently keeping dead state.
        try await waitUntil("post-delete re-bootstrap") {
            await MainActor.run { transport.historyRequests.count > historyCountBeforeDelete }
        }
        #expect(vm.sessionKey == "main")
    }

    @Test func `deleting the active non-main session switches to main`() async throws {
        let transport = DeleteSessionTestTransport()
        let vm = OpenClawChatViewModel(sessionKey: "scratch", transport: transport)
        vm.load()
        try await waitUntil("initial bootstrap history") {
            await MainActor.run { transport.historyRequests.contains("scratch") }
        }

        vm.deleteSession("scratch")

        try await waitUntil("delete reaches transport") {
            await MainActor.run { transport.deletedKeys == ["scratch"] }
        }
        try await waitUntil("fallback switch to main") {
            await MainActor.run { vm.sessionKey == "main" }
        }
    }

    @Test func `deleting the canonical selected global row treats its alias as active`() async throws {
        let transport = DeleteSessionTestTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "global",
            transport: transport,
            activeAgentId: "ops")
        vm.load()
        try await waitUntil("initial bootstrap history") {
            await MainActor.run { transport.historyRequests.contains("global") }
        }

        vm.deleteSession("agent:ops:global")

        try await waitUntil("delete reaches transport") {
            await MainActor.run { transport.deletedKeys == ["agent:ops:global"] }
        }
        try await waitUntil("alias fallback switch to main") {
            await MainActor.run { vm.sessionKey == "main" }
        }
    }

    @Test func `deleting an inactive session keeps the active one`() async throws {
        let transport = DeleteSessionTestTransport()
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        vm.load()
        try await waitUntil("initial bootstrap history") {
            await MainActor.run { transport.historyRequests.contains("main") }
        }

        vm.deleteSession("scratch")

        try await waitUntil("delete reaches transport") {
            await MainActor.run { transport.deletedKeys == ["scratch"] }
        }
        #expect(vm.sessionKey == "main")
    }
}
