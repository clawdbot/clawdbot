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
  const memory = "session-memory";

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

  it("isolates scenarios that own asynchronous transport state", () => {
    const channelBaseline = requireFlowScenario(readQaScenarioById("channel-chat-baseline"));
    const subagentFanout = requireFlowScenario(readQaScenarioById("subagent-fanout-synthesis"));

    expect(channelBaseline.execution.suiteIsolation).toBe("isolated");
    expect(subagentFanout.execution.suiteIsolation).toBe("isolated");
  });

  it("settles subagent completions before reading the SQLite session store", () => {
    const scenario = requireFlowScenario(readQaScenarioById("subagent-fanout-synthesis"));
    const flow = JSON.stringify(scenario.execution.flow);
    const completionWaits = [...flow.matchAll(/expectedChildCompletionMarkers/gu)].map(
      (match) => match.index,
    );
    const storeReads = [...flow.matchAll(/readRawQaSessionStore/gu)].map((match) => match.index);

    expect(completionWaits).toHaveLength(2);
    expect(storeReads).toHaveLength(2);
    expect(completionWaits.every((wait, index) => wait < (storeReads[index] ?? -1))).toBe(true);
  });

  it("adds a dreaming shadow trial report scenario", () => {
    const scenario = readQaScenarioById("dreaming-shadow-trial-report");
    const config = readQaScenarioExecutionConfig("dreaming-shadow-trial-report") as
      | {
          prompt?: string;
          reportName?: string;
          expectedReportAll?: string[];
          forbiddenReplyNeedles?: string[];
          seededMemory?: string;
        }
      | undefined;
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.coverage?.primary).toEqual([`${memory}.memory-files-dreaming`]);
    expect(scenario.coverage?.secondary).toEqual([
      `${memory}.memory-files-promotion`,
      `${memory}.memory-files-artifact-safety`,
    ]);
    expect(config?.expectedReportAll).toContain("verdict: helpful");
    expect(config?.expectedReportAll).toContain("exact verification commands and remaining risk");
    expect(config?.expectedReportAll).toContain("omits the exact command and remaining risk");
    expect(config?.expectedReportAll).toContain("calls out the remaining review risk");
    expect(config?.forbiddenReplyNeedles).toContain("candidate was promoted to MEMORY.md");
    expect(flow).toContain("plannedToolName === 'write'");
    expect(flow).toContain("readIndices[1] < firstWrite");
    expect(flow).toContain("String(memoryAfter) === config.seededMemory");
  });

  it("enables Telegram previews for channel streaming evidence", () => {
    const scenario = readQaScenarioById("channel-message-flows");

    expect(scenario.coverage?.primary).toEqual([`${agentRuntime}.streaming-replies`]);
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
