/** Bounded claim-token-fenced writes for durable ingress settlement. */
import { sleepWithAbort } from "@openclaw/retry";
import { IngressAdoptionLostError, isIngressAdoptionLostError } from "./ingress-drain-state.js";
import type { ChannelIngressQueue, ChannelIngressQueueClaim } from "./ingress-queue.js";
import {
  DEFAULT_INGRESS_RETRY_BASE_MS,
  DEFAULT_INGRESS_RETRY_MAX_MS,
} from "./ingress-retry-policy.js";

/** Bounded tombstone write retries — wedged ownership beats silent double-dispatch. */
const INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS = 8;

/**
 * Claim-token fenced writes can throw OR return false when the lease was
 * reclaimed. For complete, false is ownership loss (do not settle success).
 * For release/fail, false means the row is already gone from this owner —
 * treat as done so abandon races do not wedge.
 */
export function createIngressWriter<TPayload, TMetadata, TCompletedMetadata>(
  options: { abortSignal?: AbortSignal },
  {
    queue,
    now,
    formatError,
    log,
    isStopped,
  }: {
    queue: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>;
    now: () => number;
    formatError: (err: unknown) => string;
    log: (message: string) => void;
    isStopped: () => boolean;
  },
) {
  const commitClaimWriteWithRetry = async (params: {
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>;
    label: "tombstone" | "dead-letter" | "release";
    write: () => Promise<boolean>;
    falseMeansReclaimed: boolean;
  }): Promise<boolean> => {
    let attempt = 0;
    for (;;) {
      // First write still runs after session abort: terminal complete/release
      // (failed-retryable requeue, post-dispatch tombstone) must not be blocked.
      // Stop only cuts retry backoffs (webhook stop / dispose mid-retry).
      if (attempt > 0 && isStopped()) {
        throw new Error("ingress drain stopped during claim write");
      }
      try {
        const committed = await params.write();
        if (!committed && params.falseMeansReclaimed) {
          throw new IngressAdoptionLostError("reclaimed");
        }
        return committed;
      } catch (err) {
        if (isIngressAdoptionLostError(err)) {
          throw err;
        }
        attempt += 1;
        if (isStopped() || attempt >= INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS) {
          if (attempt >= INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS && !isStopped()) {
            log(
              `ingress drain: ${params.label} write failed for event ${params.claim.id} after ${attempt} attempt(s); holding claim: ${formatError(err)}`,
            );
          }
          throw err;
        }
        const delayMs = Math.min(
          DEFAULT_INGRESS_RETRY_MAX_MS,
          DEFAULT_INGRESS_RETRY_BASE_MS * 2 ** (attempt - 1),
        );
        const displayId = params.claim.id.replace(/^0+(?=\d)/, "") || params.claim.id;
        // Operator + test-visible: tombstone/complete retries after durable adoption.
        log(
          `ingress drain: ${params.label} retry ${attempt}/${INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS} for event ${params.claim.id} in ${delayMs}ms: ${formatError(err)}`,
        );
        if (params.label === "tombstone") {
          log(`completion retry ${attempt} scheduled for event ${displayId}`);
        }
        // Abortable sleep: webhook stop aborts options.abortSignal mid-backoff.
        await sleepWithAbort(delayMs, options.abortSignal, { ref: false });
      }
    }
  };

  const completeClaimWithRetry = async (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
  ): Promise<void> => {
    // Tombstone via complete() — never delete. Retry IO failures; false = reclaimed.
    await commitClaimWriteWithRetry({
      claim,
      label: "tombstone",
      write: () => queue.complete(claim),
      falseMeansReclaimed: true,
    });
  };

  const releaseClaim = async (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    releaseOptions?: { lastError?: string; recordAttempt?: boolean },
  ) => {
    return await commitClaimWriteWithRetry({
      claim,
      label: "release",
      write: () => queue.release(claim, { ...releaseOptions, releasedAt: now() }),
      falseMeansReclaimed: false,
    });
  };

  const failClaim = async (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    reason: string,
    message: string,
  ) => {
    return await commitClaimWriteWithRetry({
      claim,
      label: "dead-letter",
      write: () => queue.fail(claim, { reason, message, failedAt: now() }),
      // Fail false after guillotine/supersede race: treat as already settled.
      falseMeansReclaimed: false,
    });
  };

  return { completeClaimWithRetry, releaseClaim, failClaim };
}
