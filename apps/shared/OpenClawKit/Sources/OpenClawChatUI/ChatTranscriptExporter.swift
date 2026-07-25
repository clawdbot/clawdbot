import Foundation

public enum ChatTranscriptExporter {
    private static let maxFileStemUTF8Count = 240

    public static func markdown(
        sessionTitle: String?,
        sessionKey: String,
        messages: [OpenClawChatMessage]) -> String
    {
        let title = self.resolvedTitle(sessionTitle: sessionTitle, sessionKey: sessionKey)
        let timestampFormatter = ISO8601DateFormatter()
        timestampFormatter.formatOptions = [.withInternetDateTime]
        timestampFormatter.timeZone = TimeZone(secondsFromGMT: 0)

        var sections = ["# \(title)"]
        for message in messages where self.shouldExport(message) {
            let timestamp = self.timestamp(message.timestamp, formatter: timestampFormatter)
            let heading = "### \(self.displayRole(message.role)) — \(timestamp)"
            let body = self.body(for: message)
            sections.append([heading, body].filter { !$0.isEmpty }.joined(separator: "\n\n"))
        }
        return sections.joined(separator: "\n\n") + "\n"
    }

    public static func filename(sessionTitle: String?, sessionKey: String) -> String {
        let title = sessionTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let key = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let stem = self.sanitizedFileStem(title)
            ?? self.sanitizedFileStem(key)
            ?? "chat-transcript"
        let boundedStem = self.boundedFileStem(stem)
        return "\(boundedStem.isEmpty ? "chat-transcript" : boundedStem).md"
    }

    private static func sanitizedFileStem(_ value: String) -> String? {
        let forbidden = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
        var segments: [String] = []
        var current = ""

        for scalar in value.unicodeScalars {
            if forbidden.contains(scalar) {
                segments.append(current)
                current = ""
            } else {
                current.unicodeScalars.append(scalar)
            }
        }
        segments.append(current)

        let edgeCharacters = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ".-"))
        let stem = segments
            .map { segment in
                segment
                    .split(whereSeparator: { $0.isWhitespace })
                    .joined(separator: " ")
                    .trimmingCharacters(in: edgeCharacters)
            }
            .filter { !$0.isEmpty }
            .joined(separator: "-")
        return stem.isEmpty ? nil : stem
    }

    private static func boundedFileStem(_ stem: String) -> String {
        var result = ""
        for character in stem {
            let candidate = result + String(character)
            guard candidate.utf8.count <= self.maxFileStemUTF8Count else { break }
            result = candidate
        }
        return result
    }

    private static func resolvedTitle(sessionTitle: String?, sessionKey: String) -> String {
        let title = sessionTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !title.isEmpty {
            return title.split(whereSeparator: { $0.isNewline }).joined(separator: " ")
        }
        let key = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        return key.isEmpty ? "Chat transcript" : key.split(whereSeparator: { $0.isNewline }).joined(separator: " ")
    }

    private static func shouldExport(_ message: OpenClawChatMessage) -> Bool {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard role != "system" else { return false }
        if !self.attachments(in: message).isEmpty {
            return true
        }
        let text = self.visibleText(in: message)
        guard !text.isEmpty else { return false }
        return role == "user" || AssistantTextParser.hasVisibleContent(in: text)
    }

    private static func body(for message: OpenClawChatMessage) -> String {
        var parts: [String] = []
        let text = self.visibleText(in: message)
        if !text.isEmpty {
            parts.append(text)
        }
        parts.append(contentsOf: self.attachments(in: message).map { attachment in
            let filename = attachment.fileName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return "_[attachment: \(filename.isEmpty ? "Attachment" : filename)]_"
        })
        return parts.joined(separator: "\n\n")
    }

    private static func visibleText(in message: OpenClawChatMessage) -> String {
        ChatMessageVisibleText.visibleText(in: message)
    }

    private static func attachments(in message: OpenClawChatMessage) -> [OpenClawChatMessageContent] {
        message.content.filter { content in
            let kind = (content.type ?? "text").lowercased()
            return kind == "file" || kind == "attachment"
        }
    }

    private static func displayRole(_ role: String) -> String {
        let normalized = role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return switch normalized {
        case "user": "User"
        case "assistant": "Assistant"
        default:
            normalized.isEmpty
                ? "Message"
                : normalized.prefix(1).uppercased() + normalized.dropFirst()
        }
    }

    private static func timestamp(_ value: Double?, formatter: ISO8601DateFormatter) -> String {
        guard let value else { return "Unknown time" }
        return formatter.string(from: Date(timeIntervalSince1970: value / 1000))
    }
}

extension OpenClawChatViewModel {
    public func exportTranscriptMarkdown() -> String {
        let title = self.sessions.first { $0.key == self.sessionKey }?.displayName
        return ChatTranscriptExporter.markdown(
            sessionTitle: title,
            sessionKey: self.sessionKey,
            messages: self.messages)
    }
}
