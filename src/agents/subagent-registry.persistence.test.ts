// Subagent registry persistence tests cover JSON registry restore, child
// session timing writes, and restart cleanup behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue, withEnv } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { scheduleOrphanRecovery } from "./subagent-orphan-recovery.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import {
  createSubagentRegistryTestDeps,
  readSubagentSessionStore,
  removeSubagentSessionEntry,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
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
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { createAgentsWaitTool } from "./tools/agents-wait-tool.js";

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
    // Each persisted-registry fixture gets its own state dir so session and
    // subagent SQLite stores use the same production paths.
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    const runs = (persisted.runs ?? {}) as Record<string, SubagentRunRecord>;
    saveSubagentRegistryToSqlite(new Map(Object.entries(runs)));
    if (opts?.seedChildSessions !== false) {
      await seedChildSessionsForPersistedRuns(persisted);
    }
    return path.join(tempStateDir, "state", "openclaw.sqlite");
  };

  const readPersistedRun = async <T>(
    _registryPath: string,
    runId: string,
  ): Promise<T | undefined> => {
    return loadSubagentRegistryFromSqlite().get(runId) as T | undefined;
  };

  const readPersistedRegistry = () => ({
    runs: Object.fromEntries(loadSubagentRegistryFromSqlite()),
  });

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

  const fastPersistSubagentRunsToDisk = (runs: Map<string, SubagentRunRecord>) =>
    saveSubagentRegistryToSqlite(runs);

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
    closeOpenClawStateDatabaseForTest();
    testing.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    await cleanupSessionStateForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("round-trips the progress source locator through SQLite", async () => {
    const progressOrigin = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: "789",
      channelId: "123",
      messageId: "456",
    };
    const record: SubagentRunRecord = {
      runId: "run-progress-origin",
      childSessionKey: "agent:main:subagent:progress-origin",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      progressOrigin,
      task: "persist progress source",
      cleanup: "keep",
      createdAt: 1,
    };

    await writePersistedRegistry(
      { runs: { [record.runId]: record } },
      { seedChildSessions: false },
    );

    expect(loadSubagentRegistryFromSqlite().get(record.runId)?.progressOrigin).toEqual(
      progressOrigin,
    );
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
    saveSubagentRegistryToSqlite(
      new Map(Object.entries(persisted.runs) as Array<[string, SubagentRunRecord]>),
    );
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
    const previousFlag = process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;
    let cloneSpy: { mockRestore(): void } | undefined;
    try {
      process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = "1";
      getSubagentRunsSnapshotForRead(new Map());
      cloneSpy = vi.spyOn(globalThis, "structuredClone");
      const snapshot = getSubagentRunsSnapshotForRead(new Map());

      expect(snapshot.has("run-cached-read")).toBe(true);
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy?.mockRestore();
      if (previousFlag === undefined) {
        delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;
      } else {
        process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = previousFlag;
      }
    }
  });

  it("normalizes newly registered session keys to canonical trimmed values", async () => {
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

  it("reloads waitable swarm collector completions after a gateway restart", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    const run: SubagentRunRecord = {
      runId: "run-swarm-restart",
      childSessionKey: "agent:worker:subagent:swarm-restart",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persist collector result",
      cleanup: "keep",
      createdAt: 1,
      endedAt: 2,
      collect: true,
      swarmRequesterSessionKey: "agent:worker:subagent:owner",
      swarmWaitOwnerSessionKeys: ["agent:worker:subagent:owner", "agent:main:main"],
      groupId: "swarm:agent:main:main:parent-run",
      outputSchema: { type: "object", required: ["answer"] },
      completion: { required: false, resultText: "raw answer", capturedAt: 2 },
      collectorCompletion: {
        status: "done",
        structured: { answer: 42 },
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    };
    saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
    await writeChildSessionEntry({
      sessionKey: run.childSessionKey,
      sessionId: "session-swarm-restart",
      updatedAt: run.endedAt,
    });

    closeOpenClawStateDatabaseForTest();
    const restored = loadSubagentRegistryFromSqlite().get(run.runId);

    expect(restored).toMatchObject({
      runId: run.runId,
      collect: true,
      swarmRequesterSessionKey: run.swarmRequesterSessionKey,
      swarmWaitOwnerSessionKeys: run.swarmWaitOwnerSessionKeys,
      groupId: run.groupId,
      outputSchema: run.outputSchema,
      completion: { resultText: "raw answer" },
      collectorCompletion: {
        status: "done",
        structured: { answer: 42 },
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    });

    restartRegistry();
    const wait = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });
    const waited = await wait.execute("wait-after-restart", {
      ids: [run.runId],
      timeoutSeconds: 0,
    });
    expect(waited.details).toMatchObject({
      completed: [
        {
          runId: run.runId,
          status: "done",
          result: "raw answer",
          structured: { answer: 42 },
        },
      ],
      pending: [],
    });
  });

  it("reloads queued launch and in-flight structured state", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    const run: SubagentRunRecord = {
      runId: "run-swarm-in-flight",
      childSessionKey: "agent:worker:subagent:swarm-in-flight",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persist collector launch",
      cleanup: "keep",
      createdAt: 1,
      collect: true,
      swarmRequesterSessionKey: "agent:main:telegram:default:direct:456",
      groupId: "logical-group",
      outputSchema: { type: "object" },
      execution: { status: "queued" },
      structuredOutput: { invalidAttempts: 1, schemaError: "answer is required" },
      queuedLaunch: {
        request: { sessionKey: "agent:worker:subagent:swarm-in-flight" },
        authorization: {
          modelOverride: { provider: "openai", model: "gpt-5.4" },
        },
        timeoutMs: 1_000,
        schedulerGroupKey: '["agent:main:main","logical-group"]',
        maxConcurrent: 8,
      },
    };
    saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

    closeOpenClawStateDatabaseForTest();
    expect(loadSubagentRegistryFromSqlite().get(run.runId)).toMatchObject({
      swarmRequesterSessionKey: run.swarmRequesterSessionKey,
      structuredOutput: run.structuredOutput,
      queuedLaunch: run.queuedLaunch,
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
    const afterSecond = readPersistedRegistry();
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
    const afterFirst = readPersistedRegistry();
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
    const afterSecond = readPersistedRegistry();
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
      const afterSecond = readPersistedRegistry();
      return announceSpy.mock.calls.length === 2 && afterSecond.runs?.["run-4"] === undefined;
    });

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = readPersistedRegistry();
    expect(afterSecond.runs?.["run-4"]).toBeUndefined();
  });

  it("reconciles orphaned restored runs by pruning them from registry", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-orphan-restore",
      childSessionKey: "agent:main:subagent:ghost-restore",
      task: "orphan restore",
      cleanup: "keep",
    });
    await writePersistedRegistry(persisted, {
      seedChildSessions: false,
    });

    restartRegistry();
    await waitForRegistryWork(async () => {
      const after = readPersistedRegistry();
      return after.runs?.["run-orphan-restore"] === undefined;
    });

    expect(announceSpy).not.toHaveBeenCalled();
    const after = readPersistedRegistry();
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
    await writePersistedRegistry({
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
      const after = readPersistedRegistry();
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
    await waitForRegistryWork(() => vi.mocked(scheduleOrphanRecovery).mock.calls.length > 0);

    // The dead pre-restart run must not be queried before orphan recovery can
    // replace it with a fresh turn through the Gateway-owned runtime.
    expect(callGateway).not.toHaveBeenCalled();
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

    saveSubagentRegistryToSqlite(
      new Map(Object.entries(persisted.runs) as Array<[string, SubagentRunRecord]>),
    );

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
    const after = readPersistedRegistry();
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

    const resolved = withEnv({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, () =>
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

    const resolved = withEnv({ OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" }, () =>
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
    const persisted = loadSubagentRegistryFromSqlite();
    expect(persisted.has(runId)).toBe(false);
  });
});
