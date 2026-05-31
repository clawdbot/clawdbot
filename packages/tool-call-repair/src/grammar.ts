export const END_TOOL_REQUEST = "[END_TOOL_REQUEST]";
export const HARMONY_CHANNEL_MARKER = "<|channel|>";
export const HARMONY_MESSAGE_MARKER = "<|message|>";
export const HARMONY_CALL_MARKER = "<|call|>";

export function matchesLiteralPrefix(text: string, literal: string): boolean {
  return literal.startsWith(text) || text.startsWith(literal);
}

export function isPlainTextToolNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_-]/.test(char));
}

export function isXmlishNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_.:-]/.test(char));
}

export function skipHorizontalWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    index += 1;
  }
  return index;
}

export function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

export function consumeLineBreak(text: string, start: number): number | null {
  if (text[start] === "\r") {
    return text[start + 1] === "\n" ? start + 2 : start + 1;
  }
  if (text[start] === "\n") {
    return start + 1;
  }
  return null;
}

export function findJsonObjectEnd(
  text: string,
  start: number,
  maxPayloadBytes?: number,
): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    if (maxPayloadBytes !== undefined && index + 1 - start > maxPayloadBytes) {
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
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return null;
}

export function skipSerializedToolCallTrailingLineBreak(text: string, cursor: number): number {
  const afterLineBreak = consumeLineBreak(text, cursor);
  return afterLineBreak ?? cursor;
}

export function consumeJsonToolClosingMarker(text: string, cursor: number): number {
  let markerStart = cursor;
  while (markerStart < text.length && /\s/.test(text[markerStart] ?? "")) {
    markerStart += 1;
  }
  const rest = text.slice(markerStart);
  if (rest.startsWith(END_TOOL_REQUEST)) {
    return skipSerializedToolCallTrailingLineBreak(text, markerStart + END_TOOL_REQUEST.length);
  }
  const bracketClose = /^\[\/[A-Za-z0-9_-]+\]/.exec(rest);
  if (bracketClose) {
    return skipSerializedToolCallTrailingLineBreak(text, markerStart + bracketClose[0].length);
  }
  if (rest.startsWith(HARMONY_CALL_MARKER)) {
    return skipSerializedToolCallTrailingLineBreak(text, markerStart + HARMONY_CALL_MARKER.length);
  }
  return skipSerializedToolCallTrailingLineBreak(text, cursor);
}

export function findBracketedJsonPayloadStart(text: string): number | null {
  if (!text.startsWith("[")) {
    return null;
  }
  const close = text.indexOf("]");
  if (close === -1) {
    return null;
  }
  let cursor = close + 1;
  cursor = skipHorizontalWhitespace(text, cursor);
  cursor = skipSerializedToolCallTrailingLineBreak(text, cursor);
  cursor = skipHorizontalWhitespace(text, cursor);
  return text[cursor] === "{" ? cursor : null;
}

export function findHarmonyJsonPayloadStart(text: string): number | null {
  let cursor = 0;
  if (text.startsWith(HARMONY_CHANNEL_MARKER)) {
    cursor = HARMONY_CHANNEL_MARKER.length;
  }
  const rest = text.slice(cursor);
  const channel = ["commentary", "analysis", "final"].find((candidate) =>
    rest.startsWith(candidate),
  );
  if (!channel) {
    return null;
  }
  cursor += channel.length;
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.slice(cursor).startsWith("to=")) {
    return null;
  }
  cursor += "to=".length;
  const nameStart = cursor;
  while (isPlainTextToolNameChar(text[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart) {
    return null;
  }
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.slice(cursor).startsWith("code")) {
    return null;
  }
  cursor += "code".length;
  cursor = skipWhitespace(text, cursor);
  if (text.slice(cursor).startsWith(HARMONY_MESSAGE_MARKER)) {
    cursor = skipWhitespace(text, cursor + HARMONY_MESSAGE_MARKER.length);
  }
  return text[cursor] === "{" ? cursor : null;
}

export function startsWithAsciiMarkerIgnoreCase(
  text: string,
  cursor: number,
  marker: string,
): boolean {
  return text.slice(cursor, cursor + marker.length).toLowerCase() === marker;
}

export function indexOfAsciiMarkerIgnoreCase(text: string, marker: string, start: number): number {
  let cursor = start;
  while (cursor < text.length) {
    const next = text.indexOf(marker[0] ?? "", cursor);
    if (next === -1) {
      return -1;
    }
    if (startsWithAsciiMarkerIgnoreCase(text, next, marker)) {
      return next;
    }
    cursor = next + 1;
  }
  return -1;
}

export function findXmlishToolCallEnd(text: string): number | null {
  let cursor: number;
  const xmlFunction = /^<function=[A-Za-z0-9_.:-]+>/i.exec(text);
  if (xmlFunction) {
    cursor = xmlFunction[0].length;
  } else {
    const bracketed = /^\[(?:tool:)?[A-Za-z0-9_-]+\]/.exec(text);
    if (!bracketed) {
      return null;
    }
    cursor = bracketed[0].length;
    cursor = skipHorizontalWhitespace(text, cursor);
    cursor = skipSerializedToolCallTrailingLineBreak(text, cursor);
  }

  cursor = skipWhitespace(text, cursor);
  if (!startsWithAsciiMarkerIgnoreCase(text, cursor, "<parameter=")) {
    return null;
  }

  while (cursor < text.length) {
    const parameterClose = indexOfAsciiMarkerIgnoreCase(text, "</parameter>", cursor);
    if (parameterClose === -1) {
      return null;
    }
    cursor = skipWhitespace(text, parameterClose + "</parameter>".length);
    if (startsWithAsciiMarkerIgnoreCase(text, cursor, "</function>")) {
      return skipSerializedToolCallTrailingLineBreak(text, cursor + "</function>".length);
    }
    if (!startsWithAsciiMarkerIgnoreCase(text, cursor, "<parameter=")) {
      return skipSerializedToolCallTrailingLineBreak(text, cursor);
    }
  }
  return null;
}
