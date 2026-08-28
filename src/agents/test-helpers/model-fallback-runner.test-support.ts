import type { FailoverReason } from "../failover/signal.js";
import type { ModelFallbackRunOptions } from "../model-fallback-attempt.js";

export type TestModelFallbackRunnerParams<T = unknown> = {
  provider: string;
  model: string;
  run: (provider: string, model: string, options: ModelFallbackRunOptions) => Promise<T>;
};

export function initialModelFallbackAttemptOptions(
  params: Pick<TestModelFallbackRunnerParams, "provider" | "model">,
): ModelFallbackRunOptions {
  return {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "initial",
    },
  };
}

export function fallbackModelAttemptOptions(
  params: Pick<TestModelFallbackRunnerParams, "provider" | "model">,
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

export function runInitialModelFallbackAttempt<T>(
  params: TestModelFallbackRunnerParams<T>,
  provider = params.provider,
  model = params.model,
): Promise<T> {
  return params.run(provider, model, initialModelFallbackAttemptOptions(params));
}

export function runFallbackModelAttempt<T>(
  params: TestModelFallbackRunnerParams<T>,
  provider: string,
  model: string,
  fallbackReason: FailoverReason,
): Promise<T> {
  return params.run(provider, model, fallbackModelAttemptOptions(params, fallbackReason));
}
