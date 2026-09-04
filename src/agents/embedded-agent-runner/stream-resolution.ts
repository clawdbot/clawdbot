/**
 * Resolves provider stream functions and API keys for embedded agents.
 */
import type { LlmRuntime } from "@openclaw/ai";
import { notifyLlmRequestActivity, onLlmRequestActivity } from "@openclaw/ai/internal/runtime";
import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { createBoundaryAwareStreamFnForModel } from "@openclaw/ai/transports";
import { hasNonEmptyString as hasResolvedRuntimeApiKey } from "@openclaw/normalization-core/string-coerce";
import { getStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import "../ai-transport-runtime-host.js";
import { createAnthropicVertexStreamFnForModel } from "../anthropic-vertex-stream.js";
import type { StreamFn } from "../runtime/index.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

const embeddedAgentBaseStreamFnCache = new WeakMap<object, StreamFn | undefined>();

type EmbeddedStreamOptions = Parameters<StreamFn>[2] & {
  authProfileId?: string;
  promptCacheKey?: string;
};

export function resolveEmbeddedAgentBaseStreamFn(params: {
  session: { agent: { streamFn?: StreamFn } };
}): StreamFn {
  const cached = embeddedAgentBaseStreamFnCache.get(params.session);
  if (cached !== undefined || embeddedAgentBaseStreamFnCache.has(params.session)) {
    if (!cached) {
      throw new Error("Agent session has no lifecycle-owned base stream.");
    }
    return cached;
  }
  const baseStreamFn = params.session.agent.streamFn;
  embeddedAgentBaseStreamFnCache.set(params.session, baseStreamFn);
  if (!baseStreamFn) {
    throw new Error("Agent session has no lifecycle-owned base stream.");
  }
  return baseStreamFn;
}

type EmbeddedStreamRuntimeOwner =
  | {
      llmRuntime: LlmRuntime;
      currentStreamFn: StreamFn | undefined;
    }
  | {
      llmRuntime?: never;
      currentStreamFn: StreamFn;
    };

function resolveEmbeddedStreamRuntime(owner: EmbeddedStreamRuntimeOwner): LlmRuntime {
  const runtime = owner.llmRuntime ?? getStreamLlmRuntime(owner.currentStreamFn);
  if (!runtime) {
    throw new Error("Embedded stream has no lifecycle runtime owner.");
  }
  return runtime;
}

function isDefaultOpenClawStreamFnForModel(
  model: EmbeddedRunAttemptParams["model"],
  streamFn: StreamFn | undefined,
  llmRuntime: LlmRuntime,
): boolean {
  if (!streamFn || streamFn === llmRuntime.streamSimple) {
    return true;
  }
  const api = typeof model.api === "string" ? model.api.trim() : "";
  if (!api) {
    return false;
  }
  const provider = llmRuntime.registry.getApiProvider(api as never);
  return streamFn === provider?.streamSimple || streamFn === provider?.stream;
}

function isOpenAICodexResponsesModel(model: EmbeddedRunAttemptParams["model"]): boolean {
  return model.provider === "openai" && model.api === "openai-chatgpt-responses";
}

function resolveOpenClawNativeCodexResponsesStreamFn(params: {
  model: EmbeddedRunAttemptParams["model"];
  currentStreamFn: StreamFn | undefined;
  llmRuntime: LlmRuntime;
}): StreamFn | undefined {
  if (!isOpenAICodexResponsesModel(params.model)) {
    return undefined;
  }
  // Lifecycle-owned session streams wrap auth/retry policy, so their runtime
  // binding preserves native Codex transport even when function identity differs.
  if (
    !isDefaultOpenClawStreamFnForModel(params.model, params.currentStreamFn, params.llmRuntime) &&
    getStreamLlmRuntime(params.currentStreamFn) !== params.llmRuntime
  ) {
    return undefined;
  }
  return params.currentStreamFn ?? params.llmRuntime.streamSimple;
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

export function resolveEmbeddedAgentStream(
  params: EmbeddedStreamRuntimeOwner & {
    providerStreamFn?: StreamFn;
    sessionId: string;
    promptCacheKey?: string;
    signal?: AbortSignal;
    model: EmbeddedRunAttemptParams["model"];
    resolvedApiKey?: string;
    transportAuthAvailable?: boolean;
    authProfileId?: string;
    authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
  },
): { streamFn: StreamFn; strategy: string } {
  const llmRuntime = resolveEmbeddedStreamRuntime(params);
  const wrapOptions = {
    runSignal: params.signal,
    resolvedApiKey: params.resolvedApiKey,
    authProfileId: params.authProfileId,
    authStorage: params.authStorage,
    providerId: params.model.provider,
    promptCacheKey: params.promptCacheKey,
  };
  const stripCacheBoundary = (context: Parameters<StreamFn>[1]) =>
    context.systemPrompt
      ? { ...context, systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt) }
      : context;
  if (params.providerStreamFn) {
    return {
      streamFn: wrapEmbeddedAgentStreamFn(params.providerStreamFn, {
        ...wrapOptions,
        transformContext: stripCacheBoundary,
      }),
      strategy: "provider",
    };
  }

  const currentStreamFn = params.currentStreamFn ?? llmRuntime.streamSimple;
  if (params.model.provider === "anthropic-vertex") {
    const vertexStreamFn = createAnthropicVertexStreamFnForModel(params.model);
    return {
      streamFn: params.signal
        ? wrapEmbeddedAgentStreamFn(vertexStreamFn, {
            runSignal: params.signal,
            providerId: params.model.provider,
          })
        : vertexStreamFn,
      strategy: "anthropic-vertex",
    };
  }

  const nativeStreamFn = resolveOpenClawNativeCodexResponsesStreamFn({
    model: params.model,
    currentStreamFn: params.currentStreamFn,
    llmRuntime,
  });
  if (nativeStreamFn) {
    return {
      streamFn: wrapEmbeddedAgentStreamFn(nativeStreamFn, {
        ...wrapOptions,
        sessionId: params.sessionId,
        transformContext: stripCacheBoundary,
      }),
      strategy: "openclaw-native-codex-responses",
    };
  }

  const isDefault = isDefaultOpenClawStreamFnForModel(
    params.model,
    params.currentStreamFn,
    llmRuntime,
  );
  if (
    isDefault ||
    hasResolvedRuntimeApiKey(params.resolvedApiKey) ||
    params.transportAuthAvailable ||
    // Proxied Anthropic streams need the managed transport's commentary tagging
    // even without a resolved key; direct Anthropic keeps its existing replay path.
    (params.model.api === "anthropic-messages" && params.model.provider !== "anthropic")
  ) {
    const boundaryAwareStreamFn = createBoundaryAwareStreamFnForModel(params.model);
    if (boundaryAwareStreamFn) {
      return {
        streamFn: wrapEmbeddedAgentStreamFn(boundaryAwareStreamFn, {
          ...wrapOptions,
          sessionId: params.sessionId,
        }),
        strategy: `boundary-aware:${params.model.api}`,
      };
    }
  }

  const promptCacheKey = params.promptCacheKey?.trim();
  return {
    streamFn:
      !promptCacheKey && !params.signal
        ? currentStreamFn
        : wrapEmbeddedAgentStreamFn(currentStreamFn, {
            runSignal: params.signal,
            providerId: params.model.provider,
            promptCacheKey,
          }),
    strategy: isDefault ? "stream-simple" : "session-custom",
  };
}

/** Preserve request activity across cancellation composition without retaining completed turns. */
function composeRunSignal(callerSignal: AbortSignal, runSignal: AbortSignal): AbortSignal {
  const composedSignal = AbortSignal.any([callerSignal, runSignal]);
  // The activity registry owns this bridge weakly; an abort listener on either
  // reusable source would retain its composite after a successful request.
  onLlmRequestActivity(composedSignal, () => {
    if (!composedSignal.aborted) {
      notifyLlmRequestActivity(callerSignal);
    }
  });
  return composedSignal;
}

function wrapEmbeddedAgentStreamFn(
  inner: StreamFn,
  params: {
    runSignal: AbortSignal | undefined;
    resolvedApiKey?: string;
    authProfileId?: string;
    authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
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
    const callerSignal = embeddedOptions?.signal;
    const signal =
      callerSignal && params.runSignal && callerSignal !== params.runSignal
        ? composeRunSignal(callerSignal, params.runSignal)
        : (callerSignal ?? params.runSignal);
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
