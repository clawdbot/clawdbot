import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct WebChatManagerTests {
    @Test func `controller reuse requires the full normalized route`() {
        let work = WebChatRoute(sessionKey: "global", agentID: " Work ")
        let sameWork = WebChatRoute(sessionKey: "global", agentID: "work")
        let main = WebChatRoute(sessionKey: "global", agentID: "main")

        #expect(work == sameWork)
        #expect(WebChatManager.shouldReuseController(currentRoute: work, requestedRoute: sameWork))
        #expect(!WebChatManager.shouldReuseController(currentRoute: work, requestedRoute: main))
        #expect(!WebChatManager.shouldReuseController(
            currentRoute: work,
            requestedRoute: WebChatRoute(sessionKey: "main", agentID: "work")))
    }

    @Test func `blank agent route normalizes to nil`() {
        #expect(WebChatRoute(sessionKey: "global", agentID: "  ") ==
            WebChatRoute(sessionKey: "global", agentID: nil))
    }

    @Test func `preferred session key is non empty`() async {
        let key = await WebChatManager.shared.preferredSessionKey()
        #expect(!key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
}
