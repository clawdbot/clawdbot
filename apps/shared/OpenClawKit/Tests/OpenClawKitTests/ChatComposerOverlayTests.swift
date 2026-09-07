import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatComposerOverlayTests {
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
}
