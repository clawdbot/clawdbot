import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientToolDefinition } from "../agents/command/shared-types.js";
import type { ImageContent } from "../agents/command/types.js";
import { isClientToolNameConflictError } from "../agents/pi-tool-definition-adapter.js";
import {
  hasNonzeroUsage,
  normalizeUsage,
  toOpenAiChatCompletionsUsage,
  type NormalizedUsage,
} from "../agents/usage.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import type { GatewayHttpChatCompletionsConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { estimateBase64DecodedBytes } from "../media/base64.js";
import {
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractImageContentFromSource,
  normalizeMimeList,
  type InputImageLimits,
  type InputImageSource,
} from "../media/input-files.js";
import { defaultRuntime } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
} from "./agent-prompt.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, setSseHeaders, watchClientDisconnect, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  resolveGatewayRequestContext,
  resolveOpenAiCompatModelOverride,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";
import { resolveOpenAiCompatError, validateOpenAiSamplingParams } from "./openai-compat-errors.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  config?: GatewayHttpChatCompletionsConfig;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
};

type OpenAiChatCompletionRequest = {
  model?: unknown;
  stream?: unknown;
  // Naming/style reference: src/agents/openai-transport-stream.ts:1262-1273
  stream_options?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  messages?: unknown;
  user?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
};

const DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES = 20 * 1024 * 1024;
const IMAGE_ONLY_USER_MESSAGE = "User sent image(s) with no text.";
const DEFAULT_OPENAI_MAX_IMAGE_PARTS = 8;
const DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_IMAGE_LIMITS: InputImageLimits = {
  allowUrl: false,
  allowedMimes: new Set(DEFAULT_INPUT_IMAGE_MIMES),
  maxBytes: DEFAULT_INPUT_IMAGE_MAX_BYTES,
  maxRedirects: DEFAULT_INPUT_MAX_REDIRECTS,
  timeoutMs: DEFAULT_INPUT_TIMEOUT_MS,
};

type ResolvedOpenAiChatCompletionsLimits = {
  maxBodyBytes: number;
  maxImageParts: number;
  maxTotalImageBytes: number;
  images: InputImageLimits;
};

function resolveOpenAiChatCompletionsLimits(
  config: GatewayHttpChatCompletionsConfig | undefined,
): ResolvedOpenAiChatCompletionsLimits {
  const imageConfig = config?.images;
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES,
    maxImageParts:
      typeof config?.maxImageParts === "number"
        ? Math.max(0, Math.floor(config.maxImageParts))
        : DEFAULT_OPENAI_MAX_IMAGE_PARTS,
    maxTotalImageBytes:
      typeof config?.maxTotalImageBytes === "number"
        ? Math.max(1, Math.floor(config.maxTotalImageBytes))
        : DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES,
    images: {
      allowUrl: imageConfig?.allowUrl ?? DEFAULT_OPENAI_IMAGE_LIMITS.allowUrl,
      urlAllowlist: normalizeInputHostnameAllowlist(imageConfig?.urlAllowlist),
      allowedMimes: normalizeMimeList(imageConfig?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: imageConfig?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: imageConfig?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: imageConfig?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
  };
}

function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildAgentCommandInput(params: {
  prompt: { message: string; extraSystemPrompt?: string; images?: ImageContent[] };
  clientTools?: ClientToolDefinition[];
  modelOverride?: string;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  abortSignal?: AbortSignal;
  streamParams?: { maxTokens?: number; temperature?: number; topP?: number };
}) {
  return {
    message: params.prompt.message,
    extraSystemPrompt: params.prompt.extraSystemPrompt,
    images: params.prompt.images,
    clientTools: params.clientTools,
    model: params.modelOverride,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false as const,
    messageChannel: params.messageChannel,
    bestEffortDeliver: false as const,
    senderIsOwner: params.senderIsOwner,
    allowModelOverride: true as const,
    abortSignal: params.abortSignal,
    streamParams: params.streamParams,
  };
}

function extractClientToolsFromChatRequest(tools: unknown): ClientToolDefinition[] {
  if (tools == null) {
    return [];
  }
  if (!Array.isArray(tools)) {
    throw new Error("tools must be an array");
  }
  const clientTools: ClientToolDefinition[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      throw new Error("each tool must be an object");
    }
    if ((tool as { type?: unknown }).type !== "function") {
      throw new Error("only function tools are supported");
    }
    const functionValue = (tool as { function?: unknown }).function;
    if (!functionValue || typeof functionValue !== "object" || Array.isArray(functionValue)) {
      throw new Error("tool.function is required");
    }
    const rawName = (functionValue as { name?: unknown }).name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) {
      throw new Error("tool.function.name is required");
    }
    const description = (functionValue as { description?: unknown }).description;
    const parameters = (functionValue as { parameters?: unknown }).parameters;
    const strict = (functionValue as { strict?: unknown }).strict;
    clientTools.push({
      type: "function",
      function: {
        name,
        ...(typeof description === "string" ? { description } : {}),
        ...(parameters && typeof parameters === "object" && !Array.isArray(parameters)
          ? { parameters: parameters as Record<string, unknown> }
          : {}),
        ...(typeof strict === "boolean" ? { strict } : {}),
      },
    });
  }
  return clientTools;
}

function applyChatToolChoice(params: { tools: ClientToolDefinition[]; toolChoice: unknown }): {
  tools: ClientToolDefinition[];
  extraSystemPrompt?: string;
} {
  const { tools, toolChoice } = params;
  if (toolChoice == null || toolChoice === "auto") {
    return { tools };
  }
  if (toolChoice === "none") {
    return { tools: [] };
  }
  if (toolChoice === "required") {
    throw new Error("tool_choice=required is not supported");
  }
  if (typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    throw new Error("tool_choice must be a string or object");
  }
  const choiceType = (toolChoice as { type?: unknown }).type;
  if (typeof choiceType !== "string") {
    throw new Error("unsupported tool_choice type");
  }
  throw new Error(`tool_choice ${choiceType} is not supported`);
}

function writeAssistantRoleChunk(res: ServerResponse, params: { runId: string; model: string }) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
}

function writeAssistantContentChunk(
  res: ServerResponse,
  params: { runId: string; model: string; content: string; finishReason: "stop" | null },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: { content: params.content },
        finish_reason: params.finishReason,
      },
    ],
  });
}

function writeAssistantFinishChunk(
  res: ServerResponse,
  params: { runId: string; model: string; finishReason: "stop" | "tool_calls" },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: params.finishReason,
      },
    ],
  });
}

function splitArgumentsForStreaming(argumentsValue: string): string[] {
  if (!argumentsValue) {
    return [""];
  }
  const chunkSize = 256;
  const chunks: string[] = [];
  for (let i = 0; i < argumentsValue.length; i += chunkSize) {
    chunks.push(argumentsValue.slice(i, i + chunkSize));
  }
  return chunks.length > 0 ? chunks : [""];
}

function writeAssistantToolCallsIncrementalChunks(
  res: ServerResponse,
  params: {
    runId: string;
    model: string;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
  },
) {
  for (const [index, call] of params.toolCalls.entries()) {
    writeSse(res, {
      id: params.runId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: params.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });

    for (const argsDelta of splitArgumentsForStreaming(call.arguments)) {
      writeSse(res, {
        id: params.runId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: params.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  function: { arguments: argsDelta },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    }
  }
}

function writeUsageChunk(
  res: ServerResponse,
  params: {
    runId: string;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  },
) {
  writeSse(res, {
    id: params.runId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [],
    usage: params.usage,
  });
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") {
          return text;
        }
        if (type === "input_text" && typeof text === "string") {
          return text;
        }
        if (typeof inputText === "string") {
          return inputText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

type AssistantToolCall = {
  id: string;
  name: string;
  arguments: string;
};

function stringifyToolCallArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "";
  } catch {
    return "";
  }
}

function extractAssistantToolCalls(value: unknown): AssistantToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const calls: AssistantToolCall[] = [];
  for (const rawCall of value) {
    if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) {
      continue;
    }
    const id = normalizeOptionalString((rawCall as { id?: unknown }).id) ?? "";
    const functionValue = (rawCall as { function?: unknown }).function;
    if (!functionValue || typeof functionValue !== "object" || Array.isArray(functionValue)) {
      continue;
    }
    const name = normalizeOptionalString((functionValue as { name?: unknown }).name) ?? "";
    if (!id || !name) {
      continue;
    }
    const argumentsValue = stringifyToolCallArguments(
      (functionValue as { arguments?: unknown }).arguments,
    );
    calls.push({ id, name, arguments: argumentsValue });
  }
  return calls;
}

function renderAssistantToolCalls(calls: AssistantToolCall[]): string {
  return calls
    .map((call) => `tool_call id=${call.id} name=${call.name} arguments=${call.arguments}`)
    .join("\n");
}

function resolveImageUrlPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  const imageUrl = (part as { image_url?: unknown }).image_url;
  if (typeof imageUrl === "string") {
    const trimmed = imageUrl.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!imageUrl || typeof imageUrl !== "object") {
    return undefined;
  }
  const rawUrl = (imageUrl as { url?: unknown }).url;
  if (typeof rawUrl !== "string") {
    return undefined;
  }
  const trimmed = rawUrl.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractImageUrls(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const urls: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if ((part as { type?: unknown }).type !== "image_url") {
      continue;
    }
    const url = resolveImageUrlPart(part);
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

type ActiveTurnContext = {
  activeTurnIndex: number;
  activeUserMessageIndex: number;
  urls: string[];
};

function parseImageUrlToSource(url: string): InputImageSource {
  const dataUriMatch = /^data:([^,]*?),(.*)$/is.exec(url);
  if (dataUriMatch) {
    const metadata = normalizeOptionalString(dataUriMatch[1]) ?? "";
    const data = dataUriMatch[2] ?? "";
    const metadataParts = metadata
      .split(";")
      .map((part) => normalizeOptionalString(part) ?? "")
      .filter(Boolean);
    const isBase64 = metadataParts.some(
      (part) => normalizeLowercaseStringOrEmpty(part) === "base64",
    );
    if (!isBase64) {
      throw new Error("image_url data URI must be base64 encoded");
    }
    if (!(normalizeOptionalString(data) ?? "")) {
      throw new Error("image_url data URI is missing payload data");
    }
    const mediaTypeRaw = metadataParts.find((part) => part.includes("/"));
    return {
      type: "base64",
      mediaType: mediaTypeRaw,
      data,
    };
  }
  return { type: "url", url };
}

function resolveActiveTurnContext(messagesUnknown: unknown): ActiveTurnContext {
  const messages = asMessages(messagesUnknown);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "tool") {
      continue;
    }
    return {
      activeTurnIndex: i,
      activeUserMessageIndex: normalizedRole === "user" ? i : -1,
      urls: normalizedRole === "user" ? extractImageUrls(msg.content) : [],
    };
  }
  return { activeTurnIndex: -1, activeUserMessageIndex: -1, urls: [] };
}

async function resolveImagesForRequest(
  activeTurnContext: Pick<ActiveTurnContext, "urls">,
  limits: ResolvedOpenAiChatCompletionsLimits,
): Promise<ImageContent[]> {
  const urls = activeTurnContext.urls;
  if (urls.length === 0) {
    return [];
  }
  if (urls.length > limits.maxImageParts) {
    throw new Error(`Too many image_url parts (${urls.length}; limit ${limits.maxImageParts})`);
  }

  const images: ImageContent[] = [];
  let totalBytes = 0;
  for (const url of urls) {
    const source = parseImageUrlToSource(url);
    if (source.type === "base64") {
      const sourceBytes = estimateBase64DecodedBytes(source.data);
      if (totalBytes + sourceBytes > limits.maxTotalImageBytes) {
        throw new Error(
          `Total image payload too large (${totalBytes + sourceBytes}; limit ${limits.maxTotalImageBytes})`,
        );
      }
    }

    const image = await extractImageContentFromSource(source, limits.images);
    totalBytes += estimateBase64DecodedBytes(image.data);
    if (totalBytes > limits.maxTotalImageBytes) {
      throw new Error(
        `Total image payload too large (${totalBytes}; limit ${limits.maxTotalImageBytes})`,
      );
    }
    images.push(image);
  }
  return images;
}

export const __testOnlyOpenAiHttp = {
  resolveImagesForRequest,
  resolveOpenAiChatCompletionsLimits,
  resolveChatCompletionUsage,
};

function buildAgentPrompt(
  messagesUnknown: unknown,
  activeUserMessageIndex: number,
): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const [i, msg] of messages.entries()) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const content = extractTextContent(msg.content).trim();
    const hasImage = extractImageUrls(msg.content).length > 0;
    if (!role) {
      continue;
    }
    if (role === "system" || role === "developer") {
      if (content) {
        systemParts.push(content);
      }
      continue;
    }

    const normalizedRole = role === "function" ? "tool" : role;
    if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "tool") {
      continue;
    }
    const assistantToolCalls =
      normalizedRole === "assistant" ? extractAssistantToolCalls(msg.tool_calls) : [];
    const assistantToolCallsSummary =
      assistantToolCalls.length > 0 ? renderAssistantToolCalls(assistantToolCalls) : "";

    // Keep the image-only placeholder scoped to the active user turn so we don't
    // mention historical image-only turns whose bytes are intentionally not replayed.
    const baseMessageContent =
      normalizedRole === "user" && !content && hasImage && i === activeUserMessageIndex
        ? IMAGE_ONLY_USER_MESSAGE
        : content;
    const messageContent = [baseMessageContent, assistantToolCallsSummary]
      .filter((part): part is string => Boolean(part))
      .join("\n");
    if (!messageContent) {
      continue;
    }

    const name = normalizeOptionalString(msg.name) ?? "";
    const toolCallId = normalizeOptionalString(msg.tool_call_id) ?? "";
    const sender =
      normalizedRole === "assistant"
        ? "Assistant"
        : normalizedRole === "user"
          ? "User"
          : toolCallId
            ? `Tool:${toolCallId}`
            : name
              ? `Tool:${name}`
              : "Tool";

    conversationEntries.push({
      role: normalizedRole,
      entry: { sender, body: messageContent },
    });
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function coerceRequest(val: unknown): OpenAiChatCompletionRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as OpenAiChatCompletionRequest;
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return content || "No response from OpenClaw.";
}

function resolveAgentResponseCommentary(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "";
  }
  return payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

type AgentUsageMeta = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type PendingToolCall = {
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
};

function resolveAgentRunUsage(result: unknown): NormalizedUsage | undefined {
  const agentMeta = (
    result as {
      meta?: {
        agentMeta?: {
          usage?: AgentUsageMeta;
          lastCallUsage?: AgentUsageMeta;
        };
      };
    } | null
  )?.meta?.agentMeta;
  const primary = normalizeUsage(agentMeta?.usage);
  if (hasNonzeroUsage(primary)) {
    return primary;
  }
  const fallback = normalizeUsage(agentMeta?.lastCallUsage);
  if (hasNonzeroUsage(fallback)) {
    return fallback;
  }
  return primary ?? fallback;
}

function resolveStopReasonAndPendingToolCalls(meta: unknown): {
  stopReason: string | undefined;
  pendingToolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
} {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return { stopReason: undefined, pendingToolCalls: undefined };
  }
  const stopReasonRaw = (meta as { stopReason?: unknown }).stopReason;
  const stopReason = typeof stopReasonRaw === "string" ? stopReasonRaw : undefined;
  const pendingRaw = (meta as { pendingToolCalls?: unknown }).pendingToolCalls;
  if (!Array.isArray(pendingRaw)) {
    return { stopReason, pendingToolCalls: undefined };
  }
  const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  for (const call of pendingRaw as PendingToolCall[]) {
    const id = typeof call?.id === "string" ? call.id.trim() : "";
    const name = typeof call?.name === "string" ? call.name.trim() : "";
    const argsValue = call?.arguments;
    const argumentsValue =
      typeof argsValue === "string"
        ? argsValue
        : argsValue == null
          ? ""
          : JSON.stringify(argsValue);
    if (!id || !name) {
      continue;
    }
    pendingToolCalls.push({ id, name, arguments: argumentsValue });
  }
  return { stopReason, pendingToolCalls };
}

function resolveChatCompletionUsage(result: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  return toOpenAiChatCompletionsUsage(resolveAgentRunUsage(result));
}

function resolveIncludeUsageForStreaming(payload: OpenAiChatCompletionRequest): boolean {
  // Keep parsing aligned with OpenAI wire-format field names.
  // Flow reference: src/agents/openai-transport-stream.ts:1262-1273
  const streamOptions = payload.stream_options;
  if (!streamOptions || typeof streamOptions !== "object" || Array.isArray(streamOptions)) {
    return false;
  }
  return (streamOptions as { include_usage?: unknown }).include_usage === true;
}

function resolveErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.trim();
    if (message) {
      return message;
    }
  }
  return String(err);
}

export async function handleOpenAiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiHttpOptions,
): Promise<boolean> {
  const limits = resolveOpenAiChatCompletionsLimits(opts.config);
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/chat/completions",
    requiredOperatorMethod: "chat.send",
    // Compat HTTP uses a different scope model from generic HTTP helpers:
    // shared-secret bearer auth is treated as full operator access here.
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? limits.maxBodyBytes,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }
  // On the compat surface, shared-secret bearer auth is also treated as an
  // owner sender so owner-only tool policy matches the documented contract.
  const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, handled.requestAuth);

  const payload = coerceRequest(handled.body);
  const stream = Boolean(payload.stream);
  const streamIncludeUsage = stream && resolveIncludeUsageForStreaming(payload);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;
  const maxTokens =
    typeof payload.max_completion_tokens === "number"
      ? payload.max_completion_tokens
      : typeof payload.max_tokens === "number"
        ? payload.max_tokens
        : undefined;
  const temperature = typeof payload.temperature === "number" ? payload.temperature : undefined;
  const topP = typeof payload.top_p === "number" ? payload.top_p : undefined;
  const samplingError = validateOpenAiSamplingParams({
    temperature: payload.temperature,
    topP: payload.top_p,
  });
  if (samplingError) {
    sendJson(res, 400, {
      error: { message: samplingError, type: "invalid_request_error" },
    });
    return true;
  }
  const streamParams =
    maxTokens !== undefined || temperature !== undefined || topP !== undefined
      ? {
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(topP !== undefined ? { topP } : {}),
        }
      : undefined;

  const { agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model,
    user,
    sessionPrefix: "openai",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  });
  const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
    req,
    agentId,
    model,
  });
  if (modelError) {
    sendJson(res, 400, {
      error: { message: modelError, type: "invalid_request_error" },
    });
    return true;
  }
  const activeTurnContext = resolveActiveTurnContext(payload.messages);
  const prompt = buildAgentPrompt(payload.messages, activeTurnContext.activeUserMessageIndex);
  let resolvedClientTools: ClientToolDefinition[] = [];
  let toolChoicePrompt: string | undefined;
  try {
    const parsedClientTools = extractClientToolsFromChatRequest(payload.tools);
    const toolChoiceResult = applyChatToolChoice({
      tools: parsedClientTools,
      toolChoice: payload.tool_choice,
    });
    resolvedClientTools = toolChoiceResult.tools;
    toolChoicePrompt = toolChoiceResult.extraSystemPrompt;
  } catch (err) {
    sendJson(res, 400, {
      error: {
        message: `Invalid tools/tool_choice: ${resolveErrorMessage(err)}`,
        type: "invalid_request_error",
      },
    });
    return true;
  }
  let images: ImageContent[] = [];
  try {
    images = await resolveImagesForRequest(activeTurnContext, limits);
  } catch (err) {
    logWarn(`openai-compat: invalid image_url content: ${String(err)}`);
    sendJson(res, 400, {
      error: {
        message: "Invalid image_url content in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  if (!prompt.message && images.length === 0) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `messages`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const deps = createDefaultDeps();
  const abortController = new AbortController();
  const mergedExtraSystemPrompt = [prompt.extraSystemPrompt, toolChoicePrompt]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  const commandInput = buildAgentCommandInput({
    prompt: {
      message: prompt.message,
      extraSystemPrompt: mergedExtraSystemPrompt || undefined,
      images: images.length > 0 ? images : undefined,
    },
    clientTools: resolvedClientTools.length > 0 ? resolvedClientTools : undefined,
    modelOverride,
    sessionKey,
    runId,
    messageChannel,
    abortSignal: abortController.signal,
    senderIsOwner,
    streamParams,
  });

  if (!stream) {
    const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);

      if (abortController.signal.aborted) {
        return true;
      }

      const usage = resolveChatCompletionUsage(result);
      const meta = (result as { meta?: unknown } | null)?.meta;
      const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);

      if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
        const commentary = resolveAgentResponseCommentary(result);
        sendJson(res, 200, {
          id: runId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: commentary,
                tool_calls: pendingToolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              },
              finish_reason: "tool_calls",
            },
          ],
          usage,
        });
        return true;
      }
      const content = resolveAgentResponseText(result);

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage,
      });
    } catch (err) {
      if (abortController.signal.aborted) {
        return true;
      }
      logWarn(`openai-compat: chat completion failed: ${String(err)}`);
      if (isClientToolNameConflictError(err)) {
        sendJson(res, 400, {
          error: { message: "invalid tool configuration", type: "invalid_request_error" },
        });
        return true;
      }
      const mapped = resolveOpenAiCompatError(err);
      if (mapped) {
        sendJson(res, mapped.status, { error: mapped.error });
        return true;
      }
      sendJson(res, 500, {
        error: { message: "internal error", type: "api_error" },
      });
    } finally {
      stopWatchingDisconnect();
    }
    return true;
  }

  setSseHeaders(res);

  let wroteRole = false;
  let wroteStopChunk = false;
  let sawAssistantDelta = false;
  let finalUsage:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }
    | undefined;
  let finalizeRequested = false;
  let finalizeFinishReason: "stop" | "tool_calls" = "stop";
  let resultResolved = false;
  let closed = false;
  let stopWatchingDisconnect = () => {};

  const maybeFinalize = () => {
    if (closed || !finalizeRequested) {
      return;
    }
    if (!resultResolved) {
      return;
    }
    if (streamIncludeUsage && !finalUsage) {
      return;
    }
    closed = true;
    stopWatchingDisconnect();
    unsubscribe();
    if (!wroteStopChunk) {
      writeAssistantFinishChunk(res, { runId, model, finishReason: finalizeFinishReason });
      wroteStopChunk = true;
    }
    if (streamIncludeUsage && finalUsage) {
      writeUsageChunk(res, { runId, model, usage: finalUsage });
    }
    writeDone(res);
    res.end();
  };

  const requestFinalize = (finishReason: "stop" | "tool_calls" = "stop") => {
    finalizeFinishReason = finishReason;
    finalizeRequested = true;
    maybeFinalize();
  };

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt) ?? "";
      if (!content) {
        return;
      }

      if (!wroteRole) {
        wroteRole = true;
        writeAssistantRoleChunk(res, { runId, model });
      }

      sawAssistantDelta = true;
      writeAssistantContentChunk(res, {
        runId,
        model,
        content,
        finishReason: null,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        requestFinalize();
      }
    }
  });

  stopWatchingDisconnect = watchClientDisconnect(req, res, abortController, () => {
    closed = true;
    unsubscribe();
  });

  wroteRole = true;
  writeAssistantRoleChunk(res, { runId, model });

  void (async () => {
    try {
      const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);
      resultResolved = true;

      if (closed) {
        return;
      }

      finalUsage = resolveChatCompletionUsage(result);
      const meta = (result as { meta?: unknown } | null)?.meta;
      const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);

      if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
        if (!wroteRole) {
          wroteRole = true;
          writeAssistantRoleChunk(res, { runId, model });
        }
        if (!sawAssistantDelta) {
          const commentary = resolveAgentResponseCommentary(result);
          if (commentary) {
            sawAssistantDelta = true;
            writeAssistantContentChunk(res, {
              runId,
              model,
              content: commentary,
              finishReason: null,
            });
          }
        }
        writeAssistantToolCallsIncrementalChunks(res, {
          runId,
          model,
          toolCalls: pendingToolCalls,
        });
        requestFinalize("tool_calls");
        return;
      }

      if (!sawAssistantDelta) {
        if (!wroteRole) {
          wroteRole = true;
          writeAssistantRoleChunk(res, { runId, model });
        }

        const content = resolveAgentResponseText(result);

        sawAssistantDelta = true;
        writeAssistantContentChunk(res, {
          runId,
          model,
          content,
          finishReason: null,
        });
      }
      requestFinalize();
    } catch (err) {
      resultResolved = true;
      if (closed || abortController.signal.aborted) {
        return;
      }
      logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
      if (isClientToolNameConflictError(err)) {
        closed = true;
        stopWatchingDisconnect();
        unsubscribe();
        writeSse(res, {
          error: { message: "invalid tool configuration", type: "invalid_request_error" },
        });
        writeDone(res);
        res.end();
        return;
      }
      const mapped = resolveOpenAiCompatError(err);
      if (mapped) {
        closed = true;
        stopWatchingDisconnect();
        unsubscribe();
        writeSse(res, { error: mapped.error });
        writeDone(res);
        res.end();
        return;
      }
      const content = "Error: internal error";
      writeAssistantContentChunk(res, {
        runId,
        model,
        content,
        finishReason: "stop",
      });
      wroteStopChunk = true;
      finalUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      };
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
      requestFinalize();
    } finally {
      if (!closed) {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
      }
    }
  })();

  return true;
}
