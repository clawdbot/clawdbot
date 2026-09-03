// Memory Host SDK module implements embeddings remote client behavior.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddingProviderOptions } from "./embeddings.types.js";
import { requireApiKey, resolveApiKeyForProvider } from "./openclaw-runtime-auth.js";
import type { SsrFPolicy } from "./openclaw-runtime-network.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

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

function normalizeEmbeddingDestinationKey(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.protocol}//${hostname}:${port}${pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

/** Whether provider-owned embedding credentials belong to the selected destination. */
export function embeddingProviderOwnsDestination(params: {
  baseUrl: string;
  providerBaseUrl: string;
}): boolean {
  const baseUrlKey = normalizeEmbeddingDestinationKey(params.baseUrl);
  const providerBaseUrlKey = normalizeEmbeddingDestinationKey(params.providerBaseUrl);
  return baseUrlKey !== undefined && baseUrlKey === providerBaseUrlKey;
}

/** Append an embedding endpoint without changing its destination-owned query. */
export function resolveEmbeddingEndpointUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${endpoint.replace(/^\/+/, "")}`;
  url.hash = "";
  return url.toString();
}

function resolveEmbeddingHeaders(
  ...sources: Array<{ headers: Record<string, unknown> | undefined; path: string }>
): Map<string, [string, string]> {
  const resolved = new Map<string, [string, string]>();
  for (const source of sources) {
    // Retain each source's existing SecretRef and prototype-key handling.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(source.headers ?? {})) {
      const header = resolveMemorySecretInputString({ value, path: `${source.path}.${name}` });
      if (header) {
        headers[name] = header;
      }
    }
    for (const entry of Object.entries(headers)) {
      resolved.set(entry[0].toLowerCase(), entry);
    }
  }
  return resolved;
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
  const providerBaseUrl = normalizeOptionalString(providerConfig?.baseUrl) || params.defaultBaseUrl;
  const baseUrl = remoteBaseUrl || providerBaseUrl;
  const providerOwnsDestination = embeddingProviderOwnsDestination({
    baseUrl,
    providerBaseUrl,
  });
  const headerOverrides = resolveEmbeddingHeaders(
    {
      headers: providerOwnsDestination ? providerConfig?.headers : undefined,
      path: `models.providers.${params.provider}.headers`,
    },
    {
      headers: remote?.headers,
      path: "memory.search.remote.headers",
    },
  );
  const hasExplicitAuthorization = headerOverrides.has("authorization");
  const apiKey = hasExplicitAuthorization
    ? undefined
    : remoteApiKey
      ? remoteApiKey
      : providerOwnsDestination
        ? requireApiKey(
            await resolveApiKeyForProvider({
              provider: params.provider,
              cfg: params.options.config,
              agentDir: params.options.agentDir,
            }),
            params.provider,
          )
        : undefined;
  if (!apiKey && !hasExplicitAuthorization) {
    throw new Error(
      `${params.provider} embedding credentials are not configured for ${baseUrl}. Set memory.search.remote.apiKey or an Authorization header for this destination.`,
    );
  }
  const entries: Array<[string, string]> = [["Content-Type", "application/json"]];
  if (apiKey) {
    entries.push(["Authorization", `Bearer ${apiKey}`]);
  }
  entries.push(...headerOverrides.values());
  if (isNativeOpenAIEmbeddingRoute(params.provider, baseUrl)) {
    entries.push(...Object.entries(resolveOpenClawAttributionHeaders()));
  }
  // Fetch joins duplicate names; retain only the last source, but preserve its
  // spelling so ordinary non-secret embedding cache identities stay unchanged.
  const headers = Object.fromEntries(
    new Map(entries.map((entry) => [entry[0].toLowerCase(), entry])).values(),
  );
  return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl) };
}
