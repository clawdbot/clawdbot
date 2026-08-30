import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
/** Owns subagent registration and queued collector launch transitions. */
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  createQueuedTaskRun,
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  startTaskRunByRunId,
} from "../../../tasks/detached-task-runtime.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { SubagentRecoveryManager } from "./subagent-registry-run-recovery.js";
import type {
  SubagentProgressOrigin,
  SubagentRunRecord,
  SwarmQueuedLaunch,
} from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  nextSubagentRunGeneration,
} from "./subagent-run-generation.js";

const log = createSubsystemLogger("agents/subagent-registry");

function resolveSwarmWaitOwnerSessionKeys(
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>,
  requesterSessionKey: string,
): string[] {
  const ownerSessionKeys: string[] = [];
  const visited = new Set<string>();
  let currentSessionKey = requesterSessionKey.trim();
  while (currentSessionKey && !visited.has(currentSessionKey)) {
    visited.add(currentSessionKey);
    ownerSessionKeys.push(currentSessionKey);
    let latestOwner: SubagentRunRecord | undefined;
    for (const candidate of getRunsForChildSession(currentSessionKey)) {
      if (!latestOwner || compareSubagentRunGeneration(candidate, latestOwner) > 0) {
        latestOwner = candidate;
      }
    }
    currentSessionKey =
      latestOwner?.controllerSessionKey?.trim() || latestOwner?.requesterSessionKey.trim() || "";
  }
  return ownerSessionKeys;
}

export type RegisterSubagentRunParams = {
  runId: string;
  requesterTurnRunId?: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  progressOrigin?: SubagentProgressOrigin;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  agentId?: string;
  requesterAgentId?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  spawnMode?: "run" | "session";
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  collect?: boolean;
  swarmRequesterSessionKey?: string;
  swarmLaunchIdempotencyKey?: string;
  swarmLaunchReplayKey?: string;
  swarmLaunchRequestFingerprint?: string;
  groupId?: string;
  outputSchema?: Record<string, unknown>;
  queuedLaunch?: SwarmQueuedLaunch;
  queued?: boolean;
  /** Required when direct dispatch suppresses Gateway tracking. Out-of-process launches keep
      Gateway's existing best-effort CLI policy; other callers create a best-effort row here. */
  taskRowOwnership?: "required" | "gateway_best_effort";
  gatewayContextResolver?: GatewayContextResolver;
};

export class SubagentLaunchManager extends SubagentRecoveryManager {
  private findRunByIdentity(runId: string): SubagentRunRecord | undefined {
    return (
      this.options.runs.get(runId) ??
      [...this.options.runs.values()].find((candidate) => candidate.swarmRunId === runId)
    );
  }

  readonly registerSubagentRun = (registerParams: RegisterSubagentRunParams): void => {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    const requesterTurnRunId = registerParams.requesterTurnRunId?.trim();
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return;
    }
    const now = Date.now();
    const generation = nextSubagentRunGeneration(
      this.options.getRunsForChildSession(childSessionKey),
      childSessionKey,
    );
    const cfg = this.options.getRuntimeConfig();
    const spawnMode = registerParams.spawnMode === "session" ? "session" : "run";
    const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = this.options.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
    const queued = registerParams.queued === true;
    const entry: SubagentRunRecord = normalizeSubagentRunState({
      runId,
      taskRunId: runId,
      ...(requesterTurnRunId ? { requesterTurnRunId } : {}),
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey,
      requesterOrigin,
      progressOrigin: registerParams.progressOrigin,
      requesterDisplayKey: registerParams.requesterDisplayKey,
      requesterAgentId: resolveSubagentRequesterAgentId(cfg, registerParams),
      task: registerParams.task,
      taskName: registerParams.taskName,
      cleanup: registerParams.cleanup,
      expectsCompletionMessage: registerParams.expectsCompletionMessage,
      spawnMode,
      label: registerParams.label,
      model: registerParams.model,
      agentDir: registerParams.agentDir,
      workspaceDir: registerParams.workspaceDir,
      runTimeoutSeconds,
      collect: registerParams.collect,
      swarmRequesterSessionKey: registerParams.swarmRequesterSessionKey,
      swarmWaitOwnerSessionKeys:
        registerParams.collect && registerParams.swarmRequesterSessionKey
          ? resolveSwarmWaitOwnerSessionKeys(
              this.options.getRunsForChildSession,
              registerParams.swarmRequesterSessionKey,
            )
          : undefined,
      swarmRunId: registerParams.collect ? runId : undefined,
      schedulerSlotId: registerParams.collect ? runId : undefined,
      swarmLaunchIdempotencyKey: registerParams.swarmLaunchIdempotencyKey,
      swarmLaunchReplayKey: registerParams.swarmLaunchReplayKey,
      swarmLaunchRequestFingerprint: registerParams.swarmLaunchRequestFingerprint,
      swarmLaunchPending: registerParams.collect === true,
      groupId: registerParams.groupId,
      outputSchema: registerParams.outputSchema,
      queuedLaunch: registerParams.queuedLaunch,
      generation,
      createdAt: now,
      execution: {
        status: queued ? "queued" : "running",
        startedAt: queued ? undefined : now,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      completion: {
        required: registerParams.expectsCompletionMessage === true,
      },
      delivery: {
        status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending",
      },
      sessionStartedAt: queued ? undefined : now,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
      wakeOnDescendantSettle: undefined,
      requesterSettleWake: undefined,
      attachmentsDir: registerParams.attachmentsDir,
      attachmentsRootDir: registerParams.attachmentsRootDir,
      retainAttachmentsOnKeep: registerParams.retainAttachmentsOnKeep,
    });
    this.options.runs.set(runId, entry);
    bindGatewayContextResolver(entry, registerParams.gatewayContextResolver);
    const killReconciliationSnapshots = this.markOlderKillReconciliationsSuperseded(entry);
    const registeredKillReconciliationSnapshots = new Map(
      [...killReconciliationSnapshots.keys()].map((candidate) => [
        candidate,
        structuredClone(candidate.killReconciliation),
      ]),
    );
    const registeredRunIds = [
      runId,
      ...[...killReconciliationSnapshots.keys()].map((candidate) => candidate.runId),
    ];
    const rollbackRegistration = () => {
      this.options.runs.delete(runId);
      this.restoreKillReconciliationSnapshots(killReconciliationSnapshots);
    };
    const restoreDurableRegistration = () => {
      this.options.runs.set(runId, entry);
      this.restoreKillReconciliationSnapshots(registeredKillReconciliationSnapshots);
    };
    const activateRegistrationLifecycle = () => {
      subagentRuns.commitOwnership(entry);
      this.options.ensureListener();
      // Session-mode and persistence-recovery runs also need TTL cleanup.
      this.options.startSweeper();
      if (!queued) {
        void this.waitForSubagentCompletion(runId, waitTimeoutMs, entry);
      }
    };
    try {
      this.options.persistOrThrow(...registeredRunIds);
    } catch (error) {
      rollbackRegistration();
      throw error;
    }
    if (registerParams.taskRowOwnership !== "gateway_best_effort") {
      try {
        const taskParams = {
          runtime: "subagent",
          sourceId: runId,
          ownerKey: requesterSessionKey,
          scopeKind: "session",
          // Detached task runtimes are plugin-replaceable. Isolate their input so
          // mutation cannot change the already-persisted registry record.
          requesterOrigin: requesterOrigin ? structuredClone(requesterOrigin) : undefined,
          childSessionKey,
          runId,
          label: registerParams.label,
          task: registerParams.task,
          agentId: registerParams.agentId,
          requesterAgentId: resolveSubagentRequesterAgentId(cfg, registerParams),
          deliveryStatus:
            registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
          detail: createSubagentTaskBackingDetail(generation),
        } as const;
        const task = queued
          ? createQueuedTaskRun(taskParams)
          : createRunningTaskRun({
              ...taskParams,
              startedAt: now,
              lastEventAt: now,
            });
        if (!task) {
          if (registerParams.taskRowOwnership === "required") {
            throw new Error(`detached task runtime created no task row for run ${runId}`);
          }
          log.warn("Failed to persist background task for subagent run", { runId });
        }
      } catch (error) {
        if (registerParams.taskRowOwnership !== "required") {
          log.warn("Failed to create background task for subagent run", { runId, error });
        } else {
          // Direct dispatch suppressed Gateway's CLI fallback. Persist the rollback before
          // asking the caller to abort; if that write fails, memory must match durable state.
          rollbackRegistration();
          try {
            this.options.persistOrThrow(...registeredRunIds);
          } catch (rollbackError) {
            restoreDurableRegistration();
            // Durable state still owns this registration. Keep reconciliation active so
            // caller cleanup can terminalize it instead of leaving a phantom run.
            activateRegistrationLifecycle();
            throw rollbackError;
          }
          throw error;
        }
      }
    }
    // Wait through Gateway RPC; the in-process lifecycle listener is the embedded fallback.
    activateRegistrationLifecycle();
  };

  readonly startQueuedSubagentRun = (
    runId: string,
    gatewayRunId?: string,
    lifecycleGeneration?: string,
    gatewayContextResolver?: GatewayContextResolver,
  ): boolean => {
    const key = runId.trim();
    const entry = this.findRunByIdentity(key);
    const acceptedLifecycleGeneration = lifecycleGeneration ?? getAgentEventLifecycleGeneration();
    if (
      lifecycleGeneration !== undefined &&
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
    ) {
      return false;
    }
    const lifecycleStarted =
      entry?.execution.status === "running" &&
      typeof entry.execution.startedAt === "number" &&
      entry.swarmLaunchPending === true;
    const provisionalTerminalBeforeAcceptance =
      entry?.swarmLaunchPending === true &&
      typeof entry.execution.endedAt === "number" &&
      entry.collectorCompletion === undefined;
    if (provisionalTerminalBeforeAcceptance) {
      // Cancellation won before Gateway acceptance. The caller must abort the
      // newly accepted run before freezing completion or releasing the FIFO slot.
      return false;
    }
    // Completion clears swarmLaunchPending, but queuedLaunch remains until the
    // delayed acceptance response remaps the durable terminal row.
    const terminalBeforeAcceptance =
      entry?.collectorCompletion !== undefined && entry.queuedLaunch !== undefined;
    if (
      !entry ||
      entry.killIntent ||
      entry.killReconciliation ||
      (!terminalBeforeAcceptance && entry.execution.status !== "queued" && !lifecycleStarted)
    ) {
      return false;
    }
    const nextRunId = gatewayRunId?.trim() || entry.runId;
    const conflicting = this.options.runs.get(nextRunId);
    if (conflicting && conflicting !== entry) {
      throw new Error(`collector gateway run id already exists: ${nextRunId}`);
    }
    const acceptedAt = Date.now();
    const previousRunId = entry.runId;
    const previous = structuredClone(entry);
    const restoreQueuedRun = () => {
      if (previousRunId !== nextRunId) {
        this.options.runs.delete(nextRunId);
      }
      this.restoreRunRecord(entry, previous);
      if (previousRunId !== nextRunId) {
        this.options.runs.set(previousRunId, entry);
      }
    };
    entry.swarmRunId ??= previousRunId;
    entry.schedulerSlotId ??= entry.swarmRunId;
    if (previousRunId !== nextRunId) {
      this.options.runs.delete(previousRunId);
      entry.runId = nextRunId;
      this.options.runs.set(nextRunId, entry);
    }
    if (!terminalBeforeAcceptance) {
      // Acceptance is not a lifecycle start; preserve a raced start or leave its clock unset.
      const lifecycleStartedAt =
        entry.execution.status === "running" ? entry.execution.startedAt : undefined;
      if (typeof lifecycleStartedAt === "number") {
        entry.sessionStartedAt ??= lifecycleStartedAt;
        entry.execution = {
          ...entry.execution,
          status: "running",
          acceptedAt,
          lifecycleGeneration: acceptedLifecycleGeneration,
          restartRecovery: undefined,
          suppressSessionEffects: undefined,
          startedAt: lifecycleStartedAt,
        };
      } else {
        delete entry.sessionStartedAt;
        entry.execution = {
          ...entry.execution,
          status: "running",
          acceptedAt,
          lifecycleGeneration: acceptedLifecycleGeneration,
          restartRecovery: undefined,
          suppressSessionEffects: undefined,
        };
        delete entry.execution.startedAt;
      }
    }
    entry.swarmLaunchPending = false;
    entry.queuedLaunch = undefined;
    let persistedRunning = false;
    try {
      this.options.persistOrThrow(previousRunId, nextRunId);
      if (terminalBeforeAcceptance) {
        bindGatewayContextResolver(entry, gatewayContextResolver);
        return true;
      }
      persistedRunning = true;
      startTaskRunByRunId({
        runId: entry.taskRunId ?? entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        startedAt: acceptedAt,
        lastEventAt: acceptedAt,
      });
    } catch (error) {
      restoreQueuedRun();
      if (persistedRunning) {
        try {
          this.options.persistOrThrow(previousRunId, nextRunId);
        } catch (rollbackError) {
          // The failure callback terminalizes this in-memory queued row next.
          log.warn("failed to persist collector start rollback", {
            runId: previousRunId,
            error: rollbackError,
          });
        }
      }
      throw error;
    }
    bindGatewayContextResolver(entry, gatewayContextResolver);
    const cfg = this.options.getRuntimeConfig();
    void this.waitForSubagentCompletion(
      nextRunId,
      this.options.resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds),
      entry,
    );
    return true;
  };

  readonly failQueuedSubagentRun = (runId: string, error: string): boolean => {
    const key = runId.trim();
    const entry = this.findRunByIdentity(key);
    if (!entry || entry.execution.status !== "queued") {
      return false;
    }
    const snapshot = structuredClone(entry);
    const endedAt = Date.now();
    entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt,
      outcome: { status: "error", error, endedAt },
    };
    entry.queuedLaunch = undefined;
    entry.collectorLaunchCleanupPending = true;
    entry.completion = { required: false, resultText: error, capturedAt: endedAt };
    updateSwarmCollectorCompletion(entry, this.options.getRuntimeConfig());
    try {
      this.options.persistOrThrow(entry.runId);
    } catch (persistError) {
      this.restoreRunRecord(entry, snapshot);
      throw persistError;
    }
    try {
      finalizeTaskRunByRunId({
        runId: entry.taskRunId ?? entry.runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
        status: "failed",
        endedAt,
        lastEventAt: endedAt,
        error,
        suppressDelivery: true,
      });
    } catch (taskError) {
      // Collector failure is already durable. Detached-task cleanup cannot
      // turn it back into queued work or the scheduler could launch it twice.
      log.warn("failed to finalize task after collector launch failure", {
        runId: entry.runId,
        error: taskError,
      });
    }
    return true;
  };

  readonly settleFailedQueuedSubagentLaunch = (runId: string, error: string): boolean => {
    const entry = this.findRunByIdentity(runId);
    if (!entry?.collect) {
      return false;
    }
    if (typeof entry.execution.endedAt !== "number") {
      return this.failQueuedSubagentRun(runId, error);
    }
    if (entry.collectorCompletion) {
      return true;
    }
    const snapshot = structuredClone(entry);
    entry.swarmLaunchPending = false;
    entry.collectorLaunchCleanupPending = true;
    entry.queuedLaunch = undefined;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt: entry.execution.endedAt,
    };
    entry.completion = {
      required: false,
      resultText:
        entry.execution.outcome?.status === "error"
          ? (entry.execution.outcome.error ?? error)
          : error,
      capturedAt: entry.execution.endedAt,
    };
    updateSwarmCollectorCompletion(entry, this.options.getRuntimeConfig());
    try {
      this.options.persistOrThrow(entry.runId);
    } catch (persistError) {
      this.restoreRunRecord(entry, snapshot);
      throw persistError;
    }
    return true;
  };
}
