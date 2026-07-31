import Foundation
import OpenClawKit

struct WatchMessagingStartupBuffer<Event> {
    private let maxCount: Int
    private var events: [Event] = []
    private(set) var isReady = false

    init(maxCount: Int) {
        precondition(maxCount > 0)
        self.maxCount = maxCount
    }

    mutating func receive(_ event: Event) -> [Event] {
        guard !self.isReady else { return [event] }
        if self.events.count == self.maxCount {
            self.events.removeFirst()
        }
        self.events.append(event)
        return []
    }

    mutating func markReady() -> [Event] {
        guard !self.isReady else { return [] }
        self.isReady = true
        defer { self.events.removeAll(keepingCapacity: false) }
        return self.events
    }
}

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
    private enum StartupEvent {
        case reply(WatchQuickReplyEvent)
        case execApprovalResolve(WatchExecApprovalResolveEvent)
        case execApprovalSnapshotRequest(WatchExecApprovalSnapshotRequestEvent)
        case appSnapshotRequest(WatchAppSnapshotRequestEvent)
        case appCommand(WatchAppCommandEvent)
    }

    private static let maxStartupEvents = 64

    private let transport: WatchConnectivityTransport
    private var startupEvents = WatchMessagingStartupBuffer<StartupEvent>(
        maxCount: WatchMessagingService.maxStartupEvents)
    private var statusHandler: (@Sendable (WatchMessagingStatus) -> Void)?
    private var lastEmittedStatus: WatchMessagingStatus?
    private var replyHandler: (@Sendable (WatchQuickReplyEvent) -> Void)?
    private var execApprovalResolveHandler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?
    private var execApprovalSnapshotRequestHandler: (
        @Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?
    private var appSnapshotRequestHandler: (@Sendable (WatchAppSnapshotRequestEvent) -> Void)?
    private var appCommandHandler: (@Sendable (WatchAppCommandEvent) -> Void)?

    init(transport: WatchConnectivityTransport = WatchConnectivityTransport()) {
        self.transport = transport
        self.transport.setStatusUpdateHandler { [weak self] snapshot in
            Task { @MainActor [weak self] in
                self?.emitStatusIfChanged(snapshot)
            }
        }
        self.transport.setReplyHandler { [weak self] event in
            Task { @MainActor [weak self] in
                self?.receiveStartupEvent(.reply(event))
            }
        }
        self.transport.setExecApprovalResolveHandler { [weak self] event in
            Task { @MainActor [weak self] in
                self?.receiveStartupEvent(.execApprovalResolve(event))
            }
        }
        self.transport.setExecApprovalSnapshotRequestHandler { [weak self] event in
            Task { @MainActor [weak self] in
                self?.receiveStartupEvent(.execApprovalSnapshotRequest(event))
            }
        }
        self.transport.setAppSnapshotRequestHandler { [weak self] event in
            Task { @MainActor [weak self] in
                self?.receiveStartupEvent(.appSnapshotRequest(event))
            }
        }
        self.transport.setAppCommandHandler { [weak self] event in
            Task { @MainActor [weak self] in
                self?.receiveStartupEvent(.appCommand(event))
            }
        }
        self.transport.activate()
    }

    nonisolated static func isSupportedOnDevice() -> Bool {
        WatchConnectivityTransport.isSupportedOnDevice()
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
        self.finishStartupRegistrationIfReady()
    }

    func setExecApprovalResolveHandler(_ handler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?) {
        self.execApprovalResolveHandler = handler
        self.finishStartupRegistrationIfReady()
    }

    func setExecApprovalSnapshotRequestHandler(
        _ handler: (@Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?)
    {
        self.execApprovalSnapshotRequestHandler = handler
        self.finishStartupRegistrationIfReady()
    }

    func setAppSnapshotRequestHandler(_ handler: (@Sendable (WatchAppSnapshotRequestEvent) -> Void)?) {
        self.appSnapshotRequestHandler = handler
        self.finishStartupRegistrationIfReady()
    }

    func setAppCommandHandler(_ handler: (@Sendable (WatchAppCommandEvent) -> Void)?) {
        self.appCommandHandler = handler
        self.finishStartupRegistrationIfReady()
    }

    func sendNotification(
        id: String,
        params: OpenClawWatchNotifyParams,
        gatewayStableID: String?) async throws -> WatchNotificationSendResult
    {
        let payload = WatchMessagingPayloadCodec.encodeNotificationPayload(
            id: id,
            params: params,
            gatewayStableID: gatewayStableID)
        return try await self.transport.sendPayload(payload)
    }

    func sendDirectNodeSetup(setupCode: String) async throws -> WatchNotificationSendResult {
        try await self.transport.sendPayload(
            WatchMessagingPayloadCodec.encodeDirectNodeSetupPayload(setupCode: setupCode))
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

    func syncAppSnapshot(
        _ message: OpenClawWatchAppSnapshotMessage) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendSnapshotPayload(
            WatchMessagingPayloadCodec.encodeAppSnapshotPayload(message))
    }

    func sendChatCompletion(
        _ message: OpenClawWatchChatCompletionMessage) async throws -> WatchNotificationSendResult
    {
        try await self.transport.sendPayload(
            WatchMessagingPayloadCodec.encodeChatCompletionPayload(message))
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

    private func emitAppSnapshotRequest(_ event: WatchAppSnapshotRequestEvent) {
        GatewayDiagnostics.log(
            "watch messaging: app snapshot request "
                + "id=\(event.requestId) transport=\(event.transport) "
                + "sentAtMs=\(event.sentAtMs ?? -1)")
        self.appSnapshotRequestHandler?(event)
    }

    private func emitAppCommand(_ event: WatchAppCommandEvent) {
        GatewayDiagnostics.log(
            "watch messaging: app command "
                + "id=\(event.commandId) command=\(event.command.rawValue) "
                + "transport=\(event.transport)")
        self.appCommandHandler?(event)
    }

    private func receiveStartupEvent(_ event: StartupEvent) {
        for event in self.startupEvents.receive(event) {
            self.dispatchStartupEvent(event)
        }
    }

    private func finishStartupRegistrationIfReady() {
        guard self.replyHandler != nil,
              self.execApprovalResolveHandler != nil,
              self.execApprovalSnapshotRequestHandler != nil,
              self.appSnapshotRequestHandler != nil,
              self.appCommandHandler != nil
        else {
            return
        }
        for event in self.startupEvents.markReady() {
            self.dispatchStartupEvent(event)
        }
    }

    private func dispatchStartupEvent(_ event: StartupEvent) {
        switch event {
        case let .reply(event):
            self.emitReply(event)
        case let .execApprovalResolve(event):
            self.emitExecApprovalResolve(event)
        case let .execApprovalSnapshotRequest(event):
            self.emitExecApprovalSnapshotRequest(event)
        case let .appSnapshotRequest(event):
            self.emitAppSnapshotRequest(event)
        case let .appCommand(event):
            self.emitAppCommand(event)
        }
    }
}
