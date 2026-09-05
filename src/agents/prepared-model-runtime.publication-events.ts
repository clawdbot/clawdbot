import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");

type PreparedModelRuntimePublicationEvent =
  | { phase: "catalog-published" | "invalidated" | "published" }
  | { phase: "failed"; error: Error };

const publicationListeners = new Set<(event: PreparedModelRuntimePublicationEvent) => void>();

/** Observes committed prepared model/auth generations without starting discovery. */
export function registerPreparedModelRuntimePublicationListener(
  listener: (event: PreparedModelRuntimePublicationEvent) => void,
): () => void {
  publicationListeners.add(listener);
  return () => publicationListeners.delete(listener);
}

export function notifyPreparedModelRuntimePublication(
  event: PreparedModelRuntimePublicationEvent,
): void {
  for (const listener of publicationListeners) {
    try {
      listener(event);
    } catch (error) {
      log.warn(`prepared model runtime publication listener failed: ${String(error)}`);
    }
  }
}

export function reportPreparedModelRuntimeAuthRefreshFailure(error: unknown): void {
  const refreshError = toStringifiedError(error);
  notifyPreparedModelRuntimePublication({ phase: "failed", error: refreshError });
  log.warn(`auth-triggered model runtime refresh failed: ${String(refreshError)}`);
}

export function resetPreparedModelRuntimePublicationListenersForTest(): void {
  publicationListeners.clear();
}
