import OpenClawChatUI
import OpenClawProtocol
import Testing

struct MacSessionObserverDigestTests {
    @Test func `native chat sidebar accepts only the server reported run`() {
        let session = OpenClawChatSessionEntry(
            key: "agent:main:work",
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: 100,
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
            status: "running",
            hasActiveRun: true,
            activeRunIds: ["run-1"])
        let wrongRun = SessionObserverDigest(
            sessionkey: session.key,
            runid: "run-old",
            revision: 5,
            updatedat: 500,
            headline: "Wrong run",
            health: .stuck)
        let accepted = SessionObserverDigest(
            sessionkey: session.key,
            runid: "run-1",
            revision: 1,
            updatedat: 600,
            headline: "On track",
            health: .onTrack)

        let rejected = ChatSessionSidebarModel.applying(observerDigest: wrongRun, to: [session])
        let updated = ChatSessionSidebarModel.applying(observerDigest: accepted, to: rejected)

        #expect(rejected[0].observerDigest == nil)
        #expect(updated[0].observerDigest?.headline == "On track")
        #expect(ChatSessionSidebarModel.subtitle(for: updated[0], workSubtitle: "Work") == "On track")
    }

    @Test func `native chat sidebar rejects another agent global digest`() {
        let session = OpenClawChatSessionEntry(
            key: "global",
            kind: "global",
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: 100,
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
            status: "running",
            hasActiveRun: true,
            activeRunIds: ["run-work"])
        let other = SessionObserverDigest(
            sessionkey: "global",
            agentid: "main",
            runid: "run-work",
            revision: 1,
            updatedat: 200,
            headline: "Wrong owner",
            health: .stuck)
        let selected = SessionObserverDigest(
            sessionkey: "global",
            agentid: "work",
            runid: "run-work",
            revision: 1,
            updatedat: 200,
            headline: "Selected owner",
            health: .onTrack)
        let ownerless = SessionObserverDigest(
            sessionkey: "global",
            runid: "run-work",
            revision: 1,
            updatedat: 200,
            headline: "Missing owner",
            health: .stuck)

        let rejected = ChatSessionSidebarModel.applying(
            observerDigest: other,
            to: [session],
            activeAgentId: "work")
        let rejectedOwnerless = ChatSessionSidebarModel.applying(
            observerDigest: ownerless,
            to: rejected,
            activeAgentId: "work")
        let accepted = ChatSessionSidebarModel.applying(
            observerDigest: selected,
            to: rejectedOwnerless,
            activeAgentId: "work")

        #expect(rejected[0].observerDigest == nil)
        #expect(rejectedOwnerless[0].observerDigest == nil)
        #expect(accepted[0].observerDigest?.headline == "Selected owner")
    }

    @Test func `changing the selected agent clears the previous global digest`() {
        var session = OpenClawChatSessionEntry(
            key: "global",
            kind: "global",
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: 100,
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
            status: "running",
            hasActiveRun: true,
            activeRunIds: ["run-main"])
        session.observerDigest = OpenClawChatSessionObserverDigest(
            agentId: "main",
            runId: "run-main",
            revision: 4,
            updatedAt: 400,
            headline: "Main owner",
            health: "on-track")

        let disconnected = ChatSessionSidebarModel.clearingForeignGlobalObserverDigest(
            in: [session],
            activeAgentId: nil)
        let switched = ChatSessionSidebarModel.clearingForeignGlobalObserverDigest(
            in: [session],
            activeAgentId: "work")

        #expect(disconnected[0].observerDigest?.headline == "Main owner")
        #expect(switched[0].observerDigest == nil)

        session.observerDigest = OpenClawChatSessionObserverDigest(
            runId: "run-work",
            revision: 1,
            updatedAt: 500,
            headline: "Legacy selected owner",
            health: "on-track")
        let clearedLegacy = ChatSessionSidebarModel.clearingForeignGlobalObserverDigest(
            in: [session],
            activeAgentId: "work")
        let adopted = ChatSessionSidebarModel.reconcilingGlobalObserverDigestOwner(
            in: [session],
            activeAgentId: "work")
        #expect(clearedLegacy[0].observerDigest == nil)
        #expect(adopted[0].observerDigest?.agentId == "work")
    }
}
