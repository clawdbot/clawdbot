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

    /// Returns true only when a session switch happened (create or reset
    /// fallback); callers keep UI like the new-session popover open on failure.
    @discardableResult
    func performStartNewSession(
        agentID: String? = nil,
        worktree: Bool,
        worktreeBaseRef: String? = nil,
        routeLease: OpenClawChatNewSessionRouteLease? = nil) async -> Bool
    {
        guard !self.blocksAttachmentOwnerChange else {
            self.errorText = String(
                localized: "Remove attachments or wait for delivery to resolve before starting a new chat.")
            return false
        }
        let normalizedAgentID = agentID?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let requestedAgentID = normalizedAgentID?.isEmpty == false ? normalizedAgentID : nil
        let requested = self.generatedNewSessionKey(agentID: requestedAgentID)
        // Only authoritative identities decide agent ownership; scanning the roster
        // could adopt an unrelated agent and hand sessions.create a cross-agent parent.
        let currentAgentID = (
            OpenClawChatSessionKey.agentID(from: self.sessionKey) ??
                self.activeAgentId ??
                OpenClawChatSessionKey.agentID(from: self.resolvedMainSessionKey))?
            .lowercased()
        let parentSessionKey = requestedAgentID == nil || requestedAgentID == currentAgentID
            ? self.sessionKey
            : nil
        let next: String
        do {
            let created = if let routeLease {
                try await routeLease.createSession(
                    key: requested,
                    label: nil,
                    agentID: requestedAgentID,
                    parentSessionKey: parentSessionKey,
                    worktree: worktree ? true : nil,
                    worktreeBaseRef: worktree ? worktreeBaseRef : nil)
            } else {
                try await self.transport.createSession(
                    key: requested,
                    label: nil,
                    agentID: requestedAgentID,
                    parentSessionKey: parentSessionKey,
                    worktree: worktree ? true : nil,
                    worktreeBaseRef: worktree ? worktreeBaseRef : nil)
            }
            let createdKey = created.key.trimmingCharacters(in: .whitespacesAndNewlines)
            next = createdKey.isEmpty ? requested : createdKey
        } catch {
            if Self.isUnsupportedCreateSessionError(error) {
                // Reset only mimics a plain new chat; agent/worktree selections were
                // not honored, so advanced requests surface the error instead of
                // silently resetting the current session.
                guard requestedAgentID == nil, !worktree else {
                    chatUILogger.error("sessions.create unsupported; advanced options not honored")
                    self.errorText = error.localizedDescription
                    return false
                }
                chatUILogger.info("sessions.create unsupported; falling back to sessions.reset")
                await self.performReset()
                return true
            }
            chatUILogger.error("sessions.create failed \(error.localizedDescription, privacy: .public)")
            self.errorText = error.localizedDescription
            return false
        }
        guard !self.blocksAttachmentOwnerChange else {
            self.errorText = String(
                localized: "Remove attachments or wait for delivery to resolve before starting a new chat.")
            return false
        }
        self.adoptCreatedSession(next)
        return true
    }

    static func isUnsupportedCreateSessionError(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == "OpenClawChatTransport"
            && nsError.localizedDescription == "sessions.create not supported by this transport"
    }

    @discardableResult
    public func startNewSession(
        agentID: String? = nil,
        worktree: Bool = false,
        worktreeBaseRef: String? = nil) async -> Bool
    {
        await self.performStartNewSession(
            agentID: agentID,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef)
    }

    @discardableResult
    func startNewSession(
        agentID: String,
        worktree: Bool,
        worktreeBaseRef: String?,
        using routeLease: OpenClawChatNewSessionRouteLease) async -> Bool
    {
        await self.performStartNewSession(
            agentID: agentID,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef,
            routeLease: routeLease)
    }

    func newSessionRouteLease() async throws -> OpenClawChatNewSessionRouteLease {
        guard let routeLease = await self.transport.acquireNewSessionRouteLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        return routeLease
    }

    public func fetchSessionGroups() async throws -> [OpenClawChatSessionGroup] {
        let routeLease = try await self.sessionGroupsRouteLease()
        return try await self.fetchSessionGroups(using: routeLease)
    }

    func sessionGroupsRouteLease() async throws -> OpenClawChatSessionGroupsRouteLease {
        guard let routeLease = await self.transport.acquireSessionGroupsRouteLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        return routeLease
    }

    func fetchSessionGroups(
        using routeLease: OpenClawChatSessionGroupsRouteLease) async throws -> [OpenClawChatSessionGroup]
    {
        let response = try await routeLease.listGroups()
        return (response?.groups ?? []).sorted { lhs, rhs in
            lhs.position == rhs.position ? lhs.name < rhs.name : lhs.position < rhs.position
        }
    }

    @discardableResult
    func createSessionGroup(
        named rawName: String,
        using routeLease: OpenClawChatSessionGroupsRouteLease) async throws -> [OpenClawChatSessionGroup]
    {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return try await self.fetchSessionGroups(using: routeLease) }
        // Read-modify-write matches web group creation (app-sidebar-session-groups,
        // custom-groups); the gateway has no atomic add/CAS. A concurrent edit can
        // lose catalog names/order only — session categories are untouched by
        // sessions.groups.put, so memberships survive. Accepted tradeoff until the
        // gateway grows a revisioned groups API.
        let current = try await self.fetchSessionGroups(using: routeLease)
        let response = try await routeLease.putGroups(names: current.map(\.name) + [name])
        self.sessionGroupsRevision += 1
        return response.groups
    }

    @discardableResult
    func renameSessionGroup(
        _ name: String,
        to rawName: String,
        using routeLease: OpenClawChatSessionGroupsRouteLease) async throws -> [OpenClawChatSessionGroup]
    {
        let nextName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !nextName.isEmpty else { return try await self.fetchSessionGroups(using: routeLease) }
        let response = try await routeLease.renameGroup(name: name, to: nextName)
        self.sessionGroupsRevision += 1
        self.refreshSessions(limit: Self.sessionListFetchLimit)
        return response.groups
    }

    @discardableResult
    func deleteSessionGroup(
        _ name: String,
        using routeLease: OpenClawChatSessionGroupsRouteLease) async throws -> [OpenClawChatSessionGroup]
    {
        let response = try await routeLease.deleteGroup(name: name)
        self.sessionGroupsRevision += 1
        self.refreshSessions(limit: Self.sessionListFetchLimit)
        return response.groups
    }

    public func setSessionGroup(key: String, group: String?) async throws {
        let normalized = group?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextGroup = normalized?.isEmpty == false ? normalized : nil
        let routeLease = await self.transport.acquireSessionMutationRouteLease()
        guard let routeLease else { throw OpenClawChatTransportSendError.notDispatched }
        try await routeLease.patchSession(
            key: key,
            label: nil,
            category: .some(nextGroup),
            pinned: nil,
            archived: nil,
            unread: nil)
        if let index = self.sessions.firstIndex(where: { $0.key == key }) {
            self.sessions[index].category = nextGroup
        }
        self.refreshSessions(limit: Self.sessionListFetchLimit)
    }

    func performSessionBatch(
        sessions selectedSessions: [OpenClawChatSessionEntry],
        action: ChatSessionBatchAction) async -> ChatSessionBatchResult
    {
        let orderedKeys = selectedSessions.map(\.key)
        let entries = Dictionary(uniqueKeysWithValues: selectedSessions.map { ($0.key, $0) })
        let mainSessionKey = self.resolvedMainSessionKey
        let attachmentBlockedKeys = self.isAttachmentOwnerPinned
            ? Set(selectedSessions.filter {
                self.matchesCurrentSessionKey(incoming: $0.key, current: self.sessionKey)
            }.map(\.key))
            : []
        let routeLease = await self.transport.acquireSessionMutationRouteLease()
        guard let routeLease else {
            return ChatSessionBatchResult(
                succeededKeys: [],
                errorsByKey: Dictionary(uniqueKeysWithValues: orderedKeys.map {
                    ($0, String(localized: "Gateway changed before the thread operation started."))
                }))
        }
        let result = await ChatSessionBatchMutationRunner.run(keys: orderedKeys) { key in
            if let entry = entries[key] {
                switch action {
                case .archive where !ChatSessionSidebarModel.canArchiveSession(
                    entry,
                    mainSessionKey: mainSessionKey):
                    throw ChatSessionBatchValidationError.cannotArchive
                case .delete where !ChatSessionSidebarModel.canDeleteSession(
                    key: key,
                    mainSessionKey: mainSessionKey):
                    throw ChatSessionBatchValidationError.cannotDelete
                case .archive where attachmentBlockedKeys.contains(key),
                     .delete where attachmentBlockedKeys.contains(key):
                    throw ChatSessionBatchValidationError.attachmentOwnerPinned
                default:
                    break
                }
            }
            switch action {
            case .pin:
                try await routeLease.patchSession(
                    key: key,
                    label: nil,
                    category: nil,
                    pinned: true,
                    archived: nil,
                    unread: nil)
            case .unpin:
                try await routeLease.patchSession(
                    key: key,
                    label: nil,
                    category: nil,
                    pinned: false,
                    archived: nil,
                    unread: nil)
            case .archive:
                try await routeLease.patchSession(
                    key: key,
                    label: nil,
                    category: nil,
                    pinned: nil,
                    archived: true,
                    unread: nil)
            case .delete:
                try await routeLease.deleteSession(key: key)
            }
        }
        let succeeded = Set(result.succeededKeys)
        switch action {
        case .pin, .unpin:
            let pinned = action == .pin
            for index in self.sessions.indices where succeeded.contains(self.sessions[index].key) {
                self.sessions[index].pinned = pinned
                self.sessions[index].pinnedAt = pinned ? Date().timeIntervalSince1970 * 1000 : nil
            }
            self.sessions = OpenClawChatSessionListOrganizer.organize(self.sessions)
        case .archive, .delete:
            self.sessions.removeAll { succeeded.contains($0.key) }
            if succeeded.contains(where: {
                self.matchesCurrentSessionKey(incoming: $0, current: self.sessionKey)
            }) {
                self.switchSession(to: self.resolvedMainSessionKey)
            }
        }
        self.refreshSessions(limit: Self.sessionListFetchLimit)
        return result
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

    public func rewindToMessage(_ message: OpenClawChatMessage) async {
        guard let entryID = Self.sessionMutationEntryID(for: message) else { return }
        guard !self.hasBlockingRunActivity, !self.isSending, !self.isAborting else { return }
        let initiatingSession = self.currentSessionSnapshot()
        do {
            let result = try await self.transport.rewindSession(
                sessionKey: initiatingSession.key,
                entryId: entryID)
            guard self.isCurrentSession(initiatingSession) else { return }
            self.replyTarget = nil
            self.runMessageScopesByRunID.removeAll()
            self.provisionalFinalMessagesByID.removeAll()
            self.input = result.editorText ?? ""
            let historyRequest = self.beginHistoryRequest(for: initiatingSession)
            _ = await self.refreshHistoryAfterRun(historyRequest: historyRequest)
        } catch {
            self.errorText = error.localizedDescription
            chatSessionActionsLogger.error(
                "sessions.rewind failed \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Dispatch parity with forkSession(key:): per-request server-lease guards in the
    /// transport plus post-RPC staleness re-checks, not the patch-flow route lease,
    /// which does not expose fork/rewind and would widen the lease API for no sibling.
    public func forkAtMessage(_ message: OpenClawChatMessage) async {
        guard let entryID = Self.sessionMutationEntryID(for: message) else { return }
        guard !self.hasBlockingRunActivity, !self.isSending, !self.isAborting else { return }
        guard self.canCreateSessionForImmediateSwitch() else { return }
        let initiatingSession = self.currentSessionSnapshot()
        do {
            let result = try await self.transport.forkSessionAtMessage(
                sessionKey: initiatingSession.key,
                entryId: entryID)
            let createdKey = result.sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !createdKey.isEmpty else { return }
            guard self.isCurrentSession(initiatingSession),
                  !self.hasBlockingRunActivity,
                  !self.isSending,
                  !self.isAborting,
                  self.canCreateSessionForImmediateSwitch()
            else {
                self.refreshSessions(limit: Self.sessionListFetchLimit)
                return
            }
            self.switchSession(to: createdKey)
            guard self.sessionKey == createdKey else { return }
            self.input = result.editorText ?? ""
        } catch {
            self.errorText = error.localizedDescription
            chatSessionActionsLogger.error(
                "sessions.fork failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func sessionMutationEntryID(for message: OpenClawChatMessage) -> String? {
        guard message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user"
        else { return nil }
        let entryID = message.transcriptMessageID?.trimmingCharacters(in: .whitespacesAndNewlines)
        return entryID?.isEmpty == false ? entryID : nil
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
