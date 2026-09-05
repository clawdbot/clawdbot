// Memory Core plugin module implements manager embedding ops behavior.
import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { extractCuratedEntryRecallMetadata } from "openclaw/plugin-sdk/memory-core-host-engine-curated";
import {
  enforceEmbeddingMaxInputTokens,
  hasNonTextEmbeddingParts,
  isEmbeddingBatchUnavailableError,
  type EmbeddingInput,
  type MemoryEmbeddingProviderRuntime,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  hashText,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  remapChunkLines,
  retryTransientMemoryRead,
  runWithConcurrency,
  stripMemoryAnnotationCarriers,
  type MemoryChunk,
  type MemoryEntryProvenance,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { MAX_TIMER_TIMEOUT_MS, resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import { chunkItems } from "openclaw/plugin-sdk/text-chunking";
import { hasMemorySessionTombstone } from "../memory-entry-origins.js";
import { withMemoryWorkspaceLock } from "../memory-workspace-lock.js";
import { readSessionResetRecallCutoffMetadata } from "../session-reset-recall-metadata.js";
import type { EmbeddingProvider } from "./embeddings.js";
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
  isSplittableMemoryEmbeddingBatchError,
  resolveMemoryEmbeddingRetryDelay,
  runMemoryEmbeddingBatchRetryWithSplit,
  runMemoryEmbeddingRetryLoop,
} from "./manager-embedding-policy.js";
import { deleteMemoryFtsRows } from "./manager-fts-state.js";
import {
  resolveMemoryIndexProviderIdentities,
  type MemoryIndexProviderIdentity,
} from "./manager-reindex-state.js";
import { chunkSessionContentAtResetBoundary } from "./manager-reset-chunk-boundary.js";
import {
  MemoryManagerSyncOps,
  type MemoryIndexWorkItem,
  type MemorySemanticProviderGeneration,
  type MemorySyncProviderGeneration,
} from "./manager-sync-ops.js";
import { logMemoryVectorDegradedWrite } from "./manager-vector-warning.js";
import { replaceMemoryVectorRow } from "./manager-vector-write.js";
import { resolveMemoryPathClassification } from "./memory-path-provenance.js";

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

type IndexedMemoryChunk = MemoryChunk & {
  importance: number | null;
  triggers: string | null;
  projectKey: string | null;
};

type PreparedMemoryIndexEntry = {
  entry: MemoryIndexEntry;
  source: MemorySource;
  chunks: IndexedMemoryChunk[];
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

function splitSourceWideEmbeddingChunks<T>(chunks: T[], maxRequests: number): T[][] {
  return chunkItems(chunks, Math.max(1, Math.floor(maxRequests)));
}

function resolveEmbeddingTimeoutMs(params: {
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

function resolveMemoryIndexConcurrency(params: {
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

async function runEmbeddingOperationWithTimeout<T>(params: {
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
  const timeoutError = new Error(params.message);
  const deadlineStartedAt = Date.now();
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError);
      controller.abort(timeoutError);
    }, timeoutMs);
  });
  try {
    const operation = params.run(signal);
    const result = (await Promise.race([operation, timeoutPromise])) as T;
    params.signal?.throwIfAborted();
    // An overdue watchdog can run after provider success following an event-loop stall.
    if (Date.now() - deadlineStartedAt >= timeoutMs) {
      controller.abort(timeoutError);
      throw timeoutError;
    }
    return result;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export abstract class MemoryManagerEmbeddingOps extends MemoryManagerSyncOps {
  protected readonly batchFailureLimit = 2;
  protected batchFailure: { count: number; lastError?: string; lastProvider?: string } = {
    count: 0,
  };
  protected abstract markLocalEmbeddingProviderDegraded(err: unknown): void;
  private activeProviderUses = new Map<EmbeddingProvider, number>();
  private providerIdleWaiters = new Map<EmbeddingProvider, Set<() => void>>();
  private syncProviderGenerationRelease: (() => void) | null = null;
  private syncProviderGenerationOwners = 0;

  protected acquireProviderUse(provider: EmbeddingProvider): () => void {
    this.activeProviderUses.set(provider, (this.activeProviderUses.get(provider) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remaining = (this.activeProviderUses.get(provider) ?? 1) - 1;
      if (remaining > 0) {
        this.activeProviderUses.set(provider, remaining);
        return;
      }
      this.activeProviderUses.delete(provider);
      const waiters = this.providerIdleWaiters.get(provider);
      this.providerIdleWaiters.delete(provider);
      for (const resolve of waiters ?? []) {
        resolve();
      }
    };
  }

  protected async withProviderUse<T>(
    provider: EmbeddingProvider,
    run: () => Promise<T>,
  ): Promise<T> {
    const release = this.acquireProviderUse(provider);
    try {
      return await run();
    } finally {
      release();
    }
  }

  protected async awaitProviderIdle(provider: EmbeddingProvider): Promise<void> {
    if (!this.activeProviderUses.has(provider)) {
      return;
    }
    await new Promise<void>((resolve) => {
      const waiters = this.providerIdleWaiters.get(provider) ?? new Set();
      waiters.add(resolve);
      this.providerIdleWaiters.set(provider, waiters);
    });
  }

  protected override beginSyncProviderGeneration(options?: { forceFtsOnly?: boolean }): void {
    if (this.syncProviderGeneration) {
      this.syncProviderGenerationOwners += 1;
      return;
    }
    const provider = options?.forceFtsOnly ? null : this.provider;
    const runtime = provider ? this.providerRuntime : undefined;
    const identities = resolveMemoryIndexProviderIdentities({
      provider,
      cacheKeyData: runtime?.cacheKeyData,
      aliases: runtime?.indexIdentityAliases,
    });
    const providerKey = expectDefined(
      identities.at(0),
      "primary memory provider identity",
    ).providerKey;
    this.syncProviderGeneration = provider
      ? {
          kind: "semantic",
          database: this.db,
          provider,
          ...(runtime ? { runtime } : {}),
          providerKey,
          identities,
        }
      : { kind: "fts-only", database: this.db, provider: null, providerKey, identities };
    this.syncProviderGenerationRelease = provider ? this.acquireProviderUse(provider) : null;
    this.syncProviderGenerationOwners = 1;
  }

  protected override endSyncProviderGeneration(): void {
    if (this.syncProviderGenerationOwners > 1) {
      this.syncProviderGenerationOwners -= 1;
      return;
    }
    this.syncProviderGenerationOwners = 0;
    this.syncProviderGeneration = null;
    this.syncProviderGenerationRelease?.();
    this.syncProviderGenerationRelease = null;
  }

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

  private async embedChunksInBatches(
    chunks: IndexedMemoryChunk[],
    generation: MemorySemanticProviderGeneration,
  ): Promise<number[][]> {
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks, generation);

    if (missing.length === 0) {
      return embeddings;
    }

    const missingChunks = missing.map((m) => m.chunk);
    const batches = buildMemoryEmbeddingBatches(missingChunks, EMBEDDING_BATCH_MAX_TOKENS);
    let cursor = 0;
    for (const batch of batches) {
      const inputs = buildTextEmbeddingInputs(batch);
      const hasStructuredInputs = inputs.some((input) => hasNonTextEmbeddingParts(input));
      const batchEmbeddings = await this.embedBatchWithRetry(
        hasStructuredInputs ? inputs : batch.map((chunk) => chunk.text),
        generation,
      );
      for (let i = 0; i < batch.length; i += 1) {
        const item = missing[cursor + i];
        const embedding = batchEmbeddings[i] ?? [];
        if (item) {
          embeddings[item.index] = embedding;
        }
      }
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
    chunks: IndexedMemoryChunk[],
    source: string,
    generation: MemorySemanticProviderGeneration,
    debugContext: Record<string, unknown> = {},
  ): Promise<number[][]> {
    const provider = generation.provider;
    const batchEmbed = generation.runtime?.batchEmbed;
    if (!batchEmbed) {
      return this.embedChunksInBatches(chunks, generation);
    }
    if (chunks.length === 0) {
      return [];
    }
    const { embeddings, missing } = this.collectCachedEmbeddings(chunks, generation);
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
      fallback: async () => await this.embedChunksInBatches(missingChunks, generation),
    });
    if (!batchResult) {
      return this.embedChunksInBatches(chunks, generation);
    }
    for (let index = 0; index < missing.length; index += 1) {
      const item = missing[index];
      const embedding = batchResult[index] ?? [];
      if (!item) {
        continue;
      }
      embeddings[item.index] = embedding;
    }
    return embeddings;
  }

  private collectCachedEmbeddings(
    chunks: IndexedMemoryChunk[],
    generation: MemorySemanticProviderGeneration,
  ): {
    embeddings: number[][];
    missing: Array<{ index: number; chunk: IndexedMemoryChunk }>;
  } {
    return collectMemoryCachedEmbeddings({
      chunks,
      cached: loadMemoryEmbeddingCache({
        db: this.db,
        enabled: this.cache.enabled,
        providerIdentities: generation.identities,
        hashes: chunks.map((chunk) => chunk.hash),
      }),
    });
  }

  protected async embedBatchWithRetry(
    inputs: Array<string | EmbeddingInput>,
    generation?: MemorySemanticProviderGeneration,
  ): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    const provider = generation?.provider ?? this.provider;
    if (!provider) {
      throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
    }
    const structured = inputs.some((input) => typeof input !== "string");
    const label = structured ? "structured batch" : "batch";
    try {
      return await this.withProviderUse(
        provider,
        async () =>
          await runMemoryEmbeddingBatchRetryWithSplit({
            items: inputs,
            run: async (batchItems) => {
              const timeoutMs = this.resolveEmbeddingTimeout(
                "batch",
                provider,
                generation?.runtime,
              );
              log.debug(`memory embeddings: ${label} start`, {
                provider: provider.id,
                items: batchItems.length,
                timeoutMs,
              });
              const result = await runEmbeddingOperationWithTimeout({
                timeoutMs,
                message: `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
                run: async (signal) =>
                  await provider.embedBatch(batchItems, { signal, inputType: "document" }),
              });
              if (!structured) {
                log.debug("memory embeddings: batch completed", {
                  provider: provider.id,
                  items: batchItems.length,
                });
              }
              return result;
            },
            isRetryable: isRetryableMemoryEmbeddingError,
            isSplittable: isSplittableMemoryEmbeddingBatchError,
            waitForRetry: async (delayMs) => {
              await this.waitForEmbeddingRetry(
                delayMs,
                structured ? "retrying structured batch" : "retrying",
              );
            },
            maxAttempts: EMBEDDING_RETRY_MAX_ATTEMPTS,
            baseDelayMs: EMBEDDING_RETRY_BASE_DELAY_MS,
            onSplit: ({ itemCount, splitAt }) => {
              log.warn(
                `memory embeddings ${label} failed; splitting ${itemCount} inputs into ${splitAt} + ${itemCount - splitAt}`,
              );
            },
          }),
      );
    } catch (err) {
      if (!structured) {
        log.debug("memory embeddings: batch failed", {
          provider: provider.id,
          error: formatErrorMessage(err),
        });
      }
      this.markLocalEmbeddingProviderDegraded(err);
      throw createMemoryEmbeddingOperationError({
        operation: structured ? "structured-batch" : "batch",
        providerId: provider.id,
        cause: err,
      });
    }
  }

  private async waitForEmbeddingRetry(
    delayMs: number,
    action: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const waitMs = resolveMemoryEmbeddingRetryDelay(
      delayMs,
      Math.random(),
      EMBEDDING_RETRY_MAX_DELAY_MS,
    );
    log.warn(`memory embeddings retryable error; ${action} in ${waitMs}ms`);
    await sleepWithAbort(waitMs, signal);
  }

  private resolveEmbeddingTimeout(
    kind: "query" | "batch",
    provider: EmbeddingProvider | null = this.provider,
    providerRuntime: MemoryEmbeddingProviderRuntime | undefined = this.providerRuntime,
  ): number {
    return resolveEmbeddingTimeoutMs({
      kind,
      providerId: provider?.id,
      providerRuntime,
      configuredBatchTimeoutSeconds: this.settings.sync.embeddingBatchTimeoutSeconds,
    });
  }

  protected async embedQueryWithRetry(
    text: string,
    signal?: AbortSignal,
    providerOverride?: EmbeddingProvider,
    markDegraded = true,
    providerRuntimeOverride?: MemoryEmbeddingProviderRuntime,
  ): Promise<number[]> {
    const provider = providerOverride ?? this.provider;
    const providerRuntime = providerOverride ? providerRuntimeOverride : this.providerRuntime;
    if (!provider) {
      throw new Error("Cannot embed query in FTS-only mode (no embedding provider)");
    }
    try {
      return await this.withProviderUse(
        provider,
        async () =>
          await runMemoryEmbeddingRetryLoop({
            run: async () => {
              signal?.throwIfAborted();
              const timeoutMs = this.resolveEmbeddingTimeout("query", provider, providerRuntime);
              log.debug("memory embeddings: query start", { provider: provider.id, timeoutMs });
              return await runEmbeddingOperationWithTimeout({
                timeoutMs,
                message: `memory embeddings query timed out after ${Math.round(timeoutMs / 1000)}s`,
                signal,
                run: async (opSignal) =>
                  await provider.embed(text, { signal: opSignal, inputType: "query" }),
              });
            },
            signal,
            isRetryable: isRetryableMemoryEmbeddingError,
            waitForRetry: async (delayMs) => {
              await this.waitForEmbeddingRetry(delayMs, "retrying query", signal);
            },
            maxAttempts: EMBEDDING_RETRY_MAX_ATTEMPTS,
            baseDelayMs: EMBEDDING_RETRY_BASE_DELAY_MS,
          }),
      );
    } catch (err) {
      if (markDegraded) {
        this.markLocalEmbeddingProviderDegraded(err);
      }
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
    return await runEmbeddingOperationWithTimeout({ timeoutMs, message, run: () => promise });
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
    // Completion accounting is synchronous: concurrent batches cannot interleave updates.
    if (result.kind === "success") {
      if (this.batchFailure.count > 0) {
        log.debug("memory embeddings: batch recovered; resetting failure count");
      }
      // An in-flight success clears failures without re-enabling disabled batching.
      this.batchFailure = { count: 0 };
      return result.value;
    }

    const message = formatErrorMessage(result.error);
    const forceDisable = isEmbeddingBatchUnavailableError(result.error);
    if (this.batch.enabled) {
      const count =
        this.batchFailure.count + (forceDisable ? this.batchFailureLimit : result.attempts);
      this.batchFailure = { count, lastError: message, lastProvider: params.provider };
      this.batch.enabled = !(forceDisable || count >= this.batchFailureLimit);
    }
    const suffix = this.batch.enabled ? "keeping batch enabled" : "disabling batch";
    log.warn(
      `memory embeddings: ${params.provider} batch failed (${this.batchFailure.count}/${this.batchFailureLimit}); ${suffix}; falling back to non-batch embeddings: ${message}`,
    );
    return await params.fallback();
  }

  protected getIndexConcurrency(): number {
    return resolveMemoryIndexConcurrency({
      batch: this.batch,
      configuredNonBatchConcurrency: this.settings.remote?.nonBatchConcurrency,
      providerId: this.syncProviderGeneration
        ? this.syncProviderGeneration.provider?.id
        : this.provider?.id,
    });
  }

  private clearIndexedFileData(pathname: string, source: MemorySource): void {
    this.deleteVectorRowsForSource(pathname, source);
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

  private assertMemoryFileSnapshot(entry: MemoryIndexEntry, currentHash: string | undefined): void {
    if (currentHash === entry.hash) {
      return;
    }
    this.markFailedFullReindexRetry({ memory: true, sessions: false });
    throw new Error(`Memory source ${entry.path} changed while indexing; retry the memory index.`);
  }

  private async writeChunks(
    { entry, source, chunks }: PreparedMemoryIndexEntry,
    generation: MemorySyncProviderGeneration | null,
    embeddings: number[][],
    vectorReady: boolean,
  ): Promise<void> {
    await withMemoryWorkspaceLock(this.workspaceDir, async () => {
      if (source === "memory") {
        // The lock excludes purge and promotion writers while the exact file
        // snapshot is validated and its derived index records are committed.
        const current = await buildFileEntry(
          entry.absPath,
          this.workspaceDir,
          this.settings.multimodal,
        );
        this.assertMemoryFileSnapshot(entry, current?.hash);
      }
      const now = Date.now();
      const model = generation?.provider?.model ?? "fts-only";
      const needsVectorRebuild =
        !vectorReady && embeddings.some((embedding) => embedding.length > 0);
      runSqliteImmediateTransactionSync(this.db, () => {
        if (source === "sessions") {
          const sessionId = expectDefined(entry.sessionId, "memory index session identity");
          // Embedding and vector setup may await while a purge completes. Read the
          // live owner, never the shadow index, immediately before publishing.
          if (hasMemorySessionTombstone(generation?.database ?? this.db, this.agentId, sessionId)) {
            this.markFailedFullReindexRetry({ memory: false, sessions: true });
            throw new Error(
              "A session was forgotten while memory indexing was running; retry the memory index.",
            );
          }
        }
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
          this.db
            .prepare(
              `INSERT INTO ${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE} (
                 chunk_id, importance, triggers, project_key
               ) VALUES (?, ?, ?, ?)
               ON CONFLICT(chunk_id) DO UPDATE SET
                 importance=excluded.importance,
                 triggers=excluded.triggers,
                 project_key=excluded.project_key`,
            )
            .run(id, chunk.importance, chunk.triggers, chunk.projectKey);
          const provenance = chunk.provenance ?? {
            originClass: "untrusted" as const,
            sessionKind: "unknown" as const,
            observedAt: now,
          };
          this.db
            .prepare(
              `INSERT INTO ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} (
                 chunk_id, origin_class, session_kind, observed_at, supersedes_key
               ) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(chunk_id) DO UPDATE SET
                 origin_class=excluded.origin_class,
                 session_kind=excluded.session_kind,
                 observed_at=excluded.observed_at,
                 supersedes_key=excluded.supersedes_key`,
            )
            .run(
              id,
              provenance.originClass,
              provenance.sessionKind,
              provenance.observedAt,
              provenance.supersedesKey ?? null,
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
        upsertMemoryEmbeddingCache({
          db: this.db,
          enabled: this.cache.enabled,
          provider: generation?.provider ?? null,
          providerKey: generation?.providerKey ?? null,
          entries: chunks.map((chunk, index) => ({
            hash: chunk.hash,
            embedding: embeddings[index] ?? [],
          })),
          now,
        });
        this.upsertFileRecord(entry, source);
        if (needsVectorRebuild) {
          this.markVectorRebuildRequired();
        }
      });
      this.database.vectorDegradedWriteWarningShown = logMemoryVectorDegradedWrite({
        vectorEnabled: this.vector.enabled,
        vectorReady,
        chunkCount: chunks.length,
        warningShown: this.database.vectorDegradedWriteWarningShown,
        loadError: this.vector.loadError,
        warn: (message) => log.warn(message),
      });
    });
  }

  private async prepareIndexEntry(
    entry: MemoryIndexEntry,
    options: { source: MemorySource; content?: string },
    generation: MemorySyncProviderGeneration | null,
  ): Promise<PreparedMemoryIndexEntry | null> {
    return await withMemoryWorkspaceLock(this.workspaceDir, async () => {
      const pathClassification = await resolveMemoryPathClassification({
        absolutePath: entry.absPath,
        source: options.source,
        workspaceDir: this.workspaceDir,
      });
      if ("kind" in entry && entry.kind === "multimodal") {
        const multimodalChunk = await buildMultimodalChunkForIndexing(entry);
        if (!multimodalChunk) {
          this.clearIndexedFileData(entry.path, options.source);
          this.deleteFileRecord(entry.path, options.source);
          return null;
        }
        const chunk: IndexedMemoryChunk = {
          ...multimodalChunk.chunk,
          importance: null,
          triggers: null,
          projectKey: null,
        };
        chunk.provenance = this.resolveChunkProvenance(
          entry,
          options.source,
          chunk,
          pathClassification.originClass,
        );
        return {
          entry,
          source: options.source,
          chunks: [chunk],
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
      if (options.source === "memory") {
        this.assertMemoryFileSnapshot(entry, hashText(content));
      }
      const normalizedEntryPath = entry.path.replaceAll("\\", "/");
      const perEntry =
        options.source === "memory" &&
        (normalizedEntryPath === "MEMORY.md" || normalizedEntryPath === "USER.md");
      const indexingContent =
        options.source === "memory" ? stripMemoryAnnotationCarriers(content) : content;
      // All chunks share one source snapshot; splitting per chunk makes indexing quadratic.
      const sourceLines =
        options.source === "memory" ? content.replace(/\r\n/gu, "\n").split("\n") : [];
      const chunkOptions = { ...this.settings.chunking, perEntry };
      const baseChunks = filterNonEmptyMemoryChunks(
        options.source === "sessions"
          ? chunkSessionContentAtResetBoundary({
              content: indexingContent,
              cutoffLine: (() => {
                const cutoff = readSessionResetRecallCutoffMetadata(entry);
                return cutoff.state === "valid" ? cutoff.cutoffLine : undefined;
              })(),
              lineMap: entry.lineMap,
              chunking: chunkOptions,
            })
          : chunkMarkdown(indexingContent, chunkOptions),
      );
      for (const chunk of baseChunks) {
        chunk.provenance = this.resolveChunkProvenance(
          entry,
          options.source,
          chunk,
          pathClassification.originClass,
        );
      }
      // Fragments inherit one entry's metadata; parse each source span once,
      // not once per fragment of a long line or oversized entry.
      const recallMetadata = new Map<
        string,
        ReturnType<typeof extractCuratedEntryRecallMetadata>
      >();
      const chunks = (
        generation?.kind === "semantic"
          ? enforceEmbeddingMaxInputTokens(
              generation.provider,
              baseChunks,
              EMBEDDING_BATCH_MAX_TOKENS,
            )
          : baseChunks
      ).map((chunk): IndexedMemoryChunk => {
        const start = chunk.entryStartLine ?? chunk.startLine;
        const end = chunk.entryEndLine ?? chunk.endLine;
        const span = `${start}:${end}`;
        let metadata = recallMetadata.get(span);
        if (!metadata) {
          metadata = extractCuratedEntryRecallMetadata({
            curatedRoot: pathClassification.curatedRoot,
            projectScopeEligible:
              options.source === "memory" && normalizedEntryPath.toUpperCase() !== "USER.MD",
            sourceLines: sourceLines.slice(start - 1, end),
          });
          recallMetadata.set(span, metadata);
        }
        return Object.assign(chunk, metadata);
      });
      if (options.source === "sessions" && "lineMap" in entry) {
        remapChunkLines(chunks, entry.lineMap);
      }
      return { entry, source: options.source, chunks };
    });
  }

  private resolveChunkProvenance(
    entry: MemoryIndexEntry,
    source: MemorySource,
    chunk: MemoryChunk,
    pathOriginClass: MemoryEntryProvenance["originClass"],
  ): MemoryEntryProvenance {
    const lineProvenance = entry.lineProvenance?.slice(chunk.startLine - 1, chunk.endLine) ?? [];
    if (source === "sessions" && lineProvenance.length > 0) {
      const originPriority = ["owner", "agent", "system", "untrusted"] as const;
      const originClass = originPriority.findLast((origin) =>
        lineProvenance.some((item) => item.originClass === origin),
      );
      const sessionKinds = new Set(lineProvenance.map((item) => item.sessionKind));
      const supersedesKeys = new Set(
        lineProvenance.flatMap((item) => (item.supersedesKey ? [item.supersedesKey] : [])),
      );
      return {
        originClass: originClass ?? "untrusted",
        sessionKind:
          sessionKinds.size === 1 ? (lineProvenance[0]?.sessionKind ?? "unknown") : "unknown",
        observedAt: Math.max(...lineProvenance.map((item) => item.observedAt)),
        ...(supersedesKeys.size === 1 ? { supersedesKey: [...supersedesKeys][0] } : {}),
      };
    }

    // Workspace memory files are inside the operator trust boundary: any
    // filesystem writer already owns the host. Defaulting them untrusted would
    // silently make handwritten persona memory ineligible for dreaming.
    return {
      originClass: pathOriginClass,
      sessionKind: "unknown",
      observedAt: Math.max(0, Math.floor(entry.mtimeMs)),
    };
  }

  protected override async indexFiles(items: MemoryIndexWorkItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    this.beginSyncProviderGeneration();
    try {
      await this.indexFilesWithGeneration(items, this.syncProviderGeneration);
    } finally {
      this.endSyncProviderGeneration();
    }
  }

  private async indexFilesWithGeneration(
    items: MemoryIndexWorkItem[],
    generation: MemorySyncProviderGeneration | null,
  ): Promise<void> {
    const batchEmbed = generation?.kind === "semantic" ? generation.runtime?.batchEmbed : undefined;
    if (
      generation?.kind !== "semantic" ||
      !this.batch.enabled ||
      !batchEmbed ||
      generation.runtime?.sourceWideBatchEmbed !== true
    ) {
      await runWithConcurrency(
        items.map(
          (item) => async () =>
            await this.indexFileWithGeneration(item.entry, { source: item.source }, generation),
        ),
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
      if (prepared.length === 0) {
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
          ...(await this.embedChunksWithBatch(chunkBatch, source, generation, {
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
        await this.writeChunks(item, generation, fileEmbeddings, vectorReady);
      }
      prepared = [];
      preparedRequestCount = 0;
    };

    for (const item of items) {
      if ("kind" in item.entry && item.entry.kind === "multimodal") {
        await this.indexFileWithGeneration(item.entry, { source: item.source }, generation);
        continue;
      }
      const preparedEntry = await this.prepareIndexEntry(
        item.entry,
        { source: item.source },
        generation,
      );
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
  ): Promise<void> {
    this.beginSyncProviderGeneration();
    try {
      await this.indexFileWithGeneration(entry, options, this.syncProviderGeneration);
    } finally {
      this.endSyncProviderGeneration();
    }
  }

  private async indexFileWithGeneration(
    entry: MemoryIndexEntry,
    options: { source: MemorySource; content?: string },
    generation: MemorySyncProviderGeneration | null,
  ): Promise<void> {
    // Multimodal files require an embedding provider; skip in FTS-only mode.
    if (generation?.kind !== "semantic" && "kind" in entry && entry.kind === "multimodal") {
      return;
    }
    const prepared = await this.prepareIndexEntry(entry, options, generation);
    if (!prepared) {
      return;
    }
    if (generation?.kind !== "semantic") {
      await this.writeChunks(prepared, generation, [], false);
      return;
    }

    let embeddings: number[][];
    try {
      embeddings = this.batch.enabled
        ? await this.embedChunksWithBatch(prepared.chunks, options.source, generation)
        : await this.embedChunksInBatches(prepared.chunks, generation);
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
          provider: generation.provider.id,
          model: generation.provider.model,
          error: message,
        });
        await this.writeChunks({ ...prepared, chunks: [] }, generation, [], false);
        return;
      }
      throw err;
    }
    const sample = embeddings.find((embedding) => embedding.length > 0);
    const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
    await this.writeChunks(prepared, generation, embeddings, vectorReady);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
