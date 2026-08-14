import Darwin
import Foundation
import OSLog

private struct CuaDriverDaemonMetadata: Decodable, Equatable {
    let pid: Int32
    let embedded: Bool
    let hostBundleID: String?

    private enum CodingKeys: String, CodingKey {
        case pid
        case embedded
        case hostBundleID = "host_bundle_id"
    }
}

private struct CuaDriverDaemonMetadataResponse: Decodable {
    let ok: Bool
    let result: CuaDriverDaemonMetadata?
}

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
        hostBundleID: String?) async
    {
        let logger = Logger(subsystem: "ai.openclaw", category: "cua-driver-host")
        for directory in self.ownedSocketDirectories(in: applicationSupportURL) {
            var socketStatus = stat()
            guard lstat(directory.socketPath, &socketStatus) == 0 else {
                if errno == ENOENT {
                    self.cleanupSocketDirectory(directory)
                }
                continue
            }
            guard socketStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
                  socketStatus.st_uid == geteuid()
            else { continue }

            guard let metadata = self.daemonMetadata(at: directory.socketPath) else {
                // A socket with no listener is crash residue. If something accepts
                // connections but does not speak CUA, leave it untouched.
                if !self.socketAcceptsConnections(directory.socketPath) {
                    self.cleanupSocketDirectory(directory)
                }
                continue
            }
            guard let hostBundleID, !hostBundleID.isEmpty,
                  metadata.embedded,
                  metadata.hostBundleID == hostBundleID,
                  metadata.pid > 1,
                  metadata.pid != getpid(),
                  self.isCuaDriverProcess(metadata.pid),
                  let parentPID = self.parentProcessIdentifier(metadata.pid),
                  parentPID <= 1 || self.parentProcessIdentifier(parentPID) == nil
            else { continue }

            // Reconfirm the process-bound metadata after classification so a
            // closed endpoint or recycled PID cannot redirect the reap.
            guard self.daemonMetadata(at: directory.socketPath) == metadata else { continue }
            logger.error(
                "reaping orphaned embedded CUA daemon \(metadata.pid, privacy: .public) at \(directory.socketPath, privacy: .public)")
            if await self.terminateProcess(metadata.pid) {
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

    private static func daemonMetadata(at socketPath: String) -> CuaDriverDaemonMetadata? {
        guard let descriptor = self.connectUnixSocket(socketPath) else { return nil }
        defer { close(descriptor) }

        var enabled: Int32 = 1
        _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout.size(ofValue: enabled)))
        var timeout = timeval(tv_sec: 0, tv_usec: 250_000)
        _ = setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
        _ = setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))

        let request = Data("{\"method\":\"metadata\"}\n".utf8)
        let sent = request.withUnsafeBytes { bytes in
            Darwin.send(descriptor, bytes.baseAddress, bytes.count, 0)
        }
        guard sent == request.count else { return nil }

        var response = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while response.count < 64 * 1024 {
            let count = chunk.withUnsafeMutableBytes { bytes in
                Darwin.recv(descriptor, bytes.baseAddress, bytes.count, 0)
            }
            guard count > 0 else { return nil }
            response.append(contentsOf: chunk.prefix(Int(count)))
            if let newline = response.firstIndex(of: 0x0A) {
                let line = Data(response[..<newline])
                guard let decoded = try? JSONDecoder().decode(
                    CuaDriverDaemonMetadataResponse.self,
                    from: line),
                    decoded.ok
                else { return nil }
                return decoded.result
            }
        }
        return nil
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

    private static func parentProcessIdentifier(_ processIdentifier: pid_t) -> pid_t? {
        guard processIdentifier > 0 else { return nil }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, processIdentifier]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0,
              size > 0,
              info.kp_proc.p_pid == processIdentifier
        else { return nil }
        return info.kp_eproc.e_ppid
    }

    private static func isCuaDriverProcess(_ processIdentifier: pid_t) -> Bool {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        let length = proc_pidpath(processIdentifier, &buffer, UInt32(buffer.count))
        guard length > 0 else { return false }
        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        guard let path = String(bytes: bytes, encoding: .utf8) else { return false }
        return URL(fileURLWithPath: path).lastPathComponent == "cua-driver"
    }

    private static func terminateProcess(_ processIdentifier: pid_t) async -> Bool {
        guard processIdentifier > 1 else { return false }
        if Darwin.kill(processIdentifier, SIGTERM) != 0, errno != ESRCH { return false }
        if await self.waitForProcessExit(processIdentifier) { return true }
        if Darwin.kill(processIdentifier, SIGKILL) != 0, errno != ESRCH { return false }
        return await self.waitForProcessExit(processIdentifier)
    }

    private static func waitForProcessExit(_ processIdentifier: pid_t) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(1)
        while self.parentProcessIdentifier(processIdentifier) != nil,
              ContinuousClock.now < deadline
        {
            try? await Task.sleep(for: .milliseconds(25))
        }
        return self.parentProcessIdentifier(processIdentifier) == nil
    }
}
