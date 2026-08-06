import Foundation

/// Plain-text projection of a transcript message: exactly what the reader sees
/// in the bubble, with tool traces and non-text blocks removed. Shared by the
/// transcript exporter and the Listen action so exported and spoken text
/// always match the visible transcript.
public enum ChatMessageVisibleText {
    static func copyText(in message: OpenClawChatMessage) -> String {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return role == "assistant" ? self.visibleText(in: message) : self.primaryText(in: message)
    }

    public static func visibleText(in message: OpenClawChatMessage) -> String {
        let text = self.primaryText(in: message)
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard role != "user" else { return text }
        return AssistantTextParser.visibleSegments(from: text)
            .map(\.text)
            .joined(separator: "\n\n")
    }

    static func hasVisibleText(in message: OpenClawChatMessage) -> Bool {
        !self.visibleText(in: message)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty
    }

    static func displayText(in message: OpenClawChatMessage, includeThinking: Bool) -> String {
        let isAssistant = message.role.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() == "assistant"
        let parts = message.content.compactMap { content -> String? in
            let kind = (content.type ?? "text").lowercased()
            if kind == "text" || kind.isEmpty {
                return content.text
            }
            guard
                includeThinking,
                isAssistant,
                kind == "thinking",
                let thinking = content.thinking,
                !thinking.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                return nil
            }
            return "<think>\n\(thinking)\n</think>"
        }
        return OpenClawChatMessage.displayText(
            contentText: parts.joined(separator: "\n"),
            role: message.role,
            stopReason: message.stopReason,
            errorMessage: message.errorMessage)
    }

    private static func primaryText(in message: OpenClawChatMessage) -> String {
        self.displayText(in: message, includeThinking: false)
    }
}
