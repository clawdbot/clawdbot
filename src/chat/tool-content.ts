// Normalizes tool result content for chat transcript rendering.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const TOOL_USE_ID_FIELDS = [
  "id",
  "tool_call_id",
  "toolCallId",
  "tool_use_id",
  "toolUseId",
] as const;
type ToolUseIdField = (typeof TOOL_USE_ID_FIELDS)[number];

/** Provider-agnostic chat content block shape used before SDK-specific narrowing. */
export type ToolContentBlock = Record<string, unknown> & Partial<Record<ToolUseIdField, unknown>>;

function normalizeToolContentType(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/** Accepts tool-call content type spellings used by provider SDKs and persisted transcripts. */
export function isToolCallContentType(value: unknown): boolean {
  const type = normalizeToolContentType(value);
  return type === "toolcall" || type === "tool_call" || type === "tooluse" || type === "tool_use";
}

/** Accepts tool-result content type spellings used by provider SDKs and persisted transcripts. */
export function isToolResultContentType(value: unknown): boolean {
  const type = normalizeToolContentType(value);
  return type === "toolresult" || type === "tool_result";
}

/** Narrows unknown chat content blocks to provider-shaped tool-call blocks. */
export function isToolCallBlock(block: ToolContentBlock): boolean {
  return isToolCallContentType(block.type);
}

/** Narrows unknown chat content blocks to provider-shaped tool-result blocks. */
export function isToolResultBlock(block: ToolContentBlock): boolean {
  return isToolResultContentType(block.type);
}

/** Reads the argument payload across the common provider field names. */
export function resolveToolBlockArgs(block: ToolContentBlock): unknown {
  return block.args ?? block.arguments ?? block.input;
}

/** Reads the stable tool-use id across snake_case and camelCase provider field names. */
export function resolveToolUseId(block: ToolContentBlock): string | undefined {
  for (const field of TOOL_USE_ID_FIELDS) {
    const id = normalizeOptionalString(block[field]);
    if (id) {
      return id;
    }
  }
  return undefined;
}
