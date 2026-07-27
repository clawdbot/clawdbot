// Qa Lab tests prove taxonomy selection precedes deterministic CI sharding.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createQaSmokeCiShard,
  selectQaSmokeCiEligibilityChannel,
  selectQaSmokeCiScenarios,
} from "./ci-smoke-plan.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

describe("QA smoke CI planning", () => {
  it("resolves one eligible scenario for every taxonomy coverage anchor", () => {
    const scenarioPack = readQaScenarioPack();
    const selected = selectQaSmokeCiScenarios();
    const report = readQaScorecardTaxonomyReport(scenarioPack.scenarios);
    const profile = expectDefined(
      report.profiles.find((candidate) => candidate.id === "smoke-ci"),
      "smoke-ci taxonomy profile",
    );
    const selectedPaths = new Set(selected.map((scenario) => scenario.sourcePath));
    const profileScenarioPaths = new Set(
      report.categories
        .filter((category) => category.profiles.includes(profile.id))
        .flatMap((category) => category.scenarioRefs),
    );

    expect(profile.coverageIds).toHaveLength(12);
    expect(selected).toHaveLength(profile.coverageIds.length);
    expect(new Set(selected.map((scenario) => scenario.id)).size).toBe(selected.length);
    expect([...selectedPaths].every((scenarioPath) => profileScenarioPaths.has(scenarioPath))).toBe(
      true,
    );
    for (const coverageId of profile.coverageIds) {
      expect(
        selected.filter((scenario) =>
          [...(scenario.coverage?.primary ?? []), ...(scenario.coverage?.secondary ?? [])].includes(
            coverageId,
          ),
        ),
      ).toHaveLength(1);
    }
    expect(new Set(selected.map((scenario) => scenario.execution.kind))).toEqual(
      new Set(["flow", "playwright", "script"]),
    );
  });

  it("shards deterministically after semantic selection", () => {
    const selectedIds = selectQaSmokeCiScenarios().map((scenario) => scenario.id);
    const shards = ["shard-1", "shard-2", "shard-3", "shard-4"].map((shardId) =>
      createQaSmokeCiShard(shardId),
    );

    expect(createQaSmokeCiShard("shard-4")).toEqual(shards[3]);
    expect(
      shards.slice(0, 3).every((shard) => shard.runs.every((run) => run.slug !== "matrix")),
    ).toBe(true);
    expect(shards[3]?.runs.some((run) => run.slug === "matrix")).toBe(true);
    const shardedIds = shards.flatMap((shard) => shard.runs.flatMap((run) => run.scenario_ids));
    expect(new Set(shardedIds)).toEqual(new Set(selectedIds));
    expect(shardedIds).toHaveLength(selectedIds.length);
  });

  it("rejects undeclared shard ids", () => {
    expect(() => createQaSmokeCiShard("shard-5")).toThrow("unknown QA smoke CI shard: shard-5");
  });

  it("selects a supported transport for portable channel scenarios", () => {
    const scenario = expectDefined(
      readQaScenarioPack().scenarios.find((candidate) => candidate.id === "channel-message-flows"),
      "channel-message-flows scenario",
    );

    expect(scenario.execution).toMatchObject({ channels: ["qa-channel", "telegram"] });
    expect(selectQaSmokeCiEligibilityChannel(scenario)).toBe("telegram");
  });
});
