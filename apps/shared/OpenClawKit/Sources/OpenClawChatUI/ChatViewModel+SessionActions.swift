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

    public func setSessionPinned(_ sessionKey: String, pinned: Bool) {
        Task {
            do {
                try await self.transport.patchSession(
                    key: sessionKey,
                    label: nil,
                    category: nil,
                    pinned: pinned,
                    archived: nil,
                    unread: nil)
            } catch {
                self.errorText = error.localizedDescription
                return
            }
            await self.fetchSessions(limit: nil, sessionSnapshot: self.currentSessionSnapshot())
        }
    }

    /// One-shot session list fetch for search and archived browsing. Falls back
    /// to locally filtering the cached active list when the gateway is
    /// unreachable; archived rows exist only server-side, so archived mode
    /// returns empty offline.
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
        guard !trimmed.isEmpty else { return }
        let previous = self.sessions
        if let index = self.sessions.firstIndex(where: { $0.key == key }) {
            self.sessions[index].label = trimmed
            self.sessions[index].displayName = trimmed
        }
        Task {
            do {
                try await self.transport.patchSession(
                    key: key,
                    label: trimmed,
                    category: nil,
                    pinned: nil,
                    archived: nil,
                    unread: nil)
                self.refreshSessions()
            } catch {
                self.sessions = previous
                self.errorText = error.localizedDescription
                chatSessionActionsLogger.error(
                    "sessions.patch(label) failed \(error.localizedDescription, privacy: .public)")
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
                self.sessions = previous
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
                if key == self.sessionKey {
                    // The archived session rejects new sends; move the user back
                    // to the main session instead of leaving a dead composer.
                    self.switchSession(to: self.resolvedMainSessionKey)
                }
                self.refreshSessions()
            } catch {
                self.sessions = previous
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
}
