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
  registry.add({
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
  it("finalize is idempotent and preserves first terminal metadata", () => {
    const registry = createRunRegistry();
    addRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1 });

    registry.finalize("r1", {
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

    registry.finalize("r1", {
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
    addRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1 });
    addRecord(registry, { runId: "r2", sessionId: "s2", startedAtMs: 2 });
    addRecord(registry, { runId: "r3", sessionId: "s3", startedAtMs: 3 });
    addRecord(registry, { runId: "r4", sessionId: "s4", startedAtMs: 4 });

    registry.finalize("r2", { reason: "exit", exitCode: 0, exitSignal: null });
    registry.finalize("r3", { reason: "exit", exitCode: 0, exitSignal: null });
    registry.finalize("r1", { reason: "exit", exitCode: 0, exitSignal: null });

    expect(registry.get("r1")).toBeUndefined();
    expect(registry.get("r2")?.state).toBe("exited");
    expect(registry.get("r3")?.state).toBe("exited");

    registry.finalize("r4", { reason: "exit", exitCode: 0, exitSignal: null });

    expect(registry.get("r2")).toBeUndefined();
    expect(registry.get("r3")?.state).toBe("exited");
    expect(registry.get("r4")?.state).toBe("exited");
  });

  it("tracks records added or transitioned into the exited state", () => {
    const registry = createRunRegistry({ maxExitedRecords: 2 });
    addRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1, state: "exited" });
    addRecord(registry, { runId: "r2", sessionId: "s2", startedAtMs: 2 });
    addRecord(registry, { runId: "r3", sessionId: "s3", startedAtMs: 3 });

    registry.updateState("r2", "exited");
    registry.finalize("r3", { reason: "exit", exitCode: 0, exitSignal: null });

    expect(registry.get("r1")).toBeUndefined();
    expect(registry.get("r2")?.state).toBe("exited");
    expect(registry.get("r3")?.state).toBe("exited");
  });

  it("tracks exited records replaced or transitioned back to a live state", () => {
    const registry = createRunRegistry({ maxExitedRecords: 2 });
    addRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1, state: "exited" });
    addRecord(registry, { runId: "r2", sessionId: "s2", startedAtMs: 2, state: "exited" });

    addRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1 });
    registry.updateState("r2", "running");
    addRecord(registry, { runId: "r3", sessionId: "s3", startedAtMs: 3 });
    registry.finalize("r1", { reason: "exit", exitCode: 0, exitSignal: null });
    registry.finalize("r3", { reason: "exit", exitCode: 0, exitSignal: null });

    expect(registry.get("r1")?.state).toBe("exited");
    expect(registry.get("r2")?.state).toBe("running");
    expect(registry.get("r3")?.state).toBe("exited");
  });
});
