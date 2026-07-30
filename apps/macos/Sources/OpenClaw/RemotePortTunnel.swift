import Foundation
import Network
import OpenClawKit
import OSLog
import Subprocess
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

    let localPort: UInt16?
    var isRunning: Bool {
        self.process.isRunning
    }

    var processIdentifier: pid_t {
        self.process.processIdentifier
    }

    private let process: ManagedProcess
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

    private enum ProcessWakeReason: Sendable {
        case exited
        case terminate
    }

    private struct ProcessStartFailure: LocalizedError, Sendable {
        let message: String

        var errorDescription: String? {
            self.message
        }
    }

    private final class ProcessStartSignal: @unchecked Sendable {
        private let lock = NSLock()
        private var result: Result<pid_t, ProcessStartFailure>?
        private var continuation: CheckedContinuation<pid_t, any Error>?

        func wait() async throws -> pid_t {
            try await withCheckedThrowingContinuation { continuation in
                self.lock.lock()
                if let result = self.result {
                    self.lock.unlock()
                    continuation.resume(with: result)
                    return
                }
                self.continuation = continuation
                self.lock.unlock()
            }
        }

        func succeed(_ processIdentifier: pid_t) {
            self.resolve(.success(processIdentifier))
        }

        func fail(_ error: ProcessStartFailure) {
            self.resolve(.failure(error))
        }

        private func resolve(_ result: Result<pid_t, ProcessStartFailure>) {
            self.lock.lock()
            guard self.result == nil else {
                self.lock.unlock()
                return
            }
            self.result = result
            let continuation = self.continuation
            self.continuation = nil
            self.lock.unlock()
            continuation?.resume(with: result)
        }
    }

    private final class ProcessWakeSignal: @unchecked Sendable {
        private let lock = NSLock()
        private var reason: ProcessWakeReason?
        private var continuation: CheckedContinuation<ProcessWakeReason, Never>?
        private var source: DispatchSourceProcess?

        func wait(processIdentifier: pid_t) async -> ProcessWakeReason {
            await withCheckedContinuation { continuation in
                self.lock.lock()
                if let reason = self.reason {
                    self.lock.unlock()
                    continuation.resume(returning: reason)
                    return
                }
                self.continuation = continuation
                self.lock.unlock()

                if Self.hasExited(processIdentifier) {
                    self.resolve(.exited)
                    return
                }

                let source = DispatchSource.makeProcessSource(
                    identifier: processIdentifier,
                    eventMask: .exit,
                    queue: .global(qos: .userInitiated))
                source.setEventHandler { [weak self] in
                    self?.resolve(.exited)
                }

                self.lock.lock()
                if self.reason == nil {
                    self.source = source
                }
                let shouldStart = self.reason == nil
                self.lock.unlock()

                source.resume()
                if !shouldStart {
                    source.cancel()
                    return
                }
                // Cover an exit between the preflight waitid and kqueue registration.
                if Self.hasExited(processIdentifier) {
                    self.resolve(.exited)
                }
            }
        }

        func requestTermination() {
            self.resolve(.terminate)
        }

        private func resolve(_ reason: ProcessWakeReason) {
            self.lock.lock()
            guard self.reason == nil else {
                self.lock.unlock()
                return
            }
            self.reason = reason
            let continuation = self.continuation
            self.continuation = nil
            let source = self.source
            self.source = nil
            self.lock.unlock()
            source?.cancel()
            continuation?.resume(returning: reason)
        }

        private static func hasExited(_ processIdentifier: pid_t) -> Bool {
            var info = siginfo_t()
            let result = waitid(
                P_PID,
                id_t(processIdentifier),
                &info,
                WEXITED | WNOHANG | WNOWAIT)
            return result == 0 && info.si_pid != 0
        }
    }

    private final class ProcessCompletionState: @unchecked Sendable {
        private let lock = NSLock()
        private var finished = false
        private var status: TerminationStatus?

        var isRunning: Bool {
            self.lock.lock()
            defer { self.lock.unlock() }
            return !self.finished
        }

        var terminationStatus: TerminationStatus? {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.status
        }

        func finish(status: TerminationStatus?) {
            self.lock.lock()
            self.finished = true
            self.status = status
            self.lock.unlock()
        }
    }

    fileprivate final class ManagedProcess: @unchecked Sendable {
        let processIdentifier: pid_t
        private let task: Task<Void, Never>
        private let wakeSignal: ProcessWakeSignal
        private let state: ProcessCompletionState

        var isRunning: Bool {
            self.state.isRunning
        }

        var terminationStatus: TerminationStatus? {
            self.state.terminationStatus
        }

        private init(
            processIdentifier: pid_t,
            task: Task<Void, Never>,
            wakeSignal: ProcessWakeSignal,
            state: ProcessCompletionState)
        {
            self.processIdentifier = processIdentifier
            self.task = task
            self.wakeSignal = wakeSignal
            self.state = state
        }

        static func start(
            configuration: Subprocess.Configuration,
            error: some ErrorOutputProtocol & Sendable) async throws -> ManagedProcess
        {
            let startSignal = ProcessStartSignal()
            let wakeSignal = ProcessWakeSignal()
            let state = ProcessCompletionState()
            let task = Task.detached(priority: .userInitiated) {
                do {
                    let result = try await Subprocess.run(
                        configuration,
                        input: .none,
                        output: .discarded,
                        error: error)
                    { execution in
                        let processIdentifier = execution.processIdentifier.value
                        startSignal.succeed(processIdentifier)
                        let reason = await wakeSignal.wait(processIdentifier: processIdentifier)
                        switch reason {
                        case .terminate:
                            try? execution.send(signal: .terminate, toProcessGroup: true)
                            try? await Task.sleep(for: .milliseconds(250))
                            // The leader stays unreaped until this body returns, so its
                            // process-group identity cannot be reused before escalation.
                            try? execution.send(signal: .kill, toProcessGroup: true)
                        case .exited:
                            // A crashed SSH leader can leave ProxyCommand descendants.
                            // The zombie leader still pins the group identity here.
                            try? execution.send(signal: .kill, toProcessGroup: true)
                        }
                    }
                    state.finish(status: result.terminationStatus)
                } catch {
                    let message = if let subprocessError = error as? SubprocessError {
                        subprocessError.description
                    } else {
                        error.localizedDescription
                    }
                    startSignal.fail(ProcessStartFailure(message: message))
                    state.finish(status: nil)
                }
            }
            let processIdentifier = try await startSignal.wait()
            return ManagedProcess(
                processIdentifier: processIdentifier,
                task: task,
                wakeSignal: wakeSignal,
                state: state)
        }

        func requestTermination() {
            self.wakeSignal.requestTermination()
        }

        func terminate() async {
            self.requestTermination()
            await self.task.value
        }

        deinit {
            self.requestTermination()
        }
    }

    private init(
        process: ManagedProcess,
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
        self.process.requestTermination()
    }

    func terminate() async {
        await self.process.terminate()
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

        let pipe = Pipe()
        let stderrHandle = pipe.fileHandleForReading
        let stderrWriter = pipe.fileHandleForWriting
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

        var platformOptions = PlatformOptions()
        platformOptions.qualityOfService = .userInitiated
        platformOptions.createSession = true
        platformOptions.teardownSequence = [
            .send(
                signal: .terminate,
                toProcessGroup: true,
                allowedDurationToNextStep: .milliseconds(250)),
        ]
        let processConfiguration = Subprocess.Configuration(
            .path(.init("/usr/bin/ssh")),
            arguments: Arguments(args),
            environment: self.environment(from: CommandResolver.sshEnvironment()),
            platformOptions: platformOptions)
        let process: ManagedProcess
        do {
            process = try await ManagedProcess.start(
                configuration: processConfiguration,
                error: .fileDescriptor(
                    .init(rawValue: stderrWriter.fileDescriptor),
                    closeAfterSpawningProcess: false))
            try? stderrWriter.close()
        } catch {
            await PortGuardian.shared.cancelTunnelSpawn(spawnPreparation)
            try? stderrWriter.close()
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
                command: "/usr/bin/ssh",
                mode: .remote,
                preparation: spawnPreparation)
        } catch {
            await process.terminate()
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
            await process.terminate()
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

    private static func waitForListener(
        process: ManagedProcess,
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

    private static func environment(from values: [String: String]) -> Environment {
        var converted: [Environment.Key: String] = [:]
        converted.reserveCapacity(values.count)
        for (key, value) in values {
            guard let environmentKey = Environment.Key(rawValue: key) else { continue }
            converted[environmentKey] = value
        }
        return .custom(converted)
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

    final class TestProcess: @unchecked Sendable {
        private let process: ManagedProcess

        fileprivate init(process: ManagedProcess) {
            self.process = process
        }

        var isRunning: Bool {
            self.process.isRunning
        }

        var terminationStatus: TerminationStatus? {
            self.process.terminationStatus
        }

        func requestTermination() {
            self.process.requestTermination()
        }

        func terminate() async {
            await self.process.terminate()
        }
    }

    static func _testStartProcess(
        executable: String,
        arguments: [String],
        environment: [String: String] = [:]) async throws -> TestProcess
    {
        var platformOptions = PlatformOptions()
        platformOptions.createSession = true
        let configuration = Subprocess.Configuration(
            .path(.init(executable)),
            arguments: Arguments(arguments),
            environment: self.environment(from: environment),
            platformOptions: platformOptions)
        return try await TestProcess(process: ManagedProcess.start(
            configuration: configuration,
            error: .discarded))
    }

    #endif
}
