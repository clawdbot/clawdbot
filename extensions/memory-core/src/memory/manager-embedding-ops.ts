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
  extractProjectKeysFromCuratedEntry,
  hashText,
  INVALID_PROJECT_ANNOTATION_KEY,
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
import { readSessionResetRecallCutoffMetadata } from "../session-reset-recall-metadata.js";
import type { EmbeddingProvider } from "./embeddings.js";
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
  computeNextMemoryEmbeddingCooldown,
  isMemoryEmbeddingCoolingDown,
  type MemoryEmbeddingCooldownState,
} from "./manager-embedding-cooldown.js";
import { createMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import {
  buildMemoryEmbeddingBatches,
  buildTextEmbeddingInputs,
  filterNonEmptyMemoryChunks,
  isBillingExhaustedMemoryEmbeddingError,
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

function resolveChunkRecallMetadata(params: {
  curatedRoot: boolean;
  projectScopeEligible: boolean;
  content?: string;
  chunk: MemoryChunk;
}): Pick<IndexedMemoryChunk, "importance" | "triggers" | "projectKey"> {
  if ((!params.curatedRoot && !params.projectScopeEligible) || params.content === undefined) {
    return { importance: null, triggers: null, projectKey: null };
  }

  const phrases = new Set<string>();
  let importance: number | null = null;
  const lines = params.content.replace(/\r\n/gu, "\n").split("\n");
  const annotationStartLine = params.chunk.entryStartLine ?? params.chunk.startLine;
  const annotationEndLine = params.chunk.entryEndLine ?? params.chunk.endLine;
  const annotationLines = lines.slice(annotationStartLine - 1, annotationEndLine);
  const projectAnnotations = params.projectScopeEligible
    ? extractProjectKeysFromCuratedEntry(annotationLines.join("\n"))
    : { annotated: false, valid: true, keys: [] };
  for (const line of annotationLines) {
    const annotationSuffix = line.match(
      /(?:\s*<!--\s*(?:trigger|importance|project)\s*:[\s\S]*?-->\s*)+$/iu,
    )?.[0];
    if (!annotationSuffix) {
      continue;
    }
    for (const match of annotationSuffix.matchAll(
      /<!--\s*(trigger|importance|project)\s*:\s*([\s\S]*?)\s*-->/giu,
    )) {
      const kind = match[1]?.toLowerCase();
      const value = match[2]?.trim() ?? "";
      if (kind === "trigger") {
        if (!params.curatedRoot) {
          continue;
        }
        for (const phrase of value.split(/[,;]/u).map((entry) => entry.trim())) {
          if (phrase) {
            phrases.add(phrase);
          }
        }
        continue;
      }
      if (kind === "project") {
        continue;
      }
      if (!params.curatedRoot) {
        continue;
      }
      if (/^\d+$/u.test(value)) {
        const parsed = Number.parseInt(value, 10);
        if (parsed >= 1 && parsed <= 10) {
          importance = Math.max(importance ?? parsed, parsed);
        }
      }
    }
  }

  // Missing annotations intentionally stay NULL: pre-annotation indexes keep
  // neutral ranking and never become trigger candidates after a reindex.
  return {
    importance,
    triggers: phrases.size > 0 ? [...phrases].join("; ") : null,
    // Invalid annotations remain scoped but unsatisfiable; treating them as NULL
    // would make malformed project memory global and leak it into every project.
    projectKey:
      projectAnnotations.annotated && !projectAnnotations.valid
        ? INVALID_PROJECT_ANNOTATION_KEY
        : projectAnnotations.keys.length > 0
          ? projectAnnotations.keys.join("; ")
          : null,
  };
}

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
  const limit = Math.max(1, Math.floor(maxRequests));
  const batches: T[][] = [];
  for (let start = 0; start < chunks.length; start += limit) {
    batches.push(chunks.slice(start, start + limit));
  }
  return batches;
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
  private activeProviderUses = new Map<EmbeddingProvider, number>();
  private providerIdleWaiters = new Map<EmbeddingProvider, Set<() => void>>();
  private syncProviderGenerationRelease: (() => void) | null = null;
  private syncProviderGenerationOwners = 0;
  private embeddingBillingCooldown?: MemoryEmbeddingCooldownState;

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
          provider,
          ...(runtime ? { runtime } : {}),
          providerKey,
          identities,
        }
      : { kind: "fts-only", provider: null, providerKey, identities };
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

  private upsertEmbeddingCacheEntries(
    entries: Array<{ hash: string; embedding: number[] }>,
    generation: MemorySemanticProviderGeneration,
  ): void {
    upsertMemoryEmbeddingCache({
      db: this.db,
      enabled: this.cache.enabled,
      provider: generation.provider,
      providerKey: generation.providerKey,
      entries,
      tableName: EMBEDDING_CACHE_TABLE,
    });
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
    const provider = generation.provider;
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
        ? await this.embedBatchInputsWithRetry(inputs, generation)
        : await this.embedBatchWithRetry(
            batch.map((chunk) => chunk.text),
            generation,
          );
      const batchCacheEntries: Array<{ hash: string; embedding: number[] }> = [];
      for (let i = 0; i < batch.length; i += 1) {
        const item = missing[cursor + i];
        const embedding = batchEmbeddings[i] ?? [];
        if (item) {
          embeddings[item.index] = embedding;
          batchCacheEntries.push({ hash: item.chunk.hash, embedding });
        }
      }
      this.upsertEmbeddingCacheEntries(batchCacheEntries, generation);
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
    _entry: MemoryIndexEntry,
    source: string,
    generation: MemorySemanticProviderGeneration,
    debugContext: Record<string, unknown> = {},
  ): Promise<number[][]> {
    const provider = generation.provider;
    const batchEmbed = generation.runtime?.batchEmbed;
    // A cooling-down provider must never see the runtime batch API's network call, not just
    // the standard-embedding fallback: embedChunksInBatches funnels into the same guarded
    // runProviderBatchWithRetry check and throws the canonical skip error without a request.
    if (
      !batchEmbed ||
      isMemoryEmbeddingCoolingDown(this.embeddingBillingCooldown, provider.id, Date.now())
    ) {
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
    this.upsertEmbeddingCacheEntries(toCache, generation);
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
        tableName: EMBEDDING_CACHE_TABLE,
      }),
    });
  }

  protected async embedBatchWithRetry(
    texts: string[],
    generation?: MemorySemanticProviderGeneration,
  ): Promise<number[][]> {
    return await this.runProviderBatchWithRetry({
      items: texts,
      generation,
      operation: "batch",
      run: async (provider, batchTexts, signal) =>
        await provider.embedBatch(batchTexts, { signal }),
    });
  }

  protected async embedBatchInputsWithRetry(
    inputs: EmbeddingInput[],
    generation?: MemorySemanticProviderGeneration,
  ): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    const provider = generation?.provider ?? this.provider;
    const embedBatchInputs = provider?.embedBatchInputs;
    if (!embedBatchInputs) {
      return await this.embedBatchWithRetry(
        inputs.map((input) => input.text),
        generation,
      );
    }
    return await this.runProviderBatchWithRetry({
      items: inputs,
      generation,
      operation: "structured-batch",
      run: async (_provider, batchInputs, signal) =>
        await embedBatchInputs(batchInputs, { signal }),
    });
  }

  private async runProviderBatchWithRetry<T>(params: {
    items: T[];
    generation?: MemorySemanticProviderGeneration;
    operation: "batch" | "structured-batch";
    run: (provider: EmbeddingProvider, items: T[], signal: AbortSignal) => Promise<number[][]>;
  }): Promise<number[][]> {
    if (params.items.length === 0) {
      return [];
    }
    const provider = params.generation?.provider ?? this.provider;
    if (!provider) {
      throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
    }
    const structured = params.operation === "structured-batch";
    const label = structured ? "structured batch" : "batch";
    if (isMemoryEmbeddingCoolingDown(this.embeddingBillingCooldown, provider.id, Date.now())) {
      // A prior attempt already classified this as billing-exhausted (won't clear until a
      // future cycle); skip the network call entirely instead of re-hitting a known-dead
      // provider on every debounced sync cycle. Log at debug (not warn) since this is a
      // known, already-reported state, not a new failure.
      const reason = this.embeddingBillingCooldown!.reason;
      log.debug("memory embeddings: skipping batch, provider in billing cooldown", {
        provider: provider.id,
        reason,
        untilMs: this.embeddingBillingCooldown!.untilMs,
      });
      throw createMemoryEmbeddingOperationError({
        operation: params.operation,
        providerId: provider.id,
        cause: new Error(reason),
        skippedDueToCooldown: true,
      });
    }
    try {
      const batchResult = await this.withProviderUse(
        provider,
        async () =>
          await runMemoryEmbeddingBatchRetryWithSplit({
            items: params.items,
            run: async (batchItems) => {
              const timeoutMs = this.resolveEmbeddingTimeout(
                "batch",
                provider,
                params.generation?.runtime,
              );
              log.debug(`memory embeddings: ${label} start`, {
                provider: provider.id,
                items: batchItems.length,
                timeoutMs,
              });
              const result = await runEmbeddingOperationWithTimeout({
                timeoutMs,
                message: `memory embeddings batch timed out after ${Math.round(timeoutMs / 1000)}s`,
                run: async (signal) => await params.run(provider, batchItems, signal),
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
            isSplittable: isSplittableMemoryEmbeddingTransportError,
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
                `memory embeddings transport failed after retries; splitting ${label} of ${itemCount} into ${splitAt} + ${itemCount - splitAt}`,
              );
            },
          }),
      );
      if (this.embeddingBillingCooldown?.providerId === provider.id) {
        log.warn("memory embeddings: provider recovered, clearing billing cooldown", {
          provider: provider.id,
        });
        this.embeddingBillingCooldown = undefined;
      }
      return batchResult;
    } catch (err) {
      if (!structured) {
        log.debug("memory embeddings: batch failed", {
          provider: provider.id,
          error: formatErrorMessage(err),
        });
      }
      const message = formatErrorMessage(err);
      if (isBillingExhaustedMemoryEmbeddingError(message)) {
        this.embeddingBillingCooldown = computeNextMemoryEmbeddingCooldown({
          providerId: provider.id,
          reason: message,
          previous: this.embeddingBillingCooldown,
          nowMs: Date.now(),
        });
        log.warn("memory embeddings: provider entering billing cooldown", {
          provider: provider.id,
          reason: message,
          consecutiveFailures: this.embeddingBillingCooldown.consecutiveFailures,
          cooldownUntil: new Date(this.embeddingBillingCooldown.untilMs).toISOString(),
        });
      }
      this.markLocalEmbeddingProviderDegraded(err);
      throw createMemoryEmbeddingOperationError({
        operation: params.operation,
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
                run: async (opSignal) => await provider.embedQuery(text, { signal: opSignal }),
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

  /**
   * Write chunks (and optional embeddings) for a file into the index.
   * Handles both the chunks table, the vector table, and the FTS table.
   * Pass an empty embeddings array to skip vector writes (FTS-only mode).
   */
  private writeChunks(
    entry: MemoryIndexEntry,
    source: MemorySource,
    model: string,
    chunks: IndexedMemoryChunk[],
    embeddings: number[][],
    vectorReady: boolean,
  ): void {
    const now = Date.now();
    const needsVectorRebuild = !vectorReady && embeddings.some((embedding) => embedding.length > 0);
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
      this.upsertFileRecord(entry, source);
      if (needsVectorRebuild) {
        this.markVectorRebuildRequired();
      }
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
    generation: MemorySyncProviderGeneration | null,
  ): Promise<PreparedMemoryIndexEntry | null> {
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
    const normalizedEntryPath = entry.path.replaceAll("\\", "/");
    const perEntry =
      options.source === "memory" &&
      (normalizedEntryPath === "MEMORY.md" || normalizedEntryPath === "USER.md");
    const indexingContent =
      options.source === "memory" ? stripMemoryAnnotationCarriers(content) : content;
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
    const chunks = (
      generation?.kind === "semantic"
        ? enforceEmbeddingMaxInputTokens(
            generation.provider,
            baseChunks,
            EMBEDDING_BATCH_MAX_TOKENS,
          )
        : baseChunks
    ).map(
      (chunk): IndexedMemoryChunk =>
        Object.assign(
          chunk,
          resolveChunkRecallMetadata({
            curatedRoot: pathClassification.curatedRoot,
            projectScopeEligible:
              options.source === "memory" && normalizedEntryPath.toUpperCase() !== "USER.MD",
            content,
            chunk,
          }),
        ),
    );
    if (options.source === "sessions" && "lineMap" in entry) {
      remapChunkLines(chunks, entry.lineMap);
    }
    return { entry, source: options.source, chunks };
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
          ...(await this.embedChunksWithBatch(chunkBatch, firstEntry, source, generation, {
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
          generation.provider.model,
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
    // FTS-only mode: no embedding provider, but we can still build a FTS index
    if (generation?.kind !== "semantic") {
      // Multimodal files require an embedding provider; skip in FTS-only mode.
      if ("kind" in entry && entry.kind === "multimodal") {
        return;
      }
      const prepared = await this.prepareIndexEntry(entry, options, null);
      this.writeChunks(entry, options.source, "fts-only", prepared?.chunks ?? [], [], false);
      return;
    }

    const prepared = await this.prepareIndexEntry(entry, options, generation);
    if (!prepared) {
      return;
    }

    let embeddings: number[][];
    try {
      embeddings = this.batch.enabled
        ? await this.embedChunksWithBatch(prepared.chunks, entry, options.source, generation)
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
      generation.provider.model,
      prepared.chunks,
      embeddings,
      vectorReady,
    );
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
