import { markPendingDelegateChainStatePersistPlanned } from "./delegate-store.js";
import type { ChainState } from "./scheduler.js";
import type { PendingContinuationDelegate } from "./types.js";

export const formatDelegateDispatchError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** @internal One-way recovery classifier for persist-before-terminal failures. */
export class DelegateTerminalChainStatePersistError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(formatDelegateDispatchError(originalError));
    this.name = "DelegateTerminalChainStatePersistError";
    this.originalError = originalError;
  }
}

export async function persistChainStateBeforeTerminalCommit(
  params: {
    persistBeforeTerminalCommit?: boolean;
    persistChainState?: (chainState: ChainState) => void | Promise<void>;
  },
  delegate: PendingContinuationDelegate,
  chainState: ChainState,
  options: { markPlannedChainState?: boolean; markerKind?: "advanced" | "terminal" } = {},
): Promise<PendingContinuationDelegate> {
  if (!params.persistBeforeTerminalCommit || !params.persistChainState) {
    return delegate;
  }
  try {
    const plannedDelegate = options.markPlannedChainState
      ? markPendingDelegateChainStatePersistPlanned(
          delegate,
          chainState,
          options.markerKind ?? "advanced",
        )
      : delegate;
    await params.persistChainState(chainState);
    return plannedDelegate;
  } catch (err) {
    throw new DelegateTerminalChainStatePersistError(err);
  }
}
