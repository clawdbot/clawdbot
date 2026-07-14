/** Legacy marker some models emit after a serialized JSON tool request. */
export const END_TOOL_REQUEST = "[END_TOOL_REQUEST]";
/** Harmony stream marker that introduces the target channel before a tool call. */
export const HARMONY_CHANNEL_MARKER = "<|channel|>";
/** Harmony stream marker that may separate the header from the JSON payload. */
export const HARMONY_MESSAGE_MARKER = "<|message|>";
/** Harmony stream marker that may close a serialized tool-call payload. */
export const HARMONY_CALL_MARKER = "<|call|>";

/** Tool names in bracket/plain-text repairs intentionally match provider-safe ids only. */
export function isPlainTextToolNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_-]/.test(char));
}

/** XML-ish function tags allow namespace punctuation used by some model families. */
export function isXmlishNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_.:-]/.test(char));
}

// Some proxies degrade native Anthropic/MiniMax tool calls into namespaced XML
// text (the attribute dialect: `<invoke name="..."><parameter name="...">`).
// Accept only this closed prefix allow-list so namespaced markup is repaired
// instead of leaking, without matching arbitrary `ns:` tokens in prose. Open and
// close tags carry the prefix independently, and degraded proxy output routinely
// drops the prefix on the close, so any open/close prefix combination is intended.
// The `y` (sticky) matchers anchor at an explicit offset without slicing the tail,
// keeping the scan linear; the parameter close uses `g` to search forward. All are
// linear with no nested quantifiers, so they stay ReDoS-safe.
const TOOL_CALL_TAG_NAMESPACE = "(?:antml:|mm:)?";
/** Optional `<function_calls>` wrapper that brackets one or more invoke blocks. */
const XMLISH_FUNCTION_CALLS_OPEN_RE = new RegExp(
  `<\\s*${TOOL_CALL_TAG_NAMESPACE}function_calls\\s*>`,
  "iy",
);
const XMLISH_FUNCTION_CALLS_CLOSE_RE = new RegExp(
  `<\\s*/\\s*${TOOL_CALL_TAG_NAMESPACE}function_calls\\s*>`,
  "iy",
);
/** Attribute-dialect invoke open carrying the tool name in a quoted attribute. */
const XMLISH_INVOKE_OPEN_RE = new RegExp(
  `<\\s*${TOOL_CALL_TAG_NAMESPACE}invoke\\s+name\\s*=\\s*("[^"]*"|'[^']*')\\s*>`,
  "iy",
);
/** Self-closing invoke (`<invoke name="x"/>`): a complete, argument-less block. */
const XMLISH_INVOKE_SELF_CLOSE_RE = new RegExp(
  `<\\s*${TOOL_CALL_TAG_NAMESPACE}invoke\\s+name\\s*=\\s*("[^"]*"|'[^']*')\\s*/\\s*>`,
  "iy",
);
const XMLISH_INVOKE_CLOSE_RE = new RegExp(`<\\s*/\\s*${TOOL_CALL_TAG_NAMESPACE}invoke\\s*>`, "iy");
/** Parameter open in the equals (`<parameter=name>`) or attribute (`<parameter name="...">`) dialect. */
const XMLISH_PARAMETER_OPEN_RE = new RegExp(
  `<\\s*${TOOL_CALL_TAG_NAMESPACE}parameter(?:=[A-Za-z0-9_.:-]{1,120}|\\s+name\\s*=\\s*("[^"]*"|'[^']*'))\\s*>`,
  "iy",
);
const XMLISH_PARAMETER_CLOSE_RE = new RegExp(
  `<\\s*/\\s*${TOOL_CALL_TAG_NAMESPACE}parameter\\s*>`,
  "ig",
);

/** Length of a sticky-regex match anchored exactly at `at`, or null when it does not match there. */
function stickyMatchLength(re: RegExp, text: string, at: number): number | null {
  re.lastIndex = at;
  const match = re.exec(text);
  return match ? match[0].length : null;
}

/** Consumes one attribute/namespaced `<parameter ...>...</parameter>` child. */
function consumeXmlishAttributeParameterEnd(text: string, start: number): number | null {
  const openLength = stickyMatchLength(XMLISH_PARAMETER_OPEN_RE, text, start);
  if (openLength === null) {
    return null;
  }
  const payloadStart = start + openLength;
  XMLISH_PARAMETER_CLOSE_RE.lastIndex = payloadStart;
  const closeMatch = XMLISH_PARAMETER_CLOSE_RE.exec(text);
  return closeMatch ? closeMatch.index + closeMatch[0].length : null;
}

/** Consumes the optional `<function_calls>` wrapper close after the final invoke. */
function finishXmlishInvokeBlockEnd(text: string, invokeEnd: number): number {
  // The wrapper close only follows the final invoke; leave it for the next block
  // when several invokes share one `<function_calls>` wrapper.
  const afterInvoke = skipWhitespace(text, invokeEnd);
  const wrapperCloseLength = stickyMatchLength(XMLISH_FUNCTION_CALLS_CLOSE_RE, text, afterInvoke);
  return wrapperCloseLength === null ? invokeEnd : afterInvoke + wrapperCloseLength;
}

/**
 * Result of {@link scanStandaloneXmlishInvokeBlock}: `none` when the text at
 * `start` does not open an invoke block (the caller falls through to the shared
 * scanner), `complete` with the exclusive end offset of one whole block, or
 * `incomplete` when an invoke/`function_calls` open was matched but the block
 * never closes. `incomplete` must be terminal for the caller: it signals that the
 * unclosed tail should not be rescanned line-by-line, which would be quadratic.
 */
export type StandaloneXmlishInvokeScan =
  | { kind: "none" }
  | { kind: "incomplete" }
  | { kind: "complete"; end: number };

/**
 * Recognizes the attribute-dialect invoke tool call that degraded proxies emit as
 * plain text: `<invoke name="tool"><parameter name="x">v</parameter></invoke>`,
 * optionally wrapped in `<function_calls>`, optionally namespaced (`antml:`/`mm:`),
 * self-closing (`<invoke name="x"/>`), or with zero parameters. An unterminated
 * open reports `incomplete` (never greedily consumed) so the caller can stop
 * instead of re-scanning the same unclosed tail at every following line start.
 * This dialect is scrubbable but intentionally never promoted to an executable
 * call, so it stays out of `scanXmlishToolCall`.
 */
export function scanStandaloneXmlishInvokeBlock(
  text: string,
  start = 0,
): StandaloneXmlishInvokeScan {
  let cursor = start;
  const wrapperOpenLength = stickyMatchLength(XMLISH_FUNCTION_CALLS_OPEN_RE, text, cursor);
  const hasWrapper = wrapperOpenLength !== null;
  if (hasWrapper) {
    cursor = skipWhitespace(text, cursor + wrapperOpenLength);
  }
  const selfCloseLength = stickyMatchLength(XMLISH_INVOKE_SELF_CLOSE_RE, text, cursor);
  if (selfCloseLength !== null) {
    return { kind: "complete", end: finishXmlishInvokeBlockEnd(text, cursor + selfCloseLength) };
  }
  const invokeOpenLength = stickyMatchLength(XMLISH_INVOKE_OPEN_RE, text, cursor);
  if (invokeOpenLength === null) {
    // A bare `<function_calls>` wrapper with no invoke is an unterminated block;
    // anything else here simply is not an invoke block.
    return hasWrapper ? { kind: "incomplete" } : { kind: "none" };
  }
  cursor = skipWhitespace(text, cursor + invokeOpenLength);
  while (true) {
    const parameterEnd = consumeXmlishAttributeParameterEnd(text, cursor);
    if (parameterEnd === null) {
      break;
    }
    cursor = skipWhitespace(text, parameterEnd);
  }
  // A real `</invoke>` close is still required: an unclosed open is `incomplete` so
  // the caller defers the remainder rather than rescanning the unterminated tail.
  const invokeCloseLength = stickyMatchLength(XMLISH_INVOKE_CLOSE_RE, text, cursor);
  if (invokeCloseLength === null) {
    return { kind: "incomplete" };
  }
  return { kind: "complete", end: finishXmlishInvokeBlockEnd(text, cursor + invokeCloseLength) };
}

/** Skips spaces and tabs only, preserving line boundaries for grammar decisions. */
export function skipHorizontalWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    index += 1;
  }
  return index;
}

/** Skips indentation whitespace without crossing the current line boundary. */
export function skipLineIndentation(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[^\S\r\n]/u.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

/** Skips all JavaScript whitespace when line structure is no longer meaningful. */
export function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

/** Consumes either Unix or Windows line endings and returns the first offset after them. */
export function consumeLineBreak(text: string, start: number): number | null {
  if (text[start] === "\r") {
    return text[start + 1] === "\n" ? start + 2 : start + 1;
  }
  if (text[start] === "\n") {
    return start + 1;
  }
  return null;
}

export type StructuralLineBreakOptions = {
  lineBreakOffsets: ReadonlySet<number>;
  usedLineBreakOffsets?: Set<number>;
};

export function consumeStructuralLineBreakAfterHorizontalWhitespace(
  text: string,
  start: number,
  options?: StructuralLineBreakOptions,
): number | null {
  const right = skipHorizontalWhitespace(text, start);
  const actual = consumeLineBreak(text, right);
  if (actual !== null) {
    return actual;
  }
  for (let offset = start; offset <= right; offset += 1) {
    if (options?.lineBreakOffsets.has(offset)) {
      options.usedLineBreakOffsets?.add(offset);
      return offset;
    }
  }
  return null;
}

const utf8Encoder = new TextEncoder();

/** Returns the encoded byte length when a source span stays within its serialized limit. */
export function utf8ByteLengthWithinLimit(
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

export type XmlishToolCallSpan = { end: number; start: number };
export type XmlishToolCallParameterSpan = {
  name: XmlishToolCallSpan;
  value: XmlishToolCallSpan;
};
type XmlishToolCallCandidate = {
  activeParameterOpenEnd?: number;
  name: XmlishToolCallSpan;
  nameComplete: boolean;
  parameters: readonly XmlishToolCallParameterSpan[];
  payload?: XmlishToolCallSpan;
  syntax: "function" | "named-bracket" | "tool-bracket";
};
export type XmlishToolCallScan =
  | { at: number; candidate?: XmlishToolCallCandidate; kind: "invalid" }
  // `completeEnd` is safe for static stripping only; the prefix remains non-executable.
  | { candidate?: XmlishToolCallCandidate; completeEnd?: number; kind: "prefix" }
  | (XmlishToolCallCandidate & {
      end: number;
      kind: "complete";
      payload: XmlishToolCallSpan;
    });

const FUNCTION_OPEN = "<function=";
const FUNCTION_CLOSE = "</function>";
const PARAMETER_OPEN = "<parameter=";
const PARAMETER_CLOSE = "</parameter>";

export function startsWithAsciiMarkerIgnoreCase(
  text: string,
  cursor: number,
  marker: string,
): boolean {
  return text.slice(cursor, cursor + marker.length).toLowerCase() === marker;
}

export function isAsciiMarkerPrefixIgnoreCase(
  text: string,
  cursor: number,
  marker: string,
): boolean {
  const rest = text.slice(cursor, cursor + marker.length).toLowerCase();
  return rest.length < marker.length && marker.startsWith(rest);
}

export function indexOfAsciiMarkerIgnoreCase(text: string, marker: string, start: number): number {
  for (
    let cursor = text.indexOf("<", start);
    cursor !== -1;
    cursor = text.indexOf("<", cursor + 1)
  ) {
    if (startsWithAsciiMarkerIgnoreCase(text, cursor, marker)) {
      return cursor;
    }
  }
  return -1;
}

/** Uncapped structural scan shared by parsing, stripping, and stream buffering. */
export function scanXmlishToolCall(
  text: string,
  start = 0,
  structuralLineBreaks?: StructuralLineBreakOptions,
): XmlishToolCallScan {
  let cursor = start;
  let syntax: XmlishToolCallCandidate["syntax"];
  let name: XmlishToolCallSpan;

  if (text[cursor] === "<") {
    if (
      !startsWithAsciiMarkerIgnoreCase(text, cursor, FUNCTION_OPEN) &&
      !isAsciiMarkerPrefixIgnoreCase(text, cursor, FUNCTION_OPEN)
    ) {
      return { kind: "invalid", at: start };
    }
    if (text.length - cursor < FUNCTION_OPEN.length) {
      return { kind: "prefix" };
    }
    cursor += FUNCTION_OPEN.length;
    const nameStart = cursor;
    while (isXmlishNameChar(text[cursor]) && cursor - nameStart < 121) {
      cursor += 1;
    }
    name = { start: nameStart, end: cursor };
    syntax = "function";
    if (cursor - nameStart > 120) {
      return { kind: "invalid", at: cursor };
    }
    if (cursor === text.length) {
      return { kind: "prefix", candidate: { syntax, name, nameComplete: false, parameters: [] } };
    }
    if (cursor === nameStart || text[cursor] !== ">") {
      return { kind: "invalid", at: cursor };
    }
    cursor += 1;
  } else if (text[cursor] === "[") {
    cursor += 1;
    const firstNameStart = cursor;
    while (isPlainTextToolNameChar(text[cursor]) && cursor - firstNameStart < 121) {
      cursor += 1;
    }
    if (cursor - firstNameStart > 120) {
      return { kind: "invalid", at: cursor };
    }
    const firstName = text.slice(firstNameStart, cursor);
    if (cursor === text.length && "tool".startsWith(firstName)) {
      return { kind: "prefix" };
    }
    syntax = "named-bracket";
    name = { start: firstNameStart, end: cursor };
    if (text[cursor] === ":" && firstName === "tool") {
      syntax = "tool-bracket";
      cursor += 1;
      const nameStart = cursor;
      while (isPlainTextToolNameChar(text[cursor]) && cursor - nameStart < 121) {
        cursor += 1;
      }
      name = { start: nameStart, end: cursor };
      if (cursor - nameStart > 120) {
        return { kind: "invalid", at: cursor };
      }
    }
    if (cursor === text.length) {
      return { kind: "prefix", candidate: { syntax, name, nameComplete: false, parameters: [] } };
    }
    if (name.start === name.end || text[cursor] !== "]") {
      return { kind: "invalid", at: cursor };
    }
    cursor += 1;
    if (syntax === "named-bracket") {
      if (cursor === text.length) {
        return { kind: "prefix", candidate: { syntax, name, nameComplete: true, parameters: [] } };
      }
      const afterLineBreak = consumeStructuralLineBreakAfterHorizontalWhitespace(
        text,
        cursor,
        structuralLineBreaks,
      );
      if (afterLineBreak === null) {
        return { kind: "invalid", at: cursor };
      }
      cursor = afterLineBreak;
    }
  } else {
    return { kind: "invalid", at: start };
  }

  const bodyStart = cursor;
  const parameters: XmlishToolCallParameterSpan[] = [];
  const candidate = (
    payloadEnd: number,
    activeParameterOpenEnd?: number,
  ): XmlishToolCallCandidate & { payload: XmlishToolCallSpan } => ({
    syntax,
    name,
    nameComplete: true,
    parameters,
    payload: { start: bodyStart, end: payloadEnd },
    ...(activeParameterOpenEnd === undefined ? {} : { activeParameterOpenEnd }),
  });
  let lastParameterEnd: number | undefined;
  const prefix = (payloadEnd: number, activeParameterOpenEnd?: number): XmlishToolCallScan => ({
    kind: "prefix",
    candidate: candidate(payloadEnd, activeParameterOpenEnd),
    completeEnd: syntax === "tool-bracket" ? lastParameterEnd : undefined,
  });
  const complete = (payloadEnd: number, end = payloadEnd): XmlishToolCallScan => ({
    kind: "complete",
    ...candidate(payloadEnd),
    end,
  });
  while (true) {
    const markerStart = skipWhitespace(text, cursor);
    if (markerStart === text.length) {
      return syntax === "tool-bracket" && lastParameterEnd !== undefined
        ? complete(lastParameterEnd)
        : { kind: "prefix", candidate: candidate(text.length) };
    }
    if (startsWithAsciiMarkerIgnoreCase(text, markerStart, FUNCTION_CLOSE)) {
      return syntax !== "function" && parameters.length === 0
        ? { kind: "invalid", at: markerStart, candidate: candidate(markerStart) }
        : complete(markerStart, markerStart + FUNCTION_CLOSE.length);
    }
    if (isAsciiMarkerPrefixIgnoreCase(text, markerStart, FUNCTION_CLOSE)) {
      return prefix(markerStart);
    }
    if (startsWithAsciiMarkerIgnoreCase(text, markerStart, PARAMETER_OPEN)) {
      const nameStart = markerStart + PARAMETER_OPEN.length;
      let nameEnd = nameStart;
      while (isXmlishNameChar(text[nameEnd]) && nameEnd - nameStart < 121) {
        nameEnd += 1;
      }
      if (nameEnd - nameStart > 120) {
        return { kind: "invalid", at: markerStart, candidate: candidate(markerStart) };
      }
      if (nameEnd === text.length) {
        return prefix(markerStart);
      }
      if (nameEnd === nameStart || text[nameEnd] !== ">") {
        return { kind: "invalid", at: markerStart, candidate: candidate(markerStart) };
      }
      const valueStart = nameEnd + 1;
      const closeStart = indexOfAsciiMarkerIgnoreCase(text, PARAMETER_CLOSE, valueStart);
      if (closeStart === -1) {
        return prefix(text.length, valueStart);
      }
      const end = closeStart + PARAMETER_CLOSE.length;
      parameters.push({
        name: { start: nameStart, end: nameEnd },
        value: { start: valueStart, end: closeStart },
      });
      cursor = end;
      lastParameterEnd = end;
      continue;
    }
    if (isAsciiMarkerPrefixIgnoreCase(text, markerStart, PARAMETER_OPEN)) {
      return prefix(markerStart);
    }
    if (syntax === "tool-bracket" && lastParameterEnd !== undefined) {
      return complete(lastParameterEnd);
    }
    return { kind: "invalid", at: markerStart, candidate: candidate(markerStart) };
  }
}
