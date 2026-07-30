import Foundation

struct ChatSessionUnreadPatchGuard {
    private var activeSessionKey = ""
    private var requested = false
    private var activeExplicitUnread: Bool?
    private var confirmedUnreadByKey: [String: Bool] = [:]
    private var pendingExplicitUnreadByKey: [String: Bool] = [:]
    private var pendingExplicitRevisions: [String: Int] = [:]
    private var revisions: [String: Int] = [:]

    mutating func observe(key: String, unread: Bool?) {
        guard self.pendingExplicitRevisions[key] == nil,
              !(key == self.activeSessionKey && self.activeExplicitUnread != nil)
        else { return }
        if let unread {
            self.confirmedUnreadByKey[key] = unread
        }
        if key == self.activeSessionKey, unread == false {
            self.requested = false
        }
    }

    mutating func shouldPatch(key: String, unread: Bool?) -> Int? {
        guard !key.isEmpty else { return nil }
        self.activate(key: key)
        if unread == false {
            self.requested = false
            return nil
        }
        guard unread == true, !self.requested else { return nil }
        self.requested = true
        return self.advanceRevision(key: key)
    }

    mutating func activate(key: String) {
        guard key != self.activeSessionKey else { return }
        self.activeSessionKey = key
        self.requested = false
        self.activeExplicitUnread = nil
    }

    mutating func beginExplicitPatch(key: String, unread: Bool, isActive: Bool) -> Int {
        let revision = self.advanceRevision(key: key)
        self.pendingExplicitRevisions[key] = revision
        self.pendingExplicitUnreadByKey[key] = unread
        if isActive {
            self.activeSessionKey = key
            // The explicit action owns this activation. Only navigation opens
            // the next episode; stale list snapshots cannot undo the action.
            self.requested = true
            self.activeExplicitUnread = unread
        }
        return revision
    }

    mutating func patchSucceeded(key: String, unread: Bool, revision: Int) -> Bool {
        guard self.revisions[key] == revision else { return false }
        if self.pendingExplicitRevisions[key] == revision {
            self.pendingExplicitRevisions.removeValue(forKey: key)
            self.pendingExplicitUnreadByKey.removeValue(forKey: key)
        }
        self.confirmedUnreadByKey[key] = unread
        return true
    }

    mutating func patchFailed(key: String, revision: Int) -> Bool {
        guard self.revisions[key] == revision else { return false }
        if self.pendingExplicitRevisions[key] == revision {
            self.pendingExplicitRevisions.removeValue(forKey: key)
            self.pendingExplicitUnreadByKey.removeValue(forKey: key)
        }
        if key == self.activeSessionKey {
            self.requested = false
            self.activeExplicitUnread = nil
        }
        return true
    }

    func confirmedUnread(key: String) -> Bool? {
        self.confirmedUnreadByKey[key]
    }

    func localUnreadOverride(key: String) -> Bool? {
        if let unread = self.pendingExplicitUnreadByKey[key] {
            return unread
        }
        guard key == self.activeSessionKey else { return nil }
        return self.activeExplicitUnread
    }

    private mutating func advanceRevision(key: String) -> Int {
        let revision = self.revisions[key, default: 0] + 1
        self.revisions[key] = revision
        return revision
    }
}

@MainActor
final class ChatSessionUnreadMutationQueue {
    private struct Tail {
        let id: Int
        let task: Task<Void, Never>
    }

    private var nextID = 0
    private var tails: [String: Tail] = [:]

    func reserve(
        routeLease: Task<OpenClawChatSessionMutationRouteLease?, Never>,
        queueKey: String,
        routeKey: String,
        unread: Bool) -> Task<Void, Error>
    {
        let previous = self.tails[queueKey]?.task
        self.nextID += 1
        let id = self.nextID
        let operation = Task { @MainActor in
            let resolvedRouteLease = await routeLease.value
            await previous?.value
            guard let resolvedRouteLease else {
                throw OpenClawChatTransportSendError.notDispatched
            }
            try await resolvedRouteLease.patchSession(
                key: routeKey,
                label: nil,
                category: nil,
                pinned: nil,
                archived: nil,
                unread: unread)
        }
        let tail = Task { @MainActor in
            _ = try? await operation.value
        }
        self.tails[queueKey] = Tail(id: id, task: tail)
        Task { @MainActor in
            await tail.value
            if self.tails[queueKey]?.id == id {
                self.tails.removeValue(forKey: queueKey)
            }
        }
        return operation
    }
}
