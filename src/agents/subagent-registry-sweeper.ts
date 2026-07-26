import type { callGateway } from "../gateway/call.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { removeInternalSessionEffectsSession } from "./internal-session-effects.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryLastError,
  isDeliverySuspended,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
} from "./subagent-lifecycle-events.js";
import { reconcileOrphanedRun, safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import type { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { reconcileProvisionalSubagentKill } from "./subagent-registry-sweep-kill.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentCompletionRequest,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";

const SESSION_RUN_TTL_MS = 5 * 60_000;
const STALE_ACTIVE_SUBAGENT_GRACE_MS = isFastTestRuntimeEnv() ? 1_000 : 60_000;
const SUSPENDED_DELIVERY_CRON_EXPIRY_MS = 2 * 60 * 60_000;
const SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS = 6 * 60 * 60_000;
const SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS = 24 * 60 * 60_000;
const SUSPENDED_DELIVERY_SOFT_CAP = 25;
const SUSPENDED_DELIVERY_HARD_CAP = 50;
const SUSPENDED_DELIVERY_PRESSURE_TARGET = 10;

type LifecycleController = ReturnType<typeof createSubagentRegistryLifecycleController>;
type LifecycleOptions = Parameters<typeof createSubagentRegistryLifecycleController>[0];

export async function retireSupersededSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  runs: Map<string, SubagentRunRecord>;
  clearPendingLifecycleError: (runId: string) => void;
}): Promise<void> {
  const transcriptTarget = params.entry.execution?.transcriptTarget;
  params.clearPendingLifecycleError(params.runId);
  params.runs.delete(params.runId);
  const transcriptStillOwned = Array.from(params.runs.values()).some((candidate) => {
    const candidateTarget = candidate.execution?.transcriptTarget;
    return (
      candidateTarget?.sessionId === transcriptTarget?.sessionId &&
      candidateTarget?.sessionKey === transcriptTarget?.sessionKey &&
      candidateTarget?.storePath === transcriptTarget?.storePath
    );
  });
  if (transcriptTarget && !transcriptStillOwned) {
    await removeInternalSessionEffectsSession(transcriptTarget);
  }
  if (params.entry.cleanup === "delete" || !params.entry.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(params.entry);
  }
}

export function createSubagentRegistrySweeper(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  persist: () => void;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  sweepPendingLifecycle: (now: number) => void;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
  scheduleSubagentOrphanRecovery: (params?: { delayMs?: number; maxRetries?: number }) => void;
  resumeRequesterSettleWake: LifecycleController["resumeRequesterSettleWake"];
  startSubagentAnnounceCleanupFlow: LifecycleController["startSubagentAnnounceCleanupFlow"];
  completeCleanupBookkeeping: LifecycleController["completeCleanupBookkeeping"];
  shouldEmitEndedHookForRun: LifecycleOptions["shouldEmitEndedHookForRun"];
  emitSubagentEndedHookForRun: LifecycleOptions["emitSubagentEndedHookForRun"];
  callGateway: typeof callGateway;
  cleanupCollectorLaunchResources: (entry: SubagentRunRecord) => Promise<boolean>;
  runContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  notifyContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { runs, resumedRuns } = params;
  let timer: NodeJS.Timeout | null = null;
  let sweepInProgress = false;

  function start() {
    if (timer) {
      return;
    }
    timer = setInterval(() => {
      if (!sweepInProgress) {
        void runTick();
      }
    }, 60_000);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
    }
    timer = null;
  }

  async function runTick() {
    try {
      await runWithGatewayIndependentRootWorkAdmission(sweepOnce);
    } catch (error) {
      params.warn(
        `subagent run sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function runCleanupTail(runId: string, label: string, run: () => Promise<unknown>) {
    void runWithGatewayIndependentRootWorkAdmission(run).catch((error: unknown) => {
      params.warn(`subagent sweep ${label} failed`, { runId, error });
    });
  }

  function deleteSession(childSessionKey: string) {
    return params.callGateway({
      method: "sessions.delete",
      params: { key: childSessionKey, deleteTranscript: true, emitLifecycleHooks: false },
      timeoutMs: 10_000,
    });
  }

  const sweptContext = (entry: SubagentRunRecord) => ({
    childSessionKey: entry.childSessionKey,
    reason: "swept" as const,
    agentDir: entry.agentDir,
    workspaceDir: entry.workspaceDir,
  });

  function isSuspendedPendingFinalDelivery(entry: SubagentRunRecord): boolean {
    return typeof entry.endedAt === "number" && isDeliverySuspended(entry);
  }

  function resolveSuspendedDeliveryExpiryMs(entry: SubagentRunRecord): number {
    const requester = entry.requesterSessionKey;
    return requester.includes(":cron:")
      ? SUSPENDED_DELIVERY_CRON_EXPIRY_MS
      : requester.includes(":subagent:")
        ? SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS
        : SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS;
  }

  async function discardSuspendedPendingFinalDelivery(
    runId: string,
    entry: SubagentRunRecord,
    now: number,
    reason: "expired" | "pressure-pruned",
  ): Promise<void> {
    const delivery = ensureDeliveryState(entry);
    const payload = delivery.payload;
    delivery.status = "discarded";
    delivery.discardedAt = now;
    delivery.discardReason = reason;
    delivery.discardedPayloadSummary = {
      requesterSessionKey: payload?.requesterSessionKey ?? entry.requesterSessionKey,
      childSessionKey: payload?.childSessionKey ?? entry.childSessionKey,
      childRunId: payload?.childRunId ?? entry.runId,
      endedAt: payload?.endedAt ?? entry.endedAt,
      status: payload?.outcome?.status ?? entry.outcome?.status,
      lastError: getDeliveryLastError(entry) ?? null,
    };
    delivery.payload = undefined;
    delivery.createdAt = undefined;
    delivery.lastAttemptAt = undefined;
    delivery.attemptCount = undefined;
    delivery.lastError = undefined;
    delivery.suspendedAt = undefined;
    delivery.suspendedReason = undefined;
    entry.wakeOnDescendantSettle = undefined;
    const completion = ensureCompletionState(entry);
    completion.fallbackResultText = undefined;
    completion.fallbackCapturedAt = undefined;
    entry.cleanupHandled = true;
    delivery.announcedAt = undefined;
    resumedRuns.delete(runId);
    params.clearPendingLifecycleError(runId);
    params.clearPendingLifecycleTimeout(runId);
    params.warn("subagent suspended delivery discarded", {
      reason,
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
    });
    const shouldDeleteAttachments = entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(entry);
    }
    await removeInternalSessionEffectsSession(entry.execution?.transcriptTarget);
    const completionReason = entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
    params.completeCleanupBookkeeping({
      runId,
      entry,
      cleanup: entry.cleanup,
      completedAt: now,
      // The requester settle wake already ran when this delivery was suspended.
      skipRequesterSettleWake: true,
    });
    if (
      entry.expectsCompletionMessage === true &&
      params.shouldEmitEndedHookForRun({ entry, reason: completionReason })
    ) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason: completionReason,
        sendFarewell: true,
      });
    }
  }

  async function sweepOnce() {
    if (sweepInProgress) {
      return;
    }
    sweepInProgress = true;
    try {
      const now = Date.now();
      const storeCache: SubagentSessionStoreCache = new Map();
      let mutated = false;
      const archivedCollectorGroups = new Set<string>();
      const suspendedEntries = [...runs.entries()].filter(([, entry]) =>
        isSuspendedPendingFinalDelivery(entry),
      );
      const pressureDiscardRunIds = new Set<string>();
      if (suspendedEntries.length > SUSPENDED_DELIVERY_HARD_CAP) {
        const pressureCount = Math.max(
          0,
          suspendedEntries.length - SUSPENDED_DELIVERY_PRESSURE_TARGET,
        );
        for (const [runId] of suspendedEntries
          .toSorted((a, b) => (a[1].delivery?.suspendedAt ?? 0) - (b[1].delivery?.suspendedAt ?? 0))
          .slice(0, pressureCount)) {
          pressureDiscardRunIds.add(runId);
        }
        params.warn("subagent suspended delivery backlog exceeded pressure cap", {
          suspendedCount: suspendedEntries.length,
          softCap: SUSPENDED_DELIVERY_SOFT_CAP,
          hardCap: SUSPENDED_DELIVERY_HARD_CAP,
          pressureTarget: SUSPENDED_DELIVERY_PRESSURE_TARGET,
          pressureDiscardCount: pressureDiscardRunIds.size,
        });
      }
      for (const [runId, entry] of runs.entries()) {
        if (entry.requesterSettleWake) {
          params.resumeRequesterSettleWake(runId, entry);
          continue;
        }
        if (isSuspendedPendingFinalDelivery(entry)) {
          const suspendedAgeMs = now - (entry.delivery?.suspendedAt ?? now);
          const expired = suspendedAgeMs >= resolveSuspendedDeliveryExpiryMs(entry);
          if (expired || pressureDiscardRunIds.has(runId)) {
            await discardSuspendedPendingFinalDelivery(
              runId,
              entry,
              now,
              expired ? "expired" : "pressure-pruned",
            );
            mutated = true;
          }
          continue;
        }
        if (typeof entry.endedAt !== "number") {
          const hasLiveRunContext = Boolean(getAgentRunContext(runId));
          const activeAgeMs = now - (entry.startedAt ?? entry.createdAt);
          if (!hasLiveRunContext && activeAgeMs >= STALE_ACTIVE_SUBAGENT_GRACE_MS) {
            const orphanReason = resolveSubagentRunOrphanReason({ entry });
            if (orphanReason) {
              if (
                reconcileOrphanedRun({
                  runId,
                  entry,
                  reason: orphanReason,
                  source: "resume",
                  runs,
                  resumedRuns,
                })
              ) {
                mutated = true;
              }
              continue;
            }

            const sessionEntry = loadSubagentSessionEntry({
              childSessionKey: entry.childSessionKey,
              storeCache,
            });
            const completion = resolveCompletionFromSessionEntry(sessionEntry, now, {
              notBeforeMs: entry.startedAt ?? entry.createdAt,
            });
            if (completion) {
              await params.completeSubagentRunWithRecovery(
                {
                  runId,
                  startedAt: completion.startedAt,
                  endedAt: completion.endedAt,
                  outcome: completion.outcome,
                  reason: completion.reason,
                  sendFarewell: true,
                  accountId: entry.requesterOrigin?.accountId,
                  triggerCleanup: true,
                },
                "sweeper-session-completion",
              );
              continue;
            }

            if (sessionEntry?.abortedLastRun === true) {
              params.scheduleSubagentOrphanRecovery({ delayMs: 1_000 });
              continue;
            }

            await params.completeSubagentRunWithRecovery(
              {
                runId,
                endedAt: now,
                outcome: {
                  status: "error",
                  error: "subagent run lost active execution context",
                },
                reason: SUBAGENT_ENDED_REASON_ERROR,
                sendFarewell: true,
                accountId: entry.requesterOrigin?.accountId,
                triggerCleanup: true,
              },
              "sweeper-lost-context",
            );
            continue;
          }
        }

        if (entry.killReconciliation) {
          mutated =
            (await reconcileProvisionalSubagentKill({
              runId,
              entry,
              now,
              runs,
              storeCache,
              completeSubagentRunWithRecovery: params.completeSubagentRunWithRecovery,
              retireSupersededRun: params.retireSupersededRun,
              startSubagentAnnounceCleanupFlow: params.startSubagentAnnounceCleanupFlow,
              warn: params.warn,
            })) || mutated;
          continue;
        }
        if (entry.collect && entry.collectorCompletion) {
          if (entry.collectorLaunchCleanupPending) {
            try {
              await deleteSession(entry.childSessionKey);
            } catch (error) {
              params.warn("failed to retry collector launch cleanup", {
                runId,
                childSessionKey: entry.childSessionKey,
                error,
              });
              continue;
            }
            if (!(await params.cleanupCollectorLaunchResources(entry))) {
              continue;
            }
            emitSessionLifecycleEvent({
              sessionKey: entry.childSessionKey,
              reason: "delete",
              parentSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
            });
            entry.collectorLaunchCleanupPending = false;
            entry.cleanupCompletedAt = now;
            mutated = true;
          }
          const groupId = entry.groupId?.trim();
          const swarmRequesterSessionKey =
            entry.swarmRequesterSessionKey ?? entry.requesterSessionKey;
          const groupKey = groupId
            ? JSON.stringify([swarmRequesterSessionKey, groupId])
            : undefined;
          if (!groupKey || archivedCollectorGroups.has(groupKey)) {
            continue;
          }
          const groupEntries = [...runs.entries()].filter(
            ([, candidate]) =>
              candidate.collect === true &&
              (candidate.swarmRequesterSessionKey ?? candidate.requesterSessionKey) ===
                swarmRequesterSessionKey &&
              candidate.groupId === groupId,
          );
          if (
            groupEntries.some(
              ([, candidate]) =>
                !candidate.collectorCompletion ||
                candidate.collectorLaunchCleanupPending === true ||
                candidate.archiveAtMs === undefined ||
                candidate.archiveAtMs > now,
            )
          ) {
            continue;
          }
          let deleteFailed = false;
          for (const [candidateRunId, candidate] of groupEntries) {
            try {
              await deleteSession(candidate.childSessionKey);
            } catch (error) {
              params.warn("sessions.delete failed during collector group sweep; keeping group", {
                runId: candidateRunId,
                childSessionKey: candidate.childSessionKey,
                groupId,
                error,
              });
              deleteFailed = true;
              break;
            }
          }
          if (deleteFailed) {
            continue;
          }
          let attachmentCleanupFailed = false;
          for (const [candidateRunId, candidate] of groupEntries) {
            if (await safeRemoveAttachmentsDir(candidate)) {
              continue;
            }
            params.warn("attachment cleanup failed during collector group sweep; keeping group", {
              runId: candidateRunId,
              childSessionKey: candidate.childSessionKey,
              groupId,
            });
            attachmentCleanupFailed = true;
            break;
          }
          if (attachmentCleanupFailed) {
            continue;
          }
          let contextCleanupFailed = false;
          for (const [candidateRunId, candidate] of groupEntries) {
            if (
              candidate.cleanup === "delete" ||
              typeof candidate.contextEngineCleanupCompletedAt === "number"
            ) {
              continue;
            }
            try {
              await params.runContextEngineSubagentEnded(sweptContext(candidate));
              candidate.contextEngineCleanupCompletedAt = Date.now();
              params.persist();
            } catch (error) {
              params.warn(
                "context-engine cleanup failed during collector group sweep; keeping group",
                {
                  runId: candidateRunId,
                  childSessionKey: candidate.childSessionKey,
                  groupId,
                  error,
                },
              );
              contextCleanupFailed = true;
              break;
            }
          }
          if (contextCleanupFailed) {
            continue;
          }
          for (const [candidateRunId] of groupEntries) {
            params.clearPendingLifecycleError(candidateRunId);
            runs.delete(candidateRunId);
          }
          archivedCollectorGroups.add(groupKey);
          mutated = true;
          continue;
        }
        if (!entry.archiveAtMs && entry.cleanup === "keep" && entry.spawnMode !== "session") {
          continue;
        }
        if (!entry.archiveAtMs) {
          if (
            typeof entry.cleanupCompletedAt === "number" &&
            now - entry.cleanupCompletedAt > SESSION_RUN_TTL_MS
          ) {
            params.clearPendingLifecycleError(runId);
            runCleanupTail(runId, "context-engine cleanup", async () => {
              await params.notifyContextEngineSubagentEnded(sweptContext(entry));
            });
            runs.delete(runId);
            mutated = true;
            if (!entry.retainAttachmentsOnKeep) {
              await safeRemoveAttachmentsDir(entry);
            }
          }
          continue;
        }
        if (entry.archiveAtMs > now) {
          continue;
        }
        params.clearPendingLifecycleError(runId);
        try {
          await deleteSession(entry.childSessionKey);
        } catch (error) {
          params.warn("sessions.delete failed during subagent sweep; keeping run for retry", {
            runId,
            childSessionKey: entry.childSessionKey,
            error,
          });
          continue;
        }
        runs.delete(runId);
        mutated = true;
        await safeRemoveAttachmentsDir(entry);
        runCleanupTail(runId, "context-engine cleanup", async () => {
          await params.notifyContextEngineSubagentEnded(sweptContext(entry));
        });
      }
      params.sweepPendingLifecycle(now);

      if (mutated) {
        params.persist();
      }
      if (runs.size === 0) {
        stop();
      }
    } finally {
      sweepInProgress = false;
    }
  }

  return {
    start,
    stop,
    sweepOnce,
    runTick,
    reset() {
      stop();
      sweepInProgress = false;
    },
  };
}
