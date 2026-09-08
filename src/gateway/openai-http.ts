// Gateway OpenAI-compatible chat completions endpoint.
// Translates OpenAI chat requests to OpenClaw agent runs and SSE/JSON responses.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { avoidTrailingHighSurrogateBreak } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import { isClientToolNameConflictError } from "../agents/agent-tool-definition-adapter.js";
import type { AgentStreamParams, ClientToolDefinition } from "../agents/command/shared-types.js";
import type { ImageContent } from "../agents/command/types.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { toOpenAiChatCompletionsUsage, type OpenAiChatCompletionsUsage } from "../agents/usage.js";
import { readAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayHttpChatCompletionsConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEventForRun } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
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
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../process/gateway-work-admission.js";
import { defaultRuntime } from "../runtime.js";
import {
  mergeAssistantText,
  mergePendingAssistantText,
  resolveAssistantResultText,
  resolveAssistantTextCompletion,
  resolveAssistantTextInput,
  type AssistantTextSnapshot,
} from "./agent-event-assistant-text.js";
import {
  buildAgentMessageFromConversationEntries,
  type ConversationEntry,
  type ConversationToolCall,
  IMAGE_ONLY_USER_MESSAGE,
  renderConversationToolCall,
} from "./agent-prompt.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  parseGatewayJsonRequest,
  sendInvalidRequest,
  sendJson,
  sendMissingScopeForbidden,
  setSseHeaders,
  watchClientDisconnect,
  writeDone,
} from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  authorizeOpenAiCompatibleHttpModelOverride,
  authorizeOpenAiCompatibleHttpSession,
  isAgentSelectionRequiredError,
  isGatewaySessionKeyOverrideError,
  isInvalidGatewayModelError,
  isUnknownGatewayAgentError,
  resolveGatewayRequestContext,
  resolveOpenAiCompatModelOverride,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";
import { resolveAgentRunUsage } from "./openai-agent-run-usage.js";
import { resolveOpenAiCompatError, validateOpenAiSamplingParams } from "./openai-compat-errors.js";
import {
  applyToolChoice,
  isToolChoiceConstraintSatisfied,
  resolveUnsatisfiedToolChoiceMessage,
  type ToolChoiceConstraint,
} from "./openai-tool-choice.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

type OpenAiHttpOptions = {
  auth: ResolvedGatewayAuth;
  config?: GatewayHttpChatCompletionsConfig;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  resolveGatewayContext?: GatewayContextResolver;
};

type OpenAiChatMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
  stopReason?: unknown;
};

const OpenAiChatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullish(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  messages: z.array(z.unknown()).optional(),
  user: z.string().optional(),
  max_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  temperature: z.number().nullish(),
  top_p: z.number().nullish(),
  response_format: z.unknown().optional(),
  frequency_penalty: z.number().nullish(),
  presence_penalty: z.number().nullish(),
  seed: z.number().nullish(),
  stop: z.union([z.string(), z.array(z.string())]).nullish(),
});

type OpenAiChatCompletionRequest = z.infer<typeof OpenAiChatCompletionRequestSchema>;

const DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES = 20 * 1024 * 1024;
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
    maxBodyBytes: DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES,
    maxImageParts: DEFAULT_OPENAI_MAX_IMAGE_PARTS,
    maxTotalImageBytes: DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES,
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
  streamParams?: AgentStreamParams;
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
    senderIsOwner: params.senderIsOwner,
    bestEffortDeliver: false as const,
    allowModelOverride: params.modelOverride !== undefined,
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

function resolveChatToolChoice(toolChoice: unknown): ToolChoiceConstraint | "none" | undefined {
  if (toolChoice == null || toolChoice === "auto") {
    return undefined;
  }
  if (toolChoice === "none") {
    return "none";
  }
  if (toolChoice === "required") {
    return { type: "required" };
  }
  if (typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    throw new Error("tool_choice must be a string or object");
  }
  const choiceType = (toolChoice as { type?: unknown }).type;
  if (choiceType === "function") {
    const targetName = normalizeOptionalString(
      (toolChoice as { function?: { name?: unknown } }).function?.name,
    );
    if (!targetName) {
      throw new Error("tool_choice.function.name is required");
    }
    return { type: "function", name: targetName };
  }
  if (typeof choiceType !== "string") {
    throw new Error("unsupported tool_choice type");
  }
  throw new Error(`tool_choice ${choiceType} is not supported`);
}

type ChatCompletionStreamIdentity = { runId: string; model: string; created: number };

function writeChatCompletionChunk(
  res: ServerResponse,
  identity: ChatCompletionStreamIdentity,
  chunk: { choices: unknown[]; usage?: OpenAiChatCompletionsUsage },
) {
  writeSse(res, {
    id: identity.runId,
    object: "chat.completion.chunk",
    created: identity.created,
    model: identity.model,
    ...chunk,
  });
}

function writeAssistantRoleChunk(res: ServerResponse, params: ChatCompletionStreamIdentity) {
  writeChatCompletionChunk(res, params, {
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
}

function writeAssistantContentChunk(
  res: ServerResponse,
  params: ChatCompletionStreamIdentity & { content: string },
) {
  writeChatCompletionChunk(res, params, {
    choices: [
      {
        index: 0,
        delta: { content: params.content },
        finish_reason: null,
      },
    ],
  });
}

function writeAssistantFinishChunk(
  res: ServerResponse,
  params: ChatCompletionStreamIdentity & { finishReason: "stop" | "length" | "tool_calls" },
) {
  writeChatCompletionChunk(res, params, {
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: params.finishReason,
      },
    ],
  });
}

function writeAssistantToolCallsIncrementalChunks(
  res: ServerResponse,
  params: ChatCompletionStreamIdentity & {
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
  },
) {
  for (const [index, call] of params.toolCalls.entries()) {
    writeChatCompletionChunk(res, params, {
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

    // Empty arguments still produce a delta after the tool identity frame.
    let start = 0;
    do {
      const end = avoidTrailingHighSurrogateBreak(
        call.arguments,
        start,
        Math.min(start + 256, call.arguments.length),
      );
      writeChatCompletionChunk(res, params, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  function: { arguments: call.arguments.slice(start, end) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      start = end;
    } while (start < call.arguments.length);
  }
}

function writeUsageChunk(
  res: ServerResponse,
  params: ChatCompletionStreamIdentity & {
    usage: OpenAiChatCompletionsUsage;
  },
) {
  writeChatCompletionChunk(res, params, {
    choices: [],
    usage: params.usage,
  });
}

function asMessages(val: unknown): OpenAiChatMessage[] {
  return Array.isArray(val) ? (val as OpenAiChatMessage[]) : [];
}

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      if (!part || typeof part !== "object") {
        return undefined;
      }
      const type = (part as { type?: unknown }).type;
      const text = (part as { text?: unknown }).text;
      const inputText = (part as { input_text?: unknown }).input_text;
      if ((type === "text" || type === "input_text") && typeof text === "string") {
        return text;
      }
      return typeof inputText === "string" ? inputText : undefined;
    });
    const text = parts.filter(Boolean).join("\n");
    return text.trim() || parts.every((part) => part !== undefined) ? text : undefined;
  }
  return undefined;
}

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

function extractAssistantToolCalls(value: unknown): ConversationToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const calls: ConversationToolCall[] = [];
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

type ExtractedImageUrls = { kind: "valid"; urls: string[] } | { kind: "invalid" };

function extractImageUrls(content: unknown): ExtractedImageUrls {
  const urls: string[] = [];
  if (!Array.isArray(content)) {
    return { kind: "valid", urls };
  }
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if ((part as { type?: unknown }).type !== "image_url") {
      continue;
    }
    const url = resolveImageUrlPart(part);
    if (!url) {
      return { kind: "invalid" };
    }
    urls.push(url);
  }
  return { kind: "valid", urls };
}

type ActiveTurnContext = {
  activeTurnIndex: number;
  activeUserMessageIndex: number;
  imageUrls: ExtractedImageUrls;
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
    const imageUrls: ExtractedImageUrls =
      normalizedRole === "user" ? extractImageUrls(msg.content) : { kind: "valid", urls: [] };
    return {
      activeTurnIndex: i,
      activeUserMessageIndex: normalizedRole === "user" ? i : -1,
      imageUrls,
    };
  }
  return {
    activeTurnIndex: -1,
    activeUserMessageIndex: -1,
    imageUrls: { kind: "valid", urls: [] },
  };
}

async function resolveImagesForRequest(
  activeTurnContext: Pick<ActiveTurnContext, "imageUrls">,
  limits: ResolvedOpenAiChatCompletionsLimits,
  signal: AbortSignal,
): Promise<ImageContent[]> {
  signal.throwIfAborted();
  if (activeTurnContext.imageUrls.kind === "invalid") {
    throw new Error("image_url part is missing a valid URL");
  }
  const urls = activeTurnContext.imageUrls.urls;
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

    const image = await extractImageContentFromSource(source, limits.images, signal);
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

function buildAgentPrompt(
  messagesUnknown: unknown,
  activeTurnContext: Pick<ActiveTurnContext, "activeUserMessageIndex" | "imageUrls">,
): {
  message: string;
  extraSystemPrompt?: string;
} {
  const messages = asMessages(messagesUnknown);
  const hasActiveTurnImage =
    activeTurnContext.imageUrls.kind === "valid" && activeTurnContext.imageUrls.urls.length > 0;

  const systemParts: string[] = [];
  const conversationEntries: ConversationEntry[] = [];

  for (const [i, msg] of messages.entries()) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = normalizeOptionalString(msg.role) ?? "";
    const content = (
      role === "function" && msg.content === null ? "" : extractTextContent(msg.content)
    )?.trim();
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
    const assistantToolCallsSummary = assistantToolCalls.map(renderConversationToolCall).join("\n");

    // Keep the image-only placeholder scoped to the active user turn so we don't
    // mention historical image-only turns whose bytes are intentionally not replayed.
    const baseMessageContent =
      normalizedRole === "user" &&
      !content &&
      hasActiveTurnImage &&
      i === activeTurnContext.activeUserMessageIndex
        ? IMAGE_ONLY_USER_MESSAGE
        : content;
    const messageContent = [baseMessageContent, assistantToolCallsSummary]
      .filter((part): part is string => Boolean(part))
      .join("\n");
    const name = normalizeOptionalString(msg.name) ?? "";
    const toolCallId = normalizeOptionalString(msg.tool_call_id) ?? "";
    // Empty output completes a named call; absent or malformed content does not.
    const isToolResult =
      normalizedRole === "tool" &&
      Boolean(role === "function" ? name : toolCallId) &&
      content !== undefined &&
      (role !== "function" || typeof msg.content === "string" || msg.content === null);
    if (!messageContent && !isToolResult) {
      continue;
    }

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
      internalStreamError:
        normalizedRole === "assistant" &&
        normalizeOptionalString(msg.stopReason) === "error" &&
        messageContent.trim() === STREAM_ERROR_FALLBACK_TEXT,
    });
  }

  const message = buildAgentMessageFromConversationEntries(conversationEntries);

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

type PendingToolCall = {
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
};

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

function resolveChatCompletionUsage(result: unknown): OpenAiChatCompletionsUsage {
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

function resolveResponseFormat(value: unknown): Record<string, unknown> | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("response_format must be an object");
  }
  const obj = value as Record<string, unknown>;
  const type = obj.type;
  if (type !== "text" && type !== "json_object" && type !== "json_schema") {
    throw new Error("response_format.type must be text, json_object, or json_schema");
  }
  return obj;
}

function resolveStopSequences(value: unknown): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) {
    throw new Error("stop must be a string or array of strings");
  }
  // OpenAI Chat Completions accepts at most 4 stop sequences.
  if (list.length > 4) {
    throw new Error("stop supports at most 4 sequences");
  }
  const sequences: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("stop entries must be non-empty strings");
    }
    sequences.push(item);
  }
  return sequences.length > 0 ? sequences : undefined;
}

function resolveChatCompletionTokenCap(value: unknown, field: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  const maxTokens = asPositiveSafeInteger(value);
  if (maxTokens === undefined) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return maxTokens;
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
  const abortController = new AbortController();
  // The signal owns preparation; SSE installs presentation cleanup below.
  let onDisconnect = () => {};
  watchClientDisconnect(req, res, abortController, () => onDisconnect());
  const modelOverrideAuth = authorizeOpenAiCompatibleHttpModelOverride(req, handled.requestAuth);
  if (!modelOverrideAuth.allowed) {
    sendMissingScopeForbidden(res, modelOverrideAuth.missingScope);
    return true;
  }
  const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, handled.requestAuth);
  const payload = parseGatewayJsonRequest(res, handled.body, OpenAiChatCompletionRequestSchema);
  if (!payload) {
    return true;
  }
  const stream = payload.stream === true;
  const streamIncludeUsage = stream && resolveIncludeUsageForStreaming(payload);
  const model = typeof payload.model === "string" ? payload.model : "openclaw";
  const user = typeof payload.user === "string" ? payload.user : undefined;
  let maxTokens: number | undefined;
  try {
    const maxCompletionTokens = resolveChatCompletionTokenCap(
      payload.max_completion_tokens,
      "max_completion_tokens",
    );
    const legacyMaxTokens = resolveChatCompletionTokenCap(payload.max_tokens, "max_tokens");
    maxTokens = maxCompletionTokens ?? legacyMaxTokens;
  } catch (err) {
    sendInvalidRequest(res, formatErrorMessage(err).trim());
    return true;
  }
  const temperature = typeof payload.temperature === "number" ? payload.temperature : undefined;
  const topP = typeof payload.top_p === "number" ? payload.top_p : undefined;
  const frequencyPenalty =
    typeof payload.frequency_penalty === "number" ? payload.frequency_penalty : undefined;
  const presencePenalty =
    typeof payload.presence_penalty === "number" ? payload.presence_penalty : undefined;
  const seed = typeof payload.seed === "number" ? payload.seed : undefined;
  let responseFormat: Record<string, unknown> | undefined;
  try {
    responseFormat = resolveResponseFormat(payload.response_format);
  } catch (err) {
    sendInvalidRequest(res, `Invalid response_format: ${formatErrorMessage(err).trim()}`);
    return true;
  }
  let stop: string[] | undefined;
  try {
    stop = resolveStopSequences(payload.stop);
  } catch (err) {
    sendInvalidRequest(res, `Invalid stop: ${formatErrorMessage(err).trim()}`);
    return true;
  }
  const samplingError = validateOpenAiSamplingParams({
    temperature: payload.temperature,
    topP: payload.top_p,
    frequencyPenalty: payload.frequency_penalty,
    presencePenalty: payload.presence_penalty,
    seed: payload.seed,
  });
  if (samplingError) {
    sendInvalidRequest(res, samplingError);
    return true;
  }
  const streamParams =
    maxTokens !== undefined ||
    temperature !== undefined ||
    topP !== undefined ||
    responseFormat !== undefined ||
    frequencyPenalty !== undefined ||
    presencePenalty !== undefined ||
    seed !== undefined ||
    stop !== undefined
      ? {
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(topP !== undefined ? { topP } : {}),
          ...(responseFormat !== undefined ? { responseFormat } : {}),
          ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
          ...(presencePenalty !== undefined ? { presencePenalty } : {}),
          ...(seed !== undefined ? { seed } : {}),
          ...(stop !== undefined ? { stop } : {}),
        }
      : undefined;

  let agentId: string;
  let sessionKey: string;
  let messageChannel: string;
  try {
    ({ agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
      req,
      model,
      user,
      sessionPrefix: "openai",
      defaultMessageChannel: "webchat",
      useMessageChannelHeader: true,
    }));
  } catch (err) {
    if (
      isAgentSelectionRequiredError(err) ||
      isUnknownGatewayAgentError(err) ||
      isInvalidGatewayModelError(err) ||
      isGatewaySessionKeyOverrideError(err)
    ) {
      sendInvalidRequest(res, err.message);
      return true;
    }
    throw err;
  }
  const creationAuth = authorizeGatewaySessionCreation({
    cfg: getRuntimeConfig(),
    ...(handled.requestAuth.operatorRoleActor
      ? { actor: handled.requestAuth.operatorRoleActor }
      : { profileId: handled.requestAuth.authenticatedUserProfile?.profileId }),
    agentId,
  });
  if (creationAuth) {
    sendJson(res, 403, {
      error: { message: creationAuth.message, type: "forbidden" },
    });
    return true;
  }
  const sessionAuth = authorizeOpenAiCompatibleHttpSession({
    agentId,
    sessionKey,
    requestAuth: handled.requestAuth,
    senderIsOwner,
  });
  if (!sessionAuth.allowed) {
    sendJson(res, 403, { error: { message: sessionAuth.message, type: "forbidden" } });
    return true;
  }
  const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
    req,
    agentId,
    model,
  });
  if (modelError) {
    sendInvalidRequest(res, modelError);
    return true;
  }
  const activeTurnContext = resolveActiveTurnContext(payload.messages);
  const prompt = buildAgentPrompt(payload.messages, activeTurnContext);
  let resolvedClientTools: ClientToolDefinition[];
  let toolChoicePrompt: string | undefined;
  let toolChoiceConstraint: ToolChoiceConstraint | undefined;
  try {
    const parsedClientTools = extractClientToolsFromChatRequest(payload.tools);
    const toolChoiceResult = applyToolChoice(
      parsedClientTools,
      resolveChatToolChoice(payload.tool_choice),
    );
    resolvedClientTools = toolChoiceResult.tools;
    toolChoicePrompt = toolChoiceResult.extraSystemPrompt;
    toolChoiceConstraint = toolChoiceResult.constraint;
  } catch (err) {
    sendInvalidRequest(res, `Invalid tools/tool_choice: ${formatErrorMessage(err).trim()}`);
    return true;
  }
  let images: ImageContent[];
  try {
    images = await resolveImagesForRequest(activeTurnContext, limits, abortController.signal);
  } catch (err) {
    if (abortController.signal.aborted) {
      return true;
    }
    logWarn(`openai-compat: invalid image_url content: ${String(err)}`);
    sendInvalidRequest(res, "Invalid image_url content in `messages`.");
    return true;
  }

  if (!prompt.message && images.length === 0) {
    sendInvalidRequest(res, "Missing user message in `messages`.");
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const streamIdentity = { runId, model, created };
  const deps = createDefaultDeps();
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
    senderIsOwner,
    abortSignal: abortController.signal,
    streamParams,
  });
  const gatewayCommandInput = opts.resolveGatewayContext
    ? {
        ...commandInput,
        onAdmittedRunContext: (context: AdmittedRunContext) =>
          bindGatewayContextResolver(context, opts.resolveGatewayContext),
      }
    : commandInput;

  if (!stream) {
    try {
      const result = await agentCommandFromGatewayIngress(
        gatewayCommandInput,
        defaultRuntime,
        deps,
        {},
      );

      if (abortController.signal.aborted) {
        return true;
      }

      const meta = (result as { meta?: { error?: unknown; stopReason?: unknown } } | null)?.meta;
      if (readAgentRunTerminalOutcome(result) === "failed") {
        throw new Error("agent run failed");
      }
      const usage = resolveChatCompletionUsage(result);
      const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);

      // `tool_choice` is an HTTP client-tool contract. The provider may still
      // ignore the prompt, so enforce after the run using structured pending
      // client tool calls instead of accepting prose that only says it called.
      if (
        toolChoiceConstraint &&
        !isToolChoiceConstraintSatisfied({
          constraint: toolChoiceConstraint,
          pendingToolCalls,
        })
      ) {
        sendJson(res, 502, {
          error: {
            message: resolveUnsatisfiedToolChoiceMessage(toolChoiceConstraint),
            type: "api_error",
          },
        });
        return true;
      }

      if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
        const commentary = resolveAssistantResultText(result) ?? "";
        sendJson(res, 200, {
          id: runId,
          object: "chat.completion",
          created,
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
      const content = resolveAssistantResultText(result) || "No response from OpenClaw.";

      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: stopReason === "length" ? "length" : "stop",
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
        sendInvalidRequest(res, "invalid tool configuration");
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
    }
    return true;
  }

  setSseHeaders(res);

  let wroteStopChunk = false;
  let streamedAssistantText = "";
  let assistantText: AssistantTextSnapshot = { text: "" };
  let pendingAssistantText: AssistantTextSnapshot | undefined;
  let finalResultText: string | undefined;
  let finalFinishReason: "stop" | "length" = "stop";
  let finalToolCalls: ReturnType<typeof resolveStopReasonAndPendingToolCalls>["pendingToolCalls"];
  let finalUsage: OpenAiChatCompletionsUsage | undefined;
  let finalizeRequested = false;
  let finalizeScheduled = false;
  let resultResolved = false;
  let closed = false;
  let observedTerminalLifecycle = false;
  let terminalStreamError: { message: string; type: string; code?: string } | undefined;
  let terminalLifecyclePhase: "end" | "error" = "end";

  const maybeFinalize = () => {
    if (closed || finalizeScheduled || !finalizeRequested) {
      return;
    }
    if (!resultResolved) {
      return;
    }
    if (streamIncludeUsage && !finalUsage) {
      return;
    }
    // Agent text_end flushes run in a microtask. Keep the stream subscribed
    // until those same-turn deltas arrive, then emit exactly one terminal frame.
    finalizeScheduled = true;
    queueMicrotask(() => {
      if (closed) {
        return;
      }
      if (terminalStreamError) {
        finishStreamWithError(terminalStreamError);
        return;
      }
      const text = resolveAssistantTextCompletion({
        assistantText,
        pending: pendingAssistantText,
        resultText: finalResultText,
        streamedText: streamedAssistantText,
        fallbackText: finalToolCalls ? "" : "No response from OpenClaw.",
      });
      if (!text.startsWith(streamedAssistantText)) {
        finishStreamWithError({
          message: "Assistant output cannot be represented as an append-only response stream.",
          type: "api_error",
        });
        return;
      }
      const content = text.slice(streamedAssistantText.length);
      if (content) {
        writeAssistantContentChunk(res, { ...streamIdentity, content });
      }
      streamedAssistantText = text;
      if (finalToolCalls) {
        writeAssistantToolCallsIncrementalChunks(res, {
          ...streamIdentity,
          toolCalls: finalToolCalls,
        });
      }
      closed = true;
      unsubscribe();
      if (!wroteStopChunk) {
        writeAssistantFinishChunk(res, {
          ...streamIdentity,
          finishReason: finalToolCalls ? "tool_calls" : finalFinishReason,
        });
        wroteStopChunk = true;
      }
      if (streamIncludeUsage && finalUsage) {
        writeUsageChunk(res, { ...streamIdentity, usage: finalUsage });
      }
      writeDone(res);
      res.end();
    });
  };

  const requestFinalize = () => {
    finalizeRequested = true;
    maybeFinalize();
  };

  const unsubscribe = onAgentEventForRun(runId, (evt) => {
    if (evt.runId !== runId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const input = resolveAssistantTextInput(evt.data);
      if (!input) {
        return;
      }
      // Once a provisional replacement begins, even its terminal text echo
      // stays held until the run result selects the authoritative output.
      if (input.replaceable || pendingAssistantText) {
        pendingAssistantText = mergePendingAssistantText(
          pendingAssistantText ?? assistantText,
          input,
        );
        return;
      }

      assistantText = mergeAssistantText(assistantText, input, "append-only");
      // Hold prose until the run proves the requested client-tool call exists.
      if (toolChoiceConstraint) {
        return;
      }
      // SSE cannot retract bytes already delivered, even for an item correction.
      if (!assistantText.text.startsWith(streamedAssistantText)) {
        terminalStreamError ??= {
          message: "Assistant output cannot be represented as an append-only response stream.",
          type: "api_error",
        };
        return;
      }
      const content = assistantText.text.slice(streamedAssistantText.length);
      if (!content) {
        return;
      }
      streamedAssistantText = assistantText.text;
      writeAssistantContentChunk(res, { ...streamIdentity, content });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "start") {
        observedTerminalLifecycle = false;
      }
      if (phase === "end" || phase === "error") {
        observedTerminalLifecycle = true;
        if (phase === "error" && terminalLifecyclePhase !== "error") {
          terminalStreamError ??= {
            message: normalizeOptionalString(evt.data?.error) ?? "Agent run failed",
            type: "api_error",
          };
        }
        requestFinalize();
      }
    }
  });

  const finishStreamWithError = (error: { message: string; type: string; code?: string }) => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe();
    writeSse(res, { error });
    writeDone(res);
    res.end();
  };

  // Agent cleanup and deferred SSE delivery have independent lifetimes;
  // shutdown must wait until both have settled, whichever finishes last.
  const releaseAgentRootWork = retainGatewayRootWorkAdmissionContinuation();
  const releaseResponseRootWork = retainGatewayRootWorkAdmissionContinuation();
  const releaseStreamRootWork = () => {
    res.off("finish", releaseStreamRootWork);
    res.off("close", releaseStreamRootWork);
    releaseResponseRootWork?.();
  };
  res.once("finish", releaseStreamRootWork);
  res.once("close", releaseStreamRootWork);

  onDisconnect = () => {
    closed = true;
    unsubscribe();
    releaseStreamRootWork();
  };

  writeAssistantRoleChunk(res, streamIdentity);

  void (async () => {
    try {
      const result = await agentCommandFromGatewayIngress(
        gatewayCommandInput,
        defaultRuntime,
        deps,
        {},
      );
      resultResolved = true;

      if (closed) {
        return;
      }

      if (readAgentRunTerminalOutcome(result) === "failed") {
        terminalLifecyclePhase = "error";
        finishStreamWithError({ message: "internal error", type: "api_error" });
        return;
      }

      if (terminalStreamError) {
        finishStreamWithError(terminalStreamError);
        return;
      }

      finalUsage = resolveChatCompletionUsage(result);
      const meta = (result as { meta?: unknown } | null)?.meta;
      const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);

      // Streaming enforces the same post-run client-tool contract as the
      // non-streaming path; buffered assistant prose is only flushed when the
      // matching structured call is present.
      if (
        toolChoiceConstraint &&
        !isToolChoiceConstraintSatisfied({
          constraint: toolChoiceConstraint,
          pendingToolCalls,
        })
      ) {
        finishStreamWithError({
          message: resolveUnsatisfiedToolChoiceMessage(toolChoiceConstraint),
          type: "api_error",
        });
        return;
      }

      finalResultText = resolveAssistantResultText(result);
      finalFinishReason = stopReason === "length" ? "length" : "stop";
      finalToolCalls =
        stopReason === "tool_calls" && pendingToolCalls?.length ? pendingToolCalls : undefined;
      requestFinalize();
    } catch (err) {
      resultResolved = true;
      if (closed || abortController.signal.aborted) {
        return;
      }
      terminalLifecyclePhase = "error";
      logWarn(`openai-compat: streaming chat completion failed: ${String(err)}`);
      if (isClientToolNameConflictError(err)) {
        finishStreamWithError({
          message: "invalid tool configuration",
          type: "invalid_request_error",
        });
        return;
      }
      const mapped = resolveOpenAiCompatError(err);
      if (mapped) {
        finishStreamWithError(mapped.error);
        return;
      }
      if (terminalStreamError) {
        finishStreamWithError(terminalStreamError);
        return;
      }
      finishStreamWithError({ message: "internal error", type: "api_error" });
    } finally {
      releaseAgentRootWork?.();
      // The provider owns observed terminals; a second end would erase a failed session.
      if (!observedTerminalLifecycle && (terminalLifecyclePhase === "error" || !closed)) {
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: terminalLifecyclePhase },
        });
      }
    }
  })();

  return true;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
