import { randomUUID } from "node:crypto";
import type { StreamFn } from "../agents/runtime/index.js";
import { streamWithPayloadPatch } from "../llm/providers/stream-wrappers/stream-payload-utils.js";
import { streamSimple } from "../llm/stream.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { ProviderWrapStreamFnContext } from "./plugin-entry.js";
import { parseStandalonePlainTextToolCallBlocks } from "./tool-payload.js";

export type ProviderStreamWrapperFactory =
  | ((streamFn: StreamFn | undefined) => StreamFn | undefined)
  | null
  | undefined
  | false;

export function composeProviderStreamWrappers(
  baseStreamFn: StreamFn | undefined,
  ...wrappers: ProviderStreamWrapperFactory[]
): StreamFn | undefined {
  return wrappers.reduce(
    (streamFn, wrapper) => (wrapper ? wrapper(streamFn) : streamFn),
    baseStreamFn,
  );
}

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

function matchesLiteralPrefix(text: string, literal: string): boolean {
  return literal.startsWith(text) || text.startsWith(literal);
}

function skipHorizontalWhitespace(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && /[ \t]/.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function matchesAnyToolNamePrefix(text: string, toolNames: Set<string>): boolean {
  if (!text) {
    return true;
  }
  for (const toolName of toolNames) {
    if (toolName.startsWith(text) || text.startsWith(toolName)) {
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
    const nameStart = toolPrefix.length;
    let cursor = nameStart;
    while (cursor < text.length && text[cursor] !== "]") {
      cursor += 1;
    }
    const name = text.slice(nameStart, cursor).trim();
    if (!matchesAnyToolNamePrefix(name, toolNames)) {
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
  while (cursor < text.length && text[cursor] !== "\n" && text[cursor] !== "]") {
    cursor += 1;
  }
  const firstLine = text.slice(1, cursor);
  if (!matchesAnyToolNamePrefix(firstLine.trim(), toolNames)) {
    return false;
  }
  if (cursor >= text.length) {
    return true;
  }
  if (text[cursor] === "]") {
    return couldStillBeJsonPayload(text, text[cursor + 1] === "\n" ? cursor + 2 : cursor + 1);
  }
  if (text[cursor] !== "\n") {
    return false;
  }
  return couldStillBeJsonPayload(text, cursor + 1);
}

function couldStillBeHarmonyToolCall(text: string, toolNames: Set<string>): boolean {
  const harmonyChannelPrefix = "<|channel|>";
  let cursor = 0;
  if (matchesLiteralPrefix(text, harmonyChannelPrefix)) {
    if (text.length <= harmonyChannelPrefix.length) {
      return true;
    }
    cursor = harmonyChannelPrefix.length;
  }

  const channelRest = text.slice(cursor);
  const channelName = ["commentary", "analysis", "final"].find((marker) =>
    matchesLiteralPrefix(channelRest, marker),
  );
  if (channelName) {
    if (channelRest.length <= channelName.length) {
      return true;
    }
    cursor += channelName.length;
  } else if (cursor === 0) {
    return false;
  } else {
    return false;
  }

  const constraintMarker = " to=";
  const constraintRest = text.slice(cursor);
  if (matchesLiteralPrefix(constraintRest, constraintMarker)) {
    if (constraintRest.length <= constraintMarker.length) {
      return true;
    }
    cursor += constraintMarker.length;
    const nameStart = cursor;
    while (cursor < text.length && text[cursor] !== " " && text[cursor] !== "\n") {
      cursor += 1;
    }
    const name = text.slice(nameStart, cursor).trim();
    if (!matchesAnyToolNamePrefix(name, toolNames)) {
      return false;
    }
  }

  cursor = skipHorizontalWhitespace(text, cursor);
  if (cursor >= text.length) {
    return true;
  }
  const codeMarker = "code";
  const codeRest = text.slice(cursor);
  if (matchesLiteralPrefix(codeRest, codeMarker)) {
    if (codeRest.length <= codeMarker.length) {
      return true;
    }
    cursor += codeMarker.length;
    cursor = skipHorizontalWhitespace(text, cursor);
    if (cursor >= text.length) {
      return true;
    }
  }
  const messageMarker = "<|message|>";
  const messageRest = text.slice(cursor);
  if (matchesLiteralPrefix(messageRest, messageMarker)) {
    return true;
  }
  return text[cursor] === "{";
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
 * Provider stream wrapper for local/proxy providers that sometimes emit a
 * standalone textual tool-call block even when native tool calling is enabled.
 */
export function createPlainTextToolCallCompatWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
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

/** @deprecated Bundled provider stream helper; do not use from third-party plugins. */
export function defaultToolStreamExtraParams(
  extraParams?: Record<string, unknown>,
): Record<string, unknown> {
  if (extraParams?.tool_stream !== undefined) {
    return extraParams;
  }
  return {
    ...extraParams,
    tool_stream: true,
  };
}

export function createPayloadPatchStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  patchPayload: (params: {
    payload: Record<string, unknown>;
    model: Parameters<StreamFn>[0];
    context: Parameters<StreamFn>[1];
    options: Parameters<StreamFn>[2];
  }) => void,
  wrapperOptions?: {
    shouldPatch?: (params: {
      model: Parameters<StreamFn>[0];
      context: Parameters<StreamFn>[1];
      options: Parameters<StreamFn>[2];
    }) => boolean;
  },
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (wrapperOptions?.shouldPatch && !wrapperOptions.shouldPatch({ model, context, options })) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) =>
      patchPayload({ payload, model, context, options }),
    );
  };
}

function isAnthropicThinkingEnabled(payload: Record<string, unknown>): boolean {
  const thinking = payload.thinking;
  if (!thinking || typeof thinking !== "object") {
    return false;
  }
  return (thinking as { type?: unknown }).type !== "disabled";
}

function assistantMessageHasAnthropicToolUse(message: Record<string, unknown>): boolean {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) =>
      block &&
      typeof block === "object" &&
      ((block as { type?: unknown }).type === "tool_use" ||
        (block as { type?: unknown }).type === "toolCall"),
  );
}

function stripTrailingAssistantPrefillMessages(payload: Record<string, unknown>): number {
  if (!Array.isArray(payload.messages)) {
    return 0;
  }

  let stripped = 0;
  while (payload.messages.length > 0) {
    const finalMessage = payload.messages[payload.messages.length - 1];
    if (!finalMessage || typeof finalMessage !== "object") {
      break;
    }

    const message = finalMessage as Record<string, unknown>;
    if (message.role !== "assistant" || assistantMessageHasAnthropicToolUse(message)) {
      break;
    }

    payload.messages.pop();
    stripped += 1;
  }
  return stripped;
}

/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export function stripTrailingAnthropicAssistantPrefillWhenThinking(
  payload: Record<string, unknown>,
): number {
  if (!isAnthropicThinkingEnabled(payload)) {
    return 0;
  }
  return stripTrailingAssistantPrefillMessages(payload);
}

/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export function createAnthropicThinkingPrefillPayloadWrapper(
  baseStreamFn: StreamFn | undefined,
  onStripped?: (stripped: number) => void,
  wrapperOptions?: Parameters<typeof createPayloadPatchStreamWrapper>[2],
): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload }) => {
      const stripped = stripTrailingAnthropicAssistantPrefillWhenThinking(payload);
      if (stripped > 0) {
        onStripped?.(stripped);
      }
    },
    wrapperOptions,
  );
}

/** @deprecated OpenAI-compatible provider stream helper; do not use from third-party plugins. */
export type OpenAICompatibleThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];

/** @deprecated OpenAI-compatible provider stream helper; do not use from third-party plugins. */
export function isOpenAICompatibleThinkingEnabled(params: {
  thinkingLevel: OpenAICompatibleThinkingLevel;
  options: Parameters<StreamFn>[2];
}): boolean {
  const options = (params.options ?? {}) as { reasoningEffort?: unknown; reasoning?: unknown };
  const raw = options.reasoningEffort ?? options.reasoning ?? params.thinkingLevel ?? "high";
  if (typeof raw !== "string") {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized !== "off" && normalized !== "none";
}

/** @deprecated DeepSeek provider stream helper; do not use from third-party plugins. */
export type DeepSeekV4ThinkingLevel = ProviderWrapStreamFnContext["thinkingLevel"];
/** @deprecated DeepSeek provider stream helper; do not use from third-party plugins. */
export type DeepSeekV4ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function isDisabledDeepSeekV4ThinkingLevel(thinkingLevel: DeepSeekV4ThinkingLevel): boolean {
  const normalized = typeof thinkingLevel === "string" ? thinkingLevel.toLowerCase() : "";
  return normalized === "off" || normalized === "none";
}

function resolveDeepSeekV4ReasoningEffort(
  thinkingLevel: DeepSeekV4ThinkingLevel,
): DeepSeekV4ReasoningEffort {
  return thinkingLevel === "xhigh" || thinkingLevel === "max" ? "max" : "high";
}

function stripDeepSeekV4ReasoningContent(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    delete (message as Record<string, unknown>).reasoning_content;
  }
}

function ensureDeepSeekV4AssistantReasoningContent(
  payload: Record<string, unknown>,
  params?: {
    shouldBackfillAssistantMessage?: (message: Record<string, unknown>) => boolean;
  },
): void {
  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }
    if (params?.shouldBackfillAssistantMessage && !params.shouldBackfillAssistantMessage(record)) {
      continue;
    }
    if (!("reasoning_content" in record)) {
      record.reasoning_content = "";
    }
  }
}

/** @deprecated DeepSeek provider stream helper; do not use from third-party plugins. */
export function createDeepSeekV4OpenAICompatibleThinkingWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  thinkingLevel: DeepSeekV4ThinkingLevel;
  shouldPatchModel: (model: Parameters<StreamFn>[0]) => boolean;
  resolveReasoningEffort?: (thinkingLevel: DeepSeekV4ThinkingLevel) => DeepSeekV4ReasoningEffort;
  shouldBackfillAssistantReasoningContent?: (message: Record<string, unknown>) => boolean;
}): StreamFn | undefined {
  if (!params.baseStreamFn) {
    return undefined;
  }
  const underlying = params.baseStreamFn;
  const resolveReasoningEffort = params.resolveReasoningEffort ?? resolveDeepSeekV4ReasoningEffort;
  return (model, context, options) => {
    if (!params.shouldPatchModel(model)) {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      if (isDisabledDeepSeekV4ThinkingLevel(params.thinkingLevel)) {
        payload.thinking = { type: "disabled" };
        delete payload.reasoning_effort;
        delete payload.reasoning;
        stripDeepSeekV4ReasoningContent(payload);
        return;
      }

      payload.thinking = { type: "enabled" };
      payload.reasoning_effort = resolveReasoningEffort(params.thinkingLevel);
      ensureDeepSeekV4AssistantReasoningContent(payload, {
        shouldBackfillAssistantMessage: params.shouldBackfillAssistantReasoningContent,
      });
    });
  };
}

type ThinkingOnlyFinalTextStream = Awaited<ReturnType<StreamFn>>;

function promoteThinkingOnlyFinalOutputToText(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const record = message as { content?: unknown; stopReason?: unknown };
  if (record.stopReason !== "stop" && record.stopReason !== "length") {
    return;
  }
  if (!Array.isArray(record.content) || record.content.length === 0) {
    return;
  }

  let hasVisibleText = false;
  let hasToolCall = false;
  let hasVisibleThinking = false;
  for (const block of record.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (
      typedBlock.type === "text" &&
      typeof typedBlock.text === "string" &&
      typedBlock.text.trim()
    ) {
      hasVisibleText = true;
    }
    if (typedBlock.type === "toolCall" || typedBlock.type === "tool_use") {
      hasToolCall = true;
    }
    if (
      typedBlock.type === "thinking" &&
      typeof typedBlock.thinking === "string" &&
      typedBlock.thinking.trim()
    ) {
      hasVisibleThinking = true;
    }
  }
  if (hasVisibleText || hasToolCall || !hasVisibleThinking) {
    return;
  }

  record.content = record.content.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
    const typedBlock = block as { type?: unknown; thinking?: unknown };
    if (
      typedBlock.type !== "thinking" ||
      typeof typedBlock.thinking !== "string" ||
      !typedBlock.thinking.trim()
    ) {
      return block;
    }
    return { type: "text", text: typedBlock.thinking };
  });
}

function wrapThinkingOnlyFinalTextStream(
  stream: ThinkingOnlyFinalTextStream,
): ThinkingOnlyFinalTextStream {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    promoteThinkingOnlyFinalOutputToText(message);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as { partial?: unknown; message?: unknown };
            promoteThinkingOnlyFinalOutputToText(event.partial);
            promoteThinkingOnlyFinalOutputToText(event.message);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
  return stream;
}

/** @deprecated OpenAI-compatible provider stream helper; do not use from third-party plugins. */
export function createThinkingOnlyFinalTextWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  shouldPatchModel: (model: Parameters<StreamFn>[0]) => boolean;
}): StreamFn | undefined {
  if (!params.baseStreamFn) {
    return undefined;
  }
  const underlying = params.baseStreamFn;
  return (model, context, options) => {
    const maybeStream = underlying(model, context, options);
    if (!params.shouldPatchModel(model)) {
      return maybeStream;
    }
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) => wrapThinkingOnlyFinalTextStream(stream));
    }
    return wrapThinkingOnlyFinalTextStream(maybeStream);
  };
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export type GoogleThinkingInputLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "adaptive"
  | "high"
  | "max"
  | "xhigh";

// Gemini 2.5 Pro only works in thinking mode and rejects thinkingBudget=0 with
// "Budget 0 is invalid. This model only works in thinking mode."
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function isGoogleThinkingRequiredModel(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).includes("gemini-2.5-pro");
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function isGoogleGemini25ThinkingBudgetModel(modelId: string): boolean {
  return /(?:^|\/)gemini-2\.5-/.test(normalizeLowercaseStringOrEmpty(modelId));
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function isGoogleGemini3ProModel(modelId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return /(?:^|\/)gemini-(?:3(?:\.\d+)?-pro|pro-latest)(?:-|$)/.test(normalized);
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function isGoogleGemini3FlashModel(modelId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return /(?:^|\/)gemini-(?:3(?:\.\d+)?-flash|flash(?:-lite)?-latest)(?:-|$)/.test(normalized);
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function isGoogleGemini3ThinkingLevelModel(modelId: string): boolean {
  return isGoogleGemini3ProModel(modelId) || isGoogleGemini3FlashModel(modelId);
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function resolveGoogleGemini3ThinkingLevel(params: {
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
  thinkingBudget?: number;
}): GoogleThinkingLevel | undefined {
  if (typeof params.modelId !== "string") {
    return undefined;
  }
  if (isGoogleGemini3ProModel(params.modelId)) {
    switch (params.thinkingLevel) {
      case "off":
      case "minimal":
      case "low":
        return "LOW";
      case "medium":
      case "high":
      case "max":
      case "xhigh":
        return "HIGH";
      case "adaptive":
        return undefined;
      case undefined:
        break;
    }
    if (typeof params.thinkingBudget === "number") {
      if (params.thinkingBudget < 0) {
        return undefined;
      }
      return params.thinkingBudget <= 2048 ? "LOW" : "HIGH";
    }
    return undefined;
  }
  if (!isGoogleGemini3FlashModel(params.modelId)) {
    return undefined;
  }
  switch (params.thinkingLevel) {
    case "off":
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
    case "max":
    case "xhigh":
      return "HIGH";
    case "adaptive":
      return undefined;
    case undefined:
      break;
  }
  if (typeof params.thinkingBudget !== "number") {
    return undefined;
  }
  if (params.thinkingBudget < 0) {
    return undefined;
  }
  if (params.thinkingBudget <= 0) {
    return "MINIMAL";
  }
  if (params.thinkingBudget <= 2048) {
    return "LOW";
  }
  if (params.thinkingBudget <= 8192) {
    return "MEDIUM";
  }
  return "HIGH";
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function stripInvalidGoogleThinkingBudget(params: {
  thinkingConfig: Record<string, unknown>;
  modelId?: string;
}): boolean {
  if (
    params.thinkingConfig.thinkingBudget !== 0 ||
    typeof params.modelId !== "string" ||
    !isGoogleThinkingRequiredModel(params.modelId)
  ) {
    return false;
  }
  delete params.thinkingConfig.thinkingBudget;
  return true;
}

function isGemma4Model(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).startsWith("gemma-4");
}

function mapThinkLevelToGemma4ThinkingLevel(
  thinkingLevel?: GoogleThinkingInputLevel,
): "MINIMAL" | "HIGH" | undefined {
  switch (thinkingLevel) {
    case "off":
      return undefined;
    case "minimal":
    case "low":
      return "MINIMAL";
    case "medium":
    case "adaptive":
    case "high":
    case "max":
    case "xhigh":
      return "HIGH";
    default:
      return undefined;
  }
}

function normalizeGemma4ThinkingLevel(value: unknown): "MINIMAL" | "HIGH" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.trim().toUpperCase()) {
    case "MINIMAL":
    case "LOW":
      return "MINIMAL";
    case "MEDIUM":
    case "HIGH":
      return "HIGH";
    default:
      return undefined;
  }
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function sanitizeGoogleThinkingPayload(params: {
  payload: unknown;
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
}): void {
  if (!params.payload || typeof params.payload !== "object") {
    return;
  }
  const payloadObj = params.payload as Record<string, unknown>;
  sanitizeGoogleThinkingConfigContainer({
    container: payloadObj.config,
    modelId: params.modelId,
    thinkingLevel: params.thinkingLevel,
  });
  sanitizeGoogleThinkingConfigContainer({
    container: payloadObj.generationConfig,
    modelId: params.modelId,
    thinkingLevel: params.thinkingLevel,
  });
}

function sanitizeGoogleThinkingConfigContainer(params: {
  container: unknown;
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
}): void {
  if (!params.container || typeof params.container !== "object") {
    return;
  }
  const configObj = params.container as Record<string, unknown>;
  const thinkingConfig = configObj.thinkingConfig;
  if (!thinkingConfig || typeof thinkingConfig !== "object") {
    return;
  }
  const thinkingConfigObj = thinkingConfig as Record<string, unknown>;

  if (typeof params.modelId === "string" && isGemma4Model(params.modelId)) {
    const normalizedThinkingLevel = normalizeGemma4ThinkingLevel(thinkingConfigObj.thinkingLevel);
    const explicitMappedLevel = mapThinkLevelToGemma4ThinkingLevel(params.thinkingLevel);
    const disabledViaBudget =
      typeof thinkingConfigObj.thinkingBudget === "number" && thinkingConfigObj.thinkingBudget <= 0;
    const hadThinkingBudget = thinkingConfigObj.thinkingBudget !== undefined;
    delete thinkingConfigObj.thinkingBudget;

    if (
      params.thinkingLevel === "off" ||
      (disabledViaBudget && explicitMappedLevel === undefined && !normalizedThinkingLevel)
    ) {
      delete thinkingConfigObj.thinkingLevel;
      if (Object.keys(thinkingConfigObj).length === 0) {
        delete configObj.thinkingConfig;
      }
      return;
    }

    const mappedLevel =
      explicitMappedLevel ?? normalizedThinkingLevel ?? (hadThinkingBudget ? "MINIMAL" : undefined);

    if (mappedLevel) {
      thinkingConfigObj.thinkingLevel = mappedLevel;
    }
    return;
  }

  const thinkingBudget = thinkingConfigObj.thinkingBudget;

  if (
    params.thinkingLevel === "adaptive" &&
    typeof params.modelId === "string" &&
    isGoogleGemini25ThinkingBudgetModel(params.modelId)
  ) {
    delete thinkingConfigObj.thinkingLevel;
    thinkingConfigObj.thinkingBudget = -1;
    return;
  }

  if (
    params.thinkingLevel === "adaptive" &&
    typeof params.modelId === "string" &&
    isGoogleGemini3ThinkingLevelModel(params.modelId)
  ) {
    delete thinkingConfigObj.thinkingBudget;
    delete thinkingConfigObj.thinkingLevel;
    if (Object.keys(thinkingConfigObj).length === 0) {
      delete configObj.thinkingConfig;
    }
    return;
  }

  if (typeof params.modelId === "string" && isGoogleGemini3ThinkingLevelModel(params.modelId)) {
    const mappedLevel = resolveGoogleGemini3ThinkingLevel({
      modelId: params.modelId,
      thinkingLevel: params.thinkingLevel,
      thinkingBudget: typeof thinkingBudget === "number" ? thinkingBudget : undefined,
    });
    delete thinkingConfigObj.thinkingBudget;
    if (mappedLevel) {
      thinkingConfigObj.thinkingLevel = mappedLevel;
    }
    if (Object.keys(thinkingConfigObj).length === 0) {
      delete configObj.thinkingConfig;
    }
    return;
  }

  if (
    stripInvalidGoogleThinkingBudget({ thinkingConfig: thinkingConfigObj, modelId: params.modelId })
  ) {
    if (Object.keys(thinkingConfigObj).length === 0) {
      delete configObj.thinkingConfig;
    }
    return;
  }

  if (typeof thinkingBudget !== "number" || thinkingBudget >= 0) {
    return;
  }

  // shared model runtime can emit thinkingBudget=-1 for some Google model IDs; a negative budget
  // is invalid for Google-compatible backends and can lead to malformed handling.
  delete thinkingConfigObj.thinkingBudget;
  if (Object.keys(thinkingConfigObj).length === 0) {
    delete configObj.thinkingConfig;
  }
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function createGoogleThinkingPayloadWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: GoogleThinkingInputLevel,
): StreamFn {
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, model }) => {
    if (model.api === "google-generative-ai") {
      sanitizeGoogleThinkingPayload({
        payload,
        modelId: model.id,
        thinkingLevel,
      });
    }
  });
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function createGoogleThinkingStreamWrapper(
  ctx: ProviderWrapStreamFnContext,
): NonNullable<ProviderWrapStreamFnContext["streamFn"]> {
  return createGoogleThinkingPayloadWrapper(ctx.streamFn, ctx.thinkingLevel);
}

export {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "../agents/anthropic-payload-policy.js";
export { applyAnthropicEphemeralCacheControlMarkers } from "../llm/providers/stream-wrappers/anthropic-cache-control-payload.js";
export {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../llm/providers/stream-wrappers/moonshot-thinking.js";
export { streamWithPayloadPatch };
export {
  createToolStreamWrapper,
  createZaiToolStreamWrapper,
} from "../llm/providers/stream-wrappers/zai.js";
