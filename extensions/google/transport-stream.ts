import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  calculateCost,
  getEnvApiKey,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "@mariozechner/pi-ai";
import { createProviderHttpError } from "openclaw/plugin-sdk/provider-http";
import {
  buildGuardedModelFetch,
  coerceTransportToolCallArguments,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeTransportPayloadText,
  stripSystemPromptCacheBoundary,
  transformTransportMessages,
  type WritableTransportStream,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { parseGeminiAuth } from "./gemini-auth.js";
import { normalizeGoogleApiBaseUrl } from "./provider-policy.js";
import {
  isGoogleGemini25ThinkingBudgetModel,
  isGoogleGemini3FlashModel,
  isGoogleGemini3ProModel,
  resolveGoogleGemini3ThinkingLevel,
  stripInvalidGoogleThinkingBudget,
  type GoogleThinkingInputLevel,
  type GoogleThinkingLevel,
} from "./thinking-api.js";
import {
  isGoogleVertexCredentialsMarker,
  resolveGoogleVertexAuthorizedUserHeaders,
} from "./vertex-adc.js";

type GoogleTransportApi = "google-generative-ai" | "google-vertex";

type GoogleTransportModel = Model<GoogleTransportApi> & {
  headers?: Record<string, string>;
  provider: string;
};

type GoogleTransportOptions = SimpleStreamOptions & {
  cachedContent?: string;
  toolChoice?:
    | "auto"
    | "none"
    | "any"
    | "required"
    | {
        type: "function";
        function: {
          name: string;
        };
      };
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    level?: GoogleThinkingLevel;
  };
};

type GoogleGenerateContentRequest = {
  cachedContent?: string;
  contents: Array<Record<string, unknown>>;
  generationConfig?: Record<string, unknown>;
  systemInstruction?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  toolConfig?: Record<string, unknown>;
};

type GoogleTransportContentBlock =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    };

type MutableAssistantOutput = {
  role: "assistant";
  content: Array<GoogleTransportContentBlock>;
  api: GoogleTransportApi;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
};

const GOOGLE_VERTEX_DEFAULT_API_VERSION = "v1";

type GoogleSseChunk = {
  responseId?: string;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        thoughtSignature?: string;
        functionCall?: {
          id?: string;
          name?: string;
          args?: Record<string, unknown>;
        };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
};

let toolCallCounter = 0;

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiresToolCallId(modelId: string): boolean {
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const match = normalizeLowercaseStringOrEmpty(modelId).match(/^gemini(?:-live)?-(\d+)/);
  if (!match) {
    return true;
  }
  return Number.parseInt(match[1] ?? "", 10) >= 3;
}

function retainThoughtSignature(existing: string | undefined, incoming: string | undefined) {
  if (typeof incoming === "string" && incoming.length > 0) {
    return incoming;
  }
  return existing;
}

function mapToolChoice(
  choice: GoogleTransportOptions["toolChoice"],
): { mode: "AUTO" | "NONE" | "ANY"; allowedFunctionNames?: string[] } | undefined {
  if (!choice) {
    return undefined;
  }
  if (typeof choice === "object" && choice.type === "function") {
    return { mode: "ANY", allowedFunctionNames: [choice.function.name] };
  }
  switch (choice) {
    case "none":
      return { mode: "NONE" };
    case "any":
    case "required":
      return { mode: "ANY" };
    default:
      return { mode: "AUTO" };
  }
}

function mapStopReasonString(reason: string): "stop" | "length" | "error" {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    default:
      return "error";
  }
}

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function resolveGoogleModelPath(modelId: string): string {
  if (modelId.startsWith("models/") || modelId.startsWith("tunedModels/")) {
    return modelId;
  }
  return `models/${modelId}`;
}

function buildGoogleGenerativeAiRequestUrl(model: GoogleTransportModel): string {
  const baseUrl = normalizeGoogleApiBaseUrl(model.baseUrl);
  return `${baseUrl}/${resolveGoogleModelPath(model.id)}:streamGenerateContent?alt=sse`;
}

function resolveGoogleVertexProject(options: GoogleTransportOptions | undefined): string {
  const project =
    normalizeOptionalString((options as { project?: unknown } | undefined)?.project) ||
    normalizeOptionalString(process.env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalString(process.env.GCLOUD_PROJECT);
  if (!project) {
    throw new Error(
      "Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
    );
  }
  return project;
}

function resolveGoogleVertexLocation(options: GoogleTransportOptions | undefined): string {
  const location =
    normalizeOptionalString((options as { location?: unknown } | undefined)?.location) ||
    normalizeOptionalString(process.env.GOOGLE_CLOUD_LOCATION);
  if (!location) {
    throw new Error(
      "Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.",
    );
  }
  return location;
}

function resolveGoogleVertexBaseOrigin(model: GoogleTransportModel, location: string): string {
  const configured = normalizeOptionalString(model.baseUrl);
  if (configured && !configured.includes("{location}")) {
    try {
      const url = new URL(configured);
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/u, "");
    } catch {
      return configured.replace(/\/+$/u, "");
    }
  }
  if (location === "global") {
    return "https://aiplatform.googleapis.com";
  }
  return `https://${location}-aiplatform.googleapis.com`;
}

function buildGoogleVertexRequestUrl(
  model: GoogleTransportModel,
  options: GoogleTransportOptions | undefined,
): string {
  const project = encodeURIComponent(resolveGoogleVertexProject(options));
  const location = encodeURIComponent(resolveGoogleVertexLocation(options));
  const modelId = encodeURIComponent(model.id);
  const origin = resolveGoogleVertexBaseOrigin(model, decodeURIComponent(location));
  return `${origin}/${GOOGLE_VERTEX_DEFAULT_API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${modelId}:streamGenerateContent?alt=sse`;
}

function resolveThinkingLevel(level: ThinkingLevel, modelId: string): GoogleThinkingLevel {
  const resolved = resolveGoogleGemini3ThinkingLevel({ modelId, thinkingLevel: level });
  if (resolved) {
    return resolved;
  }
  throw new Error("Unsupported thinking level");
}

function resolveExplicitThinkingLevel(
  level: GoogleThinkingLevel,
  modelId: string,
): GoogleThinkingLevel {
  return (
    resolveGoogleGemini3ThinkingLevel({
      modelId,
      thinkingLevel: level.toLowerCase() as GoogleThinkingInputLevel,
    }) ?? level
  );
}

function getDisabledThinkingConfig(modelId: string): Record<string, unknown> | undefined {
  const thinkingLevel = resolveGoogleGemini3ThinkingLevel({ modelId, thinkingLevel: "off" });
  if (thinkingLevel) {
    return { thinkingLevel };
  }
  return normalizeGoogleThinkingConfig(modelId, { thinkingBudget: 0 });
}

function getGoogleThinkingBudget(
  modelId: string,
  effort: ThinkingLevel,
  customBudgets?: GoogleTransportOptions["thinkingBudgets"],
): number | undefined {
  const normalizedEffort = effort === "xhigh" ? "high" : effort;
  if (customBudgets?.[normalizedEffort] !== undefined) {
    return customBudgets[normalizedEffort];
  }
  if (modelId.includes("2.5-pro")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 32768 }[normalizedEffort];
  }
  if (modelId.includes("2.5-flash")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 24576 }[normalizedEffort];
  }
  return undefined;
}

function isAdaptiveReasoningLevel(value: unknown): value is "adaptive" {
  return value === "adaptive";
}

function resolveGoogleThinkingConfig(
  model: GoogleTransportModel,
  options: GoogleTransportOptions | undefined,
): Record<string, unknown> | undefined {
  if (!model.reasoning) {
    return undefined;
  }
  if (options?.thinking) {
    if (!options.thinking.enabled) {
      return getDisabledThinkingConfig(model.id);
    }
    const config: Record<string, unknown> = { includeThoughts: true };
    if (options.thinking.level) {
      config.thinkingLevel = resolveExplicitThinkingLevel(options.thinking.level, model.id);
    } else if (typeof options.thinking.budgetTokens === "number") {
      const thinkingLevel = resolveGoogleGemini3ThinkingLevel({
        modelId: model.id,
        thinkingBudget: options.thinking.budgetTokens,
      });
      if (thinkingLevel) {
        config.thinkingLevel = thinkingLevel;
      } else {
        config.thinkingBudget = options.thinking.budgetTokens;
      }
    }
    return normalizeGoogleThinkingConfig(model.id, config);
  }
  if (!options?.reasoning) {
    return getDisabledThinkingConfig(model.id);
  }
  if (isAdaptiveReasoningLevel(options.reasoning)) {
    if (isGoogleGemini3ProModel(model.id) || isGoogleGemini3FlashModel(model.id)) {
      return { includeThoughts: true };
    }
    if (isGoogleGemini25ThinkingBudgetModel(model.id)) {
      return normalizeGoogleThinkingConfig(model.id, {
        includeThoughts: true,
        thinkingBudget: -1,
      });
    }
  }
  if (isGoogleGemini3ProModel(model.id) || isGoogleGemini3FlashModel(model.id)) {
    return {
      includeThoughts: true,
      thinkingLevel: resolveThinkingLevel(options.reasoning, model.id),
    };
  }
  const budget = getGoogleThinkingBudget(model.id, options.reasoning, options.thinkingBudgets);
  return normalizeGoogleThinkingConfig(model.id, {
    includeThoughts: true,
    ...(typeof budget === "number" ? { thinkingBudget: budget } : {}),
  });
}

function normalizeGoogleThinkingConfig(
  modelId: string,
  thinkingConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  stripInvalidGoogleThinkingBudget({ thinkingConfig, modelId });
  return Object.keys(thinkingConfig).length > 0 ? thinkingConfig : undefined;
}

function convertGoogleMessages(model: GoogleTransportModel, context: Context) {
  const contents: Array<Record<string, unknown>> = [];
  const transformedMessages = transformTransportMessages(context.messages, model, (id) =>
    requiresToolCallId(model.id) ? normalizeToolCallId(id) : id,
  );
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({
          role: "user",
          parts: [{ text: sanitizeTransportPayloadText(msg.content) || " " }],
        });
        continue;
      }
      const parts = msg.content
        .map((item) =>
          item.type === "text"
            ? { text: sanitizeTransportPayloadText(item.text) || " " }
            : {
                inlineData: {
                  mimeType: item.mimeType,
                  data: item.data,
                },
              },
        )
        .filter((item) => model.input.includes("image") || !("inlineData" in item));
      if (parts.length === 0) {
        parts.push({ text: " " });
      }
      contents.push({ role: "user", parts });
      continue;
    }

    if (msg.role === "assistant") {
      const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
      const parts: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (!block.text.trim()) {
            continue;
          }
          parts.push({
            text: sanitizeTransportPayloadText(block.text),
            ...(isSameProviderAndModel && block.textSignature
              ? { thoughtSignature: block.textSignature }
              : {}),
          });
          continue;
        }
        if (block.type === "thinking") {
          if (!block.thinking.trim()) {
            continue;
          }
          if (isSameProviderAndModel) {
            parts.push({
              thought: true,
              text: sanitizeTransportPayloadText(block.thinking),
              ...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
            });
          } else {
            parts.push({ text: sanitizeTransportPayloadText(block.thinking) });
          }
          continue;
        }
        if (block.type === "toolCall") {
          parts.push({
            functionCall: {
              name: block.name,
              args: coerceTransportToolCallArguments(block.arguments),
              ...(requiresToolCallId(model.id) ? { id: block.id } : {}),
            },
            ...(isSameProviderAndModel && block.thoughtSignature
              ? { thoughtSignature: block.thoughtSignature }
              : {}),
          });
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter(
          (item): item is Extract<(typeof msg.content)[number], { type: "text" }> =>
            item.type === "text",
        )
        .map((item) => item.text)
        .join("\n");
      const imageContent = model.input.includes("image")
        ? msg.content.filter(
            (item): item is Extract<(typeof msg.content)[number], { type: "image" }> =>
              item.type === "image",
          )
        : [];
      const responseValue = textResult
        ? sanitizeTransportPayloadText(textResult)
        : imageContent.length > 0
          ? "(see attached image)"
          : "";
      const imageParts = imageContent.map((imageBlock) => ({
        inlineData: {
          mimeType: imageBlock.mimeType,
          data: imageBlock.data,
        },
      }));
      const functionResponse = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseValue } : { output: responseValue },
          ...(supportsMultimodalFunctionResponse(model.id) && imageParts.length > 0
            ? { parts: imageParts }
            : {}),
          ...(requiresToolCallId(model.id) ? { id: msg.toolCallId } : {}),
        },
      };
      const last = contents[contents.length - 1];
      if (
        last?.role === "user" &&
        Array.isArray(last.parts) &&
        last.parts.some((part) => "functionResponse" in part)
      ) {
        (last.parts as Array<Record<string, unknown>>).push(functionResponse);
      } else {
        contents.push({ role: "user", parts: [functionResponse] });
      }
      if (imageParts.length > 0 && !supportsMultimodalFunctionResponse(model.id)) {
        contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...imageParts] });
      }
    }
  }
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: " " }] });
  }
  return contents;
}

function convertGoogleTools(tools: NonNullable<Context["tools"]>) {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}

export function buildGoogleGenerativeAiParams(
  model: GoogleTransportModel,
  context: Context,
  options?: GoogleTransportOptions,
): GoogleGenerateContentRequest {
  const generationConfig: Record<string, unknown> = {};
  if (typeof options?.temperature === "number") {
    generationConfig.temperature = options.temperature;
  }
  if (typeof options?.maxTokens === "number") {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  const thinkingConfig = resolveGoogleThinkingConfig(model, options);
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const params: GoogleGenerateContentRequest = {
    contents: convertGoogleMessages(model, context),
  };
  if (typeof options?.cachedContent === "string" && options.cachedContent.trim()) {
    params.cachedContent = options.cachedContent.trim();
  }
  if (Object.keys(generationConfig).length > 0) {
    params.generationConfig = generationConfig;
  }
  if (context.systemPrompt) {
    params.systemInstruction = {
      parts: [
        {
          text: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt)),
        },
      ],
    };
  }
  if (context.tools?.length) {
    params.tools = convertGoogleTools(context.tools);
    const toolChoice = mapToolChoice(options?.toolChoice);
    if (toolChoice) {
      params.toolConfig = {
        functionCallingConfig: toolChoice,
      };
    }
  }
  return params;
}

function buildGoogleHeaders(
  model: GoogleTransportModel,
  apiKey: string | undefined,
  optionHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const authHeaders = apiKey ? parseGeminiAuth(apiKey).headers : undefined;
  return (
    mergeTransportHeaders(
      {
        "Content-Type": "application/json",
        accept: "text/event-stream",
      },
      authHeaders,
      model.headers,
      optionHeaders,
    ) ?? {
      "Content-Type": "application/json",
      accept: "text/event-stream",
    }
  );
}

async function buildGoogleVertexHeaders(
  model: GoogleTransportModel,
  apiKey: string | undefined,
  optionHeaders: Record<string, string> | undefined,
  fetchImpl?: typeof fetch,
): Promise<Record<string, string>> {
  const authHeaders = isGoogleVertexCredentialsMarker(apiKey)
    ? await resolveGoogleVertexAuthorizedUserHeaders(fetchImpl)
    : { "x-goog-api-key": apiKey };
  return (
    mergeTransportHeaders(
      {
        "Content-Type": "application/json",
        accept: "text/event-stream",
      },
      authHeaders,
      model.headers,
      optionHeaders,
    ) ?? {
      "Content-Type": "application/json",
      accept: "text/event-stream",
    }
  );
}

function buildGoogleTransportRequestUrl(
  kind: GoogleTransportApi,
  model: GoogleTransportModel,
  options: GoogleTransportOptions | undefined,
): string {
  return kind === "google-vertex"
    ? buildGoogleVertexRequestUrl(model, options)
    : buildGoogleGenerativeAiRequestUrl(model);
}

async function buildGoogleTransportHeaders(params: {
  kind: GoogleTransportApi;
  model: GoogleTransportModel;
  apiKey: string | undefined;
  optionHeaders: Record<string, string> | undefined;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, string>> {
  return params.kind === "google-vertex"
    ? await buildGoogleVertexHeaders(
        params.model,
        params.apiKey,
        params.optionHeaders,
        params.fetchImpl,
      )
    : buildGoogleHeaders(params.model, params.apiKey, params.optionHeaders);
}

async function* parseGoogleSseChunks(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<GoogleSseChunk> {
  if (!response.body) {
    throw new Error("No response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abortHandler = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortHandler);
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") {
          continue;
        }
        yield JSON.parse(data) as GoogleSseChunk;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }
}

function updateUsage(
  output: MutableAssistantOutput,
  model: GoogleTransportModel,
  chunk: GoogleSseChunk,
) {
  const usage = chunk.usageMetadata;
  if (!usage) {
    return;
  }
  const promptTokens = usage.promptTokenCount || 0;
  const cacheRead = usage.cachedContentTokenCount || 0;
  output.usage = {
    input: Math.max(0, promptTokens - cacheRead),
    output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
    cacheRead,
    cacheWrite: 0,
    totalTokens: usage.totalTokenCount || 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, output.usage);
}

function pushTextBlockEnd(
  stream: WritableTransportStream,
  output: MutableAssistantOutput,
  blockIndex: number,
) {
  const block = output.content[blockIndex];
  if (!block) {
    return;
  }
  if (block.type === "thinking") {
    stream.push({
      type: "thinking_end",
      contentIndex: blockIndex,
      content: block.thinking,
      partial: output as never,
    });
    return;
  }
  if (block.type === "text") {
    stream.push({
      type: "text_end",
      contentIndex: blockIndex,
      content: block.text,
      partial: output as never,
    });
  }
}

function createGoogleTransportStreamFn(kind: GoogleTransportApi): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = rawModel as GoogleTransportModel;
    const options = rawOptions as GoogleTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant",
        content: [],
        api: kind,
        provider: model.provider,
        model: model.id,
        usage: createEmptyTransportUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? undefined;
        const guardedFetch = buildGuardedModelFetch(model);
        let params = buildGoogleGenerativeAiParams(model, context, options);
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as GoogleGenerateContentRequest;
        }
        const response = await guardedFetch(buildGoogleTransportRequestUrl(kind, model, options), {
          method: "POST",
          headers: await buildGoogleTransportHeaders({
            kind,
            model,
            apiKey,
            optionHeaders: options?.headers,
            fetchImpl: (options as { fetch?: typeof fetch } | undefined)?.fetch,
          }),
          body: JSON.stringify(params),
          signal: options?.signal,
        });
        if (!response.ok) {
          throw await createProviderHttpError(
            response,
            kind === "google-vertex"
              ? "Google Vertex AI API error"
              : "Google Generative AI API error",
          );
        }
        stream.push({ type: "start", partial: output as never });
        let currentBlockIndex = -1;
        for await (const chunk of parseGoogleSseChunks(response, options?.signal)) {
          output.responseId ||= chunk.responseId;
          updateUsage(output, model, chunk);
          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              if (typeof part.text === "string") {
                const isThinking = part.thought === true;
                const currentBlock = output.content[currentBlockIndex];
                if (
                  currentBlockIndex < 0 ||
                  !currentBlock ||
                  (isThinking && currentBlock.type !== "thinking") ||
                  (!isThinking && currentBlock.type !== "text")
                ) {
                  if (currentBlockIndex >= 0) {
                    pushTextBlockEnd(stream, output, currentBlockIndex);
                  }
                  if (isThinking) {
                    output.content.push({ type: "thinking", thinking: "" });
                    currentBlockIndex = output.content.length - 1;
                    stream.push({
                      type: "thinking_start",
                      contentIndex: currentBlockIndex,
                      partial: output as never,
                    });
                  } else {
                    output.content.push({ type: "text", text: "" });
                    currentBlockIndex = output.content.length - 1;
                    stream.push({
                      type: "text_start",
                      contentIndex: currentBlockIndex,
                      partial: output as never,
                    });
                  }
                }
                const activeBlock = output.content[currentBlockIndex];
                if (activeBlock?.type === "thinking") {
                  activeBlock.thinking += part.text;
                  activeBlock.thinkingSignature = retainThoughtSignature(
                    activeBlock.thinkingSignature,
                    part.thoughtSignature,
                  );
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: currentBlockIndex,
                    delta: part.text,
                    partial: output as never,
                  });
                } else if (activeBlock?.type === "text") {
                  activeBlock.text += part.text;
                  activeBlock.textSignature = retainThoughtSignature(
                    activeBlock.textSignature,
                    part.thoughtSignature,
                  );
                  stream.push({
                    type: "text_delta",
                    contentIndex: currentBlockIndex,
                    delta: part.text,
                    partial: output as never,
                  });
                }
              }
              if (part.functionCall) {
                if (currentBlockIndex >= 0) {
                  pushTextBlockEnd(stream, output, currentBlockIndex);
                  currentBlockIndex = -1;
                }
                const providedId = part.functionCall.id;
                const isDuplicate = output.content.some(
                  (block) => block.type === "toolCall" && block.id === providedId,
                );
                const toolCallId =
                  providedId && !isDuplicate
                    ? providedId
                    : `${part.functionCall.name || "tool"}_${Date.now()}_${++toolCallCounter}`;
                const toolCall: GoogleTransportContentBlock = {
                  type: "toolCall",
                  id: toolCallId,
                  name: part.functionCall.name || "",
                  arguments: part.functionCall.args ?? {},
                  thoughtSignature: part.thoughtSignature,
                };
                output.content.push(toolCall);
                const blockIndex = output.content.length - 1;
                stream.push({
                  type: "toolcall_start",
                  contentIndex: blockIndex,
                  partial: output as never,
                });
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: blockIndex,
                  delta: JSON.stringify(toolCall.arguments),
                  partial: output as never,
                });
                stream.push({
                  type: "toolcall_end",
                  contentIndex: blockIndex,
                  toolCall,
                  partial: output as never,
                });
              }
            }
          }
          if (typeof candidate?.finishReason === "string") {
            output.stopReason = mapStopReasonString(candidate.finishReason);
            if (output.content.some((block) => block.type === "toolCall")) {
              output.stopReason = "toolUse";
            }
          }
        }
        if (currentBlockIndex >= 0) {
          pushTextBlockEnd(stream, output, currentBlockIndex);
        }
        finalizeTransportStream({ stream, output, signal: options?.signal });
      } catch (error) {
        failTransportStream({ stream, output, signal: options?.signal, error });
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

export function createGoogleGenerativeAiTransportStreamFn(): StreamFn {
  return createGoogleTransportStreamFn("google-generative-ai");
}

export function createGoogleVertexTransportStreamFn(): StreamFn {
  return createGoogleTransportStreamFn("google-vertex");
}
