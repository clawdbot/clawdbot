// Coordinates direct embedded state writers with the Gateway state-directory owner.
import { createAbortError } from "./abort-signal.js";
import type { GatewayLockIdentity, GatewayLockOptions } from "./gateway-lock.js";

export type EmbeddedStateSignal = "SIGINT" | "SIGTERM";

export type EmbeddedStateSignalProcess = {
  on(signal: EmbeddedStateSignal, handler: () => void): unknown;
  off(signal: EmbeddedStateSignal, handler: () => void): unknown;
};

export type EmbeddedStateLockHandle = {
  release: () => Promise<void>;
};

const EMBEDDED_STATE_SIGNALS: readonly EmbeddedStateSignal[] = ["SIGINT", "SIGTERM"];

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError("embedded state lock acquisition aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError("embedded state lock acquisition aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Bridges process signals into embedded-run cancellation so lock cleanup can unwind. */
export function createEmbeddedStateSignalBridge(processLike: EmbeddedStateSignalProcess = process) {
  const controller = new AbortController();
  let receivedSignal: EmbeddedStateSignal | undefined;
  const handlers = new Map<EmbeddedStateSignal, () => void>();
  const dispose = () => {
    for (const [signal, handler] of handlers) {
      processLike.off(signal, handler);
    }
    handlers.clear();
  };
  for (const signal of EMBEDDED_STATE_SIGNALS) {
    const handler = () => {
      receivedSignal = signal;
      if (!controller.signal.aborted) {
        controller.abort();
        dispose();
      }
    };
    handlers.set(signal, handler);
    processLike.on(signal, handler);
  }
  return {
    signal: controller.signal,
    getReceivedSignal: () => receivedSignal,
    dispose,
  };
}

/** Probe the Gateway owner first, then acquire the shared embedded-writer role. */
export async function acquireEmbeddedStateLock(params: {
  options?: GatewayLockOptions;
  signal?: AbortSignal;
  formatActiveGatewayRefusal: (identity: GatewayLockIdentity) => string;
}): Promise<EmbeddedStateLockHandle | null> {
  const { acquireGatewayLock, GatewayLockError, readActiveGatewayLockIdentity } =
    await import("./gateway-lock.js");
  const env = params.options?.env ?? process.env;
  if (
    params.options?.allowInTests !== true &&
    (env.VITEST !== undefined || env.NODE_ENV === "test")
  ) {
    return null;
  }
  const activeGateway = await readActiveGatewayLockIdentity(params.options);
  if (activeGateway) {
    throw new GatewayLockError(params.formatActiveGatewayRefusal(activeGateway));
  }
  try {
    return await acquireGatewayLock({
      ...params.options,
      role: "agent-embedded",
      sleep: params.options?.sleep ?? (async (ms) => await abortableDelay(ms, params.signal)),
    });
  } catch (error) {
    if (!(error instanceof GatewayLockError)) {
      throw error;
    }
    const racedGateway = await readActiveGatewayLockIdentity(params.options);
    if (racedGateway) {
      throw new GatewayLockError(params.formatActiveGatewayRefusal(racedGateway), error);
    }
    throw error;
  }
}
