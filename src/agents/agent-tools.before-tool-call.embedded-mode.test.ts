/**
 * Tests before_tool_call approval behavior in embedded mode.
 * Ensures gateway approval requests use non-blocking semantics and preserve
 * plugin hook decisions.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import type { HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { PluginApprovalResolutions } from "../plugins/types.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
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

const agentToolsWarnSpy = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      // Capture agents/tools warnings so the deprecation signal is assertable.
      return subsystem === "agents/tools" ? { ...logger, warn: agentToolsWarnSpy } : logger;
    },
  };
});

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
    resetGlobalHookRunner();
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
    clearRuntimeConfigSnapshot();
    setEmbeddedPluginApprovalBroker(null);
    setEmbeddedMode(false);
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetGlobalHookRunner();
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
      disposition: "failed",
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

  it("resolves embedded approvals through the in-process TUI broker", async () => {
    setEmbeddedMode(true);
    const broker = new EmbeddedPluginApprovalBroker();
    setEmbeddedPluginApprovalBroker(broker);
    runBeforeToolCallMock.mockResolvedValue({
      params: { action: "apply", proposal_id: "weather" },
    });

    const resultPromise = runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "apply", proposal_id: "weather" },
      toolCallId: "call-skill-local",
      ctx: {
        agentId: "main",
        sessionKey: "agent:main:main",
        config: {
          skills: {
            workshop: {
              approvalPolicy: "pending",
            },
          },
        },
      },
    });
    await vi.waitFor(() => {
      expect(broker.listPending()).toHaveLength(1);
    });
    const approval = expectDefined(
      broker.listPending()[0],
      "broker.listPending()[0] test invariant",
    );
    expect(approval?.request.toolName).toBe("skill_workshop");
    expect(broker.resolve(approval?.id, "allow-once")).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      blocked: false,
      params: { action: "apply", proposal_id: "weather" },
      approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("does not allow embedded approvals when the broker stops", async () => {
    setEmbeddedMode(true);
    const broker = new EmbeddedPluginApprovalBroker();
    setEmbeddedPluginApprovalBroker(broker);
    const onResolution = vi.fn();
    runBeforeToolCallMock.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Needs approval",
        description: "Test approval request",
        severity: "info",
        timeoutBehavior: "allow",
        onResolution,
      },
      params: { adjusted: true },
    });

    const resultPromise = runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "apply", proposal_id: "weather" },
      toolCallId: "call-skill-stop",
      ctx: { agentId: "main", sessionKey: "agent:main:main" },
    });
    await vi.waitFor(() => {
      expect(broker.listPending()).toHaveLength(1);
    });

    broker.stop(new Error("local TUI stopped"));

    await expect(resultPromise).resolves.toMatchObject({
      blocked: true,
      deniedReason: "plugin-approval",
    });
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.CANCELLED);
  });

  it("blocks embedded approvals on timeout even when deprecated timeoutBehavior is allow", async () => {
    setEmbeddedMode(true);
    const broker = new EmbeddedPluginApprovalBroker();
    setEmbeddedPluginApprovalBroker(broker);
    const onResolution = vi.fn();
    runBeforeToolCallMock.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Needs approval",
        description: "Test approval request",
        timeoutMs: 1,
        timeoutBehavior: "allow",
        onResolution,
      },
      params: { adjusted: true },
    });

    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-skill-timeout",
      ctx: { agentId: "main", sessionKey: "agent:main:main" },
    });

    expect(result).toEqual({
      blocked: true,
      kind: "failure",
      disposition: "timed_out",
      deniedReason: "plugin-approval",
      reason: "Approval timed out",
      params: { command: "ls" },
    });
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.TIMEOUT);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("warns once per plugin when deprecated timeoutBehavior allow arrives, still failing closed", async () => {
    agentToolsWarnSpy.mockClear();
    setEmbeddedMode(true);
    const broker = new EmbeddedPluginApprovalBroker();
    setEmbeddedPluginApprovalBroker(broker);
    runBeforeToolCallMock.mockResolvedValue({
      requireApproval: {
        pluginId: "deprecated-timeout-plugin",
        title: "Needs approval",
        description: "Test approval request",
        timeoutMs: 1,
        timeoutBehavior: "allow",
      },
    });

    const first = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-deprecated-warn-1",
      ctx: { agentId: "main", sessionKey: "agent:main:main" },
    });
    const second = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-deprecated-warn-2",
      ctx: { agentId: "main", sessionKey: "agent:main:main" },
    });

    expect(first).toMatchObject({ blocked: true, disposition: "timed_out" });
    expect(second).toMatchObject({ blocked: true, disposition: "timed_out" });
    const deprecationWarnings = agentToolsWarnSpy.mock.calls.filter(
      ([message]) =>
        typeof message === "string" &&
        message.includes("deprecated-timeout-plugin") &&
        message.includes("timeoutBehavior"),
    );
    expect(deprecationWarnings).toHaveLength(1);
  });

  it("blocks embedded allow decisions excluded by the request", async () => {
    setEmbeddedMode(true);
    const broker = new EmbeddedPluginApprovalBroker();
    setEmbeddedPluginApprovalBroker(broker);
    vi.spyOn(broker, "request").mockResolvedValue({
      id: "plugin:unexpected-decision",
      decision: PluginApprovalResolutions.ALLOW_ALWAYS,
    });
    const onResolution = vi.fn();
    runBeforeToolCallMock.mockResolvedValue({
      requireApproval: {
        pluginId: "test-plugin",
        title: "Restricted approval",
        description: "Allow once only",
        allowedDecisions: ["allow-once", "deny"],
        onResolution,
      },
      params: { adjusted: true },
    });

    const result = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: "unsafe-command" },
      toolCallId: "call-restricted-approval",
      ctx: { agentId: "main", sessionKey: "agent:main:main" },
    });

    expect(result).toEqual({
      blocked: true,
      kind: "failure",
      disposition: "timed_out",
      deniedReason: "plugin-approval",
      reason: "Approval timed out",
      params: { command: "unsafe-command" },
    });
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.TIMEOUT);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
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
      disposition: "blocked",
      deniedReason: "plugin-approval",
      reason: "Review before running",
      params: { command: "ls" },
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("defers approval-required tools without opening an approval request", async () => {
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
      toolCallId: "call-defer",
      approvalMode: "defer",
    });

    expect(result).toMatchObject({
      blocked: false,
      params: { command: "ls" },
      deferredApproval: {
        toolName: "exec",
        toolCallId: "call-defer",
        baseParams: { command: "ls" },
        overrideParams: { adjusted: true },
      },
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
      ctx: { approvalReviewerDeviceId: "device-tui-reviewer" },
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
    expect(approvalCall.request.approvalReviewerDeviceIds).toEqual(["device-tui-reviewer"]);
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

    expect(result).toEqual({
      blocked: false,
      params: { command: "deploy" },
      approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
    });
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

  it("requires approval before skill_workshop applies a proposal", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "skill-workshop-approval",
      decision: PluginApprovalResolutions.ALLOW_ONCE,
    });

    const result = await runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      toolCallId: "call-skill-apply",
      ctx: {
        agentId: "main",
        sessionKey: "main",
        config: {
          skills: {
            workshop: {
              approvalPolicy: "pending",
            },
          },
        },
      },
    });

    expect(result).toEqual({
      blocked: false,
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
    });
    const approvalCall = requireApprovalRequestCall("skill_workshop approval request");
    expect(approvalCall.request.pluginId).toBeUndefined();
    expect(approvalCall.request.title).toBe("Apply workspace skill proposal");
    expect(approvalCall.request.description).toBe(
      "Apply a pending workspace skill proposal into live workspace skills.",
    );
    expect(approvalCall.request.severity).toBe("warning");
    expect(approvalCall.request.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(approvalCall.request.timeoutMs).toBe(70_000);
    expect(approvalCall.timeoutParams.timeoutMs).toBe(80_000);
    expect(approvalCall.request.toolName).toBe("skill_workshop");
    expect(approvalCall.request.toolCallId).toBe("call-skill-apply");
    expect(runBeforeToolCallMock).toHaveBeenCalledTimes(1);

    {
      mockCallGatewayTool.mockReset();
      runBeforeToolCallMock.mockReset();
      runBeforeToolCallMock.mockResolvedValue({
        params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      });
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "skill-workshop-approval",
        decision: PluginApprovalResolutions.ALLOW_ONCE,
      });

      const adjustedResult = await runBeforeToolCallHook({
        toolName: "skill_workshop",
        params: { action: "inspect", proposal_id: "weather-20260530-a1b2c3d4e5" },
        toolCallId: "call-skill-hook-apply",
        ctx: {
          config: {
            skills: {
              workshop: {
                approvalPolicy: "pending",
              },
            },
          },
        },
      });

      expect(adjustedResult).toEqual({
        blocked: false,
        params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
        approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
      });
      const adjustedApprovalCall = requireApprovalRequestCall(
        "skill_workshop adjusted approval request",
      );
      expect(adjustedApprovalCall.request.title).toBe("Apply workspace skill proposal");
      expect(adjustedApprovalCall.request.toolName).toBe("skill_workshop");
      expect(adjustedApprovalCall.request.toolCallId).toBe("call-skill-hook-apply");
      expect(runBeforeToolCallMock).toHaveBeenCalledTimes(1);
    }
  });

  it("returns an actionable pending outcome when skill_workshop approval expires", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "skill-workshop-timeout",
      status: "accepted",
    });
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "skill-workshop-timeout",
      decision: null,
    });

    const result = await runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      toolCallId: "call-skill-timeout",
      ctx: {
        agentId: "main",
        sessionKey: "main",
        config: {
          skills: {
            workshop: {
              approvalPolicy: "pending",
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      kind: "veto",
      deniedReason: "plugin-approval",
      reason:
        "The Skill Workshop approval request expired without a decision. This lifecycle call left the proposal unchanged and pending; check its current status in case another operator acted on it. Decide in the Skill Workshop UI or run `openclaw skills workshop apply|reject|quarantine <id>`. Do not retry this tool call in a loop.",
    });
  });

  it("runs trusted policies before skill_workshop lifecycle approval", async () => {
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-policy",
        pluginName: "Trusted Policy",
        source: "test",
        policy: {
          id: "block-skill-workshop",
          description: "Block skill workshop lifecycle",
          evaluate: () => ({
            block: true,
            blockReason: "trusted policy blocked skill workshop",
          }),
        },
      },
    ];
    setActivePluginRegistry(registry);
    (hookRunner.hasHooks as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      toolCallId: "call-skill-apply",
      ctx: {
        config: {
          skills: {
            workshop: {
              approvalPolicy: "pending",
            },
          },
        },
      },
    });

    expect(result).toEqual({
      blocked: true,
      kind: "veto",
      deniedReason: "plugin-before-tool-call",
      reason: "trusted policy blocked skill workshop",
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(runBeforeToolCallMock).not.toHaveBeenCalled();
  });

  it("runs trusted policies from the global hook registry after the active registry changes", async () => {
    const evaluatePolicy = vi.fn(() => ({
      block: true,
      blockReason: "gateway registry policy blocked",
    }));
    const gatewayRegistry = createEmptyPluginRegistry();
    gatewayRegistry.trustedToolPolicies = [
      {
        pluginId: "gateway-policy",
        pluginName: "Gateway Policy",
        source: "test",
        policy: {
          id: "gateway-block",
          description: "Gateway policy",
          evaluate: evaluatePolicy,
        },
      },
    ];
    initializeGlobalHookRunner(gatewayRegistry);
    setActivePluginRegistry(createEmptyPluginRegistry());
    runBeforeToolCallMock.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "deploy" },
      toolCallId: "call-gateway-policy",
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toEqual({
      blocked: true,
      kind: "veto",
      deniedReason: "plugin-before-tool-call",
      reason: "gateway registry policy blocked",
      params: { command: "deploy" },
    });
    expect(evaluatePolicy).toHaveBeenCalledTimes(1);
    expect(runBeforeToolCallMock).not.toHaveBeenCalled();
  });

  it("runs pinned gateway trusted policies after a later global runner initialization", async () => {
    const evaluatePolicy = vi.fn(() => ({
      block: true,
      blockReason: "pinned gateway policy blocked",
    }));
    const gatewayRegistry = createEmptyPluginRegistry();
    gatewayRegistry.trustedToolPolicies = [
      {
        pluginId: "gateway-policy",
        pluginName: "Gateway Policy",
        source: "test",
        policy: {
          id: "gateway-block",
          description: "Gateway policy",
          evaluate: evaluatePolicy,
        },
      },
    ];
    setActivePluginRegistry(gatewayRegistry);
    initializeGlobalHookRunner(gatewayRegistry);
    pinActivePluginChannelRegistry(gatewayRegistry);
    try {
      const laterRegistry = createEmptyPluginRegistry();
      setActivePluginRegistry(laterRegistry);
      initializeGlobalHookRunner(laterRegistry);
      runBeforeToolCallMock.mockResolvedValue(undefined);

      const result = await runBeforeToolCallHook({
        toolName: "bash",
        params: { command: "deploy" },
        toolCallId: "call-pinned-gateway-policy",
        ctx: { agentId: "main", sessionKey: "main" },
      });

      expect(result).toEqual({
        blocked: true,
        kind: "veto",
        deniedReason: "plugin-before-tool-call",
        reason: "pinned gateway policy blocked",
        params: { command: "deploy" },
      });
      expect(evaluatePolicy).toHaveBeenCalledTimes(1);
      expect(runBeforeToolCallMock).not.toHaveBeenCalled();
    } finally {
      releasePinnedPluginChannelRegistry(gatewayRegistry);
    }
  });

  it("does not require skill_workshop lifecycle approval by default", async () => {
    (hookRunner.hasHooks as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "reject", proposal_id: "weather-20260530-a1b2c3d4e5" },
    });

    expect(result).toEqual({
      blocked: false,
      params: { action: "reject", proposal_id: "weather-20260530-a1b2c3d4e5" },
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(runBeforeToolCallMock).not.toHaveBeenCalled();
  });

  it("uses runtime config for skill_workshop pending mode when hook context config is absent", async () => {
    (hookRunner.hasHooks as ReturnType<typeof vi.fn>).mockReturnValue(false);
    setRuntimeConfigSnapshot({
      skills: {
        workshop: {
          approvalPolicy: "pending",
        },
      },
    });
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "skill-workshop-runtime-approval",
      decision: PluginApprovalResolutions.ALLOW_ONCE,
    });

    const result = await runBeforeToolCallHook({
      toolName: "skill_workshop",
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result).toEqual({
      blocked: false,
      params: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
    });
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
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
