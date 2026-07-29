import { describe, expect, it } from "vitest";
import { selectQaExecutionShardScenarioIds } from "../../execution-sharding.js";
import { scenarioDeclaresQaChannel } from "../../profile-planning.js";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import { describeQaProviderLaneMismatches } from "../../scenario-lane.js";
import { resolveCatalogLiveTransportQaScenarioIds } from "./scenario-selection.js";

const MOCK_MATRIX_LANE = {
  channelId: "matrix",
  providerMode: "mock-openai" as const,
  primaryModel: "mock-openai/gpt-5.6-luna",
};

describe("catalog live transport QA scenario selection", () => {
  it("derives the implicit set from declared channel and lane eligibility", () => {
    const catalog = readQaScenarioPack().scenarios;
    const scenarioById = new Map(catalog.map((scenario) => [scenario.id, scenario] as const));
    const scenarioIds = resolveCatalogLiveTransportQaScenarioIds(MOCK_MATRIX_LANE);
    const expectedScenarioIds = catalog
      .filter(
        (scenario) =>
          scenarioDeclaresQaChannel(scenario, "matrix") &&
          scenario.execution.kind === "flow" &&
          (scenario.execution.providerMode === undefined ||
            scenario.execution.providerMode === MOCK_MATRIX_LANE.providerMode) &&
          describeQaProviderLaneMismatches({
            scenario,
            ...MOCK_MATRIX_LANE,
            channelDriver: "live",
            channel: "matrix",
          }).length === 0,
      )
      .map((scenario) => scenario.id);

    expect(scenarioIds.length).toBeGreaterThan(0);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    expect(scenarioIds).toEqual(expectedScenarioIds);
    for (const scenarioId of scenarioIds) {
      const scenario = scenarioById.get(scenarioId);
      expect(scenario?.execution.kind, scenarioId).toBe("flow");
      expect(
        scenario?.execution.channel === "matrix" ||
          (scenario?.execution.kind === "flow" && scenario.execution.channels?.includes("matrix")),
        scenarioId,
      ).toBe(true);
    }

    const unrelatedScenario = catalog.find(
      (scenario) =>
        scenario.execution.kind === "flow" &&
        scenario.execution.channel !== "matrix" &&
        !scenario.execution.channels?.includes("matrix"),
    );
    expect(unrelatedScenario).toBeDefined();
    expect(scenarioIds).not.toContain(unrelatedScenario?.id);
  });

  it("preserves an explicit scenario subset without a named profile", () => {
    const explicitScenarioIds = resolveCatalogLiveTransportQaScenarioIds(MOCK_MATRIX_LANE)
      .slice(0, 2)
      .toReversed();

    expect(
      resolveCatalogLiveTransportQaScenarioIds({
        ...MOCK_MATRIX_LANE,
        scenarioIds: explicitScenarioIds,
      }),
    ).toEqual(explicitScenarioIds);
  });

  it("enforces channel, provider, and model constraints for explicit subsets", () => {
    expect(() =>
      resolveCatalogLiveTransportQaScenarioIds({
        ...MOCK_MATRIX_LANE,
        scenarioIds: ["whatsapp-whoami-command"],
      }),
    ).toThrow("channel=whatsapp");
    expect(() =>
      resolveCatalogLiveTransportQaScenarioIds({
        ...MOCK_MATRIX_LANE,
        scenarioIds: ["anthropic-opus-api-key-smoke"],
      }),
    ).toThrow("provider=anthropic");
  });

  it("keeps portable Matrix scenarios eligible through live and Crabline drivers", () => {
    const scenarioIds = ["dm-per-room-session", "dm-shared-session"];
    const selectForDriver = (channelDriver: "crabline" | "live") =>
      resolveCatalogLiveTransportQaScenarioIds({
        ...MOCK_MATRIX_LANE,
        channelDriver,
        scenarioIds,
      });

    expect(selectForDriver("live")).toEqual(scenarioIds);
    expect(selectForDriver("crabline")).toEqual(scenarioIds);
  });

  it("partitions the complete semantic Matrix selection across CI workers", () => {
    const semanticScenarioIds = resolveCatalogLiveTransportQaScenarioIds(MOCK_MATRIX_LANE);
    const shards = [1, 2, 3, 4, 5].map((index) =>
      selectQaExecutionShardScenarioIds(semanticScenarioIds, { index, count: 5 }),
    );

    expect(shards.flat().toSorted()).toEqual(semanticScenarioIds.toSorted());
    expect(new Set(shards.flat()).size).toBe(semanticScenarioIds.length);
    expect(Math.max(...shards.map((shard) => shard.length))).toBeLessThanOrEqual(
      Math.min(...shards.map((shard) => shard.length)) + 1,
    );
  });
});
