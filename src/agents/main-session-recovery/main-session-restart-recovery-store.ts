import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  type InternalSessionEntry as SessionEntry,
  resolveSessionWorkStartError,
} from "../../config/sessions.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import {
  listSessionEntriesByStatus,
  loadExactSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { findDeliveryIntentOwner } from "../../infra/outbound/delivery-queue-storage.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "../embedded-agent-runner/active-run-projections.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import {
  getMainSessionRecoveryRetryCount,
  isMainRestartRecoveryAggregateTerminalOnly,
  isMainRestartRecoveryCandidate,
} from "./main-session-recovery-state.js";
import {
  commitMainSessionRecovery,
  type MainSessionRecoveryStoreTarget,
} from "./main-session-recovery-store.js";
import {
  hasRestartRecoveryMessageActionAuthority,
  requiresRestartRecoveryMessageActionAuthority,
  resumeMainSession,
} from "./main-session-restart-dispatch.js";
import {
  hasCompletionReportUserTail,
  hasOnlyAnnounceRecoveryRuns,
  markSessionCompletedAfterRecoveryCheckpoint,
  reconcileInterruptedCompletionReport,
} from "./main-session-restart-recovery-checkpoint.js";
import { tombstoneMainRestartRecoveryWithNotice } from "./main-session-restart-recovery-failure.js";
import { readMainSessionReplaySafeCheckpoint } from "./main-session-restart-recovery-replay-safety.js";
import {
  hasReplaySafeCodeModeCheckpointInCurrentTurn,
  resolveMainSessionResumePolicy,
} from "./main-session-restart-recovery-resume-policy.js";
import {
  type ExhaustedRestartRecoveryTarget,
  type ExpectedRestartRecoveryTarget,
  hasCurrentProcessOwner,
  mainSessionRecoveryLog,
  MAX_RECOVERY_RETRIES,
  normalizeStringSet,
  resolveRestartRecoveryTerminalClientRunId,
} from "./main-session-restart-recovery-shared.js";
import { resolveRestartRecoveryDispatchTarget } from "./main-session-restart-recovery-target.js";

function pendingFinalRecoveryAction(
  pending: NonNullable<SessionEntry["pendingFinalDelivery"]>,
  stateDir?: string,
): "complete" | "defer" | "fail" | "notice" | "retry" {
  const deliveries = pending.deliveries;
  if (!deliveries?.length) {
    return "fail";
  }
  if (deliveries.every(({ state }) => state === "delivered" || state === "suppressed")) {
    return "complete";
  }
  const owners = deliveries.map(({ id }) => findDeliveryIntentOwner(id, stateDir));
  if (owners.some((owner) => owner?.status === "pending" || owner?.settlementPending)) {
    return "defer";
  }
  if (
    pending.kind === "replayable" &&
    deliveries.every(({ state }) => state === "prepared") &&
    owners.every((owner) => owner === null)
  ) {
    return "retry";
  }
  // Residual ambiguity (unknown custody, settled owners, unreplayable mixes):
  // complete the session and record durable notice debt instead of failing it.
  // A fire-and-forget failure notice is lost during the very outage that made
  // the outcome ambiguous; the debt survives until the next same-route turn.
  // Records without notice identity cannot carry debt, so they keep the
  // visible fail path instead of completing silently.
  return pending.context && pending.intentId ? "notice" : "fail";
}

async function completePendingFinalRecoveryWithNotice(
  entry: SessionEntry,
  target: MainSessionRecoveryStoreTarget,
): Promise<boolean> {
  const endedAt = Date.now();
  let completed = false;
  await updateSessionEntry(
    target,
    (current) => {
      if (
        current.sessionId !== entry.sessionId ||
        current.pendingFinalDelivery?.intentId !== entry.pendingFinalDelivery?.intentId
      ) {
        return null;
      }
      const pending = current.pendingFinalDelivery;
      completed = true;
      return {
        ...buildRestartRecoveryClaimCleanupPatch({
          entry: current,
          recordTerminalSource: true,
        }),
        abortedLastRun: false,
        endedAt,
        lifecycleRunId: undefined,
        lastRunId: resolveRestartRecoveryTerminalClientRunId(current),
        pendingFinalDelivery: undefined,
        ...(pending?.context &&
        pending.intentId &&
        current.pendingDeliveryNotice?.intentId !== pending.intentId &&
        (!current.pendingDeliveryNotice ||
          current.pendingDeliveryNotice.createdAt <= pending.createdAt)
          ? {
              pendingDeliveryNotice: {
                createdAt: pending.createdAt,
                context: pending.context,
                intentId: pending.intentId,
                state: "owed" as const,
              },
            }
          : {}),
        restartRecoveryRuns: undefined,
        runtimeMs:
          typeof current.startedAt === "number"
            ? Math.max(0, endedAt - current.startedAt)
            : undefined,
        status: "done" as const,
        updatedAt: endedAt,
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  return completed;
}

export type ExpectedRestartRecoveryClaim = ExpectedRestartRecoveryTarget & {
  recoveryRunId: string;
  recoverySourceRunId: string;
};

export function loadExpectedRestartRecoveryClaim(params: {
  expected: ExpectedRestartRecoveryClaim;
  storePath: string;
}): SessionEntry | undefined {
  const exact = loadExactSessionEntry({
    ...params.expected,
    readConsistency: "latest",
    storePath: params.storePath,
  });
  const entry = exact?.sessionKey === params.expected.sessionKey ? exact.entry : undefined;
  return entry?.sessionId === params.expected.sessionId &&
    entry.status === "running" &&
    entry.abortedLastRun === true &&
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === params.expected.recoveryRunId &&
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ===
      params.expected.recoverySourceRunId
    ? entry
    : undefined;
}

export function loadExpectedRestartRecoveryTarget(params: {
  expected: ExpectedRestartRecoveryTarget;
  storePath: string;
}): SessionEntry | undefined {
  const exact = loadExactSessionEntry({
    ...params.expected,
    storePath: params.storePath,
    readConsistency: "latest",
  });
  const entry = exact?.sessionKey === params.expected.sessionKey ? exact.entry : undefined;
  return entry?.sessionId === params.expected.sessionId &&
    entry.status === "running" &&
    entry.abortedLastRun === true &&
    isMainRestartRecoveryCandidate(entry, params.expected.sessionKey)
    ? entry
    : undefined;
}

export async function recoverStore(params: {
  storeAgentId?: string;
  cfg?: OpenClawConfig;
  observationOnly?: boolean;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  storePath: string;
  stateDir?: string;
  handledSessionKeys: Set<string>;
  expectedClaim?: ExpectedRestartRecoveryClaim;
  expectedTarget?: ExpectedRestartRecoveryTarget;
  sessionWorkAdmissionHandoffId?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ started: number; settled: number; failed: number; skipped: number }> {
  const result = { started: 0, settled: 0, failed: 0, skipped: 0 };
  const shouldContinue = () => params.shouldContinue?.() !== false;
  const stopped = () => {
    if (shouldContinue()) {
      return false;
    }
    result.skipped++;
    return true;
  };
  const providedActiveSessionIds =
    params.activeSessionIds === undefined ? undefined : normalizeStringSet(params.activeSessionIds);
  const providedActiveSessionKeys =
    params.activeSessionKeys === undefined
      ? undefined
      : normalizeStringSet(params.activeSessionKeys);
  const resolveActiveSessionIds = () =>
    providedActiveSessionIds ?? normalizeStringSet(listActiveEmbeddedRunSessionIds());
  const resolveActiveSessionKeys = () =>
    providedActiveSessionKeys ?? normalizeStringSet(listActiveEmbeddedRunSessionKeys());
  let entries: Array<{ sessionKey: string; entry: SessionEntry }>;
  try {
    if (params.expectedClaim) {
      const entry = loadExpectedRestartRecoveryClaim({
        expected: params.expectedClaim,
        storePath: params.storePath,
      });
      entries = entry ? [{ sessionKey: params.expectedClaim.sessionKey, entry }] : [];
    } else if (params.expectedTarget) {
      const entry = loadExpectedRestartRecoveryTarget({
        expected: params.expectedTarget,
        storePath: params.storePath,
      });
      entries = entry ? [{ sessionKey: params.expectedTarget.sessionKey, entry }] : [];
    } else {
      entries = listSessionEntriesByStatus(
        { agentId: params.storeAgentId, storePath: params.storePath },
        ["running"],
      );
    }
  } catch (err) {
    mainSessionRecoveryLog.warn(`failed to load session store ${params.storePath}: ${String(err)}`);
    result.failed++;
    return result;
  }

  for (const { sessionKey, entry: loadedEntry } of entries.toSorted((a, b) =>
    a.sessionKey.localeCompare(b.sessionKey),
  )) {
    if (stopped()) {
      return result;
    }
    let entry = loadedEntry;
    const hasRecoveryStateToObserve =
      entry?.abortedLastRun === true ||
      (entry !== undefined && isMainRestartRecoveryAggregateTerminalOnly(entry));
    if (!entry || entry.status !== "running" || !hasRecoveryStateToObserve) {
      continue;
    }
    if (!isMainRestartRecoveryCandidate(entry, sessionKey)) {
      result.skipped++;
      continue;
    }
    if (resolveSessionWorkStartError(sessionKey, entry)) {
      result.skipped++;
      continue;
    }
    const dispatchTarget = resolveRestartRecoveryDispatchTarget({
      agentId: (params.expectedClaim ?? params.expectedTarget)?.agentId,
      storeAgentId: params.storeAgentId,
      cfg: params.cfg,
      sessionKey,
      storePath: params.storePath,
    });
    if (!dispatchTarget) {
      result.skipped++;
      continue;
    }
    const agentId = dispatchTarget.agentId;
    const target = { agentId, sessionKey, storePath: params.storePath };
    const dispatchSessionKey =
      params.expectedClaim?.canonicalSessionKey ??
      params.expectedTarget?.canonicalSessionKey ??
      dispatchTarget.sessionKey;
    if (
      hasCurrentProcessOwner({
        activeSessionIds: resolveActiveSessionIds(),
        activeSessionKeys: resolveActiveSessionKeys(),
        entry,
        sessionKey,
      })
    ) {
      result.skipped++;
      continue;
    }
    const resumeDedupeKey = JSON.stringify([agentId, dispatchSessionKey]);
    if (params.handledSessionKeys.has(resumeDedupeKey)) {
      result.skipped++;
      continue;
    }

    if (stopped()) {
      return result;
    }
    const observed = await commitMainSessionRecovery({
      command: {
        kind: "observe",
        cycleId: randomUUID(),
        lifecycleGeneration: params.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
        sessionKey,
      },
      requireWriteSuccess: true,
      shouldContinue: params.shouldContinue,
      target,
    });
    if (!observed.entry || observed.transition.kind !== "observed") {
      result.skipped++;
      continue;
    }
    if (stopped()) {
      return result;
    }
    entry = observed.entry;
    const recoveryView = observed.transition.view;
    if (
      recoveryView.status === "inactive" ||
      recoveryView.status === "blocked" ||
      recoveryView.status === "tombstoned"
    ) {
      result.skipped++;
      continue;
    }
    if (recoveryView.status === "exhausted") {
      if (stopped()) {
        return result;
      }
      const tombstone = await tombstoneMainRestartRecoveryWithNotice({
        ...target,
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason: recoveryView.reason,
      });
      if (tombstone === "notice_failed") {
        result.failed++;
      } else {
        result.skipped++;
      }
      continue;
    }
    if (params.observationOnly) {
      result.skipped++;
      continue;
    }
    const recordResumeResult = (resumeResult: Awaited<ReturnType<typeof resumeMainSession>>) => {
      if (resumeResult === "started") {
        params.handledSessionKeys.add(resumeDedupeKey);
        result.started++;
      } else if (resumeResult === "settled") {
        params.handledSessionKeys.add(resumeDedupeKey);
        result.settled++;
      } else if (resumeResult === "skipped") {
        result.skipped++;
      } else {
        result.failed++;
        const current = loadExpectedRestartRecoveryTarget({
          expected: { agentId, sessionId: entry.sessionId, sessionKey },
          storePath: params.storePath,
        });
        if (
          getMainSessionRecoveryRetryCount(current?.mainRestartRecovery) === MAX_RECOVERY_RETRIES &&
          !current?.mainRestartRecovery?.reservation
        ) {
          params.onExhaustedTarget?.({
            ...target,
            canonicalSessionKey: dispatchSessionKey,
            sessionId: entry.sessionId,
          });
        }
      }
    };
    if (
      requiresRestartRecoveryMessageActionAuthority(entry) &&
      !hasRestartRecoveryMessageActionAuthority(entry)
    ) {
      if (stopped()) {
        return result;
      }
      const tombstone = await tombstoneMainRestartRecoveryWithNotice({
        ...target,
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason: "message-tool-only recovery authority is unavailable",
      });
      if (tombstone === "notice_failed") {
        result.failed++;
      } else {
        result.skipped++;
      }
      continue;
    }

    const expectedRecoverySourceRunId = normalizeOptionalString(
      entry.restartRecoveryDeliverySourceRunId,
    );
    const resumeCurrent = async (
      options: Pick<
        Parameters<typeof resumeMainSession>[0],
        "forceCodeModeTools" | "forceRestartSafeTools" | "pendingFinalDeliveryText"
      > = {},
    ) => {
      if (stopped()) {
        return;
      }
      recordResumeResult(
        await resumeMainSession({
          ...target,
          canonicalSessionKey: dispatchSessionKey,
          cfg: params.cfg,
          entry,
          observation: recoveryView.observation,
          recoveryAttempt: recoveryView.nextAttempt,
          sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
          gatewayRuntime: params.gatewayRuntime,
          ...options,
          lifecycleGeneration: params.lifecycleGeneration,
          shouldContinue: params.shouldContinue,
        }),
      );
    };

    const pendingAction = entry.pendingFinalDelivery
      ? pendingFinalRecoveryAction(entry.pendingFinalDelivery, params.stateDir)
      : undefined;
    if (pendingAction === "defer") {
      // The exact durable queue owner is still responsible for settlement.
      // Dispatching a second recovery turn would duplicate that delivery.
      result.skipped++;
      continue;
    }
    if (pendingAction === "complete") {
      const completion = await markSessionCompletedAfterRecoveryCheckpoint({
        ...target,
        entry,
        messages: [],
        pendingFinalDeliveryIntentId: entry.pendingFinalDelivery?.intentId,
        reason: "delivered-terminal-receipt",
      });
      if (completion.outcome === "completed") {
        params.handledSessionKeys.add(resumeDedupeKey);
        result.settled++;
      } else {
        result.skipped++;
      }
      continue;
    }
    if (pendingAction === "notice") {
      const completed = await completePendingFinalRecoveryWithNotice(entry, target);
      result[completed ? "settled" : "skipped"]++;
      continue;
    }
    if (pendingAction === "fail") {
      await resumeCurrent({
        ...(entry.pendingFinalDelivery?.kind === "replayable"
          ? { pendingFinalDeliveryText: entry.pendingFinalDelivery.text }
          : {}),
        forceRestartSafeTools: true,
      });
      continue;
    }

    if (
      entry.pendingFinalDelivery?.kind === "replayable" &&
      entry.restartRecoveryForceSafeTools === true
    ) {
      await resumeCurrent({
        pendingFinalDeliveryText: entry.pendingFinalDelivery.text,
        forceRestartSafeTools: true,
      });
      continue;
    }

    const execPolicy = resolveExecDefaults({
      cfg: params.cfg,
      agentId,
      sessionKey: dispatchSessionKey,
      sessionEntry: entry,
    });
    const fullAccess =
      execPolicy.mode === "full" &&
      execPolicy.security === "full" &&
      execPolicy.ask === "off" &&
      entry.restartRecoveryDeliveryMediaUrls === undefined &&
      entry.restartRecoveryDisableMessageTool !== true &&
      entry.restartRecoverySuppressTextDelivery !== true;
    let replaySafeCheckpoint = false;
    let messages: unknown[];
    try {
      const transcriptScope = {
        ...target,
        sessionEntry: entry,
        sessionId: entry.sessionId,
      };
      messages = await readSessionMessagesAsync(transcriptScope, {
        mode: "recent",
        maxMessages: 20,
        maxBytes: 256 * 1024,
      });
      if (fullAccess && !entry.pendingFinalDelivery) {
        replaySafeCheckpoint = await readMainSessionReplaySafeCheckpoint(transcriptScope);
      }
    } catch (err) {
      if (stopped()) {
        return result;
      }
      if (entry.pendingFinalDelivery?.kind === "replayable") {
        mainSessionRecoveryLog.warn(
          `transcript unavailable for ${sessionKey}; resuming its durable pending final delivery`,
        );
        await resumeCurrent({
          pendingFinalDeliveryText: entry.pendingFinalDelivery.text,
        });
        continue;
      }
      mainSessionRecoveryLog.warn(`failed to read transcript for ${sessionKey}: ${String(err)}`);
      result.failed++;
      continue;
    }

    if (stopped()) {
      return result;
    }
    if (entry.pendingFinalDelivery?.kind === "replayable") {
      await resumeCurrent({
        pendingFinalDeliveryText: entry.pendingFinalDelivery.text,
        forceRestartSafeTools: hasReplaySafeCodeModeCheckpointInCurrentTurn(messages),
      });
      continue;
    }

    // Completion reports are delivery turns, not human work. Same-process
    // rotation retains their announce run ids; a full restart can recover the
    // same fact from the already-persisted user-message provenance.
    const hasRecoveryRuns = Boolean(entry.restartRecoveryRuns?.length);
    const completionSource = hasOnlyAnnounceRecoveryRuns(entry)
      ? "announce_runs"
      : !hasRecoveryRuns && hasCompletionReportUserTail(messages)
        ? "transcript"
        : undefined;
    if (completionSource) {
      if (stopped()) {
        return result;
      }
      const reconciliation = await reconcileInterruptedCompletionReport({
        ...target,
        entry,
        source: completionSource,
      });
      if (reconciliation.outcome === "reconciled") {
        params.handledSessionKeys.add(resumeDedupeKey);
        result.skipped++;
      } else if (
        reconciliation.entry?.status === "running" &&
        reconciliation.entry.abortedLastRun === true
      ) {
        result.failed++;
      } else {
        result.skipped++;
      }
      continue;
    }

    const retainedSafeTools =
      replaySafeCheckpoint || (entry.restartRecoveryForceSafeTools === true && !fullAccess);
    const resumePolicy = resolveMainSessionResumePolicy(
      messages,
      retainedSafeTools,
      expectedRecoverySourceRunId,
      entry.restartRecoveryBeforeAgentReplyState,
      entry.restartRecoveryDeliveryReceiptState,
      entry.restartRecoveryDeliveryToolCallId,
      fullAccess && !retainedSafeTools,
    );
    if (resumePolicy.action === "complete") {
      if (stopped()) {
        return result;
      }
      const completion = await markSessionCompletedAfterRecoveryCheckpoint({
        ...target,
        entry,
        messages,
        reason: resumePolicy.reason,
        sourceTurnId: expectedRecoverySourceRunId,
        ...(resumePolicy.reason === "handled-silent"
          ? {}
          : {
              toolCallId: resumePolicy.toolCallId,
            }),
      });
      if (completion.outcome === "completed") {
        params.handledSessionKeys.add(resumeDedupeKey);
        result.settled++;
      } else if (completion.outcome === "changed") {
        result.skipped++;
      } else {
        await resumeCurrent({ forceRestartSafeTools: true });
      }
      continue;
    }

    await resumeCurrent({
      forceRestartSafeTools: retainedSafeTools || resumePolicy.forceRestartSafeTools,
      forceCodeModeTools: resumePolicy.forceCodeModeTools === true,
    });
  }

  return result;
}
