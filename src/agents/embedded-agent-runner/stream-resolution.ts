/**
 * Resolves provider stream functions and API keys for embedded agents.
 */
import { getApiProvider } from "@openclaw/ai/internal/runtime";
import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { streamSimple } from "../../llm/stream.js";
import { createAnthropicVertexStreamFnForModel } from "../anthropic-vertex-stream.js";
import { createBoundaryAwareStreamFnForModel } from "../provider-transport-stream.js";
import type { StreamFn } from "../runtime/index.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

const embeddedAgentBaseStreamFnCache = new WeakMap<object, StreamFn | undefined>();

type EmbeddedStreamOptions = Parameters<StreamFn>[2] & {
  authProfileId?: string;
  promptCacheKey?: string;
};

export function resolveEmbeddedAgentBaseStreamFn(params: {
  session: { agent: { streamFn?: StreamFn } };
}): StreamFn | undefined {
  const cached = embeddedAgentBaseStreamFnCache.get(params.session);
  if (cached !== undefined || embeddedAgentBaseStreamFnCache.has(params.session)) {
    return cached;
  }
  const baseStreamFn = params.session.agent.streamFn;
  embeddedAgentBaseStreamFnCache.set(params.session, baseStreamFn);
  return baseStreamFn;
}

function isDefaultOpenClawStreamFnForModel(
  model: EmbeddedRunAttemptParams["model"],
  streamFn: StreamFn | undefined,
): boolean {
  if (!streamFn || streamFn === streamSimple) {
    return true;
  }
  const api = typeof model.api === "string" ? model.api.trim() : "";
  if (!api) {
    return false;
  }
  const provider = getApiProvider(api as never);
  return streamFn === provider?.streamSimple || streamFn === provider?.stream;
}

function hasResolvedRuntimeApiKey(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function isOpenAICodexResponsesModel(model: EmbeddedRunAttemptParams["model"]): boolean {
  return model.provider === "openai" && model.api === "openai-chatgpt-responses";
}

function resolveOpenClawNativeCodexResponsesStreamFn(params: {
  model: EmbeddedRunAttemptParams["model"];
  currentStreamFn: StreamFn | undefined;
}): StreamFn | undefined {
  if (!isOpenAICodexResponsesModel(params.model)) {
    return undefined;
  }
  if (!isDefaultOpenClawStreamFnForModel(params.model, params.currentStreamFn)) {
    return undefined;
  }
  return params.currentStreamFn ?? streamSimple;
}

export function describeEmbeddedAgentStreamStrategy(params: {
  currentStreamFn: StreamFn | undefined;
  providerStreamFn?: StreamFn;
  model: EmbeddedRunAttemptParams["model"];
  resolvedApiKey?: string;
}): string {
  if (params.providerStreamFn) {
    return "provider";
  }
  if (params.model.provider === "anthropic-vertex") {
    return "anthropic-vertex";
  }
  if (
    resolveOpenClawNativeCodexResponsesStreamFn({
      model: params.model,
      currentStreamFn: params.currentStreamFn,
    })
  ) {
    return "openclaw-native-codex-responses";
  }
  if (isDefaultOpenClawStreamFnForModel(params.model, params.currentStreamFn)) {
    return createBoundaryAwareStreamFnForModel(params.model)
      ? `boundary-aware:${params.model.api}`
      : "stream-simple";
  }
  if (
    hasResolvedRuntimeApiKey(params.resolvedApiKey) &&
    createBoundaryAwareStreamFnForModel(params.model)
  ) {
    return `boundary-aware:${params.model.api}`;
  }
  return "session-custom";
}

export async function resolveEmbeddedAgentApiKey(params: {
  provider: string;
  resolvedApiKey?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
}): Promise<string | undefined> {
  const resolvedApiKey = params.resolvedApiKey?.trim();
  if (resolvedApiKey) {
    return resolvedApiKey;
  }
  return params.authStorage ? await params.authStorage.getApiKey(params.provider) : undefined;
}

export function resolveEmbeddedAgentStreamFn(params: {
  currentStreamFn: StreamFn | undefined;
  providerStreamFn?: StreamFn;
  sessionId: string;
  promptCacheKey?: string;
  signal?: AbortSignal;
  model: EmbeddedRunAttemptParams["model"];
  resolvedApiKey?: string;
  transportAuthAvailable?: boolean;
  authProfileId?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
}): StreamFn {
  if (params.providerStreamFn) {
    return wrapEmbeddedAgentStreamFn(params.providerStreamFn, {
      runSignal: params.signal,
      resolvedApiKey: params.resolvedApiKey,
      authProfileId: params.authProfileId,
      authStorage: params.authStorage,
      providerId: params.model.provider,
      promptCacheKey: params.promptCacheKey,
      transformContext: (context) =>
        context.systemPrompt
          ? {
              ...context,
              systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
            }
          : context,
    });
  }

  const currentStreamFn = params.currentStreamFn ?? streamSimple;
  if (params.model.provider === "anthropic-vertex") {
    return createAnthropicVertexStreamFnForModel(params.model);
  }

  const openClawNativeCodexResponsesStreamFn = resolveOpenClawNativeCodexResponsesStreamFn({
    model: params.model,
    currentStreamFn: params.currentStreamFn,
  });
  if (openClawNativeCodexResponsesStreamFn) {
    return wrapEmbeddedAgentStreamFn(openClawNativeCodexResponsesStreamFn, {
      runSignal: params.signal,
      resolvedApiKey: params.resolvedApiKey,
      authProfileId: params.authProfileId,
      authStorage: params.authStorage,
      providerId: params.model.provider,
      sessionId: params.sessionId,
      promptCacheKey: params.promptCacheKey,
      transformContext: (context) =>
        context.systemPrompt
          ? {
              ...context,
              systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt),
            }
          : context,
    });
  }

  if (
    isDefaultOpenClawStreamFnForModel(params.model, params.currentStreamFn) ||
    hasResolvedRuntimeApiKey(params.resolvedApiKey) ||
    params.transportAuthAvailable ||
    // Proxied anthropic-messages providers (provider !== "anthropic", e.g. pioneer)
    // must use the boundary-aware managed transport even without a resolved runtime
    // key — it is the only place a tool-using turn's narration gets tagged
    // phase:commentary; the base SDK stream never tags it, so proxied anthropic
    // providers silently lost their narration lane. Scoped to non-"anthropic"
    // providers so direct-anthropic edge cases (thinking-replay repair without a
    // resolved key) are unchanged; the wrap below injects the resolved key
    // (fallback options.apiKey), preserving x-api-key auth.
    (params.model.api === "anthropic-messages" && params.model.provider !== "anthropic")
  ) {
    const boundaryAwareStreamFn = createBoundaryAwareStreamFnForModel(params.model);
    if (boundaryAwareStreamFn) {
      // Some OpenClaw session factories return a provider-specific stream wrapper
      // once runtime auth is resolved. Keep transport-supported APIs on
      // OpenClaw's HTTP transport so provider-specific auth/header semantics
      // are not lost behind that wrapper.
      // Boundary-aware transports read credentials from options.apiKey just
      // like provider-owned streams, but the embedded run layer never gets to
      // inject the resolved runtime key for them. Without this wrap, OAuth
      // providers (e.g. openai/gpt-5.5 over ChatGPT OAuth) hit the Responses API with an
      // empty bearer and fail with 401 Missing bearer auth header.
      return wrapEmbeddedAgentStreamFn(boundaryAwareStreamFn, {
        runSignal: params.signal,
        resolvedApiKey: params.resolvedApiKey,
        authProfileId: params.authProfileId,
        authStorage: params.authStorage,
        providerId: params.model.provider,
        promptCacheKey: params.promptCacheKey,
      });
    }
  }

  const promptCacheKey = params.promptCacheKey?.trim();
  if (!promptCacheKey) {
    return currentStreamFn;
  }
  return wrapEmbeddedAgentStreamFn(currentStreamFn, {
    runSignal: params.signal,
    resolvedApiKey: undefined,
    authProfileId: undefined,
    authStorage: undefined,
    providerId: params.model.provider,
    promptCacheKey,
  });
}

function wrapEmbeddedAgentStreamFn(
  inner: StreamFn,
  params: {
    runSignal: AbortSignal | undefined;
    resolvedApiKey: string | undefined;
    authProfileId: string | undefined;
    authStorage: { getApiKey(provider: string): Promise<string | undefined> } | undefined;
    providerId: string;
    sessionId?: string;
    promptCacheKey?: string;
    transformContext?: (context: Parameters<StreamFn>[1]) => Parameters<StreamFn>[1];
  },
): StreamFn {
  const transformContext =
    params.transformContext ?? ((context: Parameters<StreamFn>[1]) => context);
  const mergeRunSignal = (options: Parameters<StreamFn>[2]) => {
    const embeddedOptions = options as EmbeddedStreamOptions | undefined;
    const signal = embeddedOptions?.signal ?? params.runSignal;
    let merged =
      params.sessionId && !embeddedOptions?.sessionId
        ? { ...embeddedOptions, sessionId: params.sessionId }
        : embeddedOptions;
    const promptCacheKey = params.promptCacheKey?.trim();
    if (promptCacheKey && !merged?.promptCacheKey) {
      merged = { ...merged, promptCacheKey };
    }
    if (params.authProfileId && !merged?.authProfileId) {
      merged = { ...merged, authProfileId: params.authProfileId };
    }
    return signal ? { ...merged, signal } : merged;
  };
  if (!params.authStorage && !params.resolvedApiKey) {
    return (m, context, options) => inner(m, transformContext(context), mergeRunSignal(options));
  }
  const { authStorage, providerId, resolvedApiKey } = params;
  return async (m, context, options) => {
    const apiKey = await resolveEmbeddedAgentApiKey({
      provider: providerId,
      resolvedApiKey,
      authStorage,
    });
    const selectedApiKey = apiKey ?? options?.apiKey;
    return inner(m, transformContext(context), {
      ...mergeRunSignal(options),
      apiKey: selectedApiKey,
    });
  };
}
