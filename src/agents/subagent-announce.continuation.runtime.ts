import { dispatchToolDelegates } from "../auto-reply/continuation/delegate-dispatch.js";
import {
  createContinuationOwnerSessionLoader,
  registerContinuationDelegateDispatchClaim,
} from "../auto-reply/continuation/delegate-spawn-authority.js";
import { stagePostCompactionDelegate } from "../auto-reply/continuation/delegate-store-post-compaction.js";
import {
  clearQueuedDelegatesChainTokensFold,
  consumePendingDelegates,
  enqueuePendingDelegate,
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
  revalidatePendingDelegateForSpawn,
} from "../auto-reply/continuation/delegate-store.js";
import { stripContinuationSignal } from "../auto-reply/continuation/signal.js";
import {
  loadContinuationChainState,
  persistContinuationChainState,
} from "../auto-reply/continuation/state.js";
import { hasCrossSessionDelegateTargeting } from "../auto-reply/continuation/targeting-pure.js";
import { scheduleContinuationWorkBatch } from "../auto-reply/continuation/work-dispatch.js";
import { hasLiveOrRecentlyDispatchedContinuationWork } from "../auto-reply/continuation/work-store.js";
import { resolveAgentIdFromSessionKey, resolveSessionStorePathCore } from "../config/sessions.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveContinuationTraceparent } from "../infra/continuation-tracer.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { removeUnacceptedDelegateArtifactPolicy } from "./delegate-artifacts.js";
import {
  type ContinuationChainSource,
  type ContinuationChainState,
  mergeContinuationChainStateFloor,
  parseContinuationChainHop,
  prepareSubagentContinuationAccounting,
} from "./subagent-announce.continuation.accounting.js";
import { deriveContinuationDelegateChildSessionKeyFromParent } from "./subagent-continuation-ids.js";
import { loadSessionEntryByKey } from "./subagents/announce/subagent-announce-delivery.js";
import { resolveContinuationRuntimeConfig } from "./subagents/announce/subagent-announce.runtime.js";
import { getSubagentDepthFromSessionStore } from "./subagents/spawn/subagent-depth.js";
import { spawnSubagentDirect } from "./subagents/spawn/subagent-spawn.js";

export { routeSubagentContinuationReturn } from "./subagent-announce.continuation-return.js";

async function rejectCrossSessionTargeting(params: {
  crossSessionTargeting: "disabled" | "enabled";
  dispatchingSessionKey: string;
  eventSessionKey: string;
  source: "bracket" | "tool";
  targeting: {
    targetSessionKey?: string;
    targetSessionKeys?: readonly string[];
    fanoutMode?: "tree" | "all";
  };
  task: string;
}): Promise<boolean> {
  if (
    params.crossSessionTargeting !== "disabled" ||
    !hasCrossSessionDelegateTargeting(params.targeting, params.dispatchingSessionKey)
  ) {
    return false;
  }
  defaultRuntime.log(
    `[subagent-chain-hop] Cross-session targeting rejected by policy for ${params.source} delegate in session ${params.dispatchingSessionKey}`,
  );
  enqueueSystemEvent(
    "[continuation] Delegate rejected: cross-session targeting is disabled by policy. " +
      'Use the default return target, targetSessionKey set to this session, or fanoutMode="tree". ' +
      `Task: ${params.task}`,
    { sessionKey: params.eventSessionKey, trusted: true },
  );
  return true;
}

async function drainChildContinuationQueue(params: {
  cfg: OpenClawConfig;
  childSessionKey: string;
  requesterOrigin?: DeliveryContext;
  additionalChainTokens?: number;
  dispatchRegardlessOfDelay?: boolean;
  inheritedSilent?: boolean;
  inheritedWake?: boolean;
  chainStateOverride?: ContinuationChainState;
}): Promise<void> {
  if (params.cfg.agents?.defaults?.continuation?.enabled !== true) {
    return;
  }
  try {
    const childEntry = loadSessionEntryByKey(params.childSessionKey);
    const config = resolveContinuationRuntimeConfig(params.cfg);
    const baseChainState = params.chainStateOverride ?? loadContinuationChainState(childEntry);
    const chainState =
      !params.chainStateOverride && (params.additionalChainTokens ?? 0) > 0
        ? {
            ...baseChainState,
            accumulatedChainTokens:
              baseChainState.accumulatedChainTokens + (params.additionalChainTokens ?? 0),
          }
        : baseChainState;
    let chainStateFloor = chainState;
    const loadFreshChainState = () =>
      mergeContinuationChainStateFloor(loadContinuationChainState(childEntry), chainStateFloor);
    const persistAdvancedChainState = async (
      advanced: ContinuationChainState,
    ): Promise<boolean> => {
      chainStateFloor = mergeContinuationChainStateFloor(advanced, chainStateFloor);
      persistContinuationChainState({
        sessionEntry: childEntry,
        count: advanced.currentChainCount,
        startedAt: advanced.chainStartedAt,
        tokens: advanced.accumulatedChainTokens,
        ...(advanced.chainId ? { chainId: advanced.chainId } : {}),
      });
      try {
        const agentId = resolveAgentIdFromSessionKey(params.childSessionKey);
        const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
        const persisted = await updateSessionEntry(
          { agentId, sessionKey: params.childSessionKey, storePath },
          () => ({
            continuationChainCount: advanced.currentChainCount,
            continuationChainStartedAt: advanced.chainStartedAt,
            continuationChainTokens: advanced.accumulatedChainTokens,
            ...(advanced.chainId ? { continuationChainId: advanced.chainId } : {}),
          }),
          { requireWriteSuccess: true },
        );
        if (!persisted) {
          defaultRuntime.error?.(
            `[continuation:drain-persist-missing-entry] child=${params.childSessionKey} advanced chain state was not durably written`,
          );
          return false;
        }
        return true;
      } catch (error) {
        defaultRuntime.error?.(
          `[continuation:drain-persist-failed] child=${params.childSessionKey} error=${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    };

    let forceDispatch = params.dispatchRegardlessOfDelay === true;
    if (params.chainStateOverride) {
      const persisted = await persistAdvancedChainState(chainState);
      forceDispatch ||= !persisted;
      if (persisted) {
        clearQueuedDelegatesChainTokensFold(params.childSessionKey);
      }
    }
    const dispatchResult = await dispatchToolDelegates({
      sessionKey: params.childSessionKey,
      chainState,
      ctx: {
        sessionKey: params.childSessionKey,
        agentChannel: params.requesterOrigin?.channel,
        agentAccountId: params.requesterOrigin?.accountId,
        agentTo: params.requesterOrigin?.to,
        agentThreadId: params.requesterOrigin?.threadId,
      },
      maxChainLength: config.maxChainLength,
      config,
      ...(forceDispatch ? { dispatchQueuedRegardlessOfDelay: true } : {}),
      loadFreshChainState,
      persistChainState: async (advanced) => {
        if (!(await persistAdvancedChainState(advanced))) {
          throw new Error(
            `advanced continuation chain state was not durably persisted for ${params.childSessionKey}`,
          );
        }
      },
      ...(params.inheritedSilent ? { inheritedSilent: true } : {}),
      ...(params.inheritedWake ? { inheritedWake: true } : {}),
    });
    if (
      dispatchResult.dispatched > 0 &&
      (await persistAdvancedChainState(dispatchResult.chainState))
    ) {
      clearQueuedDelegatesChainTokensFold(params.childSessionKey);
    }
  } catch (error) {
    defaultRuntime.error?.(
      `Subagent continuation delegate drain failed for ${params.childSessionKey}: ${String(error)}`,
    );
  }
}

async function scheduleSubagentSelfContinuationWork(params: {
  cfg: OpenClawConfig;
  childSessionKey: string;
  childRunId: string;
  delayMs?: number;
  traceparent?: string;
}): Promise<void> {
  try {
    if (hasLiveOrRecentlyDispatchedContinuationWork(params.childSessionKey)) {
      return;
    }
    const config = resolveContinuationRuntimeConfig(params.cfg);
    const childEntry = loadSessionEntryByKey(params.childSessionKey);
    const result = await scheduleContinuationWorkBatch({
      sessionKey: params.childSessionKey,
      chainState: loadContinuationChainState(childEntry),
      requests: [
        {
          reason: "subagent self-continuation (CONTINUE_WORK token)",
          delaySeconds:
            params.delayMs !== undefined ? params.delayMs / 1000 : config.defaultDelayMs / 1000,
          ...(params.traceparent ? { traceparent: params.traceparent } : {}),
        },
      ],
      config,
      originRunId: params.childRunId,
      originTurnId: params.childSessionKey,
      log: (message) => defaultRuntime.log(message),
    });
    if (result.scheduledCount === 0) {
      return;
    }
    persistContinuationChainState({
      sessionEntry: childEntry,
      count: result.chainState.currentChainCount,
      startedAt: result.chainState.chainStartedAt,
      tokens: result.chainState.accumulatedChainTokens,
      ...(result.chainState.chainId ? { chainId: result.chainState.chainId } : {}),
    });
    const agentId = resolveAgentIdFromSessionKey(params.childSessionKey);
    const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
    const persisted = await updateSessionEntry(
      { agentId, sessionKey: params.childSessionKey, storePath },
      () => ({
        continuationChainCount: result.chainState.currentChainCount,
        continuationChainStartedAt: result.chainState.chainStartedAt,
        continuationChainTokens: result.chainState.accumulatedChainTokens,
        ...(result.chainState.chainId ? { continuationChainId: result.chainState.chainId } : {}),
      }),
      { requireWriteSuccess: true },
    );
    if (!persisted) {
      throw new Error(`child entry not found: ${params.childSessionKey}`);
    }
    defaultRuntime.log(
      `[subagent-chain-hop] Armed self-continuation continue_work wake for ${params.childSessionKey} (hop ${result.chainState.currentChainCount}) from completion-flow findings`,
    );
  } catch (error) {
    defaultRuntime.error?.(
      `[continuation:self-continuation-failed] child=${params.childSessionKey} error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function coordinateSubagentContinuation(params: {
  cfg: OpenClawConfig;
  childSessionKey: string;
  childRunId: string;
  targetRequesterSessionKey: string;
  targetRequesterOrigin?: DeliveryContext;
  task: string;
  findings: string;
  skipAnnounceDelivery: boolean;
  silentAnnounce?: boolean;
  wakeOnReturn?: boolean;
  traceparent?: string;
  loadEntry: (
    sessionKey: string,
    options?: { refresh?: boolean },
  ) => (ContinuationChainSource & { inputTokens?: number; outputTokens?: number }) | undefined;
  invalidateSessionEntry: (sessionKey: string) => void;
}): Promise<{
  findings: string;
  skipAnnounceDelivery: boolean;
  continuationEnabled: boolean;
  isContinuationChainDelegate: boolean;
}> {
  const continuationEnabled = params.cfg.agents?.defaults?.continuation?.enabled === true;
  const accounting = await prepareSubagentContinuationAccounting({
    enabled: continuationEnabled,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.targetRequesterSessionKey,
    task: params.task,
    cfg: params.cfg,
    loadEntry: params.loadEntry,
    invalidateSessionEntry: params.invalidateSessionEntry,
  });
  if (!continuationEnabled) {
    return {
      findings: params.findings,
      skipAnnounceDelivery: params.skipAnnounceDelivery,
      continuationEnabled,
      isContinuationChainDelegate: accounting.isContinuationChainDelegate,
    };
  }

  let findings = params.findings;
  const isChain = accounting.isContinuationChainDelegate;
  const deferInitialDrain =
    isChain && stripContinuationSignal(findings).signal?.kind === "delegate";
  if (!deferInitialDrain) {
    await drainChildContinuationQueue({
      cfg: params.cfg,
      childSessionKey: params.childSessionKey,
      requesterOrigin: params.targetRequesterOrigin,
      additionalChainTokens: accounting.childChainTokensToFold,
      dispatchRegardlessOfDelay: accounting.childChainTokensToFold > 0,
      inheritedSilent: params.silentAnnounce === true,
      inheritedWake: params.wakeOnReturn === true,
    });
  }

  const toolDelegates = isChain ? consumePendingDelegates(params.childSessionKey) : [];
  if (!isChain) {
    const orphaned = consumePendingDelegates(params.childSessionKey);
    if (orphaned.length > 0) {
      defaultRuntime.log(
        `[subagent-chain-hop] WARNING: ${orphaned.length} tool delegate(s) orphaned from non-chain-hop subagent ${params.childSessionKey} — drainsContinuationDelegateQueue was set but task has no chain-hop prefix`,
      );
    }
  }

  let bracketReserved = false;
  let delayedBracketDrainArmed = false;
  const continuationResult = stripContinuationSignal(findings);
  if (continuationResult.signal?.kind === "work") {
    findings = continuationResult.text || "(no output)";
    const traceparent = resolveContinuationTraceparent(params.traceparent);
    await scheduleSubagentSelfContinuationWork({
      cfg: params.cfg,
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
      ...(continuationResult.signal.delayMs !== undefined
        ? { delayMs: continuationResult.signal.delayMs }
        : {}),
      ...(traceparent ? { traceparent } : {}),
    });
  } else if (continuationResult.signal?.kind === "delegate") {
    findings = continuationResult.text || "(no output)";
    const signal = continuationResult.signal;
    const internalTraceparent = resolveContinuationTraceparent(params.traceparent);
    const parentWasSilent = params.silentAnnounce === true;
    const chainSilent = signal.silent || signal.silentWake || parentWasSilent;
    const chainWake = signal.silentWake || (parentWasSilent && params.wakeOnReturn === true);
    if (signal.postCompaction) {
      stagePostCompactionDelegate(params.targetRequesterSessionKey, {
        task: signal.task,
        createdAt: Date.now(),
        ...(signal.targetSessionKey ? { targetSessionKey: signal.targetSessionKey } : {}),
        ...(signal.targetSessionKeys?.length
          ? { targetSessionKeys: signal.targetSessionKeys }
          : {}),
        ...(signal.fanoutMode ? { fanoutMode: signal.fanoutMode } : {}),
        ...(chainSilent ? { silent: true } : {}),
        ...(chainWake ? { silentWake: true } : {}),
        ...(internalTraceparent
          ? { traceparent: internalTraceparent, traceparentProvenance: "internal" as const }
          : {}),
        ...(signal.model ? { model: signal.model } : {}),
      });
      enqueueSystemEvent(
        `[continuation:delegate-staged-post-compaction] Bracket delegate staged for post-compaction release: ${signal.task}`,
        { sessionKey: params.targetRequesterSessionKey, trusted: true },
      );
    } else {
      const config = resolveContinuationRuntimeConfig(params.cfg);
      const childChainHop = parseContinuationChainHop(params.task) ?? 0;
      const nextChainHop = childChainHop + 1;
      const parentEntry = params.loadEntry(params.targetRequesterSessionKey);
      const parentChainTokens =
        (parentEntry?.continuationChainTokens ?? 0) + accounting.parentChainTokensToFold;
      const guardAllowed =
        childChainHop < config.maxChainLength &&
        (config.costCapTokens <= 0 || parentChainTokens <= config.costCapTokens);
      const spawnBracket = async (): Promise<boolean> => {
        if (
          await rejectCrossSessionTargeting({
            crossSessionTargeting: config.crossSessionTargeting,
            dispatchingSessionKey: params.childSessionKey,
            eventSessionKey: params.targetRequesterSessionKey,
            source: "bracket",
            targeting: {
              ...(signal.targetSessionKey ? { targetSessionKey: signal.targetSessionKey } : {}),
              ...(signal.targetSessionKeys?.length
                ? { targetSessionKeys: signal.targetSessionKeys }
                : {}),
              ...(signal.fanoutMode ? { fanoutMode: signal.fanoutMode } : {}),
            },
            task: signal.task,
          })
        ) {
          return false;
        }
        try {
          const childDepth = getSubagentDepthFromSessionStore(params.childSessionKey);
          const spawnResult = await spawnSubagentDirect(
            {
              task: `[continuation:chain-hop:${nextChainHop}] Delegated from sub-agent (depth ${childDepth}): ${signal.task}`,
              ...(chainSilent ? { silentAnnounce: true } : {}),
              ...(chainWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
              ...(signal.targetSessionKey
                ? { continuationTargetSessionKey: signal.targetSessionKey }
                : {}),
              ...(signal.targetSessionKeys?.length
                ? { continuationTargetSessionKeys: signal.targetSessionKeys }
                : {}),
              ...(signal.fanoutMode ? { continuationFanoutMode: signal.fanoutMode } : {}),
              drainsContinuationDelegateQueue: true,
              continuationChainState: accounting.buildChildContinuationSpawnState(nextChainHop),
              ...(signal.model ? { model: signal.model } : {}),
            },
            {
              agentSessionKey: params.targetRequesterSessionKey,
              agentChannel: params.targetRequesterOrigin?.channel ?? undefined,
              agentAccountId: params.targetRequesterOrigin?.accountId ?? undefined,
              agentTo: params.targetRequesterOrigin?.to ?? undefined,
              agentThreadId: params.targetRequesterOrigin?.threadId ?? undefined,
            },
          );
          if (spawnResult.status === "accepted") {
            defaultRuntime.log(
              `[subagent-chain-hop] Spawned chain delegate (${nextChainHop}/${config.maxChainLength}) from ${params.childSessionKey}: ${signal.task.slice(0, 80)}`,
            );
            return true;
          }
          defaultRuntime.log(
            `[subagent-chain-hop] Spawn rejected (${spawnResult.status}) from ${params.childSessionKey} reason=${spawnResult.error ?? "no reason given"}: ${signal.task.slice(0, 80)}`,
          );
          return false;
        } catch (error) {
          defaultRuntime.log(
            `[subagent-chain-hop] Spawn failed from ${params.childSessionKey}: ${String(error)}`,
          );
          return false;
        }
      };
      if (!guardAllowed) {
        defaultRuntime.log(
          childChainHop >= config.maxChainLength
            ? `[subagent-chain-hop] Chain length ${nextChainHop} > ${config.maxChainLength}, rejecting hop from ${params.childSessionKey}`
            : `[subagent-chain-hop] Cost cap exceeded (${parentChainTokens} > ${config.costCapTokens}), rejecting hop from ${params.childSessionKey}`,
        );
      } else if ((signal.delayMs ?? 0) > 0 && accounting.childChainTokensToFold === 0) {
        enqueuePendingDelegate(params.childSessionKey, {
          task: signal.task,
          delayMs: Math.max(config.minDelayMs, Math.min(config.maxDelayMs, signal.delayMs ?? 0)),
          ...(chainWake ? { mode: "silent-wake" } : chainSilent ? { mode: "silent" } : {}),
          ...(params.silentAnnounce ? { inheritedSilent: true } : {}),
          ...(params.silentAnnounce && params.wakeOnReturn ? { inheritedWake: true } : {}),
          ...(signal.targetSessionKey ? { targetSessionKey: signal.targetSessionKey } : {}),
          ...(signal.targetSessionKeys?.length
            ? { targetSessionKeys: signal.targetSessionKeys }
            : {}),
          ...(signal.fanoutMode ? { fanoutMode: signal.fanoutMode } : {}),
          ...(internalTraceparent ? { traceparent: internalTraceparent } : {}),
          ...(signal.model ? { model: signal.model } : {}),
          spawnRequesterSessionKey: params.targetRequesterSessionKey,
          ...(params.targetRequesterOrigin?.channel
            ? { spawnRequesterChannel: params.targetRequesterOrigin.channel }
            : {}),
          ...(params.targetRequesterOrigin?.accountId
            ? { spawnRequesterAccountId: params.targetRequesterOrigin.accountId }
            : {}),
          ...(params.targetRequesterOrigin?.to
            ? { spawnRequesterTo: params.targetRequesterOrigin.to }
            : {}),
          ...(params.targetRequesterOrigin?.threadId !== undefined
            ? { spawnRequesterThreadId: params.targetRequesterOrigin.threadId }
            : {}),
        });
        if (toolDelegates.length === 0) {
          const state = accounting.buildChildContinuationSpawnState(nextChainHop);
          void drainChildContinuationQueue({
            cfg: params.cfg,
            childSessionKey: params.childSessionKey,
            requesterOrigin: params.targetRequesterOrigin,
            chainStateOverride: {
              currentChainCount: state.count,
              chainStartedAt: state.startedAt,
              accumulatedChainTokens: state.tokens,
              chainId: state.chainId,
            },
            inheritedSilent: params.silentAnnounce === true,
            inheritedWake: params.wakeOnReturn === true,
          });
          delayedBracketDrainArmed = true;
        }
      } else if (accounting.childChainTokensToFold > 0 && (signal.delayMs ?? 0) > 0) {
        bracketReserved = await spawnBracket();
      } else {
        bracketReserved = await spawnBracket();
      }
    }
  }

  let postBracketDrainArmed = false;
  if (toolDelegates.length > 0 && isChain) {
    const config = resolveContinuationRuntimeConfig(params.cfg);
    const childChainHop = parseContinuationChainHop(params.task) ?? 0;
    let toolHopBase = childChainHop + (bracketReserved ? 1 : 0);
    for (let index = 0; index < toolDelegates.length; index += 1) {
      const delegate = toolDelegates[index]!;
      const nextHop = toolHopBase + 1;
      const parentEntry = params.loadEntry(params.targetRequesterSessionKey);
      const parentTokens =
        (parentEntry?.continuationChainTokens ?? 0) + accounting.parentChainTokensToFold;
      if (
        nextHop > config.maxChainLength ||
        (config.costCapTokens > 0 && parentTokens > config.costCapTokens)
      ) {
        const summary =
          nextHop > config.maxChainLength
            ? `Tool delegate rejected: chain length ${nextHop} exceeds maxChainLength ${config.maxChainLength}.`
            : `Tool delegate rejected: cost cap exceeded (${parentTokens} > ${config.costCapTokens}).`;
        for (const dropped of toolDelegates.slice(index)) {
          markPendingDelegateFailed(dropped, summary, "Delegate rejected");
        }
        break;
      }
      const parentWasSilent = params.silentAnnounce === true;
      const mode = delegate.mode ?? "normal";
      const toolSilent = mode === "silent" || mode === "silent-wake" || parentWasSilent;
      const toolWake = mode === "silent-wake" || (parentWasSilent && params.wakeOnReturn === true);
      const activeDispatch = registerContinuationDelegateDispatchClaim({
        controller: "pending",
        delegate,
        loadOwnerSessionEntry: createContinuationOwnerSessionLoader(params.childSessionKey),
        ownerSessionKey: params.childSessionKey,
      });
      try {
        if (
          await rejectCrossSessionTargeting({
            crossSessionTargeting: config.crossSessionTargeting,
            dispatchingSessionKey: params.childSessionKey,
            eventSessionKey: params.targetRequesterSessionKey,
            source: "tool",
            targeting: {
              ...(delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {}),
              ...(delegate.targetSessionKeys?.length
                ? { targetSessionKeys: delegate.targetSessionKeys }
                : {}),
              ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
            },
            task: delegate.task,
          })
        ) {
          markPendingDelegateFailed(
            delegate,
            "Tool delegate rejected: cross-session targeting is disabled by policy.",
            "Delegate rejected",
          );
          continue;
        }
        const childDepth = getSubagentDepthFromSessionStore(params.childSessionKey);
        const spawnFence = revalidatePendingDelegateForSpawn(delegate, "pending");
        if (!spawnFence.allowed) {
          if (
            delegate.flowId &&
            (delegate.returnOptions?.artifacts === "optional" ||
              delegate.returnOptions?.artifacts === "required")
          ) {
            removeUnacceptedDelegateArtifactPolicy(delegate.flowId);
          }
          defaultRuntime.log(
            `[continuation:delegate-spawn-fenced] reason=${spawnFence.reason} flowId=${delegate.flowId ?? "unknown"} session=${params.childSessionKey}`,
          );
          enqueueSystemEvent(`[continuation] ${spawnFence.summary} Task: ${delegate.task}`, {
            sessionKey: params.targetRequesterSessionKey,
            trusted: true,
          });
          continue;
        }
        const spawnResult = await spawnSubagentDirect(
          {
            task: `[continuation:chain-hop:${nextHop}] Tool-delegated from sub-agent (depth ${childDepth}): ${delegate.task}`,
            ...(toolSilent ? { silentAnnounce: true } : {}),
            ...(toolWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
            ...(delegate.targetSessionKey
              ? { continuationTargetSessionKey: delegate.targetSessionKey }
              : {}),
            ...(delegate.targetSessionKeys?.length
              ? { continuationTargetSessionKeys: delegate.targetSessionKeys }
              : {}),
            ...(delegate.fanoutMode ? { continuationFanoutMode: delegate.fanoutMode } : {}),
            drainsContinuationDelegateQueue: true,
            continuationChainState: accounting.buildChildContinuationSpawnState(nextHop),
            ...(delegate.flowId ? { continuationDelegateFlowId: delegate.flowId } : {}),
            ...(delegate.model ? { model: delegate.model } : {}),
            ...(delegate.attachments ? { attachments: delegate.attachments } : {}),
            ...(delegate.attachAs?.mountPath
              ? { attachMountPath: delegate.attachAs.mountPath }
              : {}),
          },
          {
            agentSessionKey: params.targetRequesterSessionKey,
            agentChannel: params.targetRequesterOrigin?.channel ?? undefined,
            agentAccountId: params.targetRequesterOrigin?.accountId ?? undefined,
            agentTo: params.targetRequesterOrigin?.to ?? undefined,
            agentThreadId: params.targetRequesterOrigin?.threadId ?? undefined,
            continuationDelegateAdmission: activeDispatch.authority,
          },
        );
        if (spawnResult.status === "accepted") {
          if (delegate.flowId) {
            markPendingDelegateSpawnAccepted(
              delegate,
              spawnResult.childSessionKey ??
                deriveContinuationDelegateChildSessionKeyFromParent(
                  params.targetRequesterSessionKey,
                  delegate.flowId,
                ),
            );
          }
          toolHopBase = nextHop;
        } else if (spawnResult.status !== "cancelled") {
          const reason = spawnResult.error ?? "delegation was not accepted.";
          markPendingDelegateFailed(
            delegate,
            `Tool delegate spawn ${spawnResult.status}: ${reason}`,
            spawnResult.status === "forbidden" ? "Delegate rejected" : "Delegate spawn failed",
          );
          defaultRuntime.log(
            `[subagent-chain-hop] Tool delegate spawn rejected (${spawnResult.status}) from ${params.childSessionKey} reason=${reason}`,
          );
        }
      } catch (error) {
        markPendingDelegateFailed(delegate, `Tool delegate spawn failed: ${String(error)}`);
        defaultRuntime.log(
          `[subagent-chain-hop] Tool delegate spawn failed from ${params.childSessionKey}: ${String(error)}`,
        );
      } finally {
        activeDispatch.release();
      }
    }
    if (deferInitialDrain) {
      const state = accounting.buildChildContinuationSpawnState(toolHopBase);
      postBracketDrainArmed = true;
      void drainChildContinuationQueue({
        cfg: params.cfg,
        childSessionKey: params.childSessionKey,
        requesterOrigin: params.targetRequesterOrigin,
        chainStateOverride: {
          currentChainCount: state.count,
          chainStartedAt: state.startedAt,
          accumulatedChainTokens: state.tokens,
          chainId: state.chainId,
        },
        inheritedSilent: params.silentAnnounce === true,
        inheritedWake: params.wakeOnReturn === true,
      });
    }
  }
  if (deferInitialDrain && !postBracketDrainArmed && !delayedBracketDrainArmed) {
    const state = accounting.buildChildContinuationSpawnState(
      (parseContinuationChainHop(params.task) ?? 0) + (bracketReserved ? 1 : 0),
    );
    void drainChildContinuationQueue({
      cfg: params.cfg,
      childSessionKey: params.childSessionKey,
      requesterOrigin: params.targetRequesterOrigin,
      chainStateOverride: {
        currentChainCount: state.count,
        chainStartedAt: state.startedAt,
        accumulatedChainTokens: state.tokens,
        chainId: state.chainId,
      },
      inheritedSilent: params.silentAnnounce === true,
      inheritedWake: params.wakeOnReturn === true,
    });
  }

  return {
    findings,
    skipAnnounceDelivery: params.skipAnnounceDelivery,
    continuationEnabled,
    isContinuationChainDelegate: isChain,
  };
}
