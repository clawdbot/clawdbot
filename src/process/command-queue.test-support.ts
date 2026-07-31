import { resetGatewayWorkAdmission } from "./gateway-work-admission.js";

type ActiveTaskWaiterShape = {
  resolve: (value: { drained: boolean }) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

type CommandQueueStateShape = {
  lanes: Map<unknown, unknown>;
  activeTaskWaiters?: Set<ActiveTaskWaiterShape>;
  nextTaskId: number;
  nextQueueSequence?: number;
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
  for (const waiter of Array.from(state.activeTaskWaiters ?? [])) {
    state.activeTaskWaiters?.delete(waiter);
    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
    }
    waiter.resolve({ drained: true });
  }
  state.nextTaskId = 1;
  state.nextQueueSequence = 1;
}
