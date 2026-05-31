import {
  parseStandalonePlainTextToolCallBlocks as parseStandaloneRepairToolCallBlocks,
  stripPlainTextToolCallBlocks as stripRepairToolCallBlocks,
} from "../../packages/tool-call-repair/src/index.js";

export type PlainTextToolCallBlock = {
  arguments: Record<string, unknown>;
  end: number;
  name: string;
  raw: string;
  start: number;
};

export type PlainTextToolCallParseOptions = {
  allowedToolNames?: Iterable<string>;
  maxPayloadBytes?: number;
};

export function parseStandalonePlainTextToolCallBlocks(
  text: string,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock[] | null {
  return parseStandaloneRepairToolCallBlocks(text, options);
}

export function stripPlainTextToolCallBlocks(text: string): string {
  return stripRepairToolCallBlocks(text);
}

type ToolPayloadTextBlock = {
  type: "text";
  text: string;
};

export type ToolPayloadCarrier = {
  details?: unknown;
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
