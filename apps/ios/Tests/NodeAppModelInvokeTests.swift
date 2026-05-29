import Foundation
import OpenClawKit
import Testing
import UIKit
import UserNotifications
@testable import OpenClaw

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

@MainActor
private func mountScreen(_ screen: ScreenController) throws -> ScreenWebViewCoordinator {
    let coordinator = ScreenWebViewCoordinator(controller: screen)
    _ = coordinator.makeContainerView()
    _ = try #require(coordinator.managedWebView)
    return coordinator
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
    var lastSent: (id: String, params: OpenClawWatchNotifyParams)?
    var lastSentExecApprovalPrompt: OpenClawWatchExecApprovalPromptMessage?
    var lastSentExecApprovalResolved: OpenClawWatchExecApprovalResolvedMessage?
    var lastSentExecApprovalExpired: OpenClawWatchExecApprovalExpiredMessage?
    var lastSentExecApprovalSnapshot: OpenClawWatchExecApprovalSnapshotMessage?
    private var statusHandler: (@Sendable (WatchMessagingStatus) -> Void)?
    private var replyHandler: (@Sendable (WatchQuickReplyEvent) -> Void)?
    private var execApprovalResolveHandler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?
    private var execApprovalSnapshotRequestHandler: (@Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?

    func status() async -> WatchMessagingStatus {
        self.currentStatus
    }

    func setStatusHandler(_ handler: (@Sendable (WatchMessagingStatus) -> Void)?) {
        self.statusHandler = handler
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

    func sendNotification(id: String, params: OpenClawWatchNotifyParams) async throws -> WatchNotificationSendResult {
        self.lastSent = (id: id, params: params)
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func sendExecApprovalPrompt(
        _ message: OpenClawWatchExecApprovalPromptMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentExecApprovalPrompt = message
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
}

private final class MockBootstrapNotificationCenter: NotificationCentering, @unchecked Sendable {
    var status: NotificationAuthorizationStatus = .notDetermined
    var requestAuthorizationResult = false
    var requestAuthorizationCalls = 0

    func authorizationStatus() async -> NotificationAuthorizationStatus {
        self.status
    }

    func requestAuthorization(options _: UNAuthorizationOptions) async throws -> Bool {
        self.requestAuthorizationCalls += 1
        if self.requestAuthorizationResult {
            self.status = .authorized
        } else {
            self.status = .denied
        }
        return self.requestAuthorizationResult
    }

    func add(_: UNNotificationRequest) async throws {}

    func removePendingNotificationRequests(withIdentifiers _: [String]) async {}

    func removeDeliveredNotifications(withIdentifiers _: [String]) async {}

    func deliveredNotifications() async -> [NotificationSnapshot] {
        []
    }
}

@Suite(.serialized) struct NodeAppModelInvokeTests {
    @Test @MainActor func decodeParamsFailsWithoutJSON() {
        #expect(throws: Error.self) {
            _ = try NodeAppModel._test_decodeParams(OpenClawCanvasNavigateParams.self, from: nil)
        }
    }

    @Test @MainActor func encodePayloadEmitsJSON() throws {
        struct Payload: Codable, Equatable {
            var value: String
        }
        let json = try NodeAppModel._test_encodePayload(Payload(value: "ok"))
        #expect(json.contains("\"value\""))
    }

    @Test @MainActor func chatSessionKeyDefaultsToMainBase() {
        let appModel = NodeAppModel()
        #expect(appModel.chatSessionKey == "main")
    }

    @Test @MainActor func initPreservesSavedTalkModePreference() {
        withUserDefaults(["talk.enabled": true]) {
            let talkMode = TalkModeManager(allowSimulatorCapture: true)
            let appModel = NodeAppModel(talkMode: talkMode)

            #expect(UserDefaults.standard.bool(forKey: "talk.enabled"))
            #expect(appModel.talkMode.isEnabled)
        }
    }

    @Test @MainActor func chatSessionKeyUsesAgentScopedKeyForNonDefaultAgent() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.setSelectedAgentId("agent-123")
        #expect(appModel.chatSessionKey == SessionKey.makeAgentSessionKey(agentId: "agent-123", baseKey: "main"))
        #expect(appModel.mainSessionKey == "agent:agent-123:main")
    }

    @Test @MainActor func execApprovalPromptPresentationTracksLatestNotificationTap() throws {
        let appModel = NodeAppModel()
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-1",
                    commandText: "echo first",
                    allowedDecisions: ["allow-once", "deny"],
                    host: "gateway",
                    nodeId: nil,
                    agentId: "main",
                    expiresAtMs: 1)))

        let firstPrompt = try #require(appModel._test_pendingExecApprovalPrompt())
        #expect(firstPrompt.id == "approval-1")
        #expect(firstPrompt.commandText == "echo first")
        #expect(firstPrompt.allowsAllowAlways == false)

        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-2",
                    commandText: "echo second",
                    allowedDecisions: ["allow-once", "allow-always", "deny"],
                    host: "gateway",
                    nodeId: "node-2",
                    agentId: nil,
                    expiresAtMs: 2)))

        let secondPrompt = try #require(appModel._test_pendingExecApprovalPrompt())
        #expect(secondPrompt.id == "approval-2")
        #expect(secondPrompt.commandText == "echo second")
        #expect(secondPrompt.allowsAllowAlways)

        appModel._test_dismissPendingExecApprovalPrompt()
        #expect(appModel._test_pendingExecApprovalPrompt() == nil)
    }

    @Test @MainActor func dismissPendingExecApprovalPromptByIdLeavesDifferentPromptVisible() throws {
        let appModel = NodeAppModel()
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-active",
                    commandText: "echo keep",
                    allowedDecisions: ["allow-once", "deny"],
                    host: "gateway",
                    nodeId: nil,
                    agentId: nil,
                    expiresAtMs: 1)))

        appModel.dismissPendingExecApprovalPrompt(approvalId: "approval-stale")

        let prompt = try #require(appModel._test_pendingExecApprovalPrompt())
        #expect(prompt.id == "approval-active")
    }

    @Test @MainActor func presentingExecApprovalPromptSyncsWatchPrompt() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let prompt = try #require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-watch-sync",
                commandText: "npm publish",
                allowedDecisions: ["allow-once", "deny"],
                host: "gateway",
                nodeId: "node-1",
                agentId: "main",
                expiresAtMs: 1234))

        appModel._test_presentExecApprovalPrompt(prompt)
        await Task.yield()

        let sent = try #require(watchService.lastSentExecApprovalPrompt)
        #expect(sent.approval.id == "approval-watch-sync")
        #expect(sent.approval.allowedDecisions == [.allowOnce, .deny])
        #expect(sent.approval.host == "gateway")
        #expect(sent.approval.risk == nil)
        #expect(sent.resetResolvingState != true)
    }

    @Test @MainActor func watchExecApprovalSnapshotRequestPublishesCachedApprovalsInBackground() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let futureExpiryMs = Int(Date().timeIntervalSince1970 * 1000) + 60000
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-watch-snapshot",
                    commandText: "echo from watch",
                    allowedDecisions: ["allow-once", "deny"],
                    host: "gateway",
                    nodeId: nil,
                    agentId: nil,
                    expiresAtMs: futureExpiryMs)))
        await Task.yield()

        appModel.setScenePhase(.background)
        watchService.emitExecApprovalSnapshotRequest(
            WatchExecApprovalSnapshotRequestEvent(
                requestId: "snapshot-1",
                sentAtMs: 111,
                transport: "sendMessage"))
        await Task.yield()

        let snapshot = try #require(watchService.lastSentExecApprovalSnapshot)
        #expect(snapshot.approvals.map(\.id) == ["approval-watch-snapshot"])
    }

    @Test @MainActor func watchExecApprovalSnapshotRequestSkipsForegroundRecovery() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let futureExpiryMs = Int(Date().timeIntervalSince1970 * 1000) + 60000
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-watch-foreground-skip",
                    commandText: "echo foreground",
                    allowedDecisions: ["allow-once", "deny"],
                    host: "gateway",
                    nodeId: nil,
                    agentId: nil,
                    expiresAtMs: futureExpiryMs)))
        await Task.yield()
        watchService.lastSentExecApprovalSnapshot = nil

        watchService.emitExecApprovalSnapshotRequest(
            WatchExecApprovalSnapshotRequestEvent(
                requestId: "snapshot-foreground",
                sentAtMs: 222,
                transport: "sendMessage"))
        await Task.yield()

        #expect(watchService.lastSentExecApprovalSnapshot == nil)
    }

    @Test @MainActor func pendingWatchRecoveryIDsAreIncludedWithoutDeliveredNotifications() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }

        let appModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        appModel._test_recordPendingWatchExecApprovalRecoveryID("approval-watch-recovery")

        let ids = await appModel._test_pendingExecApprovalIDsForWatchRecovery()
        #expect(ids == ["approval-watch-recovery"])
    }

    @Test @MainActor func presentingExecApprovalPromptClearsPendingWatchRecoveryID() throws {
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
                    allowedDecisions: ["allow-once", "deny"],
                    host: "gateway",
                    nodeId: nil,
                    agentId: nil,
                    expiresAtMs: Int(Date().timeIntervalSince1970 * 1000) + 60000)))

        #expect(appModel._test_pendingWatchExecApprovalRecoveryIDs().isEmpty)
    }

    @Test func approvalNotificationErrorClassificationPrefersStructuredDetails() {
        let staleError = GatewayResponseError(
            method: "exec.approval.get",
            code: "INVALID_REQUEST",
            message: "gateway error",
            details: ["reason": AnyCodable("APPROVAL_NOT_FOUND")])
        let unavailableError = GatewayResponseError(
            method: "exec.approval.resolve",
            code: "INVALID_REQUEST",
            message: "gateway error",
            details: ["reason": AnyCodable("APPROVAL_ALLOW_ALWAYS_UNAVAILABLE")])

        #expect(NodeAppModel._test_isApprovalNotificationStaleError(staleError))
        #expect(NodeAppModel._test_isApprovalNotificationUnavailableError(unavailableError))
    }

    @Test func backgroundAwareExecApprovalReconnectCoversWatchAndPushPaths() {
        #expect(
            NodeAppModel._test_shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "watch_request",
                isBackgrounded: true))
        #expect(
            NodeAppModel._test_shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "push_request",
                isBackgrounded: true))
        #expect(
            NodeAppModel._test_shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "watch_resolve",
                isBackgrounded: true))
        #expect(
            !NodeAppModel._test_shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "direct",
                isBackgrounded: true))
        #expect(
            !NodeAppModel._test_shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "watch_request",
                isBackgrounded: false))
    }

    @Test func watchExecApprovalHydrateFetchesOnlyMissingIDs() {
        let idsToFetch = NodeAppModel._test_watchExecApprovalIDsNeedingFetch(
            candidateIDs: ["cached", "pending", "cached", "other", "", "  pending  "],
            cachedApprovalIDs: ["cached", "also-cached"])

        #expect(idsToFetch == ["pending", "other"])
    }

    @Test func watchExecApprovalRetryPromptResetsResolvingStateOnlyForRetryReason() {
        #expect(NodeAppModel._test_shouldResetWatchExecApprovalResolvingStateOnPrompt(reason: "resolve_retry"))
        #expect(!NodeAppModel._test_shouldResetWatchExecApprovalResolvingStateOnPrompt(reason: "push_request"))
        #expect(!NodeAppModel._test_shouldResetWatchExecApprovalResolvingStateOnPrompt(reason: "present_prompt"))
    }

    @Test func operatorLoopWaitsForBootstrapHandoffBeforeUsingStoredToken() {
        #expect(
            !NodeAppModel._test_shouldStartOperatorGatewayLoop(
                token: nil,
                bootstrapToken: "fresh-bootstrap-token",
                password: nil,
                hasStoredOperatorToken: true))
        #expect(
            !NodeAppModel._test_shouldStartOperatorGatewayLoop(
                token: nil,
                bootstrapToken: nil,
                password: nil,
                hasStoredOperatorToken: false))
        #expect(
            NodeAppModel._test_shouldStartOperatorGatewayLoop(
                token: nil,
                bootstrapToken: nil,
                password: nil,
                hasStoredOperatorToken: true))
        #expect(
            NodeAppModel._test_shouldStartOperatorGatewayLoop(
                token: "shared-token",
                bootstrapToken: "fresh-bootstrap-token",
                password: nil,
                hasStoredOperatorToken: false))
    }

    @Test @MainActor func successfulBootstrapOnboardingRequestsNotificationAuthorization() async {
        let center = MockBootstrapNotificationCenter()
        let appModel = NodeAppModel(notificationCenter: center)

        await appModel._test_handleSuccessfulBootstrapGatewayOnboarding()

        #expect(center.requestAuthorizationCalls == 1)
    }

    @Test func clearingBootstrapTokenStripsReconnectConfigEvenWithoutPersistence() throws {
        let config = try GatewayConnectConfig(
            url: #require(URL(string: "wss://gateway.example")),
            stableID: "test-gateway",
            tls: nil,
            token: nil,
            bootstrapToken: "spent-bootstrap-token",
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

        let cleared = NodeAppModel._test_clearingBootstrapToken(in: config)
        #expect(cleared?.bootstrapToken == nil)
        #expect(cleared?.url == config.url)
        #expect(cleared?.stableID == config.stableID)
        #expect(cleared?.token == config.token)
        #expect(cleared?.password == config.password)
        #expect(cleared?.nodeOptions.role == config.nodeOptions.role)
    }

    @Test @MainActor func handleInvokeRejectsBackgroundCommands() async {
        let appModel = NodeAppModel()
        appModel.setScenePhase(.background)

        let req = BridgeInvokeRequest(id: "bg", command: OpenClawCanvasCommand.present.rawValue)
        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .backgroundUnavailable)
    }

    @Test @MainActor func handleInvokeRejectsCameraWhenDisabled() async {
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

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message.contains("CAMERA_DISABLED") == true)
    }

    @Test @MainActor func handleInvokeRejectsInvalidScreenFormat() async {
        let appModel = NodeAppModel()
        let params = OpenClawScreenRecordParams(format: "gif")
        let data = try? JSONEncoder().encode(params)
        let json = data.flatMap { String(data: $0, encoding: .utf8) }

        let req = BridgeInvokeRequest(
            id: "screen",
            command: OpenClawScreenCommand.record.rawValue,
            paramsJSON: json)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.message.contains("screen format must be mp4") == true)
    }

    @Test @MainActor func handleInvokeCanvasCommandsUpdateScreen() async throws {
        let appModel = NodeAppModel()
        let coordinator = try mountScreen(appModel.screen)
        defer { coordinator.teardown() }

        appModel.screen.navigate(to: "http://example.com")

        let present = BridgeInvokeRequest(id: "present", command: OpenClawCanvasCommand.present.rawValue)
        let presentRes = await appModel._test_handleInvoke(present)
        #expect(presentRes.ok == true)
        #expect(appModel.screen.urlString.isEmpty)

        // Loopback URLs are rejected (they are not meaningful for a remote gateway).
        let navigateParams = OpenClawCanvasNavigateParams(url: "http://example.com/")
        let navData = try JSONEncoder().encode(navigateParams)
        let navJSON = String(decoding: navData, as: UTF8.self)
        let navigate = BridgeInvokeRequest(
            id: "nav",
            command: OpenClawCanvasCommand.navigate.rawValue,
            paramsJSON: navJSON)
        let navRes = await appModel._test_handleInvoke(navigate)
        #expect(navRes.ok == true)
        #expect(appModel.screen.urlString == "http://example.com/")

        let evalParams = OpenClawCanvasEvalParams(javaScript: "1+1")
        let evalData = try JSONEncoder().encode(evalParams)
        let evalJSON = String(decoding: evalData, as: UTF8.self)
        let eval = BridgeInvokeRequest(
            id: "eval",
            command: OpenClawCanvasCommand.evalJS.rawValue,
            paramsJSON: evalJSON)
        var evalRes = await appModel._test_handleInvoke(eval)
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while evalRes.ok != true, ContinuousClock().now < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
            evalRes = await appModel._test_handleInvoke(eval)
        }
        #expect(evalRes.ok == true)
        let payloadData = try #require(evalRes.payloadJSON?.data(using: .utf8))
        let payload = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any]
        #expect(payload?["result"] as? String == "2")
    }

    @Test @MainActor func pendingForegroundActionsReplayCanvasNavigate() async throws {
        let appModel = NodeAppModel()
        let navigateParams = OpenClawCanvasNavigateParams(url: "http://example.com/")
        let navData = try JSONEncoder().encode(navigateParams)
        let navJSON = String(decoding: navData, as: UTF8.self)

        await appModel._test_applyPendingForegroundNodeActions([
            (
                id: "pending-nav-1",
                command: OpenClawCanvasCommand.navigate.rawValue,
                paramsJSON: navJSON),
        ])

        #expect(appModel.screen.urlString == "http://example.com/")
    }

    @Test @MainActor func pendingForegroundActionsDoNotApplyWhileBackgrounded() async throws {
        let appModel = NodeAppModel()
        appModel.setScenePhase(.background)
        let navigateParams = OpenClawCanvasNavigateParams(url: "http://example.com/")
        let navData = try JSONEncoder().encode(navigateParams)
        let navJSON = String(decoding: navData, as: UTF8.self)

        await appModel._test_applyPendingForegroundNodeActions([
            (
                id: "pending-nav-bg",
                command: OpenClawCanvasCommand.navigate.rawValue,
                paramsJSON: navJSON),
        ])

        #expect(appModel.screen.urlString.isEmpty)
    }

    @Test @MainActor func handleInvokeA2UICommandsFailWhenHostMissing() async throws {
        let appModel = NodeAppModel()

        let reset = BridgeInvokeRequest(id: "reset", command: OpenClawCanvasA2UICommand.reset.rawValue)
        let resetRes = await appModel._test_handleInvoke(reset)
        #expect(resetRes.ok == false)
        #expect(resetRes.error?.message.contains("A2UI_HOST_NOT_CONFIGURED") == true)

        let jsonl = "{\"beginRendering\":{}}"
        let pushParams = OpenClawCanvasA2UIPushJSONLParams(jsonl: jsonl)
        let pushData = try JSONEncoder().encode(pushParams)
        let pushJSON = String(decoding: pushData, as: UTF8.self)
        let push = BridgeInvokeRequest(
            id: "push",
            command: OpenClawCanvasA2UICommand.pushJSONL.rawValue,
            paramsJSON: pushJSON)
        let pushRes = await appModel._test_handleInvoke(push)
        #expect(pushRes.ok == false)
        #expect(pushRes.error?.message.contains("A2UI_HOST_NOT_CONFIGURED") == true)
    }

    @Test @MainActor func handleInvokeUnknownCommandReturnsInvalidRequest() async {
        let appModel = NodeAppModel()
        let req = BridgeInvokeRequest(id: "unknown", command: "nope")
        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .invalidRequest)
    }

    @Test @MainActor func handleInvokeWatchStatusReturnsServiceSnapshot() async throws {
        let watchService = MockWatchMessagingService()
        watchService.currentStatus = WatchMessagingStatus(
            supported: true,
            paired: true,
            appInstalled: true,
            reachable: false,
            activationState: "inactive")
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let req = BridgeInvokeRequest(id: "watch-status", command: OpenClawWatchCommand.status.rawValue)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == true)

        let payloadData = try #require(res.payloadJSON?.data(using: .utf8))
        let payload = try JSONDecoder().decode(OpenClawWatchStatusPayload.self, from: payloadData)
        #expect(payload.supported == true)
        #expect(payload.reachable == false)
        #expect(payload.activationState == "inactive")
    }

    @Test @MainActor func handleInvokeWatchNotifyRoutesToWatchService() async throws {
        let watchService = MockWatchMessagingService()
        watchService.nextSendResult = WatchNotificationSendResult(
            deliveredImmediately: false,
            queuedForDelivery: true,
            transport: "transferUserInfo")
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(
            title: "OpenClaw",
            body: "Meeting with Peter is at 4pm",
            priority: .timeSensitive)
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == true)
        #expect(watchService.lastSent?.params.title == "OpenClaw")
        #expect(watchService.lastSent?.params.body == "Meeting with Peter is at 4pm")
        #expect(watchService.lastSent?.params.priority == .timeSensitive)

        let payloadData = try #require(res.payloadJSON?.data(using: .utf8))
        let payload = try JSONDecoder().decode(OpenClawWatchNotifyPayload.self, from: payloadData)
        #expect(payload.deliveredImmediately == false)
        #expect(payload.queuedForDelivery == true)
        #expect(payload.transport == "transferUserInfo")
    }

    @Test @MainActor func handleInvokeWatchNotifyRejectsEmptyMessage() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(title: "   ", body: "\n")
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify-empty",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .invalidRequest)
        #expect(watchService.lastSent == nil)
    }

    @Test @MainActor func handleInvokeWatchNotifyAddsDefaultActionsForPrompt() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(
            title: "Task",
            body: "Action needed",
            priority: .passive,
            promptId: "prompt-123")
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify-default-actions",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == true)
        #expect(watchService.lastSent?.params.risk == .low)
        let actionIDs = watchService.lastSent?.params.actions?.map(\.id)
        #expect(actionIDs == ["done", "snooze_10m", "open_phone", "escalate"])
    }

    @Test @MainActor func handleInvokeWatchNotifyAddsApprovalDefaults() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(
            title: "Approval",
            body: "Allow command?",
            promptId: "prompt-approval",
            kind: "approval")
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify-approval-defaults",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == true)
        let actionIDs = watchService.lastSent?.params.actions?.map(\.id)
        #expect(actionIDs == ["approve", "decline", "open_phone", "escalate"])
        #expect(watchService.lastSent?.params.actions?[1].style == "destructive")
    }

    @Test @MainActor func handleInvokeWatchNotifyDerivesPriorityFromRiskAndCapsActions() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
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
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify-derive-priority",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == true)
        #expect(watchService.lastSent?.params.priority == .timeSensitive)
        #expect(watchService.lastSent?.params.risk == .high)
        let actionIDs = watchService.lastSent?.params.actions?.map(\.id)
        #expect(actionIDs == ["a1", "a2", "a3", "a4"])
    }

    @Test @MainActor func handleInvokeWatchNotifyReturnsUnavailableOnDeliveryFailure() async throws {
        let watchService = MockWatchMessagingService()
        watchService.sendError = NSError(
            domain: "watch",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "WATCH_UNAVAILABLE: no paired Apple Watch"])
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(title: "OpenClaw", body: "Delivery check")
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify-fail",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message.contains("WATCH_UNAVAILABLE") == true)
    }

    @Test @MainActor func watchReplyQueuesWhenGatewayOffline() async {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        watchService.emitReply(
            WatchQuickReplyEvent(
                replyId: "reply-offline-1",
                promptId: "prompt-1",
                actionId: "approve",
                actionLabel: "Approve",
                sessionKey: "ios",
                note: nil,
                sentAtMs: 1234,
                transport: "transferUserInfo"))
        await Task.yield()
        #expect(appModel._test_queuedWatchReplyCount() == 1)
    }

    @Test @MainActor func handleDeepLinkSetsErrorWhenNotConnected() async throws {
        let appModel = NodeAppModel()
        let url = try #require(URL(string: "openclaw://agent?message=hello"))
        await appModel.handleDeepLink(url: url)
        #expect(appModel.screen.errorText?.contains("Gateway not connected") == true)
    }

    @Test @MainActor func handleDeepLinkRejectsOversizedMessage() async throws {
        let appModel = NodeAppModel()
        let msg = String(repeating: "a", count: 20001)
        let url = try #require(URL(string: "openclaw://agent?message=\(msg)"))
        await appModel.handleDeepLink(url: url)
        #expect(appModel.screen.errorText?.contains("Deep link too large") == true)
    }

    @Test @MainActor func handleDeepLinkRequiresConfirmationWhenConnectedAndUnkeyed() async {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)
        let url = makeAgentDeepLinkURL(message: "hello from deep link")

        await appModel.handleDeepLink(url: url)
        #expect(appModel.pendingAgentDeepLinkPrompt != nil)
        #expect(appModel.openChatRequestID == 0)

        await appModel.approvePendingAgentDeepLinkPrompt()
        #expect(appModel.pendingAgentDeepLinkPrompt == nil)
        #expect(appModel.openChatRequestID == 1)
    }

    @Test @MainActor func handleDeepLinkCoalescesPromptWhenRateLimited() async throws {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)

        await appModel.handleDeepLink(url: makeAgentDeepLinkURL(message: "first prompt"))
        let firstPrompt = try #require(appModel.pendingAgentDeepLinkPrompt)

        await appModel.handleDeepLink(url: makeAgentDeepLinkURL(message: "second prompt"))
        let coalescedPrompt = try #require(appModel.pendingAgentDeepLinkPrompt)

        #expect(coalescedPrompt.id != firstPrompt.id)
        #expect(coalescedPrompt.messagePreview.contains("second prompt"))
    }

    @Test @MainActor func handleDeepLinkStripsDeliveryFieldsWhenUnkeyed() async throws {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)
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

    @Test @MainActor func handleDeepLinkRejectsLongUnkeyedMessageWhenConnected() async {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)
        let message = String(repeating: "x", count: 241)
        let url = makeAgentDeepLinkURL(message: message)

        await appModel.handleDeepLink(url: url)
        #expect(appModel.pendingAgentDeepLinkPrompt == nil)
        #expect(appModel.screen.errorText?.contains("blocked") == true)
    }

    @Test @MainActor func handleDeepLinkBypassesPromptWithValidKey() async {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)
        let key = NodeAppModel._test_currentDeepLinkKey()
        let url = makeAgentDeepLinkURL(message: "trusted request", key: key)

        await appModel.handleDeepLink(url: url)
        #expect(appModel.pendingAgentDeepLinkPrompt == nil)
        #expect(appModel.openChatRequestID == 1)
    }

    @Test @MainActor func sendVoiceTranscriptThrowsWhenGatewayOffline() async {
        let appModel = NodeAppModel()
        await #expect(throws: Error.self) {
            try await appModel.sendVoiceTranscript(text: "hello", sessionKey: "main")
        }
    }

    @Test @MainActor func canvasA2UIActionDispatchesStatus() async {
        let appModel = NodeAppModel()
        let body: [String: Any] = [
            "userAction": [
                "name": "tap",
                "id": "action-1",
                "surfaceId": "main",
                "sourceComponentId": "button-1",
                "context": ["value": "ok"],
            ],
        ]
        await appModel._test_handleCanvasA2UIAction(body: body)
        #expect(appModel.screen.urlString.isEmpty)
    }
}
