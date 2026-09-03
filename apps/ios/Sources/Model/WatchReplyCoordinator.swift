import Foundation
import OpenClawKit

/// Three recovery sources represent the same gateway-owned approval readback.
/// Preserve their source so cached cards, migration rows, and held Watch actions
/// share one classifier without losing source-specific cleanup.
enum WatchApprovalReadbackCandidate<Prompt, PersistedReadback> {
    case cached(Prompt)
    case persisted(PersistedReadback)
    case held(WatchExecApprovalSnapshotRequestItem)
}

@MainActor
final class WatchMessageOutbox {
    enum Decision {
        case dropMissingFields
        case dropMissingTarget
        case deduped(messageID: String)
        case queue(event: WatchAppCommandEvent)
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
        gatewayStableID: String?) -> Decision
    {
        let messageID = event.commandId.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = event.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if messageID.isEmpty || text.isEmpty {
            return .dropMissingFields
        }
        guard let owner = GatewayStableIdentifier.exact(gatewayStableID) else { return .dropMissingTarget }
        if self.seenMessageIDs.contains(messageID) {
            // Pending replay resumes the admitted payload; only delivered or foreign work is deduped.
            if let pending = self.queuedMessages.first(where: {
                $0.event.commandId == messageID && GatewayStableIdentifier.matches($0.gatewayStableID, owner)
            }) {
                return .queue(event: pending.event)
            }
            return .deduped(messageID: messageID)
        }
        // Persist before network delivery; iOS may suspend a background callback at any await.
        let queuedEvent = self.message(event, taggedFor: owner)
        self.queuedMessages.append(
            QueuedMessage(gatewayStableID: owner, event: queuedEvent))
        self.rebuildSeenMessageIDs()
        self.persistQueue()
        return .queue(event: queuedEvent)
    }

    func recordPromptRoute(promptID: String?, gatewayStableID: String?) {
        let promptID = promptID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !promptID.isEmpty, promptID != "unknown",
              let gatewayStableID = GatewayStableIdentifier.exact(gatewayStableID)
        else { return }
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

    func nextQueuedMessage(
        isAvailable: Bool,
        gatewayStableID: String?,
        excludingMessageIDs: Set<String> = []) -> WatchAppCommandEvent?
    {
        guard isAvailable, let owner = GatewayStableIdentifier.exact(gatewayStableID) else { return nil }
        // Replies are time-sensitive; a retrying chat must not strand them behind it.
        var oldest: WatchAppCommandEvent?
        for queued in self.queuedMessages where
            GatewayStableIdentifier.matches(queued.gatewayStableID, owner) &&
            !excludingMessageIDs.contains(queued.event.commandId)
        {
            if self.kind(of: queued.event) == .quickReply { return queued.event }
            if oldest == nil { oldest = queued.event }
        }
        return oldest
    }

    func removeQueuedMessage(messageID: String, gatewayStableID: String?) {
        let messageID = messageID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !messageID.isEmpty, let owner = GatewayStableIdentifier.exact(gatewayStableID) else { return }
        guard let index = self.queuedMessages.firstIndex(where: {
            GatewayStableIdentifier.matches($0.gatewayStableID, owner) && $0.event.commandId == messageID
        }) else { return }
        self.queuedMessages.remove(at: index)
        self.rememberRecentMessageID(messageID)
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
            let messageID = queued.event.commandId.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = queued.event.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard let owner = GatewayStableIdentifier.exact(queued.gatewayStableID),
                  !messageID.isEmpty,
                  !text.isEmpty,
                  !self.recentMessageIDs.contains(messageID),
                  seenSet.insert(messageID).inserted
            else {
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
            guard !promptID.isEmpty, promptID != "unknown",
                  let gatewayStableID = GatewayStableIdentifier.exact(rawRoute.gatewayStableID)
            else { continue }
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
