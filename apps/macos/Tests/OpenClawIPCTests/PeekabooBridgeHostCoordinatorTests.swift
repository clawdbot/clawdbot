import Foundation
import PeekabooBridge
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct PeekabooBridgeHostCoordinatorTests {
    @Test
    func `production authorization uses the canonical Peekaboo CLI release signers`() {
        #expect(
            PeekabooBridgeHostCoordinator.allowedClientTeamIDs ==
                PeekabooBridgeConstants.trustedReleaseTeamIDs)
        #expect(PeekabooBridgeHostCoordinator.allowedClientTeamIDs == ["Y5PE65HELJ", "FWJYW4S8P8"])
        #expect(PeekabooBridgeHostCoordinator.allowedClientBundleIDs == ["boo.peekaboo.peekaboo"])
    }

    @Test
    func `later disable stops an earlier suspended startup before it is retained`() async {
        let startEntered = AsyncTestGate()
        let releaseStart = AsyncTestGate()
        let runtime = ScriptedBridgeRuntime(
            startAction: {
                startEntered.open()
                await releaseStart.wait()
            })
        let factory = ScriptedRuntimeFactory([runtime])
        let coordinator = Self.coordinator(factory: factory)

        let enableTask = Task { await coordinator.setEnabled(true) }
        await startEntered.wait()
        let disableTask = Task { await coordinator.setEnabled(false) }
        await Task.yield()
        await Task.yield()
        releaseStart.open()

        await enableTask.value
        await disableTask.value
        #expect(await runtime.startCount == 1)
        #expect(await runtime.stopCount == 1)
        #expect(await runtime.snapshot().state == .stopped)
    }

    @Test
    func `a later enable retries after startup failure`() async {
        let failedRuntime = ScriptedBridgeRuntime(startResults: [.failure(.startup)])
        let readyRuntime = ScriptedBridgeRuntime()
        let factory = ScriptedRuntimeFactory([failedRuntime, readyRuntime])
        let coordinator = Self.coordinator(factory: factory)

        await coordinator.setEnabled(true)
        await coordinator.setEnabled(true)

        #expect(factory.makeCount == 2)
        #expect(await failedRuntime.startCount == 1)
        #expect(await readyRuntime.startCount == 1)
        await coordinator.setEnabled(false)
        #expect(await readyRuntime.stopCount == 1)
    }

    @Test
    func `incomplete stop retains the runtime for a later teardown retry`() async {
        let runtime = ScriptedBridgeRuntime(stopStates: [.stopping, .stopped])
        let factory = ScriptedRuntimeFactory([runtime])
        let coordinator = Self.coordinator(factory: factory)

        await coordinator.setEnabled(true)
        await coordinator.setEnabled(false)
        await coordinator.setEnabled(false)

        #expect(factory.makeCount == 1)
        #expect(await runtime.stopCount == 2)
        #expect(await runtime.snapshot().state == .stopped)
    }

    @Test
    func `legacy aliases never replace regular files or unrelated symlinks`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-peekaboo-alias-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let target = root.appendingPathComponent("target.sock").path
        let regularAlias = root.appendingPathComponent("regular/bridge.sock")
        let foreignAlias = root.appendingPathComponent("foreign/bridge.sock")
        let newAlias = root.appendingPathComponent("new/bridge.sock")
        try FileManager.default.createDirectory(
            at: regularAlias.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: foreignAlias.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try Data("owned by another process".utf8).write(to: regularAlias)
        try FileManager.default.createSymbolicLink(
            atPath: foreignAlias.path,
            withDestinationPath: root.appendingPathComponent("other.sock").path)

        LegacyPeekabooSocketAliasManager(
            targetSocketPath: target,
            aliasSocketPaths: [regularAlias.path, foreignAlias.path, newAlias.path])
            .ensureAliases(logger: .init(subsystem: "ai.openclaw.tests", category: "PeekabooBridge"))

        #expect(try String(contentsOf: regularAlias, encoding: .utf8) == "owned by another process")
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: foreignAlias.path) ==
            root.appendingPathComponent("other.sock").path)
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: newAlias.path) == target)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_PEEKABOO_HANDSHAKE_CLI"] != nil))
    func `embedded runtime serves an exact socket handshake`() async throws {
        let cliPath = try #require(ProcessInfo.processInfo.environment["OPENCLAW_PEEKABOO_HANDSHAKE_CLI"])
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let socketPath = root.appendingPathComponent("bridge.sock").path

        let coordinator = PeekabooBridgeHostCoordinator(
            runtimeFactory: {
                PeekabooEmbeddedBridgeRuntime.make(
                    configuration: .init(
                        socketPath: socketPath,
                        allowlistedTeams: PeekabooBridgeHostCoordinator.allowedClientTeamIDs,
                        allowlistedBundles: PeekabooBridgeHostCoordinator.allowedClientBundleIDs,
                        hostKind: .gui))
            },
            aliasManager: .init(targetSocketPath: socketPath, aliasSocketPaths: []))
        await coordinator.setEnabled(true)

        let result: ProcessResult
        do {
            result = try await Task.detached {
                let process = Process()
                let stdout = Pipe()
                let stderr = Pipe()
                process.executableURL = URL(fileURLWithPath: cliPath)
                process.arguments = ["bridge", "status", "--bridge-socket", socketPath, "--json"]
                process.standardOutput = stdout
                process.standardError = stderr
                try process.run()
                process.waitUntilExit()
                return ProcessResult(
                    status: process.terminationStatus,
                    stdout: String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self),
                    stderr: String(decoding: stderr.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
            }.value
        } catch {
            await coordinator.shutdown()
            throw error
        }
        await coordinator.shutdown()
        #expect(result.status == 0, Comment(rawValue: result.stderr))
        #expect(result.stdout.replacingOccurrences(of: "\\/", with: "/").contains(socketPath))
        #expect(result.stdout.contains("backgroundBridgeHost"))

        #expect(!FileManager.default.fileExists(atPath: socketPath))
    }

    private static func coordinator(factory: ScriptedRuntimeFactory) -> PeekabooBridgeHostCoordinator {
        PeekabooBridgeHostCoordinator(
            runtimeFactory: { factory.make() },
            aliasManager: .init(targetSocketPath: "/tmp/openclaw-test.sock", aliasSocketPaths: []))
    }
}

private struct ProcessResult: Sendable {
    let status: Int32
    let stdout: String
    let stderr: String
}

private enum ScriptedRuntimeError: Error {
    case startup
}

private actor ScriptedBridgeRuntime: PeekabooBridgeRuntimeControlling {
    private let socketPath = "/tmp/openclaw-scripted-peekaboo.sock"
    private let startAction: @Sendable () async -> Void
    private var startResults: [Result<PeekabooEmbeddedBridgeRuntimeState, ScriptedRuntimeError>]
    private var stopStates: [PeekabooEmbeddedBridgeRuntimeState]
    private var state: PeekabooEmbeddedBridgeRuntimeState = .stopped
    private(set) var startCount = 0
    private(set) var stopCount = 0

    init(
        startResults: [Result<PeekabooEmbeddedBridgeRuntimeState, ScriptedRuntimeError>] = [.success(.ready)],
        stopStates: [PeekabooEmbeddedBridgeRuntimeState] = [.stopped],
        startAction: @escaping @Sendable () async -> Void = {})
    {
        self.startResults = startResults
        self.stopStates = stopStates
        self.startAction = startAction
    }

    func startChecked() async throws -> PeekabooEmbeddedBridgeRuntimeSnapshot {
        self.startCount += 1
        await self.startAction()
        let result = self.startResults.isEmpty ? .success(.ready) : self.startResults.removeFirst()
        self.state = try result.get()
        return self.snapshot()
    }

    func stopChecked() async {
        self.stopCount += 1
        self.state = self.stopStates.isEmpty ? .stopped : self.stopStates.removeFirst()
    }

    func snapshot() -> PeekabooEmbeddedBridgeRuntimeSnapshot {
        .init(state: self.state, socketPath: self.socketPath, hostCapabilities: [])
    }
}

@MainActor
private final class ScriptedRuntimeFactory {
    private var runtimes: [ScriptedBridgeRuntime]
    private(set) var makeCount = 0

    init(_ runtimes: [ScriptedBridgeRuntime]) {
        self.runtimes = runtimes
    }

    func make() -> any PeekabooBridgeRuntimeControlling {
        self.makeCount += 1
        return self.runtimes.removeFirst()
    }
}
