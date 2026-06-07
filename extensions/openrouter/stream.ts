// Openrouter plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeoutGuarded,
} from "openclaw/plugin-sdk/provider-http";
import { OPENROUTER_THINKING_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream-family";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  type DeepSeekV4ReasoningEffort,
  type DeepSeekV4ThinkingLevel,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { isOpenRouterDeepSeekV4ModelId } from "./models.js";
import {
  isOpenRouterProxyReasoningUnsupportedModel,
  normalizeOpenRouterBaseUrl,
  OPENROUTER_BASE_URL,
} from "./provider-catalog.js";

const log = createSubsystemLogger("openrouter-stream");
const OPENROUTER_GENERATION_LOOKUP_TIMEOUT_MS = 2_000;

type OpenRouterGenerationResponse = {
  data?: {
    total_cost?: unknown;
  };
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function isOpenRouterAnthropicModelId(modelId: unknown): boolean {
  const normalized = readString(modelId)?.toLowerCase();
  return (
    normalized?.startsWith("anthropic/") === true ||
    normalized?.startsWith("openrouter/anthropic/") === true
  );
}

function isVerifiedOpenRouterRoute(model: Parameters<StreamFn>[0]): boolean {
  const provider = readString(model.provider)?.toLowerCase();
  const baseUrl = readString(model.baseUrl);
  if (baseUrl) {
    return normalizeOpenRouterBaseUrl(baseUrl) === OPENROUTER_BASE_URL;
  }
  return provider === "openrouter";
}

function shouldPatchAnthropicOpenRouterPayload(model: Parameters<StreamFn>[0]): boolean {
  const api = readString(model.api);
  return (
    (api === undefined || api === "openai-completions") &&
    isOpenRouterAnthropicModelId(model.id) &&
    isVerifiedOpenRouterRoute(model)
  );
}

function shouldPatchDeepSeekV4OpenRouterPayload(model: Parameters<StreamFn>[0]): boolean {
  const api = readString(model.api);
  return (
    (api === undefined || api === "openai-completions") &&
    isOpenRouterDeepSeekV4ModelId(model.id) &&
    isVerifiedOpenRouterRoute(model)
  );
}

function shouldPatchOpenRouterRoutingPayload(model: Parameters<StreamFn>[0]): boolean {
  const api = readString(model.api);
  return (api === undefined || api === "openai-completions") && isVerifiedOpenRouterRoute(model);
}

function resolveOpenRouterGenerationUrl(
  model: Parameters<StreamFn>[0],
  responseId: string,
): string {
  const baseUrl = readString(model.baseUrl) || OPENROUTER_BASE_URL;
  const url = new URL("generation", `${baseUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("id", responseId);
  return url.href;
}

function readOpenRouterTotalCost(payload: OpenRouterGenerationResponse): number | undefined {
  const totalCost = payload.data?.total_cost;
  if (typeof totalCost !== "number" || !Number.isFinite(totalCost) || totalCost < 0) {
    return undefined;
  }
  return totalCost;
}

function isDoneEvent(
  event: AssistantMessageEvent,
): event is Extract<AssistantMessageEvent, { type: "done" }> {
  return event.type === "done";
}

async function fetchOpenRouterGenerationTotalCost(params: {
  apiKey: string;
  model: Parameters<StreamFn>[0];
  responseId: string;
}): Promise<number | undefined> {
  const url = resolveOpenRouterGenerationUrl(params.model, params.responseId);
  const { response, release } = await fetchWithTimeoutGuarded(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
      },
    },
    OPENROUTER_GENERATION_LOOKUP_TIMEOUT_MS,
    fetch,
    { auditContext: "openrouter-generation-cost" },
  );
  try {
    await assertOkOrThrowHttpError(response, "OpenRouter generation metadata request failed");
    return readOpenRouterTotalCost((await response.json()) as OpenRouterGenerationResponse);
  } finally {
    await release();
  }
}

async function applyOpenRouterBilledCost(params: {
  apiKey: string | undefined;
  message: AssistantMessage;
  model: Parameters<StreamFn>[0];
}): Promise<void> {
  const apiKey = readString(params.apiKey);
  const responseId = readString((params.message as { responseId?: unknown }).responseId);
  if (!apiKey || !responseId || !params.message.usage?.cost) {
    return;
  }
  try {
    const totalCost = await fetchOpenRouterGenerationTotalCost({
      apiKey,
      model: params.model,
      responseId,
    });
    if (totalCost !== undefined) {
      params.message.usage.cost.total = totalCost;
    }
  } catch (error) {
    log.debug?.(
      `kept streamed OpenRouter cost estimate because generation metadata lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function createOpenRouterBilledCostWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return baseStreamFn;
  }
  return async (model, context, options) => {
    const source = await baseStreamFn(model, context, options);
    if (!isVerifiedOpenRouterRoute(model)) {
      return source;
    }
    const output = createAssistantMessageEventStream();
    const stream = output as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      try {
        for await (const event of source as AsyncIterable<AssistantMessageEvent>) {
          if (isDoneEvent(event)) {
            await applyOpenRouterBilledCost({
              apiKey: options?.apiKey,
              message: event.message,
              model,
            });
          }
          stream.push(event);
        }
      } catch (error) {
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        stream.end();
      }
    })();
    return output as ReturnType<StreamFn>;
  };
}

function assistantMessageHasOpenAIToolCalls(message: Record<string, unknown>): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function isAnthropicToolCallContentBlock(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    ((value as { type?: unknown }).type === "tool_use" ||
      (value as { type?: unknown }).type === "toolCall")
  );
}

function assistantMessageHasAnthropicToolUse(message: Record<string, unknown>): boolean {
  const content = message.content;
  return Array.isArray(content) && content.some(isAnthropicToolCallContentBlock);
}

function shouldStripOpenRouterTrailingMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as Record<string, unknown>;
  return (
    message.role === "assistant" &&
    !assistantMessageHasOpenAIToolCalls(message) &&
    !assistantMessageHasAnthropicToolUse(message)
  );
}

function stripTrailingOpenRouterAssistantPrefillMessages(payload: Record<string, unknown>): number {
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return 0;
  }

  let keep = messages.length;
  while (keep > 0 && shouldStripOpenRouterTrailingMessage(messages[keep - 1])) {
    keep -= 1;
  }
  if (keep === messages.length) {
    return 0;
  }
  const stripped = messages.length - keep;
  messages.splice(keep);
  return stripped;
}

function resolveOpenRouterDeepSeekV4ReasoningEffort(
  thinkingLevel: DeepSeekV4ThinkingLevel,
): DeepSeekV4ReasoningEffort {
  switch (thinkingLevel) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return thinkingLevel;
    case "max":
      return "xhigh";
    case "adaptive":
      return "medium";
    case "off":
    case undefined:
      return "high";
  }
  return "high";
}

function isEnabledReasoningValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "off" && normalized !== "none";
  }
  return true;
}

function isOpenRouterReasoningPayloadEnabled(payload: Record<string, unknown>): boolean {
  return (
    isEnabledReasoningValue(payload.reasoning) || isEnabledReasoningValue(payload.reasoning_effort)
  );
}

function injectOpenRouterRouting(
  baseStreamFn: StreamFn | undefined,
  providerRouting?: Record<string, unknown>,
): StreamFn | undefined {
  if (!providerRouting) {
    return baseStreamFn;
  }
  const routedStreamFn: StreamFn = (model, context, options) =>
    (
      baseStreamFn ??
      ((nextModel) => {
        throw new Error(
          `OpenRouter routing wrapper requires an underlying streamFn for ${nextModel.id}.`,
        );
      })
    )(
      {
        ...model,
        compat: { ...model.compat, openRouterRouting: providerRouting },
      } as typeof model,
      context,
      options,
    );
  return createPayloadPatchStreamWrapper(
    routedStreamFn,
    ({ payload }) => {
      if (payload.provider === undefined) {
        payload.provider = providerRouting;
      }
    },
    {
      shouldPatch: ({ model }) => shouldPatchOpenRouterRoutingPayload(model),
    },
  );
}

function createOpenRouterAnthropicPrefillWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload }) => {
      if (!isOpenRouterReasoningPayloadEnabled(payload)) {
        return;
      }
      const stripped = stripTrailingOpenRouterAssistantPrefillMessages(payload);
      if (stripped > 0) {
        log.warn(
          `removed ${stripped} trailing assistant prefill message${stripped === 1 ? "" : "s"} because OpenRouter-routed Anthropic reasoning requires conversations to end with a user turn`,
        );
      }
    },
    {
      shouldPatch: ({ model }) => shouldPatchAnthropicOpenRouterPayload(model),
    },
  );
}

function createOpenRouterDeepSeekV4ThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): StreamFn | undefined {
  return createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: shouldPatchDeepSeekV4OpenRouterPayload,
    resolveReasoningEffort: resolveOpenRouterDeepSeekV4ReasoningEffort,
    shouldBackfillAssistantReasoningContent: (message) =>
      !assistantMessageHasOpenAIToolCalls(message),
  });
}

export function wrapOpenRouterProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | null | undefined {
  const providerRouting =
    ctx.extraParams?.provider != null && typeof ctx.extraParams.provider === "object"
      ? (ctx.extraParams.provider as Record<string, unknown>)
      : undefined;
  const routedStreamFn = providerRouting
    ? injectOpenRouterRouting(ctx.streamFn, providerRouting)
    : ctx.streamFn;
  const wrapStreamFn = OPENROUTER_THINKING_STREAM_HOOKS.wrapStreamFn ?? undefined;
  if (!wrapStreamFn) {
    return createOpenRouterBilledCostWrapper(
      createOpenRouterAnthropicPrefillWrapper(
        createOpenRouterDeepSeekV4ThinkingWrapper(routedStreamFn, ctx.thinkingLevel),
      ),
    );
  }
  const wrappedStreamFn =
    wrapStreamFn({
      ...ctx,
      streamFn: routedStreamFn,
      thinkingLevel: isOpenRouterProxyReasoningUnsupportedModel(ctx.modelId)
        ? undefined
        : ctx.thinkingLevel,
    }) ?? undefined;
  return createOpenRouterBilledCostWrapper(
    createOpenRouterAnthropicPrefillWrapper(
      createOpenRouterDeepSeekV4ThinkingWrapper(wrappedStreamFn, ctx.thinkingLevel),
    ),
  );
}
