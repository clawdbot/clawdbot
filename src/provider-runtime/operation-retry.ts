import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";

export type ProviderOperationRetryStage = "read" | "poll" | "download" | "create";

export type TransientProviderRetryParams = {
  error: unknown;
  message: string;
  provider: string;
  apiKeyIndex: number;
  attemptNumber: number;
  stage?: ProviderOperationRetryStage;
};

export type TransientProviderRetryOptions = {
  /**
   * Total executions, including the first call.
   * attempts: 2 means one initial call plus one retry.
   */
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (params: TransientProviderRetryParams) => boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type TransientProviderRetryConfig = boolean | TransientProviderRetryOptions;

export const DEFAULT_TRANSIENT_PROVIDER_RETRY_OPTIONS = {
  attempts: 2,
  baseDelayMs: 250,
  maxDelayMs: 1_000,
} as const satisfies TransientProviderRetryOptions;

export function resolveTransientProviderRetryOptions(
  options?: TransientProviderRetryConfig,
): TransientProviderRetryOptions | undefined {
  if (!options) {
    return undefined;
  }
  if (options === true) {
    return DEFAULT_TRANSIENT_PROVIDER_RETRY_OPTIONS;
  }
  return options;
}

export function defaultTransientProviderRetryForStage(
  stage: ProviderOperationRetryStage,
): TransientProviderRetryConfig | undefined {
  return stage === "create" ? undefined : true;
}

export function providerOperationRetryConfig(
  stage: ProviderOperationRetryStage,
  options?: TransientProviderRetryConfig,
): TransientProviderRetryConfig | undefined {
  return options ?? defaultTransientProviderRetryForStage(stage);
}

function readErrorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function isTimeoutNamedError(error: unknown): boolean {
  const name = readErrorName(error);
  return name === "TimeoutError" || name === "RequestTimeoutError";
}

function readErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  for (const value of [record.status, record.statusCode, record.code]) {
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
    if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
      return Number(value.trim());
    }
  }
  return undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function readErrorCause(error: unknown): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return (error as { cause?: unknown }).cause;
}

function hasTransientNetworkSignal(error: unknown, message: string): boolean {
  const transientCodes = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/i;
  if (transientCodes.test(message)) {
    return true;
  }
  const code = readErrorCode(error);
  if (code && transientCodes.test(code)) {
    return true;
  }
  const cause = readErrorCause(error);
  if (!cause || cause === error) {
    return false;
  }
  const causeCode = readErrorCode(cause);
  if (causeCode && transientCodes.test(causeCode)) {
    return true;
  }
  const causeMessage = formatErrorMessage(cause);
  return transientCodes.test(causeMessage);
}

function hasTimeoutSignal(error: unknown, message: string): boolean {
  if (isTimeoutNamedError(error)) {
    return true;
  }
  if (/\b(?:request timeout|provider timeout|timed out|timeout)\b/i.test(message)) {
    return true;
  }
  const cause = readErrorCause(error);
  if (!cause || cause === error) {
    return false;
  }
  if (isTimeoutNamedError(cause)) {
    return true;
  }
  return /\b(?:request timeout|provider timeout|timed out|timeout)\b/i.test(
    formatErrorMessage(cause),
  );
}

export function isTransientProviderOperationError(error: unknown, message: string): boolean {
  const status = readErrorStatus(error);
  if (status !== undefined) {
    return status === 500 || status === 502 || status === 503 || status === 504;
  }
  if (
    /\b(?:HTTP\s*)?(?:400|401|403|404)\b/i.test(message) ||
    /\b(?:invalid api key|permission denied|model not found|validation|unsupported model)\b/i.test(
      message,
    )
  ) {
    return false;
  }
  if (/\b(?:HTTP\s*)?(?:500|502|503|504)\b/i.test(message)) {
    return true;
  }
  if (hasTransientNetworkSignal(error, message)) {
    return true;
  }
  if (hasTimeoutSignal(error, message)) {
    return true;
  }
  if (/\bfetch failed\b/i.test(message)) {
    return hasTransientNetworkSignal(error, message);
  }
  return false;
}

export function resolveTransientProviderAttempts(options?: TransientProviderRetryOptions): number {
  if (!options) {
    return 1;
  }
  return Math.max(1, Math.round(Number.isFinite(options.attempts) ? options.attempts : 1));
}

export function resolveTransientProviderDelayMs(
  options: TransientProviderRetryOptions,
  attemptNumber: number,
): number {
  const rawBaseDelayMs = options.baseDelayMs ?? 250;
  const baseDelayMs = Math.max(
    0,
    Math.round(Number.isFinite(rawBaseDelayMs) ? rawBaseDelayMs : 250),
  );
  const rawMaxDelayMs = options.maxDelayMs ?? 1_000;
  const maxDelayMs = Math.max(
    baseDelayMs,
    Math.round(Number.isFinite(rawMaxDelayMs) ? rawMaxDelayMs : 1_000),
  );
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(attemptNumber - 1, 0));
}

export function shouldRetrySameKeyProviderOperation(params: {
  options: TransientProviderRetryOptions;
  error: unknown;
  message: string;
  provider: string;
  apiKeyIndex: number;
  attemptNumber: number;
  maxAttempts: number;
  stage?: ProviderOperationRetryStage;
}): boolean {
  if (params.attemptNumber >= params.maxAttempts) {
    return false;
  }
  if (params.options.signal?.aborted) {
    return false;
  }
  const retryParams: TransientProviderRetryParams = {
    error: params.error,
    message: params.message,
    provider: params.provider,
    apiKeyIndex: params.apiKeyIndex,
    attemptNumber: params.attemptNumber,
    ...(params.stage ? { stage: params.stage } : {}),
  };
  return params.options.shouldRetry
    ? params.options.shouldRetry(retryParams)
    : isTransientProviderOperationError(params.error, params.message);
}

export async function executeProviderOperationWithRetry<T>(params: {
  provider: string;
  stage: ProviderOperationRetryStage;
  operation: () => Promise<T>;
  retry?: TransientProviderRetryConfig;
}): Promise<T> {
  const retryConfig = providerOperationRetryConfig(params.stage, params.retry);
  const retryOptions = resolveTransientProviderRetryOptions(retryConfig);
  const maxAttempts = resolveTransientProviderAttempts(retryOptions);
  let lastError: unknown;

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    try {
      return await params.operation();
    } catch (error) {
      lastError = error;
      const message = formatErrorMessage(error);
      if (
        !retryOptions ||
        !shouldRetrySameKeyProviderOperation({
          options: retryOptions,
          error,
          message,
          provider: params.provider,
          apiKeyIndex: 0,
          attemptNumber,
          maxAttempts,
          stage: params.stage,
        })
      ) {
        throw error;
      }

      const delayMs = resolveTransientProviderDelayMs(retryOptions, attemptNumber);
      const sleep = retryOptions.sleep ?? sleepWithAbort;
      await sleep(delayMs, retryOptions.signal);
    }
  }

  throw lastError;
}
