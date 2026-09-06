import Testing
@testable import OpenClawChatUI

struct ChatComposerOverlayTests {
    @Test func `iOS Chat overlays the composer so the transcript can scroll behind it`() {
        #expect(chatComposerOverlaysTranscript(platformIsIOS: true))
    }

    @Test func `macOS window and Quick Chat keep a stacked composer`() {
        #expect(!chatComposerOverlaysTranscript(platformIsIOS: false))
    }

    @Test func `Quick Chat stays composer-off and does not float an input`() throws {
        let decision = chatSurfaceDecision(
            ChatSurfaceState(
                hasSession: true,
                isLoading: false,
                hasVisibleTranscript: false,
                isEmptyThread: true,
                errorText: nil,
                composerChromeIsClean: true,
                hasEmptyAssistantIntro: true,
                isComposerEnabled: false,
                hostConnection: .unmanaged))

        #expect(decision.presentation == .emptyUnavailable)
        #expect(decision.presentation != .emptyIntro)
        #expect(!chatComposerOverlaysTranscript(platformIsIOS: false))

        let quickChat = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("macos/Sources/OpenClaw/QuickChatView.swift"),
            encoding: .utf8)
        #expect(quickChat.contains("isComposerEnabled: false"))
        #expect(!quickChat.contains("ChatFloatingComposerBar"))
        #expect(quickChat.contains(".id(self.replyBinding.route)"))
    }

    @Test func `iOS canvas pins composer chrome with a bar inset not a reserved footer stack`() throws {
        let kitRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let chatView = try String(
            contentsOf: kitRoot.appendingPathComponent("Sources/OpenClawChatUI/ChatView.swift"),
            encoding: .utf8)
        let overlay = try String(
            contentsOf: kitRoot.appendingPathComponent("Sources/OpenClawChatUI/ChatComposerOverlay.swift"),
            encoding: .utf8)

        #expect(chatView.contains("ChatFloatingComposerBar"))
        #expect(chatView.contains("#elseif os(iOS)"))
        #expect(overlay.contains("safeAreaBar(edge: .bottom"))
        #expect(overlay.contains("safeAreaInset(edge: .bottom"))
        #expect(overlay.contains(".ultraThinMaterial"))
    }
}
