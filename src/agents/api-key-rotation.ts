/**
 * Provider API-key rotation wrapper.
 * Runs provider calls across configured keys on rate-limit failures and keeps
 * same-key transient retries separate from key rotation.
 */
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveTransientProviderAttempts,
  resolveTransientProviderDelayMs,
  resolveTransientProviderRetryOptions,
  shouldRetrySameKeyProviderOperation,
  type TransientProviderRetryConfig,
} from "../provider-runtime/operation-retry.js";
import { collectProviderApiKeys, isApiKeyRateLimitError } from "./live-auth-keys.js";

type ApiKeyRetryParams = {
  apiKey: string;
  error: unknown;
  attempt: number; // One-based execution count for the current key.
  apiKeyIndex: number; // Zero-based position of the current key.
};

type ExecuteWithApiKeyRotationOptions<T> = {
  provider: string;
  apiKeys: string[];
  execute: (apiKey: string) => Promise<T>;
  shouldRetry?: (params: ApiKeyRetryParams & { message: string }) => boolean;
  onRetry?: (params: ApiKeyRetryParams & { message: string }) => void;
  transientRetry?: TransientProviderRetryConfig;
};

/** Collect primary and live-discovered provider keys in stable de-duped order. */
export function collectProviderApiKeysForExecution(params: {
  provider: string;
  primaryApiKey?: string;
}): string[] {
  const { primaryApiKey, provider } = params;
  return normalizeUniqueStringEntries([
    primaryApiKey?.trim() ?? "",
    ...collectProviderApiKeys(provider),
  ]);
}

/**
 * Execute a provider operation with key rotation and optional same-key transient
 * retries.
 */
export async function executeWithApiKeyRotation<T>(
  params: ExecuteWithApiKeyRotationOptions<T>,
): Promise<T> {
  const keys = normalizeUniqueStringEntries(params.apiKeys);
  if (keys.length === 0) {
    throw new Error(`No API keys configured for provider "${params.provider}".`);
  }

  let lastError: unknown;
  const transientRetry = resolveTransientProviderRetryOptions(params.transientRetry);
  keyLoop: for (const [apiKeyIndex, apiKey] of keys.entries()) {
    const maxOperationAttempts = resolveTransientProviderAttempts(transientRetry);
    for (let attempt = 1; attempt <= maxOperationAttempts; attempt += 1) {
      transientRetry?.signal?.throwIfAborted();
      try {
        return await params.execute(apiKey);
      } catch (error) {
        transientRetry?.signal?.throwIfAborted();
        lastError = error;
        const message = formatErrorMessage(error);
        const retry = { apiKey, error, attempt, apiKeyIndex, message };
        const rotateKey = params.shouldRetry?.(retry) ?? isApiKeyRateLimitError(message);

        if (rotateKey) {
          // A rotation signal consumes the current key and moves to the next key
          // without running same-key transient retry logic.
          if (apiKeyIndex + 1 >= keys.length) {
            break;
          }
          params.onRetry?.(retry);
          break;
        }

        if (
          !transientRetry ||
          !shouldRetrySameKeyProviderOperation({
            options: transientRetry,
            error,
            message,
            provider: params.provider,
            apiKeyIndex,
            attemptNumber: attempt,
            maxAttempts: maxOperationAttempts,
          })
        ) {
          break keyLoop;
        }

        const delayMs = resolveTransientProviderDelayMs(transientRetry, attempt);
        // Same-key transient retries are bounded by provider policy and keep the
        // current key stable so auth rotation only handles key-specific failures.
        const sleep = transientRetry.sleep ?? sleepWithAbort;
        await sleep(delayMs, transientRetry.signal);
      }
    }
  }

  if (lastError === undefined) {
    throw new Error(`Failed to run API request for ${params.provider}.`);
  }
  throw toLintErrorObject(lastError, "Non-Error thrown");
}
