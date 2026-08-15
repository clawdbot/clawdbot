import Foundation
import Testing
@testable import OpenClaw

struct WatchSessionActivationGateTests {
    @Test func `reachable delivery requires an accepted acknowledgment`() throws {
        try requireAcceptedWatchMessageReply(["ok": true])

        #expect(throws: WatchMessageAcknowledgmentError.self) {
            try requireAcceptedWatchMessageReply(["ok": false, "error": "unsupported_payload"])
        }
        #expect(throws: WatchMessageAcknowledgmentError.self) {
            try requireAcceptedWatchMessageReply(["ok": "true"])
        }
        #expect(throws: WatchMessageAcknowledgmentError.self) {
            try requireAcceptedWatchMessageReply([:])
        }
    }

    @Test func `startup event buffering is ordered and bounded`() {
        var buffer = WatchMessagingStartupBuffer<String>(maxCount: 3)

        #expect(buffer.receive("first").isEmpty)
        #expect(buffer.receive("second").isEmpty)
        #expect(buffer.receive("third").isEmpty)
        #expect(buffer.receive("fourth").isEmpty)
        #expect(buffer.markReady() == ["second", "third", "fourth"])
        #expect(buffer.receive("live") == ["live"])
        #expect(buffer.markReady().isEmpty)
    }

    @Test func `iPhone observes watch pairing and install changes`() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/Services/WatchConnectivityTransport.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        #expect(source.contains("func sessionWatchStateDidChange(_ session: WCSession)"))
        #expect(source.contains("paired=\\(session.isPaired) installed=\\(session.isWatchAppInstalled)"))
    }

    @Test func `concurrent waiters share one activation`() async throws {
        let gate = WatchSessionActivationGate(timeoutNanoseconds: 1_000_000_000)

        #expect(gate.beginActivation())
        #expect(!gate.beginActivation())
        let first = Task { try await gate.waitUntilActivated() }
        let second = Task { try await gate.waitUntilActivated() }

        gate.complete(activated: true, errorDescription: nil)

        try await first.value
        try await second.value
    }

    @Test func `activation timeout remains retryable`() async throws {
        let gate = WatchSessionActivationGate(timeoutNanoseconds: 1_000_000)

        #expect(gate.beginActivation())
        await #expect(throws: WatchSessionActivationError.self) {
            try await gate.waitUntilActivated()
        }

        #expect(gate.beginActivation())
        gate.complete(activated: true, errorDescription: nil)
        try await gate.waitUntilActivated()
    }

    @Test func `activation errors reach every waiter`() async {
        let gate = WatchSessionActivationGate(timeoutNanoseconds: 1_000_000_000)

        #expect(gate.beginActivation())
        let first = Task { try await gate.waitUntilActivated() }
        let second = Task { try await gate.waitUntilActivated() }
        gate.complete(activated: false, errorDescription: "not paired")

        await #expect(throws: WatchSessionActivationError.self) { try await first.value }
        await #expect(throws: WatchSessionActivationError.self) { try await second.value }
    }

    @Test func `watch receiver acknowledges only accepted payloads and snapshots only after activation`() throws {
        let iosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let receiverSource = try String(
            contentsOf: iosRoot.appendingPathComponent(
                "WatchApp/Sources/WatchConnectivityReceiver.swift"),
            encoding: .utf8)
        let transportSource = try String(
            contentsOf: iosRoot.appendingPathComponent(
                "Sources/Services/WatchConnectivityTransport.swift"),
            encoding: .utf8)
        let serviceSource = try String(
            contentsOf: iosRoot.appendingPathComponent(
                "Sources/Services/WatchMessagingService.swift"),
            encoding: .utf8)

        #expect(receiverSource.contains("final class WatchMessageAcknowledgment"))
        #expect(receiverSource.contains(
            "acknowledgment: WatchMessageAcknowledgment(replyHandler: replyHandler)"))
        #expect(receiverSource.contains("acknowledgment?.accept()"))
        #expect(receiverSource.contains("acknowledgment?.rejectUnsupportedPayload()"))
        #expect(receiverSource.contains(
            "acknowledgment: WatchMessageAcknowledgment? = nil) -> Bool"))
        #expect(receiverSource.contains("guard activationState == .activated else { return }"))
        #expect(receiverSource.contains("try requireAcceptedWatchMessageReply(reply)"))
        #expect(transportSource.contains("try requireAcceptedWatchMessageReply(reply)"))
        let callbackRegistration = try #require(
            serviceSource.range(of: "self.transport.setAppCommandHandler"))
        let activation = try #require(serviceSource.range(of: "self.transport.activate()"))
        #expect(callbackRegistration.lowerBound < activation.lowerBound)
    }
}
