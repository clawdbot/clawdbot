import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import OSLog

struct ExecApprovalQueueItem: Decodable, Identifiable {
    enum ApprovalKind {
        case exec
        case systemAgent
    }

    let id: String
    let request: ExecApprovalPromptRequest
    let createdAtMs: Int
    let expiresAtMs: Int
    let kind: ApprovalKind
    let allowedDecisions: [ExecApprovalDecision]

    init(
        id: String,
        request: ExecApprovalPromptRequest,
        createdAtMs: Int,
        expiresAtMs: Int,
        kind: ApprovalKind = .exec)
    {
        self.id = id
        self.request = request
        self.createdAtMs = createdAtMs
        self.expiresAtMs = expiresAtMs
        self.kind = kind
        self.allowedDecisions = Self.inlineDecisions(
            request.allowedDecisions,
            policyPresent: request.allowedDecisions != nil)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let request = try container.decode(ExecApprovalPromptRequest.self, forKey: .request)
        let requestContainer = try container.nestedContainer(
            keyedBy: RequestCodingKeys.self,
            forKey: .request)
        self.id = try container.decode(String.self, forKey: .id)
        self.request = request
        self.createdAtMs = try container.decode(Int.self, forKey: .createdAtMs)
        self.expiresAtMs = try container.decode(Int.self, forKey: .expiresAtMs)
        self.kind = .exec
        self.allowedDecisions = Self.inlineDecisions(
            request.allowedDecisions,
            policyPresent: requestContainer.contains(.allowedDecisions))
    }

    func assigningKind(_ kind: ApprovalKind) -> Self {
        var request = self.request
        request.allowedDecisions = self.allowedDecisions
        return Self(
            id: self.id,
            request: request,
            createdAtMs: self.createdAtMs,
            expiresAtMs: self.expiresAtMs,
            kind: kind)
    }

    private static func inlineDecisions(
        _ decisions: [ExecApprovalDecision]?,
        policyPresent: Bool) -> [ExecApprovalDecision]
    {
        let allowed = policyPresent ? decisions ?? [] : [.allowOnce, .deny]
        return allowed.filter { $0 == .deny || $0 == .allowOnce }
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case request
        case createdAtMs
        case expiresAtMs
    }

    private enum RequestCodingKeys: String, CodingKey {
        case allowedDecisions
    }
}

@MainActor
@Observable
final class ExecApprovalQueueStore {
    static let shared = ExecApprovalQueueStore()

    private(set) var requests: [ExecApprovalQueueItem] = []

    @ObservationIgnored private let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals.queue")
    @ObservationIgnored private let gateway: GatewayConnection
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var expiryTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var refreshGeneration: UInt64 = 0

    init(gateway: GatewayConnection = .shared) {
        self.gateway = gateway
    }

    func start() {
        guard self.eventTask == nil else { return }
        self.eventTask = Task { [weak self, gateway] in
            for await push in await gateway.subscribe(bufferingNewest: 200) {
                guard !Task.isCancelled, let self else { return }
                self.handle(push: push)
            }
        }
    }

    func stop() {
        self.eventTask?.cancel()
        self.eventTask = nil
        for task in self.expiryTasks.values {
            task.cancel()
        }
        self.expiryTasks.removeAll()
        self.refreshGeneration &+= 1
    }

    func refresh() async {
        let generation = self.refreshGeneration
        do {
            let listed: [ExecApprovalQueueItem] = try await self.gateway.requestDecoded(
                method: .execApprovalList,
                timeoutMs: 10000)
            // A resolution received during the request owns newer state; an old
            // list must never resurrect its already-dismissed approval card.
            guard generation == self.refreshGeneration, !Task.isCancelled else { return }
            let nowMs = Self.currentTimeMs()
            let systemApprovals = self.requests.filter { $0.kind == .systemAgent && $0.expiresAtMs > nowMs }
            self.replaceRequests(listed.filter { $0.expiresAtMs > nowMs } + systemApprovals)
        } catch {
            guard !Task.isCancelled else { return }
            self.logger.error("exec approval listing failed \(error.localizedDescription, privacy: .public)")
        }
    }

    func resolve(request: ExecApprovalQueueItem, decision: ExecApprovalDecision) async {
        guard request.allowedDecisions.contains(decision),
              decision != .allowAlways,
              self.requests.contains(where: { $0.id == request.id })
        else { return }

        var params: [String: AnyCodable] = [
            "id": AnyCodable(request.id),
            "decision": AnyCodable(decision.rawValue),
        ]
        let method: GatewayConnection.Method
        switch request.kind {
        case .exec:
            method = .execApprovalResolve
        case .systemAgent:
            method = .approvalResolve
            params["kind"] = AnyCodable("system-agent")
        }

        do {
            try await self.gateway.requestVoid(method: method, params: params, timeoutMs: 10000)
            self.removeRequest(id: request.id)
        } catch {
            self.logger.error("exec approval resolution failed \(error.localizedDescription, privacy: .public)")
            // A losing race (the modal prompter or another client resolved first)
            // surfaces here as a gateway rejection. Re-list instead of parsing
            // error text so the card converges to the authoritative queue.
            await self.refresh()
        }
    }

    private func handle(push: GatewayPush) {
        guard case let .event(event) = push, let payload = event.payload else { return }
        switch event.event {
        case "exec.approval.requested", "openclaw.approval.requested":
            do {
                let request = try GatewayPayloadDecoding.decode(payload, as: ExecApprovalQueueItem.self)
                let kind: ExecApprovalQueueItem.ApprovalKind = event.event == "openclaw.approval.requested"
                    ? .systemAgent
                    : .exec
                self.insertRequest(request.assigningKind(kind))
            } catch {
                self.logger.error("exec approval event decode failed \(error.localizedDescription, privacy: .public)")
            }
        case "exec.approval.resolved", "openclaw.approval.resolved":
            guard let resolved = try? GatewayPayloadDecoding.decode(payload, as: ResolvedApproval.self) else {
                return
            }
            self.removeRequest(id: resolved.id)
        default:
            break
        }
    }

    private func insertRequest(_ request: ExecApprovalQueueItem) {
        guard request.expiresAtMs > Self.currentTimeMs() else { return }
        self.refreshGeneration &+= 1
        self.requests.removeAll { $0.id == request.id }
        self.requests.append(request)
        self.requests.sort { $0.createdAtMs < $1.createdAtMs }
        self.scheduleExpiry(for: request)
    }

    private func removeRequest(id: String) {
        self.refreshGeneration &+= 1
        self.requests.removeAll { $0.id == id }
        self.expiryTasks.removeValue(forKey: id)?.cancel()
    }

    private func replaceRequests(_ requests: [ExecApprovalQueueItem]) {
        for task in self.expiryTasks.values {
            task.cancel()
        }
        self.expiryTasks.removeAll()
        self.requests = requests.sorted { $0.createdAtMs < $1.createdAtMs }
        for request in self.requests {
            self.scheduleExpiry(for: request)
        }
    }

    private func scheduleExpiry(for request: ExecApprovalQueueItem) {
        self.expiryTasks.removeValue(forKey: request.id)?.cancel()
        let (remainingMs, overflow) = request.expiresAtMs.subtractingReportingOverflow(Self.currentTimeMs())
        guard !overflow, remainingMs > 0 else {
            self.removeRequest(id: request.id)
            return
        }
        self.expiryTasks[request.id] = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(remainingMs))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            self?.removeRequest(id: request.id)
        }
    }

    private static func currentTimeMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    private struct ResolvedApproval: Decodable {
        let id: String
    }
}
