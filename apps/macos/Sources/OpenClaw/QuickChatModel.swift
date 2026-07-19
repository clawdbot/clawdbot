import Foundation
import Observation
import OpenClawChatUI
import OpenClawIPC
import OpenClawKit
import OpenClawProtocol

enum QuickChatAgentAvatar: Equatable, Sendable {
    case none
    case image(Data)
}

struct QuickChatAgentDisplay: Equatable, Sendable, Identifiable {
    static let maximumAvatarBytes = 6_000_000
    static let placeholder = QuickChatAgentDisplay(id: "", name: "Agent", emoji: nil, avatar: .none)

    let id: String
    let name: String
    let emoji: String?
    let avatar: QuickChatAgentAvatar
    let monogram: String
    let tintHue: Double

    init(id: String, name: String, emoji: String?, avatar: QuickChatAgentAvatar = .none) {
        self.id = id
        self.name = name
        self.emoji = emoji
        self.avatar = avatar
        let monogramSource = name.isEmpty ? id : name
        self.monogram = String(monogramSource.prefix(1)).uppercased()
        self.tintHue = Self.stableTintHue(for: id)
    }

    init(summary: AgentSummary) {
        let emoji = (summary.identity?["emoji"]?.value as? String)?.nonEmptyTrimmed
        let avatarRendered = summary.identity?["avatarUrl"]?.value as? String
        self.init(
            id: summary.id,
            name: summary.name ?? summary.id,
            emoji: emoji,
            avatar: Self.avatar(fromRendered: avatarRendered))
    }

    static func avatar(fromRendered rawValue: String?) -> QuickChatAgentAvatar {
        guard let rawValue = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rawValue.isEmpty
        else { return .none }

        if rawValue.lowercased().hasPrefix("data:") {
            guard let comma = rawValue.firstIndex(of: ",") else { return .none }
            let metadata = rawValue[..<comma].lowercased()
            guard metadata.hasSuffix(";base64") else { return .none }
            let payload = rawValue[rawValue.index(after: comma)...]
            let maximumEncodedBytes = ((Self.maximumAvatarBytes + 2) / 3) * 4 + 4
            guard payload.utf8.count <= maximumEncodedBytes,
                  let data = Data(base64Encoded: String(payload), options: .ignoreUnknownCharacters),
                  data.count <= Self.maximumAvatarBytes
            else { return .none }
            return .image(data)
        }

        // Remote http(s) avatar URLs are deliberately not fetched: a gateway-supplied URL
        // must not turn this app into a blind request primitive against local networks.
        // Local avatar files already arrive as data URIs; everything else falls back.
        return .none
    }

    private static func stableTintHue(for id: String) -> Double {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in id.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return Double(hash % 360) / 360
    }
}

struct QuickChatRoutingTarget: Equatable, Hashable, Sendable {
    let sessionKey: String
    let agentID: String?
}

struct QuickChatSessionTargetOverride: Equatable, Hashable, Sendable {
    let key: String
    let displayName: String
}

enum QuickChatConnectionGate: Equatable {
    case available
    case unconfigured
    case paused
    case disconnected
}

enum QuickChatSendState: Equatable {
    case idle
    case sending
    case sent
    case failed(String)
}

@MainActor
@Observable
final class QuickChatModel {
    private struct RetryIdentity {
        let draft: String
        let message: String
        let thinking: String?
        let sessionKey: String
        let agentID: String?
        let attachments: [OpenClawChatAttachmentPayload]
        let idempotencyKey: String
    }

    typealias SessionKeyProvider = @MainActor () async -> String
    typealias AgentsProvider = @MainActor () async throws -> AgentsListResult
    typealias AgentIdentityProvider = @MainActor (String) async throws -> QuickChatAgentDisplay
    typealias SendProvider = @MainActor (
        String,
        String?,
        String,
        String?,
        String,
        [OpenClawChatAttachmentPayload]) async throws -> String
    typealias PermissionStatusProvider = @MainActor ([Capability]) async -> [Capability: Bool]
    typealias PermissionGrantProvider = @MainActor ([Capability]) async -> [Capability: Bool]
    typealias ConnectionGateProvider = @MainActor () -> QuickChatConnectionGate
    typealias FrontmostAppNameProvider = @MainActor () -> String
    typealias TextContextCaptureProvider = @MainActor () async -> QuickChatTextContextCaptureOutcome
    typealias ModelControlsProvider = @MainActor (
        QuickChatRoutingTarget) async throws -> QuickChatModelControlSnapshot
    typealias ModelPatchProvider = @MainActor (
        QuickChatRoutingTarget,
        String?) async throws -> OpenClawChatModelPatchResult?

    static let trackedPermissions: [Capability] = [.notifications, .accessibility, .screenRecording]

    var text = "" {
        didSet {
            if !self.text.isEmpty, self.sendState == .sent {
                self.sendState = .idle
            }
            if self.sendTask == nil, let retryIdentity = self.retryIdentity, retryIdentity.draft != self.text {
                self.retryIdentity = nil
            }
            if !self.isDictating, !self.isStartingDictation, self.dictationTextSession == nil {
                self.dictationSelectionRange = nil
            }
        }
    }

    private(set) var sessionKey = ""
    private(set) var sendAgentID: String?
    private(set) var targetSessionOverride: QuickChatSessionTargetOverride?
    private(set) var agents: [QuickChatAgentDisplay] = []
    private(set) var defaultAgentID: String?
    private(set) var selectedAgentID: String?
    private(set) var agentDisplay = QuickChatAgentDisplay.placeholder
    private(set) var missingPermissions: [Capability] = []
    private(set) var permissionsDismissedThisSession = false
    private(set) var isGrantingPermissions = false
    private(set) var sendState: QuickChatSendState = .idle
    private(set) var isPresentationActive = false
    private(set) var frontmostAppName = String(localized: "focused app")
    private(set) var textContext: QuickChatTextContext?
    private(set) var isCapturingTextContext = false
    private(set) var textContextCaptureMessage: String?
    private(set) var isStartingDictation = false
    private(set) var isDictating = false
    private(set) var dictationStatusMessage: String?
    private(set) var dictationSelectionRange: NSRange?
    private(set) var modelChoices: [OpenClawChatModelChoice] = []
    private(set) var currentSessionModelSelectionID: String?
    private(set) var currentSessionThinkingLevel: String?
    private(set) var thinkingOptions = QuickChatModelControlLogic.baseThinkingOptions
    private(set) var selectedModelSelectionID: String?
    private(set) var selectedThinkingLevel: String?
    private(set) var modelDefaultProvider: String?
    private(set) var isLoadingModelControls = false
    private(set) var isUpdatingModel = false
    private(set) var modelControlStatusMessage: String?
    /// Route of the most recently accepted send; navigation reads this immutable value
    /// instead of sampling live routing state that an agent switch could move meanwhile.
    private(set) var lastAcceptedRoute: QuickChatRoutingTarget?
    private(set) var lastAcceptedIdempotencyKey: String?

    @ObservationIgnored private let sessionKeyProvider: SessionKeyProvider
    @ObservationIgnored private let agentsProvider: AgentsProvider
    @ObservationIgnored private let agentIdentityProvider: AgentIdentityProvider
    @ObservationIgnored private let sendProvider: SendProvider
    @ObservationIgnored private let permissionStatusProvider: PermissionStatusProvider
    @ObservationIgnored private let permissionGrantProvider: PermissionGrantProvider
    @ObservationIgnored private let connectionGateProvider: ConnectionGateProvider
    @ObservationIgnored private let frontmostAppNameProvider: FrontmostAppNameProvider
    @ObservationIgnored private let textContextCaptureProvider: TextContextCaptureProvider
    @ObservationIgnored private let modelControlsProvider: ModelControlsProvider
    @ObservationIgnored private let modelPatchProvider: ModelPatchProvider
    /// Invoked with the snapshotted route just before a send is dispatched, for every
    /// send path (text and capture); wires the reply consumer's pre-bind.
    @ObservationIgnored var onSendDispatched: ((QuickChatRoutingTarget) -> Void)?
    @ObservationIgnored private var presentationID = UUID()
    @ObservationIgnored private var agentsScope: String?
    @ObservationIgnored private var agentsMainKey: String?
    @ObservationIgnored private var baseRoutingTarget: QuickChatRoutingTarget?
    @ObservationIgnored private var sendTask: Task<String, Error>?
    @ObservationIgnored private var permissionTask: Task<Void, Never>?
    @ObservationIgnored private var permissionPollTask: Task<Void, Never>?
    @ObservationIgnored private var retryIdentity: RetryIdentity?
    @ObservationIgnored private var capturePipelineID: UUID?
    @ObservationIgnored private var textContextCaptureID: UUID?
    @ObservationIgnored private var textContextCaptureTask: Task<Void, Never>?
    @ObservationIgnored private var dictationTextSession: QuickChatDictationTextSession?
    @ObservationIgnored private var modelControlsTask: Task<Void, Never>?
    @ObservationIgnored private var modelControlsRequestID = UUID()
    @ObservationIgnored private var modelPatchTask: Task<OpenClawChatModelPatchResult?, Error>?
    @ObservationIgnored private var modelPatchTarget: QuickChatRoutingTarget?
    @ObservationIgnored private var modelPatchSelectionID: String?
    @ObservationIgnored private var modelPatchRequestID = UUID()
    @ObservationIgnored private var appliedModelSelections: [QuickChatRoutingTarget: String] = [:]

    init(
        sessionKeyProvider: @escaping SessionKeyProvider = {
            await GatewayConnection.shared.mainSessionKey()
        },
        agentsProvider: @escaping AgentsProvider = {
            try await GatewayConnection.shared.agentsList()
        },
        agentIdentityProvider: @escaping AgentIdentityProvider = { sessionKey in
            let identity = try await GatewayConnection.shared.agentIdentity(sessionKey: sessionKey)
            let name = identity.name?.nonEmptyTrimmed ?? identity.agentid
            let emoji = identity.emoji?.nonEmptyTrimmed
            return QuickChatAgentDisplay(
                id: identity.agentid,
                name: name,
                emoji: emoji,
                avatar: QuickChatAgentDisplay.avatar(fromRendered: identity.avatar))
        },
        sendProvider: @escaping SendProvider = { sessionKey, agentID, message, thinking, idempotencyKey, attachments in
            let response = try await GatewayConnection.shared.chatSend(
                sessionKey: sessionKey,
                agentID: agentID,
                message: message,
                thinking: thinking,
                idempotencyKey: idempotencyKey,
                attachments: attachments)
            return response.status
        },
        permissionStatusProvider: @escaping PermissionStatusProvider = { capabilities in
            await PermissionManager.status(capabilities)
        },
        permissionGrantProvider: @escaping PermissionGrantProvider = { capabilities in
            await PermissionManager.ensure(capabilities, interactive: true)
        },
        connectionGateProvider: @escaping ConnectionGateProvider = {
            let appState = AppStateStore.shared
            if appState.connectionMode == .unconfigured { return .unconfigured }
            if appState.isPaused { return .paused }
            if ControlChannel.shared.state != .connected { return .disconnected }
            return .available
        },
        frontmostAppNameProvider: @escaping FrontmostAppNameProvider = {
            QuickChatFocusedTextCaptureService.frontmostApplicationName()
        },
        textContextCaptureProvider: @escaping TextContextCaptureProvider = {
            await QuickChatFocusedTextCaptureService.capture()
        },
        modelControlsProvider: @escaping ModelControlsProvider = { target in
            let transport = MacGatewayChatTransport(defaultGlobalAgentID: target.agentID)
            async let models = transport.listModels()
            async let sessions = transport.listSessions(limit: 200, search: target.sessionKey, archived: false)
            async let agents = GatewayConnection.shared.agentsList()
            return try await QuickChatModelControlLogic.snapshot(
                target: target,
                models: models,
                sessions: sessions,
                agents: agents)
        },
        modelPatchProvider: @escaping ModelPatchProvider = { target, model in
            let transport = MacGatewayChatTransport(defaultGlobalAgentID: target.agentID)
            return try await transport.patchSessionSettings(
                sessionKey: target.sessionKey,
                agentID: target.agentID,
                patch: OpenClawChatSessionSettingsPatch(model: .some(model)))
        })
    {
        self.sessionKeyProvider = sessionKeyProvider
        self.agentsProvider = agentsProvider
        self.agentIdentityProvider = agentIdentityProvider
        self.sendProvider = sendProvider
        self.permissionStatusProvider = permissionStatusProvider
        self.permissionGrantProvider = permissionGrantProvider
        self.connectionGateProvider = connectionGateProvider
        self.frontmostAppNameProvider = frontmostAppNameProvider
        self.textContextCaptureProvider = textContextCaptureProvider
        self.modelControlsProvider = modelControlsProvider
        self.modelPatchProvider = modelPatchProvider
    }

    var connectionGate: QuickChatConnectionGate {
        self.connectionGateProvider()
    }

    var connectionStatusMessage: String? {
        switch self.connectionGate {
        case .available: nil
        case .unconfigured: "Not configured"
        case .paused: "OpenClaw is paused"
        case .disconnected: "Gateway disconnected"
        }
    }

    var shouldShowPermissionStrip: Bool {
        !self.permissionsDismissedThisSession && !self.missingPermissions.isEmpty
    }

    var canSend: Bool {
        let hasPendingOverrideState = self.selectedModelSelectionID != nil || self.selectedThinkingLevel != nil
        return (!self.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || self.textContext != nil) &&
            !self.sessionKey.isEmpty &&
            self.connectionGate == .available &&
            !self.isCapturingTextContext &&
            !self.isStartingDictation &&
            !self.isUpdatingModel &&
            (!hasPendingOverrideState || !self.isLoadingModelControls) &&
            self.isSelectedThinkingLevelSupported &&
            self.sendState != .sending
    }

    var canCaptureWindow: Bool {
        !self.sessionKey.isEmpty &&
            self.connectionGate == .available &&
            !self.isGrantingPermissions &&
            !self.isCapturingTextContext &&
            !self.isStartingDictation &&
            !self.isDictating &&
            !self.isUpdatingModel &&
            self.sendState != .sending
    }

    var canCaptureTextContext: Bool {
        self.canCaptureWindow && !self.isCapturingTextContext
    }

    var canSelectRecentSession: Bool {
        !self.sessionKey.isEmpty &&
            self.connectionGate == .available &&
            !self.isGrantingPermissions &&
            !self.isCapturingTextContext &&
            !self.isStartingDictation &&
            !self.isDictating &&
            !self.isUpdatingModel &&
            self.sendState != .sending
    }

    var canToggleDictation: Bool {
        self.isDictating || self.isStartingDictation || (
            !self.sessionKey.isEmpty &&
                self.connectionGate == .available &&
                !self.isGrantingPermissions &&
                !self.isCapturingTextContext &&
                !self.isUpdatingModel &&
                self.sendState != .sending)
    }

    var messagePlaceholder: String {
        if let targetSessionOverride {
            return "Reply in \(targetSessionOverride.displayName)"
        }
        return "Message \(self.agentDisplay.name)"
    }

    var routingTarget: QuickChatRoutingTarget? {
        guard !self.sessionKey.isEmpty else { return nil }
        return QuickChatRoutingTarget(sessionKey: self.sessionKey, agentID: self.sendAgentID)
    }

    var activePresentationID: UUID? {
        self.isPresentationActive ? self.presentationID : nil
    }

    func beginPresentation() -> UUID {
        self.presentationID = UUID()
        self.isPresentationActive = true
        self.sessionKey = ""
        self.sendAgentID = nil
        self.frontmostAppName = self.frontmostAppNameProvider()
        self.textContext = nil
        self.textContextCaptureMessage = nil
        self.cancelTextContextCapture()
        self.resetDictationState()
        self.cancelModelControlRefresh()
        self.appliedModelSelections.removeAll()
        self.selectedModelSelectionID = nil
        self.selectedThinkingLevel = nil
        self.currentSessionModelSelectionID = nil
        self.currentSessionThinkingLevel = nil
        self.modelControlStatusMessage = nil
        self.targetSessionOverride = nil
        self.baseRoutingTarget = nil
        // The cached list stays displayable, but routing metadata must wait for the fresh
        // contract: selecting from a stale scope/mainKey could target an obsolete session.
        self.agentsScope = nil
        self.agentsMainKey = nil
        if self.sendTask == nil { self.sendState = .idle }
        self.startPermissionPolling(id: self.presentationID)
        return self.presentationID
    }

    func refreshForPresentation(id: UUID) async {
        guard self.isCurrentPresentation(id) else { return }
        async let permissionStatus = self.permissionStatusProvider(Self.trackedPermissions)

        let agentsResult: Result<AgentsListResult, Error>
        do {
            agentsResult = try await .success(self.agentsProvider())
        } catch {
            agentsResult = .failure(error)
        }

        let status = await permissionStatus
        guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
        self.applyPermissionStatus(status)

        switch agentsResult {
        case let .success(result):
            self.applyAgentsList(result)
        case .failure:
            await self.refreshFallbackIdentity(id: id)
        }
    }

    func selectAgent(_ id: String) {
        // A held or in-flight send is already routed; switching now would reroute a
        // screenshot captured for the previously selected agent.
        guard self.sendState != .sending,
              !self.isUpdatingModel,
              let display = self.agents.first(where: { $0.id == id }),
              let mainKey = self.agentsMainKey
        else { return }
        // Agent and recent-session targeting are mutually exclusive: keeping both would
        // make the avatar advertise one destination while sends go somewhere else.
        self.targetSessionOverride = nil
        self.selectedAgentID = id
        self.agentDisplay = display
        let target = Self.routingTarget(scope: self.agentsScope, selectedAgentID: id, mainKey: mainKey)
        self.baseRoutingTarget = target
        self.applyRoutingTarget()
    }

    func selectSessionOverride(_ target: QuickChatSessionTargetOverride?) {
        guard self.sendState != .sending, !self.isUpdatingModel else { return }
        self.targetSessionOverride = target
        self.applyRoutingTarget()
    }

    func dismissPermissionsForSession() {
        self.permissionsDismissedThisSession = true
    }

    func grantMissingPermissions() {
        let capabilities = self.missingPermissions
        guard !capabilities.isEmpty, !self.isGrantingPermissions else { return }
        let id = self.presentationID
        self.permissionTask?.cancel()
        self.isGrantingPermissions = true
        self.permissionTask = Task { [weak self] in
            guard let self else { return }
            _ = await self.permissionGrantProvider(capabilities)
            guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
            await self.recheckPermissions(id: id)
            guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
            self.isGrantingPermissions = false
            self.permissionTask = nil
        }
    }

    func prepareDictation(selection: NSRange) -> Bool {
        guard self.canToggleDictation, !self.isDictating, !self.isStartingDictation else { return false }
        self.dictationTextSession = QuickChatDictationTextSession(
            baseText: self.text,
            replacementRange: selection)
        self.dictationSelectionRange = nil
        self.dictationStatusMessage = nil
        self.isStartingDictation = true
        return true
    }

    func dictationDidStart() {
        guard self.isStartingDictation else { return }
        self.isStartingDictation = false
        self.isDictating = true
    }

    func applyDictationTranscript(_ transcript: String) {
        guard self.isDictating, let dictationTextSession else { return }
        let update = dictationTextSession.update(transcript: transcript)
        self.dictationSelectionRange = update.selection
        self.text = update.text
    }

    func stopDictation() {
        self.isStartingDictation = false
        self.isDictating = false
        self.dictationTextSession = nil
    }

    func failDictation(message: String) {
        self.stopDictation()
        self.dictationStatusMessage = message
    }

    func selectThinkingLevel(_ level: String?) {
        let normalized = level?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let selection = normalized?.isEmpty == false ? normalized : nil
        guard selection != self.selectedThinkingLevel else { return }
        self.selectedThinkingLevel = selection
        self.modelControlStatusMessage = nil
        self.retryIdentity = nil
    }

    func selectModel(_ selectionID: String) {
        guard self.canUseModelControls, !self.isUpdatingModel, let target = self.routingTarget else { return }
        let normalized = selectionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized == OpenClawChatViewModel.defaultModelSelectionID ||
            self.modelChoices.contains(where: { $0.selectionID == normalized })
        else { return }
        guard normalized != self.selectedModelSelectionID else { return }
        let patchDecision = QuickChatModelControlLogic.modelPatchDecision(
            selectionID: normalized,
            appliedSelectionID: self.appliedModelSelections[target],
            currentSessionSelectionID: self.currentSessionModelSelectionID)
        self.selectedModelSelectionID = normalized
        self.modelControlStatusMessage = nil
        if patchDecision != .none {
            self.retryIdentity = nil
        }
        self.startSelectedModelPatchIfNeeded(selectionID: normalized, target: target)
    }

    func send() async -> Bool {
        await self.performSend(messageOverride: nil, attachments: [])
    }

    func captureFocusedAppText() {
        guard self.canCaptureTextContext, self.isPresentationActive else { return }
        let captureID = UUID()
        let presentationID = self.presentationID
        self.textContextCaptureID = captureID
        self.isCapturingTextContext = true
        self.textContextCaptureMessage = nil
        self.textContextCaptureTask?.cancel()
        self.textContextCaptureTask = Task { [weak self] in
            guard let self else { return }
            let outcome = await self.textContextCaptureProvider()
            guard self.isCurrentPresentation(presentationID),
                  self.textContextCaptureID == captureID,
                  !Task.isCancelled
            else { return }
            self.textContextCaptureID = nil
            self.textContextCaptureTask = nil
            self.isCapturingTextContext = false
            switch outcome {
            case let .captured(context):
                self.replaceTextContext(context)
            case let .failed(message):
                self.textContextCaptureMessage = message
            case .cancelled:
                break
            }
        }
    }

    func replaceTextContext(_ context: QuickChatTextContext) {
        self.textContext = context
        self.textContextCaptureMessage = nil
        self.retryIdentity = nil
    }

    func clearTextContext() {
        self.textContext = nil
        self.retryIdentity = nil
    }

    /// Holds the send state for the whole capture pipeline so typing/Return cannot race
    /// the screenshot send. Returns an ownership token (nil when a send is already active);
    /// detached processing can outlive cancellation, so every later pipeline mutation must
    /// present this token or it could reset a newer pipeline's held state.
    func beginCapturePipeline() -> UUID? {
        guard self.sendState != .sending else { return nil }
        let id = UUID()
        self.capturePipelineID = id
        self.sendState = .sending
        return id
    }

    func cancelCapturePipeline(_ id: UUID) {
        guard self.capturePipelineID == id else { return }
        self.capturePipelineID = nil
        if self.sendState == .sending, self.sendTask == nil {
            self.sendState = .idle
        }
    }

    func failCapturePipeline(_ id: UUID) {
        guard self.capturePipelineID == id else { return }
        self.capturePipelineID = nil
        self.sendState = .failed(String(localized: "Couldn't capture that image."))
    }

    /// Pre-pipeline capture failures (enumeration, no candidates). Never clobbers a held
    /// send state; those failures belong to their owning pipeline token.
    func setCaptureFailure() {
        guard self.sendState != .sending else { return }
        self.sendState = .failed(String(localized: "Couldn't capture that image."))
    }

    func sendCapturedImage(
        pipelineID: UUID,
        data: Data,
        label: String,
        fileName: String) async -> Bool
    {
        // Bind the pipeline to the route visible when the user completed the selection; an agent
        // switch or re-presentation during processing must drop the capture, not reroute it.
        guard self.capturePipelineID == pipelineID,
              let presentationID = self.activePresentationID
        else { return false }
        let sessionKey = self.sessionKey
        let agentID = self.sendAgentID
        guard !sessionKey.isEmpty else {
            self.cancelCapturePipeline(pipelineID)
            return false
        }
        let draft = self.text
        let trimmedDraft = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let baseMessage = trimmedDraft.isEmpty ? String(localized: "Screenshot: \(label)") : trimmedDraft
        let textContext = self.textContext
        let message = Self.assembleMessage(draft: baseMessage, context: textContext)

        let attachment: OpenClawChatAttachmentPayload
        do {
            attachment = try await Task.detached(priority: .userInitiated) {
                let processed = try ChatImageProcessor.processForUpload(data: data)
                return OpenClawChatAttachmentPayload(
                    type: "file",
                    mimeType: "image/jpeg",
                    fileName: fileName,
                    content: processed.base64EncodedString())
            }.value
        } catch {
            self.failCapturePipeline(pipelineID)
            return false
        }

        guard self.capturePipelineID == pipelineID,
              self.activePresentationID == presentationID,
              self.sessionKey == sessionKey,
              self.sendAgentID == agentID,
              !Task.isCancelled
        else {
            self.cancelCapturePipeline(pipelineID)
            return false
        }
        let accepted = await self.performSend(
            messageOverride: message,
            attachments: [attachment],
            draftOverride: draft,
            textContextOverride: textContext,
            continuesCapturePipeline: true)
        if self.capturePipelineID == pipelineID {
            self.capturePipelineID = nil
            // performSend left the held state untouched only on its early guard failure.
            if !accepted, self.sendState == .sending, self.sendTask == nil {
                self.sendState = .idle
            }
        }
        return accepted
    }

    nonisolated static func routingTarget(
        scope: String?,
        selectedAgentID: String,
        mainKey: String) -> QuickChatRoutingTarget
    {
        if scope?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "global" {
            return QuickChatRoutingTarget(sessionKey: "global", agentID: selectedAgentID)
        }
        // Canonical agent keys already encode ownership; a redundant agentId is rejected.
        return QuickChatRoutingTarget(
            sessionKey: "agent:\(selectedAgentID):\(mainKey)",
            agentID: nil)
    }

    nonisolated static func assembleMessage(draft: String, context: QuickChatTextContext?) -> String {
        let trimmedDraft = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let context else { return trimmedDraft }
        let contextLabel = String(localized: "Context from \(context.appName) — \(context.windowTitle)")
        let contextBlock = "[\(contextLabel)]\n\(context.text)"
        return trimmedDraft.isEmpty ? contextBlock : "\(trimmedDraft)\n\n\(contextBlock)"
    }

    nonisolated static func routingTarget(
        override: QuickChatSessionTargetOverride?,
        base: QuickChatRoutingTarget) -> QuickChatRoutingTarget
    {
        guard let override else { return base }
        // sessions.list preserves the bare global sentinel. It needs the same explicit
        // agent owner as the selected base route when session scope is global.
        let agentID = override.key.lowercased() == "global" ? base.agentID : nil
        return QuickChatRoutingTarget(sessionKey: override.key, agentID: agentID)
    }

    nonisolated static func screenshotFileName(appName: String) -> String {
        let scalarValues = appName.lowercased().unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.contains(scalar) ? Character(String(scalar)) : "-"
        }
        let sanitized = String(scalarValues)
            .split(separator: "-", omittingEmptySubsequences: true)
            .joined(separator: "-")
        return "window-\(sanitized.isEmpty ? "screenshot" : sanitized).jpg"
    }

    func endPresentation() {
        self.isPresentationActive = false
        self.presentationID = UUID()
        // A quick bar target is presentation-scoped. Never carry a stale recent session
        // into the next invocation where the compact UI no longer explains that choice.
        self.targetSessionOverride = nil
        self.baseRoutingTarget = nil
        self.sessionKey = ""
        self.sendAgentID = nil
        // Captured AX text is presentation-scoped: hiding the bar must erase it so a
        // later recipient can never inherit stale focused-app context.
        self.clearTextContext()
        self.textContextCaptureMessage = nil
        self.cancelTextContextCapture()
        self.resetDictationState()
        // Model patches are persistent session mutations. Let an accepted selection
        // settle even though its presentation-scoped controls are being discarded.
        self.cancelModelControlRefresh()
        self.appliedModelSelections.removeAll()
        self.selectedModelSelectionID = nil
        self.selectedThinkingLevel = nil
        self.currentSessionModelSelectionID = nil
        self.currentSessionThinkingLevel = nil
        self.modelControlStatusMessage = nil
        // A dispatched chat.send may already be accepted; cancelling and retrying with a new UUID can duplicate it.
        self.cancelPermissionTask()
        self.cancelPermissionPolling()
    }

    func cancelAllTasks() {
        self.sendTask?.cancel()
        self.sendTask = nil
        self.retryIdentity = nil
        self.cancelPermissionTask()
        self.cancelPermissionPolling()
        self.cancelTextContextCapture()
        self.cancelModelControlRefresh()
        self.resetDictationState()
        if self.sendState == .sending { self.sendState = .idle }
    }

    private func applyAgentsList(_ result: AgentsListResult) {
        let displays = result.agents.map(QuickChatAgentDisplay.init(summary:))
        let selectedID: String? = if let selectedAgentID,
                                     displays.contains(where: { $0.id == selectedAgentID })
        {
            selectedAgentID
        } else if displays.contains(where: { $0.id == result.defaultid }) {
            result.defaultid
        } else {
            displays.first?.id
        }

        self.agents = displays
        self.defaultAgentID = result.defaultid
        self.selectedAgentID = selectedID
        self.agentsScope = result.scope.value as? String
        self.agentsMainKey = result.mainkey

        guard let selectedID,
              let display = displays.first(where: { $0.id == selectedID })
        else {
            self.agentDisplay = .placeholder
            self.baseRoutingTarget = nil
            self.sessionKey = ""
            self.sendAgentID = nil
            return
        }
        self.agentDisplay = display
        let target = Self.routingTarget(
            scope: self.agentsScope,
            selectedAgentID: selectedID,
            mainKey: result.mainkey)
        self.baseRoutingTarget = target
        self.applyRoutingTarget()
    }

    private func refreshFallbackIdentity(id: UUID) async {
        let resolvedSessionKey = await self.sessionKeyProvider()
        guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
        self.baseRoutingTarget = QuickChatRoutingTarget(sessionKey: resolvedSessionKey, agentID: nil)
        self.applyRoutingTarget()
        self.agents = []
        self.defaultAgentID = nil
        self.selectedAgentID = nil
        self.agentsScope = nil
        self.agentsMainKey = nil
        self.agentDisplay = .placeholder

        do {
            let display = try await self.agentIdentityProvider(resolvedSessionKey)
            guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
            self.agentDisplay = display
            self.agents = [display]
            self.defaultAgentID = display.id
            self.selectedAgentID = display.id
        } catch {
            // The fallback session remains sendable even when its optional identity cannot load.
        }
    }

    private func applyRoutingTarget() {
        guard let baseRoutingTarget else {
            self.sessionKey = ""
            self.sendAgentID = nil
            self.cancelModelControlRefresh()
            return
        }
        let target = Self.routingTarget(override: self.targetSessionOverride, base: baseRoutingTarget)
        let previousTarget = self.routingTarget
        self.sessionKey = target.sessionKey
        self.sendAgentID = target.agentID
        if previousTarget != target {
            // Explicit overrides survive target changes, but the target's underlying
            // session state must be read again before the compact control claims a value.
            self.currentSessionModelSelectionID = nil
            self.currentSessionThinkingLevel = nil
            self.modelDefaultProvider = nil
            self.thinkingOptions = []
        }
        self.refreshModelControls(for: target)
    }

    private func performSend(
        messageOverride: String?,
        attachments: [OpenClawChatAttachmentPayload],
        draftOverride: String? = nil,
        textContextOverride: QuickChatTextContext? = nil,
        continuesCapturePipeline: Bool = false) async -> Bool
    {
        guard let presentationID = self.activePresentationID else { return false }
        // The capture pipeline captured its draft before detached processing; edits made
        // meanwhile must survive, so the clear-decision compares against that original.
        let draft = draftOverride ?? self.text
        let textContext = textContextOverride ?? self.textContext
        let message = messageOverride ?? Self.assembleMessage(draft: draft, context: textContext)
        guard !message.isEmpty, !self.sessionKey.isEmpty, self.connectionGate == .available else {
            // The capture pipeline unwinds its own held state after this returns false.
            return false
        }
        guard continuesCapturePipeline || self.sendState != .sending else { return false }

        let sessionKey = self.sessionKey
        let agentID = self.sendAgentID
        let route = QuickChatRoutingTarget(sessionKey: sessionKey, agentID: agentID)
        let selectedModelSelectionID = self.selectedModelSelectionID
        guard await self.applySelectedModelIfNeeded(
            to: route,
            selectionID: selectedModelSelectionID)
        else { return false }
        guard !Task.isCancelled,
              self.isCurrentPresentation(presentationID),
              self.routingTarget == route,
              self.connectionGate == .available,
              self.isSelectedThinkingLevelSupported,
              continuesCapturePipeline || self.sendState != .sending
        else { return false }
        let thinking = self.selectedThinkingLevel
        self.lastAcceptedIdempotencyKey = nil
        // Pre-bind the reply consumer for every send path (text and screenshots): a
        // fast turn must not emit frames before the reply view model starts listening.
        self.onSendDispatched?(route)
        let idempotencyKey: String
        if let retryIdentity = self.retryIdentity,
           retryIdentity.draft == draft,
           retryIdentity.message == message,
           retryIdentity.thinking == thinking,
           retryIdentity.sessionKey == sessionKey,
           retryIdentity.agentID == agentID,
           retryIdentity.attachments == attachments
        {
            idempotencyKey = retryIdentity.idempotencyKey
        } else {
            idempotencyKey = UUID().uuidString
            self.retryIdentity = RetryIdentity(
                draft: draft,
                message: message,
                thinking: thinking,
                sessionKey: sessionKey,
                agentID: agentID,
                attachments: attachments,
                idempotencyKey: idempotencyKey)
        }
        let task = Task {
            try await self.sendProvider(sessionKey, agentID, message, thinking, idempotencyKey, attachments)
        }
        self.sendTask = task
        self.sendState = .sending
        do {
            let status = try await task.value
            self.sendTask = nil
            switch ChatSendStatus.acceptance(of: status) {
            case .terminalFailure:
                self.retryIdentity = nil
                let normalized = ChatSendStatus.normalized(status)
                self.sendState = self.text == draft
                    ? .failed("Message was not accepted (\(normalized)).")
                    : .idle
                return false
            case .terminalSuccess, .inFlight:
                self.retryIdentity = nil
                self.lastAcceptedRoute = route
                self.lastAcceptedIdempotencyKey = idempotencyKey
                if self.textContext == textContext {
                    self.textContext = nil
                }
                if self.text == draft {
                    self.sendState = .sent
                    self.text = ""
                } else {
                    self.sendState = .idle
                }
                return true
            }
        } catch is CancellationError {
            self.sendTask = nil
            self.retryIdentity = nil
            self.sendState = .idle
            return false
        } catch {
            self.sendTask = nil
            self.sendState = self.text == draft ? .failed(error.localizedDescription) : .idle
            return false
        }
    }

    private func startPermissionPolling(id: UUID) {
        guard !ProcessInfo.processInfo.isRunningTests else { return }
        self.permissionPollTask?.cancel()
        // TCC posts no change notifications; poll only while the bar is presented.
        self.permissionPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, self.isCurrentPresentation(id), !Task.isCancelled else { return }
                await self.recheckPermissions(id: id)
            }
        }
    }

    private func cancelPermissionPolling() {
        self.permissionPollTask?.cancel()
        self.permissionPollTask = nil
    }

    private func cancelPermissionTask() {
        self.permissionTask?.cancel()
        self.permissionTask = nil
        self.isGrantingPermissions = false
    }

    private func cancelTextContextCapture() {
        self.textContextCaptureTask?.cancel()
        self.textContextCaptureTask = nil
        self.textContextCaptureID = nil
        self.isCapturingTextContext = false
    }

    private func recheckPermissions(id: UUID) async {
        let status = await self.permissionStatusProvider(Self.trackedPermissions)
        guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
        self.applyPermissionStatus(status)
    }

    private func applyPermissionStatus(_ status: [Capability: Bool]) {
        self.missingPermissions = Self.trackedPermissions.filter { status[$0] != true }
    }

    private func isCurrentPresentation(_ id: UUID) -> Bool {
        self.isPresentationActive && self.presentationID == id
    }
}

extension QuickChatModel {
    var canUseModelControls: Bool {
        !self.sessionKey.isEmpty &&
            self.connectionGate == .available &&
            !self.isGrantingPermissions &&
            !self.isCapturingTextContext &&
            !self.isStartingDictation &&
            !self.isLoadingModelControls &&
            !self.isUpdatingModel &&
            self.sendState != .sending
    }

    var isSelectedThinkingLevelSupported: Bool {
        QuickChatModelControlLogic.validatedThinkingSelection(
            self.selectedThinkingLevel,
            options: self.thinkingOptions) == self.selectedThinkingLevel
    }

    var modelPickerSections: ChatModelPickerSections {
        ChatModelPickerStore.sections(
            choices: self.modelChoices,
            favorites: [],
            recents: [],
            defaultProvider: self.modelDefaultProvider)
    }

    var displayedModelSelectionID: String? {
        self.selectedModelSelectionID ?? self.currentSessionModelSelectionID
    }

    var displayedThinkingLevel: String? {
        self.selectedThinkingLevel ?? self.currentSessionThinkingLevel
    }

    var modelControlLabel: String {
        let automatic = String(localized: "Auto")
        let model = QuickChatModelControlLogic.displayName(
            selectionID: self.displayedModelSelectionID,
            models: self.modelChoices,
            automaticLabel: automatic)
        let thinking = self.thinkingOptions.first(where: { $0.id == self.displayedThinkingLevel })?.label
            ?? self.displayedThinkingLevel
            ?? automatic
        return String(localized: "\(model) · \(thinking)")
    }

    private func refreshModelControls(for target: QuickChatRoutingTarget) {
        guard self.isPresentationActive else { return }
        let requestID = UUID()
        self.modelControlsRequestID = requestID
        self.modelControlsTask?.cancel()
        self.isLoadingModelControls = true
        self.modelControlsTask = Task { [weak self] in
            guard let self else { return }
            do {
                let snapshot = try await self.modelControlsProvider(target)
                guard !Task.isCancelled,
                      self.modelControlsRequestID == requestID,
                      self.routingTarget == target
                else { return }
                self.modelChoices = snapshot.models
                self.currentSessionModelSelectionID = snapshot.currentModelSelectionID
                self.currentSessionThinkingLevel = snapshot.currentThinkingLevel
                self.thinkingOptions = snapshot.thinkingOptions
                self.modelDefaultProvider = snapshot.defaultProvider
                self.modelControlStatusMessage = self.isSelectedThinkingLevelSupported
                    ? nil
                    : String(localized: "Selected reasoning is unavailable for this target.")
            } catch is CancellationError {
                return
            } catch {
                guard self.modelControlsRequestID == requestID,
                      self.routingTarget == target
                else { return }
                self.modelControlStatusMessage = String(localized: "Couldn't load model settings.")
            }
            guard self.modelControlsRequestID == requestID else { return }
            self.isLoadingModelControls = false
            self.modelControlsTask = nil
        }
    }

    private func startSelectedModelPatchIfNeeded(selectionID: String, target: QuickChatRoutingTarget) {
        Task { [weak self] in
            _ = await self?.applySelectedModelIfNeeded(to: target, selectionID: selectionID)
        }
    }

    private func applySelectedModelIfNeeded(
        to target: QuickChatRoutingTarget,
        selectionID: String?) async -> Bool
    {
        let appliedSelectionID = self.appliedModelSelections[target]
        switch QuickChatModelControlLogic.modelPatchDecision(
            selectionID: selectionID,
            appliedSelectionID: appliedSelectionID,
            currentSessionSelectionID: self.routingTarget == target
                ? self.currentSessionModelSelectionID
                : nil)
        {
        case .none:
            return true
        case let .patch(model):
            // Model is a session setting and persists through sessions.patch. Reasoning
            // remains a per-message override passed only to chat.send below.
            if let task = self.modelPatchTask,
               self.modelPatchTarget == target,
               self.modelPatchSelectionID == selectionID
            {
                return await self.finishModelPatch(
                    task,
                    requestID: self.modelPatchRequestID,
                    target: target,
                    selectionID: selectionID)
            }

            self.modelPatchTask?.cancel()
            self.modelControlsRequestID = UUID()
            self.modelControlsTask?.cancel()
            self.modelControlsTask = nil
            self.isLoadingModelControls = false
            let requestID = UUID()
            self.modelPatchRequestID = requestID
            self.modelPatchTarget = target
            self.modelPatchSelectionID = selectionID
            self.isUpdatingModel = true
            let task = Task {
                try await self.modelPatchProvider(target, model)
            }
            self.modelPatchTask = task
            return await self.finishModelPatch(
                task,
                requestID: requestID,
                target: target,
                selectionID: selectionID)
        }
    }

    private func finishModelPatch(
        _ task: Task<OpenClawChatModelPatchResult?, Error>,
        requestID: UUID,
        target: QuickChatRoutingTarget,
        selectionID: String?) async -> Bool
    {
        do {
            let result = try await task.value
            var refreshedSnapshot: QuickChatModelControlSnapshot?
            var refreshFailed = false
            if result?.thinkingLevels == nil, self.routingTarget == target {
                do {
                    refreshedSnapshot = try await self.modelControlsProvider(target)
                } catch {
                    refreshFailed = true
                }
            }
            guard self.modelPatchRequestID == requestID else { return false }
            if self.isPresentationActive, let selectionID {
                self.appliedModelSelections[target] = selectionID
            }
            if self.routingTarget == target {
                self.modelControlsRequestID = UUID()
                self.modelControlsTask?.cancel()
                self.modelControlsTask = nil
                self.isLoadingModelControls = false
                if let refreshedSnapshot {
                    self.modelChoices = refreshedSnapshot.models
                    self.currentSessionModelSelectionID = refreshedSnapshot.currentModelSelectionID
                    self.currentSessionThinkingLevel = refreshedSnapshot.currentThinkingLevel
                    self.modelDefaultProvider = refreshedSnapshot.defaultProvider
                } else if let model = result?.model {
                    self.currentSessionModelSelectionID = QuickChatModelControlLogic.selectionID(
                        model: model,
                        provider: result?.modelProvider)
                } else if selectionID != OpenClawChatViewModel.defaultModelSelectionID {
                    self.currentSessionModelSelectionID = selectionID
                } else {
                    self.currentSessionModelSelectionID = nil
                }
                // The refreshedSnapshot branch above already seeded currentSessionThinkingLevel
                // from the authoritative fetch, so when the patch response omits both
                // thinkingLevels and thinkingLevel both branches here are skipped and the
                // refreshed level survives; these only override when the patch itself
                // returned a level.
                if result?.thinkingLevels != nil {
                    self.currentSessionThinkingLevel = result?.thinkingLevel
                } else if let thinkingLevel = result?.thinkingLevel {
                    self.currentSessionThinkingLevel = thinkingLevel
                }
                let thinkingOptions = result?.thinkingLevels ?? refreshedSnapshot?.thinkingOptions ?? []
                self.thinkingOptions = thinkingOptions
                if !refreshFailed {
                    let validated = QuickChatModelControlLogic.validatedThinkingSelection(
                        self.selectedThinkingLevel,
                        options: thinkingOptions)
                    if validated != self.selectedThinkingLevel {
                        self.selectedThinkingLevel = validated
                        self.retryIdentity = nil
                    }
                }
                self.modelControlStatusMessage = refreshFailed
                    ? String(localized: "Couldn't load model settings.")
                    : nil
            }
            self.clearModelPatchState(requestID: requestID)
            return true
        } catch is CancellationError {
            self.clearModelPatchState(requestID: requestID)
            return false
        } catch {
            guard self.modelPatchRequestID == requestID else { return false }
            if self.routingTarget == target {
                self.modelControlStatusMessage = String(localized: "Couldn't change the model.")
            }
            self.clearModelPatchState(requestID: requestID)
            return false
        }
    }

    private func clearModelPatchState(requestID: UUID) {
        guard self.modelPatchRequestID == requestID else { return }
        self.isUpdatingModel = false
        self.modelPatchTask = nil
        self.modelPatchTarget = nil
        self.modelPatchSelectionID = nil
    }

    private func cancelModelControlRefresh() {
        self.modelControlsRequestID = UUID()
        self.modelControlsTask?.cancel()
        self.modelControlsTask = nil
        self.isLoadingModelControls = false
    }

    private func resetDictationState() {
        self.isStartingDictation = false
        self.isDictating = false
        self.dictationStatusMessage = nil
        self.dictationSelectionRange = nil
        self.dictationTextSession = nil
    }
}

extension String {
    fileprivate var nonEmptyTrimmed: String? {
        let trimmed = self.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
