import Darwin
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ExecApprovalsPromptServerTests {
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
    func `prompt server retry backoff grows exponentially and caps`() {
        var backoff = ExecApprovalsPromptRetryBackoff(
            initialDelay: .milliseconds(10),
            maximumDelay: .milliseconds(40))

        #expect(backoff.nextDelay() == .milliseconds(10))
        #expect(backoff.nextDelay() == .milliseconds(20))
        #expect(backoff.nextDelay() == .milliseconds(40))
        #expect(backoff.nextDelay() == .milliseconds(40))
    }

    @Test
    func `prompt server reloads credentials after an unavailable approvals read`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        let socketPath = root.appendingPathComponent("exec-approvals.sock").path
        defer { try? FileManager().removeItem(at: root) }

        let probe = SequenceCredentialsProbe(
            socketPath: socketPath,
            tokens: ["", "current-token"])
        let server = ExecApprovalsPromptServer(
            retryDelay: .milliseconds(10),
            resolveSocketCredentials: { probe.resolve() },
            onPrompt: { _ in .allowOnce })

        server.start()
        #expect(!FileManager().fileExists(atPath: socketPath))

        let decision = await self.waitForDecision(socketPath: socketPath, token: "current-token")
        let snapshot = probe.snapshot()
        #expect(snapshot.count >= 2)
        #expect(!snapshot.resolvedOnMain)
        #expect(decision == .allowOnce)
        await server.stop()?.value
    }

    @Test
    func `stopping prompt server prevents a blocked resolver from installing a socket`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
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
        let decision = await ExecApprovalsSocketTestSupport.requestDecision(
            socketPath: socketPath,
            token: "current-token",
            timeoutMs: 100)
        #expect(decision == nil)
    }

    @Test
    func `pre-cancelled socket startup does not listen`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        let socketPath = root.appendingPathComponent("exec-approvals.sock").path
        defer { try? FileManager().removeItem(at: root) }

        let sentinel = ExecApprovalsSocketTestSupport.makeServer(socketPath: socketPath)
        #expect(await sentinel.start())
        let server = ExecApprovalsSocketTestSupport.makeServer(socketPath: socketPath)
        let ready = await Task.detached {
            withUnsafeCurrentTask { $0?.cancel() }
            return await server.start()
        }.value
        await server.stop().value

        #expect(!ready)
        #expect(sentinel.isListening)
        #expect((try? ExecApprovalsSocketPathGuard.pathKind(at: socketPath)) == .socket)
        await sentinel.stop().value
        #expect(!FileManager().fileExists(atPath: socketPath))
    }

    @Test
    func `prompt server retries after a transient socket startup failure`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
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

        server.start()
        let observedRetry = await self.waitUntil { probe.snapshot().count >= 2 }
        #expect(observedRetry)
        do {
            try FileManager().removeItem(at: socketURL)
        } catch {
            await server.stop()?.value
            throw error
        }

        let decision = await self.waitForDecision(
            socketPath: socketURL.path,
            token: "current-token")
        #expect(probe.snapshot().count >= 2)
        #expect(decision == .allowOnce)
        await server.stop()?.value
    }

    @Test
    func `prompt server restarts after its active listener stops unexpectedly`() async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        let socketPath = root.appendingPathComponent("exec-approvals.sock").path
        defer { try? FileManager().removeItem(at: root) }

        let probe = SequenceCredentialsProbe(
            socketPath: socketPath,
            tokens: ["current-token"])
        let server = ExecApprovalsPromptServer(
            retryDelay: .milliseconds(10),
            resolveSocketCredentials: { probe.resolve() },
            onPrompt: { _ in .allowOnce })

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
        await server.stop()?.value
    }

    private func waitForDecision(socketPath: String, token: String) async -> ExecApprovalDecision? {
        for _ in 0..<100 {
            try? await Task.sleep(for: .milliseconds(10))
            if let decision = await ExecApprovalsSocketTestSupport.requestDecision(
                socketPath: socketPath,
                token: token,
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
