import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
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
  getMemoryManagerContext,
  getMemoryManagerContextWithPurpose,
  loadMemoryToolRuntime,
  MemoryGetSchema,
  MemorySearchSchema,
  searchMemoryCorpusSupplements,
} from "./tools.shared.js";

type MemorySearchToolResult =
  | (MemorySearchResult & { corpus: MemorySource })
  | MemoryCorpusSearchResult;

const MEMORY_SEARCH_TOOL_TIMEOUT_MS = 15_000;
const MEMORY_SEARCH_TOOL_COOLDOWN_MS = 60_000;

const memorySearchToolCooldowns = new Map<string, { until: number; error: string }>();

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

async function runMemorySearchToolWithDeadline<T>(params: {
  timeoutMs: number;
  run: () => Promise<T>;
}): Promise<{ status: "ok"; value: T } | { status: "unavailable"; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), params.timeoutMs);
    timer.unref?.();
  });
  const task = params.run();
  task.catch(() => undefined);

  try {
    const result = await Promise.race([task, timeoutPromise]);
    if (result === "timeout") {
      return {
        status: "unavailable",
        error: `memory_search timed out after ${Math.round(params.timeoutMs / 1000)}s`,
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

function sortMemorySearchToolResults<T extends { score: number; path: string }>(results: T[]): T[] {
  return results.toSorted((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  });
}

function mergeMemorySearchCorpusResults(params: {
  memoryResults: MemorySearchToolResult[];
  supplementResults: MemorySearchToolResult[];
  maxResults: number;
  balanceCorpora: boolean;
}): MemorySearchToolResult[] {
  const memoryResults = sortMemorySearchToolResults(params.memoryResults);
  const supplementResults = sortMemorySearchToolResults(params.supplementResults);
  if (!params.balanceCorpora || memoryResults.length === 0 || supplementResults.length === 0) {
    return sortMemorySearchToolResults([...memoryResults, ...supplementResults]).slice(
      0,
      params.maxResults,
    );
  }

  const perCorpusCap = Math.ceil(params.maxResults / 2);
  const selectedMemory = memoryResults.slice(0, perCorpusCap);
  const selectedSupplements = supplementResults.slice(0, perCorpusCap);
  const selected = [...selectedMemory, ...selectedSupplements];
  if (selected.length < params.maxResults) {
    selected.push(
      ...sortMemorySearchToolResults([
        ...memoryResults.slice(selectedMemory.length),
        ...supplementResults.slice(selectedSupplements.length),
      ]).slice(0, params.maxResults - selected.length),
    );
  }

  return sortMemorySearchToolResults(selected).slice(0, params.maxResults);
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
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all";
}) {
  const supplement = await getMemoryCorpusSupplementResult({
    lookup: params.relPath,
    fromLine: params.from,
    lineCount: params.lines,
    agentSessionKey: params.agentSessionKey,
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
  agentSessionKey?: string;
}) {
  if (params.requestedCorpus === "all") {
    const supplement = await getSupplementMemoryReadResult({
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
      agentSessionKey: params.agentSessionKey,
      corpus: params.requestedCorpus,
    });
    if (supplement) {
      return jsonResult(supplement);
    }
  }
  const message = formatErrorMessage(params.error);
  return jsonResult({ path: params.relPath, text: "", disabled: true, error: message });
}

async function executeMemoryReadResult<T>(params: {
  read: () => Promise<T>;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
}) {
  try {
    return jsonResult(await params.read());
  } catch (error) {
    return await resolveMemoryReadFailureResult({
      error,
      requestedCorpus: params.requestedCorpus,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
      agentSessionKey: params.agentSessionKey,
    });
  }
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}) {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos. Optional `corpus=wiki` or `corpus=all` also searches registered compiled-wiki supplements. `corpus=memory` restricts hits to indexed memory files (excludes session transcript chunks from ranking). `corpus=sessions` restricts hits to indexed session transcripts (same visibility rules as session history tools). If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
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
          run: async () => {
            const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
            const shouldQuerySupplements = requestedCorpus === "wiki" || requestedCorpus === "all";
            const shouldQueryMemory = requestedCorpus !== "wiki" && !cooldown;
            if (cooldown && !shouldQuerySupplements) {
              return jsonResult(buildMemorySearchUnavailableResult(cooldown.error));
            }
            const memory = shouldQueryMemory
              ? await runUnavailablePhase(
                  "memory",
                  async () => await getMemoryManagerContext({ cfg, agentId }),
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
            let searchDebug:
              | {
                  backend: string;
                  configuredMode?: string;
                  effectiveMode?: string;
                  fallback?: string;
                  searchMs: number;
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
                  onDebug: (debug: MemorySearchRuntimeDebug) => {
                    runtimeDebug.push(debug);
                  },
                  ...(searchSources ? { sources: searchSources } : {}),
                };
                try {
                  rawResults = await activeMemory.manager.search(query, searchOptions);
                } catch (error) {
                  if (!isClosedMemoryStoreError(error)) {
                    throw error;
                  }
                  const refreshed = await getMemoryManagerContext({ cfg, agentId });
                  if ("error" in refreshed) {
                    throw error;
                  }
                  activeMemory = refreshed;
                  rawResults = await activeMemory.manager.search(query, searchOptions);
                }
                if (rawResults.length === 0 && activeMemory.manager.sync) {
                  await activeMemory.manager.sync({ reason: "search", force: true });
                  rawResults = await activeMemory.manager.search(query, searchOptions);
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
                    ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
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
                searchMode = latestDebug?.effectiveMode;
                searchDebug = {
                  backend: status.backend,
                  configuredMode: latestDebug?.configuredMode,
                  effectiveMode:
                    status.backend === "qmd"
                      ? (latestDebug?.effectiveMode ?? latestDebug?.configuredMode)
                      : "n/a",
                  fallback: latestDebug?.fallback,
                  searchMs: Math.max(0, Date.now() - searchStartedAt),
                  hits: rawResults.length,
                };
              });
            }
            const supplementResults = shouldQuerySupplements
              ? await runUnavailablePhase(
                  "supplement",
                  async () =>
                    await searchMemoryCorpusSupplements({
                      query,
                      maxResults,
                      agentSessionKey: options.agentSessionKey,
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
            return jsonResult({
              results,
              provider,
              model,
              fallback,
              citations: citationsMode,
              mode: searchMode,
              debug: searchDebug,
            });
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
            agentSessionKey: options.agentSessionKey,
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
            agentSessionKey: options.agentSessionKey,
          });
        }
        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "status",
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
          agentSessionKey: options.agentSessionKey,
        });
      },
  });
}
