import { describe, expect, it } from "vitest";
import { readQaScenarioById, readQaScenarioExecutionConfig } from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";

describe("QA inference scenario catalog", () => {
  it("isolates live goal followthrough from shared gateway state", () => {
    const scenario = requireFlowScenario(readQaScenarioById("goal-followthrough-live"));

    expect(scenario.execution).toMatchObject({
      suiteIsolation: "isolated",
      isolationReason: expect.stringContaining("active goal"),
      retryCount: 0,
      config: {
        requiredProviderMode: "live-frontier",
        readyMarker: "GOAL-CONTINUANCE-READY",
        doneMarker: "GOAL-CONTINUANCE-DONE",
      },
    });
    const flow = scenario.execution.flow;
    expect(flow?.steps.map((step) => step.name)).toEqual([
      "starts the staged goal without completing its objective",
      "verifies the durable goal stays active before continuation",
      "advances the active goal on bare continue",
    ]);
    const serializedFlow = JSON.stringify(flow);
    expect(serializedFlow).toContain("sessions.list");
    expect(serializedFlow).toContain("waitForCondition");
    expect(serializedFlow).toContain("session.hasActiveRun === false");
    expect(serializedFlow).toContain("message.replyToId === goalStartInbound.id");
    expect(serializedFlow).toContain("message.replyToId === continueInbound.id");
    expect(serializedFlow).toContain("goalSession?.goal?.status === 'active'");
    expect(serializedFlow).toContain('"text":"continue"');
  });

  it("runs the long-context watchdog through the declared Codex runtime", () => {
    const scenario = readQaScenarioById("long-context-progress-watchdog");
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution).toMatchObject({ kind: "flow", runtime: "codex" });
    expect(flow).toContain("OPENCLAW_QA_FORCE_RUNTIME");
    expect(flow).toContain("markGatewayLogCursor");
    expect(flow).toContain("fs.writeFile");
    expect(flow).toContain("runAgentPrompt");
    expect(flow).toContain("waitForOutboundMessage");
    expect(flow).toContain("assertNoGatewayLogSentinels");
    expect(flow).toContain("codex-app-server-timeout");
    expect(flow).toContain("stalled-agent-run");
    expect(flow).not.toContain("patchConfig");
    expect(flow).not.toContain("originalCodexPluginEnabled");
    expect(readQaScenarioExecutionConfig(scenario.id)).toMatchObject({
      requiredProviderMode: "live-frontier",
      harnessRuntime: "codex",
      fixtureFile: "LONG_CONTEXT_SENTINEL_FIXTURE.txt",
      expectedMarker: "LONG-CONTEXT-WATCHDOG-OK",
      repeatCount: 2000,
    });
    expect(scenario.plugins).toBeUndefined();
    expect(scenario.gatewayConfigPatch).toBeUndefined();
  });

  it("proves one visible failure after the empty-response retry budget is exhausted", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("empty-response-retry-budget-exhausted"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.config).toMatchObject({
      requiredProvider: "mock-openai",
      retryNeedle: "The previous attempt did not produce a user-visible answer.",
      settledToolRetryNeedle:
        "The previous assistant turn completed its tool calls but did not produce a user-visible answer.",
      expectedDiagnostic: "⚠️ Agent couldn't generate a response. Please try again.",
      unexpectedSuccessMarker: "EMPTY-EXHAUSTED-OK",
    });
    const firstOutboundIndex = flow.indexOf('"set":"firstScenarioOutbound"');
    const settleIndex = flow.indexOf('"call":"sleep","args":[300]');
    const finalOutboundIndex = flow.indexOf('"set":"scenarioOutbound"');

    expect(firstOutboundIndex).toBeGreaterThanOrEqual(0);
    expect(settleIndex).toBeGreaterThan(firstOutboundIndex);
    expect(finalOutboundIndex).toBeGreaterThan(settleIndex);
    expect(flow).toContain("Date.now() + liveTurnTimeoutMs(env, 30000)");
    expect(flow).toContain("await sleep(100)");
    expect(flow).toContain("slice(outboundStartIndex)");
    expect(flow).toContain("message.conversation.id === 'qa-operator'");
    expect(flow).not.toContain("qaImport(");
    expect(flow).not.toContain("waitForQaTransportCondition");
    expect(flow).toContain("/debug/requests?after=${requestCursorBefore}");
    expect(flow).toContain("String(request.allInputText ?? '').includes(config.promptSnippet)");
    expect(flow).toContain("splitModelRef(env.primaryModel)?.model");
    expect(flow).toContain("splitModelRef(env.alternateModel)?.model");
    expect(flow).toContain("Array.from(new Set(");
    expect(flow).toContain("scenarioRequests.slice(index * 3, index * 3 + 3)");
    expect(flow).toContain("scenarioRequests.length === expectedModels.length * 3");
    expect(flow).toContain("request.model === group.model");
    expect(flow).toContain("cursor: request.cursor");
    expect(flow).toContain("model: request.model");
    expect(flow).toContain("tool: request.plannedToolName ?? null");
    expect(flow).toContain(
      "retry: String(request.allInputText ?? '').includes(config.retryNeedle)",
    );
    expect(flow).toContain(
      "settledRetry: String(request.allInputText ?? '').includes(config.settledToolRetryNeedle)",
    );
    expect(flow).toContain("callId: request.toolOutputCallId ?? null");
    expect(flow).toContain("group.requests[0]?.plannedToolName === 'read'");
    expect(flow).toContain("!group.requests[1]?.plannedToolName");
    expect(flow).toContain("!group.requests[2]?.plannedToolName");
    expect(flow).toContain("typeof group.requests[1]?.toolOutputCallId === 'string'");
    expect(flow).toContain("typeof group.requests[2]?.toolOutputCallId === 'string'");
    expect(flow).toContain("String(request.allInputText ?? '').includes(config.retryNeedle)");
    expect(flow).toContain(
      "String(request.allInputText ?? '').includes(config.settledToolRetryNeedle)",
    );
    expect(flow).toContain("modelRequestGroups.map((group) => group.requests[2])");
    expect(flow).toContain("retryRequests.length === expectedModels.length");
    expect(flow).toContain("group.requests[2] === retryRequests[index]");
    expect(flow).toContain("scenarioOutbound.length === 1");
    expect(flow).toContain("String(scenarioOutbound[0]?.text ?? '') === config.expectedDiagnostic");
    expect(flow).toContain("config.unexpectedSuccessMarker");
  });
});
