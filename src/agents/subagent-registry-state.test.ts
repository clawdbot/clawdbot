// Subagent registry state tests cover hot read caching over the persisted SQLite snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead,
  onSubagentRegistryPersisted,
  persistSubagentRunsToDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  loadSubagentRegistryFromSqlite: vi.fn<() => Map<string, SubagentRunRecord>>(),
  saveSubagentRegistryToSqlite: vi.fn<(runs: Map<string, SubagentRunRecord>) => void>(),
}));

vi.mock("./subagent-registry.store.sqlite.js", () => ({
  loadSubagentRegistryFromSqlite: mocks.loadSubagentRegistryFromSqlite,
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
    startedAt: 1,
  };
}

describe("subagent registry state read cache", () => {
  const previousReadSqliteFlag = process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = "1";
    clearSubagentRunsReadCacheForTest();
    mocks.loadSubagentRegistryFromSqlite.mockReset();
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
});
