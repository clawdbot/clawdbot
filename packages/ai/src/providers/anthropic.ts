// Anthropic provider adapts Anthropic streams and tool calls for the runtime.
import Anthropic from "@anthropic-ai/sdk";
import { Stream } from "@anthropic-ai/sdk/core/streaming.js";
import type {
  CacheControlEphemeral,
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import {
  createAnthropicInlineImageBudget,
  normalizeAnthropicInlineContent,
  resolveAnthropicImageMediaType,
  type AnthropicInlineImageBudget,
} from "../internal/anthropic-inline-images.js";
import { calculateCost } from "../model-utils.js";
import type { AnthropicOptions, AnthropicThinkingDisplay } from "../provider-options.js";
import { applyAnthropicCacheControlToMessages } from "../transports/anthropic-payload-policy.js";
import { snapshotProviderEndpointResolver } from "../transports/host-policy.js";
import { transportAbortError } from "../transports/transport-stream-shared.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import type {
  AnthropicMessagesCompat,
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  CacheRetention,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
} from "../types.js";
import { createDeferredEventBuffer } from "../utils/deferred-event-buffer.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
import { formatProviderError } from "../utils/provider-error.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "../utils/system-prompt-cache-boundary.js";
import {
  omitFoundryBearerCredentialHeaders,
  usesFoundryBearerAuth,
} from "./anthropic-auth-headers.js";
import {
  buildAnthropicGuardedFetch,
  canGuardAnthropicServerFallbackDispatch,
} from "./anthropic-guarded-fetch.js";
import {
  applyClaudeRequestContract,
  ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
  ANTHROPIC_CLAUDE_CODE_VERSION,
  mapAnthropicStopReason,
  prepareClaudeNoPrefillRequestContext,
  resolveAnthropicThinkingEffort,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  requiresClaudeAdaptiveThinking,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeXhighEffort,
  usesClaudeFable5MessagesContract,
  usesClaudeStreamingRefusalContract,
} from "./anthropic-model-contract.js";
import { applyAnthropicRefusal } from "./anthropic-refusal.js";
import {
  ANTHROPIC_SERVER_SIDE_FALLBACK_BETA,
  ANTHROPIC_SERVER_SIDE_FALLBACKS,
  applyAnthropicFallbackContentBoundary,
  applyAnthropicFallbackServingModel,
  assertAnthropicServerFallbackPayloadAuthorized,
  isCanonicalAnthropicPublicUrl,
  preserveAnthropicServerFallbackBetaHeader,
  readAnthropicFallbackBoundary,
  resolveAnthropicFallbackServingModelCost,
  snapshotAnthropicServerFallbackAuthorization,
} from "./anthropic-server-fallback.js";
import {
  anthropicSseTailHasModelFragment,
  classifyUnknownAnthropicSseFrame,
  createAnthropicEndpointAuthority,
  createAnthropicStreamTerminalCompleteness,
  isMatchingAnthropicSseEventPayload,
  type AnthropicEndpointAuthoritySnapshot,
} from "./anthropic-stream-terminal.js";
import {
  ANTHROPIC_OMITTED_REASONING_TEXT,
  findActiveAnthropicToolTurnAssistantIndex,
} from "./anthropic-thinking-replay.js";
import {
  normalizeAnthropicToolCallId,
  normalizeAnthropicToolChoice,
  projectAnthropicTools,
  reconcileAnthropicToolChoice,
  resolveOriginalAnthropicToolName,
  toClaudeCodeToolName,
  type AnthropicToolProjection,
} from "./anthropic-tool-projection.js";
import {
  createAnthropicTransportAccounting,
  inheritAnthropicTransportAccountingContext,
  type AnthropicFallbackResolution,
  type AnthropicTransportAccounting,
} from "./anthropic-transport-accounting.js";
import {
  applyAnthropicMessageDeltaUsage,
  applyAnthropicMessageStartUsage,
  type AnthropicPromptUsageSnapshot,
} from "./anthropic-usage.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import {
  adjustMaxTokensForThinking,
  buildBaseOptions,
  clampMaxTokensToModel,
} from "./simple-options.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultBlockText,
  extractToolResultText,
  isImageWithMediaPayload,
} from "./tool-result-text.js";
import { transformMessages } from "./transform-messages.js";

const ANTHROPIC_CACHE_CONTROL_LIMIT = 4;
const EMPTY_ERROR_TOOL_RESULT_TEXT = "[tool error with no output]";

function getCacheControl(
  model: Model<"anthropic-messages">,
  cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
  const retention = resolveCacheRetention(cacheRetention);
  if (retention === "none") {
    return { retention };
  }
  const ttl =
    retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
  return {
    retention,
    cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
  };
}

/**
 * Convert content blocks to Anthropic API format
 */
async function convertContentBlocks(
  content: readonly unknown[],
  isError: boolean,
  imageBudget: AnthropicInlineImageBudget,
): Promise<
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
            data: string;
          };
        }
    >
> {
  const text = extractToolResultText(content);
  const mediaPlaceholder = describeToolResultMediaPlaceholder(content);
  const hasImages = content.some(isImageWithMediaPayload);

  if (!hasImages) {
    const sanitized = sanitizeSurrogates(text);
    return sanitized.trim().length > 0
      ? sanitized
      : (mediaPlaceholder ?? (isError ? EMPTY_ERROR_TOOL_RESULT_TEXT : ""));
  }

  const blocks: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: {
          type: "base64";
          media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
          data: string;
        };
      }
  > = [];
  let hasTextBlock = false;

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    const blockText = extractToolResultBlockText(block);
    if (blockText) {
      blocks.push({ type: "text" as const, text: sanitizeSurrogates(blockText) });
      hasTextBlock = true;
    }
    if (!isImageWithMediaPayload(record)) {
      continue;
    }
    const [normalizedImage] = await normalizeAnthropicInlineContent(
      [
        {
          type: "image" as const,
          data: typeof record.data === "string" ? record.data : "",
          mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/jpeg",
        },
      ],
      imageBudget,
    );
    if (normalizedImage?.type !== "image") {
      continue;
    }
    blocks.push({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: resolveAnthropicImageMediaType(normalizedImage.mimeType),
        data: normalizedImage.data,
      },
    });
  }
  if (!hasTextBlock) {
    blocks.unshift({ type: "text" as const, text: mediaPlaceholder ?? "(see attached image)" });
  }

  return blocks;
}

export type {
  AnthropicEffort,
  AnthropicOptions,
  AnthropicThinkingDisplay,
} from "../provider-options.js";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const ANTHROPIC_MIN_THINKING_BUDGET_TOKENS = 1024;

function getAnthropicCompat(model: Model<"anthropic-messages">): Required<AnthropicMessagesCompat> {
  // Auto-detect session affinity and cache control support from provider
  const isFireworks = model.provider === "fireworks";
  const isCloudflareAiGatewayAnthropic =
    model.provider === "cloudflare-ai-gateway" && model.baseUrl.includes("anthropic");
  return {
    supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
    supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? !isFireworks,
    sendSessionAffinityHeaders:
      model.compat?.sendSessionAffinityHeaders ?? (isFireworks || isCloudflareAiGatewayAnthropic),
    supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? !isFireworks,
    allowEmptySignature: model.compat?.allowEmptySignature ?? false,
  };
}

function mergeHeaders(
  ...headerSources: (Record<string, string | null> | undefined)[]
): Record<string, string | null> {
  const merged: Record<string, string | null> = {};
  for (const headers of headerSources) {
    if (headers) {
      Object.assign(merged, headers);
    }
  }
  return merged;
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "error",
]);

const ANTHROPIC_SSE_EVENT_BOUNDARY = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/gu;

function trackAnthropicSseTail(
  response: Response,
  observeStructuralIncomplete: () => void,
): Response {
  if (!response.body) {
    return response;
  }
  const decoder = new TextDecoder();
  let pending = "";
  const observeText = (text: string): void => {
    pending += text;
    let boundaryEnd = 0;
    for (const match of pending.matchAll(ANTHROPIC_SSE_EVENT_BOUNDARY)) {
      boundaryEnd = (match.index ?? 0) + match[0].length;
    }
    if (boundaryEnd > 0) {
      pending = pending.slice(boundaryEnd);
    }
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observeText(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        observeText(decoder.decode());
        if (anthropicSseTailHasModelFragment(pending)) {
          observeStructuralIncomplete();
        }
      },
    }),
  );
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function* iterateAnthropicEvents(
  response: Response,
  terminal: {
    observeMessageStop: () => void;
    observeStandaloneDone: () => void;
    observeStructuralIncomplete: () => void;
  },
): AsyncGenerator<RawMessageStreamEvent> {
  if (!response.body) {
    throw new Error("Attempted to iterate over an Anthropic response with no body");
  }

  const events = Stream.rawEvents(
    trackAnthropicSseTail(response, terminal.observeStructuralIncomplete),
  )[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = await events.next();
      if (next.done) {
        completed = true;
        return;
      }
      const sse = next.value;
      if (sse.event === null && sse.data.trim() === "[DONE]") {
        terminal.observeStandaloneDone();
        return;
      }
      if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
        const classify =
          sse.event === null && /^\s*[{[]/u.test(sse.data)
            ? (data: string) => parseJsonWithRepair(data)
            : JSON.parse;
        let classification: ReturnType<typeof classifyUnknownAnthropicSseFrame>;
        try {
          classification = classifyUnknownAnthropicSseFrame(sse.data, classify);
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause: error });
          }
          throw error;
        }
        if (classification === "model_event") {
          terminal.observeStructuralIncomplete();
        } else if (sse.event === null && /^\s*[{[]/u.test(sse.data)) {
          try {
            parseJsonWithRepair(sse.data);
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause: error });
            }
            throw error;
          }
        }
        continue;
      }
      try {
        const event = parseJsonWithRepair(sse.data);
        if (!isMatchingAnthropicSseEventPayload(sse.event ?? "", event)) {
          terminal.observeStructuralIncomplete();
          continue;
        }
        if (event.type === "error") {
          const error = event.error as { message?: unknown } | undefined;
          throw new Error(
            typeof error?.message === "string" ? error.message : "Anthropic Messages stream failed",
          );
        }
        if (event.type === "message_stop") {
          terminal.observeMessageStop();
        }
        yield event as RawMessageStreamEvent;
      } catch (error) {
        // Frame payloads carry model output, so surface the shared malformed-fragment
        // error instead of echoing them. The SyntaxError stays reachable on `cause`.
        if (error instanceof SyntaxError) {
          throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause: error });
        }
        throw error;
      }
    }
  } finally {
    if (!completed) {
      try {
        await events.return?.();
      } catch {
        // Stream cleanup is best-effort and must not override terminal authority.
      }
    }
  }
}

function applyAnthropicFallbackResolution(params: {
  model: Model<"anthropic-messages">;
  output: AssistantMessage;
  resolution: AnthropicFallbackResolution;
}): Model<"anthropic-messages"> {
  for (const transition of params.resolution.productTransitions) {
    applyAnthropicFallbackServingModel({
      output: params.output,
      boundary: transition,
      provider: params.model.provider,
    });
  }
  const servingModel =
    params.resolution.servingModel ?? params.resolution.productTransitions.at(-1)?.toModel ?? null;
  const costModel = {
    ...params.model,
    cost: resolveAnthropicFallbackServingModelCost({
      requestedModelId: params.model.id,
      servingModelId: servingModel,
      requestedCost: params.model.cost,
    }),
  };
  calculateCost(costModel, params.output.usage);
  return costModel;
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
) => {
  const stream = new AssistantMessageEventStream();
  const requestContext = prepareClaudeNoPrefillRequestContext(model, context);
  const requestOptions = normalizeAnthropicThinkingOptions(model, options);

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api as Api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tokenCountsOrigin: "runtime-placeholder",
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    // Classifier refusals can invalidate partial output, so no event is safe
    // to expose until the terminal stop reason is known.
    const refusalBuffer = usesClaudeStreamingRefusalContract(model)
      ? createDeferredEventBuffer<AssistantMessageEvent>(stream, () =>
          notifyLlmRequestActivity(requestOptions?.signal),
        )
      : undefined;
    const eventSink = refusalBuffer ?? stream;
    // Fallback-served turns bill at the serving model's rates; a boundary
    // swaps this to the fallback model's cost table.
    let costModel = model;
    let messageStartPromptUsage: AnthropicPromptUsageSnapshot | undefined;
    let transportAccounting: AnthropicTransportAccounting | undefined;
    let transportAccountingCompleted = false;
    let providerInvocationStarted = false;
    const effectiveMaxRetries = requestOptions?.maxRetries ?? 0;
    let getEndpointAuthority: (() => AnthropicEndpointAuthoritySnapshot) | undefined;

    try {
      let client: Anthropic;
      let isOAuth: boolean;
      let observeProvisionalEndpoint = () => {};
      // The beta-gated fallbacks param may only ship on clients we built,
      // where the matching beta header is guaranteed; injected clients carry
      // caller-owned headers.
      let serverSideFallback = false;

      if (requestOptions?.client) {
        client = requestOptions.client;
        isOAuth = false;
        transportAccounting = createAnthropicTransportAccounting({
          fallbackBoundaryAuthority: "client_provisional",
          maxRetries: effectiveMaxRetries,
          model,
          options: requestOptions,
          serverFallbackEnabled: false,
        });
        const resolveProviderEndpoint = snapshotProviderEndpointResolver();
        const endpointAuthority = createAnthropicEndpointAuthority({
          provider: model.provider,
          resolveEndpointClass: (url) => resolveProviderEndpoint(url).endpointClass,
        });
        observeProvisionalEndpoint = () =>
          endpointAuthority.observeProvisional(client.baseURL ?? model.baseUrl);
        getEndpointAuthority = () => endpointAuthority.snapshot();
      } else {
        const apiKey = requestOptions?.apiKey ?? getEnvApiKey(model.provider) ?? "";
        const effectiveModel = {
          ...model,
          baseUrl: resolveAnthropicSdkBaseUrl(model.baseUrl),
        };

        let copilotDynamicHeaders: Record<string, string> | undefined;
        if (model.provider === "github-copilot") {
          const hasImages = hasCopilotVisionInput(requestContext.messages);
          copilotDynamicHeaders = buildCopilotDynamicHeaders({
            messages: requestContext.messages,
            hasImages,
          });
        }

        const cacheRetention = requestOptions?.cacheRetention ?? resolveCacheRetention();
        const cacheSessionId = cacheRetention === "none" ? undefined : requestOptions?.sessionId;

        serverSideFallback =
          !isOAuthToken(apiKey) &&
          supportsAnthropicServerSideFallback(effectiveModel) &&
          canGuardAnthropicServerFallbackDispatch();
        transportAccounting = createAnthropicTransportAccounting({
          fallbackBoundaryAuthority: serverSideFallback
            ? "server_authoritative"
            : "client_provisional",
          maxRetries: effectiveMaxRetries,
          model,
          options: requestOptions,
          serverFallbackEnabled: serverSideFallback,
        });
        const created = createClient(
          effectiveModel,
          apiKey,
          requestOptions?.thinkingEnabled === true,
          requestOptions?.interleavedThinking ?? true,
          shouldUseFineGrainedToolStreamingBeta(model, requestContext),
          requestOptions?.headers,
          copilotDynamicHeaders,
          cacheSessionId,
          serverSideFallback,
          requestOptions?.requestId ? transportAccounting : undefined,
        );
        client = created.client;
        isOAuth = created.isOAuthToken;
        serverSideFallback = created.serverSideFallback;
        getEndpointAuthority = created.getEndpointAuthority;
      }
      const builtParams = await buildParams(
        model,
        requestContext,
        isOAuth,
        requestOptions,
        serverSideFallback,
      );
      let params = builtParams.params;
      const fallbackAuthorization = serverSideFallback
        ? snapshotAnthropicServerFallbackAuthorization(params)
        : undefined;
      const toolProjection = builtParams.toolProjection;
      const nextParams = await requestOptions?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as MessageCreateParamsStreaming;
      }
      applyClaudeRequestContract(params as unknown as Record<string, unknown>, model);
      assertAnthropicServerFallbackPayloadAuthorized({
        authorization: fallbackAuthorization,
        payload: params,
      });
      transportAccounting?.observeFinalRequestPayload(params);
      providerInvocationStarted = true;
      if (requestOptions?.client) {
        transportAccounting?.observeSemanticCoverage("transport_submission_authority_partial");
      }
      observeProvisionalEndpoint();
      const sdkRequestOptions = {
        ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
        ...(requestOptions?.timeoutMs !== undefined ? { timeout: requestOptions.timeoutMs } : {}),
        maxRetries: effectiveMaxRetries,
      };
      const response = await client.messages
        .create({ ...params, stream: true }, sdkRequestOptions)
        .asResponse();
      const endpointAuthority = getEndpointAuthority();
      if (endpointAuthority.traceState !== "exact") {
        transportAccounting?.observeSemanticCoverage("transport_endpoint_authority_partial");
      }
      await requestOptions?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );

      type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & {
        index: number;
      };
      const blocks = output.content as Block[];
      const blockIndexes = new Map<number, number>();
      const terminalCompleteness = createAnthropicStreamTerminalCompleteness({
        requireMessageStop: endpointAuthority.requiresMessageStop || refusalBuffer !== undefined,
      });

      for await (const event of iterateAnthropicEvents(response, terminalCompleteness)) {
        if (event.type === "message_start") {
          terminalCompleteness.observeMessageStart();
          output.responseId = event.message.id;
          output.responseModel = event.message.model;
          messageStartPromptUsage = applyAnthropicMessageStartUsage(
            output.usage,
            event.message.usage,
          );
          calculateCost(costModel, output.usage);
          // Defer start until after message_start so that pre-stream SSE errors
          // (e.g. invalid thinking signatures) arrive before any non-error event
          // is yielded, keeping yieldedOutput=false in pumpStreamWithRecovery
          // and allowing the thinking-block recovery retry to fire.
          eventSink.push({ type: "start", partial: output });
        } else if (event.type === "content_block_start") {
          terminalCompleteness.observeContentBlockStart(event.index);
          const fallbackBoundary = refusalBuffer
            ? readAnthropicFallbackBoundary(event.content_block)
            : null;
          if (!fallbackBoundary) {
            transportAccounting.observeFallbackContent();
          }
          if (fallbackBoundary) {
            // Server-side fallback boundary: pre-boundary thinking/tool blocks
            // must not replay or execute, and the buffered preview events
            // reference them, so rebuild the deferred timeline from the
            // surviving text prefix the fallback model continued from.
            refusalBuffer?.discard();
            blockIndexes.clear();
            applyAnthropicFallbackContentBoundary(output);
            transportAccounting.observeFallbackBoundary(fallbackBoundary);
            eventSink.push({ type: "start", partial: output });
            for (const [i, block] of blocks.entries()) {
              if (block.type !== "text") {
                continue;
              }
              delete (block as Partial<Block>).index;
              eventSink.push({ type: "text_start", contentIndex: i, partial: output });
              if (block.text) {
                eventSink.push({
                  type: "text_delta",
                  contentIndex: i,
                  delta: block.text,
                  partial: output,
                });
              }
              eventSink.push({
                type: "text_end",
                contentIndex: i,
                content: block.text,
                partial: output,
              });
            }
          } else if (event.content_block.type === "text") {
            const block: Block = {
              type: "text",
              text: "",
              index: event.index,
            };
            output.content.push(block);
            blockIndexes.set(event.index, output.content.length - 1);
            eventSink.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "thinking") {
            const block: Block = {
              type: "thinking",
              thinking: "",
              thinkingSignature: "",
              index: event.index,
            };
            output.content.push(block);
            blockIndexes.set(event.index, output.content.length - 1);
            eventSink.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "redacted_thinking") {
            const block: Block = {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: event.content_block.data,
              redacted: true,
              index: event.index,
            };
            output.content.push(block);
            blockIndexes.set(event.index, output.content.length - 1);
            eventSink.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "tool_use") {
            const block: Block = {
              type: "toolCall",
              id: event.content_block.id,
              name: isOAuth
                ? resolveOriginalAnthropicToolName(event.content_block.name, toolProjection)
                : event.content_block.name,
              arguments: (event.content_block.input as Record<string, unknown>) ?? {},
              partialJson: "",
              index: event.index,
            };
            output.content.push(block);
            blockIndexes.set(event.index, output.content.length - 1);
            eventSink.push({
              type: "toolcall_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
        } else if (event.type === "content_block_delta") {
          terminalCompleteness.observeContentBlockDelta(event.index);
          if (event.delta.type === "text_delta") {
            let index = blockIndexes.get(event.index);
            let block = index === undefined ? undefined : blocks[index];
            if (!block) {
              block = {
                type: "text",
                text: "",
                index: event.index,
              };
              output.content.push(block);
              index = output.content.length - 1;
              blockIndexes.set(event.index, index);
              eventSink.push({
                type: "text_start",
                contentIndex: index,
                partial: output,
              });
            }
            if (index !== undefined && block?.type === "text") {
              block.text += event.delta.text;
              eventSink.push({
                type: "text_delta",
                contentIndex: index,
                delta: event.delta.text,
                partial: output,
              });
            }
          } else if (event.delta.type === "thinking_delta") {
            const index = blockIndexes.get(event.index);
            const block = index === undefined ? undefined : blocks[index];
            if (index !== undefined && block?.type === "thinking") {
              block.thinking += event.delta.thinking;
              eventSink.push({
                type: "thinking_delta",
                contentIndex: index,
                delta: event.delta.thinking,
                partial: output,
              });
            }
          } else if (event.delta.type === "input_json_delta") {
            const index = blockIndexes.get(event.index);
            const block = index === undefined ? undefined : blocks[index];
            if (index !== undefined && block?.type === "toolCall") {
              block.partialJson += event.delta.partial_json;
              block.arguments = parseStreamingJson(block.partialJson);
              eventSink.push({
                type: "toolcall_delta",
                contentIndex: index,
                delta: event.delta.partial_json,
                partial: output,
              });
            }
          } else if (event.delta.type === "signature_delta") {
            const index = blockIndexes.get(event.index);
            const block = index === undefined ? undefined : blocks[index];
            if (index !== undefined && block?.type === "thinking") {
              block.thinkingSignature = block.thinkingSignature || "";
              block.thinkingSignature += event.delta.signature;
            }
          }
        } else if (event.type === "content_block_stop") {
          terminalCompleteness.observeContentBlockStop(event.index);
          const index = blockIndexes.get(event.index);
          const block = index === undefined ? undefined : blocks[index];
          if (index !== undefined && block) {
            blockIndexes.delete(event.index);
            delete (block as Partial<Block>).index;
            if (block.type === "text") {
              eventSink.push({
                type: "text_end",
                contentIndex: index,
                content: block.text,
                partial: output,
              });
            } else if (block.type === "thinking") {
              eventSink.push({
                type: "thinking_end",
                contentIndex: index,
                content: block.thinking,
                partial: output,
              });
            } else if (block.type === "toolCall") {
              block.arguments = parseStreamingJson(block.partialJson);
              // Finalize in-place and strip the scratch buffer so replay only
              // carries parsed arguments.
              delete (block as { partialJson?: string }).partialJson;
              eventSink.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall: block,
                partial: output,
              });
            }
          }
        } else if (event.type === "message_delta") {
          terminalCompleteness.observeMessageDelta();
          if (event.delta.stop_reason) {
            transportAccounting?.observeFallbackContent();
            if (event.delta.stop_reason === "refusal") {
              applyAnthropicRefusal(output, event.delta.stop_details, model.provider);
            } else {
              output.stopReason = mapAnthropicStopReason(event.delta.stop_reason);
            }
            terminalCompleteness.observeMappedStopReason(event.delta.stop_reason);
          }
          // Missing terminal usage is an incomplete observation, not permission
          // to leave the provisional message-start snapshot looking final.
          applyAnthropicMessageDeltaUsage(output.usage, event.usage, messageStartPromptUsage);
          if (event.delta.stop_reason) {
            transportAccounting?.observeTerminalUsage(event.usage);
          }
          calculateCost(costModel, output.usage);
        }
      }
      if (
        blockIndexes.size > 0 ||
        blocks.some(
          (block) => block.type === "toolCall" && Object.hasOwn(block as object, "partialJson"),
        )
      ) {
        terminalCompleteness.observeStructuralIncomplete();
      }
      const terminalEvidence = terminalCompleteness.assertComplete();
      transportAccounting?.sealTerminalUsage();
      if (terminalEvidence.state === "unverified") {
        transportAccounting?.observeSemanticCoverage("transport_terminal_unverified");
      }

      if (requestOptions?.signal?.aborted) {
        throw transportAbortError(requestOptions.signal);
      }

      const terminalError =
        output.stopReason === "aborted" || output.stopReason === "error"
          ? new Error(output.errorMessage ?? "An unknown error occurred")
          : undefined;
      const fallbackResolution = terminalError
        ? transportAccounting?.completeFailure(terminalError)
        : transportAccounting?.completeSuccess();
      if (fallbackResolution) {
        costModel = applyAnthropicFallbackResolution({
          model,
          output,
          resolution: fallbackResolution,
        });
      }
      transportAccountingCompleted = true;
      if (terminalError) {
        throw terminalError;
      }
      const doneReason = output.stopReason;
      if (doneReason !== "stop" && doneReason !== "length" && doneReason !== "toolUse") {
        throw new Error("Anthropic stream ended without a valid terminal stop reason");
      }
      refusalBuffer?.flush();
      stream.push({ type: "done", reason: doneReason, message: output });
      stream.end();
    } catch (error) {
      const endpointAuthority = getEndpointAuthority?.();
      if (
        providerInvocationStarted &&
        transportAccounting &&
        (!endpointAuthority || endpointAuthority.traceState !== "exact")
      ) {
        transportAccounting?.observeSemanticCoverage("transport_endpoint_authority_partial");
      }
      const failureResolution = transportAccounting?.fail(error);
      if (!transportAccountingCompleted) {
        output.responseModel = model.id;
      }
      if (!transportAccountingCompleted && failureResolution) {
        for (const transition of failureResolution.productTransitions) {
          applyAnthropicFallbackServingModel({
            output,
            boundary: transition,
            provider: model.provider,
          });
        }
      }
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // partialJson is only a streaming scratch buffer; never persist it.
        delete (block as { partialJson?: string }).partialJson;
      }
      if (refusalBuffer) {
        refusalBuffer.discard();
        output.content = [];
      }
      output.stopReason = requestOptions?.signal?.aborted ? "aborted" : "error";
      // A bare JSON.stringify here dies on the circular error objects HTTP/socket
      // layers raise, and the throw escapes this catch so stream.end() never runs
      // and the consumer hangs. formatProviderError guards that conversion, matching
      // the other provider terminal paths.
      output.errorMessage = formatProviderError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

function normalizeAnthropicThinkingOptions(
  model: Model<"anthropic-messages">,
  options: AnthropicOptions | undefined,
): AnthropicOptions | undefined {
  if (options?.thinkingEnabled !== true || supportsClaudeAdaptiveThinking(model)) {
    return options;
  }

  const budgetTokens = options.thinkingBudgetTokens ?? ANTHROPIC_MIN_THINKING_BUDGET_TOKENS;
  const maxTokens = options.maxTokens ?? model.maxTokens;
  if (budgetTokens >= ANTHROPIC_MIN_THINKING_BUDGET_TOKENS && budgetTokens < maxTokens) {
    return options;
  }

  // Manual thinking is one request-wide mode: replay, sampling, tool choice,
  // headers, and payload construction must all observe the disabled state.
  return { ...options, thinkingEnabled: false, thinkingBudgetTokens: undefined };
}

type AnthropicSimpleStreamOptions = SimpleStreamOptions & {
  toolChoice?: AnthropicOptions["toolChoice"];
};

export const streamSimpleAnthropic: StreamFunction<
  "anthropic-messages",
  AnthropicSimpleStreamOptions
> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicSimpleStreamOptions,
) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = inheritAnthropicTransportAccountingContext(options, {
    ...buildBaseOptions(model, options, apiKey),
    maxTokens: clampMaxTokensToModel(model, options?.maxTokens ?? model.maxTokens),
    requestId: options?.requestId,
    toolChoice: options?.toolChoice,
  });
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  if (options?.reasoning === "off" && !mandatoryAdaptiveThinking) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: false,
    } satisfies AnthropicOptions);
  }
  const reasoning =
    options?.reasoning === "off"
      ? mandatoryAdaptiveThinking
        ? "low"
        : "high"
      : options?.reasoning;
  if (resolveClaudeOpus5ModelIdentity(model) || resolveClaudeSonnet5ModelIdentity(model)) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: true,
      effort: resolveAnthropicThinkingEffort(model, reasoning ?? "high"),
    } satisfies AnthropicOptions);
  }
  if (!reasoning) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: mandatoryAdaptiveThinking,
      ...(mandatoryAdaptiveThinking ? { effort: "high" as const } : {}),
    } satisfies AnthropicOptions);
  }

  // For Opus 4.6 and Sonnet 4.6: use adaptive thinking with effort level
  // For older models: use budget-based thinking
  if (supportsClaudeAdaptiveThinking(model)) {
    const effort = resolveAnthropicThinkingEffort(model, reasoning);
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: true,
      effort,
    } satisfies AnthropicOptions);
  }

  // Undefined means the caller did not request an output cap; let the helper use the model cap.
  // Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
  const adjusted = adjustMaxTokensForThinking(
    base.maxTokens,
    model.maxTokens,
    reasoning,
    options?.thinkingBudgets,
  );
  // Sub-minimum budgets (< 1024) resolve to thinking disabled so downstream
  // consumers (payload, replay, temperature, tool-choice) see consistent state.
  const thinkingEnabled = adjusted.thinkingBudget >= ANTHROPIC_MIN_THINKING_BUDGET_TOKENS;
  // When thinking cannot fit, restore the visible-output cap instead of keeping
  // the thinking-inflated request limit from adjustMaxTokensForThinking.
  const maxTokens = thinkingEnabled
    ? adjusted.maxTokens
    : clampMaxTokensToModel(model, options?.maxTokens ?? model.maxTokens);
  return streamAnthropic(model, context, {
    ...base,
    maxTokens,
    thinkingEnabled,
    thinkingBudgetTokens: thinkingEnabled ? adjusted.thinkingBudget : undefined,
  } satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
  // Inspect the host-resolved shape only for auth routing; the SDK still receives the sentinel.
  return getAiTransportHost().resolveSecretSentinel(apiKey).includes("sk-ant-oat");
}

const DEFAULT_ANTHROPIC_SDK_BASE_URL = "https://api.anthropic.com";

function resolveAnthropicSdkBaseUrl(baseUrl: string | undefined): string {
  return (
    baseUrl?.trim() || process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_SDK_BASE_URL
  );
}

/**
 * Server-side refusal fallback is a first-party Claude API beta: proxies and
 * Bedrock/Vertex/Foundry reject the `fallbacks` param, and OAuth (Claude Code
 * identity) requests are excluded until the beta is verified there.
 */
function supportsAnthropicServerSideFallback(model: Model<"anthropic-messages">): boolean {
  if (
    (!usesClaudeFable5MessagesContract(model) &&
      resolveClaudeOpus5ModelIdentity(model) === undefined) ||
    model.provider !== "anthropic"
  ) {
    return false;
  }
  return isCanonicalAnthropicPublicUrl(model.baseUrl);
}

function createClient(
  model: Model<"anthropic-messages">,
  apiKey: string,
  thinkingEnabled: boolean,
  interleavedThinking: boolean,
  useFineGrainedToolStreamingBeta: boolean,
  optionsHeaders?: Record<string, string>,
  dynamicHeaders?: Record<string, string>,
  sessionId?: string,
  serverSideFallback = false,
  transportAccounting?: AnthropicTransportAccounting,
): {
  client: Anthropic;
  getEndpointAuthority: () => AnthropicEndpointAuthoritySnapshot;
  isOAuthToken: boolean;
  serverSideFallback: boolean;
} {
  // Adaptive thinking models (Opus 4.6, Sonnet 4.6) have interleaved thinking built-in.
  // The beta header is deprecated on Opus 4.6 and redundant on Sonnet 4.6, so skip it.
  const needsInterleavedBeta = interleavedThinking && !supportsClaudeAdaptiveThinking(model);
  const betaFeatures: string[] = [];
  if (useFineGrainedToolStreamingBeta) {
    betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  if (needsInterleavedBeta) {
    betaFeatures.push(INTERLEAVED_THINKING_BETA);
  }
  // Anthropic supports custom fetch, so sentinels stay opaque until guarded egress.
  const guardedFetch = buildAnthropicGuardedFetch({
    model,
    sanitizeSse: /^kimi(?:-|$)/.test(model.provider) && thinkingEnabled ? false : undefined,
    serverSideFallback,
    transportAccounting,
  });
  const finishClient = (
    client: Anthropic,
    isOAuthTokenResult: boolean,
    fallbackEnabled: boolean,
  ) => ({
    client,
    getEndpointAuthority: guardedFetch.getEndpointAuthority,
    isOAuthToken: isOAuthTokenResult,
    serverSideFallback: fallbackEnabled,
  });

  if (model.provider === "cloudflare-ai-gateway") {
    const client = new Anthropic({
      apiKey,
      authToken: null,
      baseURL: resolveCloudflareBaseUrl(model),
      dangerouslyAllowBrowser: true,
      defaultHeaders: mergeHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          Authorization: null,
          ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
        },
        model.headers,
        optionsHeaders,
      ),
      fetch: guardedFetch.fetch,
    });

    return finishClient(client, false, false);
  }

  // Copilot: Bearer auth, selective betas.
  if (model.provider === "github-copilot") {
    const client = new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: mergeHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
        },
        model.headers,
        dynamicHeaders,
        optionsHeaders,
      ),
      fetch: guardedFetch.fetch,
    });

    return finishClient(client, false, false);
  }

  if (
    usesFoundryBearerAuth({
      ...model,
      headers: resolveAiTransportHeaderSentinels(model.headers),
    })
  ) {
    const client = new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: mergeHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
        },
        omitFoundryBearerCredentialHeaders(model.headers),
        dynamicHeaders,
        optionsHeaders,
      ),
      fetch: guardedFetch.fetch,
    });

    return finishClient(client, false, false);
  }

  // OAuth: Bearer auth, Claude Code identity headers
  if (isOAuthToken(apiKey)) {
    const client = new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true,
      defaultHeaders: mergeHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          "anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
          "user-agent": `claude-cli/${ANTHROPIC_CLAUDE_CODE_VERSION}`,
          "x-app": "cli",
        },
        model.headers,
        optionsHeaders,
      ),
      fetch: guardedFetch.fetch,
    });

    return finishClient(client, true, false);
  }

  // API key auth
  if (serverSideFallback) {
    betaFeatures.push(ANTHROPIC_SERVER_SIDE_FALLBACK_BETA);
  }
  const sessionAffinityHeaders: Record<string, string | null> =
    sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders
      ? { "x-session-affinity": sessionId }
      : {};
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: preserveAnthropicServerFallbackBetaHeader(
      mergeHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
        },
        sessionAffinityHeaders,
        model.headers,
        optionsHeaders,
      ),
      serverSideFallback,
    ),
    fetch: guardedFetch.fetch,
  });

  return finishClient(client, false, serverSideFallback);
}

async function buildParams(
  model: Model<"anthropic-messages">,
  context: Context,
  isOAuthTokenResult: boolean,
  options?: AnthropicOptions,
  serverSideFallback = false,
): Promise<{
  params: MessageCreateParamsStreaming;
  toolProjection?: AnthropicToolProjection;
}> {
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  const replayThinkingEnabled = mandatoryAdaptiveThinking || options?.thinkingEnabled === true;
  const { cacheControl } = getCacheControl(model, options?.cacheRetention);
  const system = buildAnthropicSystemBlocks(context.systemPrompt, isOAuthTokenResult, cacheControl);
  const compat = getAnthropicCompat(model);
  const convertedTools = context.tools
    ? convertTools(
        context.tools,
        isOAuthTokenResult,
        compat.supportsEagerToolInputStreaming,
        compat.supportsCacheControlOnTools ? cacheControl : undefined,
      )
    : undefined;
  const tools = convertedTools?.tools;
  const toolProjection = convertedTools?.projection;
  const systemCacheControlCount = countNativeCacheControlMarkers(system);
  const toolCacheControlCount = countNativeCacheControlMarkers(tools);
  const messageCacheControlLimit = Math.max(
    0,
    ANTHROPIC_CACHE_CONTROL_LIMIT - systemCacheControlCount - toolCacheControlCount,
  );
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    messages: await convertMessages(
      context.messages,
      model,
      isOAuthTokenResult,
      cacheControl,
      messageCacheControlLimit,
      replayThinkingEnabled,
      compat.allowEmptySignature,
    ),
    max_tokens: options?.maxTokens ?? model.maxTokens,
    stream: true,
  };

  if (system) {
    params.system = system;
  }

  // Fable 5 and Opus 5 safety classifiers can decline benign-adjacent work.
  // Anthropic owns the per-category fallback recommendation so routing can
  // evolve without a client release.
  if (serverSideFallback) {
    (params as { fallbacks?: "default" }).fallbacks = ANTHROPIC_SERVER_SIDE_FALLBACKS;
  }

  // Thinking and post-4.6 Claude models reject custom temperature values.
  if (
    options?.temperature !== undefined &&
    !options?.thinkingEnabled &&
    !supportsClaudeNativeXhighEffort(model)
  ) {
    params.temperature = options.temperature;
  }

  if (options?.stop !== undefined && options.stop.length > 0) {
    params.stop_sequences = options.stop;
  }

  if (tools && tools.length > 0) {
    params.tools = tools;
  }

  // Configure thinking mode: always-on adaptive (Fable 5 and Mythos 5),
  // adaptive (Opus 4.6+ and Sonnet 4.6),
  // budget-based (older models), or explicitly disabled.
  if (mandatoryAdaptiveThinking || model.reasoning || supportsClaudeAdaptiveThinking(model)) {
    if (mandatoryAdaptiveThinking || options?.thinkingEnabled) {
      // Default to "summarized" so Opus 4.7+ and Mythos Preview behave like
      // older Claude 4 models (whose API default is also "summarized").
      const display: AnthropicThinkingDisplay = options?.thinkingDisplay ?? "summarized";
      if (supportsClaudeAdaptiveThinking(model)) {
        // Adaptive thinking: Claude decides when and how much to think.
        params.thinking = { type: "adaptive", display };
        const effort = options?.effort ?? (mandatoryAdaptiveThinking ? "high" : undefined);
        if (effort) {
          // The Anthropic SDK types can lag newly supported effort values such as "xhigh".
          params.output_config =
            effort === "xhigh"
              ? ({ effort } as unknown as NonNullable<
                  MessageCreateParamsStreaming["output_config"]
                >)
              : { effort };
        }
      } else {
        // Budget-based thinking for older models.
        params.thinking = {
          type: "enabled",
          budget_tokens: options?.thinkingBudgetTokens ?? ANTHROPIC_MIN_THINKING_BUDGET_TOKENS,
          display,
        };
      }
    } else if (options?.thinkingEnabled === false) {
      params.thinking = { type: "disabled" };
    }
  }

  if (options?.metadata) {
    const userId = options.metadata.user_id;
    if (typeof userId === "string") {
      params.metadata = { user_id: userId };
    }
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

  return { params, toolProjection };
}

async function convertMessages(
  messages: Message[],
  model: Model<"anthropic-messages">,
  isOAuthTokenValue: boolean,
  cacheControl?: CacheControlEphemeral,
  messageCacheControlLimit = 4,
  replayThinkingEnabled = true,
  allowEmptySignature = false,
): Promise<MessageParam[]> {
  const params: MessageParam[] = [];
  const imageBudget = createAnthropicInlineImageBudget();
  // Param indexes for transient runtime-context carriers — excluded from
  // cache_control breakpoint selection so the deepest breakpoint anchors on the
  // last stable user turn, not the volatile carrier appended after it.
  const cacheBreakpointOptOutParamIndexes = new Set<number>();

  // Transform messages for cross-provider compatibility
  const transformedMessages = transformMessages(messages, model, normalizeAnthropicToolCallId);
  const activeToolTurnAssistantIndex = replayThinkingEnabled
    ? -1
    : findActiveAnthropicToolTurnAssistantIndex(transformedMessages);

  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (!msg) {
      continue;
    }

    if (msg.role === "user") {
      const isRuntimeContextCarrier = msg.runtimeContextCarrier === true;
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          if (isRuntimeContextCarrier) {
            cacheBreakpointOptOutParamIndexes.add(params.length);
          }
          params.push({
            role: "user",
            content: sanitizeSurrogates(msg.content),
          });
        }
      } else {
        const normalizedContent = await normalizeAnthropicInlineContent(msg.content, imageBudget);
        const blocks: ContentBlockParam[] = normalizedContent.map((item) => {
          if (item.type === "text") {
            return {
              type: "text",
              text: sanitizeSurrogates(item.text),
            };
          }
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: resolveAnthropicImageMediaType(item.mimeType),
              data: item.data,
            },
          };
        });
        const filteredBlocks = blocks.filter((b) => {
          if (b.type === "text") {
            return b.text.trim().length > 0;
          }
          return true;
        });
        if (filteredBlocks.length === 0) {
          continue;
        }
        if (isRuntimeContextCarrier) {
          cacheBreakpointOptOutParamIndexes.add(params.length);
        }
        params.push({
          role: "user",
          content: filteredBlocks,
        });
      }
    } else if (msg.role === "assistant") {
      const blocks: ContentBlockParam[] = [];
      let omittedThinking = false;

      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) {
            continue;
          }
          blocks.push({
            type: "text",
            text: sanitizeSurrogates(block.text),
          });
        } else if (block.type === "thinking") {
          if (!replayThinkingEnabled && i !== activeToolTurnAssistantIndex) {
            omittedThinking = true;
            continue;
          }
          // Redacted thinking: pass the opaque payload back as redacted_thinking
          if (block.redacted) {
            if (!block.thinkingSignature) {
              throw new Error("redacted thinking block is missing its opaque signature");
            }
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature,
            });
            continue;
          }
          const thinkingSignature = block.thinkingSignature?.trim();
          const hasNativeThinkingSignature =
            Boolean(thinkingSignature) && thinkingSignature !== "reasoning_content";
          if (block.thinking.trim().length === 0 && !hasNativeThinkingSignature) {
            continue;
          }
          // If thinking signature is missing/empty (e.g., from aborted stream),
          // convert to plain text block without <thinking> tags to avoid API rejection
          // and prevent Claude from mimicking the tags in responses
          if (!thinkingSignature && !allowEmptySignature) {
            blocks.push({
              type: "text",
              text: sanitizeSurrogates(block.thinking),
            });
          } else {
            // OpenAI-compatible reasoning markers are field names, not native
            // Anthropic replay signatures; sending them bricks persisted replays.
            if (thinkingSignature === "reasoning_content") {
              continue;
            }
            blocks.push({
              type: "thinking",
              thinking: block.thinking,
              signature: thinkingSignature ?? "",
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: isOAuthTokenValue ? toClaudeCodeToolName(block.name) : block.name,
            input: block.arguments ?? {},
          });
        }
      }
      if (blocks.length === 0 && omittedThinking) {
        blocks.push({ type: "text", text: ANTHROPIC_OMITTED_REASONING_TEXT });
      }
      if (blocks.length === 0) {
        continue;
      }
      params.push({
        role: "assistant",
        content: blocks,
      });
    } else if (msg.role === "toolResult") {
      // Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
      const toolResults: ContentBlockParam[] = [];
      toolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: await convertContentBlocks(msg.content, msg.isError, imageBudget),
        is_error: msg.isError,
      });

      let j = i + 1;
      while (j < transformedMessages.length) {
        const nextMsg = transformedMessages.at(j);
        if (nextMsg?.role !== "toolResult") {
          break;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: await convertContentBlocks(nextMsg.content, nextMsg.isError, imageBudget),
          is_error: nextMsg.isError,
        });
        j++;
      }

      i = j - 1;
      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }

  if (cacheControl) {
    applyAnthropicCacheControlToMessages(
      params,
      cacheControl,
      messageCacheControlLimit,
      cacheBreakpointOptOutParamIndexes,
    );
  }

  return params;
}

function buildAnthropicSystemBlocks(
  systemPrompt: string | undefined,
  isOAuthTokenResult: boolean,
  cacheControl: CacheControlEphemeral | undefined,
): TextBlockParam[] | undefined {
  const blocks: TextBlockParam[] = [];
  if (isOAuthTokenResult) {
    // Anthropic uses this first system block to route Claude subscription OAuth billing.
    blocks.push({
      type: "text",
      text: ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
    });
    blocks.push({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    });
  }
  if (systemPrompt) {
    blocks.push(...buildSystemPromptBlocks(systemPrompt, cacheControl));
  }
  return blocks.length > 0 ? blocks : undefined;
}

function buildSystemPromptBlocks(
  systemPrompt: string,
  cacheControl: CacheControlEphemeral | undefined,
): TextBlockParam[] {
  if (!cacheControl) {
    return [
      { type: "text", text: sanitizeSurrogates(stripSystemPromptCacheBoundary(systemPrompt)) },
    ];
  }

  const split = splitSystemPromptCacheBoundary(systemPrompt);
  if (!split) {
    return [
      {
        type: "text",
        text: sanitizeSurrogates(systemPrompt),
        cache_control: cacheControl,
      },
    ];
  }

  const blocks: TextBlockParam[] = [];
  if (split.stablePrefix) {
    blocks.push({
      type: "text",
      text: sanitizeSurrogates(split.stablePrefix),
      cache_control: cacheControl,
    });
  }
  if (split.dynamicSuffix) {
    blocks.push({ type: "text", text: sanitizeSurrogates(split.dynamicSuffix) });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function countNativeCacheControlMarkers(blocks: unknown): number {
  if (!Array.isArray(blocks)) {
    return 0;
  }

  let count = 0;
  for (const block of blocks) {
    if (block && typeof block === "object" && "cache_control" in block) {
      count += 1;
    }
  }
  return count;
}

function shouldUseFineGrainedToolStreamingBeta(
  model: Model<"anthropic-messages">,
  context: Context,
): boolean {
  return (
    Boolean(context.tools?.length) && !getAnthropicCompat(model).supportsEagerToolInputStreaming
  );
}

function convertTools(
  tools: Tool[],
  isOAuthTokenLocal: boolean,
  supportsEagerToolInputStreaming: boolean,
  cacheControl?: CacheControlEphemeral,
): {
  projection: AnthropicToolProjection;
  tools: Anthropic.Messages.Tool[];
} {
  const projection = projectAnthropicTools(tools, (name) =>
    isOAuthTokenLocal ? toClaudeCodeToolName(name) : name,
  );
  const convertedTools: Anthropic.Messages.Tool[] = [];
  for (const [index, tool] of projection.tools.entries()) {
    const convertedTool: Anthropic.Messages.Tool = {
      name: tool.wireName,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
    if (supportsEagerToolInputStreaming) {
      convertedTool.eager_input_streaming = true;
    }
    if (cacheControl && index === projection.tools.length - 1) {
      convertedTool.cache_control = cacheControl;
    }
    convertedTools.push(convertedTool);
  }
  return {
    projection,
    tools: convertedTools,
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
