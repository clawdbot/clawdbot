import { afterEach, describe, expect, it, vi } from "vitest";
import { callGatewayTool } from "../tools/gateway.js";
import { invokeNativeHookRelay, registerNativeHookRelay, testing } from "./native-hook-relay.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(() => {
  vi.restoreAllMocks();
  mockCallGatewayTool.mockReset();
  testing.clearNativeHookRelaysForTests();
});

describe("native hook relay approval wait handling", () => {
  it("explains how to unblock an MCP tool when approval times out", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-timeout", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-timeout", decision: null });
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    const result = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        tool_name: "mcp__memory__create_entities",
        tool_input: { entities: [] },
      },
    });

    expect(result.stdout).toContain("MCP tool approval timed out");
    expect(result.stdout).toContain("mcp.servers.<id>.codex.defaultToolsApprovalMode");
  });

  it("defers an MCP tool when no approval id is created", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ status: "unavailable" });
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "mcp__memory__create_entities",
          tool_input: { entities: [] },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
  });

  it("defers an MCP tool when waitDecision returns a different approval id", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-request", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:other-approval", decision: null });
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "mcp__memory__create_entities",
          tool_input: { entities: [] },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("defers when waitDecision reports a stale approval id", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-stale", status: "accepted" })
      .mockRejectedValueOnce(new Error("approval expired or not found"));
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "cat /tmp/private-key" },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });
});
