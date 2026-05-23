import { describe, expect, it } from "vitest";
import {
  QA_OBSERVABILITY_SCENARIO_IDS,
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
      "personal-approval-denial-stop",
      "personal-task-followthrough-status",
      "personal-share-safe-diagnostics-artifact",
      "personal-no-fake-progress",
      "personal-failure-recovery",
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

  it("expands the observability pack in pack order", () => {
    expect(resolveQaScenarioPackScenarioIds({ pack: "observability" })).toEqual([
      ...QA_OBSERVABILITY_SCENARIO_IDS,
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
      '--pack must be one of personal-agent, observability, got "personal-admin"',
    );
  });

  it("keeps personal pack mock debug assertions scoped to each reviewed scenario", () => {
    const redactionFlow = JSON.stringify(
      readQaScenarioById("personal-redaction-no-secret-leak").execution.flow,
    );
    const toolSafetyFlow = JSON.stringify(
      readQaScenarioById("personal-tool-safety-followthrough").execution.flow,
    );
    const approvalDenialFlow = JSON.stringify(
      readQaScenarioById("personal-approval-denial-stop").execution.flow,
    );
    const taskFollowthroughScenario = readQaScenarioById("personal-task-followthrough-status");
    const taskFollowthroughFlow = JSON.stringify(taskFollowthroughScenario.execution.flow);
    const diagnosticsScenario = readQaScenarioById("personal-share-safe-diagnostics-artifact");
    const diagnosticsFlow = JSON.stringify(diagnosticsScenario.execution.flow);
    const noFakeProgressScenario = readQaScenarioById("personal-no-fake-progress");
    const noFakeProgressFlow = JSON.stringify(noFakeProgressScenario.execution.flow);
    const failureRecoveryScenario = readQaScenarioById("personal-failure-recovery");
    const failureRecoveryFlow = JSON.stringify(failureRecoveryScenario.execution.flow);
    const memoryScenario = readQaScenarioById("personal-memory-preference-recall");
    const memoryFlow = JSON.stringify(memoryScenario.execution.flow);

    expect(redactionFlow).toContain("config.promptSnippet");
    expect(redactionFlow).toContain("plannedToolName === 'read'");
    expect(redactionFlow).toContain("!newOutbounds.some");

    expect(toolSafetyFlow).toContain("config.preActionPrompt");
    expect(toolSafetyFlow).toContain("preActionOutbound");
    expect(toolSafetyFlow).toContain("request.plannedToolName");
    expect(toolSafetyFlow).toContain("plannedToolName === 'read'");

    expect(approvalDenialFlow).toContain("config.denialPromptSnippet");
    expect(approvalDenialFlow).toContain("request.plannedToolName");
    expect(approvalDenialFlow).toContain("config.deniedReadMarker");
    expect(approvalDenialFlow).toContain("beforeDenialOutboundCursor");

    expect(taskFollowthroughScenario.execution.config?.prompt).toContain(
      "Personal task followthrough check",
    );
    expect(taskFollowthroughFlow).toContain("personal-task-status.txt");
    expect(taskFollowthroughFlow).toContain("plannedToolName === 'write'");
    expect(taskFollowthroughFlow).toContain("readIndices[1] < firstWrite");
    expect(taskFollowthroughScenario.successCriteria.join("\n").toLowerCase()).toContain("blocked");

    expect(diagnosticsScenario.execution.config?.prompt).toContain(
      "Personal share-safe diagnostics check",
    );
    expect(diagnosticsScenario.execution.config?.artifactName).toBe(
      "personal-diagnostics-summary.txt",
    );
    expect(diagnosticsFlow).toContain("plannedToolName === 'write'");
    expect(diagnosticsFlow).toContain("readIndices[1] < firstWrite");
    expect(diagnosticsFlow).toContain("forbiddenNeedles");
    expect(diagnosticsScenario.successCriteria.join("\n").toLowerCase()).toContain("share-safe");

    expect(noFakeProgressScenario.execution.config?.prompt).toContain(
      "Personal no-fake-progress check",
    );
    expect(noFakeProgressScenario.execution.config?.artifactName).toBe(
      "personal-progress-proof.txt",
    );
    expect(noFakeProgressFlow).toContain("plannedToolName === 'write'");
    expect(noFakeProgressFlow).toContain("readIndices[1] < firstWrite");
    expect(noFakeProgressFlow).toContain("forbiddenNeedles");
    expect(noFakeProgressScenario.successCriteria.join("\n").toLowerCase()).toContain(
      "local evidence",
    );

    expect(failureRecoveryScenario.execution.config?.prompt).toContain(
      "Personal failure recovery check",
    );
    expect(failureRecoveryScenario.execution.config?.artifactName).toBe(
      "personal-failure-recovery.txt",
    );
    expect(failureRecoveryFlow).toContain("plannedToolName === 'write'");
    expect(failureRecoveryFlow).toContain("readIndices[1] < firstWrite");
    expect(failureRecoveryFlow).toContain("length === 1");
    expect(failureRecoveryScenario.successCriteria.join("\n").toLowerCase()).toContain(
      "retry boundary",
    );

    expect(memoryFlow).toContain("config.rememberPrompt");
    expect(memoryFlow).toContain("config.recallPrompt");
    expect(memoryScenario.execution.config?.recallPrompt).toContain("Memory tools check");
    expect(memoryFlow).toContain("recallStartIndex");
    expect(memoryFlow).toContain("slice(recallStartIndex)");
    expect(memoryFlow).toContain("recallExpectedAny");
  });
});
