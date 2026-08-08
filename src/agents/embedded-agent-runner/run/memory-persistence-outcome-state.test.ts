import { describe, expect, it } from "vitest";
import type { ToolOutcomeObservation } from "../../agent-tools.before-tool-call.js";
import { createMemoryPersistenceOutcomeState } from "./memory-persistence-outcome-state.js";
import { buildPayloads } from "./payloads.test-helpers.js";

function observation(params: {
  factDigest: string;
  status: "confirmed" | "not-confirmed";
  ordinal?: number;
}): ToolOutcomeObservation {
  return {
    toolName: "memory_store",
    argsHash: "args",
    resultHash: "result",
    ...(params.ordinal === undefined ? {} : { toolCallOrdinal: params.ordinal }),
    memoryPersistence: {
      attemptDigest: `attempt-${params.ordinal ?? "fallback"}`,
      factDigest: params.factDigest,
      status: params.status,
    },
  };
}

describe("memory persistence outcome state", () => {
  it("does not let an unrelated fact success clear an unresolved fact", () => {
    const state = createMemoryPersistenceOutcomeState();
    state.observe(observation({ factDigest: "fact-a", status: "not-confirmed", ordinal: 0 }));
    state.observe(observation({ factDigest: "fact-b", status: "confirmed", ordinal: 1 }));

    expect(state.summary()).toEqual({ unconfirmedCount: 1 });
  });

  it("clears a failed fact after a successful same-fact retry", () => {
    const state = createMemoryPersistenceOutcomeState();
    state.observe(observation({ factDigest: "fact-a", status: "not-confirmed", ordinal: 0 }));
    state.observe(observation({ factDigest: "fact-a", status: "confirmed", ordinal: 1 }));

    expect(state.summary()).toEqual({ unconfirmedCount: 0 });
  });

  it("uses model-call order when same-fact parallel outcomes finish out of order", () => {
    const state = createMemoryPersistenceOutcomeState();
    state.observe(observation({ factDigest: "fact-a", status: "confirmed", ordinal: 1 }));
    state.observe(observation({ factDigest: "fact-a", status: "not-confirmed", ordinal: 0 }));

    expect(state.summary()).toEqual({ unconfirmedCount: 0 });
  });

  it("keeps fallback ordinals monotonic after explicit ordinals", () => {
    const state = createMemoryPersistenceOutcomeState();
    state.observe(observation({ factDigest: "fact-a", status: "confirmed", ordinal: 5 }));
    state.observe(observation({ factDigest: "fact-a", status: "not-confirmed" }));

    expect(state.summary()).toEqual({ unconfirmedCount: 1 });
  });

  it("returns no structured summary before a receipt-aware outcome is observed", () => {
    expect(createMemoryPersistenceOutcomeState().summary()).toBeUndefined();
  });

  it("lets a later same-fact success suppress only the stale older tool error", () => {
    const state = createMemoryPersistenceOutcomeState();
    state.observe(observation({ factDigest: "fact-a", status: "not-confirmed", ordinal: 0 }));
    state.observe(observation({ factDigest: "fact-a", status: "confirmed", ordinal: 1 }));

    const payloads = buildPayloads({
      assistantTexts: ["I saved that to persistent memory."],
      lastToolError: { toolName: "memory_store", error: "older attempt failed" },
      unconfirmedMemoryPersistenceCount: state.summary()?.unconfirmedCount,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("I saved that to persistent memory.");
  });
});
