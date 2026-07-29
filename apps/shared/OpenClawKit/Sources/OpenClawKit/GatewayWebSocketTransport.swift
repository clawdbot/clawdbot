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
    /// Bounds a ping whose pong handler URLSession may never invoke. Long enough that a
    /// slow-but-live link still pongs, short enough that a wedged keepalive recovers.
    public static let pingTimeout: Duration = .seconds(10)

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

    public func sendPing(timeout: Duration = WebSocketTaskBox.pingTimeout) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let gate = WebSocketPingContinuationGate()
            // URLSession drops the pong handler entirely when the task is cancelled or
            // closed mid-flight, which orphans this continuation and wedges the keepalive
            // loop forever on an await that can never return. The deadline guarantees the
            // continuation always resumes; the gate keeps that resume exactly once.
            let deadline = Task {
                do {
                    try await Task.sleep(for: timeout)
                } catch {
                    // Cancelled because a pong arrived first; that callback owns the resume.
                    // Swallowing this error instead would race the gate and report a healthy
                    // ping as timed out.
                    return
                }
                gate.resumeOnce {
                    // URLError keeps this indistinguishable from a transport timeout for
                    // callers, which already handle URLSession errors from every other path.
                    ThrowingContinuationSupport.resumeVoid(continuation, error: URLError(.timedOut))
                }
            }
            self.task.sendPing { error in
                deadline.cancel()
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
