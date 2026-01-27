import Foundation
import OSLog
#if canImport(Darwin)
import Darwin
#endif

actor PortGuardian {
    static let shared = PortGuardian()

    struct Record: Codable {
        let port: Int
        let pid: Int32
        let command: String
        let mode: String
        let timestamp: TimeInterval
    }

    struct Descriptor: Sendable {
        let pid: Int32
        let command: String
        let executablePath: String?
    }

    private var records: [Record] = []
    private let logger = Logger(subsystem: "com.clawdbot", category: "portguard")
    private nonisolated static let appSupportDir: URL = {
        let base = FileManager().urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("Moltbot", isDirectory: true)
    }()

    private nonisolated static var recordPath: URL {
        self.appSupportDir.appendingPathComponent("port-guard.json", isDirectory: false)
    }

    init() {
        self.records = Self.loadRecords(from: Self.recordPath)
    }

    func sweep(mode: AppState.ConnectionMode) async {
        self.logger.info("port sweep starting (mode=\(mode.rawValue, privacy: .public))")
        guard mode != .unconfigured else {
            self.logger.info("port sweep skipped (mode=unconfigured)")
            return
        }
        let ports = [GatewayEnvironment.gatewayPort()]
        for port in ports {
            let listeners = await self.listeners(on: port)
            guard !listeners.isEmpty else { continue }
            for listener in listeners {
                if self.isExpected(listener, port: port, mode: mode) {
                    let message = """
                    port \(port) already served by expected \(listener.command)
                    (pid \(listener.pid)) — keeping
                    """
                    self.logger.info("\(message, privacy: .public)")
                    continue
                }
                let killed = await self.kill(listener.pid)
                if killed {
                    let message = """
                    port \(port) was held by \(listener.command)
                    (pid \(listener.pid)); terminated
                    """
                    self.logger.error("\(message, privacy: .public)")
                } else {
                    self.logger.error("failed to terminate pid \(listener.pid) on port \(port, privacy: .public)")
                }
            }
        }
        self.logger.info("port sweep done")
    }

    func record(port: Int, pid: Int32, command: String, mode: AppState.ConnectionMode) async {
        try? FileManager().createDirectory(at: Self.appSupportDir, withIntermediateDirectories: true)
        self.records.removeAll { $0.pid == pid }
        self.records.append(
            Record(
                port: port,
                pid: pid,
                command: command,
                mode: mode.rawValue,
                timestamp: Date().timeIntervalSince1970))
        self.save()
    }

    func removeRecord(pid: Int32) {
        let before = self.records.count
        self.records.removeAll { $0.pid == pid }
        if self.records.count != before {
            self.save()
        }
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

        var id: Int { self.port }

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

        var id: Int32 { self.pid }
    }

    func diagnose(mode: AppState.ConnectionMode) async -> [PortReport] {
        if mode == .unconfigured {
            return []
        }
        let ports = [GatewayEnvironment.gatewayPort()]
        var reports: [PortReport] = []

        for port in ports {
            let listeners = await self.listeners(on: port)
            let tunnelHealthy = await self.probeGatewayHealthIfNeeded(
                port: port,
                mode: mode,
                listeners: listeners)
            reports.append(Self.buildReport(
                port: port,
                listeners: listeners,
                mode: mode,
                tunnelHealthy: tunnelHealthy))
        }

        return reports
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
        let expectedCommands = ["node", "moltbot", "tsx", "pnpm", "bun"]

        switch mode {
        case .remote:
            expectedDesc = "SSH tunnel to remote gateway"
            okPredicate = { $0.command.lowercased().contains("ssh") }
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

    private func kill(_ pid: Int32) async -> Bool {
        let term = await ShellExecutor.run(command: ["kill", "-TERM", "\(pid)"], cwd: nil, env: nil, timeout: 2)
        if term.ok { return true }
        let sigkill = await ShellExecutor.run(command: ["kill", "-KILL", "\(pid)"], cwd: nil, env: nil, timeout: 2)
        return sigkill.ok
    }

    private func isExpected(_ listener: Listener, port: Int, mode: AppState.ConnectionMode) -> Bool {
        let cmd = listener.command.lowercased()
        let full = listener.fullCommand.lowercased()
        switch mode {
        case .remote:
            // Remote mode expects an SSH tunnel for the gateway WebSocket port.
            if port == GatewayEnvironment.gatewayPort() { return cmd.contains("ssh") }
            return false
        case .local:
            // The gateway daemon may listen as `moltbot` or as its runtime (`node`, `bun`, etc).
            if full.contains("gateway-daemon") { return true }
            // If args are unavailable, treat a moltbot listener as expected.
            if cmd.contains("moltbot"), full == cmd { return true }
            return false
        case .unconfigured:
            return false
        }
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

    private func save() {
        guard let data = try? JSONEncoder().encode(self.records) else { return }
        try? data.write(to: Self.recordPath, options: [.atomic])
    }
}

#if DEBUG
extension PortGuardian {
    static func _testParseListeners(_ text: String) -> [(
        pid: Int32,
        command: String,
        fullCommand: String,
        user: String?)]
    {
        self.parseListeners(from: text).map { ($0.pid, $0.command, $0.fullCommand, $0.user) }
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
