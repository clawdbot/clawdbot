import type { SessionObserverState } from "./session-observer-model.js";

export function createSessionObserverModelSlots(params: {
  states: Map<string, SessionObserverState>;
  maxSessions: number;
  resolve: (agentId: string) => string | undefined;
  demote: (state: SessionObserverState) => void;
}) {
  const demoted = new WeakSet<SessionObserverState>();

  return {
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
