import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagents/registry/subagent-registry.mocks.shared.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import * as detachedTaskRuntime from "../tasks/detached-task-runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { runSpawnPipeline } from "./spawn-pipeline.js";
import type {
  RegisterSubagentRunParams,
  SubagentRegistrationIdentity,
} from "./subagents/registry/subagent-registry-run-launch.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagents/registry/subagent-registry-state.js";
import {
  recordAcceptedSubagentSpawnRollback,
  rollbackSubagentRunRegistration,
} from "./subagents/registry/subagent-registry.js";
import {
  createSubagentRegistryTestDeps,
  canonicalSubagentRunFixtures,
} from "./subagents/registry/subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagents/registry/subagent-registry.store.sqlite.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
  testing,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";

describe("subagent registration rollback", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let tempStateDir: string | undefined;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-rollback-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempStateDir);
    testing.setDepsForTest(createSubagentRegistryTestDeps());
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    testing.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = undefined;
    }
    envSnapshot.restore();
  });

  const createOlderKilledRun = (childSessionKey: string): SubagentRunRecord => ({
    runId: "run-task-registration-older",
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "older killed generation",
    cleanup: "keep",
    generation: 1,
    createdAt: 1,
    execution: {
      status: "terminal",
      startedAt: 1,
      endedAt: 2,
      outcome: { status: "error", error: "killed" },
    },
    completion: { required: false, resultText: null, capturedAt: 2 },
    delivery: { status: "not_required" },
    endedReason: "subagent-killed",
    suppressAnnounceReason: "killed",
    killReconciliation: { killedAt: 2 },
    cleanupHandled: true,
    cleanupCompletedAt: 2,
  });

  const createPriorSameIdRun = (runId: string, childSessionKey: string): SubagentRunRecord => ({
    runId,
    taskRunId: runId,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "prior same-id run",
    cleanup: "keep",
    generation: 2,
    createdAt: 3,
    execution: {
      status: "terminal",
      startedAt: 3,
      endedAt: 4,
      outcome: { status: "ok" },
    },
    completion: { required: false, resultText: "prior result", capturedAt: 4 },
    delivery: { status: "not_required" },
    endedReason: "subagent-complete",
    cleanupHandled: true,
    cleanupCompletedAt: 4,
  });

  function createRegistration(runId: string, childSessionKey: string) {
    return {
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "registration ownership integration",
      cleanup: "keep" as const,
      taskRowOwnership: "required" as const,
    };
  }

  function createPipelineAdapter(cleanupOnFailure: (params: { error: unknown }) => Promise<void>) {
    return {
      initialize: async () => ({}),
      dispatchTurn: async () => ({ runId: "run-pipeline-registration" }),
      cleanupOnFailure,
    };
  }

  function recordAcceptedRollback(
    registration: RegisterSubagentRunParams & {
      expectedRegistration: SubagentRegistrationIdentity;
    },
    error: unknown,
  ) {
    return recordAcceptedSubagentSpawnRollback({
      runId: registration.runId,
      childSessionKey: registration.childSessionKey,
      gatewayRunId: registration.runId,
      reason: error instanceof Error ? error.message : String(error),
      expectedRegistration: registration.expectedRegistration,
    });
  }

  function rollbackRegistration(
    registration: RegisterSubagentRunParams & {
      expectedRegistration: SubagentRegistrationIdentity;
    },
  ) {
    return rollbackSubagentRunRegistration({
      runId: registration.runId,
      childSessionKey: registration.childSessionKey,
      expectedRegistration: registration.expectedRegistration,
    });
  }

  it("restores same-id and older kill state after task registration throws", () => {
    const childSessionKey = "agent:main:subagent:task-registration-fails";
    const runId = "run-task-registration-fails";
    const priorSameIdRun = createPriorSameIdRun(runId, childSessionKey);
    const olderRun = createOlderKilledRun(childSessionKey);
    addSubagentRunForTests(priorSameIdRun);
    addSubagentRunForTests(olderRun);
    saveSubagentRegistryToSqlite(
      canonicalSubagentRunFixtures(
        new Map([
          [priorSameIdRun.runId, priorSameIdRun],
          [olderRun.runId, olderRun],
        ]),
      ),
    );
    const expectedKillReconciliation = structuredClone(olderRun.killReconciliation);
    const persistenceScopes: string[][] = [];
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDiskOrThrow: (runs, changedRunIds) => {
        persistenceScopes.push([...(changedRunIds ?? [])]);
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      },
    });
    const taskError = new Error("task runtime unavailable");
    const createTaskSpy = vi
      .spyOn(detachedTaskRuntime, "createRunningTaskRun")
      .mockImplementationOnce(() => {
        throw taskError;
      });

    try {
      expect(() =>
        registerSubagentRun({
          runId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "task registration failure",
          cleanup: "keep",
          taskRowOwnership: "required",
        }),
      ).toThrow(expect.objectContaining({ cause: taskError }));
      expect(
        listSubagentRunsForRequester("agent:main:main").find((entry) => entry.runId === runId),
      ).toMatchObject({
        task: priorSameIdRun.task,
        generation: priorSameIdRun.generation,
      });
      expect(
        listSubagentRunsForRequester("agent:main:main").find(
          (entry) => entry.runId === olderRun.runId,
        )?.killReconciliation,
      ).toEqual(expectedKillReconciliation);
      const persisted = loadSubagentRegistryFromSqlite();
      expect(persisted.get(runId)).toMatchObject({
        task: priorSameIdRun.task,
        generation: priorSameIdRun.generation,
      });
      expect(persisted.get(olderRun.runId)?.killReconciliation).toEqual(expectedKillReconciliation);
      expect(persistenceScopes).toEqual([
        [runId, olderRun.runId],
        [runId, olderRun.runId],
      ]);
    } finally {
      createTaskSpy.mockRestore();
    }
  });

  it("restores a same-id run when initial registration persistence fails", () => {
    const runId = "run-initial-persist-same-id";
    const childSessionKey = "agent:main:subagent:initial-persist-same-id";
    const priorSameIdRun = createPriorSameIdRun(runId, childSessionKey);
    addSubagentRunForTests(priorSameIdRun);
    saveSubagentRegistryToSqlite(
      canonicalSubagentRunFixtures(new Map([[priorSameIdRun.runId, priorSameIdRun]])),
    );
    const persistError = new Error("initial sqlite busy");
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDisk: saveSubagentRegistryToSqlite,
      persistSubagentRunsToDiskOrThrow: () => {
        throw persistError;
      },
    });

    expect(() =>
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "replacement that must roll back",
        cleanup: "keep",
      }),
    ).toThrow(expect.objectContaining({ cause: persistError }));
    expect(
      listSubagentRunsForRequester("agent:main:main").find((entry) => entry.runId === runId),
    ).toMatchObject({
      task: priorSameIdRun.task,
      generation: priorSameIdRun.generation,
    });
    expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
      task: priorSameIdRun.task,
      generation: priorSameIdRun.generation,
    });
  });

  it("surfaces task registration and rollback persistence failures together", () => {
    const taskError = new Error("task runtime unavailable");
    const rollbackError = new Error("rollback sqlite busy");
    let persistAttempt = 0;
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDiskOrThrow: (runs, changedRunIds) => {
        persistAttempt += 1;
        if (persistAttempt === 2) {
          throw rollbackError;
        }
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      },
    });
    const createTaskSpy = vi
      .spyOn(detachedTaskRuntime, "createRunningTaskRun")
      .mockImplementationOnce(() => {
        throw taskError;
      });

    try {
      let thrown: unknown;
      try {
        registerSubagentRun({
          runId: "run-rollback-persist-fails",
          childSessionKey: "agent:main:subagent:rollback-persist-fails",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "rollback persistence failure",
          cleanup: "keep",
          taskRowOwnership: "required",
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([taskError, rollbackError]);
      expect((thrown as AggregateError).cause).toBe(taskError);
      expect(
        getSubagentRunByChildSessionKey("agent:main:subagent:rollback-persist-fails"),
      ).toMatchObject({
        runId: "run-rollback-persist-fails",
        task: "rollback persistence failure",
      });
    } finally {
      createTaskSpy.mockRestore();
    }
  });

  it("retains exact rollback authority when registration survives and termination is incomplete", async () => {
    const taskError = new Error("task runtime unavailable");
    const rollbackPersistError = new Error("rollback sqlite busy");
    const terminationError = new Error("gateway termination unavailable");
    let persistAttempt = 0;
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDiskOrThrow: (runs, changedRunIds) => {
        persistAttempt += 1;
        if (persistAttempt === 2) {
          throw rollbackPersistError;
        }
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      },
    });
    const createTaskSpy = vi
      .spyOn(detachedTaskRuntime, "createRunningTaskRun")
      .mockImplementationOnce(() => {
        throw taskError;
      });
    const cleanupOnFailure = vi.fn(async () => {
      throw terminationError;
    });
    const childSessionKey = "agent:main:subagent:pipeline-registration";
    const registration = createRegistration("run-pipeline-registration", childSessionKey);

    try {
      let thrown: unknown;
      try {
        await runSpawnPipeline({
          adapter: createPipelineAdapter(cleanupOnFailure),
          progressSessionKey: "agent:main:main",
          buildRegistration: () => registration,
          recordAcceptedRollback,
          rollbackRegistration,
        });
      } catch (error) {
        thrown = error;
      }

      expect(cleanupOnFailure).toHaveBeenCalledOnce();
      expect(thrown).toBeInstanceOf(AggregateError);
      const registrationError = (thrown as AggregateError).errors[0] as AggregateError & {
        registrationOwnership: { status: string };
      };
      expect(registrationError.errors).toEqual([taskError, rollbackPersistError]);
      expect(registrationError.cause).toBe(taskError);
      expect(registrationError.registrationOwnership.status).toBe("new-row-survived");
      const retained = getSubagentRunByChildSessionKey(childSessionKey);
      expect(retained).toMatchObject({
        runId: registration.runId,
        acceptedSpawnRollback: {
          gatewayRunId: registration.runId,
          reason: expect.stringContaining("rollback persistence both failed"),
        },
        suppressCompletionDelivery: true,
        execution: { suppressSessionEffects: true },
      });
      expect(retained?.execution.restartRecovery).toBeUndefined();
      expect(loadSubagentRegistryFromSqlite().get(registration.runId)).toMatchObject({
        acceptedSpawnRollback: { gatewayRunId: registration.runId },
        suppressCompletionDelivery: true,
        execution: { suppressSessionEffects: true },
      });
      await testing.sweepOnceForTests();
      expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
        runId: registration.runId,
        acceptedSpawnRollback: { gatewayRunId: registration.runId },
        suppressCompletionDelivery: true,
        execution: { suppressSessionEffects: true },
      });
    } finally {
      createTaskSpy.mockRestore();
    }
  });

  it("preserves a restored same-id predecessor after failed replacement registration", async () => {
    const runId = "run-pipeline-registration";
    const childSessionKey = "agent:main:subagent:pipeline-predecessor";
    const predecessor = createPriorSameIdRun(runId, childSessionKey);
    addSubagentRunForTests(predecessor);
    saveSubagentRegistryToSqlite(canonicalSubagentRunFixtures(new Map([[runId, predecessor]])));
    const taskError = new Error("task runtime unavailable");
    const createTaskSpy = vi
      .spyOn(detachedTaskRuntime, "createRunningTaskRun")
      .mockImplementationOnce(() => {
        throw taskError;
      });
    const cleanupOnFailure = vi.fn(async () => {});

    try {
      const result = await runSpawnPipeline({
        adapter: createPipelineAdapter(cleanupOnFailure),
        progressSessionKey: "agent:main:main",
        buildRegistration: () => createRegistration(runId, childSessionKey),
        recordAcceptedRollback,
        rollbackRegistration,
      });

      expect(result).toMatchObject({ ok: false, phase: "register" });
      if (result.ok) {
        throw new Error("expected replacement registration failure");
      }
      expect(
        (
          result.error as Error & {
            registrationOwnership: { status: string; predecessor: { createdAt: number } };
          }
        ).registrationOwnership,
      ).toEqual(
        expect.objectContaining({
          status: "predecessor-restored",
          predecessor: expect.objectContaining({ createdAt: predecessor.createdAt }),
        }),
      );
      expect(cleanupOnFailure).toHaveBeenCalledOnce();
      const restored = getSubagentRunByChildSessionKey(childSessionKey);
      expect(restored).toMatchObject({
        runId,
        task: predecessor.task,
        generation: predecessor.generation,
      });
      expect(restored?.acceptedSpawnRollback).toBeUndefined();
      expect(restored?.execution).toEqual(predecessor.execution);
    } finally {
      createTaskSpy.mockRestore();
    }
  });

  it("attempts external cleanup without a rollback marker when no durable row survives", async () => {
    const persistError = new Error("initial sqlite busy");
    testing.setDepsForTest({
      ...createSubagentRegistryTestDeps(),
      persistSubagentRunsToDiskOrThrow: () => {
        throw persistError;
      },
    });
    const cleanupOnFailure = vi.fn(async () => {});
    const childSessionKey = "agent:main:subagent:pipeline-no-row";

    const result = await runSpawnPipeline({
      adapter: createPipelineAdapter(cleanupOnFailure),
      progressSessionKey: "agent:main:main",
      buildRegistration: () => createRegistration("run-pipeline-registration", childSessionKey),
      recordAcceptedRollback,
      rollbackRegistration,
    });

    expect(result).toMatchObject({ ok: false, phase: "register" });
    if (result.ok) {
      throw new Error("expected registration persistence failure");
    }
    expect(
      (result.error as Error & { registrationOwnership: { status: string } }).registrationOwnership
        .status,
    ).toBe("no-new-row");
    expect(cleanupOnFailure).toHaveBeenCalledOnce();
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toBeNull();
    expect(loadSubagentRegistryFromSqlite().has("run-pipeline-registration")).toBe(false);
  });

  it("fails closed when registration ownership is unknown at the pipeline boundary", async () => {
    const runId = "run-pipeline-registration";
    const terminationAttempts: string[] = [];
    const recordRollback = vi.fn(recordAcceptedRollback);
    const cleanupOnFailure = vi.fn(async ({ error }: { error: unknown }) => {
      terminationAttempts.push(runId);
      expect(error).toMatchObject({
        registrationOwnership: {
          status: "unknown",
          attempted: { runId, childSessionKey: "" },
        },
      });
    });

    const result = await runSpawnPipeline({
      adapter: createPipelineAdapter(cleanupOnFailure),
      progressSessionKey: "agent:main:main",
      buildRegistration: () => createRegistration(runId, ""),
      recordAcceptedRollback: recordRollback,
      rollbackRegistration,
    });

    expect(result).toMatchObject({
      ok: false,
      phase: "register",
      error: {
        registrationOwnership: {
          status: "unknown",
          attempted: { runId, childSessionKey: "" },
        },
      },
    });
    expect(recordRollback).not.toHaveBeenCalled();
    expect(terminationAttempts).toEqual([runId]);
    expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
    resetSubagentRegistryForTests({ persist: false });
    await testing.sweepOnceForTests();
    expect(getSubagentRunByChildSessionKey("agent:main:subagent:any")).toBeNull();
  });

  it("keeps normal registration and rollback exactly once", async () => {
    const cleanupOnFailure = vi.fn(async () => {});
    const childSessionKey = "agent:main:subagent:pipeline-success";
    const result = await runSpawnPipeline({
      adapter: createPipelineAdapter(cleanupOnFailure),
      progressSessionKey: "agent:main:main",
      buildRegistration: () => createRegistration("run-pipeline-registration", childSessionKey),
      recordAcceptedRollback,
      rollbackRegistration,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const registered = getSubagentRunByChildSessionKey(childSessionKey);
    expect(registered?.runId).toBe(result.runId);
    if (!registered || registered.generation === undefined) {
      throw new Error("expected exact registered row identity");
    }
    expect(
      rollbackSubagentRunRegistration({
        runId: registered.runId,
        childSessionKey,
        expectedRegistration: {
          runId: "different-run",
          childSessionKey,
          generation: registered.generation,
          createdAt: registered.createdAt,
        },
      }),
    ).toBe(false);
    await result.rollbackAccepted();
    expect(getSubagentRunByChildSessionKey(childSessionKey)).toBeNull();
    expect(cleanupOnFailure).toHaveBeenCalledOnce();
  });
});
