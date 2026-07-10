import AppKit
import Foundation
import Observation
import OpenClawDiscovery
import OpenClawIPC
import OpenClawKit
import OpenClawProtocol
import OSLog
import UserNotifications

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
    private var task: Task<Void, Never>?
    private var reconcileTask: Task<Void, Never>?
    private var reconcileOnceTask: Task<Void, Never>?
    private var reconcileInFlight = false
    private var isStopping = false
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

        var id: String {
            self.requestId
        }
    }

    private typealias PairingResolvedEvent = PairingPromptSupport.PairingResolvedEvent
    private typealias PairingResolution = PairingPromptSupport.PairingResolution

    func start() {
        self.reconcileTask?.cancel()
        self.reconcileTask = nil
        PairingApprovalCenter.shared.register(kind: .node) { [weak self] card, decision in
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
        PairingApprovalCenter.shared.unregister(kind: .node)
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
    }

    private func loadPendingRequestsFromGateway() async {
        // The gateway process may start slightly after the app. Retry a bit so
        // pending pairing prompts are still shown on launch.
        var delayMs: UInt64 = 200
        for attempt in 1...8 {
            if Task.isCancelled { return }
            do {
                let data = try await GatewayConnection.shared.request(
                    method: "node.pair.list",
                    params: nil,
                    timeoutMs: 6000)
                guard !data.isEmpty else { return }
                let list = try JSONDecoder().decode(PairingList.self, from: data)
                let pendingCount = list.pending.count
                guard pendingCount > 0 else { return }
                self.logger.info(
                    "loaded \(pendingCount, privacy: .public) pending node pairing request(s) on startup")
                self.apply(list: list)
                return
            } catch {
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

    private func reconcileLoop() async {
        // Reconcile requests periodically so multiple running apps stay in sync
        // (e.g. close cards + notify if another machine approves/rejects via app or CLI).
        while !Task.isCancelled {
            if self.isStopping {
                break
            }
            if !self.shouldPoll {
                self.reconcileTask = nil
                return
            }
            await self.reconcileOnce(timeoutMs: 2500)
            try? await Task.sleep(
                nanoseconds: NodePairingReconcilePolicy.activeIntervalMs * 1_000_000)
        }
        self.reconcileTask = nil
    }

    private func fetchPairingList(timeoutMs: Double) async throws -> PairingList {
        let data = try await GatewayConnection.shared.request(
            method: "node.pair.list",
            params: nil,
            timeoutMs: timeoutMs)
        return try JSONDecoder().decode(PairingList.self, from: data)
    }

    private func apply(list: PairingList) {
        if self.isStopping {
            return
        }

        self.pairedNodeIds = Set((list.paired ?? []).map(\.nodeId))
        // This snapshot is authoritative for every pending request in it.
        self.trustUnknownRequestIds.removeAll()

        let pendingById = Dictionary(
            uniqueKeysWithValues: list.pending.map { ($0.requestId, $0) })

        // Enqueue any missing requests (covers missed pushes while reconnecting).
        for req in list.pending.sorted(by: { $0.ts < $1.ts }) {
            self.enqueue(req)
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
                    await self.notify(resolution: resolution, request: req, via: "remote")
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

    private func handle(push: GatewayPush) {
        switch push {
        case let .event(evt) where evt.event == "node.pair.requested":
            guard let payload = evt.payload else { return }
            do {
                let req = try GatewayPayloadDecoding.decode(payload, as: PendingRequest.self)
                self.trustUnknownRequestIds.insert(req.requestId)
                self.enqueue(req)
                self.syncCards()
                self.updateReconcileLoop()
                // Refresh the paired list now so the card's "previously
                // paired" trust signal reflects current gateway truth.
                self.scheduleReconcileOnce(delayMs: 0)
            } catch {
                self.logger
                    .error("failed to decode pairing request: \(error.localizedDescription, privacy: .public)")
            }
        case let .event(evt) where evt.event == "node.pair.resolved":
            guard let payload = evt.payload else { return }
            do {
                let resolved = try GatewayPayloadDecoding.decode(payload, as: PairingResolvedEvent.self)
                self.handleResolved(resolved)
            } catch {
                self.logger
                    .error(
                        "failed to decode pairing resolution: \(error.localizedDescription, privacy: .public)")
            }
        case .snapshot:
            self.scheduleReconcileOnce(delayMs: 0)
        case .seqGap:
            self.scheduleReconcileOnce()
        default:
            return
        }
    }

    private func enqueue(_ req: PendingRequest) {
        if self.queue.contains(where: { $0.requestId == req.requestId }) {
            return
        }
        // The gateway keeps at most one live pending request per node; a newer
        // request supersedes queued ones so missed resolve pushes cannot stack
        // stale cards.
        self.queue.removeAll { $0.nodeId == req.nodeId }
        self.queue.append(req)
        self.updatePendingCounts()
        self.beginAutoApproveIfEligible(req)
    }

    /// Auto-approve runs before the request surfaces in the panel: the app's
    /// own local node pairs silently, and `silent` requests are approved after
    /// an SSH trust probe. Only failed attempts fall through to the UI.
    private func beginAutoApproveIfEligible(_ req: PendingRequest) {
        guard !self.autoApproveAttempts.contains(req.requestId) else { return }
        guard self.isAutoApproveCandidate(req) else { return }
        self.autoApproveInFlight.insert(req.requestId)
        Task { @MainActor [weak self] in
            guard let self else { return }
            let approved = await self.tryAutomaticApproveIfPossible(req)
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
        let localNodeId = DeviceIdentityStore.loadOrCreate(
            profile: MacNodeModeCoordinator.nodeIdentityProfile).deviceId
        return Self.shouldAutoApproveOwnLocalNode(
            connectionMode: AppStateStore.shared.connectionMode,
            requestNodeId: req.nodeId,
            localNodeId: localNodeId)
    }

    private func syncCards() {
        guard !self.isStopping else { return }
        let cards = self.queue
            .filter { !self.autoApproveInFlight.contains($0.requestId) }
            .map { self.card(for: $0) }
        PairingApprovalCenter.shared.sync(kind: .node, cards: cards)
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
            requestedAt: Date(timeIntervalSince1970: req.ts / 1000))
    }

    private func handleDecision(card: PairingApprovalCenter.Card, decision: PairingApprovalCenter.Decision) async {
        guard !self.isStopping else { return }
        guard let request = self.queue.first(where: { $0.requestId == card.requestId }) else { return }

        self.pendingLocalDecisionRequestIds.insert(request.requestId)
        let expected: PairingResolution = decision == .approve ? .approved : .rejected
        let rpcOk: Bool = switch decision {
        case .approve:
            await self.approve(requestId: request.requestId)
        case .reject:
            await self.reject(requestId: request.requestId)
        }
        self.pendingLocalDecisionRequestIds.remove(request.requestId)

        if let echoed = self.echoedResolutionsByRequestId.removeValue(forKey: request.requestId) {
            // The gateway resolved this request while our RPC was in flight
            // (possibly another operator with the opposite decision); report
            // the authoritative outcome, not what the user asked for.
            let via = rpcOk && echoed == expected ? "local" : "remote"
            await self.notify(resolution: echoed, request: request, via: via)
        } else if rpcOk {
            await self.notify(resolution: expected, request: request, via: "local")
        } else {
            // RPC failed and nothing resolved it elsewhere: keep the card and
            // re-sync with gateway truth instead of claiming an outcome.
            self.scheduleReconcileOnce(delayMs: 0)
            return
        }

        self.queue.removeAll { $0.requestId == request.requestId }
        self.updatePendingCounts()
        self.syncCards()
        self.updateReconcileLoop()
    }

    private func approve(requestId: String) async -> Bool {
        await PairingPromptSupport.approveRequest(
            requestId: requestId,
            kind: "node",
            logger: self.logger)
        {
            try await GatewayConnection.shared.nodePairApprove(requestId: requestId)
        }
    }

    private func reject(requestId: String) async -> Bool {
        await PairingPromptSupport.rejectRequest(
            requestId: requestId,
            kind: "node",
            logger: self.logger)
        {
            try await GatewayConnection.shared.nodePairReject(requestId: requestId)
        }
    }

    private func notify(resolution: PairingResolution, request: PendingRequest, via: String) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized ||
            settings.authorizationStatus == .provisional
        else {
            return
        }

        let title = resolution == .approved ? "Node pairing approved" : "Node pairing rejected"
        let name = request.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let device = name?.isEmpty == false ? name! : request.nodeId
        let body = "\(device)\n(via \(via))"

        _ = await NotificationManager().send(
            title: title,
            body: body,
            sound: nil,
            priority: .active)
    }

    private struct SSHTarget {
        let host: String
        let port: Int
    }

    private func tryAutomaticApproveIfPossible(_ req: PendingRequest) async -> Bool {
        let localNodeId = DeviceIdentityStore.loadOrCreate(
            profile: MacNodeModeCoordinator.nodeIdentityProfile).deviceId
        if Self.shouldAutoApproveOwnLocalNode(
            connectionMode: AppStateStore.shared.connectionMode,
            requestNodeId: req.nodeId,
            localNodeId: localNodeId)
        {
            guard self.beginAutoApproveAttempt(requestId: req.requestId) else { return false }
            return await self.approveAutomatically(req, via: "local-node", notify: false)
        }

        guard req.silent == true else { return false }
        guard self.beginAutoApproveAttempt(requestId: req.requestId) else { return false }

        guard let target = await self.resolveSSHTarget() else {
            self.logger.info("silent pairing skipped (no ssh target) requestId=\(req.requestId, privacy: .public)")
            return false
        }

        let user = NSUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !user.isEmpty else {
            self.logger.info("silent pairing skipped (missing local user) requestId=\(req.requestId, privacy: .public)")
            return false
        }

        let ok = await Self.probeSSH(user: user, host: target.host, port: target.port)
        if !ok {
            self.logger.info("silent pairing probe failed requestId=\(req.requestId, privacy: .public)")
            return false
        }

        return await self.approveAutomatically(req, via: "silent-ssh", notify: true)
    }

    private func approveAutomatically(_ req: PendingRequest, via: String, notify: Bool) async -> Bool {
        self.pendingLocalDecisionRequestIds.insert(req.requestId)
        defer {
            self.pendingLocalDecisionRequestIds.remove(req.requestId)
            self.echoedResolutionsByRequestId.removeValue(forKey: req.requestId)
        }
        guard await self.approve(requestId: req.requestId) else {
            self.logger.info("automatic pairing approve failed requestId=\(req.requestId, privacy: .public)")
            return false
        }

        self.logger.info(
            """
            automatically approved node pairing requestId=\(req.requestId, privacy: .public) \
            via=\(via, privacy: .public)
            """)
        if notify {
            await self.notify(resolution: .approved, request: req, via: via)
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

    private func resolveSSHTarget() async -> SSHTarget? {
        let settings = CommandResolver.connectionSettings()
        if !settings.target.isEmpty, let parsed = CommandResolver.parseSSHTarget(settings.target) {
            let user = NSUserName().trimmingCharacters(in: .whitespacesAndNewlines)
            if let targetUser = parsed.user,
               !targetUser.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               targetUser != user
            {
                self.logger.info("silent pairing skipped (ssh user mismatch)")
                return nil
            }
            let host = parsed.host.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !host.isEmpty else { return nil }
            let port = parsed.port > 0 ? parsed.port : 22
            return SSHTarget(host: host, port: port)
        }

        let model = GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName)
        model.start()
        defer { model.stop() }

        let deadline = Date().addingTimeInterval(5.0)
        while model.gateways.isEmpty, Date() < deadline {
            try? await Task.sleep(nanoseconds: 200_000_000)
        }

        let preferred = GatewayDiscoveryPreferences.preferredStableID()
        let gateway = model.gateways.first { $0.stableID == preferred } ?? model.gateways.first
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
        return await Task.detached(priority: .utility) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")

            guard let target = CommandResolver.makeSSHTarget(user: user, host: host, port: port) else {
                return false
            }
            let args = CommandResolver.sshArguments(
                target: target,
                identity: "",
                options: options,
                remoteCommand: ["/usr/bin/true"])
            process.arguments = args
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe

            do {
                _ = try process.runAndReadToEnd(from: pipe)
            } catch {
                return false
            }
            return process.terminationStatus == 0
        }.value
    }

    private var shouldPoll: Bool {
        NodePairingReconcilePolicy.shouldPoll(pendingCount: self.queue.count)
    }

    private func updateReconcileLoop() {
        guard !self.isStopping else { return }
        if self.shouldPoll {
            if self.reconcileTask == nil {
                self.reconcileTask = Task { [weak self] in
                    await self?.reconcileLoop()
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

    private func reconcileOnce(timeoutMs: Double) async {
        if self.isStopping {
            return
        }
        if self.reconcileInFlight {
            return
        }
        self.reconcileInFlight = true
        defer { self.reconcileInFlight = false }
        do {
            let list = try await self.fetchPairingList(timeoutMs: timeoutMs)
            self.apply(list: list)
        } catch {
            // best effort: ignore transient connectivity failures
        }
    }

    private func scheduleReconcileOnce(delayMs: UInt64 = NodePairingReconcilePolicy.resyncDelayMs) {
        self.reconcileOnceTask?.cancel()
        self.reconcileOnceTask = Task { [weak self] in
            guard let self else { return }
            if delayMs > 0 {
                try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
            }
            await self.reconcileOnce(timeoutMs: 2500)
        }
    }

    private func handleResolved(_ resolved: PairingResolvedEvent) {
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
                await self.notify(resolution: resolution, request: request, via: "remote")
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

    static func exerciseForTesting() async {
        let prompter = NodePairingApprovalPrompter()
        let pending = PendingRequest(
            requestId: "req-1",
            nodeId: "node-1",
            displayName: "Node One",
            platform: "macos",
            version: "1.0.0",
            coreVersion: "1.0.0",
            deviceFamily: "Mac",
            modelIdentifier: "MacBookPro18,3",
            caps: ["screen"],
            commands: ["system.run"],
            remoteIp: "127.0.0.1",
            silent: true,
            ts: 1_700_000_000_000)
        let paired = PairedNode(
            nodeId: "node-1",
            approvedAtMs: 1_700_000_000_000,
            displayName: "Node One",
            platform: "macOS",
            version: "1.0.0",
            remoteIp: "127.0.0.1")
        let list = PairingList(pending: [pending], paired: [paired])

        _ = prompter.card(for: pending)
        _ = prompter.inferResolution(for: pending, list: list)

        prompter.queue = [pending]
        _ = prompter.shouldPoll
        _ = await prompter.tryAutomaticApproveIfPossible(pending)
        prompter.queue.removeAll()
    }
}
#endif
