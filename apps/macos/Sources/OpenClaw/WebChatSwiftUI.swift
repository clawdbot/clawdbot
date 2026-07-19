import AppKit
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog
import QuartzCore
import SwiftUI

private let webChatSwiftLogger = Logger(subsystem: "ai.openclaw", category: "WebChatSwiftUI")
private let webChatThinkingLevelDefaultsKey = "openclaw.webchat.thinkingLevel"
private let webChatVerboseLevelDefaultsKey = "openclaw.webchat.verboseLevel"

private enum WebChatSwiftUILayout {
    static let windowSize = NSSize(width: 960, height: 700)
    static let panelSize = NSSize(width: 480, height: 640)
    static let windowMinSize = NSSize(width: 640, height: 420)
    static let windowFrameAutosaveName = "OpenClawChatWindow"
    static let anchorPadding: CGFloat = 8
}

enum WebChatTracePreferences {
    static func displayOptions(defaults: UserDefaults = .standard) -> OpenClawChatDisplayOptions {
        if let legacyValue = defaults.object(
            forKey: OpenClawChatWindowShell.assistantTraceDefaultsKey) as? Bool
        {
            for key in [
                OpenClawChatWindowShell.assistantReasoningDefaultsKey,
                OpenClawChatWindowShell.assistantToolActivityDefaultsKey,
            ] where defaults.object(forKey: key) == nil {
                defaults.set(legacyValue, forKey: key)
            }
        }

        var options: OpenClawChatDisplayOptions = []
        if defaults.object(forKey: OpenClawChatWindowShell.assistantReasoningDefaultsKey) as? Bool ?? true {
            options.insert(.reasoning)
        }
        if defaults.object(forKey: OpenClawChatWindowShell.assistantToolActivityDefaultsKey) as? Bool ?? true {
            options.insert(.toolActivity)
        }
        return options
    }
}

/// SwiftUI's native toolbar bridge may restore visible title chrome while it
/// installs toolbar items. Keep the full-window chat's titlebar merged.
private final class WebChatWindow: NSWindow {
    override var titleVisibility: NSWindow.TitleVisibility {
        didSet {
            if self.titleVisibility != .hidden {
                self.titleVisibility = .hidden
            }
        }
    }
}

struct MacGatewayChatTransport: OpenClawChatTransport {
    /// Shared across transport value copies so the live view model and its
    /// snapshot observer cannot diverge on the owner of the bare global alias.
    private final class RoutingIdentity: @unchecked Sendable {
        private let lock = NSLock()
        private var defaultGlobalAgentID: String?

        init(defaultGlobalAgentID: String?) {
            self.defaultGlobalAgentID = Self.normalized(defaultGlobalAgentID)
        }

        func update(defaultGlobalAgentID: String?) {
            self.lock.withLock {
                self.defaultGlobalAgentID = Self.normalized(defaultGlobalAgentID)
            }
        }

        func currentAgentID() -> String? {
            self.lock.withLock { self.defaultGlobalAgentID }
        }

        private static func normalized(_ agentID: String?) -> String? {
            let normalized = agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return normalized?.isEmpty == false ? normalized : nil
        }
    }

    typealias SessionTarget = OpenClawChatSessionTarget

    let outboxGatewayID: String?
    private let routingIdentity: RoutingIdentity

    init(outboxGatewayID: String? = nil, defaultGlobalAgentID: String? = nil) {
        self.outboxGatewayID = outboxGatewayID
        self.routingIdentity = RoutingIdentity(defaultGlobalAgentID: defaultGlobalAgentID)
    }

    func updateDefaultGlobalAgentID(_ agentID: String?) {
        self.routingIdentity.update(defaultGlobalAgentID: agentID)
    }

    func sessionTarget(for sessionKey: String) -> SessionTarget {
        OpenClawChatSessionTarget.resolve(
            sessionKey,
            selectedAgentID: self.routingIdentity.currentAgentID(),
            policy: .preserveBareKeys)
    }

    var outboxRequiresSessionRoutingContract: Bool {
        true
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        let target = self.sessionTarget(for: sessionKey)
        return try await GatewayConnection.shared.chatHistory(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
    }

    func requestFullMessage(sessionKey: String, messageID: String) async throws -> OpenClawChatMessage? {
        let target = self.sessionTarget(for: sessionKey)
        let request = try Self.fullMessageRequest(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            messageID: messageID)
        let data = try await GatewayConnection.shared.request(request)
        let result = try JSONDecoder().decode(ChatMessageGetResult.self, from: data)
        guard result.ok, let encodedMessage = result.message else { return nil }
        return try JSONDecoder().decode(
            OpenClawChatMessage.self,
            from: JSONEncoder().encode(encodedMessage))
    }

    static func fullMessageRequest(
        sessionKey: String,
        agentID: String?,
        messageID: String) throws -> OpenClawChatGatewayRequest
    {
        let params = ChatMessageGetParams(
            sessionkey: sessionKey,
            agentid: agentID,
            messageid: messageID,
            maxchars: 500_000)
        let encoded = try JSONEncoder().encode(params)
        return try OpenClawChatGatewayRequest(
            method: "chat.message.get",
            params: JSONDecoder().decode([String: AnyCodable].self, from: encoded),
            timeoutMs: 15000)
    }

    func resolveInlineWidgetResource(
        path: String,
        replacing failedResource: OpenClawChatWidgetResource?) async -> OpenClawChatWidgetResource?
    {
        await OpenClawChatWidgetURLResolver.resolveResource(
            target: path,
            replacing: failedResource,
            currentSurfaceRoutes: {
                let node = await MacNodeModeCoordinator.shared.currentCanvasPluginSurfaceRoute()
                let operatorSurface = await GatewayConnection.shared.canvasPluginSurfaceRoute()
                return (node: node, operatorSurface: operatorSurface)
            },
            // Prefer the local node route; operator rotation keeps chat usable
            // while macOS node mode is disabled or reconnecting.
            refreshNodeSurfaceRoute: { observed in
                await MacNodeModeCoordinator.shared.refreshCanvasPluginSurfaceRoute(replacing: observed?.url)
            },
            refreshOperatorSurfaceRoute: { observed in
                await GatewayConnection.shared.refreshCanvasPluginSurfaceRoute(replacing: observed?.url)
            })
    }

    func resolveInlineWidgetURL(path: String, replacing failedURL: URL?) async -> URL? {
        await self.resolveInlineWidgetResource(
            path: path,
            replacing: failedURL.map { OpenClawChatWidgetResource(url: $0) })?.url
    }

    func listModels() async throws -> [OpenClawChatModelChoice] {
        do {
            let data = try await GatewayConnection.shared.request(OpenClawChatGatewayRequests.modelsList())
            return try OpenClawChatGatewayPayloadCodec.decodeModelChoices(data)
        } catch {
            webChatSwiftLogger.warning(
                "models.list failed; hiding model picker: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.abortRun(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            runID: runId)
        _ = try await GatewayConnection.shared.request(request)
    }

    func listSessions(
        limit: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        let request = OpenClawChatGatewayRequests.sessionsList(
            limit: limit,
            search: search,
            archived: archived)
        let data = try await GatewayConnection.shared.request(request)
        let decoded = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
        let mainSessionKey = await GatewayConnection.shared.cachedMainSessionKey()
        let defaults = decoded.defaults.map {
            OpenClawChatSessionsDefaults(
                modelProvider: $0.modelProvider,
                model: $0.model,
                contextTokens: $0.contextTokens,
                thinkingLevels: $0.thinkingLevels,
                thinkingOptions: $0.thinkingOptions,
                thinkingDefault: $0.thinkingDefault,
                mainSessionKey: mainSessionKey)
        } ?? OpenClawChatSessionsDefaults(
            model: nil,
            contextTokens: nil,
            mainSessionKey: mainSessionKey)
        return OpenClawChatSessionsListResponse(
            ts: decoded.ts,
            path: decoded.path,
            count: decoded.count,
            defaults: defaults,
            sessions: decoded.sessions)
    }

    func listAgents() async throws -> OpenClawChatAgentsListResponse? {
        let data = try await GatewayConnection.shared.request(OpenClawChatGatewayRequests.agentsList())
        let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
        return OpenClawChatAgentsListResponse(
            defaultId: result.defaultid,
            agents: result.agents.map {
                OpenClawChatAgentChoice(
                    id: $0.id,
                    name: $0.name,
                    workspaceGit: $0.workspacegit)
            })
    }

    func listSessionGroups() async throws -> OpenClawChatSessionGroupsResponse? {
        let data = try await GatewayConnection.shared.request(OpenClawChatGatewayRequests.sessionGroupsList())
        return try JSONDecoder().decode(OpenClawChatSessionGroupsResponse.self, from: data)
    }

    func putSessionGroups(names: [String]) async throws -> OpenClawChatSessionGroupsMutationResponse {
        let request = OpenClawChatGatewayRequests.sessionGroupsPut(names: names)
        let data = try await GatewayConnection.shared.request(request)
        return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
    }

    func renameSessionGroup(
        name: String,
        to: String) async throws -> OpenClawChatSessionGroupsMutationResponse
    {
        let request = OpenClawChatGatewayRequests.sessionGroupsRename(name: name, to: to)
        let data = try await GatewayConnection.shared.request(request)
        return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
    }

    func deleteSessionGroup(name: String) async throws -> OpenClawChatSessionGroupsMutationResponse {
        let request = OpenClawChatGatewayRequests.sessionGroupsDelete(name: name)
        let data = try await GatewayConnection.shared.request(request)
        return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
    }

    func setSessionModel(sessionKey: String, model: String?) async throws {
        let target = self.sessionTarget(for: sessionKey)
        _ = try await self.patchSessionModel(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            model: model)
    }

    func patchSessionModel(
        sessionKey: String,
        agentID: String?,
        model: String?) async throws -> OpenClawChatModelPatchResult?
    {
        try await self.patchSessionSettings(
            sessionKey: sessionKey,
            agentID: agentID,
            patch: OpenClawChatSessionSettingsPatch(model: .some(model)))
    }

    func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?
    {
        try await self.patchSessionSettings(
            sessionKey: sessionKey,
            agentID: agentID,
            patch: patch,
            serverLease: nil)
    }

    private func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch,
        serverLease: GatewayConnection.ServerLease?) async throws -> OpenClawChatModelPatchResult?
    {
        let target = OpenClawChatSessionTarget.resolve(
            sessionKey,
            selectedAgentID: self.routingIdentity.currentAgentID(),
            overrideAgentID: agentID,
            policy: .preserveBareKeys)
        let request = Self.sessionSettingsRequest(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            patch: patch)
        let data: Data = if let serverLease {
            try await GatewayConnection.shared.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
                ifCurrentServerLease: serverLease)
        } else {
            try await GatewayConnection.shared.request(request)
        }
        return try JSONDecoder().decode(OpenClawChatModelPatchResult.self, from: data)
    }

    static func sessionSettingsRequest(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch) -> OpenClawChatGatewayRequest
    {
        OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: sessionKey,
            agentID: agentID,
            model: patch.model,
            thinkingLevel: patch.thinkingLevel,
            fastMode: patch.fastMode,
            verboseLevel: patch.verboseLevel)
    }

    func acquireSessionSettingsRouteLease() async -> OpenClawChatSessionSettingsRouteLease? {
        if let outboxGatewayID {
            let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
            guard currentGatewayID == outboxGatewayID else { return nil }
        }
        guard let serverLease = await GatewayConnection.shared.captureServerLease() else { return nil }
        let transport = self
        return OpenClawChatSessionSettingsRouteLease { sessionKey, agentID, patch in
            if let outboxGatewayID = transport.outboxGatewayID {
                try await Self.requireGateway(outboxGatewayID)
            }
            return try await transport.patchSessionSettings(
                sessionKey: sessionKey,
                agentID: agentID,
                patch: patch,
                serverLease: serverLease)
        }
    }

    func setSessionThinking(sessionKey: String, thinkingLevel: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        _ = try await self.patchSessionSettings(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            patch: OpenClawChatSessionSettingsPatch(thinkingLevel: .some(thinkingLevel)))
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        return try await GatewayConnection.shared.chatSend(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
    }

    func sendMessage(
        sessionKey: String,
        agentID: String?,
        expectedSessionRoutingContract: String?,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        if let outboxGatewayID {
            try await Self.requireGateway(outboxGatewayID)
        }
        guard let route = await GatewayConnection.shared.captureRoute(),
              let supportsRoutingContract = await GatewayConnection.shared.supportsServerCapability(
                  .chatSendRoutingContract,
                  ifCurrentRoute: route)
        else { throw OpenClawChatTransportSendError.notDispatched }
        // Outbox replay is capability-gated in acquireOutboxRouteLease. A
        // live send keeps its captured route on older gateways and omits the
        // unsupported atomic routing field.
        let guardedContract = OpenClawChatSessionRoutingContract.expectedValue(
            expectedSessionRoutingContract,
            serverSupportsGuard: supportsRoutingContract)
        return try await GatewayConnection.shared.chatSend(
            sessionKey: target.sessionKey,
            agentID: agentID ?? target.agentID,
            expectedSessionRoutingContract: guardedContract,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
    }

    func acquireOutboxRouteLease() async -> OpenClawChatTransportRouteLeaseResult {
        guard let outboxGatewayID else { return .unavailable(reason: nil) }
        let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
        guard currentGatewayID == outboxGatewayID,
              let route = await GatewayConnection.shared.captureRoute()
        else { return .unavailable(reason: nil) }
        guard let supportsRoutingContract = await GatewayConnection.shared.supportsServerCapability(
            .chatSendRoutingContract,
            ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        guard supportsRoutingContract else {
            return .unavailable(reason: OpenClawChatTransportUpgradeMessage.routingContract)
        }
        guard let routingIdentity = try? await GatewayConnection.shared.sessionRoutingIdentity(
            ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        let routingContract = routingIdentity.contract
        return .available(OpenClawChatTransportRouteLease(
            sendTargetedMessage: { sessionKey, agentID, message, thinking, idempotencyKey, attachments in
                try await Self.requireGateway(outboxGatewayID)
                return try await GatewayConnection.shared.chatSend(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    expectedSessionRoutingContract: routingContract,
                    message: message,
                    thinking: thinking,
                    idempotencyKey: idempotencyKey,
                    attachments: attachments,
                    ifCurrentRoute: route,
                    distinguishPreDispatchRouteChange: true)
            },
            requestTargetedHistory: { sessionKey, agentID in
                try await Self.requireGateway(outboxGatewayID)
                return try await GatewayConnection.shared.chatHistory(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    ifCurrentRoute: route)
            },
            sessionRoutingContract: routingContract))
    }

    private static func requireGateway(_ gatewayID: String) async throws {
        let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
        guard currentGatewayID == gatewayID else {
            throw OpenClawChatTransportSendError.notDispatched
        }
    }

    func synthesizeSpeech(text: String) async throws -> OpenClawChatSpeechClip {
        // Capture the lease before validating the pinned gateway: a gateway
        // switch after validation then fails the request via the lease guard
        // instead of re-routing the text to the newly selected gateway.
        guard let serverLease = await GatewayConnection.shared.captureServerLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        if let outboxGatewayID {
            try await Self.requireGateway(outboxGatewayID)
        }
        return try await MacChatMessageSpeechClient.synthesize(
            text: text,
            serverLease: serverLease)
    }

    var supportsSlashCommandCatalog: Bool {
        true
    }

    func listCommands(sessionKey: String) async throws -> [OpenClawChatCommandChoice] {
        let request = OpenClawChatGatewayRequests.commandsList(
            sessionKey: sessionKey,
            fallbackAgentID: self.routingIdentity.currentAgentID())
        let data = try await GatewayConnection.shared.request(request)
        let decoded = try JSONDecoder().decode(CommandsListResult.self, from: data)
        return decoded.commands.map(OpenClawChatGatewayPayloadCodec.commandChoice)
    }

    func createSession(
        key: String,
        label: String?,
        parentSessionKey: String?,
        worktree: Bool?) async throws -> OpenClawChatCreateSessionResponse
    {
        try await self.createSession(
            key: key,
            label: label,
            agentID: nil,
            parentSessionKey: parentSessionKey,
            worktree: worktree,
            worktreeBaseRef: nil)
    }

    func createSession(
        key: String,
        label: String?,
        agentID explicitAgentID: String?,
        parentSessionKey: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) async throws -> OpenClawChatCreateSessionResponse
    {
        let agentID = explicitAgentID
            ?? OpenClawChatSessionKey.agentID(from: key)
            ?? parentSessionKey.flatMap { OpenClawChatSessionKey.agentID(from: $0) }
            ?? self.routingIdentity.currentAgentID()
        let request = OpenClawChatGatewayRequests.createSession(
            key: key,
            agentID: agentID,
            label: label,
            parentSessionKey: parentSessionKey,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef)
        let data = try await GatewayConnection.shared.request(request)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data)
    }

    func patchSession(
        key: String,
        label: String??,
        category: String??,
        pinned: Bool?,
        archived: Bool?,
        unread: Bool?) async throws
    {
        let target = self.sessionTarget(for: key)
        let request = OpenClawChatGatewayRequests.patchSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            label: label,
            category: category,
            pinned: pinned,
            archived: archived,
            unread: unread)
        _ = try await GatewayConnection.shared.request(request)
    }

    func deleteSession(key: String) async throws {
        let target = self.sessionTarget(for: key)
        let request = OpenClawChatGatewayRequests.deleteSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await GatewayConnection.shared.request(request)
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        try await GatewayConnection.shared.healthOK(timeoutMs: timeoutMs)
    }

    func listQuestions() async throws -> [QuestionRecord] {
        let data = try await GatewayConnection.shared.request(OpenClawChatGatewayRequests.questionList())
        return try JSONDecoder().decode(QuestionListResult.self, from: data).questions
    }

    func getQuestion(id: String) async throws -> QuestionRecord {
        let data = try await GatewayConnection.shared.request(OpenClawChatGatewayRequests.questionGet(id: id))
        return try JSONDecoder().decode(QuestionGetResult.self, from: data).question
    }

    func resolveQuestion(id: String, answers: [String: [String]]) async throws {
        _ = try await GatewayConnection.shared.request(
            OpenClawChatGatewayRequests.resolveQuestion(id: id, answers: answers))
    }

    func cancelQuestion(id: String) async throws {
        _ = try await GatewayConnection.shared.request(
            OpenClawChatGatewayRequests.cancelQuestion(id: id))
    }

    func waitForRunCompletion(
        runId rawRunId: String,
        timeoutMs: Int) async -> OpenClawChatRunObservation
    {
        let runId = rawRunId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !runId.isEmpty,
              let route = await GatewayConnection.shared.captureRoute()
        else { return .unavailable }
        do {
            let request = OpenClawChatGatewayRequests.agentWait(runID: runId, timeoutMs: timeoutMs)
            let data = try await GatewayConnection.shared.request(
                request,
                ifCurrentRoute: route)
            return try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(data)
        } catch {
            webChatSwiftLogger.warning(
                "agent.wait failed runId=\(runId, privacy: .public) "
                    + "error=\(error.localizedDescription, privacy: .public)")
            return .unavailable
        }
    }

    func resetSession(sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.resetSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await GatewayConnection.shared.request(request)
    }

    func compactSession(sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.compactSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        let response = try await GatewayConnection.shared.request(request, retryTransportFailures: false)
        try OpenClawSessionsCompactResponse.requireSuccess(from: response)
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        await MainActor.run {
            WebChatManager.shared.recordActiveSessionKey(sessionKey)
        }
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.subscribeSessionMessages(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        _ = try await GatewayConnection.shared.request(request)
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            let task = Task {
                do {
                    try await GatewayConnection.shared.refresh()
                } catch {
                    webChatSwiftLogger.error("gateway refresh failed \(error.localizedDescription, privacy: .public)")
                }

                let stream = await GatewayConnection.shared.subscribe()
                for await push in stream {
                    if Task.isCancelled {
                        return
                    }
                    if let evt = Self.mapPushToTransportEvent(push) {
                        continuation.yield(evt)
                    }
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    static func mapPushToTransportEvent(_ push: GatewayPush) -> OpenClawChatTransportEvent? {
        switch push {
        case let .snapshot(hello):
            let ok = (try? JSONDecoder().decode(
                OpenClawGatewayHealthOK.self,
                from: JSONEncoder().encode(hello.snapshot.health)))?.ok ?? true
            return .health(ok: ok)

        case let .event(evt):
            return OpenClawChatGatewayPayloadCodec.event(from: evt)

        case .seqGap:
            return .seqGap
        }
    }
}

// MARK: - Window controller

private enum MacChatMessageSpeechError: LocalizedError {
    case invalidRequest
    case emptyAudio
    case unsupportedTransport

    var errorDescription: String? {
        switch self {
        case .invalidRequest:
            "Failed to encode tts.speak request"
        case .emptyAudio:
            "Gateway tts.speak returned empty audio"
        case .unsupportedTransport:
            "Gateway TTS is unavailable for this chat transport"
        }
    }
}

private enum MacChatMessageSpeechClient {
    private static let requestTimeoutMs: Double = 60000

    static func synthesize(
        text: String,
        serverLease: GatewayConnection.ServerLease) async throws -> OpenClawChatSpeechClip
    {
        let encoded = try JSONEncoder().encode(TtsSpeakParams(text: text))
        guard let params = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            throw MacChatMessageSpeechError.invalidRequest
        }
        let responseData = try await GatewayConnection.shared.request(
            method: "tts.speak",
            params: params.mapValues(AnyCodable.init),
            timeoutMs: self.requestTimeoutMs,
            ifCurrentServerLease: serverLease)
        let response = try JSONDecoder().decode(TtsSpeakResult.self, from: responseData)
        guard let audioData = Data(base64Encoded: response.audiobase64), !audioData.isEmpty else {
            throw MacChatMessageSpeechError.emptyAudio
        }
        return OpenClawChatSpeechClip(
            data: audioData,
            outputFormat: response.outputformat,
            mimeType: response.mimetype,
            fileExtension: response.fileextension)
    }
}

@MainActor
private struct MacChatSurface: View {
    @State private var viewModel: OpenClawChatViewModel
    @State private var appState = AppStateStore.shared
    @State private var talkController = TalkModeController.shared
    @State private var audioInputCatalog = MacChatAudioInputCatalog()
    @AppStorage(OpenClawChatWindowShell.assistantReasoningDefaultsKey)
    private var showsReasoning = WebChatTracePreferences.displayOptions().contains(.reasoning)
    @AppStorage(OpenClawChatWindowShell.assistantToolActivityDefaultsKey)
    private var showsToolActivity = WebChatTracePreferences.displayOptions().contains(.toolActivity)

    private let isFullWindow: Bool
    private let userAccent: Color?
    private let speech: OpenClawChatSpeechController
    private let voiceNoteRecorder: OpenClawVoiceNoteRecorder

    init(
        viewModel: OpenClawChatViewModel,
        isFullWindow: Bool,
        userAccent: Color?,
        speech: OpenClawChatSpeechController,
        voiceNoteRecorder: OpenClawVoiceNoteRecorder)
    {
        _viewModel = State(initialValue: viewModel)
        self.isFullWindow = isFullWindow
        self.userAccent = userAccent
        self.speech = speech
        self.voiceNoteRecorder = voiceNoteRecorder
    }

    var body: some View {
        Group {
            if self.isFullWindow {
                OpenClawChatWindowShell(
                    viewModel: self.viewModel,
                    userAccent: self.userAccent,
                    displayOptions: self.displayOptions,
                    emptyAssistantIntro: Self.emptyAssistantIntro,
                    emptyAssistantPrompts: Self.emptyAssistantPrompts,
                    talkControl: self.talkControl,
                    voiceNoteControl: self.voiceNoteControl,
                    speech: self.speech)
            } else {
                OpenClawChatView(
                    viewModel: self.viewModel,
                    showsSessionSwitcher: true,
                    userAccent: self.userAccent,
                    emptyAssistantIntro: Self.emptyAssistantIntro,
                    emptyAssistantPrompts: Self.emptyAssistantPrompts,
                    talkControl: self.talkControl,
                    voiceNoteControl: self.voiceNoteControl,
                    speech: self.speech)
            }
        }
        .onAppear { self.audioInputCatalog.start() }
        .onDisappear { self.audioInputCatalog.stop() }
    }

    private var talkControl: OpenClawChatTalkControl {
        OpenClawChatTalkControl(
            isEnabled: self.appState.talkEnabled,
            isListening: !self.talkController.isPaused && self.talkController.phase == .listening,
            isSpeaking: !self.talkController.isPaused && self.talkController.phase == .speaking,
            isGatewayConnected: self.viewModel.healthOK,
            statusText: self.talkStatusText,
            // macOS exposes live phase but not the runtime's resolved TTS provider.
            // An empty label avoids presenting stale config as current state.
            providerLabel: "",
            level: self.talkController.level,
            partialTranscript: self.talkController.partialTranscript,
            recentTranscript: self.talkController.recentTranscripts,
            inputDevices: self.audioInputCatalog.chatDevices,
            selectedInputDeviceID: self.appState.voiceWakeMicID.isEmpty ? nil : self.appState.voiceWakeMicID,
            selectInputDevice: { deviceID in
                self.audioInputCatalog.select(deviceID, state: self.appState)
            },
            toggle: { sessionKey in
                WebChatManager.shared.recordActiveSessionKey(sessionKey)
                Task {
                    await AppStateStore.shared.setTalkEnabled(!AppStateStore.shared.talkEnabled)
                }
            })
    }

    private var displayOptions: OpenClawChatDisplayOptions {
        var options: OpenClawChatDisplayOptions = []
        if self.showsReasoning { options.insert(.reasoning) }
        if self.showsToolActivity { options.insert(.toolActivity) }
        return options
    }

    private var voiceNoteControl: OpenClawChatVoiceNoteControl {
        OpenClawChatVoiceNoteControl(
            recorder: self.voiceNoteRecorder,
            // Enabled Talk Mode owns microphone admission through teardown,
            // even while its visible phase is thinking or speaking.
            isTalkActive: self.appState.talkEnabled)
    }

    private var talkStatusText: String {
        guard self.appState.talkEnabled else { return String(localized: "Talk mode off") }
        if self.talkController.isPaused { return String(localized: "Talk mode paused") }
        return switch self.talkController.phase {
        case .idle: String(localized: "Talk mode ready")
        case .listening: String(localized: "Listening")
        case .thinking: String(localized: "Thinking")
        case .speaking: String(localized: "Speaking")
        }
    }

    private static let emptyAssistantIntro = String(localized: "What would you like to work on?")
    private static let emptyAssistantPrompts: [OpenClawChatView.StarterPrompt] = [
        .init(
            id: "check-status",
            title: String(localized: "Check OpenClaw status"),
            prompt: String(localized: "Summarize the current OpenClaw status and tell me what needs attention.")),
        .init(
            id: "show-capabilities",
            title: String(localized: "What can you do?"),
            prompt: String(localized: "Show me what you can help with on this Mac right now.")),
        .init(
            id: "catch-up",
            title: String(localized: "Catch me up"),
            prompt: String(localized: "Summarize what happened in my threads since yesterday.")),
    ]

    #if DEBUG
    var _testCapabilities: MacChatSurfaceCapabilities {
        MacChatSurfaceCapabilities(
            hasTalkControl: true,
            hasSpeech: true,
            hasVoiceNoteControl: true,
            displayOptions: self.isFullWindow ? self.displayOptions : [])
    }
    #endif
}

#if DEBUG
struct MacChatSurfaceCapabilities: Equatable {
    let hasTalkControl: Bool
    let hasSpeech: Bool
    let hasVoiceNoteControl: Bool
    let displayOptions: OpenClawChatDisplayOptions
}
#endif

/// Bridges the view model's session switches out of the controller. The view
/// model is constructed before `self`, so the closure targets this box and the
/// controller re-points it after initialization.
@MainActor
private final class WebChatSessionKeyRelay {
    var onChange: ((String) -> Void)?
}

@MainActor
final class WebChatSwiftUIWindowController {
    private let presentation: WebChatPresentation
    private let sessionKey: String
    private let initialActiveAgentID: String?
    private let viewModel: OpenClawChatViewModel
    private let contentController: NSViewController
    private let sessionKeyRelay: WebChatSessionKeyRelay
    private let speech: OpenClawChatSpeechController
    private let voiceNoteRecorder: OpenClawVoiceNoteRecorder
    private var window: NSWindow?
    private var dismissMonitor: Any?
    var onClosed: (() -> Void)?
    var onVisibilityChanged: ((Bool) -> Void)?
    /// Fires when the hosted chat switches sessions in place (sidebar,
    /// composer picker, /new) so the owner can track what this surface shows.
    var onSessionKeyChanged: ((String) -> Void)?

    convenience init(
        sessionKey: String,
        agentID: String? = nil,
        initialDraft: String? = nil,
        presentation: WebChatPresentation)
    {
        // Connection-mode changes tear chat windows down via resetTunnels(),
        // so binding the cache identity at construction stays correct. One
        // store instance backs both the transcript cache and the offline
        // command outbox.
        let context = MacChatTranscriptCache.makeContext()
        self.init(
            sessionKey: sessionKey,
            agentID: agentID,
            initialDraft: initialDraft,
            presentation: presentation,
            cachedRoutingIdentity: context?.routingIdentity,
            store: context?.store)
    }

    convenience init(
        sessionKey: String,
        agentID: String?,
        initialDraft: String? = nil,
        presentation: WebChatPresentation,
        cachedRoutingIdentity: OpenClawChatSessionRoutingIdentity?,
        store: OpenClawChatSQLiteTranscriptCache?)
    {
        let explicitAgentID = WebChatRoute.normalizedAgentID(agentID)
        let effectiveAgentID = Self.effectiveAgentID(
            explicitAgentID: explicitAgentID,
            cachedDefaultAgentID: cachedRoutingIdentity?.defaultAgentID)
        self.init(
            sessionKey: sessionKey,
            initialDraft: initialDraft,
            presentation: presentation,
            transport: MacGatewayChatTransport(
                outboxGatewayID: store?.gatewayID,
                defaultGlobalAgentID: effectiveAgentID),
            initialActiveAgentID: effectiveAgentID,
            explicitAgentID: explicitAgentID,
            initialSessionRoutingContract: cachedRoutingIdentity?.contract,
            transcriptCache: store,
            outbox: store)
    }

    init(
        sessionKey: String,
        initialDraft: String? = nil,
        presentation: WebChatPresentation,
        transport: any OpenClawChatTransport,
        initialActiveAgentID: String? = nil,
        explicitAgentID: String? = nil,
        initialSessionRoutingContract: String? = nil,
        transcriptCache: (any OpenClawChatTranscriptCache)? = nil,
        outbox: (any OpenClawChatCommandOutbox)? = nil)
    {
        self.sessionKey = sessionKey
        self.presentation = presentation
        let initialActiveAgentID = WebChatRoute.normalizedAgentID(initialActiveAgentID)
        self.initialActiveAgentID = initialActiveAgentID
        let voiceNoteRecorder = OpenClawVoiceNoteRecorder()
        voiceNoteRecorder.setCaptureAdmissionHandler {
            !AppStateStore.shared.talkEnabled
        }
        self.voiceNoteRecorder = voiceNoteRecorder
        let speech = OpenClawChatSpeechController { text in
            guard let transport = transport as? MacGatewayChatTransport else {
                throw MacChatMessageSpeechError.unsupportedTransport
            }
            return try await transport.synthesizeSpeech(text: text)
        }
        self.speech = speech
        let sessionKeyRelay = WebChatSessionKeyRelay()
        self.sessionKeyRelay = sessionKeyRelay
        let vm = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: initialActiveAgentID,
            sessionRoutingContract: initialSessionRoutingContract,
            attachmentOwnerIsActive: { voiceNoteRecorder.ownsPendingChatAttachment },
            transcriptCache: transcriptCache,
            outbox: outbox,
            initialThinkingLevel: Self.persistedThinkingLevel(),
            initialVerboseLevel: Self.persistedVerboseLevel(),
            onSessionChanged: { key in
                sessionKeyRelay.onChange?(key)
            },
            onThinkingPreferenceChanged: { level in
                if let level {
                    UserDefaults.standard.set(level, forKey: webChatThinkingLevelDefaultsKey)
                } else {
                    UserDefaults.standard.removeObject(forKey: webChatThinkingLevelDefaultsKey)
                }
            },
            onVerbosePreferenceChanged: { level in
                Self.persistVerbosePreference(level)
            })
        if let initialDraft,
           !initialDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            vm.input = initialDraft
        }
        self.viewModel = vm
        let explicitAgentID = WebChatRoute.normalizedAgentID(explicitAgentID)
        Task { @MainActor [weak vm] in
            let pushes = await GatewayConnection.shared.subscribe()
            for await push in pushes {
                guard let vm else { return }
                guard case .snapshot = push else { continue }
                let route = await GatewayConnection.shared.captureRoute()
                let routingIdentity: OpenClawChatSessionRoutingIdentity? = if let route {
                    try? await GatewayConnection.shared.sessionRoutingIdentity(
                        ifCurrentRoute: route)
                } else {
                    nil
                }
                if let routingIdentity {
                    // An explicit navigation agent owns this window; gateway
                    // default refreshes only supply the fallback route.
                    let effectiveAgentID = Self.effectiveAgentID(
                        explicitAgentID: explicitAgentID,
                        cachedDefaultAgentID: routingIdentity.defaultAgentID)
                    (transport as? MacGatewayChatTransport)?
                        .updateDefaultGlobalAgentID(effectiveAgentID)
                    if let store = transcriptCache as? OpenClawChatSQLiteTranscriptCache,
                       store.gatewayID == MacChatTranscriptCache.currentGatewayID(),
                       let persistedIdentity = OpenClawChatSessionRoutingIdentity(
                           contract: routingIdentity.contract)
                    {
                        await store.storeSessionRoutingIdentity(persistedIdentity)
                    }
                    vm.syncDeliveryIdentity(
                        activeAgentId: effectiveAgentID,
                        sessionRoutingContract: routingIdentity.contract)
                }
            }
        }
        let accent = Self.color(fromHex: AppStateStore.shared.seamColorHex)
        switch presentation {
        case .window:
            // Full window: native split-view shell with sessions sidebar and
            // toolbar pickers bridged into the NSToolbar.
            let hosting = NSHostingController(rootView: MacChatSurface(
                viewModel: vm,
                isFullWindow: true,
                userAccent: accent,
                speech: speech,
                voiceNoteRecorder: voiceNoteRecorder))
            self.contentController = hosting
        case .panel:
            // Anchored compact chat panel: single-column chat.
            let hosting = NSHostingController(rootView: MacChatSurface(
                viewModel: vm,
                isFullWindow: false,
                userAccent: accent,
                speech: speech,
                voiceNoteRecorder: voiceNoteRecorder))
            self.contentController = Self.makePanelContentController(hosting: hosting)
        }
        self.window = Self.makeWindow(for: presentation, contentViewController: self.contentController)
        sessionKeyRelay.onChange = { [weak self] key in
            self?.onSessionKeyChanged?(key)
        }
    }

    deinit {}

    var isVisible: Bool {
        self.window?.isVisible ?? false
    }

    func applyDraftIfEmpty(_ draft: String?) {
        guard self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let draft,
              !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }
        self.viewModel.input = draft
    }

    func show() {
        guard let window else { return }
        self.ensureWindowSize()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.onVisibilityChanged?(true)
    }

    func presentAnchored(anchorProvider: () -> NSRect?) {
        guard case .panel = self.presentation, let window else { return }
        self.installDismissMonitor()
        let target = self.reposition(using: anchorProvider)

        if !self.isVisible {
            let start = target.offsetBy(dx: 0, dy: 8)
            window.setFrame(start, display: true)
            window.alphaValue = 0
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                window.animator().setFrame(target, display: true)
                window.animator().alphaValue = 1
            }
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }

        self.onVisibilityChanged?(true)
    }

    func close() {
        self.window?.orderOut(nil)
        self.onVisibilityChanged?(false)
        self.onClosed?()
        self.removeDismissMonitor()
    }

    @discardableResult
    private func reposition(using anchorProvider: () -> NSRect?) -> NSRect {
        guard let window else { return .zero }
        guard let anchor = anchorProvider() else {
            let frame = WindowPlacement.topRightFrame(
                size: WebChatSwiftUILayout.panelSize,
                padding: WebChatSwiftUILayout.anchorPadding)
            window.setFrame(frame, display: false)
            return frame
        }
        let screen = NSScreen.screens.first { screen in
            screen.frame.contains(anchor.origin) || screen.frame.contains(NSPoint(x: anchor.midX, y: anchor.midY))
        } ?? NSScreen.main
        let bounds = (screen?.visibleFrame ?? .zero).insetBy(
            dx: WebChatSwiftUILayout.anchorPadding,
            dy: WebChatSwiftUILayout.anchorPadding)
        let frame = WindowPlacement.anchoredBelowFrame(
            size: WebChatSwiftUILayout.panelSize,
            anchor: anchor,
            padding: WebChatSwiftUILayout.anchorPadding,
            in: bounds)
        window.setFrame(frame, display: false)
        return frame
    }

    private func installDismissMonitor() {
        if ProcessInfo.processInfo.isRunningTests {
            return
        }
        guard self.dismissMonitor == nil, self.window != nil else { return }
        self.dismissMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown])
        { [weak self] _ in
            guard let self, let win = self.window else { return }
            let pt = NSEvent.mouseLocation
            if !win.frame.contains(pt) {
                self.close()
            }
        }
    }

    private func removeDismissMonitor() {
        OverlayPanelFactory.clearGlobalEventMonitor(&self.dismissMonitor)
    }

    static func persistedThinkingLevel(defaults: UserDefaults = .standard) -> String? {
        let stored = defaults.string(forKey: webChatThinkingLevelDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard let stored,
              ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"].contains(stored)
        else {
            return nil
        }
        return stored
    }

    static func persistedVerboseLevel(defaults: UserDefaults = .standard) -> String? {
        let stored = defaults.string(forKey: webChatVerboseLevelDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return OpenClawChatViewModel.verboseLevelOptions.contains(stored ?? "") ? stored : nil
    }

    static func persistVerbosePreference(_ level: String?, defaults: UserDefaults = .standard) {
        if let level {
            defaults.set(level, forKey: webChatVerboseLevelDefaultsKey)
        } else {
            defaults.removeObject(forKey: webChatVerboseLevelDefaultsKey)
        }
    }

    static func effectiveAgentID(
        explicitAgentID: String?,
        cachedDefaultAgentID: String?) -> String?
    {
        WebChatRoute.normalizedAgentID(explicitAgentID)
            ?? WebChatRoute.normalizedAgentID(cachedDefaultAgentID)
    }

    private static func makeWindow(
        for presentation: WebChatPresentation,
        contentViewController: NSViewController) -> NSWindow
    {
        switch presentation {
        case .window:
            let window = WebChatWindow(
                contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.windowSize),
                styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                backing: .buffered,
                defer: false)
            window.title = "OpenClaw Chat"
            window.contentViewController = contentViewController
            // Attaching an NSHostingController resets scene bridging to `.all`;
            // opt back into toolbar items only so SwiftUI cannot restore the title.
            (contentViewController as? NSHostingController<MacChatSurface>)?
                .sceneBridgingOptions = [.toolbars]
            window.isReleasedWhenClosed = false
            // Keep the SwiftUI toolbar controls, but merge their unified row
            // with the traffic lights instead of stacking it below a title band.
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.toolbarStyle = .unified
            window.titlebarSeparatorStyle = .none
            window.isMovableByWindowBackground = true
            window.center()
            window.setFrameAutosaveName(WebChatSwiftUILayout.windowFrameAutosaveName)
            WindowPlacement.ensureOnScreen(window: window, defaultSize: WebChatSwiftUILayout.windowSize)
            window.minSize = WebChatSwiftUILayout.windowMinSize
            return window
        case .panel:
            let panel = WebChatPanel(
                contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.panelSize),
                styleMask: [.borderless],
                backing: .buffered,
                defer: false)
            panel.level = .statusBar
            panel.hidesOnDeactivate = true
            panel.hasShadow = true
            panel.isMovable = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.titleVisibility = .hidden
            panel.titlebarAppearsTransparent = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.contentViewController = contentViewController
            panel.becomesKeyOnlyIfNeeded = true
            panel.contentView?.wantsLayer = true
            panel.contentView?.layer?.backgroundColor = NSColor.clear.cgColor
            panel.setFrame(
                WindowPlacement.topRightFrame(
                    size: WebChatSwiftUILayout.panelSize,
                    padding: WebChatSwiftUILayout.anchorPadding),
                display: false)
            return panel
        }
    }

    private static func makePanelContentController(
        hosting: NSHostingController<MacChatSurface>) -> NSViewController
    {
        let controller = NSViewController()
        let effectView = NSVisualEffectView()
        effectView.material = .sidebar
        effectView.blendingMode = .withinWindow
        effectView.state = .active
        effectView.wantsLayer = true
        effectView.layer?.cornerCurve = .continuous
        let cornerRadius: CGFloat = 16
        effectView.layer?.cornerRadius = cornerRadius
        effectView.layer?.masksToBounds = true
        effectView.layer?.backgroundColor = NSColor.clear.cgColor

        effectView.translatesAutoresizingMaskIntoConstraints = true
        effectView.autoresizingMask = [.width, .height]
        let rootView = effectView

        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        hosting.view.wantsLayer = true
        hosting.view.layer?.cornerCurve = .continuous
        hosting.view.layer?.cornerRadius = cornerRadius
        hosting.view.layer?.masksToBounds = true
        hosting.view.layer?.backgroundColor = NSColor.clear.cgColor

        controller.addChild(hosting)
        effectView.addSubview(hosting.view)
        controller.view = rootView

        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: effectView.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: effectView.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: effectView.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: effectView.bottomAnchor),
        ])

        return controller
    }

    private func ensureWindowSize() {
        guard case .window = self.presentation, let window else { return }
        let current = window.frame.size
        let min = WebChatSwiftUILayout.windowMinSize
        if current.width < min.width || current.height < min.height {
            let frame = WindowPlacement.centeredFrame(size: WebChatSwiftUILayout.windowSize)
            window.setFrame(frame, display: false)
        }
    }

    private static func color(fromHex raw: String?) -> Color? {
        ColorHexSupport.color(fromHex: raw)
    }

    #if DEBUG
    var _testWindow: NSWindow? {
        self.window
    }

    var _testSceneBridgingOptions: NSHostingSceneBridgingOptions? {
        (self.contentController as? NSHostingController<MacChatSurface>)?.sceneBridgingOptions
    }

    var _testChatCapabilities: MacChatSurfaceCapabilities? {
        if let hosting = self.contentController as? NSHostingController<MacChatSurface> {
            return hosting.rootView._testCapabilities
        }
        return self.contentController.children
            .compactMap { $0 as? NSHostingController<MacChatSurface> }
            .first?.rootView._testCapabilities
    }

    var _testActiveAgentID: String? {
        self.initialActiveAgentID
    }

    var _testDraft: String {
        self.viewModel.input
    }
    #endif
}
