import {
  asOptionalRecord as asRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  extractActiveMemorySearchDebugFromSessionRecord,
  extractToolResultNameFromSessionRecord,
  fileTranscriptSource,
  hasTerminalUnavailableMemoryResultInSessionRecord,
  hasUnavailableMemoryResultInSessionRecord,
  hasUsableMemoryResultInSessionRecord,
  streamActiveMemoryTranscriptRecords,
} from "./transcript.js";
import {
  TERMINAL_MEMORY_SEARCH_POLL_INTERVAL_MS,
  type ActiveMemorySearchDebug,
  type ActiveMemoryTranscriptSource,
  type TerminalMemorySearchResult,
  type TerminalMemorySearchWatch,
  type TranscriptReadLimits,
} from "./types.js";

async function readActiveMemoryTranscriptState(
  source: ActiveMemoryTranscriptSource | string,
  limits?: TranscriptReadLimits,
  toolsAllow?: readonly string[],
): Promise<{
  searchDebug?: ActiveMemorySearchDebug;
  hasUsableMemoryResult: boolean;
  hasUnavailableMemorySearchResult: boolean;
}> {
  let searchDebug: ActiveMemorySearchDebug | undefined;
  let hasUsableMemoryResult = false;
  let hasUnavailableMemorySearchResult = false;
  await streamActiveMemoryTranscriptRecords({
    source: typeof source === "string" ? fileTranscriptSource(source) : source,
    limits,
    onRecord: (record) => {
      const debug = extractActiveMemorySearchDebugFromSessionRecord(record);
      if (debug) {
        searchDebug = debug;
      }
      hasUnavailableMemorySearchResult ||= hasUnavailableMemoryResultInSessionRecord(
        record,
        toolsAllow,
      );
      hasUsableMemoryResult ||= hasUsableMemoryResultInSessionRecord(record, toolsAllow);
    },
  });
  return { searchDebug, hasUsableMemoryResult, hasUnavailableMemorySearchResult };
}

async function readActiveMemorySearchDebug(
  source: ActiveMemoryTranscriptSource | string,
  limits?: TranscriptReadLimits,
): Promise<ActiveMemorySearchDebug | undefined> {
  return (await readActiveMemoryTranscriptState(source, limits)).searchDebug;
}

async function readMergedActiveMemoryTranscriptState(params: {
  sources: readonly ActiveMemoryTranscriptSource[];
  toolsAllow: readonly string[];
}): Promise<{
  searchDebug?: ActiveMemorySearchDebug;
  hasUsableMemoryResult: boolean;
  hasUnavailableMemorySearchResult: boolean;
}> {
  let searchDebug: ActiveMemorySearchDebug | undefined;
  let hasUsableMemoryResult = false;
  let hasUnavailableMemorySearchResult = false;
  const seen = new Set<string>();
  for (const source of params.sources) {
    const key =
      source.kind === "runtime"
        ? `runtime:${source.target.agentId ?? ""}:${source.target.sessionId}:${source.target.sessionKey}:${source.target.storePath ?? ""}:${source.target.threadId ?? ""}`
        : `file:${source.sessionFile}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const state = await readActiveMemoryTranscriptState(source, undefined, params.toolsAllow);
    searchDebug = state.searchDebug ?? searchDebug;
    hasUsableMemoryResult ||= state.hasUsableMemoryResult;
    hasUnavailableMemorySearchResult ||= state.hasUnavailableMemorySearchResult;
  }
  return { searchDebug, hasUsableMemoryResult, hasUnavailableMemorySearchResult };
}

async function readTerminalMemorySearchResult(
  source: ActiveMemoryTranscriptSource,
  limits?: TranscriptReadLimits,
  toolsAllow?: readonly string[],
): Promise<TerminalMemorySearchResult | undefined> {
  // memory_get consumes a path discovered by another tool; it is not an
  // independent fallback that should delay terminal unavailability.
  const recallPathNames = new Set(
    toolsAllow
      ?.map((toolName) => normalizeLowercaseStringOrEmpty(toolName))
      .filter((toolName) => toolName && toolName !== "memory_get"),
  );
  if (recallPathNames.size === 0) {
    return undefined;
  }
  const unavailablePathNames = new Set<string>();
  let hasUsableMemoryResult = false;
  let searchDebug: ActiveMemorySearchDebug | undefined;
  await streamActiveMemoryTranscriptRecords({
    source,
    limits,
    onRecord: (record) => {
      hasUsableMemoryResult ||= hasUsableMemoryResultInSessionRecord(record, toolsAllow);
      searchDebug = extractActiveMemorySearchDebugFromSessionRecord(record) ?? searchDebug;
      const toolName = extractToolResultNameFromSessionRecord(record);
      if (!toolName || !recallPathNames.has(toolName)) {
        return false;
      }
      if (hasTerminalUnavailableMemoryResultInSessionRecord(record, toolsAllow ?? [])) {
        unavailablePathNames.add(toolName);
      } else {
        unavailablePathNames.delete(toolName);
      }
      return false;
    },
  });
  if (unavailablePathNames.size !== recallPathNames.size) {
    return undefined;
  }
  return {
    status: "unavailable",
    hasUsableMemoryResult,
    searchDebug,
  };
}

async function readTerminalMemorySearchResultFromSources(
  sources: readonly ActiveMemoryTranscriptSource[],
  limits: TranscriptReadLimits | undefined,
  toolsAllow: readonly string[],
): Promise<TerminalMemorySearchResult | undefined> {
  for (const source of sources) {
    const result = await readTerminalMemorySearchResult(source, limits, toolsAllow);
    if (result) {
      return result;
    }
  }
  return undefined;
}

function watchTerminalMemorySearchResult(params: {
  getTranscriptSources: () => readonly ActiveMemoryTranscriptSource[];
  abortSignal: AbortSignal;
  toolsAllow: readonly string[];
}): TerminalMemorySearchWatch {
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let resolveWatch: (result: TerminalMemorySearchResult) => void = () => {};
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    params.abortSignal.removeEventListener("abort", onAbort);
  };
  const finish = (result: TerminalMemorySearchResult) => {
    stop();
    resolveWatch(result);
  };
  const schedule = () => {
    if (stopped) {
      return;
    }
    timeoutId = setTimeout(() => {
      void tick();
    }, TERMINAL_MEMORY_SEARCH_POLL_INTERVAL_MS);
    timeoutId.unref?.();
  };
  const tick = async () => {
    if (stopped || inFlight) {
      return;
    }
    if (params.abortSignal.aborted) {
      stop();
      return;
    }
    inFlight = true;
    try {
      const result = await readTerminalMemorySearchResultFromSources(
        params.getTranscriptSources(),
        undefined,
        params.toolsAllow,
      );
      if (result) {
        finish(result);
        return;
      }
    } catch {
      // Transcript polling is opportunistic; normal timeout handling remains authoritative.
    } finally {
      inFlight = false;
    }
    schedule();
  };
  function onAbort() {
    stop();
  }
  const promise = new Promise<TerminalMemorySearchResult>((resolve) => {
    resolveWatch = resolve;
    params.abortSignal.addEventListener("abort", onAbort, { once: true });
    void tick();
  });
  return {
    promise,
    stop,
  };
}

function normalizeSearchDebug(value: unknown): ActiveMemorySearchDebug | undefined {
  const debug = asRecord(value);
  if (!debug) {
    return undefined;
  }
  const normalized: ActiveMemorySearchDebug = {
    backend: normalizeOptionalString(debug.backend),
    configuredMode: normalizeOptionalString(debug.configuredMode),
    effectiveMode: normalizeOptionalString(debug.effectiveMode),
    fallback: normalizeOptionalString(debug.fallback),
    searchMs:
      typeof debug.searchMs === "number" && Number.isFinite(debug.searchMs)
        ? debug.searchMs
        : undefined,
    hits: typeof debug.hits === "number" && Number.isFinite(debug.hits) ? debug.hits : undefined,
    warning: normalizeOptionalString(debug.warning) ?? normalizeOptionalString(debug.reason),
    action: normalizeOptionalString(debug.action),
    error: normalizeOptionalString(debug.error),
  };
  return normalized.backend ||
    normalized.configuredMode ||
    normalized.effectiveMode ||
    normalized.fallback ||
    typeof normalized.searchMs === "number" ||
    typeof normalized.hits === "number" ||
    normalized.warning ||
    normalized.action ||
    normalized.error
    ? normalized
    : undefined;
}

function readActiveMemorySearchDebugFromRunResult(
  result: unknown,
): ActiveMemorySearchDebug | undefined {
  const record = asRecord(result);
  const meta = asRecord(record?.meta);
  return (
    normalizeSearchDebug(meta?.activeMemorySearchDebug) ??
    normalizeSearchDebug(meta?.memorySearchDebug) ??
    normalizeSearchDebug(record?.activeMemorySearchDebug) ??
    normalizeSearchDebug(record?.memorySearchDebug)
  );
}

function readActiveMemorySessionFileFromRunResult(result: unknown): string | undefined {
  const record = asRecord(result);
  const meta = asRecord(record?.meta);
  const agentMeta = asRecord(meta?.agentMeta);
  return (
    normalizeOptionalString(agentMeta?.sessionFile) ?? normalizeOptionalString(meta?.sessionFile)
  );
}

export {
  readActiveMemorySearchDebug,
  readActiveMemorySearchDebugFromRunResult,
  readActiveMemorySessionFileFromRunResult,
  readMergedActiveMemoryTranscriptState,
  watchTerminalMemorySearchResult,
};
