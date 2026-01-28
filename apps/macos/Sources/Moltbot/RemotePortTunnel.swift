import Foundation
import Network
import OSLog
#if canImport(Darwin)
import Darwin
#endif

/// Port forwarding tunnel for remote mode.
///
/// Uses `ssh -N -L` to forward the remote gateway ports to localhost.
final class RemotePortTunnel {
    private static let logger = Logger(subsystem: "bot.molt", category: "remote.tunnel")

    let process: Process
    let localPort: UInt16?
    private let stderrHandle: FileHandle?

    private init(process: Process, localPort: UInt16?, stderrHandle: FileHandle?) {
        self.process = process
        self.localPort = localPort
        self.stderrHandle = stderrHandle
    }

    deinit {
        Self.cleanupStderr(self.stderrHandle)
        let pid = self.process.processIdentifier
        self.process.terminate()
        Task { await PortGuardian.shared.removeRecord(pid: pid) }
    }

    func terminate() {
        Self.cleanupStderr(self.stderrHandle)
        let pid = self.process.processIdentifier
        if self.process.isRunning {
            self.process.terminate()
            self.process.waitUntilExit()
        }
        Task { await PortGuardian.shared.removeRecord(pid: pid) }
    }

    static func create(
        remotePort: Int,
        preferredLocalPort: UInt16? = nil,
        allowRemoteUrlOverride: Bool = true,
        allowRandomLocalPort: Bool = true) async throws -> RemotePortTunnel
    {
        let settings = CommandResolver.connectionSettings()
        guard settings.mode == .remote, let parsed = CommandResolver.parseSSHTarget(settings.target) else {
            throw NSError(
                domain: "RemotePortTunnel",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Remote mode is not configured"])
        }

        let localPort = try await Self.findPort(
            preferred: preferredLocalPort,
            allowRandom: allowRandomLocalPort)
        let sshHost = parsed.host.trimmingCharacters(in: .whitespacesAndNewlines)
        let remotePortOverride =
            allowRemoteUrlOverride && remotePort == GatewayEnvironment.gatewayPort()
            ? Self.resolveRemotePortOverride(for: sshHost)
            : nil
        let resolvedRemotePort = remotePortOverride ?? remotePort
        if let override = remotePortOverride {
            Self.logger.info(
                "ssh tunnel remote port override " +
                    "host=\(sshHost, privacy: .public) port=\(override, privacy: .public)")
        } else {
            Self.logger.debug(
                "ssh tunnel using default remote port " +
                    "host=\(sshHost, privacy: .public) port=\(remotePort, privacy: .public)")
        }
        let options: [String] = [
            "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UpdateHostKeys=yes",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "TCPKeepAlive=yes",
            "-N",
            "-L", "\(localPort):127.0.0.1:\(resolvedRemotePort)",
        ]
        let identity = settings.identity.trimmingCharacters(in: .whitespacesAndNewlines)
        let args = CommandResolver.sshArguments(
            target: parsed,
            identity: identity,
            options: options)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = args

        let pipe = Pipe()
        process.standardError = pipe
        let stderrHandle = pipe.fileHandleForReading

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
            Self.logger.error("ssh tunnel stderr: \(line, privacy: .public)")
        }
        process.terminationHandler = { _ in
            Self.cleanupStderr(stderrHandle)
        }

        try process.run()

        // If ssh exits immediately (e.g. local port already in use), surface stderr and ensure we stop monitoring.
        try? await Task.sleep(nanoseconds: 150_000_000) // 150ms
        if !process.isRunning {
            let stderr = Self.drainStderr(stderrHandle)
            let msg = stderr.isEmpty ? "ssh tunnel exited immediately" : "ssh tunnel failed: \(stderr)"
            throw NSError(domain: "RemotePortTunnel", code: 4, userInfo: [NSLocalizedDescriptionKey: msg])
        }

        // Track tunnel so we can clean up stale listeners on restart.
        Task {
            await PortGuardian.shared.record(
                port: Int(localPort),
                pid: process.processIdentifier,
                command: process.executableURL?.path ?? "ssh",
                mode: CommandResolver.connectionSettings().mode)
        }

        return RemotePortTunnel(process: process, localPort: localPort, stderrHandle: stderrHandle)
    }

    private static func resolveRemotePortOverride(for sshHost: String) -> Int? {
        let root = MoltbotConfigFile.loadDict()
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
        let sshKey = Self.hostKey(sshHost)
        let urlKey = Self.hostKey(host)
        guard !sshKey.isEmpty, !urlKey.isEmpty else { return nil }
        guard sshKey == urlKey else {
            Self.logger.debug(
                "remote url host mismatch sshHost=\(sshHost, privacy: .public) urlHost=\(host, privacy: .public)")
            return nil
        }
        return port
    }

    private static func hostKey(_ host: String) -> String {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return "" }
        if trimmed.contains(":") { return trimmed }
        let digits = CharacterSet(charactersIn: "0123456789.")
        if trimmed.rangeOfCharacter(from: digits.inverted) == nil {
            return trimmed
        }
        return trimmed.split(separator: ".").first.map(String.init) ?? trimmed
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
            let queue = DispatchQueue(label: "bot.molt.remote.tunnel.port", qos: .utility)
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

    private static func drainStderr(_ handle: FileHandle) -> String {
        handle.readabilityHandler = nil
        defer { try? handle.close() }

        do {
            let data = try handle.readToEnd() ?? Data()
            return String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        } catch {
            self.logger.debug("Failed to drain ssh stderr: \(error, privacy: .public)")
            return ""
        }
    }

    #if SWIFT_PACKAGE
    static func _testPortIsFree(_ port: UInt16) -> Bool {
        self.portIsFree(port)
    }

    static func _testDrainStderr(_ handle: FileHandle) -> String {
        self.drainStderr(handle)
    }
    #endif
}
