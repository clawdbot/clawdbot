import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  CliBackendParseJsonlEvent,
  CliBackendParsedJsonlEvent,
} from "../plugins/cli-backend.types.js";
import type {
  CliJsonlStreamingParserOptions,
  CliOutput,
  CliStreamJsonOutputLimits,
  CliUsage,
} from "./cli-output-contracts.js";
import type { CliEventProjectionState } from "./cli-output-events.js";
import {
  createLeadingTaggedReasoningRouter,
  createThinkingTracker,
  createToolUseTracker,
  dispatchClaudeCliStreamingToolEvent,
  dispatchClaudeCliThinking,
  dispatchGeminiCliStreamingToolEvent,
  isClaudeToolUseBlockType,
  partitionLeadingTaggedReasoning,
  projectCliBackendEvent,
  projectCliTaggedReasoning,
} from "./cli-output-events.js";
import {
  decodeCliRecords,
  isClaudeStreamJsonDialect,
  isClaudeStreamJsonResult,
  isClaudeSubagentRecord,
  isGeminiStreamJsonDialect,
  isStreamJsonDialect,
  missingMessageBoundarySeparator,
  parseClaudeCliJsonlResult,
  parseClaudeCliStreamingDelta,
  pickCliResumeCheckpointId,
  pickCliSessionId,
  preferGeminiCliStreamJsonError,
  preferStreamedClaudeTextOverResult,
  readCliUsage,
  readGeminiCliStreamJsonError,
  supportsCliJsonlToolEvents,
} from "./cli-output-records.js";

export const CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS = 8 * 1024 * 1024;
const CLI_STREAM_JSON_DEFAULT_MAX_TURN_LINES = 20_000;
export const CLI_STREAM_JSON_MISSING_RESULT_ERROR =
  "CLI stream-json output ended without a result event.";
const CLAUDE_SYNTHETIC_NO_RESPONSE_ERROR = "Claude CLI returned a synthetic no-response result.";

export const CLI_STREAM_JSON_OUTPUT_LIMITS = Object.freeze({
  maxTurnRawChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  maxPendingLineChars: CLI_STREAM_JSON_DEFAULT_MAX_TURN_RAW_CHARS,
  maxTurnLines: CLI_STREAM_JSON_DEFAULT_MAX_TURN_LINES,
} satisfies CliStreamJsonOutputLimits);

function isClaudeSyntheticNoResponse(parsed: Record<string, unknown>): boolean {
  if (parsed.type !== "assistant" || !isRecord(parsed.message)) {
    return false;
  }
  const message = parsed.message;
  if (message.model !== "<synthetic>" || !Array.isArray(message.content)) {
    return false;
  }
  return (
    message.content.length === 1 &&
    isRecord(message.content[0]) &&
    message.content[0].type === "text" &&
    message.content[0].text === "No response requested."
  );
}

/** Frames arbitrary stdout chunks while bounding each individual raw JSONL line. */
export function frameBoundedCliJsonlChunk(
  state: { pending: string },
  chunk: string,
  maxLineChars: number,
  onLine: (line: string) => boolean | void,
): boolean {
  for (let offset = 0; offset < chunk.length;) {
    const newlineIndex = chunk.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
    if (state.pending.length + (lineEnd - offset) > maxLineChars) {
      state.pending = "";
      return false;
    }
    state.pending += chunk.slice(offset, lineEnd);
    if (newlineIndex === -1) {
      return true;
    }
    const line = state.pending;
    // Control-response writes can synchronously reenter stdout framing.
    state.pending = "";
    offset = newlineIndex + 1;
    if (onLine(line) === false) {
      return true;
    }
  }
  return true;
}

/** Drops Claude's echoed binary bytes before they enter retained tool/transcript state. */
export function normalizeClaudeCliStreamJsonRecord(
  parsed: Record<string, unknown>,
): { line: string; omittedRawChars: number } | undefined {
  if (parsed.type !== "user" || !isRecord(parsed.message)) {
    return undefined;
  }
  const content = Array.isArray(parsed.message.content) ? parsed.message.content : [];
  let normalized = false;
  let omittedRawChars = 0;
  for (const result of content) {
    if (!isRecord(result) || result.type !== "tool_result" || !Array.isArray(result.content)) {
      continue;
    }
    for (const block of result.content) {
      if (!isRecord(block) || !isRecord(block.source) || block.source.type !== "base64") {
        continue;
      }
      if (
        block.type !== "image" &&
        !(block.type === "document" && block.source.media_type === "application/pdf")
      ) {
        continue;
      }
      const { data, ...source } = block.source;
      if (typeof data !== "string") {
        continue;
      }
      block.source = source;
      block.omitted = true;
      block.bytes = estimateBase64DecodedBytes(data);
      omittedRawChars += data.length;
      normalized = true;
    }
  }
  return normalized ? { line: JSON.stringify(parsed), omittedRawChars } : undefined;
}

function streamJsonOutputLimitErrorText(kind: "raw" | "line" | "lines", limit: number): string {
  if (kind === "line") {
    return `CLI JSONL line exceeded ${limit} characters; refusing to parse output.`;
  }
  if (kind === "lines") {
    return `CLI JSONL output exceeded ${limit} lines; refusing to parse output.`;
  }
  return `CLI JSONL output exceeded ${limit} characters; refusing to parse output.`;
}

export function createCliJsonlStreamingParser(params: CliJsonlStreamingParserOptions) {
  const lineBuffer = { pending: "" };
  let assistantText = "";
  let customThinkingText = "";
  let pendingClaudeText = "";
  let pendingMessageSeparator = false;
  let currentMessageStart = 0;
  let segmentStart = 0;
  // Streamed text from this offset on is still a candidate to outrank the
  // result envelope; every non-tool boundary or interim result restarts it.
  let preserveFrom = 0;
  let sawToolUseSinceText = false;
  let currentMessageHadToolUse = false;
  let previousMessageHadToolUse = false;
  let sessionId: string | undefined;
  let resumeCheckpointId: string | undefined;
  let usage: CliUsage | undefined;
  let diagnosticUsage: CliUsage | undefined;
  let output: CliOutput | null = null;
  let parseErrorText = "";
  let rawChars = 0;
  let rawLines = 0;
  const texts: string[] = [];
  let sawCustomJsonlEvent = false;
  let sawGeminiStructuredOutput = false;
  let sawTerminalResult = false;
  let sawClaudeSyntheticNoResponse = false;
  const toolTracker = createToolUseTracker();
  const outputLimits = CLI_STREAM_JSON_OUTPUT_LIMITS;
  // Classification is keyed on consumer presence so reclassified pre-tool text
  // always has a destination; a separate enable flag let it be dropped (#92092).
  const classifyClaudeCommentary =
    Boolean(params.onCommentaryText) && supportsCliJsonlToolEvents(params);
  const thinkingTracker = createThinkingTracker();
  const claudeStreamJson = isClaudeStreamJsonDialect(params);
  let taggedReasoningRouter = createLeadingTaggedReasoningRouter();
  let currentTaggedReasoningText = "";

  const flushPendingClaudeAssistantText = () => {
    if (!pendingClaudeText) {
      return;
    }
    const delta = pendingClaudeText;
    pendingClaudeText = "";
    assistantText = `${assistantText}${delta}`;
    params.onAssistantDelta({
      text: assistantText,
      delta,
      sessionId,
      usage,
    });
  };

  const flushPendingClaudeCommentaryText = () => {
    if (!pendingClaudeText) {
      return;
    }
    const text = pendingClaudeText.trim();
    pendingClaudeText = "";
    if (text) {
      params.onCommentaryText?.(text);
    }
  };

  const emitClaudeVisibleText = (delta: string) => {
    if (!delta) {
      return;
    }
    if (classifyClaudeCommentary) {
      pendingClaudeText = `${pendingClaudeText}${delta}`;
      return;
    }
    // A tool_use block starts a new post-tool segment even inside one assistant
    // message; only tool-split boundaries may later outrank the result envelope.
    // A message boundary is a tool split only when the PREVIOUS message used a
    // tool: a tool-first fresh message must not connect an earlier draft, while
    // a tool-using message keeps its text connected across its own boundary.
    const boundaryPending = pendingMessageSeparator || sawToolUseSinceText;
    const isToolSplitBoundary = pendingMessageSeparator
      ? previousMessageHadToolUse
      : sawToolUseSinceText;
    const separator =
      boundaryPending && assistantText ? missingMessageBoundarySeparator(assistantText, delta) : "";
    if (boundaryPending && assistantText) {
      currentMessageStart = assistantText.length + separator.length;
      // Text before a non-tool boundary may be a superseded draft; only text
      // connected to the result through tool splits stays a candidate.
      if (!isToolSplitBoundary) {
        preserveFrom = currentMessageStart;
      }
    }
    pendingMessageSeparator = false;
    sawToolUseSinceText = false;
    const deltaText = `${separator}${delta}`;
    assistantText = `${assistantText}${deltaText}`;
    params.onAssistantDelta({ text: assistantText, delta: deltaText, sessionId, usage });
  };

  const routeTaggedReasoningDeltas = (
    deltas: Parameters<typeof projectCliTaggedReasoning>[0]["deltas"],
  ) => {
    currentTaggedReasoningText = projectCliTaggedReasoning({
      deltas,
      currentText: currentTaggedReasoningText,
      hasNativeThinking: Boolean(thinkingTracker.emittedText),
      onThinkingDelta: params.onThinkingDelta,
      onVisibleText: emitClaudeVisibleText,
    });
  };

  const finishTaggedReasoningMessage = () => {
    if (claudeStreamJson) {
      routeTaggedReasoningDeltas(taggedReasoningRouter.finish());
    }
  };

  const beginTaggedReasoningMessage = () => {
    finishTaggedReasoningMessage();
    taggedReasoningRouter = createLeadingTaggedReasoningRouter();
    currentTaggedReasoningText = "";
  };

  const handleCustomJsonlEvent = (event: CliBackendParsedJsonlEvent) => {
    const state: CliEventProjectionState = {
      assistantText,
      customThinkingText,
      sessionId,
      usage,
      output,
      sawCustomJsonlEvent,
    };
    projectCliBackendEvent({
      ...params,
      event,
      state,
      texts,
      toolTracker,
    });
    ({ assistantText, customThinkingText, sessionId, usage, output, sawCustomJsonlEvent } = state);
  };

  const accountClaudeJsonlLine = (lineChars: number): boolean => {
    rawChars += lineChars + 1;
    if (rawChars <= outputLimits.maxTurnRawChars) {
      return true;
    }
    parseErrorText = streamJsonOutputLimitErrorText("raw", outputLimits.maxTurnRawChars);
    lineBuffer.pending = "";
    return false;
  };

  const handleCustomJsonlLine = (line: string, rawLine: string): boolean => {
    if (parseErrorText) {
      return true;
    }
    if (!params.parseJsonlEvent) {
      return false;
    }
    let parsed: ReturnType<CliBackendParseJsonlEvent>;
    try {
      parsed = params.parseJsonlEvent(line, {
        backendId: params.providerId,
        backend: params.backend,
      });
    } catch (error) {
      parseErrorText = truncateUtf16Safe(
        `CLI backend ${params.providerId} JSONL parser failed: ${formatErrorMessage(error)}`,
        500,
      );
      return true;
    }
    if (parsed == null) {
      return false;
    }
    if (claudeStreamJson && !accountClaudeJsonlLine(rawLine.length)) {
      return true;
    }
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      if (event.kind === "result") {
        sawTerminalResult = true;
      }
      handleCustomJsonlEvent(event);
    }
    return true;
  };

  const handleParsedRecord = (parsed: Record<string, unknown>) => {
    if (parseErrorText) {
      return;
    }
    const parsedSessionId = pickCliSessionId(parsed, params.backend);
    if (parsed.type === "result" && isStreamJsonDialect(params)) {
      sawTerminalResult = true;
    }
    if (parsedSessionId && parsedSessionId !== sessionId) {
      sessionId = parsedSessionId;
      params.onSessionId?.(parsedSessionId);
    }
    const nextUsage = readCliUsage(parsed);
    const isClaudeTerminalResult =
      isClaudeStreamJsonDialect({
        backend: params.backend,
        providerId: params.providerId,
      }) && parsed.type === "result";
    if (isClaudeTerminalResult && nextUsage && usage) {
      diagnosticUsage = nextUsage;
    }
    if (nextUsage) {
      params.onUsage?.(nextUsage, isClaudeTerminalResult);
    }
    const shouldUseUsage =
      !isClaudeStreamJsonResult({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
      }) || !usage;
    if (shouldUseUsage) {
      usage = nextUsage ?? usage;
    }
    if (
      parsed.type === "assistant" &&
      isRecord(parsed.message) &&
      !isClaudeSubagentRecord(parsed)
    ) {
      resumeCheckpointId = pickCliResumeCheckpointId({ ...params, parsed }) ?? resumeCheckpointId;
      params.onAssistantMessage?.(parsed.message);
      if (claudeStreamJson && isClaudeSyntheticNoResponse(parsed)) {
        sawClaudeSyntheticNoResponse = true;
      }
    }
    const geminiErrorText = isGeminiStreamJsonDialect(params)
      ? readGeminiCliStreamJsonError(parsed)
      : undefined;
    if (
      isGeminiStreamJsonDialect(params) &&
      (parsed.type === "tool_use" || parsed.type === "tool_result" || parsed.type === "result")
    ) {
      sawGeminiStructuredOutput = true;
    }
    if (geminiErrorText) {
      output = {
        text: "",
        sessionId,
        usage,
        errorText: preferGeminiCliStreamJsonError(output?.errorText, geminiErrorText),
      };
      return;
    }

    if (classifyClaudeCommentary && parsed.type === "result") {
      finishTaggedReasoningMessage();
      flushPendingClaudeAssistantText();
    } else if (parsed.type === "result") {
      finishTaggedReasoningMessage();
    }

    let result = parseClaudeCliJsonlResult({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
      sessionId,
      usage,
    });
    if (result) {
      if (result.errorText) {
        output = result;
        return;
      }
      if (claudeStreamJson && result.text) {
        const taggedResult = partitionLeadingTaggedReasoning(result.text, true);
        if (!taggedResult.pending && taggedResult.reasoningText) {
          if (
            !thinkingTracker.emittedText &&
            taggedResult.reasoningText !== currentTaggedReasoningText
          ) {
            currentTaggedReasoningText = projectCliTaggedReasoning({
              deltas: [{ kind: "thinking", text: taggedResult.reasoningText }],
              currentText: "",
              hasNativeThinking: false,
              onThinkingDelta: params.onThinkingDelta,
              onVisibleText: emitClaudeVisibleText,
            });
          }
          result = { ...result, text: taggedResult.visibleText.trim() };
        }
      }
      // Empty terminal result can follow already-streamed text; keep that text.
      const streamedText = assistantText.slice(segmentStart).trim();
      const preservedCandidate = assistantText.slice(preserveFrom).trim();
      const keepStreamed = preferStreamedClaudeTextOverResult({
        streamedText: preservedCandidate,
        finalMessageText: assistantText.slice(currentMessageStart).trim(),
        resultText: result.text,
      });
      const nextText = (
        keepStreamed ? preservedCandidate : result.text || streamedText || texts.join("\n").trim()
      ).trim();
      const previousText = output?.text?.trim() ?? "";
      // Claude Code may emit an interim result while background agents run, then
      // a second result after task-notification. Preserve earlier result text
      // when the later envelope does not already include it.
      let text = nextText;
      if (
        previousText &&
        nextText &&
        previousText !== nextText &&
        !nextText.startsWith(previousText)
      ) {
        text = `${previousText}\n${nextText}`;
      } else if (!nextText) {
        text = previousText;
      }
      const syntheticNoResponse =
        sawClaudeSyntheticNoResponse &&
        parsed.subtype === "success" &&
        !text &&
        toolTracker.pendingByIndex.size === 0 &&
        toolTracker.startedIds.size === 0 &&
        toolTracker.resultDeliveredIds.size === 0;
      output = {
        ...result,
        text,
        ...(syntheticNoResponse
          ? {
              errorText: CLAUDE_SYNTHETIC_NO_RESPONSE_ERROR,
              terminalFailure: { reason: "synthetic_no_response" as const },
            }
          : {}),
        ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
        ...(diagnosticUsage ? { diagnosticUsage } : {}),
      };
      // An interim result commits its segment. Rebase boundary state so later
      // text is judged on its own, while delta snapshots stay cumulative.
      segmentStart = assistantText.length;
      currentMessageStart = segmentStart;
      preserveFrom = segmentStart;
      pendingMessageSeparator = false;
      sawToolUseSinceText = false;
      currentMessageHadToolUse = false;
      previousMessageHadToolUse = false;
      return;
    }

    const item = isRecord(parsed.item) ? parsed.item : null;
    if (item && typeof item.text === "string") {
      const type = normalizeLowercaseStringOrEmpty(item.type);
      if (!type || type.includes("message")) {
        texts.push(item.text);
      }
    }

    if (parsed.type === "stream_event" && isRecord(parsed.event)) {
      const evt = parsed.event;
      // Tool-split turns stream as separate assistant messages. Mark the
      // boundary so accumulated text joins with a paragraph break instead of
      // gluing the pre-tool text to the next message's first delta.
      if (evt.type === "message_start") {
        beginTaggedReasoningMessage();
        pendingMessageSeparator = true;
        previousMessageHadToolUse = currentMessageHadToolUse;
        currentMessageHadToolUse = false;
      } else if (evt.type === "message_stop") {
        finishTaggedReasoningMessage();
      }
      const isToolUseBlockStart =
        evt.type === "content_block_start" &&
        isRecord(evt.content_block) &&
        isClaudeToolUseBlockType(evt.content_block.type);
      if (isToolUseBlockStart) {
        sawToolUseSinceText = true;
        currentMessageHadToolUse = true;
      }
      if (classifyClaudeCommentary) {
        if (isToolUseBlockStart) {
          flushPendingClaudeCommentaryText();
        } else if (evt.type === "content_block_start" || evt.type === "message_stop") {
          flushPendingClaudeAssistantText();
        }
      }
    }

    if (params.onThinkingDelta || params.onThinkingProgress) {
      dispatchClaudeCliThinking({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: thinkingTracker,
        onThinkingDelta: params.onThinkingDelta,
        onThinkingProgress: params.onThinkingProgress,
      });
    }

    if (params.onToolUseStart || params.onToolResult) {
      dispatchGeminiCliStreamingToolEvent({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: toolTracker,
        onToolUseStart: params.onToolUseStart,
        onToolResult: params.onToolResult,
      });
    }
    if (claudeStreamJson || params.onToolUseStart || params.onToolResult) {
      dispatchClaudeCliStreamingToolEvent({
        backend: params.backend,
        providerId: params.providerId,
        parsed,
        tracker: toolTracker,
        onToolUseStart: params.onToolUseStart,
        onToolResult: params.onToolResult,
      });
    }

    const delta = parseClaudeCliStreamingDelta({
      backend: params.backend,
      providerId: params.providerId,
      parsed,
    });
    if (!delta) {
      if (
        isGeminiStreamJsonDialect(params) &&
        parsed.type === "message" &&
        parsed.role === "assistant" &&
        typeof parsed.content === "string"
      ) {
        const deltaText = parsed.content;
        if (deltaText) {
          assistantText = `${assistantText}${deltaText}`;
          params.onAssistantDelta({
            text: assistantText,
            delta: deltaText,
            sessionId,
            usage,
          });
        }
      } else if (
        isGeminiStreamJsonDialect(params) &&
        parsed.type === "result" &&
        parsed.status === "success"
      ) {
        output = {
          text: assistantText.trim(),
          sessionId,
          usage,
        };
      }
      return;
    }
    if (claudeStreamJson) {
      routeTaggedReasoningDeltas(taggedReasoningRouter.push(delta));
      return;
    }
    emitClaudeVisibleText(delta);
  };

  const handleJsonlLine = (rawLine: string) => {
    if (parseErrorText) {
      return;
    }
    const line = rawLine.trim();
    if (!line && !claudeStreamJson) {
      return;
    }
    rawLines += 1;
    if (rawLines > outputLimits.maxTurnLines) {
      parseErrorText = streamJsonOutputLimitErrorText("lines", outputLimits.maxTurnLines);
      lineBuffer.pending = "";
      return;
    }
    if (!line) {
      accountClaudeJsonlLine(rawLine.length);
      return;
    }
    if (handleCustomJsonlLine(line, rawLine)) {
      return;
    }
    const parsedRecords = decodeCliRecords(line);
    if (claudeStreamJson) {
      const normalized =
        parsedRecords.length === 1
          ? normalizeClaudeCliStreamJsonRecord(parsedRecords[0]!)
          : undefined;
      // Exempt actual media bytes only; JSON serialization must not erase wire whitespace.
      const retainedChars = normalized
        ? Math.max(normalized.line.length, rawLine.length - normalized.omittedRawChars)
        : rawLine.length;
      if (!accountClaudeJsonlLine(retainedChars)) {
        return;
      }
    }
    for (const parsed of parsedRecords) {
      handleParsedRecord(parsed);
    }
  };

  return {
    push(chunk: string) {
      if (!chunk || parseErrorText) {
        return;
      }
      if (!claudeStreamJson) {
        rawChars += chunk.length;
        if (rawChars > outputLimits.maxTurnRawChars) {
          parseErrorText = streamJsonOutputLimitErrorText("raw", outputLimits.maxTurnRawChars);
          lineBuffer.pending = "";
          return;
        }
      }
      if (
        !frameBoundedCliJsonlChunk(lineBuffer, chunk, outputLimits.maxPendingLineChars, (line) => {
          handleJsonlLine(line);
          return !parseErrorText;
        })
      ) {
        parseErrorText = streamJsonOutputLimitErrorText("line", outputLimits.maxPendingLineChars);
      }
    },
    finish() {
      if (parseErrorText) {
        return;
      }
      const tail = lineBuffer.pending;
      lineBuffer.pending = "";
      if (tail) {
        handleJsonlLine(tail);
      }
      finishTaggedReasoningMessage();
      if (classifyClaudeCommentary) {
        flushPendingClaudeAssistantText();
      }
    },
    getErrorText() {
      return parseErrorText || null;
    },
    hasTerminalResult() {
      return sawTerminalResult;
    },
    getOutput() {
      if (parseErrorText) {
        return {
          text: "",
          sessionId,
          usage,
          ...(diagnosticUsage ? { diagnosticUsage } : {}),
          errorText: parseErrorText,
        };
      }
      if (output) {
        return output;
      }
      if (rawLines === 0) {
        return null;
      }
      if (sawCustomJsonlEvent) {
        return { text: texts.join("\n").trim() || assistantText.trim(), sessionId, usage };
      }
      if (isStreamJsonDialect(params) && assistantText.trim()) {
        return {
          text: assistantText.trim(),
          sessionId,
          usage,
          ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
        };
      }
      if (isGeminiStreamJsonDialect(params) && sawGeminiStructuredOutput) {
        return { text: "", sessionId, usage };
      }
      if (isStreamJsonDialect(params)) {
        return {
          text: "",
          sessionId,
          usage,
          errorText: CLI_STREAM_JSON_MISSING_RESULT_ERROR,
        };
      }
      const text = texts.join("\n").trim();
      return text
        ? { text, sessionId, usage, ...(resumeCheckpointId ? { resumeCheckpointId } : {}) }
        : null;
    },
  };
}
