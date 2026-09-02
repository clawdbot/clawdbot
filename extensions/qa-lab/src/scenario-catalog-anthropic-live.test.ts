// Qa Lab tests keep Anthropic provider smoke evidence on real model lanes.
import { describe, expect, it } from "vitest";
import { readQaScenarioById, readQaScenarioExecutionConfig } from "./scenario-catalog.js";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";

const ANTHROPIC_OPUS_SCENARIO_IDS = [
  "anthropic-opus-api-key-smoke",
  "anthropic-opus-setup-token-smoke",
] as const;

describe("QA Anthropic live scenario catalog", () => {
  it.each(ANTHROPIC_OPUS_SCENARIO_IDS)("pins %s to live Anthropic Opus", (scenarioId) => {
    const scenario = readQaScenarioById(scenarioId);

    expect(readQaScenarioExecutionConfig(scenarioId)).toMatchObject({
      requiredProviderMode: "live-frontier",
      requiredProvider: "anthropic",
      requiredModel: "claude-opus-5",
    });
    expect(scenario.execution.flow?.steps.at(-1)?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ call: "runAgentPrompt" }),
        expect.objectContaining({ call: "waitForOutboundMessage" }),
      ]),
    );
  });

  it.each(ANTHROPIC_OPUS_SCENARIO_IDS)(
    "rejects %s from matching-provider mock lanes",
    (scenarioId) => {
      const scenario = readQaScenarioById(scenarioId);
      const mockLane = {
        scenarios: [scenario],
        providerMode: "mock-openai" as const,
        primaryModel: "anthropic/claude-opus-5",
      };

      expect(selectQaFlowSuiteScenarios({ ...mockLane, providerMode: "live-frontier" })).toEqual([
        scenario,
      ]);
      expect(selectQaFlowSuiteScenarios(mockLane)).toEqual([]);
      expect(() => selectQaFlowSuiteScenarios({ ...mockLane, scenarioIds: [scenario.id] })).toThrow(
        "providerMode=live-frontier",
      );
    },
  );
});
