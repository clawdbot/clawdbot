import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.types.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");

type PreparedModelRuntimePublicationEvent =
  | { phase: "catalog-published" | "invalidated" | "published" }
  | { phase: "catalog-failed" | "failed"; error: Error };

const publicationListeners = new Set<(event: PreparedModelRuntimePublicationEvent) => void>();

/** Completes catalog attempts without withdrawing their prepared turn runtime. */
export function createCatalogAttemptReporter(
  owner: Pick<PreparedModelRuntimeOwner, "catalogAttemptError">,
  isCurrent: () => boolean,
): { published: () => void; failed: (error: unknown) => never } {
  return {
    published: () => {
      delete owner.catalogAttemptError;
      notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
    },
    failed: (error) => {
      if (isCurrent() && !(error instanceof PreparedModelRuntimePublicationSupersededError)) {
        const attemptError = toStringifiedError(error);
        owner.catalogAttemptError = attemptError;
        notifyPreparedModelRuntimePublication({ phase: "catalog-failed", error: attemptError });
      }
      throw error;
    },
  };
}

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

export function resetPreparedModelRuntimePublicationListenersForTest(): void {
  publicationListeners.clear();
}
