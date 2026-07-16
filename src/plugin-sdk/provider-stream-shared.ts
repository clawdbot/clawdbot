// Provider stream shared helpers implement reusable stream wrappers and payload policies.
import { resolveOpenAIReasoningEffortForModel } from "@openclaw/ai/internal/openai";
import { normalizeLowercaseStringOrEmpty } from "../../packages/normalization-core/src/string-coerce.js";
import {
  createPromotedPlainTextToolCallBlock,
  createPromotedPlainTextToolCallEvents,
  normalizePlainTextToolCallStreamEvents,
  projectScrubbedPlainTextToolCallMessage,
  projectStandalonePlainTextToolCallMessage,
  type PlainTextToolCallMessageProjection,
  type PlainTextToolCallNameMatcher,
  type PlainTextToolCallMessageNormalization,
} from "../../packages/tool-call-repair/src/index.js";
import { resolveOpenAIReasoningEffortMap } from "../agents/openai-reasoning-compat.js";
import type { StreamFn } from "../agents/runtime/index.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import { mapThinkingLevelToReasoningEffort } from "../llm/providers/stream-wrappers/reasoning-effort-utils.js";
import { streamWithPayloadPatch } from "../llm/providers/stream-wrappers/stream-payload-utils.js";
import { streamSimple } from "../llm/stream.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
export { applyAnthropicRefusal } from "@openclaw/ai/internal/anthropic";
export { createDeferredEventBuffer } from "@openclaw/ai/internal/runtime";
export { notifyLlmRequestActivity, onLlmRequestActivity } from "@openclaw/ai/internal/runtime";

type ProviderWrapStreamFnContext = import("../plugins/types.js").ProviderWrapStreamFnContext;

/** Optional provider stream decorator factory used by shared provider wrappers. */
export type ProviderStreamWrapperFactory =
  /** Wrapper factory that can decorate, replace, or omit a provider stream function. */
  ((streamFn: StreamFn | undefined) => StreamFn | undefined) | null | undefined | false;

/** Compose stream wrapper factories from left to right around a base stream function. */
export function composeProviderStreamWrappers(
  /** Base provider stream function to pass through the wrapper chain. */
  baseStreamFn: StreamFn | undefined,
  /** Ordered wrapper factories; falsey entries are skipped. */
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

function promotePlainTextToolCalls(
  message: unknown,
  toolNames: Set<string>,
): PlainTextToolCallMessageProjection | undefined {
  const messageRecord = toRecord(message);
  if (
    Array.isArray(messageRecord?.content) &&
    messageRecord.content.some((block) => toRecord(block)?.type === "toolCall")
  ) {
    return undefined;
  }
  return projectStandalonePlainTextToolCallMessage({
    allowedToolNames: toolNames,
    createToolCallBlock: createPromotedPlainTextToolCallBlock,
    isRetainableNonTextBlock: () => true,
    message,
  });
}

function createProviderToolNameMatcher(toolNames: Set<string>): PlainTextToolCallNameMatcher {
  return {
    hasExactName: (name) => toolNames.has(name),
    hasNamePrefix: (prefix) => {
      for (const toolName of toolNames) {
        if (toolName.startsWith(prefix)) {
          return true;
        }
      }
      return false;
    },
  };
}

function normalizeProviderDoneMessage(
  message: unknown,
  allowPromotion: boolean,
  toolNames: Set<string>,
  matcher: PlainTextToolCallNameMatcher,
  preserveEmptyTextBlocks = false,
): PlainTextToolCallMessageNormalization {
  const scrubbedMessage = scrubProviderTerminalMessage(message, matcher, preserveEmptyTextBlocks);
  if (scrubbedMessage) {
    return { kind: "scrubbed", ...scrubbedMessage };
  }
  // Token-limit and error terminals can leave complete-looking tool syntax.
  // Only normal completion or explicit tool use may promote it into an executable call.
  if (!allowPromotion) {
    return undefined;
  }
  const promotedMessage = promotePlainTextToolCalls(message, toolNames);
  return promotedMessage ? { kind: "promoted", ...promotedMessage } : undefined;
}

function scrubProviderTerminalMessage(
  message: unknown,
  matcher: PlainTextToolCallNameMatcher,
  preserveEmptyTextBlocks = false,
  forceKnownCandidates = false,
): PlainTextToolCallMessageProjection | undefined {
  return projectScrubbedPlainTextToolCallMessage({
    forceKnownCandidates,
    matcher,
    message,
    preserveEmptyTextBlocks,
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
  const matcher = createProviderToolNameMatcher(toolNames);
  const output = createAssistantMessageEventStream();
  const stream = output as unknown as { push(event: unknown): void; end(): void };

  void (async () => {
    let ended = false;
    const endStream = () => {
      if (!ended) {
        ended = true;
        stream.end();
      }
    };

    try {
      const normalizedEvents = normalizePlainTextToolCallStreamEvents(
        source as AsyncIterable<unknown>,
        {
          createPromotedToolCallEvents: createPromotedPlainTextToolCallEvents,
          matcher,
          normalizeTerminalMessage: ({ allowPromotion, message, preserveEmptyTextBlocks }) =>
            normalizeProviderDoneMessage(
              message,
              allowPromotion,
              toolNames,
              matcher,
              preserveEmptyTextBlocks,
            ),
          stopAfterDone: true,
        },
      );
      for await (const event of normalizedEvents) {
        stream.push(event);
      }
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
export function createPlainTextToolCallCompatWrapper(
  /** Provider stream function to wrap; defaults to the simple stream implementation. */
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

/** @deprecated Bundled provider stream helper; do not use from third-party plugins. */
export function defaultToolStreamExtraParams(
  /** Existing provider extra params; explicit tool_stream values are preserved. */
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

/** Wrap a provider stream so callers can patch the outbound provider payload once. */
export function createPayloadPatchStreamWrapper(
  /** Provider stream function whose outbound payload should be patched. */
  baseStreamFn: StreamFn | undefined,
  patchPayload: (params: {
    /** Mutable provider payload immediately before the underlying stream dispatches it. */
    payload: Record<string, unknown>;
    /** Model selected for the stream call. */
    model: Parameters<StreamFn>[0];
    /** Stream context passed by the runtime. */
    context: Parameters<StreamFn>[1];
    /** Stream options passed by the runtime. */
    options: Parameters<StreamFn>[2];
  }) => void,
  wrapperOptions?: {
    shouldPatch?: (params: {
      /** Model selected for the stream call. */
      model: Parameters<StreamFn>[0];
      /** Stream context passed by the runtime. */
      context: Parameters<StreamFn>[1];
      /** Stream options passed by the runtime. */
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

/**
 * Applies explicit disabled-thinking intent to OpenAI-compatible Chat
 * Completions payloads without changing enabled reasoning levels.
 */
export function createOpenAICompatibleCompletionsThinkingOffWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  if (thinkingLevel !== "off") {
    return underlying;
  }
  return (model, context, options) => {
    if (model.api !== "openai-completions") {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      if (!("reasoning_effort" in payload)) {
        return;
      }
      const disabled = resolveOpenAIReasoningEffortForModel({
        model,
        effort: "none",
        fallbackMap: resolveOpenAIReasoningEffortMap({
          provider: typeof model.provider === "string" ? model.provider : null,
          id: typeof model.id === "string" ? model.id : null,
          compat: model.compat,
        }),
      });
      if (disabled) {
        payload.reasoning_effort = disabled;
      } else {
        delete payload.reasoning_effort;
      }
    });
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

/** Applies the shared reasoning payload policy used by OpenAI-compatible proxy providers. */
export function normalizeOpenAICompatibleReasoningPayload(
  payload: Record<string, unknown>,
  thinkingLevel?: ThinkLevel,
): void {
  delete payload.reasoning_effort;
  if (!thinkingLevel || thinkingLevel === "off") {
    return;
  }

  const existingReasoning = payload.reasoning;
  if (
    existingReasoning &&
    typeof existingReasoning === "object" &&
    !Array.isArray(existingReasoning)
  ) {
    const reasoning = existingReasoning as Record<string, unknown>;
    if (!("max_tokens" in reasoning) && !("effort" in reasoning)) {
      reasoning.effort = mapThinkingLevelToReasoningEffort(thinkingLevel);
    }
  } else if (!existingReasoning) {
    payload.reasoning = {
      effort: mapThinkingLevelToReasoningEffort(thinkingLevel),
    };
  }
}

/** Applies Qwen chat-template thinking flags without discarding provider-specific kwargs. */
export function setQwenChatTemplateThinking(
  payload: Record<string, unknown>,
  enabled: boolean,
): void {
  const existing = payload.chat_template_kwargs;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const next: Record<string, unknown> = {
      ...(existing as Record<string, unknown>),
      enable_thinking: enabled,
    };
    if (!Object.hasOwn(next, "preserve_thinking")) {
      next.preserve_thinking = true;
    }
    payload.chat_template_kwargs = next;
    return;
  }
  payload.chat_template_kwargs = {
    enable_thinking: enabled,
    preserve_thinking: true,
  };
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

/**
 * Maps legacy numeric/semantic thinking input onto Gemini 3's provider enum.
 * @deprecated Google provider-owned stream helper; do not use from third-party plugins.
 */
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

/**
 * Removes `thinkingBudget=0` only for Gemini models that reject disabled thinking.
 * @deprecated Google provider-owned stream helper; do not use from third-party plugins.
 */
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

/**
 * Normalizes Google thinking config across SDK payload shapes before provider transport.
 * @deprecated Google provider-owned stream helper; do not use from third-party plugins.
 */
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
    // Gemma 4 accepts thinkingLevel but not thinkingBudget; map legacy budget
    // inputs before deleting the unsupported numeric field.
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
    // Gemini 3 adaptive mode means omit both controls so the provider chooses.
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
      // Gemini 3 uses thinkingLevel; leaving thinkingBudget would make mixed-mode payloads.
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
