// Memory Core plugin module implements manager async state behavior.
export function startAsyncSearchSync(params: {
  enabled: boolean;
  memoryFullRetryDirty: boolean;
  sessionsFullRetryDirty: boolean;
  sync: (params: { reason: string }) => Promise<void>;
  onError: (err: unknown) => void;
}): Promise<void> | void {
  if (!params.enabled || (!params.memoryFullRetryDirty && !params.sessionsFullRetryDirty)) {
    return;
  }
  try {
    const sync = params.sync({ reason: "search" });
    return sync.catch((err: unknown) => {
      params.onError(err);
    });
  } catch (err: unknown) {
    params.onError(err);
  }
}
