// Qa Lab tests cover canonical scenario lane matching behavior.
import { describe, expect, it } from "vitest";
import { readQaScenarioPack } from "./scenario-catalog.js";
import {
  describeQaProviderLaneMismatches,
  scenarioMatchesQaProviderLane,
} from "./scenario-lane.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

describe("QA scenario lane matching", () => {
  const planningCoverageIds = new Set(["runtime.no-meta-leak", "workspace.planning"]);
  const planningScenarios = readQaScenarioPack().scenarios.filter((scenario) =>
    [...(scenario.coverage?.primary ?? []), ...(scenario.coverage?.secondary ?? [])].some(
      (coverageId) => planningCoverageIds.has(coverageId),
    ),
  );

  it.each(planningScenarios)("selects $id for the GPT-5.6 Luna live lane", (scenario) => {
    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }),
    ).toBe(true);
    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "openai/gpt-5.6-luna",
      }),
    ).toBe(false);
  });

  it("reports every declared mismatch in one decision", () => {
    const scenario = makeQaSuiteTestScenario("strict-live-lane", {
      channel: "matrix",
      runtimeParityTier: "live-only",
      config: {
        requiredProviderMode: "live-frontier",
        requiredProvider: "claude-cli",
        requiredModel: "claude-sonnet-4-6",
        authMode: "subscription",
      },
    });

    expect(
      describeQaProviderLaneMismatches({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver: "crabline",
        channel: "telegram",
        claudeCliAuthMode: "api-key",
      }),
    ).toEqual([
      "live provider mode",
      "providerMode=live-frontier",
      "channel=matrix",
      "provider=claude-cli",
      "model=claude-sonnet-4-6",
      "authMode=subscription",
    ]);
  });

  it("keeps provider contracts independent from the selected channel driver", () => {
    const scenario = makeQaSuiteTestScenario("portable-telegram", {
      channel: "telegram",
      config: {
        requiredProvider: "openai",
        requiredModel: "gpt-5.6-luna",
      },
    });

    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
        channelDriver: "crabline",
        channel: "telegram",
      }),
    ).toBe(true);
    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "openai/gpt-5.6-luna",
        channelDriver: "live",
        channel: "telegram",
      }),
    ).toBe(true);
  });

  it("keeps the built-in driver bound to the qa-channel channel", () => {
    const scenario = makeQaSuiteTestScenario("telegram-only", {
      channel: "telegram",
    });

    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver: "qa-channel",
        channel: "telegram",
      }),
    ).toBe(false);
  });

  it("accepts a mock lane only when its selected provider and model satisfy the contract", () => {
    const scenario = makeQaSuiteTestScenario("mock-anthropic", {
      config: {
        requiredProvider: "anthropic",
        requiredModel: "claude-opus-4-8",
      },
    });

    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "anthropic/claude-opus-4-8",
      }),
    ).toBe(true);
    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }),
    ).toBe(false);
  });
});
