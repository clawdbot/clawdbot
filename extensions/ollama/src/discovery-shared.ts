import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import { readProviderBaseUrl } from "./provider-base-url.js";
import { resolveOllamaApiBase } from "./provider-models.js";

export const OLLAMA_PROVIDER_ID = "ollama";
export const OLLAMA_DEFAULT_API_KEY = "ollama-local";

export type OllamaPluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

type OllamaDiscoveryContext = {
  config: {
    models?: {
      providers?: Record<string, ModelProviderConfig | undefined>;
      ollamaDiscovery?: {
        enabled?: boolean;
      };
    };
  };
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: (providerId: string) => { apiKey?: unknown };
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (value && typeof value === "object" && "value" in value) {
    return normalizeOptionalString((value as { value?: unknown }).value);
  }
  return undefined;
}

function resolveOllamaDiscoveryApiKey(params: {
  env: NodeJS.ProcessEnv;
  baseUrl?: string;
  explicitApiKey?: string;
  hasDeclaredApiKey?: boolean;
  resolvedApiKey?: unknown;
}): string | undefined {
  const envValue = normalizeOptionalString(params.env.OLLAMA_API_KEY);
  const envApiKey = envValue ? "OLLAMA_API_KEY" : undefined;
  const resolvedApiKey = normalizeOptionalString(params.resolvedApiKey);
  const explicitApiKey = normalizeOptionalString(params.explicitApiKey);
  if (explicitApiKey) {
    return explicitApiKey;
  }
  if (params.hasDeclaredApiKey && resolvedApiKey) {
    return resolvedApiKey;
  }
  if (!isLocalOllamaBaseUrl(params.baseUrl)) {
    return envApiKey ?? (resolvedApiKey !== OLLAMA_DEFAULT_API_KEY ? resolvedApiKey : undefined);
  }
  if (resolvedApiKey && resolvedApiKey !== envValue && resolvedApiKey !== OLLAMA_DEFAULT_API_KEY) {
    return resolvedApiKey;
  }
  return OLLAMA_DEFAULT_API_KEY;
}

function shouldSkipAmbientOllamaDiscovery(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

const LOCAL_OLLAMA_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"]);

function isIpv4Loopback(host: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return false;
  }
  const octets = host.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return octets[0] === 127;
}

function isIpv4PrivateRange(host: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return false;
  }
  const octets = host.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isIpv6LocalRange(host: string): boolean {
  const lower = host.toLowerCase();
  return /^fe[89ab][0-9a-f]:/.test(lower) || /^f[cd][0-9a-f]{2}:/.test(lower);
}

export function isLocalOllamaBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return (
    LOCAL_OLLAMA_HOSTNAMES.has(host) ||
    host.endsWith(".local") ||
    isIpv4PrivateRange(host) ||
    isIpv6LocalRange(host) ||
    (!host.includes(".") && !host.includes(":"))
  );
}

function isLoopbackOllamaBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return LOCAL_OLLAMA_HOSTNAMES.has(host) || isIpv4Loopback(host);
}

function hasExplicitRemoteOllamaApiProvider(
  providers: Record<string, ModelProviderConfig | undefined> | undefined,
): boolean {
  if (!providers) {
    return false;
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    if (providerId === OLLAMA_PROVIDER_ID || !provider) {
      continue;
    }
    if (normalizeOptionalString(provider.api)?.toLowerCase() !== "ollama") {
      continue;
    }
    const baseUrl = readProviderBaseUrl(provider);
    if (baseUrl && !isLoopbackOllamaBaseUrl(baseUrl)) {
      return true;
    }
  }
  return false;
}

export function shouldUseSyntheticOllamaAuth(
  providerConfig: ModelProviderConfig | undefined,
): boolean {
  if (!hasMeaningfulExplicitOllamaConfig(providerConfig)) {
    return false;
  }
  return isLocalOllamaBaseUrl(readProviderBaseUrl(providerConfig));
}

function hasMeaningfulExplicitOllamaConfig(
  providerConfig: ModelProviderConfig | undefined,
): boolean {
  if (!providerConfig) {
    return false;
  }
  if (Array.isArray(providerConfig.models) && providerConfig.models.length > 0) {
    return true;
  }
  const baseUrl = readProviderBaseUrl(providerConfig);
  if (baseUrl) {
    return resolveOllamaApiBase(baseUrl) !== OLLAMA_DEFAULT_BASE_URL;
  }
  if (readStringValue(providerConfig.apiKey)) {
    return true;
  }
  if (providerConfig.auth) {
    return true;
  }
  if (typeof providerConfig.authHeader === "boolean") {
    return true;
  }
  if (
    providerConfig.headers &&
    typeof providerConfig.headers === "object" &&
    Object.keys(providerConfig.headers).length > 0
  ) {
    return true;
  }
  if (providerConfig.request) {
    return true;
  }
  if (typeof providerConfig.injectNumCtxForOpenAICompat === "boolean") {
    return true;
  }
  return false;
}

export async function resolveOllamaDiscoveryResult(params: {
  ctx: OllamaDiscoveryContext;
  pluginConfig: OllamaPluginConfig;
  buildProvider: (
    configuredBaseUrl?: string,
    opts?: { quiet?: boolean },
  ) => Promise<ModelProviderConfig>;
}): Promise<{ provider: ModelProviderConfig } | null> {
  const explicit = params.ctx.config.models?.providers?.ollama;
  const hasExplicitModels = Array.isArray(explicit?.models) && explicit.models.length > 0;
  const hasMeaningfulExplicitConfig = hasMeaningfulExplicitOllamaConfig(explicit);
  const hasRemoteOllamaApiProvider = hasExplicitRemoteOllamaApiProvider(
    params.ctx.config.models?.providers,
  );
  const discoveryEnabled =
    params.pluginConfig.discovery?.enabled ?? params.ctx.config.models?.ollamaDiscovery?.enabled;
  if (!hasExplicitModels && discoveryEnabled === false) {
    return null;
  }
  const ollamaKey = params.ctx.resolveProviderApiKey(OLLAMA_PROVIDER_ID).apiKey;
  const hasOllamaDiscoveryOptIn = typeof ollamaKey === "string" && ollamaKey.trim().length > 0;
  const hasRealOllamaKey =
    typeof ollamaKey === "string" &&
    ollamaKey.trim().length > 0 &&
    ollamaKey.trim() !== OLLAMA_DEFAULT_API_KEY;
  const explicitApiKey = readStringValue(explicit?.apiKey);
  const hasDeclaredApiKey = explicit?.apiKey !== undefined;
  if (hasExplicitModels && explicit) {
    const baseUrl = resolveOllamaApiBase(readProviderBaseUrl(explicit) ?? OLLAMA_DEFAULT_BASE_URL);
    const apiKey = resolveOllamaDiscoveryApiKey({
      env: params.ctx.env,
      baseUrl,
      explicitApiKey,
      hasDeclaredApiKey,
      resolvedApiKey: ollamaKey,
    });
    return {
      provider: {
        ...explicit,
        baseUrl,
        api: explicit.api ?? "ollama",
        ...(apiKey ? { apiKey } : {}),
      },
    };
  }
  if (!hasMeaningfulExplicitConfig && hasRemoteOllamaApiProvider) {
    return null;
  }
  if (!hasOllamaDiscoveryOptIn && !hasMeaningfulExplicitConfig) {
    return null;
  }
  if (
    !hasRealOllamaKey &&
    !hasMeaningfulExplicitConfig &&
    shouldSkipAmbientOllamaDiscovery(params.ctx.env)
  ) {
    return null;
  }

  const configuredBaseUrl = readProviderBaseUrl(explicit);
  const provider = await params.buildProvider(configuredBaseUrl, {
    quiet: !hasRealOllamaKey && !hasMeaningfulExplicitConfig,
  });
  if (provider.models?.length === 0 && !ollamaKey && !explicit?.apiKey) {
    return null;
  }
  const apiKey = resolveOllamaDiscoveryApiKey({
    env: params.ctx.env,
    baseUrl: provider.baseUrl ?? configuredBaseUrl,
    explicitApiKey,
    hasDeclaredApiKey,
    resolvedApiKey: ollamaKey,
  });
  return {
    provider: {
      ...provider,
      ...(apiKey ? { apiKey } : {}),
    },
  };
}
