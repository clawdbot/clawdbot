import Testing
@testable import OpenClaw

struct ChatSendStatusTests {
    @Test(arguments: ["ok", " OK ", "\nok\t"])
    func `ok is terminal success`(_ status: String) {
        #expect(ChatSendStatus.acceptance(of: status) == .terminalSuccess)
    }

    @Test(arguments: ["error", " ERROR ", "timeout", " Timeout\n"])
    func `errors are terminal failures`(_ status: String) {
        #expect(ChatSendStatus.acceptance(of: status) == .terminalFailure)
    }

    @Test(arguments: ["started", "in_flight", "queued", "", "  pending  "])
    func `other statuses remain in flight`(_ status: String) {
        #expect(ChatSendStatus.acceptance(of: status) == .inFlight)
    }
}
