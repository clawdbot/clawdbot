// Qa Lab tests cover bounded CI smoke profile planning.
import { OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import { describe, expect, it } from "vitest";
import { createQaSmokeCiPart } from "./ci-smoke-plan.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

describe("createQaSmokeCiPart", () => {
  it("balances the bounded automatic smoke set across two profile parts", () => {
    const first = createQaSmokeCiPart("profile-1");
    const second = createQaSmokeCiPart("profile-2");
    const repeatedSecond = createQaSmokeCiPart("profile-2");

    expect(repeatedSecond).toEqual(second);
    expect(first.runs[0]?.channel).toBe(OPENCLAW_CRABLINE_DEFAULT_CHANNEL);
    expect(second.runs[0]?.channel).toBe(OPENCLAW_CRABLINE_DEFAULT_CHANNEL);
    expect(first.runs.some((run) => run.channel === "matrix")).toBe(false);
    expect(second.runs.some((run) => run.channel === "matrix")).toBe(true);

    const scenarioIds = [...first.runs, ...second.runs].flatMap((run) => run.scenario_ids);
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
    const uncoveredCategoryIds = scorecardReport.categories
      .filter((category) => category.profiles.includes("smoke-ci"))
      .filter((category) => !category.scenarioRefs.some((ref) => selectedScenarioPaths.has(ref)))
      .map((category) => category.id);
    expect(uncoveredCategoryIds).toEqual([]);

    const primaryRunSizes = [first, second].map(
      (part) => part.runs.find((run) => run.slug === "primary")?.scenario_ids.length ?? 0,
    );
    expect(Math.abs(primaryRunSizes[0] - primaryRunSizes[1])).toBeLessThanOrEqual(2);
  });

  it("rejects undeclared profile parts", () => {
    expect(() => createQaSmokeCiPart("profile-3")).toThrow(
      "unknown QA smoke CI profile part: profile-3",
    );
  });
});
