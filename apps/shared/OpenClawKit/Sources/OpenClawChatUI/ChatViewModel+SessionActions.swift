import Foundation
import OSLog

private let chatSessionActionsLogger = Logger(
    subsystem: "ai.openclaw",
    category: "OpenClawChat")

extension OpenClawChatViewModel {
    public func refreshSessions(limit: Int? = nil) {
        let context = self.currentSessionSnapshot()
        Task { await self.fetchSessions(limit: limit, sessionSnapshot: context) }
    }

    public func startNewSession(worktree: Bool = false) async {
        await self.performStartNewSession(worktree: worktree)
    }

    public func requestSessionReset() {
        Task { await self.performReset() }
    }

    public func requestSessionCompact() {
        Task { await self.performCompact() }
    }

    public func fetchSessionList(search: String?, archived: Bool) async -> [OpenClawChatSessionEntry] {
        let normalizedSearch = search?.trimmingCharacters(in: .whitespacesAndNewlines)
        let query = normalizedSearch?.isEmpty == false ? normalizedSearch : nil
        do {
            let res = try await self.transport.listSessions(
                limit: Self.sessionListFetchLimit,
                search: query,
                archived: archived)
            return OpenClawChatSessionListOrganizer.organize(res.sessions)
        } catch {
            // A superseded (cancelled) fetch must not produce fallback rows;
            // the newer task owns the scoped list. Callers also guard on
            // Task.isCancelled before applying results.
            guard !(error is CancellationError), !Task.isCancelled else { return [] }
            guard !archived else { return [] }
            guard let query else { return self.sessions }
            return OpenClawChatSessionListOrganizer.filter(self.sessions, search: query)
        }
    }

    public func renameSession(key: String, label: String) {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextLabel: String? = trimmed.isEmpty ? nil : trimmed
        let previous = self.sessions
        if let index = self.sessions.firstIndex(where: { $0.key == key }) {
            self.sessions[index].label = nextLabel
            self.sessions[index].displayName = nextLabel
        }
        Task {
            do {
                try await self.transport.patchSession(
                    key: key,
                    label: .some(nextLabel),
                    category: nil,
                    pinned: nil,
                    archived: nil,
                    unread: nil)
                self.refreshSessions()
            } catch {
                self.sessions = self.applyingLocalUnreadOverrides(to: previous)
                self.errorText = error.localizedDescription
                chatSessionActionsLogger.error(
                    "sessions.patch(label) failed \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    public func forkSession(key: String) async {
        guard self.canCreateSessionForImmediateSwitch() else { return }
        let initiatingSession = self.currentSessionSnapshot()
        do {
            let createdKey = try await self.transport.forkSession(parentKey: key)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !createdKey.isEmpty else { return }
            guard self.isCurrentSession(initiatingSession), self.canCreateSessionForImmediateSwitch() else {
                self.refreshSessions(limit: Self.sessionListFetchLimit)
                return
            }
            self.switchSession(to: createdKey)
        } catch {
            self.errorText = error.localizedDescription
            chatSessionActionsLogger.error(
                "sessions.create(fork) failed \(error.localizedDescription, privacy: .public)")
        }
    }

    public func setSessionUnread(key: String, unread: Bool) {
        let identityKey = self.sessionMutationIdentity(for: key)
        let previousEntry = self.sessions.first(where: { $0.key == key })
        let rollbackUnread = self.unreadPatchGuard.confirmedUnread(key: identityKey) ?? previousEntry?.unread
        let revision = self.unreadPatchGuard.beginExplicitPatch(
            key: identityKey,
            unread: unread,
            isActive: self.matchesCurrentSessionKey(incoming: key, current: self.sessionKey))
        if let index = self.sessions.firstIndex(where: { $0.key == key }) {
            self.sessions[index].unread = unread
        }
        let routeLease = Task { await self.transport.acquireSessionMutationRouteLease() }
        let operation = self.unreadMutationQueue.reserve(
            routeLease: routeLease,
            queueKey: identityKey,
            routeKey: key,
            unread: unread)
        Task {
            do {
                try await operation.value
                guard self.unreadPatchGuard.patchSucceeded(
                    key: identityKey,
                    unread: unread,
                    revision: revision)
                else { return }
                self.refreshSessions()
            } catch {
                guard self.unreadPatchGuard.patchFailed(key: identityKey, revision: revision) else { return }
                if let index = self.sessions.firstIndex(where: { $0.key == key }),
                   self.sessions[index].unread == unread
                {
                    self.sessions[index].unread = rollbackUnread
                }
                self.refreshSessions()
                self.errorText = error.localizedDescription
                chatSessionActionsLogger.error(
                    "sessions.patch(unread) failed \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    public func setSessionPinned(key: String, pinned: Bool) {
        let previous = self.sessions
        if let index = self.sessions.firstIndex(where: { $0.key == key }) {
            self.sessions[index].pinned = pinned
            self.sessions[index].pinnedAt = pinned ? Date().timeIntervalSince1970 * 1000 : nil
            self.sessions = OpenClawChatSessionListOrganizer.organize(self.sessions)
        }
        Task {
            do {
                try await self.transport.patchSession(
                    key: key,
                    label: nil,
                    category: nil,
                    pinned: pinned,
                    archived: nil,
                    unread: nil)
                self.refreshSessions()
            } catch {
                self.sessions = self.applyingLocalUnreadOverrides(to: previous)
                self.errorText = error.localizedDescription
                chatSessionActionsLogger.error(
                    "sessions.patch(pinned) failed \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    public func setSessionArchived(key: String, archived: Bool) {
        guard archived else {
            Task { await self.restoreSession(key: key) }
            return
        }
        let previous = self.sessions
        self.sessions.removeAll { $0.key == key }
        Task {
            do {
                try await self.transport.patchSession(
                    key: key,
                    label: nil,
                    category: nil,
                    pinned: nil,
                    archived: true,
                    unread: nil)
                if self.matchesCurrentSessionKey(incoming: key, current: self.sessionKey) {
                    // The archived session rejects new sends; move the user back
                    // to the main session instead of leaving a dead composer.
                    self.switchSession(to: self.resolvedMainSessionKey)
                }
                self.refreshSessions()
            } catch {
                self.sessions = self.applyingLocalUnreadOverrides(to: previous)
                self.errorText = error.localizedDescription
                chatSessionActionsLogger.error(
                    "sessions.patch(archived) failed \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Restores an archived session. Returns false (with `errorText` set) on
    /// failure so open-flows can avoid switching into a still-archived session.
    @discardableResult
    public func restoreSession(key: String) async -> Bool {
        do {
            try await self.transport.patchSession(
                key: key,
                label: nil,
                category: nil,
                pinned: nil,
                archived: false,
                unread: nil)
            self.refreshSessions()
            return true
        } catch {
            self.errorText = error.localizedDescription
            chatSessionActionsLogger.error(
                "sessions.patch(archived=false) failed \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func markCurrentSessionReadAfterActivation(
        _ session: SessionSnapshot,
        fallbackEntry: OpenClawChatSessionEntry?) async
    {
        guard self.isCurrentSession(session), self.hasAppliedLiveHistory,
              let entry = self.currentSessionEntry() ?? fallbackEntry,
              let revision = self.unreadPatchGuard.shouldPatch(
                  key: self.sessionMutationIdentity(for: entry.key, listedKey: entry.key),
                  unread: entry.unread)
        else { return }
        let identityKey = self.sessionMutationIdentity(for: entry.key, listedKey: entry.key)
        let routeLease = Task { await self.transport.acquireSessionMutationRouteLease() }
        let operation = self.unreadMutationQueue.reserve(
            routeLease: routeLease,
            queueKey: identityKey,
            routeKey: entry.key,
            unread: false)
        do {
            try await operation.value
            guard self.unreadPatchGuard.patchSucceeded(
                key: identityKey,
                unread: false,
                revision: revision)
            else { return }
            if let index = self.sessions.firstIndex(where: { $0.key == entry.key }) {
                self.sessions[index].unread = false
            }
        } catch {
            guard self.unreadPatchGuard.patchFailed(key: identityKey, revision: revision) else { return }
            chatSessionActionsLogger.error(
                "sessions.patch(unread=false) failed \(error.localizedDescription, privacy: .public)")
        }
    }
}
