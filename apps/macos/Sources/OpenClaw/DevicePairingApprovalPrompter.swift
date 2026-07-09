import AppKit
import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import OSLog

@MainActor
@Observable
final class DevicePairingApprovalPrompter {
    static let shared = DevicePairingApprovalPrompter()

    private let logger = Logger(subsystem: "ai.openclaw", category: "device-pairing")
    private var task: Task<Void, Never>?
    private var isStopping = false
    private var listFetchGeneration = 0
    private var queue: [PendingRequest] = []
    var pendingCount: Int = 0
    var pendingRepairCount: Int = 0
    /// Device ids already paired on the gateway (from the last list fetch);
    /// drives the "previously paired" trust signal on cards.
    private var pairedDeviceIds: Set<String> = []
    /// Requests that arrived via push after the last list fetch; their trust
    /// state is unknown until fresh gateway truth applies (stale snapshots
    /// must not produce a positive "previously paired" claim).
    private var trustUnknownRequestIds: Set<String> = []

    private struct PairingList: Codable {
        let pending: [PendingRequest]
        let paired: [PairedDevice]?
    }

    private struct PairedDevice: Codable, Equatable {
        let deviceId: String
        let approvedAtMs: Double?
        let displayName: String?
        let platform: String?
        let remoteIp: String?
    }

    struct PendingRequest: Codable, Equatable, Identifiable {
        let requestId: String
        let deviceId: String
        let publicKey: String
        let displayName: String?
        let platform: String?
        let clientId: String?
        let clientMode: String?
        let role: String?
        let scopes: [String]?
        let remoteIp: String?
        let silent: Bool?
        let isRepair: Bool?
        let ts: Double

        var id: String {
            self.requestId
        }
    }

    private typealias PairingResolvedEvent = PairingPromptSupport.PairingResolvedEvent

    func start() {
        PairingApprovalCenter.shared.register(kind: .device) { [weak self] card, decision in
            await self?.handleDecision(card: card, decision: decision)
        }
        self.startPushTask()
    }

    private func startPushTask() {
        PairingPromptSupport.startPairingPushTask(
            task: &self.task,
            isStopping: &self.isStopping,
            loadPending: self.loadPendingRequestsFromGateway,
            handlePush: self.handle(push:))
    }

    func stop() {
        PairingPromptSupport.stopPairingPrompter(
            isStopping: &self.isStopping,
            task: &self.task,
            queue: &self.queue)
        PairingApprovalCenter.shared.unregister(kind: .device)
        self.updatePendingCounts()
    }

    private func loadPendingRequestsFromGateway() async {
        // Push-triggered refreshes can overlap; only the newest snapshot may
        // replace the queue or an older read would drop just-arrived requests.
        self.listFetchGeneration += 1
        let generation = self.listFetchGeneration
        do {
            let list: PairingList = try await GatewayConnection.shared.requestDecoded(method: .devicePairList)
            guard generation == self.listFetchGeneration else { return }
            self.apply(list: list)
        } catch {
            self.logger.error("failed to load device pairing requests: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func apply(list: PairingList) {
        if self.isStopping {
            return
        }
        self.pairedDeviceIds = Set((list.paired ?? []).map(\.deviceId))
        self.queue = list.pending.sorted(by: { $0.ts < $1.ts })
        // This snapshot is authoritative for every pending request in it.
        self.trustUnknownRequestIds.removeAll()
        self.updatePendingCounts()
        self.syncCards()
    }

    private func updatePendingCounts() {
        self.pendingCount = self.queue.count
        self.pendingRepairCount = self.queue.count(where: { $0.isRepair == true })
    }

    private func syncCards() {
        guard !self.isStopping else { return }
        let cards = self.queue.map { self.card(for: $0) }
        PairingApprovalCenter.shared.sync(kind: .device, cards: cards)
    }

    private func card(for req: PendingRequest) -> PairingApprovalCenter.Card {
        PairingApprovalCenter.Card(
            kind: .device,
            requestId: req.requestId,
            subjectId: req.deviceId,
            displayName: req.displayName,
            platform: req.platform,
            deviceFamily: nil,
            modelIdentifier: nil,
            version: nil,
            coreVersion: nil,
            remoteIp: req.remoteIp,
            role: req.role,
            scopes: req.scopes ?? [],
            caps: [],
            commands: [],
            isRepair: req.isRepair == true,
            previouslyPaired: self.trustUnknownRequestIds.contains(req.requestId)
                ? nil
                : self.pairedDeviceIds.contains(req.deviceId),
            requestedAt: Date(timeIntervalSince1970: req.ts / 1000))
    }

    private func handleDecision(card: PairingApprovalCenter.Card, decision: PairingApprovalCenter.Decision) async {
        guard !self.isStopping else { return }
        guard let request = self.queue.first(where: { $0.requestId == card.requestId }) else { return }

        switch decision {
        case .approve:
            if await !(self.approve(requestId: request.requestId)) {
                // Stale request (expired or superseded on the gateway): re-sync the
                // queue with gateway truth so accumulated stale cards collapse at once.
                await self.loadPendingRequestsFromGateway()
                return
            }
        case .reject:
            if await !(self.reject(requestId: request.requestId)) {
                // Failed reject leaves the request pending on the gateway;
                // re-sync instead of hiding a still-live card.
                await self.loadPendingRequestsFromGateway()
                return
            }
        }

        // Discard any in-flight list snapshot: it predates this resolution
        // and applying it would resurrect the just-resolved card.
        self.listFetchGeneration += 1
        self.queue.removeAll { $0.requestId == request.requestId }
        self.updatePendingCounts()
        self.syncCards()
    }

    private func approve(requestId: String) async -> Bool {
        await PairingPromptSupport.approveRequest(
            requestId: requestId,
            kind: "device",
            logger: self.logger)
        {
            try await GatewayConnection.shared.devicePairApprove(requestId: requestId)
        }
    }

    private func reject(requestId: String) async -> Bool {
        await PairingPromptSupport.rejectRequest(
            requestId: requestId,
            kind: "device",
            logger: self.logger)
        {
            try await GatewayConnection.shared.devicePairReject(requestId: requestId)
        }
    }

    private func handle(push: GatewayPush) {
        switch push {
        case let .event(evt) where evt.event == "device.pair.requested":
            guard let payload = evt.payload else { return }
            do {
                let req = try GatewayPayloadDecoding.decode(payload, as: PendingRequest.self)
                self.enqueue(req)
            } catch {
                self.logger
                    .error("failed to decode device pairing request: \(error.localizedDescription, privacy: .public)")
            }
        case let .event(evt) where evt.event == "device.pair.resolved":
            guard let payload = evt.payload else { return }
            do {
                let resolved = try GatewayPayloadDecoding.decode(payload, as: PairingResolvedEvent.self)
                self.handleResolved(resolved)
            } catch {
                self.logger
                    .error(
                        "failed to decode device pairing resolution: \(error.localizedDescription, privacy: .public)")
            }
        default:
            break
        }
    }

    /// The gateway keeps at most one live pending request per device, so a new
    /// requestId for the same device supersedes anything still queued for it.
    /// Without this, missed/dropped resolve pushes pile up as cards whose
    /// approval can no longer succeed. Returns nil when the request is already queued.
    static func coalescedQueue(_ queue: [PendingRequest], adding req: PendingRequest) -> [PendingRequest]? {
        guard !queue.contains(where: { $0.requestId == req.requestId }) else { return nil }
        return queue.filter { $0.deviceId != req.deviceId } + [req]
    }

    private func enqueue(_ req: PendingRequest) {
        guard let next = Self.coalescedQueue(self.queue, adding: req) else { return }
        self.queue = next
        self.trustUnknownRequestIds.insert(req.requestId)
        self.updatePendingCounts()
        self.syncCards()
        // The "previously paired" trust signal must not come from a stale
        // startup snapshot; re-fetch gateway truth for each new request.
        Task { @MainActor [weak self] in
            await self?.loadPendingRequestsFromGateway()
        }
    }

    private func handleResolved(_ resolved: PairingResolvedEvent) {
        // Discard any in-flight list snapshot taken before this resolution
        // so it cannot resurrect the resolved card.
        self.listFetchGeneration += 1
        self.queue.removeAll { $0.requestId == resolved.requestId }
        self.updatePendingCounts()
        self.syncCards()
    }
}
