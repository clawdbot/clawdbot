import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

type CallbackLogger = {
  warn(message: string): void;
};

/** Contains callback failures and tracks completion for delivery owners that join it. */
export function runBestEffortCallback(params: {
  callback: () => unknown;
  label: string;
  log: CallbackLogger;
  pending?: Set<Promise<void>>;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}): void {
  const failed = (error: unknown) => {
    params.onError?.(error);
    params.log.warn(`${params.label} callback failed: ${String(error)}`);
  };
  try {
    const result = params.callback();
    if (isPromiseLike(result)) {
      const task = Promise.resolve(result).then(() => params.onSuccess?.(), failed);
      if (params.pending) {
        params.pending.add(task);
        void task.finally(() => params.pending?.delete(task));
      }
    } else {
      params.onSuccess?.();
    }
  } catch (error) {
    failed(error);
  }
}
