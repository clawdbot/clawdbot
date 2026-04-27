import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  enforceEmbeddingMaxInputTokens,
  hasNonTextEmbeddingParts,
  type EmbeddingInput,
  type MemoryEmbeddingProviderRuntime,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { type SessionFileEntry } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  hashText,
  remapChunkLines,
  type MemoryChunk,
  type MemoryFileEntry,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
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
import {
  buildMemoryEmbeddingBatches,
  buildTextEmbeddingInputs,
  filterNonEmptyMemoryChunks,
  isRetryableMemoryEmbeddingError,
  resolveMemoryEmbeddingRetryDelay,
  runMemoryEmbeddingRetryLoop,
} from "./manager-embedding-policy.js";
import { deleteMemoryFtsRows } from "./manager-fts-state.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";
import { logMemoryVectorDegradedWrite } from "./manager-vector-warning.js";
import { replaceMemoryVectorRow } from "./manager-vector-write.js";

const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 60_000;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 60_000;

const log = createSubsystemLogger("memory");

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
      return runtimeTimeoutMs;
    }
    return params.providerId === "local"
      ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS
      : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
  }

  const configuredTimeoutSeconds = params.configuredBatchTimeoutSeconds;
  if (typeof configuredTimeoutSeconds === "number" && configuredTimeoutSeconds > 0) {
    return configuredTimeoutSeconds * 1000;
  }
  const runtimeTimeoutMs = params.providerRuntime?.inlineBatchTimeoutMs;
  if (typeof runtimeTimeoutMs === "number" && runtimeTimeoutMs > 0) {
    return runtimeTimeoutMs;
  }
  return params.providerId === "local"
    ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS
    : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
}

export function resolveMemoryIndexConcurrency(params: {
  batch: { enabled: boolean; concurrency: number };
  configuredConcurrency?: number;
}): number {
  return params.configuredConcurrency != null || params.batch.enabled
    ? params.batch.concurrency
    : EMBEDDING_INDEX_CONCURRENCY;
}

export abstract class MemoryManagerEmbeddingOps extends MemoryManagerSyncOps {
  protected abstract batchFailureCount: number;
  protected abstract batchFailureLastError?: string;
  protected abstract batchFailureLastProvider?: string;
  protected abstract batchFailureLock: Promise<void>;

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
    const toCache: Array<{ hash: string; embedding: number[] }> = [];
    const provider = this.provider;
    if (!provider) {
      throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
    }
    let cursor = 0;
    for (const batch of batches) {
      const inputs = buildTextEmbeddingInputs(batch);
      const hasStructuredInputs = inputs.some((input) => hasNonTextEmbeddingParts(input));
      if (hasStructuredInputs && !provider.embedBatchInputs) {
        throw new Error(
          `Embedding provider "${provider.id}" does not support multimodal memory inputs.`,
        );
      }
      const batchEmbeddings = hasStructuredInputs
        ? await this.embedBatchInputsWithRetry(inputs)
        : await this.embedBatchWithRetry(batch.map((chunk) => chunk.text));
      for (let i = 0; i < batch.length; i += 1) {
        const item = missing[cursor + i];
        const embedding = batchEmbeddings[i] ?? [];
        if (item) {
          embeddings[item.index] = embedding;
          toCache.push({ hash: item.chunk.hash, embedding });
        }
      }
      cursor += batch.length;
    }
    upsertMemoryEmbeddingCache({
      db: this.db,
      enabled: this.cache.enabled,
      provider: this.provider,
      providerKey: this.providerKey,
      entries: toCache,
      tableName: EMBEDDING_CACHE_TABLE,
    });
    return embeddings;
  }

  protected computeProviderKey(): string {
    // FTS-only mode: no provider, use a constant key
    if (!this.provider) {
      return hashText(JSON.stringify({ provider: "none", model: "fts-only" }));
    }
    if (this.providerRuntime?.cacheKeyData) {
      return hashText(JSON.stringify(this.providerRuntime.cacheKeyData));
    }
    return hashText(JSON.stringify({ provider: this.provider.id, model: this.provider.model }));
  }

  private buildBatchDebug(source: MemorySource, chunks: MemoryChunk[]) {
    return (message: string, data?: Record<string, unknown>) =>
      log.debug(
        message,
        data ? { ...data, source, chunks: chunks.length } : { source, chunks: chunks.length },
      );
  }

  private async embedChunksWithBatch(
    chunks: MemoryChunk[],
    _entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
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
          debug: this.buildBatchDebug(source, chunks),
        }),
      fallback: async () => await this.embedChunksInBatches(chunks),
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
    upsertMemoryEmbeddingCache({
      db: this.db,
      enabled: this.cache.enabled,
      provider,
      providerKey: this.providerKey,
      entries: toCache,
      tableName: EMBEDDING_CACHE_TABLE,
    });
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
        provider: this.provider,
        providerKey: this.providerKey,
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
    return await runMemoryEmbeddingRetryLoop({
      run: async () => {
        const timeoutMs = this.resolveEmbeddingTimeout("batch");
        log.debug("memory embeddings: batch start", {
          provider: provider.id,
          items: texts.length,
          timeoutMs,
        });
        return await this.withTimeout(
          provider.embedBatch(texts),
          timeoutMs,
          `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      },
      isRetryable: isRetryableMemoryEmbeddingError,
      waitForRetry: async (delayMs) => {
        await this.waitForEmbeddingRetry(delayMs, "retrying");
      },
      maxAttempts: EMBEDDING_RETRY_MAX_ATTEMPTS,
      baseDelayMs: EMBEDDING_RETRY_BASE_DELAY_MS,
    });
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
    return await runMemoryEmbeddingRetryLoop({
      run: async () => {
        const timeoutMs = this.resolveEmbeddingTimeout("batch");
        log.debug("memory embeddings: structured batch start", {
          provider: provider.id,
          items: inputs.length,
          timeoutMs,
        });
        return await this.withTimeout(
          embedBatchInputs(inputs),
          timeoutMs,
          `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      },
      isRetryable: isRetryableMemoryEmbeddingError,
      waitForRetry: async (delayMs) => {
        await this.waitForEmbeddingRetry(delayMs, "retrying structured batch");
      },
      maxAttempts: EMBEDDING_RETRY_MAX_ATTEMPTS,
      baseDelayMs: EMBEDDING_RETRY_BASE_DELAY_MS,
    });
  }

  private async waitForEmbeddingRetry(delayMs: number, action: string): Promise<void> {
    const waitMs = resolveMemoryEmbeddingRetryDelay(
      delayMs,
      Math.random(),
      EMBEDDING_RETRY_MAX_DELAY_MS,
    );
    log.warn(`memory embeddings rate limited; ${action} in ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private resolveEmbeddingTimeout(kind: "query" | "batch"): number {
    return resolveEmbeddingTimeoutMs({
      kind,
      providerId: this.provider?.id,
      providerRuntime: this.providerRuntime,
      configuredBatchTimeoutSeconds: this.settings.sync.embeddingBatchTimeoutSeconds,
    });
  }

  protected async embedQueryWithTimeout(text: string): Promise<number[]> {
    if (!this.provider) {
      throw new Error("Cannot embed query in FTS-only mode (no embedding provider)");
    }
    const timeoutMs = this.resolveEmbeddingTimeout("query");
    log.debug("memory embeddings: query start", { provider: this.provider.id, timeoutMs });
    return await this.withTimeout(
      this.provider.embedQuery(text),
      timeoutMs,
      `memory embeddings query timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  protected async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return await promise;
    }
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
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
    attempts?: number;
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

  private isBatchTimeoutError(message: string): boolean {
    return /timed out|timeout/i.test(message);
  }

  private async runBatchWithTimeoutRetry<T>(params: {
    provider: string;
    run: () => Promise<T>;
  }): Promise<T> {
    try {
      return await params.run();
    } catch (err) {
      const message = formatErrorMessage(err);
      if (this.isBatchTimeoutError(message)) {
        log.warn(`memory embeddings: ${params.provider} batch timed out; retrying once`);
        try {
          return await params.run();
        } catch (retryErr) {
          (retryErr as { batchAttempts?: number }).batchAttempts = 2;
          throw retryErr;
        }
      }
      throw err;
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
    try {
      const result = await this.runBatchWithTimeoutRetry({
        provider: params.provider,
        run: params.run,
      });
      await this.resetBatchFailureCount();
      return result;
    } catch (err) {
      const message = formatErrorMessage(err);
      const attempts = (err as { batchAttempts?: number }).batchAttempts ?? 1;
      const forceDisable = /asyncBatchEmbedContent not available/i.test(message);
      const failure = await this.recordBatchFailure({
        provider: params.provider,
        message,
        attempts,
        forceDisable,
      });
      const suffix = failure.disabled ? "disabling batch" : "keeping batch enabled";
      log.warn(
        `memory embeddings: ${params.provider} batch failed (${failure.count}/${MEMORY_BATCH_FAILURE_LIMIT}); ${suffix}; falling back to non-batch embeddings: ${message}`,
      );
      return await params.fallback();
    }
  }

  protected getIndexConcurrency(): number {
    return resolveMemoryIndexConcurrency({
      batch: this.batch,
      configuredConcurrency: this.settings.remote?.batch?.concurrency,
    });
  }

  private clearIndexedFileData(pathname: string, source: MemorySource): void {
    if (this.vector.enabled) {
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
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
    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(pathname, source);
  }

  private upsertFileRecord(entry: MemoryFileEntry | SessionFileEntry, source: MemorySource): void {
    this.db
      .prepare(
        `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source,
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size`,
      )
      .run(entry.path, source, entry.hash, entry.mtimeMs, entry.size);
  }

  private deleteFileRecord(pathname: string, source: MemorySource): void {
    this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(pathname, source);
  }

  /**
   * Write chunks (and optional embeddings) for a file into the index.
   * Handles both the chunks table, the vector table, and the FTS table.
   * Pass an empty embeddings array to skip vector writes (FTS-only mode).
   */
  private writeChunks(
    entry: MemoryFileEntry | SessionFileEntry,
    source: MemorySource,
    model: string,
    chunks: MemoryChunk[],
    embeddings: number[][],
    vectorReady: boolean,
  ): void {
    const now = Date.now();
    this.clearIndexedFileData(entry.path, source);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      const id = hashText(
        `${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${model}`,
      );
      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
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
    this.vectorDegradedWriteWarningShown = logMemoryVectorDegradedWrite({
      vectorEnabled: this.vector.enabled,
      vectorReady,
      chunkCount: chunks.length,
      warningShown: this.vectorDegradedWriteWarningShown,
      loadError: this.vector.loadError,
      warn: (message) => log.warn(message),
    });
    this.upsertFileRecord(entry, source);
  }

  protected async indexFile(
    entry: MemoryFileEntry | SessionFileEntry,
    options: { source: MemorySource; content?: string },
  ) {
    // FTS-only mode: no embedding provider, but we can still build a FTS index
    if (!this.provider) {
      // Multimodal files require an embedding provider; skip in FTS-only mode.
      if ("kind" in entry && entry.kind === "multimodal") {
        return;
      }
      const content = options.content ?? (await fs.readFile(entry.absPath, "utf-8"));
      const chunks = filterNonEmptyMemoryChunks(chunkMarkdown(content, this.settings.chunking));
      if (options.source === "sessions" && "lineMap" in entry) {
        remapChunkLines(chunks, entry.lineMap);
      }
      this.writeChunks(entry, options.source, "fts-only", chunks, [], false);
      return;
    }

    let chunks: MemoryChunk[];
    let structuredInputBytes: number | undefined;
    if ("kind" in entry && entry.kind === "multimodal") {
      if (!this.provider) {
        log.debug("Skipping multimodal indexing in FTS-only mode", {
          path: entry.path,
          source: options.source,
        });
        this.clearIndexedFileData(entry.path, options.source);
        this.upsertFileRecord(entry, options.source);
        return;
      }
      const multimodalChunk = await buildMultimodalChunkForIndexing(entry);
      if (!multimodalChunk) {
        this.clearIndexedFileData(entry.path, options.source);
        this.deleteFileRecord(entry.path, options.source);
        return;
      }
      structuredInputBytes = multimodalChunk.structuredInputBytes;
      chunks = [multimodalChunk.chunk];
    } else {
      const content = options.content ?? (await fs.readFile(entry.absPath, "utf-8"));
      const baseChunks = filterNonEmptyMemoryChunks(chunkMarkdown(content, this.settings.chunking));
      chunks = this.provider
        ? enforceEmbeddingMaxInputTokens(this.provider, baseChunks, EMBEDDING_BATCH_MAX_TOKENS)
        : baseChunks;
      if (options.source === "sessions" && "lineMap" in entry) {
        remapChunkLines(chunks, entry.lineMap);
      }
    }
    if (!this.provider) {
      this.writeChunks(entry, options.source, "fts-only", chunks, [], false);
      return;
    }

    let embeddings: number[][];
    try {
      embeddings = this.batch.enabled
        ? await this.embedChunksWithBatch(chunks, entry, options.source)
        : await this.embedChunksInBatches(chunks);
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
          bytes: structuredInputBytes,
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
    this.writeChunks(entry, options.source, this.provider.model, chunks, embeddings, vectorReady);
  }
}
