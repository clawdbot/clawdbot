// Tool Call Repair module implements payload behavior.
import {
  consumeLineBreak,
  consumeStructuralLineBreakAfterHorizontalWhitespace,
  END_TOOL_REQUEST,
  HARMONY_CALL_MARKER,
  HARMONY_CHANNEL_MARKER,
  HARMONY_MESSAGE_MARKER,
  isPlainTextToolNameChar,
  scanXmlishToolCall,
  skipHorizontalWhitespace,
  skipLineIndentation,
  skipWhitespace,
  type StructuralLineBreakOptions,
  utf8ByteLengthWithinLimit,
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

type NormalizedPlainTextToolCallParseOptions = Omit<
  PlainTextToolCallParseOptions,
  "allowedToolNames"
> & { allowedToolNames?: ReadonlySet<string> };

const DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES = 256_000;
const MAX_PLAIN_TEXT_TOOL_NAME_CHARS = 120;
const HARMONY_CHANNELS = ["commentary", "analysis", "final"] as const;

export type PlainTextJsonToolCallSpan = { end: number; start: number };
export type PlainTextJsonToolCallSyntax = "harmony" | "named-bracket" | "tool-bracket";
export type PlainTextJsonToolCallState = {
  depth: number;
  escaped: boolean;
  inString: boolean;
};
export type PlainTextJsonToolCallCandidate = {
  json?: PlainTextJsonToolCallState;
  name: PlainTextJsonToolCallSpan;
  nameComplete: boolean;
  payload?: PlainTextJsonToolCallSpan;
  syntax: PlainTextJsonToolCallSyntax;
};
export type PlainTextJsonToolCallScan =
  | { at: number; candidate?: PlainTextJsonToolCallCandidate; kind: "invalid" }
  | { candidate?: PlainTextJsonToolCallCandidate; kind: "prefix" }
  | (PlainTextJsonToolCallCandidate & {
      end: number;
      kind: "complete";
      nameComplete: true;
      payload: PlainTextJsonToolCallSpan;
    });

export type PlainTextToolCallNameMatcher = {
  hasExactName(name: string): boolean;
  hasNamePrefix(prefix: string): boolean;
};

type PlainTextToolCallScanBranches = {
  json: PlainTextJsonToolCallScan;
  matches: { json: boolean; xmlish: boolean };
  xmlish: ReturnType<typeof scanXmlishToolCall>;
};

export type PlainTextToolCallScan = PlainTextToolCallScanBranches &
  (
    | {
        end: number;
        kind: "complete";
        next: number;
        overCap: boolean;
        payloadStart: number;
      }
    | {
        completeEnd?: number;
        kind: "prefix";
        next: number;
        overCap: boolean;
        payloadStart?: number;
      }
    | {
        at: number;
        kind: "invalid";
        next: number;
        overCap: boolean;
        payloadStart?: number;
      }
  );

type PlainTextToolCallScanCandidate = {
  name: PlainTextJsonToolCallSpan;
  nameComplete: boolean;
  payload?: PlainTextJsonToolCallSpan;
};

type PlainTextToolCallScanBranch =
  | ({
      end: number;
      kind: "complete";
      payload: PlainTextJsonToolCallSpan;
    } & PlainTextToolCallScanCandidate)
  | { candidate?: PlainTextToolCallScanCandidate; kind: "prefix" }
  | { at: number; candidate?: PlainTextToolCallScanCandidate; kind: "invalid" };

type PlainTextJsonToolCallOpening = {
  cursor: number;
  kind: "complete";
  value: PlainTextJsonToolCallCandidate & { nameComplete: true };
};
type PlainTextJsonToolCallOpeningScan =
  | PlainTextJsonToolCallOpening
  | Extract<PlainTextJsonToolCallScan, { kind: "invalid" | "prefix" }>;

function isLiteralPrefixAt(text: string, start: number, literal: string): boolean {
  const available = text.length - start;
  return start >= 0 && available < literal.length && literal.startsWith(text.slice(start));
}

function scanToolNameEnd(text: string, start: number): number | null {
  let end = start;
  while (isPlainTextToolNameChar(text[end])) {
    if (end - start === MAX_PLAIN_TEXT_TOOL_NAME_CHARS) {
      return null;
    }
    end += 1;
  }
  return end;
}

function candidate<NameComplete extends boolean>(
  syntax: PlainTextJsonToolCallSyntax,
  name: PlainTextJsonToolCallSpan,
  nameComplete: NameComplete,
  payload?: PlainTextJsonToolCallSpan,
  json?: PlainTextJsonToolCallState,
): PlainTextJsonToolCallCandidate & { nameComplete: NameComplete } {
  return { syntax, name, nameComplete, ...(payload ? { payload } : {}), ...(json ? { json } : {}) };
}

function scanBracketOpening(
  text: string,
  start: number,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextJsonToolCallOpeningScan {
  let cursor = start + 1;
  let syntax: PlainTextJsonToolCallSyntax = "named-bracket";
  if (text.startsWith("tool:", cursor)) {
    syntax = "tool-bracket";
    cursor += "tool:".length;
  } else if (isLiteralPrefixAt(text, cursor, "tool:")) {
    return { kind: "prefix" };
  }
  const nameStart = cursor;
  const nameEnd = scanToolNameEnd(text, nameStart);
  if (nameEnd === null) {
    return { kind: "invalid", at: nameStart + MAX_PLAIN_TEXT_TOOL_NAME_CHARS };
  }
  const name = { start: nameStart, end: nameEnd };
  cursor = nameEnd;
  if (cursor === text.length) {
    return {
      kind: "prefix",
      ...(nameStart === nameEnd ? {} : { candidate: candidate(syntax, name, false) }),
    };
  }
  if (nameStart === nameEnd || text[cursor] !== "]") {
    return { kind: "invalid", at: cursor };
  }
  cursor += 1;
  const value = candidate(syntax, name, true);
  if (syntax === "named-bracket") {
    const horizontalEnd = skipHorizontalWhitespace(text, cursor);
    if (horizontalEnd === text.length) {
      return { kind: "prefix", candidate: value };
    }
    const afterLineBreak = consumeStructuralLineBreakAfterHorizontalWhitespace(
      text,
      cursor,
      structuralLineBreaks,
    );
    if (afterLineBreak === null) {
      return { kind: "invalid", at: horizontalEnd, candidate: value };
    }
    cursor = afterLineBreak;
  }
  return { kind: "complete", cursor, value };
}

function scanHarmonyOpening(text: string, start: number): PlainTextJsonToolCallOpeningScan {
  let cursor = start;
  if (text.startsWith(HARMONY_CHANNEL_MARKER, cursor)) {
    cursor += HARMONY_CHANNEL_MARKER.length;
  } else if (isLiteralPrefixAt(text, cursor, HARMONY_CHANNEL_MARKER)) {
    return { kind: "prefix" };
  } else if (text[cursor] === "<") {
    return { kind: "invalid", at: cursor };
  }

  const channel = HARMONY_CHANNELS.find((value) => text.startsWith(value, cursor));
  if (!channel) {
    return HARMONY_CHANNELS.some((value) => isLiteralPrefixAt(text, cursor, value))
      ? { kind: "prefix" }
      : { kind: "invalid", at: cursor };
  }
  cursor += channel.length;
  if (cursor === text.length) {
    return { kind: "prefix" };
  }
  if (text[cursor] !== " " && text[cursor] !== "\t") {
    return { kind: "invalid", at: cursor };
  }
  cursor = skipHorizontalWhitespace(text, cursor);
  if (!text.startsWith("to=", cursor)) {
    return isLiteralPrefixAt(text, cursor, "to=")
      ? { kind: "prefix" }
      : { kind: "invalid", at: cursor };
  }
  cursor += "to=".length;

  const nameStart = cursor;
  const nameEnd = scanToolNameEnd(text, nameStart);
  if (nameEnd === null) {
    return { kind: "invalid", at: nameStart + MAX_PLAIN_TEXT_TOOL_NAME_CHARS };
  }
  const name = { start: nameStart, end: nameEnd };
  cursor = nameEnd;
  if (cursor === text.length) {
    return {
      kind: "prefix",
      ...(nameStart === nameEnd ? {} : { candidate: candidate("harmony", name, false) }),
    };
  }
  if (nameStart === nameEnd || (text[cursor] !== " " && text[cursor] !== "\t")) {
    return { kind: "invalid", at: cursor };
  }
  cursor = skipHorizontalWhitespace(text, cursor);
  const value = candidate("harmony", name, true);
  if (!text.startsWith("code", cursor)) {
    return isLiteralPrefixAt(text, cursor, "code")
      ? { kind: "prefix", candidate: value }
      : { kind: "invalid", at: cursor, candidate: value };
  }
  cursor = skipWhitespace(text, cursor + "code".length);
  if (text.startsWith(HARMONY_MESSAGE_MARKER, cursor)) {
    cursor = skipWhitespace(text, cursor + HARMONY_MESSAGE_MARKER.length);
  } else if (isLiteralPrefixAt(text, cursor, HARMONY_MESSAGE_MARKER)) {
    return { kind: "prefix", candidate: value };
  } else if (text[cursor] === "<") {
    return { kind: "invalid", at: cursor, candidate: value };
  }
  return { kind: "complete", cursor, value };
}

function scanJsonObject(
  text: string,
  start: number,
): {
  end: number;
  kind: "complete" | "prefix";
  state: PlainTextJsonToolCallState;
} {
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
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
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          kind: "complete",
          end: index + 1,
          state: { depth, escaped, inString },
        };
      }
    }
  }
  return { kind: "prefix", end: text.length, state: { depth, escaped, inString } };
}

/** Uncapped structural scan shared by parsing, stripping, and stream buffering. */
export function scanPlainTextJsonToolCall(
  text: string,
  start = 0,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextJsonToolCallScan {
  const opening =
    text[start] === "["
      ? scanBracketOpening(text, start, structuralLineBreaks)
      : scanHarmonyOpening(text, start);
  if (opening.kind !== "complete") {
    return opening;
  }

  const value = opening.value;
  const payloadStart = skipWhitespace(text, opening.cursor);
  if (payloadStart === text.length) {
    return { kind: "prefix", candidate: value };
  }
  if (text[payloadStart] !== "{") {
    return { kind: "invalid", at: payloadStart, candidate: value };
  }

  const json = scanJsonObject(text, payloadStart);
  const payload = { start: payloadStart, end: json.end };
  if (json.kind === "prefix") {
    return {
      kind: "prefix",
      candidate: candidate(value.syntax, value.name, true, payload, json.state),
    };
  }

  const closingCandidate = candidate(value.syntax, value.name, true, payload, json.state);
  if (value.syntax !== "named-bracket") {
    const markerStart = skipWhitespace(text, json.end);
    const name = text.slice(value.name.start, value.name.end);
    const closings = [HARMONY_CALL_MARKER, END_TOOL_REQUEST, `[/${name}]`];
    for (const closing of closings) {
      if (text.startsWith(closing, markerStart)) {
        return {
          ...value,
          kind: "complete",
          payload,
          end: markerStart + closing.length,
        };
      }
      if (markerStart < text.length && isLiteralPrefixAt(text, markerStart, closing)) {
        return { kind: "prefix", candidate: closingCandidate };
      }
    }
    return {
      ...value,
      kind: "complete",
      payload,
      end: json.end,
    };
  }

  const closingStart = skipWhitespace(text, json.end);
  if (closingStart === text.length) {
    return { kind: "prefix", candidate: closingCandidate };
  }
  const name = text.slice(value.name.start, value.name.end);
  const closings = [END_TOOL_REQUEST, `[/${name}]`];
  for (const closing of closings) {
    if (text.startsWith(closing, closingStart)) {
      return {
        ...value,
        payload,
        kind: "complete",
        end: closingStart + closing.length,
      };
    }
    if (isLiteralPrefixAt(text, closingStart, closing)) {
      return { kind: "prefix", candidate: closingCandidate };
    }
  }
  return { kind: "invalid", at: closingStart, candidate: closingCandidate };
}

/** Classifies one JSON/XML call candidate and provides monotonic scan progress. */
export function scanPlainTextToolCall(
  text: string,
  start = 0,
  options?: {
    matcher?: PlainTextToolCallNameMatcher;
    maxPayloadBytes?: number;
    structuralLineBreaks?: StructuralLineBreakOptions;
  },
): PlainTextToolCallScan {
  const xmlish = scanXmlishToolCall(text, start, options?.structuralLineBreaks);
  const json = scanPlainTextJsonToolCall(text, start, options?.structuralLineBreaks);
  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
  const allowed = (
    scan: PlainTextToolCallScanBranch,
  ): {
    accepted: boolean;
    payload?: PlainTextJsonToolCallSpan;
    value?: PlainTextToolCallScanCandidate;
  } => {
    const value = scan.kind === "complete" ? scan : scan.candidate;
    if (!value) {
      return { accepted: scan.kind === "prefix" };
    }
    const name = text.slice(value.name.start, value.name.end);
    const matches = value.nameComplete
      ? (options?.matcher?.hasExactName(name) ?? true)
      : (options?.matcher?.hasNamePrefix(name) ?? true);
    return matches
      ? { accepted: true, value, ...(value.payload ? { payload: value.payload } : {}) }
      : { accepted: false };
  };
  const xml = allowed(xmlish);
  const jsonValue = allowed(json);
  const branches = {
    json,
    matches: { json: jsonValue.accepted, xmlish: xml.accepted },
    xmlish,
  };
  const overCap = (payload?: PlainTextJsonToolCallSpan) =>
    Boolean(
      payload &&
      utf8ByteLengthWithinLimit(text, payload.start, payload.end, maxPayloadBytes) === null,
    );
  const xmlOverCap = overCap(xml.payload);
  const jsonOverCap = overCap(jsonValue.payload);

  if (xml.accepted && xmlish.kind === "complete") {
    return {
      ...branches,
      end: xmlish.end,
      kind: "complete",
      next: xmlish.end,
      overCap: xmlOverCap,
      payloadStart: xmlish.payload.start,
    };
  }
  if (jsonValue.accepted && json.kind === "complete") {
    if (jsonOverCap || parseJsonArguments(text, json.payload)) {
      return {
        ...branches,
        end: json.end,
        kind: "complete",
        next: json.end,
        overCap: jsonOverCap,
        payloadStart: json.payload.start,
      };
    }
    return {
      ...branches,
      at: json.end,
      kind: "invalid",
      next: json.end,
      overCap: false,
      payloadStart: json.payload.start,
    };
  }

  if (xml.accepted && xmlish.kind === "invalid" && xmlOverCap && xml.payload) {
    return {
      ...branches,
      at: xmlish.at,
      kind: "invalid",
      next: xmlish.at,
      overCap: true,
      payloadStart: xml.payload.start,
    };
  }
  if (jsonValue.accepted && json.kind === "invalid" && jsonOverCap && jsonValue.payload) {
    return {
      ...branches,
      at: json.at,
      kind: "invalid",
      next: json.at,
      overCap: true,
      payloadStart: jsonValue.payload.start,
    };
  }

  const xmlPrefix = xml.accepted && xmlish.kind === "prefix";
  const jsonPrefix = jsonValue.accepted && json.kind === "prefix";
  if (xmlPrefix || jsonPrefix) {
    const payload = xmlPrefix ? xml.payload : jsonValue.payload;
    return {
      ...branches,
      ...(xmlish.kind === "prefix" && xmlish.completeEnd !== undefined
        ? { completeEnd: xmlish.completeEnd }
        : {}),
      kind: "prefix",
      next: text.length,
      overCap: overCap(payload),
      ...(payload ? { payloadStart: payload.start } : {}),
    };
  }

  let next = start + 1;
  if (xml.accepted) {
    next = Math.max(next, xmlish.kind === "invalid" ? xmlish.at : text.length);
  }
  if (jsonValue.accepted) {
    next = Math.max(
      next,
      json.kind === "complete" ? json.end : json.kind === "invalid" ? json.at : text.length,
    );
  }
  return { ...branches, at: next, kind: "invalid", next, overCap: false };
}

function parsePlainTextToolCallBlockAt(
  text: string,
  start: number,
  options?: NormalizedPlainTextToolCallParseOptions,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextToolCallBlock | null {
  const scan = scanPlainTextJsonToolCall(text, start, structuralLineBreaks);
  if (scan.kind !== "complete") {
    return null;
  }
  const name = text.slice(scan.name.start, scan.name.end);
  if (options?.allowedToolNames && !options.allowedToolNames.has(name)) {
    return null;
  }
  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
  if (
    utf8ByteLengthWithinLimit(text, scan.payload.start, scan.payload.end, maxPayloadBytes) === null
  ) {
    return null;
  }
  const argumentsValue = parseJsonArguments(text, scan.payload);
  if (!argumentsValue) {
    return null;
  }
  return {
    arguments: argumentsValue,
    end: scan.end,
    name,
    raw: text.slice(start, scan.end),
    start,
  };
}

function parseJsonArguments(
  text: string,
  payload: PlainTextJsonToolCallSpan,
): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text.slice(payload.start, payload.end)) as unknown;
  } catch {
    return null;
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractXmlishParameterValue(
  text: string,
  start: number,
  end: number,
  structuralLineBreaks?: StructuralLineBreakOptions,
): string {
  let value = text.slice(start, end);
  if (consumeLineBreak(text, skipHorizontalWhitespace(text, start)) === null) {
    const boundary = consumeStructuralLineBreakAfterHorizontalWhitespace(
      text,
      start,
      structuralLineBreaks,
    );
    if (boundary !== null) {
      const offset = boundary - start;
      value = `${value.slice(0, offset)}\n${value.slice(offset)}`;
    }
  }
  const payloadStart = consumeLineBreak(value, 0);
  if (payloadStart === null) {
    return value;
  }
  return value.slice(payloadStart).replace(/(?:\r\n|[\r\n])$/u, "");
}

function parseXmlishPlainTextToolCallBlockAt(
  text: string,
  start: number,
  options?: NormalizedPlainTextToolCallParseOptions,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextToolCallBlock | null {
  const scan = scanXmlishToolCall(text, start, structuralLineBreaks);
  if (scan.kind !== "complete") {
    return null;
  }
  const name = text.slice(scan.name.start, scan.name.end);
  if (options?.allowedToolNames && !options.allowedToolNames.has(name)) {
    return null;
  }

  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PLAIN_TEXT_TOOL_PAYLOAD_BYTES;
  if (
    utf8ByteLengthWithinLimit(text, scan.payload.start, scan.payload.end, maxPayloadBytes) === null
  ) {
    return null;
  }
  const args = Object.fromEntries(
    scan.parameters.map((parameter) => [
      text.slice(parameter.name.start, parameter.name.end),
      extractXmlishParameterValue(
        text,
        parameter.value.start,
        parameter.value.end,
        structuralLineBreaks,
      ),
    ]),
  );
  return {
    arguments: args,
    end: scan.end,
    name,
    raw: text.slice(start, scan.end),
    start,
  };
}

function parsePlainTextToolCallBlockAtAnySyntax(
  text: string,
  start: number,
  options?: NormalizedPlainTextToolCallParseOptions,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextToolCallBlock | null {
  return (
    parsePlainTextToolCallBlockAt(text, start, options, structuralLineBreaks) ??
    parseXmlishPlainTextToolCallBlockAt(text, start, options, structuralLineBreaks)
  );
}

function normalizeParseOptions(
  options?: PlainTextToolCallParseOptions,
): NormalizedPlainTextToolCallParseOptions | undefined {
  return options
    ? {
        ...options,
        allowedToolNames: options.allowedToolNames ? new Set(options.allowedToolNames) : undefined,
      }
    : undefined;
}

/** Parses one canonical call prefix while allowing unrelated visible suffix text. */
export function parsePlainTextToolCallPrefix(
  text: string,
  start = 0,
  options?: PlainTextToolCallParseOptions,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextToolCallBlock | null {
  return parsePlainTextToolCallBlockAtAnySyntax(
    text,
    start,
    normalizeParseOptions(options),
    structuralLineBreaks,
  );
}

export function parseStandalonePlainTextToolCallBlocks(
  text: string,
  options?: PlainTextToolCallParseOptions,
  structuralLineBreaks?: StructuralLineBreakOptions,
): PlainTextToolCallBlock[] | null {
  const blocks: PlainTextToolCallBlock[] = [];
  const normalizedOptions = normalizeParseOptions(options);
  let cursor = skipWhitespace(text, 0);
  while (cursor < text.length) {
    const block = parsePlainTextToolCallBlockAtAnySyntax(
      text,
      cursor,
      normalizedOptions,
      structuralLineBreaks,
    );
    if (!block) {
      return null;
    }
    blocks.push(block);
    cursor = skipWhitespace(text, block.end);
  }
  return blocks.length > 0 ? blocks : null;
}

/** Removes full-line standalone plain-text tool-call blocks from user-visible text. */
export function stripPlainTextToolCallBlocks(text: string): string {
  if (
    !text ||
    (!/\[(?:tool:)?[A-Za-z0-9_-]+\]/.test(text) &&
      !/(?:^|[\r\n])[^\S\r\n]*(?:<\|channel\|>)?(?:commentary|analysis|final)[ \t]+to=/.test(
        text,
      ) &&
      !/(?:^|[\r\n])[^\S\r\n]*<function=/i.test(text))
  ) {
    return text;
  }
  let result = "";
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const lineStart = index === 0 || text[index - 1] === "\n" || text[index - 1] === "\r";
    if (!lineStart) {
      index += 1;
      continue;
    }
    const blockStart = skipLineIndentation(text, index);
    const scan = scanPlainTextToolCall(text, blockStart);
    if (scan.kind === "prefix" && scan.completeEnd === undefined) {
      return result + text.slice(cursor);
    }
    if (scan.kind === "invalid") {
      // The scanner owns everything before `at` as one malformed candidate. Honor that
      // progress so nested line starts inside its payload are not rescanned quadratically.
      index = Math.max(index + 1, scan.next);
      continue;
    }
    let blockEnd = scan.kind === "complete" ? scan.end : scan.completeEnd;
    if (blockEnd === undefined) {
      return result + text.slice(cursor);
    }
    result += text.slice(cursor, index);
    while (true) {
      const adjacentStart = skipLineIndentation(text, blockEnd);
      const adjacent = scanPlainTextToolCall(text, adjacentStart);
      const adjacentEnd =
        adjacent.kind === "complete"
          ? adjacent.end
          : adjacent.kind === "prefix"
            ? adjacent.completeEnd
            : undefined;
      if (adjacentEnd === undefined || adjacentEnd <= blockEnd) {
        break;
      }
      blockEnd = adjacentEnd;
    }
    const lineBreakStart = skipLineIndentation(text, blockEnd);
    cursor =
      lineBreakStart === text.length
        ? lineBreakStart
        : (consumeLineBreak(text, lineBreakStart) ?? blockEnd);
    index = cursor;
  }
  result += text.slice(cursor);
  return result;
}
