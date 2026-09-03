/**
 * Parses output from CLI-backed model providers. It supports plain text, JSON,
 * JSONL streaming, Claude stream-json dialects, usage metadata, and tool event
 * reconstruction.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  CliBackendConfig,
  CliBackendParseJsonlEvent,
  CliBackendParseJsonlLifecycleEvent,
} from "../plugins/cli-backend.types.js";
import type { CliOutput } from "./cli-output-contracts.js";
import {
  collectExplicitCliErrorText,
  decodeCliRecords,
  isStreamJsonDialect,
  parseCliJson,
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

/** Parses CLI backend output using the configured JSON/JSONL/plain-text mode. */
export function parseCliOutput(params: {
  raw: string;
  backend: CliBackendConfig;
  providerId: string;
  parseJsonlEvent?: CliBackendParseJsonlEvent;
  parseJsonlLifecycleEvent?: CliBackendParseJsonlLifecycleEvent;
  outputMode?: "json" | "jsonl" | "text";
  fallbackSessionId?: string;
}): CliOutput {
  const outputMode = params.outputMode ?? "text";
  if (outputMode === "text") {
    return { text: params.raw.trim(), sessionId: params.fallbackSessionId };
  }
  if (outputMode === "jsonl") {
    const parser = createCliJsonlStreamingParser({
      backend: params.backend,
      providerId: params.providerId,
      parseJsonlEvent: params.parseJsonlEvent,
      parseJsonlLifecycleEvent: params.parseJsonlLifecycleEvent,
      onAssistantDelta: () => {},
    });
    parser.push(params.raw);
    parser.finish();
    const parsed = parser.getOutput();
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
