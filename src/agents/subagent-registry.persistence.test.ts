// Subagent registry persistence tests cover JSON registry restore, child
// session timing writes, and restart cleanup behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreWriterQueuesForTest,
} from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import type { DetachedTaskLifecycleRuntime } from "../tasks/detached-task-runtime-contract.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../tasks/detached-task-runtime.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue, withEnv } from "../test-utils/env.js";
import { scheduleOrphanRecovery } from "./subagent-orphan-recovery.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import {
  testing,
  addSubagentRunForTests,
  clearSubagentRunSteerRestart,
  getLatestSubagentRunByChildSessionKey,
  getSubagentRunByChildSessionKey,
  initSubagentRegistry,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import {
  createSubagentRegistryTestDeps,
  readSubagentSessionStore,
  removeSubagentSessionEntry,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromDisk,
  resolveSubagentRegistryPath,
} from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => true),
}));
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: vi.fn(),
}));

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function createDetachedTaskRuntime(
  overrides: Partial<DetachedTaskLifecycleRuntime> = {},
): DetachedTaskLifecycleRuntime {
  return {
    createQueuedTaskRun: vi.fn(() => ({}) as never),
    createRunningTaskRun: vi.fn(() => ({}) as never),
    startTaskRunByRunId: vi.fn(() => []),
    recordTaskRunProgressByRunId: vi.fn(() => []),
    completeTaskRunByRunId: vi.fn(() => []),
    failTaskRunByRunId: vi.fn(() => []),
    setDetachedTaskDeliveryStatusByRunId: vi.fn(() => []),
    cancelDetachedTaskRunById: vi.fn(async () => ({ found: false, cancelled: false })),
    ...overrides,
  };
}

describe("subagent registry persistence", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  const resolveAgentIdFromSessionKey = (sessionKey: string) => {
    const match = sessionKey.match(/^agent:([^:]+):/i);
    return (match?.[1] ?? "main").trim().toLowerCase() || "main";
  };

  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
    abortedLastRun?: boolean;
  }) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    return await writeSubagentSessionEntry({
      stateDir: tempStateDir,
      agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      updatedAt: params.updatedAt,
      abortedLastRun: params.abortedLastRun,
      defaultSessionId: `sess-${agentId}-${Date.now()}`,
    });
  };

  const removeChildSessionEntry = async (sessionKey: string) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    return await removeSubagentSessionEntry({
      stateDir: tempStateDir,
      agentId,
      sessionKey,
    });
  };

  const seedChildSessionsForPersistedRuns = async (persisted: Record<string, unknown>) => {
    const runs = (persisted.runs ?? {}) as Record<
      string,
      {
        runId?: string;
        childSessionKey?: string;
      }
    >;
    for (const [runId, run] of Object.entries(runs)) {
      const childSessionKey = run?.childSessionKey?.trim();
      if (!childSessionKey) {
        continue;
      }
      await writeChildSessionEntry({
        sessionKey: childSessionKey,
        sessionId: `sess-${run.runId ?? runId}`,
      });
    }
  };

  const writePersistedRegistry = async (
    persisted: Record<string, unknown>,
    opts?: { seedChildSessions?: boolean },
  ) => {
    // Each persisted-registry fixture gets its own state dir so session stores
    // and registry files are tested through the same paths production resolves.
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");
    if (opts?.seedChildSessions !== false) {
      await seedChildSessionsForPersistedRuns(persisted);
    }
    return registryPath;
  };

  const readPersistedRun = async <T>(
    registryPath: string,
    runId: string,
  ): Promise<T | undefined> => {
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, unknown>;
    };
    return parsed.runs?.[runId] as T | undefined;
  };

  const createPersistedEndedRun = (params: {
    runId: string;
    childSessionKey: string;
    task: string;
    cleanup: "keep" | "delete";
  }) => {
    const now = Date.now();
    return {
      version: 2,
      runs: {
        [params.runId]: {
          runId: params.runId,
          childSessionKey: params.childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: params.task,
          cleanup: params.cleanup,
          createdAt: now - 2,
          startedAt: now - 1,
          endedAt: now,
        },
      },
    };
  };

  const flushQueuedRegistryWork = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const waitForRegistryWork = async (predicate: () => boolean | Promise<boolean>) => {
    await vi.waitFor(async () => expect(await predicate()).toBe(true), {
      interval: 1,
      timeout: 5_000,
    });
  };

  const restartRegistry = () => {
    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
  };

  const fastPersistSubagentRunsToDisk = (runs: Map<string, SubagentRunRecord>) => {
    // Most tests assert restore semantics, not async writer behavior, so this
    // synchronous writer keeps registry state immediately observable.
    const registryPath = tempStateDir
      ? path.join(tempStateDir, "subagents", "runs.json")
      : resolveSubagentRegistryPath();
    fsSync.mkdirSync(path.dirname(registryPath), { recursive: true });
    fsSync.writeFileSync(
      registryPath,
      `${JSON.stringify({ version: 2, runs: Object.fromEntries(runs) })}\n`,
      "utf8",
    );
  };

  beforeEach(() => {
    announceSpy.mockReset();
    announceSpy.mockResolvedValue(true);
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDisk: fastPersistSubagentRunsToDisk,
      runSubagentAnnounceFlow: announceSpy,
    });
    vi.mocked(callGateway).mockReset();
    vi.mocked(callGateway).mockResolvedValue({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    vi.mocked(scheduleOrphanRecovery).mockReset();
    vi.mocked(onAgentEvent).mockReset();
    vi.mocked(onAgentEvent).mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    testing.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    resetDetachedTaskLifecycleRuntimeForTests();
    await drainSessionStoreWriterQueuesForTest();
    clearSessionStoreCacheForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("persists completed subagent timing into the child session entry", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);

    const now = Date.now();
    const startedAt = now;
    const endedAt = now + 500;

    const storePath = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:timing",
      sessionId: "sess-timing",
      updatedAt: startedAt - 1,
    });
    await persistSubagentSessionTiming({
      runId: "run-session-timing",
      childSessionKey: "agent:main:subagent:timing",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persist timing",
      cleanup: "keep",
      createdAt: startedAt,
      startedAt,
      sessionStartedAt: startedAt,
      accumulatedRuntimeMs: 0,
      endedAt,
      outcome: { status: "ok" },
    } as never);

    const store = await readSubagentSessionStore(storePath);
    const persisted = store["agent:main:subagent:timing"];
    expect(persisted?.endedAt).toBe(endedAt);
    expect(persisted?.runtimeMs).toBe(500);
    expect(persisted?.status).toBe("done");
    expect(persisted?.startedAt).toBeGreaterThanOrEqual(startedAt);
    expect(persisted?.startedAt).toBeLessThanOrEqual(endedAt);
  });

  it("rolls back a new subagent run when initial persistence fails", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    const persistError = new Error("disk full");
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDisk: () => {
        throw persistError;
      },
      runSubagentAnnounceFlow: announceSpy,
    });

    expect(() =>
      registerSubagentRun({
        runId: "run-persist-fails",
        childSessionKey: "agent:main:subagent:persist-fails",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "must be durable before spawn",
        cleanup: "keep",
      }),
    ).toThrow(persistError);

    expect(getLatestSubagentRunByChildSessionKey("agent:main:subagent:persist-fails")).toBeNull();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("uses fail-closed production persistence for initial subagent registration", async () => {
    tempStateDir = path.join(
      os.tmpdir(),
      `openclaw-subagent-state-file-${process.pid}-${Date.now()}`,
    );
    await fs.writeFile(tempStateDir, "not a directory", "utf8");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      runSubagentAnnounceFlow: announceSpy,
    });

    expect(() =>
      registerSubagentRun({
        runId: "run-prod-persist-fails",
        childSessionKey: "agent:main:subagent:prod-persist-fails",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "must use strict production persistence",
        cleanup: "keep",
      }),
    ).toThrow();

    expect(
      getLatestSubagentRunByChildSessionKey("agent:main:subagent:prod-persist-fails"),
    ).toBeNull();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("rolls back a new subagent run when TaskFlow tracking fails", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    const taskFlowError = new Error("task registry unavailable");
    setDetachedTaskLifecycleRuntime(
      createDetachedTaskRuntime({
        createRunningTaskRun: vi.fn(() => {
          throw taskFlowError;
        }),
      }),
    );

    expect(() =>
      registerSubagentRun({
        runId: "run-taskflow-fails",
        childSessionKey: "agent:main:subagent:taskflow-fails",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "must be tracked before spawn acceptance",
        cleanup: "keep",
      }),
    ).toThrow(taskFlowError);

    expect(getLatestSubagentRunByChildSessionKey("agent:main:subagent:taskflow-fails")).toBeNull();
    expect(loadSubagentRegistryFromDisk().has("run-taskflow-fails")).toBe(false);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("persists silent announce metadata and replays it after restart", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);

    let releaseInitialWait:
      | ((value: { status: "ok"; startedAt: number; endedAt: number }) => void)
      | undefined;
    vi.mocked(callGateway)
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            releaseInitialWait = resolve as typeof releaseInitialWait;
          }),
      )
      .mockResolvedValueOnce({
        status: "ok",
        startedAt: 111,
        endedAt: 222,
      });

    registerSubagentRun({
      runId: "run-silent",
      childSessionKey: "agent:main:subagent:silent-test",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "quiet enrichment",
      cleanup: "keep",
      silentAnnounce: true,
      wakeOnReturn: true,
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:silent-test",
      sessionId: "sess-silent",
    });

    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    const run = await readPersistedRun<{
      silentAnnounce?: boolean;
      wakeOnReturn?: boolean;
      traceparent?: string;
    }>(registryPath, "run-silent");
    expect(run).toMatchObject({
      silentAnnounce: true,
      wakeOnReturn: true,
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });

    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
    releaseInitialWait?.({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });

    await vi.waitFor(() => {
      expect(announceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          childRunId: "run-silent",
          silentAnnounce: true,
          wakeOnReturn: true,
          traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        }),
      );
    });
  });

  it("persists completed subagent timing through the lifecycle (registerSubagentRun → callGateway → persist)", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);

    const now = Date.now();
    const startedAt = now;
    const endedAt = now + 500;
    vi.mocked(callGateway).mockResolvedValueOnce({
      status: "ok",
      startedAt,
      endedAt,
    });

    const storePath = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:timing",
      sessionId: "sess-timing",
      updatedAt: startedAt - 1,
    });
    registerSubagentRun({
      runId: "run-session-timing",
      childSessionKey: "agent:main:subagent:timing",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persist timing",
      cleanup: "keep",
    });

    await waitForRegistryWork(async () => {
      const store = await readSubagentSessionStore(storePath);
      return store["agent:main:subagent:timing"]?.endedAt === endedAt;
    });

    const store = await readSubagentSessionStore(storePath);
    const persisted = store["agent:main:subagent:timing"];
    expect(persisted?.endedAt).toBe(endedAt);
    expect(persisted?.runtimeMs).toBe(500);
    expect(persisted?.status).toBe("done");
    expect(persisted?.startedAt).toBeGreaterThanOrEqual(startedAt);
    expect(persisted?.startedAt).toBeLessThanOrEqual(endedAt);
  });

  it("rejects a stale timing write after session ownership changes", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);

    const startedAt = Date.now();
    const storePath = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:stale-timing",
      sessionId: "sess-stale-timing",
      updatedAt: startedAt - 1,
    });
    await persistSubagentSessionTiming(
      {
        runId: "run-stale-timing",
        childSessionKey: "agent:main:subagent:stale-timing",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "do not persist stale timing",
        cleanup: "keep",
        createdAt: startedAt,
        startedAt,
        endedAt: startedAt + 500,
        outcome: { status: "ok" },
      } as never,
      { isCurrentGeneration: () => false },
    );

    const persisted = (await readSubagentSessionStore(storePath))[
      "agent:main:subagent:stale-timing"
    ];
    expect(persisted).toMatchObject({
      sessionId: "sess-stale-timing",
      updatedAt: startedAt - 1,
    });
    expect(persisted?.startedAt).toBeUndefined();
    expect(persisted?.endedAt).toBeUndefined();
    expect(persisted?.status).toBeUndefined();
  });

  it("does not overwrite durable completion with a provisional killed status", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);

    const startedAt = Date.now();
    const completedAt = startedAt + 500;
    const storePath = await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:kill-race",
      sessionId: "sess-kill-race",
      updatedAt: completedAt,
    });
    const store = await readSubagentSessionStore(storePath);
    await replaceSessionEntry({ storePath, sessionKey: "agent:main:subagent:kill-race" }, {
      ...store["agent:main:subagent:kill-race"],
      status: "done",
      startedAt,
      endedAt: completedAt,
      runtimeMs: 500,
      abortedLastRun: true,
    } as SessionEntry);

    await persistSubagentSessionTiming({
      runId: "run-kill-race",
      childSessionKey: "agent:main:subagent:kill-race",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "preserve completion",
      cleanup: "keep",
      createdAt: startedAt,
      startedAt,
      endedAt: completedAt + 1,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
    } as never);

    const persisted = (await readSubagentSessionStore(storePath))["agent:main:subagent:kill-race"];
    expect(persisted).toMatchObject({
      status: "done",
      startedAt,
      endedAt: completedAt,
      runtimeMs: 500,
    });
    expect(persisted?.abortedLastRun).toBeUndefined();
  });

  it("skips cleanup when cleanupHandled was persisted", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);

    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    const persisted = {
      version: 2,
      runs: {
        "run-2": {
          runId: "run-2",
          childSessionKey: "agent:main:subagent:two",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do the other thing",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
          cleanupHandled: true, // Already handled - should be skipped
        },
      },
    };
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");
    await writeChildSessionEntry({
      sessionKey: "agent:main:subagent:two",
      sessionId: "sess-two",
    });

    restartRegistry();
    await flushQueuedRegistryWork();

    // announce should NOT be called since cleanupHandled was true
    const calls = (announceSpy.mock.calls as unknown as Array<[unknown]>).map((call) => call[0]);
    expect(
      calls.some(
        (call) =>
          (call as { childSessionKey?: unknown } | undefined)?.childSessionKey ===
          "agent:main:subagent:two",
      ),
    ).toBe(false);
  });

  it("maps legacy announce fields into cleanup state", async () => {
    const persisted = {
      version: 1,
      runs: {
        "run-legacy": {
          runId: "run-legacy",
          childSessionKey: "agent:main:subagent:legacy",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "legacy announce",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
          announceCompletedAt: 9,
          announceHandled: true,
          requesterChannel: "whatsapp",
          requesterAccountId: "legacy-account",
        },
      },
    };
    const registryPath = await writePersistedRegistry(persisted);

    const runs = loadSubagentRegistryFromDisk();
    const entry = runs.get("run-legacy");
    expect(entry?.cleanupHandled).toBe(true);
    expect(entry?.cleanupCompletedAt).toBe(9);
    expect(entry?.requesterOrigin?.channel).toBe("whatsapp");
    expect(entry?.requesterOrigin?.accountId).toBe("legacy-account");

    const after = JSON.parse(await fs.readFile(registryPath, "utf8")) as { version?: number };
    expect(after.version).toBe(2);
  });

  it("returns isolated clones for unchanged persisted registry snapshots", async () => {
    const registryPath = await writePersistedRegistry(
      {
        version: 2,
        runs: {
          "run-cached": {
            runId: "run-cached",
            childSessionKey: "agent:main:subagent:cached",
            requesterSessionKey: "agent:main:main",
            requesterOrigin: { channel: "telegram", accountId: "cached-account" },
            requesterDisplayKey: "main",
            task: "cached persisted run",
            cleanup: "keep",
            createdAt: 1,
            startedAt: 1,
            outcome: { status: "ok" },
          },
        },
      },
      { seedChildSessions: false },
    );
    const first = loadSubagentRegistryFromDisk();
    first.clear();
    const cachedEntry = loadSubagentRegistryFromDisk().get("run-cached");
    if (!cachedEntry) {
      throw new Error("expected cached run");
    }
    cachedEntry.endedAt = 999;
    cachedEntry.cleanupHandled = true;
    if (cachedEntry.requesterOrigin) {
      cachedEntry.requesterOrigin.accountId = "mutated-account";
    }
    if (cachedEntry.outcome) {
      cachedEntry.outcome.status = "error";
    }
    const second = loadSubagentRegistryFromDisk();

    expectFields(second.get("run-cached")?.requesterOrigin, { accountId: "cached-account" });
    expectFields(second.get("run-cached")?.outcome, { status: "ok" });
    expect(second.get("run-cached")?.endedAt).toBeUndefined();
    expect(second.get("run-cached")?.cleanupHandled).toBeUndefined();

    await fs.writeFile(
      registryPath,
      `${JSON.stringify({
        version: 2,
        runs: {
          "run-updated": {
            runId: "run-updated",
            childSessionKey: "agent:main:subagent:updated",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "updated persisted run with a longer payload",
            cleanup: "keep",
            createdAt: 2,
            startedAt: 2,
          },
        },
      })}\n`,
      "utf8",
    );

    expect(loadSubagentRegistryFromDisk().has("run-updated")).toBe(true);
  });

  it("reuses the persisted registry cache on hot internal read snapshots", async () => {
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          "run-cached-read": {
            runId: "run-cached-read",
            childSessionKey: "agent:main:subagent:cached-read",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "cached persisted run",
            cleanup: "keep",
            createdAt: 1,
            startedAt: 1,
          },
        },
      },
      { seedChildSessions: false },
    );
    const previousFlag = process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK;
    let cloneSpy: { mockRestore(): void } | undefined;
    try {
      process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK = "1";
      getSubagentRunsSnapshotForRead(new Map());
      cloneSpy = vi.spyOn(globalThis, "structuredClone");
      const snapshot = getSubagentRunsSnapshotForRead(new Map());

      expect(snapshot.has("run-cached-read")).toBe(true);
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy?.mockRestore();
      if (previousFlag === undefined) {
        delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK;
      } else {
        process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK = previousFlag;
      }
    }
  });

  it("returns empty maps for unchanged invalid persisted registry snapshots", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, "{invalid", "utf8");

    expect(loadSubagentRegistryFromDisk()).toEqual(new Map());
    expect(loadSubagentRegistryFromDisk()).toEqual(new Map());
  });

  it("normalizes persisted and newly registered session keys to canonical trimmed values", async () => {
    const persisted = {
      version: 2,
      runs: {
        "run-spaced": {
          runId: "run-spaced",
          childSessionKey: " agent:main:subagent:spaced-child ",
          controllerSessionKey: " agent:main:subagent:controller ",
          requesterSessionKey: " agent:main:main ",
          requesterDisplayKey: "main",
          task: "spaced persisted keys",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
        },
      },
    };
    await writePersistedRegistry(persisted, { seedChildSessions: false });

    const restored = loadSubagentRegistryFromDisk();
    const restoredEntry = restored.get("run-spaced");
    expectFields(restoredEntry, {
      childSessionKey: "agent:main:subagent:spaced-child",
      controllerSessionKey: "agent:main:subagent:controller",
      requesterSessionKey: "agent:main:main",
    });

    resetSubagentRegistryForTests({ persist: false });
    addSubagentRunForTests(restoredEntry as never);
    const restoredRuns = listSubagentRunsForRequester("agent:main:main");
    expect(restoredRuns).toHaveLength(1);
    expectFields(restoredRuns[0], { runId: "run-spaced" });
    expectFields(getSubagentRunByChildSessionKey("agent:main:subagent:spaced-child"), {
      runId: "run-spaced",
    });

    resetSubagentRegistryForTests({ persist: false });
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);

    vi.mocked(callGateway).mockResolvedValueOnce({
      status: "pending",
    });

    registerSubagentRun({
      runId: " run-live ",
      childSessionKey: " agent:main:subagent:live-child ",
      controllerSessionKey: " agent:main:subagent:live-controller ",
      requesterSessionKey: " agent:main:main ",
      requesterDisplayKey: "main",
      task: "live spaced keys",
      cleanup: "keep",
    });

    const liveRuns = listSubagentRunsForRequester("agent:main:main");
    expect(liveRuns).toHaveLength(1);
    expectFields(liveRuns[0], {
      runId: "run-live",
      childSessionKey: "agent:main:subagent:live-child",
      controllerSessionKey: "agent:main:subagent:live-controller",
      requesterSessionKey: "agent:main:main",
    });
    expectFields(getSubagentRunByChildSessionKey("agent:main:subagent:live-child"), {
      runId: "run-live",
    });
  });

  it("retries cleanup announce after a failed announce", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-3",
      childSessionKey: "agent:main:subagent:three",
      task: "retry announce",
      cleanup: "keep",
    });
    const registryPath = await writePersistedRegistry(persisted);

    announceSpy.mockResolvedValueOnce(false);
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterFirst = await readPersistedRun<{
        cleanupHandled?: boolean;
        cleanupCompletedAt?: number;
      }>(registryPath, "run-3");
      return (
        announceSpy.mock.calls.length === 1 &&
        afterFirst?.cleanupHandled === false &&
        afterFirst.cleanupCompletedAt === undefined
      );
    });

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = await readPersistedRun<{
      cleanupHandled?: boolean;
      cleanupCompletedAt?: number;
    }>(registryPath, "run-3");
    expect(afterFirst?.cleanupHandled).toBe(false);
    expect(afterFirst?.cleanupCompletedAt).toBeUndefined();

    announceSpy.mockResolvedValueOnce(true);
    const beforeRetry = Date.now();
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterSecond = await readPersistedRun<{
        cleanupCompletedAt?: number;
      }>(registryPath, "run-3");
      return announceSpy.mock.calls.length === 2 && afterSecond?.cleanupCompletedAt != null;
    });

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { cleanupCompletedAt?: number }>;
    };
    expect(
      expectDefined(afterSecond.runs["run-3"], 'afterSecond.runs["run-3"] test invariant')
        .cleanupCompletedAt,
    ).toBeGreaterThanOrEqual(beforeRetry);
  });

  it("retries cleanup announce after announce flow rejects", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-reject",
      childSessionKey: "agent:main:subagent:reject",
      task: "reject announce",
      cleanup: "keep",
    });
    const registryPath = await writePersistedRegistry(persisted);

    announceSpy.mockRejectedValueOnce(new Error("announce boom"));
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterFirst = await readPersistedRun<{
        cleanupHandled?: boolean;
        cleanupCompletedAt?: number;
      }>(registryPath, "run-reject");
      return (
        announceSpy.mock.calls.length === 1 &&
        afterFirst?.cleanupHandled === false &&
        afterFirst.cleanupCompletedAt === undefined
      );
    });

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { cleanupHandled?: boolean; cleanupCompletedAt?: number }>;
    };
    expect(
      expectDefined(afterFirst.runs["run-reject"], 'afterFirst.runs["run-reject"] test invariant')
        .cleanupHandled,
    ).toBe(false);
    expect(
      expectDefined(afterFirst.runs["run-reject"], 'afterFirst.runs["run-reject"] test invariant')
        .cleanupCompletedAt,
    ).toBeUndefined();

    announceSpy.mockResolvedValueOnce(true);
    const beforeRetry = Date.now();
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterSecond = await readPersistedRun<{
        cleanupCompletedAt?: number;
      }>(registryPath, "run-reject");
      return announceSpy.mock.calls.length === 2 && afterSecond?.cleanupCompletedAt != null;
    });

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { cleanupCompletedAt?: number }>;
    };
    expect(
      expectDefined(afterSecond.runs["run-reject"], 'afterSecond.runs["run-reject"] test invariant')
        .cleanupCompletedAt,
    ).toBeGreaterThanOrEqual(beforeRetry);
  });

  it("keeps delete-mode runs retryable when announce is deferred", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-4",
      childSessionKey: "agent:main:subagent:four",
      task: "deferred announce",
      cleanup: "delete",
    });
    const registryPath = await writePersistedRegistry(persisted);

    announceSpy.mockResolvedValueOnce(false);
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterFirst = await readPersistedRun<{ cleanupHandled?: boolean }>(
        registryPath,
        "run-4",
      );
      return announceSpy.mock.calls.length === 1 && afterFirst?.cleanupHandled === false;
    });

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = await readPersistedRun<{ cleanupHandled?: boolean }>(registryPath, "run-4");
    expect(afterFirst?.cleanupHandled).toBe(false);

    announceSpy.mockResolvedValueOnce(true);
    restartRegistry();
    await waitForRegistryWork(async () => {
      const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
        runs?: Record<string, unknown>;
      };
      return announceSpy.mock.calls.length === 2 && afterSecond.runs?.["run-4"] === undefined;
    });

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, unknown>;
    };
    expect(afterSecond.runs?.["run-4"]).toBeUndefined();
  });

  it("reconciles orphaned restored runs by pruning them from registry", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-orphan-restore",
      childSessionKey: "agent:main:subagent:ghost-restore",
      task: "orphan restore",
      cleanup: "keep",
    });
    const registryPath = await writePersistedRegistry(persisted, {
      seedChildSessions: false,
    });

    restartRegistry();
    await waitForRegistryWork(async () => {
      const after = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
        runs?: Record<string, unknown>;
      };
      return after.runs?.["run-orphan-restore"] === undefined;
    });

    expect(announceSpy).not.toHaveBeenCalled();
    const after = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, unknown>;
    };
    expect(after.runs?.["run-orphan-restore"]).toBeUndefined();
    expect(listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("preserves restored killed tombstones until bounded reconciliation", async () => {
    const now = Date.now();
    const runId = "run-killed-restore-tombstone";
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          [runId]: {
            runId,
            childSessionKey: "agent:main:subagent:killed-restore-tombstone",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "restore killed tombstone",
            cleanup: "keep",
            createdAt: now - 100,
            startedAt: now - 50,
            endedAt: now,
            endedReason: "subagent-killed",
            outcome: { status: "error", error: "manual kill" },
            suppressAnnounceReason: "killed",
            killReconciliation: { killedAt: now },
            cleanupHandled: true,
            cleanupCompletedAt: now,
          },
        },
      },
      { seedChildSessions: false },
    );

    restartRegistry();
    await flushQueuedRegistryWork();

    expect(announceSpy).not.toHaveBeenCalled();
    expect(listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({
        runId,
        endedReason: "subagent-killed",
        suppressAnnounceReason: "killed",
      }),
    ]);
  });

  it("preserves restored interrupted-recovery owners for orphan replay", async () => {
    const now = Date.now();
    const runId = "run-interrupted-recovery-restore";
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          [runId]: {
            runId,
            childSessionKey: "agent:main:subagent:interrupted-recovery-restore",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "replay interrupted terminal",
            cleanup: "keep",
            createdAt: now - 100,
            startedAt: now - 50,
            endedAt: now,
            endedReason: "subagent-error",
            outcome: { status: "error", error: "restart interrupted run" },
            terminalOwner: "interrupted-recovery",
            completion: { required: false, resultText: null, capturedAt: now },
          },
        },
      },
      { seedChildSessions: false },
    );

    restartRegistry();
    await waitForRegistryWork(() => vi.mocked(scheduleOrphanRecovery).mock.calls.length > 0);

    expect(callGateway).not.toHaveBeenCalled();
    expect(scheduleOrphanRecovery).toHaveBeenCalledOnce();
    expect(listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({ runId, terminalOwner: "interrupted-recovery" }),
    ]);
  });

  it("reconciles stale unended restored runs that are not restart-recoverable", async () => {
    const now = Date.now();
    const runId = "run-stale-unended-restore";
    const childSessionKey = "agent:main:subagent:stale-unended-restore";
    const registryPath = await writePersistedRegistry({
      version: 2,
      runs: {
        [runId]: {
          runId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "stale unended restored work",
          cleanup: "keep",
          createdAt: now - 3 * 60 * 60 * 1_000,
          startedAt: now - 3 * 60 * 60 * 1_000,
        },
      },
    });

    restartRegistry();
    await waitForRegistryWork(async () => {
      const after = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
        runs?: Record<string, unknown>;
      };
      return after.runs?.[runId] === undefined;
    });

    expect(callGateway).not.toHaveBeenCalled();
    expect(announceSpy).not.toHaveBeenCalled();
    expect(listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("keeps stale unended restored runs with abortedLastRun for lifecycle recovery", async () => {
    vi.mocked(callGateway).mockImplementationOnce(async (request) => {
      expectFields(request, {
        method: "agent.wait",
      });
      expectFields((request as { params?: unknown }).params, {
        runId: "run-stale-aborted-restore",
      });
      return {
        status: "pending",
      };
    });
    const now = Date.now();
    const runId = "run-stale-aborted-restore";
    const childSessionKey = "agent:main:subagent:stale-aborted-restore";
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          [runId]: {
            runId,
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "stale restart-recoverable work",
            cleanup: "keep",
            createdAt: now - 3 * 60 * 60 * 1_000,
            startedAt: now - 3 * 60 * 60 * 1_000,
          },
        },
      },
      { seedChildSessions: false },
    );
    await writeChildSessionEntry({
      sessionKey: childSessionKey,
      sessionId: "sess-stale-aborted-restore",
      updatedAt: now,
      abortedLastRun: true,
    });

    restartRegistry();
    await waitForRegistryWork(
      () =>
        vi.mocked(callGateway).mock.calls.length > 0 &&
        vi.mocked(scheduleOrphanRecovery).mock.calls.length > 0,
    );

    expect(callGateway).toHaveBeenCalledTimes(1);
    const [request] = vi.mocked(callGateway).mock.calls.at(0) ?? [];
    expectFields(request, { method: "agent.wait" });
    expectFields((request as { params?: unknown } | undefined)?.params, { runId });
    expect(scheduleOrphanRecovery).toHaveBeenCalledOnce();
    expect(
      listSubagentRunsForRequester("agent:main:main").some((entry) => entry.runId === runId),
    ).toBe(true);
  });

  it("removes attachments when pruning orphaned restored runs", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    const attachmentsRootDir = path.join(tempStateDir, "attachments");
    const attachmentsDir = path.join(attachmentsRootDir, "ghost");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact", "utf8");

    const persisted = createPersistedEndedRun({
      runId: "run-orphan-attachments",
      childSessionKey: "agent:main:subagent:ghost-attachments",
      task: "orphan attachments",
      cleanup: "delete",
    });
    Object.assign(persisted.runs["run-orphan-attachments"] as Record<string, unknown>, {
      attachmentsRootDir,
      attachmentsDir,
    });

    const registryPath = path.join(tempStateDir, "subagents", "runs.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");

    restartRegistry();
    await waitForRegistryWork(async () => {
      try {
        await fs.access(attachmentsDir);
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ENOENT";
      }
    });

    await expect(fs.access(attachmentsDir)).rejects.toHaveProperty("code", "ENOENT");
    const after = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, unknown>;
    };
    expect(after.runs?.["run-orphan-attachments"]).toBeUndefined();
  });

  it("prefers active runs and can resolve them from persisted registry snapshots", async () => {
    const childSessionKey = "agent:main:subagent:disk-active";
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          "run-complete": {
            runId: "run-complete",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "completed first",
            cleanup: "keep",
            createdAt: 200,
            startedAt: 210,
            endedAt: 220,
            outcome: { status: "ok" },
          },
          "run-active": {
            runId: "run-active",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "still running",
            cleanup: "keep",
            createdAt: 100,
            startedAt: 110,
          },
        },
      },
      { seedChildSessions: false },
    );

    resetSubagentRegistryForTests({ persist: false });

    const resolved = withEnv({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK: "1" }, () =>
      getSubagentRunByChildSessionKey(childSessionKey),
    );

    expectFields(resolved, {
      runId: "run-active",
      childSessionKey,
    });
    expect(resolved?.endedAt).toBeUndefined();
  });

  it("can resolve the newest child-session row even when an older stale row is still active", async () => {
    const childSessionKey = "agent:main:subagent:disk-latest";
    await writePersistedRegistry(
      {
        version: 2,
        runs: {
          "run-current-ended": {
            runId: "run-current-ended",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "completed latest",
            cleanup: "keep",
            createdAt: 200,
            startedAt: 210,
            endedAt: 220,
            outcome: { status: "ok" },
          },
          "run-stale-active": {
            runId: "run-stale-active",
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "stale active",
            cleanup: "keep",
            createdAt: 100,
            startedAt: 110,
          },
        },
      },
      { seedChildSessions: false },
    );

    resetSubagentRegistryForTests({ persist: false });

    const resolved = withEnv({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK: "1" }, () =>
      getLatestSubagentRunByChildSessionKey(childSessionKey),
    );

    expectFields(resolved, {
      runId: "run-current-ended",
      childSessionKey,
    });
    expect(resolved?.endedAt).toBe(220);
  });

  it("resume guard prunes orphan runs before announce retry", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    const runId = "run-orphan-resume-guard";
    const childSessionKey = "agent:main:subagent:ghost-resume";
    const now = Date.now();

    await writeChildSessionEntry({
      sessionKey: childSessionKey,
      sessionId: "sess-resume-guard",
      updatedAt: now,
    });
    addSubagentRunForTests({
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "resume orphan guard",
      cleanup: "keep",
      createdAt: now - 50,
      startedAt: now - 25,
      endedAt: now,
      suppressAnnounceReason: "steer-restart",
      cleanupHandled: false,
    });
    await removeChildSessionEntry(childSessionKey);

    const changed = clearSubagentRunSteerRestart(runId);
    expect(changed).toBe(true);
    await flushQueuedRegistryWork();

    expect(announceSpy).not.toHaveBeenCalled();
    expect(listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    const persisted = loadSubagentRegistryFromDisk();
    expect(persisted.has(runId)).toBe(false);
  });

  it("uses isolated temp state when OPENCLAW_STATE_DIR is unset in tests", () => {
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
    const registryPath = resolveSubagentRegistryPath();
    expect(registryPath).toContain(path.join(os.tmpdir(), "openclaw-test-state"));
  });
});
