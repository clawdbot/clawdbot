import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callGatewayTool } from "../tools/gateway.js";
import { invokeNativeHookRelay, registerNativeHookRelay, testing } from "./native-hook-relay.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const approvalMocks = vi.hoisted(() => ({ loadExecApprovalsReadOnly: vi.fn() }));

vi.mock("../../infra/exec-approvals-store.js", () => ({
  loadExecApprovalsReadOnly: approvalMocks.loadExecApprovalsReadOnly,
}));

beforeEach(() => {
  approvalMocks.loadExecApprovalsReadOnly.mockReset().mockReturnValue({ version: 1, agents: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  mockCallGatewayTool.mockReset();
  testing.clearNativeHookRelaysForTests();
});

describe("native hook relay approval wait handling", () => {
  it("defers all native MCP names to Codex when the exact agent has a prepared durable grant", async () => {
    const grant = { server: "raw-server_", tool: "_raw.tool", source: "allow-always", addedAt: 1 };
    approvalMocks.loadExecApprovalsReadOnly.mockReturnValue({
      version: 1,
      agents: { main: { mcpTools: [grant] }, "*": { mcpTools: [grant] } },
    });
    mockCallGatewayTool.mockResolvedValue({ id: "unexpected-approval", decision: "deny" });
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "main",
      sessionId: "session-1",
      runId: "run-1",
    });
    approvalMocks.loadExecApprovalsReadOnly.mockReturnValue({ version: 1, agents: {} });
    for (const toolName of [
      "mcp__raw_server__raw_tool",
      "mcp__hashed_a13e__shortened",
      "mcp__codex_apps__write",
    ]) {
      for (const query of ["first", "different arguments"]) {
        const result = await invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "permission_request",
          rawPayload: {
            hook_event_name: "PermissionRequest",
            tool_name: toolName,
            tool_input: { query },
          },
        });
        expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
      }
    }
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(approvalMocks.loadExecApprovalsReadOnly).toHaveBeenCalledTimes(1);
    relay.unregister();
    approvalMocks.loadExecApprovalsReadOnly.mockReturnValue({
      version: 1,
      agents: { "*": { mcpTools: [grant] } },
    });
    const nextRelay = registerNativeHookRelay({
      provider: "codex",
      agentId: "main",
      sessionId: "session-2",
      runId: "run-2",
    });
    const result = await invokeNativeHookRelay({
      provider: "codex",
      relayId: nextRelay.relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        tool_name: "mcp__raw_server__raw_tool",
        tool_input: {},
      },
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior).toBe("deny");
  });

  it.each(
    [
      { fullPermission: true, mode: undefined, decision: "defer" },
      { fullPermission: false, mode: undefined, decision: "deny" },
      { fullPermission: true, mode: "auto" as const, decision: "defer" },
      { fullPermission: true, mode: "prompt" as const, decision: "defer" },
      { fullPermission: false, mode: "approve" as const, decision: "defer" },
      {
        fullPermission: true,
        mode: "prompt" as const,
        serverName: "linear-team",
        nativeServerName: "linear_team",
        decision: "defer",
      },
      { fullPermission: true, mode: "prompt" as const, serverName: "Linear", decision: "defer" },
      {
        fullPermission: true,
        mode: "prompt" as const,
        serverName: "team__linear",
        nativeServerName: "team__linear",
        decision: "defer",
      },
      {
        fullPermission: true,
        mode: undefined,
        projectedMode: "prompt" as const,
        decision: "defer",
      },
      {
        fullPermission: true,
        mode: "approve" as const,
        projectedMode: "prompt" as const,
        decision: "defer",
      },
      {
        fullPermission: false,
        mode: "prompt" as const,
        nativeServerName: "linear_abc12345",
        decision: "defer",
      },
      { fullPermission: false, mode: "prompt" as const, serverName: "linear_", decision: "defer" },
      {
        fullPermission: false,
        mode: "prompt" as const,
        nativeServerName: "Linear",
        decision: "defer",
      },
      { fullPermission: true, mode: undefined, nativeServerName: "codex_apps", decision: "defer" },
    ].map((scenario) => ({
      serverName: scenario.serverName ?? "linear",
      nativeServerName: scenario.nativeServerName ?? "linear",
      projectedMode: "projectedMode" in scenario ? scenario.projectedMode : undefined,
      fullPermission: scenario.fullPermission,
      mode: scenario.mode,
      decision: scenario.decision,
    })),
  )(
    "uses full=$fullPermission with server $serverName mode=$mode projected=$projectedMode for MCP approval",
    async ({ fullPermission, mode, decision, serverName, nativeServerName, projectedMode }) => {
      mockCallGatewayTool.mockResolvedValue({ id: "approval-1", decision: "deny" });
      const registration = {
        provider: "codex" as const,
        sessionId: "session-1",
        runId: "run-1",
        autoApproveMcpTools: fullPermission,
        projectedMcpServers: projectedMode
          ? { [serverName]: { default_tools_approval_mode: projectedMode } }
          : undefined,
        config: {
          mcp: {
            servers: {
              [serverName]: {
                url: "https://mcp.example.test",
                codex: { defaultToolsApprovalMode: mode },
              },
            },
          },
        },
      };
      const relay = registerNativeHookRelay(registration);
      const result = await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: `mcp__${nativeServerName}__list_issues`,
          tool_input: { query: "first" },
        },
      });

      if (decision === "defer") {
        expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
      } else {
        expect(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior).toBe(decision);
      }
      expect(mockCallGatewayTool).toHaveBeenCalledTimes(decision === "defer" ? 0 : 1);
    },
  );

  it.each([null, "deny"])("explains how to unblock an MCP tool after %s", async (decision) => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-timeout", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-timeout", decision });
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

    expect(result.stdout).toContain(
      decision === null ? "MCP tool approval timed out" : "Denied by user",
    );
    expect(result.stdout).toContain("openclaw mcp configure memory --approval approve");
  });

  it.each(["arguments", "cwd", "elapsed time", "shortened name", "tool", "server", "case"])(
    "scopes MCP allow-always after changed %s",
    async (change) => {
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "approval-1", decision: "allow-always" })
        .mockResolvedValueOnce({ id: "approval-2", decision: "deny" });
      const now = Date.now();
      const relay = registerNativeHookRelay({
        provider: "codex",
        sessionId: "session-1",
        runId: "run-1",
        ttlMs: 60 * 60_000,
      });
      const invoke = (cwd: string, query: string, toolName = "mcp__linear__list_issues") =>
        invokeNativeHookRelay({
          provider: "codex",
          relayId: relay.relayId,
          event: "permission_request",
          rawPayload: {
            hook_event_name: "PermissionRequest",
            cwd,
            tool_name: toolName,
            tool_input: { query },
          },
        });
      const initialToolName = change === "shortened name" ? "mcp__list_issues" : undefined;
      await invoke("/repo", "first", initialToolName);
      if (change === "elapsed time" || change === "shortened name") {
        vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
      }
      const result = await invoke(
        change === "cwd" ? "/other-repo" : "/repo",
        change === "arguments" ? "second" : "first",
        change === "tool"
          ? "mcp__linear__get_issue"
          : change === "case"
            ? "mcp__linear__List_Issues"
            : change === "server"
              ? "mcp__other__list_issues"
              : initialToolName,
      );

      const sameTool = change !== "tool" && change !== "server" && change !== "case";
      expect(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior).toBe(
        sameTool ? "allow" : "deny",
      );
      expect(mockCallGatewayTool).toHaveBeenCalledTimes(sameTool ? 1 : 2);
    },
  );

  it.each(["unregister", "replace"])("forgets MCP allow-always on relay %s", async (disposal) => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1", decision: "allow-always" })
      .mockResolvedValueOnce({ id: "approval-2", decision: "deny" });
    const registration = {
      provider: "codex" as const,
      relayId: "mcp-approval-lifetime",
      sessionId: "session-1",
      runId: "run-1",
    };
    const relay = registerNativeHookRelay(registration);
    const invoke = () =>
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "mcp__linear__list_issues",
          tool_input: { query: "first" },
        },
      });
    await invoke();
    if (disposal === "unregister") {
      relay.unregister();
    }
    registerNativeHookRelay({ ...registration, runId: "run-2" });
    const result = await invoke();

    expect(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior).toBe("deny");
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(2);
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
