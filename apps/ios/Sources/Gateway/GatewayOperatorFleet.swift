import Foundation
import Observation
import OpenClawKit

/// Keeps operator sessions for non-focused gateways live in the foreground.
/// The focused gateway remains owned by `NodeAppModel`, including its capability-bearing
/// node session. This fleet therefore cannot route camera, screen, or device commands.
@MainActor
@Observable
final class GatewayOperatorFleet {
    nonisolated static func backgroundStableIDs(
        connectedStableIDs: [String],
        focusedStableID: String?) -> [String]
    {
        var seen = Set<GatewayStableIdentifier.Key>()
        return connectedStableIDs.filter { stableID in
            guard !GatewayStableIdentifier.matches(stableID, focusedStableID),
                  let key = GatewayStableIdentifier.key(stableID)
            else { return false }
            return seen.insert(key).inserted
        }
    }

    enum ConnectionState: String, Sendable {
        case connecting
        case connected
        case offline
        case needsAttention
    }

    struct Status: Identifiable, Sendable, Equatable {
        let stableID: String
        var name: String
        var state: ConnectionState
        var detail: String?

        var id: String {
            self.stableID
        }
    }

    private final class Runtime {
        let id = UUID()
        let session = GatewayNodeSession()
        var config: GatewayConnectConfig
        var name: String
        var task: Task<Void, Never>?
        var isPausedForAttention = false

        init(config: GatewayConnectConfig, name: String) {
            self.config = config
            self.name = name
        }
    }

    private(set) var statuses: [Status] = []
    @ObservationIgnored private var runtimes: [GatewayStableIdentifier.Key: Runtime] = [:]

    func reconcile(
        desiredStableIDs: [String],
        configs: [(config: GatewayConnectConfig, name: String)])
    {
        let desiredKeys = Set(desiredStableIDs.compactMap(GatewayStableIdentifier.key))
        var desired: [GatewayStableIdentifier.Key: (GatewayConnectConfig, String)] = [:]
        for item in configs {
            guard let key = GatewayStableIdentifier.key(item.config.effectiveStableID),
                  desiredKeys.contains(key)
            else { continue }
            desired[key] = (item.config, item.name)
        }

        // Endpoint resolution is transient for discovered gateways. Keep a healthy runtime on
        // its last proven route until the user disables, forgets, or focuses that gateway.
        for key in self.runtimes.keys where !desiredKeys.contains(key) {
            self.stopRuntime(key: key)
        }
        for (key, item) in desired {
            if let runtime = self.runtimes[key],
               runtime.config.hasSameConnectionInputs(as: item.0),
               runtime.task != nil || runtime.isPausedForAttention
            {
                runtime.name = item.1
                self.setStatus(
                    stableID: item.0.effectiveStableID,
                    name: item.1,
                    preservingState: true)
                continue
            }
            self.stopRuntime(key: key)
            self.startRuntime(config: item.0, name: item.1, key: key)
        }
        self.sortStatuses()
    }

    func stop(stableID: String) {
        guard let key = GatewayStableIdentifier.key(stableID) else { return }
        self.stopRuntime(key: key)
    }

    func stopAll() {
        for key in Array(self.runtimes.keys) {
            self.stopRuntime(key: key)
        }
    }

    private func startRuntime(
        config: GatewayConnectConfig,
        name: String,
        key: GatewayStableIdentifier.Key)
    {
        let runtime = Runtime(config: config, name: name)
        self.runtimes[key] = runtime
        self.setStatus(
            stableID: config.effectiveStableID,
            name: name,
            state: .connecting,
            detail: nil)
        runtime.task = Task { @MainActor [weak self, weak runtime] in
            guard let self, let runtime else { return }
            await self.run(runtime: runtime, key: key)
        }
    }

    private func stopRuntime(key: GatewayStableIdentifier.Key) {
        guard let runtime = self.runtimes.removeValue(forKey: key) else { return }
        runtime.task?.cancel()
        runtime.task = nil
        self.statuses.removeAll { GatewayStableIdentifier.matches($0.stableID, runtime.config.effectiveStableID) }
        Task {
            await runtime.session.disconnect()
        }
    }

    private func run(runtime: Runtime, key: GatewayStableIdentifier.Key) async {
        var attempt = 0
        while !Task.isCancelled, self.runtimes[key]?.id == runtime.id {
            let config = runtime.config
            self.setStatus(
                stableID: config.effectiveStableID,
                name: runtime.name,
                state: attempt == 0 ? .connecting : .offline,
                detail: attempt == 0 ? nil : String(localized: "Reconnecting…"))

            let options = Self.operatorOptions(from: config.nodeOptions)
            let sessionBox = config.tls.map {
                WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0))
            }
            let runtimeID = runtime.id
            do {
                try await runtime.session.connect(
                    url: config.url,
                    credentials: GatewayNodeSessionCredentials(
                        token: config.token,
                        bootstrapToken: config.bootstrapToken,
                        password: config.password),
                    connectOptions: options,
                    sessionBox: sessionBox,
                    extraHeadersProvider: {
                        GatewaySettingsStore.loadGatewayCustomHeaders(
                            gatewayStableID: config.effectiveStableID)
                    },
                    onConnected: { [weak self] in
                        await MainActor.run {
                            guard let self, let runtime = self.runtimes[key], runtime.id == runtimeID else { return }
                            self.setStatus(
                                stableID: config.effectiveStableID,
                                name: runtime.name,
                                state: .connected,
                                detail: nil)
                            _ = GatewaySettingsStore.markGatewayConnected(
                                stableID: config.effectiveStableID,
                                atMs: Int(Date().timeIntervalSince1970 * 1000))
                        }
                    },
                    onDisconnected: { [weak self] reason in
                        await MainActor.run {
                            guard let self, let runtime = self.runtimes[key], runtime.id == runtimeID else { return }
                            self.setStatus(
                                stableID: config.effectiveStableID,
                                name: runtime.name,
                                state: .offline,
                                detail: reason)
                        }
                    },
                    onInvoke: { request in
                        BridgeInvokeResponse(
                            id: request.id,
                            ok: false,
                            error: OpenClawNodeError(
                                code: .invalidRequest,
                                message: "INVALID_REQUEST: background operator sessions cannot invoke node commands"))
                    })
                attempt = 0
                try await Task.sleep(for: .seconds(1))
            } catch is CancellationError {
                break
            } catch {
                guard !Task.isCancelled, self.runtimes[key]?.id == runtime.id else { break }
                attempt += 1
                let problem = GatewayConnectionProblemMapper.map(error: error)
                let pauses = problem?.pauseReconnect == true || problem?.needsPairingApproval == true
                runtime.isPausedForAttention = pauses
                self.setStatus(
                    stableID: config.effectiveStableID,
                    name: runtime.name,
                    state: pauses ? .needsAttention : .offline,
                    detail: problem?.message ?? error.localizedDescription)
                if pauses { break }
                let delay = min(pow(2.0, Double(min(attempt, 5))), 30.0)
                try? await Task.sleep(for: .seconds(delay))
            }
        }
        if self.runtimes[key]?.id == runtime.id {
            // A paused auth failure deliberately leaves its status visible, but the
            // finished task must not make a later reconciliation look connected.
            runtime.task = nil
        }
        await runtime.session.disconnect()
    }

    private static func operatorOptions(from nodeOptions: GatewayConnectOptions) -> GatewayConnectOptions {
        GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read", "operator.write", "operator.talk.secrets"],
            caps: [OpenClawGatewayClientCapability.inlineWidgets],
            commands: [],
            permissions: [:],
            clientId: nodeOptions.clientId,
            clientMode: "ui",
            clientDisplayName: nodeOptions.clientDisplayName,
            includeDeviceIdentity: true,
            allowStoredDeviceAuth: nodeOptions.allowStoredDeviceAuth,
            deviceAuthGatewayID: nodeOptions.deviceAuthGatewayID)
    }

    private func setStatus(
        stableID: String,
        name: String,
        state: ConnectionState? = nil,
        detail: String? = nil,
        preservingState: Bool = false)
    {
        if let index = self.statuses.firstIndex(where: {
            GatewayStableIdentifier.matches($0.stableID, stableID)
        }) {
            self.statuses[index].name = name
            if !preservingState, let state {
                self.statuses[index].state = state
                self.statuses[index].detail = detail
            }
        } else {
            self.statuses.append(Status(
                stableID: stableID,
                name: name,
                state: state ?? .offline,
                detail: detail))
        }
        self.sortStatuses()
    }

    private func sortStatuses() {
        self.statuses.sort { lhs, rhs in
            if lhs.name != rhs.name { return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending }
            return GatewayStableIdentifier.sortsBefore(lhs.stableID, rhs.stableID)
        }
    }
}

#if DEBUG
extension GatewayOperatorFleet {
    func _test_pauseRuntimeForAttention(stableID: String, detail: String = "Approval required") {
        guard let key = GatewayStableIdentifier.key(stableID),
              let runtime = self.runtimes[key]
        else { return }
        runtime.task?.cancel()
        runtime.task = nil
        runtime.isPausedForAttention = true
        self.setStatus(
            stableID: runtime.config.effectiveStableID,
            name: runtime.name,
            state: .needsAttention,
            detail: detail)
    }
}
#endif
