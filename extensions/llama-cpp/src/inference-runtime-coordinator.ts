import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";

const COORDINATOR_KEY = Symbol.for("openclaw.llamaCppInferenceRuntimeCoordinator");
const TEST_API_KEY = Symbol.for("openclaw.llamaCppInferenceTestApi");
const RESTART_REQUIRED_CODE = "LLAMA_CPP_INFERENCE_RESTART_REQUIRED";

type Completion = {
  promise: Promise<void>;
  complete: () => void;
};

type CoordinatorState = {
  owner?: Completion;
  restartRequired?: Error;
};

type RuntimeToken = {
  closing: Completion;
  owner?: Completion;
  released: boolean;
};

export type LlamaCppInferenceRuntimeToken = {
  acquire: (params: {
    signal?: AbortSignal;
    isLive: () => boolean;
    onRestartRequired: () => void;
  }) => Promise<void>;
  close: () => void;
  fail: (error: unknown) => void;
  release: () => void;
};

class LlamaCppInferenceRestartRequiredError extends Error {
  readonly code = RESTART_REQUIRED_CODE;

  constructor(cause: Error) {
    super("A previous llama.cpp runtime failed to release native resources", { cause });
    this.name = "LlamaCppInferenceRestartRequiredError";
  }
}

function getCoordinatorState(): CoordinatorState {
  return resolveGlobalSingleton<CoordinatorState>(COORDINATOR_KEY, () => ({}));
}

function createCompletion(): Completion {
  let complete!: () => void;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, complete };
}

function abortedError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request was aborted");
}

function waitForTurn(params: {
  closing: Promise<void>;
  retired: Promise<void>;
  signal?: AbortSignal;
}): Promise<"closed" | "retired"> {
  const signal = params.signal;
  if (signal?.aborted) {
    return Promise.reject(abortedError(signal));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal ? abortedError(signal) : new Error("Request was aborted"));
    };
    const finish = (result: "closed" | "retired") => {
      cleanup();
      resolve(result);
    };
    signal?.addEventListener("abort", abort, { once: true });
    void params.closing.then(() => finish("closed"));
    void params.retired.then(() => finish("retired"));
  });
}

function isRestartRequiredError(error: unknown): error is LlamaCppInferenceRestartRequiredError {
  return error instanceof Error && "code" in error && error.code === RESTART_REQUIRED_CODE;
}

async function acquireRuntime(
  token: RuntimeToken,
  params: { signal?: AbortSignal; isLive: () => boolean },
): Promise<void> {
  if (token.owner) {
    return;
  }
  while (true) {
    if (token.released || !params.isLive()) {
      throw new Error("llama.cpp runtime is stopping");
    }
    if (params.signal?.aborted) {
      throw abortedError(params.signal);
    }
    const state = getCoordinatorState();
    if (state.restartRequired) {
      throw new LlamaCppInferenceRestartRequiredError(state.restartRequired);
    }
    if (!state.owner) {
      const owner = createCompletion();
      state.owner = owner;
      token.owner = owner;
      return;
    }
    if (
      (await waitForTurn({
        closing: token.closing.promise,
        retired: state.owner.promise,
        signal: params.signal,
      })) === "closed"
    ) {
      throw new Error("llama.cpp runtime is stopping");
    }
  }
}

function releaseRuntime(token: RuntimeToken): void {
  token.released = true;
  if (!token.owner) {
    return;
  }
  const state = getCoordinatorState();
  if (state.owner === token.owner) {
    state.owner = undefined;
  }
  token.owner.complete();
  token.owner = undefined;
}

function failRuntime(token: RuntimeToken, error: unknown): void {
  const state = getCoordinatorState();
  state.restartRequired ??= error instanceof Error ? error : new Error(String(error));
  token.owner?.complete();
}

export function createLlamaCppInferenceRuntimeToken(): LlamaCppInferenceRuntimeToken {
  // Registration creates only a local token; native ownership remains lazy.
  const token: RuntimeToken = { closing: createCompletion(), released: false };
  return {
    acquire: async ({ onRestartRequired, ...params }) => {
      try {
        await acquireRuntime(token, params);
      } catch (error) {
        // Reloaded plugin chunks have distinct class identities.
        if (isRestartRequiredError(error)) {
          onRestartRequired();
        }
        throw error;
      }
    },
    close: () => token.closing.complete(),
    fail: (error) => failRuntime(token, error),
    release: () => releaseRuntime(token),
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const testApi = (globalStore[TEST_API_KEY] ?? {}) as Record<string, unknown>;
  testApi.resetInferenceRuntimeCoordinator = () => {
    const state = getCoordinatorState();
    state.owner?.complete();
    state.owner = undefined;
    state.restartRequired = undefined;
  };
  globalStore[TEST_API_KEY] = testApi;
}
