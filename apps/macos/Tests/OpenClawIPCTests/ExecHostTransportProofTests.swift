import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

/// Opt-in, process-isolated proof. The socket accept task is detached, so a task-local
/// store override alone cannot isolate the executor from the operator's approvals.
@Suite(.serialized)
@MainActor
struct ExecHostTransportProofTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_EXEC_HOST_NATIVE_PROOF"] == "1"))
    func `native execution survives lost response`() async throws {
        let environment = ProcessInfo.processInfo.environment
        let statePath = try #require(environment["OPENCLAW_STATE_DIR"])
        let state = URL(fileURLWithPath: statePath).resolvingSymlinksInPath()
        let root = state.deletingLastPathComponent()
        try #require(root.deletingLastPathComponent().path == URL(fileURLWithPath: "/tmp").resolvingSymlinksInPath()
            .path)
        try #require(root.lastPathComponent.hasPrefix("oc-exec-native-"))
        for key in ["HOME", "CFFIXED_USER_HOME", "OPENCLAW_HOME"] {
            let value = try #require(environment[key])
            try #require(URL(fileURLWithPath: value).resolvingSymlinksInPath().path == root
                .appendingPathComponent("home").path)
        }
        try #require(ExecApprovalsStore.databaseURL().resolvingSymlinksInPath().path ==
            ExecApprovalsSQLiteStore.databaseURL(stateDirectoryURL: state).resolvingSymlinksInPath().path)
        let socketPath = root.appendingPathComponent("native.sock").path
        let token = "exec-host-native-proof-token"
        try ExecApprovalsSQLiteStore.write(
            ExecApprovalsFile(
                version: 1,
                socket: ExecApprovalsSocketConfig(path: socketPath, token: token),
                defaults: ExecApprovalsDefaults(security: .full, ask: .off, autoAllowSkills: false),
                agents: ["denied": ExecApprovalsAgent(security: .deny, ask: .off)]),
            stateDirectoryURL: state)

        let server = ExecApprovalsPromptServer(
            resolveSocketCredentials: { (socketPath, token) },
            onPrompt: { _ in
                Issue.record("This proof must not request interactive approval")
                return .deny
            })
        server.start()
        do {
            let deadline = ContinuousClock.now + .seconds(5)
            while !FileManager.default.fileExists(atPath: socketPath), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(FileManager.default.fileExists(atPath: socketPath))
            var repo = URL(fileURLWithPath: #filePath)
            for _ in 0..<5 {
                repo.deleteLastPathComponent()
            }
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            child.arguments = [
                "node", "--import", "tsx",
                repo.appendingPathComponent("src/infra/exec-host.native.test-support.ts").path,
                root.path, socketPath,
            ]
            child.currentDirectoryURL = repo
            child.environment = environment
            let outputURL = root.appendingPathComponent("native-client.log")
            FileManager.default.createFile(atPath: outputURL.path, contents: nil)
            let output = try FileHandle(forWritingTo: outputURL)
            defer { try? output.close() }
            child.standardOutput = output
            child.standardError = output
            let exited = Task { @MainActor in
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int32, any Error>) in
                    child.terminationHandler = { process in continuation.resume(returning: process.terminationStatus) }
                    do { try child.run() } catch { continuation.resume(throwing: error) }
                }
            }
            let exitCode = try await exited.value
            try output.close()
            let log = try String(contentsOf: outputURL, encoding: .utf8)
            #expect(exitCode == 0, "TypeScript boundary proof failed: \(log)")
            #expect(log.contains("native START -> response dropped -> client null -> native COMPLETE"))
            #expect(log.contains("native success and policy denial verified"))
        } catch {
            if let pending = server.stop() { await pending.value }
            throw error
        }
        if let pending = server.stop() { await pending.value }
        #expect(!FileManager.default.fileExists(atPath: socketPath))
    }
}
