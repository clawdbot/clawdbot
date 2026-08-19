import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { LLAMA_SERVER_DEFAULT_ORIGIN } from "./defaults.js";

type LlamaServerEndpoint = {
  origin: string;
  inferenceBaseUrl: string;
};

function toFetchableBaseUrl(value: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
    return value;
  }
  return `http://${value}`;
}

/** Resolves the server origin and its OpenAI-compatible `/v1` inference base. */
export function resolveLlamaServerEndpoint(configuredBaseUrl?: string): LlamaServerEndpoint {
  const configured = configuredBaseUrl?.trim() || LLAMA_SERVER_DEFAULT_ORIGIN;
  const parsed = new URL(toFetchableBaseUrl(configured));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`Unsupported llama-server protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("llama-server base URL must not contain credentials");
  }

  const pathname = parsed.pathname.replace(/\/+$/u, "").replace(/\/v1$/iu, "");
  parsed.pathname = pathname || "/";
  parsed.search = "";
  parsed.hash = "";
  const origin = parsed.toString().replace(/\/$/u, "");
  return {
    origin,
    inferenceBaseUrl: `${origin}/v1`,
  };
}

/** Canonicalizes persisted provider config for the shared OpenAI transport. */
export function normalizeLlamaServerProviderConfig(
  provider: ModelProviderConfig,
): ModelProviderConfig {
  const endpoint = resolveLlamaServerEndpoint(provider.baseUrl);
  const request = provider.request ?? {};
  const normalizedRequest =
    typeof request.allowPrivateNetwork === "boolean"
      ? request
      : { ...request, allowPrivateNetwork: true };
  return {
    ...provider,
    baseUrl: endpoint.inferenceBaseUrl,
    api: "openai-completions",
    request: normalizedRequest,
  };
}
