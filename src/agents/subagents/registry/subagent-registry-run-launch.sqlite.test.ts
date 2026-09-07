import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../../tasks/detached-task-runtime.test-support.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../../tasks/task-registry.store.js";
import { loadTaskRegistryStateFromSqlite } from "../../../tasks/task-registry.store.sqlite.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { spawnSubagentDirect } from "../spawn/subagent-spawn.js";
import { testing as subagentSpawnTesting } from "../spawn/subagent-spawn.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  getSubagentRunsSnapshotForRead,
  onSubagentRegistryPersisted,
} from "./subagent-registry-state.js";
import { registerSubagentRun, startQueuedSubagentRun } from "./subagent-registry.js";
import {
  createSubagentRegistryTestDeps,
  settleSubagentRegistryPersistenceWork,
} from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  readSubagentRun,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";

describe("queued collector acceptance storage", () => {
  const env = captureEnv([
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE",
  ]);
  let stateDir = "";

  function makeGatewayContext(): GatewayRequestContext {
    return {
      logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getRuntimeConfig,
    } as unknown as GatewayRequestContext;
  }

  function externalCliClient(): GatewayRequestOptions["client"] {
    return {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "cli", version: "test", platform: "test", mode: "cli" },
        scopes: ["operator.write"],
      },
    } as GatewayRequestOptions["client"];
  }

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-collector-acceptance-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    setTestEnvValue("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify({
        session: { mainKey: "main", scope: "per-sender" },
        tools: { swarm: { enabled: true, maxConcurrent: 1 } },
        agents: { defaults: { workspace: stateDir }, entries: { main: { workspace: stateDir } } },
      })}\n`,
    );
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetGatewayWorkAdmission();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDisk: saveSubagentRegistryToSqlite,
      callGateway: async <T>() => ({ status: "pending" }) as T,
    });
  });

  afterEach(async () => {
    await settleSubagentRegistryPersistenceWork();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    resetDetachedTaskLifecycleRuntimeForTests();
    testing.setDepsForTest();
    subagentSpawnTesting.setDepsForTest();
    resetGatewayWorkAdmission();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    closeOpenClawStateDatabaseForTest();
    await rm(stateDir, { recursive: true, force: true });
    env.restore();
  });

  function registerPreparedCollector(runId: string) {
    registerSubagentRun({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "atomic collector acceptance",
      cleanup: "keep",
      collect: true,
      groupId: "atomic-acceptance",
      queued: true,
      taskRowOwnership: "required",
      expectsCompletionMessage: false,
    });
    return findTaskByRunId(runId)!;
  }

  it("commits the gateway id without changing public task identity", () => {
    const reservedRunId = "reserved-success";
    const acceptedRunId = "accepted-success";
    const task = registerPreparedCollector(reservedRunId);

    expect(startQueuedSubagentRun(reservedRunId, acceptedRunId)).toBe(true);

    expect(subagentRuns.has(reservedRunId)).toBe(false);
    expect(subagentRuns.get(acceptedRunId)).toMatchObject({
      runId: acceptedRunId,
      swarmRunId: reservedRunId,
      taskRunId: reservedRunId,
      execution: { status: "running" },
    });
    expect(loadSubagentRegistryFromSqlite().get(acceptedRunId)).toMatchObject({
      swarmRunId: reservedRunId,
      taskRunId: reservedRunId,
    });
    expect(findTaskByRunId(reservedRunId)).toMatchObject({
      taskId: task.taskId,
      runId: reservedRunId,
      status: "running",
    });
    expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toMatchObject({
      runId: reservedRunId,
      status: "running",
    });
  });

  it("publishes both primed caches before either acceptance observer runs", () => {
    const reservedRunId = "reserved-observer";
    const acceptedRunId = "accepted-observer";
    const task = registerPreparedCollector(reservedRunId);
    expect(getSubagentRunsSnapshotForRead(new Map()).has(reservedRunId)).toBe(true);
    const snapshots: Array<{ observer: string; oldRun: boolean; run?: string; task?: string }> = [];
    const capture = (observer: string) => {
      const runs = getSubagentRunsSnapshotForRead(new Map());
      snapshots.push({
        observer,
        oldRun: runs.has(reservedRunId),
        run: runs.get(acceptedRunId)?.execution.status,
        task: findTaskByRunId(reservedRunId)?.status,
      });
    };
    const unsubscribe = onSubagentRegistryPersisted(() => capture("subagent"));
    configureTaskRegistryRuntime({
      observers: {
        onEvent: (event) => {
          if (event.kind === "upserted" && event.task.taskId === task.taskId) {
            capture("task");
          }
        },
      },
    });
    try {
      expect(startQueuedSubagentRun(reservedRunId, acceptedRunId)).toBe(true);
    } finally {
      unsubscribe();
    }

    expect(snapshots).toEqual([
      { observer: "subagent", oldRun: false, run: "running", task: "running" },
      { observer: "task", oldRun: false, run: "running", task: "running" },
    ]);
  });

  it("keeps both prepared rows queued on an accepted id collision", () => {
    const reservedRunId = "reserved-collision";
    const acceptedRunId = "accepted-collision";
    registerPreparedCollector(reservedRunId);
    const database = openOpenClawStateDatabase();
    database.db
      .prepare(
        `INSERT INTO subagent_runs
          (run_id, child_session_key, controller_session_key, requester_session_key, created_at, payload_json)
         SELECT ?, child_session_key, controller_session_key, requester_session_key, created_at, payload_json
         FROM subagent_runs WHERE run_id = ?`,
      )
      .run(acceptedRunId, reservedRunId);

    expect(() => startQueuedSubagentRun(reservedRunId, acceptedRunId)).toThrow();

    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, acceptedRunId)).not.toBeNull();
    expect(findTaskByRunId(reservedRunId)?.status).toBe("queued");
  });

  it("keeps both prepared rows queued when the task snapshot drifts", () => {
    const reservedRunId = "reserved-drift";
    const acceptedRunId = "accepted-drift";
    const task = registerPreparedCollector(reservedRunId);
    const database = openOpenClawStateDatabase();
    database.db
      .prepare("UPDATE task_runs SET status = 'running' WHERE task_id = ?")
      .run(task.taskId);

    expect(() => startQueuedSubagentRun(reservedRunId, acceptedRunId)).toThrow(
      "prepared task state changed before atomic acceptance",
    );

    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, acceptedRunId)).toBeNull();
    expect(findTaskByRunId(reservedRunId)?.status).toBe("queued");
  });

  it("keeps both prepared rows queued when the subagent snapshot drifts", () => {
    const reservedRunId = "reserved-run-drift";
    const acceptedRunId = "accepted-run-drift";
    registerPreparedCollector(reservedRunId);
    const database = openOpenClawStateDatabase();
    database.db
      .prepare("UPDATE subagent_runs SET requester_session_key = ? WHERE run_id = ?")
      .run("agent:main:drifted", reservedRunId);

    expect(() => startQueuedSubagentRun(reservedRunId, acceptedRunId)).toThrow(
      "collector run state changed before gateway acceptance",
    );

    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, acceptedRunId)).toBeNull();
    expect(findTaskByRunId(reservedRunId)?.status).toBe("queued");
  });

  it("rolls back both prepared rows when the transaction fails", () => {
    const reservedRunId = "reserved-rollback";
    const acceptedRunId = "accepted-rollback";
    const task = registerPreparedCollector(reservedRunId);
    const database = openOpenClawStateDatabase();
    database.db.exec(`
      CREATE TEMP TRIGGER fail_collector_acceptance
      BEFORE UPDATE ON task_runs
      BEGIN
        SELECT RAISE(ABORT, 'injected acceptance failure');
      END
    `);

    expect(() => startQueuedSubagentRun(reservedRunId, acceptedRunId)).toThrow(
      "injected acceptance failure",
    );

    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, acceptedRunId)).toBeNull();
    expect(findTaskByRunId(reservedRunId)?.status).toBe("queued");
    expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toMatchObject({
      status: "queued",
    });
  });

  it("accepts a non-mirrored custom task runtime with the stable task id", () => {
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const startTaskRunByRunId = vi.fn(() => []);
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createQueuedTaskRun: (params) => ({
        taskId: "custom-task",
        runtime: params.runtime,
        requesterSessionKey: params.requesterSessionKey ?? "",
        ownerKey: params.ownerKey ?? params.requesterSessionKey ?? "",
        scopeKind: params.scopeKind ?? "session",
        childSessionKey: params.childSessionKey,
        runId: params.runId,
        task: params.task,
        status: "queued",
        deliveryStatus: params.deliveryStatus ?? "pending",
        notifyPolicy: params.notifyPolicy ?? "silent",
        createdAt: Date.now(),
      }),
      startTaskRunByRunId,
    });
    const reservedRunId = "custom-reserved";
    const acceptedRunId = "custom-accepted";

    registerPreparedCollector(reservedRunId);

    expect(startQueuedSubagentRun(reservedRunId, acceptedRunId)).toBe(true);
    expect(startTaskRunByRunId).toHaveBeenCalledWith({
      runId: reservedRunId,
      runtime: "subagent",
      sessionKey: `agent:main:subagent:${reservedRunId}`,
      startedAt: expect.any(Number),
      lastEventAt: expect.any(Number),
    });
    expect(subagentRuns.get(acceptedRunId)).toMatchObject({
      runId: acceptedRunId,
      taskRunId: reservedRunId,
      swarmRunId: reservedRunId,
      execution: { status: "running" },
    });
    expect(loadSubagentRegistryFromSqlite().get(acceptedRunId)).toMatchObject({
      taskRunId: reservedRunId,
      swarmRunId: reservedRunId,
    });
    expect(findTaskByRunId(reservedRunId)).toBeUndefined();
  });

  it("restores a custom runtime row before aborting the exact accepted id", async () => {
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const startTaskRunByRunId = vi.fn(() => {
      throw new Error("custom runtime start failed");
    });
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createQueuedTaskRun: (params) => ({
        taskId: "custom-failure-task",
        runtime: params.runtime,
        requesterSessionKey: params.requesterSessionKey ?? "",
        ownerKey: params.ownerKey ?? params.requesterSessionKey ?? "",
        scopeKind: params.scopeKind ?? "session",
        childSessionKey: params.childSessionKey,
        runId: params.runId,
        task: params.task,
        status: "queued",
        deliveryStatus: params.deliveryStatus ?? "pending",
        notifyPolicy: params.notifyPolicy ?? "silent",
        createdAt: Date.now(),
      }),
      startTaskRunByRunId,
    });
    const abortEntered = createDeferred<void>();
    const releaseAbort = createDeferred<void>();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        requests.push({ method, params });
        if (method === "agent") {
          return { runId: "gateway-accepted-custom", status: "accepted" } as T;
        }
        if (method === "chat.abort") {
          abortEntered.resolve();
          await releaseAbort.promise;
          return { aborted: true, runIds: [params.runId] } as T;
        }
        return {} as T;
      },
    });

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context: makeGatewayContext(),
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        spawnSubagentDirect(
          {
            task: "rollback custom runtime collector",
            collect: true,
            context: "isolated",
            lightContext: true,
            groupId: "custom-rollback",
          },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
    );

    expect(result.status).toBe("accepted");
    await abortEntered.promise;
    const reservedRunId = result.runId!;
    const database = openOpenClawStateDatabase();
    expect(startTaskRunByRunId).toHaveBeenCalledWith({
      runId: reservedRunId,
      runtime: "subagent",
      sessionKey: expect.any(String),
      startedAt: expect.any(Number),
      lastEventAt: expect.any(Number),
    });
    expect(requests).toContainEqual({
      method: "chat.abort",
      params: expect.objectContaining({ runId: "gateway-accepted-custom" }),
    });
    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, "gateway-accepted-custom")).toBeNull();
    expect(findTaskByRunId(reservedRunId)).toBeUndefined();

    releaseAbort.resolve();
    await vi.waitFor(() => {
      expect(subagentRuns.get(reservedRunId)?.collectorCompletion).toMatchObject({
        status: "failed",
      });
    });
  });

  it("aborts the exact accepted id after atomic acceptance rolls back", async () => {
    const abortEntered = createDeferred<void>();
    const releaseAbort = createDeferred<void>();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        requests.push({ method, params });
        if (method === "agent") {
          return { runId: "gateway-accepted-atomic", status: "accepted" } as T;
        }
        if (method === "chat.abort") {
          abortEntered.resolve();
          await releaseAbort.promise;
          return { aborted: true, runIds: [params.runId] } as T;
        }
        return {} as T;
      },
    });
    openOpenClawStateDatabase().db.exec(`
      CREATE TEMP TRIGGER fail_spawn_collector_acceptance
      BEFORE UPDATE ON task_runs
      BEGIN
        SELECT RAISE(ABORT, 'injected atomic acceptance failure');
      END
    `);

    const result = await withPluginRuntimeGatewayRequestScope(
      {
        context: makeGatewayContext(),
        client: externalCliClient(),
        isWebchatConnect: () => false,
      },
      () =>
        spawnSubagentDirect(
          {
            task: "rollback accepted collector",
            collect: true,
            context: "isolated",
            lightContext: true,
            groupId: "atomic-rollback",
          },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
    );

    expect(result.status).toBe("accepted");
    await abortEntered.promise;
    const reservedRunId = result.runId!;
    const task = findTaskByRunId(reservedRunId)!;
    const database = openOpenClawStateDatabase();
    expect(requests).toContainEqual({
      method: "chat.abort",
      params: expect.objectContaining({ runId: "gateway-accepted-atomic" }),
    });
    expect(subagentRuns.get(reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, reservedRunId)?.execution.status).toBe("queued");
    expect(readSubagentRun(database, "gateway-accepted-atomic")).toBeNull();
    expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)?.status).toBe("queued");

    releaseAbort.resolve();
    await vi.waitFor(() => {
      expect(subagentRuns.get(reservedRunId)?.collectorCompletion).toMatchObject({
        status: "failed",
      });
    });
  });
});
