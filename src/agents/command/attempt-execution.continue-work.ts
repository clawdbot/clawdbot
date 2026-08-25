import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { generateChainId } from "../../infra/secure-random.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";

const log = createSubsystemLogger("agents/attempt-execution");

type SpawnInitContinueWorkRequest = {
  reason: string;
  delaySeconds?: number;
  traceparent?: string;
};

type ScheduledSpawnInitContinueWorkRequest = {
  reason: string;
  delaySeconds: number;
  traceparent?: string;
};

type ContinuationChainPatch = {
  continuationChainCount: number;
  continuationChainStartedAt: number;
  continuationChainTokens: number;
  continuationChainId: string | undefined;
};

type SpawnInitChainStateUpdate = {
  count: number;
  startedAt: number;
  tokens: number;
  chainId?: string;
  update?: (entry: SessionEntry, proposed: ContinuationChainPatch) => Partial<SessionEntry> | null;
};

type PriorChainState = {
  count: number;
  startedAt: number | undefined;
  tokens: number;
  chainId: string | undefined;
};

export async function scheduleSpawnInitContinueWorkWake(params: {
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  requests: SpawnInitContinueWorkRequest[];
  cfg: OpenClawConfig;
  runResult: EmbeddedAgentRunResult;
  originRunId: string;
  originTurnId: string;
}): Promise<void> {
  const [
    { resolveLiveContinuationRuntimeConfig },
    { loadContinuationChainState },
    { scheduleContinuationWorkBatch },
    { patchSessionEntryCore, resolveSessionEntryFromStore },
  ] = await Promise.all([
    import("../../auto-reply/continuation/config.js"),
    import("../../auto-reply/continuation/state.js"),
    import("../../auto-reply/continuation/lazy.runtime.js"),
    import("../../config/sessions/session-accessor.js"),
  ]);

  const continuationConfig = resolveLiveContinuationRuntimeConfig(params.cfg);
  if (!continuationConfig.enabled) {
    log.info(
      `[continuation] Ignoring spawn-init continue_work election(s) disabled before scheduling for session ${sanitizeForLog(params.sessionKey)}`,
    );
    return;
  }
  if (!params.storePath) {
    log.info(
      `[continuation] Ignoring spawn-init continue_work election(s) without a durable session store for session ${sanitizeForLog(params.sessionKey)}`,
    );
    enqueueSystemEvent(
      "[continuation] continue_work election(s) were not scheduled because durable session state is unavailable.",
      { sessionKey: params.sessionKey, trusted: true },
    );
    return;
  }

  const tailUsage = params.runResult.meta?.agentMeta?.usage;
  const turnTokens = (tailUsage?.input ?? 0) + (tailUsage?.output ?? 0);
  let activeSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const initialChainState = loadContinuationChainState(activeSessionEntry, turnTokens);
  const workChainId = initialChainState.chainId ?? generateChainId();

  const persistChainState = async (state: SpawnInitChainStateUpdate): Promise<SessionEntry> => {
    const proposed: ContinuationChainPatch = {
      continuationChainCount: state.count,
      continuationChainStartedAt: state.startedAt,
      continuationChainTokens: state.tokens,
      continuationChainId: state.chainId,
    };
    const updated =
      (await patchSessionEntryCore(
        { storePath: params.storePath, sessionKey: params.sessionKey },
        (entry) => (state.update ? state.update(entry, proposed) : proposed),
        { preserveActivity: true, requireWriteSuccess: true },
      )) ?? undefined;
    if (!updated) {
      throw new Error(`session entry was not found: ${params.sessionKey}`);
    }

    activeSessionEntry = updated;
    if (params.sessionStore) {
      const resolved = resolveSessionEntryFromStore({
        store: params.sessionStore,
        sessionKey: params.sessionKey,
      });
      params.sessionStore[resolved.normalizedKey] = updated;
      for (const legacyKey of resolved.legacyKeys) {
        delete params.sessionStore[legacyKey];
      }
    }
    return updated;
  };

  let prior: PriorChainState | undefined;
  let reservedEntry: SessionEntry;
  try {
    reservedEntry = await persistChainState({
      count: initialChainState.currentChainCount + params.requests.length,
      startedAt: initialChainState.chainStartedAt,
      tokens: initialChainState.accumulatedChainTokens,
      chainId: workChainId,
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
            continuationConfig.maxChainLength,
            persistedCount + params.requests.length,
          ),
          continuationChainStartedAt: persistedStartedAt,
          continuationChainTokens: persistedTokens + turnTokens,
          continuationChainId: persistedChainId,
        };
      },
    });
  } catch (error) {
    enqueueSystemEvent(
      "[continuation] continue_work election(s) were not scheduled because chain state could not be persisted.",
      { sessionKey: params.sessionKey, trusted: true },
    );
    throw error;
  }
  if (!prior) {
    throw new Error("continuation chain reservation did not return prior session state");
  }

  const reservation = {
    prior,
    reserved: {
      currentChainCount: prior.count,
      chainStartedAt:
        reservedEntry.continuationChainStartedAt ??
        prior.startedAt ??
        initialChainState.chainStartedAt,
      accumulatedChainTokens: reservedEntry.continuationChainTokens ?? prior.tokens + turnTokens,
      ...(reservedEntry.continuationChainId ? { chainId: reservedEntry.continuationChainId } : {}),
    },
    reservedCount: reservedEntry.continuationChainCount ?? prior.count,
  };
  const restorePriorChainState = async (): Promise<void> => {
    let rolledBack = false;
    try {
      await persistChainState({
        count: reservation.prior.count,
        startedAt: reservation.prior.startedAt ?? initialChainState.chainStartedAt,
        tokens: reservation.prior.tokens,
        chainId: reservation.prior.chainId,
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
        throw new Error("session chain advanced after spawn-init reservation");
      }
    } catch (error) {
      enqueueSystemEvent(
        "[continuation] continue_work chain-state rollback failed; the reserved budget remains fail-closed.",
        { sessionKey: params.sessionKey, trusted: true },
      );
      throw error;
    }
  };

  const liveSchedulingConfig = resolveLiveContinuationRuntimeConfig(params.cfg);
  if (!liveSchedulingConfig.enabled) {
    await restorePriorChainState();
    log.info(
      `[continuation] Ignoring spawn-init continue_work election(s) disabled during chain-state reservation for session ${sanitizeForLog(params.sessionKey)}`,
    );
    return;
  }

  const reservedRequestCount = Math.max(0, reservation.reservedCount - reservation.prior.count);
  const reservedRequests = params.requests.slice(0, reservedRequestCount);
  const unreservedRequestCount = params.requests.length - reservedRequests.length;
  const { checkContinuationBudget } = await import("../../auto-reply/continuation/scheduler.js");
  const liveBudgetRejection =
    reservedRequests.length > 0
      ? checkContinuationBudget({
          chainState: reservation.reserved,
          config: liveSchedulingConfig,
          sessionKey: params.sessionKey,
        })
      : null;
  let result: Awaited<ReturnType<typeof scheduleContinuationWorkBatch>>;
  let failCreatedWork: ((summary: string) => void) | undefined;
  let supersedePriorParkedWork: (() => string[]) | undefined;
  const createdFlowIds: string[] = [];
  if (reservedRequests.length === 0 || liveBudgetRejection) {
    result = {
      scheduledCount: 0,
      cappedCount: params.requests.length,
      capped: params.requests.length > 0,
      chainState: reservation.reserved,
    };
  } else {
    try {
      const [
        { failFlow, getTaskFlowById, listTaskFlowsForOwnerKey, requestFlowCancel },
        { decodeWorkState, isContinuationWorkFlow, workToRuntime },
        { markPendingWorkSuperseded },
      ] = await Promise.all([
        import("../../tasks/task-flow-registry.js"),
        import("../../auto-reply/continuation/work-flow-state.js"),
        import("../../auto-reply/continuation/work-store.js"),
      ]);
      const existingFlows = listTaskFlowsForOwnerKey(params.sessionKey);
      const priorParkedFlows = existingFlows.flatMap((flow) => {
        const state = isContinuationWorkFlow(flow) ? decodeWorkState(flow) : undefined;
        return flow.status === "queued" && state?.idleRetry?.trigger === "reply-run-ended"
          ? [{ flowId: flow.flowId, revision: flow.revision }]
          : [];
      });
      supersedePriorParkedWork = () => {
        const unresolvedFlowIds: string[] = [];
        for (const priorParked of priorParkedFlows) {
          const flow = getTaskFlowById(priorParked.flowId);
          if (!flow || flow.status !== "queued" || !isContinuationWorkFlow(flow)) {
            continue;
          }
          const state = decodeWorkState(flow);
          if (state?.idleRetry?.trigger !== "reply-run-ended") {
            continue;
          }
          if (
            flow.revision !== priorParked.revision ||
            !markPendingWorkSuperseded(
              workToRuntime(flow, state, "queued"),
              "Superseded by a newer continue_work election after its chain state finalized.",
            )
          ) {
            unresolvedFlowIds.push(flow.flowId);
          }
        }
        return unresolvedFlowIds;
      };
      failCreatedWork = (summary) => {
        const unresolvedFlowIds: string[] = [];
        for (const flowId of createdFlowIds) {
          const flow = getTaskFlowById(flowId);
          if (!flow || (flow.status !== "queued" && flow.status !== "running")) {
            continue;
          }
          if (!isContinuationWorkFlow(flow)) {
            unresolvedFlowIds.push(flow.flowId);
            continue;
          }
          const failed = failFlow({
            flowId: flow.flowId,
            expectedRevision: flow.revision,
            currentStep: "spawn-init continuation finalization failed",
            stateJson: flow.stateJson,
            blockedSummary: summary,
          });
          if (!failed.applied) {
            const fresh = getTaskFlowById(flow.flowId);
            const freshState =
              fresh && isContinuationWorkFlow(fresh) ? decodeWorkState(fresh) : undefined;
            if (
              !fresh ||
              (fresh.status !== "queued" && fresh.status !== "running") ||
              fresh.cancelRequestedAt !== undefined
            ) {
              continue;
            }
            if (
              freshState?.originRunId !== params.originRunId ||
              freshState.originTurnId !== params.originTurnId
            ) {
              unresolvedFlowIds.push(fresh.flowId);
              continue;
            }
            const cancelled = requestFlowCancel({
              flowId: fresh.flowId,
              expectedRevision: fresh.revision,
            });
            if (!cancelled.applied) {
              const latest = getTaskFlowById(fresh.flowId);
              if (
                latest &&
                (latest.status === "queued" || latest.status === "running") &&
                latest.cancelRequestedAt === undefined
              ) {
                unresolvedFlowIds.push(latest.flowId);
              }
            }
          }
        }
        if (unresolvedFlowIds.length > 0) {
          throw new Error(
            `failed to terminalize or cancel continuation flow(s): ${unresolvedFlowIds.join(", ")}`,
          );
        }
      };
      result = await scheduleContinuationWorkBatch({
        sessionKey: params.sessionKey,
        chainState: reservation.reserved,
        requests: reservedRequests.map((request) => {
          const scheduledRequest: ScheduledSpawnInitContinueWorkRequest = {
            reason: request.reason,
            delaySeconds: request.delaySeconds ?? liveSchedulingConfig.defaultDelayMs / 1000,
          };
          if (request.traceparent) {
            scheduledRequest.traceparent = request.traceparent;
          }
          return scheduledRequest;
        }),
        config: liveSchedulingConfig,
        coalescePriorParkedWork: false,
        onFlowEnqueued: (flowId) => createdFlowIds.push(flowId),
        // Same-session own-turn work has no spawning parent. Adding parentRunId
        // would let orphan recovery reap the row after its electing turn settles.
        originRunId: params.originRunId,
        originTurnId: params.originTurnId,
        log: (message) => log.info(message),
      });
      result.cappedCount += unreservedRequestCount;
      result.capped ||= unreservedRequestCount > 0;
    } catch (error) {
      failCreatedWork?.("continue_work scheduling failed after durable chain reservation.");
      enqueueSystemEvent(
        "[continuation] continue_work scheduling failed; the reserved chain budget remains fail-closed.",
        { sessionKey: params.sessionKey, trusted: true },
      );
      throw error;
    }
  }

  if (result.cappedCount > 0 && params.requests.length > 1) {
    enqueueSystemEvent(
      `[continuation] ${result.cappedCount} of ${params.requests.length} continue_work elections were not scheduled (chain/cost/pending cap).`,
      { sessionKey: params.sessionKey, trusted: true },
    );
  }
  if (result.scheduledCount === 0) {
    await restorePriorChainState();
    return;
  }

  let finalizationApplied = false;
  try {
    await persistChainState({
      count: result.chainState.currentChainCount,
      startedAt: result.chainState.chainStartedAt,
      tokens: result.chainState.accumulatedChainTokens,
      ...(result.chainState.chainId ? { chainId: result.chainState.chainId } : {}),
      update: (entry, proposed) => {
        if (entry.continuationChainId !== reservation.reserved.chainId) {
          return {};
        }
        finalizationApplied = true;
        return {
          ...proposed,
          continuationChainCount:
            (entry.continuationChainCount ?? 0) === reservation.reservedCount
              ? proposed.continuationChainCount
              : Math.max(entry.continuationChainCount ?? 0, proposed.continuationChainCount),
          continuationChainTokens: Math.max(
            entry.continuationChainTokens ?? 0,
            proposed.continuationChainTokens,
          ),
        };
      },
    });
    if (!finalizationApplied) {
      throw new Error("spawn-init chain finalization guard did not apply");
    }
  } catch (error) {
    let cleanupError: unknown;
    try {
      failCreatedWork?.("continue_work chain-state finalization did not commit.");
    } catch (caught) {
      cleanupError = caught;
    }
    enqueueSystemEvent(
      "[continuation] continue_work wake was scheduled, but chain-state finalization failed; the reserved budget remains fail-closed.",
      { sessionKey: params.sessionKey, trusted: true },
    );
    if (cleanupError) {
      const combinedError = new Error(
        "spawn-init chain finalization and wake cleanup both failed",
        {
          cause: error,
        },
      );
      Object.assign(combinedError, { cleanupError });
      throw combinedError;
    }
    throw error;
  }

  let unresolvedPriorFlowIds: string[];
  try {
    unresolvedPriorFlowIds = supersedePriorParkedWork?.() ?? [];
  } catch (error) {
    log.warn(
      `[continuation] Failed while superseding prior parked work after spawn-init chain finalization for session ${sanitizeForLog(params.sessionKey)}: ${sanitizeForLog(String(error))}`,
    );
    enqueueSystemEvent(
      "[continuation] A newer continue_work wake was scheduled, but prior parked-wake cleanup failed and one or more prior wakes may also run.",
      { sessionKey: params.sessionKey, trusted: true },
    );
    return;
  }
  if (unresolvedPriorFlowIds.length > 0) {
    log.warn(
      `[continuation] Could not supersede prior parked flow(s) after spawn-init chain finalization for session ${sanitizeForLog(params.sessionKey)}: ${unresolvedPriorFlowIds.map(sanitizeForLog).join(", ")}`,
    );
    enqueueSystemEvent(
      "[continuation] A newer continue_work wake was scheduled, but one or more prior parked wakes could not be superseded and may also run.",
      { sessionKey: params.sessionKey, trusted: true },
    );
  }
}
