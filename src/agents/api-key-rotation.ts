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
  attempt: number;
};

type ExecuteWithApiKeyRotationOptions<T> = {
  provider: string;
  apiKeys: string[];
  execute: (apiKey: string) => Promise<T>;
  shouldRetry?: (params: ApiKeyRetryParams & { message: string }) => boolean;
  onRetry?: (params: ApiKeyRetryParams & { message: string }) => void;
  transientRetry?: TransientProviderRetryConfig;
};

function dedupeApiKeys(raw: string[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const value of raw) {
    const apiKey = value.trim();
    if (!apiKey || seen.has(apiKey)) {
      continue;
    }
    seen.add(apiKey);
    keys.push(apiKey);
  }
  return keys;
}

export function collectProviderApiKeysForExecution(params: {
  provider: string;
  primaryApiKey?: string;
}): string[] {
  const { primaryApiKey, provider } = params;
  return dedupeApiKeys([primaryApiKey?.trim() ?? "", ...collectProviderApiKeys(provider)]);
}

export async function executeWithApiKeyRotation<T>(
  params: ExecuteWithApiKeyRotationOptions<T>,
): Promise<T> {
  const keys = dedupeApiKeys(params.apiKeys);
  if (keys.length === 0) {
    throw new Error(`No API keys configured for provider "${params.provider}".`);
  }

  let lastError: unknown;
  const transientRetry = resolveTransientProviderRetryOptions(params.transientRetry);
  keyLoop: for (let apiKeyIndex = 0; apiKeyIndex < keys.length; apiKeyIndex += 1) {
    const apiKey = keys[apiKeyIndex];
    const maxOperationAttempts = resolveTransientProviderAttempts(transientRetry);
    for (let attemptNumber = 1; attemptNumber <= maxOperationAttempts; attemptNumber += 1) {
      try {
        return await params.execute(apiKey);
      } catch (error) {
        lastError = error;
        const message = formatErrorMessage(error);
        const rotateKey = params.shouldRetry
          ? params.shouldRetry({ apiKey, error, attempt: apiKeyIndex, message })
          : isApiKeyRateLimitError(message);

        if (rotateKey) {
          if (apiKeyIndex + 1 >= keys.length) {
            break;
          }
          params.onRetry?.({ apiKey, error, attempt: apiKeyIndex, message });
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
            attemptNumber,
            maxAttempts: maxOperationAttempts,
          })
        ) {
          break keyLoop;
        }

        const delayMs = resolveTransientProviderDelayMs(transientRetry, attemptNumber);
        const sleep = transientRetry.sleep ?? sleepWithAbort;
        await sleep(delayMs, transientRetry.signal);
      }
    }
  }

  if (lastError === undefined) {
    throw new Error(`Failed to run API request for ${params.provider}.`);
  }
  throw lastError;
}
