/** Runs image model candidates through the shared fallback attempt machinery. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  type ModelFallbackErrorHandler,
  type ModelFallbackRunResult,
  runFallbackAttempt,
  throwFallbackFailureSummary,
} from "./model-fallback-attempt.js";
import {
  resolveImageFallbackCandidates,
  resolveImageFallbackDefaultProvider,
} from "./model-fallback-candidates.js";
import type { FallbackAttempt } from "./model-fallback.types.js";

export async function runWithImageModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
  abortSignal?: AbortSignal;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveImageFallbackCandidates({
    cfg: params.cfg,
    defaultProvider: resolveImageFallbackDefaultProvider(params.cfg),
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const [i, candidate] of candidates.entries()) {
    const attemptRun = await runFallbackAttempt({
      run: params.run,
      ...candidate,
      attempts,
      attempt: i + 1,
      total: candidates.length,
      abortSignal: params.abortSignal,
    }).catch((error: unknown) => {
      params.abortSignal?.throwIfAborted();
      throw error;
    });
    if ("success" in attemptRun) {
      return attemptRun.success;
    }
    const err = attemptRun.error;
    lastError = err;
    attempts.push({
      provider: candidate.provider,
      model: candidate.model,
      error: formatErrorMessage(err),
    });
    await params.onError?.({
      provider: candidate.provider,
      model: candidate.model,
      error: err,
      attempt: i + 1,
      total: candidates.length,
    });
  }

  return throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "image models",
    formatAttempt: (attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`,
    cfg: params.cfg,
  });
}
