import type { ToolOutcomeObservation } from "../../agent-tools.before-tool-call.js";

export function createMemoryPersistenceOutcomeState() {
  const outcomes = new Map<string, { ordinal: number; status: "confirmed" | "not-confirmed" }>();
  let fallbackOrdinal = 0;
  return {
    observe(observation: ToolOutcomeObservation): void {
      if (observation.presentationOnly || !observation.memoryPersistence) {
        return;
      }
      const ordinal = observation.toolCallOrdinal ?? fallbackOrdinal;
      fallbackOrdinal = Math.max(fallbackOrdinal, ordinal + 1);
      const key = observation.memoryPersistence.factDigest
        ? `fact:${observation.memoryPersistence.factDigest}`
        : `attempt:${observation.memoryPersistence.attemptDigest}`;
      const current = outcomes.get(key);
      if (current && ordinal < current.ordinal) {
        return;
      }
      outcomes.set(key, { ordinal, status: observation.memoryPersistence.status });
    },
    summary(): { unconfirmedCount: number } | undefined {
      if (outcomes.size === 0) {
        return undefined;
      }
      let count = 0;
      for (const outcome of outcomes.values()) {
        if (outcome.status === "not-confirmed") {
          count += 1;
        }
      }
      return { unconfirmedCount: count };
    },
  };
}
