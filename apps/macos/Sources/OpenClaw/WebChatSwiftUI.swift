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

private enum WebChatSwiftUILayout {
    static let windowSize = NSSize(width: 960, height: 700)
    static let panelSize = NSSize(width: 480, height: 640)
    static let windowMinSize = NSSize(width: 640, height: 420)
    static let windowFrameAutosaveName = "OpenClawChatWindow"
    static let anchorPadding: CGFloat = 8
}

struct MacGatewayChatTransport: OpenClawChatTransport {
    private struct AgentWaitResponse: Decodable {
        var status: String?
        var endedAt: Double?
        var error: String?
        var stopReason: String?
        var livenessState: String?
        var yielded: Bool?
        var pendingError: Bool?
        var timeoutPhase: String?
        var providerStarted: Bool?
        var aborted: Bool?
    }

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

    struct SessionTarget: Equatable {
        let sessionKey: String
        let agentID: String?
    }

    private let outboxGatewayID: String?
    private let routingIdentity: RoutingIdentity

    init(outboxGatewayID: String? = nil, defaultGlobalAgentID: String? = nil) {
        self.outboxGatewayID = outboxGatewayID
        self.routingIdentity = RoutingIdentity(defaultGlobalAgentID: defaultGlobalAgentID)
    }

    func updateDefaultGlobalAgentID(_ agentID: String?) {
        self.routingIdentity.update(defaultGlobalAgentID: agentID)
    }

    /// Bare alias keys ("global") do not name their owner; the gateway
    /// resolves an omitted agentId to the default agent, so scope them to the
    /// window's agent explicitly, mirroring the iOS transport.
    private func selectedGlobalAgentID(for sessionKey: String) -> String? {
        sessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "global"
            ? self.routingIdentity.currentAgentID()
            : nil
    }

    func sessionTarget(for sessionKey: String) -> SessionTarget {
        SessionTarget(
            sessionKey: sessionKey,
            agentID: self.selectedGlobalAgentID(for: sessionKey))
    }

    private func sessionParams(for sessionKey: String, key: String = "key") -> [String: AnyCodable] {
        let target = self.sessionTarget(for: sessionKey)
        var params = [key: AnyCodable(target.sessionKey)]
        if let agentID = target.agentID {
            params["agentId"] = AnyCodable(agentID)
        }
        return params
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

    func listModels() async throws -> [OpenClawChatModelChoice] {
        do {
            let data = try await GatewayConnection.shared.request(
                method: "models.list",
                params: [:],
                timeoutMs: 15000)
            let result = try JSONDecoder().decode(ModelsListResult.self, from: data)
            return result.models.map(Self.mapModelChoice)
        } catch {
            webChatSwiftLogger.warning(
                "models.list failed; hiding model picker: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        var params = self.sessionParams(for: sessionKey, key: "sessionKey")
        params["runId"] = AnyCodable(runId)
        _ = try await GatewayConnection.shared.request(
            method: "chat.abort",
            params: params,
            timeoutMs: 10000)
    }

    func listSessions(
        limit: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        var params: [String: AnyCodable] = [
            "includeGlobal": AnyCodable(true),
            "includeUnknown": AnyCodable(false),
        ]
        if let limit { params["limit"] = AnyCodable(limit) }
        let normalizedSearch = search?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let normalizedSearch, !normalizedSearch.isEmpty {
            params["search"] = AnyCodable(normalizedSearch)
        }
        if archived {
            params["archived"] = AnyCodable(true)
        }
        let data = try await GatewayConnection.shared.request(
            method: "sessions.list",
            params: params,
            timeoutMs: 15000)
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
        var params = ["key": AnyCodable(sessionKey)]
        if let agentID {
            params["agentId"] = AnyCodable(agentID)
        }
        params["model"] = model.map(AnyCodable.init) ?? AnyCodable(NSNull())
        let data = try await GatewayConnection.shared.request(
            method: "sessions.patch",
            params: params,
            timeoutMs: 15000)
        return try JSONDecoder().decode(OpenClawChatModelPatchResult.self, from: data)
    }

    func setSessionThinking(sessionKey: String, thinkingLevel: String) async throws {
        var params = self.sessionParams(for: sessionKey)
        params["thinkingLevel"] = AnyCodable(thinkingLevel)
        _ = try await GatewayConnection.shared.request(
            method: "sessions.patch",
            params: params,
            timeoutMs: 15000)
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

    var supportsSlashCommandCatalog: Bool {
        true
    }

    func listCommands(sessionKey: String) async throws -> [OpenClawChatCommandChoice] {
        var params: [String: AnyCodable] = [
            "scope": AnyCodable("text"),
            "includeArgs": AnyCodable(true),
        ]
        if let agentID = Self.agentID(fromSessionKey: sessionKey) ?? self.routingIdentity.currentAgentID() {
            params["agentId"] = AnyCodable(agentID)
        }
        let data = try await GatewayConnection.shared.request(
            method: "commands.list",
            params: params,
            timeoutMs: 15000)
        let decoded = try JSONDecoder().decode(CommandsListResult.self, from: data)
        return decoded.commands.map(Self.mapCommandChoice)
    }

    func createSession(
        key: String,
        label: String?,
        parentSessionKey: String?,
        worktree: Bool?) async throws -> OpenClawChatCreateSessionResponse
    {
        var params: [String: AnyCodable] = [
            "key": AnyCodable(key),
        ]
        if let agentID = Self.agentID(fromSessionKey: key)
            ?? parentSessionKey.flatMap(Self.agentID(fromSessionKey:))
            ?? self.routingIdentity.currentAgentID()
        {
            params["agentId"] = AnyCodable(agentID)
        }
        if let label {
            params["label"] = AnyCodable(label)
        }
        if let parentSessionKey {
            params["parentSessionKey"] = AnyCodable(parentSessionKey)
        }
        if let worktree {
            params["worktree"] = AnyCodable(worktree)
        }
        let data = try await GatewayConnection.shared.request(
            method: "sessions.create",
            params: params,
            timeoutMs: 15000)
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
        var params = self.sessionParams(for: key)
        if let label {
            params["label"] = label.map(AnyCodable.init) ?? AnyCodable(NSNull())
        }
        if let category {
            params["category"] = category.map(AnyCodable.init) ?? AnyCodable(NSNull())
        }
        if let pinned {
            params["pinned"] = AnyCodable(pinned)
        }
        if let archived {
            params["archived"] = AnyCodable(archived)
        }
        if let unread {
            params["unread"] = AnyCodable(unread)
        }
        _ = try await GatewayConnection.shared.request(
            method: "sessions.patch",
            params: params,
            timeoutMs: 15000)
    }

    func deleteSession(key: String) async throws {
        var params = self.sessionParams(for: key)
        params["deleteTranscript"] = AnyCodable(true)
        _ = try await GatewayConnection.shared.request(
            method: "sessions.delete",
            params: params,
            timeoutMs: 15000)
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        try await GatewayConnection.shared.healthOK(timeoutMs: timeoutMs)
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
            let data = try await GatewayConnection.shared.request(
                method: "agent.wait",
                params: [
                    "runId": AnyCodable(runId),
                    "timeoutMs": AnyCodable(timeoutMs),
                ],
                timeoutMs: Double(timeoutMs + 5000),
                ifCurrentRoute: route)
            let decoded = try JSONDecoder().decode(AgentWaitResponse.self, from: data)
            return OpenClawChatRunObservation.fromWaitResponse(
                status: decoded.status,
                endedAt: decoded.endedAt,
                error: decoded.error,
                stopReason: decoded.stopReason,
                livenessState: decoded.livenessState,
                yielded: decoded.yielded,
                pendingError: decoded.pendingError,
                timeoutPhase: decoded.timeoutPhase,
                providerStarted: decoded.providerStarted,
                aborted: decoded.aborted)
        } catch {
            webChatSwiftLogger.warning(
                "agent.wait failed runId=\(runId, privacy: .public) "
                    + "error=\(error.localizedDescription, privacy: .public)")
            return .unavailable
        }
    }

    func resetSession(sessionKey: String) async throws {
        _ = try await GatewayConnection.shared.request(
            method: "sessions.reset",
            params: self.sessionParams(for: sessionKey),
            timeoutMs: 10000)
    }

    func compactSession(sessionKey: String) async throws {
        let response = try await GatewayConnection.shared.request(
            method: "sessions.compact",
            params: self.sessionParams(for: sessionKey),
            timeoutMs: 0,
            retryTransportFailures: false)
        try OpenClawSessionsCompactResponse.requireSuccess(from: response)
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        await MainActor.run {
            WebChatManager.shared.recordActiveSessionKey(sessionKey)
        }
        _ = try await GatewayConnection.shared.request(
            method: "sessions.messages.subscribe",
            params: self.sessionParams(for: sessionKey),
            timeoutMs: 10000)
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
                    if Task.isCancelled { return }
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
            switch evt.event {
            case "health":
                guard let payload = evt.payload else { return nil }
                let ok = (try? JSONDecoder().decode(
                    OpenClawGatewayHealthOK.self,
                    from: JSONEncoder().encode(payload)))?.ok ?? true
                return .health(ok: ok)
            case "tick":
                return .tick
            case "sessions.changed":
                guard let payload = evt.payload else { return nil }
                guard let change = try? JSONDecoder().decode(
                    OpenClawChatSessionsChangedEvent.self,
                    from: JSONEncoder().encode(payload))
                else {
                    return nil
                }
                return .sessionsChanged(change)
            case "chat":
                guard let payload = evt.payload else { return nil }
                guard let chat = try? JSONDecoder().decode(
                    OpenClawChatEventPayload.self,
                    from: JSONEncoder().encode(payload))
                else {
                    return nil
                }
                return .chat(chat)
            case "session.message":
                guard let payload = evt.payload else { return nil }
                guard let message = try? JSONDecoder().decode(
                    OpenClawSessionMessageEventPayload.self,
                    from: JSONEncoder().encode(payload))
                else {
                    return nil
                }
                return .sessionMessage(message)
            case "agent":
                guard let payload = evt.payload else { return nil }
                guard let agent = try? JSONDecoder().decode(
                    OpenClawAgentEventPayload.self,
                    from: JSONEncoder().encode(payload))
                else {
                    return nil
                }
                return .agent(agent)
            default:
                return nil
            }

        case .seqGap:
            return .seqGap
        }
    }

    private static func mapModelChoice(_ model: OpenClawProtocol.ModelChoice) -> OpenClawChatModelChoice {
        OpenClawChatModelChoice(
            modelID: model.id,
            name: model.name,
            provider: model.provider,
            contextWindow: model.contextwindow,
            reasoning: model.reasoning)
    }

    static func agentID(fromSessionKey sessionKey: String) -> String? {
        let parts = sessionKey
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else { return nil }
        let agentID = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        return agentID.isEmpty ? nil : agentID
    }

    private static func mapCommandChoice(_ entry: CommandEntry) -> OpenClawChatCommandChoice {
        let sourceValue = (entry.source.value as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let source: OpenClawChatCommandChoice.Source = switch sourceValue {
        case "native":
            .command
        case "skill":
            .skill
        case "plugin":
            .plugin
        default:
            .unknown
        }
        let aliases = (entry.textaliases ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let id = [
            source.rawValue,
            entry.name.trimmingCharacters(in: .whitespacesAndNewlines),
            aliases.first ?? "",
        ].joined(separator: ":")
        return OpenClawChatCommandChoice(
            id: id,
            name: entry.name,
            textAliases: aliases,
            description: entry.description,
            source: source,
            acceptsArgs: entry.acceptsargs)
    }
}

// MARK: - Window controller

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
    private let contentController: NSViewController
    private let sessionKeyRelay: WebChatSessionKeyRelay
    private var window: NSWindow?
    private var dismissMonitor: Any?
    var onClosed: (() -> Void)?
    var onVisibilityChanged: ((Bool) -> Void)?
    /// Fires when the hosted chat switches sessions in place (sidebar,
    /// composer picker, /new) so the owner can track what this surface shows.
    var onSessionKeyChanged: ((String) -> Void)?

    convenience init(sessionKey: String, presentation: WebChatPresentation) {
        // Connection-mode changes tear chat windows down via resetTunnels(),
        // so binding the cache identity at construction stays correct. One
        // store instance backs both the transcript cache and the offline
        // command outbox.
        let context = MacChatTranscriptCache.makeContext()
        let store = context?.store
        self.init(
            sessionKey: sessionKey,
            presentation: presentation,
            transport: MacGatewayChatTransport(
                outboxGatewayID: store?.gatewayID,
                defaultGlobalAgentID: context?.routingIdentity?.defaultAgentID),
            initialActiveAgentID: context?.routingIdentity?.defaultAgentID,
            initialSessionRoutingContract: context?.routingIdentity?.contract,
            transcriptCache: store,
            outbox: store)
    }

    init(
        sessionKey: String,
        presentation: WebChatPresentation,
        transport: any OpenClawChatTransport,
        initialActiveAgentID: String? = nil,
        initialSessionRoutingContract: String? = nil,
        transcriptCache: (any OpenClawChatTranscriptCache)? = nil,
        outbox: (any OpenClawChatCommandOutbox)? = nil)
    {
        self.sessionKey = sessionKey
        self.presentation = presentation
        let sessionKeyRelay = WebChatSessionKeyRelay()
        self.sessionKeyRelay = sessionKeyRelay
        let vm = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: initialActiveAgentID,
            sessionRoutingContract: initialSessionRoutingContract,
            transcriptCache: transcriptCache,
            outbox: outbox,
            initialThinkingLevel: Self.persistedThinkingLevel(),
            onSessionChanged: { key in
                sessionKeyRelay.onChange?(key)
            },
            onThinkingLevelChanged: { level in
                UserDefaults.standard.set(level, forKey: webChatThinkingLevelDefaultsKey)
            })
        Task { @MainActor [weak vm] in
            let pushes = await GatewayConnection.shared.subscribe()
            for await push in pushes {
                guard let vm else { return }
                guard case .snapshot = push else { continue }
                let route = await GatewayConnection.shared.captureRoute()
                let routingIdentity: GatewayConnection.SessionRoutingIdentity? = if let route {
                    try? await GatewayConnection.shared.sessionRoutingIdentity(
                        ifCurrentRoute: route)
                } else {
                    nil
                }
                if let routingIdentity {
                    (transport as? MacGatewayChatTransport)?
                        .updateDefaultGlobalAgentID(routingIdentity.defaultAgentID)
                    if let store = transcriptCache as? OpenClawChatSQLiteTranscriptCache,
                       store.gatewayID == MacChatTranscriptCache.currentGatewayID(),
                       let persistedIdentity = OpenClawChatSessionRoutingIdentity(
                           contract: routingIdentity.contract)
                    {
                        await store.storeSessionRoutingIdentity(persistedIdentity)
                    }
                    vm.syncDeliveryIdentity(
                        activeAgentId: routingIdentity.defaultAgentID,
                        sessionRoutingContract: routingIdentity.contract)
                }
            }
        }
        let accent = Self.color(fromHex: AppStateStore.shared.seamColorHex)
        switch presentation {
        case .window:
            // Full window: native split-view shell with sessions sidebar and
            // toolbar pickers bridged into the NSToolbar.
            let hosting = NSHostingController(rootView: OpenClawChatWindowShell(
                viewModel: vm,
                userAccent: accent))
            hosting.sceneBridgingOptions = [.toolbars, .title]
            self.contentController = hosting
        case .panel:
            // Anchored quick-chat panel: compact single-column chat.
            let hosting = NSHostingController(rootView: OpenClawChatView(
                viewModel: vm,
                showsSessionSwitcher: true,
                userAccent: accent))
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
        if ProcessInfo.processInfo.isRunningTests { return }
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

    private static func makeWindow(
        for presentation: WebChatPresentation,
        contentViewController: NSViewController) -> NSWindow
    {
        switch presentation {
        case .window:
            let window = NSWindow(
                contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.windowSize),
                styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                backing: .buffered,
                defer: false)
            window.title = "OpenClaw Chat"
            window.contentViewController = contentViewController
            window.isReleasedWhenClosed = false
            window.titleVisibility = .visible
            window.toolbarStyle = .unified
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
        hosting: NSHostingController<OpenClawChatView>) -> NSViewController
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
}
