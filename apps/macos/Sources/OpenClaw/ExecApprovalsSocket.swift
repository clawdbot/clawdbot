import Darwin
import Foundation
import OpenClawKit

let execApprovalsSocketTimeoutMs = 15000

struct ExecApprovalPromptRequest: Codable {
    var command: String
    var cwd: String?
    var host: String?
    var security: String?
    var ask: String?
    var agentId: String?
    var resolvedPath: String?
    var sessionKey: String?
    var allowedDecisions: [ExecApprovalDecision]?

    init(
        command: String,
        cwd: String? = nil,
        host: String? = nil,
        security: String? = nil,
        ask: String? = nil,
        agentId: String? = nil,
        resolvedPath: String? = nil,
        sessionKey: String? = nil,
        allowedDecisions: [ExecApprovalDecision]? = nil)
    {
        self.command = command
        self.cwd = cwd
        self.host = host
        self.security = security
        self.ask = ask
        self.agentId = agentId
        self.resolvedPath = resolvedPath
        self.sessionKey = sessionKey
        self.allowedDecisions = allowedDecisions
    }

    private enum CodingKeys: String, CodingKey {
        case command
        case cwd
        case host
        case security
        case ask
        case agentId
        case resolvedPath
        case sessionKey
        case allowedDecisions
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.command = try container.decode(String.self, forKey: .command)
        self.cwd = try container.decodeIfPresent(String.self, forKey: .cwd)
        self.host = try container.decodeIfPresent(String.self, forKey: .host)
        self.security = try container.decodeIfPresent(String.self, forKey: .security)
        self.ask = try container.decodeIfPresent(String.self, forKey: .ask)
        self.agentId = try container.decodeIfPresent(String.self, forKey: .agentId)
        self.resolvedPath = try container.decodeIfPresent(String.self, forKey: .resolvedPath)
        self.sessionKey = try container.decodeIfPresent(String.self, forKey: .sessionKey)
        let decodedDecisions = (try? container.decodeIfPresent(
            [DecodedExecApprovalDecision].self,
            forKey: .allowedDecisions)) ?? []
        self.allowedDecisions = decodedDecisions.compactMap(\.decision)
    }

    static func allowedDecisions(
        forAsk ask: String?,
        allowAlwaysEligible: Bool = true) -> [ExecApprovalDecision]
    {
        // Older payloads did not carry ask/allowedDecisions. Preserve their durable
        // approval option; explicit ask=always and allowedDecisions payloads are the
        // policy-carrying shapes that remove it.
        guard allowAlwaysEligible else { return [.allowOnce, .deny] }
        return ask == ExecAsk.always.rawValue
            ? [.allowOnce, .deny]
            : [.allowOnce, .allowAlways, .deny]
    }
}

private struct DecodedExecApprovalDecision: Decodable {
    var decision: ExecApprovalDecision?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        guard let raw = try? container.decode(String.self) else {
            self.decision = nil
            return
        }
        self.decision = ExecApprovalDecision(rawValue: raw)
    }
}

struct ExecApprovalSocketRequest: Codable {
    var type: String
    var token: String
    var id: String
    var request: ExecApprovalPromptRequest
}

struct ExecApprovalSocketDecision: Codable {
    var type: String
    var id: String
    var decision: ExecApprovalDecision
}

struct ExecHostSocketRequest: Codable {
    var type: String
    var id: String
    var nonce: String
    var ts: Int
    var hmac: String
    var requestJson: String
}

struct ExecHostRequest: Codable {
    var command: [String]
    var rawCommand: String?
    var cwd: String?
    var env: [String: String]?
    var timeoutMs: Int?
    var needsScreenRecording: Bool?
    var agentId: String?
    var sessionKey: String?
    var approvalDecision: ExecApprovalDecision?
    var approvalSource: String?
    var policySnapshot: OpenClawSystemRunApprovalPolicySnapshot?
}

struct ExecHostRunResult: Codable {
    var exitCode: Int?
    var timedOut: Bool
    var success: Bool
    var stdout: String
    var stderr: String
    var error: String?
}

enum ExecHostOutputLimiter {
    static let maxJsonlResponseBytes = 16 * 1024 * 1024
    static let maxOutputFieldBytes = 1024 * 1024
    private static let truncationMarker = "... (truncated) "

    static func truncate(_ value: String) -> String {
        let bytes = value.utf8
        guard bytes.count > self.maxOutputFieldBytes else { return value }

        let tailBudget = self.maxOutputFieldBytes - self.truncationMarker.utf8.count
        var start = bytes.index(bytes.endIndex, offsetBy: -tailBudget)
        while start < bytes.endIndex, (bytes[start] & 0xC0) == 0x80 {
            start = bytes.index(after: start)
        }
        let tail = String(bytes: bytes[start...], encoding: .utf8) ?? ""
        return self.truncationMarker + tail
    }
}

struct ExecHostError: Codable, Error {
    var code: String
    var message: String
    var reason: String?
}

struct ExecHostResponse: Codable {
    var type: String
    var id: String
    var ok: Bool
    var payload: ExecHostRunResult?
    var error: ExecHostError?
}

func configureSocketTimeouts(_ fd: Int32, timeoutMs: Int) throws {
    guard timeoutMs > 0 else { return }
    var timeout = timeval(
        tv_sec: timeoutMs / 1000,
        tv_usec: Int32((timeoutMs % 1000) * 1000))
    let timeoutSize = socklen_t(MemoryLayout.size(ofValue: timeout))
    guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, timeoutSize) == 0,
          setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, timeoutSize) == 0
    else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}

func readLineFromSocket(_ fd: Int32, maxBytes: Int) throws -> String? {
    // Foundation can wait for the full requested byte count on sockets. POSIX
    // recv returns short JSONL frames; the socket timeout bounds idle peers.
    var buffer = Data()
    while buffer.count < maxBytes {
        var chunk = [UInt8](repeating: 0, count: min(4096, maxBytes - buffer.count))
        let count = chunk.withUnsafeMutableBytes { bytes in
            recv(fd, bytes.baseAddress, bytes.count, 0)
        }
        if count == 0 {
            break
        }
        if count < 0 {
            if errno == EINTR {
                continue
            }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        buffer.append(contentsOf: chunk.prefix(count))
        if buffer.contains(0x0A) {
            break
        }
    }
    guard let newlineIndex = buffer.firstIndex(of: 0x0A) else {
        guard !buffer.isEmpty else { return nil }
        return String(data: buffer, encoding: .utf8)
    }
    let lineData = buffer.subdata(in: 0..<newlineIndex)
    return String(data: lineData, encoding: .utf8)
}

func timingSafeHexStringEquals(_ lhs: String, _ rhs: String) -> Bool {
    let lhsBytes = Array(lhs.utf8)
    let rhsBytes = Array(rhs.utf8)
    guard lhsBytes.count == rhsBytes.count else {
        return false
    }

    var diff: UInt8 = 0
    for index in lhsBytes.indices {
        diff |= lhsBytes[index] ^ rhsBytes[index]
    }
    return diff == 0
}

func execHostTimestampIsFresh(
    nowMs: Int,
    requestMs: Int,
    toleranceMs: Int = 10000) -> Bool
{
    guard toleranceMs >= 0 else { return false }
    let (lowerBound, lowerOverflow) = nowMs.subtractingReportingOverflow(toleranceMs)
    if !lowerOverflow, requestMs < lowerBound {
        return false
    }
    let (upperBound, upperOverflow) = nowMs.addingReportingOverflow(toleranceMs)
    if !upperOverflow, requestMs > upperBound {
        return false
    }
    return true
}

enum ExecApprovalsSocketClient {
    private struct TimeoutError: LocalizedError {
        var message: String
        var errorDescription: String? {
            self.message
        }
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
            return try await AsyncTimeout.withTimeoutMs(
                timeoutMs: timeoutMs,
                onTimeout: {
                    TimeoutError(message: "exec approvals socket timeout")
                },
                operation: {
                    try await Task.detached {
                        try self.requestDecisionSync(
                            socketPath: trimmedPath,
                            token: trimmedToken,
                            request: request,
                            timeoutMs: timeoutMs)
                    }.value
                })
        } catch {
            return nil
        }
    }

    private static func requestDecisionSync(
        socketPath: String,
        token: String,
        request: ExecApprovalPromptRequest,
        timeoutMs: Int) throws -> ExecApprovalDecision?
    {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw NSError(domain: "ExecApprovals", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "socket create failed",
            ])
        }
        defer { close(fd) }
        try configureSocketTimeouts(fd, timeoutMs: timeoutMs)

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

        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)

        let message = ExecApprovalSocketRequest(
            type: "request",
            token: token,
            id: UUID().uuidString,
            request: request)
        let data = try JSONEncoder().encode(message)
        var payload = data
        payload.append(0x0A)
        try handle.write(contentsOf: payload)

        guard let line = try readLineFromSocket(fd, maxBytes: 256_000),
              let lineData = line.data(using: .utf8)
        else { return nil }
        let response = try JSONDecoder().decode(ExecApprovalSocketDecision.self, from: lineData)
        return response.decision
    }
}

@MainActor
final class ExecApprovalsPromptServer {
    static let shared = ExecApprovalsPromptServer()

    private let retryDelay: Duration
    private let maximumRetryDelay: Duration
    private let resolveSocketCredentials: @Sendable () -> (socketPath: String, token: String)
    private let onPrompt: @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision?
    private var server: ExecApprovalsSocketServer?
    private var retryTask: Task<Void, Never>?
    private var previousStartupTask: Task<Void, Never>?
    private var startupGeneration: UInt64 = 0

    init(
        retryDelay: Duration = .seconds(1),
        maximumRetryDelay: Duration = .seconds(30),
        resolveSocketCredentials: @escaping @Sendable () -> (socketPath: String, token: String) = {
            let approvals = ExecApprovalsStore.resolve(agentId: nil)
            return (approvals.socketPath, approvals.token)
        },
        onPrompt: @escaping @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision? = { request in
            await ExecApprovalsPromptPresenter.prompt(
                request,
                timeoutMs: execApprovalsSocketTimeoutMs)
        })
    {
        self.retryDelay = retryDelay
        self.maximumRetryDelay = maximumRetryDelay
        self.resolveSocketCredentials = resolveSocketCredentials
        self.onPrompt = onPrompt
    }

    func start() {
        guard self.server == nil, self.retryTask == nil else { return }
        self.startupGeneration &+= 1
        let generation = self.startupGeneration
        let retryDelay = self.retryDelay
        let maximumRetryDelay = self.maximumRetryDelay
        let resolveSocketCredentials = self.resolveSocketCredentials
        let onPrompt = self.onPrompt
        let previousStartupTask = self.previousStartupTask
        // Keep one lifecycle-owned retry loop. Blocking lock acquisition stays
        // off MainActor, while generation checks prevent post-stop installation.
        self.retryTask = Task { @MainActor [weak self] in
            // A canceled startup may still be unwinding socket-path cleanup.
            // Never let a replacement generation race that cleanup.
            if let previousStartupTask {
                await previousStartupTask.value
            }
            guard !Task.isCancelled, self?.startupGeneration == generation else { return }

            var isFirstAttempt = true
            var retryBackoff = ExecApprovalsPromptRetryBackoff(
                initialDelay: retryDelay,
                maximumDelay: maximumRetryDelay)
            while !Task.isCancelled {
                if isFirstAttempt {
                    isFirstAttempt = false
                } else {
                    do {
                        try await Task.sleep(for: retryBackoff.nextDelay())
                    } catch {
                        return
                    }
                }

                let credentials = await Task.detached(priority: .utility) {
                    resolveSocketCredentials()
                }.value
                guard !Task.isCancelled,
                      let self,
                      self.startupGeneration == generation
                else { return }

                let token = credentials.token.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !token.isEmpty else { continue }

                let server = ExecApprovalsSocketServer(
                    socketPath: credentials.socketPath,
                    token: token,
                    onPrompt: onPrompt,
                    onExec: { request in
                        await ExecHostExecutor.handle(request)
                    },
                    onUnexpectedStop: { [weak self] stoppedServer in
                        Task { @MainActor [weak self] in
                            self?.handleUnexpectedStop(stoppedServer, generation: generation)
                        }
                    })
                let ready = await withTaskCancellationHandler {
                    await server.start()
                } onCancel: {
                    server.stop()
                }
                guard !Task.isCancelled, self.startupGeneration == generation else {
                    await server.stop().value
                    return
                }
                guard ready else {
                    await server.stop().value
                    continue
                }
                // The accept loop can fail after signaling readiness but before
                // this task resumes. Do not install an already-dead listener.
                guard server.isListening else {
                    await server.stop().value
                    continue
                }
                self.server = server
                self.retryTask = nil
                return
            }
        }
    }

    @discardableResult
    func stop() -> Task<Void, Never>? {
        self.startupGeneration &+= 1
        let pendingRetry = self.retryTask
        pendingRetry?.cancel()
        let serverShutdown = self.server?.stop()
        self.retryTask = nil
        self.server = nil
        guard pendingRetry != nil || serverShutdown != nil else { return self.previousStartupTask }
        let previousStartup = self.previousStartupTask
        let cleanup = Task {
            await previousStartup?.value
            await pendingRetry?.value
            await serverShutdown?.value
        }
        self.previousStartupTask = cleanup
        return cleanup
    }

    private func handleUnexpectedStop(
        _ stoppedServer: ExecApprovalsSocketServer,
        generation: UInt64)
    {
        guard self.startupGeneration == generation,
              self.server === stoppedServer
        else { return }
        self.previousStartupTask = stoppedServer.stop()
        self.server = nil
        self.start()
    }

    #if DEBUG
    func _testFailActiveSocket() {
        self.server?.failForTesting()
    }

    static func _testPrecancelledSocketStart(
        socketPath: String) async -> (ready: Bool, preservedExistingListener: Bool)
    {
        let sentinel = ExecApprovalsSocketServer(
            socketPath: socketPath,
            token: "sentinel-token",
            onPrompt: { _ in nil },
            onExec: { request in
                await ExecHostExecutor.handle(request)
            },
            onUnexpectedStop: { _ in })
        guard await sentinel.start() else {
            sentinel.stop()
            return (false, false)
        }

        let socketServer = ExecApprovalsSocketServer(
            socketPath: socketPath,
            token: "test-token",
            onPrompt: { _ in nil },
            onExec: { request in
                await ExecHostExecutor.handle(request)
            },
            onUnexpectedStop: { _ in })
        let startup = Task.detached {
            withUnsafeCurrentTask { task in
                task?.cancel()
            }
            return await socketServer.start()
        }
        let ready = await startup.value
        socketServer.stop()
        let preservedExistingListener = sentinel.isListening &&
            (try? ExecApprovalsSocketPathGuard.pathKind(at: socketPath)) == .socket
        sentinel.stop()
        return (ready, preservedExistingListener)
    }

    static func _testSocketLeaseHandoff(
        socketPath: String) async -> (
        replacementBlockedWhileOwned: Bool,
        replacementStartedAfterRelease: Bool,
        replacementHasDistinctIdentity: Bool,
        replacementPreserved: Bool)
    {
        let first = ExecApprovalsSocketServer(
            socketPath: socketPath,
            token: "first-token",
            onPrompt: { _ in nil },
            onExec: { request in
                await ExecHostExecutor.handle(request)
            },
            onUnexpectedStop: { _ in })
        guard await first.start() else {
            first.stop()
            return (false, false, false, false)
        }
        let firstIdentity = try? ExecApprovalsSocketPathGuard.socketIdentity(at: socketPath)

        let replacement = ExecApprovalsSocketServer(
            socketPath: socketPath,
            token: "replacement-token",
            onPrompt: { _ in nil },
            onExec: { request in
                await ExecHostExecutor.handle(request)
            },
            onUnexpectedStop: { _ in })
        let replacementBlockedWhileOwned = await !replacement.start()
        await first.stop().value
        let replacementStartedAfterRelease = await replacement.start()
        let replacementIdentity = try? ExecApprovalsSocketPathGuard.socketIdentity(at: socketPath)
        let currentIdentity = try? ExecApprovalsSocketPathGuard.socketIdentity(at: socketPath)
        let result = (
            replacementBlockedWhileOwned: replacementBlockedWhileOwned,
            replacementStartedAfterRelease: replacementStartedAfterRelease,
            replacementHasDistinctIdentity: firstIdentity != nil &&
                replacementIdentity != nil &&
                firstIdentity != replacementIdentity,
            replacementPreserved: replacement.isListening && currentIdentity == replacementIdentity)
        replacement.stop()
        return result
    }

    static func _testExecHostTimestampFailureReason(_ timestamp: Int) async -> String? {
        let server = ExecApprovalsSocketServer(
            socketPath: "",
            token: "test-token",
            onPrompt: { _ in nil },
            onExec: { _ in
                ExecHostResponse(
                    type: "exec-res",
                    id: "unexpected-execution",
                    ok: true,
                    payload: nil,
                    error: nil)
            },
            onUnexpectedStop: { _ in })
        return await server.testExecHostTimestampFailureReason(timestamp)
    }
    #endif
}

struct ExecApprovalsPromptRetryBackoff {
    private var currentDelay: Duration
    private let maximumDelay: Duration

    init(initialDelay: Duration, maximumDelay: Duration) {
        self.currentDelay = initialDelay
        self.maximumDelay = max(initialDelay, maximumDelay)
    }

    mutating func nextDelay() -> Duration {
        let delay = self.currentDelay
        // A second app can hold the lifecycle lease indefinitely. Back off the
        // SQLite credential read and bind attempt instead of polling every second.
        self.currentDelay = min(self.currentDelay * 2, self.maximumDelay)
        return delay
    }
}
