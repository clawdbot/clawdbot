import Darwin
import Foundation
import OSLog

extension CuaDriverHostCoordinator {
    static func makeLivenessPipe() throws -> Pipe {
        let pipe = Pipe()
        let descriptor = pipe.fileHandleForWriting.fileDescriptor
        let flags = fcntl(descriptor, F_GETFD)
        guard flags >= 0, fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) >= 0 else {
            let code = errno
            try? pipe.fileHandleForReading.close()
            try? pipe.fileHandleForWriting.close()
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
        }
        return pipe
    }

    static func reapStaleSocketDirectories(
        in applicationSupportURL: URL,
        expectedExecutableURL: URL?) async
    {
        let logger = Logger(subsystem: "ai.openclaw", category: "cua-driver-host")
        for directory in self.ownedSocketDirectories(in: applicationSupportURL) {
            guard let processIdentifier = self.readProcessIdentifier(in: directory) else {
                self.cleanupSocketDirectory(directory)
                continue
            }
            guard self.processIsAlive(processIdentifier) else {
                self.cleanupSocketDirectory(directory)
                continue
            }
            guard let expectedExecutableURL,
                  self.processExecutableMatches(
                      processIdentifier,
                      expectedExecutableURL: expectedExecutableURL)
            else { continue }

            if let hostPID = self.processEnvironmentValue(
                processIdentifier,
                key: "CUA_DRIVER_EMBEDDED_HOST_PID").flatMap(pid_t.init),
                !self.processIsAlive(hostPID)
            {
                logger.error(
                    """
                    reaping orphaned embedded CUA daemon \(processIdentifier, privacy: .public) \
                    whose host \(hostPID, privacy: .public) is gone
                    """)
            } else {
                logger.error(
                    "reaping owned embedded CUA daemon \(processIdentifier, privacy: .public) during lifecycle cleanup")
            }
            if await self.terminateProcess(
                processIdentifier,
                directory: directory,
                expectedExecutableURL: expectedExecutableURL)
            {
                self.cleanupSocketDirectory(directory)
            }
        }
    }

    private static func ownedSocketDirectories(
        in applicationSupportURL: URL) -> [CuaDriverSocketDirectory]
    {
        let openClawRoot = applicationSupportURL.appendingPathComponent("OpenClaw", isDirectory: true)
        let root = openClawRoot.appendingPathComponent("cua", isDirectory: true)
        for ancestor in [applicationSupportURL, openClawRoot, root] {
            var status = stat()
            guard lstat(ancestor.path, &status) == 0,
                  status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  status.st_uid == geteuid()
            else { return [] }
        }
        guard let children = try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles])
        else { return [] }

        return children.compactMap { child in
            let name = child.lastPathComponent
            guard name.utf8.count == 16,
                  name.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
            else { return nil }
            var status = stat()
            guard lstat(child.path, &status) == 0,
                  status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  status.st_uid == geteuid(),
                  status.st_mode & 0o777 == 0o700
            else { return nil }
            return CuaDriverSocketDirectory(
                url: child,
                socketPath: child.appendingPathComponent("cua.sock").path,
                device: UInt64(status.st_dev),
                inode: UInt64(status.st_ino))
        }
    }

    /// Records the spawned daemon pid inside its own owner-only socket directory.
    /// `serve` ignores `--pid-file` and writes only a machine-global path shared by
    /// every cua-driver, so the spawning app is the one authoritative source.
    @discardableResult
    static func writeProcessIdentifier(
        _ processIdentifier: pid_t,
        to directory: CuaDriverSocketDirectory) -> Bool
    {
        guard self.directoryIsUnchangedAndOwned(directory) else { return false }
        let descriptor = Darwin.open(
            directory.pidFilePath,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
            0o600)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        do {
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
            try handle.write(contentsOf: Data("\(processIdentifier)".utf8))
            return true
        } catch {
            return false
        }
    }

    private static func readProcessIdentifier(in directory: CuaDriverSocketDirectory) -> pid_t? {
        guard self.directoryIsUnchangedAndOwned(directory) else { return nil }
        let descriptor = Darwin.open(directory.pidFilePath, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }

        var status = stat()
        guard fstat(descriptor, &status) == 0,
              status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              status.st_uid == geteuid(),
              status.st_size > 0,
              status.st_size <= 32
        else { return nil }
        var buffer = [UInt8](repeating: 0, count: Int(status.st_size))
        let count = buffer.withUnsafeMutableBytes { bytes in
            Darwin.read(descriptor, bytes.baseAddress, bytes.count)
        }
        guard count == buffer.count,
              let contents = String(bytes: buffer, encoding: .utf8),
              let processIdentifier = pid_t(contents.trimmingCharacters(in: .whitespacesAndNewlines)),
              processIdentifier > 1,
              processIdentifier != getpid()
        else { return nil }
        return processIdentifier
    }

    private static func directoryIsUnchangedAndOwned(_ directory: CuaDriverSocketDirectory) -> Bool {
        var status = stat()
        return lstat(directory.url.path, &status) == 0 &&
            status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) &&
            status.st_uid == geteuid() &&
            status.st_mode & 0o777 == 0o700 &&
            UInt64(status.st_dev) == directory.device &&
            UInt64(status.st_ino) == directory.inode
    }

    nonisolated static func connectUnixSocket(_ socketPath: String) -> Int32? {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return nil }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let maximumLength = MemoryLayout.size(ofValue: address.sun_path)
        guard socketPath.utf8.count < maximumLength else {
            close(descriptor)
            return nil
        }
        socketPath.withCString { source in
            withUnsafeMutablePointer(to: &address.sun_path) { pointer in
                let bytes = UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: Int8.self)
                memset(bytes, 0, maximumLength)
                strncpy(bytes, source, maximumLength - 1)
            }
        }
        let addressSize = socklen_t(MemoryLayout.size(ofValue: address))
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                connect(descriptor, rebound, addressSize) == 0
            }
        }
        guard connected else {
            close(descriptor)
            return nil
        }
        return descriptor
    }

    private static func processIsAlive(_ processIdentifier: pid_t) -> Bool {
        guard processIdentifier > 1 else { return false }
        if Darwin.kill(processIdentifier, 0) == 0 { return true }
        return errno == EPERM
    }

    private static func processExecutableURL(_ processIdentifier: pid_t) -> URL? {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        let length = proc_pidpath(processIdentifier, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        guard let path = String(bytes: bytes, encoding: .utf8) else { return nil }
        return URL(fileURLWithPath: path)
    }

    private static func processExecutableMatches(
        _ processIdentifier: pid_t,
        expectedExecutableURL: URL) -> Bool
    {
        guard let actualExecutableURL = self.processExecutableURL(processIdentifier) else { return false }
        let actualPath = actualExecutableURL.resolvingSymlinksInPath().standardizedFileURL.path
        let expectedPath = expectedExecutableURL.resolvingSymlinksInPath().standardizedFileURL.path
        return actualPath == expectedPath
    }

    private static func processEnvironmentValue(
        _ processIdentifier: pid_t,
        key: String) -> String?
    {
        var argumentMaximum: Int32 = 0
        var argumentMaximumSize = MemoryLayout<Int32>.size
        var argumentMaximumMIB: [Int32] = [CTL_KERN, KERN_ARGMAX]
        guard sysctl(
            &argumentMaximumMIB,
            u_int(argumentMaximumMIB.count),
            &argumentMaximum,
            &argumentMaximumSize,
            nil,
            0) == 0,
            argumentMaximum > 0,
            argumentMaximum <= 4 * 1024 * 1024
        else { return nil }

        var buffer = [UInt8](repeating: 0, count: Int(argumentMaximum))
        var bufferSize = buffer.count
        var processMIB: [Int32] = [CTL_KERN, KERN_PROCARGS2, processIdentifier]
        let readSucceeded = buffer.withUnsafeMutableBytes { bytes in
            sysctl(
                &processMIB,
                u_int(processMIB.count),
                bytes.baseAddress,
                &bufferSize,
                nil,
                0) == 0
        }
        guard readSucceeded, bufferSize >= MemoryLayout<Int32>.size else { return nil }

        var argumentCount: Int32 = 0
        withUnsafeMutableBytes(of: &argumentCount) { destination in
            destination.copyBytes(from: buffer.prefix(destination.count))
        }
        guard argumentCount > 0 else { return nil }

        var offset = MemoryLayout<Int32>.size
        func skipString() -> Bool {
            guard offset < bufferSize else { return false }
            while offset < bufferSize, buffer[offset] != 0 {
                offset += 1
            }
            guard offset < bufferSize else { return false }
            offset += 1
            return true
        }

        guard skipString() else { return nil }
        while offset < bufferSize, buffer[offset] == 0 {
            offset += 1
        }
        for _ in 0..<argumentCount where offset < bufferSize {
            guard skipString() else { return nil }
        }

        let prefix = Data("\(key)=".utf8)
        while offset < bufferSize {
            while offset < bufferSize, buffer[offset] == 0 {
                offset += 1
            }
            guard offset < bufferSize else { break }
            let start = offset
            guard skipString() else { break }
            let entry = Data(buffer[start..<(offset - 1)])
            if entry.starts(with: prefix) {
                return String(bytes: entry.dropFirst(prefix.count), encoding: .utf8)
            }
        }
        return nil
    }

    private static func terminateProcess(
        _ processIdentifier: pid_t,
        directory: CuaDriverSocketDirectory,
        expectedExecutableURL: URL) async -> Bool
    {
        guard self.readProcessIdentifier(in: directory) == processIdentifier,
              self.processExecutableMatches(
                  processIdentifier,
                  expectedExecutableURL: expectedExecutableURL)
        else { return false }
        if Darwin.kill(processIdentifier, SIGTERM) != 0, errno != ESRCH { return false }
        if await self.waitForProcessExit(processIdentifier) { return true }
        // Recheck the executable immediately before escalation so PID reuse can
        // never redirect SIGKILL to an unrelated process.
        guard self.processExecutableMatches(
            processIdentifier,
            expectedExecutableURL: expectedExecutableURL)
        else { return false }
        if Darwin.kill(processIdentifier, SIGKILL) != 0, errno != ESRCH { return false }
        return await self.waitForProcessExit(processIdentifier)
    }

    private static func waitForProcessExit(_ processIdentifier: pid_t) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(1)
        while self.processIsAlive(processIdentifier), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(25))
        }
        return !self.processIsAlive(processIdentifier)
    }
}
