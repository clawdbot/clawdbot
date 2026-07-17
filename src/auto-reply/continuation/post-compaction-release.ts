// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
/**
 * Post-compaction continuation lifecycle release (RFC §4.4).
 *
 * Extracted from agent-runner.ts so the lifecycle release path is testable in
 * isolation. The agent-runner code path remains gated by
 * `continuationEnabledForPressure` and `preflightCompactionApplied` checks
 * upstream; this helper owns the steps that fire AFTER both gates pass:
 *
 *   1. Clear pressure dedup state so post-compaction bands can fire fresh.
 *   2. Fire context-pressure event (postCompaction: true) when totals are known.
 *   3. Consume staged post-compaction delegates and dispatch them with
 *      silentAnnounce + wakeOnReturn + drainsContinuationDelegateQueue.
 *
 * Lazy imports for `lazy.runtime` and staged delegate dispatch are preserved here:
 * lazy.runtime owns per-process singleton state and must not be statically
 * imported anywhere in src/ (boundary rule); staged dispatch is loaded only
 * when delegates are actually staged.
 */

import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { resolveContinuationRuntimeConfig } from "./config.js";

/** Minimal active-session shape this helper needs. */
export interface PostCompactionActiveSession {
  totalTokens?: number | null;
  contextTokens?: number | null;
  continuationChainCount?: number;
  continuationChainStartedAt?: number;
  continuationChainTokens?: number;
  continuationChainId?: string;
}

/** Originating channel info forwarded to spawn context. */
export interface PostCompactionOriginating {
  originatingChannel?: string | null;
  originatingAccountId?: string | null;
  originatingTo?: string | null;
  originatingThreadId?: string | number | null;
}

export interface ReleasePostCompactionParams {
  sessionKey: string;
  cfg: OpenClawConfig | undefined;
  agentCfgContextTokens: number | null | undefined;
  activeSessionEntry: PostCompactionActiveSession | null | undefined;
  originating: PostCompactionOriginating;
}

export interface ReleasePostCompactionResult {
  pressureFired: boolean;
  delegatesDispatched: number;
}

/**
 * Run the post-compaction lifecycle release. Caller is responsible for
 * checking `continuationEnabledForPressure` and `preflightCompactionApplied`
 * BEFORE invoking this — both gates must be satisfied.
 */
export async function releasePostCompactionLifecycle(
  params: ReleasePostCompactionParams,
): Promise<ReleasePostCompactionResult> {
  const { sessionKey, cfg, agentCfgContextTokens, activeSessionEntry, originating } = params;

  const {
    assertStagedPostCompactionFinalizationComplete,
    claimStagedPostCompactionTaskFlowDelegates,
    finalizeStagedPostCompactionDelegates,
    clearContextPressureState,
    checkContextPressure,
  } = await import("./lazy.runtime.js");
  // 1. Clear pressure dedup so post-compaction lifecycle can fire fresh bands.
  clearContextPressureState(sessionKey);

  // 2. Fire context-pressure unconditionally after compaction (when totals
  //    are populated) — informs the session it was compacted, enabling
  //    rehydration via delegates.
  let pressureFired = false;
  const pressureConfig = resolveContinuationRuntimeConfig(cfg);
  const pressureContextWindow =
    agentCfgContextTokens ?? activeSessionEntry?.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  if (pressureContextWindow && activeSessionEntry?.totalTokens != null) {
    const postCompactionPressure = checkContextPressure({
      sessionKey,
      totalTokens: activeSessionEntry.totalTokens,
      contextWindow: pressureContextWindow,
      threshold: pressureConfig.contextPressureThreshold ?? 0.8,
      earlyWarningBand: pressureConfig.earlyWarningBand,
      postCompaction: true,
    });
    if (postCompactionPressure) {
      enqueueSystemEvent(postCompactionPressure, { sessionKey, trusted: true });
      pressureFired = true;
    }
  }

  // 3. Release staged post-compaction delegates with the canonical flag set.
  //    claimStagedPostCompactionTaskFlowDelegates claims rows to `running`; dispatch
  //    fails deterministic policy/cap rejections, and this finalizes only rows
  //    whose spawn was accepted so transient spawn failures stay recoverable on
  // the next restart.
  const stagedDelegates = claimStagedPostCompactionTaskFlowDelegates(sessionKey);
  let delegatesDispatched = 0;
  if (stagedDelegates.length > 0) {
    const { dispatchStagedPostCompactionDelegates } =
      await import("./post-compaction-staged-dispatch.js");
    const result = await dispatchStagedPostCompactionDelegates(
      stagedDelegates,
      sessionKey,
      {
        agentSessionKey: sessionKey,
        agentChannel: originating.originatingChannel ?? undefined,
        agentAccountId: originating.originatingAccountId ?? undefined,
        agentTo: originating.originatingTo ?? undefined,
        agentThreadId: originating.originatingThreadId ?? undefined,
      },
      {
        chainState: {
          currentChainCount: activeSessionEntry?.continuationChainCount ?? 0,
          chainStartedAt: activeSessionEntry?.continuationChainStartedAt ?? Date.now(),
          accumulatedChainTokens: activeSessionEntry?.continuationChainTokens ?? 0,
          ...(activeSessionEntry?.continuationChainId
            ? { chainId: activeSessionEntry.continuationChainId }
            : {}),
        },
      },
    );
    delegatesDispatched = result.dispatched;
    const finalized = finalizeStagedPostCompactionDelegates(result.dispatchedFlowIds);
    assertStagedPostCompactionFinalizationComplete({
      flowIds: result.dispatchedFlowIds,
      finalized,
      context: `direct post-compaction release for ${sessionKey}`,
    });
  }

  return { pressureFired, delegatesDispatched };
}
