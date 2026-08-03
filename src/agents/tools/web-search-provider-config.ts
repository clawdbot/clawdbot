/**
 * Provider-scoped web-search config helpers.
 *
 * Projects plugin-owned provider configuration into the tool-local search shape.
 */
import { resolvePluginWebSearchConfig } from "../../config/plugin-web-search-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isLegacyWebSearchProviderConfigKey } from "../../config/web-search-legacy-provider-keys.js";

/** Reads the legacy top-level web search credential value. */
export function getTopLevelCredentialValue(searchConfig?: Record<string, unknown>): unknown {
  return searchConfig?.apiKey;
}

/** Writes the legacy top-level web search credential value. */
export function setTopLevelCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  value: unknown,
): void {
  searchConfigTarget.apiKey = value;
}

/** Reads a provider-scoped credential value from a web search config object. */
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

/** Writes a provider-scoped credential value, creating the scoped object when needed. */
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

/** Projects plugin web-search config into the provider-scoped tool-local shape. */
export function mergeScopedSearchConfig(
  searchConfig: Record<string, unknown> | undefined,
  key: string,
  pluginConfig: Record<string, unknown> | undefined,
  options?: { mirrorApiKeyToTopLevel?: boolean },
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...searchConfig };
  delete next.apiKey;
  if (isLegacyWebSearchProviderConfigKey(key)) {
    delete next[key];
  }
  if (!pluginConfig) {
    return Object.keys(next).length > 0 ? next : undefined;
  }

  // Provider-local projections are runtime-only and must never reserialize into tools.web.search.
  Object.defineProperty(next, key, {
    value: { ...pluginConfig },
    enumerable: false,
    configurable: true,
    writable: true,
  });

  if (options?.mirrorApiKeyToTopLevel && pluginConfig.apiKey !== undefined) {
    next.apiKey = pluginConfig.apiKey;
  }

  return next;
}

/** Resolves plugin-owned web-search config for a provider plugin id. */
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

/** Writes a single plugin-owned web-search config value and enables the plugin entry if needed. */
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
