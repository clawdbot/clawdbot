// Qa Lab tests cover bounded CI smoke pack planning.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaSmokeCiPart, selectQaSmokeCiEligibilityChannel } from "./ci-smoke-plan.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./model-selection.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { scenarioMatchesQaProviderLane } from "./scenario-lane.js";
import { resolveQaScenarioPackScenarioIds } from "./scenario-packs.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

const smokePackMock = vi.hoisted(() => ({
  mode: "actual" as "actual" | "empty" | "ineligible" | "unsupported",
}));

vi.mock("./scenario-packs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scenario-packs.js")>();
  return {
    ...actual,
    resolveQaScenarioPackScenarioIds(
      params: Parameters<typeof actual.resolveQaScenarioPackScenarioIds>[0],
    ) {
      const scenarioIds = actual.resolveQaScenarioPackScenarioIds(params);
      if (params.pack !== "smoke-ci") {
        return scenarioIds;
      }
      if (smokePackMock.mode === "empty") {
        return [];
      }
      if (smokePackMock.mode === "ineligible") {
        return ["otel-trace-smoke", ...scenarioIds.slice(1)];
      }
      if (smokePackMock.mode === "unsupported") {
        return ["discord-canary", ...scenarioIds.slice(1)];
      }
      return scenarioIds;
    },
  };
});

type QaScenario = ReturnType<typeof readQaScenarioPack>["scenarios"][number];

function estimateScenarioCost(scenario: QaScenario | undefined): number {
  if (!scenario) {
    throw new Error("QA smoke plan selected an unknown scenario.");
  }
  if (scenario.execution.kind === "script") {
    return 8;
  }
  if (scenario.execution.kind === "playwright") {
    return 6;
  }
  return scenario.execution.kind === "flow" && scenario.execution.isolationReason ? 4 : 1;
}

describe("createQaSmokeCiPart", () => {
  afterEach(() => {
    smokePackMock.mode = "actual";
  });

  it("balances the bounded smoke pack across four profile parts", () => {
    const parts = ["profile-1", "profile-2", "profile-3", "profile-4"].map((partId) =>
      createQaSmokeCiPart(partId),
    );
    const repeatedLast = createQaSmokeCiPart("profile-4");

    expect(repeatedLast).toEqual(parts[3]);
    expect(parts.slice(0, 3).some((part) => part.runs.some((run) => run.slug === "matrix"))).toBe(
      false,
    );
    expect(parts[3]?.runs.some((run) => run.slug === "matrix")).toBe(true);

    const scenarioIds = parts.flatMap((part) => part.runs.flatMap((run) => run.scenario_ids));
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    const scenarioPack = readQaScenarioPack();
    const scenarioById = new Map(
      scenarioPack.scenarios.map((scenario) => [scenario.id, scenario] as const),
    );
    const smokePackScenarioIds = resolveQaScenarioPackScenarioIds({ pack: "smoke-ci" });
    expect(smokePackScenarioIds).toHaveLength(12);
    expect(new Set(scenarioIds)).toEqual(new Set(smokePackScenarioIds));
    expect(
      new Set(scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)?.execution.kind)),
    ).toEqual(new Set(["flow", "playwright", "script"]));
    const selectedScenarioPaths = new Set(
      scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)?.sourcePath),
    );
    const scorecardReport = readQaScorecardTaxonomyReport([...scenarioById.values()]);
    const smokeScenarioRefs = new Set(
      scorecardReport.categories
        .filter((category) => category.profiles.includes("smoke-ci"))
        .flatMap((category) => category.scenarioRefs),
    );
    expect(
      [...selectedScenarioPaths].every(
        (scenarioPath) => scenarioPath !== undefined && smokeScenarioRefs.has(scenarioPath),
      ),
    ).toBe(true);
    const uncoveredCategoryIds = scorecardReport.categories
      .filter((category) => category.profiles.includes("smoke-ci"))
      .filter((category) => !category.scenarioRefs.some((ref) => selectedScenarioPaths.has(ref)))
      .map((category) => category.id);
    expect(uncoveredCategoryIds).toEqual([]);

    const smokePackScenarioIdSet = new Set(smokePackScenarioIds);
    const taxonomyProfile = expectDefined(
      scorecardReport.profiles.find((profile) => profile.id === "smoke-ci"),
      "smoke-ci taxonomy profile",
    );
    const providerMode = normalizeQaProviderMode("mock-openai");
    const primaryModel = defaultQaModelForMode(providerMode);
    const eligibleScenariosOutsidePack = scenarioPack.scenarios.filter(
      (scenario) =>
        smokeScenarioRefs.has(scenario.sourcePath) &&
        !smokePackScenarioIdSet.has(scenario.id) &&
        scenarioMatchesQaProviderLane({
          scenario,
          providerMode,
          primaryModel,
          channelDriver: taxonomyProfile.channelDriver,
          channel: scenario.execution.channel,
        }),
    );
    expect(eligibleScenariosOutsidePack.length).toBeGreaterThan(0);
    expect(
      eligibleScenariosOutsidePack.every((scenario) => !scenarioIds.includes(scenario.id)),
    ).toBe(true);

    const primaryScenarioIds = parts.map(
      (part) => part.runs.find((run) => run.slug === "primary")?.scenario_ids ?? [],
    );
    const primaryRunCosts = primaryScenarioIds.map((ids) =>
      ids.reduce(
        (cost, scenarioId) => cost + estimateScenarioCost(scenarioById.get(scenarioId)),
        0,
      ),
    );
    const largestScenarioCost = Math.max(
      ...primaryScenarioIds.flatMap((ids) =>
        ids.map((scenarioId) => estimateScenarioCost(scenarioById.get(scenarioId))),
      ),
    );
    const heaviestRunCost = expectDefined(
      primaryRunCosts.toSorted((left, right) => right - left)[0],
      "heaviest QA smoke run cost",
    );
    const lightestRunCost = expectDefined(
      primaryRunCosts.toSorted((left, right) => left - right)[0],
      "lightest QA smoke run cost",
    );
    expect(heaviestRunCost - lightestRunCost).toBeLessThanOrEqual(largestScenarioCost);
    expect(primaryScenarioIds.every((ids) => ids.length > 0)).toBe(true);
  });

  it("rejects undeclared profile parts", () => {
    expect(() => createQaSmokeCiPart("profile-5")).toThrow(
      "unknown QA smoke CI profile part: profile-5",
    );
  });

  it("accepts a portable multi-channel scenario through a supported CI channel", () => {
    const scenario = expectDefined(
      readQaScenarioPack().scenarios.find((candidate) => candidate.id === "channel-message-flows"),
      "channel-message-flows scenario",
    );

    expect(scenario.execution).toMatchObject({ channels: ["qa-channel", "telegram"] });
    expect(selectQaSmokeCiEligibilityChannel(scenario)).toBe("telegram");
  });

  it("fails when the smoke pack resolves empty", () => {
    smokePackMock.mode = "empty";
    expect(() => createQaSmokeCiPart("profile-1")).toThrow(
      "smoke-ci scenario pack did not resolve any CI scenarios",
    );
  });

  it("fails when the smoke pack contains a taxonomy-ineligible scenario", () => {
    smokePackMock.mode = "ineligible";
    expect(() => createQaSmokeCiPart("profile-1")).toThrow(
      "smoke-ci scenario pack resolved ineligible CI scenarios",
    );
  });

  it("fails when the smoke pack contains an unsupported channel", () => {
    smokePackMock.mode = "unsupported";
    expect(() => createQaSmokeCiPart("profile-1")).toThrow(
      "smoke-ci scenario pack resolved unsupported CI channels: discord",
    );
  });
});
