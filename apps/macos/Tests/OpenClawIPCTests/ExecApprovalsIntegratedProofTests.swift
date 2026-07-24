import AppKit
import CryptoKit
import Darwin
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ExecApprovalsIntegratedProofTests {
    @Test
    func `native prompt dispatch rejects replay and hot revocation`() async throws {
        guard ProcessInfo.processInfo.environment["OPENCLAW_MACOS_INTEGRATION_PROOF"] == "1" else {
            return
        }

        Self.emitProofStage("test-start")
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.finishLaunching()
        Self.emitProofStage("app-ready")
        let root = try Self.makeShortSocketRoot()
        defer { try? FileManager().removeItem(at: root) }

        let stateDir = root.appendingPathComponent("state", isDirectory: true)
        let socketPath = root.appendingPathComponent("exec-approvals.sock").path
        let markerURL = root.appendingPathComponent("execution-marker.txt")
        let token = "integration-proof-token"
        try Self.seedApprovalsFile(stateDir: stateDir, socketPath: socketPath, token: token)

        try await TestIsolation.withEnvValues([
            "OPENCLAW_HOME": root.appendingPathComponent("home", isDirectory: true).path,
            "OPENCLAW_PROFILE": nil,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            let server = ExecApprovalsPromptServer(
                retryDelay: .milliseconds(10),
                resolveSocketCredentials: { (socketPath, token) })
            defer { _ = server.stop() }
            server.start()
            Self.emitProofStage("server-started")

            guard await self.waitForSocket(socketPath) else {
                Issue.record("exec approvals socket did not become ready")
                return
            }
            Self.emitProofStage("socket-ready")

            let command = [
                "/bin/sh",
                "-c",
                #"printf 'executed\n' >> "$1""#,
                "openclaw-proof",
                markerURL.path,
            ]
            let initialRequest = ExecHostRequest(
                command: command,
                rawCommand: nil,
                cwd: root.path,
                env: nil,
                timeoutMs: 5000,
                needsScreenRecording: false,
                agentId: "main",
                sessionKey: "integration-proof",
                approvalDecision: nil)
            let initialEnvelope = try Self.makeEnvelope(token: token, request: initialRequest)
            let promptObservation = PromptObservationRecorder()
            let promptResponder = Self.scheduleAllowOnceResponse(recorder: promptObservation)
            defer { promptResponder.invalidate() }

            let initialResponse: TestExecResponse
            do {
                initialResponse = try await Self.sendEnvelope(
                    socketPath: socketPath,
                    payload: initialEnvelope)
            } catch {
                Self.emitProofStage("initial-response-error type=\(type(of: error))")
                throw error
            }
            Self.emitProofStage(
                "initial-response ok=\(initialResponse.ok) " +
                    "reason=\(initialResponse.error?.reason ?? "none")")
            let observedPrompt = try #require(promptObservation.value)
            let initialPayload = try #require(initialResponse.payload)

            #expect(initialResponse.ok)
            #expect(initialPayload.success)
            #expect(initialPayload.exitCode == 0)
            #expect(observedPrompt.messageText == "Allow this command?")
            #expect(observedPrompt.informativeText == "Review the command details before allowing.")
            #expect(observedPrompt.buttonTitles == ["Allow Once", "Don't Allow"])
            #expect(try Self.markerCount(at: markerURL) == 1)
            print("MACOS_EXEC_APPROVALS_PROOF native-prompt=observed")
            print("MACOS_EXEC_APPROVALS_PROOF allow-once=accepted marker-count=1")

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.isEmpty)
            print("MACOS_EXEC_APPROVALS_PROOF durable-grant=absent")

            let replayResponse = try await Self.sendEnvelope(
                socketPath: socketPath,
                payload: initialEnvelope)
            #expect(!replayResponse.ok)
            #expect(replayResponse.error?.reason == "replay")
            #expect(try Self.markerCount(at: markerURL) == 1)
            print("MACOS_EXEC_APPROVALS_PROOF replay=rejected marker-count=1")

            let hotRevocationRequest = ExecHostRequest(
                command: command,
                rawCommand: nil,
                cwd: root.path,
                env: nil,
                timeoutMs: 5000,
                needsScreenRecording: false,
                agentId: "main",
                sessionKey: "integration-proof",
                approvalDecision: .allowOnce,
                policySnapshot: Self.policySnapshot,
                denylistBinding: ExecHostDenylistAuthorizationSnapshot(
                    command: "sh -c <redacted>",
                    analysisOk: true,
                    configDenylist: [
                        ExecHostDenylistEntry(pattern: "sh **", reason: "proof STOP rule"),
                    ],
                    approvedRuleKeys: [],
                    denylisted: false))
            let hotRevocationEnvelope = try Self.makeEnvelope(
                token: token,
                request: hotRevocationRequest)
            let hotRevocationResponse = try await Self.sendEnvelope(
                socketPath: socketPath,
                payload: hotRevocationEnvelope)

            #expect(!hotRevocationResponse.ok)
            #expect(hotRevocationResponse.error?.reason == "approval-store-unavailable")
            #expect(try Self.markerCount(at: markerURL) == 1)
            print("MACOS_EXEC_APPROVALS_PROOF hot-stop-revocation=rejected")
            print("MACOS_EXEC_APPROVALS_PROOF final-marker-count=1 result=pass")
        }
    }

    private func waitForSocket(_ socketPath: String) async -> Bool {
        for _ in 0..<200 {
            if (try? ExecApprovalsSocketPathGuard.pathKind(at: socketPath)) == .socket {
                return true
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }

    private static func scheduleAllowOnceResponse(recorder: PromptObservationRecorder) -> Timer {
        let timer = Timer(timeInterval: 0.01, repeats: true) { _ in
            MainActor.assumeIsolated {
                guard recorder.value == nil else { return }
                if let alert = ExecApprovalsPromptPresenter.activeAlertForTesting,
                   NSApp.modalWindow === alert.window,
                   let button = alert.buttons.first(where: { $0.title == "Allow Once" })
                {
                    recorder.value = PromptObservation(
                        messageText: alert.messageText,
                        informativeText: alert.informativeText,
                        buttonTitles: alert.buttons.map(\.title))
                    button.performClick(nil)
                }
            }
        }
        RunLoop.main.add(timer, forMode: .modalPanel)
        return timer
    }

    private nonisolated static func makeShortSocketRoot() throws -> URL {
        let root = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .appendingPathComponent("ocip-\(UUID().uuidString.prefix(12))", isDirectory: true)
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

    private nonisolated static func seedApprovalsFile(
        stateDir: URL,
        socketPath: String,
        token: String) throws
    {
        try FileManager().createDirectory(
            at: stateDir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let file = ExecApprovalsFile(
            version: 1,
            socket: ExecApprovalsSocketConfig(path: socketPath, token: token),
            defaults: ExecApprovalsDefaults(
                security: .allowlist,
                ask: .always,
                askFallback: .deny,
                autoAllowSkills: false),
            agents: [:])
        try ExecApprovalsSQLiteStore.write(file, stateDirectoryURL: stateDir)
    }

    private nonisolated static func makeEnvelope(
        token: String,
        request: ExecHostRequest,
        nonce: String = UUID().uuidString) throws -> Data
    {
        let requestData = try JSONEncoder().encode(request)
        guard let requestJSON = String(data: requestData, encoding: .utf8) else {
            throw CocoaError(.fileReadInapplicableStringEncoding)
        }
        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        let key = SymmetricKey(data: Data(token.utf8))
        let authentication = HMAC<SHA256>.authenticationCode(
            for: Data("\(nonce):\(timestamp):\(requestJSON)".utf8),
            using: key)
        let hmac = authentication.map { String(format: "%02x", $0) }.joined()
        let envelope = TestExecEnvelope(
            type: "exec",
            id: UUID().uuidString,
            nonce: nonce,
            ts: timestamp,
            hmac: hmac,
            requestJson: requestJSON)
        var payload = try JSONEncoder().encode(envelope)
        payload.append(0x0A)
        return payload
    }

    private nonisolated static func sendEnvelope(
        socketPath: String,
        payload: Data) async throws -> TestExecResponse
    {
        try await Task.detached {
            try Self.sendEnvelopeSync(socketPath: socketPath, payload: payload)
        }.value
    }

    private nonisolated static func sendEnvelopeSync(
        socketPath: String,
        payload: Data) throws -> TestExecResponse
    {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.EIO) }
        defer { close(fd) }

        var timeout = timeval(tv_sec: 20, tv_usec: 0)
        let timeoutSize = socklen_t(MemoryLayout.size(ofValue: timeout))
        guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, timeoutSize) == 0,
              setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, timeoutSize) == 0
        else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let maxLength = MemoryLayout.size(ofValue: address.sun_path)
        guard socketPath.utf8.count < maxLength else { throw POSIXError(.ENAMETOOLONG) }
        socketPath.withCString { source in
            withUnsafeMutablePointer(to: &address.sun_path) { pointer in
                let target = UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: Int8.self)
                memset(target, 0, maxLength)
                strncpy(target, source, maxLength - 1)
            }
        }
        let addressSize = socklen_t(MemoryLayout.size(ofValue: address))
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                connect(fd, rebound, addressSize)
            }
        }
        guard connected == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }

        try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: payload)
        var responseData = Data()
        while responseData.count < 256_000 {
            var chunk = [UInt8](repeating: 0, count: 4096)
            let count = chunk.withUnsafeMutableBytes { bytes in
                recv(fd, bytes.baseAddress, bytes.count, 0)
            }
            if count == 0 { break }
            if count < 0 {
                if errno == EINTR { continue }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            responseData.append(contentsOf: chunk.prefix(count))
            if responseData.contains(0x0A) { break }
        }
        guard let newline = responseData.firstIndex(of: 0x0A) else {
            throw POSIXError(.EBADMSG)
        }
        return try JSONDecoder().decode(
            TestExecResponse.self,
            from: responseData.subdata(in: 0..<newline))
    }

    private nonisolated static func markerCount(at url: URL) throws -> Int {
        guard FileManager().fileExists(atPath: url.path) else { return 0 }
        return try String(contentsOf: url, encoding: .utf8)
            .split(separator: "\n")
            .count
    }

    private nonisolated static func emitProofStage(_ stage: String) {
        guard let data = "MACOS_EXEC_APPROVALS_PROOF stage=\(stage)\n".data(using: .utf8) else {
            return
        }
        try? FileHandle.standardError.write(contentsOf: data)
    }

    private static let policySnapshot = OpenClawSystemRunApprovalPolicySnapshot(
        security: .allowlist,
        ask: .always,
        askFallback: .deny,
        autoAllowSkills: false,
        allowlistRules: [])

    private struct PromptObservation: Sendable {
        let messageText: String
        let informativeText: String
        let buttonTitles: [String]
    }

    @MainActor
    private final class PromptObservationRecorder {
        var value: PromptObservation?
    }

    private struct TestExecEnvelope: Codable, Sendable {
        let type: String
        let id: String
        let nonce: String
        let ts: Int
        let hmac: String
        let requestJson: String
    }

    private struct TestExecResponse: Codable, Sendable {
        let type: String
        let id: String
        let ok: Bool
        let payload: TestExecRunResult?
        let error: TestExecError?
    }

    private struct TestExecRunResult: Codable, Sendable {
        let exitCode: Int?
        let timedOut: Bool
        let success: Bool
        let stdout: String
        let stderr: String
        let error: String?
    }

    private struct TestExecError: Codable, Sendable {
        let code: String
        let message: String
        let reason: String?
    }
}
