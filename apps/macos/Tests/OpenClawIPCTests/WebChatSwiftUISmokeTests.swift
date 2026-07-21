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

    @Test func `window controller merges titlebar and keeps toolbar controls`() throws {
        let traceKeys = [
            OpenClawChatWindowShell.assistantTraceDefaultsKey,
            OpenClawChatWindowShell.assistantReasoningDefaultsKey,
            OpenClawChatWindowShell.assistantToolActivityDefaultsKey,
        ]
        let previousTraceValues = traceKeys.map { ($0, UserDefaults.standard.object(forKey: $0)) }
        traceKeys.forEach { UserDefaults.standard.removeObject(forKey: $0) }
        defer {
            for (key, value) in previousTraceValues {
                if let value {
                    UserDefaults.standard.set(value, forKey: key)
                } else {
                    UserDefaults.standard.removeObject(forKey: key)
                }
            }
        }
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            presentation: .window,
            transport: TestTransport(),
            windowTitle: "Studio — OpenClaw")
        let window = try #require(controller._testWindow)
        let capabilities = try #require(controller._testChatCapabilities)

        #expect(window.styleMask.contains(.fullSizeContentView))
        #expect(window.titleVisibility == .hidden)
        #expect(window.titlebarAppearsTransparent)
        #expect(window.toolbarStyle == .unified)
        #expect(window.titlebarSeparatorStyle == .none)
        #expect(window.isMovableByWindowBackground)
        #expect(window.title == "Studio — OpenClaw")
        window.title = "main"
        #expect(window.title == "Studio — OpenClaw")
        #expect(controller._testSceneBridgingOptions?.contains(.toolbars) == true)
        #expect(controller._testSceneBridgingOptions?.contains(.title) == false)
        #expect(capabilities.hasTalkControl)
        #expect(capabilities.hasSpeech)
        #expect(capabilities.hasVoiceNoteControl)
        #expect(capabilities.displayOptions == .assistantTrace)

        controller.show()
        #expect(window.titleVisibility == .hidden)
        #expect(window.toolbar != nil)
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

    @Test func `closing a full window releases it and notifies its owner once`() {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            presentation: .window,
            transport: TestTransport())
        var closeCount = 0
        controller.onClosed = { closeCount += 1 }

        controller.close()
        controller.close()

        #expect(controller._testWindow == nil)
        #expect(closeCount == 1)
    }

    @Test func `one Gateway profile can own multiple independent windows`() async throws {
        let manager = WebChatManager()
        let profile = try MacGatewayProfile(
            id: "same-gateway",
            name: "Same Gateway",
            url: #require(URL(string: "wss://same.example")))

        try await manager.show(profile: profile)
        try await manager.show(profile: profile)

        #expect(manager._testProfileWindowCount(profileID: profile.id) == 2)
        await manager.closeGatewayWindows(profileID: profile.id)
        #expect(manager._testProfileWindowCount(profileID: profile.id) == 0)
    }

    @Test func `initial draft populates an empty composer without replacing user text`() {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            initialDraft: "Wake up, my friend!",
            presentation: .window,
            transport: TestTransport())

        #expect(controller._testDraft == "Wake up, my friend!")
        controller.applyDraftIfEmpty("replacement")
        #expect(controller._testDraft == "Wake up, my friend!")
        controller.close()
    }

    @Test func `controller explicit agent wins and nil falls back to cached default`() throws {
        let cachedIdentity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "global",
            mainSessionKey: "main",
            defaultAgentID: "main"))
        let explicit = WebChatSwiftUIWindowController(
            sessionKey: "global",
            agentID: " Work ",
            presentation: .window,
            cachedRoutingIdentity: cachedIdentity,
            store: nil)
        let fallback = WebChatSwiftUIWindowController(
            sessionKey: "global",
            agentID: nil,
            presentation: .window,
            cachedRoutingIdentity: cachedIdentity,
            store: nil)

        #expect(explicit._testActiveAgentID == "work")
        #expect(fallback._testActiveAgentID == "main")
        explicit.close()
        fallback.close()
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
