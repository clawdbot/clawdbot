import { describe, expect, it } from "vitest";
import { readQaBootstrapScenarioCatalog, readQaScenarioById } from "../../scenario-catalog.js";

const RENAMED_MATRIX_SCENARIOS = {
  "matrix-thread-follow-up": "thread-follow-up",
  "matrix-thread-isolation": "thread-isolation",
  "matrix-subagent-thread-spawn": "subagent-thread-spawn",
  "matrix-top-level-reply-shape": "channel-top-level-reply-shape",
  "matrix-room-thread-reply-override": "thread-reply-override",
  "matrix-dm-reply-shape": "dm-chat-baseline",
  "matrix-dm-shared-session-notice": "dm-shared-session",
  "matrix-dm-per-room-session-override": "dm-per-room-session",
  "matrix-secondary-room-reply": "channel-secondary-conversation-isolation",
  "matrix-mention-gating": "channel-mention-gating",
  "matrix-observer-allowlist-override": "matrix-allowlist-hot-reload",
  "matrix-allowlist-block": "channel-sender-allowlist",
  "matrix-multi-actor-ordering": "channel-multi-actor-ordering",
} as const;

function isMatrixModuleScenario(
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  if (scenario.execution.kind !== "flow" || scenario.id === "matrix-allowlist-hot-reload") {
    return false;
  }
  return scenario.execution.flow?.steps.some((step) =>
    step.actions.some(
      (action) =>
        typeof action === "object" &&
        action !== null &&
        "value" in action &&
        typeof action.value === "object" &&
        action.value !== null &&
        "expr" in action.value &&
        typeof action.value.expr === "string" &&
        action.value.expr.includes("./live-transports/matrix/scenarios/scenario-runtime-"),
    ),
  );
}

describe("legacy Matrix scenario migration", () => {
  const moduleScenarioIds = readQaBootstrapScenarioCatalog()
    .scenarios.filter(isMatrixModuleScenario)
    .map((scenario) => scenario.id);

  it("maps all 94 former scenario ids to QA Lab scenarios", () => {
    const legacyIds = [...moduleScenarioIds, ...Object.keys(RENAMED_MATRIX_SCENARIOS)];
    expect(legacyIds).toHaveLength(94);
    expect(new Set(legacyIds).size).toBe(94);

    for (const scenarioId of moduleScenarioIds) {
      expect(readQaScenarioById(scenarioId).id).toBe(scenarioId);
    }
    for (const [legacyId, targetId] of Object.entries(RENAMED_MATRIX_SCENARIOS)) {
      expect(readQaScenarioById(targetId).id, legacyId).toBe(targetId);
    }
  });
});
