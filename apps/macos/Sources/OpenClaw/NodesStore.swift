import Foundation
import Observation
import OpenClawKit
import OSLog

struct NodeInfo: Identifiable, Decodable {
    let nodeId: String
    let displayName: String?
    let platform: String?
    let version: String?
    let coreVersion: String?
    let uiVersion: String?
    let deviceFamily: String?
    let modelIdentifier: String?
    let remoteIp: String?
    let caps: [String]?
    let commands: [String]?
    let permissions: [String: Bool]?
    let paired: Bool?
    let connected: Bool?

    var id: String {
        self.nodeId
    }

    var isConnected: Bool {
        self.connected ?? false
    }

    var isPaired: Bool {
        self.paired ?? false
    }
}

private struct NodeListResponse: Decodable {
    let ts: Double?
    let nodes: [NodeInfo]
}

enum LocalNodeIdentityState: Equatable {
    case loading
    case available(String)
    case unavailable
}

@MainActor
@Observable
final class NodesStore {
    static let shared = NodesStore()

    private struct GatewayState {
        let revision: UInt64?
        var lease: GatewayConnection.ServerLease?
        var nodes: [NodeInfo] = []
        var error: String?
        var message: String?
    }

    private final class Refresh {
        let revision: UInt64?
        var lease: GatewayConnection.ServerLease?
        var task: Task<Void, Never>?

        init(revision: UInt64?) {
            self.revision = revision
        }
    }

    private var gatewayState: GatewayState?
    private var refreshOperation: Refresh?
    private var eventTask: Task<Void, Never>?

    /// AppKit reads cached rows before starting a refresh. Project their captured
    /// owner synchronously, while preserving the same Gateway across reconnects.
    private var currentState: GatewayState? {
        guard let state = self.gatewayState,
              state.revision == self.gateway.selectedEndpointRevision,
              state.lease.map(self.gateway.serverLeaseMatchesCurrentRoute) != false
        else { return nil }
        return state
    }

    var nodes: [NodeInfo] {
        self.currentState?.nodes ?? []
    }

    var lastError: String? {
        get { self.currentState?.error }
        set {
            var state = self.currentState ?? GatewayState(revision: self.gateway.selectedEndpointRevision)
            state.error = newValue
            self.gatewayState = state
        }
    }

    var statusMessage: String? {
        self.currentState?.message
    }

    let persistentServiceNotice: String?
    var isLoading: Bool {
        self.refreshOperation.map(self.isCurrent) ?? false
    }

    private(set) var localNodeIdentityState: LocalNodeIdentityState = .loading

    private let control: ControlChannel
    private var gateway: GatewayConnection {
        self.control.gateway
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "nodes")
    private var task: Task<Void, Never>?
    private let interval: TimeInterval = 30
    private let localNodeIdentityProfile: GatewayDeviceIdentityProfile
    @ObservationIgnored private let localNodeIDLoader: @Sendable (GatewayDeviceIdentityProfile) -> String?
    @ObservationIgnored private var localNodeIdentityLoad:
        (generation: UInt64, task: Task<String?, Never>)?
    @ObservationIgnored private var localNodeIdentityLoadGeneration: UInt64 = 0
    @ObservationIgnored private var localNodeIdentityPreparationTask: Task<Void, Never>?

    init(
        control: ControlChannel = .shared,
        appProfile: AppProfile = .current,
        localNodeIdentityProfile: GatewayDeviceIdentityProfile = MacNodeModeCoordinator.nodeIdentityProfile,
        localNodeIDLoader: @escaping @Sendable (GatewayDeviceIdentityProfile) -> String? = { profile in
            DeviceIdentityStore.loadOrCreatePersisted(profile: profile)?.deviceId
        })
    {
        self.control = control
        self.persistentServiceNotice = appProfile.isActive
            ? "Persistent Mac node service unavailable under app profile; runtime node remains available."
            : nil
        self.localNodeIdentityProfile = localNodeIdentityProfile
        self.localNodeIDLoader = localNodeIDLoader
    }

    func start() {
        guard self.task == nil else { return }
        self.scheduleLocalNodeIdentityPreparation()
        GatewayPushSubscription.restartTask(task: &self.eventTask, connection: self.gateway) { [weak self] delivery in
            self?.handle(delivery)
        }
        SimpleTaskSupport.startDetachedLoop(task: &self.task, interval: self.interval) { [weak self] in
            await self?.refresh()
        }
    }

    func stop() {
        SimpleTaskSupport.stop(task: &self.task)
        SimpleTaskSupport.stop(task: &self.eventTask)
        self.cancelRefresh()
    }

    isolated deinit {
        self.task?.cancel()
        self.eventTask?.cancel()
        self.refreshOperation?.task?.cancel()
    }

    private func handle(_ delivery: GatewayConnection.PushDelivery) {
        // Discard retired data at the delivery boundary while keeping the cache
        // across reconnects to the same logical Gateway.
        if self.gatewayState != nil, self.currentState == nil {
            self.gatewayState = nil
        }
        guard let push = delivery.push else {
            if self.refreshOperation?.lease == delivery.serverLease { self.cancelRefresh() }
            return
        }
        switch push {
        case .snapshot:
            // Acquisition receives its own hello before dispatching node.list;
            // restarting that read would turn each connection into a second fetch.
            if let refresh = self.refreshOperation, self.isCurrent(refresh),
               refresh.lease == nil || refresh.lease == delivery.serverLease { return }
            if self.currentState?.lease == delivery.serverLease { return }
        case .seqGap:
            break
        default:
            return
        }
        self.cancelRefresh()
        _ = self.beginRefresh()
    }

    private func scheduleLocalNodeIdentityPreparation() {
        guard self.localNodeIdentityPreparationTask == nil else { return }
        guard case .available = self.localNodeIdentityState else {
            // Retry on the node refresh lifecycle so transient storage failures recover
            // without moving identity I/O back into SwiftUI view evaluation.
            self.localNodeIdentityPreparationTask = Task { [weak self] in
                guard let self else { return }
                await self.prepareLocalNodeIdentity()
                self.localNodeIdentityPreparationTask = nil
            }
            return
        }
    }

    func prepareLocalNodeIdentity() async {
        if case .available = self.localNodeIdentityState {
            return
        }

        let generation: UInt64
        let task: Task<String?, Never>
        if let load = self.localNodeIdentityLoad {
            generation = load.generation
            task = load.task
        } else {
            self.localNodeIdentityState = .loading
            self.localNodeIdentityLoadGeneration &+= 1
            generation = self.localNodeIdentityLoadGeneration
            let profile = self.localNodeIdentityProfile
            let loader = self.localNodeIDLoader
            task = Task.detached(priority: .utility) {
                loader(profile)
            }
            self.localNodeIdentityLoad = (generation, task)
        }

        let nodeID = await task.value
        guard self.localNodeIdentityLoad?.generation == generation else { return }
        self.localNodeIdentityLoad = nil
        self.localNodeIdentityState = nodeID.map(LocalNodeIdentityState.available) ?? .unavailable
    }

    func refresh() async {
        guard !Task.isCancelled else { return }
        let task = self.beginRefresh()
        await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    }

    private func beginRefresh() -> Task<Void, Never> {
        if let refresh = self.refreshOperation, self.isCurrent(refresh), let task = refresh.task { return task }
        self.cancelRefresh()
        self.scheduleLocalNodeIdentityPreparation()
        let refresh = Refresh(revision: self.gateway.selectedEndpointRevision)
        self.gatewayState = self.currentState ?? GatewayState(revision: refresh.revision)
        self.gatewayState?.message = nil
        let task = Task<Void, Never> { [weak self] in await self?.performRefresh(refresh) }
        refresh.task = task
        self.refreshOperation = refresh
        return task
    }

    private func cancelRefresh() {
        self.refreshOperation?.task?.cancel()
        self.refreshOperation = nil
    }

    private func isCurrent(_ refresh: Refresh) -> Bool {
        self.refreshOperation === refresh && refresh.task?.isCancelled != true &&
            refresh.revision == self.gateway.selectedEndpointRevision &&
            refresh.lease.map(self.gateway.serverLeaseMatchesCurrentState) != false
    }

    private func performRefresh(_ refresh: Refresh) async {
        defer {
            if self.refreshOperation === refresh { self.refreshOperation = nil }
        }
        guard self.isCurrent(refresh) else { return }
        do {
            let lease = try await self.control.acquireServerLease()
            guard self.isCurrent(refresh), self.gateway.serverLeaseMatchesCurrentState(lease) else { return }
            refresh.lease = lease
            let data = try await self.gateway.request(
                method: "node.list", params: nil, timeoutMs: 8000, ifCurrentServerLease: lease)
            guard self.isCurrent(refresh) else { return }
            let decoded = try JSONDecoder().decode(NodeListResponse.self, from: data)
            self.gatewayState = GatewayState(revision: refresh.revision, lease: lease, nodes: decoded.nodes)
        } catch {
            guard self.isCurrent(refresh) else { return }
            if Self.isCancelled(error) {
                self.logger.debug("node.list cancelled; keeping last nodes")
                // Finish the cache read before its optional mutation begins.
                let message = self.nodes.isEmpty ? "Refreshing devices…" : nil
                self.gatewayState?.message = message
                self.gatewayState?.error = nil
                return
            }
            self.logger.error("node.list failed \(error.localizedDescription, privacy: .public)")
            self.gatewayState = GatewayState(
                revision: refresh.revision, lease: refresh.lease, error: error.localizedDescription)
        }
    }

    private static func isCancelled(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let urlError = error as? URLError, urlError.code == .cancelled { return true }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return true }
        return false
    }
}
