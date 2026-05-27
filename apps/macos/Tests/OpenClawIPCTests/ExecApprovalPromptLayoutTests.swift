import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ExecApprovalPromptLayoutTests {
    @Test func `allowed decisions omit durable approval even when ask allows it`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc pwd",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "full",
                ask: "on-miss",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1",
                allowedDecisions: [.allowOnce, .deny]))

        #expect(decisions == [.allowOnce, .deny])
    }

    @Test func `ask always prompts omit durable approval when decisions are omitted`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc pwd",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "full",
                ask: "always",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1"))

        #expect(decisions == [.allowOnce, .deny])
    }

    @Test func `ask on miss prompts keep durable approval when decisions are omitted`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc pwd",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "full",
                ask: "on-miss",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1"))

        #expect(decisions == [.allowOnce, .allowAlways, .deny])
    }

    @Test func `legacy prompts keep durable approval when policy fields are omitted`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc pwd",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "full",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1"))

        #expect(decisions == [.allowOnce, .allowAlways, .deny])
    }

    @Test func `unknown ask prompts keep legacy durable approval when decisions are omitted`() {
        let decisions = ExecApprovalsPromptPresenter.allowedPromptDecisions(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc pwd",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "full",
                ask: "unexpected",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1"))

        #expect(decisions == [.allowOnce, .allowAlways, .deny])
    }

    @Test func `approval request decodes valid allowed decisions only`() throws {
        let data = """
            {
              "command": "/bin/sh -lc pwd",
              "ask": "on-miss",
              "allowedDecisions": ["allow-once", "bad", "deny", 3]
            }
            """.data(using: .utf8)!

        let request = try JSONDecoder().decode(ExecApprovalPromptRequest.self, from: data)

        #expect(request.allowedDecisions == [.allowOnce, .deny])
    }

    @Test func `approval request falls back when allowed decisions has wrong shape`() throws {
        let data = """
            {
              "command": "/bin/sh -lc pwd",
              "ask": "always",
              "allowedDecisions": "allow-once"
            }
            """.data(using: .utf8)!

        let request = try JSONDecoder().decode(ExecApprovalPromptRequest.self, from: data)

        #expect(ExecApprovalsPromptPresenter.allowedPromptDecisions(request) == [.allowOnce, .deny])
    }

    @Test func `modal close does not synthesize deny when deny is unavailable`() {
        let closeResponse = NSApplication.ModalResponse(rawValue: 0)

        let withoutDeny = ExecApprovalsPromptPresenter.decision(
            forModalResponse: closeResponse,
            decisions: [.allowOnce])
        let withDeny = ExecApprovalsPromptPresenter.decision(
            forModalResponse: closeResponse,
            decisions: [.allowOnce, .deny])

        #expect(withoutDeny == nil)
        #expect(withDeny == .deny)
    }

    @Test func `accessory view reserves nonzero alert layout space`() {
        let accessory = ExecApprovalsPromptPresenter.buildAccessoryView(
            ExecApprovalPromptRequest(
                command: "/bin/sh -lc \"hostname; uptime; echo '---'\"",
                cwd: "/Users/example/projects/openclaw",
                host: "node",
                security: "allowlist",
                ask: "on-miss",
                agentId: "main",
                resolvedPath: "/bin/sh",
                sessionKey: "session-1"))

        #expect(accessory.frame.width >= 380)
        #expect(accessory.frame.height >= 160)

        let alert = NSAlert()
        alert.messageText = "Allow this command?"
        alert.informativeText = "Review the command details before allowing."
        alert.accessoryView = accessory

        #expect(alert.accessoryView?.frame.width == accessory.frame.width)
        #expect(alert.accessoryView?.frame.height == accessory.frame.height)
    }
}
