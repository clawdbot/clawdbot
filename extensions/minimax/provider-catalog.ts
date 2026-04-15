import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEFAULT_MINIMAX_CONTEXT_WINDOW,
  DEFAULT_MINIMAX_MAX_TOKENS,
  MINIMAX_API_BASE_URL,
  resolveMinimaxApiCost,
} from "./model-definitions.js";
import { MINIMAX_TEXT_MODEL_CATALOG, MINIMAX_TEXT_MODEL_ORDER } from "./provider-models.js";

function resolveMinimaxCatalogBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const rawHost = env.MINIMAX_API_HOST?.trim();
  if (!rawHost) {
    return MINIMAX_API_BASE_URL;
  }

  try {
    const url = new URL(rawHost);
    const basePath = url.pathname.replace(/\/+$/, "");
    if (basePath.endsWith("/anthropic")) {
      return `${url.origin}${basePath}`;
    }
    return `${url.origin}/anthropic`;
  } catch {
    return MINIMAX_API_BASE_URL;
  }
}

function buildMinimaxModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  input: ModelDefinitionConfig["input"];
  cost: ModelDefinitionConfig["cost"];
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name,
    reasoning: params.reasoning,
    input: params.input,
    cost: params.cost,
    contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  };
}

function buildMinimaxTextModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  cost: ModelDefinitionConfig["cost"];
}): ModelDefinitionConfig {
  return buildMinimaxModel({ ...params, input: ["text"] });
}

function buildMinimaxCatalog(): ModelDefinitionConfig[] {
  return MINIMAX_TEXT_MODEL_ORDER.map((id) => {
    const model = MINIMAX_TEXT_MODEL_CATALOG[id];
    return buildMinimaxTextModel({
      id,
      name: model.name,
      reasoning: model.reasoning,
      cost: resolveMinimaxApiCost(id),
    });
  });
}

export function buildMinimaxProvider(env?: NodeJS.ProcessEnv): ModelProviderConfig {
  return {
    baseUrl: resolveMinimaxCatalogBaseUrl(env),
    api: "anthropic-messages",
    authHeader: true,
    models: buildMinimaxCatalog(),
  };
}

export function buildMinimaxPortalProvider(env?: NodeJS.ProcessEnv): ModelProviderConfig {
  return {
    baseUrl: resolveMinimaxCatalogBaseUrl(env),
    api: "anthropic-messages",
    authHeader: true,
    models: buildMinimaxCatalog(),
  };
}
