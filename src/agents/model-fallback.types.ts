/**
 * Shared candidate and attempt types for model fallback execution.
 */
import type { FailoverReason } from "./failover/signal.js";

// Shared model fallback record types used by selection, observation, and retry
// reporting.
export type ModelCandidate = {
  provider: string;
  model: string;
};

export type ModelFallbackRouteOrigin = "requested" | "configured-fallback" | "configured-primary";
export type ModelFallbackRouteResolution = "raw" | "resolved";

/** A runnable route plus the selection edge and resolution state it arrived with. */
export type ModelFallbackCandidate = ModelCandidate & {
  routeOrigin: ModelFallbackRouteOrigin;
  routeResolution: ModelFallbackRouteResolution;
};

export type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  authMode?: string;
  status?: number;
  code?: string;
};

/** Original route plus the outer fallback stage that admitted one real attempt. */
export type ModelFallbackAttemptProvenance = {
  requestedProvider: string;
  requestedModel: string;
  stage: "initial" | "fallback";
  fallbackReason?: FailoverReason;
};
