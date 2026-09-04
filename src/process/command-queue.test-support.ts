import { resetGatewayWorkAdmission } from "./gateway-work-admission.js";

type CommandQueueStateShape = {
  lanes: Map<unknown, unknown>;
  nextTaskId: number;
  nextQueueSequence?: number;
  laneGroups?: Map<unknown, unknown>;
  laneGroupByLane?: Map<unknown, unknown>;
};

/** Hard-reset the process-global command queue between isolated tests. */
export function resetCommandQueueStateForTest(): void {
  resetGatewayWorkAdmission();
  const key = Symbol.for("openclaw.commandQueueState");
  const state = (globalThis as Record<PropertyKey, unknown>)[key] as
    | CommandQueueStateShape
    | undefined;
  if (!state) {
    return;
  }

  state.lanes.clear();
  state.laneGroups?.clear();
  state.laneGroupByLane?.clear();
  state.nextTaskId = 1;
  state.nextQueueSequence = 1;
}
