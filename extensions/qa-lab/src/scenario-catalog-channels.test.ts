import { describe, expect, it } from "vitest";
import {
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  validateQaScenarioExecutionConfig,
} from "./scenario-catalog.js";

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

describe("qa scenario catalog channel contracts", () => {
  const agentRuntime = "agent-runtime";

  it("routes native command session targeting through Crabline Telegram", () => {
    const scenario = readQaScenarioById("native-command-session-target");
    const config = readQaScenarioExecutionConfig("native-command-session-target") as
      | {
          requiredProviderMode?: string;
          sessionKey?: string;
        }
      | undefined;

    expect(scenario.execution.channel).toBe("telegram");
    expect(config?.requiredProviderMode).toBe("mock-openai");
    expect(config?.sessionKey).toBe("agent:main:telegram:direct:qa-native-operator");
    expect(JSON.stringify(requireFlowScenario(scenario).execution.flow)).toContain(
      "session.key === config.sessionKey && session.hasActiveRun === true",
    );
  });

  it("keeps channel-owned scenarios independent from the driver implementation", () => {
    const channelByScenarioId = new Map([
      ["slack-restart-resume", "slack"],
      ["whatsapp-restart-resume", "whatsapp"],
      ["whatsapp-access-control-dm-disabled", "whatsapp"],
      ["whatsapp-access-control-dm-open", "whatsapp"],
      ["whatsapp-access-control-group-disabled", "whatsapp"],
      ["whatsapp-access-control-group-open", "whatsapp"],
      ["whatsapp-pairing-block", "whatsapp"],
      ["matrix-allowlist-hot-reload", "matrix"],
    ]);

    for (const [scenarioId, channel] of channelByScenarioId) {
      expect(readQaScenarioById(scenarioId).execution.channel, scenarioId).toBe(channel);
    }
  });

  it("keeps the memory channel-context proof on the internal QA channel", () => {
    expect(readQaScenarioById("memory-tools-channel-context").execution.channel).toBe("qa-channel");
  });

  it("marks live transport modules as live-driver-only", () => {
    for (const scenarioId of [
      "matrix-approval-exec-metadata-single-event",
      "matrix-mxid-prefixed-command-block",
      "slack-codex-approval-exec-native",
      "slack-codex-approval-plugin-native",
    ]) {
      expect(readQaScenarioExecutionConfig(scenarioId)?.requiredChannelDriver, scenarioId).toBe(
        "live",
      );
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

  it("keeps channel streaming evidence portable across QA Channel and Crabline Telegram", () => {
    const scenario = requireFlowScenario(readQaScenarioById("channel-message-flows"));

    expect(scenario.execution.channel).toBeUndefined();
    expect(scenario.execution.channels).toEqual(["qa-channel", "telegram"]);
    expect(scenario.coverage?.primary).toEqual(["channels.streaming-final-reply"]);
    expect(scenario.coverage?.secondary).toEqual([`${agentRuntime}.streaming-replies-delivery`]);
    expect(scenario.gatewayConfigPatch).toMatchObject({
      channels: {
        telegram: {
          groups: { "*": { requireMention: false } },
          streaming: { mode: "partial" },
        },
      },
    });
  });

  it("disables Telegram mention gating for deterministic group delivery proofs", () => {
    const scenario = readQaScenarioById("telegram-assistant-transcript-role-boundary");

    expect(scenario.gatewayConfigPatch).toMatchObject({
      channels: { telegram: { groups: { "*": { requireMention: false } } } },
    });
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
