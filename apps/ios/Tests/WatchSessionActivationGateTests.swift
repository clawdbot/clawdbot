import Foundation
import OpenClawKit
import Synchronization
import Testing
@preconcurrency import WatchConnectivity
import XCTest
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

    private enum DeliverySuspension: CaseIterable {
        case activation
        case interactiveFailure
        case acceptedInteractiveReply
    }

    @Test(arguments: DeliverySuspension.allCases, [false, true])
    private func `watch delivery cancellation fences new transfers but preserves accepted replies`(
        suspension: DeliverySuspension,
        cancelBeforeRelease: Bool) async throws
    {
        let gate = WatchSessionActivationGate(timeoutNanoseconds: 10_000_000_000)
        #expect(gate.beginActivation())
        let entered = XCTestExpectation(description: "watch delivery suspended")
        let effects = Mutex<[String]>([])
        let sender = Task {
            try await WatchConnectivityTransport.deliverPayload(
                prepareSession: {
                    if suspension == .activation {
                        entered.fulfill()
                        try await gate.waitUntilActivated()
                    }
                },
                sendImmediately: { _ in
                    guard suspension != .activation else { return false }
                    effects.withLock { $0.append("interactive") }
                    entered.fulfill()
                    try await gate.waitUntilActivated()
                    if suspension == .interactiveFailure {
                        throw URLError(.networkConnectionLost)
                    }
                    return true
                },
                enqueue: { _ in
                    effects.withLock { $0.append("background") }
                    return "transferUserInfo"
                })
        }
        defer {
            sender.cancel()
            gate.complete(activated: false, errorDescription: "test cleanup")
        }
        let ready = await XCTWaiter.fulfillment(of: [entered], timeout: 5)
        try #require(ready == .completed)
        if cancelBeforeRelease {
            sender.cancel()
        }
        gate.complete(activated: true, errorDescription: nil)

        let acceptedReply = suspension == .acceptedInteractiveReply
        if cancelBeforeRelease, !acceptedReply {
            await #expect(throws: CancellationError.self) { try await sender.value }
        } else {
            let result = try await sender.value
            #expect(result.deliveredImmediately == acceptedReply)
            #expect(result.queuedForDelivery == !acceptedReply)
            #expect(result.transport == (acceptedReply ? "sendMessage" : "transferUserInfo"))
        }
        var expectedEffects = suspension == .activation ? [] : ["interactive"]
        if !cancelBeforeRelease, !acceptedReply {
            expectedEffects.append("background")
        }
        #expect(effects.withLock { $0 } == expectedEffects)
    }

    #if targetEnvironment(simulator)
    @Test(
        .enabled(
            if: ProcessInfo.processInfo.environment["OPENCLAW_LIVE_TEST"] == "1",
            "Requires an isolated, unpaired iPhone Simulator; run with OPENCLAW_LIVE_TEST=1."),
        .serialized,
        arguments: [false, true])
    func `native watch snapshot cancellation fences a contended context lock`(
        cancelBeforeAdmission: Bool) async throws
    {
        let session = WCSession.default
        try #require(!session.isPaired, "Do not probe a paired Watch session")
        try #require(!session.isReachable, "Do not probe a reachable Watch session")
        let marker = "openclaw.test.cancelled-snapshot-admission"
        let originalContext = session.applicationContext
        defer {
            if session.applicationContext["type"] as? String == marker {
                do {
                    try session.updateApplicationContext(originalContext)
                } catch {
                    Issue.record("Could not remove an unexpectedly admitted snapshot probe")
                }
            }
        }
        let snapshotLock = NSLock()
        let releaseLock = DispatchSemaphore(value: 0)
        let holderEntered = XCTestExpectation(description: "snapshot lock held")
        let holderFinished = XCTestExpectation(description: "snapshot lock released")
        let holderWasSignalled = Mutex<Bool?>(nil)
        DispatchQueue(label: "openclaw.test.snapshot-lock-holder").async {
            snapshotLock.withLock {
                holderEntered.fulfill()
                let signalled = releaseLock.wait(timeout: .now() + 15) == .success
                holderWasSignalled.withLock { $0 = signalled }
            }
            holderFinished.fulfill()
        }
        defer { releaseLock.signal() }
        let held = await XCTWaiter.fulfillment(of: [holderEntered], timeout: 5)
        try #require(held == .completed, "Infrastructure failure: lock holder did not start")

        let senderEntered = XCTestExpectation(description: "outer cancellation fence passed")
        let senderFinished = XCTestExpectation(description: "snapshot sender completed")
        // A contended synchronous lock must not occupy the actor running the test driver.
        let sender = Task.detached { () -> Result<Void, any Error> in
            defer { senderFinished.fulfill() }
            do {
                let session = WCSession.default
                try Task.checkCancellation()
                senderEntered.fulfill()
                try updateWatchSnapshotApplicationContext(
                    ["type": marker],
                    with: session,
                    lock: snapshotLock)
                return .success(())
            } catch {
                let nativeError = error as NSError
                print("watch snapshot SDK admission: cancelled=\(cancelBeforeAdmission) "
                    + "domain=\(nativeError.domain) code=\(nativeError.code)")
                return .failure(error)
            }
        }
        defer { sender.cancel() }
        let entered = await XCTWaiter.fulfillment(of: [senderEntered], timeout: 5)
        try #require(entered == .completed, "Infrastructure failure: sender did not reach the locked boundary")
        try #require(holderWasSignalled.withLock { $0 } == nil, "Infrastructure failure: lock holder expired")
        if cancelBeforeAdmission {
            sender.cancel()
        }
        releaseLock.signal()
        let finished = await XCTWaiter.fulfillment(of: [senderFinished, holderFinished], timeout: 5)
        try #require(finished == .completed, "Infrastructure failure: local snapshot probe did not finish")
        try #require(
            holderWasSignalled.withLock { $0 } == true,
            "Infrastructure failure: lock release was not signalled")
        let outcome = await sender.value
        guard case let .failure(error) = outcome else {
            Issue.record("The unpaired/unreachable SDK snapshot probe unexpectedly succeeded")
            return
        }
        if cancelBeforeAdmission {
            #expect(error is CancellationError, "Cancellation must win after acquiring the context lock")
        } else {
            let nativeError = error as NSError
            #expect(nativeError.domain == WCErrorDomain)
            #expect([7002, 7003, 7004, 7005, 7006, 7007, 7016].contains(nativeError.code))
        }
    }

    @Test(
        .enabled(
            if: ProcessInfo.processInfo.environment["OPENCLAW_LIVE_TEST"] == "1",
            "Requires an isolated, unpaired iPhone Simulator; run with OPENCLAW_LIVE_TEST=1."),
        arguments: [false, true])
    @MainActor
    func `native watch sender rejects cancellation before SDK admission`(cancelBeforeStart: Bool) async throws {
        let session = WCSession.default
        try #require(!session.isPaired, "Do not probe a paired Watch session")
        try #require(!session.isReachable, "Do not probe a reachable Watch session")
        let finished = XCTestExpectation(description: "native Watch send completed")
        let sender = Task { @MainActor () -> Result<Void, any Error> in
            defer { finished.fulfill() }
            #expect(Task.isCancelled == cancelBeforeStart)
            do {
                try await sendReachableWatchMessage(
                    ["type": "openclaw.test.cancelled-delivery-admission"],
                    with: session)
                return .success(())
            } catch {
                let nativeError = error as NSError
                print("watch SDK admission: cancelled=\(cancelBeforeStart) "
                    + "domain=\(nativeError.domain) code=\(nativeError.code)")
                return .failure(error)
            }
        }
        defer { sender.cancel() }
        // The child inherits this actor and cannot enter the helper before this cancellation.
        if cancelBeforeStart {
            sender.cancel()
        }
        let completion = await XCTWaiter.fulfillment(of: [finished], timeout: 5)
        try #require(
            completion == .completed,
            "Infrastructure failure: the local WCSession rejection callback did not finish")
        let outcome = await sender.value
        guard case let .failure(error) = outcome else {
            Issue.record("The unpaired/unreachable SDK probe unexpectedly succeeded")
            return
        }
        if cancelBeforeStart {
            #expect(error is CancellationError, "Cancellation must win before the SDK accepts a send")
        } else {
            let nativeError = error as NSError
            #expect(nativeError.domain == WCErrorDomain)
            // WCError.h: unsupported, missing delegate, inactive/unactivated, unpaired,
            // app missing, or unreachable are all local, non-delivery rejections.
            #expect([7002, 7003, 7004, 7005, 7006, 7007, 7016].contains(nativeError.code))
        }
    }
    #endif

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
