import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/extension-shared";
import {
  coerceSecretRef,
  resolveNonEnvSecretRefApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import {
  readProviderEnvValue,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  normalizeSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";

type XaiFallbackAuth = {
  apiKey: string;
  source: string;
};
const XAI_API_KEY_ENV_VAR = "XAI_API_KEY";
const XAI_PROVIDER_ID = "xai";

export type XaiToolAuthContext = {
  hasAuthForProvider?: (providerId: string) => boolean;
  resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
};

type ConfiguredRuntimeApiKeyResolution =
  | { status: "available"; value: string }
  | { status: "missing" }
  | { status: "blocked" };

function readConfiguredOrManagedApiKey(value: unknown): string | undefined {
  const literal = normalizeSecretInputString(value);
  if (literal) {
    return literal;
  }
  const ref = coerceSecretRef(value);
  return ref ? resolveNonEnvSecretRefApiKeyMarker(ref.source) : undefined;
}

function readLegacyGrokFallbackAuth(cfg?: OpenClawConfig): XaiFallbackAuth | undefined {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const grok = (search as Record<string, unknown>).grok;
  const apiKey = readConfiguredOrManagedApiKey(
    grok && typeof grok === "object" ? (grok as Record<string, unknown>).apiKey : undefined,
  );
  return apiKey ? { apiKey, source: "tools.web.search.grok.apiKey" } : undefined;
}

function readConfiguredRuntimeApiKey(
  value: unknown,
  path: string,
  cfg?: OpenClawConfig,
): ConfiguredRuntimeApiKeyResolution {
  const resolved = resolveSecretInputString({
    value,
    path,
    defaults: cfg?.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    return { status: "available", value: resolved.value };
  }
  if (resolved.status === "missing") {
    return { status: "missing" };
  }
  if (resolved.ref.source !== "env") {
    return { status: "blocked" };
  }
  const envVarName = resolved.ref.id.trim();
  if (envVarName !== XAI_API_KEY_ENV_VAR) {
    return { status: "blocked" };
  }
  if (
    !canResolveEnvSecretRefInReadOnlyPath({
      cfg,
      provider: resolved.ref.provider,
      id: envVarName,
    })
  ) {
    return { status: "blocked" };
  }
  const envValue = normalizeSecretInputString(process.env[envVarName]);
  return envValue ? { status: "available", value: envValue } : { status: "missing" };
}

function readLegacyGrokApiKeyResult(cfg?: OpenClawConfig): ConfiguredRuntimeApiKeyResolution {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return { status: "missing" };
  }
  const grok = (search as Record<string, unknown>).grok;
  return readConfiguredRuntimeApiKey(
    grok && typeof grok === "object" ? (grok as Record<string, unknown>).apiKey : undefined,
    "tools.web.search.grok.apiKey",
    cfg,
  );
}

function readPluginXaiWebSearchApiKeyResult(
  cfg?: OpenClawConfig,
): ConfiguredRuntimeApiKeyResolution {
  return readConfiguredRuntimeApiKey(
    resolveProviderWebSearchPluginConfig(cfg as Record<string, unknown> | undefined, "xai")?.apiKey,
    "plugins.entries.xai.config.webSearch.apiKey",
    cfg,
  );
}

function resolveConfiguredXaiToolApiKeyResult(params: {
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
}): ConfiguredRuntimeApiKeyResolution {
  const runtimePlugin = readPluginXaiWebSearchApiKeyResult(params.runtimeConfig);
  if (runtimePlugin.status === "available" || runtimePlugin.status === "blocked") {
    return runtimePlugin;
  }
  const runtimeLegacy = readLegacyGrokApiKeyResult(params.runtimeConfig);
  if (runtimeLegacy.status === "available" || runtimeLegacy.status === "blocked") {
    return runtimeLegacy;
  }
  const sourcePlugin = readPluginXaiWebSearchApiKeyResult(params.sourceConfig);
  if (sourcePlugin.status === "available" || sourcePlugin.status === "blocked") {
    return sourcePlugin;
  }
  const sourceLegacy = readLegacyGrokApiKeyResult(params.sourceConfig);
  if (sourceLegacy.status === "available" || sourceLegacy.status === "blocked") {
    return sourceLegacy;
  }
  return { status: "missing" };
}

function hasXaiAuthProfile(auth?: XaiToolAuthContext): boolean {
  return auth?.hasAuthForProvider?.(XAI_PROVIDER_ID) === true;
}

async function resolveXaiAuthProfileApiKey(auth?: XaiToolAuthContext): Promise<string | undefined> {
  const value = await auth?.resolveApiKeyForProvider?.(XAI_PROVIDER_ID);
  return normalizeSecretInputString(value);
}

export function resolveFallbackXaiAuth(cfg?: OpenClawConfig): XaiFallbackAuth | undefined {
  const pluginApiKey = readConfiguredOrManagedApiKey(
    resolveProviderWebSearchPluginConfig(cfg as Record<string, unknown> | undefined, "xai")?.apiKey,
  );
  if (pluginApiKey) {
    return {
      apiKey: pluginApiKey,
      source: "plugins.entries.xai.config.webSearch.apiKey",
    };
  }
  return readLegacyGrokFallbackAuth(cfg);
}

export function resolveFallbackXaiApiKey(cfg?: OpenClawConfig): string | undefined {
  const plugin = readPluginXaiWebSearchApiKeyResult(cfg);
  if (plugin.status === "available") {
    return plugin.value;
  }
  if (plugin.status === "blocked") {
    return undefined;
  }
  const legacy = readLegacyGrokApiKeyResult(cfg);
  return legacy.status === "available" ? legacy.value : undefined;
}

export function resolveXaiToolApiKey(params: {
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
}): string | undefined {
  const configured = resolveConfiguredXaiToolApiKeyResult(params);
  if (configured.status === "available") {
    return configured.value;
  }
  if (configured.status === "blocked") {
    return undefined;
  }
  return readProviderEnvValue([XAI_API_KEY_ENV_VAR]);
}

export async function resolveXaiToolApiKeyWithAuth(params: {
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  auth?: XaiToolAuthContext;
}): Promise<string | undefined> {
  const configured = resolveConfiguredXaiToolApiKeyResult(params);
  if (configured.status === "available") {
    return configured.value;
  }
  if (configured.status === "blocked") {
    return undefined;
  }
  return (
    (await resolveXaiAuthProfileApiKey(params.auth)) ?? readProviderEnvValue([XAI_API_KEY_ENV_VAR])
  );
}

export function isXaiToolEnabled(params: {
  enabled?: boolean;
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  auth?: XaiToolAuthContext;
}): boolean {
  if (params.enabled === false) {
    return false;
  }
  const configured = resolveConfiguredXaiToolApiKeyResult(params);
  if (configured.status === "available") {
    return true;
  }
  if (configured.status === "blocked") {
    return false;
  }
  return hasXaiAuthProfile(params.auth) || Boolean(readProviderEnvValue([XAI_API_KEY_ENV_VAR]));
}
