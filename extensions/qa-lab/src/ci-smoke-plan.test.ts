// Qa Lab tests cover bounded CI smoke pack planning.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaSmokeCiPart, selectQaSmokeCiEligibilityChannel } from "./ci-smoke-plan.js";
import { resolveQaProfileScenarios } from "./profile-planning.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

const smokeProfileMock = vi.hoisted(() => ({
  mode: "actual" as "actual" | "empty" | "ineligible" | "missing-coverage" | "unsupported",
}));

vi.mock("./profile-planning.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./profile-planning.js")>();
  return {
    ...actual,
    resolveQaProfileScenarios(params: Parameters<typeof actual.resolveQaProfileScenarios>[0]) {
      const selection = actual.resolveQaProfileScenarios(params);
      if (params.profile !== "smoke-ci") {
        return selection;
      }
      if (smokeProfileMock.mode === "empty") {
        return { ...selection, scenarios: [] };
      }
      const scenarioPack = readQaScenarioPack();
      if (smokeProfileMock.mode === "ineligible") {
        const replacement = expectDefined(
          scenarioPack.scenarios.find((scenario) => scenario.id === "otel-trace-smoke"),
          "ineligible smoke replacement",
        );
        return { ...selection, scenarios: [replacement, ...selection.scenarios.slice(1)] };
      }
      if (smokeProfileMock.mode === "missing-coverage") {
        return {
          ...selection,
          scenarios: selection.scenarios.filter(
            (scenario) => !scenario.coverage?.primary.includes("gateway.health-apis"),
          ),
        };
      }
      if (smokeProfileMock.mode === "unsupported") {
        const replacement = expectDefined(
          scenarioPack.scenarios.find((scenario) => scenario.id === "discord-canary"),
          "unsupported smoke replacement",
        );
        return { ...selection, scenarios: [replacement, ...selection.scenarios.slice(1)] };
      }
      return selection;
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
    smokeProfileMock.mode = "actual";
  });

  it.each([4, 6])("balances the bounded smoke pack across %i profile parts", (partCount) => {
    const parts = Array.from({ length: partCount }, (_, index) =>
      createQaSmokeCiPart(`profile-${index + 1}`, partCount),
    );
    const repeatedLast = createQaSmokeCiPart(`profile-${partCount}`, partCount);

    expect(repeatedLast).toEqual(parts.at(-1));
    expect(parts.slice(0, -1).some((part) => part.runs.some((run) => run.slug === "matrix"))).toBe(
      false,
    );
    expect(parts.at(-1)?.runs.some((run) => run.slug === "matrix")).toBe(true);

    const scenarioIds = parts.flatMap((part) => part.runs.flatMap((run) => run.scenario_ids));
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    const scenarioPack = readQaScenarioPack();
    const scenarioById = new Map(
      scenarioPack.scenarios.map((scenario) => [scenario.id, scenario] as const),
    );
    const smokeSelection = resolveQaProfileScenarios({
      profile: "smoke-ci",
      providerMode: "mock-openai",
      eligibleChannels: ["telegram", "matrix"],
    });
    const smokeProfileScenarioIds = smokeSelection.scenarios.map((scenario) => scenario.id);
    expect(new Set(scenarioIds)).toEqual(new Set(smokeProfileScenarioIds));
    expect(
      new Set(scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)?.execution.kind)),
    ).toEqual(new Set(smokeSelection.scenarios.map((scenario) => scenario.execution.kind)));

    const selectedScenarioPaths = new Set(
      scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)?.sourcePath),
    );
    const scorecardReport = readQaScorecardTaxonomyReport([...scenarioById.values()]);
    const taxonomyProfile = expectDefined(
      scorecardReport.profiles.find((profile) => profile.id === "smoke-ci"),
      "smoke-ci taxonomy profile",
    );
    const smokeScenarioRefs = new Set(taxonomyProfile.scenarioRefs);
    expect(
      [...selectedScenarioPaths].every(
        (scenarioPath) => scenarioPath !== undefined && smokeScenarioRefs.has(scenarioPath),
      ),
    ).toBe(true);
    const selectedCoverageIds = new Set(
      smokeSelection.scenarios.flatMap((scenario) =>
        (scenario.coverage?.primary ?? []).filter((coverageId) =>
          taxonomyProfile.coverageIds.includes(coverageId),
        ),
      ),
    );
    expect(selectedCoverageIds).toEqual(new Set(taxonomyProfile.coverageIds));

    const primaryScenarioIds = parts.map(
      (part) => part.runs.find((run) => run.slug === "primary")?.scenario_ids ?? [],
    );
    const scenarioCostsByPart = primaryScenarioIds.map((ids) =>
      ids.map((scenarioId) => estimateScenarioCost(scenarioById.get(scenarioId))),
    );
    // The separate Matrix run reserves three flow-cost points during packing.
    const partCosts = scenarioCostsByPart.map(
      (costs, index) =>
        costs.reduce((total, cost) => total + cost, 0) +
        (parts[index]?.runs.some((run) => run.slug === "matrix") ? 3 : 0),
    );
    const lightestPartCost = Math.min(...partCosts);
    for (const [index, scenarioCosts] of scenarioCostsByPart.entries()) {
      // Mixed-cost parts must stay within one indivisible scenario of the lightest part.
      const partCost = expectDefined(partCosts[index], "QA smoke part cost");
      expect(partCost - lightestPartCost).toBeLessThanOrEqual(Math.min(...scenarioCosts));
    }
    expect(primaryScenarioIds.every((ids) => ids.length > 0)).toBe(true);
  });

  it("keeps real Gateway-hosted proof outside the Crabline channel-driver profile", () => {
    const coverageId = "control-ui.gateway-hosted-ui-control";
    const smokeSelection = resolveQaProfileScenarios({
      profile: "smoke-ci",
      providerMode: "mock-openai",
      eligibleChannels: ["telegram", "matrix"],
    });
    const hostedScenario = expectDefined(
      readQaScenarioPack().scenarios.find(
        (scenario) => scenario.id === "control-ui-qa-channel-image-roundtrip",
      ),
      "real Gateway-hosted Control UI scenario",
    );

    expect(smokeSelection.profile.channelDriver).toBe("crabline");
    expect(smokeSelection.profile.coverageIds).not.toContain(coverageId);
    expect(smokeSelection.scenarios.map((scenario) => scenario.id)).not.toContain(
      hostedScenario.id,
    );
    expect(
      smokeSelection.scenarios.flatMap((scenario) => scenario.coverage?.primary ?? []),
    ).not.toContain(coverageId);
    expect(hostedScenario.execution).toMatchObject({ kind: "flow", channel: "qa-channel" });
    expect(hostedScenario.coverage?.primary).toContain(coverageId);
  });

  it("rejects undeclared profile parts", () => {
    expect(() => createQaSmokeCiPart("profile-5")).toThrow(
      "unknown QA smoke CI profile part: profile-5",
    );
    expect(() => createQaSmokeCiPart("profile-7", 6)).toThrow(
      "unknown QA smoke CI profile part: profile-7",
    );
    expect(() => createQaSmokeCiPart("profile-1", 5)).toThrow(
      "unsupported QA smoke CI profile part count: 5",
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
    smokeProfileMock.mode = "empty";
    expect(() => createQaSmokeCiPart("profile-1")).toThrow(
      "smoke-ci taxonomy profile did not resolve any CI scenarios",
    );
  });

  it("fails when the smoke pack contains a taxonomy-ineligible scenario", () => {
    smokeProfileMock.mode = "ineligible";
    expect(() => createQaSmokeCiPart("profile-1")).toThrow(
      "smoke-ci taxonomy profile resolved ineligible CI scenarios",
    );
  });

  it("fails when the smoke pack contains an unsupported channel", () => {
    smokeProfileMock.mode = "unsupported";
    expect(() => createQaSmokeCiPart("profile-1")).toThrow(
      "smoke-ci taxonomy profile resolved unsupported CI channels: discord",
    );
  });

  it("fails when an exact profile coverage ID has no eligible primary owner", () => {
    smokeProfileMock.mode = "missing-coverage";
    expect(() => createQaSmokeCiPart("profile-1")).toThrow(
      "smoke-ci taxonomy profile leaves coverage IDs without eligible CI scenarios: gateway.health-apis",
    );
  });
});
