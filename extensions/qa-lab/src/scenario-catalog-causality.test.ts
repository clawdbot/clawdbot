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
    const liveMultiRestart = requireFlowScenario(readQaScenarioById("gateway-restart-multi-live"));
    const liveMultiRestartFlow = liveMultiRestart.execution.flow;
    const liveMultiRestartContract = JSON.stringify(liveMultiRestartFlow);
    const liveMultiRestartPrompt =
      typeof liveMultiRestart.execution.config?.prompt === "string"
        ? liveMultiRestart.execution.config.prompt
        : "";
    const liveMultiRestartActions = liveMultiRestartFlow?.steps[1]?.actions ?? [];
    const checkpointLoop = liveMultiRestartActions.find(
      (action): action is { forEach?: { actions?: unknown[] } } =>
        typeof action === "object" && action !== null && "forEach" in action,
    );
    const checkpointActions = checkpointLoop?.forEach?.actions ?? [];
    const checkpointTranscriptIndex = checkpointActions.findIndex(
      (action) =>
        (action as { call?: string }).call === "waitForCondition" &&
        (action as { saveAs?: string }).saveAs === "checkpointTranscript",
    );
    const checkpointStoreIndex = checkpointActions.findIndex(
      (action) =>
        (action as { call?: string }).call === "readRawQaSessionStore" &&
        (action as { saveAs?: string }).saveAs === "checkpointStore",
    );
    const checkpointPersistenceAssertIndex = checkpointActions.findIndex((action) => {
      const expression = readFlowAssertExpression(action);
      return (
        expression.includes("checkpointEntry") &&
        expression.includes("checkpointTranscript.userMessageCount >= 1") &&
        expression.includes("checkpointTranscript.eventCursor > 0") &&
        expression.includes("checkpointTranscript.probeTextEndLine ?? 0") &&
        expression.includes("restartRecoveryDeliveryContext?.channel === 'qa-channel'") &&
        expression.includes("restartRecoveryDeliveryContext.to === `dm:${conversationId}`")
      );
    });
    const checkpointRestartIndex = checkpointActions.findIndex(
      (action) => (action as { call?: string }).call === "restartGatewayWithConfigPatch",
    );
    const finalOutboundIndex = liveMultiRestartActions.findIndex(
      (action) =>
        (action as { call?: string }).call === "waitForOutboundMessage" &&
        (action as { saveAs?: string }).saveAs === "outbound",
    );
    const outboundCountIndex = liveMultiRestartActions.findIndex(
      (action) => (action as { set?: string }).set === "outboundCountAfterDelivery",
    );
    const quietWindowIndex = liveMultiRestartActions.findIndex(
      (action) => typeof action === "object" && action !== null && "waitForNoOutbound" in action,
    );
    const finalCardinalityAssertIndex = liveMultiRestartActions.findIndex((action) =>
      readFlowAssertExpression(action).includes("finalMatches.length === 1"),
    );
    expect(liveMultiRestart.execution.retryCount).toBe(0);
    expect(JSON.stringify(liveMultiRestart.gatewayConfigPatch)).toContain(
      '"alsoAllow":["qa_restart_wait","qa_restart_unsafe_probe"]',
    );
    expect(liveMultiRestartContract).toContain("assistantToolCallCounts.exec");
    expect(liveMultiRestartContract).toContain("checkpoint");
    expect(liveMultiRestartContract).toContain("restarts=3");
    for (const fixturePath of [
      "restart-audit/components.md",
      "restart-audit/risks.md",
      "restart-audit/deployments.md",
      "restart-audit/controls.md",
      "restart-audit/recommendation.md",
    ]) {
      expect(liveMultiRestartPrompt).toContain(fixturePath);
    }
    expect(liveMultiRestartPrompt).toContain("your only work in this turn is the next checkpoint");
    expect(liveMultiRestartPrompt).toContain(
      "Make exactly one `exec` call with `restartSafe: true`",
    );
    expect(liveMultiRestartPrompt).toContain(
      "expired, or aborted `wait` result after restart is expected",
    );
    expect(liveMultiRestartPrompt).toContain("`CHECKPOINT-N` is internal tool output");
    expect(liveMultiRestartPrompt).toContain(
      "Do not send any assistant text before the final audit report",
    );
    expect(liveMultiRestartPrompt).toContain("Do not read the `restart-audit/` directory path");
    expect(liveMultiRestartContract).toContain("sendInbound");
    expect(liveMultiRestartContract).not.toContain("startAgentRun");
    expect(liveMultiRestartContract).toContain("id: `dm:${conversationId}`");
    expect(liveMultiRestartContract).toContain("dmScope: env.cfg.session?.dmScope");
    expect(liveMultiRestartContract).toContain('"saveAs":"inbound"');
    expect(liveMultiRestartContract).toContain("probeText: config.finalMarker");
    expect(liveMultiRestartContract).toContain("completedToolCallCounts.wait ?? 0) < checkpoint");
    expect(checkpointTranscriptIndex).toBeGreaterThanOrEqual(0);
    expect(checkpointStoreIndex).toBeGreaterThan(checkpointTranscriptIndex);
    expect(checkpointPersistenceAssertIndex).toBeGreaterThan(checkpointStoreIndex);
    expect(checkpointRestartIndex).toBeGreaterThan(checkpointPersistenceAssertIndex);
    expect(finalOutboundIndex).toBeGreaterThanOrEqual(0);
    expect(outboundCountIndex).toBeGreaterThan(finalOutboundIndex);
    expect(quietWindowIndex).toBeGreaterThan(outboundCountIndex);
    expect(liveMultiRestartActions[quietWindowIndex]).toMatchObject({
      waitForNoOutbound: {
        quietMs: 3000,
        sinceIndex: { ref: "outboundCountAfterDelivery" },
      },
    });
    expect(finalCardinalityAssertIndex).toBeGreaterThan(quietWindowIndex);
    expect(
      liveMultiRestartActions.some((action) => (action as { call?: string }).call === "sleep"),
    ).toBe(false);
    expect(liveMultiRestartContract).toContain("dispatching restart-safe recovery");
    expect(readQaScenarioExecutionConfig("gateway-restart-multi-live")).toMatchObject({
      requiredProviderMode: "live-frontier",
      requiredProvider: "openai",
      requiredModel: "gpt-5.4",
    });
  });

  it("keeps the deterministic restart proof on one inbound turn across three lifecycles", () => {
    const scenario = requireFlowScenario(readQaScenarioById("gateway-restart-inflight-run"));
    const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
    const contract = JSON.stringify(scenario.execution.flow);
    const checkpointLoop = actions.find(
      (action): action is { forEach: { items: unknown[]; actions: unknown[] } } =>
        typeof action === "object" && action !== null && "forEach" in action,
    );
    const checkpointActions = checkpointLoop?.forEach.actions ?? [];
    const pendingWaitIndex = checkpointActions.findIndex(
      (action) =>
        (action as { call?: string; saveAs?: string }).call === "waitForCondition" &&
        (action as { saveAs?: string }).saveAs === "checkpointTranscript",
    );
    const checkpointStoreIndex = checkpointActions.findIndex(
      (action) =>
        (action as { call?: string; saveAs?: string }).call === "readRawQaSessionStore" &&
        (action as { saveAs?: string }).saveAs === "checkpointStore",
    );
    const checkpointPersistenceIndex = checkpointActions.findIndex((action) => {
      const expression = readFlowAssertExpression(action);
      return (
        expression.includes("checkpointTranscript.userMessageCount >= 1") &&
        expression.includes("checkpointTranscript.probeTextEndLine ?? 0") &&
        expression.includes("restartRecoveryDeliveryContext?.channel === 'qa-channel'") &&
        expression.includes("restartRecoveryDeliveryContext.to === `dm:${conversationId}`")
      );
    });
    const restartIndex = checkpointActions.findIndex(
      (action) => (action as { call?: string }).call === "restartGatewayWithConfigPatch",
    );
    const outboundIndex = actions.findIndex(
      (action) =>
        (action as { call?: string; saveAs?: string }).call === "waitForOutboundMessage" &&
        (action as { saveAs?: string }).saveAs === "outbound",
    );
    const quietWindowIndex = actions.findIndex(
      (action) => typeof action === "object" && action !== null && "waitForNoOutbound" in action,
    );

    expect(scenario.execution).toMatchObject({
      retryCount: 0,
      suiteIsolation: "isolated",
    });
    expect(scenario.gatewayConfigPatch).toMatchObject({
      logging: { audit: { executionIdentity: true } },
      plugins: {
        slots: { memory: "none" },
        entries: {
          acpx: { enabled: false },
          "memory-core": { enabled: false },
        },
      },
      tools: {
        alsoAllow: ["qa_restart_wait", "qa_restart_unsafe_probe"],
      },
    });
    expect(checkpointLoop?.forEach.items).toEqual([1, 2, 3]);
    expect(contract.match(/"sendInbound"/gu)).toHaveLength(1);
    expect(contract).not.toContain("startAgentRun");
    expect(contract).not.toContain("chat.send");
    expect(contract).toContain("completedToolCallCounts.wait ?? 0) < checkpoint");
    expect(contract).toContain("probeText: config.promptMarker");
    expect(pendingWaitIndex).toBeGreaterThanOrEqual(0);
    expect(checkpointStoreIndex).toBeGreaterThan(pendingWaitIndex);
    expect(checkpointPersistenceIndex).toBeGreaterThan(checkpointStoreIndex);
    expect(restartIndex).toBeGreaterThan(checkpointPersistenceIndex);
    expect(contract).toContain("checkpointEntry.restartRecoveryDeliveryRunId");
    expect(contract).toContain("checkpointEntry.restartRecoveryRuns?.find");
    expect(contract).toContain("currentDeliveryFence.lifecycleGeneration");
    expect(contract).toContain("runQaCli(env, ['audit', '--run', auditAnchorRunId");
    expect(contract).toContain("capturedAuditAnchorInspection.identity.context");
    expect(contract).toContain("postDeliveryAuditAnchorInspection.identity.context");
    expect(contract).toContain(
      "JSON.stringify(postDeliveryAuditAnchorIdentity) === JSON.stringify(auditAnchorIdentity)",
    );
    expect(contract).toContain("checkpointDeliveryRunIds.length === 3");
    expect(contract).toContain("checkpointDeliveryRunIds[2] !== checkpointDeliveryRunIds[1]");
    expect(contract).toContain("auditAnchorIdentity !== null");
    expect(contract).not.toContain("finalInterruptedRunId");
    expect(contract).not.toContain("auditedIdentities");
    expect(contract).not.toContain("inspectQaRestartRecoveryIdentity");
    expect(contract).not.toContain("mainRestartRecovery?.executionIdentity");
    expect(contract).toContain("assistantToolCallCounts.exec ?? 0) === 3");
    expect(contract).toContain("assistantToolCallCounts.wait ?? 0) >= 3");
    expect(contract).toContain("recoveryDispatches === 3 && retainedPolicies === 3");
    expect(contract).toContain("finalMatches.length === 1");
    expect(contract).toContain("restartNotices.length === 0");
    expect(contract).toContain("unsafeVisible=false");
    expect(contract).toContain("!recoveryLogs.includes('unsafe-probe-executed')");
    expect(restartIndex).toBeGreaterThan(checkpointPersistenceIndex);
    expect(outboundIndex).toBeGreaterThanOrEqual(0);
    expect(quietWindowIndex).toBeGreaterThan(outboundIndex);
    expect(actions[quietWindowIndex]).toMatchObject({
      waitForNoOutbound: {
        quietMs: 3000,
        sinceIndex: { ref: "outboundCountAfterDelivery" },
      },
    });
    expect(actions.some((action) => (action as { call?: string }).call === "sleep")).toBe(false);
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
