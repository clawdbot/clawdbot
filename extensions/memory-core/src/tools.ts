import {
  resolveMemorySearchStaleness,
  stripMemoryAnnotationCarriers,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  asToolParamsRecord,
  jsonResult,
  readFiniteNumberParam,
  readPositiveIntegerParam,
  readStringParam,
  resolveMemoryDreamingPluginConfig,
  resolveRuntimeConfigCacheKey,
  type MemoryCorpusSearchResult,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { resolveMemoryDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import {
  attemptMemoryCorpus,
  composeMemoryCorpusMetadata,
  runMemoryCorpusDeadline,
  searchMemoryCorpusSupplements,
  unavailableMemoryCorpus,
  type MemoryCorpusAttempt,
  type MemoryCorpusFailure,
} from "./memory-corpus.js";
import { executeMemoryReadResult, executeWikiMemoryReadResult } from "./memory-read-tool.js";
import {
  buildPausedMemoryIndexUnavailableResult,
  executeMemorySearchToolQuery,
} from "./memory-search-tool-query.js";
import {
  MEMORY_GET_TOOL_CONTRACT,
  MEMORY_SEARCH_TOOL_CONTRACT,
  type MemoryToolOptions,
} from "./memory-tool-contract.js";
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
  getMemoryManagerContextWithPurpose,
  loadMemoryToolRuntime,
} from "./tools.shared.js";

type MemorySearchToolResult = MemorySearchResult | MemoryCorpusSearchResult;
type MemoryManagerContext = Awaited<ReturnType<typeof getMemoryManagerContextWithPurpose>>;
type ActiveMemoryManagerContext = Extract<MemoryManagerContext, { manager: unknown }>;
type MemorySearchToolQueryDebug = NonNullable<
  Awaited<ReturnType<typeof executeMemorySearchToolQuery>>["debug"]
>;
type PrimaryMemorySearchValue = {
  results: MemorySearchResult[];
  workspaceDir?: string;
  provider?: string;
  model?: string;
  fallback?: unknown;
  mode?: string;
  staleness?: Exclude<ReturnType<typeof resolveMemorySearchStaleness>, null>;
  debug?: MemorySearchToolQueryDebug & { toolMs?: number; outsideSearchMs?: number };
  unavailableResult?: ReturnType<typeof buildPausedMemoryIndexUnavailableResult>;
};

const MEMORY_SEARCH_TOOL_COOLDOWN_MS = 60_000;

const memorySearchToolCooldowns = new Map<
  string,
  MemoryCorpusFailure & { until: number; configKey: string }
>();

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

function readMemorySearchToolCooldown(
  key: string,
  cfg: OpenClawConfig,
): MemoryCorpusFailure | undefined {
  const entry = memorySearchToolCooldowns.get(key);
  if (!entry) {
    return undefined;
  }
  // Failed searches pause retries only for the configuration that produced them.
  if (entry.until <= Date.now() || entry.configKey !== resolveRuntimeConfigCacheKey(cfg)) {
    memorySearchToolCooldowns.delete(key);
    return undefined;
  }
  return {
    error: entry.error,
    deadline: entry.deadline,
    ...(entry.code ? { code: entry.code } : {}),
  };
}

function recordMemorySearchToolCooldown(
  key: string,
  cfg: OpenClawConfig,
  failure: MemoryCorpusFailure,
): void {
  memorySearchToolCooldowns.set(key, {
    until: Date.now() + MEMORY_SEARCH_TOOL_COOLDOWN_MS,
    configKey: resolveRuntimeConfigCacheKey(cfg),
    ...failure,
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
  } catch (error) {
    if (parentSignal?.aborted) {
      throw error;
    }
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
  const { memoryResults, supplementResults } = params;
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

export function createMemorySearchTool(options: MemoryToolOptions) {
  return createMemoryTool({
    options,
    contract: MEMORY_SEARCH_TOOL_CONTRACT,
    execute:
      ({ cfg, agentId, settings }) =>
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
        if (
          requestedCorpus === "sessions" &&
          !options.conversationRecall &&
          !settings.searchSources.includes("sessions")
        ) {
          return jsonResult(
            buildMemorySearchUnavailableResult("Session transcript search is not enabled.", {
              warning: "Session transcript search is unavailable for this agent.",
              action:
                'Enable memory.search.experimental.sessionMemory and add "sessions" to memory.search.sources, then retry memory_search.',
            }),
          );
        }
        const cooldown =
          requestedCorpus === "wiki" ? undefined : readMemorySearchToolCooldown(agentId, cfg);
        const toolStartedAt = Date.now();
        const searchesMemory = requestedCorpus !== "wiki";
        const searchesWiki = requestedCorpus === "wiki" || requestedCorpus === "all";
        const memoryManagerPurpose = options.oneShotCliRun ? "cli" : undefined;
        const memoryManagersToClose = new Set<ActiveMemoryManagerContext["manager"]>();
        let cleanupStarted = false;
        let searchSignal: AbortSignal | undefined;
        const trackMemoryManager = (context: MemoryManagerContext): MemoryManagerContext => {
          if (memoryManagerPurpose === "cli" && isActiveMemoryManagerContext(context)) {
            if (cleanupStarted) {
              void closeMemoryManagers([context.manager]);
            } else {
              memoryManagersToClose.add(context.manager);
            }
          }
          return context;
        };
        const searchMemory = async (
          signal: AbortSignal,
        ): Promise<MemoryCorpusAttempt<PrimaryMemorySearchValue | null>> => {
          if (cooldown) {
            return { corpus: "memory", outcome: "unavailable", value: null, ...cooldown };
          }
          let partial: Awaited<ReturnType<typeof executeMemorySearchToolQuery>> | null = null;
          let acceptingPartial = true;
          const attempted = await attemptMemoryCorpus<Awaited<
            ReturnType<typeof executeMemorySearchToolQuery>
          > | null>({
            corpus: "memory",
            signal,
            unavailableValue: null,
            getPartialValue: () => (partial?.rawResults.length ? partial : null),
            run: async () => {
              const memory = trackMemoryManager(
                await getMemoryManagerContextWithPurpose({
                  cfg,
                  agentId,
                  purpose: memoryManagerPurpose,
                  acquireLocalService: options.acquireLocalService,
                }),
              );
              if ("error" in memory) {
                throw new Error(memory.error ?? "memory search unavailable");
              }
              signal.throwIfAborted();
              const explicitSources: MemorySource[] | undefined =
                requestedCorpus === "sessions" &&
                (options.conversationRecall || settings.searchSources.includes("sessions"))
                  ? ["sessions"]
                  : requestedCorpus === "memory"
                    ? ["memory"]
                    : undefined;
              return await executeMemorySearchToolQuery({
                initialManager: { manager: memory.manager, managerMs: memory.debug?.managerMs },
                refreshManager: async () => {
                  const refreshed = trackMemoryManager(
                    await getMemoryManagerContextWithPurpose({
                      cfg,
                      agentId,
                      purpose: memoryManagerPurpose,
                      acquireLocalService: options.acquireLocalService,
                    }),
                  );
                  return "error" in refreshed
                    ? null
                    : { manager: refreshed.manager, managerMs: refreshed.debug?.managerMs };
                },
                query: {
                  text: query,
                  resultLimit: maxResults ?? settings.query.maxResults,
                  minScore,
                  explicitSources,
                  defaultSources: settings.searchSources,
                  indexedSources: settings.sources,
                  requestedCorpus,
                  sessionKey: options.agentSessionKey,
                  activeProjectKeys: options.activeProjectKeys,
                  conversationRecall: options.conversationRecall,
                },
                visibility: { cfg, agentId, sandboxed: options.sandboxed === true },
                signal,
                onPartialResults: (result) => {
                  if (acceptingPartial) {
                    partial = result;
                  }
                },
              });
            },
          });
          acceptingPartial = false;
          if (attempted.outcome !== "ok" && attempted.outcome !== "partial") {
            if (callerSignal?.aborted) {
              throw resolveMemorySearchAbortError(callerSignal);
            }
            const failure: MemoryCorpusFailure =
              attempted.outcome === "unavailable"
                ? {
                    error: attempted.error,
                    deadline: attempted.deadline,
                    ...(attempted.code ? { code: attempted.code } : {}),
                  }
                : { error: "memory search unavailable", deadline: false };
            recordMemorySearchToolCooldown(agentId, cfg, failure);
            return { corpus: "memory", outcome: "unavailable", value: null, ...failure };
          }
          const executed = attempted.value!;
          if (executed.pausedIndexIdentity) {
            return unavailableMemoryCorpus(
              "memory",
              {
                results: [],
                unavailableResult: buildPausedMemoryIndexUnavailableResult(
                  executed.pausedIndexIdentity,
                  { agentId, status: executed.status },
                ),
              },
              executed.pausedIndexIdentity.reason,
            );
          }
          const status = executed.status;
          return {
            ...attempted,
            value: {
              results: executed.rawResults,
              workspaceDir: status.workspaceDir,
              provider: status.provider,
              model: status.model,
              fallback: status.fallback,
              mode: executed.searchMode,
              staleness: resolveMemorySearchStaleness(status, agentId) ?? undefined,
              debug:
                attempted.outcome === "partial" && executed.debug
                  ? {
                      ...executed.debug,
                      searchMs: Math.max(0, Date.now() - executed.searchStartedAt),
                      fallback: attempted.error,
                    }
                  : executed.debug,
            },
          };
        };
        try {
          return await runMemoryCorpusDeadline({
            operation: "memory_search",
            parentSignal: callerSignal,
            run: async (signal) => {
              searchSignal = signal;
              const [memory, wiki] = await Promise.all([
                searchesMemory ? searchMemory(signal) : Promise.resolve(null),
                searchesWiki
                  ? searchMemoryCorpusSupplements({
                      query,
                      maxResults,
                      agentId,
                      agentSessionKey: options.agentSessionKey,
                      sandboxed: options.sandboxed,
                      signal,
                    })
                  : Promise.resolve(null),
              ]);
              const memoryValue = memory?.outcome === "not-registered" ? null : memory?.value;
              if (searchesMemory && !searchesWiki && memory?.outcome === "unavailable") {
                return jsonResult(
                  memoryValue?.unavailableResult ??
                    buildMemorySearchUnavailableResult(memory.error, {
                      agentId,
                      deadline: memory.deadline,
                      code: memory.code,
                    }),
                );
              }
              const wikiResults = wiki?.outcome === "not-registered" ? [] : (wiki?.value ?? []);
              // Primary results already own their configured limit; only wiki/all need aggregation.
              const results = searchesWiki
                ? mergeMemorySearchCorpusResults({
                    memoryResults: memoryValue?.results ?? [],
                    supplementResults: wikiResults,
                    maxResults: maxResults ?? 10,
                    balanceCorpora: requestedCorpus === "all",
                  })
                : (memoryValue?.results ?? []);
              // Preserve primary object identity through blending: only evidence
              // actually returned to the model earns a recall signal.
              const surfaced = new Set(results);
              const recalled = (memoryValue?.results ?? []).filter((result) =>
                surfaced.has(result),
              );
              const citationsMode = resolveMemoryCitationsMode(cfg);
              const decorated = decorateCitations(
                recalled.map((result) => ({
                  ...result,
                  corpus: result.source,
                  snippet: stripMemoryAnnotationCarriers(result.snippet),
                })),
                shouldIncludeCitations({
                  mode: citationsMode,
                  sessionKey: options.agentSessionKey,
                }),
              );
              const presentation = new Map<MemorySearchToolResult, MemorySearchResult>(
                recalled.map((result, index) => [result, decorated[index]!]),
              );
              const dreaming = resolveMemoryDreamingConfig({
                pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
                cfg,
              });
              if ((memory?.outcome === "ok" || memory?.outcome === "partial") && dreaming.enabled) {
                void recordShortTermRecalls({
                  workspaceDir: memoryValue?.workspaceDir,
                  query,
                  results: recalled,
                  timezone: dreaming.timezone,
                }).catch(() => {
                  // Gateway recall persistence stays off the reply latency path.
                });
              }
              const attempts = [
                ...((requestedCorpus === "all" || memory?.outcome === "partial") && memory
                  ? [memory]
                  : []),
                ...(wiki ? [wiki] : []),
              ];
              const staleness = memoryValue?.staleness;
              const recoveryAction = memoryValue?.unavailableResult?.action;
              const metadata = composeMemoryCorpusMetadata(attempts, [
                ...(staleness?.warning ? [staleness.warning] : []),
                ...(memory?.outcome === "partial"
                  ? [
                      "Only memory-file keyword matches are included; semantic memory retrieval did not finish within the search time limit. Session transcript results are not included.",
                    ]
                  : []),
              ]);
              const elapsed = Math.max(0, Date.now() - toolStartedAt);
              const debug = memoryValue?.debug
                ? {
                    ...memoryValue.debug,
                    toolMs: elapsed,
                    outsideSearchMs: Math.max(0, elapsed - memoryValue.debug.searchMs),
                  }
                : undefined;
              return jsonResult({
                results: results.map((result) => presentation.get(result) ?? result),
                provider: memoryValue?.provider,
                model: memoryValue?.model,
                fallback: memoryValue?.fallback,
                citations: citationsMode,
                mode: memoryValue?.mode,
                ...staleness,
                ...(attempts.length > 0 ? metadata : {}),
                ...(memory?.outcome === "partial" ? { partial: true } : {}),
                // Another corpus can succeed while primary memory still needs repair.
                ...(recoveryAction ? { action: recoveryAction } : {}),
                debug,
              });
            },
          });
        } catch (error) {
          if (callerSignal?.aborted) {
            throw resolveMemorySearchAbortError(callerSignal);
          }
          const failed = unavailableMemoryCorpus("memory", null, error);
          if (requestedCorpus !== "wiki") {
            recordMemorySearchToolCooldown(agentId, cfg, failed);
          }
          return jsonResult(
            buildMemorySearchUnavailableResult(failed.error, {
              agentId,
              deadline: failed.deadline,
              code: failed.code,
            }),
          );
        } finally {
          cleanupStarted = true;
          if (searchSignal?.aborted) {
            // Admitted searches retain their leases until they settle; teardown
            // must not add another cleanup timeout to an already expired reply.
            void closeMemoryManagers(memoryManagersToClose);
          } else {
            await closeMemoryManagers(memoryManagersToClose, callerSignal);
          }
        }
      },
  });
}

export function createMemoryGetTool(options: MemoryToolOptions) {
  return createMemoryTool({
    options,
    contract: MEMORY_GET_TOOL_CONTRACT,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params, callerSignal) => {
        const rawParams = asToolParamsRecord(params);
        const relPath = readStringParam(rawParams, "path", { required: true });
        const from = readPositiveIntegerParam(rawParams, "from");
        const lines = readPositiveIntegerParam(rawParams, "lines");
        const requestedCorpus = readCorpusParam(rawParams, ["memory", "wiki", "all"]);
        const { readAgentMemoryFile } = await loadMemoryToolRuntime();
        if (requestedCorpus === "wiki") {
          return await executeWikiMemoryReadResult({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentId,
            agentSessionKey: options.agentSessionKey,
            sandboxed: options.sandboxed,
            requestedCorpus,
            signal: callerSignal,
          });
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
          signal: callerSignal,
        });
      },
  });
}
