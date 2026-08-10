import { AsyncLocalStorage } from "node:async_hooks";
import type { AiModelTransportEvent, AiModelTransportOutcome } from "@openclaw/ai";
import type { CachedInputObservation } from "@openclaw/ai/internal/shared";
import type {
  ProviderTransportAccountingObservationKind,
  ProviderTransportAccountingObserver,
  ProviderTransportLogicalCallStarted,
} from "./provider-transport-accounting.types.js";

const activeProviderTransportObserver =
  new AsyncLocalStorage<ProviderTransportAccountingObserver>();

export function runWithProviderTransportAccountingObserver<T>(
  observer: ProviderTransportAccountingObserver,
  run: () => T,
): T {
  return activeProviderTransportObserver.run(observer, run);
}

export function runOutsideProviderTransportAccountingObserver<T>(run: () => T): T {
  return activeProviderTransportObserver.exit(run);
}

function reportProviderTransportObservationFailure(
  observer: ProviderTransportAccountingObserver,
  kind: ProviderTransportAccountingObservationKind,
): void {
  try {
    observer.onObservationFailure(kind);
  } catch {
    // The failure reporter is observational too and cannot affect provider behavior.
  }
}

function withActiveProviderTransportObserver(
  kind: ProviderTransportAccountingObservationKind,
  visit: (observer: ProviderTransportAccountingObserver) => void,
): void {
  const observer = activeProviderTransportObserver.getStore();
  if (!observer) {
    return;
  }
  try {
    visit(observer);
  } catch {
    reportProviderTransportObservationFailure(observer, kind);
  }
}

export function observeProviderTransportLogicalCallStarted(
  call: ProviderTransportLogicalCallStarted,
): void {
  withActiveProviderTransportObserver("logical_call_started", (observer) =>
    observer.onLogicalCallStarted(call),
  );
}

export function observeProviderTransportLogicalCallSettled(
  callId: string,
  outcome: AiModelTransportOutcome,
  cachedInput?: CachedInputObservation,
): void {
  withActiveProviderTransportObserver("logical_call_settled", (observer) =>
    observer.onLogicalCallSettled(callId, outcome, cachedInput),
  );
}

export function observeProviderTransportLogicalCallFinalized(callId: string): void {
  withActiveProviderTransportObserver("logical_call_finalized", (observer) =>
    observer.onLogicalCallFinalized(callId),
  );
}

export function observeProviderTransportEvent(event: AiModelTransportEvent): void {
  withActiveProviderTransportObserver("transport_event", (observer) =>
    observer.onTransportEvent(event),
  );
}
