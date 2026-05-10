import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { PluginApprovalResolutions } from "../plugins/types.js";
import { runBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(),
  };
});
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockCallGatewayTool = vi.mocked(callGatewayTool);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireApprovalRequestCall(label: string): {
  timeoutParams: Record<string, unknown>;
  request: Record<string, unknown>;
  options: Record<string, unknown>;
} {
  const call = mockCallGatewayTool.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  expect(call[0]).toBe("plugin.approval.request");
  return {
    timeoutParams: requireRecord(call[1], `${label} timeout params`),
    request: requireRecord(call[2], `${label} request`),
    options: requireRecord(call[3], `${label} options`),
  };
}

function requireBeforeToolCall(
  mock: ReturnType<typeof vi.fn<HookRunner["runBeforeToolCall"]>>,
  label: string,
): Parameters<HookRunner["runBeforeToolCall"]> {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

describe("runBeforeToolCallHook — embedded mode approvals", () => {
  let hookRunner: Pick<HookRunner, "hasHooks" | "runBeforeToolCall">;
  let runBeforeToolCallMock: ReturnType<typeof vi.fn<HookRunner["runBeforeToolCall"]>>;

  beforeEach(() => {
    runBeforeToolCallMock = vi.fn<HookRunner["runBeforeToolCall"]>();
    hookRunner = {
      hasHooks: vi.fn<HookRunner["hasHooks"]>().mockReturnValue(true),
      runBeforeToolCall: runBeforeToolCallMock,
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as HookRunner);
    mockCallGatewayTool.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterEach(() => {
    setEmbeddedMode(false);
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("blocks approval-required tools in embedded mode when no gateway approval route exists", async () => {
    setEmbeddedMode(true);
    const onResolution = vi.fn();

    runBeforeToolCallMock.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Needs approval",
        description: "Test approval request",
        severity: "info",
        onResolution,
      },
      params: { adjusted: true },
    });
    mockCallGatewayTool.mockRejectedValueOnce(new Error("gateway unavailable"));

    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-1",
    });

    expect(result).toEqual({
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-approval",
      reason: "Plugin approval required (gateway unavailable)",
      params: { command: "ls" },
    });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      {
        timeoutMs: 130_000,
      },
      {
        agentId: undefined,
        allowedDecisions: undefined,
        description: "Test approval request",
        pluginId: "test-plugin",
        sessionKey: undefined,
        severity: "info",
        timeoutMs: 120_000,
        title: "Needs approval",
        toolCallId: "call-1",
        toolName: "exec",
        twoPhase: true,
      },
      { expectFinal: false },
    );
    expect(onResolution).toHaveBeenCalledTimes(1);
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.CANCELLED);
  });

  it("reports approval-required tools without opening an approval request", async () => {
    runBeforeToolCallMock.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Needs approval",
        description: "Review before running",
        severity: "info",
      },
      params: { adjusted: true },
    });

    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-report",
      approvalMode: "report",
    });

    expect(result).toEqual({
      blocked: true,
      kind: "failure",
      deniedReason: "plugin-approval",
      reason: "Review before running",
      params: { command: "ls" },
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("sends approval to gateway when NOT in embedded mode", async () => {
    setEmbeddedMode(false);

    runBeforeToolCallMock.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Needs approval",
        description: "Test approval request",
        severity: "info",
        timeoutMs: 5_000,
      },
    });

    mockCallGatewayTool.mockResolvedValue({});

    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-2",
    });

    expect(result.blocked).toBe(true);
    const approvalCall = requireApprovalRequestCall("non-embedded approval request");
    expect(approvalCall.timeoutParams.timeoutMs).toBe(15_000);
    expect(approvalCall.request.pluginId).toBe("test-plugin");
    expect(approvalCall.request.title).toBe("Needs approval");
    expect(approvalCall.request.description).toBe("Test approval request");
    expect(approvalCall.request.severity).toBe("info");
    expect(approvalCall.request.toolName).toBe("exec");
    expect(approvalCall.request.toolCallId).toBe("call-2");
    expect(approvalCall.request.timeoutMs).toBe(5_000);
    expect(approvalCall.request.twoPhase).toBe(true);
    expect(approvalCall.options.expectFinal).toBe(false);
  });

  it("preserves hook params override after an approval allow decision", async () => {
    setEmbeddedMode(true);

    runBeforeToolCallMock.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Approval",
        description: "desc",
        severity: "info",
      },
      params: { extraField: "injected" },
    });
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-3",
      decision: PluginApprovalResolutions.ALLOW_ONCE,
    });

    const result = await runBeforeToolCallHook({
      toolName: "write",
      params: { path: "/tmp/test.txt", content: "hello" },
      toolCallId: "call-3",
    });

    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.params).toEqual({
        path: "/tmp/test.txt",
        content: "hello",
        extraField: "injected",
      });
    }
  });

  it("routes trusted policy approval through the same approval gate as before_tool_call hooks", async () => {
    setEmbeddedMode(true);
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-policy",
        pluginName: "Trusted Policy",
        source: "test",
        policy: {
          id: "approval-policy",
          description: "Approval policy",
          evaluate: () => ({
            requireApproval: {
              pluginId: "trusted-policy",
              title: "Policy approval",
              description: "Policy requested approval",
            },
          }),
        },
      },
    ];
    setActivePluginRegistry(registry);
    (hookRunner.hasHooks as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-policy",
      decision: PluginApprovalResolutions.ALLOW_ONCE,
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "deploy" },
      toolCallId: "call-policy",
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toEqual({ blocked: false, params: { command: "deploy" } });
    const approvalCall = requireApprovalRequestCall("trusted policy approval request");
    expect(approvalCall.timeoutParams.timeoutMs).toBe(130_000);
    expect(approvalCall.request.pluginId).toBe("trusted-policy");
    expect(approvalCall.request.title).toBe("Policy approval");
    expect(approvalCall.request.description).toBe("Policy requested approval");
    expect(approvalCall.request.toolName).toBe("exec");
    expect(approvalCall.request.toolCallId).toBe("call-policy");
    expect(approvalCall.request.agentId).toBe("main");
    expect(approvalCall.request.sessionKey).toBe("main");
    expect(approvalCall.request.twoPhase).toBe(true);
    expect(approvalCall.options.expectFinal).toBe(false);
    expect(runBeforeToolCallMock).not.toHaveBeenCalled();
  });

  it("preserves trusted policy params when before_tool_call hooks leave params unchanged", async () => {
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-policy",
        pluginName: "Trusted Policy",
        source: "test",
        policy: {
          id: "param-policy",
          description: "Param policy",
          evaluate: () => ({ params: { command: "patched" } }),
        },
      },
    ];
    setActivePluginRegistry(registry);
    runBeforeToolCallMock.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "original", cwd: "/tmp" },
      toolCallId: "call-policy-params",
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toEqual({ blocked: false, params: { command: "patched" } });
    const [hookParams, hookContext] = requireBeforeToolCall(
      runBeforeToolCallMock,
      "before_tool_call invocation",
    );
    expect(hookParams.params).toEqual({ command: "patched" });
    expect(hookParams.toolName).toBe("exec");
    expect(hookParams.toolCallId).toBe("call-policy-params");
    expect(typeof hookContext).toBe("object");
  });

  it("keeps original params after an approval allow decision without overrides", async () => {
    setEmbeddedMode(true);

    runBeforeToolCallMock.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Approval",
        description: "desc",
        severity: "info",
      },
    });
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-4",
      decision: PluginApprovalResolutions.ALLOW_ONCE,
    });

    const result = await runBeforeToolCallHook({
      toolName: "read",
      params: { file: "/etc/hosts" },
      toolCallId: "call-4",
    });

    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.params).toEqual({ file: "/etc/hosts" });
    }
  });
});
