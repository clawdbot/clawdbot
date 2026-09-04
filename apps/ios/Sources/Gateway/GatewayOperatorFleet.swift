import Foundation
import OpenClawKit

/// Keeps operator sessions for non-focused gateways live in the foreground.
/// The focused gateway remains owned by `NodeAppModel`, including its capability-bearing
/// node session. This fleet therefore cannot route camera, screen, or device commands.
@MainActor
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

    private final class Runtime {
        let id = UUID()
        let session = GatewayNodeSession()
        let config: GatewayConnectConfig
        var task: Task<Void, Never>?
        var isPausedForAttention = false

        init(config: GatewayConnectConfig) {
            self.config = config
        }
    }

    private var runtimes: [GatewayStableIdentifier.Key: Runtime] = [:]

    func reconcile(
        desiredStableIDs: [String],
        configs: [GatewayConnectConfig])
    {
        let desiredKeys = Set(desiredStableIDs.compactMap(GatewayStableIdentifier.key))
        var desired: [GatewayStableIdentifier.Key: GatewayConnectConfig] = [:]
        for config in configs {
            guard let key = GatewayStableIdentifier.key(config.effectiveStableID),
                  desiredKeys.contains(key)
            else { continue }
            desired[key] = config
        }

        // Endpoint resolution is transient for discovered gateways. Keep a healthy runtime on
        // its last proven route until the user disables, forgets, or focuses that gateway.
        for key in self.runtimes.keys where !desiredKeys.contains(key) {
            self.stopRuntime(key: key)
        }
        for (key, config) in desired {
            if let runtime = self.runtimes[key],
               runtime.config.hasSameConnectionInputs(as: config),
               runtime.task != nil || runtime.isPausedForAttention
            {
                continue
            }
            self.stopRuntime(key: key)
            self.startRuntime(config: config, key: key)
        }
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
        key: GatewayStableIdentifier.Key)
    {
        let runtime = Runtime(config: config)
        self.runtimes[key] = runtime
        runtime.task = Task { @MainActor [weak self, weak runtime] in
            guard let self, let runtime else { return }
            await self.run(runtime: runtime, key: key)
        }
    }

    private func stopRuntime(key: GatewayStableIdentifier.Key) {
        guard let runtime = self.runtimes.removeValue(forKey: key) else { return }
        runtime.task?.cancel()
        runtime.task = nil
        Task {
            await runtime.session.disconnect()
        }
    }

    private func run(runtime: Runtime, key: GatewayStableIdentifier.Key) async {
        let config = runtime.config
        let options = Self.operatorOptions(from: config.nodeOptions)
        // The session box is part of GatewayNodeSession's route identity. Keep it for
        // this runtime so a retry cannot replace an unchanged TLS transport.
        let sessionBox = config.tls.map {
            WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0))
        }
        let runtimeID = runtime.id
        var attempt = 0
        while !Task.isCancelled, self.runtimes[key]?.id == runtime.id {
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
                            guard self?.runtimes[key]?.id == runtimeID else { return }
                            _ = GatewaySettingsStore.markGatewayConnected(
                                stableID: config.effectiveStableID,
                                atMs: Int(Date().timeIntervalSince1970 * 1000))
                        }
                    },
                    onDisconnected: { _ in },
                    onInvoke: { request in
                        BridgeInvokeResponse(
                            id: request.id,
                            ok: false,
                            error: OpenClawNodeError(
                                code: .invalidRequest,
                                message: "INVALID_REQUEST: background operator sessions cannot invoke node commands"))
                    })
                attempt = 0
                // connect returns at readiness; the channel owns the live connection.
                repeat {
                    try await Task.sleep(for: .seconds(1))
                } while await runtime.session.currentRoute() != nil
            } catch {
                guard !Task.isCancelled, self.runtimes[key]?.id == runtime.id else { break }
                // An in-place reconnect can retire an admission without canceling this runtime.
                if error is CancellationError { continue }
                attempt += 1
                let problem = GatewayConnectionProblemMapper.map(error: error)
                runtime.isPausedForAttention = problem?.pauseReconnect == true || problem?.needsPairingApproval == true
                if runtime.isPausedForAttention { break }
                let delay = min(pow(2.0, Double(min(attempt, 5))), 30.0)
                try? await Task.sleep(for: .seconds(delay))
            }
        }
        if self.runtimes[key]?.id == runtime.id {
            // A completed task cannot keep a runtime alive; auth pauses are retained separately.
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
}
