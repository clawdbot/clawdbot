import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import os
import Security
import SwiftUI
import UIKit
import UserNotifications

/// Wrap errors without pulling non-Sendable types into async notification paths.
private struct NotificationCallError: Error {
    let message: String
}

private struct GatewayRelayIdentityResponse: Decodable {
    let deviceId: String
    let publicKey: String
}

/// Ensures notification requests return promptly even if the system prompt blocks.
private final class NotificationInvokeLatch<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Result<T, NotificationCallError>, Never>?
    private var resumed = false

    func setContinuation(_ continuation: CheckedContinuation<Result<T, NotificationCallError>, Never>) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.continuation = continuation
    }

    func resume(_ response: Result<T, NotificationCallError>) {
        let cont: CheckedContinuation<Result<T, NotificationCallError>, Never>?
        self.lock.lock()
        if self.resumed {
            self.lock.unlock()
            return
        }
        self.resumed = true
        cont = self.continuation
        self.continuation = nil
        self.lock.unlock()
        cont?.resume(returning: response)
    }
}

private enum IOSDeepLinkAgentPolicy {
    static let maxMessageChars = 20000
    static let maxUnkeyedConfirmChars = 240
}

@MainActor
@Observable
// swiftlint:disable type_body_length file_length
final class NodeAppModel {
    struct AgentDeepLinkPrompt: Identifiable, Equatable {
        let id: String
        let messagePreview: String
        let urlPreview: String
        let request: AgentDeepLink
    }

    struct ExecApprovalPrompt: Identifiable, Equatable, Codable {
        let id: String
        let commandText: String
        let commandPreview: String?
        let allowedDecisions: [String]
        let host: String?
        let nodeId: String?
        let agentId: String?
        let expiresAtMs: Int?

        var allowsAllowAlways: Bool {
            self.allowedDecisions.contains("allow-always")
        }
    }

    private enum ExecApprovalResolutionOutcome {
        case resolved
        case stale
        case unavailable
        case failed(message: String)
    }

    private struct PersistedWatchExecApprovalBridgeState: Codable {
        var approvals: [ExecApprovalPrompt]
        var pendingApprovalIDs: [String]?
    }

    private let deepLinkLogger = Logger(subsystem: "ai.openclaw.ios", category: "DeepLink")
    private let pushWakeLogger = Logger(subsystem: "ai.openclaw.ios", category: "PushWake")
    private let pendingActionLogger = Logger(subsystem: "ai.openclaw.ios", category: "PendingAction")
    private let locationWakeLogger = Logger(subsystem: "ai.openclaw.ios", category: "LocationWake")
    private let watchReplyLogger = Logger(subsystem: "ai.openclaw.ios", category: "WatchReply")
    private let watchExecApprovalLogger = Logger(subsystem: "ai.openclaw.ios", category: "WatchExecApproval")
    private let execApprovalNotificationLogger = Logger(
        subsystem: "ai.openclaw.ios",
        category: "ExecApprovalNotification")
    enum CameraHUDKind {
        case photo
        case recording
        case success
        case error
    }

    var isBackgrounded: Bool = false
    let screen: ScreenController
    private let camera: any CameraServicing
    private let screenRecorder: any ScreenRecordingServicing
    var gatewayStatusText: String = "Offline"
    var nodeStatusText: String = "Offline"
    var operatorStatusText: String = "Offline"
    var gatewayServerName: String?
    var gatewayRemoteAddress: String?
    var connectedGatewayID: String?
    var gatewayAutoReconnectEnabled: Bool = true
    // When the gateway requires pairing approval, we pause reconnect churn and show a stable UX.
    // Reconnect loops (both our own and the underlying WebSocket watchdog) can otherwise generate
    // multiple pending requests and cause the onboarding UI to "flip-flop".
    var gatewayPairingPaused: Bool = false
    var gatewayPairingRequestId: String?
    private(set) var lastGatewayProblem: GatewayConnectionProblem?
    var gatewayDisplayStatusText: String {
        self.lastGatewayProblem?.statusText ?? self.gatewayStatusText
    }

    var seamColorHex: String?
    private var mainSessionBaseKey: String = "main"
    var selectedAgentId: String?
    var gatewayDefaultAgentId: String?
    var gatewayAgents: [AgentSummary] = []
    var homeCanvasRevision: Int = 0
    var lastShareEventText: String = "No share events yet."
    var openChatRequestID: Int = 0
    private(set) var pendingAgentDeepLinkPrompt: AgentDeepLinkPrompt?
    private(set) var pendingExecApprovalPrompt: ExecApprovalPrompt?
    private(set) var pendingExecApprovalPromptResolving: Bool = false
    private(set) var pendingExecApprovalPromptErrorText: String?
    private var pendingExecApprovalPromptRequestGeneration: Int = 0
    private var queuedAgentDeepLinkPrompt: AgentDeepLinkPrompt?
    private var lastAgentDeepLinkPromptAt: Date = .distantPast
    @ObservationIgnored private var queuedAgentDeepLinkPromptTask: Task<Void, Never>?

    /// Primary "node" connection: used for device capabilities and node.invoke requests.
    private let nodeGateway = GatewayNodeSession()
    // Secondary "operator" connection: used for chat/talk/config/voicewake requests.
    private let operatorGateway = GatewayNodeSession()
    private var nodeGatewayTask: Task<Void, Never>?
    private var operatorGatewayTask: Task<Void, Never>?
    private var voiceWakeSyncTask: Task<Void, Never>?
    @ObservationIgnored private var cameraHUDDismissTask: Task<Void, Never>?
    @ObservationIgnored private lazy var capabilityRouter: NodeCapabilityRouter = self.buildCapabilityRouter()
    private let gatewayHealthMonitor = GatewayHealthMonitor()
    private var gatewayHealthMonitorDisabled = false
    private let notificationCenter: NotificationCentering
    let voiceWake = VoiceWakeManager()
    let talkMode: TalkModeManager
    private let locationService: any LocationServicing
    private let deviceStatusService: any DeviceStatusServicing
    private let photosService: any PhotosServicing
    private let contactsService: any ContactsServicing
    private let calendarService: any CalendarServicing
    private let remindersService: any RemindersServicing
    private let motionService: any MotionServicing
    private let watchMessagingService: any WatchMessagingServicing
    var lastAutoA2uiURL: String?
    private var pttVoiceWakeSuspended = false
    private var talkVoiceWakeSuspended = false
    private var backgroundVoiceWakeSuspended = false
    private var backgroundTalkSuspended = false
    private var backgroundTalkKeptActive = false
    private var backgroundedAt: Date?
    private var reconnectAfterBackgroundArmed = false
    private var backgroundGraceTaskID: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private var backgroundGraceTaskTimer: Task<Void, Never>?
    private var backgroundReconnectSuppressed = false
    private var backgroundReconnectLeaseUntil: Date?
    private var lastSignificantLocationWakeAt: Date?
    @ObservationIgnored private let watchReplyCoordinator = WatchReplyCoordinator()
    private var watchExecApprovalPromptsByID: [String: ExecApprovalPrompt] = [:]
    private var pendingWatchExecApprovalRecoveryIDs: [String] = []
    private var pendingForegroundActionDrainInFlight = false

    private var gatewayConnected = false
    private var operatorConnected = false
    private var shareDeliveryChannel: String?
    private var shareDeliveryTo: String?
    private var apnsDeviceTokenHex: String?
    private var apnsLastRegisteredTokenHex: String?
    @ObservationIgnored private let pushRegistrationManager = PushRegistrationManager()
    var gatewaySession: GatewayNodeSession {
        self.nodeGateway
    }

    var operatorSession: GatewayNodeSession {
        self.operatorGateway
    }

    private(set) var activeGatewayConnectConfig: GatewayConnectConfig?

    private static let watchExecApprovalBridgeStateKey = "watch.execApproval.bridge.state.v1"
    private static let backgroundAliveLastSuccessAtMsKey = "gateway.backgroundAlive.lastSuccessAtMs"
    private static let backgroundAliveLastTriggerKey = "gateway.backgroundAlive.lastTrigger"

    var cameraHUDText: String?
    var cameraHUDKind: CameraHUDKind?
    var cameraFlashNonce: Int = 0
    var screenRecordActive: Bool = false

    init(
        screen: ScreenController = ScreenController(),
        camera: any CameraServicing = CameraController(),
        screenRecorder: any ScreenRecordingServicing = ScreenRecordService(),
        locationService: any LocationServicing = LocationService(),
        notificationCenter: NotificationCentering = LiveNotificationCenter(),
        deviceStatusService: any DeviceStatusServicing = DeviceStatusService(),
        photosService: any PhotosServicing = PhotoLibraryService(),
        contactsService: any ContactsServicing = ContactsService(),
        calendarService: any CalendarServicing = CalendarService(),
        remindersService: any RemindersServicing = RemindersService(),
        motionService: any MotionServicing = MotionService(),
        watchMessagingService: any WatchMessagingServicing = WatchMessagingService(),
        talkMode: TalkModeManager = TalkModeManager())
    {
        self.screen = screen
        self.camera = camera
        self.screenRecorder = screenRecorder
        self.locationService = locationService
        self.notificationCenter = notificationCenter
        self.deviceStatusService = deviceStatusService
        self.photosService = photosService
        self.contactsService = contactsService
        self.calendarService = calendarService
        self.remindersService = remindersService
        self.motionService = motionService
        self.watchMessagingService = watchMessagingService
        self.talkMode = talkMode
        self.apnsDeviceTokenHex = UserDefaults.standard.string(forKey: Self.apnsDeviceTokenUserDefaultsKey)
        self.restorePersistedWatchExecApprovalBridgeState()
        GatewayDiagnostics.bootstrap()
        GatewayDiagnostics.log("node app model: init start")
        self.watchMessagingService.setStatusHandler { [weak self] status in
            Task { @MainActor in
                GatewayDiagnostics.log(
                    "node app model: watch status callback "
                        + "reachable=\(status.reachable) activation=\(status.activationState) "
                        + "backgrounded=\(self?.isBackgrounded ?? false)")
                await self?.handleWatchMessagingStatusChanged(status)
            }
        }
        self.watchMessagingService.setReplyHandler { [weak self] event in
            Task { @MainActor in
                await self?.handleWatchQuickReply(event)
            }
        }
        self.watchMessagingService.setExecApprovalResolveHandler { [weak self] event in
            Task { @MainActor in
                await self?.handleWatchExecApprovalResolve(event)
            }
        }
        self.watchMessagingService.setExecApprovalSnapshotRequestHandler { [weak self] event in
            Task { @MainActor in
                guard let self else { return }
                GatewayDiagnostics.log(
                    "node app model: watch snapshot request id=\(event.requestId) backgrounded=\(self.isBackgrounded)")
                guard self.isBackgrounded else {
                    self.watchExecApprovalLogger.debug(
                        "watch exec approval snapshot skipped reason=watch_request_foreground")
                    GatewayDiagnostics.log("node app model: watch snapshot request skipped in foreground")
                    return
                }
                await self.refreshWatchExecApprovalSnapshotOnDemand(reason: "watch_request")
            }
        }

        self.voiceWake.configure { [weak self] cmd in
            guard let self else { return }
            let sessionKey = await MainActor.run { self.mainSessionKey }
            do {
                try await self.sendVoiceTranscript(text: cmd, sessionKey: sessionKey)
            } catch {
                // Best-effort only.
            }
        }

        let enabled = UserDefaults.standard.bool(forKey: "voiceWake.enabled")
        self.voiceWake.setEnabled(enabled)
        self.talkMode.attachGateway(self.operatorGateway)
        self.refreshLastShareEventFromRelay()
        let talkEnabled = UserDefaults.standard.bool(forKey: "talk.enabled")
        // Route through the coordinator so VoiceWake and Talk don't fight over the microphone.
        self.setTalkEnabled(talkEnabled)

        // Wire up deep links from canvas taps
        self.screen.onDeepLink = { [weak self] url in
            guard let self else { return }
            Task { @MainActor in
                await self.handleDeepLink(url: url)
            }
        }

        // Wire up A2UI action clicks (buttons, etc.)
        self.screen.onA2UIAction = { [weak self] body in
            guard let self else { return }
            Task { @MainActor in
                await self.handleCanvasA2UIAction(body: body)
            }
        }
    }

    private func handleCanvasA2UIAction(body: [String: Any]) async {
        let userActionAny = body["userAction"] ?? body
        let userAction: [String: Any] = {
            if let dict = userActionAny as? [String: Any] { return dict }
            if let dict = userActionAny as? [AnyHashable: Any] {
                return dict.reduce(into: [String: Any]()) { acc, pair in
                    guard let key = pair.key as? String else { return }
                    acc[key] = pair.value
                }
            }
            return [:]
        }()
        guard !userAction.isEmpty else { return }

        guard let name = OpenClawCanvasA2UIAction.extractActionName(userAction) else { return }
        let actionId: String = {
            let id = (userAction["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return id.isEmpty ? UUID().uuidString : id
        }()

        let surfaceId: String = {
            let raw = (userAction["surfaceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? "main" : raw
        }()
        let sourceComponentId: String = {
            let raw = (userAction[
                "sourceComponentId",
            ] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return raw.isEmpty ? "-" : raw
        }()

        let host = NodeDisplayName.resolve(
            existing: UserDefaults.standard.string(forKey: "node.displayName"),
            deviceName: UIDevice.current.name,
            interfaceIdiom: UIDevice.current.userInterfaceIdiom)
        let instanceId = (UserDefaults.standard.string(forKey: "node.instanceId") ?? "ios-node").lowercased()
        let contextJSON = OpenClawCanvasA2UIAction.compactJSON(userAction["context"])
        let sessionKey = self.mainSessionKey

        let messageContext = OpenClawCanvasA2UIAction.AgentMessageContext(
            actionName: name,
            session: .init(key: sessionKey, surfaceId: surfaceId),
            component: .init(id: sourceComponentId, host: host, instanceId: instanceId),
            contextJSON: contextJSON)
        let message = OpenClawCanvasA2UIAction.formatAgentMessage(messageContext)

        let ok: Bool
        var errorText: String?
        if await !self.isGatewayConnected() {
            ok = false
            errorText = "gateway not connected"
        } else {
            do {
                try await self.sendAgentRequest(link: AgentDeepLink(
                    message: message,
                    sessionKey: sessionKey,
                    thinking: "low",
                    deliver: false,
                    to: nil,
                    channel: nil,
                    timeoutSeconds: nil,
                    key: actionId))
                ok = true
            } catch {
                ok = false
                errorText = error.localizedDescription
            }
        }

        let js = OpenClawCanvasA2UIAction.jsDispatchA2UIActionStatus(actionId: actionId, ok: ok, error: errorText)
        do {
            _ = try await self.screen.eval(javaScript: js)
        } catch {
            // ignore
        }
    }

    func setScenePhase(_ phase: ScenePhase) {
        let keepTalkActive = UserDefaults.standard.bool(forKey: "talk.background.enabled")
        GatewayDiagnostics.log("node app model: scene phase=\(String(describing: phase))")
        switch phase {
        case .background:
            self.isBackgrounded = true
            self.stopGatewayHealthMonitor()
            self.backgroundedAt = Date()
            self.reconnectAfterBackgroundArmed = true
            self.beginBackgroundConnectionGracePeriod()
            // Release voice wake mic in background.
            self.backgroundVoiceWakeSuspended = self.voiceWake.suspendForExternalAudioCapture()
            let shouldKeepTalkActive = keepTalkActive && self.talkMode.isEnabled
            self.backgroundTalkKeptActive = shouldKeepTalkActive
            self.backgroundTalkSuspended = self.talkMode.suspendForBackground(keepActive: shouldKeepTalkActive)
        case .active, .inactive:
            self.isBackgrounded = false
            self.endBackgroundConnectionGracePeriod(reason: "scene_foreground")
            self.clearBackgroundReconnectSuppression(reason: "scene_foreground")
            if self.operatorConnected {
                self.startGatewayHealthMonitor()
            }
            if phase == .active {
                self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: self.backgroundVoiceWakeSuspended)
                self.backgroundVoiceWakeSuspended = false
                Task { [weak self] in
                    guard let self else { return }
                    let suspended = await MainActor.run { self.backgroundTalkSuspended }
                    let keptActive = await MainActor.run { self.backgroundTalkKeptActive }
                    await MainActor.run {
                        self.backgroundTalkSuspended = false
                        self.backgroundTalkKeptActive = false
                    }
                    await self.talkMode.resumeAfterBackground(wasSuspended: suspended, wasKeptActive: keptActive)
                }
                Task { [weak self] in
                    await self?.resumePendingForegroundNodeActionsIfNeeded(trigger: "scene_active")
                }
            }
            if phase == .active, self.reconnectAfterBackgroundArmed {
                self.reconnectAfterBackgroundArmed = false
                let backgroundedFor = self.backgroundedAt.map { Date().timeIntervalSince($0) } ?? 0
                self.backgroundedAt = nil
                // iOS may suspend network sockets in background without a clean close.
                // On foreground, force a fresh handshake to avoid "connected but dead" states.
                if backgroundedFor >= 3.0 {
                    Task { [weak self] in
                        guard let self else { return }
                        let operatorWasConnected = await MainActor.run { self.operatorConnected }
                        if operatorWasConnected {
                            // Prefer keeping the connection if it's healthy; reconnect only when needed.
                            let healthy = await (try? self.operatorGateway.request(
                                method: "health",
                                paramsJSON: nil,
                                timeoutSeconds: 2)) != nil
                            if healthy {
                                await MainActor.run { self.startGatewayHealthMonitor() }
                                return
                            }
                        }

                        await self.operatorGateway.disconnect()
                        await self.nodeGateway.disconnect()
                        await MainActor.run {
                            self.operatorConnected = false
                            self.gatewayConnected = false
                            // Foreground recovery must actively restart the saved gateway config.
                            // Disconnecting stale sockets alone can leave us idle if the old
                            // reconnect tasks were suppressed or otherwise got stuck in background.
                            self.gatewayStatusText = "Reconnecting…"
                            self.talkMode.updateGatewayConnected(false)
                            if let cfg = self.activeGatewayConnectConfig {
                                self.applyGatewayConnectConfig(cfg)
                            }
                        }
                    }
                }
            }
        @unknown default:
            self.isBackgrounded = false
            self.endBackgroundConnectionGracePeriod(reason: "scene_unknown")
            self.clearBackgroundReconnectSuppression(reason: "scene_unknown")
        }
    }

    private func beginBackgroundConnectionGracePeriod(seconds: TimeInterval = 25) {
        self.grantBackgroundReconnectLease(seconds: seconds, reason: "scene_background_grace")
        self.endBackgroundConnectionGracePeriod(reason: "restart")
        let taskID = UIApplication.shared.beginBackgroundTask(withName: "gateway-background-grace") { [weak self] in
            Task { @MainActor in
                self?.suppressBackgroundReconnect(
                    reason: "background_grace_expired",
                    disconnectIfNeeded: true)
                self?.endBackgroundConnectionGracePeriod(reason: "expired")
            }
        }
        guard taskID != .invalid else {
            self.pushWakeLogger.info("Background grace unavailable: beginBackgroundTask returned invalid")
            return
        }
        self.backgroundGraceTaskID = taskID
        self.pushWakeLogger.info("Background grace started seconds=\(seconds, privacy: .public)")
        self.backgroundGraceTaskTimer = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(max(1, seconds) * 1_000_000_000))
            await MainActor.run {
                self.suppressBackgroundReconnect(reason: "background_grace_timer", disconnectIfNeeded: true)
                self.endBackgroundConnectionGracePeriod(reason: "timer")
            }
        }
    }

    private func endBackgroundConnectionGracePeriod(reason: String) {
        self.backgroundGraceTaskTimer?.cancel()
        self.backgroundGraceTaskTimer = nil
        guard self.backgroundGraceTaskID != .invalid else { return }
        UIApplication.shared.endBackgroundTask(self.backgroundGraceTaskID)
        self.backgroundGraceTaskID = .invalid
        self.pushWakeLogger.info("Background grace ended reason=\(reason, privacy: .public)")
    }

    private func grantBackgroundReconnectLease(seconds: TimeInterval, reason: String) {
        guard self.isBackgrounded else { return }
        let leaseSeconds = max(5, seconds)
        let leaseUntil = Date().addingTimeInterval(leaseSeconds)
        if let existing = self.backgroundReconnectLeaseUntil, existing > leaseUntil {
            // Keep the longer lease if one is already active.
        } else {
            self.backgroundReconnectLeaseUntil = leaseUntil
        }
        let wasSuppressed = self.backgroundReconnectSuppressed
        self.backgroundReconnectSuppressed = false
        let leaseLogMessage =
            "Background reconnect lease reason=\(reason) "
                + "seconds=\(leaseSeconds) wasSuppressed=\(wasSuppressed)"
        self.pushWakeLogger.info("\(leaseLogMessage, privacy: .public)")
    }

    private func suppressBackgroundReconnect(reason: String, disconnectIfNeeded: Bool) {
        guard self.isBackgrounded else { return }
        let hadLease = self.backgroundReconnectLeaseUntil != nil
        let changed = hadLease || !self.backgroundReconnectSuppressed
        self.backgroundReconnectLeaseUntil = nil
        self.backgroundReconnectSuppressed = true
        guard changed else { return }
        let suppressLogMessage =
            "Background reconnect suppressed reason=\(reason) "
                + "disconnect=\(disconnectIfNeeded)"
        self.pushWakeLogger.info("\(suppressLogMessage, privacy: .public)")
        guard disconnectIfNeeded else { return }
        Task { [weak self] in
            guard let self else { return }
            await self.operatorGateway.disconnect()
            await self.nodeGateway.disconnect()
            await MainActor.run {
                self.operatorConnected = false
                self.gatewayConnected = false
                self.talkMode.updateGatewayConnected(false)
                if self.isBackgrounded {
                    self.gatewayStatusText = "Background idle"
                    self.gatewayServerName = nil
                    self.gatewayRemoteAddress = nil
                    self.showLocalCanvasOnDisconnect()
                }
            }
        }
    }

    private func clearBackgroundReconnectSuppression(reason: String) {
        let changed = self.backgroundReconnectSuppressed || self.backgroundReconnectLeaseUntil != nil
        self.backgroundReconnectSuppressed = false
        self.backgroundReconnectLeaseUntil = nil
        guard changed else { return }
        self.pushWakeLogger.info("Background reconnect cleared reason=\(reason, privacy: .public)")
    }

    func setVoiceWakeEnabled(_ enabled: Bool) {
        self.voiceWake.setEnabled(enabled)
        if enabled {
            // If talk is enabled, voice wake should not grab the mic.
            if self.talkMode.isEnabled {
                self.voiceWake.setSuppressedByTalk(true)
                self.talkVoiceWakeSuspended = self.voiceWake.suspendForExternalAudioCapture()
            }
        } else {
            self.voiceWake.setSuppressedByTalk(false)
            self.talkVoiceWakeSuspended = false
        }
    }

    func setTalkEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: "talk.enabled")
        if enabled {
            // Voice wake holds the microphone continuously; talk mode needs exclusive access for STT.
            // When talk is enabled from the UI, prioritize talk and pause voice wake.
            self.voiceWake.setSuppressedByTalk(true)
            self.talkVoiceWakeSuspended = self.voiceWake.suspendForExternalAudioCapture()
        } else {
            self.voiceWake.setSuppressedByTalk(false)
            self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: self.talkVoiceWakeSuspended)
            self.talkVoiceWakeSuspended = false
        }
        self.talkMode.setEnabled(enabled)
        Task { [weak self] in
            await self?.pushTalkModeToGateway(
                enabled: enabled,
                phase: enabled ? "enabled" : "disabled")
        }
    }

    func requestLocationPermissions(mode: OpenClawLocationMode) async -> Bool {
        guard mode != .off else { return true }
        let status = await self.locationService.ensureAuthorization(mode: mode)
        switch status {
        case .authorizedAlways:
            return true
        case .authorizedWhenInUse:
            return mode != .always
        default:
            return false
        }
    }

    var seamColor: Color {
        Self.color(fromHex: self.seamColorHex) ?? Self.defaultSeamColor
    }

    private static let defaultSeamColor = Color(red: 79 / 255.0, green: 122 / 255.0, blue: 154 / 255.0)
    private static let apnsDeviceTokenUserDefaultsKey = "push.apns.deviceTokenHex"
    private static let deepLinkKeyUserDefaultsKey = "deeplink.agent.key"
    private static let canvasUnattendedDeepLinkKey: String = NodeAppModel.generateDeepLinkKey()

    private func refreshBrandingFromGateway() async {
        do {
            let res = try await self.operatorGateway.request(method: "config.get", paramsJSON: "{}", timeoutSeconds: 8)
            guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return }
            guard let config = json["config"] as? [String: Any] else { return }
            let ui = config["ui"] as? [String: Any]
            let raw = (ui?["seamColor"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let session = config["session"] as? [String: Any]
            let mainKey = SessionKey.normalizeMainKey(session?["mainKey"] as? String)
            await MainActor.run {
                self.seamColorHex = raw.isEmpty ? nil : raw
                self.mainSessionBaseKey = mainKey
                self.talkMode.updateMainSessionKey(self.mainSessionKey)
                self.homeCanvasRevision &+= 1
            }
        } catch {
            if let gatewayError = error as? GatewayResponseError {
                let lower = gatewayError.message.lowercased()
                if lower.contains("unauthorized role") {
                    return
                }
            }
            // ignore
        }
    }

    private func refreshAgentsFromGateway() async {
        do {
            let res = try await self.operatorGateway.request(method: "agents.list", paramsJSON: "{}", timeoutSeconds: 8)
            let decoded = try JSONDecoder().decode(AgentsListResult.self, from: res)
            await MainActor.run {
                self.gatewayDefaultAgentId = decoded.defaultid
                self.gatewayAgents = decoded.agents
                self.applyMainSessionKey(decoded.mainkey)

                let selected = (self.selectedAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !selected.isEmpty, !decoded.agents.contains(where: { $0.id == selected }) {
                    self.selectedAgentId = nil
                }
                self.talkMode.updateMainSessionKey(self.mainSessionKey)
                self.homeCanvasRevision &+= 1
            }
        } catch {
            // Best-effort only.
        }
    }

    func refreshGatewayOverviewIfConnected() async {
        guard await self.isOperatorConnected() else { return }
        await self.refreshBrandingFromGateway()
        await self.refreshAgentsFromGateway()
    }

    func setSelectedAgentId(_ agentId: String?) {
        let trimmed = (agentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let stableID = (self.connectedGatewayID ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if stableID.isEmpty {
            self.selectedAgentId = trimmed.isEmpty ? nil : trimmed
        } else {
            self.selectedAgentId = trimmed.isEmpty ? nil : trimmed
            GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: stableID, agentId: self.selectedAgentId)
        }
        self.talkMode.updateMainSessionKey(self.mainSessionKey)
        self.homeCanvasRevision &+= 1
        if let relay = ShareGatewayRelaySettings.loadConfig() {
            ShareGatewayRelaySettings.saveConfig(
                ShareGatewayRelayConfig(
                    gatewayURLString: relay.gatewayURLString,
                    token: relay.token,
                    password: relay.password,
                    sessionKey: self.mainSessionKey,
                    deliveryChannel: self.shareDeliveryChannel,
                    deliveryTo: self.shareDeliveryTo))
        }
    }

    func setGlobalWakeWords(_ words: [String]) async {
        let sanitized = VoiceWakePreferences.sanitizeTriggerWords(words)

        struct Payload: Codable {
            var triggers: [String]
        }
        let payload = Payload(triggers: sanitized)
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else { return }

        do {
            _ = try await self.operatorGateway.request(method: "voicewake.set", paramsJSON: json, timeoutSeconds: 12)
        } catch {
            // Best-effort only.
        }
    }

    private func startVoiceWakeSync() async {
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = Task { [weak self] in
            guard let self else { return }

            if !self.isGatewayHealthMonitorDisabled() {
                await self.refreshWakeWordsFromGateway()
            }

            let stream = await self.operatorGateway.subscribeServerEvents(bufferingNewest: 200)
            for await evt in stream {
                if Task.isCancelled { return }
                guard let payload = evt.payload else { continue }
                switch evt.event {
                case "voicewake.changed":
                    struct Payload: Decodable { var triggers: [String] }
                    guard let decoded = try? GatewayPayloadDecoding.decode(payload, as: Payload.self) else { continue }
                    let triggers = VoiceWakePreferences.sanitizeTriggerWords(decoded.triggers)
                    VoiceWakePreferences.saveTriggerWords(triggers)
                case "talk.mode":
                    struct Payload: Decodable {
                        var enabled: Bool
                        var phase: String?
                    }
                    guard let decoded = try? GatewayPayloadDecoding.decode(payload, as: Payload.self) else { continue }
                    self.applyTalkModeSync(enabled: decoded.enabled, phase: decoded.phase)
                default:
                    continue
                }
            }
        }
    }

    private func applyTalkModeSync(enabled: Bool, phase: String?) {
        _ = phase
        guard self.talkMode.isEnabled != enabled else { return }
        self.setTalkEnabled(enabled)
    }

    private func pushTalkModeToGateway(enabled: Bool, phase: String?) async {
        guard await self.isOperatorConnected() else { return }
        struct TalkModePayload: Encodable {
            var enabled: Bool
            var phase: String?
        }
        let payload = TalkModePayload(enabled: enabled, phase: phase)
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else { return }
        _ = try? await self.operatorGateway.request(
            method: "talk.mode",
            paramsJSON: json,
            timeoutSeconds: 8)
    }

    private func startGatewayHealthMonitor() {
        self.gatewayHealthMonitorDisabled = false
        self.gatewayHealthMonitor.start(
            check: { [weak self] in
                guard let self else { return false }
                if await MainActor.run(body: { self.isGatewayHealthMonitorDisabled() }) { return true }
                do {
                    let data = try await self.operatorGateway.request(
                        method: "health",
                        paramsJSON: nil,
                        timeoutSeconds: 6)
                    guard let decoded = try? JSONDecoder().decode(OpenClawGatewayHealthOK.self, from: data) else {
                        return false
                    }
                    return decoded.ok ?? false
                } catch {
                    if let gatewayError = error as? GatewayResponseError {
                        let lower = gatewayError.message.lowercased()
                        if lower.contains("unauthorized role") || lower.contains("missing scope") {
                            await self.setGatewayHealthMonitorDisabled(true)
                            return true
                        }
                    }
                    return false
                }
            },
            onFailure: { [weak self] _ in
                guard let self else { return }
                await self.operatorGateway.disconnect()
                await self.nodeGateway.disconnect()
                await MainActor.run {
                    self.operatorConnected = false
                    self.gatewayConnected = false
                    self.gatewayStatusText = "Reconnecting…"
                    self.talkMode.updateGatewayConnected(false)
                }
            })
    }

    private func stopGatewayHealthMonitor() {
        self.gatewayHealthMonitor.stop()
    }

    private func handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        let command = req.command

        if self.isBackgrounded, self.isBackgroundRestricted(command) {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .backgroundUnavailable,
                    message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground"))
        }

        if command.hasPrefix("camera."), !self.isCameraEnabled() {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "CAMERA_DISABLED: enable Camera in iOS Settings → Camera → Allow Camera"))
        }

        do {
            return try await self.capabilityRouter.handle(req)
        } catch let error as NodeCapabilityRouter.RouterError {
            switch error {
            case .unknownCommand:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
            case .handlerUnavailable:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(code: .unavailable, message: "node handler unavailable"))
            }
        } catch {
            if command.hasPrefix("camera.") {
                let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self.showCameraHUD(text: text, kind: .error, autoHideSeconds: 2.2)
            }
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: error.localizedDescription))
        }
    }

    private func isBackgroundRestricted(_ command: String) -> Bool {
        command.hasPrefix("canvas.") || command.hasPrefix("camera.") || command.hasPrefix("screen.") ||
            command.hasPrefix("talk.")
    }

    private func handleLocationInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let mode = self.locationMode()
        guard mode != .off else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_DISABLED: enable Location in Settings"))
        }
        if self.isBackgrounded, mode != .always {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .backgroundUnavailable,
                    message: "LOCATION_BACKGROUND_UNAVAILABLE: background location requires Always"))
        }
        let params = (try? Self.decodeParams(OpenClawLocationGetParams.self, from: req.paramsJSON)) ??
            OpenClawLocationGetParams()
        let desired = params.desiredAccuracy ??
            (self.isLocationPreciseEnabled() ? .precise : .balanced)
        let status = self.locationService.authorizationStatus()
        if status != .authorizedAlways, status != .authorizedWhenInUse {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_PERMISSION_REQUIRED: grant Location permission"))
        }
        if self.isBackgrounded, status != .authorizedAlways {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_PERMISSION_REQUIRED: enable Always for background access"))
        }
        let location = try await self.locationService.currentLocation(
            params: params,
            desiredAccuracy: desired,
            maxAgeMs: params.maxAgeMs,
            timeoutMs: params.timeoutMs)
        let isPrecise = self.locationService.accuracyAuthorization() == .fullAccuracy
        let payload = OpenClawLocationPayload(
            lat: location.coordinate.latitude,
            lon: location.coordinate.longitude,
            accuracyMeters: location.horizontalAccuracy,
            altitudeMeters: location.verticalAccuracy >= 0 ? location.altitude : nil,
            speedMps: location.speed >= 0 ? location.speed : nil,
            headingDeg: location.course >= 0 ? location.course : nil,
            timestamp: ISO8601DateFormatter().string(from: location.timestamp),
            isPrecise: isPrecise,
            source: nil)
        let json = try Self.encodePayload(payload)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func handleCanvasInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawCanvasCommand.present.rawValue:
            // iOS ignores placement hints; canvas always fills the screen.
            let params = (try? Self.decodeParams(OpenClawCanvasPresentParams.self, from: req.paramsJSON)) ??
                OpenClawCanvasPresentParams()
            let url = params.url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if url.isEmpty {
                self.screen.showDefaultCanvas()
            } else {
                let trustedA2UIURL = await self.resolveA2UIHostURL()
                self.screen.navigate(
                    to: url,
                    trustA2UIActions: trustedA2UIURL == Self.normalizeURLForTrustComparison(url))
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.hide.rawValue:
            self.screen.showDefaultCanvas()
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.navigate.rawValue:
            let params = try Self.decodeParams(OpenClawCanvasNavigateParams.self, from: req.paramsJSON)
            let trimmedURL = params.url.trimmingCharacters(in: .whitespacesAndNewlines)
            let trustedA2UIURL = await self.resolveA2UIHostURL()
            self.screen.navigate(
                to: trimmedURL,
                trustA2UIActions: trustedA2UIURL == Self.normalizeURLForTrustComparison(trimmedURL))
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.evalJS.rawValue:
            let params = try Self.decodeParams(OpenClawCanvasEvalParams.self, from: req.paramsJSON)
            let result = try await self.screen.eval(javaScript: params.javaScript)
            let payload = try Self.encodePayload(["result": result])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCanvasCommand.snapshot.rawValue:
            let params = try? Self.decodeParams(OpenClawCanvasSnapshotParams.self, from: req.paramsJSON)
            let format = params?.format ?? .jpeg
            let maxWidth: CGFloat? = {
                if let raw = params?.maxWidth, raw > 0 { return CGFloat(raw) }
                // Keep default snapshots comfortably below the gateway client's maxPayload.
                // For full-res, clients should explicitly request a larger maxWidth.
                return switch format {
                case .png: 900
                case .jpeg: 1600
                }
            }()
            let base64 = try await self.screen.snapshotBase64(
                maxWidth: maxWidth,
                format: format,
                quality: params?.quality)
            let payload = try Self.encodePayload([
                "format": format == .jpeg ? "jpeg" : "png",
                "base64": base64,
            ])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleCanvasA2UIInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let command = req.command
        switch command {
        case OpenClawCanvasA2UICommand.reset.rawValue:
            switch await self.ensureA2UIReadyWithCapabilityRefresh(timeoutMs: 5000) {
            case .ready:
                break
            case .hostNotConfigured:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host"))
            case .hostUnavailable:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_UNAVAILABLE: A2UI host not reachable"))
            }
            let json = try await self.screen.eval(javaScript: """
            (() => {
              const host = globalThis.openclawA2UI;
              if (!host) return JSON.stringify({ ok: false, error: "missing openclawA2UI" });
              return JSON.stringify(host.reset());
            })()
            """)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)

        case OpenClawCanvasA2UICommand.push.rawValue, OpenClawCanvasA2UICommand.pushJSONL.rawValue:
            let messages: [OpenClawKit.AnyCodable]
            if command == OpenClawCanvasA2UICommand.pushJSONL.rawValue {
                let params = try Self.decodeParams(OpenClawCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                messages = try OpenClawCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
            } else {
                do {
                    let params = try Self.decodeParams(OpenClawCanvasA2UIPushParams.self, from: req.paramsJSON)
                    messages = params.messages
                } catch {
                    // Be forgiving: some clients still send JSONL payloads to `canvas.a2ui.push`.
                    let params = try Self.decodeParams(OpenClawCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                    messages = try OpenClawCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
                }
            }

            switch await self.ensureA2UIReadyWithCapabilityRefresh(timeoutMs: 5000) {
            case .ready:
                break
            case .hostNotConfigured:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host"))
            case .hostUnavailable:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_UNAVAILABLE: A2UI host not reachable"))
            }

            let messagesJSON = try OpenClawCanvasA2UIJSONL.encodeMessagesJSONArray(messages)
            let js = """
            (() => {
              try {
                const host = globalThis.openclawA2UI;
                if (!host) return JSON.stringify({ ok: false, error: "missing openclawA2UI" });
                const messages = \(messagesJSON);
                return JSON.stringify(host.applyMessages(messages));
              } catch (e) {
                return JSON.stringify({ ok: false, error: String(e?.message ?? e) });
              }
            })()
            """
            let resultJSON = try await self.screen.eval(javaScript: js)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: resultJSON)

        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleCameraInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawCameraCommand.list.rawValue:
            let devices = await self.camera.listDevices()
            struct Payload: Codable {
                var devices: [CameraController.CameraDeviceInfo]
            }
            let payload = try Self.encodePayload(Payload(devices: devices))
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCameraCommand.snap.rawValue:
            self.showCameraHUD(text: "Taking photo…", kind: .photo)
            self.triggerCameraFlash()
            let params = (try? Self.decodeParams(OpenClawCameraSnapParams.self, from: req.paramsJSON)) ??
                OpenClawCameraSnapParams()
            let res = try await self.camera.snap(params: params)

            struct Payload: Codable {
                var format: String
                var base64: String
                var width: Int
                var height: Int
            }
            let payload = try Self.encodePayload(Payload(
                format: res.format,
                base64: res.base64,
                width: res.width,
                height: res.height))
            self.showCameraHUD(text: "Photo captured", kind: .success, autoHideSeconds: 1.6)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCameraCommand.clip.rawValue:
            let params = (try? Self.decodeParams(OpenClawCameraClipParams.self, from: req.paramsJSON)) ??
                OpenClawCameraClipParams()

            let suspended = (params.includeAudio ?? true) ? self.voiceWake.suspendForExternalAudioCapture() : false
            defer { self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: suspended) }

            self.showCameraHUD(text: "Recording…", kind: .recording)
            let res = try await self.camera.clip(params: params)

            struct Payload: Codable {
                var format: String
                var base64: String
                var durationMs: Int
                var hasAudio: Bool
            }
            let payload = try Self.encodePayload(Payload(
                format: res.format,
                base64: res.base64,
                durationMs: res.durationMs,
                hasAudio: res.hasAudio))
            self.showCameraHUD(text: "Clip captured", kind: .success, autoHideSeconds: 1.8)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleScreenRecordInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = (try? Self.decodeParams(OpenClawScreenRecordParams.self, from: req.paramsJSON)) ??
            OpenClawScreenRecordParams()
        if let format = params.format, format.lowercased() != "mp4" {
            throw NSError(domain: "Screen", code: 30, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: screen format must be mp4",
            ])
        }
        // Status pill mirrors screen recording state so it stays visible without overlay stacking.
        self.screenRecordActive = true
        defer { self.screenRecordActive = false }
        let path = try await self.screenRecorder.record(
            screenIndex: params.screenIndex,
            durationMs: params.durationMs,
            fps: params.fps,
            includeAudio: params.includeAudio,
            outPath: nil)
        defer { try? FileManager().removeItem(atPath: path) }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        struct Payload: Codable {
            var format: String
            var base64: String
            var durationMs: Int?
            var fps: Double?
            var screenIndex: Int?
            var hasAudio: Bool
        }
        let payload = try Self.encodePayload(Payload(
            format: "mp4",
            base64: data.base64EncodedString(),
            durationMs: params.durationMs,
            fps: params.fps,
            screenIndex: params.screenIndex,
            hasAudio: params.includeAudio ?? true))
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

    private func handleSystemNotify(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(OpenClawSystemNotifyParams.self, from: req.paramsJSON)
        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = params.body.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty, body.isEmpty {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: empty notification"))
        }

        let finalStatus = await self.requestNotificationAuthorizationIfNeeded()
        guard finalStatus == .authorized || finalStatus == .provisional || finalStatus == .ephemeral else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: "NOT_AUTHORIZED: notifications"))
        }

        let addResult = await self.runNotificationCall(timeoutSeconds: 2.0) { [notificationCenter] in
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            if #available(iOS 15.0, *) {
                switch params.priority ?? .active {
                case .passive:
                    content.interruptionLevel = .passive
                case .timeSensitive:
                    content.interruptionLevel = .timeSensitive
                case .active:
                    content.interruptionLevel = .active
                }
            }
            let soundValue = params.sound?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if let soundValue, ["none", "silent", "off", "false", "0"].contains(soundValue) {
                content.sound = nil
            } else {
                content.sound = .default
            }
            let request = UNNotificationRequest(
                identifier: UUID().uuidString,
                content: content,
                trigger: nil)
            try await notificationCenter.add(request)
        }
        if case let .failure(error) = addResult {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: "NOTIFICATION_FAILED: \(error.message)"))
        }
        return BridgeInvokeResponse(id: req.id, ok: true)
    }

    private func handleChatPushInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(OpenClawChatPushParams.self, from: req.paramsJSON)
        let text = params.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: empty chat.push text"))
        }

        let finalStatus = await self.requestNotificationAuthorizationIfNeeded()
        let messageId = UUID().uuidString
        if finalStatus == .authorized || finalStatus == .provisional || finalStatus == .ephemeral {
            let addResult = await self.runNotificationCall(timeoutSeconds: 2.0) { [notificationCenter] in
                let content = UNMutableNotificationContent()
                content.title = "OpenClaw"
                content.body = text
                content.sound = .default
                content.userInfo = ["messageId": messageId]
                let request = UNNotificationRequest(
                    identifier: messageId,
                    content: content,
                    trigger: nil)
                try await notificationCenter.add(request)
            }
            if case let .failure(error) = addResult {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(code: .unavailable, message: "NOTIFICATION_FAILED: \(error.message)"))
            }
        }

        if params.speak ?? true {
            let toSpeak = text
            Task { @MainActor in
                try? await TalkSystemSpeechSynthesizer.shared.speak(text: toSpeak)
            }
        }

        let payload = OpenClawChatPushPayload(messageId: messageId)
        let json = try Self.encodePayload(payload)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func requestNotificationAuthorizationIfNeeded() async -> NotificationAuthorizationStatus {
        let status = await self.notificationAuthorizationStatus()
        guard status == .notDetermined else { return status }

        // Avoid hanging invoke requests if the permission prompt is never answered.
        _ = await self.runNotificationCall(timeoutSeconds: 2.0) { [notificationCenter] in
            _ = try await notificationCenter.requestAuthorization(options: [.alert, .sound, .badge])
        }

        let updatedStatus = await self.notificationAuthorizationStatus()
        if Self.isNotificationAuthorizationAllowed(updatedStatus) {
            // Refresh APNs registration immediately after the first permission grant so the
            // gateway can receive a push registration without requiring an app relaunch.
            await MainActor.run {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
        return updatedStatus
    }

    private func notificationAuthorizationStatus() async -> NotificationAuthorizationStatus {
        let result = await self.runNotificationCall(timeoutSeconds: 1.5) { [notificationCenter] in
            await notificationCenter.authorizationStatus()
        }
        switch result {
        case let .success(status):
            return status
        case .failure:
            return .denied
        }
    }

    private static func isNotificationAuthorizationAllowed(
        _ status: NotificationAuthorizationStatus) -> Bool
    {
        switch status {
        case .authorized, .provisional, .ephemeral:
            true
        case .denied, .notDetermined:
            false
        }
    }

    private func runNotificationCall<T: Sendable>(
        timeoutSeconds: Double,
        operation: @escaping @Sendable () async throws -> T) async -> Result<T, NotificationCallError>
    {
        let latch = NotificationInvokeLatch<T>()
        var opTask: Task<Void, Never>?
        var timeoutTask: Task<Void, Never>?
        defer {
            opTask?.cancel()
            timeoutTask?.cancel()
        }
        let clamped = max(0.0, timeoutSeconds)
        return await withCheckedContinuation { (cont: CheckedContinuation<Result<T, NotificationCallError>, Never>) in
            latch.setContinuation(cont)
            opTask = Task { @MainActor in
                do {
                    let value = try await operation()
                    latch.resume(.success(value))
                } catch {
                    latch.resume(.failure(NotificationCallError(message: error.localizedDescription)))
                }
            }
            timeoutTask = Task.detached {
                if clamped > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(clamped * 1_000_000_000))
                }
                latch.resume(.failure(NotificationCallError(message: "notification request timed out")))
            }
        }
    }

    private func handleDeviceInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawDeviceCommand.status.rawValue:
            let payload = try await self.deviceStatusService.status()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawDeviceCommand.info.rawValue:
            let payload = self.deviceStatusService.info()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handlePhotosInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = (try? Self.decodeParams(OpenClawPhotosLatestParams.self, from: req.paramsJSON)) ??
            OpenClawPhotosLatestParams()
        let payload = try await self.photosService.latest(params: params)
        let json = try Self.encodePayload(payload)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func handleContactsInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawContactsCommand.search.rawValue:
            let params = (try? Self.decodeParams(OpenClawContactsSearchParams.self, from: req.paramsJSON)) ??
                OpenClawContactsSearchParams()
            let payload = try await self.contactsService.search(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawContactsCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawContactsAddParams.self, from: req.paramsJSON)
            let payload = try await self.contactsService.add(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleCalendarInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawCalendarCommand.events.rawValue:
            let params = (try? Self.decodeParams(OpenClawCalendarEventsParams.self, from: req.paramsJSON)) ??
                OpenClawCalendarEventsParams()
            let payload = try await self.calendarService.events(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawCalendarCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawCalendarAddParams.self, from: req.paramsJSON)
            let payload = try await self.calendarService.add(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleRemindersInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawRemindersCommand.list.rawValue:
            let params = (try? Self.decodeParams(OpenClawRemindersListParams.self, from: req.paramsJSON)) ??
                OpenClawRemindersListParams()
            let payload = try await self.remindersService.list(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawRemindersCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawRemindersAddParams.self, from: req.paramsJSON)
            let payload = try await self.remindersService.add(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleMotionInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawMotionCommand.activity.rawValue:
            let params = (try? Self.decodeParams(OpenClawMotionActivityParams.self, from: req.paramsJSON)) ??
                OpenClawMotionActivityParams()
            let payload = try await self.motionService.activities(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawMotionCommand.pedometer.rawValue:
            let params = (try? Self.decodeParams(OpenClawPedometerParams.self, from: req.paramsJSON)) ??
                OpenClawPedometerParams()
            let payload = try await self.motionService.pedometer(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func handleTalkInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawTalkCommand.pttStart.rawValue:
            self.pttVoiceWakeSuspended = self.voiceWake.suspendForExternalAudioCapture()
            let payload = try await self.talkMode.beginPushToTalk()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawTalkCommand.pttStop.rawValue:
            let payload = await self.talkMode.endPushToTalk()
            self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: self.pttVoiceWakeSuspended)
            self.pttVoiceWakeSuspended = false
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawTalkCommand.pttCancel.rawValue:
            let payload = await self.talkMode.cancelPushToTalk()
            self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: self.pttVoiceWakeSuspended)
            self.pttVoiceWakeSuspended = false
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawTalkCommand.pttOnce.rawValue:
            self.pttVoiceWakeSuspended = self.voiceWake.suspendForExternalAudioCapture()
            defer {
                self.voiceWake.resumeAfterExternalAudioCapture(wasSuspended: self.pttVoiceWakeSuspended)
                self.pttVoiceWakeSuspended = false
            }
            let payload = try await self.talkMode.runPushToTalkOnce()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }
}

extension NodeAppModel {
    /// Central registry for node invoke routing to keep commands in one place.
    private func buildCapabilityRouter() -> NodeCapabilityRouter {
        var handlers: [String: NodeCapabilityRouter.Handler] = [:]

        func register(_ commands: [String], handler: @escaping NodeCapabilityRouter.Handler) {
            for command in commands {
                handlers[command] = handler
            }
        }

        register([OpenClawLocationCommand.get.rawValue]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleLocationInvoke(req)
        }

        register([
            OpenClawCanvasCommand.present.rawValue,
            OpenClawCanvasCommand.hide.rawValue,
            OpenClawCanvasCommand.navigate.rawValue,
            OpenClawCanvasCommand.evalJS.rawValue,
            OpenClawCanvasCommand.snapshot.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleCanvasInvoke(req)
        }

        register([
            OpenClawCanvasA2UICommand.reset.rawValue,
            OpenClawCanvasA2UICommand.push.rawValue,
            OpenClawCanvasA2UICommand.pushJSONL.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleCanvasA2UIInvoke(req)
        }

        register([
            OpenClawCameraCommand.list.rawValue,
            OpenClawCameraCommand.snap.rawValue,
            OpenClawCameraCommand.clip.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleCameraInvoke(req)
        }

        register([OpenClawScreenCommand.record.rawValue]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleScreenRecordInvoke(req)
        }

        register([OpenClawSystemCommand.notify.rawValue]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleSystemNotify(req)
        }

        register([OpenClawChatCommand.push.rawValue]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleChatPushInvoke(req)
        }

        register([
            OpenClawDeviceCommand.status.rawValue,
            OpenClawDeviceCommand.info.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleDeviceInvoke(req)
        }

        register([
            OpenClawWatchCommand.status.rawValue,
            OpenClawWatchCommand.notify.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleWatchInvoke(req)
        }

        register([OpenClawPhotosCommand.latest.rawValue]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handlePhotosInvoke(req)
        }

        register([
            OpenClawContactsCommand.search.rawValue,
            OpenClawContactsCommand.add.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleContactsInvoke(req)
        }

        register([
            OpenClawCalendarCommand.events.rawValue,
            OpenClawCalendarCommand.add.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleCalendarInvoke(req)
        }

        register([
            OpenClawRemindersCommand.list.rawValue,
            OpenClawRemindersCommand.add.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleRemindersInvoke(req)
        }

        register([
            OpenClawMotionCommand.activity.rawValue,
            OpenClawMotionCommand.pedometer.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleMotionInvoke(req)
        }

        register([
            OpenClawTalkCommand.pttStart.rawValue,
            OpenClawTalkCommand.pttStop.rawValue,
            OpenClawTalkCommand.pttCancel.rawValue,
            OpenClawTalkCommand.pttOnce.rawValue,
        ]) { [weak self] req in
            guard let self else { throw NodeCapabilityRouter.RouterError.handlerUnavailable }
            return try await self.handleTalkInvoke(req)
        }

        return NodeCapabilityRouter(handlers: handlers)
    }

    private func handleWatchInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawWatchCommand.status.rawValue:
            let status = await self.watchMessagingService.status()
            let payload = OpenClawWatchStatusPayload(
                supported: status.supported,
                paired: status.paired,
                appInstalled: status.appInstalled,
                reachable: status.reachable,
                activationState: status.activationState)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawWatchCommand.notify.rawValue:
            let params = try Self.decodeParams(OpenClawWatchNotifyParams.self, from: req.paramsJSON)
            let normalizedParams = Self.normalizeWatchNotifyParams(params)
            let title = normalizedParams.title
            let body = normalizedParams.body
            if title.isEmpty, body.isEmpty {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .invalidRequest,
                        message: "INVALID_REQUEST: empty watch notification"))
            }
            do {
                let result = try await self.watchMessagingService.sendNotification(
                    id: req.id,
                    params: normalizedParams)
                if result.queuedForDelivery || !result.deliveredImmediately {
                    let invokeID = req.id
                    Task { @MainActor in
                        await WatchPromptNotificationBridge.scheduleMirroredWatchPromptNotificationIfNeeded(
                            invokeID: invokeID,
                            params: normalizedParams,
                            sendResult: result)
                    }
                }
                let payload = OpenClawWatchNotifyPayload(
                    deliveredImmediately: result.deliveredImmediately,
                    queuedForDelivery: result.queuedForDelivery,
                    transport: result.transport)
                let json = try Self.encodePayload(payload)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
            } catch {
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: error.localizedDescription))
            }
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func locationMode() -> OpenClawLocationMode {
        let raw = UserDefaults.standard.string(forKey: "location.enabledMode") ?? "off"
        return OpenClawLocationMode(rawValue: raw) ?? .off
    }

    private func isLocationPreciseEnabled() -> Bool {
        // iOS settings now expose a single location mode control.
        // Default location tool precision stays high unless a command explicitly requests balanced.
        true
    }

    fileprivate static func decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        guard let json, let data = json.data(using: .utf8) else {
            throw NSError(domain: "Gateway", code: 20, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: paramsJSON required",
            ])
        }
        return try JSONDecoder().decode(type, from: data)
    }

    fileprivate static func encodePayload(_ obj: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(obj)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 21, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode payload as UTF-8",
            ])
        }
        return json
    }

    private func isCameraEnabled() -> Bool {
        // Default-on: if the key doesn't exist yet, treat it as enabled.
        if UserDefaults.standard.object(forKey: "camera.enabled") == nil { return true }
        return UserDefaults.standard.bool(forKey: "camera.enabled")
    }

    private func triggerCameraFlash() {
        self.cameraFlashNonce &+= 1
    }

    private func showCameraHUD(text: String, kind: CameraHUDKind, autoHideSeconds: Double? = nil) {
        self.cameraHUDDismissTask?.cancel()

        withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
            self.cameraHUDText = text
            self.cameraHUDKind = kind
        }

        guard let autoHideSeconds else { return }
        self.cameraHUDDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(autoHideSeconds * 1_000_000_000))
            withAnimation(.easeOut(duration: 0.25)) {
                self.cameraHUDText = nil
                self.cameraHUDKind = nil
            }
        }
    }
}

extension NodeAppModel {
    var mainSessionKey: String {
        let base = SessionKey.normalizeMainKey(self.mainSessionBaseKey)
        let agentId = (self.selectedAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let defaultId = (self.gatewayDefaultAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if agentId.isEmpty || (!defaultId.isEmpty && agentId == defaultId) { return base }
        return SessionKey.makeAgentSessionKey(agentId: agentId, baseKey: base)
    }

    var chatSessionKey: String {
        // Keep chat aligned with the gateway's resolved main session key.
        // A hardcoded "ios" base creates synthetic placeholder sessions in the chat UI.
        self.mainSessionKey
    }

    var activeAgentName: String {
        let agentId = (self.selectedAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let defaultId = (self.gatewayDefaultAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedId = agentId.isEmpty ? defaultId : agentId
        if resolvedId.isEmpty { return "Main" }
        if let match = self.gatewayAgents.first(where: { $0.id == resolvedId }) {
            let name = (match.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? match.id : name
        }
        return resolvedId
    }

    func connectToGateway(
        url: URL,
        gatewayStableID: String,
        tls: GatewayTLSParams?,
        token: String?,
        bootstrapToken: String?,
        password: String?,
        connectOptions: GatewayConnectOptions)
    {
        let stableID = gatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveStableID = stableID.isEmpty ? url.absoluteString : stableID
        let sessionBox = tls.map { WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0)) }

        self.activeGatewayConnectConfig = GatewayConnectConfig(
            url: url,
            stableID: stableID,
            tls: tls,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            nodeOptions: connectOptions)
        self.prepareForGatewayConnect(url: url, stableID: effectiveStableID)
        if self.shouldStartOperatorGatewayLoop(
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            stableID: effectiveStableID)
        {
            self.startOperatorGatewayLoop(
                url: url,
                stableID: effectiveStableID,
                token: token,
                bootstrapToken: bootstrapToken,
                password: password,
                nodeOptions: connectOptions,
                sessionBox: sessionBox)
        } else {
            self.operatorGatewayTask = nil
            Task { await self.operatorGateway.disconnect() }
        }
        self.startNodeGatewayLoop(
            url: url,
            stableID: effectiveStableID,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            nodeOptions: connectOptions,
            sessionBox: sessionBox)
    }

    /// Preferred entry-point: apply a single config object and start both sessions.
    func applyGatewayConnectConfig(_ cfg: GatewayConnectConfig) {
        self.activeGatewayConnectConfig = cfg
        self.connectToGateway(
            url: cfg.url,
            // Preserve the caller-provided stableID (may be empty) and let connectToGateway
            // derive the effective stable id consistently for persistence keys.
            gatewayStableID: cfg.stableID,
            tls: cfg.tls,
            token: cfg.token,
            bootstrapToken: cfg.bootstrapToken,
            password: cfg.password,
            connectOptions: cfg.nodeOptions)
    }

    func disconnectGateway() {
        self.gatewayAutoReconnectEnabled = false
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        self.lastGatewayProblem = nil
        self.nodeGatewayTask?.cancel()
        self.nodeGatewayTask = nil
        self.operatorGatewayTask?.cancel()
        self.operatorGatewayTask = nil
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        LiveActivityManager.shared.handleDisconnect()
        self.gatewayHealthMonitor.stop()
        Task {
            await self.operatorGateway.disconnect()
            await self.nodeGateway.disconnect()
        }
        self.gatewayStatusText = "Offline"
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.connectedGatewayID = nil
        self.activeGatewayConnectConfig = nil
        self.gatewayConnected = false
        self.operatorConnected = false
        self.talkMode.updateGatewayConnected(false)
        self.seamColorHex = nil
        self.mainSessionBaseKey = "main"
        self.talkMode.updateMainSessionKey(self.mainSessionKey)
        ShareGatewayRelaySettings.clearConfig()
        self.showLocalCanvasOnDisconnect()
    }
}

extension NodeAppModel {
    private func prepareForGatewayConnect(url: URL, stableID: String) {
        self.gatewayAutoReconnectEnabled = true
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        self.lastGatewayProblem = nil
        self.nodeGatewayTask?.cancel()
        self.operatorGatewayTask?.cancel()
        self.gatewayHealthMonitor.stop()
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.connectedGatewayID = stableID
        self.gatewayConnected = false
        self.operatorConnected = false
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        LiveActivityManager.shared.handleDisconnect()
        self.gatewayDefaultAgentId = nil
        self.gatewayAgents = []
        self.selectedAgentId = GatewaySettingsStore.loadGatewaySelectedAgentId(stableID: stableID)
        self.homeCanvasRevision &+= 1
        self.apnsLastRegisteredTokenHex = nil
    }

    private func clearGatewayConnectionProblem() {
        self.lastGatewayProblem = nil
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
    }

    private func applyGatewayConnectionProblem(_ problem: GatewayConnectionProblem) {
        self.lastGatewayProblem = problem
        self.gatewayStatusText = problem.statusText
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.gatewayConnected = false
        self.showLocalCanvasOnDisconnect()
        if problem.pauseReconnect {
            self.gatewayAutoReconnectEnabled = false
        }
        if problem.needsPairingApproval {
            self.gatewayPairingPaused = true
            self.gatewayPairingRequestId = problem.requestId
        } else {
            self.gatewayPairingPaused = false
            self.gatewayPairingRequestId = nil
        }
    }

    private func shouldKeepGatewayProblemStatus(forDisconnectReason reason: String) -> Bool {
        guard let lastGatewayProblem else { return false }
        return GatewayConnectionProblemMapper.shouldPreserve(
            previousProblem: lastGatewayProblem,
            overDisconnectReason: reason)
    }

    private func shouldStartOperatorGatewayLoop(
        token: String?,
        bootstrapToken: String?,
        password: String?,
        stableID _: String) -> Bool
    {
        Self.shouldStartOperatorGatewayLoop(
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            hasStoredOperatorToken: self.hasStoredGatewayRoleToken("operator"))
    }

    private func hasStoredGatewayRoleToken(_ role: String) -> Bool {
        let identity = DeviceIdentityStore.loadOrCreate()
        return DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: role) != nil
    }

    fileprivate nonisolated static func shouldStartOperatorGatewayLoop(
        token: String?,
        bootstrapToken: String?,
        password: String?,
        hasStoredOperatorToken: Bool) -> Bool
    {
        let trimmedToken = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedToken.isEmpty {
            return true
        }
        let trimmedPassword = password?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedPassword.isEmpty {
            return true
        }
        let trimmedBootstrapToken = bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedBootstrapToken.isEmpty {
            return false
        }
        return hasStoredOperatorToken
    }

    fileprivate nonisolated static func clearingBootstrapToken(in config: GatewayConnectConfig?)
    -> GatewayConnectConfig? {
        guard let config else { return nil }
        let trimmedBootstrapToken = config.bootstrapToken?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmedBootstrapToken.isEmpty else { return config }
        return GatewayConnectConfig(
            url: config.url,
            stableID: config.stableID,
            tls: config.tls,
            token: config.token,
            bootstrapToken: nil,
            password: config.password,
            nodeOptions: config.nodeOptions)
    }

    private func currentGatewayReconnectAuth(
        fallbackToken: String?,
        fallbackBootstrapToken: String?,
        fallbackPassword: String?) -> (token: String?, bootstrapToken: String?, password: String?)
    {
        if let cfg = self.activeGatewayConnectConfig {
            return (cfg.token, cfg.bootstrapToken, cfg.password)
        }
        return (fallbackToken, fallbackBootstrapToken, fallbackPassword)
    }

    private func clearPersistedGatewayBootstrapTokenIfNeeded() {
        // Always drop the in-memory bootstrap token after the first successful
        // bootstrap connect so reconnect loops cannot reuse a spent token.
        self.activeGatewayConnectConfig = Self.clearingBootstrapToken(in: self.activeGatewayConnectConfig)

        let trimmedInstanceId = UserDefaults.standard.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmedInstanceId.isEmpty else { return }
        guard
            GatewaySettingsStore.loadGatewayBootstrapToken(instanceId: trimmedInstanceId) != nil
        else { return }

        GatewaySettingsStore.clearGatewayBootstrapToken(instanceId: trimmedInstanceId)
    }

    private func handleSuccessfulBootstrapGatewayOnboarding(
        url: URL,
        stableID: String,
        token: String?,
        password: String?,
        nodeOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?) async
    {
        self.clearPersistedGatewayBootstrapTokenIfNeeded()
        if self.operatorGatewayTask == nil, self.shouldStartOperatorGatewayLoop(
            token: token,
            bootstrapToken: nil,
            password: password,
            stableID: stableID)
        {
            self.startOperatorGatewayLoop(
                url: url,
                stableID: stableID,
                token: token,
                bootstrapToken: nil,
                password: password,
                nodeOptions: nodeOptions,
                sessionBox: sessionBox)
        }

        // QR bootstrap onboarding should surface the system notification permission
        // prompt immediately so visible APNs alerts work without a second manual step.
        _ = await self.requestNotificationAuthorizationIfNeeded()
    }

    private func refreshBackgroundReconnectSuppressionIfNeeded(source: String) {
        guard self.isBackgrounded else { return }
        guard !self.backgroundReconnectSuppressed else { return }
        guard let leaseUntil = self.backgroundReconnectLeaseUntil else {
            self.suppressBackgroundReconnect(reason: "\(source):no_lease", disconnectIfNeeded: true)
            return
        }
        if Date() >= leaseUntil {
            self.suppressBackgroundReconnect(reason: "\(source):lease_expired", disconnectIfNeeded: true)
        }
    }

    private func shouldPauseReconnectLoopInBackground(source: String) -> Bool {
        self.refreshBackgroundReconnectSuppressionIfNeeded(source: source)
        return self.isBackgrounded && self.backgroundReconnectSuppressed
    }

    private func startOperatorGatewayLoop(
        url: URL,
        stableID: String,
        token: String?,
        bootstrapToken: String?,
        password: String?,
        nodeOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?)
    {
        // Operator session reconnects independently (chat/talk/config/voicewake), but we tie its
        // lifecycle to the current gateway config so it doesn't keep running across Disconnect.
        self.operatorGatewayTask = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            while !Task.isCancelled {
                if self.gatewayPairingPaused {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
                if !self.gatewayAutoReconnectEnabled {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
                if self.shouldPauseReconnectLoopInBackground(source: "operator_loop") {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    continue
                }
                if await self.isOperatorConnected() {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }

                let reconnectAuth = self.currentGatewayReconnectAuth(
                    fallbackToken: token,
                    fallbackBootstrapToken: bootstrapToken,
                    fallbackPassword: password)
                let effectiveClientId =
                    GatewaySettingsStore.loadGatewayClientIdOverride(stableID: stableID) ?? nodeOptions.clientId
                let operatorOptions = self.makeOperatorConnectOptions(
                    clientId: effectiveClientId,
                    displayName: nodeOptions.clientDisplayName,
                    includeApprovalScope: self.shouldRequestOperatorApprovalScope(
                        token: reconnectAuth.token,
                        password: reconnectAuth.password))

                do {
                    try await self.operatorGateway.connect(
                        url: url,
                        token: reconnectAuth.token,
                        bootstrapToken: reconnectAuth.bootstrapToken,
                        password: reconnectAuth.password,
                        connectOptions: operatorOptions,
                        sessionBox: sessionBox,
                        onConnected: { [weak self] in
                            guard let self else { return }
                            await MainActor.run {
                                self.operatorConnected = true
                                self.talkMode.updateGatewayConnected(true)
                            }
                            GatewayDiagnostics.log(
                                "operator gateway connected host=\(url.host ?? "?") scheme=\(url.scheme ?? "?")")
                            await self.talkMode.reloadConfig()
                            await self.refreshBrandingFromGateway()
                            await self.refreshAgentsFromGateway()
                            await self.refreshShareRouteFromGateway()
                            await self.registerAPNsTokenIfNeeded()
                            await self.startVoiceWakeSync()
                            await MainActor.run { LiveActivityManager.shared.handleReconnect() }
                            await MainActor.run { self.startGatewayHealthMonitor() }
                        },
                        onDisconnected: { [weak self] reason in
                            guard let self else { return }
                            await MainActor.run {
                                self.operatorConnected = false
                                self.talkMode.updateGatewayConnected(false)
                                LiveActivityManager.shared.handleDisconnect()
                            }
                            GatewayDiagnostics.log("operator gateway disconnected reason=\(reason)")
                            await MainActor.run { self.stopGatewayHealthMonitor() }
                        },
                        onInvoke: { req in
                            // Operator session should not handle node.invoke requests.
                            BridgeInvokeResponse(
                                id: req.id,
                                ok: false,
                                error: OpenClawNodeError(
                                    code: .invalidRequest,
                                    message: "INVALID_REQUEST: operator session cannot invoke node commands"))
                        })

                    attempt = 0
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                } catch {
                    attempt += 1
                    GatewayDiagnostics.log("operator gateway connect error: \(error.localizedDescription)")
                    let sleepSeconds = min(8.0, 0.5 * pow(1.7, Double(attempt)))
                    try? await Task.sleep(nanoseconds: UInt64(sleepSeconds * 1_000_000_000))
                }
            }
        }
    }

    // Legacy reconnect state machine; follow-up refactor needed to split into helpers.
    // swiftlint:disable:next function_body_length
    private func startNodeGatewayLoop(
        url: URL,
        stableID: String,
        token: String?,
        bootstrapToken: String?,
        password: String?,
        nodeOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?)
    {
        self.nodeGatewayTask = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            var currentOptions = nodeOptions
            var didFallbackClientId = false
            var pausedForPairingApproval = false

            while !Task.isCancelled {
                if self.gatewayPairingPaused {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
                if !self.gatewayAutoReconnectEnabled {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
                if self.shouldPauseReconnectLoopInBackground(source: "node_loop") {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    continue
                }
                if await self.isGatewayConnected() {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    continue
                }
                await MainActor.run {
                    self.gatewayStatusText = (attempt == 0) ? "Connecting…" : "Reconnecting…"
                    self.gatewayServerName = nil
                    self.gatewayRemoteAddress = nil
                    let liveActivity = LiveActivityManager.shared
                    if liveActivity.isActive {
                        liveActivity.handleConnecting()
                    } else {
                        liveActivity.startActivity(
                            agentName: self.selectedAgentId ?? "main",
                            sessionKey: self.mainSessionKey)
                    }
                }

                do {
                    let epochMs = Int(Date().timeIntervalSince1970 * 1000)
                    let reconnectAuth = self.currentGatewayReconnectAuth(
                        fallbackToken: token,
                        fallbackBootstrapToken: bootstrapToken,
                        fallbackPassword: password)
                    let connectedOptions = currentOptions
                    GatewayDiagnostics.log("connect attempt epochMs=\(epochMs) url=\(url.absoluteString)")
                    try await self.nodeGateway.connect(
                        url: url,
                        token: reconnectAuth.token,
                        bootstrapToken: reconnectAuth.bootstrapToken,
                        password: reconnectAuth.password,
                        connectOptions: connectedOptions,
                        sessionBox: sessionBox,
                        onConnected: { [weak self] in
                            guard let self else { return }
                            await MainActor.run {
                                self.clearGatewayConnectionProblem()
                                self.gatewayStatusText = "Connected"
                                self.gatewayServerName = url.host ?? "gateway"
                                self.gatewayConnected = true
                                self.screen.errorText = nil
                                UserDefaults.standard.set(true, forKey: "gateway.autoconnect")
                            }
                            let usedBootstrapToken =
                                reconnectAuth.token?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false &&
                                reconnectAuth.bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines)
                                .isEmpty == false
                            if usedBootstrapToken {
                                await self.handleSuccessfulBootstrapGatewayOnboarding(
                                    url: url,
                                    stableID: stableID,
                                    token: reconnectAuth.token,
                                    password: reconnectAuth.password,
                                    nodeOptions: connectedOptions,
                                    sessionBox: sessionBox)
                            }
                            let relayData = await MainActor.run {
                                (
                                    sessionKey: self.mainSessionKey,
                                    deliveryChannel: self.shareDeliveryChannel,
                                    deliveryTo: self.shareDeliveryTo)
                            }
                            ShareGatewayRelaySettings.saveConfig(
                                ShareGatewayRelayConfig(
                                    gatewayURLString: url.absoluteString,
                                    token: reconnectAuth.token,
                                    password: reconnectAuth.password,
                                    sessionKey: relayData.sessionKey,
                                    deliveryChannel: relayData.deliveryChannel,
                                    deliveryTo: relayData.deliveryTo))
                            GatewayDiagnostics.log(
                                "gateway connected host=\(url.host ?? "?") "
                                    + "scheme=\(url.scheme ?? "?")")
                            if let addr = await self.nodeGateway.currentRemoteAddress() {
                                await MainActor.run { self.gatewayRemoteAddress = addr }
                            }
                            await self.showA2UIOnConnectIfNeeded()
                            await self.onNodeGatewayConnected()
                            await MainActor.run {
                                SignificantLocationMonitor.startIfNeeded(
                                    locationService: self.locationService,
                                    locationMode: self.locationMode(),
                                    gateway: self.nodeGateway,
                                    beforeSend: { [weak self] in
                                        await self?.handleSignificantLocationWakeIfNeeded()
                                    })
                            }
                        },
                        onDisconnected: { [weak self] reason in
                            guard let self else { return }
                            await MainActor.run {
                                if self.shouldKeepGatewayProblemStatus(forDisconnectReason: reason),
                                   let lastGatewayProblem = self.lastGatewayProblem
                                {
                                    self.gatewayStatusText = lastGatewayProblem.statusText
                                } else {
                                    self.gatewayStatusText = "Disconnected: \(reason)"
                                }
                                self.gatewayServerName = nil
                                self.gatewayRemoteAddress = nil
                                self.gatewayConnected = false
                                self.showLocalCanvasOnDisconnect()
                            }
                            GatewayDiagnostics.log("gateway disconnected reason: \(reason)")
                        },
                        onInvoke: { [weak self] req in
                            guard let self else {
                                return BridgeInvokeResponse(
                                    id: req.id,
                                    ok: false,
                                    error: OpenClawNodeError(
                                        code: .unavailable,
                                        message: "UNAVAILABLE: node not ready"))
                            }
                            return await self.handleInvoke(req)
                        })

                    attempt = 0
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                } catch {
                    if Task.isCancelled { break }
                    if !didFallbackClientId,
                       let fallbackClientId = self.legacyClientIdFallback(
                           currentClientId: currentOptions.clientId,
                           error: error)
                    {
                        didFallbackClientId = true
                        currentOptions.clientId = fallbackClientId
                        GatewaySettingsStore.saveGatewayClientIdOverride(
                            stableID: stableID,
                            clientId: fallbackClientId)
                        await MainActor.run { self.gatewayStatusText = "Gateway rejected client id. Retrying…" }
                        continue
                    }

                    attempt += 1
                    let problem = await MainActor.run {
                        let nextProblem = GatewayConnectionProblemMapper.map(
                            error: error,
                            preserving: self.lastGatewayProblem)
                        if let nextProblem {
                            self.applyGatewayConnectionProblem(nextProblem)
                        } else {
                            self.lastGatewayProblem = nil
                            self.gatewayStatusText = "Gateway error: \(error.localizedDescription)"
                            self.gatewayServerName = nil
                            self.gatewayRemoteAddress = nil
                            self.gatewayConnected = false
                            self.showLocalCanvasOnDisconnect()
                        }
                        return nextProblem
                    }
                    GatewayDiagnostics.log("gateway connect error: \(error.localizedDescription)")

                    if problem?.needsPairingApproval == true {
                        // Hard stop the underlying WebSocket watchdog reconnects so the UI stays stable and
                        // we don't generate multiple pending requests while waiting for approval.
                        pausedForPairingApproval = true
                        self.operatorGatewayTask?.cancel()
                        self.operatorGatewayTask = nil
                        await self.operatorGateway.disconnect()
                        await self.nodeGateway.disconnect()
                        break
                    }

                    if problem?.pauseReconnect == true {
                        continue
                    }

                    let sleepSeconds = min(8.0, 0.5 * pow(1.7, Double(attempt)))
                    try? await Task.sleep(nanoseconds: UInt64(sleepSeconds * 1_000_000_000))
                }
            }

            if pausedForPairingApproval {
                // Leave the status text + request id intact so onboarding can guide the user.
                return
            }

            await MainActor.run {
                self.lastGatewayProblem = nil
                self.gatewayStatusText = "Offline"
                self.gatewayServerName = nil
                self.gatewayRemoteAddress = nil
                self.connectedGatewayID = nil
                self.gatewayConnected = false
                self.operatorConnected = false
                self.talkMode.updateGatewayConnected(false)
                self.seamColorHex = nil
                self.mainSessionBaseKey = "main"
                self.talkMode.updateMainSessionKey(self.mainSessionKey)
                self.showLocalCanvasOnDisconnect()
            }
        }
    }

    private func shouldRequestOperatorApprovalScope(token: String?, password: String?) -> Bool {
        let identity = DeviceIdentityStore.loadOrCreate()
        let storedOperatorScopes = DeviceAuthStore
            .loadToken(deviceId: identity.deviceId, role: "operator")?
            .scopes ?? []
        return Self.shouldRequestOperatorApprovalScope(
            token: token,
            password: password,
            storedOperatorScopes: storedOperatorScopes)
    }

    fileprivate nonisolated static func shouldRequestOperatorApprovalScope(
        token: String?,
        password: String?,
        storedOperatorScopes: [String]) -> Bool
    {
        let trimmedToken = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedToken.isEmpty {
            return true
        }
        let trimmedPassword = password?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedPassword.isEmpty {
            return true
        }
        return storedOperatorScopes.contains("operator.approvals")
    }

    private func makeOperatorConnectOptions(
        clientId: String,
        displayName: String?,
        includeApprovalScope: Bool) -> GatewayConnectOptions
    {
        var scopes = ["operator.read", "operator.write", "operator.talk.secrets"]
        // Preserve reconnect compatibility for older paired operator tokens that were
        // approved before iOS requested operator.approvals by default.
        if includeApprovalScope {
            scopes.append("operator.approvals")
        }
        return GatewayConnectOptions(
            role: "operator",
            scopes: scopes,
            caps: [],
            commands: [],
            permissions: [:],
            clientId: clientId,
            clientMode: "ui",
            clientDisplayName: displayName,
            includeDeviceIdentity: true)
    }

    private func legacyClientIdFallback(currentClientId: String, error: Error) -> String? {
        let normalizedClientId = currentClientId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalizedClientId == "openclaw-ios" else { return nil }
        let message = error.localizedDescription.lowercased()
        guard message.contains("invalid connect params"), message.contains("/client/id") else {
            return nil
        }
        return "moltbot-ios"
    }

    private func isOperatorConnected() async -> Bool {
        self.operatorConnected
    }
}

extension NodeAppModel {
    private struct PendingForegroundNodeAction: Decodable {
        var id: String
        var command: String
        var paramsJSON: String?
        var enqueuedAtMs: Int?
    }

    private struct PendingForegroundNodeActionsResponse: Decodable {
        var nodeId: String?
        var actions: [PendingForegroundNodeAction]
    }

    private struct PendingForegroundNodeActionsAckRequest: Encodable {
        var ids: [String]
    }

    private func refreshShareRouteFromGateway() async {
        struct Params: Codable {
            var includeGlobal: Bool
            var includeUnknown: Bool
            var limit: Int
        }
        struct SessionRow: Decodable {
            var key: String
            var updatedAt: Double?
            var lastChannel: String?
            var lastTo: String?
        }
        struct SessionsListResult: Decodable {
            var sessions: [SessionRow]
        }

        let normalize: (String?) -> String? = { raw in
            let value = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        }

        do {
            let data = try JSONEncoder().encode(
                Params(includeGlobal: true, includeUnknown: false, limit: 80))
            guard let json = String(data: data, encoding: .utf8) else { return }
            let response = try await self.operatorGateway.request(
                method: "sessions.list",
                paramsJSON: json,
                timeoutSeconds: 10)
            let decoded = try JSONDecoder().decode(SessionsListResult.self, from: response)
            let currentKey = self.mainSessionKey
            let sorted = decoded.sessions.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
            let exactMatch = sorted.first { row in
                row.key == currentKey && normalize(row.lastChannel) != nil && normalize(row.lastTo) != nil
            }
            let selected = exactMatch
            let channel = normalize(selected?.lastChannel)
            let to = normalize(selected?.lastTo)

            await MainActor.run {
                self.shareDeliveryChannel = channel
                self.shareDeliveryTo = to
                if let relay = ShareGatewayRelaySettings.loadConfig() {
                    ShareGatewayRelaySettings.saveConfig(
                        ShareGatewayRelayConfig(
                            gatewayURLString: relay.gatewayURLString,
                            token: relay.token,
                            password: relay.password,
                            sessionKey: self.mainSessionKey,
                            deliveryChannel: channel,
                            deliveryTo: to))
                }
            }
        } catch {
            // Best-effort only.
        }
    }

    func runSharePipelineSelfTest() async {
        self.recordShareEvent("Share self-test running…")

        let payload = SharedContentPayload(
            title: "OpenClaw Share Self-Test",
            url: URL(string: "https://openclaw.ai/share-self-test"),
            text: "Validate iOS share->deep-link->gateway forwarding.")
        guard let deepLink = ShareToAgentDeepLink.buildURL(
            from: payload,
            instruction: "Reply with: SHARE SELF-TEST OK")
        else {
            self.recordShareEvent("Self-test failed: could not build deep link.")
            return
        }

        await self.handleDeepLink(url: deepLink)
    }

    func refreshLastShareEventFromRelay() {
        if let event = ShareGatewayRelaySettings.loadLastEvent() {
            self.lastShareEventText = event
        }
    }

    func recordShareEvent(_ text: String) {
        ShareGatewayRelaySettings.saveLastEvent(text)
        self.refreshLastShareEventFromRelay()
    }

    func reloadTalkConfig() {
        Task { [weak self] in
            await self?.talkMode.reloadConfig()
        }
    }

    /// Back-compat hook retained for older gateway-connect flows.
    func onNodeGatewayConnected() async {
        await self.registerAPNsTokenIfNeeded()
        await self.flushQueuedWatchRepliesIfConnected()
        await self.syncWatchExecApprovalSnapshot(reason: "node_connected")
        await self.resumePendingForegroundNodeActionsIfNeeded(trigger: "node_connected")
    }

    private func resumePendingForegroundNodeActionsIfNeeded(trigger: String) async {
        guard !self.isBackgrounded else { return }
        guard await self.isGatewayConnected() else { return }
        guard !self.pendingForegroundActionDrainInFlight else { return }

        self.pendingForegroundActionDrainInFlight = true
        defer { self.pendingForegroundActionDrainInFlight = false }

        do {
            let payload = try await self.nodeGateway.request(
                method: "node.pending.pull",
                paramsJSON: "{}",
                timeoutSeconds: 6)
            let decoded = try JSONDecoder().decode(
                PendingForegroundNodeActionsResponse.self,
                from: payload)
            guard !decoded.actions.isEmpty else { return }
            self.pendingActionLogger
                .info("pending actions trigger=\(trigger, privacy: .public)")
            self.pendingActionLogger.info("pending actions count=\(decoded.actions.count, privacy: .public)")
            await self.applyPendingForegroundNodeActions(decoded.actions, trigger: trigger)
        } catch {
            // Best-effort only.
        }
    }

    private func applyPendingForegroundNodeActions(
        _ actions: [PendingForegroundNodeAction],
        trigger: String) async
    {
        for action in actions {
            guard !self.isBackgrounded else {
                self.pendingActionLogger.info(
                    "Pending action replay paused trigger=\(trigger, privacy: .public): app backgrounded")
                return
            }
            let req = BridgeInvokeRequest(
                id: action.id,
                command: action.command,
                paramsJSON: action.paramsJSON)
            let result = await self.handleInvoke(req)
            self.pendingActionLogger
                .info("pending replay trigger=\(trigger, privacy: .public) id=\(action.id, privacy: .public)")
            self.pendingActionLogger.info("pending replay ok=\(result.ok, privacy: .public)")
            self.pendingActionLogger.info("pending replay command=\(action.command, privacy: .public)")
            guard result.ok else { return }
            let acked = await self.ackPendingForegroundNodeAction(
                id: action.id,
                trigger: trigger,
                command: action.command)
            guard acked else { return }
        }
    }

    private func ackPendingForegroundNodeAction(
        id: String,
        trigger: String,
        command: String) async -> Bool
    {
        do {
            let payload = try JSONEncoder().encode(PendingForegroundNodeActionsAckRequest(ids: [id]))
            let paramsJSON = String(bytes: payload, encoding: .utf8) ?? "{}"
            _ = try await self.nodeGateway.request(
                method: "node.pending.ack",
                paramsJSON: paramsJSON,
                timeoutSeconds: 6)
            return true
        } catch {
            self.pendingActionLogger
                .error("pending ack failed trigger=\(trigger, privacy: .public) id=\(id, privacy: .public)")
            self.pendingActionLogger.error("pending ack command=\(command, privacy: .public)")
            self.pendingActionLogger.error("pending ack error=\(String(describing: error), privacy: .public)")
            return false
        }
    }

    private func handleWatchQuickReply(_ event: WatchQuickReplyEvent) async {
        switch await self.watchReplyCoordinator.ingest(event, isGatewayConnected: self.isGatewayConnected()) {
        case .dropMissingFields:
            self.watchReplyLogger.info("watch reply dropped: missing replyId/actionId")
        case let .deduped(replyId):
            self.watchReplyLogger.debug(
                "watch reply deduped replyId=\(replyId, privacy: .public)")
        case let .queue(replyId, actionId):
            self.watchReplyLogger.info(
                "watch reply queued replyId=\(replyId, privacy: .public) action=\(actionId, privacy: .public)")
        case .forward:
            await self.forwardWatchReplyToAgent(event)
        }
    }

    private func flushQueuedWatchRepliesIfConnected() async {
        for event in await self.watchReplyCoordinator.drainIfConnected(self.isGatewayConnected()) {
            await self.forwardWatchReplyToAgent(event)
        }
    }

    private func forwardWatchReplyToAgent(_ event: WatchQuickReplyEvent) async {
        let sessionKey = event.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveSessionKey = (sessionKey?.isEmpty == false) ? sessionKey : self.mainSessionKey
        let message = Self.makeWatchReplyAgentMessage(event)
        let link = AgentDeepLink(
            message: message,
            sessionKey: effectiveSessionKey,
            thinking: "low",
            deliver: false,
            to: nil,
            channel: nil,
            timeoutSeconds: nil,
            key: event.replyId)
        do {
            try await self.sendAgentRequest(link: link)
            let forwardedMessage =
                "watch reply forwarded replyId=\(event.replyId) "
                    + "action=\(event.actionId)"
            self.watchReplyLogger.info("\(forwardedMessage, privacy: .public)")
            self.openChatRequestID &+= 1
        } catch {
            let failedMessage =
                "watch reply forwarding failed replyId=\(event.replyId) "
                    + "error=\(error.localizedDescription)"
            self.watchReplyLogger.error("\(failedMessage, privacy: .public)")
            self.watchReplyCoordinator.requeueFront(event)
        }
    }

    private static func makeWatchReplyAgentMessage(_ event: WatchQuickReplyEvent) -> String {
        let actionLabel = event.actionLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
        let promptId = event.promptId.trimmingCharacters(in: .whitespacesAndNewlines)
        let transport = event.transport.trimmingCharacters(in: .whitespacesAndNewlines)
        let summary = actionLabel?.isEmpty == false ? actionLabel! : event.actionId
        var lines: [String] = []
        lines.append("Watch reply: \(summary)")
        lines.append("promptId=\(promptId.isEmpty ? "unknown" : promptId)")
        lines.append("actionId=\(event.actionId)")
        lines.append("replyId=\(event.replyId)")
        if !transport.isEmpty {
            lines.append("transport=\(transport)")
        }
        if let sentAtMs = event.sentAtMs {
            lines.append("sentAtMs=\(sentAtMs)")
        }
        if let note = event.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
            lines.append("note=\(note)")
        }
        return lines.joined(separator: "\n")
    }

    private func restorePersistedWatchExecApprovalBridgeState() {
        guard let data = UserDefaults.standard.data(forKey: Self.watchExecApprovalBridgeStateKey),
              let state = try? JSONDecoder().decode(PersistedWatchExecApprovalBridgeState.self, from: data)
        else {
            return
        }
        self.watchExecApprovalPromptsByID = Dictionary(
            uniqueKeysWithValues: state.approvals.map { ($0.id, $0) })
        self.pendingWatchExecApprovalRecoveryIDs = (state.pendingApprovalIDs ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .sorted()
        self.pruneExpiredWatchExecApprovalPrompts()
    }

    private func persistWatchExecApprovalBridgeState() {
        self.pruneExpiredWatchExecApprovalPrompts()
        let approvals = self.watchExecApprovalPromptsByID.values.sorted { lhs, rhs in
            let lhsExpires = lhs.expiresAtMs ?? Int.max
            let rhsExpires = rhs.expiresAtMs ?? Int.max
            if lhsExpires != rhsExpires {
                return lhsExpires < rhsExpires
            }
            return lhs.id < rhs.id
        }
        let pendingApprovalIDs = self.pendingWatchExecApprovalRecoveryIDs
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .sorted()
        guard let data = try? JSONEncoder().encode(
            PersistedWatchExecApprovalBridgeState(
                approvals: approvals,
                pendingApprovalIDs: pendingApprovalIDs))
        else {
            return
        }
        UserDefaults.standard.set(data, forKey: Self.watchExecApprovalBridgeStateKey)
    }

    private func pruneExpiredWatchExecApprovalPrompts(nowMs: Int? = nil) {
        let currentNowMs = nowMs ?? Int(Date().timeIntervalSince1970 * 1000)
        self.watchExecApprovalPromptsByID = self.watchExecApprovalPromptsByID.filter { _, prompt in
            guard let expiresAtMs = prompt.expiresAtMs else { return true }
            return expiresAtMs > currentNowMs
        }
    }

    private func handleWatchMessagingStatusChanged(_ status: WatchMessagingStatus) async {
        GatewayDiagnostics.log(
            "watch exec approval: status changed "
                + "reachable=\(status.reachable) activation=\(status.activationState) "
                + "backgrounded=\(self.isBackgrounded)")
        guard self.isBackgrounded else { return }
        guard status.supported, status.paired, status.appInstalled else { return }
        guard status.reachable || status.activationState == "activated" else { return }
        let reason = status.reachable ? "watch_reachable" : "watch_activated"
        await self.syncWatchExecApprovalSnapshot(reason: reason)
    }

    private func appendPendingWatchExecApprovalRecoveryID(_ approvalId: String) {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return }
        guard !self.pendingWatchExecApprovalRecoveryIDs.contains(normalizedApprovalID) else { return }
        self.pendingWatchExecApprovalRecoveryIDs.append(normalizedApprovalID)
        self.pendingWatchExecApprovalRecoveryIDs.sort()
        GatewayDiagnostics.log(
            "watch exec approval: queued recovery "
                + "id=\(normalizedApprovalID) pendingCount=\(self.pendingWatchExecApprovalRecoveryIDs.count)")
        self.persistWatchExecApprovalBridgeState()
    }

    private func removePendingWatchExecApprovalRecoveryID(_ approvalId: String) {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return }
        let originalCount = self.pendingWatchExecApprovalRecoveryIDs.count
        self.pendingWatchExecApprovalRecoveryIDs.removeAll { $0 == normalizedApprovalID }
        guard self.pendingWatchExecApprovalRecoveryIDs.count != originalCount else { return }
        GatewayDiagnostics.log(
            "watch exec approval: cleared recovery "
                + "id=\(normalizedApprovalID) pendingCount=\(self.pendingWatchExecApprovalRecoveryIDs.count)")
        self.persistWatchExecApprovalBridgeState()
    }

    private func upsertWatchExecApprovalPrompt(_ prompt: ExecApprovalPrompt) {
        self.watchExecApprovalPromptsByID[prompt.id] = prompt
        self.removePendingWatchExecApprovalRecoveryID(prompt.id)
        self.persistWatchExecApprovalBridgeState()
    }

    private func removeWatchExecApprovalPrompt(_ approvalId: String) {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return }
        self.watchExecApprovalPromptsByID.removeValue(forKey: normalizedApprovalID)
        self.removePendingWatchExecApprovalRecoveryID(normalizedApprovalID)
        self.persistWatchExecApprovalBridgeState()
    }

    private static func makeWatchExecApprovalItem(from prompt: ExecApprovalPrompt) -> OpenClawWatchExecApprovalItem {
        let decisions = prompt.allowedDecisions.compactMap { decision in
            let normalizedDecision = decision.trimmingCharacters(in: .whitespacesAndNewlines)
            return OpenClawWatchExecApprovalDecision(rawValue: normalizedDecision)
        }
        let preview = Self.trimmedOrNil(prompt.commandPreview) ?? Self.trimmedOrNil(prompt.commandText)
        return OpenClawWatchExecApprovalItem(
            id: prompt.id,
            commandText: prompt.commandText,
            commandPreview: preview,
            host: Self.trimmedOrNil(prompt.host),
            nodeId: Self.trimmedOrNil(prompt.nodeId),
            agentId: Self.trimmedOrNil(prompt.agentId),
            expiresAtMs: prompt.expiresAtMs,
            allowedDecisions: decisions,
            // Prefer the watch's neutral/default presentation until exec.approval.get
            // carries an explicit risk signal for exec approvals.
            risk: nil)
    }

    private nonisolated static func shouldResetWatchExecApprovalResolvingStateOnPrompt(
        reason: String) -> Bool
    {
        reason == "resolve_retry"
    }

    private func publishWatchExecApprovalPrompt(_ prompt: ExecApprovalPrompt, reason: String) async {
        let message = OpenClawWatchExecApprovalPromptMessage(
            approval: Self.makeWatchExecApprovalItem(from: prompt),
            sentAtMs: Int(Date().timeIntervalSince1970 * 1000),
            deliveryId: UUID().uuidString,
            resetResolvingState: Self.shouldResetWatchExecApprovalResolvingStateOnPrompt(reason: reason))
        do {
            _ = try await self.watchMessagingService.sendExecApprovalPrompt(message)
            self.watchExecApprovalLogger.debug(
                "watch exec approval prompt sent id=\(prompt.id, privacy: .public) reason=\(reason, privacy: .public)")
        } catch {
            self.watchExecApprovalLogger
                .error(
                    "watch approval prompt failed id=\(prompt.id, privacy: .public) reason=\(reason, privacy: .public)")
            self.watchExecApprovalLogger.error(
                "watch approval prompt error=\(error.localizedDescription, privacy: .public)")
        }
        await self.syncWatchExecApprovalSnapshot(reason: "\(reason)_snapshot")
    }

    private func publishWatchExecApprovalResolved(
        approvalId: String,
        decision: OpenClawWatchExecApprovalDecision?,
        source: String) async
    {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return }
        self.removeWatchExecApprovalPrompt(normalizedApprovalID)
        let message = OpenClawWatchExecApprovalResolvedMessage(
            approvalId: normalizedApprovalID,
            decision: decision,
            resolvedAtMs: Int(Date().timeIntervalSince1970 * 1000),
            source: source)
        do {
            _ = try await self.watchMessagingService.sendExecApprovalResolved(message)
        } catch {
            self.watchExecApprovalLogger
                .error(
                    "watch approval resolve failed id=\(normalizedApprovalID, privacy: .public)")
            self.watchExecApprovalLogger.error(
                "watch approval resolve error=\(error.localizedDescription, privacy: .public)")
        }
        await self.syncWatchExecApprovalSnapshot(reason: "resolved_snapshot")
    }

    private func publishWatchExecApprovalExpired(
        approvalId: String,
        reason: OpenClawWatchExecApprovalCloseReason) async
    {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return }
        self.removeWatchExecApprovalPrompt(normalizedApprovalID)
        let message = OpenClawWatchExecApprovalExpiredMessage(
            approvalId: normalizedApprovalID,
            reason: reason,
            expiredAtMs: Int(Date().timeIntervalSince1970 * 1000))
        do {
            _ = try await self.watchMessagingService.sendExecApprovalExpired(message)
        } catch {
            self.watchExecApprovalLogger
                .error(
                    "watch approval expiry failed id=\(normalizedApprovalID, privacy: .public)")
            self.watchExecApprovalLogger.error(
                "watch approval expiry error=\(error.localizedDescription, privacy: .public)")
        }
        await self.syncWatchExecApprovalSnapshot(reason: "expired_\(reason.rawValue)")
    }

    private func syncWatchExecApprovalSnapshot(reason: String) async {
        self.pruneExpiredWatchExecApprovalPrompts()
        GatewayDiagnostics.log(
            "watch exec approval: sync snapshot start "
                + "reason=\(reason) cacheCount=\(self.watchExecApprovalPromptsByID.count) "
                + "backgrounded=\(self.isBackgrounded)")
        let approvals = self.watchExecApprovalPromptsByID.values
            .sorted { lhs, rhs in
                let lhsExpires = lhs.expiresAtMs ?? Int.max
                let rhsExpires = rhs.expiresAtMs ?? Int.max
                if lhsExpires != rhsExpires {
                    return lhsExpires < rhsExpires
                }
                return lhs.id < rhs.id
            }
            .map(Self.makeWatchExecApprovalItem)
        let message = OpenClawWatchExecApprovalSnapshotMessage(
            approvals: approvals,
            sentAtMs: Int(Date().timeIntervalSince1970 * 1000),
            snapshotId: UUID().uuidString)
        do {
            _ = try await self.watchMessagingService.syncExecApprovalSnapshot(message)
            GatewayDiagnostics.log(
                "watch exec approval: sync snapshot sent reason=\(reason) count=\(approvals.count)")
            self.watchExecApprovalLogger
                .debug("watch approval snapshot reason=\(reason, privacy: .public)")
            self.watchExecApprovalLogger.debug(
                "watch approval snapshot count=\(approvals.count, privacy: .public)")
        } catch {
            GatewayDiagnostics.log(
                "watch exec approval: sync snapshot failed reason=\(reason) error=\(error.localizedDescription)")
            self.watchExecApprovalLogger
                .error(
                    "watch approval snapshot failed reason=\(reason, privacy: .public)")
            self.watchExecApprovalLogger.error(
                "watch approval snapshot error=\(error.localizedDescription, privacy: .public)")
        }
    }

    private func refreshWatchExecApprovalSnapshotOnDemand(reason: String) async {
        GatewayDiagnostics.log("watch exec approval: refresh on demand start reason=\(reason)")
        await self.hydrateWatchExecApprovalCacheIfNeeded(reason: reason)
        await self.syncWatchExecApprovalSnapshot(reason: reason)
        GatewayDiagnostics.log("watch exec approval: refresh on demand end reason=\(reason)")
    }

    private nonisolated static func watchExecApprovalIDsNeedingFetch(
        candidateIDs: [String],
        cachedApprovalIDs: [String]) -> [String]
    {
        let cachedIDs = Set(cachedApprovalIDs.compactMap { id -> String? in
            let normalizedID = id.trimmingCharacters(in: .whitespacesAndNewlines)
            return normalizedID.isEmpty ? nil : normalizedID
        })
        var idsToFetch: [String] = []
        var seen = Set<String>()
        for rawID in candidateIDs {
            let normalizedID = rawID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalizedID.isEmpty else { continue }
            guard seen.insert(normalizedID).inserted else { continue }
            guard !cachedIDs.contains(normalizedID) else { continue }
            idsToFetch.append(normalizedID)
        }
        return idsToFetch
    }

    private func hydrateWatchExecApprovalCacheIfNeeded(reason: String) async {
        self.pruneExpiredWatchExecApprovalPrompts()

        let approvalIDs = await self.pendingExecApprovalIDsForWatchRecovery()
        let missingApprovalIDs = Self.watchExecApprovalIDsNeedingFetch(
            candidateIDs: approvalIDs,
            cachedApprovalIDs: Array(self.watchExecApprovalPromptsByID.keys))
        GatewayDiagnostics.log(
            "watch exec approval: hydrate candidates "
                + "reason=\(reason) ids=\(approvalIDs.joined(separator: ",")) "
                + "missing=\(missingApprovalIDs.joined(separator: ",")) "
                + "cached=\(self.watchExecApprovalPromptsByID.count)")
        guard !missingApprovalIDs.isEmpty else {
            self.watchExecApprovalLogger.debug(
                "watch exec approval hydrate skipped reason=\(reason, privacy: .public): no missing approval ids")
            return
        }

        for approvalId in missingApprovalIDs {
            GatewayDiagnostics.log(
                "watch exec approval: hydrate fetch start id=\(approvalId) reason=\(reason)")
            let outcome = await self.fetchExecApprovalPrompt(
                approvalId: approvalId,
                sourceReason: reason)
            switch outcome {
            case let .loaded(prompt):
                GatewayDiagnostics.log("watch exec approval: hydrate fetch loaded id=\(approvalId)")
                self.upsertWatchExecApprovalPrompt(prompt)
            case .stale:
                GatewayDiagnostics.log("watch exec approval: hydrate fetch stale id=\(approvalId)")
                self.removePendingWatchExecApprovalRecoveryID(approvalId)
                await ExecApprovalNotificationBridge.removeNotifications(
                    forApprovalID: approvalId,
                    notificationCenter: self.notificationCenter)
            case let .failed(message):
                self.watchExecApprovalLogger
                    .error("watch approval hydrate failed id=\(approvalId, privacy: .public)")
                self.watchExecApprovalLogger.error("watch approval hydrate reason=\(reason, privacy: .public)")
                self.watchExecApprovalLogger.error("watch approval hydrate error=\(message, privacy: .public)")
            }
        }
    }

    private func pendingExecApprovalIDsForWatchRecovery() async -> [String] {
        var ids: [String] = []
        var seen = Set<String>()

        func append(_ rawID: String?) {
            let approvalId = rawID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !approvalId.isEmpty, seen.insert(approvalId).inserted else { return }
            ids.append(approvalId)
        }

        append(self.pendingExecApprovalPrompt?.id)
        for approvalId in self.pendingWatchExecApprovalRecoveryIDs {
            append(approvalId)
        }
        for approvalId in self.watchExecApprovalPromptsByID.keys.sorted() {
            append(approvalId)
        }

        let delivered = await self.notificationCenter.deliveredNotifications()
        GatewayDiagnostics.log("watch exec approval: delivered notifications count=\(delivered.count)")
        for snapshot in delivered {
            guard ExecApprovalNotificationBridge.payloadKind(userInfo: snapshot.userInfo)
                == ExecApprovalNotificationBridge.requestedKind
            else {
                continue
            }
            append(ExecApprovalNotificationBridge.approvalID(from: snapshot.userInfo))
        }

        return ids
    }

    private func handleWatchExecApprovalResolve(_ event: WatchExecApprovalResolveEvent) async {
        let normalizedApprovalID = event.approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return }
        if self.pendingExecApprovalPrompt?.id == normalizedApprovalID {
            self.pendingExecApprovalPromptResolving = true
            self.pendingExecApprovalPromptErrorText = nil
        }
        let outcome = await self.resolveExecApprovalNotificationDecision(
            approvalId: normalizedApprovalID,
            decision: event.decision.rawValue,
            sourceReason: "watch_resolve")
        if case let .failed(message) = outcome {
            if self.pendingExecApprovalPrompt?.id == normalizedApprovalID {
                self.pendingExecApprovalPromptResolving = false
                self.pendingExecApprovalPromptErrorText = message
            }
            if let prompt = self.watchExecApprovalPromptsByID[normalizedApprovalID] {
                await self.publishWatchExecApprovalPrompt(prompt, reason: "resolve_retry")
            }
        }
    }

    func handleExecApprovalRequestedRemotePush(approvalId: String) async -> Bool {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return false }
        self.appendPendingWatchExecApprovalRecoveryID(normalizedApprovalID)
        let fetchedPrompt = await self.fetchExecApprovalPrompt(
            approvalId: normalizedApprovalID,
            sourceReason: "push_request")
        switch fetchedPrompt {
        case let .loaded(prompt):
            self.upsertWatchExecApprovalPrompt(prompt)
            await self.publishWatchExecApprovalPrompt(prompt, reason: "push_request")
            return true
        case .stale:
            await ExecApprovalNotificationBridge.removeNotifications(
                forApprovalID: normalizedApprovalID,
                notificationCenter: self.notificationCenter)
            self.clearPendingExecApprovalPromptIfMatches(normalizedApprovalID)
            await self.publishWatchExecApprovalExpired(
                approvalId: normalizedApprovalID,
                reason: .notFound)
            return true
        case let .failed(message):
            self.watchExecApprovalLogger
                .error(
                    "watch approval push fetch failed id=\(normalizedApprovalID, privacy: .public)")
            self.watchExecApprovalLogger.error("watch approval push fetch error=\(message, privacy: .public)")
            return false
        }
    }

    func handleExecApprovalResolvedRemotePush(approvalId: String) async {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return }

        let hadWatchPrompt = self.watchExecApprovalPromptsByID[normalizedApprovalID] != nil
        let hadPendingPrompt = self.pendingExecApprovalPrompt?.id == normalizedApprovalID
        let hadPendingRecoveryID = self.pendingWatchExecApprovalRecoveryIDs.contains(normalizedApprovalID)
        guard hadWatchPrompt || hadPendingPrompt || hadPendingRecoveryID else {
            return
        }

        await self.publishWatchExecApprovalExpired(approvalId: normalizedApprovalID, reason: .resolved)
        self.clearPendingExecApprovalPromptIfMatches(normalizedApprovalID)
    }

    func handleSilentPushWake(_ userInfo: [AnyHashable: Any]) async -> Bool {
        let wakeId = Self.makePushWakeAttemptID()
        guard Self.isSilentPushPayload(userInfo) else {
            self.pushWakeLogger.info("Ignored APNs payload wakeId=\(wakeId, privacy: .public): not silent push")
            return false
        }
        let pushKind = Self.openclawPushKind(userInfo)
        let receivedMessage =
            "Silent push received wakeId=\(wakeId) "
                + "kind=\(pushKind) "
                + "backgrounded=\(self.isBackgrounded) "
                + "autoReconnect=\(self.gatewayAutoReconnectEnabled)"
        self.pushWakeLogger.info("\(receivedMessage, privacy: .public)")

        if await ExecApprovalNotificationBridge.handleResolvedPushIfNeeded(
            userInfo: userInfo,
            notificationCenter: self.notificationCenter)
        {
            if let approvalId = ExecApprovalNotificationBridge.approvalID(from: userInfo) {
                await self.handleExecApprovalResolvedRemotePush(approvalId: approvalId)
            }
            self.execApprovalNotificationLogger.info(
                "Handled exec approval cleanup push wakeId=\(wakeId, privacy: .public)")
            return true
        }

        let execApprovalPushKind = ExecApprovalNotificationBridge.payloadKind(userInfo: userInfo)
        let isExecApprovalRequestPush = execApprovalPushKind == ExecApprovalNotificationBridge.requestedKind
        if isExecApprovalRequestPush,
           let approvalId = ExecApprovalNotificationBridge.approvalID(from: userInfo)
        {
            let handled = await self.handleExecApprovalRequestedRemotePush(approvalId: approvalId)
            if handled {
                self.execApprovalNotificationLogger
                    .info(
                        "handled approval push wakeId=\(wakeId, privacy: .public) id=\(approvalId, privacy: .public)")
            }
            return handled
        }

        let result = await self.performBackgroundAliveBeaconIfNeeded(
            wakeId: wakeId,
            trigger: .silentPush)
        let outcomeMessage =
            "Silent push outcome wakeId=\(wakeId) "
                + "applied=\(result.applied) "
                + "handled=\(result.handled) "
                + "reason=\(result.reason) "
                + "durationMs=\(result.durationMs)"
        self.pushWakeLogger.info("\(outcomeMessage, privacy: .public)")
        return result.handled
    }

    func handleBackgroundRefreshWake(trigger: String = "bg_app_refresh") async -> Bool {
        let wakeId = Self.makePushWakeAttemptID()
        let normalizedTrigger = BackgroundAliveBeacon.normalizeTrigger(trigger)
        let receivedMessage =
            "Background refresh wake received wakeId=\(wakeId) "
                + "trigger=\(normalizedTrigger.rawValue) "
                + "backgrounded=\(self.isBackgrounded) "
                + "autoReconnect=\(self.gatewayAutoReconnectEnabled)"
        self.pushWakeLogger.info("\(receivedMessage, privacy: .public)")
        let result = await self.performBackgroundAliveBeaconIfNeeded(
            wakeId: wakeId,
            trigger: normalizedTrigger)
        let outcomeMessage =
            "Background refresh wake outcome wakeId=\(wakeId) "
                + "applied=\(result.applied) "
                + "handled=\(result.handled) "
                + "reason=\(result.reason) "
                + "durationMs=\(result.durationMs)"
        self.pushWakeLogger.info("\(outcomeMessage, privacy: .public)")
        return result.handled
    }

    func handleSignificantLocationWakeIfNeeded() async {
        let wakeId = Self.makePushWakeAttemptID()
        let now = Date()
        let throttleWindowSeconds: TimeInterval = 180

        if await self.isGatewayConnected() {
            self.locationWakeLogger.info(
                "Location wake no-op wakeId=\(wakeId, privacy: .public): already connected")
            return
        }
        if let last = self.lastSignificantLocationWakeAt,
           now.timeIntervalSince(last) < throttleWindowSeconds
        {
            let throttledMessage =
                "Location wake throttled wakeId=\(wakeId) "
                    + "elapsedSec=\(now.timeIntervalSince(last))"
            self.locationWakeLogger.info("\(throttledMessage, privacy: .public)")
            return
        }
        self.lastSignificantLocationWakeAt = now

        let beginMessage =
            "Location wake begin wakeId=\(wakeId) "
                + "backgrounded=\(self.isBackgrounded) "
                + "autoReconnect=\(self.gatewayAutoReconnectEnabled)"
        self.locationWakeLogger.info("\(beginMessage, privacy: .public)")
        let result = await self.performBackgroundAliveBeaconIfNeeded(
            wakeId: wakeId,
            trigger: .significantLocation)
        let triggerMessage =
            "Location wake trigger wakeId=\(wakeId) "
                + "applied=\(result.applied) "
                + "handled=\(result.handled) "
                + "reason=\(result.reason) "
                + "durationMs=\(result.durationMs)"
        self.locationWakeLogger.info("\(triggerMessage, privacy: .public)")

        guard result.applied else { return }
        let connected = await self.waitForGatewayConnection(timeoutMs: 5000, pollMs: 250)
        self.locationWakeLogger.info(
            "Location wake post-check wakeId=\(wakeId, privacy: .public) connected=\(connected, privacy: .public)")
    }

    func updateAPNsDeviceToken(_ tokenData: Data) {
        let tokenHex = tokenData.map { String(format: "%02x", $0) }.joined()
        let trimmed = tokenHex.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.apnsDeviceTokenHex = trimmed
        UserDefaults.standard.set(trimmed, forKey: Self.apnsDeviceTokenUserDefaultsKey)
        Task { [weak self] in
            await self?.registerAPNsTokenIfNeeded()
        }
    }

    private func registerAPNsTokenIfNeeded() async {
        guard self.gatewayConnected else { return }
        guard let token = self.apnsDeviceTokenHex?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty
        else {
            return
        }
        let usesRelayTransport = await self.pushRegistrationManager.usesRelayTransport
        if !usesRelayTransport, token == self.apnsLastRegisteredTokenHex {
            return
        }
        guard let topic = Bundle.main.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
              !topic.isEmpty
        else {
            return
        }

        do {
            let gatewayIdentity: PushRelayGatewayIdentity?
            if usesRelayTransport {
                guard self.operatorConnected else { return }
                gatewayIdentity = try await self.fetchPushRelayGatewayIdentity()
            } else {
                gatewayIdentity = nil
            }
            let payloadJSON = try await self.pushRegistrationManager.makeGatewayRegistrationPayload(
                apnsTokenHex: token,
                topic: topic,
                gatewayIdentity: gatewayIdentity)
            await self.nodeGateway.sendEvent(event: "push.apns.register", payloadJSON: payloadJSON)
            self.apnsLastRegisteredTokenHex = token
        } catch {
            self.pushWakeLogger.error(
                "APNs registration publish failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func fetchPushRelayGatewayIdentity() async throws -> PushRelayGatewayIdentity {
        let response = try await self.operatorGateway.request(
            method: "gateway.identity.get",
            paramsJSON: "{}",
            timeoutSeconds: 8)
        let decoded = try JSONDecoder().decode(GatewayRelayIdentityResponse.self, from: response)
        let deviceId = decoded.deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
        let publicKey = decoded.publicKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !deviceId.isEmpty, !publicKey.isEmpty else {
            throw PushRelayError.relayMisconfigured("Gateway identity response missing required fields")
        }
        return PushRelayGatewayIdentity(deviceId: deviceId, publicKey: publicKey)
    }

    private static func isSilentPushPayload(_ userInfo: [AnyHashable: Any]) -> Bool {
        guard let apsAny = userInfo["aps"] else { return false }
        if let aps = apsAny as? [AnyHashable: Any] {
            return Self.hasContentAvailable(aps["content-available"])
        }
        if let aps = apsAny as? [String: Any] {
            return Self.hasContentAvailable(aps["content-available"])
        }
        return false
    }

    private static func hasContentAvailable(_ value: Any?) -> Bool {
        if let number = value as? NSNumber {
            return number.intValue == 1
        }
        if let text = value as? String {
            return text.trimmingCharacters(in: .whitespacesAndNewlines) == "1"
        }
        return false
    }

    private static func makePushWakeAttemptID() -> String {
        let raw = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        return String(raw.prefix(8))
    }

    private static func openclawPushKind(_ userInfo: [AnyHashable: Any]) -> String {
        if let payload = userInfo["openclaw"] as? [String: Any],
           let kind = payload["kind"] as? String
        {
            let trimmed = kind.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        if let payload = userInfo["openclaw"] as? [AnyHashable: Any],
           let kind = payload["kind"] as? String
        {
            let trimmed = kind.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return "unknown"
    }

    private struct ExecApprovalGetRequest: Encodable {
        let id: String
    }

    private struct ExecApprovalResolveRequest: Encodable {
        let id: String
        let decision: String
    }

    private struct ExecApprovalGetResponse: Decodable {
        var id: String
        var commandText: String
        var commandPreview: String?
        var allowedDecisions: [String]
        var host: String?
        var nodeId: String?
        var agentId: String?
        var expiresAtMs: Int?
    }

    func presentExecApprovalNotificationPrompt(_ prompt: ExecApprovalNotificationPrompt) async {
        let approvalId = prompt.approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !approvalId.isEmpty else { return }

        self.pendingExecApprovalPromptRequestGeneration &+= 1
        let requestGeneration = self.pendingExecApprovalPromptRequestGeneration
        self.pendingExecApprovalPromptResolving = true
        self.pendingExecApprovalPromptErrorText = nil

        let fetchedPrompt = await self.fetchExecApprovalPrompt(approvalId: approvalId)
        guard self.pendingExecApprovalPromptRequestGeneration == requestGeneration else {
            return
        }
        self.pendingExecApprovalPromptResolving = false
        switch fetchedPrompt {
        case let .loaded(fetchedPrompt):
            self.presentFetchedExecApprovalPrompt(fetchedPrompt)
        case .stale:
            await ExecApprovalNotificationBridge.removeNotifications(
                forApprovalID: approvalId,
                notificationCenter: self.notificationCenter)
            self.clearPendingExecApprovalPromptIfMatches(approvalId)
            await self.publishWatchExecApprovalExpired(approvalId: approvalId, reason: .notFound)
        case let .failed(message):
            self.execApprovalNotificationLogger
                .error("approval prompt fetch failed id=\(approvalId, privacy: .public)")
            self.execApprovalNotificationLogger.error("approval prompt fetch reason=\(message, privacy: .public)")
        }
    }

    private enum ExecApprovalPromptFetchOutcome {
        case loaded(ExecApprovalPrompt)
        case stale
        case failed(message: String)
    }

    private func presentFetchedExecApprovalPrompt(_ prompt: ExecApprovalPrompt) {
        self.pendingExecApprovalPrompt = prompt
        self.pendingExecApprovalPromptResolving = false
        self.pendingExecApprovalPromptErrorText = nil
        self.upsertWatchExecApprovalPrompt(prompt)
        Task { @MainActor [weak self] in
            await self?.publishWatchExecApprovalPrompt(prompt, reason: "present_prompt")
        }
    }

    private static func makeExecApprovalPrompt(from details: ExecApprovalGetResponse) -> ExecApprovalPrompt? {
        let approvalId = details.id.trimmingCharacters(in: .whitespacesAndNewlines)
        let commandText = details.commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !approvalId.isEmpty, !commandText.isEmpty else { return nil }
        return ExecApprovalPrompt(
            id: approvalId,
            commandText: commandText,
            commandPreview: details.commandPreview?.trimmingCharacters(in: .whitespacesAndNewlines),
            allowedDecisions: details.allowedDecisions.compactMap { decision in
                let trimmed = decision.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            },
            host: details.host?.trimmingCharacters(in: .whitespacesAndNewlines),
            nodeId: details.nodeId?.trimmingCharacters(in: .whitespacesAndNewlines),
            agentId: details.agentId?.trimmingCharacters(in: .whitespacesAndNewlines),
            expiresAtMs: details.expiresAtMs)
    }

    private nonisolated static func shouldUseBackgroundAwareExecApprovalReconnect(
        sourceReason: String,
        isBackgrounded: Bool) -> Bool
    {
        guard isBackgrounded else { return false }
        switch sourceReason {
        case "watch_request", "push_request", "watch_resolve", "notification_action":
            return true
        default:
            return false
        }
    }

    private func fetchExecApprovalPrompt(
        approvalId: String,
        sourceReason: String? = nil) async -> ExecApprovalPromptFetchOutcome
    {
        let normalizedSourceReason = sourceReason?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fetchReason: String = if let normalizedSourceReason, !normalizedSourceReason.isEmpty {
            normalizedSourceReason
        } else {
            "direct"
        }
        GatewayDiagnostics.log(
            "watch exec approval: fetch prompt start id=\(approvalId) reason=\(fetchReason)")
        let connected: Bool = if Self.shouldUseBackgroundAwareExecApprovalReconnect(
            sourceReason: fetchReason,
            isBackgrounded: self.isBackgrounded)
        {
            await self.ensureOperatorApprovalConnectionForWatchReview(
                timeoutMs: 12000,
                reason: fetchReason)
        } else {
            await self.ensureOperatorApprovalConnection(timeoutMs: 12000)
        }
        guard connected else {
            GatewayDiagnostics.log(
                "watch exec approval: fetch prompt operator not connected id=\(approvalId) reason=\(fetchReason)")
            return .failed(message: "operator_not_connected")
        }

        do {
            let payloadJSON = try Self.encodePayload(ExecApprovalGetRequest(id: approvalId))
            let response = try await self.operatorGateway.request(
                method: "exec.approval.get",
                paramsJSON: payloadJSON,
                timeoutSeconds: 12)
            let details = try JSONDecoder().decode(ExecApprovalGetResponse.self, from: response)
            guard let prompt = Self.makeExecApprovalPrompt(from: details) else {
                GatewayDiagnostics.log(
                    "watch exec approval: fetch prompt invalid payload id=\(approvalId) reason=\(fetchReason)")
                return .failed(message: "invalid_prompt_payload")
            }
            GatewayDiagnostics.log(
                "watch exec approval: fetch prompt loaded id=\(approvalId) reason=\(fetchReason)")
            return .loaded(prompt)
        } catch {
            if Self.isApprovalNotificationStaleError(error) {
                GatewayDiagnostics.log(
                    "watch exec approval: fetch prompt stale id=\(approvalId) reason=\(fetchReason)")
                return .stale
            }
            GatewayDiagnostics.log(
                "watch exec approval: fetch prompt failed "
                    + "id=\(approvalId) reason=\(fetchReason) "
                    + "error=\(error.localizedDescription)")
            return .failed(message: error.localizedDescription)
        }
    }

    func dismissPendingExecApprovalPrompt() {
        self.pendingExecApprovalPrompt = nil
        self.pendingExecApprovalPromptResolving = false
        self.pendingExecApprovalPromptErrorText = nil
    }

    func dismissPendingExecApprovalPrompt(approvalId: String) {
        self.clearPendingExecApprovalPromptIfMatches(approvalId)
    }

    func resolvePendingExecApprovalPrompt(decision: String) async {
        guard let prompt = self.pendingExecApprovalPrompt else { return }
        let normalizedDecision = decision.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedDecision.isEmpty else { return }

        self.pendingExecApprovalPromptResolving = true
        self.pendingExecApprovalPromptErrorText = nil
        let outcome = await self.resolveExecApprovalNotificationDecision(
            approvalId: prompt.id,
            decision: normalizedDecision)
        switch outcome {
        case .resolved, .stale, .unavailable:
            break
        case let .failed(message):
            self.pendingExecApprovalPromptResolving = false
            self.pendingExecApprovalPromptErrorText = message
        }
    }

    func handleExecApprovalNotificationDecision(
        approvalId: String,
        decision: String) async
    {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return }

        if self.pendingExecApprovalPrompt?.id == normalizedApprovalID {
            self.pendingExecApprovalPromptResolving = true
            self.pendingExecApprovalPromptErrorText = nil
        }

        let outcome = await self.resolveExecApprovalNotificationDecision(
            approvalId: normalizedApprovalID,
            decision: decision)
        switch outcome {
        case .resolved, .stale, .unavailable:
            break
        case let .failed(message):
            if self.pendingExecApprovalPrompt?.id == normalizedApprovalID {
                self.pendingExecApprovalPromptResolving = false
                self.pendingExecApprovalPromptErrorText = message
            }
        }
    }

    private func resolveExecApprovalNotificationDecision(
        approvalId: String,
        decision: String,
        sourceReason: String? = nil) async -> ExecApprovalResolutionOutcome
    {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedDecision = decision.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSourceReason = sourceReason?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolutionReason = (normalizedSourceReason?.isEmpty == false) ? normalizedSourceReason! : "direct"
        guard !normalizedApprovalID.isEmpty, !normalizedDecision.isEmpty else {
            return .failed(message: "Invalid approval request.")
        }

        let connected: Bool = if Self.shouldUseBackgroundAwareExecApprovalReconnect(
            sourceReason: resolutionReason,
            isBackgrounded: self.isBackgrounded)
        {
            await self.ensureOperatorApprovalConnectionForWatchReview(
                timeoutMs: 12000,
                reason: resolutionReason)
        } else {
            await self.ensureOperatorApprovalConnection(timeoutMs: 12000)
        }
        guard connected else {
            self.execApprovalNotificationLogger.error(
                "Exec approval action failed id=\(normalizedApprovalID, privacy: .public): operator not connected")
            return .failed(message: "OpenClaw couldn't connect to the gateway operator session.")
        }

        do {
            let payloadJSON = try Self.encodePayload(
                ExecApprovalResolveRequest(id: normalizedApprovalID, decision: normalizedDecision))
            _ = try await self.operatorGateway.request(
                method: "exec.approval.resolve",
                paramsJSON: payloadJSON,
                timeoutSeconds: 12)
            await ExecApprovalNotificationBridge.removeNotifications(
                forApprovalID: normalizedApprovalID,
                notificationCenter: self.notificationCenter)
            self.clearPendingExecApprovalPromptIfMatches(normalizedApprovalID)
            await self.publishWatchExecApprovalResolved(
                approvalId: normalizedApprovalID,
                decision: OpenClawWatchExecApprovalDecision(rawValue: normalizedDecision),
                source: "iphone")
            return .resolved
        } catch {
            if Self.isApprovalNotificationStaleError(error) {
                await ExecApprovalNotificationBridge.removeNotifications(
                    forApprovalID: normalizedApprovalID,
                    notificationCenter: self.notificationCenter)
                self.clearPendingExecApprovalPromptIfMatches(normalizedApprovalID)
                await self.publishWatchExecApprovalExpired(approvalId: normalizedApprovalID, reason: .notFound)
                return .stale
            }
            if Self.isApprovalNotificationUnavailableError(error) {
                await ExecApprovalNotificationBridge.removeNotifications(
                    forApprovalID: normalizedApprovalID,
                    notificationCenter: self.notificationCenter)
                self.clearPendingExecApprovalPromptIfMatches(normalizedApprovalID)
                await self.publishWatchExecApprovalExpired(approvalId: normalizedApprovalID, reason: .unavailable)
                return .unavailable
            }
            let logMessage =
                "Exec approval action failed id=\(normalizedApprovalID) error=\(error.localizedDescription)"
            self.execApprovalNotificationLogger.error("\(logMessage, privacy: .public)")
            return .failed(
                message: "OpenClaw couldn't resolve this approval right now. Try again.")
        }
    }

    private func clearPendingExecApprovalPromptIfMatches(_ approvalId: String) {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.pendingExecApprovalPrompt?.id == normalizedApprovalID else { return }
        self.dismissPendingExecApprovalPrompt()
    }

    private nonisolated static func isApprovalNotificationStaleError(_ error: Error) -> Bool {
        guard let gatewayError = error as? GatewayResponseError else { return false }
        if gatewayError.code != "INVALID_REQUEST" {
            return false
        }
        if gatewayError.detailsReason == "APPROVAL_NOT_FOUND" {
            return true
        }
        return gatewayError.message.lowercased().contains("unknown or expired approval id")
    }

    private nonisolated static func isApprovalNotificationUnavailableError(_ error: Error) -> Bool {
        guard let gatewayError = error as? GatewayResponseError else { return false }
        if gatewayError.code != "INVALID_REQUEST" {
            return false
        }
        if gatewayError.detailsReason == "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" {
            return true
        }
        return gatewayError.message.lowercased().contains("allow-always is unavailable")
    }

    private struct BackgroundAliveWakeAttemptResult {
        var applied: Bool
        var handled: Bool
        var reason: String
        var durationMs: Int
    }

    private func waitForGatewayConnection(timeoutMs: Int, pollMs: Int) async -> Bool {
        let clampedTimeoutMs = max(0, timeoutMs)
        let pollIntervalNs = UInt64(max(50, pollMs)) * 1_000_000
        let deadline = Date().addingTimeInterval(Double(clampedTimeoutMs) / 1000.0)
        while Date() < deadline {
            if Task.isCancelled {
                return false
            }
            if await self.isGatewayConnected() {
                return true
            }
            do {
                try await Task.sleep(nanoseconds: pollIntervalNs)
            } catch {
                return false
            }
        }
        return await self.isGatewayConnected()
    }

    private func waitForOperatorConnection(timeoutMs: Int, pollMs: Int) async -> Bool {
        let clampedTimeoutMs = max(0, timeoutMs)
        let pollIntervalNs = UInt64(max(50, pollMs)) * 1_000_000
        let deadline = Date().addingTimeInterval(Double(clampedTimeoutMs) / 1000.0)
        while Date() < deadline {
            if Task.isCancelled {
                return false
            }
            if await self.isOperatorConnected() {
                return true
            }
            do {
                try await Task.sleep(nanoseconds: pollIntervalNs)
            } catch {
                return false
            }
        }
        return await self.isOperatorConnected()
    }

    private func ensureOperatorReconnectLoopIfNeeded() {
        guard let cfg = self.activeGatewayConnectConfig else {
            return
        }
        guard self.operatorGatewayTask == nil else {
            return
        }
        let stableID = cfg.stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveStableID = stableID.isEmpty ? cfg.url.absoluteString : stableID
        let sessionBox = cfg.tls.map { WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0)) }
        self.startOperatorGatewayLoop(
            url: cfg.url,
            stableID: effectiveStableID,
            token: cfg.token,
            bootstrapToken: cfg.bootstrapToken,
            password: cfg.password,
            nodeOptions: cfg.nodeOptions,
            sessionBox: sessionBox)
    }

    private func ensureOperatorApprovalConnectionForWatchReview(timeoutMs: Int, reason: String) async -> Bool {
        let normalizedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let reconnectReason = normalizedReason.isEmpty ? "watch_request" : normalizedReason
        if await self.isOperatorConnected() {
            GatewayDiagnostics.log(
                "watch exec approval: watch_request_reconnect_connected "
                    + "reason=\(reconnectReason) phase=already_connected")
            return true
        }

        guard self.isBackgrounded else {
            GatewayDiagnostics.log(
                "watch exec approval: watch_request_reconnect_begin "
                    + "reason=\(reconnectReason) backgrounded=false strategy=default")
            let connected = await self.ensureOperatorApprovalConnection(timeoutMs: timeoutMs)
            GatewayDiagnostics.log(
                "watch exec approval: watch_request_reconnect_\(connected ? "connected" : "timeout") "
                    + "reason=\(reconnectReason) phase=foreground_delegate")
            return connected
        }

        guard self.gatewayAutoReconnectEnabled else {
            GatewayDiagnostics.log(
                "watch exec approval: watch_request_reconnect_timeout "
                    + "reason=\(reconnectReason) phase=auto_reconnect_disabled")
            return false
        }

        guard let cfg = self.activeGatewayConnectConfig else {
            GatewayDiagnostics.log(
                "watch exec approval: watch_request_reconnect_timeout "
                    + "reason=\(reconnectReason) phase=no_active_gateway_config")
            return false
        }

        GatewayDiagnostics.log(
            "watch exec approval: watch_request_reconnect_begin reason=\(reconnectReason) backgrounded=true")
        let leaseSeconds = min(45.0, max(15.0, Double(max(timeoutMs, 1000)) / 1000.0 + 8.0))
        self.grantBackgroundReconnectLease(seconds: leaseSeconds, reason: "watch_review_\(reconnectReason)")
        GatewayDiagnostics.log(
            "watch exec approval: watch_request_reconnect_lease_granted "
                + "reason=\(reconnectReason) seconds=\(leaseSeconds)")

        let hadReconnectLoop = self.operatorGatewayTask != nil
        let canStartReconnectLoop = hadReconnectLoop || self.shouldStartOperatorGatewayLoop(
            token: cfg.token,
            bootstrapToken: cfg.bootstrapToken,
            password: cfg.password,
            stableID: cfg.effectiveStableID)
        guard canStartReconnectLoop else {
            GatewayDiagnostics.log(
                "watch exec approval: watch_request_reconnect_timeout "
                    + "reason=\(reconnectReason) phase=no_operator_reconnect_auth")
            return false
        }

        self.ensureOperatorReconnectLoopIfNeeded()
        GatewayDiagnostics.log(
            "watch exec approval: watch_request_reconnect_loop_\(hadReconnectLoop ? "reused" : "started") "
                + "reason=\(reconnectReason)")

        let initialWaitMs = min(2500, max(750, timeoutMs / 4))
        GatewayDiagnostics.log(
            "watch exec approval: watch_request_reconnect_wait "
                + "reason=\(reconnectReason) phase=initial timeoutMs=\(initialWaitMs)")
        if await self.waitForOperatorConnection(timeoutMs: initialWaitMs, pollMs: 200) {
            GatewayDiagnostics.log(
                "watch exec approval: watch_request_reconnect_connected "
                    + "reason=\(reconnectReason) phase=initial")
            return true
        }

        GatewayDiagnostics.log(
            "watch exec approval: watch_request_reconnect_restart reason=\(reconnectReason)")
        self.operatorGatewayTask?.cancel()
        self.operatorGatewayTask = nil
        await self.operatorGateway.disconnect()
        self.operatorConnected = false
        self.talkMode.updateGatewayConnected(false)
        self.stopGatewayHealthMonitor()

        let sessionBox = cfg.tls.map { WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0)) }
        self.startOperatorGatewayLoop(
            url: cfg.url,
            stableID: cfg.effectiveStableID,
            token: cfg.token,
            bootstrapToken: cfg.bootstrapToken,
            password: cfg.password,
            nodeOptions: cfg.nodeOptions,
            sessionBox: sessionBox)

        let remainingWaitMs = max(250, timeoutMs - initialWaitMs)
        GatewayDiagnostics.log(
            "watch exec approval: watch_request_reconnect_wait "
                + "reason=\(reconnectReason) phase=restart timeoutMs=\(remainingWaitMs)")
        let connected = await self.waitForOperatorConnection(timeoutMs: remainingWaitMs, pollMs: 200)
        GatewayDiagnostics.log(
            "watch exec approval: watch_request_reconnect_\(connected ? "connected" : "timeout") "
                + "reason=\(reconnectReason) phase=restart")
        return connected
    }

    private func ensureOperatorApprovalConnection(timeoutMs: Int) async -> Bool {
        if await self.isOperatorConnected() {
            return true
        }
        self.ensureOperatorReconnectLoopIfNeeded()
        return await self.waitForOperatorConnection(timeoutMs: timeoutMs, pollMs: 250)
    }

    private func performBackgroundAliveBeaconIfNeeded(
        wakeId: String,
        trigger: BackgroundAliveBeacon.Trigger) async -> BackgroundAliveWakeAttemptResult
    {
        let startedAt = Date()
        let makeResult: (Bool, Bool, String) -> BackgroundAliveWakeAttemptResult = { applied, handled, reason in
            let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            return BackgroundAliveWakeAttemptResult(
                applied: applied,
                handled: handled,
                reason: reason,
                durationMs: max(0, durationMs))
        }

        guard self.isBackgrounded else {
            self.pushWakeLogger.info("Wake no-op wakeId=\(wakeId, privacy: .public): app not backgrounded")
            return makeResult(false, false, "not_backgrounded")
        }
        guard self.gatewayAutoReconnectEnabled else {
            self.pushWakeLogger.info("Wake no-op wakeId=\(wakeId, privacy: .public): auto reconnect disabled")
            return makeResult(false, false, "auto_reconnect_disabled")
        }
        let now = Date()
        let gatewayConnected = await self.isGatewayConnected()

        var appliedReconnect = false
        if !gatewayConnected {
            guard let cfg = self.activeGatewayConnectConfig else {
                self.pushWakeLogger.info("Wake no-op wakeId=\(wakeId, privacy: .public): no active gateway config")
                return makeResult(false, false, "no_active_gateway_config")
            }
            self.pushWakeLogger.info(
                "Wake reconnect begin wakeId=\(wakeId, privacy: .public) stableID=\(cfg.stableID, privacy: .public)")
            self.grantBackgroundReconnectLease(seconds: 30, reason: "wake_\(wakeId)")
            await self.operatorGateway.disconnect()
            await self.nodeGateway.disconnect()
            self.operatorConnected = false
            self.gatewayConnected = false
            self.gatewayStatusText = "Reconnecting…"
            self.talkMode.updateGatewayConnected(false)
            self.applyGatewayConnectConfig(cfg)
            appliedReconnect = true
            self.pushWakeLogger.info("Wake reconnect trigger applied wakeId=\(wakeId, privacy: .public)")

            let connected = await self.waitForGatewayConnection(timeoutMs: 12000, pollMs: 250)
            guard connected else {
                return makeResult(appliedReconnect, false, "connect_timeout")
            }
        } else if BackgroundAliveBeacon.shouldSkipRecentSuccess(
            isGatewayConnected: true,
            now: now,
            lastSuccessAtMs: UserDefaults.standard.object(forKey: Self.backgroundAliveLastSuccessAtMsKey) as? Double)
        {
            return makeResult(false, true, "recent_success")
        }

        let beacon = await self.publishBackgroundAliveBeacon(trigger: trigger)
        if beacon.handled {
            let successAtMs = Date().timeIntervalSince1970 * 1000
            UserDefaults.standard.set(successAtMs, forKey: Self.backgroundAliveLastSuccessAtMsKey)
            UserDefaults.standard.set(trigger.rawValue, forKey: Self.backgroundAliveLastTriggerKey)
            return makeResult(appliedReconnect, true, beacon.reason)
        }
        return makeResult(appliedReconnect, false, beacon.reason)
    }

    private func publishBackgroundAliveBeacon(
        trigger: BackgroundAliveBeacon.Trigger) async -> (handled: Bool, reason: String)
    {
        do {
            let pushTransport = await self.pushRegistrationManager.usesRelayTransport ? "relay" : "direct"
            let displayName = NodeDisplayName.resolve(
                existing: UserDefaults.standard.string(forKey: "node.displayName"),
                deviceName: UIDevice.current.name,
                interfaceIdiom: UIDevice.current.userInterfaceIdiom)
            let payload = BackgroundAliveBeacon.makePayload(
                trigger: trigger,
                displayName: displayName,
                pushTransport: pushTransport)
            let paramsJSON = try BackgroundAliveBeacon.makeNodeEventRequestPayloadJSON(payload: payload)
            let response = try await self.nodeGateway.request(
                method: "node.event",
                paramsJSON: paramsJSON,
                timeoutSeconds: 8)
            guard let decoded = BackgroundAliveBeacon.decodeResponse(response) else {
                return (false, "invalid_response")
            }
            if decoded.handled == true {
                return (true, decoded.reason ?? "beacon_persisted")
            }
            return (false, decoded.reason ?? "unsupported")
        } catch {
            return (false, "beacon_failed")
        }
    }
}

extension NodeAppModel {
    private func refreshWakeWordsFromGateway() async {
        do {
            let data = try await self.operatorGateway.request(
                method: "voicewake.get",
                paramsJSON: "{}",
                timeoutSeconds: 8)
            guard let triggers = VoiceWakePreferences.decodeGatewayTriggers(from: data) else { return }
            VoiceWakePreferences.saveTriggerWords(triggers)
        } catch {
            if let gatewayError = error as? GatewayResponseError {
                let lower = gatewayError.message.lowercased()
                if lower.contains("unauthorized role") || lower.contains("missing scope") {
                    self.setGatewayHealthMonitorDisabled(true)
                    return
                }
            }
            // Best-effort only.
        }
    }

    private func isGatewayHealthMonitorDisabled() -> Bool {
        self.gatewayHealthMonitorDisabled
    }

    private func setGatewayHealthMonitorDisabled(_ disabled: Bool) {
        self.gatewayHealthMonitorDisabled = disabled
    }

    func sendVoiceTranscript(text: String, sessionKey: String?) async throws {
        if await !self.isGatewayConnected() {
            throw NSError(domain: "Gateway", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "Gateway not connected",
            ])
        }
        struct Payload: Codable {
            var text: String
            var sessionKey: String?
        }
        let payload = Payload(text: text, sessionKey: sessionKey)
        let data = try JSONEncoder().encode(payload)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode voice transcript payload as UTF-8",
            ])
        }
        await self.nodeGateway.sendEvent(event: "voice.transcript", payloadJSON: json)
    }

    func handleDeepLink(url: URL) async {
        guard let route = DeepLinkParser.parse(url) else { return }

        switch route {
        case let .agent(link):
            await self.handleAgentDeepLink(link, originalURL: url)
        case .gateway:
            break
        }
    }

    private func handleAgentDeepLink(_ link: AgentDeepLink, originalURL: URL) async {
        let message = link.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        self.deepLinkLogger.info(
            "agent deep link messageChars=\(message.count) url=\(originalURL.absoluteString, privacy: .public)")

        if message.count > IOSDeepLinkAgentPolicy.maxMessageChars {
            self.screen.errorText = "Deep link too large (message exceeds "
                + "\(IOSDeepLinkAgentPolicy.maxMessageChars) characters)."
            self.recordShareEvent("Rejected: message too large (\(message.count) chars).")
            return
        }

        guard await self.isGatewayConnected() else {
            self.screen.errorText = "Gateway not connected (cannot forward deep link)."
            self.recordShareEvent("Failed: gateway not connected.")
            self.deepLinkLogger.error("agent deep link rejected: gateway not connected")
            return
        }

        let allowUnattended = self.isUnattendedDeepLinkAllowed(link.key)
        if !allowUnattended {
            if message.count > IOSDeepLinkAgentPolicy.maxUnkeyedConfirmChars {
                self.screen.errorText = "Deep link blocked (message too long without key)."
                self.recordShareEvent(
                    "Rejected: deep link over \(IOSDeepLinkAgentPolicy.maxUnkeyedConfirmChars) chars without key.")
                self.deepLinkLogger.error(
                    "agent deep link rejected: unkeyed message too long chars=\(message.count, privacy: .public)")
                return
            }
            let urlText = originalURL.absoluteString
            let prompt = AgentDeepLinkPrompt(
                id: UUID().uuidString,
                messagePreview: message,
                urlPreview: urlText.count > 500 ? "\(urlText.prefix(500))…" : urlText,
                request: self.effectiveAgentDeepLinkForPrompt(link))

            let promptIntervalSeconds = 5.0
            let elapsed = Date().timeIntervalSince(self.lastAgentDeepLinkPromptAt)
            if elapsed < promptIntervalSeconds {
                if self.pendingAgentDeepLinkPrompt != nil {
                    self.pendingAgentDeepLinkPrompt = prompt
                    self.recordShareEvent("Updated local confirmation request (\(message.count) chars).")
                    self.deepLinkLogger.debug("agent deep link prompt coalesced into active confirmation")
                    return
                }

                let remaining = max(0, promptIntervalSeconds - elapsed)
                self.queueAgentDeepLinkPrompt(prompt, initialDelaySeconds: remaining)
                self.recordShareEvent("Queued local confirmation (\(message.count) chars).")
                self.deepLinkLogger.debug("agent deep link prompt queued due to rate limit")
                return
            }

            self.presentAgentDeepLinkPrompt(prompt)
            self.recordShareEvent("Awaiting local confirmation (\(message.count) chars).")
            self.deepLinkLogger.info("agent deep link requires local confirmation")
            return
        }

        await self.submitAgentDeepLink(link, messageCharCount: message.count)
    }

    private func sendAgentRequest(link: AgentDeepLink) async throws {
        if link.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NSError(domain: "DeepLink", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "invalid agent message",
            ])
        }

        let data = try JSONEncoder().encode(link)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode agent request payload as UTF-8",
            ])
        }
        await self.nodeGateway.sendEvent(event: "agent.request", payloadJSON: json)
    }

    private func isGatewayConnected() async -> Bool {
        self.gatewayConnected
    }

    private func applyMainSessionKey(_ key: String?) {
        let trimmed = (key ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let current = self.mainSessionBaseKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == current { return }
        self.mainSessionBaseKey = trimmed
        self.talkMode.updateMainSessionKey(self.mainSessionKey)
    }

    private static func color(fromHex raw: String?) -> Color? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let hex = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        return Color(red: r, green: g, blue: b)
    }

    func approvePendingAgentDeepLinkPrompt() async {
        guard let prompt = self.pendingAgentDeepLinkPrompt else { return }
        self.pendingAgentDeepLinkPrompt = nil
        guard await self.isGatewayConnected() else {
            self.screen.errorText = "Gateway not connected (cannot forward deep link)."
            self.recordShareEvent("Failed: gateway not connected.")
            self.deepLinkLogger.error("agent deep link approval failed: gateway not connected")
            return
        }
        await self.submitAgentDeepLink(prompt.request, messageCharCount: prompt.messagePreview.count)
    }

    func declinePendingAgentDeepLinkPrompt() {
        guard self.pendingAgentDeepLinkPrompt != nil else { return }
        self.pendingAgentDeepLinkPrompt = nil
        self.screen.errorText = "Deep link cancelled."
        self.recordShareEvent("Cancelled: deep link confirmation declined.")
        self.deepLinkLogger.info("agent deep link cancelled by local user")
    }

    private func presentAgentDeepLinkPrompt(_ prompt: AgentDeepLinkPrompt) {
        self.lastAgentDeepLinkPromptAt = Date()
        self.pendingAgentDeepLinkPrompt = prompt
    }

    private func queueAgentDeepLinkPrompt(_ prompt: AgentDeepLinkPrompt, initialDelaySeconds: TimeInterval) {
        self.queuedAgentDeepLinkPrompt = prompt
        guard self.queuedAgentDeepLinkPromptTask == nil else { return }

        self.queuedAgentDeepLinkPromptTask = Task { [weak self] in
            guard let self else { return }
            let delayNs = UInt64(max(0, initialDelaySeconds) * 1_000_000_000)
            if delayNs > 0 {
                do {
                    try await Task.sleep(nanoseconds: delayNs)
                } catch {
                    return
                }
            }
            await self.deliverQueuedAgentDeepLinkPrompt()
        }
    }

    private func deliverQueuedAgentDeepLinkPrompt() async {
        defer { self.queuedAgentDeepLinkPromptTask = nil }
        let promptIntervalSeconds = 5.0
        while let prompt = self.queuedAgentDeepLinkPrompt {
            if self.pendingAgentDeepLinkPrompt != nil {
                do {
                    try await Task.sleep(nanoseconds: 200_000_000)
                } catch {
                    return
                }
                continue
            }

            let elapsed = Date().timeIntervalSince(self.lastAgentDeepLinkPromptAt)
            if elapsed < promptIntervalSeconds {
                let remaining = max(0, promptIntervalSeconds - elapsed)
                do {
                    try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
                } catch {
                    return
                }
                continue
            }

            self.queuedAgentDeepLinkPrompt = nil
            self.presentAgentDeepLinkPrompt(prompt)
            self.recordShareEvent("Awaiting local confirmation (\(prompt.messagePreview.count) chars).")
            self.deepLinkLogger.info("agent deep link queued prompt delivered")
        }
    }

    private func submitAgentDeepLink(_ link: AgentDeepLink, messageCharCount: Int) async {
        do {
            try await self.sendAgentRequest(link: link)
            self.screen.errorText = nil
            self.recordShareEvent("Sent to gateway (\(messageCharCount) chars).")
            self.deepLinkLogger.info("agent deep link forwarded to gateway")
            self.openChatRequestID &+= 1
        } catch {
            self.screen.errorText = "Agent request failed: \(error.localizedDescription)"
            self.recordShareEvent("Failed: \(error.localizedDescription)")
            self.deepLinkLogger.error("agent deep link send failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func effectiveAgentDeepLinkForPrompt(_ link: AgentDeepLink) -> AgentDeepLink {
        // Without a trusted key, strip delivery/routing knobs to reduce exfiltration risk.
        AgentDeepLink(
            message: link.message,
            sessionKey: link.sessionKey,
            thinking: link.thinking,
            deliver: false,
            to: nil,
            channel: nil,
            timeoutSeconds: link.timeoutSeconds,
            key: link.key)
    }

    private func isUnattendedDeepLinkAllowed(_ key: String?) -> Bool {
        let normalizedKey = key?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalizedKey.isEmpty else { return false }
        return normalizedKey == Self.canvasUnattendedDeepLinkKey || normalizedKey == Self.expectedDeepLinkKey()
    }

    private static func expectedDeepLinkKey() -> String {
        let defaults = UserDefaults.standard
        if let key = defaults.string(forKey: self.deepLinkKeyUserDefaultsKey), !key.isEmpty {
            return key
        }
        let key = self.generateDeepLinkKey()
        defaults.set(key, forKey: self.deepLinkKeyUserDefaultsKey)
        return key
    }

    private static func generateDeepLinkKey() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let data = Data(bytes)
        return data
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

extension NodeAppModel {
    func _bridgeConsumeMirroredWatchReply(_ event: WatchQuickReplyEvent) async {
        await self.handleWatchQuickReply(event)
    }
}

#if DEBUG
extension NodeAppModel {
    func _test_handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        await self.handleInvoke(req)
    }

    static func _test_decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        try self.decodeParams(type, from: json)
    }

    static func _test_encodePayload(_ obj: some Encodable) throws -> String {
        try self.encodePayload(obj)
    }

    func _test_isCameraEnabled() -> Bool {
        self.isCameraEnabled()
    }

    func _test_triggerCameraFlash() {
        self.triggerCameraFlash()
    }

    func _test_showCameraHUD(text: String, kind: CameraHUDKind, autoHideSeconds: Double? = nil) {
        self.showCameraHUD(text: text, kind: kind, autoHideSeconds: autoHideSeconds)
    }

    func _test_handleCanvasA2UIAction(body: [String: Any]) async {
        await self.handleCanvasA2UIAction(body: body)
    }

    func _test_showLocalCanvasOnDisconnect() {
        self.showLocalCanvasOnDisconnect()
    }

    func _test_applyTalkModeSync(enabled: Bool, phase: String? = nil) {
        self.applyTalkModeSync(enabled: enabled, phase: phase)
    }

    func _test_queuedWatchReplyCount() -> Int {
        self.watchReplyCoordinator.queuedCount
    }

    func _test_setGatewayConnected(_ connected: Bool) {
        self.gatewayConnected = connected
    }

    func _test_applyPendingForegroundNodeActions(
        _ actions: [(id: String, command: String, paramsJSON: String?)]) async
    {
        let mapped = actions.map { action in
            PendingForegroundNodeAction(
                id: action.id,
                command: action.command,
                paramsJSON: action.paramsJSON,
                enqueuedAtMs: nil)
        }
        await self.applyPendingForegroundNodeActions(mapped, trigger: "test")
    }

    func _test_makeOperatorConnectOptions(
        clientId: String,
        displayName: String?,
        includeApprovalScope: Bool) -> GatewayConnectOptions
    {
        self.makeOperatorConnectOptions(
            clientId: clientId,
            displayName: displayName,
            includeApprovalScope: includeApprovalScope)
    }

    func _test_presentExecApprovalPrompt(_ prompt: ExecApprovalPrompt) {
        self.presentFetchedExecApprovalPrompt(prompt)
    }

    func _test_dismissPendingExecApprovalPrompt() {
        self.dismissPendingExecApprovalPrompt()
    }

    func _test_pendingExecApprovalPrompt() -> ExecApprovalPrompt? {
        self.pendingExecApprovalPrompt
    }

    func _test_recordPendingWatchExecApprovalRecoveryID(_ approvalId: String) {
        self.appendPendingWatchExecApprovalRecoveryID(approvalId)
    }

    func _test_pendingWatchExecApprovalRecoveryIDs() -> [String] {
        self.pendingWatchExecApprovalRecoveryIDs
    }

    func _test_pendingExecApprovalIDsForWatchRecovery() async -> [String] {
        await self.pendingExecApprovalIDsForWatchRecovery()
    }

    nonisolated static func _test_isApprovalNotificationStaleError(_ error: Error) -> Bool {
        self.isApprovalNotificationStaleError(error)
    }

    nonisolated static func _test_isApprovalNotificationUnavailableError(_ error: Error) -> Bool {
        self.isApprovalNotificationUnavailableError(error)
    }

    nonisolated static func _test_shouldUseBackgroundAwareExecApprovalReconnect(
        sourceReason: String,
        isBackgrounded: Bool) -> Bool
    {
        self.shouldUseBackgroundAwareExecApprovalReconnect(
            sourceReason: sourceReason,
            isBackgrounded: isBackgrounded)
    }

    nonisolated static func _test_watchExecApprovalIDsNeedingFetch(
        candidateIDs: [String],
        cachedApprovalIDs: [String]) -> [String]
    {
        self.watchExecApprovalIDsNeedingFetch(
            candidateIDs: candidateIDs,
            cachedApprovalIDs: cachedApprovalIDs)
    }

    nonisolated static func _test_shouldResetWatchExecApprovalResolvingStateOnPrompt(
        reason: String) -> Bool
    {
        self.shouldResetWatchExecApprovalResolvingStateOnPrompt(reason: reason)
    }

    static func _test_makeExecApprovalPrompt(
        id: String,
        commandText: String,
        allowedDecisions: [String],
        host: String?,
        nodeId: String?,
        agentId: String?,
        expiresAtMs: Int?) -> ExecApprovalPrompt?
    {
        self.makeExecApprovalPrompt(
            from: ExecApprovalGetResponse(
                id: id,
                commandText: commandText,
                commandPreview: nil,
                allowedDecisions: allowedDecisions,
                host: host,
                nodeId: nodeId,
                agentId: agentId,
                expiresAtMs: expiresAtMs))
    }

    static func _test_currentDeepLinkKey() -> String {
        self.expectedDeepLinkKey()
    }

    static func _test_resetPersistedWatchExecApprovalBridgeState() {
        UserDefaults.standard.removeObject(forKey: self.watchExecApprovalBridgeStateKey)
    }

    nonisolated static func _test_shouldStartOperatorGatewayLoop(
        token: String?,
        bootstrapToken: String?,
        password: String?,
        hasStoredOperatorToken: Bool) -> Bool
    {
        self.shouldStartOperatorGatewayLoop(
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            hasStoredOperatorToken: hasStoredOperatorToken)
    }

    nonisolated static func _test_shouldRequestOperatorApprovalScope(
        token: String?,
        password: String?,
        storedOperatorScopes: [String]) -> Bool
    {
        self.shouldRequestOperatorApprovalScope(
            token: token,
            password: password,
            storedOperatorScopes: storedOperatorScopes)
    }

    nonisolated static func _test_clearingBootstrapToken(
        in config: GatewayConnectConfig?) -> GatewayConnectConfig?
    {
        self.clearingBootstrapToken(in: config)
    }

    func _test_handleSuccessfulBootstrapGatewayOnboarding() async {
        await self.handleSuccessfulBootstrapGatewayOnboarding(
            url: URL(string: "wss://gateway.example")!,
            stableID: "test-gateway",
            token: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "node",
                clientDisplayName: nil),
            sessionBox: nil)
    }
}
#endif
// swiftlint:enable type_body_length file_length
