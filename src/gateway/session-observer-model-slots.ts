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
      const occupied = [...params.states.values()].filter(
        (state) => state !== current && state.utilityModelRef,
      );
      if (current && demoted.has(current)) {
        if (occupied.length >= params.maxSessions) {
          return undefined;
        }
        demoted.delete(current);
        return resolved;
      }
      if (occupied.length >= params.maxSessions) {
        const evicted = occupied
          .filter((state) => !state.terminalHealth && !state.finalPending)
          .toSorted(
            (left, right) =>
              left.lastActivityAt - right.lastActivityAt ||
              left.sessionKey.localeCompare(right.sessionKey),
          )[0];
        if (!evicted) {
          return undefined;
        }
        demoted.add(evicted);
        params.demote(evicted);
      }
      return resolved;
    },
  };
}
