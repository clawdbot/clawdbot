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

    // The Gateway's durable operator_approvals registry shares IDs across kinds.
    let id: String
    let request: ExecApprovalPromptRequest
    let createdAtMs: Int
    let expiresAtMs: Int
    let kind: ApprovalKind
    let allowedDecisions: [ExecApprovalDecision]
    fileprivate var serverLease: GatewayConnection.ServerLease?

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

    fileprivate func owned(by lease: GatewayConnection.ServerLease, kind: ApprovalKind = .exec) -> Self {
        var request = self.request
        request.allowedDecisions = self.allowedDecisions
        var owned = Self(
            id: self.id,
            request: request,
            createdAtMs: self.createdAtMs,
            expiresAtMs: self.expiresAtMs,
            kind: kind)
        owned.serverLease = lease
        return owned
    }

    fileprivate func hasSameSource(as other: Self) -> Bool {
        self.id == other.id && self.kind == other.kind && self.serverLease == other.serverLease
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
    @ObservationIgnored private var admittedLease: GatewayConnection.ServerLease?
    @ObservationIgnored private var pendingRefresh: (
        lease: GatewayConnection.ServerLease,
        task: Task<Void, Never>)?
    @ObservationIgnored private var expiryTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var refreshGeneration: UInt64 = 0

    init(gateway: GatewayConnection = .shared) {
        self.gateway = gateway
    }

    func start() {
        guard self.eventTask == nil else { return }
        self.eventTask = Task { [weak self, gateway] in
            for await delivery in await gateway.subscribe(bufferingNewest: 200) {
                guard !Task.isCancelled, let self else { return }
                self.handle(delivery: delivery)
            }
        }
    }

    func stop() {
        self.eventTask?.cancel()
        self.eventTask = nil
        self.pendingRefresh?.task.cancel()
        self.pendingRefresh = nil
        self.admittedLease = nil
        for task in self.expiryTasks.values {
            task.cancel()
        }
        self.expiryTasks.removeAll()
        self.refreshGeneration &+= 1
    }

    func refresh() async {
        let generation = self.refreshGeneration
        do {
            let lease = try await self.gateway.acquireServerLease()
            guard generation == self.refreshGeneration, !Task.isCancelled,
                  self.gateway.serverLeaseMatchesCurrentState(lease)
            else { return }
            self.admit(lease)
            await self.reconcile(lease).value
        } catch {
            guard !Task.isCancelled else { return }
            self.logger.error("exec approval listing failed \(error.localizedDescription, privacy: .public)")
        }
    }

    @discardableResult
    private func admit(_ lease: GatewayConnection.ServerLease) -> Bool {
        guard self.admittedLease != lease else { return false }
        self.admittedLease = lease
        self.replaceRequests(self.requests.filter { $0.serverLease == lease })
        return true
    }

    private func reconcile(_ lease: GatewayConnection.ServerLease) -> Task<Void, Never> {
        if let pending = self.pendingRefresh, pending.lease == lease {
            return pending.task
        }
        self.pendingRefresh?.task.cancel()
        let task = Task { [weak self] in
            guard !Task.isCancelled, let self else { return }
            defer {
                // A replacement cancels its predecessor before installing its own task.
                if !Task.isCancelled { self.pendingRefresh = nil }
            }
            do {
                while !Task.isCancelled, self.gateway.serverLeaseMatchesCurrentState(lease) {
                    let generation = self.refreshGeneration
                    async let exec = self.listRequests(kind: .exec, lease: lease)
                    async let system = self.listRequests(kind: .systemAgent, lease: lease)
                    let listed = try await exec + system
                    guard !Task.isCancelled, self.gateway.serverLeaseMatchesCurrentState(lease) else { return }
                    // Reconcile again after newer events so untouched pending rows are still recovered.
                    guard generation == self.refreshGeneration else { continue }
                    self.replaceRequests(listed.filter { $0.expiresAtMs > Self.currentTimeMs() })
                    return
                }
            } catch {
                guard !Task.isCancelled else { return }
                self.logger.error("exec approval listing failed \(error.localizedDescription, privacy: .public)")
            }
        }
        self.pendingRefresh = (lease, task)
        return task
    }

    private func listRequests(
        kind: ExecApprovalQueueItem.ApprovalKind,
        lease: GatewayConnection.ServerLease) async throws -> [ExecApprovalQueueItem]
    {
        let method = kind == .exec ? "exec.approval.list" : "openclaw.approval.list"
        if kind == .systemAgent,
           await self.gateway.supportsServerMethod(method, ifCurrentServerLease: lease) != true
        {
            return []
        }
        let data = try await self.gateway.request(
            method: method,
            params: nil,
            timeoutMs: 10000,
            ifCurrentServerLease: lease)
        return try JSONDecoder().decode([ExecApprovalQueueItem].self, from: data)
            .map { $0.owned(by: lease, kind: kind) }
    }

    func resolve(request: ExecApprovalQueueItem, decision: ExecApprovalDecision) async {
        guard request.allowedDecisions.contains(decision),
              decision != .allowAlways,
              request.expiresAtMs > Self.currentTimeMs(),
              let lease = request.serverLease,
              self.requests.contains(where: { $0.hasSameSource(as: request) })
        else {
            self.logger.info("exec approval decision ignored; request or available decisions changed")
            return
        }

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
            _ = try await self.gateway.request(
                method: method.rawValue,
                params: params,
                timeoutMs: 10000,
                ifCurrentServerLease: lease)
            self.removeRequest(request)
        } catch {
            self.logger.error("exec approval resolution failed \(error.localizedDescription, privacy: .public)")
            if !self.gateway.serverLeaseMatchesCurrentState(lease) {
                self.removeRequest(request)
            }
            // A losing race (the modal prompter or another client resolved first)
            // surfaces here as a gateway rejection. Re-list instead of parsing
            // error text so the card converges to the authoritative queue.
            await self.refresh()
        }
    }

    private func handle(delivery: GatewayConnection.PushDelivery) {
        let serverLease = delivery.serverLease
        guard let push = delivery.push else {
            // Retirement still clears A's rows while replacement B is unavailable.
            if self.pendingRefresh?.lease == serverLease {
                self.pendingRefresh?.task.cancel()
                self.pendingRefresh = nil
            }
            if self.admittedLease == serverLease { self.admittedLease = nil }
            self.replaceRequests(self.requests.filter { $0.serverLease != serverLease })
            return
        }
        guard delivery.isCurrent else { return }
        // The short hello admission can let current events precede the ordinary snapshot.
        if self.admit(serverLease) {
            _ = self.reconcile(serverLease)
        }
        guard case let .event(event) = push, let payload = event.payload else { return }
        switch event.event {
        case "exec.approval.requested", "openclaw.approval.requested":
            do {
                let request = try GatewayPayloadDecoding.decode(payload, as: ExecApprovalQueueItem.self)
                let kind: ExecApprovalQueueItem.ApprovalKind = event.event == "openclaw.approval.requested"
                    ? .systemAgent
                    : .exec
                self.insertRequest(request.owned(by: serverLease, kind: kind))
            } catch {
                self.logger.error("exec approval event decode failed \(error.localizedDescription, privacy: .public)")
            }
        case "exec.approval.resolved", "openclaw.approval.resolved":
            guard let resolved = try? GatewayPayloadDecoding.decode(payload, as: ResolvedApproval.self) else {
                return
            }
            self.refreshGeneration &+= 1
            let kind: ExecApprovalQueueItem.ApprovalKind = event.event == "openclaw.approval.resolved"
                ? .systemAgent
                : .exec
            if let request = self.requests.first(where: {
                $0.id == resolved.id && $0.kind == kind && $0.serverLease == serverLease
            }) {
                self.removeRequest(request)
            }
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

    private func removeRequest(_ request: ExecApprovalQueueItem) {
        // A retained menu action, timer, or reply must not retire the same id
        // admitted later from another Gateway or physical connection.
        guard let index = self.requests.firstIndex(where: { $0.hasSameSource(as: request) }) else { return }
        self.refreshGeneration &+= 1
        self.requests.remove(at: index)
        self.expiryTasks.removeValue(forKey: request.id)?.cancel()
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
            self.removeRequest(request)
            return
        }
        // Task startup may be delayed; keep the Gateway's expiry deadline.
        let deadline = ContinuousClock.now + .milliseconds(remainingMs)
        self.expiryTasks[request.id] = Task { [weak self] in
            try? await Task.sleep(until: deadline, clock: .continuous)
            guard !Task.isCancelled else { return }
            self?.removeRequest(request)
        }
    }

    private static func currentTimeMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    private struct ResolvedApproval: Decodable {
        let id: String
    }
}
