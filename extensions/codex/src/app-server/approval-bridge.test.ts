import {
  callGatewayTool,
  hasNativeHookRelayInvocation,
  invokeNativeHookRelay,
  runBeforeToolCallHook,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApprovalResponse, handleCodexAppServerApprovalRequest } from "./approval-bridge.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: vi.fn(),
  hasNativeHookRelayInvocation: vi.fn(() => false),
  invokeNativeHookRelay: vi.fn(),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const mockHasNativeHookRelayInvocation = vi.mocked(hasNativeHookRelayInvocation);
const mockInvokeNativeHookRelay = vi.mocked(invokeNativeHookRelay);
const mockRunBeforeToolCallHook = vi.mocked(runBeforeToolCallHook);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function gatewayCallAt(callIndex = 0) {
  const call = mockCallGatewayTool.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected gateway call ${callIndex + 1}`);
  }
  return call;
}

function gatewayRequestPayload(callIndex = 0) {
  return requireRecord(gatewayCallAt(callIndex)[2], `gateway request payload ${callIndex + 1}`);
}

function gatewayCallOptions(callIndex = 0) {
  return gatewayCallAt(callIndex)[3];
}

function gatewayCallMethod(callIndex = 0) {
  return gatewayCallAt(callIndex)[0];
}

function findApprovalEvent(
  params: EmbeddedRunAttemptParams,
  fields: {
    status?: string;
    approvalId?: string;
    command?: string;
    reason?: string;
    message?: string;
  },
) {
  const onAgentEvent = params.onAgentEvent as unknown as { mock?: { calls?: unknown[][] } };
  const calls = onAgentEvent.mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error("Expected onAgentEvent mock calls");
  }
  for (const call of calls) {
    const event = requireRecord(call[0], "agent event");
    if (event.stream !== "approval") {
      continue;
    }
    const data = requireRecord(event.data, "approval event data");
    if (
      (!fields.status || data.status === fields.status) &&
      (!fields.approvalId || data.approvalId === fields.approvalId) &&
      (!fields.command || data.command === fields.command) &&
      (!fields.reason || data.reason === fields.reason) &&
      (!fields.message || data.message === fields.message)
    ) {
      return data;
    }
  }
  throw new Error(`Expected approval event ${JSON.stringify(fields)}`);
}

function createParams(): EmbeddedRunAttemptParams {
  return {
    sessionKey: "agent:main:session-1",
    agentId: "main",
    messageChannel: "telegram",
    currentChannelId: "chat-1",
    agentAccountId: "default",
    currentThreadTs: "thread-ts",
    onAgentEvent: vi.fn(),
  } as unknown as EmbeddedRunAttemptParams;
}

describe("Codex app-server approval bridge", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
    mockHasNativeHookRelayInvocation.mockReset();
    mockHasNativeHookRelayInvocation.mockReturnValue(false);
    mockInvokeNativeHookRelay.mockReset();
    mockRunBeforeToolCallHook.mockReset();
    mockRunBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  it("routes command approvals through plugin approvals and accepts allowed commands", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-1",
        command: "pnpm test extensions/codex/src/app-server",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(gatewayCallMethod()).toBe("plugin.approval.request");
    expect(typeof gatewayCallAt(0)[1]).toBe("object");
    const requestPayload = gatewayRequestPayload();
    expect(requestPayload.pluginId).toBe("openclaw-codex-app-server");
    expect(requestPayload.title).toBe("Codex app-server command approval");
    expect(requestPayload.twoPhase).toBe(true);
    expect(requestPayload.turnSourceChannel).toBe("telegram");
    expect(requestPayload.turnSourceTo).toBe("chat-1");
    expect(gatewayCallOptions()).toEqual({ expectFinal: false });
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith({
      toolName: "exec",
      params: {
        command: "pnpm test extensions/codex/src/app-server",
        approval: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "cmd-1",
          command: "pnpm test extensions/codex/src/app-server",
        },
      },
      toolCallId: "cmd-1",
      approvalMode: "report",
      signal: undefined,
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        channelId: "chat-1",
      },
    });
    findApprovalEvent(params, { status: "pending", approvalId: "plugin:approval-1" });
    findApprovalEvent(params, { status: "approved", approvalId: "plugin:approval-1" });
  });

  it("normalizes prefixed channel targets for OpenClaw tool policy context", async () => {
    const params = createParams();
    params.messageChannel = "telegram";
    params.messageProvider = "telegram";
    params.currentChannelId = "telegram:-100123";
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-prefixed", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-prefixed", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-prefixed",
        command: "pnpm test extensions/codex/src/app-server",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          channelId: "-100123",
        }),
      }),
    );
    expect(gatewayRequestPayload().turnSourceTo).toBe("telegram:-100123");
  });

  it("denies command approvals before prompting when OpenClaw tool policy blocks", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: true,
      kind: "veto",
      deniedReason: "plugin-before-tool-call",
      reason: "blocked by policy",
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-blocked",
        command: "cat /tmp/private_key",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, { status: "denied" });
  });

  it("routes command approvals through the active native hook relay before prompting", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "blocked by native relay",
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay",
        command: "cat /tmp/private_key",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledWith({
      provider: "codex",
      relayId: "relay-1",
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        tool_name: "exec_command",
        tool_use_id: "cmd-native-relay",
        cwd: "/workspace",
        turn_id: "turn-1",
        tool_input: {
          command: "cat /tmp/private_key",
          cwd: "/workspace",
          approval: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-native-relay",
            command: "cat /tmp/private_key",
            cwd: "/workspace",
          },
          cmd: "cat /tmp/private_key",
        },
      },
    });
    findApprovalEvent(params, {
      status: "denied",
      message: "blocked by native relay",
    });
  });

  it("falls through to plugin approval when the native hook relay has no decision", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-native-noop", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-native-noop", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-noop",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, {
      status: "pending",
      approvalId: "plugin:approval-native-noop",
    });
    findApprovalEvent(params, {
      status: "approved",
      approvalId: "plugin:approval-native-noop",
    });
  });

  it("does not invoke the app-server relay when native PreToolUse already ran", async () => {
    const params = createParams();
    mockHasNativeHookRelayInvocation.mockReturnValueOnce(true);
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-native-observed", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-native-observed", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-observed",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockHasNativeHookRelayInvocation).toHaveBeenCalledWith({
      relayId: "relay-1",
      event: "pre_tool_use",
      toolUseId: "cmd-native-relay-observed",
    });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("fails closed when the native hook relay returns unreadable approval output", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: "not-json",
      stderr: "",
      exitCode: 0,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-unreadable",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "OpenClaw native hook relay returned an unreadable Codex app-server approval result.",
    });
  });

  it("fails closed when the native hook relay returns a non-deny decision", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout:
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
          },
        }) + "\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-allow",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message: "OpenClaw native hook relay returned a non-deny Codex app-server approval decision.",
    });
  });

  it("fails closed when the native hook relay exits non-zero", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: "ignored stdout",
      stderr: "blocked from stderr",
      exitCode: 1,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-exit",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message: "blocked from stderr",
    });
  });

  it("fails closed when the expected native hook relay cannot be invoked", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockRejectedValueOnce(new Error("native hook relay not found"));

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-native-relay-missing",
        command: "cat /tmp/private_key",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay: {
        relayId: "relay-missing",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "OpenClaw native hook relay unavailable for Codex app-server approval: native hook relay not found",
    });
  });

  it("keeps non-command approvals on the app-server approval route when a native relay is registered", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:file-approval", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:file-approval", decision: "allow-once" })
      .mockResolvedValueOnce({ id: "plugin:permission-approval", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:permission-approval", decision: "deny" });
    const nativeHookRelay = {
      relayId: "relay-1",
      allowedEvents: ["pre_tool_use" as const],
    };

    await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-native-relay-registered",
        reason: "needs write access",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay,
    });
    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "permission-native-relay-registered",
        permissions: {
          network: { allowHosts: ["example.com"] },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      nativeHookRelay,
    });

    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("denies command approvals when OpenClaw tool policy rewrites params", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: false,
      params: {
        command: "echo rewritten",
        approval: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "cmd-rewritten",
          command: "echo rewritten",
        },
      },
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-rewritten",
        command: "cat /tmp/private_key",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
    });
  });

  it("denies command approvals when OpenClaw tool policy requires approval", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-approval",
      reason: "Plugin approval required",
    });
    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-needs-approval",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message: "Plugin approval required",
    });
  });

  it("describes command approvals from parsed command actions when available", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-actions", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-actions", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-actions",
        command: "bash -lc 'pnpm test extensions/codex'",
        commandActions: [{ command: "pnpm test extensions/codex" }],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const requestPayload = gatewayRequestPayload();
    expect(String(requestPayload.description)).toContain("Command: pnpm test extensions/codex");
    expect(String(requestPayload.description)).not.toContain("bash -lc");
    expect(mockRunBeforeToolCallHook.mock.calls.at(0)?.[0]).toMatchObject({
      toolName: "exec",
      params: {
        command: "bash -lc 'pnpm test extensions/codex'",
      },
    });
    findApprovalEvent(params, { command: "pnpm test extensions/codex" });
  });

  it("describes command approval permission and policy amendments", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-command-permissions", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-command-permissions",
        decision: "allow-always",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-permissions",
        command: "npm install",
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            write: ["/"],
          },
        },
        proposedExecpolicyAmendment: ["npm install"],
        proposedNetworkPolicyAmendments: [{ host: "registry.npmjs.org", action: "allow" }],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("Command: npm install");
    expect(description).toContain("Additional permissions: network, fileSystem");
    expect(description).toContain("High-risk targets: network access, filesystem root");
    expect(description).toContain("Network enabled: true");
    expect(description).toContain("File system write: /");
    expect(description).toContain("Proposed exec policy: npm install");
    expect(description).toContain("Proposed network policy: allow registry.npmjs.org");
  });

  it("keeps command approval permission details visible after long command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-long-command-permissions", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-long-command-permissions",
        decision: "allow-always",
      });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-long-permissions",
        command: `${"npm install ".repeat(500)} --unsafe-perm`,
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            write: ["/"],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("[preview truncated or unsafe content omitted]");
    expect(description).toContain("Additional permissions: network, fileSystem");
    expect(description).toContain("High-risk targets: network access, filesystem root");
  });

  it("sanitizes command previews before forwarding approval text and events", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-sanitized-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-sanitized-command", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-sanitized",
        command: ["pnpm", "test\n--watch", "\u001b[31mextensions/codex/src/app-server\u001b[0m"],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(gatewayRequestPayload().description).toBe(
      "Command: pnpm test --watch extensions/codex/src/app-server\nSession: agent:main:session-1",
    );
    findApprovalEvent(params, {
      status: "pending",
      command: "pnpm test --watch extensions/codex/src/app-server",
    });
  });

  it("escapes command approval previews before forwarding approval text and events", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-escaped-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-escaped-command", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-escaped",
        command: "printf '<@U123> [trusted](https://evil) @here'",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain(
      "printf '&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here'",
    );
    expect(description).not.toContain("<@U123>");
    expect(description).not.toContain("[trusted](https://evil)");
    expect(description).not.toContain("@here");
    findApprovalEvent(params, {
      command: "printf '&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here'",
    });
  });

  it("preserves visible OSC-8 link labels in command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-osc", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-osc", decision: "allow-once" });
    const esc = "\u001b";

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-osc",
        command: `prefix ${esc}]8;;https://example.com${esc}\\VISIBLE${esc}]8;;${esc}\\ suffix`,
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(gatewayRequestPayload().description).toBe(
      "Command: prefix VISIBLE suffix\nSession: agent:main:session-1",
    );
    findApprovalEvent(params, { command: "prefix VISIBLE suffix" });
  });

  it("strips bidi and invisible formatting controls from command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-bidi", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-bidi", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-bidi",
        command: "echo safe\u202e cod.exe\u2066 hidden\u2069 \ufeffdone\u{e0100}",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(gatewayRequestPayload().description).toBe(
      "Command: echo safe cod.exe hidden done\nSession: agent:main:session-1",
    );
    findApprovalEvent(params, { command: "echo safe cod.exe hidden done" });
  });

  it("marks oversized unsafe command previews as omitted", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-omitted-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-omitted-command", decision: "allow-once" });
    const esc = "\u001b";
    const oversizedPrefix = `${esc}]8;;https://example.com${esc}\\`.repeat(300);

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-omitted",
        command: [oversizedPrefix, "TAIL"],
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(gatewayRequestPayload().description).toBe(
      "Command: [preview truncated or unsafe content omitted]\nSession: agent:main:session-1",
    );
    const omittedEvent = findApprovalEvent(params, {});
    expect(omittedEvent.commandPreviewOmitted).toBe(true);
  });

  it("marks clipped command previews even when a safe prefix remains", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-clipped-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-clipped-command", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-clipped",
        command: `${"a".repeat(5000)} tail`,
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("[preview truncated or unsafe content omitted]");
    const omittedEvent = findApprovalEvent(params, {});
    expect(omittedEvent.commandPreviewOmitted).toBe(true);
  });

  it("does not trust request-time decisions for two-phase command approvals", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({
        id: "plugin:approval-untrusted",
        status: "accepted",
        decision: "allow-always",
      })
      .mockResolvedValueOnce({ id: "plugin:approval-untrusted", decision: "deny" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-untrusted",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, {
      status: "denied",
      approvalId: "plugin:approval-untrusted",
    });
  });

  it("only treats own null data-property request decisions as no-route", async () => {
    const params = createParams();
    const inheritedDecisionResult = Object.assign(Object.create({ decision: null }), {
      id: "plugin:approval-inherited",
      status: "accepted",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce(inheritedDecisionResult)
      .mockResolvedValueOnce({ id: "plugin:approval-inherited", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-inherited",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("does not invoke request-time decision accessors", async () => {
    const params = createParams();
    const requestResult = {
      id: "plugin:approval-accessor",
      status: "accepted",
      get decision() {
        throw new Error("decision getter must not run");
      },
    };
    mockCallGatewayTool
      .mockResolvedValueOnce(requestResult)
      .mockResolvedValueOnce({ id: "plugin:approval-accessor", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-accessor",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
  });

  it("does not fail when request-time decision descriptors throw", async () => {
    const params = createParams();
    const requestResult = new Proxy(
      { id: "plugin:approval-proxy", status: "accepted" },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "decision") {
            throw new Error("descriptor trap must not fail approval");
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    mockCallGatewayTool
      .mockResolvedValueOnce(requestResult)
      .mockResolvedValueOnce({ id: "plugin:approval-proxy", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-proxy",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "accept" });
  });

  it("fails closed when no approval route is available", async () => {
    const params = createParams();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-2",
      decision: null,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-1",
        reason: "needs write access",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
    findApprovalEvent(params, { status: "unavailable", reason: "needs write access" });
  });

  it("sanitizes reason previews before forwarding approval text and events", async () => {
    const params = createParams();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-sanitized-reason",
      decision: null,
    });

    await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-sanitized",
        reason: "needs write access\nfor \u001b[31m/tmp\u001b[0m\tplease",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(gatewayRequestPayload().description).toBe(
      "Reason: needs write access for /tmp please\nSession: agent:main:session-1",
    );
    findApprovalEvent(params, {
      status: "unavailable",
      reason: "needs write access for /tmp please",
    });
  });

  it("fails closed for unsupported native approval methods without requesting plugin approval", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "future/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "future-1",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      decision: "decline",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(params.onAgentEvent).not.toHaveBeenCalled();
  });
  it("labels permission approvals explicitly with permission detail", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-3", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-3", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-1",
        permissions: {
          network: { allowHosts: ["example.com", "*.internal"] },
          fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      permissions: {
        network: { allowHosts: ["example.com", "*.internal"] },
        fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
      },
      scope: "turn",
    });
    expect(gatewayCallMethod()).toBe("plugin.approval.request");
    expect(typeof gatewayCallAt(0)[1]).toBe("object");
    const requestPayload = gatewayRequestPayload();
    expect(requestPayload.title).toBe("Codex app-server permission approval");
    expect(requestPayload.toolName).toBe("codex_permission_approval");
    const description = String(requestPayload.description);
    expect(description).toContain("Permissions: network, fileSystem");
    expect(gatewayCallOptions()).toEqual({ expectFinal: false });
    expect(description).toContain("Network allowHosts: example.com, *.internal");
    expect(description).toContain("File system roots: /; writePaths: ~");
    expect(description).toContain(
      "High-risk targets: wildcard hosts, private-network wildcards, filesystem root",
    );
    expect(description).not.toContain("agent:main:session-1");
  });

  it("keeps permission detail bounded with truncated and compacted target samples", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-4", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-4", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-2",
        permissions: {
          network: {
            allowHosts: [
              "https://secret-token@example.com/private",
              "*.internal",
              "very-long-service-name.example.corp",
              "third.example.com",
            ],
          },
          fileSystem: {
            roots: ["/", "/workspace/project", "/Users/simone/Documents"],
            readPaths: ["/Users/simone/.ssh/id_rsa", "/etc/hosts", "/var/log/system.log"],
            writePaths: ["/tmp/output", "/var/log/app", "/home/simone/private"],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description.length).toBeLessThanOrEqual(700);
    expect(description).toContain("example.com");
    expect(description).not.toContain("secret-token");
    expect(description).not.toContain("simone");
    expect(description).toContain("*.internal");
    expect(description).toContain("/workspace/project");
    expect(description).toContain("High-risk targets:");
    expect(description).toContain("readPaths: ~/.ssh/id_rsa, /etc/hosts");
  });

  it("describes current protocol network and filesystem permission grants", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-current-permissions", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-current-permissions", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-current",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/Users/simone/.ssh/id_rsa"],
            write: ["/"],
            entries: [
              { path: "/workspace/project", access: "read" },
              { path: "/tmp/output", access: "write" },
              { path: "/ignored", access: "none" },
            ],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/Users/simone/.ssh/id_rsa"],
          write: ["/"],
          entries: [
            { path: "/workspace/project", access: "read" },
            { path: "/tmp/output", access: "write" },
            { path: "/ignored", access: "none" },
          ],
        },
      },
      scope: "turn",
    });
    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("Network enabled: true");
    expect(description).toContain("File system read: ~/.ssh/id_rsa; write: /");
    expect(description).toContain("entries: read /workspace/project, write /tmp/output (+1 more)");
    expect(description).toContain("High-risk targets: network access, filesystem root");
  });

  it("compacts Windows home paths in permission descriptions", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-windows-home", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-windows-home", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-windows-home",
        permissions: {
          fileSystem: {
            roots: ["C:/Users/alice"],
            readPaths: ["C:\\Users\\alice\\.ssh\\id_rsa", "c:/users/bob/project"],
          },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("File system roots: ~; readPaths: ~/.ssh/id_rsa, ~/project");
    expect(description).not.toContain("High-risk targets");
  });

  it("strips terminal and invisible controls from permission descriptions", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-permission-controls", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-permission-controls", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "perm-controls",
        permissions: {
          network: { allowHosts: ["exa\u009b31mmple.com", "safe\u202e.example.com"] },
          fileSystem: { roots: ["/tmp/\u001b[31mproject\u001b[0m"] },
        },
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("example.com");
    expect(description).toContain("safe .example.com");
    expect(description).toContain("/tmp/project");
    expect(description).not.toContain("\u009b");
    expect(description).not.toContain("\u202e");
    expect(description).not.toContain("\u001b");
  });

  it("ignores approval requests that are missing explicit thread or turn ids", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        itemId: "cmd-2",
        command: "pnpm test",
      },
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(params.onAgentEvent).not.toHaveBeenCalled();
  });

  it("maps app-server approval response families separately", () => {
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["accept"] },
        "approved-session",
      ),
    ).toEqual({
      decision: "accept",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        {
          availableDecisions: [
            "accept",
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: {
                  permissions: [{ permission: "allow", command: ["pnpm", "test"] }],
                },
              },
            },
          ],
        },
        "approved-session",
      ),
    ).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: {
            permissions: [{ permission: "allow", command: ["pnpm", "test"] }],
          },
        },
      },
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        {
          availableDecisions: [
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  domain: "registry.npmjs.org",
                },
              },
            },
          ],
        },
        "approved-session",
      ),
    ).toEqual({
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            domain: "registry.npmjs.org",
          },
        },
      },
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["decline"] },
        "approved-once",
      ),
    ).toEqual({
      decision: "decline",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["decline"] },
        "approved-session",
      ),
    ).toEqual({
      decision: "decline",
    });
    expect(
      buildApprovalResponse("item/commandExecution/requestApproval", undefined, "approved-once"),
    ).toEqual({
      decision: "accept",
    });
    expect(
      buildApprovalResponse("item/commandExecution/requestApproval", undefined, "approved-session"),
    ).toEqual({
      decision: "acceptForSession",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["cancel"] },
        "approved-once",
      ),
    ).toEqual({
      decision: "cancel",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["accept", "cancel"] },
        "denied",
      ),
    ).toEqual({
      decision: "cancel",
    });
    expect(
      buildApprovalResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["decline"] },
        "cancelled",
      ),
    ).toEqual({
      decision: "decline",
    });
    expect(buildApprovalResponse("item/fileChange/requestApproval", undefined, "denied")).toEqual({
      decision: "decline",
    });
    expect(
      buildApprovalResponse(
        "item/permissions/requestApproval",
        {
          permissions: {
            network: { allowHosts: ["example.com"] },
            fileSystem: null,
          },
        },
        "approved-once",
      ),
    ).toEqual({
      permissions: { network: { allowHosts: ["example.com"] } },
      scope: "turn",
    });
    expect(buildApprovalResponse("future/requestApproval", undefined, "approved-once")).toEqual({
      decision: "decline",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    });
  });
});
