import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  type InternalSessionEntry as SessionEntry,
  resolveSessionWorkStartError,
} from "../config/sessions.js";
import {
  listSessionEntriesByStatus,
  loadExactSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { readSessionMessagesAsync } from "../gateway/session-transcript-readers.js";
import { resolveGatewaySessionStoreTarget } from "../gateway/session-utils.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { resolveDefaultAgentId } from "./agent-scope-config.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "./embedded-agent-runner/run-state.js";
import { isMainRestartRecoveryCandidate } from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import {
  loadExpectedRestartRecoveryClaim,
  type ExpectedRestartRecoveryClaim,
} from "./main-session-restart-claim.js";
import {
  hasRestartRecoveryMessageActionAuthority,
  requiresRestartRecoveryMessageActionAuthority,
  resolveRestartRecoveryResumeBlockReason,
  resumeMainSession,
} from "./main-session-restart-dispatch.js";
import {
  hasCompletionReportUserTail,
  hasOnlyAnnounceRecoveryRuns,
  markSessionCompletedAfterRecoveryCheckpoint,
  reconcileInterruptedCompletionReport,
} from "./main-session-restart-recovery-checkpoint.js";
import { tombstoneMainRestartRecoveryWithNotice } from "./main-session-restart-recovery-failure.js";
import { failUnresumableMainSession } from "./main-session-restart-recovery-notice.js";
import {
  hasReplaySafeCodeModeCheckpointInCurrentTurn,
  resolveMainSessionResumePolicy,
} from "./main-session-restart-recovery-resume-policy.js";
import {
  type ExhaustedRestartRecoveryTarget,
  type ExpectedRestartRecoveryTarget,
  hasCurrentProcessOwner,
  log,
  MAX_RECOVERY_RETRIES,
  normalizeStringSet,
  shouldSkipMainRecovery,
} from "./main-session-restart-recovery-shared.js";

export function loadExpectedRestartRecoveryTarget(params: {
  expected: ExpectedRestartRecoveryTarget;
  storePath: string;
}): SessionEntry | undefined {
  const exact = loadExactSessionEntry({
    sessionKey: params.expected.sessionKey,
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

function resolveRecoveryDispatchSessionKey(params: {
  cfg?: OpenClawConfig;
  sessionKey: string;
  storePath: string;
}): string | undefined {
  if (!params.cfg) {
    return params.sessionKey;
  }
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.sessionKey,
    });
    return !params.cfg.session?.store ||
      path.resolve(target.storePath) === path.resolve(params.storePath)
      ? target.canonicalKey
      : undefined;
  } catch (err) {
    log.warn(`failed to resolve recovery store for ${params.sessionKey}: ${String(err)}`);
    return undefined;
  }
}

export async function recoverStore(params: {
  cfg?: OpenClawConfig;
  observationOnly?: boolean;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  storePath: string;
  resumedSessionKeys: Set<string>;
  expectedClaim?: ExpectedRestartRecoveryClaim;
  expectedTarget?: ExpectedRestartRecoveryTarget;
  sessionWorkAdmissionHandoffId?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const shouldContinue = () => params.shouldContinue?.() !== false;
  const resumeIfCurrent = async (resumeParams: Parameters<typeof resumeMainSession>[0]) => {
    if (!shouldContinue()) {
      return "skipped" as const;
    }
    return await resumeMainSession({
      ...resumeParams,
      lifecycleGeneration: params.lifecycleGeneration,
      shouldContinue: params.shouldContinue,
    });
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
      entries = listSessionEntriesByStatus({ storePath: params.storePath }, ["running"]);
    }
  } catch (err) {
    log.warn(`failed to load session store ${params.storePath}: ${String(err)}`);
    result.failed++;
    return result;
  }

  for (const { sessionKey, entry: loadedEntry } of entries.toSorted((a, b) =>
    a.sessionKey.localeCompare(b.sessionKey),
  )) {
    if (!shouldContinue()) {
      result.skipped++;
      return result;
    }
    let entry = loadedEntry;
    const agentId = resolveAgentIdFromSessionKey(
      sessionKey,
      params.cfg ? resolveDefaultAgentId(params.cfg) : undefined,
    );
    if (!entry || entry.status !== "running" || entry.abortedLastRun !== true) {
      continue;
    }
    if (shouldSkipMainRecovery(entry, sessionKey)) {
      result.skipped++;
      continue;
    }
    if (resolveSessionWorkStartError(sessionKey, entry)) {
      result.skipped++;
      continue;
    }
    const resolvedDispatchSessionKey = resolveRecoveryDispatchSessionKey({
      cfg: params.cfg,
      sessionKey,
      storePath: params.storePath,
    });
    if (!resolvedDispatchSessionKey) {
      result.skipped++;
      continue;
    }
    const dispatchSessionKey =
      params.expectedClaim?.canonicalSessionKey ??
      params.expectedTarget?.canonicalSessionKey ??
      resolvedDispatchSessionKey;
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
    const resumeDedupeKey = sessionKey;
    if (params.resumedSessionKeys.has(resumeDedupeKey)) {
      result.skipped++;
      continue;
    }

    if (!shouldContinue()) {
      result.skipped++;
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
      target: { sessionKey, storePath: params.storePath },
    });
    if (!observed.entry || observed.transition.kind !== "observed") {
      result.skipped++;
      continue;
    }
    if (!shouldContinue()) {
      result.skipped++;
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
      if (!shouldContinue()) {
        result.skipped++;
        return result;
      }
      const tombstone = await tombstoneMainRestartRecoveryWithNotice({
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason: recoveryView.reason,
        sessionKey,
        storePath: params.storePath,
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
      if (resumeResult === "resumed") {
        params.resumedSessionKeys.add(resumeDedupeKey);
        result.recovered++;
      } else if (resumeResult === "skipped") {
        result.skipped++;
      } else {
        result.failed++;
        const current = loadExpectedRestartRecoveryTarget({
          expected: { sessionId: entry.sessionId, sessionKey },
          storePath: params.storePath,
        });
        if (
          current?.mainRestartRecovery?.chargedAttempts === MAX_RECOVERY_RETRIES &&
          !current.mainRestartRecovery.reservation
        ) {
          params.onExhaustedTarget?.({
            canonicalSessionKey: dispatchSessionKey,
            sessionId: entry.sessionId,
            sessionKey,
            storePath: params.storePath,
          });
        }
      }
    };

    if (
      requiresRestartRecoveryMessageActionAuthority(entry) &&
      !hasRestartRecoveryMessageActionAuthority(entry)
    ) {
      if (!shouldContinue()) {
        result.skipped++;
        return result;
      }
      const disposition = await failUnresumableMainSession({
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason: "message-tool-only recovery authority is unavailable",
        sessionKey,
        storePath: params.storePath,
      });
      result[disposition]++;
      continue;
    }

    const expectedRecoverySourceRunId = normalizeOptionalString(
      entry.restartRecoveryDeliverySourceRunId,
    );
    let resumeBlockReason: string | undefined;
    let resumeSafetyResolved = false;
    const failBlockedResume = async (): Promise<boolean> => {
      if (!resumeSafetyResolved) {
        resumeSafetyResolved = true;
        resumeBlockReason = resolveRestartRecoveryResumeBlockReason({
          cfg: params.cfg,
          entry,
          sessionKey,
        });
      }
      if (!resumeBlockReason) {
        return false;
      }
      if (!shouldContinue()) {
        return true;
      }
      const disposition = await failUnresumableMainSession({
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason: resumeBlockReason,
        sessionKey,
        storePath: params.storePath,
      });
      result[disposition]++;
      return true;
    };

    if (
      entry.pendingFinalDelivery?.kind === "replayable" &&
      entry.restartRecoveryForceSafeTools === true
    ) {
      if (await failBlockedResume()) {
        continue;
      }
      const resumed = await resumeIfCurrent({
        canonicalSessionKey: dispatchSessionKey,
        cfg: params.cfg,
        entry,
        observation: recoveryView.observation,
        recoveryAttempt: recoveryView.nextAttempt,
        storePath: params.storePath,
        sessionKey,
        pendingFinalDeliveryText: entry.pendingFinalDelivery.text,
        forceRestartSafeTools: true,
        sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
        gatewayRuntime: params.gatewayRuntime,
      });
      recordResumeResult(resumed);
      continue;
    }

    let messages: unknown[];
    try {
      messages = await readSessionMessagesAsync(
        {
          agentId,
          sessionEntry: entry,
          sessionId: entry.sessionId,
          sessionKey,
          storePath: params.storePath,
        },
        {
          mode: "recent",
          maxMessages: 20,
          maxBytes: 256 * 1024,
        },
      );
    } catch (err) {
      if (!shouldContinue()) {
        result.skipped++;
        return result;
      }
      if (entry.pendingFinalDelivery?.kind === "replayable") {
        if (await failBlockedResume()) {
          continue;
        }
        log.warn(
          `transcript unavailable for ${sessionKey}; resuming its durable pending final delivery`,
        );
        const resumed = await resumeIfCurrent({
          canonicalSessionKey: dispatchSessionKey,
          cfg: params.cfg,
          entry,
          observation: recoveryView.observation,
          recoveryAttempt: recoveryView.nextAttempt,
          storePath: params.storePath,
          sessionKey,
          pendingFinalDeliveryText: entry.pendingFinalDelivery.text,
          sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
          gatewayRuntime: params.gatewayRuntime,
        });
        recordResumeResult(resumed);
        continue;
      }
      log.warn(`failed to read transcript for ${sessionKey}: ${String(err)}`);
      result.failed++;
      continue;
    }

    if (!shouldContinue()) {
      result.skipped++;
      return result;
    }
    if (entry.pendingFinalDelivery?.kind === "replayable") {
      if (await failBlockedResume()) {
        continue;
      }
      const resumed = await resumeIfCurrent({
        canonicalSessionKey: dispatchSessionKey,
        cfg: params.cfg,
        entry,
        observation: recoveryView.observation,
        recoveryAttempt: recoveryView.nextAttempt,
        storePath: params.storePath,
        sessionKey,
        pendingFinalDeliveryText: entry.pendingFinalDelivery.text,
        forceRestartSafeTools: hasReplaySafeCodeModeCheckpointInCurrentTurn(messages),
        sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
        gatewayRuntime: params.gatewayRuntime,
      });
      recordResumeResult(resumed);
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
      if (!shouldContinue()) {
        result.skipped++;
        return result;
      }
      const reconciliation = await reconcileInterruptedCompletionReport({
        entry,
        source: completionSource,
        storePath: params.storePath,
        sessionKey,
      });
      if (reconciliation.outcome === "reconciled") {
        params.resumedSessionKeys.add(resumeDedupeKey);
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

    const resumePolicy = resolveMainSessionResumePolicy(
      messages,
      entry.restartRecoveryForceSafeTools === true,
      expectedRecoverySourceRunId,
      entry.restartRecoveryBeforeAgentReplyState,
      entry.restartRecoveryDeliveryReceiptState,
      entry.restartRecoveryDeliveryToolCallId,
    );
    if (resumePolicy.action === "complete") {
      if (!shouldContinue()) {
        result.skipped++;
        return result;
      }
      const completion = await markSessionCompletedAfterRecoveryCheckpoint({
        agentId,
        entry,
        messages,
        reason: resumePolicy.reason,
        storePath: params.storePath,
        sessionKey,
        sourceTurnId: expectedRecoverySourceRunId,
        ...(resumePolicy.reason === "handled-silent"
          ? {}
          : {
              toolCallId: resumePolicy.toolCallId,
            }),
      });
      if (completion.outcome === "completed") {
        params.resumedSessionKeys.add(resumeDedupeKey);
        result.recovered++;
      } else if (completion.outcome === "changed") {
        result.skipped++;
      } else {
        if (!shouldContinue()) {
          result.skipped++;
          return result;
        }
        const disposition = await failUnresumableMainSession({
          cfg: params.cfg,
          entry,
          gatewayRuntime: params.gatewayRuntime,
          observation: recoveryView.observation,
          reason: completion.reason,
          sessionKey,
          storePath: params.storePath,
        });
        result[disposition]++;
      }
      continue;
    }
    if (resumePolicy.action === "fail") {
      if (!shouldContinue()) {
        result.skipped++;
        return result;
      }
      const disposition = await failUnresumableMainSession({
        cfg: params.cfg,
        entry,
        gatewayRuntime: params.gatewayRuntime,
        observation: recoveryView.observation,
        reason: resumePolicy.reason,
        sessionKey,
        storePath: params.storePath,
      });
      result[disposition]++;
      continue;
    }

    if (await failBlockedResume()) {
      continue;
    }
    const resumed = await resumeIfCurrent({
      canonicalSessionKey: dispatchSessionKey,
      cfg: params.cfg,
      entry,
      observation: recoveryView.observation,
      recoveryAttempt: recoveryView.nextAttempt,
      storePath: params.storePath,
      sessionKey,
      forceRestartSafeTools:
        entry.restartRecoveryForceSafeTools === true || resumePolicy.forceRestartSafeTools,
      forceCodeModeTools: resumePolicy.forceCodeModeTools === true,
      sessionWorkAdmissionHandoffId: params.sessionWorkAdmissionHandoffId,
      gatewayRuntime: params.gatewayRuntime,
    });
    recordResumeResult(resumed);
  }

  return result;
}
