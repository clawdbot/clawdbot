/**
 * Shared candidate and attempt types for model fallback execution.
 */
import type { FailoverReason } from "./embedded-agent-helpers/types.js";

// Shared model fallback record types used by selection, observation, and retry
// reporting.
export type ModelCandidate = {
  provider: string;
  model: string;
};

export type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};
