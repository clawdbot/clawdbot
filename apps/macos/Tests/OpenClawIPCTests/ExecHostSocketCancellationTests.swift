import CryptoKit
import Darwin
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecHostSocketCancellationTests {
    enum Cancellation: CaseIterable {
        case disconnect
        case serverStop
    }

    @Test
    func `normal request half-close still receives native execution result`() async throws {
        try await self.withServer { server, root in
            let client = try self.connect(root)
            defer { close(client) }
            try self.send(command: ["/usr/bin/printf", "half-close-ok"], root: root, client: client)
            #expect(shutdown(client, SHUT_WR) == 0)
            let response = try await Task.detached {
                try self.readResponse(client)
            }.value
            #expect(response.ok)
            #expect(response.payload?.stdout == "half-close-ok")
            #expect(response.payload?.success == true)
            server.stop()
        }
    }

    @Test(arguments: Cancellation.allCases, [false, true])
    func `closed caller or server stops native command and its descendant`(
        _ cancellation: Cancellation, withTimeout: Bool) async throws
    {
        try await self.withServer { server, root in
            var client = try self.connect(root)
            defer { if client >= 0 { close(client) } }
            let parentFile = root.appendingPathComponent("parent.pid")
            let childFile = root.appendingPathComponent("child.pid")
            let sentinel = root.appendingPathComponent("sentinel")
            // Publish the PID atomically: file creation alone can race the printf payload.
            let command = [
                "/bin/sh", "-c",
                """
                printf '%s' "$$" > '\(parentFile.path)'
                /bin/sh -c '
                  trap "" TERM
                  printf "%s" "$$" > "\(childFile.path).tmp"
                  /bin/mv "\(childFile.path).tmp" "\(childFile.path)"
                  /bin/sleep 2
                  /usr/bin/touch "\(sentinel.path)"
                ' &
                wait
                """,
            ]
            try self.send(command: command, root: root, client: client, timeoutMs: withTimeout ? 10000 : nil)
            #expect(shutdown(client, SHUT_WR) == 0)
            try #require(await self.waitUntil { FileManager.default.fileExists(atPath: childFile.path) })
            let parent = try self.readPID(parentFile)
            let child = try self.readPID(childFile)
            defer {
                if kill(parent, 0) == 0 { kill(-parent, SIGKILL) }
                if kill(child, 0) == 0 { kill(child, SIGKILL) }
            }
            switch cancellation {
            case .disconnect:
                close(client)
                client = -1
            case .serverStop:
                server.stop()
            }
            #expect(await self.waitUntil { self.isGone(parent) && self.isGone(child) })
            try await Task.sleep(for: .milliseconds(2200))
            #expect(!FileManager.default.fileExists(atPath: sentinel.path))
        }
    }

    @Test
    func `cancelled native executor never starts a command`() async throws {
        let root = try self.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try self.seed(root)
        let sentinel = root.appendingPathComponent("unexpected")
        let request = ExecHostRequest(command: ["/usr/bin/touch", sentinel.path], cwd: root.path)
        let response = await Task.detached {
            withUnsafeCurrentTask { $0?.cancel() }
            return await ExecApprovalsStore.withStateDirectory(root) {
                await ExecHostExecutor.handle(request)
            }
        }.value
        #expect(!response.ok)
        #expect(!FileManager.default.fileExists(atPath: sentinel.path))
    }

    private func withServer(
        _ body: (ExecApprovalsSocketServer, URL) async throws -> Void) async throws
    {
        let root = try self.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try self.seed(root)
        let server = ExecApprovalsSocketServer(
            socketPath: root.appendingPathComponent("exec.sock").path,
            token: "test-token",
            onPrompt: { _ in .deny },
            onExec: { request in
                await ExecApprovalsStore.withStateDirectory(root) {
                    await ExecHostExecutor.handle(request)
                }
            },
            onUnexpectedStop: { _ in })
        do {
            try #require(await server.start())
            try await body(server, root)
        } catch {
            await server.stop().value
            throw error
        }
        await server.stop().value
    }

    private func makeRoot() throws -> URL {
        let root = URL(fileURLWithPath: "/tmp/oehc-\(UUID().uuidString.prefix(12))", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return root.resolvingSymlinksInPath()
    }

    private func seed(_ root: URL) throws {
        try ExecApprovalsSQLiteStore.write(
            ExecApprovalsFile(version: 1, defaults: nil, agents: [:]),
            stateDirectoryURL: root)
    }

    private func connect(_ root: URL) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.EIO) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let socketPath = root.appendingPathComponent("exec.sock").path
        socketPath.withCString { source in
            withUnsafeMutablePointer(to: &address.sun_path) {
                $0.withMemoryRebound(to: CChar.self, capacity: 104) { destination in
                    _ = strcpy(destination, source)
                }
            }
        }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            close(fd)
            throw POSIXError(.ECONNREFUSED)
        }
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        return fd
    }

    private func send(command: [String], root: URL, client: Int32, timeoutMs: Int? = 10000) throws {
        let request = ExecHostRequest(command: command, cwd: root.path, timeoutMs: timeoutMs)
        let requestJSON = try #require(String(data: JSONEncoder().encode(request), encoding: .utf8))
        let nonce = UUID().uuidString
        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        let hmac = HMAC<SHA256>.authenticationCode(
            for: Data("\(nonce):\(timestamp):\(requestJSON)".utf8),
            using: SymmetricKey(data: Data("test-token".utf8)))
            .map { String(format: "%02x", $0) }.joined()
        let envelope: [String: Any] = [
            "type": "exec", "id": UUID().uuidString, "nonce": nonce,
            "ts": timestamp, "hmac": hmac, "requestJson": requestJSON,
        ]
        var bytes = try JSONSerialization.data(withJSONObject: envelope)
        bytes.append(0x0A)
        try FileHandle(fileDescriptor: client, closeOnDealloc: false).write(contentsOf: bytes)
    }

    private func readResponse(_ fd: Int32) throws -> ExecHostResponse {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while !data.contains(0x0A) {
            let count = recv(fd, &buffer, buffer.count, 0)
            guard count > 0 else { throw POSIXError(.EIO) }
            data.append(contentsOf: buffer.prefix(count))
        }
        return try JSONDecoder().decode(ExecHostResponse.self, from: data)
    }

    private func readPID(_ url: URL) throws -> pid_t {
        try #require(pid_t(String(contentsOf: url, encoding: .utf8)))
    }

    private func isGone(_ pid: pid_t) -> Bool {
        errno = 0
        return kill(pid, 0) == -1 && errno == ESRCH
    }

    private func waitUntil(_ condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(1)
        while ContinuousClock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }
}
