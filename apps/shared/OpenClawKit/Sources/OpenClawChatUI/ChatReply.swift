import Foundation

public struct OpenClawChatReplyTarget: Equatable, Sendable {
    public let selectionID: UUID
    public let messageID: UUID
    public let text: String
    public let senderLabel: String

    public init(selectionID: UUID = UUID(), messageID: UUID, text: String, senderLabel: String) {
        self.selectionID = selectionID
        self.messageID = messageID
        self.text = text
        self.senderLabel = senderLabel
    }
}

enum ChatReplyQuote {
    static let targetTextUTF16Limit = 500
    static let previewUTF16Limit = 120

    static func targetText(_ text: String) -> String {
        self.truncateUTF16Safe(text.trimmingCharacters(in: .whitespacesAndNewlines), limit: self.targetTextUTF16Limit)
    }

    static func previewText(_ text: String) -> (text: String, isTruncated: Bool) {
        let truncated = self.truncateUTF16Safe(text, limit: self.previewUTF16Limit)
        return (truncated, text.utf16.count > self.previewUTF16Limit)
    }

    static func prepend(message: String, replyTarget: OpenClawChatReplyTarget) -> String {
        let senderLabel = replyTarget.senderLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = self.escapeMarkdownInline(senderLabel.isEmpty ? "User" : senderLabel)
        let text = replyTarget.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // LF-only detection matches the web encoder (chat-send.ts
        // prependReplyQuote) byte-for-byte; normalizing CR here would make
        // native quotes diverge from web transcripts for identical targets.
        if !text.contains("\n") {
            return "> **\(label):** \(text)\n\n\(message)"
        }
        let quoted = text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { "> \($0)" }
            .joined(separator: "\n")
        return "> **\(label):**\n\(quoted)\n\n\(message)"
    }

    static func truncateUTF16Safe(_ text: String, limit: Int) -> String {
        guard limit >= 0, text.utf16.count > limit else { return text }
        let utf16 = text.utf16
        var end = utf16.index(utf16.startIndex, offsetBy: limit)
        if end > utf16.startIndex,
           end < utf16.endIndex,
           (0xD800...0xDBFF).contains(utf16[utf16.index(before: end)]),
           (0xDC00...0xDFFF).contains(utf16[end])
        {
            end = utf16.index(before: end)
        }
        return String(decoding: utf16[..<end], as: UTF16.self)
    }

    private static func escapeMarkdownInline(_ value: String) -> String {
        let escaped = CharacterSet(charactersIn: "\\`*_{}[]()#+-.!|>")
        return value.unicodeScalars.reduce(into: "") { result, scalar in
            if escaped.contains(scalar) { result.append("\\") }
            result.unicodeScalars.append(scalar)
        }
    }
}

extension OpenClawChatViewModel {
    public func clearReplyTarget() {
        self.replyTarget = nil
    }

    func setReplyTarget(messageID: UUID, text: String, senderLabel: String) {
        let text = ChatReplyQuote.targetText(text)
        guard !text.isEmpty else { return }
        self.replyTarget = OpenClawChatReplyTarget(
            messageID: messageID,
            text: text,
            senderLabel: senderLabel.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Accepted sends consume the chip even if newer text was typed meanwhile:
    /// the quote was delivered with the submitted message, and web behaves the
    /// same (chat-send.ts clears chatReplyTarget on accept by messageId alone).
    /// Selection identity is already stricter: a re-selected target survives.
    func consumeReplyTarget(_ target: OpenClawChatReplyTarget?) {
        guard let target, self.replyTarget == target else { return }
        self.replyTarget = nil
    }
}
