import type { ScenarioOutcome, SeedScenario, UiState } from "./ui-types.js";

export function findScenarioOutcome(state: UiState, scenario: SeedScenario) {
  return (
    state.scenarioRun?.scenarios.find((o) => o.id === scenario.id) ??
    state.scenarioRun?.scenarios.find((o) => o.name === scenario.title) ??
    null
  );
}

export function statusDotClass(status: ScenarioOutcome["status"] | "pending"): string {
  return `scenario-item-dot scenario-item-dot-${status}`;
}
