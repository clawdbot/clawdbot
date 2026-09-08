import type { SessionObserverState } from "./session-observer-model.js";

export function createSessionObserverModelSlots(params: {
  states: Map<string, SessionObserverState>;
  maxSessions: number;
  resolve: (agentId: string) => string | undefined;
  demote: (state: SessionObserverState) => void;
}) {
  const demoted = new WeakSet<SessionObserverState>();
  const requestGenerations = new WeakMap<SessionObserverState, number>();

  return {
    beginRequest(state: SessionObserverState): number {
      const generation = (requestGenerations.get(state) ?? 0) + 1;
      requestGenerations.set(state, generation);
      return generation;
    },

    invalidateRequest(state: SessionObserverState): void {
      requestGenerations.set(state, (requestGenerations.get(state) ?? 0) + 1);
      state.activeController?.abort();
    },

    requestIsCurrent(state: SessionObserverState, generation: number): boolean {
      return requestGenerations.get(state) === generation;
    },

    claim(agentId: string, current?: SessionObserverState): string | undefined {
      const resolved = params.resolve(agentId);
      if (!resolved || current?.utilityModelRef === resolved) {
        return resolved;
      }
      let occupied = 0;
      let evicted: SessionObserverState | undefined;
      for (const state of params.states.values()) {
        if (state === current || !state.utilityModelRef) {
          continue;
        }
        occupied += 1;
        if (
          !state.terminalHealth &&
          !state.finalPending &&
          (!evicted ||
            (state.lastActivityAt - evicted.lastActivityAt ||
              state.sessionKey.localeCompare(evicted.sessionKey)) < 0)
        ) {
          evicted = state;
        }
      }
      if (occupied >= params.maxSessions) {
        if ((current && demoted.has(current)) || !evicted) {
          return undefined;
        }
        demoted.add(evicted);
        params.demote(evicted);
      } else if (current) {
        demoted.delete(current);
      }
      return resolved;
    },
  };
}
