import Foundation
import Network
import OpenClawKit
import OSLog
#if canImport(Darwin)
import Darwin
#endif

/// Port forwarding tunnel for remote mode.
///
/// Uses `ssh -N -L` to forward the remote gateway ports to localhost.
final class RemotePortTunnel: @unchecked Sendable {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "remote.tunnel")

    struct Configuration: Equatable, Sendable {
        let target: CommandResolver.SSHParsedTarget
        let identity: String
        let remotePort: Int
        let hostKeyPolicy: CommandResolver.SSHHostKeyPolicy
    }

    let process: Process
    let localPort: UInt16?
    private let stderrHandle: FileHandle?
    private let guardianReceipt: PortGuardian.Record

    private final class StderrCapture: @unchecked Sendable {
        private let lock = NSLock()
        private var text = ""
        private let limit = 4096

        func append(_ chunk: String) {
            let trimmed = chunk.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            if !self.text.isEmpty {
                self.text += "\n"
            }
            self.text += trimmed
            if self.text.count > self.limit {
                self.text = String(self.text.suffix(self.limit))
            }
        }

        func snapshot() -> String {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    private init(
        process: Process,
        localPort: UInt16?,
        stderrHandle: FileHandle?,
        guardianReceipt: PortGuardian.Record)
    {
        self.process = process
        self.localPort = localPort
        self.stderrHandle = stderrHandle
        self.guardianReceipt = guardianReceipt
    }

    deinit {
        Self.cleanupStderr(self.stderrHandle)
        let receipt = self.guardianReceipt
        guard self.process.isRunning else {
            Task { await PortGuardian.shared.removeRecord(receipt) }
            return
        }
        // deinit cannot wait. Leave the receipt durable until a later sweep proves
        // the child exited; deleting it after TERM alone can orphan a resistant SSH.
        Task { await PortGuardian.shared.relinquishRecord(receipt) }
        self.process.terminate()
    }

    func terminate() {
        Self.terminateAndWait(self.process)
        Self.cleanupStderr(self.stderrHandle)
        let receipt = self.guardianReceipt
        Task { await PortGuardian.shared.removeRecord(receipt) }
    }

    static func configuration(remotePort: Int) throws -> Configuration {
        let root = OpenClawConfigFile.loadDict()
        let settings = CommandResolver.connectionSettings(configRoot: root)
        guard settings.mode == .remote,
              GatewayRemoteConfig.resolveTransportResolution(root: root).transport == .ssh,
              let target = CommandResolver.parseSSHTarget(settings.target)
        else {
            throw NSError(
                domain: "RemotePortTunnel",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Remote mode is not configured"])
        }
        let sshHost = target.host.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedRemotePort = Self.resolveRemotePortOverride(
            defaultRemotePort: remotePort,
            for: sshHost,
            root: root) ?? remotePort
        return Configuration(
            target: target,
            identity: settings.identity.trimmingCharacters(in: .whitespacesAndNewlines),
            remotePort: resolvedRemotePort,
            hostKeyPolicy: settings.sshHostKeyPolicy)
    }

    static func create(
        configuration: Configuration,
        preferredLocalPort: UInt16? = nil,
        allowRandomLocalPort: Bool = true) async throws -> RemotePortTunnel
    {
        // Reap orphans from crashed instances before picking a port, otherwise a dead
        // session's tunnel squats the preferred port and forces an ephemeral one.
        await PortGuardian.shared.reapOrphanedTunnels()

        let localPort = try await Self.findPort(
            preferred: preferredLocalPort,
            allowRandom: allowRandomLocalPort)
        let sshHost = configuration.target.host
        Self.logger.debug(
            "ssh tunnel route host=\(sshHost, privacy: .public) " +
                "remotePort=\(configuration.remotePort, privacy: .public)")
        let options = Self.sshOptions(
            localPort: localPort,
            remotePort: configuration.remotePort,
            hostKeyPolicy: configuration.hostKeyPolicy)
        let args = CommandResolver.sshArguments(
            target: configuration.target,
            identity: configuration.identity,
            options: options)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = args
        process.environment = CommandResolver.sshEnvironment()

        let pipe = Pipe()
        process.standardError = pipe
        let stderrHandle = pipe.fileHandleForReading
        let stderrCapture = StderrCapture()

        // Consume stderr so ssh cannot block if it logs.
        stderrHandle.readabilityHandler = { handle in
            let data = handle.readSafely(upToCount: 64 * 1024)
            guard !data.isEmpty else {
                // EOF (or read failure): stop monitoring to avoid spinning on a closed pipe.
                Self.cleanupStderr(handle)
                return
            }
            guard let line = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !line.isEmpty
            else { return }
            stderrCapture.append(line)
            Self.logger.error("ssh tunnel stderr: \(line, privacy: .public)")
        }
        process.terminationHandler = { _ in
            Self.cleanupStderr(stderrHandle)
        }

        let spawnPreparation: PortGuardian.SpawnPreparation
        do {
            // Legacy reconciliation can inspect many live processes. Complete it
            // before spawn so a crash during migration cannot orphan this SSH child.
            spawnPreparation = try await PortGuardian.shared.prepareForTunnelSpawn()
        } catch {
            Self.cleanupStderr(stderrHandle)
            throw NSError(
                domain: "RemotePortTunnel",
                code: 5,
                userInfo: [
                    NSLocalizedDescriptionKey: "Could not prepare SSH tunnel ownership: \(error.localizedDescription)",
                    NSUnderlyingErrorKey: error,
                ])
        }

        do {
            try process.run()
        } catch {
            await PortGuardian.shared.cancelTunnelSpawn(spawnPreparation)
            Self.cleanupStderr(stderrHandle)
            throw error
        }

        let receipt: PortGuardian.Record
        do {
            // Persist immediately after spawn. Waiting for listener readiness first leaves
            // a crash window where a live SSH process has no durable reap receipt.
            receipt = try await PortGuardian.shared.record(
                port: Int(localPort),
                pid: process.processIdentifier,
                command: process.executableURL?.path ?? "ssh",
                mode: .remote,
                preparation: spawnPreparation)
        } catch {
            Self.terminateAndWait(process)
            // Keep the reservation exclusive until this exact child is reaped.
            // Only then may another operation migrate or open the ledger.
            await PortGuardian.shared.cancelTunnelSpawn(spawnPreparation)
            Self.cleanupStderr(stderrHandle)
            throw NSError(
                domain: "RemotePortTunnel",
                code: 5,
                userInfo: [
                    NSLocalizedDescriptionKey: "Could not persist SSH tunnel ownership: \(error.localizedDescription)",
                    NSUnderlyingErrorKey: error,
                ])
        }

        do {
            try await Self.waitForListener(
                process: process,
                localPort: localPort,
                stderrHandle: stderrHandle,
                stderrCapture: stderrCapture)
        } catch {
            Self.terminateAndWait(process)
            Self.cleanupStderr(stderrHandle)
            await PortGuardian.shared.removeRecord(receipt)
            throw error
        }

        return RemotePortTunnel(
            process: process,
            localPort: localPort,
            stderrHandle: stderrHandle,
            guardianReceipt: receipt)
    }

    private static func terminateAndWait(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        // waitUntilExit reaps this exact child before its pid can be reused. A
        // delayed raw kill(pid) could otherwise signal an unrelated process.
        process.waitUntilExit()
    }

    private static func waitForListener(
        process: Process,
        localPort: UInt16,
        stderrHandle: FileHandle,
        stderrCapture: StderrCapture) async throws
    {
        let deadline = Date().addingTimeInterval(6)
        repeat {
            if !process.isRunning {
                let stderr = Self.drainStderr(stderrHandle, captured: stderrCapture.snapshot())
                let msg = stderr.isEmpty ? "ssh tunnel exited before listening" : "ssh tunnel failed: \(stderr)"
                throw NSError(domain: "RemotePortTunnel", code: 4, userInfo: [NSLocalizedDescriptionKey: msg])
            }
            if await PortGuardian.shared.isListening(port: Int(localPort), pid: process.processIdentifier) {
                return
            }
            do {
                try await Task.sleep(nanoseconds: 100_000_000)
            } catch {
                throw error
            }
        } while Date() < deadline

        let stderr = stderrCapture.snapshot()
        let msg = stderr.isEmpty ? "ssh tunnel did not open local port \(localPort)" : "ssh tunnel failed: \(stderr)"
        throw NSError(domain: "RemotePortTunnel", code: 4, userInfo: [NSLocalizedDescriptionKey: msg])
    }

    /// Shared with MacChatTranscriptCache: the offline cache identity must key
    /// on the same remote gateway port this tunnel actually forwards to, or two
    /// gateways behind one SSH target would share cached transcripts.
    static func resolveRemotePortOverride(defaultRemotePort: Int, for sshHost: String) -> Int? {
        let root = OpenClawConfigFile.loadDict()
        return self.resolveRemotePortOverride(
            defaultRemotePort: defaultRemotePort,
            for: sshHost,
            root: root)
    }

    private static func resolveRemotePortOverride(
        defaultRemotePort: Int,
        for sshHost: String,
        root: [String: Any]) -> Int?
    {
        if let port = GatewayRemoteConfig.resolveRemotePort(root: root) {
            return port
        }
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any],
              let urlRaw = remote["url"] as? String
        else {
            return nil
        }
        let trimmed = urlRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed), let port = url.port else {
            return nil
        }
        guard let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty
        else {
            return nil
        }
        if LoopbackHost.isLoopbackHost(host) {
            return port == defaultRemotePort ? nil : port
        }
        guard let sshKey = OpenClawConfigFile.canonicalHostForComparison(sshHost),
              let urlKey = OpenClawConfigFile.canonicalHostForComparison(host)
        else {
            return nil
        }
        guard sshKey == urlKey else {
            Self.logger.debug(
                "remote url host mismatch sshHost=\(sshHost, privacy: .public) urlHost=\(host, privacy: .public)")
            return nil
        }
        return port
    }

    private static func sshOptions(
        localPort: UInt16,
        remotePort: Int,
        hostKeyPolicy: CommandResolver.SSHHostKeyPolicy) -> [String]
    {
        [
            "-o", "BatchMode=yes",
            // The app tracks this exact child PID, so aliases must not hand the tunnel to a shared master.
            "-o", "ControlMaster=no",
            "-o", "ControlPath=none",
            "-o", "ControlPersist=no",
            "-o", "ForkAfterAuthentication=no",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "TCPKeepAlive=yes",
            "-n",
            "-N",
            "-L", "\(localPort):127.0.0.1:\(remotePort)",
        ] + hostKeyPolicy.hostKeyOptions
    }

    private static func findPort(preferred: UInt16?, allowRandom: Bool) async throws -> UInt16 {
        if let preferred, self.portIsFree(preferred) { return preferred }
        if let preferred, !allowRandom {
            throw NSError(
                domain: "RemotePortTunnel",
                code: 5,
                userInfo: [
                    NSLocalizedDescriptionKey: "Local port \(preferred) is unavailable",
                ])
        }

        return try await withCheckedThrowingContinuation { cont in
            let queue = DispatchQueue(label: "ai.openclaw.remote.tunnel.port", qos: .utility)
            do {
                let listener = try NWListener(using: .tcp, on: .any)
                listener.newConnectionHandler = { connection in connection.cancel() }
                listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        if let port = listener.port?.rawValue {
                            listener.stateUpdateHandler = nil
                            listener.cancel()
                            cont.resume(returning: port)
                        }
                    case let .failed(error):
                        listener.stateUpdateHandler = nil
                        listener.cancel()
                        cont.resume(throwing: error)
                    default:
                        break
                    }
                }
                listener.start(queue: queue)
            } catch {
                cont.resume(throwing: error)
            }
        }
    }

    private static func portIsFree(_ port: UInt16) -> Bool {
        #if canImport(Darwin)
        // NWListener can succeed even when only one address family is held. Mirror what ssh needs by checking
        // both 127.0.0.1 and ::1 for availability.
        return self.canBindIPv4(port) && self.canBindIPv6(port)
        #else
        do {
            let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
            listener.cancel()
            return true
        } catch {
            return false
        }
        #endif
    }

    #if canImport(Darwin)
    private static func canBindIPv4(_ port: UInt16) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { _ = Darwin.close(fd) }

        var one: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout.size(ofValue: one)))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    private static func canBindIPv6(_ port: UInt16) -> Bool {
        let fd = socket(AF_INET6, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { _ = Darwin.close(fd) }

        var one: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout.size(ofValue: one)))

        var addr = sockaddr_in6()
        addr.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
        addr.sin6_family = sa_family_t(AF_INET6)
        addr.sin6_port = port.bigEndian
        var loopback = in6_addr()
        _ = withUnsafeMutablePointer(to: &loopback) { ptr in
            inet_pton(AF_INET6, "::1", ptr)
        }
        addr.sin6_addr = loopback

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in6>.size))
            }
        }
        return result == 0
    }
    #endif

    private static func cleanupStderr(_ handle: FileHandle?) {
        guard let handle else { return }
        Self.cleanupStderr(handle)
    }

    private static func cleanupStderr(_ handle: FileHandle) {
        if handle.readabilityHandler != nil {
            handle.readabilityHandler = nil
        }
        try? handle.close()
    }

    private static func drainStderr(_ handle: FileHandle, captured: String) -> String {
        handle.readabilityHandler = nil
        defer { try? handle.close() }

        do {
            let data = try handle.readToEnd() ?? Data()
            let remaining = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if captured.isEmpty {
                return remaining
            }
            if remaining.isEmpty {
                return captured
            }
            return captured + "\n" + remaining
        } catch {
            self.logger.debug("Failed to drain ssh stderr: \(error, privacy: .public)")
            return captured
        }
    }

    #if SWIFT_PACKAGE
    static func _testPortIsFree(_ port: UInt16) -> Bool {
        self.portIsFree(port)
    }

    static func _testResolveRemotePortOverride(defaultRemotePort: Int, sshHost: String) -> Int? {
        self.resolveRemotePortOverride(defaultRemotePort: defaultRemotePort, for: sshHost)
    }

    static func _testSSHOptions(
        localPort: UInt16,
        remotePort: Int,
        hostKeyPolicy: CommandResolver.SSHHostKeyPolicy = .strict) -> [String]
    {
        self.sshOptions(localPort: localPort, remotePort: remotePort, hostKeyPolicy: hostKeyPolicy)
    }

    static func _testDrainStderr(_ handle: FileHandle) -> String {
        self.drainStderr(handle, captured: "")
    }

    static func _testTerminateAndWait(_ process: Process) {
        self.terminateAndWait(process)
    }

    #endif
}
