import Foundation
import OSLog
#if canImport(Darwin)
import Darwin
#endif

actor PortGuardian {
    static let shared = PortGuardian()

    struct Record: Codable, Equatable {
        let port: Int
        let pid: Int32
        let command: String
        let mode: String
        let timestamp: TimeInterval
    }

    struct Descriptor {
        let pid: Int32
        let command: String
        let executablePath: String?
    }

    /// Tunnels spawned by THIS process. Disk (`port-guard.json`) holds the union
    /// across app instances; entries there that we do not own are reap candidates,
    /// never adopted — adopting them would resurrect records a sibling removed.
    private var ownRecords: [Int32: Record] = [:]
    private let logger = Logger(subsystem: "ai.openclaw", category: "portguard")
    #if DEBUG
    private var testingDescriptors: [Int: Descriptor] = [:]
    #endif
    private nonisolated static let appSupportDir: URL = {
        let base = FileManager().urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("OpenClaw", isDirectory: true)
    }()

    private nonisolated static var recordPath: URL {
        self.appSupportDir.appendingPathComponent("port-guard.json", isDirectory: false)
    }

    private nonisolated static var recordLockPath: URL {
        self.appSupportDir.appendingPathComponent("port-guard.lock", isDirectory: false)
    }

    func sweep(mode: AppState.ConnectionMode) async {
        self.logger.info("port sweep starting (mode=\(mode.rawValue, privacy: .public))")
        // Reap before the port scan and in every mode: orphans come from earlier
        // remote sessions and must die even after the user switched modes.
        await self.reapOrphanedTunnels()
        guard mode != .unconfigured else {
            self.logger.info("port sweep skipped (mode=unconfigured)")
            return
        }
        let port = GatewayEnvironment.gatewayPort()
        for listener in await self.listeners(on: port) {
            if Self.isExpected(listener, port: port, mode: mode) {
                let message = """
                port \(port) already served by expected \(listener.command)
                (pid \(listener.pid)) — keeping
                """
                self.logger.info("\(message, privacy: .public)")
                continue
            }
            if mode == .remote {
                let message = """
                port \(port) held by \(listener.command)
                (pid \(listener.pid)) in remote mode — not killing
                """
                self.logger.warning(message)
                continue
            }
            if await Self.terminateProcess(listener.pid) {
                let message = """
                port \(port) was held by \(listener.command)
                (pid \(listener.pid)); terminated
                """
                self.logger.error("\(message, privacy: .public)")
            } else {
                self.logger.error("failed to terminate pid \(listener.pid) on port \(port, privacy: .public)")
            }
        }
        self.logger.info("port sweep done")
    }

    func record(port: Int, pid: Int32, command: String, mode: AppState.ConnectionMode) {
        let record = Record(
            port: port,
            pid: pid,
            command: command,
            mode: mode.rawValue,
            timestamp: Date().timeIntervalSince1970)
        self.ownRecords[pid] = record
        Self.persistRecords { $0[pid] = record }
    }

    func removeRecord(pid: Int32) {
        guard let owned = self.ownRecords.removeValue(forKey: pid) else { return }
        // Content-guarded like reap: a sibling instance may have re-recorded a
        // recycled pid for its own new tunnel; that fresh record must survive.
        Self.persistRecords { merged in
            if merged[pid] == owned {
                merged.removeValue(forKey: pid)
            }
        }
    }

    // MARK: - Orphaned tunnel reaping

    /// Live process facts for a recorded tunnel pid; nil means the process is gone.
    struct TunnelProcessInfo {
        let parentPid: Int32
        let startedAt: TimeInterval
        let fullCommand: String?
    }

    enum TunnelRecordAction: Equatable {
        /// Owner still alive (or process unverifiable) — leave process and record alone.
        case keep
        /// Record is stale (process gone or pid reused) — forget it, never kill.
        case drop
        /// Orphaned tunnel this app family spawned — kill it and forget the record.
        case reap
    }

    /// Kill recorded ssh tunnels whose owning app instance died. A crash/force-kill
    /// leaves the tunnel reparented to launchd, holding the remote connection and
    /// squatting the preferred local port so new tunnels drift to ephemeral ports.
    func reapOrphanedTunnels() async {
        let plan = Self.planTunnelReap(
            own: Array(self.ownRecords.values),
            disk: Self.loadRecords(from: Self.recordPath),
            processInfo: Self.tunnelProcessInfo(pid:))
        var removals = plan.drop
        for record in plan.reap {
            if await Self.terminateProcess(record.pid) {
                removals.append(record)
                let message = """
                reaped orphaned ssh tunnel (pid \(record.pid), local port \(record.port))
                """
                self.logger.error("\(message, privacy: .public)")
            } else {
                // Leave the record in place so the next sweep retries the kill.
                self.logger.error("failed to reap orphaned tunnel pid \(record.pid, privacy: .public)")
            }
        }
        guard !removals.isEmpty else { return }
        for record in removals where self.ownRecords[record.pid] == record {
            self.ownRecords.removeValue(forKey: record.pid)
        }
        // Remove only records whose content still matches what was classified: a
        // sibling instance may have re-recorded the same pid for a new tunnel in the
        // meantime, and that fresh record must survive.
        Self.persistRecords { merged in
            for record in removals where merged[record.pid] == record {
                merged.removeValue(forKey: record.pid)
            }
        }
    }

    /// Matches only the exact `ssh … -N -L <localPort>:127.0.0.1:<remotePort>` shape spawned by
    /// RemotePortTunnel. First reap gate; the start-time check in classify handles pid reuse
    /// by a look-alike tunnel on the same port.
    static func isTunnelCommand(_ fullCommand: String, localPort: Int) -> Bool {
        let tokens = fullCommand.split(whereSeparator: \.isWhitespace).map(String.init)
        guard let executable = tokens.first,
              executable == "ssh" || executable.hasSuffix("/ssh"),
              tokens.contains("-N")
        else { return false }
        let forwardPrefix = "\(localPort):127.0.0.1:"
        for (index, token) in tokens.enumerated() {
            if token == "-L", index + 1 < tokens.count, tokens[index + 1].hasPrefix(forwardPrefix) {
                return true
            }
            if token.hasPrefix("-L"), token.dropFirst(2).hasPrefix(forwardPrefix) {
                return true
            }
        }
        return false
    }

    static func classifyTunnelRecord(_ record: Record, process: TunnelProcessInfo?) -> TunnelRecordAction {
        guard let process else { return .drop }
        // No readable command line (e.g. zombie): cannot prove the pid is ours, so
        // never kill; the record drops once the process is truly gone.
        guard let command = process.fullCommand, !command.isEmpty else { return .keep }
        guard self.isTunnelCommand(command, localPort: record.port) else { return .drop }
        // Records are written right after spawn, so the recorded process always starts
        // before its record. Started-later means the pid was reused — possibly by a
        // user's own look-alike tunnel on the same port. Drop, never kill. Small slack
        // absorbs wall-clock steps between kernel start time and the record write.
        guard process.startedAt <= record.timestamp + 5 else { return .drop }
        // ppid 1 means reparented to launchd: the owning app instance died. Any other
        // live parent may be a concurrent OpenClaw instance (prod + dev), so hands off.
        return process.parentPid == 1 ? .reap : .keep
    }

    static func planTunnelReap(
        own: [Record],
        disk: [Record],
        processInfo: (Int32) -> TunnelProcessInfo?) -> (reap: [Record], keep: [Record], drop: [Record])
    {
        // All app instances share port-guard.json, so disk can hold records from a
        // crashed sibling this instance never saw. Own records win pid collisions —
        // they are fresher than anything a dead sibling left behind.
        var merged: [Int32: Record] = [:]
        for record in disk {
            merged[record.pid] = record
        }
        for record in own {
            merged[record.pid] = record
        }
        let ordered = merged.values.sorted { ($0.timestamp, $0.pid) < ($1.timestamp, $1.pid) }
        var reap: [Record] = []
        var keep: [Record] = []
        var drop: [Record] = []
        for record in ordered {
            switch self.classifyTunnelRecord(record, process: processInfo(record.pid)) {
            case .keep: keep.append(record)
            case .drop: drop.append(record)
            case .reap: reap.append(record)
            }
        }
        return (reap, keep, drop)
    }

    /// TERM first, then KILL, returning only once the process is confirmed gone:
    /// sweep and reap callers rebind the freed port immediately, and reap must not
    /// forget a still-running tunnel (the record is its only retry path).
    private static func terminateProcess(_ pid: Int32) async -> Bool {
        #if canImport(Darwin)
        guard pid > 0 else { return false }
        _ = Darwin.kill(pid, SIGTERM)
        if await self.waitForProcessExit(pid: pid) { return true }
        _ = Darwin.kill(pid, SIGKILL)
        return await self.waitForProcessExit(pid: pid)
        #else
        return false
        #endif
    }

    private static func waitForProcessExit(pid: Int32, timeout: TimeInterval = 1.0) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while self.tunnelProcessInfo(pid: pid) != nil {
            guard Date() < deadline else { return false }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return true
    }

    private static func tunnelProcessInfo(pid: Int32) -> TunnelProcessInfo? {
        #if canImport(Darwin)
        guard pid > 0 else { return nil }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        let rc = sysctl(&mib, u_int(mib.count), &info, &size, nil, 0)
        // sysctl "succeeds" with size 0 when the pid does not exist.
        guard rc == 0, size > 0, info.kp_proc.p_pid == pid else { return nil }
        let started = TimeInterval(info.kp_proc.p_starttime.tv_sec)
            + TimeInterval(info.kp_proc.p_starttime.tv_usec) / 1_000_000
        return TunnelProcessInfo(
            parentPid: info.kp_eproc.e_ppid,
            startedAt: started,
            fullCommand: self.readFullCommand(pid: pid))
        #else
        return nil
        #endif
    }

    struct PortReport: Identifiable {
        enum Status {
            case ok(String)
            case missing(String)
            case interference(String, offenders: [ReportListener])
        }

        let port: Int
        let expected: String
        let status: Status
        let listeners: [ReportListener]

        var id: Int {
            self.port
        }

        var offenders: [ReportListener] {
            if case let .interference(_, offenders) = self.status { return offenders }
            return []
        }

        var summary: String {
            switch self.status {
            case let .ok(text): text
            case let .missing(text): text
            case let .interference(text, _): text
            }
        }
    }

    func describe(port: Int) async -> Descriptor? {
        #if DEBUG
        if let descriptor = self.testingDescriptors[port] {
            return descriptor
        }
        #endif
        guard let listener = await self.listeners(on: port).first else { return nil }
        let path = Self.executablePath(for: listener.pid)
        return Descriptor(pid: listener.pid, command: listener.command, executablePath: path)
    }

    // MARK: - Internals

    private struct Listener {
        let pid: Int32
        let command: String
        let fullCommand: String
        let user: String?
    }

    struct ReportListener: Identifiable {
        let pid: Int32
        let command: String
        let fullCommand: String
        let user: String?
        let expected: Bool

        var id: Int32 {
            self.pid
        }
    }

    func diagnose(mode: AppState.ConnectionMode) async -> [PortReport] {
        if mode == .unconfigured {
            return []
        }
        let port = GatewayEnvironment.gatewayPort()
        let listeners = await self.listeners(on: port)
        let tunnelHealthy = await self.probeGatewayHealthIfNeeded(
            port: port,
            mode: mode,
            listeners: listeners)
        return [Self.buildReport(
            port: port,
            listeners: listeners,
            mode: mode,
            tunnelHealthy: tunnelHealthy)]
    }

    func probeGatewayHealth(port: Int, timeout: TimeInterval = 2.0) async -> Bool {
        let url = URL(string: "http://127.0.0.1:\(port)/")!
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: config)
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = timeout
        do {
            let (_, response) = try await session.data(for: request)
            return response is HTTPURLResponse
        } catch {
            return false
        }
    }

    func isListening(port: Int, pid: Int32? = nil) async -> Bool {
        let listeners = await self.listeners(on: port)
        if let pid {
            return listeners.contains(where: { $0.pid == pid })
        }
        return !listeners.isEmpty
    }

    private func listeners(on port: Int) async -> [Listener] {
        let res = await ShellExecutor.run(
            command: ["lsof", "-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpcn"],
            cwd: nil,
            env: nil,
            timeout: 5)
        guard res.ok, let data = res.payload, !data.isEmpty else { return [] }
        let text = String(data: data, encoding: .utf8) ?? ""
        return Self.parseListeners(from: text)
    }

    private static func readFullCommand(pid: Int32) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/ps")
        proc.arguments = ["-p", "\(pid)", "-o", "command="]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            let data = try proc.runAndReadToEnd(from: pipe)
            guard !data.isEmpty else { return nil }
            return String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private static func parseListeners(from text: String) -> [Listener] {
        var listeners: [Listener] = []
        var currentPid: Int32?
        var currentCmd: String?
        var currentUser: String?

        func flush() {
            if let pid = currentPid, let cmd = currentCmd {
                let full = Self.readFullCommand(pid: pid) ?? cmd
                listeners.append(Listener(pid: pid, command: cmd, fullCommand: full, user: currentUser))
            }
            currentPid = nil
            currentCmd = nil
            currentUser = nil
        }

        for line in text.split(separator: "\n") {
            guard let prefix = line.first else { continue }
            let value = String(line.dropFirst())
            switch prefix {
            case "p":
                flush()
                currentPid = Int32(value) ?? 0
            case "c":
                currentCmd = value
            case "u":
                currentUser = value
            default:
                continue
            }
        }
        flush()
        return listeners
    }

    private static func buildReport(
        port: Int,
        listeners: [Listener],
        mode: AppState.ConnectionMode,
        tunnelHealthy: Bool?) -> PortReport
    {
        let expectedDesc: String
        let okPredicate: (Listener) -> Bool
        let expectedCommands = ["node", "openclaw", "tsx", "pnpm", "bun"]

        switch mode {
        case .remote:
            expectedDesc = "Remote gateway (SSH tunnel, Docker, or direct)"
            okPredicate = { _ in true }
        case .local:
            expectedDesc = "Gateway websocket (node/tsx)"
            okPredicate = { listener in
                let c = listener.command.lowercased()
                return expectedCommands.contains { c.contains($0) }
            }
        case .unconfigured:
            expectedDesc = "Gateway not configured"
            okPredicate = { _ in false }
        }

        if listeners.isEmpty {
            let text = "Nothing is listening on \(port) (\(expectedDesc))."
            return .init(port: port, expected: expectedDesc, status: .missing(text), listeners: [])
        }

        let tunnelUnhealthy =
            mode == .remote && port == GatewayEnvironment.gatewayPort() && tunnelHealthy == false
        let reportListeners = listeners.map { listener in
            var expected = okPredicate(listener)
            if tunnelUnhealthy, expected { expected = false }
            return ReportListener(
                pid: listener.pid,
                command: listener.command,
                fullCommand: listener.fullCommand,
                user: listener.user,
                expected: expected)
        }

        let offenders = reportListeners.filter { !$0.expected }
        if tunnelUnhealthy {
            let list = listeners.map { "\($0.command) (\($0.pid))" }.joined(separator: ", ")
            let reason = "Port \(port) is served by \(list), but the SSH tunnel is unhealthy."
            return .init(
                port: port,
                expected: expectedDesc,
                status: .interference(reason, offenders: offenders),
                listeners: reportListeners)
        }
        if offenders.isEmpty {
            let list = listeners.map { "\($0.command) (\($0.pid))" }.joined(separator: ", ")
            let okText = "Port \(port) is served by \(list)."
            return .init(
                port: port,
                expected: expectedDesc,
                status: .ok(okText),
                listeners: reportListeners)
        }

        let list = offenders.map { "\($0.command) (\($0.pid))" }.joined(separator: ", ")
        let reason = "Port \(port) is held by \(list), expected \(expectedDesc)."
        return .init(
            port: port,
            expected: expectedDesc,
            status: .interference(reason, offenders: offenders),
            listeners: reportListeners)
    }

    private static func executablePath(for pid: Int32) -> String? {
        #if canImport(Darwin)
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        // Drop trailing null and decode as UTF-8.
        let trimmed = buffer.prefix { $0 != 0 }
        let bytes = trimmed.map { UInt8(bitPattern: $0) }
        return String(bytes: bytes, encoding: .utf8)
        #else
        return nil
        #endif
    }

    private static func isExpected(_ listener: Listener, port: Int, mode: AppState.ConnectionMode) -> Bool {
        let cmd = listener.command.lowercased()
        let full = listener.fullCommand.lowercased()
        switch mode {
        case .remote:
            if port == GatewayEnvironment.gatewayPort() { return true }
            return false
        case .local:
            // Preserve both the legacy hidden alias and the current service process title.
            if full.contains("gateway-daemon") || full.contains("openclaw-gateway")
                || cmd.contains("openclaw-gateway")
            {
                return true
            }
            if self.isNodeOpenClawGatewayCommand(full) { return true }
            // If args are unavailable, treat a CLI listener as expected.
            if cmd.contains("openclaw"), full == cmd { return true }
            return false
        case .unconfigured:
            return false
        }
    }

    private static func isNodeOpenClawGatewayCommand(_ fullCommand: String) -> Bool {
        let tokens = fullCommand
            .split(whereSeparator: \.isWhitespace)
            .map { self.unquoteCommandToken(String($0)) }
        guard tokens.count >= 3 else { return false }
        guard URL(fileURLWithPath: tokens[0]).lastPathComponent.lowercased() == "node" else {
            return false
        }
        return self.isOpenClawDistEntrypointToken(tokens[1])
            && tokens[2].lowercased() == "gateway"
    }

    private static func isOpenClawDistEntrypointToken(_ token: String) -> Bool {
        let normalized = token.replacingOccurrences(of: "\\", with: "/").lowercased()
        guard normalized.hasSuffix("/dist/index.js") else { return false }
        return normalized
            .split(separator: "/", omittingEmptySubsequences: true)
            .contains("openclaw")
    }

    private static func unquoteCommandToken(_ token: String) -> String {
        token.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
    }

    private func probeGatewayHealthIfNeeded(
        port: Int,
        mode: AppState.ConnectionMode,
        listeners: [Listener]) async -> Bool?
    {
        guard mode == .remote, port == GatewayEnvironment.gatewayPort(), !listeners.isEmpty else { return nil }
        let hasSsh = listeners.contains { $0.command.lowercased().contains("ssh") }
        guard hasSsh else { return nil }
        return await self.probeGatewayHealth(port: port)
    }

    private static func loadRecords(from url: URL) -> [Record] {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([Record].self, from: data)
        else { return [] }
        return decoded
    }

    /// The single write path for port-guard.json: read-merge-write under a file
    /// lock so concurrent app instances (prod + dev) never clobber each other's
    /// records — a lost record means an unreapable orphan after a crash.
    private static func persistRecords(_ mutate: (inout [Int32: Record]) -> Void) {
        try? FileManager().createDirectory(at: self.appSupportDir, withIntermediateDirectories: true)
        self.withRecordFileLock {
            let disk = self.loadRecords(from: self.recordPath)
            var merged: [Int32: Record] = [:]
            for record in disk {
                merged[record.pid] = record
            }
            mutate(&merged)
            let ordered = merged.values.sorted { ($0.timestamp, $0.pid) < ($1.timestamp, $1.pid) }
            guard ordered != disk else { return }
            guard let data = try? JSONEncoder().encode(ordered) else { return }
            try? data.write(to: self.recordPath, options: [.atomic])
        }
    }

    /// flock on a sidecar (atomic writes swap the json inode, so locking the json
    /// itself would not serialize anything). The kernel releases it if we die.
    private static func withRecordFileLock(_ body: () -> Void) {
        #if canImport(Darwin)
        let fd = open(self.recordLockPath.path, O_CREAT | O_RDWR, 0o644)
        guard fd >= 0 else {
            body()
            return
        }
        defer { close(fd) }
        _ = flock(fd, LOCK_EX)
        defer { _ = flock(fd, LOCK_UN) }
        body()
        #else
        body()
        #endif
    }
}

#if DEBUG
extension PortGuardian {
    func setTestingDescriptor(_ descriptor: Descriptor?, forPort port: Int) {
        if let descriptor {
            self.testingDescriptors[port] = descriptor
        } else {
            self.testingDescriptors.removeValue(forKey: port)
        }
    }

    static func _testTunnelProcessInfo(pid: Int32) -> TunnelProcessInfo? {
        self.tunnelProcessInfo(pid: pid)
    }

    static func _testParseListeners(_ text: String) -> [(
        pid: Int32,
        command: String,
        fullCommand: String,
        user: String?)]
    {
        self.parseListeners(from: text).map { ($0.pid, $0.command, $0.fullCommand, $0.user) }
    }

    static func _testIsExpected(
        command: String,
        fullCommand: String,
        port: Int,
        mode: AppState.ConnectionMode) -> Bool
    {
        let listener = Listener(pid: 0, command: command, fullCommand: fullCommand, user: nil)
        return Self.isExpected(listener, port: port, mode: mode)
    }

    static func _testBuildReport(
        port: Int,
        mode: AppState.ConnectionMode,
        listeners: [(pid: Int32, command: String, fullCommand: String, user: String?)]) -> PortReport
    {
        let mapped = listeners.map { Listener(
            pid: $0.pid,
            command: $0.command,
            fullCommand: $0.fullCommand,
            user: $0.user) }
        return Self.buildReport(port: port, listeners: mapped, mode: mode, tunnelHealthy: nil)
    }
}
#endif
