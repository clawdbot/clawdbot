// Memory Core plugin module implements tools behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
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
  resolveMemorySearchConfig,
  type MemoryCorpusSearchResult,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import {
  attemptMemoryCorpus,
  composeMemoryCorpusMetadata,
  runMemoryCorpusDeadline,
  searchMemoryCorpusSupplements,
  unavailableMemoryCorpus,
  type MemoryCorpusAttempt,
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

type MemorySearchToolResult =
  | (MemorySearchResult & { corpus: MemorySource })
  | MemoryCorpusSearchResult;
type MemoryManagerContext = Awaited<ReturnType<typeof getMemoryManagerContextWithPurpose>>;
type ActiveMemoryManagerContext = Extract<MemoryManagerContext, { manager: unknown }>;
type MemorySearchToolQueryDebug = NonNullable<
  Awaited<ReturnType<typeof executeMemorySearchToolQuery>>["debug"]
>;
type PrimaryMemorySearchValue = {
  results: Array<MemorySearchResult & { corpus: MemorySource }>;
  rawResults: MemorySearchResult[];
  provider?: string;
  model?: string;
  fallback?: unknown;
  mode?: string;
  staleness?: Exclude<ReturnType<typeof resolveMemorySearchStaleness>, null>;
  debug?: MemorySearchToolQueryDebug & { toolMs?: number; outsideSearchMs?: number };
  unavailableResult?: ReturnType<typeof buildPausedMemoryIndexUnavailableResult>;
};

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

export function createMemorySearchTool(options: MemoryToolOptions) {
  return createMemoryTool({
    options,
    contract: MEMORY_SEARCH_TOOL_CONTRACT,
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
        if (
          requestedCorpus === "sessions" &&
          !options.conversationRecall &&
          !resolveMemorySearchConfig(cfg, agentId)?.searchSources.includes("sessions")
        ) {
          return jsonResult(
            buildMemorySearchUnavailableResult("Session transcript search is not enabled.", {
              warning: "Session transcript search is unavailable for this agent.",
              action:
                'Enable memory.search.experimental.sessionMemory and add "sessions" to memory.search.sources, then retry memory_search.',
            }),
          );
        }
        const cooldownKey = resolveMemorySearchToolCooldownKey({
          agentId,
          agentSessionKey: options.agentSessionKey,
        });
        const cooldown =
          requestedCorpus === "wiki" ? undefined : readMemorySearchToolCooldown(cooldownKey);
        const toolStartedAt = Date.now();
        const searchesMemory = requestedCorpus !== "wiki";
        const searchesWiki = requestedCorpus === "wiki" || requestedCorpus === "all";
        const memoryManagerPurpose = options.oneShotCliRun ? "cli" : undefined;
        const memoryManagersToClose = new Set<ActiveMemoryManagerContext["manager"]>();
        let cleanupStarted = false;
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
            return unavailableMemoryCorpus("memory", null, cooldown.error);
          }
          const attempted = await attemptMemoryCorpus<Awaited<
            ReturnType<typeof executeMemorySearchToolQuery>
          > | null>({
            corpus: "memory",
            signal,
            unavailableValue: null,
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
              const settings = resolveMemorySearchConfig(cfg, agentId);
              const defaultSources = settings?.searchSources;
              const explicitSources: MemorySource[] | undefined =
                requestedCorpus === "sessions" &&
                (options.conversationRecall || defaultSources?.includes("sessions"))
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
                  resultLimit: maxResults ?? settings?.query.maxResults ?? 10,
                  minScore,
                  explicitSources,
                  defaultSources,
                  indexedSources: settings?.sources,
                  requestedCorpus,
                  sessionKey: options.agentSessionKey,
                  activeProjectKeys: options.activeProjectKeys,
                  conversationRecall: options.conversationRecall,
                },
                visibility: { cfg, agentId, sandboxed: options.sandboxed === true },
                signal,
              });
            },
          });
          if (attempted.outcome !== "ok") {
            if (callerSignal?.aborted) {
              throw resolveMemorySearchAbortError(callerSignal);
            }
            const error =
              attempted.outcome === "unavailable" ? attempted.error : "memory search unavailable";
            recordMemorySearchToolCooldown(cooldownKey, error);
            return unavailableMemoryCorpus("memory", null, error);
          }
          const executed = attempted.value!;
          if (executed.pausedIndexIdentityReason) {
            const reason = executed.pausedIndexIdentityReason;
            return unavailableMemoryCorpus(
              "memory",
              {
                results: [],
                rawResults: [],
                unavailableResult: buildPausedMemoryIndexUnavailableResult(reason),
              },
              reason,
            );
          }
          const citationsMode = resolveMemoryCitationsMode(cfg);
          const includeCitations = shouldIncludeCitations({
            mode: citationsMode,
            sessionKey: options.agentSessionKey,
          });
          const rawResults = executed.rawResults;
          const memoryResults = decorateCitations(
            rawResults.map((result) => ({
              ...result,
              snippet: stripMemoryAnnotationCarriers(result.snippet),
            })),
            includeCitations,
          );
          const status = executed.status;
          if (
            resolveMemoryDreamingConfig({
              pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
              cfg,
            }).enabled
          ) {
            queueShortTermRecallTracking({
              workspaceDir: status.workspaceDir,
              query,
              rawResults,
              surfacedResults: memoryResults,
              timezone: resolveMemoryDeepDreamingConfig({
                pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
                cfg,
              }).timezone,
            });
          }
          return {
            corpus: "memory",
            outcome: "ok",
            value: {
              results: memoryResults.map((result) =>
                Object.assign(result, { corpus: result.source }),
              ),
              rawResults,
              provider: status.provider,
              model: status.model,
              fallback: status.fallback,
              mode: executed.searchMode,
              staleness: resolveMemorySearchStaleness(status, agentId) ?? undefined,
              debug: executed.debug,
            },
          };
        };
        try {
          return await runMemoryCorpusDeadline({
            operation: "memory_search",
            parentSignal: callerSignal,
            run: async (signal) => {
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
                    buildMemorySearchUnavailableResult(memory.error),
                );
              }
              const wikiResults = wiki?.outcome === "not-registered" ? [] : (wiki?.value ?? []);
              const results = mergeMemorySearchCorpusResults({
                memoryResults: memoryValue?.results ?? [],
                supplementResults: wikiResults,
                maxResults: Math.max(1, maxResults ?? 10),
                balanceCorpora: requestedCorpus === "all",
              });
              const attempts = [
                ...(requestedCorpus === "all" && memory ? [memory] : []),
                ...(wiki ? [wiki] : []),
              ];
              const staleness = memoryValue?.staleness;
              const metadata = composeMemoryCorpusMetadata(
                attempts,
                staleness?.warning ? [staleness.warning] : [],
              );
              const elapsed = Math.max(0, Date.now() - toolStartedAt);
              const debug = memoryValue?.debug
                ? {
                    ...memoryValue.debug,
                    toolMs: elapsed,
                    outsideSearchMs: Math.max(0, elapsed - memoryValue.debug.searchMs),
                  }
                : undefined;
              return jsonResult({
                results,
                provider: memoryValue?.provider,
                model: memoryValue?.model,
                fallback: memoryValue?.fallback,
                citations: resolveMemoryCitationsMode(cfg),
                mode: memoryValue?.mode,
                ...(attempts.length > 0 ? metadata : {}),
                ...staleness,
                debug,
              });
            },
          });
        } catch (error) {
          if (callerSignal?.aborted) {
            throw resolveMemorySearchAbortError(callerSignal);
          }
          const message = formatErrorMessage(error);
          if (requestedCorpus !== "wiki") {
            recordMemorySearchToolCooldown(cooldownKey, message);
          }
          return jsonResult(buildMemorySearchUnavailableResult(message));
        } finally {
          cleanupStarted = true;
          await closeMemoryManagers(memoryManagersToClose, callerSignal);
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
