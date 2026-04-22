import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  Tool,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, streamSimple } from "@mariozechner/pi-ai";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  OpenClawConfig,
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import {
  DEFAULT_CONTEXT_TOKENS,
  normalizeProviderId,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty, readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import {
  parseJsonObjectPreservingUnsafeIntegers,
  parseJsonPreservingUnsafeIntegers,
} from "./ollama-json.js";
import { buildOllamaBaseUrlSsrFPolicy } from "./provider-models.js";

const log = createSubsystemLogger("ollama-stream");

export const OLLAMA_NATIVE_BASE_URL = OLLAMA_DEFAULT_BASE_URL;

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

export function resolveConfiguredOllamaProviderConfig(params: {
  config?: OpenClawConfig;
  providerId?: string;
}) {
  const providerId = params.providerId?.trim();
  if (!providerId) {
    return undefined;
  }
  const providers = params.config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const direct = providers[providerId];
  if (direct) {
    return direct;
  }
  const normalized = normalizeProviderId(providerId);
  for (const [candidateId, candidate] of Object.entries(providers)) {
    if (normalizeProviderId(candidateId) === normalized) {
      return candidate;
    }
  }
  return undefined;
}

export function isOllamaCompatProvider(model: {
  provider?: string;
  baseUrl?: string;
  api?: string;
}): boolean {
  const providerId = normalizeProviderId(model.provider ?? "");
  if (providerId === "ollama") {
    return true;
  }
  if (!model.baseUrl) {
    return false;
  }
  try {
    const parsed = new URL(model.baseUrl);
    const hostname = normalizeLowercaseStringOrEmpty(parsed.hostname);
    const isLocalhost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
    if (isLocalhost && parsed.port === "11434") {
      return true;
    }

    // Allow remote/LAN Ollama OpenAI-compatible endpoints when the provider id
    // itself indicates Ollama usage (for example "my-ollama").
    const providerHintsOllama = providerId.includes("ollama");
    const isOllamaPort = parsed.port === "11434";
    const isOllamaCompatPath = parsed.pathname === "/" || /^\/v1\/?$/i.test(parsed.pathname);
    return providerHintsOllama && isOllamaPort && isOllamaCompatPath;
  } catch {
    return false;
  }
}

export function resolveOllamaCompatNumCtxEnabled(params: {
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  return resolveConfiguredOllamaProviderConfig(params)?.injectNumCtxForOpenAICompat ?? true;
}

export function shouldInjectOllamaCompatNumCtx(params: {
  model: { api?: string; provider?: string; baseUrl?: string };
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  if (params.model.api !== "openai-completions") {
    return false;
  }
  if (!isOllamaCompatProvider(params.model)) {
    return false;
  }
  return resolveOllamaCompatNumCtxEnabled({
    config: params.config,
    providerId: params.providerId,
  });
}

export function wrapOllamaCompatNumCtx(baseFn: StreamFn | undefined, numCtx: number): StreamFn {
  const streamFn = baseFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(streamFn, model, context, options, (payloadRecord) => {
      if (!payloadRecord.options || typeof payloadRecord.options !== "object") {
        payloadRecord.options = {};
      }
      (payloadRecord.options as Record<string, unknown>).num_ctx = numCtx;
      normalizeOllamaCompatMessageToolArgs(payloadRecord);
    });
}

function createOllamaThinkingWrapper(baseFn: StreamFn | undefined, think: boolean): StreamFn {
  const streamFn = baseFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(streamFn, model, context, options, (payloadRecord) => {
      payloadRecord.think = think;
    });
}

function resolveOllamaCompatNumCtx(model: ProviderRuntimeModel): number {
  return Math.max(1, Math.floor(model.contextWindow ?? model.maxTokens ?? DEFAULT_CONTEXT_TOKENS));
}

function isOllamaCloudKimiModelRef(modelId: string): boolean {
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  return normalizedModelId.startsWith("kimi-k") && normalizedModelId.includes(":cloud");
}

export function createConfiguredOllamaCompatStreamWrapper(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  let streamFn = ctx.streamFn;
  const model = ctx.model;
  let injectNumCtx = false;
  const isNativeOllamaTransport = model?.api === "ollama";

  if (model) {
    const providerId =
      typeof model.provider === "string" && model.provider.trim().length > 0
        ? model.provider
        : ctx.provider;
    if (
      shouldInjectOllamaCompatNumCtx({
        model,
        config: ctx.config,
        providerId,
      })
    ) {
      injectNumCtx = true;
    }
  }

  if (injectNumCtx && model) {
    streamFn = wrapOllamaCompatNumCtx(streamFn, resolveOllamaCompatNumCtx(model));
  }

  if (isNativeOllamaTransport && ctx.thinkingLevel === "off") {
    streamFn = createOllamaThinkingWrapper(streamFn, false);
  } else if (isNativeOllamaTransport && ctx.thinkingLevel) {
    // Any non-off ThinkLevel (minimal, low, medium, high, xhigh, adaptive, max)
    // should enable Ollama's native thinking mode.
    streamFn = createOllamaThinkingWrapper(streamFn, true);
  }

  if (normalizeProviderId(ctx.provider) === "ollama" && isOllamaCloudKimiModelRef(ctx.modelId)) {
    const thinkingType = resolveMoonshotThinkingType({
      configuredThinking: ctx.extraParams?.thinking,
      thinkingLevel: ctx.thinkingLevel,
    });
    streamFn = createMoonshotThinkingWrapper(streamFn, thinkingType);
  }

  return streamFn;
}

// Backward-compatible alias for existing imports/tests while the broader
// Ollama compat wrapper now owns more than num_ctx injection.
export const createConfiguredOllamaCompatNumCtxWrapper = createConfiguredOllamaCompatStreamWrapper;

function normalizeOllamaWireModelId(modelId: string): string {
  const trimmed = modelId.trim();
  return trimmed.startsWith("ollama/") ? trimmed.slice("ollama/".length) : trimmed;
}

export function buildOllamaChatRequest(params: {
  modelId: string;
  messages: OllamaChatMessage[];
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
  stream?: boolean;
}): OllamaChatRequest {
  return {
    model: normalizeOllamaWireModelId(params.modelId),
    messages: params.messages,
    stream: params.stream ?? true,
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    ...(params.options ? { options: params.options } : {}),
  };
}

type StreamModelDescriptor = {
  api: string;
  provider: string;
  id: string;
};

function buildUsageWithNoCost(params: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}): Usage {
  const input = params.input ?? 0;
  const output = params.output ?? 0;
  const cacheRead = params.cacheRead ?? 0;
  const cacheWrite = params.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
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
  errorMessage: string;
  timestamp?: number;
}): AssistantMessage & { stopReason: "error"; errorMessage: string } {
  return {
    ...buildStreamAssistantMessage({
      model: params.model,
      content: [],
      stopReason: "error",
      usage: buildUsageWithNoCost({}),
      timestamp: params.timestamp,
    }),
    stopReason: "error",
    errorMessage: params.errorMessage,
  };
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
  think?: boolean;
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
  function: {
    name: string;
    arguments: Record<string, unknown>;
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

function normalizeOllamaCompatMessageToolArgs(payloadRecord: Record<string, unknown>): void {
  const messages = payloadRecord.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const messageRecord = message as Record<string, unknown>;

    const functionCall = messageRecord.function_call;
    if (functionCall && typeof functionCall === "object" && !Array.isArray(functionCall)) {
      const functionCallRecord = functionCall as Record<string, unknown>;
      if (Object.hasOwn(functionCallRecord, "arguments")) {
        functionCallRecord.arguments = ensureArgsObject(functionCallRecord.arguments);
      }
    }

    const toolCalls = messageRecord.tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
        continue;
      }
      const functionSpec = (toolCall as Record<string, unknown>).function;
      if (!functionSpec || typeof functionSpec !== "object" || Array.isArray(functionSpec)) {
        continue;
      }
      const functionRecord = functionSpec as Record<string, unknown>;
      if (Object.hasOwn(functionRecord, "arguments")) {
        functionRecord.arguments = ensureArgsObject(functionRecord.arguments);
      }
    }
  }
}

function extractToolCalls(content: unknown): OllamaToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts = content as InputContentPart[];
  const result: OllamaToolCall[] = [];
  for (const part of parts) {
    if (part.type === "toolCall") {
      result.push({ function: { name: part.name, arguments: ensureArgsObject(part.arguments) } });
    } else if (part.type === "tool_use") {
      result.push({ function: { name: part.name, arguments: ensureArgsObject(part.input) } });
    }
  }
  return result;
}

export function convertToOllamaMessages(
  messages: Array<{ role: string; content: unknown }>,
  system?: string,
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
      const toolCalls = extractToolCalls(msg.content);
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
        parameters: (tool.parameters ?? {}) as Record<string, unknown>,
      },
    });
  }
  return result;
}

export function buildAssistantMessage(
  response: OllamaChatResponse,
  modelInfo: StreamModelDescriptor,
): AssistantMessage {
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  const thinking = response.message.thinking ?? response.message.reasoning ?? "";
  if (thinking) {
    content.push({ type: "thinking", thinking });
  }
  const text = response.message.content || "";
  if (text) {
    content.push({ type: "text", text });
  }

  const toolCalls = response.message.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    for (const toolCall of toolCalls) {
      content.push({
        type: "toolCall",
        id: `ollama_call_${randomUUID()}`,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }
  }

  return buildStreamAssistantMessage({
    model: modelInfo,
    content,
    stopReason: toolCalls && toolCalls.length > 0 ? "toolUse" : "stop",
    usage: buildUsageWithNoCost({
      input: response.prompt_eval_count ?? 0,
      output: response.eval_count ?? 0,
    }),
  });
}

export async function* parseNdjsonStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<OllamaChatResponse> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
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
        log.warn(`Skipping malformed NDJSON line: ${trimmed.slice(0, 120)}`);
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield parseJsonPreservingUnsafeIntegers(buffer.trim()) as OllamaChatResponse;
    } catch {
      log.warn(`Skipping malformed trailing data: ${buffer.trim().slice(0, 120)}`);
    }
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

export function createOllamaStreamFn(
  baseUrl: string,
  defaultHeaders?: Record<string, string>,
): StreamFn {
  const chatUrl = resolveOllamaChatUrl(baseUrl);
  const ssrfPolicy = buildOllamaBaseUrlSsrFPolicy(chatUrl);

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const ollamaMessages = convertToOllamaMessages(
          context.messages ?? [],
          context.systemPrompt,
        );
        const ollamaTools = extractOllamaTools(context.tools);

        const ollamaOptions: Record<string, unknown> = { num_ctx: model.contextWindow ?? 65536 };
        if (typeof options?.temperature === "number") {
          ollamaOptions.temperature = options.temperature;
        }
        if (typeof options?.maxTokens === "number") {
          ollamaOptions.num_predict = options.maxTokens;
        }

        const body = buildOllamaChatRequest({
          modelId: model.id,
          messages: ollamaMessages,
          stream: true,
          tools: ollamaTools,
          options: ollamaOptions,
        });
        options?.onPayload?.(body, model);
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

        const { response, release } = await fetchWithSsrFGuard({
          url: chatUrl,
          init: {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: options?.signal,
          },
          policy: ssrfPolicy,
          auditContext: "ollama-stream.chat",
        });

        try {
          if (!response.ok) {
            const errorText = await response.text().catch(() => "unknown error");
            throw new Error(`${response.status} ${errorText}`);
          }
          if (!response.body) {
            throw new Error("Ollama API returned empty response body");
          }

          const reader = response.body.getReader();
          let accumulatedContent = "";
          let accumulatedThinking = "";
          const accumulatedToolCalls: OllamaToolCall[] = [];
          let finalResponse: OllamaChatResponse | undefined;
          const modelInfo = { api: model.api, provider: model.provider, id: model.id };
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
            if (accumulatedContent) {
              parts.push({ type: "text", text: accumulatedContent });
            }
            return parts;
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
              content: accumulatedContent,
              partial,
            });
          };

          for await (const chunk of parseNdjsonStream(reader)) {
            const thinkingDelta = chunk.message?.thinking ?? chunk.message?.reasoning;
            if (thinkingDelta) {
              if (!streamStarted) {
                streamStarted = true;
                const emptyPartial = buildStreamAssistantMessage({
                  model: modelInfo,
                  content: [],
                  stopReason: "stop",
                  usage: buildUsageWithNoCost({}),
                });
                stream.push({ type: "start", partial: emptyPartial });
              }
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

            if (chunk.message?.content) {
              const delta = chunk.message.content;
              if (thinkingStarted && !thinkingEnded) {
                closeThinkingBlock();
              }

              if (!streamStarted) {
                streamStarted = true;
                const emptyPartial = buildStreamAssistantMessage({
                  model: modelInfo,
                  content: [],
                  stopReason: "stop",
                  usage: buildUsageWithNoCost({}),
                });
                stream.push({ type: "start", partial: emptyPartial });
              }
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

              accumulatedContent += delta;
              const partial = buildStreamAssistantMessage({
                model: modelInfo,
                content: buildCurrentContent(),
                stopReason: "stop",
                usage: buildUsageWithNoCost({}),
              });
              stream.push({
                type: "text_delta",
                contentIndex: textContentIndex(),
                delta,
                partial,
              });
            }
            if (chunk.message?.tool_calls) {
              closeThinkingBlock();
              closeTextBlock();
              accumulatedToolCalls.push(...chunk.message.tool_calls);
            }
            if (chunk.done) {
              finalResponse = chunk;
              break;
            }
          }

          if (!finalResponse) {
            throw new Error("Ollama API stream ended without a final response");
          }

          finalResponse.message.content = accumulatedContent;
          if (accumulatedThinking) {
            finalResponse.message.thinking = accumulatedThinking;
          }
          if (accumulatedToolCalls.length > 0) {
            finalResponse.message.tool_calls = accumulatedToolCalls;
          }

          const assistantMessage = buildAssistantMessage(finalResponse, modelInfo);
          closeThinkingBlock();
          closeTextBlock();

          stream.push({
            type: "done",
            reason: assistantMessage.stopReason === "toolUse" ? "toolUse" : "stop",
            message: assistantMessage,
          });
        } finally {
          await release();
        }
      } catch (err) {
        stream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({
            model,
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
