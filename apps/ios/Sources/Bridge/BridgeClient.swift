import ClawdbotKit
import Foundation
import Network

actor BridgeClient {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var lineBuffer = Data()

    func pairAndHello(
        endpoint: NWEndpoint,
        hello: BridgeHello,
        onStatus: (@Sendable (String) -> Void)? = nil) async throws -> String
    {
        self.lineBuffer = Data()
        let connection = NWConnection(to: endpoint, using: .tcp)
        let queue = DispatchQueue(label: "com.clawdbot.ios.bridge-client")
        defer { connection.cancel() }
        try await self.withTimeout(seconds: 8, purpose: "connect") {
            try await self.startAndWaitForReady(connection, queue: queue)
        }

        onStatus?("Authenticating…")
        try await self.send(hello, over: connection)

        let first = try await self.withTimeout(seconds: 10, purpose: "hello") { () -> ReceivedFrame in
            guard let frame = try await self.receiveFrame(over: connection) else {
                throw NSError(domain: "Bridge", code: 0, userInfo: [
                    NSLocalizedDescriptionKey: "Bridge closed connection during hello",
                ])
            }
            return frame
        }

        switch first.base.type {
        case "hello-ok":
            // We only return a token if we have one; callers should treat empty as "no token yet".
            return hello.token ?? ""

        case "error":
            let err = try self.decoder.decode(BridgeErrorFrame.self, from: first.data)
            if err.code != "NOT_PAIRED", err.code != "UNAUTHORIZED" {
                throw NSError(domain: "Bridge", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "\(err.code): \(err.message)",
                ])
            }

            onStatus?("Requesting approval…")
            try await self.send(
                BridgePairRequest(
                    nodeId: hello.nodeId,
                    displayName: hello.displayName,
                    platform: hello.platform,
                    version: hello.version,
                    deviceFamily: hello.deviceFamily,
                    modelIdentifier: hello.modelIdentifier,
                    caps: hello.caps,
                    commands: hello.commands),
                over: connection)

            onStatus?("Waiting for approval…")
            let ok = try await self.withTimeout(seconds: 60, purpose: "pairing approval") {
                while let next = try await self.receiveFrame(over: connection) {
                    switch next.base.type {
                    case "pair-ok":
                        return try self.decoder.decode(BridgePairOk.self, from: next.data)
                    case "error":
                        let e = try self.decoder.decode(BridgeErrorFrame.self, from: next.data)
                        throw NSError(domain: "Bridge", code: 2, userInfo: [
                            NSLocalizedDescriptionKey: "\(e.code): \(e.message)",
                        ])
                    default:
                        continue
                    }
                }
                throw NSError(domain: "Bridge", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "Pairing failed: bridge closed connection",
                ])
            }

            return ok.token

        default:
            throw NSError(domain: "Bridge", code: 0, userInfo: [
                NSLocalizedDescriptionKey: "Unexpected bridge response",
            ])
        }
    }

    private func send(_ obj: some Encodable, over connection: NWConnection) async throws {
        let data = try self.encoder.encode(obj)
        var line = Data()
        line.append(data)
        line.append(0x0A)
        try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Void, Error>) in
            connection.send(content: line, completion: .contentProcessed { err in
                if let err { cont.resume(throwing: err) } else { cont.resume(returning: ()) }
            })
        }
    }

    private struct ReceivedFrame {
        var base: BridgeBaseFrame
        var data: Data
    }

    private func receiveFrame(over connection: NWConnection) async throws -> ReceivedFrame? {
        guard let lineData = try await self.receiveLineData(over: connection) else {
            return nil
        }
        let base = try self.decoder.decode(BridgeBaseFrame.self, from: lineData)
        return ReceivedFrame(base: base, data: lineData)
    }

    private func receiveChunk(over connection: NWConnection) async throws -> Data {
        try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Data, Error>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                if isComplete {
                    cont.resume(returning: Data())
                    return
                }
                cont.resume(returning: data ?? Data())
            }
        }
    }

    private func receiveLineData(over connection: NWConnection) async throws -> Data? {
        while true {
            if let idx = self.lineBuffer.firstIndex(of: 0x0A) {
                let line = self.lineBuffer.prefix(upTo: idx)
                self.lineBuffer.removeSubrange(...idx)
                return Data(line)
            }

            let chunk = try await self.receiveChunk(over: connection)
            if chunk.isEmpty { return nil }
            self.lineBuffer.append(chunk)
        }
    }

    private struct TimeoutError: LocalizedError, Sendable {
        var purpose: String
        var seconds: Int

        var errorDescription: String? {
            if self.purpose == "pairing approval" {
                return
                    "Timed out waiting for approval (\(self.seconds)s). " +
                    "Approve the node on your gateway and try again."
            }
            return "Timed out during \(self.purpose) (\(self.seconds)s)."
        }
    }

    private func withTimeout<T: Sendable>(
        seconds: Int,
        purpose: String,
        _ op: @escaping @Sendable () async throws -> T) async throws -> T
    {
        try await AsyncTimeout.withTimeout(
            seconds: Double(seconds),
            onTimeout: { TimeoutError(purpose: purpose, seconds: seconds) },
            operation: op)
    }

    private func startAndWaitForReady(_ connection: NWConnection, queue: DispatchQueue) async throws {
        try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Void, Error>) in
            final class ResumeFlag: @unchecked Sendable {
                private let lock = NSLock()
                private var value = false

                func trySet() -> Bool {
                    self.lock.lock()
                    defer { self.lock.unlock() }
                    if self.value { return false }
                    self.value = true
                    return true
                }
            }
            let didResume = ResumeFlag()
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if didResume.trySet() { cont.resume(returning: ()) }
                case let .failed(err):
                    if didResume.trySet() { cont.resume(throwing: err) }
                case let .waiting(err):
                    if didResume.trySet() { cont.resume(throwing: err) }
                case .cancelled:
                    if didResume.trySet() {
                        cont.resume(throwing: NSError(domain: "Bridge", code: 50, userInfo: [
                            NSLocalizedDescriptionKey: "Connection cancelled",
                        ]))
                    }
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }
}
