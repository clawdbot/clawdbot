import { describe, expect, it } from "vitest";
import { resolveLiveTransportQaScenarioIds } from "./live-transports/shared/scenario-selection.js";
import { resolveQaProfileScenarios } from "./profile-planning.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

describe("taxonomy profile scenario selection", () => {
  it("resolves smoke membership from primary coverage owners only", () => {
    const catalog = readQaScenarioPack().scenarios;
    const selection = resolveQaProfileScenarios({
      profile: "smoke-ci",
      providerMode: "mock-openai",
    });
    const selectedCoverageIds = new Set(selection.profile.coverageIds);
    const selectedScenarioIds = new Set(selection.scenarios.map((scenario) => scenario.id));

    expect(selection.scenarios.length).toBeGreaterThan(0);
    for (const scenario of selection.scenarios) {
      expect(scenario.coverage?.primary.some((id) => selectedCoverageIds.has(id))).toBe(true);
    }
    for (const coverageId of selectedCoverageIds) {
      const primaryOwners = catalog.filter((scenario) =>
        scenario.coverage?.primary.includes(coverageId),
      );
      const representatives = primaryOwners.filter((scenario) =>
        scenario.coverage?.representative?.includes(coverageId),
      );
      const selectedOwners = primaryOwners.filter((scenario) =>
        selectedScenarioIds.has(scenario.id),
      );

      expect(selectedOwners).toHaveLength(1);
      if (primaryOwners.length > 1) {
        expect(representatives).toHaveLength(1);
        expect(selectedOwners[0]?.id).toBe(representatives[0]?.id);
      }
    }
  });

  it("does not pull unrelated scenarios from a selected coverage category", () => {
    const scenarioPack = readQaScenarioPack();
    const report = readQaScorecardTaxonomyReport(scenarioPack.scenarios);
    const profile = report.profiles.find((candidate) => candidate.id === "smoke-ci");
    expect(profile).toBeDefined();
    const categoryScenarioRefs = new Set(
      report.categories
        .filter((category) => category.profiles.includes("smoke-ci"))
        .flatMap((category) => category.scenarioRefs),
    );
    const profileScenarioRefs = new Set(profile?.scenarioRefs ?? []);
    const unrelatedRefs = [...categoryScenarioRefs].filter((ref) => !profileScenarioRefs.has(ref));

    expect(unrelatedRefs.length).toBeGreaterThan(0);
    expect(
      resolveQaProfileScenarios({ profile: "smoke-ci", providerMode: "mock-openai" }).scenarios,
    ).not.toContainEqual(expect.objectContaining({ sourcePath: unrelatedRefs[0] }));
  });

  it("derives channel defaults from catalog metadata and lane constraints", () => {
    const liveTelegram = resolveLiveTransportQaScenarioIds({
      channelId: "telegram",
      providerMode: "live-frontier",
    });
    const mockTelegram = resolveLiveTransportQaScenarioIds({
      channelId: "telegram",
      providerMode: "mock-openai",
    });

    expect(liveTelegram).toContain("telegram-help-command");
    expect(liveTelegram).not.toContain("telegram-assistant-transcript-role-boundary");
    expect(mockTelegram).toContain("telegram-assistant-transcript-role-boundary");
    expect(mockTelegram).not.toContain("discord-canary");
  });
});
