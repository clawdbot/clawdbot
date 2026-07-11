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
  type MemoryCorpusSearchResult,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type {
  MemorySearchResult,
  MemorySearchRuntimeDebug,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryCorePluginConfig,
  resolveMemoryDreamingConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { asRecord } from "./dreaming-shared.js";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
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
type QmdRuntimeDebug = NonNullable<MemorySearchRuntimeDebug["qmd"]>;

const MEMORY_SEARCH_TOOL_TIMEOUT_MS = 15_000;
const MEMORY_SEARCH_TOOL_COOLDOWN_MS = 60_000;

const memorySearchToolCooldowns = new Map<string, { until: number; error: string }>();

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
): Promise<void> {
  for (const manager of managers) {
    try {
      await manager.close?.();
    } catch {
      // Search results should not be hidden by best-effort transient cleanup.
    }
  }
}

async function runMemorySearchToolWithDeadline<T>(params: {
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<{ status: "ok"; value: T } | { status: "unavailable"; error: string }> {
  const timeoutError = () =>
    new Error(`memory_search timed out after ${Math.round(params.timeoutMs / 1000)}s`);
  // Abort the losing task when the deadline fires so in-flight embedding work
  // is cancelled instead of retrying orphaned for minutes after the tool
  // already returned "timed out" to the agent.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      // Resolve before aborting: abort listeners run synchronously and an
      // abort-aware search could reject the task first, replacing the stable
      // timeout result with a provider-wrapped abort error.
      resolve("timeout");
      controller.abort(timeoutError());
    }, params.timeoutMs);
    timer.unref?.();
  });
  const task = params.run(controller.signal);
  task.catch(() => undefined);

  try {
    const result = await Promise.race([task, timeoutPromise]);
    if (result === "timeout") {
      return {
        status: "unavailable",
        error: timeoutError().message,
      };
    }
    return { status: "ok", value: result as T };
  } catch (error) {
    return { status: "unavailable", error: formatErrorMessage(error) };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
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
  acquireLocalService?: MemoryCoreAcquireLocalService;
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
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const query = readStringParam(rawParams, "query", { required: true });
        const maxResults = readPositiveIntegerParam(rawParams, "maxResults");
        const minScore = readFiniteNumberParam(rawParams, "minScore");
        const requestedCorpus = readStringParam(rawParams, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | "sessions"
          | undefined;
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

        const outcome = await runMemorySearchToolWithDeadline({
          timeoutMs: MEMORY_SEARCH_TOOL_TIMEOUT_MS,
          run: async (deadlineSignal) => {
            const toolStartedAt = Date.now();
            const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
            const shouldQuerySupplements = requestedCorpus === "wiki" || requestedCorpus === "all";
            const shouldQueryMemory = requestedCorpus !== "wiki" && !cooldown;
            if (cooldown && !shouldQuerySupplements) {
              return jsonResult(buildMemorySearchUnavailableResult(cooldown.error));
            }
            const memoryManagerPurpose = options.oneShotCliRun ? "cli" : undefined;
            const memoryManagersToClose = new Set<ActiveMemoryManagerContext["manager"]>();
            const trackMemoryManager = (context: MemoryManagerContext): MemoryManagerContext => {
              if (memoryManagerPurpose === "cli" && isActiveMemoryManagerContext(context)) {
                memoryManagersToClose.add(context.manager);
              }
              return context;
            };
            try {
              const memory = shouldQueryMemory
                ? await runUnavailablePhase("memory", async () =>
                    trackMemoryManager(
                      await getMemoryManagerContextWithPurpose({
                        cfg,
                        agentId,
                        purpose: memoryManagerPurpose,
                        acquireLocalService: options.acquireLocalService,
                      }),
                    ),
                  )
                : null;
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
              const pluginConfig = resolveMemoryCorePluginConfig(cfg);
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
              if (shouldQueryMemory && memory && !("error" in memory)) {
                await runUnavailablePhase("memory", async () => {
                  let activeMemory = memory;
                  const runtimeDebug: MemorySearchRuntimeDebug[] = [];
                  const qmdSearchModeOverride = resolveActiveMemoryQmdSearchModeOverride(
                    cfg,
                    options.agentSessionKey,
                  );
                  const searchSources: MemorySource[] | undefined =
                    requestedCorpus === "sessions"
                      ? (["sessions"] as MemorySource[])
                      : requestedCorpus === "memory"
                        ? (["memory"] as MemorySource[])
                        : undefined;
                  const searchOptions = {
                    maxResults,
                    minScore,
                    sessionKey: options.agentSessionKey,
                    qmdSearchModeOverride,
                    signal: deadlineSignal,
                    onDebug: (debug: MemorySearchRuntimeDebug) => {
                      runtimeDebug.push(debug);
                    },
                    ...(searchSources ? { sources: searchSources } : {}),
                  };
                  managerMs = memory.debug?.managerMs;
                  managerCacheState = memory.debug?.managerCacheState;
                  try {
                    rawResults = await activeMemory.manager.search(query, searchOptions);
                  } catch (error) {
                    if (!isClosedMemoryStoreError(error)) {
                      throw error;
                    }
                    const refreshed = trackMemoryManager(
                      await getMemoryManagerContextWithPurpose({
                        cfg,
                        agentId,
                        purpose: memoryManagerPurpose,
                        acquireLocalService: options.acquireLocalService,
                      }),
                    );
                    if ("error" in refreshed) {
                      throw error;
                    }
                    managerMs = refreshed.debug?.managerMs;
                    managerCacheState = refreshed.debug?.managerCacheState;
                    activeMemory = refreshed;
                    rawResults = await activeMemory.manager.search(query, searchOptions);
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
                    await activeMemory.manager.sync({ reason: "search", force: true });
                    rawResults = await activeMemory.manager.search(query, searchOptions);
                    pausedIndexIdentityReason = resolvePausedMemoryIndexIdentityReason(
                      activeMemory.manager.status(),
                    );
                    if (pausedIndexIdentityReason) {
                      return;
                    }
                  }
                  rawResults = await filterMemorySearchHitsBySessionVisibility({
                    cfg,
                    agentId,
                    requesterSessionKey: options.agentSessionKey,
                    sandboxed: options.sandboxed === true,
                    hits: rawResults,
                  });
                  if (requestedCorpus === "sessions") {
                    rawResults = rawResults.filter((hit) => hit.source === "sessions");
                  } else if (requestedCorpus === "memory") {
                    rawResults = rawResults.filter((hit) => hit.source === "memory");
                  }
                  const status = activeMemory.manager.status();
                  const decorated = decorateCitations(rawResults, includeCitations);
                  const resolved = resolveMemoryBackendConfig({ cfg, agentId });
                  const memoryResults =
                    status.backend === "qmd"
                      ? clampResultsByInjectedChars(
                          decorated,
                          resolved.qmd?.limits.maxInjectedChars,
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
                      await searchMemoryCorpusSupplements({
                        query,
                        maxResults,
                        agentId,
                        agentSessionKey: options.agentSessionKey,
                        sandboxed: options.sandboxed,
                        corpus: requestedCorpus,
                      }),
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
              await closeMemoryManagers(memoryManagersToClose);
            }
          },
        });
        if (outcome.status === "unavailable") {
          const unavailablePhase = failedUnavailablePhase ?? activeUnavailablePhase;
          const shouldRecordCooldown =
            requestedCorpus !== "wiki" &&
            (requestedCorpus !== "all" || unavailablePhase === "memory");
          if (shouldRecordCooldown) {
            recordMemorySearchToolCooldown(cooldownKey, outcome.error);
          }
          return jsonResult(buildMemorySearchUnavailableResult(outcome.error));
        }
        return outcome.value;
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
        const requestedCorpus = readStringParam(rawParams, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | undefined;
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
