import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isOffsetInProtectedRanges,
  type PlainTextToolCallNameMatcher,
  type PlainTextToolCallProtectedRange,
  type PlainTextToolCallProtectedRangeResolver,
} from "./contracts.js";
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
import { scanPlainTextToolCall, type PlainTextToolCallScan } from "./payload.js";
import type { PlainTextToolCallMessageProjection } from "./promote.js";
import {
  advanceProtectionScanState,
  cloneProtectionScanState,
  createProtectionScanState,
  resolveProtectionFastPath,
} from "./protection-fast-path.js";

export type { PlainTextToolCallNameMatcher } from "./contracts.js";

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
  /** Resolves source ranges that must remain literal user-visible text. */
  resolveProtectedRanges?: PlainTextToolCallProtectedRangeResolver;
  /**
   * Opts a fence-based `resolveProtectedRanges` into the incremental fast path so a
   * candidate-shaped delta can skip a full re-parse (see protection-fast-path.ts's safety
   * contract). Leave unset for any resolver whose protected ranges are not exactly CommonMark
   * fenced/indented/inline code spans — the fast path only tracks fence state, so trusting it
   * for a differently defined resolver would silently drop that resolver's protection.
   */
  protectedRangesFenceCompatible?: boolean;
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
// Retain bounded visible history only for split Markdown ownership; terminal snapshots stay canonical.
const MAX_PROTECTION_CONTEXT_CHARS = 1_000_000;
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
  const record = asOptionalObjectRecord(message);
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
    const value = asOptionalObjectRecord(block);
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
  protectedRanges: readonly PlainTextToolCallProtectedRange[] = [],
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
    if (isOffsetInProtectedRanges(callStart, protectedRanges)) {
      index += 1;
      continue;
    }
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
      if (isOffsetInProtectedRanges(nextStart, protectedRanges)) {
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
  resolveProtectedRanges?: PlainTextToolCallProtectedRangeResolver,
): ScannedCallSequence[] {
  const view = createCandidateScanView(candidate);
  return findCallSequences(
    view.text,
    matcher,
    view.boundaries,
    view.structuralLineBreaks,
    resolveProtectedRanges?.(view.text),
  );
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
    const blockRecord = asOptionalObjectRecord(block);
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
  resolveProtectedRanges?: PlainTextToolCallProtectedRangeResolver;
  requireAssistantRole?: boolean;
}): PlainTextToolCallMessageProjection | undefined {
  const record = asOptionalObjectRecord(params.message);
  const candidate = extractStandaloneCandidate(
    params.message,
    params.requireAssistantRole === true,
  );
  if (!record || !candidate) {
    return undefined;
  }
  const sequences = findCandidateCallSequences(
    candidate,
    params.matcher,
    params.resolveProtectedRanges,
  );
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
  isProtected?: (offset: number) => boolean,
): number | null {
  for (let index = 0; index < text.length;) {
    const lineStart =
      (index === 0 && atLineStart) || text[index - 1] === "\n" || text[index - 1] === "\r";
    if (!lineStart) {
      index += 1;
      continue;
    }
    const start = skipLineIndentation(text, index);
    if (isProtected?.(start)) {
      index += 1;
      continue;
    }
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

/** A confirmed preceding-context verdict, keyed by the partial's own reported length. */
type PrecedingContextVerdict = { precedingLength: number; trusted: boolean };

/**
 * Decides whether the carried fence-state scan can be trusted for a candidate in
 * `contentIndex`, reusing a cached verdict from an earlier delta in the same block when
 * it is still known to apply.
 *
 * The scan advances in event order; `partial`'s own per-block offsets are in
 * content-index order. These normally agree, but not when a provider interleaves active
 * blocks (an earlier block can stream after a later one), when an earlier block was
 * never streamed as its own delta at all, or when an earlier block is itself still
 * actively streaming and grows between two candidate checks in a later block -- so the
 * scan's state does not correspond to "everything that precedes this block" and must
 * not be trusted without checking the partial's own reported preceding text.
 *
 * `partial` is optional on every event, so a delta can arrive with none at all -- that
 * proves nothing either way and, with no cache to fall back on either, defaults to
 * trusting the scan (there is nothing to contradict it with; it remains the only source
 * of truth this normalizer itself built, in order).
 *
 * A cached verdict is reused only when a later delta's own reported preceding length
 * (`part.start`) exactly matches the length the cache was validated against -- a
 * still-evolving earlier block changes that length, invalidating the cache and forcing
 * a fresh comparison, rather than trusting a verdict that predates the earlier block's
 * own growth. A length match alone does not otherwise prove agreement -- interleaved
 * blocks of the same length streamed out of order can produce the same tracked length
 * from different actual text (e.g. opposite fence state) -- so a fresh, same-length,
 * nonzero-length comparison still needs a real text comparison. `trackedPrefix` is
 * called lazily: only an uncached (or invalidated) comparison pays for materializing it,
 * and its cost is bounded by the (typically small, fixed) preceding-block size, not by
 * however large the current block's own growing content is.
 */
function resolvePrecedingContextTrust(
  partial: unknown,
  contentIndex: number,
  trackedLength: number,
  trackedPrefix: () => string,
  cached: PrecedingContextVerdict | undefined,
): { cache: PrecedingContextVerdict | undefined; trusted: boolean } {
  const candidate = extractStandaloneCandidate(partial);
  const part = candidate?.parts.find((entry) => entry.contentIndex === contentIndex);
  if (!candidate || !part) {
    return { cache: cached, trusted: cached?.trusted ?? true };
  }
  if (cached && cached.precedingLength === part.start) {
    return { cache: cached, trusted: cached.trusted };
  }
  const trusted =
    part.start === trackedLength &&
    (part.start === 0 || candidate.text.slice(0, part.start) === trackedPrefix());
  return { cache: { precedingLength: part.start, trusted }, trusted };
}

function resolvePartialProtectionCheck(params: {
  authoritative: boolean;
  contentIndex: number;
  incoming: string;
  partial: unknown;
  resolveProtectedRanges: PlainTextToolCallProtectedRangeResolver;
}): ((offset: number) => boolean) | undefined {
  const candidate = extractStandaloneCandidate(params.partial);
  const record = asOptionalObjectRecord(params.partial);
  if (!candidate || !record) {
    return undefined;
  }
  let blockStart = 0;
  let blockText: string | undefined;
  if (typeof record.content === "string") {
    if (params.contentIndex !== 0) {
      return undefined;
    }
    blockText = record.content;
  } else {
    const part = candidate.parts.find((entry) => entry.contentIndex === params.contentIndex);
    const block = Array.isArray(record.content)
      ? asOptionalObjectRecord(record.content[params.contentIndex])
      : undefined;
    if (!part || block?.type !== "text" || typeof block.text !== "string") {
      return undefined;
    }
    blockStart = part.start;
    blockText = block.text;
  }
  const incomingStart = params.authoritative ? 0 : blockText.length - params.incoming.length;
  if (
    incomingStart < 0 ||
    (params.authoritative ? blockText !== params.incoming : !blockText.endsWith(params.incoming))
  ) {
    return undefined;
  }
  const protectedRanges = params.resolveProtectedRanges(candidate.text);
  return (offset) =>
    isOffsetInProtectedRanges(blockStart + incomingStart + offset, protectedRanges);
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
  const content = asOptionalObjectRecord(projection.message)?.content;
  if (typeof content === "string") {
    return content;
  }
  const projectedIndex = projection.sourceToProjectedContentIndex.get(eventContentIndex(event));
  const block =
    Array.isArray(content) && projectedIndex !== undefined
      ? asOptionalObjectRecord(content[projectedIndex])
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
  resolveProtectedRanges?: PlainTextToolCallProtectedRangeResolver,
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
  const sequences = findCandidateCallSequences(candidate, matcher, resolveProtectedRanges);
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
    const index = asOptionalObjectRecord(event)?.contentIndex;
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
  const protectionChunks: string[] = [];
  let protectionContextLength = 0;
  let protectionContextOverflow = false;
  let protectionBlockContentIndex: number | undefined;
  let protectionBlockStart = 0;
  // This block's cached preceding-context trust verdict (see resolvePrecedingContextTrust),
  // keyed by the preceding length it was validated against. Reset per block so it starts
  // fresh for each one, and invalidated within a block if a later delta's partial reports
  // a different preceding length than the cache was validated against (an earlier block
  // that is itself still actively streaming can grow between two candidate checks here).
  let protectionBlockPrefixVerdict: PrecedingContextVerdict | undefined;
  // Carried Markdown block state mirrors the protection context so a candidate delta can
  // skip re-parsing the whole response. `protectionScanAtBlockStart` matches the prefix an
  // authoritative delta uses (context sliced at protectionBlockStart); the live state
  // matches the full context. Both stay in sync because every context mutation routes
  // through advanceProtectionContext/beginProtectionBlock.
  let protectionScan = createProtectionScanState();
  let protectionScanAtBlockStart = createProtectionScanState();

  const beginProtectionBlock = (contentIndex: number) => {
    if (protectionBlockContentIndex === contentIndex) {
      return;
    }
    protectionBlockContentIndex = contentIndex;
    protectionBlockStart = protectionContextLength;
    protectionScanAtBlockStart = cloneProtectionScanState(protectionScan);
    protectionBlockPrefixVerdict = undefined;
  };
  const truncateProtectionContext = (length: number) => {
    while (protectionContextLength > length) {
      const tail = protectionChunks.at(-1);
      if (tail === undefined) {
        protectionContextLength = 0;
        return;
      }
      const retainedLength = tail.length - (protectionContextLength - length);
      if (retainedLength > 0) {
        protectionChunks[protectionChunks.length - 1] = tail.slice(0, retainedLength);
        protectionContextLength = length;
        return;
      }
      protectionChunks.pop();
      protectionContextLength -= tail.length;
    }
  };
  const advanceProtectionContext = (text: string, resetActiveBlock = false) => {
    if (!options.resolveProtectedRanges || protectionContextOverflow) {
      return;
    }
    if (resetActiveBlock) {
      truncateProtectionContext(protectionBlockStart);
      protectionScan = cloneProtectionScanState(protectionScanAtBlockStart);
    }
    if (protectionContextLength + text.length > MAX_PROTECTION_CONTEXT_CHARS) {
      protectionChunks.length = 0;
      protectionContextLength = 0;
      protectionContextOverflow = true;
      return;
    }
    if (text) {
      protectionChunks.push(text);
      advanceProtectionScanState(protectionScan, text);
    }
    protectionContextLength += text.length;
  };
  const materializeProtectionPrefix = (authoritative: boolean): string => {
    if (protectionContextOverflow) {
      return "";
    }
    const context = protectionChunks.join("");
    return authoritative ? context.slice(0, protectionBlockStart) : context;
  };
  // Reconstructs only the first `length` tracked characters, stopping as soon as enough
  // chunks are collected instead of joining every chunk ever pushed. protectionChunks
  // keeps growing with the CURRENT block's own advances, so joining it in full to read a
  // fixed-size preceding-block prefix would itself be the quadratic cost this exists to
  // avoid; this stays bounded by `length` (the preceding block's own size), not by
  // however large the current, still-growing block gets.
  const materializeBoundedPrefix = (length: number): string => {
    let result = "";
    for (const chunk of protectionChunks) {
      if (result.length >= length) {
        break;
      }
      result += chunk;
    }
    return result.slice(0, length);
  };

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
          resolveProtectedRanges: options.resolveProtectedRanges,
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
      let record = asOptionalObjectRecord(sourceEvent);
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
        beginProtectionBlock(eventContentIndex(record));
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
            let callStart = findPotentialCallStart(incoming, atLineStart, options.matcher);
            if (callStart !== null && options.resolveProtectedRanges) {
              if (protectionContextOverflow) {
                // Bounded live history no longer proves ownership. Preserve bytes and let the
                // authoritative terminal snapshot decide instead of deleting literal content.
                callStart = null;
              } else {
                // Candidate-shaped text is rare in prose but constant in bracket-dense
                // answers, so materializing and re-parsing the whole response here is
                // quadratic. Ask the carried fence state first; it answers only what it
                // can prove and yields to a full parse for everything else. Only a caller
                // that opted in has promised its resolver's protection is exactly fence
                // state, so an un-opted-in resolver always takes the full-parse path below
                // and stays authoritative — the fast path must never silently stand in for it.
                const carriedScan = authoritative ? protectionScanAtBlockStart : protectionScan;
                // protectionBlockStart is how much text the scan had tracked (in event order)
                // when this block began. If the partial's own content-order offset for this
                // block disagrees, either an earlier block was never streamed as its own delta,
                // blocks interleaved out of content-index order, or an earlier block is itself
                // still growing -- either way the scan's state does not correspond to this
                // block's actual preceding text and cannot be trusted here, whatever it claims
                // for this block's own content. resolvePrecedingContextTrust caches its
                // verdict per block (reset in beginProtectionBlock) but invalidates it the
                // moment a later delta's own reported preceding length changes, so an earlier
                // block growing mid-stream still gets a fresh comparison rather than reusing a
                // verdict that predates that growth.
                const precedingContextTrust = resolvePrecedingContextTrust(
                  incomingRecord.partial,
                  eventContentIndex(incomingRecord),
                  protectionBlockStart,
                  () => materializeBoundedPrefix(protectionBlockStart),
                  protectionBlockPrefixVerdict,
                );
                protectionBlockPrefixVerdict = precedingContextTrust.cache;
                const untrackedPrecedingContext = !precedingContextTrust.trusted;
                let isProtectedAt: ((offset: number) => boolean) | undefined =
                  !untrackedPrecedingContext && options.protectedRangesFenceCompatible
                    ? resolveProtectionFastPath(carriedScan, incoming)
                    : undefined;
                if (!isProtectedAt) {
                  // The fast path could not prove the verdict from carried state (an
                  // un-opted-in resolver, or a delimiter it cannot classify). Recover from
                  // the provider's own cumulative "partial" snapshot when one validates
                  // against this exact delta — providers like OpenAI-completions and
                  // Mistral attach it to every text delta, but this is still a full parse,
                  // so it must never run ahead of the fast path above on the common case.
                  isProtectedAt = resolvePartialProtectionCheck({
                    authoritative,
                    contentIndex: eventContentIndex(incomingRecord),
                    incoming,
                    partial: incomingRecord.partial,
                    resolveProtectedRanges: options.resolveProtectedRanges,
                  });
                }
                if (!isProtectedAt) {
                  const protectionPrefix = materializeProtectionPrefix(authoritative);
                  const protectedRanges = options.resolveProtectedRanges(
                    `${protectionPrefix}${incoming}`,
                  );
                  isProtectedAt = (offset) =>
                    isOffsetInProtectedRanges(protectionPrefix.length + offset, protectedRanges);
                }
                callStart = findPotentialCallStart(
                  incoming,
                  atLineStart,
                  options.matcher,
                  isProtectedAt,
                );
              }
            }
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
              advanceProtectionContext(incoming, authoritative);
              break;
            }
            const visiblePrefix = incoming.slice(0, callStart);
            advanceProtectionContext(visiblePrefix, authoritative);
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
                  asOptionalObjectRecord(visibleProjection?.message),
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
                    asOptionalObjectRecord(record.partial),
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
          const classification = classifyPending(
            pending,
            options.matcher,
            options.resolveProtectedRanges,
          );
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
            const replayedCandidate = pending;
            pending = undefined;
            if (replayText) {
              overCapSequenceOpen = false;
              lineStarts.set(key, nextAtLineStart(lineStarts.get(key) ?? true, replayText));
              advanceProtectionContext(replayedCandidate.buffer);
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
          advanceProtectionContext(sanitizedText);
          pending = undefined;
          break;
        }
        if (closesText) {
          emittedTextUnits.delete(key);
          protectionBlockContentIndex = undefined;
          protectionBlockStart = protectionContextLength;
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
          findCandidateCallSequences(
            terminalCandidate,
            options.matcher,
            options.resolveProtectedRanges,
          ).some((sequence) => sequence.activeStart !== undefined);
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
            const classification = classifyPending(
              pending,
              options.matcher,
              options.resolveProtectedRanges,
              true,
            );
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
            const classification = classifyPending(
              pending,
              options.matcher,
              options.resolveProtectedRanges,
              true,
            );
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
        protectionChunks.length = 0;
        protectionContextLength = 0;
        protectionContextOverflow = false;
        protectionBlockContentIndex = undefined;
        protectionBlockStart = 0;
        // Carried block state belongs to the completion that just ended. Without this a
        // following completion would start inside its fence while the materialized
        // context is empty, and the fast path would call its first line protected.
        protectionScan = createProtectionScanState();
        protectionScanAtBlockStart = createProtectionScanState();
        if (options.stopAfterDone) {
          return;
        }
        continue;
      }

      if (type === "error") {
        const knownCandidate =
          pending?.kind === "suppressing" ||
          (pending?.kind === "candidate" &&
            classifyPending(pending, options.matcher, options.resolveProtectedRanges, true).kind !==
              "false-positive");
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
          const classification = classifyPending(
            pending,
            options.matcher,
            options.resolveProtectedRanges,
          );
          if (classification.kind === "false-positive") {
            yield* replayFalsePositiveCandidate(pending);
            // Replayed text becomes ordinary visible text going forward, same as the
            // false-positive branch in the main delta loop above -- without this, the
            // carried fence-state scan silently falls behind what was actually streamed,
            // and a later candidate inside a fence this replay opened would wrongly
            // report unprotected.
            advanceProtectionContext(pending.buffer);
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
      const classification = classifyPending(
        pending,
        options.matcher,
        options.resolveProtectedRanges,
        true,
      );
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
    const record = asOptionalObjectRecord(event);
    if (record?.type === "text_delta" && typeof record.delta === "string") {
      const key = eventKey(record);
      const previous = emittedTextUnits.get(key) ?? 0;
      emittedTextUnits.set(key, previous + record.delta.length);
    }
    yield event;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
