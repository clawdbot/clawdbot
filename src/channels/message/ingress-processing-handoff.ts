import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const INGRESS_BOUNDED_PROCESSING_STARTED_ALS_KEY = Symbol.for(
  "openclaw.ingressBoundedProcessingStartedAls",
);

type IngressBoundedProcessingStarted = () => void;

function ingressBoundedProcessingStartedAls(): AsyncLocalStorage<IngressBoundedProcessingStarted> {
  return resolveGlobalSingleton(
    INGRESS_BOUNDED_PROCESSING_STARTED_ALS_KEY,
    () => new AsyncLocalStorage<IngressBoundedProcessingStarted>(),
  );
}

const startedByAbortSignal = new WeakMap<AbortSignal, IngressBoundedProcessingStarted>();

/** Drain-only: bind the claim abort signal to the watchdog-retirement setter. */
export function bindIngressBoundedProcessingStarted(
  abortSignal: AbortSignal,
  startBoundedProcessing: IngressBoundedProcessingStarted,
): void {
  startedByAbortSignal.set(abortSignal, startBoundedProcessing);
}

/** Drain-only: keep the setter live across the claimed dispatch async context. */
export function runWithIngressBoundedProcessingStarted<T>(
  startBoundedProcessing: IngressBoundedProcessingStarted,
  run: () => T,
): T {
  return ingressBoundedProcessingStartedAls().run(startBoundedProcessing, run);
}

/**
 * Reply-owned entry: retire the shorter ingress stall watchdog once bounded
 * processing can settle the claim. No-op when no drain claim is in scope.
 */
export function markIngressBoundedProcessingStarted(abortSignal?: AbortSignal): void {
  const fromAls = ingressBoundedProcessingStartedAls().getStore();
  if (fromAls) {
    fromAls();
    return;
  }
  if (abortSignal) {
    startedByAbortSignal.get(abortSignal)?.();
  }
}
