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

export function runWithSessionMcpRequestSignal<T>(
  signal: AbortSignal | undefined,
  run: () => T,
): T {
  return signal ? requestSignals.run(signal, run) : run();
}
