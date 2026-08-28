// Retained-singleton coverage for the reply-run registry state.
//
// `replyRunState` is a process-local global singleton. A registry instance
// created before a field was added stays on `globalThis` across hot reloads,
// upgrades, and duplicated runtime chunks; `resolveGlobalSingleton` returns
// that older object instead of the factory result. Nearby newer maps are
// backfilled beside the factory (`??= new Map()`), so a retained instance
// keeps working after the field is introduced. This file locks that upgrade
// contract for `sourceTurnByKey`, which `bindSourceTurnId` writes through
// `replyRunState.sourceTurnByKey.set(...)` — an uninitialized retained field
// throws on the next admitted source turn and fails the reply.
import { afterEach, describe, expect, it, vi } from "vitest";

const REPLY_RUN_STATE_KEY = Symbol.for("openclaw.replyRunRegistry");

type RetainedReplyRunState = {
  activeRunsByKey: Map<string, unknown>;
  activeSessionIdsByKey: Map<string, string>;
  activeKeysBySessionId: Map<string, string>;
  waitKeysBySessionId: Map<string, string>;
  waitersByKey: Map<string, Set<unknown>>;
  followupAdmissionBarriersByKey: Map<string, unknown>;
  successorAdmissionBarriersByKey: Map<string, unknown>;
  sourceTurnByKey?: Map<string, string>;
  evictOperationByOperation: WeakMap<object, () => void>;
  executionStartedOperations: WeakSet<object>;
};

function buildRetainedStateWithoutSourceTurnByKey(): RetainedReplyRunState {
  // A registry instance created before `sourceTurnByKey` existed: every map
  // the old module version knew about, none of the new field.
  return {
    activeRunsByKey: new Map(),
    activeSessionIdsByKey: new Map(),
    activeKeysBySessionId: new Map(),
    waitKeysBySessionId: new Map(),
    waitersByKey: new Map(),
    followupAdmissionBarriersByKey: new Map(),
    successorAdmissionBarriersByKey: new Map(),
    evictOperationByOperation: new WeakMap(),
    executionStartedOperations: new WeakSet(),
  };
}

afterEach(() => {
  // Leave the shared singleton slot clean for other suites in this worker.
  const store = globalThis as Record<PropertyKey, unknown>;
  delete store[REPLY_RUN_STATE_KEY];
  vi.resetModules();
});

describe("reply run registry retained singleton", () => {
  it("backfills sourceTurnByKey when the retained singleton predates the field", async () => {
    // Simulate a process-local singleton created by an older module version:
    // the object already lives on globalThis and lacks `sourceTurnByKey`.
    (globalThis as Record<PropertyKey, unknown>)[REPLY_RUN_STATE_KEY] =
      buildRetainedStateWithoutSourceTurnByKey();

    vi.resetModules();
    const { replyRunRegistry } = await import("./reply-run-registry.js");

    // The next admitted source turn binds its identity through the retained
    // registry. It must not throw and must record the binding.
    expect(() =>
      replyRunRegistry.bindSourceTurnId("agent:main:legacy", "source-legacy-1"),
    ).not.toThrow();
    expect(replyRunRegistry.getSourceTurnId("agent:main:legacy")).toBe("source-legacy-1");
  });

  it("keeps the retained singleton's pre-existing maps usable after backfill", async () => {
    (globalThis as Record<PropertyKey, unknown>)[REPLY_RUN_STATE_KEY] =
      buildRetainedStateWithoutSourceTurnByKey();

    vi.resetModules();
    const { replyRunRegistry } = await import("./reply-run-registry.js");

    // The same upgrade path must keep every other registry map functional:
    // a retained instance is shared state, not a throwaway factory result.
    replyRunRegistry.bindSourceTurnId("agent:main:legacy-2", "source-legacy-2");
    expect(replyRunRegistry.getSourceTurnId("agent:main:legacy-2")).toBe("source-legacy-2");
    expect(replyRunRegistry.isActive("agent:main:legacy-2")).toBe(false);
  });
});
