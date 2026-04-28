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
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
    expect(onResolution).toHaveBeenCalledTimes(1);
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.CANCELLED);
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
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
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
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        pluginId: "trusted-policy",
        title: "Policy approval",
      }),
      { expectFinal: false },
    );
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
    expect(runBeforeToolCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { command: "patched" },
      }),
      expect.any(Object),
    );
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
