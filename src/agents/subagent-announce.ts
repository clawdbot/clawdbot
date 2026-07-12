// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
/**
 * Subagent completion announcement coordinator.
 *
 * Captures child output, applies wait outcomes, routes announcements, and performs cleanup decisions.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  annotateQueuedDelegatesChainTokensFold,
  clearQueuedDelegatesChainTokensFold,
  consumePendingDelegates,
  enqueuePendingDelegate,
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
  stagePostCompactionDelegate,
} from "../auto-reply/continuation-delegate-store.js";
import type { ContinuationTrigger } from "../auto-reply/get-reply-options.types.js";
import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripContinuationSignal,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../auto-reply/tokens.js";
import { resolveAgentIdFromSessionKey, resolveStorePath } from "../config/sessions.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveContinuationTraceparent } from "../infra/continuation-tracer.js";
import { generateChainId } from "../infra/secure-random.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { importRuntimeModule } from "../shared/runtime-import.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
  runAnnounceDeliveryWithRetry,
  resolveSubagentAnnounceTimeoutMs,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-delivery.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  applySubagentWaitOutcome,
  buildChildCompletionFindings,
  buildCompactAnnounceStatsLine,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
  readLatestSubagentOutputWithRetry,
  readSubagentOutput,
  type SubagentRunOutcome,
  waitForSubagentRunOutcome,
} from "./subagent-announce-output.js";
import {
  callGateway,
  dispatchGatewayMethodInProcess,
  isEmbeddedAgentRunActive,
  getRuntimeConfig,
  resolveContinuationRuntimeConfig,
  waitForEmbeddedAgentRunEnd,
} from "./subagent-announce.runtime.js";
import { deriveContinuationDelegateChildSessionKeyFromParent } from "./subagent-continuation-ids.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
import { isAnnounceSkip } from "./tools/sessions-send-tokens.js";

type SubagentAnnounceDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
  resolveContinuationRuntimeConfig: typeof resolveContinuationRuntimeConfig;
};

const defaultSubagentAnnounceDeps: SubagentAnnounceDeps = {
  callGateway,
  dispatchGatewayMethodInProcess,
  getRuntimeConfig,
  loadSubagentRegistryRuntime,
  resolveContinuationRuntimeConfig,
};

let subagentAnnounceDeps: SubagentAnnounceDeps = defaultSubagentAnnounceDeps;

let subagentSpawnRuntimePromise: Promise<
  Pick<typeof import("./subagent-spawn.js"), "spawnSubagentDirect">
> | null = null;
const CONTINUATION_CHAIN_HOP_PATTERN = /\[continuation:chain-hop:(\d+)\]/;

function parseContinuationChainHop(task: string): number | undefined {
  const hopText = task.match(CONTINUATION_CHAIN_HOP_PATTERN)?.[1];
  if (!hopText) {
    return undefined;
  }
  const hop = Number.parseInt(hopText, 10);
  return Number.isFinite(hop) ? hop : undefined;
}

function resolveCompletionTraceContext(params: {
  traceparent?: string;
  task: string;
  resolveMaxChainLength: () => number;
}): { traceparent?: string; chainStepRemaining?: number } {
  if (!params.traceparent) {
    return {};
  }
  const childChainHop = parseContinuationChainHop(params.task);
  if (childChainHop === undefined) {
    return { traceparent: params.traceparent };
  }
  const chainStepRemaining = Math.max(0, params.resolveMaxChainLength() - childChainHop);
  return {
    chainStepRemaining,
    ...(chainStepRemaining > 0 ? { traceparent: params.traceparent } : {}),
  };
}

const subagentRegistryRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-announce.registry.runtime.js"),
);

function loadSubagentRegistryRuntime() {
  return subagentRegistryRuntimeLoader.load();
}

function loadSubagentSpawnRuntime() {
  subagentSpawnRuntimePromise ??= import("./subagent-spawn.js");
  return subagentSpawnRuntimePromise;
}

async function listKnownSessionKeysOnHost(
  cfg: ReturnType<typeof getRuntimeConfig>,
): Promise<string[]> {
  const [{ resolveAllAgentSessionStoreTargetsSync }, { loadSessionStore }] = await Promise.all([
    import("../config/sessions/targets.js"),
    import("../config/sessions/store-load.js"),
  ]);
  const keys = new Set<string>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    const store = loadSessionStore(target.storePath);
    for (const key of Object.keys(store)) {
      const normalized = normalizeOptionalString(key);
      if (normalized) {
        keys.add(normalized);
      }
    }
  }
  return [...keys].toSorted();
}

export { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";
export { captureSubagentCompletionReply } from "./subagent-announce-output.js";
export type { SubagentRunOutcome } from "./subagent-announce-output.js";

export type SubagentAnnounceType = "subagent task" | "cron job";

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  silentEnrichment?: boolean;
  silentWakeEnrichment?: boolean;
}): string {
  if (params.requesterIsSubagent) {
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words. Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  if (params.expectsCompletionMessage) {
    return `A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type). Reply ONLY: ${SILENT_REPLY_TOKEN} only when this exact result is already visible to the user in this same turn.`;
  }
  return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}

function buildAnnounceSteerMessage(events: AgentInternalEvent[]): string {
  return (
    formatAgentInternalEventsForPrompt(events) ||
    "A background task finished. Process the completion update now."
  );
}

function hasUsableSessionEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const sessionId = (entry as { sessionId?: unknown }).sessionId;
  return typeof sessionId !== "string" || sessionId.trim() !== "";
}

// Structural shapes for the continuation modules loaded via
// `importRuntimeModule`. Defined locally so no static edge leads from this
// file to `auto-reply/continuation/*` — that would close an import cycle
// through `delegate-dispatch → subagent-spawn → subagent-registry →
// subagent-announce`.
type ContinuationChainState = {
  currentChainCount: number;
  chainStartedAt: number;
  accumulatedChainTokens: number;
  chainId?: string;
};

type ContinuationDispatchContext = {
  sessionKey: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
};

type ContinuationDispatchTargeting = {
  targetSessionKey?: string;
  targetSessionKeys?: readonly string[];
  fanoutMode?: "tree" | "all";
};

type ContinuationDispatchModule = {
  dispatchToolDelegates: (params: {
    sessionKey: string;
    chainState: ContinuationChainState;
    ctx: ContinuationDispatchContext;
    maxChainLength: number;
    dispatchQueuedRegardlessOfDelay?: boolean;
    loadFreshChainState?: () => ContinuationChainState;
    persistChainState?: (chainState: ContinuationChainState) => void | Promise<void>;
    inheritedSilent?: boolean;
    inheritedWake?: boolean;
  }) => Promise<{
    dispatched: number;
    rejected: number;
    chainState: ContinuationChainState;
  }>;
};

type ContinuationChainSource = {
  continuationChainCount?: number;
  continuationChainStartedAt?: number;
  continuationChainTokens?: number;
  continuationChainId?: string;
};

function mergeContinuationChainStateFloor(
  current: ContinuationChainState,
  floor: ContinuationChainState,
): ContinuationChainState {
  return {
    currentChainCount: Math.max(current.currentChainCount, floor.currentChainCount),
    chainStartedAt:
      current.currentChainCount > 0 || current.accumulatedChainTokens > 0
        ? current.chainStartedAt
        : floor.chainStartedAt,
    accumulatedChainTokens: Math.max(current.accumulatedChainTokens, floor.accumulatedChainTokens),
    ...((current.chainId ?? floor.chainId) ? { chainId: current.chainId ?? floor.chainId } : {}),
  };
}

type ContinuationStateModule = {
  loadContinuationChainState: (
    source: ContinuationChainSource | undefined,
    turnTokens?: number,
  ) => ContinuationChainState;
  persistContinuationChainState: (params: {
    sessionEntry?: ContinuationChainSource;
    count: number;
    startedAt: number;
    tokens: number;
    chainId?: string;
  }) => void;
};

type SessionStoreUpdateModule = {
  updateSessionEntry: (
    scope: { agentId?: string; sessionKey: string; storePath?: string },
    update: (
      entry: ContinuationChainSource & Record<string, unknown>,
    ) => Partial<ContinuationChainSource> | null,
    options?: { requireWriteSuccess?: boolean },
  ) => Promise<(ContinuationChainSource & Record<string, unknown>) | null>;
  resolveStorePath: (store: unknown, options: { agentId: string }) => string;
  resolveAgentIdFromSessionKey: (sessionKey: string) => string;
};

type ContinuationWorkModule = {
  scheduleContinuationWorkBatch: (params: {
    sessionKey: string;
    chainState: ContinuationChainState;
    requests: readonly { reason: string; delaySeconds: number; traceparent?: string }[];
    config: ReturnType<typeof resolveContinuationRuntimeConfig>;
    parentRunId?: string;
    originRunId?: string;
    originTurnId?: string;
    log?: (message: string) => void;
  }) => Promise<{
    scheduledCount: number;
    cappedCount: number;
    capped: boolean;
    chainState: ContinuationChainState;
  }>;
  hasLiveOrRecentlyDispatchedContinuationWork: (sessionKey: string) => boolean;
};

async function rejectCrossSessionTargetingForSubagentDispatch(params: {
  crossSessionTargeting: "disabled" | "enabled";
  dispatchingSessionKey: string;
  eventSessionKey: string;
  source: "bracket" | "tool";
  targeting: ContinuationDispatchTargeting;
  task: string;
}): Promise<boolean> {
  if (params.crossSessionTargeting !== "disabled") {
    return false;
  }
  if (
    !params.targeting.targetSessionKey &&
    (!params.targeting.targetSessionKeys || params.targeting.targetSessionKeys.length === 0) &&
    !params.targeting.fanoutMode
  ) {
    return false;
  }
  const { hasCrossSessionDelegateTargeting } =
    await import("../auto-reply/continuation/targeting-pure.js");
  if (!hasCrossSessionDelegateTargeting(params.targeting, params.dispatchingSessionKey)) {
    return false;
  }
  const { enqueueSystemEvent } = await import("../infra/system-events.js");
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

/**
 * Drain the child session's continue_delegate queue after the subagent has
 * settled. Chain state is inherited from the child session entry so nested
 * hops stay sequential across the chain. Best-effort — dispatch failures
 * are logged and swallowed so they cannot break the announce path.
 */
async function drainChildContinuationQueue(params: {
  childSessionKey: string;
  requesterOrigin?: DeliveryContext;
  /**
   * Fallback in-memory fold of the settled child's own run cost, passed ONLY
   * when the durable persist of that cost into the child entry failed (see the
   * accumulation block in runSubagentAnnounceFlow). 0 in the normal path — the
   * drain then reads the post-run basis straight from the persisted child entry,
   * so the two are never combined and the basis is never double-counted (#1144).
   */
  additionalChainTokens?: number;
  /**
   * Fail-closed with `additionalChainTokens`: when the durable child chain-cost
   * persist failed, dispatch queued delegates immediately (ignore their delay)
   * on the in-memory folded basis instead of leaving delayed ones durably
   * queued, where restart recovery would rebuild their cost basis from the stale
   * child entry and under-enforce the cost cap (#1144).
   */
  dispatchRegardlessOfDelay?: boolean;
  /**
   * Inherited silent/wake policy from the settled parent run. When the parent
   * was silent (or silent-wake), a default-mode delegate the child queued must
   * still spawn internal (and wake on return) instead of announcing to the
   * channel. This early drain runs BEFORE the later chain-hop guards that apply
   * `parentWasSilent`, so the policy is threaded through here to keep
   * descendants of a silent/wake chain internal (#1158).
   */
  inheritedSilent?: boolean;
  inheritedWake?: boolean;
  chainStateOverride?: ContinuationChainState;
}): Promise<void> {
  let cfg: ReturnType<typeof subagentAnnounceDeps.getRuntimeConfig>;
  try {
    cfg = subagentAnnounceDeps.getRuntimeConfig();
  } catch (err) {
    // Config-load failure here silently drops the child's delegate drain.
    // Surface it via the file's existing defaultRuntime.error
    // pattern so operators can see why a chain stopped after a subagent
    // settled.
    defaultRuntime.error?.(
      `[continuation:drain-config-load-failed] child=${params.childSessionKey} error=${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (cfg?.agents?.defaults?.continuation?.enabled !== true) {
    return;
  }
  try {
    // `importRuntimeModule` constructs the module URL at call time, keeping
    // `delegate-dispatch.js` off the static import graph. Direct `await import()`
    // with a literal path would pull `subagent-spawn.js` into a cycle via
    // `delegate-dispatch.js → subagent-spawn.js → subagent-registry.js →
    // subagent-announce.ts`.
    const [dispatchModule, stateModule, sessionStoreModule] = await Promise.all([
      importRuntimeModule<ContinuationDispatchModule>(import.meta.url, [
        "./subagent-announce.continuation.runtime",
        ".js",
      ]),
      importRuntimeModule<ContinuationStateModule>(import.meta.url, [
        "./subagent-announce.continuation.runtime",
        ".js",
      ]),
      importRuntimeModule<SessionStoreUpdateModule>(import.meta.url, [
        "./subagent-announce.continuation.runtime",
        ".js",
      ]),
    ]);
    const { dispatchToolDelegates } = dispatchModule;
    const { loadContinuationChainState, persistContinuationChainState } = stateModule;
    const {
      updateSessionEntry: updateSessionEntryLazy,
      resolveStorePath: resolveStorePathLazy,
      resolveAgentIdFromSessionKey: resolveAgentIdFromSessionKeyLazy,
    } = sessionStoreModule;
    const childEntry = loadSessionEntryByKey(params.childSessionKey) as
      | ContinuationChainSource
      | undefined;
    const dispatchConfig = subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg);
    // The settled child's own run cost is normally folded into the child entry's
    // durable `continuationChainTokens` at accumulation time, so this drain, the
    // hedge re-arm, and restart recovery all read the SAME post-run cost basis
    // from the persisted entry. `additionalChainTokens` is non-zero ONLY as the
    // persist-failure fallback: it re-applies the run cost in memory here so the
    // cost cap still enforces this turn even when the durable write did not land
    // (fails closed). Normal path passes 0, so the two are never combined (#1144).
    const baseChainState = params.chainStateOverride ?? loadContinuationChainState(childEntry);
    const chainState =
      !params.chainStateOverride && params.additionalChainTokens && params.additionalChainTokens > 0
        ? {
            ...baseChainState,
            accumulatedChainTokens:
              baseChainState.accumulatedChainTokens + params.additionalChainTokens,
          }
        : baseChainState;
    let chainStateFloor = chainState;
    const loadFreshChildChainState = (): ContinuationChainState =>
      mergeContinuationChainStateFloor(loadContinuationChainState(childEntry), chainStateFloor);
    const childEntryForWrite = childEntry as
      | (ContinuationChainSource & Record<string, unknown>)
      | undefined;
    // Persist the advanced child chain state to BOTH the in-memory entry (so a
    // subsequent hedge re-arm / drain reads the advanced basis) and the durable
    // session store (so it survives gateway restart). Shared by the synchronous
    // drain below AND the hedge-fired dispatch: a delayed delegate that only arms
    // a hedge here would otherwise advance only the pre-spawn snapshot, so
    // multiple delayed delegates hedge-fire against the stale count and bypass
    // maxChainLength / the cost cap. Mirrors the main-runner / followup-runner
    // persist patterns (#1158).
    const persistAdvancedChildChainState = async (
      advanced: ContinuationChainState,
    ): Promise<boolean> => {
      chainStateFloor = mergeContinuationChainStateFloor(advanced, chainStateFloor);
      // In-memory mirror so any post-drain reads of the same entry (incl. the
      // hedge's loadFreshChainState) see the advanced state immediately.
      persistContinuationChainState({
        sessionEntry: childEntryForWrite,
        count: advanced.currentChainCount,
        startedAt: advanced.chainStartedAt,
        tokens: advanced.accumulatedChainTokens,
        // Carry the advanced/minted chain id so a later child drain reloads it
        // instead of re-minting a fresh one (stable chain correlation).
        ...(advanced.chainId ? { chainId: advanced.chainId } : {}),
      });
      try {
        const agentId = resolveAgentIdFromSessionKeyLazy(params.childSessionKey);
        const storePath = resolveStorePathLazy(cfg.session?.store, { agentId });
        const persisted = await updateSessionEntryLazy(
          { agentId, sessionKey: params.childSessionKey, storePath },
          () => ({
            continuationChainCount: advanced.currentChainCount,
            continuationChainStartedAt: advanced.chainStartedAt,
            continuationChainTokens: advanced.accumulatedChainTokens,
            // Persist the chain id to disk too so it survives gateway restart /
            // cache eviction and the next drain does not re-mint a fresh id.
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
      } catch (writeErr) {
        defaultRuntime.error?.(
          `[continuation:drain-persist-failed] child=${params.childSessionKey} error=${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        );
        return false;
      }
    };
    let forceDispatchRegardlessOfDelay = params.dispatchRegardlessOfDelay === true;
    if (params.chainStateOverride) {
      const overridePersisted = await persistAdvancedChildChainState(chainState);
      forceDispatchRegardlessOfDelay ||= !overridePersisted;
      if (overridePersisted) {
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
      maxChainLength: dispatchConfig.maxChainLength,
      ...(forceDispatchRegardlessOfDelay ? { dispatchQueuedRegardlessOfDelay: true } : {}),
      // A hedge-fired dispatch (delayed delegate) runs with no enclosing runner
      // frame, so supply the fresh-load + persist callbacks the shared hedge
      // needs to advance the child chain state durably across fires (#1158).
      loadFreshChainState: loadFreshChildChainState,
      persistChainState: async (advanced) => {
        const persisted = await persistAdvancedChildChainState(advanced);
        if (!persisted) {
          throw new Error(
            `advanced continuation chain state was not durably persisted for ${params.childSessionKey}`,
          );
        }
      },
      // Descendants of a silent/wake parent chain must stay internal even though
      // this drain runs before the later parentWasSilent chain-hop guards (#1158).
      ...(params.inheritedSilent ? { inheritedSilent: true } : {}),
      ...(params.inheritedWake ? { inheritedWake: true } : {}),
    });

    // Persist the advanced child chain state after a synchronous (matured)
    // drain. Without this, child `continuationChainCount/StartedAt/Tokens`
    // never advances after accepted spawns; later drains reload stale counters
    // and under-enforce `maxChainLength`. The hedge path persists itself via the
    // persistChainState callback above.
    if (dispatchResult && dispatchResult.dispatched > 0) {
      const persisted = await persistAdvancedChildChainState(dispatchResult.chainState);
      if (persisted) {
        clearQueuedDelegatesChainTokensFold(params.childSessionKey);
      }
    }
  } catch (err) {
    defaultRuntime.error?.(
      `Subagent continuation delegate drain failed for ${params.childSessionKey}: ${String(err)}`,
    );
  }
}

/**
 * Arm a same-session continue_work wake for a completing subagent whose final
 * findings carry a bare CONTINUE_WORK token (a self-continuation: the child
 * claims its own next turn).
 *
 * The spawn-init / turn-1 path (attempt-execution.ts) is the primary site that
 * arms this wake, reading the token from the run-result payloads. This
 * completion-flow path reads the canonical transcript findings instead, so it
 * closes the gap when the payload-based path could not see the token (e.g. a
 * reply-transform hook rewrote the payloads, or the final payload was
 * classified silent). The liveness guard makes it a strict fallback: when a
 * same-session wake is already queued/running it does nothing, so the two paths
 * never double-arm the child's next turn (#952). Best-effort — scheduling
 * failures are logged and swallowed so they cannot break the announce path.
 */
async function scheduleSubagentSelfContinuationWork(params: {
  childSessionKey: string;
  childRunId: string;
  delayMs?: number;
  traceparent?: string;
  cfg: ReturnType<typeof subagentAnnounceDeps.getRuntimeConfig>;
}): Promise<void> {
  try {
    const [workModule, stateModule, sessionStoreModule] = await Promise.all([
      importRuntimeModule<ContinuationWorkModule>(import.meta.url, [
        "./subagent-announce.continuation.runtime",
        ".js",
      ]),
      importRuntimeModule<ContinuationStateModule>(import.meta.url, [
        "./subagent-announce.continuation.runtime",
        ".js",
      ]),
      importRuntimeModule<SessionStoreUpdateModule>(import.meta.url, [
        "./subagent-announce.continuation.runtime",
        ".js",
      ]),
    ]);
    const { scheduleContinuationWorkBatch, hasLiveOrRecentlyDispatchedContinuationWork } =
      workModule;
    // Strict fallback: the spawn-init/turn-1 path already owns the wake in the
    // common case, so never arm a second one for the same child session.
    if (hasLiveOrRecentlyDispatchedContinuationWork(params.childSessionKey)) {
      return;
    }
    const { loadContinuationChainState, persistContinuationChainState } = stateModule;
    const {
      updateSessionEntry: updateSessionEntryLazy,
      resolveStorePath: resolveStorePathLazy,
      resolveAgentIdFromSessionKey: resolveAgentIdFromSessionKeyLazy,
    } = sessionStoreModule;
    const config = subagentAnnounceDeps.resolveContinuationRuntimeConfig(params.cfg);
    const childEntry = loadSessionEntryByKey(params.childSessionKey) as
      | (ContinuationChainSource & Record<string, unknown>)
      | undefined;
    const delaySeconds =
      params.delayMs !== undefined ? params.delayMs / 1000 : config.defaultDelayMs / 1000;
    const result = await scheduleContinuationWorkBatch({
      sessionKey: params.childSessionKey,
      chainState: loadContinuationChainState(childEntry),
      requests: [
        {
          reason: "subagent self-continuation (CONTINUE_WORK token)",
          delaySeconds,
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
    defaultRuntime.log(
      `[subagent-chain-hop] Armed self-continuation continue_work wake for ${params.childSessionKey} (hop ${result.chainState.currentChainCount}) from completion-flow findings`,
    );
    // Advance the child chain state so a later self-continuation re-enforces the
    // chain/cost cap from the right baseline. Mirror the delegate-drain persist.
    persistContinuationChainState({
      sessionEntry: childEntry,
      count: result.chainState.currentChainCount,
      startedAt: result.chainState.chainStartedAt,
      tokens: result.chainState.accumulatedChainTokens,
      ...(result.chainState.chainId ? { chainId: result.chainState.chainId } : {}),
    });
    try {
      const agentId = resolveAgentIdFromSessionKeyLazy(params.childSessionKey);
      const storePath = resolveStorePathLazy(params.cfg.session?.store, { agentId });
      const persisted = await updateSessionEntryLazy(
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
    } catch (writeErr) {
      defaultRuntime.error?.(
        `[continuation:self-continuation-persist-failed] child=${params.childSessionKey} error=${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
      );
    }
  } catch (err) {
    defaultRuntime.error?.(
      `[continuation:self-continuation-failed] child=${params.childSessionKey} error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function buildDescendantWakeMessage(params: { findings: string; taskLabel: string }): string {
  return [
    "[Subagent Context] Your prior run ended while waiting for descendant subagent completions.",
    "[Subagent Context] All pending descendants for that run have now settled.",
    "[Subagent Context] Continue your workflow using these results. Spawn more subagents if needed, otherwise send your final answer.",
    "",
    `Task: ${params.taskLabel}`,
    "",
    params.findings,
  ].join("\n");
}

const WAKE_RUN_SUFFIX = ":wake";

function stripWakeRunSuffixes(runId: string): string {
  let next = runId.trim();
  while (next.endsWith(WAKE_RUN_SUFFIX)) {
    next = next.slice(0, -WAKE_RUN_SUFFIX.length);
  }
  return next || runId.trim();
}

function isWakeContinuationRun(runId: string): boolean {
  const trimmed = runId.trim();
  if (!trimmed) {
    return false;
  }
  return stripWakeRunSuffixes(trimmed) !== trimmed;
}

function stripAndClassifyReply(text: string): string | null {
  let result = text;
  let didStrip = false;
  const hasLeadingSilentToken = startsWithSilentToken(result, SILENT_REPLY_TOKEN);
  if (hasLeadingSilentToken) {
    result = stripLeadingSilentToken(result, SILENT_REPLY_TOKEN);
    didStrip = true;
  }
  if (hasLeadingSilentToken || result.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())) {
    result = stripSilentToken(result, SILENT_REPLY_TOKEN);
    didStrip = true;
  }
  if (
    didStrip &&
    (!result.trim() || isSilentReplyText(result, SILENT_REPLY_TOKEN) || isAnnounceSkip(result))
  ) {
    return null;
  }
  return result;
}

async function wakeSubagentRunAfterDescendants(params: {
  runId: string;
  childSessionKey: string;
  taskLabel: string;
  findings: string;
  announceId: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }

  const childEntry = loadSessionEntryByKey(params.childSessionKey);
  if (!hasUsableSessionEntry(childEntry)) {
    return false;
  }

  const cfg = subagentAnnounceDeps.getRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const wakeMessage = buildDescendantWakeMessage({
    findings: params.findings,
    taskLabel: params.taskLabel,
  });

  let wakeRunId;
  try {
    const wakeResponse = await runAnnounceDeliveryWithRetry<{ runId?: string }>({
      operation: "descendant wake agent call",
      signal: params.signal,
      run: async () =>
        await subagentAnnounceDeps.dispatchGatewayMethodInProcess(
          "agent",
          {
            sessionKey: params.childSessionKey,
            message: wakeMessage,
            deliver: false,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: params.childSessionKey,
              sourceChannel: INTERNAL_MESSAGE_CHANNEL,
              sourceTool: "subagent_announce",
            },
            idempotencyKey: buildAnnounceIdempotencyKey(`${params.announceId}:wake`),
          },
          {
            timeoutMs: announceTimeoutMs,
          },
        ),
    });
    wakeRunId = normalizeOptionalString(wakeResponse?.runId) ?? "";
  } catch {
    return false;
  }

  if (!wakeRunId) {
    return false;
  }

  const { replaceSubagentRunAfterSteer } = await loadSubagentRegistryRuntime();
  return replaceSubagentRunAfterSteer({
    previousRunId: params.runId,
    nextRunId: wakeRunId,
    preserveFrozenResultFallback: true,
    // Persist the wake message as the replacement run's task so that any
    // post-restart redispatch reconstructs the correct prompt.
    task: wakeMessage,
  });
}

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  /**
   * Fallback text preserved from the pre-wake run when a wake continuation
   * completes with NO_REPLY despite an earlier final summary already existing.
   */
  fallbackReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
  announceType?: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  signal?: AbortSignal;
  bestEffortDeliver?: boolean;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  /** When true, deliver completion as a silent system event instead of a
   *  visible channel message. Used for ambient enrichment (DELEGATE | silent). */
  silentAnnounce?: boolean;
  /** When true (with silentAnnounce), trigger a generation cycle on the parent
   *  session after enrichment delivery. Enables autonomous cognition loops
   *  (DELEGATE | silent-wake). */
  wakeOnReturn?: boolean;
  continuationTargetSessionKey?: string;
  continuationTargetSessionKeys?: string[];
  continuationFanoutMode?: "tree" | "all";
  traceparent?: string;
  onBeforeDeleteChildSession?: () => boolean;
}): Promise<boolean> {
  let didAnnounce = false;
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  const announceType = params.announceType ?? "subagent task";
  let shouldDeleteChildSession = params.cleanup === "delete";
  try {
    const sessionEntryCache = new Map<string, ReturnType<typeof loadSessionEntryByKey>>();
    const requesterEntryCache = new Map<string, ReturnType<typeof loadRequesterSessionEntry>>();
    const readSessionEntryByKey = (sessionKey: string, options?: { refresh?: boolean }) => {
      if (options?.refresh || !sessionEntryCache.has(sessionKey)) {
        sessionEntryCache.set(sessionKey, loadSessionEntryByKey(sessionKey));
      }
      return sessionEntryCache.get(sessionKey);
    };
    const readRequesterSessionEntry = (
      requesterSessionKey: string,
      options?: { refresh?: boolean },
    ) => {
      if (options?.refresh || !requesterEntryCache.has(requesterSessionKey)) {
        requesterEntryCache.set(
          requesterSessionKey,
          loadRequesterSessionEntry(requesterSessionKey),
        );
      }
      return requesterEntryCache.get(requesterSessionKey)!;
    };
    const invalidateSessionEntry = (sessionKey: string) => {
      sessionEntryCache.delete(sessionKey);
      requesterEntryCache.delete(sessionKey);
    };

    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionId = (() => {
      const entry = readSessionEntryByKey(params.childSessionKey);
      return typeof entry?.sessionId === "string" && entry.sessionId.trim()
        ? entry.sessionId.trim()
        : undefined;
    })();
    const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 120_000);
    let reply = params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    if (childSessionId && isEmbeddedAgentRunActive(childSessionId)) {
      const settled = await waitForEmbeddedAgentRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedAgentRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        // Keep delete cleanup retryable until the active child can be removed.
        if (outcome?.status !== "timeout" || params.cleanup === "delete") {
          return false;
        }
      }
    }

    if (!reply && params.waitForCompletion !== false) {
      const wait = await waitForSubagentRunOutcome(params.childRunId, settleTimeoutMs);
      const applied = applySubagentWaitOutcome({
        wait,
        outcome,
        startedAt: params.startedAt,
        endedAt: params.endedAt,
      });
      outcome = applied.outcome;
      params.startedAt = applied.startedAt;
      params.endedAt = applied.endedAt;
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }
    const failedTerminalOutcome = outcome.status === "error";
    const allowFailedOutputCapture =
      !failedTerminalOutcome || (!params.roundOneReply && !params.fallbackReply);
    if (failedTerminalOutcome) {
      reply = undefined;
    }

    let requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
    const requesterIsInternalSession = () =>
      requesterDepth >= 1 || isCronSessionKey(targetRequesterSessionKey);

    let childCompletionFindings: string | undefined;
    let subagentRegistryRuntime:
      | Awaited<ReturnType<typeof loadSubagentRegistryRuntime>>
      | undefined;
    try {
      subagentRegistryRuntime = await subagentAnnounceDeps.loadSubagentRegistryRuntime();
      const runtime = subagentRegistryRuntime;
      const refreshRequesterTarget = () => {
        if (!requesterIsInternalSession()) {
          return { ok: true } as const;
        }
        if (runtime.isSubagentSessionRunActive(targetRequesterSessionKey)) {
          return { ok: true } as const;
        }
        if (runtime.shouldIgnorePostCompletionAnnounceForSession(targetRequesterSessionKey)) {
          return { ok: false, ignored: true } as const;
        }
        const parentSessionEntry = readSessionEntryByKey(targetRequesterSessionKey);
        if (hasUsableSessionEntry(parentSessionEntry)) {
          return { ok: true } as const;
        }
        const fallback = runtime.resolveRequesterForChildSession(targetRequesterSessionKey);
        if (!fallback?.requesterSessionKey) {
          return { ok: false, missing: true } as const;
        }
        targetRequesterSessionKey = fallback.requesterSessionKey;
        targetRequesterOrigin =
          normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
        requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
        return { ok: true } as const;
      };
      const requesterTarget = refreshRequesterTarget();
      if (!requesterTarget.ok) {
        if (requesterTarget.ignored) {
          return true;
        }
        shouldDeleteChildSession = false;
        return false;
      }

      const pendingChildDescendantRuns = Math.max(
        0,
        subagentRegistryRuntime.countPendingDescendantRuns(params.childSessionKey),
      );
      if (pendingChildDescendantRuns > 0 && announceType !== "cron job") {
        shouldDeleteChildSession = false;
        return false;
      }

      if (typeof subagentRegistryRuntime.listSubagentRunsForRequester === "function") {
        const directChildren = subagentRegistryRuntime.listSubagentRunsForRequester(
          params.childSessionKey,
          {
            requesterRunId: params.childRunId,
          },
        );
        if (Array.isArray(directChildren) && directChildren.length > 0) {
          childCompletionFindings = buildChildCompletionFindings(
            dedupeLatestChildCompletionRows(
              filterCurrentDirectChildCompletionRows(directChildren, {
                requesterSessionKey: params.childSessionKey,
                getLatestSubagentRunByChildSessionKey:
                  subagentRegistryRuntime.getLatestSubagentRunByChildSessionKey,
              }),
            ),
          );
        }
      }
    } catch {
      // Best-effort only.
    }

    const announceId = buildAnnounceIdFromChildRun({
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
    });

    const childRunAlreadyWoken = isWakeContinuationRun(params.childRunId);
    if (
      params.wakeOnDescendantSettle === true &&
      childCompletionFindings?.trim() &&
      !childRunAlreadyWoken
    ) {
      const wakeAnnounceId = buildAnnounceIdFromChildRun({
        childSessionKey: params.childSessionKey,
        childRunId: stripWakeRunSuffixes(params.childRunId),
      });
      const woke = await wakeSubagentRunAfterDescendants({
        runId: params.childRunId,
        childSessionKey: params.childSessionKey,
        taskLabel: params.label || params.task || "task",
        findings: childCompletionFindings,
        announceId: wakeAnnounceId,
        signal: params.signal,
      });
      if (woke) {
        shouldDeleteChildSession = false;
        return true;
      }
    }

    // Track whether the announce delivery should be skipped (silent/skip reply
    // with no fallback). Declared here so chain-hop accounting below still runs.
    let skipAnnounceDelivery = false;

    if (childCompletionFindings?.trim()) {
      // Descendant completions were synthesized successfully; announce that
      // result upward unless we converted it into a wake continuation above.
      reply = childCompletionFindings;
    } else {
      const fallbackReply = failedTerminalOutcome
        ? undefined
        : normalizeOptionalString(params.fallbackReply);
      const fallbackIsSilent =
        Boolean(fallbackReply) &&
        (isAnnounceSkip(fallbackReply) || isSilentReplyText(fallbackReply, SILENT_REPLY_TOKEN));

      if (!reply && allowFailedOutputCapture) {
        reply = await readSubagentOutput(params.childSessionKey, outcome);
      }

      if (!reply?.trim() && allowFailedOutputCapture) {
        reply = await readLatestSubagentOutputWithRetry({
          sessionKey: params.childSessionKey,
          maxWaitMs: params.timeoutMs,
          outcome,
        });
      }

      if (!reply?.trim() && fallbackReply && !fallbackIsSilent) {
        reply = fallbackReply;
      }

      // A worker can finish just after the first wait request timed out.
      // If we already have real completion content, do one cached recheck so
      // the final completion event prefers the authoritative terminal state.
      // This is best-effort; if the recheck fails, keep the known timeout
      // outcome instead of dropping the announcement entirely.
      if (outcome?.status === "timeout" && reply?.trim() && params.waitForCompletion !== false) {
        try {
          const rechecked = await waitForSubagentRunOutcome(params.childRunId, 0);
          const applied = applySubagentWaitOutcome({
            wait: rechecked,
            outcome,
            startedAt: params.startedAt,
            endedAt: params.endedAt,
          });
          outcome = applied.outcome;
          params.startedAt = applied.startedAt;
          params.endedAt = applied.endedAt;
        } catch {
          // Best-effort recheck; keep the existing timeout outcome on failure.
        }
      }

      if (isAnnounceSkip(reply) || isSilentReplyText(reply, SILENT_REPLY_TOKEN)) {
        if (fallbackReply && !fallbackIsSilent) {
          const cleaned = stripAndClassifyReply(fallbackReply);
          if (cleaned === null) {
            if (isAnnounceSkip(reply) && isCronSessionKey(targetRequesterSessionKey)) {
              logWarn(
                `cron job completion for session=${targetRequesterSessionKey} ` +
                  `run=${params.childRunId} suppressed by ANNOUNCE_SKIP; ` +
                  `the agent replied with the skip sentinel instead of delivering a result`,
              );
            }
            return true;
          }
          reply = cleaned;
        } else {
          if (isAnnounceSkip(reply) && isCronSessionKey(targetRequesterSessionKey)) {
            logWarn(
              `cron job completion for session=${targetRequesterSessionKey} ` +
                `run=${params.childRunId} suppressed by ANNOUNCE_SKIP; ` +
                `the agent replied with the skip sentinel instead of delivering a result`,
            );
          }
          // Do NOT early-return here — fall through to chain-hop accounting
          // below so that token accumulation, chain guards, and tool-delegate
          // consumption still run for silent/skip replies. Without this,
          // subagents that reply with NO_REPLY bypass cost-cap enforcement
          // and chain-hop accounting entirely.
          skipAnnounceDelivery = true;
        }
      } else if (reply) {
        const cleaned = stripAndClassifyReply(reply);
        if (cleaned === null) {
          if (fallbackReply && !fallbackIsSilent) {
            const cleanedFallback = stripAndClassifyReply(fallbackReply);
            if (cleanedFallback === null) {
              return true;
            }
            reply = cleanedFallback;
          } else {
            return true;
          }
        } else {
          reply = cleaned;
        }
      }
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    // Build status label
    const statusLabel =
      outcome.status === "ok"
        ? "completed; ready for parent review"
        : outcome.status === "timeout"
          ? "timed out"
          : outcome.status === "error"
            ? `failed: ${outcome.error || "unknown error"}`
            : "finished with unknown status";

    const taskLabel = params.label || params.task || "task";
    const announceSessionId = childSessionId || "unknown";
    let findings = reply || "(no output)";
    if (
      childCompletionFindings?.trim() &&
      findings !== "(no output)" &&
      findings !== childCompletionFindings
    ) {
      findings = `${findings}\n\n[Descendant completions]\n${childCompletionFindings}`;
    }

    // --- Sub-agent continuation chain: accumulate child token cost + parse [[CONTINUE_DELEGATE:]] ---
    const cfg = subagentAnnounceDeps.getRuntimeConfig();
    const continuationEnabled = cfg?.agents?.defaults?.continuation?.enabled === true;

    // Accumulate the completing shard's token cost unconditionally on delegate-return,
    // even if the child doesn't emit another [[CONTINUE_DELEGATE:]]. Without this,
    // children that finish normally leak their tokens from the chain budget.
    const childTask = params.task ?? "";
    const isContinuationChainDelegate = CONTINUATION_CHAIN_HOP_PATTERN.test(childTask);
    let accumulatedChildTokens = 0;
    // #1144: the child's own run cost is normally persisted into the child
    // entry's `continuationChainTokens` below, and the drain reads that durable
    // basis (single source of truth, no in-memory fold). If that persist FAILS,
    // the persisted basis is stale (missing this run), so fall back to folding
    // the run cost into the drain's in-memory cost basis instead — the live cost
    // cap then still enforces against the post-run total. Stays 0 when the
    // persist succeeds, so the basis is never double-counted in the normal path;
    // a fallback double-count would only over-estimate cost (fails closed).
    let childChainTokensToFold = 0;
    // Companion to childChainTokensToFold for the PARENT-entry persist: the
    // bracket/tool chain guard reads the requester (parent) chain cost, which is
    // stale if the parent accumulation persist failed. When it fails this holds
    // the run cost so the guard folds it in-memory and cannot under-enforce the
    // cost cap; 0 when the persist succeeds (no double-count) (#1144).
    let parentChainTokensToFold = 0;
    if (continuationEnabled && isContinuationChainDelegate) {
      let childEntry = readSessionEntryByKey(params.childSessionKey);
      const hasTokenData =
        typeof childEntry?.inputTokens === "number" || typeof childEntry?.outputTokens === "number";
      if (!hasTokenData) {
        // Best-effort single retry — avoid blocking the announce hot path
        await new Promise((resolve) => {
          setTimeout(resolve, 150);
        });
        childEntry = readSessionEntryByKey(params.childSessionKey, { refresh: true });
        const hasTokenDataRetry =
          typeof childEntry?.inputTokens === "number" ||
          typeof childEntry?.outputTokens === "number";
        if (!hasTokenDataRetry) {
          defaultRuntime.log(
            `[subagent-chain-hop] Token data unavailable for ${params.childSessionKey} after retry, proceeding with zero token accumulation`,
          );
        }
      }
      accumulatedChildTokens =
        (typeof childEntry?.inputTokens === "number" ? childEntry.inputTokens : 0) +
        (typeof childEntry?.outputTokens === "number" ? childEntry.outputTokens : 0);
      if (accumulatedChildTokens > 0) {
        const parentAgentId = resolveAgentIdFromSessionKey(targetRequesterSessionKey);
        const parentStorePath = resolveStorePath(cfg?.session?.store, {
          agentId: parentAgentId,
        });
        try {
          const parentEntry = await updateSessionEntry(
            {
              agentId: parentAgentId,
              sessionKey: targetRequesterSessionKey,
              storePath: parentStorePath,
            },
            (entry) => ({
              continuationChainTokens:
                (typeof entry.continuationChainTokens === "number"
                  ? entry.continuationChainTokens
                  : 0) + accumulatedChildTokens,
            }),
            { requireWriteSuccess: true },
          );
          if (!parentEntry) {
            throw new Error(`requester entry not found: ${targetRequesterSessionKey}`);
          }
          defaultRuntime.log(
            `[subagent-chain-hop] Accumulated ${accumulatedChildTokens} tokens from ${params.childSessionKey} to parent chain cost`,
          );
          invalidateSessionEntry(targetRequesterSessionKey);
        } catch (err) {
          // Parent-entry persist failed: the requester chain cost read by the
          // bracket/tool chain guard below is stale (missing this run). Fold the
          // run cost into the guard's basis so it cannot under-enforce the cost
          // cap (fails closed) (#1144).
          parentChainTokensToFold = accumulatedChildTokens;
          defaultRuntime.log(
            `[subagent-chain-hop] Failed to persist token accumulation for ${targetRequesterSessionKey}: ${String(err)}`,
          );
        }
        // Fold the child's own run cost into the CHILD entry's durable chain
        // total too. The child — not the requester — is the durable owner of any
        // delayed continuation delegate it queues (bracket or tool), and restart
        // recovery re-drives those from the child entry's persisted
        // `continuationChainTokens`. Persisting once here (at settle) makes the
        // child entry the single post-run cost basis for the live drain, the
        // hedge re-arm, and recovery — so a child run that already blew past
        // costCapTokens cannot launch a delayed hop after a restart (#1144).
        const childAgentId = resolveAgentIdFromSessionKey(params.childSessionKey);
        const childStorePath = resolveStorePath(cfg?.session?.store, {
          agentId: childAgentId,
        });
        try {
          const childStoreEntry = await updateSessionEntry(
            {
              agentId: childAgentId,
              sessionKey: params.childSessionKey,
              storePath: childStorePath,
            },
            (entry) => ({
              continuationChainTokens:
                (typeof entry.continuationChainTokens === "number"
                  ? entry.continuationChainTokens
                  : 0) + accumulatedChildTokens,
            }),
            { requireWriteSuccess: true },
          );
          if (!childStoreEntry) {
            throw new Error(`child entry not found: ${params.childSessionKey}`);
          }
          invalidateSessionEntry(params.childSessionKey);
        } catch (err) {
          // Durable persist failed: the child entry's continuationChainTokens is
          // stale (missing this run's cost). Two-part fail-closed handling:
          //  (1) fold it into the LIVE drain's cost basis (childChainTokensToFold)
          //      so THIS turn's dispatch still enforces the cap; and
          //  (2) annotate the child's already-queued delegates with the durable
          //      fold so a delegate that survives to restart recovery (which
          //      rebuilds chain cost from the stale child entry) still enforces
          //      the post-run total instead of the stale basis (#1144).
          childChainTokensToFold = accumulatedChildTokens;
          const annotated = annotateQueuedDelegatesChainTokensFold(
            params.childSessionKey,
            accumulatedChildTokens,
          );
          defaultRuntime.log(
            `[subagent-chain-hop] Failed to persist child chain cost for ${params.childSessionKey}; folding ${accumulatedChildTokens} into the live drain cost basis and annotating ${annotated} queued delegate(s) for restart recovery: ${String(err)}`,
          );
        }
      }
    }

    let fallbackChildContinuationChainId: string | undefined;
    const buildChildContinuationSpawnState = (
      count: number,
    ): {
      count: number;
      startedAt: number;
      tokens: number;
      chainId: string;
    } => {
      const childChainEntry = readSessionEntryByKey(params.childSessionKey) as
        | ContinuationChainSource
        | undefined;
      return {
        count,
        startedAt: childChainEntry?.continuationChainStartedAt ?? Date.now(),
        tokens: (childChainEntry?.continuationChainTokens ?? 0) + childChainTokensToFold,
        chainId:
          childChainEntry?.continuationChainId ??
          (fallbackChildContinuationChainId ??= generateChainId()),
      };
    };

    // F7: drain the child session's continue_delegate queue now that the
    // subagent has settled. Delegates enqueued by the subagent during its turn
    // would otherwise stay orphaned in TaskFlow until the next inbound message
    // on the parent triggers agent-runner dispatch — stalling the two-hop chain.
    // Runs AFTER the child-token accumulation above, which persists the child's
    // own run cost into the child entry's durable `continuationChainTokens`, so
    // this drain reads the post-run cost basis from the persisted entry. If that
    // persist failed, childChainTokensToFold carries the run cost so the drain
    // still enforces the cost cap against the post-run total (fails closed), AND
    // dispatchRegardlessOfDelay force-dispatches the child's queued delegates
    // immediately rather than leaving delayed ones durably queued — where restart
    // recovery would rebuild their basis from the stale child entry and
    // under-enforce the cap (#1144).
    // RFC: docs/design/continue-work-signal-v2.md §3.2, §3.4.
    const deferInitialChildToolDrain =
      continuationEnabled &&
      isContinuationChainDelegate &&
      stripContinuationSignal(findings).signal?.kind === "delegate";
    if (!deferInitialChildToolDrain) {
      await drainChildContinuationQueue({
        childSessionKey: params.childSessionKey,
        requesterOrigin: targetRequesterOrigin,
        additionalChainTokens: childChainTokensToFold,
        dispatchRegardlessOfDelay: childChainTokensToFold > 0,
        // Inherit the settled parent's silent/wake policy so a default-mode
        // delegate the child queued stays internal instead of announcing when this
        // early drain consumes it (before the parentWasSilent chain-hop guards run).
        inheritedSilent: params.silentAnnounce === true,
        inheritedWake: params.wakeOnReturn === true,
      });
    }

    // --- Consume tool-dispatched delegates from the completing subagent ---
    const toolDelegates =
      continuationEnabled && isContinuationChainDelegate
        ? consumePendingDelegates(params.childSessionKey)
        : [];
    if (toolDelegates.length > 0) {
      defaultRuntime.log(
        `[subagent-chain-hop] Consuming ${toolDelegates.length} tool delegate(s) from subagent ${params.childSessionKey}`,
      );
    }

    // Safety: drain orphaned delegates from non-chain-hop subagents that had tool access.
    if (!isContinuationChainDelegate && continuationEnabled) {
      const orphaned = consumePendingDelegates(params.childSessionKey);
      if (orphaned.length > 0) {
        defaultRuntime.log(
          `[subagent-chain-hop] WARNING: ${orphaned.length} tool delegate(s) orphaned from non-chain-hop subagent ${params.childSessionKey} — drainsContinuationDelegateQueue was set but task has no chain-hop prefix`,
        );
      }
    }

    // Track whether a bracket delegate was consumed from findings — must
    // capture BEFORE stripping mutates findings (P0-1 from review).
    let bracketDelegateReservedCurrentHop = false;
    let delayedBracketDelegateDrainArmed = false;

    if (continuationEnabled && (findings !== "(no output)" || toolDelegates.length > 0)) {
      const continuationResult = stripContinuationSignal(findings);
      if (continuationResult.signal?.kind === "work") {
        // A subagent's bare CONTINUE_WORK token is a same-session
        // self-continuation (the child claims its own next turn), NOT a chain
        // hop to a new child (that is [[CONTINUE_DELEGATE:]], handled below).
        // Strip the token from the announced findings so the parent's
        // orchestration update never carries the child's internal continuation
        // marker, then route it through the SAME durable continue_work scheduler
        // the tool form uses. The scheduler call is a strict fallback: if the
        // spawn-init/turn-1 path already armed the wake from the run payloads it
        // is a no-op (#952).
        const workSignal = continuationResult.signal;
        const internalWorkTraceparent = resolveContinuationTraceparent(params.traceparent);
        findings = continuationResult.text || "(no output)";
        await scheduleSubagentSelfContinuationWork({
          childSessionKey: params.childSessionKey,
          childRunId: params.childRunId,
          ...(workSignal.delayMs !== undefined ? { delayMs: workSignal.delayMs } : {}),
          ...(internalWorkTraceparent ? { traceparent: internalWorkTraceparent } : {}),
          cfg,
        });
      } else if (continuationResult.signal?.kind === "delegate") {
        findings = continuationResult.text || "(no output)";
        const chainSignal = continuationResult.signal;
        const internalChainTraceparent = resolveContinuationTraceparent(params.traceparent);
        const chainTask = chainSignal.task;
        const chainDelayMs = chainSignal.delayMs;
        const parentWasSilent = params.silentAnnounce === true;
        const chainSilent = chainSignal.silent || chainSignal.silentWake || parentWasSilent;
        const chainWake =
          chainSignal.silentWake || (parentWasSilent && params.wakeOnReturn === true);

        // Mirror agent-runner.ts post-compaction routing: a post-compaction bracket
        // delegate stages at the compaction seam instead of spawning now. Without this
        // branch the light-context-leaf / completion path drops post-compaction mode and
        // dispatches the delegate as a normal immediate chain hop (the lifeboat-drop bug).
        // Mutually exclusive with the normal chain-spawn below; chain/cost caps are
        // re-applied at release time inside dispatchPostCompactionDelegates.
        if (chainSignal.postCompaction) {
          stagePostCompactionDelegate(targetRequesterSessionKey, {
            task: chainTask,
            createdAt: Date.now(),
            ...(chainSignal.targetSessionKey
              ? { targetSessionKey: chainSignal.targetSessionKey }
              : {}),
            ...(chainSignal.targetSessionKeys && chainSignal.targetSessionKeys.length > 0
              ? { targetSessionKeys: chainSignal.targetSessionKeys }
              : {}),
            ...(chainSignal.fanoutMode ? { fanoutMode: chainSignal.fanoutMode } : {}),
            ...(internalChainTraceparent
              ? {
                  traceparent: internalChainTraceparent,
                  traceparentProvenance: "internal" as const,
                }
              : {}),
            ...(chainSignal.model ? { model: chainSignal.model } : {}),
          });
          const { enqueueSystemEvent } = await import("../infra/system-events.js");
          enqueueSystemEvent(
            `[continuation:delegate-staged-post-compaction] Bracket delegate staged for post-compaction release: ${chainTask}`,
            { sessionKey: targetRequesterSessionKey, trusted: true },
          );
        } else {
          const { maxChainLength, costCapTokens, minDelayMs, maxDelayMs, crossSessionTargeting } =
            subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg);

          const childChainHop = parseContinuationChainHop(childTask) ?? 0;
          const nextChainHop = childChainHop + 1;

          let chainGuardResult:
            | { allowed: false; reason: "chain-length"; chainCount: number; maxChainLength: number }
            | { allowed: false; reason: "cost-cap"; chainTokens: number; costCapTokens: number }
            | { allowed: true; nextChainHop: number };

          if (childChainHop >= maxChainLength) {
            chainGuardResult = {
              allowed: false,
              reason: "chain-length",
              chainCount: nextChainHop,
              maxChainLength,
            };
          } else {
            const parentEntry = readSessionEntryByKey(targetRequesterSessionKey);
            const storedChainTokens = parentEntry?.continuationChainTokens ?? 0;
            // storedChainTokens already includes this run's tokens when the
            // parent accumulation persist succeeded (parentChainTokensToFold === 0).
            // If that persist FAILED, the entry is stale and parentChainTokensToFold
            // carries the run cost so the guard still enforces against the post-run
            // total — never guessed from a `stored >= run` heuristic that
            // under-enforces when the stale prior chain cost already exceeds the
            // run cost (#1144).
            const parentChainTokens = storedChainTokens + parentChainTokensToFold;
            if (costCapTokens > 0 && parentChainTokens > costCapTokens) {
              chainGuardResult = {
                allowed: false,
                reason: "cost-cap",
                chainTokens: parentChainTokens,
                costCapTokens,
              };
            } else {
              chainGuardResult = { allowed: true, nextChainHop };
            }
          }

          if (!chainGuardResult.allowed) {
            if (chainGuardResult.reason === "chain-length") {
              defaultRuntime.log(
                `[subagent-chain-hop] Chain length ${chainGuardResult.chainCount} > ${chainGuardResult.maxChainLength}, rejecting hop from ${params.childSessionKey}`,
              );
            } else {
              defaultRuntime.log(
                `[subagent-chain-hop] Cost cap exceeded (${chainGuardResult.chainTokens} > ${chainGuardResult.costCapTokens}), rejecting hop from ${params.childSessionKey}`,
              );
            }
          } else {
            const doChainSpawn = async (): Promise<boolean> => {
              try {
                const rejectedByTargetingPolicy =
                  await rejectCrossSessionTargetingForSubagentDispatch({
                    crossSessionTargeting,
                    dispatchingSessionKey: params.childSessionKey,
                    eventSessionKey: targetRequesterSessionKey,
                    source: "bracket",
                    targeting: {
                      ...(chainSignal.targetSessionKey
                        ? { targetSessionKey: chainSignal.targetSessionKey }
                        : {}),
                      ...(chainSignal.targetSessionKeys && chainSignal.targetSessionKeys.length > 0
                        ? { targetSessionKeys: chainSignal.targetSessionKeys }
                        : {}),
                      ...(chainSignal.fanoutMode ? { fanoutMode: chainSignal.fanoutMode } : {}),
                    },
                    task: chainTask,
                  });
                if (rejectedByTargetingPolicy) {
                  return false;
                }
                const childDepth = getSubagentDepthFromSessionStore(params.childSessionKey);
                const { spawnSubagentDirect } = await loadSubagentSpawnRuntime();
                const spawnResult = await spawnSubagentDirect(
                  {
                    task: `[continuation:chain-hop:${nextChainHop}] Delegated from sub-agent (depth ${childDepth}): ${chainTask}`,
                    ...(chainSilent ? { silentAnnounce: true } : {}),
                    ...(chainWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
                    ...(chainSignal.targetSessionKey
                      ? { continuationTargetSessionKey: chainSignal.targetSessionKey }
                      : {}),
                    ...(chainSignal.targetSessionKeys && chainSignal.targetSessionKeys.length > 0
                      ? { continuationTargetSessionKeys: chainSignal.targetSessionKeys }
                      : {}),
                    ...(chainSignal.fanoutMode
                      ? { continuationFanoutMode: chainSignal.fanoutMode }
                      : {}),
                    drainsContinuationDelegateQueue: true,
                    continuationChainState: buildChildContinuationSpawnState(nextChainHop),
                    ...(chainSignal.model ? { model: chainSignal.model } : {}),
                  },
                  {
                    agentSessionKey: targetRequesterSessionKey,
                    agentChannel: targetRequesterOrigin?.channel ?? undefined,
                    agentAccountId: targetRequesterOrigin?.accountId ?? undefined,
                    agentTo: targetRequesterOrigin?.to ?? undefined,
                    agentThreadId: targetRequesterOrigin?.threadId ?? undefined,
                  },
                );
                if (spawnResult.status === "accepted") {
                  defaultRuntime.log(
                    `[subagent-chain-hop] Spawned chain delegate (${nextChainHop}/${maxChainLength}) from ${params.childSessionKey}: ${chainTask.slice(0, 80)}`,
                  );
                  return true;
                }
                const reasonText = spawnResult.error ?? "no reason given";
                defaultRuntime.log(
                  `[subagent-chain-hop] Spawn rejected (${spawnResult.status}) from ${params.childSessionKey} reason=${reasonText}: ${chainTask.slice(0, 80)}`,
                );
                return false;
              } catch (err) {
                defaultRuntime.log(
                  `[subagent-chain-hop] Spawn failed from ${params.childSessionKey}: ${String(err)}`,
                );
                return false;
              }
            };

            if (chainDelayMs && chainDelayMs > 0) {
              if (childChainTokensToFold > 0) {
                // #1144: the child chain-cost persist failed, so the durable
                // child entry is stale and the run-cost fallback
                // (childChainTokensToFold) lives ONLY in this process. A durable
                // delayed delegate that survived a restart would have recovery
                // rebuild chain state from the stale entry and under-enforce the
                // cost cap. Fail closed: spawn the hop NOW via the in-process path
                // (the enqueue-time chain guard above already enforced the cap on
                // the live folded basis) instead of persisting a delegate that
                // could outlive the in-memory fallback. Dropping the +Ns delay is
                // an acceptable degradation for this rare persist-failure corner —
                // the continuation still fires, and with a correct cost basis.
                defaultRuntime.log(
                  `[subagent-chain-hop] Child chain-cost persist failed for ${params.childSessionKey}; spawning the delayed bracket delegate immediately (no durable delay) to avoid stale-cost restart recovery`,
                );
                bracketDelegateReservedCurrentHop = await doChainSpawn();
              } else {
                const clampedDelay = Math.max(minDelayMs, Math.min(maxDelayMs, chainDelayMs));
                // #1144: route the delayed bracket delegate through the durable
                // pending-delegate store — the SAME queue and chain-state owner as
                // the tool-dispatched delayed path — instead of a volatile
                // setTimeout that a gateway restart before `clampedDelay` elapses
                // would drop. Enqueue under the CHILD session that emitted the
                // continuation so the later drain derives hop/cost from the child's
                // chain state (enqueuing under the requester would reset the hop to
                // the requester's chain count and bypass maxChainLength /
                // costCapTokens). The child-queue drain arms the shared hedge timer
                // for the unmatured entry; restart recovery re-drives it if the
                // process dies first — safe here because the child's post-run cost
                // was durably persisted (childChainTokensToFold === 0), so recovery
                // reads the correct basis.
                //
                // Enqueue `chainTask` RAW: it is the clean parsed delegate body —
                // stripContinuationSignal already removed the `+Ns` delay (kept
                // separately in delayMs) and it carries no chain-hop wrapper. The
                // shared delegate dispatcher applies the `[continuation:chain-hop:N]`
                // wrapper at dispatch time (see delegate-dispatch.ts spawn task),
                // exactly like the normal continue_delegate queue contract. Do NOT
                // pre-wrap it the way the immediate `doChainSpawn` payload does, or
                // the dispatcher would double-wrap the hop marker.
                enqueuePendingDelegate(params.childSessionKey, {
                  task: chainTask,
                  delayMs: clampedDelay,
                  ...(chainWake ? { mode: "silent-wake" } : chainSilent ? { mode: "silent" } : {}),
                  ...(params.silentAnnounce ? { inheritedSilent: true } : {}),
                  ...(params.silentAnnounce && params.wakeOnReturn ? { inheritedWake: true } : {}),
                  ...(chainSignal.targetSessionKey
                    ? { targetSessionKey: chainSignal.targetSessionKey }
                    : {}),
                  ...(chainSignal.targetSessionKeys && chainSignal.targetSessionKeys.length > 0
                    ? { targetSessionKeys: chainSignal.targetSessionKeys }
                    : {}),
                  ...(chainSignal.fanoutMode ? { fanoutMode: chainSignal.fanoutMode } : {}),
                  ...(internalChainTraceparent ? { traceparent: internalChainTraceparent } : {}),
                  ...(chainSignal.model ? { model: chainSignal.model } : {}),
                  spawnRequesterSessionKey: targetRequesterSessionKey,
                  ...(targetRequesterOrigin?.channel
                    ? { spawnRequesterChannel: targetRequesterOrigin.channel }
                    : {}),
                  ...(targetRequesterOrigin?.accountId
                    ? { spawnRequesterAccountId: targetRequesterOrigin.accountId }
                    : {}),
                  ...(targetRequesterOrigin?.to
                    ? { spawnRequesterTo: targetRequesterOrigin.to }
                    : {}),
                  ...(targetRequesterOrigin?.threadId !== undefined
                    ? { spawnRequesterThreadId: targetRequesterOrigin.threadId }
                    : {}),
                });
                if (toolDelegates.length === 0) {
                  void drainChildContinuationQueue({
                    childSessionKey: params.childSessionKey,
                    requesterOrigin: targetRequesterOrigin,
                    additionalChainTokens: childChainTokensToFold,
                    chainStateOverride: (() => {
                      const state = buildChildContinuationSpawnState(nextChainHop);
                      return {
                        currentChainCount: state.count,
                        chainStartedAt: state.startedAt,
                        accumulatedChainTokens: state.tokens,
                        chainId: state.chainId,
                      };
                    })(),
                    inheritedSilent: params.silentAnnounce === true,
                    inheritedWake: params.wakeOnReturn === true,
                  }).catch((err: unknown) => {
                    defaultRuntime.log(
                      `[subagent-chain-hop] Failed to arm durable delayed bracket delegate hedge for ${params.childSessionKey}: ${String(err)}`,
                    );
                  });
                  delayedBracketDelegateDrainArmed = true;
                }
              }
            } else {
              // Same-turn tool drains need the real bracket acceptance before
              // they can charge this hop; rejected/failed bracket spawns do not
              // consume the child's chain budget.
              bracketDelegateReservedCurrentHop = await doChainSpawn();
            }
          }
        }
      }

      // --- Tool-dispatched delegates from subagent (parallel to bracket delegates above) ---
      let postBracketChildDrainArmed = false;
      if (toolDelegates.length > 0 && isContinuationChainDelegate) {
        const {
          maxChainLength: toolMaxChainLength,
          costCapTokens: toolCostCapTokens,
          crossSessionTargeting: toolCrossSessionTargeting,
        } = subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg);
        const childChainHop = parseContinuationChainHop(childTask) ?? 0;
        // Use the current-chain reservation flag captured before findings was
        // mutated. A post-compaction bracket delegate is only staged for a later
        // compaction seam, so it must not charge the child chain's tool delegates now.
        const bracketConsumedHop = bracketDelegateReservedCurrentHop ? 1 : 0;
        let toolHopBase = childChainHop + bracketConsumedHop;

        const parentWasSilent = params.silentAnnounce === true;

        let toolDelegateIdx = 0;
        for (const toolDelegate of toolDelegates) {
          const nextToolHop = toolHopBase + 1;

          if (nextToolHop > toolMaxChainLength) {
            const remaining = toolDelegates.length - toolDelegateIdx;
            const summary = `Tool delegate rejected: chain length ${nextToolHop} exceeds maxChainLength ${toolMaxChainLength}.`;
            defaultRuntime.log(
              `[subagent-chain-hop] Tool delegate chain length ${nextToolHop} > ${toolMaxChainLength}, rejecting from ${params.childSessionKey}. ${remaining} delegate(s) dropped.`,
            );
            for (const dropped of toolDelegates.slice(toolDelegateIdx)) {
              markPendingDelegateFailed(dropped, summary, "Delegate rejected");
            }
            break;
          }

          const parentEntryForTool = readSessionEntryByKey(targetRequesterSessionKey);
          const storedToolChainTokens = parentEntryForTool?.continuationChainTokens ?? 0;
          // Same definitive fold as the bracket guard: parentChainTokensToFold is
          // 0 when the parent persist landed (storedToolChainTokens already
          // includes the run cost) and the run cost when it failed (#1144).
          const parentChainTokensForTool = storedToolChainTokens + parentChainTokensToFold;
          if (toolCostCapTokens > 0 && parentChainTokensForTool > toolCostCapTokens) {
            const remaining = toolDelegates.length - toolDelegateIdx;
            const summary = `Tool delegate rejected: cost cap exceeded (${parentChainTokensForTool} > ${toolCostCapTokens}).`;
            defaultRuntime.log(
              `[subagent-chain-hop] Tool delegate cost cap exceeded (${parentChainTokensForTool} > ${toolCostCapTokens}), rejecting from ${params.childSessionKey}. ${remaining} delegate(s) dropped.`,
            );
            for (const dropped of toolDelegates.slice(toolDelegateIdx)) {
              markPendingDelegateFailed(dropped, summary, "Delegate rejected");
            }
            break;
          }

          const delegateMode = toolDelegate.mode ?? "normal";
          const toolSilent =
            delegateMode === "silent" || delegateMode === "silent-wake" || parentWasSilent;
          const toolWake =
            delegateMode === "silent-wake" || (parentWasSilent && params.wakeOnReturn === true);
          const childDepth = getSubagentDepthFromSessionStore(params.childSessionKey);
          const doToolChainSpawn = async (): Promise<boolean> => {
            try {
              const rejectedByTargetingPolicy =
                await rejectCrossSessionTargetingForSubagentDispatch({
                  crossSessionTargeting: toolCrossSessionTargeting,
                  dispatchingSessionKey: params.childSessionKey,
                  eventSessionKey: targetRequesterSessionKey,
                  source: "tool",
                  targeting: {
                    ...(toolDelegate.targetSessionKey
                      ? { targetSessionKey: toolDelegate.targetSessionKey }
                      : {}),
                    ...(toolDelegate.targetSessionKeys && toolDelegate.targetSessionKeys.length > 0
                      ? { targetSessionKeys: toolDelegate.targetSessionKeys }
                      : {}),
                    ...(toolDelegate.fanoutMode ? { fanoutMode: toolDelegate.fanoutMode } : {}),
                  },
                  task: toolDelegate.task,
                });
              if (rejectedByTargetingPolicy) {
                markPendingDelegateFailed(
                  toolDelegate,
                  "Tool delegate rejected: cross-session targeting is disabled by policy.",
                  "Delegate rejected",
                );
                return false;
              }
              const { spawnSubagentDirect } = await loadSubagentSpawnRuntime();
              const spawnResult = await spawnSubagentDirect(
                {
                  task: `[continuation:chain-hop:${nextToolHop}] Tool-delegated from sub-agent (depth ${childDepth}): ${toolDelegate.task}`,
                  ...(toolSilent ? { silentAnnounce: true } : {}),
                  ...(toolWake ? { silentAnnounce: true, wakeOnReturn: true } : {}),
                  ...(toolDelegate.targetSessionKey
                    ? { continuationTargetSessionKey: toolDelegate.targetSessionKey }
                    : {}),
                  ...(toolDelegate.targetSessionKeys && toolDelegate.targetSessionKeys.length > 0
                    ? { continuationTargetSessionKeys: toolDelegate.targetSessionKeys }
                    : {}),
                  ...(toolDelegate.fanoutMode
                    ? { continuationFanoutMode: toolDelegate.fanoutMode }
                    : {}),
                  drainsContinuationDelegateQueue: true,
                  continuationChainState: buildChildContinuationSpawnState(nextToolHop),
                  ...(toolDelegate.flowId
                    ? { continuationDelegateFlowId: toolDelegate.flowId }
                    : {}),
                  ...(toolDelegate.model ? { model: toolDelegate.model } : {}),
                },
                {
                  agentSessionKey: targetRequesterSessionKey,
                  agentChannel: targetRequesterOrigin?.channel ?? undefined,
                  agentAccountId: targetRequesterOrigin?.accountId ?? undefined,
                  agentTo: targetRequesterOrigin?.to ?? undefined,
                  agentThreadId: targetRequesterOrigin?.threadId ?? undefined,
                },
              );
              if (spawnResult.status === "accepted") {
                // Commit the consumed TaskFlow row like the shared dispatcher
                // (delegate-dispatch.ts). consumePendingDelegates already moved
                // it to `running`; without finishing it here the row stays
                // `running` and restart recovery re-spawns it as duplicate
                // continuation work (C2).
                if (toolDelegate.flowId) {
                  const acceptedChildSessionKey =
                    spawnResult.childSessionKey ??
                    deriveContinuationDelegateChildSessionKeyFromParent(
                      targetRequesterSessionKey,
                      toolDelegate.flowId,
                    );
                  markPendingDelegateSpawnAccepted(toolDelegate, acceptedChildSessionKey);
                }
                defaultRuntime.log(
                  `[subagent-chain-hop] Tool delegate (${nextToolHop}/${toolMaxChainLength}) from ${params.childSessionKey}: ${toolDelegate.task.slice(0, 80)}`,
                );
                return true;
              }
              const toolReasonText = spawnResult.error ?? "delegation was not accepted.";
              markPendingDelegateFailed(
                toolDelegate,
                `Tool delegate spawn ${spawnResult.status}: ${toolReasonText}`,
                spawnResult.status === "forbidden" ? "Delegate rejected" : "Delegate spawn failed",
              );
              defaultRuntime.log(
                `[subagent-chain-hop] Tool delegate spawn rejected (${spawnResult.status}) from ${params.childSessionKey} reason=${toolReasonText}`,
              );
              return false;
            } catch (err) {
              markPendingDelegateFailed(toolDelegate, `Tool delegate spawn failed: ${String(err)}`);
              defaultRuntime.log(
                `[subagent-chain-hop] Tool delegate spawn failed from ${params.childSessionKey}: ${String(err)}`,
              );
              return false;
            }
          };

          // consumePendingDelegates only returns delegates after createdAt + delayMs has matured;
          // delayMs here is audit metadata, not another timer to charge against the task.
          const toolSpawnAccepted = await doToolChainSpawn();
          if (toolSpawnAccepted) {
            toolHopBase = nextToolHop;
          }
          toolDelegateIdx += 1;
        }
        if (deferInitialChildToolDrain) {
          const chainState = buildChildContinuationSpawnState(toolHopBase);
          postBracketChildDrainArmed = true;
          void drainChildContinuationQueue({
            childSessionKey: params.childSessionKey,
            requesterOrigin: targetRequesterOrigin,
            chainStateOverride: {
              currentChainCount: chainState.count,
              chainStartedAt: chainState.startedAt,
              accumulatedChainTokens: chainState.tokens,
              chainId: chainState.chainId,
            },
            inheritedSilent: params.silentAnnounce === true,
            inheritedWake: params.wakeOnReturn === true,
          }).catch((err: unknown) => {
            defaultRuntime.log(
              `[subagent-chain-hop] Failed to arm post-bracket child delegate drain for ${params.childSessionKey}: ${String(err)}`,
            );
          });
        }
      }
      if (
        deferInitialChildToolDrain &&
        !postBracketChildDrainArmed &&
        !delayedBracketDelegateDrainArmed
      ) {
        const childChainHop = parseContinuationChainHop(childTask) ?? 0;
        const chainState = buildChildContinuationSpawnState(
          childChainHop + (bracketDelegateReservedCurrentHop ? 1 : 0),
        );
        void drainChildContinuationQueue({
          childSessionKey: params.childSessionKey,
          requesterOrigin: targetRequesterOrigin,
          chainStateOverride: {
            currentChainCount: chainState.count,
            chainStartedAt: chainState.startedAt,
            accumulatedChainTokens: chainState.tokens,
            chainId: chainState.chainId,
          },
          inheritedSilent: params.silentAnnounce === true,
          inheritedWake: params.wakeOnReturn === true,
        }).catch((err: unknown) => {
          defaultRuntime.log(
            `[subagent-chain-hop] Failed to arm post-bracket child delegate drain for ${params.childSessionKey}: ${String(err)}`,
          );
        });
      }
    }

    // If the reply was silent/skip and we fell through for chain-hop accounting,
    // return now before delivery logic.
    if (skipAnnounceDelivery) {
      return true;
    }

    const requesterIsSubagent = requesterIsInternalSession();

    const replyInstruction = buildAnnounceReplyInstruction({
      requesterIsSubagent,
      announceType,
      expectsCompletionMessage,
      silentEnrichment: params.silentAnnounce === true,
      silentWakeEnrichment: params.silentAnnounce === true && params.wakeOnReturn === true,
    });
    const statsLine = await buildCompactAnnounceStatsLine({
      sessionKey: params.childSessionKey,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });
    const internalEvents: AgentInternalEvent[] = [
      {
        type: "task_completion",
        source: announceType === "cron job" ? "cron" : "subagent",
        childSessionKey: params.childSessionKey,
        childSessionId: announceSessionId,
        announceType,
        taskLabel,
        status: outcome.status,
        statusLabel,
        result: findings,
        statsLine,
        replyInstruction,
      },
    ];
    const triggerMessage = buildAnnounceSteerMessage(internalEvents);
    const completionTrace = resolveCompletionTraceContext({
      traceparent: params.traceparent,
      task: childTask,
      resolveMaxChainLength: () =>
        subagentAnnounceDeps.resolveContinuationRuntimeConfig(cfg).maxChainLength,
    });
    const hasContinuationTargeting = Boolean(
      params.continuationTargetSessionKey ||
      (params.continuationTargetSessionKeys && params.continuationTargetSessionKeys.length > 0) ||
      params.continuationFanoutMode,
    );
    if (hasContinuationTargeting) {
      const { enqueueContinuationReturnDeliveries, resolveContinuationReturnTargetSessionKeys } =
        await import("../auto-reply/continuation/targeting.js");
      const treeSessionKeys =
        params.continuationFanoutMode === "tree" && subagentRegistryRuntime
          ? subagentRegistryRuntime.listAncestorSessionKeys(targetRequesterSessionKey)
          : undefined;
      const allSessionKeys =
        params.continuationFanoutMode === "all" ? await listKnownSessionKeysOnHost(cfg) : undefined;
      const targetSessionKeys = resolveContinuationReturnTargetSessionKeys({
        defaultSessionKey: targetRequesterSessionKey,
        targetSessionKey: params.continuationTargetSessionKey,
        targetSessionKeys: params.continuationTargetSessionKeys,
        fanoutMode: params.continuationFanoutMode,
        treeSessionKeys,
        allSessionKeys,
        childSessionKey: params.childSessionKey,
      });
      const enrichmentText =
        triggerMessage || `[continuation:enrichment-return] Delegate completed: ${taskLabel}`;
      await enqueueContinuationReturnDeliveries({
        targetSessionKeys,
        text: enrichmentText,
        idempotencyKeyBase: `continuation-return:${announceId}`,
        wakeRecipients: params.wakeOnReturn === true || params.silentAnnounce !== true,
        childRunId: params.childRunId,
        ...(params.continuationFanoutMode ? { fanoutMode: params.continuationFanoutMode } : {}),
        ...(completionTrace.chainStepRemaining !== undefined
          ? { chainStepRemaining: completionTrace.chainStepRemaining }
          : {}),
        ...(completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}),
      });
      defaultRuntime.log(
        `[continuation:targeted-return] Delivered to ${targetSessionKeys.join(",")} from ${params.childSessionKey}`,
      );
      didAnnounce = true;
      shouldDeleteChildSession = params.cleanup === "delete";
      return true;
    }

    // Send to the requester session. For nested subagents this is an internal
    // follow-up injection (deliver=false) so the orchestrator receives it.
    let directOrigin = targetRequesterOrigin;
    if (!requesterIsSubagent) {
      const { entry } = readRequesterSessionEntry(targetRequesterSessionKey);
      directOrigin = resolveAnnounceOrigin(entry, targetRequesterOrigin);
    }
    const completionDirectOrigin =
      expectsCompletionMessage && !requesterIsSubagent
        ? await resolveSubagentCompletionOrigin({
            childSessionKey: params.childSessionKey,
            requesterSessionKey: targetRequesterSessionKey,
            requesterOrigin: directOrigin,
            childRunId: params.childRunId,
            spawnMode: params.spawnMode,
            expectsCompletionMessage,
          })
        : targetRequesterOrigin;
    // --- Continuation: silent/wake routing (RFC §2.3) ---
    // If this is a continuation delegate with silentAnnounce, deliver as internal
    // system event instead of channel announce. If wakeOnReturn, also wake parent.
    if (params.silentAnnounce) {
      const { enqueueSystemEvent: enqueueSystemEventLazy } =
        await import("../infra/system-events.js");
      const { createSubsystemLogger } = await import("../logging/subsystem.js");
      const continuationLog = createSubsystemLogger("continuation/announce");

      if (params.wakeOnReturn) {
        continuationLog.info(
          `[continuation/silent-wake] wakeOnReturn=true target=${targetRequesterSessionKey} silentAnnounce=true`,
        );
      }

      // Inject completion as system event (invisible to channel).
      const enrichmentText =
        triggerMessage || `[continuation:enrichment-return] Delegate completed: ${taskLabel}`;
      enqueueSystemEventLazy(enrichmentText, {
        sessionKey: targetRequesterSessionKey,
        trusted: true,
        ...(completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}),
      });
      continuationLog.info(
        `[continuation:enrichment-return] Delivered to ${targetRequesterSessionKey} from ${params.childSessionKey}`,
      );

      if (params.wakeOnReturn) {
        const { requestHeartbeatNow } = await import("../infra/heartbeat-wake.js");
        requestHeartbeatNow({
          sessionKey: targetRequesterSessionKey,
          reason: "silent-wake-enrichment",
          parentRunId: params.childRunId,
        });
      }

      didAnnounce = true;
      shouldDeleteChildSession = params.cleanup === "delete";
      return true;
    }

    const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
    // Structured completion wakes ride the continuation flag for every subagent
    // return, but the trigger must distinguish an in-chain continuation hop from
    // an ordinary inter-session subagent completion. An actual
    // `[continuation:chain-hop:N]` return (`isContinuationChainDelegate`) is a
    // mid-chain wake — it carries `delegate-return` so the reset gate preserves
    // the runaway leash. An ordinary subagent completion is an external
    // turn-entry, so it carries `subagent-return` and the reset gate rewinds the
    // chain budget instead of skipping it (#989).
    const delegateReturnTrigger: ContinuationTrigger | undefined = continuationEnabled
      ? isContinuationChainDelegate
        ? "delegate-return"
        : "subagent-return"
      : undefined;
    const delivery = await deliverSubagentAnnouncement({
      requesterSessionKey: targetRequesterSessionKey,
      announceId,
      triggerMessage,
      steerMessage: triggerMessage,
      internalEvents,
      summaryLine: taskLabel,
      requesterSessionOrigin: targetRequesterOrigin,
      requesterOrigin:
        expectsCompletionMessage && !requesterIsSubagent
          ? completionDirectOrigin
          : targetRequesterOrigin,
      completionDirectOrigin,
      directOrigin,
      sourceSessionKey: params.childSessionKey,
      sourceChannel: INTERNAL_MESSAGE_CHANNEL,
      sourceTool: "subagent_announce",
      targetRequesterSessionKey,
      requesterIsSubagent,
      expectsCompletionMessage,
      bestEffortDeliver: params.bestEffortDeliver,
      directIdempotencyKey,
      signal: params.signal,
      continuationTriggerOverride: delegateReturnTrigger,
      ...(completionTrace.traceparent ? { traceparent: completionTrace.traceparent } : {}),
    });
    params.onDeliveryResult?.(delivery);
    didAnnounce = delivery.delivered || delivery.terminal === true;
    if (!delivery.delivered && delivery.path === "direct" && delivery.error) {
      defaultRuntime.log(
        `[warn] Subagent completion direct announce failed for run ${params.childRunId}: ${delivery.error}`,
      );
    }
  } catch (err) {
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // Patch label after all writes complete
    if (params.label) {
      try {
        await subagentAnnounceDeps.callGateway({
          method: "sessions.patch",
          params: { key: params.childSessionKey, label: params.label },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort
      }
    }
    if (shouldDeleteChildSession && (params.onBeforeDeleteChildSession?.() ?? true)) {
      await deleteSubagentSessionForCleanup({
        callGateway: subagentAnnounceDeps.callGateway,
        childSessionKey: params.childSessionKey,
        spawnMode: params.spawnMode,
      });
    }
  }
  return didAnnounce;
}

export const testing = {
  setDepsForTest(
    overrides?: Partial<SubagentAnnounceDeps> & {
      callGateway?: typeof callGateway;
    },
  ) {
    const callGatewayOverride = overrides?.callGateway;
    const dispatchGatewayMethodInProcessOverride =
      overrides?.dispatchGatewayMethodInProcess ??
      (callGatewayOverride
        ? ((async (method, agentParams, options) =>
            await callGatewayOverride({
              method,
              params: agentParams,
              expectFinal: options?.expectFinal,
              timeoutMs: options?.timeoutMs,
            })) satisfies typeof dispatchGatewayMethodInProcess)
        : undefined);
    subagentAnnounceDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeps,
          ...overrides,
          ...(dispatchGatewayMethodInProcessOverride
            ? { dispatchGatewayMethodInProcess: dispatchGatewayMethodInProcessOverride }
            : {}),
        }
      : defaultSubagentAnnounceDeps;
  },
};
