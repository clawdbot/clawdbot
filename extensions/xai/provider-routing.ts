import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { XAI_BASE_URL } from "./model-definitions.js";
import { isXaiProviderId } from "./provider-id.js";

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

export function supportsXaiPromptCacheKey(params: { api?: unknown; baseUrl?: unknown }): boolean {
  const baseUrl = normalizeOptionalString(params.baseUrl) ?? XAI_BASE_URL;
  // Native Chat Completions routes are normalized to Responses after model compat.
  return (
    (params.api === "openai-responses" || params.api === "openai-completions") &&
    (isXaiNativeEndpoint(baseUrl) ||
      (params.api === "openai-responses" && resolveHostname(baseUrl) === "cli-chat-proxy.grok.com"))
  );
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
