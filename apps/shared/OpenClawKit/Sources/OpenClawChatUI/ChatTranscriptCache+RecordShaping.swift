import Foundation
import OpenClawKit

extension OpenClawChatSQLiteTranscriptCache {
    // MARK: - Portable cache record shaping

    /// Cache format v1 stores one JSON document per session/message row. Large
    /// attachment bodies and ordinary tool arguments are never cache data.
    static func cacheableMessages(_ messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        messages.suffix(maxCachedMessagesPerSession).map { message in
            OpenClawChatMessage(
                id: message.id,
                role: message.role,
                content: message.content.map { item in
                    OpenClawChatMessageContent(
                        type: item.type,
                        text: item.text,
                        thinking: item.thinking,
                        thinkingSignature: nil,
                        mimeType: item.mimeType,
                        fileName: item.fileName,
                        artifactId: item.artifactId,
                        url: item.url,
                        openUrl: item.openUrl,
                        alt: item.alt,
                        width: item.width,
                        height: item.height,
                        sizeBytes: item.sizeBytes,
                        durationSeconds: item.durationSeconds,
                        content: nil,
                        id: item.id,
                        name: item.name,
                        arguments: self.cacheablePatchArguments(item),
                        details: self.cacheableDetails(item.details),
                        isError: item.isError)
                },
                timestamp: message.timestamp,
                transcriptMessageID: message.transcriptMessageID,
                isTruncated: message.isTruncated,
                idempotencyKey: message.idempotencyKey,
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                usage: message.usage,
                stopReason: message.stopReason,
                errorMessage: message.errorMessage,
                details: self.cacheableDetails(message.details),
                isError: message.isError,
                provenance: message.provenance,
                historyMarker: message.historyMarker)
        }
    }

    private static func cacheableDetails(_ details: AnyCodable?) -> AnyCodable? {
        guard let diff = details?.dictionaryValue?["diff"]?.stringValue else { return nil }
        let capped = self.cacheableText(diff)
        guard !capped.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return AnyCodable(["diff": AnyCodable(capped)])
    }

    private static func cacheablePatchArguments(_ item: OpenClawChatMessageContent) -> AnyCodable? {
        guard let type = item.type?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              ["toolcall", "tool_call", "tooluse", "tool_use"].contains(type),
              let name = item.name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              ["apply_patch", "applypatch", "patch"].contains(name),
              let arguments = item.arguments?.dictionaryValue
        else { return nil }

        for key in ["input", "patch", "diff"] {
            guard let value = arguments[key]?.stringValue,
                  !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { continue }
            return AnyCodable([key: AnyCodable(self.cacheableText(value))])
        }
        return nil
    }

    private static func cacheableText(_ value: String) -> String {
        let limit = 64000
        let truncationMarker = "\n...(truncated)..."
        return if value.utf16.count > limit {
            self.utf16Prefix(value, limit: limit - truncationMarker.utf16.count) + truncationMarker
        } else {
            value
        }
    }

    private static func utf16Prefix(_ value: String, limit: Int) -> String {
        let units = value.utf16
        guard units.count > limit else { return value }
        var end = units.index(units.startIndex, offsetBy: limit)
        if String.Index(end, within: value) == nil {
            end = units.index(before: end)
        }
        guard let stringEnd = String.Index(end, within: value) else { return "" }
        return String(value[..<stringEnd])
    }
}
