import Foundation

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
