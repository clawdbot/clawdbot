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

  it("keeps real Gateway-hosted proof outside the Crabline smoke profile", () => {
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
