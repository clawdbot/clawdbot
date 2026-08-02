import {
  inspectGatewayToolCallerMessageActionCapabilityForTest,
  wrapToolWithGatewayCallerIdentityForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import { createCodexDynamicToolExecutionRegistry } from "./run-attempt-tools.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

function createControllerFixture(
  attemptToken: string | undefined,
  observed: Array<unknown>,
  constructorToken?: string,
  constructorSessionKey = "agent:test-agent:session",
  onTrustedCapability?: () => void,
) {
  const runAbortController = new AbortController();
  const materializedTool = wrapToolWithGatewayCallerIdentityForTest(
    {
      name: "authority_probe",
      label: "Authority probe",
      description: "authority probe",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await Promise.resolve();
        const resolution = inspectGatewayToolCallerMessageActionCapabilityForTest(attemptToken);
        observed.push(resolution);
        if (resolution.ok && resolution.present) {
          onTrustedCapability?.();
        }
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    },
    {
      agentId: "test-agent",
      sessionKey: constructorSessionKey,
      messageActionTurnCapability: constructorToken,
    },
  );
  const handleToolCall = vi.fn(async () => {
    await materializedTool.execute?.("call", {});
    return {
      success: true,
      contentItems: [{ type: "inputText" as const, text: "ok" }],
    };
  });
  const turnWatches = {
    clearCompletionIdleTimer: vi.fn(),
    disarmAssistantCompletionIdleWatch: vi.fn(),
    touchActivity: vi.fn(),
    armCompletionIdleWatch: vi.fn(),
    scheduleProgressWatches: vi.fn(),
  };
  const trajectoryRecorder = { recordEvent: vi.fn() };
  const projector = {
    recordDynamicToolCall: vi.fn(),
    recordDynamicToolResult: vi.fn(),
  };
  const resources = {
    prompt: {
      context: {
        runtime: {
          connection: {
            params: {
              messageActionTurnCapability: attemptToken,
              sessionKey: "agent:test-agent:session",
              timeoutMs: 1_000,
              provider: "openai",
              modelId: "test-model",
            },
            computerUseConfig: { enabled: false },
            runAbortController,
            appServer: {},
            sessionAgentId: "test-agent",
            sandboxSessionKey: "agent:test-agent:session",
          },
        },
        attemptTools: {
          toolBridge: { handleToolCall },
          toolOutcomeOrdinals: new Map(),
          suppressedDynamicToolOutcomeOrdinals: new Set(),
        },
      },
    },
    state: { thread: { threadId: "thread-1" } },
    projectorRef: { current: projector },
    trajectoryRecorder,
  } as unknown as CodexAttemptResources;
  const turnRuntime = {
    state: {
      activeAppServerTurnRequests: 0,
      turnCrossedToolHandoff: false,
      currentTurnHadNonTerminalDynamicToolResult: false,
    },
    turnIdRef: { current: "turn-1" },
    userInputBridgeRef: {},
    openClawDynamicToolExecutions: createCodexDynamicToolExecutionRegistry(),
    pendingOpenClawDynamicToolCompletionIds: new Set(),
    postToolRawAssistantCompletionIdleTimeoutMs: 5,
    turnWatches,
  } as unknown as CodexAttemptTurnState;
  const lifecycle = {
    emitExecutionPhaseOnce: vi.fn(),
    scheduleTurnReleaseAfterTerminalDynamicTool: vi.fn(),
    scheduleTerminalDynamicToolReleaseCheck: vi.fn(),
  } as unknown as CodexAttemptLifecycleController;
  return {
    controller: createCodexAttemptServerRequestController(resources, turnRuntime, lifecycle),
    handleToolCall,
    projector,
    trajectoryRecorder,
  };
}

describe("Codex dynamic tool message authority", () => {
  it("binds pre-materialized tools and isolates concurrent controller attempts", async () => {
    const firstObserved: Array<unknown> = [];
    const secondObserved: Array<unknown> = [];
    const first = createControllerFixture("opaque-first-capability", firstObserved);
    const second = createControllerFixture("opaque-second-capability", secondObserved);
    const request = (callId: string) => ({
      id: `request-${callId}`,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId,
        namespace: null,
        tool: "authority_probe",
        arguments: {},
      },
    });
    const scope = { threadId: "thread-1", turnId: "turn-1" };

    await expect(
      Promise.all([
        first.controller.handleServerRequest(request("first"), scope),
        second.controller.handleServerRequest(request("second"), scope),
      ]),
    ).resolves.toEqual([
      { success: true, contentItems: [{ type: "inputText", text: "ok" }] },
      { success: true, contentItems: [{ type: "inputText", text: "ok" }] },
    ]);
    expect(firstObserved).toEqual([{ ok: true, present: true, matchesExpected: true }]);
    expect(secondObserved).toEqual([{ ok: true, present: true, matchesExpected: true }]);
    expect(first.handleToolCall).toHaveBeenCalledOnce();
    expect(second.handleToolCall).toHaveBeenCalledOnce();
    expect(inspectGatewayToolCallerMessageActionCapabilityForTest()).toEqual({
      ok: true,
      present: false,
      matchesExpected: true,
    });
  });

  it("fails closed when a pre-materialized tool has conflicting authority", async () => {
    const observed: Array<unknown> = [];
    const fixture = createControllerFixture(
      "opaque-attempt-capability",
      observed,
      "opaque-constructor-capability",
    );
    await fixture.controller.handleServerRequest(
      {
        id: "request-conflict",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "conflict",
          namespace: null,
          tool: "authority_probe",
          arguments: {},
        },
      },
      { threadId: "thread-1", turnId: "turn-1" },
    );
    expect(observed).toEqual([{ ok: false, reason: "token_conflict" }]);
    expect(inspectGatewayToolCallerMessageActionCapabilityForTest()).toEqual({
      ok: true,
      present: false,
      matchesExpected: true,
    });
  });

  it.each([
    { name: "tokened attempt", attemptToken: "opaque-attempt-capability" },
    { name: "untokened attempt", attemptToken: undefined },
  ])(
    "rejects a different-session tool during a $name before its trusted Slack callback",
    async ({ attemptToken }) => {
      const observed: Array<unknown> = [];
      const trustedSlackCallback = vi.fn();
      const fixture = createControllerFixture(
        attemptToken,
        observed,
        "opaque-other-session-capability",
        "agent:test-agent:other-session",
        trustedSlackCallback,
      );

      await fixture.controller.handleServerRequest(
        {
          id: "request-cross-session",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "cross-session",
            namespace: null,
            tool: "authority_probe",
            arguments: {},
          },
        },
        { threadId: "thread-1", turnId: "turn-1" },
      );

      expect(observed).toEqual([{ ok: false, reason: "token_conflict" }]);
      expect(trustedSlackCallback).not.toHaveBeenCalled();
    },
  );

  it("keeps the permission value out of Codex requests, transcripts, and stored tool records", async () => {
    const permissionValue = "opaque-permission-value-that-must-not-be-recorded";
    const observed: Array<unknown> = [];
    const fixture = createControllerFixture(permissionValue, observed);
    const request = {
      id: "request-no-leak",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "no-leak",
        namespace: null,
        tool: "authority_probe",
        arguments: { visible: "model-authored argument" },
      },
    };

    const response = await fixture.controller.handleServerRequest(request, {
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const externallyRecorded = {
      request,
      response,
      toolBridgeCalls: fixture.handleToolCall.mock.calls,
      transcriptCalls: fixture.projector.recordDynamicToolCall.mock.calls,
      transcriptResults: fixture.projector.recordDynamicToolResult.mock.calls,
      storedTrajectory: fixture.trajectoryRecorder.recordEvent.mock.calls,
    };
    expect(JSON.stringify(externallyRecorded)).not.toContain(permissionValue);
    expect(observed).toEqual([{ ok: true, present: true, matchesExpected: true }]);
  });
});
