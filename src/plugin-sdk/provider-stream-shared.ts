import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { streamWithPayloadPatch } from "../agents/pi-embedded-runner/stream-payload-utils.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { ProviderWrapStreamFnContext } from "./plugin-entry.js";

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

const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#\d+);/i;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

export function decodeHtmlEntitiesInObject(value: unknown): unknown {
  if (typeof value === "string") {
    return HTML_ENTITY_RE.test(value) ? decodeHtmlEntities(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeHtmlEntitiesInObject);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = decodeHtmlEntitiesInObject(entry);
    }
    return result;
  }
  return value;
}

function decodeToolCallArgumentsHtmlEntitiesInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    if (typedBlock.type !== "toolCall" || !typedBlock.arguments) {
      continue;
    }
    if (typeof typedBlock.arguments === "object") {
      typedBlock.arguments = decodeHtmlEntitiesInObject(typedBlock.arguments);
    }
  }
}

function wrapStreamDecodeToolCallArgumentHtmlEntities(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    decodeToolCallArgumentsHtmlEntitiesInMessage(message);
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
            decodeToolCallArgumentsHtmlEntitiesInMessage(event.partial);
            decodeToolCallArgumentsHtmlEntitiesInMessage(event.message);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };
  return stream;
}

export function createHtmlEntityToolCallArgumentDecodingWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const maybeStream = underlying(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamDecodeToolCallArgumentHtmlEntities(stream),
      );
    }
    return wrapStreamDecodeToolCallArgumentHtmlEntities(maybeStream);
  };
}

export function createPayloadPatchStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  patchPayload: (params: {
    payload: Record<string, unknown>;
    model: Parameters<StreamFn>[0];
  }) => void,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payload) =>
      patchPayload({ payload, model }),
    );
}

export type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
export type GoogleThinkingInputLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "adaptive"
  | "high"
  | "xhigh";

// Gemini 2.5 Pro only works in thinking mode and rejects thinkingBudget=0 with
// "Budget 0 is invalid. This model only works in thinking mode."
export function isGoogleThinkingRequiredModel(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).includes("gemini-2.5-pro");
}

export function isGoogleGemini3ProModel(modelId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return /(?:^|\/)gemini-(?:3(?:\.\d+)?-pro|pro-latest)(?:-|$)/.test(normalized);
}

export function isGoogleGemini3FlashModel(modelId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return /(?:^|\/)gemini-(?:3(?:\.\d+)?-flash|flash(?:-lite)?-latest)(?:-|$)/.test(normalized);
}

export function isGoogleGemini3ThinkingLevelModel(modelId: string): boolean {
  return isGoogleGemini3ProModel(modelId) || isGoogleGemini3FlashModel(modelId);
}

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
      case "adaptive":
      case "high":
      case "xhigh":
        return "HIGH";
    }
    if (typeof params.thinkingBudget === "number") {
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
    case "adaptive":
      return "MEDIUM";
    case "high":
    case "xhigh":
      return "HIGH";
  }
  if (typeof params.thinkingBudget !== "number") {
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

  // pi-ai can emit thinkingBudget=-1 for some Google model IDs; a negative budget
  // is invalid for Google-compatible backends and can lead to malformed handling.
  delete thinkingConfigObj.thinkingBudget;
  if (Object.keys(thinkingConfigObj).length === 0) {
    delete configObj.thinkingConfig;
  }
}

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

export function createGoogleThinkingStreamWrapper(
  ctx: ProviderWrapStreamFnContext,
): NonNullable<ProviderWrapStreamFnContext["streamFn"]> {
  return createGoogleThinkingPayloadWrapper(ctx.streamFn, ctx.thinkingLevel);
}

export {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "../agents/anthropic-payload-policy.js";
export {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
} from "../agents/copilot-dynamic-headers.js";
export { applyAnthropicEphemeralCacheControlMarkers } from "../agents/pi-embedded-runner/anthropic-cache-control-payload.js";
export {
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
} from "../agents/pi-embedded-runner/bedrock-stream-wrappers.js";
export {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
export { streamWithPayloadPatch };
export {
  createToolStreamWrapper,
  createZaiToolStreamWrapper,
} from "../agents/pi-embedded-runner/zai-stream-wrappers.js";
