// Qa Lab tests cover canonical live-transport scenario delegation.
import { describe, expect, it, vi } from "vitest";

const { runQaFlowSuiteFromRuntime } = vi.hoisted(() => ({
  runQaFlowSuiteFromRuntime: vi.fn(),
}));

vi.mock("../../suite-launch.runtime.js", () => ({
  runQaFlowSuiteFromRuntime,
}));
import {
  assertKnownScenarioIds,
  partitionCanonicalScenarioIds,
  TELEGRAM_CANONICAL_SCENARIO_IDS,
  TELEGRAM_DEFAULT_CANONICAL_SCENARIO_IDS,
  WHATSAPP_CANONICAL_SCENARIO_IDS,
  WHATSAPP_MOCK_DEFAULT_CANONICAL_SCENARIO_IDS,
  whatsappDefaultCanonicalScenarioIds,
  listCanonicalScenarios,
  runCanonicalLiveScenarios,
} from "./canonical-scenarios.js";
import { loadNonYamlScenarioRefs } from "./live-transport-scenarios.js";

describe("canonical live-transport scenarios", () => {
  it("loads every migrated routing, command, and session-context scenario from YAML", () => {
    const telegram = listCanonicalScenarios({
      ids: TELEGRAM_CANONICAL_SCENARIO_IDS,
      defaultIds: TELEGRAM_DEFAULT_CANONICAL_SCENARIO_IDS,
    });
    const whatsapp = listCanonicalScenarios({
      ids: WHATSAPP_CANONICAL_SCENARIO_IDS,
      defaultIds: WHATSAPP_MOCK_DEFAULT_CANONICAL_SCENARIO_IDS,
    });

    expect(telegram.map(({ id }) => id).toSorted()).toEqual(
      [...TELEGRAM_CANONICAL_SCENARIO_IDS].toSorted(),
    );
    expect(whatsapp.map(({ id }) => id).toSorted()).toEqual(
      [...WHATSAPP_CANONICAL_SCENARIO_IDS].toSorted(),
    );
    expect(telegram.filter(({ defaultEnabled }) => defaultEnabled).map(({ id }) => id)).toEqual(
      expect.arrayContaining([...TELEGRAM_DEFAULT_CANONICAL_SCENARIO_IDS]),
    );
    expect(whatsapp.filter(({ defaultEnabled }) => defaultEnabled).map(({ id }) => id)).toEqual(
      expect.arrayContaining([...WHATSAPP_MOCK_DEFAULT_CANONICAL_SCENARIO_IDS]),
    );
    expect(whatsappDefaultCanonicalScenarioIds("live-frontier")).toEqual(["whatsapp-help-command"]);
    expect(telegram.find(({ id }) => id === "telegram-status-command")?.regressionRefs).toEqual([
      "openclaw/openclaw#74698",
    ]);
  });

  it("partitions canonical aliases from remaining imperative scenarios", () => {
    expect(
      partitionCanonicalScenarioIds(
        ["telegram-help-command", "telegram-mentioned-message-reply"],
        TELEGRAM_CANONICAL_SCENARIO_IDS,
      ),
    ).toEqual({
      canonical: ["telegram-help-command"],
      legacy: ["telegram-mentioned-message-reply"],
    });
  });

  it("rejects unknown legacy ids before either live runner starts", () => {
    expect(() =>
      assertKnownScenarioIds({
        ids: ["known", "missing"],
        knownIds: ["known"],
        laneLabel: "Demo",
      }),
    ).toThrow("unknown Demo QA scenario id(s): missing");
  });

  it("runs canonical live aliases through the runtime lab launcher", async () => {
    runQaFlowSuiteFromRuntime.mockResolvedValueOnce({ summaryPath: "/tmp/summary.json" });
    const sutOpenClawCommand = {
      executablePath: "/usr/local/bin/openclaw-telegram-sut-launcher",
      usePackagedPlugins: true,
    };

    await runCanonicalLiveScenarios({
      channelId: "telegram",
      factory: {
        id: "telegram",
        matches: () => true,
        create: vi.fn(),
      },
      options: {
        providerMode: "mock-openai",
        repoRoot: "/tmp/openclaw-repo",
        sutOpenClawCommand,
      },
      scenarioIds: ["telegram-help-command"],
    });

    expect(runQaFlowSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        channelDriver: "live",
        channelId: "telegram",
        scenarioIds: ["telegram-help-command"],
        sutOpenClawCommand,
      }),
    );
  });

  it("removes migrated ids from non-YAML scenario ownership", async () => {
    const nonYamlIds = new Set((await loadNonYamlScenarioRefs()).map(({ id }) => id));

    for (const scenarioId of [
      ...TELEGRAM_CANONICAL_SCENARIO_IDS,
      ...WHATSAPP_CANONICAL_SCENARIO_IDS,
    ]) {
      expect(nonYamlIds.has(scenarioId), scenarioId).toBe(false);
    }
  });
});
