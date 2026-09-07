import Testing
@testable import OpenClaw

struct CommandCenterTabSessionFilterTests {
    @Test func `hides direct agent device sessions`() {
        #expect(!CommandCenterTab.isRecentChatSession("main", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:main", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:rust-claw:main", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:node-0b88d67b7e42", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:work", defaultSessionKey: "work"))
        #expect(!CommandCenterTab.isRecentChatSession("main", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("global", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("node-0b88d67b7e42", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("work", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:work", defaultSessionKey: "agent:rust-claw:work"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:main:thread:42", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:support:main:thread:1234:42", defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession(
            "agent:main:node-0b88d67b7e42:thread:42",
            defaultSessionKey: "main"))
        #expect(!CommandCenterTab.isRecentChatSession("agent:main:work:thread:42", defaultSessionKey: "work"))
        #expect(!CommandCenterTab.isRecentChatSession(
            "agent:main:work:thread:42",
            defaultSessionKey: "agent:rust-claw:work"))
    }

    @Test func `keeps agent scoped channel and cron sessions`() {
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:main:signal:direct:+15555550123",
            defaultSessionKey: "main"))
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:rust-claw:mattermost:channel:abc123",
            defaultSessionKey: "main"))
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:rust-claw:cron:3cd2eb6f-b8a5-4db7-b74a-f6a3f7eab3d3",
            defaultSessionKey: "main"))
        #expect(CommandCenterTab.isRecentChatSession(
            "agent:main:slack:channel:c1:thread:123",
            defaultSessionKey: "main"))
    }

    @Test func `prefers generated display names over ios key placeholders`() {
        func entry(
            key: String,
            displayName: String? = nil,
            label: String? = nil) -> OpenClawChatSessionEntry
        {
            OpenClawChatSessionEntry(
                key: key,
                kind: nil,
                displayName: displayName,
                surface: nil,
                subject: nil,
                room: nil,
                space: nil,
                updatedAt: 1,
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
                label: label)
        }

        #expect(
            CommandCenterTab.sessionTitle(
                entry(key: "agent:main:ios-abc123", displayName: "Compare session naming"))
                == "Compare session naming")
        #expect(CommandCenterTab.sessionTitle(entry(key: "agent:main:ios-abc123")) == "iOS chat")
        #expect(
            CommandCenterTab.sessionTitle(
                entry(
                    key: "agent:main:ios-abc123",
                    displayName: "Compare session naming",
                    label: "My thread"))
                == "My thread")
    }
}
