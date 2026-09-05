// Memory Core plugin module implements manager async state behavior.
export function startAsyncSearchSync(params: {
  enabled: boolean;
  dirty: boolean;
  sessionsDirty: boolean;
  sync: (params: { reason: string }) => Promise<void>;
  onError: (err: unknown) => void;
}): Promise<void> | void {
  if (!params.enabled || (!params.dirty && !params.sessionsDirty)) {
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
