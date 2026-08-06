/** Serializes this Gateway's native config writes with its config-loading requests. */

type CodexNativeConfigFenceState = Map<string, Promise<void>>;

type CodexNativeConfigFenceOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage?: string;
  abortMessage?: string;
};

const CODEX_NATIVE_CONFIG_FENCE_STATE = Symbol.for("openclaw.codexNativeConfigFenceState");

function getFenceState(): CodexNativeConfigFenceState {
  const globalState = globalThis as typeof globalThis & {
    [CODEX_NATIVE_CONFIG_FENCE_STATE]?: CodexNativeConfigFenceState;
  };
  globalState[CODEX_NATIVE_CONFIG_FENCE_STATE] ??= new Map();
  return globalState[CODEX_NATIVE_CONFIG_FENCE_STATE];
}

/** Acquires the per-CODEX_HOME fence and returns an idempotent release. */
export async function acquireCodexNativeConfigFence(
  key: string,
  options: CodexNativeConfigFenceOptions = {},
): Promise<() => void> {
  const state = getFenceState();
  const previous = state.get(key) ?? Promise.resolve();
  let resolveCurrent: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  state.set(key, current);
  try {
    await waitForPreviousFence(previous, options);
  } catch (error) {
    // Preserve FIFO exclusion for later waiters even though this caller leaves
    // the queue before its predecessor releases.
    void previous.then(() => {
      resolveCurrent();
      if (state.get(key) === current) {
        state.delete(key);
      }
    });
    throw error;
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    resolveCurrent();
    if (state.get(key) === current) {
      state.delete(key);
    }
  };
}

async function waitForPreviousFence(
  previous: Promise<void>,
  options: CodexNativeConfigFenceOptions,
): Promise<void> {
  if (options.signal?.aborted) {
    throw new Error(options.abortMessage ?? "Codex native config fence aborted");
  }
  if (options.timeoutMs === undefined && !options.signal) {
    await previous;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (run: () => void) => {
      cleanup();
      run();
    };
    const onAbort = () =>
      settle(() => reject(new Error(options.abortMessage ?? "Codex native config fence aborted")));
    void previous.then(() => settle(resolve));
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(
        () =>
          settle(() =>
            reject(new Error(options.timeoutMessage ?? "Codex native config fence timed out")),
          ),
        Math.max(1, options.timeoutMs),
      );
      timeout.unref?.();
    }
  });
}
