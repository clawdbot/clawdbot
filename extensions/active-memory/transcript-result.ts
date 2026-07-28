import {
  asOptionalRecord as asRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { normalizeActiveSummary, truncateSummary } from "./prompt.js";
import { extractTextContent } from "./query.js";
import { readMergedActiveMemoryTranscriptState } from "./transcript-watch.js";
import {
  fileTranscriptSource,
  hasUnavailableMemoryResultInSessionRecord,
  hasUsableMemoryResultInSessionRecord,
  isUnavailableMemorySearchDebug,
  resolveTranscriptReadLimits,
  streamActiveMemoryTranscriptRecords,
} from "./transcript.js";
import {
  TIMEOUT_PARTIAL_DATA_GRACE_MS,
  type ActiveMemoryPartialTimeoutError,
  type ActiveMemorySearchDebug,
  type ActiveMemoryTranscriptSource,
  type ActiveRecallResult,
  type RecallSubagentResult,
  type TranscriptReadLimits,
} from "./types.js";

let timeoutPartialDataGraceMs = TIMEOUT_PARTIAL_DATA_GRACE_MS;

function readMemoryToolResultEvidence(params: {
  toolName: string;
  result: unknown;
  isError: boolean;
  toolsAllow: readonly string[];
}): {
  hasUsableMemoryResult: boolean;
  hasUnavailableMemorySearchResult: boolean;
} {
  const result = asRecord(params.result);
  const rawContent = result?.content;
  const textContent =
    normalizeOptionalString(result?.detailedContent) ??
    (typeof rawContent === "string" ? normalizeOptionalString(rawContent) : undefined);
  const record = {
    message: {
      role: "toolResult",
      toolName: params.toolName,
      isError: params.isError,
      content: Array.isArray(rawContent)
        ? rawContent
        : textContent
          ? [{ type: "text", text: textContent }]
          : [],
      details: result?.details,
    },
  };
  return {
    hasUsableMemoryResult: hasUsableMemoryResultInSessionRecord(record, params.toolsAllow),
    hasUnavailableMemorySearchResult: hasUnavailableMemoryResultInSessionRecord(
      record,
      params.toolsAllow,
    ),
  };
}

function extractAssistantTextFromSessionRecord(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const nestedMessage = asRecord(record.message);
  const topLevelMessage = normalizeOptionalString(record.role) === "assistant" ? record : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message || normalizeOptionalString(message.role) !== "assistant") {
    return "";
  }
  return extractTextContent(message.content).trim();
}

async function readPartialAssistantText(
  source: ActiveMemoryTranscriptSource | string | undefined,
  limits?: TranscriptReadLimits,
): Promise<string | null> {
  if (!source) {
    return null;
  }
  const texts: string[] = [];
  const resolvedLimits = resolveTranscriptReadLimits(limits);
  let collectedChars = 0;
  await streamActiveMemoryTranscriptRecords({
    source: typeof source === "string" ? fileTranscriptSource(source) : source,
    limits: resolvedLimits,
    onRecord: (record) => {
      const text = extractAssistantTextFromSessionRecord(record);
      if (text) {
        const separatorChars = texts.length > 0 ? 1 : 0;
        const remaining = resolvedLimits.maxChars - collectedChars - separatorChars;
        if (remaining <= 0) {
          return true;
        }
        const nextText = truncateUtf16Safe(text, remaining);
        if (!nextText) {
          return true;
        }
        texts.push(nextText);
        collectedChars += separatorChars + nextText.length;
        // A surrogate backoff leaves spare code units; stop instead of skipping ahead.
        return nextText.length < text.length || collectedChars >= resolvedLimits.maxChars;
      }
      return false;
    },
  });
  // Accepted chunks and separators are charged before append, so the join is already bounded.
  const joined = texts.join("\n").trim();
  return joined || null;
}

async function readPartialAssistantTextFromSources(
  sources: readonly ActiveMemoryTranscriptSource[],
  limits?: TranscriptReadLimits,
): Promise<string | null> {
  for (const source of sources) {
    const text = await readPartialAssistantText(source, limits);
    if (text) {
      return text;
    }
  }
  return null;
}

function attachPartialTimeoutData(
  error: unknown,
  partialReply: string | null,
  searchDebug: ActiveMemorySearchDebug | undefined,
  hasUnavailableMemorySearchResult: boolean,
): void {
  if (!error || typeof error !== "object") {
    return;
  }
  const target = error as ActiveMemoryPartialTimeoutError;
  if (partialReply) {
    target.activeMemoryPartialReply = partialReply;
  }
  if (searchDebug) {
    target.activeMemorySearchDebug = searchDebug;
  }
  if (hasUnavailableMemorySearchResult) {
    target.activeMemoryUnavailableMemorySearch = true;
  }
}

function readPartialTimeoutData(error: unknown): {
  rawReply?: string;
  searchDebug?: ActiveMemorySearchDebug;
  hasUnavailableMemorySearchResult?: boolean;
} {
  if (!error || typeof error !== "object") {
    return {};
  }
  const source = error as ActiveMemoryPartialTimeoutError;
  return {
    rawReply: normalizeOptionalString(source.activeMemoryPartialReply),
    searchDebug: source.activeMemorySearchDebug,
    hasUnavailableMemorySearchResult: source.activeMemoryUnavailableMemorySearch,
  };
}

async function waitForSubagentPartialTimeoutData(
  subagentPromise: Promise<RecallSubagentResult> | undefined,
): Promise<{
  rawReply?: string;
  searchDebug?: ActiveMemorySearchDebug;
  hasUnavailableMemorySearchResult?: boolean;
  settled: boolean;
}> {
  if (!subagentPromise) {
    return { settled: true };
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ settled: false }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ settled: false }), timeoutPartialDataGraceMs);
    timeoutId.unref?.();
  });
  try {
    return await Promise.race([
      subagentPromise.then(
        () => ({ settled: true as const }),
        (error: unknown) => ({ ...readPartialTimeoutData(error), settled: true as const }),
      ),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function buildTimeoutRecallResult(params: {
  elapsedMs: number;
  maxSummaryChars: number;
  transcriptSources: readonly ActiveMemoryTranscriptSource[];
  rawReply?: string;
  searchDebug?: ActiveMemorySearchDebug;
  hasUnavailableMemorySearchResult?: boolean;
  subagentPromise?: Promise<RecallSubagentResult>;
  toolsAllow: readonly string[];
}): Promise<ActiveRecallResult> {
  const subagentPartialData = params.rawReply
    ? { settled: true as const }
    : await waitForSubagentPartialTimeoutData(params.subagentPromise);
  const rawReply =
    params.rawReply ??
    subagentPartialData.rawReply ??
    (await readPartialAssistantTextFromSources(params.transcriptSources));
  const summary = truncateSummary(
    normalizeActiveSummary(rawReply ?? "") ?? "",
    params.maxSummaryChars,
  );
  const transcriptState =
    params.transcriptSources.length > 0
      ? await readMergedActiveMemoryTranscriptState({
          sources: params.transcriptSources,
          toolsAllow: params.toolsAllow,
        })
      : undefined;
  const searchDebug =
    params.searchDebug ?? subagentPartialData.searchDebug ?? transcriptState?.searchDebug;
  if (
    summary.length === 0 ||
    isUnavailableMemorySearchDebug(searchDebug) ||
    !subagentPartialData.settled ||
    params.hasUnavailableMemorySearchResult ||
    subagentPartialData.hasUnavailableMemorySearchResult ||
    transcriptState?.hasUnavailableMemorySearchResult
  ) {
    return {
      status: "timeout",
      elapsedMs: params.elapsedMs,
      summary: null,
      searchDebug,
    };
  }
  return {
    status: "timeout_partial",
    elapsedMs: params.elapsedMs,
    summary,
    searchDebug,
  };
}

function buildSubagentRecallResult(params: {
  subagentResult: RecallSubagentResult;
  fallbackSearchDebug?: ActiveMemorySearchDebug;
  fallbackHasUsableMemoryResult?: boolean;
  elapsedMs: number;
  maxSummaryChars: number;
}): ActiveRecallResult {
  const { rawReply, resultStatus } = params.subagentResult;
  const searchDebug = params.subagentResult.searchDebug ?? params.fallbackSearchDebug;
  const summary = truncateSummary(normalizeActiveSummary(rawReply) ?? "", params.maxSummaryChars);
  const hasUsableMemoryResult =
    params.subagentResult.hasUsableMemoryResult === true ||
    params.fallbackHasUsableMemoryResult === true;
  const hasUnavailableMemorySearchResult =
    params.subagentResult.hasUnavailableMemorySearchResult === true;
  const canUseSummary = hasUsableMemoryResult;
  return summary.length > 0 && canUseSummary
    ? {
        status: "ok",
        elapsedMs: params.elapsedMs,
        rawReply,
        summary,
        searchDebug,
      }
    : resultStatus === "failed"
      ? {
          status: "failed",
          elapsedMs: params.elapsedMs,
          summary: null,
          searchDebug,
        }
      : resultStatus === "unavailable" ||
          isUnavailableMemorySearchDebug(searchDebug) ||
          hasUnavailableMemorySearchResult
        ? {
            status: "unavailable",
            elapsedMs: params.elapsedMs,
            summary: null,
            searchDebug,
          }
        : {
            status: "no_relevant_memory",
            elapsedMs: params.elapsedMs,
            summary: null,
            searchDebug,
          };
}

function resetActiveMemoryTranscriptForTests(): void {
  timeoutPartialDataGraceMs = TIMEOUT_PARTIAL_DATA_GRACE_MS;
}

function setTimeoutPartialDataGraceMsForTests(value: number): void {
  timeoutPartialDataGraceMs = Math.max(0, Math.floor(value));
}

export {
  attachPartialTimeoutData,
  buildSubagentRecallResult,
  buildTimeoutRecallResult,
  readMemoryToolResultEvidence,
  readPartialAssistantText,
  readPartialAssistantTextFromSources,
  readPartialTimeoutData,
  resetActiveMemoryTranscriptForTests,
  setTimeoutPartialDataGraceMsForTests,
};
