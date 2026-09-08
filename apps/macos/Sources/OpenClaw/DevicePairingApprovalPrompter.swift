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
    private let gateway: GatewayConnection
    private let center: PairingApprovalCenter
    private var source: PairingPromptSupport.Source?
    private var task: Task<Void, Never>?
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
    /// Requests whose approve/reject RPC is still in flight; their cards are
    /// hidden optimistically and restored by the failure path.
    private var pendingLocalDecisionRequestIds: Set<String> = []

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

    init(gateway: GatewayConnection = .shared, center: PairingApprovalCenter = .shared) {
        self.gateway = gateway
        self.center = center
    }

    func start() {
        self.center.register(kind: .device) { [weak self] card, decision in
            await self?.handleDecision(card: card, decision: decision)
        }
        PairingPromptSupport.startPairingPushTask(
            task: &self.task,
            gateway: self.gateway,
            handlePush: self.handle(delivery:))
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
        self.replaceSource(nil)
        self.center.unregister(kind: .device)
    }

    private func replaceSource(_ source: PairingPromptSupport.Source?) {
        self.source?.retire()
        self.source = source
        self.queue.removeAll()
        self.pairedDeviceIds.removeAll()
        self.trustUnknownRequestIds.removeAll()
        self.pendingLocalDecisionRequestIds.removeAll(keepingCapacity: false)
        self.updatePendingCounts()
        self.syncCards()
    }

    private func owns(_ source: PairingPromptSupport.Source) -> Bool {
        self.source === source && source.isCurrent
    }

    private func loadPendingRequestsFromGateway(source: PairingPromptSupport.Source) async {
        guard self.owns(source) else { return }
        do {
            try await source.refreshList(method: GatewayConnection.Method.devicePairList.rawValue) { data in
                let list = try JSONDecoder().decode(PairingList.self, from: data)
                self.apply(list: list)
            }
        } catch {
            guard self.owns(source) else { return }
            self.logger.error("failed to load device pairing requests: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func apply(list: PairingList) {
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
        // A pending local decision hides the card immediately (the decision is
        // optimistic); the failure path re-syncs so the card can come back.
        let cards = self.queue
            .filter { !self.pendingLocalDecisionRequestIds.contains($0.requestId) }
            .map { self.card(for: $0) }
        self.center.sync(kind: .device, cards: cards)
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
            requestedAt: Date(timeIntervalSince1970: req.ts / 1000),
            source: self.source)
    }

    private func handleDecision(card: PairingApprovalCenter.Card, decision: PairingApprovalCenter.Decision) async {
        guard let source = card.source, self.owns(source),
              let request = self.queue.first(where: { $0.requestId == card.requestId })
        else {
            self.logger.info("pairing decision discarded because its request or Gateway connection changed")
            return
        }

        self.pendingLocalDecisionRequestIds.insert(request.requestId)
        // Optimistic dismiss: the card leaves the panel before the RPC
        // round-trip.
        self.syncCards()
        let rpcOk = await PairingPromptSupport.decide(
            requestId: request.requestId, kind: .device, decision: decision, source: source, logger: self.logger)
        guard self.owns(source) else { return }
        source.invalidateList()
        self.pendingLocalDecisionRequestIds.remove(request.requestId)

        if !rpcOk {
            // Stale request (expired/superseded/resolved elsewhere) or gateway
            // failure: re-sync with gateway truth so stale cards collapse. A
            // request that is genuinely still pending comes back, and the
            // notification explains why the optimistic dismiss did not stick.
            await self.loadPendingRequestsFromGateway(source: source)
            guard self.owns(source) else { return }
            self.syncCards()
            if self.queue.contains(where: { $0.requestId == request.requestId }) {
                await PairingPromptSupport.notifyDecisionFailed(
                    kind: .device,
                    decision: decision,
                    source: source,
                    subject: PairingPromptSupport.subjectLabel(
                        displayName: request.displayName,
                        fallback: request.deviceId))
            }
            return
        }

        self.queue.removeAll { $0.requestId == request.requestId }
        self.updatePendingCounts()
        self.syncCards()
    }

    private func handle(delivery: GatewayConnection.PushDelivery) {
        guard let push = delivery.push else {
            if self.source?.lease == delivery.serverLease { self.replaceSource(nil) }
            return
        }
        guard delivery.isCurrent else { return }
        if self.source?.lease != delivery.serverLease {
            self.replaceSource(.init(lease: delivery.serverLease, gateway: self.gateway))
        }
        guard let source = self.source else { return }
        switch push {
        case let .event(evt) where evt.event == "device.pair.requested":
            guard let payload = evt.payload else { return }
            do {
                let req = try GatewayPayloadDecoding.decode(payload, as: PendingRequest.self)
                self.enqueue(req, source: source)
            } catch {
                self.logger
                    .error("failed to decode device pairing request: \(error.localizedDescription, privacy: .public)")
            }
        case let .event(evt) where evt.event == "device.pair.resolved":
            guard let payload = evt.payload else { return }
            do {
                let resolved = try GatewayPayloadDecoding.decode(payload, as: PairingResolvedEvent.self)
                self.handleResolved(resolved, source: source)
            } catch {
                self.logger
                    .error(
                        "failed to decode device pairing resolution: \(error.localizedDescription, privacy: .public)")
            }
        case .snapshot:
            Task { await self.loadPendingRequestsFromGateway(source: source) }
        case .seqGap:
            source.invalidateList()
            Task { await self.loadPendingRequestsFromGateway(source: source) }
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

    private func enqueue(_ req: PendingRequest, source: PairingPromptSupport.Source) {
        guard let next = Self.coalescedQueue(self.queue, adding: req) else { return }
        source.invalidateList()
        self.queue = next
        self.trustUnknownRequestIds.insert(req.requestId)
        self.updatePendingCounts()
        self.syncCards()
        // The "previously paired" trust signal must not come from a stale
        // startup snapshot; re-fetch gateway truth for each new request.
        Task { @MainActor [weak self] in
            await self?.loadPendingRequestsFromGateway(source: source)
        }
    }

    private func handleResolved(_ resolved: PairingResolvedEvent, source: PairingPromptSupport.Source) {
        // Discard any in-flight list snapshot taken before this resolution
        // so it cannot resurrect the resolved card.
        source.invalidateList()
        self.queue.removeAll { $0.requestId == resolved.requestId }
        self.updatePendingCounts()
        self.syncCards()
    }
}
