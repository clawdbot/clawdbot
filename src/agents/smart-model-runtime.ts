/**
 * Runtime execution helpers for the Personal AI OS smart model router.
 *
 * This module deliberately does not own transport/provider SDKs. Callers provide
 * the candidates and an executor. It turns the Phase 1 ranking primitives into
 * a deterministic attempt/failover loop that can be reused by agent runtimes.
 */
import {
  classifyModelFailure,
  failureCooldownMs,
  rankSmartModels,
  type ModelFailureReason,
  type ModelTask,
  type ModelRoutingPolicy,
  type RankedModel,
  type SmartModelCandidate,
} from "./smart-model-router.js";

export type RuntimeModelSelectionOptions = {
  candidates: SmartModelCandidate[];
  task: ModelTask;
  policy: ModelRoutingPolicy;
  now?: number;
  minimumScore?: number;
  allowPaidFallback?: boolean;
  preferredModel?: string;
  maxAttempts?: number;
};

export type RuntimeModelAttempt = {
  provider: string;
  model: string;
  attempt: number;
  startedAt: number;
  completedAt: number;
  ok: boolean;
  failureReason?: ModelFailureReason;
  error?: string;
};

export type RuntimeModelResult<T> = {
  value: T;
  selected: RankedModel;
  attempts: RuntimeModelAttempt[];
  failedOver: boolean;
};

export type RuntimeModelExecutor<T> = (model: RankedModel) => Promise<T>;

function candidateKey(model: Pick<SmartModelCandidate, "provider" | "model">): string {
  return `${model.provider}/${model.model}`.toLowerCase();
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Return the ordered runtime candidates. A preferred model is moved to the
 * front only when it is already eligible under the selected policy.
 */
export function selectRuntimeModels(options: RuntimeModelSelectionOptions): RankedModel[] {
  const ranked = rankSmartModels(options.candidates, {
    policy: options.policy,
    task: options.task,
    now: options.now,
    minimumScore: options.minimumScore,
    allowPaidFallback: options.allowPaidFallback,
  });

  if (!options.preferredModel) return ranked;
  const preferred = options.preferredModel.toLowerCase();
  const index = ranked.findIndex((model) => candidateKey(model) === preferred || model.model.toLowerCase() === preferred);
  if (index <= 0) return ranked;
  const [selected] = ranked.splice(index, 1);
  ranked.unshift(selected);
  return ranked;
}

/**
 * Execute against the best model and transparently fail over to the next
 * eligible model when the provider reports a transient/compatibility failure.
 * Authentication and permission failures stop immediately because retrying a
 * different model would not fix the credential problem.
 */
export async function executeWithModelFailover<T>(
  options: RuntimeModelSelectionOptions,
  execute: RuntimeModelExecutor<T>,
): Promise<RuntimeModelResult<T>> {
  const ranked = selectRuntimeModels(options);
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? ranked.length, ranked.length));
  const attempts: RuntimeModelAttempt[] = [];
  let lastError: unknown;

  for (let index = 0; index < maxAttempts; index += 1) {
    const selected = ranked[index];
    const startedAt = Date.now();
    try {
      const value = await execute(selected);
      const completedAt = Date.now();
      attempts.push({
        provider: selected.provider,
        model: selected.model,
        attempt: index + 1,
        startedAt,
        completedAt,
        ok: true,
      });
      return { value, selected, attempts, failedOver: index > 0 };
    } catch (error) {
      lastError = error;
      const message = errorMessage(error);
      const reason = classifyModelFailure(errorStatus(error), message);
      const completedAt = Date.now();
      attempts.push({
        provider: selected.provider,
        model: selected.model,
        attempt: index + 1,
        startedAt,
        completedAt,
        ok: false,
        failureReason: reason,
        error: message,
      });

      if (["authentication", "permission"].includes(reason)) break;
      // A zero cooldown means the failure is non-transient. We still allow a
      // different model when it is a capability mismatch (e.g. tool/vision),
      // but never spin on the same candidate because it is removed by index.
      void failureCooldownMs(reason);
    }
  }

  const detail = errorMessage(lastError);
  throw new Error(`All eligible models failed after ${attempts.length} attempt(s): ${detail}`);
}
