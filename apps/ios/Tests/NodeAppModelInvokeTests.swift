import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
import UIKit
import UserNotifications
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
private final class MockVoiceNoteAudioCapture: VoiceNoteAudioCapture {
    private(set) var cancelCallCount = 0
    private(set) var permissionRequestCount = 0

    func requestPermission() async -> Bool {
        self.permissionRequestCount += 1
        return true
    }

    func start(url _: URL) throws {}
    func stop() -> TimeInterval {
        1
    }

    func cancel() {
        self.cancelCallCount += 1
    }

    func setFailureHandler(_: @escaping @MainActor () -> Void) {}
}

private actor CancellingCameraService: CameraServicing {
    func listDevices() async -> [CameraController.CameraDeviceInfo] {
        []
    }

    func snap(
        params _: OpenClawCameraSnapParams,
        defaultFacing _: OpenClawCameraFacing) async throws -> OpenClawCameraSnapResult
    {
        throw CancellationError()
    }

    func clip(
        params _: OpenClawCameraClipParams,
        defaultFacing _: OpenClawCameraFacing) async throws -> OpenClawCameraClipResult
    {
        throw CancellationError()
    }
}

private actor RecordingCameraService: CameraServicing {
    private var clipCalls = 0

    func listDevices() async -> [CameraController.CameraDeviceInfo] {
        []
    }

    func snap(
        params _: OpenClawCameraSnapParams,
        defaultFacing _: OpenClawCameraFacing) async throws -> OpenClawCameraSnapResult
    {
        (format: "jpg", base64: "", width: 1, height: 1)
    }

    func clip(
        params _: OpenClawCameraClipParams,
        defaultFacing _: OpenClawCameraFacing) async throws -> OpenClawCameraClipResult
    {
        self.clipCalls += 1
        return (format: "mp4", base64: "", durationMs: 1, hasAudio: true)
    }

    func clipCallCount() -> Int {
        self.clipCalls
    }
}

private actor ApprovalResolutionCapture {
    private var kind: ApprovalKind?

    func record(kind: ApprovalKind) {
        self.kind = kind
    }

    func recordedKind() -> ApprovalKind? {
        self.kind
    }
}

private actor WatchApprovalReadbackProbe {
    private var approvalIDs: [String] = []

    func record(_ approvalID: String) {
        self.approvalIDs.append(approvalID)
    }

    func snapshot() -> [String] {
        self.approvalIDs
    }
}

private actor MockHealthSummaryService: HealthSummaryServicing {
    private(set) var periods: [OpenClawHealthSummaryPeriod] = []

    func summary(params: OpenClawHealthSummaryParams) async throws -> OpenClawHealthSummaryPayload {
        self.periods.append(params.period)
        return OpenClawHealthSummaryPayload(
            period: params.period,
            startISO: "2026-07-06T00:00:00Z",
            endISO: "2026-07-12T18:30:00Z",
            timeZoneIdentifier: "America/Los_Angeles",
            stepCount: 42000,
            sleepDurationMinutes: 2880,
            restingHeartRateBpm: 61.2,
            workoutCount: 3,
            workoutDurationMinutes: 145)
    }
}

private actor BlockingAudioCameraService: CameraServicing {
    private let barrier: TalkPreparationBarrier

    init(barrier: TalkPreparationBarrier) {
        self.barrier = barrier
    }

    func listDevices() async -> [CameraController.CameraDeviceInfo] {
        []
    }

    func snap(
        params _: OpenClawCameraSnapParams,
        defaultFacing _: OpenClawCameraFacing) async throws -> OpenClawCameraSnapResult
    {
        (format: "jpg", base64: "", width: 1, height: 1)
    }

    func clip(
        params _: OpenClawCameraClipParams,
        defaultFacing _: OpenClawCameraFacing) async throws -> OpenClawCameraClipResult
    {
        await self.barrier.suspendFirstPreparation()
        try Task.checkCancellation()
        return (format: "mp4", base64: "", durationMs: 1, hasAudio: true)
    }
}

private actor BlockingAudioScreenRecorder: ScreenRecordingServicing {
    private let barrier: TalkPreparationBarrier
    private var recordCalls = 0

    init(barrier: TalkPreparationBarrier) {
        self.barrier = barrier
    }

    func record(
        screenIndex _: Int?,
        durationMs _: Int?,
        fps _: Double?,
        includeAudio _: Bool?,
        outPath _: String?) async throws -> String
    {
        self.recordCalls += 1
        await self.barrier.suspendFirstPreparation()
        try Task.checkCancellation()
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-screen-test-\(UUID().uuidString).mp4")
        try Data().write(to: url)
        return url.path
    }

    func recordCallCount() -> Int {
        self.recordCalls
    }
}

private actor CancellationIgnoringScreenRecorder: ScreenRecordingServicing {
    private let barrier: TalkPreparationBarrier
    private let outputURL: URL

    init(barrier: TalkPreparationBarrier, outputURL: URL) {
        self.barrier = barrier
        self.outputURL = outputURL
    }

    func record(
        screenIndex _: Int?,
        durationMs _: Int?,
        fps _: Double?,
        includeAudio _: Bool?,
        outPath _: String?) async throws -> String
    {
        await self.barrier.suspendFirstPreparation()
        try Data([0x01]).write(to: self.outputURL)
        return self.outputURL.path
    }
}

private actor OverlappingCameraService: CameraServicing {
    private let firstStarted: AsyncStream<Void>.Continuation
    private let secondStarted: AsyncStream<Void>.Continuation
    private var firstGate: CheckedContinuation<Void, Never>?
    private var secondGate: CheckedContinuation<Void, Never>?
    private var snapCount = 0

    init(
        firstStarted: AsyncStream<Void>.Continuation,
        secondStarted: AsyncStream<Void>.Continuation)
    {
        self.firstStarted = firstStarted
        self.secondStarted = secondStarted
    }

    func listDevices() async -> [CameraController.CameraDeviceInfo] {
        []
    }

    func snap(
        params _: OpenClawCameraSnapParams,
        defaultFacing _: OpenClawCameraFacing) async throws -> OpenClawCameraSnapResult
    {
        self.snapCount += 1
        if self.snapCount == 1 {
            self.firstStarted.yield()
            self.firstStarted.finish()
            await withCheckedContinuation { self.firstGate = $0 }
            throw CancellationError()
        }

        self.secondStarted.yield()
        self.secondStarted.finish()
        await withCheckedContinuation { self.secondGate = $0 }
        return (format: "jpg", base64: "", width: 1, height: 1)
    }

    func clip(
        params _: OpenClawCameraClipParams,
        defaultFacing _: OpenClawCameraFacing) async throws -> OpenClawCameraClipResult
    {
        throw CancellationError()
    }

    func releaseFirst() {
        self.firstGate?.resume()
        self.firstGate = nil
    }

    func releaseSecond() {
        self.secondGate?.resume()
        self.secondGate = nil
    }
}

@MainActor
private final class TalkPreparationBarrier {
    private var didEnter = false
    private var enteredContinuation: CheckedContinuation<Void, Never>?
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    func suspendFirstPreparation() async {
        guard !self.didEnter else { return }
        self.didEnter = true
        self.enteredContinuation?.resume()
        self.enteredContinuation = nil
        await withCheckedContinuation { continuation in
            self.releaseContinuation = continuation
        }
    }

    func waitUntilEntered() async {
        if self.didEnter {
            return
        }
        await withCheckedContinuation { continuation in
            self.enteredContinuation = continuation
        }
    }

    func release() {
        self.releaseContinuation?.resume()
        self.releaseContinuation = nil
    }
}

@MainActor
private func waitForTalkCondition(_ condition: @MainActor () -> Bool) async {
    for _ in 0..<2000 {
        if condition() {
            return
        }
        try? await Task.sleep(nanoseconds: 1_000_000)
    }
    Issue.record("Timed out waiting for Talk state")
}

private func talkRequest(id: String, command: OpenClawTalkCommand) -> BridgeInvokeRequest {
    BridgeInvokeRequest(id: id, command: command.rawValue)
}

private func decodeTalkPayload<T: Decodable>(_ type: T.Type, from response: BridgeInvokeResponse) throws -> T {
    let data = try #require(response.payloadJSON?.data(using: .utf8))
    return try JSONDecoder().decode(type, from: data)
}

private func makeAgentDeepLinkURL(
    message: String,
    deliver: Bool = false,
    to: String? = nil,
    channel: String? = nil,
    key: String? = nil) -> URL
{
    var components = URLComponents()
    components.scheme = "openclaw"
    components.host = "agent"
    var queryItems: [URLQueryItem] = [URLQueryItem(name: "message", value: message)]
    if deliver {
        queryItems.append(URLQueryItem(name: "deliver", value: "1"))
    }
    if let to {
        queryItems.append(URLQueryItem(name: "to", value: to))
    }
    if let channel {
        queryItems.append(URLQueryItem(name: "channel", value: channel))
    }
    if let key {
        queryItems.append(URLQueryItem(name: "key", value: key))
    }
    components.queryItems = queryItems
    return components.url!
}

private func makeWatchChatRawMessage(
    role: String,
    text: String?,
    type: String = "text",
    timestamp: Double,
    idempotencyKey: String? = nil,
    stopReason: String? = nil) throws -> AnyCodable
{
    let message = OpenClawChatMessage(
        role: role,
        content: [
            OpenClawChatMessageContent(
                type: type,
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil),
        ],
        timestamp: timestamp,
        idempotencyKey: idempotencyKey,
        stopReason: stopReason ?? (role == "assistant" ? "stop" : nil))
    let data = try JSONEncoder().encode(message)
    return try JSONDecoder().decode(AnyCodable.self, from: data)
}

private func makeProjectedWatchChatRawMessage(
    role: String,
    text: String,
    timestamp: Double,
    serverId: String,
    isMessageToolMirror: Bool = false) throws -> AnyCodable
{
    var object: [String: Any] = [
        "role": role,
        "content": [["type": "text", "text": text]],
        "timestamp": timestamp,
        "__openclaw": ["id": serverId],
    ]
    if isMessageToolMirror {
        object["openclawMessageToolMirror"] = ["toolName": "message"]
    }
    let data = try JSONSerialization.data(withJSONObject: object)
    return try JSONDecoder().decode(AnyCodable.self, from: data)
}

private func encodedFixtureJSON(_ value: some Encodable) -> String {
    guard let data = try? JSONEncoder().encode(value) else {
        preconditionFailure("Could not encode test fixture")
    }
    return String(decoding: data, as: UTF8.self)
}

private func execApprovalPresentation(
    commandText: String,
    commandPreview: String? = nil,
    warningText: String? = nil,
    agentID: String? = "main",
    allowedDecisions: [ApprovalDecision] = [.allowOnce, .deny]) -> ApprovalPresentation
{
    .exec(ExecApprovalPresentation(
        kind: ApprovalKind.exec.rawValue,
        commandtext: commandText,
        commandpreview: AnyCodable(commandPreview ?? commandText),
        warningtext: warningText.map(AnyCodable.init) ?? AnyCodable(NSNull()),
        host: AnyCodable("gateway"),
        nodeid: AnyCodable(NSNull()),
        agentid: agentID.map(AnyCodable.init) ?? AnyCodable(NSNull()),
        alloweddecisions: allowedDecisions))
}

private func pluginApprovalPresentation(
    title: String,
    description: String) -> ApprovalPresentation
{
    .plugin(PluginApprovalPresentation(
        kind: ApprovalKind.plugin.rawValue,
        title: title,
        description: description,
        severity: .warning,
        pluginid: AnyCodable("example"),
        toolname: AnyCodable("guarded"),
        agentid: AnyCodable("main"),
        alloweddecisions: [.allowOnce, .deny]))
}

private func makePendingApprovalJSON(
    id: String,
    presentation: ApprovalPresentation,
    createdAtMs: Int = 100,
    expiresAtMs: Int = 4_000_000_000_000) -> String
{
    encodedFixtureJSON(ApprovalGetResult(approval: .pending(PendingApprovalSnapshot(
        id: id,
        urlpath: "/approve/\(id)",
        createdatms: createdAtMs,
        expiresatms: expiresAtMs,
        presentation: presentation,
        status: "pending"))))
}

private func makePendingExecApprovalJSON(
    _ approvalID: String,
    commandText: String = "echo held",
    commandPreview: String? = nil,
    warningText: String? = nil,
    agentID: String? = "main",
    allowedDecisions: [ApprovalDecision] = [.allowOnce, .deny]) -> String
{
    makePendingApprovalJSON(
        id: approvalID,
        presentation: execApprovalPresentation(
            commandText: commandText,
            commandPreview: commandPreview,
            warningText: warningText,
            agentID: agentID,
            allowedDecisions: allowedDecisions))
}

private func makeDeniedExecApprovalJSON(
    _ approvalID: String,
    commandText: String,
    commandPreview: String? = nil,
    warningText: String? = nil,
    allowedDecisions: [ApprovalDecision] = [.allowOnce, .deny],
    expiresAtMs: Int = 200,
    applied: Bool? = nil) -> String
{
    let approval = DeniedApprovalSnapshot(
        id: approvalID,
        urlpath: "/approve/\(approvalID)",
        createdatms: 100,
        expiresatms: expiresAtMs,
        presentation: execApprovalPresentation(
            commandText: commandText,
            commandPreview: commandPreview,
            warningText: warningText,
            allowedDecisions: allowedDecisions),
        resolvedatms: 150,
        status: "denied",
        decision: ApprovalDecision.deny.rawValue,
        reason: .user)
    if let applied {
        return encodedFixtureJSON(ApprovalResolveResult(applied: applied, approval: .denied(approval)))
    }
    return encodedFixtureJSON(ApprovalGetResult(approval: .denied(approval)))
}

private func makeDeniedPluginApprovalJSON(_ approvalID: String, applied: Bool) -> String {
    let approval = DeniedApprovalSnapshot(
        id: approvalID,
        urlpath: "/approve/\(approvalID)",
        createdatms: 100,
        expiresatms: 200,
        presentation: pluginApprovalPresentation(title: "Plugin approval", description: "Review"),
        resolvedatms: 150,
        status: "denied",
        decision: ApprovalDecision.deny.rawValue,
        reason: .user)
    return encodedFixtureJSON(ApprovalResolveResult(applied: applied, approval: .denied(approval)))
}

private func makeAllowedExecApprovalJSON(
    _ approvalID: String,
    commandText: String,
    decision: ApprovalAllowDecision,
    applied: Bool) -> String
{
    let approval = AllowedApprovalSnapshot(
        id: approvalID,
        urlpath: "/approve/\(approvalID)",
        createdatms: 100,
        expiresatms: 4_000_000_000_000,
        presentation: execApprovalPresentation(commandText: commandText),
        resolvedatms: 150,
        status: "allowed",
        decision: decision,
        reason: .user)
    return encodedFixtureJSON(ApprovalResolveResult(applied: applied, approval: .allowed(approval)))
}

private func makeGatewayPair(
    firstURL: URL,
    firstStableID: String = "gateway-a",
    firstToken: String = "token-a",
    secondURL: URL,
    secondStableID: String = "gateway-b",
    secondToken: String = "token-b") throws -> (GatewayConnectConfig, GatewayConnectConfig)
{
    let options = GatewayConnectOptions(
        role: "node",
        scopes: [],
        caps: [],
        commands: [],
        permissions: [:],
        clientId: "ios",
        clientMode: "node",
        clientDisplayName: "Phone")
    return try (
        GatewayConnectConfig(
            url: firstURL,
            stableID: firstStableID,
            tls: nil,
            token: firstToken,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: options),
        GatewayConnectConfig(
            url: secondURL,
            stableID: secondStableID,
            tls: nil,
            token: secondToken,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: options))
}

@MainActor
private func makeWatchModel() -> (MockWatchMessagingService, NodeAppModel) {
    let watchService = MockWatchMessagingService()
    return (watchService, NodeAppModel(watchMessagingService: watchService))
}

@MainActor
private func makeWatchModel(
    notificationCenter: NotificationCentering) -> (MockWatchMessagingService, NodeAppModel)
{
    let watchService = MockWatchMessagingService()
    return (watchService, NodeAppModel(
        notificationCenter: notificationCenter,
        watchMessagingService: watchService))
}

@MainActor
private func makeTalkModel() -> (TalkModeManager, NodeAppModel) {
    let talkMode = TalkModeManager(allowSimulatorCapture: true)
    return (talkMode, NodeAppModel(talkMode: talkMode))
}

@MainActor
private func makeNodeModelWithMockServices() -> NodeAppModel {
    NodeAppModel(
        notificationCenter: MockBootstrapNotificationCenter(),
        watchMessagingService: MockWatchMessagingService())
}

@MainActor
private func makeNotificationModel(
    status: NotificationAuthorizationStatus) -> (MockBootstrapNotificationCenter, NodeAppModel)
{
    let center = MockBootstrapNotificationCenter()
    center.status = status
    return (center, NodeAppModel(notificationCenter: center))
}

private func makeInvokeRequest(
    id: String,
    command: String,
    params: some Encodable) throws -> BridgeInvokeRequest
{
    let data = try JSONEncoder().encode(params)
    return BridgeInvokeRequest(id: id, command: command, paramsJSON: String(decoding: data, as: UTF8.self))
}

private func makeWatchApprovalSnapshotRequest(
    _ id: String,
    gateway: String? = "test-gateway",
    held: [WatchExecApprovalSnapshotRequestItem] = [],
    sentAt: Int64) -> WatchExecApprovalSnapshotRequestEvent
{
    .init(
        requestId: id,
        gatewayStableID: gateway,
        heldApprovals: held,
        sentAtMs: sentAt,
        transport: "sendMessage")
}

private func makeWatchAppCommand(
    _ id: String,
    _ command: OpenClawWatchAppCommand,
    session: String? = "main",
    gateway: String? = nil,
    text: String? = nil,
    sentAt: Int64,
    transport: String = "sendMessage",
    kind: WatchMessageKind? = nil) -> WatchAppCommandEvent
{
    .init(
        commandId: id,
        command: command,
        sessionKey: session,
        gatewayStableID: gateway,
        text: text,
        sentAtMs: sentAt,
        transport: transport,
        messageKind: kind)
}

private func makeExpiredExecApprovalJSON(_ approvalID: String) -> String {
    #"{"approval":{"id":"\#(approvalID)","status":"expired","urlPath":"/approve/\#(approvalID)","createdAtMs":0,"expiresAtMs":1,"resolvedAtMs":2,"reason":"timeout","presentation":{"kind":"exec","commandText":"echo expired","commandPreview":"echo expired","warningText":null,"host":"gateway","nodeId":null,"agentId":"main","allowedDecisions":["allow-once","deny"]}}}"#
}

@MainActor
@discardableResult
private func waitForMainActorWork(
    timeout: Duration = .seconds(2),
    _ condition: () -> Bool) async -> Bool
{
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if condition() {
            return true
        }
        await Task.yield()
    }
    return condition()
}

@MainActor
private final class MockWatchMessagingService: @preconcurrency WatchMessagingServicing, @unchecked Sendable {
    var currentStatus = WatchMessagingStatus(
        supported: true,
        paired: true,
        appInstalled: true,
        reachable: true,
        activationState: "activated")
    var nextSendResult = WatchNotificationSendResult(
        deliveredImmediately: true,
        queuedForDelivery: false,
        transport: "sendMessage")
    var sendError: Error?
    var lastSent: (id: String, params: OpenClawWatchNotifyParams, gatewayStableID: String?)?
    var lastDirectNodeSetupCode: String?
    var lastSentExecApprovalPrompt: OpenClawWatchExecApprovalPromptMessage?
    var sentExecApprovalPrompts: [OpenClawWatchExecApprovalPromptMessage] = []
    var lastSentExecApprovalResolved: OpenClawWatchExecApprovalResolvedMessage?
    var lastSentExecApprovalExpired: OpenClawWatchExecApprovalExpiredMessage?
    var lastSentExecApprovalSnapshot: OpenClawWatchExecApprovalSnapshotMessage?
    var sentExecApprovalSnapshots: [OpenClawWatchExecApprovalSnapshotMessage] = []
    var lastSentAppSnapshot: OpenClawWatchAppSnapshotMessage?
    var syncExecApprovalSnapshotHandler: ((OpenClawWatchExecApprovalSnapshotMessage) async throws
        -> WatchNotificationSendResult)?
    var lastSentChatCompletion: OpenClawWatchChatCompletionMessage?
    private var statusHandler: (@Sendable (WatchMessagingStatus) -> Void)?
    private var replyHandler: (@Sendable (WatchQuickReplyEvent) -> Void)?
    private var execApprovalResolveHandler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?
    private var execApprovalSnapshotRequestHandler: (@Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?
    private var appSnapshotRequestHandler: (@Sendable (WatchAppSnapshotRequestEvent) -> Void)?
    private var appCommandHandler: (@Sendable (WatchAppCommandEvent) -> Void)?

    func status() async -> WatchMessagingStatus {
        self.currentStatus
    }

    func setStatusHandler(_ handler: (@Sendable (WatchMessagingStatus) -> Void)?) {
        self.statusHandler = handler
    }

    func emitStatus(_ status: WatchMessagingStatus) {
        self.currentStatus = status
        self.statusHandler?(status)
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

    func setAppSnapshotRequestHandler(_ handler: (@Sendable (WatchAppSnapshotRequestEvent) -> Void)?) {
        self.appSnapshotRequestHandler = handler
    }

    func setAppCommandHandler(_ handler: (@Sendable (WatchAppCommandEvent) -> Void)?) {
        self.appCommandHandler = handler
    }

    func sendNotification(
        id: String,
        params: OpenClawWatchNotifyParams,
        gatewayStableID: String?) async throws -> WatchNotificationSendResult
    {
        self.lastSent = (id: id, params: params, gatewayStableID: gatewayStableID)
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func sendDirectNodeSetup(setupCode: String) async throws -> WatchNotificationSendResult {
        self.lastDirectNodeSetupCode = setupCode
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func sendExecApprovalPrompt(
        _ message: OpenClawWatchExecApprovalPromptMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentExecApprovalPrompt = message
        self.sentExecApprovalPrompts.append(message)
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func sendExecApprovalResolved(
        _ message: OpenClawWatchExecApprovalResolvedMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentExecApprovalResolved = message
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func sendExecApprovalExpired(
        _ message: OpenClawWatchExecApprovalExpiredMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentExecApprovalExpired = message
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func syncExecApprovalSnapshot(
        _ message: OpenClawWatchExecApprovalSnapshotMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentExecApprovalSnapshot = message
        self.sentExecApprovalSnapshots.append(message)
        if let syncExecApprovalSnapshotHandler {
            return try await syncExecApprovalSnapshotHandler(message)
        }
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func syncAppSnapshot(
        _ message: OpenClawWatchAppSnapshotMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentAppSnapshot = message
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func sendChatCompletion(
        _ message: OpenClawWatchChatCompletionMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentChatCompletion = message
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func emitReply(_ event: WatchQuickReplyEvent) {
        self.replyHandler?(event)
    }

    func emitExecApprovalResolve(_ event: WatchExecApprovalResolveEvent) {
        self.execApprovalResolveHandler?(event)
    }

    func emitExecApprovalSnapshotRequest(_ event: WatchExecApprovalSnapshotRequestEvent) {
        self.execApprovalSnapshotRequestHandler?(event)
    }

    func emitAppSnapshotRequest(_ event: WatchAppSnapshotRequestEvent) {
        self.appSnapshotRequestHandler?(event)
    }

    func emitAppCommand(_ event: WatchAppCommandEvent) {
        self.appCommandHandler?(event)
    }
}

private final class MockBootstrapNotificationCenter: NotificationCentering, @unchecked Sendable {
    var status: NotificationAuthorizationStatus = .notDetermined
    var authorizationStatusHandler: (@Sendable () async -> NotificationAuthorizationStatus)?
    var addCalls = 0
    var pendingRemovedIdentifiers: [[String]] = []
    var deliveredRemovedIdentifiers: [[String]] = []
    var delivered: [NotificationSnapshot] = []

    func authorizationStatus() async -> NotificationAuthorizationStatus {
        if let authorizationStatusHandler {
            return await authorizationStatusHandler()
        }
        return self.status
    }

    func add(_: UNNotificationRequest) async throws {
        self.addCalls += 1
    }

    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) async {
        self.pendingRemovedIdentifiers.append(identifiers)
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) async {
        self.deliveredRemovedIdentifiers.append(identifiers)
    }

    func deliveredNotifications() async -> [NotificationSnapshot] {
        self.delivered
    }
}

private actor NotificationAuthorizationGate {
    private var didStart = false
    private var continuation: CheckedContinuation<NotificationAuthorizationStatus, Never>?

    func wait() async -> NotificationAuthorizationStatus {
        self.didStart = true
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func hasStarted() -> Bool {
        self.didStart
    }

    func resume(returning status: NotificationAuthorizationStatus) {
        self.continuation?.resume(returning: status)
        self.continuation = nil
    }
}

private actor WatchSnapshotSendGate {
    private var didStart = false
    private var resumePending = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        self.didStart = true
        if self.resumePending {
            self.resumePending = false
            return
        }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func hasStarted() -> Bool {
        self.didStart
    }

    func resume() {
        guard let continuation else {
            self.resumePending = true
            return
        }
        continuation.resume()
        self.continuation = nil
    }
}

private actor ExecApprovalResolutionGate {
    private var calls = 0
    private var continuation: CheckedContinuation<Void, Never>?

    func waitForFirstCall() async -> String {
        self.calls += 1
        guard self.calls == 1 else { return "unexpected duplicate approval write" }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
        return "simulated approval write failure"
    }

    func callCount() -> Int {
        self.calls
    }

    func hasStarted() -> Bool {
        self.calls > 0
    }

    func resume() {
        self.continuation?.resume()
        self.continuation = nil
    }
}

private actor ExecApprovalConcurrentWriteProbe {
    private var calls: [String] = []
    private var activeWrites = 0
    private var maximumActiveWrites = 0
    private var firstContinuation: CheckedContinuation<Void, Never>?

    func resolve(decision: String) async -> String {
        self.calls.append(decision)
        self.activeWrites += 1
        self.maximumActiveWrites = max(self.maximumActiveWrites, self.activeWrites)
        if self.calls.count == 1 {
            await withCheckedContinuation { continuation in
                self.firstContinuation = continuation
            }
        }
        self.activeWrites -= 1
        return "simulated approval write failure"
    }

    func snapshot() -> (calls: [String], maximumActiveWrites: Int) {
        (calls: self.calls, maximumActiveWrites: self.maximumActiveWrites)
    }

    func releaseFirst() {
        self.firstContinuation?.resume()
        self.firstContinuation = nil
    }
}

private func overrideNotificationServingPreference(_ enabled: Bool) -> () -> Void {
    let defaults = UserDefaults.standard
    let previous = defaults.object(forKey: NotificationServingPreference.storageKey)
    defaults.set(enabled, forKey: NotificationServingPreference.storageKey)
    return {
        if let previous {
            defaults.set(previous, forKey: NotificationServingPreference.storageKey)
        } else {
            defaults.removeObject(forKey: NotificationServingPreference.storageKey)
        }
    }
}

@Suite(.serialized) struct NodeAppModelInvokeTests {
    @Test @MainActor func `health summary routes a fixed period to the health service`() async throws {
        let service = MockHealthSummaryService()
        let appModel = NodeAppModel(healthSummaryService: service)
        let request = BridgeInvokeRequest(
            id: "health-1",
            command: OpenClawHealthCommand.summary.rawValue,
            paramsJSON: #"{"period":"today"}"#)

        let response = await appModel.handleInvoke(request)
        let payload = try decodeTalkPayload(OpenClawHealthSummaryPayload.self, from: response)

        #expect(response.ok)
        #expect(payload.period == .today)
        #expect(payload.stepCount == 42000)
        #expect(await service.periods == [.today])
    }

    @Test @MainActor func `health summary rejects arbitrary periods before querying`() async {
        let service = MockHealthSummaryService()
        let appModel = NodeAppModel(healthSummaryService: service)
        let request = BridgeInvokeRequest(
            id: "health-invalid",
            command: OpenClawHealthCommand.summary.rawValue,
            paramsJSON: #"{"period":"90d"}"#)

        let response = await appModel.handleInvoke(request)

        #expect(response.ok == false)
        #expect(response.error?.code == .invalidRequest)
        #expect(await service.periods.isEmpty)
    }

    @Test @MainActor func `chat session key defaults to main base`() {
        let appModel = NodeAppModel()
        #expect(appModel.chatSessionKey == "main")
        #expect(appModel.chatDeliveryAgentId == nil)
    }

    @Test @MainActor func `chat delivery owner requires persisted or gateway ownership`() {
        let appModel = NodeAppModel()
        #expect(appModel.chatDeliveryAgentId == nil)

        appModel.gatewayDefaultAgentId = " Agent-A "
        #expect(appModel.chatDeliveryAgentId == "agent-a")

        appModel.setSelectedAgentId(" Agent-B ")
        #expect(appModel.chatDeliveryAgentId == "agent-b")

        appModel.openChat(sessionKey: "agent:Agent-C:incident")
        #expect(appModel.chatDeliveryAgentId == "agent-c")
    }

    @Test @MainActor func `init preserves saved talk mode preference`() {
        withUserDefaults(["talk.enabled": true]) {
            let talkMode = TalkModeManager(allowSimulatorCapture: true)
            let appModel = NodeAppModel(talkMode: talkMode)

            #expect(UserDefaults.standard.bool(forKey: "talk.enabled"))
            #expect(appModel.talkMode.isEnabled)
        }
    }

    @Test @MainActor func `chat session key uses agent scoped key for non default agent`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.setSelectedAgentId("agent-123")
        #expect(appModel.chatSessionKey == SessionKey.makeAgentSessionKey(agentId: "agent-123", baseKey: "main"))
        #expect(appModel.mainSessionKey == "agent:agent-123:main")
    }

    @Test @MainActor func `explicit ownership keeps selected default agent scoped for Talk`() async throws {
        let appModel = NodeAppModel()
        let stableID = "talk-explicit-default-\(UUID().uuidString)"
        let databaseDirectoryURL = try #require(NodeAppModel.chatDatabaseDirectoryURL())
        let databases = try OpenClawClientDatabases(directoryURL: databaseDirectoryURL)
        let identity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "per-sender",
            mainSessionKey: "main",
            defaultAgentID: "main",
            selectionRequired: true,
            sessionRoutingContract: "opaque-routing-contract"))
        let store = databases.store(gatewayID: stableID)
        await store.storeSessionRoutingIdentity(identity)
        await store.retire()
        defer {
            try? databases.removeGatewayData(gatewayID: stableID)
            appModel.voiceWake.stop()
        }

        appModel.prepareForGatewayConnect(stableID: stableID)
        await appModel.chatSessionRoutingRestoreTask?.value

        appModel.openChat(sessionKey: "agent:research:incident")
        #expect(appModel.chatDeliveryAgentId == "research")
        #expect(appModel.mainSessionKey == "main")

        appModel.setTalkEnabled(true)
        #expect(!appModel.talkMode.isEnabled)
        #expect(appModel.talkMode.statusText == "Select an agent before enabling Talk")
        #expect(appModel.voiceCommandSessionKey() == nil)
        #expect(appModel.voiceWake.statusText == "Select an agent before using Voice Wake")
        await #expect(throws: Error.self) {
            try await appModel.sendVoiceTranscript(text: "hello", sessionKey: "main")
        }

        appModel.setSelectedAgentId("main")

        #expect(appModel.gatewayAgentSelectionRequired)
        #expect(appModel.mainSessionKey == "agent:main:main")
        #expect(appModel.talkMode._test_mainSessionKey() == "agent:main:main")
        #expect(appModel.voiceCommandSessionKey() == "agent:main:main")
    }

    @Test @MainActor func `routing restore revokes persisted Talk for an unowned session`() async throws {
        try await withUserDefaults(["talk.enabled": true]) {
            let talkMode = TalkModeManager(allowSimulatorCapture: true)
            let appModel = NodeAppModel(talkMode: talkMode)
            let stableID = "talk-persisted-unowned-\(UUID().uuidString)"
            let databaseDirectoryURL = try #require(NodeAppModel.chatDatabaseDirectoryURL())
            let databases = try OpenClawClientDatabases(directoryURL: databaseDirectoryURL)
            let identity = try #require(OpenClawChatSessionRoutingIdentity(
                scope: "per-sender",
                mainSessionKey: "main",
                defaultAgentID: "main",
                selectionRequired: true,
                sessionRoutingContract: "opaque-routing-contract"))
            let store = databases.store(gatewayID: stableID)
            await store.storeSessionRoutingIdentity(identity)
            await store.retire()
            defer {
                try? databases.removeGatewayData(gatewayID: stableID)
                appModel.voiceWake.stop()
            }

            #expect(appModel.talkMode.isEnabled)
            appModel.prepareForGatewayConnect(stableID: stableID)
            await appModel.chatSessionRoutingRestoreTask?.value

            #expect(appModel.gatewayAgentSelectionRequired)
            #expect(appModel.chatDeliveryAgentId == nil)
            #expect(!appModel.talkMode.isEnabled)
            #expect(!UserDefaults.standard.bool(forKey: "talk.enabled"))
            #expect(appModel.talkMode.statusText == "Select an agent before enabling Talk")
        }
    }

    @Test @MainActor func `fresh ownerless gateway stays gated until routing metadata resolves`() async {
        let appModel = NodeAppModel()
        let stableID = "routing-metadata-pending-\(UUID().uuidString)"
        GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: stableID, agentId: nil)
        defer {
            GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: stableID, agentId: nil)
            appModel.voiceWake.stop()
        }

        appModel.prepareForGatewayConnect(stableID: stableID)
        await appModel.chatSessionRoutingRestoreTask?.value

        #expect(appModel.gatewayAgentSelectionRequired)
        #expect(appModel.chatDeliveryAgentId == nil)
        #expect(appModel.chatSessionRoutingContract == nil)
        #expect(appModel.requiresExplicitAgentSelectionForVoice)
    }

    @Test @MainActor func `session key extracts canonical agent ID`() {
        #expect(SessionKey.agentId(from: "agent:rust-claw:mattermost:channel:w6g") == "rust-claw")
        #expect(SessionKey.agentId(from: " agent:main:main ") == "main")
        #expect(SessionKey.agentId(from: "main") == nil)
        #expect(SessionKey.agentId(from: "agent::main") == nil)
        #expect(SessionKey.agentId(from: nil) == nil)
    }

    @Test @MainActor func `chat agent name uses focused canonical session agent`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.gatewayAgents = [
            AgentSummary(
                id: "main",
                name: "Joshtimus Prime",
                identity: nil,
                workspace: nil,
                workspacegit: nil,
                model: nil,
                agentruntime: nil),
            AgentSummary(
                id: "rust-claw",
                name: "Rust Claw",
                identity: nil,
                workspace: nil,
                workspacegit: nil,
                model: nil,
                agentruntime: nil),
        ]
        appModel.setSelectedAgentId("main")

        appModel.openChat(sessionKey: "agent:rust-claw:mattermost:channel:w6gjp6iz3fyp3fo15q4fwfpnno")

        #expect(appModel.selectedAgentId == "main")
        #expect(appModel.activeAgentName == "Joshtimus Prime")
        #expect(appModel.chatAgentId == "rust-claw")
        #expect(appModel.chatAgentName == "Rust Claw")
    }

    @Test @MainActor func `chat agent name falls back to selected agent for unscoped session`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.gatewayAgents = [
            AgentSummary(
                id: "rust-claw",
                name: "Rust Claw",
                identity: nil,
                workspace: nil,
                workspacegit: nil,
                model: nil,
                agentruntime: nil),
        ]
        appModel.setSelectedAgentId("rust-claw")

        appModel.openChat(sessionKey: "incident-42")

        #expect(appModel.chatAgentId == "rust-claw")
        #expect(appModel.chatAgentName == "Rust Claw")
    }

    @Test @MainActor func `selecting agent clears explicit chat focus`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        let rustSessionKey = SessionKey.makeAgentSessionKey(agentId: "rust-claw", baseKey: "main")

        appModel.setSelectedAgentId("rust-claw")
        #expect(appModel.chatSessionKey == rustSessionKey)
        appModel.focusChatSession(rustSessionKey)

        appModel.setSelectedAgentId("main")
        #expect(appModel.defaultChatSessionKey == "main")
        #expect(appModel.mainSessionKey == "main")
        #expect(appModel.chatSessionKey == "main")
    }

    @Test @MainActor func `same selected agent keeps explicit chat focus`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.setSelectedAgentId("main")
        appModel.openChat(sessionKey: "incident-42")

        appModel.setSelectedAgentId("main")
        #expect(appModel.defaultChatSessionKey == "main")
        #expect(appModel.chatSessionKey == "incident-42")
    }

    @Test @MainActor func `default chat session key ignores explicit chat focus`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.setSelectedAgentId("rust-claw")
        appModel.openChat(sessionKey: "incident-42")

        #expect(appModel.defaultChatSessionKey == SessionKey.makeAgentSessionKey(
            agentId: "rust-claw",
            baseKey: "main"))
        #expect(appModel.chatSessionKey == "incident-42")
    }

    @Test @MainActor func `opening nil chat session clears explicit chat focus`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.setSelectedAgentId("rust-claw")
        appModel.openChat(sessionKey: "incident-42")

        appModel.openChat(sessionKey: nil)

        #expect(appModel.chatSessionKey == SessionKey.makeAgentSessionKey(
            agentId: "rust-claw",
            baseKey: "main"))

        appModel.setSelectedAgentId("main")
        #expect(appModel.chatSessionKey == "main")
    }

    @Test @MainActor func `exec approval prompt presentation tracks latest notification tap`() throws {
        let appModel = NodeAppModel()
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-1",
                    commandText: "echo first",
                    expiresAtMs: 1)))

        let firstPrompt = try #require(appModel.pendingExecApprovalPrompt)
        #expect(firstPrompt.id == "approval-1")
        #expect(firstPrompt.commandText == "echo first")
        #expect(firstPrompt.allowsAllowAlways == false)

        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-2",
                    commandText: "echo second",
                    allowedDecisions: ["allow-once", "allow-always", "deny"],
                    nodeId: "node-2",
                    agentId: nil,
                    expiresAtMs: 2)))

        let secondPrompt = try #require(appModel.pendingExecApprovalPrompt)
        #expect(secondPrompt.id == "approval-2")
        #expect(secondPrompt.commandText == "echo second")
        #expect(secondPrompt.allowsAllowAlways)

        appModel.dismissPendingExecApprovalPrompt()
        #expect(appModel.pendingExecApprovalPrompt == nil)
    }

    @Test @MainActor func `explicit notification tap replaces visible approval after canonical fetch`() async throws {
        let fetchGate = WatchSnapshotSendGate()
        let appModel = makeNodeModelWithMockServices()
        appModel.connectedGatewayID = "test-gateway"
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-visible-a",
                commandText: "echo visible-a",
                expiresAtMs: 4_000_000_000_000)))
        appModel._test_setUnifiedExecApprovalGetResponse(
            makePendingExecApprovalJSON("approval-tapped-b", commandText: "echo tapped-b"),
            beforeResponse: { await fetchGate.wait() })

        let fetching = Task { @MainActor in
            await appModel._test_presentExecApprovalNotificationPrompt(ExecApprovalNotificationPrompt(
                approvalId: "approval-tapped-b",
                gatewayDeviceId: nil))
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !(fetchGate.hasStarted()), ContinuousClock().now < deadline {
            await Task.yield()
        }

        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-visible-a")
        await fetchGate.resume()
        await fetching.value
        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-tapped-b")
        #expect(appModel.pendingExecApprovalPrompt?.commandText == "echo tapped-b")
    }

    @Test @MainActor func `unified approval get accepts matching exec and plugin presentations`() throws {
        let execJSON = #"""
        {
          "approval": {
            "id": "approval-unified",
            "status": "pending",
            "urlPath": "/approve/approval-unified",
            "createdAtMs": 100,
            "expiresAtMs": 200,
            "presentation": {
              "kind": "exec",
              "commandText": "echo unified",
              "commandPreview": "echo unified",
              "warningText": "  Review shell expansion  ",
              "host": "gateway",
              "nodeId": null,
              "agentId": "main",
              "allowedDecisions": ["allow-once", "deny"]
            }
          }
        }
        """#

        let decodedPrompt = try NodeAppModel._test_decodeUnifiedExecApprovalPrompt(
            execJSON,
            approvalID: "approval-unified")
        let prompt = try #require(decodedPrompt)
        #expect(prompt.kind == "exec")
        #expect(prompt.commandText == "echo unified")
        #expect(prompt.warningText == "Review shell expansion")
        #expect(prompt.allowedDecisions == ["allow-once", "deny"])
        #expect(prompt.gatewayStableID == "test-gateway")

        #expect(try NodeAppModel._test_decodeUnifiedExecApprovalPrompt(
            execJSON,
            approvalID: "different-approval") == nil)

        let composedID = "approval-\u{00E9}"
        let decomposedID = "approval-e\u{0301}"
        let composedJSON = execJSON.replacingOccurrences(
            of: "approval-unified",
            with: composedID)
        #expect(try NodeAppModel._test_decodeUnifiedExecApprovalPrompt(
            composedJSON,
            approvalID: composedID)?.id == composedID)
        #expect(try NodeAppModel._test_decodeUnifiedExecApprovalPrompt(
            composedJSON,
            approvalID: decomposedID) == nil)

        let pluginJSON = #"""
        {
          "approval": {
            "id": "approval-unified",
            "status": "pending",
            "urlPath": "/approve/approval-unified",
            "createdAtMs": 100,
            "expiresAtMs": 200,
            "presentation": {
              "kind": "plugin",
              "title": "Plugin approval",
              "description": "Review",
              "severity": "warning",
              "pluginId": "example",
              "toolName": "guarded",
              "agentId": "main",
              "allowedDecisions": ["allow-once", "deny"]
            }
          }
        }
        """#
        let decodedPluginPrompt = try NodeAppModel._test_decodeUnifiedExecApprovalPrompt(
            pluginJSON,
            approvalID: "approval-unified")
        let pluginPrompt = try #require(decodedPluginPrompt)
        #expect(pluginPrompt.kind == "plugin")
        #expect(pluginPrompt.commandText == "Plugin approval")
        #expect(pluginPrompt.descriptionText == "Review")
        #expect(pluginPrompt.pluginId == "example")
        #expect(pluginPrompt.toolName == "guarded")
        #expect(pluginPrompt.pluginSeverity == "warning")
        #expect(pluginPrompt.agentId == "main")
        #expect(pluginPrompt.allowedDecisions == ["allow-once", "deny"])
        #expect(pluginPrompt.allowsAllowOnce)
        #expect(!pluginPrompt.allowsAllowAlways)
        #expect(pluginPrompt.allowsDeny)

        let whitespaceDescriptionJSON = pluginJSON.replacingOccurrences(
            of: #""description": "Review""#,
            with: #""description": "   ""#)
        #expect(try NodeAppModel._test_decodeUnifiedExecApprovalPrompt(
            whitespaceDescriptionJSON,
            approvalID: "approval-unified") == nil)
    }

    @Test @MainActor func `plugin notification prompt resolves with plugin kind`() async throws {
        let pluginJSON = makePendingApprovalJSON(
            id: "approval-plugin",
            presentation: pluginApprovalPresentation(
                title: "Allow guarded plugin tool?",
                description: "The plugin wants to perform a guarded action."))
        let capture = ApprovalResolutionCapture()
        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        appModel.connectedGatewayID = "test-gateway"
        appModel._test_setUnifiedExecApprovalGetResponse(pluginJSON)
        appModel._test_setExecApprovalResolutionSuccessHandler { _, kind, _, _ in
            await capture.record(kind: kind)
        }

        await appModel._test_presentExecApprovalNotificationPrompt(ApprovalNotificationPrompt(
            approvalId: "approval-plugin",
            gatewayDeviceId: nil,
            kind: .plugin))

        let prompt = try #require(appModel.pendingExecApprovalPrompt)
        #expect(prompt.kind == "plugin")
        #expect(prompt.commandText == "Allow guarded plugin tool?")
        #expect(prompt.descriptionText == "The plugin wants to perform a guarded action.")
        #expect(prompt.allowsAllowOnce)
        #expect(!prompt.allowsAllowAlways)
        #expect(prompt.allowsDeny)
        #expect(watchService.lastSentExecApprovalPrompt == nil)

        await appModel.resolvePendingExecApprovalPrompt(decision: "deny")

        #expect(await capture.recordedKind() == .plugin)
        #expect(appModel._test_pendingExecApprovalState().resolved == "Approval denied.")
        #expect(watchService.lastSentExecApprovalResolved == nil)
    }

    @Test @MainActor func `persisted plugin approval restores into phone inbox only`() throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }

        let firstWatchService = MockWatchMessagingService()
        let firstModel = NodeAppModel(watchMessagingService: firstWatchService)
        firstModel.connectedGatewayID = "test-gateway"
        try firstModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-plugin-restored",
                kind: .plugin,
                commandText: "Allow guarded plugin tool?",
                allowedDecisions: ["allow-once", "deny"],
                descriptionText: "The plugin wants to perform a guarded action.",
                pluginId: "example",
                toolName: "guarded",
                pluginSeverity: "warning",
                expiresAtMs: 4_000_000_000_000)))
        #expect(firstWatchService.lastSentExecApprovalPrompt == nil)

        let restoredWatchService = MockWatchMessagingService()
        let restoredModel = NodeAppModel(watchMessagingService: restoredWatchService)
        restoredModel.connectedGatewayID = "test-gateway"

        #expect(restoredModel._test_pendingExecApprovalInboxItems().map(\.id) == [
            "approval-plugin-restored",
        ])
        restoredModel._test_presentPendingExecApprovalFromInbox(
            approvalID: "approval-plugin-restored",
            gatewayStableID: "test-gateway")
        #expect(restoredModel.pendingExecApprovalPrompt?.kind == "plugin")
        #expect(restoredWatchService.lastSentExecApprovalPrompt == nil)
    }

    @Test @MainActor func `exec approval prompt rejects malformed decision sets`() {
        for decisions in [
            ["allow-once"],
            ["allow-once", "allow-once", "deny"],
            ["accept", "deny"],
            [" allow-once ", "deny"],
            ["allow-once", "deny "],
        ] {
            #expect(NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-malformed",
                commandText: "echo guarded",
                allowedDecisions: decisions,
                expiresAtMs: 200) == nil)
        }
    }

    @Test @MainActor func `unified approval resolve reports and applies canonical late winner`() async throws {
        let paramsData = try JSONEncoder().encode(ApprovalResolveParams(
            id: "approval-race",
            kind: .exec,
            decision: .deny))
        let params = try #require(JSONSerialization.jsonObject(with: paramsData) as? [String: String])
        #expect(params == [
            "id": "approval-race",
            "kind": "exec",
            "decision": "deny",
        ])

        let responseJSON = #"""
        {
          "applied": false,
          "approval": {
            "id": "approval-race",
            "status": "allowed",
            "urlPath": "/approve/approval-race",
            "createdAtMs": 100,
            "expiresAtMs": 200,
            "resolvedAtMs": 150,
            "reason": "user",
            "decision": "allow-always",
            "presentation": {
              "kind": "exec",
              "commandText": "npm publish",
              "commandPreview": "npm publish",
              "warningText": "Publishes a package",
              "host": "gateway",
              "nodeId": null,
              "agentId": "main",
              "allowedDecisions": ["allow-once", "allow-always", "deny"]
            }
          }
        }
        """#

        let decodedResult = try NodeAppModel._test_decodeUnifiedExecApprovalResolution(
            responseJSON,
            approvalID: "approval-race")
        let result = try #require(decodedResult)
        #expect(!result.applied)
        #expect(result.status == "allowed")
        #expect(result.decision == "allow-always")
        #expect(result.text == "This approval was already set to Always Allow.")
        #expect(try NodeAppModel._test_isValidUnifiedExecApprovalResolveAck(
            responseJSON,
            approvalID: "approval-race",
            attemptedDecision: .deny))
        let mismatchedAppliedAck = try NodeAppModel._test_isValidUnifiedExecApprovalResolveAck(
            responseJSON.replacingOccurrences(of: #""applied": false"#, with: #""applied": true"#),
            approvalID: "approval-race",
            attemptedDecision: .deny)
        #expect(!mismatchedAppliedAck)
        #expect(try NodeAppModel._test_decodeUnifiedExecApprovalResolution(
            responseJSON,
            approvalID: "different-approval") == nil)
        for malformedResponse in [
            responseJSON.replacingOccurrences(
                of: #""urlPath": "/approve/approval-race""#,
                with: #""urlPath": """#),
            responseJSON.replacingOccurrences(
                of: #""createdAtMs": 100"#,
                with: #""createdAtMs": -1"#),
            responseJSON.replacingOccurrences(
                of: #""resolvedAtMs": 150"#,
                with: #""resolvedAtMs": -1"#),
            responseJSON.replacingOccurrences(
                of: #"["allow-once", "allow-always", "deny"]"#,
                with: #"["allow-once", "deny"]"#),
            responseJSON.replacingOccurrences(
                of: #"["allow-once", "allow-always", "deny"]"#,
                with: #"["allow-always", "allow-always", "deny"]"#),
        ] {
            #expect(try NodeAppModel._test_decodeUnifiedExecApprovalResolution(
                malformedResponse,
                approvalID: "approval-race") == nil)
        }

        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-race",
                commandText: "npm publish",
                warningText: "Publishes a package",
                allowedDecisions: ["allow-once", "allow-always", "deny"],
                expiresAtMs: 200)))
        #expect(try await appModel._test_applyUnifiedExecApprovalResolveResult(
            responseJSON,
            approvalID: "approval-race",
            attemptedDecision: .deny))
        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-race")
        #expect(appModel._test_pendingExecApprovalState().resolved ==
            "This approval was already set to Always Allow.")
        #expect(appModel._test_pendingExecApprovalState().tone == .success)
        #expect(appModel._test_pendingExecApprovalState().resolving == false)
        await appModel.resolvePendingExecApprovalPrompt(decision: "deny")
        #expect(appModel._test_pendingExecApprovalState().resolved ==
            "This approval was already set to Always Allow.")
        #expect(appModel._test_pendingExecApprovalState().resolving == false)
        #expect(watchService.lastSentExecApprovalResolved?.source == "another-reviewer")
        #expect(watchService.lastSentExecApprovalResolved?.outcome == .allowedAlways)
        #expect(watchService.lastSentExecApprovalResolved?.outcomeText ==
            "This approval was already set to Always Allow.")

        let ownWinnerService = MockWatchMessagingService()
        let ownWinnerModel = NodeAppModel(watchMessagingService: ownWinnerService)
        try ownWinnerModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-race",
                commandText: "npm publish",
                allowedDecisions: ["allow-once", "allow-always", "deny"],
                expiresAtMs: 200)))
        let ownWinnerResponse = responseJSON.replacingOccurrences(
            of: #""applied": false"#,
            with: #""applied": true"#)
        #expect(try await ownWinnerModel._test_applyUnifiedExecApprovalResolveResult(
            ownWinnerResponse,
            approvalID: "approval-race",
            attemptedDecision: .allowAlways))
        #expect(ownWinnerModel.pendingExecApprovalPrompt?.id == "approval-race")
        #expect(ownWinnerModel._test_pendingExecApprovalState().resolved ==
            "Approval set to Always Allow.")
        #expect(ownWinnerModel._test_pendingExecApprovalInboxItems().isEmpty)
        #expect(ownWinnerService.lastSentExecApprovalResolved?.source == "iphone")

        let pluginResponseJSON = makeDeniedPluginApprovalJSON("approval-race", applied: false)
        let decodedPluginResult = try NodeAppModel._test_decodeUnifiedExecApprovalResolution(
            pluginResponseJSON,
            approvalID: "approval-race")
        let pluginResult = try #require(decodedPluginResult)
        #expect(pluginResult.status == "denied")
        #expect(pluginResult.decision == "deny")
        #expect(pluginResult.text == "This approval was already denied.")
    }

    @Test @MainActor func `legacy approval resolve acknowledgment uses neutral gateway attribution`() async throws {
        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-legacy-ack",
                commandText: "echo legacy",
                allowedDecisions: ["deny"],
                expiresAtMs: nil)))

        await appModel._test_applyLegacyExecApprovalTerminal(
            approvalID: "approval-legacy-ack",
            decision: .deny)

        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-legacy-ack")
        #expect(appModel._test_pendingExecApprovalState().resolved == "Approval denied.")
        #expect(watchService.lastSentExecApprovalResolved?.source == "gateway")
        #expect(watchService.lastSentExecApprovalResolved?.outcome == .denied)
        #expect(watchService.lastSentExecApprovalResolved?.outcomeText == "Approval denied.")
    }

    @Test @MainActor func `canonical denial keeps destructive terminal tone`() async throws {
        let responseJSON = makeDeniedExecApprovalJSON(
            "approval-denied-elsewhere",
            commandText: "rm -rf build",
            commandPreview: "rm build",
            warningText: "Deletes build output",
            applied: false)
        let appModel = makeNodeModelWithMockServices()
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-denied-elsewhere",
                commandText: "rm -rf build",
                warningText: "Deletes build output",
                expiresAtMs: 200)))

        #expect(try await appModel._test_applyUnifiedExecApprovalResolveResult(
            responseJSON,
            approvalID: "approval-denied-elsewhere",
            attemptedDecision: .allowOnce))
        #expect(appModel._test_pendingExecApprovalState().resolved ==
            "This approval was already denied.")
        #expect(appModel._test_pendingExecApprovalState().tone == .danger)
    }

    @Test @MainActor func `gateway switch invalidates privileged approval surfaces`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let watchService = MockWatchMessagingService()
        let notificationCenter = MockBootstrapNotificationCenter()
        notificationCenter.delivered = [
            NotificationSnapshot(
                identifier: "old-requested-approval",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "recovery-a",
                        "gatewayDeviceId": "device-a",
                    ],
                ]),
            NotificationSnapshot(
                identifier: "new-requested-approval",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "recovery-b",
                        "gatewayDeviceId": "device-b",
                    ],
                ]),
        ]
        let appModel = NodeAppModel(
            notificationCenter: notificationCenter,
            watchMessagingService: watchService)
        defer { appModel.disconnectGateway() }
        let (gatewayA, gatewayB) = try makeGatewayPair(
            firstURL: #require(URL(string: "wss://127.0.0.1:1")),
            secondURL: #require(URL(string: "wss://127.0.0.1:2")))

        appModel.applyGatewayConnectConfig(gatewayA)
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "shared-approval-id",
                gatewayStableID: gatewayA.effectiveStableID,
                commandText: "deploy gateway A",
                host: "gateway-a",
                expiresAtMs: nil)))
        appModel._test_recordPendingWatchExecApprovalRecoveryID(
            "recovery-a",
            gatewayDeviceId: "device-a")

        appModel.applyGatewayConnectConfig(gatewayB)
        for _ in 0..<1000
            where notificationCenter.deliveredRemovedIdentifiers.isEmpty
            || watchService.lastSentExecApprovalSnapshot?.approvals.isEmpty != true
        {
            await Task.yield()
        }

        #expect(appModel.pendingExecApprovalPrompt == nil)
        #expect(appModel._test_pendingWatchExecApprovalRecoveryIDs().isEmpty)
        #expect(watchService.lastSentExecApprovalSnapshot?.approvals.isEmpty == true)
        #expect(notificationCenter.pendingRemovedIdentifiers.contains([
            "exec.approval-v2.8:device-a.recovery-a",
            "exec.approval.device-a.recovery-a",
        ]))
        #expect(notificationCenter.deliveredRemovedIdentifiers.contains([
            "old-requested-approval",
        ]))
        #expect(!notificationCenter.deliveredRemovedIdentifiers
            .flatMap(\.self)
            .contains("new-requested-approval"))

        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "shared-approval-id",
                gatewayStableID: gatewayB.effectiveStableID,
                commandText: "deploy gateway B",
                host: "gateway-b",
                expiresAtMs: nil)))

        watchService.emitExecApprovalResolve(WatchExecApprovalResolveEvent(
            replyId: "stale-watch-reply",
            approvalId: "shared-approval-id",
            gatewayStableID: gatewayA.effectiveStableID,
            decision: .allowOnce,
            sentAtMs: nil,
            transport: "test"))
        await Task.yield()
        await Task.yield()

        #expect(watchService.lastSentExecApprovalResolved == nil)
        #expect(watchService.lastSentExecApprovalExpired == nil)
        #expect(watchService.lastSentExecApprovalSnapshot?.approvals.first?.gatewayStableID == gatewayB
            .effectiveStableID)
    }

    @Test @MainActor func `uncertain approval survives dismiss and restart until canonical readback`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = makeNodeModelWithMockServices()
        let approvalID = "approval-uncertain-dismissible"
        let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
            id: approvalID,
            commandText: "echo uncertain",
            expiresAtMs: 4_000_000_000_000))
        appModel._test_presentExecApprovalPrompt(prompt)

        let uncertainMessage = "Decision status is unknown. Actions remain locked until OpenClaw reconnects."
        appModel._test_setPendingExecApprovalPromptUncertain(uncertainMessage)

        #expect(appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalState().canDismiss)
        appModel.dismissPendingExecApprovalPrompt()
        #expect(appModel.pendingExecApprovalPrompt == nil)

        appModel._test_presentPendingExecApprovalFromInbox(
            approvalID: approvalID,
            gatewayStableID: prompt.gatewayStableID)
        #expect(appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalState().error == uncertainMessage)

        let restoredModel = makeNodeModelWithMockServices()
        restoredModel._test_presentExecApprovalPrompt(prompt)
        #expect(restoredModel._test_pendingExecApprovalState().resolving)
        #expect(restoredModel._test_pendingExecApprovalState().error == uncertainMessage)

        restoredModel._test_setUnifiedExecApprovalGetResponse(makePendingExecApprovalJSON(approvalID))
        await restoredModel.reconcileWatchExecApprovalCache(reason: "operator_reconnected")
        #expect(!restoredModel._test_pendingExecApprovalState().resolving)
        #expect(restoredModel._test_pendingExecApprovalState().error ==
            "The previous decision was not recorded. Review and try again.")
    }

    @Test @MainActor func `readback started before uncertainty cannot unlock approval`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let approvalID = "approval-uncertain-readback-fence"
        let appModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: approvalID,
                commandText: "echo fenced",
                expiresAtMs: 4_000_000_000_000)))
        let fetchGate = WatchSnapshotSendGate()
        appModel._test_setUnifiedExecApprovalGetResponse(
            makePendingExecApprovalJSON(approvalID),
            beforeResponse: { await fetchGate.wait() })

        let reconciliation = Task { @MainActor in
            await appModel.reconcileWatchExecApprovalCache(reason: "operator_reconnected")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !fetchGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }
        #expect(await fetchGate.hasStarted())
        let uncertainMessage = "Decision status is unknown while an older readback is in flight."
        appModel._test_setPendingExecApprovalPromptUncertain(uncertainMessage)
        await fetchGate.resume()
        _ = await reconciliation.value

        #expect(appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalState().error == uncertainMessage)
    }

    @Test @MainActor func `expired persisted uncertainty remains a canonical readback candidate`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let approvalID = "approval-expired-uncertainty-readback"
        let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
            id: approvalID,
            commandText: "echo expired",
            expiresAtMs: 1))
        let firstModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        firstModel._test_presentExecApprovalPrompt(prompt)
        firstModel._test_setPendingExecApprovalPromptUncertain("Awaiting expired terminal truth.")
        #expect(firstModel._test_watchExecApprovalCacheIDs().isEmpty)
        #expect(firstModel._test_pendingPersistedExecApprovalReadbacks().map(\.approvalId) == [approvalID])

        let restoredModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        restoredModel.connectedGatewayID = prompt.gatewayStableID
        #expect(restoredModel._test_watchExecApprovalCacheIDs().isEmpty)
        #expect(restoredModel._test_pendingPersistedExecApprovalReadbacks().map(\.approvalId) == [approvalID])
        restoredModel._test_setUnifiedExecApprovalGetResponse(makeExpiredExecApprovalJSON(approvalID))
        await restoredModel.reconcileWatchExecApprovalCache(reason: "operator_reconnected")

        #expect(restoredModel._test_pendingPersistedExecApprovalReadbacks().isEmpty)
        restoredModel._test_presentExecApprovalPrompt(prompt)
        #expect(restoredModel.pendingExecApprovalPrompt == nil)
    }

    @Test @MainActor func `canonical pending readback resumes queued watch decision`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let approvalID = "approval-watch-uncertain-resume"
        let appModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
            id: approvalID,
            commandText: "echo watch",
            expiresAtMs: 4_000_000_000_000))
        appModel._test_presentExecApprovalPrompt(prompt)
        appModel._test_setPendingExecApprovalPromptUncertain("Awaiting canonical state.")
        let watchEvent = WatchExecApprovalResolveEvent(
            replyId: "watch-uncertain-resume",
            approvalId: approvalID,
            gatewayStableID: prompt.gatewayStableID,
            decision: .deny,
            sentAtMs: 123,
            transport: "test")
        let resolvedImmediately = await appModel.handleWatchExecApprovalResolve(watchEvent)
        #expect(!resolvedImmediately)

        let writeGate = ExecApprovalResolutionGate()
        appModel._test_setExecApprovalResolutionFailureHandler { _, _, _ in
            await writeGate.waitForFirstCall()
        }
        appModel._test_setUnifiedExecApprovalGetResponse(makePendingExecApprovalJSON(approvalID))
        await appModel.reconcileWatchExecApprovalCache(reason: "operator_reconnected")
        let deadline = ContinuousClock().now.advanced(by: .seconds(10))
        while await !writeGate.hasStarted(), ContinuousClock().now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        let writeCount = await writeGate.callCount()
        #expect(writeCount == 1)
        await writeGate.resume()
    }

    @Test @MainActor func `uncertain result stays owner scoped after another prompt replaces it`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        let firstPrompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
            id: "approval-uncertain-replaced",
            commandText: "echo first",
            expiresAtMs: 4_000_000_000_000))
        let secondPrompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
            id: "approval-visible-replacement",
            commandText: "echo second",
            allowedDecisions: ["deny"],
            expiresAtMs: 4_000_000_000_000))
        appModel._test_presentExecApprovalPrompt(firstPrompt)
        let writeGate = ExecApprovalResolutionGate()
        appModel._test_setExecApprovalResolutionUncertainHandler { _, _, _ in
            await writeGate.waitForFirstCall()
        }

        let firstWrite = Task { @MainActor in
            await appModel.resolvePendingExecApprovalPrompt(decision: "allow-once")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !writeGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }
        #expect(await writeGate.hasStarted())
        appModel._test_presentExecApprovalPrompt(secondPrompt)
        await writeGate.resume()
        await firstWrite.value

        #expect(appModel.pendingExecApprovalPrompt?.id == secondPrompt.id)
        appModel.dismissPendingExecApprovalPrompt()
        appModel._test_presentPendingExecApprovalFromInbox(
            approvalID: firstPrompt.id,
            gatewayStableID: firstPrompt.gatewayStableID)
        #expect(appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalState().error == "simulated approval write failure")
    }

    @Test @MainActor func `canonical terminal invalidates an in flight uncertain result`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        let approvalID = "approval-terminal-beats-uncertain"
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: approvalID,
                commandText: "echo terminal",
                expiresAtMs: 4_000_000_000_000)))
        let writeGate = ExecApprovalResolutionGate()
        appModel._test_setExecApprovalResolutionUncertainHandler { _, _, _ in
            await writeGate.waitForFirstCall()
        }

        let pendingWrite = Task { @MainActor in
            await appModel.resolvePendingExecApprovalPrompt(decision: "allow-once")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !writeGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }
        #expect(await writeGate.hasStarted())
        let terminalApplied = await appModel._test_applyLegacyExecApprovalTerminal(
            approvalID: approvalID,
            decision: .deny)
        #expect(terminalApplied)
        await writeGate.resume()
        await pendingWrite.value

        #expect(appModel._test_pendingExecApprovalState().resolved == "Approval denied.")
        #expect(!appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalInboxItems().isEmpty)
    }

    @Test @MainActor func `gateway switch during uncertain resolve keeps owner frozen after switching back`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = makeNodeModelWithMockServices()
        defer { appModel.disconnectGateway() }
        let (gatewayA, gatewayB) = try makeGatewayPair(
            firstURL: #require(URL(string: "wss://127.0.0.1:1")),
            secondURL: #require(URL(string: "wss://127.0.0.1:2")))
        let approvalID = "approval-switch-mid-uncertain"
        let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
            id: approvalID,
            gatewayStableID: gatewayA.effectiveStableID,
            commandText: "echo switch",
            host: "gateway-a",
            expiresAtMs: 4_000_000_000_000))

        appModel.applyGatewayConnectConfig(gatewayA)
        appModel._test_presentExecApprovalPrompt(prompt)
        let writeGate = ExecApprovalResolutionGate()
        appModel._test_setExecApprovalResolutionUncertainHandler { _, _, _ in
            await writeGate.waitForFirstCall()
        }

        let pendingWrite = Task { @MainActor in
            await appModel.resolvePendingExecApprovalPrompt(decision: "allow-once")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !writeGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }
        #expect(await writeGate.hasStarted())
        appModel.applyGatewayConnectConfig(gatewayB)
        await writeGate.resume()
        await pendingWrite.value

        // The invalidated attempt must not surface UI on the newly selected gateway,
        // but the lost outcome must survive as an owner-scoped readback candidate.
        #expect(appModel.pendingExecApprovalPrompt == nil)
        #expect(appModel._test_pendingPersistedExecApprovalReadbacks().contains { readback in
            readback.approvalId == approvalID && readback.gatewayStableID == gatewayA.effectiveStableID
        })

        appModel.applyGatewayConnectConfig(gatewayA)
        appModel._test_presentExecApprovalPrompt(prompt)
        #expect(appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalState().error == "simulated approval write failure")

        let restoredModel = makeNodeModelWithMockServices()
        restoredModel._test_presentExecApprovalPrompt(prompt)
        #expect(restoredModel._test_pendingExecApprovalState().resolving)
        #expect(restoredModel._test_pendingExecApprovalState().error == "simulated approval write failure")
    }

    @Test @MainActor func `gateway switch during in flight resolve keeps the owner write fence`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = makeNodeModelWithMockServices()
        defer { appModel.disconnectGateway() }
        let (gatewayA, gatewayB) = try makeGatewayPair(
            firstURL: #require(URL(string: "wss://127.0.0.1:1")),
            secondURL: #require(URL(string: "wss://127.0.0.1:2")))
        let approvalID = "approval-switch-mid-write"
        let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
            id: approvalID,
            gatewayStableID: gatewayA.effectiveStableID,
            commandText: "echo fence",
            host: "gateway-a",
            expiresAtMs: 4_000_000_000_000))

        appModel.applyGatewayConnectConfig(gatewayA)
        appModel._test_presentExecApprovalPrompt(prompt)
        let writeGate = ExecApprovalResolutionGate()
        appModel._test_setExecApprovalResolutionFailureHandler { _, _, _ in
            await writeGate.waitForFirstCall()
        }

        let pendingWrite = Task { @MainActor in
            await appModel.resolvePendingExecApprovalPrompt(decision: "allow-once")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !writeGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }
        #expect(await writeGate.hasStarted())

        appModel.applyGatewayConnectConfig(gatewayB)
        appModel.applyGatewayConnectConfig(gatewayA)
        appModel._test_presentExecApprovalPrompt(prompt)
        // The preserved write fence keeps the owner card non-actionable: the prompt
        // renders as resolving and a second resolution attempt never reaches transport.
        #expect(appModel._test_pendingExecApprovalState().resolving)
        await appModel.resolvePendingExecApprovalPrompt(decision: "deny")
        #expect(await writeGate.callCount() == 1)

        await writeGate.resume()
        await pendingWrite.value

        // Settling the original write releases the fence and reports its outcome.
        #expect(!appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalState().error == "simulated approval write failure")
        await appModel.resolvePendingExecApprovalPrompt(decision: "deny")
        #expect(await writeGate.callCount() == 2)
    }

    @Test @MainActor func `gateway switch during unknown ack readback keeps re-presented card resolving`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = makeNodeModelWithMockServices()
        defer { appModel.disconnectGateway() }
        let (gatewayA, gatewayB) = try makeGatewayPair(
            firstURL: #require(URL(string: "wss://127.0.0.1:1")),
            secondURL: #require(URL(string: "wss://127.0.0.1:2")))
        let approvalID = "approval-switch-mid-readback"
        let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
            id: approvalID,
            gatewayStableID: gatewayA.effectiveStableID,
            commandText: "echo readback",
            host: "gateway-a",
            expiresAtMs: 4_000_000_000_000))

        appModel.applyGatewayConnectConfig(gatewayA)
        appModel._test_presentExecApprovalPrompt(prompt)
        appModel._test_setExecApprovalResolutionUnknownAck()
        let fetchGate = ExecApprovalResolutionGate()
        appModel._test_setUnifiedExecApprovalGetResponse(
            makePendingExecApprovalJSON(approvalID),
            beforeResponse: { _ = await fetchGate.waitForFirstCall() })

        let pendingWrite = Task { @MainActor in
            await appModel.resolvePendingExecApprovalPrompt(decision: "allow-once")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !fetchGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }
        #expect(await fetchGate.hasStarted())

        appModel.applyGatewayConnectConfig(gatewayB)
        appModel.applyGatewayConnectConfig(gatewayA)
        appModel._test_presentExecApprovalPrompt(prompt)
        // The write settled but readback has not classified it: the attempt lease is
        // still held, so the re-presented card must render resolving (non-actionable)
        // and a second resolution attempt must never reach the transport.
        #expect(appModel._test_pendingExecApprovalState().resolving)
        await appModel.resolvePendingExecApprovalPrompt(decision: "deny")
        #expect(await fetchGate.callCount() == 1)

        await fetchGate.resume()
        await pendingWrite.value

        // The gated readback lost its route to the A->B->A switch, so the settle is the
        // owner-frozen uncertain contract with a durable readback record.
        #expect(appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalState().error ==
            "Decision status is unknown. Actions remain locked until OpenClaw reconnects.")
        #expect(appModel._test_pendingPersistedExecApprovalReadbacks().contains { readback in
            readback.approvalId == approvalID && readback.gatewayStableID == gatewayA.effectiveStableID
        })
    }

    @Test @MainActor func `watch pending retry after unknown ack unlocks the phone card`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = makeNodeModelWithMockServices()
        let approvalID = "approval-watch-unknown-ack-retry"
        let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
            id: approvalID,
            commandText: "echo watch retry",
            expiresAtMs: 4_000_000_000_000))
        appModel._test_presentExecApprovalPrompt(prompt)
        appModel._test_setExecApprovalResolutionUnknownAck()
        let fetchGate = ExecApprovalResolutionGate()
        appModel._test_setUnifiedExecApprovalGetResponse(
            makePendingExecApprovalJSON(approvalID),
            beforeResponse: { _ = await fetchGate.waitForFirstCall() })

        let watchResolve = Task { @MainActor in
            await appModel.handleWatchExecApprovalResolve(WatchExecApprovalResolveEvent(
                replyId: "watch-unknown-ack-retry",
                approvalId: approvalID,
                gatewayStableID: prompt.gatewayStableID,
                decision: .allowOnce,
                sentAtMs: nil,
                transport: "test"))
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !fetchGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }
        #expect(await fetchGate.hasStarted())

        // Re-presenting during the gated readback keeps the card fenced as resolving.
        appModel._test_presentExecApprovalPrompt(prompt)
        #expect(appModel._test_pendingExecApprovalState().resolving)

        await fetchGate.resume()
        let completed = await watchResolve.value
        #expect(completed)

        // Pending readback settled the watch attempt: the phone card must unlock with
        // the same retry message the phone path stamps.
        #expect(!appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalState().error ==
            "The previous decision was not recorded. Review and try again.")

        // The released lease admits a fresh resolve that reaches the transport again.
        await appModel.resolvePendingExecApprovalPrompt(decision: "deny")
        #expect(await fetchGate.callCount() == 2)
    }

    @Test @MainActor func `gateway switch during uncertain watch resolve records owner uncertainty`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = makeNodeModelWithMockServices()
        defer { appModel.disconnectGateway() }
        let (gatewayA, gatewayB) = try makeGatewayPair(
            firstURL: #require(URL(string: "wss://127.0.0.1:1")),
            secondURL: #require(URL(string: "wss://127.0.0.1:2")))
        let approvalID = "approval-watch-switch-mid-uncertain"
        let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
            id: approvalID,
            gatewayStableID: gatewayA.effectiveStableID,
            commandText: "echo watch switch",
            host: "gateway-a",
            expiresAtMs: 4_000_000_000_000))

        appModel.applyGatewayConnectConfig(gatewayA)
        appModel._test_presentExecApprovalPrompt(prompt)
        let writeGate = ExecApprovalResolutionGate()
        appModel._test_setExecApprovalResolutionUncertainHandler { _, _, _ in
            await writeGate.waitForFirstCall()
        }

        let watchResolve = Task { @MainActor in
            await appModel.handleWatchExecApprovalResolve(WatchExecApprovalResolveEvent(
                replyId: "watch-switch-mid-uncertain",
                approvalId: approvalID,
                gatewayStableID: gatewayA.effectiveStableID,
                decision: .allowOnce,
                sentAtMs: nil,
                transport: "test"))
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !writeGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }
        #expect(await writeGate.hasStarted())
        appModel.applyGatewayConnectConfig(gatewayB)
        await writeGate.resume()
        let completed = await watchResolve.value

        // The Watch decision was written with an unknown outcome: consume it, keep the
        // owner-scoped uncertainty + readback record instead of dropping every trace.
        #expect(completed)
        #expect(appModel._test_pendingPersistedExecApprovalReadbacks().contains { readback in
            readback.approvalId == approvalID && readback.gatewayStableID == gatewayA.effectiveStableID
        })

        appModel.applyGatewayConnectConfig(gatewayA)
        appModel._test_presentExecApprovalPrompt(prompt)
        #expect(appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalState().error == "simulated approval write failure")
    }

    @Test @MainActor func `canonically equivalent gateway owners stay distinct across switch and resolve`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let composedGatewayID = "gateway-\u{00E9}"
        let decomposedGatewayID = "gateway-e\u{0301}"
        #expect(composedGatewayID == decomposedGatewayID)
        #expect(GatewayStableIdentifier.key(composedGatewayID) !=
            GatewayStableIdentifier.key(decomposedGatewayID))
        let switchModel = makeNodeModelWithMockServices()
        defer { switchModel.disconnectGateway() }
        let (composedGateway, decomposedGateway) = try makeGatewayPair(
            firstURL: #require(URL(string: "wss://127.0.0.1:1")),
            firstStableID: composedGatewayID,
            secondURL: #require(URL(string: "wss://127.0.0.1:2")),
            secondStableID: decomposedGatewayID)

        switchModel.applyGatewayConnectConfig(composedGateway)
        try switchModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-exact-gateway-switch",
                gatewayStableID: composedGatewayID,
                commandText: "echo composed",
                expiresAtMs: 4_000_000_000_000)))
        switchModel.applyGatewayConnectConfig(decomposedGateway)
        #expect(switchModel.pendingExecApprovalPrompt == nil)
        #expect(switchModel._test_watchExecApprovalCacheIDs().isEmpty)

        let watchService = MockWatchMessagingService()
        let resolveModel = NodeAppModel(
            notificationCenter: MockBootstrapNotificationCenter(),
            watchMessagingService: watchService)
        resolveModel.connectedGatewayID = composedGatewayID
        try resolveModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-exact-gateway-resolve",
                gatewayStableID: composedGatewayID,
                commandText: "echo resolve",
                allowedDecisions: ["deny"],
                expiresAtMs: 4_000_000_000_000)))
        resolveModel.connectedGatewayID = decomposedGatewayID

        let applied = await resolveModel._test_applyLegacyExecApprovalTerminal(
            approvalID: "approval-exact-gateway-resolve",
            decision: .deny,
            expectedGatewayStableID: composedGatewayID)
        #expect(!applied)
        #expect(resolveModel.pendingExecApprovalPrompt?.id == "approval-exact-gateway-resolve")
        #expect(watchService.lastSentExecApprovalResolved == nil)
    }

    @Test @MainActor func `offline resolution push remains durable until its gateway reconnects`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let push = ExecApprovalNotificationPrompt(
            approvalId: "approval-resolved-offline",
            gatewayDeviceId: "gateway-device-a")
        let notificationCenter = MockBootstrapNotificationCenter()
        notificationCenter.delivered = [NotificationSnapshot(
            identifier: "offline-request-alert",
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": push.approvalId,
                    "gatewayDeviceId": "gateway-device-a",
                ],
            ])]
        let firstModel = NodeAppModel(notificationCenter: notificationCenter)

        #expect(await firstModel.handleExecApprovalResolvedRemotePush(push))
        #expect(firstModel.pendingExecApprovalResolvedPushes == [push])
        #expect(notificationCenter.pendingRemovedIdentifiers == [[
            "exec.approval-v2.16:gateway-device-a.approval-resolved-offline",
            "exec.approval.gateway-device-a.approval-resolved-offline",
        ]])
        #expect(notificationCenter.deliveredRemovedIdentifiers == [["offline-request-alert"]])

        let restoredModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        #expect(restoredModel.pendingExecApprovalResolvedPushes == [push])
    }

    @Test @MainActor func `offline approval request remains durable until its gateway reconnects`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let push = ExecApprovalNotificationPrompt(
            approvalId: "approval-requested-offline",
            gatewayDeviceId: "gateway-device-a")
        let firstModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())

        #expect(await firstModel.handleExecApprovalRequestedRemotePush(push))
        #expect(firstModel._test_pendingWatchExecApprovalRecoveryIDs() == [push.approvalId])

        let restoredModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        #expect(restoredModel._test_pendingWatchExecApprovalRecoveryIDs() == [push.approvalId])
    }

    @Test @MainActor func `offline approval notification tap retains watch recovery`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let push = ExecApprovalNotificationPrompt(
            approvalId: "approval-notification-offline",
            gatewayDeviceId: "gateway-device-a")
        let appModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())

        await appModel.presentExecApprovalNotificationPrompt(push)

        #expect(appModel._test_pendingWatchExecApprovalRecoveryIDs() == [push.approvalId])
    }

    @Test @MainActor func `failed PTT start restores voice wake suspension`() async {
        let (talkMode, appModel) = makeTalkModel()
        appModel.voiceWake.isEnabled = true
        appModel.voiceWake.isListening = true
        appModel.voiceWake.statusText = "Listening"

        let request = BridgeInvokeRequest(
            id: "ptt-start",
            command: OpenClawTalkCommand.pttStart.rawValue)
        let response = await appModel.handleInvoke(request)

        #expect(response.ok == false)
        #expect(response.error?.message.contains("Gateway not connected") == true)
        #expect(!appModel.voiceWake._test_isSuppressedByPushToTalk())
        appModel.voiceWake.stop()
    }

    @Test @MainActor func `PTT start preserves an active voice note`() async {
        let capture = MockVoiceNoteAudioCapture()
        let recorder = OpenClawVoiceNoteRecorder(capture: capture)
        #expect(await recorder.start())
        let appModel = NodeAppModel(
            talkMode: TalkModeManager(allowSimulatorCapture: true),
            voiceNoteRecorder: recorder)

        let request = BridgeInvokeRequest(
            id: "ptt-start-with-voice-note",
            command: OpenClawTalkCommand.pttStart.rawValue)
        let response = await appModel.handleInvoke(request)

        #expect(response.ok == false)
        #expect(response.error?.message.contains("active voice note") == true)
        #expect(recorder.isRecording)
        #expect(capture.cancelCallCount == 0)
        recorder.cancel()
    }

    @Test @MainActor func `cancelled queued PTT start never acquires preparation`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        appModel.testTalkCapturePreparationHandler = { await barrier.suspendFirstPreparation() }
        defer {
            appModel.testTalkCapturePreparationHandler = nil
            appModel.voiceWake.stop()
        }

        let active = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "ptt-active", command: .pttStart))
        }
        await barrier.waitUntilEntered()
        let queued = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "ptt-queued", command: .pttStart))
        }
        await waitForTalkCondition { appModel.talkPreparationWaiters.count == 1 }

        queued.cancel()
        await waitForTalkCondition { appModel.talkPreparationWaiters.count == 0 }
        barrier.release()

        let activeResponse = await active.value
        let queuedResponse = await queued.value
        let activePayload = try decodeTalkPayload(OpenClawTalkPTTStartPayload.self, from: activeResponse)
        #expect(activeResponse.ok)
        #expect(!queuedResponse.ok)
        #expect(talkMode._test_activePushToTalkCaptureId() == activePayload.captureId)

        #expect(await appModel.handleInvoke(talkRequest(id: "cleanup", command: .pttCancel)).ok)
    }

    @Test @MainActor func `PTT cancel invalidates suspended preparation without waiting`() async {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        appModel.testTalkCapturePreparationHandler = { await barrier.suspendFirstPreparation() }
        defer {
            appModel.testTalkCapturePreparationHandler = nil
            appModel.voiceWake.stop()
        }

        let start = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "stale-start", command: .pttStart))
        }
        await barrier.waitUntilEntered()
        let epoch = appModel.talkPttCommandEpoch

        let cancel = await appModel.handleInvoke(talkRequest(id: "cancel", command: .pttCancel))
        #expect(cancel.ok)
        #expect(appModel.talkPttCommandEpoch == epoch + 1)
        barrier.release()

        #expect(await start.value.ok == false)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `PTT start after cancel uses the new command epoch`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        appModel.testTalkCapturePreparationHandler = { await barrier.suspendFirstPreparation() }
        defer {
            appModel.testTalkCapturePreparationHandler = nil
            appModel.voiceWake.stop()
        }

        let stale = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "old-epoch", command: .pttStart))
        }
        await barrier.waitUntilEntered()
        #expect(await appModel.handleInvoke(talkRequest(id: "cancel", command: .pttCancel)).ok)
        let fresh = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "new-epoch", command: .pttStart))
        }
        await waitForTalkCondition { appModel.talkPreparationWaiters.count == 1 }
        barrier.release()

        #expect(await stale.value.ok == false)
        let freshResponse = await fresh.value
        let freshPayload = try decodeTalkPayload(OpenClawTalkPTTStartPayload.self, from: freshResponse)
        #expect(freshResponse.ok)
        #expect(talkMode._test_activePushToTalkCaptureId() == freshPayload.captureId)

        #expect(await appModel.handleInvoke(talkRequest(id: "cleanup", command: .pttCancel)).ok)
    }

    @Test @MainActor func `chat focus switch invalidates reserved and queued PTT starts`() async {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        talkMode._test_setPTTReservedHandler { await barrier.suspendFirstPreparation() }
        defer {
            barrier.release()
            talkMode._test_setPTTReservedHandler(nil)
            appModel.voiceWake.stop()
        }

        let reserved = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "focus-reserved", command: .pttStart))
        }
        await barrier.waitUntilEntered()
        let queued = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "focus-queued", command: .pttStart))
        }
        await waitForTalkCondition { appModel.talkPreparationWaiters.count == 1 }
        let epoch = appModel.talkPttCommandEpoch

        appModel.focusChatSession("agent:main:focused-replacement")

        #expect(appModel.talkPttCommandEpoch == epoch + 1)
        #expect(talkMode.isUsingMainSessionKey("agent:main:focused-replacement"))
        barrier.release()
        #expect(await reserved.value.ok == false)
        #expect(await queued.value.ok == false)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `same-session route replacement invalidates reserved and queued PTT starts`() async {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        talkMode._test_setPTTReservedHandler { await barrier.suspendFirstPreparation() }
        defer {
            barrier.release()
            talkMode._test_setPTTReservedHandler(nil)
            appModel.voiceWake.stop()
        }

        let reserved = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "route-reserved", command: .pttStart))
        }
        await barrier.waitUntilEntered()
        let queued = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "route-queued", command: .pttStart))
        }
        await waitForTalkCondition { appModel.talkPreparationWaiters.count == 1 }
        let epoch = appModel.talkPttCommandEpoch

        appModel.invalidateOperatorTalkRoute()
        talkMode.updateGatewayConnected(true)

        #expect(appModel.talkPttCommandEpoch == epoch + 1)
        barrier.release()
        #expect(await reserved.value.ok == false)
        #expect(await queued.value.ok == false)
        #expect(appModel.talkPreparationWaiters.count == 0)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `same-route reconnect preserves routing restore before Talk admission`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        let stableID = "talk-routing-restore-\(UUID().uuidString)"
        let databaseDirectoryURL = try #require(NodeAppModel.chatDatabaseDirectoryURL())
        let databases = try OpenClawClientDatabases(directoryURL: databaseDirectoryURL)
        let identity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "per-sender",
            mainSessionKey: "restored-main",
            defaultAgentID: "main",
            selectionRequired: true,
            sessionRoutingContract: "per-sender|restored-main|unowned"))
        let store = databases.store(gatewayID: stableID)
        await store.storeSessionRoutingIdentity(identity)
        await store.retire()
        appModel.testChatSessionRoutingRestoreHandler = {
            await barrier.suspendFirstPreparation()
        }
        defer {
            barrier.release()
            appModel.testChatSessionRoutingRestoreHandler = nil
            try? databases.removeGatewayData(gatewayID: stableID)
            appModel.voiceWake.stop()
        }

        appModel.prepareForGatewayConnect(stableID: stableID)
        await barrier.waitUntilEntered()
        appModel.invalidateOperatorTalkRoute()

        #expect(appModel.chatSessionRoutingRestoreTask != nil)
        #expect(!talkMode.isGatewayConnected)
        #expect(appModel.chatSessionRoutingContract == nil)

        barrier.release()
        await appModel._test_admitTalkAfterSessionHydration()

        #expect(talkMode.isGatewayConnected)
        #expect(appModel.chatSessionRoutingContract == identity.contract)
        #expect(appModel.chatDeliveryAgentId == nil)
        #expect(talkMode.isUsingMainSessionKey(appModel.chatSessionKey))
    }

    @Test @MainActor func `cancelled routing restore cannot apply after SQLite load`() async throws {
        let appModel = NodeAppModel()
        let barrier = TalkPreparationBarrier()
        let stableID = "cancelled-routing-restore-\(UUID().uuidString)"
        let databaseDirectoryURL = try #require(NodeAppModel.chatDatabaseDirectoryURL())
        let databases = try OpenClawClientDatabases(directoryURL: databaseDirectoryURL)
        let identity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "per-sender",
            mainSessionKey: "stale-main",
            defaultAgentID: "main"))
        let store = databases.store(gatewayID: stableID)
        await store.storeSessionRoutingIdentity(identity)
        await store.retire()
        appModel.connectedGatewayID = stableID
        appModel.testChatSessionRoutingRestoreHandler = {
            await barrier.suspendFirstPreparation()
        }
        defer {
            barrier.release()
            appModel.testChatSessionRoutingRestoreHandler = nil
            try? databases.removeGatewayData(gatewayID: stableID)
            appModel.voiceWake.stop()
        }

        let restore = Task { @MainActor in
            await appModel.restoreChatSessionRoutingIdentityIfNeeded()
        }
        await barrier.waitUntilEntered()
        restore.cancel()
        barrier.release()
        await restore.value

        #expect(appModel.chatSessionRoutingContract == nil)
        await appModel.purgeChatTranscriptCache(gatewayID: stableID)
    }

    @Test @MainActor func `offline stores keep byte-distinct gateway owners isolated`() async throws {
        let appModel = NodeAppModel()
        let suffix = UUID().uuidString
        let composedGatewayID = "offline-gateway-\u{00E9}-\(suffix)"
        let decomposedGatewayID = "offline-gateway-e\u{0301}-\(suffix)"
        #expect(composedGatewayID.precomposedStringWithCanonicalMapping ==
            decomposedGatewayID.precomposedStringWithCanonicalMapping)
        #expect(GatewayStableIdentifier.key(composedGatewayID) !=
            GatewayStableIdentifier.key(decomposedGatewayID))
        defer {
            appModel.cancelChatOfflineDataRemoval(gatewayID: composedGatewayID)
        }

        appModel.connectedGatewayID = composedGatewayID
        let composedStore = try #require(appModel.makeChatOfflineStore())
        let composedOwnerID = appModel.chatViewModelOwnerID
        #expect(await appModel.stageChatOfflineDataRemoval(gatewayID: composedGatewayID))

        appModel.connectedGatewayID = decomposedGatewayID
        let decomposedStore = try #require(appModel.makeChatOfflineStore())

        #expect(ObjectIdentifier(composedStore) != ObjectIdentifier(decomposedStore))
        #expect(Array(composedStore.gatewayID.utf8) == Array(composedGatewayID.utf8))
        #expect(Array(decomposedStore.gatewayID.utf8) == Array(decomposedGatewayID.utf8))
        #expect(appModel.chatViewModelOwnerID != composedOwnerID)

        appModel.cancelChatOfflineDataRemoval(gatewayID: composedGatewayID)
        _ = await appModel.purgeChatTranscriptCache(gatewayID: composedGatewayID)
        _ = await appModel.purgeChatTranscriptCache(gatewayID: decomposedGatewayID)
    }

    @Test @MainActor func `failed full offline reset never reuses retired facade`() async throws {
        let appModel = NodeAppModel()
        let gatewayID = "offline-reset-failure-\(UUID().uuidString)"
        appModel.connectedGatewayID = gatewayID
        let originalStore = try #require(appModel.makeChatOfflineStore())
        appModel.testRemoveAllChatDatabaseFilesHandler = {
            throw CocoaError(.fileWriteUnknown)
        }
        defer {
            appModel.testRemoveAllChatDatabaseFilesHandler = nil
        }

        let didPurge = await appModel.purgeChatTranscriptCache()
        #expect(!didPurge)
        let replacementStore = try #require(appModel.makeChatOfflineStore())

        #expect(ObjectIdentifier(originalStore) != ObjectIdentifier(replacementStore))
        appModel.testRemoveAllChatDatabaseFilesHandler = nil
        _ = await appModel.purgeChatTranscriptCache(gatewayID: gatewayID)
    }

    @Test @MainActor func `gateway main key refresh preserves focused Talk session`() {
        let (talkMode, appModel) = makeTalkModel()
        appModel.focusChatSession("agent:focused:thread")
        let epoch = appModel.talkPttCommandEpoch

        appModel.applyMainSessionKey("gateway-main")

        #expect(appModel.chatSessionKey == "agent:focused:thread")
        #expect(talkMode.isUsingMainSessionKey("agent:focused:thread"))
        #expect(appModel.talkPttCommandEpoch == epoch)
    }

    @Test @MainActor func `gateway replacement waits for final Talk session before admission`() async {
        let (talkMode, appModel) = makeTalkModel()
        appModel.focusChatSession("agent:old:thread")
        let epoch = appModel.talkPttCommandEpoch
        let stableID = "talk-session-replacement-\(UUID().uuidString)"
        defer { GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: stableID, agentId: nil) }

        appModel.prepareForGatewayConnect(stableID: stableID)

        #expect(appModel.chatSessionKey != "agent:old:thread")
        #expect(talkMode.isUsingMainSessionKey(appModel.chatSessionKey))
        #expect(appModel.talkPttCommandEpoch > epoch)
        #expect(!talkMode.isGatewayConnected)
        let blocked = await appModel.handleInvoke(
            talkRequest(id: "pre-hydration", command: .pttStart))
        #expect(!blocked.ok)

        appModel.applyMainSessionKey("custom-main")
        appModel.gatewayDefaultAgentId = "main"
        appModel.setSelectedAgentId("worker")
        await appModel._test_admitTalkAfterSessionHydration()

        #expect(talkMode.isGatewayConnected)
        #expect(appModel.chatSessionKey == "agent:worker:custom-main")
        #expect(talkMode.isUsingMainSessionKey(appModel.chatSessionKey))
        let admitted = await appModel.handleInvoke(
            talkRequest(id: "post-hydration", command: .pttStart))
        #expect(admitted.ok)
        _ = await appModel.handleInvoke(
            talkRequest(id: "post-hydration-cleanup", command: .pttCancel))
    }

    @Test @MainActor func `cancelled PTT start after capture activation cleans up the capture`() async {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        appModel.testTalkCaptureStartedHandler = { await barrier.suspendFirstPreparation() }
        defer {
            appModel.testTalkCaptureStartedHandler = nil
            appModel.voiceWake.stop()
        }

        let start = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "cancel-after-start", command: .pttStart))
        }
        await barrier.waitUntilEntered()
        #expect(talkMode._test_activePushToTalkCaptureId() != nil)

        start.cancel()
        barrier.release()

        #expect(await start.value.ok == false)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `session switch cannot return a cancelled PTT capture id`() async {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        appModel.testTalkCaptureStartedHandler = { await barrier.suspendFirstPreparation() }
        defer {
            barrier.release()
            appModel.testTalkCaptureStartedHandler = nil
            appModel.voiceWake.stop()
        }

        let start = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "session-switch-after-start", command: .pttStart))
        }
        await barrier.waitUntilEntered()
        #expect(talkMode._test_activePushToTalkCaptureId() != nil)

        talkMode.updateMainSessionKey("agent:main:replacement-after-start")
        barrier.release()

        #expect(await start.value.ok == false)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `session switch cannot strand a one shot PTT waiter`() async {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        talkMode._test_setPTTOnceStartedHandler { await barrier.suspendFirstPreparation() }
        defer {
            barrier.release()
            talkMode._test_setPTTOnceStartedHandler(nil)
            appModel.voiceWake.stop()
        }

        let once = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "session-switch-once", command: .pttOnce))
        }
        await barrier.waitUntilEntered()
        #expect(talkMode._test_activePushToTalkCaptureId() != nil)

        talkMode.updateMainSessionKey("agent:main:replacement-once")
        barrier.release()

        #expect(await once.value.ok == false)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `node route invalidation cancels active and preparing PTT`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        defer {
            barrier.release()
            appModel.testTalkCapturePreparationHandler = nil
            appModel.voiceWake.stop()
        }

        let activeResponse = await appModel.handleInvoke(
            talkRequest(id: "node-route-active", command: .pttStart))
        let active = try decodeTalkPayload(OpenClawTalkPTTStartPayload.self, from: activeResponse)
        #expect(talkMode._test_activePushToTalkCaptureId() == active.captureId)

        appModel.invalidateNodePushToTalkRoute()

        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)

        appModel.testTalkCapturePreparationHandler = { await barrier.suspendFirstPreparation() }
        let preparing = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "node-route-preparing", command: .pttStart))
        }
        await barrier.waitUntilEntered()

        appModel.invalidateNodePushToTalkRoute()
        barrier.release()

        #expect(await preparing.value.ok == false)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `cancelled stale interrupt cannot stop a newer PTT capture`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        defer {
            barrier.release()
            _ = talkMode.cancelPushToTalk()
        }
        let startResponse = await appModel.handleInvoke(
            talkRequest(id: "fresh-before-stale-cancel", command: .pttStart))
        let active = try decodeTalkPayload(OpenClawTalkPTTStartPayload.self, from: startResponse)
        let staleCancel = Task { @MainActor in
            await barrier.suspendFirstPreparation()
            return await appModel.handleInvoke(
                talkRequest(id: "stale-route-cancel", command: .pttCancel))
        }
        await barrier.waitUntilEntered()

        staleCancel.cancel()
        barrier.release()

        #expect(await staleCancel.value.ok == false)
        #expect(talkMode._test_activePushToTalkCaptureId() == active.captureId)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds() == [active.captureId])
    }

    @Test @MainActor func `PTT stop during reserved preparation restores idle capture state`() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        talkMode._test_setPTTReservedHandler { await barrier.suspendFirstPreparation() }
        defer {
            barrier.release()
            talkMode._test_setPTTReservedHandler(nil)
        }

        let start = Task { @MainActor in
            try await talkMode.beginPushToTalk()
        }
        await barrier.waitUntilEntered()
        let captureId = try #require(talkMode._test_activePushToTalkCaptureId())

        let stopped = talkMode.endPushToTalk(captureId: captureId)
        #expect(stopped.status == "idle")
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(talkMode._test_pushToTalkCaptureIsIdle())

        barrier.release()
        var startFailed = false
        do {
            _ = try await start.value
        } catch {
            startFailed = true
        }
        #expect(startFailed)
    }

    @Test @MainActor func `session switch cancels reserved and active PTT`() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        talkMode._test_setPTTReservedHandler { await barrier.suspendFirstPreparation() }
        defer {
            barrier.release()
            talkMode._test_setPTTReservedHandler(nil)
            talkMode.stop()
        }

        let preparing = Task { @MainActor in try await talkMode.beginPushToTalk() }
        await barrier.waitUntilEntered()
        talkMode.updateMainSessionKey("agent:main:reserved-replacement")
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        barrier.release()
        await #expect(throws: Error.self) {
            _ = try await preparing.value
        }

        talkMode._test_setPTTReservedHandler(nil)
        let active = try await talkMode.beginPushToTalk()
        talkMode.updateMainSessionKey("agent:main:active-replacement")
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(!talkMode.isPushToTalkActive)
        #expect(talkMode.cancelPushToTalk(captureId: active.captureId).status == "idle")
    }

    @Test @MainActor func `PTT stop and cancel interrupt active one-shot capture`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        talkMode.updateGatewayConnected(true)
        defer { appModel.voiceWake.stop() }

        let cancelledOnce = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "once-cancel", command: .pttOnce))
        }
        await waitForTalkCondition { talkMode._test_activePushToTalkCaptureId() != nil }
        let cancelledCaptureId = try #require(talkMode._test_activePushToTalkCaptureId())
        let cancelResponse = await appModel.handleInvoke(talkRequest(id: "cancel", command: .pttCancel))
        let cancelPayload = try decodeTalkPayload(OpenClawTalkPTTStopPayload.self, from: cancelResponse)
        let cancelledOncePayload = try await decodeTalkPayload(
            OpenClawTalkPTTStopPayload.self,
            from: cancelledOnce.value)
        #expect(cancelPayload.captureId == cancelledCaptureId)
        #expect(cancelPayload.status == "cancelled")
        #expect(cancelledOncePayload == cancelPayload)

        let stoppedOnce = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "once-stop", command: .pttOnce))
        }
        await waitForTalkCondition { talkMode._test_activePushToTalkCaptureId() != nil }
        let stoppedCaptureId = try #require(talkMode._test_activePushToTalkCaptureId())
        let stopResponse = await appModel.handleInvoke(talkRequest(id: "stop", command: .pttStop))
        let stopPayload = try decodeTalkPayload(OpenClawTalkPTTStopPayload.self, from: stopResponse)
        let stoppedOncePayload = try await decodeTalkPayload(OpenClawTalkPTTStopPayload.self, from: stoppedOnce.value)
        #expect(stopPayload.captureId == stoppedCaptureId)
        #expect(stopPayload.status == "empty")
        #expect(stoppedOncePayload == stopPayload)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `stale PTT cleanup cannot stop a newer capture`() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        talkMode.updateGatewayConnected(true)

        let first = try await talkMode.beginPushToTalk()
        #expect(talkMode.cancelPushToTalk(captureId: first.captureId).status == "cancelled")
        let second = try await talkMode.beginPushToTalk()

        let stale = talkMode.cancelPushToTalk(captureId: first.captureId)
        #expect(stale.status == "idle")
        #expect(talkMode._test_activePushToTalkCaptureId() == second.captureId)
        #expect(talkMode.isPushToTalkActive)

        #expect(talkMode.cancelPushToTalk(captureId: second.captureId).status == "cancelled")
    }

    @Test @MainActor func `transcribed PTT releases audio once before replacement capture`() async throws {
        var ownershipEvents: [String] = []
        let talkMode = TalkModeManager(
            allowSimulatorCapture: true,
            audioSessionDeactivationAction: { ownershipEvents.append("deactivate") })
        talkMode.setPushToTalkAudioOwnershipEndHandler {
            ownershipEvents.append("release:\($0)")
        }
        defer {
            talkMode.setPushToTalkAudioOwnershipEndHandler(nil)
            talkMode.stop()
        }

        let first = try await talkMode.beginPushToTalk(transcriptionOnly: true)
        await talkMode._test_handlePushToTalkTranscript(
            "transcription survives release",
            isFinal: false,
            captureId: first.captureId)

        let finished = talkMode.endPushToTalk(captureId: first.captureId)

        #expect(finished.status == "transcribed")
        #expect(finished.transcript == "transcription survives release")
        #expect(ownershipEvents == ["deactivate", "release:\(first.captureId)"])
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(talkMode._test_pushToTalkCaptureIsIdle())

        let replacement = try await talkMode.beginPushToTalk(transcriptionOnly: true)
        #expect(replacement.captureId != first.captureId)
        #expect(talkMode.cancelPushToTalk(captureId: replacement.captureId).status == "cancelled")
        #expect(ownershipEvents == [
            "deactivate",
            "release:\(first.captureId)",
            "deactivate",
            "release:\(replacement.captureId)",
        ])
    }

    @Test @MainActor func `standalone PTT deactivates audio before releasing ownership`() async throws {
        var events: [String] = []
        let talkMode = TalkModeManager(
            allowSimulatorCapture: true,
            audioSessionDeactivationAction: { events.append("deactivate") })
        talkMode.setPushToTalkAudioOwnershipEndHandler { _ in events.append("release") }
        talkMode.updateGatewayConnected(true)

        let capture = try await talkMode.beginPushToTalk()
        #expect(talkMode.cancelPushToTalk(captureId: capture.captureId).status == "cancelled")

        #expect(events == ["deactivate", "release"])
    }

    @Test @MainActor func `failed audio deactivation remains retryable`() async throws {
        var deactivationAttempts = 0
        let talkMode = TalkModeManager(
            allowSimulatorCapture: true,
            audioSessionDeactivationAction: {
                deactivationAttempts += 1
                if deactivationAttempts == 1 {
                    throw NSError(domain: "TalkModeTests", code: 1)
                }
            })
        talkMode.updateGatewayConnected(true)

        let capture = try await talkMode.beginPushToTalk()
        _ = talkMode.cancelPushToTalk(captureId: capture.captureId)
        #expect(deactivationAttempts == 1)

        talkMode.stop()
        #expect(deactivationAttempts == 2)
    }

    @Test @MainActor func `blocked continuous resume releases the PTT audio session`() async throws {
        var deactivationCount = 0
        let talkMode = TalkModeManager(
            allowSimulatorCapture: true,
            audioSessionDeactivationAction: { deactivationCount += 1 })
        talkMode.updateGatewayConnected(true)
        talkMode.gatewayTalkConfigLoaded = true
        talkMode.gatewayTalkPermissionState = .missingScope("operator.talk.secrets")
        defer { talkMode.stop() }

        let capture = try await talkMode.beginPushToTalk()
        talkMode.setEnabled(true)
        #expect(talkMode.cancelPushToTalk(captureId: capture.captureId).status == "cancelled")
        await waitForTalkCondition { talkMode.statusText == "Gateway permission required" }

        #expect(deactivationCount == 1)
        #expect(!talkMode._test_audioSessionIsActive())
        #expect(!talkMode.isListening)
    }

    @Test @MainActor func `enabling unified voice requests a missing Talk scope upgrade`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let config = try GatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: "manual|gateway.example.com|443",
            tls: nil,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "node",
                clientDisplayName: nil))
        appModel.activeGatewayConnectConfig = config
        talkMode.gatewayTalkPermissionState = .missingScope("operator.talk.secrets")
        defer {
            appModel.setTalkEnabled(false)
            appModel.disconnectGateway()
        }

        appModel.setTalkEnabled(true)
        await waitForTalkCondition { talkMode.gatewayTalkPermissionState == .requestingUpgrade }

        #expect(appModel._test_forceTalkPermissionUpgradeRequest())
        appModel.gatewayAutoReconnectEnabled = false
        appModel.gatewayPairingPaused = true
        appModel.setTalkEnabled(false)
        #expect(!appModel._test_forceTalkPermissionUpgradeRequest())
        #expect(appModel.gatewayAutoReconnectEnabled)
        #expect(!appModel.gatewayPairingPaused)

        appModel.gatewayAutoReconnectEnabled = false
        appModel.gatewayPairingPaused = true
        appModel.setTalkEnabled(false)
        #expect(!appModel.gatewayAutoReconnectEnabled)
        #expect(appModel.gatewayPairingPaused)
    }

    @Test @MainActor func `stale PTT recognition callback cannot mutate a newer capture`() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        talkMode.updateGatewayConnected(true)

        let first = try await talkMode.beginPushToTalkOnce(maxDurationSeconds: 0)
        let firstCaptureId = try #require(talkMode._test_activePushToTalkCaptureId())
        _ = talkMode.cancelPushToTalk(captureId: firstCaptureId)
        _ = await talkMode.awaitPushToTalkOnce(first)

        let second = try await talkMode.beginPushToTalkOnce(maxDurationSeconds: 0)
        let secondCaptureId = try #require(talkMode._test_activePushToTalkCaptureId())
        await talkMode._test_handlePushToTalkTranscript(
            "stale transcript",
            isFinal: true,
            captureId: firstCaptureId)

        #expect(talkMode._test_activePushToTalkCaptureId() == secondCaptureId)
        #expect(talkMode.isPushToTalkActive)

        _ = talkMode.cancelPushToTalk(captureId: secondCaptureId)
        _ = await talkMode.awaitPushToTalkOnce(second)
    }

    @Test @MainActor func `chat dictation returns transcript and releases audio ownership`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let transcription = Task { @MainActor in
            try await appModel.transcribeChatDraft()
        }
        await waitForTalkCondition { appModel.isChatDictationActive }
        let captureId = try #require(talkMode._test_activePushToTalkCaptureId())
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds() == [captureId])
        await talkMode._test_handlePushToTalkTranscript(
            "draft from speech",
            isFinal: false,
            captureId: captureId)

        appModel.finishChatDictation()
        let transcript = try await transcription.value
        #expect(transcript == "draft from speech")
        #expect(!appModel.isChatDictationActive)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `cancelling chat dictation clears capture and voice wake lease`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let transcription = Task { @MainActor in
            try await appModel.transcribeChatDraft()
        }
        await waitForTalkCondition { appModel.isChatDictationActive }
        let captureId = try #require(talkMode._test_activePushToTalkCaptureId())
        await talkMode._test_handlePushToTalkTranscript(
            "discard this partial draft",
            isFinal: false,
            captureId: captureId)

        appModel.cancelChatDictation()

        let transcript = try await transcription.value
        #expect(transcript == nil)
        #expect(!appModel.isChatDictationActive)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `remote PTT cannot adopt or interrupt chat dictation`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        talkMode.updateGatewayConnected(true)
        let transcription = Task { @MainActor in
            try await appModel.transcribeChatDraft()
        }
        await waitForTalkCondition { appModel.isChatDictationActive }
        let captureId = try #require(talkMode._test_activePushToTalkCaptureId())

        let remoteStart = await appModel.handleInvoke(
            talkRequest(id: "remote-start-during-dictation", command: .pttStart))
        #expect(!remoteStart.ok)
        #expect(remoteStart.error?.message.contains("PTT_BUSY") == true)

        for command in [OpenClawTalkCommand.pttStop, .pttCancel] {
            let response = await appModel.handleInvoke(
                talkRequest(id: "remote-\(command.rawValue)-during-dictation", command: command))
            let payload = try decodeTalkPayload(OpenClawTalkPTTStopPayload.self, from: response)
            #expect(payload.status == "idle")
            #expect(payload.captureId != captureId)
            #expect(talkMode._test_activePushToTalkCaptureId() == captureId)
            #expect(appModel.isChatDictationActive)
            #expect(appModel._test_pttVoiceWakeLeaseCaptureIds() == [captureId])
        }

        await talkMode._test_handlePushToTalkTranscript(
            "draft remains local",
            isFinal: false,
            captureId: captureId)
        appModel.finishChatDictation()

        #expect(try await transcription.value == "draft remains local")
        #expect(!appModel.isChatDictationActive)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `chat dictation refuses a capture it did not reserve`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let existing = try await talkMode.beginPushToTalkOnce(
            maxDurationSeconds: 30,
            transcriptionOnly: true)
        let captureId = try #require(talkMode._test_activePushToTalkCaptureId())

        let transcript = try await appModel.transcribeChatDraft()

        #expect(transcript == nil)
        #expect(!appModel.isChatDictationActive)
        #expect(talkMode._test_activePushToTalkCaptureId() == captureId)
        _ = talkMode.cancelPushToTalk(captureId: captureId)
        _ = await talkMode.awaitPushToTalkOnce(existing)
    }

    @Test @MainActor func `gateway disconnect preserves local chat dictation`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        talkMode.updateGatewayConnected(true)
        let transcription = Task { @MainActor in
            try await appModel.transcribeChatDraft()
        }
        await waitForTalkCondition { appModel.isChatDictationActive }
        let captureId = try #require(talkMode._test_activePushToTalkCaptureId())
        await talkMode._test_handlePushToTalkTranscript(
            "draft survives disconnect",
            isFinal: false,
            captureId: captureId)

        talkMode.updateGatewayConnected(false)

        #expect(talkMode._test_activePushToTalkCaptureId() == captureId)
        appModel.finishChatDictation()
        #expect(try await transcription.value == "draft survives disconnect")
        #expect(!appModel.isChatDictationActive)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `gateway replacement preserves local chat dictation`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let initialGateway = GatewayNodeSession()
        let replacementGateway = GatewayNodeSession()
        talkMode.attachGateway(initialGateway)
        let transcription = Task { @MainActor in
            try await appModel.transcribeChatDraft()
        }
        await waitForTalkCondition { appModel.isChatDictationActive }
        let captureId = try #require(talkMode._test_activePushToTalkCaptureId())
        await talkMode._test_handlePushToTalkTranscript(
            "draft survives replacement",
            isFinal: false,
            captureId: captureId)

        talkMode.attachGateway(replacementGateway)

        #expect(talkMode._test_activePushToTalkCaptureId() == captureId)
        appModel.finishChatDictation()
        #expect(try await transcription.value == "draft survives replacement")
        #expect(!appModel.isChatDictationActive)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `route and remote PTT invalidation preserve dictation preparation`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        appModel.testTalkCapturePreparationHandler = { await barrier.suspendFirstPreparation() }
        defer {
            barrier.release()
            appModel.testTalkCapturePreparationHandler = nil
            appModel.voiceWake.stop()
        }

        let transcription = Task { @MainActor in
            try await appModel.transcribeChatDraft()
        }
        await barrier.waitUntilEntered()

        #expect(await appModel.handleInvoke(talkRequest(id: "remote-cancel", command: .pttCancel)).ok)
        appModel.invalidateOperatorTalkRoute()
        barrier.release()

        await waitForTalkCondition { appModel.isChatDictationActive }
        let captureId = try #require(talkMode._test_activePushToTalkCaptureId())
        await talkMode._test_handlePushToTalkTranscript(
            "draft survives preparation invalidation",
            isFinal: false,
            captureId: captureId)
        appModel.finishChatDictation()

        #expect(try await transcription.value == "draft survives preparation invalidation")
        #expect(!appModel.isChatDictationActive)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `backgrounding invalidates dictation preparation`() async {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        appModel.testTalkCapturePreparationHandler = { await barrier.suspendFirstPreparation() }
        defer {
            barrier.release()
            appModel.testTalkCapturePreparationHandler = nil
            appModel.setScenePhase(.active)
            appModel.voiceWake.stop()
        }

        let transcription = Task { @MainActor in
            try await appModel.transcribeChatDraft()
        }
        await barrier.waitUntilEntered()

        appModel.setScenePhase(.background)
        barrier.release()

        await #expect(throws: Error.self) {
            try await transcription.value
        }
        #expect(!appModel.isChatDictationActive)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `cancelling invalidates dictation preparation before capture reservation`() async {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        appModel.testTalkCapturePreparationHandler = { await barrier.suspendFirstPreparation() }
        defer {
            barrier.release()
            appModel.testTalkCapturePreparationHandler = nil
            appModel.voiceWake.stop()
        }

        let transcription = Task { @MainActor in
            try await appModel.transcribeChatDraft()
        }
        await barrier.waitUntilEntered()
        #expect(appModel.isChatDictationPending)
        #expect(!appModel.isChatDictationActive)

        appModel.cancelChatDictation()
        #expect(appModel.isChatDictationPending)
        barrier.release()

        await #expect(throws: Error.self) {
            try await transcription.value
        }
        #expect(!appModel.isChatDictationPending)
        #expect(!appModel.isChatDictationActive)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `backgrounding cancels chat dictation and preserves audio admission`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        defer { appModel.setScenePhase(.active) }
        let transcription = Task { @MainActor in
            try await appModel.transcribeChatDraft()
        }
        await waitForTalkCondition { appModel.isChatDictationActive }

        appModel.setScenePhase(.background)

        let transcript = try await transcription.value
        #expect(transcript == nil)
        #expect(!appModel.isChatDictationActive)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `stale continuous recognition callback cannot stop newer PTT`() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        talkMode.updateGatewayConnected(true)
        let staleGeneration = talkMode._test_recognitionGeneration()

        let once = try await talkMode.beginPushToTalkOnce(maxDurationSeconds: 0)
        let captureId = try #require(talkMode._test_activePushToTalkCaptureId())
        await talkMode._test_handleTranscript(
            "stale continuous transcript",
            isFinal: true,
            pttCaptureId: nil,
            recognitionGeneration: staleGeneration)

        #expect(talkMode._test_activePushToTalkCaptureId() == captureId)
        #expect(talkMode.isPushToTalkActive)

        _ = talkMode.cancelPushToTalk(captureId: captureId)
        _ = await talkMode.awaitPushToTalkOnce(once)
    }

    @Test @MainActor func `finishing PTT turn blocks replacement until finalizer exits`() async throws {
        var ownershipEvents: [String] = []
        let talkMode = TalkModeManager(
            allowSimulatorCapture: true,
            audioSessionDeactivationAction: { ownershipEvents.append("deactivate") })
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        talkMode._test_setPTTFinalizerHandler { await barrier.suspendFirstPreparation() }
        talkMode.setPushToTalkAudioOwnershipEndHandler { _ in ownershipEvents.append("release") }
        defer {
            barrier.release()
            talkMode._test_setPTTFinalizerHandler(nil)
            talkMode.setPushToTalkAudioOwnershipEndHandler(nil)
        }

        let first = try await talkMode.beginPushToTalk()
        await talkMode._test_handlePushToTalkTranscript(
            "first turn",
            isFinal: false,
            captureId: first.captureId)
        let queued = talkMode.endPushToTalk(captureId: first.captureId)
        #expect(queued.status == "queued")
        await barrier.waitUntilEntered()
        #expect(talkMode._test_finishingPushToTalkCaptureId() == first.captureId)

        var busyError: Error?
        do {
            _ = try await talkMode.beginPushToTalk()
        } catch {
            busyError = error
        }
        #expect(busyError?.localizedDescription == "PTT_BUSY: previous push-to-talk turn is still finishing")

        let once = try await talkMode.beginPushToTalkOnce(maxDurationSeconds: 0)
        switch once {
        case let .busy(payload):
            #expect(payload.captureId == first.captureId)
            #expect(payload.status == "busy")
        case .started:
            Issue.record("one-shot PTT replaced a finishing turn")
        }

        barrier.release()
        await waitForTalkCondition { talkMode._test_finishingPushToTalkCaptureId() == nil }
        #expect(ownershipEvents == ["deactivate", "release"])

        let replacement = try await talkMode.beginPushToTalk()
        #expect(talkMode._test_activePushToTalkCaptureId() == replacement.captureId)
        _ = talkMode.cancelPushToTalk(captureId: replacement.captureId)
    }

    @Test @MainActor func `cancelled PTT finalizer keeps ownership until task exits`() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let barrier = TalkPreparationBarrier()
        var audioOwnershipEndCount = 0
        talkMode.updateGatewayConnected(true)
        talkMode._test_setPTTFinalizerHandler { await barrier.suspendFirstPreparation() }
        talkMode.setPushToTalkAudioOwnershipEndHandler { _ in audioOwnershipEndCount += 1 }
        defer {
            barrier.release()
            talkMode._test_setPTTFinalizerHandler(nil)
            talkMode.setPushToTalkAudioOwnershipEndHandler(nil)
        }

        let first = try await talkMode.beginPushToTalk()
        await talkMode._test_handlePushToTalkTranscript(
            "cancelled finalizer",
            isFinal: false,
            captureId: first.captureId)
        #expect(talkMode.endPushToTalk(captureId: first.captureId).status == "queued")
        await barrier.waitUntilEntered()
        #expect(audioOwnershipEndCount == 0)

        talkMode.stop()
        #expect(talkMode._test_finishingPushToTalkCaptureId() == first.captureId)
        #expect(audioOwnershipEndCount == 0)
        var busyError: Error?
        do {
            _ = try await talkMode.beginPushToTalk()
        } catch {
            busyError = error
        }
        #expect(busyError?.localizedDescription == "PTT_BUSY: previous push-to-talk turn is still finishing")

        barrier.release()
        await waitForTalkCondition { talkMode._test_finishingPushToTalkCaptureId() == nil }
        #expect(audioOwnershipEndCount == 1)
        #expect(talkMode.statusText == "Off")
        let replacement = try await talkMode.beginPushToTalk()
        _ = talkMode.cancelPushToTalk(captureId: replacement.captureId)
    }

    @Test @MainActor func `PTT finalizer cleanup ignores localized presentation text`() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        talkMode.updateGatewayConnected(true)
        talkMode._test_setPTTFinalizerHandler {
            talkMode.statusText = "Generando voz…"
        }
        defer {
            talkMode._test_setPTTFinalizerHandler(nil)
            talkMode.stop()
        }

        let start = try await talkMode.beginPushToTalk()
        await talkMode._test_handlePushToTalkTranscript(
            "localized cleanup",
            isFinal: false,
            captureId: start.captureId)
        #expect(talkMode.endPushToTalk(captureId: start.captureId).status == "queued")
        await waitForTalkCondition { talkMode._test_finishingPushToTalkCaptureId() == nil }

        #expect(talkMode.statusText == "Ready")
        #expect(talkMode.phase == .idle)
    }

    @Test @MainActor func `enabling Talk during PTT finalization resumes after ownership clears`() async throws {
        var audioDeactivationCount = 0
        let talkMode = TalkModeManager(
            allowSimulatorCapture: true,
            audioSessionDeactivationAction: { audioDeactivationCount += 1 })
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        talkMode._test_setPTTFinalizerHandler { await barrier.suspendFirstPreparation() }
        defer {
            barrier.release()
            talkMode._test_setPTTFinalizerHandler(nil)
            talkMode.stop()
        }

        let start = try await talkMode.beginPushToTalk()
        await talkMode._test_handlePushToTalkTranscript(
            "resume continuous Talk",
            isFinal: false,
            captureId: start.captureId)
        #expect(talkMode.endPushToTalk(captureId: start.captureId).status == "queued")
        await barrier.waitUntilEntered()

        talkMode.setEnabled(true)
        await talkMode.start()
        #expect(!talkMode.isListening)

        barrier.release()
        await waitForTalkCondition {
            talkMode._test_finishingPushToTalkCaptureId() == nil && talkMode.isListening
        }
        #expect(talkMode.isEnabled)
        #expect(talkMode.isListening)
        #expect(audioDeactivationCount == 1)
    }

    @Test @MainActor func `native Talk disconnect releases audio and reconnects once`() async {
        var audioDeactivationCount = 0
        let talkMode = TalkModeManager(
            allowSimulatorCapture: true,
            audioSessionDeactivationAction: { audioDeactivationCount += 1 })
        defer { talkMode.stop() }
        talkMode.updateGatewayConnected(true)
        talkMode.setEnabled(true)
        await waitForTalkCondition { talkMode.isListening }
        await talkMode._test_handleTranscript(
            "partial old route",
            isFinal: false,
            pttCaptureId: nil,
            recognitionGeneration: talkMode._test_recognitionGeneration())
        #expect(talkMode._test_lastTranscript() == "partial old route")

        talkMode.updateGatewayConnected(false)

        #expect(talkMode.isEnabled)
        #expect(!talkMode.isListening)
        #expect(talkMode._test_lastTranscript().isEmpty)
        #expect(audioDeactivationCount == 1)

        talkMode.updateGatewayConnected(true)
        await waitForTalkCondition { talkMode.isListening }
        #expect(talkMode.isListening)
        #expect(audioDeactivationCount == 1)
    }

    @Test @MainActor func `native Talk session switch discards old recognition and restarts`() async {
        var audioDeactivationCount = 0
        let talkMode = TalkModeManager(
            allowSimulatorCapture: true,
            audioSessionDeactivationAction: { audioDeactivationCount += 1 })
        talkMode.updateGatewayConnected(true)
        talkMode.setEnabled(true)
        defer { talkMode.stop() }
        await waitForTalkCondition { talkMode.isListening }
        let staleRecognitionGeneration = talkMode._test_recognitionGeneration()
        await talkMode._test_handleTranscript(
            "old session partial",
            isFinal: false,
            pttCaptureId: nil,
            recognitionGeneration: staleRecognitionGeneration)
        #expect(talkMode._test_lastTranscript() == "old session partial")

        talkMode.updateMainSessionKey("agent:main:replacement")

        #expect(talkMode._test_recognitionGeneration() > staleRecognitionGeneration)
        #expect(talkMode._test_lastTranscript().isEmpty)
        await waitForTalkCondition { talkMode.isListening }
        #expect(talkMode.isUsingMainSessionKey("agent:main:replacement"))
        #expect(audioDeactivationCount == 1)
    }

    @Test @MainActor func `session switch cancellation clears finalizer status`() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        talkMode._test_setPTTFinalizerHandler {
            talkMode.statusText = "Aborted"
            await barrier.suspendFirstPreparation()
        }
        defer {
            barrier.release()
            talkMode._test_setPTTFinalizerHandler(nil)
            talkMode.stop()
        }

        let start = try await talkMode.beginPushToTalk()
        await talkMode._test_handlePushToTalkTranscript(
            "cancel old session",
            isFinal: false,
            captureId: start.captureId)
        #expect(talkMode.endPushToTalk(captureId: start.captureId).status == "queued")
        await barrier.waitUntilEntered()
        #expect(talkMode.statusText == "Aborted")

        talkMode.updateMainSessionKey("agent:main:replacement")
        barrier.release()
        await waitForTalkCondition { talkMode._test_finishingPushToTalkCaptureId() == nil }

        #expect(talkMode.statusText == "Ready")
    }

    @Test @MainActor func `backgrounding completes PTT once and releases its voice wake lease`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        talkMode.updateGatewayConnected(true)
        defer { appModel.voiceWake.stop() }

        let once = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "once-background", command: .pttOnce))
        }
        await waitForTalkCondition { talkMode._test_activePushToTalkCaptureId() != nil }
        let captureId = try #require(talkMode._test_activePushToTalkCaptureId())
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds() == [captureId])

        talkMode.suspendForBackground()

        let payload = try await decodeTalkPayload(OpenClawTalkPTTStopPayload.self, from: once.value)
        #expect(payload.captureId == captureId)
        #expect(payload.status == "cancelled")
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `background PTT teardown cannot restart Voice Wake`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        talkMode.updateGatewayConnected(true)
        appModel.voiceWake.isEnabled = true
        appModel.voiceWake.isListening = true
        appModel.voiceWake.statusText = "Listening"
        defer { appModel.voiceWake.stop() }

        let startResponse = await appModel.handleInvoke(talkRequest(id: "background-start", command: .pttStart))
        let start = try decodeTalkPayload(OpenClawTalkPTTStartPayload.self, from: startResponse)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds() == [start.captureId])

        appModel.setScenePhase(.background)

        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
        #expect(appModel.voiceWake._test_isSuppressedForBackground())
        #expect(!appModel.voiceWake._test_isSuppressedByPushToTalk())
        #expect(!appModel.voiceWake.isListening)

        appModel.setScenePhase(.active)
        #expect(!appModel.voiceWake._test_isSuppressedForBackground())
    }

    @Test @MainActor func `background listening preference never preserves active PTT`() async throws {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: "talk.background.enabled")
        defaults.set(true, forKey: "talk.background.enabled")
        defer {
            if let previous {
                defaults.set(previous, forKey: "talk.background.enabled")
            } else {
                defaults.removeObject(forKey: "talk.background.enabled")
            }
        }

        let (talkMode, appModel) = makeTalkModel()
        talkMode.updateGatewayConnected(true)
        defer {
            appModel.setScenePhase(.active)
            talkMode.stop()
        }

        let response = await appModel.handleInvoke(talkRequest(id: "background-pref-start", command: .pttStart))
        let start = try decodeTalkPayload(OpenClawTalkPTTStartPayload.self, from: response)
        #expect(talkMode._test_activePushToTalkCaptureId() == start.captureId)

        appModel.setScenePhase(.background)

        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(talkMode._test_pushToTalkCaptureIsIdle())
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `background listening preference does not strand an initially gated Talk start`() async {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: "talk.background.enabled")
        defaults.set(true, forKey: "talk.background.enabled")
        defer {
            if let previous {
                defaults.set(previous, forKey: "talk.background.enabled")
            } else {
                defaults.removeObject(forKey: "talk.background.enabled")
            }
        }

        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let appModel = NodeAppModel(
            talkMode: talkMode,
            audioAdmissionInitiallyAllowed: false)
        talkMode.updateGatewayConnected(true)
        talkMode.setEnabled(true)
        defer {
            appModel.setScenePhase(.active)
            talkMode.stop()
        }
        await waitForTalkCondition { talkMode.statusText == "Paused" }
        #expect(!talkMode.canKeepContinuousTalkActiveInBackground)

        appModel.setScenePhase(.background)
        appModel.setScenePhase(.active)

        await waitForTalkCondition { talkMode.isListening }
        #expect(talkMode.isEnabled)
        #expect(talkMode.isListening)
    }

    @Test @MainActor func `background listening keeps an active continuous transcript turn`() {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        talkMode.isEnabled = true
        talkMode._test_setContinuousTranscriptProcessingActive(true)
        defer {
            talkMode._test_setContinuousTranscriptProcessingActive(false)
            talkMode.stop()
        }

        #expect(talkMode.canKeepContinuousTalkActiveInBackground)
        talkMode.suspendForBackground(keepActive: true)
        #expect(talkMode.canKeepContinuousTalkActiveInBackground)

        talkMode.resumeAfterBackground(wasKeptActive: true)
        #expect(talkMode.canKeepContinuousTalkActiveInBackground)
    }

    @Test @MainActor func `late finalizer release cannot restart Voice Wake in background`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        talkMode._test_setPTTFinalizerHandler { await barrier.suspendFirstPreparation() }
        appModel.voiceWake.isEnabled = true
        appModel.voiceWake.isListening = true
        appModel.voiceWake.statusText = "Listening"
        defer {
            barrier.release()
            talkMode._test_setPTTFinalizerHandler(nil)
            appModel.setScenePhase(.active)
            appModel.voiceWake.stop()
        }

        let startResponse = await appModel.handleInvoke(
            talkRequest(id: "background-finalizer-start", command: .pttStart))
        let start = try decodeTalkPayload(OpenClawTalkPTTStartPayload.self, from: startResponse)
        await talkMode._test_handlePushToTalkTranscript(
            "finish in background",
            isFinal: false,
            captureId: start.captureId)
        let stopResponse = await appModel.handleInvoke(
            talkRequest(id: "background-finalizer-stop", command: .pttStop))
        #expect(try decodeTalkPayload(OpenClawTalkPTTStopPayload.self, from: stopResponse).status == "queued")
        await barrier.waitUntilEntered()

        appModel.setScenePhase(.background)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds() == [start.captureId])

        barrier.release()
        await waitForTalkCondition { talkMode._test_finishingPushToTalkCaptureId() == nil }

        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
        #expect(!appModel.voiceWake.isListening)
        #expect(appModel.voiceWake.statusText == "Paused")
        #expect(talkMode.statusText == "Paused")
    }

    @Test @MainActor func `idle background blocks a later Talk enable`() async {
        let (talkMode, appModel) = makeTalkModel()
        talkMode.updateGatewayConnected(true)
        defer {
            appModel.setScenePhase(.active)
            talkMode.stop()
        }

        appModel.setScenePhase(.background)
        talkMode.setEnabled(true)
        await waitForTalkCondition { talkMode.statusText == "Paused" }

        #expect(!talkMode.isListening)
        #expect(talkMode.statusText == "Paused")

        appModel.setScenePhase(.active)
        await waitForTalkCondition { talkMode.isListening }
        #expect(talkMode.isEnabled)
        #expect(talkMode.isListening)
    }

    @Test @MainActor func `background to inactive keeps PTT admission closed`() async {
        let (talkMode, appModel) = makeTalkModel()
        talkMode.updateGatewayConnected(true)
        defer {
            appModel.setScenePhase(.active)
            talkMode.stop()
        }

        appModel.setScenePhase(.background)
        appModel.setScenePhase(.inactive)
        let response = await appModel.handleInvoke(
            talkRequest(id: "inactive-ptt-start", command: .pttStart))

        #expect(!response.ok)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `cancelled background timer cannot suppress a replacement background lease`() async {
        let appModel = NodeAppModel(talkMode: TalkModeManager(allowSimulatorCapture: true))
        defer { appModel.setScenePhase(.active) }

        appModel.setScenePhase(.background)
        appModel.setScenePhase(.active)
        appModel.setScenePhase(.background)

        for _ in 0..<8 {
            await Task.yield()
        }

        #expect(appModel.isBackgrounded)
        #expect(!appModel.backgroundReconnectSuppressed)
        #expect(appModel.gatewayStatusText != "Background idle")
    }

    @Test @MainActor func `stale foreground resume cannot reopen Talk after rebackgrounding`() async {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        var startResumed = false
        talkMode.updateGatewayConnected(true)
        talkMode._test_setStartEntryHandler {
            await barrier.suspendFirstPreparation()
            startResumed = true
        }
        defer {
            barrier.release()
            talkMode._test_setStartEntryHandler(nil)
            appModel.setScenePhase(.active)
            talkMode.stop()
        }

        appModel.setScenePhase(.background)
        talkMode.setEnabled(true)
        appModel.setScenePhase(.active)
        await barrier.waitUntilEntered()
        appModel.setScenePhase(.background)
        barrier.release()
        await waitForTalkCondition { startResumed }

        #expect(!talkMode.isListening)
        #expect(talkMode.statusText != "Listening")
    }

    @Test @MainActor func `gateway disconnect invalidates a suspended Talk start`() async {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let barrier = TalkPreparationBarrier()
        var startResumed = false
        talkMode.updateGatewayConnected(true)
        talkMode._test_setStartEntryHandler {
            await barrier.suspendFirstPreparation()
            startResumed = true
        }
        defer {
            barrier.release()
            talkMode._test_setStartEntryHandler(nil)
            talkMode.stop()
        }

        talkMode.setEnabled(true)
        await barrier.waitUntilEntered()
        talkMode.updateGatewayConnected(false)
        barrier.release()
        await waitForTalkCondition { startResumed }

        #expect(!talkMode.isListening)
        #expect(talkMode.statusText == "Offline")
    }

    @Test @MainActor func `gateway disconnect cancels manual PTT and releases its lease`() async throws {
        let (talkMode, appModel) = makeTalkModel()
        talkMode.updateGatewayConnected(true)

        let response = await appModel.handleInvoke(
            talkRequest(id: "disconnect-ptt-start", command: .pttStart))
        let start = try decodeTalkPayload(OpenClawTalkPTTStartPayload.self, from: response)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds() == [start.captureId])

        talkMode.updateGatewayConnected(false)

        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(!talkMode.isPushToTalkActive)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `background invalidates active and queued PTT preparation`() async {
        let (talkMode, appModel) = makeTalkModel()
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        appModel.testTalkCapturePreparationHandler = { await barrier.suspendFirstPreparation() }
        defer {
            appModel.testTalkCapturePreparationHandler = nil
            appModel.setScenePhase(.active)
            appModel.voiceWake.stop()
        }

        let active = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "background-active", command: .pttStart))
        }
        await barrier.waitUntilEntered()
        let queued = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "background-queued", command: .pttStart))
        }
        await waitForTalkCondition { appModel.talkPreparationWaiters.count == 1 }

        appModel.setScenePhase(.background)
        barrier.release()

        #expect(await active.value.ok == false)
        #expect(await queued.value.ok == false)
        #expect(appModel.talkPreparationWaiters.count == 0)
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds().isEmpty)
    }

    @Test @MainActor func `stale PTT release cannot clear the active voice wake lease`() {
        let appModel = NodeAppModel(talkMode: TalkModeManager(allowSimulatorCapture: true))
        appModel.voiceWake.isEnabled = true
        appModel.voiceWake.isListening = true
        appModel.voiceWake.statusText = "Listening"

        appModel.acquirePttVoiceWakeLease(for: "capture-a")
        #expect(appModel.isTalkCaptureActive == true)
        appModel.acquirePttVoiceWakeLease(for: "capture-a")
        #expect(appModel.voiceWake._test_isSuppressedByPushToTalk())
        #expect(appModel._test_pttVoiceWakeLeaseCaptureIds() == ["capture-a"])

        appModel.releasePttVoiceWakeLease(for: "stale-capture")
        #expect(appModel.voiceWake._test_isSuppressedByPushToTalk())

        appModel.releasePttVoiceWakeLease(for: "capture-a")
        #expect(!appModel.voiceWake._test_isSuppressedByPushToTalk())
        #expect(appModel.isTalkCaptureActive == false)
        appModel.voiceWake.stop()
    }

    @Test @MainActor func `enabling Voice Wake during standalone PTT remains suppressed`() async {
        let appModel = NodeAppModel(talkMode: TalkModeManager(allowSimulatorCapture: true))
        appModel.acquirePttVoiceWakeLease(for: "standalone-ptt")

        appModel.setVoiceWakeEnabled(true)
        await appModel.voiceWake._test_waitForScheduledStart()

        #expect(appModel.voiceWake.statusText == "Paused")
        #expect(!appModel.voiceWake.isListening)

        appModel.releasePttVoiceWakeLease(for: "standalone-ptt")
        await appModel.voiceWake._test_waitForScheduledStart()
        #expect(appModel.voiceWake.statusText == "Voice Wake isn’t supported on Simulator")
        appModel.voiceWake.stop()
    }

    @Test @MainActor func `voice note start cannot race an acquired PTT lease`() async {
        let capture = MockVoiceNoteAudioCapture()
        let recorder = OpenClawVoiceNoteRecorder(capture: capture)
        let appModel = NodeAppModel(
            talkMode: TalkModeManager(allowSimulatorCapture: true),
            voiceNoteRecorder: recorder)
        appModel.acquirePttVoiceWakeLease(for: "voice-note-race")

        #expect(await recorder.start() == false)
        #expect(recorder.isRecording == false)
        #expect(capture.permissionRequestCount == 0)

        appModel.releasePttVoiceWakeLease(for: "voice-note-race")
    }

    @Test @MainActor func `voice note cannot start after the app backgrounds`() async {
        let capture = MockVoiceNoteAudioCapture()
        let recorder = OpenClawVoiceNoteRecorder(capture: capture)
        let appModel = NodeAppModel(voiceNoteRecorder: recorder)
        defer { appModel.setScenePhase(.active) }

        appModel.setScenePhase(.background)

        #expect(await recorder.start() == false)
        #expect(!recorder.isRecording)
        #expect(capture.permissionRequestCount == 0)
        #expect(recorder.errorMessage == "Another feature is using the microphone.")
    }

    @Test @MainActor func `voice note cannot start during PTT preparation`() async {
        let capture = MockVoiceNoteAudioCapture()
        let recorder = OpenClawVoiceNoteRecorder(capture: capture)
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let appModel = NodeAppModel(talkMode: talkMode, voiceNoteRecorder: recorder)
        let barrier = TalkPreparationBarrier()
        talkMode.updateGatewayConnected(true)
        appModel.testTalkCapturePreparationHandler = { await barrier.suspendFirstPreparation() }
        defer {
            barrier.release()
            appModel.testTalkCapturePreparationHandler = nil
            _ = talkMode.cancelPushToTalk()
        }

        let start = Task { @MainActor in
            await appModel.handleInvoke(talkRequest(id: "voice-note-preparation", command: .pttStart))
        }
        await barrier.waitUntilEntered()

        #expect(await recorder.start() == false)
        #expect(!recorder.isRecording)
        #expect(capture.permissionRequestCount == 0)

        barrier.release()
        _ = await start.value
    }

    @Test @MainActor func `audio camera clip cannot overlap PTT ownership`() async throws {
        let camera = RecordingCameraService()
        let appModel = NodeAppModel(
            camera: camera,
            talkMode: TalkModeManager(allowSimulatorCapture: true))
        appModel.acquirePttVoiceWakeLease(for: "camera-audio-ptt")
        defer { appModel.releasePttVoiceWakeLease(for: "camera-audio-ptt") }
        let params = try JSONEncoder().encode(OpenClawCameraClipParams(includeAudio: true))
        let request = try BridgeInvokeRequest(
            id: "camera-audio-during-ptt",
            command: OpenClawCameraCommand.clip.rawValue,
            paramsJSON: #require(String(data: params, encoding: .utf8)))

        let response = await appModel.handleInvoke(request)

        #expect(!response.ok)
        #expect(response.error?.message.contains("Finish the active audio capture") == true)
        #expect(await camera.clipCallCount() == 0)
    }

    @Test @MainActor func `camera audio ownership blocks PTT and continuous Talk`() async throws {
        let barrier = TalkPreparationBarrier()
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let voiceNoteCapture = MockVoiceNoteAudioCapture()
        let voiceNoteRecorder = OpenClawVoiceNoteRecorder(capture: voiceNoteCapture)
        let appModel = NodeAppModel(
            camera: BlockingAudioCameraService(barrier: barrier),
            talkMode: talkMode,
            voiceNoteRecorder: voiceNoteRecorder)
        talkMode.updateGatewayConnected(true)
        defer {
            barrier.release()
            talkMode.stop()
        }
        let params = try JSONEncoder().encode(OpenClawCameraClipParams(includeAudio: true))
        let clipRequest = try BridgeInvokeRequest(
            id: "blocking-camera-audio",
            command: OpenClawCameraCommand.clip.rawValue,
            paramsJSON: #require(String(data: params, encoding: .utf8)))
        let clip = Task { @MainActor in await appModel.handleInvoke(clipRequest) }
        await barrier.waitUntilEntered()

        let ptt = await appModel.handleInvoke(
            talkRequest(id: "ptt-during-camera-audio", command: .pttStart))
        appModel.setTalkEnabled(true)
        let voiceNoteStarted = await voiceNoteRecorder.start()

        #expect(!ptt.ok)
        #expect(ptt.error?.message.contains("active audio capture") == true)
        #expect(!talkMode.isEnabled)
        #expect(talkMode.statusText == "Finish the active audio capture first")
        #expect(!voiceNoteStarted)
        #expect(voiceNoteCapture.permissionRequestCount == 0)
        #expect(voiceNoteRecorder.errorMessage == "Another feature is using the microphone.")

        barrier.release()
        #expect(await clip.value.ok)
    }

    @Test @MainActor func `screen audio ownership blocks PTT`() async throws {
        let barrier = TalkPreparationBarrier()
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let appModel = NodeAppModel(
            screenRecorder: BlockingAudioScreenRecorder(barrier: barrier),
            talkMode: talkMode)
        talkMode.updateGatewayConnected(true)
        defer {
            barrier.release()
            talkMode.stop()
        }
        let params = try JSONEncoder().encode(OpenClawScreenRecordParams(includeAudio: true))
        let recordRequest = try BridgeInvokeRequest(
            id: "blocking-screen-audio",
            command: OpenClawScreenCommand.record.rawValue,
            paramsJSON: #require(String(data: params, encoding: .utf8)))
        let recording = Task { @MainActor in await appModel.handleInvoke(recordRequest) }
        await barrier.waitUntilEntered()

        let ptt = await appModel.handleInvoke(
            talkRequest(id: "ptt-during-screen-audio", command: .pttStart))

        #expect(!ptt.ok)
        #expect(ptt.error?.message.contains("active audio capture") == true)

        barrier.release()
        #expect(await recording.value.ok)
    }

    @Test @MainActor func `screen recording stays single flight across audio modes`() async throws {
        for (firstIncludesAudio, secondIncludesAudio) in [(false, true), (true, false)] {
            let barrier = TalkPreparationBarrier()
            let recorder = BlockingAudioScreenRecorder(barrier: barrier)
            let appModel = NodeAppModel(screenRecorder: recorder)
            let firstParams = try JSONEncoder().encode(
                OpenClawScreenRecordParams(includeAudio: firstIncludesAudio))
            let secondParams = try JSONEncoder().encode(
                OpenClawScreenRecordParams(includeAudio: secondIncludesAudio))
            let firstRequest = try BridgeInvokeRequest(
                id: "screen-first-\(firstIncludesAudio)",
                command: OpenClawScreenCommand.record.rawValue,
                paramsJSON: #require(String(data: firstParams, encoding: .utf8)))
            let secondRequest = try BridgeInvokeRequest(
                id: "screen-second-\(secondIncludesAudio)",
                command: OpenClawScreenCommand.record.rawValue,
                paramsJSON: #require(String(data: secondParams, encoding: .utf8)))

            let first = Task { @MainActor in await appModel.handleInvoke(firstRequest) }
            await barrier.waitUntilEntered()
            #expect(appModel.screenRecordActive)

            let second = await appModel.handleInvoke(secondRequest)

            #expect(!second.ok)
            #expect(second.error?.message.contains("screen recording already active") == true)
            #expect(await recorder.recordCallCount() == 1)
            #expect(appModel.screenRecordActive)

            barrier.release()
            #expect(await first.value.ok)
            #expect(!appModel.screenRecordActive)
        }
    }

    @Test @MainActor func `background cancels camera audio capture and retains suppression until exit`() async throws {
        let barrier = TalkPreparationBarrier()
        let appModel = NodeAppModel(camera: BlockingAudioCameraService(barrier: barrier))
        defer {
            barrier.release()
            appModel.setScenePhase(.active)
        }
        appModel.voiceWake.isEnabled = true
        appModel.voiceWake.statusText = "Listening"
        let params = try JSONEncoder().encode(OpenClawCameraClipParams(includeAudio: true))
        let request = try BridgeInvokeRequest(
            id: "background-camera-audio",
            command: OpenClawCameraCommand.clip.rawValue,
            paramsJSON: #require(String(data: params, encoding: .utf8)))
        let capture = Task { @MainActor in await appModel.handleInvoke(request) }
        await barrier.waitUntilEntered()

        appModel.setScenePhase(.background)
        #expect(appModel.voiceWake._test_isSuppressedForAuxiliaryAudio())
        barrier.release()

        #expect(await capture.value.ok == false)
        #expect(!appModel.voiceWake._test_isSuppressedForAuxiliaryAudio())
        #expect(appModel.voiceWake._test_isSuppressedForBackground())
    }

    @Test @MainActor func `background cancels audio free screen capture`() async throws {
        let barrier = TalkPreparationBarrier()
        let appModel = NodeAppModel(screenRecorder: BlockingAudioScreenRecorder(barrier: barrier))
        defer {
            barrier.release()
            appModel.setScenePhase(.active)
        }
        let params = try JSONEncoder().encode(OpenClawScreenRecordParams(includeAudio: false))
        let request = try BridgeInvokeRequest(
            id: "background-screen-no-audio",
            command: OpenClawScreenCommand.record.rawValue,
            paramsJSON: #require(String(data: params, encoding: .utf8)))
        let capture = Task { @MainActor in await appModel.handleInvoke(request) }
        await barrier.waitUntilEntered()

        appModel.setScenePhase(.background)
        barrier.release()

        #expect(await capture.value.ok == false)
        #expect(!appModel.screenRecordActive)
    }

    @Test @MainActor func `cancelled screen capture deletes a late output file`() async throws {
        let barrier = TalkPreparationBarrier()
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("late-cancelled-screen-\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: outputURL) }
        let appModel = NodeAppModel(
            screenRecorder: CancellationIgnoringScreenRecorder(
                barrier: barrier,
                outputURL: outputURL))
        defer {
            barrier.release()
            appModel.setScenePhase(.active)
        }
        let params = try JSONEncoder().encode(OpenClawScreenRecordParams(includeAudio: false))
        let request = try BridgeInvokeRequest(
            id: "late-cancelled-screen",
            command: OpenClawScreenCommand.record.rawValue,
            paramsJSON: #require(String(data: params, encoding: .utf8)))
        let capture = Task { @MainActor in await appModel.handleInvoke(request) }
        await barrier.waitUntilEntered()

        appModel.setScenePhase(.background)
        barrier.release()

        #expect(await capture.value.ok == false)
        #expect(!FileManager.default.fileExists(atPath: outputURL.path))
        #expect(!appModel.screenRecordActive)
    }

    @Test @MainActor func `late watch snapshot is repaired after gateway switch`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let watchService = MockWatchMessagingService()
        let gate = WatchSnapshotSendGate()
        var shouldBlockNextSnapshot = true
        watchService.syncExecApprovalSnapshotHandler = { _ in
            if shouldBlockNextSnapshot {
                shouldBlockNextSnapshot = false
                await gate.wait()
            }
            return watchService.nextSendResult
        }
        let appModel = NodeAppModel(watchMessagingService: watchService)
        defer { appModel.disconnectGateway() }
        let (gatewayA, gatewayB) = try makeGatewayPair(
            firstURL: #require(URL(string: "wss://127.0.0.1:1")),
            firstStableID: "watch-route-a",
            secondURL: #require(URL(string: "wss://127.0.0.1:2")),
            secondStableID: "watch-route-b")

        appModel.applyGatewayConnectConfig(gatewayA)
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-route-a",
                gatewayStableID: gatewayA.effectiveStableID,
                commandText: "route A",
                allowedDecisions: ["deny"],
                host: nil,
                agentId: nil,
                expiresAtMs: nil)))
        while await !(gate.hasStarted()) {
            await Task.yield()
        }

        appModel.applyGatewayConnectConfig(gatewayB)
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-route-b",
                gatewayStableID: gatewayB.effectiveStableID,
                commandText: "route B",
                allowedDecisions: ["deny"],
                host: nil,
                agentId: nil,
                expiresAtMs: nil)))
        await gate.resume()

        for _ in 0..<1000
            where watchService.sentExecApprovalSnapshots.count < 3
            || watchService.lastSentExecApprovalSnapshot?.approvals.first?.gatewayStableID
            != gatewayB.effectiveStableID
        {
            await Task.yield()
        }
        #expect(watchService.sentExecApprovalSnapshots.count >= 3)
        #expect(watchService.lastSentExecApprovalSnapshot?.approvals.map(\.gatewayStableID) == [
            gatewayB.effectiveStableID,
        ])
    }

    @Test @MainActor func `dismiss pending exec approval prompt by id leaves different prompt visible`() throws {
        let appModel = NodeAppModel()
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-active",
                    commandText: "echo keep",
                    agentId: nil,
                    expiresAtMs: 1)))

        appModel.dismissPendingExecApprovalPrompt(approvalId: "approval-stale")

        let prompt = try #require(appModel.pendingExecApprovalPrompt)
        #expect(prompt.id == "approval-active")
    }

    @Test @MainActor func `presenting exec approval prompt syncs watch prompt`() async throws {
        let (watchService, appModel) = makeWatchModel()
        let prompt = try #require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-watch-sync",
                commandText: "npm publish",
                warningText: "Publishes a package",
                nodeId: "node-1",
                expiresAtMs: 1234))

        appModel._test_presentExecApprovalPrompt(prompt)
        let promptPublished = await waitForMainActorWork {
            watchService.lastSentExecApprovalPrompt?.approval.id == "approval-watch-sync"
        }
        try #require(promptPublished)

        let sent = try #require(watchService.lastSentExecApprovalPrompt)
        #expect(sent.approval.id == "approval-watch-sync")
        #expect(sent.approval.allowedDecisions == [.allowOnce, .deny])
        #expect(sent.approval.warningText == "Publishes a package")
        #expect(sent.approval.host == "gateway")
        #expect(sent.approval.risk == nil)
        #expect(sent.resetResolutionAttemptId == nil)
    }

    @Test @MainActor func `watch exec approval snapshot request publishes cached approvals in background`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel()
        let futureExpiryMs = Int64(Date().timeIntervalSince1970 * 1000) + 60000
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-watch-snapshot",
                    commandText: "echo from watch",
                    agentId: nil,
                    expiresAtMs: futureExpiryMs)))
        appModel._test_setUnifiedExecApprovalGetResponse(makePendingExecApprovalJSON(
            "approval-watch-snapshot",
            commandText: "echo from watch",
            agentID: nil))
        let initialSnapshotPublished = await waitForMainActorWork {
            watchService.sentExecApprovalSnapshots.contains { snapshot in
                snapshot.requestId == nil &&
                    snapshot.approvals.map(\.id) == ["approval-watch-snapshot"]
            }
        }
        try #require(initialSnapshotPublished)

        appModel.setScenePhase(.background)
        let snapshotCount = watchService.sentExecApprovalSnapshots.count
        watchService.emitExecApprovalSnapshotRequest(
            makeWatchApprovalSnapshotRequest("snapshot-1", sentAt: 111))
        let correlatedSnapshotPublished = await waitForMainActorWork {
            watchService.sentExecApprovalSnapshots.dropFirst(snapshotCount).contains { snapshot in
                snapshot.requestId == "snapshot-1" &&
                    snapshot.requestGatewayStableID == "test-gateway"
            }
        }
        try #require(correlatedSnapshotPublished)

        let snapshot = try #require(watchService.sentExecApprovalSnapshots
            .dropFirst(snapshotCount)
            .first { $0.requestId == "snapshot-1" })
        #expect(snapshot.approvals.map(\.id) == ["approval-watch-snapshot"])
        #expect(snapshot.requestId == "snapshot-1")
        #expect(snapshot.requestGatewayStableID == "test-gateway")
    }

    @Test @MainActor func `foreground watch snapshot acknowledgment requires canonical readback`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel()
        let futureExpiryMs = Int64(Date().timeIntervalSince1970 * 1000) + 60000
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-watch-foreground",
                    commandText: "echo foreground",
                    agentId: nil,
                    expiresAtMs: futureExpiryMs)))
        let canonicalResponse = makePendingExecApprovalJSON(
            "approval-watch-foreground",
            commandText: "echo foreground",
            agentID: nil)
        let initialSnapshotPublished = await waitForMainActorWork {
            watchService.sentExecApprovalSnapshots.contains { snapshot in
                snapshot.requestId == nil &&
                    snapshot.approvals.map(\.id) == ["approval-watch-foreground"]
            }
        }
        try #require(initialSnapshotPublished)
        watchService.lastSentExecApprovalSnapshot = nil
        let snapshotCountBeforeMatchingRequest = watchService.sentExecApprovalSnapshots.count

        appModel._test_setExecApprovalPromptFetchFailure("gateway unavailable")
        await appModel._test_refreshWatchExecApprovalSnapshotOnDemand(
            makeWatchApprovalSnapshotRequest("snapshot-foreground-failed", sentAt: 221))
        #expect(watchService.sentExecApprovalSnapshots.count == snapshotCountBeforeMatchingRequest)

        appModel._test_setUnifiedExecApprovalGetResponse(canonicalResponse)
        await appModel._test_refreshWatchExecApprovalSnapshotOnDemand(
            makeWatchApprovalSnapshotRequest("snapshot-foreground", sentAt: 222))
        let matchingSnapshotPublished = await waitForMainActorWork {
            watchService.sentExecApprovalSnapshots.dropFirst(snapshotCountBeforeMatchingRequest).contains { snapshot in
                snapshot.requestId == "snapshot-foreground" &&
                    snapshot.requestGatewayStableID == "test-gateway"
            }
        }
        try #require(matchingSnapshotPublished)
        let matchingSnapshot = try #require(watchService.sentExecApprovalSnapshots
            .dropFirst(snapshotCountBeforeMatchingRequest)
            .first { $0.requestId == "snapshot-foreground" })

        #expect(matchingSnapshot.approvals.map(\.id) == [
            "approval-watch-foreground",
        ])
        #expect(matchingSnapshot.requestId == "snapshot-foreground")
        #expect(matchingSnapshot.requestGatewayStableID == "test-gateway")

        watchService.lastSentExecApprovalSnapshot = nil
        let snapshotCountBeforeWrongOwnerRequest = watchService.sentExecApprovalSnapshots.count
        watchService.emitExecApprovalSnapshotRequest(
            makeWatchApprovalSnapshotRequest(
                "snapshot-wrong-owner",
                gateway: "other-gateway",
                sentAt: 223))
        let uncorrelatedSnapshotPublished = await waitForMainActorWork {
            watchService.sentExecApprovalSnapshots.dropFirst(snapshotCountBeforeWrongOwnerRequest)
                .contains { snapshot in
                    snapshot.requestId == nil && snapshot.requestGatewayStableID == nil
                }
        }
        try #require(uncorrelatedSnapshotPublished)
        let uncorrelatedSnapshot = try #require(watchService.sentExecApprovalSnapshots
            .dropFirst(snapshotCountBeforeWrongOwnerRequest)
            .first { $0.requestId == nil && $0.requestGatewayStableID == nil })
        #expect(uncorrelatedSnapshot.requestId == nil)
        #expect(uncorrelatedSnapshot.requestGatewayStableID == nil)
    }

    @Test @MainActor func `unknown held attempt stays frozen after pending readback`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        appModel.connectedGatewayID = "test-gateway"
        let approvalID = "approval-held-pending"
        let resolutionAttemptID = "attempt-e\u{0301}-\u{0085}"
        appModel._test_setUnifiedExecApprovalGetResponse(makePendingExecApprovalJSON(approvalID))

        await appModel._test_refreshWatchExecApprovalSnapshotOnDemand(
            makeWatchApprovalSnapshotRequest(
                "snapshot-held-pending",
                held: [WatchExecApprovalSnapshotRequestItem(
                    approvalId: approvalID,
                    activeResolutionAttemptId: resolutionAttemptID)],
                sentAt: 225))

        let snapshot = try #require(watchService.lastSentExecApprovalSnapshot)
        #expect(snapshot.requestId == "snapshot-held-pending")
        #expect(snapshot.approvals.map(\.id) == [approvalID])
        #expect(!watchService.sentExecApprovalPrompts.contains {
            $0.approval.id == approvalID && $0.resetResolutionAttemptId != nil
        })
    }

    @Test @MainActor func `failed held approval readback sends no request snapshot`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        appModel.connectedGatewayID = "test-gateway"
        appModel._test_setUnifiedExecApprovalGetResponse(#"{"invalid":true}"#)
        let snapshotCount = watchService.sentExecApprovalSnapshots.count

        await appModel._test_refreshWatchExecApprovalSnapshotOnDemand(
            makeWatchApprovalSnapshotRequest(
                "snapshot-readback-failed",
                held: [WatchExecApprovalSnapshotRequestItem(
                    approvalId: "approval-watch-readback-failure",
                    activeResolutionAttemptId: nil)],
                sentAt: 225))

        #expect(watchService.sentExecApprovalSnapshots.count == snapshotCount)
    }

    @Test @MainActor func `watch refresh classifies every held approval before acknowledging`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        appModel.connectedGatewayID = "test-gateway"
        let approvalIDs = ["approval-held-b", "approval-held-a"]
        appModel._test_setUnifiedExecApprovalGetResponses(approvalIDs.map {
            (approvalID: $0, json: makePendingExecApprovalJSON($0))
        })

        await appModel._test_refreshWatchExecApprovalSnapshotOnDemand(
            makeWatchApprovalSnapshotRequest(
                "snapshot-held-all",
                held: approvalIDs.map {
                    WatchExecApprovalSnapshotRequestItem(
                        approvalId: $0,
                        activeResolutionAttemptId: nil)
                },
                sentAt: 226))

        let snapshot = try #require(watchService.lastSentExecApprovalSnapshot)
        #expect(snapshot.requestId == "snapshot-held-all")
        #expect(snapshot.approvals.map(\.id) == approvalIDs.sorted())
    }

    @Test @MainActor func `watch readback classifies cached persisted and held approvals once in owner order`()
        async throws
    {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        NodeAppModel._test_setPersistedWatchExecApprovalBridgeStateJSON(#"""
        {
          "approvals": [],
          "pendingApprovalReadbacks": [{
            "approvalId": "approval-persisted-owner",
            "gatewayStableID": "test-gateway"
          }]
        }
        """#)
        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        appModel.connectedGatewayID = "test-gateway"
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-cached-owner",
                commandText: "echo cached",
                expiresAtMs: 4_000_000_000_000)))

        let expectedApprovalIDs = [
            "approval-cached-owner",
            "approval-persisted-owner",
            "approval-held-owner",
        ]
        let probe = WatchApprovalReadbackProbe()
        appModel._test_setUnifiedExecApprovalGetResponses(
            expectedApprovalIDs.map {
                (approvalID: $0, json: makePendingExecApprovalJSON($0))
            },
            beforeResponse: { approvalID in
                await probe.record(approvalID)
            })

        await appModel._test_refreshWatchExecApprovalSnapshotOnDemand(
            makeWatchApprovalSnapshotRequest(
                "snapshot-canonical-owner-order",
                held: [WatchExecApprovalSnapshotRequestItem(
                    approvalId: "approval-held-owner",
                    activeResolutionAttemptId: nil)],
                sentAt: 226))

        #expect(await probe.snapshot() == expectedApprovalIDs)
        let snapshot = try #require(watchService.sentExecApprovalSnapshots.first {
            $0.requestId == "snapshot-canonical-owner-order"
        })
        #expect(snapshot.requestId == "snapshot-canonical-owner-order")
        #expect(snapshot.requestGatewayStableID == "test-gateway")
        #expect(snapshot.approvals.map(\.id) == expectedApprovalIDs.sorted())
        #expect(appModel._test_pendingPersistedExecApprovalReadbacks().isEmpty)
    }

    @Test @MainActor func `canonical watch refresh does not acknowledge byte distinct owner`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let composedGatewayID = "gateway-\u{00E9}"
        let decomposedGatewayID = "gateway-e\u{0301}"
        #expect(composedGatewayID == decomposedGatewayID)
        #expect(GatewayStableIdentifier.key(composedGatewayID) !=
            GatewayStableIdentifier.key(decomposedGatewayID))
        let (watchService, appModel) = makeWatchModel()
        appModel.connectedGatewayID = composedGatewayID
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-watch-exact-owner",
                gatewayStableID: composedGatewayID,
                commandText: "echo exact owner",
                expiresAtMs: 4_000_000_000_000)))
        appModel._test_setUnifiedExecApprovalGetResponse(makePendingExecApprovalJSON(
            "approval-watch-exact-owner",
            commandText: "echo exact owner"))
        await waitForMainActorWork { watchService.lastSentExecApprovalSnapshot != nil }
        let snapshotCount = watchService.sentExecApprovalSnapshots.count

        watchService.emitExecApprovalSnapshotRequest(
            makeWatchApprovalSnapshotRequest(
                "snapshot-byte-distinct-owner",
                gateway: decomposedGatewayID,
                sentAt: 227))
        await waitForMainActorWork {
            watchService.sentExecApprovalSnapshots.count > snapshotCount
        }

        let snapshot = try #require(watchService.sentExecApprovalSnapshots.last)
        #expect(snapshot.approvals.map(\.id) == ["approval-watch-exact-owner"])
        #expect(snapshot.requestId == nil)
        #expect(snapshot.requestGatewayStableID == nil)
        #expect(try Array(#require(snapshot.gatewayStableID).utf8) == Array(composedGatewayID.utf8))
    }

    @Test @MainActor func `not found canonical watch refresh acknowledges request`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        appModel.connectedGatewayID = "test-gateway"
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-watch-not-found",
                commandText: "echo cached",
                expiresAtMs: 4_000_000_000_000)))
        appModel._test_setExecApprovalPromptFetchStale()
        await waitForMainActorWork { watchService.lastSentExecApprovalSnapshot != nil }

        watchService.emitExecApprovalSnapshotRequest(
            makeWatchApprovalSnapshotRequest("snapshot-not-found", sentAt: 226))
        await waitForMainActorWork {
            watchService.lastSentExecApprovalSnapshot?.requestId == "snapshot-not-found"
        }

        #expect(watchService.lastSentExecApprovalSnapshot?.approvals.isEmpty == true)
        #expect(watchService.lastSentExecApprovalExpired?.approvalId == "approval-watch-not-found")
        #expect(watchService.lastSentExecApprovalExpired?.reason == .notFound)
    }

    @Test @MainActor func `foreground watch snapshot acknowledgment follows canonical readback`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        appModel.connectedGatewayID = "test-gateway"
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-watch-stale-cache",
                commandText: "echo stale",
                expiresAtMs: 4_000_000_000_000)))
        appModel._test_setUnifiedExecApprovalGetResponse(makeDeniedExecApprovalJSON(
            "approval-watch-stale-cache",
            commandText: "echo stale",
            expiresAtMs: 4_000_000_000_000))
        watchService.lastSentExecApprovalSnapshot = nil

        watchService.emitExecApprovalSnapshotRequest(
            makeWatchApprovalSnapshotRequest("snapshot-canonical", sentAt: 224))
        await waitForMainActorWork {
            watchService.lastSentExecApprovalSnapshot?.requestId == "snapshot-canonical"
        }

        #expect(watchService.lastSentExecApprovalSnapshot?.approvals.isEmpty == true)
        #expect(watchService.lastSentExecApprovalResolved?.approvalId == "approval-watch-stale-cache")
        #expect(watchService.lastSentExecApprovalResolved?.decision == .deny)
    }

    @Test @MainActor func `watch approval cache miss reports canonical terminal readback`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        appModel.connectedGatewayID = "test-gateway"
        appModel._test_setUnifiedExecApprovalGetResponse(makeDeniedExecApprovalJSON(
            "approval-watch-terminal-readback",
            commandText: "echo guarded"))

        let handled = await appModel.handleWatchExecApprovalResolve(
            WatchExecApprovalResolveEvent(
                replyId: "watch-terminal-readback",
                approvalId: "approval-watch-terminal-readback",
                gatewayStableID: "test-gateway",
                decision: .allowOnce,
                sentAtMs: 123,
                transport: "test"))

        #expect(handled)
        #expect(watchService.lastSentExecApprovalResolved?.approvalId ==
            "approval-watch-terminal-readback")
        #expect(watchService.lastSentExecApprovalResolved?.decision == .deny)
        #expect(watchService.lastSentExecApprovalResolved?.source == "another-reviewer")
        #expect(watchService.lastSentExecApprovalExpired == nil)
    }

    @Test @MainActor func `watch approval cache miss reports canonical pending readback`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        appModel.connectedGatewayID = "test-gateway"
        appModel._test_setUnifiedExecApprovalGetResponse(makePendingExecApprovalJSON(
            "approval-watch-pending-readback",
            commandText: "echo guarded",
            warningText: "Review this command",
            allowedDecisions: [.deny]))

        let handled = await appModel.handleWatchExecApprovalResolve(
            WatchExecApprovalResolveEvent(
                replyId: "watch-pending-readback",
                approvalId: "approval-watch-pending-readback",
                gatewayStableID: "test-gateway",
                decision: .allowOnce,
                sentAtMs: 123,
                transport: "test"))

        #expect(handled)
        let prompt = try #require(watchService.lastSentExecApprovalPrompt)
        #expect(prompt.approval.id == "approval-watch-pending-readback")
        #expect(prompt.approval.allowedDecisions == [.deny])
        #expect(prompt.resetResolutionAttemptId == "watch-pending-readback")
        #expect(watchService.lastSentExecApprovalExpired == nil)
    }

    @Test @MainActor func `delayed terminal fetch does not mutate another visible approval`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let fetchGate = WatchSnapshotSendGate()
        let appModel = makeNodeModelWithMockServices()
        appModel.connectedGatewayID = "test-gateway"
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-visible-b",
                commandText: "echo visible-b",
                expiresAtMs: 4_000_000_000_000)))
        appModel._test_setUnifiedExecApprovalGetResponse(
            makeDeniedExecApprovalJSON("approval-terminal-a", commandText: "echo terminal-a"),
            beforeResponse: { await fetchGate.wait() })

        let fetching = Task { @MainActor in
            await appModel.presentExecApprovalGatewayEventPrompt(approvalId: "approval-terminal-a")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !(fetchGate.hasStarted()), ContinuousClock().now < deadline {
            await Task.yield()
        }

        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-visible-b")
        #expect(appModel._test_pendingExecApprovalState().resolving == false)
        await fetchGate.resume()
        await fetching.value
        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-visible-b")
        #expect(appModel._test_pendingExecApprovalState().resolving == false)
        #expect(appModel._test_pendingExecApprovalState().resolved == nil)
    }

    @Test @MainActor func `delayed pending fetch cannot replace a newer visible approval`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let fetchGate = WatchSnapshotSendGate()
        let appModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        appModel.connectedGatewayID = "test-gateway"
        appModel._test_setUnifiedExecApprovalGetResponse(
            makePendingExecApprovalJSON("approval-delayed-a", commandText: "echo delayed-a"),
            beforeResponse: { await fetchGate.wait() })
        let fetching = Task { @MainActor in
            await appModel.presentExecApprovalGatewayEventPrompt(approvalId: "approval-delayed-a")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !(fetchGate.hasStarted()), ContinuousClock().now < deadline {
            await Task.yield()
        }
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-newer-b",
                commandText: "echo newer-b",
                expiresAtMs: 4_000_000_000_000)))

        await fetchGate.resume()
        await fetching.value
        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-newer-b")
        #expect(appModel._test_pendingExecApprovalState().resolving == false)
    }

    @Test @MainActor func `terminal event tombstone blocks delayed pending reconciliation resurrection`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let fetchGate = WatchSnapshotSendGate()
        let (watchService, appModel) = makeWatchModel()
        appModel.connectedGatewayID = "test-gateway"
        let approvalID = "approval-terminal-interleave"
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: approvalID,
                commandText: "echo guarded",
                expiresAtMs: 4_000_000_000_000)))
        await waitForMainActorWork { watchService.lastSentExecApprovalPrompt != nil }
        watchService.lastSentExecApprovalPrompt = nil
        watchService.sentExecApprovalPrompts.removeAll()
        appModel._test_setUnifiedExecApprovalGetResponse(makePendingExecApprovalJSON(approvalID), beforeResponse: {
            await fetchGate.wait()
        })

        let reconciling = Task { @MainActor in
            await appModel.reconcileWatchExecApprovalCache(reason: "watch_request")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !fetchGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }

        let terminalJSON = makeAllowedExecApprovalJSON(
            "approval-terminal-interleave",
            commandText: "echo guarded",
            decision: .allowOnce,
            applied: true)
        #expect(try await appModel._test_applyUnifiedExecApprovalResolveResult(
            terminalJSON,
            approvalID: approvalID,
            attemptedDecision: .allowOnce))
        await fetchGate.resume()
        _ = await reconciling.value

        #expect(appModel._test_pendingExecApprovalInboxItems().isEmpty)
        #expect(appModel.pendingExecApprovalPrompt?.id == approvalID)
        #expect(appModel._test_pendingExecApprovalState().resolved == "Approval allowed once.")
        #expect(watchService.sentExecApprovalPrompts.isEmpty)
        #expect(watchService.lastSentExecApprovalResolved?.approvalId == approvalID)
    }

    @Test @MainActor func `operator reconnect preserves dismissed approval in reopenable inbox`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel()
        appModel.connectedGatewayID = "test-gateway"
        let prompt = try #require(NodeAppModel._test_makeExecApprovalPrompt(
            id: "approval-reconnect-restore",
            commandText: "echo restore",
            warningText: "Review after reconnect",
            expiresAtMs: 4_000_000_000_000))
        appModel._test_presentExecApprovalPrompt(prompt)
        appModel.dismissPendingExecApprovalPrompt()
        #expect(appModel.pendingExecApprovalPrompt == nil)
        appModel._test_setUnifiedExecApprovalGetResponse(makePendingExecApprovalJSON(
            "approval-reconnect-restore",
            commandText: "echo restore",
            warningText: "Review after reconnect"))

        await appModel.reconcileWatchExecApprovalCache(reason: "operator_reconnected")

        #expect(appModel.pendingExecApprovalPrompt == nil)
        #expect(appModel._test_pendingExecApprovalInboxItems().map(\.id) == ["approval-reconnect-restore"])
        await waitForMainActorWork { watchService.lastSentExecApprovalPrompt != nil }
        #expect(watchService.lastSentExecApprovalPrompt?.approval.id == "approval-reconnect-restore")
        #expect(watchService.lastSentExecApprovalPrompt?.resetResolutionAttemptId == nil)
        appModel._test_presentPendingExecApprovalFromInbox(
            approvalID: "approval-reconnect-restore",
            gatewayStableID: "test-gateway")
        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-reconnect-restore")
    }

    @Test @MainActor func `watch reconciliation does not reopen dismissed phone presentation`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel(
            notificationCenter: MockBootstrapNotificationCenter())
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-watch-reconcile",
                commandText: "echo reconcile",
                expiresAtMs: 4_000_000_000_000)))
        await waitForMainActorWork { watchService.lastSentExecApprovalPrompt != nil }
        appModel.dismissPendingExecApprovalPrompt()
        watchService.lastSentExecApprovalPrompt = nil
        appModel._test_setUnifiedExecApprovalGetResponse(makePendingExecApprovalJSON(
            "approval-watch-reconcile",
            commandText: "echo reconcile"))

        await appModel.reconcileWatchExecApprovalCache(reason: "operator_reconnected")

        await waitForMainActorWork { watchService.lastSentExecApprovalPrompt != nil }
        #expect(watchService.lastSentExecApprovalPrompt?.approval.id == "approval-watch-reconcile")
        #expect(watchService.lastSentExecApprovalPrompt?.resetResolutionAttemptId == nil)
        #expect(appModel.pendingExecApprovalPrompt == nil)
        #expect(appModel._test_pendingExecApprovalInboxItems().map(\.id) == ["approval-watch-reconcile"])
    }

    @Test @MainActor func `pending reconciliation cannot unlock or duplicate an active phone approval write`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        let approvalID = "approval-phone-write-race"
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: approvalID,
                commandText: "echo race",
                expiresAtMs: 4_000_000_000_000)))
        appModel._test_setUnifiedExecApprovalGetResponse(makePendingExecApprovalJSON(
            "approval-phone-write-race",
            commandText: "echo race"))
        let writeGate = ExecApprovalResolutionGate()
        appModel._test_setExecApprovalResolutionFailureHandler { _, _, _ in
            await writeGate.waitForFirstCall()
        }

        let firstWrite = Task { @MainActor in
            await appModel.resolvePendingExecApprovalPrompt(decision: "allow-once")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !writeGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }
        let initialWriteCount = await writeGate.callCount()
        #expect(initialWriteCount == 1)
        #expect(appModel._test_pendingExecApprovalState().resolving)

        await appModel.reconcileWatchExecApprovalCache(reason: "watch_request")
        #expect(appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalState().error == nil)

        await appModel.resolvePendingExecApprovalPrompt(decision: "deny")
        let conflictingWriteCount = await writeGate.callCount()
        #expect(conflictingWriteCount == 1)
        #expect(appModel._test_pendingExecApprovalState().resolving)

        await writeGate.resume()
        await firstWrite.value
        #expect(!appModel._test_pendingExecApprovalState().resolving)
        #expect(appModel._test_pendingExecApprovalState().error == "simulated approval write failure")
    }

    @Test @MainActor func `phone and watch decisions share one exact owner write lease`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel()
        let approvalID = "approval-phone-watch-lease"
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: approvalID,
                commandText: "echo serialized",
                expiresAtMs: 4_000_000_000_000)))
        await waitForMainActorWork { watchService.lastSentExecApprovalPrompt != nil }
        watchService.lastSentExecApprovalPrompt = nil
        let probe = ExecApprovalConcurrentWriteProbe()
        appModel._test_setExecApprovalResolutionFailureHandler { _, decision, _ in
            await probe.resolve(decision: decision)
        }

        let phoneWrite = Task { @MainActor in
            await appModel.resolvePendingExecApprovalPrompt(decision: "allow-once")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await probe.snapshot().calls.count < 1, ContinuousClock().now < deadline {
            await Task.yield()
        }
        let queuedWatchDecision = await appModel.handleWatchExecApprovalResolve(
            WatchExecApprovalResolveEvent(
                replyId: "watch-lease-attempt",
                approvalId: approvalID,
                gatewayStableID: "test-gateway",
                decision: .deny,
                sentAtMs: 123,
                transport: "test"))
        #expect(!queuedWatchDecision)
        let queuedSnapshot = await probe.snapshot()
        #expect(queuedSnapshot.calls == ["allow-once"])

        await probe.releaseFirst()
        await phoneWrite.value
        let secondDeadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await probe.snapshot().calls.count < 2, ContinuousClock().now < secondDeadline {
            await Task.yield()
        }
        let snapshot = await probe.snapshot()
        #expect(snapshot.calls == ["allow-once", "deny"])
        #expect(snapshot.maximumActiveWrites == 1)
        await waitForMainActorWork {
            watchService.lastSentExecApprovalPrompt?.resetResolutionAttemptId == "watch-lease-attempt"
        }
        #expect(watchService.lastSentExecApprovalPrompt?.resetResolutionAttemptId == "watch-lease-attempt")
    }

    @Test @MainActor func `watch reconciliation retains visible approval and otherwise chooses first exact I d`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        appModel.connectedGatewayID = "test-gateway"
        for approvalID in ["approval-b", "approval-a"] {
            try appModel._test_presentExecApprovalPrompt(#require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: approvalID,
                    commandText: "echo cached \(approvalID)",
                    expiresAtMs: 4_000_000_000_000)))
        }
        let responses: [(approvalID: String, json: String)] = [
            (
                "approval-a",
                makePendingExecApprovalJSON("approval-a", commandText: "canonical approval-a")),
            (
                "approval-b",
                makePendingExecApprovalJSON("approval-b", commandText: "canonical approval-b")),
        ]
        appModel._test_setUnifiedExecApprovalGetResponses(responses)

        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-a")
        await appModel.reconcileWatchExecApprovalCache(reason: "watch_request")
        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-a")
        #expect(appModel.pendingExecApprovalPrompt?.commandText == "canonical approval-a")

        let fetchGate = WatchSnapshotSendGate()
        appModel._test_setUnifiedExecApprovalGetResponses(responses, beforeResponse: { approvalID in
            if approvalID == "approval-a" {
                await fetchGate.wait()
            }
        })
        let reconciling = Task { @MainActor in
            await appModel.reconcileWatchExecApprovalCache(reason: "watch_request")
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !(fetchGate.hasStarted()), ContinuousClock().now < deadline {
            await Task.yield()
        }
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-b",
                commandText: "newer visible b",
                expiresAtMs: 4_000_000_000_000)))
        await fetchGate.resume()
        _ = await reconciling.value
        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-b")
        #expect(appModel.pendingExecApprovalPrompt?.commandText == "newer visible b")

        appModel.dismissPendingExecApprovalPrompt()
        appModel._test_setUnifiedExecApprovalGetResponses(responses)
        await appModel.reconcileWatchExecApprovalCache(reason: "operator_reconnected")
        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-a")
    }

    @Test @MainActor func `watch app snapshot request publishes current dashboard state`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel()
        let gatewayStableID = " gateway-watch-snapshot "
        appModel.gatewayConnected = true
        appModel.setOperatorConnected(true)
        appModel.connectedGatewayID = gatewayStableID
        appModel.gatewayStatusText = "Connected"
        appModel.talkMode.setEnabled(true)
        appModel.talkMode.statusText = "Listening"

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-1",
                sentAtMs: 123,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot != nil {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        let snapshot = try #require(watchService.lastSentAppSnapshot)
        #expect(snapshot.gatewayConnected == true)
        #expect(snapshot.gatewayStatus.code == .gatewayConnected)
        #expect(snapshot.gatewayStatus.verbatim == nil)
        #expect(snapshot.agentName == "Main")
        #expect(snapshot.sessionKey == "main")
        #expect(try Array(#require(snapshot.gatewayStableID).utf8) == Array(gatewayStableID.utf8))
        #expect(snapshot.talkStatus.code != .legacy)
        #expect(snapshot.talkStatus.verbatim == nil)
        #expect(snapshot.talkEnabled == true)
        #expect(snapshot.pendingApprovalCount == 0)
    }

    @Test @MainActor func `watch gateway problem keeps localization semantics`() async throws {
        let (watchService, appModel) = makeWatchModel()
        appModel.applyOperatorGatewayConnectionProblem(GatewayConnectionProblem(
            kind: .pairingRequired,
            owner: .gateway,
            title: "Pairing approval required",
            message: "Approve this device.",
            titlePresentation: .localized("Pairing approval required"),
            requestId: "request-42",
            retryable: false,
            pauseReconnect: true))

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "localized-gateway-problem",
                sentAtMs: 123,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot != nil {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        let status = try #require(watchService.lastSentAppSnapshot?.gatewayStatus)
        #expect(status.code == .gatewayProblemWithRequestID)
        #expect(status.localizationKey == "Pairing approval required")
        #expect(status.arguments == ["request-42"])
        #expect(status.verbatim == nil)
    }

    @Test @MainActor func `watch app snapshot publishes offline when operator disconnects`() async {
        let (watchService, appModel) = makeWatchModel()
        appModel.gatewayConnected = true
        appModel.setOperatorConnected(true)
        appModel.gatewayStatusText = "Connected"

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-before-disconnect",
                sentAtMs: 123,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot?.gatewayConnected == true {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        #expect(watchService.lastSentAppSnapshot?.gatewayConnected == true)

        appModel.disconnectGateway()
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot?.gatewayConnected == false {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        #expect(watchService.lastSentAppSnapshot?.gatewayConnected == false)
        #expect(watchService.lastSentAppSnapshot?.gatewayStatus.code == .gatewayOffline)
    }

    @Test @MainActor func `watch app snapshot preserves gateway connection progress`() async throws {
        let (watchService, appModel) = makeWatchModel()
        appModel.setGatewayConnectionProgress(reconnecting: false)

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-connecting",
                sentAtMs: 123,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot != nil {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        let status = try #require(watchService.lastSentAppSnapshot?.gatewayStatus)
        #expect(status.code == .gatewayConnecting)
        #expect(status.verbatim == nil)
        #expect(watchService.lastSentAppSnapshot?.gatewayStatusText == "Connecting…")
    }

    @Test @MainActor func `watch app snapshot preserves talk failures`() async throws {
        let (watchService, appModel) = makeWatchModel()
        appModel.talkMode._test_markSpeechErrorStatusPendingRestart("Speech error: denied")

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-talk-failure",
                sentAtMs: 123,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot != nil {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        let status = try #require(watchService.lastSentAppSnapshot?.talkStatus)
        #expect(status.code == .talkFailure)
        #expect(status.verbatim == "Speech error: denied")
        #expect(watchService.lastSentAppSnapshot?.talkStatusText == "Speech error: denied")
    }

    @Test @MainActor func `watch app snapshot preserves one shot push to talk phase`() async {
        let (watchService, appModel) = makeWatchModel()
        appModel.talkMode.isEnabled = false
        appModel.talkMode.isPushToTalkActive = true
        appModel.talkMode._test_handleRealtimeRelayStatus("Thinking")

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-push-to-talk",
                sentAtMs: 123,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot != nil {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        #expect(watchService.lastSentAppSnapshot?.talkStatus.code == .talkThinking)
    }

    @Test @MainActor func `watch app snapshot preserves terminal push to talk failure`() async {
        let (watchService, appModel) = makeWatchModel()
        appModel.talkMode._test_handleRealtimeRelayStatus("Backend rejected realtime request")

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-push-to-talk-failure",
                sentAtMs: 123,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot != nil {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        #expect(watchService.lastSentAppSnapshot?.talkStatus.code == .talkFailure)
        #expect(
            watchService.lastSentAppSnapshot?.talkStatus.verbatim
                == "Backend rejected realtime request")
    }

    @Test @MainActor func `watch app snapshot publishes online when operator reconnects`() async {
        let (watchService, appModel) = makeWatchModel()
        appModel.gatewayConnected = true
        appModel.gatewayStatusText = "Connected"

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-before-reconnect",
                sentAtMs: 124,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot?.gatewayConnected == false {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        #expect(watchService.lastSentAppSnapshot?.gatewayConnected == false)

        appModel.setOperatorConnected(true)
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot?.gatewayConnected == true {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        #expect(watchService.lastSentAppSnapshot?.gatewayConnected == true)
        #expect(watchService.lastSentAppSnapshot?.gatewayStatus.code == .gatewayConnected)
    }

    @Test @MainActor func `watch app snapshot uses configured agent avatar`() async throws {
        let (watchService, appModel) = makeWatchModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.gatewayAgents = [
            AgentSummary(
                id: "main",
                name: "Main",
                identity: [
                    "avatarUrl": AnyCodable("https://example.com/openclaw.png"),
                    "emoji": AnyCodable("OC"),
                ],
                workspace: nil,
                workspacegit: nil,
                model: nil,
                agentruntime: nil),
        ]

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-avatar",
                sentAtMs: 124,
                transport: "sendMessage"))
        await Task.yield()

        let snapshot = try #require(watchService.lastSentAppSnapshot)
        #expect(snapshot.agentAvatarURL == "https://example.com/openclaw.png")
        #expect(snapshot.agentAvatarText == "OC")
    }

    @Test @MainActor func `watch app snapshot includes pending approval count`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let (watchService, appModel) = makeWatchModel()

        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-watch-app-count",
                    commandText: "rm -rf build",
                    host: "Mac",
                    nodeId: "node-1",
                    agentId: "agent-1",
                    expiresAtMs: nil)))
        await Task.yield()

        let snapshot = try #require(watchService.lastSentAppSnapshot)
        #expect(snapshot.pendingApprovalCount == 1)
    }

    @Test @MainActor func `watch app command controls talk through phone model`() async {
        let watchService = MockWatchMessagingService()
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let appModel = NodeAppModel(watchMessagingService: watchService, talkMode: talkMode)

        watchService.emitAppCommand(
            makeWatchAppCommand("watch-start-talk", .startTalk, sentAt: 123))
        await Task.yield()

        #expect(appModel.talkMode.isEnabled == true)
        #expect(watchService.lastSentAppSnapshot?.talkEnabled == true)

        watchService.emitAppCommand(
            makeWatchAppCommand("watch-stop-talk", .stopTalk, sentAt: 124))
        await Task.yield()

        #expect(appModel.talkMode.isEnabled == false)
        #expect(watchService.lastSentAppSnapshot?.talkEnabled == false)
    }

    @Test @MainActor func `watch app command opens chat session on phone model`() async {
        let (watchService, appModel) = makeWatchModel()

        watchService.emitAppCommand(
            makeWatchAppCommand(
                "watch-open-chat",
                .openChat,
                session: "incident-42",
                sentAt: 125))
        await Task.yield()

        #expect(appModel.chatSessionKey == "incident-42")
        #expect(watchService.lastSentAppSnapshot?.sessionKey == "incident-42")
    }

    @Test @MainActor func `watch app commands reject stale gateway targets`() async {
        let watchService = MockWatchMessagingService()
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let appModel = NodeAppModel(watchMessagingService: watchService, talkMode: talkMode)
        appModel.connectedGatewayID = "gateway-current"
        appModel.setTalkEnabled(false)

        for command in [OpenClawWatchAppCommand.openChat, .startTalk] {
            watchService.emitAppCommand(
                makeWatchAppCommand(
                    "watch-stale-\(command.rawValue)",
                    command,
                    session: "stale-session",
                    gateway: "gateway-stale",
                    sentAt: 125,
                    transport: "transferUserInfo"))
            await Task.yield()
        }

        #expect(appModel.chatSessionKey != "stale-session")
        #expect(appModel.talkMode.isEnabled == false)

        appModel.setTalkEnabled(true)
        watchService.emitAppCommand(
            makeWatchAppCommand(
                "watch-stale-stop-talk",
                .stopTalk,
                session: "stale-session",
                gateway: "gateway-stale",
                sentAt: 126,
                transport: "transferUserInfo"))
        await Task.yield()

        #expect(appModel.talkMode.isEnabled == true)
    }

    @Test @MainActor func `watch app command sends chat message through phone model`() async {
        let (watchService, appModel) = makeWatchModel()
        appModel.enterAppleReviewDemoMode()

        watchService.emitAppCommand(
            makeWatchAppCommand(
                "watch-send-chat",
                .sendChat,
                gateway: AppleReviewDemoMode.gatewayID,
                text: "Watch says hello",
                sentAt: 126))
        for _ in 0..<20 {
            if watchService.lastSentChatCompletion?.commandId == "watch-send-chat",
               watchService.lastSentAppSnapshot?.chatItems?.contains(where: { item in
                   item.role == "user" && item.text.contains("Watch says hello")
               }) == true
            {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        #expect(watchService.lastSentAppSnapshot?.chatItems?.contains { item in
            item.role == "user" && item.text.contains("Watch says hello")
        } == true)
        #expect(watchService.lastSentChatCompletion?.commandId == "watch-send-chat")
        #expect(watchService.lastSentChatCompletion?.replyText.contains("Watch says hello") == true)
    }

    @Test func `watch chat preview keeps older readable messages after internal events`() throws {
        var rawMessages = try [
            makeWatchChatRawMessage(
                role: "assistant",
                text: "Still worth reading",
                timestamp: 1000),
        ]
        for index in 0..<30 {
            try rawMessages.append(
                makeWatchChatRawMessage(
                    role: "assistant",
                    text: nil,
                    type: "toolCall",
                    timestamp: 2000 + Double(index)))
        }

        let items = WatchChatPresentation.makeItems(from: rawMessages)

        #expect(items.map(\.text) == ["Still worth reading"])
    }

    @Test func `canonical watch chat owner keeps the last five readable projected rows`() throws {
        let rawMessages = try (0..<7).map { index in
            try makeWatchChatRawMessage(
                role: "assistant",
                text: "Readable message \(index)",
                timestamp: Double(index + 1))
        }

        let items = WatchChatPresentation.makeItems(from: rawMessages)

        #expect(items.map(\.text) == (2..<7).map { "Readable message \($0)" })
    }

    @Test func `canonical watch chat owner anchors terminal tool mirrors to the submitted turn`() throws {
        let rawMessages = try [
            makeWatchChatRawMessage(
                role: "user",
                text: "Send the update",
                timestamp: 3000,
                idempotencyKey: "watch-run:user"),
            makeProjectedWatchChatRawMessage(
                role: "assistant",
                text: "Update sent",
                timestamp: 4000,
                serverId: "tool-result-1",
                isMessageToolMirror: true),
        ]

        let reply = WatchChatPresentation.replyText(
            from: rawMessages,
            runID: "watch-run",
            submittedText: "Send the update",
            submittedAtMs: 2500)

        #expect(reply == "Update sent")
    }

    @Test func `watch chat uses shared responses text projection`() throws {
        for type in ["input_text", "output_text"] {
            let runID = "watch-\(type)"
            let rawMessages = try [
                makeWatchChatRawMessage(
                    role: "assistant",
                    text: "Responses \(type)",
                    type: type,
                    timestamp: 1000,
                    idempotencyKey: runID),
            ]

            let items = WatchChatPresentation.makeItems(from: rawMessages)
            let reply = WatchChatPresentation.replyText(
                from: rawMessages,
                runID: runID,
                submittedText: "Question",
                submittedAtMs: 500)

            #expect(items.map(\.text) == ["Responses \(type)"])
            #expect(reply == "Responses \(type)")
        }
    }

    @Test func `watch voice reply matches direct run instead of newest assistant`() throws {
        let rawMessages = try [
            makeWatchChatRawMessage(
                role: "assistant",
                text: "Matching reply",
                timestamp: 2000,
                idempotencyKey: "watch-run"),
            makeWatchChatRawMessage(
                role: "assistant",
                text: "Unrelated newer reply",
                timestamp: 3000,
                idempotencyKey: "other-run"),
        ]

        let reply = WatchChatPresentation.replyText(
            from: rawMessages,
            runID: "watch-run",
            submittedText: "Question",
            submittedAtMs: 1000)

        #expect(reply == "Matching reply")
    }

    @Test func `watch voice reply anchors queued run after persisted user turn`() throws {
        let rawMessages = try [
            makeWatchChatRawMessage(role: "assistant", text: "Active reply", timestamp: 2000),
            makeWatchChatRawMessage(
                role: "user",
                text: "Watch question",
                timestamp: 3000,
                idempotencyKey: "watch-run:user"),
            makeWatchChatRawMessage(
                role: "assistant",
                text: "Still working",
                timestamp: 3500,
                stopReason: "toolUse"),
            makeWatchChatRawMessage(role: "assistant", text: "Queued reply", timestamp: 4000),
        ]

        let reply = WatchChatPresentation.replyText(
            from: rawMessages,
            runID: "watch-run",
            submittedText: "Watch question",
            submittedAtMs: 2500)

        #expect(reply == "Queued reply")
    }

    @Test func `watch voice reply finds collected queued turn`() throws {
        let rawMessages = try [
            makeWatchChatRawMessage(role: "assistant", text: "Active reply", timestamp: 2000),
            makeWatchChatRawMessage(
                role: "user",
                text: "[Queued messages]\nWatch question\nAnother request",
                timestamp: 3100,
                idempotencyKey: "followup-collect:session:hash"),
            makeWatchChatRawMessage(role: "assistant", text: "Collected reply", timestamp: 4000),
        ]

        let reply = WatchChatPresentation.replyText(
            from: rawMessages,
            runID: "watch-run",
            submittedText: "Watch question",
            submittedAtMs: 2500)

        #expect(reply == "Collected reply")
    }

    @Test func `watch chat completion bounds reply text`() {
        let message = OpenClawWatchChatCompletionMessage(
            commandId: "watch-voice",
            replyText: String(repeating: "x", count: 5000))

        let payload = WatchMessagingPayloadCodec.encodeChatCompletionPayload(message)
        let reply = payload["replyText"] as? String

        #expect(reply?.count == WatchMessagingPayloadCodec.completedChatReplyTextLimit)
        #expect(reply?.hasSuffix("...") == true)
    }

    @Test func `watch chat preview disambiguates identical fallback messages`() throws {
        let rawMessages = try [
            makeWatchChatRawMessage(role: "assistant", text: "Same", timestamp: 1000),
            makeWatchChatRawMessage(role: "assistant", text: "Same", timestamp: 1000),
        ]

        let items = WatchChatPresentation.makeItems(from: rawMessages)

        #expect(items.count == 2)
        #expect(items[0].id != items[1].id)
    }

    @Test func `watch chat preview disambiguates projected rows sharing server ID`() throws {
        let rawMessages = try [
            makeProjectedWatchChatRawMessage(
                role: "toolResult",
                text: "Update sent",
                timestamp: 1000,
                serverId: "shared-result"),
            makeProjectedWatchChatRawMessage(
                role: "assistant",
                text: "Update sent",
                timestamp: 1000,
                serverId: "shared-result",
                isMessageToolMirror: true),
        ]

        let items = WatchChatPresentation.makeItems(from: rawMessages)

        #expect(items.count == 2)
        #expect(items[0].id != items[1].id)
    }

    @Test func `watch chat preview keeps message I ds stable when window rolls`() throws {
        var rawMessages: [AnyCodable] = []
        for index in 0..<5 {
            try rawMessages.append(
                makeWatchChatRawMessage(
                    role: "assistant",
                    text: "Reply \(index)",
                    timestamp: Double(1000 + index)))
        }

        let before = WatchChatPresentation.makeItems(from: rawMessages)
        try rawMessages.append(
            makeWatchChatRawMessage(
                role: "user",
                text: "Next question",
                timestamp: 2000))
        let after = WatchChatPresentation.makeItems(from: rawMessages)

        #expect(before.last?.id == after.dropLast().last?.id)
        #expect(after.last?.role == "user")
    }

    @Test @MainActor func `watch app command queues chat message when operator offline`() async {
        WatchMessageOutbox.resetPersistedQueue()
        defer { WatchMessageOutbox.resetPersistedQueue() }
        let (watchService, appModel) = makeWatchModel()
        let gatewayID = "gateway-watch-chat-offline"
        appModel.connectedGatewayID = gatewayID

        watchService.emitAppCommand(
            makeWatchAppCommand(
                "watch-send-chat-offline",
                .sendChat,
                gateway: gatewayID,
                text: "Queue this from watch",
                sentAt: 127))
        await Task.yield()

        #expect(appModel.watchMessageOutbox.queuedCount(kind: .chat) == 1)

        watchService.emitAppCommand(
            makeWatchAppCommand(
                "watch-send-chat-offline",
                .sendChat,
                gateway: gatewayID,
                text: "Queue this from watch",
                sentAt: 128))
        await Task.yield()

        #expect(appModel.watchMessageOutbox.queuedCount(kind: .chat) == 1)
    }

    @Test @MainActor func `watch app command queues until cold launch restores its gateway`() async {
        WatchMessageOutbox.resetPersistedQueue()
        defer { WatchMessageOutbox.resetPersistedQueue() }
        let (watchService, appModel) = makeWatchModel()

        watchService.emitAppCommand(
            makeWatchAppCommand(
                "watch-send-chat-before-route",
                .sendChat,
                gateway: "gateway-cold-launch",
                text: "Keep this until startup restores the route",
                sentAt: 127,
                transport: "transferUserInfo"))
        await waitForMainActorWork { appModel.watchMessageOutbox.queuedCount(kind: .chat) == 1 }

        #expect(appModel.watchMessageOutbox.queuedCount(kind: .chat) == 1)
        #expect(watchService.lastSentAppSnapshot == nil)
    }

    @Test @MainActor func `watch app command drops chat message for stale gateway snapshot`() async {
        WatchMessageOutbox.resetPersistedQueue()
        defer { WatchMessageOutbox.resetPersistedQueue() }
        let (watchService, appModel) = makeWatchModel()
        appModel.connectedGatewayID = "gateway-current"

        watchService.emitAppCommand(
            makeWatchAppCommand(
                "watch-send-chat-stale-gateway",
                .sendChat,
                gateway: "gateway-from-old-snapshot",
                text: "Do not send to the new gateway",
                sentAt: 128,
                transport: "transferUserInfo"))
        await Task.yield()

        #expect(appModel.watchMessageOutbox.queuedCount(kind: .chat) == 0)
    }

    @Test @MainActor func `watch app command restores queued chat message after model restart`() async {
        WatchMessageOutbox.resetPersistedQueue()
        defer { WatchMessageOutbox.resetPersistedQueue() }

        let gatewayID = "gateway-watch-chat-restore"
        let firstWatchService = MockWatchMessagingService()
        let firstAppModel = NodeAppModel(watchMessagingService: firstWatchService)
        firstAppModel.connectedGatewayID = gatewayID
        firstWatchService.emitAppCommand(
            makeWatchAppCommand(
                "watch-send-chat-restore",
                .sendChat,
                gateway: gatewayID,
                text: "Keep this through restart",
                sentAt: 129))
        await Task.yield()

        #expect(firstAppModel.watchMessageOutbox.queuedMessageIDs(kind: .chat) == ["watch-send-chat-restore"])

        let secondWatchService = MockWatchMessagingService()
        let secondAppModel = NodeAppModel(watchMessagingService: secondWatchService)
        secondAppModel.connectedGatewayID = gatewayID

        #expect(secondAppModel.watchMessageOutbox.queuedMessageIDs(kind: .chat) == ["watch-send-chat-restore"])

        secondWatchService.emitAppCommand(
            makeWatchAppCommand(
                "watch-send-chat-restore",
                .sendChat,
                gateway: gatewayID,
                text: "Keep this through restart",
                sentAt: 130,
                transport: "transferUserInfo"))
        await Task.yield()

        #expect(secondAppModel.watchMessageOutbox.queuedMessageIDs(kind: .chat) == ["watch-send-chat-restore"])
    }

    @Test @MainActor func `watch chat queue scopes and orders commands by gateway`() throws {
        let suiteName = "watch-chat-queue-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let coordinator = WatchMessageOutbox(defaults: defaults)
        let first = makeWatchAppCommand(
            "watch-send-chat-gateway-a-1",
            .sendChat,
            gateway: "gateway-a",
            text: "First for gateway A",
            sentAt: 131)
        let second = makeWatchAppCommand(
            "watch-send-chat-gateway-a-2",
            .sendChat,
            gateway: "gateway-a",
            text: "Second for gateway A",
            sentAt: 132)

        if case .queue = coordinator.ingest(first, isAvailable: false, gatewayStableID: "gateway-a") {
        } else {
            Issue.record("expected first gateway A command to queue")
        }
        if case .queue = coordinator.ingest(second, isAvailable: false, gatewayStableID: "gateway-a") {
        } else {
            Issue.record("expected second gateway A command to queue")
        }

        #expect(coordinator.nextQueuedMessage(isAvailable: true, gatewayStableID: "gateway-b") == nil)
        coordinator.removeQueuedMessage(
            messageID: "watch-send-chat-gateway-a-1",
            gatewayStableID: "gateway-b")

        #expect(
            coordinator.nextQueuedMessage(isAvailable: true, gatewayStableID: "gateway-a")?.commandId ==
                "watch-send-chat-gateway-a-1")
        #expect(
            coordinator.nextQueuedMessage(isAvailable: true, gatewayStableID: "gateway-a")?.commandId ==
                "watch-send-chat-gateway-a-1")

        coordinator.removeQueuedMessage(
            messageID: "watch-send-chat-gateway-a-1",
            gatewayStableID: "gateway-a")
        #expect(
            coordinator.nextQueuedMessage(isAvailable: true, gatewayStableID: "gateway-a")?.commandId ==
                "watch-send-chat-gateway-a-2")
    }

    @Test @MainActor func `watch chat requeue keeps original gateway owner`() throws {
        let suiteName = "watch-chat-requeue-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let coordinator = WatchMessageOutbox(defaults: defaults)
        let event = makeWatchAppCommand(
            "watch-send-chat-retry-gateway-a",
            .sendChat,
            gateway: "gateway-a",
            text: "Retry for gateway A",
            sentAt: 133)

        coordinator.requeueFront(event, gatewayStableID: event.gatewayStableID)

        #expect(coordinator.nextQueuedMessage(isAvailable: true, gatewayStableID: "gateway-b") == nil)
        #expect(
            coordinator.nextQueuedMessage(isAvailable: true, gatewayStableID: "gateway-a")?.commandId ==
                "watch-send-chat-retry-gateway-a")
    }

    @Test @MainActor func `watch message retry budget resets only on reconnect`() {
        let appModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        let messageID = "watch-message-exhausted"

        appModel.watchMessageRetryAttempts[messageID] = 3
        appModel.setOperatorConnected(true)
        #expect(appModel.watchMessageRetryAttempts[messageID] == nil)

        appModel.watchMessageRetryAttempts[messageID] = 2
        appModel.setOperatorConnected(true)
        #expect(appModel.watchMessageRetryAttempts[messageID] == 2)

        appModel.setOperatorConnected(false)
        appModel.setOperatorConnected(true)
        #expect(appModel.watchMessageRetryAttempts[messageID] == nil)
    }

    @Test @MainActor func `watch message outbox prioritizes replies over queued chat`() throws {
        let suiteName = "watch-message-priority-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let outbox = WatchMessageOutbox(defaults: defaults)
        let chat = makeWatchAppCommand(
            "queued-chat",
            .sendChat,
            gateway: "gateway-a",
            text: "Chat first",
            sentAt: 1,
            transport: "transferUserInfo")
        let reply = makeWatchAppCommand(
            "queued-reply",
            .sendChat,
            session: nil,
            gateway: "gateway-a",
            text: "Reply second",
            sentAt: 2,
            transport: "transferUserInfo",
            kind: .quickReply)

        _ = outbox.ingest(chat, isAvailable: false, gatewayStableID: "gateway-a")
        _ = outbox.ingest(reply, isAvailable: false, gatewayStableID: "gateway-a")

        #expect(outbox.nextQueuedMessage(isAvailable: true, gatewayStableID: "gateway-a") == reply)
    }

    @Test func `watch messages only override thinking for quick replies`() {
        #expect(NodeAppModel.watchThinkingOverride(for: .chat) == nil)
        #expect(NodeAppModel.watchThinkingOverride(for: .quickReply) == "low")
    }

    @Test func `watch message outbox discards permanent gateway failures`() {
        #expect(NodeAppModel._test_shouldDiscardFailedWatchMessage(code: "INVALID_REQUEST"))
        #expect(!NodeAppModel._test_shouldDiscardFailedWatchMessage(
            code: "INVALID_REQUEST",
            message: "Session changed while starting work. Retry."))
        #expect(!NodeAppModel._test_shouldDiscardFailedWatchMessage(code: "UNAVAILABLE"))
    }

    @Test @MainActor func `watch chat restore backfills gateway owner into legacy queued event`() throws {
        let suiteName = "watch-chat-restore-legacy-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let legacyQueueJSON = """
        [
          {
            "gatewayStableID": "gateway-a",
            "event": {
              "commandId": "watch-send-chat-legacy",
              "command": "send-chat",
              "sessionKey": "main",
              "text": "Legacy queued text",
              "sentAtMs": 134,
              "transport": "transferUserInfo"
            }
          }
        ]
        """
        defaults.set(
            Data(legacyQueueJSON.utf8),
            forKey: "watch.chat.command.queue.v1")

        let coordinator = WatchMessageOutbox(defaults: defaults)
        let restored = coordinator.nextQueuedMessage(isAvailable: true, gatewayStableID: "gateway-a")

        #expect(restored?.commandId == "watch-send-chat-legacy")
        #expect(restored?.gatewayStableID == "gateway-a")
    }

    @Test @MainActor func `watch chat command deduping keeps only recent forwarded commands`() throws {
        let suiteName = "watch-chat-recent-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let coordinator = WatchMessageOutbox(defaults: defaults)
        for index in 0..<140 {
            let event = makeWatchAppCommand(
                "watch-forward-\(index)",
                .sendChat,
                text: "Message \(index)",
                sentAt: Int64(index))
            if case .forward = coordinator.ingest(
                event,
                isAvailable: true,
                gatewayStableID: "gateway-a")
            {
                coordinator.removeQueuedMessage(
                    messageID: event.commandId,
                    gatewayStableID: "gateway-a")
            } else {
                Issue.record("expected forwarded command \(index)")
            }
        }

        let oldestEvent = makeWatchAppCommand(
            "watch-forward-0",
            .sendChat,
            text: "Message 0 again",
            sentAt: 999)
        if case .forward = coordinator.ingest(
            oldestEvent,
            isAvailable: true,
            gatewayStableID: "gateway-a")
        {
        } else {
            Issue.record("expected oldest forwarded command to age out of dedupe")
        }

        let recentEvent = makeWatchAppCommand(
            "watch-forward-139",
            .sendChat,
            text: "Message 139 again",
            sentAt: 1000)
        if case .deduped = coordinator.ingest(
            recentEvent,
            isAvailable: true,
            gatewayStableID: "gateway-a")
        {
        } else {
            Issue.record("expected recent forwarded command to stay deduped")
        }
    }

    @Test @MainActor func `watch chat command deduping keeps delivered queued commands recent`() throws {
        let suiteName = "watch-chat-delivered-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let coordinator = WatchMessageOutbox(defaults: defaults)
        for index in 0..<140 {
            let event = makeWatchAppCommand(
                "watch-queued-\(index)",
                .sendChat,
                text: "Queued \(index)",
                sentAt: Int64(index),
                transport: "transferUserInfo")
            if case .queue = coordinator.ingest(
                event,
                isAvailable: false,
                gatewayStableID: "gateway-a")
            {
            } else {
                Issue.record("expected queued command \(index)")
            }
        }

        coordinator.removeQueuedMessage(
            messageID: "watch-queued-0",
            gatewayStableID: "gateway-a")

        let duplicateDeliveredEvent = makeWatchAppCommand(
            "watch-queued-0",
            .sendChat,
            text: "Duplicate after delivery",
            sentAt: 999,
            transport: "transferUserInfo")
        if case .deduped = coordinator.ingest(
            duplicateDeliveredEvent,
            isAvailable: true,
            gatewayStableID: "gateway-a")
        {
        } else {
            Issue.record("expected delivered queued command to stay deduped")
        }
    }

    @Test @MainActor func `pending watch recovery I ds are included without delivered notifications`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }

        let appModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        appModel._test_recordPendingWatchExecApprovalRecoveryID("approval-watch-recovery")

        let ids = await appModel._test_pendingExecApprovalIDsForWatchRecovery()
        #expect(ids == ["approval-watch-recovery"])
    }

    @Test @MainActor func `delivered approval becomes durable watch recovery`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let notificationCenter = MockBootstrapNotificationCenter()
        notificationCenter.delivered = [NotificationSnapshot(
            identifier: "delivered-approval",
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-delivered-recovery",
                    "gatewayDeviceId": "gateway-device-a",
                ],
            ])]
        let firstModel = NodeAppModel(notificationCenter: notificationCenter)

        #expect(await firstModel._test_pendingExecApprovalIDsForWatchRecovery() == [
            "approval-delivered-recovery",
        ])
        #expect(firstModel._test_pendingWatchExecApprovalRecoveryIDs() == [
            "approval-delivered-recovery",
        ])

        let restoredModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        #expect(restoredModel._test_pendingWatchExecApprovalRecoveryIDs() == [
            "approval-delivered-recovery",
        ])
    }

    @Test @MainActor func `approval push owners dedupe and remove by exact bytes`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let composedOwner = "gateway-device-\u{00E9}"
        let decomposedOwner = "gateway-device-e\u{0301}"
        #expect(composedOwner == decomposedOwner)
        let appModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        let composedRecovery = ExecApprovalNotificationPrompt(
            approvalId: "approval-exact-push-recovery",
            gatewayDeviceId: composedOwner)
        let decomposedRecovery = ExecApprovalNotificationPrompt(
            approvalId: "approval-exact-push-recovery",
            gatewayDeviceId: decomposedOwner)

        appModel._test_recordPendingWatchExecApprovalRecoveryID(
            composedRecovery.approvalId,
            gatewayDeviceId: composedOwner)
        appModel._test_recordPendingWatchExecApprovalRecoveryID(
            decomposedRecovery.approvalId,
            gatewayDeviceId: decomposedOwner)
        var recoveryPushes = appModel.pendingWatchExecApprovalRecoveryPushes
        #expect(recoveryPushes.count == 2)
        #expect(Set(recoveryPushes.compactMap { GatewayStableIdentifier.key($0.gatewayDeviceId) }).count == 2)

        appModel.removePendingWatchExecApprovalRecoveryPush(composedRecovery)
        recoveryPushes = appModel.pendingWatchExecApprovalRecoveryPushes
        #expect(recoveryPushes.count == 1)
        #expect(GatewayStableIdentifier.key(recoveryPushes.first?.gatewayDeviceId) ==
            GatewayStableIdentifier.key(decomposedOwner))

        let composedResolved = ExecApprovalNotificationPrompt(
            approvalId: "approval-exact-push-resolved",
            gatewayDeviceId: composedOwner)
        let decomposedResolved = ExecApprovalNotificationPrompt(
            approvalId: "approval-exact-push-resolved",
            gatewayDeviceId: decomposedOwner)
        #expect(await appModel.handleExecApprovalResolvedRemotePush(composedResolved))
        #expect(await appModel.handleExecApprovalResolvedRemotePush(decomposedResolved))
        var resolvedPushes = appModel.pendingExecApprovalResolvedPushes
        #expect(resolvedPushes.count == 2)
        #expect(Set(resolvedPushes.compactMap { GatewayStableIdentifier.key($0.gatewayDeviceId) }).count == 2)

        appModel.removePendingExecApprovalResolvedPush(composedResolved)
        resolvedPushes = appModel.pendingExecApprovalResolvedPushes
        #expect(resolvedPushes.count == 1)
        #expect(GatewayStableIdentifier.key(resolvedPushes.first?.gatewayDeviceId) ==
            GatewayStableIdentifier.key(decomposedOwner))
    }

    @Test @MainActor func `shipped kindless approval cache migrates through owner scoped canonical readback`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        NodeAppModel._test_setPersistedWatchExecApprovalBridgeStateJSON(#"""
        {
          "approvals": [{
            "id": "approval-shipped-cache",
            "gatewayStableID": "gateway-a",
            "commandText": "stale cached command",
            "commandPreview": null,
            "warningText": null,
            "allowedDecisions": ["allow-once", "deny"],
            "host": "gateway",
            "nodeId": null,
            "agentId": "main",
            "expiresAtMs": 4000000000000
          }]
        }
        """#)
        let appModel = makeNodeModelWithMockServices()

        #expect(appModel._test_watchExecApprovalCacheIDs().isEmpty)
        var readbacks = appModel._test_pendingPersistedExecApprovalReadbacks()
        #expect(readbacks.count == 1)
        #expect(readbacks.first?.approvalId == "approval-shipped-cache")
        #expect(readbacks.first?.gatewayStableID == "gateway-a")

        appModel._test_setUnifiedExecApprovalGetResponse(makePendingExecApprovalJSON(
            "approval-shipped-cache",
            commandText: "canonical command"))
        appModel.connectedGatewayID = "gateway-b"
        await appModel.reconcileWatchExecApprovalCache(reason: "operator_reconnected")
        #expect(appModel._test_watchExecApprovalCacheIDs().isEmpty)
        #expect(appModel.pendingExecApprovalPrompt == nil)
        #expect(appModel._test_pendingPersistedExecApprovalReadbacks().count == 1)

        appModel.connectedGatewayID = "gateway-a"
        await appModel.reconcileWatchExecApprovalCache(reason: "operator_reconnected")
        #expect(appModel._test_watchExecApprovalCacheIDs() == ["approval-shipped-cache"])
        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-shipped-cache")
        #expect(appModel.pendingExecApprovalPrompt?.commandText == "canonical command")
        readbacks = appModel._test_pendingPersistedExecApprovalReadbacks()
        #expect(readbacks.isEmpty)
    }

    @Test @MainActor func `route prompt cannot clear ownerful push recovery`() throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }

        let appModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        appModel._test_recordPendingWatchExecApprovalRecoveryID("approval-watch-clear")
        #expect(appModel._test_pendingWatchExecApprovalRecoveryIDs() == ["approval-watch-clear"])

        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-watch-clear",
                    commandText: "echo clear",
                    agentId: nil,
                    expiresAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 60000)))

        #expect(appModel._test_pendingWatchExecApprovalRecoveryIDs() == ["approval-watch-clear"])
    }

    @Test func `approval notification stale error classification prefers structured details`() {
        let staleError = GatewayResponseError(
            method: "approval.get",
            code: "INVALID_REQUEST",
            message: "gateway error",
            details: ["reason": AnyCodable("APPROVAL_NOT_FOUND")])

        #expect(NodeAppModel.isApprovalNotificationStaleError(staleError))
    }

    @Test func `approval RPC family requires a complete route catalog family`() {
        #expect(NodeAppModel._test_execApprovalRPCFamily(
            unifiedGet: true,
            unifiedResolve: true,
            legacyGet: true,
            legacyResolve: true) == "unified")
        #expect(NodeAppModel._test_execApprovalRPCFamily(
            unifiedGet: false,
            unifiedResolve: false,
            legacyGet: true,
            legacyResolve: true) == "legacy")

        for methods in [
            (true, false, true, true),
            (false, true, true, true),
            (false, false, true, false),
            (false, false, false, true),
        ] {
            #expect(NodeAppModel._test_execApprovalRPCFamily(
                unifiedGet: methods.0,
                unifiedResolve: methods.1,
                legacyGet: methods.2,
                legacyResolve: methods.3) == "unavailable")
        }
        #expect(NodeAppModel._test_execApprovalRPCFamily(
            unifiedGet: nil,
            unifiedResolve: nil,
            legacyGet: nil,
            legacyResolve: nil) == "unavailable")
        #expect(NodeAppModel._test_execApprovalRPCFamily(
            unifiedGet: nil,
            unifiedResolve: nil,
            legacyGet: true,
            legacyResolve: true) == "unavailable")
    }

    @Test func `background aware exec approval reconnect covers watch and push paths`() {
        #expect(
            NodeAppModel.shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "watch_request",
                isBackgrounded: true))
        #expect(
            NodeAppModel.shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "push_request",
                isBackgrounded: true))
        #expect(
            NodeAppModel.shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "watch_resolve",
                isBackgrounded: true))
        #expect(
            !NodeAppModel.shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "direct",
                isBackgrounded: true))
        #expect(
            !NodeAppModel.shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "watch_request",
                isBackgrounded: false))
    }

    @Test func `exec approval event ID decodes gateway payload`() {
        let controlPrefixedID = "\u{001C}approval-1"
        #expect(NodeAppModel
            .execApprovalEventID(from: AnyCodable(["id": controlPrefixedID])) == controlPrefixedID)
        #expect(NodeAppModel
            .execApprovalEventID(from: AnyCodable(["id": " approval-1 "])) == " approval-1 ")
        #expect(NodeAppModel
            .execApprovalEventID(from: AnyCodable(["id": "\tapproval-1"])) == "\tapproval-1")
        #expect(NodeAppModel
            .execApprovalEventID(from: AnyCodable(["id": "\u{FEFF}approval-1"])) == "\u{FEFF}approval-1")
        #expect(NodeAppModel.execApprovalEventID(from: AnyCodable(["id": "."])) == nil)
        #expect(NodeAppModel.execApprovalEventID(from: AnyCodable(["id": ".."])) == nil)
        #expect(NodeAppModel.execApprovalEventID(from: AnyCodable(["id": "   "])) == "   ")
        #expect(NodeAppModel.execApprovalEventID(from: AnyCodable(["other": "approval-1"])) == nil)
    }

    @Test @MainActor func `operator gateway resolved event waits for canonical readback`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let notificationCenter = MockBootstrapNotificationCenter()
        notificationCenter.delivered = [NotificationSnapshot(
            identifier: "approval-event-notification",
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-event-resolved",
                    "gatewayDeviceId": "gateway-device-a",
                ],
            ])]
        let appModel = NodeAppModel(notificationCenter: notificationCenter)
        appModel._test_recordPendingWatchExecApprovalRecoveryID(
            "approval-event-resolved",
            gatewayDeviceId: "gateway-device-a")
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-event-resolved",
                    commandText: "echo clear",
                    agentId: nil,
                    expiresAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 60000)))

        await appModel.handleOperatorGatewayServerEvent(EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.resolvedKind,
            payload: AnyCodable(["id": "approval-event-resolved"]),
            seq: nil,
            stateversion: nil))

        #expect(appModel.pendingExecApprovalPrompt?.id == "approval-event-resolved")
        #expect(appModel._test_pendingWatchExecApprovalRecoveryIDs() == ["approval-event-resolved"])
        let pendingResolvedPush = ExecApprovalNotificationPrompt(
            approvalId: "approval-event-resolved",
            gatewayDeviceId: nil)
        #expect(appModel.pendingExecApprovalResolvedPushes == [pendingResolvedPush])
        #expect(!notificationCenter.deliveredRemovedIdentifiers.contains([
            "approval-event-notification",
        ]))
    }

    @Test @MainActor func `resolved push without canonical readback preserves gateway recoveries`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        appModel.connectedGatewayID = "gateway-a"
        let gatewayA = ExecApprovalNotificationPrompt(
            approvalId: "shared-approval-id",
            gatewayDeviceId: "gateway-device-a")
        let gatewayB = ExecApprovalNotificationPrompt(
            approvalId: "shared-approval-id",
            gatewayDeviceId: "gateway-device-b")
        appModel._test_recordPendingWatchExecApprovalRecoveryID(
            gatewayA.approvalId,
            gatewayDeviceId: "gateway-device-a")
        appModel._test_recordPendingWatchExecApprovalRecoveryID(
            gatewayB.approvalId,
            gatewayDeviceId: "gateway-device-b")

        await appModel._test_handleExecApprovalResolvedForCurrentGateway(
            approvalId: gatewayA.approvalId,
            recoveryPushGatewayDeviceID: gatewayA.gatewayDeviceId)

        #expect(appModel.pendingWatchExecApprovalRecoveryPushes == [gatewayA, gatewayB])
    }

    @Test func `watch exec approval hydrate preserves exact missing I ds`() {
        let controlPrefixedID = "\u{001C}pending"
        let composedID = "pending-\u{00E9}"
        let decomposedID = "pending-e\u{0301}"
        let idsToFetch = NodeAppModel.watchExecApprovalIDsNeedingFetch(
            candidateIDs: [
                "cached",
                controlPrefixedID,
                "pending",
                composedID,
                decomposedID,
                "cached",
                "other",
                "",
                "  pending  ",
            ],
            cachedApprovalIDs: ["cached", "also-cached"])

        #expect(idsToFetch.count == 6)
        #expect(idsToFetch[0] == controlPrefixedID)
        #expect(idsToFetch[1] == "pending")
        #expect(Array(idsToFetch[2].utf8) == Array(composedID.utf8))
        #expect(Array(idsToFetch[3].utf8) == Array(decomposedID.utf8))
        #expect(idsToFetch[4] == "other")
        #expect(idsToFetch[5] == "  pending  ")
    }

    @Test @MainActor func `watch approval cache orders canonically equivalent I ds exactly`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let composedID = "approval-\u{00E9}"
        let decomposedID = "approval-e\u{0301}"
        let (watchService, appModel) = makeWatchModel()
        appModel.connectedGatewayID = "test-gateway"

        for approvalID in [composedID, decomposedID] {
            try appModel._test_presentExecApprovalPrompt(#require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: approvalID,
                    commandText: "echo exact",
                    expiresAtMs: 4_000_000_000_000)))
        }

        let cachedIDs = appModel._test_watchExecApprovalCacheIDs()
        #expect(cachedIDs.count == 2)
        #expect(Array(cachedIDs[0].utf8) == Array(decomposedID.utf8))
        #expect(Array(cachedIDs[1].utf8) == Array(composedID.utf8))

        await waitForMainActorWork {
            watchService.lastSentExecApprovalSnapshot?.approvals.count == 2
        }
        let snapshotIDs = try #require(watchService.lastSentExecApprovalSnapshot).approvals.map(\.id)
        #expect(Array(snapshotIDs[0].utf8) == Array(decomposedID.utf8))
        #expect(Array(snapshotIDs[1].utf8) == Array(composedID.utf8))

        let restoredModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        #expect(restoredModel._test_watchExecApprovalCacheIDs().count == 2)
    }

    @Test func `operator loop waits for bootstrap handoff before using stored token`() {
        #expect(
            !NodeAppModel.shouldStartOperatorGatewayLoop(
                token: nil,
                bootstrapToken: "fresh-bootstrap-token",
                password: nil,
                hasStoredOperatorToken: true))
        #expect(
            !NodeAppModel.shouldStartOperatorGatewayLoop(
                token: nil,
                bootstrapToken: nil,
                password: nil,
                hasStoredOperatorToken: false))
        #expect(
            NodeAppModel.shouldStartOperatorGatewayLoop(
                token: nil,
                bootstrapToken: nil,
                password: nil,
                hasStoredOperatorToken: true))
        #expect(
            NodeAppModel.shouldStartOperatorGatewayLoop(
                token: "shared-token",
                bootstrapToken: "fresh-bootstrap-token",
                password: nil,
                hasStoredOperatorToken: false))
    }

    @Test func `credential handoff is required only for bootstrap authentication`() {
        #expect(NodeAppModel.usesBootstrapCredential(
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: nil))
        #expect(!NodeAppModel.usesBootstrapCredential(
            token: "shared-token",
            bootstrapToken: "fresh-bootstrap-token",
            password: nil))
        #expect(!NodeAppModel.usesBootstrapCredential(
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: "shared-password"))
        #expect(!NodeAppModel.usesBootstrapCredential(
            token: nil,
            bootstrapToken: nil,
            password: nil))
    }

    @Test @MainActor func `operator gateway requested event shows notification guidance when notifications off`() async throws {
        let (center, appModel) = makeNotificationModel(status: .notDetermined)
        appModel.resetExecApprovalNotificationGuidanceSuppression()
        defer { appModel.resetExecApprovalNotificationGuidanceSuppression() }

        await appModel.handleOperatorGatewayServerEvent(EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.requestedKind,
            payload: AnyCodable(["id": "approval-notifications-off"]),
            seq: nil,
            stateversion: nil))

        let prompt = try #require(appModel.pendingNotificationPermissionGuidancePrompt)
        #expect(prompt.approvalId == "approval-notifications-off")
    }

    @Test @MainActor func `requested event persists exact readback until canonical classification`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let center = MockBootstrapNotificationCenter()
        center.status = .authorized
        let appModel = NodeAppModel(
            notificationCenter: center,
            watchMessagingService: MockWatchMessagingService())
        appModel.connectedGatewayID = "test-gateway"
        appModel._test_setExecApprovalPromptFetchFailure("route_changed")

        await appModel.handleOperatorGatewayServerEvent(EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.requestedKind,
            payload: AnyCodable(["id": "approval-requested-retry"]),
            seq: nil,
            stateversion: nil))

        #expect(appModel._test_pendingPersistedExecApprovalReadbacks().map(\.approvalId) == [
            "approval-requested-retry",
        ])
        appModel._test_setUnifiedExecApprovalGetResponse(
            makePendingExecApprovalJSON("approval-requested-retry"))
        await appModel.reconcileWatchExecApprovalCache(reason: "operator_reconnected")

        #expect(appModel._test_pendingPersistedExecApprovalReadbacks().isEmpty)
        #expect(appModel._test_pendingExecApprovalInboxItems().map(\.id) == [
            "approval-requested-retry",
        ])
    }

    @Test @MainActor func `stale operator event cannot mutate approval UI after suspension`() async {
        let center = MockBootstrapNotificationCenter()
        let authorizationGate = NotificationAuthorizationGate()
        center.authorizationStatusHandler = { await authorizationGate.wait() }
        let appModel = NodeAppModel(notificationCenter: center)
        appModel.resetExecApprovalNotificationGuidanceSuppression()
        defer { appModel.resetExecApprovalNotificationGuidanceSuppression() }
        var routeIsCurrent = true
        let event = EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.requestedKind,
            payload: AnyCodable(["id": "approval-stale-route"]),
            seq: nil,
            stateversion: nil)

        let handling = Task { @MainActor in
            await appModel.handleOperatorGatewayServerEvent(
                event,
                shouldContinue: { routeIsCurrent })
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !(authorizationGate.hasStarted()), ContinuousClock().now < deadline {
            await Task.yield()
        }
        routeIsCurrent = false
        await authorizationGate.resume(returning: .denied)
        await handling.value

        #expect(appModel.pendingNotificationPermissionGuidancePrompt == nil)
        #expect(appModel.pendingExecApprovalPrompt == nil)
    }

    @Test @MainActor func `suppressed operator gateway requested event does not show notification guidance`() async {
        let (center, appModel) = makeNotificationModel(status: .denied)
        appModel.resetExecApprovalNotificationGuidanceSuppression()
        defer { appModel.resetExecApprovalNotificationGuidanceSuppression() }
        appModel.dismissNotificationPermissionGuidancePrompt(suppressFuture: true)

        await appModel.handleOperatorGatewayServerEvent(EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.requestedKind,
            payload: AnyCodable(["id": "approval-suppressed"]),
            seq: nil,
            stateversion: nil))

        #expect(appModel.pendingNotificationPermissionGuidancePrompt == nil)
    }

    @Test @MainActor func `canonical resolved readback clears notification guidance prompt`() async throws {
        let (center, appModel) = makeNotificationModel(status: .denied)
        appModel.resetExecApprovalNotificationGuidanceSuppression()
        defer { appModel.resetExecApprovalNotificationGuidanceSuppression() }

        await appModel.handleOperatorGatewayServerEvent(EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.requestedKind,
            payload: AnyCodable(["id": "approval-guidance-resolved"]),
            seq: nil,
            stateversion: nil))
        _ = try #require(appModel.pendingNotificationPermissionGuidancePrompt)
        appModel.connectedGatewayID = "test-gateway"
        appModel._test_setUnifiedExecApprovalGetResponse(makeDeniedExecApprovalJSON(
            "approval-guidance-resolved",
            commandText: "echo guarded"))

        await appModel._test_handleExecApprovalResolvedForCurrentGateway(
            approvalId: "approval-guidance-resolved",
            recoveryPushGatewayDeviceID: nil)

        #expect(appModel.pendingNotificationPermissionGuidancePrompt == nil)
    }

    @Test @MainActor func `handle invoke rejects background commands`() async {
        let appModel = NodeAppModel()
        appModel.setScenePhase(.background)

        let req = BridgeInvokeRequest(id: "bg", command: OpenClawScreenCommand.record.rawValue)
        let res = await appModel.handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .backgroundUnavailable)

        let talk = await appModel.handleInvoke(talkRequest(id: "bg-talk", command: .pttStart))
        #expect(talk.ok == false)
        #expect(talk.error?.message.contains("/talk") == true)
    }

    @Test @MainActor func `handle invoke rejects camera when disabled`() async {
        let appModel = NodeAppModel()
        let req = BridgeInvokeRequest(id: "cam", command: OpenClawCameraCommand.snap.rawValue)

        let defaults = UserDefaults.standard
        let key = "camera.enabled"
        let previous = defaults.object(forKey: key)
        defaults.set(false, forKey: key)
        defer {
            if let previous {
                defaults.set(previous, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }

        let res = await appModel.handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message.contains("CAMERA_DISABLED") == true)
    }

    @Test @MainActor func `cancelled camera invoke clears progress HUD`() async {
        let defaults = UserDefaults.standard
        let key = "camera.enabled"
        let previous = defaults.object(forKey: key)
        defaults.set(true, forKey: key)
        defer {
            if let previous {
                defaults.set(previous, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
        let appModel = NodeAppModel(camera: CancellingCameraService())
        let request = BridgeInvokeRequest(id: "cancelled-camera", command: OpenClawCameraCommand.snap.rawValue)

        let response = await appModel.handleInvoke(request)

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message == "node invoke cancelled")
        #expect(appModel.cameraHUDText == nil)
        #expect(appModel.cameraHUDKind == nil)
    }

    @Test @MainActor func `older cancelled camera invoke preserves newer HUD`() async {
        let defaults = UserDefaults.standard
        let key = "camera.enabled"
        let previous = defaults.object(forKey: key)
        defaults.set(true, forKey: key)
        defer {
            if let previous {
                defaults.set(previous, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
        let firstStarted = AsyncStream<Void>.makeStream()
        let secondStarted = AsyncStream<Void>.makeStream()
        let camera = OverlappingCameraService(
            firstStarted: firstStarted.continuation,
            secondStarted: secondStarted.continuation)
        let appModel = NodeAppModel(camera: camera)
        let firstTask = Task {
            await appModel.handleInvoke(
                BridgeInvokeRequest(id: "camera-first", command: OpenClawCameraCommand.snap.rawValue))
        }
        for await _ in firstStarted.stream {
            break
        }
        let secondTask = Task {
            await appModel.handleInvoke(
                BridgeInvokeRequest(id: "camera-second", command: OpenClawCameraCommand.snap.rawValue))
        }
        for await _ in secondStarted.stream {
            break
        }

        await camera.releaseFirst()
        let firstResponse = await firstTask.value
        #expect(firstResponse.error?.message == "node invoke cancelled")
        #expect(appModel.cameraHUDText == "Taking photo…")

        await camera.releaseSecond()
        let secondResponse = await secondTask.value
        #expect(secondResponse.ok)
        #expect(appModel.cameraHUDText == "Photo captured")
    }

    @Test @MainActor func `system notify returns unavailable when notifications off`() async throws {
        let (center, appModel) = makeNotificationModel(status: .notDetermined)
        let req = try makeInvokeRequest(
            id: "notify-off",
            command: OpenClawSystemCommand.notify.rawValue,
            params: OpenClawSystemNotifyParams(title: "Approval", body: "Review request"))

        let res = await appModel.handleInvoke(req)

        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message == "NOT_AUTHORIZED: notifications")
        #expect(center.addCalls == 0)
    }

    @Test @MainActor func `system notify schedules when notifications are already allowed`() async throws {
        let restorePreference = overrideNotificationServingPreference(true)
        defer { restorePreference() }
        let (center, appModel) = makeNotificationModel(status: .authorized)
        let req = try makeInvokeRequest(
            id: "notify-on",
            command: OpenClawSystemCommand.notify.rawValue,
            params: OpenClawSystemNotifyParams(title: "Approval", body: "Review request"))

        let res = await appModel.handleInvoke(req)

        #expect(res.ok)
        #expect(center.addCalls == 1)
    }

    @Test @MainActor func `system notify respects app notification opt out`() async throws {
        let restorePreference = overrideNotificationServingPreference(false)
        defer { restorePreference() }
        let (center, appModel) = makeNotificationModel(status: .authorized)
        let req = try makeInvokeRequest(
            id: "notify-disabled",
            command: OpenClawSystemCommand.notify.rawValue,
            params: OpenClawSystemNotifyParams(title: "Approval", body: "Review request"))

        let res = await appModel.handleInvoke(req)

        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message == "NOT_AUTHORIZED: notifications")
        #expect(center.addCalls == 0)
    }

    @Test @MainActor func `apns registration requires notification authorization and relay disclosure`() async {
        let restorePreference = overrideNotificationServingPreference(true)
        defer { restorePreference() }
        let (center, appModel) = makeNotificationModel(status: .authorized)
        PushEnrollmentConsent.reset()
        defer { PushEnrollmentConsent.reset() }

        #expect(await appModel.canPublishAPNsRegistration() == false)
        #expect(await appModel.canPublishAPNsRegistration(usesRelayTransport: false))

        PushEnrollmentConsent.markDisclosureAccepted()
        center.status = .notDetermined
        #expect(await appModel.canPublishAPNsRegistration() == false)

        center.status = .authorized
        #expect(await appModel.canPublishAPNsRegistration())

        UserDefaults.standard.set(false, forKey: NotificationServingPreference.storageKey)
        #expect(await appModel.canPublishAPNsRegistration() == false)
    }

    @Test @MainActor func `chat push without speech returns unavailable when notifications off`() async throws {
        let (center, appModel) = makeNotificationModel(status: .notDetermined)
        let req = try makeInvokeRequest(
            id: "chat-push-off",
            command: OpenClawChatCommand.push.rawValue,
            params: OpenClawChatPushParams(text: "Build finished", speak: false))

        let res = await appModel.handleInvoke(req)

        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message == "NOT_AUTHORIZED: notifications")
        #expect(center.addCalls == 0)
    }

    @Test @MainActor func `chat push schedules when notifications are already allowed`() async throws {
        let restorePreference = overrideNotificationServingPreference(true)
        defer { restorePreference() }
        let (center, appModel) = makeNotificationModel(status: .authorized)
        let req = try makeInvokeRequest(
            id: "chat-push-on",
            command: OpenClawChatCommand.push.rawValue,
            params: OpenClawChatPushParams(text: "Build finished", speak: false))

        let res = await appModel.handleInvoke(req)

        #expect(res.ok)
        #expect(center.addCalls == 1)
    }

    @Test @MainActor func `handle invoke rejects invalid screen format`() async {
        let appModel = NodeAppModel()
        let params = OpenClawScreenRecordParams(format: "gif")
        let data = try? JSONEncoder().encode(params)
        let json = data.flatMap { String(data: $0, encoding: .utf8) }

        let req = BridgeInvokeRequest(
            id: "screen",
            command: OpenClawScreenCommand.record.rawValue,
            paramsJSON: json)

        let res = await appModel.handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.message.contains("screen format must be mp4") == true)
    }

    @Test @MainActor func `handle invoke unknown command returns invalid request`() async {
        let appModel = NodeAppModel()
        let req = BridgeInvokeRequest(id: "unknown", command: "nope")
        let res = await appModel.handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .invalidRequest)
    }

    @Test @MainActor func `handle invoke watch status returns service snapshot`() async throws {
        let watchService = MockWatchMessagingService()
        watchService.currentStatus = WatchMessagingStatus(
            supported: true,
            paired: true,
            appInstalled: true,
            reachable: false,
            activationState: "inactive")
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let req = BridgeInvokeRequest(id: "watch-status", command: OpenClawWatchCommand.status.rawValue)

        let res = await appModel.handleInvoke(req)
        #expect(res.ok == true)

        let payloadData = try #require(res.payloadJSON?.data(using: .utf8))
        let payload = try JSONDecoder().decode(OpenClawWatchStatusPayload.self, from: payloadData)
        #expect(payload.supported == true)
        #expect(payload.reachable == false)
        #expect(payload.activationState == "inactive")
    }

    @Test @MainActor func `watch status refresh publishes service snapshot`() async {
        let watchService = MockWatchMessagingService()
        let status = WatchMessagingStatus(
            supported: true,
            paired: true,
            appInstalled: true,
            reachable: false,
            activationState: "activated")
        watchService.currentStatus = status
        let appModel = NodeAppModel(watchMessagingService: watchService)

        await appModel.refreshWatchMessagingStatus()

        #expect(appModel.watchMessagingStatus == status)
    }

    @Test @MainActor func `watch status callback publishes reachability changes`() async {
        let (watchService, appModel) = makeWatchModel()
        let status = WatchMessagingStatus(
            supported: true,
            paired: true,
            appInstalled: true,
            reachable: true,
            activationState: "activated")

        watchService.emitStatus(status)
        await waitForMainActorWork { appModel.watchMessagingStatus == status }

        #expect(appModel.watchMessagingStatus == status)
    }

    @Test @MainActor func `handle invoke watch notify routes to watch service`() async throws {
        let watchService = MockWatchMessagingService()
        watchService.nextSendResult = WatchNotificationSendResult(
            deliveredImmediately: false,
            queuedForDelivery: true,
            transport: "transferUserInfo")
        let appModel = NodeAppModel(watchMessagingService: watchService)
        appModel.connectedGatewayID = "gateway-watch-notify"
        let params = OpenClawWatchNotifyParams(
            title: "OpenClaw",
            body: "Meeting with Peter is at 4pm",
            priority: .timeSensitive)
        let req = try makeInvokeRequest(
            id: "watch-notify",
            command: OpenClawWatchCommand.notify.rawValue,
            params: params)

        let res = await appModel.handleInvoke(req, gatewayStableID: "gateway-a")
        #expect(res.ok == true)
        #expect(watchService.lastSent?.params.title == "OpenClaw")
        #expect(watchService.lastSent?.params.body == "Meeting with Peter is at 4pm")
        #expect(watchService.lastSent?.params.priority == .timeSensitive)
        #expect(watchService.lastSent?.gatewayStableID == "gateway-watch-notify")

        let payloadData = try #require(res.payloadJSON?.data(using: .utf8))
        let payload = try JSONDecoder().decode(OpenClawWatchNotifyPayload.self, from: payloadData)
        #expect(payload.deliveredImmediately == false)
        #expect(payload.queuedForDelivery == true)
        #expect(payload.transport == "transferUserInfo")
    }

    @Test @MainActor func `watch reply codec preserves prompt gateway owner`() throws {
        let params = OpenClawWatchNotifyParams(
            title: "Approval",
            body: "Allow?",
            promptId: "prompt-a",
            sessionKey: "ios-a",
            gatewayStableID: "gateway-a")
        let notification = WatchMessagingPayloadCodec.encodeNotificationPayload(
            id: "notification-a",
            params: params,
            gatewayStableID: "gateway-a")
        #expect(notification["gatewayStableID"] as? String == "gateway-a")

        let reply = try #require(WatchMessagingPayloadCodec.parseQuickReplyPayload([
            "type": OpenClawWatchPayloadType.reply.rawValue,
            "replyId": "reply-a",
            "promptId": "prompt-a",
            "actionId": "approve",
            "gatewayStableID": "gateway-a",
        ], transport: "sendMessage"))
        #expect(reply.gatewayStableID == "gateway-a")
    }

    @Test @MainActor func `watch exec approval codec preserves gateway owner`() throws {
        let approval = OpenClawWatchExecApprovalItem(
            id: "approval-a",
            gatewayStableID: "gateway-a",
            commandText: "echo safe",
            warningText: "Review shell expansion",
            allowedDecisions: [.allowOnce, .deny])
        let prompt = WatchMessagingPayloadCodec.encodeExecApprovalPromptPayload(
            OpenClawWatchExecApprovalPromptMessage(approval: approval))
        let encodedApproval = try #require(prompt["approval"] as? [String: Any])
        #expect(encodedApproval["gatewayStableID"] as? String == "gateway-a")
        #expect(encodedApproval["warningText"] as? String == "Review shell expansion")

        let reply = try #require(WatchMessagingPayloadCodec.parseExecApprovalResolvePayload([
            "type": OpenClawWatchPayloadType.execApprovalResolve.rawValue,
            "replyId": "reply-a",
            "approvalId": "approval-a",
            "gatewayStableID": "gateway-a",
            "decision": OpenClawWatchExecApprovalDecision.allowOnce.rawValue,
        ], transport: "sendMessage"))
        #expect(reply.gatewayStableID == "gateway-a")

        let resolved = WatchMessagingPayloadCodec.encodeExecApprovalResolvedPayload(
            OpenClawWatchExecApprovalResolvedMessage(
                approvalId: "approval-a",
                gatewayStableID: "gateway-a",
                outcome: .allowedAlways,
                outcomeText: "This approval was already set to Always Allow."))
        let expired = WatchMessagingPayloadCodec.encodeExecApprovalExpiredPayload(
            OpenClawWatchExecApprovalExpiredMessage(
                approvalId: "approval-a",
                gatewayStableID: "gateway-a",
                reason: .notFound))
        #expect(resolved["gatewayStableID"] as? String == "gateway-a")
        #expect(resolved["outcome"] as? String == "allowedAlways")
        #expect(resolved["outcomeText"] as? String == "This approval was already set to Always Allow.")
        #expect(expired["gatewayStableID"] as? String == "gateway-a")

        let requestID = "\u{0085}snapshot-request-a"
        let heldApprovalID = "\u{0085}held-approval-a\u{0085}"
        let activeResolutionAttemptID = "\u{0085}resolution-attempt-a\u{0085}"
        let snapshotRequest = try #require(
            WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload([
                "type": OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue,
                "requestId": requestID,
                "gatewayStableID": "gateway-a",
                "heldApprovals": [
                    [
                        "approvalId": heldApprovalID,
                        "activeResolutionAttemptId": activeResolutionAttemptID,
                    ],
                    ["approvalId": "held-approval-b"],
                ],
            ], transport: "sendMessage"))
        #expect(Array(snapshotRequest.requestId.utf8) == Array(requestID.utf8))
        #expect(snapshotRequest.gatewayStableID == "gateway-a")
        #expect(snapshotRequest.heldApprovals.count == 2)
        #expect(Array(snapshotRequest.heldApprovals[0].approvalId.utf8) == Array(heldApprovalID.utf8))
        #expect(try Array(#require(snapshotRequest.heldApprovals[0].activeResolutionAttemptId).utf8) ==
            Array(activeResolutionAttemptID.utf8))
        #expect(snapshotRequest.heldApprovals[1].activeResolutionAttemptId == nil)

        let snapshot = WatchMessagingPayloadCodec.encodeExecApprovalSnapshotPayload(
            OpenClawWatchExecApprovalSnapshotMessage(
                approvals: [approval],
                gatewayStableID: "gateway-a",
                requestId: requestID,
                requestGatewayStableID: "gateway-a"))
        #expect(try Array(#require(snapshot["requestId"] as? String).utf8) == Array(requestID.utf8))
        #expect(snapshot["requestGatewayStableID"] as? String == "gateway-a")

        let legacySnapshot = try JSONDecoder().decode(
            OpenClawWatchExecApprovalSnapshotMessage.self,
            from: Data(#"{"type":"watch.execApproval.snapshot","approvals":[]}"#.utf8))
        #expect(legacySnapshot.requestId == nil)
        #expect(legacySnapshot.requestGatewayStableID == nil)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(
                OpenClawWatchExecApprovalSnapshotRequestMessage.self,
                from: Data(#"{"type":"watch.execApproval.snapshotRequest","requestId":"legacy"}"#.utf8))
        }
        // Shipped Watch binaries request snapshots with neither requestId nor heldApprovals.
        let shippedShapeRequest = try #require(
            WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload([
                "type": OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue,
            ], transport: "sendMessage"))
        #expect(!shippedShapeRequest.requestId.isEmpty)
        #expect(shippedShapeRequest.heldApprovals.isEmpty)
        #expect(shippedShapeRequest.gatewayStableID == nil)
        let missingHeldApprovalsRequest = try #require(
            WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload([
                "type": OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue,
                "requestId": "missing-held-approvals",
            ], transport: "applicationContext"))
        #expect(missingHeldApprovalsRequest.requestId == "missing-held-approvals")
        #expect(missingHeldApprovalsRequest.heldApprovals.isEmpty)
        let missingRequestIdRequest = try #require(
            WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload([
                "type": OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue,
                "heldApprovals": [],
            ], transport: "applicationContext"))
        #expect(!missingRequestIdRequest.requestId.isEmpty)
        let emptyRequestIdRequest = try #require(
            WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload([
                "type": OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue,
                "requestId": "",
                "heldApprovals": [],
            ], transport: "applicationContext"))
        #expect(!emptyRequestIdRequest.requestId.isEmpty)
        // A present heldApprovals key keeps strict rejection when malformed.
        #expect(WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload([
            "type": OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue,
            "requestId": "malformed-held-approvals-shape",
            "heldApprovals": "not-an-array",
        ], transport: "applicationContext") == nil)
        #expect(WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload([
            "type": OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue,
            "requestId": "malformed-held-approval",
            "heldApprovals": [
                ["approvalId": "valid"],
                ["approvalId": ""],
            ],
        ], transport: "applicationContext") == nil)
        #expect(WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload([
            "type": OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue,
            "requestId": "malformed-attempt",
            "heldApprovals": [[
                "approvalId": "valid",
                "activeResolutionAttemptId": "",
            ]],
        ], transport: "applicationContext") == nil)
    }

    @Test @MainActor func `watch exec approval codec round trips exact opaque identifiers`() throws {
        let approvalID = "\u{0085}approval-a\u{0085}"
        let gatewayID = "\u{0085}gateway-a\u{0085}"
        let replyID = "\u{0085}reply-e\u{0301}\u{0085}"
        let prompt = WatchMessagingPayloadCodec.encodeExecApprovalPromptPayload(
            OpenClawWatchExecApprovalPromptMessage(approval: OpenClawWatchExecApprovalItem(
                id: approvalID,
                gatewayStableID: gatewayID,
                commandText: "echo exact",
                allowedDecisions: [.allowOnce, .deny])))
        let encodedApproval = try #require(prompt["approval"] as? [String: Any])
        let encodedApprovalID = try #require(encodedApproval["id"] as? String)
        let encodedGatewayID = try #require(encodedApproval["gatewayStableID"] as? String)
        let reply = try #require(WatchMessagingPayloadCodec.parseExecApprovalResolvePayload([
            "type": OpenClawWatchPayloadType.execApprovalResolve.rawValue,
            "replyId": replyID,
            "approvalId": encodedApprovalID,
            "gatewayStableID": encodedGatewayID,
            "decision": OpenClawWatchExecApprovalDecision.allowOnce.rawValue,
        ], transport: "sendMessage"))

        #expect(Array(reply.replyId.utf8) == Array(replyID.utf8))
        #expect(Array(reply.approvalId.utf8) == Array(approvalID.utf8))
        #expect(try Array(#require(reply.gatewayStableID).utf8) == Array(gatewayID.utf8))
    }

    @Test @MainActor func `watch direct node setup codec carries opaque setup code`() {
        let payload = WatchMessagingPayloadCodec.encodeDirectNodeSetupPayload(
            setupCode: "opaque-bootstrap-code")

        #expect(payload["type"] as? String == OpenClawWatchPayloadType.directNodeSetup.rawValue)
        #expect(payload["setupCode"] as? String == "opaque-bootstrap-code")
        #expect(payload["sentAtMs"] is Int64)
        #expect(payload["token"] == nil)
        #expect(payload["password"] == nil)
    }

    @Test @MainActor func `watch payload codec preserves 64 bit epoch milliseconds`() throws {
        let sentAtMs: Int64 = 1_725_000_000_123
        let encodedTimestamp = NSNumber(value: sentAtMs)

        let reply = try #require(WatchMessagingPayloadCodec.parseQuickReplyPayload([
            "type": OpenClawWatchPayloadType.reply.rawValue,
            "actionId": "approve",
            "sentAtMs": encodedTimestamp,
        ], transport: "sendMessage"))
        let resolution = try #require(WatchMessagingPayloadCodec.parseExecApprovalResolvePayload([
            "type": OpenClawWatchPayloadType.execApprovalResolve.rawValue,
            "approvalId": "approval-a",
            "decision": OpenClawWatchExecApprovalDecision.allowOnce.rawValue,
            "sentAtMs": encodedTimestamp,
        ], transport: "sendMessage"))
        let approvalSnapshotRequest = try #require(
            WatchMessagingPayloadCodec.parseExecApprovalSnapshotRequestPayload([
                "type": OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue,
                "requestId": "timestamp-request",
                "sentAtMs": encodedTimestamp,
                "heldApprovals": [],
            ], transport: "sendMessage"))
        let appSnapshotRequest = try #require(WatchMessagingPayloadCodec.parseAppSnapshotRequestPayload([
            "type": OpenClawWatchPayloadType.appSnapshotRequest.rawValue,
            "sentAtMs": encodedTimestamp,
        ], transport: "sendMessage"))
        let appCommand = try #require(WatchMessagingPayloadCodec.parseAppCommandPayload([
            "type": OpenClawWatchPayloadType.appCommand.rawValue,
            "command": OpenClawWatchAppCommand.refresh.rawValue,
            "sentAtMs": encodedTimestamp,
        ], transport: "sendMessage"))

        #expect(reply.sentAtMs == sentAtMs)
        #expect(resolution.sentAtMs == sentAtMs)
        #expect(approvalSnapshotRequest.sentAtMs == sentAtMs)
        #expect(appSnapshotRequest.sentAtMs == sentAtMs)
        #expect(appCommand.sentAtMs == sentAtMs)
    }

    @Test @MainActor func `watch application context retains app and approval snapshots`() throws {
        let appPayload = WatchMessagingPayloadCodec.encodeAppSnapshotPayload(
            OpenClawWatchAppSnapshotMessage(
                gatewayStatus: OpenClawWatchAppStatus(code: .gatewayConnected),
                gatewayStatusText: "Connected",
                gatewayConnected: true,
                agentName: "Main",
                agentAvatarURL: "https://example.com/avatar.png",
                sessionKey: "main",
                gatewayStableID: "gateway-a",
                talkStatus: OpenClawWatchAppStatus(code: .talkOff),
                talkStatusText: "Off",
                talkEnabled: false,
                talkListening: false,
                talkSpeaking: false,
                pendingApprovalCount: 1,
                chatStatus: OpenClawWatchAppStatus(code: .chatConnectIPhone),
                chatStatusText: "Connect iPhone chat to read messages",
                snapshotId: "app-a"))
        let approvalPayload = WatchMessagingPayloadCodec.encodeExecApprovalSnapshotPayload(
            OpenClawWatchExecApprovalSnapshotMessage(
                approvals: [
                    OpenClawWatchExecApprovalItem(
                        id: "approval-a",
                        gatewayStableID: "gateway-a",
                        commandText: "echo safe",
                        warningText: "Review shell expansion",
                        allowedDecisions: [.allowOnce, .deny]),
                ],
                gatewayStableID: "gateway-a",
                snapshotId: "approval-a"))

        let appContext = WatchMessagingPayloadCodec.encodeSnapshotApplicationContext(
            appPayload,
            merging: [:])
        let combined = WatchMessagingPayloadCodec.encodeSnapshotApplicationContext(
            approvalPayload,
            merging: appContext)

        #expect(combined["type"] as? String == OpenClawWatchPayloadType.execApprovalSnapshot.rawValue)
        let nestedApp = try #require(
            combined[OpenClawWatchPayloadType.appSnapshot.rawValue] as? [String: Any])
        let nestedApprovals = try #require(
            combined[OpenClawWatchPayloadType.execApprovalSnapshot.rawValue] as? [String: Any])
        #expect(nestedApp["gatewayStableID"] as? String == "gateway-a")
        #expect(nestedApp["agentAvatarUrl"] as? String == "https://example.com/avatar.png")
        #expect(nestedApp["agentAvatarURL"] == nil)
        let nestedChatStatus = try #require(nestedApp["chatStatus"] as? [String: Any])
        #expect(nestedChatStatus["code"] as? String == "chatConnectIPhone")
        #expect(nestedApp["chatStatusCode"] == nil)
        #expect(nestedApp["snapshotId"] as? String == "app-a")
        #expect(nestedApprovals["snapshotId"] as? String == "approval-a")
        #expect(nestedApprovals["gatewayStableID"] as? String == "gateway-a")
        #expect((nestedApprovals["approvals"] as? [Any])?.count == 1)
        let nestedApproval = try #require((nestedApprovals["approvals"] as? [[String: Any]])?.first)
        #expect(nestedApproval["warningText"] as? String == "Review shell expansion")
    }

    @Test @MainActor func `handle invoke watch notify rejects empty message`() async throws {
        let (watchService, appModel) = makeWatchModel()
        let params = OpenClawWatchNotifyParams(title: "   ", body: "\n")
        let req = try makeInvokeRequest(
            id: "watch-notify-empty",
            command: OpenClawWatchCommand.notify.rawValue,
            params: params)

        let res = await appModel.handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .invalidRequest)
        #expect(watchService.lastSent == nil)
    }

    @Test @MainActor func `handle invoke watch notify adds default actions for prompt`() async throws {
        let (watchService, appModel) = makeWatchModel()
        let params = OpenClawWatchNotifyParams(
            title: "Task",
            body: "Action needed",
            priority: .passive,
            promptId: "prompt-123")
        let req = try makeInvokeRequest(
            id: "watch-notify-default-actions",
            command: OpenClawWatchCommand.notify.rawValue,
            params: params)

        let res = await appModel.handleInvoke(req)
        #expect(res.ok == true)
        #expect(watchService.lastSent?.params.risk == .low)
        let actionIDs = watchService.lastSent?.params.actions?.map(\.id)
        #expect(actionIDs == ["done", "snooze_10m", "open_phone", "escalate"])
    }

    @Test @MainActor func `legacy watch reply binds to latest prompt owner`() async throws {
        let (watchService, appModel) = makeWatchModel()
        appModel.connectedGatewayID = "gateway-a"
        let params = OpenClawWatchNotifyParams(
            title: "Task",
            body: "Action needed",
            promptId: "prompt-legacy")
        let request = try makeInvokeRequest(
            id: "watch-notify-legacy-owner",
            command: OpenClawWatchCommand.notify.rawValue,
            params: params)
        #expect(await appModel.handleInvoke(request, gatewayStableID: "gateway-a").ok)

        watchService.emitReply(WatchQuickReplyEvent(
            replyId: "legacy-reply",
            promptId: "prompt-legacy",
            actionId: "done",
            actionLabel: "Done",
            sessionKey: nil,
            gatewayStableID: nil,
            note: nil,
            sentAtMs: 1234,
            transport: "transferUserInfo"))
        await Task.yield()

        #expect(appModel.watchMessageOutbox.queuedCount(kind: .quickReply) == 1)
    }

    @Test @MainActor func `handle invoke watch notify adds approval defaults`() async throws {
        let (watchService, appModel) = makeWatchModel()
        let params = OpenClawWatchNotifyParams(
            title: "Approval",
            body: "Allow command?",
            promptId: "prompt-approval",
            kind: "approval")
        let req = try makeInvokeRequest(
            id: "watch-notify-approval-defaults",
            command: OpenClawWatchCommand.notify.rawValue,
            params: params)

        let res = await appModel.handleInvoke(req)
        #expect(res.ok == true)
        let actionIDs = watchService.lastSent?.params.actions?.map(\.id)
        #expect(actionIDs == ["approve", "decline", "open_phone", "escalate"])
        #expect(watchService.lastSent?.params.actions?[1].style == "destructive")
    }

    @Test @MainActor func `handle invoke watch notify derives priority from risk and caps actions`() async throws {
        let (watchService, appModel) = makeWatchModel()
        let params = OpenClawWatchNotifyParams(
            title: "Urgent",
            body: "Check now",
            risk: .high,
            actions: [
                OpenClawWatchAction(id: "a1", label: "A1"),
                OpenClawWatchAction(id: "a2", label: "A2"),
                OpenClawWatchAction(id: "a3", label: "A3"),
                OpenClawWatchAction(id: "a4", label: "A4"),
                OpenClawWatchAction(id: "a5", label: "A5"),
            ])
        let req = try makeInvokeRequest(
            id: "watch-notify-derive-priority",
            command: OpenClawWatchCommand.notify.rawValue,
            params: params)

        let res = await appModel.handleInvoke(req)
        #expect(res.ok == true)
        #expect(watchService.lastSent?.params.priority == .timeSensitive)
        #expect(watchService.lastSent?.params.risk == .high)
        let actionIDs = watchService.lastSent?.params.actions?.map(\.id)
        #expect(actionIDs == ["a1", "a2", "a3", "a4"])
    }

    @Test @MainActor func `handle invoke watch notify returns unavailable on delivery failure`() async throws {
        let watchService = MockWatchMessagingService()
        watchService.sendError = NSError(
            domain: "watch",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "WATCH_UNAVAILABLE: no paired Apple Watch"])
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(title: "OpenClaw", body: "Delivery check")
        let req = try makeInvokeRequest(
            id: "watch-notify-fail",
            command: OpenClawWatchCommand.notify.rawValue,
            params: params)

        let res = await appModel.handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message.contains("WATCH_UNAVAILABLE") == true)
    }

    @Test @MainActor func `watch reply queues when gateway offline`() async {
        WatchMessageOutbox.resetPersistedQueue()
        defer { WatchMessageOutbox.resetPersistedQueue() }
        let (watchService, appModel) = makeWatchModel()
        appModel.connectedGatewayID = "gateway-watch-reply"
        watchService.emitReply(
            WatchQuickReplyEvent(
                replyId: "reply-offline-1",
                promptId: "prompt-1",
                actionId: "approve",
                actionLabel: "Approve",
                sessionKey: "ios",
                gatewayStableID: "gateway-watch-reply",
                note: nil,
                sentAtMs: 1234,
                transport: "transferUserInfo"))
        await Task.yield()
        #expect(appModel.watchMessageOutbox.queuedCount(kind: .quickReply) == 1)
    }

    @Test @MainActor func `watch chat and reply preserve boundary whitespace gateway owner`() async {
        WatchMessageOutbox.resetPersistedQueue()
        defer { WatchMessageOutbox.resetPersistedQueue() }
        let gatewayID = " gateway-boundary "
        let (watchService, appModel) = makeWatchModel()
        appModel.connectedGatewayID = gatewayID

        watchService.emitAppCommand(makeWatchAppCommand(
            "watch-boundary-chat",
            .sendChat,
            gateway: gatewayID,
            text: "Keep exact owner",
            sentAt: 1))
        watchService.emitReply(WatchQuickReplyEvent(
            replyId: "watch-boundary-reply",
            promptId: "watch-boundary-prompt",
            actionId: "approve",
            actionLabel: "Approve",
            sessionKey: "main",
            gatewayStableID: gatewayID,
            note: nil,
            sentAtMs: 2,
            transport: "sendMessage"))
        await waitForMainActorWork { appModel.watchMessageOutbox.queuedCount(kind: .quickReply) == 1 }

        #expect(appModel.watchMessageOutbox.queuedMessageIDs(kind: .chat) == ["watch-boundary-chat"])
        #expect(appModel.watchMessageOutbox.queuedCount(kind: .quickReply) == 1)

        watchService.emitAppCommand(makeWatchAppCommand(
            "watch-trimmed-owner-chat",
            .sendChat,
            gateway: "gateway-boundary",
            text: "Wrong owner",
            sentAt: 3))
        await Task.yield()
        #expect(appModel.watchMessageOutbox.queuedMessageIDs(kind: .chat) == ["watch-boundary-chat"])
    }

    @Test @MainActor func `watch message outbox restores queued reply after restart`() throws {
        let suiteName = "watch-reply-queue-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let event = makeWatchAppCommand(
            "reply-restore-1",
            .sendChat,
            session: "ios",
            gateway: "gateway-a",
            text: "Watch reply: Approve",
            sentAt: 1235,
            transport: "transferUserInfo",
            kind: .quickReply)
        let firstOutbox = WatchMessageOutbox(defaults: defaults)
        if case .queue = firstOutbox.ingest(event, isAvailable: false, gatewayStableID: "gateway-a") {
        } else {
            Issue.record("expected watch reply to queue")
        }

        let secondOutbox = WatchMessageOutbox(defaults: defaults)
        #expect(secondOutbox.nextQueuedMessage(isAvailable: true, gatewayStableID: "gateway-b") == nil)
        let restored = secondOutbox.nextQueuedMessage(isAvailable: true, gatewayStableID: "gateway-a")

        #expect(restored == event)
        #expect(secondOutbox.queuedCount(kind: .quickReply) == 1)
        secondOutbox.removeQueuedMessage(messageID: event.commandId, gatewayStableID: "gateway-a")
        #expect(secondOutbox.queuedCount() == 0)
    }

    @Test @MainActor func `watch message outbox restores delivery tombstones and prompt routes`() throws {
        let suiteName = "watch-message-metadata-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let event = makeWatchAppCommand(
            "delivered-reply",
            .sendChat,
            gateway: "gateway-a",
            text: "Delivered reply",
            sentAt: 1,
            kind: .quickReply)
        let firstOutbox = WatchMessageOutbox(defaults: defaults)
        firstOutbox.recordPromptRoute(promptID: "prompt-a", gatewayStableID: "gateway-a")
        _ = firstOutbox.ingest(event, isAvailable: true, gatewayStableID: "gateway-a")
        firstOutbox.removeQueuedMessage(messageID: event.commandId, gatewayStableID: "gateway-a")
        for index in 0..<140 {
            let pending = makeWatchAppCommand(
                "pending-\(index)",
                .sendChat,
                gateway: "gateway-a",
                text: "Pending \(index)",
                sentAt: Int64(index + 2),
                transport: "transferUserInfo")
            _ = firstOutbox.ingest(pending, isAvailable: false, gatewayStableID: "gateway-a")
        }

        let restoredOutbox = WatchMessageOutbox(defaults: defaults)
        #expect(restoredOutbox.gatewayStableID(forPromptID: "prompt-a") == "gateway-a")
        if case .deduped = restoredOutbox.ingest(
            event,
            isAvailable: true,
            gatewayStableID: "gateway-a")
        {
        } else {
            Issue.record("expected delivered reply to remain deduped after restart")
        }
    }

    @Test @MainActor func `watch message outbox tombstone rejects stale persisted queue`() throws {
        let suiteName = "watch-message-stale-queue-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let event = makeWatchAppCommand(
            "delivered-before-crash",
            .sendChat,
            gateway: "gateway-a",
            text: "Delivered reply",
            sentAt: 1,
            kind: .quickReply)
        let firstOutbox = WatchMessageOutbox(defaults: defaults)
        _ = firstOutbox.ingest(event, isAvailable: true, gatewayStableID: "gateway-a")
        let staleQueue = try #require(defaults.data(forKey: "watch.chat.command.queue.v1"))
        firstOutbox.removeQueuedMessage(messageID: event.commandId, gatewayStableID: "gateway-a")

        // Simulate termination after the delivery tombstone persisted but before
        // the older queue snapshot was removed.
        defaults.set(staleQueue, forKey: "watch.chat.command.queue.v1")
        let restoredOutbox = WatchMessageOutbox(defaults: defaults)

        #expect(restoredOutbox.queuedCount() == 0)
        if case .deduped = restoredOutbox.ingest(
            event,
            isAvailable: true,
            gatewayStableID: "gateway-a")
        {
        } else {
            Issue.record("expected the delivery tombstone to reject the stale queue row")
        }
    }

    @Test @MainActor func `watch reply drops stale gateway target`() async {
        WatchMessageOutbox.resetPersistedQueue()
        defer { WatchMessageOutbox.resetPersistedQueue() }
        let (watchService, appModel) = makeWatchModel()
        appModel.connectedGatewayID = "gateway-current"

        watchService.emitReply(
            WatchQuickReplyEvent(
                replyId: "reply-stale-gateway",
                promptId: "prompt-stale",
                actionId: "approve",
                actionLabel: "Approve",
                sessionKey: "ios",
                gatewayStableID: "gateway-old",
                note: nil,
                sentAtMs: 1236,
                transport: "transferUserInfo"))
        await Task.yield()

        #expect(appModel.watchMessageOutbox.queuedCount(kind: .quickReply) == 0)
        #expect(appModel.openChatRequestID == 0)
    }

    @Test @MainActor func `watch reply uses idempotent chat outbox`() async {
        WatchMessageOutbox.resetPersistedQueue()
        defer { WatchMessageOutbox.resetPersistedQueue() }
        let (watchService, appModel) = makeWatchModel()
        appModel.enterAppleReviewDemoMode()
        appModel.watchMessageOutbox.recordPromptRoute(
            promptID: "prompt-idempotent",
            gatewayStableID: AppleReviewDemoMode.gatewayID)
        let initialOpenChatRequestID = appModel.openChatRequestID
        let event = WatchQuickReplyEvent(
            replyId: "reply-idempotent",
            promptId: "prompt-idempotent",
            actionId: "approve",
            actionLabel: "Approve",
            sessionKey: "main",
            gatewayStableID: nil,
            note: nil,
            sentAtMs: 1237,
            transport: "sendMessage")

        watchService.emitReply(event)
        await waitForMainActorWork { appModel.openChatRequestID == initialOpenChatRequestID + 1 }
        watchService.emitReply(event)
        await waitForMainActorWork { appModel.watchMessageOutbox.queuedCount(kind: .quickReply) == 0 }

        #expect(appModel.openChatRequestID == initialOpenChatRequestID + 1)
        #expect(appModel.watchMessageOutbox.queuedCount(kind: .quickReply) == 0)
    }

    @Test @MainActor func `watch reply rejects legacy prompt without a gateway owner`() async {
        WatchMessageOutbox.resetPersistedQueue()
        defer { WatchMessageOutbox.resetPersistedQueue() }
        let (watchService, appModel) = makeWatchModel()
        appModel.enterAppleReviewDemoMode()
        let initialOpenChatRequestID = appModel.openChatRequestID
        let event = WatchQuickReplyEvent(
            replyId: "reply-legacy-prompt",
            promptId: "prompt-from-previous-release",
            actionId: "approve",
            actionLabel: "Approve",
            sessionKey: "main",
            gatewayStableID: nil,
            note: nil,
            sentAtMs: 1238,
            transport: "sendMessage")

        watchService.emitReply(event)
        await Task.yield()
        watchService.emitReply(event)
        await Task.yield()

        #expect(appModel.openChatRequestID == initialOpenChatRequestID)
        #expect(appModel.watchMessageOutbox.queuedCount(kind: .quickReply) == 0)
    }

    @Test @MainActor func `handle deep link records failure when not connected`() async throws {
        let appModel = NodeAppModel()
        let url = try #require(URL(string: "openclaw://agent?message=hello"))
        await appModel.handleDeepLink(url: url)
        #expect(appModel.lastShareEventText.contains("gateway not connected"))
    }

    @Test @MainActor func `handle deep link records oversized message rejection`() async throws {
        let appModel = NodeAppModel()
        let msg = String(repeating: "a", count: 20001)
        let url = try #require(URL(string: "openclaw://agent?message=\(msg)"))
        await appModel.handleDeepLink(url: url)
        #expect(appModel.lastShareEventText.contains("message too large"))
    }

    @Test @MainActor func `handle deep link requires confirmation when connected and unkeyed`() async {
        let appModel = NodeAppModel()
        appModel.gatewayConnected = true
        appModel.testAgentRequestHandler = { _ in }
        let url = makeAgentDeepLinkURL(message: "hello from deep link")

        await appModel.handleDeepLink(url: url)
        #expect(appModel.pendingAgentDeepLinkPrompt != nil)
        #expect(appModel.openChatRequestID == 0)

        await appModel.approvePendingAgentDeepLinkPrompt()
        #expect(appModel.pendingAgentDeepLinkPrompt == nil)
        #expect(appModel.openChatRequestID == 1)
        #expect(appModel.lastShareEventText.contains("Sent to gateway"))
    }

    @Test @MainActor func `handle deep link coalesces prompt when rate limited`() async throws {
        let appModel = NodeAppModel()
        appModel.gatewayConnected = true

        await appModel.handleDeepLink(url: makeAgentDeepLinkURL(message: "first prompt"))
        let firstPrompt = try #require(appModel.pendingAgentDeepLinkPrompt)

        await appModel.handleDeepLink(url: makeAgentDeepLinkURL(message: "second prompt"))
        let coalescedPrompt = try #require(appModel.pendingAgentDeepLinkPrompt)

        #expect(coalescedPrompt.id != firstPrompt.id)
        #expect(coalescedPrompt.messagePreview.contains("second prompt"))
    }

    @Test @MainActor func `handle deep link strips delivery fields when unkeyed`() async throws {
        let appModel = NodeAppModel()
        appModel.gatewayConnected = true
        let url = makeAgentDeepLinkURL(
            message: "route this",
            deliver: true,
            to: "123456",
            channel: "telegram")

        await appModel.handleDeepLink(url: url)
        let prompt = try #require(appModel.pendingAgentDeepLinkPrompt)
        #expect(prompt.request.deliver == false)
        #expect(prompt.request.to == nil)
        #expect(prompt.request.channel == nil)
    }

    @Test @MainActor func `handle deep link rejects long unkeyed message when connected`() async {
        let appModel = NodeAppModel()
        appModel.gatewayConnected = true
        let message = String(repeating: "x", count: 241)
        let url = makeAgentDeepLinkURL(message: message)

        await appModel.handleDeepLink(url: url)
        #expect(appModel.pendingAgentDeepLinkPrompt == nil)
        #expect(appModel.lastShareEventText.contains("Rejected"))
    }

    @Test @MainActor func `handle deep link bypasses prompt with valid key`() async {
        let appModel = NodeAppModel()
        appModel.gatewayConnected = true
        appModel.testAgentRequestHandler = { _ in }
        let key = NodeAppModel.expectedDeepLinkKey()
        let url = makeAgentDeepLinkURL(message: "trusted request", key: key)

        await appModel.handleDeepLink(url: url)
        #expect(appModel.pendingAgentDeepLinkPrompt == nil)
        #expect(appModel.openChatRequestID == 1)
        #expect(appModel.lastShareEventText.contains("Sent to gateway"))
    }

    @Test @MainActor func `operator scopes use the active gateway token`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let stableID = "manual|gateway.example.com|443"
        let authenticationOwnerID = stableID
        let config = try GatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: stableID,
            tls: nil,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "node",
                clientDisplayName: nil,
                deviceAuthGatewayID: authenticationOwnerID))
        appModel.applyGatewayConnectConfig(config)
        let identity = DeviceIdentityStore.loadOrCreate()
        #expect(appModel.hasOperatorAdminScope == false)

        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "operator-token",
            scopes: ["operator.read", "operator.admin", "operator.approvals"],
            gatewayID: authenticationOwnerID)
        appModel.refreshOperatorAdminScopeFromStore()
        #expect(appModel.hasOperatorAdminScope == true)
        #expect(appModel._test_shouldRequestStoredOperatorAdminScope(gatewayID: authenticationOwnerID))
        #expect(appModel._test_shouldRequestStoredOperatorApprovalScope(
            gatewayID: authenticationOwnerID,
            forceTalkPermissionUpgradeRequest: true))

        let otherStableID = "manual|other.example.com|443"
        #expect(!appModel._test_shouldRequestStoredOperatorAdminScope(gatewayID: otherStableID))
        #expect(!appModel._test_shouldRequestStoredOperatorApprovalScope(
            gatewayID: otherStableID,
            forceTalkPermissionUpgradeRequest: true))

        DeviceAuthStore.clearToken(
            deviceId: identity.deviceId,
            role: "operator",
            gatewayID: authenticationOwnerID)
        appModel.refreshOperatorAdminScopeFromStore()
        #expect(appModel.hasOperatorAdminScope == false)
    }

    @Test @MainActor func `send voice transcript throws when gateway offline`() async {
        let appModel = NodeAppModel()
        await #expect(throws: Error.self) {
            try await appModel.sendVoiceTranscript(text: "hello", sessionKey: "main")
        }
    }
}
