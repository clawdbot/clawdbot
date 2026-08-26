/** Session-lifecycle mutation and persistence for subagent kills. */
import type { ClearSessionQueueResult } from "../../../auto-reply/reply/queue.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { logVerbose } from "../../../globals.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../../sessions/session-lifecycle-admission.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import {
  SUBAGENT_KILL_TASK_ERROR,
  type DetachedTaskTerminalState,
} from "../../../tasks/detached-task-runtime-contract.js";
import { isCurrentSubagentRun } from "./subagent-control-scope.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { resolveSessionEntryForKey } from "./subagent-list.js";
import {
  resolveFinalizedSubagentTaskState,
  resolveKilledSubagentTaskEndedAt,
} from "./subagent-registry-completion.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import {
  claimSubagentRunKill,
  markSubagentRunTerminated,
  releaseSubagentRunKillClaim,
} from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type PatchSessionEntry = typeof patchSessionEntryCore;
type AbortEmbeddedAgentRun = (sessionId: string) => boolean;
type IsEmbeddedAgentRunActive = (sessionId: string) => boolean;
type ClearSessionQueues = (keys: Array<string | undefined>) => ClearSessionQueueResult;

type SubagentKillDeps = {
  patchSessionEntryCore: PatchSessionEntry;
  abortEmbeddedAgentRun?: AbortEmbeddedAgentRun;
  isEmbeddedAgentRunActive?: IsEmbeddedAgentRunActive;
  clearSessionQueues?: ClearSessionQueues;
};

const defaultSubagentKillDeps: SubagentKillDeps = {
  patchSessionEntryCore,
};

let subagentKillDeps: SubagentKillDeps = defaultSubagentKillDeps;

const subagentKillRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-control.runtime.js"),
);

async function resolveSubagentKillRuntime(): Promise<{
  abortEmbeddedAgentRun: AbortEmbeddedAgentRun;
  isEmbeddedAgentRunActive: IsEmbeddedAgentRunActive;
  clearSessionQueues: ClearSessionQueues;
}> {
  if (
    subagentKillDeps.abortEmbeddedAgentRun &&
    subagentKillDeps.isEmbeddedAgentRunActive &&
    subagentKillDeps.clearSessionQueues
  ) {
    return {
      abortEmbeddedAgentRun: subagentKillDeps.abortEmbeddedAgentRun,
      isEmbeddedAgentRunActive: subagentKillDeps.isEmbeddedAgentRunActive,
      clearSessionQueues: subagentKillDeps.clearSessionQueues,
    };
  }
  const runtime = await subagentKillRuntimeLoader.load();
  return {
    abortEmbeddedAgentRun: subagentKillDeps.abortEmbeddedAgentRun ?? runtime.abortEmbeddedAgentRun,
    isEmbeddedAgentRunActive:
      subagentKillDeps.isEmbeddedAgentRunActive ?? runtime.isEmbeddedAgentRunActive,
    clearSessionQueues: subagentKillDeps.clearSessionQueues ?? runtime.clearSessionQueues,
  };
}

export function setSubagentKillTestDeps(overrides?: Partial<SubagentKillDeps>) {
  subagentKillDeps = overrides
    ? {
        ...defaultSubagentKillDeps,
        ...overrides,
      }
    : defaultSubagentKillDeps;
}

type SubagentKillTargetState =
  | { state: "finalizing" }
  | { state: "terminal"; task: DetachedTaskTerminalState };

export function resolveSubagentKillTargetState(
  entry: SubagentRunRecord,
): SubagentKillTargetState | undefined {
  if (
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.suppressAnnounceReason !== "steer-restart"
  ) {
    const taskEndedAt = resolveKilledSubagentTaskEndedAt(entry);
    return typeof taskEndedAt === "number"
      ? {
          state: "terminal",
          task: {
            status: "cancelled",
            endedAt: taskEndedAt,
            lastEventAt: taskEndedAt,
            error: SUBAGENT_KILL_TASK_ERROR,
            progressSummary: entry.completion?.resultText ?? undefined,
            terminalSummary: null,
          },
        }
      : undefined;
  }
  const terminal = resolveFinalizedSubagentTaskState(entry);
  if (terminal) {
    return { state: "terminal", task: terminal };
  }
  return typeof entry.execution.endedAt === "number" &&
    entry.pauseReason !== "sessions_yield" &&
    (entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
      entry.suppressAnnounceReason === "steer-restart")
    ? { state: "finalizing" }
    : undefined;
}

export async function persistSubagentAbortedLastRun(params: {
  childSessionKey: string;
  storePath: string;
  hasSessionEntry: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  abortedLastRun: boolean;
  isCurrent?: (current: SessionEntry) => boolean;
  assertCommitAllowed?: () => void;
  strict?: boolean;
}): Promise<boolean> {
  if (!params.hasSessionEntry) {
    return true;
  }
  try {
    await subagentKillDeps.patchSessionEntryCore(
      { storePath: params.storePath, sessionKey: params.childSessionKey },
      (current) =>
        current.sessionId !== params.expectedSessionId ||
        current.lifecycleRevision !== params.expectedLifecycleRevision ||
        params.isCurrent?.(current) === false
          ? null
          : {
              ...current,
              abortedLastRun: params.abortedLastRun,
              updatedAt: Date.now(),
            },
      {
        assertCommitAllowed: params.assertCommitAllowed,
        replaceEntry: true,
      },
    );
    return true;
  } catch (error) {
    if (params.strict) {
      throw error;
    }
    logVerbose(
      `subagents control kill: failed to persist abortedLastRun=${params.abortedLastRun} for ${params.childSessionKey}: ${formatErrorMessage(error)}`,
    );
    return false;
  }
}

function markSubagentRunTerminatedBestEffort(
  params: Parameters<typeof markSubagentRunTerminated>[0],
): number {
  try {
    return markSubagentRunTerminated(params);
  } catch (error) {
    // The registry transition rolled back atomically. Keep multi-run control
    // moving so one persistence failure cannot leave siblings running.
    logVerbose(
      `subagents control kill: failed to persist ${params.runId ?? params.childSessionKey ?? "unknown"}: ${formatErrorMessage(error)}`,
    );
    return 0;
  }
}

async function killSubagentRun(params: {
  cfg: OpenClawConfig;
  entry: SubagentRunRecord;
  cache: Map<string, Record<string, SessionEntry>>;
  suppressTaskDelivery?: boolean;
}): Promise<{
  killed: boolean;
  sessionId?: string;
  superseded?: boolean;
  targetState?: SubagentKillTargetState;
  error?: string;
}> {
  const markKilledBestEffort = () =>
    markSubagentRunTerminatedBestEffort({
      runId: params.entry.runId,
      reason: "killed",
      suppressTaskDelivery: params.suppressTaskDelivery,
    });
  const initialTargetState = resolveSubagentKillTargetState(params.entry);
  if (initialTargetState) {
    if (
      params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      params.entry.suppressAnnounceReason !== "steer-restart"
    ) {
      markKilledBestEffort();
    }
    return { killed: false, targetState: initialTargetState };
  }
  if (params.entry.execution.endedAt && params.entry.pauseReason !== "sessions_yield") {
    return { killed: false };
  }
  const childSessionKey = params.entry.childSessionKey;
  const resolved = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: childSessionKey,
    cache: params.cache,
  });
  const sessionId = resolved.entry?.sessionId;
  const sessionLifecycleRevision = resolved.entry?.lifecycleRevision;
  const runtime = await resolveSubagentKillRuntime();
  let admittedWorkReleased = true;
  return await runExclusiveSessionLifecycleMutation({
    scope: resolved.storePath,
    identities: [childSessionKey, sessionId],
    prepare: async () => {
      if (!isCurrentSubagentRun(params.entry, params.cfg)) {
        return;
      }
      admittedWorkReleased = await interruptSessionWorkAdmissions({
        scope: resolved.storePath,
        identities: [childSessionKey, sessionId],
        timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      });
    },
    run: async () => {
      if (!admittedWorkReleased) {
        return {
          killed: false,
          sessionId,
          error: "Subagent is still active; try the kill again in a moment.",
        };
      }
      // Runtime loading and admission draining yield. Fence the exact row before
      // touching session-owned queues so a successor cannot inherit an older kill.
      if (!isCurrentSubagentRun(params.entry, params.cfg)) {
        return { killed: false, sessionId, superseded: true };
      }
      const targetStateAfterRuntimeLoad = resolveSubagentKillTargetState(params.entry);
      if (targetStateAfterRuntimeLoad) {
        if (
          params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
          params.entry.suppressAnnounceReason !== "steer-restart"
        ) {
          markKilledBestEffort();
        }
        return { killed: false, sessionId, targetState: targetStateAfterRuntimeLoad };
      }
      let killClaim: ReturnType<typeof claimSubagentRunKill>;
      const killOwnerCurrent = () =>
        isCurrentSubagentRun(params.entry, params.cfg) &&
        (!killClaim ||
          ((params.entry.killIntent === killClaim ||
            (params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
              params.entry.killReconciliation !== undefined &&
              params.entry.execution.lifecycleGeneration === killClaim.lifecycleGeneration)) &&
            (killClaim.lifecycleGeneration === undefined ||
              isAgentEventLifecycleGenerationCurrent(killClaim.lifecycleGeneration))));
      const persistAbortedLastRun = (abortedLastRun: boolean, strict = false) =>
        persistSubagentAbortedLastRun({
          childSessionKey,
          storePath: resolved.storePath,
          hasSessionEntry: resolved.entry !== undefined,
          expectedSessionId: sessionId,
          expectedLifecycleRevision: sessionLifecycleRevision,
          abortedLastRun,
          isCurrent: () => killOwnerCurrent(),
          assertCommitAllowed: () => {
            if (!killOwnerCurrent()) {
              throw new Error("subagent kill lifecycle retired before abort-marker commit");
            }
          },
          strict,
        });
      try {
        // Persist operator intent before aborting runtime work. If terminal
        // persistence fails, recovery still cannot replay this exact row.
        killClaim = claimSubagentRunKill({
          runId: params.entry.runId,
          expected: params.entry,
          sessionId,
          sessionLifecycleRevision,
          suppressTaskDelivery: params.suppressTaskDelivery,
        });
      } catch (error) {
        return {
          killed: false,
          sessionId,
          error: `Failed to persist subagent kill intent: ${formatErrorMessage(error)}`,
        };
      }
      if (!killClaim || !killOwnerCurrent()) {
        return {
          killed: false,
          sessionId,
          superseded: true,
        };
      }
      const claimedKill = killClaim;
      const ownsSessionIncarnation = () => {
        const currentSessionEntry = loadSessionEntry({
          storePath: resolved.storePath,
          sessionKey: childSessionKey,
          clone: false,
          readConsistency: "latest",
        });
        return (
          (currentSessionEntry !== undefined) === (resolved.entry !== undefined) &&
          currentSessionEntry?.sessionId === sessionId &&
          currentSessionEntry?.lifecycleRevision === sessionLifecycleRevision
        );
      };
      const releaseChangedSessionKill = () => {
        try {
          releaseSubagentRunKillClaim({
            runId: params.entry.runId,
            expected: params.entry,
            claim: claimedKill,
          });
        } catch (error) {
          return {
            killed: false,
            sessionId,
            error: `Subagent session changed and its kill intent could not be released: ${formatErrorMessage(error)}`,
          };
        }
        return {
          killed: false,
          sessionId,
          error: "Subagent session changed while the kill was pending; retry.",
        };
      };
      if (!ownsSessionIncarnation()) {
        return releaseChangedSessionKill();
      }
      const active = sessionId ? runtime.isEmbeddedAgentRunActive(sessionId) : false;
      if (!ownsSessionIncarnation()) {
        return releaseChangedSessionKill();
      }
      const aborted = sessionId ? runtime.abortEmbeddedAgentRun(sessionId) : false;
      if (!ownsSessionIncarnation()) {
        return releaseChangedSessionKill();
      }
      const cleared = runtime.clearSessionQueues([childSessionKey, sessionId]);
      if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
        logVerbose(
          `subagents control kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
        );
      }
      if (active && !aborted) {
        try {
          releaseSubagentRunKillClaim({
            runId: params.entry.runId,
            expected: params.entry,
            claim: killClaim,
          });
        } catch (error) {
          return {
            killed: false,
            sessionId,
            error: `Subagent remained active and its kill intent could not be released: ${formatErrorMessage(error)}`,
          };
        }
        return {
          killed: false,
          sessionId,
          error: "Subagent is still active; try the kill again in a moment.",
        };
      }
      const targetState = resolveSubagentKillTargetState(params.entry);
      if (targetState) {
        const killedTarget =
          targetState.state === "terminal" &&
          targetState.task.status === "cancelled" &&
          targetState.task.error === SUBAGENT_KILL_TASK_ERROR;
        if (killedTarget) {
          markKilledBestEffort();
        } else {
          try {
            releaseSubagentRunKillClaim({
              runId: params.entry.runId,
              expected: params.entry,
              claim: killClaim,
            });
          } catch (error) {
            return {
              killed: false,
              sessionId,
              targetState,
              error: `Completed subagent kill intent could not be released: ${formatErrorMessage(error)}`,
            };
          }
        }
        return { killed: killedTarget, sessionId, targetState };
      }
      let marked: number;
      try {
        marked = markSubagentRunTerminated({
          runId: params.entry.runId,
          reason: "killed",
          suppressTaskDelivery: params.suppressTaskDelivery,
        });
      } catch (error) {
        return {
          killed: false,
          sessionId,
          error: `Failed to persist subagent kill tombstone: ${formatErrorMessage(error)}`,
        };
      }
      await persistAbortedLastRun(true);
      return {
        killed: marked > 0,
        sessionId,
      };
    },
  });
}

export async function killLatestSubagentRun(params: {
  cfg: OpenClawConfig;
  entry: SubagentRunRecord;
  cache: Map<string, Record<string, SessionEntry>>;
  suppressTaskDelivery?: boolean;
  expectedRunId?: string;
  expectedGeneration?: number;
}): Promise<{
  entry: SubagentRunRecord;
  result: Awaited<ReturnType<typeof killSubagentRun>>;
}> {
  let entry = params.entry;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (params.expectedGeneration !== undefined && entry.generation !== params.expectedGeneration) {
      return {
        entry,
        result: { killed: false, superseded: true },
      };
    }
    const result = await killSubagentRun({ ...params, entry });
    if (!result.superseded) {
      return { entry, result };
    }
    const latest = getLatestLiveSubagentRunByChildSessionKey(entry.childSessionKey);
    if (!latest || latest === entry) {
      return { entry, result };
    }
    // A task-scoped kill is bound to its exact run. Recovery may replace that
    // run while cancellation awaits lifecycle admission, but cannot inherit its authority.
    if (params.expectedRunId) {
      return { entry, result };
    }
    if (entry.execution.restartRecovery?.idempotencyKey !== latest.runId) {
      return { entry, result };
    }
    entry = latest;
  }
  return {
    entry,
    result: {
      killed: false,
      superseded: true,
      error: "Subagent changed generations repeatedly during kill; retry in a moment.",
    },
  };
}
