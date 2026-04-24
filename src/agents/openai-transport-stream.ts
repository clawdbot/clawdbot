import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  calculateCost,
  createAssistantMessageEventStream,
  getEnvApiKey,
  parseStreamingJson,
  type Api,
  type Context,
  type Model,
} from "@mariozechner/pi-ai";
import { convertMessages } from "@mariozechner/pi-ai/openai-completions";
import OpenAI, { AzureOpenAI } from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputMessageContentList,
} from "openai/resources/responses/responses.js";
import type { ModelCompatConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveProviderTransportTurnStateWithPlugin } from "../plugins/provider-runtime.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { flattenCompletionMessagesToStringContent } from "./openai-completions-string-content.js";
import { resolveOpenAIReasoningEffortMap } from "./openai-reasoning-compat.js";
import {
  normalizeOpenAIReasoningEffort,
  resolveOpenAIReasoningEffortForModel,
  type OpenAIApiReasoningEffort,
  type OpenAIReasoningEffort,
} from "./openai-reasoning-effort.js";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";
import {
  findOpenAIStrictToolSchemaDiagnostics,
  normalizeOpenAIStrictToolParameters,
  resolveOpenAIStrictToolFlagForInventory,
  resolveOpenAIStrictToolSetting,
} from "./openai-tool-schema.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { stripSystemPromptCacheBoundary } from "./system-prompt-cache-boundary.js";
import { transformTransportMessages } from "./transport-message-transform.js";
import { mergeTransportMetadata, sanitizeTransportPayloadText } from "./transport-stream-shared.js";

const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-12-01-preview";
const log = createSubsystemLogger("openai-transport");

type BaseStreamOptions = {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  cacheRetention?: "none" | "short" | "long";
  sessionId?: string;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown;
  headers?: Record<string, string>;
};

type OpenAIResponsesOptions = BaseStreamOptions & {
  reasoning?: OpenAIReasoningEffort;
  reasoningEffort?: OpenAIReasoningEffort;
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
};

type OpenAICompletionsOptions = BaseStreamOptions & {
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | {
        type: "function";
        function: {
          name: string;
        };
      };
  reasoning?: OpenAIReasoningEffort;
  reasoningEffort?: OpenAIReasoningEffort;
};

type OpenAIModeModel = Omit<Model<Api>, "compat"> & {
  compat?: ModelCompatConfig;
};

type MutableAssistantOutput = {
  role: "assistant";
  content: Array<Record<string, unknown>>;
  api: Api;
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

export { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

function stringifyUnknown(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function stringifyJsonLike(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function getServiceTierCostMultiplier(serviceTier: ResponseCreateParamsStreaming["service_tier"]) {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: MutableAssistantOutput["usage"],
  serviceTier?: ResponseCreateParamsStreaming["service_tier"],
): void {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1) {
    return;
  }
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export function resolveAzureOpenAIApiVersion(env = process.env): string {
  return env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}

function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function encodeTextSignatureV1(id: string, phase?: "commentary" | "final_answer"): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

function parseTextSignature(
  signature: string | undefined,
): { id: string; phase?: "commentary" | "final_answer" } | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown };
      if (parsed.v === 1 && typeof parsed.id === "string") {
        return parsed.phase === "commentary" || parsed.phase === "final_answer"
          ? { id: parsed.id, phase: parsed.phase }
          : { id: parsed.id };
      }
    } catch {
      // Keep legacy plain-string behavior below.
    }
  }
  return { id: signature };
}

function convertResponsesMessages(
  model: Model<Api>,
  context: Context,
  allowedToolCallProviders: Set<string>,
  options?: { includeSystemPrompt?: boolean; supportsDeveloperRole?: boolean },
): ResponseInput {
  const messages: ResponseInput = [];
  const normalizeIdPart = (part: string) => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };
  const buildForeignResponsesItemId = (itemId: string) => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };
  const normalizeToolCallId = (
    id: string,
    _targetModel: Model<Api>,
    source: { provider: string; api: Api },
  ) => {
    if (!allowedToolCallProviders.has(model.provider)) {
      return normalizeIdPart(id);
    }
    if (!id.includes("|")) {
      return normalizeIdPart(id);
    }
    const [callId, itemId] = id.split("|");
    const normalizedCallId = normalizeIdPart(callId);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId)
      : normalizeIdPart(itemId);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };
  const transformedMessages = transformTransportMessages(
    context.messages,
    model,
    normalizeToolCallId,
  );
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    messages.push({
      role: model.reasoning && options?.supportsDeveloperRole !== false ? "developer" : "system",
      content: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt)),
    });
  }
  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeTransportPayloadText(msg.content) }],
        });
      } else {
        const content = (
          msg.content.map((item) =>
            item.type === "text"
              ? { type: "input_text", text: sanitizeTransportPayloadText(item.text) }
              : {
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${item.mimeType};base64,${item.data}`,
                },
          ) as ResponseInputMessageContentList
        ).filter((item) => model.input.includes("image") || item.type !== "input_image");
        if (content.length > 0) {
          messages.push({ role: "user", content });
        }
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      const isDifferentModel =
        msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            output.push(JSON.parse(block.thinkingSignature));
          }
        } else if (block.type === "text") {
          let msgId = parseTextSignature(block.textSignature)?.id ?? `msg_${msgIndex}`;
          if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          output.push({
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: sanitizeTransportPayloadText(block.text),
                annotations: [],
              },
            ],
            status: "completed",
            id: msgId,
            phase: parseTextSignature(block.textSignature)?.phase,
          });
        } else if (block.type === "toolCall") {
          const [callId, itemIdRaw] = block.id.split("|");
          const itemId = isDifferentModel && itemIdRaw?.startsWith("fc_") ? undefined : itemIdRaw;
          output.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: block.name,
            arguments:
              typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          });
        }
      }
      if (output.length > 0) {
        messages.push(...output);
      }
    } else if (msg.role === "toolResult") {
      const textResult = msg.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const hasImages = msg.content.some((item) => item.type === "image");
      const [callId] = msg.toolCallId.split("|");
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output:
          hasImages && model.input.includes("image")
            ? ([
                ...(textResult
                  ? [{ type: "input_text", text: sanitizeTransportPayloadText(textResult) }]
                  : []),
                ...msg.content
                  .filter((item) => item.type === "image")
                  .map((item) => ({
                    type: "input_image",
                    detail: "auto",
                    image_url: `data:${item.mimeType};base64,${item.data}`,
                  })),
              ] as ResponseFunctionCallOutputItemList)
            : sanitizeTransportPayloadText(textResult || "(see attached image)"),
      });
    }
    msgIndex += 1;
  }
  return messages;
}

function convertResponsesTools(
  tools: NonNullable<Context["tools"]>,
  model: OpenAIModeModel,
  options?: { strict?: boolean | null },
): FunctionTool[] {
  const strict = resolveOpenAIStrictToolFlagWithDiagnostics(tools, options?.strict, {
    transport: "responses",
    model,
  });
  return tools.map((tool): FunctionTool => {
    const base = {
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: normalizeOpenAIStrictToolParameters(tool.parameters, strict === true) as Record<
        string,
        unknown
      >,
    };
    return strict === undefined ? (base as FunctionTool) : { ...base, strict };
  });
}

function resolveOpenAIStrictToolFlagWithDiagnostics(
  tools: NonNullable<Context["tools"]>,
  strictSetting: boolean | null | undefined,
  context: { transport: "responses" | "completions"; model: OpenAIModeModel },
): boolean | undefined {
  const strict = resolveOpenAIStrictToolFlagForInventory(tools, strictSetting);
  if (strictSetting === true && strict === false && log.isEnabled("debug", "any")) {
    const diagnostics = findOpenAIStrictToolSchemaDiagnostics(tools);
    const sample = diagnostics.slice(0, 5).map((entry) => ({
      tool: entry.toolName ?? `tool[${entry.toolIndex}]`,
      violations: entry.violations.slice(0, 8),
    }));
    log.debug(
      `OpenAI ${context.transport} tool schema strict mode downgraded to strict=false for ` +
        `${context.model.provider ?? "unknown"}/${context.model.id ?? "unknown"} ` +
        `because ${diagnostics.length} tool schema(s) are not strict-compatible`,
      {
        transport: context.transport,
        provider: context.model.provider,
        model: context.model.id,
        incompatibleToolCount: diagnostics.length,
        sample,
      },
    );
  }
  return strict;
}

async function processResponsesStream(
  openaiStream: AsyncIterable<unknown>,
  output: MutableAssistantOutput,
  stream: { push(event: unknown): void },
  model: Model<Api>,
  options?: {
    serviceTier?: ResponseCreateParamsStreaming["service_tier"];
    applyServiceTierPricing?: (
      usage: MutableAssistantOutput["usage"],
      serviceTier?: ResponseCreateParamsStreaming["service_tier"],
    ) => void;
  },
) {
  let currentItem: Record<string, unknown> | null = null;
  let currentBlock: Record<string, unknown> | null = null;
  const blockIndex = () => output.content.length - 1;
  for await (const rawEvent of openaiStream) {
    const event = rawEvent as Record<string, unknown>;
    const type = stringifyUnknown(event.type);
    if (type === "response.created") {
      output.responseId = stringifyUnknown((event.response as { id?: string } | undefined)?.id);
    } else if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
          name: stringifyUnknown(item.name),
          arguments: {},
          partialJson: stringifyJsonLike(item.arguments),
        };
        output.content.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
      }
    } else if (type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = `${stringifyUnknown(currentBlock.thinking)}${stringifyUnknown(event.delta)}`;
        stream.push({
          type: "thinking_delta",
          contentIndex: blockIndex(),
          delta: stringifyUnknown(event.delta),
          partial: output,
        });
      }
    } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = `${stringifyUnknown(currentBlock.text)}${stringifyUnknown(event.delta)}`;
        stream.push({
          type: "text_delta",
          contentIndex: blockIndex(),
          delta: stringifyUnknown(event.delta),
          partial: output,
        });
      }
    } else if (type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson = `${stringifyJsonLike(currentBlock.partialJson)}${stringifyJsonLike(event.delta)}`;
        currentBlock.arguments = parseStreamingJson(stringifyJsonLike(currentBlock.partialJson));
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: stringifyJsonLike(event.delta),
          partial: output,
        });
      }
    } else if (type === "response.output_item.done") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        const summary = Array.isArray(item.summary)
          ? item.summary
              .map((part) => {
                const summaryPart = part as { text?: string };
                return summaryPart.text ?? "";
              })
              .join("\n\n")
          : "";
        currentBlock.thinking = summary;
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: stringifyUnknown(currentBlock.thinking),
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        const content = Array.isArray(item.content) ? item.content : [];
        currentBlock.text = content
          .map((part) => {
            const contentPart = part as { type?: string; text?: string; refusal?: string };
            return contentPart.type === "output_text"
              ? (contentPart.text ?? "")
              : (contentPart.refusal ?? "");
          })
          .join("");
        currentBlock.textSignature = encodeTextSignatureV1(
          stringifyUnknown(item.id),
          (item.phase as "commentary" | "final_answer" | undefined) ?? undefined,
        );
        stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: stringifyUnknown(currentBlock.text),
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const args =
          currentBlock?.type === "toolCall" && currentBlock.partialJson
            ? parseStreamingJson(stringifyJsonLike(currentBlock.partialJson, "{}"))
            : parseStreamingJson(stringifyJsonLike(item.arguments, "{}"));
        stream.push({
          type: "toolcall_end",
          contentIndex: blockIndex(),
          toolCall: {
            type: "toolCall",
            id: `${stringifyUnknown(item.call_id)}|${stringifyUnknown(item.id)}`,
            name: stringifyUnknown(item.name),
            arguments: args,
          },
          partial: output,
        });
        currentBlock = null;
      }
    } else if (type === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      if (typeof response?.id === "string") {
        output.responseId = response.id;
      }
      const usage = response?.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
            service_tier?: ResponseCreateParamsStreaming["service_tier"];
            status?: string;
          }
        | undefined;
      if (usage) {
        const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
        output.usage = {
          input: (usage.input_tokens || 0) - cachedTokens,
          output: usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          totalTokens: usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
      calculateCost(model as never, output.usage as never);
      if (options?.applyServiceTierPricing) {
        options.applyServiceTierPricing(
          output.usage,
          (response?.service_tier as ResponseCreateParamsStreaming["service_tier"] | undefined) ??
            options.serviceTier,
        );
      }
      output.stopReason = mapResponsesStopReason(response?.status as string | undefined);
      if (
        output.content.some((block) => block.type === "toolCall") &&
        output.stopReason === "stop"
      ) {
        output.stopReason = "toolUse";
      }
    } else if (type === "error") {
      throw new Error(
        `Error Code ${stringifyUnknown(event.code, "unknown")}: ${stringifyUnknown(event.message, "Unknown error")}`,
      );
    } else if (type === "response.failed") {
      const response = event.response as
        | {
            error?: { code?: string; message?: string };
            incomplete_details?: { reason?: string };
          }
        | undefined;
      const msg = response?.error
        ? `${response.error.code || "unknown"}: ${response.error.message || "no message"}`
        : response?.incomplete_details?.reason
          ? `incomplete: ${response.incomplete_details.reason}`
          : "Unknown error (no error details in response)";
      throw new Error(msg);
    }
  }
}

function mapResponsesStopReason(status: string | undefined): string {
  if (!status) {
    return "stop";
  }
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default:
      throw new Error(`Unhandled stop reason: ${status}`);
  }
}

function buildOpenAIClientHeaders(
  model: Model<Api>,
  context: Context,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
): Record<string, string> {
  const headers = { ...model.headers };
  if (model.provider === "github-copilot") {
    Object.assign(
      headers,
      buildCopilotDynamicHeaders({
        messages: context.messages,
        hasImages: hasCopilotVisionInput(context.messages),
      }),
    );
  }
  if (optionHeaders) {
    Object.assign(headers, optionHeaders);
  }
  if (turnHeaders) {
    Object.assign(headers, turnHeaders);
  }
  return headers;
}

function resolveProviderTransportTurnState(
  model: Model<Api>,
  params: {
    sessionId?: string;
    turnId: string;
    attempt: number;
    transport: "stream" | "websocket";
  },
) {
  return resolveProviderTransportTurnStateWithPlugin({
    provider: model.provider,
    context: {
      provider: model.provider,
      modelId: model.id,
      model: model as ProviderRuntimeModel,
      sessionId: params.sessionId,
      turnId: params.turnId,
      attempt: params.attempt,
      transport: params.transport,
    },
  });
}

function createOpenAIResponsesClient(
  model: Model<Api>,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
) {
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
    fetch: buildGuardedModelFetch(model),
  });
}

export function createOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const turnState = resolveProviderTransportTurnState(model, {
          sessionId: options?.sessionId,
          turnId: randomUUID(),
          attempt: 1,
          transport: "stream",
        });
        const client = createOpenAIResponsesClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
        );
        let params = buildOpenAIResponsesParams(
          model,
          context,
          options as OpenAIResponsesOptions,
          turnState?.metadata,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        params = mergeTransportMetadata(params, turnState?.metadata);
        const responseStream = (await client.responses.create(
          params as never,
          options?.signal ? { signal: options.signal } : undefined,
        )) as unknown as AsyncIterable<unknown>;
        stream.push({ type: "start", partial: output as never });
        await processResponsesStream(responseStream, output, stream, model, {
          serviceTier: (options as OpenAIResponsesOptions | undefined)?.serviceTier,
          applyServiceTierPricing,
        });
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error("An unknown error occurred");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

function resolveCacheRetention(cacheRetention: string | undefined): "short" | "long" | "none" {
  if (cacheRetention === "short" || cacheRetention === "long" || cacheRetention === "none") {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

function getPromptCacheRetention(
  baseUrl: string | undefined,
  cacheRetention: "short" | "long" | "none",
) {
  if (cacheRetention !== "long") {
    return undefined;
  }
  return baseUrl?.includes("api.openai.com") ? "24h" : undefined;
}

function resolveOpenAIReasoningEffort(
  options: OpenAIResponsesOptions | undefined,
): OpenAIApiReasoningEffort {
  return normalizeOpenAIReasoningEffort(
    options?.reasoningEffort ?? options?.reasoning ?? "high",
  ) as OpenAIApiReasoningEffort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasResponsesWebSearchTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some((tool) => {
    if (!isRecord(tool)) {
      return false;
    }
    if (tool.type === "web_search") {
      return true;
    }
    if (tool.type === "function" && tool.name === "web_search") {
      return true;
    }
    const fn = tool.function;
    return isRecord(fn) && fn.name === "web_search";
  });
}

function raiseMinimalReasoningForResponsesWebSearch(params: {
  model: Model<Api>;
  effort: OpenAIApiReasoningEffort;
  tools: unknown;
}): OpenAIApiReasoningEffort {
  if (params.effort !== "minimal" || !hasResponsesWebSearchTool(params.tools)) {
    return params.effort;
  }
  for (const effort of ["low", "medium", "high"] as const) {
    const resolved = resolveOpenAIReasoningEffortForModel({
      model: params.model,
      effort,
    });
    if (resolved && resolved !== "none" && resolved !== "minimal") {
      return resolved;
    }
  }
  return params.effort;
}

export function buildOpenAIResponsesParams(
  model: Model<Api>,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  metadata?: Record<string, string>,
) {
  const compat = getCompat(model as OpenAIModeModel);
  const supportsDeveloperRole =
    typeof compat.supportsDeveloperRole === "boolean" ? compat.supportsDeveloperRole : undefined;
  const messages = convertResponsesMessages(
    model,
    context,
    new Set(["openai", "openai-codex", "opencode", "azure-openai-responses"]),
    { supportsDeveloperRole },
  );
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, {
    storeMode: "disable",
  });
  const params: OpenAIResponsesRequestParams = {
    model: model.id,
    input: messages,
    stream: true,
    prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
    prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
    ...(metadata ? { metadata } : {}),
  };
  if (options?.maxTokens) {
    params.max_output_tokens = options.maxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.serviceTier !== undefined && payloadPolicy.allowsServiceTier) {
    params.service_tier = options.serviceTier;
  }
  if (context.tools) {
    params.tools = convertResponsesTools(context.tools, model as OpenAIModeModel, {
      strict: resolveOpenAIStrictToolSetting(model as OpenAIModeModel, {
        transport: "stream",
      }),
    });
  }
  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoning || options?.reasoningSummary) {
      const requestedReasoningEffort = resolveOpenAIReasoningEffort(options);
      const resolvedReasoningEffort = resolveOpenAIReasoningEffortForModel({
        model,
        effort: requestedReasoningEffort,
      });
      const reasoningEffort = resolvedReasoningEffort
        ? raiseMinimalReasoningForResponsesWebSearch({
            model,
            effort: resolvedReasoningEffort,
            tools: params.tools,
          })
        : undefined;
      if (reasoningEffort) {
        params.reasoning = {
          effort: reasoningEffort,
          ...(reasoningEffort === "none" ? {} : { summary: options?.reasoningSummary || "auto" }),
        };
        if (reasoningEffort !== "none") {
          params.include = ["reasoning.encrypted_content"];
        }
      }
    } else if (model.provider !== "github-copilot") {
      const reasoningEffort = resolveOpenAIReasoningEffortForModel({
        model,
        effort: "none",
      });
      if (reasoningEffort) {
        params.reasoning = {
          effort: reasoningEffort,
        };
      }
    }
  }
  applyOpenAIResponsesPayloadPolicy(params as Record<string, unknown>, payloadPolicy);
  return params;
}

export function createAzureOpenAIResponsesTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: "azure-openai-responses",
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const turnState = resolveProviderTransportTurnState(model, {
          sessionId: options?.sessionId,
          turnId: randomUUID(),
          attempt: 1,
          transport: "stream",
        });
        const client = createAzureOpenAIClient(
          model,
          context,
          apiKey,
          options?.headers,
          turnState?.headers,
        );
        const deploymentName = resolveAzureDeploymentName(model);
        let params = buildAzureOpenAIResponsesParams(
          model,
          context,
          options as OpenAIResponsesOptions | undefined,
          deploymentName,
          turnState?.metadata,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        params = mergeTransportMetadata(params, turnState?.metadata);
        const responseStream = (await client.responses.create(
          params as never,
          options?.signal ? { signal: options.signal } : undefined,
        )) as unknown as AsyncIterable<unknown>;
        stream.push({ type: "start", partial: output as never });
        await processResponsesStream(responseStream, output, stream, model);
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error("An unknown error occurred");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

function normalizeAzureBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveAzureDeploymentName(model: Model<Api>): string {
  const deploymentMap = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
  if (deploymentMap) {
    for (const entry of deploymentMap.split(",")) {
      const [modelId, deploymentName] = entry.split("=", 2).map((value) => value?.trim());
      if (modelId === model.id && deploymentName) {
        return deploymentName;
      }
    }
  }
  return model.id;
}

function createAzureOpenAIClient(
  model: Model<Api>,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
) {
  return new AzureOpenAI({
    apiKey,
    apiVersion: resolveAzureOpenAIApiVersion(),
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
    baseURL: normalizeAzureBaseUrl(model.baseUrl),
    fetch: buildGuardedModelFetch(model),
  });
}

function buildAzureOpenAIResponsesParams(
  model: Model<Api>,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  deploymentName: string,
  metadata?: Record<string, string>,
) {
  const params = buildOpenAIResponsesParams(model, context, options, metadata);
  params.model = deploymentName;
  delete params.store;
  return params;
}

function hasToolHistory(messages: Context["messages"]): boolean {
  return messages.some(
    (message) =>
      message.role === "toolResult" ||
      (message.role === "assistant" && message.content.some((block) => block.type === "toolCall")),
  );
}

function createOpenAICompletionsClient(
  model: Model<Api>,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
) {
  const clientConfig = buildOpenAICompletionsClientConfig(model, context, optionHeaders);
  return new OpenAI({
    apiKey,
    baseURL: clientConfig.baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: clientConfig.defaultHeaders,
    defaultQuery: clientConfig.defaultQuery,
    fetch: buildGuardedModelFetch(model),
  });
}

function isAzureOpenAICompatibleHost(hostname: string): boolean {
  return (
    hostname.endsWith(".openai.azure.com") ||
    hostname.endsWith(".services.ai.azure.com") ||
    hostname.endsWith(".cognitiveservices.azure.com")
  );
}

function buildOpenAICompletionsClientConfig(
  model: Model<Api>,
  context: Context,
  optionHeaders?: Record<string, string>,
): {
  baseURL: string;
  defaultHeaders: Record<string, string>;
  defaultQuery?: Record<string, string>;
} {
  const headers = buildOpenAIClientHeaders(model, context, optionHeaders);
  const defaultQuery: Record<string, string> = {};
  let baseURL = model.baseUrl;
  let isAzureHost = false;

  try {
    const parsed = new URL(model.baseUrl);
    isAzureHost = isAzureOpenAICompatibleHost(parsed.hostname.toLowerCase());
    parsed.searchParams.forEach((value, key) => {
      if (value) {
        defaultQuery[key] = value;
      }
    });
    parsed.search = "";
    baseURL = parsed.toString().replace(/\/$/, "");
  } catch {
    // Keep the configured base URL unchanged; the OpenAI SDK will surface invalid URLs.
  }

  if (isAzureHost) {
    const apiVersionHeader = Object.keys(headers).find(
      (key) => key.toLowerCase() === "api-version",
    );
    if (apiVersionHeader) {
      const apiVersion = headers[apiVersionHeader]?.trim();
      delete headers[apiVersionHeader];
      if (apiVersion && !defaultQuery["api-version"]) {
        defaultQuery["api-version"] = apiVersion;
      }
    }
  }

  return {
    baseURL,
    defaultHeaders: headers,
    defaultQuery: Object.keys(defaultQuery).length > 0 ? defaultQuery : undefined,
  };
}

export function createOpenAICompletionsTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const client = createOpenAICompletionsClient(model, context, apiKey, options?.headers);
        let params = buildOpenAICompletionsParams(
          model as OpenAIModeModel,
          context,
          options as OpenAICompletionsOptions | undefined,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        const responseStream = (await client.chat.completions.create(params as never, {
          signal: options?.signal,
        })) as unknown as AsyncIterable<ChatCompletionChunk>;
        stream.push({ type: "start", partial: output as never });
        await processOpenAICompletionsStream(responseStream, output, model, stream);
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
        stream.end();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

async function processOpenAICompletionsStream(
  responseStream: AsyncIterable<ChatCompletionChunk>,
  output: MutableAssistantOutput,
  model: Model<Api>,
  stream: { push(event: unknown): void },
) {
  const MAX_POST_TOOL_CALL_BUFFER_BYTES = 256_000;
  const MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES = 256_000;
  const compat = getCompat(model as OpenAIModeModel);
  let currentBlock:
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; thinkingSignature?: string }
    | {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        partialArgs: string;
        thoughtSignature?: string;
      }
    | null = null;
  let pendingPostToolCallDeltas: CompletionsReasoningDelta[] = [];
  let pendingPostToolCallBytes = 0;
  let currentToolCallArgumentBytes = 0;
  let isFlushingPendingPostToolCallDeltas = false;
  const blockIndex = () => output.content.length - 1;
  const measureUtf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const finishCurrentBlock = () => {
    if (!currentBlock) {
      return;
    }
    if (currentBlock.type === "toolCall") {
      currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
      const completed = {
        ...currentBlock,
        arguments: parseStreamingJson(currentBlock.partialArgs),
      };
      output.content[blockIndex()] = completed;
    }
  };
  const queuePostToolCallDelta = (next: CompletionsReasoningDelta) => {
    const nextBytes = measureUtf8Bytes(next.text);
    if (pendingPostToolCallBytes + nextBytes > MAX_POST_TOOL_CALL_BUFFER_BYTES) {
      throw new Error("Exceeded post-tool-call delta buffer limit");
    }
    pendingPostToolCallBytes += nextBytes;
    const previous = pendingPostToolCallDeltas[pendingPostToolCallDeltas.length - 1];
    if (!previous || previous.kind !== next.kind) {
      pendingPostToolCallDeltas.push(next);
      return;
    }
    if (next.kind === "thinking" && previous.kind === "thinking") {
      if (previous.signature !== next.signature) {
        pendingPostToolCallDeltas.push(next);
        return;
      }
      previous.text += next.text;
      return;
    }
    previous.text += next.text;
  };
  const appendThinkingDeltaInternal = (reasoningDelta: { signature: string; text: string }) => {
    if (!currentBlock || currentBlock.type !== "thinking") {
      finishCurrentBlock();
      currentBlock = {
        type: "thinking",
        thinking: "",
        thinkingSignature: reasoningDelta.signature,
      };
      output.content.push(currentBlock);
      stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
    }
    currentBlock.thinking += reasoningDelta.text;
    stream.push({
      type: "thinking_delta",
      contentIndex: blockIndex(),
      delta: reasoningDelta.text,
      partial: output,
    });
  };
  const appendTextDeltaInternal = (text: string) => {
    if (!currentBlock || currentBlock.type !== "text") {
      finishCurrentBlock();
      currentBlock = { type: "text", text: "" };
      output.content.push(currentBlock);
      stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
    }
    currentBlock.text += text;
    stream.push({
      type: "text_delta",
      contentIndex: blockIndex(),
      delta: text,
      partial: output,
    });
  };
  const flushPendingPostToolCallDeltas = () => {
    if (
      isFlushingPendingPostToolCallDeltas ||
      currentBlock?.type === "toolCall" ||
      pendingPostToolCallDeltas.length === 0
    ) {
      return;
    }
    isFlushingPendingPostToolCallDeltas = true;
    const bufferedDeltas = pendingPostToolCallDeltas;
    pendingPostToolCallDeltas = [];
    pendingPostToolCallBytes = 0;
    for (const delta of bufferedDeltas) {
      if (delta.kind === "text") {
        appendTextDeltaInternal(delta.text);
      } else {
        appendThinkingDeltaInternal(delta);
      }
    }
    isFlushingPendingPostToolCallDeltas = false;
  };
  const appendThinkingDelta = (reasoningDelta: { signature: string; text: string }) => {
    flushPendingPostToolCallDeltas();
    appendThinkingDeltaInternal(reasoningDelta);
  };
  const appendTextDelta = (text: string) => {
    flushPendingPostToolCallDeltas();
    appendTextDeltaInternal(text);
  };
  for await (const chunk of responseStream) {
    output.responseId ||= chunk.id;
    if (chunk.usage) {
      output.usage = parseTransportChunkUsage(chunk.usage, model);
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) {
      continue;
    }
    const choiceUsage = (choice as unknown as { usage?: ChatCompletionChunk["usage"] }).usage;
    if (!chunk.usage && choiceUsage) {
      output.usage = parseTransportChunkUsage(choiceUsage, model);
    }
    if (choice.finish_reason) {
      const finishReasonResult = mapStopReason(choice.finish_reason);
      output.stopReason = finishReasonResult.stopReason;
      if (finishReasonResult.errorMessage) {
        output.errorMessage = finishReasonResult.errorMessage;
      }
    }
    if (!choice.delta) {
      continue;
    }
    if (choice.delta.content) {
      if (currentBlock?.type === "toolCall") {
        queuePostToolCallDelta({ kind: "text", text: choice.delta.content });
      } else {
        appendTextDelta(choice.delta.content);
      }
      continue;
    }
    const reasoningDeltas = getCompletionsReasoningDeltas(
      choice.delta as Record<string, unknown>,
      compat.visibleReasoningDetailTypes,
    );
    for (const reasoningDelta of reasoningDeltas) {
      if (currentBlock?.type === "toolCall") {
        queuePostToolCallDelta({ ...reasoningDelta });
        continue;
      }
      if (reasoningDelta.kind === "text") {
        appendTextDelta(reasoningDelta.text);
      } else {
        appendThinkingDelta(reasoningDelta);
      }
    }
    if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
      for (const toolCall of choice.delta.tool_calls) {
        if (
          !currentBlock ||
          currentBlock.type !== "toolCall" ||
          (toolCall.id && currentBlock.id !== toolCall.id)
        ) {
          const switchingToolCall = currentBlock?.type === "toolCall";
          finishCurrentBlock();
          if (switchingToolCall) {
            currentBlock = null;
            flushPendingPostToolCallDeltas();
          }
          const initialSig = extractGoogleThoughtSignature(toolCall);
          currentBlock = {
            type: "toolCall",
            id: toolCall.id || "",
            name: toolCall.function?.name || "",
            arguments: {},
            partialArgs: "",
            ...(initialSig ? { thoughtSignature: initialSig } : {}),
          };
          currentToolCallArgumentBytes = 0;
          output.content.push(currentBlock);
          stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
        }
        if (currentBlock.type !== "toolCall") {
          continue;
        }
        if (toolCall.id) {
          currentBlock.id = toolCall.id;
        }
        if (toolCall.function?.name) {
          currentBlock.name = toolCall.function.name;
        }
        const deltaSig = extractGoogleThoughtSignature(toolCall);
        if (deltaSig) {
          currentBlock.thoughtSignature = deltaSig;
        }
        if (toolCall.function?.arguments) {
          const nextArgumentBytes = measureUtf8Bytes(toolCall.function.arguments);
          if (
            currentToolCallArgumentBytes + nextArgumentBytes >
            MAX_TOOL_CALL_ARGUMENT_BUFFER_BYTES
          ) {
            throw new Error("Exceeded tool-call argument buffer limit");
          }
          currentToolCallArgumentBytes += nextArgumentBytes;
          currentBlock.partialArgs += toolCall.function.arguments;
          currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
          stream.push({
            type: "toolcall_delta",
            contentIndex: blockIndex(),
            delta: toolCall.function.arguments,
            partial: output,
          });
        }
      }
    }
    flushPendingPostToolCallDeltas();
  }
  finishCurrentBlock();
  if (currentBlock?.type === "toolCall") {
    currentBlock = null;
  }
  flushPendingPostToolCallDeltas();
  const hasToolCalls = output.content.some((block) => block.type === "toolCall");
  if (output.stopReason === "toolUse" && !hasToolCalls) {
    output.stopReason = "stop";
  }
}

type CompletionsReasoningDelta =
  | {
      kind: "thinking";
      signature: string;
      text: string;
    }
  | {
      kind: "text";
      text: string;
    };

function getCompletionsReasoningDeltas(
  delta: Record<string, unknown>,
  visibleReasoningDetailTypes: readonly string[],
): CompletionsReasoningDelta[] {
  const output: CompletionsReasoningDelta[] = [];
  const pushDelta = (next: CompletionsReasoningDelta) => {
    const previous = output[output.length - 1];
    if (!previous || previous.kind !== next.kind) {
      output.push(next);
      return;
    }
    if (next.kind === "thinking" && previous.kind === "thinking") {
      if (previous.signature !== next.signature) {
        output.push(next);
        return;
      }
      previous.text += next.text;
      return;
    }
    previous.text += next.text;
  };
  const reasoningDetails = delta.reasoning_details;
  let usedReasoningThinkingDetails = false;
  if (Array.isArray(reasoningDetails)) {
    const visibleTypes = new Set(visibleReasoningDetailTypes);
    for (const item of reasoningDetails) {
      const detail = item as { type?: unknown; text?: unknown };
      if (typeof detail.text !== "string" || !detail.text) {
        continue;
      }
      if (detail.type === "reasoning.text") {
        usedReasoningThinkingDetails = true;
        pushDelta({ kind: "thinking", signature: "reasoning_details", text: detail.text });
        continue;
      }
      if (typeof detail.type === "string" && visibleTypes.has(detail.type)) {
        pushDelta({ kind: "text", text: detail.text });
      }
    }
  }
  if (!usedReasoningThinkingDetails) {
    const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
    for (const field of reasoningFields) {
      const value = delta[field];
      if (typeof value === "string" && value.length > 0) {
        pushDelta({ kind: "thinking", signature: field, text: value });
        break;
      }
    }
  }
  return output;
}

function detectCompat(model: OpenAIModeModel) {
  const provider = model.provider;
  const { capabilities, defaults: compatDefaults } = detectOpenAICompletionsCompat(model);
  const endpointClass = capabilities.endpointClass;
  const isDefaultRoute = endpointClass === "default";
  const isGroq = endpointClass === "groq-native" || (isDefaultRoute && provider === "groq");
  const reasoningEffortMap: Record<string, string> =
    isGroq && model.id === "qwen/qwen3-32b"
      ? {
          minimal: "default",
          low: "default",
          medium: "default",
          high: "default",
          xhigh: "default",
        }
      : {};
  return {
    supportsStore: compatDefaults.supportsStore,
    supportsDeveloperRole: compatDefaults.supportsDeveloperRole,
    supportsReasoningEffort: compatDefaults.supportsReasoningEffort,
    reasoningEffortMap,
    supportsUsageInStreaming: compatDefaults.supportsUsageInStreaming,
    maxTokensField: compatDefaults.maxTokensField,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    thinkingFormat: compatDefaults.thinkingFormat,
    visibleReasoningDetailTypes: compatDefaults.visibleReasoningDetailTypes,
    openRouterRouting: {},
    vercelGatewayRouting: {},
    supportsStrictMode: compatDefaults.supportsStrictMode,
  };
}

function getCompat(model: OpenAIModeModel): {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  reasoningEffortMap: Record<string, string>;
  supportsUsageInStreaming: boolean;
  maxTokensField: string;
  requiresToolResultName: boolean;
  requiresAssistantAfterToolResult: boolean;
  requiresThinkingAsText: boolean;
  thinkingFormat: string;
  openRouterRouting: Record<string, unknown>;
  vercelGatewayRouting: Record<string, unknown>;
  supportsStrictMode: boolean;
  requiresStringContent: boolean;
  visibleReasoningDetailTypes: string[];
} {
  const detected = detectCompat(model);
  const compat = model.compat ?? {};
  const supportsStore =
    typeof compat.supportsStore === "boolean" ? compat.supportsStore : detected.supportsStore;
  const supportsReasoningEffort =
    typeof compat.supportsReasoningEffort === "boolean"
      ? compat.supportsReasoningEffort
      : detected.supportsReasoningEffort;
  return {
    supportsStore,
    supportsDeveloperRole: compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort,
    reasoningEffortMap: resolveOpenAIReasoningEffortMap(model, detected.reasoningEffortMap),
    supportsUsageInStreaming: compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: (compat.maxTokensField as string | undefined) ?? detected.maxTokensField,
    requiresToolResultName: compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    thinkingFormat: (compat.thinkingFormat as string | undefined) ?? detected.thinkingFormat,
    openRouterRouting: (compat.openRouterRouting as Record<string, unknown> | undefined) ?? {},
    vercelGatewayRouting:
      (compat.vercelGatewayRouting as Record<string, unknown> | undefined) ??
      detected.vercelGatewayRouting,
    supportsStrictMode: compat.supportsStrictMode ?? detected.supportsStrictMode,
    requiresStringContent: compat.requiresStringContent ?? false,
    visibleReasoningDetailTypes:
      compat.visibleReasoningDetailTypes ?? detected.visibleReasoningDetailTypes,
  };
}

type OpenAIResponsesRequestParams = {
  model: string;
  input: ResponseInput;
  stream: true;
  prompt_cache_key?: string;
  prompt_cache_retention?: "24h";
  metadata?: Record<string, string>;
  store?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  service_tier?: ResponseCreateParamsStreaming["service_tier"];
  tools?: FunctionTool[];
  reasoning?:
    | { effort: OpenAIApiReasoningEffort }
    | {
        effort: OpenAIApiReasoningEffort;
        summary: NonNullable<OpenAIResponsesOptions["reasoningSummary"]>;
      };
  include?: string[];
};

function resolveOpenAICompletionsReasoningEffort(options: OpenAICompletionsOptions | undefined) {
  return options?.reasoningEffort ?? options?.reasoning ?? "high";
}

function convertTools(
  tools: NonNullable<Context["tools"]>,
  compat: ReturnType<typeof getCompat>,
  model: OpenAIModeModel,
) {
  const strict = resolveOpenAIStrictToolFlagWithDiagnostics(
    tools,
    resolveOpenAIStrictToolSetting(model, {
      transport: "stream",
      supportsStrictMode: compat?.supportsStrictMode,
    }),
    {
      transport: "completions",
      model,
    },
  );
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeOpenAIStrictToolParameters(tool.parameters, strict === true),
      ...(strict === undefined ? {} : { strict }),
    },
  }));
}

function extractGoogleThoughtSignature(toolCall: unknown): string | undefined {
  const tc = toolCall as Record<string, unknown> | undefined;
  if (!tc) {
    return undefined;
  }
  const extra = (tc.extra_content as Record<string, unknown> | undefined)?.google as
    | Record<string, unknown>
    | undefined;
  const fromExtra = extra?.thought_signature;
  if (typeof fromExtra === "string" && fromExtra.length > 0) {
    return fromExtra;
  }
  const fromFunction = (tc.function as { thought_signature?: unknown } | undefined)
    ?.thought_signature;
  return typeof fromFunction === "string" && fromFunction.length > 0 ? fromFunction : undefined;
}

function isGoogleOpenAICompatModel(model: OpenAIModeModel): boolean {
  const endpointClass = detectOpenAICompletionsCompat(model as Model<"openai-completions">)
    .capabilities.endpointClass;
  return (
    model.provider === "google" ||
    endpointClass === "google-generative-ai" ||
    endpointClass === "google-vertex"
  );
}

function injectToolCallThoughtSignatures(
  outgoingMessages: unknown[],
  context: Context,
  model: OpenAIModeModel,
): void {
  if (!isGoogleOpenAICompatModel(model)) {
    return;
  }
  const sigById = new Map<string, string>();
  for (const msg of context.messages ?? []) {
    if ((msg as { role?: string }).role !== "assistant") {
      continue;
    }
    const source = msg as { api?: string; provider?: string; model?: string; content?: unknown };
    if (
      source.api !== model.api ||
      source.provider !== model.provider ||
      source.model !== model.id
    ) {
      continue;
    }
    if (!Array.isArray(source.content)) {
      continue;
    }
    for (const block of source.content as Array<Record<string, unknown>>) {
      if (block.type !== "toolCall") {
        continue;
      }
      const id = block.id;
      const sig = block.thoughtSignature;
      if (typeof id === "string" && typeof sig === "string" && sig.length > 0) {
        sigById.set(id, sig);
      }
    }
  }
  if (sigById.size === 0) {
    return;
  }
  for (const message of outgoingMessages) {
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const toolCall of toolCalls as Array<Record<string, unknown>>) {
      const id = toolCall.id;
      if (typeof id !== "string") {
        continue;
      }
      const sig = sigById.get(id);
      if (!sig) {
        continue;
      }
      const extra =
        toolCall.extra_content && typeof toolCall.extra_content === "object"
          ? (toolCall.extra_content as Record<string, unknown>)
          : {};
      toolCall.extra_content = extra;
      const google =
        extra.google && typeof extra.google === "object"
          ? (extra.google as Record<string, unknown>)
          : {};
      extra.google = google;
      google.thought_signature = sig;
    }
  }
}

export function buildOpenAICompletionsParams(
  model: OpenAIModeModel,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
) {
  const compat = getCompat(model);
  const completionsContext = context.systemPrompt
    ? {
        ...context,
        systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
      }
    : context;
  const messages = convertMessages(model as never, completionsContext, compat as never);
  injectToolCallThoughtSignatures(messages as unknown[], context, model);
  const params: Record<string, unknown> = {
    model: model.id,
    messages: compat.requiresStringContent
      ? flattenCompletionMessagesToStringContent(messages)
      : messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (compat.supportsStore) {
    params.store = false;
  }
  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      params.max_tokens = options.maxTokens;
    } else {
      params.max_completion_tokens = options.maxTokens;
    }
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (context.tools) {
    params.tools = convertTools(context.tools, compat, model);
    if (options?.toolChoice) {
      params.tool_choice = options.toolChoice;
    }
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }
  const completionsReasoningEffort = resolveOpenAICompletionsReasoningEffort(options);
  const resolvedCompletionsReasoningEffort = completionsReasoningEffort
    ? resolveOpenAIReasoningEffortForModel({
        model,
        effort: completionsReasoningEffort,
        fallbackMap: compat.reasoningEffortMap,
      })
    : undefined;
  if (
    compat.thinkingFormat === "openrouter" &&
    model.reasoning &&
    resolvedCompletionsReasoningEffort
  ) {
    params.reasoning = {
      effort: resolvedCompletionsReasoningEffort,
    };
  } else if (
    resolvedCompletionsReasoningEffort &&
    model.reasoning &&
    compat.supportsReasoningEffort
  ) {
    params.reasoning_effort = resolvedCompletionsReasoningEffort;
  }
  return params;
}

export function parseTransportChunkUsage(
  rawUsage: NonNullable<ChatCompletionChunk["usage"]>,
  model: Model<Api>,
) {
  const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
  const promptTokens = rawUsage.prompt_tokens || 0;
  const input = Math.max(0, promptTokens - cachedTokens);
  const outputTokens = rawUsage.completion_tokens || 0;
  const usage = {
    input,
    output: outputTokens,
    cacheRead: cachedTokens,
    cacheWrite: 0,
    totalTokens: input + outputTokens + cachedTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model as never, usage as never);
  return usage;
}

function mapStopReason(reason: string | null) {
  if (reason === null) {
    return { stopReason: "stop" };
  }
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
    default:
      return {
        stopReason: "error",
        errorMessage: `Provider finish_reason: ${reason}`,
      };
  }
}

export const __testing = {
  buildOpenAICompletionsClientConfig,
  processOpenAICompletionsStream,
};
