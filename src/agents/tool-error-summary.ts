/**
 * Compact tool error summary types.
 *
 * Stores failure metadata used by transcripts, retry behavior, and mutation recovery logic.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { FileTarget } from "./tool-mutation.js";

export type ToolErrorSummary = {
  toolName: string;
  meta?: string;
  errorCode?: string;
  error?: string;
  validationErrorSummary?: string;
  timedOut?: boolean;
  middlewareError?: boolean;
  mutatingAction?: boolean;
  actionFingerprint?: string;
  fileTarget?: FileTarget;
};

const EXEC_LIKE_TOOL_NAMES = new Set(["exec", "bash"]);

/** Detects shell-execution tools that share retry and mutation semantics. */
export function isExecLikeToolName(toolName: string): boolean {
  return EXEC_LIKE_TOOL_NAMES.has(normalizeOptionalLowercaseString(toolName) ?? "");
}

const MAX_ABORT_SUMMARY_LENGTH = 160;

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
  if (!summary || summary.length > MAX_ABORT_SUMMARY_LENGTH || hasUnsafeSummaryCharacter(summary)) {
    return undefined;
  }
  return summary;
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
