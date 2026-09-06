import Foundation

@MainActor
final class GatewayMenuStatusStore {
    typealias Probe = (version: String?, buildId: String?, latencyMs: Double)

    struct Facts: Equatable, Sendable {
        var version: String?
        var buildId: String?
        var latencyMs: Double?
        var health: DashboardGatewayHealth = .unknown
        var lastSeen: Date?
        var probedAt: Date?
    }

    private(set) var facts: [DashboardGatewayTarget: Facts] = [:]
    private var probingTargets: Set<DashboardGatewayTarget> = []
    private var startedTargets: Set<DashboardGatewayTarget> = []
    private var generation: UInt64 = 0
    private var probeTask: Task<Void, Never>?
    private var cleanupTasks: [String: (generation: UInt64, task: Task<Void, Never>)] = [:]
    private let primaryProbe: @MainActor @Sendable () async throws -> Probe
    private let profileProbe: @MainActor @Sendable (String) async throws -> Probe
    private let disconnectProfile: @MainActor @Sendable (String) async -> Void

    init(
        primaryProbe: @escaping @MainActor @Sendable () async throws -> Probe = {
            let start = Date()
            _ = try await ControlChannel.shared.health(timeout: 3)
            let latency = ControlChannel.shared.lastPingMs ?? Date().timeIntervalSince(start) * 1000
            let snapshot = GatewayConnection.shared.lastSnapshot
            return (
                snapshot?.server["version"]?.value as? String,
                snapshot?.server["buildId"]?.value as? String,
                latency)
        },
        profileProbe: @escaping @MainActor @Sendable (String) async throws -> Probe = { profileID in
            let connection = await MacGatewayConnectionFleet.shared.connection(profileID: profileID)
            try Task.checkCancellation()
            // The first request may include connecting; time a second one so the
            // card shows the warm round-trip like the primary's lastPingMs.
            _ = try await connection.request(
                method: "health", params: nil, timeoutMs: 3000, retryTransportFailures: false)
            try Task.checkCancellation()
            let start = Date()
            _ = try await connection.request(
                method: "health", params: nil, timeoutMs: 3000, retryTransportFailures: false)
            let latency = Date().timeIntervalSince(start) * 1000
            let snapshot = connection.lastSnapshot
            return (
                snapshot?.server["version"]?.value as? String,
                snapshot?.server["buildId"]?.value as? String,
                latency)
        },
        disconnectProfile: @escaping @MainActor @Sendable (String) async -> Void = { profileID in
            await MacGatewayConnectionFleet.shared.disconnect(profileID: profileID, ifCurrent: { !Task.isCancelled })
        })
    {
        self.primaryProbe = primaryProbe
        self.profileProbe = profileProbe
        self.disconnectProfile = disconnectProfile
    }

    func isProbing(_ target: DashboardGatewayTarget) -> Bool {
        self.probingTargets.contains(target)
    }

    func beginProbing(targets: [DashboardGatewayTarget], onChange: @escaping @MainActor () -> Void) {
        guard self.probeTask == nil else { return }
        self.generation &+= 1
        let generation = self.generation
        self.probingTargets = Set(targets)
        self.startedTargets.removeAll()
        for case let .profile(profileID) in targets {
            self.cleanupTasks.removeValue(forKey: profileID)?.task.cancel()
        }
        self.probeTask = Task {
            await withTaskGroup(of: Void.self) { group in
                for target in Set(targets) {
                    group.addTask {
                        await self.probe(target, generation: generation, onChange: onChange)
                    }
                }
            }
            if self.generation == generation {
                self.probeTask = nil
            }
        }
    }

    func endProbing(openWindowCount: @escaping @MainActor (DashboardGatewayTarget) -> Int) {
        let task = self.probeTask
        task?.cancel()
        self.probeTask = nil
        self.generation &+= 1
        let generation = self.generation
        self.probingTargets.removeAll()
        let targets = self.startedTargets
        self.startedTargets.removeAll()
        for case let .profile(profileID) in targets {
            self.cleanupTasks[profileID]?.task.cancel()
            let cleanup = Task {
                // Drain canceled probes before disconnecting: a delayed profile
                // lookup must not establish a socket after menu cleanup finishes.
                await task?.value
                guard !Task.isCancelled else { return }
                if openWindowCount(.profile(profileID)) == 0 {
                    await self.disconnectProfile(profileID)
                }
                if self.cleanupTasks[profileID]?.generation == generation {
                    self.cleanupTasks.removeValue(forKey: profileID)
                }
            }
            self.cleanupTasks[profileID] = (generation, cleanup)
        }
    }

    private func probe(
        _ target: DashboardGatewayTarget,
        generation: UInt64,
        onChange: @MainActor () -> Void) async
    {
        guard self.generation == generation, !Task.isCancelled else { return }
        self.startedTargets.insert(target)
        let result: Result<Probe, Error>
        do {
            let probe = switch target {
            case .primary: try await self.primaryProbe()
            case let .profile(profileID): try await self.profileProbe(profileID)
            }
            result = .success(probe)
        } catch {
            result = .failure(error)
        }
        guard self.generation == generation, !Task.isCancelled else { return }
        var facts = self.facts[target] ?? Facts()
        let now = Date()
        facts.probedAt = now
        switch result {
        case let .success(probe):
            facts.version = probe.version
            facts.buildId = probe.buildId
            facts.latencyMs = probe.latencyMs
            facts.health = .ok
            facts.lastSeen = now
        case .failure:
            facts.health = .error
            facts.latencyMs = nil
        }
        self.facts[target] = facts
        self.probingTargets.remove(target)
        onChange()
    }
}
