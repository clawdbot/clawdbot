import { annotateQueuedDelegatesChainTokensFold } from "../auto-reply/continuation/delegate-store.js";
import { resolveAgentIdFromSessionKey, resolveStorePath } from "../config/sessions.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";
import { generateChainId } from "../infra/secure-random.js";
import { defaultRuntime } from "../runtime.js";

export const CONTINUATION_CHAIN_HOP_PATTERN = /\[continuation:chain-hop:(\d+)\]/;

export type ContinuationChainState = {
  currentChainCount: number;
  chainStartedAt: number;
  accumulatedChainTokens: number;
  chainId?: string;
};

export type ContinuationChainSource = {
  continuationChainCount?: number;
  continuationChainStartedAt?: number;
  continuationChainTokens?: number;
  continuationChainId?: string;
};

type ChainTokenEntry = ContinuationChainSource & {
  inputTokens?: number;
  outputTokens?: number;
};

export function parseContinuationChainHop(task: string): number | undefined {
  const hopText = task.match(CONTINUATION_CHAIN_HOP_PATTERN)?.[1];
  if (!hopText) {
    return undefined;
  }
  const hop = Number.parseInt(hopText, 10);
  return Number.isFinite(hop) ? hop : undefined;
}

export function mergeContinuationChainStateFloor(
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

export async function prepareSubagentContinuationAccounting(params: {
  enabled: boolean;
  childSessionKey: string;
  requesterSessionKey: string;
  task: string;
  cfg: { session?: { store?: unknown } };
  loadEntry: (sessionKey: string, options?: { refresh?: boolean }) => ChainTokenEntry | undefined;
  invalidateSessionEntry: (sessionKey: string) => void;
}): Promise<{
  isContinuationChainDelegate: boolean;
  childChainTokensToFold: number;
  parentChainTokensToFold: number;
  buildChildContinuationSpawnState: (count: number) => {
    count: number;
    startedAt: number;
    tokens: number;
    chainId: string;
  };
}> {
  const isContinuationChainDelegate = CONTINUATION_CHAIN_HOP_PATTERN.test(params.task);
  let childChainTokensToFold = 0;
  let parentChainTokensToFold = 0;

  if (params.enabled && isContinuationChainDelegate) {
    let childEntry = params.loadEntry(params.childSessionKey);
    const hasTokenData =
      typeof childEntry?.inputTokens === "number" || typeof childEntry?.outputTokens === "number";
    if (!hasTokenData) {
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      childEntry = params.loadEntry(params.childSessionKey, { refresh: true });
      if (
        typeof childEntry?.inputTokens !== "number" &&
        typeof childEntry?.outputTokens !== "number"
      ) {
        defaultRuntime.log(
          `[subagent-chain-hop] Token data unavailable for ${params.childSessionKey} after retry, proceeding with zero token accumulation`,
        );
      }
    }
    const accumulatedChildTokens =
      (typeof childEntry?.inputTokens === "number" ? childEntry.inputTokens : 0) +
      (typeof childEntry?.outputTokens === "number" ? childEntry.outputTokens : 0);
    if (accumulatedChildTokens > 0) {
      const configuredSessionStore =
        typeof params.cfg.session?.store === "string" ? params.cfg.session.store : undefined;
      const parentAgentId = resolveAgentIdFromSessionKey(params.requesterSessionKey);
      const parentStorePath = resolveStorePath(configuredSessionStore, {
        agentId: parentAgentId,
      });
      try {
        const parentEntry = await updateSessionEntry(
          {
            agentId: parentAgentId,
            sessionKey: params.requesterSessionKey,
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
          throw new Error(`requester entry not found: ${params.requesterSessionKey}`);
        }
        params.invalidateSessionEntry(params.requesterSessionKey);
      } catch (error) {
        parentChainTokensToFold = accumulatedChildTokens;
        defaultRuntime.log(
          `[subagent-chain-hop] Failed to persist token accumulation for ${params.requesterSessionKey}: ${String(error)}`,
        );
      }

      const childAgentId = resolveAgentIdFromSessionKey(params.childSessionKey);
      const childStorePath = resolveStorePath(configuredSessionStore, { agentId: childAgentId });
      try {
        const persistedChild = await updateSessionEntry(
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
        if (!persistedChild) {
          throw new Error(`child entry not found: ${params.childSessionKey}`);
        }
        params.invalidateSessionEntry(params.childSessionKey);
      } catch (error) {
        childChainTokensToFold = accumulatedChildTokens;
        const annotated = annotateQueuedDelegatesChainTokensFold(
          params.childSessionKey,
          accumulatedChildTokens,
        );
        defaultRuntime.log(
          `[subagent-chain-hop] Failed to persist child chain cost for ${params.childSessionKey}; folding ${accumulatedChildTokens} into the live drain cost basis and annotating ${annotated} queued delegate(s) for restart recovery: ${String(error)}`,
        );
      }
    }
  }

  let fallbackChildContinuationChainId: string | undefined;
  const buildChildContinuationSpawnState = (count: number) => {
    const childEntry = params.loadEntry(params.childSessionKey);
    return {
      count,
      startedAt: childEntry?.continuationChainStartedAt ?? Date.now(),
      tokens: (childEntry?.continuationChainTokens ?? 0) + childChainTokensToFold,
      chainId:
        childEntry?.continuationChainId ?? (fallbackChildContinuationChainId ??= generateChainId()),
    };
  };

  return {
    isContinuationChainDelegate,
    childChainTokensToFold,
    parentChainTokensToFold,
    buildChildContinuationSpawnState,
  };
}
