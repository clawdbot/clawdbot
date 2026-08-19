// Memory Core plugin module implements tools behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveMemorySearchStaleness,
  stripMemoryAnnotationCarriers,
  type MemoryReadResult,
  type MemorySource,
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
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildPausedMemoryIndexUnavailableResult,
  executeMemorySearchToolQuery,
} from "./memory-search-tool-query.js";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
import {
  DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
  resolveMemorySearchAbortError,
  runMemorySearchWithDeadline,
} from "./memory/search-deadline.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import {
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
type MemorySearchToolQueryDebug = NonNullable<
  Awaited<ReturnType<typeof executeMemorySearchToolQuery>>["debug"]
>;

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
    // Gateway tool calls are latency-sensitive and live in a long-running
    // process, so background best-effort tracking is safe here unlike in the CLI.
  });
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
  activeProjectKeys?: readonly string[];
  acquireLocalService?: MemoryCoreAcquireLocalService;
}) {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos. Optional `corpus=wiki` or `corpus=all` also searches registered compiled-wiki supplements. `corpus=memory` restricts hits to indexed memory files (excludes session transcript chunks from ranking). `corpus=sessions` restricts hits to indexed session transcripts (same visibility rules as session history tools). If response has disabled=true or stale=true, you must tell the user and include the warning/action guidance.",
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
          task: (signal: AbortSignal) => Promise<T>,
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
                      const context = trackMemoryManager(
                        await getMemoryManagerContextWithPurpose({
                          cfg,
                          agentId,
                          purpose: memoryManagerPurpose,
                          acquireLocalService: options.acquireLocalService,
                        }),
                      );
                      return { context };
                    }),
                )
              : null;
            const memory = memorySetup?.context ?? null;
            let memoryCorpusUnavailable: string | undefined;
            if (shouldQueryMemory && memory && "error" in memory) {
              recordMemorySearchToolCooldown(
                cooldownKey,
                memory.error ?? "memory search unavailable",
              );
              if (!shouldQuerySupplements) {
                return jsonResult(buildMemorySearchUnavailableResult(memory.error));
              }
              // corpus=all still serves wiki supplements, but the omitted memory
              // corpus must be recorded or the degraded search reads as complete.
              memoryCorpusUnavailable = memory.error ?? "memory search unavailable";
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
            let rawResults: MemorySearchResult[] = [];
            let surfacedMemoryResults: Array<MemorySearchResult & { corpus: MemorySource }> = [];
            let provider: string | undefined, model: string | undefined;
            let fallback: unknown;
            let searchMode: string | undefined, pausedIndexIdentityReason: string | undefined;
            let staleness:
              | Exclude<ReturnType<typeof resolveMemorySearchStaleness>, null>
              | undefined;
            let searchDebug:
              | (MemorySearchToolQueryDebug & { toolMs?: number; outsideSearchMs?: number })
              | undefined;
            if (shouldQueryMemory && memorySetup && memory && !("error" in memory)) {
              await runUnavailablePhase("memory", async () => {
                const memorySearchConfig = resolveMemorySearchConfig(cfg, agentId);
                const defaultSearchSources = memorySearchConfig?.searchSources;
                const explicitSearchSources: MemorySource[] | undefined =
                  requestedCorpus === "sessions" &&
                  (options.conversationRecall || defaultSearchSources?.includes("sessions"))
                    ? (["sessions"] as MemorySource[])
                    : requestedCorpus === "memory"
                      ? (["memory"] as MemorySource[])
                      : undefined;
                const resultLimit = maxResults ?? memorySearchConfig?.query.maxResults ?? 10;
                const executed = await executeMemorySearchToolQuery({
                  initialManager: {
                    manager: memory.manager,
                    managerMs: memory.debug?.managerMs,
                  },
                  refreshManager: async () => {
                    const refreshed = await runWithDefaultDeadline(async () =>
                      trackMemoryManager(
                        await getMemoryManagerContextWithPurpose({
                          cfg,
                          agentId,
                          purpose: memoryManagerPurpose,
                          acquireLocalService: options.acquireLocalService,
                        }),
                      ),
                    );
                    if ("error" in refreshed) {
                      return null;
                    }
                    return {
                      manager: refreshed.manager,
                      managerMs: refreshed.debug?.managerMs,
                    };
                  },
                  query: {
                    text: query,
                    resultLimit,
                    minScore,
                    explicitSources: explicitSearchSources,
                    defaultSources: defaultSearchSources,
                    indexedSources: memorySearchConfig?.sources,
                    requestedCorpus,
                    sessionKey: options.agentSessionKey,
                    activeProjectKeys: options.activeProjectKeys,
                    conversationRecall: options.conversationRecall,
                  },
                  visibility: {
                    cfg,
                    agentId,
                    sandboxed: options.sandboxed === true,
                  },
                  runWithDeadline: runWithDefaultDeadline,
                });
                pausedIndexIdentityReason = executed.pausedIndexIdentityReason;
                if (pausedIndexIdentityReason) {
                  return;
                }
                rawResults = executed.rawResults;
                const status = executed.status;
                staleness = resolveMemorySearchStaleness(status, agentId) ?? undefined;
                const payloadResults = rawResults.map((result) => ({
                  ...result,
                  snippet: stripMemoryAnnotationCarriers(result.snippet),
                }));
                const decorated = decorateCitations(payloadResults, includeCitations);
                const memoryResults = decorated;
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
                searchMode = executed.searchMode;
                searchDebug = executed.debug;
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
              ...(memoryCorpusUnavailable
                ? {
                    warning: `Memory corpus unavailable; results cover wiki supplements only: ${memoryCorpusUnavailable}`,
                  }
                : {}),
              ...staleness,
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
        const { readAgentMemoryFile } = await loadMemoryToolRuntime();
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
      },
  });
}
