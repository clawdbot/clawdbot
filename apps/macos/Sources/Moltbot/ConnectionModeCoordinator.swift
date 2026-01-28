import Foundation
import OSLog

@MainActor
final class ConnectionModeCoordinator {
    static let shared = ConnectionModeCoordinator()

    private let logger = Logger(subsystem: "bot.molt", category: "connection")
    private var lastMode: AppState.ConnectionMode?

    /// Apply the requested connection mode by starting/stopping local gateway,
    /// managing the control-channel SSH tunnel, and cleaning up chat windows/panels.
    func apply(mode: AppState.ConnectionMode, paused: Bool) async {
        if let lastMode = self.lastMode, lastMode != mode {
            GatewayProcessManager.shared.clearLastFailure()
            NodesStore.shared.lastError = nil
        }
        self.lastMode = mode
        switch mode {
        case .unconfigured:
            _ = await NodeServiceManager.stop()
            NodesStore.shared.lastError = nil
            await RemoteTunnelManager.shared.stopAll()
            WebChatManager.shared.resetTunnels()
            GatewayProcessManager.shared.stop()
            await GatewayConnection.shared.shutdown()
            await ControlChannel.shared.disconnect()
            Task.detached { await PortGuardian.shared.sweep(mode: .unconfigured) }

        case .local:
            _ = await NodeServiceManager.stop()
            NodesStore.shared.lastError = nil
            await RemoteTunnelManager.shared.stopAll()
            WebChatManager.shared.resetTunnels()
            let shouldStart = GatewayAutostartPolicy.shouldStartGateway(mode: .local, paused: paused)
            if shouldStart {
                GatewayProcessManager.shared.setActive(true)
                if GatewayAutostartPolicy.shouldEnsureLaunchAgent(
                    mode: .local,
                    paused: paused)
                {
                    Task { await GatewayProcessManager.shared.ensureLaunchAgentEnabledIfNeeded() }
                }
                _ = await GatewayProcessManager.shared.waitForGatewayReady()
            } else {
                GatewayProcessManager.shared.stop()
            }
            do {
                try await ControlChannel.shared.configure(mode: .local)
            } catch {
                // Control channel will mark itself degraded; nothing else to do here.
                self.logger.error(
                    "control channel local configure failed: \(error.localizedDescription, privacy: .public)")
            }
            Task.detached { await PortGuardian.shared.sweep(mode: .local) }

        case .remote:
            // Never run a local gateway in remote mode.
            GatewayProcessManager.shared.stop()
            WebChatManager.shared.resetTunnels()

            do {
                NodesStore.shared.lastError = nil
                if let error = await NodeServiceManager.start() {
                    NodesStore.shared.lastError = "Node service start failed: \(error)"
                }
                _ = try await GatewayEndpointStore.shared.ensureRemoteControlTunnel()
                let settings = CommandResolver.connectionSettings()
                try await ControlChannel.shared.configure(mode: .remote(
                    target: settings.target,
                    identity: settings.identity))
            } catch {
                self.logger.error("remote tunnel/configure failed: \(error.localizedDescription, privacy: .public)")
            }

            Task.detached { await PortGuardian.shared.sweep(mode: .remote) }
        }
    }
}
