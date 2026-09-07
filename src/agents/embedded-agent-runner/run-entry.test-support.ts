import type { FailoverReason } from "../failover/signal.js";
import type { ModelFallbackRunOptions } from "../model-fallback-attempt.js";
import type { runWithModelFallback } from "../model-fallback-runner.js";
import type { EmbeddedAgentRunResult } from "./types.js";

export type FallbackRunnerParams = Parameters<
  typeof runWithModelFallback<EmbeddedAgentRunResult>
>[0];

export function initialAttemptOptions(params: FallbackRunnerParams): ModelFallbackRunOptions {
  return {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "initial",
    },
  };
}

export function fallbackAttemptOptions(
  params: FallbackRunnerParams,
  fallbackReason: FailoverReason,
): ModelFallbackRunOptions {
  return {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "fallback",
      fallbackReason,
    },
  };
}
