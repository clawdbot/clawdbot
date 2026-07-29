import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { QmdQueryResult } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type {
  MemoryEntryProvenance,
  MemorySearchResult,
  MemorySearchRuntimeDebug,
  MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { uniqueValues } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  attachQmdSessionArtifactHit,
  resolveQmdSessionArtifactIdentity,
} from "../qmd-session-artifacts.js";
import { asQmdAbortError, isMissingCollectionSearchError } from "./qmd-command-errors.js";
import { qmdManagerLog } from "./qmd-manager-base.js";
import { QmdManagerSearchSupport } from "./qmd-manager-search-support.js";
import {
  MEMORY_SEARCH_DEADLINE_CONTROL,
  type MemorySearchDeadlineControlOptions,
} from "./search-deadline.js";

function resolveQmdSearchProvenance(
  resultPath: string,
  source: MemorySource,
  observedAt: number,
): MemoryEntryProvenance {
  const normalizedPath = resultPath.replaceAll("\\", "/").toLowerCase();
  const isSystemArtifact =
    normalizedPath === "dreams.md" ||
    normalizedPath.startsWith("memory/dreaming/") ||
    normalizedPath.startsWith("memory/.dreams/");
  const isConsolidatedMemory = normalizedPath === "memory.md";
  return {
    // QMD does not carry flush-recorded per-line provenance. Keep daily notes
    // and extra paths untrusted until that metadata is available on results.
    originClass:
      source === "sessions"
        ? "untrusted"
        : isSystemArtifact
          ? "system"
          : isConsolidatedMemory
            ? "agent"
            : "untrusted",
    sessionKind: "unknown",
    observedAt,
  };
}

export abstract class QmdManagerSearch extends QmdManagerSearchSupport {
  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      sources?: MemorySource[];
      /**
       * Caller-owned cancellation. When the caller stops waiting, abort kills
       * the in-flight qmd subprocess instead of leaving it orphaned.
       */
      signal?: AbortSignal;
    } & MemorySearchDeadlineControlOptions,
  ): Promise<MemorySearchResult[]> {
    if (!this.isScopeAllowed(opts?.sessionKey)) {
      this.logScopeDenied(opts?.sessionKey);
      return [];
    }
    const searchSignal = opts?.signal;
    const reportCommandPhase = opts?.[MEMORY_SEARCH_DEADLINE_CONTROL];
    if (searchSignal?.aborted) {
      throw asQmdAbortError(searchSignal);
    }
    const debugContext = this.beginQmdSearchRuntimeDebug();
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    await this.maybeWarmSession(opts?.sessionKey);
    await this.maybeSyncDirtySearchState();
    await this.waitForPendingUpdateBeforeSearch();
    const resultLimit = Math.min(
      this.qmd.limits.maxResults,
      opts?.maxResults ?? this.qmd.limits.maxResults,
    );
    // Remember-only session exports are indexed for trusted recall but are not
    // part of ordinary manager searches. Explicit export keeps its existing
    // ordinary-access behavior; trusted recall always passes sources=sessions.
    const requestedSources = opts?.sources?.length
      ? uniqueValues(opts.sources)
      : this.qmd.sessions.readable
        ? undefined
        : (["memory"] satisfies MemorySource[]);
    const collectionNames = this.listManagedCollectionNames(requestedSources);
    const limit = resultLimit;
    if (collectionNames.length === 0) {
      qmdManagerLog.warn("qmd query skipped: no managed collections configured");
      return [];
    }
    const qmdSearchCommand = opts?.qmdSearchModeOverride ?? this.qmd.searchMode;
    let effectiveSearchMode: "query" | "search" | "vsearch" = qmdSearchCommand;
    let searchFallbackReason: string | undefined;
    const explicitSearchTool = this.qmd.searchTool;
    const mcporterEnabled = this.qmd.mcporter.enabled;
    const runSearchAttempt = async (
      allowMissingCollectionRepair: boolean,
    ): Promise<QmdQueryResult[]> => {
      let attemptedCombinedCollectionFilter = false;
      try {
        if (mcporterEnabled) {
          const minScore = opts?.minScore ?? 0;
          if (explicitSearchTool) {
            if (collectionNames.length > 1) {
              return await this.commands.searchAcrossCollections({
                tool: explicitSearchTool,
                searchCommand: qmdSearchCommand,
                explicitToolOverride: true,
                query: trimmed,
                limit,
                minScore,
                collectionNames,
                signal: searchSignal,
                reportCommandPhase,
              });
            }
            return await this.commands.searchViaMcporter({
              mcporter: this.qmd.mcporter,
              tool: explicitSearchTool,
              searchCommand: qmdSearchCommand,
              explicitToolOverride: true,
              query: trimmed,
              limit,
              minScore,
              collection: collectionNames[0],
              timeoutMs: this.qmd.limits.timeoutMs,
              signal: searchSignal,
              reportCommandPhase,
            });
          }
          const tool = this.commands.resolveMcpTool(qmdSearchCommand);
          if (collectionNames.length > 1) {
            return await this.commands.searchAcrossCollections({
              tool,
              searchCommand: qmdSearchCommand,
              explicitToolOverride: false,
              query: trimmed,
              limit,
              minScore,
              collectionNames,
              signal: searchSignal,
              reportCommandPhase,
            });
          }
          return await this.commands.searchViaMcporter({
            mcporter: this.qmd.mcporter,
            tool,
            searchCommand: qmdSearchCommand,
            explicitToolOverride: false,
            query: trimmed,
            limit,
            minScore,
            collection: collectionNames[0],
            timeoutMs: this.qmd.limits.timeoutMs,
            signal: searchSignal,
            reportCommandPhase,
          });
        }
        const collectionGroups = await this.resolveCollectionSearchGroups(
          collectionNames,
          searchSignal,
          debugContext,
        );
        this.recordSearchPlanDebug({
          debugContext,
          command: qmdSearchCommand,
          collectionNames,
          collectionGroups,
        });
        attemptedCombinedCollectionFilter = collectionGroups.some((group) => group.length > 1);
        if (collectionGroups.length > 1) {
          return await this.runQueryAcrossCollectionGroups(
            trimmed,
            limit,
            collectionGroups,
            qmdSearchCommand,
            searchSignal,
            reportCommandPhase,
          );
        }
        const args = this.buildSearchArgs(qmdSearchCommand, trimmed, limit);
        args.push(...this.buildCollectionFilterArgs(collectionGroups[0] ?? collectionNames));
        return await this.runQmdSearch(args, qmdSearchCommand, searchSignal, reportCommandPhase);
      } catch (err) {
        if (allowMissingCollectionRepair && isMissingCollectionSearchError(err)) {
          throw err;
        }
        if (
          !mcporterEnabled &&
          qmdSearchCommand !== "query" &&
          this.isUnsupportedQmdOptionError(err)
        ) {
          if (attemptedCombinedCollectionFilter) {
            await this.markQmdMultiCollectionFiltersUnsupported(debugContext);
          }
          effectiveSearchMode = "query";
          searchFallbackReason = "unsupported-search-flags";
          qmdManagerLog.warn(
            `qmd ${qmdSearchCommand} does not support configured flags; retrying search with qmd query`,
          );
          try {
            const collectionGroups = await this.resolveCollectionSearchGroups(
              collectionNames,
              searchSignal,
              debugContext,
            );
            this.recordSearchPlanDebug({
              debugContext,
              command: "query",
              collectionNames,
              collectionGroups,
            });
            if (collectionGroups.length > 1) {
              return await this.runQueryAcrossCollectionGroups(
                trimmed,
                limit,
                collectionGroups,
                "query",
                searchSignal,
                reportCommandPhase,
              );
            }
            const fallbackArgs = this.buildSearchArgs("query", trimmed, limit);
            fallbackArgs.push(
              ...this.buildCollectionFilterArgs(collectionGroups[0] ?? collectionNames),
            );
            return await this.runQmdSearch(fallbackArgs, "query", searchSignal, reportCommandPhase);
          } catch (fallbackErr) {
            qmdManagerLog.warn(`qmd query fallback failed: ${String(fallbackErr)}`);
            throw fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
          }
        }
        const label = mcporterEnabled ? "mcporter/qmd" : `qmd ${qmdSearchCommand}`;
        qmdManagerLog.warn(`${label} failed: ${String(err)}`);
        throw err instanceof Error ? err : new Error(String(err));
      }
    };

    let parsed: QmdQueryResult[];
    try {
      parsed = await runSearchAttempt(true);
    } catch (err) {
      if (!(await this.tryRepairMissingCollectionSearch(err, debugContext, searchSignal))) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      parsed = await runSearchAttempt(false);
    }
    const results: MemorySearchResult[] = [];
    for (const entry of parsed) {
      const docHints = this.normalizeDocHints({
        preferredCollection: entry.collection,
        preferredFile: entry.file,
      });
      const doc = await this.resolveDocLocation(entry.docid, docHints);
      if (!doc) {
        continue;
      }
      const snippet = truncateUtf16Safe(entry.snippet ?? "", this.qmd.limits.maxSnippetChars);
      const lines = this.resolveSnippetLines(entry, snippet);
      const score = typeof entry.score === "number" ? entry.score : 0;
      const minScore = opts?.minScore ?? 0;
      if (score < minScore) {
        continue;
      }
      const result = {
        path: doc.rel,
        startLine: lines.startLine,
        endLine: lines.endLine,
        score,
        snippet,
        source: doc.source,
        provenance: resolveQmdSearchProvenance(doc.rel, doc.source, doc.observedAt),
      } satisfies MemorySearchResult;
      const artifactIdentity =
        doc.source === "sessions"
          ? resolveQmdSessionArtifactIdentity({
              artifactPath: doc.collectionRelativePath,
              collection: doc.collection,
              docid: entry.docid?.trim() || undefined,
              indexPath: this.indexPath,
              searchPath: doc.rel,
            })
          : null;
      results.push(
        artifactIdentity ? attachQmdSessionArtifactHit(result, artifactIdentity) : result,
      );
    }
    opts?.onDebug?.({
      backend: "qmd",
      configuredMode: qmdSearchCommand,
      effectiveMode: effectiveSearchMode,
      fallback: searchFallbackReason,
      qmd: this.consumeQmdRuntimeDebug(debugContext),
    });
    let ranked = results;
    if (opts?.sources?.length) {
      const allow = new Set(opts.sources);
      ranked = results.filter((result) => allow.has(result.source));
    }
    return this.clampResultsByInjectedChars(this.diversifyResultsBySource(ranked, resultLimit));
  }
}
