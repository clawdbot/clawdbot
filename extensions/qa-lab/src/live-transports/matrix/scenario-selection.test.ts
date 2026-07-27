import { describe, expect, it } from "vitest";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import {
  listMatrixQaScenarioIds,
  resolveMatrixQaScenarioIds,
  shardMatrixQaScenarioIds,
} from "./scenario-selection.js";

describe("QA Lab Matrix scenario selection", () => {
  it("derives the default set from explicit Matrix channel eligibility", () => {
    const catalog = readQaScenarioPack().scenarios;
    const scenarioById = new Map(catalog.map((scenario) => [scenario.id, scenario] as const));
    const scenarioIds = listMatrixQaScenarioIds();

    expect(scenarioIds.length).toBeGreaterThan(0);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
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
    const explicitScenarioIds = listMatrixQaScenarioIds().slice(0, 2).toReversed();

    expect(resolveMatrixQaScenarioIds({ scenarioIds: explicitScenarioIds })).toEqual(
      explicitScenarioIds,
    );
  });

  it("balances deterministic shards independently of input order", () => {
    const scenarioIds = listMatrixQaScenarioIds();
    const shardValues = ["1/5", "2/5", "3/5", "4/5", "5/5"] as const;
    const shards = shardValues.map((shard) => shardMatrixQaScenarioIds(scenarioIds, shard));
    const sizes = shards.map((shard) => shard.length);

    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(shards.flat().toSorted()).toEqual(scenarioIds.toSorted());
    expect(new Set(shards.flat()).size).toBe(scenarioIds.length);
    expect(shardMatrixQaScenarioIds(scenarioIds.toReversed(), shardValues[0])).toEqual(shards[0]);
  });

  it("rejects invalid and empty shard selections honestly", () => {
    expect(() => shardMatrixQaScenarioIds(["scenario"], "0/5")).toThrow("Expected <index>/<total>");
    expect(() => shardMatrixQaScenarioIds(["scenario"], "2/5")).toThrow("resolved no scenarios");
  });
});
