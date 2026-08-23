// QA Lab tests cover canonical scenario lane matching behavior.
import { describe, expect, it } from "vitest";
import type { QaProviderMode } from "./model-selection.js";
import { resolveQaRunProfileExecutionSelection } from "./profile-planning.js";
import { readQaScenarioById, readQaScenarioPack } from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";
import {
  describeQaProviderLaneMismatches,
  expandQaScenarioExecutionCells,
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

  it("expands scheduler cells deterministically across flow and native scenarios", () => {
    const cells = expandQaScenarioExecutionCells({
      scenarios: [
        readQaScenarioById("thread-isolation"),
        readQaScenarioById("control-ui-chat-flow-playwright"),
      ],
      channelDriver: "live",
      supportsChannel: (channel) => channel === "matrix" || channel === "slack",
      expandChannels: true,
    });

    expect(cells).toEqual([
      { scenarioId: "thread-isolation", executionKind: "flow", channel: "slack" },
      { scenarioId: "thread-isolation", executionKind: "flow", channel: "matrix" },
      {
        scenarioId: "control-ui-chat-flow-playwright",
        executionKind: "playwright",
        channel: null,
      },
    ]);
  });

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

  it.each([
    {
      id: "cron-empty-response-after-write-recovery",
      allowedProviderMode: "mock-openai" as const,
      rejectedProviderMode: "live-frontier" as const,
    },
    {
      id: "subagent-completion-direct-fallback",
      allowedProviderMode: "mock-openai" as const,
      rejectedProviderMode: "live-frontier" as const,
    },
    {
      id: "cron-explicit-authority-execution",
      allowedProviderMode: "live-frontier" as const,
      rejectedProviderMode: "mock-openai" as const,
    },
  ])(
    "keeps $id on its required $allowedProviderMode provider lane",
    ({ id, allowedProviderMode, rejectedProviderMode }) => {
      const scenario = readQaScenarioById(id);
      const modelForMode = (mode: QaProviderMode) =>
        mode === "mock-openai" ? "mock-openai/gpt-5.6-luna" : "openai/gpt-5.6-luna";

      expect(
        scenarioMatchesQaProviderLane({
          scenario,
          providerMode: allowedProviderMode,
          primaryModel: modelForMode(allowedProviderMode),
        }),
      ).toBe(true);
      const rejected = {
        scenario,
        providerMode: rejectedProviderMode,
        primaryModel: modelForMode(rejectedProviderMode),
      };
      expect(scenarioMatchesQaProviderLane(rejected)).toBe(false);
      expect(describeQaProviderLaneMismatches(rejected)).toContain(
        `providerMode=${allowedProviderMode}`,
      );
    },
  );

  it.each(["matrix-room-block-streaming", "matrix-voice-preflight-mention"])(
    "keeps the scenario-pinned provider for %s out of the live provider lane",
    (scenarioId) => {
      const scenario = readQaScenarioById(scenarioId);
      const liveLane = {
        scenario,
        providerMode: "live-frontier" as const,
        primaryModel: "openai/gpt-5.6-luna",
        channelDriver: "live" as const,
        channel: "matrix",
        supportsModuleFlows: true,
      };

      expect(scenarioMatchesQaProviderLane(liveLane)).toBe(false);
      expect(describeQaProviderLaneMismatches(liveLane)).toEqual(["providerMode=mock-openai"]);
    },
  );

  it("excludes a mock-pinned Matrix scenario from a live profile execution", () => {
    const scenario = readQaScenarioById("matrix-room-block-streaming");

    expect(
      resolveQaRunProfileExecutionSelection({
        scenarios: [scenario],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
        channelDriver: "live",
        channel: "matrix",
        resolveModuleFlowSupport: () => true,
      }),
    ).toEqual({
      selectedScenarios: [],
      excludedScenarios: [{ scenario, reasons: ["providerMode=mock-openai"] }],
    });
  });

  it("treats matching execution and config provider pins as one lane requirement", () => {
    const scenario = requireFlowScenario(
      makeQaSuiteTestScenario("matching-provider-modes", {
        config: { requiredProviderMode: "mock-openai" },
      }),
    );
    scenario.execution.providerMode = "mock-openai";

    expect(
      describeQaProviderLaneMismatches({
        scenario,
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }),
    ).toEqual(["providerMode=mock-openai"]);
    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }),
    ).toBe(true);
  });

  it.each(["mock-openai", "live-frontier"] as const)(
    "rejects conflicting execution and config provider pins on the %s lane",
    (providerMode) => {
      const scenario = requireFlowScenario(
        makeQaSuiteTestScenario("conflicting-provider-modes", {
          config: { requiredProviderMode: "live-frontier" },
        }),
      );
      scenario.execution.providerMode = "mock-openai";

      expect(() =>
        describeQaProviderLaneMismatches({
          scenario,
          providerMode,
          primaryModel: "openai/gpt-5.6-luna",
        }),
      ).toThrow(
        "QA scenario conflicting-provider-modes declares conflicting provider modes: execution.providerMode=mock-openai, execution.config.requiredProviderMode=live-frontier",
      );
    },
  );

  it("keeps multi-channel metadata as OR eligibility while exposing every supported lane", () => {
    const scenario = readQaScenarioById("thread-isolation");

    expect(
      expandQaScenarioExecutionCells({
        scenarios: [scenario],
        channelDriver: "live",
        supportsChannel: (channel) => channel === "slack" || channel === "matrix",
        expandChannels: true,
      }),
    ).toEqual([
      { scenarioId: scenario.id, executionKind: "flow", channel: "slack" },
      { scenarioId: scenario.id, executionKind: "flow", channel: "matrix" },
    ]);
  });

  it("reports every declared mismatch in one decision", () => {
    const scenario = makeQaSuiteTestScenario("strict-live-lane", {
      channel: "matrix",
      runtimePairLane: "core",
      config: {
        requiredProviderMode: "live-frontier",
        requiredChannelDriver: "live",
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
      "providerMode=live-frontier",
      "channelDriver=live",
      "channel=matrix",
      "provider=claude-cli",
      "model=claude-sonnet-4-6",
      "authMode=subscription",
    ]);
  });

  it.each(["crabline", "live"] as const)(
    "keeps provider, model, and auth contracts independent from the $channelDriver driver",
    (channelDriver) => {
      const scenario = makeQaSuiteTestScenario("portable-telegram", {
        channel: "telegram",
        config: {
          requiredProvider: "claude-cli",
          requiredModel: "claude-sonnet-4-6",
          authMode: "subscription",
        },
      });

      expect(
        scenarioMatchesQaProviderLane({
          scenario,
          providerMode: "live-frontier",
          primaryModel: "claude-cli/claude-sonnet-4-6",
          channelDriver,
          channel: "telegram",
          claudeCliAuthMode: "subscription",
        }),
      ).toBe(true);
      expect(
        describeQaProviderLaneMismatches({
          scenario,
          providerMode: "mock-openai",
          primaryModel: "openai/gpt-5.6-luna",
          channelDriver,
          channel: "telegram",
          claudeCliAuthMode: "api-key",
        }),
      ).toEqual(["provider=claude-cli", "model=claude-sonnet-4-6", "authMode=subscription"]);
    },
  );

  it("enforces an explicit channel driver contract", () => {
    const scenario = makeQaSuiteTestScenario("live-only", {
      channel: "matrix",
      config: { requiredChannelDriver: "live" },
    });

    expect(
      describeQaProviderLaneMismatches({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver: "crabline",
        channel: "matrix",
      }),
    ).toEqual(["channelDriver=live"]);
    expect(
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver: "live",
        channel: "matrix",
      }),
    ).toBe(true);
  });

  it("keeps module-flow support independent from driver and channel constraints", () => {
    const scenario = makeQaSuiteTestScenario("matrix-module", {
      channel: "matrix",
      flowKind: "module",
      config: { requiredChannelDriver: "live" },
    });

    expect(
      describeQaProviderLaneMismatches({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver: "crabline",
        channel: "telegram",
      }),
    ).toEqual([
      "channelDriver=live",
      "channel=matrix",
      "module flow unsupported by implementation=crabline:telegram",
    ]);
    expect(
      describeQaProviderLaneMismatches({
        scenario,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver: "live",
        channel: "matrix",
        supportsModuleFlows: true,
      }),
    ).toEqual([]);
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

  it.each([
    { channelDriver: "qa-channel" as const, channel: undefined, matches: true },
    { channelDriver: "crabline" as const, channel: "telegram", matches: true },
    { channelDriver: "crabline" as const, channel: "discord", matches: false },
  ])(
    "matches channel streaming evidence for $channelDriver channel $channel: $matches",
    ({ channelDriver, channel, matches }) => {
      const scenario = readQaScenarioById("channel-message-flows");

      expect(
        scenarioMatchesQaProviderLane({
          scenario,
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          channelDriver,
          channel,
        }),
      ).toBe(matches);
    },
  );

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
