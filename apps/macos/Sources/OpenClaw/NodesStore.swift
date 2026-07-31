import Foundation
import Observation
import OpenClawKit
import OSLog

struct NodeInfo: Identifiable, Codable {
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

private struct NodeListResponse: Codable {
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

    var nodes: [NodeInfo] = []
    var lastError: String?
    var statusMessage: String?
    var isLoading = false
    private(set) var localNodeIdentityState: LocalNodeIdentityState = .loading

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
        localNodeIdentityProfile: GatewayDeviceIdentityProfile = MacNodeModeCoordinator.nodeIdentityProfile,
        localNodeIDLoader: @escaping @Sendable (GatewayDeviceIdentityProfile) -> String? = { profile in
            DeviceIdentityStore.loadOrCreatePersisted(profile: profile)?.deviceId
        })
    {
        self.localNodeIdentityProfile = localNodeIdentityProfile
        self.localNodeIDLoader = localNodeIDLoader
    }

    func start() {
        guard self.task == nil else { return }
        self.scheduleLocalNodeIdentityPreparation()
        SimpleTaskSupport.startDetachedLoop(task: &self.task, interval: self.interval) { [weak self] in
            await self?.refresh()
        }
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
        self.scheduleLocalNodeIdentityPreparation()
        if self.isLoading { return }
        self.statusMessage = nil
        self.isLoading = true
        defer { self.isLoading = false }
        do {
            let data = try await GatewayConnection.shared.requestRaw(method: "node.list", params: nil, timeoutMs: 8000)
            let decoded = try JSONDecoder().decode(NodeListResponse.self, from: data)
            self.nodes = decoded.nodes
            self.lastError = nil
            self.statusMessage = nil
        } catch {
            if Self.isCancelled(error) {
                self.logger.debug("node.list cancelled; keeping last nodes")
                if self.nodes.isEmpty {
                    self.statusMessage = "Refreshing devices…"
                }
                self.lastError = nil
                return
            }
            self.logger.error("node.list failed \(error.localizedDescription, privacy: .public)")
            self.nodes = []
            self.lastError = error.localizedDescription
            self.statusMessage = nil
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
