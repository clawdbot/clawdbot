// Qa Lab tests cover bounded CI smoke profile planning.
import { OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createQaSmokeCiPart } from "./ci-smoke-plan.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

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
  it("balances the bounded automatic smoke set across four profile parts", () => {
    const parts = ["profile-1", "profile-2", "profile-3", "profile-4"].map((partId) =>
      createQaSmokeCiPart(partId),
    );
    const repeatedLast = createQaSmokeCiPart("profile-4");

    expect(repeatedLast).toEqual(parts[3]);
    for (const part of parts) {
      expect(part.runs[0]?.channel).toBe(OPENCLAW_CRABLINE_DEFAULT_CHANNEL);
    }
    // The matrix channel run rides only on the last part.
    expect(
      parts.slice(0, 3).some((part) => part.runs.some((run) => run.channel === "matrix")),
    ).toBe(false);
    expect(parts[3]?.runs.some((run) => run.channel === "matrix")).toBe(true);

    const scenarioIds = parts.flatMap((part) => part.runs.flatMap((run) => run.scenario_ids));
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    const scenarioById = new Map(
      readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
    );
    expect(
      new Set(scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)?.execution.kind)),
    ).toEqual(new Set(["flow", "playwright", "script"]));
    expect(scenarioIds).toHaveLength(12);
    expect(scenarioIds).toContain("control-ui-chat-flow-playwright");
    expect(scenarioIds).toContain("gateway-smoke");
    expect(scenarioIds).toContain("matrix-restart-resume");

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

    const primaryScenarioIds = parts.map(
      (part) => part.runs.find((run) => run.slug === "primary")?.scenario_ids ?? [],
    );
    expect(primaryScenarioIds[1]).toContain("system-agent-ring-zero-setup");
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
    // Greedy balance: no part carries more than one heaviest-scenario cost
    // beyond the lightest, and every part runs at least one scenario.
    expect(heaviestRunCost - lightestRunCost).toBeLessThanOrEqual(largestScenarioCost);
    expect(primaryScenarioIds.every((ids) => ids.length > 0)).toBe(true);
  });

  it("rejects undeclared profile parts", () => {
    expect(() => createQaSmokeCiPart("profile-5")).toThrow(
      "unknown QA smoke CI profile part: profile-5",
    );
  });
});
