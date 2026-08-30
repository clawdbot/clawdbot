/** Session-lifecycle mutation and persistence for subagent kills. */

import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadExactSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { logVerbose } from "../../../globals.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
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
import {
  resolveFinalizedSubagentTaskState,
  resolveKilledSubagentTaskEndedAt,
} from "./subagent-registry-completion.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  claimSubagentRunKill,
  markSubagentRunTerminated,
  releaseSubagentRunKillClaim,
} from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const subagentKillRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-control.runtime.js"),
);

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
    await patchSessionEntryCore(
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

export function resolveSubagentKillSession(cfg: OpenClawConfig, sessionKey: string) {
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: parseAgentSessionKey(sessionKey)?.agentId,
  });
  return {
    storePath,
    entry: loadExactSessionEntryReadOnly({ storePath, sessionKey, clone: false })?.entry,
  };
}

export async function killSubagentRun(params: {
  cfg: OpenClawConfig;
  entry: SubagentRunRecord;
  session: ReturnType<typeof resolveSubagentKillSession>;
  suppressTaskDelivery?: boolean;
  isCurrent?: (entry: SubagentRunRecord) => boolean;
  withdrawQueuedReservation: () => void;
  refreshDescendants: () => void;
}): Promise<{
  killed: boolean;
  sessionId?: string;
  superseded?: boolean;
  targetState?: SubagentKillTargetState;
  error?: string;
}> {
  const isCurrent = () =>
    isCurrentSubagentRun(params.entry, params.cfg) && params.isCurrent?.(params.entry) !== false;
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
  const resolved = params.session;
  const sessionId = resolved.entry?.sessionId;
  const sessionLifecycleRevision = resolved.entry?.lifecycleRevision;
  const runtime = await subagentKillRuntimeLoader.load();
  let admittedWorkReleased = true;
  return await runExclusiveSessionLifecycleMutation({
    scope: resolved.storePath,
    identities: [childSessionKey, sessionId],
    prepare: async () => {
      if (!isCurrent()) {
        return;
      }
      // Admissions can release scheduler capacity synchronously when interrupted.
      params.refreshDescendants();
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
      if (!isCurrent()) {
        return { killed: false, sessionId, superseded: true };
      }
      params.refreshDescendants();
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
        isCurrent() &&
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
      if (!killClaim) {
        return {
          killed: false,
          sessionId,
          superseded: true,
        };
      }
      const claimedKill = killClaim;
      const ownsSessionIncarnation = () => {
        const currentSessionEntry = loadExactSessionEntryReadOnly({
          storePath: resolved.storePath,
          sessionKey: childSessionKey,
          clone: false,
        })?.entry;
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
      try {
        if (!ownsSessionIncarnation()) {
          return releaseChangedSessionKill();
        }
        if (!killOwnerCurrent()) {
          return { killed: false, sessionId, superseded: true };
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
      } catch (error) {
        return { killed: false, sessionId, error: formatErrorMessage(error) };
      } finally {
        // Disposition follows the exact retained claim, not fallible session/ancestor reads.
        // The captured scheduler capability cannot withdraw a replacement or active launch.
        if (
          subagentRuns.get(params.entry.runId) === params.entry &&
          params.entry.killIntent === claimedKill
        ) {
          params.withdrawQueuedReservation();
        }
      }
    },
  });
}
