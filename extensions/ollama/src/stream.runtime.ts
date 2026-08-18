// Ollama stream runtime implements native transport behavior.
import { randomUUID } from "node:crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  parseJsonObjectPreservingUnsafeIntegers,
  parseJsonPreservingUnsafeIntegers,
} from "openclaw/plugin-sdk/json-unsafe-integers";
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  Tool,
  Usage,
} from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import { createPlainTextToolCallCompatWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { notifyProviderHttpResponse } from "openclaw/plugin-sdk/provider-transport-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { estimateStringChars, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { OLLAMA_CLOUD_BASE_URL, OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import { normalizeOllamaWireModelId } from "./model-id.js";
import { buildOllamaBaseUrlSsrFPolicy, isOllamaCloudModel } from "./provider-models.js";
import {
  createOllamaVisibleContentSanitizer,
  sanitizeOllamaFinalVisibleContent,
} from "./sanitizers/visible-content.js";
import {
  type OllamaThinkValue,
  resolveOllamaConfiguredNumCtx,
  resolveOllamaThinkParamValue,
  supportsNativeOllamaMax,
  shouldForwardNativeOllamaThink,
} from "./stream-compat.js";
import { OLLAMA_INCOMPLETE_STREAM_ERROR } from "./stream-contract.js";
import { checkNdjsonRecordCap } from "./stream-ndjson-cap.js";

export {
  createConfiguredOllamaCompatStreamWrapper,
  isOllamaCompatProvider,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "./stream-compat.js";

const log = createSubsystemLogger("ollama-stream");

export const OLLAMA_NATIVE_BASE_URL = OLLAMA_DEFAULT_BASE_URL;

const OLLAMA_STREAM_COOPERATIVE_YIELD_INTERVAL_MS = 12;
const OLLAMA_STREAM_COOPERATIVE_YIELD_MAX_EVENTS = 64;
const OLLAMA_STREAM_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const GARBLED_VISIBLE_TEXT_MODEL_RE = /\b(?:glm|kimi)\b/i;
const GARBLED_VISIBLE_TEXT_MIN_CHARS = 80;
const GARBLED_VISIBLE_TEXT_SYMBOL_RE = /[$#%&="'_~`^|\\/*+\-[\]{}()<>:;,.!?]/gu;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/gu;

type OllamaStreamCooperativeScheduler = {
  afterEvent: () => Promise<void>;
};

function throwIfOllamaStreamAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Request was aborted");
  }
}

function createOllamaStreamCooperativeScheduler(
  signal?: AbortSignal,
): OllamaStreamCooperativeScheduler {
  let lastYieldedAt = Date.now();
  let eventsSinceYield = 0;
  return {
    async afterEvent() {
      throwIfOllamaStreamAborted(signal);
      eventsSinceYield += 1;
      const now = Date.now();
      if (
        eventsSinceYield < OLLAMA_STREAM_COOPERATIVE_YIELD_MAX_EVENTS &&
        now - lastYieldedAt < OLLAMA_STREAM_COOPERATIVE_YIELD_INTERVAL_MS
      ) {
        return;
      }
      eventsSinceYield = 0;
      lastYieldedAt = now;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      throwIfOllamaStreamAborted(signal);
    },
  };
}

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  return Array.from(text.matchAll(re)).length;
}

function maxCharacterFrequency(text: string): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const char of text) {
    const count = (counts.get(char) ?? 0) + 1;
    counts.set(char, count);
    max = Math.max(max, count);
  }
  return max;
}

function isKnownOllamaGarbledVisibleTextModel(modelId: string): boolean {
  return GARBLED_VISIBLE_TEXT_MODEL_RE.test(modelId);
}

function isLikelyGarbledVisibleText(params: { text: string; modelId: string }): boolean {
  if (!isKnownOllamaGarbledVisibleTextModel(params.modelId)) {
    return false;
  }
  const compact = params.text.replace(/\s+/g, "");
  if (compact.length < GARBLED_VISIBLE_TEXT_MIN_CHARS) {
    return false;
  }

  const letterOrDigitCount = countMatches(compact, LETTER_OR_DIGIT_RE);
  const symbolCount = countMatches(compact, GARBLED_VISIBLE_TEXT_SYMBOL_RE);
  const maxFrequency = maxCharacterFrequency(compact);
  const letterOrDigitRatio = letterOrDigitCount / compact.length;
  const symbolRatio = symbolCount / compact.length;
  const dominantCharacterRatio = maxFrequency / compact.length;

  return (
    letterOrDigitRatio < 0.08 &&
    symbolRatio > 0.6 &&
    (dominantCharacterRatio > 0.22 || /[$#%&="'_~`^|\\/*+\-[\]{}()<>:;,.!?]{12,}/u.test(compact))
  );
}

export function resolveOllamaBaseUrlForRun(params: {
  modelBaseUrl?: string;
  providerBaseUrl?: string;
}): string {
  const providerBaseUrl = params.providerBaseUrl?.trim();
  if (providerBaseUrl) {
    return providerBaseUrl;
  }
  const modelBaseUrl = params.modelBaseUrl?.trim();
  if (modelBaseUrl) {
    return modelBaseUrl;
  }
  return OLLAMA_NATIVE_BASE_URL;
}

const OLLAMA_OPTION_PARAM_KEYS = new Set([
  "num_keep",
  "seed",
  "num_predict",
  "top_k",
  "top_p",
  "min_p",
  "typical_p",
  "repeat_last_n",
  "temperature",
  "repeat_penalty",
  "presence_penalty",
  "frequency_penalty",
  "stop",
  "num_ctx",
  "num_batch",
  "num_gpu",
  "main_gpu",
  "use_mmap",
  "num_thread",
]);

const OLLAMA_TOP_LEVEL_PARAM_KEYS = new Set(["format", "keep_alive", "truncate", "shift"]);

/**
 * Resolves num_ctx for native /api/chat requests:
 *  1. explicit `params.num_ctx` set on the model wins,
 *  2. the effective `contextTokens` runtime cap is forwarded when present,
 *  3. otherwise Ollama's model, OLLAMA_CONTEXT_LENGTH, VRAM, or Modelfile policy decides.
 *
 * This intentionally differs from the OpenAI-compat resolver by not falling back
 * to a default context size: that fallback is a sane wrapper-side guess for
 * the OpenAI-compat path, but native `/api/chat` should not force the full
 * advertised `contextWindow`; only an explicit runtime cap or operator override is forwarded.
 */
function resolveOllamaNativeNumCtx(model: ProviderRuntimeModel): number | undefined {
  const configured = resolveOllamaConfiguredNumCtx(model);
  if (configured !== undefined) {
    return configured;
  }
  const effective = model.contextTokens;
  if (typeof effective !== "number" || !Number.isFinite(effective) || effective <= 0) {
    return undefined;
  }
  return Math.floor(effective);
}

function resolveOllamaModelOptions(model: ProviderRuntimeModel): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const params = model.params;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    for (const [key, value] of Object.entries(params)) {
      if (key === "num_ctx") {
        continue;
      }
      if (value !== undefined && OLLAMA_OPTION_PARAM_KEYS.has(key)) {
        options[key] = value;
      }
    }
  }
  const numCtx = resolveOllamaNativeNumCtx(model);
  if (numCtx !== undefined) {
    options.num_ctx = numCtx;
  }
  return options;
}

function normalizeOllamaGreedySamplingOptions(options: Record<string, unknown>): void {
  if (options.temperature !== 0) {
    return;
  }
  if (
    options.top_p === undefined ||
    (typeof options.top_p === "number" && Number.isFinite(options.top_p) && options.top_p !== 1)
  ) {
    options.top_p = 1;
  }
}

function resolveOllamaTopLevelParams(
  model: ProviderRuntimeModel,
): Record<string, unknown> | undefined {
  const requestParams: Record<string, unknown> = {};
  const params = model.params;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && OLLAMA_TOP_LEVEL_PARAM_KEYS.has(key)) {
        requestParams[key] = value;
      }
    }
  }
  const think = resolveOllamaThinkParamValue(params, supportsNativeOllamaMax(model));
  if (think !== undefined && shouldForwardNativeOllamaThink(model, think)) {
    requestParams.think = think;
  }
  return Object.keys(requestParams).length > 0 ? requestParams : undefined;
}

function resolveStreamingTextDelta(previousText: string, nextText: string): string {
  if (!nextText) {
    return "";
  }
  if (!previousText) {
    return nextText;
  }
  if (nextText.startsWith(previousText)) {
    return nextText.slice(previousText.length);
  }
  // Sanitizers may rewrite previously accumulated content. Fall back to
  // re-emitting the latest complete text so downstream partial state converges.
  return nextText;
}

export function buildOllamaChatRequest(params: {
  modelId: string;
  providerId?: string;
  messages: OllamaChatMessage[];
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
  requestParams?: Record<string, unknown>;
  stream?: boolean;
}): OllamaChatRequest {
  return {
    model: normalizeOllamaWireModelId(params.modelId, params.providerId),
    messages: params.messages,
    stream: params.stream ?? true,
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    ...(params.options ? { options: params.options } : {}),
    ...params.requestParams,
  };
}

function resolveOllamaResponseFormat(
  responseFormat: Record<string, unknown> | undefined,
  params: { baseUrl: string; modelId: string },
): "json" | Record<string, unknown> | undefined {
  if (
    !responseFormat ||
    isOllamaCloudModel(params.modelId) ||
    isOllamaCloudBaseUrl(params.baseUrl)
  ) {
    return undefined;
  }
  if (responseFormat.type === "json_object") {
    return "json";
  }
  if (responseFormat.type === "text") {
    return undefined;
  }
  if (responseFormat.type === "json_schema" && isRecord(responseFormat.json_schema)) {
    const schema = responseFormat.json_schema.schema;
    return isRecord(schema) ? schema : undefined;
  }
  return responseFormat;
}

function isOllamaCloudBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === OLLAMA_CLOUD_BASE_URL;
  } catch {
    return false;
  }
}

type StreamModelDescriptor = {
  api: string;
  provider: string;
  id: string;
  reasoning?: boolean;
};

type OllamaUsageFallback = {
  input?: number;
  output?: number;
};

const CHARS_PER_TOKEN_ESTIMATE = 4;

function buildUsageWithNoCost(params: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheTelemetry?: Usage["cacheTelemetry"];
  totalTokens?: number;
}): Usage {
  const input = params.input ?? 0;
  const output = params.output ?? 0;
  const cacheRead = params.cacheRead ?? 0;
  const cacheWrite = params.cacheWrite ?? 0;
  const cacheTelemetry =
    params.cacheTelemetry ??
    (params.cacheRead !== undefined && params.cacheWrite !== undefined
      ? { state: "available" as const }
      : { state: "unavailable" as const });
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheTelemetry,
    totalTokens: params.totalTokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function buildStreamAssistantMessage(params: {
  model: StreamModelDescriptor;
  content: AssistantMessage["content"];
  stopReason: StopReason;
  usage: Usage;
  timestamp?: number;
}): AssistantMessage {
  return {
    role: "assistant",
    content: params.content,
    stopReason: params.stopReason,
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: params.usage,
    timestamp: params.timestamp ?? Date.now(),
  };
}

function buildStreamErrorAssistantMessage(params: {
  model: StreamModelDescriptor;
  stopReason: Extract<StopReason, "aborted" | "error">;
  errorMessage: string;
  timestamp?: number;
}): AssistantMessage & {
  stopReason: Extract<StopReason, "aborted" | "error">;
  errorMessage: string;
} {
  return {
    ...buildStreamAssistantMessage({
      model: params.model,
      content: [],
      stopReason: params.stopReason,
      usage: buildUsageWithNoCost({}),
      timestamp: params.timestamp,
    }),
    stopReason: params.stopReason,
    errorMessage: params.errorMessage,
  };
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
  think?: OllamaThinkValue;
  format?: "json" | Record<string, unknown>;
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: "assistant";
    content: string;
    thinking?: string;
    reasoning?: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

function safeJsonLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? estimateStringChars(serialized) : 0;
  } catch {
    return 0;
  }
}

function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) {
    return 0;
  }
  return Math.max(1, Math.round(chars / CHARS_PER_TOKEN_ESTIMATE));
}

function resolveOllamaStopReason(response: OllamaChatResponse) {
  // Ollama's length terminal means generation hit its token limit, even when
  // the partial response already contains a complete-looking tool call.
  if (response.done_reason === "length") {
    return "length" as const;
  }
  if (response.message.tool_calls?.length) {
    return "toolUse" as const;
  }
  return "stop" as const;
}

function estimateOllamaPromptTokens(params: {
  messages: OllamaChatMessage[];
  tools: OllamaTool[];
}): number {
  let chars = 0;
  for (const message of params.messages) {
    chars += estimateStringChars(message.content);
    chars += safeJsonLength(message.images);
    chars += safeJsonLength(message.tool_calls);
    chars += message.tool_name ? estimateStringChars(message.tool_name) : 0;
  }
  chars += safeJsonLength(params.tools);
  return estimateTokensFromChars(chars);
}

function estimateOllamaCompletionTokens(
  response: OllamaChatResponse,
  extraOutputChars = 0,
): number {
  const chars =
    extraOutputChars +
    estimateStringChars(response.message.content) +
    (response.message.thinking ? estimateStringChars(response.message.thinking) : 0) +
    (response.message.reasoning ? estimateStringChars(response.message.reasoning) : 0) +
    safeJsonLength(response.message.tool_calls);
  return estimateTokensFromChars(chars);
}

function resolveUsageCount(value: number | undefined, fallback: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }
  return 0;
}

type InputContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as InputContentPart[])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function extractOllamaImages(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as InputContentPart[])
    .filter((part): part is { type: "image"; data: string } => part.type === "image")
    .map((part) => part.data);
}

function ensureArgsObject(value: unknown): Record<string, unknown> {
  return parseJsonObjectPreservingUnsafeIntegers(value) ?? {};
}

function normalizeOllamaToolCallArguments(value: unknown): Record<string, unknown> {
  return ensureArgsObject(value);
}

function inferOllamaSchemaType(schema: Record<string, unknown>): string | undefined {
  if (schema.properties && isRecord(schema.properties)) {
    return "object";
  }
  if (schema.items) {
    return "array";
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.filter((value) => value !== null);
    if (values.length > 0 && values.every((value) => typeof value === "string")) {
      return "string";
    }
    if (values.length > 0 && values.every((value) => typeof value === "number")) {
      return "number";
    }
    if (values.length > 0 && values.every((value) => typeof value === "boolean")) {
      return "boolean";
    }
  }
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const variants = schema[unionKey];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      if (!isRecord(variant)) {
        continue;
      }
      const variantType = variant.type;
      if (typeof variantType === "string" && variantType !== "null") {
        return variantType;
      }
      if (Array.isArray(variantType)) {
        const firstType = variantType.find(
          (entry): entry is string => typeof entry === "string" && entry !== "null",
        );
        if (firstType) {
          return firstType;
        }
      }
      const inferred = inferOllamaSchemaType(variant);
      if (inferred) {
        return inferred;
      }
    }
  }
  return undefined;
}

function normalizeOllamaToolSchema(schema: unknown, isRoot = false): Record<string, unknown> {
  if (!isRecord(schema)) {
    return {
      type: "object",
      properties: {},
    };
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isRecord(value)) {
      normalized.properties = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [
          propertyName,
          normalizeOllamaToolSchema(propertySchema),
        ]),
      );
      continue;
    }
    if (key === "items") {
      normalized.items = Array.isArray(value)
        ? value.map((entry) => normalizeOllamaToolSchema(entry))
        : normalizeOllamaToolSchema(value);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      normalized[key] = value.map((entry) => normalizeOllamaToolSchema(entry));
      continue;
    }
    normalized[key] = value;
  }

  const schemaType = normalized.type;
  if (
    typeof schemaType !== "string" &&
    (!Array.isArray(schemaType) ||
      !schemaType.some((entry) => typeof entry === "string" && entry !== "null"))
  ) {
    normalized.type = inferOllamaSchemaType(normalized) ?? (isRoot ? "object" : "string");
  }
  if (normalized.type === "object" && !isRecord(normalized.properties)) {
    normalized.properties = {};
  }
  return normalized;
}

type OllamaToolCallNameOptions = {
  availableToolNames?: ReadonlySet<string>;
};

type OllamaAssistantMessageBuildOptions = OllamaToolCallNameOptions & {
  sanitizeVisibleContent?: boolean;
};

function readOllamaToolCallId(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function extractToolCalls(
  content: unknown,
  options: OllamaToolCallNameOptions = {},
): OllamaToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts = content as InputContentPart[];
  const result: OllamaToolCall[] = [];
  for (const part of parts) {
    if (part.type === "toolCall") {
      const id = readOllamaToolCallId(part.id);
      result.push({
        ...(id ? { id } : {}),
        function: {
          name: normalizeOllamaToolCallName(part.name, options),
          arguments: ensureArgsObject(part.arguments),
        },
      });
    } else if (part.type === "tool_use") {
      const id = readOllamaToolCallId(part.id);
      result.push({
        ...(id ? { id } : {}),
        function: {
          name: normalizeOllamaToolCallName(part.name, options),
          arguments: ensureArgsObject(part.input),
        },
      });
    }
  }
  return result;
}

function buildOllamaToolNameSet(tools: Tool[] | undefined): ReadonlySet<string> | undefined {
  if (!tools || !Array.isArray(tools)) {
    return undefined;
  }
  const names = new Set<string>();
  for (const tool of tools) {
    if (typeof tool.name === "string" && tool.name.trim()) {
      names.add(tool.name.trim());
    }
  }
  return names.size > 0 ? names : undefined;
}

function normalizeOllamaToolCallName(
  rawName: string,
  options: OllamaToolCallNameOptions = {},
): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return trimmed;
  }
  const availableToolNames = options.availableToolNames;
  if (availableToolNames?.has(trimmed)) {
    return trimmed;
  }

  const strippedAnySeparator = trimmed.replace(/^(?:functions?|tools?)[./_-]+/iu, "").trim();
  if (
    availableToolNames &&
    strippedAnySeparator !== trimmed &&
    availableToolNames.has(strippedAnySeparator)
  ) {
    return strippedAnySeparator;
  }
  if (availableToolNames) {
    return trimmed;
  }

  return trimmed.replace(/^(?:functions?|tools?)[./]+/iu, "").trim();
}

export function convertToOllamaMessages(
  messages: Array<{ role: string; content: unknown }>,
  system?: string,
  options: OllamaToolCallNameOptions = {},
): OllamaChatMessage[] {
  const result: OllamaChatMessage[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractTextContent(msg.content);
      const images = extractOllamaImages(msg.content);
      result.push({
        role: "user",
        content: text,
        ...(images.length > 0 ? { images } : {}),
      });
      continue;
    }

    if (msg.role === "assistant") {
      const text = extractTextContent(msg.content);
      const toolCalls = extractToolCalls(msg.content, options);
      result.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (msg.role === "tool" || msg.role === "toolResult") {
      const text = extractTextContent(msg.content);
      const toolName =
        typeof (msg as { toolName?: unknown }).toolName === "string"
          ? (msg as { toolName?: string }).toolName
          : undefined;
      result.push({
        role: "tool",
        content: text,
        ...(toolName ? { tool_name: toolName } : {}),
      });
    }
  }

  return result;
}

function extractOllamaTools(tools: Tool[] | undefined): OllamaTool[] {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }
  const result: OllamaTool[] = [];
  for (const tool of tools) {
    if (typeof tool.name !== "string" || !tool.name) {
      continue;
    }
    result.push({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: normalizeOllamaToolSchema(tool.parameters, true),
      },
    });
  }
  return result;
}

export function buildAssistantMessage(
  response: OllamaChatResponse,
  modelInfo: StreamModelDescriptor,
  usageFallback?: OllamaUsageFallback,
  options: OllamaAssistantMessageBuildOptions = {},
): AssistantMessage {
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  const thinking =
    modelInfo.reasoning === false
      ? ""
      : (response.message.thinking ?? response.message.reasoning ?? "");
  if (thinking) {
    content.push({ type: "thinking", thinking });
  }
  const rawText = response.message.content || "";
  const text =
    options.sanitizeVisibleContent === false
      ? rawText
      : sanitizeOllamaFinalVisibleContent({
          modelId: modelInfo.id,
          text: rawText,
        });
  if (text) {
    content.push({ type: "text", text });
  }

  const toolCalls = response.message.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    for (const toolCall of toolCalls) {
      content.push({
        type: "toolCall",
        id: readOllamaToolCallId(toolCall.id) ?? `ollama_call_${randomUUID()}`,
        name: normalizeOllamaToolCallName(toolCall.function.name, options),
        arguments: normalizeOllamaToolCallArguments(toolCall.function.arguments),
      });
    }
  }

  return buildStreamAssistantMessage({
    model: modelInfo,
    content,
    stopReason: resolveOllamaStopReason(response),
    usage: buildUsageWithNoCost({
      input: resolveUsageCount(response.prompt_eval_count, usageFallback?.input),
      output: resolveUsageCount(response.eval_count, usageFallback?.output),
    }),
  });
}

export async function* parseNdjsonStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<OllamaChatResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingRecordBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      pendingRecordBytes = checkNdjsonRecordCap(value, pendingRecordBytes);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          yield parseJsonPreservingUnsafeIntegers(trimmed) as OllamaChatResponse;
        } catch {
          log.warn(`Skipping malformed NDJSON line: ${truncateUtf16Safe(trimmed, 120)}`);
        }
      }
    }

    if (buffer.trim()) {
      try {
        yield parseJsonPreservingUnsafeIntegers(buffer.trim()) as OllamaChatResponse;
      } catch {
        log.warn(`Skipping malformed trailing data: ${truncateUtf16Safe(buffer.trim(), 120)}`);
      }
    }
  } finally {
    // Start cancellation best-effort; do not await it — a pending cancel
    // must not stall releaseLock() and keep the reader locked.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function resolveOllamaChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const normalizedBase = trimmed.replace(/\/v1$/i, "");
  return `${normalizedBase || OLLAMA_NATIVE_BASE_URL}/api/chat`;
}

function resolveOllamaModelHeaders(model: {
  headers?: unknown;
}): Record<string, string> | undefined {
  if (!model.headers || typeof model.headers !== "object" || Array.isArray(model.headers)) {
    return undefined;
  }
  return model.headers as Record<string, string>;
}

function resolveOllamaRequestTimeoutMs(
  model: object,
  options: { requestTimeoutMs?: unknown; timeoutMs?: unknown } | undefined,
): number | undefined {
  const raw =
    options?.requestTimeoutMs ??
    options?.timeoutMs ??
    (model as { requestTimeoutMs?: unknown }).requestTimeoutMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

function createRawOllamaStreamFn(
  baseUrl: string,
  defaultHeaders?: Record<string, string>,
): StreamFn {
  const chatUrl = resolveOllamaChatUrl(baseUrl);
  const ssrfPolicy = buildOllamaBaseUrlSsrFPolicy(chatUrl);

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const availableToolNames = buildOllamaToolNameSet(context.tools);
        const toolCallNameOptions: OllamaToolCallNameOptions = availableToolNames
          ? { availableToolNames }
          : {};
        const ollamaMessages = convertToOllamaMessages(
          context.messages ?? [],
          context.systemPrompt,
          toolCallNameOptions,
        );
        const ollamaTools = extractOllamaTools(context.tools);

        const ollamaOptions: Record<string, unknown> = resolveOllamaModelOptions(model);
        if (typeof options?.temperature === "number") {
          ollamaOptions.temperature = options.temperature;
        }
        if (typeof options?.maxTokens === "number") {
          ollamaOptions.num_predict = options.maxTokens;
        }
        if (options?.stop && options.stop.length > 0) {
          ollamaOptions.stop = options.stop;
        }
        normalizeOllamaGreedySamplingOptions(ollamaOptions);

        // Structured-output grammars constrain the same token stream as tool
        // calls. Keep tool-enabled turns capable by letting tools win.
        const responseFormat =
          ollamaTools.length > 0
            ? undefined
            : resolveOllamaResponseFormat(options?.responseFormat, {
                baseUrl,
                modelId: model.id,
              });
        const requestParams = {
          ...resolveOllamaTopLevelParams(model),
          ...(responseFormat !== undefined ? { format: responseFormat } : {}),
        };

        const body = buildOllamaChatRequest({
          modelId: model.id,
          providerId: model.provider,
          messages: ollamaMessages,
          stream: true,
          tools: ollamaTools,
          options: ollamaOptions,
          requestParams,
        });
        const replacement = await options?.onPayload?.(body, model);
        const requestBody = replacement === undefined ? body : replacement;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...defaultHeaders,
          ...options?.headers,
        };
        if (
          options?.apiKey &&
          (!headers.Authorization || !isNonSecretApiKeyMarker(options.apiKey))
        ) {
          headers.Authorization = `Bearer ${options.apiKey}`;
        }

        const { response, release, refreshTimeout } = await fetchWithSsrFGuard({
          url: chatUrl,
          init: {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
          },
          policy: ssrfPolicy,
          ...(options?.signal ? { signal: options.signal } : {}),
          timeoutMs: resolveOllamaRequestTimeoutMs(
            model,
            options as { requestTimeoutMs?: unknown; timeoutMs?: unknown } | undefined,
          ),
          auditContext: "ollama-stream.chat",
        });

        try {
          await notifyProviderHttpResponse({ options, response, model });
          if (!response.ok) {
            const errorText = await readResponseTextLimited(
              response,
              OLLAMA_STREAM_ERROR_BODY_LIMIT_BYTES,
            ).catch(() => "unknown error");
            throw new Error(`${response.status} ${errorText}`);
          }
          if (!response.body) {
            throw new Error("Ollama API returned empty response body");
          }

          const reader = response.body.getReader();
          let accumulatedRawContent = "";
          let accumulatedVisibleContent = "";
          let accumulatedThinking = "";
          let suppressedThinking = "";
          const accumulatedToolCalls: OllamaToolCall[] = [];
          const streamedToolCalls: ToolCall[] = [];
          let finalResponse: OllamaChatResponse | undefined;
          let pendingFinalVisibleContent: string | undefined;
          const modelInfo = {
            api: model.api,
            provider: model.provider,
            id: model.id,
            reasoning: model.reasoning,
          };
          const shouldEmitThinking = model.reasoning ?? true;
          const visibleContentSanitizer = createOllamaVisibleContentSanitizer(model.id);
          const cooperativeScheduler = createOllamaStreamCooperativeScheduler(options?.signal);
          let streamStarted = false;
          let thinkingStarted = false;
          let thinkingEnded = false;
          let textBlockStarted = false;
          let textBlockClosed = false;
          const textContentIndex = () => (thinkingStarted ? 1 : 0);

          const buildCurrentContent = (): (TextContent | ThinkingContent | ToolCall)[] => {
            const parts: (TextContent | ThinkingContent | ToolCall)[] = [];
            if (accumulatedThinking) {
              parts.push({
                type: "thinking",
                thinking: accumulatedThinking,
              });
            }
            if (accumulatedVisibleContent) {
              parts.push({ type: "text", text: accumulatedVisibleContent });
            }
            parts.push(...streamedToolCalls);
            return parts;
          };

          const ensureStreamStarted = () => {
            if (streamStarted) {
              return;
            }
            streamStarted = true;
            const emptyPartial = buildStreamAssistantMessage({
              model: modelInfo,
              content: [],
              stopReason: "stop",
              usage: buildUsageWithNoCost({}),
            });
            stream.push({ type: "start", partial: emptyPartial });
          };

          const closeThinkingBlock = () => {
            if (!thinkingStarted || thinkingEnded) {
              return;
            }
            thinkingEnded = true;
            const partial = buildStreamAssistantMessage({
              model: modelInfo,
              content: buildCurrentContent(),
              stopReason: "stop",
              usage: buildUsageWithNoCost({}),
            });
            stream.push({
              type: "thinking_end",
              contentIndex: 0,
              content: accumulatedThinking,
              partial,
            });
          };

          const closeTextBlock = () => {
            if (!textBlockStarted || textBlockClosed) {
              return;
            }
            textBlockClosed = true;
            const partial = buildStreamAssistantMessage({
              model: modelInfo,
              content: buildCurrentContent(),
              stopReason: "stop",
              usage: buildUsageWithNoCost({}),
            });
            stream.push({
              type: "text_end",
              contentIndex: textContentIndex(),
              content: accumulatedVisibleContent,
              partial,
            });
          };

          const flushVisibleText = (nextVisibleContent: string | undefined) => {
            if (nextVisibleContent === undefined) {
              return;
            }
            const previousVisibleContent = accumulatedVisibleContent;
            const delta = resolveStreamingTextDelta(previousVisibleContent, nextVisibleContent);
            if (!delta) {
              return;
            }
            if (thinkingStarted && !thinkingEnded) {
              closeThinkingBlock();
            }

            ensureStreamStarted();
            if (!textBlockStarted) {
              textBlockStarted = true;
              const partial = buildStreamAssistantMessage({
                model: modelInfo,
                content: buildCurrentContent(),
                stopReason: "stop",
                usage: buildUsageWithNoCost({}),
              });
              stream.push({ type: "text_start", contentIndex: textContentIndex(), partial });
            }

            accumulatedVisibleContent = nextVisibleContent;
            stream.push({
              type: "text_delta",
              contentIndex: textContentIndex(),
              delta,
            });
          };

          const resolveVisibleContent = (final: boolean): string | undefined => {
            const resolution = visibleContentSanitizer.resolveStreamText({
              text: accumulatedRawContent,
              final,
            });
            if (resolution.kind === "pending") {
              return undefined;
            }
            return resolution.text;
          };

          for await (const chunk of parseNdjsonStream(reader)) {
            throwIfOllamaStreamAborted(options?.signal);
            // Keep guarded timeouts tied to stream progress so slow remote
            // inference is not aborted while Ollama is still emitting tokens.
            refreshTimeout?.();
            const thinkingDelta = chunk.message?.thinking ?? chunk.message?.reasoning;
            if (thinkingDelta && shouldEmitThinking) {
              ensureStreamStarted();
              if (!thinkingStarted) {
                thinkingStarted = true;
                const partial = buildStreamAssistantMessage({
                  model: modelInfo,
                  content: buildCurrentContent(),
                  stopReason: "stop",
                  usage: buildUsageWithNoCost({}),
                });
                stream.push({ type: "thinking_start", contentIndex: 0, partial });
              }
              accumulatedThinking += thinkingDelta;
              const partial = buildStreamAssistantMessage({
                model: modelInfo,
                content: buildCurrentContent(),
                stopReason: "stop",
                usage: buildUsageWithNoCost({}),
              });
              stream.push({
                type: "thinking_delta",
                contentIndex: 0,
                delta: thinkingDelta,
                partial,
              });
            }
            if (thinkingDelta && !shouldEmitThinking) {
              suppressedThinking += thinkingDelta;
            }

            if (chunk.message?.content) {
              const rawDelta = chunk.message.content;
              accumulatedRawContent += rawDelta;
              flushVisibleText(resolveVisibleContent(false));
            }
            if (chunk.message?.tool_calls?.length) {
              // Kimi holds short visible prefixes until a terminal boundary;
              // settle them now so later tool indices cannot overwrite text.
              flushVisibleText(resolveVisibleContent(true));
              closeThinkingBlock();
              closeTextBlock();
              for (const rawToolCall of chunk.message.tool_calls) {
                // Ollama can report a length stop in a later chunk, so no call
                // becomes executable until its authoritative terminal arrives.
                const id = readOllamaToolCallId(rawToolCall.id) ?? `ollama_call_${randomUUID()}`;
                accumulatedToolCalls.push({ ...rawToolCall, id });
              }
            }
            if (chunk.done) {
              pendingFinalVisibleContent = resolveVisibleContent(true);
              finalResponse = chunk;
              break;
            }
            await cooperativeScheduler.afterEvent();
          }

          if (!finalResponse) {
            throw new Error(OLLAMA_INCOMPLETE_STREAM_ERROR);
          }

          if (
            pendingFinalVisibleContent !== undefined &&
            isLikelyGarbledVisibleText({ text: pendingFinalVisibleContent, modelId: model.id })
          ) {
            throw new Error(
              `Ollama returned non-linguistic garbled visible text for ${model.id}; retry or switch models`,
            );
          }

          flushVisibleText(pendingFinalVisibleContent);

          if (isLikelyGarbledVisibleText({ text: accumulatedVisibleContent, modelId: model.id })) {
            throw new Error(
              `Ollama returned non-linguistic garbled visible text for ${model.id}; retry or switch models`,
            );
          }

          finalResponse.message.content = accumulatedVisibleContent;
          if (accumulatedThinking) {
            finalResponse.message.thinking = accumulatedThinking;
          }
          if (finalResponse.done_reason === "length") {
            // All consumers inspect terminal content, not only lifecycle events;
            // a token-limit stop must never retain an executable-looking call.
            delete finalResponse.message.tool_calls;
          } else if (accumulatedToolCalls.length > 0) {
            finalResponse.message.tool_calls = accumulatedToolCalls;
          }

          const usageFallback = {
            input: estimateOllamaPromptTokens({ messages: ollamaMessages, tools: ollamaTools }),
            output: estimateOllamaCompletionTokens(
              finalResponse,
              estimateStringChars(suppressedThinking),
            ),
          };
          const assistantMessage = buildAssistantMessage(finalResponse, modelInfo, usageFallback, {
            ...toolCallNameOptions,
            sanitizeVisibleContent: false,
          });
          closeThinkingBlock();
          closeTextBlock();

          const reason = resolveOllamaStopReason(finalResponse);
          if (reason === "toolUse") {
            for (const completedToolCall of assistantMessage.content) {
              if (completedToolCall.type !== "toolCall") {
                continue;
              }
              ensureStreamStarted();
              const placeholder: ToolCall = { ...completedToolCall, arguments: {} };
              streamedToolCalls.push(placeholder);
              const contentIndex = buildCurrentContent().length - 1;
              const partial = () =>
                buildStreamAssistantMessage({
                  model: modelInfo,
                  content: buildCurrentContent(),
                  stopReason: "stop",
                  usage: buildUsageWithNoCost({}),
                });
              stream.push({ type: "toolcall_start", contentIndex, partial: partial() });
              // Replace the placeholder instead of mutating it: queued start
              // snapshots must not see arguments before their delta arrives.
              streamedToolCalls[streamedToolCalls.length - 1] = completedToolCall;
              stream.push({
                type: "toolcall_delta",
                contentIndex,
                delta: JSON.stringify(completedToolCall.arguments),
                partial: partial(),
              });
              stream.push({
                type: "toolcall_end",
                contentIndex,
                toolCall: completedToolCall,
                partial: partial(),
              });
            }
          }

          stream.push({
            type: "done",
            reason,
            message: assistantMessage,
          });
        } finally {
          await release();
        }
      } catch (err) {
        const stopReason = options?.signal?.aborted ? "aborted" : "error";
        stream.push({
          type: "error",
          reason: stopReason,
          error: buildStreamErrorAssistantMessage({
            model,
            stopReason,
            errorMessage: formatErrorMessage(err),
          }),
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}

export function createOllamaStreamFn(
  baseUrl: string,
  defaultHeaders?: Record<string, string>,
): StreamFn {
  return createPlainTextToolCallCompatWrapper(createRawOllamaStreamFn(baseUrl, defaultHeaders));
}

export function createConfiguredOllamaStreamFn(params: {
  model: { baseUrl?: string; headers?: unknown };
  providerBaseUrl?: string;
}): StreamFn {
  return createOllamaStreamFn(
    resolveOllamaBaseUrlForRun({
      modelBaseUrl: readStringValue(params.model.baseUrl),
      providerBaseUrl: params.providerBaseUrl,
    }),
    resolveOllamaModelHeaders(params.model),
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
