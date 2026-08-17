import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const REQUEST_SIGNAL_KEY = Symbol.for("openclaw.sessionMcpRequestSignal");
const requestSignals = resolveGlobalSingleton<AsyncLocalStorage<AbortSignal>>(
  REQUEST_SIGNAL_KEY,
  () => new AsyncLocalStorage(),
);

export function getSessionMcpRequestSignal(): AbortSignal | undefined {
  return requestSignals.getStore();
}

export function resolveSessionMcpRequestSignal(
  explicitSignal?: AbortSignal,
): AbortSignal | undefined {
  const contextSignal = getSessionMcpRequestSignal();
  if (!explicitSignal || explicitSignal === contextSignal) {
    return explicitSignal ?? contextSignal;
  }
  return contextSignal ? AbortSignal.any([explicitSignal, contextSignal]) : explicitSignal;
}

export function runWithSessionMcpRequestSignal<T>(
  signal: AbortSignal | undefined,
  run: () => T,
): T {
  return signal ? requestSignals.run(signal, run) : run();
}

/** Starts runtime-owned work without inheriting one model tool's cancellation. */
export function runWithoutSessionMcpRequestSignal<T>(run: () => T): T {
  return requestSignals.exit(run);
}
