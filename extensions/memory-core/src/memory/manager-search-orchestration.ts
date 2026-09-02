// Memory Core plugin module owns public search orchestration.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  type MemorySearchManager,
  type MemorySearchResult,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { uniqueValues } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  mergeHybridResults,
  selectHybridSearchResults,
  type HybridSearchResult,
} from "./hybrid.js";
import { applyImportanceMultiplier } from "./importance.js";
import { startAsyncSearchSync } from "./manager-async-state.js";
import { acquireMemoryIndexReadGeneration } from "./manager-index-generation-lease.js";
import { MemoryKeywordRetrieval, type KeywordSearchHit } from "./manager-keyword-retrieval.js";
import { runVectorKnnInSubprocess } from "./manager-search-knn-subprocess.js";
import { resolveMemorySearchPreflight } from "./manager-search-preflight.js";
import { resolveExactPathSpecificity, searchVector } from "./manager-search.js";
import { applyProjectRanking } from "./project-ranking.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = MEMORY_INDEX_VECTOR_TABLE;
const FTS_TABLE = MEMORY_INDEX_FTS_TABLE;
const log = createSubsystemLogger("memory");
type MemoryIndexSearchOptions = NonNullable<Parameters<MemorySearchManager["search"]>[1]>;

export abstract class MemorySearchOrchestration extends MemoryKeywordRetrieval {
  protected abstract sessionWarm: Set<string>;

  protected claimSessionWarmSync(sessionKey?: string): boolean {
    if (!this.settings.sync.onSessionStart) {
      return false;
    }
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      return false;
    }
    if (key) {
      this.sessionWarm.add(key);
    }
    return this.dirty || this.sessionsDirty;
  }

  async search(query: string, opts?: MemoryIndexSearchOptions): Promise<MemorySearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const hasActiveProject = (opts?.activeProjectKeys?.length ?? 0) > 0;
    const candidateMaxResults = hasActiveProject
      ? Math.min(200, Math.max(maxResults, maxResults * 4))
      : maxResults;
    const candidateMinScore = hasActiveProject ? minScore / 1.15 : minScore;
    const results = await this.searchCandidates(normalizedQuery, {
      ...opts,
      maxResults: candidateMaxResults,
      minScore: candidateMinScore,
    });
    return hasActiveProject
      ? results.filter((entry) => entry.score >= minScore).slice(0, maxResults)
      : results;
  }

  private async searchCandidates(
    normalizedQuery: string,
    opts?: MemoryIndexSearchOptions,
  ): Promise<MemorySearchResult[]> {
    let releaseGeneration: (() => void) | undefined;
    return await this.withManagerOperation(async () => {
      opts?.onDebug?.({ backend: "builtin" });
      if (this.providerRequirement.mode === "required") {
        await this.ensureProviderInitialized();
        this.assertRequiredProviderAvailable("search");
      }
      let hasIndexedContent = this.hasIndexedContent();
      if (!hasIndexedContent) {
        try {
          // A fresh process can receive its first search before background watch/session
          // syncs have built the index. Force one synchronous bootstrap so the first
          // lookup after restart does not fail closed with empty results.
          await this.syncAdmitted(
            { reason: "search", force: true },
            { allowEmbeddingBootstrapFallback: true },
          );
        } catch (err) {
          if (this.providerRequirement.mode === "optional" && this.shouldFallbackOnError(err)) {
            const failedProvider = this.provider?.id ?? this.settings.provider;
            await this.retireCurrentProvider().catch((retireErr: unknown) => {
              const message = redactSensitiveText(formatErrorMessage(retireErr), {
                mode: "tools",
              });
              log.warn(`memory search-bootstrap: failed to retire embedding provider: ${message}`);
            });
            this.markEmbeddingBootstrapFailure(err, { provider: failedProvider });
            await this.syncAdmitted({ reason: "search", force: true }).catch(
              (fallbackErr: unknown) => {
                const message = redactSensitiveText(formatErrorMessage(fallbackErr), {
                  mode: "tools",
                });
                log.warn(`memory sync failed (search-bootstrap-fallback): ${message}`);
              },
            );
          } else {
            log.warn(`memory sync failed (search-bootstrap): ${String(err)}`);
          }
        }
        hasIndexedContent = this.hasIndexedContent();
      }
      const preflight = resolveMemorySearchPreflight({
        query: normalizedQuery,
        hasIndexedContent,
      });
      if (!preflight.shouldSearch) {
        if (this.embeddingBootstrapFailure) {
          opts?.onDebug?.({
            backend: "builtin",
            embeddingBootstrap: this.embeddingBootstrapFailure,
          });
        }
        return [];
      }
      const cleaned = preflight.normalizedQuery;
      const embeddingBootstrapKeywordOnly = await this.ensureEmbeddingProviderForSearch(
        opts?.onDebug,
      );
      const sessionStartSync = this.claimSessionWarmSync(opts?.sessionKey);
      if (
        !embeddingBootstrapKeywordOnly &&
        preflight.shouldInitializeProvider &&
        !this.provider &&
        (this.providerLifecycle.mode === "pending" ||
          (this.providerLifecycle.mode === "degraded" &&
            this.providerLifecycle.providerId !== this.settings.provider))
      ) {
        // A failed fallback must yield ownership back to the configured primary.
        // Reinitialize it before identity validation; leaving the lifecycle pending
        // makes a valid existing index look mismatched and drops keyword results.
        this.resetProviderInitializationForRetry();
        await this.ensureProviderInitialized();
      }
      this.assertRequiredProviderAvailable("search");
      if (
        !embeddingBootstrapKeywordOnly &&
        !this.provider &&
        this.providerLifecycle.mode === "degraded"
      ) {
        const activatedFallback = await this.activateFallbackProvider(
          this.providerLifecycle.reason,
        ).catch((fallbackErr: unknown) => {
          log.warn(
            `memory search: failed to activate fallback provider: ${formatErrorMessage(fallbackErr)}`,
          );
          return false;
        });
        if (activatedFallback) {
          this.refreshIndexIdentityDirty({
            providerKeyKnown: this.providerInitialized,
          });
        }
      }
      const indexIdentity = embeddingBootstrapKeywordOnly
        ? this.refreshKeywordFallbackIndexIdentity()
        : this.refreshIndexIdentityDirty({
            providerKeyKnown: this.providerInitialized,
          });
      if (indexIdentity.status === "missing" && hasIndexedContent) {
        // Missing metadata cannot identify a safe published generation. Repair it
        // synchronously before a detached handoff or a read-generation lease.
        await this.syncAdmitted(
          { reason: "search", force: true },
          { allowEmbeddingBootstrapFallback: true },
        ).catch((err: unknown) => {
          log.warn(`memory sync failed (search-identity-repair): ${formatErrorMessage(err)}`);
        });
      }
      let repairedIndexIdentity =
        indexIdentity.status === "missing" && hasIndexedContent
          ? embeddingBootstrapKeywordOnly
            ? this.refreshKeywordFallbackIndexIdentity()
            : this.refreshIndexIdentityDirty({
                providerKeyKnown: this.providerInitialized,
              })
          : indexIdentity;
      if (
        repairedIndexIdentity.status === "mismatched" &&
        !embeddingBootstrapKeywordOnly &&
        (await this.adoptPublishedFallbackProviderIfMatched())
      ) {
        repairedIndexIdentity = this.refreshIndexIdentityDirty({
          providerKeyKnown: this.providerInitialized,
        });
      }
      if (repairedIndexIdentity.status !== "valid") {
        return [];
      }
      const backgroundSearchSync = startAsyncSearchSync({
        enabled:
          (this.settings.sync.onSearch || sessionStartSync) &&
          (this.purpose === "default" || this.purpose === "cli"),
        dirty: this.dirty,
        sessionsDirty: this.sessionsDirty,
        sync: async (params) => await this.syncPublishedIndexInBackground(params),
        onError: (err) => {
          log.warn(`memory sync failed (search): ${String(err)}`);
        },
      });
      if (backgroundSearchSync) {
        const trackedSearchSync = backgroundSearchSync.finally(() => {
          this.activeBackgroundSearchSyncs.delete(trackedSearchSync);
        });
        this.activeBackgroundSearchSyncs.add(trackedSearchSync);
      }
      // Bootstrap and identity repair may publish a new generation. Acquire the
      // read lease only after those writers finish so first search cannot wait on itself.
      for (let identityAttempt = 0; identityAttempt < 2; identityAttempt += 1) {
        releaseGeneration = await acquireMemoryIndexReadGeneration(
          this.settings.store.databasePath,
          opts?.signal,
        );
        if (embeddingBootstrapKeywordOnly) {
          break;
        }
        const leasedIdentity = this.refreshIndexIdentityDirty({
          providerKeyKnown: this.providerInitialized,
        });
        if (leasedIdentity.status === "valid") {
          break;
        }
        releaseGeneration();
        releaseGeneration = undefined;
        if (
          identityAttempt > 0 ||
          leasedIdentity.status !== "mismatched" ||
          !(await this.adoptPublishedFallbackProviderIfMatched())
        ) {
          return [];
        }
      }
      const minScore = opts?.minScore ?? this.settings.query.minScore;
      const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
      const searchSources =
        opts?.sources && opts.sources.length > 0
          ? uniqueValues(opts.sources).filter((s) => this.sources.has(s))
          : undefined;
      if (
        opts?.sources &&
        opts.sources.length > 0 &&
        (!searchSources || searchSources.length === 0)
      ) {
        return [];
      }
      // The manager may index recall-only transcripts without making them part of
      // ordinary searches. Trusted recall passes an explicit source override;
      // every other caller defaults to the configured search corpus.
      const sourceFilterList = searchSources ?? this.settings.searchSources;
      const hybrid = this.settings.query.hybrid;
      const candidates = Math.min(
        200,
        Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
      );

      // FTS-only mode: no embedding provider available
      if (embeddingBootstrapKeywordOnly || !this.provider) {
        this.assertRequiredProviderAvailable("search");
        if (!this.fts.enabled || !this.fts.available) {
          log.warn("memory search: no provider and FTS unavailable");
          return [];
        }

        const keywordResults = await this.searchKeywordWithFallback(
          cleaned,
          candidates,
          {
            boostFallbackRanking: true,
          },
          sourceFilterList,
        ).catch((err: unknown) => {
          log.warn(`memory search: FTS keyword query failed: ${formatErrorMessage(err)}`);
          return [];
        });

        return await this.finalizeKeywordOnlyResults({
          results: keywordResults,
          temporalDecay: hybrid.temporalDecay,
          maxResults,
          minScore,
          activeProjectKeys: opts?.activeProjectKeys,
        });
      }
      let semanticProvider = this.provider;
      let semanticProviderRuntime = this.providerRuntime;
      let vectorProviderIdentity = {
        model: semanticProvider.model,
        aliases: this.resolveProviderIndexIdentities()
          .slice(1)
          .map((identity) => identity.model),
      };

      // If FTS isn't available, hybrid mode cannot use keyword search; degrade to vector-only.
      const loadKeywordResults = async () =>
        hybrid.enabled && this.fts.enabled && this.fts.available
          ? await this.searchKeywordWithFallback(
              cleaned,
              candidates,
              { boostFallbackRanking: true },
              sourceFilterList,
            ).catch((err: unknown) => {
              log.warn(
                `memory search: FTS hybrid keyword query failed: ${formatErrorMessage(err)}`,
              );
              return [];
            })
          : [];
      let keywordResults: Awaited<ReturnType<typeof loadKeywordResults>> = [];
      let queryVec: number[];
      const releaseSemanticProvider = this.acquireProviderUse(semanticProvider);
      try {
        keywordResults = await loadKeywordResults();
        // lexicalOnly is a reply-path contract: no query embedding, no vector
        // search, no network. Callers accept keyword-only recall quality.
        if (opts?.lexicalOnly) {
          return await this.finalizeKeywordOnlyResults({
            results: keywordResults,
            temporalDecay: hybrid.temporalDecay,
            maxResults,
            minScore,
            activeProjectKeys: opts?.activeProjectKeys,
          });
        }
        try {
          queryVec = await this.embedQueryWithRetry(
            cleaned,
            opts?.signal,
            semanticProvider,
            false,
            semanticProviderRuntime,
          );
        } catch (err) {
          releaseSemanticProvider();
          // An aborted caller already stopped waiting; keep the provider generation
          // healthy and skip fallback activation instead of poisoning later searches.
          if (opts?.signal?.aborted) {
            throw err;
          }
          this.markLocalEmbeddingProviderDegraded(err);
          const message = formatErrorMessage(err);
          const activatedFallback = this.shouldFallbackOnError(err)
            ? await this.activateFallbackProvider(message).catch((fallbackErr: unknown) => {
                log.warn(
                  `memory search: failed to activate fallback provider: ${formatErrorMessage(fallbackErr)}`,
                );
                return false;
              })
            : false;
          if (activatedFallback) {
            if (
              this.refreshIndexIdentityDirty({
                providerKeyKnown: this.providerInitialized,
              }).status !== "valid"
            ) {
              return [];
            }
            if (!this.provider) {
              return [];
            }
            semanticProvider = this.provider;
            semanticProviderRuntime = this.providerRuntime;
            vectorProviderIdentity = {
              model: semanticProvider.model,
              aliases: this.resolveProviderIndexIdentities()
                .slice(1)
                .map((identity) => identity.model),
            };
            const releaseFallbackProvider = this.acquireProviderUse(semanticProvider);
            try {
              keywordResults = await loadKeywordResults();
              queryVec = await this.embedQueryWithRetry(
                cleaned,
                opts?.signal,
                semanticProvider,
                false,
                semanticProviderRuntime,
              );
            } catch (fallbackErr) {
              releaseFallbackProvider();
              if (!opts?.signal?.aborted) {
                this.markLocalEmbeddingProviderDegraded(fallbackErr);
              }
              throw fallbackErr;
            } finally {
              releaseFallbackProvider();
            }
          } else if (!this.provider && this.fts.enabled && this.fts.available) {
            this.assertRequiredProviderAvailable("search");
            log.warn(
              `memory search: embeddings unavailable; using keyword-only results: ${message}`,
            );
            return await this.finalizeKeywordOnlyResults({
              results: keywordResults,
              temporalDecay: hybrid.temporalDecay,
              maxResults,
              minScore,
              activeProjectKeys: opts?.activeProjectKeys,
            });
          } else {
            throw err;
          }
        }
      } finally {
        releaseSemanticProvider();
      }
      const hasVector = queryVec.some((v) => v !== 0);
      const vectorResults = hasVector
        ? await this.searchVector(
            queryVec,
            candidates,
            sourceFilterList,
            vectorProviderIdentity,
            opts?.signal,
          ).catch((err: unknown) => {
            opts?.signal?.throwIfAborted();
            log.warn(`memory search: vector query failed: ${formatErrorMessage(err)}`);
            return [];
          })
        : [];

      if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) {
        const decayed = await applyTemporalDecayToHybridResults({
          results: vectorResults,
          temporalDecay: hybrid.temporalDecay,
          workspaceDir: this.workspaceDir,
        });
        return applyProjectRanking(applyImportanceMultiplier(decayed), opts?.activeProjectKeys)
          .filter((entry) => entry.score >= minScore)
          .slice(0, maxResults);
      }

      const merged = await this.mergeHybridResults({
        query: cleaned,
        vector: vectorResults,
        keyword: keywordResults,
        vectorWeight: hybrid.vectorWeight,
        textWeight: hybrid.textWeight,
        mmr: hybrid.mmr,
        temporalDecay: hybrid.temporalDecay,
        activeProjectKeys: opts?.activeProjectKeys,
      });
      return selectHybridSearchResults({
        merged,
        keyword: keywordResults,
        maxResults,
        minScore,
      });
    }).finally(() => {
      releaseGeneration?.();
    });
  }

  private hasIndexedContent(): boolean {
    const chunkRow = this.db.prepare(`SELECT 1 as found FROM memory_index_chunks LIMIT 1`).get() as
      | {
          found?: number;
        }
      | undefined;
    if (chunkRow?.found === 1) {
      return true;
    }
    if (!this.fts.enabled || !this.fts.available) {
      return false;
    }
    const ftsRow = this.db.prepare(`SELECT 1 as found FROM ${FTS_TABLE} LIMIT 1`).get() as
      | {
          found?: number;
        }
      | undefined;
    return ftsRow?.found === 1;
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
    sourceFilterList: MemorySource[],
    providerIdentity: { model: string; aliases: string[] },
    signal?: AbortSignal,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: providerIdentity.model,
      providerModelAliases: providerIdentity.aliases,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      signal,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      runVectorKnn: async (request, knnSignal) =>
        await runVectorKnnInSubprocess({
          databasePath: resolveUserPath(this.settings.store.databasePath),
          extensionPath: this.vector.extensionPath,
          request,
          signal: knnSignal,
        }),
      sourceFilterVec: this.buildSourceFilter("c", sourceFilterList),
      sourceFilterChunks: this.buildSourceFilter(undefined, sourceFilterList),
    });
    return this.attachRecallMetadata(
      results.map((entry) => entry as MemorySearchResult & { id: string }),
    );
  }

  private mergeHybridResults(params: {
    query: string;
    vector: Array<MemorySearchResult & { id: string }>;
    keyword: KeywordSearchHit[];
    vectorWeight: number;
    textWeight: number;
    mmr?: { enabled: boolean; lambda: number };
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
    activeProjectKeys?: readonly string[];
  }): Promise<HybridSearchResult<MemorySource>[]> {
    return mergeHybridResults({
      vector: params.vector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
        importance: r.importance,
        triggers: r.triggers,
        projectKey: r.projectKey,
        exactPathSpecificity: resolveExactPathSpecificity(params.query, r.path),
        ...(r.provenance ? { provenance: r.provenance } : {}),
      })),
      keyword: params.keyword.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
        hasBodyMatch: r.hasBodyMatch,
        importance: r.importance,
        triggers: r.triggers,
        projectKey: r.projectKey,
        rankingScore: r.score,
        pathScore: r.pathScore,
        exactPathSpecificity: r.exactPathSpecificity,
        ...(r.provenance ? { provenance: r.provenance } : {}),
      })),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
      isNonTextMediaPath: (path) =>
        classifyMemoryMultimodalPath(path, this.settings.multimodal) !== null,
      mmr: params.mmr,
      temporalDecay: params.temporalDecay,
      activeProjectKeys: params.activeProjectKeys,
      workspaceDir: this.workspaceDir,
    });
  }
}
