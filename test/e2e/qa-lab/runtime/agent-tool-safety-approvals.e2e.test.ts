import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBeforeToolCallFailureDisposition,
  wrapToolWithBeforeToolCallHook,
} from "../../../../src/agents/agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../../../src/infra/diagnostic-events.js";
import { setEmbeddedMode } from "../../../../src/infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../../../../src/infra/embedded-plugin-approval-broker.js";
import { resetGlobalHookRunner } from "../../../../src/plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../../src/plugins/runtime.js";
import { PluginApprovalResolutions } from "../../../../src/plugins/types.js";

type BrokerEvent = Parameters<Parameters<EmbeddedPluginApprovalBroker["subscribe"]>[0]>[0];

const AGENT_ID = "qa-agent";
const SESSION_KEY = "agent:qa-agent:approval";
const ALLOWED_DECISIONS = ["allow-once", "deny"] as const;

function flushDiagnostics(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("agent tool safety approvals", () => {
  let broker: EmbeddedPluginApprovalBroker;
  let brokerEvents: BrokerEvent[];
  let resolutions: Array<{ toolCallId?: string; resolution: string }>;
  let execute: ReturnType<typeof vi.fn>;
  let tool: AnyAgentTool;

  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    setEmbeddedMode(true);
    broker = new EmbeddedPluginApprovalBroker();
    brokerEvents = [];
    resolutions = [];
    broker.subscribe((event) => brokerEvents.push(event));
    setEmbeddedPluginApprovalBroker(broker);

    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "qa-safety-policy",
        pluginName: "QA Safety Policy",
        source: "test",
        policy: {
          id: "approval-gate",
          description: "Gate sentinel execution",
          evaluate: (event) => ({
            params: {
              value: `rewritten:${event.toolCallId}`,
              marker: "APPROVED-SENTINEL",
            },
            requireApproval: {
              pluginId: "qa-safety-policy",
              title: "Approve sentinel tool",
              description: "Allow this exact sentinel invocation?",
              severity: "warning",
              allowedDecisions: [...ALLOWED_DECISIONS],
              onResolution: (resolution) => {
                resolutions.push({ toolCallId: event.toolCallId, resolution });
              },
            },
          }),
        },
      },
    ];
    setActivePluginRegistry(registry);

    execute = vi.fn(async (_toolCallId: string, params: unknown) => ({
      content: [{ type: "text" as const, text: "APPROVED-SENTINEL" }],
      details: { params },
    }));
    tool = wrapToolWithBeforeToolCallHook(
      { name: "sentinel", execute } as unknown as AnyAgentTool,
      {
        agentId: AGENT_ID,
        sessionKey: SESSION_KEY,
        loopDetection: { enabled: false },
      },
    );
  });

  afterEach(() => {
    broker.stop();
    setEmbeddedPluginApprovalBroker(null);
    setEmbeddedMode(false);
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetGlobalHookRunner();
    resetDiagnosticEventsForTest();
  });

  async function pendingApproval(toolCallId: string) {
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    const pending = broker.listPending()[0];
    expect(pending).toBeDefined();
    expect(pending?.request).toMatchObject({
      pluginId: "qa-safety-policy",
      title: "Approve sentinel tool",
      description: "Allow this exact sentinel invocation?",
      severity: "warning",
      allowedDecisions: ALLOWED_DECISIONS,
      toolName: "sentinel",
      toolCallId,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
    });
    return pending!;
  }

  it("denies without execution and records a visible blocked outcome", async () => {
    const toolEvents: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("tool.execution.")) {
        toolEvents.push(event);
      }
    });
    try {
      const result = tool.execute("call-deny", { value: "original" }, undefined, undefined);
      const pending = await pendingApproval("call-deny");
      await flushDiagnostics();

      expect(execute).not.toHaveBeenCalled();
      expect(toolEvents).toEqual([]);
      expect(brokerEvents).toEqual([{ event: "plugin.approval.requested", payload: pending }]);

      expect(broker.resolve(pending.id, "deny")).toBe(true);
      let denied: unknown;
      try {
        await result;
      } catch (error) {
        denied = error;
      }
      await flushDiagnostics();

      expect(denied).toMatchObject({
        name: "BeforeToolCallFailureError",
        message: [
          "Denied by user. The tool call did not run.",
          "This denial is final: the approval request is closed. Do not mention /approve or any other approval command to the user.",
          "Do not run the tool call again or ask the user to approve it again.",
          "If the user still wants the action, explain that a new tool call will trigger a fresh approval request.",
        ].join("\n"),
      });
      expect(getBeforeToolCallFailureDisposition(denied)).toBe("blocked");
      expect(execute).not.toHaveBeenCalled();
      expect(broker.listPending()).toEqual([]);
      expect(resolutions).toEqual([
        { toolCallId: "call-deny", resolution: PluginApprovalResolutions.DENY },
      ]);
      expect(brokerEvents.at(-1)).toMatchObject({
        event: "plugin.approval.resolved",
        payload: { id: pending.id, decision: "deny", request: pending.request },
      });
      expect(toolEvents).toContainEqual(
        expect.objectContaining({
          type: "tool.execution.blocked",
          toolName: "sentinel",
          toolCallId: "call-deny",
          deniedReason: "plugin-approval",
        }),
      );
    } finally {
      stopDiagnostics();
    }
  });

  it("executes rewritten args once and requires a fresh later approval", async () => {
    const first = tool.execute("call-allow", { value: "original" }, undefined, undefined);
    const firstPending = await pendingApproval("call-allow");
    expect(execute).not.toHaveBeenCalled();
    expect(broker.resolve(firstPending.id, "allow-once")).toBe(true);

    await expect(first).resolves.toEqual({
      content: [{ type: "text", text: "APPROVED-SENTINEL" }],
      details: {
        params: {
          value: "rewritten:call-allow",
          marker: "APPROVED-SENTINEL",
        },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      "call-allow",
      { value: "rewritten:call-allow", marker: "APPROVED-SENTINEL" },
      undefined,
      undefined,
    );
    expect(resolutions).toEqual([
      { toolCallId: "call-allow", resolution: PluginApprovalResolutions.ALLOW_ONCE },
    ]);
    expect(broker.listPending()).toEqual([]);

    const later = tool.execute("call-later", { value: "second" }, undefined, undefined);
    const laterPending = await pendingApproval("call-later");
    expect(laterPending.id).not.toBe(firstPending.id);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(broker.resolve(laterPending.id, "deny")).toBe(true);
    await expect(later).rejects.toThrow("Denied by user");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(broker.listPending()).toEqual([]);
    expect(resolutions).toEqual([
      { toolCallId: "call-allow", resolution: PluginApprovalResolutions.ALLOW_ONCE },
      { toolCallId: "call-later", resolution: PluginApprovalResolutions.DENY },
    ]);
    expect(brokerEvents.map((event) => event.event)).toEqual([
      "plugin.approval.requested",
      "plugin.approval.resolved",
      "plugin.approval.requested",
      "plugin.approval.resolved",
    ]);
  });
});
