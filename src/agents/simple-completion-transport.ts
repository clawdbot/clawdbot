import type { ApiRegistry } from "@openclaw/ai";
/**
 * Simple completion transport preparation.
 *
 * Registers provider-specific stream functions and rewrites models that need OpenClaw-managed transport semantics.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Api, Model } from "../llm/types.js";
import { wrapProviderSimpleCompletionStreamFn } from "../plugins/provider-runtime.js";
import { createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { prepareGoogleSimpleCompletionModel } from "./google-simple-completion-stream.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import {
  buildTransportAwareSimpleStreamFn,
  createOpenClawTransportStreamFnForModel,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";
import type { StreamFn } from "./runtime/index.js";

const PROVIDER_SIMPLE_COMPLETION_API_PREFIX = "openclaw-provider-simple:";

function resolveAnthropicVertexSimpleApi(baseUrl?: string): Api {
  const suffix = baseUrl?.trim() ? encodeURIComponent(baseUrl.trim()) : "default";
  return `openclaw-anthropic-vertex-simple:${suffix}`;
}

export function normalizeCodexResponsesBaseUrlForOpenAISdk(baseUrl?: string): string {
  const normalized = baseUrl?.trim().replace(/\/+$/u, "") || "https://chatgpt.com/backend-api";
  try {
    const parsed = new URL(normalized);
    const path = parsed.pathname.replace(/\/+$/u, "").toLowerCase();
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
  } catch {
    // Keep non-URL custom values on the same suffix contract transport callers accept.
  }
  if (normalized.endsWith("/codex/responses")) {
    return normalized.slice(0, -"/responses".length);
  }
  if (normalized.endsWith("/codex")) {
    return normalized;
  }
  return `${normalized}/codex`;
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
  cfg?: OpenClawConfig,
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
    sourceProvider.streamSimple({ ...runtimeModel, api: sourceApi }, context, options);
  const streamFn = wrapProviderSimpleCompletionStreamFn({
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
  ensureCustomApiRegistered(registry, api, streamFn);
  return { ...model, api };
}

function prepareCodexSimpleTransportModel<TApi extends Api>(
  registry: ApiRegistry,
  model: Model<TApi>,
  cfg?: OpenClawConfig,
): Model | undefined {
  if (model.provider !== "openai" || model.api !== "openai-chatgpt-responses") {
    return undefined;
  }

  // Static Codex provider catalogs intentionally omit credentials; the simple
  // completion path must use OpenClaw's transport so resolved request auth is applied.
  const transportModel = {
    ...model,
    baseUrl: normalizeCodexResponsesBaseUrlForOpenAISdk(model.baseUrl),
  } as Model;
  const api = resolveTransportAwareSimpleApi(model.api);
  const streamFn = createOpenClawTransportStreamFnForModel(transportModel, { cfg });
  if (!api || !streamFn) {
    return undefined;
  }

  ensureCustomApiRegistered(registry, api, streamFn);
  return {
    ...transportModel,
    api,
  };
}

export function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  apiRegistry: ApiRegistry;
  model: Model<TApi>;
  cfg?: OpenClawConfig;
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
    if (streamFn) {
      ensureCustomApiRegistered(apiRegistry, transportAwareModel.api, streamFn);
      return applyProviderSimpleCompletionWrapper(apiRegistry, transportAwareModel, cfg);
    }
  }

  if (model.api === "google-generative-ai") {
    return applyProviderSimpleCompletionWrapper(
      apiRegistry,
      prepareGoogleSimpleCompletionModel(apiRegistry, model),
      cfg,
    );
  }

  if (model.provider === "anthropic-vertex") {
    const api = resolveAnthropicVertexSimpleApi(model.baseUrl);
    ensureCustomApiRegistered(apiRegistry, api, createAnthropicVertexStreamFnForModel(model));
    return applyProviderSimpleCompletionWrapper(apiRegistry, { ...model, api }, cfg);
  }

  return applyProviderSimpleCompletionWrapper(apiRegistry, model, cfg);
}
