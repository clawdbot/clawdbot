import Darwin
import Dispatch
import Foundation
@testable import OpenClaw

enum ExecApprovalsSocketTestSupport {
    private static let blockingSocketQueue = DispatchQueue(label: "exec-approvals-test.socket", attributes: .concurrent)

    static func withBlockingSocketIO<Value: Sendable>(
        _ operation: @escaping @Sendable () throws -> Value) async throws -> Value
    {
        // Keep blocking I/O off the cooperative executor, and join it before callers
        // can close descriptors or remove fixture roots, including on cancellation.
        try await withCheckedThrowingContinuation { continuation in
            self.blockingSocketQueue.async {
                continuation.resume(with: Result(catching: operation))
            }
        }
    }

    static func makeRoot() throws -> URL {
        let base = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
        let template = base.appendingPathComponent("XXXXXX", isDirectory: true).path
        // CuaDriverHostCoordinator.createSocketDirectory adds this 39-byte suffix.
        // Reserve its full sun_path budget before mkdtemp creates any fixture state.
        let longestSocketPath = template + "/OpenClaw/cua/0000000000000000/cua.sock"
        guard longestSocketPath.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENAMETOOLONG), userInfo: [
                NSLocalizedDescriptionKey:
                    "Native socket fixtures need a shorter per-user temporary directory in the disposable runner.",
            ])
        }
        var bytes = Array(template.utf8CString)
        return try bytes.withUnsafeMutableBufferPointer { buffer in
            guard let created = mkdtemp(buffer.baseAddress!) else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            return URL(fileURLWithPath: String(cString: created), isDirectory: true).resolvingSymlinksInPath()
        }
    }

    static func makeServer(
        socketPath: String,
        onPrompt: @escaping @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision? = { _ in .deny })
        -> ExecApprovalsSocketServer
    {
        ExecApprovalsSocketServer(
            socketPath: socketPath,
            token: "test-token",
            onPrompt: onPrompt,
            onExec: { _ in
                ExecHostResponse(type: "exec-res", id: "test", ok: true, payload: nil, error: nil)
            },
            onUnexpectedStop: { _ in })
    }

    static func requestDecision(
        socketPath: String,
        token: String = "test-token",
        timeoutMs: Int = 100) async -> ExecApprovalDecision?
    {
        let response = try? await self.roundTrip(
            socketPath: socketPath,
            message: ExecApprovalSocketRequest(
                type: "request",
                token: token,
                id: UUID().uuidString,
                request: ExecApprovalPromptRequest(command: "echo ready")),
            response: ExecApprovalSocketDecision.self,
            timeoutMs: timeoutMs)
        return response?.decision
    }

    static func roundTrip<Response: Decodable & Sendable>(
        socketPath: String,
        message: some Encodable & Sendable,
        response: Response.Type,
        timeoutMs: Int = 1000) async throws -> Response
    {
        try await self.withBlockingSocketIO {
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            defer { close(fd) }
            try configureSocketTimeouts(fd, timeoutMs: timeoutMs)
            var noSigPipe: Int32 = 1
            guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0
            else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }

            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let capacity = MemoryLayout.size(ofValue: address.sun_path)
            guard socketPath.utf8.count < capacity else { throw POSIXError(.ENAMETOOLONG) }
            socketPath.withCString { source in
                withUnsafeMutablePointer(to: &address.sun_path) {
                    $0.withMemoryRebound(to: CChar.self, capacity: capacity) {
                        _ = strcpy($0, source)
                    }
                }
            }
            let connected = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard connected == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }

            var payload = try JSONEncoder().encode(message)
            payload.append(0x0A)
            try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: payload)
            guard let line = try readLineFromSocket(fd, maxBytes: 256_000) else { throw POSIXError(.ECONNRESET) }
            return try JSONDecoder().decode(response, from: Data(line.utf8))
        }
    }
}
