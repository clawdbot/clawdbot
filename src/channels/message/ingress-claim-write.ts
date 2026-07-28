/**
 * Claim write helpers for the durable channel-ingress drain: bounded, retried,
 * claim-token-fenced tombstone / dead-letter / release writes.
 */
import { formatErrorMessage } from "../../infra/errors.js";
import {
  DEFAULT_INGRESS_RETRY_BASE_MS,
  DEFAULT_INGRESS_RETRY_MAX_MS,
  sleepIngressRetryDelay,
} from "./ingress-retry-policy.js";

/** Bounded tombstone write retries — wedged ownership beats silent double-dispatch. */
export const INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS = 8;

/**
 * Closed error when adoption races a pre-adoption guillotine/supersede, or when
 * a claim-token fence rejects complete/fail (lease reclaimed by another owner).
 * Callers must stop the turn (abortSignal is also aborted when applicable).
 */
export class IngressAdoptionLostError extends Error {
  readonly code: "guillotined" | "superseded" | "reclaimed";

  constructor(code: "guillotined" | "superseded" | "reclaimed") {
    super(`ingress adoption lost: ${code}`);
    this.name = "IngressAdoptionLostError";
    this.code = code;
  }
}

export function isIngressAdoptionLostError(error: unknown): error is IngressAdoptionLostError {
  return error instanceof IngressAdoptionLostError;
}

/**
 * Claim-token fenced writes can throw OR return false when the lease was
 * reclaimed. For complete, false is ownership loss (do not settle success).
 * For release/fail, false means the row is already gone from this owner —
 * treat as done so abandon races do not wedge.
 */
export async function commitIngressClaimWriteWithRetry(params: {
  claimId: string;
  label: "tombstone" | "dead-letter" | "release";
  write: () => Promise<boolean>;
  falseMeansReclaimed: boolean;
  isStopped: () => boolean;
  abortSignal?: AbortSignal;
  log: (message: string) => void;
  formatError?: (err: unknown) => string;
}): Promise<void> {
  const formatError = params.formatError ?? formatErrorMessage;
  let attempt = 0;
  for (;;) {
    // First write still runs after session abort: terminal complete/release
    // (failed-retryable requeue, post-dispatch tombstone) must not be blocked.
    // Stop only cuts retry backoffs (webhook stop / dispose mid-retry).
    if (attempt > 0 && params.isStopped()) {
      throw new Error("ingress drain stopped during claim write");
    }
    try {
      const committed = await params.write();
      if (!committed) {
        if (params.falseMeansReclaimed) {
          throw new IngressAdoptionLostError("reclaimed");
        }
        return;
      }
      return;
    } catch (err) {
      if (isIngressAdoptionLostError(err)) {
        throw err;
      }
      attempt += 1;
      if (params.isStopped() || attempt >= INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS) {
        if (attempt >= INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS && !params.isStopped()) {
          params.log(
            `ingress drain: ${params.label} write failed for event ${params.claimId} after ${attempt} attempt(s); holding claim: ${formatError(err)}`,
          );
        }
        throw err;
      }
      const delayMs = Math.min(
        DEFAULT_INGRESS_RETRY_MAX_MS,
        DEFAULT_INGRESS_RETRY_BASE_MS * 2 ** (attempt - 1),
      );
      const displayId = params.claimId.replace(/^0+(?=\d)/, "") || params.claimId;
      // Operator + test-visible: tombstone/complete retries after durable adoption.
      params.log(
        `ingress drain: ${params.label} retry ${attempt}/${INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS} for event ${params.claimId} in ${delayMs}ms: ${formatError(err)}`,
      );
      if (params.label === "tombstone") {
        params.log(`completion retry ${attempt} scheduled for event ${displayId}`);
      }
      // Abortable sleep: webhook stop aborts abortSignal mid-backoff.
      await sleepIngressRetryDelay(delayMs, params.abortSignal);
    }
  }
}
