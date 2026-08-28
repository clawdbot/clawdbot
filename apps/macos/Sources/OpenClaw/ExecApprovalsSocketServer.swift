import CryptoKit
import Darwin
import Foundation
import OSLog

private final class ExecApprovalsSocketLifecycleLease: @unchecked Sendable {
    private static let processLock = NSLock()
    private nonisolated(unsafe) static var reservedPaths = Set<String>()

    private let descriptor: Int32
    private let path: String
    private let stateLock = NSLock()
    private var released = false

    private init(descriptor: Int32, path: String) {
        self.descriptor = descriptor
        self.path = path
    }

    static func acquire(for socketPath: String) throws -> ExecApprovalsSocketLifecycleLease {
        let socketURL = URL(fileURLWithPath: socketPath).standardizedFileURL
        let canonicalSocketPath = socketURL.deletingLastPathComponent()
            .resolvingSymlinksInPath()
            .appendingPathComponent(socketURL.lastPathComponent)
            .path
        let lockPath = "\(canonicalSocketPath).lifecycle.lock"
        let reserved = self.processLock.withLock { () -> Bool in
            guard !self.reservedPaths.contains(lockPath) else { return false }
            self.reservedPaths.insert(lockPath)
            return true
        }
        guard reserved else {
            throw ExecApprovalsSocketPathGuardError.lifecycleLockBusy(path: lockPath)
        }

        let descriptor = open(
            lockPath,
            O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
            S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            self.releaseProcessReservation(lockPath)
            throw ExecApprovalsSocketPathGuardError.lifecycleLockOpenFailed(
                path: lockPath,
                code: errno)
        }

        do {
            var descriptorStatus = stat()
            var pathStatus = stat()
            guard fstat(descriptor, &descriptorStatus) == 0,
                  lstat(lockPath, &pathStatus) == 0,
                  descriptorStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                  descriptorStatus.st_uid == geteuid(),
                  descriptorStatus.st_nlink == 1,
                  descriptorStatus.st_mode & mode_t(0o022) == 0,
                  descriptorStatus.st_dev == pathStatus.st_dev,
                  descriptorStatus.st_ino == pathStatus.st_ino
            else {
                throw ExecApprovalsSocketPathGuardError.lifecycleLockInvalid(path: lockPath)
            }
            guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
                throw ExecApprovalsSocketPathGuardError.lifecycleLockBusy(path: lockPath)
            }
            return ExecApprovalsSocketLifecycleLease(
                descriptor: descriptor,
                path: lockPath)
        } catch {
            close(descriptor)
            self.releaseProcessReservation(lockPath)
            throw error
        }
    }

    func release() {
        let shouldRelease = self.stateLock.withLock { () -> Bool in
            guard !self.released else { return false }
            self.released = true
            return true
        }
        guard shouldRelease else { return }
        _ = flock(self.descriptor, LOCK_UN)
        close(self.descriptor)
        Self.releaseProcessReservation(self.path)
    }

    deinit {
        self.release()
    }

    private static func releaseProcessReservation(_ path: String) {
        _ = self.processLock.withLock {
            self.reservedPaths.remove(path)
        }
    }
}

final class ExecApprovalsSocketServer: @unchecked Sendable {
    private struct OpenedSocket {
        let fd: Int32
        let identity: ExecApprovalsSocketPathIdentity
        let lifecycleLease: ExecApprovalsSocketLifecycleLease
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals.socket")
    private let socketPath: String
    private let token: String
    private let onPrompt: @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision?
    private let onExec: @Sendable (ExecHostRequest) async -> ExecHostResponse
    private let onUnexpectedStop: @Sendable (ExecApprovalsSocketServer) -> Void
    private let stateLock = NSLock()
    private var socketFD: Int32 = -1
    private var socketIdentity: ExecApprovalsSocketPathIdentity?
    private var socketLifecycleLease: ExecApprovalsSocketLifecycleLease?
    private var acceptTask: Task<Void, Never>?
    private var clients: [UUID: ExecApprovalsSocketClientSession] = [:]
    private var shutdownTask: Task<Void, Never>?
    private var isRunning = false

    init(
        socketPath: String,
        token: String,
        onPrompt: @escaping @Sendable (ExecApprovalPromptRequest) async -> ExecApprovalDecision?,
        onExec: @escaping @Sendable (ExecHostRequest) async -> ExecHostResponse,
        onUnexpectedStop: @escaping @Sendable (ExecApprovalsSocketServer) -> Void)
    {
        self.socketPath = socketPath
        self.token = token
        self.onPrompt = onPrompt
        self.onExec = onExec
        self.onUnexpectedStop = onUnexpectedStop
    }

    var isListening: Bool {
        self.stateLock.withLock { self.isRunning && self.socketFD >= 0 }
    }

    func start() async -> Bool {
        let shouldStart = self.stateLock.withLock {
            guard !Task.isCancelled, !self.isRunning, self.shutdownTask == nil else { return false }
            self.isRunning = true
            return true
        }
        guard shouldStart else {
            return self.stateLock.withLock { self.socketFD >= 0 }
        }

        return await withCheckedContinuation { continuation in
            let task = Task.detached { [weak self] in
                guard let self else {
                    continuation.resume(returning: false)
                    return
                }
                await self.runAcceptLoop { ready in
                    continuation.resume(returning: ready)
                }
            }
            self.stateLock.withLock {
                self.acceptTask = task
                if !self.isRunning {
                    task.cancel()
                }
            }
        }
    }

    @discardableResult
    func stop() -> Task<Void, Never> {
        self.stateLock.withLock {
            if let shutdownTask { return shutdownTask }
            self.isRunning = false
            let acceptTask = self.acceptTask
            self.acceptTask = nil
            let clients = Array(self.clients.values)
            self.clients.removeAll()
            let lifecycleLease = self.socketLifecycleLease
            self.socketLifecycleLease = nil
            acceptTask?.cancel()
            for client in clients {
                client.cancel()
            }
            self.closeOwnedSocket(fd: self.socketFD, identity: self.socketIdentity, lifecycleLease: nil)
            self.socketFD = -1
            self.socketIdentity = nil
            // Hold the path lease until all admitted work has unwound. A new
            // listener must not overlap commands still owned by this generation.
            let shutdownTask = Task.detached {
                await acceptTask?.value
                for client in clients {
                    await client.wait()
                }
                lifecycleLease?.release()
            }
            self.shutdownTask = shutdownTask
            return shutdownTask
        }
    }

    private func runAcceptLoop(onReady: @escaping @Sendable (Bool) -> Void) async {
        let shouldOpen = self.stateLock.withLock { self.isRunning && !Task.isCancelled }
        guard shouldOpen else {
            self.stateLock.withLock {
                self.isRunning = false
                self.acceptTask = nil
            }
            onReady(false)
            return
        }

        guard let openedSocket = self.openSocket() else {
            self.stateLock.withLock {
                self.isRunning = false
                self.acceptTask = nil
            }
            onReady(false)
            return
        }
        let fd = openedSocket.fd

        let shouldAccept = self.stateLock.withLock {
            guard self.isRunning, !Task.isCancelled else { return false }
            self.socketFD = fd
            self.socketIdentity = openedSocket.identity
            self.socketLifecycleLease = openedSocket.lifecycleLease
            return true
        }
        guard shouldAccept else {
            self.closeOwnedSocket(
                fd: fd,
                identity: openedSocket.identity,
                lifecycleLease: openedSocket.lifecycleLease)
            onReady(false)
            return
        }

        onReady(true)
        while self.stateLock.withLock({ self.isRunning }), !Task.isCancelled {
            var addr = sockaddr_un()
            var len = socklen_t(MemoryLayout.size(ofValue: addr))
            let client = withUnsafeMutablePointer(to: &addr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                    accept(fd, rebound, &len)
                }
            }
            if client < 0 {
                if errno == EINTR {
                    continue
                }
                break
            }
            self.stateLock.withLock {
                guard self.isRunning, self.socketFD == fd else {
                    close(client)
                    return
                }
                do {
                    let session = try ExecApprovalsSocketClientSession(fd: client)
                    let id = UUID()
                    self.clients[id] = session
                    session.start(operation: { [weak self] handle in
                        await self?.handleClient(handle: handle)
                    }, onFinished: { [weak self] in
                        guard let self else { return }
                        _ = self.stateLock.withLock { self.clients.removeValue(forKey: id) }
                    })
                } catch {
                    close(client)
                    self.logger
                        .error(
                            "exec approvals client monitoring failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        }

        let stoppedUnexpectedly = self.stateLock.withLock { self.isRunning && !Task.isCancelled }
        self.stop()
        if stoppedUnexpectedly {
            self.onUnexpectedStop(self)
        }
    }

    private func closeOwnedSocket(
        fd: Int32,
        identity: ExecApprovalsSocketPathIdentity?,
        lifecycleLease: ExecApprovalsSocketLifecycleLease?)
    {
        if fd >= 0 {
            _ = shutdown(fd, SHUT_RDWR)
            close(fd)
        }
        if !self.socketPath.isEmpty, let identity {
            do {
                // Keep the cross-process lease through the identity check and
                // unlink so no replacement can bind between those operations.
                try ExecApprovalsSocketPathGuard.removeSocket(
                    at: self.socketPath,
                    ifIdentityMatches: identity)
            } catch {
                self.logger
                    .warning("exec approvals socket cleanup failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        lifecycleLease?.release()
    }

    #if DEBUG
    func failForTesting() {
        guard self.isListening else { return }
        self.stop()
        self.onUnexpectedStop(self)
    }
    #endif

    private func openSocket() -> OpenedSocket? {
        let lifecycleLease: ExecApprovalsSocketLifecycleLease
        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: self.socketPath)
            lifecycleLease = try ExecApprovalsSocketLifecycleLease.acquire(for: self.socketPath)
            try ExecApprovalsSocketPathGuard.removeExistingSocket(at: self.socketPath)
        } catch {
            self.logger
                .error("exec approvals socket path hardening failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            self.logger.error("exec approvals socket create failed")
            lifecycleLease.release()
            return nil
        }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        if self.socketPath.utf8.count >= maxLen {
            self.logger.error("exec approvals socket path too long")
            close(fd)
            lifecycleLease.release()
            return nil
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
            lifecycleLease.release()
            return nil
        }
        let identity: ExecApprovalsSocketPathIdentity
        do {
            guard let boundIdentity = try ExecApprovalsSocketPathGuard.socketIdentity(at: self.socketPath) else {
                self.logger.error("exec approvals socket identity unavailable after bind")
                close(fd)
                try? ExecApprovalsSocketPathGuard.removeExistingSocket(at: self.socketPath)
                lifecycleLease.release()
                return nil
            }
            identity = boundIdentity
        } catch {
            self.logger.error(
                "exec approvals socket identity failed: \(error.localizedDescription, privacy: .public)")
            close(fd)
            try? ExecApprovalsSocketPathGuard.removeExistingSocket(at: self.socketPath)
            lifecycleLease.release()
            return nil
        }
        if chmod(self.socketPath, 0o600) != 0 {
            self.logger.error("exec approvals socket chmod failed")
            self.closeOwnedSocket(
                fd: fd,
                identity: identity,
                lifecycleLease: lifecycleLease)
            return nil
        }
        if listen(fd, 16) != 0 {
            self.logger.error("exec approvals socket listen failed")
            self.closeOwnedSocket(
                fd: fd,
                identity: identity,
                lifecycleLease: lifecycleLease)
            return nil
        }
        self.logger.info("exec approvals socket listening at \(self.socketPath, privacy: .public)")
        return OpenedSocket(
            fd: fd,
            identity: identity,
            lifecycleLease: lifecycleLease)
    }

    private func handleClient(handle: FileHandle) async {
        let fd = handle.fileDescriptor
        do {
            try Task.checkCancellation()
            guard self.isAllowedPeer(fd: fd) else {
                try self.sendApprovalResponse(handle: handle, id: UUID().uuidString, decision: .deny)
                return
            }
            try configureSocketTimeouts(fd, timeoutMs: execApprovalsSocketTimeoutMs)
            guard let line = try readLineFromSocket(fd, maxBytes: 256_000),
                  let data = line.data(using: .utf8)
            else {
                return
            }
            try Task.checkCancellation()
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
                guard let decision = await self.onPrompt(request.request) else { return }
                try Task.checkCancellation()
                try self.sendApprovalResponse(handle: handle, id: request.id, decision: decision)
                return
            }

            if type == "exec" {
                let request = try JSONDecoder().decode(ExecHostSocketRequest.self, from: data)
                let response = await self.handleExecRequest(request)
                try Task.checkCancellation()
                try self.sendExecResponse(handle: handle, response: response)
                return
            }
        } catch {
            if !Task.isCancelled {
                self.logger
                    .error("exec approvals socket handling failed: \(error.localizedDescription, privacy: .public)")
            }
        }
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
        if !execHostTimestampIsFresh(nowMs: nowMs, requestMs: request.ts) {
            return ExecHostResponse(
                type: "exec-res",
                id: request.id,
                ok: false,
                payload: nil,
                error: ExecHostError(code: "INVALID_REQUEST", message: "expired request", reason: "ttl"))
        }
        let expected = self.hmacHex(nonce: request.nonce, ts: request.ts, requestJson: request.requestJson)
        if !timingSafeHexStringEquals(expected, request.hmac) {
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

    #if DEBUG
    func testExecHostTimestampFailureReason(_ timestamp: Int) async -> String? {
        let response = await self.handleExecRequest(ExecHostSocketRequest(
            type: "exec",
            id: "timestamp-test",
            nonce: "nonce",
            ts: timestamp,
            hmac: "unauthenticated",
            requestJson: #"{"command":["/usr/bin/true"]}"#))
        return response.error?.reason
    }
    #endif

    private func hmacHex(nonce: String, ts: Int, requestJson: String) -> String {
        let key = SymmetricKey(data: Data(self.token.utf8))
        let message = "\(nonce):\(ts):\(requestJson)"
        let mac = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key)
        return mac.map { String(format: "%02x", $0) }.joined()
    }
}
