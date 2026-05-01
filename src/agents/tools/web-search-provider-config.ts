import { resolvePluginWebSearchConfig } from "../../config/plugin-web-search-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function getTopLevelCredentialValue(searchConfig?: Record<string, unknown>): unknown {
  return searchConfig?.apiKey;
}

export function setTopLevelCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  value: unknown,
): void {
  searchConfigTarget.apiKey = value;
}

export function getScopedCredentialValue(
  searchConfig: Record<string, unknown> | undefined,
  key: string,
): unknown {
  const scoped = searchConfig?.[key];
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return undefined;
  }
  return (scoped as Record<string, unknown>).apiKey;
}

export function setScopedCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const scoped = searchConfigTarget[key];
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    searchConfigTarget[key] = { apiKey: value };
    return;
  }
  (scoped as Record<string, unknown>).apiKey = value;
}

export function mergeScopedSearchConfig(
  searchConfig: Record<string, unknown> | undefined,
  key: string,
  pluginConfig: Record<string, unknown> | undefined,
  options?: { mirrorApiKeyToTopLevel?: boolean },
): Record<string, unknown> | undefined {
  if (!pluginConfig) {
    return searchConfig;
  }

  const currentScoped =
    searchConfig?.[key] &&
    typeof searchConfig[key] === "object" &&
    !Array.isArray(searchConfig[key])
      ? (searchConfig[key] as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = {
    ...searchConfig,
    [key]: {
      ...currentScoped,
      ...pluginConfig,
    },
  };

  if (options?.mirrorApiKeyToTopLevel && pluginConfig.apiKey !== undefined) {
    next.apiKey = pluginConfig.apiKey;
  }

  return next;
}

export function resolveProviderWebSearchPluginConfig(
  config: OpenClawConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  return resolvePluginWebSearchConfig(config, pluginId);
}

function ensureObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

export function setProviderWebSearchPluginConfigValue(
  configTarget: OpenClawConfig,
  pluginId: string,
  key: string,
  value: unknown,
): void {
  const plugins = ensureObject(configTarget as Record<string, unknown>, "plugins");
  const entries = ensureObject(plugins, "entries");
  const entry = ensureObject(entries, pluginId);
  if (entry.enabled === undefined) {
    entry.enabled = true;
  }
  const config = ensureObject(entry, "config");
  const webSearch = ensureObject(config, "webSearch");
  webSearch[key] = value;
}
