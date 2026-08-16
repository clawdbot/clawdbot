/** Full pre-adoption -> adoption ownership lifecycle for one claimed event. */
export type ChannelIngressDispatchLifecycle = {
  /** Pre-adoption only. After adopt the drain treats this signal as inert. */
  abortSignal: AbortSignal;
  /**
   * Fires when recovery-relevant session/run state is durable.
   * Drain completes (tombstones) the claim here -- never at settle.
   */
  onAdopted: () => void | Promise<void>;
  /**
   * Turn ownership deferred to reply-lane admission (queued followup).
   * Claim remains held until adopted or abandoned.
   */
  onDeferred: () => void;
  /**
   * Durable adoption finalization is in progress (e.g. settlement hold while
   * committing dedupe). Clears the pre-adoption stall watchdog so a timeout
   * settlement cannot race and dead-letter an about-to-complete claim.
   * Claim stays held until onAdopted / onAbandoned / fail.
   */
  onAdoptionFinalizing: () => void;
  /** Deferred work terminally failed after dispatch returned. */
  onFailed?: (error: unknown) => void | Promise<void>;
  /** Explicit cancellation before adoption; releases without consuming retry budget. */
  onCancelled?: () => void | Promise<void>;
  /**
   * Deferred turn finished without ever owning the reply lane.
   * Drain releases the claim for retry.
   */
  onAbandoned: () => void | Promise<void>;
};

/** Maps a drain lifecycle onto the reply-lane ownership surface. */
export function bindIngressLifecycleToReplyOptions(lifecycle: ChannelIngressDispatchLifecycle): {
  abortSignal: AbortSignal;
  turnAdoptionLifecycle: {
    admission: "exclusive";
    onAdopted: () => void | Promise<void>;
    onDeferred: () => void;
    onAbandoned: () => void | Promise<void>;
    abortSignal: AbortSignal;
  };
} {
  return {
    // Core initial-dispatch cancellation reads replyOptions.abortSignal; the
    // drain aborts it only while pre-adoption (abortActiveClaims/dispose skip
    // adopted claims), so the dispatch cancels exactly when the claim is being
    // reopened for replay — never an adopted run.
    abortSignal: lifecycle.abortSignal,
    turnAdoptionLifecycle: {
      admission: "exclusive",
      onAdopted: lifecycle.onAdopted,
      onDeferred: lifecycle.onDeferred,
      onAbandoned: lifecycle.onAbandoned,
      abortSignal: lifecycle.abortSignal,
    },
  };
}

// onAdoptionFinalizing stays drain-only (not reply-options); channels call it
// via the spooled-replay ALS lifecycle frame during settlement hold.
