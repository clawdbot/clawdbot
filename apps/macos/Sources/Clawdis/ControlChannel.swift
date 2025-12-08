import Foundation
import Network
import OSLog
import Darwin

struct ControlHeartbeatEvent: Codable {
    let ts: Double
    let status: String
    let to: String?
    let preview: String?
    let durationMs: Double?
    let hasMedia: Bool?
    let reason: String?
}

struct ControlHealthSnapshot: Codable {
    struct Web: Codable {
        let linked: Bool
        let authAgeMs: Double?
        let connect: Connect?

        struct Connect: Codable {
            let ok: Bool
            let status: Int?
            let error: String?
            let elapsedMs: Double?
        }
    }

    struct Sessions: Codable {
        struct Entry: Codable {
            let key: String
            let updatedAt: Double?
            let age: Double?
        }
        let path: String
        let count: Int
        let recent: [Entry]
    }

    struct IPC: Codable {
        let path: String
        let exists: Bool
    }

    let ts: Double
    let durationMs: Double
    let web: Web
    let heartbeatSeconds: Int
    let sessions: Sessions
    let ipc: IPC
}

enum ControlChannelError: Error, LocalizedError {
    case disconnected
    case badResponse(String)
    case sshFailed(String)

    var errorDescription: String? {
        switch self {
        case .disconnected: return "Control channel disconnected"
        case let .badResponse(msg): return msg
        case let .sshFailed(msg): return "SSH tunnel failed: \(msg)"
        }
    }
}

@MainActor
final class ControlChannel: ObservableObject {
    static let shared = ControlChannel()

    enum Mode: Equatable {
        case local
        case remote(target: String, identity: String)
    }

    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        case degraded(String)
    }

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "control")
    private var connection: NWConnection?
    private var sshProcess: Process?
    private var buffer = Data()
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]
    private var listenTask: Task<Void, Never>?
    private var mode: Mode = .local
    private var localPort: UInt16 = 18789
    private var pingTask: Task<Void, Never>?

    @Published private(set) var state: ConnectionState = .disconnected
    @Published private(set) var lastPingMs: Double?

    func configure(mode: Mode) async throws {
        if mode == self.mode, self.connection != nil { return }
        await self.disconnect()
        self.mode = mode
        try await self.connect()
    }

    func disconnect() async {
        self.listenTask?.cancel()
        self.listenTask = nil
        self.pingTask?.cancel()
        self.pingTask = nil
        if let conn = self.connection {
            conn.cancel()
        }
        self.connection = nil
        if let ssh = self.sshProcess, ssh.isRunning { ssh.terminate() }
        self.sshProcess = nil
        for (_, cont) in self.pending {
            cont.resume(throwing: ControlChannelError.disconnected)
        }
        self.pending.removeAll()
        self.state = .disconnected
    }

    func health(timeout: TimeInterval? = nil) async throws -> Data {
        try await self.ensureConnected()
        let payload = try await self.request(method: "health", params: timeout.map { ["timeoutMs": Int($0 * 1000)] })
        return payload
    }

    func lastHeartbeat() async throws -> ControlHeartbeatEvent? {
        try await self.ensureConnected()
        let data = try await self.request(method: "last-heartbeat")
        if data.isEmpty { return nil }
        return try? JSONDecoder().decode(ControlHeartbeatEvent.self, from: data)
    }

    private func request(method: String, params: [String: Any]? = nil) async throws -> Data {
        try await self.ensureConnected()
        let id = UUID().uuidString
        var frame: [String: Any] = ["type": "request", "id": id, "method": method]
        if let params { frame["params"] = params }
        let data = try JSONSerialization.data(withJSONObject: frame)
        try await self.send(data)
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            self.pending[id] = cont
        }
    }

    private func ensureConnected() async throws {
        if let conn = self.connection {
            switch conn.state {
            case .ready: return
            default: break
            }
        }
        try await self.connect()
    }

    private func connect() async throws {
        switch self.mode {
        case .local:
            self.localPort = 18789
        case let .remote(target, identity):
            self.localPort = try self.startSSHTunnel(target: target, identity: identity)
        }

        self.state = .connecting

        let host = NWEndpoint.Host("127.0.0.1")
        let port = NWEndpoint.Port(rawValue: self.localPort)!
        let conn = NWConnection(host: host, port: port, using: .tcp)
        self.connection = conn

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            conn.stateUpdateHandler = { [weak self, weak conn] state in
                guard let self else { return }
                switch state {
                case .ready:
                    Task { @MainActor in self.state = .connected }
                    conn?.stateUpdateHandler = nil
                    cont.resume(returning: ())
                case let .failed(err):
                    Task { @MainActor in self.state = .degraded(err.localizedDescription) }
                    conn?.stateUpdateHandler = nil
                    cont.resume(throwing: err)
                case let .waiting(err):
                    Task { @MainActor in self.state = .degraded(err.localizedDescription) }
                    conn?.stateUpdateHandler = nil
                    cont.resume(throwing: err)
                default:
                    break
                }
            }
            conn.start(queue: .global())
        }

        self.listenTask = Task.detached { [weak self] in
            await self?.listen()
        }

        self.pingTask = Task.detached { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                    let start = Date()
                    _ = try await self.request(method: "ping")
                    let ms = Date().timeIntervalSince(start) * 1000
                    await MainActor.run { self.lastPingMs = ms; self.state = .connected }
                } catch {
                    await MainActor.run { self.state = .degraded(error.localizedDescription) }
                }
            }
        }
    }

    private func startSSHTunnel(target: String, identity: String) throws -> UInt16 {
        let localPort = Self.pickAvailablePort()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        var args: [String] = ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-L", "\(localPort):127.0.0.1:18789", target]
        if !identity.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.insert(contentsOf: ["-i", identity], at: 2)
        }
        proc.arguments = args
        proc.standardInput = nil
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        try proc.run()
        self.sshProcess = proc
        return localPort
    }

    private func send(_ data: Data) async throws {
        guard let conn = self.connection else { throw ControlChannelError.disconnected }
        let line = data + Data([0x0A])
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            conn.send(content: line, completion: .contentProcessed { error in
                if let error { cont.resume(throwing: error) }
                else { cont.resume(returning: ()) }
            })
        }
    }

    private func listen() async {
        guard let conn = self.connection else { return }
        while true {
            let result: (Data?, Bool, NWError?) = await withCheckedContinuation { cont in
                conn.receiveMessage { data, _, isComplete, error in
                    cont.resume(returning: (data, isComplete, error))
                }
            }

            let (data, isComplete, error) = result
            if let error {
                self.logger.debug("control receive error: \(error.localizedDescription, privacy: .public)")
                break
            }
            if isComplete { break }
            guard let data else { continue }
            self.buffer.append(data)
            while let range = buffer.firstRange(of: Data([0x0A])) {
                let lineData = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
                buffer.removeSubrange(buffer.startIndex...range.lowerBound)
                self.handleLine(lineData)
            }
        }
    }

    private func handleLine(_ data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }

        if type == "event", let event = obj["event"] as? String {
            if event == "heartbeat", let payload = obj["payload"] {
                if let payloadData = try? JSONSerialization.data(withJSONObject: payload) {
                    NotificationCenter.default.post(name: .controlHeartbeat, object: payloadData)
                }
            }
            return
        }

        if type == "response", let id = obj["id"] as? String {
            let ok = obj["ok"] as? Bool ?? false
            if ok, let payload = obj["payload"] {
                let payloadData = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
                self.pending[id]?.resume(returning: payloadData)
            } else {
                let err = (obj["error"] as? String) ?? "control error"
                self.pending[id]?.resume(throwing: ControlChannelError.badResponse(err))
            }
            self.pending.removeValue(forKey: id)
        }
    }

    private static func pickAvailablePort() -> UInt16 {
        var port: UInt16 = 0
        let socket = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(socket) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(0).bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        _ = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        getsockname(socket, withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { $0 }
        }, &len)
        port = UInt16(bigEndian: addr.sin_port)
        return port
    }
}

extension Notification.Name {
    static let controlHeartbeat = Notification.Name("clawdis.control.heartbeat")
}
