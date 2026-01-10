import Foundation
import Testing
@testable import Clawdbot

@Suite
struct MacNodeBridgeSessionTests {
    @Test func sendEventThrowsWhenNotConnected() async {
        let session = MacNodeBridgeSession()

        do {
            try await session.sendEvent(event: "test", payloadJSON: "{}")
            Issue.record("Expected sendEvent to throw when disconnected")
        } catch {
            let ns = error as NSError
            #expect(ns.domain == "Bridge")
            #expect(ns.code == 15)
        }
    }
}
