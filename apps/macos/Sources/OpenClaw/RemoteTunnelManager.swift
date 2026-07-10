import Foundation
import OSLog

/// Manages the SSH tunnel that forwards the remote gateway/control port to localhost.
actor RemoteTunnelManager {
    static let shared = RemoteTunnelManager()

    private let logger = Logger(subsystem: "ai.openclaw", category: "remote-tunnel")
    private var controlTunnel: RemotePortTunnel?
    private var createInFlight: (token: UUID, task: Task<RemotePortTunnel, Error>)?
    private var restartInFlight = false
    private var lastRestartAt: Date?
    private let restartBackoffSeconds: TimeInterval = 2.0

    func controlTunnelPortIfRunning() async -> UInt16? {
        if self.restartInFlight {
            self.logger.info("control tunnel restart in flight; skipping reuse check")
            return nil
        }
        if let tunnel = self.controlTunnel,
           tunnel.process.isRunning,
           let local = tunnel.localPort
        {
            let pid = tunnel.process.processIdentifier
            if await PortGuardian.shared.isListening(port: Int(local), pid: pid) {
                self.logger.info("reusing active SSH tunnel localPort=\(local, privacy: .public)")
                return local
            }
            self.logger.error(
                "active SSH tunnel on port \(local, privacy: .public) is not listening; restarting")
            await self.beginRestart()
            tunnel.terminate()
            self.controlTunnel = nil
        }
        return nil
    }

    /// Ensure an SSH tunnel is running for the gateway control port.
    /// Returns the local forwarded port (usually the configured gateway port).
    func ensureControlTunnel() async throws -> UInt16 {
        let settings = CommandResolver.connectionSettings()
        guard settings.mode == .remote else {
            throw NSError(
                domain: "RemoteTunnel",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Remote mode is not enabled"])
        }

        let identitySet = !settings.identity.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        self.logger.info(
            "ensure SSH tunnel target=\(settings.target, privacy: .public) " +
                "identitySet=\(identitySet, privacy: .public)")

        if let local = await self.controlTunnelPortIfRunning() { return local }
        if let create = self.createInFlight {
            self.logger.info("control tunnel create in flight; joining")
            let tunnel = try await create.task.value
            return try await self.installCreatedTunnel(
                tunnel,
                token: create.token,
                fallbackPort: UInt16(GatewayEnvironment.gatewayPort()))
        }
        await self.waitForRestartBackoffIfNeeded()

        let desiredPort = UInt16(GatewayEnvironment.gatewayPort())
        let token = UUID()
        let task = Task {
            try await RemotePortTunnel.create(
                remotePort: GatewayEnvironment.gatewayPort(),
                preferredLocalPort: desiredPort,
                allowRandomLocalPort: true)
        }
        self.createInFlight = (token: token, task: task)
        let tunnel: RemotePortTunnel
        do {
            tunnel = try await task.value
        } catch {
            if self.createInFlight?.token == token {
                self.createInFlight = nil
            }
            throw error
        }
        return try await self.installCreatedTunnel(tunnel, token: token, fallbackPort: desiredPort)
    }

    private func installCreatedTunnel(
        _ tunnel: RemotePortTunnel,
        token: UUID,
        fallbackPort: UInt16) async throws -> UInt16
    {
        if self.createInFlight?.token == token {
            self.createInFlight = nil
        }
        self.controlTunnel = tunnel
        self.endRestart()
        let resolvedPort = tunnel.localPort ?? fallbackPort
        self.logger.info("ssh tunnel ready localPort=\(resolvedPort, privacy: .public)")
        return resolvedPort
    }

    func stopAll() {
        self.createInFlight?.task.cancel()
        self.createInFlight = nil
        self.controlTunnel?.terminate()
        self.controlTunnel = nil
    }

    private func beginRestart() async {
        guard !self.restartInFlight else { return }
        self.restartInFlight = true
        self.lastRestartAt = Date()
        self.logger.info("control tunnel restart started")
        Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(self.restartBackoffSeconds * 1_000_000_000))
            await self.endRestart()
        }
    }

    private func endRestart() {
        if self.restartInFlight {
            self.restartInFlight = false
            self.logger.info("control tunnel restart finished")
        }
    }

    private func waitForRestartBackoffIfNeeded() async {
        guard let last = self.lastRestartAt else { return }
        let elapsed = Date().timeIntervalSince(last)
        let remaining = self.restartBackoffSeconds - elapsed
        guard remaining > 0 else { return }
        self.logger.info(
            "control tunnel restart backoff \(remaining, privacy: .public)s")
        try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
    }

    // Keep tunnel reuse lightweight; restart only when the listener disappears.
}
