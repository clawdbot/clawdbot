import CryptoKit
import Foundation
import OpenClawChatUI
import OpenClawKit

/// Three recovery sources represent the same gateway-owned approval readback.
/// Preserve their source so cached cards, migration rows, and held Watch actions
/// share one classifier without losing source-specific cleanup.
enum WatchApprovalReadbackCandidate<Prompt, PersistedReadback> {
    case cached(Prompt)
    case persisted(PersistedReadback)
    case held(WatchExecApprovalSnapshotRequestItem)
}

/// Owns the one canonical interpretation of projected chat rows shared by Watch
/// previews and run-correlated voice replies.
enum WatchChatPresentation {
    private static let previewItemLimit = 5

    private struct MetadataEnvelope: Decodable {
        struct Metadata: Decodable {
            var id: String?
        }

        var metadata: Metadata?
        var messageToolMirror: [String: String]?

        enum CodingKeys: String, CodingKey {
            case metadata = "__openclaw"
            case messageToolMirror = "openclawMessageToolMirror"
        }
    }

    private struct MessageEntry {
        var message: OpenClawChatMessage
        var text: String
        var serverID: String?
        var isMessageToolMirror: Bool
    }

    nonisolated static func replyText(
        from rawMessages: [OpenClawKit.AnyCodable],
        runID: String,
        submittedText: String,
        submittedAtMs: Int64) -> String?
    {
        let entries = rawMessages.compactMap(Self.decodeMessage)
        if let directReply = entries.last(where: {
            Self.isTerminalAssistant($0) && $0.message.idempotencyKey == runID
        }) {
            return directReply.text
        }

        let userIdempotencyKey = "\(runID):user"
        let exactUserIndex = entries.lastIndex(where: {
            $0.message.role.lowercased() == "user" &&
                $0.message.idempotencyKey == userIdempotencyKey
        })
        let queuedUserIndex = entries.lastIndex(where: { entry in
            guard entry.message.role.lowercased() == "user",
                  let timestampMs = Self.timestampMs(entry.message.timestamp),
                  timestampMs >= submittedAtMs
            else { return false }
            return entry.text.contains(submittedText)
        })
        guard let userIndex = exactUserIndex ?? queuedUserIndex else { return nil }
        return entries[(userIndex + 1)...].first(where: Self.isTerminalAssistant)?.text
    }

    nonisolated static func makeItems(
        from rawMessages: [OpenClawKit.AnyCodable]) -> [OpenClawWatchChatItem]
    {
        var occurrences: [String: Int] = [:]
        let identified = rawMessages.compactMap(Self.decodeMessage).map { entry in
            let baseID = entry.serverID.map { "\(entry.message.role)-\($0)" }
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
        guard entry.message.role.lowercased() == "assistant" else { return false }
        if entry.isMessageToolMirror { return true }
        guard let stopReason = entry.message.stopReason?.lowercased() else { return false }
        // Progress rows are not final replies; the later assistant row owns completion.
        return stopReason != "tooluse" && stopReason != "tool_use" && stopReason != "tool_calls"
    }

    private nonisolated static func decodeMessage(_ raw: OpenClawKit.AnyCodable) -> MessageEntry? {
        guard let data = try? JSONEncoder().encode(raw),
              let message = try? JSONDecoder().decode(OpenClawChatMessage.self, from: data),
              let text = nonEmptyText(messageText(message))
        else { return nil }
        let metadata = try? JSONDecoder().decode(MetadataEnvelope.self, from: data)
        return MessageEntry(
            message: message,
            text: text,
            serverID: metadata?.metadata?.id,
            isMessageToolMirror: metadata?.messageToolMirror != nil)
    }

    private nonisolated static func fallbackKey(_ entry: MessageEntry) -> String {
        let timestamp = Self.timestampMs(entry.message.timestamp).map(String.init) ?? "missing"
        let source = "\(entry.message.role)\u{0}\(timestamp)\u{0}\(entry.text)"
        let digest = SHA256.hash(data: Data(source.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return "\(entry.message.role)-\(digest)"
    }

    private nonisolated static func messageText(_ message: OpenClawChatMessage) -> String {
        let parts = message.content.compactMap { content -> String? in
            let kind = (content.type ?? "text").lowercased()
            guard kind.isEmpty || kind == "text" || kind == "output_text" else { return nil }
            if let text = Self.nonEmptyText(content.text) { return text }
            if let text = Self.nonEmptyText(content.content?.value as? String) { return text }
            if let values = content.content?.value as? [String: OpenClawKit.AnyCodable] {
                return Self.nonEmptyText(values["text"]?.value as? String)
            }
            return nil
        }
        let contentText = parts.joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return contentText.isEmpty
            ? message.errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            : contentText
    }

    private nonisolated static func nonEmptyText(_ text: String?) -> String? {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
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

@MainActor
final class WatchMessageOutbox {
    enum Decision {
        case dropMissingFields
        case dropMissingTarget
        case deduped(messageID: String)
        case queue(messageID: String)
        case forward
    }

    // Keep the shipped chat key so upgrades retain messages already queued by the Watch.
    private static let persistedQueueKey = "watch.chat.command.queue.v1"
    private static let persistedMetadataKey = "watch.message.outbox.metadata.v1"
    private static let maxRecentMessageIDs = 128
    private static let maxPromptRoutes = 128

    private struct QueuedMessage: Codable, Equatable {
        var gatewayStableID: String
        var event: WatchAppCommandEvent
    }

    private struct PromptRoute: Codable, Equatable {
        var promptID: String
        var gatewayStableID: String
    }

    private struct PersistedMetadata: Codable, Equatable {
        var recentMessageIDs: [String]
        var promptRoutes: [PromptRoute]
    }

    private let defaults: UserDefaults
    private var queuedMessages: [QueuedMessage] = []
    private var recentMessageIDs: [String] = []
    private var seenMessageIDs = Set<String>()
    private var promptRoutes: [PromptRoute] = []

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.restoreMetadata()
        self.restoreQueue()
    }

    func ingest(
        _ event: WatchAppCommandEvent,
        isAvailable: Bool,
        gatewayStableID: String?) -> Decision
    {
        let messageID = event.commandId.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = event.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if messageID.isEmpty || text.isEmpty {
            return .dropMissingFields
        }
        let owner = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !owner.isEmpty else { return .dropMissingTarget }
        if self.seenMessageIDs.contains(messageID) {
            return .deduped(messageID: messageID)
        }
        // Persist before network delivery; iOS may suspend a background callback at any await.
        self.queuedMessages.append(
            QueuedMessage(gatewayStableID: owner, event: self.message(event, taggedFor: owner)))
        self.rebuildSeenMessageIDs()
        self.persistQueue()
        return isAvailable ? .forward : .queue(messageID: messageID)
    }

    func recordPromptRoute(promptID: String?, gatewayStableID: String?) {
        let promptID = promptID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gatewayStableID = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !promptID.isEmpty, promptID != "unknown", !gatewayStableID.isEmpty else { return }
        self.promptRoutes.removeAll { $0.promptID == promptID }
        self.promptRoutes.append(PromptRoute(promptID: promptID, gatewayStableID: gatewayStableID))
        if self.promptRoutes.count > Self.maxPromptRoutes {
            self.promptRoutes.removeFirst(self.promptRoutes.count - Self.maxPromptRoutes)
        }
        self.persistMetadata()
    }

    func gatewayStableID(forPromptID promptID: String) -> String? {
        let promptID = promptID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !promptID.isEmpty, promptID != "unknown" else { return nil }
        return self.promptRoutes.last { $0.promptID == promptID }?.gatewayStableID
    }

    func nextQueuedMessage(isAvailable: Bool, gatewayStableID: String?) -> WatchAppCommandEvent? {
        let owner = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard isAvailable, !owner.isEmpty else { return nil }
        // Replies are time-sensitive; a retrying chat must not strand them behind it.
        if let reply = self.queuedMessages.first(where: {
            $0.gatewayStableID == owner && self.kind(of: $0.event) == .quickReply
        }) {
            return reply.event
        }
        return self.queuedMessages.first { $0.gatewayStableID == owner }?.event
    }

    func removeQueuedMessage(messageID: String, gatewayStableID: String?) {
        let messageID = messageID.trimmingCharacters(in: .whitespacesAndNewlines)
        let owner = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !messageID.isEmpty, !owner.isEmpty else { return }
        guard let index = self.queuedMessages.firstIndex(where: {
            $0.gatewayStableID == owner && $0.event.commandId == messageID
        }) else { return }
        self.queuedMessages.remove(at: index)
        self.rememberRecentMessageID(messageID)
        self.persistQueue()
    }

    func requeueFront(_ event: WatchAppCommandEvent, gatewayStableID: String?) {
        let messageID = event.commandId.trimmingCharacters(in: .whitespacesAndNewlines)
        let owner = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !messageID.isEmpty, !owner.isEmpty else { return }
        self.queuedMessages.removeAll { $0.event.commandId == messageID }
        self.queuedMessages.insert(
            QueuedMessage(gatewayStableID: owner, event: self.message(event, taggedFor: owner)),
            at: 0)
        self.rebuildSeenMessageIDs()
        self.persistQueue()
    }

    func queuedCount(kind: WatchMessageKind? = nil) -> Int {
        guard let kind else { return self.queuedMessages.count }
        return self.queuedMessages.count(where: { self.kind(of: $0.event) == kind })
    }

    func queuedMessageIDs(kind: WatchMessageKind? = nil) -> [String] {
        self.queuedMessages.compactMap { queued in
            guard kind == nil || self.kind(of: queued.event) == kind else { return nil }
            return queued.event.commandId
        }
    }

    private func restoreQueue() {
        guard let data = defaults.data(forKey: Self.persistedQueueKey),
              let persisted = try? JSONDecoder().decode([QueuedMessage].self, from: data)
        else {
            return
        }

        var seenSet = Set<String>()
        self.queuedMessages = persisted.compactMap { queued in
            let owner = queued.gatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
            let messageID = queued.event.commandId.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = queued.event.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !owner.isEmpty, !messageID.isEmpty, !text.isEmpty, seenSet.insert(messageID).inserted else {
                return nil
            }
            return QueuedMessage(gatewayStableID: owner, event: self.message(queued.event, taggedFor: owner))
        }
        self.rebuildSeenMessageIDs()
        if self.queuedMessages.count != persisted.count {
            self.persistQueue()
        }
    }

    private func rememberRecentMessageID(_ messageID: String) {
        guard !messageID.isEmpty else { return }
        self.recentMessageIDs.removeAll { $0 == messageID }
        self.recentMessageIDs.append(messageID)
        if self.recentMessageIDs.count > Self.maxRecentMessageIDs {
            self.recentMessageIDs.removeFirst(self.recentMessageIDs.count - Self.maxRecentMessageIDs)
        }
        self.rebuildSeenMessageIDs()
        self.persistMetadata()
    }

    private func restoreMetadata() {
        guard let data = self.defaults.data(forKey: Self.persistedMetadataKey),
              let metadata = try? JSONDecoder().decode(PersistedMetadata.self, from: data)
        else { return }

        for rawMessageID in metadata.recentMessageIDs {
            let messageID = rawMessageID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !messageID.isEmpty else { continue }
            self.recentMessageIDs.removeAll { $0 == messageID }
            self.recentMessageIDs.append(messageID)
        }
        self.recentMessageIDs = Array(self.recentMessageIDs.suffix(Self.maxRecentMessageIDs))

        for rawRoute in metadata.promptRoutes {
            let promptID = rawRoute.promptID.trimmingCharacters(in: .whitespacesAndNewlines)
            let gatewayStableID = rawRoute.gatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !promptID.isEmpty, promptID != "unknown", !gatewayStableID.isEmpty else { continue }
            self.promptRoutes.removeAll { $0.promptID == promptID }
            self.promptRoutes.append(PromptRoute(promptID: promptID, gatewayStableID: gatewayStableID))
        }
        self.promptRoutes = Array(self.promptRoutes.suffix(Self.maxPromptRoutes))
        self.rebuildSeenMessageIDs()
    }

    private func rebuildSeenMessageIDs() {
        var ids = Set(self.recentMessageIDs)
        ids.formUnion(self.queuedMessages.map(\.event.commandId))
        self.seenMessageIDs = ids
    }

    private func persistQueue() {
        if self.queuedMessages.isEmpty {
            self.defaults.removeObject(forKey: Self.persistedQueueKey)
            return
        }
        guard let data = try? JSONEncoder().encode(self.queuedMessages) else { return }
        self.defaults.set(data, forKey: Self.persistedQueueKey)
    }

    private func persistMetadata() {
        let metadata = PersistedMetadata(
            recentMessageIDs: self.recentMessageIDs,
            promptRoutes: self.promptRoutes)
        guard let data = try? JSONEncoder().encode(metadata) else { return }
        self.defaults.set(data, forKey: Self.persistedMetadataKey)
    }

    private func message(_ event: WatchAppCommandEvent, taggedFor gatewayStableID: String) -> WatchAppCommandEvent {
        var tagged = event
        tagged.gatewayStableID = gatewayStableID
        return tagged
    }

    private func kind(of event: WatchAppCommandEvent) -> WatchMessageKind {
        event.messageKind ?? .chat
    }

    static func resetPersistedQueue(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: self.persistedQueueKey)
        defaults.removeObject(forKey: self.persistedMetadataKey)
    }
}
