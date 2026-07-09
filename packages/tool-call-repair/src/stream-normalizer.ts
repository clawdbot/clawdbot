// Tool Call Repair helper module supports stream normalizer behavior.
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  consumeJsonToolClosingMarker,
  END_TOOL_REQUEST,
  findBracketedJsonPayloadStart,
  findHarmonyJsonPayloadStart,
  findJsonObjectEnd,
  findXmlishToolCallEnd,
  isPlainTextToolNameChar,
  isXmlishNameChar,
  matchesLiteralPrefix,
} from "./grammar.js";

export type PlainTextToolCallNameMatcher = {
  /** True only when the candidate is a complete tool name this request may repair. */
  hasExactName(name: string): boolean;
  /** True while streamed bytes still match at least one repairable tool name prefix. */
  hasNamePrefix(prefix: string): boolean;
};

/** Result of repairing the final message carried by a provider stream `done` event. */
export type PlainTextToolCallMessageNormalization =
  | { kind: "promoted" | "scrubbed"; message: Record<string, unknown> }
  | undefined;

/** Stream-level hooks used to promote leaked text tool calls into provider events. */
export type PlainTextToolCallStreamNormalizerOptions = {
  /** Expands a promoted final message into provider-native tool-call stream events. */
  createPromotedToolCallEvents(message: Record<string, unknown>): Iterable<unknown>;
  /** Tool-name matcher scoped to the exact request being normalized. */
  matcher: PlainTextToolCallNameMatcher;
  /** Repairs or scrubs the final done-message snapshot after text buffering completes. */
  normalizeDoneMessage(params: {
    message: unknown;
    reason: unknown;
  }): PlainTextToolCallMessageNormalization;
  /** Stop after the first normalized done event when the wrapped provider has completed. */
  stopAfterDone?: boolean;
};

const TEXT_TOOL_CALL_BUFFER_MAX_CHARS = 256_000;

// Keep a bounded prefix plus enough tail to notice closing markers after the cap;
// otherwise a huge leaked payload could either grow unbounded or lose the visible suffix.
const TEXT_TOOL_CALL_SUPPRESSED_SCAN_MAX_CHARS = TEXT_TOOL_CALL_BUFFER_MAX_CHARS + 64_000;
const TEXT_TOOL_CALL_SUPPRESSED_TAIL_CHARS =
  TEXT_TOOL_CALL_SUPPRESSED_SCAN_MAX_CHARS - TEXT_TOOL_CALL_BUFFER_MAX_CHARS;
const TEXT_TOOL_CALL_SUPPRESSED_MARKER_SCAN_CHARS = 2_048;

type PlainTextToolCallBufferState = "possible" | "impossible" | "over-cap";

// Compaction joins a distant tail onto the safe prefix. Preserve that exact boundary so
// terminal snapshots are scrubbed without inferring it from a UTF-16-shortened buffer length.
type TextToolCallBuffer =
  | { kind: "full"; text: string }
  | { kind: "compacted"; prefixLength: number; text: string };

function createFullTextToolCallBuffer(text = ""): TextToolCallBuffer {
  return { kind: "full", text };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function couldStillBeJsonPayload(text: string, start: number): boolean {
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor >= text.length || text[cursor] === "{";
}

function couldStillBeXmlishParameterPayload(text: string, start: number): boolean {
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  if (cursor >= text.length) {
    return true;
  }
  return matchesLiteralPrefix(text.slice(cursor).toLowerCase(), "<parameter=");
}

function couldStillBeBracketedStandaloneToolCall(
  text: string,
  matcher: PlainTextToolCallNameMatcher,
): boolean {
  if (!text.startsWith("[")) {
    return false;
  }

  const toolPrefix = "[tool:";
  if (matchesLiteralPrefix(text, toolPrefix)) {
    if (text.length <= toolPrefix.length) {
      return true;
    }
    let cursor = toolPrefix.length;
    while (isPlainTextToolNameChar(text[cursor])) {
      cursor += 1;
    }
    const name = text.slice(toolPrefix.length, cursor);
    if (!name || !matcher.hasNamePrefix(name)) {
      return false;
    }
    if (cursor >= text.length) {
      return true;
    }
    if (text[cursor] !== "]") {
      return false;
    }
    if (!matcher.hasExactName(name)) {
      return false;
    }
    return (
      couldStillBeJsonPayload(text, cursor + 1) ||
      couldStillBeXmlishParameterPayload(text, cursor + 1)
    );
  }

  let cursor = 1;
  while (isPlainTextToolNameChar(text[cursor])) {
    cursor += 1;
  }
  const name = text.slice(1, cursor);
  if (!name || !matcher.hasNamePrefix(name)) {
    return false;
  }
  if (cursor >= text.length) {
    return true;
  }
  if (text[cursor] !== "]") {
    return false;
  }
  if (!matcher.hasExactName(name)) {
    return false;
  }

  cursor += 1;
  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  if (cursor >= text.length) {
    return true;
  }
  if (text[cursor] === "\r") {
    if (cursor + 1 >= text.length) {
      return true;
    }
    const payloadStart = text[cursor + 1] === "\n" ? cursor + 2 : cursor + 1;
    return (
      couldStillBeJsonPayload(text, payloadStart) ||
      couldStillBeXmlishParameterPayload(text, payloadStart)
    );
  }
  if (text[cursor] !== "\n") {
    return false;
  }
  return (
    couldStillBeJsonPayload(text, cursor + 1) ||
    couldStillBeXmlishParameterPayload(text, cursor + 1)
  );
}

function couldStillBeXmlishFunctionToolCall(
  text: string,
  matcher: PlainTextToolCallNameMatcher,
): boolean {
  const marker = "<function=";
  const lowerText = text.toLowerCase();
  if (!matchesLiteralPrefix(lowerText, marker)) {
    return false;
  }
  if (text.length <= marker.length) {
    return true;
  }

  let cursor = marker.length;
  while (isXmlishNameChar(text[cursor])) {
    cursor += 1;
  }
  const name = text.slice(marker.length, cursor);
  if (!name || !matcher.hasNamePrefix(name)) {
    return false;
  }
  if (cursor >= text.length) {
    return true;
  }
  if (text[cursor] !== ">") {
    return false;
  }
  if (!matcher.hasExactName(name)) {
    return false;
  }
  return couldStillBeXmlishParameterPayload(text, cursor + 1);
}

function couldStillBeHarmonyStandaloneToolCall(
  text: string,
  matcher: PlainTextToolCallNameMatcher,
): boolean {
  const channelMarker = "<|channel|>";
  let cursor = 0;
  if (matchesLiteralPrefix(text, channelMarker)) {
    if (text.length <= channelMarker.length) {
      return true;
    }
    cursor = channelMarker.length;
  }

  const rest = text.slice(cursor);
  const channel = ["commentary", "analysis", "final"].find((candidate) =>
    matchesLiteralPrefix(rest, candidate),
  );
  if (!channel) {
    return false;
  }
  if (rest.length <= channel.length) {
    return true;
  }

  cursor += channel.length;
  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  if (cursor >= text.length) {
    return true;
  }

  const toMarker = "to=";
  const toRest = text.slice(cursor);
  if (!matchesLiteralPrefix(toRest, toMarker)) {
    return false;
  }
  if (toRest.length <= toMarker.length) {
    return true;
  }

  cursor += toMarker.length;
  const nameStart = cursor;
  while (isPlainTextToolNameChar(text[cursor])) {
    cursor += 1;
  }
  const name = text.slice(nameStart, cursor);
  if (!name || !matcher.hasNamePrefix(name)) {
    return false;
  }
  if (cursor >= text.length) {
    return true;
  }

  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  if (cursor >= text.length) {
    return true;
  }
  if (!matcher.hasExactName(name)) {
    return false;
  }

  const codeMarker = "code";
  const codeRest = text.slice(cursor);
  if (!matchesLiteralPrefix(codeRest, codeMarker)) {
    return false;
  }
  if (codeRest.length <= codeMarker.length) {
    return true;
  }

  cursor += codeMarker.length;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  if (cursor >= text.length) {
    return true;
  }

  const messageMarker = "<|message|>";
  const messageRest = text.slice(cursor);
  if (matchesLiteralPrefix(messageRest, messageMarker)) {
    return true;
  }
  return text[cursor] === "{";
}

function hasExactSerializedToolCallPrefix(
  text: string,
  matcher: PlainTextToolCallNameMatcher,
): boolean {
  const bracketed = /^\[(?:tool:)?([A-Za-z0-9_-]+)\]/.exec(text);
  if (bracketed?.[1]) {
    return matcher.hasExactName(bracketed[1]);
  }
  const xmlish = /^<function=([A-Za-z0-9_.:-]+)>/i.exec(text);
  if (xmlish?.[1]) {
    return matcher.hasExactName(xmlish[1]);
  }
  const harmony =
    /^(?:<\|channel\|>)?(?:commentary|analysis|final)\s+to=([A-Za-z0-9_-]+)\s+code\b/.exec(text);
  return Boolean(harmony?.[1] && matcher.hasExactName(harmony[1]));
}

function stripCompleteSerializedToolCallPrefix(
  text: string,
  matcher?: PlainTextToolCallNameMatcher,
): string | null {
  if (matcher && !hasExactSerializedToolCallPrefix(text, matcher)) {
    return null;
  }
  const xmlishEnd = findXmlishToolCallEnd(text);
  if (xmlishEnd !== null) {
    return text.slice(xmlishEnd);
  }
  const jsonStart = findBracketedJsonPayloadStart(text) ?? findHarmonyJsonPayloadStart(text);
  if (jsonStart === null) {
    return null;
  }
  const jsonEnd = findJsonObjectEnd(text, jsonStart);
  if (jsonEnd === null) {
    return null;
  }
  return text.slice(consumeJsonToolClosingMarker(text, jsonEnd));
}

function stripSerializedToolCallPrefixes(
  text: string,
  matcher: PlainTextToolCallNameMatcher,
): string | null {
  let current = text;
  let changed = false;
  for (let count = 0; count < 32; count += 1) {
    const next = stripCompleteSerializedToolCallPrefix(current.trimStart(), matcher);
    if (next === null) {
      if (changed && hasExactSerializedToolCallPrefix(current.trimStart(), matcher)) {
        return "";
      }
      return changed ? current : null;
    }
    changed = true;
    current = next;
    if (!current.trim()) {
      return current;
    }
  }
  return hasExactSerializedToolCallPrefix(current.trimStart(), matcher) ? "" : current;
}

function getPlainTextToolCallBufferState(
  text: string,
  matcher: PlainTextToolCallNameMatcher,
): PlainTextToolCallBufferState {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) {
    return text.length > TEXT_TOOL_CALL_BUFFER_MAX_CHARS ? "impossible" : "possible";
  }
  const toolCallLike =
    couldStillBeBracketedStandaloneToolCall(trimmed, matcher) ||
    couldStillBeXmlishFunctionToolCall(trimmed, matcher) ||
    couldStillBeHarmonyStandaloneToolCall(trimmed, matcher);
  if (!toolCallLike) {
    return "impossible";
  }
  if (text.length <= TEXT_TOOL_CALL_BUFFER_MAX_CHARS) {
    return "possible";
  }
  const textAfterCompleteToolBlocks = stripSerializedToolCallPrefixes(trimmed, matcher);
  return textAfterCompleteToolBlocks !== null && textAfterCompleteToolBlocks.trim()
    ? "impossible"
    : "over-cap";
}

function getTextToolCallEventText(event: Record<string, unknown>): string | undefined {
  if (typeof event.delta === "string") {
    return event.delta;
  }
  return typeof event.content === "string" ? event.content : undefined;
}

function appendTextToolCallBuffer(bufferedText: string, event: Record<string, unknown>): string {
  const text = getTextToolCallEventText(event);
  if (text === undefined) {
    return bufferedText;
  }
  if (typeof event.content === "string" && !bufferedText) {
    return text;
  }
  return typeof event.delta === "string" ? bufferedText + text : bufferedText;
}

function hasSuppressedToolCallClosingMarker(text: string): boolean {
  if (!text) {
    return false;
  }
  const lowerText = text.toLowerCase();
  return (
    lowerText.includes("</parameter>") ||
    lowerText.includes("</function>") ||
    text.includes(END_TOOL_REQUEST) ||
    text.includes("<|call|>") ||
    text.includes("}") ||
    /\[\/[A-Za-z0-9_.:-]+\]/.test(text)
  );
}

function shouldRescanSuppressedTextToolCallBuffer(
  previousBufferedText: string,
  event: Record<string, unknown>,
): boolean {
  const eventText = getTextToolCallEventText(event);
  if (!eventText) {
    return false;
  }
  return hasSuppressedToolCallClosingMarker(
    previousBufferedText.slice(-TEXT_TOOL_CALL_SUPPRESSED_MARKER_SCAN_CHARS) + eventText,
  );
}

function truncateSuppressedTextToolCallBuffer(
  text: string,
  previous: TextToolCallBuffer,
): TextToolCallBuffer {
  const previousPrefixLength = previous.kind === "compacted" ? previous.prefixLength : undefined;
  if (text.length <= TEXT_TOOL_CALL_SUPPRESSED_SCAN_MAX_CHARS) {
    return previousPrefixLength === undefined
      ? createFullTextToolCallBuffer(text)
      : { kind: "compacted", prefixLength: previousPrefixLength, text };
  }
  const prefix =
    previousPrefixLength === undefined
      ? sliceUtf16Safe(text, 0, TEXT_TOOL_CALL_BUFFER_MAX_CHARS)
      : text.slice(0, previousPrefixLength);
  return {
    kind: "compacted",
    prefixLength: prefix.length,
    text: prefix + sliceUtf16Safe(text, -TEXT_TOOL_CALL_SUPPRESSED_TAIL_CHARS),
  };
}

function appendSuppressedTextToolCallBuffer(
  buffer: TextToolCallBuffer,
  event: Record<string, unknown>,
): { buffer: TextToolCallBuffer; changed: boolean; scanText: string } {
  const nextText = appendTextToolCallBuffer(buffer.text, event);
  if (nextText === buffer.text) {
    return { buffer, changed: false, scanText: buffer.text };
  }
  return {
    buffer: truncateSuppressedTextToolCallBuffer(nextText, buffer),
    changed: true,
    scanText: nextText,
  };
}

function shouldSuppressBufferedTextBlock(blockText: string, buffer: TextToolCallBuffer): boolean {
  const normalizedBlock = blockText.trim();
  const normalizedBuffer = buffer.text.trim();
  const normalizedSuppressedPrefix =
    buffer.kind === "compacted" ? buffer.text.slice(0, buffer.prefixLength).trim() : "";
  return (
    Boolean(normalizedBlock && normalizedBuffer) &&
    (normalizedBuffer.startsWith(normalizedBlock) ||
      normalizedBlock.startsWith(normalizedBuffer) ||
      (buffer.kind === "compacted" &&
        Boolean(normalizedSuppressedPrefix) &&
        normalizedBlock.startsWith(normalizedSuppressedPrefix)))
  );
}

function scrubBufferedTextFromContent(
  content: unknown,
  bufferedText: TextToolCallBuffer,
  matcher: PlainTextToolCallNameMatcher,
  options?: { onlyTextIndex?: unknown; preserveEmptyTextBlocks?: boolean },
): { changed: boolean; content: unknown } {
  if (Array.isArray(content)) {
    if (typeof options?.onlyTextIndex === "number") {
      const block = content[options.onlyTextIndex];
      const record = asRecord(block);
      if (
        record?.type !== "text" ||
        typeof record.text !== "string" ||
        !shouldSuppressBufferedTextBlock(record.text, bufferedText)
      ) {
        return { changed: false, content };
      }
      const nextContent = [...content];
      if (options.preserveEmptyTextBlocks) {
        nextContent[options.onlyTextIndex] = { ...record, text: "" };
      } else {
        nextContent.splice(options.onlyTextIndex, 1);
      }
      return { changed: true, content: nextContent };
    }

    const overCapPrefix = scrubOverCapTextPrefixFromContent(content, matcher, options);
    if (overCapPrefix.changed) {
      return overCapPrefix;
    }

    let changed = false;
    const nextContent = content.flatMap((block) => {
      const record = asRecord(block);
      if (
        record?.type === "text" &&
        typeof record.text === "string" &&
        shouldSuppressBufferedTextBlock(record.text, bufferedText)
      ) {
        changed = true;
        return options?.preserveEmptyTextBlocks ? [{ ...record, text: "" }] : [];
      }
      return [block];
    });
    return changed ? { changed, content: nextContent } : { changed: false, content };
  }
  if (typeof content === "string" && shouldSuppressBufferedTextBlock(content, bufferedText)) {
    return { changed: true, content: "" };
  }
  return { changed: false, content };
}

function scrubOverCapTextPrefixFromContent(
  content: readonly unknown[],
  matcher: PlainTextToolCallNameMatcher,
  options?: { preserveEmptyTextBlocks?: boolean },
): { changed: boolean; content: unknown } {
  let currentContent: readonly unknown[] = content;
  let changed = false;
  for (let count = 0; count < 32; count += 1) {
    const scrubbed = scrubFirstOverCapTextPrefixFromContent(currentContent, matcher, options);
    if (!scrubbed.changed || !Array.isArray(scrubbed.content)) {
      return changed ? { changed: true, content: currentContent } : scrubbed;
    }
    currentContent = scrubbed.content;
    changed = true;
  }
  return { changed, content: currentContent };
}

function scrubFirstOverCapTextPrefixFromContent(
  content: readonly unknown[],
  matcher: PlainTextToolCallNameMatcher,
  options?: { preserveEmptyTextBlocks?: boolean },
): { changed: boolean; content: unknown } {
  const suppressedTextIndexes = new Set<number>();
  let accumulated = "";
  let reachedOverCap = false;
  for (let index = 0; index < content.length; index += 1) {
    const record = asRecord(content[index]);
    if (record?.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    if (!record.text.trim()) {
      continue;
    }
    if (!accumulated && !hasExactSerializedToolCallPrefix(record.text.trimStart(), matcher)) {
      continue;
    }
    if (reachedOverCap && hasExactSerializedToolCallPrefix(record.text.trimStart(), matcher)) {
      break;
    }
    if (
      reachedOverCap &&
      suppressedTextIndexes.size === 1 &&
      !hasSuppressedToolCallClosingMarker(record.text)
    ) {
      break;
    }

    accumulated = accumulated ? `${accumulated}\n${record.text}` : record.text;
    suppressedTextIndexes.add(index);

    const state = getPlainTextToolCallBufferState(accumulated, matcher);
    if (state === "over-cap") {
      reachedOverCap = true;
      const strippedSuffix = stripSerializedToolCallPrefixes(accumulated, matcher);
      if (strippedSuffix !== null) {
        return scrubSuppressedTextIndexesFromContent(
          content,
          suppressedTextIndexes,
          options,
          strippedSuffix,
          index,
        );
      }
      continue;
    }
    if (state === "impossible") {
      if (reachedOverCap) {
        const strippedSuffix = stripSerializedToolCallPrefixes(accumulated, matcher);
        if (strippedSuffix !== null) {
          return scrubSuppressedTextIndexesFromContent(
            content,
            suppressedTextIndexes,
            options,
            strippedSuffix,
            index,
          );
        }
        return scrubSuppressedTextIndexesFromContent(content, suppressedTextIndexes, options);
      }
      accumulated = "";
      suppressedTextIndexes.clear();
      reachedOverCap = false;
    }
  }
  if (reachedOverCap) {
    return scrubSuppressedTextIndexesFromContent(content, suppressedTextIndexes, options);
  }
  return { changed: false, content };
}

function scrubSuppressedTextIndexesFromContent(
  content: readonly unknown[],
  suppressedTextIndexes: ReadonlySet<number>,
  options?: { preserveEmptyTextBlocks?: boolean },
  visibleSuffix?: string,
  visibleSuffixIndex?: number,
): { changed: boolean; content: unknown } {
  const nextContent = content.flatMap((block, blockIndex) => {
    if (!suppressedTextIndexes.has(blockIndex)) {
      return [block];
    }
    const blockRecord = asRecord(block);
    if (
      visibleSuffixIndex === blockIndex &&
      visibleSuffix !== undefined &&
      visibleSuffix.trim() &&
      blockRecord
    ) {
      return [{ ...blockRecord, text: visibleSuffix }];
    }
    return options?.preserveEmptyTextBlocks && blockRecord ? [{ ...blockRecord, text: "" }] : [];
  });
  return { changed: true, content: nextContent };
}

function stripPlainTextToolCallsFromContent(
  content: unknown,
  matcher: PlainTextToolCallNameMatcher,
  options?: { preserveEmptyTextBlocks?: boolean },
): { changed: boolean; content: unknown } {
  if (Array.isArray(content)) {
    const textBlocks = content
      .map((block, index) => ({ index, record: asRecord(block) }))
      .filter(
        (entry): entry is { index: number; record: Record<string, unknown> } =>
          entry.record?.type === "text" && typeof entry.record.text === "string",
      );
    const joinedText = textBlocks.map((entry) => String(entry.record.text)).join("\n");
    if (joinedText.trim()) {
      const strippedJoined = stripSerializedToolCallPrefixes(joinedText.trim(), matcher);
      if (strippedJoined !== null && strippedJoined !== joinedText) {
        const firstTextIndex = textBlocks[0]?.index;
        const nextContent = content.flatMap((block, index) => {
          const record = asRecord(block);
          if (record?.type !== "text" || typeof record.text !== "string") {
            return [block];
          }
          if (options?.preserveEmptyTextBlocks) {
            return [
              {
                ...record,
                text: index === firstTextIndex && strippedJoined.trim() ? strippedJoined : "",
              },
            ];
          }
          return index === firstTextIndex && strippedJoined.trim()
            ? [{ ...record, text: strippedJoined }]
            : [];
        });
        return { changed: true, content: nextContent };
      }
    }

    let changed = false;
    const nextContent: unknown[] = [];
    for (const block of content) {
      const record = asRecord(block);
      if (record?.type !== "text" || typeof record.text !== "string") {
        nextContent.push(block);
        continue;
      }
      const strippedText = stripSerializedToolCallPrefixes(record.text, matcher);
      if (strippedText === null || strippedText === record.text) {
        nextContent.push(block);
        continue;
      }
      changed = true;
      if (strippedText.trim()) {
        nextContent.push({ ...record, text: strippedText });
      } else if (options?.preserveEmptyTextBlocks) {
        nextContent.push({ ...record, text: "" });
      }
    }
    return changed ? { changed, content: nextContent } : { changed: false, content };
  }
  if (typeof content === "string") {
    const strippedText = stripSerializedToolCallPrefixes(content, matcher);
    if (strippedText !== null && strippedText !== content) {
      return { changed: true, content: strippedText };
    }
  }
  return { changed: false, content };
}

function stripOverCapPlainTextToolCallsFromContent(
  content: unknown,
  matcher: PlainTextToolCallNameMatcher,
  options?: { preserveEmptyTextBlocks?: boolean },
): { changed: boolean; content: unknown } {
  if (Array.isArray(content)) {
    let changed = false;
    const nextContent: unknown[] = [];
    for (const block of content) {
      const record = asRecord(block);
      if (
        record?.type !== "text" ||
        typeof record.text !== "string" ||
        record.text.length <= TEXT_TOOL_CALL_BUFFER_MAX_CHARS
      ) {
        nextContent.push(block);
        continue;
      }
      const strippedText = stripSerializedToolCallPrefixes(record.text, matcher);
      if (strippedText === null || strippedText === record.text) {
        nextContent.push(block);
        continue;
      }
      changed = true;
      if (strippedText.trim()) {
        nextContent.push({ ...record, text: strippedText });
      } else if (options?.preserveEmptyTextBlocks) {
        nextContent.push({ ...record, text: "" });
      }
    }
    return changed ? { changed, content: nextContent } : { changed: false, content };
  }
  if (typeof content === "string" && content.length > TEXT_TOOL_CALL_BUFFER_MAX_CHARS) {
    const strippedText = stripSerializedToolCallPrefixes(content, matcher);
    if (strippedText !== null && strippedText !== content) {
      return { changed: true, content: strippedText };
    }
  }
  return { changed: false, content };
}

function scrubPlainTextToolCallContent(
  content: unknown,
  bufferedText: TextToolCallBuffer,
  matcher: PlainTextToolCallNameMatcher,
  options?: { onlyTextIndex?: unknown; preserveEmptyTextBlocks?: boolean },
): { changed: boolean; content: unknown } {
  const scrubbed = scrubBufferedTextFromContent(content, bufferedText, matcher, options);
  const stripped =
    options?.onlyTextIndex === undefined
      ? stripPlainTextToolCallsFromContent(scrubbed.content, matcher, options)
      : { changed: false, content: scrubbed.content };
  return stripped.changed ? stripped : scrubbed;
}

function shouldPreserveEmptyTextBlocksForEventIndex(
  content: unknown,
  bufferedText: TextToolCallBuffer,
  matcher: PlainTextToolCallNameMatcher,
  eventContentIndex: unknown,
): boolean {
  if (
    typeof eventContentIndex !== "number" ||
    !Number.isInteger(eventContentIndex) ||
    eventContentIndex < 0 ||
    !Array.isArray(content)
  ) {
    return false;
  }
  const currentBlock = content[eventContentIndex];
  if (currentBlock === undefined) {
    return false;
  }
  const scrubbed = scrubPlainTextToolCallContent(content, bufferedText, matcher);
  return (
    scrubbed.changed &&
    Array.isArray(scrubbed.content) &&
    scrubbed.content[eventContentIndex] !== currentBlock
  );
}

function scrubBufferedTextFromPartial(
  event: Record<string, unknown>,
  bufferedText: TextToolCallBuffer,
  matcher: PlainTextToolCallNameMatcher,
  contentIndex?: unknown,
  options?: { preserveEmptyTextBlocks?: boolean },
): Record<string, unknown> {
  const partial = asRecord(event.partial);
  if (!partial) {
    return event;
  }
  const preserveEmptyTextBlocks =
    options?.preserveEmptyTextBlocks === true ||
    shouldPreserveEmptyTextBlocksForEventIndex(
      partial.content,
      bufferedText,
      matcher,
      event.contentIndex,
    );
  const scrubbed = scrubPlainTextToolCallContent(partial.content, bufferedText, matcher, {
    onlyTextIndex: contentIndex,
    preserveEmptyTextBlocks,
  });
  if (!scrubbed.changed) {
    return event;
  }
  return {
    ...event,
    partial: {
      ...partial,
      content: scrubbed.content,
    },
  };
}

function scrubBufferedTextFromMessage(
  event: Record<string, unknown>,
  bufferedText: TextToolCallBuffer,
  matcher: PlainTextToolCallNameMatcher,
  contentIndex?: unknown,
): Record<string, unknown> {
  const message = asRecord(event.message);
  if (!message) {
    return event;
  }
  const scrubbed = scrubPlainTextToolCallContent(message.content, bufferedText, matcher, {
    onlyTextIndex: contentIndex,
  });
  if (!scrubbed.changed) {
    return event;
  }
  return {
    ...event,
    message: {
      ...message,
      content: scrubbed.content,
    },
  };
}

function scrubBufferedTextFromError(
  event: Record<string, unknown>,
  bufferedText: TextToolCallBuffer,
  matcher: PlainTextToolCallNameMatcher,
  contentIndex?: unknown,
): Record<string, unknown> {
  const error = asRecord(event.error);
  if (!error) {
    return event;
  }
  const scrubbed = scrubPlainTextToolCallContent(error.content, bufferedText, matcher, {
    onlyTextIndex: contentIndex,
  });
  if (!scrubbed.changed) {
    return event;
  }
  return {
    ...event,
    error: {
      ...error,
      content: scrubbed.content,
    },
  };
}

function replaceTextContentWithVisibleSuffix(
  record: Record<string, unknown>,
  visibleText: string,
  contentIndex?: unknown,
  matcher?: PlainTextToolCallNameMatcher,
): Record<string, unknown> {
  if (typeof record.content === "string") {
    return { ...record, content: visibleText };
  }
  if (!Array.isArray(record.content)) {
    return record;
  }
  const originalContent = record.content;
  if (typeof contentIndex === "number") {
    const content = originalContent.flatMap((block, index) => {
      if (index !== contentIndex) {
        return [block];
      }
      const blockRecord = asRecord(block);
      if (blockRecord?.type !== "text" || typeof blockRecord.text !== "string") {
        return [block];
      }
      if (matcher && !hasExactSerializedToolCallPrefix(blockRecord.text.trimStart(), matcher)) {
        return [block];
      }
      return visibleText.trim() ? [{ ...blockRecord, text: visibleText }] : [];
    });
    if (matcher && content.every((block, index) => block === originalContent[index])) {
      return replaceTextContentWithVisibleSuffix(record, visibleText, undefined, matcher);
    }
    return { ...record, content };
  }
  const textBlockCount = originalContent.filter((block) => {
    const blockRecord = asRecord(block);
    return blockRecord?.type === "text" && typeof blockRecord.text === "string";
  }).length;
  if (textBlockCount !== 1) {
    if (!matcher) {
      return record;
    }
    let replaced = false;
    const content = originalContent.flatMap((block) => {
      const blockRecord = asRecord(block);
      if (blockRecord?.type !== "text" || typeof blockRecord.text !== "string") {
        return [block];
      }
      if (replaced) {
        return [block];
      }
      if (!hasExactSerializedToolCallPrefix(blockRecord.text.trimStart(), matcher)) {
        return [block];
      }
      replaced = true;
      return visibleText.trim() ? [{ ...blockRecord, text: visibleText }] : [];
    });
    return replaced ? { ...record, content } : record;
  }
  let replaced = false;
  const content = originalContent.flatMap((block) => {
    const blockRecord = asRecord(block);
    if (blockRecord?.type !== "text" || typeof blockRecord.text !== "string") {
      return [block];
    }
    if (replaced) {
      return [];
    }
    replaced = true;
    return visibleText.trim() ? [{ ...blockRecord, text: visibleText }] : [];
  });
  return { ...record, content };
}

function scrubReclassifiedMixedTextFromPartial(
  event: Record<string, unknown>,
  visibleText: string,
  contentIndex?: unknown,
  matcher?: PlainTextToolCallNameMatcher,
): Record<string, unknown> {
  const partial = asRecord(event.partial);
  if (!partial) {
    return event;
  }
  return {
    ...event,
    partial: replaceTextContentWithVisibleSuffix(partial, visibleText, contentIndex, matcher),
  };
}

function scrubReclassifiedMixedTextFromError(
  event: Record<string, unknown>,
  visibleText: string,
  contentIndex?: unknown,
  matcher?: PlainTextToolCallNameMatcher,
): Record<string, unknown> {
  const error = asRecord(event.error);
  if (!error) {
    return event;
  }
  return {
    ...event,
    error: replaceTextContentWithVisibleSuffix(error, visibleText, contentIndex, matcher),
  };
}

/** Scrubs final messages whose streamed plain-text tool-call prefix exceeded the buffer cap. */
export function scrubOverCapPlainTextToolCallMessage(params: {
  candidateText: string | undefined;
  matcher: PlainTextToolCallNameMatcher;
  message: unknown;
}): Record<string, unknown> | undefined {
  const record = asRecord(params.message);
  const candidateText = params.candidateText;
  if (!record || !candidateText) {
    return undefined;
  }
  const bufferState = getPlainTextToolCallBufferState(candidateText, params.matcher);
  if (bufferState === "impossible") {
    if (candidateText.length <= TEXT_TOOL_CALL_BUFFER_MAX_CHARS) {
      return undefined;
    }
    const visibleText = stripSerializedToolCallPrefixes(candidateText, params.matcher);
    if (visibleText?.trim() && !Array.isArray(record.content)) {
      const replaced = replaceTextContentWithVisibleSuffix(
        record,
        visibleText,
        undefined,
        params.matcher,
      );
      if (replaced !== record) {
        return replaced;
      }
    }
    if (Array.isArray(record.content)) {
      const overCap = scrubOverCapTextPrefixFromContent(record.content, params.matcher);
      const stripped = stripOverCapPlainTextToolCallsFromContent(overCap.content, params.matcher);
      if (!overCap.changed && !stripped.changed) {
        return undefined;
      }
      return {
        ...record,
        content: stripped.changed ? stripped.content : overCap.content,
      };
    }
    return undefined;
  }
  if (bufferState !== "over-cap") {
    return undefined;
  }
  const scrubbed = scrubPlainTextToolCallContent(
    record.content,
    createFullTextToolCallBuffer(candidateText),
    params.matcher,
  );
  return {
    ...record,
    content: scrubbed.content,
  };
}

function createScrubbedTextDeltaEvent(
  event: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  const partial = asRecord(event.partial);
  const syntheticContent =
    typeof event.contentIndex === "number"
      ? Array.from({ length: event.contentIndex + 1 }, (_, index) => ({
          type: "text",
          text: index === event.contentIndex ? text : "",
        }))
      : [{ type: "text", text }];
  const scrubbedPartial = partial
    ? replaceTextContentWithVisibleSuffix(partial, text, event.contentIndex)
    : { role: "assistant", content: syntheticContent };
  const eventWithoutTextEndContent = { ...event };
  delete eventWithoutTextEndContent.content;
  return {
    ...eventWithoutTextEndContent,
    type: "text_delta",
    delta: text,
    partial: scrubbedPartial,
  };
}

function appendReclassifiedVisibleDelta(
  visibleText: string,
  event: Record<string, unknown>,
): string {
  return typeof event.delta === "string" ? `${visibleText}${event.delta}` : visibleText;
}

function isAllowedTextToolCallLikeEvent(
  event: Record<string, unknown>,
  matcher: PlainTextToolCallNameMatcher,
): boolean {
  const text = getTextToolCallEventText(event);
  return Boolean(text?.trim() && getPlainTextToolCallBufferState(text, matcher) !== "impossible");
}

function isBufferedTextEvent(bufferedEvent: unknown): boolean {
  const bufferedRecord = asRecord(bufferedEvent);
  const bufferedType = typeof bufferedRecord?.type === "string" ? bufferedRecord.type : "";
  return (
    bufferedType === "text_start" || bufferedType === "text_delta" || bufferedType === "text_end"
  );
}

/** Buffers provider stream text long enough to promote or hide leaked plain-text tool calls. */
export async function* normalizePlainTextToolCallStreamEvents(
  source: AsyncIterable<unknown>,
  options: PlainTextToolCallStreamNormalizerOptions,
): AsyncGenerator {
  const bufferedEvents: unknown[] = [];
  let bufferedText = createFullTextToolCallBuffer();
  let suppressingOverCapTextToolCall = false;
  let suppressedTextContentIndex: unknown;
  let hasSuppressedTextContentIndex = false;
  let reclassifiedMixedTextContentIndex: unknown;
  let hasReclassifiedMixedTextContentIndex = false;
  let scrubReclassifiedMixedTextFromDone = false;
  let reclassifiedMixedVisibleText: string | undefined;

  const flushBufferedEvents = () => {
    const events = bufferedEvents.splice(0);
    bufferedText = createFullTextToolCallBuffer();
    return events;
  };

  function* flushScrubbedBufferedNonTextEvents(resetBufferedText: boolean) {
    const events = bufferedEvents.splice(0);
    const textToScrub = bufferedText;
    if (resetBufferedText) {
      bufferedText = createFullTextToolCallBuffer();
    }
    for (const bufferedEvent of events) {
      if (isBufferedTextEvent(bufferedEvent)) {
        continue;
      }
      const bufferedRecord = asRecord(bufferedEvent);
      yield bufferedRecord
        ? scrubBufferedTextFromPartial(
            bufferedRecord,
            textToScrub,
            options.matcher,
            hasSuppressedTextContentIndex ? suppressedTextContentIndex : undefined,
            { preserveEmptyTextBlocks: suppressingOverCapTextToolCall },
          )
        : bufferedEvent;
    }
  }

  function* suppressBufferedTextEvents() {
    suppressingOverCapTextToolCall = true;
    yield* flushScrubbedBufferedNonTextEvents(false);
  }

  for await (const event of source) {
    const record = asRecord(event);
    if (!record) {
      yield event;
      continue;
    }
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "text_start" || type === "text_delta" || type === "text_end") {
      if (
        type === "text_end" &&
        hasReclassifiedMixedTextContentIndex &&
        record.contentIndex === reclassifiedMixedTextContentIndex
      ) {
        continue;
      }
      if (
        scrubReclassifiedMixedTextFromDone &&
        reclassifiedMixedVisibleText !== undefined &&
        hasReclassifiedMixedTextContentIndex &&
        record.contentIndex === reclassifiedMixedTextContentIndex
      ) {
        reclassifiedMixedVisibleText = appendReclassifiedVisibleDelta(
          reclassifiedMixedVisibleText,
          record,
        );
        yield scrubReclassifiedMixedTextFromPartial(
          record,
          reclassifiedMixedVisibleText,
          reclassifiedMixedTextContentIndex,
          options.matcher,
        );
        continue;
      }
      if (suppressingOverCapTextToolCall) {
        // Once the tentative tool call exceeds the cap, suppress text deltas until a closing
        // marker proves whether the buffered prefix was a hidden call or mixed visible text.
        if (hasSuppressedTextContentIndex && record.contentIndex !== suppressedTextContentIndex) {
          if (isAllowedTextToolCallLikeEvent(record, options.matcher)) {
            continue;
          }
          yield scrubBufferedTextFromPartial(
            record,
            bufferedText,
            options.matcher,
            suppressedTextContentIndex,
            { preserveEmptyTextBlocks: true },
          );
          continue;
        }
        const previousBufferedText = bufferedText.text;
        const appended = appendSuppressedTextToolCallBuffer(bufferedText, record);
        bufferedText = appended.buffer;
        const shouldRescan =
          appended.changed &&
          shouldRescanSuppressedTextToolCallBuffer(previousBufferedText, record);
        const bufferState = shouldRescan
          ? getPlainTextToolCallBufferState(appended.scanText, options.matcher)
          : "over-cap";
        if (bufferState === "impossible") {
          const visibleText =
            stripSerializedToolCallPrefixes(appended.scanText, options.matcher) ?? "";
          yield* flushScrubbedBufferedNonTextEvents(true);
          suppressingOverCapTextToolCall = false;
          suppressedTextContentIndex = undefined;
          hasSuppressedTextContentIndex = false;
          reclassifiedMixedTextContentIndex = record.contentIndex;
          hasReclassifiedMixedTextContentIndex = true;
          scrubReclassifiedMixedTextFromDone = true;
          reclassifiedMixedVisibleText = visibleText;
          if (visibleText.trim()) {
            yield createScrubbedTextDeltaEvent(record, visibleText);
          }
        }
        continue;
      }
      bufferedEvents.push(event);
      bufferedText = createFullTextToolCallBuffer(
        appendTextToolCallBuffer(bufferedText.text, record),
      );
      const scanBufferedText = truncateSuppressedTextToolCallBuffer(
        bufferedText.text,
        bufferedText,
      );
      const scanWasTruncated = scanBufferedText.kind === "compacted";
      const bufferState = getPlainTextToolCallBufferState(scanBufferedText.text, options.matcher);
      if (bufferState === "impossible") {
        const visibleText =
          !scanWasTruncated && bufferedText.text.length > TEXT_TOOL_CALL_BUFFER_MAX_CHARS
            ? stripSerializedToolCallPrefixes(bufferedText.text.trimStart(), options.matcher)
            : null;
        if (visibleText?.trim()) {
          // A tool-call prefix followed by visible text must be reclassified: emit only the
          // suffix now, then scrub the final done/error snapshots to match that stream history.
          yield* flushScrubbedBufferedNonTextEvents(true);
          reclassifiedMixedTextContentIndex = record.contentIndex;
          hasReclassifiedMixedTextContentIndex = true;
          scrubReclassifiedMixedTextFromDone = true;
          reclassifiedMixedVisibleText = visibleText;
          yield createScrubbedTextDeltaEvent(record, visibleText);
        } else if (
          scanWasTruncated &&
          stripSerializedToolCallPrefixes(scanBufferedText.text.trimStart(), options.matcher) !==
            null
        ) {
          bufferedText = scanBufferedText;
          suppressedTextContentIndex = record.contentIndex;
          hasSuppressedTextContentIndex = true;
          yield* suppressBufferedTextEvents();
        } else {
          yield* flushBufferedEvents();
        }
      } else if (bufferState === "over-cap") {
        bufferedText = scanBufferedText;
        suppressedTextContentIndex = record.contentIndex;
        hasSuppressedTextContentIndex = true;
        yield* suppressBufferedTextEvents();
      }
      continue;
    }

    if (type === "done") {
      const normalizedMessage = options.normalizeDoneMessage({
        message: record.message,
        reason: record.reason,
      });
      if (normalizedMessage?.kind === "promoted") {
        yield* flushScrubbedBufferedNonTextEvents(true);
        suppressingOverCapTextToolCall = false;
        suppressedTextContentIndex = undefined;
        hasSuppressedTextContentIndex = false;
        scrubReclassifiedMixedTextFromDone = false;
        reclassifiedMixedTextContentIndex = undefined;
        hasReclassifiedMixedTextContentIndex = false;
        reclassifiedMixedVisibleText = undefined;
        yield* options.createPromotedToolCallEvents(normalizedMessage.message);
        yield { ...record, reason: "toolUse", message: normalizedMessage.message };
        if (options.stopAfterDone) {
          return;
        }
        continue;
      }
      if (normalizedMessage?.kind === "scrubbed") {
        yield* flushScrubbedBufferedNonTextEvents(true);
        suppressingOverCapTextToolCall = false;
        suppressedTextContentIndex = undefined;
        hasSuppressedTextContentIndex = false;
        scrubReclassifiedMixedTextFromDone = false;
        reclassifiedMixedTextContentIndex = undefined;
        hasReclassifiedMixedTextContentIndex = false;
        reclassifiedMixedVisibleText = undefined;
        yield { ...record, message: normalizedMessage.message };
        if (options.stopAfterDone) {
          return;
        }
        continue;
      }
      const mixedMessageRecord = scrubReclassifiedMixedTextFromDone
        ? asRecord(record.message)
        : undefined;
      const strippedMixedMessage =
        mixedMessageRecord && reclassifiedMixedVisibleText !== undefined
          ? replaceTextContentWithVisibleSuffix(
              mixedMessageRecord,
              reclassifiedMixedVisibleText,
              hasReclassifiedMixedTextContentIndex ? reclassifiedMixedTextContentIndex : undefined,
              options.matcher,
            )
          : undefined;
      if (strippedMixedMessage) {
        yield* flushScrubbedBufferedNonTextEvents(true);
        scrubReclassifiedMixedTextFromDone = false;
        reclassifiedMixedTextContentIndex = undefined;
        hasReclassifiedMixedTextContentIndex = false;
        reclassifiedMixedVisibleText = undefined;
        yield { ...record, message: strippedMixedMessage };
        if (options.stopAfterDone) {
          return;
        }
        continue;
      }
      if (suppressingOverCapTextToolCall) {
        const scrubbedDoneEvent = scrubBufferedTextFromMessage(
          record,
          bufferedText,
          options.matcher,
          hasSuppressedTextContentIndex ? suppressedTextContentIndex : undefined,
        );
        yield* flushScrubbedBufferedNonTextEvents(true);
        suppressingOverCapTextToolCall = false;
        suppressedTextContentIndex = undefined;
        hasSuppressedTextContentIndex = false;
        scrubReclassifiedMixedTextFromDone = false;
        reclassifiedMixedTextContentIndex = undefined;
        hasReclassifiedMixedTextContentIndex = false;
        reclassifiedMixedVisibleText = undefined;
        yield scrubbedDoneEvent;
        if (options.stopAfterDone) {
          return;
        }
        continue;
      }
      yield* flushBufferedEvents();
      yield event;
      if (options.stopAfterDone) {
        return;
      }
      continue;
    }

    if (type === "error") {
      if (!suppressingOverCapTextToolCall) {
        yield* flushBufferedEvents();
      }
      yield suppressingOverCapTextToolCall
        ? scrubBufferedTextFromError(
            scrubBufferedTextFromPartial(
              record,
              bufferedText,
              options.matcher,
              hasSuppressedTextContentIndex ? suppressedTextContentIndex : undefined,
              { preserveEmptyTextBlocks: true },
            ),
            bufferedText,
            options.matcher,
            hasSuppressedTextContentIndex ? suppressedTextContentIndex : undefined,
          )
        : scrubReclassifiedMixedTextFromDone && reclassifiedMixedVisibleText !== undefined
          ? scrubReclassifiedMixedTextFromError(
              scrubReclassifiedMixedTextFromPartial(
                record,
                reclassifiedMixedVisibleText,
                hasReclassifiedMixedTextContentIndex
                  ? reclassifiedMixedTextContentIndex
                  : undefined,
                options.matcher,
              ),
              reclassifiedMixedVisibleText,
              hasReclassifiedMixedTextContentIndex ? reclassifiedMixedTextContentIndex : undefined,
              options.matcher,
            )
          : event;
      return;
    }

    if (scrubReclassifiedMixedTextFromDone && reclassifiedMixedVisibleText !== undefined) {
      yield scrubReclassifiedMixedTextFromPartial(
        record,
        reclassifiedMixedVisibleText,
        hasReclassifiedMixedTextContentIndex ? reclassifiedMixedTextContentIndex : undefined,
        options.matcher,
      );
      continue;
    }

    if (bufferedEvents.length > 0 && !suppressingOverCapTextToolCall) {
      bufferedEvents.push(event);
      continue;
    }

    yield suppressingOverCapTextToolCall
      ? scrubBufferedTextFromPartial(
          record,
          bufferedText,
          options.matcher,
          hasSuppressedTextContentIndex ? suppressedTextContentIndex : undefined,
          { preserveEmptyTextBlocks: suppressingOverCapTextToolCall },
        )
      : event;
  }

  if (!suppressingOverCapTextToolCall) {
    yield* flushBufferedEvents();
  }
}
