import Foundation
import OSLog
@preconcurrency import WatchConnectivity

private struct WatchConnectivityTransportCallbacks {
    var statusUpdateHandler: (@Sendable (WatchMessagingStatus) -> Void)?
    var inboundEventHandler: (@Sendable (WatchMessagingInboundEvent) -> Void)?
}

final class WatchConnectivityTransport: NSObject, @unchecked Sendable {
    private nonisolated static let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "watch.messaging")

    private let session: WCSession?
    private let activationGate = WatchSessionActivationGate()
    private let callbacksLock = NSLock()
    private let snapshotContextLock = NSLock()
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
        }
    }

    nonisolated static func isSupportedOnDevice() -> Bool {
        WCSession.isSupported()
    }

    func status() async -> WatchMessagingStatus {
        try? await self.ensureActivated()
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

    func setInboundEventHandler(_ handler: (@Sendable (WatchMessagingInboundEvent) -> Void)?) {
        self.updateCallbacks { $0.inboundEventHandler = handler }
    }

    func activate() {
        guard let session = self.session else { return }
        self.beginActivation(session)
    }

    func sendPayload(_ payload: [String: Any]) async throws -> WatchNotificationSendResult {
        try await self.ensureActivated()
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
        try await self.ensureActivated()
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
            try self.snapshotContextLock.withLock {
                let context = WatchMessagingPayloadCodec.encodeSnapshotApplicationContext(
                    payload,
                    merging: session.applicationContext)
                try session.updateApplicationContext(context)
            }
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
        guard session.activationState == .activated else {
            throw WatchSessionActivationError.failed("session stayed inactive")
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

    private func beginActivation(_ session: WCSession) {
        if self.activationGate.beginActivation() {
            session.activate()
        }
    }

    private func ensureActivated() async throws {
        guard let session = self.session else { return }
        if session.activationState == .activated {
            self.activationGate.complete(activated: true, errorDescription: nil)
            return
        }
        self.beginActivation(session)
        try await self.activationGate.waitUntilActivated()
    }

    private func emitStatusUpdate(_ snapshot: WatchMessagingStatus) {
        guard let handler = self.callbacksSnapshot().statusUpdateHandler else {
            return
        }
        Task { @MainActor in
            handler(snapshot)
        }
    }

    private func emitInboundEvent(_ event: WatchMessagingInboundEvent) {
        guard let handler = self.callbacksSnapshot().inboundEventHandler else {
            return
        }
        Task { @MainActor in
            handler(event)
        }
    }

    private nonisolated static func status(for session: WCSession) -> WatchMessagingStatus {
        let activationState = session.activationState
        let isActivated = activationState == .activated
        return WatchMessagingStatus(
            supported: true,
            paired: isActivated && session.isPaired,
            appInstalled: isActivated && session.isWatchAppInstalled,
            reachable: isActivated && session.isReachable,
            activationState: self.activationStateLabel(activationState))
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
        self.activationGate.complete(
            activated: activationState == .activated,
            errorDescription: error?.localizedDescription)
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

    func sessionDidBecomeInactive(_ session: WCSession) {
        GatewayDiagnostics.log("watch messaging: session became inactive")
        self.emitStatusUpdate(Self.status(for: session))
    }

    func sessionDidDeactivate(_ session: WCSession) {
        GatewayDiagnostics.log("watch messaging: session did deactivate; reactivating")
        self.activationGate.reset()
        self.beginActivation(session)
        self.emitStatusUpdate(Self.status(for: session))
    }

    func sessionWatchStateDidChange(_ session: WCSession) {
        GatewayDiagnostics.log(
            "watch messaging: watch state changed "
                + "paired=\(session.isPaired) installed=\(session.isWatchAppInstalled)")
        self.emitStatusUpdate(Self.status(for: session))
    }

    func session(_: WCSession, didReceiveMessage message: [String: Any]) {
        let type = (message["type"] as? String) ?? "unknown"
        GatewayDiagnostics.log("watch messaging: didReceiveMessage type=\(type)")
        if let event = WatchMessagingPayloadCodec.parseInboundPayload(
            message,
            transport: "sendMessage")
        {
            self.emitInboundEvent(event)
        }
    }

    func session(
        _: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void)
    {
        let type = (message["type"] as? String) ?? "unknown"
        GatewayDiagnostics.log("watch messaging: didReceiveMessageWithReply type=\(type)")
        guard let event = WatchMessagingPayloadCodec.parseInboundPayload(
            message,
            transport: "sendMessage")
        else {
            replyHandler(["ok": false, "error": "unsupported_payload"])
            return
        }
        replyHandler(["ok": true])
        self.emitInboundEvent(event)
    }

    func session(_: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        let type = (userInfo["type"] as? String) ?? "unknown"
        GatewayDiagnostics.log("watch messaging: didReceiveUserInfo type=\(type)")
        if let event = WatchMessagingPayloadCodec.parseInboundPayload(
            userInfo,
            transport: "transferUserInfo")
        {
            self.emitInboundEvent(event)
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
