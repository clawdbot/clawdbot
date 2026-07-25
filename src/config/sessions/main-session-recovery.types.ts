export type MainRestartRecoveryState = {
  /** Stable identity for one interrupted episode; prevents clear-and-rewedge ABA matches. */
  cycleId: string;
  /** Monotonic identity for observations within the current recovery cycle. */
  revision: number;
  /** Attempts charged when their reservation is persisted, before dispatch. */
  chargedAttempts: number;
  reservation?: {
    runId: string;
    attempt: number;
    lifecycleGeneration: string;
  };
  foregroundClaims?: {
    lifecycleGeneration: string;
    tokens: string[];
    /** Run identity for claims that have crossed the actual agent-run boundary. */
    runIdsByClaimId?: Record<string, string>;
  };
  tombstone?: { reason: string };
};
