// Memory Core plugin module implements manager embedding ops behavior.
import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  enforceEmbeddingMaxInputTokens,
  hasNonTextEmbeddingParts,
  isEmbeddingBatchUnavailableError,
  type EmbeddingInput,
  type MemoryEmbeddingProviderRuntime,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  hashText,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  remapChunkLines,
  retryTransientMemoryRead,
  runWithConcurrency,
  type MemoryChunk,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { MAX_TIMER_TIMEOUT_MS, resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  MEMORY_BATCH_FAILURE_LIMIT,
  recordMemoryBatchFailure,
  resetMemoryBatchFailureState,
} from "./manager-batch-state.js";
import {
  collectMemoryCachedEmbeddings,
  loadMemoryEmbeddingCache,
  upsertMemoryEmbeddingCache,
} from "./manager-embedding-cache.js";
import { createMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import {
  buildMemoryEmbeddingBatches,
  buildTextEmbeddingInputs,
  filterNonEmptyMemoryChunks,
  isRetryableMemoryEmbeddingError,
  isSplittableMemoryEmbeddingTransportError,
  resolveMemoryEmbeddingRetryDelay,
  runMemoryEmbeddingBatchRetryWithSplit,
  runMemoryEmbeddingRetryLoop,
} from "./manager-embedding-policy.js";
import { deleteMemoryFtsRows } from "./manager-fts-state.js";
import {
  resolveMemoryIndexProviderIdentities,
  type MemoryIndexProviderIdentity,
} from "./manager-reindex-state.js";
import { MemoryManagerSyncOps, type MemoryIndexWorkItem } from "./manager-sync-ops.js";
import { logMemoryVectorDegradedWrite } from "./manager-vector-warning.js";
import { replaceMemoryVectorRow } from "./manager-vector-write.js";

const VECTOR_TABLE = MEMORY_INDEX_VECTOR_TABLE;
const FTS_TABLE = MEMORY_INDEX_FTS_TABLE;
const EMBEDDING_CACHE_TABLE = MEMORY_EMBEDDING_CACHE_TABLE;
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;
const SOURCE_WIDE_BATCH_MAX_FILES = 2048;
const SOURCE_WIDE_BATCH_MAX_REQUESTS = 50000;

const log = createSubsystemLogger("memory");

function resolveEmbeddingSecondsTimeoutMs(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  const timeoutMs = Math.floor(seconds * 1000);
  return resolveTimerTimeoutMs(
    Number.isFinite(timeoutMs) ? timeoutMs : MAX_TIMER_TIMEOUT_MS,
    MAX_TIMER_TIMEOUT_MS,
  );
}

type MemoryIndexEntry = MemoryIndexWorkItem["entry"];

type PreparedMemoryIndexEntry = {
  entry: MemoryIndexEntry;
  source: MemorySource;
  chunks: MemoryChunk[];
  structuredInputBytes?: number;
};

// Retry attempts are host control state. Provider-thrown values stay opaque so
// they cannot override the counter or break accounting when they are immutable.
type MemoryBatchRetryResult<T> =
  | { kind: "success"; value: T }
  | { kind: "failure"; error: unknown; attempts: 1 | 2 };

function countBatchSources(items: Array<{ source: MemorySource }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.source] = (counts[item.source] ?? 0) + 1;
  }
  return counts;
}

function formatBatchSourceLabel(counts: Record<string, number>): string {
  const sources = Object.keys(counts).toSorted();
  return sources.length > 0 ? sources.join("+") : "unknown";
}

function formatBatchSourceCounts(counts: Record<string, number>): string {
  return (
    Object.entries(counts)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([source, count]) => `${source}=${count}`)
      .join(",") || "none"
  );
}

export function splitSourceWideEmbeddingChunks<T>(chunks: T[], maxRequests: number): T[][] {
  const limit = Math.max(1, Math.floor(maxRequests));
  const batches: T[][] = [];
  for (let start = 0; start < chunks.length; start += limit) {
    batches.push(chunks.slice(start, start + limit));
  }
  return batches;
}

export function resolveEmbeddingTimeoutMs(params: {
  kind: "query" | "batch";
  providerId?: string;
  providerRuntime?: Pick<
    MemoryEmbeddingProviderRuntime,
    "inlineQueryTimeoutMs" | "inlineBatchTimeoutMs"
  >;
  configuredBatchTimeoutSeconds?: number;
}): number {
  if (params.kind === "query") {
    const runtimeTimeoutMs = params.providerRuntime?.inlineQueryTimeoutMs;
    if (typeof runtimeTimeoutMs === "number" && runtimeTimeoutMs > 0) {
      return resolveTimerTimeoutMs(runtimeTimeoutMs, EMBEDDING_QUERY_TIMEOUT_REMOTE_MS);
    }
    return params.providerId === "local"
      ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS
      : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
  }

  const configuredTimeoutSeconds = params.configuredBatchTimeoutSeconds;
  if (typeof configuredTimeoutSeconds === "number" && configuredTimeoutSeconds > 0) {
    return resolveEmbeddingSecondsTimeoutMs(configuredTimeoutSeconds);
  }
  const runtimeTimeoutMs = params.providerRuntime?.inlineBatchTimeoutMs;
  if (typeof runtimeTimeoutMs === "number" && runtimeTimeoutMs > 0) {
    return resolveTimerTimeoutMs(runtimeTimeoutMs, EMBEDDING_BATCH_TIMEOUT_REMOTE_MS);
  }
  return params.providerId === "local"
    ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS
    : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
}

export function resolveMemoryIndexConcurrency(params: {
  batch: { enabled: boolean; concurrency: number };
  configuredNonBatchConcurrency?: number;
  providerId?: string;
}): number {
  if (params.batch.enabled) {
    return params.batch.concurrency;
  }
  const configured = params.configuredNonBatchConcurrency;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(1, Math.floor(configured));
  }
  return params.providerId === "ollama" ? 1 : EMBEDDING_INDEX_CONCURRENCY;
}

export async function runEmbeddingOperationWithTimeout<T>(params: {
  timeoutMs: number;
  message: string;
  /** Caller-owned cancellation, merged with the per-call watchdog abort. */
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
    return await params.run(signal);
  }
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(params.message);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    const operation = params.run(signal);
    return (await Promise.race([operation, timeoutPromise])) as T;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export abstract class MemoryManagerEmbeddingOps extends MemoryManagerSyncOps {
  protected abstract batchFailureCount: number;
  protected abstract batchFailureLastError?: string;
  protected abstract batchFailureLastProvider?: string;
  protected abstract batchFailureLock: Promise<void>;
  protected abstract markLocalEmbeddingProviderDegraded(err: unknown): void;

  protected pruneEmbeddingCacheIfNeeded(): void {
    if (!this.cache.enabled) {
      return;
    }
    const max = this.cache.maxEntries;
    if (!max || max <= 0) {
      return;
    }
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
      | { c: number }
      | undefined;
    const count = row?.c ?? 0;
    if (count <= max) {
      return;
    }
    const excess = count - max;
    this.db
      .prepare(
        `DELETE FROM ${EMBEDDING_CACHE_TABLE}\n` +
          ` WHERE rowid IN (\n` +
          `   SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}\n` +
          `   ORDER BY updated_at ASC\n` +
          `   LIMIT ?\n` +
          ` )`,
      )
      .run(excess);
  }

  private upsertEmbeddingCacheEntries(
    entries: Array<{ hash: string; embedding: number[] }>,
    provider: { id: string; model: string } | null = this.provider,
  ): void {
    upsertMemoryEmbeddingCache({
      db: this.db,
      enabled: this.cache.enabled,
      provider,
      providerKey: this.providerKey,
      entries,
      tableName: EMBEDDING_CACHE_TABLE,
    });
  }

  private async embedChunksInBatches(chunks: MemoryChunk[]): Promise<number[][]> {
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks);

    if (missing.length === 0) {
      return embeddings;
    }

    const missingChunks = missing.map((m) => m.chunk);
    const batches = buildMemoryEmbeddingBatches(missingChunks, EMBEDDING_BATCH_MAX_TOKENS);
    const provider = this.provider;
    if (!provider) {
      throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
    }
    let cursor = 0;
    for (const batch of batches) {
      const inputs = buildTextEmbeddingInputs(batch);
      const hasStructuredInputs = inputs.some((input) => hasNonTextEmbeddingParts(input));
      if (hasStructuredInputs && !provider.embedBatchInputs) {
        throw createMemoryEmbeddingOperationError({
          operation: "structured-batch",
          providerId: provider.id,
          cause: new Error(
            `Embedding provider "${provider.id}" does not support multimodal memory inputs.`,
          ),
        });
      }
      const batchEmbeddings = hasStructuredInputs
        ? await this.embedBatchInputsWithRetry(inputs)
        : await this.embedBatchWithRetry(batch.map((chunk) => chunk.text));
      const batchCacheEntries: Array<{ hash: string; embedding: number[] }> = [];
      for (let i = 0; i < batch.length; i += 1) {
        const item = missing[cursor + i];
        const embedding = batchEmbeddings[i] ?? [];
        if (item) {
          embeddings[item.index] = embedding;
          batchCacheEntries.push({ hash: item.chunk.hash, embedding });
        }
      }
      this.upsertEmbeddingCacheEntries(batchCacheEntries);
      cursor += batch.length;
    }
    return embeddings;
  }

  protected computeProviderKey(): string {
    return expectDefined(
      this.resolveProviderIndexIdentities().at(0),
      "primary memory provider identity",
    ).providerKey;
  }

  protected resolveProviderIndexIdentities(): MemoryIndexProviderIdentity[] {
    return resolveMemoryIndexProviderIdentities({
      provider: this.provider,
      cacheKeyData: this.providerRuntime?.cacheKeyData,
      aliases: this.providerRuntime?.indexIdentityAliases,
    });
  }

  private buildBatchDebug(
    source: string,
    chunks: MemoryChunk[],
    context: Record<string, unknown> = {},
  ) {
    return (message: string, data?: Record<string, unknown>) =>
      log.debug(
        message,
        data
          ? { ...data, source, chunks: chunks.length, ...context }
          : { source, chunks: chunks.length, ...context },
      );
  }

  private async embedChunksWithBatch(
    chunks: MemoryChunk[],
    _entry: MemoryIndexEntry,
    source: string,
    debugContext: Record<string, unknown> = {},
  ): Promise<number[][]> {
    const provider = this.provider;
    const batchEmbed = this.providerRuntime?.batchEmbed;
    if (!provider || !batchEmbed) {
      return this.embedChunksInBatches(chunks);
    }
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks);
    if (missing.length === 0) {
      return embeddings;
    }

    const missingChunks = missing.map((item) => item.chunk);
    const batchResult = await this.runBatchWithFallback({
      provider: provider.id,
      run: async () =>
        await batchEmbed({
          agentId: this.agentId,
          chunks: missingChunks,
          wait: this.batch.wait,
          concurrency: this.batch.concurrency,
          pollIntervalMs: this.batch.pollIntervalMs,
          timeoutMs: this.batch.timeoutMs,
          debug: this.buildBatchDebug(source, chunks, debugContext),
        }),
      fallback: async () => await this.embedChunksInBatches(missingChunks),
    });
    if (!batchResult) {
      return this.embedChunksInBatches(chunks);
    }
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    for (let index = 0; index < missing.length; index += 1) {
      const item = missing[index];
      const embedding = batchResult[index] ?? [];
      if (!item) {
        continue;
      }
      embeddings[item.index] = embedding;
      toCache.push({ hash: item.chunk.hash, embedding });
    }
    this.upsertEmbeddingCacheEntries(toCache, provider);
    return embeddings;
  }

  private collectCachedEmbeddings(chunks: MemoryChunk[]): {
    embeddings: number[][];
    missing: Array<{ index: number; chunk: MemoryChunk }>;
  } {
    return collectMemoryCachedEmbeddings({
      chunks,
      cached: loadMemoryEmbeddingCache({
        db: this.db,
        enabled: this.cache.enabled,
        providerIdentities: this.provider ? this.resolveProviderIndexIdentities() : [],
        hashes: chunks.map((chunk) => chunk.hash),
        tableName: EMBEDDING_CACHE_TABLE,
      }),
    });
  }

  protected async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const provider = this.provider;
    if (!provider) {
      throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
    }
    try {
      return await runMemoryEmbeddingBatchRetryWithSplit({
        items: texts,
        run: async (batchTexts) => {
          const timeoutMs = this.resolveEmbeddingTimeout("batch");
          log.debug("memory embeddings: batch start", {
            provider: provider.id,
            items: batchTexts.length,
            timeoutMs,
          });
          const result = await runEmbeddingOperationWithTimeout({
            timeoutMs,
            message: `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
            run: async (signal) => await provider.embedBatch(batchTexts, { signal }),
          });
          log.debug("memory embeddings: batch completed", {
            provider: provider.id,
            items: batchTexts.length,
          });
          return result;
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        isSplittable: isSplittableMemoryEmbeddingTransportError,
        waitForRetry: async (delayMs) => {
          await this.waitForEmbeddingRetry(delayMs, "retrying");
        },
        maxAttempts: EMBEDDING_RETRY_MAX_ATTEMPTS,
        baseDelayMs: EMBEDDING_RETRY_BASE_DELAY_MS,
        onSplit: ({ itemCount, splitAt }) => {
          log.warn(
            `memory embeddings transport failed after retries; splitting batch of ${itemCount} into ${splitAt} + ${itemCount - splitAt}`,
          );
        },
      });
    } catch (err) {
      log.debug("memory embeddings: batch failed", {
        provider: provider.id,
        error: formatErrorMessage(err),
      });
      this.markLocalEmbeddingProviderDegraded(err);
      throw createMemoryEmbeddingOperationError({
        operation: "batch",
        providerId: provider.id,
        cause: err,
      });
    }
  }

  protected async embedBatchInputsWithRetry(inputs: EmbeddingInput[]): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    const provider = this.provider;
    const embedBatchInputs = provider?.embedBatchInputs;
    if (!embedBatchInputs) {
      return await this.embedBatchWithRetry(inputs.map((input) => input.text));
    }
    try {
      return await runMemoryEmbeddingBatchRetryWithSplit({
        items: inputs,
        run: async (batchInputs) => {
          const timeoutMs = this.resolveEmbeddingTimeout("batch");
          log.debug("memory embeddings: structured batch start", {
            provider: provider.id,
            items: batchInputs.length,
            timeoutMs,
          });
          return await runEmbeddingOperationWithTimeout({
            timeoutMs,
            message: `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
            run: async (signal) => await embedBatchInputs(batchInputs, { signal }),
          });
        },
        isRetryable: isRetryableMemoryEmbeddingError,
        isSplittable: isSplittableMemoryEmbeddingTransportError,
        waitForRetry: async (delayMs) => {
          await this.waitForEmbeddingRetry(delayMs, "retrying structured batch");
        },
        maxAttempts: EMBEDDING_RETRY_MAX_ATTEMPTS,
        baseDelayMs: EMBEDDING_RETRY_BASE_DELAY_MS,
        onSplit: ({ itemCount, splitAt }) => {
          log.warn(
            `memory embeddings transport failed after retries; splitting structured batch of ${itemCount} into ${splitAt} + ${itemCount - splitAt}`,
          );
        },
      });
    } catch (err) {
      this.markLocalEmbeddingProviderDegraded(err);
      throw createMemoryEmbeddingOperationError({
        operation: "structured-batch",
        providerId: provider.id,
        cause: err,
      });
    }
  }

  private async waitForEmbeddingRetry(delayMs: number, action: string): Promise<void> {
    const waitMs = resolveMemoryEmbeddingRetryDelay(
      delayMs,
      Math.random(),
      EMBEDDING_RETRY_MAX_DELAY_MS,
    );
    log.warn(`memory embeddings retryable error; ${action} in ${waitMs}ms`);
    await new Promise((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }

  private resolveEmbeddingTimeout(kind: "query" | "batch"): number {
    return resolveEmbeddingTimeoutMs({
      kind,
      providerId: this.provider?.id,
      providerRuntime: this.providerRuntime,
      configuredBatchTimeoutSeconds: this.settings.sync.embeddingBatchTimeoutSeconds,
    });
  }

  protected async embedQueryWithRetry(text: string, signal?: AbortSignal): Promise<number[]> {
    const provider = this.provider;
    if (!provider) {
      throw new Error("Cannot embed query in FTS-only mode (no embedding provider)");
    }
    try {
      return await runMemoryEmbeddingRetryLoop({
        run: async () => {
          signal?.throwIfAborted();
          const timeoutMs = this.resolveEmbeddingTimeout("query");
          log.debug("memory embeddings: query start", { provider: provider.id, timeoutMs });
          return await runEmbeddingOperationWithTimeout({
            timeoutMs,
            message: `memory embeddings query timed out after ${Math.round(timeoutMs / 1000)}s`,
            signal,
            run: async (opSignal) => await provider.embedQuery(text, { signal: opSignal }),
          });
        },
        signal,
        isRetryable: isRetryableMemoryEmbeddingError,
        waitForRetry: async (delayMs) => {
          await this.waitForEmbeddingRetry(delayMs, "retrying query");
        },
        maxAttempts: EMBEDDING_RETRY_MAX_ATTEMPTS,
        baseDelayMs: EMBEDDING_RETRY_BASE_DELAY_MS,
      });
    } catch (err) {
      this.markLocalEmbeddingProviderDegraded(err);
      throw createMemoryEmbeddingOperationError({
        operation: "query",
        providerId: provider.id,
        cause: err,
      });
    }
  }

  protected async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return await promise;
    }
    const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), resolvedTimeoutMs);
    });
    try {
      return (await Promise.race([promise, timeoutPromise])) as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async withBatchFailureLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const wait = this.batchFailureLock;
    this.batchFailureLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  private async resetBatchFailureCount(): Promise<void> {
    await this.withBatchFailureLock(async () => {
      if (this.batchFailureCount > 0) {
        log.debug("memory embeddings: batch recovered; resetting failure count");
      }
      const nextState = resetMemoryBatchFailureState({
        enabled: this.batch.enabled,
        count: this.batchFailureCount,
        lastError: this.batchFailureLastError,
        lastProvider: this.batchFailureLastProvider,
      });
      this.batch.enabled = nextState.enabled;
      this.batchFailureCount = nextState.count;
      this.batchFailureLastError = nextState.lastError;
      this.batchFailureLastProvider = nextState.lastProvider;
    });
  }

  private async recordBatchFailure(params: {
    provider: string;
    message: string;
    attempts: 1 | 2;
    forceDisable?: boolean;
  }): Promise<{ disabled: boolean; count: number }> {
    return await this.withBatchFailureLock(async () => {
      if (!this.batch.enabled) {
        return { disabled: true, count: this.batchFailureCount };
      }
      const nextState = recordMemoryBatchFailure(
        {
          enabled: this.batch.enabled,
          count: this.batchFailureCount,
          lastError: this.batchFailureLastError,
          lastProvider: this.batchFailureLastProvider,
        },
        params,
      );
      this.batch.enabled = nextState.enabled;
      this.batchFailureCount = nextState.count;
      this.batchFailureLastError = nextState.lastError;
      this.batchFailureLastProvider = nextState.lastProvider;
      return { disabled: !nextState.enabled, count: nextState.count };
    });
  }

  private async runBatchWithTimeoutRetry<T>(params: {
    provider: string;
    run: () => Promise<T>;
  }): Promise<MemoryBatchRetryResult<T>> {
    try {
      return { kind: "success", value: await params.run() };
    } catch (error) {
      if (!/timed out|timeout/i.test(formatErrorMessage(error))) {
        return { kind: "failure", error, attempts: 1 };
      }
    }

    log.warn(`memory embeddings: ${params.provider} batch timed out; retrying once`);
    try {
      return { kind: "success", value: await params.run() };
    } catch (error) {
      return { kind: "failure", error, attempts: 2 };
    }
  }

  private async runBatchWithFallback<T>(params: {
    provider: string;
    run: () => Promise<T>;
    fallback: () => Promise<number[][]>;
  }): Promise<T | number[][]> {
    if (!this.batch.enabled) {
      return await params.fallback();
    }
    const result = await this.runBatchWithTimeoutRetry({
      provider: params.provider,
      run: params.run,
    });
    if (result.kind === "success") {
      await this.resetBatchFailureCount();
      return result.value;
    }

    const message = formatErrorMessage(result.error);
    const forceDisable = isEmbeddingBatchUnavailableError(result.error);
    const failure = await this.recordBatchFailure({
      provider: params.provider,
      message,
      attempts: result.attempts,
      forceDisable,
    });
    const suffix = failure.disabled ? "disabling batch" : "keeping batch enabled";
    log.warn(
      `memory embeddings: ${params.provider} batch failed (${failure.count}/${MEMORY_BATCH_FAILURE_LIMIT}); ${suffix}; falling back to non-batch embeddings: ${message}`,
    );
    return await params.fallback();
  }

  protected getIndexConcurrency(): number {
    return resolveMemoryIndexConcurrency({
      batch: this.batch,
      configuredNonBatchConcurrency: this.settings.remote?.nonBatchConcurrency,
      providerId: this.provider?.id,
    });
  }

  private clearIndexedFileData(pathname: string, source: MemorySource): void {
    if (this.vector.enabled) {
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM memory_index_chunks WHERE path = ? AND source = ?)`,
          )
          .run(pathname, source);
      } catch {}
    }
    if (this.fts.enabled && this.fts.available) {
      try {
        deleteMemoryFtsRows({
          db: this.db,
          tableName: FTS_TABLE,
          path: pathname,
          source,
          currentModel: this.provider?.model,
        });
      } catch {}
    }
    this.db
      .prepare(`DELETE FROM memory_index_chunks WHERE path = ? AND source = ?`)
      .run(pathname, source);
  }

  private upsertFileRecord(entry: MemoryIndexEntry, source: MemorySource): void {
    this.db
      .prepare(
        `INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path, source) DO UPDATE SET
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size`,
      )
      .run(entry.path, source, entry.hash, entry.mtimeMs, entry.size);
  }

  private deleteFileRecord(pathname: string, source: MemorySource): void {
    this.db
      .prepare(`DELETE FROM memory_index_sources WHERE path = ? AND source = ?`)
      .run(pathname, source);
  }

  /**
   * Write chunks (and optional embeddings) for a file into the index.
   * Handles both the chunks table, the vector table, and the FTS table.
   * Pass an empty embeddings array to skip vector writes (FTS-only mode).
   */
  private writeChunks(
    entry: MemoryIndexEntry,
    source: MemorySource,
    model: string,
    chunks: MemoryChunk[],
    embeddings: number[][],
    vectorReady: boolean,
  ): void {
    const now = Date.now();
    runSqliteImmediateTransactionSync(this.db, () => {
      this.clearIndexedFileData(entry.path, source);
      for (const [i, chunk] of chunks.entries()) {
        const embedding = embeddings[i] ?? [];
        const id = hashText(
          `${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${model}`,
        );
        this.db
          .prepare(
            `INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               hash=excluded.hash,
               model=excluded.model,
               text=excluded.text,
               embedding=excluded.embedding,
               updated_at=excluded.updated_at`,
          )
          .run(
            id,
            entry.path,
            source,
            chunk.startLine,
            chunk.endLine,
            chunk.hash,
            model,
            chunk.text,
            JSON.stringify(embedding),
            now,
          );
        if (vectorReady && embedding.length > 0) {
          replaceMemoryVectorRow({
            db: this.db,
            tableName: VECTOR_TABLE,
            id,
            embedding,
          });
        }
        if (this.fts.enabled && this.fts.available) {
          this.db
            .prepare(
              `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)\n` +
                ` VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(chunk.text, id, entry.path, source, model, chunk.startLine, chunk.endLine);
        }
      }
      this.upsertFileRecord(entry, source);
    });
    this.vectorDegradedWriteWarningShown = logMemoryVectorDegradedWrite({
      vectorEnabled: this.vector.enabled,
      vectorReady,
      chunkCount: chunks.length,
      warningShown: this.vectorDegradedWriteWarningShown,
      loadError: this.vector.loadError,
      warn: (message) => log.warn(message),
    });
  }

  private async prepareIndexEntry(
    entry: MemoryIndexEntry,
    options: { source: MemorySource; content?: string },
  ): Promise<PreparedMemoryIndexEntry | null> {
    if ("kind" in entry && entry.kind === "multimodal") {
      const multimodalChunk = await buildMultimodalChunkForIndexing(entry);
      if (!multimodalChunk) {
        this.clearIndexedFileData(entry.path, options.source);
        this.deleteFileRecord(entry.path, options.source);
        return null;
      }
      return {
        entry,
        source: options.source,
        chunks: [multimodalChunk.chunk],
        structuredInputBytes: multimodalChunk.structuredInputBytes,
      };
    }

    const content =
      options.content ??
      entry.content ??
      (await retryTransientMemoryRead(
        () => fs.readFile(entry.absPath, "utf-8"),
        `read memory markdown for indexing ${entry.absPath}`,
      ));
    const baseChunks = filterNonEmptyMemoryChunks(chunkMarkdown(content, this.settings.chunking));
    const chunks = this.provider
      ? enforceEmbeddingMaxInputTokens(this.provider, baseChunks, EMBEDDING_BATCH_MAX_TOKENS)
      : baseChunks;
    if (options.source === "sessions" && "lineMap" in entry) {
      remapChunkLines(chunks, entry.lineMap);
    }
    return { entry, source: options.source, chunks };
  }

  protected override async indexFiles(items: MemoryIndexWorkItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const provider = this.provider;
    const batchEmbed = this.providerRuntime?.batchEmbed;
    if (
      !provider ||
      !this.batch.enabled ||
      !batchEmbed ||
      this.providerRuntime?.sourceWideBatchEmbed !== true
    ) {
      await runWithConcurrency(
        items.map((item) => async () => await this.indexFile(item.entry, { source: item.source })),
        this.getIndexConcurrency(),
      );
      return;
    }

    const itemSourceCounts = countBatchSources(items);
    log.debug(
      `memory embeddings: source-wide batch prepare files=${items.length} sources=${formatBatchSourceCounts(
        itemSourceCounts,
      )} maxFiles=${SOURCE_WIDE_BATCH_MAX_FILES} maxRequests=${SOURCE_WIDE_BATCH_MAX_REQUESTS}`,
      {
        files: items.length,
        sources: itemSourceCounts,
        maxFiles: SOURCE_WIDE_BATCH_MAX_FILES,
        maxRequests: SOURCE_WIDE_BATCH_MAX_REQUESTS,
      },
    );

    let prepared: PreparedMemoryIndexEntry[] = [];
    let preparedRequestCount = 0;
    let sourceWideBatchGroup = 0;
    const flushPrepared = async (reason: "max-files" | "max-requests" | "end") => {
      const firstEntry = prepared[0]?.entry;
      if (!firstEntry) {
        return;
      }
      const current = prepared;
      const chunks = current.flatMap((item) => item.chunks);
      const sourceCounts = countBatchSources(current);
      const source = formatBatchSourceLabel(sourceCounts);
      sourceWideBatchGroup += 1;
      const chunkBatches = splitSourceWideEmbeddingChunks(chunks, SOURCE_WIDE_BATCH_MAX_REQUESTS);
      log.debug(
        `memory embeddings: source-wide batch submit group=${sourceWideBatchGroup} source=${source} files=${current.length} chunks=${chunks.length} requests=${chunkBatches.length} sources=${formatBatchSourceCounts(
          sourceCounts,
        )} reason=${reason}`,
        {
          source,
          files: current.length,
          chunks: chunks.length,
          requests: chunkBatches.length,
          sources: sourceCounts,
          group: sourceWideBatchGroup,
          reason,
          maxFiles: SOURCE_WIDE_BATCH_MAX_FILES,
          maxRequests: SOURCE_WIDE_BATCH_MAX_REQUESTS,
        },
      );
      const embeddings: number[][] = [];
      for (let requestIndex = 0; requestIndex < chunkBatches.length; requestIndex += 1) {
        const chunkBatch = chunkBatches[requestIndex] ?? [];
        embeddings.push(
          ...(await this.embedChunksWithBatch(chunkBatch, firstEntry, source, {
            sourceWideFiles: current.length,
            sourceWideSources: sourceCounts,
            sourceWideBatchGroup,
            sourceWideRequestGroup: requestIndex + 1,
            sourceWideRequestGroups: chunkBatches.length,
          })),
        );
      }
      const sample = embeddings.find((embedding) => embedding.length > 0);
      const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
      let offset = 0;
      for (const item of current) {
        const fileEmbeddings = embeddings.slice(offset, offset + item.chunks.length);
        offset += item.chunks.length;
        this.writeChunks(
          item.entry,
          item.source,
          provider.model,
          item.chunks,
          fileEmbeddings,
          vectorReady,
        );
      }
      prepared = [];
      preparedRequestCount = 0;
    };

    for (const item of items) {
      if ("kind" in item.entry && item.entry.kind === "multimodal") {
        await this.indexFile(item.entry, { source: item.source });
        continue;
      }
      const preparedEntry = await this.prepareIndexEntry(item.entry, { source: item.source });
      if (!preparedEntry) {
        continue;
      }
      const nextWouldExceedFiles = prepared.length >= SOURCE_WIDE_BATCH_MAX_FILES;
      const nextWouldExceedRequests =
        preparedRequestCount + preparedEntry.chunks.length > SOURCE_WIDE_BATCH_MAX_REQUESTS;
      if (prepared.length > 0 && (nextWouldExceedFiles || nextWouldExceedRequests)) {
        await flushPrepared(nextWouldExceedFiles ? "max-files" : "max-requests");
      }
      prepared.push(preparedEntry);
      preparedRequestCount += preparedEntry.chunks.length;
      if (
        prepared.length >= SOURCE_WIDE_BATCH_MAX_FILES ||
        preparedRequestCount >= SOURCE_WIDE_BATCH_MAX_REQUESTS
      ) {
        await flushPrepared(
          prepared.length >= SOURCE_WIDE_BATCH_MAX_FILES ? "max-files" : "max-requests",
        );
      }
    }
    await flushPrepared("end");
  }

  protected async indexFile(
    entry: MemoryIndexEntry,
    options: { source: MemorySource; content?: string },
  ) {
    // FTS-only mode: no embedding provider, but we can still build a FTS index
    if (!this.provider) {
      // Multimodal files require an embedding provider; skip in FTS-only mode.
      if ("kind" in entry && entry.kind === "multimodal") {
        return;
      }
      const prepared = await this.prepareIndexEntry(entry, options);
      this.writeChunks(entry, options.source, "fts-only", prepared?.chunks ?? [], [], false);
      return;
    }

    const prepared = await this.prepareIndexEntry(entry, options);
    if (!prepared) {
      return;
    }

    let embeddings: number[][];
    try {
      embeddings = this.batch.enabled
        ? await this.embedChunksWithBatch(prepared.chunks, entry, options.source)
        : await this.embedChunksInBatches(prepared.chunks);
    } catch (err) {
      const message = formatErrorMessage(err);
      if (
        "kind" in entry &&
        entry.kind === "multimodal" &&
        /(413|payload too large|request too large|input too large|too many tokens|input limit|request size)/i.test(
          message,
        )
      ) {
        log.warn("memory embeddings: skipping multimodal file rejected as too large", {
          path: entry.path,
          bytes: prepared.structuredInputBytes,
          provider: this.provider.id,
          model: this.provider.model,
          error: message,
        });
        this.clearIndexedFileData(entry.path, options.source);
        this.upsertFileRecord(entry, options.source);
        return;
      }
      throw err;
    }
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    this.writeChunks(
      entry,
      options.source,
      this.provider.model,
      prepared.chunks,
      embeddings,
      vectorReady,
    );
  }
}
