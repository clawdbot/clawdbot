import Foundation
import Testing

struct ChatDynamicTypeSourceGuardTests {
    @Test func `chat text avoids fixed point fonts`() throws {
        let sources = try Self.scopedChatTextSources()

        #expect(!sources.messageViews.contains("font: .system(size: 14)"))
        #expect(!sources.messageViews.contains("Font.system(size: 14)"))
        #expect(!sources.chatView.contains(".font(.system(size: 15))"))
        #expect(!sources.composer.contains(".font(.system(size: 15))"))
        #expect(!sources.composer.contains(".frame(height: self.cleanControlHeight)"))
        #expect(!sources.composer.contains("return self.composerChrome == .clean ? 48 : 64"))
        #expect(sources.composer.contains("@ScaledMetric(relativeTo: .body)"))
        #expect(sources.composer.contains(".textFieldStyle(.plain)"))
        #expect(sources.composer.contains(".lineLimit(1...4)"))
        #expect(sources.composer.contains(".fixedSize(horizontal: false, vertical: true)"))
        #expect(sources.composer.contains("CleanChatComposerSurface"))
        #expect(sources.composer.contains(".accessibilityIdentifier(\"chat-composer-surface\")"))
        #expect(sources.composer.contains("private var sendButtonVisualSize: CGFloat"))
        #expect(sources.messageViews.contains("self.isUser || self.style == .onboarding || !self.isClean"))
    }

    private static func scopedChatTextSources() throws -> (
        messageViews: String,
        chatView: String,
        composer: String)
    {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()

        return try (
            messageViews: String(
                contentsOf: root.appendingPathComponent("Sources/OpenClawChatUI/ChatMessageViews.swift"),
                encoding: .utf8),
            chatView: String(
                contentsOf: root.appendingPathComponent("Sources/OpenClawChatUI/ChatView.swift"),
                encoding: .utf8),
            composer: String(
                contentsOf: root.appendingPathComponent("Sources/OpenClawChatUI/ChatComposer.swift"),
                encoding: .utf8))
    }
}
