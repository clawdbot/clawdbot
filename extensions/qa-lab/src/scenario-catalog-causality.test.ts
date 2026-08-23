import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById, readQaScenarioExecutionConfig } from "./scenario-catalog.js";
import { readFlowAssertExpression, requireFlowScenario } from "./scenario-catalog.test-utils.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

describe("qa scenario catalog causality", () => {
  it("loads live gateway sentinel scenarios for harness self-health", () => {
    const scenarioIds = [
      "plugin-hook-health-sentinel",
      "plugin-manifest-contract-health",
      "webchat-direct-reply-routing",
      "long-context-progress-watchdog",
      "gateway-restart-inflight-run",
      "gateway-restart-multi-live",
      "streaming-final-integrity",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.execution.flow?.steps.length).toBeGreaterThan(0);
      expect(scenario.coverage?.primary.length).toBeGreaterThan(0);
    }
    expect(readQaScenarioById("webchat-direct-reply-routing").sourcePath).toBe(
      "qa/scenarios/channels/webchat-direct-reply-routing.yaml",
    );
    expect(readQaScenarioById("long-context-progress-watchdog").sourcePath).toBe(
      "qa/scenarios/runtime/long-context-progress-watchdog.yaml",
    );
    const gatewayRestart = requireFlowScenario(readQaScenarioById("gateway-restart-inflight-run"));
    const gatewayRestartFlow = gatewayRestart.execution.flow;
    const gatewayRestartContract = JSON.stringify(gatewayRestartFlow);
    const gatewayRestartActions = gatewayRestartFlow?.steps[0]?.actions ?? [];
    const recoveryPollIndex = gatewayRestartActions.findIndex(
      (action) =>
        (action as { call?: string }).call === "waitForCondition" &&
        (action as { saveAs?: string }).saveAs === "settledRecovery",
    );
    const outboundIndex = gatewayRestartActions.findIndex(
      (action) =>
        (action as { call?: string }).call === "waitForOutboundMessage" &&
        (action as { saveAs?: string }).saveAs === "outbound",
    );
    const preOutboundRecoveryAssertIndex = gatewayRestartActions.findIndex((action) =>
      readFlowAssertExpression(action).includes(
        "restartRecoveryRequestsBeforeOutbound.length === 1",
      ),
    );
    const preOutboundHeartbeatAssertIndex = gatewayRestartActions.findIndex((action) =>
      readFlowAssertExpression(action).includes(
        "!String(restartRecoveryRequestsBeforeOutbound[0].prompt ?? '').includes('[OpenClaw heartbeat poll]')",
      ),
    );
    const settledRequestsIndex = gatewayRestartActions.findIndex(
      (action) => (action as { set?: string }).set === "settledRecoveryRequests",
    );
    const settledDedupeAssertIndex = gatewayRestartActions.findIndex((action) =>
      readFlowAssertExpression(action).includes("settledRestartRecoveryRequests.length === 1"),
    );
    const recoveryPoll = gatewayRestartActions[recoveryPollIndex] as
      | { args?: Array<{ lambda?: { expr?: string } }> }
      | undefined;
    const recoveryPollExpr = recoveryPoll?.args?.[0]?.lambda?.expr ?? "";
    expect(gatewayRestart.execution.retryCount).toBe(0);
    expect(JSON.stringify(gatewayRestart.gatewayConfigPatch)).toContain(
      '"alsoAllow":["qa_restart_wait","qa_restart_unsafe_probe"]',
    );
    expect(gatewayRestartContract).toContain("plannedToolName === 'wait'");
    expect(gatewayRestartContract).toContain("lastAssistantToolNames?.includes('wait')");
    expect(gatewayRestartContract).toContain("restartRecoveryDeliveryContext");
    expect(gatewayRestartContract).toContain("sendInbound");
    expect(gatewayRestartContract).not.toContain("startAgentRun");
    expect(gatewayRestartContract).toContain('"restartGatewayWithConfigPatch"');
    expect(gatewayRestartContract).toContain("interruptedMatches.length === 1");
    expect(gatewayRestartContract).toContain("restartNotices.length === 0");
    expect(gatewayRestartContract).toContain("dispatching restart-safe recovery");
    expect(recoveryPollIndex).toBeGreaterThanOrEqual(0);
    expect(recoveryPollExpr).toContain(
      "String(request.prompt ?? '').includes('Your previous turn was interrupted by a gateway restart')",
    );
    expect(recoveryPollExpr).toContain(
      "String(request.allInputText ?? '').includes(config.interruptedMarker)",
    );
    expect(recoveryPollExpr).toContain("restartRecoveryRequests.length >= 1");
    expect(recoveryPollExpr).toContain(
      "String(transcript.finalText ?? '').includes(config.interruptedMarker)",
    );
    expect(preOutboundRecoveryAssertIndex).toBeGreaterThan(recoveryPollIndex);
    expect(preOutboundHeartbeatAssertIndex).toBeGreaterThan(preOutboundRecoveryAssertIndex);
    expect(outboundIndex).toBeGreaterThan(preOutboundHeartbeatAssertIndex);
    expect(settledRequestsIndex).toBeGreaterThan(outboundIndex);
    expect(settledDedupeAssertIndex).toBeGreaterThan(settledRequestsIndex);
    expect(
      gatewayRestartActions.some((action) => (action as { call?: string }).call === "sleep"),
    ).toBe(false);
    expect(gatewayRestartContract).toContain("recoveryPromptHeartbeat=false");
    expect(gatewayRestartContract).toContain("liveTurnTimeoutMs(env, 180000)");
    expect(gatewayRestartContract).toContain("id: `dm:${conversationId}`");
    expect(gatewayRestartContract).toContain("dmScope: env.cfg.session?.dmScope");
    expect(gatewayRestart.gatewayConfigPatch).toMatchObject({
      plugins: {
        slots: { memory: "none" },
        entries: {
          acpx: { enabled: false },
          "memory-core": { enabled: false },
        },
      },
    });
    const liveMultiRestart = readQaScenarioById("gateway-restart-multi-live");
    const liveMultiRestartContract = JSON.stringify(liveMultiRestart.execution.flow);
    expect(JSON.stringify(liveMultiRestart.gatewayConfigPatch)).toContain(
      '"alsoAllow":["qa_restart_wait","qa_restart_unsafe_probe"]',
    );
    expect(liveMultiRestartContract).toContain("assistantToolCallCounts.exec");
    expect(liveMultiRestartContract).toContain("checkpoint");
    expect(liveMultiRestartContract).toContain("restarts=3");
    expect(liveMultiRestartContract).toContain("dmScope: 'per-channel-peer'");
    expect(liveMultiRestartContract).toContain("dispatching restart-safe recovery");
    expect(readQaScenarioExecutionConfig("gateway-restart-multi-live")).toMatchObject({
      requiredProviderMode: "live-frontier",
      requiredProvider: "openai",
      requiredModel: "gpt-5.4",
    });
  });

  it("scopes prompt diagnostics to requests after each scenario cursor", () => {
    for (const scenarioId of [
      "instruction-followthrough-repo-contract",
      "subagent-handoff",
    ] as const) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      const flow = JSON.stringify(scenario.execution.flow);
      const cursorIndex = flow.indexOf("/debug/request-cursor");
      const promptIndex = flow.indexOf('"call":"runAgentPrompt"');
      const requestsIndex = flow.indexOf("/debug/requests?after=${requestCursorBefore}");

      expect(cursorIndex, scenarioId).toBeGreaterThanOrEqual(0);
      expect(cursorIndex, scenarioId).toBeLessThan(promptIndex);
      expect(requestsIndex, scenarioId).toBeGreaterThan(promptIndex);
      expect(flow, scenarioId).not.toContain("`${env.mock.baseUrl}/debug/requests`");
    }
  });

  it.each([
    [
      "thread-memory-isolation",
      "poll",
      "finalRequest.toolOutputCallId === searchResultRequest.plannedToolCallId",
      null,
    ],
    [
      "memory-tools-channel-context",
      "poll",
      "finalRequest.toolOutputCallId === searchResultRequest.plannedToolCallId",
      "durableChannelLifecycle",
    ],
    [
      "agent-tool-consumption",
      "immediate",
      "getResultRequest.toolOutputCallId === searchResultRequest.plannedToolCallId",
      null,
    ],
  ] as const)(
    "asserts the complete memory tool chain before %s delivery",
    (scenarioId, requestCollectionMode, finalLinkNeedle, durableWaitSaveAs) => {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
      const outboundIndex = actions.findIndex((action) =>
        durableWaitSaveAs
          ? (action as { call?: string }).call === "waitForCondition" &&
            (action as { saveAs?: string }).saveAs === durableWaitSaveAs
          : (action as { call?: string }).call === "waitForOutboundMessage",
      );
      const requestCollectionIndex = actions.findIndex((action) =>
        requestCollectionMode === "poll"
          ? (action as { call?: string }).call === "waitForCondition" &&
            (action as { saveAs?: string }).saveAs === "scenarioRequests"
          : (action as { set?: string }).set === "scenarioRequests",
      );
      const requestCountAssertIndex = actions.findIndex((action) =>
        readFlowAssertExpression(action).includes("scenarioRequests.length === 3"),
      );
      const searchPlanAssertIndex = actions.findIndex((action) =>
        readFlowAssertExpression(action).includes(
          "searchPlanRequest.plannedToolName === 'memory_search'",
        ),
      );
      const searchResultAssertIndex = actions.findIndex((action) =>
        readFlowAssertExpression(action).includes(
          "searchResultRequest.toolOutputCallId === searchPlanRequest.plannedToolCallId",
        ),
      );
      const finalRequestAssertIndex = actions.findIndex((action) =>
        readFlowAssertExpression(action).includes(finalLinkNeedle),
      );

      expect(requestCollectionIndex, scenarioId).toBeGreaterThanOrEqual(0);
      expect(requestCountAssertIndex, scenarioId).toBeGreaterThan(requestCollectionIndex);
      expect(searchPlanAssertIndex, scenarioId).toBeGreaterThan(requestCountAssertIndex);
      expect(searchResultAssertIndex, scenarioId).toBeGreaterThan(searchPlanAssertIndex);
      expect(finalRequestAssertIndex, scenarioId).toBeGreaterThan(searchResultAssertIndex);
      expect(outboundIndex, scenarioId).toBeGreaterThan(finalRequestAssertIndex);

      if (durableWaitSaveAs) {
        const durableWait = actions[outboundIndex] as
          | { args?: Array<{ lambda?: { expr?: string } }> }
          | undefined;
        const durableExpr = durableWait?.args?.[0]?.lambda?.expr ?? "";
        expect(durableExpr, scenarioId).toContain("event.cursor < finalSent.cursor");
        expect(durableExpr, scenarioId).toContain("event.cursor < previewRetired.cursor");
      }

      if (requestCollectionMode === "poll") {
        const requestPoll = actions[requestCollectionIndex] as
          | { args?: Array<{ lambda?: { expr?: string } }> }
          | undefined;
        expect(requestPoll?.args?.[0]?.lambda?.expr, scenarioId).toContain(
          "requests.length >= 3 ? requests : undefined",
        );
      } else {
        expect(
          actions.some(
            (action) =>
              (action as { call?: string }).call === "waitForCondition" &&
              (action as { saveAs?: string }).saveAs === "scenarioRequests",
          ),
          scenarioId,
        ).toBe(false);
      }
    },
  );

  it.each([
    ["memory-tools-channel-context", "durableChannelLifecycle", 30000],
    ["agent-progress-evidence", "durableCompletionLifecycle", 60000],
  ] as const)("keeps the policy-aware durable delivery budget for %s", (scenarioId, saveAs, ms) => {
    const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
    const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
    const durableWait = actions.find(
      (action) =>
        (action as { call?: string }).call === "waitForCondition" &&
        (action as { saveAs?: string }).saveAs === saveAs,
    );

    expect(durableWait, scenarioId).toMatchObject({
      args: [expect.any(Object), { expr: `liveTurnTimeoutMs(env, ${ms})` }],
    });
  });

  it.each([
    {
      scenarioId: "memory-tools-channel-context",
      saveAs: "durableChannelLifecycle",
      cursorName: "busCursorBeforeInbound",
      conversationKey: "channelId",
      markerKey: "expectedNeedle",
      targetPrefix: "channel",
    },
    {
      scenarioId: "agent-progress-evidence",
      saveAs: "durableCompletionLifecycle",
      cursorName: "busCursorBefore",
      conversationKey: "conversationId",
      markerKey: "completionText",
      targetPrefix: "dm",
    },
  ] as const)("isolates $scenarioId durable lifecycle evidence by account", async (fixture) => {
    const scenario = requireFlowScenario(readQaScenarioById(fixture.scenarioId));
    const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
    const durableWaitIndex = actions.findIndex(
      (action) =>
        (action as { call?: string }).call === "waitForCondition" &&
        (action as { saveAs?: string }).saveAs === fixture.saveAs,
    );
    const cardinalityAssertIndex = actions.findIndex((action) =>
      readFlowAssertExpression(action).includes(
        fixture.scenarioId === "memory-tools-channel-context"
          ? "visibleChannelOutbounds.length === 1"
          : "completionMessages.length === 1",
      ),
    );
    expect(durableWaitIndex, fixture.scenarioId).toBeGreaterThanOrEqual(0);
    expect(cardinalityAssertIndex, fixture.scenarioId).toBeGreaterThan(durableWaitIndex);
    if (durableWaitIndex < 0 || cardinalityAssertIndex <= durableWaitIndex) {
      throw new Error(`missing durable lifecycle assertion path for ${fixture.scenarioId}`);
    }
    const postWaitAssertionPath = actions.slice(durableWaitIndex, cardinalityAssertIndex + 1);

    const config = scenario.execution.config ?? {};
    const conversationId = String(config[fixture.conversationKey]);
    const marker = String(config[fixture.markerKey]);
    const target = `${fixture.targetPrefix}:${conversationId}`;
    const state = createQaBusState();
    for (const accountId of ["foreign", "qa-channel"]) {
      const preview = state.addOutboundMessage({ accountId, to: target, text: marker });
      state.deleteMessage({ accountId, messageId: preview.id });
      state.addOutboundMessage({ accountId, to: target, text: marker });
    }
    const foreignKind = fixture.targetPrefix === "dm" ? "channel" : "dm";
    const foreignKindTarget = `${foreignKind}:${conversationId}`;
    const foreignKindPreview = state.addOutboundMessage({
      accountId: "qa-channel",
      to: foreignKindTarget,
      text: marker,
    });
    state.deleteMessage({ accountId: "qa-channel", messageId: foreignKindPreview.id });
    state.addOutboundMessage({
      accountId: "qa-channel",
      to: foreignKindTarget,
      text: marker,
    });

    await expect(
      runLoadedScenarioFlow(fixture.scenarioId, {
        state,
        flow: {
          steps: [
            {
              name: "keeps foreign account lifecycle evidence isolated",
              actions: [
                { set: "outboundStartIndex", value: { expr: "0" } },
                { set: fixture.cursorName, value: { expr: "0" } },
                ...postWaitAssertionPath,
                {
                  assert: {
                    expr: `${fixture.saveAs}.message.accountId === transport.accountId`,
                  },
                },
              ],
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("isolates Active Memory request traces from interleaved heartbeats", async () => {
    const scenario = requireFlowScenario(readQaScenarioById("active-memory-preprompt-recall"));
    const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
    const baselineTrace = actions.find(
      (action) => (action as { set?: string }).set === "baselineMockRequests",
    );
    const activeTrace = actions.find(
      (action) => (action as { set?: string }).set === "activeRequests",
    );
    expect(baselineTrace).toBeDefined();
    expect(activeTrace).toBeDefined();
    if (!baselineTrace || !activeTrace) {
      throw new Error("active-memory-preprompt-recall request trace actions are missing");
    }

    const marker = String(scenario.execution.config?.turnMarker);
    const heartbeat = { allInputText: "[OpenClaw heartbeat poll]" };
    const scenarioRequest = (suffix: string) => ({ allInputText: `${marker} ${suffix}` });
    const traces = new Map<string, unknown[]>([
      ["10", [heartbeat, scenarioRequest("baseline main")]],
      [
        "20",
        [
          heartbeat,
          scenarioRequest("You are a memory search agent. search plan"),
          scenarioRequest("You are a memory search agent. search result"),
          scenarioRequest("You are a memory search agent. memory get result"),
          scenarioRequest("active main"),
        ],
      ],
    ]);

    await expect(
      runLoadedScenarioFlow("active-memory-preprompt-recall", {
        flow: {
          steps: [
            {
              name: "filters provider-global traces before exact counts",
              actions: [
                { set: "requestCursorBeforeBaseline", value: { expr: "10" } },
                baselineTrace,
                { assert: "baselineMockRequests.length === 1" },
                { set: "requestCursorBeforeActive", value: { expr: "20" } },
                activeTrace,
                { assert: "activeRequests.length === 4" },
              ],
            },
          ],
        },
        api: {
          env: { mock: { baseUrl: "http://mock.invalid" } },
          fetchJson: async (url: string) =>
            traces.get(new URL(url).searchParams.get("after") ?? "") ?? [],
        },
      }),
    ).resolves.toMatchObject({ status: "pass" });
  });
});
