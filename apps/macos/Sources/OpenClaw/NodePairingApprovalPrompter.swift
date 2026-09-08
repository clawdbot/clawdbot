import AppKit
import Foundation
import Observation
import OpenClawDiscovery
import OpenClawIPC
import OpenClawKit
import OpenClawProtocol
import OSLog

enum NodePairingReconcilePolicy {
    static let activeIntervalMs: UInt64 = 15000
    static let resyncDelayMs: UInt64 = 250

    static func shouldPoll(pendingCount: Int) -> Bool {
        pendingCount > 0
    }
}

@MainActor
@Observable
final class NodePairingApprovalPrompter {
    private static let silentPairingSSHOptions = [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        "-o", "NumberOfPasswordPrompts=0",
        "-o", "PreferredAuthentications=publickey",
        "-o", "ControlMaster=no",
        "-o", "ControlPath=none",
        "-o", "ControlPersist=no",
        "-o", "ForkAfterAuthentication=no",
        // Silent approval is an authorization boundary; require an already trusted host key.
        "-o", "StrictHostKeyChecking=yes",
    ]

    static let shared = NodePairingApprovalPrompter()

    private let logger = Logger(subsystem: "ai.openclaw", category: "node-pairing")
    private let gateway: GatewayConnection
    private let center: PairingApprovalCenter
    private var source: PairingPromptSupport.Source?
    private var task: Task<Void, Never>?
    private var reconcileTask: Task<Void, Never>?
    private var reconcileOnceTask: Task<Void, Never>?
    private var queue: [PendingRequest] = []
    var pendingCount: Int = 0
    /// Node ids already paired on the gateway (from the last list fetch);
    /// drives the "previously paired" trust signal on cards.
    private var pairedNodeIds: Set<String> = []
    /// Requests that arrived via push after the last list fetch; their trust
    /// state is unknown until fresh gateway truth applies (stale snapshots
    /// must not produce a positive "previously paired" claim).
    private var trustUnknownRequestIds: Set<String> = []
    private var autoApproveAttempts: Set<String> = []
    /// Requests hidden from the panel while a silent/local auto-approve runs.
    private var autoApproveInFlight: Set<String> = []
    /// The gateway broadcasts `node.pair.resolved` before our approve/reject
    /// RPC returns. Ids here mark decisions whose RPC is still in flight;
    /// resolutions echoed for them are parked in
    /// `echoedResolutionsByRequestId` so the awaiting path can report the
    /// authoritative outcome exactly once (another operator may win the race
    /// with the opposite decision).
    private var pendingLocalDecisionRequestIds: Set<String> = []
    private var echoedResolutionsByRequestId: [String: PairingResolution] = [:]

    private struct PairingList: Codable {
        let pending: [PendingRequest]
        let paired: [PairedNode]?
    }

    private struct PairedNode: Codable, Equatable {
        let nodeId: String
        let approvedAtMs: Double?
        let displayName: String?
        let platform: String?
        let version: String?
        let remoteIp: String?
    }

    struct PendingRequest: Codable, Equatable, Identifiable {
        let requestId: String
        let nodeId: String
        let displayName: String?
        let platform: String?
        let version: String?
        let coreVersion: String?
        let deviceFamily: String?
        let modelIdentifier: String?
        let caps: [String]?
        let commands: [String]?
        let remoteIp: String?
        let silent: Bool?
        let ts: Double
        var requiredApproveScopes: [String]?

        var id: String {
            self.requestId
        }
    }

    private typealias PairingResolvedEvent = PairingPromptSupport.PairingResolvedEvent
    private typealias PairingResolution = PairingPromptSupport.PairingResolution

    init(gateway: GatewayConnection = .shared, center: PairingApprovalCenter = .shared) {
        self.gateway = gateway
        self.center = center
    }

    func start() {
        self.reconcileTask?.cancel()
        self.reconcileTask = nil
        self.center.register(kind: .node) { [weak self] card, decision in
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
        self.center.unregister(kind: .node)
    }

    private func replaceSource(_ source: PairingPromptSupport.Source?) {
        self.source?.retire()
        self.source = source
        self.queue.removeAll()
        self.pairedNodeIds.removeAll()
        self.reconcileTask?.cancel()
        self.reconcileTask = nil
        self.reconcileOnceTask?.cancel()
        self.reconcileOnceTask = nil
        self.updatePendingCounts()
        self.autoApproveAttempts.removeAll(keepingCapacity: false)
        self.autoApproveInFlight.removeAll(keepingCapacity: false)
        self.pendingLocalDecisionRequestIds.removeAll(keepingCapacity: false)
        self.echoedResolutionsByRequestId.removeAll(keepingCapacity: false)
        self.trustUnknownRequestIds.removeAll(keepingCapacity: false)
        self.syncCards()
    }

    private func owns(_ source: PairingPromptSupport.Source) -> Bool {
        self.source === source && source.isCurrent
    }

    private func loadPendingRequestsFromGateway(source: PairingPromptSupport.Source) async {
        // The gateway process may start slightly after the app. Retry a bit so
        // pending pairing prompts are still shown on launch.
        var delayMs: UInt64 = 200
        for attempt in 1...8 {
            guard !Task.isCancelled, self.owns(source) else { return }
            do {
                try await self.refreshPairingList(timeoutMs: 6000, source: source)
                guard self.owns(source) else { return }
                let pendingCount = self.queue.count
                guard pendingCount > 0 else { return }
                self.logger.info(
                    "loaded \(pendingCount, privacy: .public) pending node pairing request(s) on startup")
                return
            } catch {
                guard !Task.isCancelled, self.owns(source) else { return }
                if attempt == 8 {
                    self.logger
                        .error(
                            "failed to load pending pairing requests: \(error.localizedDescription, privacy: .public)")
                    return
                }
                try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
                delayMs = min(delayMs * 2, 2000)
            }
        }
    }

    private func reconcileLoop(source: PairingPromptSupport.Source) async {
        // Reconcile requests periodically so multiple running apps stay in sync
        // (e.g. close cards + notify if another machine approves/rejects via app or CLI).
        // Queue mutations own the task slot; an exiting loop cannot clear its replacement.
        while !Task.isCancelled, self.owns(source), self.shouldPoll {
            await self.reconcileOnce(timeoutMs: 2500, source: source)
            try? await Task.sleep(
                nanoseconds: NodePairingReconcilePolicy.activeIntervalMs * 1_000_000)
        }
    }

    private func refreshPairingList(timeoutMs: Double, source: PairingPromptSupport.Source) async throws {
        try await source.refreshList(method: "node.pair.list", timeoutMs: timeoutMs) { data in
            let list = try JSONDecoder().decode(PairingList.self, from: data)
            self.apply(list: list, source: source)
        }
    }

    private func apply(list: PairingList, source: PairingPromptSupport.Source) {
        guard self.owns(source) else { return }

        self.pairedNodeIds = Set((list.paired ?? []).map(\.nodeId))
        // This snapshot is authoritative for every pending request in it.
        self.trustUnknownRequestIds.removeAll()

        let pendingById = Dictionary(
            uniqueKeysWithValues: list.pending.map { ($0.requestId, $0) })

        // Enqueue any missing requests (covers missed pushes while reconnecting).
        for req in list.pending.sorted(by: { $0.ts < $1.ts }) {
            self.enqueue(req, source: source)
        }

        // Detect resolved requests (approved/rejected elsewhere).
        for req in self.queue where pendingById[req.requestId] == nil {
            let resolution = self.inferResolution(for: req, list: list)
            self.logger.info(
                """
                pairing request resolved elsewhere requestId=\(req.requestId, privacy: .public) \
                resolution=\(resolution.rawValue, privacy: .public)
                """)
            self.queue.removeAll { $0 == req }
            // Same coordination as handleResolved: while our own RPC is in
            // flight the awaiting path reports the outcome, not this one.
            if self.pendingLocalDecisionRequestIds.contains(req.requestId) {
                self.echoedResolutionsByRequestId[req.requestId] = resolution
            } else {
                Task { @MainActor in
                    await self.notify(resolution: resolution, request: req, via: "remote", source: source)
                }
            }
        }

        self.updatePendingCounts()
        self.syncCards()
        self.updateReconcileLoop()
    }

    private func inferResolution(for request: PendingRequest, list: PairingList) -> PairingResolution {
        let paired = list.paired ?? []
        guard let node = paired.first(where: { $0.nodeId == request.nodeId }) else {
            return .rejected
        }
        // A previously paired node stays in the paired list even when this
        // request was rejected; only an approval newer than the request proves approval.
        if let approvedAtMs = node.approvedAtMs {
            return approvedAtMs >= request.ts ? .approved : .rejected
        }
        return .approved
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
        case let .event(evt) where evt.event == "node.pair.requested":
            guard let payload = evt.payload else { return }
            do {
                let req = try GatewayPayloadDecoding.decode(payload, as: PendingRequest.self)
                source.invalidateList()
                self.trustUnknownRequestIds.insert(req.requestId)
                self.enqueue(req, source: source)
                self.syncCards()
                self.updateReconcileLoop()
                // Refresh the paired list now so the card's "previously
                // paired" trust signal reflects current gateway truth.
                self.scheduleReconcileOnce(delayMs: 0, source: source)
            } catch {
                self.logger
                    .error("failed to decode pairing request: \(error.localizedDescription, privacy: .public)")
            }
        case let .event(evt) where evt.event == "node.pair.resolved":
            guard let payload = evt.payload else { return }
            do {
                let resolved = try GatewayPayloadDecoding.decode(payload, as: PairingResolvedEvent.self)
                self.handleResolved(resolved, source: source)
            } catch {
                self.logger
                    .error(
                        "failed to decode pairing resolution: \(error.localizedDescription, privacy: .public)")
            }
        case .snapshot:
            Task { await self.loadPendingRequestsFromGateway(source: source) }
        case .seqGap:
            source.invalidateList()
            self.scheduleReconcileOnce(source: source)
        default:
            return
        }
    }

    private func enqueue(_ req: PendingRequest, source: PairingPromptSupport.Source) {
        if let index = self.queue.firstIndex(where: { $0.requestId == req.requestId }) {
            // A fresh list can add approval requirements absent from an older
            // Gateway's push; refresh its metadata without repeating auto-approval.
            self.queue[index] = req
            return
        }
        // The gateway keeps at most one live pending request per node; a newer
        // request supersedes queued ones so missed resolve pushes cannot stack
        // stale cards.
        self.queue.removeAll { $0.nodeId == req.nodeId }
        self.queue.append(req)
        self.updatePendingCounts()
        self.beginAutoApproveIfEligible(req, source: source)
    }

    /// Auto-approve runs before the request surfaces in the panel: the app's
    /// own local node pairs silently, and `silent` requests are approved after
    /// an SSH trust probe. Only failed attempts fall through to the UI.
    private func beginAutoApproveIfEligible(_ req: PendingRequest, source: PairingPromptSupport.Source) {
        guard !self.autoApproveAttempts.contains(req.requestId) else { return }
        guard self.isAutoApproveCandidate(req) else { return }
        self.autoApproveInFlight.insert(req.requestId)
        Task { @MainActor [weak self] in
            guard let self, self.owns(source) else { return }
            let approved = await self.tryAutomaticApproveIfPossible(req, source: source)
            guard self.owns(source) else { return }
            self.autoApproveInFlight.remove(req.requestId)
            if approved {
                self.queue.removeAll { $0.requestId == req.requestId }
                self.updatePendingCounts()
            }
            self.syncCards()
            self.updateReconcileLoop()
        }
    }

    private func isAutoApproveCandidate(_ req: PendingRequest) -> Bool {
        if req.silent == true {
            return true
        }
        guard let localNodeId = DeviceIdentityStore.loadOrCreatePersisted(
            profile: MacNodeModeCoordinator.nodeIdentityProfile)?.deviceId
        else { return false }
        return Self.shouldAutoApproveOwnLocalNode(
            connectionMode: AppStateStore.shared.connectionMode,
            requestNodeId: req.nodeId,
            localNodeId: localNodeId)
    }

    private func syncCards() {
        // A pending local decision hides the card immediately (the decision is
        // optimistic); the failure path re-syncs so the card can come back.
        let cards = self.queue
            .filter {
                !self.autoApproveInFlight.contains($0.requestId) &&
                    !self.pendingLocalDecisionRequestIds.contains($0.requestId)
            }
            .map { self.card(for: $0) }
        self.center.sync(kind: .node, cards: cards)
    }

    private func card(for req: PendingRequest) -> PairingApprovalCenter.Card {
        PairingApprovalCenter.Card(
            kind: .node,
            requestId: req.requestId,
            subjectId: req.nodeId,
            displayName: req.displayName,
            platform: req.platform,
            deviceFamily: req.deviceFamily,
            modelIdentifier: req.modelIdentifier,
            version: req.version,
            coreVersion: req.coreVersion,
            remoteIp: req.remoteIp,
            role: nil,
            scopes: [],
            caps: req.caps ?? [],
            commands: req.commands ?? [],
            isRepair: false,
            previouslyPaired: self.trustUnknownRequestIds.contains(req.requestId)
                ? nil
                : self.pairedNodeIds.contains(req.nodeId),
            requestedAt: Date(timeIntervalSince1970: req.ts / 1000),
            requiredApproveScopes: req.requiredApproveScopes,
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
        // round-trip; the outcome arrives as a notification instead.
        self.syncCards()
        let expected: PairingResolution = decision == .approve ? .approved : .rejected
        let rpcOk = await PairingPromptSupport.decide(
            requestId: request.requestId, kind: .node, decision: decision, source: source, logger: self.logger)
        guard self.owns(source) else { return }
        source.invalidateList()
        self.pendingLocalDecisionRequestIds.remove(request.requestId)

        if let echoed = self.echoedResolutionsByRequestId.removeValue(forKey: request.requestId) {
            // The gateway resolved this request while our RPC was in flight
            // (possibly another operator with the opposite decision); report
            // the authoritative outcome, not what the user asked for.
            let via = rpcOk && echoed == expected ? "local" : "remote"
            await self.notify(resolution: echoed, request: request, via: via, source: source)
        } else if rpcOk {
            await self.notify(resolution: expected, request: request, via: "local", source: source)
        } else {
            // RPC failed and nothing resolved it elsewhere: bring the card
            // back, tell the user the optimistic dismiss did not stick, and
            // re-sync with gateway truth instead of claiming an outcome.
            self.syncCards()
            await PairingPromptSupport.notifyDecisionFailed(
                kind: .node,
                decision: decision,
                source: source,
                subject: PairingPromptSupport.subjectLabel(
                    displayName: request.displayName,
                    fallback: request.nodeId))
            guard self.owns(source) else { return }
            self.scheduleReconcileOnce(delayMs: 0, source: source)
            return
        }

        guard self.owns(source) else { return }
        self.queue.removeAll { $0.requestId == request.requestId }
        self.updatePendingCounts()
        self.syncCards()
        self.updateReconcileLoop()
    }

    private func notify(
        resolution: PairingResolution,
        request: PendingRequest,
        via: String,
        source: PairingPromptSupport.Source) async
    {
        guard self.owns(source) else { return }

        let title = resolution == .approved ? "Node pairing approved" : "Node pairing rejected"
        let device = PairingPromptSupport.subjectLabel(
            displayName: request.displayName,
            fallback: request.nodeId)
        let body = "\(device)\n(via \(via))"

        _ = await NotificationManager().send(
            title: title,
            body: body,
            sound: nil,
            priority: .active,
            requestPermission: false,
            isCurrent: { self.owns(source) })
    }

    struct SSHTarget: Equatable {
        let host: String
        let port: Int
    }

    private func tryAutomaticApproveIfPossible(
        _ req: PendingRequest,
        source: PairingPromptSupport.Source) async -> Bool
    {
        guard self.owns(source) else { return false }
        guard let localNodeId = DeviceIdentityStore.loadOrCreatePersisted(
            profile: MacNodeModeCoordinator.nodeIdentityProfile)?.deviceId
        else {
            self.logger.error(
                "automatic pairing skipped (device identity unavailable) requestId=\(req.requestId, privacy: .public)")
            return false
        }
        if Self.shouldAutoApproveOwnLocalNode(
            connectionMode: AppStateStore.shared.connectionMode,
            requestNodeId: req.nodeId,
            localNodeId: localNodeId)
        {
            guard self.beginAutoApproveAttempt(requestId: req.requestId) else { return false }
            return await self.approveAutomatically(req, via: "local-node", notify: false, source: source)
        }

        guard req.silent == true else { return false }
        guard self.beginAutoApproveAttempt(requestId: req.requestId) else { return false }

        guard let target = await self.resolveSSHTarget(source: source), self.owns(source) else {
            self.logger.info("silent pairing skipped (no ssh target) requestId=\(req.requestId, privacy: .public)")
            return false
        }

        let user = NSUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !user.isEmpty else {
            self.logger.info("silent pairing skipped (missing local user) requestId=\(req.requestId, privacy: .public)")
            return false
        }

        let ok = await Self.probeSSH(user: user, host: target.host, port: target.port)
        guard self.owns(source) else {
            self.logger.info("silent pairing probe result ignored after the Gateway connection changed")
            return false
        }
        if !ok {
            self.logger.info("silent pairing probe failed requestId=\(req.requestId, privacy: .public)")
            return false
        }

        return await self.approveAutomatically(req, via: "silent-ssh", notify: true, source: source)
    }

    private func approveAutomatically(
        _ req: PendingRequest, via: String, notify: Bool, source: PairingPromptSupport.Source) async -> Bool
    {
        guard self.owns(source) else { return false }
        self.pendingLocalDecisionRequestIds.insert(req.requestId)
        defer {
            if self.source === source {
                self.pendingLocalDecisionRequestIds.remove(req.requestId)
                self.echoedResolutionsByRequestId.removeValue(forKey: req.requestId)
            }
        }
        let approved = await PairingPromptSupport.decide(
            requestId: req.requestId, kind: .node, decision: .approve, source: source, logger: self.logger)
        guard self.owns(source) else { return false }
        source.invalidateList()
        guard approved else {
            self.logger.info("automatic pairing approve failed requestId=\(req.requestId, privacy: .public)")
            return false
        }

        self.logger.info(
            """
            automatically approved node pairing requestId=\(req.requestId, privacy: .public) \
            via=\(via, privacy: .public)
            """)
        if notify {
            await self.notify(resolution: .approved, request: req, via: via, source: source)
        }
        return true
    }

    private func beginAutoApproveAttempt(requestId: String) -> Bool {
        self.autoApproveAttempts.insert(requestId).inserted
    }

    static func shouldAutoApproveOwnLocalNode(
        connectionMode: AppState.ConnectionMode,
        requestNodeId: String,
        localNodeId: String) -> Bool
    {
        // The signed node identity is the same app-owned node already connecting to this Mac's Gateway.
        // Keep remote and mismatched identities on the explicit approval path.
        connectionMode == .local && requestNodeId == localNodeId
    }

    private func resolveSSHTarget(source: PairingPromptSupport.Source) async -> SSHTarget? {
        let settings = CommandResolver.connectionSettings()
        let gatewayURL = source.lease.route.url
        let user = NSUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        if settings.mode == .remote, settings.transport == .ssh {
            return Self.silentPairingSSHTarget(
                settings: settings, gatewayURL: gatewayURL, gateways: [], preferredStableID: nil, user: user)
        }

        let model = GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName)
        model.start()
        defer { model.stop() }

        let deadline = Date().addingTimeInterval(5.0)
        while self.owns(source), Date() < deadline {
            if let target = Self.silentPairingSSHTarget(
                settings: settings,
                gatewayURL: gatewayURL,
                gateways: model.gateways,
                preferredStableID: GatewayDiscoveryPreferences.preferredStableID(),
                user: user)
            {
                return target
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        return nil
    }

    static func silentPairingSSHTarget(
        settings: CommandResolver.RemoteSettings,
        gatewayURL: URL,
        gateways: [GatewayDiscoveryModel.DiscoveredGateway],
        preferredStableID: String?,
        user: String) -> SSHTarget?
    {
        if settings.mode == .remote, settings.transport == .ssh {
            guard let parsed = CommandResolver.parseSSHTarget(settings.target) else { return nil }
            if let targetUser = parsed.user,
               !targetUser.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               targetUser != user
            {
                return nil
            }
            let host = parsed.host.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !host.isEmpty else { return nil }
            return SSHTarget(host: host, port: parsed.port > 0 ? parsed.port : 22)
        }
        // SSH proves ownership only of the server behind this captured route.
        // Dormant SSH settings and unrelated Bonjour entries cannot authorize it.
        guard let owner = try? MacGatewayProfileStore.canonicalURL(gatewayURL) else { return nil }
        let matches = gateways.filter {
            guard let raw = GatewayDiscoveryHelpers.directUrl(for: $0), let url = URL(string: raw) else { return false }
            return (try? MacGatewayProfileStore.canonicalURL(url)) == owner
        }
        let gateway = matches.first { $0.stableID == preferredStableID } ?? matches.first
        guard let gateway else { return nil }
        guard let target = GatewayDiscoveryHelpers.sshTarget(for: gateway),
              let parsed = CommandResolver.parseSSHTarget(target)
        else {
            return nil
        }
        return SSHTarget(host: parsed.host, port: parsed.port)
    }

    private static func probeSSH(user: String, host: String, port: Int) async -> Bool {
        let options = self.silentPairingSSHOptions
        guard let target = CommandResolver.makeSSHTarget(user: user, host: host, port: port) else {
            return false
        }
        let args = CommandResolver.sshArguments(
            target: target,
            identity: "",
            options: options,
            remoteCommand: ["/usr/bin/true"])
        do {
            return try await BoundedProcess.run(
                path: "/usr/bin/ssh",
                arguments: args,
                timeout: 8).terminationStatus == 0
        } catch {
            return false
        }
    }

    private var shouldPoll: Bool {
        NodePairingReconcilePolicy.shouldPoll(pendingCount: self.queue.count)
    }

    private func updateReconcileLoop() {
        guard let source = self.source else { return }
        if self.shouldPoll {
            if self.reconcileTask == nil {
                self.reconcileTask = Task { [weak self] in
                    await self?.reconcileLoop(source: source)
                }
            }
        } else {
            self.reconcileTask?.cancel()
            self.reconcileTask = nil
        }
    }

    private func updatePendingCounts() {
        // Keep a cheap observable summary for the menu bar status line.
        self.pendingCount = self.queue.count
    }

    private func reconcileOnce(timeoutMs: Double, source: PairingPromptSupport.Source) async {
        do {
            try await self.refreshPairingList(timeoutMs: timeoutMs, source: source)
        } catch {
            // best effort: ignore transient connectivity failures
        }
    }

    private func scheduleReconcileOnce(
        delayMs: UInt64 = NodePairingReconcilePolicy.resyncDelayMs, source: PairingPromptSupport.Source)
    {
        self.reconcileOnceTask?.cancel()
        self.reconcileOnceTask = Task { [weak self] in
            guard let self else { return }
            if delayMs > 0 {
                try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
            }
            guard !Task.isCancelled else { return }
            await self.reconcileOnce(timeoutMs: 2500, source: source)
        }
    }

    private func handleResolved(_ resolved: PairingResolvedEvent, source: PairingPromptSupport.Source) {
        source.invalidateList()
        let resolution: PairingResolution =
            resolved.decision == PairingResolution.approved.rawValue ? .approved : .rejected

        guard let request = self.queue.first(where: { $0.requestId == resolved.requestId }) else {
            return
        }
        self.queue.removeAll { $0.requestId == resolved.requestId }
        self.updatePendingCounts()
        self.syncCards()
        if self.pendingLocalDecisionRequestIds.contains(resolved.requestId) {
            // Our own approve/reject RPC is still in flight; park the
            // authoritative outcome for that path to report exactly once.
            self.echoedResolutionsByRequestId[resolved.requestId] = resolution
        } else {
            Task { @MainActor in
                await self.notify(resolution: resolution, request: request, via: "remote", source: source)
            }
        }
        self.updateReconcileLoop()
    }
}

#if DEBUG
@MainActor
extension NodePairingApprovalPrompter {
    static func _testSilentPairingSSHOptions() -> [String] {
        self.silentPairingSSHOptions
    }
}
#endif
