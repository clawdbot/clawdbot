// Covers run-scoped approval-host binding for native hook PermissionRequest events.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunPluginApprovalHost } from "../agent-run-approval.js";
import { invokeNativeHookRelay, registerNativeHookRelay, testing } from "./native-hook-relay.js";

afterEach(() => {
  vi.restoreAllMocks();
  testing.clearNativeHookRelaysForTests();
});

async function invokePermissionRequest(relayId: string, command = "printf binding") {
  return invokeNativeHookRelay({
    provider: "codex",
    relayId,
    event: "permission_request",
    rawPayload: {
      hook_event_name: "PermissionRequest",
      cwd: "/repo",
      model: "gpt-5.4",
      tool_name: "Bash",
      tool_use_id: `native-binding-${command}`,
      tool_input: { command },
    },
  });
}

describe("native hook relay approval host binding", () => {
  it("routes PermissionRequest through the registration-scoped plugin approval host", async () => {
    const abortController = new AbortController();
    const request = vi.fn<AgentRunPluginApprovalHost["request"]>(async () => ({
      outcome: "resolved",
      decision: "allow-once",
    }));
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-host-binding",
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      signal: abortController.signal,
      approvalContext: {
        approvalHost: { plugin: { request } },
        turnSourceAccountId: "account-1",
        turnSourceChannel: "discord",
        turnSourceThreadId: "thread-1",
        turnSourceTo: "channel-1",
      },
    });

    const response = await invokePermissionRequest(relay.relayId);

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(request).toHaveBeenCalledWith({
      request: {
        pluginId: "openclaw-native-hook-relay-codex",
        title: "Codex permission request",
        description: "Tool: exec\nCwd: /repo\nModel: gpt-5.4\nCommand: printf binding",
        severity: "warning",
        toolName: "exec",
        toolCallId: "native-binding-printf binding",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        agentId: "agent-1",
        sessionKey: "agent:main:session-1",
        turnSourceAccountId: "account-1",
        turnSourceChannel: "discord",
        turnSourceThreadId: "thread-1",
        turnSourceTo: "channel-1",
      },
      timeoutMs: 120_000,
      signal: abortController.signal,
    });
  });

  it("keeps concurrent relay approvals bound to their own host", async () => {
    const firstRequest = vi.fn<AgentRunPluginApprovalHost["request"]>(async () => ({
      outcome: "resolved",
      decision: "allow-always",
    }));
    const secondRequest = vi.fn<AgentRunPluginApprovalHost["request"]>(async () => ({
      outcome: "resolved",
      decision: "deny",
    }));
    const firstRelay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-host-first",
      sessionId: "session-1",
      runId: "run-1",
      approvalContext: { approvalHost: { plugin: { request: firstRequest } } },
    });
    const secondRelay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-host-second",
      sessionId: "session-2",
      runId: "run-2",
      approvalContext: { approvalHost: { plugin: { request: secondRequest } } },
    });

    const [firstResponse, secondResponse] = await Promise.all([
      invokePermissionRequest(firstRelay.relayId, "printf first"),
      invokePermissionRequest(secondRelay.relayId, "printf second"),
    ]);

    expect(JSON.parse(firstResponse.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(JSON.parse(secondResponse.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied by user" },
      },
    });
    expect(firstRequest).toHaveBeenCalledTimes(1);
    expect(secondRequest).toHaveBeenCalledTimes(1);
  });

  it("does not reuse allow-always decisions across live relays with identical input", async () => {
    const firstRequest = vi.fn<AgentRunPluginApprovalHost["request"]>(async () => ({
      outcome: "resolved",
      decision: "allow-always",
    }));
    const secondRequest = vi.fn<AgentRunPluginApprovalHost["request"]>(async () => ({
      outcome: "resolved",
      decision: "deny",
    }));
    const firstRelay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-cache-first",
      sessionId: "session-1",
      runId: "run-1",
      approvalContext: { approvalHost: { plugin: { request: firstRequest } } },
    });
    const secondRelay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-cache-second",
      sessionId: "session-2",
      runId: "run-2",
      approvalContext: { approvalHost: { plugin: { request: secondRequest } } },
    });

    const firstResponse = await invokePermissionRequest(firstRelay.relayId, "printf shared");
    const secondResponse = await invokePermissionRequest(secondRelay.relayId, "printf shared");

    expect(JSON.parse(firstResponse.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(JSON.parse(secondResponse.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Denied by user" },
      },
    });
    expect(firstRequest).toHaveBeenCalledTimes(1);
    expect(secondRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps identical allow-always decisions cached independently per live relay", async () => {
    const firstRequest = vi.fn<AgentRunPluginApprovalHost["request"]>(async () => ({
      outcome: "resolved",
      decision: "allow-always",
    }));
    const secondRequest = vi.fn<AgentRunPluginApprovalHost["request"]>(async () => ({
      outcome: "resolved",
      decision: "allow-always",
    }));
    const firstRelay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-cache-independent-first",
      sessionId: "session-1",
      runId: "run-1",
      approvalContext: { approvalHost: { plugin: { request: firstRequest } } },
    });
    const secondRelay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-cache-independent-second",
      sessionId: "session-2",
      runId: "run-2",
      approvalContext: { approvalHost: { plugin: { request: secondRequest } } },
    });

    await invokePermissionRequest(firstRelay.relayId, "printf shared");
    await invokePermissionRequest(secondRelay.relayId, "printf shared");
    await invokePermissionRequest(firstRelay.relayId, "printf shared");
    await invokePermissionRequest(secondRelay.relayId, "printf shared");
    secondRelay.unregister();
    await invokePermissionRequest(firstRelay.relayId, "printf shared");

    expect(firstRequest).toHaveBeenCalledTimes(1);
    expect(secondRequest).toHaveBeenCalledTimes(1);
  });
});
