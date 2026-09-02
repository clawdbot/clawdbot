// Memory Core plugin module owns ranked search-window filtering and diagnostics.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  formatMemoryIndexRebuildGuidance,
  resolveMemoryIndexIdentityDiagnostic,
  type MemoryIndexIdentityDiagnostic,
  type MemoryProviderStatus,
  type MemorySearchManager,
  type MemorySearchRuntimeDebug,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { buildMemorySearchUnavailableResult } from "./tools.shared.js";

const MEMORY_SEARCH_POST_FILTER_MAX_CANDIDATES = 200;

export function buildPausedMemoryIndexUnavailableResult(
  diagnostic: MemoryIndexIdentityDiagnostic,
  params: {
    agentId: string;
    status: Pick<MemoryProviderStatus, "provider" | "requestedProvider">;
  },
) {
  const cause =
    diagnostic.owner === "configuration"
      ? `the current memory configuration no longer matches the index (${diagnostic.reason})`
      : diagnostic.code === "metadata_missing"
        ? `the memory index metadata is missing (${diagnostic.reason}); no configuration change is needed`
        : `this OpenClaw version changed the memory index format (${diagnostic.reason}); no configuration change is needed`;
  return buildMemorySearchUnavailableResult(diagnostic.reason, {
    warning: `Tell the user: memory search is paused because ${cause}.`,
    action: `Tell the user to run: ${formatMemoryIndexRebuildGuidance(params.status, params.agentId)}`,
  });
}

type ManagerState = { manager: MemorySearchManager; managerMs?: number };

type MemorySearchToolQuery = {
  text: string;
  resultLimit: number;
  minScore?: number;
  explicitSources?: MemorySource[];
  defaultSources?: MemorySource[];
  indexedSources?: MemorySource[];
  requestedCorpus?: "memory" | "wiki" | "all" | "sessions";
  sessionKey?: string;
  activeProjectKeys?: readonly string[];
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
};

type MemorySearchToolVisibility = {
  cfg: OpenClawConfig;
  agentId: string;
  sandboxed: boolean;
};

function isClosedMemoryStoreError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes("database is not open") ||
    message.includes("database connection is not open") ||
    message.includes("database handle is closed") ||
    message.includes("memory search manager is closed")
  );
}

export async function executeMemorySearchToolQuery(params: {
  initialManager: ManagerState;
  refreshManager: () => Promise<ManagerState | null>;
  query: MemorySearchToolQuery;
  visibility: MemorySearchToolVisibility;
  signal: AbortSignal;
}) {
  const startedAt = Date.now();
  const runtimeDebug: MemorySearchRuntimeDebug[] = [];
  let active = params.initialManager;
  const { query, signal, visibility } = params;
  // Product recall may index transcripts without adding them to ordinary model search.
  // Explicit corpus selection is authorized by the tool owner before this point.
  const searchSources =
    query.explicitSources ??
    (query.requestedCorpus === "sessions"
      ? query.defaultSources
      : query.requestedCorpus == null || query.requestedCorpus === "all"
        ? query.conversationRecall?.corpus === "configured"
          ? query.indexedSources
          : query.defaultSources
        : undefined);

  const searchOnce = async () => {
    const allowedSources = searchSources ? new Set(searchSources) : undefined;
    const searchesSessions = searchSources?.includes("sessions") === true;
    const indexedCandidateCount = searchesSessions
      ? (active.manager.status().sourceCounts ?? [])
          .filter((entry) => allowedSources?.has(entry.source))
          .reduce((total, entry) => total + entry.chunks, 0)
      : query.resultLimit;
    // A zero-count index can populate during first-search bootstrap. Reserve the
    // full bounded window so that bootstrap cannot recreate post-filter starvation.
    const availableCandidates =
      indexedCandidateCount > 0 ? indexedCandidateCount : MEMORY_SEARCH_POST_FILTER_MAX_CANDIDATES;
    const searchWindow = searchesSessions
      ? Math.min(MEMORY_SEARCH_POST_FILTER_MAX_CANDIDATES, availableCandidates)
      : query.resultLimit;
    const candidates = await active.manager.search(query.text, {
      maxResults: searchWindow,
      minScore: query.minScore,
      sessionKey: query.sessionKey,
      activeProjectKeys: query.activeProjectKeys ? [...query.activeProjectKeys] : undefined,
      signal,
      onDebug: (debug) => runtimeDebug.push(debug),
      ...(searchSources ? { sources: searchSources } : {}),
    });
    return { candidates, searchWindow };
  };

  let searched: Awaited<ReturnType<typeof searchOnce>>;
  try {
    searched = await searchOnce();
  } catch (error) {
    if (!isClosedMemoryStoreError(error)) {
      throw error;
    }
    const refreshed = await params.refreshManager();
    if (!refreshed) {
      throw error;
    }
    active = refreshed;
    searched = await searchOnce();
  }

  const status = active.manager.status();
  const pausedIndexIdentity = resolveMemoryIndexIdentityDiagnostic(status);
  if (pausedIndexIdentity) {
    return {
      status,
      rawResults: [],
      pausedIndexIdentity,
      searchMode: undefined,
      debug: undefined,
    };
  }

  let filtered = await filterMemorySearchHitsBySessionVisibility({
    cfg: visibility.cfg,
    agentId: visibility.agentId,
    requesterSessionKey: query.sessionKey,
    sandboxed: visibility.sandboxed,
    hits: searched.candidates,
    conversationRecall: query.conversationRecall,
  });
  if (searchSources) {
    const allowedSources = new Set(searchSources);
    filtered = filtered.filter((hit) => allowedSources.has(hit.source));
  }
  if (query.requestedCorpus === "sessions") {
    filtered = filtered.filter((hit) => hit.source === "sessions");
  } else if (query.requestedCorpus === "memory") {
    filtered = filtered.filter((hit) => hit.source === "memory");
  }

  const postFilterHits = filtered.length;
  const rawResults = filtered.slice(0, query.resultLimit);
  const latestDebug = runtimeDebug.at(-1);
  return {
    status,
    rawResults,
    pausedIndexIdentity: undefined,
    searchMode: latestDebug?.effectiveMode,
    debug: {
      backend: status.backend,
      configuredMode: latestDebug?.configuredMode,
      effectiveMode: "n/a",
      fallback: latestDebug?.fallback,
      managerMs: active.managerMs,
      searchMs: Math.max(0, Date.now() - startedAt),
      embeddingBootstrap: runtimeDebug.findLast((entry) => entry.embeddingBootstrap)
        ?.embeddingBootstrap,
      hits: rawResults.length,
      candidateHits: searched.candidates.length,
      withheldHits: Math.max(0, searched.candidates.length - postFilterHits),
      searchWindow: searched.searchWindow,
    },
  };
}
