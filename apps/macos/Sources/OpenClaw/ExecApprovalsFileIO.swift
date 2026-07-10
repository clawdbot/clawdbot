import Darwin
import Foundation

/// Coordinates native approval reads and writes with the TypeScript sidecar-lock protocol.
/// Target files are opened without following links; writes replace the directory entry atomically.
enum ExecApprovalsFileIO {
    struct CurrentFile {
        let data: Data
        let linkCount: UInt64
    }

    private static let processLock = NSRecursiveLock()
    private static let lockAttempts = 11
    private static let lockRetryDelayMicroseconds: useconds_t = 20000

    private struct LockHandle {
        let descriptor: Int32
        let url: URL
        let device: UInt64
        let inode: UInt64
        let raw: Data
    }

    static func withLock<T>(
        fileURL: URL,
        trustedRoot: URL,
        _ body: () throws -> T) throws -> T
    {
        self.processLock.lock()
        defer { self.processLock.unlock() }
        try self.assertSafeParentChain(of: fileURL, trustedRoot: trustedRoot)
        let handle = try self.acquireLock(fileURL: fileURL, trustedRoot: trustedRoot)
        defer { self.releaseLock(handle) }
        return try body()
    }

    static func read(at url: URL, trustedRoot: URL) throws -> CurrentFile? {
        try self.assertSafeParentChain(of: url, trustedRoot: trustedRoot)
        guard let pathInfo = try self.currentMetadata(at: url) else { return nil }
        let descriptor = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { close(descriptor) }

        var descriptorInfo = stat()
        guard fstat(descriptor, &descriptorInfo) == 0,
              descriptorInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              descriptorInfo.st_dev == pathInfo.st_dev,
              descriptorInfo.st_ino == pathInfo.st_ino
        else {
            throw self.error(15, "exec approvals file changed before read")
        }
        let data = try self.readAll(from: descriptor)
        guard let finalInfo = try self.currentMetadata(at: url),
              finalInfo.st_dev == descriptorInfo.st_dev,
              finalInfo.st_ino == descriptorInfo.st_ino
        else {
            throw self.error(16, "exec approvals file changed during read")
        }
        return CurrentFile(data: data, linkCount: UInt64(descriptorInfo.st_nlink))
    }

    static func pathExistsNoFollow(_ url: URL) -> Bool {
        var info = stat()
        if lstat(url.path, &info) == 0 {
            return true
        }
        return errno != ENOENT
    }

    static func assertSafeDirectory(at url: URL) throws {
        var info = stat()
        guard lstat(url.path, &info) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
            throw self.error(20, "unsafe exec approvals state directory")
        }
    }

    static func write(_ data: Data, to url: URL, trustedRoot: URL) throws {
        try self.assertSafeParentChain(of: url, trustedRoot: trustedRoot)
        _ = try self.currentMetadata(at: url)
        let temporaryURL = url.deletingLastPathComponent()
            .appendingPathComponent(".exec-approvals.\(UUID().uuidString)")
        let descriptor = open(
            temporaryURL.path,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        var closed = false
        var renamed = false
        defer {
            if !closed {
                close(descriptor)
            }
            if !renamed {
                _ = unlink(temporaryURL.path)
            }
        }
        try self.writeAll(data, to: descriptor)
        guard close(descriptor) == 0 else {
            closed = true
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        closed = true
        guard rename(temporaryURL.path, url.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        renamed = true
        guard let saved = try self.currentMetadata(at: url), saved.st_nlink == 1 else {
            throw self.error(17, "exec approvals atomic write retained shared links")
        }
    }

    private static func acquireLock(fileURL: URL, trustedRoot: URL) throws -> LockHandle {
        try FileManager().createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try self.assertSafeParentChain(of: fileURL, trustedRoot: trustedRoot)
        let realDirectory = fileURL.deletingLastPathComponent().resolvingSymlinksInPath()
        let lockURL = realDirectory.appendingPathComponent("\(fileURL.lastPathComponent).lock")
        var lockPayload: [String: Any] = [
            "pid": Int(getpid()),
            "createdAt": ISO8601DateFormatter().string(from: Date()),
            "nonce": UUID().uuidString,
        ]
        if let starttime = self.processStartTime(getpid()) {
            lockPayload["starttime"] = starttime
        }
        let payload = try JSONSerialization.data(
            withJSONObject: lockPayload,
            options: [.prettyPrinted, .sortedKeys])
        let raw = payload + Data([0x0A])

        for attempt in 0..<self.lockAttempts {
            let descriptor = open(
                lockURL.path,
                O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
                S_IRUSR | S_IWUSR)
            if descriptor >= 0 {
                var info = stat()
                guard fstat(descriptor, &info) == 0 else {
                    let error = POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                    close(descriptor)
                    throw error
                }
                let handle = LockHandle(
                    descriptor: descriptor,
                    url: lockURL,
                    device: UInt64(info.st_dev),
                    inode: UInt64(info.st_ino),
                    raw: raw)
                do {
                    try self.writeAll(raw, to: descriptor)
                    return handle
                } catch {
                    close(descriptor)
                    self.removeLockIfOwned(handle, requirePayloadMatch: false)
                    throw error
                }
            }
            guard errno == EEXIST else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            guard attempt + 1 < self.lockAttempts else { throw POSIXError(.ETIMEDOUT) }
            // Match the synchronous TypeScript lock budget: ten 20 ms retries.
            usleep(self.lockRetryDelayMicroseconds)
        }
        throw POSIXError(.ETIMEDOUT)
    }

    static func assertSafeParentChain(of target: URL, trustedRoot: URL) throws {
        let root = trustedRoot.standardizedFileURL
        let parent = target.deletingLastPathComponent().standardizedFileURL
        let rootComponents = root.pathComponents
        let parentComponents = parent.pathComponents
        guard parentComponents.count >= rootComponents.count,
              Array(parentComponents.prefix(rootComponents.count)) == rootComponents
        else {
            // Match the TypeScript allowOutsideRoot contract: an explicitly
            // configured path outside the effective home is operator-trusted.
            return
        }

        var cursor = root
        for component in parentComponents.dropFirst(rootComponents.count) {
            cursor.appendPathComponent(component, isDirectory: true)
            var info = stat()
            guard lstat(cursor.path, &info) == 0 else {
                if errno == ENOENT {
                    return
                }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
                throw self.error(19, "unsafe exec approvals parent path")
            }
        }
    }

    private static func releaseLock(_ handle: LockHandle) {
        close(handle.descriptor)
        self.removeLockIfOwned(handle, requirePayloadMatch: true)
    }

    private static func removeLockIfOwned(_ handle: LockHandle, requirePayloadMatch: Bool) {
        var current = stat()
        guard lstat(handle.url.path, &current) == 0,
              UInt64(current.st_dev) == handle.device,
              UInt64(current.st_ino) == handle.inode
        else { return }
        if requirePayloadMatch {
            guard let raw = try? Data(contentsOf: handle.url), raw == handle.raw else { return }
        }
        _ = unlink(handle.url.path)
    }

    private static func currentMetadata(at url: URL) throws -> stat? {
        var info = stat()
        guard lstat(url.path, &info) == 0 else {
            if errno == ENOENT {
                return nil
            }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else {
            throw self.error(14, "unsafe exec approvals file type")
        }
        return info
    }

    private static func readAll(from descriptor: Int32) throws -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { bytes in
                Darwin.read(descriptor, bytes.baseAddress, bytes.count)
            }
            if count == 0 {
                return data
            }
            if count < 0 {
                if errno == EINTR {
                    continue
                }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            data.append(contentsOf: buffer.prefix(count))
        }
    }

    private static func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count < 0 {
                    if errno == EINTR {
                        continue
                    }
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
                offset += count
            }
        }
    }

    private static func processStartTime(_ pid: pid_t) -> UInt64? {
        guard pid > 0 else { return nil }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0,
              size > 0,
              info.kp_proc.p_pid == pid,
              info.kp_proc.p_starttime.tv_sec >= 0
        else { return nil }
        return UInt64(info.kp_proc.p_starttime.tv_sec)
    }

    private static func error(_ code: Int, _ message: String) -> NSError {
        NSError(domain: "ExecApprovals", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
