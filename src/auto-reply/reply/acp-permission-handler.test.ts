import type { AcpPermissionRequest } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { createAcpPermissionHandler } from "./acp-permission-handler.js";

function executeRequest(
  toolCallId = "tool-1",
  command = "touch /tmp/acp-approved.txt",
): AcpPermissionRequest {
  return {
    sessionId: "cursor-session-1",
    toolCall: {
      toolCallId,
      title: "Run command",
      kind: "execute",
      rawInput: { command },
    },
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "deny", name: "Reject once", kind: "reject_once" },
    ],
    inferredKind: "execute",
  };
}

function createHost() {
  return {
    assertActive: vi.fn(),
    requestApproval: vi.fn(),
    waitForApproval: vi.fn(),
  };
}

describe("createAcpPermissionHandler", () => {
  it("keeps a two-phase request pending and maps the resolved decision", async () => {
    const host = createHost();
    host.requestApproval.mockResolvedValue({ id: "approval-1" });
    host.waitForApproval.mockResolvedValue({
      decision: "allow-once",
      terminalReason: "resolved",
    });
    const handler = createAcpPermissionHandler({ host, cwd: "/workspace" });

    await expect(
      handler(executeRequest(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ outcome: "allow_once" });
    expect(host.requestApproval).toHaveBeenCalledWith({
      title: "touch /tmp/acp-approved.txt",
      description:
        "ACP tool kind: execute. Working directory: /workspace. Command: touch /tmp/acp-approved.txt",
      severity: "warning",
      toolName: "acp:execute",
      toolCallId: "tool-1",
      allowedDecisions: ["allow-once", "deny"],
      timeoutMs: 600_000,
      transportTimeoutMs: 605_000,
    });
    expect(host.waitForApproval).toHaveBeenCalledWith({
      approvalId: "approval-1",
      timeoutMs: 600_000,
      transportTimeoutMs: 605_000,
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    ["allow-once", "allow_once"],
    ["allow-always", "allow_always"],
    ["deny", "reject_once"],
    [null, "cancel"],
    [undefined, "cancel"],
  ] as const)("maps an immediate %s decision to %s", async (decision, outcome) => {
    const host = createHost();
    host.requestApproval.mockResolvedValue(decision === undefined ? undefined : { decision });
    const handler = createAcpPermissionHandler({ host });

    await expect(
      handler(executeRequest(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ outcome });
    expect(host.waitForApproval).not.toHaveBeenCalled();
  });

  it("does not create plugin approvals for read and search requests", async () => {
    const host = createHost();
    const handler = createAcpPermissionHandler({ host });

    await expect(
      handler(
        {
          ...executeRequest(),
          inferredKind: "read",
          toolCall: { ...executeRequest().toolCall, kind: "read" },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
    expect(host.requestApproval).not.toHaveBeenCalled();
  });

  it("keeps concurrent permissions independent and fails closed per decision", async () => {
    const host = createHost();
    host.requestApproval.mockImplementation(async ({ toolCallId }) => ({
      id: `approval-${toolCallId}`,
    }));
    host.waitForApproval.mockImplementation(async ({ approvalId }) => ({
      decision: approvalId.endsWith("allow") ? "allow-once" : "deny",
      terminalReason: "resolved",
    }));
    const handler = createAcpPermissionHandler({ host });
    const signal = new AbortController().signal;

    await expect(
      Promise.all([
        handler(executeRequest("allow"), { signal }),
        handler(executeRequest("deny"), { signal }),
      ]),
    ).resolves.toEqual([{ outcome: "allow_once" }, { outcome: "reject_once" }]);
    expect(host.waitForApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-allow" }),
    );
    expect(host.waitForApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-deny" }),
    );
  });

  it("redacts secrets without pre-truncating titles before gateway display caps", async () => {
    const host = createHost();
    host.requestApproval.mockResolvedValue({ decision: "deny" });
    const secret = `ghp_${"a".repeat(36)}`;
    const handler = createAcpPermissionHandler({ host, cwd: "/workspace" });

    await handler(executeRequest("tool-secret", `echo ${secret} ${"x".repeat(300)}`), {
      signal: new AbortController().signal,
    });

    const request = host.requestApproval.mock.calls[0]?.[0];
    expect(request.title).not.toContain(secret);
    expect(request.description).not.toContain(secret);
    expect(request.title).toContain("echo");
    expect(request.description.length).toBeGreaterThan(256);
  });

  it("forwards ampersand-heavy commands without ACP-side title truncation", async () => {
    const host = createHost();
    host.requestApproval.mockResolvedValue({ decision: "deny" });
    const handler = createAcpPermissionHandler({ host, cwd: "/workspace" });
    const command = `true ${"&".repeat(40)}`;

    await handler(executeRequest("tool-ampersands", command), {
      signal: new AbortController().signal,
    });

    expect(host.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        title: command,
      }),
    );
  });
});
