import {
  consumeLineBreak,
  END_TOOL_REQUEST,
  findJsonObjectEnd,
  HARMONY_CALL_MARKER,
  HARMONY_CHANNEL_MARKER,
  HARMONY_MESSAGE_MARKER,
  isPlainTextToolNameChar,
  skipHorizontalWhitespace,
  skipWhitespace,
} from "./grammar.js";

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

type PlainTextToolCallOpening = {
  allowsOptionalXmlishClose?: boolean;
  end: number;
  name: string;
  requiresClosing: boolean;
};

function parseBracketOpening(text: string, start: number): PlainTextToolCallOpening | null {
  if (text[start] !== "[") {
    return null;
  }
  let cursor = start + 1;
  if (text.startsWith("tool:", cursor)) {
    cursor += "tool:".length;
    const nameStart = cursor;
    while (isPlainTextToolNameChar(text[cursor])) {
      cursor += 1;
    }
    if (cursor === nameStart || text[cursor] !== "]") {
      return null;
    }
    return {
      allowsOptionalXmlishClose: true,
      end: cursor + 1,
      name: text.slice(nameStart, cursor),
      requiresClosing: false,
    };
  }
  const nameStart = cursor;
  while (isPlainTextToolNameChar(text[cursor])) {
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
  while (isPlainTextToolNameChar(text[cursor])) {
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

function parseXmlishFunctionOpening(text: string, start: number): PlainTextToolCallOpening | null {
  const match = /^<function=([A-Za-z0-9_.:-]{1,120})>\s*/i.exec(text.slice(start));
  if (!match?.[1]) {
    return null;
  }
  return { end: start + match[0].length, name: match[1], requiresClosing: false };
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
  const end = findJsonObjectEnd(text, cursor, maxPayloadBytes);
  if (end === null) {
    return null;
  }
  const rawJson = text.slice(cursor, end);
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return { end, value: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
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

type XmlishParameterBlockBounds = {
  closeStart: number;
  end: number;
  name: string;
  payloadStart: number;
  start: number;
};

function findXmlishParameterBlock(text: string, start: number): XmlishParameterBlockBounds | null {
  const cursor = skipWhitespace(text, start);
  const openMatch = /^<parameter=([A-Za-z0-9_.:-]{1,120})>/i.exec(text.slice(cursor));
  if (!openMatch?.[1]) {
    return null;
  }
  const payloadStart = cursor + openMatch[0].length;
  const closeMatch = /<\/parameter>/i.exec(text.slice(payloadStart));
  if (!closeMatch) {
    return null;
  }
  const closeStart = payloadStart + closeMatch.index;
  const closeEnd = closeStart + closeMatch[0].length;
  return {
    closeStart,
    end: closeEnd,
    name: openMatch[1],
    payloadStart,
    start: cursor,
  };
}

function consumeXmlishParameterBlock(
  text: string,
  start: number,
  maxPayloadBytes: number,
): { end: number; name: string; value: string } | null {
  const bounds = findXmlishParameterBlock(text, start);
  if (!bounds) {
    return null;
  }
  if (bounds.end - bounds.start > maxPayloadBytes) {
    return null;
  }
  return {
    end: bounds.end,
    name: bounds.name,
    value: extractXmlishParameterValue(text, bounds.payloadStart, bounds.closeStart),
  };
}

function extractXmlishParameterValue(text: string, start: number, end: number): string {
  let payloadStart = start;
  let payloadEnd = end;
  const afterOpeningLineBreak = consumeLineBreak(text, payloadStart);
  if (afterOpeningLineBreak !== null) {
    payloadStart = afterOpeningLineBreak;
    if (payloadEnd > payloadStart && text[payloadEnd - 1] === "\n") {
      payloadEnd -= 1;
      if (payloadEnd > payloadStart && text[payloadEnd - 1] === "\r") {
        payloadEnd -= 1;
      }
    } else if (payloadEnd > payloadStart && text[payloadEnd - 1] === "\r") {
      payloadEnd -= 1;
    }
  }
  return text.slice(payloadStart, payloadEnd);
}

function consumeXmlishFunctionClose(text: string, start: number): number | null {
  const cursor = skipWhitespace(text, start);
  return text.slice(cursor).toLowerCase().startsWith("</function>")
    ? cursor + "</function>".length
    : null;
}

function consumeOptionalXmlishFunctionClose(text: string, start: number): number {
  return consumeXmlishFunctionClose(text, start) ?? start;
}

function parseXmlishPlainTextToolCallBlockEndAt(
  text: string,
  start: number,
  options?: PlainTextToolCallParseOptions,
): number | null {
  const opening = parseXmlishOpening(text, start);
  if (!opening) {
    return null;
  }
  const allowedToolNames = options?.allowedToolNames
    ? new Set(options.allowedToolNames)
    : undefined;
  if (allowedToolNames && !allowedToolNames.has(opening.name)) {
    return null;
  }

  let cursor = opening.end;
  let parameterCount = 0;
  while (true) {
    const parameter = findXmlishParameterBlock(text, cursor);
    if (!parameter) {
      break;
    }
    parameterCount += 1;
    cursor = parameter.end;
  }
  if (parameterCount === 0) {
    return null;
  }
  return opening.allowsOptionalXmlishClose
    ? consumeOptionalXmlishFunctionClose(text, cursor)
    : consumeXmlishFunctionClose(text, cursor);
}

function parseXmlishOpening(text: string, start: number): PlainTextToolCallOpening | null {
  return parseBracketOpening(text, start) ?? parseXmlishFunctionOpening(text, start);
}

function parseXmlishPlainTextToolCallBlockAt(
  text: string,
  start: number,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock | null {
  const opening = parseXmlishOpening(text, start);
  if (!opening) {
    return null;
  }
  const allowedToolNames = options?.allowedToolNames
    ? new Set(options.allowedToolNames)
    : undefined;
  if (allowedToolNames && !allowedToolNames.has(opening.name)) {
    return null;
  }

  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
  const args: Record<string, unknown> = {};
  let cursor = opening.end;
  let parameterCount = 0;
  while (true) {
    const parameter = consumeXmlishParameterBlock(text, cursor, maxPayloadBytes);
    if (!parameter) {
      break;
    }
    if (parameter.end - opening.end > maxPayloadBytes) {
      return null;
    }
    args[parameter.name] = parameter.value;
    parameterCount += 1;
    cursor = parameter.end;
  }
  if (parameterCount === 0) {
    return null;
  }

  const end = opening.allowsOptionalXmlishClose
    ? consumeOptionalXmlishFunctionClose(text, cursor)
    : consumeXmlishFunctionClose(text, cursor);
  if (end === null) {
    return null;
  }
  return {
    arguments: args,
    end,
    name: opening.name,
    raw: text.slice(start, end),
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
    const block =
      parsePlainTextToolCallBlockAt(text, cursor, options) ??
      parseXmlishPlainTextToolCallBlockAt(text, cursor, options);
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
    (!/\[(?:tool:)?[A-Za-z0-9_-]+\]/.test(text) &&
      !/(?:^|\n)\s*(?:<\|channel\|>)?(?:commentary|analysis|final)\s+to=/.test(text) &&
      !/(?:^|\n)\s*<function=[A-Za-z0-9_.:-]{1,120}>/i.test(text))
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
    const blockEnd = block?.end ?? parseXmlishPlainTextToolCallBlockEndAt(text, blockStart);
    if (blockEnd === null) {
      index += 1;
      continue;
    }
    result += text.slice(cursor, index);
    cursor = blockEnd;
    const afterBlockLineBreak = consumeLineBreak(text, cursor);
    if (afterBlockLineBreak !== null) {
      cursor = afterBlockLineBreak;
    }
    index = cursor;
  }
  result += text.slice(cursor);
  return result;
}
