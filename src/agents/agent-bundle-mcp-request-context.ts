import { AsyncLocalStorage } from "node:async_hooks";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const REQUEST_SIGNAL_KEY = Symbol.for("openclaw.sessionMcpRequestSignal");
const requestSignals = resolveGlobalSingleton<AsyncLocalStorage<AbortSignal>>(
  REQUEST_SIGNAL_KEY,
  () => new AsyncLocalStorage(),
);

export function getSessionMcpRequestSignal(): AbortSignal | undefined {
  const caller = requestSignals.getStore();
  const owner = getAsyncWorkSignal();
  // Retiring a work owner must cancel MCP requests before joining their handlers;
  // transport disposal happens later, after the handlers release their leases.
  return caller && owner ? AbortSignal.any([caller, owner]) : (caller ?? owner);
}

export function runWithSessionMcpRequestSignal<T>(
  signal: AbortSignal | undefined,
  run: () => T,
): T {
  return signal ? requestSignals.run(signal, run) : run();
}
