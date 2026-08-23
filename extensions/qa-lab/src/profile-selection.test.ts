import { describe, expect, it } from "vitest";
import { resolveLiveTransportQaScenarioIds } from "./live-transports/shared/scenario-selection.js";
import {
  resolveQaProfileScenarios,
  resolveQaRunProfileExecutionSelection,
} from "./profile-planning.js";
import { readQaScenarioById, readQaScenarioPack } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";

describe("taxonomy profile scenario selection", () => {
  it("resolves smoke membership from every primary coverage owner", () => {
    const catalog = readQaScenarioPack().scenarios;
    const report = readQaScorecardTaxonomyReport(catalog);
    const profile = report.profiles.find((candidate) => candidate.id === "smoke-ci");
    expect(profile).toBeDefined();
    const selectedCoverageIds = new Set(profile?.coverageIds ?? []);
    const selectedScenarioRefs = new Set(profile?.scenarioRefs ?? []);

    expect(selectedScenarioRefs.size).toBeGreaterThan(0);
    for (const scenario of catalog.filter((candidate) =>
      selectedScenarioRefs.has(candidate.sourcePath),
    )) {
      expect(scenario.coverage?.primary.some((id) => selectedCoverageIds.has(id))).toBe(true);
    }
    for (const coverageId of selectedCoverageIds) {
      const primaryOwners = catalog.filter((scenario) =>
        scenario.coverage?.primary.includes(coverageId),
      );
      expect(primaryOwners.length).toBeGreaterThan(0);
      expect(primaryOwners.every((scenario) => selectedScenarioRefs.has(scenario.sourcePath))).toBe(
        true,
      );
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
    expect(mockTelegram).not.toContain("telegram-assistant-transcript-role-boundary");
    expect(mockTelegram).not.toContain("discord-canary");
  });

  it("lets flow-only consumers exclude a channel-declared script without changing membership", () => {
    const scenario = readQaScenarioById("telegram-startup-getme-live");
    const lane = {
      scenarios: [scenario],
      providerMode: "mock-openai" as const,
      primaryModel: "mock-openai/gpt-5.6-luna",
      channelDriver: "live" as const,
      channel: "telegram",
    };

    expect(resolveQaRunProfileExecutionSelection(lane).selectedScenarios).toEqual([scenario]);
    expect(
      resolveQaRunProfileExecutionSelection({ ...lane, executionKind: "flow" }).excludedScenarios,
    ).toEqual([{ scenario, reasons: ["execution.kind=flow"] }]);
  });
});
