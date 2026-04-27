import { randomUUID } from "node:crypto";

export type LmstudioPlainTextToolCallBlock = {
  arguments: Record<string, unknown>;
  name: string;
};

const END_TOOL_REQUEST = "[END_TOOL_REQUEST]";
const MAX_PAYLOAD_CHARS = 256_000;

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
): { end: number; value: Record<string, unknown> } | null {
  const cursor = skipWhitespace(text, start);
  if (text[cursor] !== "{") {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = cursor; index < text.length; index += 1) {
    if (index + 1 - cursor > MAX_PAYLOAD_CHARS) {
      return null;
    }
    const char = text[index];
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
        try {
          const parsed = JSON.parse(text.slice(cursor, index + 1)) as unknown;
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

function parseBlockAt(
  text: string,
  start: number,
  allowedToolNames: Set<string>,
): { block: LmstudioPlainTextToolCallBlock; end: number } | null {
  const opening = parseOpening(text, start);
  if (!opening || !allowedToolNames.has(opening.name)) {
    return null;
  }
  const payload = consumeJsonObject(text, opening.end);
  if (!payload) {
    return null;
  }
  const end = parseClosing(text, payload.end, opening.name);
  if (end === null) {
    return null;
  }
  return {
    block: { arguments: payload.value, name: opening.name },
    end,
  };
}

export function parseLmstudioPlainTextToolCalls(
  text: string,
  allowedToolNames: Set<string>,
): LmstudioPlainTextToolCallBlock[] | null {
  const blocks: LmstudioPlainTextToolCallBlock[] = [];
  let cursor = skipWhitespace(text, 0);
  while (cursor < text.length) {
    const parsed = parseBlockAt(text, cursor, allowedToolNames);
    if (!parsed) {
      return null;
    }
    blocks.push(parsed.block);
    cursor = skipWhitespace(text, parsed.end);
  }
  return blocks.length > 0 ? blocks : null;
}

export function createLmstudioSyntheticToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
