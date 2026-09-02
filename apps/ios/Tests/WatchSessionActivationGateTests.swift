import Foundation
import OpenClawKit
import Testing
@preconcurrency import WatchConnectivity
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

    @Test func `accepted watch reply ignores later transport callbacks`() async throws {
        try await withCheckedThrowingContinuation { continuation in
            let completion = WatchMessageSendCompletion(continuation)
            completion.complete(.success(()))
            completion.complete(.failure(URLError(.timedOut)))
            completion.complete(.success(()))
        }
    }

    @Test func `watch transport error ignores later replies and errors`() async {
        await #expect(throws: URLError.self) {
            try await withCheckedThrowingContinuation { continuation in
                let completion = WatchMessageSendCompletion(continuation)
                completion.complete(.failure(URLError(.notConnectedToInternet)))
                completion.complete(.success(()))
                completion.complete(.failure(WatchMessageAcknowledgmentError.rejected("late")))
            }
        }
    }

    @Test func `rejected watch acknowledgment ignores a later transport error`() async {
        await #expect(throws: WatchMessageAcknowledgmentError.self) {
            try await withCheckedThrowingContinuation { continuation in
                let completion = WatchMessageSendCompletion(continuation)
                completion.complete(Result {
                    try requireAcceptedWatchMessageReply(["ok": false, "error": "unsupported_payload"])
                })
                completion.complete(.failure(URLError(.timedOut)))
            }
        }
    }

    @Test func `racing watch callbacks complete their continuation exactly once`() async {
        do {
            try await withCheckedThrowingContinuation { continuation in
                let completion = WatchMessageSendCompletion(continuation)
                DispatchQueue.concurrentPerform(iterations: 100) { index in
                    completion.complete(index.isMultiple(of: 2)
                        ? .success(())
                        : .failure(URLError(.timedOut)))
                }
            }
        } catch is URLError {
            // Either terminal callback may win; racing callbacks must never resume twice.
        } catch {
            Issue.record("Unexpected watch message failure: \(error)")
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
        let callbackRegistration = try #require(
            serviceSource.range(of: "self.transport.setInboundEventHandler"))
        let activation = try #require(serviceSource.range(of: "self.transport.activate()"))
        #expect(callbackRegistration.lowerBound < activation.lowerBound)
    }
}

@MainActor
struct WatchMessagingInboundTransportTests {
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String] = []

        func append(_ value: String) {
            self.lock.withLock { self.values.append(value) }
        }

        func snapshot() -> [String] {
            self.lock.withLock { self.values }
        }
    }

    @Test func `inbound payload families cross every delegate boundary once`() async throws {
        let transport = WatchConnectivityTransport()
        let service = WatchMessagingService(transport: transport)
        let events = Recorder()
        let order = Recorder()
        service.setReplyHandler { event in
            order.append("callback")
            events.append("reply|\(event.replyId)|\(event.transport)")
        }
        service.setExecApprovalResolveHandler { event in
            order.append("callback")
            events.append("resolve|\(event.approvalId)|\(event.transport)")
        }
        service.setExecApprovalSnapshotRequestHandler { event in
            order.append("callback")
            events.append("approvalSnapshot|\(event.requestId)|\(event.transport)")
        }
        service.setAppSnapshotRequestHandler { event in
            order.append("callback")
            events.append("appSnapshot|\(event.requestId)|\(event.transport)")
        }
        service.setAppCommandHandler { event in
            order.append("callback")
            events.append("appCommand|\(event.commandId)|\(event.transport)")
        }

        let opaqueApprovalID = "approval.e\u{301}/opaque"
        let cases: [([String: Any], String, String)] = [
            ([
                "type": OpenClawWatchPayloadType.reply.rawValue,
                "replyId": "reply/opaque",
                "actionId": "approve",
            ], "reply", "reply/opaque"),
            ([
                "type": OpenClawWatchPayloadType.execApprovalResolve.rawValue,
                "replyId": "resolve/opaque",
                "approvalId": opaqueApprovalID,
                "decision": OpenClawWatchExecApprovalDecision.allowOnce.rawValue,
            ], "resolve", opaqueApprovalID),
            ([
                "type": OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue,
                "requestId": "approval-snapshot/opaque",
                "heldApprovals": [],
            ], "approvalSnapshot", "approval-snapshot/opaque"),
            ([
                "type": OpenClawWatchPayloadType.appSnapshotRequest.rawValue,
                "requestId": "app-snapshot/opaque",
            ], "appSnapshot", "app-snapshot/opaque"),
            ([
                "type": OpenClawWatchPayloadType.appCommand.rawValue,
                "command": OpenClawWatchAppCommand.refresh.rawValue,
                "commandId": "app-command/opaque",
            ], "appCommand", "app-command/opaque"),
        ]

        for ingress in 0..<3 {
            let transportLabel = ingress == 2 ? "transferUserInfo" : "sendMessage"
            for item in cases {
                let before = events.snapshot().count
                switch ingress {
                case 0:
                    transport.session(WCSession.default, didReceiveMessage: item.0)
                case 1:
                    var reply: [String: Any]?
                    order.append("reply-pending")
                    transport.session(
                        WCSession.default,
                        didReceiveMessage: item.0,
                        replyHandler: {
                            reply = $0
                            order.append("reply")
                        })
                    #expect(reply?.count == 1)
                    #expect(reply?["ok"] as? Bool == true)
                default:
                    transport.session(WCSession.default, didReceiveUserInfo: item.0)
                }
                try await Self.waitForCount(before + 1, in: events)
                #expect(events.snapshot().last == "\(item.1)|\(item.2)|\(transportLabel)")
                #expect(events.snapshot().count == before + 1)
                if ingress == 1 {
                    #expect(Array(order.snapshot().suffix(3)) == ["reply-pending", "reply", "callback"])
                }
            }
        }

        let countBeforeInvalid = events.snapshot().count
        for payload: [String: Any] in [
            [:],
            ["type": "watch.unknown"],
            ["type": OpenClawWatchPayloadType.reply.rawValue],
        ] {
            transport.session(WCSession.default, didReceiveMessage: payload)
            transport.session(WCSession.default, didReceiveUserInfo: payload)
            var reply: [String: Any]?
            transport.session(
                WCSession.default,
                didReceiveMessage: payload,
                replyHandler: { reply = $0 })
            #expect(reply?.count == 2)
            #expect(reply?["ok"] as? Bool == false)
            #expect(reply?["error"] as? String == "unsupported_payload")
        }
        transport.session(WCSession.default, didReceiveMessage: cases[0].0)
        try await Self.waitForCount(countBeforeInvalid + 1, in: events)
        #expect(events.snapshot().count == countBeforeInvalid + 1)
    }

    private static func waitForCount(_ count: Int, in recorder: Recorder) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while recorder.snapshot().count < count, ContinuousClock.now < deadline {
            await Task.yield()
        }
        try #require(recorder.snapshot().count == count)
    }
}
