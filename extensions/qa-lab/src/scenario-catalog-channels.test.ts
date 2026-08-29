import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioPack,
  validateQaScenarioExecutionConfig,
} from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { recentOutboundSummary } from "./suite-runtime-transport.js";

type CatalogScenario = ReturnType<typeof readQaScenarioById>;
type FlowCatalogScenario = CatalogScenario & {
  execution: Extract<CatalogScenario["execution"], { kind: "flow" }>;
};

function requireFlowScenario(scenario: CatalogScenario): FlowCatalogScenario {
  expect(scenario.execution.kind).toBe("flow");
  if (scenario.execution.kind !== "flow") {
    throw new Error(`expected ${scenario.id} to be a flow scenario`);
  }
  return scenario as FlowCatalogScenario;
}

const telegramStreamingFinalScenarios = [
  {
    scenarioId: "telegram-stream-final-single-message",
    finalTexts: ["QA-TELEGRAM-STREAM-SINGLE-OK"],
  },
  {
    scenarioId: "telegram-long-final-reuses-preview",
    finalTexts: ["TELEGRAM-LONG-FINAL-BEGIN first", "second TELEGRAM-LONG-FINAL-END"],
  },
  {
    scenarioId: "telegram-long-final-three-chunks",
    finalTexts: [
      "TELEGRAM-LONG-FINAL-3CHUNK-BEGIN first",
      "second final chunk",
      "third TELEGRAM-LONG-FINAL-3CHUNK-END",
    ],
  },
] as const;

function runTelegramStreamingFinalScenario(params: {
  scenarioId: string;
  finalTexts: readonly string[];
  deletedPreview: boolean;
}) {
  return runLoadedScenarioFlow(params.scenarioId, {
    state: createQaBusState(),
    onWaitForOutboundMessage: ({ state }) => {
      if (params.deletedPreview) {
        const preview = state.addOutboundMessage({
          accountId: "qa-channel",
          to: "channel:telegram-stream-room",
          text: "deleted streaming preview",
        });
        state.deleteMessage({ accountId: "qa-channel", messageId: preview.id });
      }
      for (const text of params.finalTexts) {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "channel:telegram-stream-room",
          text,
        });
      }
    },
  });
}

describe("qa scenario catalog channel contracts", () => {
  const agentRuntime = "agent-runtime";

  it("classifies every current module flow intrinsically", () => {
    const moduleFlows = readQaScenarioPack().scenarios.filter(
      (scenario) => scenario.execution.flowKind === "module",
    );

    expect(moduleFlows).toHaveLength(146);
    expect(moduleFlows.every((scenario) => scenario.execution.flow)).toBe(true);
  });

  it("routes native command session targeting through Crabline Telegram", () => {
    const scenario = readQaScenarioById("native-command-session-target");
    const config = readQaScenarioExecutionConfig("native-command-session-target") as
      | {
          requiredChannelDriver?: string;
          requiredProviderMode?: string;
        }
      | undefined;

    expect(scenario.execution.channel).toBe("telegram");
    expect(scenario.execution.channels).toEqual(["telegram"]);
    expect(config?.requiredProviderMode).toBe("mock-openai");
    expect(config?.requiredChannelDriver).toBe("crabline");
    const flow = JSON.stringify(requireFlowScenario(scenario).execution.flow);
    expect(flow).toContain("transport.buildAgentDelivery");
    expect(flow).toContain("peer: { kind: 'group', id: delivery.replyTo }");
  });

  it("keeps channel-owned scenarios independent from the driver implementation", () => {
    const channelByScenarioId = new Map<string, { channel: string; sharedCall?: string }>([
      [
        "matrix-restart-resume",
        { channel: "matrix", sharedCall: "env.gateway.restartAfterStateMutation" },
      ],
      [
        "slack-restart-resume",
        { channel: "slack", sharedCall: "env.gateway.restartAfterStateMutation" },
      ],
      [
        "whatsapp-restart-resume",
        { channel: "whatsapp", sharedCall: "env.gateway.restartAfterStateMutation" },
      ],
      [
        "whatsapp-access-control-dm-disabled",
        { channel: "whatsapp", sharedCall: "config.expectReply" },
      ],
      [
        "whatsapp-access-control-dm-open",
        { channel: "whatsapp", sharedCall: "config.expectReply" },
      ],
      [
        "whatsapp-access-control-group-disabled",
        { channel: "whatsapp", sharedCall: "config.expectReply" },
      ],
      [
        "whatsapp-access-control-group-open",
        { channel: "whatsapp", sharedCall: "config.expectReply" },
      ],
      ["whatsapp-pairing-block", { channel: "whatsapp" }],
      ["matrix-allowlist-hot-reload", { channel: "matrix" }],
    ]);

    for (const [scenarioId, expected] of channelByScenarioId) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      expect(scenario.execution.channel, scenarioId).toBe(expected.channel);
      if (expected.sharedCall) {
        expect(scenario.execution.flowKind, scenarioId).toBe("steps");
        expect(scenario.execution.suiteIsolation, scenarioId).toBe("isolated");
        expect(JSON.stringify(scenario.execution.flow), scenarioId).toContain(expected.sharedCall);
      }
    }
  });

  it("keeps the memory channel-context proof on the internal QA channel", () => {
    expect(readQaScenarioById("memory-tools-channel-context").execution.channel).toBe("qa-channel");
  });

  it("keeps channel participant identity proof on isolated QA Channel lifecycle owners", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("channel-participant-identity-inspection"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.channel).toBe("qa-channel");
    expect(scenario.execution.suiteIsolation).toBe("isolated");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      logging: { audit: { executionIdentity: true } },
      messages: { queue: { mode: "collect", debounceMsByChannel: { "qa-channel": 1000 } } },
      channels: { "qa-channel": { groupPolicy: "allowlist" } },
    });
    expect(flow).toContain("inspectQaExecutionIdentityStorage");
    expect(flow).toContain("env.gateway.restartAfterStateMutation");
  });

  it("keeps stored inbound audio proof on the real QA Channel and Gateway flow", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("inbound-media-store-audio-transcription"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.coverage?.primary).toEqual(["media.inbound-media-store"]);
    expect(scenario.coverage?.secondary).toEqual(["channels.inbound-media-normalization"]);
    expect(scenario.plugins).toContain("openai");
    expect(scenario.execution.channel).toBe("qa-channel");
    expect(scenario.execution.providerMode).toBe("mock-openai");
    expect(flow).toContain('"sendInbound"');
    expect(flow).toContain('"contentBase64"');
    expect(flow).toContain('"mediaFactCarrier":"media-store-url"');
    expect(flow).toContain("String(candidate.text ?? '').trim() === config.expectedMarker");
    expect(flow).toContain("String(message.text ?? '').trim() === config.expectedMarker");
    expect(flow).toContain("conversationOutbound.length === 1");
    expect(flow).not.toContain(".includes(config.expectedMarker)");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      tools: { media: { audio: { echoTranscript: false } } },
    });
    expect(flow).not.toContain('"call":"runAgentPrompt"');
  });

  it("preserves module flow identity without mutating the driver contract", () => {
    for (const scenarioId of [
      "matrix-approval-exec-metadata-single-event",
      "matrix-mxid-prefixed-command-block",
      "slack-codex-approval-exec-native",
      "slack-codex-approval-plugin-native",
    ]) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      expect(scenario.execution.flowKind, scenarioId).toBe("module");
      expect(
        readQaScenarioExecutionConfig(scenarioId)?.requiredChannelDriver,
        scenarioId,
      ).toBeUndefined();
    }
  });

  it("keeps the Teams final-dedupe proof on the real Gateway transport", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("msteams-thread-message-tool-final-dedupe"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.channel).toBe("msteams");
    expect(scenario.execution.suiteIsolation).toBe("isolated");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      messages: { groupChat: { visibleReplies: "automatic" } },
      tools: { alsoAllow: ["message"] },
      agents: { entries: { qa: { tools: { alsoAllow: ["message"] } } } },
    });
    expect(flow).toContain("QA-MSTEAMS-SAME-OK");
    expect(flow).toContain("QA-MSTEAMS-OTHER-THREAD-OK");
    expect(flow).toContain("QA-MSTEAMS-OTHER-CONVERSATION-OK");
    expect(flow).toContain("QA-MSTEAMS-DM-OK");
    expect(flow).toContain("QA-MSTEAMS-GROUP-OK");
  });

  it("isolates scenarios that own asynchronous transport state", () => {
    const channelBaseline = requireFlowScenario(readQaScenarioById("channel-chat-baseline"));
    const subagentFanout = requireFlowScenario(readQaScenarioById("subagent-fanout-synthesis"));

    expect(channelBaseline.execution.suiteIsolation).toBe("isolated");
    expect(subagentFanout.execution.suiteIsolation).toBe("isolated");
  });

  it("uses public parent history and durable task records before accepting fanout", () => {
    const scenario = requireFlowScenario(readQaScenarioById("subagent-fanout-synthesis"));
    const flow = JSON.stringify(scenario.execution.flow);

    expect(flow).toContain('"call":"startAgentRun"');
    expect(flow).not.toContain('"call":"runAgentPrompt"');
    expect(flow).toContain('"taskTracking":false');
    expect(flow).toContain('"saveAs":"parentOutbound"');
    expect(flow).toContain("waitForAgentHistoryReply");
    expect(flow).not.toContain('"call":"waitForOutboundMessage"');
    expect(flow).not.toContain("childCompletionMarker");
    expect(flow).toContain("['tasks', 'list', '--json', '--runtime', 'subagent']");
    expect(flow).toContain("task.requesterSessionKey === sessionKey");
    expect(flow).toContain("task?.status === 'succeeded'");
    expect(flow).toContain("task.deliveryStatus === 'delivered'");
    expect(flow).not.toContain("readRawQaSessionStore");
    expect(flow).not.toContain("readSessionTranscriptSummary");
    expect(flow).not.toContain('"value":"subagent-1: ok\\nsubagent-2: ok"');
  });

  it("settles terminal-reply scenarios from durable task facts instead of sleeps", () => {
    const scenario = requireFlowScenario(readQaScenarioById("subagent-completion-direct-fallback"));
    const flow = JSON.stringify(scenario.execution.flow);
    const config = scenario.execution.config as
      | {
          requiredProviderMode?: string;
          cases?: Array<{ name?: string; marker?: string; expectedSendCount?: number }>;
        }
      | undefined;

    expect(scenario.execution.providerMode).toBe("mock-openai");
    expect(config?.requiredProviderMode).toBe("mock-openai");
    expect(config?.cases).toEqual([
      {
        name: "visible",
        marker: "QA-SUBAGENT-TERMINAL-VISIBLE-OK",
        expectedSendCount: 1,
      },
      {
        name: "silent",
        marker: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED",
        expectedSendCount: 1,
      },
      {
        name: "fallback",
        marker: "QA-SUBAGENT-TERMINAL-FALLBACK-OK",
        expectedSendCount: 1,
      },
    ]);
    expect(flow).toContain("env.gateway.call('tasks.list'");
    expect(flow).toContain("task.title === `qa-terminal-${caseName}`");
    expect(flow).toContain("terminalTask.status === 'completed'");
    expect(flow).toContain("emptyTask.status === 'completed'");
    expect(flow).toContain("emptyTask.terminalOutcome === 'blocked'");
    expect(flow).toContain("task.deliveryStatus === 'delivered'");
    expect(flow).toContain("readSettledTerminalTask('restart')");
    expect(flow).toContain("readSettledTerminalTask('empty')");
    expect(flow).toContain("postRestartUnexpectedPayloads.length === 0");
    expect(flow).toContain("env.providerMode === config.requiredProviderMode");
    expect(flow).not.toContain("interrupted by a gateway restart");
    expect(flow).toContain("verdicts.length === 5");
    expect(flow).not.toContain('"call":"sleep"');
  });

  it("keeps channel streaming evidence portable across QA Channel and Crabline Telegram", () => {
    const scenario = requireFlowScenario(readQaScenarioById("channel-message-flows"));

    expect(scenario.execution.channel).toBeUndefined();
    expect(scenario.execution.channels).toEqual(["qa-channel", "telegram"]);
    expect(scenario.execution.retryCount).toBe(0);
    expect(scenario.coverage?.primary).toEqual(["channels.streaming-final-reply"]);
    expect(scenario.coverage?.secondary).toEqual([`${agentRuntime}.streaming-replies-delivery`]);
    expect(scenario.gatewayConfigPatch).toMatchObject({
      channels: { telegram: { streaming: { mode: "partial" } } },
    });
    expect(scenario.gatewayConfigPatch).not.toHaveProperty("channels.telegram.groups");
  });

  it.each(
    telegramStreamingFinalScenarios.flatMap((scenario) => [
      { ...scenario, deletedPreview: false },
      { ...scenario, deletedPreview: true },
    ]),
  )(
    "counts only visible Telegram finals for $scenarioId (deleted preview: $deletedPreview)",
    async (scenario) => {
      await expect(runTelegramStreamingFinalScenario(scenario)).resolves.toMatchObject({
        status: "pass",
      });
    },
  );

  it("rejects a deleted Telegram preview standing in for a missing final chunk", async () => {
    await expect(
      runTelegramStreamingFinalScenario({
        scenarioId: "telegram-long-final-three-chunks",
        finalTexts: [
          "TELEGRAM-LONG-FINAL-3CHUNK-BEGIN first",
          "second TELEGRAM-LONG-FINAL-3CHUNK-END",
        ],
        deletedPreview: true,
      }),
    ).rejects.toThrow("expected three complete final chunks; saw 2");
  });

  it("keeps the shared channel canary eligible for its supported channels", () => {
    const scenario = requireFlowScenario(readQaScenarioById("channel-canary"));

    expect(scenario.execution.channels).toEqual(["qa-channel", "telegram", "buzz", "msteams"]);
  });

  it.each([
    {
      label: "accepts only the authorized driver reply",
      observerReplies: false,
      driverReplies: true,
      expectedFailure: null,
    },
    {
      label: "rejects an observer reply when the authorized driver never replies",
      observerReplies: true,
      driverReplies: false,
      expectedFailure: "waiting for outbound marker",
    },
    {
      label: "rejects a late observer reply even when the authorized driver replies",
      observerReplies: true,
      driverReplies: true,
      expectedFailure: "blocked sender replied",
    },
  ])("$label", async ({ observerReplies, driverReplies, expectedFailure }) => {
    const state = createQaBusState();
    const result = runLoadedScenarioFlow("channel-sender-allowlist", {
      state,
      api: { recentOutboundSummary },
      onWaitForOutboundMessage: ({ state: currentState }) => {
        for (const [senderId, replies] of [
          ["observer", observerReplies],
          ["driver", driverReplies],
        ] as const) {
          if (!replies) {
            continue;
          }
          const inbound = currentState
            .getSnapshot()
            .messages.find(
              (message) => message.direction === "inbound" && message.senderId === senderId,
            );
          if (!inbound) {
            throw new Error(`missing ${senderId} inbound message`);
          }
          const marker = inbound.text.split("reply exactly: ")[1];
          if (!marker) {
            throw new Error(`missing ${senderId} requested reply marker`);
          }
          currentState.addOutboundMessage({
            accountId: "qa-channel",
            to: "group:qa-routing-allowlist",
            replyToId: inbound.id,
            text: marker,
          });
        }
      },
    });

    if (expectedFailure) {
      await expect(result).rejects.toThrow(expectedFailure);
    } else {
      await expect(result).resolves.toMatchObject({ status: "pass" });
    }

    const snapshot = state.getSnapshot();
    const senderIdsByInboundId = new Map(
      snapshot.messages
        .filter((message) => message.direction === "inbound")
        .map((message) => [message.id, message.senderId]),
    );
    expect(
      snapshot.messages
        .filter((message) => message.direction === "outbound")
        .map((message) => senderIdsByInboundId.get(message.replyToId ?? "")),
    ).toEqual([...(observerReplies ? ["observer"] : []), ...(driverReplies ? ["driver"] : [])]);
  });

  it("keeps transcript-role delivery on the Crabline driver", () => {
    const scenario = readQaScenarioById("telegram-assistant-transcript-role-boundary");
    const config = readQaScenarioExecutionConfig("telegram-assistant-transcript-role-boundary") as
      | {
          requiredChannelDriver?: string;
        }
      | undefined;

    expect(scenario.gatewayConfigPatch).toBeUndefined();
    expect(config?.requiredChannelDriver).toBe("crabline");
  });

  it("rejects malformed string matcher lists before running a flow", () => {
    expect(() =>
      validateQaScenarioExecutionConfig({
        gracefulFallbackAny: [{ confirmed: "the hidden fact is present" }],
      }),
    ).toThrow(/gracefulFallbackAny entries must be strings/);
  });

  it("returns undefined execution config for an unknown scenario id", () => {
    expect(readQaScenarioExecutionConfig("missing-scenario-id")).toBeUndefined();
  });
});
