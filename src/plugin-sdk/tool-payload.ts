// Tool payload helpers normalize provider tool-call schemas and compatibility payloads.
import {
  parseStandalonePlainTextToolCallBlocks as parseStandaloneRepairToolCallBlocks,
  stripPlainTextToolCallBlocks as stripRepairToolCallBlocks,
} from "../../packages/tool-call-repair/src/index.js";

/** Plugin-facing plain-text tool call block with source offsets for repair. */
export type PlainTextToolCallBlock = {
  /** Parsed JSON arguments object. */
  arguments: Record<string, unknown>;
  /** Exclusive end offset of the parsed block. */
  end: number;
  /** Tool name parsed from the standalone block. */
  name: string;
  /** Original text slice that produced this block. */
  raw: string;
  /** Inclusive start offset of the parsed block. */
  start: number;
};

/** Plugin-facing parser options for standalone plain-text tool calls. */
export type PlainTextToolCallParseOptions = {
  /** Optional allowlist of tool names that may be accepted. */
  allowedToolNames?: Iterable<string>;
  /** Maximum serialized payload size accepted for one parsed call. */
  maxPayloadBytes?: number;
};

/** Parses a message made only of standalone plain-text tool call blocks. */
export function parseStandalonePlainTextToolCallBlocks(
  text: string,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock[] | null {
  return parseStandaloneRepairToolCallBlocks(text, options);
}

/**
 * Removes full-line standalone plain-text tool call blocks from visible text.
 *
 * Strict scrubber: a leaked block is removed even when it sits inside a Markdown
 * code fence or inline span, preserving the SDK contract for callers that sanitize
 * untrusted visible text where a tool-call-shaped block is always a leak. The
 * code-region-aware path lives only in the internal packages/tool-call-repair helper.
 */
export function stripPlainTextToolCallBlocks(text: string): string {
  // Force a strict scrub: the repair helper spares code-region examples by default,
  // so an always-false predicate keeps the untrusted-text contract unchanged.
  return stripRepairToolCallBlocks(text, () => false);
}

type ToolPayloadTextBlock = {
  type: "text";
  text: string;
};

/** Minimal tool-result-like object shape accepted by payload extraction helpers. */
export type ToolPayloadCarrier = {
  /** Structured payload preferred over content text when present. */
  details?: unknown;
  /** Provider/tool content blocks or fallback payload. */
  content?: unknown;
};

function isToolPayloadTextBlock(block: unknown): block is ToolPayloadTextBlock {
  return (
    Boolean(block) &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

/**
 * Extract the most useful payload from tool result-like objects shared across
 * outbound core flows and bundled plugin helpers.
 */
export function extractToolPayload(result: ToolPayloadCarrier | null | undefined): unknown {
  if (!result) {
    return undefined;
  }
  // Structured details are authoritative; content text is only a compatibility fallback.
  if (result.details !== undefined) {
    return result.details;
  }
  const textBlock = Array.isArray(result.content)
    ? result.content.find(isToolPayloadTextBlock)
    : undefined;
  const text = textBlock?.text;
  if (!text) {
    return result.content ?? result;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
