import Foundation

/// Pure grouping/filtering for the macOS sessions sidebar. Kept UI-free so the
/// pin/search/ordering rules stay unit-testable.
enum ChatSessionSidebarModel {
    struct Section: Identifiable, Equatable {
        let id: String
        let title: String?
        let sessions: [OpenClawChatSessionEntry]
    }

    static func isHiddenInternalSession(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return trimmed == "onboarding" || trimmed.hasSuffix(":onboarding")
    }

    @MainActor
    static func sections(
        sessions: [OpenClawChatSessionEntry],
        currentSessionKey: String,
        mainSessionKey: String = "main",
        activeAgentID: String? = nil,
        query: String) -> [Section]
    {
        let visible = self.visibleSessions(
            sessions: sessions,
            currentSessionKey: currentSessionKey,
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID,
            query: query)
        let pinned = visible.filter { $0.pinned == true }
        let recent = visible.filter { $0.pinned != true }

        var result: [Section] = []
        if !pinned.isEmpty {
            result.append(Section(id: "pinned", title: "Pinned", sessions: pinned))
        }
        if !recent.isEmpty {
            result.append(Section(
                id: "recent",
                title: pinned.isEmpty ? nil : "Recent",
                sessions: recent))
        }
        return result
    }

    static func displayName(for session: OpenClawChatSessionEntry) -> String {
        for candidate in [session.displayName, session.label] {
            if let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
               !trimmed.isEmpty
            {
                return trimmed
            }
        }
        return self.displayName(forKey: session.key)
    }

    static func canDeleteSession(key: String, mainSessionKey: String) -> Bool {
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedMain = mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized != "main" && normalized != "global" && normalized != normalizedMain
    }

    @MainActor
    static func selectedSessionKey(
        sessions: [OpenClawChatSessionEntry],
        currentSessionKey: String,
        mainSessionKey: String,
        activeAgentID: String?) -> String
    {
        let normalizedCurrent = currentSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedAgent = activeAgentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let preferredAliasKey = if normalizedCurrent == "global",
                                   let normalizedAgent,
                                   !normalizedAgent.isEmpty
        {
            "agent:\(normalizedAgent):global"
        } else if normalizedCurrent == "main" {
            mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        } else {
            ""
        }
        // The selected wrapper is the active session even when archived;
        // active rows stay visible until the user leaves them.
        if let preferred = sessions.first(where: { $0.key.lowercased() == preferredAliasKey }) {
            return preferred.key
        }
        if sessions.contains(where: { $0.key == currentSessionKey }) {
            return currentSessionKey
        }
        return sessions.first(where: {
            OpenClawChatViewModel.matchesCurrentSessionKey(
                incoming: $0.key,
                current: currentSessionKey,
                mainSessionKey: mainSessionKey,
                activeAgentId: activeAgentID)
        })?.key ?? currentSessionKey
    }

    /// Session keys read as routing ids ("agent:main:main"); show the human
    /// part and keep the owning agent as a suffix only when it disambiguates.
    static func displayName(forKey key: String) -> String {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "agent" else {
            return trimmed.isEmpty ? key : trimmed
        }
        let agent = String(parts[1])
        let session = String(parts[2])
        if session.isEmpty {
            return trimmed
        }
        return agent == "main" || agent.isEmpty ? session : "\(session) (\(agent))"
    }

    @MainActor
    private static func visibleSessions(
        sessions: [OpenClawChatSessionEntry],
        currentSessionKey: String,
        mainSessionKey: String,
        activeAgentID: String?,
        query: String) -> [OpenClawChatSessionEntry]
    {
        let selectedSessionKey = self.selectedSessionKey(
            sessions: sessions,
            currentSessionKey: currentSessionKey,
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID)
        let normalizedCurrent = currentSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let selectedIsResolvedAlias = (normalizedCurrent == "main" || normalizedCurrent == "global") &&
            selectedSessionKey.lowercased() != normalizedCurrent
        var entries = sessions.filter { entry in
            if selectedIsResolvedAlias, entry.key.lowercased() == normalizedCurrent {
                return false
            }
            return entry.key == selectedSessionKey ||
                (!self.isHiddenInternalSession(entry.key) && entry.archived != true)
        }
        if !entries.contains(where: { $0.key == selectedSessionKey }),
           !currentSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            // Sessions can lag behind a fresh switch/new-session; keep the
            // active row selectable instead of showing an empty selection.
            entries.append(self.placeholder(key: currentSessionKey))
        }
        entries.sort { (($0.updatedAt ?? $0.lastActivityAt) ?? 0) > (($1.updatedAt ?? $1.lastActivityAt) ?? 0) }

        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return entries }
        return entries.filter { entry in
            self.displayName(for: entry).lowercased().contains(needle) ||
                entry.key.lowercased().contains(needle)
        }
    }

    private static func placeholder(key: String) -> OpenClawChatSessionEntry {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: nil,
            model: nil,
            contextTokens: nil)
    }
}
