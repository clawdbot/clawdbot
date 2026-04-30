import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  calculateCost,
  getEnvApiKey,
  parseStreamingJson,
  type AnthropicOptions,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "@mariozechner/pi-ai";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "./anthropic-payload-policy.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { resolveProviderEndpoint } from "./provider-attribution.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { transformTransportMessages } from "./transport-message-transform.js";
import {
  coerceTransportToolCallArguments,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";

const CLAUDE_CODE_VERSION = "2.1.75";
const CLAUDE_CODE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
] as const;
const CLAUDE_CODE_TOOL_LOOKUP = new Map(
  CLAUDE_CODE_TOOLS.map((tool) => [normalizeLowercaseStringOrEmpty(tool), tool]),
);
type AnthropicTransportModel = Model<"anthropic-messages"> & {
  headers?: Record<string, string>;
  provider: string;
};

type AnthropicTransportOptions = AnthropicOptions &
  Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets">;
type AnthropicAdaptiveEffort = NonNullable<AnthropicOptions["effort"]> | "xhigh";
type AnthropicMessagesClient = {
  messages: {
    stream(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<Record<string, unknown>>;
  };
};

type TransportContentBlock =
  | { type: "text"; text: string; index?: number }
  | {
      type: "thinking";
      thinking: string;
      thinkingSignature: string;
      redacted?: boolean;
      index?: number;
    }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: unknown;
      partialJson?: string;
      index?: number;
    };

type MutableAssistantOutput = {
  role: "assistant";
  content: Array<TransportContentBlock>;
  api: "anthropic-messages";
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

function isClaudeOpus47Model(modelId: string): boolean {
  return modelId.includes("opus-4-7") || modelId.includes("opus-4.7");
}

function isClaudeOpus46Model(modelId: string): boolean {
  return modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}

function supportsAdaptiveThinking(modelId: string): boolean {
  return (
    isClaudeOpus47Model(modelId) ||
    isClaudeOpus46Model(modelId) ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

function mapThinkingLevelToEffort(level: ThinkingLevel, modelId: string): AnthropicAdaptiveEffort {
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "xhigh":
      if (isClaudeOpus47Model(modelId)) {
        return "xhigh";
      }
      return isClaudeOpus46Model(modelId) ? "max" : "high";
    default:
      return "high";
  }
}

function clampReasoningLevel(level: ThinkingLevel): "minimal" | "low" | "medium" | "high" {
  return level === "xhigh" ? "high" : level;
}

function resolvePositiveAnthropicMaxTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

function resolveAnthropicMessagesMaxTokens(params: {
  modelMaxTokens: number | undefined;
  requestedMaxTokens: number | undefined;
}): number | undefined {
  const requested = resolvePositiveAnthropicMaxTokens(params.requestedMaxTokens);
  if (requested !== undefined) {
    return requested;
  }
  const modelMax = resolvePositiveAnthropicMaxTokens(params.modelMaxTokens);
  return modelMax !== undefined ? Math.min(modelMax, 32_000) : undefined;
}

function adjustMaxTokensForThinking(params: {
  baseMaxTokens: number;
  modelMaxTokens: number;
  reasoningLevel: ThinkingLevel;
  customBudgets?: SimpleStreamOptions["thinkingBudgets"];
}): { maxTokens: number; thinkingBudget: number } {
  const budgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    ...params.customBudgets,
  };
  const minOutputTokens = 1024;
  const level = clampReasoningLevel(params.reasoningLevel);
  let thinkingBudget = budgets[level];
  const maxTokens = Math.min(params.baseMaxTokens + thinkingBudget, params.modelMaxTokens);
  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }
  return { maxTokens, thinkingBudget };
}

function isAnthropicOAuthToken(apiKey: string): boolean {
  return apiKey.includes("sk-ant-oat");
}

function isDirectAnthropicModel(model: Pick<AnthropicTransportModel, "provider" | "baseUrl">) {
  if (normalizeLowercaseStringOrEmpty(model.provider) !== "anthropic") {
    return false;
  }
  const endpointClass = resolveProviderEndpoint(model.baseUrl).endpointClass;
  return endpointClass === "default" || endpointClass === "anthropic-public";
}

function buildAnthropicBetaHeader(
  model: AnthropicTransportModel,
  betaFeatures: readonly string[],
  params: { oauth: boolean },
): string | undefined {
  if (!isDirectAnthropicModel(model)) {
    return undefined;
  }
  return params.oauth
    ? `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`
    : betaFeatures.join(",");
}

function toClaudeCodeName(name: string): string {
  return CLAUDE_CODE_TOOL_LOOKUP.get(normalizeLowercaseStringOrEmpty(name)) ?? name;
}

function fromClaudeCodeName(name: string, tools: Context["tools"] | undefined): string {
  if (tools && tools.length > 0) {
    const lowerName = normalizeLowercaseStringOrEmpty(name);
    const matchedTool = tools.find(
      (tool) => normalizeLowercaseStringOrEmpty(tool.name) === lowerName,
    );
    if (matchedTool) {
      return matchedTool.name;
    }
  }
  return name;
}

function convertContentBlocks(
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >,
) {
  const hasImages = content.some((item) => item.type === "image");
  if (!hasImages) {
    return sanitizeNonEmptyTransportPayloadText(
      content.map((item) => ("text" in item ? item.text : "")).join("\n"),
    );
  }
  const blocks: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: string; data: string };
      }
  > = [];
  for (const block of content) {
    if (block.type === "text") {
      const text = sanitizeTransportPayloadText(block.text);
      if (text.trim().length > 0) {
        blocks.push({ type: "text", text });
      }
    } else {
      blocks.push({
        type: "image" as const,
        source: {
          type: "base64",
          media_type: block.mimeType,
          data: block.data,
        },
      });
    }
  }
  if (!blocks.some((block) => block.type === "text")) {
    blocks.unshift({
      type: "text",
      text: "(see attached image)",
    });
  }
  return blocks;
}

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertAnthropicMessages(
  messages: Context["messages"],
  model: AnthropicTransportModel,
  isOAuthToken: boolean,
) {
  const params: Array<Record<string, unknown>> = [];
  const transformedMessages = transformTransportMessages(messages, model, normalizeToolCallId);
  for (let i = 0; i < transformedMessages.length; i += 1) {
    const msg = transformedMessages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          params.push({
            role: "user",
            content: sanitizeTransportPayloadText(msg.content),
          });
        }
        continue;
      }
      const blocks: Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: { type: "base64"; media_type: string; data: string };
          }
      > = msg.content.map((item) =>
        item.type === "text"
          ? {
              type: "text",
              text: sanitizeTransportPayloadText(item.text),
            }
          : {
              type: "image",
              source: {
                type: "base64",
                media_type: item.mimeType,
                data: item.data,
              },
            },
      );
      let filteredBlocks = model.input.includes("image")
        ? blocks
        : blocks.filter((block) => block.type !== "image");
      filteredBlocks = filteredBlocks.filter(
        (block) => block.type !== "text" || block.text.trim().length > 0,
      );
      if (filteredBlocks.length === 0) {
        continue;
      }
      params.push({
        role: "user",
        content: filteredBlocks,
      });
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            blocks.push({
              type: "text",
              text: sanitizeTransportPayloadText(block.text),
            });
          }
          continue;
        }
        if (block.type === "thinking") {
          if (block.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature,
            });
            continue;
          }
          if (block.thinking.trim().length === 0) {
            continue;
          }
          if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
            blocks.push({
              type: "text",
              text: sanitizeTransportPayloadText(block.thinking),
            });
          } else {
            blocks.push({
              type: "thinking",
              thinking: sanitizeTransportPayloadText(block.thinking),
              signature: block.thinkingSignature,
            });
          }
          continue;
        }
        if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
            input: coerceTransportToolCallArguments(block.arguments),
          });
        }
      }
      if (blocks.length > 0) {
        params.push({
          role: "assistant",
          content: blocks,
        });
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const toolResult = msg;
      const toolResults: Array<Record<string, unknown>> = [
        {
          type: "tool_result",
          tool_use_id: toolResult.toolCallId,
          content: convertContentBlocks(toolResult.content),
          is_error: toolResult.isError,
        },
      ];
      let j = i + 1;
      while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
        const nextMsg = transformedMessages[j] as Extract<
          Context["messages"][number],
          { role: "toolResult" }
        >;
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: convertContentBlocks(nextMsg.content),
          is_error: nextMsg.isError,
        });
        j += 1;
      }
      i = j - 1;
      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }
  return params;
}

function convertAnthropicTools(tools: Context["tools"], isOAuthToken: boolean) {
  if (!tools) {
    return [];
  }
  return tools.flatMap((tool) => {
    // Main quarantine happens when plugin tools materialize; this keeps Anthropic
    // safe for direct/custom tool arrays that bypass the plugin registry.
    const parameters =
      tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
        ? (tool.parameters as Record<string, unknown>)
        : undefined;
    if (!parameters) {
      return [];
    }
    return [
      {
        name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
        description: tool.description,
        input_schema: {
          type: "object",
          properties: parameters.properties || {},
          required: parameters.required || [],
        },
      },
    ];
  });
}

function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "pause_turn":
      return "stop";
    case "refusal":
    case "sensitive":
      return "error";
    case "stop_sequence":
      return "stop";
    default:
      throw new Error(`Unhandled stop reason: ${String(reason)}`);
  }
}

function resolveAnthropicMessagesUrl(baseUrl?: string): string {
  const normalized = (baseUrl?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error =
    reason === undefined
      ? new Error("Request was aborted")
      : new Error("Request was aborted", { cause: reason });
  error.name = "AbortError";
  return error;
}

function readAnthropicSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reader.cancel(signal.reason).catch(() => undefined);
      reject(createAbortError(signal));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function parseAnthropicSseEventData(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause: error });
    }
    throw error;
  }
}

async function* parseAnthropicSseBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await readAnthropicSseChunk(reader, signal);
      if (done) {
        break;
      }
      buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replaceAll("\r\n", "\n");
      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd >= 0) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          yield parseAnthropicSseEventData(data);
        }
        frameEnd = buffer.indexOf("\n\n");
      }
    }
    const tail = `${buffer}${decoder.decode()}`.replaceAll("\r\n", "\n").trim();
    if (tail) {
      const data = tail
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") {
        yield parseAnthropicSseEventData(data);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function createAnthropicMessagesClient(params: {
  apiKey?: string | null;
  authToken?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  fetch: typeof fetch;
}): AnthropicMessagesClient {
  const url = resolveAnthropicMessagesUrl(params.baseURL);
  return {
    messages: {
      async *stream(body: Record<string, unknown>, options?: { signal?: AbortSignal }) {
        const headers = mergeTransportHeaders(
          {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            ...(params.apiKey ? { "x-api-key": params.apiKey } : {}),
            ...(params.authToken ? { authorization: `Bearer ${params.authToken}` } : {}),
          },
          params.defaultHeaders,
        );
        const response = await params.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(
            detail || `Anthropic Messages request failed with HTTP ${response.status}`,
          );
        }
        if (!response.body) {
          return;
        }
        yield* parseAnthropicSseBody(response.body, options?.signal);
      },
    },
  };
}

function createAnthropicTransportClient(params: {
  model: AnthropicTransportModel;
  context: Context;
  apiKey: string;
  options: AnthropicTransportOptions | undefined;
}) {
  const { model, context, apiKey, options } = params;
  const needsInterleavedBeta =
    (options?.interleavedThinking ?? true) && !supportsAdaptiveThinking(model.id);
  const fetch = buildGuardedModelFetch(model);
  if (model.provider === "github-copilot") {
    const betaFeatures = needsInterleavedBeta ? ["interleaved-thinking-2025-05-14"] : [];
    return {
      client: createAnthropicMessagesClient({
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        defaultHeaders: mergeTransportHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
          },
          model.headers,
          buildCopilotDynamicHeaders({
            messages: context.messages,
            hasImages: hasCopilotVisionInput(context.messages),
          }),
          options?.headers,
        ),
        fetch,
      }),
      isOAuthToken: false,
    };
  }
  const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
  if (needsInterleavedBeta) {
    betaFeatures.push("interleaved-thinking-2025-05-14");
  }
  if (isAnthropicOAuthToken(apiKey)) {
    const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: true });
    return {
      client: createAnthropicMessagesClient({
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        defaultHeaders: mergeTransportHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
            "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
            "x-app": "cli",
          },
          model.headers,
          options?.headers,
        ),
        fetch,
      }),
      isOAuthToken: true,
    };
  }
  const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: false });
  return {
    client: createAnthropicMessagesClient({
      apiKey,
      baseURL: model.baseUrl,
      defaultHeaders: mergeTransportHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
        },
        model.headers,
        options?.headers,
      ),
      fetch,
    }),
    isOAuthToken: false,
  };
}

function buildAnthropicParams(
  model: AnthropicTransportModel,
  context: Context,
  isOAuthToken: boolean,
  options: AnthropicTransportOptions | undefined,
) {
  const maxTokens = resolveAnthropicMessagesMaxTokens({
    modelMaxTokens: model.maxTokens,
    requestedMaxTokens: options?.maxTokens,
  });
  if (maxTokens === undefined) {
    throw new Error(
      `Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`,
    );
  }
  const payloadPolicy = resolveAnthropicPayloadPolicy({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    cacheRetention: options?.cacheRetention,
    enableCacheControl: true,
  });
  const params: Record<string, unknown> = {
    model: model.id,
    messages: convertAnthropicMessages(context.messages, model, isOAuthToken),
    max_tokens: maxTokens,
    stream: true,
  };
  if (isOAuthToken) {
    params.system = [
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      ...(context.systemPrompt
        ? [
            {
              type: "text",
              text: sanitizeTransportPayloadText(context.systemPrompt),
            },
          ]
        : []),
    ];
  } else if (context.systemPrompt) {
    params.system = [
      {
        type: "text",
        text: sanitizeTransportPayloadText(context.systemPrompt),
      },
    ];
  }
  if (options?.temperature !== undefined && !options.thinkingEnabled) {
    params.temperature = options.temperature;
  }
  if (context.tools) {
    params.tools = convertAnthropicTools(context.tools, isOAuthToken);
  }
  if (model.reasoning) {
    if (options?.thinkingEnabled) {
      if (supportsAdaptiveThinking(model.id)) {
        params.thinking = { type: "adaptive" };
        if (options.effort) {
          params.output_config = { effort: options.effort };
        }
      } else {
        params.thinking = {
          type: "enabled",
          budget_tokens: options.thinkingBudgetTokens || 1024,
        };
      }
    } else if (options?.thinkingEnabled === false) {
      params.thinking = { type: "disabled" };
    }
  }
  if (options?.metadata && typeof options.metadata.user_id === "string") {
    params.metadata = { user_id: options.metadata.user_id };
  }
  if (options?.toolChoice) {
    params.tool_choice =
      typeof options.toolChoice === "string" ? { type: options.toolChoice } : options.toolChoice;
  }
  applyAnthropicPayloadPolicyToParams(params, payloadPolicy);
  return params;
}

function resolveAnthropicTransportOptions(
  model: AnthropicTransportModel,
  options: AnthropicTransportOptions | undefined,
  apiKey: string,
): AnthropicTransportOptions {
  const baseMaxTokens = resolveAnthropicMessagesMaxTokens({
    modelMaxTokens: model.maxTokens,
    requestedMaxTokens: options?.maxTokens,
  });
  if (baseMaxTokens === undefined) {
    throw new Error(
      `Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`,
    );
  }
  const reasoningModelMaxTokens =
    resolvePositiveAnthropicMaxTokens(model.maxTokens) ?? baseMaxTokens;
  const resolved: AnthropicTransportOptions = {
    temperature: options?.temperature,
    maxTokens: baseMaxTokens,
    signal: options?.signal,
    apiKey,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
    interleavedThinking: options?.interleavedThinking,
    toolChoice: options?.toolChoice,
    thinkingBudgets: options?.thinkingBudgets,
    reasoning: options?.reasoning,
  };
  if (!options?.reasoning) {
    resolved.thinkingEnabled = false;
    return resolved;
  }
  if (supportsAdaptiveThinking(model.id)) {
    resolved.thinkingEnabled = true;
    resolved.effort = mapThinkingLevelToEffort(options.reasoning, model.id) as NonNullable<
      AnthropicOptions["effort"]
    >;
    return resolved;
  }
  const adjusted = adjustMaxTokensForThinking({
    baseMaxTokens,
    modelMaxTokens: reasoningModelMaxTokens,
    reasoningLevel: options.reasoning,
    customBudgets: options.thinkingBudgets,
  });
  resolved.maxTokens = adjusted.maxTokens;
  resolved.thinkingEnabled = true;
  resolved.thinkingBudgetTokens = adjusted.thinkingBudget;
  return resolved;
}

export function createAnthropicMessagesTransportStreamFn(): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = rawModel as AnthropicTransportModel;
    const options = rawOptions as AnthropicTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: model.provider,
        model: model.id,
        usage: createEmptyTransportUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        const transportOptions = resolveAnthropicTransportOptions(model, options, apiKey);
        const { client, isOAuthToken } = createAnthropicTransportClient({
          model,
          context,
          apiKey,
          options: transportOptions,
        });
        let params = buildAnthropicParams(model, context, isOAuthToken, transportOptions);
        const nextParams = await transportOptions.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as Record<string, unknown>;
        }
        const anthropicStream = client.messages.stream(
          { ...params, stream: true },
          transportOptions.signal ? { signal: transportOptions.signal } : undefined,
        );
        stream.push({ type: "start", partial: output as never });
        const blocks = output.content;
        for await (const event of anthropicStream) {
          if (event.type === "error") {
            const error = event.error as { message?: string } | undefined;
            throw new Error(error?.message || "Anthropic Messages stream failed");
          }
          if (event.type === "message_start") {
            const message = event.message as
              | { id?: string; usage?: Record<string, unknown> }
              | undefined;
            const usage = message?.usage ?? {};
            output.responseId = typeof message?.id === "string" ? message.id : undefined;
            output.usage.input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
            output.usage.output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
            output.usage.cacheRead =
              typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
            output.usage.cacheWrite =
              typeof usage.cache_creation_input_tokens === "number"
                ? usage.cache_creation_input_tokens
                : 0;
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            calculateCost(model, output.usage);
            continue;
          }
          if (event.type === "content_block_start") {
            const contentBlock = event.content_block as Record<string, unknown> | undefined;
            const index = typeof event.index === "number" ? event.index : -1;
            if (contentBlock?.type === "text") {
              const text =
                typeof contentBlock.text === "string"
                  ? sanitizeTransportPayloadText(contentBlock.text)
                  : "";
              const block: TransportContentBlock = { type: "text", text, index };
              output.content.push(block);
              const contentIndex = output.content.length - 1;
              stream.push({
                type: "text_start",
                contentIndex,
                partial: output as never,
              });
              if (text.length > 0) {
                stream.push({
                  type: "text_delta",
                  contentIndex,
                  delta: text,
                  partial: output as never,
                });
              }
              continue;
            }
            if (contentBlock?.type === "thinking") {
              const thinking =
                typeof contentBlock.thinking === "string"
                  ? sanitizeTransportPayloadText(contentBlock.thinking)
                  : "";
              const block: TransportContentBlock = {
                type: "thinking",
                thinking,
                thinkingSignature:
                  typeof contentBlock.signature === "string" ? contentBlock.signature : "",
                index,
              };
              output.content.push(block);
              const contentIndex = output.content.length - 1;
              stream.push({
                type: "thinking_start",
                contentIndex,
                partial: output as never,
              });
              if (thinking.length > 0) {
                stream.push({
                  type: "thinking_delta",
                  contentIndex,
                  delta: thinking,
                  partial: output as never,
                });
              }
              continue;
            }
            if (contentBlock?.type === "redacted_thinking") {
              const block: TransportContentBlock = {
                type: "thinking",
                thinking: "[Reasoning redacted]",
                thinkingSignature: typeof contentBlock.data === "string" ? contentBlock.data : "",
                redacted: true,
                index,
              };
              output.content.push(block);
              stream.push({
                type: "thinking_start",
                contentIndex: output.content.length - 1,
                partial: output as never,
              });
              continue;
            }
            if (contentBlock?.type === "tool_use") {
              const block: TransportContentBlock = {
                type: "toolCall",
                id: typeof contentBlock.id === "string" ? contentBlock.id : "",
                name:
                  typeof contentBlock.name === "string"
                    ? isOAuthToken
                      ? fromClaudeCodeName(contentBlock.name, context.tools)
                      : contentBlock.name
                    : "",
                arguments:
                  contentBlock.input && typeof contentBlock.input === "object"
                    ? (contentBlock.input as Record<string, unknown>)
                    : {},
                partialJson: "",
                index,
              };
              output.content.push(block);
              stream.push({
                type: "toolcall_start",
                contentIndex: output.content.length - 1,
                partial: output as never,
              });
            }
            continue;
          }
          if (event.type === "content_block_delta") {
            const index = blocks.findIndex((block) => block.index === event.index);
            const block = blocks[index];
            const delta = event.delta as Record<string, unknown> | undefined;
            if (
              block?.type === "text" &&
              delta?.type === "text_delta" &&
              typeof delta.text === "string"
            ) {
              block.text += delta.text;
              stream.push({
                type: "text_delta",
                contentIndex: index,
                delta: delta.text,
                partial: output as never,
              });
              continue;
            }
            if (
              block?.type === "thinking" &&
              delta?.type === "thinking_delta" &&
              typeof delta.thinking === "string"
            ) {
              block.thinking += delta.thinking;
              stream.push({
                type: "thinking_delta",
                contentIndex: index,
                delta: delta.thinking,
                partial: output as never,
              });
              continue;
            }
            if (
              block?.type === "toolCall" &&
              delta?.type === "input_json_delta" &&
              typeof delta.partial_json === "string"
            ) {
              block.partialJson += delta.partial_json;
              block.arguments = parseStreamingJson(block.partialJson);
              stream.push({
                type: "toolcall_delta",
                contentIndex: index,
                delta: delta.partial_json,
                partial: output as never,
              });
              continue;
            }
            if (
              block?.type === "thinking" &&
              delta?.type === "signature_delta" &&
              typeof delta.signature === "string"
            ) {
              block.thinkingSignature = delta.signature;
            }
            continue;
          }
          if (event.type === "content_block_stop") {
            const index = blocks.findIndex((block) => block.index === event.index);
            const block = blocks[index];
            if (!block) {
              continue;
            }
            delete block.index;
            if (block.type === "text") {
              stream.push({
                type: "text_end",
                contentIndex: index,
                content: block.text,
                partial: output as never,
              });
              continue;
            }
            if (block.type === "thinking") {
              stream.push({
                type: "thinking_end",
                contentIndex: index,
                content: block.thinking,
                partial: output as never,
              });
              continue;
            }
            if (block.type === "toolCall") {
              if (typeof block.partialJson === "string" && block.partialJson.length > 0) {
                block.arguments = parseStreamingJson(block.partialJson);
              }
              delete block.partialJson;
              stream.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall: block as never,
                partial: output as never,
              });
            }
            continue;
          }
          if (event.type === "message_delta") {
            const delta = event.delta as { stop_reason?: string } | undefined;
            const usage = event.usage as Record<string, unknown> | undefined;
            if (delta?.stop_reason) {
              output.stopReason = mapStopReason(delta.stop_reason);
            }
            if (typeof usage?.input_tokens === "number") {
              output.usage.input = usage.input_tokens;
            }
            if (typeof usage?.output_tokens === "number") {
              output.usage.output = usage.output_tokens;
            }
            if (typeof usage?.cache_read_input_tokens === "number") {
              output.usage.cacheRead = usage.cache_read_input_tokens;
            }
            if (typeof usage?.cache_creation_input_tokens === "number") {
              output.usage.cacheWrite = usage.cache_creation_input_tokens;
            }
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            calculateCost(model, output.usage);
          }
        }
        finalizeTransportStream({ stream, output, signal: transportOptions.signal });
      } catch (error) {
        failTransportStream({
          stream,
          output,
          signal: options?.signal,
          error,
          cleanup: () => {
            for (const block of output.content) {
              delete block.index;
            }
          },
        });
      }
    })();
    return eventStream as ReturnType<StreamFn>;
  };
}
