import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
} from "../config/sessions/store.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { captureEnv, withEnv } from "../test-utils/env.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import {
  __testing,
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
  loadSubagentRegistryFromDisk,
  resolveSubagentRegistryPath,
} from "./subagent-registry.store.js";

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => true),
}));
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: vi.fn(),
}));

describe("subagent registry persistence", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | null = null;

  const resolveAgentIdFromSessionKey = (sessionKey: string) => {
    const match = sessionKey.match(/^agent:([^:]+):/i);
    return (match?.[1] ?? "main").trim().toLowerCase() || "main";
  };

  const resolveSessionStorePath = (stateDir: string, agentId: string) =>
    path.join(stateDir, "agents", agentId, "sessions", "sessions.json");

  const readSessionStore = async (storePath: string) => {
    try {
      const raw = await fs.readFile(storePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, Record<string, unknown>>;
      }
    } catch {
      // ignore
    }
    return {} as Record<string, Record<string, unknown>>;
  };

  const writeChildSessionEntry = async (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
  }) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    const storePath = resolveSessionStorePath(tempStateDir, agentId);
    const store = await readSessionStore(storePath);
    store[params.sessionKey] = {
      ...store[params.sessionKey],
      sessionId: params.sessionId ?? `sess-${agentId}-${Date.now()}`,
      updatedAt: params.updatedAt ?? Date.now(),
    };
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, `${JSON.stringify(store)}\n`, "utf8");
    return storePath;
  };

  const removeChildSessionEntry = async (sessionKey: string) => {
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveSessionStorePath(tempStateDir, agentId);
    const store = await readSessionStore(storePath);
    delete store[sessionKey];
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, `${JSON.stringify(store)}\n`, "utf8");
    return storePath;
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
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  };

  const restartRegistryAndFlush = async () => {
    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();
    await flushQueuedRegistryWork();
  };

  beforeEach(() => {
    __testing.setDepsForTest({
      cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
      ensureContextEnginesInitialized: vi.fn(),
      ensureRuntimePluginsLoaded: vi.fn(),
      loadConfig: vi.fn(() => ({})),
      resolveAgentTimeoutMs: vi.fn(() => 100),
      resolveContextEngine: vi.fn(async () => ({
        info: { id: "test", name: "Test", version: "0.0.1" },
        ingest: vi.fn(async () => ({ ingested: false })),
        assemble: vi.fn(async ({ messages }) => ({ messages, estimatedTokens: 0 })),
        compact: vi.fn(async () => ({ ok: false, compacted: false })),
      })),
      runSubagentAnnounceFlow: announceSpy,
    });
    vi.mocked(callGateway).mockReset();
    vi.mocked(callGateway).mockResolvedValue({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    vi.mocked(onAgentEvent).mockReset();
    vi.mocked(onAgentEvent).mockReturnValue(() => undefined);
  });

  afterEach(async () => {
    announceSpy.mockClear();
    __testing.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    await drainSessionStoreLockQueuesForTest();
    clearSessionStoreCacheForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("persists completed subagent timing into the child session entry", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

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

    const store = await readSessionStore(storePath);
    const persisted = store["agent:main:subagent:timing"];
    expect(persisted?.endedAt).toBe(endedAt);
    expect(persisted?.runtimeMs).toBe(500);
    expect(persisted?.status).toBe("done");
    expect(persisted?.startedAt).toBeGreaterThanOrEqual(startedAt);
    expect(persisted?.startedAt).toBeLessThanOrEqual(endedAt);
  });

  it("skips cleanup when cleanupHandled was persisted", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

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

    resetSubagentRegistryForTests({ persist: false });
    initSubagentRegistry();

    await flushQueuedRegistryWork();

    // announce should NOT be called since cleanupHandled was true
    const calls = (announceSpy.mock.calls as unknown as Array<[unknown]>).map((call) => call[0]);
    const match = calls.find(
      (params) =>
        (params as { childSessionKey?: string }).childSessionKey === "agent:main:subagent:two",
    );
    expect(match).toBeFalsy();
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
    expect(restoredEntry).toMatchObject({
      childSessionKey: "agent:main:subagent:spaced-child",
      controllerSessionKey: "agent:main:subagent:controller",
      requesterSessionKey: "agent:main:main",
    });

    resetSubagentRegistryForTests({ persist: false });
    addSubagentRunForTests(restoredEntry as never);
    expect(listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({
        runId: "run-spaced",
      }),
    ]);
    expect(getSubagentRunByChildSessionKey("agent:main:subagent:spaced-child")).toMatchObject({
      runId: "run-spaced",
    });

    resetSubagentRegistryForTests({ persist: false });
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    vi.mocked(callGateway).mockImplementationOnce(async () => await new Promise(() => {}));

    registerSubagentRun({
      runId: " run-live ",
      childSessionKey: " agent:main:subagent:live-child ",
      controllerSessionKey: " agent:main:subagent:live-controller ",
      requesterSessionKey: " agent:main:main ",
      requesterDisplayKey: "main",
      task: "live spaced keys",
      cleanup: "keep",
    });

    expect(listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({
        runId: "run-live",
        childSessionKey: "agent:main:subagent:live-child",
        controllerSessionKey: "agent:main:subagent:live-controller",
        requesterSessionKey: "agent:main:main",
      }),
    ]);
    expect(getSubagentRunByChildSessionKey("agent:main:subagent:live-child")).toMatchObject({
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
    await restartRegistryAndFlush();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = await readPersistedRun<{
      cleanupHandled?: boolean;
      cleanupCompletedAt?: number;
    }>(registryPath, "run-3");
    expect(afterFirst?.cleanupHandled).toBe(false);
    expect(afterFirst?.cleanupCompletedAt).toBeUndefined();

    announceSpy.mockResolvedValueOnce(true);
    await restartRegistryAndFlush();

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { cleanupCompletedAt?: number }>;
    };
    expect(afterSecond.runs["run-3"].cleanupCompletedAt).toBeDefined();
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
    await restartRegistryAndFlush();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { cleanupHandled?: boolean; cleanupCompletedAt?: number }>;
    };
    expect(afterFirst.runs["run-reject"].cleanupHandled).toBe(false);
    expect(afterFirst.runs["run-reject"].cleanupCompletedAt).toBeUndefined();

    announceSpy.mockResolvedValueOnce(true);
    await restartRegistryAndFlush();

    expect(announceSpy).toHaveBeenCalledTimes(2);
    const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { cleanupCompletedAt?: number }>;
    };
    expect(afterSecond.runs["run-reject"].cleanupCompletedAt).toBeDefined();
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
    await restartRegistryAndFlush();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const afterFirst = await readPersistedRun<{ cleanupHandled?: boolean }>(registryPath, "run-4");
    expect(afterFirst?.cleanupHandled).toBe(false);

    announceSpy.mockResolvedValueOnce(true);
    await restartRegistryAndFlush();

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

    await restartRegistryAndFlush();

    expect(announceSpy).not.toHaveBeenCalled();
    const after = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, unknown>;
    };
    expect(after.runs?.["run-orphan-restore"]).toBeUndefined();
    expect(listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("removes attachments when pruning orphaned restored runs", async () => {
    const persisted = createPersistedEndedRun({
      runId: "run-orphan-attachments",
      childSessionKey: "agent:main:subagent:ghost-attachments",
      task: "orphan attachments",
      cleanup: "delete",
    });
    const registryPath = await writePersistedRegistry(persisted, {
      seedChildSessions: false,
    });
    if (!tempStateDir) {
      throw new Error("tempStateDir not initialized");
    }
    const attachmentsRootDir = path.join(tempStateDir, "attachments");
    const attachmentsDir = path.join(attachmentsRootDir, "ghost");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact", "utf8");
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs?: Record<string, Record<string, unknown>>;
    };
    if (!parsed.runs?.["run-orphan-attachments"]) {
      throw new Error("expected orphaned run in persisted registry");
    }
    parsed.runs["run-orphan-attachments"] = {
      ...parsed.runs["run-orphan-attachments"],
      attachmentsRootDir,
      attachmentsDir,
    };
    await fs.writeFile(registryPath, `${JSON.stringify(parsed)}\n`, "utf8");

    await restartRegistryAndFlush();

    await expect(fs.access(attachmentsDir)).rejects.toMatchObject({ code: "ENOENT" });
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

    const resolved = withEnv({ VITEST: undefined, NODE_ENV: "development" }, () =>
      getSubagentRunByChildSessionKey(childSessionKey),
    );

    expect(resolved).toMatchObject({
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

    const resolved = withEnv({ VITEST: undefined, NODE_ENV: "development" }, () =>
      getLatestSubagentRunByChildSessionKey(childSessionKey),
    );

    expect(resolved).toMatchObject({
      runId: "run-current-ended",
      childSessionKey,
    });
    expect(resolved?.endedAt).toBe(220);
  });

  it("resume guard prunes orphan runs before announce retry", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
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

  it("uses isolated temp state when OPENCLAW_STATE_DIR is unset in tests", async () => {
    delete process.env.OPENCLAW_STATE_DIR;
    const registryPath = resolveSubagentRegistryPath();
    expect(registryPath).toContain(path.join(os.tmpdir(), "openclaw-test-state"));
  });
});
