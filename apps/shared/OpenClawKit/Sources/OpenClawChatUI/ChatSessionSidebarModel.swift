import Foundation
import OpenClawProtocol

/// Pure grouping/filtering shared by the Apple sessions sidebars. Kept UI-free
/// so pin/search/ordering rules stay unit-testable across macOS and iOS.
public enum ChatSessionSidebarModel {
    public struct Badges: Equatable, Sendable {
        public let runningCount: Int
        public let failedCount: Int
        public let hasUnread: Bool
    }

    public struct Node: Identifiable, Equatable, Sendable {
        public let session: OpenClawChatSessionEntry
        public let children: [Node]
        public let badges: Badges

        public var id: String {
            self.session.key
        }
    }

    public struct Section: Identifiable, Equatable, Sendable {
        public let id: String
        public let title: String?
        public let nodes: [Node]
    }

    public static func isHiddenInternalSession(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return trimmed == "onboarding" || trimmed.hasSuffix(":onboarding")
    }

    /// `excludesMainSession` is for sidebars with a dedicated Home row (iOS);
    /// the macOS sidebar keeps the main session inside its sections.
    @MainActor
    public static func sections(
        sessions: [OpenClawChatSessionEntry],
        currentSessionKey: String,
        mainSessionKey: String = "main",
        activeAgentID: String? = nil,
        groups: [OpenClawChatSessionGroup] = [],
        excludesMainSession: Bool = false,
        query: String) -> [Section]
    {
        let visible = self.visibleSessions(
            sessions: sessions,
            currentSessionKey: currentSessionKey,
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID,
            excludesMainSession: excludesMainSession,
            query: query)
        // Pin state owns first placement. Group sections then preserve the
        // same tree builder, so grouped parent/child rosters still nest.
        let pinned = self.tree(from: visible.filter { $0.pinned == true })
        let unpinned = visible.filter { $0.pinned != true }
        let orderedGroups = groups.sorted { lhs, rhs in
            lhs.position == rhs.position ? lhs.name < rhs.name : lhs.position < rhs.position
        }
        let groupNames = Set(orderedGroups.map(\.name))
        let recent = self.tree(from: unpinned.filter { session in
            guard let category = session.category else { return true }
            return !groupNames.contains(category)
        })

        var result: [Section] = []
        if !pinned.isEmpty {
            result.append(Section(id: "pinned", title: "Pinned", nodes: pinned))
        }
        for group in orderedGroups {
            let nodes = self.tree(from: unpinned.filter { $0.category == group.name })
            if !nodes.isEmpty {
                result.append(Section(id: "group:\(group.name)", title: group.name, nodes: nodes))
            }
        }
        if !recent.isEmpty {
            result.append(Section(
                id: "recent",
                title: result.isEmpty ? nil : "Recent",
                nodes: recent))
        }
        return result
    }

    static func tree(from sessions: [OpenClawChatSessionEntry]) -> [Node] {
        let hierarchyPresent = sessions.contains { session in
            self.normalizedKey(session.spawnedBy) != nil ||
                self.normalizedKey(session.parentSessionKey) != nil ||
                session.childSessions != nil
        }
        guard hierarchyPresent else {
            return sessions.map { self.node(session: $0, children: []) }
        }

        var entriesByKey: [String: OpenClawChatSessionEntry] = [:]
        for session in sessions where entriesByKey[session.key] == nil {
            entriesByKey[session.key] = session
        }
        var parentByChild: [String: String] = [:]
        // The gateway child roster is freshness-filtered and omitted when
        // empty. Persisted parent metadata can outlive that freshness window,
        // so it is display metadata only and must not recreate stale edges.
        for parent in sessions {
            for childKey in parent.childSessions ?? [] where childKey != parent.key {
                if entriesByKey[childKey] != nil, parentByChild[childKey] == nil {
                    parentByChild[childKey] = parent.key
                }
            }
        }

        var orderByKey: [String: Int] = [:]
        for (offset, session) in sessions.enumerated() where orderByKey[session.key] == nil {
            orderByKey[session.key] = offset
        }
        for session in sessions {
            var path: [String] = []
            var indexByKey: [String: Int] = [:]
            var cursor: String? = session.key
            while let current = cursor, let parent = parentByChild[current] {
                indexByKey[current] = path.count
                path.append(current)
                if let cycleStart = indexByKey[parent] {
                    let cycle = path[cycleStart...]
                    let root = cycle.min { (orderByKey[$0] ?? Int.max) < (orderByKey[$1] ?? Int.max) }
                    if let root {
                        parentByChild[root] = nil
                    }
                    break
                }
                cursor = parent
            }
        }

        var childrenByParent: [String: [OpenClawChatSessionEntry]] = [:]
        for session in sessions {
            if let parentKey = parentByChild[session.key] {
                childrenByParent[parentKey, default: []].append(session)
            }
        }

        func build(_ session: OpenClawChatSessionEntry, ancestors: Set<String>) -> Node {
            guard !ancestors.contains(session.key) else {
                return Self.node(session: session, children: [])
            }
            var nextAncestors = ancestors
            nextAncestors.insert(session.key)
            let children = (childrenByParent[session.key] ?? []).map {
                build($0, ancestors: nextAncestors)
            }
            return Self.node(session: session, children: children)
        }

        return sessions.compactMap { session in
            guard parentByChild[session.key] == nil else { return nil }
            return build(session, ancestors: [])
        }
    }

    private static func node(session: OpenClawChatSessionEntry, children: [Node]) -> Node {
        let status = session.status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let isRunning = session.hasActiveRun == true || session.hasActiveSubagentRun == true || status == "running"
        let hasFailed = status == "failed" || status == "timeout"
        return Node(
            session: session,
            children: children,
            badges: Badges(
                runningCount: (isRunning ? 1 : 0) + children.reduce(0) { $0 + $1.badges.runningCount },
                failedCount: (hasFailed ? 1 : 0) + children.reduce(0) { $0 + $1.badges.failedCount },
                hasUnread: session.unread == true || children.contains { $0.badges.hasUnread }))
    }

    private static func normalizedKey(_ key: String?) -> String? {
        let trimmed = key?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    public static func displayName(for session: OpenClawChatSessionEntry) -> String {
        for candidate in [session.displayName, session.label] {
            if let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
               !trimmed.isEmpty
            {
                return trimmed
            }
        }
        return self.displayName(forKey: session.key)
    }

    /// Compact "repo \u{2387} branch" line for worktree/work sessions; mirrors the
    /// web sidebar row subtitle (ui/src/lib/session-display.ts).
    public static func workSubtitle(for session: OpenClawChatSessionEntry) -> String? {
        let repoRoot = session.worktree?.repoRoot?.trimmingCharacters(in: .whitespacesAndNewlines)
        let branch = session.worktree?.branch?.trimmingCharacters(in: .whitespacesAndNewlines)
        let repoName = repoRoot?.split(separator: "/").last.map(String.init)
        let shortBranch = branch.map { $0.hasPrefix("openclaw/") ? String($0.dropFirst("openclaw/".count)) : $0 }
        guard let repoName, !repoName.isEmpty else { return nil }
        guard let shortBranch, !shortBranch.isEmpty else { return repoName }
        return "\(repoName) \u{2387} \(shortBranch)"
    }

    /// Resolves the single session-list subtitle slot with the same ownership
    /// order as the web sidebar. Gateway-supplied text stays verbatim.
    public static func subtitle(
        for session: OpenClawChatSessionEntry,
        workSubtitle: String?,
        now: Double = Date().timeIntervalSince1970 * 1000) -> String?
    {
        let agentStatus = self.activeAgentStatus(session.agentStatus, now: now)
        let declaredAttention = agentStatus?.attention == nil ? nil : agentStatus?.note
        let failedAttention = self.unreadFailureReason(for: session)
        let statusNote = agentStatus?.note
        let observer = self.visibleObserverDigest(for: session)?.headline
        return declaredAttention ?? failedAttention ?? statusNote ?? observer ?? workSubtitle
    }

    /// Live observer events are useful only after a server row names the
    /// active run. This prevents a late event from a prior run taking over a
    /// replacement run that reused the same session key.
    public static func applying(
        observerDigest digest: SessionObserverDigest,
        to sessions: [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry]
    {
        guard let index = sessions.firstIndex(where: { $0.key == digest.sessionkey }) else { return sessions }
        var session = sessions[index]
        let candidate = OpenClawChatSessionObserverDigest(digest)
        let activeRunIds = self.normalizedActiveRunIds(session.activeRunIds)
        guard self.isRunning(session),
              let runId = normalized(candidate.runId),
              activeRunIds.contains(runId)
        else { return sessions }

        if let previous = session.observerDigest,
           previous.runId == candidate.runId,
           !self.isNewer(candidate, than: previous)
        {
            return sessions
        }

        session.observerDigest = candidate
        var updated = sessions
        updated[index] = session
        return updated
    }

    /// Session snapshots own rollover and clearing. A projected digest may
    /// advance a live one, while an active-run change immediately retires any
    /// digest that no longer belongs to a server-reported run.
    public static func applying(
        sessionChange change: OpenClawChatSessionsChangedEvent,
        to sessions: [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry]?
    {
        guard let key = change.sessionKey else { return sessions }
        guard let index = sessions.firstIndex(where: { $0.key == key }) else { return nil }

        var session = sessions[index]
        if let updatedAt = change.updatedAt {
            session.updatedAt = updatedAt
        }
        if let lastReadAt = change.lastReadAt {
            session.lastReadAt = lastReadAt
        }
        if change.agentStatusPresent {
            session.agentStatus = change.agentStatus
        }
        if change.statusPresent {
            session.status = change.status
        }
        if change.lastRunErrorPresent {
            session.lastRunError = change.lastRunError
        }
        if let hasActiveRun = change.hasActiveRun {
            session.hasActiveRun = hasActiveRun
        }
        if let activeRunIds = change.activeRunIds {
            session.activeRunIds = activeRunIds
        }
        if let startedAt = change.startedAt {
            session.startedAt = startedAt
        }
        if let endedAt = change.endedAt {
            session.endedAt = endedAt
        }

        let activeRunIds = self.normalizedActiveRunIds(session.activeRunIds)
        if self.isRunning(session),
           self.normalized(session.observerDigest?.runId).map(activeRunIds.contains) != true
        {
            session.observerDigest = nil
        }
        if change.observerDigestPresent {
            if let projected = change.observerDigest {
                let matchesActiveRun = !self.isRunning(session) ||
                    self.normalized(projected.runId).map(activeRunIds.contains) == true
                if matchesActiveRun {
                    if let previous = session.observerDigest,
                       previous.runId == projected.runId
                    {
                        if self.isNewer(projected, than: previous) {
                            session.observerDigest = projected
                        }
                    } else {
                        session.observerDigest = projected
                    }
                }
            } else {
                session.observerDigest = nil
            }
        }

        var updated = sessions
        updated[index] = session
        return updated
    }

    private static func visibleObserverDigest(
        for session: OpenClawChatSessionEntry) -> OpenClawChatSessionObserverDigest?
    {
        guard let digest = session.observerDigest else { return nil }
        if self.isRunning(session) {
            let activeRunIds = self.normalizedActiveRunIds(session.activeRunIds)
            guard let runId = normalized(digest.runId),
                  activeRunIds.contains(runId)
            else { return nil }
            return digest
        }
        let health = digest.health.lowercased()
        guard health == "done" || health == "failed",
              (session.lastReadAt ?? 0) < digest.updatedAt
        else { return nil }
        return digest
    }

    private static func activeAgentStatus(
        _ status: OpenClawChatSessionAgentStatus?,
        now: Double) -> OpenClawChatSessionAgentStatus?
    {
        guard let status,
              status.expiresAt > now,
              !status.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return status
    }

    private static func unreadFailureReason(for session: OpenClawChatSessionEntry) -> String? {
        let status = session.status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard status == "failed" || status == "timeout" else { return nil }
        let failureAt = session.endedAt ?? session.updatedAt ?? 0
        guard (session.lastReadAt ?? 0) < failureAt else { return nil }
        return self.normalized(session.lastRunError)
    }

    private static func isRunning(_ session: OpenClawChatSessionEntry) -> Bool {
        session.hasActiveRun == true ||
            session.status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "running"
    }

    private static func isNewer(
        _ candidate: OpenClawChatSessionObserverDigest,
        than previous: OpenClawChatSessionObserverDigest) -> Bool
    {
        candidate.revision > previous.revision ||
            (candidate.revision == previous.revision && candidate.updatedAt > previous.updatedAt)
    }

    private static func normalized(_ value: String?) -> String? {
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized?.isEmpty == false ? normalized : nil
    }

    private static func normalizedActiveRunIds(_ runIds: [String]?) -> Set<String> {
        Set((runIds ?? []).compactMap(self.normalized))
    }

    public static func canDeleteSession(key: String, mainSessionKey: String) -> Bool {
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedMain = mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized != "main" && normalized != "global" && normalized != normalizedMain
    }

    public static func canArchiveSession(
        _ session: OpenClawChatSessionEntry,
        mainSessionKey: String) -> Bool
    {
        let status = session.status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return self.canDeleteSession(key: session.key, mainSessionKey: mainSessionKey) &&
            session.hasActiveRun != true &&
            session.hasActiveSubagentRun != true &&
            status != "running"
    }

    static func isSessionInActiveAgentScope(key: String, activeAgentID: String?) -> Bool {
        let normalizedAgent = activeAgentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        guard !normalizedAgent.isEmpty else { return true }
        let parts = key.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].lowercased() == "agent" else { return true }
        return parts[1].lowercased() == normalizedAgent
    }

    @MainActor
    public static func selectedSessionKey(
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
    public static func displayName(forKey key: String) -> String {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "agent" else {
            return trimmed.isEmpty ? key : trimmed
        }
        let agent = String(parts[1])
        let session = String(parts[2])
        if session.isEmpty { return trimmed }
        return agent == "main" || agent.isEmpty ? session : "\(session) (\(agent))"
    }

    @MainActor
    private static func visibleSessions(
        sessions: [OpenClawChatSessionEntry],
        currentSessionKey: String,
        mainSessionKey: String,
        activeAgentID: String?,
        excludesMainSession: Bool,
        query: String) -> [OpenClawChatSessionEntry]
    {
        let scopedSessions = sessions.filter {
            self.isSessionInActiveAgentScope(key: $0.key, activeAgentID: activeAgentID)
        }
        let selectedSessionKey = self.selectedSessionKey(
            sessions: scopedSessions,
            currentSessionKey: currentSessionKey,
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID)
        let resolvedMainSessionKey = self.selectedSessionKey(
            sessions: scopedSessions,
            currentSessionKey: "main",
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID)
        let normalizedCurrent = currentSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let selectedIsResolvedAlias = (normalizedCurrent == "main" || normalizedCurrent == "global") &&
            selectedSessionKey.lowercased() != normalizedCurrent
        let selectedIsMain = normalizedCurrent == "main" ||
            selectedSessionKey.caseInsensitiveCompare(resolvedMainSessionKey) == .orderedSame
        var entries = scopedSessions.filter { entry in
            if excludesMainSession,
               entry.key.caseInsensitiveCompare(resolvedMainSessionKey) == .orderedSame
            {
                // Home owns the main row. Removing it before tree construction
                // naturally promotes any retained child rows to section roots.
                return false
            }
            if selectedIsResolvedAlias, entry.key.lowercased() == normalizedCurrent {
                return false
            }
            return entry.key == selectedSessionKey ||
                (!self.isHiddenInternalSession(entry.key) && entry.archived != true)
        }
        if !(excludesMainSession && selectedIsMain),
           !entries.contains(where: { $0.key == selectedSessionKey }),
           self.isSessionInActiveAgentScope(key: selectedSessionKey, activeAgentID: activeAgentID),
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
