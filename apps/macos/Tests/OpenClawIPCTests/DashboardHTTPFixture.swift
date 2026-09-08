import Foundation
import Network
import Security

/// A test owns the listener until `stop()`, after closing its dashboard windows.
@MainActor
final class DashboardHTTPFixture {
    static let html = "<!doctype html><html><head><title>Dashboard fixture</title></head><body>Ready</body></html>"

    private let server: DashboardHTTPFixtureServer
    nonisolated let port: UInt16
    nonisolated let usesTLS: Bool

    private init(server: DashboardHTTPFixtureServer, port: UInt16, usesTLS: Bool) {
        self.server = server
        self.port = port
        self.usesTLS = usesTLS
    }

    static func start(
        html: String = DashboardHTTPFixture.html,
        contentSecurityPolicy: String = "default-src 'none'",
        beforeResponse: (@MainActor () async -> Void)? = nil,
        tlsIdentity: sec_identity_t? = nil,
        requestHandler: (@MainActor (String) -> String?)? = nil) async throws -> DashboardHTTPFixture
    {
        let parameters: NWParameters
        if let tlsIdentity {
            let tls = NWProtocolTLS.Options()
            sec_protocol_options_set_local_identity(tls.securityProtocolOptions, tlsIdentity)
            parameters = NWParameters(tls: tls)
        } else {
            parameters = .tcp
        }
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters, on: .any)
        let server = DashboardHTTPFixtureServer(
            listener: listener,
            html: html,
            contentSecurityPolicy: contentSecurityPolicy,
            beforeResponse: beforeResponse,
            requestHandler: requestHandler)
        server.start()
        do {
            let deadline = ContinuousClock.now + .seconds(5)
            while true {
                try Task.checkCancellation()
                switch listener.state {
                case .ready:
                    guard let port = listener.port, port.rawValue != 0 else {
                        throw URLError(.cannotFindHost)
                    }
                    return DashboardHTTPFixture(
                        server: server,
                        port: port.rawValue,
                        usesTLS: tlsIdentity != nil)
                case let .failed(error):
                    throw error
                case .cancelled:
                    throw CancellationError()
                default:
                    guard ContinuousClock.now < deadline else {
                        throw URLError(.timedOut, userInfo: [
                            NSLocalizedDescriptionKey: "Dashboard HTTP fixture listener timed out: \(listener.state)",
                        ])
                    }
                    try await Task.sleep(for: .milliseconds(10))
                }
            }
        } catch {
            server.stop()
            throw error
        }
    }

    nonisolated func url(_ path: String = "/") -> URL {
        URL(string: "\(self.usesTLS ? "https" : "http")://127.0.0.1:\(self.port)\(path)")!
    }

    nonisolated func websocketURL(_ path: String = "/") -> URL {
        URL(string: "\(self.usesTLS ? "wss" : "ws")://127.0.0.1:\(self.port)\(path)")!
    }

    func stop() {
        self.server.stop()
    }
}

/// All mutable transport state belongs to queue; UI tests may block the main actor.
private final class DashboardHTTPFixtureServer: @unchecked Sendable {
    private struct Client {
        let connection: NWConnection
        let timeout: DispatchWorkItem
        var request = Data()
        var responseTask: Task<Void, Never>?
    }

    private let queue = DispatchQueue(label: "DashboardHTTPFixture")
    private let listener: NWListener
    private let responseHTML: String
    private let contentSecurityPolicy: String
    private let beforeResponse: (@MainActor () async -> Void)?
    private let requestHandler: (@MainActor (String) -> String?)?
    private var clients: [UUID: Client] = [:]
    private var stopped = false

    init(
        listener: NWListener,
        html: String,
        contentSecurityPolicy: String,
        beforeResponse: (@MainActor () async -> Void)?,
        requestHandler: (@MainActor (String) -> String?)?)
    {
        self.listener = listener
        self.responseHTML = html
        self.contentSecurityPolicy = contentSecurityPolicy
        self.beforeResponse = beforeResponse
        self.requestHandler = requestHandler
        // Network.framework requires the connection handler before listener.start.
        self.listener.newConnectionHandler = { [weak self] connection in
            guard let self else {
                connection.cancel()
                return
            }
            self.accept(connection)
        }
    }

    func start() {
        self.listener.start(queue: self.queue)
    }

    func stop() {
        self.queue.sync {
            guard !self.stopped else { return }
            self.stopped = true
            self.listener.cancel()
            for id in Array(self.clients.keys) {
                self.close(id)
            }
        }
    }

    private func accept(_ connection: NWConnection) {
        guard !self.stopped, self.clients.count < 32 else {
            connection.cancel()
            return
        }
        let id = UUID()
        let timeout = DispatchWorkItem { [weak self] in self?.close(id) }
        self.clients[id] = Client(connection: connection, timeout: timeout)
        connection.start(queue: self.queue)
        self.queue.asyncAfter(deadline: .now() + 5, execute: timeout)
        self.receive(id)
    }

    private func receive(_ id: UUID) {
        guard let client = self.clients[id] else { return }
        // One bounded request per connection; neither slow clients nor a partial
        // header can leave a receive alive beyond the connection's deadline.
        client.connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: 8192 - client.request.count)
        { [weak self] data, _, complete, error in
            guard let self, var client = self.clients[id] else { return }
            if let data { client.request.append(data) }
            self.clients[id] = client
            if client.request.range(of: Data("\r\n\r\n".utf8)) != nil {
                if self.beforeResponse != nil || self.requestHandler != nil {
                    let request = String(data: client.request, encoding: .utf8) ?? ""
                    self.clients[id]?.responseTask = Task { @MainActor [
                        weak self,
                        beforeResponse = self.beforeResponse,
                        requestHandler = self.requestHandler,
                    ] in
                        await beforeResponse?()
                        // stop/timeout may have retired this client while the hook waited.
                        guard !Task.isCancelled else { return }
                        let response = requestHandler?(request)
                        self?.queue.async { [weak self] in self?.respond(id, response: response) }
                    }
                } else {
                    self.respond(id)
                }
            } else if error != nil || complete || client.request.count >= 8192 {
                self.close(id)
            } else {
                self.receive(id)
            }
        }
    }

    private func respond(_ id: UUID, response: String? = nil) {
        guard let client = self.clients[id] else { return }
        let body = Data(self.responseHTML.utf8)
        // Existing callers stay inert; navigation tests explicitly opt into
        // their own scripts and loopback-only frame origins.
        let headers = [
            "HTTP/1.1 200 OK",
            "Content-Type: text/html; charset=utf-8",
            "Content-Length: \(body.count)",
            "Cache-Control: no-store",
            "Content-Security-Policy: \(self.contentSecurityPolicy)",
            "Connection: close",
        ].joined(separator: "\r\n") + "\r\n\r\n"
        let content = response.map { Data($0.utf8) } ?? (Data(headers.utf8) + body)
        client.connection.send(content: content, completion: .contentProcessed { [weak self] _ in
            self?.close(id)
        })
    }

    private func close(_ id: UUID) {
        guard let client = self.clients.removeValue(forKey: id) else { return }
        client.timeout.cancel()
        client.responseTask?.cancel()
        client.connection.cancel()
    }
}
