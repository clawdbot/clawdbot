import { describe, expect, it } from "vitest";
import {
  QA_PERSONAL_AGENT_SCENARIO_IDS,
  QA_SCENARIO_PACKS,
  readQaScenarioById,
  resolveQaScenarioPackScenarioIds,
} from "./scenario-catalog.js";

describe("qa scenario packs", () => {
  it("points every pack scenario id at a loadable markdown scenario", () => {
    expect(QA_SCENARIO_PACKS.length).toBeGreaterThan(0);

    for (const pack of QA_SCENARIO_PACKS) {
      expect(pack.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(pack.title.trim()).toBe(pack.title);
      expect(pack.description.trim()).toBe(pack.description);
      expect(pack.scenarioIds.length).toBeGreaterThan(0);
      expect(new Set(pack.scenarioIds).size).toBe(pack.scenarioIds.length);

      for (const scenarioId of pack.scenarioIds) {
        const scenario = readQaScenarioById(scenarioId);

        expect(scenario.id).toBe(scenarioId);
        expect(scenario.execution.kind).toBe("flow");
        expect(scenario.execution.flow?.steps.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the personal-agent pack scoped to the personal scenarios directory", () => {
    const personalPack = QA_SCENARIO_PACKS.find((pack) => pack.id === "personal-agent");

    expect(personalPack?.scenarioIds).toEqual([
      "personal-reminder-roundtrip",
      "personal-channel-thread-reply",
      "personal-memory-preference-recall",
      "personal-redaction-no-secret-leak",
      "personal-tool-safety-followthrough",
    ]);

    for (const scenarioId of personalPack?.scenarioIds ?? []) {
      const scenario = readQaScenarioById(scenarioId);

      expect(scenario.sourcePath).toMatch(/^qa\/scenarios\/personal\//);
      expect(scenario.coverage?.primary.some((id) => id.startsWith("personal."))).toBe(true);
    }
  });

  it("expands the personal-agent pack in pack order", () => {
    expect(resolveQaScenarioPackScenarioIds({ pack: "personal-agent" })).toEqual([
      ...QA_PERSONAL_AGENT_SCENARIO_IDS,
    ]);
  });

  it("combines explicit scenarios with pack scenarios", () => {
    expect(
      resolveQaScenarioPackScenarioIds({
        pack: "personal-agent",
        scenarioIds: ["channel-chat-baseline", "personal-reminder-roundtrip"],
      }),
    ).toEqual(["channel-chat-baseline", ...QA_PERSONAL_AGENT_SCENARIO_IDS]);
  });

  it("rejects unknown scenario packs", () => {
    expect(() => resolveQaScenarioPackScenarioIds({ pack: "personal-admin" })).toThrow(
      '--pack must be one of personal-agent, got "personal-admin"',
    );
  });

  it("keeps personal pack mock debug assertions scoped to each reviewed scenario", () => {
    const redactionFlow = JSON.stringify(
      readQaScenarioById("personal-redaction-no-secret-leak").execution.flow,
    );
    const toolSafetyFlow = JSON.stringify(
      readQaScenarioById("personal-tool-safety-followthrough").execution.flow,
    );
    const memoryScenario = readQaScenarioById("personal-memory-preference-recall");
    const memoryFlow = JSON.stringify(memoryScenario.execution.flow);

    expect(redactionFlow).toContain("config.promptSnippet");
    expect(redactionFlow).toContain("plannedToolName === 'read'");
    expect(redactionFlow).toContain("!newOutbounds.some");

    expect(toolSafetyFlow).toContain("config.preActionPrompt");
    expect(toolSafetyFlow).toContain("preActionOutbound");
    expect(toolSafetyFlow).toContain("request.plannedToolName");
    expect(toolSafetyFlow).toContain("plannedToolName === 'read'");

    expect(memoryFlow).toContain("config.rememberPrompt");
    expect(memoryFlow).toContain("config.recallPrompt");
    expect(memoryScenario.execution.config?.recallPrompt).toContain("Memory tools check");
    expect(memoryFlow).toContain("recallStartIndex");
    expect(memoryFlow).toContain("slice(recallStartIndex)");
    expect(memoryFlow).toContain("recallExpectedAny");
  });
});
