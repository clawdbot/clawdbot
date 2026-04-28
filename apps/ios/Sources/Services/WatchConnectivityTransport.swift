import Foundation
import OSLog
@preconcurrency import WatchConnectivity

private struct WatchConnectivityTransportCallbacks {
    var statusUpdateHandler: (@Sendable (WatchMessagingStatus) -> Void)?
    var replyHandler: (@Sendable (WatchQuickReplyEvent) -> Void)?
    var execApprovalResolveHandler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?
    var execApprovalSnapshotRequestHandler: (@Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?
}

private func sendReachableWatchMessage(_ payload: [String: Any], with session: WCSession) async throws {
    // WatchConnectivity replies arrive on its own queue. Keep this continuation explicitly
    // nonisolated so Swift 6 does not inherit a caller actor (for example MainActor) into the
    // Objective-C callback boundary and trap on the reply callback executor check.
    try await withCheckedThrowingContinuation(isolation: nil) { (continuation: CheckedContinuation<Void, Error>) in
        session.sendMessage(
            payload,
            replyHandler: { _ in
                continuation.resume(returning: ())
            },
            errorHandler: { error in
                continuation.resume(throwing: error)
            })
    }
}

final class WatchConnectivityTransport: NSObject, @unchecked Sendable {
    private nonisolated static let logger = Logger(subsystem: "ai.openclaw", category: "watch.messaging")

    private let session: WCSession?
    private let callbacksLock = NSLock()
    private var callbacks = WatchConnectivityTransportCallbacks()

    override init() {
        if WCSession.isSupported() {
            self.session = WCSession.default
        } else {
            self.session = nil
        }
        super.init()
        if let session = self.session {
            session.delegate = self
            session.activate()
        }
    }

    nonisolated static func isSupportedOnDevice() -> Bool {
        WCSession.isSupported()
    }

    nonisolated static func currentStatusSnapshot() -> WatchMessagingStatus {
        guard WCSession.isSupported() else {
            return WatchMessagingStatus(
                supported: false,
                paired: false,
                appInstalled: false,
                reachable: false,
                activationState: "unsupported")
        }
        return self.status(for: WCSession.default)
    }

    func status() async -> WatchMessagingStatus {
        await self.ensureActivated()
        return self.currentStatusSnapshot()
    }

    func currentStatusSnapshot() -> WatchMessagingStatus {
        guard let session = self.session else {
            return WatchMessagingStatus(
                supported: false,
                paired: false,
                appInstalled: false,
                reachable: false,
                activationState: "unsupported")
        }
        return Self.status(for: session)
    }

    func setStatusUpdateHandler(_ handler: (@Sendable (WatchMessagingStatus) -> Void)?) {
        self.updateCallbacks { $0.statusUpdateHandler = handler }
    }

    func setReplyHandler(_ handler: (@Sendable (WatchQuickReplyEvent) -> Void)?) {
        self.updateCallbacks { $0.replyHandler = handler }
    }

    func setExecApprovalResolveHandler(_ handler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?) {
        self.updateCallbacks { $0.execApprovalResolveHandler = handler }
    }

    func setExecApprovalSnapshotRequestHandler(
        _ handler: (@Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?)
    {
        self.updateCallbacks { $0.execApprovalSnapshotRequestHandler = handler }
    }

    func sendPayload(_ payload: [String: Any]) async throws -> WatchNotificationSendResult {
        await self.ensureActivated()
        let session = try self.requireReadySession()
        if session.isReachable {
            do {
                try await sendReachableWatchMessage(payload, with: session)
                return WatchNotificationSendResult(
                    deliveredImmediately: true,
                    queuedForDelivery: false,
                    transport: "sendMessage")
            } catch {
                Self.logger.error("watch sendMessage failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        _ = session.transferUserInfo(payload)
        return WatchNotificationSendResult(
            deliveredImmediately: false,
            queuedForDelivery: true,
            transport: "transferUserInfo")
    }

    func sendSnapshotPayload(_ payload: [String: Any]) async throws -> WatchNotificationSendResult {
        await self.ensureActivated()
        let session = try self.requireReadySession()
        if session.isReachable {
            do {
                try await sendReachableWatchMessage(payload, with: session)
                return WatchNotificationSendResult(
                    deliveredImmediately: true,
                    queuedForDelivery: false,
                    transport: "sendMessage")
            } catch {
                Self.logger.error(
                    "watch snapshot sendMessage failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        do {
            try session.updateApplicationContext(payload)
            return WatchNotificationSendResult(
                deliveredImmediately: false,
                queuedForDelivery: true,
                transport: "applicationContext")
        } catch {
            Self.logger.error(
                "watch updateApplicationContext failed: \(error.localizedDescription, privacy: .public)")
            _ = session.transferUserInfo(payload)
            return WatchNotificationSendResult(
                deliveredImmediately: false,
                queuedForDelivery: true,
                transport: "transferUserInfo")
        }
    }

    private func updateCallbacks(_ update: (inout WatchConnectivityTransportCallbacks) -> Void) {
        self.callbacksLock.lock()
        defer { self.callbacksLock.unlock() }
        update(&self.callbacks)
    }

    private func callbacksSnapshot() -> WatchConnectivityTransportCallbacks {
        self.callbacksLock.lock()
        defer { self.callbacksLock.unlock() }
        return self.callbacks
    }

    private func requireReadySession() throws -> WCSession {
        guard let session = self.session else {
            throw WatchMessagingError.unsupported
        }
        let snapshot = Self.status(for: session)
        guard snapshot.paired else {
            throw WatchMessagingError.notPaired
        }
        guard snapshot.appInstalled else {
            throw WatchMessagingError.watchAppNotInstalled
        }
        return session
    }

    private func ensureActivated() async {
        guard let session = self.session else { return }
        if session.activationState == .activated {
            return
        }
        session.activate()
        for _ in 0..<8 {
            if session.activationState == .activated {
                return
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    private func emitStatusUpdate(_ snapshot: WatchMessagingStatus) {
        guard let handler = self.callbacksSnapshot().statusUpdateHandler else {
            return
        }
        Task { @MainActor in
            handler(snapshot)
        }
    }

    private func emitReply(_ event: WatchQuickReplyEvent) {
        guard let handler = self.callbacksSnapshot().replyHandler else {
            return
        }
        Task { @MainActor in
            handler(event)
        }
    }

    private func emitExecApprovalResolve(_ event: WatchExecApprovalResolveEvent) {
        guard let handler = self.callbacksSnapshot().execApprovalResolveHandler else {
            return
        }
        Task { @MainActor in
            handler(event)
        }
    }

    private func emitExecApprovalSnapshotRequest(_ event: WatchExecApprovalSnapshotRequestEvent) {
        guard let handler = self.callbacksSnapshot().execApprovalSnapshotRequestHandler else {
            return
        }
        Task { @MainActor in
            handler(event)
        }
    }

    private nonisolated static func status(for session: WCSession) -> WatchMessagingStatus {
        WatchMessagingStatus(
            supported: true,
            paired: session.isPaired,
            appInstalled: session.isWatchAppInstalled,
            reachable: session.isReachable,
            activationState: self.activationStateLabel(session.activationState))
    }

    private nonisolated static func activationStateLabel(_ state: WCSessionActivationState) -> String {
        switch state {
        case .notActivated:
            "notActivated"
        case .inactive:
            "inactive"
        case .activated:
            "activated"
        @unknown default:
            "unknown"
        }
    }
}

extension WatchConnectivityTransport: WCSessionDelegate {
    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: (any Error)?)
    {
        GatewayDiagnostics.log(
            "watch messaging: activation complete "
                + "state=\(Self.activationStateLabel(activationState)) "
                + "error=\(error?.localizedDescription ?? "none")")
        if let error {
            Self.logger.error("watch activation failed: \(error.localizedDescription, privacy: .public)")
        } else {
            Self.logger.debug(
                "watch activation state=\(Self.activationStateLabel(activationState), privacy: .public)")
        }
        self.emitStatusUpdate(Self.status(for: session))
    }

    func sessionDidBecomeInactive(_: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        GatewayDiagnostics.log("watch messaging: session did deactivate; reactivating")
        session.activate()
        self.emitStatusUpdate(Self.status(for: session))
    }

    func session(_: WCSession, didReceiveMessage message: [String: Any]) {
        let type = (message["type"] as? String) ?? "unknown"
        GatewayDiagnostics.log("watch messaging: didReceiveMessage type=\(type)")
        if let event = WatchMessagingPayloadCodec.parseQuickReplyPayload(message, transport: "sendMessage") {
            self.emitReply(event)
            return
        }
        if let event = WatchMessagingPayloadCodec.parseExecApprovalResolvePayload(
            message,
            transport: "sendMessage")
        {
            self.emitExecApprovalResolve(event)
            return
        }
        if let event = WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload(
            message,
            transport: "sendMessage")
        {
            self.emitExecApprovalSnapshotRequest(event)
        }
    }

    func session(
        _: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void)
    {
        let type = (message["type"] as? String) ?? "unknown"
        GatewayDiagnostics.log("watch messaging: didReceiveMessageWithReply type=\(type)")
        if let event = WatchMessagingPayloadCodec.parseQuickReplyPayload(message, transport: "sendMessage") {
            replyHandler(["ok": true])
            self.emitReply(event)
            return
        }
        if let event = WatchMessagingPayloadCodec.parseExecApprovalResolvePayload(
            message,
            transport: "sendMessage")
        {
            replyHandler(["ok": true])
            self.emitExecApprovalResolve(event)
            return
        }
        if let event = WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload(
            message,
            transport: "sendMessage")
        {
            replyHandler(["ok": true])
            self.emitExecApprovalSnapshotRequest(event)
            return
        }
        replyHandler(["ok": false, "error": "unsupported_payload"])
    }

    func session(_: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        let type = (userInfo["type"] as? String) ?? "unknown"
        GatewayDiagnostics.log("watch messaging: didReceiveUserInfo type=\(type)")
        if let event = WatchMessagingPayloadCodec.parseQuickReplyPayload(
            userInfo,
            transport: "transferUserInfo")
        {
            self.emitReply(event)
            return
        }
        if let event = WatchMessagingPayloadCodec.parseExecApprovalResolvePayload(
            userInfo,
            transport: "transferUserInfo")
        {
            self.emitExecApprovalResolve(event)
            return
        }
        if let event = WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload(
            userInfo,
            transport: "transferUserInfo")
        {
            self.emitExecApprovalSnapshotRequest(event)
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        GatewayDiagnostics.log(
            "watch messaging: reachability changed "
                + "reachable=\(session.isReachable) paired=\(session.isPaired) "
                + "installed=\(session.isWatchAppInstalled)")
        self.emitStatusUpdate(Self.status(for: session))
    }
}
