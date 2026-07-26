import type { SessionEntry } from "../../config/sessions.js";
import { resolveLiveContinuationRuntimeConfig } from "../continuation/config.js";
import type { ContinuationSignalExtraction } from "../continuation/signal.js";
import type { ChainState, ContinueWorkRequest } from "../continuation/types.js";
import { handleContinuationSignal } from "./agent-runner-continuation-signal.js";
import type {
  PersistContinuationChainStateParams,
  ReplyContinuationController,
} from "./agent-runner-continuation.js";
import type { FollowupRun } from "./queue.js";

type ContinuationUsage = { input?: number; output?: number } | undefined;

// Ports the monolith's continuation work/delegate scheduling + staged
// post-compaction release region. Kept as a narrow module so completeReplyAgentRun
// stays within the max-lines budget. Behavior/order is identical to the monolith.
export async function scheduleReplyContinuation(context: {
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
}): Promise<void> {
  const {
    cfg,
    sessionKey,
    followupRun,
    usage,
    effectiveContinuationSignal,
    continuation,
    getActiveSessionEntry,
  } = context;
  const { activeSessionEntry: activeSessionEntryAfterSignal, bracketTokensAccumulated } =
    await handleContinuationSignal(context);
  let activeSessionEntry = activeSessionEntryAfterSignal;
  const persistContinuationChainState = async (
    params: PersistContinuationChainStateParams,
  ): Promise<{ chainId: string | undefined; entry: SessionEntry | undefined }> => {
    const result = await continuation.persistContinuationChainState(params);
    activeSessionEntry = getActiveSessionEntry();
    return result;
  };

  // Post-compaction delegates staged after this turn's compaction release stay
  // queued in TaskFlow for the NEXT seam. Do not consume them here: the consume
  // API marks rows `running`, which startup recovery interprets as already
  // released crash-orphans and would dispatch before the next compaction.

  // Consume and dispatch TaskFlow-backed delegates before silent returns so
  // delayed delegates still arm their quiet-channel hedge.
  let toolDelegateDispatchResult:
    | { dispatched: number; rejected: number; chainState: ChainState }
    | undefined;
  if (resolveLiveContinuationRuntimeConfig(cfg).enabled && sessionKey) {
    const turnTokens = bracketTokensAccumulated ? 0 : (usage?.input ?? 0) + (usage?.output ?? 0);
    const { dispatchToolDelegates, loadContinuationChainState } =
      await import("../continuation/lazy.runtime.js");
    const dispatchChainState = loadContinuationChainState(activeSessionEntry, turnTokens);
    const liveContinuationRuntimeConfig = resolveLiveContinuationRuntimeConfig(cfg);
    toolDelegateDispatchResult = await dispatchToolDelegates({
      sessionKey,
      chainState: dispatchChainState,
      ctx: {
        sessionKey,
        agentChannel: followupRun.originatingChannel ?? undefined,
        agentAccountId: followupRun.originatingAccountId ?? undefined,
        agentTo: followupRun.originatingTo ?? undefined,
        agentThreadId: followupRun.originatingThreadId ?? undefined,
      },
      maxChainLength: liveContinuationRuntimeConfig.maxChainLength,
      config: liveContinuationRuntimeConfig,
      reservedDelegateSlots:
        effectiveContinuationSignal?.kind === "delegate" &&
        (effectiveContinuationSignal.delayMs ?? 0) <= 0
          ? 1
          : 0,
      // Pass a fresh-loader so the hedge timer re-loads the chain state
      // from the persisted session entry at fire time.
      loadFreshChainState: () => loadContinuationChainState(activeSessionEntry, 0),
      persistChainState: async (nextState) => {
        await persistContinuationChainState({
          count: nextState.currentChainCount,
          startedAt: nextState.chainStartedAt,
          tokens: nextState.accumulatedChainTokens,
          ...(nextState.chainId ? { chainId: nextState.chainId } : {}),
          required: true,
        });
      },
    });
  }

  // --- Chain state write-back (docs/design/continue-work-signal-v2.md §3.3) ---
  // When delegates were dispatched this turn, persist the advanced chain
  // state returned by `dispatchToolDelegates` rather than re-loading the
  // unchanged pre-dispatch state. Without this the counter never advances
  // across hops and `maxChainLength` enforcement breaks.
  const toolDelegateChainStateChanged =
    toolDelegateDispatchResult &&
    (toolDelegateDispatchResult.dispatched > 0 || toolDelegateDispatchResult.rejected > 0);
  if (toolDelegateChainStateChanged && sessionKey && activeSessionEntry) {
    const { loadContinuationChainState } = await import("../continuation/lazy.runtime.js");
    const turnTokens = bracketTokensAccumulated ? 0 : (usage?.input ?? 0) + (usage?.output ?? 0);
    const nextState =
      toolDelegateDispatchResult?.chainState ??
      loadContinuationChainState(activeSessionEntry, turnTokens);
    await persistContinuationChainState({
      count: nextState.currentChainCount,
      startedAt: nextState.chainStartedAt,
      tokens: nextState.accumulatedChainTokens,
      ...(nextState.chainId ? { chainId: nextState.chainId } : {}),
    });
  }
}
