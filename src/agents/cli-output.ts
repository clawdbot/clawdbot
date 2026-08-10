/**
 * Parses output from CLI-backed model providers. It supports plain text, JSON,
 * JSONL streaming, Claude stream-json dialects, usage metadata, and tool event
 * reconstruction.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CliBackendConfig, CliBackendParseJsonlEvent } from "../plugins/cli-backend.types.js";
import type { CliOutput, CliUsage } from "./cli-output-contracts.js";
import { isClaudeToolUseBlockType } from "./cli-output-events.js";
import {
  collectExplicitCliErrorText,
  decodeCliRecords,
  isClaudeStreamJsonDialect,
  isClaudeStreamJsonResult,
  isGeminiStreamJsonDialect,
  isStreamJsonDialect,
  missingMessageBoundarySeparator,
  parseClaudeCliJsonlResult,
  parseClaudeCliStreamingDelta,
  parseCliJson,
  pickCliResumeCheckpointId,
  pickCliSessionId,
  preferGeminiCliStreamJsonError,
  preferStreamedClaudeTextOverResult,
  readCliUsage,
  readGeminiCliStreamJsonError,
} from "./cli-output-records.js";
import {
  CLI_STREAM_JSON_MISSING_RESULT_ERROR,
  createCliJsonlStreamingParser,
} from "./cli-output-stream.js";

function normalizeCliContextValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized ? truncateUtf16Safe(normalized, 200) : undefined;
}

export function formatCliOutputError(
  output: CliOutput,
  attribution: { runId?: string; sessionId?: string } = {},
): string {
  if (output.terminalFailure?.reason !== "max_turns") {
    return output.errorText || "CLI failed.";
  }

  const runId = normalizeCliContextValue(attribution.runId);
  const sessionId = normalizeCliContextValue(attribution.sessionId);
  const cliSessionId = normalizeCliContextValue(output.sessionId);
  const context = [
    runId ? `OpenClaw run: ${runId}.` : undefined,
    sessionId ? `OpenClaw session: ${sessionId}.` : undefined,
    cliSessionId ? `Claude session: ${cliSessionId}.` : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  const limit = output.terminalFailure.limit;
  return [
    `Claude CLI stopped after reaching the maximum number of turns${limit ? ` (limit: ${limit})` : ""}.`,
    ...context,
    "Tool actions may already have run; verify their effects before retrying.",
    "Retry with a higher --max-turns value or a narrower task.",
  ].join(" ");
}

/** Parses complete JSONL CLI output into the final assistant result and metadata. */
/** Parses complete JSONL output from a CLI backend into normalized text and metadata. */
function parseCliJsonl(
  raw: string,
  backend: CliBackendConfig,
  providerId: string,
): CliOutput | null {
  const lines = normalizeStringEntries(raw.split(/\r?\n/g));
  if (lines.length === 0) {
    return null;
  }
  let sessionId: string | undefined;
  let resumeCheckpointId: string | undefined;
  let usage: CliUsage | undefined;
  let diagnosticUsage: CliUsage | undefined;
  const texts: string[] = [];
  let streamJsonText = "";
  let pendingMessageSeparator = false;
  let currentMessageStart = 0;
  let segmentStart = 0;
  let preserveFrom = 0;
  let sawToolUseSinceText = false;
  let currentMessageHadToolUse = false;
  let previousMessageHadToolUse = false;
  let committedResult: CliOutput | null = null;
  let geminiErrorText: string | undefined;
  let sawGeminiStructuredOutput = false;
  const streamJsonDialect = isStreamJsonDialect({ backend, providerId });
  for (const line of lines) {
    for (const parsed of decodeCliRecords(line)) {
      sessionId = pickCliSessionId(parsed, backend) ?? sessionId;
      if (!sessionId && typeof parsed.thread_id === "string") {
        sessionId = parsed.thread_id.trim();
      }
      resumeCheckpointId =
        pickCliResumeCheckpointId({ backend, providerId, parsed }) ?? resumeCheckpointId;
      const nextUsage = readCliUsage(parsed);
      const isClaudeTerminalResult =
        isClaudeStreamJsonDialect({ backend, providerId }) && parsed.type === "result";
      if (isClaudeTerminalResult && nextUsage && usage) {
        diagnosticUsage = nextUsage;
      }
      const shouldUseUsage = !isClaudeStreamJsonResult({ backend, providerId, parsed }) || !usage;
      if (shouldUseUsage) {
        usage = nextUsage ?? usage;
      }

      if (isGeminiStreamJsonDialect({ backend, providerId })) {
        const nextGeminiErrorText = readGeminiCliStreamJsonError(parsed);
        if (nextGeminiErrorText) {
          geminiErrorText = preferGeminiCliStreamJsonError(geminiErrorText, nextGeminiErrorText);
          sawGeminiStructuredOutput = true;
          continue;
        }
        if (
          parsed.type === "message" &&
          parsed.role === "assistant" &&
          typeof parsed.content === "string"
        ) {
          streamJsonText = `${streamJsonText}${parsed.content}`;
          sawGeminiStructuredOutput = true;
          continue;
        }
        if (
          parsed.type === "tool_use" ||
          parsed.type === "tool_result" ||
          parsed.type === "result"
        ) {
          sawGeminiStructuredOutput = true;
        }
      }

      const claudeResult = parseClaudeCliJsonlResult({
        backend,
        providerId,
        parsed,
        sessionId,
        usage,
      });
      if (claudeResult) {
        if (claudeResult.errorText) {
          return {
            ...claudeResult,
            ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
          };
        }
        // Live sessions reparse the completed JSONL transcript, so preserve
        // streamed text here as well as in the incremental parser above, and
        // keep scanning: an interim result can be followed by more stream
        // events and the actual terminal result.
        const streamedText = streamJsonText.slice(segmentStart).trim();
        const preservedCandidate = streamJsonText.slice(preserveFrom).trim();
        const keepStreamed = preferStreamedClaudeTextOverResult({
          streamedText: preservedCandidate,
          finalMessageText: streamJsonText.slice(currentMessageStart).trim(),
          resultText: claudeResult.text,
        });
        const nextText = (
          keepStreamed
            ? preservedCandidate
            : claudeResult.text || streamedText || texts.join("\n").trim()
        ).trim();
        const previousText = committedResult?.text?.trim() ?? "";
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
        committedResult = {
          ...claudeResult,
          text,
          ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
          ...(diagnosticUsage ? { diagnosticUsage } : {}),
        };
        segmentStart = streamJsonText.length;
        currentMessageStart = segmentStart;
        preserveFrom = segmentStart;
        pendingMessageSeparator = false;
        sawToolUseSinceText = false;
        currentMessageHadToolUse = false;
        previousMessageHadToolUse = false;
        continue;
      }

      if (parsed.type === "stream_event" && isRecord(parsed.event)) {
        // Same boundary contracts as the incremental parser above.
        if (parsed.event.type === "message_start") {
          pendingMessageSeparator = true;
          previousMessageHadToolUse = currentMessageHadToolUse;
          currentMessageHadToolUse = false;
        }
        if (
          parsed.event.type === "content_block_start" &&
          isRecord(parsed.event.content_block) &&
          isClaudeToolUseBlockType(parsed.event.content_block.type)
        ) {
          sawToolUseSinceText = true;
          currentMessageHadToolUse = true;
        }
      }
      const claudeDelta = parseClaudeCliStreamingDelta({
        backend,
        providerId,
        parsed,
        textSoFar: streamJsonText,
        sessionId,
        usage,
      });
      if (claudeDelta) {
        const boundaryPending = pendingMessageSeparator || sawToolUseSinceText;
        const isToolSplitBoundary = pendingMessageSeparator
          ? previousMessageHadToolUse
          : sawToolUseSinceText;
        const separator =
          boundaryPending && streamJsonText
            ? missingMessageBoundarySeparator(streamJsonText, claudeDelta.delta)
            : "";
        if (boundaryPending && streamJsonText) {
          currentMessageStart = streamJsonText.length + separator.length;
          if (!isToolSplitBoundary) {
            preserveFrom = currentMessageStart;
          }
        }
        pendingMessageSeparator = false;
        sawToolUseSinceText = false;
        streamJsonText = `${streamJsonText}${separator}${claudeDelta.delta}`;
        continue;
      }

      const item = isRecord(parsed.item) ? parsed.item : null;
      if (item && typeof item.text === "string") {
        const type = normalizeLowercaseStringOrEmpty(item.type);
        if (!type || type.includes("message")) {
          texts.push(item.text);
        }
      }
    }
  }
  if (committedResult) {
    return committedResult;
  }
  if (isGeminiStreamJsonDialect({ backend, providerId }) && geminiErrorText) {
    return { text: "", sessionId, usage, errorText: geminiErrorText };
  }
  if (streamJsonDialect && (streamJsonText.trim() || sawGeminiStructuredOutput)) {
    return {
      text: streamJsonText.trim(),
      sessionId,
      usage,
      ...(resumeCheckpointId ? { resumeCheckpointId } : {}),
    };
  }
  if (streamJsonDialect) {
    return { text: "", sessionId, usage, errorText: CLI_STREAM_JSON_MISSING_RESULT_ERROR };
  }
  const text = texts.join("\n").trim();
  if (!text) {
    return null;
  }
  return { text, sessionId, usage };
}

/** Parses CLI output according to the backend output mode with text fallback. */
/** Parses CLI backend output using the configured JSON/JSONL/plain-text mode. */
export function parseCliOutput(params: {
  raw: string;
  backend: CliBackendConfig;
  providerId: string;
  parseJsonlEvent?: CliBackendParseJsonlEvent;
  outputMode?: "json" | "jsonl" | "text";
  fallbackSessionId?: string;
}): CliOutput {
  const outputMode = params.outputMode ?? "text";
  if (outputMode === "text") {
    return { text: params.raw.trim(), sessionId: params.fallbackSessionId };
  }
  if (outputMode === "jsonl") {
    let parsed: CliOutput | null;
    if (params.parseJsonlEvent) {
      const parser = createCliJsonlStreamingParser({
        backend: params.backend,
        providerId: params.providerId,
        parseJsonlEvent: params.parseJsonlEvent,
        onAssistantDelta: () => {},
      });
      parser.push(params.raw);
      parser.finish();
      parsed = parser.getOutput();
    } else {
      parsed = parseCliJsonl(params.raw, params.backend, params.providerId);
    }
    if (parsed) {
      return parsed;
    }
    if (isStreamJsonDialect(params)) {
      return {
        text: "",
        sessionId: params.fallbackSessionId,
        errorText: CLI_STREAM_JSON_MISSING_RESULT_ERROR,
      };
    }
    return { text: params.raw.trim(), sessionId: params.fallbackSessionId };
  }
  return (
    parseCliJson(params.raw, params.backend, params.providerId) ?? {
      text: params.raw.trim(),
      sessionId: params.fallbackSessionId,
    }
  );
}

/** Extracts the most specific structured CLI error message from mixed or JSON output. */
/** Extracts a human-readable error message from mixed CLI stderr/stdout text. */
export function extractCliErrorMessage(raw: string): string | null {
  const parsedRecords = decodeCliRecords(raw);
  if (parsedRecords.length === 0) {
    return null;
  }

  let errorText = "";
  for (const parsed of parsedRecords) {
    const next = collectExplicitCliErrorText(parsed);
    if (next) {
      errorText = next;
    }
  }

  return errorText || null;
}
