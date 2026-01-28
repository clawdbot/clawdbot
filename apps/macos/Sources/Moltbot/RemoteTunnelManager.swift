import Foundation
import OSLog

/// Manages the SSH tunnel that forwards the remote gateway/control port to localhost.
actor RemoteTunnelManager {
    static let shared = RemoteTunnelManager()

    private let logger = Logger(subsystem: "bot.molt", category: "remote-tunnel")
    private var controlTunnel: RemotePortTunnel?
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
        // If a previous Moltbot run already has an SSH listener on the expected port (common after restarts),
        // reuse it instead of spawning new ssh processes that immediately fail with "Address already in use".
        let desiredPort = UInt16(GatewayEnvironment.gatewayPort())
        if let desc = await PortGuardian.shared.describe(port: Int(desiredPort)),
           self.isSshProcess(desc)
        {
            self.logger.info(
                "reusing existing SSH tunnel listener " +
                    "localPort=\(desiredPort, privacy: .public) " +
                    "pid=\(desc.pid, privacy: .public)")
            return desiredPort
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
        await self.waitForRestartBackoffIfNeeded()

        let desiredPort = UInt16(GatewayEnvironment.gatewayPort())
        let tunnel = try await RemotePortTunnel.create(
            remotePort: GatewayEnvironment.gatewayPort(),
            preferredLocalPort: desiredPort,
            allowRandomLocalPort: false)
        self.controlTunnel = tunnel
        self.endRestart()
        let resolvedPort = tunnel.localPort ?? desiredPort
        self.logger.info("ssh tunnel ready localPort=\(resolvedPort, privacy: .public)")
        return tunnel.localPort ?? desiredPort
    }

    func stopAll() {
        self.controlTunnel?.terminate()
        self.controlTunnel = nil
    }

    private func isSshProcess(_ desc: PortGuardian.Descriptor) -> Bool {
        let cmd = desc.command.lowercased()
        if cmd.contains("ssh") { return true }
        if let path = desc.executablePath?.lowercased(), path.contains("/ssh") { return true }
        return false
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
