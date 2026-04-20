import Foundation
import OpenClawKit

enum WatchMessagingError: LocalizedError {
    case unsupported
    case notPaired
    case watchAppNotInstalled

    var errorDescription: String? {
        switch self {
        case .unsupported:
            "WATCH_UNAVAILABLE: WatchConnectivity is not supported on this device"
        case .notPaired:
            "WATCH_UNAVAILABLE: no paired Apple Watch"
        case .watchAppNotInstalled:
            "WATCH_UNAVAILABLE: OpenClaw watch companion app is not installed"
        }
    }
}

@MainActor
final class WatchMessagingService: @preconcurrency WatchMessagingServicing {
    private let transport: WatchConnectivityTransport
    private var statusHandler: (@Sendable (WatchMessagingStatus) -> Void)?
    private var lastEmittedStatus: WatchMessagingStatus?
    private var replyHandler: (@Sendable (WatchQuickReplyEvent) -> Void)?
    private var execApprovalResolveHandler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?
    private var execApprovalSnapshotRequestHandler: (
        @Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?

    init(transport: WatchConnectivityTransport = WatchConnectivityTransport()) {
        self.transport = transport
        self.transport.setStatusUpdateHandler { [weak self] snapshot in
            Task { @MainActor [weak self] in
                self?.emitStatusIfChanged(snapshot)
            }
        }
        self.transport.setReplyHandler { [weak self] event in
            Task { @MainActor [weak self] in
                self?.emitReply(event)
            }
        }
        self.transport.setExecApprovalResolveHandler { [weak self] event in
            Task { @MainActor [weak self] in
                self?.emitExecApprovalResolve(event)
            }
        }
        self.transport.setExecApprovalSnapshotRequestHandler { [weak self] event in
            Task { @MainActor [weak self] in
                self?.emitExecApprovalSnapshotRequest(event)
            }
        }
    }

    nonisolated static func isSupportedOnDevice() -> Bool {
        WatchConnectivityTransport.isSupportedOnDevice()
    }

    nonisolated static func currentStatusSnapshot() -> WatchMessagingStatus {
        WatchConnectivityTransport.currentStatusSnapshot()
    }

    func status() async -> WatchMessagingStatus {
        await self.transport.status()
    }

    func setStatusHandler(_ handler: (@Sendable (WatchMessagingStatus) -> Void)?) {
        self.statusHandler = handler
        guard let handler else {
            self.lastEmittedStatus = nil
            GatewayDiagnostics.log("watch messaging: cleared status handler")
            return
        }
        let snapshot = self.transport.currentStatusSnapshot()
        self.lastEmittedStatus = snapshot
        GatewayDiagnostics.log(
            "watch messaging: set status handler "
                + "supported=\(snapshot.supported) paired=\(snapshot.paired) "
                + "appInstalled=\(snapshot.appInstalled) reachable=\(snapshot.reachable) "
                + "activation=\(snapshot.activationState)")
        handler(snapshot)
    }

    func setReplyHandler(_ handler: (@Sendable (WatchQuickReplyEvent) -> Void)?) {
        self.replyHandler = handler
    }

    func setExecApprovalResolveHandler(_ handler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?) {
        self.execApprovalResolveHandler = handler
    }

    func setExecApprovalSnapshotRequestHandler(
        _ handler: (@Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?)
    {
        self.execApprovalSnapshotRequestHandler = handler
    }

    func sendNotification(
        id: String,
        params: OpenClawWatchNotifyParams) async throws -> WatchNotificationSendResult
    {
        let payload = WatchMessagingPayloadCodec.encodeNotificationPayload(id: id, params: params)
        return try await self.transport.sendPayload(payload)
    }

    func sendExecApprovalPrompt(
        _ message: OpenClawWatchExecApprovalPromptMessage) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendPayload(
            WatchMessagingPayloadCodec.encodeExecApprovalPromptPayload(message))
    }

    func sendExecApprovalResolved(
        _ message: OpenClawWatchExecApprovalResolvedMessage) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendPayload(
            WatchMessagingPayloadCodec.encodeExecApprovalResolvedPayload(message))
    }

    func sendExecApprovalExpired(
        _ message: OpenClawWatchExecApprovalExpiredMessage) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendPayload(
            WatchMessagingPayloadCodec.encodeExecApprovalExpiredPayload(message))
    }

    func syncExecApprovalSnapshot(
        _ message: OpenClawWatchExecApprovalSnapshotMessage) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendSnapshotPayload(
            WatchMessagingPayloadCodec.encodeExecApprovalSnapshotPayload(message))
    }

    private func emitStatusIfChanged(_ snapshot: WatchMessagingStatus) {
        guard snapshot != self.lastEmittedStatus else {
            return
        }
        self.lastEmittedStatus = snapshot
        GatewayDiagnostics.log(
            "watch messaging: status "
                + "supported=\(snapshot.supported) paired=\(snapshot.paired) "
                + "appInstalled=\(snapshot.appInstalled) reachable=\(snapshot.reachable) "
                + "activation=\(snapshot.activationState)")
        self.statusHandler?(snapshot)
    }

    private func emitReply(_ event: WatchQuickReplyEvent) {
        self.replyHandler?(event)
    }

    private func emitExecApprovalResolve(_ event: WatchExecApprovalResolveEvent) {
        self.execApprovalResolveHandler?(event)
    }

    private func emitExecApprovalSnapshotRequest(_ event: WatchExecApprovalSnapshotRequestEvent) {
        GatewayDiagnostics.log(
            "watch messaging: snapshot request "
                + "id=\(event.requestId) transport=\(event.transport) "
                + "sentAtMs=\(event.sentAtMs ?? -1)")
        self.execApprovalSnapshotRequestHandler?(event)
    }
}
