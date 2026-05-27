import CoreGraphics
import Foundation
import OpenClawKit
import OpenClawProtocol
import OSLog

@MainActor
final class ExecApprovalsGatewayPrompter {
    static let shared = ExecApprovalsGatewayPrompter()

    private let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals.gateway")
    private var task: Task<Void, Never>?

    struct GatewayApprovalRequest: Codable {
        var id: String
        var request: ExecApprovalPromptRequest
        var createdAtMs: Int
        var expiresAtMs: Int
    }

    func start() {
        SimpleTaskSupport.start(task: &self.task) { [weak self] in
            await self?.run()
        }
    }

    func stop() {
        SimpleTaskSupport.stop(task: &self.task)
    }

    private func run() async {
        let stream = await GatewayConnection.shared.subscribe(bufferingNewest: 200)
        for await push in stream {
            if Task.isCancelled { return }
            await self.handle(push: push)
        }
    }

    private func handle(push: GatewayPush) async {
        guard case let .event(evt) = push else { return }
        guard evt.event == "exec.approval.requested" else { return }
        guard let payload = evt.payload else { return }
        do {
            let data = try JSONEncoder().encode(payload)
            let request = try JSONDecoder().decode(GatewayApprovalRequest.self, from: data)
            let presentation = self.shouldPresent(request: request)
            guard presentation.shouldAsk else {
                // Ask policy says no prompt needed – resolve based on security policy
                let decision: ExecApprovalDecision = presentation.security == .full ? .allowOnce : .deny
                try await GatewayConnection.shared.requestVoid(
                    method: .execApprovalResolve,
                    params: [
                        "id": AnyCodable(request.id),
                        "decision": AnyCodable(decision.rawValue),
                    ],
                    timeoutMs: 10000)
                return
            }
            guard presentation.canPresent else {
                let decision = Self.fallbackDecision(
                    request: request.request,
                    askFallback: presentation.askFallback,
                    allowlist: presentation.allowlist)
                try await GatewayConnection.shared.requestVoid(
                    method: .execApprovalResolve,
                    params: [
                        "id": AnyCodable(request.id),
                        "decision": AnyCodable(decision.rawValue),
                    ],
                    timeoutMs: 10000)
                return
            }
            guard let decision = ExecApprovalsPromptPresenter.prompt(request.request) else {
                return
            }
            try await GatewayConnection.shared.requestVoid(
                method: .execApprovalResolve,
                params: [
                    "id": AnyCodable(request.id),
                    "decision": AnyCodable(decision.rawValue),
                ],
                timeoutMs: 10000)
        } catch {
            self.logger.error("exec approval handling failed \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Whether the ask policy requires prompting the user.
    /// Note: this only determines if a prompt is shown, not whether the action is allowed.
    /// The security policy (full/deny/allowlist) decides the actual outcome.
    private static func shouldAsk(security: ExecSecurity, ask: ExecAsk) -> Bool {
        switch ask {
        case .always:
            true
        case .onMiss:
            security == .allowlist
        case .off:
            false
        }
    }

    struct PresentationDecision {
        /// Whether the ask policy requires prompting the user (not whether the action is allowed).
        var shouldAsk: Bool
        /// Whether the prompt can actually be shown (session match, recent activity, etc.).
        var canPresent: Bool
        /// The resolved security policy, used to determine allow/deny when no prompt is shown.
        var security: ExecSecurity
        /// Fallback security policy when a prompt is needed but can't be presented.
        var askFallback: ExecSecurity
        var allowlist: [ExecAllowlistEntry]
    }

    private func shouldPresent(request: GatewayApprovalRequest) -> PresentationDecision {
        let mode = AppStateStore.shared.connectionMode
        let activeSession = WebChatManager.shared.activeSessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestSession = request.request.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)

        // Read-only resolve to avoid disk writes on the MainActor
        let approvals = ExecApprovalsStore.resolveReadOnly(agentId: request.request.agentId)
        let security = approvals.agent.security
        let ask = approvals.agent.ask

        let shouldAsk = Self.shouldAsk(security: security, ask: ask)

        let canPresent = shouldAsk && Self.shouldPresent(
            mode: mode,
            activeSession: activeSession,
            requestSession: requestSession,
            lastInputSeconds: Self.lastInputSeconds(),
            thresholdSeconds: 120)

        return PresentationDecision(
            shouldAsk: shouldAsk,
            canPresent: canPresent,
            security: security,
            askFallback: approvals.agent.askFallback,
            allowlist: approvals.allowlist)
    }

    private static func fallbackDecision(
        request: ExecApprovalPromptRequest,
        askFallback: ExecSecurity,
        allowlist: [ExecAllowlistEntry]) -> ExecApprovalDecision
    {
        guard askFallback == .allowlist else {
            return askFallback == .full ? .allowOnce : .deny
        }
        let resolution = self.fallbackResolution(for: request)
        let match = ExecAllowlistMatcher.match(entries: allowlist, resolution: resolution)
        return match == nil ? .deny : .allowOnce
    }

    private static func fallbackResolution(for request: ExecApprovalPromptRequest) -> ExecCommandResolution? {
        let resolvedPath = request.resolvedPath?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedResolvedPath = (resolvedPath?.isEmpty == false) ? resolvedPath : nil
        let rawExecutable = self.firstToken(from: request.command) ?? trimmedResolvedPath ?? ""
        guard !rawExecutable.isEmpty || trimmedResolvedPath != nil else { return nil }
        let executableName = trimmedResolvedPath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? rawExecutable
        return ExecCommandResolution(
            rawExecutable: rawExecutable,
            resolvedPath: trimmedResolvedPath,
            executableName: executableName,
            cwd: request.cwd)
    }

    private static func firstToken(from command: String) -> String? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed.split(whereSeparator: { $0.isWhitespace }).first.map(String.init)
    }

    private static func shouldPresent(
        mode: AppState.ConnectionMode,
        activeSession: String?,
        requestSession: String?,
        lastInputSeconds: Int?,
        thresholdSeconds: Int) -> Bool
    {
        let active = activeSession?.trimmingCharacters(in: .whitespacesAndNewlines)
        let requested = requestSession?.trimmingCharacters(in: .whitespacesAndNewlines)
        let recentlyActive = lastInputSeconds.map { $0 <= thresholdSeconds } ?? (mode == .local)

        if let session = requested, !session.isEmpty {
            if let active, !active.isEmpty {
                return active == session
            }
            return recentlyActive
        }

        if let active, !active.isEmpty {
            return true
        }
        return mode == .local
    }

    private static func lastInputSeconds() -> Int? {
        let anyEvent = CGEventType(rawValue: UInt32.max) ?? .null
        let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyEvent)
        if seconds.isNaN || seconds.isInfinite || seconds < 0 { return nil }
        return Int(seconds.rounded())
    }
}

#if DEBUG
extension ExecApprovalsGatewayPrompter {
    static func _testShouldPresent(
        mode: AppState.ConnectionMode,
        activeSession: String?,
        requestSession: String?,
        lastInputSeconds: Int?,
        thresholdSeconds: Int = 120) -> Bool
    {
        self.shouldPresent(
            mode: mode,
            activeSession: activeSession,
            requestSession: requestSession,
            lastInputSeconds: lastInputSeconds,
            thresholdSeconds: thresholdSeconds)
    }

    static func _testShouldAsk(security: ExecSecurity, ask: ExecAsk) -> Bool {
        self.shouldAsk(security: security, ask: ask)
    }

    static func _testFallbackDecision(
        command: String,
        resolvedPath: String?,
        askFallback: ExecSecurity,
        allowlistPatterns: [String]) -> ExecApprovalDecision
    {
        self.fallbackDecision(
            request: ExecApprovalPromptRequest(
                command: command,
                cwd: nil,
                host: nil,
                security: nil,
                ask: nil,
                agentId: nil,
                resolvedPath: resolvedPath,
                sessionKey: nil),
            askFallback: askFallback,
            allowlist: allowlistPatterns.map { ExecAllowlistEntry(pattern: $0) })
    }
}
#endif
