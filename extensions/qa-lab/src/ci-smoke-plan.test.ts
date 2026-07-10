// Qa Lab tests cover bounded CI smoke shard planning.
import { describe, expect, it } from "vitest";
import { createQaSmokeCiMatrix } from "./ci-smoke-plan.js";
import { defaultQaModelForMode } from "./model-selection.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";
import {
  scenarioMatchesQaProviderLane,
  scenarioRequiresIsolatedQaSuiteWorker,
} from "./suite-planning.js";

describe("createQaSmokeCiMatrix", () => {
  it("partitions every smoke scenario into bounded channel-compatible shards", () => {
    const first = createQaSmokeCiMatrix();
    const second = createQaSmokeCiMatrix();

    expect(second).toEqual(first);
    expect(first.include.map((shard) => shard.name)).toEqual([
      "matrix",
      "telegram 1/2",
      "telegram 2/2",
    ]);
    expect(first.include).toHaveLength(3);

    const scenarioIds = first.include.flatMap((shard) => shard.scenario_ids);
    const scenarioPack = readQaScenarioPack();
    const taxonomy = readQaScorecardTaxonomyReport(scenarioPack.scenarios);
    const smokeProfile = taxonomy.profiles.find((profile) => profile.id === "smoke-ci");
    if (!smokeProfile) {
      throw new Error("missing smoke-ci taxonomy profile");
    }
    const smokeScenarioPaths = new Set(
      taxonomy.categories
        .filter((category) => category.profiles.includes(smokeProfile.id))
        .flatMap((category) => category.scenarioRefs),
    );
    const expectedScenarioIds = scenarioPack.scenarios
      .filter(
        (scenario) =>
          smokeScenarioPaths.has(scenario.sourcePath) &&
          scenarioMatchesQaProviderLane({
            scenario,
            providerMode: "mock-openai",
            primaryModel: defaultQaModelForMode("mock-openai"),
            channelDriver: smokeProfile.channelDriver,
          }),
      )
      .map((scenario) => scenario.id)
      .toSorted();
    expect(scenarioIds.toSorted()).toEqual(expectedScenarioIds);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    const scenarioById = new Map(
      scenarioPack.scenarios.map((scenario) => [scenario.id, scenario] as const),
    );
    expect(
      new Set(scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)?.execution.kind)),
    ).toEqual(new Set(["flow", "playwright", "script"]));
    expect(scenarioIds).not.toContain("slack-restart-resume");
    expect(scenarioIds).not.toContain("whatsapp-restart-resume");
    expect(first.include.every((shard) => shard.scenario_ids.length > 0)).toBe(true);

    const telegramShards = first.include.filter((shard) => shard.channel === "telegram");
    expect(telegramShards).toHaveLength(2);
    const telegramWeights = telegramShards.map((shard) =>
      shard.scenario_ids.reduce((weight, scenarioId) => {
        const scenario = scenarioById.get(scenarioId);
        if (!scenario) {
          throw new Error(`missing QA scenario ${scenarioId}`);
        }
        if (scenario.execution.kind === "script") {
          return weight + 8;
        }
        if (scenario.execution.kind === "playwright") {
          return weight + 6;
        }
        if (scenario.execution.kind === "vitest") {
          return weight + 4;
        }
        return weight + (scenarioRequiresIsolatedQaSuiteWorker(scenario) ? 3 : 1);
      }, 0),
    );
    expect(Math.abs(telegramWeights[0] - telegramWeights[1])).toBeLessThanOrEqual(1);
  });
});
