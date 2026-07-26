// Memory Core plugin module implements tools behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  MemoryReadResult,
  MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  asToolParamsRecord,
  jsonResult,
  readFiniteNumberParam,
  readPositiveIntegerParam,
  readStringParam,
  resolveMemoryDreamingPluginConfig,
  resolveMemorySearchConfig,
  type MemoryCorpusSearchResult,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type {
  MemorySearchResult,
  MemorySearchRuntimeDebug,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import { asRecord } from "./dreaming-shared.js";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
import {
  DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
  MEMORY_SEARCH_DEADLINE_CONTROL,
  resolveMemorySearchAbortError,
  runMemorySearchWithDeadline,
  type MemorySearchDeadlineAction,
  type MemorySearchDeadlineControlOptions,
} from "./memory/search-deadline.js";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import {
  clampResultsByInjectedChars,
  decorateCitations,
  resolveMemoryCitationsMode,
  shouldIncludeCitations,
} from "./tools.citations.js";
import {
  buildMemorySearchUnavailableResult,
  createMemoryTool,
  getMemoryCorpusSupplementResult,
  getMemoryManagerContextWithPurpose,
  loadMemoryToolRuntime,
  MemoryGetSchema,
  MemorySearchSchema,
  searchMemoryCorpusSupplements,
} from "./tools.shared.js";

type MemorySearchToolResult =
  | (MemorySearchResult & { corpus: MemorySource })
  | MemoryCorpusSearchResult;
type MemoryManagerContext = Awaited<ReturnType<typeof getMemoryManagerContextWithPurpose>>;
type ActiveMemoryManagerContext = Extract<MemoryManagerContext, { manager: unknown }>;
type MemoryManagerSearchOptions = NonNullable<
  Parameters<ActiveMemoryManagerContext["manager"]["search"]>[1]
> &
  MemorySearchDeadlineControlOptions;
type QmdRuntimeDebug = NonNullable<MemorySearchRuntimeDebug["qmd"]>;

const MEMORY_SEARCH_TOOL_COOLDOWN_MS = 60_000;

const memorySearchToolCooldowns = new Map<string, { until: number; error: string }>();

/**
 * Validate the model-authored corpus argument against the tool's closed enum.
 * Provider tool schemas do not guarantee enum enforcement; an unknown corpus
 * must fail closed instead of falling through to an unrestricted search that
 * could surface recall-only indexed transcripts.
 */
function readCorpusParam<T extends string>(
  rawParams: Record<string, unknown>,
  allowed: readonly T[],
): T | undefined {
  const raw = readStringParam(rawParams, "corpus");
  if (raw === undefined) {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }
  throw new Error(`corpus must be one of: ${allowed.join(", ")}`);
}

function mergeQmdRuntimeDebug(
  entries: readonly MemorySearchRuntimeDebug[],
): MemorySearchRuntimeDebug["qmd"] | undefined {
  const merged: QmdRuntimeDebug = {};
  for (const entry of entries) {
    const qmd = entry.qmd;
    if (!qmd) {
      continue;
    }
    if (!merged.collectionValidation && qmd.collectionValidation) {
      merged.collectionValidation = qmd.collectionValidation;
    }
    if (qmd.multiCollectionProbe) {
      merged.multiCollectionProbe = qmd.multiCollectionProbe;
    }
    if (qmd.searchPlan) {
      merged.searchPlan = qmd.searchPlan;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function resolveMemorySearchToolCooldownKey(options: {
  agentId?: string;
  agentSessionKey?: string;
}): string {
  return options.agentId ?? options.agentSessionKey ?? "default";
}

function readMemorySearchToolCooldown(key: string): { error: string } | undefined {
  const entry = memorySearchToolCooldowns.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.until <= Date.now()) {
    memorySearchToolCooldowns.delete(key);
    return undefined;
  }
  return { error: entry.error };
}

function recordMemorySearchToolCooldown(key: string, error: string): void {
  memorySearchToolCooldowns.set(key, {
    until: Date.now() + MEMORY_SEARCH_TOOL_COOLDOWN_MS,
    error,
  });
}

export const testing = {
  resetMemorySearchToolCooldowns() {
    memorySearchToolCooldowns.clear();
  },
} as const;

function isActiveMemoryManagerContext(
  context: MemoryManagerContext | null,
): context is ActiveMemoryManagerContext {
  return context !== null && "manager" in context;
}

async function closeMemoryManagers(
  managers: Iterable<ActiveMemoryManagerContext["manager"]>,
  parentSignal?: AbortSignal,
): Promise<void> {
  const pending = Array.from(managers, async (manager) => await manager.close?.());
  if (pending.length === 0) {
    return;
  }
  try {
    await runMemorySearchWithDeadline({
      timeoutMs: DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
      parentSignal,
      run: async () => {
        await Promise.allSettled(pending);
      },
    });
  } catch {
    // Search results should not be hidden by best-effort transient cleanup.
  }
}

const PAUSED_MEMORY_INDEX_WARNING =
  "Tell the user: memory search is paused because the memory index was built with a different embedding provider/model/settings.";
const PAUSED_MEMORY_INDEX_ACTION =
  "Tell the user to run: openclaw memory status --index or openclaw memory index --force.";

function resolvePausedMemoryIndexIdentityReason(status: { custom?: unknown }): string | undefined {
  const indexIdentity = asRecord(asRecord(status.custom)?.indexIdentity);
  if (indexIdentity?.status !== "mismatched" && indexIdentity?.status !== "missing") {
    return undefined;
  }
  return typeof indexIdentity.reason === "string" && indexIdentity.reason.trim()
    ? indexIdentity.reason.trim()
    : "memory index identity is missing or mismatched";
}

function buildPausedMemoryIndexUnavailableResult(reason: string) {
  return buildMemorySearchUnavailableResult(reason, {
    warning: PAUSED_MEMORY_INDEX_WARNING,
    action: PAUSED_MEMORY_INDEX_ACTION,
  });
}

function mergeRankedMemorySearchToolStreams(
  memoryResults: MemorySearchToolResult[],
  supplementResults: MemorySearchToolResult[],
): MemorySearchToolResult[] {
  const merged: MemorySearchToolResult[] = [];
  let memoryIndex = 0;
  let supplementIndex = 0;
  // Each backend owns its ranking. Memory scores intentionally omit some
  // precedence facts, so compare only stream heads and never reorder a stream.
  while (memoryIndex < memoryResults.length && supplementIndex < supplementResults.length) {
    const memory = memoryResults[memoryIndex];
    const supplement = supplementResults[supplementIndex];
    if ((memory?.score ?? 0) >= (supplement?.score ?? 0)) {
      if (memory) {
        merged.push(memory);
      }
      memoryIndex += 1;
    } else {
      if (supplement) {
        merged.push(supplement);
      }
      supplementIndex += 1;
    }
  }
  merged.push(...memoryResults.slice(memoryIndex), ...supplementResults.slice(supplementIndex));
  return merged;
}

function mergeMemorySearchCorpusResults(params: {
  memoryResults: MemorySearchToolResult[];
  supplementResults: MemorySearchToolResult[];
  maxResults: number;
  balanceCorpora: boolean;
}): MemorySearchToolResult[] {
  const memoryResults = params.memoryResults;
  const supplementResults = params.supplementResults;
  if (!params.balanceCorpora || memoryResults.length === 0 || supplementResults.length === 0) {
    return mergeRankedMemorySearchToolStreams(memoryResults, supplementResults).slice(
      0,
      params.maxResults,
    );
  }

  const perCorpusCap = Math.ceil(params.maxResults / 2);
  let memoryTake = Math.min(perCorpusCap, memoryResults.length);
  let supplementTake = Math.min(perCorpusCap, supplementResults.length);
  while (memoryTake + supplementTake < params.maxResults) {
    const memory = memoryResults[memoryTake];
    const supplement = supplementResults[supplementTake];
    if (!memory && !supplement) {
      break;
    }
    if (!supplement || (memory && memory.score >= supplement.score)) {
      memoryTake += 1;
    } else {
      supplementTake += 1;
    }
  }

  return mergeRankedMemorySearchToolStreams(
    memoryResults.slice(0, memoryTake),
    supplementResults.slice(0, supplementTake),
  ).slice(0, params.maxResults);
}

function isClosedMemoryStoreError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes("database is not open") ||
    message.includes("database connection is not open") ||
    message.includes("database handle is closed") ||
    message.includes("memory search manager is closed")
  );
}

function buildRecallKey(
  result: Pick<MemorySearchResult, "source" | "path" | "startLine" | "endLine">,
): string {
  return `${result.source}:${result.path}:${result.startLine}:${result.endLine}`;
}

function resolveRecallTrackingResults(
  rawResults: MemorySearchResult[],
  surfacedResults: MemorySearchResult[],
): MemorySearchResult[] {
  if (surfacedResults.length === 0 || rawResults.length === 0) {
    return surfacedResults;
  }
  const rawByKey = new Map<string, MemorySearchResult>();
  for (const raw of rawResults) {
    const key = buildRecallKey(raw);
    if (!rawByKey.has(key)) {
      rawByKey.set(key, raw);
    }
  }
  return surfacedResults.map((surfaced) => rawByKey.get(buildRecallKey(surfaced)) ?? surfaced);
}

function queueShortTermRecallTracking(params: {
  workspaceDir?: string;
  query: string;
  rawResults: MemorySearchResult[];
  surfacedResults: MemorySearchResult[];
  timezone?: string;
}): void {
  const trackingResults = resolveRecallTrackingResults(params.rawResults, params.surfacedResults);
  void recordShortTermRecalls({
    workspaceDir: params.workspaceDir,
    query: params.query,
    results: trackingResults,
    timezone: params.timezone,
  }).catch(() => {
    // Recall tracking is best-effort and must never block memory recall.
  });
}

function normalizeActiveMemoryQmdSearchMode(
  value: unknown,
): "inherit" | "search" | "vsearch" | "query" {
  return value === "inherit" || value === "search" || value === "vsearch" || value === "query"
    ? value
    : "search";
}

function isActiveMemorySessionKey(sessionKey?: string): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":active-memory:");
}

function resolveActiveMemoryQmdSearchModeOverride(
  cfg: OpenClawConfig,
  sessionKey?: string,
): "search" | "vsearch" | "query" | undefined {
  if (!isActiveMemorySessionKey(sessionKey)) {
    return undefined;
  }
  const entry = cfg.plugins?.entries?.["active-memory"];
  const entryRecord =
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as { config?: unknown })
      : undefined;
  const pluginConfig =
    entryRecord?.config &&
    typeof entryRecord.config === "object" &&
    !Array.isArray(entryRecord.config)
      ? (entryRecord.config as { qmd?: { searchMode?: unknown } })
      : undefined;
  const searchMode = normalizeActiveMemoryQmdSearchMode(pluginConfig?.qmd?.searchMode);
  return searchMode === "inherit" ? undefined : searchMode;
}

async function getSupplementMemoryReadResult(params: {
  relPath: string;
  from?: number;
  lines?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  corpus?: "memory" | "wiki" | "all";
}) {
  const supplement = await getMemoryCorpusSupplementResult({
    lookup: params.relPath,
    fromLine: params.from,
    lineCount: params.lines,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    corpus: params.corpus,
  });
  if (!supplement) {
    return null;
  }
  const { content, ...rest } = supplement;
  return {
    ...rest,
    text: content,
  };
}

async function resolveMemoryReadFailureResult(params: {
  error: unknown;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}) {
  if (params.requestedCorpus === "all") {
    try {
      const supplement = await getSupplementMemoryReadResult({
        relPath: params.relPath,
        from: params.from,
        lines: params.lines,
        agentId: params.agentId,
        agentSessionKey: params.agentSessionKey,
        sandboxed: params.sandboxed,
        corpus: params.requestedCorpus,
      });
      if (supplement) {
        return jsonResult(supplement);
      }
    } catch {
      // Supplement lookup is best-effort after the primary memory read failed.
      // Preserve the original structured error instead of rejecting the tool call.
    }
  }
  const message = formatErrorMessage(params.error);
  return jsonResult({ path: params.relPath, text: "", disabled: true, error: message });
}

function isMissingMemoryReadResult(result: MemoryReadResult, relPath: string): boolean {
  return result.path === relPath && result.text === "" && result.from === undefined;
}

async function executeMemoryReadResult(params: {
  read: () => Promise<MemoryReadResult>;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}) {
  try {
    const result = await params.read();
    if (params.requestedCorpus === "all" && isMissingMemoryReadResult(result, params.relPath)) {
      const supplement = await getSupplementMemoryReadResult({
        relPath: params.relPath,
        from: params.from,
        lines: params.lines,
        agentId: params.agentId,
        agentSessionKey: params.agentSessionKey,
        sandboxed: params.sandboxed,
        corpus: params.requestedCorpus,
      });
      if (supplement) {
        return jsonResult(supplement);
      }
    }
    return jsonResult(result);
  } catch (error) {
    return await resolveMemoryReadFailureResult({
      error,
      requestedCorpus: params.requestedCorpus,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
      agentId: params.agentId,
      agentSessionKey: params.agentSessionKey,
      sandboxed: params.sandboxed,
    });
  }
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  oneShotCliRun?: boolean;
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
  acquireLocalService?: MemoryCoreAcquireLocalService;
  withLease?: PluginStateLeaseRunner;
}) {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos. Optional `corpus=wiki` or `corpus=all` also searches registered compiled-wiki supplements. `corpus=memory` restricts hits to indexed memory files (excludes session transcript chunks from ranking). `corpus=sessions` restricts hits to indexed session transcripts (same visibility rules as session history tools). If response has disabled=true, memory retrieval is unavailable; you must tell the user and include the warning/action guidance.",
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params, callerSignal) => {
        const rawParams = asToolParamsRecord(params);
        if (callerSignal?.aborted) {
          throw resolveMemorySearchAbortError(callerSignal);
        }
        const query = readStringParam(rawParams, "query", { required: true });
        const maxResults = readPositiveIntegerParam(rawParams, "maxResults");
        const minScore = readFiniteNumberParam(rawParams, "minScore");
        const modelRequestedCorpus = readCorpusParam(rawParams, [
          "memory",
          "wiki",
          "all",
          "sessions",
        ]);
        // The trusted runtime chooses the recall corpus; model-authored arguments cannot broaden it.
        const requestedCorpus =
          options.conversationRecall?.corpus === "sessions" ? "sessions" : modelRequestedCorpus;
        const cooldownKey = resolveMemorySearchToolCooldownKey({
          agentId,
          agentSessionKey: options.agentSessionKey,
        });
        const cooldown =
          requestedCorpus === "wiki" ? undefined : readMemorySearchToolCooldown(cooldownKey);
        let activeUnavailablePhase: "memory" | "supplement" | undefined;
        let failedUnavailablePhase: "memory" | "supplement" | undefined;
        const runUnavailablePhase = async <T>(
          phase: "memory" | "supplement",
          task: () => Promise<T>,
        ): Promise<T> => {
          activeUnavailablePhase = phase;
          try {
            return await task();
          } catch (error) {
            failedUnavailablePhase = phase;
            throw error;
          } finally {
            if (activeUnavailablePhase === phase) {
              activeUnavailablePhase = undefined;
            }
          }
        };
        const runWithDefaultDeadline = async <T>(
          task: (
            signal: AbortSignal,
            controlDeadline: (action: MemorySearchDeadlineAction) => void,
          ) => Promise<T>,
        ): Promise<T> =>
          await runMemorySearchWithDeadline({
            timeoutMs: DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
            parentSignal: callerSignal,
            run: task,
          });
        const runMemorySearchTool = async () => {
          const toolStartedAt = Date.now();
          const shouldQuerySupplements = requestedCorpus === "wiki" || requestedCorpus === "all";
          const shouldQueryMemory = requestedCorpus !== "wiki" && !cooldown;
          if (cooldown && !shouldQuerySupplements) {
            return jsonResult(buildMemorySearchUnavailableResult(cooldown.error));
          }
          const memoryManagerPurpose = options.oneShotCliRun ? "cli" : undefined;
          const memoryManagersToClose = new Set<ActiveMemoryManagerContext["manager"]>();
          let cleanupStarted = false;
          const trackMemoryManager = (context: MemoryManagerContext): MemoryManagerContext => {
            if (memoryManagerPurpose === "cli" && isActiveMemoryManagerContext(context)) {
              if (cleanupStarted) {
                // Setup can settle after its deadline. Close that late transient
                // manager instead of leaking it after the tool has returned.
                void closeMemoryManagers([context.manager]);
              } else {
                memoryManagersToClose.add(context.manager);
              }
            }
            return context;
          };
          try {
            const memorySetup = shouldQueryMemory
              ? await runUnavailablePhase(
                  "memory",
                  async () =>
                    await runWithDefaultDeadline(async () => {
                      const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
                      const resolvedMemoryBackend = resolveMemoryBackendConfig({ cfg, agentId });
                      const context = trackMemoryManager(
                        await getMemoryManagerContextWithPurpose({
                          cfg,
                          agentId,
                          purpose: memoryManagerPurpose,
                          acquireLocalService: options.acquireLocalService,
                          withLease: options.withLease,
                        }),
                      );
                      return { context, resolvedMemoryBackend };
                    }),
                )
              : null;
            const memory = memorySetup?.context ?? null;
            if (shouldQueryMemory && memory && "error" in memory && !shouldQuerySupplements) {
              recordMemorySearchToolCooldown(
                cooldownKey,
                memory.error ?? "memory search unavailable",
              );
              return jsonResult(buildMemorySearchUnavailableResult(memory.error));
            }

            const citationsMode = resolveMemoryCitationsMode(cfg);
            const includeCitations = shouldIncludeCitations({
              mode: citationsMode,
              sessionKey: options.agentSessionKey,
            });
            const pluginConfig = resolveMemoryDreamingPluginConfig(cfg);
            const dreamingEnabled = resolveMemoryDreamingConfig({
              pluginConfig,
              cfg,
            }).enabled;
            const dreaming = resolveMemoryDeepDreamingConfig({
              pluginConfig,
              cfg,
            });
            const searchStartedAt = Date.now();
            let rawResults: MemorySearchResult[] = [];
            let surfacedMemoryResults: Array<MemorySearchResult & { corpus: MemorySource }> = [];
            let provider: string | undefined;
            let model: string | undefined;
            let fallback: unknown;
            let searchMode: string | undefined;
            let pausedIndexIdentityReason: string | undefined;
            let managerMs: number | undefined;
            let managerCacheState: string | undefined;
            let searchDebug:
              | {
                  backend: string;
                  configuredMode?: string;
                  effectiveMode?: string;
                  fallback?: string;
                  toolMs?: number;
                  managerMs?: number;
                  outsideSearchMs?: number;
                  searchMs: number;
                  managerCacheState?: string;
                  qmd?: MemorySearchRuntimeDebug["qmd"];
                  hits: number;
                }
              | undefined;
            if (shouldQueryMemory && memorySetup && memory && !("error" in memory)) {
              await runUnavailablePhase("memory", async () => {
                let activeMemory = memory;
                const runtimeDebug: MemorySearchRuntimeDebug[] = [];
                const qmdSearchModeOverride = resolveActiveMemoryQmdSearchModeOverride(
                  cfg,
                  options.agentSessionKey,
                );
                const memorySearchConfig = resolveMemorySearchConfig(cfg, agentId);
                const defaultSearchSources = memorySearchConfig?.searchSources;
                const trustedConfiguredRecall = options.conversationRecall?.corpus === "configured";
                const effectiveSearchSources = trustedConfiguredRecall
                  ? memorySearchConfig?.sources
                  : defaultSearchSources;
                const trustedTranscriptRecall = options.conversationRecall !== undefined;
                const configuredSessionSearch = defaultSearchSources?.includes("sessions") === true;
                // Product recall may index transcripts without adding them to ordinary model search.
                // Only trusted recall or explicit configuration may search those indexed transcripts.
                const searchSources: MemorySource[] | undefined =
                  requestedCorpus === "sessions"
                    ? trustedTranscriptRecall || configuredSessionSearch
                      ? (["sessions"] as MemorySource[])
                      : defaultSearchSources
                    : requestedCorpus === "memory"
                      ? (["memory"] as MemorySource[])
                      : requestedCorpus == null || requestedCorpus === "all"
                        ? effectiveSearchSources
                        : undefined;
                const createSearchOptions = (
                  signal: AbortSignal,
                  controlDeadline: (action: MemorySearchDeadlineAction) => void,
                ) =>
                  ({
                    maxResults,
                    minScore,
                    sessionKey: options.agentSessionKey,
                    qmdSearchModeOverride,
                    signal,
                    onDebug: (debug: MemorySearchRuntimeDebug) => {
                      runtimeDebug.push(debug);
                    },
                    [MEMORY_SEARCH_DEADLINE_CONTROL]: controlDeadline,
                    ...(searchSources ? { sources: searchSources } : {}),
                  }) satisfies MemoryManagerSearchOptions;
                const searchActiveMemory = async (): Promise<MemorySearchResult[]> =>
                  await runWithDefaultDeadline(
                    async (signal, controlDeadline) =>
                      await activeMemory.manager.search(
                        query,
                        createSearchOptions(signal, controlDeadline),
                      ),
                  );
                managerMs = memory.debug?.managerMs;
                managerCacheState = memory.debug?.managerCacheState;
                try {
                  rawResults = await searchActiveMemory();
                } catch (error) {
                  if (!isClosedMemoryStoreError(error)) {
                    throw error;
                  }
                  const refreshed = await runWithDefaultDeadline(async () =>
                    trackMemoryManager(
                      await getMemoryManagerContextWithPurpose({
                        cfg,
                        agentId,
                        purpose: memoryManagerPurpose,
                        acquireLocalService: options.acquireLocalService,
                        withLease: options.withLease,
                      }),
                    ),
                  );
                  if ("error" in refreshed) {
                    throw error;
                  }
                  managerMs = refreshed.debug?.managerMs;
                  managerCacheState = refreshed.debug?.managerCacheState;
                  activeMemory = refreshed;
                  rawResults = await searchActiveMemory();
                }
                const statusBeforeRetry = activeMemory.manager.status();
                pausedIndexIdentityReason =
                  resolvePausedMemoryIndexIdentityReason(statusBeforeRetry);
                if (pausedIndexIdentityReason) {
                  return;
                }
                // One-shot CLI managers have no background lifecycle, so keep their bootstrap
                // retry. Long-lived QMD managers must not run update work in the tool hot path.
                if (
                  rawResults.length === 0 &&
                  activeMemory.manager.sync &&
                  (statusBeforeRetry.backend !== "qmd" || options.oneShotCliRun === true)
                ) {
                  await runWithDefaultDeadline(async () => {
                    // Sync may join shared/background manager maintenance and has
                    // no request-cancellation contract. Bound only this tool's wait.
                    await activeMemory.manager.sync?.({ reason: "search", force: true });
                  });
                  rawResults = await searchActiveMemory();
                  pausedIndexIdentityReason = resolvePausedMemoryIndexIdentityReason(
                    activeMemory.manager.status(),
                  );
                  if (pausedIndexIdentityReason) {
                    return;
                  }
                }
                rawResults = await runWithDefaultDeadline(
                  async () =>
                    await filterMemorySearchHitsBySessionVisibility({
                      cfg,
                      agentId,
                      requesterSessionKey: options.agentSessionKey,
                      sandboxed: options.sandboxed === true,
                      hits: rawResults,
                      conversationRecall: options.conversationRecall,
                    }),
                );
                if (searchSources) {
                  const allowedSources = new Set<MemorySource>(searchSources);
                  rawResults = rawResults.filter((hit) => allowedSources.has(hit.source));
                }
                if (requestedCorpus === "sessions") {
                  rawResults = rawResults.filter((hit) => hit.source === "sessions");
                } else if (requestedCorpus === "memory") {
                  rawResults = rawResults.filter((hit) => hit.source === "memory");
                }
                const status = activeMemory.manager.status();
                const decorated = decorateCitations(rawResults, includeCitations);
                const memoryResults =
                  status.backend === "qmd"
                    ? clampResultsByInjectedChars(
                        decorated,
                        memorySetup.resolvedMemoryBackend.qmd?.limits.maxInjectedChars,
                      )
                    : decorated;
                surfacedMemoryResults = memoryResults.map((result) => ({
                  ...result,
                  corpus: result.source,
                }));
                if (dreamingEnabled) {
                  queueShortTermRecallTracking({
                    workspaceDir: status.workspaceDir,
                    query,
                    rawResults,
                    surfacedResults: memoryResults,
                    timezone: dreaming.timezone,
                  });
                }
                provider = status.provider;
                model = status.model;
                fallback = status.fallback;
                const latestDebug = runtimeDebug.at(-1);
                const qmdDebug = mergeQmdRuntimeDebug(runtimeDebug);
                searchMode = latestDebug?.effectiveMode;
                const searchMs = Math.max(0, Date.now() - searchStartedAt);
                searchDebug = {
                  backend: status.backend,
                  configuredMode: latestDebug?.configuredMode,
                  effectiveMode:
                    status.backend === "qmd"
                      ? (latestDebug?.effectiveMode ?? latestDebug?.configuredMode)
                      : "n/a",
                  fallback: latestDebug?.fallback,
                  managerMs,
                  searchMs,
                  managerCacheState,
                  qmd: qmdDebug,
                  hits: rawResults.length,
                };
              });
              if (pausedIndexIdentityReason) {
                return jsonResult(
                  buildPausedMemoryIndexUnavailableResult(pausedIndexIdentityReason),
                );
              }
            }
            const supplementResults = shouldQuerySupplements
              ? await runUnavailablePhase(
                  "supplement",
                  async () =>
                    await runWithDefaultDeadline(
                      async () =>
                        await searchMemoryCorpusSupplements({
                          query,
                          maxResults,
                          agentId,
                          agentSessionKey: options.agentSessionKey,
                          sandboxed: options.sandboxed,
                          corpus: requestedCorpus,
                        }),
                    ),
                )
              : [];
            // Wiki and memory scores use incomparable scales, so corpus=all first
            // balances candidate selection and then backfills any unused slots.
            const effectiveMax = Math.max(1, maxResults ?? 10);
            const results = mergeMemorySearchCorpusResults({
              memoryResults: surfacedMemoryResults,
              supplementResults,
              maxResults: effectiveMax,
              balanceCorpora: requestedCorpus === "all",
            });
            if (searchDebug) {
              const finalToolMs = Math.max(0, Date.now() - toolStartedAt);
              searchDebug = {
                ...searchDebug,
                toolMs: finalToolMs,
                outsideSearchMs: Math.max(0, finalToolMs - searchDebug.searchMs),
              };
            }
            return jsonResult({
              results,
              provider,
              model,
              fallback,
              citations: citationsMode,
              mode: searchMode,
              debug: searchDebug,
            });
          } finally {
            cleanupStarted = true;
            await closeMemoryManagers(memoryManagersToClose, callerSignal);
          }
        };
        try {
          const result = await runMemorySearchTool();
          if (callerSignal?.aborted) {
            throw resolveMemorySearchAbortError(callerSignal);
          }
          return result;
        } catch (error) {
          if (callerSignal?.aborted) {
            throw resolveMemorySearchAbortError(callerSignal);
          }
          const unavailablePhase = failedUnavailablePhase ?? activeUnavailablePhase;
          const shouldRecordCooldown =
            requestedCorpus !== "wiki" &&
            (requestedCorpus !== "all" || unavailablePhase === "memory");
          const message = formatErrorMessage(error);
          if (shouldRecordCooldown) {
            recordMemorySearchToolCooldown(cooldownKey, message);
          }
          return jsonResult(buildMemorySearchUnavailableResult(message));
        }
      },
  });
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  withLease?: PluginStateLeaseRunner;
}) {
  return createMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe exact excerpt read from MEMORY.md or memory/*.md. Defaults to a bounded excerpt when lines are omitted, includes truncation/continuation info when more content exists, and `corpus=wiki` reads from registered compiled-wiki supplements.",
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const relPath = readStringParam(rawParams, "path", { required: true });
        const from = readPositiveIntegerParam(rawParams, "from");
        const lines = readPositiveIntegerParam(rawParams, "lines");
        const requestedCorpus = readCorpusParam(rawParams, ["memory", "wiki", "all"]);
        const { readAgentMemoryFile, resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        if (requestedCorpus === "wiki") {
          const supplement = await getSupplementMemoryReadResult({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentId,
            agentSessionKey: options.agentSessionKey,
            sandboxed: options.sandboxed,
            corpus: requestedCorpus,
          });
          return jsonResult(
            supplement ?? {
              path: relPath,
              text: "",
              disabled: true,
              error: "wiki corpus result not found",
            },
          );
        }
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        if (resolved.backend === "builtin") {
          return await executeMemoryReadResult({
            read: async () =>
              await readAgentMemoryFile({
                cfg,
                agentId,
                relPath,
                from: from ?? undefined,
                lines: lines ?? undefined,
              }),
            requestedCorpus,
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentId,
            agentSessionKey: options.agentSessionKey,
            sandboxed: options.sandboxed,
          });
        }
        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "status",
          acquireLocalService: options.acquireLocalService,
          withLease: options.withLease,
        });
        if ("error" in memory) {
          return jsonResult({ path: relPath, text: "", disabled: true, error: memory.error });
        }
        return await executeMemoryReadResult({
          read: async () =>
            await memory.manager.readFile({
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            }),
          requestedCorpus,
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
          agentId,
          agentSessionKey: options.agentSessionKey,
          sandboxed: options.sandboxed,
        });
      },
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
