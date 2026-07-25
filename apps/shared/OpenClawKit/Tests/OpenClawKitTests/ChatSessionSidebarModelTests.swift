import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarModelTests {
    private func entry(
        key: String,
        displayName: String? = nil,
        updatedAt: Double? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil,
        lastReadAt: Double? = nil,
        category: String? = nil,
        parentSessionKey: String? = nil,
        spawnedBy: String? = nil,
        childSessions: [String]? = nil,
        status: String? = nil,
        lastRunError: String? = nil,
        hasActiveRun: Bool? = nil,
        activeRunIds: [String]? = nil,
        agentStatus: OpenClawChatSessionAgentStatus? = nil,
        observerDigest: OpenClawChatSessionObserverDigest? = nil,
        endedAt: Double? = nil,
        hasActiveSubagentRun: Bool? = nil) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: displayName,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: updatedAt,
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
            contextTokens: nil,
            category: category,
            pinned: pinned,
            archived: archived,
            unread: unread,
            agentStatus: agentStatus,
            observerDigest: observerDigest,
            lastReadAt: lastReadAt,
            parentSessionKey: parentSessionKey,
            spawnedBy: spawnedBy,
            childSessions: childSessions,
            status: status,
            lastRunError: lastRunError,
            hasActiveRun: hasActiveRun,
            activeRunIds: activeRunIds,
            hasActiveSubagentRun: hasActiveSubagentRun,
            endedAt: endedAt)
    }

    @Test func `pinned sessions get their own section, rest sorted by recency`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(key: "a", updatedAt: 100),
                self.entry(key: "b", updatedAt: 300, pinned: true),
                self.entry(key: "c", updatedAt: 200),
            ],
            currentSessionKey: "a",
            query: "")

        #expect(sections.map(\.id) == ["pinned", "recent"])
        #expect(sections[0].nodes.map(\.session.key) == ["b"])
        #expect(sections[1].nodes.map(\.session.key) == ["c", "a"])
        #expect(sections[1].title == "Recent")
    }

    @Test func `single unpinned section carries no title`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [self.entry(key: "a", updatedAt: 100)],
            currentSessionKey: "a",
            query: "")

        #expect(sections.count == 1)
        #expect(sections[0].title == nil)
    }

    @Test func `gateway groups render between pinned and recent and retain trees`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(key: "pinned", pinned: true),
                self.entry(key: "parent", category: "Projects", childSessions: ["child"]),
                self.entry(key: "child", category: "Projects", parentSessionKey: "parent"),
                self.entry(key: "recent"),
            ],
            currentSessionKey: "recent",
            groups: [OpenClawChatSessionGroup(name: "Projects", position: 0)],
            query: "")

        #expect(sections.map(\.id) == ["pinned", "group:Projects", "recent"])
        #expect(sections[1].nodes.map(\.id) == ["parent"])
        #expect(sections[1].nodes[0].children.map(\.id) == ["child"])
    }

    @Test func `group placement uses exact gateway category names`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(key: "exact", category: "Projects"),
                self.entry(key: "case", category: "projects"),
                self.entry(key: "spaces", category: " Projects "),
            ],
            currentSessionKey: "exact",
            groups: [OpenClawChatSessionGroup(name: "Projects", position: 0)],
            query: "")

        #expect(sections.map(\.id) == ["group:Projects", "recent"])
        #expect(sections[0].nodes.map(\.session.key) == ["exact"])
        #expect(Set(sections[1].nodes.map(\.session.key)) == Set(["case", "spaces"]))
    }

    @Test func `pinned descendants move to pinned section independently`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(key: "parent", updatedAt: 200),
                self.entry(key: "child", updatedAt: 100, pinned: true, parentSessionKey: "parent"),
            ],
            currentSessionKey: "parent",
            query: "")

        #expect(sections.map(\.id) == ["pinned", "recent"])
        #expect(sections[0].nodes.map(\.id) == ["child"])
        #expect(sections[1].nodes.map(\.id) == ["parent"])
    }

    @Test func `hides onboarding and archived sessions, keeps the active one`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(key: "agent:main:onboarding", updatedAt: 500),
                self.entry(key: "gone", updatedAt: 400, archived: true),
                self.entry(key: "main", updatedAt: 300),
            ],
            currentSessionKey: "main",
            query: "")

        // Default (macOS) sections keep the main row; only Home-row sidebars
        // opt into excludesMainSession.
        #expect(sections.flatMap(\.nodes).map(\.session.key) == ["main"])
    }

    @Test func `active session gets a placeholder row before lists load`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [],
            currentSessionKey: "agent:main:main",
            query: "")

        #expect(sections.flatMap(\.nodes).map(\.session.key) == ["agent:main:main"])
    }

    @Test func `main aliases select the resolved row without adding a placeholder`() {
        let sessions = [self.entry(key: "agent:default:main", updatedAt: 100)]
        let sections = ChatSessionSidebarModel.sections(
            sessions: sessions,
            currentSessionKey: "main",
            mainSessionKey: "agent:default:main",
            activeAgentID: "default",
            excludesMainSession: true,
            query: "")

        #expect(sections.flatMap(\.nodes).isEmpty)
        #expect(ChatSessionSidebarModel.selectedSessionKey(
            sessions: sessions,
            currentSessionKey: "main",
            mainSessionKey: "agent:default:main",
            activeAgentID: "default") == "agent:default:main")
    }

    @Test func `agent scope keeps active agent and unprefixed sessions`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(key: "agent:ops:main", updatedAt: 400),
                self.entry(key: "agent:ops:deploy", updatedAt: 300),
                self.entry(key: "agent:other:private", updatedAt: 200),
                self.entry(key: "global-tool", updatedAt: 100),
            ],
            currentSessionKey: "main",
            mainSessionKey: "agent:ops:main",
            activeAgentID: "ops",
            excludesMainSession: true,
            query: "")

        #expect(sections.flatMap(\.nodes).map(\.session.key) == ["agent:ops:deploy", "global-tool"])
        #expect(ChatSessionSidebarModel.isSessionInActiveAgentScope(
            key: "agent:OPS:deploy",
            activeAgentID: "ops"))
        #expect(!ChatSessionSidebarModel.isSessionInActiveAgentScope(
            key: "agent:other:private",
            activeAgentID: "ops"))
        #expect(ChatSessionSidebarModel.isSessionInActiveAgentScope(
            key: "global-tool",
            activeAgentID: "ops"))
    }

    @Test func `main row is excluded while its children are promoted`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(
                    key: "agent:ops:main",
                    updatedAt: 300,
                    childSessions: ["agent:ops:child"]),
                self.entry(
                    key: "agent:ops:child",
                    updatedAt: 200,
                    parentSessionKey: "agent:ops:main"),
            ],
            currentSessionKey: "main",
            mainSessionKey: "agent:ops:main",
            activeAgentID: "ops",
            excludesMainSession: true,
            query: "")

        #expect(sections.flatMap(\.nodes).map(\.session.key) == ["agent:ops:child"])
    }

    @Test func `global aliases select their agent wrapped row`() {
        let sessions = [
            self.entry(key: "global", updatedAt: 200),
            self.entry(key: "agent:ops:global", updatedAt: 100, archived: true),
        ]
        let sections = ChatSessionSidebarModel.sections(
            sessions: sessions,
            currentSessionKey: "global",
            mainSessionKey: "agent:main:main",
            activeAgentID: "ops",
            query: "")

        #expect(ChatSessionSidebarModel.selectedSessionKey(
            sessions: sessions,
            currentSessionKey: "global",
            mainSessionKey: "agent:main:main",
            activeAgentID: "ops") == "agent:ops:global")
        #expect(sections.flatMap(\.nodes).map(\.session.key) == ["agent:ops:global"])
    }

    @Test func `query filters on display name and key`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(key: "agent:main:research", displayName: "Deep Research", updatedAt: 200),
                self.entry(key: "agent:main:main", updatedAt: 100),
            ],
            currentSessionKey: "agent:main:main",
            query: "research")

        #expect(sections.flatMap(\.nodes).map(\.session.key) == ["agent:main:research"])
    }

    @Test func `session keys render as human names`() {
        #expect(ChatSessionSidebarModel.displayName(forKey: "agent:main:main") == "main")
        #expect(ChatSessionSidebarModel.displayName(forKey: "agent:ops:standup") == "standup (ops)")
        #expect(ChatSessionSidebarModel.displayName(forKey: "global") == "global")
    }

    @Test func `display name prefers explicit names over key prettifying`() {
        let named = self.entry(key: "agent:main:x", displayName: "  Weekly Sync  ")
        #expect(ChatSessionSidebarModel.displayName(for: named) == "Weekly Sync")

        let unnamed = self.entry(key: "agent:main:x")
        #expect(ChatSessionSidebarModel.displayName(for: unnamed) == "x")
    }

    @Test func `delete excludes main aliases and allows ordinary or selected global sessions`() {
        let mainKey = "agent:default:main"

        #expect(!ChatSessionSidebarModel.canDeleteSession(key: "main", mainSessionKey: mainKey))
        #expect(!ChatSessionSidebarModel.canDeleteSession(key: "GLOBAL", mainSessionKey: mainKey))
        #expect(!ChatSessionSidebarModel.canDeleteSession(key: mainKey, mainSessionKey: mainKey))
        #expect(ChatSessionSidebarModel.canDeleteSession(key: "scratch", mainSessionKey: mainKey))
        #expect(ChatSessionSidebarModel.canDeleteSession(
            key: "agent:other:global",
            mainSessionKey: mainKey))
    }

    @Test func `session list hierarchy fields decode with gateway spellings`() throws {
        let data = try #require("""
        {
          "key": "agent:main:child",
          "parentSessionKey": "agent:main:main",
          "spawnedBy": "agent:main:controller",
          "childSessions": ["agent:main:grandchild"],
          "status": "running",
          "hasActiveRun": true,
          "hasActiveSubagentRun": true,
          "lastInteractionAt": 1700000000000,
          "startedAt": 1700000001000,
          "endedAt": 1700000003000,
          "runtimeMs": 2000,
          "agentRuntime": {"id": "codex", "fallback": "openclaw", "source": "session"},
          "worktree": {"id": "wt-1", "branch": "feature/chat", "repoRoot": "/repo"}
        }
        """.data(using: .utf8))

        let entry = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: data)

        #expect(entry.parentSessionKey == "agent:main:main")
        #expect(entry.spawnedBy == "agent:main:controller")
        #expect(entry.childSessions == ["agent:main:grandchild"])
        #expect(entry.status == "running")
        #expect(entry.hasActiveRun == true)
        #expect(entry.hasActiveSubagentRun == true)
        #expect(entry.lastInteractionAt == 1_700_000_000_000)
        #expect(entry.startedAt == 1_700_000_001_000)
        #expect(entry.endedAt == 1_700_000_003_000)
        #expect(entry.runtimeMs == 2000)
        #expect(entry.agentRuntime?.id == "codex")
        #expect(entry.worktree?.id == "wt-1")
        #expect(entry.worktree?.branch == "feature/chat")
        #expect(entry.worktree?.repoRoot == "/repo")
    }

    @Test func `inspector derives gateway metadata without composer overrides`() {
        let session = OpenClawChatSessionEntry(
            key: "agent:reviewer:child",
            kind: "subagent",
            displayName: "Review",
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: 1_700_000_000_000,
            sessionId: "session-1",
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: "high",
            verboseLevel: "full",
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: "openai",
            model: "gpt-5.6",
            contextTokens: nil,
            category: "Projects",
            hasActiveRun: true,
            worktree: OpenClawChatSessionWorktree(
                id: "wt-1",
                branch: "feature/review",
                repoRoot: "/repo"),
            runtimeMs: 1500,
            agentRuntime: OpenClawChatAgentRuntime(id: "codex", fallback: nil, source: "session"))

        let details = ChatSessionInspectorDetails(session: session)

        #expect(details.title == "Review")
        #expect(details.agentID == "reviewer")
        #expect(details.group == "Projects")
        #expect(details.runState == "Running")
        #expect(details.model == "gpt-5.6")
        #expect(details.provider == "openai")
        #expect(details.runtime == "codex")
        #expect(details.runDurationMs == 1500)
        #expect(details.worktreeBranch == "feature/review")
    }

    @Test func `tree nests children and bubbles run failure and unread badges`() {
        let nodes = ChatSessionSidebarModel.tree(from: [
            self.entry(key: "parent", childSessions: ["child"]),
            self.entry(
                key: "child",
                spawnedBy: "parent",
                childSessions: ["grandchild"],
                status: "running"),
            self.entry(key: "grandchild", unread: true, parentSessionKey: "child", status: "failed"),
        ])

        #expect(nodes.map(\.id) == ["parent"])
        #expect(nodes[0].children.map(\.id) == ["child"])
        #expect(nodes[0].children[0].children.map(\.id) == ["grandchild"])
        #expect(nodes[0].badges == .init(runningCount: 1, failedCount: 1, hasUnread: true))
        #expect(nodes[0].children.contains { $0.badges.hasUnread })
    }

    @Test func `tree breaks cycles without dropping or duplicating sessions`() {
        let nodes = ChatSessionSidebarModel.tree(from: [
            self.entry(key: "a", parentSessionKey: "b", childSessions: ["b"]),
            self.entry(key: "b", parentSessionKey: "a", childSessions: ["a"]),
        ])

        func keys(_ nodes: [ChatSessionSidebarModel.Node]) -> [String] {
            nodes.flatMap { [$0.id] + keys($0.children) }
        }
        #expect(keys(nodes) == ["a", "b"])
    }

    @Test func `omitted gateway child roster excludes stale persisted parent metadata`() {
        let nodes = ChatSessionSidebarModel.tree(from: [
            self.entry(key: "parent"),
            self.entry(key: "stale-child", parentSessionKey: "parent"),
        ])

        #expect(nodes.map(\.id) == ["parent", "stale-child"])
    }

    @Test func `orphaned parents remain visible as roots`() {
        let nodes = ChatSessionSidebarModel.tree(from: [
            self.entry(key: "orphan", parentSessionKey: "missing"),
            self.entry(key: "root"),
        ])

        #expect(nodes.map(\.id) == ["orphan", "root"])
    }

    @Test func `sessions without hierarchy data keep flat ordering`() {
        let nodes = ChatSessionSidebarModel.tree(from: [
            self.entry(key: "a"),
            self.entry(key: "b"),
        ])

        #expect(nodes.map(\.id) == ["a", "b"])
        #expect(nodes.filter { !$0.children.isEmpty }.isEmpty)
    }

    @Test func `main aliases cannot archive while ordinary sessions can`() {
        #expect(!ChatSessionSidebarModel.canArchiveSession(
            self.entry(key: "main"),
            mainSessionKey: "agent:main:main"))
        #expect(!ChatSessionSidebarModel.canArchiveSession(
            self.entry(key: "global"),
            mainSessionKey: "agent:main:main"))
        #expect(!ChatSessionSidebarModel.canArchiveSession(
            self.entry(key: "agent:main:main"),
            mainSessionKey: "agent:main:main"))
        #expect(ChatSessionSidebarModel.canArchiveSession(
            self.entry(key: "agent:main:child"),
            mainSessionKey: "agent:main:main"))
        #expect(!ChatSessionSidebarModel.canArchiveSession(
            self.entry(key: "agent:main:running", status: "running"),
            mainSessionKey: "agent:main:main"))
        #expect(!ChatSessionSidebarModel.canArchiveSession(
            self.entry(key: "agent:main:active", hasActiveSubagentRun: true),
            mainSessionKey: "agent:main:main"))
    }

    @Test func `observer events require the server run and advance monotonically`() throws {
        let running = self.entry(
            key: "agent:main:work",
            status: "running",
            hasActiveRun: true,
            activeRunIds: [" run-1 "])
        let revision2 = SessionObserverDigest(
            sessionkey: running.key,
            runid: "run-1",
            revision: 2,
            updatedat: 200,
            headline: "Second",
            health: .onTrack)
        var sessions = ChatSessionSidebarModel.applying(observerDigest: revision2, to: [running])

        sessions = ChatSessionSidebarModel.applying(
            observerDigest: SessionObserverDigest(
                sessionkey: running.key,
                runid: "run-1",
                revision: 1,
                updatedat: 300,
                headline: "Stale",
                health: .grinding),
            to: sessions)
        sessions = ChatSessionSidebarModel.applying(
            observerDigest: SessionObserverDigest(
                sessionkey: running.key,
                runid: "run-old",
                revision: 3,
                updatedat: 400,
                headline: "Wrong run",
                health: .stuck),
            to: sessions)

        #expect(sessions[0].observerDigest?.headline == "Second")
        #expect(ChatSessionSidebarModel.subtitle(for: sessions[0], workSubtitle: "Work") == "Second")

        sessions = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(
                sessionKey: running.key,
                reason: "run-progress",
                observerDigest: .init(
                    runId: "run-1",
                    revision: 3,
                    updatedAt: 500,
                    headline: "Projected",
                    health: "wrapping-up"),
                status: "running",
                hasActiveRun: true,
                activeRunIds: ["run-1"]),
            to: sessions))
        #expect(sessions[0].observerDigest?.headline == "Projected")
    }

    @Test func `run rollover clears a stale digest before the replacement event`() throws {
        let existing = self.entry(
            key: "agent:main:work",
            status: "running",
            hasActiveRun: true,
            activeRunIds: ["run-1"],
            observerDigest: .init(
                runId: "run-1",
                revision: 8,
                updatedAt: 800,
                headline: "Old run",
                health: "on-track"))
        let rolled = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(
                sessionKey: existing.key,
                reason: "run-start",
                status: "running",
                hasActiveRun: true,
                activeRunIds: ["run-2"]),
            to: [existing]))

        #expect(rolled[0].observerDigest == nil)

        let accepted = ChatSessionSidebarModel.applying(
            observerDigest: SessionObserverDigest(
                sessionkey: existing.key,
                runid: "run-2",
                revision: 1,
                updatedat: 900,
                headline: "New run",
                health: .onTrack),
            to: rolled)
        #expect(accepted[0].observerDigest?.headline == "New run")
    }

    @Test func `unknown session change requests an authoritative refetch`() {
        let change = OpenClawChatSessionsChangedEvent(
            sessionKey: "agent:main:new",
            reason: "created",
            updatedAt: 200)

        #expect(ChatSessionSidebarModel.applying(
            sessionChange: change,
            to: [self.entry(key: "agent:main:existing")]) == nil)
    }

    @Test func `partial session change preserves observer and status metadata`() throws {
        let agentStatus = OpenClawChatSessionAgentStatus(
            note: "Waiting on review",
            expiresAt: 5000,
            attention: "hand")
        let observerDigest = OpenClawChatSessionObserverDigest(
            runId: "run-1",
            revision: 3,
            updatedAt: 300,
            headline: "Reviewing",
            health: "waiting-on-user")
        let existing = self.entry(
            key: "agent:main:work",
            updatedAt: 100,
            status: "running",
            lastRunError: "Previous warning",
            hasActiveRun: true,
            activeRunIds: ["run-1"],
            agentStatus: agentStatus,
            observerDigest: observerDigest)

        let updated = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(
                sessionKey: existing.key,
                reason: "message",
                updatedAt: 400),
            to: [existing]))[0]

        #expect(updated.updatedAt == 400)
        #expect(updated.agentStatus == agentStatus)
        #expect(updated.observerDigest == observerDigest)
        #expect(updated.status == "running")
        #expect(updated.lastRunError == "Previous warning")

        let cleared = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(
                sessionKey: existing.key,
                reason: "clear",
                agentStatusPresent: true,
                observerDigestPresent: true,
                statusPresent: true,
                lastRunErrorPresent: true),
            to: [existing]))[0]
        #expect(cleared.agentStatus == nil)
        #expect(cleared.observerDigest == nil)
        #expect(cleared.status == nil)
        #expect(cleared.lastRunError == nil)
    }

    @Test func `subtitle precedence keeps attention and status above observer digest`() {
        let digest = OpenClawChatSessionObserverDigest(
            runId: "run-1",
            revision: 1,
            updatedAt: 200,
            headline: "Observer",
            health: "on-track")
        let agent = OpenClawChatSessionAgentStatus(
            note: "Agent note",
            expiresAt: 10000,
            attention: nil)
        let session = self.entry(
            key: "work",
            updatedAt: 500,
            lastReadAt: 100,
            status: "failed",
            lastRunError: "Needs approval",
            hasActiveRun: true,
            activeRunIds: ["run-1"],
            agentStatus: agent,
            observerDigest: digest,
            endedAt: 500)

        #expect(ChatSessionSidebarModel.subtitle(
            for: session,
            workSubtitle: "Work",
            now: 1000) == "Needs approval")
        #expect(ChatSessionSidebarModel.subtitle(
            for: self.entry(
                key: "work",
                status: "running",
                hasActiveRun: true,
                activeRunIds: ["run-1"],
                agentStatus: agent,
                observerDigest: digest),
            workSubtitle: "Work",
            now: 1000) == "Agent note")
    }

    @Test func `idle final digest remains until its timestamp is read`() {
        let digest = OpenClawChatSessionObserverDigest(
            revision: 3,
            updatedAt: 2000,
            headline: "Finished with warnings",
            health: "done")
        let unread = self.entry(key: "work", lastReadAt: 1999, observerDigest: digest)
        let read = self.entry(key: "work", lastReadAt: 2000, observerDigest: digest)

        #expect(ChatSessionSidebarModel.subtitle(for: unread, workSubtitle: "Work") == "Finished with warnings")
        #expect(ChatSessionSidebarModel.subtitle(for: read, workSubtitle: "Work") == "Work")
    }

    @Test func `runless terminal digest is idle only and cleared by a later run`() throws {
        let digest = OpenClawChatSessionObserverDigest(
            revision: 4,
            updatedAt: 2000,
            headline: "Finished",
            health: "done")
        var session = self.entry(
            key: "agent:main:work",
            lastReadAt: 1000,
            status: "done",
            observerDigest: digest)

        #expect(ChatSessionSidebarModel.subtitle(for: session, workSubtitle: "Work") == "Finished")
        session.status = "running"
        session.hasActiveRun = true
        session.activeRunIds = ["run-2"]
        #expect(ChatSessionSidebarModel.subtitle(for: session, workSubtitle: "Work") == "Work")
        session.status = "done"
        session.hasActiveRun = false
        session.activeRunIds = []
        #expect(ChatSessionSidebarModel.subtitle(for: session, workSubtitle: "Work") == "Finished")

        let rolled = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(
                sessionKey: session.key,
                reason: "run-start",
                status: "running",
                hasActiveRun: true,
                activeRunIds: ["run-2"]),
            to: [session]))
        #expect(rolled[0].observerDigest == nil)
    }
}
