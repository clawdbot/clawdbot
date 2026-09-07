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

    private enum ResponseReadError: Error {
        case eofBeforeNewline
    }

    @Test
    func `normal request half-close still receives native execution result`() async throws {
        try await self.withServer { server, root, fixture in
            let client = fixture.client
            try self.send(command: ["/usr/bin/printf", "half-close-ok"], root: root, client: client)
            #expect(shutdown(client, SHUT_WR) == 0)
            let response = try await self.readResponse(client)
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
        // Exercise a valid startup slower than the old one-second assumption through the real callback.
        let admissionDelay: Duration = cancellation == .serverStop && withTimeout ? .milliseconds(1200) : .zero
        try await self.withServer(admissionDelay: admissionDelay) { server, root, fixture in
            let sentAt = ContinuousClock.now
            try self.send(
                command: fixture.command, root: root, client: fixture.client, timeoutMs: withTimeout ? 10000 : nil)
            #expect(shutdown(fixture.client, SHUT_WR) == 0)
            let (parent, child) = try await fixture.waitForStart()
            try #require(kill(parent, 0) == 0 && kill(child, 0) == 0, "\(fixture.diagnostics)")
            try #require(fixture.response == nil, "\(fixture.diagnostics)")
            #expect(ContinuousClock.now - sentAt >= admissionDelay)
            #expect(!FileManager.default.fileExists(atPath: fixture.file("sentinel").path))
            print("native ready after \(ContinuousClock.now - sentAt): \(fixture.diagnostics)")
            switch cancellation {
            case .disconnect:
                fixture.closeClient()
            case .serverStop:
                server.stop()
            }
            #expect(await self.waitUntil {
                TestProcessSupport.processIsGone(parent) && TestProcessSupport.processIsGone(child)
            }, "\(fixture.diagnostics)")
            // A surviving child must be released so broken cancellation exposes its side effect.
            try fixture.releaseCommand()
            await server.stop().value
            #expect(!FileManager.default.fileExists(atPath: fixture.file("sentinel").path))
        }
    }

    @Test(arguments: [false, true])
    func `native failure wakes readiness without a PID marker`(missingExecutable: Bool) async throws {
        try await self.withServer { _, root, fixture in
            let command = missingExecutable ? [root.appendingPathComponent("missing-executable").path] : []
            try self.send(command: command, root: root, client: fixture.client)
            do {
                _ = try await fixture.waitForStart()
                Issue.record("Early native failure must not count as readiness")
            } catch let CancellationFixture.StartupFailure.terminal(diagnostics) {
                #expect(diagnostics.contains("child.pid=<missing>"))
                if missingExecutable {
                    #expect(fixture.response?.payload?.success == false)
                    #expect(fixture.response?.payload?.exitCode == 127)
                } else {
                    #expect(fixture.response?.error?.message == "command required")
                }
                print("native early failure: \(diagnostics)")
            }
        }
    }

    @Test
    func `readiness watchdog drains an unpublished child before removing its root`() async throws {
        var fixtureRoot: URL?
        var witnessed: [pid_t] = []
        do {
            try await self.withServer { _, root, fixture in
                fixtureRoot = root
                try Data().write(to: fixture.file("hold-publication"))
                try self.send(command: fixture.command, root: root, client: fixture.client, timeoutMs: nil)
                try await fixture.wait(for: fixture.partialPublication)
                witnessed = try ["parent.pid", "child.pid.tmp"].map {
                    try #require(TestProcessSupport.pollPID(in: fixture.file($0)))
                }
                try #require(witnessed.allSatisfy { kill($0, 0) == 0 })
                _ = try await fixture.waitForStart(watchdog: .milliseconds(50))
                Issue.record("Unpublished child must not count as readiness")
            }
        } catch let CancellationFixture.StartupFailure.watchdog(diagnostics) {
            #expect(diagnostics.contains("child.pid=<missing>"))
            #expect(try diagnostics.contains("child.pid.tmp=\(#require(witnessed.last))"))
            print("native publication watchdog: \(diagnostics)")
        }
        #expect(witnessed.count == 2)
        #expect(witnessed.allSatisfy { TestProcessSupport.processIsGone($0) })
        #expect(try !FileManager.default.fileExists(atPath: #require(fixtureRoot).path))
    }

    @Test
    func `cancelled native executor never starts a command`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
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
        admissionDelay: Duration = .zero,
        _ body: (ExecApprovalsSocketServer, URL, CancellationFixture) async throws -> Void) async throws
    {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try self.seed(root)
        let fixture = try CancellationFixture(root: root)
        let server = ExecApprovalsSocketServer(
            socketPath: root.appendingPathComponent("exec.sock").path,
            token: "test-token",
            onPrompt: { _ in .deny },
            onExec: { request in
                if admissionDelay > .zero { try? await Task.sleep(for: admissionDelay) }
                let response = await ExecApprovalsStore.withStateDirectory(root) {
                    await ExecHostExecutor.handle(request)
                }
                fixture.record(response)
                return response
            },
            onUnexpectedStop: { _ in })
        do {
            try #require(await server.start())
            fixture.client = try self.connect(root)
            try await body(server, root, fixture)
        } catch {
            print("native fixture failure: \(fixture.diagnostics)")
            await fixture.cleanUp(server: server)
            throw error
        }
        await fixture.cleanUp(server: server)
    }

    private func seed(_ root: URL) throws {
        try ExecApprovalsSQLiteStore.write(
            ExecApprovalsFile(version: 1, defaults: nil, agents: [:]),
            stateDirectoryURL: root)
    }

    private func connect(_ root: URL) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
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
            let error = NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            close(fd)
            throw error
        }
        var timeout = timeval(tv_sec: CancellationFixture.socketTimeoutSeconds, tv_usec: 0)
        guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0 else {
            let error = NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            close(fd)
            throw error
        }
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

    private func readResponse(_ fd: Int32) async throws -> ExecHostResponse {
        try await ExecApprovalsSocketTestSupport.withBlockingSocketIO {
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while !data.contains(0x0A) {
                let count = recv(fd, &buffer, buffer.count, 0)
                guard count >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                guard count > 0 else { throw ResponseReadError.eofBeforeNewline }
                data.append(contentsOf: buffer.prefix(count))
            }
            return try JSONDecoder().decode(ExecHostResponse.self, from: data)
        }
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

/// Owns the child's causal handshake and terminal observation, never native execution.
private final class CancellationFixture: @unchecked Sendable {
    enum StartupFailure: Error {
        case watchdog(String)
        case terminal(String)
    }

    static let socketTimeoutSeconds = 5
    let root: URL
    let partialPublication = AsyncTestGate()
    private let startup = AsyncTestGate()
    private let ready: FileHandle
    private let release: FileHandle
    private let partialReady: FileHandle
    private let lock = NSLock()
    private var terminalResponse: ExecHostResponse?
    var client: Int32 = -1

    init(root: URL) throws {
        self.root = root
        let ready = try Self.makeFIFO(root.appendingPathComponent("ready"))
        do {
            let release = try Self.makeFIFO(root.appendingPathComponent("release"))
            do {
                self.partialReady = try Self.makeFIFO(root.appendingPathComponent("partial-ready"))
            } catch {
                try? release.close()
                throw error
            }
            self.release = release
        } catch {
            try? ready.close()
            throw error
        }
        self.ready = ready
        self.ready.readabilityHandler = { [startup] handle in
            handle.readabilityHandler = nil
            startup.open()
        }
        self.partialReady.readabilityHandler = { [partialPublication] handle in
            handle.readabilityHandler = nil
            partialPublication.open()
        }
    }

    private static func makeFIFO(_ url: URL) throws -> FileHandle {
        try #require(mkfifo(url.path, 0o600) == 0)
        // Keep both ends open so setup and failure cleanup never block on a missing child.
        let fd = open(url.path, O_RDWR | O_NONBLOCK | O_CLOEXEC)
        try #require(fd >= 0)
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }

    func file(_ name: String) -> URL {
        self.root.appendingPathComponent(name)
    }

    var response: ExecHostResponse? {
        self.lock.withLock { self.terminalResponse }
    }

    func record(_ response: ExecHostResponse) {
        self.lock.withLock { self.terminalResponse = response }
        self.startup.open()
    }

    private func pid(_ name: String) -> pid_t? {
        guard let pid = TestProcessSupport.pollPID(in: self.file(name)), pid > 1 else { return nil }
        return pid
    }

    var diagnostics: String {
        let markers = ["parent.pid", "child.pid", "child.pid.tmp", "hold-publication", "sentinel"]
            .map { name -> String in
                let value = (try? String(contentsOf: self.file(name), encoding: .utf8)) ?? "<missing>"
                return "\(name)=\(value)"
            }.joined(separator: ", ")
        let response = self.response.flatMap { try? JSONEncoder().encode($0) }
            .flatMap { String(data: $0, encoding: .utf8) } ?? "<pending>"
        return "\(self.root.lastPathComponent): \(markers); response=\(response)"
    }

    func wait(
        for gate: AsyncTestGate,
        watchdog: Duration = .seconds(CancellationFixture.socketTimeoutSeconds)) async throws
    {
        // Reuse the socket watchdog; this is not a startup SLA across MainActor policy work.
        // Both race losers join on cancellation.
        let signalled = try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask {
                await gate.wait()
                return true
            }
            group.addTask {
                try await Task.sleep(for: watchdog)
                return false
            }
            defer { group.cancelAll() }
            return try await group.next() ?? false
        }
        try Task.checkCancellation()
        guard signalled else { throw StartupFailure.watchdog(self.diagnostics) }
    }

    func waitForStart(
        watchdog: Duration = .seconds(CancellationFixture.socketTimeoutSeconds)) async throws
        -> (parent: pid_t, child: pid_t)
    {
        try await self.wait(for: self.startup, watchdog: watchdog)
        guard self.response == nil, let parent = self.pid("parent.pid"), let child = self.pid("child.pid") else {
            throw StartupFailure.terminal(self.diagnostics)
        }
        return (parent, child)
    }

    /// Ready is published only after both PID writes and opening the child's release gate.
    var command: [String] {
        [
            "/bin/sh", "-c",
            """
            printf '%s' "$$" > '\(self.file("parent.pid").path)'
            /bin/sh -c '
              trap "" TERM
              printf "%s" "$$" > "\(self.file("child.pid.tmp").path)"
              exec 3< "\(self.file("release").path)"
              if [ -f "\(self.file("hold-publication").path)" ]; then
                printf partial > "\(self.file("partial-ready").path)"
                IFS= read -r _ <&3
                exit 0
              fi
              /bin/mv "\(self.file("child.pid.tmp").path)" "\(self.file("child.pid").path)"
              printf ready > "\(self.file("ready").path)"
              IFS= read -r _ <&3 || exit 1
              /usr/bin/touch "\(self.file("sentinel").path)"
            ' &
            wait
            """,
        ]
    }

    func releaseCommand() throws {
        try self.release.write(contentsOf: Data("go\n".utf8))
    }

    func closeClient() {
        if self.client >= 0 {
            close(self.client)
            self.client = -1
        }
    }

    func cleanUp(server: ExecApprovalsSocketServer) async {
        self.closeClient()
        let stopped = server.stop()
        // Release even on failed readiness, then join before removing the fixture's root.
        try? self.releaseCommand()
        await stopped.value
        let pidFiles = ["parent.pid", "child.pid", "child.pid.tmp"].map(self.file)
        TestProcessSupport.killLeakedProcesses(in: pidFiles)
        for handle in [self.ready, self.release, self.partialReady] {
            handle.readabilityHandler = nil
            try? handle.close()
        }
        for file in pidFiles {
            if let pid = TestProcessSupport.pollPID(in: file) {
                #expect(TestProcessSupport.processIsGone(pid), "\(self.diagnostics)")
            }
        }
        #expect(!FileManager.default.fileExists(atPath: self.file("exec.sock").path))
    }
}
