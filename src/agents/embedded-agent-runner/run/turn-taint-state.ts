import type { ToolOutcomeObservation } from "../../agent-tools.before-tool-call.js";

/** Sticky current-turn taint shared by retries and runtime-specific tool owners. */
export function createAgentTurnTaintState() {
  let tainted = false;
  return {
    observe(observation: ToolOutcomeObservation): void {
      if (!observation.presentationOnly && observation.resultContentSource === "network") {
        tainted = true;
      }
    },
    isTainted: () => tainted,
  };
}
