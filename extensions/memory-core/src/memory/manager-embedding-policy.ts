// Memory Core plugin module implements manager embedding policy behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  isRemoteProviderQuotaError,
  readRemoteProviderErrorFacts,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
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

// Message fallback for providers that throw plain errors without a structured
// status (Bedrock, Copilot, local runtimes). Status numbers must sit next to
// an HTTP-ish marker so payload numbers ("512 dimensions") never match.
const RETRYABLE_MEMORY_EMBEDDING_SERVICE_ERROR_RE =
  /(rate[_ ]limit|too many requests|resource has been exhausted|cloudflare|tokens per day|(?::\s*|\bhttp\s+|\bstatus\s+|\bcode\s+|\()(?:429|5\d\d)\b)/i;

const RETRYABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE =
  /(fetch failed|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_|socket hang up|socket terminated|network error|read ECONN|timed out|connection (?:reset|refused|aborted|timed out)|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EAI_AGAIN)/i;

const SPLITTABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE =
  /(request_headers_too_large|request header fields too large|other side closed|ECONNRESET|EPIPE|UND_ERR_SOCKET|socket hang up|socket terminated|read ECONN|connection (?:reset|aborted))/i;

function isRetryableMemoryEmbeddingTransportError(message: string): boolean {
  return RETRYABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE.test(message);
}

export function isSplittableMemoryEmbeddingTransportError(message: string): boolean {
  return SPLITTABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE.test(message);
}

export function isRetryableMemoryEmbeddingError(err: unknown): boolean {
  // Exhausted quota is a terminal 429: retrying burns paid requests that can
  // never succeed until an operator restores billing.
  if (isRemoteProviderQuotaError(err)) {
    return false;
  }
  const status = readRemoteProviderErrorFacts(err).status;
  if (status !== undefined) {
    // 408/429/5xx are transient by HTTP contract; any other 4xx means the
    // provider definitively rejected this request or credential.
    return status === 408 || status === 429 || status >= 500;
  }
  const message = formatErrorMessage(err);
  return (
    RETRYABLE_MEMORY_EMBEDDING_SERVICE_ERROR_RE.test(message) ||
    isRetryableMemoryEmbeddingTransportError(message)
  );
}

/**
 * Account-level provider rejections (quota, billing, auth) that keep failing
 * until an operator acts; callers pause embeddings instead of retrying them
 * on every sync.
 */
export function isMemoryEmbeddingProviderAccessError(err: unknown): boolean {
  if (isRemoteProviderQuotaError(err)) {
    return true;
  }
  const status = readRemoteProviderErrorFacts(err).status;
  return status === 401 || status === 402 || status === 403;
}

// Caps both jittered backoff and honored Retry-After hints. Retry sleeps run
// inside the single-flight sync slot, so an unbounded server hint would starve
// every queued session sync behind it.
export const MEMORY_EMBEDDING_RETRY_MAX_DELAY_MS = 30_000;

export function resolveMemoryEmbeddingRetryDelay(
  delayMs: number,
  randomValue: number,
  maxDelayMs: number,
): number {
  return Math.min(maxDelayMs, Math.round(delayMs * (1 + randomValue * 0.2)));
}

export async function runMemoryEmbeddingRetryLoop<T>(params: {
  run: () => Promise<T>;
  isRetryable: (err: unknown) => boolean;
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
    shouldRetry: (err) => !params.signal?.aborted && params.isRetryable(err),
    // A genuine rate-limit hint beats exponential guessing at when the
    // provider will accept the next request.
    retryAfterMs: (err) => readRemoteProviderErrorFacts(err).retryAfterMs,
    retryAfterMaxDelayMs: MEMORY_EMBEDDING_RETRY_MAX_DELAY_MS,
    sleep: params.waitForRetry,
  });
}

export async function runMemoryEmbeddingBatchRetryWithSplit<TInput, TOutput>(params: {
  items: TInput[];
  run: (items: TInput[]) => Promise<TOutput[]>;
  isRetryable: (err: unknown) => boolean;
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
