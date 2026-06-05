/**
 * Simple completion transport preparation.
 *
 * Registers provider-specific stream functions and rewrites models that need OpenClaw-managed transport semantics.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getApiProvider } from "../llm/api-registry.js";
import type { Api, Model } from "../llm/types.js";
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

function resolveAnthropicVertexSimpleApi(baseUrl?: string): Api {
  const suffix = baseUrl?.trim() ? encodeURIComponent(baseUrl.trim()) : "default";
  return `openclaw-anthropic-vertex-simple:${suffix}`;
}

function normalizeCodexResponsesBaseUrlForOpenAISdk(baseUrl?: string): string {
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

function prepareCodexSimpleTransportModel<TApi extends Api>(
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

  ensureCustomApiRegistered(api, streamFn);
  return {
    ...transportModel,
    api,
  };
}

export function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
}): Model {
  const { model, cfg } = params;
  // Only provider-owned custom APIs need runtime stream registration here.
  if (!getApiProvider(model.api) && registerProviderStreamForModel({ model, cfg })) {
    return model;
  }

  const codexTransportModel = prepareCodexSimpleTransportModel(model, cfg);
  if (codexTransportModel) {
    return codexTransportModel;
  }

  const transportAwareModel = prepareTransportAwareSimpleModel(model, { cfg });
  if (transportAwareModel !== model) {
    const streamFn = buildTransportAwareSimpleStreamFn(model, { cfg });
    if (streamFn) {
      ensureCustomApiRegistered(transportAwareModel.api, streamFn);
      return transportAwareModel;
    }
  }

  if (model.api === "google-generative-ai") {
    return prepareGoogleSimpleCompletionModel(model);
  }

  if (model.provider === "anthropic-vertex") {
    const api = resolveAnthropicVertexSimpleApi(model.baseUrl);
    ensureCustomApiRegistered(api, createAnthropicVertexStreamFnForModel(model));
    return { ...model, api };
  }

  return model;
}
