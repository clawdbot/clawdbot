import {
  consumeLineBreak,
  END_TOOL_REQUEST,
  HARMONY_CALL_MARKER,
  indexOfAsciiMarkerIgnoreCase,
  isAsciiMarkerPrefixIgnoreCase,
  isXmlishNameChar,
  skipLineIndentation,
  skipWhitespace,
  startsWithAsciiMarkerIgnoreCase,
  type StructuralLineBreakOptions,
  utf8ByteLengthWithinLimit,
} from "./grammar.js";
import {
  scanPlainTextToolCall,
  type PlainTextToolCallNameMatcher,
  type PlainTextToolCallScan,
} from "./payload.js";
import type { PlainTextToolCallMessageProjection } from "./promote.js";

export type { PlainTextToolCallNameMatcher } from "./payload.js";

/** Result of repairing the final message carried by a provider stream `done` event. */
export type PlainTextToolCallMessageNormalization =
  | (PlainTextToolCallMessageProjection & { kind: "promoted" | "scrubbed" })
  | undefined;

/** Stream-level hooks used to promote leaked text tool calls into provider events. */
export type PlainTextToolCallStreamNormalizerOptions = {
  /** Expands a promoted final message into provider-native tool-call stream events. */
  createPromotedToolCallEvents(message: Record<string, unknown>): Iterable<unknown>;
  /** Tool-name matcher scoped to the exact request being normalized. */
  matcher: PlainTextToolCallNameMatcher;
  /** Promotes an eligible terminal snapshot or scrubs every recognized candidate. */
  normalizeTerminalMessage(params: {
    allowPromotion: boolean;
    message: unknown;
    preserveEmptyTextBlocks?: boolean;
    reason: unknown;
  }): PlainTextToolCallMessageNormalization;
  /** Stop after the first normalized done event when the wrapped provider has completed. */
  stopAfterDone?: boolean;
};

const MAX_PAYLOAD_BYTES = 256_000;
const MAX_PENDING_EVENTS = 256;
const MAX_TOOL_NAME_CHARS = 120;

type TextRange = { end: number; start: number };
type StandalonePlainTextToolCallCandidate = {
  parts: Array<{ contentIndex: number; end: number; start: number }>;
  text: string;
};
type ScannedCallSequence = TextRange & { activeStart?: number; overCap: boolean };
type XmlSuppressor = { carry: string; kind: "xml"; phase: "body" | "parameter" };

type JsonSuppressor = {
  carry: string;
  depth: number;
  escaped: boolean;
  inString: boolean;
  kind: "json";
  optionalClosings?: readonly string[];
  phase: "closing" | "opening" | "payload";
  requiredClosing?: string;
};

type OpeningSuppressor = {
  allowXml: boolean;
  carry: string;
  choice?: JsonSuppressor | XmlSuppressor;
  json: JsonSuppressor;
  kind: "opening";
};

type OverCapSuppressor = JsonSuppressor | OpeningSuppressor | XmlSuppressor;

type CandidatePendingState = {
  buffer: string;
  bufferBytes: number;
  entryBytes: number;
  entries?: Record<string, unknown>[];
  kind: "candidate";
  nextScanChars: number;
  parts: StandalonePlainTextToolCallCandidate["parts"];
  sequenceOverCap: boolean;
  snapshotOffset: number;
  template: Record<string, unknown>;
};

type SuppressingPendingState = {
  entryBytes: number;
  entries?: Record<string, unknown>[];
  kind: "suppressing";
  suppressor?: OverCapSuppressor;
};

type PendingState = CandidatePendingState | SuppressingPendingState;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function eventContentIndex(event: Record<string, unknown>): number {
  const index = event.contentIndex;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : 0;
}

function isTextStreamEvent(event: Record<string, unknown>): boolean {
  return event.type === "text_start" || event.type === "text_delta" || event.type === "text_end";
}

function extractStandaloneCandidate(
  message: unknown,
  requireAssistantRole = false,
): StandalonePlainTextToolCallCandidate | undefined {
  const record = asRecord(message);
  if (!record || (requireAssistantRole && record.role !== "assistant")) {
    return undefined;
  }
  if (typeof record.content === "string") {
    return record.content.trim() ? { text: record.content, parts: [] } : undefined;
  }
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const candidate: StandalonePlainTextToolCallCandidate = { text: "", parts: [] };
  for (const [contentIndex, block] of record.content.entries()) {
    const value = asRecord(block);
    if (!value) {
      return undefined;
    }
    if (value.type !== "text") {
      continue;
    }
    if (typeof value.text !== "string") {
      return undefined;
    }
    const start = candidate.text.length;
    candidate.text += value.text;
    candidate.parts.push({ contentIndex, start, end: candidate.text.length });
  }
  return candidate.text.trim() ? candidate : undefined;
}

function scannedCall(scan: PlainTextToolCallScan) {
  if (scan.kind === "complete") {
    return {
      end: scan.end,
      incomplete: false,
      overCap: scan.overCap,
      payloadStart: scan.payloadStart,
    };
  }
  if (scan.overCap && scan.payloadStart !== undefined) {
    return {
      end: scan.kind === "prefix" ? scan.next : scan.at,
      incomplete: scan.kind === "prefix",
      overCap: true,
      payloadStart: scan.payloadStart,
    };
  }
  return null;
}

function scanHasNamedCandidate(scan: PlainTextToolCallScan): boolean {
  const branches = [scan.json, scan.xmlish] as Array<{
    candidate?: { name?: TextRange };
    name?: TextRange;
  }>;
  return branches.some((branch) => {
    const name = branch.candidate?.name ?? branch.name;
    return name !== undefined && name.end > name.start;
  });
}

function consumeRemovedLineEnd(text: string, end: number): number {
  const lineBreakStart = skipLineIndentation(text, end);
  if (lineBreakStart === text.length) {
    return lineBreakStart;
  }
  return consumeLineBreak(text, lineBreakStart) ?? end;
}

function findUtf8OverCapOffset(text: string, start: number): number | null {
  let bytes = 0;
  for (let index = start; index < text.length;) {
    const code = text.codePointAt(index) ?? 0;
    index += code > 0xffff ? 2 : 1;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > MAX_PAYLOAD_BYTES) {
      return index;
    }
  }
  return null;
}

function findCallSequences(
  text: string,
  matcher: PlainTextToolCallNameMatcher,
  structuralBoundaries: readonly number[] = [],
  structuralLineBreaks?: StructuralLineBreakOptions,
): ScannedCallSequence[] {
  const sequences: ScannedCallSequence[] = [];
  const structuralBoundarySet = new Set(structuralBoundaries);
  let structuralBoundaryIndex = 0;
  let index = 0;
  while (index < text.length) {
    const lineStart =
      index === 0 ||
      text[index - 1] === "\n" ||
      text[index - 1] === "\r" ||
      structuralBoundarySet.has(index);
    if (!lineStart) {
      index += 1;
      continue;
    }
    const sequenceStart = index;
    let callStart = skipLineIndentation(text, index);
    let sequenceEnd = callStart;
    let hasOverCap = false;
    let activeStart: number | undefined;
    let callCount = 0;
    const first = scanPlainTextToolCall(text, callStart, {
      matcher,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
      structuralLineBreaks,
    });
    let call = scannedCall(first);
    if (!call && first.kind === "prefix" && scanHasNamedCandidate(first)) {
      activeStart = callStart;
      callCount = 1;
      sequenceEnd = text.length;
    }
    while (call && callStart < text.length) {
      if (call.incomplete && call.overCap) {
        const overCapOffset = findUtf8OverCapOffset(text, call.payloadStart);
        while (
          structuralBoundaryIndex < structuralBoundaries.length &&
          (structuralBoundaries[structuralBoundaryIndex] ?? 0) < (overCapOffset ?? Infinity)
        ) {
          structuralBoundaryIndex += 1;
        }
        let boundary: number | undefined;
        while (structuralBoundaryIndex < structuralBoundaries.length) {
          const offset = structuralBoundaries[structuralBoundaryIndex];
          structuralBoundaryIndex += 1;
          const boundaryScan =
            offset === undefined
              ? undefined
              : scanPlainTextToolCall(text, skipLineIndentation(text, offset), {
                  matcher,
                  maxPayloadBytes: MAX_PAYLOAD_BYTES,
                  structuralLineBreaks,
                });
          if (boundaryScan && scannedCall(boundaryScan)) {
            boundary = offset;
            break;
          }
        }
        if (boundary !== undefined) {
          call.end = boundary;
          call.incomplete = false;
        }
      }
      callCount += 1;
      hasOverCap ||= call.overCap;
      sequenceEnd = consumeRemovedLineEnd(text, call.end);
      if (call.incomplete) {
        activeStart = callStart;
        break;
      }
      const nextStart = skipWhitespace(text, call.end);
      if (nextStart >= text.length) {
        break;
      }
      const nextScan = scanPlainTextToolCall(text, nextStart, {
        matcher,
        maxPayloadBytes: MAX_PAYLOAD_BYTES,
        structuralLineBreaks,
      });
      const next = scannedCall(nextScan);
      if (!next) {
        if (nextScan.kind === "prefix" && scanHasNamedCandidate(nextScan)) {
          activeStart = nextStart;
          sequenceEnd = text.length;
        }
        break;
      }
      callStart = nextStart;
      call = next;
    }
    if (callCount > 0) {
      const aggregateOverCap =
        utf8ByteLengthWithinLimit(text, sequenceStart, sequenceEnd, MAX_PAYLOAD_BYTES) === null;
      sequences.push({
        start: sequenceStart,
        end: sequenceEnd,
        ...(activeStart === undefined ? {} : { activeStart }),
        overCap: hasOverCap || aggregateOverCap,
      });
      index = Math.max(sequenceEnd, index + 1);
      continue;
    }
    index = Math.max(index + 1, first.next);
  }
  return sequences;
}

function createCandidateScanView(candidate: StandalonePlainTextToolCallCandidate) {
  const boundaries = candidate.parts.slice(1).map((part) => part.start);
  return {
    boundaries,
    text: candidate.text,
    ...(boundaries.length > 0
      ? { structuralLineBreaks: { lineBreakOffsets: new Set(boundaries) } }
      : {}),
  };
}

function findCandidateCallSequences(
  candidate: StandalonePlainTextToolCallCandidate,
  matcher: PlainTextToolCallNameMatcher,
): ScannedCallSequence[] {
  const view = createCandidateScanView(candidate);
  return findCallSequences(view.text, matcher, view.boundaries, view.structuralLineBreaks);
}

function createRangeRemover(ranges: readonly TextRange[]) {
  let rangeIndex = 0;
  return (text: string, offset = 0): string => {
    let result = "";
    let cursor = 0;
    const endOffset = offset + text.length;
    while ((ranges[rangeIndex]?.end ?? Infinity) <= offset) {
      rangeIndex += 1;
    }
    for (
      let range = ranges[rangeIndex];
      range && range.start < endOffset;
      range = ranges[rangeIndex]
    ) {
      const start = Math.max(0, range.start - offset);
      const end = Math.min(text.length, range.end - offset);
      if (end > start) {
        result += text.slice(cursor, Math.max(cursor, start));
        cursor = Math.max(cursor, end);
      }
      if (range.end > endOffset) {
        break;
      }
      rangeIndex += 1;
    }
    return cursor ? result + text.slice(cursor) : text;
  };
}

function projectRangesOntoMessage(
  record: Record<string, unknown>,
  candidate: StandalonePlainTextToolCallCandidate,
  ranges: readonly TextRange[],
  preserveEmptyTextBlocks: boolean,
): PlainTextToolCallMessageProjection {
  const removeRanges = createRangeRemover(ranges);
  if (typeof record.content === "string") {
    return {
      message: { ...record, content: removeRanges(record.content) },
      sourceToProjectedContentIndex: new Map([[0, 0]]),
    };
  }
  if (!Array.isArray(record.content)) {
    return { message: record, sourceToProjectedContentIndex: new Map() };
  }
  const parts = new Map(candidate.parts.map((part) => [part.contentIndex, part]));
  const content: unknown[] = [];
  const sourceToProjectedContentIndex = new Map<number, number>();
  for (const [index, block] of record.content.entries()) {
    const part = parts.get(index);
    const blockRecord = asRecord(block);
    if (!part || blockRecord?.type !== "text" || typeof blockRecord.text !== "string") {
      sourceToProjectedContentIndex.set(index, content.length);
      content.push(block);
      continue;
    }
    const text = removeRanges(blockRecord.text, part.start);
    if (text || preserveEmptyTextBlocks) {
      sourceToProjectedContentIndex.set(index, content.length);
      content.push({ ...blockRecord, text });
    }
  }
  return { message: { ...record, content }, sourceToProjectedContentIndex };
}

/** Scrubs unsafe or mixed calls and maps each retained source content block. */
export function projectScrubbedPlainTextToolCallMessage(params: {
  forceIncompleteCandidates?: boolean;
  forceKnownCandidates?: boolean;
  matcher: PlainTextToolCallNameMatcher;
  message: unknown;
  preserveEmptyTextBlocks?: boolean;
  requireAssistantRole?: boolean;
}): PlainTextToolCallMessageProjection | undefined {
  const record = asRecord(params.message);
  const candidate = extractStandaloneCandidate(
    params.message,
    params.requireAssistantRole === true,
  );
  if (!record || !candidate) {
    return undefined;
  }
  const sequences = findCandidateCallSequences(candidate, params.matcher);
  const visibleOutsideCalls = Boolean(createRangeRemover(sequences)(candidate.text).trim());
  const ranges = sequences.filter(
    (sequence) =>
      params.forceKnownCandidates ||
      sequence.overCap ||
      visibleOutsideCalls ||
      (params.forceIncompleteCandidates && sequence.activeStart !== undefined),
  );
  return ranges.length > 0
    ? projectRangesOntoMessage(record, candidate, ranges, params.preserveEmptyTextBlocks === true)
    : undefined;
}

function findPotentialCallStart(
  text: string,
  atLineStart: boolean,
  matcher: PlainTextToolCallNameMatcher,
): number | null {
  for (let index = 0; index < text.length;) {
    const lineStart =
      (index === 0 && atLineStart) || text[index - 1] === "\n" || text[index - 1] === "\r";
    if (!lineStart) {
      index += 1;
      continue;
    }
    const start = skipLineIndentation(text, index);
    const scan = scanPlainTextToolCall(text, start, {
      matcher,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
    });
    if (scan.kind === "prefix" || scannedCall(scan)) {
      return index;
    }
    index = Math.max(index + 1, scan.next);
  }
  return null;
}

function nextAtLineStart(previous: boolean, text: string): boolean {
  if (!text) {
    return previous;
  }
  return text.endsWith("\n") || text.endsWith("\r");
}

function eventTemplate(event: Record<string, unknown>): Record<string, unknown> {
  const template = { ...event };
  delete template.content;
  delete template.delta;
  delete template.partial;
  return template;
}

function createSyntheticTextDelta(
  template: Record<string, unknown>,
  text: string,
  partial?: Record<string, unknown>,
): Record<string, unknown> {
  const event = eventTemplate(template);
  return {
    ...event,
    type: "text_delta",
    delta: text,
    ...(partial ? { partial } : {}),
  };
}

function cappedUtf8ByteLength(text: string): number {
  return (
    utf8ByteLengthWithinLimit(text, 0, text.length, MAX_PAYLOAD_BYTES) ?? MAX_PAYLOAD_BYTES + 1
  );
}

function pendingEventBytes(record: Record<string, unknown>): number {
  const delta = typeof record.delta === "string" ? cappedUtf8ByteLength(record.delta) : 0;
  const content = typeof record.content === "string" ? cappedUtf8ByteLength(record.content) : 0;
  return Math.min(MAX_PAYLOAD_BYTES + 1, delta + content);
}

function pendingQueueOverCap(pending: CandidatePendingState | SuppressingPendingState): boolean {
  return (
    pending.entryBytes > MAX_PAYLOAD_BYTES || (pending.entries?.length ?? 0) > MAX_PENDING_EVENTS
  );
}

function createPendingState(
  record: Record<string, unknown>,
  text: string,
  heldStart?: Record<string, unknown>,
  sequenceOverCap = false,
  snapshotOffset = 0,
): CandidatePendingState {
  const entries = [...(heldStart ? [{ ...heldStart }] : []), { ...record }];
  return {
    buffer: text,
    bufferBytes: cappedUtf8ByteLength(text),
    entries,
    entryBytes: entries.reduce((total, entry) => {
      return Math.min(MAX_PAYLOAD_BYTES + 1, total + pendingEventBytes(entry));
    }, 0),
    kind: "candidate",
    nextScanChars: 256,
    parts: [
      {
        contentIndex: eventContentIndex(record),
        start: 0,
        end: text.length,
      },
    ],
    sequenceOverCap,
    snapshotOffset,
    template: eventTemplate(record),
  };
}

function queuePendingEvent(
  pending: CandidatePendingState | SuppressingPendingState,
  record: Record<string, unknown>,
): void {
  if (!pending.entries) {
    return;
  }
  const event = { ...record };
  pending.entryBytes = Math.min(
    MAX_PAYLOAD_BYTES + 1,
    pending.entryBytes + pendingEventBytes(event),
  );
  const previous = pending.entries.at(-1);
  const canMerge =
    typeof previous?.delta === "string" &&
    typeof event.delta === "string" &&
    previous.type === event.type &&
    eventContentIndex(previous) === eventContentIndex(event);
  if (!canMerge || !previous) {
    pending.entries.push(event);
    return;
  }
  previous.delta = (previous.delta as string) + (event.delta as string);
  if (Object.hasOwn(event, "partial")) {
    previous.partial = event.partial;
  }
}

function appendPendingText(
  pending: CandidatePendingState,
  text: string,
  record: Record<string, unknown>,
): void {
  queuePendingEvent(pending, record);
  if (text) {
    const start = pending.buffer.length;
    const high = pending.buffer.charCodeAt(pending.buffer.length - 1);
    const low = text.charCodeAt(0);
    const joinedPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
    pending.bufferBytes = Math.min(
      MAX_PAYLOAD_BYTES + 1,
      pending.bufferBytes + cappedUtf8ByteLength(text) - (joinedPair ? 2 : 0),
    );
    pending.buffer += text;
    const contentIndex = eventContentIndex(record);
    const previous = pending.parts.at(-1);
    if (previous?.contentIndex === contentIndex) {
      previous.end = pending.buffer.length;
    } else {
      pending.parts.push({ contentIndex, start, end: pending.buffer.length });
    }
  }
  pending.template = eventTemplate(record);
}

function replayFalsePositiveCandidate(pending: CandidatePendingState): Record<string, unknown>[] {
  return pending.entries ?? [createSyntheticTextDelta(pending.template, pending.buffer)];
}

function projectPendingAuxEvents(
  pending: CandidatePendingState | SuppressingPendingState,
  projection?: PlainTextToolCallMessageProjection,
  projectPartial?: (message: unknown) => PlainTextToolCallMessageProjection | undefined,
  retainedTextContentIndex?: number,
): Record<string, unknown>[] {
  return (pending.entries ?? []).flatMap((event) => {
    if (isTextStreamEvent(event)) {
      if (event.type !== "text_start" || eventContentIndex(event) !== retainedTextContentIndex) {
        return [];
      }
    }
    let eventProjection = projection ?? projectPartial?.(event.partial);
    const projectedEvent = { ...event };
    if (eventProjection && typeof event.contentIndex === "number") {
      let contentIndex = eventProjection.sourceToProjectedContentIndex.get(event.contentIndex);
      if (contentIndex === undefined && projection) {
        const partialProjection = projectPartial?.(event.partial);
        const partialContentIndex = partialProjection?.sourceToProjectedContentIndex.get(
          event.contentIndex,
        );
        if (partialProjection && partialContentIndex !== undefined) {
          eventProjection = partialProjection;
          contentIndex = partialContentIndex;
        }
      }
      if (contentIndex === undefined) {
        return [];
      }
      projectedEvent.contentIndex = contentIndex;
    }
    if (Object.hasOwn(projectedEvent, "partial")) {
      if (eventProjection) {
        projectedEvent.partial = eventProjection.message;
      }
    }
    return [projectedEvent];
  });
}

function projectEventIndex(
  event: Record<string, unknown>,
  projection: PlainTextToolCallMessageProjection,
): Record<string, unknown> | undefined {
  if (typeof event.contentIndex !== "number") {
    return event;
  }
  const contentIndex = projection.sourceToProjectedContentIndex.get(event.contentIndex);
  return contentIndex === undefined ? undefined : { ...event, contentIndex };
}

function projectedTextForEvent(
  event: Record<string, unknown>,
  projection: PlainTextToolCallMessageProjection,
): string | undefined {
  const content = asRecord(projection.message)?.content;
  if (typeof content === "string") {
    return content;
  }
  const projectedIndex = projection.sourceToProjectedContentIndex.get(eventContentIndex(event));
  const block =
    Array.isArray(content) && projectedIndex !== undefined
      ? asRecord(content[projectedIndex])
      : undefined;
  return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

type PendingClassification =
  | { kind: "complete" }
  | { kind: "false-positive" }
  | { kind: "incomplete" }
  | { kind: "stripped"; text: string }
  | { kind: "suppress"; suppressor: OverCapSuppressor }
  | { candidate: StandalonePlainTextToolCallCandidate; kind: "trim" };

const XML_PARAMETER_CLOSE = "</parameter>";
const XML_FUNCTION_CLOSE = "</function>";
const XML_PARAMETER_OPEN = "<parameter=";

function createOverCapSuppressor(
  candidate: StandalonePlainTextToolCallCandidate,
  matcher: PlainTextToolCallNameMatcher,
  force = false,
): OverCapSuppressor | undefined {
  const view = createCandidateScanView(candidate);
  const start = skipLineIndentation(view.text, 0);
  const scan = scanPlainTextToolCall(view.text, start, {
    matcher,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    structuralLineBreaks: view.structuralLineBreaks,
  });
  const { json, matches, xmlish } = scan;
  const value =
    json.kind === "prefix" ? json.candidate : json.kind === "complete" ? json : undefined;
  const state =
    value?.json ??
    (json.kind === "complete" ? { depth: 0, escaped: false, inString: false } : undefined);
  const name = value ? view.text.slice(value.name.start, value.name.end) : "";
  const jsonSuppressor: JsonSuppressor | undefined = value
    ? {
        kind: "json",
        carry:
          value.payload && state?.depth === 0
            ? view.text.slice(skipWhitespace(view.text, value.payload.end))
            : "",
        depth: state?.depth ?? 0,
        escaped: state?.escaped ?? false,
        inString: state?.inString ?? false,
        phase: !value.payload ? "opening" : state?.depth === 0 ? "closing" : "payload",
        ...(value.syntax === "named-bracket"
          ? { requiredClosing: `[/${name}]` }
          : { optionalClosings: [HARMONY_CALL_MARKER, END_TOOL_REQUEST, `[/${name}]`] }),
      }
    : undefined;
  if (force && jsonSuppressor && value?.nameComplete === true && !value.payload && matches.json) {
    return {
      allowXml: xmlish.kind === "prefix" && matches.xmlish,
      carry: "",
      json: jsonSuppressor,
      kind: "opening",
    };
  }
  if (
    xmlish.kind === "prefix" &&
    matches.xmlish &&
    xmlish.candidate?.payload &&
    (force ||
      utf8ByteLengthWithinLimit(
        view.text,
        xmlish.candidate.payload.start,
        xmlish.candidate.payload.end,
        MAX_PAYLOAD_BYTES,
      ) === null)
  ) {
    const phase = xmlish.candidate.activeParameterOpenEnd === undefined ? "body" : "parameter";
    const markers =
      phase === "parameter" ? [XML_PARAMETER_CLOSE] : [XML_PARAMETER_OPEN, XML_FUNCTION_CLOSE];
    const markerStart = view.text.lastIndexOf("<");
    const carry =
      markerStart !== -1 &&
      markers.some((marker) => isAsciiMarkerPrefixIgnoreCase(view.text, markerStart, marker))
        ? view.text.slice(markerStart)
        : "";
    return {
      kind: "xml",
      carry,
      phase,
    };
  }
  if (
    !value ||
    !jsonSuppressor ||
    (!value.nameComplete && !value.payload) ||
    !matches.json ||
    (!state && !force) ||
    (!value.payload && !force) ||
    (!force &&
      value.payload &&
      utf8ByteLengthWithinLimit(
        view.text,
        value.payload.start,
        value.payload.end,
        MAX_PAYLOAD_BYTES,
      ) !== null)
  ) {
    return undefined;
  }
  return jsonSuppressor;
}

function classifyPending(
  pending: CandidatePendingState,
  matcher: PlainTextToolCallNameMatcher,
  finalize = false,
): PendingClassification {
  const candidate = { text: pending.buffer, parts: pending.parts };
  const view = createCandidateScanView(candidate);
  const terminalScan = scanPlainTextToolCall(view.text, skipLineIndentation(view.text, 0), {
    matcher,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    structuralLineBreaks: view.structuralLineBreaks,
  });
  const hasNamedCandidate = scanHasNamedCandidate(terminalScan);
  const sequences = findCandidateCallSequences(candidate, matcher);
  const overCapRanges = sequences.filter(({ overCap }) => overCap);
  const leading = sequences[0]?.start === 0 ? sequences[0] : undefined;
  if (leading?.activeStart !== undefined && (pending.sequenceOverCap || overCapRanges.length > 0)) {
    const activeCandidate = {
      text: candidate.text.slice(leading.activeStart),
      parts: candidate.parts
        .filter((part) => part.end > (leading.activeStart ?? 0))
        .map((part) => ({
          contentIndex: part.contentIndex,
          start: Math.max(0, part.start - (leading.activeStart ?? 0)),
          end: part.end - (leading.activeStart ?? 0),
        })),
    };
    const suppressor = createOverCapSuppressor(activeCandidate, matcher, true);
    if (suppressor) {
      return { kind: "suppress", suppressor };
    }
    if (leading.activeStart > 0) {
      return { kind: "trim", candidate: activeCandidate };
    }
  }
  if (overCapRanges.length > 0) {
    const text = createRangeRemover(overCapRanges)(candidate.text);
    const suppressor = text ? undefined : createOverCapSuppressor(candidate, matcher);
    return suppressor ? { kind: "suppress", suppressor } : { kind: "stripped", text };
  }
  if (
    leading &&
    leading.activeStart === undefined &&
    skipWhitespace(candidate.text, leading.end) < candidate.text.length
  ) {
    return { kind: "stripped", text: createRangeRemover([leading])(candidate.text) };
  }
  if (leading && leading.activeStart === undefined) {
    return pending.sequenceOverCap || pending.bufferBytes > MAX_PAYLOAD_BYTES
      ? { kind: "stripped", text: "" }
      : { kind: "complete" };
  }
  if (leading?.activeStart !== undefined) {
    return !hasNamedCandidate && finalize ? { kind: "false-positive" } : { kind: "incomplete" };
  }
  if (
    terminalScan.kind === "prefix" &&
    !hasNamedCandidate &&
    pending.bufferBytes > MAX_PAYLOAD_BYTES
  ) {
    return { kind: "false-positive" };
  }
  if (terminalScan.kind === "prefix" && (!finalize || hasNamedCandidate)) {
    return { kind: "incomplete" };
  }
  return pending.sequenceOverCap
    ? { kind: "stripped", text: candidate.text }
    : { kind: "false-positive" };
}

function consumeXmlSuppressor(
  suppressor: XmlSuppressor,
  chunk: string,
): { complete: false } | { complete: true; suffix: string } {
  const text = suppressor.carry + chunk;
  suppressor.carry = "";
  let cursor = 0;
  while (true) {
    if (suppressor.phase === "parameter") {
      const close = indexOfAsciiMarkerIgnoreCase(text, XML_PARAMETER_CLOSE, cursor);
      if (close === -1) {
        suppressor.carry = text.slice(-(XML_PARAMETER_CLOSE.length - 1));
        return { complete: false };
      }
      cursor = close + XML_PARAMETER_CLOSE.length;
      suppressor.phase = "body";
    }
    const markerStart = skipWhitespace(text, cursor);
    if (markerStart === text.length) {
      return { complete: false };
    }
    if (startsWithAsciiMarkerIgnoreCase(text, markerStart, XML_FUNCTION_CLOSE)) {
      const end = consumeRemovedLineEnd(text, markerStart + XML_FUNCTION_CLOSE.length);
      return { complete: true, suffix: text.slice(end) };
    }
    const markerPrefix =
      isAsciiMarkerPrefixIgnoreCase(text, markerStart, XML_FUNCTION_CLOSE) ||
      isAsciiMarkerPrefixIgnoreCase(text, markerStart, XML_PARAMETER_OPEN);
    if (markerPrefix) {
      suppressor.carry = text.slice(markerStart);
      return { complete: false };
    }
    if (startsWithAsciiMarkerIgnoreCase(text, markerStart, XML_PARAMETER_OPEN)) {
      const restLength = text.length - markerStart;
      const close = text.indexOf(">", markerStart + XML_PARAMETER_OPEN.length);
      if (close === -1 && restLength <= XML_PARAMETER_OPEN.length + 120) {
        suppressor.carry = text.slice(markerStart);
        return { complete: false };
      }
      if (close === -1) {
        return { complete: true, suffix: text.slice(markerStart) };
      }
      const name = text.slice(markerStart + XML_PARAMETER_OPEN.length, close);
      if (
        !name ||
        name.length > MAX_TOOL_NAME_CHARS ||
        Array.from(name).some((character) => !isXmlishNameChar(character))
      ) {
        return { complete: true, suffix: text.slice(markerStart) };
      }
      suppressor.phase = "parameter";
      cursor = close + 1;
      continue;
    }
    return { complete: true, suffix: text.slice(markerStart) };
  }
}

function consumeJsonSuppressor(
  suppressor: JsonSuppressor,
  chunk: string,
): { complete: false } | { complete: true; suffix: string } {
  let text = suppressor.carry + chunk;
  suppressor.carry = "";
  let cursor = 0;
  if (suppressor.phase === "opening") {
    cursor = skipWhitespace(text, cursor);
    if (cursor === text.length) {
      return { complete: false };
    }
    if (text[cursor] !== "{") {
      return { complete: true, suffix: text.slice(cursor) };
    }
    suppressor.depth = 1;
    suppressor.phase = "payload";
    cursor += 1;
  }
  if (suppressor.phase === "payload") {
    for (; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (suppressor.inString) {
        if (suppressor.escaped) {
          suppressor.escaped = false;
        } else if (char === "\\") {
          suppressor.escaped = true;
        } else if (char === '"') {
          suppressor.inString = false;
        }
        continue;
      }
      if (char === '"') {
        suppressor.inString = true;
      } else if (char === "{") {
        suppressor.depth += 1;
      } else if (char === "}") {
        suppressor.depth -= 1;
        if (suppressor.depth === 0) {
          suppressor.phase = "closing";
          cursor += 1;
          break;
        }
      }
    }
    if (suppressor.phase === "payload") {
      return { complete: false };
    }
    text = text.slice(cursor);
  }

  const markerStart = skipWhitespace(text, 0);
  const rest = text.slice(markerStart);
  if (suppressor.requiredClosing) {
    const markers = [suppressor.requiredClosing, END_TOOL_REQUEST];
    const closing = markers.find((marker) => rest.startsWith(marker));
    if (closing) {
      const end = consumeRemovedLineEnd(rest, closing.length);
      return { complete: true, suffix: rest.slice(end) };
    }
    if (markers.some((marker) => marker.startsWith(rest))) {
      suppressor.carry = rest;
      return { complete: false };
    }
    return { complete: true, suffix: rest };
  }
  const optionalClosing = suppressor.optionalClosings?.find((marker) => rest.startsWith(marker));
  if (optionalClosing) {
    const end = consumeRemovedLineEnd(rest, optionalClosing.length);
    return { complete: true, suffix: rest.slice(end) };
  }
  const optionalClosings = suppressor.optionalClosings ?? [];
  if (optionalClosings.some((marker) => marker.startsWith(rest))) {
    const maxCarryChars = Math.max(...optionalClosings.map((marker) => marker.length));
    // Keep bounded leading whitespace with a split optional closer. If the next
    // chunk disproves the closer, it remains part of the visible suffix.
    suppressor.carry = text.slice(-maxCarryChars);
    return { complete: false };
  }
  const end = consumeRemovedLineEnd(text, 0);
  return { complete: true, suffix: text.slice(end) };
}

function consumeOpeningSuppressor(
  suppressor: OpeningSuppressor,
  chunk: string,
): { complete: false } | { complete: true; suffix: string } {
  if (suppressor.choice) {
    return suppressor.choice.kind === "xml"
      ? consumeXmlSuppressor(suppressor.choice, chunk)
      : consumeJsonSuppressor(suppressor.choice, chunk);
  }
  const text = suppressor.carry + chunk;
  suppressor.carry = "";
  const start = skipWhitespace(text, 0);
  if (start === text.length) {
    return { complete: false };
  }
  const rest = text.slice(start);
  if (rest[0] === "{") {
    suppressor.choice = suppressor.json;
    return consumeJsonSuppressor(suppressor.choice, rest);
  }
  if (suppressor.allowXml) {
    if (isAsciiMarkerPrefixIgnoreCase(rest, 0, XML_PARAMETER_OPEN)) {
      suppressor.carry = rest;
      return { complete: false };
    }
    if (startsWithAsciiMarkerIgnoreCase(rest, 0, XML_PARAMETER_OPEN)) {
      suppressor.choice = { carry: "", kind: "xml", phase: "body" };
      return consumeXmlSuppressor(suppressor.choice, rest);
    }
  }
  return { complete: true, suffix: rest };
}

function consumeOverCapSuppressor(
  suppressor: OverCapSuppressor,
  chunk: string,
): { complete: false } | { complete: true; suffix: string } {
  return suppressor.kind === "xml"
    ? consumeXmlSuppressor(suppressor, chunk)
    : suppressor.kind === "json"
      ? consumeJsonSuppressor(suppressor, chunk)
      : consumeOpeningSuppressor(suppressor, chunk);
}

function orderByContentIndex(
  events: readonly unknown[],
  message: Record<string, unknown>,
): unknown[] {
  const contentLength = Array.isArray(message.content) ? message.content.length : 0;
  const order = (event: unknown) => {
    const index = asRecord(event)?.contentIndex;
    return typeof index === "number" &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < contentLength
      ? index
      : contentLength;
  };
  return events.toSorted((left, right) => order(left) - order(right));
}

/** Coordinates bounded candidate buffering; terminal snapshots remain the source of truth. */
export async function* normalizePlainTextToolCallStreamEvents(
  source: AsyncIterable<unknown>,
  options: PlainTextToolCallStreamNormalizerOptions,
): AsyncGenerator {
  let pending: PendingState | undefined;
  let overCapSequenceOpen = false;
  let scrubFuturePartials = false;
  let forceScrubTerminal = false;
  let sawStreamStart = false;
  let preserveTerminalContentIndexes = false;
  const heldTextStarts = new Map<string, Record<string, unknown>>();
  const lineStarts = new Map<string, boolean>();
  const emittedTextUnits = new Map<string, number>();

  const scrubSnapshot = (
    value: unknown,
    preserveEmptyTextBlocks = false,
    forceKnownCandidates = false,
  ) => {
    const forced = forceKnownCandidates
      ? projectScrubbedPlainTextToolCallMessage({
          forceKnownCandidates: true,
          matcher: options.matcher,
          message: value,
          preserveEmptyTextBlocks,
        })
      : undefined;
    if (forced) {
      return forced;
    }
    const normalized = options.normalizeTerminalMessage({
      allowPromotion: false,
      message: value,
      preserveEmptyTextBlocks,
      reason: "error",
    });
    return normalized?.kind === "scrubbed" ? normalized : undefined;
  };
  const eventKey = (record: Record<string, unknown>) => String(eventContentIndex(record));
  const sanitizeEventPartial = (
    record: Record<string, unknown>,
    forceKnownCandidates = false,
  ): Record<string, unknown> | undefined => {
    if (record.partial === undefined) {
      return record;
    }
    const projection = scrubSnapshot(record.partial, true, forceKnownCandidates);
    if (!projection) {
      return record;
    }
    const projected = projectEventIndex(record, projection);
    return projected ? { ...projected, partial: projection.message } : undefined;
  };
  const forceProjectPendingAux = (
    candidate: CandidatePendingState | SuppressingPendingState,
    projection?: PlainTextToolCallMessageProjection,
    retainedTextContentIndex?: number,
  ) =>
    projectPendingAuxEvents(
      candidate,
      projection,
      (message) => scrubSnapshot(message, true, true),
      retainedTextContentIndex,
    );

  async function* normalizeEvents() {
    for await (const sourceEvent of source) {
      let record = asRecord(sourceEvent);
      if (!record) {
        yield sourceEvent;
        continue;
      }
      const type = typeof record.type === "string" ? record.type : "";
      sawStreamStart ||= type === "start";
      if (
        scrubFuturePartials &&
        !pending &&
        type !== "done" &&
        type !== "error" &&
        record.partial !== undefined
      ) {
        const projection = scrubSnapshot(record.partial, true, true);
        const projectedEvent = projection ? projectEventIndex(record, projection) : record;
        if (!projectedEvent) {
          continue;
        }
        record = projection
          ? { ...projectedEvent, partial: projection.message }
          : (sanitizeEventPartial(projectedEvent, true) ?? projectedEvent);
      }

      if (type === "text_start" || type === "text_delta" || type === "text_end") {
        const text =
          typeof record.delta === "string"
            ? record.delta
            : typeof record.content === "string"
              ? record.content
              : undefined;
        const key = eventKey(record);
        if (type === "text_start" && (text === undefined || text === "") && !pending) {
          const previous = heldTextStarts.get(key);
          if (previous) {
            yield previous;
          }
          heldTextStarts.set(key, record);
          continue;
        }

        if (text === undefined) {
          if (pending?.kind === "candidate") {
            queuePendingEvent(pending, record);
          } else if (!pending) {
            const held = heldTextStarts.get(key);
            if (held) {
              yield held;
              heldTextStarts.delete(key);
            }
            yield record;
          }
          continue;
        }

        let incoming = text;
        let incomingRecord = record;
        const closesText = type === "text_end";
        let authoritative = closesText;
        let sequenceOverCap = false;
        while (true) {
          if (pending?.kind === "suppressing") {
            if (closesText) {
              const projection = scrubSnapshot(
                record.partial ?? { role: "assistant", content: incoming },
                true,
                true,
              );
              yield* forceProjectPendingAux(pending, projection);
              const projectedText = projection && projectedTextForEvent(record, projection);
              const novelText = projectedText?.slice(emittedTextUnits.get(key) ?? 0);
              if (novelText && projection) {
                yield createSyntheticTextDelta(record, novelText, projection.message);
              }
              pending = undefined;
              scrubFuturePartials = true;
              break;
            }
            if (!pending.suppressor) {
              const projection = scrubSnapshot(record.partial, true, true);
              yield* forceProjectPendingAux(pending, projection);
              pending = undefined;
              continue;
            }
            const consumed = consumeOverCapSuppressor(pending.suppressor, incoming);
            if (!consumed.complete) {
              break;
            }
            scrubFuturePartials = true;
            overCapSequenceOpen = true;
            const partialProjection = scrubSnapshot(record.partial, true, true);
            const partial = partialProjection?.message;
            yield* forceProjectPendingAux(pending, partialProjection);
            incoming = consumed.suffix;
            sequenceOverCap = true;
            if (!incoming) {
              pending = { entryBytes: 0, kind: "suppressing" };
              break;
            }
            pending = undefined;
            incomingRecord = {
              ...eventTemplate(record),
              type: "text_delta",
              delta: incoming,
              ...(partial ? { partial } : {}),
            };
            authoritative = false;
          }

          if (!pending) {
            const atLineStart =
              authoritative ||
              sequenceOverCap ||
              overCapSequenceOpen ||
              (lineStarts.get(key) ?? true);
            const callStart = findPotentialCallStart(incoming, atLineStart, options.matcher);
            if (callStart === null) {
              const held = heldTextStarts.get(key);
              if (held) {
                yield held;
                heldTextStarts.delete(key);
              }
              yield incomingRecord;
              if (incoming) {
                const continuesScrubbedSequence = overCapSequenceOpen;
                overCapSequenceOpen = false;
                const contentIndex = eventContentIndex(incomingRecord);
                preserveTerminalContentIndexes ||=
                  (sequenceOverCap || continuesScrubbedSequence) && contentIndex > 0;
              }
              lineStarts.set(key, nextAtLineStart(atLineStart, incoming));
              break;
            }
            const visiblePrefix = incoming.slice(0, callStart);
            const emittedUnits = emittedTextUnits.get(key) ?? 0;
            const emittedPrefixUnits = authoritative ? emittedUnits : 0;
            const novelVisiblePrefix = visiblePrefix.slice(emittedPrefixUnits);
            if (novelVisiblePrefix) {
              const held = heldTextStarts.get(key);
              if (held) {
                yield held;
                heldTextStarts.delete(key);
              }
              const visibleProjection = scrubSnapshot(incomingRecord.partial, true, true);
              const visibleTemplate = visibleProjection
                ? projectEventIndex(incomingRecord, visibleProjection)
                : incomingRecord;
              if (visibleTemplate) {
                yield createSyntheticTextDelta(
                  visibleTemplate,
                  novelVisiblePrefix,
                  asRecord(visibleProjection?.message),
                );
              }
            }
            const candidateText = incoming.slice(callStart);
            const candidateRecord =
              typeof incomingRecord.delta === "string"
                ? { ...incomingRecord, delta: candidateText }
                : authoritative
                  ? incomingRecord
                  : { ...incomingRecord, content: candidateText };
            const held = heldTextStarts.get(key);
            heldTextStarts.delete(key);
            pending = createPendingState(
              candidateRecord,
              candidateText,
              held,
              sequenceOverCap || overCapSequenceOpen,
              authoritative ? callStart : emittedUnits + callStart,
            );
            overCapSequenceOpen = false;
          } else if (pending.kind === "candidate") {
            if (authoritative) {
              const contentIndex = eventContentIndex(incomingRecord);
              const partIndex = pending.parts.findLastIndex(
                (part) => part.contentIndex === contentIndex,
              );
              const part = pending.parts[partIndex];
              if (part) {
                const blockOffset = part.start === 0 ? pending.snapshotOffset : 0;
                const blockText = incoming.slice(blockOffset);
                const previousLength = part.end - part.start;
                const lengthDelta = blockText.length - previousLength;
                const candidateText =
                  pending.buffer.slice(0, part.start) + blockText + pending.buffer.slice(part.end);
                const retained = pending.entries?.filter(
                  (event) => !isTextStreamEvent(event) || event.type === "text_start",
                );
                pending.buffer = candidateText;
                pending.bufferBytes = cappedUtf8ByteLength(candidateText);
                pending.entries = [
                  ...(retained ?? []),
                  createSyntheticTextDelta(
                    pending.template,
                    candidateText,
                    asRecord(record.partial),
                  ),
                  { ...incomingRecord, content: incoming },
                ];
                pending.parts = pending.parts.map((entry, index) =>
                  index < partIndex
                    ? entry
                    : index === partIndex
                      ? { ...entry, end: entry.start + blockText.length }
                      : {
                          ...entry,
                          start: entry.start + lengthDelta,
                          end: entry.end + lengthDelta,
                        },
                );
                if (part.start === 0) {
                  pending.snapshotOffset = 0;
                }
                pending.template = eventTemplate(incomingRecord);
              } else {
                // A text_end snapshot is authoritative for its own content block. Carry a
                // newly observed block into classification or visible text can vanish at EOF.
                appendPendingText(pending, incoming, incomingRecord);
              }
            } else {
              appendPendingText(pending, incoming, incomingRecord);
            }
            if (!incoming && !authoritative) {
              break;
            }
          }

          if (pending.kind !== "candidate") {
            break;
          }
          const shouldClassify =
            authoritative ||
            pending.bufferBytes > MAX_PAYLOAD_BYTES ||
            pending.buffer.length <= 256 ||
            pending.buffer.length >= pending.nextScanChars;
          if (!shouldClassify) {
            break;
          }
          const classification = classifyPending(pending, options.matcher);
          pending.nextScanChars = Math.max(pending.buffer.length + 1, pending.nextScanChars * 2);
          if (classification.kind === "complete" || classification.kind === "incomplete") {
            break;
          }
          if (classification.kind === "trim") {
            scrubFuturePartials = true;
            const partialProjection = scrubSnapshot(record.partial, true, true);
            yield* forceProjectPendingAux(pending, partialProjection);
            const candidate = classification.candidate;
            pending.buffer = candidate.text;
            pending.bufferBytes = cappedUtf8ByteLength(candidate.text);
            pending.entries = undefined;
            pending.entryBytes = 0;
            pending.nextScanChars = 256;
            pending.parts = candidate.parts;
            pending.sequenceOverCap = true;
            pending.snapshotOffset = 0;
            pending.template = {
              ...pending.template,
              contentIndex: candidate.parts[0]?.contentIndex ?? pending.template.contentIndex,
            };
            break;
          }
          if (classification.kind === "suppress") {
            const entries = pending.entries?.filter((event) => !isTextStreamEvent(event));
            scrubFuturePartials = true;
            pending = {
              entries,
              entryBytes:
                entries?.reduce((total, entry) => {
                  return Math.min(MAX_PAYLOAD_BYTES + 1, total + pendingEventBytes(entry));
                }, 0) ?? 0,
              kind: "suppressing",
              suppressor: classification.suppressor,
            };
            break;
          }
          if (classification.kind === "false-positive") {
            yield* replayFalsePositiveCandidate(pending);
            const replayText = pending.buffer;
            pending = undefined;
            if (replayText) {
              overCapSequenceOpen = false;
              lineStarts.set(key, nextAtLineStart(lineStarts.get(key) ?? true, replayText));
            }
            break;
          }

          scrubFuturePartials = true;
          const partialProjection = scrubSnapshot(record.partial, true, true);
          const authoritativeProjection =
            partialProjection ??
            (authoritative
              ? scrubSnapshot({ role: "assistant", content: pending.buffer }, true, true)
              : undefined);
          const projectedText =
            authoritativeProjection &&
            projectedTextForEvent(pending.template, authoritativeProjection);
          const sanitizedText = projectedText ?? classification.text;
          overCapSequenceOpen = sanitizedText.length === 0;
          const outputProjection = partialProjection;
          const contentIndex = eventContentIndex(pending.template);
          const partial =
            outputProjection?.message ??
            (contentIndex === 0
              ? { role: "assistant", content: [{ type: "text", text: sanitizedText }] }
              : undefined);
          yield* forceProjectPendingAux(
            pending,
            outputProjection,
            sanitizedText ? contentIndex : undefined,
          );
          // Provider text deltas append to the cumulative text_end snapshot. Count UTF-16
          // units so slicing uses the same offsets without retaining streamed text.
          const emittedUnits = emittedTextUnits.get(key) ?? 0;
          const novelOffset = projectedText
            ? emittedUnits
            : authoritative
              ? Math.max(0, emittedUnits - pending.snapshotOffset)
              : 0;
          const novelText = sanitizedText.slice(novelOffset);
          preserveTerminalContentIndexes ||= sanitizedText.length > 0 && contentIndex > 0;
          if (novelText) {
            yield createSyntheticTextDelta(pending.template, novelText, partial);
          }
          lineStarts.set(key, nextAtLineStart(lineStarts.get(key) ?? true, sanitizedText));
          pending = undefined;
          break;
        }
        if (closesText) {
          emittedTextUnits.delete(key);
        }
        continue;
      }

      if (type === "done") {
        // Keep a later visible suffix at the content index used by its streamed delta.
        const requestedNormalization = options.normalizeTerminalMessage({
          allowPromotion: record.reason === "stop" || record.reason === "toolUse",
          message: record.message,
          preserveEmptyTextBlocks: preserveTerminalContentIndexes,
          reason: record.reason,
        });
        const forcedProjection = forceScrubTerminal
          ? scrubSnapshot(record.message, preserveTerminalContentIndexes, true)
          : undefined;
        const terminalCandidate = requestedNormalization
          ? undefined
          : extractStandaloneCandidate(record.message, false);
        const terminalHasIncompleteCandidate =
          terminalCandidate &&
          findCandidateCallSequences(terminalCandidate, options.matcher).some(
            (sequence) => sequence.activeStart !== undefined,
          );
        const terminalCandidateProjection = terminalHasIncompleteCandidate
          ? scrubSnapshot(record.message, preserveTerminalContentIndexes, true)
          : undefined;
        const normalized = forcedProjection
          ? ({ kind: "scrubbed", ...forcedProjection } as const)
          : forceScrubTerminal
            ? undefined
            : (requestedNormalization ??
              (terminalCandidateProjection
                ? ({ kind: "scrubbed", ...terminalCandidateProjection } as const)
                : undefined));
        if (normalized?.kind === "promoted") {
          if (!sawStreamStart) {
            yield { type: "start", partial: { role: "assistant", content: [] } };
            sawStreamStart = true;
          }
          const promoted = [...options.createPromotedToolCallEvents(normalized.message)];
          const auxiliary =
            pending?.kind === "candidate" ? forceProjectPendingAux(pending, normalized) : [];
          yield* orderByContentIndex([...promoted, ...auxiliary], normalized.message);
          yield { ...record, reason: "toolUse", message: normalized.message };
        } else if (normalized?.kind === "scrubbed") {
          if (pending?.kind === "candidate") {
            const classification = classifyPending(pending, options.matcher, true);
            if (classification.kind === "stripped" && classification.text) {
              const template = projectEventIndex(pending.template, normalized);
              if (template) {
                const projectedText = projectedTextForEvent(pending.template, normalized);
                const sanitizedText = projectedText ?? classification.text;
                const emittedUnits = emittedTextUnits.get(eventKey(pending.template)) ?? 0;
                const novelText = sanitizedText.slice(projectedText ? emittedUnits : 0);
                if (novelText) {
                  yield createSyntheticTextDelta(template, novelText, normalized.message);
                }
              }
            }
            yield* forceProjectPendingAux(pending, normalized);
          } else if (pending?.kind === "suppressing") {
            yield* forceProjectPendingAux(pending, normalized);
          }
          yield { ...record, message: normalized.message };
        } else {
          let message = record.message;
          if (pending?.kind === "candidate") {
            const classification = classifyPending(pending, options.matcher, true);
            if (classification.kind === "false-positive") {
              yield* replayFalsePositiveCandidate(pending);
            } else {
              const projection = scrubSnapshot(record.message, true, true);
              yield* forceProjectPendingAux(pending, projection);
              message = projection?.message ?? message;
            }
          } else if (pending?.kind === "suppressing") {
            const projection = scrubSnapshot(record.message, true, true);
            yield* forceProjectPendingAux(pending, projection);
            message = projection?.message ?? message;
          }
          yield message === record.message ? record : { ...record, message };
        }
        pending = undefined;
        forceScrubTerminal = false;
        heldTextStarts.clear();
        emittedTextUnits.clear();
        if (options.stopAfterDone) {
          return;
        }
        continue;
      }

      if (type === "error") {
        const knownCandidate =
          pending?.kind === "suppressing" ||
          (pending?.kind === "candidate" &&
            classifyPending(pending, options.matcher, true).kind !== "false-positive");
        if (pending?.kind === "candidate" && !knownCandidate) {
          yield* replayFalsePositiveCandidate(pending);
        }
        const streamedPartial = scrubSnapshot(record.partial, true, knownCandidate);
        const streamedError = scrubSnapshot(
          record.error,
          preserveTerminalContentIndexes,
          knownCandidate,
        );
        const projection = streamedPartial ?? streamedError;
        if (pending?.kind === "candidate" && knownCandidate) {
          yield* forceProjectPendingAux(pending, projection);
        } else if (pending?.kind === "suppressing") {
          yield* forceProjectPendingAux(pending, projection);
        }
        yield {
          ...record,
          ...(streamedPartial ? { partial: streamedPartial.message } : {}),
          ...(streamedError ? { error: streamedError.message } : {}),
        };
        return;
      }

      if (pending?.kind === "suppressing") {
        if (!pending.entries) {
          const sanitized = sanitizeEventPartial(record, true);
          if (sanitized) {
            yield sanitized;
          }
          continue;
        }
        queuePendingEvent(pending, record);
        if (pendingQueueOverCap(pending)) {
          forceScrubTerminal = true;
          if (!sawStreamStart) {
            yield { type: "start", partial: { role: "assistant", content: [] } };
            sawStreamStart = true;
          }
          yield* forceProjectPendingAux(pending);
          pending.entries = undefined;
          pending.entryBytes = 0;
        }
      } else if (pending?.kind === "candidate") {
        if (!pending.entries) {
          const sanitized = sanitizeEventPartial(record, true);
          if (sanitized) {
            yield sanitized;
          }
          continue;
        }
        queuePendingEvent(pending, record);
        if (pendingQueueOverCap(pending)) {
          const classification = classifyPending(pending, options.matcher);
          if (classification.kind === "false-positive") {
            yield* replayFalsePositiveCandidate(pending);
            pending = undefined;
            continue;
          }
          forceScrubTerminal = true;
          scrubFuturePartials = true;
          if (!sawStreamStart) {
            yield { type: "start", partial: { role: "assistant", content: [] } };
            sawStreamStart = true;
          }
          yield* forceProjectPendingAux(pending);
          pending.entries = undefined;
          pending.entryBytes = 0;
          if (classification.kind === "suppress") {
            pending = {
              entryBytes: 0,
              kind: "suppressing",
              suppressor: classification.suppressor,
            };
          }
        }
      } else {
        for (const held of heldTextStarts.values()) {
          yield held;
        }
        heldTextStarts.clear();
        yield record;
      }
    }

    if (pending?.kind === "candidate") {
      const classification = classifyPending(pending, options.matcher, true);
      if (classification.kind === "false-positive") {
        yield* replayFalsePositiveCandidate(pending);
      } else {
        yield* forceProjectPendingAux(pending);
      }
    } else if (pending?.kind === "suppressing") {
      yield* forceProjectPendingAux(pending);
    }
    for (const held of heldTextStarts.values()) {
      yield held;
    }
  }
  for await (const event of normalizeEvents()) {
    const record = asRecord(event);
    if (record?.type === "text_delta" && typeof record.delta === "string") {
      const key = eventKey(record);
      const previous = emittedTextUnits.get(key) ?? 0;
      emittedTextUnits.set(key, previous + record.delta.length);
    }
    yield event;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
