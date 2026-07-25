import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct ExecApprovalsSocketAuthTests {
    @Test
    func `timing safe hex compare matches equal strings`() {
        #expect(timingSafeHexStringEquals(String(repeating: "a", count: 64), String(repeating: "a", count: 64)))
    }

    @Test
    func `timing safe hex compare rejects mismatched strings`() {
        let expected = String(repeating: "a", count: 63) + "b"
        let provided = String(repeating: "a", count: 63) + "c"
        #expect(!timingSafeHexStringEquals(expected, provided))
    }

    @Test
    func `timing safe hex compare rejects different length strings`() {
        #expect(!timingSafeHexStringEquals(String(repeating: "a", count: 64), "deadbeef"))
    }

    @Test
    func `minimum timestamp is rejected before authentication without overflow`() async {
        #expect(!execHostTimestampIsFresh(nowMs: 1_700_000_000_000, requestMs: Int.min))
        #expect(await ExecApprovalsPromptServer._testExecHostTimestampFailureReason(Int.min) == "ttl")
    }

    @Test
    func `exec host limiter preserves small output`() {
        #expect(ExecHostOutputLimiter.truncate("hello") == "hello")
    }

    @Test
    func `exec host limiter preserves a valid utf8 tail`() {
        let input = String(repeating: "x", count: 2 * 1024 * 1024) + "✅"
        let limited = ExecHostOutputLimiter.truncate(input)

        #expect(limited.hasPrefix("... (truncated) "))
        #expect(limited.hasSuffix("✅"))
        #expect(limited.utf8.count <= ExecHostOutputLimiter.maxOutputFieldBytes)
    }

    @Test
    func `exec host limiter keeps escaped output below the jsonl cap`() throws {
        let escaped = String(repeating: "\u{0}", count: 2 * 1024 * 1024)
        let limited = ExecHostOutputLimiter.truncate(escaped)
        let response = EncodedExecHostResponse(
            type: "exec-res",
            id: "test",
            ok: true,
            payload: EncodedExecHostRunResult(
                exitCode: 0,
                timedOut: false,
                success: true,
                stdout: limited,
                stderr: limited,
                error: nil),
            error: nil)

        #expect(try JSONEncoder().encode(response).count < ExecHostOutputLimiter.maxJsonlResponseBytes)
    }

    @Test
    func `exec host limiter bounds real command output`() async {
        let result = await ShellExecutor.runDetailed(
            command: [
                "/usr/bin/perl",
                "-e",
                "print 'x' x (2 * 1024 * 1024); print STDERR 'y' x (2 * 1024 * 1024);",
            ],
            cwd: nil,
            env: nil,
            timeout: 10)

        #expect(ExecHostOutputLimiter.truncate(result.stdout).utf8.count <= ExecHostOutputLimiter.maxOutputFieldBytes)
        #expect(ExecHostOutputLimiter.truncate(result.stderr).utf8.count <= ExecHostOutputLimiter.maxOutputFieldBytes)
        #expect(result.exitCode == 0)
    }

    @Test
    func `socket decoded argv reaches executor without token normalization`() async throws {
        let command = ["/usr/bin/printf", "<%s>|<%s>", "  padded  ", "-n"]
        let request = ExecHostRequest(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: .allowOnce,
            policySnapshot: Self.policySnapshot)
        let requestJSON = try JSONEncoder().encode(request)
        let socketDecodedRequest = try JSONDecoder().decode(ExecHostRequest.self, from: requestJSON)

        let validated: ExecHostValidatedRequest
        switch ExecHostRequestEvaluator.validateRequest(socketDecodedRequest) {
        case let .success(request):
            validated = request
        case let .failure(error):
            Issue.record("unexpected invalid request: \(error.message)")
            return
        }
        let result = await ShellExecutor.runDetailed(
            command: validated.command,
            cwd: nil,
            env: nil,
            timeout: 2)

        #expect(validated.command == command)
        #expect(validated.displayCommand == ExecCommandFormatter.displayString(for: command))
        #expect(result.stdout == "<  padded  >|<-n>")
        #expect(result.exitCode == 0)
    }

    @Test
    func `socket serialization preserves timeout fallback provenance`() throws {
        let request = ExecHostRequest(
            command: ["/usr/bin/printf", "ok"],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: "main",
            sessionKey: "agent:main:main",
            approvalDecision: nil,
            approvalSource: "ask-fallback")

        let decoded = try JSONDecoder().decode(
            ExecHostRequest.self,
            from: JSONEncoder().encode(request))
        #expect(decoded.approvalSource == "ask-fallback")
        #expect(decoded.approvalDecision == nil)
    }

    @Test
    func `socket decodes TypeScript auto review policy snapshot`() throws {
        let requestJSON = Data(#"""
        {
          "command": ["/usr/bin/printf", "ok"],
          "agentId": "main",
          "sessionKey": "agent:main:main",
          "approvalSource": "auto-review",
          "policySnapshot": {
            "security": "allowlist",
            "ask": "on-miss",
            "askFallback": "deny",
            "autoAllowSkills": true,
            "allowlistRules": [
              {"pattern": "/ä"},
              {"pattern": "/A", "source": "allow-always"},
              {"pattern": "/"},
              {"pattern": "/"},
              {"pattern": "/A"}
            ]
          }
        }
        """#.utf8)

        let decoded = try JSONDecoder().decode(ExecHostRequest.self, from: requestJSON)
        #expect(decoded.approvalSource == "auto-review")
        #expect(decoded.approvalDecision == nil)
        #expect(decoded.policySnapshot?.allowlistRules == [
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/"),
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/A"),
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/A", source: .allowAlways),
            OpenClawSystemRunApprovalPolicySnapshot.Rule(pattern: "/ä"),
        ])
        switch ExecHostRequestEvaluator.validateRequest(decoded) {
        case let .success(validated):
            #expect(validated.delayedPolicySnapshot?.portable == decoded.policySnapshot)
        case let .failure(error):
            Issue.record("unexpected invalid request: \(error.message)")
        }
    }

    private static let policySnapshot = OpenClawSystemRunApprovalPolicySnapshot(
        security: .full,
        ask: .off,
        askFallback: .deny,
        autoAllowSkills: false,
        allowlistRules: [])

    private struct EncodedExecHostResponse: Codable {
        var type: String
        var id: String
        var ok: Bool
        var payload: EncodedExecHostRunResult?
        var error: String?
    }

    private struct EncodedExecHostRunResult: Codable {
        var exitCode: Int?
        var timedOut: Bool
        var success: Bool
        var stdout: String
        var stderr: String
        var error: String?
    }
}
