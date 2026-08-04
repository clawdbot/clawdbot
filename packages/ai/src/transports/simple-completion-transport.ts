/**
 * Simple completion transport preparation.
 *
 * Registers provider-specific stream functions and rewrites models that need OpenClaw-managed transport semantics.
 */
import type { Api, Model, StreamFn } from "@openclaw/llm-core";
import type { ApiRegistry } from "../api-registry.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import {
  buildTransportAwareSimpleStreamFn,
  createOpenClawTransportStreamFnForModel,
  createTransportAwareStreamFnForModel,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";

const PROVIDER_SIMPLE_COMPLETION_API_PREFIX = "openclaw-provider-simple:";
const INVALID_CODEX_BASE_URL_MESSAGE =
  "OpenAI Codex Responses baseUrl must not include query parameters or fragments";

function registerCustomApi(registry: ApiRegistry, api: Api, streamFn: StreamFn): boolean {
  getAiTransportHost().registerCustomApi(registry, api, streamFn);
  return registry.getApiProvider(api) !== undefined;
}

function projectModel(model: Model, patch: Partial<Model>): Model {
  return getAiTransportHost().inheritManagedTransport(model, { ...model, ...patch });
}

function resolveAnthropicVertexSimpleApi(baseUrl?: string): Api {
  const suffix = baseUrl?.trim() ? encodeURIComponent(baseUrl.trim()) : "default";
  return `openclaw-anthropic-vertex-simple:${suffix}`;
}

export function normalizeCodexResponsesBaseUrlForOpenAISdk(baseUrl?: string): string {
  const normalized = baseUrl?.trim() || "https://chatgpt.com/backend-api";
  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname.replace(/\/+$/u, "");
    const path = pathname.toLowerCase();
    if (
      parsed.hostname.toLowerCase() === "chatgpt.com" &&
      [
        "/backend-api",
        "/backend-api/v1",
        "/backend-api/codex",
        "/backend-api/codex/v1",
        "/backend-api/codex/responses",
      ].includes(path)
    ) {
      parsed.pathname = "/backend-api/codex";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/u, "");
    }
    if (normalized.includes("?") || normalized.includes("#")) {
      throw new Error(INVALID_CODEX_BASE_URL_MESSAGE);
    }
    parsed.pathname = path.endsWith("/codex/responses")
      ? pathname.slice(0, -"/responses".length)
      : path.endsWith("/codex")
        ? pathname
        : `${pathname}/codex`;
    return parsed.toString();
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_CODEX_BASE_URL_MESSAGE) {
      throw error;
    }
    // Keep non-URL custom values on the same suffix contract transport callers accept.
  }
  if (normalized.includes("?") || normalized.includes("#")) {
    throw new Error(INVALID_CODEX_BASE_URL_MESSAGE);
  }
  const path = normalized.replace(/\/+$/u, "");
  if (path.endsWith("/codex/responses")) {
    return path.slice(0, -"/responses".length);
  }
  return path.endsWith("/codex") ? path : `${path}/codex`;
}

function resolveProviderSimpleCompletionApi(model: Model): Api {
  const parts = [model.provider, model.id, model.api, model.baseUrl || "default"];
  return `${PROVIDER_SIMPLE_COMPLETION_API_PREFIX}${parts
    .map((part) => encodeURIComponent(part))
    .join(":")}`;
}

function applyProviderSimpleCompletionWrapper(
  registry: ApiRegistry,
  model: Model,
  cfg?: unknown,
): Model {
  if (model.api.startsWith(PROVIDER_SIMPLE_COMPLETION_API_PREFIX)) {
    return model;
  }
  const sourceProvider = registry.getApiProvider(model.api);
  if (!sourceProvider) {
    return model;
  }

  const sourceApi = model.api;
  const sourceStreamFn: StreamFn = (runtimeModel, context, options) =>
    sourceProvider.streamSimple(projectModel(runtimeModel, { api: sourceApi }), context, options);
  const streamFn = getAiTransportHost().plugin.wrapSimpleCompletionStream({
    provider: model.provider,
    config: cfg,
    context: {
      config: cfg,
      provider: model.provider,
      modelId: model.id,
      model,
      streamFn: sourceStreamFn,
    },
  });
  if (!streamFn) {
    return model;
  }

  const api = resolveProviderSimpleCompletionApi(model);
  return registerCustomApi(registry, api, streamFn) ? projectModel(model, { api }) : model;
}

function prepareCodexSimpleTransportModel<TApi extends Api>(
  registry: ApiRegistry,
  model: Model<TApi>,
  cfg?: unknown,
): Model | undefined {
  if (model.provider !== "openai" || model.api !== "openai-chatgpt-responses") {
    return undefined;
  }

  // Static Codex provider catalogs intentionally omit credentials; the simple
  // completion path must use OpenClaw's transport so resolved request auth is applied.
  const transportModel = projectModel(model, {
    baseUrl: normalizeCodexResponsesBaseUrlForOpenAISdk(model.baseUrl),
  });
  const api = resolveTransportAwareSimpleApi(model.api);
  const streamFn = createOpenClawTransportStreamFnForModel(transportModel, { cfg });
  if (!api || !streamFn) {
    return undefined;
  }

  if (!registerCustomApi(registry, api, streamFn)) {
    return undefined;
  }
  return projectModel(transportModel, { api });
}

function resolveModelTransportSentinels<TApi extends Api>(
  model: Model<TApi>,
  boundary: string,
): Model<TApi> {
  // Plugin transports read the symbol-attached request overrides as well as the
  // visible headers, so resolving `model.headers` alone would hand the plugin a
  // raw sentinel in `request.auth`. Delegate to the host, which owns both halves.
  return getAiTransportHost().unwrapModelTransportSentinels(model, boundary);
}

function wrapPluginProviderStream(streamFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const host = getAiTransportHost();
    const apiKey = options?.apiKey ? host.resolveSecretSentinel(options.apiKey) : options?.apiKey;
    const headers = resolveAiTransportHeaderSentinels(options?.headers);
    return streamFn(
      resolveModelTransportSentinels(model, "plugin simple-completion stream egress"),
      context,
      apiKey === options?.apiKey && headers === options?.headers
        ? options
        : { ...options, apiKey, headers },
    );
  };
}

function registerProviderStreamForModel<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: unknown;
  apiRegistry: ApiRegistry;
}): StreamFn | undefined {
  const pluginModel = resolveModelTransportSentinels(
    params.model,
    "plugin simple-completion stream construction",
  );
  const providerStreamFn = getAiTransportHost().plugin.resolveProviderStream({
    provider: params.model.provider,
    config: params.cfg,
    context: {
      config: params.cfg,
      provider: params.model.provider,
      modelId: params.model.id,
      model: pluginModel,
    },
  });
  const transportFallback = providerStreamFn
    ? undefined
    : createTransportAwareStreamFnForModel(
        params.model.api === "google-generative-ai" ? pluginModel : params.model,
        { cfg: params.cfg },
      );
  const streamFn = providerStreamFn
    ? wrapPluginProviderStream(providerStreamFn)
    : transportFallback && params.model.api === "google-generative-ai"
      ? wrapPluginProviderStream(transportFallback)
      : transportFallback;
  return streamFn && registerCustomApi(params.apiRegistry, params.model.api, streamFn)
    ? streamFn
    : undefined;
}

export function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  apiRegistry: ApiRegistry;
  model: Model<TApi>;
  cfg?: unknown;
}): Model {
  const { apiRegistry, model, cfg } = params;
  // Only provider-owned custom APIs need runtime stream registration here.
  if (
    !apiRegistry.getApiProvider(model.api) &&
    registerProviderStreamForModel({ model, cfg, apiRegistry })
  ) {
    return applyProviderSimpleCompletionWrapper(apiRegistry, model, cfg);
  }

  const codexTransportModel = prepareCodexSimpleTransportModel(apiRegistry, model, cfg);
  if (codexTransportModel) {
    return applyProviderSimpleCompletionWrapper(apiRegistry, codexTransportModel, cfg);
  }

  const transportAwareModel = prepareTransportAwareSimpleModel(model, { cfg });
  if (transportAwareModel !== model) {
    const streamFn = buildTransportAwareSimpleStreamFn(model, { cfg });
    if (streamFn && registerCustomApi(apiRegistry, transportAwareModel.api, streamFn)) {
      return applyProviderSimpleCompletionWrapper(apiRegistry, transportAwareModel, cfg);
    }
  }

  if (model.api === "google-generative-ai") {
    return applyProviderSimpleCompletionWrapper(
      apiRegistry,
      getAiTransportHost().prepareGoogleSimpleCompletionModel(apiRegistry, model),
      cfg,
    );
  }

  if (model.provider === "anthropic-vertex") {
    const api = resolveAnthropicVertexSimpleApi(model.baseUrl);
    const host = getAiTransportHost();
    const streamFn = host.plugin.createAnthropicVertexStream(model);
    if (registerCustomApi(apiRegistry, api, streamFn)) {
      const transportModel = projectModel(model, { api });
      return applyProviderSimpleCompletionWrapper(apiRegistry, transportModel, cfg);
    }
  }

  return applyProviderSimpleCompletionWrapper(apiRegistry, model, cfg);
}
