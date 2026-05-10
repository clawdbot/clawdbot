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
    !!block &&
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

const DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES = 256_000;
const END_TOOL_REQUEST = "[END_TOOL_REQUEST]";
const HARMONY_CHANNEL_MARKER = "<|channel|>";
const HARMONY_MESSAGE_MARKER = "<|message|>";
const HARMONY_CALL_MARKER = "<|call|>";

type PlainTextToolCallOpening = {
  end: number;
  name: string;
  requiresClosing: boolean;
};

function isToolNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_-]/.test(char));
}

function skipHorizontalWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    index += 1;
  }
  return index;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

function consumeLineBreak(text: string, start: number): number | null {
  if (text[start] === "\r") {
    return text[start + 1] === "\n" ? start + 2 : start + 1;
  }
  if (text[start] === "\n") {
    return start + 1;
  }
  return null;
}

function parseBracketOpening(text: string, start: number): PlainTextToolCallOpening | null {
  if (text[start] !== "[") {
    return null;
  }
  let cursor = start + 1;
  const nameStart = cursor;
  while (isToolNameChar(text[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart || text[cursor] !== "]") {
    return null;
  }
  const name = text.slice(nameStart, cursor);
  cursor += 1;
  cursor = skipHorizontalWhitespace(text, cursor);
  const afterLineBreak = consumeLineBreak(text, cursor);
  if (afterLineBreak === null) {
    return null;
  }
  return { end: afterLineBreak, name, requiresClosing: true };
}

function parseHarmonyOpening(text: string, start: number): PlainTextToolCallOpening | null {
  let cursor = start;
  if (text.startsWith(HARMONY_CHANNEL_MARKER, cursor)) {
    cursor += HARMONY_CHANNEL_MARKER.length;
  }
  const channelStart = cursor;
  while (/[A-Za-z_]/.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  const channel = text.slice(channelStart, cursor);
  if (channel !== "commentary" && channel !== "analysis" && channel !== "final") {
    return null;
  }
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.startsWith("to=", cursor)) {
    return null;
  }
  cursor += 3;
  const nameStart = cursor;
  while (isToolNameChar(text[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart) {
    return null;
  }
  const name = text.slice(nameStart, cursor);
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.startsWith("code", cursor)) {
    return null;
  }
  cursor += 4;
  cursor = skipWhitespace(text, cursor);
  if (text.startsWith(HARMONY_MESSAGE_MARKER, cursor)) {
    cursor = skipWhitespace(text, cursor + HARMONY_MESSAGE_MARKER.length);
  }
  return { end: cursor, name, requiresClosing: false };
}

function parseOpening(text: string, start: number): PlainTextToolCallOpening | null {
  return parseBracketOpening(text, start) ?? parseHarmonyOpening(text, start);
}

function consumeJsonObject(
  text: string,
  start: number,
  maxPayloadBytes: number,
): { end: number; value: Record<string, unknown> } | null {
  const cursor = skipWhitespace(text, start);
  if (text[cursor] !== "{") {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = cursor; index < text.length; index += 1) {
    const char = text[index];
    if (index + 1 - cursor > maxPayloadBytes) {
      return null;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const rawJson = text.slice(cursor, index + 1);
        try {
          const parsed = JSON.parse(rawJson) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
          }
          return { end: index + 1, value: parsed as Record<string, unknown> };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseClosing(text: string, start: number, name: string): number | null {
  const cursor = skipWhitespace(text, start);
  if (text.startsWith(END_TOOL_REQUEST, cursor)) {
    return cursor + END_TOOL_REQUEST.length;
  }
  const namedClosing = `[/${name}]`;
  if (text.startsWith(namedClosing, cursor)) {
    return cursor + namedClosing.length;
  }
  return null;
}

function parseOptionalHarmonyClosing(text: string, start: number): number {
  const cursor = skipWhitespace(text, start);
  if (text.startsWith(HARMONY_CALL_MARKER, cursor)) {
    return cursor + HARMONY_CALL_MARKER.length;
  }
  return start;
}

function parsePlainTextToolCallBlockAt(
  text: string,
  start: number,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock | null {
  const opening = parseOpening(text, start);
  if (!opening) {
    return null;
  }
  const allowedToolNames = options?.allowedToolNames
    ? new Set(options.allowedToolNames)
    : undefined;
  if (allowedToolNames && !allowedToolNames.has(opening.name)) {
    return null;
  }
  const payload = consumeJsonObject(
    text,
    opening.end,
    options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES,
  );
  if (!payload) {
    return null;
  }
  const closingEnd = opening.requiresClosing
    ? parseClosing(text, payload.end, opening.name)
    : parseOptionalHarmonyClosing(text, payload.end);
  if (closingEnd === null) {
    return null;
  }
  return {
    arguments: payload.value,
    end: closingEnd,
    name: opening.name,
    raw: text.slice(start, closingEnd),
    start,
  };
}

export function parseStandalonePlainTextToolCallBlocks(
  text: string,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock[] | null {
  const blocks: PlainTextToolCallBlock[] = [];
  let cursor = skipWhitespace(text, 0);
  while (cursor < text.length) {
    const block = parsePlainTextToolCallBlockAt(text, cursor, options);
    if (!block) {
      return null;
    }
    blocks.push(block);
    cursor = skipWhitespace(text, block.end);
  }
  return blocks.length > 0 ? blocks : null;
}

export function stripPlainTextToolCallBlocks(text: string): string {
  if (
    !text ||
    (!/\[[A-Za-z0-9_-]+\]/.test(text) &&
      !/(?:^|\n)\s*(?:<\|channel\|>)?(?:commentary|analysis|final)\s+to=/.test(text))
  ) {
    return text;
  }
  let result = "";
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const lineStart = index === 0 || text[index - 1] === "\n";
    if (!lineStart) {
      index += 1;
      continue;
    }
    const blockStart = skipHorizontalWhitespace(text, index);
    const block = parsePlainTextToolCallBlockAt(text, blockStart);
    if (!block) {
      index += 1;
      continue;
    }
    result += text.slice(cursor, index);
    cursor = block.end;
    const afterBlockLineBreak = consumeLineBreak(text, cursor);
    if (afterBlockLineBreak !== null) {
      cursor = afterBlockLineBreak;
    }
    index = cursor;
  }
  result += text.slice(cursor);
  return result;
}
