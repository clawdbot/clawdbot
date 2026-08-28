import Foundation
import Network

/// A test owns the listener until `stop()`, after closing its dashboard windows.
@MainActor
final class DashboardHTTPFixture {
    static let html = "<!doctype html><html><head><title>Dashboard fixture</title></head><body>Ready</body></html>"

    private struct Client {
        let connection: NWConnection
        let timeout: DispatchWorkItem
        var request = Data()
    }

    private let listener: NWListener
    private var clients: [UUID: Client] = [:]
    private var stopped = false
    nonisolated let port: UInt16

    private init(listener: NWListener, port: UInt16) {
        self.listener = listener
        self.port = port
        self.listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated {
                guard let self else {
                    connection.cancel()
                    return
                }
                self.accept(connection)
            }
        }
    }

    static func start() async throws -> DashboardHTTPFixture {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters, on: .any)
        listener.newConnectionHandler = { $0.cancel() }
        listener.start(queue: .main)
        do {
            let deadline = ContinuousClock.now + .seconds(5)
            while ContinuousClock.now < deadline {
                try Task.checkCancellation()
                switch listener.state {
                case .ready:
                    guard let port = listener.port, port.rawValue != 0 else {
                        throw URLError(.cannotFindHost)
                    }
                    return DashboardHTTPFixture(listener: listener, port: port.rawValue)
                case let .failed(error):
                    throw error
                case .cancelled:
                    throw CancellationError()
                default:
                    try await Task.sleep(for: .milliseconds(10))
                }
            }
            throw URLError(.timedOut)
        } catch {
            listener.cancel()
            throw error
        }
    }

    nonisolated func url(_ path: String = "/") -> URL {
        URL(string: "http://127.0.0.1:\(self.port)\(path)")!
    }

    nonisolated func websocketURL(_ path: String = "/") -> URL {
        URL(string: "ws://127.0.0.1:\(self.port)\(path)")!
    }

    func stop() {
        guard !self.stopped else { return }
        self.stopped = true
        self.listener.cancel()
        for id in Array(self.clients.keys) {
            self.close(id)
        }
    }

    private func accept(_ connection: NWConnection) {
        guard !self.stopped, self.clients.count < 32 else {
            connection.cancel()
            return
        }
        let id = UUID()
        let timeout = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.close(id) }
        }
        self.clients[id] = Client(connection: connection, timeout: timeout)
        connection.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: timeout)
        self.receive(id)
    }

    private func receive(_ id: UUID) {
        guard let client = self.clients[id] else { return }
        // One bounded request per connection; neither slow clients nor a partial
        // header can leave a receive alive beyond the connection's deadline.
        client.connection.receive(minimumIncompleteLength: 1, maximumLength: 8192 - client.request.count) {
            [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, var client = self.clients[id] else { return }
                if let data { client.request.append(data) }
                self.clients[id] = client
                if client.request.range(of: Data("\r\n\r\n".utf8)) != nil {
                    self.respond(id)
                } else if error != nil || complete || client.request.count >= 8192 {
                    self.close(id)
                } else {
                    self.receive(id)
                }
            }
        }
    }

    private func respond(_ id: UUID) {
        guard let client = self.clients[id] else { return }
        let body = Data(Self.html.utf8)
        // No scripts, subresources, redirects, cookies, or gateway RPCs. The CSP
        // also fences accidental page resource additions to this inert fixture.
        let headers = [
            "HTTP/1.1 200 OK",
            "Content-Type: text/html; charset=utf-8",
            "Content-Length: \(body.count)",
            "Cache-Control: no-store",
            "Content-Security-Policy: default-src 'none'",
            "Connection: close",
        ].joined(separator: "\r\n") + "\r\n\r\n"
        client.connection.send(content: Data(headers.utf8) + body, completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated { self?.close(id) }
        })
    }

    private func close(_ id: UUID) {
        guard let client = self.clients.removeValue(forKey: id) else { return }
        client.timeout.cancel()
        client.connection.cancel()
    }
}
