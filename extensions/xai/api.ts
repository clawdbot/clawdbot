// Xai API module exposes the plugin public contract.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  applyXaiModelCompat,
  HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
  normalizeNativeXaiModelId,
  XAI_TOOL_SCHEMA_PROFILE,
} from "./model-compat.js";
import { XAI_BASE_URL } from "./model-definitions.js";
import { isXaiProviderId } from "./provider-id.js";

export { buildXaiProvider } from "./provider-catalog.js";
export { applyXaiConfig, applyXaiProviderConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
export { buildXaiImageGenerationProvider } from "./image-generation-provider.js";
export {
  buildXaiCatalogModels,
  buildXaiModelDefinition,
  resolveXaiCatalogEntry,
  XAI_BASE_URL,
  XAI_DEFAULT_CONTEXT_WINDOW,
  XAI_DEFAULT_IMAGE_MODEL,
  XAI_DEFAULT_MODEL_ID,
  XAI_DEFAULT_MAX_TOKENS,
  XAI_IMAGE_MODELS,
} from "./model-definitions.js";
export { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
export { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";
export { applyXaiModelCompat, HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING, XAI_TOOL_SCHEMA_PROFILE };

const XAI_NATIVE_ENDPOINT_HOSTS = new Set(["api.x.ai"]);

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

function getModelProviderHint(modelId: string): string | null {
  const trimmed = normalizeOptionalLowercaseString(modelId);
  if (!trimmed) {
    return null;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return null;
  }
  return trimmed.slice(0, slashIndex) || null;
}

function shouldUseXaiResponsesTransport(params: {
  provider: string;
  api?: unknown;
  baseUrl?: unknown;
}): boolean {
  const hasDefaultXaiRoute =
    isXaiProviderId(params.provider) && !normalizeOptionalString(params.baseUrl);
  return params.api === "openai-responses"
    ? hasDefaultXaiRoute
    : params.api === "openai-completions" &&
        (isXaiNativeEndpoint(params.baseUrl) || hasDefaultXaiRoute);
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
    baseUrl:
      normalizeOptionalString(params.baseUrl) ??
      (isXaiProviderId(params.provider) ? XAI_BASE_URL : undefined),
  };
}
