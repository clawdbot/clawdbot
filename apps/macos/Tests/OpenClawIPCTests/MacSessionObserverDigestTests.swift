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
}
