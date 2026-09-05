import CryptoKit
import Foundation
import OpenClawKit

/// Owns the one canonical interpretation of projected chat rows shared by Watch
/// previews and run-correlated voice replies.
public enum OpenClawChatHistoryPresentation {
    private static let previewItemLimit = 5

    private struct MessageEntry {
        var message: OpenClawChatMessage
        var text: String
        var runID: String?
        var isMessageToolMirror: Bool
    }

    /// Only callers retaining the submitted text and time may match legacy user rows.
    /// Realtime callers without them require recorded run or input-consumption ownership.
    public nonisolated static func replyText(
        from rawMessages: [OpenClawKit.AnyCodable],
        runID: String,
        submittedText: String? = nil,
        submittedAtMs: Int64? = nil,
        inputConsumptions: [OpenClawChatHistoryPayload.InputConsumption]? = nil) -> String?
    {
        let entries = rawMessages.compactMap(Self.decodeMessage)
        if let directReply = entries.last(where: {
            Self.isTerminalAssistant($0) && ($0.runID ?? $0.message.idempotencyKey) == runID
        }) {
            return directReply.text
        }

        let consumedEventID = inputConsumptions?.first { $0.runId == runID }?.consumedByEventId
        let userIdempotencyKey = "\(runID):user"
        var userIndex = entries.lastIndex(where: { entry in
            guard entry.message.role.lowercased() == "user" else { return false }
            if let consumedEventID {
                return entry.message.transcriptMessageID == consumedEventID
            }
            return entry.message.idempotencyKey == userIdempotencyKey
        })
        if userIndex == nil, consumedEventID == nil, inputConsumptions == nil,
           let submittedText, !submittedText.isEmpty, let submittedAtMs
        {
            // Older gateways lack receipts; repeated prompts must not become guessed ownership.
            let candidates = entries.indices.filter { index in
                let entry = entries[index]
                guard entry.message.role.lowercased() == "user",
                      let timestampMs = Self.timestampMs(entry.message.timestamp),
                      timestampMs >= submittedAtMs
                else { return false }
                return entry.text.contains(submittedText)
            }
            guard candidates.count == 1 else { return nil }
            userIndex = candidates.first
        }
        guard let userIndex else { return nil }
        for entry in entries.dropFirst(userIndex + 1) {
            // Attachment-only user rows still bound the turn even when previews hide them.
            guard entry.message.role.lowercased() != "user" else { return nil }
            // A collected input may execute under a fresh run ID; only its receipt permits that.
            if consumedEventID == nil, let candidateRunID = entry.runID, candidateRunID != runID {
                return nil
            }
            if Self.isTerminalAssistant(entry) { return entry.text }
        }
        return nil
    }

    public nonisolated static func makeWatchItems(
        from rawMessages: [OpenClawKit.AnyCodable]) -> [OpenClawWatchChatItem]
    {
        var occurrences: [String: Int] = [:]
        let identified = rawMessages.compactMap(Self.decodeMessage).filter { !$0.text.isEmpty }.map { entry in
            let baseID = entry.message.transcriptMessageID.map { "\(entry.message.role)-\($0)" }
                ?? Self.fallbackKey(entry)
            occurrences[baseID, default: 0] += 1
            return (entry, "\(baseID)-\(occurrences[baseID]!)")
        }
        return identified.suffix(Self.previewItemLimit).map { entry, stableID in
            OpenClawWatchChatItem(
                id: stableID,
                role: entry.message.role,
                text: Self.truncatedText(entry.text),
                timestampMs: Self.timestampMs(entry.message.timestamp))
        }
    }

    private nonisolated static func isTerminalAssistant(_ entry: MessageEntry) -> Bool {
        guard entry.message.role.lowercased() == "assistant", !entry.text.isEmpty else { return false }
        if entry.isMessageToolMirror { return true }
        guard let stopReason = entry.message.stopReason?.lowercased() else { return false }
        // Progress rows are not final replies; the later assistant row owns completion.
        return stopReason != "tooluse" && stopReason != "tool_use" && stopReason != "tool_calls"
    }

    private nonisolated static func decodeMessage(_ raw: OpenClawKit.AnyCodable) -> MessageEntry? {
        guard let data = try? JSONEncoder().encode(raw),
              let message = try? JSONDecoder().decode(OpenClawChatMessage.self, from: data)
        else { return nil }
        let text = ChatMessageVisibleText.visibleText(in: message)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let fields = raw.dictionaryValue
        return MessageEntry(
            message: message,
            text: text,
            runID: fields?["__openclaw"]?.dictionaryValue?["runId"]?.stringValue,
            isMessageToolMirror: fields?["openclawMessageToolMirror"]?.dictionaryValue != nil)
    }

    private nonisolated static func fallbackKey(_ entry: MessageEntry) -> String {
        let timestamp = Self.timestampMs(entry.message.timestamp).map(String.init) ?? "missing"
        let source = "\(entry.message.role)\u{0}\(timestamp)\u{0}\(entry.text)"
        let digest = SHA256.hash(data: Data(source.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return "\(entry.message.role)-\(digest)"
    }

    private nonisolated static func truncatedText(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 240 else { return trimmed }
        return "\(trimmed.prefix(237))..."
    }

    private nonisolated static func timestampMs(_ timestamp: Double?) -> Int64? {
        guard let timestamp, timestamp.isFinite, timestamp >= 0 else { return nil }
        let milliseconds = timestamp > 100_000_000_000 ? timestamp : timestamp * 1000
        guard milliseconds.isFinite,
              milliseconds >= 0,
              milliseconds <= 32_503_680_000_000
        else { return nil }
        return Int64(milliseconds)
    }
}
