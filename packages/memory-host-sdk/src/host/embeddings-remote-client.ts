// Memory Host SDK module implements embeddings remote client behavior.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddingProviderOptions } from "./embeddings.types.js";
import { requireApiKey, resolveApiKeyForProvider } from "./openclaw-runtime-auth.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

// Builds authenticated remote embedding HTTP clients from agent memory config.

/** Provider id used for remote embedding auth and config lookup. */
export type RemoteEmbeddingProviderId = string;

/** Attribution headers for native OpenAI embedding calls. */
function resolveOpenClawAttributionHeaders(): Record<string, string> {
  const version = typeof process !== "undefined" ? process.env.OPENCLAW_VERSION?.trim() : undefined;
  return {
    originator: "openclaw",
    ...(version ? { version } : {}),
    "User-Agent": version ? `openclaw/${version}` : "openclaw",
  };
}

/** Detect the native OpenAI embeddings API route that accepts attribution headers. */
function isNativeOpenAIEmbeddingRoute(provider: string, baseUrl: string): boolean {
  if (provider !== "openai") {
    return false;
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, "") === "api.openai.com";
  } catch {
    return false;
  }
}

/** Resolve base URL, bearer headers, header overrides, and SSRF policy for remote embeddings. */
export async function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
}): Promise<{ baseUrl: string; headers: Record<string, string>; ssrfPolicy?: SsrFPolicy }> {
  const remote = params.options.remote;
  const remoteApiKey = resolveMemorySecretInputString({
    value: remote?.apiKey,
    path: "memory.search.remote.apiKey",
  });
  const remoteBaseUrl = normalizeOptionalString(remote?.baseUrl);
  const providerConfig = params.options.config.models?.providers?.[params.provider];
  const apiKey = remoteApiKey
    ? remoteApiKey
    : requireApiKey(
        await resolveApiKeyForProvider({
          provider: params.provider,
          cfg: params.options.config,
          agentDir: params.options.agentDir,
        }),
        params.provider,
      );
  const baseUrl =
    remoteBaseUrl || normalizeOptionalString(providerConfig?.baseUrl) || params.defaultBaseUrl;
  const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...headerOverrides,
  };
  if (isNativeOpenAIEmbeddingRoute(params.provider, baseUrl)) {
    Object.assign(headers, resolveOpenClawAttributionHeaders());
  }
  return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl) };
}
