import type { ChainState } from "./scheduler.js";
import type { ContinuationRuntimeConfig } from "./types.js";

export type DelegateDispatchContext = {
  sessionKey: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
};

export type DelegateDispatchParams = {
  sessionKey: string;
  chainState: ChainState;
  ctx: DelegateDispatchContext;
  maxChainLength: number;
  /**
   * Resolved runtime config for the active run. Callers with scoped/runtime
   * snapshots should pass it so delegate caps match the turn that queued them.
   */
  config?: ContinuationRuntimeConfig;
  /**
   * Delegate slots already consumed by another continuation signal in the same
   * turn, e.g. a bracket-style CONTINUE_DELEGATE.
   */
  reservedDelegateSlots?: number;
  /**
   * Optional callback the hedge timer invokes to re-load the chain state
   * from the persisted session entry at fire time.
   */
  loadFreshChainState?: () => ChainState;
  recoverRunningDelegates?: boolean;
  queuedCreatedAtOrBefore?: number;
  includeRunningUpdatedAtOrBefore?: number;
  dispatchQueuedRegardlessOfDelay?: boolean;
  applyDelegateChainTokensFold?: boolean;
  persistChainState?: (chainState: ChainState) => void | Promise<void>;
  persistBeforeTerminalCommit?: boolean;
  inheritedSilent?: boolean;
  inheritedWake?: boolean;
};

export type DelegateDispatchResult = {
  dispatched: number;
  rejected: number;
  chainState: ChainState;
  appliedChainTokensFold?: number;
  chainStatePersistedBeforeTerminalCommit?: boolean;
};
