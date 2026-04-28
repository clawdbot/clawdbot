import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { isRecord } from "./tool-config-shared.js";

type JsonRecord = Record<string, unknown>;

function cloneRecord<T extends JsonRecord | undefined>(value: T): T {
  if (!value) {
    return value;
  }
  return { ...value } as T;
}

export function resolveLegacyXSearchConfig(config?: OpenClawConfig): JsonRecord | undefined {
  const web = config?.tools?.web as Record<string, unknown> | undefined;
  const xSearch = web?.x_search;
  return isRecord(xSearch) ? cloneRecord(xSearch) : undefined;
}

export function resolvePluginXSearchConfig(config?: OpenClawConfig): JsonRecord | undefined {
  const pluginConfig = config?.plugins?.entries?.xai?.config;
  if (!isRecord(pluginConfig?.xSearch)) {
    return undefined;
  }
  return cloneRecord(pluginConfig.xSearch);
}

export function resolveEffectiveXSearchConfig(config?: OpenClawConfig): JsonRecord | undefined {
  const legacy = resolveLegacyXSearchConfig(config);
  const pluginOwned = resolvePluginXSearchConfig(config);
  if (!legacy) {
    return pluginOwned;
  }
  if (!pluginOwned) {
    return legacy;
  }
  return {
    ...legacy,
    ...pluginOwned,
  };
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
