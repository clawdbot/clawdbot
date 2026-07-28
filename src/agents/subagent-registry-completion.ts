/**
 * Subagent run completion helpers.
 * Compares outcomes, maps them to lifecycle events, and emits completion hooks
 * exactly once per completed child run.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  SUBAGENT_KILL_TASK_ERROR,
  type DetachedTaskTerminalState,
} from "../tasks/detached-task-runtime-contract.js";
import { resolveRequiredCompletionTerminalResult } from "../tasks/task-completion-contract.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import {
  SUBAGENT_ENDED_REASON_KILLED,
  SUBAGENT_ENDED_OUTCOME_ERROR,
  SUBAGENT_ENDED_OUTCOME_OK,
  SUBAGENT_ENDED_OUTCOME_TIMEOUT,
  SUBAGENT_TARGET_KIND_SUBAGENT,
  type SubagentLifecycleEndedOutcome,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const log = createSubsystemLogger("agents/subagent-registry-completion");

/** Compares subagent run outcomes, treating missing timing as compatible. */
function runOutcomesEqual(
  a: SubagentRunOutcome | undefined,
  b: SubagentRunOutcome | undefined,
): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.status !== b.status) {
    return false;
  }
  if (a.status === "error" && b.status === "error") {
    if ((a.error ?? "") !== (b.error ?? "")) {
      return false;
    }
  }
  if (!runOutcomeHasTiming(a) || !runOutcomeHasTiming(b)) {
    return true;
  }
  return a.startedAt === b.startedAt && a.endedAt === b.endedAt && a.elapsedMs === b.elapsedMs;
}

/** Returns true when an outcome carries timing fields. */
function runOutcomeHasTiming(outcome: SubagentRunOutcome | undefined): boolean {
  return (
    Number.isFinite(outcome?.startedAt) ||
    Number.isFinite(outcome?.endedAt) ||
    Number.isFinite(outcome?.elapsedMs)
  );
}

/** Returns true when a run outcome update should replace current state. */
export function shouldUpdateRunOutcome(
  current: SubagentRunOutcome | undefined,
  next: SubagentRunOutcome | undefined,
): boolean {
  return (
    !runOutcomesEqual(current, next) || (!runOutcomeHasTiming(current) && runOutcomeHasTiming(next))
  );
}

/** Returns the complete task projection only after completion capture has settled. */
export function resolveFinalizedSubagentTaskState(
  entry: SubagentRunRecord,
): DetachedTaskTerminalState | undefined {
  const endedAt = entry.endedAt;
  const outcome = entry.outcome;
  const completion = entry.completion;
  if (
    typeof endedAt !== "number" ||
    !outcome ||
    entry.pauseReason === "sessions_yield" ||
    (completion?.resultText === undefined && typeof completion?.capturedAt !== "number")
  ) {
    return undefined;
  }
  const progressSummary = completion.resultText ?? undefined;
  if (
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.suppressAnnounceReason !== "steer-restart"
  ) {
    return {
      status: "cancelled",
      endedAt,
      lastEventAt: endedAt,
      error: SUBAGENT_KILL_TASK_ERROR,
      progressSummary,
      terminalSummary: null,
    };
  }
  if (outcome.status === "ok") {
    const terminal =
      entry.expectsCompletionMessage === true
        ? resolveRequiredCompletionTerminalResult(completion.resultText)
        : {};
    return {
      status: "succeeded",
      endedAt,
      lastEventAt: endedAt,
      progressSummary,
      terminalSummary: terminal.terminalSummary ?? null,
      terminalOutcome: terminal.terminalOutcome,
    };
  }
  return {
    status: outcome.status === "timeout" ? "timed_out" : "failed",
    endedAt,
    lastEventAt: endedAt,
    error: outcome.status === "error" ? outcome.error : undefined,
    progressSummary,
    terminalSummary: null,
  };
}

/** Preserves execution end time, except when a paused run was killed after its yield. */
export function resolveKilledSubagentTaskEndedAt(entry: SubagentRunRecord): number | undefined {
  if (entry.killReconciliation) {
    return entry.killReconciliation.killedAt;
  }
  const endedAt = entry.endedAt;
  const cleanupCompletedAt = entry.cleanupCompletedAt;
  return entry.suppressAnnounceReason === "killed" &&
    typeof endedAt === "number" &&
    typeof cleanupCompletedAt === "number" &&
    cleanupCompletedAt > endedAt
    ? cleanupCompletedAt
    : endedAt;
}

/** Maps registry run outcome to lifecycle event outcome. */
export function resolveLifecycleOutcomeFromRunOutcome(
  outcome: SubagentRunOutcome | undefined,
): SubagentLifecycleEndedOutcome {
  if (outcome?.status === "error") {
    return SUBAGENT_ENDED_OUTCOME_ERROR;
  }
  if (outcome?.status === "timeout") {
    return SUBAGENT_ENDED_OUTCOME_TIMEOUT;
  }
  return SUBAGENT_ENDED_OUTCOME_OK;
}

/** Emits the transient presentation event for a newly terminal child run. */
export async function emitSubagentProgressEndedHook(entry: SubagentRunRecord): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_progress")) {
    return;
  }
  const outcome =
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED
      ? "killed"
      : entry.outcome
        ? resolveLifecycleOutcomeFromRunOutcome(entry.outcome)
        : "unknown";
  try {
    await hookRunner.runSubagentProgress(
      {
        phase: "ended",
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        outcome,
        requester: entry.progressOrigin,
      },
      {
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
      },
    );
  } catch (err) {
    log.warn(
      `failed to emit subagent progress for run ${entry.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Emits the subagent_ended hook once per completed run. */
export async function emitSubagentEndedHookOnce(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  outcome?: SubagentLifecycleEndedOutcome;
  error?: string;
  inFlightRunIds: Set<string>;
  persist: () => void;
}) {
  const runId = params.entry.runId.trim();
  if (!runId) {
    return false;
  }
  if (params.entry.endedHookEmittedAt) {
    return false;
  }
  if (params.inFlightRunIds.has(runId)) {
    return false;
  }

  // In-flight guard prevents concurrent completion paths from double-emitting
  // the hook before endedHookEmittedAt is persisted.
  params.inFlightRunIds.add(runId);
  try {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner) {
      return false;
    }
    if (hookRunner?.hasHooks("subagent_ended")) {
      await hookRunner.runSubagentEnded(
        {
          targetSessionKey: params.entry.childSessionKey,
          targetKind: SUBAGENT_TARGET_KIND_SUBAGENT,
          reason: params.reason,
          sendFarewell: params.sendFarewell,
          accountId: params.accountId,
          runId: params.entry.runId,
          endedAt: params.entry.endedAt,
          outcome: params.outcome,
          error: params.error,
        },
        {
          runId: params.entry.runId,
          childSessionKey: params.entry.childSessionKey,
          requesterSessionKey: params.entry.requesterSessionKey,
        },
      );
    }
    params.entry.endedHookEmittedAt = Date.now();
    params.persist();
    return true;
  } catch (err) {
    log.warn(
      `failed to emit subagent_ended hook for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  } finally {
    params.inFlightRunIds.delete(runId);
  }
}
