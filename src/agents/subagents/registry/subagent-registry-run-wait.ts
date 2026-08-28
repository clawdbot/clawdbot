/** Owns subagent run completion waits and session reconciliation. */
import { getRuntimeConfig } from "../../../config/config.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { callGateway } from "../../../gateway/call.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { DetachedTaskFindResult } from "../../../tasks/detached-task-runtime-contract.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../../agent-run-terminal-outcome.js";
import { isRecoverableAgentWaitError, waitForAgentRun } from "../../run-wait.js";
import {
  type SubagentRunOutcome,
  withSubagentOutcomeTiming,
} from "../announce/subagent-announce-output.js";
import { classifySubagentTerminalOutcome } from "../subagent-terminal-outcome.js";
import { clearDeliveryState, ensureCompletionState } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";
import { resolveSubagentRunDeadlineMs } from "./subagent-run-timeout.js";
import type { SubagentSessionCompletion } from "./subagent-session-reconciliation.js";

const log = createSubsystemLogger("agents/subagent-registry");
const RECOVERABLE_WAIT_RETRY_DELAY_MS = isFastTestRuntimeEnv() ? 25 : 5_000;
const WAIT_TIMEOUT_DEADLINE_SKEW_MS = 250;

function resolveHardRunTimeoutEndedAt(
  entry: SubagentRunRecord,
  now: number,
  observedStartedAt?: number,
): number | undefined {
  const deadlineMs = resolveSubagentRunDeadlineMs(entry, observedStartedAt);
  if (deadlineMs === undefined) {
    return undefined;
  }
  return now + WAIT_TIMEOUT_DEADLINE_SKEW_MS >= deadlineMs ? deadlineMs : undefined;
}

function resolveCompletionAfterHardRunDeadline(params: {
  entry: SubagentRunRecord;
  observedStartedAt?: number;
  observedEndedAt?: number;
  now: number;
}): number | undefined {
  const deadlineMs = resolveSubagentRunDeadlineMs(params.entry, params.observedStartedAt);
  if (deadlineMs === undefined) {
    return undefined;
  }
  const observedEndedAt =
    typeof params.observedEndedAt === "number" && Number.isFinite(params.observedEndedAt)
      ? params.observedEndedAt
      : params.now;
  return observedEndedAt > deadlineMs ? deadlineMs : undefined;
}

function resolveWaitTimeoutMsForRun(
  entry: SubagentRunRecord,
  waitTimeoutMs: number,
  now: number,
): number {
  const normalizedWaitTimeoutMs = Math.max(1, Math.floor(waitTimeoutMs));
  const deadlineMs = resolveSubagentRunDeadlineMs(entry);
  if (deadlineMs === undefined) {
    return normalizedWaitTimeoutMs;
  }
  return Math.max(1, Math.min(normalizedWaitTimeoutMs, deadlineMs - now));
}

export function markSubagentRunPausedAfterYield(params: {
  entry: SubagentRunRecord;
  startedAt?: number;
  endedAt?: number;
  now?: number;
}): boolean {
  const { entry } = params;
  if (
    entry.terminalOwner === "interrupted-recovery" ||
    shouldSuppressSubagentRecoverySessionEffects(entry) ||
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED ||
    entry.suppressAnnounceReason === "killed" ||
    (entry.cleanup === "delete" && Number.isFinite(entry.deleteCleanupDispatchedAt))
  ) {
    // agent.wait and lifecycle events can report an old yield after terminal
    // ownership settles. Reviving the row would expose a run whose session may
    // belong to a newer lifecycle or already be gone.
    return false;
  }
  let mutated = false;
  if (typeof params.startedAt === "number" && entry.execution.startedAt !== params.startedAt) {
    entry.execution = { ...entry.execution, startedAt: params.startedAt };
    if (typeof entry.sessionStartedAt !== "number") {
      entry.sessionStartedAt = params.startedAt;
    }
    mutated = true;
  }
  const endedAt = typeof params.endedAt === "number" ? params.endedAt : (params.now ?? Date.now());
  if (
    entry.execution.status !== "terminal" ||
    entry.execution.endedAt !== endedAt ||
    entry.execution.outcome !== undefined
  ) {
    entry.execution = { ...entry.execution, status: "terminal", endedAt };
    delete entry.execution.outcome;
    mutated = true;
  }
  if (entry.pauseReason !== "sessions_yield") {
    entry.pauseReason = "sessions_yield";
    mutated = true;
  }
  if (entry.archiveAtMs !== undefined) {
    delete entry.archiveAtMs;
    mutated = true;
  }
  if (entry.endedReason !== undefined) {
    entry.endedReason = undefined;
    mutated = true;
  }
  if (entry.cleanupHandled === true) {
    entry.cleanupHandled = false;
    mutated = true;
  }
  if (entry.cleanupCompletedAt !== undefined) {
    entry.cleanupCompletedAt = undefined;
    mutated = true;
  }
  if (entry.delivery !== undefined) {
    clearDeliveryState(entry);
    mutated = true;
  }
  const completion = ensureCompletionState(entry);
  if (completion.resultText !== undefined) {
    completion.resultText = undefined;
    completion.capturedAt = undefined;
    completion.terminalReply = undefined;
    mutated = true;
  }
  return mutated;
}

export type SubagentManagerOptions = {
  runs: Map<string, SubagentRunRecord>;
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>;
  resumedRuns: Set<string>;
  persist(...runIds: string[]): void;
  persistOrThrow(...runIds: string[]): void;
  callGateway: typeof callGateway;
  getRuntimeConfig: typeof getRuntimeConfig;
  ensureListener(): void;
  startSweeper(): void;
  stopSweeper(): void;
  resumeSubagentRun(runId: string): void;
  clearPendingLifecycleError(runId: string): void;
  clearPendingLifecycleTimeout(runId: string): void;
  resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number): number;
  scheduleSweep(args?: { delayMs?: number }): void;
  resolveSubagentSessionCompletion(args: {
    childSessionKey: string;
    fallbackEndedAt: number;
    notBeforeMs?: number;
  }): SubagentSessionCompletion | null;
  resolveSubagentSessionStartedAt(args: {
    childSessionKey: string;
    notBeforeMs?: number;
  }): number | undefined;
  notifyContextEngineSubagentEnded(
    args: {
      childSessionKey: string;
      reason: "completed" | "deleted" | "released";
      agentDir?: string;
      workspaceDir?: string;
    },
    options?: { isCurrent?: () => boolean },
  ): Promise<void>;
  completeCleanupBookkeeping(args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
    preserveTranscript?: boolean;
    provisionalKill?: boolean;
  }): void;
  completeSubagentRun(args: SubagentCompletionRequest): Promise<void>;
  resolveSubagentTask(entry: SubagentRunRecord): DetachedTaskFindResult;
};

export class SubagentWaitManager {
  constructor(protected readonly options: SubagentManagerOptions) {}

  protected shouldDeleteAttachments(entry: SubagentRunRecord): boolean {
    return entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
  }

  protected restoreRunRecord(entry: SubagentRunRecord, snapshot: SubagentRunRecord): void {
    for (const key of Object.keys(entry)) {
      Reflect.deleteProperty(entry, key);
    }
    Object.assign(entry, snapshot);
  }

  protected markOlderKillReconciliationsSuperseded(next: SubagentRunRecord) {
    const snapshots = new Map<SubagentRunRecord, SubagentRunRecord["killReconciliation"]>();
    for (const candidate of this.options.getRunsForChildSession(next.childSessionKey)) {
      if (
        candidate.runId === next.runId ||
        compareSubagentRunGeneration(candidate, next) >= 0 ||
        !candidate.killReconciliation
      ) {
        continue;
      }
      snapshots.set(candidate, structuredClone(candidate.killReconciliation));
      candidate.killReconciliation.supersededAt = Math.min(
        candidate.killReconciliation.supersededAt ?? next.createdAt,
        next.createdAt,
      );
    }
    return snapshots;
  }

  protected currentRunOwnsSession(entry: SubagentRunRecord): boolean {
    return (
      this.options.runs.get(entry.runId) === entry &&
      entry.killReconciliation?.supersededAt === undefined &&
      !Array.from(this.options.getRunsForChildSession(entry.childSessionKey)).some(
        (candidate) => compareSubagentRunGeneration(candidate, entry) > 0,
      )
    );
  }

  protected restoreKillReconciliationSnapshots(
    snapshots: Map<SubagentRunRecord, SubagentRunRecord["killReconciliation"]>,
  ): void {
    for (const [entry, snapshot] of snapshots) {
      entry.killReconciliation = snapshot;
    }
  }

  private runSubagentCompletionWait = async (
    runId: string,
    waitTimeoutMs: number,
    expectedEntry?: SubagentRunRecord,
    capWaitToStoredDeadline = false,
  ): Promise<void> => {
    let completionForRetry: Parameters<typeof this.options.completeSubagentRun>[0] | undefined;
    const scheduleWaitRetry = (entry: SubagentRunRecord, reason: string, error?: string) => {
      this.options.scheduleSweep({ delayMs: 1_000 });
      const scheduledEntry = entry;
      setTimeout(() => {
        const current = this.options.runs.get(runId);
        if (
          !current ||
          current !== scheduledEntry ||
          typeof current.execution.endedAt === "number"
        ) {
          return;
        }
        void this.waitForSubagentCompletion(runId, waitTimeoutMs, scheduledEntry, true);
      }, RECOVERABLE_WAIT_RETRY_DELAY_MS).unref?.();
      log.info(reason, {
        runId,
        childSessionKey: entry.childSessionKey,
        ...(error ? { error } : {}),
      });
    };
    try {
      const entryBeforeWait = this.options.runs.get(runId);
      if (!entryBeforeWait || (expectedEntry && entryBeforeWait !== expectedEntry)) {
        return;
      }
      const waitStartedAt = Date.now();
      const timeoutMs = capWaitToStoredDeadline
        ? resolveWaitTimeoutMsForRun(entryBeforeWait, waitTimeoutMs, waitStartedAt)
        : Math.max(1, Math.floor(waitTimeoutMs));
      const wait = await waitForAgentRun({
        runId,
        timeoutMs,
        callGateway: this.options.callGateway,
      });
      const entry = this.options.runs.get(runId);
      if (!entry || (expectedEntry && entry !== expectedEntry)) {
        return;
      }
      if (wait.status === "pending") {
        return;
      }
      const waitTerminalOutcome = buildAgentRunTerminalOutcomeFromWaitResult(wait);
      const waitBlocked = waitTerminalOutcome?.reason === "blocked";
      const waitAborted =
        waitTerminalOutcome !== undefined &&
        classifySubagentTerminalOutcome(waitTerminalOutcome) === "cancellation";
      const waitStatus = waitTerminalOutcome?.status ?? wait.status;
      if (wait.yielded === true && waitStatus !== "timeout" && !waitBlocked) {
        this.options.clearPendingLifecycleError(runId);
        this.options.clearPendingLifecycleTimeout(runId);
        if (
          markSubagentRunPausedAfterYield({
            entry,
            startedAt: wait.startedAt,
            endedAt: wait.endedAt,
          })
        ) {
          this.options.persist(entry.runId);
        }
        return;
      }
      if (waitStatus === "error" && !waitAborted && isRecoverableAgentWaitError(wait.error)) {
        scheduleWaitRetry(entry, "subagent wait interrupted; scheduling recovery", wait.error);
        return;
      }
      const observedStartedAt =
        typeof wait.startedAt === "number" && Number.isFinite(wait.startedAt)
          ? wait.startedAt
          : this.options.resolveSubagentSessionStartedAt({
              childSessionKey: entry.childSessionKey,
              notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
            });
      const completeAsRunTimeout = async (endedAt?: number, startedAt?: number) => {
        const timeoutCompletion: Parameters<typeof this.options.completeSubagentRun>[0] = {
          runId,
          outcome: { status: "timeout" },
          reason: SUBAGENT_ENDED_REASON_COMPLETE,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
          terminalReply: wait.terminalReply,
        };
        if (typeof endedAt === "number") {
          timeoutCompletion.endedAt = endedAt;
        }
        if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
          timeoutCompletion.startedAt = startedAt;
        }
        completionForRetry = timeoutCompletion;
        await this.options.completeSubagentRun(completionForRetry);
      };
      if (waitStatus === "timeout") {
        const isTerminalWaitTimeout =
          typeof wait.endedAt === "number" ||
          typeof wait.stopReason === "string" ||
          typeof wait.livenessState === "string";
        const now = Date.now();
        // A plain agent.wait timeout has no terminal snapshot. For explicit
        // subagent run timeouts, the stored run deadline is the completion
        // contract so parent sessions are woken instead of retrying forever.
        const hardRunTimeoutEndedAt = resolveHardRunTimeoutEndedAt(entry, now, observedStartedAt);
        const completion = this.options.resolveSubagentSessionCompletion({
          childSessionKey: entry.childSessionKey,
          fallbackEndedAt:
            typeof wait.endedAt === "number" ? wait.endedAt : (hardRunTimeoutEndedAt ?? now),
          notBeforeMs: observedStartedAt ?? entry.execution.startedAt ?? entry.createdAt,
        });
        if (completion) {
          const completionStartedAt = observedStartedAt ?? completion.startedAt;
          const completionAfterDeadline = resolveCompletionAfterHardRunDeadline({
            entry,
            observedStartedAt: completionStartedAt,
            observedEndedAt: completion.endedAt,
            now,
          });
          if (completionAfterDeadline !== undefined) {
            await completeAsRunTimeout(completionAfterDeadline, completionStartedAt);
            return;
          }
          completionForRetry = {
            runId,
            endedAt: completion.endedAt,
            outcome: completion.outcome,
            reason: completion.reason,
            sendFarewell: true,
            accountId: entry.requesterOrigin?.accountId,
            triggerCleanup: true,
            startedAt: completionStartedAt,
          };
          await this.options.completeSubagentRun(completionForRetry);
          return;
        }
        if (isTerminalWaitTimeout || hardRunTimeoutEndedAt !== undefined) {
          let timeoutEndedAt =
            typeof wait.endedAt === "number" ? wait.endedAt : hardRunTimeoutEndedAt;
          const timeoutAfterDeadline = resolveCompletionAfterHardRunDeadline({
            entry,
            observedStartedAt,
            observedEndedAt: timeoutEndedAt,
            now,
          });
          if (timeoutAfterDeadline !== undefined) {
            timeoutEndedAt = timeoutAfterDeadline;
          }
          await completeAsRunTimeout(timeoutEndedAt, observedStartedAt);
          return;
        }
        if (observedStartedAt !== undefined && entry.execution.startedAt !== observedStartedAt) {
          entry.execution = { ...entry.execution, startedAt: observedStartedAt };
          if (typeof entry.sessionStartedAt !== "number") {
            entry.sessionStartedAt = observedStartedAt;
          }
          this.options.persist(entry.runId);
        }
        scheduleWaitRetry(
          entry,
          "subagent wait timed out; deferring terminal state until session reconciliation",
        );
        return;
      }
      const completionAfterDeadline = resolveCompletionAfterHardRunDeadline({
        entry,
        observedStartedAt,
        observedEndedAt: wait.endedAt,
        now: Date.now(),
      });
      if (completionAfterDeadline !== undefined) {
        await completeAsRunTimeout(completionAfterDeadline, observedStartedAt);
        return;
      }
      const endedAt = typeof wait.endedAt === "number" ? wait.endedAt : Date.now();
      const rawWaitError = typeof wait.error === "string" ? wait.error : undefined;
      const waitError = waitAborted
        ? "subagent run terminated"
        : (waitTerminalOutcome?.error ?? rawWaitError);
      const baseOutcome: SubagentRunOutcome =
        waitStatus === "error" ? { status: "error", error: waitError } : { status: "ok" };
      const outcome = withSubagentOutcomeTiming(baseOutcome, {
        startedAt: observedStartedAt ?? entry.execution.startedAt,
        endedAt,
      });
      completionForRetry = {
        runId,
        endedAt,
        outcome,
        reason: waitAborted
          ? SUBAGENT_ENDED_REASON_KILLED
          : waitStatus === "error"
            ? SUBAGENT_ENDED_REASON_ERROR
            : SUBAGENT_ENDED_REASON_COMPLETE,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
        startedAt: observedStartedAt,
        terminalReply: wait.terminalReply,
      };
      await this.options.completeSubagentRun(completionForRetry);
    } catch (error) {
      const current = this.options.runs.get(runId);
      log.warn("failed to complete subagent run; retrying completion", {
        runId,
        childSessionKey: current?.childSessionKey ?? expectedEntry?.childSessionKey,
        error,
      });
      if (!current) {
        return;
      }
      if (completionForRetry) {
        try {
          await this.options.completeSubagentRun(completionForRetry);
          return;
        } catch (retryError) {
          log.warn("failed to complete subagent run after retry; retrying ended cleanup", {
            runId,
            childSessionKey: current.childSessionKey,
            error: retryError,
          });
        }
      }
      if (
        typeof current.execution.endedAt === "number" &&
        !current.cleanupCompletedAt &&
        current.pauseReason !== "sessions_yield"
      ) {
        current.cleanupHandled = false;
        this.options.resumedRuns.delete(runId);
        this.options.resumeSubagentRun(runId);
      } else if (completionForRetry && typeof current.execution.endedAt !== "number") {
        this.options.scheduleSweep({ delayMs: 1_000 });
      }
    }
  };

  // Child completion outlives the spawning attempt, so all launch and retry
  // paths must start without inheriting its soon-to-be-disposed writer.
  readonly waitForSubagentCompletion = (
    runId: string,
    waitTimeoutMs: number,
    expectedEntry?: SubagentRunRecord,
    capWaitToStoredDeadline = false,
  ): Promise<void> =>
    runWithoutOwnedSessionTranscriptWrites(() =>
      this.runSubagentCompletionWait(runId, waitTimeoutMs, expectedEntry, capWaitToStoredDeadline),
    );
}
