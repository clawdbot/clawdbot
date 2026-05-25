import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, streamSimple } from "@earendil-works/pi-ai";
import { parseStandalonePlainTextToolCallBlocks } from "./tool-payload.js";

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function resolveContextToolNames(context: Parameters<StreamFn>[1]): Set<string> {
  const tools = (context as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return new Set();
  }
  const names = tools
    .map((tool) => {
      const record = toRecord(tool);
      return typeof record?.name === "string" && record.name.trim() ? record.name : undefined;
    })
    .filter((name): name is string => Boolean(name));
  return new Set(names);
}

function couldStillBePlainTextToolCall(text: string, toolNames: Set<string>): boolean {
  if (text.length > 256_000) {
    return false;
  }
  const trimmed = text.trimStart();
  return (
    trimmed.length === 0 ||
    couldStillBeBracketedToolCall(trimmed, toolNames) ||
    couldStillBeHarmonyToolCall(trimmed, toolNames)
  );
}

function matchesLiteralPrefix(text: string, literal: string): boolean {
  return literal.startsWith(text) || text.startsWith(literal);
}

function skipHorizontalWhitespace(text: string, start: number): number {
  let cursor = start;
  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  return cursor;
}

function isToolNameChar(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_-]/.test(char));
}

function hasToolNamePrefix(toolNames: Set<string>, prefix: string): boolean {
  for (const toolName of toolNames) {
    if (toolName.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function couldStillBeJsonPayload(text: string, start: number): boolean {
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor >= text.length || text[cursor] === "{";
}

function couldStillBeBracketedToolCall(text: string, toolNames: Set<string>): boolean {
  if (!text.startsWith("[")) {
    return false;
  }

  const toolPrefix = "[tool:";
  if (matchesLiteralPrefix(text, toolPrefix)) {
    if (text.length <= toolPrefix.length) {
      return true;
    }
    let cursor = toolPrefix.length;
    while (isToolNameChar(text[cursor])) {
      cursor += 1;
    }
    const name = text.slice(toolPrefix.length, cursor);
    if (!name || !hasToolNamePrefix(toolNames, name)) {
      return false;
    }
    if (cursor >= text.length) {
      return true;
    }
    if (text[cursor] !== "]") {
      return false;
    }
    return couldStillBeJsonPayload(text, cursor + 1);
  }

  let cursor = 1;
  while (isToolNameChar(text[cursor])) {
    cursor += 1;
  }
  const name = text.slice(1, cursor);
  if (!name || !hasToolNamePrefix(toolNames, name)) {
    return false;
  }
  if (cursor >= text.length) {
    return true;
  }
  if (text[cursor] !== "]") {
    return false;
  }

  cursor = skipHorizontalWhitespace(text, cursor + 1);
  if (cursor >= text.length) {
    return true;
  }
  if (text[cursor] === "\r") {
    if (cursor + 1 >= text.length) {
      return true;
    }
    return couldStillBeJsonPayload(text, text[cursor + 1] === "\n" ? cursor + 2 : cursor + 1);
  }
  if (text[cursor] !== "\n") {
    return false;
  }
  return couldStillBeJsonPayload(text, cursor + 1);
}

function couldStillBeHarmonyToolCall(text: string, toolNames: Set<string>): boolean {
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
  cursor = skipHorizontalWhitespace(text, cursor);
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
  while (isToolNameChar(text[cursor])) {
    cursor += 1;
  }
  const name = text.slice(nameStart, cursor);
  if (!name || !hasToolNamePrefix(toolNames, name)) {
    return false;
  }
  if (cursor >= text.length) {
    return true;
  }

  cursor = skipHorizontalWhitespace(text, cursor);
  if (cursor >= text.length) {
    return true;
  }
  if (!toolNames.has(name)) {
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

function createSyntheticToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function createPlainTextToolCallBlock(parsed: {
  arguments: Record<string, unknown>;
  name: string;
}): Record<string, unknown> {
  return {
    type: "toolCall",
    id: createSyntheticToolCallId(),
    name: parsed.name,
    arguments: parsed.arguments,
    partialArgs: JSON.stringify(parsed.arguments),
  };
}

function promotePlainTextToolCalls(
  message: unknown,
  toolNames: Set<string>,
): Record<string, unknown> | undefined {
  const messageRecord = toRecord(message);
  if (!messageRecord) {
    return undefined;
  }
  if (!Array.isArray(messageRecord.content)) {
    if (typeof messageRecord.content !== "string" || !messageRecord.content.trim()) {
      return undefined;
    }
    const parsed = parseStandalonePlainTextToolCallBlocks(messageRecord.content, {
      allowedToolNames: toolNames,
    });
    if (!parsed) {
      return undefined;
    }
    return {
      ...messageRecord,
      content: parsed.map(createPlainTextToolCallBlock),
      stopReason: "toolUse",
    };
  }
  if (
    messageRecord.content.some((block) => toRecord(block)?.type === "toolCall") ||
    messageRecord.content.length === 0
  ) {
    return undefined;
  }

  let promoted = false;
  const nextContent: Array<Record<string, unknown>> = [];
  for (const block of messageRecord.content) {
    const blockRecord = toRecord(block);
    if (!blockRecord) {
      return undefined;
    }
    if (blockRecord.type !== "text") {
      nextContent.push(blockRecord);
      continue;
    }
    const text = typeof blockRecord.text === "string" ? blockRecord.text : "";
    if (!text.trim()) {
      continue;
    }
    const parsed = parseStandalonePlainTextToolCallBlocks(text, {
      allowedToolNames: toolNames,
    });
    if (!parsed) {
      return undefined;
    }
    nextContent.push(...parsed.map(createPlainTextToolCallBlock));
    promoted = true;
  }

  if (!promoted) {
    return undefined;
  }
  return {
    ...messageRecord,
    content: nextContent,
    stopReason: "toolUse",
  };
}

function emitPromotedToolCallEvents(
  stream: { push(event: unknown): void },
  message: Record<string, unknown>,
): void {
  const content = Array.isArray(message.content) ? message.content : [];
  content.forEach((block, contentIndex) => {
    const record = toRecord(block);
    if (record?.type !== "toolCall") {
      return;
    }
    stream.push({ type: "toolcall_start", contentIndex, partial: message });
    stream.push({
      type: "toolcall_delta",
      contentIndex,
      delta: typeof record.partialArgs === "string" ? record.partialArgs : "{}",
      partial: message,
    });
  });
}

function wrapPlainTextToolCallStream(
  source: ReturnType<StreamFn>,
  context: Parameters<StreamFn>[1],
): ReturnType<StreamFn> {
  const toolNames = resolveContextToolNames(context);
  if (toolNames.size === 0) {
    return source;
  }
  const output = createAssistantMessageEventStream();
  const stream = output as unknown as { push(event: unknown): void; end(): void };

  void (async () => {
    const bufferedTextEvents: unknown[] = [];
    let bufferedText = "";
    let ended = false;
    const endStream = () => {
      if (!ended) {
        ended = true;
        stream.end();
      }
    };
    const flushBufferedTextEvents = () => {
      for (const event of bufferedTextEvents.splice(0)) {
        stream.push(event);
      }
      bufferedText = "";
    };

    try {
      for await (const event of source as AsyncIterable<unknown>) {
        const record = toRecord(event);
        const type = typeof record?.type === "string" ? record.type : "";

        if (type === "text_start" || type === "text_delta" || type === "text_end") {
          bufferedTextEvents.push(event);
          if (typeof record?.delta === "string") {
            bufferedText += record.delta;
          } else if (typeof record?.content === "string" && !bufferedText) {
            bufferedText = record.content;
          }
          if (!couldStillBePlainTextToolCall(bufferedText, toolNames)) {
            flushBufferedTextEvents();
          }
          continue;
        }

        if (type === "done") {
          const promotedMessage = promotePlainTextToolCalls(record?.message, toolNames);
          if (promotedMessage) {
            bufferedTextEvents.splice(0);
            bufferedText = "";
            emitPromotedToolCallEvents(stream, promotedMessage);
            stream.push({ ...record, reason: "toolUse", message: promotedMessage });
          } else {
            flushBufferedTextEvents();
            stream.push(event);
          }
          endStream();
          return;
        }

        flushBufferedTextEvents();
        stream.push(event);
        if (type === "error") {
          endStream();
          return;
        }
      }
      flushBufferedTextEvents();
    } catch (error) {
      stream.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      endStream();
    }
  })();

  return output as ReturnType<StreamFn>;
}

/**
 * Bundled-provider runtime hygiene for providers that can leak tool-use syntax
 * as assistant text even when native tool calling is enabled.
 */
export function createPlainTextToolCallPromotionWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const maybeStream = underlying(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapPlainTextToolCallStream(stream, context),
      ) as ReturnType<StreamFn>;
    }
    return wrapPlainTextToolCallStream(maybeStream, context);
  };
}
