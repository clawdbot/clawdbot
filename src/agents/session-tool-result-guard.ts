import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  boundedJsonUtf8Bytes,
  firstEnumerableOwnKeys,
  jsonUtf8BytesOrInfinity,
  type BoundedJsonUtf8Bytes,
} from "../infra/json-utf8-bytes.js";
import {
  isSensitiveFieldKey,
  redactSensitiveFieldValueWithConfig,
  redactToolPayloadTextWithConfig,
} from "../logging/redact.js";
import type {
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from "../plugins/types.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { formatContextLimitTruncationNotice } from "./pi-embedded-runner/context-truncation-notice.js";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  truncateToolResultMessage,
} from "./pi-embedded-runner/tool-result-truncation.js";
import {
  getRawSessionAppendMessage,
  setRawSessionAppendMessage,
} from "./session-raw-append-message.js";
import { createPendingToolCallState } from "./session-tool-result-state.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

/**
 * Truncate oversized text content blocks in a tool result message.
 * Returns the original message if under the limit, or a new message with
 * truncated text blocks otherwise.
 */
function capToolResultSize(msg: AgentMessage, maxChars: number): AgentMessage {
  if ((msg as { role?: string }).role !== "toolResult") {
    return msg;
  }
  return truncateToolResultMessage(msg, maxChars, {
    suffix: (truncatedChars) => formatContextLimitTruncationNotice(truncatedChars),
    minKeepChars: 2_000,
  });
}

function resolveMaxToolResultChars(opts?: { maxToolResultChars?: number }): number {
  return Math.max(1, opts?.maxToolResultChars ?? DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
}

type UserAgentMessage = Extract<AgentMessage, { role: "user" }>;

function isUserAgentMessage(message: AgentMessage): message is UserAgentMessage {
  return message.role === "user";
}

// `details` is runtime/UI metadata, not model-visible tool output. Keep the
// session JSONL useful for debugging without letting metadata blobs dominate
// disk, replay repair, transcript broadcasts, or future tooling that reads raw
// sessions. Model-visible text belongs in tool result `content`.
const MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES = 8_192;
const MAX_PERSISTED_DETAIL_STRING_CHARS = 2_000;
const MAX_PERSISTED_DETAIL_SESSION_COUNT = 10;
const MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS = 200;
const MAX_PERSISTED_DETAIL_REDACTION_LOOKAHEAD_CHARS = 1_024;
const MAX_PERSISTED_DETAIL_BOUNDARY_OVERLAP_CHARS = 512;
const PERSISTED_DETAIL_REDACTION_BOUNDARY = "\u0000OPENCLAW_PERSISTED_DETAIL_BOUNDARY\u0000";
const PARTIAL_STRUCTURED_SECRET_VALUE_RE =
  /(?:["']?(?:api[-_]?key|apikey|token|secret|password|passwd|access[-_]?token|accesstoken|refresh[-_]?token|refreshtoken|auth[-_]?token|authtoken|client[-_]?secret|clientsecret|app[-_]?secret|appsecret|card[-_]?number|cardnumber|cvc|cvv)["']?\s*[:=]\s*["']?)(?!\*{3})(?=[^\s"',}\]]{8,})/i;
const PARTIAL_PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY)-----/i;

type ToolResultDetailRedactionConfig = Parameters<typeof redactToolPayloadTextWithConfig>[1];
function originalDetailsSizeFields(size: BoundedJsonUtf8Bytes): Record<string, number> {
  return size.complete
    ? { originalDetailsBytes: size.bytes }
    : { originalDetailsBytesAtLeast: size.bytes };
}

function redactPersistedDetailString(
  value: string,
  maxChars = MAX_PERSISTED_DETAIL_STRING_CHARS,
  redactionConfig?: ToolResultDetailRedactionConfig,
): string {
  if (value.length <= maxChars) {
    return redactToolPayloadTextWithConfig(value, redactionConfig);
  }

  const scan = `${value.slice(0, maxChars)}${PERSISTED_DETAIL_REDACTION_BOUNDARY}${value.slice(
    maxChars,
    maxChars + MAX_PERSISTED_DETAIL_REDACTION_LOOKAHEAD_CHARS,
  )}`;
  const redactedScan = redactToolPayloadTextWithConfig(scan, redactionConfig);
  const boundaryIndex = redactedScan.indexOf(PERSISTED_DETAIL_REDACTION_BOUNDARY);
  const redactedPrefix =
    boundaryIndex >= 0
      ? redactedScan.slice(0, boundaryIndex)
      : "[OpenClaw persisted detail redacted: boundary marker removed]";
  const safePrefixChars = Math.max(
    0,
    maxChars - Math.min(maxChars, MAX_PERSISTED_DETAIL_BOUNDARY_OVERLAP_CHARS),
  );
  const initialPersistedPrefix = redactedPrefix.slice(0, safePrefixChars);
  const persistedPrefix =
    PARTIAL_STRUCTURED_SECRET_VALUE_RE.test(initialPersistedPrefix) ||
    PARTIAL_PRIVATE_KEY_BLOCK_RE.test(initialPersistedPrefix)
      ? "[OpenClaw persisted detail redacted: partial secret span omitted]"
      : initialPersistedPrefix;
  const boundaryNotice = "[OpenClaw persisted detail redacted: boundary overlap omitted]";
  return `${persistedPrefix}${persistedPrefix ? "\n" : ""}${boundaryNotice}\n\n[OpenClaw persisted detail truncated: ${Math.max(
    0,
    value.length - maxChars,
  )} original chars omitted]`;
}

function isSensitivePersistedDetailKey(key: string | undefined): boolean {
  return Boolean(key && isSensitiveFieldKey(key));
}

function selectPersistedDetailRedactionKey(
  key: string,
  inheritedKey: string | undefined,
): string | undefined {
  return isSensitivePersistedDetailKey(key) ? key : inheritedKey;
}

function redactedOriginalDetailKeys(
  src: Record<string, unknown>,
  redactionConfig?: ToolResultDetailRedactionConfig,
): string[] {
  return firstEnumerableOwnKeys(src, 40).map((key) =>
    redactToolPayloadTextWithConfig(key, redactionConfig),
  );
}

function redactPersistedDetailValue(
  value: unknown,
  depth = 0,
  redactionKey?: string,
  redactionConfig?: ToolResultDetailRedactionConfig,
): unknown {
  if (typeof value === "string") {
    return redactionKey
      ? redactSensitiveFieldValueWithConfig(redactionKey, value, redactionConfig)
      : redactToolPayloadTextWithConfig(value, redactionConfig);
  }
  if (
    redactionKey &&
    (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
  ) {
    return redactSensitiveFieldValueWithConfig(redactionKey, String(value), redactionConfig);
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (depth >= 8) {
    return "[OpenClaw persisted detail redacted: max depth exceeded]";
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactPersistedDetailValue(item, depth + 1, redactionKey, redactionConfig);
      changed ||= redacted !== item;
      return redacted;
    });
    return changed ? next : value;
  }

  const source = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(source)) {
    const redactedKey = redactToolPayloadTextWithConfig(key, redactionConfig);
    const redacted = redactPersistedDetailValue(
      field,
      depth + 1,
      selectPersistedDetailRedactionKey(key, redactionKey),
      redactionConfig,
    );
    changed ||= redactedKey !== key || redacted !== field;
    next[redactedKey] = redacted;
  }
  return changed ? next : value;
}

function redactPersistedSummaryField(
  key: string,
  value: unknown,
  maxStringChars: number,
  redactionConfig?: ToolResultDetailRedactionConfig,
): unknown {
  if (typeof value === "string") {
    return redactPersistedDetailString(value, maxStringChars, redactionConfig);
  }
  return redactPersistedDetailValue(
    value,
    0,
    selectPersistedDetailRedactionKey(key, undefined),
    redactionConfig,
  );
}

function sanitizePersistedSessionDetail(
  value: unknown,
  redactionConfig?: ToolResultDetailRedactionConfig,
): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    "sessionId",
    "status",
    "pid",
    "startedAt",
    "endedAt",
    "runtimeMs",
    "cwd",
    "name",
    "truncated",
    "exitCode",
    "exitSignal",
  ]) {
    const field = src[key];
    if (field !== undefined) {
      out[key] = redactPersistedSummaryField(key, field, 500, redactionConfig);
    }
  }
  if (typeof src.command === "string") {
    out.command = redactPersistedDetailString(src.command, 500, redactionConfig);
  }
  return out;
}

function buildPersistedDetailsFallback(
  src: Record<string, unknown> | undefined,
  originalSize: BoundedJsonUtf8Bytes,
  sanitizedBytes?: number,
  redactionConfig?: ToolResultDetailRedactionConfig,
): Record<string, unknown> {
  // If even the structured summary is too large, keep only shape and stable
  // status fields. This preserves "what happened?" without persisting the raw
  // diagnostics payload that caused the cap to trip.
  const fallback: Record<string, unknown> = {
    persistedDetailsTruncated: true,
    finalDetailsTruncated: true,
    ...originalDetailsSizeFields(originalSize),
  };
  if (sanitizedBytes !== undefined) {
    fallback.sanitizedDetailsBytes = sanitizedBytes;
  }
  if (src) {
    fallback.originalDetailKeys = redactedOriginalDetailKeys(src, redactionConfig);
    for (const key of ["status", "sessionId", "pid", "exitCode", "exitSignal", "truncated"]) {
      const field = src[key];
      if (field !== undefined) {
        fallback[key] = redactPersistedSummaryField(
          key,
          field,
          MAX_PERSISTED_DETAIL_FALLBACK_STRING_CHARS,
          redactionConfig,
        );
      }
    }
  }
  return fallback;
}

function enforcePersistedDetailsByteCap(
  value: Record<string, unknown>,
  src: Record<string, unknown> | undefined,
  originalSize: BoundedJsonUtf8Bytes,
  redactionConfig?: ToolResultDetailRedactionConfig,
): Record<string, unknown> {
  const sanitizedBytes = jsonUtf8BytesOrInfinity(value);
  if (sanitizedBytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) {
    return value;
  }
  const fallback = buildPersistedDetailsFallback(
    src,
    originalSize,
    sanitizedBytes,
    redactionConfig,
  );
  if (jsonUtf8BytesOrInfinity(fallback) <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) {
    return fallback;
  }
  return {
    persistedDetailsTruncated: true,
    finalDetailsTruncated: true,
    ...originalDetailsSizeFields(originalSize),
    sanitizedDetailsBytes: sanitizedBytes,
  };
}

function enforceRedactedPersistedDetailsByteCap(
  redacted: unknown,
  originalDetails: unknown,
  originalSize: BoundedJsonUtf8Bytes,
  redactionConfig?: ToolResultDetailRedactionConfig,
): unknown {
  const redactedBytes = jsonUtf8BytesOrInfinity(redacted);
  if (redactedBytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) {
    return redacted;
  }
  if (originalDetails && typeof originalDetails === "object" && !Array.isArray(originalDetails)) {
    return buildPersistedDetailsFallback(
      originalDetails as Record<string, unknown>,
      originalSize,
      redactedBytes,
      redactionConfig,
    );
  }
  return {
    persistedDetailsTruncated: true,
    finalDetailsTruncated: true,
    ...originalDetailsSizeFields(originalSize),
    sanitizedDetailsBytes: redactedBytes,
  };
}

function sanitizeToolResultDetailsForPersistence(
  details: unknown,
  redactionConfig?: ToolResultDetailRedactionConfig,
): unknown {
  if (details === undefined || details === null) {
    return details;
  }
  // Measure with an early-exit walker so hostile or enormous details do not
  // need to be fully stringified just to learn they exceed the persistence cap.
  const originalSize = boundedJsonUtf8Bytes(details, MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES);
  if (originalSize.complete && originalSize.bytes <= MAX_PERSISTED_TOOL_RESULT_DETAILS_BYTES) {
    return enforceRedactedPersistedDetailsByteCap(
      redactPersistedDetailValue(details, 0, undefined, redactionConfig),
      details,
      originalSize,
      redactionConfig,
    );
  }
  if (typeof details !== "object") {
    return enforcePersistedDetailsByteCap(
      {
        persistedDetailsTruncated: true,
        ...originalDetailsSizeFields(originalSize),
        valueType: typeof details,
      },
      undefined,
      originalSize,
      redactionConfig,
    );
  }
  const src = details as Record<string, unknown>;
  const out: Record<string, unknown> = {
    persistedDetailsTruncated: true,
    ...originalDetailsSizeFields(originalSize),
    originalDetailKeys: redactedOriginalDetailKeys(src, redactionConfig),
  };
  for (const key of [
    "status",
    "sessionId",
    "pid",
    "startedAt",
    "endedAt",
    "cwd",
    "name",
    "exitCode",
    "exitSignal",
    "retryInMs",
    "total",
    "totalLines",
    "totalChars",
    "truncated",
    "fullOutputPath",
    "truncation",
  ]) {
    const field = src[key];
    if (field !== undefined) {
      out[key] = redactPersistedSummaryField(
        key,
        field,
        MAX_PERSISTED_DETAIL_STRING_CHARS,
        redactionConfig,
      );
    }
  }
  if (typeof src.tail === "string") {
    out.tail = redactPersistedDetailString(
      src.tail,
      MAX_PERSISTED_DETAIL_STRING_CHARS,
      redactionConfig,
    );
  }
  if (Array.isArray(src.sessions)) {
    out.sessions = src.sessions
      .slice(0, MAX_PERSISTED_DETAIL_SESSION_COUNT)
      .map((session) => sanitizePersistedSessionDetail(session, redactionConfig));
    if (src.sessions.length > MAX_PERSISTED_DETAIL_SESSION_COUNT) {
      out.sessionsTruncated = src.sessions.length - MAX_PERSISTED_DETAIL_SESSION_COUNT;
    }
  }
  return enforcePersistedDetailsByteCap(out, src, originalSize, redactionConfig);
}

function capToolResultDetails(
  msg: AgentMessage,
  redactionConfig?: ToolResultDetailRedactionConfig,
): AgentMessage {
  if ((msg as { role?: string }).role !== "toolResult") {
    return msg;
  }
  const details = (msg as { details?: unknown }).details;
  const sanitizedDetails = sanitizeToolResultDetailsForPersistence(details, redactionConfig);
  if (sanitizedDetails === details) {
    return msg;
  }
  const next = { ...msg } as AgentMessage & { details?: unknown };
  next.details = sanitizedDetails;
  return next;
}

function capToolResultForPersistence(
  msg: AgentMessage,
  maxChars: number,
  redactionConfig?: ToolResultDetailRedactionConfig,
): AgentMessage {
  return capToolResultDetails(capToolResultSize(msg, maxChars), redactionConfig);
}

function normalizePersistedToolResultName(
  message: AgentMessage,
  fallbackName?: string,
): AgentMessage {
  if ((message as { role?: unknown }).role !== "toolResult") {
    return message;
  }
  const toolResult = message as Extract<AgentMessage, { role: "toolResult" }>;
  const rawToolName = (toolResult as { toolName?: unknown }).toolName;
  const normalizedToolName = normalizeOptionalString(rawToolName);
  if (normalizedToolName) {
    if (rawToolName === normalizedToolName) {
      return toolResult;
    }
    return { ...toolResult, toolName: normalizedToolName };
  }

  const normalizedFallback = normalizeOptionalString(fallbackName);
  if (normalizedFallback) {
    return { ...toolResult, toolName: normalizedFallback };
  }

  if (typeof rawToolName === "string") {
    return { ...toolResult, toolName: "unknown" };
  }
  return toolResult;
}

function isTranscriptOnlyOpenClawAssistantMessage(message: AgentMessage): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const provider = normalizeOptionalString((message as { provider?: unknown }).provider) ?? "";
  const model = normalizeOptionalString((message as { model?: unknown }).model) ?? "";
  return provider === "openclaw" && (model === "delivery-mirror" || model === "gateway-injected");
}

export { getRawSessionAppendMessage };

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
    /** Optional session key for transcript update broadcasts. */
    sessionKey?: string;
    /**
     * Optional transform applied to any message before persistence.
     */
    transformMessageForPersistence?: (message: AgentMessage) => AgentMessage;
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (
      message: AgentMessage,
      meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
    ) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
    missingToolResultText?: string;
    /**
     * Optional set/list of tool names accepted for assistant toolCall/toolUse blocks.
     * When set, tool calls with unknown names are dropped before persistence.
     */
    allowedToolNames?: Iterable<string>;
    /**
     * Synchronous hook invoked before any message is written to the session JSONL.
     * If the hook returns { block: true }, the message is silently dropped.
     * If it returns { message }, the modified message is written instead.
     */
    beforeMessageWriteHook?: (
      event: PluginHookBeforeMessageWriteEvent,
    ) => PluginHookBeforeMessageWriteResult | undefined;
    redactLoggingConfig?: ToolResultDetailRedactionConfig;
    maxToolResultChars?: number;
    suppressNextUserMessagePersistence?: boolean;
    onUserMessagePersisted?: (
      message: Extract<AgentMessage, { role: "user" }>,
    ) => void | Promise<void>;
  },
): {
  flushPendingToolResults: () => void;
  clearPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = getRawSessionAppendMessage(sessionManager);
  setRawSessionAppendMessage(sessionManager, originalAppend);
  const pendingState = createPendingToolCallState();
  const persistMessage = (message: AgentMessage) => {
    const transformer = opts?.transformMessageForPersistence;
    return transformer ? transformer(message) : message;
  };

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(message, meta) : message;
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
  const missingToolResultText = opts?.missingToolResultText;
  const beforeWrite = opts?.beforeMessageWriteHook;
  const redactionConfig = opts?.redactLoggingConfig;
  const maxToolResultChars = resolveMaxToolResultChars(opts);
  let suppressNextUserMessagePersistence = opts?.suppressNextUserMessagePersistence === true;

  /**
   * Run the before_message_write hook. Returns the (possibly modified) message,
   * or null if the message should be blocked.
   */
  const applyBeforeWriteHook = (msg: AgentMessage): AgentMessage | null => {
    if (!beforeWrite) {
      return msg;
    }
    const result = beforeWrite({ message: msg });
    if (result?.block) {
      return null;
    }
    if (result?.message) {
      return result.message;
    }
    return msg;
  };

  const flushPendingToolResults = () => {
    if (pendingState.size() === 0) {
      return;
    }
    if (allowSyntheticToolResults) {
      for (const [id, name] of pendingState.entries()) {
        const synthetic = makeMissingToolResult({
          toolCallId: id,
          toolName: name,
          text: missingToolResultText,
        });
        const flushed = applyBeforeWriteHook(
          persistToolResult(persistMessage(synthetic), {
            toolCallId: id,
            toolName: name,
            isSynthetic: true,
          }),
        );
        if (flushed) {
          originalAppend(
            capToolResultForPersistence(flushed, maxToolResultChars, redactionConfig) as never,
          );
        }
      }
    }
    pendingState.clear();
  };

  const clearPendingToolResults = () => {
    pendingState.clear();
  };

  const guardedAppend = (message: AgentMessage) => {
    let nextMessage = message;
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      const sanitized = sanitizeToolCallInputs([message], {
        allowedToolNames: opts?.allowedToolNames,
      });
      if (sanitized.length === 0) {
        if (pendingState.shouldFlushForSanitizedDrop()) {
          flushPendingToolResults();
        }
        return undefined;
      }
      nextMessage = sanitized[0];
    }
    const nextRole = (nextMessage as { role?: unknown }).role;

    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pendingState.getToolName(id) : undefined;
      if (id) {
        pendingState.delete(id);
      }
      const normalizedToolResult = normalizePersistedToolResultName(nextMessage, toolName);
      // Apply hard size cap before persistence to prevent oversized tool results
      // from consuming the entire context window on subsequent LLM calls.
      const capped = capToolResultForPersistence(
        persistMessage(normalizedToolResult),
        maxToolResultChars,
        redactionConfig,
      );
      const persisted = applyBeforeWriteHook(
        persistToolResult(capped, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }),
      );
      if (!persisted) {
        return undefined;
      }
      return originalAppend(
        capToolResultForPersistence(persisted, maxToolResultChars, redactionConfig) as never,
      );
    }

    // Skip tool call extraction for aborted/errored assistant messages.
    // When stopReason is "error" or "aborted", the tool_use blocks may be incomplete
    // and should not have synthetic tool_results created. Creating synthetic results
    // for incomplete tool calls causes API 400 errors:
    // "unexpected tool_use_id found in tool_result blocks"
    // This matches the behavior in repairToolUseResultPairing (session-transcript-repair.ts)
    const stopReason = (nextMessage as { stopReason?: string }).stopReason;
    const toolCalls =
      nextRole === "assistant" && stopReason !== "aborted" && stopReason !== "error"
        ? extractToolCallsFromAssistant(nextMessage as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    // Always clear pending tool call state before appending non-tool-result messages.
    // flushPendingToolResults() only inserts synthetic results when allowSyntheticToolResults
    // is true; it always clears the pending map. Without this, providers that disable
    // synthetic results (e.g. OpenAI) accumulate stale pending state when a user message
    // interrupts in-flight tool calls, leaving orphaned tool_use blocks in the transcript
    // that cause API 400 errors on subsequent requests.
    const transcriptOnlyAssistant =
      nextRole === "assistant" &&
      toolCalls.length === 0 &&
      isTranscriptOnlyOpenClawAssistantMessage(nextMessage);
    if (
      !transcriptOnlyAssistant &&
      pendingState.shouldFlushBeforeNonToolResult(nextRole, toolCalls.length)
    ) {
      flushPendingToolResults();
    }
    // If new tool calls arrive while older ones are pending, flush the old ones first.
    if (pendingState.shouldFlushBeforeNewToolCalls(toolCalls.length)) {
      flushPendingToolResults();
    }

    const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
    if (!finalMessage) {
      return undefined;
    }
    if (isUserAgentMessage(finalMessage) && suppressNextUserMessagePersistence) {
      suppressNextUserMessagePersistence = false;
      return undefined;
    }
    const result = originalAppend(finalMessage as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate({
        sessionFile,
        sessionKey: opts?.sessionKey,
        message: finalMessage,
        messageId: typeof result === "string" ? result : undefined,
      });
    }

    if (toolCalls.length > 0) {
      pendingState.trackToolCalls(toolCalls);
    }
    if (isUserAgentMessage(finalMessage)) {
      void opts?.onUserMessagePersisted?.(finalMessage);
    }

    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    clearPendingToolResults,
    getPendingIds: pendingState.getPendingIds,
  };
}
