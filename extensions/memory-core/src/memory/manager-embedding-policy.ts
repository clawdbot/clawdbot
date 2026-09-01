// Memory Core plugin module implements manager embedding policy behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
  type EmbeddingInput,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

type MemoryEmbeddingChunk = {
  text: string;
  embeddingInput?: EmbeddingInput;
};

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

const RATE_LIMITED_MEMORY_EMBEDDING_ERROR_RE =
  /(rate[_ ]limit|too many requests|\b429\b|resource has been exhausted|tokens per day)/i;

const RETRYABLE_MEMORY_EMBEDDING_SERVICE_ERROR_RE = /\b5\d\d\b|cloudflare/i;

const RETRYABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE =
  /(fetch failed|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_|socket hang up|socket terminated|network error|read ECONN|timed out|connection (?:reset|refused|aborted|timed out)|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EAI_AGAIN)/i;

const SPLITTABLE_MEMORY_EMBEDDING_BATCH_ERROR_RE =
  /(request_headers_too_large|request header fields too large|other side closed|ECONNRESET|EPIPE|UND_ERR_SOCKET|socket hang up|socket terminated|read ECONN|connection (?:reset|aborted)|\bembeddings (?:api input limit exceeded:\s*max\s+\d+\s*,\s*got\s+\d+|max input length is\s+\d+)\b)/i;

const SHORT_MEMORY_EMBEDDING_RETRY_BUDGET = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
} as const;
const MEMORY_EMBEDDING_RETRY_PROFILES = {
  index: {
    transient: SHORT_MEMORY_EMBEDDING_RETRY_BUDGET,
    rateLimit: { attempts: 5, baseDelayMs: 5000, maxDelayMs: 60_000 },
    maxTotalWaitMs: Number.POSITIVE_INFINITY,
  },
  query: {
    transient: SHORT_MEMORY_EMBEDDING_RETRY_BUDGET,
    rateLimit: SHORT_MEMORY_EMBEDDING_RETRY_BUDGET,
    maxTotalWaitMs: 8000,
  },
} as const;
export type MemoryEmbeddingRetryProfileName = keyof typeof MEMORY_EMBEDDING_RETRY_PROFILES;

export function isSplittableMemoryEmbeddingBatchError(message: string): boolean {
  return SPLITTABLE_MEMORY_EMBEDDING_BATCH_ERROR_RE.test(message);
}

function readMemoryEmbeddingRetryAfterMs(error: unknown): number | undefined {
  const value = asOptionalRecord(error)?.retryAfterMs;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function resolveMemoryEmbeddingRetryBudget(
  profile: (typeof MEMORY_EMBEDDING_RETRY_PROFILES)[MemoryEmbeddingRetryProfileName],
  error: unknown,
) {
  const fields = asOptionalRecord(error);
  const message = formatErrorMessage(error);
  const retryAfterMs = readMemoryEmbeddingRetryAfterMs(error);
  const status = [fields?.status, fields?.statusCode].find(
    (value): value is number => typeof value === "number" && Number.isInteger(value),
  );
  const code = normalizeOptionalString(fields?.errorCode) ?? normalizeOptionalString(fields?.code);
  if (code?.toLowerCase() === "quota_exceeded" && retryAfterMs === undefined) {
    return undefined;
  }
  if (status === 429 || RATE_LIMITED_MEMORY_EMBEDDING_ERROR_RE.test(message)) {
    return profile.rateLimit;
  }
  return RETRYABLE_MEMORY_EMBEDDING_TRANSPORT_ERROR_RE.test(message) ||
    (!isSplittableMemoryEmbeddingBatchError(message) &&
      ((status !== undefined && status >= 500 && status <= 599) ||
        RETRYABLE_MEMORY_EMBEDDING_SERVICE_ERROR_RE.test(message)))
    ? profile.transient
    : undefined;
}

export async function runMemoryEmbeddingRetryLoop<T>(params: {
  profile: MemoryEmbeddingRetryProfileName;
  run: () => Promise<T>;
  waitForRetry: (delayMs: number) => Promise<void>;
  /** Caller-owned cancellation; an aborted caller stops the retry loop. */
  signal?: AbortSignal;
}): Promise<T> {
  const profile = MEMORY_EMBEDDING_RETRY_PROFILES[params.profile];
  let remainingWaitMs = profile.maxTotalWaitMs;
  return await retryAsync(params.run, {
    attempts: profile.rateLimit.attempts,
    minDelayMs: profile.transient.baseDelayMs,
    maxDelayMs: profile.rateLimit.maxDelayMs,
    retryAfterMaxDelayMs: profile.rateLimit.maxDelayMs,
    jitter: 0.2,
    // Caller cancellation wins even when its timeout resembles a retryable
    // provider error; otherwise abandoned searches start another request.
    shouldRetry: (err, attempt) => {
      if (params.signal?.aborted) {
        return false;
      }
      const retryBudget = resolveMemoryEmbeddingRetryBudget(profile, err);
      return retryBudget !== undefined && attempt < retryBudget.attempts;
    },
    delayMs: ({ attempt, err }) => {
      const retryBudget = resolveMemoryEmbeddingRetryBudget(profile, err);
      return retryBudget
        ? Math.min(retryBudget.maxDelayMs, retryBudget.baseDelayMs * 2 ** (attempt - 1))
        : 0;
    },
    // The query profile shares one short budget for both classes, so this gate
    // also admits hints on transient errors there — accepted: every honored
    // hint stays under the profile's per-wait cap and cumulative wait ceiling.
    retryAfterMs: (err) =>
      resolveMemoryEmbeddingRetryBudget(profile, err) === profile.rateLimit
        ? readMemoryEmbeddingRetryAfterMs(err)
        : undefined,
    sleep: async (delayMs) => {
      const boundedDelayMs = Math.min(delayMs, remainingWaitMs);
      remainingWaitMs -= boundedDelayMs;
      await params.waitForRetry(boundedDelayMs);
    },
  });
}

export async function runMemoryEmbeddingBatchRetryWithSplit<TInput, TOutput>(params: {
  profile: MemoryEmbeddingRetryProfileName;
  items: TInput[];
  run: (items: TInput[]) => Promise<TOutput[]>;
  isSplittable: (message: string) => boolean;
  waitForRetry: (delayMs: number) => Promise<void>;
  onSplit?: (info: { itemCount: number; splitAt: number; message: string }) => void;
}): Promise<TOutput[]> {
  try {
    return await runMemoryEmbeddingRetryLoop({
      profile: params.profile,
      run: async () => await params.run(params.items),
      waitForRetry: params.waitForRetry,
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

export function buildTextEmbeddingInputs(chunks: MemoryEmbeddingChunk[]): EmbeddingInput[] {
  return chunks.map((chunk) => chunk.embeddingInput ?? { text: chunk.text });
}
