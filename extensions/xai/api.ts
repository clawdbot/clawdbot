import {
  getModelProviderHint,
  normalizeNativeXaiModelId,
  normalizeProviderId,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyXaiModelCompat,
  resolveXaiModelCompatPatch,
} from "openclaw/plugin-sdk/provider-tools";
import { readStringValue } from "openclaw/plugin-sdk/text-runtime";

export { buildXaiProvider } from "./provider-catalog.js";
export { applyXaiConfig, applyXaiProviderConfig } from "./onboard.js";
export { buildXaiImageGenerationProvider } from "./image-generation-provider.js";
export {
  buildXaiCatalogModels,
  buildXaiModelDefinition,
  resolveXaiCatalogEntry,
  XAI_BASE_URL,
  XAI_DEFAULT_CONTEXT_WINDOW,
  XAI_DEFAULT_IMAGE_MODEL,
  XAI_DEFAULT_MODEL_ID,
  XAI_DEFAULT_MODEL_REF,
  XAI_DEFAULT_MAX_TOKENS,
  XAI_IMAGE_MODELS,
} from "./model-definitions.js";
export { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
export { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";
export {
  applyXaiModelCompat,
  HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
  XAI_TOOL_SCHEMA_PROFILE,
  resolveXaiModelCompatPatch,
} from "openclaw/plugin-sdk/provider-tools";

const XAI_NATIVE_ENDPOINT_HOSTS = new Set(["api.x.ai", "api.grok.x.ai"]);

function resolveHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isXaiNativeEndpoint(baseUrl: unknown): boolean {
  return (
    typeof baseUrl === "string" && XAI_NATIVE_ENDPOINT_HOSTS.has(resolveHostname(baseUrl) ?? "")
  );
}

export function isXaiModelHint(modelId: string): boolean {
  return getModelProviderHint(modelId) === "x-ai";
}

export { normalizeNativeXaiModelId as normalizeXaiModelId };

function shouldUseXaiResponsesTransport(params: {
  provider: string;
  api?: unknown;
  baseUrl?: unknown;
}): boolean {
  if (params.api !== "openai-completions") {
    return false;
  }
  if (isXaiNativeEndpoint(params.baseUrl)) {
    return true;
  }
  return normalizeProviderId(params.provider) === "xai" && !params.baseUrl;
}

export function shouldContributeXaiCompat(params: {
  modelId: string;
  model: { api?: unknown; baseUrl?: unknown };
}): boolean {
  if (params.model.api !== "openai-completions") {
    return false;
  }
  return isXaiNativeEndpoint(params.model.baseUrl) || isXaiModelHint(params.modelId);
}

export function resolveXaiTransport(params: {
  provider: string;
  api?: unknown;
  baseUrl?: unknown;
}): { api: "openai-responses"; baseUrl?: string } | undefined {
  if (!shouldUseXaiResponsesTransport(params)) {
    return undefined;
  }
  return {
    api: "openai-responses",
    baseUrl: readStringValue(params.baseUrl),
  };
}

export function resolveXaiBaseUrl(baseUrlOrConfig?: unknown): string {
  let candidate = baseUrlOrConfig;
  if (
    baseUrlOrConfig &&
    typeof baseUrlOrConfig === "object" &&
    !Array.isArray(baseUrlOrConfig) &&
    "cfg" in baseUrlOrConfig
  ) {
    candidate =
      (baseUrlOrConfig as { cfg?: { models?: { providers?: { xai?: { baseUrl?: unknown } } } } })
        .cfg?.models?.providers?.xai?.baseUrl ?? baseUrlOrConfig;
  }
  return readStringValue(candidate) || "https://api.x.ai/v1";
}
