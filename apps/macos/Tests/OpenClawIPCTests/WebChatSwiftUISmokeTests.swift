import AppKit
import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct WebChatSwiftUISmokeTests {
    private struct TestTransport: OpenClawChatTransport {
        func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
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

        func setActiveSessionKey(_: String) async throws {}
    }

    @Test func `window controller show and close`() {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            presentation: .window,
            transport: TestTransport())
        controller.show()
        controller.close()
    }

    @Test func `panel controller present and close`() {
        let anchor = { NSRect(x: 200, y: 400, width: 40, height: 40) }
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            presentation: .panel(anchorProvider: anchor),
            transport: TestTransport())
        controller.presentAnchored(anchorProvider: anchor)
        controller.close()
    }

    @Test func `max and Ultra thinking preferences survive reopen`() throws {
        let suiteName = "WebChatSwiftUISmokeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        for level in ["max", "ultra"] {
            defaults.set(level, forKey: "openclaw.webchat.thinkingLevel")
            #expect(WebChatSwiftUIWindowController.persistedThinkingLevel(defaults: defaults) == level)
        }
    }
}
