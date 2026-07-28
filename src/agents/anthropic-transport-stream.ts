import {
  ANTHROPIC_OMITTED_REASONING_TEXT,
  ANTHROPIC_SERVER_SIDE_FALLBACK_BETA,
  CLAUDE_FABLE_5_FALLBACK_MODEL_COST,
  applyClaudeRequestContract,
  applyAnthropicFallbackBoundary,
  buildAnthropicServerSideFallbacks,
  defaultsClaudeAdaptiveThinking,
  applyAnthropicRefusal,
  findActiveAnthropicToolTurnAssistantIndex,
  omitFoundryBearerCredentialHeaders,
  prepareClaudeSonnet5RequestContext,
  projectAnthropicTools,
  reconcileAnthropicToolChoice,
  requiresClaudeAdaptiveThinking,
  resolveClaudeNativeThinkingLevelMap,
  resolveClaudeSonnet5ModelIdentity,
  resolveOriginalAnthropicToolName,
  readAnthropicFallbackBoundary,
  readAnthropicPromptUsageSnapshot,
  readAnthropicUsageTokenCount,
  readLastAnthropicIterationUsage,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
  usesClaudeFable5MessagesContract,
  usesClaudeStreamingRefusalContract,
  usesFoundryBearerAuth,
  type AnthropicOptions,
  type AnthropicPromptUsageSnapshot,
  type AnthropicProjectedToolChoice,
  type AnthropicThinkingDisplay,
  type AnthropicToolProjection,
} from "@openclaw/ai/internal/anthropic";
import {
  calculateCost,
  clampThinkingLevel,
  createDeferredEventBuffer,
  getEnvApiKey,
  notifyLlmRequestActivity,
  parseStreamingJson,
} from "@openclaw/ai/internal/runtime";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultBlockText,
  extractToolResultText,
} from "@openclaw/ai/internal/shared";
/**
 * Native Anthropic Messages streaming transport.
 * Converts OpenClaw contexts/tools into Anthropic payloads, streams SSE events
 * back into runtime output blocks, and applies provider request policy.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createAbortError as createNamedAbortError } from "../infra/abort-signal.js";
import { toErrorObject } from "../infra/errors.js";
import { readResponseTextSnippet } from "../infra/http-body.js";
import type {
  AssistantMessageDiagnostic,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
} from "../llm/types.js";
import "../llm/ai-transport-host.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "./anthropic-payload-policy.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./json-unsafe-integers.js";
import { resolveProviderEndpoint } from "./provider-attribution.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import type { StreamFn } from "./runtime/index.js";
import { transformTransportMessages } from "./transport-message-transform.js";
import {
  coerceTransportToolCallArguments,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  encodeAssistantTextSignatureV1,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "./transport-stream-shared.js";
import type { ContextUsage } from "./usage.js";

const CLAUDE_CODE_VERSION = "2.1.75";
const CLAUDE_CODE_BILLING_SYSTEM_BLOCK = `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}; cc_entrypoint=sdk-cli;`;
const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES = 8 * 1024;
const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_CHARS = 400;
const ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS = 10_000;
// Mirror the fetch sanitizer cap here because compatible routes such as Kimi
// bypass that layer; without a parser-local guard, partial frames grow forever.
const ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS = 16 * 1024 * 1024;
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
  Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets" | "stop">;
type AnthropicAdaptiveEffort = NonNullable<AnthropicOptions["effort"]> | "xhigh";
type AnthropicMessagesClient = {
  messages: {
    stream(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<Record<string, unknown>>;
  };
};

function resolveAnthropicRequestModelId(model: AnthropicTransportModel): string {
  if (isDirectAnthropicModel(model) && /^anthropic\//i.test(model.id)) {
    return model.id.replace(/^anthropic\//i, "");
  }
  return model.id;
}

type TransportContentBlock =
  | { type: "text"; text: string; index?: number; textSignature?: string }
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
  responseModel?: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    contextUsage?: ContextUsage;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
  diagnostics?: AssistantMessageDiagnostic[];
};

const EMPTY_ANTHROPIC_MESSAGES_FALLBACK_TEXT = ".";

function normalizeAnthropicToolChoice(
  thinkingEnabled: boolean,
  toolChoice: NonNullable<AnthropicTransportOptions["toolChoice"]>,
): AnthropicProjectedToolChoice {
  if (
    thinkingEnabled &&
    (toolChoice === "any" || (typeof toolChoice === "object" && toolChoice.type === "tool"))
  ) {
    return { type: "auto" as const };
  }
  return typeof toolChoice === "string" ? { type: toolChoice } : toolChoice;
}

function supportsNativeXhighEffort(model: AnthropicTransportModel): boolean {
  return supportsClaudeNativeXhighEffort(model);
}

function supportsAdaptiveThinking(model: AnthropicTransportModel): boolean {
  return supportsClaudeAdaptiveThinking(model);
}

function mapThinkingLevelToEffort(
  level: ThinkingLevel | "off",
  model: AnthropicTransportModel,
): AnthropicAdaptiveEffort {
  const thinkingLevelMap = resolveClaudeNativeThinkingLevelMap(model);
  const clampModel = {
    ...model,
    ...(typeof model.params?.canonicalModelId === "string" ? { reasoning: true } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
  const resolvedLevel = clampThinkingLevel(clampModel, level);
  const mapped = thinkingLevelMap?.[resolvedLevel];
  if (typeof mapped === "string") {
    return mapped as AnthropicAdaptiveEffort;
  }
  switch (resolvedLevel) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "xhigh":
      return supportsNativeXhighEffort(model) ? "xhigh" : "high";
    case "max":
      return supportsClaudeNativeMaxEffort(model) ? "max" : "high";
    default:
      return "high";
  }
}

function clampReasoningLevel(level: ThinkingLevel): "minimal" | "low" | "medium" | "high" {
  return level === "xhigh" || level === "max" ? "high" : level;
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
  useModelDefault?: boolean;
}): number | undefined {
  const requested = resolvePositiveAnthropicMaxTokens(params.requestedMaxTokens);
  if (requested !== undefined) {
    return requested;
  }
  const modelMax = resolvePositiveAnthropicMaxTokens(params.modelMaxTokens);
  return modelMax !== undefined
    ? params.useModelDefault
      ? modelMax
      : Math.min(modelMax, 32_000)
    : undefined;
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

function isKimiAnthropicProvider(provider: string | undefined): boolean {
  return /^kimi(?:-|$)/.test(normalizeLowercaseStringOrEmpty(provider ?? ""));
}

/**
 * Server-side refusal fallback is a first-party Claude API beta: proxies and
 * Bedrock/Vertex/Foundry reject the `fallbacks` param, and OAuth (Claude Code
 * identity) requests are excluded until the beta is verified there.
 */
function useAnthropicServerSideFallback(model: AnthropicTransportModel): boolean {
  return usesClaudeFable5MessagesContract(model) && isDirectAnthropicModel(model);
}

function supportsReasoningContentReplay(
  model: Pick<AnthropicTransportModel, "provider" | "baseUrl">,
): boolean {
  return resolveProviderEndpoint(model.baseUrl).endpointClass === "xiaomi-native";
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

function convertContentBlocks(content: readonly unknown[]) {
  const text = extractToolResultText(content);
  const mediaPlaceholder = describeToolResultMediaPlaceholder(content);
  const hasImages =
    Array.isArray(content) &&
    content.some(
      (item) =>
        item && typeof item === "object" && (item as Record<string, unknown>).type === "image",
    );
  if (!hasImages) {
    return sanitizeNonEmptyTransportPayloadText(text, mediaPlaceholder ?? "(no output)");
  }
  const blocks: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: string; data: string };
      }
  > = [];
  let hasTextBlock = false;
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    const blockText = extractToolResultBlockText(block);
    if (blockText) {
      blocks.push({ type: "text", text: sanitizeTransportPayloadText(blockText) });
      hasTextBlock = true;
    }
    if (record.type !== "image") {
      continue;
    }
    blocks.push({
      type: "image" as const,
      source: {
        type: "base64",
        media_type: typeof record.mimeType === "string" ? record.mimeType : "image/png",
        data: typeof record.data === "string" ? record.data : "",
      },
    });
  }
  if (!hasTextBlock) {
    blocks.unshift({ type: "text", text: mediaPlaceholder ?? "(see attached image)" });
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
  options: {
    allowReasoningContentReplay?: boolean;
    cacheBreakpointOptOutMessageIndexes: Set<number>;
    replayThinkingEnabled?: boolean;
  },
): Array<Record<string, unknown>> {
  const params: Array<Record<string, unknown>> = [];
  const allowReasoningContentReplay = options.allowReasoningContentReplay === true;
  const replayThinkingEnabled = options.replayThinkingEnabled !== false;
  const transformedMessages = transformTransportMessages(messages, model, normalizeToolCallId);
  const activeToolTurnAssistantIndex = replayThinkingEnabled
    ? -1
    : findActiveAnthropicToolTurnAssistantIndex(transformedMessages);
  for (let i = 0; i < transformedMessages.length; i += 1) {
    const msg = transformedMessages[i];
    if (msg.role === "user") {
      const isRuntimeContextCarrier = msg.runtimeContextCarrier === true;
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          const userParam = {
            role: "user",
            content: sanitizeTransportPayloadText(msg.content),
          };
          if (isRuntimeContextCarrier) {
            options.cacheBreakpointOptOutMessageIndexes.add(params.length);
          }
          params.push(userParam);
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
      const userParam = {
        role: "user",
        content: filteredBlocks,
      };
      if (isRuntimeContextCarrier) {
        options.cacheBreakpointOptOutMessageIndexes.add(params.length);
      }
      params.push(userParam);
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      const reasoningContent: string[] = [];
      let omittedThinking = false;
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
          const thinkingSignature = block.thinkingSignature?.trim();
          const isReasoningContent = thinkingSignature === "reasoning_content";
          if (!replayThinkingEnabled && i !== activeToolTurnAssistantIndex && !isReasoningContent) {
            omittedThinking = true;
            continue;
          }
          if (block.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature,
            });
            continue;
          }
          const hasNativeThinkingSignature = Boolean(thinkingSignature) && !isReasoningContent;
          if (block.thinking.trim().length === 0 && !hasNativeThinkingSignature) {
            continue;
          }
          if (!thinkingSignature) {
            blocks.push({
              type: "text",
              text: sanitizeTransportPayloadText(block.thinking),
            });
          } else {
            const thinking =
              thinkingSignature === "reasoning_content"
                ? sanitizeTransportPayloadText(block.thinking)
                : block.thinking;
            if (thinkingSignature === "reasoning_content") {
              if (allowReasoningContentReplay) {
                blocks.push({
                  type: "thinking",
                  thinking,
                  signature: thinkingSignature,
                });
                reasoningContent.push(thinking);
              }
              continue;
            }
            blocks.push({
              type: "thinking",
              thinking,
              signature: thinkingSignature,
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
      if (blocks.length === 0 && omittedThinking) {
        blocks.push({ type: "text", text: ANTHROPIC_OMITTED_REASONING_TEXT });
      }
      if (blocks.length > 0) {
        const assistantMsg: Record<string, unknown> = { role: "assistant", content: blocks };
        if (reasoningContent.length > 0) {
          assistantMsg.reasoning_content = reasoningContent.join("\n");
        } else if (allowReasoningContentReplay) {
          blocks.unshift({
            type: "thinking",
            thinking: "",
            signature: "reasoning_content",
          });
        }
        params.push(assistantMsg);
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

function ensureNonEmptyAnthropicMessages(messages: Array<Record<string, unknown>>) {
  return messages.length > 0
    ? messages
    : [{ role: "user", content: EMPTY_ANTHROPIC_MESSAGES_FALLBACK_TEXT }];
}

function convertAnthropicTools(tools: Context["tools"], isOAuthToken: boolean) {
  const projection = projectAnthropicTools(tools ?? [], (name) =>
    isOAuthToken ? toClaudeCodeName(name) : name,
  );
  const converted: Array<{
    name: string;
    description?: string;
    input_schema: {
      type: "object";
      properties: unknown;
      required: unknown;
    };
  }> = [];
  for (const tool of projection.tools) {
    converted.push({
      name: tool.wireName,
      description: tool.description,
      input_schema: tool.inputSchema,
    });
  }
  return { projection, tools: converted };
}

function parseAnthropicToolCallArguments(inputJson: string): unknown {
  return parseJsonObjectPreservingUnsafeIntegers(inputJson) ?? parseStreamingJson(inputJson);
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

function tagPendingCommentaryText(content: TransportContentBlock[]): void {
  let commentaryTextIndex = content.filter(
    (block) => block.type === "text" && block.textSignature !== undefined,
  ).length;
  for (const block of content) {
    if (
      block.type === "text" &&
      block.text.trim().length > 0 &&
      block.textSignature === undefined
    ) {
      block.textSignature = encodeAssistantTextSignatureV1(
        `commentary-${commentaryTextIndex}`,
        "commentary",
      );
      commentaryTextIndex += 1;
    }
  }
}

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Resolve the effective Anthropic API base URL from model or environment. */
export function resolveAnthropicBaseUrl(baseUrl?: string): string {
  return baseUrl?.trim() || process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL;
}

/** Resolve the Anthropic Messages endpoint URL for the effective base URL. */
export function resolveAnthropicMessagesUrl(baseUrl?: string): string {
  const normalized = resolveAnthropicBaseUrl(baseUrl).replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function withEffectiveAnthropicBaseUrl(model: AnthropicTransportModel): AnthropicTransportModel {
  const baseUrl = resolveAnthropicBaseUrl(model.baseUrl);
  return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return createNamedAbortError(
    "Request was aborted",
    reason === undefined ? undefined : { cause: reason },
  );
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
        reject(toErrorObject(error, "Non-Error rejection"));
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

function assertAnthropicSsePendingBufferWithinLimit(pendingChars: number): void {
  if (pendingChars <= ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS) {
    return;
  }
  throw new Error(
    `Anthropic Messages SSE response exceeded max pending buffer size (${ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS} chars) without event boundary`,
  );
}

async function* parseAnthropicSseBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await readAnthropicSseChunk(reader, signal);
      if (done) {
        completed = true;
        break;
      }
      buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replaceAll("\r\n", "\n");
      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd >= 0) {
        assertAnthropicSsePendingBufferWithinLimit(frameEnd);
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
      assertAnthropicSsePendingBufferWithinLimit(buffer.length);
    }
    const tailBuffer = `${buffer}${decoder.decode()}`.replaceAll("\r\n", "\n");
    assertAnthropicSsePendingBufferWithinLimit(tailBuffer.length);
    const tail = tailBuffer.trim();
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
    if (!completed) {
      await reader.cancel(signal?.reason).catch(() => undefined);
    }
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
          const detail = await readAnthropicMessagesErrorBodySnippet(response);
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

async function readAnthropicMessagesErrorBodySnippet(response: Response): Promise<string> {
  try {
    return (
      (await readResponseTextSnippet(response, {
        maxBytes: ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES,
        maxChars: ANTHROPIC_MESSAGES_ERROR_BODY_MAX_CHARS,
        chunkTimeoutMs: ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS,
        onIdleTimeout: ({ chunkTimeoutMs }) =>
          new Error(
            `Anthropic Messages error response stalled: no data received for ${chunkTimeoutMs}ms`,
          ),
      })) ?? ""
    );
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.startsWith("Anthropic Messages error response stalled:")
    ) {
      return error.message;
    }
    return "";
  }
}

function createAnthropicTransportClient(params: {
  model: AnthropicTransportModel;
  context: Context;
  apiKey: string;
  options: AnthropicTransportOptions | undefined;
}) {
  const { model, context, apiKey, options } = params;
  const needsInterleavedBeta =
    (options?.interleavedThinking ?? true) && !supportsAdaptiveThinking(model);
  // Kimi's Anthropic thinking SSE is already well-formed for this parser, but
  // the OpenAI SDK compatibility sanitizer can stall before the text block.
  const fetch =
    isKimiAnthropicProvider(model.provider) && options?.thinkingEnabled === true
      ? buildGuardedModelFetch(model, undefined, { sanitizeSse: false })
      : buildGuardedModelFetch(model);
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
  if (usesFoundryBearerAuth(model)) {
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
          omitFoundryBearerCredentialHeaders(model.headers),
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
  if (useAnthropicServerSideFallback(model)) {
    betaFeatures.push(ANTHROPIC_SERVER_SIDE_FALLBACK_BETA);
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
): {
  params: Record<string, unknown>;
  toolProjection?: AnthropicToolProjection;
} {
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  const replayThinkingEnabled = mandatoryAdaptiveThinking || options?.thinkingEnabled === true;
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
  // Transient runtime-context carrier indexes skip cache anchoring so the breakpoint
  // stays on the last stable user turn; conversion-to-policy must not splice messages.
  const cacheBreakpointOptOutMessageIndexes = new Set<number>();
  const messages = convertAnthropicMessages(context.messages, model, isOAuthToken, {
    allowReasoningContentReplay: supportsReasoningContentReplay(model),
    cacheBreakpointOptOutMessageIndexes,
    replayThinkingEnabled,
  });
  const params: Record<string, unknown> = {
    model: resolveAnthropicRequestModelId(model),
    messages: ensureNonEmptyAnthropicMessages(messages),
    max_tokens: maxTokens,
    stream: true,
  };
  // Fable safety classifiers can decline benign-adjacent work; server-side
  // fallback re-serves the same call on claude-opus-4-8 instead of failing
  // the turn. Requires the matching beta header from the transport client.
  if (!isOAuthToken && useAnthropicServerSideFallback(model)) {
    params.fallbacks = buildAnthropicServerSideFallbacks();
  }
  if (isOAuthToken) {
    params.system = [
      // Anthropic requires this first block to route Claude subscription OAuth billing.
      {
        type: "text",
        text: CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
      },
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
  if (
    options?.temperature !== undefined &&
    !options.thinkingEnabled &&
    !supportsNativeXhighEffort(model)
  ) {
    params.temperature = options.temperature;
  }
  if (options?.stop !== undefined && options.stop.length > 0) {
    params.stop_sequences = options.stop;
  }
  let toolProjection: AnthropicToolProjection | undefined;
  if (context.tools) {
    const convertedTools = convertAnthropicTools(context.tools, isOAuthToken);
    toolProjection = convertedTools.projection;
    if (convertedTools.tools.length > 0) {
      params.tools = convertedTools.tools;
    }
  }
  if (mandatoryAdaptiveThinking || model.reasoning || supportsAdaptiveThinking(model)) {
    if (mandatoryAdaptiveThinking || options?.thinkingEnabled) {
      if (supportsAdaptiveThinking(model)) {
        // Default display to "summarized" so Opus 4.7+/Fable 5 return a thinking
        // summary like older Claude 4 models — mirrors the provider path
        // (llm/providers/anthropic.ts). Without it the adaptive request omits the
        // summary and only an encrypted signature comes back, so the 🧠 lane is
        // blank (the live agent transport previously sent this for opus-4-8).
        const display: AnthropicThinkingDisplay = options?.thinkingDisplay ?? "summarized";
        params.thinking = { type: "adaptive", display };
        const effort = options?.effort ?? (mandatoryAdaptiveThinking ? "high" : undefined);
        if (effort) {
          params.output_config = { effort };
        }
      } else {
        params.thinking = {
          type: "enabled",
          budget_tokens: options?.thinkingBudgetTokens || 1024,
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
    const normalizedToolChoice = normalizeAnthropicToolChoice(
      replayThinkingEnabled,
      options.toolChoice,
    );
    const projectedToolChoice = toolProjection
      ? reconcileAnthropicToolChoice(normalizedToolChoice, toolProjection)
      : normalizedToolChoice;
    if (projectedToolChoice) {
      params.tool_choice = projectedToolChoice;
    }
  }
  applyAnthropicPayloadPolicyToParams(params, payloadPolicy, cacheBreakpointOptOutMessageIndexes);
  return { params, toolProjection };
}

function resolveAnthropicTransportOptions(
  model: AnthropicTransportModel,
  options: AnthropicTransportOptions | undefined,
  apiKey: string,
): AnthropicTransportOptions {
  const baseMaxTokens = resolveAnthropicMessagesMaxTokens({
    modelMaxTokens: model.maxTokens,
    requestedMaxTokens: options?.maxTokens,
    useModelDefault: resolveClaudeSonnet5ModelIdentity(model) !== undefined,
  });
  if (baseMaxTokens === undefined) {
    throw new Error(
      `Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`,
    );
  }
  const reasoningModelMaxTokens =
    resolvePositiveAnthropicMaxTokens(model.maxTokens) ?? baseMaxTokens;
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  const reasoning =
    options?.reasoning === "off" && mandatoryAdaptiveThinking ? "low" : options?.reasoning;
  const resolved: AnthropicTransportOptions = {
    temperature: options?.temperature,
    stop: options?.stop,
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
    reasoning,
  };
  if (reasoning === "off") {
    resolved.thinkingEnabled = false;
    return resolved;
  }
  if (!reasoning) {
    resolved.thinkingEnabled = defaultsClaudeAdaptiveThinking(model);
    if (resolved.thinkingEnabled) {
      resolved.effort = "high";
    }
    return resolved;
  }
  if (supportsAdaptiveThinking(model)) {
    resolved.thinkingEnabled = true;
    resolved.effort = mapThinkingLevelToEffort(reasoning, model) as NonNullable<
      AnthropicOptions["effort"]
    >;
    return resolved;
  }
  const adjusted = adjustMaxTokensForThinking({
    baseMaxTokens,
    modelMaxTokens: reasoningModelMaxTokens,
    reasoningLevel: reasoning,
    customBudgets: options?.thinkingBudgets,
  });
  resolved.maxTokens = adjusted.maxTokens;
  resolved.thinkingEnabled = true;
  resolved.thinkingBudgetTokens = adjusted.thinkingBudget;
  return resolved;
}

/** Create the stream function used by Anthropic Messages transport models. */
export function createAnthropicMessagesTransportStreamFn(): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = withEffectiveAnthropicBaseUrl(rawModel as AnthropicTransportModel);
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
      // Classifier refusals can invalidate partial output, so no event is safe
      // to expose until the terminal stop reason is known.
      const refusalBuffer = usesClaudeStreamingRefusalContract(model)
        ? createDeferredEventBuffer<unknown>(stream, () =>
            notifyLlmRequestActivity(options?.signal),
          )
        : undefined;
      const eventSink = refusalBuffer ?? stream;
      // Fallback-served turns bill at the serving model's rates; a boundary
      // swaps this to the fallback model's cost table.
      let costModel = model;
      let messageStartPromptUsage: AnthropicPromptUsageSnapshot | undefined;
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        const transportOptions = resolveAnthropicTransportOptions(model, options, apiKey);
        const requestContext = prepareClaudeSonnet5RequestContext(model, context);
        const { client, isOAuthToken } = createAnthropicTransportClient({
          model,
          context: requestContext,
          apiKey,
          options: transportOptions,
        });
        const builtParams = buildAnthropicParams(
          model,
          requestContext,
          isOAuthToken,
          transportOptions,
        );
        let params = builtParams.params;
        const toolProjection = builtParams.toolProjection;
        const nextParams = await transportOptions.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as Record<string, unknown>;
        }
        applyClaudeRequestContract(params, model);
        const anthropicStream = client.messages.stream(
          { ...params, stream: true },
          transportOptions.signal ? { signal: transportOptions.signal } : undefined,
        );
        const blocks = output.content;
        const blockIndexes = new Map<number, number>();
        const signatureDeltaIndexes = new Set<number>();
        const allowReasoningContentReplay = supportsReasoningContentReplay(model);
        const reasoningContentThinkingBlocks = new Map<number, number>();
        const reasoningContentTextBlocks = new Map<number, number>();
        let sawMessageStop = false;
        const pendingTextEnds: Array<Parameters<typeof eventSink.push>[0]> = [];
        // Hold text_end until tool-boundary classification is known.
        const flushPendingTextEnds = () => {
          for (const event of pendingTextEnds) {
            eventSink.push(event);
          }
          pendingTextEnds.length = 0;
        };
        const eventIndexKey = (eventIndex: unknown) =>
          typeof eventIndex === "number" ? eventIndex : -1;
        const appendReasoningContentThinkingDelta = (
          eventIndex: unknown,
          rawText: unknown,
        ): boolean => {
          if (typeof rawText !== "string") {
            return false;
          }
          const text = sanitizeTransportPayloadText(rawText);
          if (text.length === 0) {
            return false;
          }
          const key = eventIndexKey(eventIndex);
          let contentIndex = reasoningContentThinkingBlocks.get(key);
          let block =
            contentIndex === undefined
              ? undefined
              : (output.content[contentIndex] as TransportContentBlock | undefined);
          if (!block || block.type !== "thinking") {
            block = { type: "thinking", thinking: "", thinkingSignature: "reasoning_content" };
            output.content.push(block);
            contentIndex = output.content.length - 1;
            reasoningContentThinkingBlocks.set(key, contentIndex);
            eventSink.push({
              type: "thinking_start",
              contentIndex,
              partial: output as never,
            });
          }
          block.thinking += text;
          block.thinkingSignature = "reasoning_content";
          eventSink.push({
            type: "thinking_delta",
            contentIndex,
            delta: text,
            partial: output as never,
          });
          return true;
        };
        const appendReasoningContentTextDelta = (
          eventIndex: unknown,
          rawText: unknown,
        ): boolean => {
          if (typeof rawText !== "string") {
            return false;
          }
          const text = sanitizeTransportPayloadText(rawText);
          if (text.length === 0) {
            return false;
          }
          const key = eventIndexKey(eventIndex);
          let contentIndex = reasoningContentTextBlocks.get(key);
          let block =
            contentIndex === undefined
              ? undefined
              : (output.content[contentIndex] as TransportContentBlock | undefined);
          if (!block || block.type !== "text") {
            block = { type: "text", text: "" };
            output.content.push(block);
            contentIndex = output.content.length - 1;
            reasoningContentTextBlocks.set(key, contentIndex);
            eventSink.push({
              type: "text_start",
              contentIndex,
              partial: output as never,
            });
          }
          block.text += text;
          eventSink.push({
            type: "text_delta",
            contentIndex,
            delta: text,
            partial: output as never,
          });
          return true;
        };
        const finishReasoningContentSidecars = (eventIndex: unknown) => {
          const key = eventIndexKey(eventIndex);
          const thinkingContentIndex = reasoningContentThinkingBlocks.get(key);
          if (thinkingContentIndex !== undefined) {
            reasoningContentThinkingBlocks.delete(key);
            const block = output.content[thinkingContentIndex];
            if (block?.type === "thinking") {
              eventSink.push({
                type: "thinking_end",
                contentIndex: thinkingContentIndex,
                content: block.thinking,
                partial: output as never,
              });
            }
          }
          const textContentIndex = reasoningContentTextBlocks.get(key);
          if (textContentIndex === undefined) {
            return;
          }
          reasoningContentTextBlocks.delete(key);
          const block = output.content[textContentIndex];
          if (block?.type === "text") {
            eventSink.push({
              type: "text_end",
              contentIndex: textContentIndex,
              content: block.text,
              partial: output as never,
            });
          }
        };
        for await (const event of anthropicStream) {
          if (event.type === "error") {
            const error = event.error as { message?: string } | undefined;
            throw new Error(error?.message || "Anthropic Messages stream failed");
          }
          if (event.type === "message_start") {
            const message = event.message as
              | { id?: string; model?: string; usage?: Record<string, unknown> }
              | undefined;
            const usage = message?.usage ?? {};
            output.responseId = typeof message?.id === "string" ? message.id : undefined;
            output.responseModel = typeof message?.model === "string" ? message.model : undefined;
            const promptUsage = readAnthropicPromptUsageSnapshot(usage);
            const messageStartPromptTokens = promptUsage
              ? promptUsage.input + promptUsage.cacheRead + promptUsage.cacheWrite
              : 0;
            messageStartPromptUsage = messageStartPromptTokens > 0 ? promptUsage : undefined;
            const inputTokens = readAnthropicUsageTokenCount(usage.input_tokens);
            if (inputTokens !== undefined) {
              output.usage.input = inputTokens;
            }
            const outputTokens = readAnthropicUsageTokenCount(usage.output_tokens);
            if (outputTokens !== undefined) {
              output.usage.output = outputTokens;
            }
            const cacheReadTokens =
              usage.cache_read_input_tokens == null
                ? 0
                : readAnthropicUsageTokenCount(usage.cache_read_input_tokens);
            if (cacheReadTokens !== undefined) {
              output.usage.cacheRead = cacheReadTokens;
            }
            const cacheWriteTokens =
              usage.cache_creation_input_tokens == null
                ? 0
                : readAnthropicUsageTokenCount(usage.cache_creation_input_tokens);
            if (cacheWriteTokens !== undefined) {
              output.usage.cacheWrite = cacheWriteTokens;
            }
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            if (messageStartPromptUsage && outputTokens !== undefined) {
              output.usage.contextUsage = {
                state: "available",
                promptTokens: messageStartPromptTokens,
                totalTokens: messageStartPromptTokens + output.usage.output,
              };
            }
            calculateCost(costModel, output.usage);
            // Defer start until after message_start so that pre-stream SSE errors
            // (e.g. invalid thinking signatures) arrive before any non-error event
            // is yielded, keeping yieldedOutput=false in pumpStreamWithRecovery
            // and allowing the thinking-block recovery retry to fire.
            eventSink.push({ type: "start", partial: output as never });
            continue;
          }
          if (event.type === "message_stop") {
            sawMessageStop = true;
            continue;
          }
          if (event.type === "content_block_start") {
            const contentBlock = event.content_block as Record<string, unknown> | undefined;
            const index = typeof event.index === "number" ? event.index : -1;
            const fallbackBoundary = refusalBuffer
              ? readAnthropicFallbackBoundary(contentBlock)
              : null;
            if (fallbackBoundary) {
              // Server-side fallback boundary: pre-boundary thinking/tool
              // blocks must not replay or execute, and the buffered preview
              // events reference them, so rebuild the deferred timeline from
              // the surviving text prefix the fallback model continued from.
              refusalBuffer?.discard();
              pendingTextEnds.length = 0;
              blockIndexes.clear();
              applyAnthropicFallbackBoundary({
                output,
                boundary: fallbackBoundary,
                provider: model.provider,
              });
              // Cost intentionally mirrors top-level usage (serving attempt at
              // serving-model rates). A mid-stream decline's billed partial is
              // only in usage.iterations and is not folded in here.
              costModel = { ...model, cost: CLAUDE_FABLE_5_FALLBACK_MODEL_COST };
              calculateCost(costModel, output.usage);
              eventSink.push({ type: "start", partial: output as never });
              for (let i = 0; i < output.content.length; i += 1) {
                const block = output.content[i];
                if (block.type !== "text") {
                  continue;
                }
                delete block.index;
                eventSink.push({
                  type: "text_start",
                  contentIndex: i,
                  partial: output as never,
                });
                if (block.text) {
                  eventSink.push({
                    type: "text_delta",
                    contentIndex: i,
                    delta: block.text,
                    partial: output as never,
                  });
                }
                pendingTextEnds.push({
                  type: "text_end",
                  contentIndex: i,
                  content: block.text,
                  partial: output as never,
                });
              }
              continue;
            }
            if (contentBlock?.type === "text") {
              const text =
                typeof contentBlock.text === "string"
                  ? sanitizeTransportPayloadText(contentBlock.text)
                  : "";
              const block: TransportContentBlock = { type: "text", text, index };
              output.content.push(block);
              const contentIndex = output.content.length - 1;
              blockIndexes.set(index, contentIndex);
              eventSink.push({
                type: "text_start",
                contentIndex,
                partial: output as never,
              });
              if (text.length > 0) {
                eventSink.push({
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
                typeof contentBlock.thinking === "string" ? contentBlock.thinking : "";
              const block: TransportContentBlock = {
                type: "thinking",
                thinking,
                thinkingSignature:
                  typeof contentBlock.signature === "string" ? contentBlock.signature : "",
                index,
              };
              output.content.push(block);
              const contentIndex = output.content.length - 1;
              blockIndexes.set(index, contentIndex);
              eventSink.push({
                type: "thinking_start",
                contentIndex,
                partial: output as never,
              });
              if (thinking.length > 0) {
                eventSink.push({
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
              blockIndexes.set(index, output.content.length - 1);
              eventSink.push({
                type: "thinking_start",
                contentIndex: output.content.length - 1,
                partial: output as never,
              });
              continue;
            }
            if (contentBlock?.type === "tool_use") {
              tagPendingCommentaryText(output.content);
              flushPendingTextEnds();
              const block: TransportContentBlock = {
                type: "toolCall",
                id: typeof contentBlock.id === "string" ? contentBlock.id : "",
                name:
                  typeof contentBlock.name === "string"
                    ? isOAuthToken
                      ? resolveOriginalAnthropicToolName(contentBlock.name, toolProjection)
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
              blockIndexes.set(index, output.content.length - 1);
              eventSink.push({
                type: "toolcall_start",
                contentIndex: output.content.length - 1,
                partial: output as never,
              });
            }
            continue;
          }
          if (event.type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown> | undefined;
            const eventIndex = typeof event.index === "number" ? event.index : undefined;
            let index = eventIndex === undefined ? undefined : blockIndexes.get(eventIndex);
            let block = index === undefined ? undefined : blocks[index];
            if (allowReasoningContentReplay) {
              const appendedThinking = appendReasoningContentThinkingDelta(
                event.index,
                delta?.reasoning_content,
              );
              const hasNativeAnthropicDelta =
                (delta?.type === "text_delta" && typeof delta.text === "string") ||
                (delta?.type === "thinking_delta" && typeof delta.thinking === "string") ||
                (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") ||
                (delta?.type === "signature_delta" && typeof delta.signature === "string");
              let appendedContent = false;
              if (
                !hasNativeAnthropicDelta &&
                typeof delta?.content === "string" &&
                delta.content.length > 0
              ) {
                const text = sanitizeTransportPayloadText(delta.content);
                if (text.length > 0) {
                  if (block?.type === "text") {
                    block.text += text;
                    eventSink.push({
                      type: "text_delta",
                      contentIndex: index,
                      delta: text,
                      partial: output as never,
                    });
                    appendedContent = true;
                  } else {
                    appendedContent = appendReasoningContentTextDelta(event.index, text);
                  }
                }
              }
              if ((appendedThinking || appendedContent) && !hasNativeAnthropicDelta) {
                continue;
              }
            }
            if (!block && delta?.type === "text_delta" && typeof delta.text === "string") {
              const recoveredIndex = typeof event.index === "number" ? event.index : blocks.length;
              block = { type: "text", text: "", index: recoveredIndex };
              output.content.push(block);
              index = output.content.length - 1;
              if (typeof event.index === "number") {
                blockIndexes.set(event.index, index);
              }
              eventSink.push({
                type: "text_start",
                contentIndex: index,
                partial: output as never,
              });
            }
            if (
              block?.type === "text" &&
              delta?.type === "text_delta" &&
              typeof delta.text === "string"
            ) {
              block.text += delta.text;
              eventSink.push({
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
              eventSink.push({
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
              const partialJson = `${block.partialJson ?? ""}${delta.partial_json}`;
              block.partialJson = partialJson;
              block.arguments = parseAnthropicToolCallArguments(partialJson);
              eventSink.push({
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
              const signatureIndex = eventIndexKey(event.index);
              if (!signatureDeltaIndexes.has(signatureIndex)) {
                signatureDeltaIndexes.add(signatureIndex);
                block.thinkingSignature = "";
              }
              block.thinkingSignature = (block.thinkingSignature || "") + delta.signature;
            }
            continue;
          }
          if (event.type === "content_block_stop") {
            const eventIndex = typeof event.index === "number" ? event.index : undefined;
            const index = eventIndex === undefined ? undefined : blockIndexes.get(eventIndex);
            const block = index === undefined ? undefined : blocks[index];
            if (eventIndex === undefined || index === undefined || !block) {
              finishReasoningContentSidecars(event.index);
              continue;
            }
            blockIndexes.delete(eventIndex);
            delete block.index;
            if (block.type === "text") {
              pendingTextEnds.push({
                type: "text_end",
                contentIndex: index,
                content: block.text,
                partial: output as never,
              });
              finishReasoningContentSidecars(event.index);
              continue;
            }
            if (block.type === "thinking") {
              eventSink.push({
                type: "thinking_end",
                contentIndex: index,
                content: block.thinking,
                partial: output as never,
              });
              finishReasoningContentSidecars(event.index);
              continue;
            }
            if (block.type === "toolCall") {
              if (typeof block.partialJson === "string" && block.partialJson.length > 0) {
                block.arguments = parseAnthropicToolCallArguments(block.partialJson);
              }
              delete block.partialJson;
              eventSink.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall: block as never,
                partial: output as never,
              });
              finishReasoningContentSidecars(event.index);
            }
            continue;
          }
          if (event.type === "message_delta") {
            const delta = event.delta as
              | { stop_reason?: string; stop_details?: unknown }
              | undefined;
            const usage = event.usage as Record<string, unknown> | undefined;
            if (delta?.stop_reason) {
              if (delta.stop_reason === "refusal") {
                applyAnthropicRefusal(output, delta.stop_details, model.provider);
              } else {
                output.stopReason = mapStopReason(delta.stop_reason);
              }
            }
            const inputTokens = readAnthropicUsageTokenCount(usage?.input_tokens);
            if (inputTokens !== undefined) {
              output.usage.input = inputTokens;
            }
            const outputTokens = readAnthropicUsageTokenCount(usage?.output_tokens);
            if (outputTokens !== undefined) {
              output.usage.output = outputTokens;
            }
            // Match the SDK stream accumulator: null means no update, not a zero counter.
            const cacheReadTokens = readAnthropicUsageTokenCount(usage?.cache_read_input_tokens);
            if (cacheReadTokens !== undefined) {
              output.usage.cacheRead = cacheReadTokens;
            }
            const cacheWriteTokens = readAnthropicUsageTokenCount(
              usage?.cache_creation_input_tokens,
            );
            if (cacheWriteTokens !== undefined) {
              output.usage.cacheWrite = cacheWriteTokens;
            }
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            const iterationUsage = readLastAnthropicIterationUsage(usage ?? {});
            if (iterationUsage.state === "valid") {
              output.usage.contextUsage = {
                state: "available",
                promptTokens: iterationUsage.usage.contextPromptTokens,
                totalTokens: iterationUsage.usage.totalTokens,
              };
            } else if (iterationUsage.state === "invalid") {
              output.usage.contextUsage = { state: "unavailable" };
            } else if (
              outputTokens !== undefined &&
              (messageStartPromptUsage !== undefined ||
                (inputTokens !== undefined &&
                  cacheReadTokens !== undefined &&
                  cacheWriteTokens !== undefined))
            ) {
              const promptTokens =
                output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
              output.usage.contextUsage = {
                state: "available",
                promptTokens,
                totalTokens: promptTokens + output.usage.output,
              };
            } else {
              output.usage.contextUsage = { state: "unavailable" };
            }
            calculateCost(costModel, output.usage);
            // Gate on the turn CONTAINING a tool call, not the provider's stop_reason
            // label: Bedrock/Vertex-proxied routes (e.g. pioneer) report "end_turn" on
            // tool-using turns. No-op for direct Anthropic (already "toolUse" here).
            if (
              output.stopReason === "toolUse" ||
              output.content.some((block) => block.type === "toolCall")
            ) {
              tagPendingCommentaryText(output.content);
            }
            flushPendingTextEnds();
          }
        }
        if (refusalBuffer && !sawMessageStop) {
          throw new Error("Anthropic stream ended before message_stop");
        }
        if (transportOptions.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error(output.errorMessage ?? "An unknown error occurred");
        }
        refusalBuffer?.flush();
        // Backstop: streaming tags commentary at the tool-boundary above, but
        // replay/non-streaming assembly may reach here with tool calls untagged.
        // Idempotent, so it never double-tags the streaming path. Gate on the turn
        // containing a tool call (not stop_reason) so proxied Bedrock/Vertex routes
        // that mislabel tool turns as "end_turn" still tag their narration.
        if (
          output.stopReason === "toolUse" ||
          output.content.some((block) => block.type === "toolCall")
        ) {
          tagPendingCommentaryText(output.content);
        }
        flushPendingTextEnds();
        finalizeTransportStream({ stream, output });
      } catch (error) {
        if (refusalBuffer) {
          refusalBuffer.discard();
          output.content = [];
        }
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
