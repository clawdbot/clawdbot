import { describe, expect, it } from "vitest";
import { createRunRegistry } from "./registry.js";

type RunRegistry = ReturnType<typeof createRunRegistry>;

function addRunningRecord(
  registry: RunRegistry,
  params: {
    runId: string;
    sessionId: string;
    startedAtMs: number;
    scopeKey?: string;
    backendId?: string;
  },
) {
  registry.add({
    runId: params.runId,
    sessionId: params.sessionId,
    backendId: params.backendId ?? "b1",
    scopeKey: params.scopeKey,
    state: "running",
    startedAtMs: params.startedAtMs,
    lastOutputAtMs: params.startedAtMs,
    createdAtMs: params.startedAtMs,
    updatedAtMs: params.startedAtMs,
  });
}

describe("process supervisor run registry", () => {
  it("finalize is idempotent and preserves first terminal metadata", () => {
    const registry = createRunRegistry();
    addRunningRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1 });

    const first = registry.finalize("r1", {
      reason: "overall-timeout",
      exitCode: null,
      exitSignal: "SIGKILL",
    });
    const second = registry.finalize("r1", {
      reason: "manual-cancel",
      exitCode: 0,
      exitSignal: null,
    });

    if (!first) {
      throw new Error("missing first finalize result");
    }
    expect(first.firstFinalize).toBe(true);
    expect(first.record.terminationReason).toBe("overall-timeout");
    expect(first.record.exitCode).toBeNull();
    expect(first.record.exitSignal).toBe("SIGKILL");

    if (!second) {
      throw new Error("missing second finalize result");
    }
    expect(second.firstFinalize).toBe(false);
    expect(second.record.terminationReason).toBe("overall-timeout");
    expect(second.record.exitCode).toBeNull();
    expect(second.record.exitSignal).toBe("SIGKILL");
  });

  it("prunes oldest exited records once retention cap is exceeded", () => {
    const registry = createRunRegistry({ maxExitedRecords: 2 });
    addRunningRecord(registry, { runId: "r1", sessionId: "s1", startedAtMs: 1 });
    addRunningRecord(registry, { runId: "r2", sessionId: "s2", startedAtMs: 2 });
    addRunningRecord(registry, { runId: "r3", sessionId: "s3", startedAtMs: 3 });

    registry.finalize("r1", { reason: "exit", exitCode: 0, exitSignal: null });
    registry.finalize("r2", { reason: "exit", exitCode: 0, exitSignal: null });
    registry.finalize("r3", { reason: "exit", exitCode: 0, exitSignal: null });

    expect(registry.get("r1")).toBeUndefined();
    expect(registry.get("r2")?.state).toBe("exited");
    expect(registry.get("r3")?.state).toBe("exited");
  });

  it("filters listByScope and returns detached copies", () => {
    const registry = createRunRegistry();
    addRunningRecord(registry, {
      runId: "r1",
      sessionId: "s1",
      scopeKey: "scope:a",
      startedAtMs: 1,
    });
    addRunningRecord(registry, {
      runId: "r2",
      sessionId: "s2",
      scopeKey: "scope:b",
      startedAtMs: 2,
    });

    expect(registry.listByScope("   ")).toStrictEqual([]);
    const scoped = registry.listByScope("scope:a");
    expect(scoped).toHaveLength(1);
    const [firstScoped] = scoped;
    expect(firstScoped?.runId).toBe("r1");

    if (!firstScoped) {
      throw new Error("missing scoped record");
    }
    firstScoped.state = "exited";
    expect(registry.get("r1")?.state).toBe("running");
  });
});
