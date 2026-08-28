import Darwin
import Foundation
@testable import OpenClaw

enum ExecApprovalsSocketTestSupport {
    static func makeRoot() throws -> URL {
        let root = URL(fileURLWithPath: "/tmp/ocst-\(UUID().uuidString.prefix(12))", isDirectory: true)
        try FileManager().createDirectory(
            at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return root.resolvingSymlinksInPath()
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
        try await Task.detached {
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { throw POSIXError(.EIO) }
            defer { close(fd) }
            try configureSocketTimeouts(fd, timeoutMs: timeoutMs)
            var noSigPipe: Int32 = 1
            guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0
            else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }

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
            guard connected == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }

            var payload = try JSONEncoder().encode(message)
            payload.append(0x0A)
            try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: payload)
            guard let line = try readLineFromSocket(fd, maxBytes: 256_000) else { throw POSIXError(.ECONNRESET) }
            return try JSONDecoder().decode(response, from: Data(line.utf8))
        }.value
    }
}
