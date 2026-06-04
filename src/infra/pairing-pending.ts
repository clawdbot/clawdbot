// Shared helpers for mutating pending pairing request state.
type PendingState<TPending> = {
  pendingById: Record<string, TPending>;
};

/** Reject one pending pairing request and return the caller-selected id field. */
export async function rejectPendingPairingRequest<
  TPending,
  TState extends PendingState<TPending>,
  TIdKey extends string,
>(params: {
  requestId: string;
  idKey: TIdKey;
  loadState: () => Promise<TState>;
  persistState: (state: TState) => Promise<void>;
  getId: (pending: TPending) => string;
}): Promise<({ requestId: string } & Record<TIdKey, string>) | null> {
  const state = await params.loadState();
  const pending = state.pendingById[params.requestId];
  if (!pending) {
    return null;
  }
  delete state.pendingById[params.requestId];
  await params.persistState(state);
  return {
    requestId: params.requestId,
    [params.idKey]: params.getId(pending),
  } as { requestId: string } & Record<TIdKey, string>;
}
