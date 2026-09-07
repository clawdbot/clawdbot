import Darwin
import Foundation
import OSLog

private final class LocalSocketLifecycleLease: @unchecked Sendable {
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

    static func acquire(for socketPath: String) throws -> LocalSocketLifecycleLease {
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
            return LocalSocketLifecycleLease(
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

/// Owns the listener generation and drains accepted requests before releasing its path.
final class LocalSocketServer: @unchecked Sendable {
    private struct OpenedSocket {
        let fd: Int32
        let identity: ExecApprovalsSocketPathIdentity
        let lifecycleLease: LocalSocketLifecycleLease
    }

    private let logger: Logger
    private let socketPath: String
    private let stateLock = NSLock()
    private var openedSocket: OpenedSocket?
    private var acceptTask: Task<Void, Never>?
    private var clients: [UUID: ExecApprovalsSocketClientSession] = [:]
    private var shutdownTask: Task<Void, Never>?
    private var isRunning = false

    init(socketPath: String, logger: Logger) {
        self.socketPath = socketPath
        self.logger = logger
    }

    var isListening: Bool {
        self.stateLock.withLock { self.isRunning && self.openedSocket != nil }
    }

    func start(
        prepare: @escaping @Sendable () throws -> Void = {},
        handler: @escaping @Sendable (FileHandle) async -> Void,
        onUnexpectedStop: @escaping @Sendable () -> Void) async -> Bool
    {
        let shouldStart = self.stateLock.withLock {
            guard !Task.isCancelled, !self.isRunning, self.shutdownTask == nil else { return false }
            self.isRunning = true
            return true
        }
        guard shouldStart else {
            return self.stateLock.withLock { self.openedSocket != nil }
        }

        return await withCheckedContinuation { continuation in
            let task = Task.detached { [weak self] in
                guard let self else {
                    continuation.resume(returning: false)
                    return
                }
                await self.runAcceptLoop(
                    prepare: prepare,
                    handler: handler,
                    onUnexpectedStop: onUnexpectedStop,
                    onReady: { ready in
                        continuation.resume(returning: ready)
                    })
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
            let openedSocket = self.openedSocket
            self.openedSocket = nil
            acceptTask?.cancel()
            for client in clients {
                client.cancel()
            }
            if let openedSocket {
                self.closeOwnedSocket(openedSocket)
            }
            // Hold the path lease until all admitted work has unwound. A new
            // listener must not overlap commands still owned by this generation.
            let shutdownTask = Task.detached {
                await acceptTask?.value
                for client in clients {
                    await client.wait()
                }
                openedSocket?.lifecycleLease.release()
            }
            self.shutdownTask = shutdownTask
            return shutdownTask
        }
    }

    private func runAcceptLoop(
        prepare: @escaping @Sendable () throws -> Void,
        handler: @escaping @Sendable (FileHandle) async -> Void,
        onUnexpectedStop: @escaping @Sendable () -> Void,
        onReady: @escaping @Sendable (Bool) -> Void) async
    {
        let shouldOpen = self.stateLock.withLock { self.isRunning && !Task.isCancelled }
        guard shouldOpen, let openedSocket = self.openSocket(prepare: prepare) else {
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
            self.openedSocket = openedSocket
            return true
        }
        guard shouldAccept else {
            self.closeOwnedSocket(openedSocket)
            openedSocket.lifecycleLease.release()
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
                guard self.isRunning, self.openedSocket?.fd == fd else {
                    close(client)
                    return
                }
                do {
                    let session = try ExecApprovalsSocketClientSession(fd: client)
                    let id = UUID()
                    self.clients[id] = session
                    session.start(operation: handler, onFinished: { [weak self] in
                        guard let self else { return }
                        _ = self.stateLock.withLock { self.clients.removeValue(forKey: id) }
                    })
                } catch {
                    close(client)
                    self.logger
                        .error(
                            "local client monitoring failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        }

        let stoppedUnexpectedly = self.stateLock.withLock { self.isRunning && !Task.isCancelled }
        self.stop()
        if stoppedUnexpectedly {
            onUnexpectedStop()
        }
    }

    private func closeOwnedSocket(_ socket: OpenedSocket) {
        _ = shutdown(socket.fd, SHUT_RDWR)
        close(socket.fd)
        do {
            // The caller retains the lease through this identity check and unlink;
            // shutdown also keeps it until admitted work has drained.
            try ExecApprovalsSocketPathGuard.removeSocket(
                at: self.socketPath,
                ifIdentityMatches: socket.identity)
        } catch {
            self.logger
                .warning("local socket cleanup failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func openSocket(prepare: @Sendable () throws -> Void) -> OpenedSocket? {
        let lifecycleLease: LocalSocketLifecycleLease
        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: self.socketPath)
            lifecycleLease = try LocalSocketLifecycleLease.acquire(for: self.socketPath)
            do {
                try ExecApprovalsSocketPathGuard.removeExistingSocket(at: self.socketPath)
                // The credential must be complete before clients can observe a listening socket.
                try prepare()
            } catch {
                lifecycleLease.release()
                throw error
            }
        } catch {
            self.logger
                .error("local socket path hardening failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            self.logger.error("local socket create failed")
            lifecycleLease.release()
            return nil
        }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        if self.socketPath.utf8.count >= maxLen {
            self.logger.error("local socket path too long")
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
            self.logger.error("local socket bind failed")
            close(fd)
            lifecycleLease.release()
            return nil
        }
        let identity: ExecApprovalsSocketPathIdentity
        do {
            guard let boundIdentity = try ExecApprovalsSocketPathGuard.socketIdentity(at: self.socketPath) else {
                self.logger.error("local socket identity unavailable after bind")
                close(fd)
                try? ExecApprovalsSocketPathGuard.removeExistingSocket(at: self.socketPath)
                lifecycleLease.release()
                return nil
            }
            identity = boundIdentity
        } catch {
            self.logger.error(
                "local socket identity failed: \(error.localizedDescription, privacy: .public)")
            close(fd)
            try? ExecApprovalsSocketPathGuard.removeExistingSocket(at: self.socketPath)
            lifecycleLease.release()
            return nil
        }
        let openedSocket = OpenedSocket(fd: fd, identity: identity, lifecycleLease: lifecycleLease)
        if chmod(self.socketPath, 0o600) != 0 {
            self.logger.error("local socket chmod failed")
            self.closeOwnedSocket(openedSocket)
            lifecycleLease.release()
            return nil
        }
        if listen(fd, 16) != 0 {
            self.logger.error("local socket listen failed")
            self.closeOwnedSocket(openedSocket)
            lifecycleLease.release()
            return nil
        }
        self.logger.info("local socket listening at \(self.socketPath, privacy: .public)")
        return openedSocket
    }
}
