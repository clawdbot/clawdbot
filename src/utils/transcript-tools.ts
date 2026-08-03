/**
 * Transcript inspection helpers shared by session filesystem views and usage metrics.
 * Keep provider-specific block aliases centralized so both surfaces classify tools consistently.
 */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";

type ToolResultCounts = {
  total: number;
  errors: number;
};

// Transcript providers disagree on tool-call block spellings; keep the accepted
// aliases centralized so display and metrics code classify the same payloads.
const TOOL_CALL_TYPES = new Set(["tool_use", "toolcall", "tool_call"]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "tool_result_error"]);

const normalizeType = (value: unknown): string => {
  return typeof value === "string" ? (normalizeOptionalLowercaseString(value) ?? "") : "";
};

/** Extracts de-duplicated tool names from direct fields and structured content blocks. */
export const extractToolCallNames = (message: Record<string, unknown>): string[] => {
  const names = new Set<string>();
  const toolNameRaw = message.toolName ?? message.tool_name;
  const toolName =
    typeof toolNameRaw === "string" ? normalizeOptionalString(toolNameRaw) : undefined;
  if (toolName) {
    names.add(toolName);
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return Array.from(names);
  }

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const block = entry as Record<string, unknown>;
    const type = normalizeType(block.type);
    if (!TOOL_CALL_TYPES.has(type)) {
      continue;
    }
    const name = typeof block.name === "string" ? normalizeOptionalString(block.name) : undefined;
    if (name) {
      names.add(name);
    }
  }

  return Array.from(names);
};

/** Returns whether a transcript message contains any recognized tool-call marker. */
export const hasToolCall = (message: Record<string, unknown>): boolean =>
  extractToolCallNames(message).length > 0;

/** Counts recognized tool-result blocks and the subset explicitly marked as errors. */
export const countToolResults = (message: Record<string, unknown>): ToolResultCounts => {
  const content = message.content;
  if (!Array.isArray(content)) {
    return { total: 0, errors: 0 };
  }

  let total = 0;
  let errors = 0;
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const block = entry as Record<string, unknown>;
    const type = normalizeType(block.type);
    if (!TOOL_RESULT_TYPES.has(type)) {
      continue;
    }
    total += 1;
    if (block.is_error === true) {
      errors += 1;
    }
  }

  return { total, errors };
};
