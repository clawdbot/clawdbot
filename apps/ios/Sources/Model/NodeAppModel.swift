import CoreLocation
import CryptoKit
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

private struct WatchChatPreview {
    var items: [OpenClawWatchChatItem]
    var statusText: String?
}

private struct WatchChatMetadataEnvelope: Decodable {
    struct Metadata: Decodable {
        var id: String?
    }

    var metadata: Metadata?
    var messageToolMirror: [String: String]?

    enum CodingKeys: String, CodingKey {
        case metadata = "__openclaw"
        case messageToolMirror = "openclawMessageToolMirror"
    }
}

private struct WatchChatMessageEntry {
    var message: OpenClawChatMessage
    var text: String
    var serverId: String?
    var isMessageToolMirror: Bool
}

private struct ExecApprovalGatewayEventPayload: Decodable {
    var id: String
}

private struct NodeEventRequestPayload: Encodable {
    var event: String
    var payloadJSON: String
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
    private nonisolated static let watchChatPreviewItemLimit = 5
    private nonisolated static let watchMessageMaxImmediateRetryAttempts = 3

    struct AgentDeepLinkPrompt: Identifiable, Equatable {
        let id: String
        let messagePreview: String
        let urlPreview: String
        let request: AgentDeepLink
    }

    struct ExecApprovalPrompt: Identifiable, Equatable, Codable {
        let id: String
        let gatewayStableID: String
        let commandText: String
        let commandPreview: String?
        let allowedDecisions: [String]
        let host: String?
        let nodeId: String?
        let agentId: String?
        let expiresAtMs: Int64?

        var allowsAllowAlways: Bool {
            self.allowedDecisions.contains("allow-always")
        }
    }

    struct NotificationPermissionGuidancePrompt: Identifiable, Equatable {
        let id = UUID()
        let approvalId: String
    }

    private enum ExecApprovalResolutionOutcome {
        case resolved
        case stale
        case unavailable
        case failed(message: String)
    }

    private struct GatewaySessionRouteContext {
        let route: GatewayNodeSessionRoute
        let gatewayStableID: String
        let routeGeneration: UInt64
    }

    private struct NodeGatewayLoopContext: Sendable {
        let url: URL
        let stableID: String
        let routeGeneration: UInt64
        let fallbackToken: String?
        let fallbackBootstrapToken: String?
        let fallbackPassword: String?
        let initialOptions: GatewayConnectOptions
        let sessionBox: WebSocketSessionBox?
    }

    private struct NodeGatewayLoopState: Sendable {
        var attempt = 0
        var options: GatewayConnectOptions
        var didFallbackClientID = false
    }

    private enum NodeGatewayLoopStep: Sendable {
        case retry(NodeGatewayLoopState)
        case stop
        case stopPreservingStatus
    }

    private struct APNsRegistrationContext: Sendable {
        let usesRelayTransport: Bool
        let nodeRoute: GatewayNodeSessionRoute
        let token: String
        let gatewayStableID: String
        let topic: String
    }

    private enum ExecApprovalPushRouteValidation {
        case validated(GatewaySessionRouteContext)
        case unavailable
        case mismatchedOwner
    }

    private enum WatchMessageSendOutcome {
        case sent
        case retry
        case discard
    }

    private struct PersistedWatchExecApprovalBridgeState: Codable {
        var approvals: [ExecApprovalPrompt]
        var pendingApprovalPushes: [ExecApprovalNotificationPrompt]?
        var pendingResolvedPushes: [ExecApprovalNotificationPrompt]?
        var pendingResolutions: [WatchExecApprovalResolveEvent]?
    }

    private let deepLinkLogger = Logger(subsystem: "ai.openclawfoundation.app", category: "DeepLink")
    private nonisolated static let agentRequestNodeEventTimeoutSeconds = 8
    private nonisolated static let execApprovalNotificationGuidanceSuppressedKey =
        "notifications.execApprovalGuidance.suppressed"
    private let pushWakeLogger = Logger(subsystem: "ai.openclawfoundation.app", category: "PushWake")
    private let pendingActionLogger = Logger(subsystem: "ai.openclawfoundation.app", category: "PendingAction")
    private let locationWakeLogger = Logger(subsystem: "ai.openclawfoundation.app", category: "LocationWake")
    private let watchReplyLogger = Logger(subsystem: "ai.openclawfoundation.app", category: "WatchReply")
    private let watchExecApprovalLogger = Logger(subsystem: "ai.openclawfoundation.app", category: "WatchExecApproval")
    private let execApprovalNotificationLogger = Logger(
        subsystem: "ai.openclawfoundation.app",
        category: "ExecApprovalNotification")
    enum CameraHUDKind {
        case photo
        case recording
        case success
        case error
    }

    private enum AuxiliaryAudioCapture: Equatable {
        case cameraClip
        case screenRecording
    }

    var isBackgrounded: Bool = false
    let screen: ScreenController
    private let camera: any CameraServicing
    private let screenRecorder: any ScreenRecordingServicing
    var gatewayStatusText: String = "Offline"
    var nodeStatusText: String = "Offline"
    var operatorStatusText: String = "Offline"
    private(set) var isAppleReviewDemoModeEnabled: Bool = false
    private(set) var isScreenshotFixtureModeEnabled: Bool = false
    var isOperatorGatewayConnected: Bool {
        self.operatorConnected
    }

    private(set) var hasOperatorAdminScope: Bool = false

    var gatewayServerName: String?
    var gatewayRemoteAddress: String?
    var connectedGatewayID: String?
    var gatewayAutoReconnectEnabled: Bool = true
    // When the gateway requires pairing approval, we pause reconnect churn and show a stable UX.
    // Reconnect loops (both our own and the underlying WebSocket watchdog) can otherwise generate
    // multiple pending requests and cause the onboarding UI to "flip-flop".
    var gatewayPairingPaused: Bool = false
    var gatewayPairingRequestId: String?
    // Bumped on every non-nil assignment, including re-reports of an equal problem;
    // value equality alone cannot tell the UI to re-surface or shake the toast.
    private(set) var gatewayProblemReportCount = 0
    private(set) var lastGatewayProblem: GatewayConnectionProblem? {
        didSet { if self.lastGatewayProblem != nil { self.gatewayProblemReportCount &+= 1 } }
    }

    private var operatorGatewayProblem: GatewayConnectionProblem?
    var gatewayDisplayStatusText: String {
        self.lastGatewayProblem?.statusText ?? self.gatewayStatusText
    }

    private var mainSessionBaseKey: String = "main"
    private var gatewaySessionScope: String?
    private var focusedChatSessionKey: String?
    // Two-part unread guard mirroring Android: the opened key survives read
    // confirmations so later unread episodes on the same open chat re-acknowledge;
    // the acknowledged key is the per-episode pending flag.
    @ObservationIgnored private var openedChatSessionKey: String?
    @ObservationIgnored private var readAcknowledgedChatSessionKey: String?
    var selectedAgentId: String?
    var gatewayDefaultAgentId: String?
    var gatewayAgents: [AgentSummary] = []
    var homeCanvasRevision: Int = 0
    var lastShareEventText: String = "No share events yet."
    var openChatRequestID: Int = 0
    var gatewaySetupRequestID: Int = 0
    private(set) var pendingAgentDeepLinkPrompt: AgentDeepLinkPrompt?
    private var pendingGatewaySetupLink: GatewayConnectDeepLink?
    private(set) var pendingExecApprovalPrompt: ExecApprovalPrompt?
    private(set) var pendingExecApprovalPromptResolving: Bool = false
    private(set) var pendingExecApprovalPromptErrorText: String?
    private var pendingExecApprovalPromptRequestGeneration: Int = 0
    private(set) var pendingNotificationPermissionGuidancePrompt: NotificationPermissionGuidancePrompt?
    private var queuedAgentDeepLinkPrompt: AgentDeepLinkPrompt?
    private var lastAgentDeepLinkPromptAt: Date = .distantPast
    @ObservationIgnored private var queuedAgentDeepLinkPromptTask: Task<Void, Never>?

    /// Primary "node" connection: used for device capabilities and node.invoke requests.
    private let nodeGateway = GatewayNodeSession()
    // Secondary "operator" connection: used for chat/talk/config/voicewake requests.
    private let operatorGateway = GatewayNodeSession()
    private var nodeGatewayTask: Task<Void, Never>?
    private var operatorGatewayTask: Task<Void, Never>?
    @ObservationIgnored private var gatewaySessionResetTask: Task<Void, Never>?
    @ObservationIgnored private var gatewaySessionResetGeneration: UInt64 = 0
    @ObservationIgnored private var gatewayRouteGeneration: UInt64 = 0
    @ObservationIgnored private var operatorTalkConnectionGeneration: UInt64 = 0
    @ObservationIgnored private var credentialHandoffFailureGeneration: UInt64?
    @ObservationIgnored private(set) var gatewayConnectGeneration: UInt64 = 0
    private var forceOperatorTalkPermissionUpgradeRequest = false
    private var lastTalkPermissionReconnectAttemptAt: Date?
    private var voiceWakeSyncTask: Task<Void, Never>?
    @ObservationIgnored private var cameraHUDDismissTask: Task<Void, Never>?
    @ObservationIgnored private var cameraHUDOwnerID: String?
    @ObservationIgnored private lazy var capabilityRouter: NodeCapabilityRouter = self.buildCapabilityRouter()
    private let gatewayHealthMonitor = GatewayHealthMonitor()
    private var gatewayHealthMonitorDisabled = false
    private let notificationCenter: NotificationCentering
    let voiceWake = VoiceWakeManager()
    let voiceNoteRecorder: OpenClawVoiceNoteRecorder
    let talkMode: TalkModeManager
    private let locationService: any LocationServicing
    private let deviceStatusService: any DeviceStatusServicing
    private let photosService: any PhotosServicing
    private let contactsService: any ContactsServicing
    private let calendarService: any CalendarServicing
    private let remindersService: any RemindersServicing
    private let motionService: any MotionServicing
    private let watchMessagingService: any WatchMessagingServicing
    #if DEBUG
    @ObservationIgnored private var testAgentRequestHandler: ((AgentDeepLink) async throws -> Void)?
    @ObservationIgnored private var testTalkCapturePreparationHandler: (() async -> Void)?
    @ObservationIgnored private var testTalkCaptureStartedHandler: (() async -> Void)?
    @ObservationIgnored private var testChatSessionRoutingRestoreHandler: (() async -> Void)?
    #endif
    private var pttVoiceWakeLeaseCaptureId: String?
    private var talkPttCommandEpoch: UInt64 = 0
    private var talkPreparationInFlight = false
    private var auxiliaryAudioCapture: AuxiliaryAudioCapture?
    private var foregroundCaptureCancellations: [UUID: @MainActor () -> Void] = [:]
    private var talkPreparationWaiters: [(id: UUID, continuation: CheckedContinuation<Bool, Never>)] = []
    private var backgroundTalkKeptActive = false
    private var backgroundedAt: Date?
    private var reconnectAfterBackgroundArmed = false
    private var backgroundGraceTaskID: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private var backgroundGraceTaskTimer: Task<Void, Never>?
    private var backgroundReconnectSuppressed = false
    private var backgroundReconnectLeaseUntil: Date?
    @ObservationIgnored private var foregroundGatewayResumeCheckInFlight = false
    private var lastSignificantLocationWakeAt: Date?
    @ObservationIgnored private let watchMessageOutbox = WatchMessageOutbox()
    @ObservationIgnored private var watchMessageFlushInFlight = false
    @ObservationIgnored private var watchMessageRetryAttempts: [String: Int] = [:]
    @ObservationIgnored private var watchMessageRetryTask: Task<Void, Never>?
    @ObservationIgnored private let appleReviewDemoChatTransport = AppleReviewDemoChatTransport()
    @ObservationIgnored private var chatTranscriptCachesByGatewayID: [String: OpenClawChatSQLiteTranscriptCache] = [:]
    @ObservationIgnored private var chatSessionRoutingRestoreTask: Task<Void, Never>?
    private var watchExecApprovalPromptsByID: [String: ExecApprovalPrompt] = [:]
    private var pendingWatchExecApprovalRecoveryPushes: [ExecApprovalNotificationPrompt] = []
    private var pendingExecApprovalResolvedPushes: [ExecApprovalNotificationPrompt] = []
    private var pendingWatchExecApprovalResolutions: [WatchExecApprovalResolveEvent] = []
    private var pendingForegroundActionDrainInFlight = false
    private var pendingForegroundActionDrainRequested = false
    private var completedPendingForegroundActionIDsByGateway: [String: Set<String>] = [:]

    private var gatewayConnected = false
    private var operatorConnected = false
    private var shareDeliveryChannel: String?
    private var shareDeliveryTo: String?
    private var apnsDeviceTokenHex: String?
    private var apnsLastRegisteredTokenHex: String?
    private var apnsLastRegisteredGatewayStableID: String?
    @ObservationIgnored private let pushRegistrationManager = PushRegistrationManager()

    var operatorSession: GatewayNodeSession {
        self.operatorGateway
    }

    var isTalkCaptureActive: Bool {
        // PTT owns its Voice Wake lease before permission and audio setup.
        // Count that pending interval so Chat cannot race another mic owner.
        self.talkPreparationInFlight ||
            self.talkMode.isEnabled ||
            self.talkMode.isPushToTalkActive ||
            self.pttVoiceWakeLeaseCaptureId != nil
    }

    var localChatFixture: LocalChatFixture? {
        if self.isScreenshotFixtureModeEnabled { return .appScreenshots }
        if self.isAppleReviewDemoModeEnabled { return .appleReviewDemo }
        return nil
    }

    var isLocalChatFixtureEnabled: Bool {
        self.localChatFixture != nil
    }

    var isLocalGatewayFixtureEnabled: Bool {
        self.isAppleReviewDemoModeEnabled || self.isScreenshotFixtureModeEnabled
    }

    var chatTransportModeID: String {
        if self.isScreenshotFixtureModeEnabled { return "screenshots" }
        if self.isAppleReviewDemoModeEnabled { return "apple-review-demo" }
        return self.isOperatorGatewayConnected ? "operator" : "offline"
    }

    func makeChatTransport(outboxGatewayID: String? = nil) -> any OpenClawChatTransport {
        if self.isScreenshotFixtureModeEnabled {
            return LocalFixtureChatTransport(fixture: .appScreenshots)
        }
        if self.isAppleReviewDemoModeEnabled {
            return AppleReviewDemoChatTransport()
        }
        return IOSGatewayChatTransport(
            gateway: self.operatorSession,
            globalAgentId: self.chatDeliveryAgentId,
            outboxGatewayID: outboxGatewayID)
    }

    /// Gateway identity the transcript cache is scoped to: the active
    /// connection's stableID, or the keychain-persisted active gateway on
    /// cold open before the gateway session is up. Nil for fixture transports
    /// and unpaired installs so demo or foreign rows can never leak into a
    /// real gateway's transcript.
    var chatTranscriptCacheGatewayID: String? {
        guard !self.isLocalGatewayFixtureEnabled else { return nil }
        let stableID = self.activeGatewayConnectConfig?.effectiveStableID
            ?? self.connectedGatewayID
            ?? GatewaySettingsStore.activeGatewayEntry()?.stableID
        guard let stableID, !stableID.isEmpty else { return nil }
        return stableID
    }

    /// Recreation key for the chat view model. Includes the cache gateway
    /// identity: switching paired gateways while the transport mode stays
    /// "operator" must rebuild the view model so transcripts are never read
    /// from or written under another gateway's cache scope.
    var chatViewModelIdentityID: String {
        "\(self.chatTransportModeID)|\(self.chatTranscriptCacheGatewayID ?? "")|\(self.chatTranscriptCacheGeneration)"
    }

    /// Stable owner key for the long-lived chat view model. Connectivity still
    /// changes `chatViewModelIdentityID` for session-list refreshes, but must
    /// not rebuild Chat and discard an offline draft on the same gateway.
    var chatViewModelOwnerID: String {
        let modeID = self.isLocalGatewayFixtureEnabled ? self.chatTransportModeID : "gateway"
        return "\(modeID)|\(self.chatTranscriptCacheGatewayID ?? "")|\(self.chatTranscriptCacheGeneration)"
    }

    private var chatTranscriptCacheGeneration = 0

    /// Offline transcript cache plus durable command outbox, both scoped to
    /// the paired gateway identity (one SQLite file per gateway, memoized so
    /// retire/purge can close every open handle). Nil for fixture/unpaired
    /// transports: no cache and no outbox.
    func makeChatOfflineStore() -> OpenClawChatSQLiteTranscriptCache? {
        guard let gatewayID = self.chatTranscriptCacheGatewayID else { return nil }
        if let cache = self.chatTranscriptCachesByGatewayID[gatewayID] {
            return cache
        }
        guard let databaseURL = Self.chatTranscriptCacheDatabaseURL(gatewayID: gatewayID) else { return nil }
        let cache = OpenClawChatSQLiteTranscriptCache(databaseURL: databaseURL, gatewayID: gatewayID)
        self.chatTranscriptCachesByGatewayID[gatewayID] = cache
        return cache
    }

    var hasVerifiedChatOfflineRoutingIdentity: Bool {
        self.chatTranscriptCacheGatewayID != nil &&
            self.chatDeliveryAgentId != nil &&
            self.chatSessionRoutingContract != nil
    }

    func restoreChatSessionRoutingIdentityIfNeeded() async {
        guard !self.isLocalGatewayFixtureEnabled,
              self.chatSessionRoutingContract == nil,
              let store = self.makeChatOfflineStore()
        else { return }
        let identity = await store.loadSessionRoutingIdentity()
        #if DEBUG
        if let testChatSessionRoutingRestoreHandler {
            await testChatSessionRoutingRestoreHandler()
        }
        #endif
        guard !Task.isCancelled,
              let identity,
              self.chatTranscriptCacheGatewayID == store.gatewayID,
              self.chatSessionRoutingContract == nil
        else { return }
        self.selectedAgentId = GatewaySettingsStore.loadGatewaySelectedAgentId(stableID: store.gatewayID)
        self.gatewaySessionScope = identity.scope
        self.mainSessionBaseKey = identity.mainSessionKey
        self.gatewayDefaultAgentId = identity.defaultAgentID
        self.synchronizeTalkSessionKey()
        self.homeCanvasRevision &+= 1
    }

    func loadCachedChatSessions() async -> [OpenClawChatSessionEntry] {
        guard let cache = self.makeChatOfflineStore() else { return [] }
        return await cache.loadSessions()
    }

    func storeCachedChatSessions(_ sessions: [OpenClawChatSessionEntry]) async {
        guard let cache = self.makeChatOfflineStore() else { return }
        await cache.storeSessions(sessions)
    }

    /// Delete one gateway's cache during bootstrap replacement, or the whole
    /// disposable database during a full onboarding reset. The offline command
    /// outbox shares each gateway's database file, so purging a cache also
    /// drops that gateway's queued commands.
    func purgeChatTranscriptCache(gatewayID: String? = nil) async {
        if let gatewayID, !gatewayID.isEmpty {
            guard let databaseURL = Self.chatTranscriptCacheDatabaseURL(gatewayID: gatewayID) else { return }
            if let cache = self.chatTranscriptCachesByGatewayID[gatewayID] {
                await cache.retire()
            }
            OpenClawChatSQLiteTranscriptCache.removeDatabaseFiles(at: databaseURL)
            self.chatTranscriptCachesByGatewayID.removeValue(forKey: gatewayID)
            self.chatTranscriptCacheGeneration &+= 1
            return
        }

        // Full reset retires every open handle before removing SQLite sidecars,
        // so deleted transcript bytes cannot survive in WAL or journal pages.
        for cache in self.chatTranscriptCachesByGatewayID.values {
            await cache.retire()
        }
        if let directoryURL = Self.chatTranscriptCacheDirectoryURL() {
            try? FileManager.default.removeItem(at: directoryURL)
        }
        self.chatTranscriptCachesByGatewayID.removeAll()
        self.chatTranscriptCacheGeneration &+= 1
    }

    /// Debug launch reset runs before Chat can create a cache actor, so direct
    /// file removal preserves the launch flag's synchronous startup contract.
    func purgeChatTranscriptCacheBeforeStartup() {
        guard let directoryURL = Self.chatTranscriptCacheDirectoryURL() else { return }
        try? FileManager.default.removeItem(at: directoryURL)
        self.chatTranscriptCachesByGatewayID.removeAll()
        self.chatTranscriptCacheGeneration &+= 1
    }

    private static func chatTranscriptCacheDirectoryURL() -> URL? {
        try? OpenClawNodeStorage.appSupportDir()
            .appendingPathComponent("chat-cache", isDirectory: true)
    }

    static func chatTranscriptCacheDatabaseURL(gatewayID: String) -> URL? {
        let digest = SHA256.hash(data: Data(gatewayID.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return Self.chatTranscriptCacheDirectoryURL()?
            .appendingPathComponent("\(digest).sqlite", isDirectory: false)
    }

    private(set) var activeGatewayConnectConfig: GatewayConnectConfig?

    private static let watchExecApprovalBridgeStateKey = "watch.execApproval.bridge.state.v1"
    private static let backgroundAliveLastSuccessAtMsKey = "gateway.backgroundAlive.lastSuccessAtMs"
    private static let backgroundAliveLastTriggerKey = "gateway.backgroundAlive.lastTrigger"
    private static let foregroundResumeHealthTimeoutSeconds = 1
    private static let watchChatCompletionWaitMs = 75000
    private static let watchChatRunWaitSliceMs = 60000

    var cameraHUDText: String?
    var cameraHUDKind: CameraHUDKind?
    var cameraFlashNonce: Int = 0
    var screenRecordActive: Bool = false
    private(set) var watchMessagingStatus = WatchMessagingStatus(
        supported: false,
        paired: false,
        appInstalled: false,
        reachable: false,
        activationState: "notActivated")

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
        talkMode: TalkModeManager = TalkModeManager(),
        voiceNoteRecorder: OpenClawVoiceNoteRecorder = OpenClawVoiceNoteRecorder(),
        audioAdmissionInitiallyAllowed: Bool = true)
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
        self.voiceNoteRecorder = voiceNoteRecorder
        if !audioAdmissionInitiallyAllowed {
            // The production scene has not reported its initial phase yet. Keep
            // every microphone owner closed until SwiftUI explicitly admits it.
            self.isBackgrounded = true
            self.voiceWake.setSuppressedForBackground(true)
            self.talkMode.suspendForBackground()
        }
        self.talkMode.setPushToTalkAudioOwnershipEndHandler { [weak self] captureId in
            self?.releasePttVoiceWakeLease(for: captureId)
        }
        self.voiceNoteRecorder.setCaptureAdmissionHandler { [weak self] in
            self?.isBackgrounded == false &&
                self?.isTalkCaptureActive == false &&
                self?.auxiliaryAudioCapture == nil
        }
        self.apnsDeviceTokenHex = UserDefaults.standard.string(forKey: Self.apnsDeviceTokenUserDefaultsKey)
        restorePersistedWatchExecApprovalBridgeState()
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
                _ = await self?.handleWatchExecApprovalResolve(event)
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
        self.watchMessagingService.setAppSnapshotRequestHandler { [weak self] event in
            Task { @MainActor in
                guard let self else { return }
                GatewayDiagnostics.log(
                    "node app model: watch app snapshot request id=\(event.requestId)")
                await self.syncWatchAppSnapshot(reason: "watch_app_request", includeChat: true)
            }
        }
        self.watchMessagingService.setAppCommandHandler { [weak self] event in
            Task { @MainActor in
                await self?.handleWatchAppCommand(event)
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
        self.voiceNoteRecorder.onRecordingActiveChanged = { [weak self] isActive in
            self?.voiceWake.setSuppressedByVoiceNote(isActive)
        }

        let enabled = UserDefaults.standard.bool(forKey: "voiceWake.enabled")
        self.voiceWake.setEnabled(enabled)
        self.talkMode.attachGateway(self.operatorGateway)
        refreshOperatorAdminScopeFromStore()
        refreshLastShareEventFromRelay()
        let talkEnabled = UserDefaults.standard.bool(forKey: "talk.enabled")
        self.setTalkEnabled(talkEnabled)
        self.locationService.setAuthorizationChangeHandler { [weak self] status in
            guard let self else { return }
            self.reconcileSignificantLocationMonitoring(
                mode: self.locationMode(),
                authorizationStatus: status)
        }

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
        let sessionKey = mainSessionKey

        let messageContext = OpenClawCanvasA2UIAction.AgentMessageContext(
            actionName: name,
            session: .init(key: sessionKey, surfaceId: surfaceId),
            component: .init(id: sourceComponentId, host: host, instanceId: instanceId),
            contextJSON: contextJSON)
        let message = OpenClawCanvasA2UIAction.formatAgentMessage(messageContext)

        let ok: Bool
        var errorText: String?
        if await !isGatewayConnected() {
            ok = false
            errorText = "gateway not connected"
        } else {
            do {
                try await sendAgentRequest(link: AgentDeepLink(
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
            // This durable reason outlives asynchronous PTT/Talk teardown. A
            // late lease release cannot reopen Voice Wake while backgrounded.
            self.voiceWake.setSuppressedForBackground(true)
            // Captures remain owners until cancellation unwinds. Their defers
            // then clear tracking and any auxiliary-audio suppression they own.
            for cancel in self.foregroundCaptureCancellations.values {
                cancel()
            }
            self.stopGatewayHealthMonitor()
            self.backgroundedAt = Date()
            self.reconnectAfterBackgroundArmed = true
            self.beginBackgroundConnectionGracePeriod()
            if self.voiceNoteRecorder.isRecording || self.voiceNoteRecorder.isRequestingPermission {
                // Cancel first: releasing the voice-note suppression reason can
                // schedule Voice Wake, which the background suspension must catch.
                self.voiceNoteRecorder.cancel()
            }
            // Invalidate queued or permission-suspended PTT starts before releasing
            // Talk. Its capture-end callback can otherwise restart Voice Wake after
            // the background suspension has already run.
            self.talkPttCommandEpoch &+= 1
            let shouldKeepTalkActive = keepTalkActive && self.talkMode.canKeepContinuousTalkActiveInBackground
            self.backgroundTalkKeptActive = shouldKeepTalkActive
            self.talkMode.suspendForBackground(keepActive: shouldKeepTalkActive)
        case .inactive:
            // Background -> inactive is not foreground admission. iOS passes
            // through this phase before active; keep microphone gates closed.
            break
        case .active:
            self.isBackgrounded = false
            self.endBackgroundConnectionGracePeriod(reason: "scene_foreground")
            self.clearBackgroundReconnectSuppression(reason: "scene_foreground")
            var shouldStartGatewayHealthMonitor = self.operatorConnected
            self.voiceWake.setSuppressedForBackground(false)
            let keptActive = self.backgroundTalkKeptActive
            self.backgroundTalkKeptActive = false
            self.talkMode.resumeAfterBackground(wasKeptActive: keptActive)
            Task { [weak self] in
                await self?.resumePendingForegroundNodeActionsIfNeeded(trigger: "scene_active")
            }
            if self.reconnectAfterBackgroundArmed {
                self.reconnectAfterBackgroundArmed = false
                let backgroundedFor = self.backgroundedAt.map { Date().timeIntervalSince($0) } ?? 0
                self.backgroundedAt = nil
                // iOS may suspend network sockets in background without a clean close.
                // On foreground, force a fresh handshake to avoid "connected but dead" states.
                if backgroundedFor >= 3.0 {
                    shouldStartGatewayHealthMonitor = false
                    self.foregroundGatewayResumeCheckInFlight = true
                    Task { [weak self] in
                        guard let self else { return }
                        let operatorWasConnected = await MainActor.run { self.operatorConnected }
                        if operatorWasConnected {
                            // Prefer keeping the connection if it's healthy; reconnect only when needed.
                            let healthy = await (try? self.operatorGateway.request(
                                method: "health",
                                paramsJSON: nil,
                                timeoutSeconds: Self.foregroundResumeHealthTimeoutSeconds)) != nil
                            if healthy {
                                await MainActor.run {
                                    self.foregroundGatewayResumeCheckInFlight = false
                                    self.startGatewayHealthMonitor()
                                }
                                return
                            }
                        }

                        await MainActor.run {
                            self.foregroundGatewayResumeCheckInFlight = false
                        }
                        await self.restartGatewaySessionsAfterForegroundStaleConnection()
                    }
                }
            }
            if shouldStartGatewayHealthMonitor {
                self.startGatewayHealthMonitor()
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
        if let existing = backgroundReconnectLeaseUntil, existing > leaseUntil {
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
                guard !self.isLocalGatewayFixtureEnabled else { return }
                self.setOperatorConnected(false)
                self.gatewayConnected = false
                self.talkMode.updateGatewayConnected(false)
                if self.isBackgrounded {
                    self.gatewayStatusText = "Background idle"
                    LiveActivityManager.shared.endActivity(reason: "background_idle")
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
            }
        } else {
            self.voiceWake.setSuppressedByTalk(false)
        }
    }

    func setTalkEnabled(_ enabled: Bool) {
        if self.isAppleReviewDemoModeEnabled {
            UserDefaults.standard.set(false, forKey: "talk.enabled")
            self.talkMode.setEnabled(false)
            self.talkMode.statusText = "Demo mode only"
            return
        }
        if enabled, self.auxiliaryAudioCapture != nil {
            UserDefaults.standard.set(false, forKey: "talk.enabled")
            self.talkMode.setEnabled(false)
            self.talkMode.statusText = "Finish the active audio capture first"
            return
        }
        UserDefaults.standard.set(enabled, forKey: "talk.enabled")
        if enabled {
            if self.voiceNoteRecorder.isRecording || self.voiceNoteRecorder.isRequestingPermission {
                self.voiceNoteRecorder.cancel()
            }
            // Voice wake holds the microphone continuously; talk mode needs exclusive access for STT.
            // When talk is enabled from the UI, prioritize talk and pause voice wake.
            self.voiceWake.setSuppressedByTalk(true)
        } else {
            self.voiceWake.setSuppressedByTalk(false)
        }
        self.talkMode.setEnabled(enabled)
        Task { [weak self] in
            await self?.pushTalkModeToGateway(
                enabled: enabled,
                phase: enabled ? "enabled" : "disabled")
        }
    }

    func setTalkProviderSelection(_ rawValue: String) {
        let selection = TalkModeProviderSelection.resolved(rawValue)
        UserDefaults.standard.set(selection.rawValue, forKey: TalkModeProviderSelection.storageKey)
        self.talkMode.applyProviderSelectionChanged()
    }

    func setTalkRealtimeVoiceSelection(_ rawValue: String) {
        let voice = TalkModeRealtimeVoiceSelection.resolvedOverride(rawValue) ?? ""
        UserDefaults.standard.set(voice, forKey: TalkModeRealtimeVoiceSelection.storageKey)
        self.talkMode.applyProviderSelectionChanged()
    }

    func requestTalkPermissionUpgrade() {
        guard let config = activeGatewayConnectConfig else {
            self.talkMode.gatewayTalkPermissionState = .requestFailed("Gateway is not connected")
            self.talkMode.statusText = "Gateway not connected"
            return
        }
        GatewayDiagnostics.log("talk permission upgrade requested")
        self.talkMode.gatewayTalkPermissionState = .requestingUpgrade
        self.talkMode.statusText = "Requesting Talk approval"
        self.forceOperatorTalkPermissionUpgradeRequest = true
        self.gatewayAutoReconnectEnabled = true
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        self.lastGatewayProblem = nil
        self.operatorGatewayProblem = nil
        self.operatorGatewayTask?.cancel()
        self.operatorGatewayTask = nil
        let sessionBox = config.tls.map { WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0)) }
        Task { [weak self] in
            guard let self else { return }
            await self.operatorGateway.disconnect()
            await MainActor.run {
                self.startOperatorGatewayLoop(
                    url: config.url,
                    stableID: config.effectiveStableID,
                    token: config.token,
                    bootstrapToken: config.bootstrapToken,
                    password: config.password,
                    nodeOptions: config.nodeOptions,
                    sessionBox: sessionBox)
            }
        }
    }

    func pollTalkPermissionUpgrade() async {
        guard self.talkMode.gatewayTalkPermissionState.isApprovalRequestInProgress else {
            await self.talkMode.reloadConfig()
            await self.talkMode.prefetchRealtimeSessionIfReady(reason: "talk_permission_poll")
            return
        }

        guard let cfg = activeGatewayConnectConfig else {
            self.talkMode.gatewayTalkPermissionState = .requestFailed("Gateway is not connected")
            self.talkMode.statusText = "Gateway not connected"
            return
        }

        let now = Date()
        if let lastTalkPermissionReconnectAttemptAt,
           now.timeIntervalSince(lastTalkPermissionReconnectAttemptAt) < 6
        {
            return
        }
        lastTalkPermissionReconnectAttemptAt = now

        GatewayDiagnostics.log("talk permission approval poll reconnect")
        self.gatewayAutoReconnectEnabled = true
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        ensureOperatorReconnectLoopIfNeeded()

        if self.operatorGatewayTask == nil {
            let sessionBox = cfg.tls.map { WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0)) }
            startOperatorGatewayLoop(
                url: cfg.url,
                stableID: cfg.effectiveStableID,
                token: cfg.token,
                bootstrapToken: cfg.bootstrapToken,
                password: cfg.password,
                nodeOptions: cfg.nodeOptions,
                sessionBox: sessionBox)
        }

        guard await waitForOperatorConnection(timeoutMs: 2500, pollMs: 250) else {
            return
        }
        await self.talkMode.reloadConfig()
        await self.talkMode.prefetchRealtimeSessionIfReady(reason: "talk_permission_poll_connected")
    }

    func setTalkSpeakerphoneEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: TalkDefaults.speakerphoneEnabledKey)
        self.talkMode.applyAudioRoutePreferenceChanged()
    }

    func requestLocationPermissions(mode: OpenClawLocationMode) async -> Bool {
        guard mode != .off else {
            self.reconcileSignificantLocationMonitoring(
                mode: mode,
                authorizationStatus: self.locationService.authorizationStatus())
            return true
        }
        let status = await locationService.ensureAuthorization(mode: mode)
        switch status {
        case .authorizedAlways:
            self.reconcileSignificantLocationMonitoring(mode: mode, authorizationStatus: status)
            return true
        case .authorizedWhenInUse:
            self.reconcileSignificantLocationMonitoring(mode: mode, authorizationStatus: status)
            return true
        default:
            self.reconcileSignificantLocationMonitoring(mode: mode, authorizationStatus: status)
            return false
        }
    }

    private func reconcileSignificantLocationMonitoring(
        mode: OpenClawLocationMode,
        authorizationStatus: CLAuthorizationStatus)
    {
        guard mode == .always, authorizationStatus == .authorizedAlways else {
            self.locationService.setBackgroundLocationUpdatesEnabled(false)
            self.locationService.stopMonitoringSignificantLocationChanges()
            return
        }
        SignificantLocationMonitor.startIfNeeded(
            locationService: self.locationService,
            locationMode: mode,
            gateway: self.nodeGateway,
            beforeSend: { [weak self] in
                await self?.handleSignificantLocationWakeIfNeeded()
            })
    }

    private static let apnsDeviceTokenUserDefaultsKey = "push.apns.deviceTokenHex"
    private static let deepLinkKeyUserDefaultsKey = "deeplink.agent.key"
    private static let canvasUnattendedDeepLinkKey: String = NodeAppModel.generateDeepLinkKey()

    private func refreshBrandingFromGateway(shouldApply: () -> Bool = { true }) async {
        do {
            guard let sourceGatewayID = self.chatTranscriptCacheGatewayID,
                  let sourceRoute = await operatorGateway.currentRoute(ifGatewayID: sourceGatewayID)
            else { return }
            let res = try await operatorGateway.request(
                method: "config.get",
                paramsJSON: "{}",
                timeoutSeconds: 8,
                ifCurrentRoute: sourceRoute)
            guard let json = try JSONSerialization.jsonObject(with: res) as? [String: Any] else { return }
            guard let config = json["config"] as? [String: Any] else { return }
            let session = config["session"] as? [String: Any]
            let mainKey = SessionKey.normalizeMainKey(session?["mainKey"] as? String)
            let scope = (session?["scope"] as? String) ?? "per-sender"
            guard shouldApply(), self.chatTranscriptCacheGatewayID == sourceGatewayID else { return }
            await MainActor.run {
                self.mainSessionBaseKey = mainKey
                self.gatewaySessionScope = scope
                self.synchronizeTalkSessionKey()
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

    private func refreshAgentsFromGateway(shouldApply: () -> Bool = { true }) async {
        do {
            guard let sourceGatewayID = self.chatTranscriptCacheGatewayID,
                  let sourceStore = self.makeChatOfflineStore(),
                  sourceStore.gatewayID == sourceGatewayID,
                  let sourceRoute = await operatorGateway.currentRoute(ifGatewayID: sourceGatewayID)
            else { return }
            let res = try await operatorGateway.request(
                method: "agents.list",
                paramsJSON: "{}",
                timeoutSeconds: 8,
                ifCurrentRoute: sourceRoute)
            let decoded = try JSONDecoder().decode(AgentsListResult.self, from: res)
            let routingIdentity = OpenClawChatSessionRoutingIdentity(
                scope: decoded.scope.value as? String,
                mainSessionKey: decoded.mainkey,
                defaultAgentID: decoded.defaultid)
            guard shouldApply(), self.chatTranscriptCacheGatewayID == sourceGatewayID else { return }
            await MainActor.run {
                self.gatewayDefaultAgentId = decoded.defaultid
                self.gatewayAgents = decoded.agents
                self.gatewaySessionScope = decoded.scope.value as? String
                self.applyMainSessionKey(decoded.mainkey)

                let selected = (self.selectedAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !selected.isEmpty, !decoded.agents.contains(where: { $0.id == selected }) {
                    self.selectedAgentId = nil
                    self.focusedChatSessionKey = nil
                }
                self.synchronizeTalkSessionKey()
                self.homeCanvasRevision &+= 1
            }
            if let routingIdentity {
                await sourceStore.storeSessionRoutingIdentity(routingIdentity)
            }
        } catch {
            // Best-effort only.
        }
    }

    func refreshGatewayOverviewIfConnected() async {
        guard await isOperatorConnected() else { return }
        if self.foregroundGatewayResumeCheckInFlight {
            GatewayDiagnostics.log("gateway overview refresh deferred reason=foreground_resume_check")
            try? await Task.sleep(
                nanoseconds: UInt64(Self.foregroundResumeHealthTimeoutSeconds) * 1_000_000_000)
            guard await isOperatorConnected(), !self.foregroundGatewayResumeCheckInFlight else { return }
        }
        await self.refreshBrandingFromGateway()
        await self.refreshAgentsFromGateway()
    }

    func setSelectedAgentId(_ agentId: String?) {
        let trimmed = (agentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let nextSelectedAgentId = trimmed.isEmpty ? nil : trimmed
        let currentSelectedAgentId = self.selectedAgentId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let selectedAgentChanged = currentSelectedAgentId != nextSelectedAgentId
        let stableID = (connectedGatewayID ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if stableID.isEmpty {
            self.selectedAgentId = nextSelectedAgentId
        } else {
            self.selectedAgentId = nextSelectedAgentId
            GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: stableID, agentId: self.selectedAgentId)
        }
        if selectedAgentChanged {
            self.focusedChatSessionKey = nil
        }
        self.synchronizeTalkSessionKey()
        self.homeCanvasRevision &+= 1
        if let relay = ShareGatewayRelaySettings.loadConfig() {
            ShareGatewayRelaySettings.saveConfig(
                ShareGatewayRelayConfig(
                    gatewayURLString: relay.gatewayURLString,
                    gatewayStableID: relay.gatewayStableID,
                    token: relay.token,
                    password: relay.password,
                    sessionKey: mainSessionKey,
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

    private func startVoiceWakeSync(shouldContinue: @escaping @MainActor @Sendable () -> Bool = { true }) async {
        guard shouldContinue() else { return }
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = Task { [weak self] in
            guard let self else { return }

            if !self.isGatewayHealthMonitorDisabled() {
                await self.refreshWakeWordsFromGateway(shouldApply: shouldContinue)
            }
            guard shouldContinue() else { return }

            guard let operatorRoute = await self.operatorGateway.currentRoute(), shouldContinue() else { return }
            let stream = await self.operatorGateway.subscribeServerEvents(bufferingNewest: 200)
            for await evt in stream {
                if Task.isCancelled || !shouldContinue() { return }
                guard evt.payload != nil else { continue }
                await self.handleOperatorGatewayServerEvent(
                    evt,
                    expectedOperatorRoute: operatorRoute,
                    shouldContinue: shouldContinue)
            }
        }
    }

    private func handleOperatorGatewayServerEvent(
        _ evt: EventFrame,
        expectedOperatorRoute: GatewayNodeSessionRoute? = nil,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
    {
        guard shouldContinue(), let payload = evt.payload else { return }
        switch evt.event {
        case "voicewake.changed":
            struct Payload: Decodable { var triggers: [String] }
            guard let decoded = try? GatewayPayloadDecoding.decode(payload, as: Payload.self) else { return }
            let triggers = VoiceWakePreferences.sanitizeTriggerWords(decoded.triggers)
            VoiceWakePreferences.saveTriggerWords(triggers)
        case "talk.mode":
            struct Payload: Decodable {
                var enabled: Bool
                var phase: String?
            }
            guard let decoded = try? GatewayPayloadDecoding.decode(payload, as: Payload.self) else { return }
            self.applyTalkModeSync(enabled: decoded.enabled, phase: decoded.phase)
        case ExecApprovalNotificationBridge.requestedKind:
            guard let approvalId = Self.execApprovalEventID(from: payload) else { return }
            await self.presentNotificationPermissionGuidanceForExecApprovalIfNeeded(
                approvalId: approvalId,
                shouldApply: shouldContinue)
            guard shouldContinue() else { return }
            await presentExecApprovalGatewayEventPrompt(
                approvalId: approvalId,
                expectedOperatorRoute: expectedOperatorRoute,
                shouldContinue: shouldContinue)
        case ExecApprovalNotificationBridge.resolvedKind:
            guard let approvalId = Self.execApprovalEventID(from: payload) else { return }
            await handleExecApprovalResolvedForCurrentGateway(
                approvalId: approvalId,
                shouldContinue: shouldContinue)
        default:
            return
        }
    }

    private nonisolated static func execApprovalEventID(from payload: AnyCodable) -> String? {
        guard let decoded = try? GatewayPayloadDecoding.decode(
            payload,
            as: ExecApprovalGatewayEventPayload.self)
        else {
            return nil
        }
        let approvalId = decoded.id.trimmingCharacters(in: .whitespacesAndNewlines)
        return approvalId.isEmpty ? nil : approvalId
    }

    private func applyTalkModeSync(enabled: Bool, phase: String?) {
        _ = phase
        guard self.talkMode.isEnabled != enabled else { return }
        self.setTalkEnabled(enabled)
    }

    private func pushTalkModeToGateway(enabled: Bool, phase: String?) async {
        guard await isOperatorConnected() else { return }
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
                    guard !self.isLocalGatewayFixtureEnabled else { return }
                    self.setOperatorConnected(false)
                    self.gatewayConnected = false
                    self.gatewayStatusText = "Reconnecting…"
                    self.talkMode.updateGatewayConnected(false)
                }
            })
    }

    private func stopGatewayHealthMonitor() {
        self.gatewayHealthMonitor.stop()
    }

    private func handleInvoke(
        _ req: BridgeInvokeRequest,
        gatewayStableID: String? = nil) async -> BridgeInvokeResponse
    {
        let command = req.command

        if self.isBackgrounded, self.isBackgroundRestricted(command) {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .backgroundUnavailable,
                    message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen/talk commands require foreground"))
        }

        if command.hasPrefix("camera."), !isCameraEnabled() {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "CAMERA_DISABLED: enable Camera in iOS Settings → Camera → Allow Camera"))
        }

        do {
            return try await self.capabilityRouter.handle(
                Self.scopedWatchNotificationRequest(req, gatewayStableID: gatewayStableID))
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
        } catch is CancellationError {
            if command.hasPrefix("camera.") {
                self.clearCameraHUD(ownerID: req.id)
            }
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: "node invoke cancelled"))
        } catch {
            if command.hasPrefix("camera.") {
                let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self.updateCameraHUD(ownerID: req.id, text: text, kind: .error, autoHideSeconds: 2.2)
            }
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: error.localizedDescription))
        }
    }

    private static func scopedWatchNotificationRequest(
        _ req: BridgeInvokeRequest,
        gatewayStableID: String?) -> BridgeInvokeRequest
    {
        guard req.command == OpenClawWatchCommand.notify.rawValue,
              var params = try? decodeParams(OpenClawWatchNotifyParams.self, from: req.paramsJSON)
        else { return req }
        // Gateway identity comes from the installed node route, never the request payload.
        params.gatewayStableID = trimmedOrNil(gatewayStableID)
        guard let paramsJSON = try? encodePayload(params) else { return req }
        return BridgeInvokeRequest(
            type: req.type,
            id: req.id,
            command: req.command,
            paramsJSON: paramsJSON,
            nodeId: req.nodeId)
    }

    private func isBackgroundRestricted(_ command: String) -> Bool {
        command.hasPrefix("canvas.") || command.hasPrefix("camera.") || command.hasPrefix("screen.") ||
            command.hasPrefix("talk.")
    }

    private func handleLocationInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let mode = locationMode()
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
            (isLocationPreciseEnabled() ? .precise : .balanced)
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
        let location = try await locationService.currentLocation(
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
                self.screen.presentDefaultCanvas()
            } else {
                self.screen.present(urlString: url)
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.hide.rawValue:
            self.screen.hideCanvas()
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.navigate.rawValue:
            let params = try Self.decodeParams(OpenClawCanvasNavigateParams.self, from: req.paramsJSON)
            let trimmedURL = params.url.trimmingCharacters(in: .whitespacesAndNewlines)
            self.screen.present(urlString: trimmedURL)
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.evalJS.rawValue:
            let params = try Self.decodeParams(OpenClawCanvasEvalParams.self, from: req.paramsJSON)
            let result = try await screen.eval(javaScript: params.javaScript)
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
            let base64 = try await screen.snapshotBase64(
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
            switch await ensureA2UIReadyWithCapabilityRefresh(timeoutMs: 5000) {
            case .ready:
                break
            case .hostUnavailable:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_UNAVAILABLE: bundled A2UI host not reachable"))
            }
            let json = try await screen.eval(javaScript: """
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

            switch await ensureA2UIReadyWithCapabilityRefresh(timeoutMs: 5000) {
            case .ready:
                break
            case .hostUnavailable:
                return BridgeInvokeResponse(
                    id: req.id,
                    ok: false,
                    error: OpenClawNodeError(
                        code: .unavailable,
                        message: "A2UI_HOST_UNAVAILABLE: bundled A2UI host not reachable"))
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
            let resultJSON = try await screen.eval(javaScript: js)
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
            let devices = await camera.listDevices()
            struct Payload: Codable {
                var devices: [CameraController.CameraDeviceInfo]
            }
            let payload = try Self.encodePayload(Payload(devices: devices))
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCameraCommand.snap.rawValue:
            showCameraHUD(ownerID: req.id, text: "Taking photo…", kind: .photo)
            triggerCameraFlash()
            let params = (try? Self.decodeParams(OpenClawCameraSnapParams.self, from: req.paramsJSON)) ??
                OpenClawCameraSnapParams()
            let res = try await self.withForegroundCapture {
                try await self.camera.snap(params: params)
            }

            struct Payload: Codable {
                var format: String
                var base64: String
                var width: Int
                var height: Int
            }
            try Task.checkCancellation()
            let payload = try Self.encodePayload(Payload(
                format: res.format,
                base64: res.base64,
                width: res.width,
                height: res.height))
            try Task.checkCancellation()
            updateCameraHUD(ownerID: req.id, text: "Photo captured", kind: .success, autoHideSeconds: 1.6)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCameraCommand.clip.rawValue:
            let params = (try? Self.decodeParams(OpenClawCameraClipParams.self, from: req.paramsJSON)) ??
                OpenClawCameraClipParams()

            let includeAudio = params.includeAudio ?? true
            showCameraHUD(ownerID: req.id, text: "Recording…", kind: .recording)
            let res = try await self.withForegroundCapture(
                audioOwner: includeAudio ? .cameraClip : nil)
            {
                try await self.camera.clip(params: params)
            }

            struct Payload: Codable {
                var format: String
                var base64: String
                var durationMs: Int
                var hasAudio: Bool
            }
            try Task.checkCancellation()
            let payload = try Self.encodePayload(Payload(
                format: res.format,
                base64: res.base64,
                durationMs: res.durationMs,
                hasAudio: res.hasAudio))
            try Task.checkCancellation()
            updateCameraHUD(ownerID: req.id, text: "Clip captured", kind: .success, autoHideSeconds: 1.8)
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
        let includeAudio = params.includeAudio ?? true
        guard !self.screenRecordActive else {
            throw NSError(domain: "Screen", code: 31, userInfo: [
                NSLocalizedDescriptionKey: "SCREEN_CAPTURE_BUSY: screen recording already active",
            ])
        }
        // Status pill mirrors screen recording state so it stays visible without overlay stacking.
        self.screenRecordActive = true
        defer { self.screenRecordActive = false }
        let data = try await self.withForegroundCapture(
            audioOwner: includeAudio ? .screenRecording : nil)
        {
            let path = try await self.screenRecorder.record(
                screenIndex: params.screenIndex,
                durationMs: params.durationMs,
                fps: params.fps,
                includeAudio: params.includeAudio,
                outPath: nil)
            defer { try? FileManager().removeItem(atPath: path) }
            return try Data(contentsOf: URL(fileURLWithPath: path))
        }
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
            hasAudio: includeAudio))
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

        let status = await notificationAuthorizationStatus()
        guard Self.isNotificationServingEnabled(status) else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: "NOT_AUTHORIZED: notifications"))
        }

        let addResult = await runNotificationCall(timeoutSeconds: 2.0) { [notificationCenter] in
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

        let shouldSpeak = params.speak ?? true
        let status = await notificationAuthorizationStatus()
        let notificationsAllowed = Self.isNotificationServingEnabled(status)
        if !notificationsAllowed, !shouldSpeak {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .unavailable, message: "NOT_AUTHORIZED: notifications"))
        }

        let messageId = UUID().uuidString
        if notificationsAllowed {
            let addResult = await runNotificationCall(timeoutSeconds: 2.0) { [notificationCenter] in
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

        if shouldSpeak {
            let toSpeak = text
            Task { @MainActor in
                try? await TalkSystemSpeechSynthesizer.shared.speak(text: toSpeak)
            }
        }

        let payload = OpenClawChatPushPayload(messageId: messageId)
        let json = try Self.encodePayload(payload)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func notificationAuthorizationStatus() async -> NotificationAuthorizationStatus {
        let result = await runNotificationCall(timeoutSeconds: 1.5) { [notificationCenter] in
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

    private static func isNotificationServingEnabled(
        _ status: NotificationAuthorizationStatus) -> Bool
    {
        NotificationServingPreference.isEnabled() && self.isNotificationAuthorizationAllowed(status)
    }

    private func presentNotificationPermissionGuidanceForExecApprovalIfNeeded(
        approvalId: String,
        shouldApply: @MainActor @Sendable () -> Bool = { true }) async
    {
        guard shouldApply(), !self.execApprovalNotificationGuidanceSuppressed else { return }
        let status = await notificationAuthorizationStatus()
        guard shouldApply(), !Self.isNotificationAuthorizationAllowed(status) else { return }
        self.pendingNotificationPermissionGuidancePrompt =
            NotificationPermissionGuidancePrompt(approvalId: approvalId)
    }

    var execApprovalNotificationGuidanceSuppressed: Bool {
        UserDefaults.standard.bool(forKey: Self.execApprovalNotificationGuidanceSuppressedKey)
    }

    func dismissNotificationPermissionGuidancePrompt(suppressFuture: Bool) {
        if suppressFuture {
            UserDefaults.standard.set(true, forKey: Self.execApprovalNotificationGuidanceSuppressedKey)
        }
        self.pendingNotificationPermissionGuidancePrompt = nil
    }

    func resetExecApprovalNotificationGuidanceSuppression() {
        UserDefaults.standard.removeObject(forKey: Self.execApprovalNotificationGuidanceSuppressedKey)
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
            let payload = try await deviceStatusService.status()
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
        let payload = try await photosService.latest(params: params)
        let json = try Self.encodePayload(payload)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func handleContactsInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawContactsCommand.search.rawValue:
            let params = (try? Self.decodeParams(OpenClawContactsSearchParams.self, from: req.paramsJSON)) ??
                OpenClawContactsSearchParams()
            let payload = try await contactsService.search(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawContactsCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawContactsAddParams.self, from: req.paramsJSON)
            let payload = try await contactsService.add(params: params)
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
            let payload = try await calendarService.events(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawCalendarCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawCalendarAddParams.self, from: req.paramsJSON)
            let payload = try await calendarService.add(params: params)
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
            let payload = try await remindersService.list(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawRemindersCommand.add.rawValue:
            let params = try Self.decodeParams(OpenClawRemindersAddParams.self, from: req.paramsJSON)
            let payload = try await remindersService.add(params: params)
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
            let payload = try await motionService.activities(params: params)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawMotionCommand.pedometer.rawValue:
            let params = (try? Self.decodeParams(OpenClawPedometerParams.self, from: req.paramsJSON)) ??
                OpenClawPedometerParams()
            let payload = try await motionService.pedometer(params: params)
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
        try Task.checkCancellation()
        switch req.command {
        case OpenClawTalkCommand.pttStart.rawValue:
            let commandEpoch = self.talkPttCommandEpoch
            var reservedCaptureId: String?
            do {
                let payload = try await self.withTalkCapturePreparation(commandEpoch: commandEpoch) {
                    try self.rejectTalkCaptureWhileOtherAudioActive()
                    return try await self.talkMode.beginPushToTalk(
                        canStartCapture: {
                            self.talkPttCommandEpoch == commandEpoch && !self.isBackgrounded
                        },
                        onCaptureReserved: { captureId in
                            reservedCaptureId = captureId
                            self.acquirePttVoiceWakeLease(for: captureId)
                        })
                }
                #if DEBUG
                if let testTalkCaptureStartedHandler {
                    await testTalkCaptureStartedHandler()
                }
                #endif
                try self.ensureTalkPttStartCurrent(commandEpoch, captureId: payload.captureId)
                let json = try Self.encodePayload(payload)
                try self.ensureTalkPttStartCurrent(commandEpoch, captureId: payload.captureId)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
            } catch {
                if let reservedCaptureId {
                    _ = self.talkMode.cancelPushToTalk(captureId: reservedCaptureId)
                }
                throw error
            }
        case OpenClawTalkCommand.pttOnce.rawValue:
            let commandEpoch = self.talkPttCommandEpoch
            var reservedCaptureId: String?
            let start: TalkPushToTalkOnceStart
            do {
                start = try await self.withTalkCapturePreparation(commandEpoch: commandEpoch) {
                    try self.rejectTalkCaptureWhileOtherAudioActive()
                    return try await self.talkMode.beginPushToTalkOnce(
                        canStartCapture: {
                            self.talkPttCommandEpoch == commandEpoch && !self.isBackgrounded
                        },
                        onCaptureReserved: { captureId in
                            reservedCaptureId = captureId
                            self.acquirePttVoiceWakeLease(for: captureId)
                        })
                }
            } catch {
                if let reservedCaptureId {
                    _ = self.talkMode.cancelPushToTalk(captureId: reservedCaptureId)
                }
                throw error
            }
            let payload: OpenClawTalkPTTStopPayload = switch start {
            case let .busy(busyPayload):
                busyPayload
            case .started:
                await self.talkMode.awaitPushToTalkOnce(start)
            }
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawTalkCommand.pttStop.rawValue:
            // Interrupt commands invalidate suspended preparation before touching
            // capture state, then bypass the preparation queue entirely.
            self.talkPttCommandEpoch &+= 1
            let payload = self.talkMode.endPushToTalk()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        case OpenClawTalkCommand.pttCancel.rawValue:
            self.talkPttCommandEpoch &+= 1
            let payload = self.talkMode.cancelPushToTalk()
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        default:
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(code: .invalidRequest, message: "INVALID_REQUEST: unknown command"))
        }
    }

    private func rejectTalkCaptureWhileOtherAudioActive() throws {
        // Remote PTT bypasses the Chat Talk toggle. Preserve the user's draft;
        // Talk must not reconfigure AVAudioSession while its recorder owns it.
        if self.voiceNoteRecorder.isRecording || self.voiceNoteRecorder.isRequestingPermission {
            throw NSError(domain: "TalkMode", code: 8, userInfo: [
                NSLocalizedDescriptionKey: "Finish or cancel the active voice note before starting push-to-talk.",
            ])
        }
        if self.auxiliaryAudioCapture != nil {
            throw NSError(domain: "TalkMode", code: 8, userInfo: [
                NSLocalizedDescriptionKey: "Finish the active audio capture before starting push-to-talk.",
            ])
        }
    }

    private func acquireAuxiliaryAudioCapture(_ owner: AuxiliaryAudioCapture) throws {
        guard self.auxiliaryAudioCapture == nil,
              !self.isBackgrounded,
              !self.isTalkCaptureActive,
              !self.voiceNoteRecorder.isRecording,
              !self.voiceNoteRecorder.isRequestingPermission
        else {
            throw NSError(domain: "AudioCapture", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Finish the active audio capture before starting another one.",
            ])
        }
        self.auxiliaryAudioCapture = owner
        self.voiceWake.setSuppressedForAuxiliaryAudio(true)
    }

    private func releaseAuxiliaryAudioCapture(_ owner: AuxiliaryAudioCapture) {
        guard self.auxiliaryAudioCapture == owner else { return }
        self.auxiliaryAudioCapture = nil
        self.voiceWake.setSuppressedForAuxiliaryAudio(false)
    }

    private func withForegroundCapture<T: Sendable>(
        audioOwner: AuxiliaryAudioCapture? = nil,
        operation: @escaping @MainActor () async throws -> T) async throws -> T
    {
        try self.ensureForegroundCaptureAllowed()
        if let audioOwner {
            try self.acquireAuxiliaryAudioCapture(audioOwner)
        }
        let captureTask = Task {
            try Task.checkCancellation()
            let result = try await operation()
            try Task.checkCancellation()
            return result
        }
        let captureId = UUID()
        self.foregroundCaptureCancellations[captureId] = { captureTask.cancel() }
        defer {
            self.foregroundCaptureCancellations.removeValue(forKey: captureId)
            if let audioOwner {
                self.releaseAuxiliaryAudioCapture(audioOwner)
            }
        }

        return try await withTaskCancellationHandler {
            try await captureTask.value
        } onCancel: {
            captureTask.cancel()
        }
    }

    private func ensureForegroundCaptureAllowed() throws {
        guard !self.isBackgrounded else {
            throw NSError(domain: "AudioCapture", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "NODE_BACKGROUND_UNAVAILABLE: camera and screen capture require foreground",
            ])
        }
    }

    private func acquirePttVoiceWakeLease(for captureId: String) {
        guard self.pttVoiceWakeLeaseCaptureId != captureId else { return }
        self.pttVoiceWakeLeaseCaptureId = captureId
        // The suppression reason outlives Voice Wake enable/disable toggles,
        // so enabling it mid-capture cannot open a competing audio pipeline.
        self.voiceWake.setSuppressedByPushToTalk(true)
    }

    private func releasePttVoiceWakeLease(for captureId: String) {
        guard self.pttVoiceWakeLeaseCaptureId == captureId else { return }
        self.pttVoiceWakeLeaseCaptureId = nil
        // Capture identity makes stale stop/cancel cleanup harmless. Resume Voice
        // Wake only after the live capture owner releases its lease.
        self.voiceWake.setSuppressedByPushToTalk(false)
    }

    private func withTalkCapturePreparation<T>(
        commandEpoch: UInt64,
        operation: () async throws -> T) async throws -> T
    {
        try await self.acquireTalkPreparation()
        defer { self.releaseTalkPreparation() }
        try self.ensureTalkPttCommandCurrent(commandEpoch)
        #if DEBUG
        if let testTalkCapturePreparationHandler {
            await testTalkCapturePreparationHandler()
        }
        #endif
        try self.ensureTalkPttCommandCurrent(commandEpoch)
        return try await operation()
    }

    private func ensureTalkPttCommandCurrent(_ commandEpoch: UInt64) throws {
        try Task.checkCancellation()
        guard self.talkPttCommandEpoch == commandEpoch, !self.isBackgrounded else {
            throw NSError(domain: "TalkMode", code: 9, userInfo: [
                NSLocalizedDescriptionKey: "PTT_CANCELLED: push-to-talk start was cancelled",
            ])
        }
    }

    private func ensureTalkPttStartCurrent(_ commandEpoch: UInt64, captureId: String) throws {
        try self.ensureTalkPttCommandCurrent(commandEpoch)
        guard self.talkMode.isActivePushToTalkCapture(captureId) else {
            throw NSError(domain: "TalkMode", code: 9, userInfo: [
                NSLocalizedDescriptionKey: "PTT_CANCELLED: push-to-talk start was cancelled",
            ])
        }
    }

    private func acquireTalkPreparation() async throws {
        if !self.talkPreparationInFlight {
            try Task.checkCancellation()
            self.talkPreparationInFlight = true
            return
        }
        let waiterID = UUID()
        let acquired = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled {
                    continuation.resume(returning: false)
                    return
                }
                self.talkPreparationWaiters.append((id: waiterID, continuation: continuation))
            }
        } onCancel: {
            Task { @MainActor in
                self.cancelTalkPreparationWaiter(id: waiterID)
            }
        }
        guard acquired else {
            try Task.checkCancellation()
            return
        }
        do {
            try Task.checkCancellation()
        } catch {
            self.releaseTalkPreparation()
            throw error
        }
    }

    private func cancelTalkPreparationWaiter(id: UUID) {
        guard let index = self.talkPreparationWaiters.firstIndex(where: { $0.id == id }) else { return }
        self.talkPreparationWaiters.remove(at: index).continuation.resume(returning: false)
    }

    private func releaseTalkPreparation() {
        guard !self.talkPreparationWaiters.isEmpty else {
            self.talkPreparationInFlight = false
            return
        }
        self.talkPreparationWaiters.removeFirst().continuation.resume(returning: true)
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
            let status = await watchMessagingService.status()
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
                let gatewayStableID = currentWatchChatGatewayStableID()
                self.watchMessageOutbox.recordPromptRoute(
                    promptID: normalizedParams.promptId,
                    gatewayStableID: gatewayStableID)
                let result = try await watchMessagingService.sendNotification(
                    id: req.id,
                    params: normalizedParams,
                    gatewayStableID: gatewayStableID)
                if result.queuedForDelivery || !result.deliveredImmediately {
                    let invokeID = req.id
                    Task { @MainActor in
                        await WatchPromptNotificationBridge.scheduleMirroredWatchPromptNotificationIfNeeded(
                            invokeID: invokeID,
                            params: normalizedParams,
                            gatewayStableID: gatewayStableID,
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

    func sendDirectWatchSetup() async throws -> WatchNotificationSendResult {
        struct SetupCodeResponse: Decodable {
            var setupCode: String
        }

        guard self.isOperatorGatewayConnected else {
            throw NSError(domain: "WatchDirectSetup", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Connect the iPhone to a Gateway first.",
            ])
        }
        guard self.hasOperatorAdminScope else {
            throw NSError(domain: "WatchDirectSetup", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "The iPhone connection needs operator.admin access.",
            ])
        }
        let status = await watchMessagingService.status()
        guard status.supported, status.paired, status.appInstalled else {
            throw NSError(domain: "WatchDirectSetup", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Pair an Apple Watch and install the OpenClaw watch app first.",
            ])
        }

        let response = try await operatorGateway.request(
            method: "device.pair.setupCode",
            paramsJSON: #"{"includeQr":false,"bootstrapProfile":"node"}"#,
            timeoutSeconds: 20)
        let setup = try JSONDecoder().decode(SetupCodeResponse.self, from: response)
        guard let setupLink = GatewayConnectDeepLink.fromSetupCode(setup.setupCode),
              setupLink.connectionEndpoints.contains(where: \.tls)
        else {
            throw NSError(domain: "WatchDirectSetup", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "Direct Apple Watch mode requires a trusted HTTPS Gateway endpoint.",
            ])
        }
        return try await self.watchMessagingService.sendDirectNodeSetup(setupCode: setup.setupCode)
    }

    func refreshWatchMessagingStatus() async {
        self.watchMessagingStatus = await self.watchMessagingService.status()
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

    private func showCameraHUD(
        ownerID: String,
        text: String,
        kind: CameraHUDKind,
        autoHideSeconds: Double? = nil)
    {
        self.cameraHUDDismissTask?.cancel()
        self.cameraHUDOwnerID = ownerID

        withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
            self.cameraHUDText = text
            self.cameraHUDKind = kind
        }

        guard let autoHideSeconds else { return }
        self.cameraHUDDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(autoHideSeconds * 1_000_000_000))
            guard self.cameraHUDOwnerID == ownerID else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                self.cameraHUDText = nil
                self.cameraHUDKind = nil
            }
            self.cameraHUDOwnerID = nil
            self.cameraHUDDismissTask = nil
        }
    }

    private func updateCameraHUD(
        ownerID: String,
        text: String,
        kind: CameraHUDKind,
        autoHideSeconds: Double? = nil)
    {
        guard self.cameraHUDOwnerID == ownerID else { return }
        self.showCameraHUD(ownerID: ownerID, text: text, kind: kind, autoHideSeconds: autoHideSeconds)
    }

    private func clearCameraHUD(ownerID: String) {
        guard self.cameraHUDOwnerID == ownerID else { return }
        self.cameraHUDDismissTask?.cancel()
        self.cameraHUDDismissTask = nil
        self.cameraHUDOwnerID = nil
        self.cameraHUDText = nil
        self.cameraHUDKind = nil
    }
}

extension NodeAppModel {
    var mainSessionKey: String {
        let base = SessionKey.normalizeMainKey(self.mainSessionBaseKey)
        let agentId = (selectedAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let defaultId = (gatewayDefaultAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if agentId.isEmpty || (!defaultId.isEmpty && agentId == defaultId) { return base }
        return SessionKey.makeAgentSessionKey(agentId: agentId, baseKey: base)
    }

    var chatSessionKey: String {
        if let focused = focusedChatSessionKey?.trimmingCharacters(in: .whitespacesAndNewlines),
           !focused.isEmpty
        {
            return focused
        }
        return self.defaultChatSessionKey
    }

    var defaultChatSessionKey: String {
        // Keep chat aligned with the gateway's resolved main session key.
        // A hardcoded "ios" base creates synthetic placeholder sessions in the chat UI.
        self.mainSessionKey
    }

    func openChat(sessionKey: String?, unread: Bool = false) {
        self.focusChatSession(sessionKey)
        let activeKey = self.chatSessionKey
        self.openedChatSessionKey = activeKey
        if self.readAcknowledgedChatSessionKey != activeKey {
            self.readAcknowledgedChatSessionKey = nil
        }
        if unread {
            self.acknowledgeChatSessionReadIfNeeded(activeKey)
        }
        self.openChatRequestID &+= 1
    }

    /// One acknowledgement per unread episode: the pending flag clears when a fresh
    /// snapshot confirms the read (unread != true), so a run finishing while the
    /// session stays open re-acknowledges without patch loops (the gateway stamps
    /// lastReadAt server-side, which makes the exchange convergent).
    func reconcileChatSessionReadState(_ entries: [OpenClawChatSessionEntry]) {
        guard let openedKey = self.openedChatSessionKey,
              let entry = entries.first(where: { $0.key == openedKey })
        else { return }
        if entry.unread != true {
            if self.readAcknowledgedChatSessionKey == openedKey {
                self.readAcknowledgedChatSessionKey = nil
            }
            return
        }
        // Only the currently open chat auto-acknowledges fresh unread episodes.
        guard openedKey == self.chatSessionKey else { return }
        self.acknowledgeChatSessionReadIfNeeded(openedKey)
    }

    private func acknowledgeChatSessionReadIfNeeded(_ sessionKey: String) {
        guard self.readAcknowledgedChatSessionKey != sessionKey else { return }
        self.readAcknowledgedChatSessionKey = sessionKey
        let transport = self.makeChatTransport()
        Task { @MainActor in
            do {
                try await transport.patchSession(
                    key: sessionKey,
                    label: nil,
                    category: nil,
                    pinned: nil,
                    archived: nil,
                    unread: false)
            } catch {
                if self.readAcknowledgedChatSessionKey == sessionKey {
                    self.readAcknowledgedChatSessionKey = nil
                }
            }
        }
    }

    func focusChatSession(_ sessionKey: String?) {
        let trimmed = (sessionKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        self.focusedChatSessionKey = trimmed.isEmpty ? nil : trimmed
        self.synchronizeTalkSessionKey()
    }

    /// Session changes invalidate queued PTT admission before Talk cancels any
    /// active owner. Otherwise a waiter can wake and retarget to the new chat.
    func synchronizeTalkSessionKey(_ sessionKey: String? = nil) {
        let effectiveSessionKey = sessionKey ?? self.chatSessionKey
        guard !self.talkMode.isUsingMainSessionKey(effectiveSessionKey) else { return }
        self.talkPttCommandEpoch &+= 1
        self.voiceWake.invalidatePendingCommand()
        self.talkMode.updateMainSessionKey(effectiveSessionKey)
    }

    var chatAgentId: String {
        if let sessionAgentId = SessionKey.agentId(from: chatSessionKey) {
            return sessionAgentId
        }
        return self.selectedOrDefaultAgentId
    }

    /// Verified routing owner for sends. Unlike `chatAgentId`, this has no
    /// display fallback: a cold offline start must wait for persisted or
    /// gateway-provided ownership before it can queue durable work.
    var chatDeliveryAgentId: String? {
        if let sessionAgentId = SessionKey.agentId(from: chatSessionKey) {
            return sessionAgentId.lowercased()
        }
        let selected = (self.selectedAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !selected.isEmpty { return selected.lowercased() }
        let defaultId = (self.gatewayDefaultAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return defaultId.isEmpty ? nil : defaultId.lowercased()
    }

    var chatSessionRoutingContract: String? {
        OpenClawChatSessionRoutingContract.make(
            scope: self.gatewaySessionScope,
            mainKey: self.mainSessionBaseKey,
            defaultAgentID: self.gatewayDefaultAgentId)
    }

    var chatAgentName: String {
        self.agentDisplayName(for: self.chatAgentId, fallback: "Main")
    }

    var chatAgentAvatarURL: String? {
        self.agentIdentityValue(for: self.chatAgentId, key: "avatarUrl")
    }

    var chatAgentAvatarText: String? {
        self.agentIdentityValue(for: self.chatAgentId, key: "emoji")
    }

    var activeAgentName: String {
        self.agentDisplayName(for: self.selectedOrDefaultAgentId, fallback: "Main")
    }

    private var selectedOrDefaultAgentId: String {
        let agentId = (selectedAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let defaultId = (gatewayDefaultAgentId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return agentId.isEmpty ? defaultId : agentId
    }

    private func agentDisplayName(for agentId: String, fallback: String) -> String {
        let resolvedId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        if resolvedId.isEmpty { return fallback }
        if let match = gatewayAgents.first(where: { $0.id == resolvedId }) {
            let name = (match.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? match.id : name
        }
        return resolvedId
    }

    private func agentIdentityValue(for agentId: String, key: String) -> String? {
        let resolvedId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !resolvedId.isEmpty,
              let match = gatewayAgents.first(where: { $0.id == resolvedId }),
              let rawValue = match.identity?[key]?.value as? String
        else {
            return nil
        }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func connectToGateway(
        url: URL,
        gatewayStableID: String,
        tls: GatewayTLSParams?,
        token: String?,
        bootstrapToken: String?,
        password: String?,
        connectOptions: GatewayConnectOptions,
        forceReconnect: Bool = false)
    {
        let stableID = gatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveStableID = stableID.isEmpty ? url.absoluteString : stableID
        let sessionBox = tls.map { WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0)) }
        let nextConfig = GatewayConnectConfig(
            url: url,
            stableID: stableID,
            tls: tls,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            nodeOptions: connectOptions)
        let previousGatewayStableID = self.activeGatewayConnectConfig?.effectiveStableID
            ?? self.connectedGatewayID
        let targetChanged = previousGatewayStableID.map {
            !$0.isEmpty && $0 != effectiveStableID
        } ?? false
        let hasForeignCachedApproval = self.watchExecApprovalPromptsByID.values.contains {
            $0.gatewayStableID != effectiveStableID
        }
        if hasForeignCachedApproval || targetChanged {
            // Approval IDs are gateway-local authorization handles. A target switch must remove
            // every cached surface so stale prompts cannot authorize work on the replacement.
            invalidateExecApprovalSurfacesForGatewayChange()
        }
        let operatorLoopRequired = shouldStartOperatorGatewayLoop(
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            deviceAuthGatewayID: connectOptions.deviceAuthGatewayID ?? effectiveStableID,
            allowStoredDeviceAuth: connectOptions.allowStoredDeviceAuth)
        if let activeConfig = activeGatewayConnectConfig,
           activeConfig.hasSameConnectionInputs(as: nextConfig),
           nodeGatewayTask != nil,
           operatorGatewayTask != nil || !operatorLoopRequired,
           !forceReconnect
        {
            self.gatewayAutoReconnectEnabled = true
            return
        }

        self.gatewayRouteGeneration &+= 1
        self.activeGatewayConnectConfig = nextConfig
        prepareForGatewayConnect(stableID: effectiveStableID)
        if operatorLoopRequired {
            startOperatorGatewayLoop(
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
        startNodeGatewayLoop(
            url: url,
            stableID: effectiveStableID,
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            nodeOptions: connectOptions,
            sessionBox: sessionBox)
    }

    /// Preferred entry-point: apply a single config object and start both sessions.
    func applyGatewayConnectConfig(
        _ cfg: GatewayConnectConfig,
        forceReconnect: Bool = false)
    {
        let generation = self.beginGatewayConnectAttempt()
        self.applyGatewayConnectConfig(
            cfg,
            forceReconnect: forceReconnect,
            expectedGeneration: generation)
    }

    /// Applies queued work only while its originating gateway attempt is still current.
    func applyGatewayConnectConfig(
        _ cfg: GatewayConnectConfig,
        forceReconnect: Bool = false,
        expectedGeneration: UInt64)
    {
        guard expectedGeneration == self.gatewayConnectGeneration else { return }
        self.isAppleReviewDemoModeEnabled = false
        self.isScreenshotFixtureModeEnabled = false
        self.connectToGateway(
            url: cfg.url,
            // Preserve the caller-provided stableID (may be empty) and let connectToGateway
            // derive the effective stable id consistently for persistence keys.
            gatewayStableID: cfg.stableID,
            tls: cfg.tls,
            token: cfg.token,
            bootstrapToken: cfg.bootstrapToken,
            password: cfg.password,
            connectOptions: cfg.nodeOptions,
            forceReconnect: forceReconnect)
    }

    func beginGatewayConnectAttempt() -> UInt64 {
        self.gatewayConnectGeneration &+= 1
        return self.gatewayConnectGeneration
    }

    private func invalidateGatewayConnectAttempts() {
        self.gatewayConnectGeneration &+= 1
    }

    var hasGatewaySessionResetInFlight: Bool {
        self.gatewaySessionResetTask != nil
    }

    func waitForGatewaySessionResetIfNeeded() async {
        while let gatewaySessionResetTask {
            await gatewaySessionResetTask.value
        }
    }

    @discardableResult
    private func beginGatewaySessionReset(chainingAfterExisting: Bool = false) -> Task<Void, Never> {
        let previousResetTask = self.gatewaySessionResetTask
        if let previousResetTask, !chainingAfterExisting {
            return previousResetTask
        }
        let nodeGatewayTask = self.nodeGatewayTask
        let operatorGatewayTask = self.operatorGatewayTask
        self.talkMode.updateGatewayConnected(false)
        self.voiceWake.invalidatePendingCommand()
        self.gatewayRouteGeneration &+= 1
        nodeGatewayTask?.cancel()
        self.nodeGatewayTask = nil
        operatorGatewayTask?.cancel()
        self.operatorGatewayTask = nil
        let operatorGateway = self.operatorGateway
        let nodeGateway = self.nodeGateway
        self.gatewaySessionResetGeneration &+= 1
        let resetGeneration = self.gatewaySessionResetGeneration
        // Disconnect first so canceled receive loops can unwind, then keep the barrier until their
        // cleanup exits. A stale loop may otherwise disconnect a replacement session after reset.
        let gatewaySessionResetTask = Task {
            await previousResetTask?.value
            await operatorGateway.disconnect()
            await nodeGateway.disconnect()
            await operatorGatewayTask?.value
            await nodeGatewayTask?.value
            if self.gatewaySessionResetGeneration == resetGeneration {
                self.gatewaySessionResetTask = nil
            }
        }
        self.gatewaySessionResetTask = gatewaySessionResetTask
        return gatewaySessionResetTask
    }

    func resetGatewaySessionsForForcedReconnect() async {
        await self.beginGatewaySessionReset().value
    }

    func resetGatewaySessionsForTargetSwitch() async {
        // A target awaiting TLS trust must not retain a reconnect route to the previous gateway.
        invalidateExecApprovalSurfacesForGatewayChange()
        self.invalidateGatewayConnectAttempts()
        self.chatSessionRoutingRestoreTask?.cancel()
        self.chatSessionRoutingRestoreTask = nil
        self.disableGatewayAutoReconnect()
        self.activeGatewayConnectConfig = nil
        ShareGatewayRelaySettings.clearConfig()
        await self.resetGatewaySessionsForForcedReconnect()
        guard !self.gatewayAutoReconnectEnabled, self.activeGatewayConnectConfig == nil else { return }
        // A canceled loop may have persisted its reconnect flag and relay config while teardown was in flight.
        self.disableGatewayAutoReconnect()
        ShareGatewayRelaySettings.clearConfig()
        self.gatewayHealthMonitor.stop()
        self.gatewayStatusText = "Offline"
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.connectedGatewayID = nil
        self.gatewayConnected = false
        setOperatorConnected(false)
        self.talkMode.updateGatewayConnected(false)
    }

    private func restartGatewaySessionsAfterForegroundStaleConnection() async {
        guard self.gatewayAutoReconnectEnabled, let cfg = activeGatewayConnectConfig else { return }
        let generation = self.gatewayConnectGeneration
        await self.resetGatewaySessionsForForcedReconnect()
        guard generation == self.gatewayConnectGeneration,
              self.gatewayAutoReconnectEnabled,
              self.activeGatewayConnectConfig?.hasSameConnectionInputs(as: cfg) == true,
              self.nodeGatewayTask == nil,
              self.operatorGatewayTask == nil
        else { return }
        guard !self.isLocalGatewayFixtureEnabled else { return }
        setOperatorConnected(false)
        self.gatewayConnected = false
        self.gatewayStatusText = "Reconnecting…"
        self.talkMode.updateGatewayConnected(false)
        self.applyGatewayConnectConfig(
            cfg,
            forceReconnect: true,
            expectedGeneration: generation)
    }

    func disconnectGateway() {
        self.disconnectGateway(disablePersistedAutoConnect: true, invalidateConnectAttempts: true)
    }

    func suspendGatewayForTargetReview() {
        // Target review pauses live reconnects without changing the user's launch preference.
        self.disconnectGateway(disablePersistedAutoConnect: false, invalidateConnectAttempts: true)
    }

    /// A replacement target may already own the connect generation while the forgotten route is live.
    /// Preserve that generation so teardown cannot strand the replacement offline.
    func disconnectForgottenGateway(preservingPendingConnectAttempt: Bool) {
        self.disconnectGateway(
            disablePersistedAutoConnect: !preservingPendingConnectAttempt,
            invalidateConnectAttempts: !preservingPendingConnectAttempt)
    }

    private func disconnectGateway(
        disablePersistedAutoConnect: Bool,
        invalidateConnectAttempts: Bool)
    {
        invalidateExecApprovalSurfacesForGatewayChange()
        if invalidateConnectAttempts {
            self.invalidateGatewayConnectAttempts()
        }
        self.isAppleReviewDemoModeEnabled = false
        self.isScreenshotFixtureModeEnabled = false
        if disablePersistedAutoConnect {
            self.disableGatewayAutoReconnect()
        } else {
            self.gatewayAutoReconnectEnabled = false
        }
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        self.lastGatewayProblem = nil
        self.operatorGatewayProblem = nil
        // Publish teardown through the shared barrier before returning. A replacement connect
        // must await old loop cleanup instead of racing this synchronous UI action.
        _ = self.beginGatewaySessionReset(chainingAfterExisting: true)
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        LiveActivityManager.shared.endActivity(reason: "manual_disconnect")
        self.gatewayHealthMonitor.stop()
        self.gatewayStatusText = "Offline"
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.connectedGatewayID = nil
        self.activeGatewayConnectConfig = nil
        self.gatewayConnected = false
        setOperatorConnected(false)
        self.talkMode.updateGatewayConnected(false)
        self.invalidateNodePushToTalkRoute()
        self.chatSessionRoutingRestoreTask?.cancel()
        self.chatSessionRoutingRestoreTask = nil
        self.synchronizeTalkSessionKey()
        ShareGatewayRelaySettings.clearConfig()
        showLocalCanvasOnDisconnect()
    }

    private func disableGatewayAutoReconnect() {
        // Runtime teardown and persisted startup routing must move together. Otherwise a relaunch
        // during target review silently reconnects the gateway the user just left.
        self.gatewayAutoReconnectEnabled = false
        UserDefaults.standard.set(false, forKey: "gateway.autoconnect")
    }
}

extension NodeAppModel {
    func resumeGatewayAfterTargetReview(_ config: GatewayConnectConfig) {
        let generation = self.beginGatewayConnectAttempt()
        self.gatewayStatusText = "Connecting…"
        // Reapply the exact suspended route only after teardown; a newer target invalidates the generation.
        Task { [weak self] in
            guard let self else { return }
            await self.waitForGatewaySessionResetIfNeeded()
            guard generation == self.gatewayConnectGeneration else { return }
            self.applyGatewayConnectConfig(config, expectedGeneration: generation)
        }
    }

    private func prepareForGatewayConnect(stableID: String) {
        self.invalidateNodePushToTalkRoute()
        self.operatorTalkConnectionGeneration &+= 1
        self.chatSessionRoutingRestoreTask?.cancel()
        self.isAppleReviewDemoModeEnabled = false
        self.isScreenshotFixtureModeEnabled = false
        self.gatewayAutoReconnectEnabled = true
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        self.lastGatewayProblem = nil
        self.operatorGatewayProblem = nil
        self.credentialHandoffFailureGeneration = nil
        self.nodeGatewayTask?.cancel()
        self.operatorGatewayTask?.cancel()
        self.gatewayHealthMonitor.stop()
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.connectedGatewayID = stableID
        self.gatewayConnected = false
        self.setOperatorConnected(false)
        self.talkMode.updateGatewayConnected(false)
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        LiveActivityManager.shared.endActivity(reason: "new_gateway_connect")
        self.mainSessionBaseKey = "main"
        self.gatewaySessionScope = nil
        self.gatewayDefaultAgentId = nil
        self.gatewayAgents = []
        self.selectedAgentId = GatewaySettingsStore.loadGatewaySelectedAgentId(stableID: stableID)
        self.focusedChatSessionKey = nil
        self.synchronizeTalkSessionKey()
        self.homeCanvasRevision &+= 1
        self.apnsLastRegisteredTokenHex = nil
        self.apnsLastRegisteredGatewayStableID = nil
        self.chatSessionRoutingRestoreTask = Task { [weak self] in
            guard !Task.isCancelled, self?.connectedGatewayID == stableID else { return }
            await self?.restoreChatSessionRoutingIdentityIfNeeded()
        }
    }

    private func clearGatewayConnectionProblem() {
        if let operatorGatewayProblem {
            self.lastGatewayProblem = operatorGatewayProblem
            if operatorGatewayProblem.needsPairingApproval {
                self.gatewayPairingPaused = true
                self.gatewayPairingRequestId = operatorGatewayProblem.requestId
            } else {
                self.gatewayPairingPaused = false
                self.gatewayPairingRequestId = nil
            }
            return
        }
        self.lastGatewayProblem = nil
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
    }

    func beginGatewayPreconnectVerification(statusText: String) {
        self.lastGatewayProblem = nil
        self.operatorGatewayProblem = nil
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        self.gatewayStatusText = statusText
    }

    private func applyGatewayConnectionProblem(_ problem: GatewayConnectionProblem) {
        guard !self.isLocalGatewayFixtureEnabled else { return }
        self.lastGatewayProblem = problem
        self.gatewayStatusText = problem.statusText
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.gatewayConnected = false
        showLocalCanvasOnDisconnect()
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
        if problem.needsPairingApproval || problem.pauseReconnect {
            LiveActivityManager.shared.showAttention(
                statusText: problem.needsPairingApproval ? "Approval needed" : "Action required",
                agentName: self.activeAgentName,
                sessionKey: self.mainSessionKey)
        }
    }

    private func applyOperatorGatewayConnectionProblem(_ problem: GatewayConnectionProblem) {
        guard !self.isLocalGatewayFixtureEnabled else { return }
        self.operatorGatewayProblem = problem
        self.lastGatewayProblem = problem
        self.gatewayStatusText = problem.statusText
        if problem.needsPairingApproval {
            self.gatewayPairingPaused = true
            self.gatewayPairingRequestId = problem.requestId
        }
        if problem.needsPairingApproval || problem.pauseReconnect {
            LiveActivityManager.shared.showAttention(
                statusText: problem.needsPairingApproval ? "Approval needed" : "Action required",
                agentName: self.activeAgentName,
                sessionKey: self.mainSessionKey)
        }
    }

    private func clearOperatorGatewayConnectionProblemIfCurrent() {
        guard let operatorGatewayProblem else { return }
        self.operatorGatewayProblem = nil
        guard self.lastGatewayProblem == operatorGatewayProblem else { return }
        self.lastGatewayProblem = nil
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        if self.gatewayServerName != nil {
            self.gatewayStatusText = "Connected"
        }
        if self.gatewayConnected {
            LiveActivityManager.shared.handleReconnect()
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
        deviceAuthGatewayID: String,
        allowStoredDeviceAuth: Bool = true) -> Bool
    {
        Self.shouldStartOperatorGatewayLoop(
            token: token,
            bootstrapToken: bootstrapToken,
            password: password,
            hasStoredOperatorToken: allowStoredDeviceAuth && self.hasStoredGatewayRoleToken(
                "operator",
                gatewayID: deviceAuthGatewayID))
    }

    private func hasStoredGatewayRoleToken(_ role: String, gatewayID: String) -> Bool {
        let identity = DeviceIdentityStore.loadOrCreate()
        return DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: role,
            gatewayID: gatewayID) != nil
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

    private func currentGatewayReconnectAuth(
        fallbackToken: String?,
        fallbackBootstrapToken: String?,
        fallbackPassword: String?) -> (token: String?, bootstrapToken: String?, password: String?)
    {
        if let cfg = activeGatewayConnectConfig {
            return (cfg.token, cfg.bootstrapToken, cfg.password)
        }
        return (fallbackToken, fallbackBootstrapToken, fallbackPassword)
    }

    private func currentGatewayReconnectOptions(
        stableID: String,
        fallback: GatewayConnectOptions) -> GatewayConnectOptions
    {
        guard let config = activeGatewayConnectConfig,
              config.effectiveStableID == stableID
        else { return fallback }
        return config.nodeOptions
    }

    private nonisolated static func usesBootstrapCredential(
        token: String?,
        bootstrapToken: String?,
        password: String?) -> Bool
    {
        token?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false &&
            password?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false &&
            bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    private func completeSuccessfulGatewayAuthHandoff(
        stableID: String,
        routeGeneration: UInt64,
        issuedRoles: Set<String>,
        nodeOptions: GatewayConnectOptions) -> GatewayConnectOptions?
    {
        guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return nil }

        // Bootstrap authentication is single-use. Do not keep a consumed bootstrap
        // route alive unless both replacement sessions can authenticate from secure storage.
        guard issuedRoles.isSuperset(of: ["node", "operator"]) else {
            return nodeOptions.allowStoredDeviceAuth ? nodeOptions : nil
        }
        guard let config = activeGatewayConnectConfig,
              config.effectiveStableID == stableID
        else { return nil }
        let instanceID = GatewaySettingsStore.currentInstanceID()
        let deviceAuthGatewayID = nodeOptions.deviceAuthGatewayID ?? stableID
        if let metadata = GatewaySettingsStore.loadGatewayCredentialMetadata(
            instanceId: instanceID,
            gatewayStableID: deviceAuthGatewayID),
            metadata.suppressStoredDeviceAuth,
            !GatewaySettingsStore.completeGatewayCredentialHandoff(
                instanceId: instanceID,
                gatewayStableID: deviceAuthGatewayID)
        {
            return nil
        }
        var reconnectOptions = nodeOptions
        reconnectOptions.allowStoredDeviceAuth = true
        self.activeGatewayConnectConfig = GatewayConnectConfig(
            url: config.url,
            stableID: config.stableID,
            tls: config.tls,
            token: config.token,
            bootstrapToken: nil,
            password: config.password,
            nodeOptions: reconnectOptions)

        if self.operatorGatewayTask == nil,
           self.shouldStartOperatorGatewayLoop(
               token: config.token,
               bootstrapToken: nil,
               password: config.password,
               deviceAuthGatewayID: deviceAuthGatewayID,
               allowStoredDeviceAuth: true)
        {
            let sessionBox = config.tls.map {
                WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0))
            }
            self.startOperatorGatewayLoop(
                url: config.url,
                stableID: stableID,
                token: config.token,
                bootstrapToken: nil,
                password: config.password,
                nodeOptions: reconnectOptions,
                sessionBox: sessionBox)
        }
        return reconnectOptions
    }

    private func gatewayOptionsAfterSuccessfulConnection(
        _ nodeOptions: GatewayConnectOptions,
        stableID: String,
        routeGeneration: UInt64,
        auth: (token: String?, bootstrapToken: String?, password: String?)) async -> GatewayConnectOptions?
    {
        guard !nodeOptions.allowStoredDeviceAuth else { return nodeOptions }
        guard Self.usesBootstrapCredential(
            token: auth.token,
            bootstrapToken: auth.bootstrapToken,
            password: auth.password)
        else {
            return nodeOptions
        }
        let issuedRoles = await nodeGateway.currentIssuedDeviceAuthRoles()
        guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return nil }
        guard let reconnectOptions = completeSuccessfulGatewayAuthHandoff(
            stableID: stableID,
            routeGeneration: routeGeneration,
            issuedRoles: issuedRoles,
            nodeOptions: nodeOptions)
        else {
            await self.handleGatewayCredentialHandoffPersistenceFailure(
                stableID: stableID,
                routeGeneration: routeGeneration)
            return nil
        }
        return reconnectOptions
    }

    private func handleGatewayCredentialHandoffPersistenceFailure(
        stableID: String,
        routeGeneration: UInt64) async
    {
        guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return }
        guard self.credentialHandoffFailureGeneration != routeGeneration else { return }
        self.credentialHandoffFailureGeneration = routeGeneration
        self.disableGatewayAutoReconnect()
        self.nodeGatewayTask?.cancel()
        self.nodeGatewayTask = nil
        self.operatorGatewayTask?.cancel()
        self.operatorGatewayTask = nil
        await self.nodeGateway.disconnect()
        await self.operatorGateway.disconnect()
        guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return }
        self.applyGatewayConnectionProblem(GatewayConnectionProblem(
            kind: .unknown,
            owner: .iphone,
            title: "Credential save failed",
            message: "OpenClaw disconnected because it could not securely save the new gateway credential.",
            retryable: true,
            pauseReconnect: true,
            technicalDetails: "Gateway credential handoff persistence failed."))
    }

    private func refreshBackgroundReconnectSuppressionIfNeeded(source: String) {
        guard self.isBackgrounded else { return }
        guard !self.backgroundReconnectSuppressed else { return }
        guard let leaseUntil = backgroundReconnectLeaseUntil else {
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

    private func gatewayReconnectLoopDelay(source: String) -> UInt64? {
        if !self.gatewayAutoReconnectEnabled || self.gatewayPairingPaused {
            return 1_000_000_000
        }
        return self.shouldPauseReconnectLoopInBackground(source: source)
            ? 2_000_000_000
            : nil
    }

    private func isCurrentGatewayRoute(generation: UInt64, stableID: String) -> Bool {
        generation == self.gatewayRouteGeneration &&
            self.activeGatewayConnectConfig?.effectiveStableID == stableID
    }

    private func gatewayRouteCheck(
        generation: UInt64,
        stableID: String) -> @MainActor @Sendable () -> Bool
    {
        { [weak self] in
            self?.isCurrentGatewayRoute(generation: generation, stableID: stableID) == true
        }
    }

    private func handleOperatorGatewayConnected(
        url: URL,
        stableID: String,
        routeGeneration: UInt64) async
    {
        guard !self.isLocalGatewayFixtureEnabled,
              self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID)
        else { return }
        self.operatorTalkConnectionGeneration &+= 1
        let talkConnectionGeneration = self.operatorTalkConnectionGeneration
        self.setOperatorConnected(true)
        self.clearOperatorGatewayConnectionProblemIfCurrent()
        self.forceOperatorTalkPermissionUpgradeRequest = false
        GatewayDiagnostics.log(
            "operator gateway connected host=\(url.host ?? "?") scheme=\(url.scheme ?? "?")")

        let shouldContinue: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            return self.operatorTalkConnectionGeneration == talkConnectionGeneration &&
                self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID)
        }
        await flushPendingWatchExecApprovalResolutions(shouldContinue: shouldContinue)
        guard shouldContinue() else { return }
        if let chatSessionRoutingRestoreTask {
            await chatSessionRoutingRestoreTask.value
        }
        guard shouldContinue() else { return }
        self.chatSessionRoutingRestoreTask = nil
        await self.refreshBrandingFromGateway(shouldApply: shouldContinue)
        guard shouldContinue() else { return }
        await self.refreshAgentsFromGateway(shouldApply: shouldContinue)
        guard shouldContinue() else { return }
        await self.talkMode.reloadConfig(shouldApply: shouldContinue)
        guard shouldContinue() else { return }
        self.admitTalkAfterSessionHydration()
        await self.talkMode.prefetchRealtimeSessionIfReady(
            reason: "operator_connected",
            shouldApply: shouldContinue)
        guard shouldContinue() else { return }
        await refreshShareRouteFromGateway(shouldApply: shouldContinue)
        guard shouldContinue() else { return }
        await registerAPNsTokenIfNeeded(shouldContinue: shouldContinue)
        guard shouldContinue() else { return }
        await self.startVoiceWakeSync(shouldContinue: shouldContinue)
        guard shouldContinue() else { return }
        self.startGatewayHealthMonitor()
    }

    private func admitTalkAfterSessionHydration() {
        self.synchronizeTalkSessionKey()
        self.talkMode.updateGatewayConnected(true)
    }

    private func handleNodeGatewayConnected(
        url: URL,
        stableID: String,
        routeGeneration: UInt64,
        nodeOptions: GatewayConnectOptions,
        auth: (token: String?, bootstrapToken: String?, password: String?)) async
    {
        guard !self.isLocalGatewayFixtureEnabled,
              self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID)
        else { return }
        let usedBootstrapToken = Self.usesBootstrapCredential(
            token: auth.token,
            bootstrapToken: auth.bootstrapToken,
            password: auth.password)
        if usedBootstrapToken {
            let issuedRoles = await nodeGateway.currentIssuedDeviceAuthRoles()
            guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return }
            guard self.completeSuccessfulGatewayAuthHandoff(
                stableID: stableID,
                routeGeneration: routeGeneration,
                issuedRoles: issuedRoles,
                nodeOptions: nodeOptions) != nil
            else {
                await self.handleGatewayCredentialHandoffPersistenceFailure(
                    stableID: stableID,
                    routeGeneration: routeGeneration)
                return
            }
        }

        self.clearGatewayConnectionProblem()
        self.gatewayStatusText = "Connected"
        self.gatewayServerName = url.host ?? "gateway"
        self.gatewayConnected = true
        _ = GatewaySettingsStore.markGatewayConnected(
            stableID: stableID,
            atMs: Int(Date().timeIntervalSince1970 * 1000))
        self.screen.errorText = nil
        UserDefaults.standard.set(true, forKey: "gateway.autoconnect")
        LiveActivityManager.shared.handleReconnect()
        guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return }
        ShareGatewayRelaySettings.saveConfig(ShareGatewayRelayConfig(
            gatewayURLString: url.absoluteString,
            gatewayStableID: nodeOptions.deviceAuthGatewayID,
            token: auth.token,
            password: auth.password,
            sessionKey: self.mainSessionKey,
            deliveryChannel: self.shareDeliveryChannel,
            deliveryTo: self.shareDeliveryTo))
        GatewayDiagnostics.log(
            "gateway connected host=\(url.host ?? "?") scheme=\(url.scheme ?? "?")")

        if let address = await nodeGateway.currentRemoteAddress() {
            guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return }
            self.gatewayRemoteAddress = address
        }
        guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return }
        await showA2UIOnConnectIfNeeded()
        guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return }
        let shouldContinue = self.gatewayRouteCheck(
            generation: routeGeneration,
            stableID: stableID)
        await onNodeGatewayConnected(shouldContinue: shouldContinue)
        guard shouldContinue() else { return }
        SignificantLocationMonitor.startIfNeeded(
            locationService: self.locationService,
            locationMode: self.locationMode(),
            gateway: self.nodeGateway,
            beforeSend: { [weak self] in
                await self?.handleSignificantLocationWakeIfNeeded()
            })
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
        let routeGeneration = self.gatewayRouteGeneration
        // Async reconnect helpers can resume after Disconnect or a target switch. Only the
        // current route may install a new loop after those suspension points.
        guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return }
        // Operator session reconnects independently (chat/talk/config/voicewake), but we tie its
        // lifecycle to the current gateway config so it doesn't keep running across Disconnect.
        self.operatorGatewayTask = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            while !Task.isCancelled,
                  self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID)
            {
                if let delay = self.gatewayReconnectLoopDelay(source: "operator_loop") {
                    try? await Task.sleep(nanoseconds: delay)
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
                // Bootstrap handoff enables stored auth in the active config. Reconnects must
                // consume that current ownership state instead of the loop's one-shot bootstrap options.
                let reconnectOptions = self.currentGatewayReconnectOptions(
                    stableID: stableID,
                    fallback: nodeOptions)
                let effectiveClientId =
                    GatewaySettingsStore.loadGatewayClientIdOverride(stableID: stableID) ?? reconnectOptions.clientId
                let talkPermissionUpgradeRequest = self.forceOperatorTalkPermissionUpgradeRequest
                let deviceAuthGatewayID = reconnectOptions.deviceAuthGatewayID ?? stableID
                let operatorOptions = self.makeOperatorConnectOptions(
                    clientId: effectiveClientId,
                    displayName: reconnectOptions.clientDisplayName,
                    deviceAuthGatewayID: deviceAuthGatewayID,
                    includeAdminScope: self.shouldRequestOperatorAdminScope(
                        gatewayID: deviceAuthGatewayID,
                        token: reconnectAuth.token,
                        password: reconnectAuth.password,
                        forceTalkPermissionUpgradeRequest: talkPermissionUpgradeRequest),
                    includeApprovalScope: self.shouldRequestOperatorApprovalScope(
                        gatewayID: deviceAuthGatewayID,
                        token: reconnectAuth.token,
                        password: reconnectAuth.password,
                        forceTalkPermissionUpgradeRequest: talkPermissionUpgradeRequest),
                    forceExplicitScopes: talkPermissionUpgradeRequest,
                    allowStoredDeviceAuth: reconnectOptions.allowStoredDeviceAuth)

                do {
                    try await self.operatorGateway.connect(
                        url: url,
                        credentials: GatewayNodeSessionCredentials(
                            token: reconnectAuth.token,
                            bootstrapToken: reconnectAuth.bootstrapToken,
                            password: reconnectAuth.password),
                        connectOptions: operatorOptions,
                        sessionBox: sessionBox,
                        extraHeadersProvider: {
                            GatewaySettingsStore.loadGatewayCustomHeaders(gatewayStableID: stableID)
                        },
                        onConnected: { [weak self] in
                            await self?.handleOperatorGatewayConnected(
                                url: url,
                                stableID: stableID,
                                routeGeneration: routeGeneration)
                        },
                        onDisconnected: { [weak self] reason in
                            guard let self else { return }
                            await MainActor.run {
                                guard !self.isLocalGatewayFixtureEnabled,
                                      self.isCurrentGatewayRoute(
                                          generation: routeGeneration,
                                          stableID: stableID)
                                else { return }
                                self.setOperatorConnected(false)
                                self.talkMode.updateGatewayConnected(false)
                                LiveActivityManager.shared.endActivity(reason: "operator_disconnected")
                            }
                            GatewayDiagnostics.log("operator gateway disconnected reason=\(reason)")
                            await MainActor.run {
                                guard self.isCurrentGatewayRoute(
                                    generation: routeGeneration,
                                    stableID: stableID)
                                else { return }
                                self.stopGatewayHealthMonitor()
                            }
                        },
                        onInvoke: { req in
                            // Operator session should not handle node.invoke requests.
                            BridgeInvokeResponse(
                                id: req.id,
                                ok: false,
                                error: OpenClawNodeError(
                                    code: .invalidRequest,
                                    message: "INVALID_REQUEST: operator session cannot invoke node commands"))
                        },
                        onRouteInvalidated: { [weak self] in
                            await MainActor.run {
                                self?.handleOperatorGatewayRouteInvalidated(
                                    routeGeneration: routeGeneration,
                                    stableID: stableID)
                            }
                        })

                    attempt = 0
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                } catch {
                    guard self.isCurrentGatewayRoute(
                        generation: routeGeneration,
                        stableID: stableID) else { break }
                    attempt += 1
                    GatewayDiagnostics.log("operator gateway connect error: \(error.localizedDescription)")
                    let problem: GatewayConnectionProblem? = await MainActor.run {
                        let nextProblem = GatewayConnectionProblemMapper.map(error: error)
                        guard !self.isLocalGatewayFixtureEnabled,
                              self.isCurrentGatewayRoute(
                                  generation: routeGeneration,
                                  stableID: stableID)
                        else { return nil }
                        if let nextProblem {
                            if nextProblem.needsPairingApproval || nextProblem.pauseReconnect {
                                self.applyOperatorGatewayConnectionProblem(nextProblem)
                            }
                            if talkPermissionUpgradeRequest, nextProblem.kind == .pairingScopeUpgradeRequired {
                                self.talkMode.markTalkPermissionUpgradeRequested(requestId: nextProblem.requestId)
                            }
                        }
                        return nextProblem
                    }
                    if problem?.needsPairingApproval == true {
                        self.operatorGatewayTask?.cancel()
                        self.operatorGatewayTask = nil
                        await self.operatorGateway.disconnect()
                        break
                    }
                    if problem?.pauseReconnect == true {
                        self.operatorGatewayTask?.cancel()
                        self.operatorGatewayTask = nil
                        await self.operatorGateway.disconnect()
                        break
                    }
                    let sleepSeconds = min(8.0, 0.5 * pow(1.7, Double(attempt)))
                    try? await Task.sleep(nanoseconds: UInt64(sleepSeconds * 1_000_000_000))
                }
            }
        }
    }

    private func handleOperatorGatewayRouteInvalidated(routeGeneration: UInt64, stableID: String) {
        guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return }
        self.invalidateOperatorTalkRoute()
    }

    private func invalidateOperatorTalkRoute() {
        self.operatorTalkConnectionGeneration &+= 1
        // A socket replacement invalidates Talk, not gateway identity hydration. The
        // replacement connection must await the same restore before admitting capture.
        self.setOperatorConnected(false)
        self.talkMode.updateGatewayConnected(false)
        self.invalidateNodePushToTalkRoute()
    }

    private func handleNodeGatewayRouteInvalidated(routeGeneration: UInt64, stableID: String) {
        guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return }
        self.invalidateNodePushToTalkRoute()
    }

    private func invalidateNodePushToTalkRoute() {
        self.talkPttCommandEpoch &+= 1
        self.voiceWake.invalidatePendingCommand()
        _ = self.talkMode.cancelPushToTalk()
    }

    private func startNodeGatewayLoop(
        url: URL,
        stableID: String,
        token: String?,
        bootstrapToken: String?,
        password: String?,
        nodeOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?)
    {
        let routeGeneration = self.gatewayRouteGeneration
        guard self.isCurrentGatewayRoute(generation: routeGeneration, stableID: stableID) else { return }
        let context = NodeGatewayLoopContext(
            url: url,
            stableID: stableID,
            routeGeneration: routeGeneration,
            fallbackToken: token,
            fallbackBootstrapToken: bootstrapToken,
            fallbackPassword: password,
            initialOptions: nodeOptions,
            sessionBox: sessionBox)
        self.nodeGatewayTask = Task { [weak self] in
            await self?.runNodeGatewayLoop(context)
        }
    }

    private func runNodeGatewayLoop(_ context: NodeGatewayLoopContext) async {
        var state = NodeGatewayLoopState(options: context.initialOptions)

        gatewayLoop: while !Task.isCancelled,
                           self.isCurrentGatewayRoute(
                               generation: context.routeGeneration,
                               stableID: context.stableID)
        {
            if await self.shouldDelayNodeGatewayConnectionAttempt() {
                continue
            }
            self.showNodeGatewayConnectingStatus(
                attempt: state.attempt,
                context: context)

            switch await self.performNodeGatewayConnectionAttempt(context: context, state: state) {
            case let .retry(nextState):
                state = nextState
            case .stop:
                break gatewayLoop
            case .stopPreservingStatus:
                // Pairing owns its status until explicit recovery.
                return
            }
        }

        self.resetNodeGatewayLoopStatusIfCurrent(context)
    }

    private func shouldDelayNodeGatewayConnectionAttempt() async -> Bool {
        if let delay = self.gatewayReconnectLoopDelay(source: "node_loop") {
            try? await Task.sleep(nanoseconds: delay)
            return true
        }
        if await self.isGatewayConnected() {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            return true
        }
        return false
    }

    private func showNodeGatewayConnectingStatus(
        attempt: Int,
        context: NodeGatewayLoopContext)
    {
        guard !self.isLocalGatewayFixtureEnabled,
              self.isCurrentGatewayRoute(
                  generation: context.routeGeneration,
                  stableID: context.stableID)
        else { return }
        self.gatewayStatusText = (attempt == 0) ? "Connecting…" : "Reconnecting…"
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        LiveActivityManager.shared.showConnecting(
            statusText: (attempt == 0) ? "Connecting..." : "Reconnecting...",
            agentName: self.activeAgentName,
            sessionKey: self.mainSessionKey)
    }

    private func performNodeGatewayConnectionAttempt(
        context: NodeGatewayLoopContext,
        state: NodeGatewayLoopState) async -> NodeGatewayLoopStep
    {
        let epochMs = Int(Date().timeIntervalSince1970 * 1000)
        let reconnectAuth = self.currentGatewayReconnectAuth(
            fallbackToken: context.fallbackToken,
            fallbackBootstrapToken: context.fallbackBootstrapToken,
            fallbackPassword: context.fallbackPassword)
        let connectedOptions = state.options
        GatewayDiagnostics.log("connect attempt epochMs=\(epochMs) url=\(context.url.absoluteString)")

        do {
            try await self.nodeGateway.connect(
                url: context.url,
                credentials: GatewayNodeSessionCredentials(
                    token: reconnectAuth.token,
                    bootstrapToken: reconnectAuth.bootstrapToken,
                    password: reconnectAuth.password),
                connectOptions: connectedOptions,
                sessionBox: context.sessionBox,
                extraHeadersProvider: {
                    GatewaySettingsStore.loadGatewayCustomHeaders(gatewayStableID: context.stableID)
                },
                onConnected: { [weak self] in
                    await self?.handleNodeGatewayConnected(
                        url: context.url,
                        stableID: context.stableID,
                        routeGeneration: context.routeGeneration,
                        nodeOptions: connectedOptions,
                        auth: reconnectAuth)
                },
                onDisconnected: { [weak self] reason in
                    guard let self else { return }
                    await MainActor.run {
                        guard !self.isLocalGatewayFixtureEnabled,
                              self.isCurrentGatewayRoute(
                                  generation: context.routeGeneration,
                                  stableID: context.stableID)
                        else { return }
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
                    return await self.handleInvoke(req, gatewayStableID: context.stableID)
                },
                onRouteInvalidated: { [weak self] in
                    await MainActor.run {
                        self?.handleNodeGatewayRouteInvalidated(
                            routeGeneration: context.routeGeneration,
                            stableID: context.stableID)
                    }
                })

            guard let reconnectOptions = await self.gatewayOptionsAfterSuccessfulConnection(
                connectedOptions,
                stableID: context.stableID,
                routeGeneration: context.routeGeneration,
                auth: reconnectAuth)
            else { return .stop }

            var nextState = state
            nextState.options = reconnectOptions
            nextState.attempt = 0
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            return .retry(nextState)
        } catch {
            return await self.handleNodeGatewayConnectionError(
                error,
                context: context,
                state: state)
        }
    }

    private func handleNodeGatewayConnectionError(
        _ error: Error,
        context: NodeGatewayLoopContext,
        state: NodeGatewayLoopState) async -> NodeGatewayLoopStep
    {
        guard !Task.isCancelled,
              self.isCurrentGatewayRoute(
                  generation: context.routeGeneration,
                  stableID: context.stableID)
        else { return .stop }

        if !state.didFallbackClientID,
           let fallbackClientID = self.legacyClientIdFallback(
               currentClientId: state.options.clientId,
               error: error)
        {
            var nextState = state
            nextState.didFallbackClientID = true
            nextState.options.clientId = fallbackClientID
            GatewaySettingsStore.saveGatewayClientIdOverride(
                stableID: context.stableID,
                clientId: fallbackClientID)
            self.gatewayStatusText = "Gateway rejected client id. Retrying…"
            return .retry(nextState)
        }

        var nextState = state
        nextState.attempt += 1
        let problem = self.applyNodeGatewayConnectionError(
            error,
            context: context)
        GatewayDiagnostics.log("gateway connect error: \(error.localizedDescription)")

        if problem?.needsPairingApproval == true {
            // Stop both watchdogs so pairing keeps one stable request and remediation surface.
            self.operatorGatewayTask?.cancel()
            self.operatorGatewayTask = nil
            await self.operatorGateway.disconnect()
            await self.nodeGateway.disconnect()
            return .stopPreservingStatus
        }
        guard problem?.pauseReconnect != true else {
            return .retry(nextState)
        }

        let sleepSeconds = min(8.0, 0.5 * pow(1.7, Double(nextState.attempt)))
        try? await Task.sleep(nanoseconds: UInt64(sleepSeconds * 1_000_000_000))
        return .retry(nextState)
    }

    private func applyNodeGatewayConnectionError(
        _ error: Error,
        context: NodeGatewayLoopContext) -> GatewayConnectionProblem?
    {
        let nextProblem = GatewayConnectionProblemMapper.map(
            error: error,
            preserving: self.lastGatewayProblem)
        guard !self.isLocalGatewayFixtureEnabled,
              self.isCurrentGatewayRoute(
                  generation: context.routeGeneration,
                  stableID: context.stableID)
        else { return nil }
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

    private func resetNodeGatewayLoopStatusIfCurrent(_ context: NodeGatewayLoopContext) {
        guard self.credentialHandoffFailureGeneration != context.routeGeneration else { return }
        guard !self.isLocalGatewayFixtureEnabled,
              self.isCurrentGatewayRoute(
                  generation: context.routeGeneration,
                  stableID: context.stableID)
        else { return }
        self.lastGatewayProblem = nil
        self.gatewayStatusText = "Offline"
        LiveActivityManager.shared.endActivity(reason: "gateway_loop_stopped")
        self.gatewayServerName = nil
        self.gatewayRemoteAddress = nil
        self.connectedGatewayID = nil
        self.gatewayConnected = false
        self.setOperatorConnected(false)
        self.talkMode.updateGatewayConnected(false)
        // Retain the last verified routing contract for offline capture; reconnect compares it
        // with the live gateway before replay.
        self.synchronizeTalkSessionKey()
        self.showLocalCanvasOnDisconnect()
    }

    private func shouldRequestOperatorApprovalScope(
        gatewayID: String,
        token: String?,
        password: String?,
        forceTalkPermissionUpgradeRequest: Bool = false) -> Bool
    {
        let identity = DeviceIdentityStore.loadOrCreate()
        let storedOperatorScopes = DeviceAuthStore
            .loadToken(deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID)?
            .scopes ?? []
        return Self.shouldRequestOperatorApprovalScope(
            token: token,
            password: password,
            storedOperatorScopes: storedOperatorScopes,
            forceTalkPermissionUpgradeRequest: forceTalkPermissionUpgradeRequest)
    }

    fileprivate nonisolated static func shouldRequestOperatorApprovalScope(
        token: String?,
        password: String?,
        storedOperatorScopes: [String],
        forceTalkPermissionUpgradeRequest: Bool = false) -> Bool
    {
        if forceTalkPermissionUpgradeRequest {
            return storedOperatorScopes.contains("operator.approvals")
        }
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

    private func shouldRequestOperatorAdminScope(
        gatewayID: String,
        token: String?,
        password: String?,
        forceTalkPermissionUpgradeRequest: Bool = false) -> Bool
    {
        let identity = DeviceIdentityStore.loadOrCreate()
        let storedOperatorScopes = DeviceAuthStore
            .loadToken(deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID)?
            .scopes ?? []
        return Self.shouldRequestOperatorAdminScope(
            token: token,
            password: password,
            storedOperatorScopes: storedOperatorScopes,
            forceTalkPermissionUpgradeRequest: forceTalkPermissionUpgradeRequest)
    }

    fileprivate nonisolated static func shouldRequestOperatorAdminScope(
        token: String?,
        password: String?,
        storedOperatorScopes: [String],
        forceTalkPermissionUpgradeRequest: Bool = false) -> Bool
    {
        if forceTalkPermissionUpgradeRequest {
            return false
        }
        let trimmedToken = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedToken.isEmpty {
            return true
        }
        let trimmedPassword = password?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedPassword.isEmpty {
            return true
        }
        return storedOperatorScopes.contains("operator.admin")
    }

    private func makeOperatorConnectOptions(
        clientId: String,
        displayName: String?,
        deviceAuthGatewayID: String? = nil,
        includeAdminScope: Bool = false,
        includeApprovalScope: Bool,
        forceExplicitScopes: Bool = false,
        allowStoredDeviceAuth: Bool = true) -> GatewayConnectOptions
    {
        var scopes = ["operator.read", "operator.write", "operator.talk.secrets"]
        if includeAdminScope {
            scopes.append("operator.admin")
        }
        // Preserve reconnect compatibility for older paired operator tokens that were
        // approved before iOS requested operator.approvals by default.
        if includeApprovalScope {
            scopes.append("operator.approvals")
        }
        return GatewayConnectOptions(
            role: "operator",
            scopes: scopes,
            scopesAreExplicit: forceExplicitScopes,
            caps: [],
            commands: [],
            permissions: [:],
            clientId: clientId,
            clientMode: "ui",
            clientDisplayName: displayName,
            includeDeviceIdentity: true,
            allowStoredDeviceAuth: allowStoredDeviceAuth,
            deviceAuthGatewayID: deviceAuthGatewayID)
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

    private func setOperatorConnected(_ connected: Bool) {
        let changed = self.operatorConnected != connected
        self.operatorConnected = connected
        self.operatorStatusText = connected ? "Connected" : "Offline"
        self.refreshOperatorAdminScopeFromStore()
        guard connected else {
            guard changed else { return }
            Task { [weak self] in
                await self?.syncWatchAppSnapshot(reason: "operator_offline")
            }
            return
        }
        if changed {
            // Immediate retries are bounded per connection. A real reconnect grants queued
            // messages a fresh budget so one exhausted head cannot strand the durable outbox.
            self.watchMessageRetryAttempts.removeAll()
        }
        Task { [weak self] in
            await self?.flushPendingExecApprovalResolvedPushes()
            await self?.flushQueuedWatchMessagesIfAvailable()
            guard changed else { return }
            await self?.syncWatchAppSnapshot(reason: "operator_online")
        }
    }

    private func refreshOperatorAdminScopeFromStore() {
        guard let config = activeGatewayConnectConfig else {
            self.hasOperatorAdminScope = false
            return
        }
        let gatewayID = config.nodeOptions.deviceAuthGatewayID ?? config.effectiveStableID
        let identity = DeviceIdentityStore.loadOrCreate()
        self.hasOperatorAdminScope = DeviceAuthStore
            .loadToken(deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID)?
            .scopes
            .contains("operator.admin") == true
    }
}

extension NodeAppModel {
    func enterAppleReviewDemoMode() {
        self.invalidateGatewayConnectAttempts()
        self.isAppleReviewDemoModeEnabled = true
        self.isScreenshotFixtureModeEnabled = false
        self.gatewayAutoReconnectEnabled = false
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        self.lastGatewayProblem = nil
        self.operatorGatewayProblem = nil
        self.credentialHandoffFailureGeneration = nil
        self.nodeGatewayTask?.cancel()
        self.nodeGatewayTask = nil
        self.operatorGatewayTask?.cancel()
        self.operatorGatewayTask = nil
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        self.gatewayHealthMonitor.stop()
        LiveActivityManager.shared.endActivity(reason: "apple_review_demo")

        Task {
            await self.operatorGateway.disconnect()
            await self.nodeGateway.disconnect()
        }

        self.gatewayStatusText = "Connected"
        self.nodeStatusText = "Connected"
        self.gatewayServerName = AppleReviewDemoMode.gatewayName
        self.gatewayRemoteAddress = AppleReviewDemoMode.gatewayAddress
        self.connectedGatewayID = AppleReviewDemoMode.gatewayID
        self.activeGatewayConnectConfig = nil
        self.gatewayConnected = true
        self.setOperatorConnected(false)
        UserDefaults.standard.set(false, forKey: "talk.enabled")
        UserDefaults.standard.set(false, forKey: "talk.background.enabled")
        self.talkMode.updateGatewayConnected(false)
        self.talkMode.setEnabled(false)
        self.talkMode.statusText = "Demo mode only"
        self.mainSessionBaseKey = "main"
        self.gatewaySessionScope = "per-sender"
        self.selectedAgentId = nil
        self.gatewayDefaultAgentId = "main"
        self.gatewayAgents = AppleReviewDemoMode.agents
        self.focusedChatSessionKey = nil
        self.synchronizeTalkSessionKey()
        self.homeCanvasRevision &+= 1
    }

    func enterScreenshotFixtureMode() {
        self.invalidateGatewayConnectAttempts()
        self.isAppleReviewDemoModeEnabled = false
        self.isScreenshotFixtureModeEnabled = true
        self.gatewayAutoReconnectEnabled = false
        self.gatewayPairingPaused = false
        self.gatewayPairingRequestId = nil
        self.lastGatewayProblem = nil
        self.operatorGatewayProblem = nil
        self.nodeGatewayTask?.cancel()
        self.nodeGatewayTask = nil
        self.operatorGatewayTask?.cancel()
        self.operatorGatewayTask = nil
        self.voiceWakeSyncTask?.cancel()
        self.voiceWakeSyncTask = nil
        self.gatewayHealthMonitor.stop()
        LiveActivityManager.shared.endActivity(reason: "screenshot_fixture")

        Task {
            await self.operatorGateway.disconnect()
            await self.nodeGateway.disconnect()
        }

        self.gatewayStatusText = "Connected"
        self.nodeStatusText = "Connected"
        self.gatewayServerName = ScreenshotFixtureMode.gatewayName
        self.gatewayRemoteAddress = ScreenshotFixtureMode.gatewayAddress
        self.connectedGatewayID = ScreenshotFixtureMode.gatewayID
        self.activeGatewayConnectConfig = nil
        self.gatewayConnected = true
        self.setOperatorConnected(true)
        self.hasOperatorAdminScope = true
        self.mainSessionBaseKey = "main"
        self.gatewaySessionScope = "per-sender"
        self.selectedAgentId = nil
        self.gatewayDefaultAgentId = "main"
        self.gatewayAgents = ScreenshotFixtureMode.agents
        self.focusedChatSessionKey = nil
        self.synchronizeTalkSessionKey()
        self.talkMode.enterScreenshotFixtureMode()
        self.homeCanvasRevision &+= 1
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

    private func refreshShareRouteFromGateway(shouldApply: () -> Bool = { true }) async {
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
            let response = try await operatorGateway.request(
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

            guard shouldApply() else { return }
            await MainActor.run {
                self.shareDeliveryChannel = channel
                self.shareDeliveryTo = to
                if let relay = ShareGatewayRelaySettings.loadConfig() {
                    ShareGatewayRelaySettings.saveConfig(
                        ShareGatewayRelayConfig(
                            gatewayURLString: relay.gatewayURLString,
                            gatewayStableID: relay.gatewayStableID,
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

        await handleDeepLink(url: deepLink)
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

    /// Back-compat hook retained for older gateway-connect flows.
    func onNodeGatewayConnected(
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
    {
        guard shouldContinue() else { return }
        await self.registerAPNsTokenIfNeeded(shouldContinue: shouldContinue)
        guard shouldContinue() else { return }
        await self.syncWatchAppSnapshot(
            reason: "node_connected",
            includeChat: true,
            shouldContinue: shouldContinue)
        guard shouldContinue() else { return }
        await self.syncWatchExecApprovalSnapshot(
            reason: "node_connected",
            shouldContinue: shouldContinue)
        guard shouldContinue() else { return }
        await self.resumePendingForegroundNodeActionsIfNeeded(
            trigger: "node_connected",
            shouldContinue: shouldContinue)
    }

    private func resumePendingForegroundNodeActionsIfNeeded(
        trigger: String,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
    {
        guard shouldContinue() else { return }
        guard !self.isBackgrounded else { return }
        guard await isGatewayConnected() else { return }
        guard !self.pendingForegroundActionDrainInFlight else {
            self.pendingForegroundActionDrainRequested = true
            return
        }

        self.pendingForegroundActionDrainInFlight = true
        defer {
            self.pendingForegroundActionDrainInFlight = false
            if self.pendingForegroundActionDrainRequested {
                self.pendingForegroundActionDrainRequested = false
                // Serialize non-idempotent action execution, then retry against whichever
                // exact route is current after the suspended drain has unwound.
                Task { @MainActor [weak self] in
                    await self?.resumePendingForegroundNodeActionsIfNeeded(trigger: "coalesced")
                }
            }
        }

        let routeGeneration = self.gatewayRouteGeneration
        guard let gatewayStableID = self.connectedGatewayID,
              let nodeRoute = await self.nodeGateway.currentRoute(),
              shouldContinue(),
              self.isCurrentGatewayRoute(generation: routeGeneration, stableID: gatewayStableID)
        else { return }

        do {
            let routeContext = GatewaySessionRouteContext(
                route: nodeRoute,
                gatewayStableID: gatewayStableID,
                routeGeneration: routeGeneration)
            let payload = try await nodeGateway.request(
                method: "node.pending.pull",
                paramsJSON: "{}",
                timeoutSeconds: 6,
                ifCurrentRoute: nodeRoute)
            let decoded = try JSONDecoder().decode(
                PendingForegroundNodeActionsResponse.self,
                from: payload)
            guard await self.isCurrentGatewaySessionRoute(
                routeContext,
                session: self.nodeGateway,
                shouldContinue: shouldContinue)
            else { return }
            self.retainCompletedPendingForegroundActionIDs(
                presentIn: decoded.actions,
                gatewayStableID: gatewayStableID)
            guard !decoded.actions.isEmpty else { return }
            self.pendingActionLogger
                .info("pending actions trigger=\(trigger, privacy: .public)")
            self.pendingActionLogger.info("pending actions count=\(decoded.actions.count, privacy: .public)")
            await self.applyPendingForegroundNodeActions(
                decoded.actions,
                trigger: trigger,
                routeContext: routeContext,
                shouldContinue: shouldContinue)
        } catch {
            // Best-effort only.
        }
    }

    private func applyPendingForegroundNodeActions(
        _ actions: [PendingForegroundNodeAction],
        trigger: String,
        routeContext: GatewaySessionRouteContext? = nil,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
    {
        for action in actions {
            guard shouldContinue() else { return }
            if let routeContext {
                guard await self.isCurrentGatewaySessionRoute(
                    routeContext,
                    session: self.nodeGateway,
                    shouldContinue: shouldContinue)
                else { return }
            }
            guard !self.isBackgrounded else {
                self.pendingActionLogger.info(
                    "Pending action replay paused trigger=\(trigger, privacy: .public): app backgrounded")
                return
            }
            let req = BridgeInvokeRequest(
                id: action.id,
                command: action.command,
                paramsJSON: action.paramsJSON)
            let gatewayStableID = routeContext?.gatewayStableID
            let alreadyCompleted = gatewayStableID.map {
                self.completedPendingForegroundActionIDsByGateway[$0]?.contains(action.id) == true
            } ?? false
            if !alreadyCompleted {
                let result = await handleInvoke(
                    req,
                    gatewayStableID: gatewayStableID ?? self.connectedGatewayID)
                self.pendingActionLogger
                    .info("pending replay trigger=\(trigger, privacy: .public) id=\(action.id, privacy: .public)")
                self.pendingActionLogger.info("pending replay ok=\(result.ok, privacy: .public)")
                self.pendingActionLogger.info("pending replay command=\(action.command, privacy: .public)")
                guard result.ok else { return }
                if let gatewayStableID {
                    // The gateway queue is connection-independent. Remember successful local
                    // execution until its source gateway accepts the ACK so reconnects cannot replay it.
                    self.completedPendingForegroundActionIDsByGateway[gatewayStableID, default: []]
                        .insert(action.id)
                }
                guard shouldContinue() else { return }
            }
            let acked = await ackPendingForegroundNodeAction(
                id: action.id,
                trigger: trigger,
                command: action.command,
                routeContext: routeContext)
            guard acked else { return }
            if let gatewayStableID {
                self.removeCompletedPendingForegroundActionID(
                    action.id,
                    gatewayStableID: gatewayStableID)
            }
        }
    }

    private func retainCompletedPendingForegroundActionIDs(
        presentIn actions: [PendingForegroundNodeAction],
        gatewayStableID: String)
    {
        guard let completed = self.completedPendingForegroundActionIDsByGateway[gatewayStableID] else {
            return
        }
        let retained = completed.intersection(actions.map(\.id))
        if retained.isEmpty {
            self.completedPendingForegroundActionIDsByGateway.removeValue(forKey: gatewayStableID)
        } else {
            self.completedPendingForegroundActionIDsByGateway[gatewayStableID] = retained
        }
    }

    private func removeCompletedPendingForegroundActionID(
        _ id: String,
        gatewayStableID: String)
    {
        self.completedPendingForegroundActionIDsByGateway[gatewayStableID]?.remove(id)
        if self.completedPendingForegroundActionIDsByGateway[gatewayStableID]?.isEmpty == true {
            self.completedPendingForegroundActionIDsByGateway.removeValue(forKey: gatewayStableID)
        }
    }

    private func isCurrentGatewaySessionRoute(
        _ context: GatewaySessionRouteContext,
        session: GatewayNodeSession,
        shouldContinue: @MainActor @Sendable () -> Bool) async -> Bool
    {
        guard shouldContinue(),
              self.isCurrentGatewayRoute(
                  generation: context.routeGeneration,
                  stableID: context.gatewayStableID)
        else { return false }
        guard await session.currentRoute() == context.route else { return false }
        return shouldContinue() &&
            self.isCurrentGatewayRoute(
                generation: context.routeGeneration,
                stableID: context.gatewayStableID)
    }

    private func ackPendingForegroundNodeAction(
        id: String,
        trigger: String,
        command: String,
        routeContext: GatewaySessionRouteContext?) async -> Bool
    {
        do {
            let expectedRoute: GatewayNodeSessionRoute?
            if let routeContext {
                guard self.activeGatewayConnectConfig?.effectiveStableID == routeContext.gatewayStableID,
                      let currentRoute = await self.nodeGateway.currentRoute(),
                      self.activeGatewayConnectConfig?.effectiveStableID == routeContext.gatewayStableID
                else { return false }
                expectedRoute = currentRoute
            } else {
                expectedRoute = nil
            }
            let payload = try JSONEncoder().encode(PendingForegroundNodeActionsAckRequest(ids: [id]))
            let paramsJSON = String(bytes: payload, encoding: .utf8) ?? "{}"
            _ = try await self.nodeGateway.request(
                method: "node.pending.ack",
                paramsJSON: paramsJSON,
                timeoutSeconds: 6,
                ifCurrentRoute: expectedRoute)
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
        let replyID = event.replyId.trimmingCharacters(in: .whitespacesAndNewlines)
        let actionID = event.actionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !replyID.isEmpty, !actionID.isEmpty else {
            self.watchReplyLogger.info("watch reply dropped: missing replyId/actionId")
            return
        }
        let payloadGatewayID = event.gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let currentGatewayID = self.currentWatchChatGatewayStableID()
        let routedGatewayID = self.watchMessageOutbox.gatewayStableID(forPromptID: event.promptId) ?? ""
        let sourceGatewayID: String = if !payloadGatewayID.isEmpty {
            payloadGatewayID
        } else if !routedGatewayID.isEmpty {
            routedGatewayID
        } else {
            ""
        }
        if !sourceGatewayID.isEmpty, let currentGatewayID, currentGatewayID != sourceGatewayID {
            self.watchReplyLogger.info("watch reply dropped: stale gateway target")
            return
        }
        guard !sourceGatewayID.isEmpty else {
            self.watchReplyLogger.info("watch reply dropped: unresolved gateway target")
            return
        }
        let gatewayStableID = sourceGatewayID

        let message = WatchAppCommandEvent(
            commandId: replyID,
            command: .sendChat,
            sessionKey: event.sessionKey,
            gatewayStableID: gatewayStableID,
            text: Self.makeWatchReplyAgentMessage(event),
            sentAtMs: event.sentAtMs,
            transport: event.transport,
            messageKind: .quickReply)
        let needsReconnect = !self.isWatchMessageSendAvailable()
        await self.handleWatchMessage(message)
        guard needsReconnect else { return }

        let connected = await ensureOperatorApprovalConnectionForWatchReview(
            timeoutMs: 12000,
            reason: "watch_reply")
        guard connected, self.currentWatchChatGatewayStableID() == gatewayStableID else {
            self.watchReplyLogger.info("watch reply remains queued: gateway target unavailable")
            return
        }
        await self.flushQueuedWatchMessagesIfAvailable()
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
        var restoredPushes = Set<ExecApprovalNotificationPrompt>()
        self.pendingWatchExecApprovalRecoveryPushes = (state.pendingApprovalPushes ?? [])
            .filter { push in
                !push.approvalId.isEmpty &&
                    push.gatewayDeviceId?.isEmpty != true &&
                    restoredPushes.insert(push).inserted
            }
            .sorted { lhs, rhs in
                (lhs.gatewayDeviceId ?? "", lhs.approvalId) < (rhs.gatewayDeviceId ?? "", rhs.approvalId)
            }
        var restoredResolvedPushes = Set<ExecApprovalNotificationPrompt>()
        self.pendingExecApprovalResolvedPushes = (state.pendingResolvedPushes ?? [])
            .filter { push in
                !push.approvalId.isEmpty &&
                    push.gatewayDeviceId?.isEmpty != true &&
                    restoredResolvedPushes.insert(push).inserted
            }
            .sorted { lhs, rhs in
                (lhs.gatewayDeviceId ?? "", lhs.approvalId) < (rhs.gatewayDeviceId ?? "", rhs.approvalId)
            }
        var restoredReplyIDs = Set<String>()
        self.pendingWatchExecApprovalResolutions = Array((state.pendingResolutions ?? []).filter { event in
            let replyID = event.replyId.trimmingCharacters(in: .whitespacesAndNewlines)
            let approvalID = event.approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
            let gatewayID = event.gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return !replyID.isEmpty &&
                !approvalID.isEmpty &&
                !gatewayID.isEmpty &&
                restoredReplyIDs.insert(replyID).inserted
        }.suffix(32))
        self.pruneExpiredWatchExecApprovalPrompts()
    }

    private func currentExecApprovalGatewayStableID() -> String? {
        let stableID = self.activeGatewayConnectConfig?.effectiveStableID
            ?? self.connectedGatewayID
            ?? ""
        let normalizedStableID = stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalizedStableID.isEmpty ? nil : normalizedStableID
    }

    private func isExecApprovalPromptCurrent(_ prompt: ExecApprovalPrompt) -> Bool {
        self.currentExecApprovalGatewayStableID() == prompt.gatewayStableID
    }

    private func invalidateExecApprovalSurfacesForGatewayChange() {
        self.pendingExecApprovalPromptRequestGeneration &+= 1
        self.dismissPendingExecApprovalPrompt()
        self.pendingNotificationPermissionGuidancePrompt = nil
        self.watchExecApprovalPromptsByID.removeAll()
        let requestedPushes = self.pendingWatchExecApprovalRecoveryPushes
        self.pendingWatchExecApprovalRecoveryPushes.removeAll()
        let resolvedPushes = self.pendingExecApprovalResolvedPushes
        self.pendingExecApprovalResolvedPushes.removeAll()
        self.persistWatchExecApprovalBridgeState()
        Task { @MainActor [weak self] in
            if let self {
                // Keep notification pushes until terminal state so route invalidation can remove
                // only alerts owned by the old gateway, never a newly delivered replacement.
                for push in Set(requestedPushes + resolvedPushes) {
                    await ExecApprovalNotificationBridge.removeNotifications(
                        for: push,
                        notificationCenter: self.notificationCenter)
                }
            }
            await self?.syncWatchExecApprovalSnapshot(reason: "gateway_changed")
        }
    }

    private func persistWatchExecApprovalBridgeState() {
        self.pruneExpiredWatchExecApprovalPrompts()
        let approvals = self.watchExecApprovalPromptsByID.values.sorted { lhs, rhs in
            let lhsExpires = lhs.expiresAtMs ?? Int64.max
            let rhsExpires = rhs.expiresAtMs ?? Int64.max
            if lhsExpires != rhsExpires {
                return lhsExpires < rhsExpires
            }
            return lhs.id < rhs.id
        }
        let pendingApprovalPushes = self.pendingWatchExecApprovalRecoveryPushes.sorted { lhs, rhs in
            (lhs.gatewayDeviceId ?? "", lhs.approvalId) < (rhs.gatewayDeviceId ?? "", rhs.approvalId)
        }
        let pendingResolvedPushes = self.pendingExecApprovalResolvedPushes.sorted { lhs, rhs in
            (lhs.gatewayDeviceId ?? "", lhs.approvalId) < (rhs.gatewayDeviceId ?? "", rhs.approvalId)
        }
        guard let data = try? JSONEncoder().encode(
            PersistedWatchExecApprovalBridgeState(
                approvals: approvals,
                pendingApprovalPushes: pendingApprovalPushes,
                pendingResolvedPushes: pendingResolvedPushes,
                pendingResolutions: pendingWatchExecApprovalResolutions))
        else {
            return
        }
        UserDefaults.standard.set(data, forKey: Self.watchExecApprovalBridgeStateKey)
    }

    private func pruneExpiredWatchExecApprovalPrompts(nowMs: Int64? = nil) {
        let currentNowMs = nowMs ?? Int64(Date().timeIntervalSince1970 * 1000)
        self.watchExecApprovalPromptsByID = self.watchExecApprovalPromptsByID.filter { _, prompt in
            guard let expiresAtMs = prompt.expiresAtMs else { return true }
            return expiresAtMs > currentNowMs
        }
    }

    private func handleWatchMessagingStatusChanged(_ status: WatchMessagingStatus) async {
        self.watchMessagingStatus = status
        GatewayDiagnostics.log(
            "watch exec approval: status changed "
                + "reachable=\(status.reachable) activation=\(status.activationState) "
                + "backgrounded=\(self.isBackgrounded)")
        guard status.supported, status.paired, status.appInstalled else { return }
        guard status.reachable || status.activationState == "activated" else { return }
        let reason = status.reachable ? "watch_reachable" : "watch_activated"
        await self.syncWatchAppSnapshot(reason: reason, includeChat: status.reachable)
        guard self.isBackgrounded else { return }
        await self.syncWatchExecApprovalSnapshot(reason: reason)
    }

    private func appendPendingWatchExecApprovalRecoveryPush(_ push: ExecApprovalNotificationPrompt) {
        guard !self.pendingWatchExecApprovalRecoveryPushes.contains(push) else { return }
        self.pendingWatchExecApprovalRecoveryPushes.append(push)
        self.pendingWatchExecApprovalRecoveryPushes.sort { lhs, rhs in
            (lhs.gatewayDeviceId ?? "", lhs.approvalId) < (rhs.gatewayDeviceId ?? "", rhs.approvalId)
        }
        GatewayDiagnostics.log(
            "watch exec approval: queued recovery "
                + "id=\(push.approvalId) pendingCount=\(self.pendingWatchExecApprovalRecoveryPushes.count)")
        self.persistWatchExecApprovalBridgeState()
    }

    private func removePendingWatchExecApprovalRecoveryPush(_ push: ExecApprovalNotificationPrompt) {
        let originalCount = self.pendingWatchExecApprovalRecoveryPushes.count
        self.pendingWatchExecApprovalRecoveryPushes.removeAll { $0 == push }
        guard self.pendingWatchExecApprovalRecoveryPushes.count != originalCount else { return }
        GatewayDiagnostics.log(
            "watch exec approval: cleared recovery "
                + "id=\(push.approvalId) pendingCount=\(self.pendingWatchExecApprovalRecoveryPushes.count)")
        self.persistWatchExecApprovalBridgeState()
    }

    private func appendPendingExecApprovalResolvedPush(_ push: ExecApprovalNotificationPrompt) {
        guard !self.pendingExecApprovalResolvedPushes.contains(push) else { return }
        // A silent resolution push is not replayed by the gateway. Keep it until the
        // authenticated owner route returns so its matching notification cannot linger.
        self.pendingExecApprovalResolvedPushes.append(push)
        if self.pendingExecApprovalResolvedPushes.count > 32 {
            self.pendingExecApprovalResolvedPushes.removeFirst()
        }
        self.pendingExecApprovalResolvedPushes.sort { lhs, rhs in
            (lhs.gatewayDeviceId ?? "", lhs.approvalId) < (rhs.gatewayDeviceId ?? "", rhs.approvalId)
        }
        self.persistWatchExecApprovalBridgeState()
    }

    private func removePendingExecApprovalResolvedPush(_ push: ExecApprovalNotificationPrompt) {
        let originalCount = self.pendingExecApprovalResolvedPushes.count
        self.pendingExecApprovalResolvedPushes.removeAll { $0 == push }
        guard self.pendingExecApprovalResolvedPushes.count != originalCount else { return }
        self.persistWatchExecApprovalBridgeState()
    }

    private func upsertWatchExecApprovalPrompt(_ prompt: ExecApprovalPrompt) {
        guard self.isExecApprovalPromptCurrent(prompt) else { return }
        self.watchExecApprovalPromptsByID[prompt.id] = prompt
        self.persistWatchExecApprovalBridgeState()
    }

    private func removeWatchExecApprovalPrompt(_ approvalId: String) {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return }
        self.watchExecApprovalPromptsByID.removeValue(forKey: normalizedApprovalID)
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
            gatewayStableID: prompt.gatewayStableID,
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
        guard self.isExecApprovalPromptCurrent(prompt) else { return }
        let deliveryGeneration = self.gatewayConnectGeneration
        let message = OpenClawWatchExecApprovalPromptMessage(
            approval: Self.makeWatchExecApprovalItem(from: prompt),
            sentAtMs: Int64(Date().timeIntervalSince1970 * 1000),
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
        if deliveryGeneration != self.gatewayConnectGeneration {
            // WatchConnectivity may finish by durably queueing the old payload after a route
            // switch. Publish the replacement owner snapshots after that send completes.
            await self.syncWatchAppSnapshot(reason: "\(reason)_route_repair")
            await self.syncWatchExecApprovalSnapshot(reason: "\(reason)_route_repair")
            return
        }
        await self.syncWatchAppSnapshot(reason: "\(reason)_app")
        await self.syncWatchExecApprovalSnapshot(reason: "\(reason)_snapshot")
    }

    private func publishWatchExecApprovalResolved(
        approvalId: String,
        gatewayStableID: String,
        decision: OpenClawWatchExecApprovalDecision?,
        source: String) async
    {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return }
        if self.watchExecApprovalPromptsByID[normalizedApprovalID]?.gatewayStableID == gatewayStableID {
            self.removeWatchExecApprovalPrompt(normalizedApprovalID)
        }
        let message = OpenClawWatchExecApprovalResolvedMessage(
            approvalId: normalizedApprovalID,
            gatewayStableID: gatewayStableID,
            decision: decision,
            resolvedAtMs: Int64(Date().timeIntervalSince1970 * 1000),
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
        await self.syncWatchAppSnapshot(reason: "resolved_app")
        await self.syncWatchExecApprovalSnapshot(reason: "resolved_snapshot")
    }

    private func publishWatchExecApprovalExpired(
        approvalId: String,
        gatewayStableID: String,
        reason: OpenClawWatchExecApprovalCloseReason) async
    {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return }
        if self.watchExecApprovalPromptsByID[normalizedApprovalID]?.gatewayStableID == gatewayStableID {
            self.removeWatchExecApprovalPrompt(normalizedApprovalID)
        }
        let message = OpenClawWatchExecApprovalExpiredMessage(
            approvalId: normalizedApprovalID,
            gatewayStableID: gatewayStableID,
            reason: reason,
            expiredAtMs: Int64(Date().timeIntervalSince1970 * 1000))
        do {
            _ = try await self.watchMessagingService.sendExecApprovalExpired(message)
        } catch {
            self.watchExecApprovalLogger
                .error(
                    "watch approval expiry failed id=\(normalizedApprovalID, privacy: .public)")
            self.watchExecApprovalLogger.error(
                "watch approval expiry error=\(error.localizedDescription, privacy: .public)")
        }
        await self.syncWatchAppSnapshot(reason: "expired_\(reason.rawValue)_app")
        await self.syncWatchExecApprovalSnapshot(reason: "expired_\(reason.rawValue)")
    }

    private func syncWatchExecApprovalSnapshot(
        reason: String,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
    {
        guard shouldContinue() else { return }
        let deliveryGeneration = self.gatewayConnectGeneration
        self.pruneExpiredWatchExecApprovalPrompts()
        GatewayDiagnostics.log(
            "watch exec approval: sync snapshot start "
                + "reason=\(reason) cacheCount=\(self.watchExecApprovalPromptsByID.count) "
                + "backgrounded=\(self.isBackgrounded)")
        let approvals = self.watchExecApprovalPromptsByID.values
            .filter(self.isExecApprovalPromptCurrent)
            .sorted { lhs, rhs in
                let lhsExpires = lhs.expiresAtMs ?? Int64.max
                let rhsExpires = rhs.expiresAtMs ?? Int64.max
                if lhsExpires != rhsExpires {
                    return lhsExpires < rhsExpires
                }
                return lhs.id < rhs.id
            }
            .map(Self.makeWatchExecApprovalItem)
        let message = OpenClawWatchExecApprovalSnapshotMessage(
            approvals: approvals,
            gatewayStableID: currentExecApprovalGatewayStableID(),
            sentAtMs: Int64(Date().timeIntervalSince1970 * 1000),
            snapshotId: UUID().uuidString)
        do {
            guard shouldContinue() else { return }
            _ = try await self.watchMessagingService.syncExecApprovalSnapshot(message)
            GatewayDiagnostics.log(
                "watch exec approval: sync snapshot sent reason=\(reason) count=\(approvals.count)")
            self.watchExecApprovalLogger
                .debug("watch approval snapshot reason=\(reason, privacy: .public)")
            self.watchExecApprovalLogger.debug(
                "watch approval snapshot count=\(approvals.count, privacy: .public)")
            if deliveryGeneration != self.gatewayConnectGeneration {
                await self.syncWatchExecApprovalSnapshot(reason: "\(reason)_route_repair")
            }
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

    private func makeWatchChatPreview() async -> WatchChatPreview {
        do {
            let payload: OpenClawChatHistoryPayload
            if self.isAppleReviewDemoModeEnabled {
                payload = try await self.appleReviewDemoChatTransport.requestHistory(sessionKey: self.chatSessionKey)
            } else {
                guard self.isOperatorGatewayConnected else {
                    return WatchChatPreview(
                        items: [],
                        statusText: "Connect iPhone chat to read messages")
                }
                payload = try await IOSGatewayChatTransport(gateway: self.operatorSession)
                    .requestHistory(sessionKey: self.chatSessionKey)
            }

            let items = Self.makeWatchChatItems(from: payload.messages ?? [])
            return WatchChatPreview(
                items: items,
                statusText: items.isEmpty ? "No chat messages yet" : nil)
        } catch {
            GatewayDiagnostics.log("watch app snapshot: chat preview failed error=\(error.localizedDescription)")
            return WatchChatPreview(items: [], statusText: "Chat unavailable")
        }
    }

    private nonisolated static func watchChatReplyText(
        from raw: [OpenClawKit.AnyCodable],
        runId: String,
        submittedText: String,
        submittedAtMs: Int64) -> String?
    {
        let entries = raw.compactMap(self.decodeWatchChatMessage)
        if let directReply = entries.last(where: {
            self.isTerminalWatchAssistant($0) && $0.message.idempotencyKey == runId
        }) {
            return directReply.text
        }

        let userIdempotencyKey = "\(runId):user"
        let exactUserIndex = entries.lastIndex(where: {
            $0.message.role.lowercased() == "user" &&
                $0.message.idempotencyKey == userIdempotencyKey
        })
        let queuedUserIndex = entries.lastIndex(where: { entry in
            guard entry.message.role.lowercased() == "user",
                  let timestampMs = self.watchTimestampMs(entry.message.timestamp),
                  timestampMs >= submittedAtMs
            else {
                return false
            }
            return entry.text.contains(submittedText)
        })
        guard let userIndex = exactUserIndex ?? queuedUserIndex else { return nil }
        return entries[(userIndex + 1)...].first(where: {
            self.isTerminalWatchAssistant($0)
        })?.text
    }

    private nonisolated static func isTerminalWatchAssistant(_ entry: WatchChatMessageEntry) -> Bool {
        guard entry.message.role.lowercased() == "assistant" else { return false }
        if entry.isMessageToolMirror {
            return true
        }
        guard let stopReason = entry.message.stopReason?.lowercased() else { return false }
        // Tool-use rows can contain visible progress text, but a later assistant row owns the final reply.
        return stopReason != "tooluse" && stopReason != "tool_use" && stopReason != "tool_calls"
    }

    private nonisolated static func decodeWatchChatMessage(
        _ raw: OpenClawKit.AnyCodable) -> WatchChatMessageEntry?
    {
        guard let data = try? JSONEncoder().encode(raw),
              let message = try? JSONDecoder().decode(OpenClawChatMessage.self, from: data),
              let text = nonEmptyWatchChatText(watchChatText(from: message))
        else {
            return nil
        }
        let metadata = try? JSONDecoder().decode(WatchChatMetadataEnvelope.self, from: data)
        return WatchChatMessageEntry(
            message: message,
            text: text,
            serverId: metadata?.metadata?.id,
            isMessageToolMirror: metadata?.messageToolMirror != nil)
    }

    private nonisolated static func makeWatchChatItems(
        from raw: [OpenClawKit.AnyCodable]) -> [OpenClawWatchChatItem]
    {
        let readableMessages = raw.compactMap(self.decodeWatchChatMessage)
        var idOccurrences: [String: Int] = [:]
        let identified = readableMessages.map { entry -> (WatchChatMessageEntry, String) in
            let baseId = entry.serverId.map { "\(entry.message.role)-\($0)" }
                ?? self.watchChatFallbackKey(entry)
            idOccurrences[baseId, default: 0] += 1
            let stableId = "\(baseId)-\(idOccurrences[baseId]!)"
            return (entry, stableId)
        }
        return identified.suffix(self.watchChatPreviewItemLimit).map { entry, stableId in
            let timestampMs = self.watchTimestampMs(entry.message.timestamp)
            return OpenClawWatchChatItem(
                id: stableId,
                role: entry.message.role,
                text: self.truncatedWatchChatText(entry.text),
                timestampMs: timestampMs)
        }
    }

    private nonisolated static func watchChatFallbackKey(_ entry: WatchChatMessageEntry) -> String {
        let timestamp = self.watchTimestampMs(entry.message.timestamp).map(String.init) ?? "missing"
        let source = "\(entry.message.role)\u{0}\(timestamp)\u{0}\(entry.text)"
        let digest = SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
        return "\(entry.message.role)-\(digest)"
    }

    private nonisolated static func watchChatText(from message: OpenClawChatMessage) -> String {
        let parts = message.content.compactMap { content -> String? in
            let kind = (content.type ?? "text").lowercased()
            guard kind.isEmpty || kind == "text" || kind == "output_text" else { return nil }
            if let text = self.nonEmptyWatchChatText(content.text) {
                return text
            }
            if let text = self.nonEmptyWatchChatText(content.content?.value as? String) {
                return text
            }
            if let dict = content.content?.value as? [String: OpenClawKit.AnyCodable],
               let text = self.nonEmptyWatchChatText(dict["text"]?.value as? String)
            {
                return text
            }
            return nil
        }
        let contentText = parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !contentText.isEmpty {
            return contentText
        }
        return message.errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private nonisolated static func nonEmptyWatchChatText(_ text: String?) -> String? {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private nonisolated static func truncatedWatchChatText(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 240 else { return trimmed }
        return "\(trimmed.prefix(237))..."
    }

    private nonisolated static func watchTimestampMs(_ timestamp: Double?) -> Int64? {
        guard let timestamp, timestamp.isFinite, timestamp >= 0 else { return nil }
        let milliseconds = timestamp > 100_000_000_000 ? timestamp : timestamp * 1000
        let maxReasonableEpochMs: Double = 32_503_680_000_000
        guard milliseconds.isFinite,
              milliseconds >= 0,
              milliseconds <= maxReasonableEpochMs
        else {
            return nil
        }
        return Int64(milliseconds)
    }

    private func makeWatchAppSnapshot(
        chatPreview: WatchChatPreview? = nil) -> OpenClawWatchAppSnapshotMessage
    {
        self.pruneExpiredWatchExecApprovalPrompts()
        let watchGatewayConnected = self.isAppleReviewDemoModeEnabled
            || (self.gatewayConnected && self.operatorConnected)
        let displayStatusText = self.gatewayDisplayStatusText
        let watchGatewayStatusText = watchGatewayConnected || displayStatusText != "Connected"
            ? displayStatusText
            : self.operatorStatusText
        return OpenClawWatchAppSnapshotMessage(
            gatewayStatusText: watchGatewayStatusText,
            gatewayConnected: watchGatewayConnected,
            agentName: self.chatAgentName,
            agentAvatarURL: self.chatAgentAvatarURL,
            agentAvatarText: self.chatAgentAvatarText,
            sessionKey: self.chatSessionKey,
            gatewayStableID: self.currentWatchChatGatewayStableID(),
            talkStatusText: self.talkMode.statusText,
            talkEnabled: self.talkMode.isEnabled,
            talkListening: self.talkMode.isListening,
            talkSpeaking: self.talkMode.isSpeaking,
            pendingApprovalCount: self.watchExecApprovalPromptsByID.count,
            chatItems: chatPreview?.items,
            chatStatusText: chatPreview?.statusText,
            sentAtMs: Int64(Date().timeIntervalSince1970 * 1000),
            snapshotId: UUID().uuidString)
    }

    private func handleWatchAppCommand(_ event: WatchAppCommandEvent) async {
        GatewayDiagnostics.log(
            "watch app command: handle id=\(event.commandId) command=\(event.command.rawValue)")
        if event.command != .sendChat,
           !self.watchAppCommandTargetsCurrentGatewayIfTagged(event)
        {
            GatewayDiagnostics.log("watch app command skipped: stale gateway target")
            await self.syncWatchAppSnapshot(reason: "watch_command_stale_gateway", includeChat: true)
            return
        }
        switch event.command {
        case .refresh:
            break
        case .openChat:
            self.openChat(sessionKey: event.sessionKey ?? self.chatSessionKey)
        case .sendChat:
            await self.handleWatchChatCommand(event)
            return
        case .startTalk:
            guard !self.isAppleReviewDemoModeEnabled else { break }
            self.synchronizeTalkSessionKey(event.sessionKey ?? self.chatSessionKey)
            self.setTalkEnabled(true)
        case .stopTalk:
            self.setTalkEnabled(false)
        }
        await self.syncWatchAppSnapshot(
            reason: "watch_command_\(event.command.rawValue)",
            includeChat: true)
    }

    private func handleWatchChatCommand(_ event: WatchAppCommandEvent) async {
        if self.currentWatchChatGatewayStableID() == nil {
            // Startup may deliver a route-tagged Watch action before restoring that route.
            // Queue it without publishing an ownerless snapshot that would erase Watch routing.
            await self.handleWatchMessage(event)
            return
        }
        guard self.watchMessageTargetsCurrentGateway(event) else {
            GatewayDiagnostics.log("watch chat send skipped: stale gateway target")
            await self.syncWatchAppSnapshot(reason: "watch_chat_stale_gateway", includeChat: true)
            return
        }
        await self.handleWatchMessage(event)
    }

    private func handleWatchMessage(_ event: WatchAppCommandEvent) async {
        let eventGatewayID = self.normalizedWatchMessageGatewayStableID(event)
        let isAvailable = self.isWatchMessageSendAvailable()
        if isAvailable, !self.watchMessageTargetsCurrentGateway(event) {
            GatewayDiagnostics.log("watch message send skipped: stale gateway target")
            return
        }
        switch self.watchMessageOutbox.ingest(
            event,
            isAvailable: isAvailable,
            gatewayStableID: eventGatewayID)
        {
        case .dropMissingFields:
            GatewayDiagnostics.log("watch message send skipped: missing id/text")
        case .dropMissingTarget:
            GatewayDiagnostics.log("watch message send skipped: missing gateway target")
        case let .deduped(messageID):
            GatewayDiagnostics.log("watch message send deduped id=\(messageID)")
        case let .queue(messageID):
            GatewayDiagnostics.log("watch message send queued id=\(messageID)")
            if self.watchMessageKind(event) == .chat,
               self.currentWatchChatGatewayStableID() != nil
            {
                await self.syncWatchAppSnapshot(reason: "watch_chat_queued", includeChat: true)
            }
        case .forward:
            switch await self.forwardWatchMessage(event, requeueOnFailure: true) {
            case .sent, .discard:
                self.watchMessageOutbox.removeQueuedMessage(
                    messageID: event.commandId,
                    gatewayStableID: eventGatewayID)
                self.watchMessageRetryAttempts[event.commandId] = nil
            case .retry:
                self.scheduleWatchMessageRetry(messageID: event.commandId)
            }
        }
    }

    private func flushQueuedWatchMessagesIfAvailable() async {
        guard !self.watchMessageFlushInFlight else { return }
        self.watchMessageFlushInFlight = true
        defer { self.watchMessageFlushInFlight = false }
        guard let gatewayStableID = currentWatchChatGatewayStableID() else { return }
        while self.currentWatchChatGatewayStableID() == gatewayStableID {
            guard let event = watchMessageOutbox.nextQueuedMessage(
                isAvailable: isWatchMessageSendAvailable(),
                gatewayStableID: gatewayStableID)
            else { return }
            guard self.watchMessageTargetsCurrentGateway(event) else { return }
            switch await self.forwardWatchMessage(event, requeueOnFailure: false) {
            case .sent, .discard:
                self.watchMessageOutbox.removeQueuedMessage(
                    messageID: event.commandId,
                    gatewayStableID: gatewayStableID)
                self.watchMessageRetryAttempts[event.commandId] = nil
            case .retry:
                self.scheduleWatchMessageRetry(messageID: event.commandId)
                return
            }
        }
    }

    private func scheduleWatchMessageRetry(messageID: String) {
        guard self.isWatchMessageSendAvailable(), self.watchMessageRetryTask == nil else { return }
        let attempt = (watchMessageRetryAttempts[messageID] ?? 0) + 1
        guard attempt <= Self.watchMessageMaxImmediateRetryAttempts else {
            GatewayDiagnostics.log("watch message retry deferred until reconnect id=\(messageID)")
            return
        }
        self.watchMessageRetryAttempts[messageID] = attempt
        let delayNanoseconds = UInt64(500 * (1 << (attempt - 1))) * 1_000_000
        self.watchMessageRetryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delayNanoseconds)
            guard let self else { return }
            self.watchMessageRetryTask = nil
            await self.flushQueuedWatchMessagesIfAvailable()
        }
    }

    private func isWatchMessageSendAvailable() -> Bool {
        self.isAppleReviewDemoModeEnabled || self.isOperatorGatewayConnected
    }

    private func currentWatchChatGatewayStableID() -> String? {
        self.connectedGatewayID?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func normalizedWatchMessageGatewayStableID(_ event: WatchAppCommandEvent) -> String? {
        let gatewayStableID = event.gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return gatewayStableID.isEmpty ? nil : gatewayStableID
    }

    private func watchMessageTargetsCurrentGateway(_ event: WatchAppCommandEvent) -> Bool {
        let eventGatewayID = self.normalizedWatchMessageGatewayStableID(event) ?? ""
        let currentGatewayID = self.currentWatchChatGatewayStableID() ?? ""
        guard !eventGatewayID.isEmpty, !currentGatewayID.isEmpty else { return false }
        return eventGatewayID == currentGatewayID
    }

    private func watchAppCommandTargetsCurrentGatewayIfTagged(_ event: WatchAppCommandEvent) -> Bool {
        guard let eventGatewayID = normalizedWatchMessageGatewayStableID(event) else {
            // Ownerless commands predate route tagging and remain valid for compatibility.
            return true
        }
        return eventGatewayID == self.currentWatchChatGatewayStableID()
    }

    private func watchMessageKind(_ event: WatchAppCommandEvent) -> WatchMessageKind {
        event.messageKind ?? .chat
    }

    private func forwardWatchMessage(
        _ event: WatchAppCommandEvent,
        requeueOnFailure: Bool) async -> WatchMessageSendOutcome
    {
        guard self.watchMessageTargetsCurrentGateway(event) else {
            GatewayDiagnostics.log("watch message send skipped: stale gateway target")
            return .retry
        }
        let text = event.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else {
            GatewayDiagnostics.log("watch chat send skipped: empty text")
            return .discard
        }

        let messageKind = self.watchMessageKind(event)
        let fallbackSessionKey = messageKind == .quickReply ? self.mainSessionKey : self.chatSessionKey
        let sessionKey = (event.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? event.sessionKey!
            : fallbackSessionKey
        if messageKind == .chat {
            self.focusChatSession(sessionKey)
        }
        let thinking = messageKind == .quickReply ? "low" : "auto"

        do {
            let submittedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            if self.isAppleReviewDemoModeEnabled {
                let response = try await appleReviewDemoChatTransport.sendMessage(
                    sessionKey: sessionKey,
                    message: text,
                    thinking: thinking,
                    idempotencyKey: event.commandId,
                    attachments: [])
                if messageKind == .quickReply {
                    await self.finishForwardedWatchMessage(event)
                    return .sent
                }
                let history = try await appleReviewDemoChatTransport.requestHistory(sessionKey: sessionKey)
                if let replyText = Self.watchChatReplyText(
                    from: history.messages ?? [],
                    runId: response.runId,
                    submittedText: text,
                    submittedAtMs: submittedAtMs)
                {
                    await self.sendWatchChatCompletion(commandId: event.commandId, replyText: replyText)
                }
                await self.syncWatchAppSnapshot(reason: "watch_chat_completed", includeChat: true)
                return .sent
            }

            guard self.isOperatorGatewayConnected else {
                GatewayDiagnostics.log("watch chat send skipped: operator gateway disconnected")
                if requeueOnFailure {
                    self.watchMessageOutbox.requeueFront(
                        event,
                        gatewayStableID: self.normalizedWatchMessageGatewayStableID(event))
                }
                return .retry
            }
            guard self.watchMessageTargetsCurrentGateway(event),
                  let operatorRoute = await operatorSession.currentRoute(),
                  isOperatorGatewayConnected,
                  watchMessageTargetsCurrentGateway(event)
            else {
                GatewayDiagnostics.log("watch chat send skipped: gateway route changed before dispatch")
                return .retry
            }

            let transport = IOSGatewayChatTransport(gateway: operatorSession)
            let completionDeadline = Date().addingTimeInterval(
                Double(Self.watchChatCompletionWaitMs) / 1000)
            let response = try await transport.sendMessage(
                sessionKey: sessionKey,
                message: text,
                thinking: thinking,
                idempotencyKey: event.commandId,
                attachments: [],
                ifCurrentRoute: operatorRoute)
            if messageKind == .quickReply {
                await self.finishForwardedWatchMessage(event)
                return .sent
            }
            await self.syncWatchAppSnapshot(reason: "watch_chat_sent", includeChat: true)
            _ = await transport.waitForRunCompletion(
                runId: response.runId,
                timeoutMs: Self.watchChatRunWaitSliceMs,
                ifCurrentRoute: operatorRoute)
            if let replyText = await waitForWatchChatReply(
                transport: transport,
                sessionKey: sessionKey,
                runId: response.runId,
                submittedText: text,
                submittedAtMs: submittedAtMs,
                deadline: completionDeadline,
                expectedRoute: operatorRoute)
            {
                guard self.watchMessageTargetsCurrentGateway(event),
                      await self.operatorSession.currentRoute() == operatorRoute
                else {
                    GatewayDiagnostics.log("watch chat completion skipped: gateway route changed")
                    return .discard
                }
                await self.sendWatchChatCompletion(commandId: event.commandId, replyText: replyText)
            }
            await self.syncWatchAppSnapshot(
                reason: "watch_chat_completed",
                includeChat: true,
                shouldContinue: { self.watchMessageTargetsCurrentGateway(event) })
            return .sent
        } catch is CancellationError {
            if !self.watchMessageTargetsCurrentGateway(event) {
                GatewayDiagnostics.log("watch chat send canceled: gateway target changed")
                return .discard
            }
            GatewayDiagnostics.log("watch chat send canceled before dispatch")
            if requeueOnFailure {
                self.watchMessageOutbox.requeueFront(
                    event,
                    gatewayStableID: self.normalizedWatchMessageGatewayStableID(event))
            }
            return .retry
        } catch {
            GatewayDiagnostics.log("watch chat send failed error=\(error.localizedDescription)")
            if Self.shouldDiscardFailedWatchMessage(error) {
                GatewayDiagnostics.log("watch message discarded after permanent send failure id=\(event.commandId)")
                return .discard
            }
            if requeueOnFailure {
                self.watchMessageOutbox.requeueFront(
                    event,
                    gatewayStableID: self.normalizedWatchMessageGatewayStableID(event))
            }
            return .retry
        }
    }

    private func waitForWatchChatReply(
        transport: IOSGatewayChatTransport,
        sessionKey: String,
        runId: String,
        submittedText: String,
        submittedAtMs: Int64,
        deadline: Date,
        expectedRoute: GatewayNodeSessionRoute) async -> String?
    {
        repeat {
            guard await self.operatorSession.currentRoute() == expectedRoute else { return nil }
            if let payload = try? await transport.requestHistory(
                sessionKey: sessionKey,
                ifCurrentRoute: expectedRoute),
                let replyText = Self.watchChatReplyText(
                    from: payload.messages ?? [],
                    runId: runId,
                    submittedText: submittedText,
                    submittedAtMs: submittedAtMs)
            {
                return replyText
            }
            guard Date() < deadline else { return nil }
            try? await Task.sleep(for: .seconds(1))
        } while !Task.isCancelled
        return nil
    }

    private func sendWatchChatCompletion(commandId: String, replyText: String) async {
        do {
            _ = try await self.watchMessagingService.sendChatCompletion(
                OpenClawWatchChatCompletionMessage(
                    commandId: commandId,
                    replyText: replyText,
                    sentAtMs: Int64(Date().timeIntervalSince1970 * 1000)))
        } catch {
            GatewayDiagnostics.log(
                "watch chat completion failed commandId=\(commandId) error=\(error.localizedDescription)")
        }
    }

    private nonisolated static func shouldDiscardFailedWatchMessage(_ error: Error) -> Bool {
        guard let gatewayError = error as? GatewayResponseError else { return false }
        guard gatewayError.code == "INVALID_REQUEST" else { return false }
        return !gatewayError.message.lowercased().hasSuffix("retry.")
    }

    private func finishForwardedWatchMessage(_ event: WatchAppCommandEvent) async {
        if self.watchMessageKind(event) == .chat {
            await self.syncWatchAppSnapshot(reason: "watch_chat_sent", includeChat: true)
            return
        }
        self.watchReplyLogger.info(
            "watch reply forwarded replyId=\(event.commandId, privacy: .public)")
        self.openChatRequestID &+= 1
    }

    private func syncWatchAppSnapshot(
        reason: String,
        includeChat: Bool = false,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
    {
        guard shouldContinue() else { return }
        let deliveryGeneration = self.gatewayConnectGeneration
        let chatPreview = includeChat ? await makeWatchChatPreview() : nil
        guard shouldContinue() else { return }
        guard deliveryGeneration == self.gatewayConnectGeneration else {
            await self.syncWatchAppSnapshot(reason: "\(reason)_route_repair")
            return
        }
        let message = self.makeWatchAppSnapshot(chatPreview: chatPreview)
        do {
            guard shouldContinue() else { return }
            _ = try await self.watchMessagingService.syncAppSnapshot(message)
            GatewayDiagnostics.log(
                "watch app snapshot: sent reason=\(reason) "
                    + "connected=\(message.gatewayConnected) approvals=\(message.pendingApprovalCount) "
                    + "chatItems=\(message.chatItems?.count ?? -1)")
            if deliveryGeneration != self.gatewayConnectGeneration {
                await self.syncWatchAppSnapshot(reason: "\(reason)_route_repair")
            }
        } catch {
            GatewayDiagnostics.log(
                "watch app snapshot: failed reason=\(reason) error=\(error.localizedDescription)")
        }
    }

    private func refreshWatchExecApprovalSnapshotOnDemand(reason: String) async {
        GatewayDiagnostics.log("watch exec approval: refresh on demand start reason=\(reason)")
        await self.hydrateWatchExecApprovalCacheIfNeeded(reason: reason)
        await self.syncWatchExecApprovalSnapshot(reason: reason)
        await self.syncWatchAppSnapshot(reason: "\(reason)_app", includeChat: true)
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

        let approvalPushes = await pendingExecApprovalPushesForWatchRecovery()
        let missingApprovalIDs = Set(Self.watchExecApprovalIDsNeedingFetch(
            candidateIDs: approvalPushes.map(\.approvalId),
            cachedApprovalIDs: Array(self.watchExecApprovalPromptsByID.keys)))
        GatewayDiagnostics.log(
            "watch exec approval: hydrate candidates "
                + "reason=\(reason) ids=\(approvalPushes.map(\.approvalId).joined(separator: ",")) "
                + "missing=\(missingApprovalIDs.sorted().joined(separator: ",")) "
                + "cached=\(self.watchExecApprovalPromptsByID.count)")
        guard !missingApprovalIDs.isEmpty else {
            self.watchExecApprovalLogger.debug(
                "watch exec approval hydrate skipped reason=\(reason, privacy: .public): no missing approval ids")
            return
        }

        for push in approvalPushes where missingApprovalIDs.contains(push.approvalId) {
            let approvalId = push.approvalId
            GatewayDiagnostics.log(
                "watch exec approval: hydrate fetch start id=\(approvalId) reason=\(reason)")
            let operatorRoute: GatewayNodeSessionRoute
            switch await self.validateExecApprovalPushRoute(push, sourceReason: reason) {
            case let .validated(context):
                operatorRoute = context.route
            case .unavailable:
                continue
            case .mismatchedOwner:
                await ExecApprovalNotificationBridge.removeNotifications(
                    for: push,
                    notificationCenter: self.notificationCenter)
                self.removePendingWatchExecApprovalRecoveryPush(push)
                continue
            }
            let outcome = await fetchExecApprovalPrompt(
                approvalId: approvalId,
                sourceReason: reason,
                expectedOperatorRoute: operatorRoute)
            switch outcome {
            case let .loaded(prompt):
                GatewayDiagnostics.log("watch exec approval: hydrate fetch loaded id=\(approvalId)")
                self.upsertWatchExecApprovalPrompt(prompt)
            case .stale:
                GatewayDiagnostics.log("watch exec approval: hydrate fetch stale id=\(approvalId)")
                self.removePendingWatchExecApprovalRecoveryPush(push)
                await ExecApprovalNotificationBridge.removeNotifications(
                    for: push,
                    notificationCenter: self.notificationCenter)
            case let .failed(message):
                self.watchExecApprovalLogger
                    .error("watch approval hydrate failed id=\(approvalId, privacy: .public)")
                self.watchExecApprovalLogger.error("watch approval hydrate reason=\(reason, privacy: .public)")
                self.watchExecApprovalLogger.error("watch approval hydrate error=\(message, privacy: .public)")
            }
        }
    }

    private func pendingExecApprovalPushesForWatchRecovery() async -> [ExecApprovalNotificationPrompt] {
        var pushes = self.pendingWatchExecApprovalRecoveryPushes
        var seen = Set(pushes)

        let delivered = await notificationCenter.deliveredNotifications()
        GatewayDiagnostics.log("watch exec approval: delivered notifications count=\(delivered.count)")
        for snapshot in delivered {
            guard let push = ExecApprovalNotificationBridge.parseRequestedPush(userInfo: snapshot.userInfo),
                  seen.insert(push).inserted
            else { continue }
            pushes.append(push)
            // Notification Center may be the only surviving source after relaunch.
            // Persist its owner tag so later route invalidation can remove only this alert.
            self.appendPendingWatchExecApprovalRecoveryPush(push)
        }

        return pushes
    }

    @discardableResult
    private func handleWatchExecApprovalResolve(_ event: WatchExecApprovalResolveEvent) async -> Bool {
        let normalizedApprovalID = event.approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return true }
        guard let routedEvent = ownerScopedWatchExecApprovalEvent(
            event,
            approvalID: normalizedApprovalID)
        else {
            await self.syncWatchExecApprovalSnapshot(reason: "legacy_watch_reply_rejected")
            return true
        }
        guard let currentGatewayStableID = currentExecApprovalGatewayStableID() else {
            self.enqueuePendingWatchExecApprovalResolution(routedEvent)
            return false
        }
        guard Self.trimmedOrNil(routedEvent.gatewayStableID) == currentGatewayStableID else {
            // Watch replies can arrive after a gateway switch. Reassert the current
            // snapshot instead of allowing an old same-ID prompt to target the new gateway.
            await self.syncWatchExecApprovalSnapshot(reason: "stale_gateway_reply")
            return true
        }
        guard let prompt = watchExecApprovalPromptsByID[normalizedApprovalID],
              prompt.gatewayStableID == currentGatewayStableID,
              isExecApprovalPromptCurrent(prompt)
        else {
            await self.publishWatchExecApprovalExpired(
                approvalId: normalizedApprovalID,
                gatewayStableID: currentGatewayStableID,
                reason: .unavailable)
            return true
        }
        if self.pendingExecApprovalPrompt?.id == normalizedApprovalID {
            self.pendingExecApprovalPromptResolving = true
            self.pendingExecApprovalPromptErrorText = nil
        }
        let outcome = await resolveExecApprovalNotificationDecision(
            approvalId: normalizedApprovalID,
            decision: routedEvent.decision.rawValue,
            expectedGatewayStableID: prompt.gatewayStableID,
            sourceReason: "watch_resolve")
        if case let .failed(message) = outcome {
            if self.pendingExecApprovalPrompt?.id == normalizedApprovalID {
                self.pendingExecApprovalPromptResolving = false
                self.pendingExecApprovalPromptErrorText = message
            }
            if let prompt = watchExecApprovalPromptsByID[normalizedApprovalID] {
                await self.publishWatchExecApprovalPrompt(prompt, reason: "resolve_retry")
            }
            return false
        }
        return true
    }

    private func ownerScopedWatchExecApprovalEvent(
        _ event: WatchExecApprovalResolveEvent,
        approvalID: String) -> WatchExecApprovalResolveEvent?
    {
        if Self.trimmedOrNil(event.gatewayStableID) != nil {
            return event
        }
        guard let prompt = watchExecApprovalPromptsByID[approvalID] else { return nil }
        // A shipped Watch binary can omit the owner field. Bind only to the prompt that
        // originally supplied this approval ID; never infer ownership from a later route.
        var routedEvent = event
        routedEvent.gatewayStableID = prompt.gatewayStableID
        return routedEvent
    }

    private func enqueuePendingWatchExecApprovalResolution(_ event: WatchExecApprovalResolveEvent) {
        let replyID = event.replyId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !replyID.isEmpty,
              !self.pendingWatchExecApprovalResolutions.contains(where: { $0.replyId == replyID })
        else { return }
        // transferUserInfo is durable only until delivery. Retain the delivered action until
        // startup restores a route, while bounding malformed or replayed Watch traffic.
        self.pendingWatchExecApprovalResolutions.append(event)
        if self.pendingWatchExecApprovalResolutions.count > 32 {
            self.pendingWatchExecApprovalResolutions.removeFirst()
        }
        self.persistWatchExecApprovalBridgeState()
    }

    private func removePendingWatchExecApprovalResolution(replyID: String) {
        let originalCount = self.pendingWatchExecApprovalResolutions.count
        self.pendingWatchExecApprovalResolutions.removeAll { $0.replyId == replyID }
        guard self.pendingWatchExecApprovalResolutions.count != originalCount else { return }
        self.persistWatchExecApprovalBridgeState()
    }

    private func flushPendingWatchExecApprovalResolutions(
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
    {
        guard shouldContinue(), !self.pendingWatchExecApprovalResolutions.isEmpty else { return }
        await self.hydrateWatchExecApprovalCacheIfNeeded(reason: "queued_watch_resolve")
        guard shouldContinue(), let currentGatewayStableID = currentExecApprovalGatewayStableID() else { return }
        let pending = self.pendingWatchExecApprovalResolutions
        var discardedMismatchedOwner = false
        for event in pending {
            guard shouldContinue() else { return }
            let owner = Self.trimmedOrNil(event.gatewayStableID)
            guard owner == currentGatewayStableID else {
                discardedMismatchedOwner = true
                self.removePendingWatchExecApprovalResolution(replyID: event.replyId)
                continue
            }
            let completed = await handleWatchExecApprovalResolve(event)
            if completed {
                self.removePendingWatchExecApprovalResolution(replyID: event.replyId)
            }
        }
        if discardedMismatchedOwner, shouldContinue() {
            await self.syncWatchExecApprovalSnapshot(reason: "queued_stale_gateway_reply")
        }
    }

    func handleExecApprovalRequestedRemotePush(_ push: ExecApprovalNotificationPrompt) async -> Bool {
        let normalizedApprovalID = push.approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty else { return false }
        let operatorRoute: GatewayNodeSessionRoute
        switch await self.validateExecApprovalPushRoute(push, sourceReason: "push_request") {
        case let .validated(context):
            operatorRoute = context.route
        case .unavailable:
            // APNs delivery is one-shot. Retain the owner-tagged request until its route
            // returns so Watch recovery cannot lose an approval during a reconnect.
            self.appendPendingWatchExecApprovalRecoveryPush(push)
            return true
        case .mismatchedOwner:
            await ExecApprovalNotificationBridge.removeNotifications(
                for: push,
                notificationCenter: self.notificationCenter)
            self.removePendingWatchExecApprovalRecoveryPush(push)
            return true
        }
        self.appendPendingWatchExecApprovalRecoveryPush(push)
        guard let gatewayStableID = currentExecApprovalGatewayStableID() else { return true }
        let fetchedPrompt = await fetchExecApprovalPrompt(
            approvalId: normalizedApprovalID,
            sourceReason: "push_request",
            expectedOperatorRoute: operatorRoute)
        switch fetchedPrompt {
        case let .loaded(prompt):
            self.upsertWatchExecApprovalPrompt(prompt)
            await self.publishWatchExecApprovalPrompt(prompt, reason: "push_request")
            return true
        case .stale:
            await ExecApprovalNotificationBridge.removeNotifications(
                for: push,
                notificationCenter: self.notificationCenter)
            self.removePendingWatchExecApprovalRecoveryPush(push)
            self.clearPendingExecApprovalPromptIfMatches(normalizedApprovalID)
            await self.publishWatchExecApprovalExpired(
                approvalId: normalizedApprovalID,
                gatewayStableID: gatewayStableID,
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

    @discardableResult
    private func handleExecApprovalResolvedForCurrentGateway(
        approvalId: String,
        recoveryPushGatewayDeviceID: String? = nil,
        routeContext: GatewaySessionRouteContext? = nil,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
        -> Bool
    {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedApprovalID.isEmpty,
              await self.canApplyExecApprovalResolvedState(
                  routeContext: routeContext,
                  shouldContinue: shouldContinue)
        else { return false }

        let currentGatewayStableID = self.currentExecApprovalGatewayStableID()
        let hadWatchPrompt = if let currentGatewayStableID {
            self.watchExecApprovalPromptsByID[normalizedApprovalID]?.gatewayStableID == currentGatewayStableID
        } else {
            false
        }
        let hadPendingPrompt = if let currentGatewayStableID {
            self.pendingExecApprovalPrompt?.id == normalizedApprovalID &&
                self.pendingExecApprovalPrompt?.gatewayStableID == currentGatewayStableID
        } else {
            false
        }
        let recoveryPushes: [ExecApprovalNotificationPrompt] = if let recoveryPushGatewayDeviceID = Self
            .trimmedOrNil(recoveryPushGatewayDeviceID)
        {
            self.pendingWatchExecApprovalRecoveryPushes.filter { push in
                push.approvalId == normalizedApprovalID &&
                    Self.trimmedOrNil(push.gatewayDeviceId) == recoveryPushGatewayDeviceID
            }
        } else {
            []
        }
        let hadPendingRecoveryID = !recoveryPushes.isEmpty
        let hadGuidancePrompt = self.pendingNotificationPermissionGuidancePrompt?.approvalId == normalizedApprovalID
        let hadApprovalSurface = hadWatchPrompt || hadPendingPrompt || hadPendingRecoveryID
        guard hadApprovalSurface || hadGuidancePrompt else {
            return true
        }

        if hadApprovalSurface, let currentGatewayStableID {
            await self.publishWatchExecApprovalExpired(
                approvalId: normalizedApprovalID,
                gatewayStableID: currentGatewayStableID,
                reason: .resolved)
            guard await self.canApplyExecApprovalResolvedState(
                routeContext: routeContext,
                shouldContinue: shouldContinue)
            else { return false }
        }
        for push in recoveryPushes {
            await ExecApprovalNotificationBridge.removeNotifications(
                for: push,
                notificationCenter: self.notificationCenter)
            guard await self.canApplyExecApprovalResolvedState(
                routeContext: routeContext,
                shouldContinue: shouldContinue)
            else { return false }
            self.removePendingWatchExecApprovalRecoveryPush(push)
        }
        guard await self.canApplyExecApprovalResolvedState(
            routeContext: routeContext,
            shouldContinue: shouldContinue)
        else { return false }
        self.clearPendingExecApprovalPromptIfMatches(normalizedApprovalID)
        return true
    }

    private func canApplyExecApprovalResolvedState(
        routeContext: GatewaySessionRouteContext?,
        shouldContinue: @MainActor @Sendable () -> Bool) async -> Bool
    {
        guard shouldContinue() else { return false }
        guard let routeContext else { return true }
        return await self.isCurrentGatewaySessionRoute(
            routeContext,
            session: self.operatorGateway,
            shouldContinue: shouldContinue)
    }

    func handleExecApprovalResolvedRemotePush(_ push: ExecApprovalNotificationPrompt) async -> Bool {
        switch await self.validateExecApprovalPushRoute(push, sourceReason: "push_resolved") {
        case let .validated(context):
            let applied = await self.applyValidatedExecApprovalResolvedPush(push, context: context)
            if !applied {
                self.appendPendingExecApprovalResolvedPush(push)
            }
        case .unavailable:
            self.appendPendingExecApprovalResolvedPush(push)
            if Self.trimmedOrNil(push.gatewayDeviceId) != nil {
                // The terminal push already identifies its notification owner. Remove that
                // exact alert now while retaining durable state for route-bound Watch cleanup.
                await ExecApprovalNotificationBridge.removeNotifications(
                    for: push,
                    notificationCenter: self.notificationCenter)
            }
        case .mismatchedOwner:
            // The payload names another gateway. Exact owner matching makes cleanup safe,
            // but it must not mutate approval state for the active gateway.
            await ExecApprovalNotificationBridge.removeNotifications(
                for: push,
                notificationCenter: self.notificationCenter)
            self.removePendingWatchExecApprovalRecoveryPush(push)
            self.removePendingExecApprovalResolvedPush(push)
        }
        return true
    }

    @discardableResult
    private func applyValidatedExecApprovalResolvedPush(
        _ push: ExecApprovalNotificationPrompt,
        context: GatewaySessionRouteContext) async -> Bool
    {
        let routeIsCurrent: @MainActor @Sendable () -> Bool = { [weak self] in
            self?.isCurrentGatewayRoute(
                generation: context.routeGeneration,
                stableID: context.gatewayStableID) == true
        }
        guard await self.isCurrentGatewaySessionRoute(
            context,
            session: self.operatorGateway,
            shouldContinue: routeIsCurrent)
        else { return false }
        guard await self.handleExecApprovalResolvedForCurrentGateway(
            approvalId: push.approvalId,
            recoveryPushGatewayDeviceID: push.gatewayDeviceId,
            routeContext: context,
            shouldContinue: routeIsCurrent)
        else { return false }
        guard await self.isCurrentGatewaySessionRoute(
            context,
            session: self.operatorGateway,
            shouldContinue: routeIsCurrent)
        else { return false }
        await ExecApprovalNotificationBridge.removeNotifications(
            for: push,
            notificationCenter: self.notificationCenter,
            includingLegacyOwnerless: true)
        guard await self.isCurrentGatewaySessionRoute(
            context,
            session: self.operatorGateway,
            shouldContinue: routeIsCurrent)
        else { return false }
        self.removePendingWatchExecApprovalRecoveryPush(push)
        self.removePendingExecApprovalResolvedPush(push)
        return true
    }

    private func flushPendingExecApprovalResolvedPushes(
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
    {
        guard shouldContinue(), !self.pendingExecApprovalResolvedPushes.isEmpty else { return }
        for push in self.pendingExecApprovalResolvedPushes {
            guard shouldContinue() else { return }
            switch await self.validateExecApprovalPushRoute(
                push,
                sourceReason: "push_resolved",
                shouldContinue: shouldContinue)
            {
            case let .validated(context):
                guard await self.applyValidatedExecApprovalResolvedPush(push, context: context) else {
                    return
                }
            case .unavailable:
                return
            case .mismatchedOwner:
                await ExecApprovalNotificationBridge.removeNotifications(
                    for: push,
                    notificationCenter: self.notificationCenter)
                self.removePendingWatchExecApprovalRecoveryPush(push)
                self.removePendingExecApprovalResolvedPush(push)
            }
        }
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
                + "backgrounded=\(isBackgrounded) "
                + "autoReconnect=\(gatewayAutoReconnectEnabled)"
        self.pushWakeLogger.info("\(receivedMessage, privacy: .public)")

        if let push = ExecApprovalNotificationBridge.parseResolvedPush(userInfo: userInfo) {
            let handled = await handleExecApprovalResolvedRemotePush(push)
            let cleanupMessage =
                "Handled exec approval cleanup push wakeId=\(wakeId) "
                    + "handled=\(handled)"
            self.execApprovalNotificationLogger.info(
                "\(cleanupMessage, privacy: .public)")
            return handled
        }

        if let push = ExecApprovalNotificationBridge.parseRequestedPush(userInfo: userInfo) {
            let handled = await handleExecApprovalRequestedRemotePush(push)
            if handled {
                let handledMessage =
                    "handled approval push wakeId=\(wakeId) "
                        + "id=\(push.approvalId)"
                self.execApprovalNotificationLogger
                    .info("\(handledMessage, privacy: .public)")
            }
            return handled
        }

        let result = await performBackgroundAliveBeaconIfNeeded(
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
        let result = await performBackgroundAliveBeaconIfNeeded(
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

        if await isGatewayConnected() {
            self.locationWakeLogger.info(
                "Location wake no-op wakeId=\(wakeId, privacy: .public): already connected")
            return
        }
        if let last = lastSignificantLocationWakeAt,
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
                + "backgrounded=\(isBackgrounded) "
                + "autoReconnect=\(gatewayAutoReconnectEnabled)"
        self.locationWakeLogger.info("\(beginMessage, privacy: .public)")
        let result = await performBackgroundAliveBeaconIfNeeded(
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
        let connected = await waitForGatewayConnection(timeoutMs: 5000, pollMs: 250)
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

    private func registerAPNsTokenIfNeeded(
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
    {
        guard shouldContinue() else { return }
        let usesRelayTransport = await pushRegistrationManager.usesRelayTransport
        guard shouldContinue() else { return }
        guard await self.canPublishAPNsRegistration(usesRelayTransport: usesRelayTransport) else { return }
        guard shouldContinue() else { return }
        guard self.gatewayConnected else {
            if usesRelayTransport {
                GatewayDiagnostics.pushRelay.skipped("gateway_offline")
            }
            return
        }
        guard let nodeRoute = await nodeGateway.currentRoute(), shouldContinue() else { return }
        guard let context = self.makeAPNsRegistrationContext(
            usesRelayTransport: usesRelayTransport,
            nodeRoute: nodeRoute)
        else { return }

        do {
            let gatewayIdentity: PushRelayGatewayIdentity?
            if context.usesRelayTransport {
                guard self.operatorConnected else {
                    GatewayDiagnostics.pushRelay.skipped("operator_offline")
                    return
                }
                GatewayDiagnostics.pushRelay.stage("gateway identity request start")
                gatewayIdentity = try await self.fetchPushRelayGatewayIdentity()
                guard shouldContinue() else { return }
                GatewayDiagnostics.pushRelay.stage("gateway identity request complete")
            } else {
                gatewayIdentity = nil
            }
            if context.usesRelayTransport {
                GatewayDiagnostics.pushRelay.stage("gateway registration payload start")
            }
            let payloadJSON = try await pushRegistrationManager.makeGatewayRegistrationPayload(
                apnsTokenHex: context.token,
                topic: context.topic,
                gatewayIdentity: gatewayIdentity)
            guard shouldContinue() else { return }
            let published = await nodeGateway.sendEvent(
                event: "push.apns.register",
                payloadJSON: payloadJSON,
                ifCurrentRoute: context.nodeRoute)
            guard published, shouldContinue() else { return }
            self.apnsLastRegisteredTokenHex = context.token
            self.apnsLastRegisteredGatewayStableID = context.gatewayStableID
            if context.usesRelayTransport {
                GatewayDiagnostics.pushRelay.stage("gateway registration event published")
            }
        } catch {
            self.pushWakeLogger.error(
                "APNs registration publish failed: \(error.localizedDescription, privacy: .public)")
            if context.usesRelayTransport {
                GatewayDiagnostics.pushRelay.failed("registration", error: error)
            }
        }
    }

    private func makeAPNsRegistrationContext(
        usesRelayTransport: Bool,
        nodeRoute: GatewayNodeSessionRoute) -> APNsRegistrationContext?
    {
        guard let token = apnsDeviceTokenHex?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty
        else {
            if usesRelayTransport {
                GatewayDiagnostics.pushRelay.skipped("missing_apns_token")
            }
            return nil
        }
        let gatewayStableID = self.activeGatewayConnectConfig?.effectiveStableID
            ?? self.connectedGatewayID
            ?? ""
        if !usesRelayTransport,
           !Self.shouldPublishDirectAPNsRegistration(
               token: token,
               gatewayStableID: gatewayStableID,
               lastToken: self.apnsLastRegisteredTokenHex,
               lastGatewayStableID: self.apnsLastRegisteredGatewayStableID)
        {
            return nil
        }
        guard let topic = Bundle.main.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
              !topic.isEmpty
        else {
            if usesRelayTransport {
                GatewayDiagnostics.pushRelay.skipped("missing_topic")
            }
            return nil
        }
        return APNsRegistrationContext(
            usesRelayTransport: usesRelayTransport,
            nodeRoute: nodeRoute,
            token: token,
            gatewayStableID: gatewayStableID,
            topic: topic)
    }

    private func canPublishAPNsRegistration(usesRelayTransport: Bool) async -> Bool {
        if usesRelayTransport, !PushEnrollmentConsent.disclosureAccepted {
            GatewayDiagnostics.pushRelay.skipped("enrollment_disclosure_not_accepted")
            return false
        }
        guard NotificationServingPreference.isEnabled() else {
            if usesRelayTransport {
                GatewayDiagnostics.pushRelay.skipped("notification_serving_disabled")
            }
            return false
        }
        let status = await notificationAuthorizationStatus()
        guard Self.isNotificationAuthorizationAllowed(status) else {
            if usesRelayTransport {
                GatewayDiagnostics.pushRelay.skipped("notifications_not_authorized")
            }
            return false
        }
        return true
    }

    nonisolated static func shouldPublishDirectAPNsRegistration(
        token: String,
        gatewayStableID: String,
        lastToken: String?,
        lastGatewayStableID: String?) -> Bool
    {
        token != lastToken || gatewayStableID != lastGatewayStableID
    }

    private func fetchPushRelayGatewayIdentity(
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute? = nil) async throws -> PushRelayGatewayIdentity
    {
        let response = try await operatorGateway.request(
            method: "gateway.identity.get",
            paramsJSON: "{}",
            timeoutSeconds: 8,
            ifCurrentRoute: expectedRoute)
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
        var expiresAtMs: Int64?
    }

    func presentExecApprovalNotificationPrompt(
        _ prompt: ExecApprovalNotificationPrompt,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
    {
        let approvalId = prompt.approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard shouldContinue(), !approvalId.isEmpty else { return }
        let operatorRoute: GatewayNodeSessionRoute
        switch await self.validateExecApprovalPushRoute(
            prompt,
            sourceReason: "notification_action",
            shouldContinue: shouldContinue)
        {
        case let .validated(context):
            operatorRoute = context.route
        case .unavailable:
            guard shouldContinue() else { return }
            self.appendPendingWatchExecApprovalRecoveryPush(prompt)
            return
        case .mismatchedOwner:
            await ExecApprovalNotificationBridge.removeNotifications(
                for: prompt,
                notificationCenter: self.notificationCenter)
            self.removePendingWatchExecApprovalRecoveryPush(prompt)
            return
        }
        self.appendPendingWatchExecApprovalRecoveryPush(prompt)
        await self.presentExecApprovalPrompt(
            approvalId: approvalId,
            notificationPush: prompt,
            expectedOperatorRoute: operatorRoute,
            shouldContinue: shouldContinue)
    }

    private func presentExecApprovalGatewayEventPrompt(
        approvalId: String,
        expectedOperatorRoute: GatewayNodeSessionRoute? = nil,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async
    {
        await self.presentExecApprovalPrompt(
            approvalId: approvalId,
            notificationPush: nil,
            expectedOperatorRoute: expectedOperatorRoute,
            shouldContinue: shouldContinue)
    }

    private func presentExecApprovalPrompt(
        approvalId: String,
        notificationPush: ExecApprovalNotificationPrompt?,
        expectedOperatorRoute: GatewayNodeSessionRoute?,
        shouldContinue: @MainActor @Sendable () -> Bool) async
    {
        guard shouldContinue(), !approvalId.isEmpty else { return }

        self.pendingExecApprovalPromptRequestGeneration &+= 1
        let requestGeneration = self.pendingExecApprovalPromptRequestGeneration
        self.pendingExecApprovalPromptResolving = true
        self.pendingExecApprovalPromptErrorText = nil

        let fetchedPrompt = await fetchExecApprovalPrompt(
            approvalId: approvalId,
            expectedOperatorRoute: expectedOperatorRoute,
            shouldContinue: shouldContinue)
        guard shouldContinue(), self.pendingExecApprovalPromptRequestGeneration == requestGeneration else {
            if self.pendingExecApprovalPromptRequestGeneration == requestGeneration {
                self.pendingExecApprovalPromptResolving = false
            }
            return
        }
        self.pendingExecApprovalPromptResolving = false
        switch fetchedPrompt {
        case let .loaded(fetchedPrompt):
            self.presentFetchedExecApprovalPrompt(fetchedPrompt)
        case .stale:
            if let notificationPush {
                await ExecApprovalNotificationBridge.removeNotifications(
                    for: notificationPush,
                    notificationCenter: self.notificationCenter)
                self.removePendingWatchExecApprovalRecoveryPush(notificationPush)
            }
            self.clearPendingExecApprovalPromptIfMatches(approvalId)
            if let gatewayStableID = currentExecApprovalGatewayStableID() {
                await self.publishWatchExecApprovalExpired(
                    approvalId: approvalId,
                    gatewayStableID: gatewayStableID,
                    reason: .notFound)
            }
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
        guard self.isExecApprovalPromptCurrent(prompt) else { return }
        self.pendingExecApprovalPrompt = prompt
        self.pendingExecApprovalPromptResolving = false
        self.pendingExecApprovalPromptErrorText = nil
        self.upsertWatchExecApprovalPrompt(prompt)
        Task { @MainActor [weak self] in
            await self?.publishWatchExecApprovalPrompt(prompt, reason: "present_prompt")
        }
    }

    private static func makeExecApprovalPrompt(
        from details: ExecApprovalGetResponse,
        gatewayStableID: String) -> ExecApprovalPrompt?
    {
        let approvalId = details.id.trimmingCharacters(in: .whitespacesAndNewlines)
        let commandText = details.commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedGatewayStableID = gatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !approvalId.isEmpty, !commandText.isEmpty, !normalizedGatewayStableID.isEmpty else { return nil }
        return ExecApprovalPrompt(
            id: approvalId,
            gatewayStableID: normalizedGatewayStableID,
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
        case "watch_request", "push_request", "push_resolved", "watch_resolve", "notification_action":
            return true
        default:
            return false
        }
    }

    private func operatorRouteForExecApproval(
        sourceReason: String,
        expectedOperatorRoute: GatewayNodeSessionRoute? = nil,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async -> GatewaySessionRouteContext?
    {
        guard shouldContinue(), let gatewayStableID = currentExecApprovalGatewayStableID() else {
            return nil
        }
        let routeGeneration = self.gatewayRouteGeneration
        let connected: Bool = if expectedOperatorRoute != nil {
            self.operatorConnected
        } else if Self.shouldUseBackgroundAwareExecApprovalReconnect(
            sourceReason: sourceReason,
            isBackgrounded: self.isBackgrounded)
        {
            await self.ensureOperatorApprovalConnectionForWatchReview(
                timeoutMs: 12000,
                reason: sourceReason)
        } else {
            await self.ensureOperatorApprovalConnection(timeoutMs: 12000)
        }
        guard shouldContinue(), connected,
              self.isCurrentGatewayRoute(generation: routeGeneration, stableID: gatewayStableID)
        else {
            return nil
        }
        let route: GatewayNodeSessionRoute? = if let expectedOperatorRoute {
            expectedOperatorRoute
        } else {
            await self.operatorGateway.currentRoute()
        }
        guard let route,
              shouldContinue(),
              self.isCurrentGatewayRoute(generation: routeGeneration, stableID: gatewayStableID)
        else {
            return nil
        }
        return GatewaySessionRouteContext(
            route: route,
            gatewayStableID: gatewayStableID,
            routeGeneration: routeGeneration)
    }

    private func validatedExecApprovalPushRoute(
        _ push: ExecApprovalNotificationPrompt,
        sourceReason: String,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async -> GatewayNodeSessionRoute?
    {
        guard case let .validated(context) = await validateExecApprovalPushRoute(
            push,
            sourceReason: sourceReason,
            shouldContinue: shouldContinue)
        else {
            return nil
        }
        return context.route
    }

    private func validateExecApprovalPushRoute(
        _ push: ExecApprovalNotificationPrompt,
        sourceReason: String,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async -> ExecApprovalPushRouteValidation
    {
        guard let context = await operatorRouteForExecApproval(
            sourceReason: sourceReason,
            shouldContinue: shouldContinue)
        else {
            return .unavailable
        }
        // Gateways shipped before owner-tagged APNs payloads are still safe when the
        // approval is resolved only through the currently authenticated operator route.
        guard let expectedGatewayDeviceID = push.gatewayDeviceId else {
            return .validated(context)
        }
        do {
            let identity = try await fetchPushRelayGatewayIdentity(ifCurrentRoute: context.route)
            guard shouldContinue(),
                  self.isCurrentGatewayRoute(
                      generation: context.routeGeneration,
                      stableID: context.gatewayStableID)
            else {
                return .unavailable
            }
            guard identity.deviceId == expectedGatewayDeviceID else {
                return .mismatchedOwner
            }
            return .validated(context)
        } catch {
            return .unavailable
        }
    }

    private func fetchExecApprovalPrompt(
        approvalId: String,
        sourceReason: String? = nil,
        expectedOperatorRoute: GatewayNodeSessionRoute? = nil,
        shouldContinue: @MainActor @Sendable () -> Bool = { true }) async -> ExecApprovalPromptFetchOutcome
    {
        let normalizedSourceReason = sourceReason?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fetchReason: String = if let normalizedSourceReason, !normalizedSourceReason.isEmpty {
            normalizedSourceReason
        } else {
            "direct"
        }
        GatewayDiagnostics.log(
            "watch exec approval: fetch prompt start id=\(approvalId) reason=\(fetchReason)")
        guard let context = await operatorRouteForExecApproval(
            sourceReason: fetchReason,
            expectedOperatorRoute: expectedOperatorRoute,
            shouldContinue: shouldContinue)
        else {
            GatewayDiagnostics.log(
                "watch exec approval: fetch prompt operator not connected id=\(approvalId) reason=\(fetchReason)")
            return .failed(message: "operator_not_connected")
        }

        do {
            let payloadJSON = try Self.encodePayload(ExecApprovalGetRequest(id: approvalId))
            let response = try await operatorGateway.request(
                method: "exec.approval.get",
                paramsJSON: payloadJSON,
                timeoutSeconds: 12,
                ifCurrentRoute: context.route)
            guard shouldContinue(), self.currentExecApprovalGatewayStableID() == context.gatewayStableID else {
                return .failed(message: "gateway_changed")
            }
            let details = try JSONDecoder().decode(ExecApprovalGetResponse.self, from: response)
            guard let prompt = Self.makeExecApprovalPrompt(
                from: details,
                gatewayStableID: context.gatewayStableID)
            else {
                GatewayDiagnostics.log(
                    "watch exec approval: fetch prompt invalid payload id=\(approvalId) reason=\(fetchReason)")
                return .failed(message: "invalid_prompt_payload")
            }
            GatewayDiagnostics.log(
                "watch exec approval: fetch prompt loaded id=\(approvalId) reason=\(fetchReason)")
            return .loaded(prompt)
        } catch is CancellationError {
            return .failed(message: "route_changed")
        } catch {
            guard self.currentExecApprovalGatewayStableID() == context.gatewayStableID else {
                return .failed(message: "gateway_changed")
            }
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
        guard let prompt = pendingExecApprovalPrompt else { return }
        guard self.isExecApprovalPromptCurrent(prompt) else {
            self.dismissPendingExecApprovalPrompt()
            return
        }
        let normalizedDecision = decision.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedDecision.isEmpty else { return }

        self.pendingExecApprovalPromptResolving = true
        self.pendingExecApprovalPromptErrorText = nil
        let outcome = await resolveExecApprovalNotificationDecision(
            approvalId: prompt.id,
            decision: normalizedDecision,
            expectedGatewayStableID: prompt.gatewayStableID)
        switch outcome {
        case .resolved, .stale, .unavailable:
            break
        case let .failed(message):
            self.pendingExecApprovalPromptResolving = false
            self.pendingExecApprovalPromptErrorText = message
        }
    }

    private func resolveExecApprovalNotificationDecision(
        approvalId: String,
        decision: String,
        expectedGatewayStableID: String,
        sourceReason: String? = nil) async -> ExecApprovalResolutionOutcome
    {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedDecision = decision.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSourceReason = sourceReason?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolutionReason = (normalizedSourceReason?.isEmpty == false) ? normalizedSourceReason! : "direct"
        guard !normalizedApprovalID.isEmpty, !normalizedDecision.isEmpty else {
            return .failed(message: "Invalid approval request.")
        }
        guard self.currentExecApprovalGatewayStableID() == expectedGatewayStableID else {
            return .failed(message: "This approval belongs to a different gateway.")
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
        guard connected,
              self.currentExecApprovalGatewayStableID() == expectedGatewayStableID,
              let operatorRoute = await operatorGateway.currentRoute()
        else {
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
                timeoutSeconds: 12,
                ifCurrentRoute: operatorRoute)
            guard self.currentExecApprovalGatewayStableID() == expectedGatewayStableID else {
                return .resolved
            }
            await self.removeCurrentGatewayExecApprovalNotifications(
                approvalId: normalizedApprovalID)
            self.clearPendingExecApprovalPromptIfMatches(normalizedApprovalID)
            await self.publishWatchExecApprovalResolved(
                approvalId: normalizedApprovalID,
                gatewayStableID: expectedGatewayStableID,
                decision: OpenClawWatchExecApprovalDecision(rawValue: normalizedDecision),
                source: "iphone")
            return .resolved
        } catch {
            guard self.currentExecApprovalGatewayStableID() == expectedGatewayStableID else {
                return .failed(message: "This approval belongs to a different gateway.")
            }
            if Self.isApprovalNotificationStaleError(error) {
                await self.removeCurrentGatewayExecApprovalNotifications(
                    approvalId: normalizedApprovalID)
                self.clearPendingExecApprovalPromptIfMatches(normalizedApprovalID)
                await self.publishWatchExecApprovalExpired(
                    approvalId: normalizedApprovalID,
                    gatewayStableID: expectedGatewayStableID,
                    reason: .notFound)
                return .stale
            }
            if Self.isApprovalNotificationUnavailableError(error) {
                await self.removeCurrentGatewayExecApprovalNotifications(
                    approvalId: normalizedApprovalID)
                self.clearPendingExecApprovalPromptIfMatches(normalizedApprovalID)
                await self.publishWatchExecApprovalExpired(
                    approvalId: normalizedApprovalID,
                    gatewayStableID: expectedGatewayStableID,
                    reason: .unavailable)
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
        self.clearNotificationPermissionGuidancePromptIfMatches(normalizedApprovalID)
        guard self.pendingExecApprovalPrompt?.id == normalizedApprovalID else { return }
        self.dismissPendingExecApprovalPrompt()
    }

    private func removeCurrentGatewayExecApprovalNotifications(approvalId: String) async {
        let delivered = await notificationCenter.deliveredNotifications()
        var seen = Set<ExecApprovalNotificationPrompt>()
        for snapshot in delivered {
            guard let push = ExecApprovalNotificationBridge.parseRequestedPush(userInfo: snapshot.userInfo),
                  push.approvalId == approvalId,
                  seen.insert(push).inserted,
                  await validatedExecApprovalPushRoute(
                      push,
                      sourceReason: "notification_action") != nil
            else {
                continue
            }
            await ExecApprovalNotificationBridge.removeNotifications(
                for: push,
                notificationCenter: self.notificationCenter)
        }
    }

    private func clearNotificationPermissionGuidancePromptIfMatches(_ approvalId: String) {
        let normalizedApprovalID = approvalId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.pendingNotificationPermissionGuidancePrompt?.approvalId == normalizedApprovalID else { return }
        self.pendingNotificationPermissionGuidancePrompt = nil
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
            if await isGatewayConnected() {
                return true
            }
            do {
                try await Task.sleep(nanoseconds: pollIntervalNs)
            } catch {
                return false
            }
        }
        return await isGatewayConnected()
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
        guard let cfg = activeGatewayConnectConfig else {
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
            let connected = await ensureOperatorApprovalConnection(timeoutMs: timeoutMs)
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

        guard let cfg = activeGatewayConnectConfig else {
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
            deviceAuthGatewayID: cfg.nodeOptions.deviceAuthGatewayID ?? cfg.effectiveStableID,
            allowStoredDeviceAuth: cfg.nodeOptions.allowStoredDeviceAuth)
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
        self.setOperatorConnected(false)
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
        let connected = await waitForOperatorConnection(timeoutMs: remainingWaitMs, pollMs: 200)
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
        let gatewayConnected = await isGatewayConnected()

        var appliedReconnect = false
        if !gatewayConnected {
            guard let cfg = activeGatewayConnectConfig else {
                self.pushWakeLogger.info("Wake no-op wakeId=\(wakeId, privacy: .public): no active gateway config")
                return makeResult(false, false, "no_active_gateway_config")
            }
            let generation = self.gatewayConnectGeneration
            self.pushWakeLogger.info(
                "Wake reconnect begin wakeId=\(wakeId, privacy: .public) stableID=\(cfg.stableID, privacy: .public)")
            self.grantBackgroundReconnectLease(seconds: 30, reason: "wake_\(wakeId)")
            await self.resetGatewaySessionsForForcedReconnect()
            guard generation == self.gatewayConnectGeneration,
                  self.gatewayAutoReconnectEnabled,
                  self.activeGatewayConnectConfig?.hasSameConnectionInputs(as: cfg) == true
            else {
                return makeResult(false, false, "reconnect_superseded")
            }
            self.setOperatorConnected(false)
            self.gatewayConnected = false
            self.gatewayStatusText = "Reconnecting…"
            self.talkMode.updateGatewayConnected(false)
            self.applyGatewayConnectConfig(cfg, expectedGeneration: generation)
            appliedReconnect = true
            self.pushWakeLogger.info("Wake reconnect trigger applied wakeId=\(wakeId, privacy: .public)")

            let connected = await waitForGatewayConnection(timeoutMs: 12000, pollMs: 250)
            guard connected else {
                return makeResult(appliedReconnect, false, "connect_timeout")
            }
            guard generation == self.gatewayConnectGeneration else {
                return makeResult(appliedReconnect, false, "reconnect_superseded")
            }
        } else if BackgroundAliveBeacon.shouldSkipRecentSuccess(
            isGatewayConnected: true,
            now: now,
            lastSuccessAtMs: UserDefaults.standard.object(forKey: Self.backgroundAliveLastSuccessAtMsKey) as? Double)
        {
            return makeResult(false, true, "recent_success")
        }

        let beacon = await publishBackgroundAliveBeacon(trigger: trigger)
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
            let pushTransport = await pushRegistrationManager.usesRelayTransport ? "relay" : "direct"
            let displayName = NodeDisplayName.resolve(
                existing: UserDefaults.standard.string(forKey: "node.displayName"),
                deviceName: UIDevice.current.name,
                interfaceIdiom: UIDevice.current.userInterfaceIdiom)
            let payload = BackgroundAliveBeacon.makePayload(
                trigger: trigger,
                displayName: displayName,
                pushTransport: pushTransport)
            let paramsJSON = try BackgroundAliveBeacon.makeNodeEventRequestPayloadJSON(payload: payload)
            let response = try await nodeGateway.request(
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
    private func refreshWakeWordsFromGateway(
        shouldApply: @escaping @MainActor @Sendable () -> Bool = { true }) async
    {
        do {
            let data = try await operatorGateway.request(
                method: "voicewake.get",
                paramsJSON: "{}",
                timeoutSeconds: 8)
            guard let triggers = VoiceWakePreferences.decodeGatewayTriggers(from: data) else { return }
            guard shouldApply() else { return }
            VoiceWakePreferences.saveTriggerWords(triggers)
        } catch {
            guard shouldApply() else { return }
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
        try Task.checkCancellation()
        let routeGeneration = self.gatewayRouteGeneration
        let gatewayStableID = self.connectedGatewayID
        if await !self.isGatewayConnected() {
            throw NSError(domain: "Gateway", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "Gateway not connected",
            ])
        }
        try Task.checkCancellation()
        guard let gatewayStableID,
              let nodeRoute = await self.nodeGateway.currentRoute(),
              self.isCurrentGatewayRoute(
                  generation: routeGeneration,
                  stableID: gatewayStableID)
        else { throw CancellationError() }
        if let sessionKey, sessionKey != self.mainSessionKey {
            throw CancellationError()
        }
        try Task.checkCancellation()
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
        // Voice Wake suppression cancels the owning command task. Check at the
        // dispatch boundary so a PTT/background takeover cannot send stale audio intent.
        try Task.checkCancellation()
        let sent = await self.nodeGateway.sendEvent(
            event: "voice.transcript",
            payloadJSON: json,
            ifCurrentRoute: nodeRoute)
        guard sent else { throw CancellationError() }
    }

    func handleDeepLink(url: URL) async {
        guard let route = DeepLinkParser.parse(url) else { return }

        switch route {
        case let .agent(link):
            await self.handleAgentDeepLink(link, originalURL: url)
        case let .gateway(link):
            self.stageGatewaySetupLink(link)
        case .dashboard:
            break
        }
    }

    func stageGatewaySetupLink(_ link: GatewayConnectDeepLink) {
        self.pendingGatewaySetupLink = link
        self.gatewaySetupRequestID &+= 1
    }

    func consumePendingGatewaySetupLink() -> GatewayConnectDeepLink? {
        defer { self.pendingGatewaySetupLink = nil }
        return self.pendingGatewaySetupLink
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

    private func sendAgentRequest(
        link: AgentDeepLink,
        expectedNodeRoute: GatewayNodeSessionRoute? = nil) async throws
    {
        if link.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NSError(domain: "DeepLink", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "invalid agent message",
            ])
        }

        #if DEBUG
        if let testAgentRequestHandler {
            try await testAgentRequestHandler(link)
            return
        }
        #endif

        let data = try JSONEncoder().encode(link)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode agent request payload as UTF-8",
            ])
        }
        let requestData = try JSONEncoder().encode(NodeEventRequestPayload(event: "agent.request", payloadJSON: json))
        guard let requestJSON = String(bytes: requestData, encoding: .utf8) else {
            throw NSError(domain: "NodeAppModel", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode agent request node event as UTF-8",
            ])
        }
        _ = try await self.nodeGateway.request(
            method: "node.event",
            paramsJSON: requestJSON,
            timeoutSeconds: Self.agentRequestNodeEventTimeoutSeconds,
            ifCurrentRoute: expectedNodeRoute)
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
        self.synchronizeTalkSessionKey()
    }

    func approvePendingAgentDeepLinkPrompt() async {
        guard let prompt = pendingAgentDeepLinkPrompt else { return }
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
        while let prompt = queuedAgentDeepLinkPrompt {
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
        if let key = defaults.string(forKey: deepLinkKeyUserDefaultsKey), !key.isEmpty {
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
    func _test_handleInvoke(
        _ req: BridgeInvokeRequest,
        gatewayStableID: String? = nil) async -> BridgeInvokeResponse
    {
        await self.handleInvoke(req, gatewayStableID: gatewayStableID)
    }

    func _test_acquirePttVoiceWakeLease(captureId: String) {
        self.acquirePttVoiceWakeLease(for: captureId)
    }

    func _test_releasePttVoiceWakeLease(captureId: String) {
        self.releasePttVoiceWakeLease(for: captureId)
    }

    func _test_setTalkCapturePreparationHandler(_ handler: (() async -> Void)?) {
        self.testTalkCapturePreparationHandler = handler
    }

    func _test_setTalkCaptureStartedHandler(_ handler: (() async -> Void)?) {
        self.testTalkCaptureStartedHandler = handler
    }

    func _test_setChatSessionRoutingRestoreHandler(_ handler: (() async -> Void)?) {
        self.testChatSessionRoutingRestoreHandler = handler
    }

    func _test_hasChatSessionRoutingRestoreTask() -> Bool {
        self.chatSessionRoutingRestoreTask != nil
    }

    func _test_talkPreparationWaiterCount() -> Int {
        self.talkPreparationWaiters.count
    }

    func _test_talkPttCommandEpoch() -> UInt64 {
        self.talkPttCommandEpoch
    }

    func _test_pttVoiceWakeLeaseCaptureIds() -> Set<String> {
        self.pttVoiceWakeLeaseCaptureId.map { [$0] } ?? []
    }

    func _test_invalidateNodePushToTalkRoute() {
        self.invalidateNodePushToTalkRoute()
    }

    func _test_invalidateOperatorTalkRoute() {
        self.invalidateOperatorTalkRoute()
    }

    func _test_applyMainSessionKey(_ key: String?) {
        self.applyMainSessionKey(key)
    }

    func _test_prepareForGatewayConnect(stableID: String) {
        self.prepareForGatewayConnect(stableID: stableID)
    }

    func _test_admitTalkAfterSessionHydration() async {
        if let chatSessionRoutingRestoreTask {
            await chatSessionRoutingRestoreTask.value
        }
        self.chatSessionRoutingRestoreTask = nil
        self.admitTalkAfterSessionHydration()
    }

    static func _test_decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        try self.decodeParams(type, from: json)
    }

    static func _test_encodePayload(_ obj: some Encodable) throws -> String {
        try self.encodePayload(obj)
    }

    func _test_handleCanvasA2UIAction(body: [String: Any]) async {
        await self.handleCanvasA2UIAction(body: body)
    }

    func _test_queuedWatchReplyCount() -> Int {
        self.watchMessageOutbox.queuedCount(kind: .quickReply)
    }

    func _test_setWatchMessageRetryAttempts(_ attempts: Int, messageID: String) {
        self.watchMessageRetryAttempts[messageID] = attempts
    }

    func _test_watchMessageRetryAttempts(messageID: String) -> Int? {
        self.watchMessageRetryAttempts[messageID]
    }

    func _test_queuedWatchChatCommandCount() -> Int {
        self.watchMessageOutbox.queuedCount(kind: .chat)
    }

    func _test_queuedWatchChatCommandIds() -> [String] {
        self.watchMessageOutbox.queuedMessageIDs(kind: .chat)
    }

    func _test_recordWatchPromptRoute(promptID: String, gatewayStableID: String) {
        self.watchMessageOutbox.recordPromptRoute(
            promptID: promptID,
            gatewayStableID: gatewayStableID)
    }

    func _test_setConnectedGatewayID(_ gatewayID: String?) {
        self.connectedGatewayID = gatewayID
    }

    func _test_setAgentRequestHandler(_ handler: @escaping (AgentDeepLink) async throws -> Void) {
        self.testAgentRequestHandler = handler
    }

    static func _test_resetPersistedWatchChatQueueState() {
        WatchMessageOutbox.resetPersistedQueue()
    }

    static func _test_resetPersistedWatchReplyQueueState() {
        WatchMessageOutbox.resetPersistedQueue()
    }

    func _test_setGatewayConnected(_ connected: Bool) {
        self.gatewayConnected = connected
    }

    func _test_setOperatorConnected(_ connected: Bool) {
        self.setOperatorConnected(connected)
    }

    func _test_canPublishAPNsRegistration(usesRelayTransport: Bool = true) async -> Bool {
        await self.canPublishAPNsRegistration(usesRelayTransport: usesRelayTransport)
    }

    nonisolated static func _test_makeWatchChatItems(from raw: [OpenClawKit.AnyCodable]) -> [OpenClawWatchChatItem] {
        self.makeWatchChatItems(from: raw)
    }

    nonisolated static func _test_watchChatReplyText(
        from raw: [OpenClawKit.AnyCodable],
        runId: String,
        submittedText: String,
        submittedAtMs: Int64) -> String?
    {
        self.watchChatReplyText(
            from: raw,
            runId: runId,
            submittedText: submittedText,
            submittedAtMs: submittedAtMs)
    }

    func _test_isGatewayConnected() -> Bool {
        self.gatewayConnected
    }

    func _test_refreshOperatorAdminScopeFromStore() {
        self.refreshOperatorAdminScopeFromStore()
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
        includeAdminScope: Bool = false,
        includeApprovalScope: Bool,
        forceExplicitScopes: Bool = false) -> GatewayConnectOptions
    {
        self.makeOperatorConnectOptions(
            clientId: clientId,
            displayName: displayName,
            includeAdminScope: includeAdminScope,
            includeApprovalScope: includeApprovalScope,
            forceExplicitScopes: forceExplicitScopes)
    }

    func _test_presentExecApprovalPrompt(_ prompt: ExecApprovalPrompt) {
        if self.currentExecApprovalGatewayStableID() == nil {
            self.connectedGatewayID = prompt.gatewayStableID
        }
        self.presentFetchedExecApprovalPrompt(prompt)
    }

    func _test_dismissPendingExecApprovalPrompt() {
        self.dismissPendingExecApprovalPrompt()
    }

    func _test_applyOperatorGatewayConnectionProblem(_ problem: GatewayConnectionProblem) {
        self.applyOperatorGatewayConnectionProblem(problem)
    }

    func _test_clearOperatorGatewayConnectionProblemIfCurrent() {
        self.clearOperatorGatewayConnectionProblemIfCurrent()
    }

    func _test_clearGatewayConnectionProblem() {
        self.clearGatewayConnectionProblem()
    }

    func _test_pendingExecApprovalPrompt() -> ExecApprovalPrompt? {
        self.pendingExecApprovalPrompt
    }

    func _test_pendingNotificationPermissionGuidancePrompt() -> NotificationPermissionGuidancePrompt? {
        self.pendingNotificationPermissionGuidancePrompt
    }

    func _debug_presentNotificationPermissionGuidancePromptForScreenshot() {
        self.resetExecApprovalNotificationGuidanceSuppression()
        self.pendingNotificationPermissionGuidancePrompt =
            NotificationPermissionGuidancePrompt(approvalId: "screenshot-exec-approval")
    }

    func _test_resetExecApprovalNotificationGuidanceSuppression() {
        self.resetExecApprovalNotificationGuidanceSuppression()
    }

    func _test_recordPendingWatchExecApprovalRecoveryID(
        _ approvalId: String,
        gatewayDeviceId: String = "test-gateway-device")
    {
        self.appendPendingWatchExecApprovalRecoveryPush(ExecApprovalNotificationPrompt(
            approvalId: approvalId,
            gatewayDeviceId: gatewayDeviceId))
    }

    func _test_pendingWatchExecApprovalRecoveryIDs() -> [String] {
        self.pendingWatchExecApprovalRecoveryPushes.map(\.approvalId)
    }

    func _test_pendingWatchExecApprovalRecoveryPushes() -> [ExecApprovalNotificationPrompt] {
        self.pendingWatchExecApprovalRecoveryPushes
    }

    func _test_handleExecApprovalResolvedForCurrentGateway(
        approvalId: String,
        recoveryPushGatewayDeviceID: String?) async
    {
        await self.handleExecApprovalResolvedForCurrentGateway(
            approvalId: approvalId,
            recoveryPushGatewayDeviceID: recoveryPushGatewayDeviceID)
    }

    func _test_pendingExecApprovalResolvedPushes() -> [ExecApprovalNotificationPrompt] {
        self.pendingExecApprovalResolvedPushes
    }

    func _test_pendingExecApprovalIDsForWatchRecovery() async -> [String] {
        await self.pendingExecApprovalPushesForWatchRecovery().map(\.approvalId)
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

    nonisolated static func _test_execApprovalEventID(from payload: AnyCodable) -> String? {
        self.execApprovalEventID(from: payload)
    }

    func _test_handleOperatorGatewayServerEvent(_ event: EventFrame) async {
        await self.handleOperatorGatewayServerEvent(event)
    }

    func _test_handleOperatorGatewayServerEvent(
        _ event: EventFrame,
        shouldContinue: @escaping @MainActor @Sendable () -> Bool) async
    {
        await self.handleOperatorGatewayServerEvent(event, shouldContinue: shouldContinue)
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
        gatewayStableID: String = "test-gateway",
        commandText: String,
        allowedDecisions: [String],
        host: String?,
        nodeId: String?,
        agentId: String?,
        expiresAtMs: Int64?) -> ExecApprovalPrompt?
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
                expiresAtMs: expiresAtMs),
            gatewayStableID: gatewayStableID)
    }

    static func _test_currentDeepLinkKey() -> String {
        self.expectedDeepLinkKey()
    }

    nonisolated static func _test_shouldDiscardFailedWatchMessage(
        code: String,
        message: String = "test") -> Bool
    {
        self.shouldDiscardFailedWatchMessage(
            GatewayResponseError(method: "chat.send", code: code, message: message, details: nil))
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

    nonisolated static func _test_usesBootstrapCredential(
        token: String?,
        bootstrapToken: String?,
        password: String?) -> Bool
    {
        self.usesBootstrapCredential(
            token: token,
            bootstrapToken: bootstrapToken,
            password: password)
    }

    nonisolated static func _test_shouldRequestOperatorApprovalScope(
        token: String?,
        password: String?,
        storedOperatorScopes: [String],
        forceTalkPermissionUpgradeRequest: Bool = false) -> Bool
    {
        self.shouldRequestOperatorApprovalScope(
            token: token,
            password: password,
            storedOperatorScopes: storedOperatorScopes,
            forceTalkPermissionUpgradeRequest: forceTalkPermissionUpgradeRequest)
    }

    func _test_shouldRequestStoredOperatorApprovalScope(
        gatewayID: String,
        forceTalkPermissionUpgradeRequest: Bool = false) -> Bool
    {
        self.shouldRequestOperatorApprovalScope(
            gatewayID: gatewayID,
            token: nil,
            password: nil,
            forceTalkPermissionUpgradeRequest: forceTalkPermissionUpgradeRequest)
    }

    nonisolated static func _test_shouldRequestOperatorAdminScope(
        token: String?,
        password: String?,
        storedOperatorScopes: [String],
        forceTalkPermissionUpgradeRequest: Bool = false) -> Bool
    {
        self.shouldRequestOperatorAdminScope(
            token: token,
            password: password,
            storedOperatorScopes: storedOperatorScopes,
            forceTalkPermissionUpgradeRequest: forceTalkPermissionUpgradeRequest)
    }

    func _test_shouldRequestStoredOperatorAdminScope(gatewayID: String) -> Bool {
        self.shouldRequestOperatorAdminScope(gatewayID: gatewayID, token: nil, password: nil)
    }

    func _test_completeSuccessfulGatewayAuthHandoff(
        issuedRoles: Set<String>,
        nodeOptions: GatewayConnectOptions) -> GatewayConnectOptions?
    {
        guard let stableID = activeGatewayConnectConfig?.effectiveStableID else { return nil }
        return self.completeSuccessfulGatewayAuthHandoff(
            stableID: stableID,
            routeGeneration: self.gatewayRouteGeneration,
            issuedRoles: issuedRoles,
            nodeOptions: nodeOptions)
    }

    func _test_currentGatewayReconnectOptions(
        stableID: String,
        fallback: GatewayConnectOptions) -> GatewayConnectOptions
    {
        self.currentGatewayReconnectOptions(stableID: stableID, fallback: fallback)
    }

    func _test_hasGatewayLoopTasks() -> (node: Bool, operator: Bool) {
        (self.nodeGatewayTask != nil, self.operatorGatewayTask != nil)
    }

    func _test_setGatewayLoopTasks(
        node: Task<Void, Never>?,
        operator: Task<Void, Never>? = nil)
    {
        self.nodeGatewayTask = node
        self.operatorGatewayTask = `operator`
    }

    func _test_setGatewaySessionResetTask(_ task: Task<Void, Never>?) {
        self.gatewaySessionResetGeneration &+= 1
        let resetGeneration = self.gatewaySessionResetGeneration
        guard let task else {
            self.gatewaySessionResetTask = nil
            return
        }
        self.gatewaySessionResetTask = Task {
            await task.value
            if self.gatewaySessionResetGeneration == resetGeneration {
                self.gatewaySessionResetTask = nil
            }
        }
    }

    func _test_restartGatewaySessionsAfterForegroundStaleConnection() async {
        await self.restartGatewaySessionsAfterForegroundStaleConnection()
    }
}
#endif
// swiftlint:enable type_body_length file_length
