export type PlainTextToolCallBlock = {
  arguments: Record<string, unknown>;
  end: number;
  name: string;
  raw: string;
  start: number;
};

type ParseOptions = {
  allowedToolNames?: Iterable<string>;
  maxPayloadBytes?: number;
};

const DEFAULT_MAX_PAYLOAD_BYTES = 256_000;
const END_TOOL_REQUEST = "[END_TOOL_REQUEST]";

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

function parseOpening(text: string, start: number): { end: number; name: string } | null {
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
  return { end: afterLineBreak, name };
}

function consumeJsonObject(
  text: string,
  start: number,
  maxPayloadBytes: number,
): { end: number; value: Record<string, unknown> } | null {
  let cursor = skipWhitespace(text, start);
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
  let cursor = skipWhitespace(text, start);
  if (text.startsWith(END_TOOL_REQUEST, cursor)) {
    return cursor + END_TOOL_REQUEST.length;
  }
  const namedClosing = `[/${name}]`;
  if (text.startsWith(namedClosing, cursor)) {
    return cursor + namedClosing.length;
  }
  return null;
}

function parseBlockAt(
  text: string,
  start: number,
  options?: ParseOptions,
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
    options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  );
  if (!payload) {
    return null;
  }
  const end = parseClosing(text, payload.end, opening.name);
  if (end === null) {
    return null;
  }
  return {
    arguments: payload.value,
    end,
    name: opening.name,
    raw: text.slice(start, end),
    start,
  };
}

export function parseStandalonePlainTextToolCallBlocks(
  text: string,
  options?: ParseOptions,
): PlainTextToolCallBlock[] | null {
  const blocks: PlainTextToolCallBlock[] = [];
  let cursor = skipWhitespace(text, 0);
  while (cursor < text.length) {
    const block = parseBlockAt(text, cursor, options);
    if (!block) {
      return null;
    }
    blocks.push(block);
    cursor = skipWhitespace(text, block.end);
  }
  return blocks.length > 0 ? blocks : null;
}

export function stripPlainTextToolCallBlocks(text: string): string {
  if (!text || !/\[[A-Za-z0-9_-]+\]/.test(text)) {
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
    const block = parseBlockAt(text, blockStart);
    if (!block) {
      index += 1;
      continue;
    }
    result += text.slice(cursor, index);
    cursor = block.end;
    index = block.end;
  }
  result += text.slice(cursor);
  return result;
}
