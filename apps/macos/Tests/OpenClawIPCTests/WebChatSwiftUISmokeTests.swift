import AppKit
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

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

    @Test func `response and thinking headings keep their semantic typography`() {
        #expect(ChatMarkdownRenderer.Typography.response.headingStyle == .hierarchy)
        #expect(ChatMarkdownRenderer.Typography.thinking.headingStyle == .prose)
    }

    @Test func `assistant segments select one complete markdown typography profile`() {
        let segments = AssistantTextParser.segments(
            from: "<think># Internal plan</think><final># Final answer</final>")

        #expect(segments.map(\.kind.markdownTypography) == [.thinking, .response])
    }

    @Test func `session observer remains visible until the last shared gateway window closes`() {
        var owners = WebChatSessionObserverVisibilityOwners()
        let firstConnection = NSObject()
        let secondConnection = NSObject()
        let firstWindow = NSObject()
        let secondWindow = NSObject()
        let independentWindow = NSObject()
        let sharedConnectionID = ObjectIdentifier(firstConnection)
        let independentConnectionID = ObjectIdentifier(secondConnection)

        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(firstWindow),
            connection: sharedConnectionID) == true)
        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(firstWindow),
            connection: sharedConnectionID) == nil)
        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(secondWindow),
            connection: sharedConnectionID) == nil)
        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(independentWindow),
            connection: independentConnectionID) == true)
        #expect(owners.setVisible(
            false,
            owner: ObjectIdentifier(firstWindow),
            connection: sharedConnectionID) == nil)
        #expect(owners.isVisible(connection: sharedConnectionID))
        #expect(owners.isVisible(connection: independentConnectionID))
        #expect(owners.setVisible(
            false,
            owner: ObjectIdentifier(secondWindow),
            connection: sharedConnectionID) == false)
        #expect(!owners.isVisible(connection: sharedConnectionID))
        #expect(owners.isVisible(connection: independentConnectionID))
        #expect(owners.setVisible(
            false,
            owner: ObjectIdentifier(secondWindow),
            connection: sharedConnectionID) == nil)
    }

    @Test func `reopening a gateway window restores visibility after the last owner closes`() {
        var owners = WebChatSessionObserverVisibilityOwners()
        let connection = NSObject()
        let closingWindow = NSObject()
        let reopeningWindow = NSObject()
        let connectionID = ObjectIdentifier(connection)

        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(closingWindow),
            connection: connectionID) == true)
        #expect(owners.setVisible(
            false,
            owner: ObjectIdentifier(closingWindow),
            connection: connectionID) == false)
        #expect(owners.setVisible(
            true,
            owner: ObjectIdentifier(reopeningWindow),
            connection: connectionID) == true)
        #expect(owners.isVisible(connection: connectionID))
        #expect(owners.setVisible(
            false,
            owner: ObjectIdentifier(closingWindow),
            connection: connectionID) == nil)
        #expect(owners.isVisible(connection: connectionID))
    }

    @Test func `window controller merges titlebar and keeps toolbar controls`() throws {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            transport: TestTransport(),
            windowTitle: "Studio — OpenClaw")
        let window = try #require(controller._testWindow)

        #expect(window.styleMask.contains(.fullSizeContentView))
        #expect(window.titleVisibility == .hidden)
        #expect(window.titlebarAppearsTransparent)
        #expect(window.toolbarStyle == .unified)
        #expect(window.titlebarSeparatorStyle == .none)
        #expect(window.isMovableByWindowBackground)
        #expect(window.isRestorable == false)
        #expect(window.title == "Studio — OpenClaw")
        window.title = "main"
        #expect(window.title == "Studio — OpenClaw")
        #expect(controller._testSceneBridgingOptions?.contains(.toolbars) == true)
        #expect(controller._testSceneBridgingOptions?.contains(.title) == false)

        controller.show()
        #expect(window.titleVisibility == .hidden)
        #expect(window.toolbar != nil)
        controller.close()
    }

    @Test func `closing a full window releases it and notifies its owner once`() {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            transport: TestTransport())
        var closeCount = 0
        var visibilityChanges: [Bool] = []
        controller.onVisibilityChanged = { visibilityChanges.append($0) }
        controller.onClosed = { closeCount += 1 }

        controller.close()
        controller.close()

        #expect(controller._testWindow == nil)
        #expect(closeCount == 1)
        #expect(visibilityChanges == [false])
    }

    @Test func `one Gateway profile can own multiple independent windows`() async throws {
        let manager = WebChatManager()
        let profile = try MacGatewayProfile(
            id: "same-gateway",
            name: "Same Gateway",
            url: #require(URL(string: "wss://same.example")))

        try await manager.show(profile: profile)
        try await manager.show(profile: profile)
        let connection = await MacGatewayConnectionFleet.shared.connection(profileID: profile.id)

        #expect(manager._testProfileWindowCount(profileID: profile.id) == 2)
        #expect(manager._testSessionObserverVisible(connection: connection))
        await manager.closeGatewayWindows(profileID: profile.id)
        #expect(manager._testProfileWindowCount(profileID: profile.id) == 0)
        #expect(!manager._testSessionObserverVisible(connection: connection))
    }

    @Test func `initial draft populates an empty composer without replacing user text`() {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            initialDraft: "Wake up, my friend!",
            transport: TestTransport())

        #expect(controller._testDraft == "Wake up, my friend!")
        controller.applyDraftIfEmpty("replacement")
        #expect(controller._testDraft == "Wake up, my friend!")
        controller.close()
    }

    @Test func `controller explicit agent wins and nil falls back to cached default`() {
        #expect(WebChatSwiftUIWindowController.effectiveAgentID(
            explicitAgentID: " Work ", cachedDefaultAgentID: "main") == "work")
        #expect(WebChatSwiftUIWindowController.effectiveAgentID(
            explicitAgentID: nil, cachedDefaultAgentID: "main") == "main")
        #expect(WebChatSwiftUIWindowController.effectiveAgentID(
            explicitAgentID: "  ", cachedDefaultAgentID: " MAIN ") == "main")
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

    @Test func `verbosity preference survives reopen`() throws {
        let suiteName = "WebChatSwiftUISmokeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set("full", forKey: "openclaw.webchat.verboseLevel")
        #expect(WebChatSwiftUIWindowController.persistedVerboseLevel(defaults: defaults) == "full")
        defaults.set("invalid", forKey: "openclaw.webchat.verboseLevel")
        #expect(WebChatSwiftUIWindowController.persistedVerboseLevel(defaults: defaults) == nil)
    }

    @Test func `inherited verbosity preference clears persisted override`() throws {
        let suiteName = "WebChatSwiftUISmokeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        WebChatSwiftUIWindowController.persistVerbosePreference("full", defaults: defaults)
        WebChatSwiftUIWindowController.persistVerbosePreference(nil, defaults: defaults)

        #expect(WebChatSwiftUIWindowController.persistedVerboseLevel(defaults: defaults) == nil)
        #expect(defaults.object(forKey: "openclaw.webchat.verboseLevel") == nil)
    }
}
