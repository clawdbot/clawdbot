import { spawnSubagentDirect } from "../../agents/subagents/spawn/subagent-spawn.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  emitContinuationDisabledSpan,
  resolveContinuationTraceparent,
  startContinuationDelegateSpan,
} from "../../infra/continuation-tracer.js";
import { generateChainId } from "../../infra/secure-random.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveLiveContinuationRuntimeConfig } from "../continuation/config.js";
import { stagePostCompactionDelegate } from "../continuation/delegate-store-post-compaction.js";
import { enqueuePendingDelegate, pendingDelegateCount } from "../continuation/delegate-store.js";
import type { ContinuationSignalExtraction } from "../continuation/signal.js";
import { hasCrossSessionDelegateTargeting } from "../continuation/targeting-pure.js";
import type { ChainState, ContinueWorkRequest } from "../continuation/types.js";
import { emitBracketContinuationRejected } from "./agent-runner-continuation-diag.js";
import type {
  PersistContinuationChainStateParams,
  ReplyContinuationController,
} from "./agent-runner-continuation.js";
import type { FollowupRun } from "./queue.js";

function formatDelegateEchoForSystemEvent(value: string): string {
  return value;
}

type ContinuationUsage = { input?: number; output?: number } | undefined;

// Ports the monolith's continuation-signal handling (CONTINUE_WORK /
// CONTINUE_DELEGATE bracket + tool forms). Split out of
// agent-runner-continuation-schedule.ts to keep each module within the
// max-lines budget. Behavior/order is identical to the monolith.
export async function handleContinuationSignal(context: {
  cfg: Parameters<typeof resolveLiveContinuationRuntimeConfig>[0];
  sessionKey: string | undefined;
  followupRun: FollowupRun;
  runId: string;
  usage: ContinuationUsage;
  effectiveContinuationSignal: ContinuationSignalExtraction["signal"];
  continuationExtractionFromBracket: boolean;
  effectiveContinueWorkRequests: ContinueWorkRequest[];
  continuationWorkReason: string | undefined;
  internalBracketTraceparent: string | undefined;
  continuation: ReplyContinuationController;
  getActiveSessionEntry: () => SessionEntry | undefined;
}): Promise<{ activeSessionEntry: SessionEntry | undefined; bracketTokensAccumulated: boolean }> {
  const {
    cfg,
    sessionKey,
    followupRun,
    runId,
    usage,
    effectiveContinuationSignal,
    continuationExtractionFromBracket,
    effectiveContinueWorkRequests,
    continuationWorkReason,
    internalBracketTraceparent,
    continuation,
    getActiveSessionEntry,
  } = context;
  let activeSessionEntry = getActiveSessionEntry();
  const persistContinuationChainState = async (
    params: PersistContinuationChainStateParams,
  ): Promise<{ chainId: string | undefined; entry: SessionEntry | undefined }> => {
    const result = await continuation.persistContinuationChainState(params);
    activeSessionEntry = getActiveSessionEntry();
    return result;
  };
  let bracketTokensAccumulated = false;
  // Token-form parity with the continue_delegate tool: a bracket
  // [[CONTINUE_DELEGATE: ... | post-compaction]] signal stages a delegate
  // for release after the next compaction seam, same as the tool's
  // mode="post-compaction" branch (see continue-delegate-tool.ts). Staging
  // happens before the bracket cap-gate because the chain/cost caps are
  // re-applied at release time inside dispatchPostCompactionDelegates, and
  // the tool form also skips the bracket cap-gate.
  const continuationRuntimeConfig = resolveLiveContinuationRuntimeConfig(cfg);
  if (
    continuationRuntimeConfig.enabled &&
    effectiveContinuationSignal &&
    sessionKey &&
    effectiveContinuationSignal.kind === "delegate" &&
    effectiveContinuationSignal.postCompaction
  ) {
    stagePostCompactionDelegate(sessionKey, {
      task: effectiveContinuationSignal.task,
      createdAt: Date.now(),
      ...(effectiveContinuationSignal.targetSessionKey
        ? { targetSessionKey: effectiveContinuationSignal.targetSessionKey }
        : {}),
      ...(effectiveContinuationSignal.targetSessionKeys &&
      effectiveContinuationSignal.targetSessionKeys.length > 0
        ? { targetSessionKeys: effectiveContinuationSignal.targetSessionKeys }
        : {}),
      ...(effectiveContinuationSignal.fanoutMode
        ? { fanoutMode: effectiveContinuationSignal.fanoutMode }
        : {}),
      ...(internalBracketTraceparent
        ? {
            traceparent: internalBracketTraceparent,
            traceparentProvenance: "internal" as const,
          }
        : {}),
      ...(effectiveContinuationSignal.model ? { model: effectiveContinuationSignal.model } : {}),
    });
    const taskEcho = formatDelegateEchoForSystemEvent(effectiveContinuationSignal.task);
    enqueueSystemEvent(
      `[continuation:delegate-staged-post-compaction] Bracket delegate staged for post-compaction release: ${taskEcho}`,
      { sessionKey, trusted: true },
    );
  } else if (continuationRuntimeConfig.enabled && effectiveContinuationSignal && sessionKey) {
    const {
      maxChainLength,
      defaultDelayMs,
      minDelayMs,
      maxDelayMs,
      costCapTokens,
      crossSessionTargeting,
    } = continuationRuntimeConfig;

    const currentChainCount = activeSessionEntry?.continuationChainCount ?? 0;
    const allocatedChainHop = currentChainCount + pendingDelegateCount(sessionKey);

    if (allocatedChainHop >= maxChainLength) {
      // No mint-on-reject: the chain never advanced for this signal, so
      // chainId passes through as-is.
      emitBracketContinuationRejected({
        sessionKey,
        signal: effectiveContinuationSignal,
        defaultDelayMs,
        chainId: activeSessionEntry?.continuationChainId,
        chainStepRemaining: Math.max(0, maxChainLength - allocatedChainHop),
        disabledReason: "cap.chain",
        logMessage: `Continuation chain capped at ${maxChainLength} for session ${sessionKey}`,
        systemEventMessage: `[continuation] Bracket continuation rejected: chain length ${maxChainLength} reached.`,
      });
    } else {
      // Accumulate token usage for cost cap (input + output only, excludes
      // cache reads/writes which inflate with inherited system prompt context).
      const turnTokens = (usage?.input ?? 0) + (usage?.output ?? 0);
      const previousChainTokens = activeSessionEntry?.continuationChainTokens ?? 0;
      const accumulatedChainTokens = previousChainTokens + turnTokens;
      if (costCapTokens > 0 && accumulatedChainTokens > costCapTokens) {
        emitBracketContinuationRejected({
          sessionKey,
          signal: effectiveContinuationSignal,
          defaultDelayMs,
          chainId: activeSessionEntry?.continuationChainId,
          chainStepRemaining: Math.max(0, maxChainLength - allocatedChainHop),
          disabledReason: "cap.cost",
          logMessage: `Continuation cost cap exceeded (${accumulatedChainTokens} > ${costCapTokens}) for session ${sessionKey}`,
          systemEventMessage: `[continuation] Bracket continuation rejected: cost cap exceeded (${accumulatedChainTokens} > ${costCapTokens}).`,
        });
      } else {
        bracketTokensAccumulated = true;
        const nextChainCount = currentChainCount + 1;
        const chainStartedAt = activeSessionEntry?.continuationChainStartedAt ?? Date.now();
        if (effectiveContinuationSignal.kind === "delegate") {
          const delegateTask = effectiveContinuationSignal.task;
          const delegateDelayMs = effectiveContinuationSignal.delayMs;
          const rejectCrossSessionTargeting = (
            targeting: {
              targetSessionKey?: string;
              targetSessionKeys?: readonly string[];
              fanoutMode?: "tree" | "all";
            },
            details: {
              plannedHop: number;
              task: string;
              delegateDelivery: "immediate" | "timer";
              silent?: boolean;
              silentWake?: boolean;
            },
          ): boolean => {
            if (
              crossSessionTargeting === "enabled" ||
              !hasCrossSessionDelegateTargeting(targeting, sessionKey)
            ) {
              return false;
            }
            defaultRuntime.log(
              `[continuation] Cross-session targeting rejected by policy for session ${sessionKey}`,
            );
            enqueueSystemEvent(
              "[continuation] Delegate rejected: cross-session targeting is disabled by policy. " +
                'Use the default return target, targetSessionKey set to this session, or fanoutMode="tree".',
              { sessionKey, trusted: true },
            );
            emitContinuationDisabledSpan({
              chainId: activeSessionEntry?.continuationChainId,
              chainStepRemaining: Math.max(0, maxChainLength - details.plannedHop),
              disabledReason: "policy.cross_session_targeting",
              signalKind: "bracket-delegate",
              delegateDelivery: details.delegateDelivery,
              delegateMode: details.silentWake
                ? "silent-wake"
                : details.silent
                  ? "silent"
                  : "normal",
              reason: details.task,
              log: (message) => defaultRuntime.log(message),
            });
            bracketTokensAccumulated = false;
            return true;
          };
          const doSpawn = async (
            plannedHop: number,
            task: string,
            options?: {
              timerTriggered?: boolean;
              silent?: boolean;
              silentWake?: boolean;
              startedAt?: number;
              targetSessionKey?: string;
              targetSessionKeys?: string[];
              fanoutMode?: "tree" | "all";
              traceparent?: string;
              model?: string;
            },
          ) => {
            let dispatchSpan: ReturnType<typeof startContinuationDelegateSpan> | undefined;
            try {
              if (
                rejectCrossSessionTargeting(
                  {
                    ...(options?.targetSessionKey
                      ? { targetSessionKey: options.targetSessionKey }
                      : {}),
                    ...(options?.targetSessionKeys && options.targetSessionKeys.length > 0
                      ? { targetSessionKeys: options.targetSessionKeys }
                      : {}),
                    ...(options?.fanoutMode ? { fanoutMode: options.fanoutMode } : {}),
                  },
                  {
                    plannedHop,
                    task,
                    delegateDelivery: options?.timerTriggered ? "timer" : "immediate",
                    ...(options?.silent ? { silent: options.silent } : {}),
                    ...(options?.silentWake ? { silentWake: options.silentWake } : {}),
                  },
                )
              ) {
                return false;
              }
              const outboundTraceparent = resolveContinuationTraceparent(options?.traceparent);
              const delegateMode = options?.silentWake
                ? "silent-wake"
                : options?.silent
                  ? "silent"
                  : "normal";
              if (!options?.timerTriggered) {
                dispatchSpan = startContinuationDelegateSpan({
                  chainId: undefined,
                  chainStepRemaining: maxChainLength - plannedHop,
                  delayMs: 0,
                  delivery: "immediate",
                  delegateMode,
                  traceparent: outboundTraceparent,
                  log: (message) => defaultRuntime.log(message),
                });
              }
              const spawnTraceparent = dispatchSpan?.traceparent?.() ?? outboundTraceparent;
              const dispatchChainId = activeSessionEntry?.continuationChainId ?? generateChainId();
              const spawnResult = await spawnSubagentDirect(
                {
                  task: `[continuation:chain-hop:${plannedHop}] Delegated task (turn ${plannedHop}/${maxChainLength}): ${task}`,
                  ...(options?.silent ? { silentAnnounce: true } : {}),
                  ...(options?.silentWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
                  drainsContinuationDelegateQueue: true,
                  continuationChainState: {
                    count: plannedHop,
                    startedAt: options?.startedAt ?? chainStartedAt,
                    tokens: Math.max(
                      accumulatedChainTokens,
                      activeSessionEntry?.continuationChainTokens ?? 0,
                    ),
                    chainId: dispatchChainId,
                  },
                  ...(options?.targetSessionKey
                    ? { continuationTargetSessionKey: options.targetSessionKey }
                    : {}),
                  ...(options?.targetSessionKeys && options.targetSessionKeys.length > 0
                    ? { continuationTargetSessionKeys: options.targetSessionKeys }
                    : {}),
                  ...(options?.fanoutMode ? { continuationFanoutMode: options.fanoutMode } : {}),
                  ...(options?.model ? { model: options.model } : {}),
                  ...(spawnTraceparent ? { traceparent: spawnTraceparent } : {}),
                },
                {
                  agentSessionKey: sessionKey,
                  agentChannel: followupRun.originatingChannel ?? undefined,
                  agentAccountId: followupRun.originatingAccountId ?? undefined,
                  agentTo: followupRun.originatingTo ?? undefined,
                  agentThreadId: followupRun.originatingThreadId ?? undefined,
                },
              );
              if (spawnResult.status === "accepted") {
                if (options?.timerTriggered) {
                  defaultRuntime.log(
                    `DELEGATE timer fired and spawned turn ${plannedHop}/${maxChainLength} for session ${sessionKey}: ${task}`,
                  );
                }
                const { chainId: persistedChainId } = await persistContinuationChainState({
                  count: Math.max(activeSessionEntry?.continuationChainCount ?? 0, plannedHop),
                  startedAt: options?.startedAt ?? chainStartedAt,
                  tokens: Math.max(
                    accumulatedChainTokens,
                    activeSessionEntry?.continuationChainTokens ?? 0,
                  ),
                  chainId: dispatchChainId,
                });
                if (dispatchSpan) {
                  if (persistedChainId !== undefined) {
                    dispatchSpan.setAttributes({ "chain.id": persistedChainId });
                  }
                  dispatchSpan.setStatus("OK");
                }
                const taskEcho = formatDelegateEchoForSystemEvent(task);
                enqueueSystemEvent(
                  `[continuation:delegate-spawned] Spawned turn ${plannedHop}/${maxChainLength}: ${taskEcho}`,
                  { sessionKey, trusted: true },
                );
                return true;
              }
              const reasonText = spawnResult.error ?? "delegation was not accepted.";
              const reasonEcho = formatDelegateEchoForSystemEvent(reasonText);
              const taskEcho = formatDelegateEchoForSystemEvent(task);
              defaultRuntime.log(
                `DELEGATE spawn rejected (${spawnResult.status}) for session ${sessionKey} reason=${reasonText}`,
              );
              dispatchSpan?.setStatus("ERROR", reasonText);
              enqueueSystemEvent(
                `[continuation] DELEGATE spawn ${spawnResult.status}: ${reasonEcho} Use sessions_spawn manually. Original task: ${taskEcho}`,
                { sessionKey, trusted: true },
              );
              return false;
            } catch (err) {
              const errorMessage = String(err);
              const errorEcho = formatDelegateEchoForSystemEvent(errorMessage);
              const taskEcho = formatDelegateEchoForSystemEvent(task);
              dispatchSpan?.recordException(err);
              dispatchSpan?.setStatus("ERROR", errorMessage);
              defaultRuntime.log(
                `DELEGATE spawn failed for session ${sessionKey}: ${errorMessage}`,
              );
              enqueueSystemEvent(
                `[continuation] DELEGATE spawn failed: ${errorEcho}. Original task: ${taskEcho}`,
                { sessionKey, trusted: true },
              );
              return false;
            } finally {
              dispatchSpan?.end();
            }
          };

          if (delegateDelayMs && delegateDelayMs > 0) {
            const rejectedDelayedTarget = rejectCrossSessionTargeting(
              {
                ...(effectiveContinuationSignal.targetSessionKey
                  ? { targetSessionKey: effectiveContinuationSignal.targetSessionKey }
                  : {}),
                ...(effectiveContinuationSignal.targetSessionKeys &&
                effectiveContinuationSignal.targetSessionKeys.length > 0
                  ? { targetSessionKeys: effectiveContinuationSignal.targetSessionKeys }
                  : {}),
                ...(effectiveContinuationSignal.fanoutMode
                  ? { fanoutMode: effectiveContinuationSignal.fanoutMode }
                  : {}),
              },
              {
                plannedHop: nextChainCount,
                task: delegateTask,
                delegateDelivery: "timer",
                ...(effectiveContinuationSignal.silent
                  ? { silent: effectiveContinuationSignal.silent }
                  : {}),
                ...(effectiveContinuationSignal.silentWake
                  ? { silentWake: effectiveContinuationSignal.silentWake }
                  : {}),
              },
            );
            if (!rejectedDelayedTarget) {
              const clampedDelay = Math.max(minDelayMs, Math.min(maxDelayMs, delegateDelayMs));
              const outboundTraceparent = internalBracketTraceparent;
              const delegateMode = effectiveContinuationSignal.silentWake
                ? "silent-wake"
                : effectiveContinuationSignal.silent
                  ? "silent"
                  : "normal";
              enqueuePendingDelegate(sessionKey, {
                task: delegateTask,
                delayMs: clampedDelay,
                ...(delegateMode !== "normal" ? { mode: delegateMode } : {}),
                ...(effectiveContinuationSignal.targetSessionKey
                  ? { targetSessionKey: effectiveContinuationSignal.targetSessionKey }
                  : {}),
                ...(effectiveContinuationSignal.targetSessionKeys &&
                effectiveContinuationSignal.targetSessionKeys.length > 0
                  ? { targetSessionKeys: effectiveContinuationSignal.targetSessionKeys }
                  : {}),
                ...(effectiveContinuationSignal.fanoutMode
                  ? { fanoutMode: effectiveContinuationSignal.fanoutMode }
                  : {}),
                ...(outboundTraceparent ? { traceparent: outboundTraceparent } : {}),
                ...(effectiveContinuationSignal.model
                  ? { model: effectiveContinuationSignal.model }
                  : {}),
              });
              await persistContinuationChainState({
                count: currentChainCount,
                startedAt: chainStartedAt,
                tokens: accumulatedChainTokens,
              });
            }
          } else {
            await doSpawn(nextChainCount, delegateTask, {
              silent: effectiveContinuationSignal.silent,
              silentWake: effectiveContinuationSignal.silentWake,
              startedAt: chainStartedAt,
              ...(effectiveContinuationSignal.model
                ? { model: effectiveContinuationSignal.model }
                : {}),
              ...(effectiveContinuationSignal.targetSessionKey
                ? { targetSessionKey: effectiveContinuationSignal.targetSessionKey }
                : {}),
              ...(effectiveContinuationSignal.targetSessionKeys &&
              effectiveContinuationSignal.targetSessionKeys.length > 0
                ? { targetSessionKeys: effectiveContinuationSignal.targetSessionKeys }
                : {}),
              ...(effectiveContinuationSignal.fanoutMode
                ? { fanoutMode: effectiveContinuationSignal.fanoutMode }
                : {}),
              ...(internalBracketTraceparent ? { traceparent: internalBracketTraceparent } : {}),
            });
          }
        } else {
          // Fan out every continue_work tool election captured this turn
          //. A single model response can fire N continue_work calls;
          // each is its own flow with its own delay/reason. Bracket-sourced
          // work has no per-tool array, so it schedules one election from the
          // merged signal.
          const workRequests: ContinueWorkRequest[] =
            !continuationExtractionFromBracket && effectiveContinueWorkRequests.length > 0
              ? effectiveContinueWorkRequests
              : [
                  {
                    reason: continuationWorkReason ?? "",
                    delaySeconds: (effectiveContinuationSignal.delayMs ?? defaultDelayMs) / 1000,
                    ...(internalBracketTraceparent
                      ? { traceparent: internalBracketTraceparent }
                      : {}),
                  },
                ];
          const workChainId = activeSessionEntry?.continuationChainId ?? generateChainId();
          const { scheduleContinuationWorkBatch } = await import("../continuation/lazy.runtime.js");
          const schedulingConfig = resolveLiveContinuationRuntimeConfig(cfg);
          if (!schedulingConfig.enabled) {
            defaultRuntime.log(
              `[continuation] Ignoring continue_work election(s) disabled before scheduling for session ${sessionKey}`,
            );
            bracketTokensAccumulated = false;
          } else {
            let reservation:
              | {
                  prior: {
                    count: number;
                    startedAt: number | undefined;
                    tokens: number;
                    chainId: string | undefined;
                  };
                  reserved: ChainState;
                  reservedCount: number;
                }
              | undefined;
            try {
              let prior:
                | {
                    count: number;
                    startedAt: number | undefined;
                    tokens: number;
                    chainId: string | undefined;
                  }
                | undefined;
              const persisted = await persistContinuationChainState({
                count: currentChainCount + workRequests.length,
                startedAt: chainStartedAt,
                tokens: accumulatedChainTokens,
                chainId: workChainId,
                required: true,
                update: (entry, proposed) => {
                  const persistedCount = entry.continuationChainCount ?? 0;
                  const persistedTokens = entry.continuationChainTokens ?? 0;
                  const persistedChainId =
                    persistedCount > 0 && entry.continuationChainId
                      ? entry.continuationChainId
                      : proposed.continuationChainId;
                  const persistedStartedAt =
                    persistedCount > 0
                      ? (entry.continuationChainStartedAt ?? proposed.continuationChainStartedAt)
                      : proposed.continuationChainStartedAt;
                  prior = {
                    count: persistedCount,
                    startedAt: entry.continuationChainStartedAt,
                    tokens: persistedTokens,
                    chainId: entry.continuationChainId,
                  };
                  return {
                    continuationChainCount: Math.min(
                      schedulingConfig.maxChainLength,
                      persistedCount + workRequests.length,
                    ),
                    continuationChainStartedAt: persistedStartedAt,
                    continuationChainTokens: persistedTokens + turnTokens,
                    continuationChainId: persistedChainId,
                  };
                },
              });
              if (!prior || !persisted.entry) {
                throw new Error("continuation chain reservation did not return session state");
              }
              reservation = {
                prior,
                reserved: {
                  currentChainCount: prior.count,
                  chainStartedAt:
                    persisted.entry.continuationChainStartedAt ?? prior.startedAt ?? chainStartedAt,
                  accumulatedChainTokens:
                    persisted.entry.continuationChainTokens ?? prior.tokens + turnTokens,
                  ...(persisted.entry.continuationChainId
                    ? { chainId: persisted.entry.continuationChainId }
                    : {}),
                },
                reservedCount: persisted.entry.continuationChainCount ?? prior.count,
              };
            } catch (err) {
              bracketTokensAccumulated = false;
              enqueueSystemEvent(
                "[continuation] continue_work election(s) were not scheduled because chain state could not be persisted.",
                { sessionKey, trusted: true },
              );
              defaultRuntime.log(
                `[continuation] Skipping continue_work scheduling after chain-state persistence failure for session ${sessionKey}: ${String(err)}`,
              );
            }
            if (reservation) {
              const restorePriorChainState = async (): Promise<boolean> => {
                let rolledBack = false;
                try {
                  await persistContinuationChainState({
                    count: reservation.prior.count,
                    startedAt: reservation.prior.startedAt ?? chainStartedAt,
                    tokens: reservation.prior.tokens,
                    ...(reservation.prior.chainId
                      ? { chainId: reservation.prior.chainId }
                      : { clearChainId: true }),
                    required: true,
                    update: (entry) => {
                      if (
                        entry.continuationChainId !== reservation.reserved.chainId ||
                        (entry.continuationChainCount ?? 0) !== reservation.reservedCount
                      ) {
                        return {};
                      }
                      rolledBack = true;
                      return {
                        continuationChainCount: reservation.prior.count,
                        continuationChainStartedAt: reservation.prior.startedAt,
                        continuationChainTokens: Math.max(
                          reservation.prior.tokens,
                          (entry.continuationChainTokens ?? 0) - turnTokens,
                        ),
                        continuationChainId: reservation.prior.chainId,
                      };
                    },
                  });
                  if (!rolledBack) {
                    throw new Error("session chain advanced after reservation");
                  }
                  return true;
                } catch (err) {
                  defaultRuntime.log(
                    `[continuation] Failed to roll back continue_work chain reservation for session ${sessionKey}: ${String(err)}`,
                  );
                  enqueueSystemEvent(
                    "[continuation] continue_work chain-state rollback failed; the reserved budget remains fail-closed.",
                    { sessionKey, trusted: true },
                  );
                  return false;
                }
              };
              const liveSchedulingConfig = resolveLiveContinuationRuntimeConfig(cfg);
              if (!liveSchedulingConfig.enabled) {
                if (await restorePriorChainState()) {
                  bracketTokensAccumulated = false;
                }
                defaultRuntime.log(
                  `[continuation] Ignoring continue_work election(s) disabled during chain-state reservation for session ${sessionKey}`,
                );
              } else {
                const reservedRequestCount = Math.max(
                  0,
                  reservation.reservedCount - reservation.prior.count,
                );
                const reservedWorkRequests = workRequests.slice(0, reservedRequestCount);
                const unreservedRequestCount = workRequests.length - reservedWorkRequests.length;
                let batchResult:
                  | Awaited<ReturnType<typeof scheduleContinuationWorkBatch>>
                  | undefined;
                if (reservedWorkRequests.length === 0) {
                  batchResult = {
                    scheduledCount: 0,
                    cappedCount: unreservedRequestCount,
                    capped: unreservedRequestCount > 0,
                    chainState: reservation.reserved,
                  };
                } else {
                  try {
                    const scheduledBatch = await scheduleContinuationWorkBatch({
                      sessionKey,
                      chainState: reservation.reserved,
                      requests: reservedWorkRequests,
                      config: liveSchedulingConfig,
                      // Same-session own-turn continue_work has no spawning lineage; leave
                      // parentRunId unset so bucket-1 never orphan-reaps it (see the
                      // matching note in attempt-execution.ts scheduleSpawnInitContinueWorkWake).
                      originRunId: runId,
                      originTurnId: followupRun.run.sessionId,
                      log: (message) => defaultRuntime.log(message),
                    });
                    batchResult = {
                      ...scheduledBatch,
                      cappedCount: scheduledBatch.cappedCount + unreservedRequestCount,
                      capped: scheduledBatch.capped || unreservedRequestCount > 0,
                    };
                  } catch (err) {
                    defaultRuntime.log(
                      `[continuation] continue_work scheduling failed after durable reservation for session ${sessionKey}: ${String(err)}`,
                    );
                    enqueueSystemEvent(
                      "[continuation] continue_work scheduling failed; the reserved chain budget remains fail-closed.",
                      { sessionKey, trusted: true },
                    );
                  }
                }
                if (batchResult) {
                  if (batchResult.scheduledCount === 0) {
                    if (await restorePriorChainState()) {
                      bracketTokensAccumulated = false;
                    }
                  } else {
                    await persistContinuationChainState({
                      count: batchResult.chainState.currentChainCount,
                      startedAt: batchResult.chainState.chainStartedAt,
                      tokens: batchResult.chainState.accumulatedChainTokens,
                      ...(batchResult.chainState.chainId
                        ? { chainId: batchResult.chainState.chainId }
                        : {}),
                      update: (entry, proposed) => {
                        if (entry.continuationChainId !== reservation.reserved.chainId) {
                          return {};
                        }
                        return {
                          ...proposed,
                          continuationChainCount:
                            (entry.continuationChainCount ?? 0) === reservation.reservedCount
                              ? proposed.continuationChainCount
                              : Math.max(
                                  entry.continuationChainCount ?? 0,
                                  proposed.continuationChainCount,
                                ),
                          continuationChainTokens: Math.max(
                            entry.continuationChainTokens ?? 0,
                            proposed.continuationChainTokens,
                          ),
                        };
                      },
                    });
                  }
                  // Surface cap-dropped elections so a partial fan-out is not silent:
                  // the tool already told the model each call was "scheduled". Only
                  // emit for multi-election turns to keep single-work behavior intact.
                  if (batchResult.cappedCount > 0 && workRequests.length > 1) {
                    enqueueSystemEvent(
                      `[continuation] ${batchResult.cappedCount} of ${workRequests.length} continue_work elections were not scheduled (chain/cost/pending cap).`,
                      { sessionKey, trusted: true },
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return { activeSessionEntry, bracketTokensAccumulated };
}
