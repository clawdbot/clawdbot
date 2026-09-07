// Xai helper module supports x search config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type JsonRecord = Record<string, unknown>;

function resolvePluginSearchConfig(
  config: OpenClawConfig | undefined,
  key: "webSearch" | "xSearch",
): JsonRecord | undefined {
  const pluginConfig = config?.plugins?.entries?.xai?.config;
  return isRecord(pluginConfig?.[key]) ? { ...pluginConfig[key] } : undefined;
}

function baseUrlFallback(config?: JsonRecord): JsonRecord | undefined {
  return typeof config?.baseUrl === "string" && config.baseUrl.trim()
    ? { baseUrl: config.baseUrl }
    : undefined;
}

export function resolveEffectiveXSearchConfig(config?: OpenClawConfig): JsonRecord | undefined {
  const pluginWebSearchBaseUrl = baseUrlFallback(resolvePluginSearchConfig(config, "webSearch"));
  const pluginOwned = resolvePluginSearchConfig(config, "xSearch");
  const merged = {
    ...pluginWebSearchBaseUrl,
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
