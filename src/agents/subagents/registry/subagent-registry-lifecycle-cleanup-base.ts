import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import {
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { retireSessionMcpRuntimeForSessionKey } from "../../agent-bundle-mcp-tools.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryLastError,
} from "./subagent-delivery-state.js";
import { logAnnounceGiveUp, MIN_ANNOUNCE_RETRY_DELAY_MS } from "./subagent-registry-helpers.js";
import type { createSubagentRegistryLifecycleCommon } from "./subagent-registry-lifecycle-common.js";
import type {
  SubagentRegistryLifecycleParams,
  SubagentRegistryLifecycleState,
} from "./subagent-registry-lifecycle-contracts.js";
import type { createSubagentRegistryLifecycleDelivery } from "./subagent-registry-lifecycle-delivery.js";
import type { createSubagentRegistryLifecycleRequesterWake } from "./subagent-registry-lifecycle-requester-wake.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function createSubagentRegistryLifecycleCleanupBase(
  params: SubagentRegistryLifecycleParams,
  state: SubagentRegistryLifecycleState,
  common: ReturnType<typeof createSubagentRegistryLifecycleCommon>,
  deliveryHelpers: ReturnType<typeof createSubagentRegistryLifecycleDelivery>,
  requesterWake: ReturnType<typeof createSubagentRegistryLifecycleRequesterWake>,
) {
  const { scheduledResumeTimers, cleanupGenerations, terminalGenerations } = state;
  const { buildSafeLifecycleErrorMeta, maskRunId, maskSessionKey, newerGenerationOwnsSession } =
    common;
  const {
    markPendingFinalDelivery,
    safeMarkRequiredCompletionDeliveryBlocked,
    safeSetSubagentTaskDeliveryStatus,
  } = deliveryHelpers;
  const { markRequesterSettleWakePending, scheduleRequesterSettleWake } = requesterWake;

  const scheduleResumeSubagentRun = (
    runId: string,
    entry: SubagentRunRecord,
    delayMs: number,
    cleanupGeneration?: number,
  ) => {
    const timer = setTimeout(() => {
      scheduledResumeTimers.delete(timer);
      void runWithGatewayIndependentRootWorkAdmission(async () => {
        if (params.runs.get(runId) !== entry) {
          return;
        }
        if (cleanupGeneration !== undefined) {
          if (!isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
            return;
          }
          entry.cleanupHandled = false;
          params.persist(runId);
        }
        params.resumedRuns.delete(runId);
        params.resumeSubagentRun(runId);
      }).catch((err: unknown) => {
        defaultRuntime.log(`[warn] subagent cleanup resume failed (${runId}): ${String(err)}`);
        const current = params.runs.get(runId);
        if (
          isGatewayRestartDraining() &&
          current === entry &&
          typeof current.cleanupCompletedAt !== "number"
        ) {
          scheduleResumeSubagentRun(
            runId,
            entry,
            Math.max(delayMs, MIN_ANNOUNCE_RETRY_DELAY_MS),
            cleanupGeneration,
          );
        }
      });
    }, delayMs);
    timer.unref?.();
    scheduledResumeTimers.add(timer);
  };

  const runDetachedCleanupAttempt = (args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanupGeneration: number;
    run: () => Promise<void>;
  }) => {
    // Completion makes the task projection non-blocking before delivery and
    // cleanup finish. This independent lease bridges that handoff and owns the
    // full detached attempt, including its final durable registry write.
    // Completion outlives the spawning attempt; inherited lock owners would
    // reject requester transcript writes after that attempt is disposed.
    runWithoutOwnedSessionTranscriptWrites(() => {
      void runWithGatewayIndependentRootWorkAdmission(async () => {
        try {
          await args.run();
        } catch (err) {
          defaultRuntime.log(
            `[warn] subagent cleanup finalize failed (${args.runId}): ${String(err)}`,
          );
          const current = params.runs.get(args.runId);
          if (
            !current ||
            current.cleanupCompletedAt ||
            !isCleanupAttemptCurrent(args.runId, args.entry, args.cleanupGeneration)
          ) {
            return;
          }
          current.cleanupHandled = false;
          params.resumedRuns.delete(args.runId);
          params.persist(args.runId);
        }
      }).catch((err: unknown) => {
        defaultRuntime.log(
          `[warn] subagent cleanup admission failed (${args.runId}): ${String(err)}`,
        );
        if (isGatewayRestartDraining()) {
          scheduleResumeSubagentRun(
            args.runId,
            args.entry,
            MIN_ANNOUNCE_RETRY_DELAY_MS,
            args.cleanupGeneration,
          );
        }
      });
    });
  };

  const suspendPendingFinalDelivery = (args: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "expiry" | "permanent_failure";
    error?: string;
  }) => {
    const previousEntry = structuredClone(args.entry);
    markPendingFinalDelivery({
      entry: args.entry,
      error: args.error ?? getDeliveryLastError(args.entry) ?? args.reason,
    });
    const now = Date.now();
    const delivery = ensureDeliveryState(args.entry);
    delivery.status = "suspended";
    delivery.suspendedAt ??= now;
    delivery.suspendedReason = args.reason;
    args.entry.cleanupHandled = false;
    args.entry.wakeOnDescendantSettle = undefined;
    const completion = ensureCompletionState(args.entry);
    completion.fallbackResultText = undefined;
    completion.fallbackCapturedAt = undefined;
    params.resumedRuns.delete(args.runId);
    safeSetSubagentTaskDeliveryStatus({
      entry: args.entry,
      deliveryStatus: "failed",
      deliveryError: getDeliveryLastError(args.entry) ?? args.reason,
    });
    safeMarkRequiredCompletionDeliveryBlocked({
      entry: args.entry,
      reason: getDeliveryLastError(args.entry) ?? args.reason,
    });
    logAnnounceGiveUp(args.entry, args.reason);
    markRequesterSettleWakePending(args.entry);
    try {
      params.persistOrThrow(args.runId);
    } catch (error) {
      const mutableEntry = args.entry as unknown as Record<string, unknown>;
      for (const key of Object.keys(mutableEntry)) {
        delete mutableEntry[key];
      }
      Object.assign(args.entry, previousEntry);
      throw error;
    }
    // Suspension is terminal for automatic retries, so it settles this child
    // for requester-drain purposes even though cleanup stays incomplete.
    scheduleRequesterSettleWake(args.runId, args.entry);
  };

  const beginSubagentCleanup = (runId: string) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return false;
    }
    if (entry.cleanupCompletedAt || entry.cleanupHandled) {
      return false;
    }
    entry.cleanupHandled = true;
    cleanupGenerations.set(entry, (cleanupGenerations.get(entry) ?? 0) + 1);
    params.persist(runId);
    return true;
  };

  const isCleanupAttemptCurrent = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): boolean =>
    params.runs.get(runId) === entry &&
    entry.cleanupHandled === true &&
    entry.pauseReason !== "sessions_yield" &&
    cleanupGenerations.get(entry) === generation &&
    !newerGenerationOwnsSession(entry);

  const retireSupersededCleanupIfNeeded = async (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): Promise<boolean> => {
    if (
      params.runs.get(runId) !== entry ||
      cleanupGenerations.get(entry) !== generation ||
      !newerGenerationOwnsSession(entry)
    ) {
      return false;
    }
    // Cleanup can yield to attachment, mirror, or announce work. A successor
    // registered while it was suspended owns every session-scoped side effect.
    await params.retireSupersededRun(runId, entry);
    return true;
  };

  const retireSupersededCleanupInBackground = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ) => {
    // Delivery callbacks are synchronous and may arrive after their announce
    // attempt returns. Give the async retirement tail its own snapshot blocker.
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      await retireSupersededCleanupIfNeeded(runId, entry, generation);
    }).catch((error: unknown) => {
      defaultRuntime.log(
        `[warn] subagent superseded cleanup retirement failed (${runId}): ${String(error)}`,
      );
    });
  };

  const isTerminalCallbackCurrent = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): boolean =>
    params.runs.get(runId) === entry &&
    entry.pauseReason !== "sessions_yield" &&
    terminalGenerations.get(entry) === generation;

  const isEndedHookOwnerCurrent = (runId: string, entry: SubagentRunRecord): boolean => {
    const current = params.runs.get(runId);
    return (current === undefined || current === entry) && !newerGenerationOwnsSession(entry);
  };

  const retireRunModeBundleMcpRuntime = async (cleanupParams: {
    runId: string;
    entry: SubagentRunRecord;
    reason: string;
  }) => {
    if (cleanupParams.entry.spawnMode === "session") {
      return;
    }
    await retireSessionMcpRuntimeForSessionKey({
      sessionKey: cleanupParams.entry.childSessionKey,
      reason: cleanupParams.reason,
      preserveActiveLeases: true,
      onError: (error, sessionId) => {
        params.warn("failed to retire subagent bundle MCP runtime", {
          error: buildSafeLifecycleErrorMeta(error),
          sessionId,
          runId: maskRunId(cleanupParams.runId),
          childSessionKey: maskSessionKey(cleanupParams.entry.childSessionKey),
        });
      },
    });
  };

  return {
    beginSubagentCleanup,
    isCleanupAttemptCurrent,
    isEndedHookOwnerCurrent,
    isTerminalCallbackCurrent,
    retireSupersededCleanupIfNeeded,
    retireRunModeBundleMcpRuntime,
    retireSupersededCleanupInBackground,
    runDetachedCleanupAttempt,
    scheduleResumeSubagentRun,
    suspendPendingFinalDelivery,
  };
}
