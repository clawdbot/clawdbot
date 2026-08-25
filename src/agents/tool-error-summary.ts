/**
 * Compact tool error summary types.
 *
 * Stores failure metadata used by transcripts, retry behavior, and mutation recovery logic.
 */
import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { readToolResultDetails } from "./tool-result-error.js";

export type ProcessTerminalDiagnostic = {
  kind: "process";
  sessionId: string;
  reason:
    | { kind: "exit"; exitCode: number }
    | { kind: "signal"; signal: string | number }
    | {
        kind: "timeout";
        timeoutKind?: "overall-timeout" | "no-output-timeout";
      };
};

export function hasTerminalControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

const PROCESS_TERMINATION_REASONS = new Set([
  "manual-cancel",
  "overall-timeout",
  "no-output-timeout",
  "spawn-error",
  "signal",
  "exit",
]);

function readSafeProcessSessionId(value: unknown): string | undefined {
  const sessionId = readStringValue(value)?.trim();
  if (!sessionId || sessionId.length > 160 || hasTerminalControlCharacter(sessionId)) {
    return undefined;
  }
  return sessionId;
}

export function buildProcessTerminalDiagnostic(
  toolName: string,
  args: Record<string, unknown>,
  sanitizedResult: unknown,
): ProcessTerminalDiagnostic | undefined {
  if (toolName !== "process") {
    return undefined;
  }
  const action = normalizeOptionalLowercaseString(args.action);
  if (action !== "poll" && action !== "log") {
    return undefined;
  }
  const details = readToolResultDetails(sanitizedResult);
  const sessionId = readSafeProcessSessionId(details?.sessionId);
  if (!sessionId) {
    return undefined;
  }

  const exitReason = normalizeOptionalLowercaseString(details?.exitReason);
  const hasCanonicalExitReason = PROCESS_TERMINATION_REASONS.has(exitReason ?? "");
  if (action === "log" && !hasCanonicalExitReason) {
    return undefined;
  }
  const timeoutKind =
    exitReason === "overall-timeout" || exitReason === "no-output-timeout" ? exitReason : undefined;
  let reason: ProcessTerminalDiagnostic["reason"] | undefined;
  if (details?.timedOut === true || timeoutKind) {
    reason = { kind: "timeout", ...(timeoutKind ? { timeoutKind } : {}) };
  } else if (
    (typeof details?.exitSignal === "string" &&
      details.exitSignal.trim().length > 0 &&
      details.exitSignal.trim().length <= 32) ||
    (typeof details?.exitSignal === "number" && Number.isFinite(details.exitSignal))
  ) {
    const signal =
      typeof details.exitSignal === "string" ? details.exitSignal.trim() : details.exitSignal;
    if (!hasTerminalControlCharacter(String(signal))) {
      reason = { kind: "signal", signal };
    }
  } else if (
    typeof details?.exitCode === "number" &&
    Number.isSafeInteger(details.exitCode) &&
    details.exitCode !== 0
  ) {
    reason = { kind: "exit", exitCode: details.exitCode };
  }
  if (!reason) {
    return undefined;
  }

  return {
    kind: "process",
    sessionId,
    reason,
  };
}

export type ToolErrorSummary = {
  toolName: string;
  executionStarted?: boolean;
  meta?: string;
  errorCode?: string;
  error?: string;
  validationErrorSummary?: string;
  timedOut?: boolean;
  middlewareError?: boolean;
  mutatingAction?: boolean;
  terminalDiagnostic?: ProcessTerminalDiagnostic;
};

const EXEC_LIKE_TOOL_NAMES = new Set(["exec", "bash"]);

/** Detects shell-execution tools that share retry and mutation semantics. */
export function isExecLikeToolName(toolName: string): boolean {
  return EXEC_LIKE_TOOL_NAMES.has(normalizeOptionalLowercaseString(toolName) ?? "");
}

const MAX_ABORT_SUMMARY_LENGTH = 160;
const REPEATED_TOOL_VALIDATION_LOOP_RE = /Stopped after \d+ identical failed .* tool calls/;

function hasUnsafeSummaryCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Accepts only the compact single-line diagnostic produced below. */
export function readToolValidationErrorSummary(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const summary = value.trim();
  if (
    !summary ||
    summary.length > MAX_ABORT_SUMMARY_LENGTH ||
    hasUnsafeSummaryCharacter(summary) ||
    hasRawToolValidationOutput(summary)
  ) {
    return undefined;
  }
  return summary;
}

/** Detects validator output that may embed model-supplied tool arguments. */
export function hasRawToolValidationOutput(value: string): boolean {
  return (
    value.includes("Received arguments") ||
    value.includes("Validation failed for tool") ||
    REPEATED_TOOL_VALIDATION_LOOP_RE.test(value)
  );
}

/** Builds a static diagnostic from typed pre-execution validation provenance. */
export function createToolValidationErrorSummary(toolName: string): string | undefined {
  if (hasUnsafeSummaryCharacter(toolName)) {
    return undefined;
  }
  const normalizedToolName = toolName.replace(/\s+/g, " ").trim();
  if (!normalizedToolName) {
    return undefined;
  }
  return readToolValidationErrorSummary(
    `${normalizedToolName} tool validation failed: invalid arguments`,
  );
}

/**
 * Returns only a boundary-prepared validation summary. Raw validator messages
 * stay private because paths and custom messages can contain model input.
 */
export function summarizeToolValidationError(summary: ToolErrorSummary): string | undefined {
  return readToolValidationErrorSummary(summary.validationErrorSummary);
}
