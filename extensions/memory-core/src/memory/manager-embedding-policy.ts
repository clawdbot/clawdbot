// Memory Core plugin module implements manager embedding policy behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";

type MemoryEmbeddingTextPart = {
  type: "text";
  text: string;
};

type MemoryEmbeddingInlineDataPart = {
  type: "inline-data";
  mimeType: string;
  data: string;
};

type MemoryEmbeddingInput = {
  text: string;
  parts?: Array<MemoryEmbeddingTextPart | MemoryEmbeddingInlineDataPart>;
};

type MemoryEmbeddingChunk = {
  text: string;
  embeddingInput?: MemoryEmbeddingInput;
};

function estimateUtf8Bytes(text: string): number {
  if (!text) {
    return 0;
  }
  return Buffer.byteLength(text, "utf8");
}

function estimateStructuredEmbeddingInputBytes(input: MemoryEmbeddingInput): number {
  if (!input.parts?.length) {
    return estimateUtf8Bytes(input.text);
  }
  let total = 0;
  for (const part of input.parts) {
    if (part.type === "text") {
      total += estimateUtf8Bytes(part.text);
    } else {
      total += estimateUtf8Bytes(part.mimeType);
      total += estimateUtf8Bytes(part.data);
    }
  }
  return total;
}

export function filterNonEmptyMemoryChunks<T extends MemoryEmbeddingChunk>(chunks: T[]): T[] {
  return chunks.filter((chunk) => chunk.text.trim().length > 0);
}

export function buildMemoryEmbeddingBatches<T extends MemoryEmbeddingChunk>(
  chunks: T[],
  maxTokens: number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;

  for (const chunk of chunks) {
    const estimate = chunk.embeddingInput
      ? estimateStructuredEmbeddingInputBytes(chunk.embeddingInput)
      : estimateUtf8Bytes(chunk.text);
    const wouldExceed = current.length > 0 && currentTokens + estimate > maxTokens;
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && estimate > maxTokens) {
      batches.push([chunk]);
      continue;
    }
    current.push(chunk);
    currentTokens += estimate;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

const RETRYABLE_MEMORY_EMBEDDING_SERVICE_ERROR_RE =
  /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare|tokens per day)/i;

const RETRYABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE =
  /(fetch failed|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_|socket hang up|socket terminated|network error|read ECONN|timed out|connection (?:reset|refused|aborted|timed out)|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EAI_AGAIN)/i;

const SPLITTABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE =
  /(request_headers_too_large|request header fields too large|other side closed|ECONNRESET|EPIPE|UND_ERR_SOCKET|socket hang up|socket terminated|read ECONN|connection (?:reset|aborted))/i;

// 402/billing failures mean "will keep failing until the next billing cycle or a plan
// change" — unlike 429/5xx, retrying sooner cannot help, so this is classified separately
// to drive a long cooldown instead of the short in-call retry loop. A 402 carrying a
// periodic/rolling-window or organization-scoped usage-limit signal is transient (resets
// on its own, like a rate limit) rather than a durable billing failure — mirrors the same
// distinction core's failover classifier makes for chat-completion providers
// (src/agents/failover/classification-rules.ts), reimplemented locally since extensions
// cannot import core internals.
const BILLING_EXHAUSTED_MEMORY_EMBEDDING_ERROR_RE =
  /(^| )402(\D|$)|payment required|insufficient_quota|insufficient quota|check your subscription|billing|quota exceeded/i;

// A periodic/scoped word alone is not enough to call a 402 transient -- e.g. "402 monthly
// subscription quota exhausted; check your subscription" is a durable billing failure that
// happens to mention "monthly". Require a periodic/scoped/retry hint together with a
// usage-limit, spend-limit, or reset signal, mirroring the bounded AND-combinations
// src/agents/failover/classification-rules.ts's hasRetryable402TransientSignal uses for the
// same distinction on chat-completion providers (reimplemented locally since extensions
// cannot import core internals).
const PERIODIC_402_HINT_RE = /(daily|weekly|monthly)/i;
const USAGE_OR_SPEND_LIMIT_402_HINT_RE = /(usage limit|organization usage|spend(?:ing)? limit)/i;
const RESET_402_HINT_RE = /resets? (?:in|at)/i;
const QUOTA_REFRESH_WINDOW_402_HINT_RE = /(rolling time window|automatic quota refresh)/i;
const RETRY_402_HINT_RE = /try again (?:in|later)/i;
const LIMIT_WORD_RE = /limit/i;
const BILLING_PERIOD_402_HINT_RE = /billing period/i;

function isTransientMemoryEmbedding402Signal(message: string): boolean {
  const hasPeriodicHint = PERIODIC_402_HINT_RE.test(message);
  const hasUsageOrSpendLimitHint = USAGE_OR_SPEND_LIMIT_402_HINT_RE.test(message);
  const hasLimitWord = LIMIT_WORD_RE.test(message);
  return (
    QUOTA_REFRESH_WINDOW_402_HINT_RE.test(message) ||
    (hasPeriodicHint && (hasUsageOrSpendLimitHint || RESET_402_HINT_RE.test(message))) ||
    (BILLING_PERIOD_402_HINT_RE.test(message) && (hasPeriodicHint || hasLimitWord)) ||
    (RETRY_402_HINT_RE.test(message) && (hasUsageOrSpendLimitHint || hasLimitWord))
  );
}

function isRetryableMemoryEmbeddingTransportError(message: string): boolean {
  return RETRYABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE.test(message);
}

export function isSplittableMemoryEmbeddingTransportError(message: string): boolean {
  return SPLITTABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE.test(message);
}

/** Whether a failure means the embedding provider is out of quota/billing until a future cycle. */
export function isBillingExhaustedMemoryEmbeddingError(message: string): boolean {
  if (!BILLING_EXHAUSTED_MEMORY_EMBEDDING_ERROR_RE.test(message)) {
    return false;
  }
  return !isTransientMemoryEmbedding402Signal(message);
}

export function isRetryableMemoryEmbeddingError(message: string): boolean {
  return (
    RETRYABLE_MEMORY_EMBEDDING_SERVICE_ERROR_RE.test(message) ||
    isRetryableMemoryEmbeddingTransportError(message)
  );
}

export function resolveMemoryEmbeddingRetryDelay(
  delayMs: number,
  randomValue: number,
  maxDelayMs: number,
): number {
  return Math.min(maxDelayMs, Math.round(delayMs * (1 + randomValue * 0.2)));
}

export async function runMemoryEmbeddingRetryLoop<T>(params: {
  run: () => Promise<T>;
  isRetryable: (message: string) => boolean;
  waitForRetry: (delayMs: number) => Promise<void>;
  maxAttempts: number;
  baseDelayMs: number;
  /** Caller-owned cancellation; an aborted caller stops the retry loop. */
  signal?: AbortSignal;
}): Promise<T> {
  return await retryAsync(params.run, {
    attempts: params.maxAttempts,
    minDelayMs: params.baseDelayMs,
    maxDelayMs: Number.MAX_SAFE_INTEGER,
    // Caller cancellation wins even when its timeout resembles a retryable
    // provider error; otherwise abandoned searches start another request.
    shouldRetry: (err) => !params.signal?.aborted && params.isRetryable(formatErrorMessage(err)),
    sleep: params.waitForRetry,
  });
}

export async function runMemoryEmbeddingBatchRetryWithSplit<TInput, TOutput>(params: {
  items: TInput[];
  run: (items: TInput[]) => Promise<TOutput[]>;
  isRetryable: (message: string) => boolean;
  isSplittable: (message: string) => boolean;
  waitForRetry: (delayMs: number) => Promise<void>;
  maxAttempts: number;
  baseDelayMs: number;
  onSplit?: (info: { itemCount: number; splitAt: number; message: string }) => void;
}): Promise<TOutput[]> {
  try {
    return await runMemoryEmbeddingRetryLoop({
      run: async () => await params.run(params.items),
      isRetryable: params.isRetryable,
      waitForRetry: params.waitForRetry,
      maxAttempts: params.maxAttempts,
      baseDelayMs: params.baseDelayMs,
    });
  } catch (err) {
    const message = formatErrorMessage(err);
    if (params.items.length <= 1 || !params.isSplittable(message)) {
      throw err;
    }

    const splitAt = Math.ceil(params.items.length / 2);
    params.onSplit?.({ itemCount: params.items.length, splitAt, message });
    const left = await runMemoryEmbeddingBatchRetryWithSplit({
      ...params,
      items: params.items.slice(0, splitAt),
    });
    const right = await runMemoryEmbeddingBatchRetryWithSplit({
      ...params,
      items: params.items.slice(splitAt),
    });
    return [...left, ...right];
  }
}

export function buildTextEmbeddingInputs(chunks: MemoryEmbeddingChunk[]): MemoryEmbeddingInput[] {
  return chunks.map((chunk) => chunk.embeddingInput ?? { text: chunk.text });
}
