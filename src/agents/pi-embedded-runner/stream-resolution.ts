import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { createAnthropicVertexStreamFnForModel } from "../anthropic-vertex-stream.js";
import { createOpenAIWebSocketStreamFn } from "../openai-ws-stream.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import { createBoundaryAwareStreamFnForModel } from "../provider-transport-stream.js";
import { stripSystemPromptCacheBoundary } from "../system-prompt-cache-boundary.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let embeddedAgentBaseStreamFnCache = new WeakMap<object, StreamFn | undefined>();

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

export function resetEmbeddedAgentBaseStreamFnCacheForTest(): void {
  embeddedAgentBaseStreamFnCache = new WeakMap<object, StreamFn | undefined>();
}

export function describeEmbeddedAgentStreamStrategy(params: {
  currentStreamFn: StreamFn | undefined;
  providerStreamFn?: StreamFn;
  shouldUseWebSocketTransport: boolean;
  wsApiKey?: string;
  model: EmbeddedRunAttemptParams["model"];
}): string {
  if (params.providerStreamFn) {
    return "provider";
  }
  if (params.shouldUseWebSocketTransport) {
    return params.wsApiKey ? "openai-websocket" : "session-http-fallback";
  }
  if (params.model.provider === "anthropic-vertex") {
    return "anthropic-vertex";
  }
  if (params.currentStreamFn === undefined || params.currentStreamFn === streamSimple) {
    return createBoundaryAwareStreamFnForModel(params.model)
      ? `boundary-aware:${params.model.api}`
      : "stream-simple";
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
  shouldUseWebSocketTransport: boolean;
  wsApiKey?: string;
  sessionId: string;
  signal?: AbortSignal;
  model: EmbeddedRunAttemptParams["model"];
  resolvedApiKey?: string;
  authStorage?: { getApiKey(provider: string): Promise<string | undefined> };
}): StreamFn {
  if (params.providerStreamFn) {
    return wrapEmbeddedAgentStreamFn(params.providerStreamFn, {
      runSignal: params.signal,
      resolvedApiKey: params.resolvedApiKey,
      authStorage: params.authStorage,
      providerId: params.model.provider,
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
  if (params.shouldUseWebSocketTransport) {
    return params.wsApiKey
      ? createOpenAIWebSocketStreamFn(params.wsApiKey, params.sessionId, {
          signal: params.signal,
          managerOptions: {
            request: getModelProviderRequestTransport(params.model),
          },
        })
      : currentStreamFn;
  }

  if (params.model.provider === "anthropic-vertex") {
    return createAnthropicVertexStreamFnForModel(params.model);
  }

  if (params.currentStreamFn === undefined || params.currentStreamFn === streamSimple) {
    const boundaryAwareStreamFn = createBoundaryAwareStreamFnForModel(params.model);
    if (boundaryAwareStreamFn) {
      // Boundary-aware transports read credentials from options.apiKey just
      // like provider-owned streams, but the embedded run layer never gets to
      // inject the resolved runtime key for them. Without this wrap, OAuth
      // providers (e.g. openai-codex/gpt-5.5) hit the Responses API with an
      // empty bearer and fail with 401 Missing bearer auth header.
      return wrapEmbeddedAgentStreamFn(boundaryAwareStreamFn, {
        runSignal: params.signal,
        resolvedApiKey: params.resolvedApiKey,
        authStorage: params.authStorage,
        providerId: params.model.provider,
      });
    }
  }

  return currentStreamFn;
}

function wrapEmbeddedAgentStreamFn(
  inner: StreamFn,
  params: {
    runSignal: AbortSignal | undefined;
    resolvedApiKey: string | undefined;
    authStorage: { getApiKey(provider: string): Promise<string | undefined> } | undefined;
    providerId: string;
    transformContext?: (context: Parameters<StreamFn>[1]) => Parameters<StreamFn>[1];
  },
): StreamFn {
  const transformContext =
    params.transformContext ?? ((context: Parameters<StreamFn>[1]) => context);
  const mergeRunSignal = (options: Parameters<StreamFn>[2]) => {
    const signal = options?.signal ?? params.runSignal;
    return signal ? { ...options, signal } : options;
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
    return inner(m, transformContext(context), {
      ...mergeRunSignal(options),
      apiKey: apiKey ?? options?.apiKey,
    });
  };
}
