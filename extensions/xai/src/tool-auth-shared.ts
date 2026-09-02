// Xai plugin module implements tool auth shared behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  coerceSecretRef,
  resolveNonEnvSecretRefApiKeyMarker,
} from "openclaw/plugin-sdk/provider-auth";
import {
  readProviderEnvValue,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  resolveReadOnlyEnvSecretRef,
  type ReadOnlyEnvSecretRefResolution,
} from "openclaw/plugin-sdk/secret-ref-readonly";

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

function readConfiguredOrManagedApiKey(value: unknown): string | undefined {
  const literal = normalizeSecretInputString(value);
  if (literal) {
    return literal;
  }
  const ref = coerceSecretRef(value);
  return ref ? resolveNonEnvSecretRefApiKeyMarker(ref.source) : undefined;
}

function readConfiguredRuntimeApiKey(
  value: unknown,
  path: string,
  cfg?: OpenClawConfig,
): ReadOnlyEnvSecretRefResolution {
  return resolveReadOnlyEnvSecretRef({
    value,
    path,
    cfg,
    expectedEnvId: XAI_API_KEY_ENV_VAR,
    normalizeValue: normalizeSecretInputString,
  });
}

function readPluginXaiWebSearchApiKeyResult(cfg?: OpenClawConfig): ReadOnlyEnvSecretRefResolution {
  return readConfiguredRuntimeApiKey(
    resolveProviderWebSearchPluginConfig(cfg as Record<string, unknown> | undefined, "xai")?.apiKey,
    "plugins.entries.xai.config.webSearch.apiKey",
    cfg,
  );
}

function resolveConfiguredXaiToolApiKeyResult(params: {
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
}): ReadOnlyEnvSecretRefResolution {
  const runtimePlugin = readPluginXaiWebSearchApiKeyResult(params.runtimeConfig);
  if (runtimePlugin.status === "available" || runtimePlugin.status === "blocked") {
    return runtimePlugin;
  }
  const sourcePlugin = readPluginXaiWebSearchApiKeyResult(params.sourceConfig);
  if (sourcePlugin.status === "available" || sourcePlugin.status === "blocked") {
    return sourcePlugin;
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
  return undefined;
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
