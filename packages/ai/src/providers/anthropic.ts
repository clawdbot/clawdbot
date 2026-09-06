// Anthropic provider adapts Anthropic streams and tool calls for the runtime.
import Anthropic from "@anthropic-ai/sdk";
import { Stream } from "@anthropic-ai/sdk/core/streaming.js";
import type {
  CacheControlEphemeral,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import type { AnthropicContextManagementOptions, AnthropicOptions } from "../provider-options.js";
import { transformProviderMessages as transformMessages } from "../provider-transcript-transform.js";
import {
  buildAnthropicReplayPlan,
  isAnthropicReplayRejection,
  suppressAnthropicCompaction,
} from "../transports/anthropic-compaction-replay.js";
import {
  convertAnthropicMessages,
  convertAnthropicTools,
  buildAnthropicGenerationParams,
} from "../transports/anthropic-messages.js";
import {
  applyAnthropicCacheControlToMessages,
  applyAnthropicContextManagementToRequest,
  isDirectAnthropicModel,
  resolveAnthropicContextManagementBetaHeader,
} from "../transports/anthropic-payload-policy.js";
import { consumeAnthropicStream } from "../transports/anthropic-stream-reducer.js";
import { resolveOpencodeSessionHeaders } from "../transports/session-affinity.js";
import {
  assignTransportErrorDetails,
  finalizeTransportStream,
  notifyProviderHttpResponse,
} from "../transports/transport-stream-shared.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import type {
  AnthropicMessagesCompat,
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  CacheRetention,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "../types.js";
import { createDeferredEventBuffer } from "../utils/deferred-event-buffer.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseJsonWithRepair } from "../utils/json-parse.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "../utils/system-prompt-cache-boundary.js";
import {
  isAnthropicOAuthApiKey,
  omitFoundryBearerCredentialHeaders,
  usesFoundryBearerAuth,
} from "./anthropic-auth-headers.js";
import {
  applyClaudeRequestContract,
  ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
  ANTHROPIC_CLAUDE_CODE_VERSION,
  prepareClaudeNoPrefillRequestContext,
  resolveAnthropicThinkingEffort,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  requiresClaudeAdaptiveThinking,
  supportsClaudeAdaptiveThinking,
  usesClaudeFable5MessagesContract,
  usesClaudeStreamingRefusalContract,
} from "./anthropic-model-contract.js";
import {
  ANTHROPIC_SERVER_SIDE_FALLBACK_BETA,
  ANTHROPIC_SERVER_SIDE_FALLBACKS,
} from "./anthropic-server-fallback.js";
import { applyAnthropicThinkingBindingControls } from "./anthropic-thinking-replay.js";
import {
  normalizeAnthropicToolCallId,
  type AnthropicToolProjection,
} from "./anthropic-tool-projection.js";
import { resolveCacheRetention } from "./cache-retention.js";
import { resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import {
  adjustMaxTokensForThinking,
  buildBaseOptions,
  clampMaxTokensToModel,
} from "./simple-options.js";

const ANTHROPIC_CACHE_CONTROL_LIMIT = 4;

type AnthropicCompactionOptions = AnthropicOptions & {
  authProfileId?: string;
};

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
]);

async function* iterateAnthropicEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
  if (!response.body) {
    throw new Error("Attempted to iterate over an Anthropic response with no body");
  }

  for await (const sse of Stream.rawEvents(response)) {
    if (sse.event === "error") {
      throw new Error(sse.data);
    }

    notifyLlmRequestActivity(signal);
    if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
      continue;
    }

    try {
      const event = parseJsonWithRepair(sse.data) as RawMessageStreamEvent;
      yield event;
    } catch (error) {
      // Frame payloads carry model output, so surface the shared malformed-fragment
      // error instead of echoing them. The SyntaxError stays reachable on `cause`.
      if (error instanceof SyntaxError) {
        throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause: error });
      }
      throw error;
    }
  }
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicCompactionOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicCompactionOptions,
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
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    // Classifier refusals can invalidate partial output, so no event is safe
    // to expose until the terminal stop reason is known.
    const refusalBuffer = usesClaudeStreamingRefusalContract(model)
      ? createDeferredEventBuffer<AssistantMessageEvent>(stream)
      : undefined;
    let usedCompactionReplay = false;

    try {
      let client: Anthropic;
      let isOAuth: boolean;
      // The beta-gated fallbacks param may only ship on clients we built,
      // where the matching beta header is guaranteed; injected clients carry
      // caller-owned headers.
      let serverSideFallback = false;
      let directApiKeyBetaHeader: string | undefined;

      if (requestOptions?.client) {
        client = requestOptions.client;
        isOAuth = false;
      } else {
        const apiKey = requestOptions?.apiKey ?? getEnvApiKey(model.provider) ?? "";

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

        const created = createClient(
          model,
          apiKey,
          requestOptions?.thinkingEnabled === true,
          requestOptions?.interleavedThinking ?? true,
          shouldUseFineGrainedToolStreamingBeta(model, requestContext),
          resolveOpencodeSessionHeaders(model, requestOptions),
          copilotDynamicHeaders,
          cacheSessionId,
        );
        client = created.client;
        isOAuth = created.isOAuthToken;
        serverSideFallback = created.serverSideFallback;
        directApiKeyBetaHeader = created.directApiKeyBetaHeader;
      }
      const builtParams = await buildParams(
        model,
        requestContext,
        isOAuth,
        requestOptions,
        serverSideFallback,
      );
      usedCompactionReplay = builtParams.usedCompactionReplay;
      let params = builtParams.params;
      const toolProjection = builtParams.toolProjection;
      applyAnthropicContextManagementToRequest(
        params,
        model,
        requestOptions,
        directApiKeyBetaHeader,
      );
      const nextParams = await requestOptions?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as MessageCreateParamsStreaming;
      }
      applyClaudeRequestContract(params, model);
      const betaHeader = resolveAnthropicContextManagementBetaHeader(
        params,
        directApiKeyBetaHeader,
      );
      const sdkRequestOptions = {
        ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
        ...(requestOptions?.timeoutMs !== undefined ? { timeout: requestOptions.timeoutMs } : {}),
        maxRetries: 0,
        headers:
          applyAnthropicThinkingBindingControls(params, betaHeader) ??
          (betaHeader !== undefined ? { "anthropic-beta": betaHeader } : undefined),
      };
      const response = await client.messages
        .create({ ...params, stream: true }, sdkRequestOptions)
        .asResponse();
      await notifyProviderHttpResponse({ options: requestOptions, response, model });

      await consumeAnthropicStream({
        events: iterateAnthropicEvents(response, requestOptions?.signal),
        model,
        options: requestOptions ?? {},
        output,
        stream,
        refusalBuffer,
        isOAuthToken: isOAuth,
        toolProjection,
        profile: "provider",
      });
      finalizeTransportStream({ stream, output });
    } catch (error) {
      const terminal = assignTransportErrorDetails(output, error, requestOptions?.signal);
      output.content = output.content.filter((block) => block.type !== "toolCall");
      for (const block of output.content) {
        delete (block as { index?: number }).index;
        // partialJson is only a streaming scratch buffer; never persist it.
        delete (block as { partialJson?: string }).partialJson;
      }
      if (refusalBuffer) {
        refusalBuffer.discard();
        output.content = [];
      }
      if (usedCompactionReplay && isAnthropicReplayRejection(error)) {
        suppressAnthropicCompaction(output, model, requestOptions);
      }
      stream.push({ type: "error", reason: terminal.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

function normalizeAnthropicThinkingOptions(
  model: Model<"anthropic-messages">,
  options: AnthropicCompactionOptions | undefined,
): AnthropicCompactionOptions | undefined {
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

type AnthropicSimpleStreamOptions = SimpleStreamOptions &
  AnthropicContextManagementOptions & {
    authProfileId?: string;
    toolChoice?: AnthropicCompactionOptions["toolChoice"];
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

  const base = {
    ...buildBaseOptions(model, options, apiKey),
    anthropicServerCompaction: options?.anthropicServerCompaction,
    anthropicCompactThreshold: options?.anthropicCompactThreshold,
    cacheTtlPruning: options?.cacheTtlPruning,
    authProfileId: options?.authProfileId,
    maxTokens: clampMaxTokensToModel(model, options?.maxTokens ?? model.maxTokens),
    toolChoice: options?.toolChoice,
  };
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  if (options?.reasoning === "off" && !mandatoryAdaptiveThinking) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: false,
    } satisfies AnthropicCompactionOptions);
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
    } satisfies AnthropicCompactionOptions);
  }
  if (!reasoning) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: mandatoryAdaptiveThinking,
      ...(mandatoryAdaptiveThinking ? { effort: "high" as const } : {}),
    } satisfies AnthropicCompactionOptions);
  }

  // For Opus 4.6 and Sonnet 4.6: use adaptive thinking with effort level
  // For older models: use budget-based thinking
  if (supportsClaudeAdaptiveThinking(model)) {
    const effort = resolveAnthropicThinkingEffort(model, reasoning);
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: true,
      effort,
    } satisfies AnthropicCompactionOptions);
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
  } satisfies AnthropicCompactionOptions);
};

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
  return isDirectAnthropicModel(model);
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
): {
  client: Anthropic;
  isOAuthToken: boolean;
  serverSideFallback: boolean;
  directApiKeyBetaHeader?: string;
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
  const fetchOptions =
    /^kimi(?:-|$)/.test(model.provider) && thinkingEnabled
      ? { sanitizeSse: false as const }
      : undefined;
  // Anthropic supports custom fetch, so sentinels stay opaque until guarded egress.
  const fetch = getAiTransportHost().buildModelFetch(model, undefined, fetchOptions);

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
      fetch,
      maxRetries: 0,
    });

    return { client, isOAuthToken: false, serverSideFallback: false };
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
      fetch,
      maxRetries: 0,
    });

    return { client, isOAuthToken: false, serverSideFallback: false };
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
      fetch,
      maxRetries: 0,
    });

    return { client, isOAuthToken: false, serverSideFallback: false };
  }

  // OAuth: Bearer auth, Claude Code identity headers
  if (isAnthropicOAuthApiKey(apiKey)) {
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
      fetch,
      maxRetries: 0,
    });

    return { client, isOAuthToken: true, serverSideFallback: false };
  }

  // API key auth
  const serverSideFallback = supportsAnthropicServerSideFallback(model);
  if (serverSideFallback) {
    betaFeatures.push(ANTHROPIC_SERVER_SIDE_FALLBACK_BETA);
  }
  const sessionAffinityHeaders: Record<string, string | null> =
    sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders
      ? { "x-session-affinity": sessionId }
      : {};
  const defaultHeaders = mergeHeaders(
    {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
    },
    sessionAffinityHeaders,
    model.headers,
    optionsHeaders,
  );
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    fetch,
    maxRetries: 0,
  });

  return {
    client,
    isOAuthToken: false,
    serverSideFallback,
    // Binding controls are verified only on direct API-key requests, not OAuth or proxies.
    directApiKeyBetaHeader: isDirectAnthropicModel(model)
      ? (Object.entries(defaultHeaders).findLast(
          ([name]) => name.toLowerCase() === "anthropic-beta",
        )?.[1] ?? "")
      : undefined,
  };
}

async function buildParams(
  model: Model<"anthropic-messages">,
  context: Context,
  isOAuthTokenResult: boolean,
  options?: AnthropicCompactionOptions,
  serverSideFallback = false,
): Promise<{
  params: MessageCreateParamsStreaming;
  toolProjection?: AnthropicToolProjection;
  usedCompactionReplay: boolean;
}> {
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  const replayThinkingEnabled = mandatoryAdaptiveThinking || options?.thinkingEnabled === true;
  const { cacheControl } = getCacheControl(model, options?.cacheRetention);
  const system = buildAnthropicSystemBlocks(context.systemPrompt, isOAuthTokenResult, cacheControl);
  const compat = getAnthropicCompat(model);
  const convertedTools = context.tools
    ? convertAnthropicTools(
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
  const replayPlan = buildAnthropicReplayPlan(context.messages, model, {
    enabled: !isOAuthTokenResult && options?.anthropicServerCompaction === true,
    authProfileId: options?.authProfileId,
    sessionId: options?.sessionId,
  });
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    // The SDK's stable message union omits compaction blocks accepted by its beta endpoint.
    messages: (await convertAnthropicMessages(
      transformMessages(replayPlan.messages, model, normalizeAnthropicToolCallId),
      model,
      isOAuthTokenResult,
      {
        profile: "provider",
        allowEmptySignature: compat.allowEmptySignature,
        compaction: replayPlan.compaction,
        replayThinkingEnabled,
      },
    )) as MessageParam[],
    max_tokens: options?.maxTokens ?? model.maxTokens,
    stream: true,
  };

  if (cacheControl) {
    // Anthropic-family carriers are append-only, so they are stable cache anchors too.
    applyAnthropicCacheControlToMessages(
      params.messages,
      cacheControl,
      messageCacheControlLimit,
      new Set(),
    );
  }

  if (system) {
    params.system = system;
  }

  // Fable 5 and Opus 5 safety classifiers can decline benign-adjacent work.
  // Anthropic owns the per-category fallback recommendation so routing can
  // evolve without a client release.
  if (serverSideFallback) {
    (params as { fallbacks?: "default" }).fallbacks = ANTHROPIC_SERVER_SIDE_FALLBACKS;
  }

  Object.assign(
    params,
    buildAnthropicGenerationParams({ model, options, tools, toolProjection, profile: "provider" }),
  );

  return { params, toolProjection, usedCompactionReplay: replayPlan.compaction !== undefined };
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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
