import fsSync from "node:fs";
import fs from "node:fs/promises";
import * as readline from "node:readline";
import { parseSqliteSessionFileMarker } from "openclaw/plugin-sdk/session-store-runtime";
import {
  readSessionTranscriptEvents,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  asOptionalRecord as asRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { clampInt } from "./config.js";
import {
  readExplicitMemoryEvidence,
  readStructuredMemoryEvidenceFromContent,
  readStructuredMemoryFailure,
  readStructuredMemoryFailureFromContent,
} from "./prompt.js";
import { extractTextContent } from "./query.js";
import {
  DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
  DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS,
  DEFAULT_TRANSCRIPT_READ_MAX_BYTES,
  DEFAULT_TRANSCRIPT_READ_MAX_LINES,
  LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW,
  type ActiveMemorySearchDebug,
  type ActiveMemoryTranscriptSource,
  type TranscriptReadLimits,
} from "./types.js";

function isUnavailableMemorySearchDebug(debug?: ActiveMemorySearchDebug): boolean {
  return Boolean(debug?.error);
}
function resolveTranscriptReadLimits(
  limits?: TranscriptReadLimits,
): Required<TranscriptReadLimits> {
  return {
    maxChars: clampInt(
      limits?.maxChars,
      DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS,
      1,
      DEFAULT_PARTIAL_TRANSCRIPT_MAX_CHARS,
    ),
    maxLines: clampInt(
      limits?.maxLines,
      DEFAULT_TRANSCRIPT_READ_MAX_LINES,
      1,
      DEFAULT_TRANSCRIPT_READ_MAX_LINES,
    ),
    maxBytes: clampInt(
      limits?.maxBytes,
      DEFAULT_TRANSCRIPT_READ_MAX_BYTES,
      1,
      DEFAULT_TRANSCRIPT_READ_MAX_BYTES,
    ),
  };
}

async function streamBoundedTranscriptJsonl(params: {
  sessionFile: string;
  limits?: TranscriptReadLimits;
  onRecord: (record: unknown) => boolean | void;
}): Promise<void> {
  const limits = resolveTranscriptReadLimits(params.limits);
  try {
    const stats = await fs.stat(params.sessionFile);
    if (!stats.isFile() || stats.size > limits.maxBytes) {
      return;
    }
  } catch {
    return;
  }
  const stream = fsSync.createReadStream(params.sessionFile, {
    encoding: "utf8",
  });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  let seenLines = 0;
  try {
    for await (const line of rl) {
      seenLines += 1;
      if (seenLines > limits.maxLines) {
        break;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        if (params.onRecord(JSON.parse(trimmed) as unknown)) {
          break;
        }
      } catch {}
    }
  } catch {
    // Treat transcript recovery as best-effort on timeout/abort paths.
  } finally {
    rl.close();
    stream.destroy();
  }
}

function fileTranscriptSource(sessionFile: string): ActiveMemoryTranscriptSource {
  return { kind: "file", sessionFile };
}

function transcriptSourceFromReturnedSessionFile(params: {
  sessionFile: string;
  sessionKey: string;
}): ActiveMemoryTranscriptSource {
  const marker = parseSqliteSessionFileMarker(normalizeOptionalString(params.sessionFile));
  if (!marker) {
    return fileTranscriptSource(params.sessionFile);
  }
  return {
    kind: "runtime",
    target: {
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      sessionKey: params.sessionKey,
      storePath: marker.storePath,
    },
  };
}

function estimateTranscriptEventsBytes(events: readonly unknown[]): number {
  let total = 0;
  for (const event of events) {
    try {
      total += Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");
    } catch {
      total += 1;
    }
  }
  return total;
}

async function streamRuntimeTranscriptEvents(params: {
  target: SessionTranscriptTargetParams;
  limits?: TranscriptReadLimits;
  onRecord: (record: unknown) => boolean | void;
}): Promise<void> {
  const limits = resolveTranscriptReadLimits(params.limits);
  let events: readonly unknown[];
  try {
    events = await readSessionTranscriptEvents(params.target);
  } catch {
    return;
  }
  if (estimateTranscriptEventsBytes(events) > limits.maxBytes) {
    return;
  }
  let seenLines = 0;
  for (const event of events) {
    seenLines += 1;
    if (seenLines > limits.maxLines) {
      break;
    }
    try {
      if (params.onRecord(event)) {
        break;
      }
    } catch {}
  }
}

async function streamActiveMemoryTranscriptRecords(params: {
  source: ActiveMemoryTranscriptSource;
  limits?: TranscriptReadLimits;
  onRecord: (record: unknown) => boolean | void;
}): Promise<void> {
  if (params.source.kind === "runtime") {
    await streamRuntimeTranscriptEvents({
      target: params.source.target,
      limits: params.limits,
      onRecord: params.onRecord,
    });
    return;
  }
  await streamBoundedTranscriptJsonl({
    sessionFile: params.source.sessionFile,
    limits: params.limits,
    onRecord: params.onRecord,
  });
}

function extractActiveMemorySearchDebugFromSessionRecord(
  value: unknown,
): ActiveMemorySearchDebug | undefined {
  const record = asRecord(value);
  const nestedMessage = asRecord(record?.message);
  const recordToolName = normalizeLowercaseStringOrEmpty(record?.toolName);
  const topLevelMessage =
    record?.role === "toolResult" ||
    recordToolName === "memory_search" ||
    recordToolName === "memory_recall"
      ? record
      : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message) {
    return undefined;
  }
  const role = normalizeOptionalString(message.role);
  const toolName = normalizeLowercaseStringOrEmpty(message.toolName);
  if (role !== "toolResult" || (toolName !== "memory_search" && toolName !== "memory_recall")) {
    return undefined;
  }
  const details = asRecord(message.details);
  const debug = asRecord(details?.debug);
  const warning = normalizeOptionalString(details?.warning);
  const action = normalizeOptionalString(details?.action);
  const error = normalizeOptionalString(details?.error);
  if (!debug && !warning && !action && !error) {
    return undefined;
  }
  return {
    backend: normalizeOptionalString(debug?.backend),
    configuredMode: normalizeOptionalString(debug?.configuredMode),
    effectiveMode: normalizeOptionalString(debug?.effectiveMode),
    fallback: normalizeOptionalString(debug?.fallback),
    searchMs:
      typeof debug?.searchMs === "number" && Number.isFinite(debug.searchMs)
        ? debug.searchMs
        : undefined,
    hits: typeof debug?.hits === "number" && Number.isFinite(debug.hits) ? debug.hits : undefined,
    warning,
    action,
    error,
  };
}

function extractToolResultNameFromSessionRecord(value: unknown): string | undefined {
  const record = asRecord(value);
  const nestedMessage = asRecord(record?.message);
  const topLevelMessage = record?.role === "toolResult" ? record : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message) {
    return undefined;
  }
  const role = normalizeOptionalString(message.role);
  const toolName = normalizeLowercaseStringOrEmpty(message.toolName);
  return role === "toolResult" && toolName ? toolName : undefined;
}

function hasUnavailableMemoryResultInSessionRecord(
  value: unknown,
  toolsAllow: readonly string[] = [
    ...DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
    ...LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW,
  ],
): boolean {
  const record = asRecord(value);
  const nestedMessage = asRecord(record?.message);
  const topLevelMessage = record?.role === "toolResult" ? record : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message || normalizeOptionalString(message.role) !== "toolResult") {
    return false;
  }
  const toolName = normalizeLowercaseStringOrEmpty(message.toolName);
  if (!toolName || !toolsAllow.includes(toolName)) {
    return false;
  }
  const details = asRecord(message.details);
  const unavailable = message.isError === true || readStructuredMemoryFailure(details) === true;
  if (unavailable) {
    return true;
  }
  return readStructuredMemoryFailureFromContent(message.content) === true;
}

function hasTerminalUnavailableMemoryResultInSessionRecord(
  value: unknown,
  toolsAllow: readonly string[],
): boolean {
  const record = asRecord(value);
  const nestedMessage = asRecord(record?.message);
  const topLevelMessage = record?.role === "toolResult" ? record : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message || normalizeOptionalString(message.role) !== "toolResult") {
    return false;
  }
  const toolName = normalizeLowercaseStringOrEmpty(message.toolName);
  if (!toolName || !toolsAllow.includes(toolName)) {
    return false;
  }
  const details = asRecord(message.details);
  if (details?.disabled === true || details?.unavailable === true) {
    return true;
  }
  const status = normalizeOptionalString(details?.status)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (status === "disabled" || status === "unavailable") {
    return true;
  }
  if (toolName !== "memory_search" && toolName !== "memory_recall") {
    return false;
  }
  const debug = extractActiveMemorySearchDebugFromSessionRecord(value);
  return Boolean(debug?.error) || Boolean(details?.error);
}

type ActiveMemoryHookDeadline = {
  arm: (timeoutMs: number, onTimeout: () => void) => void;
  promise: Promise<symbol>;
  stop: () => void;
};

function createActiveMemoryHookDeadline(): ActiveMemoryHookDeadline {
  const timeoutSentinel = Symbol("active-memory-hook-timeout");
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let resolveTimeout: (value: symbol) => void = () => {};
  const promise = new Promise<symbol>((resolve) => {
    resolveTimeout = resolve;
  });
  const stop = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };
  const arm = (timeoutMs: number, onTimeout: () => void) => {
    stop();
    timeoutId = setTimeout(() => {
      onTimeout();
      resolveTimeout(timeoutSentinel);
    }, timeoutMs);
    timeoutId.unref?.();
  };
  return { arm, promise, stop };
}

function hasUsableMemoryResultInSessionRecord(
  value: unknown,
  toolsAllow: readonly string[] = [
    ...DEFAULT_ACTIVE_MEMORY_TOOLS_ALLOW,
    ...LANCEDB_ACTIVE_MEMORY_TOOLS_ALLOW,
  ],
): boolean {
  const record = asRecord(value);
  const nestedMessage = asRecord(record?.message);
  const recordToolName = normalizeLowercaseStringOrEmpty(record?.toolName);
  const topLevelMessage =
    record?.role === "toolResult" ||
    recordToolName === "memory_search" ||
    recordToolName === "memory_recall"
      ? record
      : undefined;
  const message = nestedMessage ?? topLevelMessage;
  if (!message || normalizeOptionalString(message.role) !== "toolResult") {
    return false;
  }
  const toolName = normalizeLowercaseStringOrEmpty(message.toolName);
  if (!toolName || !toolsAllow.includes(toolName)) {
    return false;
  }
  if (hasUnavailableMemoryResultInSessionRecord(value, toolsAllow)) {
    return false;
  }
  const details = asRecord(message.details);
  const content = extractTextContent(message.content);
  if (toolName === "memory_search") {
    if (Array.isArray(details?.results)) {
      return details.results.length > 0;
    }
    // Oversized details are capped before transcript persistence, while the
    // leading model-visible JSON still preserves whether results were present.
    return /"results"\s*:\s*\[\s*([^\s\]])/.test(content);
  }
  if (toolName === "memory_recall") {
    if (Array.isArray(details?.memories)) {
      return details.memories.length > 0;
    }
    return /^Found [1-9]\d* memories:/.test(content);
  }
  if (toolName === "memory_get") {
    const text = normalizeOptionalString(details?.text);
    return text !== undefined ? text.length > 0 : /"text"\s*:\s*"(?!")/.test(content);
  }
  if (toolName === "lcm_grep") {
    if (
      typeof details?.totalMatches === "number" &&
      Number.isFinite(details.totalMatches) &&
      details.totalMatches > 0
    ) {
      return true;
    }
    return /^## LCM Grep Results[\s\S]*^\*\*Total matches:\*\*\s+[1-9]\d*$/m.test(content);
  }
  if (toolName === "lcm_describe") {
    const type = normalizeOptionalString(details?.type);
    if (normalizeOptionalString(details?.id) && (type === "summary" || type === "file")) {
      return true;
    }
    return /^LCM_SUMMARY \S+/m.test(content) || /^## LCM File: \S+/m.test(content);
  }
  if (toolName === "lcm_expand_query") {
    if (
      typeof details?.expandedSummaryCount === "number" &&
      Number.isFinite(details.expandedSummaryCount) &&
      details.expandedSummaryCount > 0 &&
      Boolean(normalizeOptionalString(details?.answer))
    ) {
      return true;
    }
    try {
      const parsed = asRecord(JSON.parse(content));
      return (
        typeof parsed?.expandedSummaryCount === "number" &&
        Number.isFinite(parsed.expandedSummaryCount) &&
        parsed.expandedSummaryCount > 0 &&
        Boolean(normalizeOptionalString(parsed?.answer))
      );
    } catch {
      return false;
    }
  }
  const normalizedContent = normalizeOptionalString(content);
  const explicitEvidence = details ? readExplicitMemoryEvidence(details) : undefined;
  const structuredEvidence = normalizedContent
    ? readStructuredMemoryEvidenceFromContent(message.content)
    : undefined;
  // Custom recall tools have a shipped native-output contract. Preserve
  // non-empty model-visible results unless structured fields explicitly say
  // the lookup was empty; explicit failures are rejected above.
  return Boolean(normalizedContent) && explicitEvidence !== false && structuredEvidence !== false;
}

export {
  createActiveMemoryHookDeadline,
  extractActiveMemorySearchDebugFromSessionRecord,
  extractToolResultNameFromSessionRecord,
  fileTranscriptSource,
  hasTerminalUnavailableMemoryResultInSessionRecord,
  hasUnavailableMemoryResultInSessionRecord,
  hasUsableMemoryResultInSessionRecord,
  isUnavailableMemorySearchDebug,
  resolveTranscriptReadLimits,
  streamActiveMemoryTranscriptRecords,
  transcriptSourceFromReturnedSessionFile,
};
