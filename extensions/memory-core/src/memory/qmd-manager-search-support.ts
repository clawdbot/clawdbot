import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  deriveQmdScopeChannel,
  deriveQmdScopeChatType,
  isQmdScopeAllowed,
  type QmdQueryResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type {
  MemorySearchResult,
  MemorySearchRuntimeDebug,
  MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { uniqueValues } from "openclaw/plugin-sdk/string-coerce-runtime";
import { copyQmdSessionArtifactHit } from "../qmd-session-artifacts.js";
import type { QmdSearchRuntimeDebugContext } from "./qmd-collection-controller.js";
import type { QmdCommandPhaseReporter } from "./qmd-command-client.js";
import {
  asQmdAbortError,
  isMissingCollectionSearchError,
  isUnsupportedQmdOptionError,
} from "./qmd-command-errors.js";
import type { QmdDocLocation as DocLocation } from "./qmd-document-resolver.js";
import { qmdManagerLog } from "./qmd-manager-base.js";
import { normalizeHanBm25Query, SEARCH_PENDING_UPDATE_WAIT_MS } from "./qmd-manager-helpers.js";
import { QmdManagerLifecycle } from "./qmd-manager-lifecycle.js";
import {
  clearQmdMultiCollectionProbeCache,
  readQmdMultiCollectionProbeCache,
  writeQmdMultiCollectionProbeCache,
} from "./qmd-runtime-cache.js";

const SNIPPET_HEADER_RE = /@@\s*-([0-9]+),([0-9]+)/;

export abstract class QmdManagerSearchSupport extends QmdManagerLifecycle {
  protected recordSearchPlanDebug(params: {
    debugContext: QmdSearchRuntimeDebugContext;
    command: "query" | "search" | "vsearch";
    collectionNames: string[];
    collectionGroups: string[][];
  }): void {
    const sources = uniqueValues(
      params.collectionNames
        .map((collectionName) => this.collectionRoots.get(collectionName)?.kind)
        .filter((source): source is MemorySource => Boolean(source)),
    );
    params.debugContext.searchPlan = {
      command: params.command,
      collectionCount: params.collectionNames.length,
      groupCount: params.collectionGroups.length,
      sources,
    };
  }

  protected beginQmdSearchRuntimeDebug(): QmdSearchRuntimeDebugContext {
    const debugContext: QmdSearchRuntimeDebugContext = {};
    const collectionValidation = this.collectionController.consumePendingValidationDebug();
    if (collectionValidation) {
      debugContext.collectionValidation = collectionValidation;
    }
    return debugContext;
  }

  protected consumeQmdRuntimeDebug(
    debugContext: QmdSearchRuntimeDebugContext,
  ): MemorySearchRuntimeDebug["qmd"] | undefined {
    const debug: NonNullable<MemorySearchRuntimeDebug["qmd"]> = {};
    if (debugContext.collectionValidation) {
      debug.collectionValidation = debugContext.collectionValidation;
    }
    if (debugContext.multiCollectionProbe) {
      debug.multiCollectionProbe = debugContext.multiCollectionProbe;
    }
    if (debugContext.searchPlan) {
      debug.searchPlan = debugContext.searchPlan;
    }
    return Object.keys(debug).length > 0 ? debug : undefined;
  }

  protected async tryRepairMissingCollectionSearch(
    err: unknown,
    debugContext: QmdSearchRuntimeDebugContext,
    parentSignal?: AbortSignal,
  ): Promise<boolean> {
    if (!isMissingCollectionSearchError(err)) {
      return false;
    }
    qmdManagerLog.warn(
      "qmd search failed because a managed collection is missing; repairing collections and retrying once",
    );
    await this.ensureCollections({ force: true, debugContext, parentSignal });
    return true;
  }

  protected async runQmdSearch(
    args: string[],
    command: "query" | "search" | "vsearch",
    signal?: AbortSignal,
    reportCommandPhase?: QmdCommandPhaseReporter,
  ): Promise<QmdQueryResult[]> {
    return await this.commands.search(args, command, signal, reportCommandPhase);
  }

  protected async resolveDocLocation(
    docid?: string,
    hints?: { preferredCollection?: string; preferredFile?: string },
  ): Promise<DocLocation | null> {
    return await this.documentResolver.resolveDocLocation(docid, hints);
  }

  protected normalizeDocHints(hints?: { preferredCollection?: string; preferredFile?: string }): {
    preferredCollection?: string;
    preferredFile?: string;
  } {
    return this.documentResolver.normalizeDocHints(hints);
  }

  protected toCollectionRelativePath(collection: string, filePath: string): string | null {
    return this.documentResolver.toCollectionRelativePath(collection, filePath);
  }

  protected resolveSnippetLines(
    entry: QmdQueryResult,
    snippet: string,
  ): { startLine: number; endLine: number } {
    const explicitStart = this.normalizeSnippetLine(entry.startLine);
    const explicitEnd = this.normalizeSnippetLine(entry.endLine);
    const headerLines = this.parseSnippetHeaderLines(snippet);
    if (explicitStart !== undefined && explicitEnd !== undefined) {
      return explicitStart <= explicitEnd
        ? { startLine: explicitStart, endLine: explicitEnd }
        : { startLine: explicitEnd, endLine: explicitStart };
    }
    if (explicitStart !== undefined) {
      if (headerLines) {
        const width = headerLines.endLine - headerLines.startLine;
        return {
          startLine: explicitStart,
          endLine: explicitStart + Math.max(0, width),
        };
      }
      return { startLine: explicitStart, endLine: explicitStart };
    }
    if (explicitEnd !== undefined) {
      if (headerLines) {
        const width = headerLines.endLine - headerLines.startLine;
        return {
          startLine: Math.max(1, explicitEnd - Math.max(0, width)),
          endLine: explicitEnd,
        };
      }
      return { startLine: explicitEnd, endLine: explicitEnd };
    }
    if (headerLines) {
      return headerLines;
    }
    return { startLine: 1, endLine: snippet.split("\n").length };
  }

  protected normalizeSnippetLine(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  protected parseSnippetHeaderLines(
    snippet: string,
  ): { startLine: number; endLine: number } | null {
    const match = SNIPPET_HEADER_RE.exec(snippet);
    if (!match) {
      return null;
    }
    const start = Number(match[1]);
    const count = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(count)) {
      return { startLine: start, endLine: start + count - 1 };
    }
    return null;
  }

  protected logScopeDenied(sessionKey?: string): void {
    const channel = deriveQmdScopeChannel(sessionKey) ?? "unknown";
    const chatType = deriveQmdScopeChatType(sessionKey) ?? "unknown";
    const key = sessionKey?.trim() || "<none>";
    qmdManagerLog.warn(
      `qmd search denied by scope (channel=${channel}, chatType=${chatType}, session=${key})`,
    );
  }

  protected isScopeAllowed(sessionKey?: string): boolean {
    return isQmdScopeAllowed(this.qmd.scope, sessionKey);
  }

  protected clampResultsByInjectedChars(results: MemorySearchResult[]): MemorySearchResult[] {
    const budget = this.qmd.limits.maxInjectedChars;
    if (!budget || budget <= 0) {
      return results;
    }
    let remaining = budget;
    const clamped: MemorySearchResult[] = [];
    for (const entry of results) {
      if (remaining <= 0) {
        break;
      }
      const snippet = entry.snippet ?? "";
      if (snippet.length <= remaining) {
        clamped.push(entry);
        remaining -= snippet.length;
      } else {
        const trimmed = truncateUtf16Safe(snippet, remaining);
        clamped.push(copyQmdSessionArtifactHit(entry, { ...entry, snippet: trimmed }));
        break;
      }
    }
    return clamped;
  }

  protected diversifyResultsBySource(
    results: MemorySearchResult[],
    limit: number,
  ): MemorySearchResult[] {
    const target = Math.max(0, limit);
    if (target <= 0) {
      return [];
    }
    if (results.length <= 1) {
      return results.slice(0, target);
    }
    const bySource = new Map<MemorySource, MemorySearchResult[]>();
    for (const entry of results) {
      const list = bySource.get(entry.source) ?? [];
      list.push(entry);
      bySource.set(entry.source, list);
    }
    if (!bySource.has("sessions") || !bySource.has("memory")) {
      return results.slice(0, target);
    }
    const sourceOrder = Array.from(bySource.entries())
      .toSorted((a, b) => (b[1][0]?.score ?? 0) - (a[1][0]?.score ?? 0))
      .map(([source]) => source);
    const diversified: MemorySearchResult[] = [];
    while (diversified.length < target) {
      let emitted = false;
      for (const source of sourceOrder) {
        const next = bySource.get(source)?.shift();
        if (!next) {
          continue;
        }
        diversified.push(next);
        emitted = true;
        if (diversified.length >= target) {
          break;
        }
      }
      if (!emitted) {
        break;
      }
    }
    return diversified;
  }

  protected async waitForPendingUpdateBeforeSearch(): Promise<void> {
    const pending = this.pendingUpdate;
    if (!pending) {
      return;
    }
    // Release the losing timer when the pending update settles first.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, SEARCH_PENDING_UPDATE_WAIT_MS);
    });
    await Promise.race([pending.catch(() => undefined), wait]).finally(() => clearTimeout(timeout));
  }

  protected async resolveCollectionSearchGroups(
    collectionNames: string[],
    signal?: AbortSignal,
    debugContext?: QmdSearchRuntimeDebugContext,
  ): Promise<string[][]> {
    if (collectionNames.length <= 1) {
      return [collectionNames];
    }
    if (!(await this.supportsQmdMultiCollectionFilters(signal, debugContext))) {
      return collectionNames.map((collectionName) => [collectionName]);
    }
    return this.groupCollectionNamesBySource(collectionNames);
  }

  protected async supportsQmdMultiCollectionFilters(
    signal?: AbortSignal,
    debugContext?: QmdSearchRuntimeDebugContext,
  ): Promise<boolean> {
    if (signal?.aborted) {
      throw asQmdAbortError(signal);
    }
    if (this.multiCollectionFilterSupported !== null) {
      return this.multiCollectionFilterSupported;
    }
    const startedAt = Date.now();
    const cacheContext = await this.buildQmdMultiCollectionProbeCacheContext();
    const cached = await readQmdMultiCollectionProbeCache(cacheContext);
    if (cached.state === "hit") {
      this.multiCollectionFilterSupported = cached.value.multiCollectionProbe.supported;
      if (debugContext) {
        debugContext.multiCollectionProbe = {
          cacheState: "hit",
          elapsedMs: Math.max(0, Date.now() - startedAt),
          supported: this.multiCollectionFilterSupported,
        };
      }
      return this.multiCollectionFilterSupported;
    }
    try {
      const result = await this.runQmd(["--help"], {
        timeoutMs: Math.min(this.qmd.limits.timeoutMs, 5_000),
        signal,
      });
      const helpText = `${result.stdout}\n${result.stderr}`;
      this.multiCollectionFilterSupported =
        /\b(?:one or more collections|collection\(s\)|multiple -c flags)\b/i.test(helpText);
      const wroteCache = await writeQmdMultiCollectionProbeCache(
        cacheContext,
        this.multiCollectionFilterSupported,
      );
      if (debugContext) {
        debugContext.multiCollectionProbe = {
          cacheState: wroteCache ? "write" : "error",
          elapsedMs: Math.max(0, Date.now() - startedAt),
          supported: this.multiCollectionFilterSupported,
        };
      }
    } catch (err) {
      // Cancellation says nothing about QMD capabilities; leave the probe uncached.
      if (signal?.aborted) {
        throw asQmdAbortError(signal);
      }
      this.multiCollectionFilterSupported = false;
      if (debugContext) {
        debugContext.multiCollectionProbe = {
          cacheState: "error",
          elapsedMs: Math.max(0, Date.now() - startedAt),
          supported: false,
        };
      }
      qmdManagerLog.debug(`qmd multi-collection filter probe failed: ${String(err)}`);
    }
    return this.multiCollectionFilterSupported;
  }

  protected async markQmdMultiCollectionFiltersUnsupported(
    debugContext: QmdSearchRuntimeDebugContext,
  ): Promise<void> {
    const startedAt = Date.now();
    const cacheContext = await this.buildQmdMultiCollectionProbeCacheContext();
    this.multiCollectionFilterSupported = false;
    await clearQmdMultiCollectionProbeCache(cacheContext);
    const wroteCache = await writeQmdMultiCollectionProbeCache(cacheContext, false);
    debugContext.multiCollectionProbe = {
      cacheState: wroteCache ? "write" : "error",
      elapsedMs: Math.max(0, Date.now() - startedAt),
      supported: false,
    };
  }

  protected async runQueryAcrossCollectionGroups(
    query: string,
    limit: number,
    collectionGroups: string[][],
    command: "query" | "search" | "vsearch",
    signal?: AbortSignal,
    reportCommandPhase?: QmdCommandPhaseReporter,
  ): Promise<QmdQueryResult[]> {
    qmdManagerLog.debug(
      `qmd ${command} multi-source collection grouping active (${collectionGroups.length} groups)`,
    );
    const bestByResultKey = new Map<string, QmdQueryResult>();
    for (const collectionNames of collectionGroups) {
      const args = this.buildSearchArgs(command, query, limit);
      args.push(...this.buildCollectionFilterArgs(collectionNames));
      const parsed = await this.runQmdSearch(args, command, signal, reportCommandPhase);
      for (const entry of parsed) {
        const defaultCollection = collectionNames.length === 1 ? collectionNames[0] : undefined;
        const normalizedHints = this.normalizeDocHints({
          preferredCollection: entry.collection ?? defaultCollection,
          preferredFile: entry.file,
        });
        const normalizedDocId =
          typeof entry.docid === "string" && entry.docid.trim().length > 0
            ? entry.docid
            : undefined;
        const withCollection = {
          ...entry,
          docid: normalizedDocId,
          collection: normalizedHints.preferredCollection ?? entry.collection ?? defaultCollection,
          file: normalizedHints.preferredFile ?? entry.file,
        } satisfies QmdQueryResult;
        const resultKey = this.buildQmdResultKey(withCollection);
        if (!resultKey) {
          continue;
        }
        const prev = bestByResultKey.get(resultKey);
        const prevScore = typeof prev?.score === "number" ? prev.score : Number.NEGATIVE_INFINITY;
        const nextScore =
          typeof withCollection.score === "number"
            ? withCollection.score
            : Number.NEGATIVE_INFINITY;
        if (!prev || nextScore > prevScore) {
          bestByResultKey.set(resultKey, withCollection);
        }
      }
    }
    return [...bestByResultKey.values()].toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  protected groupCollectionNamesBySource(collectionNames: string[]): string[][] {
    const groups = new Map<string, string[]>();
    for (const collectionName of collectionNames) {
      const source = this.collectionRoots.get(collectionName)?.kind ?? collectionName;
      const group = groups.get(source) ?? [];
      group.push(collectionName);
      groups.set(source, group);
    }
    return [...groups.values()];
  }

  protected buildQmdResultKey(entry: QmdQueryResult): string | null {
    if (typeof entry.docid === "string" && entry.docid.trim().length > 0) {
      return `docid:${entry.docid}`;
    }
    const hints = this.normalizeDocHints({
      preferredCollection: entry.collection,
      preferredFile: entry.file,
    });
    if (!hints.preferredCollection || !hints.preferredFile) {
      return null;
    }
    const collectionRelativePath = this.toCollectionRelativePath(
      hints.preferredCollection,
      hints.preferredFile,
    );
    return collectionRelativePath
      ? `file:${hints.preferredCollection}:${collectionRelativePath}`
      : null;
  }

  protected listManagedCollectionNames(sources?: MemorySource[]): string[] {
    if (!sources?.length) {
      return this.managedCollectionNames;
    }
    const allowed = new Set(sources);
    return this.managedCollectionNames.filter((name) => {
      const source = this.collectionRoots.get(name)?.kind;
      return source ? allowed.has(source) : false;
    });
  }

  protected buildCollectionFilterArgs(collectionNames: string[]): string[] {
    return collectionNames.filter(Boolean).flatMap((name) => ["-c", name]);
  }

  protected buildSearchArgs(
    command: "query" | "search" | "vsearch",
    query: string,
    limit: number,
  ): string[] {
    const normalizedQuery = command === "search" ? normalizeHanBm25Query(query) : query;
    if (command === "query") {
      const args = ["query", normalizedQuery, "--json", "-n", String(limit)];
      if (this.qmd.searchMode === "query" && this.qmd.rerank === false) {
        args.push("--no-rerank");
      }
      return args;
    }
    return [command, normalizedQuery, "--json", "-n", String(limit)];
  }

  protected isUnsupportedQmdOptionError(err: unknown): boolean {
    return isUnsupportedQmdOptionError(err);
  }
}
