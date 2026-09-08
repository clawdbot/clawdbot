import Darwin
import Foundation
import OpenClawIPC

struct MacControlClient {
    let options: MacControlOptions

    func send(_ request: MacControlRequest) throws -> Data {
        let directory = self.options.profile
            .stateDirectoryURL(homeDirectory: FileManager.default.homeDirectoryForCurrentUser)
        let socketURL = directory.appendingPathComponent(MacControlCredentials.socketFilename)
        let deadline = ContinuousClock.now + .milliseconds(self.options.timeoutMs)
        let fd = try self.reachableSocket(at: socketURL, deadline: deadline)
        defer { close(fd) }
        let token = try MacControlCredentials
            .read(at: directory.appendingPathComponent(MacControlCredentials.tokenFilename))
        var request = request
        let remaining = ContinuousClock.now.duration(to: deadline).components
        request.deadline = Date().addingTimeInterval(
            Double(remaining.seconds) + Double(remaining.attoseconds) / 1e18)
        var data = try JSONEncoder().encode(MacControlEnvelope(request: request, token: token))
        data.append(0x0A)
        guard data.count <= MacControlCredentials.maximumFrameBytes else {
            throw MacControlOptions.usage("Request is too large.")
        }
        var offset = 0
        while offset < data.count {
            try Self.wait(fd, events: Int16(POLLOUT), deadline: deadline)
            let sent = data.withUnsafeBytes { bytes in
                Darwin.send(fd, bytes.baseAddress!.advanced(by: offset), data.count - offset, 0)
            }
            if sent < 0, errno == EINTR || errno == EAGAIN { continue }
            guard sent > 0 else { throw Self.unreachable() }
            offset += sent
        }
        var response = Data()
        while response.count < MacControlCredentials.maximumFrameBytes {
            try Self.wait(fd, events: Int16(POLLIN), deadline: deadline)
            var bytes = [UInt8](
                repeating: 0,
                count: min(4096, MacControlCredentials.maximumFrameBytes - response.count))
            let count = bytes.withUnsafeMutableBytes { recv(fd, $0.baseAddress, $0.count, 0) }
            if count < 0, errno == EINTR || errno == EAGAIN { continue }
            guard count > 0 else { throw Self.unreachable() }
            response.append(contentsOf: bytes.prefix(count))
            if let newline = response.firstIndex(of: 0x0A) {
                return response.prefix(upTo: newline)
            }
        }
        throw MacControlError(code: "invalid_response", message: "The app returned an oversized response.")
    }

    private func reachableSocket(at url: URL, deadline: ContinuousClock.Instant) throws -> Int32 {
        if let fd = try? Self.connect(at: url, deadline: deadline) { return fd }
        guard self.options.launch else { throw Self.unreachable() }
        try self.launchApp(deadline: deadline)
        while ContinuousClock.now < deadline {
            if let fd = try? Self.connect(at: url, deadline: deadline) { return fd }
            usleep(100_000)
        }
        throw Self.unreachable()
    }

    private static func connect(at url: URL, deadline: ContinuousClock.Instant) throws -> Int32 {
        var info = stat()
        guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFSOCK,
              info.st_uid == geteuid(), info.st_mode & 0o777 == 0o600
        else { throw Self.unreachable() }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let path = Array(url.path.utf8CString)
        guard path.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw MacControlError(code: "unreachable", message: "The app control socket path is too long.")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            path.withUnsafeBytes { source in destination.copyBytes(from: source) }
        }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Self.unreachable() }
        do {
            guard fcntl(fd, F_SETFL, O_NONBLOCK) == 0, fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else {
                throw Self.unreachable()
            }
            var noSignal: Int32 = 1
            guard setsockopt(
                fd,
                SOL_SOCKET,
                SO_NOSIGPIPE,
                &noSignal,
                socklen_t(MemoryLayout.size(ofValue: noSignal))) ==
                0
            else {
                throw Self.unreachable()
            }
            let result = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            if result != 0 {
                guard errno == EINPROGRESS else { throw Self.unreachable() }
                try Self.wait(fd, events: Int16(POLLOUT), deadline: deadline)
                var error: Int32 = 0
                var size = socklen_t(MemoryLayout.size(ofValue: error))
                guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0, error == 0 else {
                    throw Self.unreachable()
                }
            }
            var peerUID: uid_t = 0
            var peerGID: gid_t = 0
            guard getpeereid(fd, &peerUID, &peerGID) == 0, peerUID == geteuid() else {
                throw Self.unreachable()
            }
            return fd
        } catch {
            close(fd)
            throw error
        }
    }

    private static func wait(_ fd: Int32, events: Int16, deadline: ContinuousClock.Instant) throws {
        while true {
            let remaining = ContinuousClock.now.duration(to: deadline)
            guard remaining > .zero else { throw Self.operationTimedOut() }
            let components = remaining.components
            let milliseconds = min(
                Int64(Int32.max),
                components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000)
            var descriptor = pollfd(fd: fd, events: events, revents: 0)
            let result = poll(&descriptor, 1, Int32(max(1, milliseconds)))
            if result < 0, errno == EINTR { continue }
            if result == 0 { throw Self.operationTimedOut() }
            guard result > 0, descriptor.revents & events != 0 else { throw Self.unreachable() }
            return
        }
    }

    static func applicationBundle(executableURL: URL) -> URL {
        let executable = executableURL.resolvingSymlinksInPath()
        let bundle = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        if bundle.pathExtension == "app", executable.deletingLastPathComponent().lastPathComponent == "MacOS" {
            return bundle
        }
        return URL(fileURLWithPath: "/Applications/OpenClaw.app")
    }

    private func launchApp(deadline: ContinuousClock.Instant) throws {
        let executable = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
        let bundle = Self.applicationBundle(executableURL: executable)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        // A different profile may already own the same bundle id. The app's per-profile lock arbitrates duplicates.
        process.arguments = [
            "-gj", "-n", "-a", bundle.path,
            "--env", "OPENCLAW_PROFILE=\(self.options.profile.name ?? "default")", "--args", "--background-only",
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { throw Self.unreachable() }
        while process.isRunning, ContinuousClock.now < deadline {
            usleep(10000)
        }
        if process.isRunning { process.terminate()
            throw Self.unreachable()
        }
        guard process.terminationStatus == 0 else { throw Self.unreachable() }
    }

    private static func operationTimedOut() -> MacControlError {
        MacControlError(
            code: "operation_timeout",
            message: "Timed out waiting for the app. The operation may still be running; check status before retrying.")
    }

    private static func unreachable() -> MacControlError {
        MacControlError(
            code: "unreachable",
            message: """
            OpenClaw app is not reachable for this profile. \
            Start the app or retry with --launch and a longer --timeout.
            """)
    }
}
