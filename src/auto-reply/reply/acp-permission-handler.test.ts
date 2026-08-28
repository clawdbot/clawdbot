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

function persistentAllowOnlyRequest(toolCallId = "tool-persistent"): AcpPermissionRequest {
  return {
    ...executeRequest(toolCallId),
    options: [
      { optionId: "always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject", name: "Reject once", kind: "reject_once" },
    ],
  };
}

function createHost() {
  return {
    assertActive: vi.fn(),
    requestApproval: vi.fn(),
    waitForApproval: vi.fn(),
  };
}

/**
 * Mirrors DECISION_FALLBACK_ORDER / decisionToResponse in acpx 0.13.1, which is
 * not exported. An outcome resolves against the offered options and falls back
 * across persistence, so asserting the outcome alone would hide a silent
 * escalation from allow_once to allow_always.
 */
const ACPX_DECISION_FALLBACK_ORDER = {
  allow_once: ["allow_once", "allow_always"],
  allow_always: ["allow_always", "allow_once"],
  reject_once: ["reject_once", "reject_always"],
  reject_always: ["reject_always", "reject_once"],
} as const;

function selectAcpxOption(
  request: AcpPermissionRequest,
  decision: { outcome: string },
): string | undefined {
  if (decision.outcome === "cancel") {
    return undefined;
  }
  const order =
    ACPX_DECISION_FALLBACK_ORDER[decision.outcome as keyof typeof ACPX_DECISION_FALLBACK_ORDER];
  for (const kind of order) {
    const matched = request.options.find((option) => option.kind === kind);
    if (matched) {
      return matched.optionId;
    }
  }
  return undefined;
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
    // allow_always is not among the offered options, so it must not be selected.
    ["allow-always", "cancel"],
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

  it("maps an immediate allow-always decision when the harness offers it", async () => {
    const host = createHost();
    host.requestApproval.mockResolvedValue({ decision: "allow-always" });
    const handler = createAcpPermissionHandler({ host });
    const request: AcpPermissionRequest = {
      ...executeRequest("tool-allow-always"),
      options: [
        ...executeRequest().options,
        { optionId: "always", name: "Allow always", kind: "allow_always" },
      ],
    };

    await expect(handler(request, { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "allow_always",
    });
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

  it("offers only the persistent grant the harness actually advertises", async () => {
    const host = createHost();
    host.requestApproval.mockResolvedValue({ decision: "allow-always" });
    const handler = createAcpPermissionHandler({ host, cwd: "/workspace" });
    const request = persistentAllowOnlyRequest();

    const decision = await handler(request, { signal: new AbortController().signal });

    expect(decision).toEqual({ outcome: "allow_always" });
    expect(host.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDecisions: ["allow-always", "deny"] }),
    );
    expect(selectAcpxOption(request, decision!)).toBe("always");
  });

  it("does not escalate a one-shot decision onto a persistent option", async () => {
    const host = createHost();
    host.requestApproval.mockResolvedValue({ decision: "allow-once" });
    const handler = createAcpPermissionHandler({ host });
    const request = persistentAllowOnlyRequest("tool-immediate");

    const decision = await handler(request, { signal: new AbortController().signal });

    expect(decision).toEqual({ outcome: "cancel" });
    expect(selectAcpxOption(request, decision!)).not.toBe("always");
  });

  it("does not escalate a waited one-shot decision onto a persistent option", async () => {
    const host = createHost();
    host.requestApproval.mockResolvedValue({ id: "approval-persistent" });
    host.waitForApproval.mockResolvedValue({
      decision: "allow-once",
      terminalReason: "resolved",
    });
    const handler = createAcpPermissionHandler({ host });
    const request = persistentAllowOnlyRequest("tool-waited");

    const decision = await handler(request, { signal: new AbortController().signal });

    expect(decision).toEqual({ outcome: "cancel" });
    expect(selectAcpxOption(request, decision!)).not.toBe("always");
  });

  it("offers every decision the harness advertises", async () => {
    const host = createHost();
    host.requestApproval.mockResolvedValue({ decision: "allow-once" });
    const handler = createAcpPermissionHandler({ host });
    const request: AcpPermissionRequest = {
      ...executeRequest("tool-all-kinds"),
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject", name: "Reject once", kind: "reject_once" },
        { optionId: "reject-always", name: "Reject always", kind: "reject_always" },
      ],
    };

    await handler(request, { signal: new AbortController().signal });

    expect(host.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDecisions: ["allow-once", "allow-always", "deny"] }),
    );
  });

  it("omits the deny decision when only a persistent rejection is offered", async () => {
    const host = createHost();
    host.requestApproval.mockResolvedValue({ decision: "allow-once" });
    const handler = createAcpPermissionHandler({ host });
    const request: AcpPermissionRequest = {
      ...executeRequest("tool-no-reject-once"),
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-always", name: "Reject always", kind: "reject_always" },
      ],
    };

    await expect(handler(request, { signal: new AbortController().signal })).resolves.toEqual({
      outcome: "allow_once",
    });
    expect(host.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDecisions: ["allow-once"] }),
    );
  });

  it("cancels without prompting when no decision maps onto an offered option", async () => {
    const host = createHost();
    const handler = createAcpPermissionHandler({ host });
    const request: AcpPermissionRequest = {
      ...executeRequest("tool-reject-always-only"),
      options: [{ optionId: "reject-always", name: "Reject always", kind: "reject_always" }],
    };

    const decision = await handler(request, { signal: new AbortController().signal });

    expect(decision).toEqual({ outcome: "cancel" });
    expect(host.requestApproval).not.toHaveBeenCalled();
    expect(selectAcpxOption(request, decision!)).toBeUndefined();
  });

  it("cancels a deny decision rather than escalating to a persistent rejection", async () => {
    const host = createHost();
    host.requestApproval.mockResolvedValue({ decision: "deny" });
    const handler = createAcpPermissionHandler({ host });
    const request: AcpPermissionRequest = {
      ...executeRequest("tool-deny-not-offered"),
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-always", name: "Reject always", kind: "reject_always" },
      ],
    };

    const decision = await handler(request, { signal: new AbortController().signal });

    expect(decision).toEqual({ outcome: "cancel" });
    expect(selectAcpxOption(request, decision!)).not.toBe("reject-always");
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
