import { expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { reloadTaskRuntimeStateFromStore } from "../../../tasks/runtime-internal.js";
import { getTaskFlowById } from "../../../tasks/task-flow-registry.js";
import { findTaskByRunId, getTaskById } from "../../../tasks/task-registry.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRegistryDeps } from "./subagent-registry-deps.js";
import { getSubagentRunsForChildSession, subagentRuns } from "./subagent-registry-memory.js";
import { getLatestSubagentRunByChildSessionKeyFromRuns } from "./subagent-registry-queries.js";
import { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { registerSubagentRun } from "./subagent-registry.js";
import {
  removeSubagentSessionEntry,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "./subagent-registry.store.sqlite.js";

const fixture = useSubagentControlFixture();

async function setupAcceptedRecovery(persistedPhase: "attempted" | "consumed" = "consumed") {
  const sessionKey = "agent:main:subagent:acceptance-write";
  const sessionId = "acceptance-write-session";
  const lifecycleRevision = "acceptance-session-revision";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: sessionId,
    lifecycleRevision,
    abortedLastRun: true,
  });
  registerSubagentRun({
    runId: "acceptance-predecessor",
    childSessionKey: sessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "Recover accepted work",
    cleanup: "keep",
    spawnMode: "session",
    expectsCompletionMessage: true,
  });
  const source = subagentRuns.get("acceptance-predecessor")!;
  const task = findTaskByRunId(source.runId)!;
  const noop = () => {};
  const resumed = vi.fn();
  const createManager = () =>
    createSubagentRunManager({
      runs: subagentRuns,
      getRunsForChildSession: getSubagentRunsForChildSession,
      resumedRuns: new Set(),
      persist: (...runIds) => persistSubagentRunsToDiskOrThrow(subagentRuns, runIds),
      persistOrThrow: (...runIds) => persistSubagentRunsToDiskOrThrow(subagentRuns, runIds),
      callGateway: subagentRegistryDeps.callGateway,
      getRuntimeConfig,
      ensureListener: noop,
      startSweeper: noop,
      stopSweeper: noop,
      resumeSubagentRun: resumed,
      clearPendingLifecycleError: noop,
      clearPendingLifecycleTimeout: noop,
      resolveSubagentWaitTimeoutMs: () => 1_000,
      scheduleSweep: noop,
      resolveSubagentSessionCompletion: () => null,
      resolveSubagentSessionStartedAt: () => undefined,
      notifyContextEngineSubagentEnded: async () => {},
      completeCleanupBookkeeping: noop,
      completeSubagentRun: async () => {},
      resolveSubagentTask: () => ({ lookup: "available", task: getTaskById(task.taskId) }),
    });
  const manager = createManager();
  const launch = {
    runId: source.runId,
    expected: source,
    sessionMarker: `${sessionId}:${loadSessionEntry({ storePath, sessionKey })!.updatedAt}`,
    idempotencyKey: "acceptance-successor",
  };
  expect(
    manager.reserveSubagentRestartRecoveryLaunch({
      ...launch,
      sessionId,
      sessionLifecycleRevision: lifecycleRevision,
    }),
  ).toBe(launch.idempotencyKey);
  expect(
    manager.markSubagentRestartRecoveryLaunchAttempted({
      ...launch,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    })?.phase,
  ).toBe("attempted");

  const database = openOpenClawStateDatabase().db;
  const rejectedPhases = persistedPhase === "attempted" ? "'consumed', 'accepted'" : "'accepted'";
  database.exec(`CREATE TEMP TRIGGER reject_recovery_receipt
    BEFORE UPDATE ON subagent_runs
    WHEN NEW.run_id = 'acceptance-predecessor'
      AND json_extract(NEW.payload_json, '$.execution.restartRecovery.phase') IN (${rejectedPhases})
    BEGIN SELECT RAISE(ABORT, 'recovery receipt write rejected'); END`);
  let receipt: ReturnType<typeof manager.markSubagentRestartRecoveryLaunchAccepted>;
  try {
    if (persistedPhase === "attempted") {
      expect(() => manager.markSubagentRestartRecoveryLaunchConsumed(launch)).toThrow(
        "recovery receipt write rejected",
      );
    } else {
      expect(manager.markSubagentRestartRecoveryLaunchConsumed(launch)?.phase).toBe("consumed");
    }
    receipt = manager.markSubagentRestartRecoveryLaunchAccepted(launch);
    expect(receipt?.phase).toBe("accepted");
    expect(source.execution.restartRecovery).toBe(receipt);
    expect(
      loadSubagentRegistryFromSqlite().get(source.runId)?.execution.restartRecovery?.phase,
    ).toBe(persistedPhase);
  } finally {
    database.exec("DROP TRIGGER reject_recovery_receipt");
  }
  if (!receipt) {
    throw new Error("Expected the live acceptance receipt after its failed write");
  }

  const dispatchAgent = vi.fn(async (): Promise<never> => {
    throw new Error("Already accepted recovery must not dispatch another turn");
  });
  const gatewayRuntime: GatewayRecoveryRuntime = {
    dispatchAgent,
    waitForAgent: async () => {
      throw new Error("Recovery settlement must not wait through Gateway");
    },
    abortAgent: async () => {
      throw new Error("Recovery settlement must not abort its accepted turn");
    },
    sendRecoveryNotice: async () => ({ suppressed: false }),
  };
  const replace = (
    overrides: Partial<Parameters<typeof manager.replaceSubagentRunAfterSteer>[0]> = {},
    owner = manager,
  ) =>
    owner.replaceSubagentRunAfterSteer({
      previousRunId: source.runId,
      nextRunId: launch.idempotencyKey,
      expected: source,
      restartRecovery: receipt,
      persistenceFailure: "return-false",
      ...overrides,
    });
  const recover = () =>
    recoverInterruptedSubagentRow({
      runId: source.runId,
      entry: source,
      now: Date.now(),
      gatewayRuntime,
      isCurrent: (runId, entry) =>
        subagentRuns.get(runId) === entry &&
        getLatestSubagentRunByChildSessionKeyFromRuns(
          getSubagentRunsForChildSession(entry.childSessionKey),
          entry.childSessionKey,
        ) === entry,
      getRun: (runId) => subagentRuns.get(runId),
      abandonLaunch: manager.abandonSubagentRestartRecoveryLaunch,
      clearAcceptedRecovery: manager.clearAcceptedSubagentRestartRecovery,
      clearPendingNotice: manager.clearPendingSubagentRecoveryNotice,
      resumeAcceptedRecovery: manager.resumeSettledSubagentRestartRecovery,
      replaceRun: manager.replaceSubagentRunAfterSteer,
      markLaunchAttempted: manager.markSubagentRestartRecoveryLaunchAttempted,
      markLaunchAccepted: manager.markSubagentRestartRecoveryLaunchAccepted,
      markLaunchConsumed: manager.markSubagentRestartRecoveryLaunchConsumed,
      reserveLaunch: manager.reserveSubagentRestartRecoveryLaunch,
      resetLaunchAttempt: manager.resetSubagentRestartRecoveryLaunchAttempt,
      warn: vi.fn(),
    });
  const expectRejected = (attempt = () => replace()) => {
    const before = loadSubagentRegistryFromSqlite();
    const taskBefore = getTaskById(task.taskId);
    const flowBefore = getTaskFlowById(task.parentFlowId!);
    expect(attempt()).toBe(false);
    expect(loadSubagentRegistryFromSqlite()).toEqual(before);
    expect(subagentRuns.has(launch.idempotencyKey)).toBe(false);
    expect(getTaskById(task.taskId)).toEqual(taskBefore);
    expect(getTaskFlowById(task.parentFlowId!)).toEqual(flowBefore);
  };
  return {
    source,
    task,
    receipt,
    manager,
    createManager,
    session: { sessionKey, sessionId, storePath, lifecycleRevision },
    database,
    replace,
    recover,
    expectRejected,
    dispatchAgent,
    resumed,
  };
}

it.each(["attempted", "consumed"] as const)(
  "adopts witnessed acceptance when failed receipt writes left durable %s",
  async (persistedPhase) => {
    const state = await setupAcceptedRecovery(persistedPhase);
    expect(state.replace()).toBe(true);
    const stored = loadSubagentRegistryFromSqlite();
    expect(stored.has(state.source.runId)).toBe(false);
    expect(stored.get(state.receipt.idempotencyKey)?.execution.restartRecovery).toEqual(
      state.receipt,
    );
    reloadTaskRuntimeStateFromStore();
    expect(getTaskById(state.task.taskId)).toMatchObject({
      runId: state.source.runId,
      status: "running",
      detail: { generation: state.source.generation! + 1 },
    });
    expect(getTaskFlowById(state.task.parentFlowId!)?.status).toBe("running");
  },
);

it.each(["source payload", "receipt identity", "reserved phase", "abandoned phase"] as const)(
  "does not reconcile a durable %s conflict",
  async (conflict) => {
    const state = await setupAcceptedRecovery();
    const stored = loadSubagentRegistryFromSqlite();
    const source = stored.get(state.source.runId)!;
    if (conflict === "source payload") {
      source.task = "Changed by another owner";
    } else if (conflict === "receipt identity") {
      source.execution.restartRecovery!.sessionMarker = "different-session-marker";
    } else {
      source.execution.restartRecovery!.phase =
        conflict === "reserved phase" ? "reserved" : "abandoned";
    }
    saveSubagentRegistryChangesToSqlite(stored, [source.runId]);
    state.expectRejected();
  },
);

it.each(["source", "receipt", "manager"] as const)(
  "does not transfer failed-write authority to a copied %s",
  async (copied) => {
    const state = await setupAcceptedRecovery();
    if (copied === "manager") {
      state.expectRejected(() => state.replace({}, state.createManager()));
    } else if (copied === "source") {
      const source = structuredClone(state.source);
      source.execution.restartRecovery = state.receipt;
      subagentRuns.set(source.runId, source);
      state.expectRejected(() => state.replace({ expected: source }));
      expect(subagentRuns.get(source.runId)).toBe(source);
    } else {
      const receipt = structuredClone(state.receipt);
      state.source.execution.restartRecovery = receipt;
      state.expectRejected(() => state.replace({ restartRecovery: receipt }));
    }
  },
);

it("accepts an exact persisted accepted row without failed-write authority", async () => {
  const state = await setupAcceptedRecovery();
  saveSubagentRegistryChangesToSqlite(subagentRuns, [state.source.runId]);
  expect(state.replace({}, state.createManager())).toBe(true);
});

it("does not change the witnessed identity through a retained receipt", async () => {
  const state = await setupAcceptedRecovery();
  Reflect.set(state.receipt, "sessionMarker", "unwitnessed-marker");
  const stored = loadSubagentRegistryFromSqlite();
  stored.get(state.source.runId)!.execution.restartRecovery!.sessionMarker = "unwitnessed-marker";
  saveSubagentRegistryChangesToSqlite(stored, [state.source.runId]);
  state.expectRejected();
});

it.each([
  "retired lifecycle",
  "cancelled",
  "terminal",
  "reset session",
  "deleted session",
  "newer sibling",
] as const)("rejects witnessed recovery after its owner is invalidated by %s", async (reason) => {
  const state = await setupAcceptedRecovery();
  if (reason === "retired lifecycle") {
    rotateAgentEventLifecycleGeneration();
  } else if (reason === "cancelled") {
    expect(
      state.manager.claimSubagentRunKill({
        runId: state.source.runId,
        expected: state.source,
        sessionId: state.session.sessionId,
        sessionLifecycleRevision: state.session.lifecycleRevision,
      }),
    ).toBeDefined();
  } else if (reason === "terminal") {
    state.source.execution = {
      ...state.source.execution,
      status: "terminal",
      endedAt: Date.now(),
      outcome: { status: "error", error: "Owner already settled" },
    };
  } else if (reason === "reset session") {
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: state.session.sessionKey,
      defaultSessionId: state.session.sessionId,
      lifecycleRevision: "reset-session-revision",
    });
  } else if (reason === "deleted session") {
    await removeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: state.session.sessionKey,
    });
  } else {
    registerSubagentRun({
      runId: "newer-retained-owner",
      childSessionKey: state.session.sessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Newer work owns this session",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    expect(subagentRuns.get(state.source.runId)).toBe(state.source);
  }
  state.expectRejected();
});

it.each(["successor", "task", "flow"] as const)(
  "retries accepted recovery after the atomic %s write fails without redispatching",
  async (rejectedWrite) => {
    const state = await setupAcceptedRecovery();
    const before = loadSubagentRegistryFromSqlite();
    const taskBefore = getTaskById(state.task.taskId);
    const flowBefore = getTaskFlowById(state.task.parentFlowId!);
    state.database.exec(`CREATE TEMP TRIGGER reject_recovery_replacement
      ${rejectedWrite === "successor" ? "BEFORE INSERT ON subagent_runs WHEN NEW.run_id = 'acceptance-successor'" : rejectedWrite === "task" ? "BEFORE UPDATE ON task_runs" : "BEFORE UPDATE ON flow_runs"}
      BEGIN SELECT RAISE(ABORT, 'atomic recovery write rejected'); END`);
    try {
      await expect(state.recover()).resolves.toEqual({ status: "deferred" });
      expect(subagentRuns.get(state.source.runId)).toBe(state.source);
      expect(loadSubagentRegistryFromSqlite()).toEqual(before);
      expect(getTaskById(state.task.taskId)).toEqual(taskBefore);
      expect(getTaskFlowById(state.task.parentFlowId!)).toEqual(flowBefore);
      expect(state.resumed).not.toHaveBeenCalled();
    } finally {
      state.database.exec("DROP TRIGGER reject_recovery_replacement");
    }
    await expect(state.recover()).resolves.toEqual({ status: "accepted" });
    expect(state.dispatchAgent).not.toHaveBeenCalled();
    expect(state.resumed).toHaveBeenCalledExactlyOnceWith(state.receipt.idempotencyKey);
    const stored = loadSubagentRegistryFromSqlite();
    expect(stored.has(state.source.runId)).toBe(false);
    expect(stored.get(state.receipt.idempotencyKey)?.execution.restartRecovery).toBeUndefined();
    expect(loadSessionEntry(state.session)).toMatchObject({
      sessionId: state.session.sessionId,
      lifecycleRevision: state.session.lifecycleRevision,
      abortedLastRun: false,
    });
  },
);
