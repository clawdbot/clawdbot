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
