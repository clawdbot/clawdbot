import Darwin
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ExecApprovalsPromptServerTests {
    private func makeShortSocketRoot() throws -> URL {
        let root = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .appendingPathComponent("ocps-\(UUID().uuidString.prefix(12))", isDirectory: true)
        try FileManager().createDirectory(
            at: root,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        let socketPath = root.appendingPathComponent("exec-approvals.sock").path
        guard socketPath.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
            throw POSIXError(.ENAMETOOLONG)
        }
        return root
    }

    private final class SequenceCredentialsProbe: @unchecked Sendable {
        private let lock = NSLock()
        private let socketPath: String
        private let tokens: [String]
        private var count = 0
        private var resolvedOnMain = false

        init(socketPath: String, tokens: [String]) {
            self.socketPath = socketPath
            self.tokens = tokens
        }

        func resolve() -> (socketPath: String, token: String) {
            self.lock.withLock {
                self.resolvedOnMain = self.resolvedOnMain || Thread.isMainThread
                let token = self.tokens[min(self.count, self.tokens.count - 1)]
                self.count += 1
                return (self.socketPath, token)
            }
        }

        func snapshot() -> (count: Int, resolvedOnMain: Bool) {
            self.lock.withLock { (self.count, self.resolvedOnMain) }
        }
    }

    private final class BlockingCredentialsProbe: @unchecked Sendable {
        private let lock = NSLock()
        private let release = DispatchSemaphore(value: 0)
        private let socketPath: String
        private var started = false
        private var resolvedOnMain = false
        private var completed = false

        init(socketPath: String) {
            self.socketPath = socketPath
        }

        func resolve() -> (socketPath: String, token: String) {
            self.lock.withLock {
                self.started = true
                self.resolvedOnMain = Thread.isMainThread
            }
            self.release.wait()
            self.lock.withLock {
                self.completed = true
            }
            return (self.socketPath, "current-token")
        }

        func releaseResolution() {
            self.release.signal()
        }

        func snapshot() -> (started: Bool, resolvedOnMain: Bool, completed: Bool) {
            self.lock.withLock { (self.started, self.resolvedOnMain, self.completed) }
        }
    }

    @Test
    func `prompt server reloads credentials after an unavailable approvals read`() async throws {
        let root = try self.makeShortSocketRoot()
        let socketPath = root.appendingPathComponent("exec-approvals.sock").path
        defer { try? FileManager().removeItem(at: root) }

        let probe = SequenceCredentialsProbe(
            socketPath: socketPath,
            tokens: ["", "current-token"])
        let server = ExecApprovalsPromptServer(
            retryDelay: .milliseconds(10),
            resolveSocketCredentials: { probe.resolve() },
            onPrompt: { _ in .allowOnce })
        defer { server.stop() }

        server.start()
        #expect(!FileManager().fileExists(atPath: socketPath))

        let decision = await self.waitForDecision(socketPath: socketPath, token: "current-token")
        let snapshot = probe.snapshot()
        #expect(snapshot.count >= 2)
        #expect(!snapshot.resolvedOnMain)
        #expect(decision == .allowOnce)
    }

    @Test
    func `stopping prompt server prevents a blocked resolver from installing a socket`() async throws {
        let root = try self.makeShortSocketRoot()
        let socketPath = root.appendingPathComponent("exec-approvals.sock").path
        defer { try? FileManager().removeItem(at: root) }

        let probe = BlockingCredentialsProbe(socketPath: socketPath)
        let server = ExecApprovalsPromptServer(
            retryDelay: .milliseconds(10),
            resolveSocketCredentials: { probe.resolve() })

        server.start()
        let started = await self.waitUntil { probe.snapshot().started }
        #expect(started)
        #expect(!probe.snapshot().resolvedOnMain)

        let pendingStartup = server.stop()
        probe.releaseResolution()
        if let pendingStartup {
            await pendingStartup.value
        }

        #expect(probe.snapshot().completed)
        #expect(!FileManager().fileExists(atPath: socketPath))
        let decision = await ExecApprovalsSocketClient.requestDecision(
            socketPath: socketPath,
            token: "current-token",
            request: ExecApprovalPromptRequest(command: "echo stopped"),
            timeoutMs: 100)
        #expect(decision == nil)
    }

    @Test
    func `pre-cancelled socket startup does not listen`() async throws {
        let root = try self.makeShortSocketRoot()
        let socketPath = root.appendingPathComponent("exec-approvals.sock").path
        defer { try? FileManager().removeItem(at: root) }

        let result = await ExecApprovalsPromptServer._testPrecancelledSocketStart(
            socketPath: socketPath)

        #expect(!result.ready)
        #expect(result.preservedExistingListener)
        #expect(!FileManager().fileExists(atPath: socketPath))
    }

    @Test
    func `prompt server retries after a transient socket startup failure`() async throws {
        let root = try self.makeShortSocketRoot()
        let socketURL = root.appendingPathComponent("exec-approvals.sock")
        _ = FileManager().createFile(atPath: socketURL.path, contents: Data("occupied".utf8))
        defer { try? FileManager().removeItem(at: root) }

        let probe = SequenceCredentialsProbe(
            socketPath: socketURL.path,
            tokens: ["current-token"])
        let server = ExecApprovalsPromptServer(
            retryDelay: .milliseconds(10),
            resolveSocketCredentials: { probe.resolve() },
            onPrompt: { _ in .allowOnce })
        defer { server.stop() }

        server.start()
        let observedRetry = await self.waitUntil { probe.snapshot().count >= 2 }
        #expect(observedRetry)
        try FileManager().removeItem(at: socketURL)

        let decision = await self.waitForDecision(
            socketPath: socketURL.path,
            token: "current-token")
        #expect(probe.snapshot().count >= 2)
        #expect(decision == .allowOnce)
    }

    @Test
    func `prompt server restarts after its active listener stops unexpectedly`() async throws {
        let root = try self.makeShortSocketRoot()
        let socketPath = root.appendingPathComponent("exec-approvals.sock").path
        defer { try? FileManager().removeItem(at: root) }

        let probe = SequenceCredentialsProbe(
            socketPath: socketPath,
            tokens: ["current-token"])
        let server = ExecApprovalsPromptServer(
            retryDelay: .milliseconds(10),
            resolveSocketCredentials: { probe.resolve() },
            onPrompt: { _ in .allowOnce })
        defer { server.stop() }

        server.start()
        let initialDecision = await self.waitForDecision(
            socketPath: socketPath,
            token: "current-token")
        let initialResolveCount = probe.snapshot().count
        #expect(initialDecision == .allowOnce)

        server._testFailActiveSocket()

        let recoveredDecision = await self.waitForDecision(
            socketPath: socketPath,
            token: "current-token")
        #expect(probe.snapshot().count > initialResolveCount)
        #expect(recoveredDecision == .allowOnce)
    }

    private func waitForDecision(socketPath: String, token: String) async -> ExecApprovalDecision? {
        for _ in 0..<100 {
            try? await Task.sleep(for: .milliseconds(10))
            if let decision = await ExecApprovalsSocketClient.requestDecision(
                socketPath: socketPath,
                token: token,
                request: ExecApprovalPromptRequest(command: "echo ready"),
                timeoutMs: 100)
            {
                return decision
            }
        }
        return nil
    }

    private func waitUntil(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<100 {
            if condition() {
                return true
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }
}
