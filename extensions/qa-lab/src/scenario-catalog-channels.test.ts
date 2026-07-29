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
        }
      | undefined;

    expect(scenario.execution.channel).toBe("telegram");
    expect(config?.requiredProviderMode).toBe("mock-openai");
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

  it("isolates scenarios that own asynchronous transport state", () => {
    const channelBaseline = requireFlowScenario(readQaScenarioById("channel-chat-baseline"));
    const subagentFanout = requireFlowScenario(readQaScenarioById("subagent-fanout-synthesis"));

    expect(channelBaseline.execution.suiteIsolation).toBe("isolated");
    expect(subagentFanout.execution.suiteIsolation).toBe("isolated");
  });

  it("uses durable subagent completion evidence before accepting fanout", () => {
    const scenario = requireFlowScenario(readQaScenarioById("subagent-fanout-synthesis"));
    const flow = JSON.stringify(scenario.execution.flow);
    const completionWait = flow.indexOf('"items":{"expr":"config.expectedChildCompletionMarkers"}');
    const storeReads = [...flow.matchAll(/readRawQaSessionStore/gu)].map((match) => match.index);

    expect(flow).toContain("readSessionTranscriptSummary(env, sessionKey)");
    expect(flow).not.toContain("waitForAgentHistoryReply");
    expect(
      flow.split("String(candidate.text ?? '').trim() === childCompletionMarker").length - 1,
    ).toBe(1);
    expect(flow).toContain(
      "timeoutSawAlpha && timeoutSawBeta && timeoutAlphaOk && timeoutBetaOk && timeoutSpawnRequests.length >= 2",
    );
    expect(flow).toContain("Boolean(env.mock) ? config.expectedChildCompletionMarkers[0] : 'ok'");
    expect(flow).toContain('saveAs":"timeoutEvidence');
    expect(flow).toContain("Promise.all([readSessionTranscriptSummary");
    expect(completionWait).toBeGreaterThan(-1);
    expect(storeReads).toHaveLength(2);
    expect(completionWait).toBeLessThan(storeReads[0] ?? -1);
  });

  it("keeps channel streaming evidence portable across QA Channel and Crabline Telegram", () => {
    const scenario = requireFlowScenario(readQaScenarioById("channel-message-flows"));

    expect(scenario.execution.channel).toBeUndefined();
    expect(scenario.execution.channels).toEqual(["qa-channel", "telegram"]);
    expect(scenario.coverage?.primary).toEqual(["channels.streaming-final-reply"]);
    expect(scenario.coverage?.secondary).toEqual([`${agentRuntime}.streaming-replies-delivery`]);
    expect(scenario.gatewayConfigPatch).toMatchObject({
      channels: { telegram: { streaming: { mode: "partial" } } },
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
