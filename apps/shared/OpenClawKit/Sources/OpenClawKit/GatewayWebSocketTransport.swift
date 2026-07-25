import Foundation

public protocol WebSocketTasking: AnyObject {
    var state: URLSessionTask.State { get }
    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void)
    func receive() async throws -> URLSessionWebSocketTask.Message
    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
}

extension URLSessionWebSocketTask: WebSocketTasking {}

private final class WebSocketPingContinuationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var didResume = false

    func resumeOnce(_ resume: () -> Void) {
        self.lock.lock()
        if self.didResume {
            self.lock.unlock()
            return
        }
        self.didResume = true
        self.lock.unlock()
        resume()
    }
}

public struct WebSocketTaskBox: @unchecked Sendable {
    public let task: any WebSocketTasking
    public init(task: any WebSocketTasking) {
        self.task = task
    }

    public var state: URLSessionTask.State {
        self.task.state
    }

    public func resume() {
        self.task.resume()
    }

    public func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        self.task.cancel(with: closeCode, reason: reason)
    }

    public func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try await self.task.send(message)
    }

    public func receive() async throws -> URLSessionWebSocketTask.Message {
        try await self.task.receive()
    }

    public func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        self.task.receive(completionHandler: completionHandler)
    }

    public func sendPing() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let gate = WebSocketPingContinuationGate()
            self.task.sendPing { error in
                // URLSession can race ping callbacks with cancellation; only the first
                // pong result owns this checked continuation or Swift traps the app.
                gate.resumeOnce {
                    ThrowingContinuationSupport.resumeVoid(continuation, error: error)
                }
            }
        }
    }
}

public protocol WebSocketSessioning: AnyObject {
    func makeWebSocketTask(url: URL) -> WebSocketTaskBox
    func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox
}

extension WebSocketSessioning {
    /// Compatibility path for existing session conformers. URLSession and pinning sessions
    /// override this requirement so operator headers remain attached to the upgrade request.
    public func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        guard let url = request.url else { preconditionFailure("WebSocket request URL is required") }
        return self.makeWebSocketTask(url: url)
    }
}

extension URLSession: WebSocketSessioning {
    public func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    public func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        let task = self.webSocketTask(with: request)
        // Avoid "Message too long" receive errors for large snapshots / history payloads.
        task.maximumMessageSize = 16 * 1024 * 1024 // 16 MB
        return WebSocketTaskBox(task: task)
    }
}

public struct WebSocketSessionBox: @unchecked Sendable {
    public let session: any WebSocketSessioning

    public init(session: any WebSocketSessioning) {
        self.session = session
    }
}
