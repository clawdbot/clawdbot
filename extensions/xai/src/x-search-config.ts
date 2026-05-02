import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { isRecord } from "./tool-config-shared.js";

type JsonRecord = Record<string, unknown>;

function cloneRecord<T extends JsonRecord | undefined>(value: T): T {
  if (!value) {
    return value;
  }
  return { ...value } as T;
}

function resolveLegacyXSearchConfig(config?: OpenClawConfig): JsonRecord | undefined {
  const web = config?.tools?.web as Record<string, unknown> | undefined;
  const xSearch = web?.x_search;
  return isRecord(xSearch) ? cloneRecord(xSearch) : undefined;
}

function resolvePluginXSearchConfig(config?: OpenClawConfig): JsonRecord | undefined {
  const pluginConfig = config?.plugins?.entries?.xai?.config;
  if (!isRecord(pluginConfig?.xSearch)) {
    return undefined;
  }
  return cloneRecord(pluginConfig.xSearch);
}

function resolveLegacyGrokWebSearchConfig(config?: OpenClawConfig): JsonRecord | undefined {
  const web = config?.tools?.web as Record<string, unknown> | undefined;
  const search = web?.search;
  if (!isRecord(search) || !isRecord(search.grok)) {
    return undefined;
  }
  return cloneRecord(search.grok);
}

function resolvePluginWebSearchConfig(config?: OpenClawConfig): JsonRecord | undefined {
  const pluginConfig = config?.plugins?.entries?.xai?.config;
  if (!isRecord(pluginConfig?.webSearch)) {
    return undefined;
  }
  return cloneRecord(pluginConfig.webSearch);
}

function baseUrlFallback(config?: JsonRecord): JsonRecord | undefined {
  return typeof config?.baseUrl === "string" && config.baseUrl.trim()
    ? { baseUrl: config.baseUrl }
    : undefined;
}

export function resolveEffectiveXSearchConfig(config?: OpenClawConfig): JsonRecord | undefined {
  const legacyGrokBaseUrl = baseUrlFallback(resolveLegacyGrokWebSearchConfig(config));
  const pluginWebSearchBaseUrl = baseUrlFallback(resolvePluginWebSearchConfig(config));
  const legacy = resolveLegacyXSearchConfig(config);
  const pluginOwned = resolvePluginXSearchConfig(config);
  const merged = {
    ...legacyGrokBaseUrl,
    ...pluginWebSearchBaseUrl,
    ...legacy,
    ...pluginOwned,
  };
  if (Object.keys(merged).length === 0) {
    return undefined;
  }
  return merged;
}

export function setPluginXSearchConfigValue(
  configTarget: OpenClawConfig,
  key: string,
  value: unknown,
): void {
  const plugins = (configTarget.plugins ??= {}) as { entries?: Record<string, unknown> };
  const entries = (plugins.entries ??= {});
  const entry = (entries.xai ??= {}) as { config?: Record<string, unknown> };
  const config = (entry.config ??= {});
  const xSearch = (config.xSearch ??= {}) as Record<string, unknown>;
  xSearch[key] = value;
}
