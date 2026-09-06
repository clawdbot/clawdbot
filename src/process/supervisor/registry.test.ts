// Supervisor registry tests cover run registration, lookup, and pruning behavior.
import { describe, expect, it } from "vitest";
import { createRunRegistry } from "./registry.js";

type RunRegistry = ReturnType<typeof createRunRegistry>;

function addRecord(
  registry: RunRegistry,
  params: {
    runId: string;
    sessionId: string;
    startedAtMs: number;
    state?: "running" | "exited";
    scopeKey?: string;
    backendId?: string;
  },
) {
  return registry.add({
    runId: params.runId,
    sessionId: params.sessionId,
    backendId: params.backendId ?? "b1",
    scopeKey: params.scopeKey,
    state: params.state ?? "running",
    startedAtMs: params.startedAtMs,
    lastOutputAtMs: params.startedAtMs,
    createdAtMs: params.startedAtMs,
    updatedAtMs: params.startedAtMs,
  });
}

describe("process supervisor run registry", () => {
  it("keeps retrieved snapshots detached while output timestamps advance", () => {
    const registry = createRunRegistry();
    const run = addRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1 });
    const snapshot = registry.get("r1");

    run.touchOutput();
    const touched = registry.get("r1");

    expect(snapshot).toMatchObject({ lastOutputAtMs: 1, updatedAtMs: 1 });
    expect(touched?.lastOutputAtMs).toBeGreaterThan(1);
    if (touched) {
      touched.backendId = "caller-owned";
    }
    expect(registry.get("r1")?.backendId).toBe("b1");
  });

  it("finalize is idempotent and preserves first terminal metadata", () => {
    const registry = createRunRegistry();
    const run = addRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1 });

    run.finalize({
      reason: "overall-timeout",
      exitCode: null,
      exitSignal: "SIGKILL",
    });
    expect(registry.get("r1")).toMatchObject({
      state: "exited",
      terminationReason: "overall-timeout",
      exitCode: null,
      exitSignal: "SIGKILL",
    });

    run.finalize({
      reason: "manual-cancel",
      exitCode: 0,
      exitSignal: null,
    });
    expect(registry.get("r1")).toMatchObject({
      state: "exited",
      terminationReason: "overall-timeout",
      exitCode: null,
      exitSignal: "SIGKILL",
    });
  });

  it("prunes the oldest created exited records after out-of-order exits", () => {
    const registry = createRunRegistry({ maxExitedRecords: 2 });
    const r1 = addRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1 });
    const r2 = addRecord(registry, { runId: "r2", sessionId: "s2", startedAtMs: 2 });
    const r3 = addRecord(registry, { runId: "r3", sessionId: "s3", startedAtMs: 3 });
    const r4 = addRecord(registry, { runId: "r4", sessionId: "s4", startedAtMs: 4 });

    r2.finalize({ reason: "exit", exitCode: 0, exitSignal: null });
    r3.finalize({ reason: "exit", exitCode: 0, exitSignal: null });
    r1.finalize({ reason: "exit", exitCode: 0, exitSignal: null });

    expect(registry.get("r1")).toBeUndefined();
    expect(registry.get("r2")?.state).toBe("exited");
    expect(registry.get("r3")?.state).toBe("exited");

    r4.finalize({ reason: "exit", exitCode: 0, exitSignal: null });

    expect(registry.get("r2")).toBeUndefined();
    expect(registry.get("r3")?.state).toBe("exited");
    expect(registry.get("r4")?.state).toBe("exited");
  });

  it("tracks records added or transitioned into the exited state", () => {
    const registry = createRunRegistry({ maxExitedRecords: 2 });
    addRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1, state: "exited" });
    const r2 = addRecord(registry, { runId: "r2", sessionId: "s2", startedAtMs: 2 });
    const r3 = addRecord(registry, { runId: "r3", sessionId: "s3", startedAtMs: 3 });

    r2.updateState("exited");
    r3.finalize({ reason: "exit", exitCode: 0, exitSignal: null });

    expect(registry.get("r1")).toBeUndefined();
    expect(registry.get("r2")?.state).toBe("exited");
    expect(registry.get("r3")?.state).toBe("exited");
  });

  it("tracks exited records replaced or transitioned back to a live state", () => {
    const registry = createRunRegistry({ maxExitedRecords: 2 });
    addRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1, state: "exited" });
    const r2 = addRecord(registry, {
      runId: "r2",
      sessionId: "s2",
      startedAtMs: 2,
      state: "exited",
    });

    const r1 = addRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1 });
    r2.updateState("running");
    const r3 = addRecord(registry, { runId: "r3", sessionId: "s3", startedAtMs: 3 });
    r1.finalize({ reason: "exit", exitCode: 0, exitSignal: null });
    r3.finalize({ reason: "exit", exitCode: 0, exitSignal: null });

    expect(registry.get("r1")?.state).toBe("exited");
    expect(registry.get("r2")?.state).toBe("running");
    expect(registry.get("r3")?.state).toBe("exited");
  });

  it("ignores replaced registrations without corrupting diagnostic retention", () => {
    const registry = createRunRegistry({ maxExitedRecords: 1 });
    const older = addRecord(registry, { runId: "r1", sessionId: "older", startedAtMs: 1 });
    const replacement = addRecord(registry, { runId: "r1", sessionId: "newer", startedAtMs: 2 });
    const sibling = addRecord(registry, { runId: "r2", sessionId: "sibling", startedAtMs: 3 });
    const snapshot = registry.get("r1");

    older.updateState("exiting", { pid: 1234, terminationReason: "manual-cancel" });
    older.touchOutput();
    older.finalize({ reason: "exit", exitCode: 23, exitSignal: null });
    expect(registry.get("r1")).toEqual(snapshot);

    sibling.finalize({ reason: "exit", exitCode: 0, exitSignal: null });
    expect(registry.get("r2")?.state).toBe("exited");
    replacement.finalize({ reason: "exit", exitCode: 0, exitSignal: null });
    expect(registry.get("r1")).toBeUndefined();
    expect(registry.get("r2")?.state).toBe("exited");

    replacement.updateState("running");
    expect(registry.get("r1")).toBeUndefined();
  });
});
