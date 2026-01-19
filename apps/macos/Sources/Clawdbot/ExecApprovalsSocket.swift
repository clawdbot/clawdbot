import AppKit
import ClawdbotKit
import CryptoKit
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

private struct ExecHostSocketRequest: Codable {
    var type: String
    var id: String
    var nonce: String
    var ts: Int
    var hmac: String
    var requestJson: String
}

private struct ExecHostRequest: Codable {
    var command: [String]
    var rawCommand: String?
    var cwd: String?
    var env: [String: String]?
    var timeoutMs: Int?
    var needsScreenRecording: Bool?
    var agentId: String?
    var sessionKey: String?
}

private struct ExecHostRunResult: Codable {
    var exitCode: Int?
    var timedOut: Bool
    var success: Bool
    var stdout: String
    var stderr: String
    var error: String?
}

private struct ExecHostError: Codable {
    var code: String
    var message: String
    var reason: String?
}

private struct ExecHostResponse: Codable {
    var type: String
    var id: String
    var ok: Bool
    var payload: ExecHostRunResult?
    var error: ExecHostError?
}

enum ExecApprovalsSocketClient {
    private struct TimeoutError: LocalizedError {
        var message: String
        var errorDescription: String? { self.message }
    }

    static func requestDecision(
        socketPath: String,
        token: String,
        request: ExecApprovalPromptRequest,
        timeoutMs: Int = 15000) async -> ExecApprovalDecision?
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
            },
            onExec: { request in
                await ExecHostExecutor.handle(request)
            })
        server.start()
        self.server = server
    }

    func stop() {
        self.server?.stop()
        self.server = nil
    }
}

enum ExecApprovalsPromptPresenter {
    @MainActor
    static func prompt(_ request: ExecApprovalPromptRequest) -> ExecApprovalDecision {
        NSApp.activate(ignoringOtherApps: true)
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

@MainActor
private enum ExecHostExecutor {
    private static let blockedEnvKeys: Set<String> = [
        "PATH",
        "NODE_OPTIONS",
        "PYTHONHOME",
        "PYTHONPATH",
        "PERL5LIB",
        "PERL5OPT",
        "RUBYOPT",
    ]

    private static let blockedEnvPrefixes: [String] = [
        "DYLD_",
        "LD_",
    ]

    static func handle(_ request: ExecHostRequest) async -> ExecHostResponse {
        let command = request.command.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !command.isEmpty else {
            return ExecHostResponse(
                type: "exec-res",
                id: UUID().uuidString,
                ok: false,
                payload: nil,
                error: ExecHostError(code: "INVALID_REQUEST", message: "command required", reason: "invalid"))
        }

        let displayCommand = ExecCommandFormatter.displayString(
            for: command,
            rawCommand: request.rawCommand)
        let agentId = request.agentId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedAgent = (agentId?.isEmpty == false) ? agentId : nil
        let approvals = ExecApprovalsStore.resolve(agentId: trimmedAgent)
        let security = approvals.agent.security
        let ask = approvals.agent.ask
        let autoAllowSkills = approvals.agent.autoAllowSkills
        let env = self.sanitizedEnv(request.env)
        let resolution = ExecCommandResolution.resolve(
            command: command,
            rawCommand: request.rawCommand,
            cwd: request.cwd,
            env: env)
        let allowlistMatch = security == .allowlist
            ? ExecAllowlistMatcher.match(entries: approvals.allowlist, resolution: resolution)
            : nil
        let skillAllow: Bool
        if autoAllowSkills, let name = resolution?.executableName {
            let bins = await SkillBinsCache.shared.currentBins()
            skillAllow = bins.contains(name)
        } else {
            skillAllow = false
        }

        if security == .deny {
            return ExecHostResponse(
                type: "exec-res",
                id: UUID().uuidString,
                ok: false,
                payload: nil,
                error: ExecHostError(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DISABLED: security=deny",
                    reason: "security=deny"))
        }

        let requiresAsk: Bool = {
            if ask == .always { return true }
            if ask == .onMiss, security == .allowlist, allowlistMatch == nil, !skillAllow { return true }
            return false
        }()

        var approvedByAsk = false
        if requiresAsk {
            let decision = ExecApprovalsPromptPresenter.prompt(
                ExecApprovalPromptRequest(
                    command: displayCommand,
                    cwd: request.cwd,
                    host: "node",
                    security: security.rawValue,
                    ask: ask.rawValue,
                    agentId: trimmedAgent,
                    resolvedPath: resolution?.resolvedPath))

            switch decision {
            case .deny:
                return ExecHostResponse(
                    type: "exec-res",
                    id: UUID().uuidString,
                    ok: false,
                    payload: nil,
                    error: ExecHostError(
                        code: "UNAVAILABLE",
                        message: "SYSTEM_RUN_DENIED: user denied",
                        reason: "user-denied"))
            case .allowAlways:
                approvedByAsk = true
                if security == .allowlist {
                    let pattern = resolution?.resolvedPath ?? resolution?.rawExecutable ?? command.first ?? ""
                    if !pattern.isEmpty {
                        ExecApprovalsStore.addAllowlistEntry(agentId: trimmedAgent, pattern: pattern)
                    }
                }
            case .allowOnce:
                approvedByAsk = true
            }
        }

        if security == .allowlist, allowlistMatch == nil, !skillAllow, !approvedByAsk {
            return ExecHostResponse(
                type: "exec-res",
                id: UUID().uuidString,
                ok: false,
                payload: nil,
                error: ExecHostError(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DENIED: allowlist miss",
                    reason: "allowlist-miss"))
        }

        if let match = allowlistMatch {
            ExecApprovalsStore.recordAllowlistUse(
                agentId: trimmedAgent,
                pattern: match.pattern,
                command: displayCommand,
                resolvedPath: resolution?.resolvedPath)
        }

        if request.needsScreenRecording == true {
            let authorized = await PermissionManager
                .status([.screenRecording])[.screenRecording] ?? false
            if !authorized {
                return ExecHostResponse(
                    type: "exec-res",
                    id: UUID().uuidString,
                    ok: false,
                    payload: nil,
                    error: ExecHostError(
                        code: "UNAVAILABLE",
                        message: "PERMISSION_MISSING: screenRecording",
                        reason: "permission:screenRecording"))
            }
        }

        let timeoutSec = request.timeoutMs.flatMap { Double($0) / 1000.0 }
        let result = await Task.detached { () -> ShellExecutor.ShellResult in
            await ShellExecutor.runDetailed(
                command: command,
                cwd: request.cwd,
                env: env,
                timeout: timeoutSec)
        }.value
        let payload = ExecHostRunResult(
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            success: result.success,
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.errorMessage)
        return ExecHostResponse(
            type: "exec-res",
            id: UUID().uuidString,
            ok: true,
            payload: payload,
            error: nil)
    }

    private static func sanitizedEnv(_ overrides: [String: String]?) -> [String: String]? {
        guard let overrides else { return nil }
        var merged = ProcessInfo.processInfo.environment
        for (rawKey, value) in overrides {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            let upper = key.uppercased()
            if self.blockedEnvKeys.contains(upper) { continue }
            if self.blockedEnvPrefixes.contains(where: { upper.hasPrefix($0) }) { continue }
            merged[key] = value
        }
        return merged
    }
}

private final class ExecApprovalsSocketServer: @unchecked Sendable {
    private let logger = Logger(subsystem: "com.clawdbot", category: "exec-approvals.socket")
    private let socketPath: String
    private let token: String
    private let onPrompt: @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision
    private let onExec: @Sendable (ExecHostRequest) async -> ExecHostResponse
    private var socketFD: Int32 = -1
    private var acceptTask: Task<Void, Never>?
    private var isRunning = false

    init(
        socketPath: String,
        token: String,
        onPrompt: @escaping @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision,
        onExec: @escaping @Sendable (ExecHostRequest) async -> ExecHostResponse)
    {
        self.socketPath = socketPath
        self.token = token
        self.onPrompt = onPrompt
        self.onExec = onExec
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
            guard self.isAllowedPeer(fd: fd) else {
                try self.sendApprovalResponse(handle: handle, id: UUID().uuidString, decision: .deny)
                return
            }
            guard let line = try self.readLine(from: handle, maxBytes: 256_000),
                  let data = line.data(using: .utf8)
            else {
                return
            }
            guard
                let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                let type = envelope["type"] as? String
            else {
                return
            }

            if type == "request" {
                let request = try JSONDecoder().decode(ExecApprovalSocketRequest.self, from: data)
                guard request.token == self.token else {
                    try self.sendApprovalResponse(handle: handle, id: request.id, decision: .deny)
                    return
                }
                let decision = await self.onPrompt(request.request)
                try self.sendApprovalResponse(handle: handle, id: request.id, decision: decision)
                return
            }

            if type == "exec" {
                let request = try JSONDecoder().decode(ExecHostSocketRequest.self, from: data)
                let response = await self.handleExecRequest(request)
                try self.sendExecResponse(handle: handle, response: response)
                return
            }
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

    private func sendApprovalResponse(
        handle: FileHandle,
        id: String,
        decision: ExecApprovalDecision) throws
    {
        let response = ExecApprovalSocketDecision(type: "decision", id: id, decision: decision)
        let data = try JSONEncoder().encode(response)
        var payload = data
        payload.append(0x0A)
        try handle.write(contentsOf: payload)
    }

    private func sendExecResponse(handle: FileHandle, response: ExecHostResponse) throws {
        let data = try JSONEncoder().encode(response)
        var payload = data
        payload.append(0x0A)
        try handle.write(contentsOf: payload)
    }

    private func isAllowedPeer(fd: Int32) -> Bool {
        var uid = uid_t(0)
        var gid = gid_t(0)
        if getpeereid(fd, &uid, &gid) != 0 {
            return false
        }
        return uid == geteuid()
    }

    private func handleExecRequest(_ request: ExecHostSocketRequest) async -> ExecHostResponse {
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        if abs(nowMs - request.ts) > 10000 {
            return ExecHostResponse(
                type: "exec-res",
                id: request.id,
                ok: false,
                payload: nil,
                error: ExecHostError(code: "INVALID_REQUEST", message: "expired request", reason: "ttl"))
        }
        let expected = self.hmacHex(nonce: request.nonce, ts: request.ts, requestJson: request.requestJson)
        if expected != request.hmac {
            return ExecHostResponse(
                type: "exec-res",
                id: request.id,
                ok: false,
                payload: nil,
                error: ExecHostError(code: "INVALID_REQUEST", message: "invalid auth", reason: "hmac"))
        }
        guard let requestData = request.requestJson.data(using: .utf8),
              let payload = try? JSONDecoder().decode(ExecHostRequest.self, from: requestData)
        else {
            return ExecHostResponse(
                type: "exec-res",
                id: request.id,
                ok: false,
                payload: nil,
                error: ExecHostError(code: "INVALID_REQUEST", message: "invalid payload", reason: "json"))
        }
        let response = await self.onExec(payload)
        return ExecHostResponse(
            type: "exec-res",
            id: request.id,
            ok: response.ok,
            payload: response.payload,
            error: response.error)
    }

    private func hmacHex(nonce: String, ts: Int, requestJson: String) -> String {
        let key = SymmetricKey(data: Data(self.token.utf8))
        let message = "\(nonce):\(ts):\(requestJson)"
        let mac = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)
        return mac.map { String(format: "%02x", $0) }.joined()
    }
}
