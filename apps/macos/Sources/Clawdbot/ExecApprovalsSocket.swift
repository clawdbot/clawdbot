import AppKit
import ClawdbotKit
import Darwin
import Foundation
import OSLog

struct ExecApprovalPromptRequest: Codable, Sendable {
    var command: String
    var cwd: String?
    var host: String?
    var security: String?
    var ask: String?
    var agentId: String?
    var resolvedPath: String?
}

private struct ExecApprovalSocketRequest: Codable {
    var type: String
    var token: String
    var id: String
    var request: ExecApprovalPromptRequest
}

private struct ExecApprovalSocketDecision: Codable {
    var type: String
    var id: String
    var decision: ExecApprovalDecision
}

enum ExecApprovalsSocketClient {
    private struct TimeoutError: LocalizedError {
        var message: String
        var errorDescription: String? { message }
    }

    static func requestDecision(
        socketPath: String,
        token: String,
        request: ExecApprovalPromptRequest,
        timeoutMs: Int = 15_000) async -> ExecApprovalDecision?
    {
        let trimmedPath = socketPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty, !trimmedToken.isEmpty else { return nil }
        do {
            return try await AsyncTimeout.withTimeoutMs(timeoutMs: timeoutMs, onTimeout: {
                TimeoutError(message: "exec approvals socket timeout")
            }, operation: {
                try await Task.detached {
                    try self.requestDecisionSync(
                        socketPath: trimmedPath,
                        token: trimmedToken,
                        request: request)
                }.value
            })
        } catch {
            return nil
        }
    }

    private static func requestDecisionSync(
        socketPath: String,
        token: String,
        request: ExecApprovalPromptRequest) throws -> ExecApprovalDecision?
    {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw NSError(domain: "ExecApprovals", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "socket create failed",
            ])
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        if socketPath.utf8.count >= maxLen {
            throw NSError(domain: "ExecApprovals", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "socket path too long",
            ])
        }
        socketPath.withCString { cstr in
            withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
                let raw = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: Int8.self)
                strncpy(raw, cstr, maxLen - 1)
            }
        }
        let size = socklen_t(MemoryLayout.size(ofValue: addr))
        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                connect(fd, rebound, size)
            }
        }
        if result != 0 {
            throw NSError(domain: "ExecApprovals", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "socket connect failed",
            ])
        }

        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)

        let message = ExecApprovalSocketRequest(
            type: "request",
            token: token,
            id: UUID().uuidString,
            request: request)
        let data = try JSONEncoder().encode(message)
        var payload = data
        payload.append(0x0A)
        try handle.write(contentsOf: payload)

        guard let line = try self.readLine(from: handle, maxBytes: 256_000),
              let lineData = line.data(using: .utf8)
        else { return nil }
        let response = try JSONDecoder().decode(ExecApprovalSocketDecision.self, from: lineData)
        return response.decision
    }

    private static func readLine(from handle: FileHandle, maxBytes: Int) throws -> String? {
        var buffer = Data()
        while buffer.count < maxBytes {
            let chunk = try handle.read(upToCount: 4096) ?? Data()
            if chunk.isEmpty { break }
            buffer.append(chunk)
            if buffer.contains(0x0A) { break }
        }
        guard let newlineIndex = buffer.firstIndex(of: 0x0A) else {
            guard !buffer.isEmpty else { return nil }
            return String(data: buffer, encoding: .utf8)
        }
        let lineData = buffer.subdata(in: 0..<newlineIndex)
        return String(data: lineData, encoding: .utf8)
    }
}

@MainActor
final class ExecApprovalsPromptServer {
    static let shared = ExecApprovalsPromptServer()

    private var server: ExecApprovalsSocketServer?

    func start() {
        guard self.server == nil else { return }
        let approvals = ExecApprovalsStore.resolve(agentId: nil)
        let server = ExecApprovalsSocketServer(
            socketPath: approvals.socketPath,
            token: approvals.token,
            onPrompt: { request in
                await ExecApprovalsPromptPresenter.prompt(request)
            })
        server.start()
        self.server = server
    }

    func stop() {
        self.server?.stop()
        self.server = nil
    }
}

private enum ExecApprovalsPromptPresenter {
    @MainActor
    static func prompt(_ request: ExecApprovalPromptRequest) -> ExecApprovalDecision {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Allow this command?"

        var details = "Clawdbot wants to run:\n\n\(request.command)"
        let trimmedCwd = request.cwd?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedCwd.isEmpty {
            details += "\n\nWorking directory:\n\(trimmedCwd)"
        }
        let trimmedAgent = request.agentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedAgent.isEmpty {
            details += "\n\nAgent:\n\(trimmedAgent)"
        }
        let trimmedPath = request.resolvedPath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedPath.isEmpty {
            details += "\n\nExecutable:\n\(trimmedPath)"
        }
        let trimmedHost = request.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedHost.isEmpty {
            details += "\n\nHost:\n\(trimmedHost)"
        }
        if let security = request.security?.trimmingCharacters(in: .whitespacesAndNewlines), !security.isEmpty {
            details += "\n\nSecurity:\n\(security)"
        }
        if let ask = request.ask?.trimmingCharacters(in: .whitespacesAndNewlines), !ask.isEmpty {
            details += "\nAsk mode:\n\(ask)"
        }
        details += "\n\nThis runs on this machine."
        alert.informativeText = details

        alert.addButton(withTitle: "Allow Once")
        alert.addButton(withTitle: "Always Allow")
        alert.addButton(withTitle: "Don't Allow")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            return .allowOnce
        case .alertSecondButtonReturn:
            return .allowAlways
        default:
            return .deny
        }
    }
}

private final class ExecApprovalsSocketServer {
    private let logger = Logger(subsystem: "com.clawdbot", category: "exec-approvals.socket")
    private let socketPath: String
    private let token: String
    private let onPrompt: @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision
    private var socketFD: Int32 = -1
    private var acceptTask: Task<Void, Never>?
    private var isRunning = false

    init(
        socketPath: String,
        token: String,
        onPrompt: @escaping @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision)
    {
        self.socketPath = socketPath
        self.token = token
        self.onPrompt = onPrompt
    }

    func start() {
        guard !self.isRunning else { return }
        self.isRunning = true
        self.acceptTask = Task.detached { [weak self] in
            await self?.runAcceptLoop()
        }
    }

    func stop() {
        self.isRunning = false
        self.acceptTask?.cancel()
        self.acceptTask = nil
        if self.socketFD >= 0 {
            close(self.socketFD)
            self.socketFD = -1
        }
        if !self.socketPath.isEmpty {
            unlink(self.socketPath)
        }
    }

    private func runAcceptLoop() async {
        let fd = self.openSocket()
        guard fd >= 0 else {
            self.isRunning = false
            return
        }
        self.socketFD = fd
        while self.isRunning {
            var addr = sockaddr_un()
            var len = socklen_t(MemoryLayout.size(ofValue: addr))
            let client = withUnsafeMutablePointer(to: &addr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                    accept(fd, rebound, &len)
                }
            }
            if client < 0 {
                if errno == EINTR { continue }
                break
            }
            Task.detached { [weak self] in
                await self?.handleClient(fd: client)
            }
        }
    }

    private func openSocket() -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            self.logger.error("exec approvals socket create failed")
            return -1
        }
        unlink(self.socketPath)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        if self.socketPath.utf8.count >= maxLen {
            self.logger.error("exec approvals socket path too long")
            close(fd)
            return -1
        }
        self.socketPath.withCString { cstr in
            withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
                let raw = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: Int8.self)
                memset(raw, 0, maxLen)
                strncpy(raw, cstr, maxLen - 1)
            }
        }
        let size = socklen_t(MemoryLayout.size(ofValue: addr))
        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                bind(fd, rebound, size)
            }
        }
        if result != 0 {
            self.logger.error("exec approvals socket bind failed")
            close(fd)
            return -1
        }
        if listen(fd, 16) != 0 {
            self.logger.error("exec approvals socket listen failed")
            close(fd)
            return -1
        }
        chmod(self.socketPath, 0o600)
        self.logger.info("exec approvals socket listening at \(self.socketPath, privacy: .public)")
        return fd
    }

    private func handleClient(fd: Int32) async {
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            guard let line = try self.readLine(from: handle, maxBytes: 256_000),
                  let data = line.data(using: .utf8)
            else {
                return
            }
            let request = try JSONDecoder().decode(ExecApprovalSocketRequest.self, from: data)
            guard request.type == "request", request.token == self.token else {
                let response = ExecApprovalSocketDecision(type: "decision", id: request.id, decision: .deny)
                let data = try JSONEncoder().encode(response)
                var payload = data
                payload.append(0x0A)
                try handle.write(contentsOf: payload)
                return
            }
            let decision = await self.onPrompt(request.request)
            let response = ExecApprovalSocketDecision(type: "decision", id: request.id, decision: decision)
            let responseData = try JSONEncoder().encode(response)
            var payload = responseData
            payload.append(0x0A)
            try handle.write(contentsOf: payload)
        } catch {
            self.logger.error("exec approvals socket handling failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func readLine(from handle: FileHandle, maxBytes: Int) throws -> String? {
        var buffer = Data()
        while buffer.count < maxBytes {
            let chunk = try handle.read(upToCount: 4096) ?? Data()
            if chunk.isEmpty { break }
            buffer.append(chunk)
            if buffer.contains(0x0A) { break }
        }
        guard let newlineIndex = buffer.firstIndex(of: 0x0A) else {
            guard !buffer.isEmpty else { return nil }
            return String(data: buffer, encoding: .utf8)
        }
        let lineData = buffer.subdata(in: 0..<newlineIndex)
        return String(data: lineData, encoding: .utf8)
    }
}
