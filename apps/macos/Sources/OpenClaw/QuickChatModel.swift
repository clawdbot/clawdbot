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

struct QuickChatRoutingTarget: Equatable, Sendable {
    let sessionKey: String
    let agentID: String?
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
        String,
        [OpenClawChatAttachmentPayload]) async throws -> String
    typealias PermissionStatusProvider = @MainActor ([Capability]) async -> [Capability: Bool]
    typealias PermissionGrantProvider = @MainActor ([Capability]) async -> [Capability: Bool]
    typealias ConnectionGateProvider = @MainActor () -> QuickChatConnectionGate

    static let trackedPermissions: [Capability] = [.notifications, .accessibility, .screenRecording]

    var text = "" {
        didSet {
            if !self.text.isEmpty, self.sendState == .sent {
                self.sendState = .idle
            }
            if self.sendTask == nil, let retryIdentity = self.retryIdentity, retryIdentity.draft != self.text {
                self.retryIdentity = nil
            }
        }
    }

    private(set) var sessionKey = ""
    private(set) var sendAgentID: String?
    private(set) var agents: [QuickChatAgentDisplay] = []
    private(set) var defaultAgentID: String?
    private(set) var selectedAgentID: String?
    private(set) var agentDisplay = QuickChatAgentDisplay.placeholder
    private(set) var missingPermissions: [Capability] = []
    private(set) var permissionsDismissedThisSession = false
    private(set) var isGrantingPermissions = false
    private(set) var sendState: QuickChatSendState = .idle
    private(set) var isPresentationActive = false
    /// Route of the most recently accepted send; navigation reads this immutable value
    /// instead of sampling live routing state that an agent switch could move meanwhile.
    private(set) var lastAcceptedRoute: QuickChatRoutingTarget?

    @ObservationIgnored private let sessionKeyProvider: SessionKeyProvider
    @ObservationIgnored private let agentsProvider: AgentsProvider
    @ObservationIgnored private let agentIdentityProvider: AgentIdentityProvider
    @ObservationIgnored private let sendProvider: SendProvider
    @ObservationIgnored private let permissionStatusProvider: PermissionStatusProvider
    @ObservationIgnored private let permissionGrantProvider: PermissionGrantProvider
    @ObservationIgnored private let connectionGateProvider: ConnectionGateProvider
    @ObservationIgnored private var presentationID = UUID()
    @ObservationIgnored private var agentsScope: String?
    @ObservationIgnored private var agentsMainKey: String?
    @ObservationIgnored private var sendTask: Task<String, Error>?
    @ObservationIgnored private var permissionTask: Task<Void, Never>?
    @ObservationIgnored private var permissionPollTask: Task<Void, Never>?
    @ObservationIgnored private var retryIdentity: RetryIdentity?
    @ObservationIgnored private var capturePipelineID: UUID?

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
        sendProvider: @escaping SendProvider = { sessionKey, agentID, message, idempotencyKey, attachments in
            let response = try await GatewayConnection.shared.chatSend(
                sessionKey: sessionKey,
                agentID: agentID,
                message: message,
                thinking: nil,
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
        })
    {
        self.sessionKeyProvider = sessionKeyProvider
        self.agentsProvider = agentsProvider
        self.agentIdentityProvider = agentIdentityProvider
        self.sendProvider = sendProvider
        self.permissionStatusProvider = permissionStatusProvider
        self.permissionGrantProvider = permissionGrantProvider
        self.connectionGateProvider = connectionGateProvider
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
        !self.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !self.sessionKey.isEmpty &&
            self.connectionGate == .available &&
            self.sendState != .sending
    }

    var canCaptureWindow: Bool {
        !self.sessionKey.isEmpty && self.connectionGate == .available && self.sendState != .sending
    }

    var activePresentationID: UUID? {
        self.isPresentationActive ? self.presentationID : nil
    }

    func beginPresentation() -> UUID {
        self.presentationID = UUID()
        self.isPresentationActive = true
        self.sessionKey = ""
        self.sendAgentID = nil
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
              let display = self.agents.first(where: { $0.id == id }),
              let mainKey = self.agentsMainKey
        else { return }
        self.selectedAgentID = id
        self.agentDisplay = display
        let target = Self.routingTarget(scope: self.agentsScope, selectedAgentID: id, mainKey: mainKey)
        self.sessionKey = target.sessionKey
        self.sendAgentID = target.agentID
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

    func send() async -> Bool {
        await self.performSend(messageOverride: nil, attachments: [])
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
        self.sendState = .failed("Couldn't capture that window.")
    }

    /// Pre-pipeline capture failures (enumeration, no candidates). Never clobbers a held
    /// send state; those failures belong to their owning pipeline token.
    func setCaptureFailure() {
        guard self.sendState != .sending else { return }
        self.sendState = .failed("Couldn't capture that window.")
    }

    func sendWindowScreenshot(pipelineID: UUID, data: Data, appName: String, title: String) async -> Bool {
        // Bind the pipeline to the route visible when the user clicked the window; an agent
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
        let message = trimmedDraft.isEmpty
            ? Self.defaultScreenshotCaption(appName: appName, title: title)
            : trimmedDraft
        let fileName = Self.screenshotFileName(appName: appName)

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

    nonisolated static func defaultScreenshotCaption(appName: String, title: String) -> String {
        "Screenshot: \(appName) — \(title)"
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
        self.sessionKey = ""
        self.sendAgentID = nil
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
            self.sessionKey = ""
            self.sendAgentID = nil
            return
        }
        self.agentDisplay = display
        let target = Self.routingTarget(
            scope: self.agentsScope,
            selectedAgentID: selectedID,
            mainKey: result.mainkey)
        self.sessionKey = target.sessionKey
        self.sendAgentID = target.agentID
    }

    private func refreshFallbackIdentity(id: UUID) async {
        let resolvedSessionKey = await self.sessionKeyProvider()
        guard self.isCurrentPresentation(id), !Task.isCancelled else { return }
        self.sessionKey = resolvedSessionKey
        self.sendAgentID = nil
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

    private func performSend(
        messageOverride: String?,
        attachments: [OpenClawChatAttachmentPayload],
        draftOverride: String? = nil,
        continuesCapturePipeline: Bool = false) async -> Bool
    {
        // The capture pipeline captured its draft before detached processing; edits made
        // meanwhile must survive, so the clear-decision compares against that original.
        let draft = draftOverride ?? self.text
        let message = messageOverride ?? draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !self.sessionKey.isEmpty, self.connectionGate == .available else {
            // The capture pipeline unwinds its own held state after this returns false.
            return false
        }
        guard continuesCapturePipeline || self.sendState != .sending else { return false }

        let sessionKey = self.sessionKey
        let agentID = self.sendAgentID
        let idempotencyKey: String
        if let retryIdentity = self.retryIdentity,
           retryIdentity.draft == draft,
           retryIdentity.message == message,
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
                sessionKey: sessionKey,
                agentID: agentID,
                attachments: attachments,
                idempotencyKey: idempotencyKey)
        }
        let task = Task {
            try await self.sendProvider(sessionKey, agentID, message, idempotencyKey, attachments)
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
                self.lastAcceptedRoute = QuickChatRoutingTarget(sessionKey: sessionKey, agentID: agentID)
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

extension String {
    fileprivate var nonEmptyTrimmed: String? {
        let trimmed = self.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
