import Foundation
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
        parentSessionKey: String? = nil,
        spawnedBy: String? = nil,
        childSessions: [String]? = nil,
        status: String? = nil,
        hasActiveRun: Bool? = nil,
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
            pinned: pinned,
            archived: archived,
            unread: unread,
            parentSessionKey: parentSessionKey,
            spawnedBy: spawnedBy,
            childSessions: childSessions,
            status: status,
            hasActiveRun: hasActiveRun,
            hasActiveSubagentRun: hasActiveSubagentRun)
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
        #expect(sections[0].sessions.map(\.key) == ["b"])
        #expect(sections[1].sessions.map(\.key) == ["c", "a"])
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

        #expect(sections.flatMap(\.sessions).map(\.key) == ["main"])
    }

    @Test func `active session gets a placeholder row before lists load`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [],
            currentSessionKey: "agent:main:main",
            query: "")

        #expect(sections.flatMap(\.sessions).map(\.key) == ["agent:main:main"])
    }

    @Test func `main aliases select the resolved row without adding a placeholder`() {
        let sessions = [self.entry(key: "agent:default:main", updatedAt: 100)]
        let sections = ChatSessionSidebarModel.sections(
            sessions: sessions,
            currentSessionKey: "main",
            mainSessionKey: "agent:default:main",
            activeAgentID: "default",
            query: "")

        #expect(sections.flatMap(\.sessions).map(\.key) == ["agent:default:main"])
        #expect(ChatSessionSidebarModel.selectedSessionKey(
            sessions: sessions,
            currentSessionKey: "main",
            mainSessionKey: "agent:default:main",
            activeAgentID: "default") == "agent:default:main")
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
        #expect(sections.flatMap(\.sessions).map(\.key) == ["agent:ops:global"])
    }

    @Test func `query filters on display name and key`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                self.entry(key: "agent:main:research", displayName: "Deep Research", updatedAt: 200),
                self.entry(key: "agent:main:main", updatedAt: 100),
            ],
            currentSessionKey: "agent:main:main",
            query: "research")

        #expect(sections.flatMap(\.sessions).map(\.key) == ["agent:main:research"])
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
        #expect(entry.worktree?.id == "wt-1")
        #expect(entry.worktree?.branch == "feature/chat")
        #expect(entry.worktree?.repoRoot == "/repo")
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
        #expect(nodes[0].hasUnreadDescendant)
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
}
