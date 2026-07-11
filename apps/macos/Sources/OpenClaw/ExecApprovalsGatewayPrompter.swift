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
            if Task.isCancelled {
                return
            }
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
            // The Gateway emitted this event because its own policy requires a
            // decision. If this Mac cannot present UI, leave the request
            // unresolved so the Gateway applies its current timeout fallback.
            guard self.shouldPresent(request: request) else { return }
            let nowMs = Int(Date().timeIntervalSince1970 * 1000)
            let (remainingMs, overflow) = request.expiresAtMs.subtractingReportingOverflow(nowMs)
            guard !overflow, remainingMs > 0 else { return }
            guard let decision = await ExecApprovalsPromptPresenter.prompt(
                request.request,
                timeoutMs: remainingMs)
            else {
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

    private func shouldPresent(request: GatewayApprovalRequest) -> Bool {
        let mode = AppStateStore.shared.connectionMode
        let activeSession = WebChatManager.shared.activeSessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestSession = request.request.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Self.shouldPresent(
            mode: mode,
            activeSession: activeSession,
            requestSession: requestSession,
            lastInputSeconds: Self.lastInputSeconds(),
            thresholdSeconds: 120)
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
        if seconds.isNaN || seconds.isInfinite || seconds < 0 {
            return nil
        }
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
}
#endif
