// Subagent registry state tests cover hot read caching over the persisted SQLite snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../../sessions/session-lifecycle-events.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead,
  onSubagentRegistryPersisted,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  publishSubagentRunsAfterAtomicStore,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunReadRecord, SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  loadSubagentRunsForChildSessionFromSqlite:
    vi.fn<(childSessionKey: string) => SubagentRunRecord[]>(),
  loadSubagentRunsForControllerFromSqlite:
    vi.fn<(controllerSessionKey: string) => SubagentRunRecord[]>(),
  loadSubagentRegistryFromSqlite: vi.fn<() => Map<string, SubagentRunRecord>>(),
  loadSubagentSessionListRunsFromSqlite: vi.fn<() => Map<string, SubagentRunReadRecord>>(),
  saveSubagentRegistryChangesToSqlite:
    vi.fn<(runs: Map<string, SubagentRunRecord>, changedRunIds: readonly string[]) => void>(),
  saveSubagentRegistryToSqlite: vi.fn<(runs: Map<string, SubagentRunRecord>) => void>(),
}));

vi.mock("./subagent-registry.store.sqlite.js", () => ({
  loadSubagentRunsForChildSessionFromSqlite: mocks.loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite: mocks.loadSubagentRunsForControllerFromSqlite,
  loadSubagentRegistryFromSqlite: mocks.loadSubagentRegistryFromSqlite,
  loadSubagentSessionListRunsFromSqlite: mocks.loadSubagentSessionListRunsFromSqlite,
  saveSubagentRegistryChangesToSqlite: mocks.saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite: mocks.saveSubagentRegistryToSqlite,
}));

function createRun(runId: string): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: `task ${runId}`,
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "running", startedAt: 1 },
  };
}

describe("subagent registry state read cache", () => {
  const previousReadSqliteFlag = process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = "1";
    clearSubagentRunsReadCacheForTest();
    mocks.loadSubagentRunsForChildSessionFromSqlite.mockReset();
    mocks.loadSubagentRunsForControllerFromSqlite.mockReset();
    mocks.loadSubagentRegistryFromSqlite.mockReset();
    mocks.loadSubagentSessionListRunsFromSqlite.mockReset();
    mocks.saveSubagentRegistryChangesToSqlite.mockReset();
    mocks.saveSubagentRegistryToSqlite.mockReset();
  });

  afterEach(() => {
    clearSubagentRunsReadCacheForTest();
    if (previousReadSqliteFlag === undefined) {
      delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;
    } else {
      process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = previousReadSqliteFlag;
    }
    vi.useRealTimers();
  });

  it("reuses persisted snapshots for hot reads within the ttl", () => {
    const firstRun = createRun("run-first");
    const secondRun = createRun("run-second");
    mocks.loadSubagentRegistryFromSqlite
      .mockReturnValueOnce(new Map([[firstRun.runId, firstRun]]))
      .mockReturnValueOnce(new Map([[secondRun.runId, secondRun]]));

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-second"]);
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledTimes(2);
  });

  it("refreshes the local read cache after successful writes", () => {
    const firstRun = createRun("run-first");
    const savedRun = createRun("run-saved");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[firstRun.runId, firstRun]]));

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);

    persistSubagentRunsToDisk(new Map([[savedRun.runId, savedRun]]));

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-saved"]);
    expect(mocks.saveSubagentRegistryToSqlite).toHaveBeenCalledOnce();
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledTimes(1);
  });

  it("uses the projected sqlite snapshot for session-list reads", () => {
    const firstRun = createRun("run-first");
    firstRun.model = "openai/gpt-5.6";
    const secondRun = createRun("run-second");
    mocks.loadSubagentSessionListRunsFromSqlite
      .mockReturnValueOnce(new Map([[firstRun.runId, firstRun]]))
      .mockReturnValueOnce(new Map([[secondRun.runId, secondRun]]));

    expect([...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);
    expect([...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);
    expect(mocks.loadSubagentSessionListRunsFromSqlite).toHaveBeenCalledTimes(1);
    expect(mocks.loadSubagentRegistryFromSqlite).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect([...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()]).toEqual([
      "run-second",
    ]);
    expect(mocks.loadSubagentSessionListRunsFromSqlite).toHaveBeenCalledTimes(2);
  });

  it("refreshes session-list projections from authoritative writes", () => {
    const savedRun = createRun("run-saved");
    savedRun.model = "openai/gpt-5.6";
    savedRun.execution.outcome = { status: "ok", error: "not projected" };
    mocks.saveSubagentRegistryToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    persistSubagentRunsToDisk(new Map([[savedRun.runId, savedRun]]));

    const projected = getSubagentSessionListRunsSnapshotForRead(new Map()).get(savedRun.runId);
    expect(projected).toMatchObject({
      runId: savedRun.runId,
      model: savedRun.model,
      execution: { outcome: { status: "ok" } },
    });
    expect(projected?.execution.outcome).not.toHaveProperty("error");
    expect(mocks.loadSubagentSessionListRunsFromSqlite).not.toHaveBeenCalled();
  });

  it("preserves unrelated projected rows across incremental writes", () => {
    const retained = createRun("retained");
    const changed = createRun("changed");
    mocks.loadSubagentSessionListRunsFromSqlite.mockReturnValue(
      new Map([
        [retained.runId, retained],
        [changed.runId, changed],
      ]),
    );
    expect([...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()]).toEqual([
      "retained",
      "changed",
    ]);

    changed.model = "openai/gpt-5.6";
    persistSubagentRunsToDisk(new Map([[changed.runId, changed]]), [changed.runId]);

    const projected = getSubagentSessionListRunsSnapshotForRead(new Map());
    expect([...projected.keys()]).toEqual(["retained", "changed"]);
    expect(projected.get(changed.runId)?.model).toBe("openai/gpt-5.6");
    expect(mocks.loadSubagentSessionListRunsFromSqlite).toHaveBeenCalledOnce();
  });

  it("updates only named runs in the local read cache", () => {
    const changed = createRun("changed");
    const untouched = createRun("untouched");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [changed.runId, changed],
        [untouched.runId, untouched],
      ]),
    );
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["changed", "untouched"]);

    changed.task = "updated";
    const runs = new Map([
      [changed.runId, changed],
      [untouched.runId, untouched],
    ]);
    persistSubagentRunsToDisk(runs, [changed.runId]);

    expect(mocks.saveSubagentRegistryChangesToSqlite).toHaveBeenCalledWith(runs, [changed.runId]);
    expect(mocks.saveSubagentRegistryToSqlite).not.toHaveBeenCalled();
    expect(getSubagentRunsSnapshotForRead(new Map()).get(changed.runId)?.task).toBe("updated");
    expect(getSubagentRunsSnapshotForRead(new Map()).get(untouched.runId)?.task).toBe(
      untouched.task,
    );
  });

  it("keeps an exact deletion authoritative after a best-effort write failure", () => {
    const retained = createRun("retained");
    const removed = createRun("removed");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [retained.runId, retained],
        [removed.runId, removed],
      ]),
    );
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["retained", "removed"]);
    mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    persistSubagentRunsToDisk(new Map([[retained.runId, retained]]), [removed.runId]);

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["retained"]);
  });

  it("wakes local readers when a best-effort write fails", () => {
    const staleRun = createRun("stale");
    const updatedRun = createRun("updated");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[staleRun.runId, staleRun]]));
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["stale"]);
    const listener = vi.fn();
    const unsubscribe = onSubagentRegistryPersisted(listener);
    mocks.saveSubagentRegistryToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    persistSubagentRunsToDisk(new Map([[updatedRun.runId, updatedRun]]));

    expect(listener).toHaveBeenCalledOnce();
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["updated"]);
    unsubscribe();
  });

  it("queries controller rows directly and overlays matching in-memory state", () => {
    const persisted = createRun("shared");
    persisted.controllerSessionKey = "agent:main:controller";
    persisted.task = "persisted";
    const inMemory = { ...persisted, task: "in-memory" };
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([persisted]);

    const result = getSubagentRunsSnapshotForController(
      new Map([[inMemory.runId, inMemory]]),
      "agent:main:controller",
    );

    expect(result.get("shared")?.task).toBe("in-memory");
    expect(mocks.loadSubagentRunsForControllerFromSqlite).toHaveBeenCalledOnce();
    expect(getSubagentRunsSnapshotForController(new Map(), "   ")).toEqual(new Map());
  });

  it("queries one child directly and returns isolated snapshots", () => {
    const childSessionKey = "agent:main:subagent:child";
    const persisted = createRun("child");
    persisted.childSessionKey = childSessionKey;
    persisted.task = "persisted";
    mocks.loadSubagentRunsForChildSessionFromSqlite.mockReturnValue([persisted]);

    const first = getSubagentRunsSnapshotForChildSession(new Map(), childSessionKey);
    first.get("child")!.task = "mutated";
    const second = getSubagentRunsSnapshotForChildSession(new Map(), childSessionKey);

    expect(second.get("child")?.task).toBe("persisted");
    expect(mocks.loadSubagentRunsForChildSessionFromSqlite).toHaveBeenCalledTimes(2);
  });

  it("masks persisted scope membership when the live run moved", () => {
    const persisted = createRun("moved");
    persisted.controllerSessionKey = "agent:main:controller:old";
    persisted.childSessionKey = "agent:main:subagent:old";
    const inMemory = {
      ...persisted,
      controllerSessionKey: "agent:main:controller:new",
      childSessionKey: "agent:main:subagent:new",
    };
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([persisted]);
    mocks.loadSubagentRunsForChildSessionFromSqlite.mockReturnValue([persisted]);
    const live = new Map([[inMemory.runId, inMemory]]);

    expect(getSubagentRunsSnapshotForController(live, "agent:main:controller:old")).toEqual(
      new Map(),
    );
    expect(getSubagentRunsSnapshotForChildSession(live, "agent:main:subagent:old")).toEqual(
      new Map(),
    );
  });

  it("filters before merging while keeping live identity changes authoritative", () => {
    const selected = { ...createRun("selected"), swarmRunId: "collector" };
    const unrelated = createRun("unrelated");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [selected.runId, selected],
        [unrelated.runId, unrelated],
      ]),
    );
    const include = (entry: SubagentRunRecord) => entry.swarmRunId === "collector";
    expect([...getSubagentRunsSnapshotForRead(new Map(), include).keys()]).toEqual(["selected"]);

    const moved = { ...selected, swarmRunId: "replacement" };
    expect(getSubagentRunsSnapshotForRead(new Map([[moved.runId, moved]]), include)).toEqual(
      new Map(),
    );
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual([
      "selected",
      "unrelated",
    ]);
  });

  it("preserves the fresh authoritative write snapshot before returning to scoped SQL", () => {
    const controllerSessionKey = "agent:main:controller";
    const saved = createRun("saved");
    saved.controllerSessionKey = controllerSessionKey;
    mocks.saveSubagentRegistryToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([]);

    persistSubagentRunsToDisk(new Map([[saved.runId, saved]]));

    expect([
      ...getSubagentRunsSnapshotForController(new Map(), controllerSessionKey).keys(),
    ]).toEqual(["saved"]);
    expect(mocks.loadSubagentRunsForControllerFromSqlite).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(getSubagentRunsSnapshotForController(new Map(), controllerSessionKey)).toEqual(
      new Map(),
    );
    expect(mocks.loadSubagentRunsForControllerFromSqlite).toHaveBeenCalledOnce();
  });

  it("invalidates the strict collector parent after each committed lifecycle transition", () => {
    const run: SubagentRunRecord = {
      ...createRun("cross-agent"),
      childSessionKey: "agent:research:subagent:child",
      collect: true,
      swarmRequesterSessionKey: "global",
      requesterAgentId: "ops",
      groupId: "opaque-group",
      execution: { status: "queued" as const },
    };
    const runs = new Map([[run.runId, run]]);
    const observed: Array<{ event: SessionLifecycleEvent; stored?: SubagentRunRecord }> = [];
    const unsubscribe = onSessionLifecycleEvent((event) => {
      observed.push({ event, stored: getSubagentRunsSnapshotForRead(new Map()).get(run.runId) });
    });
    try {
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      run.execution = { status: "running", startedAt: 2 };
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      run.execution = { status: "terminal", endedAt: 3, outcome: { status: "ok" } };
      run.collectorCompletion = { status: "done", structured: { private: "child result" } };
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      run.task = "unrelated bookkeeping";
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      runs.delete(run.runId);
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      expect(observed.map(({ event }) => event)).toEqual(
        Array.from({ length: 4 }, () => ({
          sessionKey: "global",
          agentId: "ops",
          reason: "swarm",
        })),
      );
      expect(
        observed.map(
          ({ stored }) => stored?.collectorCompletion?.status ?? stored?.execution.status,
        ),
      ).toEqual(["queued", "running", "done", undefined]);
    } finally {
      unsubscribe();
    }
  });

  it.each([false, true])(
    "does not advance collector notifications on failed writes (strict=%s)",
    (strict) => {
      const run: SubagentRunRecord = {
        ...createRun("retry"),
        collect: true,
        swarmRequesterSessionKey: "agent:ops:parent",
        requesterAgentId: "ops",
        groupId: "batch",
      };
      const runs = new Map([[run.runId, run]]);
      persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
      const received = vi.fn();
      const unsubscribe = onSessionLifecycleEvent(received);
      try {
        run.collectorCompletion = { status: "failed" };
        mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
          throw new Error("disk unavailable");
        });
        if (strict) {
          expect(() => persistSubagentRunsToDiskOrThrow(runs, [run.runId])).toThrow(
            "disk unavailable",
          );
        } else {
          persistSubagentRunsToDisk(runs, [run.runId]);
        }
        expect(received).not.toHaveBeenCalled();
        persistSubagentRunsToDiskOrThrow(runs, [run.runId]);
        expect(received).toHaveBeenCalledExactlyOnceWith({
          sessionKey: "agent:ops:parent",
          agentId: "ops",
          reason: "swarm",
        });
      } finally {
        unsubscribe();
      }
    },
  );

  it("invalidates archived cold-restored groups once per exact parent", () => {
    const rows = ["a", "b"].map((runId) => {
      const run = createRun(runId);
      run.collect = true;
      run.swarmRequesterSessionKey = "global";
      run.requesterAgentId = "ops";
      run.groupId = "batch";
      run.collectorCompletion = { status: "done" };
      return run;
    });
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map(rows.map((row) => [row.runId, row])),
    );
    const runs = new Map<string, SubagentRunRecord>();
    const received = vi.fn();
    const unsubscribe = onSessionLifecycleEvent(received);
    try {
      restoreSubagentRunsFromDisk({ runs });
      expect(received).not.toHaveBeenCalled();
      runs.clear();
      persistSubagentRunsToDiskOrThrow(
        runs,
        rows.map((row) => row.runId),
      );
      expect(received).toHaveBeenCalledExactlyOnceWith({
        sessionKey: "global",
        agentId: "ops",
        reason: "swarm",
      });
    } finally {
      unsubscribe();
    }
  });

  it("defers atomic collector notifications until all owner snapshots are published", () => {
    const run: SubagentRunRecord = {
      ...createRun("atomic"),
      collect: true,
      swarmRequesterSessionKey: "agent:ops:parent",
      requesterAgentId: "ops",
      groupId: "batch",
    };
    const received = vi.fn();
    const unsubscribe = onSessionLifecycleEvent(received);
    try {
      const deferred: Array<() => void> = [];
      publishSubagentRunsAfterAtomicStore(new Map([[run.runId, run]]), [run.runId], deferred);
      expect(received).not.toHaveBeenCalled();
      expect(getSubagentRunsSnapshotForRead(new Map()).get(run.runId)?.groupId).toBe("batch");
      for (const publish of deferred) {
        publish();
      }
      expect(received).toHaveBeenCalledExactlyOnceWith({
        sessionKey: "agent:ops:parent",
        agentId: "ops",
        reason: "swarm",
      });
    } finally {
      unsubscribe();
    }
  });

  it("does not infer collector parent ownership from requester or group strings", () => {
    const base = { ...createRun("missing"), collect: true, groupId: "swarm:agent:ops:parent:run" };
    const rows: SubagentRunRecord[] = [
      base,
      { ...base, runId: "no-agent", swarmRequesterSessionKey: "agent:ops:parent" },
      { ...base, runId: "no-key", requesterAgentId: "ops" },
      {
        ...base,
        runId: "ordinary",
        collect: false,
        swarmRequesterSessionKey: "agent:ops:parent",
        requesterAgentId: "ops",
      },
    ];
    const received = vi.fn();
    const unsubscribe = onSessionLifecycleEvent(received);
    try {
      persistSubagentRunsToDiskOrThrow(new Map(rows.map((row) => [row.runId, row])));
      expect(received).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
