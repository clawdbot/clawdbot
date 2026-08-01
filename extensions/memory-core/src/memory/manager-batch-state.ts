// Memory Core plugin module implements manager batch state behavior.
export const MEMORY_BATCH_FAILURE_LIMIT = 2;

type MemoryBatchFailureState = {
  enabled: boolean;
  count: number;
  lastError?: string;
  lastProvider?: string;
};

export function resetMemoryBatchFailureState(
  state: MemoryBatchFailureState,
): MemoryBatchFailureState {
  return {
    ...state,
    count: 0,
    lastError: undefined,
    lastProvider: undefined,
  };
}

export function recordMemoryBatchFailure(
  state: MemoryBatchFailureState,
  params: {
    provider: string;
    message: string;
    attempts: 1 | 2;
    forceDisable?: boolean;
  },
): MemoryBatchFailureState {
  if (!state.enabled) {
    return state;
  }
  const increment = params.forceDisable ? MEMORY_BATCH_FAILURE_LIMIT : params.attempts;
  const count = state.count + increment;
  const enabled = !(params.forceDisable || count >= MEMORY_BATCH_FAILURE_LIMIT);
  return {
    enabled,
    count,
    lastError: params.message,
    lastProvider: params.provider,
  };
}
