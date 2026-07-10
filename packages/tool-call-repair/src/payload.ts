// Tool Call Repair module implements payload behavior.
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

/** Parsed standalone plain-text tool call block with source offsets for repair. */
export type PlainTextToolCallBlock = {
  /** Parsed JSON arguments object. */
  arguments: Record<string, unknown>;
  /** Exclusive end offset of the parsed block. */
  end: number;
  /** Tool name parsed from bracket, Harmony, or XML-ish syntax. */
  name: string;
  /** Original text slice that produced this block. */
  raw: string;
  /** Inclusive start offset of the parsed block. */
  start: number;
};

/** Parser limits and allowlist options for plain-text tool-call repair. */
export type PlainTextToolCallParseOptions = {
  /** Optional allowlist of tool names that may be repaired. */
  allowedToolNames?: Iterable<string>;
  /** Maximum serialized payload size accepted for one repaired call. */
  maxPayloadBytes?: number;
};

const DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES = 256_000;
const utf8Encoder = new TextEncoder();

function utf8ByteLengthWithinLimit(
  text: string,
  start: number,
  end: number,
  maxBytes: number,
): number | null {
  if (end - start > maxBytes) {
    return null;
  }
  const byteLength = utf8Encoder.encode(text.slice(start, end)).byteLength;
  return byteLength <= maxBytes ? byteLength : null;
}

type PlainTextToolCallOpening = {
  end: number;
  kind: "bracket" | "harmony" | "tool-bracket" | "xml-function";
  name: string;
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
      end: cursor + 1,
      kind: "tool-bracket",
      name: text.slice(nameStart, cursor),
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
  return { end: afterLineBreak, kind: "bracket", name };
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
  return { end: cursor, kind: "harmony", name };
}

function parseXmlishFunctionOpening(text: string, start: number): PlainTextToolCallOpening | null {
  const match = /^<function=([A-Za-z0-9_.:-]{1,120})>/i.exec(text.slice(start));
  if (!match?.[1]) {
    return null;
  }
  return {
    end: start + match[0].length,
    kind: "xml-function",
    name: match[1],
  };
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
  if (end === null || utf8ByteLengthWithinLimit(text, cursor, end, maxPayloadBytes) === null) {
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
  const closingEnd =
    opening.kind === "bracket"
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
): { byteLength: number; end: number; name: string; value: string } | null {
  const bounds = findXmlishParameterBlock(text, start);
  if (!bounds) {
    return null;
  }
  const byteLength = utf8ByteLengthWithinLimit(text, start, bounds.end, maxPayloadBytes);
  if (byteLength === null) {
    return null;
  }
  return {
    byteLength,
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

function findXmlishFunctionClose(
  text: string,
  start: number,
): { closeStart: number; end: number } | null {
  const closeStart = skipWhitespace(text, start);
  return text.slice(closeStart).toLowerCase().startsWith("</function>")
    ? { closeStart, end: closeStart + "</function>".length }
    : null;
}

function parseXmlishPlainTextToolCallBlockEndAt(text: string, start: number): number | null {
  const opening = parseXmlishOpening(text, start);
  if (!opening) {
    return null;
  }

  let cursor = opening.end;
  let hasParameters = false;
  while (true) {
    const parameter = findXmlishParameterBlock(text, cursor);
    if (!parameter) {
      break;
    }
    hasParameters = true;
    cursor = parameter.end;
  }
  if (!hasParameters && opening.kind !== "xml-function") {
    return null;
  }
  const close = findXmlishFunctionClose(text, cursor);
  return close?.end ?? (opening.kind === "tool-bracket" ? cursor : null);
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
  let hasParameters = false;
  let payloadBytes = 0;
  while (true) {
    const parameter = consumeXmlishParameterBlock(text, cursor, maxPayloadBytes);
    if (!parameter) {
      break;
    }
    payloadBytes += parameter.byteLength;
    if (payloadBytes > maxPayloadBytes) {
      return null;
    }
    args[parameter.name] = parameter.value;
    hasParameters = true;
    cursor = parameter.end;
  }
  if (!hasParameters && opening.kind !== "xml-function") {
    return null;
  }

  const close = findXmlishFunctionClose(text, cursor);
  if (!close && opening.kind !== "tool-bracket") {
    return null;
  }
  if (close) {
    // Whitespace before the close shares the serialized body budget. Otherwise an empty
    // XML call can bypass the cap in owners that promote before over-cap scrubbing.
    const trailingBytes = utf8ByteLengthWithinLimit(
      text,
      cursor,
      close.closeStart,
      maxPayloadBytes - payloadBytes,
    );
    if (trailingBytes === null) {
      return null;
    }
  }
  const end = close?.end ?? cursor;
  return {
    arguments: args,
    end,
    name: opening.name,
    raw: text.slice(start, end),
    start,
  };
}

function parsePlainTextToolCallBlockAtAnySyntax(
  text: string,
  start: number,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock | null {
  return (
    parsePlainTextToolCallBlockAt(text, start, options) ??
    parseXmlishPlainTextToolCallBlockAt(text, start, options)
  );
}

export function parseStandalonePlainTextToolCallBlocks(
  text: string,
  options?: PlainTextToolCallParseOptions,
): PlainTextToolCallBlock[] | null {
  const blocks: PlainTextToolCallBlock[] = [];
  let cursor = skipWhitespace(text, 0);
  while (cursor < text.length) {
    const block = parsePlainTextToolCallBlockAtAnySyntax(text, cursor, options);
    if (!block) {
      return null;
    }
    blocks.push(block);
    cursor = skipWhitespace(text, block.end);
  }
  return blocks.length > 0 ? blocks : null;
}

export type OverCapPlainTextToolCallPrefix = {
  visibleText: string;
};

/** Finds complete leading blocks when at least one exceeds the default payload cap. */
export function parseOverCapPlainTextToolCallPrefix(
  text: string,
  options?: { isAllowedName?: (name: string) => boolean },
): OverCapPlainTextToolCallPrefix | null {
  let cursor = skipWhitespace(text, 0);
  let hasOverCapBlock = false;
  let parsedBlockCount = 0;
  let visibleTextStart = cursor;
  while (cursor < text.length) {
    const block = parsePlainTextToolCallBlockAtAnySyntax(text, cursor, {
      maxPayloadBytes: Number.POSITIVE_INFINITY,
    });
    if (!block) {
      break;
    }
    if (options?.isAllowedName && !options.isAllowedName(block.name)) {
      break;
    }
    // Optional-close syntax can cap out after an earlier parameter yet still parse a shorter
    // block. Matching end offsets proves both parsers consumed the same serialized call.
    const cappedBlock = parsePlainTextToolCallBlockAtAnySyntax(text, cursor);
    hasOverCapBlock ||= !cappedBlock || cappedBlock.end !== block.end;
    parsedBlockCount += 1;
    visibleTextStart = consumeLineBreak(text, block.end) ?? block.end;
    cursor = skipWhitespace(text, visibleTextStart);
  }
  return hasOverCapBlock && parsedBlockCount > 0
    ? { visibleText: text.slice(visibleTextStart) }
    : null;
}

/** Removes full-line standalone plain-text tool-call blocks from user-visible text. */
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
