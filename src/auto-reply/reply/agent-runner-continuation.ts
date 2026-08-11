import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry, SessionPostCompactionDelegate } from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { generateChainId } from "../../infra/secure-random.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveLiveContinuationRuntimeConfig } from "../continuation/config.js";

type ContinuationChainPatch = {
  continuationChainCount: number;
  continuationChainStartedAt: number;
  continuationChainTokens: number;
  continuationChainId: string | undefined;
};

export type PersistContinuationChainStateParams = {
  count: number;
  startedAt: number;
  tokens: number;
  chainId?: string;
  clearChainId?: boolean;
  required?: boolean;
  update?: (entry: SessionEntry, proposed: ContinuationChainPatch) => Partial<SessionEntry> | null;
};

export type ReplyContinuationController = {
  persistContinuationChainState: (
    params: PersistContinuationChainStateParams,
  ) => Promise<{ chainId: string | undefined; entry: SessionEntry | undefined }>;
  resetContinuationChainForFreshTurn: () => Promise<void>;
  postCompactionDelegatesToPreserve: SessionPostCompactionDelegate[];
};

// Encapsulates the run-scoped continuation chain closures the monolith defined
// inline inside runReplyAgent. Threading the controller through the split's
// run/execute/finalize phases preserves the single mutable activeSessionEntry
// contract via accessors, mirroring createReplyAgentRestartRecoveryController.
export function createReplyContinuationController(context: {
  cfg: OpenClawConfig;
  sessionKey: string | undefined;
  storePath: string | undefined;
  isContinuationWake: boolean | undefined;
  activeSessionStore: Record<string, SessionEntry> | undefined;
  getActiveSessionEntry: () => SessionEntry | undefined;
  setActiveSessionEntry: (entry: SessionEntry | undefined) => void;
}): ReplyContinuationController {
  const {
    cfg,
    sessionKey,
    storePath,
    isContinuationWake,
    activeSessionStore,
    getActiveSessionEntry,
    setActiveSessionEntry,
  } = context;

  const persistContinuationChainState = async (
    params: PersistContinuationChainStateParams,
  ): Promise<{ chainId: string | undefined; entry: SessionEntry | undefined }> => {
    if (!sessionKey) {
      return { chainId: undefined, entry: undefined };
    }
    const activeSessionEntry = getActiveSessionEntry();
    const previousCount = activeSessionEntry?.continuationChainCount ?? 0;
    const chainId = params.clearChainId
      ? undefined
      : (params.chainId ??
        (previousCount > 0 && activeSessionEntry?.continuationChainId
          ? activeSessionEntry.continuationChainId
          : generateChainId()));
    const patch = {
      continuationChainCount: params.count,
      continuationChainStartedAt: params.startedAt,
      continuationChainTokens: params.tokens,
      continuationChainId: chainId,
    };
    const inMemoryEntry = activeSessionEntry ?? activeSessionStore?.[sessionKey];
    let persistedEntry: SessionEntry | undefined;
    if (storePath) {
      try {
        const persisted = await patchSessionEntryCore(
          { storePath, sessionKey },
          (entry) => (params.update ? params.update(entry, patch) : patch),
          { preserveActivity: true },
        );
        if (!persisted) {
          throw new Error("session entry was not found");
        }
        persistedEntry = persisted;
      } catch (err) {
        defaultRuntime.log(
          `Failed to persist continuation chain state for ${sessionKey}: ${String(err)}`,
        );
        if (params.required) {
          throw err;
        }
      }
    }
    let nextEntry = persistedEntry;
    if (!nextEntry && inMemoryEntry) {
      const inMemoryPatch = params.update ? params.update(inMemoryEntry, patch) : patch;
      if (inMemoryPatch) {
        Object.assign(inMemoryEntry, inMemoryPatch);
      }
      nextEntry = inMemoryEntry;
    }
    if (!nextEntry && params.required) {
      throw new Error(`session entry was not available for ${sessionKey}`);
    }
    if (nextEntry) {
      setActiveSessionEntry(nextEntry);
      if (activeSessionStore) {
        activeSessionStore[sessionKey] = nextEntry;
      }
    }
    return {
      chainId: nextEntry?.continuationChainId ?? chainId,
      entry: nextEntry,
    };
  };

  const resetContinuationChainForFreshTurn = async (): Promise<void> => {
    const activeSessionEntry = getActiveSessionEntry();
    if (
      !resolveLiveContinuationRuntimeConfig(cfg).enabled ||
      !sessionKey ||
      !activeSessionEntry ||
      isContinuationWake ||
      ((activeSessionEntry.continuationChainCount ?? 0) <= 0 &&
        (activeSessionEntry.continuationChainTokens ?? 0) <= 0)
    ) {
      return;
    }
    await persistContinuationChainState({
      count: 0,
      startedAt: Date.now(),
      tokens: 0,
      chainId: generateChainId(),
    });
  };

  return {
    persistContinuationChainState,
    resetContinuationChainForFreshTurn,
    postCompactionDelegatesToPreserve: [],
  };
}
